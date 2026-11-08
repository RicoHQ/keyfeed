// Dan ladder shared by the server (server/skills.js) and the browser (web/js/app.js),
// so a rating always maps to the same dan everywhere.
//
// Units: keyfeed chart/player ratings ("effective 4K notes per second", see server/chart.js).
// Levels start at 1st dan = 7.5 and go up 1.5 per level. Checked against 44 real ranked 4K charts:
// rating order matches osu! star rating order with Spearman ρ ≈ 0.97, but the absolute ladder
// has not been calibrated against real dan-course passes yet.

export const DAN_NAMES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
export const STEPS = ['--', '-', '', '+', '++'];

export const LADDERS = {
  4: { bar: 96, lnBar: 95, start: 7.5, step: 1.5 },
  7: { bar: 96, lnBar: 95, start: 7.5, step: 1.5 },
};

export function thresholds(keys) {
  const l = LADDERS[keys];
  if (!l) return null;
  return DAN_NAMES.map((name, i) => ({ name, min: Math.round((l.start + i * l.step) * 100) / 100 }));
}

/**
 * Place a rating on a keymode's ladder.
 * Returns { label, level, index, pos } — e.g. { label: '7+', level: '7' } — or null when the
 * keymode has no ladder or the rating is below 1st dan.
 */
export function danFor(rating, keys) {
  const l = LADDERS[Number(keys)];
  if (!l || !(rating >= l.start)) return null;
  const raw = (rating - l.start) / l.step;
  const index = Math.min(DAN_NAMES.length - 1, Math.floor(raw));
  const pos = raw - index; // 0..1 inside the level (can exceed 1 above the top level)
  const level = DAN_NAMES[index];
  if (index === DAN_NAMES.length - 1 && pos >= 1) return { label: `>${level}`, level, index, pos: Math.round(pos * 100) / 100 };
  const step = STEPS[Math.min(4, Math.floor(pos * 5))];
  return { label: `${level}${step}`, level, index, pos: Math.round(pos * 100) / 100 };
}
