// HTTP API as a fetch-style handler (Request -> Response), shared by the Node server and the
// Cloudflare Durable Object. Returns null for non-API paths so the host can serve static files.

const WINDOWS = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
const enc = new TextEncoder();

export function createApp({ tracker, osu, cfg }) {
  const clients = new Set(); // { controller, country }
  const playerCache = new Map();

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
  tracker.on('rankings', ({ country }) => broadcast('rankings', country, { country }));

  // Keeps proxies from closing idle streams; call every ~25s.
  const ping = () => {
    const frame = enc.encode(': ping\n\n');
    for (const c of clients) { try { c.controller.enqueue(frame); } catch { clients.delete(c); } }
  };

  const countryOf = (url) => {
    const c = (url.searchParams.get('country') || cfg.countries[0]).toUpperCase();
    return cfg.countries.includes(c) ? c : null;
  };
  const num = (v, d, min, max) => Math.min(max, Math.max(min, v !== null && Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d));

  async function playerProfile(name) {
    const key = String(name).toLowerCase();
    const hit = playerCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.data;
    const user = await osu.user(name);
    if (!user) return null;
    const best = (await osu.bestScores(user.id, 100)).slice(0, 20);
    const data = { user, best };
    playerCache.set(key, { at: Date.now(), data });
    playerCache.set(String(user.id), { at: Date.now(), data });
    while (playerCache.size > 500) playerCache.delete(playerCache.keys().next().value);
    return data;
  }

  const routes = {
    '/api/config': () => ({ countries: cfg.countries, mock: cfg.mock, rosterSize: cfg.rosterSize }),
    '/api/status': () => tracker.stats(),
    '/api/rankings': (url) => {
      const country = countryOf(url);
      if (!country) return [404, { error: 'country_not_tracked' }];
      return tracker.rankings(country, num(url.searchParams.get('page'), 1, 1, 1000), num(url.searchParams.get('pageSize'), 50, 1, 100));
    },
    '/api/tracker': (url) => {
      const country = countryOf(url);
      if (!country) return [404, { error: 'country_not_tracked' }];
      return tracker.feed(country, num(url.searchParams.get('limit'), 30, 1, 100), num(url.searchParams.get('offset'), 0, 0, 1e6));
    },
    '/api/top-plays': (url) => {
      const country = countryOf(url);
      if (!country) return [404, { error: 'country_not_tracked' }];
      const w = WINDOWS[url.searchParams.get('window')] ? url.searchParams.get('window') : '7d';
      return { ...tracker.topPlays(country, WINDOWS[w], num(url.searchParams.get('limit'), 50, 1, 200)), window: w };
    },
  };

  async function fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return null;
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method_not_allowed' });

    if (path === '/api/live') {
      const country = countryOf(url);
      if (!country) return json(404, { error: 'country_not_tracked' });
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
      return new Response(body, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
      });
    }

    if (routes[path]) {
      try {
        const out = await routes[path](url);
        return Array.isArray(out) ? json(out[0], out[1]) : json(200, out, 'public, max-age=15');
      } catch (e) {
        return json(500, { error: e.message });
      }
    }

    const m = path.match(/^\/api\/players\/([^/]+)$/);
    if (m) {
      try {
        const data = await playerProfile(decodeURIComponent(m[1]));
        if (!data) return json(404, { error: 'player_not_found' });
        return json(200, { ...data, recent: tracker.playerScores(data.user.id) }, 'public, max-age=30');
      } catch (e) {
        return json(502, { error: e.message });
      }
    }

    return json(404, { error: 'not_found' });
  }

  return { fetch, ping, clients };
}

export function json(status, body, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache },
  });
}
