// Player skill ratings and dan estimates, built on chart ratings from chart.js.
//
// For each keymode with a ladder (4K, 7K):
//   credit(play, skillset) = chartRating[skillset] × rate(mods) × accuracyFactor(acc)
//   A play counts toward a skillset when that skillset is ≥ 85% of the chart's strongest one.
//   skillset rating = decayed mean (0.92^i) of the best 20 credits, needs ≥ 4 plays
//   overall         = 0.5·best + 0.3·second + 0.2·third skillset
//   dan             = overall placed on the ladder below, in five steps per level (--, -, , +, ++)
//
// The ladder thresholds are an uncalibrated first pass in "effective 4K nps" units.
// Tune them in LADDERS as real data comes in.

import { SKILLSETS, rateOf } from './chart.js';

const DAN_NAMES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];

export const LADDERS = {
  4: { bar: 96, lnBar: 95, start: 7.5, step: 1.5 },
  7: { bar: 96, lnBar: 95, start: 7.5, step: 1.5 },
};

export const SKILL_LABELS = {
  stream: 'Stream', jumpstream: 'Jumpstream', handstream: 'Handstream', jack: 'Jack',
  chordjack: 'Chordjack', tech: 'Tech', stamina: 'Stamina', ln: 'LN',
};

export function thresholds(keys) {
  const l = LADDERS[keys];
  if (!l) return null;
  return DAN_NAMES.map((name, i) => ({ name, min: Math.round((l.start + i * l.step) * 100) / 100 }));
}

/** Place a rating on the ladder. Returns { label, level, index } or null below 1st dan. */
export function danFor(rating, keys) {
  const t = thresholds(keys);
  if (!t || !(rating > 0)) return null;
  if (rating < t[0].min - LADDERS[keys].step) return null;
  let i = t.findIndex((x, j) => rating >= x.min && (j === t.length - 1 || rating < t[j + 1].min));
  if (i === -1) i = 0; // just under 1st: shows as 1--
  const lo = t[i].min;
  const width = LADDERS[keys].step;
  const pos = (rating - lo) / width; // 0..1 within level (can be <0 just under 1st)
  const beyond = i === t.length - 1 && pos >= 1;
  const steps = ['--', '-', '', '+', '++'];
  const s = steps[Math.max(0, Math.min(4, Math.floor(pos * 5)))];
  return { label: beyond ? `>${t[i].name}` : `${t[i].name}${s}`, level: t[i].name, index: i, pos: Math.round(pos * 100) / 100 };
}

/** Accuracy (0–100) → credit multiplier. Full credit at the bar, small bonus above, fades to 0 five points under. */
export function accuracyFactor(acc, bar) {
  if (acc >= bar) return 1 + 0.06 * ((acc - bar) / (100 - bar)) ** 2;
  const under = (bar - acc) / 5;
  return under >= 1 ? 0 : 1 - under ** 1.3;
}

/**
 * plays: [{ beatmap_id, accuracy (0–1), mods: [..], ended_at }]
 * charts: Map(beatmap_id -> analysis from analyzeChart)
 * Returns { [keys]: { overall, dan, skillsets: { name: { rating, dan, plays, best: [...] } }, plays } }
 */
export function computeSkills(plays, charts) {
  const byKeys = {};
  const seen = new Map(); // keep the best credit per beatmap+keys
  for (const p of plays) {
    const c = charts.get(p.beatmap_id);
    if (!c || !LADDERS[c.keys]) continue;
    const ladder = LADDERS[c.keys];
    const bar = c.lnRatio >= 0.5 ? ladder.lnBar : ladder.bar;
    const acc = (p.accuracy ?? 0) * 100;
    const factor = accuracyFactor(acc, bar);
    if (factor <= 0) continue;
    const rate = rateOf(p.mods);
    const strongest = Math.max(...SKILLSETS.map((k) => c.ratings[k] || 0));
    const bucket = (byKeys[c.keys] ||= Object.fromEntries(SKILLSETS.map((k) => [k, new Map()])));
    for (const k of SKILLSETS) {
      const r = c.ratings[k] || 0;
      if (!(r > 0) || r < strongest * 0.85) continue;
      const credit = Math.round(r * rate * factor * 100) / 100;
      const prev = bucket[k].get(p.beatmap_id);
      if (!prev || prev.credit < credit) bucket[k].set(p.beatmap_id, { beatmap_id: p.beatmap_id, credit, accuracy: p.accuracy, mods: p.mods, rate });
    }
    seen.set(`${c.keys}:${p.beatmap_id}`, true);
  }

  const out = {};
  for (const [keys, buckets] of Object.entries(byKeys)) {
    const skillsets = {};
    for (const k of SKILLSETS) {
      const list = [...buckets[k].values()].sort((a, b) => b.credit - a.credit).slice(0, 20);
      if (list.length < 4) { skillsets[k] = { rating: null, dan: null, plays: list.length, best: list.slice(0, 5) }; continue; }
      let sum = 0, wsum = 0;
      list.forEach((x, i) => { const w = 0.92 ** i; sum += x.credit * w; wsum += w; });
      const rating = Math.round((sum / wsum) * 100) / 100;
      skillsets[k] = { rating, dan: danFor(rating, Number(keys)), plays: list.length, best: list.slice(0, 5) };
    }
    const rated = SKILLSETS.map((k) => skillsets[k].rating).filter((r) => r != null).sort((a, b) => b - a);
    let overall = null;
    if (rated.length) {
      const w = [0.5, 0.3, 0.2].slice(0, rated.length);
      overall = Math.round((rated.slice(0, 3).reduce((s, r, i) => s + r * w[i], 0) / w.reduce((a, b) => a + b, 0)) * 100) / 100;
    }
    const plays = [...seen.keys()].filter((x) => x.startsWith(`${keys}:`)).length;
    out[keys] = { overall, dan: overall != null ? danFor(overall, Number(keys)) : null, skillsets, plays };
  }
  return out;
}
