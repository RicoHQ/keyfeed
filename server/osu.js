// Minimal osu! API v2 client using the client-credentials grant (public scope).
// Docs: https://osu.ppy.sh/docs/
import { RateLimiter } from './ratelimit.js';

const BASE = 'https://osu.ppy.sh';
// Lazer-format scores (statistics.perfect/great/…, mods as objects). Same format mania-tracker passes through.
const API_VERSION = '20240529';

export class OsuClient {
  constructor({ clientId, clientSecret, requestsPerMinute = 60, fetchImpl = fetch }) {
    if (!clientId || !clientSecret) throw new Error('OSU_CLIENT_ID and OSU_CLIENT_SECRET are required (or run with MOCK=1).');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
    this.limiter = new RateLimiter(requestsPerMinute);
    this.token = null;
    this.tokenExpires = 0;
    this.requestCount = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    const res = await this.fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: Number(this.clientId),
        client_secret: this.clientSecret,
        grant_type: 'client_credentials',
        scope: 'public',
      }),
    });
    if (!res.ok) throw new Error(`osu! token request failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    this.token = body.access_token;
    this.tokenExpires = Date.now() + body.expires_in * 1000;
    return this.token;
  }

  async get(path, params = {}, attempt = 0) {
    await this.limiter.take();
    const url = new URL(`${BASE}/api/v2${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await this.fetch(url, {
      headers: {
        Authorization: `Bearer ${await this.getToken()}`,
        Accept: 'application/json',
        'x-api-version': API_VERSION,
      },
    });
    this.requestCount++;
    if (res.status === 429 && attempt < 3) {
      const wait = (Number(res.headers.get('retry-after')) || 30) * 1000;
      this.limiter.penalize(wait);
      return this.get(path, params, attempt + 1);
    }
    if (res.status === 401 && attempt < 1) {
      this.token = null;
      return this.get(path, params, attempt + 1);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`osu! GET ${url.pathname} → ${res.status}`);
    return res.json();
  }

  /** One page (50 players) of country mania pp rankings. */
  async rankings(country, page = 1) {
    const body = await this.get('/rankings/mania/performance', { country, 'cursor[page]': page });
    return { ranking: (body?.ranking || []).map(normalizeStats), total: body?.total ?? 0 };
  }

  async recentScores(userId, limit = 50) {
    const body = await this.get(`/users/${userId}/scores/recent`, { mode: 'mania', limit, include_fails: 0 });
    return (body || []).map(normalizeScore);
  }

  async bestScores(userId, limit = 100) {
    const body = await this.get(`/users/${userId}/scores/best`, { mode: 'mania', limit });
    return (body || []).map(normalizeScore);
  }

  /** Accepts a numeric id or a username. */
  async user(idOrName) {
    const key = /^\d+$/.test(String(idOrName)) ? idOrName : `@${idOrName}`;
    const u = await this.get(`/users/${encodeURIComponent(key)}/mania`);
    return u ? normalizeUser(u) : null;
  }
}

// ---- normalizers: keep only what the app uses, in one stable shape ----

export function normalizeUserLite(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    avatar_url: u.avatar_url,
    country_code: u.country_code || u.country?.code,
    cover_url: u.cover_url || u.cover?.url || null,
  };
}

function variantPP(stats, v) {
  return stats?.variants?.find((x) => x.variant === v)?.pp ?? null;
}

export function normalizeStats(s) {
  return {
    user: normalizeUserLite(s.user),
    pp: s.pp,
    pp_4k: variantPP(s, '4k'),
    pp_7k: variantPP(s, '7k'),
    global_rank: s.global_rank,
    country_rank: s.country_rank ?? null,
    accuracy: s.hit_accuracy,
    play_count: s.play_count,
    ranked_score: s.ranked_score,
    grade_counts: s.grade_counts,
  };
}

export function normalizeUser(u) {
  const s = u.statistics || {};
  return {
    ...normalizeUserLite(u),
    join_date: u.join_date,
    is_online: u.is_online,
    stats: {
      pp: s.pp,
      pp_4k: variantPP(s, '4k'),
      pp_7k: variantPP(s, '7k'),
      global_rank: s.global_rank,
      country_rank: s.country_rank,
      accuracy: s.hit_accuracy,
      play_count: s.play_count,
      play_time: s.play_time,
      ranked_score: s.ranked_score,
      max_combo: s.maximum_combo,
      grade_counts: s.grade_counts,
      level: s.level?.current,
    },
  };
}

export function normalizeScore(s) {
  const bm = s.beatmap || {};
  const bs = s.beatmapset || {};
  return {
    id: s.id,
    user_id: s.user_id,
    beatmap_id: s.beatmap_id ?? bm.id,
    accuracy: s.accuracy,
    total_score: s.total_score,
    legacy_total_score: s.legacy_total_score ?? null,
    max_combo: s.max_combo,
    rank: s.rank,
    passed: s.passed,
    pp: s.pp ?? null,
    mods: (s.mods || []).map((m) => (typeof m === 'string' ? m : m.acronym)),
    statistics: s.statistics || {},
    ended_at: s.ended_at || s.created_at,
    has_replay: !!(s.has_replay ?? s.replay),
    beatmap: {
      id: bm.id,
      version: bm.version,
      difficulty_rating: bm.difficulty_rating,
      keys: bm.cs,
      bpm: bm.bpm,
      status: bm.status,
      url: bm.url || (bm.id ? `https://osu.ppy.sh/beatmaps/${bm.id}` : null),
    },
    beatmapset: {
      id: bs.id ?? bm.beatmapset_id,
      title: bs.title,
      artist: bs.artist,
      creator: bs.creator,
      cover: bs.covers?.['cover@2x'] || bs.covers?.cover || null,
      card: bs.covers?.card || null,
    },
    user: normalizeUserLite(s.user),
  };
}
