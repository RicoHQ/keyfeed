// The core loop: keep a per-country roster of top players, poll their recent scores,
// dedupe, work out pp gain, store, and emit events for the SSE hub.
//
// Work is split into small `step()` units so the same code runs as a `while` loop in Node
// and as alarm-driven bursts inside a Cloudflare Durable Object.
import { EventEmitter } from 'node:events';
import { today, DATA_TABLES } from './schema.js';
import { evaluateScore, mergeBest } from './pp.js';

export class Tracker extends EventEmitter {
  constructor({ db, osu, config, log = console }) {
    super();
    this.db = db;
    this.osu = osu;
    this.config = config;
    this.log = log;
    this.running = false;
    this.cycle = 0;
    this.queue = [];
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
      clearRoster: d.prepare(`UPDATE players SET on_roster = 0 WHERE country = ? AND updated_at < ? AND on_roster = 1`),
      upsertHistory: d.prepare(`
        INSERT INTO rank_history (user_id, day, country_rank, global_rank, pp) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, day) DO UPDATE SET country_rank=excluded.country_rank, global_rank=excluded.global_rank, pp=excluded.pp`),
      prevHistory: d.prepare(`SELECT country_rank, global_rank, pp FROM rank_history WHERE user_id = ? AND day < ? ORDER BY day DESC LIMIT 1`),
      roster: d.prepare(`SELECT id, last_score_at, initialized FROM players WHERE country = ? AND on_roster = 1 ORDER BY country_rank`),
      player: d.prepare(`SELECT * FROM players WHERE id = ?`),
      scoreExists: d.prepare(`SELECT 1 AS x FROM scores WHERE id = ?`),
      insertScore: d.prepare(`
        INSERT OR IGNORE INTO scores (id, user_id, country, beatmap_id, pp, pp_gain, weighted_pp, best_position, ended_at, json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      markPolled: d.prepare(`UPDATE players SET initialized = 1, last_score_at = MAX(last_score_at, ?) WHERE id = ?`),
      bestFor: d.prepare(`SELECT beatmap_id, pp FROM best WHERE user_id = ?`),
      clearBest: d.prepare(`DELETE FROM best WHERE user_id = ?`),
      insertBest: d.prepare(`INSERT OR REPLACE INTO best (user_id, beatmap_id, pp) VALUES (?, ?, ?)`),
      markBestLoaded: d.prepare(`UPDATE players SET best_loaded = 1 WHERE id = ?`),
      prune: d.prepare(`DELETE FROM scores WHERE ended_at < ?`),
      pruneHistory: d.prepare(`DELETE FROM rank_history WHERE day < ?`),
      getMeta: d.prepare(`SELECT value FROM meta WHERE key = ?`),
      setMeta: d.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    };
  }

  meta(key) { return this.q.getMeta.get(key)?.value ?? null; }
  setMeta(key, value) { this.q.setMeta.run(key, String(value)); }

  /** Wipe data if we switched between demo and real data (e.g. after adding osu! credentials). */
  ensureMode(mode) {
    if (this.meta('mode') === mode) return;
    this.db.transaction(() => {
      for (const t of DATA_TABLES) this.db.prepare(`DELETE FROM ${t}`).run();
      this.db.prepare(`DELETE FROM meta WHERE key LIKE 'rankings:%'`).run();
      this.setMeta('mode', mode);
    });
    this.queue = [];
  }

  // ---------- writes ----------

  async refreshRankings(country) {
    const started = Date.now();
    const pages = Math.ceil(this.config.rosterSize / 50);
    const rows = [];
    for (let page = 1; page <= pages; page++) {
      const { ranking } = await this.osu.rankings(country, page);
      rows.push(...ranking);
      if (ranking.length < 50) break;
    }
    const day = today(started);
    this.db.transaction(() => {
      rows.slice(0, this.config.rosterSize).forEach((r, i) => {
        const rank = i + 1;
        this.q.upsertPlayer.run({
          id: r.user.id, username: r.user.username, avatar_url: r.user.avatar_url, cover_url: r.user.cover_url,
          country, pp: r.pp, pp_4k: r.pp_4k, pp_7k: r.pp_7k, global_rank: r.global_rank, country_rank: rank,
          accuracy: r.accuracy, play_count: r.play_count, ranked_score: r.ranked_score, now: started,
        });
        this.q.upsertHistory.run(r.user.id, day, rank, r.global_rank, r.pp);
      });
      if (rows.length) this.q.clearRoster.run(country, started);
      this.q.prune.run(started - this.config.retentionDays * 86_400_000);
      this.q.pruneHistory.run(today(started - 14 * 86_400_000));
      this.setMeta(`rankings:${country}`, started);
    });
    this.log.info?.(`[rankings] ${country}: ${Math.min(rows.length, this.config.rosterSize)} players`);
    this.emit('rankings', { country });
  }

  async ensureBest(player) {
    if (player.best_loaded) return this.q.bestFor.all(player.id);
    const best = await this.osu.bestScores(player.id, 100);
    this.db.transaction(() => {
      this.q.clearBest.run(player.id);
      for (const s of best) if (s.pp > 0) this.q.insertBest.run(player.id, s.beatmap_id, s.pp);
      this.q.markBestLoaded.run(player.id);
    });
    player.best_loaded = 1;
    return this.q.bestFor.all(player.id);
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
          this.db.transaction(() => {
            for (const b of mergeBest(best, s)) if (b.beatmap_id === s.beatmap_id) this.q.insertBest.run(player.id, b.beatmap_id, b.pp);
          });
        }
      }
      const enriched = { ...s, pp_gain: ev.ppGain, weighted_pp: ev.weightedPP, best_position: ev.position };
      this.q.insertScore.run(s.id, player.id, player.country, s.beatmap_id, s.pp, ev.ppGain, ev.weightedPP,
        ev.position, endedAt, JSON.stringify(enriched));
      if (!silent) {
        this.emit('score', { country: player.country, score: enriched });
        if (ev.position >= 0) this.emit('top_play', { country: player.country, score: enriched });
      }
    }
    // Only write when something changed: keeps row writes low (Cloudflare bills/limits them).
    if (silent || latest > player.last_score_at) this.q.markPolled.run(latest, player.id);
    player.initialized = 1;
    player.last_score_at = Math.max(player.last_score_at || 0, latest);
    return fresh.length;
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
    for (let tries = 0; tries < this.config.coldEvery && !this.queue.length; tries++) {
      this.cycle++;
      for (const country of this.config.countries) {
        for (const p of this.q.roster.all(country)) {
          if (!p.initialized || this.isHot(p) || this.cycle % this.config.coldEvery === 0) this.queue.push(p.id);
        }
      }
    }
  }

  /**
   * Do one unit of work: refresh a country's rankings if due, otherwise poll the next player.
   * Returns 'rankings' | 'poll' | 'idle'.
   */
  async step() {
    for (const country of this.config.countries) {
      if (this.rankingsDue(country)) {
        try {
          await this.refreshRankings(country);
        } catch (e) {
          // don't hammer a failing endpoint: pretend it ran, retry in 5 minutes
          this.setMeta(`rankings:${country}`, Date.now() - (this.config.rankingsRefreshMinutes - 5) * 60_000);
          this.log.error?.(`[rankings] ${country}: ${e.message}`);
        }
        return 'rankings';
      }
    }
    if (!this.queue.length) this.buildQueue();
    const id = this.queue.shift();
    if (id === undefined) return 'idle';
    const player = this.q.player.get(id);
    if (!player || !player.on_roster) return 'poll';
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
      country,
      page,
      pageSize,
      total,
      fetchedAt: fetched || null,
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

  feed(country, limit = 30, offset = 0) {
    const rows = this.db
      .prepare(`SELECT json FROM scores WHERE country = ? ORDER BY ended_at DESC LIMIT ? OFFSET ?`)
      .all(country, limit, offset);
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM scores WHERE country = ?`).get(country).n;
    return { country, total, offset, scores: rows.map((r) => JSON.parse(r.json)) };
  }

  topPlays(country, windowMs, limit = 50) {
    const rows = this.db
      .prepare(`SELECT json FROM scores WHERE country = ? AND ended_at >= ? AND best_position >= 0 ORDER BY pp DESC LIMIT ?`)
      .all(country, Date.now() - windowMs, limit);
    return { country, window: windowMs, plays: rows.map((r) => JSON.parse(r.json)) };
  }

  playerScores(userId, limit = 30) {
    return this.db
      .prepare(`SELECT json FROM scores WHERE user_id = ? ORDER BY ended_at DESC LIMIT ?`)
      .all(userId, limit)
      .map((r) => JSON.parse(r.json));
  }

  stats() {
    const c = (sql) => this.db.prepare(sql).get().n;
    return {
      cycle: this.cycle,
      players: c(`SELECT COUNT(*) AS n FROM players WHERE on_roster = 1`),
      scores: c(`SELECT COUNT(*) AS n FROM scores`),
      apiRequests: this.osu.requestCount,
    };
  }
}

export const userLite = (p) => ({ id: p.id, username: p.username, avatar_url: p.avatar_url, country_code: p.country });
const round2 = (n) => Math.round(n * 100) / 100;
