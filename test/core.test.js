import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { evaluateScore, mergeBest, weightedTotal } from '../server/pp.js';
import { RateLimiter } from '../server/ratelimit.js';
import { normalizeScore, normalizeStats } from '../server/osu.js';
import { openDb } from '../server/db.js';
import { MockOsuClient } from '../server/mock.js';
import { Tracker } from '../server/tracker.js';
import { createApp, nodeHandler } from '../server/index.js';

const quiet = { info() {}, error() {} };

test('weightedTotal applies 0.95^i', () => {
  assert.equal(weightedTotal([100, 100]), 195);
  assert.ok(Math.abs(weightedTotal([200, 100, 50]) - (200 + 95 + 45.125)) < 1e-9);
});

test('evaluateScore: new #1 play', () => {
  const best = [{ beatmap_id: 1, pp: 300 }, { beatmap_id: 2, pp: 200 }];
  const r = evaluateScore(best, { beatmap_id: 3, pp: 400 });
  assert.equal(r.position, 0);
  assert.equal(r.weightedPP, 400);
  // before: 300 + 190 = 490; after: 400 + 285 + 180.5 = 865.5
  assert.equal(r.ppGain, 375.5);
});

test('evaluateScore: worse play on an existing map gives nothing', () => {
  const best = [{ beatmap_id: 1, pp: 300 }];
  assert.deepEqual(evaluateScore(best, { beatmap_id: 1, pp: 250 }), { position: -1, weightedPP: 0, ppGain: 0 });
});

test('evaluateScore: improvement on an existing map replaces it', () => {
  const best = [{ beatmap_id: 1, pp: 300 }, { beatmap_id: 2, pp: 200 }];
  const r = evaluateScore(best, { beatmap_id: 2, pp: 250 });
  assert.equal(r.position, 1);
  assert.equal(r.ppGain, 47.5); // (250-200)*0.95
});

test('evaluateScore: outside top 100 is ignored', () => {
  const best = Array.from({ length: 100 }, (_, i) => ({ beatmap_id: i, pp: 500 - i }));
  assert.equal(evaluateScore(best, { beatmap_id: 999, pp: 10 }).position, -1);
});

test('mergeBest keeps one entry per map and caps at 100', () => {
  const best = Array.from({ length: 100 }, (_, i) => ({ beatmap_id: i, pp: 500 - i }));
  const next = mergeBest(best, { beatmap_id: 5, pp: 1000 });
  assert.equal(next.length, 100);
  assert.equal(next[0].pp, 1000);
  assert.equal(next.filter((s) => s.beatmap_id === 5).length, 1);
});

test('RateLimiter waits once the burst is spent', async () => {
  let t = 0;
  const waits = [];
  const rl = new RateLimiter(60, { burst: 2, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  await rl.take(); await rl.take(); await rl.take();
  assert.equal(waits.length, 1);
  assert.equal(waits[0], 1000);
});

test('normalizers handle lazer-format scores and mania variants', () => {
  const s = normalizeScore({
    id: 1, user_id: 2, beatmap_id: 3, accuracy: 0.99, total_score: 990000, max_combo: 500, rank: 'S', passed: true, pp: 512.3,
    mods: [{ acronym: 'CL' }, { acronym: 'DT' }], statistics: { perfect: 900 }, ended_at: '2026-01-01T00:00:00Z', has_replay: true,
    beatmap: { id: 3, beatmapset_id: 4, version: '[7K] Extra', difficulty_rating: 6.1, cs: 7, bpm: 180 },
    beatmapset: { id: 4, title: 'T', artist: 'A', covers: { cover: 'https://assets.ppy.sh/x.jpg' } },
    user: { id: 2, username: 'u', avatar_url: 'https://a.ppy.sh/2', country_code: 'US' },
  });
  assert.deepEqual(s.mods, ['CL', 'DT']);
  assert.equal(s.beatmap.keys, 7);
  assert.equal(s.beatmapset.cover, 'https://assets.ppy.sh/x.jpg');
  const st = normalizeStats({ user: { id: 1, username: 'a' }, pp: 100, variants: [{ variant: '4k', pp: 80 }, { variant: '7k', pp: 40 }] });
  assert.equal(st.pp_4k, 80);
  assert.equal(st.pp_7k, 40);
});

function makeTracker() {
  const db = openDb(':memory:');
  const osu = new MockOsuClient({ countries: ['US'], perCountry: 60, seed: 3 });
  const config = { countries: ['US'], rosterSize: 50, rankingsRefreshMinutes: 30, hotWindowMinutes: 120, coldEvery: 4 };
  return { db, osu, tracker: new Tracker({ db, osu, config, log: quiet }) };
}

test('tracker: roster, silent backfill, then live events with dedupe', async () => {
  const { tracker } = makeTracker();
  await tracker.refreshRankings('US');
  const r = tracker.rankings('US', 1, 50);
  assert.equal(r.total, 50);
  assert.equal(r.ranking[0].rank, 1);
  assert.ok(r.ranking[0].pp >= r.ranking[1].pp);

  const events = [];
  tracker.on('score', (e) => events.push(e));
  const roster = () => tracker.q.roster.all('US').map((r) => tracker.q.player.get(r.id));

  for (const p of roster()) await tracker.pollPlayer(p); // first pass = backfill
  assert.equal(events.length, 0, 'backfill must not emit');

  for (let i = 0; i < 6; i++) for (const p of roster()) await tracker.pollPlayer(p);
  assert.ok(events.length > 0, 'later polls emit new scores');
  const ids = events.map((e) => e.score.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate emits');
  assert.ok(tracker.feed('US', 10).scores.length > 0);
  for (const s of tracker.topPlays('US', 86_400_000, 50).plays) assert.ok(s.best_position >= 0 && s.pp > 0);

  // step() drives the same work end to end
  const kinds = new Set();
  for (let i = 0; i < 120; i++) kinds.add(await tracker.step());
  assert.ok(kinds.has('poll'));
});

test('HTTP API: rankings, feed, players, SSE hello, 404s', async () => {
  const { tracker, osu } = makeTracker();
  await tracker.refreshRankings('US');
  const app = createApp({ tracker, osu, cfg: { countries: ['US'], mock: true, rosterSize: 50, onDemandRoster: 50 } });
  const server = createServer(nodeHandler(app));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const rank = await (await fetch(`${base}/api/rankings?country=US`)).json();
    assert.equal(rank.ranking.length, 50);
    assert.equal((await fetch(`${base}/api/rankings?country=ZZ`)).status, 400);
    assert.equal((await fetch(`${base}/api/tracker?country=US`)).status, 200);
    assert.equal((await fetch(`${base}/api/top-plays?country=US&window=24h`)).status, 200);

    const name = rank.ranking[0].user.username;
    const prof = await (await fetch(`${base}/api/players/${encodeURIComponent(name)}`)).json();
    assert.equal(prof.user.username, name);
    assert.ok(prof.best.length > 0);
    assert.equal((await fetch(`${base}/api/players/nobody_here_xyz`)).status, 404);

    const html = await fetch(`${base}/rankings`);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status !== 500, true);

    const ac = new AbortController();
    const sse = await fetch(`${base}/api/live?country=US`, { signal: ac.signal });
    const reader = sse.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /event: hello/);
    ac.abort();
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
