// osu! weighted pp: total = Σ pp_i · 0.95^i over a player's top 100 plays (one per beatmap),
// plus a bonus for ranked play count that we leave out (it doesn't change on a single score).

export const WEIGHT = 0.95;
export const TOP_N = 100;

export function weightedTotal(pps) {
  return pps.slice(0, TOP_N).reduce((sum, pp, i) => sum + pp * WEIGHT ** i, 0);
}

/**
 * Given a player's current best scores and a new score, work out what the new score does.
 * best: [{ beatmap_id, pp }] (any order). score: { beatmap_id, pp }.
 * Returns { position, weightedPP, ppGain } where position is the 0-based slot in the new
 * top list (or -1 if it doesn't make the list / isn't an improvement on that beatmap).
 */
export function evaluateScore(best, score) {
  if (!score || !(score.pp > 0)) return { position: -1, weightedPP: 0, ppGain: 0 };
  const before = [...best].sort((a, b) => b.pp - a.pp);
  const existing = before.find((s) => s.beatmap_id === score.beatmap_id);
  if (existing && existing.pp >= score.pp) return { position: -1, weightedPP: 0, ppGain: 0 };

  const after = before.filter((s) => s.beatmap_id !== score.beatmap_id);
  after.push({ beatmap_id: score.beatmap_id, pp: score.pp, isNew: true });
  after.sort((a, b) => b.pp - a.pp);
  const position = after.findIndex((s) => s.isNew);
  if (position >= TOP_N) return { position: -1, weightedPP: 0, ppGain: 0 };

  const gain = weightedTotal(after.map((s) => s.pp)) - weightedTotal(before.map((s) => s.pp));
  return {
    position,
    weightedPP: round2(score.pp * WEIGHT ** position),
    ppGain: round2(Math.max(0, gain)),
  };
}

/** Insert/replace a score in a best list, keeping it sorted and capped. */
export function mergeBest(best, score) {
  const next = best.filter((s) => s.beatmap_id !== score.beatmap_id || s.pp >= score.pp);
  if (!next.some((s) => s.beatmap_id === score.beatmap_id)) next.push({ beatmap_id: score.beatmap_id, pp: score.pp });
  return next.sort((a, b) => b.pp - a.pp).slice(0, TOP_N);
}

const round2 = (n) => Math.round(n * 100) / 100;
