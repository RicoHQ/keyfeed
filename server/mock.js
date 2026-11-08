// Fake osu! API with the same interface as OsuClient, for running the app without credentials.
// Everything here is invented: player names, maps, artists and charts are placeholders.
import { makeOsu } from './mockchart.js';

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const SYL = ['ka', 'ri', 'no', 'vex', 'lu', 'mi', 'tor', 'zen', 'ra', 'kyo', 'sol', 'fen', 'ash', 'iro', 'pul', 'dex', 'yu', 'ne', 'ko', 'brr'];
const TITLES = ['Glass Orbit', 'Neon Tidal', 'Paper Comet', 'Hollow Arcade', 'Velvet Static', 'Polar Drift', 'Signal Bloom', 'Iron Lullaby', 'Midnight Relay', 'Cobalt Rush', 'Echo Garden', 'Silver Cascade'];
const ARTISTS = ['Lumen Fold', 'Quartz Avenue', 'nightcrane', 'Tessellate', 'Ohm Theory', 'kilowatt kid', 'Parallax Club', 'Ferrous'];
const STYLES = ['stream', 'jumpstream', 'handstream', 'jack', 'chordjack', 'tech', 'ln'];
const STYLE_NAMES = { stream: 'Runner', jumpstream: 'Leaps', handstream: 'Hands', jack: 'Anvil', chordjack: 'Pillars', tech: 'Puzzle', ln: 'Holds' };
const MODS = [[], [], [], [], ['CL'], ['HD'], ['DT'], ['CL', 'DT'], ['NF'], ['HT']];

function avatar(name, hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl(${hue} 55% 42%)"/><text x="32" y="41" font-family="sans-serif" font-size="26" font-weight="700" fill="#fff" text-anchor="middle">${name.slice(0, 2).toUpperCase()}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function hashStr(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export class MockOsuClient {
  constructor({ countries = ['US'], perCountry = 120, seed = 7, delayMs = 0, activityScale = 1 } = {}) {
    this.r = rng(seed);
    this.seed = seed;
    this.delayMs = delayMs;
    this.activityScale = activityScale;
    this.perCountry = perCountry;
    this.requestCount = 0;
    this.users_ = new Map();
    this.byCountry = new Map();
    this.best = new Map();
    // time-based so ids stay unique across restarts (the DB outlives this object on Cloudflare)
    this.nextScoreId = Date.now() * 100;

    const r = rng(seed + 1);
    this.maps = Array.from({ length: 70 }, (_, i) => {
      const keys = r() < 0.62 ? 4 : 7;
      const style = STYLES[i % STYLES.length];
      const sr = Math.round((2 + r() * 7) * 100) / 100;
      return {
        id: 500000 + i,
        keys,
        style,
        version: `[${keys}K] ${STYLE_NAMES[style]} ${['Normal', 'Hard', 'Insane', 'Expert', 'Extra'][Math.min(4, Math.floor(sr / 2))]}`,
        difficulty_rating: sr,
        bpm: 120 + Math.floor(r() * 140),
        beatmapset: { id: 70000 + Math.floor(i / 2), title: TITLES[i % TITLES.length], artist: ARTISTS[i % ARTISTS.length], creator: 'mapper' + (i % 9) },
      };
    });
    this.mapById = new Map(this.maps.map((m) => [m.id, m]));
    for (const c of countries) this.ensureCountry(c);
  }

  ensureCountry(country) {
    if (this.byCountry.has(country)) return this.byCountry.get(country);
    const r = rng(this.seed + hashStr(country));
    const list = [];
    let id = 100000 + (hashStr(country) % 9000) * 1000;
    for (let i = 0; i < this.perCountry; i++) {
      const name = SYL[Math.floor(r() * SYL.length)] + SYL[Math.floor(r() * SYL.length)] + (r() < 0.4 ? Math.floor(r() * 99) : '');
      const pp = Math.round(22000 * Math.exp(-i / 35) * (0.6 + r() * 0.4) + 1500 + r() * 300);
      const u = {
        id: id++,
        username: `${name}_${country.toLowerCase()}`,
        country_code: country,
        avatar_url: avatar(name, Math.floor(r() * 360)),
        pp,
        pp_4k: Math.round(pp * (0.5 + r() * 0.5)),
        pp_7k: Math.round(pp * (0.3 + r() * 0.7)),
        accuracy: 95 + r() * 4,
        play_count: 5000 + Math.floor(r() * 60000),
        ranked_score: Math.floor(r() * 2e9),
        activity: r() ** 2 * this.activityScale,
        favStyle: STYLES[Math.floor(r() * STYLES.length)],
      };
      list.push(u);
      this.users_.set(u.id, u);
    }
    this.byCountry.set(country, list);
    this.rerank();
    return list;
  }

  rerank() {
    const all = [...this.users_.values()].sort((a, b) => b.pp - a.pp);
    all.forEach((u, i) => (u.global_rank = i + 1));
    for (const list of this.byCountry.values()) [...list].sort((a, b) => b.pp - a.pp).forEach((u, i) => (u.country_rank = i + 1));
  }

  wait() {
    this.requestCount++;
    return this.delayMs ? new Promise((res) => setTimeout(res, this.delayMs)) : Promise.resolve();
  }

  lite(u) {
    return { id: u.id, username: u.username, avatar_url: u.avatar_url, country_code: u.country_code, cover_url: null };
  }

  async rankings(country, page = 1, variant = null) {
    await this.wait();
    const pool = country ? this.ensureCountry(country) : [...this.users_.values()];
    for (const u of pool) if (this.r() < 0.05) u.pp += Math.round(this.r() * 40);
    const key = variant === '4k' ? 'pp_4k' : variant === '7k' ? 'pp_7k' : 'pp';
    const list = [...pool].sort((a, b) => b[key] - a[key]);
    return {
      total: list.length,
      ranking: list.slice((page - 1) * 50, page * 50).map((u) => ({
        user: this.lite(u),
        pp: u[key], pp_4k: u.pp_4k, pp_7k: u.pp_7k,
        global_rank: u.global_rank, country_rank: null,
        accuracy: u.accuracy, play_count: u.play_count, ranked_score: u.ranked_score,
        grade_counts: { ss: 50, ssh: 0, s: 400, sh: 0, a: 200 },
      })),
    };
  }

  makeScore(u, { forBest = false } = {}) {
    const r = this.r;
    // players lean toward their favourite pattern
    const pool = r() < 0.45 ? this.maps.filter((m) => m.style === u.favStyle) : this.maps;
    const map = pool[Math.floor(r() * pool.length)];
    const skill = u.pp / 25000;
    const acc = Math.min(0.999, 0.9 + r() * 0.085 + skill * 0.015);
    const base = forBest ? 0.6 + r() * 0.4 : r() ** 3;
    const pp = Math.round(map.difficulty_rating * 70 * skill * base * acc * 100) / 100;
    const total = Math.min(1000000, Math.floor(600000 + acc * 400000 * (0.8 + r() * 0.2)));
    const notes = 800 + Math.floor(r() * 3000);
    const rank = acc > 0.99 ? 'SS' : acc > 0.95 ? 'S' : acc > 0.9 ? 'A' : 'B';
    return {
      id: this.nextScoreId++,
      user_id: u.id,
      beatmap_id: map.id,
      accuracy: acc,
      total_score: total,
      legacy_total_score: null,
      max_combo: Math.floor(notes * (0.3 + r() * 0.7)),
      rank,
      passed: true,
      pp: pp > 1 ? pp : null,
      mods: MODS[Math.floor(r() * MODS.length)],
      statistics: { perfect: Math.floor(notes * acc * 0.7), great: Math.floor(notes * acc * 0.25), good: Math.floor(notes * 0.03), ok: Math.floor(notes * 0.01), meh: 3, miss: Math.floor(r() * 20) },
      ended_at: new Date(Date.now() - (forBest ? Math.floor(r() * 3e10) : Math.floor(r() * 60000))).toISOString(),
      has_replay: r() < 0.6,
      beatmap: { id: map.id, version: map.version, difficulty_rating: map.difficulty_rating, keys: map.keys, bpm: map.bpm, status: 'ranked', url: '#' },
      beatmapset: { id: map.beatmapset.id, title: map.beatmapset.title, artist: map.beatmapset.artist, creator: map.beatmapset.creator, cover: null, card: null },
      user: this.lite(u),
    };
  }

  async recentScores(userId) {
    await this.wait();
    const u = this.users_.get(Number(userId));
    if (!u) return [];
    const out = [];
    if (this.r() < u.activity) out.push(this.makeScore(u));
    if (this.r() < 0.03 * Math.min(1, this.activityScale * 3)) {
      const s = this.makeScore(u, { forBest: true });
      s.pp = Math.round((s.pp || 100) * 1.25 * 100) / 100;
      s.total_score = Math.min(1000000, s.total_score + 20000);
      s.ended_at = new Date().toISOString();
      out.push(s);
    }
    return out;
  }

  async bestScores(userId) {
    await this.wait();
    const u = this.users_.get(Number(userId));
    if (!u) return [];
    if (!this.best.has(u.id)) {
      const seen = new Set();
      const list = [];
      for (let i = 0; i < 200 && list.length < 100; i++) {
        const s = this.makeScore(u, { forBest: true });
        if (!s.pp || seen.has(s.beatmap_id)) continue;
        seen.add(s.beatmap_id);
        list.push(s);
      }
      this.best.set(u.id, list.sort((a, b) => b.pp - a.pp));
    }
    return this.best.get(u.id);
  }

  profile(u) {
    const r = rng(u.id);
    let rank = u.global_rank + 200;
    const history = Array.from({ length: 90 }, () => (rank = Math.max(1, Math.round(rank - (r() - 0.35) * 8))));
    history[89] = u.global_rank;
    return {
      ...this.lite(u),
      join_date: '2019-04-01T00:00:00Z',
      is_online: this.r() < 0.3,
      rank_history: history,
      rank_highest: { rank: Math.min(...history), updated_at: '2026-05-10T00:00:00Z' },
      stats: {
        pp: u.pp, pp_4k: u.pp_4k, pp_7k: u.pp_7k, global_rank: u.global_rank, country_rank: u.country_rank,
        accuracy: u.accuracy, play_count: u.play_count, play_time: u.play_count * 140, ranked_score: u.ranked_score,
        max_combo: 4000, grade_counts: { ss: 50, ssh: 0, s: 400, sh: 0, a: 200 }, level: 100,
      },
    };
  }

  async user(idOrName) {
    await this.wait();
    const u = /^\d+$/.test(String(idOrName))
      ? this.users_.get(Number(idOrName))
      : [...this.users_.values()].find((x) => x.username.toLowerCase() === String(idOrName).toLowerCase());
    return u ? this.profile(u) : null;
  }

  async beatmap(id) {
    await this.wait();
    const m = this.mapById.get(Number(id));
    if (!m) return null;
    return { id: m.id, set_id: m.beatmapset.id, title: m.beatmapset.title, artist: m.beatmapset.artist, version: m.version, creator: m.beatmapset.creator, keys: m.keys, sr: m.difficulty_rating, bpm: m.bpm, status: 'ranked', cover: null, url: '#' };
  }

  async beatmapFile(id) {
    await this.wait();
    const m = this.mapById.get(Number(id));
    if (!m) return null;
    const nps = (m.keys === 4 ? 3 : 4.2) + m.difficulty_rating * (m.keys === 4 ? 1.9 : 2.5);
    return makeOsu({ keys: m.keys, style: m.style, nps, seconds: 60 + (m.id % 5) * 25, seed: m.id, title: m.beatmapset.title, version: m.version });
  }

  /**
   * Fake global score feed. Scores come from players in many countries (weighted toward big
   * mania countries) and, like the worst case of the real feed, carry only user_id / beatmap_id:
   * user country and beatmap details must be looked up with users() / beatmaps().
   */
  async scoresFeed(cursor = null) {
    await this.wait();
    if (!this.world) {
      const big = ['US', 'KR', 'CN', 'JP', 'RU', 'BR', 'PH', 'ID', 'DE', 'PL', 'VN', 'CL', 'GB', 'FR', 'CA', 'TW', 'TH', 'MX', 'AR', 'AU'];
      const small = ['CY', 'IL', 'FI', 'NL', 'ES', 'IT', 'SE', 'NO', 'NZ', 'SG', 'MY', 'HK', 'PE', 'UA', 'TR', 'PT'];
      this.world = [...big.map((c) => [c, 3]), ...small.map((c) => [c, 1])];
      this.worldWeight = this.world.reduce((n, [, w]) => n + w, 0);
      this.feedClock = Date.now();
    }
    const now = Date.now();
    const elapsed = cursor ? Math.min(120_000, now - this.feedClock) : 60_000;
    this.feedClock = now;
    const count = Math.max(1, Math.round((elapsed / 1000) * 2 * this.activityScale * (0.6 + this.r() * 0.8))); // ~2 scores/s at full scale
    const out = [];
    for (let i = 0; i < count; i++) {
      let x = this.r() * this.worldWeight, country = this.world[0][0];
      for (const [c, w] of this.world) { if ((x -= w) <= 0) { country = c; break; } }
      const list = this.ensureCountry(country);
      // top players play more often
      const u = list[Math.min(list.length - 1, Math.floor(list.length * this.r() ** 2.2))];
      const sc = this.makeScore(u);
      sc.ended_at = new Date(now - Math.floor(this.r() * Math.min(elapsed, 30_000))).toISOString();
      if (this.r() < 0.04) { sc.pp = Math.round(((sc.pp || 50) * 3 + 100) * 100) / 100; sc.total_score = Math.min(1000000, sc.total_score + 30000); }
      delete sc.user; sc.beatmap = {}; sc.beatmapset = {};
      out.push(sc);
    }
    out.sort((a, b) => Date.parse(a.ended_at) - Date.parse(b.ended_at));
    return { scores: out, cursor: String(this.nextScoreId) };
  }

  async users(ids) {
    await this.wait();
    return ids.slice(0, 50).map((id) => this.users_.get(Number(id))).filter(Boolean).map((u) => this.lite(u));
  }

  async beatmaps(ids) {
    await this.wait();
    return ids.slice(0, 50).map((id) => this.mapById.get(Number(id))).filter(Boolean).map((m) => ({
      id: m.id, set_id: m.beatmapset.id, title: m.beatmapset.title, artist: m.beatmapset.artist, version: m.version,
      creator: m.beatmapset.creator, keys: m.keys, sr: m.difficulty_rating, bpm: m.bpm, status: 'ranked', cover: null, url: '#',
    }));
  }

  /** Demo-mode sign-in: picks a tracked player so the logged-in UI can be tried without osu! OAuth. */
  demoUser(country) {
    const list = this.ensureCountry(country);
    return this.profile(list[Math.floor(this.r() * Math.min(40, list.length))]);
  }
}
