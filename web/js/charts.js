// Small inline-SVG charts. Colours come from CSS variables so they follow light/dark mode.
import { esc, num } from './ui.js';

/**
 * series: [{ name, color, points: [{ x: Date|number, y: number }] }]
 * opts: { height, invert (rank charts: lower is better), yFormat, xFormat }
 */
export function lineChart(series, { height = 180, invert = false, yFormat = (v) => num(v), xFormat = shortDate, label = '' } = {}) {
  const all = series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.y));
  const longest = Math.max(0, ...series.map((s) => s.points.filter((p) => Number.isFinite(p.y)).length));
  if (all.length < 2 || longest < 2) return `<div class="chart-empty">Not enough history yet. It builds up day by day.</div>`;
  const W = 640, H = height, L = 52, R = 12, T = 12, B = 26;
  const xs = all.map((p) => +p.x), ys = all.map((p) => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x0 === x1) x1 = x0 + 1;
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
  const X = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  const Y = (y) => (invert ? T + ((y - y0) / (y1 - y0)) * (H - T - B) : H - B - ((y - y0) / (y1 - y0)) * (H - T - B));
  const ticks = 4;
  const grid = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = y0 + ((y1 - y0) * i) / ticks;
    const y = Y(v);
    return `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="grid"/><text x="${L - 8}" y="${y + 4}" text-anchor="end" class="axis">${esc(yFormat(v))}</text>`;
  }).join('');
  const xt = [x0, (x0 + x1) / 2, x1].map((x, i) => `<text x="${X(x)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}" class="axis">${esc(xFormat(x))}</text>`).join('');
  const lines = series.map((s) => {
    const pts = s.points.filter((p) => Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
    if (!pts.length) return '';
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(+p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
    const last = pts[pts.length - 1];
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${X(+last.x)}" cy="${Y(last.y)}" r="3.5" fill="${s.color}"/>`;
  }).join('');
  const legend = series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `<figure class="chart" role="img" aria-label="${esc(label)}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${xt}${lines}</svg>${legend}</figure>`;
}

/** Horizontal bars: rows [{ label, value, display, sub }] */
export function barList(rows, { max } = {}) {
  const m = max ?? Math.max(1, ...rows.map((r) => r.value || 0));
  return `<div class="bars">${rows.map((r) => `
    <div class="bar-row">
      <span class="bar-label">${esc(r.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(0, Math.min(100, ((r.value || 0) / m) * 100))}%"></span></span>
      <span class="bar-value">${r.display ?? esc(num(r.value, 2))}</span>
      ${r.sub ? `<span class="bar-sub">${r.sub}</span>` : ''}
    </div>`).join('')}</div>`;
}

/** GitHub-style activity grid for the last `weeks` weeks. activity: { 'YYYY-MM-DD': count } */
export function heatmap(activity, weeks = 26) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (weeks * 7 - 1) - end.getUTCDay());
  const max = Math.max(1, ...Object.values(activity));
  const cells = [];
  let total = 0;
  for (let d = new Date(start), i = 0; d <= end; d.setUTCDate(d.getUTCDate() + 1), i++) {
    const key = d.toISOString().slice(0, 10);
    const n = activity[key] || 0;
    total += n;
    const lvl = n === 0 ? 0 : Math.min(4, 1 + Math.floor((n / max) * 3.999));
    cells.push(`<rect x="${Math.floor(i / 7) * 13}" y="${(i % 7) * 13}" width="11" height="11" rx="2.5" class="hm${lvl}"><title>${key}: ${n} play${n === 1 ? '' : 's'}</title></rect>`);
  }
  return `<figure class="heatmap"><svg viewBox="0 0 ${weeks * 13 + 13} ${7 * 13}">${cells.join('')}</svg>
    <figcaption>${num(total)} plays seen in the last ${weeks} weeks</figcaption></figure>`;
}

export function shortDate(x) {
  return new Date(x).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const PALETTE = ['var(--accent)', '#ffcf5c', '#57d68d', '#ff6b7a', '#c38cff', '#ff9f43', '#5cb8ff', '#e4e4e4'];
