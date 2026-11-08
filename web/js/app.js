import { subscribe } from './live.js';
import { esc, num, pct, ago, scoreRow, rankRow, gradeBadge, avatarEl, danBadge, playerLink, snipeRow, mapRow, skillChips, SKILL_LABELS } from './ui.js';
import { lineChart, barList, heatmap, PALETTE } from './charts.js';
import { COUNTRY_CODES } from './countries.js';
import { danFor, thresholds } from './dan.js';

const app = document.getElementById('app');
const countrySelect = document.getElementById('country');
let cfg = { countries: ['US'], active: ['US'], mock: false, loginAvailable: false, me: null };
let me = null;
let cleanup = [];
let liveConnected = false;

// ---------- utils ----------
const api = async (path, init = {}) => {
  const opts = { ...init, headers: { ...(init.headers || {}), ...(init.method && init.method !== 'GET' ? { 'x-keyfeed': '1' } : {}) } };
  const r = await fetch(path, opts);
  if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || r.statusText), { status: r.status });
  return r.json();
};
const params = () => new URLSearchParams(location.search);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const VALID = new Set(COUNTRY_CODES);
const getCountry = () => {
  const q = params().get('country')?.toUpperCase();
  if (q && VALID.has(q)) return q;
  const saved = store.get('keyfeed-country');
  return saved && VALID.has(saved) ? saved : cfg.countries[0];
};
const withCountry = (path, c = getCountry()) => `${path}${path.includes('?') ? '&' : '?'}country=${c}`;
const regionName = (code) => { try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' }).of(code); } catch { return code; } };
const flag = (code) => (code && code.length === 2 ? code.replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0))) : '');
const isTracked = (c) => cfg.countries.includes(c) || (cfg.active || []).includes(c);
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function onLive(country, fn) {
  const off = subscribe(country, (type, data) => {
    if (type === 'status') { liveConnected = data.connected; document.querySelectorAll('.live-dot').forEach((d) => d.classList.toggle('on', liveConnected)); return; }
    if (type === 'hello') { liveConnected = true; document.querySelectorAll('.live-dot').forEach((d) => d.classList.add('on')); }
    fn(type, data);
  });
  cleanup.push(off);
}

function prepend(listEl, html, key, max = 50) {
  if (!listEl) return;
  listEl.querySelector('.empty')?.remove();
  if (key && listEl.querySelector(`[data-score="${key}"]`)) return;
  listEl.insertAdjacentHTML('afterbegin', html);
  while (listEl.children.length > max) listEl.lastElementChild.remove();
}

const card = (title, body, link, opts = {}) => `
  <section class="card ${opts.cls || ''}">
    <div class="card-head"><h2>${opts.live ? `<span class="live-dot${liveConnected ? ' on' : ''}"></span>` : ''}${esc(title)}</h2>${link ? `<a href="${link}" data-link>${opts.linkText || 'View all'}</a>` : ''}${opts.right || ''}</div>
    <div ${opts.id ? `id="${opts.id}"` : ''} ${opts.bodyCls ? `class="${opts.bodyCls}"` : ''}>${body}</div>
  </section>`;
const skeleton = (n = 5) => Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');
const errorBox = (e) => `<div class="empty">Couldn't load this: ${esc(e.message)}</div>`;
const tabs = (items, active) => `<nav class="tabs">${items.map(([key, label, href]) => `<a data-link class="${key === active ? 'active' : ''}" href="${href}">${esc(label)}</a>`).join('')}</nav>`;
const delta = (d) => (d > 0 ? `<span class="delta up">▲${d}</span>` : d < 0 ? `<span class="delta down">▼${-d}</span>` : '');
const stat = (label, value, sub = '') => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;
const countryTitle = (c) => `${flag(c)} ${esc(regionName(c))}`;

function alertBanner(msg) {
  const b = document.getElementById('banner');
  b.innerHTML = msg || '';
  b.hidden = !msg;
}

/** Warm up an on-demand country and tell the user what's happening. */
async function ensureCountry(c) {
  if (isTracked(c)) return;
  try {
    const r = await api(`/api/countries/activate?country=${c}`, { method: 'POST' });
    cfg.active = r.active;
    fillCountrySelect();
  } catch {}
}

// ---------- avatar accent colours ----------
const accentCache = new Map();
function accentFor(user) {
  if (!user?.id) return Promise.resolve(null);
  if (accentCache.has(user.id)) return accentCache.get(user.id);
  const cached = store.get(`kf-accent-${user.id}`);
  if (cached) { accentCache.set(user.id, Promise.resolve(cached)); return accentCache.get(user.id); }
  const src = String(user.avatar_url || '').startsWith('data:') ? user.avatar_url : `/api/avatar?u=${user.id}`;
  const p = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 24, 24);
        const d = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2]);
          const sat = max ? (max - min) / max : 0;
          const wt = 0.15 + sat * (max / 255);
          r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
        }
        const hex = '#' + [r, g, b].map((v) => Math.round(Math.min(255, (v / w) * 1.15 + 20)).toString(16).padStart(2, '0')).join('');
        store.set(`kf-accent-${user.id}`, hex);
        resolve(hex);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
  accentCache.set(user.id, p);
  return p;
}

// ---------- views ----------
const views = {
  async home() {
    const c = getCountry();
    await ensureCountry(c);
    app.innerHTML = `
      <h1 class="page-title">${countryTitle(c)} <small>osu!mania</small></h1>
      ${isTracked(c) && !cfg.countries.includes(c) ? `<p class="note">Tracking ${esc(regionName(c))} on demand: the top ${cfg.onDemandRoster} players are polled while someone is viewing.</p>` : ''}
      <div class="grid">
        <div class="stack">
          ${card('Rankings', skeleton(), withCountry('/rankings'), { id: 'home-rank' })}
          ${card('Top plays · 7 days', skeleton(3), withCountry('/top-plays'), { id: 'home-top' })}
          ${card('Recent snipes', skeleton(3), withCountry('/snipes'), { id: 'home-snipes' })}
        </div>
        ${card('Live scores', skeleton(8), withCountry('/tracker'), { id: 'home-feed', live: true })}
      </div>`;
    const $ = (id) => document.getElementById(id);
    const [rank, top, feed, sn] = await Promise.allSettled([
      api(withCountry('/api/rankings')),
      api(withCountry('/api/top-plays?window=7d&limit=5')),
      api(withCountry('/api/tracker?limit=15')),
      api(withCountry('/api/snipes?limit=5')),
    ]);
    $('home-rank').innerHTML = rank.status === 'fulfilled'
      ? (rank.value.ranking.slice(0, 10).map(rankRow).join('') || '<div class="empty">Fetching the rankings for the first time…</div>') : errorBox(rank.reason);
    if (rank.status === 'fulfilled' && !rank.value.ranking.length) {
      const t = setTimeout(() => { if (location.pathname === '/') route(); }, 5000);
      cleanup.push(() => clearTimeout(t));
    }
    $('home-top').innerHTML = top.status === 'fulfilled' ? renderTopHome(top.value.plays.length ? top.value.plays : (top.value.highest || []).slice(0, 5)) : errorBox(top.reason);
    $('home-feed').innerHTML = feed.status === 'fulfilled'
      ? (feed.value.scores.map((s) => scoreRow(s)).join('') || '<div class="empty">Waiting for the first scores. New plays show up here as they\'re set.</div>') : errorBox(feed.reason);
    $('home-snipes').innerHTML = sn.status === 'fulfilled'
      ? (sn.value.snipes.map((s) => snipeRow(s)).join('') || '<div class="empty">No snipes yet. They appear when a tracked player takes #1 on a map from another.</div>') : errorBox(sn.reason);

    onLive(c, (type, data) => {
      if (type === 'tracker_score') prepend($('home-feed'), scoreRow(data, { flash: true }), data.id, 15);
      if (type === 'snipe') prepend($('home-snipes'), snipeRow(data, { flash: true }), null, 5);
      if (type === 'top_play') api(withCountry('/api/top-plays?window=7d&limit=5')).then((t) => { $('home-top').innerHTML = renderTopHome(t.plays); }).catch(() => {});
      if (type === 'rankings') api(withCountry('/api/rankings')).then((r) => { $('home-rank').innerHTML = r.ranking.slice(0, 10).map(rankRow).join(''); }).catch(() => {});
    });
  },

  async rankings() {
    const c = getCountry();
    const p = params();
    const scope = p.get('scope') === 'global' ? 'global' : 'country';
    const mode = ['4k', '7k', 'skill4', 'skill7'].includes(p.get('mode')) ? p.get('mode') : 'all';
    const page = Math.max(1, Math.min(2, Number(p.get('page')) || 1));
    if (scope === 'country') await ensureCountry(c);
    const href = (o) => withCountry(`/rankings?scope=${o.scope ?? scope}&mode=${o.mode ?? mode}`);
    app.innerHTML = `
      <h1 class="page-title">Rankings <small>${scope === 'global' ? 'Global' : countryTitle(c)}</small></h1>
      <div class="tab-row">
        ${tabs([['country', 'Country', href({ scope: 'country' })], ['global', 'Global', href({ scope: 'global' })]], scope)}
        ${tabs([['all', 'pp', href({ mode: 'all' })], ['4k', '4K pp', href({ mode: '4k' })], ['7k', '7K pp', href({ mode: '7k' })], ['skill4', '4K skill', href({ mode: 'skill4' })], ['skill7', '7K skill', href({ mode: 'skill7' })]], mode)}
      </div>
      ${card(mode.startsWith('skill') ? 'Skill rating' : 'Performance', skeleton(10), null, { id: 'rank-table' })}`;
    const el = document.getElementById('rank-table');
    try {
      const r = await api(withCountry(`/api/rankings?scope=${scope}&mode=${mode}&page=${page}`));
      if (mode.startsWith('skill')) {
        el.innerHTML = r.ranking.length ? `
          <div class="table-wrap"><table class="table">
            <thead><tr><th>#</th><th>Player</th><th class="num">Rating</th><th>Dan</th><th class="hide-sm">Strongest</th></tr></thead>
            <tbody>${r.ranking.map((x) => {
              const top = Object.entries(x.skillsets).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => SKILL_LABELS[k]).join(', ');
              return `<tr><td><b>${x.rank}</b></td><td><a class="player" href="/player/${encodeURIComponent(x.user.username)}/skills" data-link>${avatarEl(x.user)}<span class="name">${esc(x.user.username)}</span></a></td>
                <td class="num pp">${num(x.overall, 2)}</td><td>${danBadge(x.dan)}</td><td class="hide-sm muted">${esc(top)}</td></tr>`;
            }).join('')}</tbody></table></div>
          <p class="note pad">Skill ratings exist for players whose skills page has been opened or computed. <a href="/dan-estimates" data-link>How this works</a></p>`
          : '<div class="empty">No skill ratings yet. Open a player\'s Skills tab to analyse their top plays.</div>';
        return;
      }
      const pages = Math.max(1, Math.ceil((r.total || 0) / 50));
      el.innerHTML = r.ranking.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>#</th><th>Player</th><th class="num">${mode === 'all' ? 'pp' : mode.toUpperCase() + ' pp'}</th><th class="num hide-sm">4K</th><th class="num hide-sm">7K</th><th class="num hide-sm">Acc</th><th class="num hide-sm">Global</th></tr></thead>
          <tbody>${r.ranking.map((x) => `
            <tr>
              <td><b>${x.rank}</b>${delta(x.rank_change)}</td>
              <td><a class="player" href="/player/${encodeURIComponent(x.user.username)}" data-link>${avatarEl(x.user)}<span class="name">${scope === 'global' && x.user.country_code ? flag(x.user.country_code) + ' ' : ''}${esc(x.user.username)}</span></a></td>
              <td class="num pp">${num(x.pp)}<small>pp</small>${x.pp_change > 0 ? `<span class="delta up">+${num(x.pp_change)}</span>` : ''}</td>
              <td class="num hide-sm">${x.pp_4k != null ? num(x.pp_4k) : '–'}</td>
              <td class="num hide-sm">${x.pp_7k != null ? num(x.pp_7k) : '–'}</td>
              <td class="num hide-sm">${x.accuracy != null ? pct(x.accuracy / 100) : '–'}</td>
              <td class="num hide-sm">${x.global_rank ? '#' + num(x.global_rank) : '–'}</td>
            </tr>`).join('')}</tbody></table></div>
        <div class="pager">
          ${page > 1 ? `<a class="btn" data-link href="${href({})}&page=${page - 1}">← Prev</a>` : ''}
          <span>Page ${page} of ${pages}${r.fetchedAt ? ` · updated ${ago(new Date(r.fetchedAt).toISOString())}` : ''}</span>
          ${page < pages ? `<a class="btn" data-link href="${href({})}&page=${page + 1}">Next →</a>` : ''}
        </div>`
        : `<div class="empty">${r.updating ? 'Fetching this leaderboard from osu!… refresh in a few seconds.' : 'Nothing here yet.'}</div>`;
      if (r.updating && !r.ranking.length) setTimeout(() => { if (location.pathname === '/rankings') route(); }, 6000);
    } catch (e) { el.innerHTML = errorBox(e); }
  },

  async tracker() {
    const c = getCountry();
    await ensureCountry(c);
    let offset = 0;
    app.innerHTML = `<h1 class="page-title">Live scores <small>${countryTitle(c)}</small></h1>
      ${card('Recent passes', skeleton(10), null, { id: 'feed', live: true })}
      <div class="pager"><button class="btn" id="more">Load more</button></div>`;
    const feedEl = document.getElementById('feed');
    const load = async () => {
      const r = await api(withCountry(`/api/tracker?limit=40&offset=${offset}`));
      if (offset === 0) feedEl.innerHTML = '';
      feedEl.insertAdjacentHTML('beforeend', r.scores.map((s) => scoreRow(s)).join(''));
      offset += r.scores.length;
      if (!feedEl.children.length) feedEl.innerHTML = '<div class="empty">Waiting for the first scores…</div>';
      document.getElementById('more').hidden = offset >= r.total;
    };
    document.getElementById('more').onclick = () => load().catch((e) => alertBanner(esc(e.message)));
    try { await load(); } catch (e) { feedEl.innerHTML = errorBox(e); }
    onLive(c, (type, data) => { if (type === 'tracker_score') { prepend(feedEl, scoreRow(data, { flash: true }), data.id, 500); offset++; } });
  },

  async 'top-plays'() {
    const c = getCountry();
    await ensureCountry(c);
    const w = ['24h', '7d', '30d'].includes(params().get('window')) ? params().get('window') : '7d';
    app.innerHTML = `<h1 class="page-title">Top plays <small>${countryTitle(c)}</small></h1>
      ${tabs(['24h', '7d', '30d'].map((x) => [x, x, withCountry(`/top-plays?window=${x}`)]), w)}
      <div class="grid">
        ${card('New personal bests (tracked players)', skeleton(8), null, { id: 'top', live: true })}
        ${card('Highest pp · last 24h · everyone', skeleton(8), null, { id: 'top-all' })}
      </div>`;
    const el = document.getElementById('top');
    const elAll = document.getElementById('top-all');
    const load = async () => {
      const r = await api(withCountry(`/api/top-plays?window=${w}&limit=100`));
      el.innerHTML = r.plays.map((s, i) => scoreRow(s, { index: i + 1 })).join('') || '<div class="empty">No new top-100 plays in this window yet.</div>';
      elAll.innerHTML = cfg.ingest === 'firehose'
        ? (r.highest || []).map((s, i) => scoreRow(s, { index: i + 1 })).join('') || '<div class="empty">No pp plays from this country seen in the last 24 hours yet.</div>'
        : '<div class="empty">Needs the global score feed (INGEST=firehose).</div>';
    };
    try { await load(); } catch (e) { el.innerHTML = errorBox(e); }
    onLive(c, (type) => { if (type === 'top_play') load().catch(() => {}); });
  },

  async snipes() {
    const c = getCountry();
    await ensureCountry(c);
    app.innerHTML = `<h1 class="page-title">Snipes <small>${countryTitle(c)}</small></h1>
      <p class="note">A snipe is a tracked player taking #1 on a map from another tracked player in the same country. Leaderboards are built from scores keyfeed has seen.</p>
      <div class="grid">
        <div class="stack">
          ${card('Most #1s', skeleton(6), null, { id: 'holders' })}
          ${card('Top snipers · 7 days', skeleton(3), null, { id: 'snipers' })}
          ${card('Most sniped · 7 days', skeleton(3), null, { id: 'victims' })}
        </div>
        ${card('Latest snipes', skeleton(8), null, { id: 'snipe-feed', live: true })}
      </div>`;
    const $ = (id) => document.getElementById(id);
    const counted = (list, unit) => list.length ? list.map((x, i) => `
      <a class="rank-row" href="/player/${encodeURIComponent(x.user.username)}" data-link>
        <span class="rank-num">#${i + 1}</span>${avatarEl(x.user)}<span class="name">${esc(x.user.username)}</span><span class="pp">${num(x.count ?? x.firsts)}<small> ${unit}</small></span>
      </a>`).join('') : '<div class="empty">Nothing yet.</div>';
    try {
      const [board, feed] = await Promise.all([api(withCountry('/api/snipes/board')), api(withCountry('/api/snipes?limit=60'))]);
      $('holders').innerHTML = counted(board.holders, '#1s');
      $('snipers').innerHTML = counted(board.snipers, 'snipes');
      $('victims').innerHTML = counted(board.victims, 'lost');
      $('snipe-feed').innerHTML = feed.snipes.map((s) => snipeRow(s)).join('') || '<div class="empty">No snipes yet.</div>';
    } catch (e) { $('snipe-feed').innerHTML = errorBox(e); }
    onLive(c, (type, data) => { if (type === 'snipe') prepend($('snipe-feed'), snipeRow(data, { flash: true }), null, 200); });
  },

  async maps() {
    const c = getCountry();
    await ensureCountry(c);
    const w = ['24h', '7d', '30d'].includes(params().get('window')) ? params().get('window') : '7d';
    app.innerHTML = `<h1 class="page-title">Maps <small>${countryTitle(c)}</small></h1>
      ${tabs(['24h', '7d', '30d'].map((x) => [x, x, withCountry(`/maps?window=${x}`)]), w)}
      ${card('Most played by tracked players', skeleton(10), null, { id: 'maps' })}`;
    const el = document.getElementById('maps');
    try {
      const r = await api(withCountry(`/api/maps?window=${w}`));
      el.innerHTML = r.maps.map(mapRow).join('') || '<div class="empty">No plays in this window yet.</div>';
    } catch (e) { el.innerHTML = errorBox(e); }
  },

  async map(id) {
    const c = getCountry();
    const scope = params().get('scope') === 'country' ? 'country' : 'all';
    app.innerHTML = `<section class="card">${skeleton(4)}</section>`;
    try {
      const d = await api(`/api/maps/${id}${scope === 'country' ? `?country=${c}` : ''}`);
      const b = d.beatmap || {};
      const a = d.analysis?.status === 'done' ? d.analysis : null;
      document.title = `${b.artist} - ${b.title} [${b.version}] · keyfeed`;
      const ratingRows = a ? Object.entries(a.ratings).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([k, v]) => ({ label: SKILL_LABELS[k], value: v, display: num(v, 2), sub: danBadge(danFor(v, a.keys)) })) : [];
      app.innerHTML = `
        <section class="card map-hero" ${b.cover && /^https:\/\/assets\.ppy\.sh\//.test(b.cover) ? `style="--cover:url('${esc(b.cover)}')"` : ''}>
          <div class="map-hero-inner">
            <div class="muted">${esc(b.artist)}</div>
            <h1>${esc(b.title)}</h1>
            <div class="score-sub"><span class="keys">${esc(b.keys ?? '?')}K</span><span>${esc(b.version)}</span>${b.sr ? `<span class="stars">★${num(b.sr, 2)}</span>` : ''}${b.bpm ? `<span>${num(b.bpm)} BPM</span>` : ''}${b.creator ? `<span>mapped by ${esc(b.creator)}</span>` : ''}
            ${b.url && b.url !== '#' ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">osu! ↗</a>` : ''}</div>
          </div>
        </section>
        <div class="grid" style="margin-top:18px">
          <div class="stack">
            ${card('Chart analysis', a ? `
              <div class="analysis-head">
                ${danBadge(danFor(a.overall, a.keys), { size: 'lg' })}
                <div><div class="value">${num(a.overall, 2)}</div><div class="muted">overall · ${esc(a.top.map((k) => SKILL_LABELS[k]).join(' / '))}</div></div>
              </div>
              ${barList(ratingRows)}
              <div class="mini-stats"><span>${num(a.notes)} notes</span><span>${num(a.nps, 1)} nps avg</span><span>${Math.round(a.lnRatio * 100)}% LN</span><span>${Math.round(a.lengthMs / 1000)}s</span></div>
              <p class="note pad">Estimate from keyfeed's chart model (${esc(a.model)}). <a href="/dan-estimates" data-link>How it works</a></p>`
              : `<div class="empty">${d.analysis?.status === 'unsupported' ? 'Only osu!mania charts are analysed.' : 'Queued for analysis. Check back in a minute.'}</div>`)}
            ${d.snipes.length ? card('Snipes on this map', d.snipes.map((s) => snipeRow(s)).join('')) : ''}
          </div>
          <div class="stack">
            ${card('Leaderboard (tracked players)', d.leaderboard.length ? `
              <div class="table-wrap"><table class="table">
                <thead><tr><th>#</th><th>Player</th><th class="num">Score</th><th class="num">Acc</th><th class="num hide-sm">pp</th><th class="hide-sm">Mods</th></tr></thead>
                <tbody>${d.leaderboard.map((x) => `<tr><td><b>${x.rank}</b></td><td>${playerLink(x.user)}</td><td class="num">${num(x.total_score)}</td><td class="num">${pct(x.accuracy)}</td><td class="num hide-sm">${x.pp ? num(x.pp) : '–'}</td><td class="hide-sm">${(x.mods || []).filter((m) => m !== 'CL').map((m) => `<span class="mod">${esc(m)}</span>`).join('')}</td></tr>`).join('')}</tbody>
              </table></div>` : '<div class="empty">No tracked scores on this map yet.</div>', null, {
                right: tabs([['all', 'All', `/maps/${id}`], ['country', regionName(c), `/maps/${id}?scope=country&country=${c}`]], scope),
              })}
            ${card('Recent plays', d.recent.map((s) => scoreRow(s)).join('') || '<div class="empty">None tracked yet.</div>')}
          </div>
        </div>`;
      if (!a && d.analysis?.status !== 'unsupported') setTimeout(() => { if (location.pathname === `/maps/${id}`) route(); }, 15000);
    } catch (e) {
      app.innerHTML = e.status === 404 ? '<div class="card"><div class="empty">Map not found.</div></div>' : `<div class="card">${errorBox(e)}</div>`;
    }
  },

  async player(name, tab = 'overview') {
    app.innerHTML = `<section class="card">${skeleton(4)}</section>`;
    let data;
    try {
      data = await api(`/api/players/${encodeURIComponent(name)}`);
    } catch (e) {
      app.innerHTML = e.status === 404 ? `<div class="card"><div class="empty">No player called “${esc(name)}”.</div></div>` : `<div class="card">${errorBox(e)}</div>`;
      return;
    }
    const { user } = data;
    const s = user.stats || {};
    document.title = `${user.username} · keyfeed`;
    const base = `/player/${encodeURIComponent(user.username)}`;
    app.innerHTML = `
      <section class="card profile-card">
        <div class="profile">
          ${avatarEl(user, 'lg')}
          <div class="profile-main">
            <h1>${esc(user.username)}</h1>
            <div class="sub">
              <span>${user.country_code ? `${flag(user.country_code)} ${esc(regionName(user.country_code))}` : ''}</span>
              ${user.is_online ? '<span><span class="live-dot on"></span> online</span>' : ''}
              ${user.join_date ? `<span>Joined ${new Date(user.join_date).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}</span>` : ''}
              ${data.tracked ? '<span class="chip">tracked</span>' : ''}
              ${cfg.mock ? '' : `<a href="https://osu.ppy.sh/users/${user.id}/mania" rel="noopener" target="_blank">osu! profile ↗</a>`}
            </div>
          </div>
          <div class="profile-actions">${followButton(user, data.following)}</div>
        </div>
        <div class="stats">
          ${stat('pp', num(s.pp))}${stat('Global', s.global_rank ? '#' + num(s.global_rank) : '–', user.rank_highest ? `peak #${num(user.rank_highest.rank)}` : '')}${stat('Country', s.country_rank ? '#' + num(s.country_rank) : '–')}
          ${stat('4K pp', s.pp_4k != null ? num(s.pp_4k) : '–')}${stat('7K pp', s.pp_7k != null ? num(s.pp_7k) : '–')}
          ${stat('Accuracy', pct((s.accuracy || 0) / 100))}${stat('Play count', num(s.play_count))}${stat('Play time', s.play_time ? Math.round(s.play_time / 3600) + 'h' : '–')}
        </div>
      </section>
      ${tabs([['overview', 'Overview', base], ['skills', 'Skills', `${base}/skills`]], tab)}
      <div id="player-body"></div>`;
    accentFor(user).then((c) => { if (c) document.querySelector('.profile-card')?.style.setProperty('--user-accent', c); });
    bindFollow(user);
    const body = document.getElementById('player-body');
    if (tab === 'skills') return renderSkills(body, user);

    const h = data.history;
    const rank90 = (user.rank_history || []).map((y, i, arr) => ({ x: Date.now() - (arr.length - 1 - i) * 86_400_000, y })).filter((p) => p.y > 0);
    const ppPts = h.snapshots.filter((x) => x.pp).map((x) => ({ x: Date.parse(x.day), y: x.pp }));
    const keyRows = Object.entries(h.keySplit).filter(([k]) => k !== '?' && k !== 'null').sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ label: `${k}K`, value: n, display: num(n), sub: '<span class="muted small">plays</span>' }));
    body.innerHTML = `
      <div class="grid">
        <div class="stack">
          ${card('Global rank · 90 days', lineChart([{ name: 'Global rank', color: PALETTE[0], points: rank90 }], { invert: true, yFormat: (v) => '#' + num(v), label: 'Global rank history' }))}
          ${card('pp history', lineChart([{ name: 'pp', color: PALETTE[1], points: ppPts }], { label: 'pp history' }))}
          ${card('Key split (top plays)', keyRows.length ? barList(keyRows) : '<div class="empty">No top plays stored yet.</div>')}
          ${card('Activity', heatmap(h.activity))}
        </div>
        <div class="stack">
          ${card('Tracked recent', data.recent.map((x) => scoreRow(x, { hideUser: true })).join('') || `<div class="empty">${data.tracked ? 'No tracked scores yet.' : 'Not tracked. Follow this player to track their scores.'}</div>`)}
          ${card('Best performance', data.best.map((x, i) => scoreRow(x, { hideUser: true, index: i + 1 })).join('') || '<div class="empty">No ranked plays.</div>')}
        </div>
      </div>`;
  },

  async world() {
    document.title = 'World · keyfeed';
    if (cfg.ingest !== 'firehose') { app.innerHTML = '<div class="card"><div class="empty">The world view needs the global score feed (INGEST=firehose).</div></div>'; return; }
    app.innerHTML = `<h1 class="page-title">🌍 World <small>every osu!mania pass, live</small></h1>
      <p class="note">Every country is followed through osu!'s global score feed. Countries marked <span class="chip">tracked</span> also get rankings, pp gain, snipes and history; open any country to start tracking it.</p>
      <div class="grid">
        ${card('Countries · last 24h', skeleton(10), null, { id: 'countries' })}
        ${card('Live, worldwide', skeleton(10), null, { id: 'world-feed', live: true })}
      </div>`;
    const render = (r) => {
      const tracked = new Set(r.tracked);
      document.getElementById('countries').innerHTML = r.countries.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Country</th><th class="num">Plays 24h</th><th class="num">This hour</th><th class="num hide-sm">Top pp</th></tr></thead>
          <tbody>${r.countries.slice(0, 120).map((c) => `
            <tr><td><a class="player" href="/?country=${c.country}" data-link>${flag(c.country)} <span class="name">${esc(regionName(c.country))}</span>${tracked.has(c.country) ? ' <span class="chip">tracked</span>' : ''}</a></td>
              <td class="num">${num(c.plays24h)}</td><td class="num">${num(c.playsHour)}</td>
              <td class="num hide-sm">${c.topPP ? num(c.topPP) + '<small>pp</small>' : '–'}</td></tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty">Waiting for the first scores from the feed…</div>';
    };
    try {
      const r = await api('/api/world?limit=40');
      document.getElementById('world-feed').innerHTML = r.scores.map((x) => scoreRow(x)).join('') || '<div class="empty">Waiting for scores…</div>';
      render(r);
    } catch (e) { document.getElementById('world-feed').innerHTML = errorBox(e); }
    const t = setInterval(() => api('/api/countries/live').then(render).catch(() => {}), 30000);
    cleanup.push(() => clearInterval(t));
    onLive('WORLD', (type, data) => {
      if (type === 'tracker_score') prepend(document.getElementById('world-feed'), scoreRow(data, { flash: true }), data.id, 60);
    });
  },

  async following() {
    if (!me) { app.innerHTML = `<div class="card"><div class="empty">Sign in to follow players. ${loginLink('Sign in with osu!')}</div></div>`; return; }
    app.innerHTML = `<h1 class="page-title">Following</h1><div class="grid">${card('Players', skeleton(4), null, { id: 'fl' })}${card('Their latest scores', skeleton(8), null, { id: 'ff' })}</div>`;
    try {
      const r = await api('/api/me/feed');
      document.getElementById('fl').innerHTML = r.following.map((u) => `
        <a class="rank-row" href="/player/${encodeURIComponent(u.username)}" data-link><span class="rank-num">${flag(u.country_code)}</span>${avatarEl(u)}<span class="name">${esc(u.username)}</span><span class="pp">${num(u.pp)}<small>pp</small></span></a>`).join('')
        || '<div class="empty">You\'re not following anyone yet. Use the Follow button on a player page.</div>';
      document.getElementById('ff').innerHTML = r.scores.map((s) => scoreRow(s)).join('') || '<div class="empty">No scores yet. Followed players are polled every few minutes.</div>';
    } catch (e) { document.getElementById('ff').innerHTML = errorBox(e); }
  },

  'dan-estimates'() {
    document.title = 'How skills and dans are estimated · keyfeed';
    app.innerHTML = `<article class="card prose">
      <h1>How skills and dans are estimated</h1>
      <p>keyfeed rates charts and players with its own transparent model (<code>kf2</code>). The numbers are estimates and get a <b>~</b> in front.</p><p><b>How well it works:</b> on 84 popular ranked charts, keyfeed's rating order matches osu!'s star rating order closely (Spearman ρ ≈ 0.98 for 4K and 0.96 for 7K). The absolute dan ladder has not been calibrated against real dan course passes yet, so treat exact levels as approximate.</p>
      <h2>1. Every chart is analysed</h2>
      <p>When a tracked player sets a pp score, or a map or skills page is opened, keyfeed downloads the chart's <code>.osu</code> file and reads its notes. Notes are grouped into rows (chords), and each row gets a pattern label:</p>
      <ul>
        <li><b>Jack</b>: a single note on a column that was also hit in the previous row.</li>
        <li><b>Chordjack</b>: two chords in a row sharing a column.</li>
        <li><b>Stream</b>: a single note with no repeat.</li>
        <li><b>Jumpstream / Handstream</b>: chords of two notes up to half the keys, or more than half.</li>
      </ul>
      <p>A 4-second window slides across the chart. In each window, each pattern's rating is note density × how much of the window is that pattern × a pattern weight (jacks count more per note than streams). A skillset's chart rating is the average of its hardest 10% of windows. <b>Tech</b> comes from rhythm changes, <b>Stamina</b> from the best sustained 60 seconds, and <b>LN</b> from press-plus-release density (a release counts as half a press) scaled by how many columns are held at once. Units are effective notes per second, normalised so 4K and 7K are comparable.</p>
      <h2>2. Plays earn credit</h2>
      <p>credit = chart rating × rate (DT 1.5×, HT 0.75×) × accuracy factor. The accuracy factor is 1.0 at the bar (96%, or 95% on LN charts), grows slowly above it, and fades to 0 five points under it. A play counts toward every skillset that is at least 85% of the chart's strongest one.</p>
      <h2>3. Skillsets, overall and dan</h2>
      <p>Each skillset's rating is a weighted average of your best 20 credits (0.92ⁱ), and needs at least 4 plays. Overall = 0.5 × your best skillset + 0.3 × the second + 0.2 × the third. Dans are computed separately for 4K and 7K from that overall:</p>
      <div class="table-wrap">${ladderTable()}</div>
      <p>Each level is split into five steps: <code>--</code>, <code>-</code>, (plain), <code>+</code>, <code>++</code>. Ratings are saved once a day, which builds the skill history chart.</p>
      <h2>Limits</h2>
      <p>Only scores keyfeed can see are used: your osu! top 100, plus scores tracked while you're on a roster or followed. A heuristic model can be fooled by unusual charts (gimmicks, SV-heavy maps). Treat it as a guide, not a ruling.</p>
    </article>`;
  },

  notFound() {
    app.innerHTML = `<div class="card"><div class="empty">Page not found. <a href="/" data-link>Go home</a></div></div>`;
  },
};

function ladderTable() {
  const t = thresholds(4);
  const half = Math.ceil(t.length / 2);
  const cell = (i) => (i < t.length ? `<td>${danBadge({ label: t[i].name, level: t[i].name })}</td><td class="num">${t[i].min.toFixed(1)}</td>` : '<td></td><td></td>');
  return `<table class="table"><thead><tr><th>Dan</th><th class="num">Overall from</th><th>Dan</th><th class="num">Overall from</th></tr></thead><tbody>${
    Array.from({ length: half }, (_, r) => `<tr>${cell(r)}${cell(r + half)}</tr>`).join('')}</tbody></table>`;
}

async function renderSkills(body, user) {
  body.innerHTML = card('Skills', skeleton(6));
  let r;
  try { r = await api(`/api/players/${encodeURIComponent(user.username)}/skills`); } catch (e) { body.innerHTML = card('Skills', errorBox(e)); return; }
  const modes = Object.entries(r.keys).sort((a, b) => (b[1].plays || 0) - (a[1].plays || 0));
  const pending = r.pending > 0 ? `<p class="note pad">${r.pending} of this player's charts are still being analysed (${r.queue} in the queue overall). The page refreshes when they're done.</p>` : '';
  if (!modes.length) {
    body.innerHTML = card('Skills', `<div class="empty">${r.pending ? 'Analysing this player\'s top plays…' : 'No 4K or 7K plays to rate yet.'}</div>${pending}`);
  } else {
    body.innerHTML = `<div class="skill-grid">${modes.map(([keys, m]) => {
      const rows = Object.entries(m.skillsets).map(([k, v]) => ({ label: SKILL_LABELS[k], value: v.rating ?? 0, display: v.rating != null ? num(v.rating, 2) : '<span class="muted">–</span>', sub: v.rating != null ? danBadge(v.dan) : `<span class="muted small">${v.plays}/4 plays</span>` }));
      const hist = r.history.filter((h) => String(h.keys) === String(keys));
      const top = Object.entries(m.skillsets).filter(([, v]) => v.rating != null).sort((a, b) => b[1].rating - a[1].rating).slice(0, 4).map(([k]) => k);
      const series = [{ name: 'Overall', color: PALETTE[0], points: hist.map((h) => ({ x: Date.parse(h.day), y: h.overall })) },
        ...top.map((k, i) => ({ name: SKILL_LABELS[k], color: PALETTE[i + 1], points: hist.map((h) => ({ x: Date.parse(h.day), y: h.skillsets[k] })) }))];
      return card(`${keys}K skill`, `
        <div class="analysis-head">
          ${danBadge(m.dan, { size: 'lg' })}
          <div><div class="value">${m.overall != null ? num(m.overall, 2) : '–'}</div><div class="muted">overall · rated from ${m.plays} chart${m.plays === 1 ? '' : 's'}</div></div>
        </div>
        ${barList(rows, { max: Math.max(...rows.map((x) => x.value), 1) })}
        <h3 class="sub-head">History</h3>
        ${lineChart(series, { height: 170, yFormat: (v) => num(v, 1), label: `${keys}K skill history` })}`);
    }).join('')}</div>${pending ? card('Analysis queue', pending) : ''}
    <p class="note">Estimates from keyfeed's chart model ${esc(r.model)}. <a href="/dan-estimates" data-link>How skills and dans are estimated</a></p>`;
  }
  if (r.pending > 0) setTimeout(() => { if (location.pathname.endsWith('/skills')) route(); }, 12000);
}

function renderTopHome(plays) {
  if (!plays.length) return '<div class="empty">No new personal bests this week yet.</div>';
  const [first, ...rest] = plays;
  const cover = first.beatmapset?.cover && /^https:\/\/assets\.ppy\.sh\//.test(first.beatmapset.cover) ? first.beatmapset.cover : null;
  return `
    <a class="hero" href="/player/${encodeURIComponent(first.user?.username || '')}" data-link ${cover ? `style="background-image:url('${esc(cover)}')"` : ''}>
      <div class="big">${num(first.pp)}pp</div>
      <div class="score-sub" style="justify-content:center">${avatarEl(first.user, 'sm')}<b>${esc(first.user?.username)}</b>${gradeBadge(first.rank)}<span>${pct(first.accuracy)}</span>${first.pp_gain ? `<span class="gain">+${num(first.pp_gain, 1)}pp</span>` : ''}</div>
      <div class="score-sub" style="justify-content:center">${esc(first.beatmapset?.artist)} – ${esc(first.beatmapset?.title)} <span class="keys">${first.beatmap?.keys ?? '?'}K</span></div>
    </a>
    ${rest.map((s) => scoreRow(s)).join('')}`;
}

// ---------- auth ----------
const loginLink = (text) => (cfg.loginAvailable ? `<a class="btn btn-primary" href="/api/auth/login?next=${encodeURIComponent(location.pathname + location.search)}">${esc(text)}</a>` : '');

function renderAuth() {
  const el = document.getElementById('auth');
  if (!cfg.loginAvailable) { el.innerHTML = ''; return; }
  if (!me) { el.innerHTML = loginLink(cfg.mock ? 'Demo sign-in' : 'Sign in'); return; }
  el.innerHTML = `
    <details class="menu">
      <summary aria-label="Account">${avatarEl(me, 'sm')}<span class="hide-sm">${esc(me.username)}</span></summary>
      <div class="menu-pop">
        <a href="/player/${encodeURIComponent(me.username)}" data-link>My profile</a>
        <a href="/player/${encodeURIComponent(me.username)}/skills" data-link>My skills</a>
        <a href="/following" data-link>Following</a>
        <button type="button" id="logout">Sign out</button>
      </div>
    </details>`;
  document.getElementById('logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    me = null;
    renderAuth();
    route();
  };
}

function followButton(user, following) {
  if (!cfg.loginAvailable) return '';
  if (!me) return loginLink('Sign in to follow');
  if (me.id === user.id) return '<span class="chip">this is you</span>';
  return `<button class="btn ${following ? '' : 'btn-primary'}" id="follow" data-following="${following ? 1 : 0}">${following ? 'Following ✓' : 'Follow'}</button>`;
}

function bindFollow(user) {
  const b = document.getElementById('follow');
  if (!b) return;
  b.onclick = async () => {
    const on = b.dataset.following === '1';
    b.disabled = true;
    try {
      await api(`/api/follows/${user.id}`, { method: on ? 'DELETE' : 'POST' });
      b.dataset.following = on ? '0' : '1';
      b.textContent = on ? 'Follow' : 'Following ✓';
      b.classList.toggle('btn-primary', on);
    } catch (e) { alertBanner(`Couldn't update follow: ${esc(e.message)}`); }
    b.disabled = false;
  };
}

// ---------- router ----------
function route() {
  cleanup.forEach((f) => f());
  cleanup = [];
  document.title = 'keyfeed · osu!mania tracker';
  document.querySelectorAll('details.menu[open]').forEach((d) => d.removeAttribute('open'));
  const path = location.pathname.replace(/\/+$/, '') || '/';
  let key = 'notFound', args = [];
  const simple = { '/': 'home', '/world': 'world', '/rankings': 'rankings', '/tracker': 'tracker', '/top-plays': 'top-plays', '/snipes': 'snipes', '/maps': 'maps', '/following': 'following', '/dan-estimates': 'dan-estimates' };
  let m;
  if (simple[path]) key = simple[path];
  else if ((m = path.match(/^\/maps\/(\d+)$/))) { key = 'map'; args = [m[1]]; }
  else if ((m = path.match(/^\/player\/([^/]+)(?:\/(skills))?$/))) { key = 'player'; args = [decodeURIComponent(m[1]), m[2] || 'overview']; }
  const navKey = key === 'map' ? 'maps' : key;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === navKey);
    a.href = a.dataset.nav === 'home' ? withCountry('/') : withCountry(`/${a.dataset.nav}`);
  });
  countrySelect.value = getCountry();
  window.scrollTo(0, 0);
  views[key](...args);
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (href !== location.pathname + location.search) history.pushState(null, '', href);
  route();
});
window.addEventListener('popstate', route);

function fillCountrySelect() {
  const tracked = [...new Set([...cfg.countries, ...(cfg.active || [])])];
  const others = COUNTRY_CODES.filter((c) => !tracked.includes(c)).map((c) => [c, regionName(c)]).sort((a, b) => a[1].localeCompare(b[1]));
  countrySelect.innerHTML = `
    <optgroup label="Tracked">${tracked.map((c) => `<option value="${c}">${flag(c)} ${esc(regionName(c))}</option>`).join('')}</optgroup>
    <optgroup label="All countries (tracked on demand)">${others.map(([c, n]) => `<option value="${c}">${flag(c)} ${esc(n)}</option>`).join('')}</optgroup>`;
  countrySelect.value = getCountry();
}

countrySelect.addEventListener('change', () => {
  store.set('keyfeed-country', countrySelect.value);
  const p = params();
  p.set('country', countrySelect.value);
  p.delete('page');
  const keep = /^\/(rankings|tracker|top-plays|snipes|maps)$/.test(location.pathname) ? location.pathname : '/';
  history.pushState(null, '', `${keep}?${p}`);
  route();
});

document.getElementById('search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (!q) return;
  e.target.q.value = '';
  history.pushState(null, '', `/player/${encodeURIComponent(q)}`);
  route();
});

(async function boot() {
  try { cfg = await api('/api/config'); } catch {}
  me = cfg.me || null;
  fillCountrySelect();
  renderAuth();
  const flags = [];
  if (cfg.mock) flags.push('Demo mode: every player, map and score here is generated. Set OSU_CLIENT_ID and OSU_CLIENT_SECRET to track real data.');
  const login = params().get('login');
  if (login === 'failed') flags.push('Sign-in failed. Please try again.');
  alertBanner(flags.map(esc).join('<br>'));
  route();
  const statusEl = document.getElementById('status');
  const refreshStatus = () => api('/api/status').then((s) => { statusEl.textContent = `${s.feed ? `${num(s.feed.countriesLive)} countries live · ` : ''}${num(s.players)} tracked players · ${num(s.scores)} scores stored · ${num(s.charts)} charts analysed`; }).catch(() => {});
  refreshStatus();
  setInterval(refreshStatus, 30000);
  setInterval(() => document.querySelectorAll('[data-ago]').forEach((el) => { el.textContent = ago(el.dataset.ago); }), 15000);
})();
