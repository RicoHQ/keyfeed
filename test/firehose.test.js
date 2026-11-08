import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { MockOsuClient } from '../server/mock.js';
import { Tracker } from '../server/tracker.js';
import { createApp } from '../server/app.js';

const quiet = { info() {}, error() {} };

function setup({ countries = ['US'] } = {}) {
  const db = openDb(':memory:');
  const osu = new MockOsuClient({ countries, perCountry: 60, seed: 11 });
  const config = { countries, rosterSize: 40, rankingsRefreshMinutes: 30, hotWindowMinutes: 120, coldEvery: 2, onDemandRoster: 20, analyzeEvery: 50, ingest: 'firehose', feedIntervalSeconds: 0 };
  const tracker = new Tracker({ db, osu, config, log: quiet });
  const app = createApp({ tracker, osu, cfg: { ...config, mock: true, sessionSecret: 't' } });
  const get = async (path, init) => app.fetch(new Request(`https://kf.test${path}`, init));
  return { db, osu, tracker, app, get };
}

async function run(tracker, steps) {
  const kinds = {};
  for (let i = 0; i < steps; i++) { const k = await tracker.step(); kinds[k] = (kinds[k] || 0) + 1; }
  return kinds;
}

test('global feed: every country gets a live feed, lookups are batched, cursor is saved', async () => {
  const { tracker, osu } = setup();
  const calls = { users: 0, beatmaps: 0, maxUsers: 0, maxMaps: 0 };
  const u = osu.users.bind(osu), b = osu.beatmaps.bind(osu);
  osu.users = async (ids) => { calls.users++; calls.maxUsers = Math.max(calls.maxUsers, ids.length); return u(ids); };
  osu.beatmaps = async (ids) => { calls.beatmaps++; calls.maxMaps = Math.max(calls.maxMaps, ids.length); return b(ids); };
  let polledPlayers = 0;
  osu.recentScores = async () => { polledPlayers++; return []; };

  const kinds = await run(tracker, 80);
  const fh = tracker.firehose;
  assert.ok(kinds.feed > 1, 'feed polled');
  assert.equal(polledPlayers, 0, 'no per-player polling in firehose mode');
  assert.ok(calls.maxUsers <= 50 && calls.maxMaps <= 50, 'batches of at most 50');
  assert.ok(fh.buffers.size >= 15, `live feed for many countries (got ${fh.buffers.size})`);
  assert.equal(fh.pending.length, 0, 'everything resolved');
  for (const [c, list] of fh.buffers) {
    for (const s of list) {
      assert.equal(s.user.country_code, c);
      assert.ok(s.beatmapset.title && s.beatmap.keys, 'beatmap details attached');
    }
  }
  assert.ok(tracker.meta('feed_cursor'), 'cursor persisted');
  // after warm-up, most scores need no lookup
  const before = calls.users;
  await run(tracker, 40);
  assert.ok(calls.users - before < 25, `lookups taper off once cached (${calls.users - before})`);
});

test('global feed: tracked players get the full pipeline, everyone else stays in memory', async () => {
  const { tracker, db } = setup();
  await run(tracker, 160);
  const stored = db.prepare(`SELECT s.user_id, p.country, p.on_roster, p.pinned FROM scores s JOIN players p ON p.id = s.user_id`).all();
  assert.ok(stored.length > 0, 'roster scores stored');
  for (const r of stored) assert.ok((r.on_roster && r.country === 'US') || r.pinned, 'only tracked players are written');
  const nonFocus = db.prepare(`SELECT COUNT(*) AS n FROM scores WHERE country <> 'US'`).get().n;
  assert.equal(nonFocus, 0);
  const memJP = tracker.firehose.live('JP');
  assert.ok(memJP.length > 0, 'JP visible live without being tracked');
  // first pp score of a tracked player defers until their top plays are loaded, then gets pp gain
  const withGain = db.prepare(`SELECT COUNT(*) AS n FROM scores WHERE pp > 0`).get().n;
  const bestLoaded = db.prepare(`SELECT COUNT(*) AS n FROM players WHERE best_loaded = 1`).get().n;
  if (withGain) assert.ok(bestLoaded > 0);
});

test('global feed: viewing a country makes its players tracked; followed players are tracked anywhere', async () => {
  const { tracker, get } = setup();
  await get('/api/rankings?country=KR');
  await run(tracker, 5);
  tracker.firehose.refreshFocus(true);
  const kr = tracker.q.roster.all('KR').map((r) => r.id);
  assert.ok(kr.length > 0 && kr.every((id) => tracker.firehose.focus.has(id)));
  const someone = tracker.osu.ensureCountry('BR')[3];
  tracker.pin({ id: someone.id, username: someone.username, avatar_url: someone.avatar_url, country_code: 'BR', stats: {} });
  assert.ok(tracker.firehose.focus.has(someone.id));
});

test('global feed: hourly activity is flushed additively and survives in /api/countries/live', async () => {
  const { tracker, get, db } = setup();
  await run(tracker, 60);
  const memTotal = [...tracker.firehose.hourly.values()].reduce((n, h) => n + h.plays, 0);
  assert.ok(memTotal > 0);
  const live1 = (await (await get('/api/countries/live')).json()).countries;
  const sum1 = live1.reduce((n, c) => n + c.plays24h, 0);
  assert.equal(sum1, memTotal);
  const written = tracker.firehose.maybeFlushHourly(true);
  assert.ok(written > 0 && written < 60, 'about one row per active country');
  assert.equal(tracker.firehose.hourly.size, 0);
  const live2 = (await (await get('/api/countries/live')).json()).countries;
  assert.equal(live2.reduce((n, c) => n + c.plays24h, 0), memTotal, 'same totals after flush');
  // more plays in the same hour add on top instead of replacing
  await run(tracker, 30);
  tracker.firehose.maybeFlushHourly(true);
  const persisted = db.prepare(`SELECT SUM(plays) AS n FROM country_activity`).get().n;
  assert.ok(persisted > memTotal);
});

test('global feed API: live feed for an untracked country, world feed, top plays today, SSE', async () => {
  const { tracker, get } = setup();
  await run(tracker, 60);
  const feed = await (await get('/api/tracker?country=PH&limit=10')).json();
  assert.ok(feed.scores.length > 0);
  assert.ok(feed.scores.every((s) => s.user.country_code === 'PH'));
  const world = await (await get('/api/world?limit=20')).json();
  assert.equal(world.scores.length, 20);
  assert.ok(new Set(world.scores.map((s) => s.user.country_code)).size > 3);
  const top = await (await get('/api/top-plays?country=KR&window=24h')).json();
  assert.ok(Array.isArray(top.highest));
  for (let i = 1; i < top.highest.length; i++) assert.ok(top.highest[i - 1].pp >= top.highest[i].pp);

  const ac = new AbortController();
  const res = await get('/api/live?country=WORLD', { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = dec.decode((await reader.read()).value);
  assert.match(text, /"country":"WORLD"/);
  await run(tracker, 6);
  for (let i = 0; i < 5 && !/tracker_score/.test(text); i++) text += dec.decode((await reader.read()).value);
  assert.match(text, /event: tracker_score/);
  await reader.cancel();
});
