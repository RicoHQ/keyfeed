// Global score feed ingester ("firehose").
//
// Reads osu!'s feed of every passed osu!mania score (GET /scores?ruleset=mania, cursor-based,
// up to 1000 per call) and fans it out:
//
//   every country  → in-memory live feed, highest-pp plays of the last 24h, live SSE events,
//                    hourly activity counts (flushed to SQLite once an hour)
//   tracked players → the full pipeline in Tracker.processScore (pp gain, top plays, snipes,
//                    map leaderboards, skills), persisted to SQLite
//
// One feed request a minute or so covers the whole world, which is far lighter on the osu! API
// than polling players one by one, and keeps SQLite writes inside Cloudflare's Free plan:
// only tracked players' scores and the hourly aggregates are written.
//
// Users and beatmaps that the feed doesn't embed are looked up in batches of 50 and cached in
// memory (LRU), so after warm-up most scores need no extra request.

const HOUR = 3600_000;

class LRU {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) { const v = this.map.get(k); if (v !== undefined) { this.map.delete(k); this.map.set(k, v); } return v; }
  has(k) { return this.map.has(k); }
  set(k, v) { this.map.delete(k); this.map.set(k, v); if (this.map.size > this.max) this.map.delete(this.map.keys().next().value); }
  get size() { return this.map.size; }
}

export class Firehose {
  constructor(tracker, opts = {}) {
    this.t = tracker;
    this.osu = tracker.osu;
    this.o = {
      feedIntervalMs: 20_000, // poll the feed this often (sooner when a page comes back full)
      bufferPerCountry: 100, // live feed kept in memory per country
      topPerCountry: 50, // highest-pp plays kept per country (rolling 24h)
      worldBuffer: 200,
      maxPending: 6000, // scores waiting for a user/beatmap lookup
      ...opts,
    };
    this.users = new LRU(150_000);
    this.maps = new LRU(60_000);
    this.pending = [];
    this.deferred = new Map(); // playerId -> scores waiting for that player's best plays to load
    this.buffers = new Map(); // country -> newest-first scores
    this.top = new Map(); // country -> pp-sorted scores (24h)
    this.world = [];
    this.hourly = new Map(); // `${country}|${hourStart}` -> { plays, players:Set, topPP, top }
    this.seen = new Set();
    this.seenOrder = [];
    this.lastFeedAt = 0;
    this.fullPage = false;
    this.lastFlushHour = Math.floor(Date.now() / HOUR);
    this.focus = new Set();
    this.focusAt = 0;
    this.stats = { feedCalls: 0, scores: 0, userLookups: 0, mapLookups: 0, routed: 0, dropped: 0 };
  }

  // The cursor lives in memory and is saved at most every 5 minutes (each save is a billed row write).
  // After a restart the feed resumes from the saved cursor; scores already stored are skipped.
  get cursor() {
    if (this._cursor === undefined) this._cursor = this.t.meta('feed_cursor');
    return this._cursor;
  }
  set cursor(v) {
    if (!v || v === this._cursor) return;
    this._cursor = v;
    if (Date.now() - (this._cursorSavedAt || 0) > 5 * 60_000) {
      this.t.setMeta('feed_cursor', v);
      this._cursorSavedAt = Date.now();
    }
  }

  /** Player ids that get the full persisted pipeline: active-country rosters and pinned players. */
  refreshFocus(force = false) {
    if (!force && Date.now() - this.focusAt < 60_000) return;
    const ids = new Set();
    for (const c of this.t.activeCountries()) for (const p of this.t.q.roster.all(c)) ids.add(p.id);
    for (const p of this.t.db.prepare(`SELECT id FROM players WHERE pinned = 1`).all()) ids.add(p.id);
    this.focus = ids;
    this.focusAt = Date.now();
  }

  /** One unit of work (≤ 1 osu! request). Returns what it did, or null when there was nothing to do. */
  async step() {
    this.refreshFocus();
    this.maybeFlushHourly();

    // 1. a tracked player's first pp score needs their top plays for the pp-gain maths
    const d = this.deferred.entries().next().value;
    if (d) {
      const [pid, scores] = d;
      this.deferred.delete(pid);
      const player = this.t.q.player.get(pid);
      if (player) {
        try {
          await this.t.ensureBest(player);
          for (const s of scores) await this.t.processScore(player, s, { announceScore: false });
        } catch (e) { this.t.log.error?.(`[feed] best ${pid}: ${e.message}`); }
      }
      return 'best';
    }

    // 2. resolve unknown users / beatmaps for queued scores, 50 at a time
    const needUsers = [...new Set(this.pending.filter((s) => !this.users.has(s.user_id)).map((s) => s.user_id))];
    if (needUsers.length) {
      const batch = needUsers.slice(0, 50);
      try {
        const found = await this.osu.users(batch);
        this.stats.userLookups++;
        for (const u of found) this.users.set(u.id, { id: u.id, username: u.username, avatar_url: u.avatar_url, country_code: u.country_code });
        for (const id of batch) if (!this.users.has(id)) this.users.set(id, { id, username: `#${id}`, avatar_url: null, country_code: null }); // deleted/restricted
      } catch (e) { this.t.log.error?.(`[feed] users: ${e.message}`); }
      await this.drain();
      return 'lookup';
    }
    const needMaps = [...new Set(this.pending.filter((s) => !this.maps.has(s.beatmap_id)).map((s) => s.beatmap_id))];
    if (needMaps.length) {
      const batch = needMaps.slice(0, 50);
      try {
        const found = await this.osu.beatmaps(batch);
        this.stats.mapLookups++;
        for (const b of found) this.maps.set(b.id, b);
        for (const id of batch) if (!this.maps.has(id)) this.maps.set(id, { id });
      } catch (e) { this.t.log.error?.(`[feed] beatmaps: ${e.message}`); }
      await this.drain();
      return 'lookup';
    }

    // 3. read the feed when due
    if (this.fullPage || Date.now() - this.lastFeedAt >= this.o.feedIntervalMs) {
      this.lastFeedAt = Date.now();
      try {
        const { scores, cursor } = await this.osu.scoresFeed(this.cursor);
        this.stats.feedCalls++;
        this.fullPage = scores.length >= 1000;
        for (const s of scores) this.accept(s);
        this.cursor = cursor;
      } catch (e) {
        this.fullPage = false;
        this.t.log.error?.(`[feed] ${e.message}`);
      }
      await this.drain();
      return 'feed';
    }
    return null;
  }

  accept(s) {
    if (!s?.id || this.seen.has(s.id) || s.passed === false) return;
    this.seen.add(s.id);
    this.seenOrder.push(s.id);
    if (this.seenOrder.length > 20_000) this.seen.delete(this.seenOrder.shift());
    this.stats.scores++;
    // cache whatever the feed embeds
    if (s.user?.country_code) this.users.set(s.user_id, s.user);
    if (s.beatmap?.version && s.beatmapset?.title) this.maps.set(s.beatmap_id, beatmapFromScore(s));
    this.pending.push(s);
    if (this.pending.length > this.o.maxPending) { this.pending.shift(); this.stats.dropped++; }
  }

  /** Route every pending score whose user and beatmap are known. */
  async drain() {
    const rest = [];
    const ready = [];
    for (const s of this.pending) (this.users.has(s.user_id) && this.maps.has(s.beatmap_id) ? ready : rest).push(s);
    this.pending = rest;
    ready.sort((a, b) => Date.parse(a.ended_at) - Date.parse(b.ended_at));
    for (const s of ready) await this.route(s);
  }

  async route(raw) {
    const u = this.users.get(raw.user_id);
    const b = this.maps.get(raw.beatmap_id);
    const s = {
      ...raw,
      user: { id: u.id, username: u.username, avatar_url: u.avatar_url, country_code: u.country_code },
      beatmap: { id: raw.beatmap_id, version: b.version, difficulty_rating: b.sr, keys: b.keys, bpm: b.bpm, status: b.status, url: b.url || `https://osu.ppy.sh/beatmaps/${raw.beatmap_id}` },
      beatmapset: { id: b.set_id, title: b.title, artist: b.artist, creator: b.creator, cover: b.cover, card: null },
    };
    const country = u.country_code;
    this.stats.routed++;
    if (country) {
      push(this.buffers, country, s, this.o.bufferPerCountry);
      if (s.pp > 0) this.addTop(country, s);
      this.count(country, s);
    }
    this.world.unshift(s);
    if (this.world.length > this.o.worldBuffer) this.world.length = this.o.worldBuffer;
    this.t.emit('live', { country, score: s });

    if (this.focus.has(s.user_id)) {
      const player = this.t.q.player.get(s.user_id);
      if (!player) return;
      if (s.pp > 0 && !player.best_loaded) {
        const list = this.deferred.get(player.id) || [];
        list.push(s);
        this.deferred.set(player.id, list);
      } else {
        try { await this.t.processScore(player, s, { announceScore: false }); } catch (e) { this.t.log.error?.(`[feed] process ${s.id}: ${e.message}`); }
      }
    }
  }

  addTop(country, s) {
    const cutoff = Date.now() - 24 * HOUR;
    const list = (this.top.get(country) || []).filter((x) => Date.parse(x.ended_at) >= cutoff);
    list.push(s);
    list.sort((a, b) => b.pp - a.pp);
    if (list.length > this.o.topPerCountry) list.length = this.o.topPerCountry;
    this.top.set(country, list);
  }

  count(country, s) {
    const hour = Math.floor((Date.parse(s.ended_at) || Date.now()) / HOUR);
    const key = `${country}|${hour}`;
    let h = this.hourly.get(key);
    if (!h) { h = { country, hour, plays: 0, players: new Set(), topPP: 0, top: null }; this.hourly.set(key, h); }
    h.plays++;
    h.players.add(s.user_id);
    if ((s.pp || 0) > h.topPP) { h.topPP = s.pp; h.top = slim(s); }
  }

  /** Write finished hours to SQLite (≈ one row per active country per hour). */
  maybeFlushHourly(force = false) {
    const nowHour = Math.floor(Date.now() / HOUR);
    if (!force && nowHour === this.lastFlushHour) return 0;
    this.lastFlushHour = nowHour;
    let n = 0;
    const up = this.t.db.prepare(`
      INSERT INTO country_activity (country, hour, plays, players, top_pp, top_json) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(country, hour) DO UPDATE SET plays = country_activity.plays + excluded.plays,
        players = MAX(country_activity.players, excluded.players),
        top_json = CASE WHEN COALESCE(excluded.top_pp, 0) > COALESCE(country_activity.top_pp, 0) THEN excluded.top_json ELSE country_activity.top_json END,
        top_pp = MAX(COALESCE(country_activity.top_pp, 0), COALESCE(excluded.top_pp, 0))`);
    this.t.db.transaction(() => {
      for (const [key, h] of this.hourly) {
        if (!force && h.hour >= nowHour) continue;
        up.run(h.country, h.hour, h.plays, h.players.size, h.topPP || null, h.top ? JSON.stringify(h.top) : null);
        n++;
        this.hourly.delete(key); // flushed counts are additive, so late scores for this hour start a fresh entry
      }
      this.t.db.prepare(`DELETE FROM country_activity WHERE hour < ?`).run(nowHour - 24 * 30);
    });
    return n;
  }

  // ---------- reads ----------

  live(country, limit = 50) { return (country === 'WORLD' ? this.world : this.buffers.get(country) || []).slice(0, limit); }
  topToday(country, limit = 50) {
    const cutoff = Date.now() - 24 * HOUR;
    return (this.top.get(country) || []).filter((x) => Date.parse(x.ended_at) >= cutoff).slice(0, limit);
  }

  /** Activity per country over the last 24h: persisted hours + the in-memory current hour. */
  countries() {
    const since = Math.floor(Date.now() / HOUR) - 23;
    const out = new Map();
    for (const r of this.t.db.prepare(`SELECT country, SUM(plays) AS plays, MAX(players) AS players, MAX(top_pp) AS top_pp FROM country_activity WHERE hour >= ? GROUP BY country`).all(since)) {
      out.set(r.country, { country: r.country, plays24h: r.plays, peakPlayersHour: r.players, topPP: r.top_pp || 0, playsHour: 0, playersHour: 0 });
    }
    const nowHour = Math.floor(Date.now() / HOUR);
    for (const h of this.hourly.values()) { // everything in memory is not yet flushed
      if (h.hour < since) continue;
      const o = out.get(h.country) || { country: h.country, plays24h: 0, peakPlayersHour: 0, topPP: 0, playsHour: 0, playersHour: 0 };
      if (h.hour === nowHour) { o.playsHour += h.plays; o.playersHour = Math.max(o.playersHour, h.players.size); }
      o.plays24h += h.plays;
      o.peakPlayersHour = Math.max(o.peakPlayersHour, h.players.size);
      o.topPP = Math.max(o.topPP, h.topPP || 0);
      out.set(h.country, o);
    }
    for (const [c, list] of this.top) { const o = out.get(c); if (o && list[0]) o.top = slim(list[0]); }
    return [...out.values()].sort((a, b) => b.plays24h - a.plays24h || b.playsHour - a.playsHour);
  }

  status() {
    return { ...this.stats, pending: this.pending.length, deferred: this.deferred.size, users: this.users.size, maps: this.maps.size, countriesLive: this.buffers.size, focus: this.focus.size };
  }
}

function push(map, key, item, max) {
  const list = map.get(key) || [];
  list.unshift(item);
  if (list.length > max) list.length = max;
  map.set(key, list);
}

function beatmapFromScore(s) {
  const bm = s.beatmap || {};
  const bs = s.beatmapset || {};
  return { id: s.beatmap_id, set_id: bs.id, title: bs.title, artist: bs.artist, version: bm.version, creator: bs.creator, keys: bm.keys, sr: bm.difficulty_rating, bpm: bm.bpm, status: bm.status, cover: bs.cover, url: bm.url };
}

const slim = (s) => ({
  id: s.id, user: s.user, pp: s.pp, accuracy: s.accuracy, rank: s.rank, mods: s.mods, ended_at: s.ended_at, beatmap_id: s.beatmap_id,
  beatmap: { version: s.beatmap?.version, keys: s.beatmap?.keys, difficulty_rating: s.beatmap?.difficulty_rating },
  beatmapset: { id: s.beatmapset?.id, title: s.beatmapset?.title, artist: s.beatmapset?.artist, cover: s.beatmapset?.cover },
});
