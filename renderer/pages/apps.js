// lumio://apps: the sites installed as apps (main/apps.js), with Open,
// Show in Finder (the Mac's launcher) and Remove.
import './keys.js';
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAC = /Mac/.test(navigator.platform);
const APP = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>';

let items = [];

function row(a) {
  const how = a.window ? 'Opens in its own window' : 'Opens in a tab';
  const when = new Date(a.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `<div class="app" role="listitem" data-id="${esc(a.id)}">
    <span class="app-icon">${a.icon ? `<img src="${esc(a.icon)}" alt="">` : APP}</span>
    <div class="meta">
      <div class="name">${esc(a.name)}</div>
      <div class="sub">${esc(a.host)} · ${esc(how)} · Added ${esc(when)}</div>
    </div>
    <div class="acts">
      <button class="btn small primary" data-act="open" aria-label="Open ${esc(a.name)}">Open</button>
      ${MAC && a.launcher ? `<button class="btn small" data-act="reveal" aria-label="Show ${esc(a.name)} in Finder">Show in Finder</button>` : ''}
      <button class="btn small danger" data-act="remove" aria-label="Remove ${esc(a.name)}">Remove</button>
    </div>
  </div>`;
}

function render() {
  $('#list').innerHTML = items.length ? items.map(row).join('')
    : '<div class="hero-empty"><h3>No apps yet</h3>Open a site you use every day, then choose Share › Install page as app.</div>';
}

async function load() {
  items = (await page.invoke('page:apps')) || [];
  render();
}

function say(text) { $('#msg').textContent = text; }

$('#list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  const id = btn?.closest('.app')?.dataset.id;
  if (!id) return;
  const app = items.find((a) => a.id === id);
  if (btn.dataset.act === 'open') page.invoke('page:app-open', id);
  else if (btn.dataset.act === 'reveal') page.invoke('page:app-reveal', id);
  else if (btn.dataset.act === 'remove' && await page.invoke('page:app-remove', id)) {
    const i = items.indexOf(app);
    await load();
    say(`${app?.name || 'The app'} was removed.`);
    // The keyboard stays in the list: on the next app's Remove, or the page.
    ($('#list').querySelectorAll('[data-act="remove"]')[Math.min(i, items.length - 1)] || document.body).focus();
  }
});

await load();
// Back on this page after installing or removing an app somewhere else.
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
