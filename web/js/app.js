import { subscribe } from './live.js';
import { esc, num, pct, ago, scoreRow, rankRow, gradeBadge, coverEl, avatarEl } from './ui.js';

const app = document.getElementById('app');
const countrySelect = document.getElementById('country');
let cfg = { countries: ['US'], mock: false };
let cleanup = [];
let liveConnected = false;

// ---------- utils ----------
const api = async (path) => {
  const r = await fetch(path);
  if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || r.statusText), { status: r.status });
  return r.json();
};
const params = () => new URLSearchParams(location.search);
const getCountry = () => {
  const q = params().get('country')?.toUpperCase();
  if (q && cfg.countries.includes(q)) return q;
  let saved = null;
  try { saved = localStorage.getItem('keyfeed-country'); } catch {}
  return cfg.countries.includes(saved) ? saved : cfg.countries[0];
};
const withCountry = (path, c = getCountry()) => `${path}${path.includes('?') ? '&' : '?'}country=${c}`;
const flagName = (code) => { try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' }).of(code); } catch { return code; } };
const flagEmoji = (code) => code.replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));

function onLive(country, fn) {
  const off = subscribe(country, (type, data) => {
    if (type === 'status') { liveConnected = data.connected; document.querySelectorAll('.live-dot').forEach((d) => d.classList.toggle('on', liveConnected)); return; }
    if (type === 'hello') { liveConnected = true; document.querySelectorAll('.live-dot').forEach((d) => d.classList.add('on')); }
    fn(type, data);
  });
  cleanup.push(off);
}

function prependScore(listEl, score, max = 50) {
  if (!listEl) return;
  listEl.querySelector('.empty')?.remove();
  if (listEl.querySelector(`[data-score="${score.id}"]`)) return;
  listEl.insertAdjacentHTML('afterbegin', scoreRow(score, { flash: true }));
  while (listEl.children.length > max) listEl.lastElementChild.remove();
}

const card = (title, body, link, opts = {}) => `
  <section class="card">
    <div class="card-head"><h2>${opts.live ? `<span class="live-dot${liveConnected ? ' on' : ''}"></span>` : ''}${esc(title)}</h2>${link ? `<a href="${link}" data-link>View all</a>` : ''}</div>
    <div ${opts.id ? `id="${opts.id}"` : ''}>${body}</div>
  </section>`;
const skeleton = (n = 5) => Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');
const errorBox = (e) => `<div class="empty">Couldn't load this: ${esc(e.message)}</div>`;

// ---------- views ----------
const views = {
  async home() {
    const c = getCountry();
    app.innerHTML = `
      <h1 class="page-title">${flagEmoji(c)} ${esc(flagName(c))} <small>osu!mania</small></h1>
      <div class="grid">
        <div class="stack">
          ${card('Rankings', skeleton(), withCountry('/rankings'), { id: 'home-rank' })}
          ${card('Top plays · 7 days', skeleton(3), withCountry('/top-plays'), { id: 'home-top' })}
        </div>
        ${card('Live scores', skeleton(8), withCountry('/tracker'), { id: 'home-feed', live: true })}
      </div>`;
    const [rank, top, feed] = await Promise.allSettled([
      api(withCountry('/api/rankings?pageSize=10')),
      api(withCountry('/api/top-plays?window=7d&limit=5')),
      api(withCountry('/api/tracker?limit=15')),
    ]);
    const $ = (id) => document.getElementById(id);
    $('home-rank').innerHTML = rank.status === 'fulfilled'
      ? (rank.value.ranking.map(rankRow).join('') || '<div class="empty">Rankings are loading for the first time…</div>') : errorBox(rank.reason);
    $('home-top').innerHTML = top.status === 'fulfilled' ? renderTopHome(top.value.plays) : errorBox(top.reason);
    $('home-feed').innerHTML = feed.status === 'fulfilled'
      ? (feed.value.scores.map((s) => scoreRow(s)).join('') || '<div class="empty">Waiting for the first scores. New plays show up here as they\'re set.</div>') : errorBox(feed.reason);

    onLive(c, (type, data) => {
      if (type === 'tracker_score') prependScore($('home-feed'), data, 15);
      if (type === 'top_play') api(withCountry('/api/top-plays?window=7d&limit=5')).then((t) => { $('home-top').innerHTML = renderTopHome(t.plays); }).catch(() => {});
      if (type === 'rankings') api(withCountry('/api/rankings?pageSize=10')).then((r) => { $('home-rank').innerHTML = r.ranking.map(rankRow).join(''); }).catch(() => {});
    });
  },

  async rankings() {
    const c = getCountry();
    const page = Math.max(1, Number(params().get('page')) || 1);
    app.innerHTML = `<h1 class="page-title">Rankings <small>${flagEmoji(c)} ${esc(flagName(c))}</small></h1>${card('Performance', skeleton(10), null, { id: 'rank-table' })}`;
    try {
      const r = await api(withCountry(`/api/rankings?page=${page}&pageSize=50`));
      const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
      document.getElementById('rank-table').innerHTML = r.ranking.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>#</th><th>Player</th><th class="num">pp</th><th class="num hide-sm">4K</th><th class="num hide-sm">7K</th><th class="num hide-sm">Acc</th><th class="num hide-sm">Global</th></tr></thead>
          <tbody>${r.ranking.map((p) => `
            <tr>
              <td><b>${p.rank}</b>${delta(p.rank_change)}</td>
              <td><a class="player" href="/player/${encodeURIComponent(p.user.username)}" data-link>${avatarEl(p.user)}<span class="name">${esc(p.user.username)}</span></a></td>
              <td class="num pp">${num(p.pp)}<small>pp</small>${p.pp_change > 0 ? `<span class="delta up">+${num(p.pp_change)}</span>` : ''}</td>
              <td class="num hide-sm">${p.pp_4k != null ? num(p.pp_4k) : '–'}</td>
              <td class="num hide-sm">${p.pp_7k != null ? num(p.pp_7k) : '–'}</td>
              <td class="num hide-sm">${pct(p.accuracy / 100)}</td>
              <td class="num hide-sm">#${num(p.global_rank)}</td>
            </tr>`).join('')}</tbody></table></div>
        <div class="pager">
          ${page > 1 ? `<a class="btn" data-link href="${withCountry(`/rankings?page=${page - 1}`)}">← Prev</a>` : ''}
          <span>Page ${page} of ${pages}</span>
          ${page < pages ? `<a class="btn" data-link href="${withCountry(`/rankings?page=${page + 1}`)}">Next →</a>` : ''}
        </div>` : '<div class="empty">No rankings yet. The first fetch runs on startup.</div>';
    } catch (e) { document.getElementById('rank-table').innerHTML = errorBox(e); }
  },

  async tracker() {
    const c = getCountry();
    let offset = 0;
    app.innerHTML = `<h1 class="page-title">Live scores <small>${flagEmoji(c)} ${esc(flagName(c))}</small></h1>
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
    document.getElementById('more').onclick = () => load().catch((e) => alertBanner(e.message));
    try { await load(); } catch (e) { feedEl.innerHTML = errorBox(e); }
    onLive(c, (type, data) => { if (type === 'tracker_score') { prependScore(feedEl, data, 500); offset++; } });
  },

  async 'top-plays'() {
    const c = getCountry();
    const w = ['24h', '7d', '30d'].includes(params().get('window')) ? params().get('window') : '7d';
    app.innerHTML = `<h1 class="page-title">Top plays <small>${flagEmoji(c)} ${esc(flagName(c))}</small></h1>
      <nav class="tabs">${['24h', '7d', '30d'].map((x) => `<a data-link class="${x === w ? 'active' : ''}" href="${withCountry(`/top-plays?window=${x}`)}">${x}</a>`).join('')}</nav>
      ${card('New personal bests, by pp', skeleton(8), null, { id: 'top', live: true })}`;
    const el = document.getElementById('top');
    const load = async () => {
      const r = await api(withCountry(`/api/top-plays?window=${w}&limit=100`));
      el.innerHTML = r.plays.map((s, i) => scoreRow(s, { index: i + 1 })).join('') || '<div class="empty">No new top-100 plays in this window yet.</div>';
    };
    try { await load(); } catch (e) { el.innerHTML = errorBox(e); }
    onLive(c, (type) => { if (type === 'top_play') load().catch(() => {}); });
  },

  async player(name) {
    app.innerHTML = `<section class="card">${skeleton(4)}</section>`;
    try {
      const { user, best, recent } = await api(`/api/players/${encodeURIComponent(name)}`);
      const s = user.stats || {};
      document.title = `${user.username} · keyfeed`;
      app.innerHTML = `
        <section class="card">
          <div class="profile">
            ${avatarEl(user, 'lg')}
            <div>
              <h1>${esc(user.username)}</h1>
              <div class="sub">
                <span>${user.country_code ? `${flagEmoji(user.country_code)} ${esc(flagName(user.country_code))}` : ''}</span>
                ${user.is_online ? '<span><span class="live-dot on"></span> online</span>' : ''}
                ${user.join_date ? `<span>Joined ${new Date(user.join_date).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}</span>` : ''}
                ${cfg.mock ? '' : `<a href="https://osu.ppy.sh/users/${user.id}/mania" rel="noopener" target="_blank">osu! profile ↗</a>`}
              </div>
            </div>
          </div>
          <div class="stats">
            ${stat('pp', num(s.pp))}${stat('Global', s.global_rank ? '#' + num(s.global_rank) : '–')}${stat('Country', s.country_rank ? '#' + num(s.country_rank) : '–')}
            ${stat('4K pp', s.pp_4k != null ? num(s.pp_4k) : '–')}${stat('7K pp', s.pp_7k != null ? num(s.pp_7k) : '–')}
            ${stat('Accuracy', pct((s.accuracy || 0) / 100))}${stat('Play count', num(s.play_count))}${stat('Play time', s.play_time ? Math.round(s.play_time / 3600) + 'h' : '–')}
          </div>
        </section>
        <div class="grid" style="margin-top:18px">
          ${card('Tracked recent', recent.map((x) => scoreRow(x, { hideUser: true })).join('') || '<div class="empty">No tracked scores yet. Only roster players are polled.</div>')}
          ${card('Best performance', best.map((x, i) => scoreRow(x, { hideUser: true, index: i + 1 })).join('') || '<div class="empty">No ranked plays.</div>')}
        </div>`;
    } catch (e) {
      app.innerHTML = e.status === 404 ? `<div class="card"><div class="empty">No player called “${esc(name)}”.</div></div>` : `<div class="card">${errorBox(e)}</div>`;
    }
  },

  notFound() {
    app.innerHTML = `<div class="card"><div class="empty">Page not found. <a href="/" data-link>Go home</a></div></div>`;
  },
};

function renderTopHome(plays) {
  if (!plays.length) return '<div class="empty">No new personal bests this week yet.</div>';
  const [first, ...rest] = plays;
  return `
    <a class="hero" href="/player/${encodeURIComponent(first.user?.username || '')}" data-link ${first.beatmapset?.cover ? `style="background-image:url('${esc(first.beatmapset.cover)}')"` : ''}>
      <div class="big">${num(first.pp)}pp</div>
      <div class="score-sub" style="justify-content:center">${avatarEl(first.user, 'sm')}<b>${esc(first.user?.username)}</b>${gradeBadge(first.rank)}<span>${pct(first.accuracy)}</span>${first.pp_gain ? `<span class="gain">+${num(first.pp_gain, 1)}pp</span>` : ''}</div>
      <div class="score-sub" style="justify-content:center">${esc(first.beatmapset?.artist)} – ${esc(first.beatmapset?.title)} <span class="keys">${first.beatmap?.keys ?? '?'}K</span></div>
    </a>
    ${rest.map((s) => scoreRow(s)).join('')}`;
}

const stat = (label, value) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`;
const delta = (d) => (d > 0 ? `<span class="delta up">▲${d}</span>` : d < 0 ? `<span class="delta down">▼${-d}</span>` : '');

function alertBanner(msg) {
  const b = document.getElementById('banner');
  b.textContent = msg;
  b.hidden = !msg;
}

// ---------- router ----------
function route() {
  cleanup.forEach((f) => f());
  cleanup = [];
  document.title = 'keyfeed · osu!mania tracker';
  const path = location.pathname.replace(/\/+$/, '') || '/';
  let key = 'notFound', arg;
  if (path === '/') key = 'home';
  else if (path === '/rankings') key = 'rankings';
  else if (path === '/tracker') key = 'tracker';
  else if (path === '/top-plays') key = 'top-plays';
  else if (path.startsWith('/player/')) { key = 'player'; arg = decodeURIComponent(path.slice(8)); }
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
  countrySelect.value = getCountry();
  window.scrollTo(0, 0);
  views[key](arg);
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
  e.preventDefault();
  if (a.getAttribute('href') !== location.pathname + location.search) history.pushState(null, '', a.getAttribute('href'));
  route();
});
window.addEventListener('popstate', route);

countrySelect.addEventListener('change', () => {
  try { localStorage.setItem('keyfeed-country', countrySelect.value); } catch {}
  const p = params();
  p.set('country', countrySelect.value);
  p.delete('page');
  history.pushState(null, '', `${location.pathname.startsWith('/player/') ? '/' : location.pathname}?${p}`);
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

// nav links keep the selected country
document.querySelectorAll('[data-nav]').forEach((a) => {
  a.addEventListener('mouseenter', () => { if (a.dataset.nav !== 'home') a.href = withCountry(a.pathname); else a.href = withCountry('/'); });
});

(async function boot() {
  try { cfg = await api('/api/config'); } catch {}
  countrySelect.innerHTML = cfg.countries.map((c) => `<option value="${c}">${flagEmoji(c)} ${c}</option>`).join('');
  if (cfg.mock) alertBanner('Demo mode: every player, map and score here is generated. Set OSU_CLIENT_ID and OSU_CLIENT_SECRET to track real data.');
  route();
  const statusEl = document.getElementById('status');
  const refreshStatus = () => api('/api/status').then((s) => { statusEl.textContent = `${num(s.players)} players · ${num(s.scores)} scores tracked`; }).catch(() => {});
  refreshStatus();
  setInterval(refreshStatus, 30000);
  setInterval(() => document.querySelectorAll('[data-ago]').forEach((el) => { el.textContent = ago(el.dataset.ago); }), 15000);
})();
