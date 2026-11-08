// HTTP API as a fetch-style handler (Request -> Response), shared by the Node server and the
// Cloudflare Durable Object. Returns null for non-API paths so the host can serve static files.
import { createSigner, parseCookies, cookie, randomState } from './auth.js';
import { renderCard } from './png.js';
import { COUNTRY_CODES } from '../web/js/countries.js';
import { SKILL_LABELS } from './skills.js';

const WINDOWS = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
const VALID = new Set(COUNTRY_CODES);
const enc = new TextEncoder();
const SESSION_DAYS = 30;

export function createApp({ tracker, osu, cfg }) {
  const clients = new Set(); // { controller, country }
  const profileCache = new Map();
  const ogCache = new Map();
  const signer = createSigner(cfg.sessionSecret || cfg.osuClientSecret);

  const sseFrame = (event, data) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, country, data) => {
    if (!clients.size) return;
    const frame = sseFrame(event, data);
    for (const c of clients) {
      if (country && c.country !== country) continue;
      try { c.controller.enqueue(frame); } catch { clients.delete(c); }
    }
  };
  tracker.on('score', ({ country, score }) => broadcast('tracker_score', country, score));
  tracker.on('top_play', ({ country, score }) => broadcast('top_play', country, score));
  tracker.on('snipe', ({ country, snipe }) => broadcast('snipe', country, snipe));
  tracker.on('rankings', ({ country }) => broadcast('rankings', country, { country }));

  const ping = () => {
    const frame = enc.encode(': ping\n\n');
    for (const c of clients) { try { c.controller.enqueue(frame); } catch { clients.delete(c); } }
  };

  // ---- helpers ----
  const countryOf = (url, { touch = true } = {}) => {
    const c = (url.searchParams.get('country') || cfg.countries[0]).toUpperCase();
    if (!VALID.has(c)) return null;
    if (touch) tracker.touchCountry(c);
    return c;
  };
  const num = (v, d, min, max) => Math.min(max, Math.max(min, v !== null && v !== undefined && Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d));
  const secure = (url) => url.protocol === 'https:';
  const origin = (url) => (cfg.publicUrl || url.origin).replace(/\/$/, '');
  const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

  async function session(request) {
    return signer.verify(parseCookies(request.headers.get('cookie')).kf_session);
  }

  async function profile(name) {
    const key = String(name).toLowerCase();
    const hit = profileCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.data;
    const user = await osu.user(name);
    if (!user) return null;
    const best = await osu.bestScores(user.id, 100);
    tracker.recordProfile(user, best);
    const data = { user, best: best.slice(0, 25) };
    for (const k of [key, String(user.id), user.username.toLowerCase()]) profileCache.set(k, { at: Date.now(), data });
    while (profileCache.size > 600) profileCache.delete(profileCache.keys().next().value);
    return data;
  }

  // ---- route table: [method, regex, handler(ctx)] ----
  const routes = [
    ['GET', /^\/api\/config$/, async ({ request }) => ({
      countries: cfg.countries, active: tracker.activeCountries(), mock: cfg.mock, rosterSize: cfg.rosterSize,
      onDemandRoster: cfg.onDemandRoster, loginAvailable: cfg.mock || !!cfg.osuClientId, me: await session(request),
      skillLabels: SKILL_LABELS,
    })],
    ['GET', /^\/api\/status$/, () => tracker.stats()],
    ['POST', /^\/api\/countries\/activate$/, ({ url }) => {
      const c = countryOf(url);
      return c ? { country: c, active: tracker.activeCountries() } : [400, { error: 'bad_country' }];
    }],

    ['GET', /^\/api\/rankings$/, ({ url }) => {
      const scope = url.searchParams.get('scope') === 'global' ? 'global' : 'country';
      const mode = ['4k', '7k', 'skill4', 'skill7'].includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'all';
      const page = num(url.searchParams.get('page'), 1, 1, 2);
      const country = countryOf(url);
      if (scope === 'country' && !country) return [400, { error: 'bad_country' }];
      if (mode.startsWith('skill')) {
        return { scope, mode, country, ranking: tracker.skillLeaderboard(Number(mode.slice(5)), scope === 'country' ? country : null) };
      }
      const out = scope === 'country' && mode === 'all'
        ? { scope, mode, ...tracker.rankings(country, page, 50) }
        : { scope, mode, country, ...tracker.leaderboard(`${scope === 'global' ? 'global' : country}:${mode}`, page, 50) };
      // don't let browsers cache an empty "still fetching" answer
      return out.ranking.length ? out : [200, { ...out, updating: true }];
    }],
    ['GET', /^\/api\/tracker$/, ({ url }) => {
      const country = countryOf(url);
      if (!country) return [400, { error: 'bad_country' }];
      return tracker.feed(country, num(url.searchParams.get('limit'), 30, 1, 100), num(url.searchParams.get('offset'), 0, 0, 1e6));
    }],
    ['GET', /^\/api\/top-plays$/, ({ url }) => {
      const country = countryOf(url);
      if (!country) return [400, { error: 'bad_country' }];
      const w = WINDOWS[url.searchParams.get('window')] ? url.searchParams.get('window') : '7d';
      return { ...tracker.topPlays(country, WINDOWS[w], num(url.searchParams.get('limit'), 50, 1, 200)), window: w };
    }],
    ['GET', /^\/api\/snipes$/, ({ url }) => {
      const country = countryOf(url);
      if (!country) return [400, { error: 'bad_country' }];
      return tracker.snipes(country, num(url.searchParams.get('limit'), 50, 1, 100), num(url.searchParams.get('offset'), 0, 0, 1e5));
    }],
    ['GET', /^\/api\/snipes\/board$/, ({ url }) => {
      const country = countryOf(url);
      return country ? tracker.snipeBoard(country) : [400, { error: 'bad_country' }];
    }],
    ['GET', /^\/api\/maps$/, ({ url }) => {
      const country = countryOf(url);
      if (!country) return [400, { error: 'bad_country' }];
      const w = WINDOWS[url.searchParams.get('window')] ? url.searchParams.get('window') : '7d';
      return { country, window: w, maps: tracker.mostPlayed(country, WINDOWS[w], 60) };
    }],
    ['GET', /^\/api\/maps\/(\d+)$/, async ({ url, m }) => {
      const id = Number(m[1]);
      const country = url.searchParams.get('country') ? countryOf(url, { touch: false }) : null;
      let detail = tracker.mapDetail(id, country);
      if (!detail.beatmap) {
        const b = await osu.beatmap(id);
        if (!b) return [404, { error: 'map_not_found' }];
        tracker.saveBeatmapInfo(b);
        detail = tracker.mapDetail(id, country);
      }
      return detail;
    }],

    ['GET', /^\/api\/players\/([^/]+)$/, async ({ request, m }) => {
      const data = await profile(decodeURIComponent(m[1]));
      if (!data) return [404, { error: 'player_not_found' }];
      const me = await session(request);
      const tracked = tracker.findPlayer(data.user.id);
      return {
        ...data,
        recent: tracker.playerScores(data.user.id),
        history: tracker.history(data.user.id),
        tracked: !!(tracked && (tracked.on_roster || tracked.pinned)),
        following: me ? tracker.following(me.id).some((f) => f.id === data.user.id) : false,
      };
    }],
    ['GET', /^\/api\/players\/([^/]+)\/skills$/, async ({ m }) => {
      const data = await profile(decodeURIComponent(m[1]));
      if (!data) return [404, { error: 'player_not_found' }];
      return { user: data.user, ...tracker.skills(data.user.id, data.user.country_code) };
    }],

    // ---- auth ----
    ['GET', /^\/api\/auth\/login$/, async ({ url }) => {
      const next = safeNext(url.searchParams.get('next'));
      if (cfg.mock) {
        const u = osu.demoUser(countryOf(url, { touch: false }) || cfg.countries[0]);
        tracker.pin(u);
        return redirect(next, [cookie('kf_session', await signer.sign(sessionOf(u, true)), { maxAge: SESSION_DAYS * 86400, secure: secure(url) })]);
      }
      if (!cfg.osuClientId) return [503, { error: 'login_not_configured' }];
      const state = randomState();
      const stateCookie = cookie('kf_state', await signer.sign({ state, next, exp: Date.now() + 10 * 60_000 }), { maxAge: 600, secure: secure(url) });
      return redirect(osu.authorizeUrl(`${origin(url)}/api/auth/callback`, state), [stateCookie]);
    }],
    ['GET', /^\/api\/auth\/callback$/, async ({ url, request }) => {
      const saved = await signer.verify(parseCookies(request.headers.get('cookie')).kf_state);
      const clear = cookie('kf_state', '', { maxAge: 0, secure: secure(url) });
      if (!saved || saved.state !== url.searchParams.get('state')) return redirect('/?login=failed', [clear]);
      if (url.searchParams.get('error') || !url.searchParams.get('code')) return redirect('/?login=cancelled', [clear]);
      try {
        const user = await osu.loginWithCode(url.searchParams.get('code'), `${origin(url)}/api/auth/callback`);
        tracker.pin(user);
        const sess = cookie('kf_session', await signer.sign(sessionOf(user, false)), { maxAge: SESSION_DAYS * 86400, secure: secure(url) });
        return redirect(safeNext(saved.next), [clear, sess]);
      } catch (e) {
        return redirect('/?login=failed', [clear]);
      }
    }],
    ['POST', /^\/api\/auth\/logout$/, ({ url }) => withCookies(json(200, { ok: true }), [cookie('kf_session', '', { maxAge: 0, secure: secure(url) })])],
    ['GET', /^\/api\/me$/, async ({ request }) => {
      const me = await session(request);
      if (!me) return { user: null, following: [] };
      return { user: me, following: tracker.following(me.id) };
    }],
    ['GET', /^\/api\/me\/feed$/, async ({ request }) => {
      const me = await session(request);
      if (!me) return [401, { error: 'not_signed_in' }];
      return { scores: tracker.followingFeed(me.id, 60), following: tracker.following(me.id) };
    }],
    ['POST', /^\/api\/follows\/(\d+)$/, async ({ request, m }) => {
      const me = await session(request);
      if (!me) return [401, { error: 'not_signed_in' }];
      const target = Number(m[1]);
      if (target === me.id) return [400, { error: 'cannot_follow_self' }];
      let p = tracker.findPlayer(target);
      if (!p) {
        const u = await osu.user(target);
        if (!u) return [404, { error: 'player_not_found' }];
        if (!tracker.pin(u)) return [429, { error: 'tracking_full' }];
      } else if (!p.on_roster && !p.pinned) tracker.pin({ id: p.id, username: p.username, avatar_url: p.avatar_url, country_code: p.country, stats: {} });
      else if (p.on_roster && !p.pinned) tracker.pin({ id: p.id, username: p.username, avatar_url: p.avatar_url, country_code: p.country, stats: {} });
      tracker.follow(me.id, target);
      return { ok: true, following: tracker.following(me.id) };
    }],
    ['DELETE', /^\/api\/follows\/(\d+)$/, async ({ request, m }) => {
      const me = await session(request);
      if (!me) return [401, { error: 'not_signed_in' }];
      tracker.unfollow(me.id, Number(m[1]));
      return { ok: true, following: tracker.following(me.id) };
    }],

    // ---- media ----
    ['GET', /^\/api\/og$/, async ({ url }) => {
      const key = url.search;
      const hit = ogCache.get(key);
      if (hit && Date.now() - hit.at < 3600_000) return png(hit.bytes);
      const bytes = await renderCard(await cardFor(url));
      ogCache.set(key, { at: Date.now(), bytes });
      while (ogCache.size > 200) ogCache.delete(ogCache.keys().next().value);
      return png(bytes);
    }],
    ['GET', /^\/api\/avatar$/, async ({ url }) => {
      const id = url.searchParams.get('u');
      if (!/^\d{1,10}$/.test(id || '')) return [400, { error: 'bad_user' }];
      const res = await fetch(`https://a.ppy.sh/${id}`);
      if (!res.ok) return [404, { error: 'no_avatar' }];
      return new Response(res.body, { headers: { 'Content-Type': res.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
    }],
  ];

  async function cardFor(url) {
    const fmt = (n) => (n == null ? '-' : Math.round(n).toLocaleString('en-US'));
    const player = url.searchParams.get('player');
    const map = url.searchParams.get('map');
    if (player) {
      const data = await profile(player).catch(() => null);
      if (data) {
        const s = data.user.stats || {};
        const skills = tracker.skills(data.user.id, data.user.country_code).keys;
        const dans = Object.keys(skills).filter((k) => skills[k]?.dan).map((k) => `${k}K ~${skills[k].dan.label}`).join('  ');
        return {
          title: data.user.username,
          subtitle: `${data.user.country_code || ''}  ·  OSU!MANIA${dans ? '  ·  ' + dans : ''}`,
          stats: [
            { label: 'PERFORMANCE', value: `${fmt(s.pp)}PP` },
            { label: 'GLOBAL', value: s.global_rank ? `#${fmt(s.global_rank)}` : '-' },
            { label: 'COUNTRY', value: s.country_rank ? `#${fmt(s.country_rank)}` : '-' },
            { label: 'ACCURACY', value: s.accuracy ? `${s.accuracy.toFixed(2)}%` : '-' },
          ],
          hue: (data.user.id * 47) % 360,
        };
      }
    }
    if (map && /^\d+$/.test(map)) {
      const d = tracker.mapDetail(Number(map));
      if (d.beatmap) {
        const a = d.analysis?.status === 'done' ? d.analysis : null;
        const { danFor } = await import('./skills.js');
        const dan = a ? danFor(a.overall, a.keys) : null;
        return {
          title: d.beatmap.title || `MAP ${map}`,
          subtitle: `${d.beatmap.artist || ''}  ·  ${d.beatmap.version || ''}`,
          tag: 'MAP ANALYSIS',
          stats: [
            { label: 'STARS', value: d.beatmap.sr ? `${d.beatmap.sr.toFixed(2)}*` : '-' },
            { label: 'KEYS', value: d.beatmap.keys ? `${d.beatmap.keys}K` : '-' },
            { label: 'EST. DAN', value: dan ? `~${dan.label}` : '...' },
            { label: 'TOP SKILL', value: a ? (SKILL_LABELS[a.top[0]] || a.top[0]) : '...' },
          ],
        };
      }
    }
    return {
      title: 'OSU!MANIA LIVE',
      subtitle: 'RANKINGS  ·  LIVE SCORES  ·  SNIPES  ·  SKILL ANALYZER',
      stats: [
        { label: 'TRACKING', value: tracker.activeCountries().join(' ') },
        { label: 'PLAYERS', value: fmt(tracker.stats().players) },
      ],
    };
  }

  /** Title/description/image for server-rendered link previews. */
  function metaFor(pathname, base) {
    const site = 'keyfeed';
    let m = pathname.match(/^\/player\/([^/]+)/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      const p = tracker.findPlayer(name);
      return {
        title: `${p?.username || name} · ${site}`,
        description: p ? `${Math.round(p.pp || 0).toLocaleString('en-US')}pp · #${p.global_rank ?? '?'} global · osu!mania stats, skills and live scores.` : 'osu!mania player stats, skills and live scores.',
        image: `${base}/api/og?player=${encodeURIComponent(name)}`,
      };
    }
    m = pathname.match(/^\/maps\/(\d+)/);
    if (m) {
      const b = tracker.q.beatmap.get(Number(m[1]));
      return {
        title: `${b ? `${b.artist} - ${b.title} [${b.version}]` : `Map ${m[1]}`} · ${site}`,
        description: 'Chart analysis, estimated dan and leaderboard among tracked players.',
        image: `${base}/api/og?map=${m[1]}`,
      };
    }
    return { title: `${site} · osu!mania tracker`, description: 'Live osu!mania scores, country rankings, snipes, map stats and a skill analyzer.', image: `${base}/api/og` };
  }

  async function fetchHandler(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return null;

    if (path === '/api/live' && request.method === 'GET') {
      const country = countryOf(url);
      if (!country) return json(400, { error: 'bad_country' });
      let client;
      const body = new ReadableStream({
        start(controller) {
          client = { controller, country };
          clients.add(client);
          controller.enqueue(sseFrame('hello', { country, status: 'connected' }));
        },
        cancel() { clients.delete(client); },
      });
      request.signal?.addEventListener?.('abort', () => clients.delete(client));
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
    }

    if (path === '/api/meta' && request.method === 'GET') return json(200, metaFor(url.searchParams.get('path') || '/', origin(url)));

    // state-changing requests must carry our header (blocks cross-site form posts)
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('x-keyfeed') !== '1') {
      return json(403, { error: 'missing_csrf_header' });
    }

    let matchedPath = false;
    for (const [method, re, handler] of routes) {
      const m = path.match(re);
      if (!m) continue;
      matchedPath = true;
      if (method !== request.method && !(method === 'GET' && request.method === 'HEAD')) continue;
      try {
        const out = await handler({ request, url, m });
        if (out instanceof Response) return out;
        if (Array.isArray(out)) return json(out[0], out[1]);
        return json(200, out, method === 'GET' && !path.startsWith('/api/me') && !path.startsWith('/api/config') ? 'public, max-age=10' : 'no-store');
      } catch (e) {
        return json(502, { error: e.message });
      }
    }
    return json(matchedPath ? 405 : 404, { error: matchedPath ? 'method_not_allowed' : 'not_found' });
  }

  return { fetch: fetchHandler, ping, clients, metaFor };
}

function sessionOf(u, demo) {
  return { id: u.id, username: u.username, avatar_url: u.avatar_url, country_code: u.country_code, demo, exp: Date.now() + SESSION_DAYS * 86_400_000 };
}

export function json(status, body, cache = 'no-store') {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache } });
}

function png(bytes) {
  return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' } });
}

function redirect(location, cookies = []) {
  const h = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers: h });
}

function withCookies(res, cookies) {
  for (const c of cookies) res.headers.append('Set-Cookie', c);
  return res;
}

/** Inject per-page meta tags into index.html (used by Node; the Worker uses HTMLRewriter). */
export function injectMeta(html, meta) {
  const e = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${e(meta.title)}</title>`)
    .replace(/(<meta property="og:title" content=")[^"]*/, `$1${e(meta.title)}`)
    .replace(/(<meta name="description" content=")[^"]*/, `$1${e(meta.description)}`)
    .replace(/(<meta property="og:description" content=")[^"]*/, `$1${e(meta.description)}`)
    .replace(/(<meta property="og:image" content=")[^"]*/, `$1${e(meta.image)}`)
    .replace(/(<meta name="twitter:image" content=")[^"]*/, `$1${e(meta.image)}`);
}
