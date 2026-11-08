// Runs the Cloudflare Durable Object + Worker entry in Node against a fake ctx.storage
// that mimics the DO SQL API (exec(query, ...bindings) -> cursor, transactionSync, alarms).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { TrackerDO } from '../worker/index.js';

function fakeStorage() {
  const db = new DatabaseSync(':memory:');
  let alarm = null;
  const sql = {
    exec(query, ...bindings) {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|PRAGMA)/i.test(query)) throw new Error('not allowed in DO: ' + query);
      for (const b of bindings) if (b === undefined) throw new TypeError('undefined binding');
      if (/;\s*\S/.test(query.trim().replace(/;\s*$/, ''))) throw new Error('multiple statements with exec in test');
      const st = db.prepare(query);
      const rows = st.columns().length ? st.all(...bindings) : (st.run(...bindings), []);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
  return {
    sql,
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    getAlarm: async () => alarm,
    setAlarm: async (t) => { alarm = t; },
    get alarmAt() { return alarm; },
  };
}

function fakeCtx() {
  const storage = fakeStorage();
  const pending = [];
  return { storage, blockConcurrencyWhile: (fn) => { const p = fn(); pending.push(p); return p; }, pending };
}

const env = { COUNTRIES: 'US,DE', ROSTER_SIZE: '50', RANKINGS_REFRESH_MINUTES: '60', HOT_WINDOW_MINUTES: '120', COLD_EVERY: '4', RETENTION_DAYS: '35' };

test('TrackerDO: boots in demo mode, arms alarm, alarm does work, API answers', async () => {
  const ctx = fakeCtx();
  const obj = new TrackerDO(ctx, env);
  await Promise.all(ctx.pending);
  assert.equal(obj.cfg.mock, true, 'no secrets -> demo mode');
  assert.ok(ctx.storage.alarmAt > 0, 'alarm armed on first boot');

  obj.osu.delayMs = 0; // speed up the fake API for the test
  await obj.alarm();
  await obj.alarm();
  const r = await (await obj.fetch(new Request('https://x/api/rankings?country=US&pageSize=5'))).json();
  assert.equal(r.ranking.length, 5);
  const de = await (await obj.fetch(new Request('https://x/api/rankings?country=DE&pageSize=5'))).json();
  assert.equal(de.ranking.length, 5);

  for (let i = 0; i < 8; i++) await obj.alarm();
  const feed = await (await obj.fetch(new Request('https://x/api/tracker?country=US'))).json();
  assert.ok(feed.total >= 0);
  const status = await (await obj.fetch(new Request('https://x/api/status'))).json();
  assert.equal(status.players, 100);
  assert.equal((await obj.fetch(new Request('https://x/api/nope'))).status, 404);

  const name = r.ranking[0].user.username;
  const prof = await obj.fetch(new Request(`https://x/api/players/${encodeURIComponent(name)}`));
  assert.equal(prof.status, 200);

  // SSE
  const ac = new AbortController();
  const live = await obj.fetch(new Request('https://x/api/live?country=US', { signal: ac.signal }));
  assert.equal(live.headers.get('content-type'), 'text/event-stream');
  const reader = live.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: hello/);
  await reader.cancel();
  assert.equal(obj.app.clients.size, 0);
});

test('TrackerDO: alarm respects the per-invocation request cap and re-arms', async () => {
  const ctx = fakeCtx();
  const obj = new TrackerDO(ctx, env);
  obj.osu.delayMs = 0;
  const before = obj.osu.requestCount;
  ctx.storage.setAlarm(null);
  await obj.alarm();
  assert.ok(obj.osu.requestCount - before <= 41);
  assert.ok(ctx.storage.alarmAt > Date.now() - 1000);
});

test('TrackerDO: switching from demo to real credentials wipes demo data', async () => {
  const ctx = fakeCtx();
  const demo = new TrackerDO(ctx, env);
  demo.osu.delayMs = 0;
  await demo.alarm();
  assert.ok(demo.tracker.stats().players > 0);
  const live = new TrackerDO(ctx, { ...env, OSU_CLIENT_ID: '1', OSU_CLIENT_SECRET: 's' });
  assert.equal(live.cfg.mock, false);
  assert.equal(live.tracker.stats().players, 0);
});

test('Worker: /api/* goes to the Durable Object, everything else to assets', async () => {
  const seen = [];
  const fakeEnv = {
    TRACKER: { idFromName: (n) => n, get: () => ({ fetch: async (r) => { seen.push(['do', new URL(r.url ?? r).pathname]); return new Response('do'); } }) },
    ASSETS: { fetch: async (r) => { seen.push(['assets', new URL(r.url).pathname]); return new Response('asset'); } },
  };
  assert.equal(await (await worker.fetch(new Request('https://k/api/rankings'), fakeEnv)).text(), 'do');
  assert.equal(await (await worker.fetch(new Request('https://k/player/abc'), fakeEnv)).text(), 'asset');
  const waits = [];
  await worker.scheduled({}, fakeEnv, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual(seen.map((s) => s[0]), ['do', 'assets', 'do']);
});
