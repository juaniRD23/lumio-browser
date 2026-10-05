import './keys.js';
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PUZZLE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M9 4.5a2 2 0 0 1 4 0V6h4a1 1 0 0 1 1 1v4h-1.5a2 2 0 0 0 0 4H18v4a1 1 0 0 1-1 1h-4v-1.5a2 2 0 0 0-4 0V20H5a1 1 0 0 1-1-1v-4h1.5a2 2 0 0 0 0-4H4V7a1 1 0 0 1 1-1h4z"/></svg>';

let state = { available: false, developerMode: false, items: [] };

function msg(text) {
  $('#msg').hidden = !text;
  $('#msg').textContent = text || '';
}

function render() {
  $('#dev').checked = state.developerMode;
  $('#devbar').hidden = !state.developerMode;
  if (!state.available) {
    $('#grid').innerHTML = '<div class="hero-empty" style="grid-column:1/-1"><h3>Extensions couldn’t start</h3>Restart Lumio Browser and try again.</div>';
    return;
  }
  if (!state.items.length) {
    $('#grid').innerHTML = `<div class="hero-empty" style="grid-column:1/-1"><h3>No extensions yet</h3>Find ad blockers, password managers, dark mode and more in the Chrome Web Store.<br><br><button class="btn primary" data-store>Open Chrome Web Store</button></div>`;
    return;
  }
  $('#grid').innerHTML = state.items.map((x) => `
    <div class="ext ${x.enabled ? '' : 'off'}" data-key="${esc(x.key)}" data-id="${esc(x.id || '')}">
      <div class="head">
        <span class="icon">${x.icon ? `<img src="${esc(x.icon)}" alt="">` : PUZZLE}</span>
        <div class="meta"><div class="name">${esc(x.name)}<span class="ver">${esc(x.version)}</span></div>
          <div class="desc">${esc(x.description || '')}</div>
          ${x.error ? `<div class="err">${esc(x.error)}</div>` : ''}
        </div>
      </div>
      <div class="foot">
        ${x.type === 'unpacked' ? '<span class="tag" title="' + esc(x.path) + '">Unpacked</span>' : ''}
        ${x.options && x.enabled && x.id ? `<button class="btn small ghost" data-act="options" data-page="${esc(x.options)}">Options</button>` : ''}
        ${x.type === 'unpacked' ? '<button class="btn small ghost" data-act="reload">Reload</button>' : ''}
        <button class="btn small ghost danger" data-act="remove">Remove</button>
        <span class="grow"></span>
        <label class="switch" title="${x.enabled ? 'Turn off' : 'Turn on'}"><input type="checkbox" data-act="toggle" ${x.enabled ? 'checked' : ''}><i></i></label>
      </div>
    </div>`).join('');
}

async function load() {
  state = await page.invoke('page:extensions');
  render();
}

$('#grid').addEventListener('click', async (e) => {
  if (e.target.closest('[data-store]')) { page.invoke('page:open-webstore'); return; }
  const card = e.target.closest('.ext');
  const act = e.target.closest('button[data-act]')?.dataset.act;
  if (!card || !act) return;
  const key = card.dataset.key;
  const item = state.items.find((x) => x.key === key);
  if (act === 'options') page.invoke('page:extension-options', card.dataset.id, e.target.closest('[data-page]').dataset.page);
  if (act === 'reload') { await page.invoke('page:extension-reload', key); msg(`Reloaded ${item?.name || 'extension'}.`); load(); }
  if (act === 'remove') { if (await page.invoke('page:extension-remove', key, item?.name)) load(); }
});
$('#grid').addEventListener('change', async (e) => {
  const input = e.target.closest('input[data-act="toggle"]');
  if (!input) return;
  await page.invoke('page:extension-toggle', input.closest('.ext').dataset.key, input.checked);
  load();
});
$('#dev').addEventListener('change', async (e) => {
  await page.invoke('page:set-developer-mode', e.target.checked);
  state.developerMode = e.target.checked;
  render();
});
$('#load').addEventListener('click', async () => {
  const res = await page.invoke('page:extension-load-unpacked');
  if (res?.ok) { msg('Extension loaded.'); load(); } else if (res && !res.canceled) msg(res.error || 'Could not load that folder.');
});
$('#store').addEventListener('click', () => page.invoke('page:open-webstore'));
window.addEventListener('focus', load);

await load();
