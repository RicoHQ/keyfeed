// Fake osu! API with the same interface as OsuClient, for running the app without credentials.
// Everything here is invented: player names, maps and artists are placeholders.

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const SYL = ['ka', 'ri', 'no', 'vex', 'lu', 'mi', 'tor', 'zen', 'ra', 'kyo', 'sol', 'fen', 'ash', 'iro', 'pul', 'dex', 'yu', 'ne', 'ko', 'brr'];
const TITLES = ['Glass Orbit', 'Neon Tidal', 'Paper Comet', 'Hollow Arcade', 'Velvet Static', 'Polar Drift', 'Signal Bloom', 'Iron Lullaby', 'Midnight Relay', 'Cobalt Rush', 'Echo Garden', 'Silver Cascade'];
const ARTISTS = ['Lumen Fold', 'Quartz Avenue', 'nightcrane', 'Tessellate', 'Ohm Theory', 'kilowatt kid', 'Parallax Club', 'Ferrous'];
const DIFFS = ['Easy', 'Normal', 'Hard', 'Insane', 'Expert', 'Extra', 'Extreme'];
const MODS = [[], [], [], [], ['CL'], ['HD'], ['DT'], ['CL', 'DT'], ['NF']];

function avatar(name, hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl(${hue} 55% 42%)"/><text x="32" y="41" font-family="sans-serif" font-size="26" font-weight="700" fill="#fff" text-anchor="middle">${name.slice(0, 2).toUpperCase()}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export class MockOsuClient {
  constructor({ countries = ['US'], perCountry = 120, seed = 7, delayMs = 0, activityScale = 1 } = {}) {
    const r = rng(seed);
    this.delayMs = delayMs;
    this.activityScale = activityScale;
    this.r = r;
    this.requestCount = 0;
    this.users = new Map();
    this.byCountry = new Map();
    this.best = new Map();
    // time-based so ids stay unique across restarts (the DB outlives this object on Cloudflare)
    this.nextScoreId = Date.now() * 100;
    let id = 100000;

    this.maps = Array.from({ length: 60 }, (_, i) => {
      const keys = r() < 0.65 ? 4 : 7;
      return {
        id: 500000 + i,
        version: `[${keys}K] ${DIFFS[Math.floor(r() * DIFFS.length)]}`,
        difficulty_rating: Math.round((2 + r() * 8) * 100) / 100,
        cs: keys,
        bpm: 120 + Math.floor(r() * 140),
        status: 'ranked',
        beatmapset: { id: 70000 + Math.floor(i / 2), title: TITLES[i % TITLES.length], artist: ARTISTS[i % ARTISTS.length], creator: 'mapper' + (i % 9), covers: {} },
      };
    });

    for (const country of countries) {
      const list = [];
      for (let i = 0; i < perCountry; i++) {
        const name = SYL[Math.floor(r() * SYL.length)] + SYL[Math.floor(r() * SYL.length)] + (r() < 0.4 ? Math.floor(r() * 99) : '');
        const pp = Math.round(22000 * Math.exp(-i / 35) + 1500 + r() * 300);
        const u = {
          id: id++,
          username: `${name}_${country.toLowerCase()}`,
          country_code: country,
          avatar_url: avatar(name, Math.floor(r() * 360)),
          cover_url: null,
          pp,
          pp_4k: Math.round(pp * (0.5 + r() * 0.5)),
          pp_7k: Math.round(pp * (0.3 + r() * 0.7)),
          accuracy: 95 + r() * 4,
          play_count: 5000 + Math.floor(r() * 60000),
          ranked_score: Math.floor(r() * 2e9),
          global_rank: 0,
          country_rank: i + 1,
          activity: r() ** 2 * activityScale, // probability of having a new score on a poll
        };
        list.push(u);
        this.users.set(u.id, u);
      }
      this.byCountry.set(country, list);
    }
    const all = [...this.users.values()].sort((a, b) => b.pp - a.pp);
    all.forEach((u, i) => (u.global_rank = i + 1));
  }

  wait() {
    this.requestCount++;
    return this.delayMs ? new Promise((res) => setTimeout(res, this.delayMs)) : Promise.resolve();
  }

  lite(u) {
    return { id: u.id, username: u.username, avatar_url: u.avatar_url, country_code: u.country_code, cover_url: null };
  }

  async rankings(country, page = 1) {
    await this.wait();
    const list = (this.byCountry.get(country) || []).slice().sort((a, b) => b.pp - a.pp);
    // drift the ladder a little so rank changes show up
    for (const u of list) if (this.r() < 0.05) u.pp += Math.round(this.r() * 40);
    const pageItems = list.slice((page - 1) * 50, page * 50);
    return {
      total: list.length,
      ranking: pageItems.map((u) => ({
        user: this.lite(u),
        pp: u.pp,
        pp_4k: u.pp_4k,
        pp_7k: u.pp_7k,
        global_rank: u.global_rank,
        country_rank: null,
        accuracy: u.accuracy,
        play_count: u.play_count,
        ranked_score: u.ranked_score,
        grade_counts: { ss: 50, ssh: 0, s: 400, sh: 0, a: 200 },
      })),
    };
  }

  makeScore(u, { forBest = false } = {}) {
    const r = this.r;
    const map = this.maps[Math.floor(r() * this.maps.length)];
    const skill = u.pp / 25000;
    const acc = Math.min(1, 0.9 + r() * 0.09 + skill * 0.01);
    const base = forBest ? 0.6 + r() * 0.4 : r() ** 3;
    const pp = Math.round(map.difficulty_rating * 70 * skill * base * acc * 100) / 100;
    const total = Math.floor(600000 + acc * 400000 * (0.8 + r() * 0.2));
    const notes = 800 + Math.floor(r() * 3000);
    const perfect = Math.floor(notes * acc * 0.7);
    const great = Math.floor(notes * acc * 0.25);
    const rank = acc > 0.99 ? 'SS' : acc > 0.95 ? 'S' : acc > 0.9 ? 'A' : 'B';
    return {
      id: this.nextScoreId++,
      user_id: u.id,
      beatmap_id: map.id,
      accuracy: acc,
      total_score: Math.min(1000000, total),
      legacy_total_score: null,
      max_combo: Math.floor(notes * (0.3 + r() * 0.7)),
      rank,
      passed: true,
      pp: pp > 1 ? pp : null,
      mods: MODS[Math.floor(r() * MODS.length)],
      statistics: { perfect, great, good: Math.floor(notes * 0.03), ok: Math.floor(notes * 0.01), meh: 3, miss: Math.floor(r() * 20) },
      ended_at: new Date(Date.now() - (forBest ? Math.floor(r() * 3e10) : Math.floor(r() * 60000))).toISOString(),
      has_replay: r() < 0.6,
      beatmap: { id: map.id, version: map.version, difficulty_rating: map.difficulty_rating, keys: map.cs, bpm: map.bpm, status: 'ranked', url: '#' },
      beatmapset: { id: map.beatmapset.id, title: map.beatmapset.title, artist: map.beatmapset.artist, creator: map.beatmapset.creator, cover: null, card: null },
      user: this.lite(u),
    };
  }

  async recentScores(userId) {
    await this.wait();
    const u = this.users.get(Number(userId));
    if (!u) return [];
    const out = [];
    if (this.r() < u.activity) out.push(this.makeScore(u));
    // occasional pop-off
    if (this.r() < 0.03 * Math.min(1, this.activityScale * 3)) {
      const s = this.makeScore(u, { forBest: true });
      s.pp = Math.round((s.pp || 100) * 1.25 * 100) / 100;
      s.ended_at = new Date().toISOString();
      out.push(s);
    }
    return out;
  }

  async bestScores(userId) {
    await this.wait();
    const u = this.users.get(Number(userId));
    if (!u) return [];
    if (!this.best.has(u.id)) {
      const seen = new Set();
      const list = [];
      for (let i = 0; i < 160 && list.length < 100; i++) {
        const s = this.makeScore(u, { forBest: true });
        if (!s.pp || seen.has(s.beatmap_id)) continue;
        seen.add(s.beatmap_id);
        list.push(s);
      }
      this.best.set(u.id, list.sort((a, b) => b.pp - a.pp));
    }
    return this.best.get(u.id);
  }

  async user(idOrName) {
    await this.wait();
    const u = /^\d+$/.test(String(idOrName))
      ? this.users.get(Number(idOrName))
      : [...this.users.values()].find((x) => x.username.toLowerCase() === String(idOrName).toLowerCase());
    if (!u) return null;
    return {
      ...this.lite(u),
      join_date: '2019-04-01T00:00:00Z',
      is_online: this.r() < 0.3,
      stats: {
        pp: u.pp, pp_4k: u.pp_4k, pp_7k: u.pp_7k, global_rank: u.global_rank, country_rank: u.country_rank,
        accuracy: u.accuracy, play_count: u.play_count, play_time: u.play_count * 140, ranked_score: u.ranked_score,
        max_combo: 4000, grade_counts: { ss: 50, ssh: 0, s: 400, sh: 0, a: 200 }, level: 100,
      },
    };
  }
}
