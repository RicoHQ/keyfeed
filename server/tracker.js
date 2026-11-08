// The core engine. Keeps per-country rosters of top players, polls their recent scores, and derives
// everything else from what it stores: pp gain / top plays, snipes, map leaderboards, chart
// analysis, skill ratings and history.
//
// Work is split into small `step()` units so the same code runs as a `while` loop in Node and as
// alarm-driven bursts inside a Cloudflare Durable Object. One step ≈ one osu! request.
import { EventEmitter } from 'node:events';
import { today, DATA_TABLES } from './schema.js';
import { evaluateScore, mergeBest } from './pp.js';
import { parseOsu, analyzeChart, MODEL } from './chart.js';
import { computeSkills } from './skills.js';

const DAY = 86_400_000;

export class Tracker extends EventEmitter {
  constructor({ db, osu, config, log = console }) {
    super();
    this.db = db;
    this.osu = osu;
    this.config = {
      onDemandRoster: 50, activeTtlMinutes: 30, maxActiveCountries: 4, leaderboardTtlMinutes: 60,
      analyzeEvery: 3, maxPinned: 300, retentionDays: 35, ...config,
    };
    this.log = log;
    this.running = false;
    this.cycle = 0;
    this.steps = 0;
    this.queue = [];
    this.pendingLeaderboards = new Set();
    this.touched = new Map();
    this.prepare();
  }

  prepare() {
    const d = this.db;
    this.q = {
      upsertPlayer: d.prepare(`
        INSERT INTO players (id, username, avatar_url, cover_url, country, pp, pp_4k, pp_7k, global_rank, country_rank,
                             accuracy, play_count, ranked_score, on_roster, updated_at)
        VALUES (:id, :username, :avatar_url, :cover_url, :country, :pp, :pp_4k, :pp_7k, :global_rank, :country_rank,
                :accuracy, :play_count, :ranked_score, 1, :now)
        ON CONFLICT(id) DO UPDATE SET username=excluded.username, avatar_url=excluded.avatar_url,
          cover_url=COALESCE(excluded.cover_url, players.cover_url), country=excluded.country, pp=excluded.pp,
          pp_4k=excluded.pp_4k, pp_7k=excluded.pp_7k, global_rank=excluded.global_rank,
          country_rank=excluded.country_rank, accuracy=excluded.accuracy, play_count=excluded.play_count,
          ranked_score=excluded.ranked_score, on_roster=1, updated_at=excluded.updated_at`),
      pinPlayer: d.prepare(`
        INSERT INTO players (id, username, avatar_url, cover_url, country, pp, pp_4k, pp_7k, global_rank, country_rank,
                             accuracy, play_count, ranked_score, pinned, updated_at)
        VALUES (:id, :username, :avatar_url, :cover_url, :country, :pp, :pp_4k, :pp_7k, :global_rank, :country_rank,
                :accuracy, :play_count, :ranked_score, 1, 0)
        ON CONFLICT(id) DO UPDATE SET pinned = 1, username = excluded.username, avatar_url = excluded.avatar_url`),
      upsertProfile: d.prepare(`
        UPDATE players SET username=:username, avatar_url=:avatar_url, pp=:pp, pp_4k=:pp_4k, pp_7k=:pp_7k,
          global_rank=:global_rank, accuracy=:accuracy, play_count=:play_count WHERE id=:id`),
      pinnedCount: d.prepare(`SELECT COUNT(*) AS n FROM players WHERE pinned = 1`),
      clearRoster: d.prepare(`UPDATE players SET on_roster = 0 WHERE country = ? AND updated_at < ? AND on_roster = 1`),
      upsertHistory: d.prepare(`
        INSERT INTO rank_history (user_id, day, country_rank, global_rank, pp) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, day) DO UPDATE SET country_rank=COALESCE(excluded.country_rank, rank_history.country_rank),
          global_rank=excluded.global_rank, pp=excluded.pp`),
      prevHistory: d.prepare(`SELECT country_rank, global_rank, pp FROM rank_history WHERE user_id = ? AND day < ? ORDER BY day DESC LIMIT 1`),
      roster: d.prepare(`SELECT id, last_score_at, initialized FROM players WHERE country = ? AND on_roster = 1 ORDER BY country_rank`),
      pinnedPlayers: d.prepare(`SELECT id, last_score_at, initialized FROM players WHERE pinned = 1 AND on_roster = 0`),
      player: d.prepare(`SELECT * FROM players WHERE id = ?`),
      playerByName: d.prepare(`SELECT * FROM players WHERE username = ? COLLATE NOCASE`),
      scoreExists: d.prepare(`SELECT 1 AS x FROM scores WHERE id = ?`),
      insertScore: d.prepare(`
        INSERT OR IGNORE INTO scores (id, user_id, country, beatmap_id, pp, pp_gain, weighted_pp, best_position, ended_at, json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      markPolled: d.prepare(`UPDATE players SET initialized = 1, last_score_at = MAX(last_score_at, ?) WHERE id = ?`),
      bestFor: d.prepare(`SELECT beatmap_id, pp FROM best WHERE user_id = ?`),
      clearBest: d.prepare(`DELETE FROM best WHERE user_id = ?`),
      insertBest: d.prepare(`INSERT OR REPLACE INTO best (user_id, beatmap_id, pp, accuracy, mods, ended_at) VALUES (?, ?, ?, ?, ?, ?)`),
      markBestLoaded: d.prepare(`UPDATE players SET best_loaded = 1 WHERE id = ?`),
      insertBeatmap: d.prepare(`
        INSERT OR IGNORE INTO beatmaps (id, set_id, title, artist, version, creator, keys, sr, bpm, status, cover, url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      beatmap: d.prepare(`SELECT * FROM beatmaps WHERE id = ?`),
      mapTop: d.prepare(`SELECT * FROM map_best WHERE country = ? AND beatmap_id = ? ORDER BY total_score DESC LIMIT 1`),
      mapMine: d.prepare(`SELECT total_score FROM map_best WHERE country = ? AND beatmap_id = ? AND user_id = ?`),
      upsertMapBest: d.prepare(`
        INSERT INTO map_best (country, beatmap_id, user_id, score_id, total_score, accuracy, pp, mods, rank, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(country, beatmap_id, user_id) DO UPDATE SET score_id=excluded.score_id, total_score=excluded.total_score,
          accuracy=excluded.accuracy, pp=excluded.pp, mods=excluded.mods, rank=excluded.rank, ended_at=excluded.ended_at
        WHERE excluded.total_score > map_best.total_score`),
      insertSnipe: d.prepare(`INSERT INTO snipes (country, beatmap_id, sniper_id, victim_id, created_at, json) VALUES (?, ?, ?, ?, ?, ?)`),
      queueChart: d.prepare(`INSERT OR IGNORE INTO charts (beatmap_id, status, queued_at) VALUES (?, 'queued', ?)`),
      nextChart: d.prepare(`SELECT beatmap_id FROM charts WHERE status = 'queued' ORDER BY queued_at LIMIT 1`),
      saveChart: d.prepare(`UPDATE charts SET status = ?, keys = ?, analyzed_at = ?, json = ? WHERE beatmap_id = ?`),
      chart: d.prepare(`SELECT * FROM charts WHERE beatmap_id = ?`),
      queuedCharts: d.prepare(`SELECT COUNT(*) AS n FROM charts WHERE status = 'queued'`),
      prune: d.prepare(`DELETE FROM scores WHERE ended_at < ?`),
      pruneHistory: d.prepare(`DELETE FROM rank_history WHERE day < ?`),
      pruneSnipes: d.prepare(`DELETE FROM snipes WHERE created_at < ?`),
      getMeta: d.prepare(`SELECT value FROM meta WHERE key = ?`),
      setMeta: d.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
      activeMeta: d.prepare(`SELECT key, value FROM meta WHERE key LIKE 'active:%'`),
      upsertSkillCache: d.prepare(`
        INSERT INTO skill_cache (user_id, keys, country, overall, json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, keys) DO UPDATE SET country=excluded.country, overall=excluded.overall, json=excluded.json, updated_at=excluded.updated_at`),
      skillCacheFor: d.prepare(`SELECT keys, overall, updated_at FROM skill_cache WHERE user_id = ?`),
      upsertSkillHistory: d.prepare(`
        INSERT INTO skill_history (user_id, day, keys, overall, json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, day, keys) DO UPDATE SET overall=excluded.overall, json=excluded.json`),
    };
  }

  meta(key) { return this.q.getMeta.get(key)?.value ?? null; }
  setMeta(key, value) { this.q.setMeta.run(key, String(value)); }

  /** Wipe data if we switched between demo and real data (e.g. after adding osu! credentials). */
  ensureMode(mode) {
    if (this.meta('mode') === mode) return;
    this.db.transaction(() => {
      for (const t of DATA_TABLES) this.db.prepare(`DELETE FROM ${t}`).run();
      this.db.prepare(`DELETE FROM meta WHERE key NOT IN ('schema_version')`).run();
      this.setMeta('mode', mode);
    });
    this.queue = [];
  }

  // ---------- countries ----------

  /** Pinned countries (config) plus countries someone viewed recently. */
  activeCountries() {
    const now = Date.now();
    const extra = this.q.activeMeta.all()
      .map((r) => ({ c: r.key.slice(7), t: Number(r.value) }))
      .filter((x) => now - x.t < this.config.activeTtlMinutes * 60_000 && !this.config.countries.includes(x.c))
      .sort((a, b) => b.t - a.t)
      .slice(0, this.config.maxActiveCountries)
      .map((x) => x.c);
    return [...this.config.countries, ...extra];
  }

  /** Mark a country as being viewed. Writes at most once a minute per country. */
  touchCountry(country) {
    if (this.config.countries.includes(country)) return;
    const now = Date.now();
    if (now - (this.touched.get(country) || 0) < 60_000) return;
    this.touched.set(country, now);
    this.setMeta(`active:${country}`, now);
  }

  rosterSizeFor(country) {
    return this.config.countries.includes(country) ? this.config.rosterSize : Math.min(this.config.rosterSize, this.config.onDemandRoster);
  }

  // ---------- writes ----------

  async refreshRankings(country) {
    const started = Date.now();
    const size = this.rosterSizeFor(country);
    const rows = [];
    for (let page = 1; page <= Math.ceil(size / 50); page++) {
      const { ranking } = await this.osu.rankings(country, page);
      rows.push(...ranking);
      if (ranking.length < 50) break;
    }
    const day = today(started);
    this.db.transaction(() => {
      rows.slice(0, size).forEach((r, i) => {
        const rank = i + 1;
        this.q.upsertPlayer.run({
          id: r.user.id, username: r.user.username, avatar_url: r.user.avatar_url, cover_url: r.user.cover_url,
          country, pp: r.pp, pp_4k: r.pp_4k, pp_7k: r.pp_7k, global_rank: r.global_rank, country_rank: rank,
          accuracy: r.accuracy, play_count: r.play_count, ranked_score: r.ranked_score, now: started,
        });
        this.q.upsertHistory.run(r.user.id, day, rank, r.global_rank, r.pp);
      });
      if (rows.length) this.q.clearRoster.run(country, started);
      this.q.prune.run(started - this.config.retentionDays * DAY);
      this.q.pruneSnipes.run(started - 60 * DAY);
      this.q.pruneHistory.run(today(started - 120 * DAY));
      this.setMeta(`rankings:${country}`, started);
    });
    this.log.info?.(`[rankings] ${country}: ${Math.min(rows.length, size)} players`);
    this.emit('rankings', { country });
  }

  /** kind: 'global:all' | 'global:4k' | 'global:7k' | 'US:4k' | 'US:7k' */
  async refreshLeaderboard(kind) {
    const [scope, mode] = kind.split(':');
    const country = scope === 'global' ? null : scope;
    const variant = mode === 'all' ? null : mode;
    const rows = [];
    for (let page = 1; page <= 2; page++) {
      const { ranking } = await this.osu.rankings(country, page, variant);
      rows.push(...ranking);
      if (ranking.length < 50) break;
    }
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM leaderboards WHERE kind = ?`).run(kind);
      const ins = this.db.prepare(`INSERT INTO leaderboards (kind, rank, json) VALUES (?, ?, ?)`);
      rows.slice(0, 100).forEach((r, i) => ins.run(kind, i + 1, JSON.stringify(r)));
      this.setMeta(`lb:${kind}`, Date.now());
    });
    this.pendingLeaderboards.delete(kind);
  }

  recordBeatmap(s) {
    const bm = s.beatmap || {};
    const bs = s.beatmapset || {};
    if (!s.beatmap_id) return;
    this.q.insertBeatmap.run(s.beatmap_id, bs.id ?? null, bs.title ?? null, bs.artist ?? null, bm.version ?? null, bs.creator ?? null,
      bm.keys ?? null, bm.difficulty_rating ?? null, bm.bpm ?? null, bm.status ?? null, bs.cover ?? null, bm.url ?? null);
  }

  saveBeatmapInfo(b) {
    this.q.insertBeatmap.run(b.id, b.set_id ?? null, b.title ?? null, b.artist ?? null, b.version ?? null, b.creator ?? null,
      b.keys ?? null, b.sr ?? null, b.bpm ?? null, b.status ?? null, b.cover ?? null, b.url ?? null);
  }

  /** Store a player's top plays (for pp gain, skills, map leaderboards). */
  storeBest(player, best) {
    this.db.transaction(() => {
      this.q.clearBest.run(player.id);
      for (const s of best) {
        if (!(s.pp > 0)) continue;
        this.q.insertBest.run(player.id, s.beatmap_id, s.pp, s.accuracy, JSON.stringify(s.mods || []), Date.parse(s.ended_at) || null);
        this.recordBeatmap(s);
        this.q.queueChart.run(s.beatmap_id, Date.now());
        if (player.country && s.total_score) {
          this.q.upsertMapBest.run(player.country, s.beatmap_id, player.id, s.id, s.total_score, s.accuracy, s.pp, JSON.stringify(s.mods || []), s.rank, Date.parse(s.ended_at) || null);
        }
      }
      this.q.markBestLoaded.run(player.id);
    });
    player.best_loaded = 1;
  }

  async ensureBest(player) {
    if (!player.best_loaded) this.storeBest(player, await this.osu.bestScores(player.id, 100));
    return this.q.bestFor.all(player.id);
  }

  /** Update the country leaderboard for a map; returns a snipe record if a different player lost #1. */
  updateMapBest(player, s, endedAt, silent) {
    if (!s.total_score || !player.country) return null;
    const top = this.q.mapTop.get(player.country, s.beatmap_id);
    const mine = this.q.mapMine.get(player.country, s.beatmap_id, player.id);
    if (mine && mine.total_score >= s.total_score) return null;
    this.q.upsertMapBest.run(player.country, s.beatmap_id, player.id, s.id, s.total_score, s.accuracy, s.pp, JSON.stringify(s.mods || []), s.rank, endedAt);
    if (silent || !top || top.user_id === player.id || s.total_score <= top.total_score) return null;
    const victim = this.q.player.get(top.user_id);
    const snipe = {
      country: player.country,
      beatmap_id: s.beatmap_id,
      sniper: { id: player.id, username: player.username, avatar_url: player.avatar_url },
      victim: { id: top.user_id, username: victim?.username ?? `#${top.user_id}`, avatar_url: victim?.avatar_url ?? null },
      score: { id: s.id, total_score: s.total_score, accuracy: s.accuracy, pp: s.pp, mods: s.mods, rank: s.rank },
      victim_score: { total_score: top.total_score, accuracy: top.accuracy, pp: top.pp, ended_at: top.ended_at },
      beatmap: s.beatmap, beatmapset: s.beatmapset,
      created_at: endedAt,
    };
    this.q.insertSnipe.run(player.country, s.beatmap_id, player.id, top.user_id, endedAt, JSON.stringify(snipe));
    return snipe;
  }

  /** Poll one player's recent scores. Returns the number of new scores. */
  async pollPlayer(player) {
    const now = Date.now();
    const recent = await this.osu.recentScores(player.id, 50);
    const fresh = recent
      .filter((s) => s.passed !== false && !this.q.scoreExists.get(s.id))
      .sort((a, b) => Date.parse(a.ended_at) - Date.parse(b.ended_at));
    const silent = !player.initialized; // first poll = backfill, don't announce
    let latest = 0;

    for (const s of fresh) {
      const endedAt = Date.parse(s.ended_at) || now;
      latest = Math.max(latest, endedAt);
      let ev = { position: -1, weightedPP: 0, ppGain: 0 };
      if (!silent && s.pp > 0) {
        const best = await this.ensureBest(player);
        ev = evaluateScore(best, s);
        if (ev.position >= 0) {
          for (const b of mergeBest(best, s)) {
            if (b.beatmap_id === s.beatmap_id) this.q.insertBest.run(player.id, s.beatmap_id, s.pp, s.accuracy, JSON.stringify(s.mods || []), endedAt);
          }
        }
      }
      const enriched = { ...s, pp_gain: ev.ppGain, weighted_pp: ev.weightedPP, best_position: ev.position };
      this.q.insertScore.run(s.id, player.id, player.country, s.beatmap_id, s.pp, ev.ppGain, ev.weightedPP,
        ev.position, endedAt, JSON.stringify(enriched));
      this.recordBeatmap(s);
      if (s.pp > 0 || ev.position >= 0) this.q.queueChart.run(s.beatmap_id, now);
      const snipe = this.updateMapBest(player, s, endedAt, silent);
      if (!silent) {
        this.emit('score', { country: player.country, score: enriched });
        if (ev.position >= 0) this.emit('top_play', { country: player.country, score: enriched });
        if (snipe) this.emit('snipe', { country: player.country, snipe });
      }
    }
    if (silent || latest > player.last_score_at) this.q.markPolled.run(latest, player.id);
    player.initialized = 1;
    player.last_score_at = Math.max(player.last_score_at || 0, latest);
    return fresh.length;
  }

  /** Download and analyse the oldest queued chart. */
  async analyzeNext() {
    const row = this.q.nextChart.get();
    if (!row) return false;
    const id = row.beatmap_id;
    try {
      const text = await this.osu.beatmapFile(id);
      if (!text) { this.q.saveChart.run('missing', null, Date.now(), null, id); return true; }
      const parsed = parseOsu(text);
      const a = parsed.mode === 3 ? analyzeChart(parsed) : null;
      this.q.saveChart.run(a ? 'done' : 'unsupported', a?.keys ?? parsed.keys ?? null, Date.now(), a ? JSON.stringify(a) : null, id);
      if (a) this.emit('chart', { beatmap_id: id, analysis: a });
    } catch (e) {
      this.q.saveChart.run('error', null, Date.now(), JSON.stringify({ error: e.message }), id);
      this.log.error?.(`[chart] ${id}: ${e.message}`);
    }
    return true;
  }

  /** Track a player outside any roster (signed-in users and people they follow). */
  pin(user) {
    const existing = this.q.player.get(user.id);
    if (!existing && this.q.pinnedCount.get().n >= this.config.maxPinned) return false;
    const s = user.stats || {};
    this.q.pinPlayer.run({
      id: user.id, username: user.username, avatar_url: user.avatar_url, cover_url: user.cover_url ?? null,
      country: user.country_code || 'XX', pp: s.pp ?? null, pp_4k: s.pp_4k ?? null, pp_7k: s.pp_7k ?? null,
      global_rank: s.global_rank ?? null, country_rank: s.country_rank ?? null, accuracy: s.accuracy ?? null,
      play_count: s.play_count ?? null, ranked_score: s.ranked_score ?? null,
    });
    return true;
  }

  /** Called when a profile is fetched from osu!: keeps history and best plays fresh for any player. */
  recordProfile(user, best) {
    const s = user.stats || {};
    this.q.upsertHistory.run(user.id, today(), s.country_rank ?? null, s.global_rank ?? null, s.pp ?? null);
    let p = this.q.player.get(user.id);
    if (p) {
      this.q.upsertProfile.run({ id: user.id, username: user.username, avatar_url: user.avatar_url, pp: s.pp ?? null, pp_4k: s.pp_4k ?? null, pp_7k: s.pp_7k ?? null, global_rank: s.global_rank ?? null, accuracy: s.accuracy ?? null, play_count: s.play_count ?? null });
    }
    // best plays change slowly; re-storing them costs ~200 row writes, so at most every 6 hours
    const last = (this.bestStoredAt ||= new Map()).get(user.id) || 0;
    if (best?.length && Date.now() - last > 6 * 3600_000) {
      this.bestStoredAt.set(user.id, Date.now());
      this.storeBest(p || { id: user.id, country: user.country_code }, best);
    }
  }

  // ---------- scheduling ----------

  rankingsDue(country) {
    const t = Number(this.meta(`rankings:${country}`) || 0);
    return Date.now() - t > this.config.rankingsRefreshMinutes * 60_000;
  }

  isHot(p) {
    return Date.now() - p.last_score_at < this.config.hotWindowMinutes * 60_000;
  }

  buildQueue() {
    const countries = this.activeCountries();
    for (let tries = 0; tries < this.config.coldEvery && !this.queue.length; tries++) {
      this.cycle++;
      const due = (p) => !p.initialized || this.isHot(p) || this.cycle % this.config.coldEvery === 0;
      for (const country of countries) for (const p of this.q.roster.all(country)) if (due(p)) this.queue.push(p.id);
      for (const p of this.q.pinnedPlayers.all()) if (due(p)) this.queue.push(p.id);
    }
  }

  /**
   * One unit of work, in priority order: due rankings, requested leaderboards, chart analysis
   * (every Nth step), then polling the next player. Returns what it did.
   */
  async step() {
    this.steps++;
    for (const country of this.activeCountries()) {
      if (this.rankingsDue(country)) {
        try {
          await this.refreshRankings(country);
        } catch (e) {
          this.setMeta(`rankings:${country}`, Date.now() - (this.config.rankingsRefreshMinutes - 5) * 60_000);
          this.log.error?.(`[rankings] ${country}: ${e.message}`);
        }
        return 'rankings';
      }
    }
    const lb = this.pendingLeaderboards.values().next().value;
    if (lb) {
      try { await this.refreshLeaderboard(lb); } catch (e) { this.pendingLeaderboards.delete(lb); this.log.error?.(`[leaderboard] ${lb}: ${e.message}`); }
      return 'leaderboard';
    }
    if (this.steps % this.config.analyzeEvery === 0 && (await this.analyzeNext())) return 'chart';
    if (!this.queue.length) this.buildQueue();
    const id = this.queue.shift();
    if (id === undefined) return (await this.analyzeNext()) ? 'chart' : 'idle';
    const player = this.q.player.get(id);
    if (!player) return 'poll';
    try {
      await this.pollPlayer(player);
    } catch (e) {
      this.log.error?.(`[poll] ${player.username}: ${e.message}`);
    }
    return 'poll';
  }

  async start() {
    this.running = true;
    while (this.running) {
      const r = await this.step();
      if (r === 'idle') await new Promise((res) => setTimeout(res, 2000));
    }
  }

  stop() {
    this.running = false;
  }

  // ---------- reads ----------

  rankings(country, page = 1, pageSize = 50) {
    const rows = this.db
      .prepare(`SELECT * FROM players WHERE country = ? AND on_roster = 1 ORDER BY country_rank LIMIT ? OFFSET ?`)
      .all(country, pageSize, (page - 1) * pageSize);
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM players WHERE country = ? AND on_roster = 1`).get(country).n;
    const day = today();
    const fetched = Number(this.meta(`rankings:${country}`) || 0);
    return {
      country, page, pageSize, total,
      fetchedAt: fetched || null,
      updating: !fetched,
      ranking: rows.map((p) => {
        const prev = this.q.prevHistory.get(p.id, day);
        return {
          rank: p.country_rank,
          user: userLite(p),
          pp: p.pp, pp_4k: p.pp_4k, pp_7k: p.pp_7k,
          global_rank: p.global_rank,
          accuracy: p.accuracy,
          play_count: p.play_count,
          rank_change: prev?.country_rank ? prev.country_rank - p.country_rank : 0,
          pp_change: prev?.pp ? round2(p.pp - prev.pp) : 0,
        };
      }),
    };
  }

  /** Cached global / variant leaderboard. Schedules a refresh when stale. */
  leaderboard(kind, page = 1, pageSize = 50) {
    const fetched = Number(this.meta(`lb:${kind}`) || 0);
    if (Date.now() - fetched > this.config.leaderboardTtlMinutes * 60_000) this.pendingLeaderboards.add(kind);
    const rows = this.db.prepare(`SELECT rank, json FROM leaderboards WHERE kind = ? ORDER BY rank LIMIT ? OFFSET ?`).all(kind, pageSize, (page - 1) * pageSize);
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM leaderboards WHERE kind = ?`).get(kind).n;
    return {
      kind, page, pageSize, total, fetchedAt: fetched || null, updating: this.pendingLeaderboards.has(kind),
      ranking: rows.map((r) => {
        const x = JSON.parse(r.json);
        return { rank: r.rank, user: x.user, pp: x.pp, pp_4k: x.pp_4k, pp_7k: x.pp_7k, global_rank: x.global_rank, accuracy: x.accuracy, play_count: x.play_count, rank_change: 0, pp_change: 0 };
      }),
    };
  }

  skillLeaderboard(keys, country = null, limit = 100) {
    const rows = country
      ? this.db.prepare(`SELECT c.*, p.username, p.avatar_url, p.country AS pc FROM skill_cache c JOIN players p ON p.id = c.user_id WHERE c.keys = ? AND p.country = ? AND c.overall IS NOT NULL ORDER BY c.overall DESC LIMIT ?`).all(keys, country, limit)
      : this.db.prepare(`SELECT c.*, p.username, p.avatar_url, p.country AS pc FROM skill_cache c JOIN players p ON p.id = c.user_id WHERE c.keys = ? AND c.overall IS NOT NULL ORDER BY c.overall DESC LIMIT ?`).all(keys, limit);
    return rows.map((r, i) => {
      const s = JSON.parse(r.json);
      return { rank: i + 1, user: { id: r.user_id, username: r.username, avatar_url: r.avatar_url, country_code: r.pc }, overall: r.overall, dan: s.dan, skillsets: Object.fromEntries(Object.entries(s.skillsets).map(([k, v]) => [k, v.rating])) };
    });
  }

  feed(country, limit = 30, offset = 0) {
    const rows = this.db.prepare(`SELECT json FROM scores WHERE country = ? ORDER BY ended_at DESC LIMIT ? OFFSET ?`).all(country, limit, offset);
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM scores WHERE country = ?`).get(country).n;
    return { country, total, offset, scores: rows.map((r) => JSON.parse(r.json)) };
  }

  topPlays(country, windowMs, limit = 50) {
    const rows = this.db
      .prepare(`SELECT json FROM scores WHERE country = ? AND ended_at >= ? AND best_position >= 0 ORDER BY pp DESC LIMIT ?`)
      .all(country, Date.now() - windowMs, limit);
    return { country, window: windowMs, plays: rows.map((r) => JSON.parse(r.json)) };
  }

  snipes(country, limit = 50, offset = 0) {
    const rows = this.db.prepare(`SELECT json FROM snipes WHERE country = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(country, limit, offset);
    return { country, snipes: rows.map((r) => JSON.parse(r.json)) };
  }

  snipeBoard(country) {
    const holders = this.db.prepare(`
      WITH ranked AS (
        SELECT user_id, ROW_NUMBER() OVER (PARTITION BY beatmap_id ORDER BY total_score DESC) AS rn
        FROM map_best WHERE country = ?)
      SELECT r.user_id, COUNT(*) AS firsts, p.username, p.avatar_url FROM ranked r LEFT JOIN players p ON p.id = r.user_id
      WHERE rn = 1 GROUP BY r.user_id ORDER BY firsts DESC LIMIT 25`).all(country);
    const since = Date.now() - 7 * DAY;
    const snipers = this.db.prepare(`SELECT sniper_id AS id, COUNT(*) AS n FROM snipes WHERE country = ? AND created_at >= ? GROUP BY sniper_id ORDER BY n DESC LIMIT 10`).all(country, since);
    const victims = this.db.prepare(`SELECT victim_id AS id, COUNT(*) AS n FROM snipes WHERE country = ? AND created_at >= ? GROUP BY victim_id ORDER BY n DESC LIMIT 10`).all(country, since);
    const named = (list) => list.map((x) => { const p = this.q.player.get(x.id); return { user: p ? userLite(p) : { id: x.id, username: `#${x.id}` }, count: x.n }; });
    return {
      country,
      holders: holders.map((h) => ({ user: { id: h.user_id, username: h.username ?? `#${h.user_id}`, avatar_url: h.avatar_url, country_code: country }, firsts: h.firsts })),
      snipers: named(snipers),
      victims: named(victims),
    };
  }

  mostPlayed(country, windowMs, limit = 50) {
    const rows = this.db.prepare(`
      SELECT s.beatmap_id, COUNT(*) AS plays, COUNT(DISTINCT s.user_id) AS players, MAX(s.pp) AS top_pp, b.*
      FROM scores s LEFT JOIN beatmaps b ON b.id = s.beatmap_id
      WHERE s.country = ? AND s.ended_at >= ?
      GROUP BY s.beatmap_id ORDER BY plays DESC, players DESC LIMIT ?`).all(country, Date.now() - windowMs, limit);
    return rows.map((r) => ({ beatmap: beatmapOut(r, r.beatmap_id), plays: r.plays, players: r.players, top_pp: r.top_pp, analysis: this.chartAnalysis(r.beatmap_id) }));
  }

  chartAnalysis(id) {
    const c = this.q.chart.get(id);
    if (!c) return null;
    return c.status === 'done' ? { status: 'done', ...JSON.parse(c.json) } : { status: c.status };
  }

  mapDetail(id, country = null) {
    const b = this.q.beatmap.get(id);
    if (!this.q.chart.get(id)) this.q.queueChart.run(id, Date.now() - DAY); // jump the queue
    const lbRows = country
      ? this.db.prepare(`SELECT m.*, p.username, p.avatar_url, p.country AS pc FROM map_best m LEFT JOIN players p ON p.id = m.user_id WHERE m.beatmap_id = ? AND m.country = ? ORDER BY m.total_score DESC LIMIT 50`).all(id, country)
      : this.db.prepare(`SELECT m.*, p.username, p.avatar_url, p.country AS pc FROM map_best m LEFT JOIN players p ON p.id = m.user_id WHERE m.beatmap_id = ? ORDER BY m.total_score DESC LIMIT 50`).all(id);
    const recent = this.db.prepare(`SELECT json FROM scores WHERE beatmap_id = ? ORDER BY ended_at DESC LIMIT 20`).all(id).map((r) => JSON.parse(r.json));
    const snipes = this.db.prepare(`SELECT json FROM snipes WHERE beatmap_id = ? ORDER BY created_at DESC LIMIT 10`).all(id).map((r) => JSON.parse(r.json));
    return {
      beatmap: b ? beatmapOut(b, id) : null,
      analysis: this.chartAnalysis(id),
      leaderboard: lbRows.map((r, i) => ({ rank: i + 1, user: { id: r.user_id, username: r.username ?? `#${r.user_id}`, avatar_url: r.avatar_url, country_code: r.pc }, total_score: r.total_score, accuracy: r.accuracy, pp: r.pp, mods: JSON.parse(r.mods || '[]'), grade: r.rank, ended_at: r.ended_at })),
      recent,
      snipes,
    };
  }

  playerScores(userId, limit = 30) {
    return this.db.prepare(`SELECT json FROM scores WHERE user_id = ? ORDER BY ended_at DESC LIMIT ?`).all(userId, limit).map((r) => JSON.parse(r.json));
  }

  findPlayer(idOrName) {
    return /^\d+$/.test(String(idOrName)) ? this.q.player.get(Number(idOrName)) : this.q.playerByName.get(String(idOrName));
  }

  history(userId) {
    const snapshots = this.db.prepare(`SELECT day, pp, global_rank, country_rank FROM rank_history WHERE user_id = ? ORDER BY day`).all(userId);
    const since = Date.now() - 182 * DAY;
    const tracked = this.db.prepare(`SELECT ended_at FROM scores WHERE user_id = ? AND ended_at >= ?`).all(userId, since).map((r) => r.ended_at);
    const bestTimes = this.db.prepare(`SELECT ended_at FROM best WHERE user_id = ? AND ended_at >= ?`).all(userId, since).map((r) => r.ended_at);
    const activity = {};
    for (const t of [...tracked, ...bestTimes]) { const d = today(t); activity[d] = (activity[d] || 0) + 1; }
    const keySplit = {};
    for (const r of this.db.prepare(`SELECT b.keys, COUNT(*) AS n FROM best x LEFT JOIN beatmaps b ON b.id = x.beatmap_id WHERE x.user_id = ? GROUP BY b.keys`).all(userId)) {
      keySplit[r.keys ?? '?'] = r.n;
    }
    const skills = this.db.prepare(`SELECT day, keys, overall FROM skill_history WHERE user_id = ? ORDER BY day`).all(userId);
    return { snapshots, activity, keySplit, skills };
  }

  /** Compute (and cache) a player's skill ratings from their top plays + tracked scores. */
  skills(userId, country = null) {
    const best = this.db.prepare(`SELECT beatmap_id, accuracy, mods, ended_at FROM best WHERE user_id = ?`).all(userId)
      .map((r) => ({ beatmap_id: r.beatmap_id, accuracy: r.accuracy, mods: JSON.parse(r.mods || '[]'), ended_at: r.ended_at }));
    const tracked = this.db.prepare(`SELECT json FROM scores WHERE user_id = ? ORDER BY ended_at DESC LIMIT 400`).all(userId)
      .map((r) => JSON.parse(r.json)).map((s) => ({ beatmap_id: s.beatmap_id, accuracy: s.accuracy, mods: s.mods, ended_at: Date.parse(s.ended_at) }));
    const plays = [...best, ...tracked];
    const ids = [...new Set(plays.map((p) => p.beatmap_id))];
    const charts = new Map();
    let pending = 0;
    for (const id of ids) {
      const c = this.q.chart.get(id);
      if (!c) { this.q.queueChart.run(id, Date.now()); pending++; continue; }
      if (c.status === 'queued') pending++;
      else if (c.status === 'done') charts.set(id, JSON.parse(c.json));
    }
    const result = computeSkills(plays, charts);
    // cache + daily history (throttled to avoid needless writes)
    const cached = Object.fromEntries(this.q.skillCacheFor.all(userId).map((r) => [r.keys, r]));
    const now = Date.now();
    for (const [keys, r] of Object.entries(result)) {
      const prev = cached[keys];
      if (prev && prev.overall === r.overall && now - prev.updated_at < 3600_000) continue;
      const slim = JSON.stringify({ dan: r.dan, overall: r.overall, skillsets: Object.fromEntries(Object.entries(r.skillsets).map(([k, v]) => [k, { rating: v.rating, plays: v.plays }])) });
      this.q.upsertSkillCache.run(userId, Number(keys), country, r.overall, slim, now);
      if (r.overall != null) this.q.upsertSkillHistory.run(userId, today(now), Number(keys), r.overall, slim);
    }
    const history = this.db.prepare(`SELECT day, keys, overall, json FROM skill_history WHERE user_id = ? ORDER BY day`).all(userId)
      .map((h) => ({ day: h.day, keys: h.keys, overall: h.overall, skillsets: Object.fromEntries(Object.entries(JSON.parse(h.json).skillsets).map(([k, v]) => [k, v.rating])) }));
    return { model: MODEL, keys: result, analyzed: charts.size, pending, plays: plays.length, history, queue: this.q.queuedCharts.get().n };
  }

  // ---------- follows ----------

  follow(userId, targetId) {
    this.db.prepare(`INSERT OR IGNORE INTO follows (user_id, target_id, created_at) VALUES (?, ?, ?)`).run(userId, targetId, Date.now());
  }
  unfollow(userId, targetId) {
    this.db.prepare(`DELETE FROM follows WHERE user_id = ? AND target_id = ?`).run(userId, targetId);
  }
  following(userId) {
    return this.db.prepare(`SELECT p.* FROM follows f JOIN players p ON p.id = f.target_id WHERE f.user_id = ? ORDER BY f.created_at DESC`).all(userId).map((p) => ({ ...userLite(p), pp: p.pp, global_rank: p.global_rank }));
  }
  followingFeed(userId, limit = 50) {
    return this.db.prepare(`SELECT s.json FROM scores s JOIN follows f ON f.target_id = s.user_id WHERE f.user_id = ? ORDER BY s.ended_at DESC LIMIT ?`).all(userId, limit).map((r) => JSON.parse(r.json));
  }

  stats() {
    const c = (sql) => this.db.prepare(sql).get().n;
    return {
      cycle: this.cycle,
      players: c(`SELECT COUNT(*) AS n FROM players WHERE on_roster = 1 OR pinned = 1`),
      scores: c(`SELECT COUNT(*) AS n FROM scores`),
      charts: c(`SELECT COUNT(*) AS n FROM charts WHERE status = 'done'`),
      chartQueue: c(`SELECT COUNT(*) AS n FROM charts WHERE status = 'queued'`),
      snipes: c(`SELECT COUNT(*) AS n FROM snipes`),
      activeCountries: this.activeCountries(),
      apiRequests: this.osu.requestCount,
    };
  }
}

export const userLite = (p) => ({ id: p.id, username: p.username, avatar_url: p.avatar_url, country_code: p.country });
const round2 = (n) => Math.round(n * 100) / 100;
const beatmapOut = (b, id) => ({
  id: b.id ?? id, set_id: b.set_id, title: b.title, artist: b.artist, version: b.version, creator: b.creator,
  keys: b.keys, sr: b.sr, bpm: b.bpm, status: b.status, cover: b.cover, url: b.url,
});
