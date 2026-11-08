// Cloudflare entry point.
//
//   browser ──► Worker ──/api/*──► TrackerDO (one instance, "main")
//                 │                  ├─ SQLite (ctx.storage.sql): players, scores, best, history
//                 │                  ├─ alarm loop: rankings refresh + roster polling (osu! API v2)
//                 │                  └─ SSE hub for /api/live
//                 └─ everything else ─► static assets (web/)
//
// A single Durable Object is deliberate: the osu! rate limit is per OAuth client, so one
// scheduler owns the whole request budget, and live-feed subscribers sit next to the poller.
import { makeConfig } from '../server/settings.js';
import { openDoDb } from '../server/sqlite-do.js';
import { OsuClient } from '../server/osu.js';
import { MockOsuClient } from '../server/mock.js';
import { Tracker } from '../server/tracker.js';
import { createApp, json } from '../server/app.js';

const ALARM_BUDGET_MS = 25_000; // work per alarm invocation
const ALARM_MAX_REQUESTS = 40; // stay under the Free plan's 50 subrequests per invocation
const ALARM_GAP_MS = 1_000;
const PING_EVERY_MS = 25_000;

export class TrackerDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    const cfg = makeConfig(env, { autoMock: true });
    this.cfg = cfg;
    this.db = openDoDb(ctx.storage);
    this.osu = cfg.mock
      ? new MockOsuClient({ countries: cfg.countries, perCountry: Math.max(cfg.rosterSize + 20, 60), delayMs: 250, activityScale: 0.15 })
      : new OsuClient({ clientId: cfg.osuClientId, clientSecret: cfg.osuClientSecret, requestsPerMinute: cfg.requestsPerMinute });
    this.tracker = new Tracker({ db: this.db, osu: this.osu, config: cfg, log: console });
    this.tracker.ensureMode(cfg.mock ? 'mock' : 'live');
    this.app = createApp({ tracker: this.tracker, osu: this.osu, cfg });
    this.lastPing = 0;
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(Date.now() + ALARM_GAP_MS);
    });
  }

  async fetch(request) {
    return (await this.app.fetch(request)) || json(404, { error: 'not_found' });
  }

  async alarm() {
    const started = Date.now();
    const req0 = this.osu.requestCount;
    try {
      while (Date.now() - started < ALARM_BUDGET_MS && this.osu.requestCount - req0 < ALARM_MAX_REQUESTS) {
        if (Date.now() - this.lastPing > PING_EVERY_MS) {
          this.app.ping();
          this.lastPing = Date.now();
        }
        if ((await this.tracker.step()) === 'idle') break;
      }
    } catch (e) {
      console.error('[alarm]', e?.stack || e);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_GAP_MS);
    }
  }
}

const trackerStub = (env) => env.TRACKER.get(env.TRACKER.idFromName('main'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return trackerStub(env).fetch(request);
    return env.ASSETS.fetch(request);
  },

  // Safety net: if the alarm chain ever stops, waking the object re-arms it (see constructor).
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(trackerStub(env).fetch('https://keyfeed.internal/api/status'));
  },
};
