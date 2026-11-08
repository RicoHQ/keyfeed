// Validate keyfeed's chart analyzer + dan ladder on real ranked osu!mania charts.
//
// Pulls popular ranked 4K/7K maps from the public osu! beatmap search, downloads their .osu files
// (politely, ~1 request per second), runs the analyzer, and compares ratings with official star
// ratings: Spearman rank correlation per keymode, and how far LN charts sit from the rice trend.
//
// Usage: node tools/validate-real-charts.mjs . /tmp/kf-validate      (REFRESH=1 re-fetches the map list)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, work] = process.argv.slice(2);
const { parseOsu, analyzeChart } = await import(pathToFileURL(join(root, 'server/chart.js')).href);
const { danFor } = await import(pathToFileURL(join(root, 'web/js/dan.js')).href);
mkdirSync(join(work, 'osu'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(q, pages) {
  const out = [];
  let cursor = null;
  for (let p = 0; p < pages; p++) {
    const u = new URL('https://osu.ppy.sh/beatmapsets/search');
    u.searchParams.set('m', '3'); u.searchParams.set('s', 'ranked'); u.searchParams.set('sort', 'plays_desc');
    if (q) u.searchParams.set('q', q);
    if (cursor) u.searchParams.set('cursor_string', cursor);
    const r = await fetch(u, { headers: { Accept: 'application/json' } });
    if (!r.ok) { console.error('search', r.status); break; }
    const j = await r.json();
    cursor = j.cursor_string;
    for (const s of j.beatmapsets) for (const b of s.beatmaps) {
      if (b.mode === 'mania' && (b.cs === 4 || b.cs === 7)) out.push({ id: b.id, keys: b.cs, sr: b.difficulty_rating, title: `${s.artist} - ${s.title} [${b.version}]` });
    }
    if (!cursor) break;
    await sleep(1000);
  }
  return out;
}

const listFile = join(work, 'maps.json');
let maps;
if (existsSync(listFile) && !process.env.REFRESH) maps = JSON.parse(readFileSync(listFile, 'utf8'));
else {
  const a = await search('keys=4', 4);
  const b = await search('keys=7', 12);
  const seen = new Set();
  maps = [...a, ...b].filter((m) => !seen.has(m.id) && seen.add(m.id));
  writeFileSync(listFile, JSON.stringify(maps));
}
// Spread across difficulty: bucket by 0.5★ and take up to 4 per bucket per keymode
const pick = [];
for (const k of [4, 7]) {
  const buckets = {};
  for (const m of maps.filter((x) => x.keys === k && x.sr >= 1.5)) (buckets[Math.floor(m.sr * 2)] ||= []).push(m);
  for (const list of Object.values(buckets)) pick.push(...list.slice(0, 4));
}
console.error(`sample: ${pick.length} charts (${pick.filter((m) => m.keys === 4).length} 4K, ${pick.filter((m) => m.keys === 7).length} 7K)`);

const rows = [];
for (const m of pick) {
  const f = join(work, 'osu', `${m.id}.osu`);
  if (!existsSync(f)) {
    const r = await fetch(`https://osu.ppy.sh/osu/${m.id}`);
    if (!r.ok) { console.error('osu', m.id, r.status); continue; }
    writeFileSync(f, await r.text());
    await sleep(700);
  }
  try {
    const a = analyzeChart(parseOsu(readFileSync(f, 'utf8')));
    if (!a) continue;
    rows.push({ ...m, overall: a.overall, top: a.top[0], ln: a.lnRatio, nps: a.nps, dan: danFor(a.overall, a.keys)?.label ?? '-' });
  } catch (e) { console.error('parse', m.id, e.message); }
}

function spearman(xs, ys) {
  const rank = (v) => { const s = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = []; s.forEach(([, i], j) => (r[i] = j)); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  const d2 = rx.reduce((s, r, i) => s + (r - ry[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}
function fit(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return { a: my - b * mx, b };
}
const summary = {};
for (const k of [4, 7]) {
  const r = rows.filter((x) => x.keys === k);
  if (r.length < 5) continue;
  const reg = r.filter((x) => x.ln < 0.5);
  summary[`${k}K`] = {
    charts: r.length,
    spearman_all: +spearman(r.map((x) => x.sr), r.map((x) => x.overall)).toFixed(3),
    spearman_rice: reg.length > 4 ? +spearman(reg.map((x) => x.sr), reg.map((x) => x.overall)).toFixed(3) : null,
    rice_vs_ln_residual: (() => { const f = fit(reg.map((x) => x.sr), reg.map((x) => x.overall)); const ln = r.filter((x) => x.ln >= 0.5); if (!ln.length) return null; return +(ln.reduce((s2, x) => s2 + (x.overall - (f.a + f.b * x.sr)), 0) / ln.length).toFixed(2); })(),
    fit_overall_from_sr: (({ a, b }) => ({ a: +a.toFixed(2), b: +b.toFixed(2) }))(fit(r.map((x) => x.sr), r.map((x) => x.overall))),
  };
}
writeFileSync(join(work, 'results.json'), JSON.stringify({ rows, summary }, null, 1));
console.log(JSON.stringify(summary, null, 1));
for (const k of [4, 7]) {
  console.log(`\n${k}K  SR  -> overall  dan   top        LN%  title`);
  for (const x of rows.filter((y) => y.keys === k).sort((a, b) => a.sr - b.sr)) {
    console.log(`${x.sr.toFixed(2).padStart(6)} ${x.overall.toFixed(2).padStart(7)}  ${x.dan.padEnd(9)} ${x.top.padEnd(10)} ${String(Math.round(x.ln * 100)).padStart(3)}  ${x.title.slice(0, 60)}`);
  }
}
