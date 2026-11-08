// keyfeed chart analyzer (model "kf1").
//
// Reads an osu!mania .osu file and rates how hard it is in each skillset. The unit is
// "effective notes per second" normalised to 4K, so numbers stay comparable across keymodes.
// It's a transparent heuristic, not a port of any other site's engine:
//
//   1. Notes are grouped into rows (chords) and each row is labelled with a pattern:
//        jack       single note on a column that was also hit in the previous row
//        chordjack  chord that repeats at least one column from the previous row
//        stream     single note, no repeat
//        jumpstream chord of 2..K/2 notes, no repeat
//        handstream chord of more than K/2 notes, no repeat
//   2. A 4-second window slides across the chart in 500 ms steps. In each window,
//      each pattern's rating = density × presence(share of that pattern) × pattern weight.
//   3. A skillset's chart rating is the mean of its best 10% of windows.
//   4. Tech comes from rhythm irregularity, stamina from the best sustained 60 s,
//      LN from hold coverage and release timing.

export const MODEL = 'kf1';
export const SKILLSETS = ['stream', 'jumpstream', 'handstream', 'jack', 'chordjack', 'tech', 'stamina', 'ln'];

const PATTERN_WEIGHT = { stream: 0.92, jumpstream: 1.0, handstream: 1.08, jack: 1.42, chordjack: 1.22 };
const WINDOW_MS = 4000;
const STEP_MS = 500;

export function parseOsu(text) {
  if (typeof text !== 'string' || !text.includes('[HitObjects]')) throw new Error('not an .osu file');
  const sections = {};
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { current = sec[1]; sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  const kv = (name) => Object.fromEntries((sections[name] || []).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
  const general = kv('General');
  const diff = kv('Difficulty');
  const meta = kv('Metadata');
  const mode = Number(general.Mode ?? 0);
  const keys = Math.round(Number(diff.CircleSize));
  const od = Number(diff.OverallDifficulty ?? 8);
  if (mode !== 3) return { mode, keys, od, notes: [], meta };
  if (!(keys >= 1 && keys <= 18)) throw new Error('bad key count');

  const notes = [];
  for (const l of sections.HitObjects || []) {
    const p = l.split(',');
    if (p.length < 5) continue;
    const x = Number(p[0]);
    const t = Number(p[2]);
    const type = Number(p[3]);
    const c = Math.min(keys - 1, Math.max(0, Math.floor((x * keys) / 512)));
    let end = null;
    if (type & 128) {
      const e = Number(String(p[5] || '').split(':')[0]);
      if (Number.isFinite(e) && e > t) end = e;
    }
    if (Number.isFinite(t)) notes.push({ t, c, end });
  }
  notes.sort((a, b) => a.t - b.t || a.c - b.c);
  return { mode, keys, od, notes, meta: { title: meta.Title, artist: meta.Artist, version: meta.Version, creator: meta.Creator } };
}

function rowsOf(notes) {
  const rows = [];
  for (const n of notes) {
    const last = rows[rows.length - 1];
    if (last && n.t - last.t <= 3) {
      if (!last.cols.has(n.c)) { last.cols.add(n.c); last.size++; }
    } else rows.push({ t: n.t, cols: new Set([n.c]), size: 1 });
  }
  return rows;
}

function labelRows(rows, keys) {
  const half = Math.max(2, Math.floor(keys / 2));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const p = rows[i - 1];
    const repeats = p ? [...r.cols].some((c) => p.cols.has(c)) : false;
    // A repeated column is a jack when it's a single note, and a chordjack only when two chords
    // in a row share a column. A chord landing on the column of a preceding single is an anchor
    // inside jumpstream/handstream, not a chordjack.
    if (repeats && r.size === 1) r.kind = 'jack';
    else if (repeats && p.size >= 2) r.kind = 'chordjack';
    else if (r.size === 1) r.kind = 'stream';
    else if (r.size <= half) r.kind = 'jumpstream';
    else r.kind = 'handstream';
    // rhythm change vs previous gap (for tech)
    if (i >= 2) {
      const g1 = r.t - p.t;
      const g0 = p.t - rows[i - 2].t;
      r.irregular = g0 > 0 && g1 > 0 && Math.abs(Math.log2(g1 / g0)) > 0.32 && Math.abs(Math.log2(g1 / g0) % 1) > 0.05 ? 1 : 0;
    } else r.irregular = 0;
  }
  return rows;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const topMean = (values, frac = 0.1) => {
  const v = values.filter((x) => x > 0).sort((a, b) => b - a);
  if (!v.length) return 0;
  return mean(v.slice(0, Math.max(1, Math.ceil(v.length * frac))));
};
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Analyse a parsed chart. Returns null for non-mania or empty charts.
 * Result: { model, keys, notes, lnRatio, lengthMs, nps, ratings: {skillset: n}, overall, top: [skillset...] }
 */
export function analyzeChart(parsed) {
  const { keys, notes } = parsed;
  if (parsed.mode !== 3 || notes.length < 20) return null;
  const norm = (keys / 4) ** 0.55; // a 7K chart at 13.6 nps ≈ a 4K chart at 10 nps
  const rows = labelRows(rowsOf(notes), keys);
  const start = notes[0].t;
  const end = Math.max(...notes.map((n) => n.end ?? n.t));
  const lengthMs = Math.max(1000, end - start);
  const lnNotes = notes.filter((n) => n.end);
  const lnRatio = lnNotes.length / notes.length;

  // per-window measurements (two pointers over rows)
  const windows = [];
  let lo = 0, hi = 0;
  for (let w = start; w <= end - WINDOW_MS / 2; w += STEP_MS) {
    while (lo < rows.length && rows[lo].t < w) lo++;
    while (hi < rows.length && rows[hi].t < w + WINDOW_MS) hi++;
    const count = { stream: 0, jumpstream: 0, handstream: 0, jack: 0, chordjack: 0 };
    let total = 0, irregular = 0, rowCount = 0;
    for (let i = lo; i < hi; i++) {
      count[rows[i].kind] += rows[i].size;
      total += rows[i].size;
      irregular += rows[i].irregular;
      rowCount++;
    }
    windows.push({ nps: total / (WINDOW_MS / 1000) / norm, count, total, irregular: rowCount ? irregular / rowCount : 0 });
  }
  if (!windows.length) return null;

  const ratings = {};
  for (const kind of Object.keys(PATTERN_WEIGHT)) {
    const vals = windows.map((w) => {
      if (!w.total) return 0;
      const share = w.count[kind] / w.total;
      if (share < 0.12) return 0;
      const presence = Math.min(1, share / 0.55) ** 0.5;
      return w.nps * presence * PATTERN_WEIGHT[kind];
    });
    ratings[kind] = topMean(vals);
  }

  // tech: dense windows with lots of rhythm changes
  ratings.tech = topMean(windows.map((w) => (w.irregular > 0.18 ? w.nps * (0.55 + 0.9 * Math.min(1, w.irregular)) : 0)));

  // stamina: best sustained 60 s (or the whole chart if shorter), scaled by length
  const per = Math.max(1, Math.round(60000 / STEP_MS));
  let best = 0;
  for (let i = 0; i + 1 <= windows.length; i++) {
    const slice = windows.slice(i, i + per);
    best = Math.max(best, mean(slice.map((w) => w.nps)));
    if (i + per >= windows.length) break;
  }
  const lengthFactor = Math.min(1.15, Math.max(0.6, (lengthMs / 120000) ** 0.3));
  ratings.stamina = best * lengthFactor * 0.88;

  // LN: hold coverage (how many columns are held on average) and releases off the beat
  if (lnRatio >= 0.15) {
    let heldTime = 0;
    for (const n of lnNotes) heldTime += n.end - n.t;
    const coverage = Math.min(1, heldTime / lengthMs / keys * 2.2);
    const pressTimes = new Set(rows.map((r) => Math.round(r.t / 5)));
    const offRelease = mean(lnNotes.map((n) => (pressTimes.has(Math.round(n.end / 5)) ? 0 : 1)));
    const base = topMean(windows.map((w) => w.nps));
    ratings.ln = base * (0.75 + 0.45 * coverage + 0.3 * offRelease) * Math.min(1, lnRatio / 0.5) ** 0.35;
  } else ratings.ln = 0;

  for (const k of SKILLSETS) ratings[k] = round2(ratings[k] || 0);
  const sorted = [...SKILLSETS].sort((a, b) => ratings[b] - ratings[a]);
  const r = sorted.map((k) => ratings[k]);
  const overall = round2(r[0] * 0.62 + r[1] * 0.24 + r[2] * 0.14);
  const top = sorted.filter((k) => ratings[k] >= r[0] * 0.85).slice(0, 3);

  return {
    model: MODEL,
    keys,
    od: parsed.od,
    notes: notes.length,
    lnRatio: round2(lnRatio),
    lengthMs,
    nps: round2(notes.length / (lengthMs / 1000)),
    ratings,
    overall,
    top,
  };
}

/** Rate multiplier for a score's mods (density scales ~linearly with playback rate). */
export function rateOf(mods = []) {
  const m = new Set(mods);
  if (m.has('DT') || m.has('NC')) return 1.5;
  if (m.has('HT') || m.has('DC')) return 0.75;
  return 1;
}
