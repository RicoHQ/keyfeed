// Small rendering helpers. Everything user- or API-supplied goes through esc().

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const num = (n, digits = 0) => (n == null || Number.isNaN(Number(n)) ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }));
export const pct = (x) => (x == null ? '–' : `${(x * 100).toFixed(2)}%`);

export function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const hueOf = (n) => (Number(n) * 47) % 360;

// Only allow images from the osu! CDNs or inline data: URIs (mock mode).
const safeImg = (u) => (typeof u === 'string' && (/^https:\/\/(a|assets)\.ppy\.sh\//.test(u) || /^data:image\/svg\+xml;base64,/.test(u)) ? u : null);

export function avatarEl(user, size = '') {
  const src = safeImg(user?.avatar_url);
  const cls = `avatar ${size}`.trim();
  return src
    ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" width="34" height="34">`
    : `<span class="${cls}" style="background:hsl(${hueOf(user?.id || 1)} 45% 40%)"></span>`;
}

export function coverEl(score) {
  const src = safeImg(score.beatmapset?.cover || score.beatmapset?.card);
  if (src) return `<img class="cover" src="${esc(src)}" alt="" loading="lazy">`;
  const h = hueOf(score.beatmapset?.id || score.beatmap_id || 1);
  return `<span class="cover ph" style="background:linear-gradient(135deg,hsl(${h} 55% 38%),hsl(${(h + 60) % 360} 55% 24%))">${esc(score.beatmap?.keys ?? '?')}K</span>`;
}

export const gradeBadge = (rank) => {
  const r = String(rank || '?').toUpperCase();
  const label = r === 'X' ? 'SS' : r === 'XH' ? 'SS' : r === 'SH' ? 'S' : r;
  return `<span class="grade grade-${esc(r)}">${esc(label)}</span>`;
};

export function rankRow(p) {
  const d = p.rank_change;
  return `
    <a class="rank-row" href="/player/${encodeURIComponent(p.user.username)}" data-link>
      <span class="rank-num">#${p.rank}</span>
      ${avatarEl(p.user)}
      <span class="name">${esc(p.user.username)}${d > 0 ? `<span class="delta up">▲${d}</span>` : d < 0 ? `<span class="delta down">▼${-d}</span>` : ''}</span>
      <span class="pp">${num(p.pp)}<small>pp</small></span>
    </a>`;
}

export function scoreRow(s, { flash = false, hideUser = false, index } = {}) {
  const bm = s.beatmap || {};
  const bs = s.beatmapset || {};
  const mods = (s.mods || []).filter((m) => m !== 'CL').map((m) => `<span class="mod">${esc(m)}</span>`).join('');
  return `
    <div class="score${flash ? ' flash' : ''}" data-score="${esc(s.id)}">
      <a href="/maps/${esc(s.beatmap_id)}" data-link>${coverEl(s)}</a>
      <div class="score-main">
        <div class="score-title">${index ? `<span class="rank-num">#${index}</span> ` : ''}<a href="/maps/${esc(s.beatmap_id)}" data-link>${esc(bs.title)} <span class="artist">· ${esc(bs.artist)}</span></a></div>
        <div class="score-sub">
          ${hideUser ? '' : `<a class="who" href="/player/${encodeURIComponent(s.user?.username || '')}" data-link>${avatarEl(s.user, 'sm')}${esc(s.user?.username)}</a>`}
          <span class="keys">${esc(bm.keys ?? '?')}K</span>
          <span>${esc((bm.version || '').replace(/^\[\d+K\]\s*/, ''))}</span>
          <span class="stars">★${num(bm.difficulty_rating, 2)}</span>
          ${mods}
        </div>
      </div>
      <div class="score-right">
        <div>${gradeBadge(s.rank)} <span class="pp">${s.pp != null ? `${num(s.pp)}<small>pp</small>` : '<small>–</small>'}</span></div>
        <div class="meta">${pct(s.accuracy)} · <span data-ago="${esc(s.ended_at)}">${ago(s.ended_at)}</span></div>
        ${s.pp_gain > 0 ? `<div class="gain">+${num(s.pp_gain, 1)}pp</div>` : ''}
      </div>
    </div>`;
}

export const SKILL_LABELS = { stream: 'Stream', jumpstream: 'Jumpstream', handstream: 'Handstream', jack: 'Jack', chordjack: 'Chordjack', tech: 'Tech', stamina: 'Stamina', ln: 'LN' };

export function danBadge(dan, { size = '' } = {}) {
  if (!dan) return `<span class="dan dan-none ${size}">–</span>`;
  const greek = /[a-z]/i.test(dan.level);
  return `<span class="dan ${greek ? 'dan-greek' : ''} ${size}" title="Estimated dan">${dan.label.startsWith('>') ? '' : '~'}${esc(dan.label)}</span>`;
}

export function playerLink(u, { size = 'sm' } = {}) {
  if (!u) return '';
  return `<a class="who" href="/player/${encodeURIComponent(u.username || u.id)}" data-link>${avatarEl(u, size)}${esc(u.username)}</a>`;
}

export function snipeRow(s, { flash = false } = {}) {
  const bm = s.beatmap || {};
  const bs = s.beatmapset || {};
  return `
    <div class="score snipe${flash ? ' flash' : ''}">
      <a href="/maps/${esc(s.beatmap_id)}" data-link>${coverEl({ beatmapset: bs, beatmap: bm, beatmap_id: s.beatmap_id })}</a>
      <div class="score-main">
        <div class="score-title"><a href="/maps/${esc(s.beatmap_id)}" data-link>${esc(bs.title)} <span class="artist">· ${esc(bs.artist)}</span></a></div>
        <div class="score-sub">
          ${playerLink(s.sniper)} <span class="snipe-arrow" aria-label="sniped">took #1 from</span> ${playerLink(s.victim)}
          <span class="keys">${esc(bm.keys ?? '?')}K</span>
        </div>
      </div>
      <div class="score-right">
        <div>${gradeBadge(s.score?.rank)} <span class="pp">${num(s.score?.total_score)}</span></div>
        <div class="meta">beat ${num(s.victim_score?.total_score)} · <span data-ago="${new Date(s.created_at).toISOString()}">${ago(new Date(s.created_at).toISOString())}</span></div>
      </div>
    </div>`;
}

export function skillChips(analysis) {
  if (!analysis || analysis.status !== 'done') return analysis?.status === 'queued' ? '<span class="chip muted">analysing…</span>' : '';
  return (analysis.top || []).map((k) => `<span class="chip">${esc(SKILL_LABELS[k] || k)}</span>`).join('');
}

export function mapRow(m, i) {
  const b = m.beatmap || {};
  return `
    <a class="score" href="/maps/${esc(b.id)}" data-link>
      ${coverEl({ beatmapset: { id: b.set_id, cover: b.cover }, beatmap: { keys: b.keys }, beatmap_id: b.id })}
      <div class="score-main">
        <div class="score-title"><span class="rank-num">#${i + 1}</span> ${esc(b.title || `Map ${b.id}`)} <span class="artist">· ${esc(b.artist || '')}</span></div>
        <div class="score-sub">
          <span class="keys">${esc(b.keys ?? '?')}K</span><span>${esc((b.version || '').replace(/^\[\d+K\]\s*/, ''))}</span>
          ${b.sr ? `<span class="stars">★${num(b.sr, 2)}</span>` : ''}${skillChips(m.analysis)}
        </div>
      </div>
      <div class="score-right">
        <div class="pp">${num(m.plays)}<small> plays</small></div>
        <div class="meta">${num(m.players)} player${m.players === 1 ? '' : 's'}</div>
      </div>
    </a>`;
}
