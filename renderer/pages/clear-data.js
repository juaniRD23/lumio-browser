// Delete browsing data (lumio://settings/clearBrowserData, ⇧⌘⌫): Basic and
// Advanced choices, a time range, and how much each choice covers. The work
// happens in main/browsing-data.js.
import '/keys.js';

const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const size = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : (n / 1e6).toFixed(1) + ' MB');
const count = (n, one, many = one + 's') => (n ? `${n} ${n === 1 ? one : many}` : 'None');

// note(counts, range): the line under each choice.
const ITEMS = {
  history: { title: 'Browsing history', note: (c) => count(c.history, 'item') },
  downloads: { title: 'Download history', note: (c) => `${count(c.downloads, 'item')} · The files stay on this computer` },
  cookies: { title: 'Cookies and other site data', note: (c) => `${c.cookieSites ? `From ${count(c.cookieSites, 'site')}` : 'None'} · Signs you out of most sites` },
  cache: { title: 'Cached images and files', note: (c, range) => `${c.cacheBytes < 1e6 ? 'Less than 1 MB' : `Frees up ${size(c.cacheBytes)}`}${range ? ' · Always all time' : ''}` },
  passwords: { title: 'Passwords and passkeys', note: (c) => (c.passwords ? `${c.passwords} saved` : 'None') },
  autofill: { title: 'Autofill form data', note: () => 'Lumio doesn’t save what you type in forms', off: true },
  siteSettings: { title: 'Site settings', note: (c) => count(c.siteSettings, 'site') },
  hosted: { title: 'Hosted app data', note: () => 'Lumio doesn’t install web apps', off: true },
  chats: { title: 'Lumio chats', note: (c) => count(c.chats, 'chat') },
  closed: { title: 'Recently closed tabs', note: (c) => count(c.closed, 'tab or window', 'tabs and windows') },
};
const TABS = {
  basic: { items: ['history', 'cookies', 'cache'], checked: ['history', 'cookies', 'cache'] },
  advanced: { items: ['history', 'downloads', 'cookies', 'cache', 'passwords', 'autofill', 'siteSettings', 'hosted', 'chats', 'closed'], checked: ['history', 'downloads', 'cookies', 'cache'] },
};

// The last choices, remembered on this computer like Chrome does.
const saved = (() => { try { return JSON.parse(localStorage.getItem('clear-data') || '{}'); } catch { return {}; } })();
const state = {
  tab: TABS[saved.tab] ? saved.tab : 'basic',
  checked: { basic: new Set(saved.basic || TABS.basic.checked), advanced: new Set(saved.advanced || TABS.advanced.checked) },
};
if (saved.range != null && [...$('#range').options].some((o) => o.value === String(saved.range))) $('#range').value = String(saved.range);
const range = () => Number($('#range').value);
const remember = () => { try { localStorage.setItem('clear-data', JSON.stringify({ tab: state.tab, range: range(), basic: [...state.checked.basic], advanced: [...state.checked.advanced] })); } catch { /* not kept */ } };

let counts = null;
function render() {
  const tab = TABS[state.tab];
  for (const b of document.querySelectorAll('[role=tab]')) {
    const on = b.dataset.tab === state.tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('#cd-panel').setAttribute('aria-labelledby', `tab-${state.tab}`);
  $('#cd-list').innerHTML = tab.items.map((id) => {
    const it = ITEMS[id];
    const checked = !it.off && state.checked[state.tab].has(id);
    return `<label class="cd-item${it.off ? ' off' : ''}"><input type="checkbox" value="${id}" ${checked ? 'checked' : ''} ${it.off ? 'disabled' : ''} aria-describedby="note-${id}">
      <span><b>${it.title}</b><small id="note-${id}">${counts || it.off ? it.note(counts, range()) : '…'}</small></span></label>`;
  }).join('');
  $('#go').disabled = !state.checked[state.tab].size || [...state.checked[state.tab]].every((id) => ITEMS[id].off);
}

let countSeq = 0;
async function refreshCounts() {
  const seq = ++countSeq;
  counts = null;
  render();
  const c = await page.invoke('page:clear-data-counts', range()).catch(() => null);
  if (seq !== countSeq) return;
  counts = c || { history: 0, downloads: 0, cookieSites: 0, cacheBytes: 0, passwords: 0, siteSettings: 0, chats: 0, closed: 0 };
  render();
}

function leave() {
  if (history.length > 1) history.back();
  else page.invoke('page:navigate', 'lumio://settings/#privacy');
}

// Tabs: click, or the arrow keys between them.
document.querySelector('.cd-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[role=tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  remember();
  render();
});
document.querySelector('.cd-tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  state.tab = e.key === 'Home' ? 'basic' : e.key === 'End' ? 'advanced' : state.tab === 'basic' ? 'advanced' : 'basic';
  remember();
  render();
  $(`#tab-${state.tab}`).focus();
});
$('#cd-list').addEventListener('change', (e) => {
  const box = e.target.closest('input[type=checkbox]');
  if (!box) return;
  if (box.checked) state.checked[state.tab].add(box.value); else state.checked[state.tab].delete(box.value);
  remember();
  render();
});
$('#range').addEventListener('change', () => { remember(); refreshCounts(); });
$('#cancel').addEventListener('click', leave);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) leave(); });

$('#go').addEventListener('click', async () => {
  const what = [...state.checked[state.tab]].filter((id) => !ITEMS[id].off);
  if (!what.length) return;
  $('#go').disabled = true;
  $('#cancel').disabled = true;
  $('#go').textContent = 'Deleting…';
  $('#cd-status').textContent = '';
  try {
    await page.invoke('page:clear-data', { range: range(), what });
    $('#cd-status').textContent = 'Deleted.';
    leave();
  } catch {
    $('#cd-status').textContent = 'Something went wrong. Try again.';
    $('#go').textContent = 'Delete data';
    $('#go').disabled = false;
    $('#cancel').disabled = false;
  }
});

render();
$(`#tab-${state.tab}`).focus();
refreshCounts();
