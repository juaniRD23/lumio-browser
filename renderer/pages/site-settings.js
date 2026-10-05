// Site settings (lumio://settings/content…) and Third-party cookies
// (lumio://settings/cookies): what sites may use and show, the sites with
// their own settings, the data sites keep, and one site's page. The settings
// live in main/site-settings.js; each view loads fresh from there.
import '/keys.js';
import { accentFor, setAccent } from '/assets/theme-colors.js';
import { siteIcon } from '/assets/site-icons.js';

const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const size = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B');
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const hostOf = (origin) => { try { return new URL(origin).host; } catch { return origin; } };
const view = $('#view');

// What a value means in a site's list or menu.
const WORDS = { allow: 'Allow', block: 'Block', session: 'Clear on exit', ask: 'Ask', quiet: 'Ask quietly', open: 'Open', download: 'Download', 'block-incognito': 'Block in Incognito' };
const DONE = { allow: 'allowed', block: 'blocked', session: 'cleared on exit' };
const valueWord = (id, v) => (id === 'sound' && v === 'block' ? 'Mute' : WORDS[v] || v);

const GROUPS = [
  { title: 'Permissions', main: 'permissions', more: 'more-permissions', moreTitle: 'Additional permissions' },
  { title: 'Content', main: 'content', more: 'more-content', moreTitle: 'Additional content settings' },
];

function header({ title, crumb, back }) {
  document.title = title;
  $('#title').textContent = title;
  $('#crumb').textContent = crumb;
  $('#back').href = back;
  $('#back').innerHTML = siteIcon('back', { size: 18 });
  $('#back').setAttribute('aria-label', `Back to ${crumb}`);
}

// A confirmation before deleting: resolves true for Delete.
function confirmDelete({ title, text, ok = 'Delete' }) {
  const dlg = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = ok;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

function done() { view.removeAttribute('aria-busy'); }

// ---------------------------------------------------------------- home
async function home() {
  header({ title: 'Site settings', crumb: 'Privacy and security', back: 'lumio://settings/#privacy' });
  const { categories, recent } = await page.invoke('page:site-settings');
  const byId = Object.fromEntries(categories.map((c) => [c.id, c]));
  const summary = (s) => Object.entries(s.settings).filter(([id]) => byId[id])
    .map(([id, v]) => `${byId[id].label} ${id === 'sound' && v === 'block' ? 'muted' : DONE[v] || v}`).join(' · ');
  const row = (c) => `<a class="row link" href="${c.id === 'thirdPartyCookies' ? '/cookies' : `/content/${c.id}`}">
      <span class="ic">${siteIcon(c.id)}</span>
      <div class="grow"><div class="title">${esc(c.label)}</div><div class="desc">${esc(c.text[c.value] || '')}</div></div>
      ${c.count ? `<span class="count">${plural(c.count, 'site')}</span>` : ''}<span class="chev">${siteIcon('chevron', { size: 16 })}</span></a>`;
  const group = (g) => {
    const main = categories.filter((c) => c.group === g.main);
    const more = categories.filter((c) => c.group === g.more);
    return `<h3>${g.title}</h3><div class="card">${main.map(row).join('')}
      <button class="row expander" aria-expanded="false" aria-controls="more-${g.more}"><div class="grow title">${g.moreTitle}</div><span class="chev">${siteIcon('chevron', { size: 16 })}</span></button>
      <div class="more" id="more-${g.more}" hidden>${more.map(row).join('')}</div></div>`;
  };
  view.innerHTML = `
    <p class="lead">Choose what sites can use and show, like your location, notifications or pop-ups.</p>
    <div class="card"><a class="row link" href="/content/all"><span class="ic">${siteIcon('siteData')}</span>
      <div class="grow"><div class="title">View permissions and data stored across sites</div></div><span class="chev">${siteIcon('chevron', { size: 16 })}</span></a></div>
    ${recent.length ? `<h3>Recent activity</h3><div class="card">${recent.map((s) => `<a class="row link" href="/content/siteDetails?site=${encodeURIComponent(s.origin)}">
      <span class="ic">${siteIcon('allSites')}</span><div class="grow"><div class="title">${esc(hostOf(s.origin))}</div><div class="desc">${esc(summary(s))}</div></div>
      <span class="chev">${siteIcon('chevron', { size: 16 })}</span></a>`).join('')}</div>` : ''}
    ${GROUPS.map(group).join('')}`;
  view.querySelectorAll('.expander').forEach((b) => b.addEventListener('click', () => {
    const open = b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', String(open));
    document.getElementById(b.getAttribute('aria-controls')).hidden = !open;
  }));
}

// ---------------------------------------------------------------- one category
async function category(id) {
  const data = await page.invoke('page:site-category', id);
  if (!data) { location.replace('/content'); return; }
  const { category: c } = data;
  const cookies = id === 'thirdPartyCookies';
  header({ title: c.label, crumb: cookies ? 'Privacy and security' : 'Site settings', back: cookies ? 'lumio://settings/#privacy' : '/content' });
  const radios = c.options.map((v) => `<label class="row option">
      <input type="radio" name="default" value="${v}" ${c.value === v ? 'checked' : ''} />
      <span class="ic">${siteIcon(c.id, { blocked: v === 'block' || (cookies && v !== 'allow') })}</span>
      <div class="grow"><div class="title">${esc(c.text[v])}</div>${c.hints?.[v] ? `<div class="desc">${esc(c.hints[v])}</div>` : ''}</div></label>`).join('');
  const lists = c.exceptions.map((v) => `<div class="card list" data-list="${v}">
      <div class="row list-head"><div class="grow title">${esc(c.lists[v])}</div><button class="btn" data-add="${v}">Add</button></div>
      <form class="row add-form" hidden><input class="field" name="site" placeholder="example.com" aria-label="Site to add to ${esc(c.lists[v])}" autocomplete="off" spellcheck="false" />
        <button class="btn primary" type="submit">Add</button><button class="btn ghost" type="button" data-cancel>Cancel</button></form>
      <div class="rows"></div></div>`).join('');
  view.innerHTML = `
    <p class="lead">${esc(c.desc)}</p>
    ${cookies ? `<p class="note">Lumio stops other sites in a page from receiving or setting cookies over the network. Their own scripts can still read cookies already saved for them in that frame.</p>` : ''}
    <h3>Default behavior</h3>
    <p class="hint">Sites automatically follow this setting when you visit them.</p>
    <div class="card modes" role="radiogroup" aria-label="Default behavior">${radios}</div>
    ${lists ? `<h3>Customized behaviors</h3><p class="hint">Sites listed below follow a custom setting instead of the default.</p>${lists}` : ''}
    ${cookies ? `<div class="card more-links"><a class="row link" href="/content/siteData"><span class="ic">${siteIcon('siteData')}</span><div class="grow"><div class="title">On-device site data</div><div class="desc">Delete data sites have saved when you close all windows</div></div><span class="chev">${siteIcon('chevron', { size: 16 })}</span></a></div>` : ''}`;
  view.querySelectorAll('input[name=default]').forEach((r) => r.addEventListener('change', () => page.invoke('page:site-set-default', id, r.value)));
  const renderLists = (sites) => {
    for (const list of view.querySelectorAll('[data-list]')) {
      const mine = sites.filter((s) => s.value === list.dataset.list);
      list.querySelector('.rows').innerHTML = mine.length ? mine.map((s) => `<div class="row site" data-origin="${esc(s.origin)}">
          <span class="ic">${siteIcon('allSites')}</span>
          <a class="grow title" href="/content/siteDetails?site=${encodeURIComponent(s.origin)}">${esc(hostOf(s.origin))}</a>
          ${c.exceptions.length > 1 ? `<select class="field small" aria-label="Setting for ${esc(hostOf(s.origin))}">${c.exceptions.map((v) => `<option value="${v}" ${v === s.value ? 'selected' : ''}>${valueWord(c.id, v)}</option>`).join('')}</select>` : ''}
          <button class="btn ghost icon" data-remove aria-label="Remove ${esc(hostOf(s.origin))}" title="Remove">${siteIcon('trash', { size: 15 })}</button></div>`).join('')
        : '<div class="row"><div class="desc">No sites added</div></div>';
    }
  };
  renderLists(data.sites);
  const reload = async () => renderLists((await page.invoke('page:site-category', id)).sites);
  view.addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      const form = add.closest('.list').querySelector('.add-form');
      form.hidden = false;
      form.site.value = '';
      form.site.focus();
      return;
    }
    if (e.target.closest('[data-cancel]')) { const form = e.target.closest('.add-form'); form.hidden = true; form.previousElementSibling.querySelector('[data-add]').focus(); return; }
    const remove = e.target.closest('[data-remove]');
    if (remove) { await page.invoke('page:site-set', remove.closest('.site').dataset.origin, id, 'default'); reload(); }
  });
  view.addEventListener('change', async (e) => {
    const sel = e.target.closest('.site select');
    if (sel) { await page.invoke('page:site-set', sel.closest('.site').dataset.origin, id, sel.value); reload(); }
  });
  view.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const value = form.closest('.list').dataset.list;
    const ok = await page.invoke('page:site-set', form.site.value, id, value);
    if (!ok) { form.site.setCustomValidity('Enter a site, like example.com'); form.site.reportValidity(); return; }
    form.hidden = true;
    reload();
  });
  view.addEventListener('input', (e) => { if (e.target.name === 'site') e.target.setCustomValidity(''); });
  view.addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.target.closest('.add-form')) e.target.closest('.add-form').querySelector('[data-cancel]').click(); });
}

// ---------------------------------------------------------------- all sites
async function allSites() {
  header({ title: 'All sites', crumb: 'Site settings', back: '/content' });
  view.innerHTML = `
    <div class="toolbar">
      <input class="field" type="search" id="filter" placeholder="Search sites" aria-label="Search sites" spellcheck="false" />
      <select class="field" id="sort" aria-label="Sort by"><option value="data">Most data stored</option><option value="name">Name</option></select>
      <button class="btn danger" id="delete-all">Delete all data</button>
    </div>
    <div class="card" id="sites"><div class="row"><div class="desc">Looking at what sites keep on this computer…</div></div></div>
    <p class="hint foot">Storage counts databases, offline files and service workers. Cookies are counted separately.</p>`;
  let sites = [];
  const render = () => {
    const q = $('#filter').value.trim().toLowerCase();
    const list = sites.filter((s) => !q || s.site.includes(q) || s.origins.some((o) => o.origin.includes(q)))
      .sort($('#sort').value === 'name' ? (a, b) => a.site.localeCompare(b.site) : (a, b) => b.usage - a.usage || b.cookies - a.cookies || a.site.localeCompare(b.site));
    $('#sites').innerHTML = list.length ? list.map((s) => {
      const bits = [s.usage ? size(s.usage) : '', s.cookies ? plural(s.cookies, 'cookie') : '', s.settings ? 'Own settings' : ''].filter(Boolean).join(' · ') || 'No data stored';
      const hosts = s.origins.length > 1 ? `<div class="origins">${s.origins.map((o) => esc(hostOf(o.origin))).join(', ')}</div>` : '';
      return `<div class="row site" data-site="${esc(s.site)}">
        <span class="ic">${siteIcon('allSites')}</span>
        <div class="grow"><a class="title" href="/content/siteDetails?site=${encodeURIComponent(s.origins[0].origin)}">${esc(s.site)}</a><div class="desc">${esc(bits)}</div>${hosts}</div>
        <button class="btn ghost icon" data-delete aria-label="Delete data for ${esc(s.site)}" title="Delete data">${siteIcon('trash', { size: 15 })}</button></div>`;
    }).join('') : `<div class="row"><div class="desc">${q ? 'No sites match' : 'Sites you visit that save data show up here'}</div></div>`;
  };
  const load = async () => { sites = await page.invoke('page:site-all') || []; render(); done(); };
  $('#filter').addEventListener('input', render);
  $('#sort').addEventListener('change', render);
  $('#sites').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-delete]');
    if (!del) return;
    const site = del.closest('.site').dataset.site;
    if (!await confirmDelete({ title: `Delete data for ${site}?`, text: `This deletes the cookies and data ${site} and its pages keep on this computer, and resets its permissions. You’ll be signed out of it.` })) return;
    await page.invoke('page:site-delete', site, { permissions: true });
    load();
  });
  $('#delete-all').addEventListener('click', async () => {
    if (!await confirmDelete({ title: 'Delete all site data?', text: 'This deletes the cookies and data every site keeps on this computer. You’ll be signed out of websites. Site permissions stay as they are.', ok: 'Delete all' })) return;
    await page.invoke('page:site-delete-all');
    load();
  });
  await load();
}

// ---------------------------------------------------------------- one site
async function siteDetails(origin) {
  const d = await page.invoke('page:site-details', origin);
  if (!d) { location.replace('/content/all'); return; }
  header({ title: d.host, crumb: 'All sites', back: '/content/all' });
  const usage = [d.usage ? size(d.usage) : '', plural(d.cookies, 'cookie')].filter(Boolean).join(' · ');
  const rows = d.settings.map((s) => `<label class="row setting">
      <span class="ic">${siteIcon(s.id)}</span><div class="grow title">${esc(s.label)}</div>
      <select class="field small" data-id="${s.id}" aria-label="${esc(s.label)}">
        <option value="default" ${s.value ? '' : 'selected'}>${valueWord(s.id, s.default)} (default)</option>
        ${s.exceptions.map((v) => `<option value="${v}" ${s.value === v ? 'selected' : ''}>${valueWord(s.id, v)}</option>`).join('')}
      </select></label>`).join('');
  view.innerHTML = `
    <p class="lead">${esc(d.origin)}</p>
    <h3>Usage</h3>
    <div class="card"><div class="row"><span class="ic">${siteIcon('siteData')}</span><div class="grow"><div class="title" id="usage">${esc(usage)}</div><div class="desc">Cookies count for all of ${esc(d.site)}.</div></div>
      <button class="btn danger" id="delete">Delete data</button></div></div>
    <h3>Permissions</h3>
    <div class="card"><div class="row"><div class="grow desc">Changes apply the next time the site’s pages load.</div><button class="btn" id="reset">Reset permissions</button></div>${rows}</div>`;
  view.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-id]');
    if (sel) page.invoke('page:site-set', d.origin, sel.dataset.id, sel.value);
  });
  $('#reset').addEventListener('click', async () => {
    if (!await confirmDelete({ title: `Reset permissions for ${d.host}?`, text: 'Every setting for this site goes back to the default.', ok: 'Reset' })) return;
    await page.invoke('page:site-reset', d.origin);
    view.querySelectorAll('select[data-id]').forEach((sel) => { sel.value = 'default'; });
  });
  $('#delete').addEventListener('click', async () => {
    if (!await confirmDelete({ title: `Delete data for ${d.site}?`, text: `This deletes the cookies and data ${d.site} keeps on this computer. You’ll be signed out of it.` })) return;
    await page.invoke('page:site-delete', d.site);
    $('#usage').textContent = 'No data stored';
  });
}

// ---------------------------------------------------------------- route
// The page's accent follows the profile's theme color, like Settings.
page.invoke('page:settings').then((s) => s && setAccent(document.documentElement, accentFor(s.profile?.theme))).catch(() => {});
const parts = location.pathname.split('/').filter(Boolean);
const route = parts[0] === 'cookies' ? category('thirdPartyCookies')
  : !parts[1] ? home()
    : parts[1] === 'all' ? allSites()
      : parts[1] === 'siteDetails' ? siteDetails(new URLSearchParams(location.search).get('site') || '')
        : category(parts[1]);
route.then(done, (err) => { view.innerHTML = `<div class="card"><div class="row"><div class="desc err">${esc(err?.message || 'Couldn’t load this page.')}</div></div></div>`; done(); });
