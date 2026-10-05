// Settings › Appearance (Home button, Page zoom), On startup (the start pages)
// and Privacy › Zoom levels. The browser side is main/navigation.js.
const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hostOf = (url) => { try { return new URL(url).host || url; } catch { return url; } };

let nav = (await page.invoke('page:nav-settings')) || { showHome: false, homePage: '', defaultZoom: 100, presets: [100], zoomLevels: [], startup: 'restore', startupPages: [] };
const save = async (key, value) => {
  const res = await page.invoke('page:nav-set', key, value);
  if (res?.ok) nav = res;
  return res || { ok: false };
};

// ---------------------------------------------------------------- Home button
const homeShow = $('#home-show');
const homeUrl = $('#home-url');
const homeRadio = (value) => document.querySelector(`input[name=home-page][value=${value}]`);
function renderHome() {
  homeShow.checked = nav.showHome;
  $('#home-choice').hidden = !nav.showHome;
  homeRadio(nav.homePage ? 'custom' : 'newtab').checked = true;
  if (document.activeElement !== homeUrl) homeUrl.value = nav.homePage;
  $('#home-desc').textContent = !nav.showHome ? 'Next to Reload, like in Chrome.' : nav.homePage ? `Opens ${hostOf(nav.homePage)}` : 'Opens the New Tab page';
}
homeShow.addEventListener('change', async () => { await save('showHome', homeShow.checked); renderHome(); });
homeRadio('newtab').addEventListener('change', async () => { $('#home-err').textContent = ''; await save('homePage', 'newtab'); renderHome(); });
homeRadio('custom').addEventListener('change', () => homeUrl.focus());
homeUrl.addEventListener('focus', () => { homeRadio('custom').checked = true; });
async function saveHomeUrl() {
  const value = homeUrl.value.trim();
  if (!value) { $('#home-err').textContent = ''; return; }
  const res = await save('homePage', value);
  $('#home-err').textContent = res.ok ? '' : res.error || 'Enter a web address, like example.com';
  if (res.ok) { homeUrl.value = nav.homePage; renderHome(); }
}
homeUrl.addEventListener('change', saveHomeUrl); // on Enter, or leaving the box

// ---------------------------------------------------------------- page zoom
function renderZoom() {
  $('#zoom-default').innerHTML = nav.presets.map((p) => `<option value="${p}" ${p === nav.defaultZoom ? 'selected' : ''}>${p}%</option>`).join('');
  const list = nav.zoomLevels;
  $('#zoom-list').innerHTML = list.length
    ? list.map((z) => `<div class="row zoom-site"><div class="grow"><div class="title">${esc(z.host)}</div></div><span class="pill">${z.percent}%</span><button class="btn" data-zoom-remove="${esc(z.host)}" aria-label="Remove ${esc(z.host)}">Remove</button></div>`).join('')
    : '<div class="row"><div class="desc">When you zoom a site in or out, it keeps that level here. Remove it to go back to the page zoom.</div></div>';
}
$('#zoom-default').addEventListener('change', async (e) => { await save('defaultZoom', Number(e.target.value)); renderZoom(); });
$('#zoom-list').addEventListener('click', async (e) => {
  const host = e.target.closest('[data-zoom-remove]')?.dataset.zoomRemove;
  if (!host) return;
  nav = (await page.invoke('page:zoom-remove', host)) || nav;
  renderZoom();
  $('#zoom-list button')?.focus();
});

// ---------------------------------------------------------------- start pages
// Like Chrome's: a list with Edit and Remove, "Add a new page" and "Use current pages".
const box = $('#startup-pages');
let mode = nav.startup; // the On startup choice (settings.js saves it)
let editing = null; // index being edited, or 'new'
// focus: what takes the keyboard after the list is drawn again (the address box when it's open).
function renderPages(focus = null) {
  box.hidden = mode !== 'pages';
  const rows = nav.startupPages.map((p, i) => (editing === i ? formHtml(p.url) : `
    <div class="row sp-row">
      <div class="grow"><div class="title">${esc(p.title || hostOf(p.url))}</div><div class="desc">${esc(p.url)}</div></div>
      <button class="btn ghost" data-sp-edit="${i}" aria-label="Edit ${esc(p.title || p.url)}">Edit</button>
      <button class="btn ghost" data-sp-remove="${i}" aria-label="Remove ${esc(p.title || p.url)}">Remove</button>
    </div>`)).join('');
  const empty = nav.startupPages.length || editing === 'new' ? '' : '<div class="row"><div class="desc">No pages yet. Add one, or use the pages you have open now.</div></div>';
  box.innerHTML = `${rows}${empty}${editing === 'new' ? formHtml('') : ''}
    <div class="row sp-actions">
      <button class="btn" data-sp-add ${editing !== null ? 'disabled' : ''}>Add a new page</button>
      <button class="btn" data-sp-current ${editing !== null ? 'disabled' : ''}>Use current pages</button>
    </div>`;
  (box.querySelector('#sp-url') || (focus && box.querySelector(focus)))?.focus();
}
const formHtml = (url) => `
  <form class="row sp-form" data-sp-form>
    <input class="field grow" id="sp-url" value="${esc(url)}" placeholder="Site URL" aria-label="Site URL" spellcheck="false" autocomplete="off" />
    <button type="button" class="btn ghost" data-sp-cancel>Cancel</button>
    <button type="submit" class="btn primary">${editing === 'new' ? 'Add' : 'Save'}</button>
    <span class="desc err" id="sp-err" aria-live="polite"></span>
  </form>`;
async function savePages(list) {
  const res = await save('startupPages', list);
  if (!res.ok) { const err = $('#sp-err'); if (err) err.textContent = res.error || 'Enter a web address, like example.com'; return false; }
  return true;
}
box.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#sp-url').value.trim();
  if (!url) { editing = null; renderPages('[data-sp-add]'); return; }
  const list = nav.startupPages.map((p) => ({ ...p }));
  if (editing === 'new') list.push({ url, title: '' });
  else list[editing] = { url, title: list[editing].url === url ? list[editing].title : '' };
  if (await savePages(list)) { editing = null; renderPages('[data-sp-add]'); }
});
box.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.hasAttribute('data-sp-add')) { editing = 'new'; renderPages(); }
  else if (t.hasAttribute('data-sp-cancel')) { editing = null; renderPages('[data-sp-add]'); }
  else if (t.dataset.spEdit) { editing = Number(t.dataset.spEdit); renderPages(); }
  else if (t.dataset.spRemove) {
    await savePages(nav.startupPages.filter((_, i) => i !== Number(t.dataset.spRemove)));
    renderPages('[data-sp-add]');
  } else if (t.hasAttribute('data-sp-current')) {
    const res = await page.invoke('page:startup-current');
    if (res?.ok) nav = res;
    renderPages('[data-sp-current]');
  }
});
box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && editing !== null) { e.preventDefault(); editing = null; renderPages('[data-sp-add]'); } });
document.querySelectorAll('input[name=startup]').forEach((r) => r.addEventListener('change', () => { mode = r.value; renderPages(); }));

renderHome();
renderZoom();
renderPages();
