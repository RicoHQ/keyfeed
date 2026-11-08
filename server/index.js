// Node entry: serves the API (shared fetch handler) plus the static front end from web/.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createApp, injectMeta } from './app.js';

const WEB_DIR = resolve('web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export { createApp };

/** Adapt a fetch-style app to node:http, falling back to static files for non-API paths. */
export function nodeHandler(app) {
  return async (req, res) => {
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    let response;
    try {
      response = await app.fetch(new Request(`http://${req.headers.host || 'localhost'}${req.url}`, { method: req.method, headers: req.headers, signal: ac.signal }));
    } catch (e) {
      response = new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
    if (!response) return serveStatic(new URL(req.url, 'http://x').pathname, res, app, `http://${req.headers.host || 'localhost'}`);
    const headers = Object.fromEntries([...response.headers].filter(([k]) => k !== 'set-cookie'));
    const cookies = response.headers.getSetCookie?.() || [];
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    if (!response.body || req.method === 'HEAD') return res.end();
    const reader = response.body.getReader();
    ac.signal.addEventListener('abort', () => reader.cancel().catch(() => {}));
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {}
    res.end();
  };
}

async function serveStatic(path, res, app, base) {
  let file;
  try { file = normalize(join(WEB_DIR, decodeURIComponent(path))); } catch { file = WEB_DIR; }
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); return res.end(); }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(WEB_DIR, 'index.html'); // SPA fallback
  }
  try {
    let body = await readFile(file);
    const ext = extname(file);
    if (ext === '.html' && app?.metaFor) body = injectMeta(body.toString('utf8'), app.metaFor(path, base));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

// ---- boot ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const { config } = await import('./config.js');
  const { openDb } = await import('./db.js');
  const { OsuClient } = await import('./osu.js');
  const { MockOsuClient } = await import('./mock.js');
  const { Tracker } = await import('./tracker.js');

  const osu = config.mock
    ? new MockOsuClient({ countries: config.countries, perCountry: Math.max(config.rosterSize + 20, 60), delayMs: 120 })
    : new OsuClient({ clientId: config.osuClientId, clientSecret: config.osuClientSecret, requestsPerMinute: config.requestsPerMinute });
  const db = openDb(config.mock ? ':memory:' : config.dbPath);
  const tracker = new Tracker({ db, osu, config });
  tracker.ensureMode(config.mock ? 'mock' : 'live');
  const app = createApp({ tracker, osu, cfg: config });
  setInterval(app.ping, 25_000).unref();
  createServer(nodeHandler(app)).listen(config.port, () => {
    console.log(`keyfeed on http://localhost:${config.port}  (${config.mock ? 'MOCK data' : 'osu! API v2'}; tracking ${config.countries.join(', ')})`);
  });
  tracker.start();
  const shutdown = () => { tracker.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
