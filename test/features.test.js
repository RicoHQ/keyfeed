import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOsu, analyzeChart, rateOf } from '../server/chart.js';
import { makeOsu } from '../server/mockchart.js';
import { computeSkills, danFor, accuracyFactor } from '../server/skills.js';
import { openDb } from '../server/db.js';
import { MockOsuClient } from '../server/mock.js';
import { Tracker } from '../server/tracker.js';
import { createApp, injectMeta } from '../server/app.js';
import { createSigner } from '../server/auth.js';

const quiet = { info() {}, error() {} };

test('chart analyzer: each synthetic style rates highest in its own skillset', () => {
  for (const keys of [4, 7]) {
    for (const style of ['stream', 'jumpstream', 'handstream', 'jack', 'chordjack', 'tech', 'ln']) {
      const a = analyzeChart(parseOsu(makeOsu({ keys, style, nps: 14, seconds: 90, seed: 9 })));
      assert.equal(a.keys, keys);
      const best = Object.entries(a.ratings).sort((x, y) => y[1] - x[1])[0][0];
      assert.equal(best, style, `${keys}K ${style} → ${best} ${JSON.stringify(a.ratings)}`);
    }
  }
});

test('chart analyzer: denser charts rate higher, non-mania is rejected', () => {
  const easy = analyzeChart(parseOsu(makeOsu({ style: 'stream', nps: 8, seed: 1 })));
  const hard = analyzeChart(parseOsu(makeOsu({ style: 'stream', nps: 16, seed: 1 })));
  assert.ok(hard.overall > easy.overall * 1.6);
  assert.equal(analyzeChart(parseOsu('[General]\nMode: 0\n[Difficulty]\nCircleSize:4\n[HitObjects]\n256,192,1000,1,0\n')), null);
  assert.throws(() => parseOsu('not a chart'));
  assert.equal(rateOf(['DT']), 1.5);
  assert.equal(rateOf(['HT', 'HD']), 0.75);
});

test('dans: ladder steps and accuracy credit', () => {
  assert.equal(danFor(7.5, 4).label, '1--');
  assert.equal(danFor(7.5 + 1.5 * 9 + 0.75, 4).label, '10');
  assert.equal(danFor(7.5 + 1.5 * 10, 4).level, 'alpha');
  assert.match(danFor(100, 4).label, /^>eta/);
  assert.equal(danFor(1, 4), null);
  assert.equal(accuracyFactor(96, 96), 1);
  assert.ok(accuracyFactor(99, 96) > 1 && accuracyFactor(99, 96) < 1.06);
  assert.equal(accuracyFactor(90, 96), 0);
});

test('skills: per-skillset ratings, dans and overall from plays', () => {
  const charts = new Map();
  const plays = [];
  let id = 1;
  for (const style of ['jack', 'stream']) {
    for (let i = 0; i < 6; i++) {
      const a = analyzeChart(parseOsu(makeOsu({ style, nps: 10 + i, seed: id })));
      charts.set(id, a);
      plays.push({ beatmap_id: id, accuracy: 0.975, mods: i === 0 ? ['DT'] : [] });
      id++;
    }
  }
  const s = computeSkills(plays, charts)[4];
  assert.ok(s.skillsets.jack.rating > 0 && s.skillsets.stream.rating > 0);
  assert.equal(s.skillsets.handstream.rating, null);
  assert.ok(s.overall > 0);
  assert.ok(s.dan.label);
});

function setup(countries = ['US']) {
  const db = openDb(':memory:');
  const osu = new MockOsuClient({ countries, perCountry: 60, seed: 5 });
  const config = { countries, rosterSize: 40, rankingsRefreshMinutes: 30, hotWindowMinutes: 120, coldEvery: 2, onDemandRoster: 20, analyzeEvery: 2 };
  const tracker = new Tracker({ db, osu, config, log: quiet });
  const app = createApp({ tracker, osu, cfg: { ...config, mock: true, sessionSecret: 'test' } });
  const get = async (path, init) => app.fetch(new Request(`https://kf.test${path}`, init));
  return { db, osu, tracker, app, get };
}

test('snipes: beating another tracked player\'s #1 on a map records a snipe', async () => {
  const { tracker } = setup();
  await tracker.refreshRankings('US');
  const [a, b] = tracker.q.roster.all('US').slice(0, 2).map((r) => tracker.q.player.get(r.id));
  a.initialized = 1; b.initialized = 1;
  const snipes = [];
  tracker.on('snipe', (e) => snipes.push(e.snipe));
  const mk = (p, id, total) => ({ id, user_id: p.id, beatmap_id: 777, total_score: total, accuracy: 0.97, pp: 300, mods: [], rank: 'S', passed: true, ended_at: new Date().toISOString(), beatmap: { id: 777, keys: 4, version: '[4K] X' }, beatmapset: { id: 1, title: 'T', artist: 'A' }, user: { id: p.id, username: p.username } });
  tracker.osu.recentScores = async (uid) => (uid === a.id ? [mk(a, 1, 900000)] : [mk(b, 2, 950000)]);
  tracker.osu.bestScores = async () => [];
  await tracker.pollPlayer(a);
  assert.equal(snipes.length, 0, 'first #1 is not a snipe');
  await tracker.pollPlayer(b);
  assert.equal(snipes.length, 1);
  assert.equal(snipes[0].sniper.id, b.id);
  assert.equal(snipes[0].victim.id, a.id);
  const board = tracker.snipeBoard('US');
  assert.equal(board.holders[0].user.id, b.id);
  assert.equal(tracker.mapDetail(777, 'US').leaderboard[0].user.id, b.id);
});

test('end to end: steps analyse charts, maps/snipes/skills/leaderboards answer', async () => {
  const { tracker, get } = setup();
  for (let i = 0; i < 260; i++) await tracker.step();
  const st = tracker.stats();
  assert.ok(st.charts > 0, 'some charts analysed');

  const maps = await (await get('/api/maps?country=US&window=30d')).json();
  assert.ok(maps.maps.length > 0);
  const detail = await (await get(`/api/maps/${maps.maps[0].beatmap.id}?country=US`)).json();
  assert.ok(detail.beatmap && Array.isArray(detail.leaderboard));

  const ranking = await (await get('/api/rankings?country=US')).json();
  const name = ranking.ranking[0].user.username;
  const prof = await (await get(`/api/players/${encodeURIComponent(name)}`)).json();
  assert.ok(prof.history.snapshots.length >= 1);
  assert.ok(prof.user.rank_history.length === 90);

  // analyse every queued chart, then skills should be rated
  while (await tracker.analyzeNext());
  const sk = await (await get(`/api/players/${encodeURIComponent(name)}/skills`)).json();
  assert.equal(sk.pending, 0);
  const anyKeys = Object.values(sk.keys)[0];
  assert.ok(anyKeys && anyKeys.overall > 0, JSON.stringify(sk.keys).slice(0, 200));
  assert.ok(sk.history.length >= 1);

  const skillBoard = await (await get('/api/rankings?country=US&mode=skill4')).json();
  assert.ok(Array.isArray(skillBoard.ranking));

  // global + variant leaderboards are fetched lazily by the next step
  const g1 = await (await get('/api/rankings?scope=global&mode=7k')).json();
  assert.equal(g1.updating, true);
  await tracker.step();
  const g2 = await (await get('/api/rankings?scope=global&mode=7k')).json();
  assert.ok(g2.ranking.length > 0);
  assert.ok(g2.ranking[0].pp >= g2.ranking[1].pp);

  assert.equal((await get('/api/snipes?country=US')).status, 200);
  assert.equal((await get('/api/snipes/board?country=US')).status, 200);
});

test('multi-country: viewing a country activates it, it gets a roster, then expires', async () => {
  const { tracker, get } = setup(['US']);
  assert.deepEqual(tracker.activeCountries(), ['US']);
  await get('/api/rankings?country=JP');
  assert.deepEqual(tracker.activeCountries(), ['US', 'JP']);
  for (let i = 0; i < 3; i++) await tracker.step();
  const jp = tracker.rankings('JP');
  assert.equal(jp.total, 20, 'on-demand roster size');
  tracker.setMeta('active:JP', Date.now() - 31 * 60_000);
  assert.deepEqual(tracker.activeCountries(), ['US']);
});

test('login (demo), follows, CSRF, logout', async () => {
  const { tracker, get } = setup();
  await tracker.refreshRankings('US');
  const login = await get('/api/auth/login?next=/rankings', { redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/rankings');
  const cookieHeader = login.headers.getSetCookie()[0].split(';')[0];
  assert.match(cookieHeader, /^kf_session=/);
  const me = await (await get('/api/me', { headers: { cookie: cookieHeader } })).json();
  assert.ok(me.user.id);

  const target = tracker.q.roster.all('US').find((r) => r.id !== me.user.id).id;
  assert.equal((await get(`/api/follows/${target}`, { method: 'POST', headers: { cookie: cookieHeader } })).status, 403, 'needs CSRF header');
  const f = await (await get(`/api/follows/${target}`, { method: 'POST', headers: { cookie: cookieHeader, 'x-keyfeed': '1' } })).json();
  assert.equal(f.following[0].id, target);
  assert.equal((await get('/api/me/feed', { headers: { cookie: cookieHeader } })).status, 200);
  const u = await (await get(`/api/follows/${target}`, { method: 'DELETE', headers: { cookie: cookieHeader, 'x-keyfeed': '1' } })).json();
  assert.equal(u.following.length, 0);
  assert.equal((await get('/api/me/feed')).status, 401);

  const out = await get('/api/auth/logout', { method: 'POST', headers: { cookie: cookieHeader, 'x-keyfeed': '1' } });
  assert.match(out.headers.getSetCookie()[0], /Max-Age=0/);
  assert.equal(login.headers.get('location').startsWith('/'), true);
  const evil = await get('/api/auth/login?next=//evil.example', { redirect: 'manual' });
  assert.equal(evil.headers.get('location'), '/');
});

test('signed cookies reject tampering and expiry', async () => {
  const s = createSigner('k');
  const t = await s.sign({ id: 1, exp: Date.now() + 1000 });
  assert.equal((await s.verify(t)).id, 1);
  const [body, sig] = t.split('.');
  const forged = btoa(JSON.stringify({ id: 2, exp: Date.now() + 1000 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(await s.verify(`${forged}.${sig}`), null, 'payload swap');
  assert.equal(await s.verify(`${body}.${sig.slice(0, 10)}${sig[10] === 'A' ? 'B' : 'A'}${sig.slice(11)}`), null, 'signature flip');
  assert.equal(await createSigner('other').verify(t), null);
  assert.equal(await s.verify(await s.sign({ id: 1, exp: Date.now() - 1 })), null);
});

test('social previews: valid PNG card and per-page meta', async () => {
  const { tracker, get, app } = setup();
  await tracker.refreshRankings('US');
  const res = await get('/api/og');
  assert.equal(res.headers.get('content-type'), 'image/png');
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(new DataView(bytes.buffer).getUint32(16), 1200);
  const name = tracker.rankings('US').ranking[0].user.username;
  const pres = await get(`/api/og?player=${encodeURIComponent(name)}`);
  assert.equal(pres.status, 200);
  const meta = app.metaFor(`/player/${name}`, 'https://kf.test');
  assert.match(meta.image, /og\?player=/);
  const html = injectMeta('<title>x</title><meta property="og:image" content="/api/og">', meta);
  assert.match(html, /https:\/\/kf\.test\/api\/og\?player=/);
});
