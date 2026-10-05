// Settings' rows for main/power-user.js: Keyboard (shortcuts, caret
// browsing), Appearance › Force dark mode, and Privacy and security ›
// Protocol handlers.
const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let st = await page.invoke('page:power-state');

function render() {
  if (!st) return;
  $('#caret-browsing').checked = st.caretBrowsing;
  $('#vertical-tabs').checked = st.verticalTabs; // settings.js handles its changes
  $('#caret-key-note').textContent = st.caretKey ? ` Press ${st.caretKey} to turn it on or off.` : '';
  $('#force-dark').checked = st.forceDark.on;
  // The switch only takes effect when Lumio starts.
  $('#fd-relaunch').hidden = st.forceDark.on === st.forceDark.active;
  // While it's in effect Lumio is dark, whatever Theme says (main/theme.js).
  $('#theme-forced').hidden = !st.forceDark.active;
  document.querySelectorAll('input[name=appearance]').forEach((r) => { r.disabled = st.forceDark.active; });
  renderHandlers();
}

function renderHandlers() {
  const list = [...st.protocolHandlers].sort((a, b) => b.allowed - a.allowed || a.host.localeCompare(b.host));
  $('#handler-list').innerHTML = list.length
    ? list.map((h) => `
      <div class="row" data-scheme="${esc(h.scheme)}" data-origin="${esc(h.origin)}">
        <div class="grow"><div class="title">${esc(h.host)}</div>
          <div class="desc">${h.allowed ? `Opens all ${esc(h.what)}` : `<b style="color:var(--danger-text)">Blocked</b> from opening ${esc(h.what)}`}</div></div>
        <button class="btn" type="button" data-remove aria-label="Remove ${esc(h.host)} for ${esc(h.what)}">Remove</button>
      </div>`).join('')
    : '<div class="row"><div class="desc">When a site like Gmail asks to open all email links, it shows up here.</div></div>';
}

const set = async (key, value) => { st = await page.invoke('page:power-set', key, value); render(); };
$('#caret-browsing').addEventListener('change', (e) => set('caretBrowsing', e.target.checked));
$('#force-dark').addEventListener('change', (e) => set('forceDarkPages', e.target.checked));
$('#fd-relaunch-btn').addEventListener('click', () => page.invoke('page:relaunch'));

$('#handler-list').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-remove]')?.closest('.row');
  if (!row) return;
  const rows = [...$('#handler-list').querySelectorAll('[data-remove]')];
  const at = rows.indexOf(row.querySelector('[data-remove]'));
  st = await page.invoke('page:protocol-handler-remove', row.dataset.scheme, row.dataset.origin);
  render();
  // The keyboard stays in the list: on the next Remove, or the one before.
  const left = [...$('#handler-list').querySelectorAll('[data-remove]')];
  (left[at] || left[at - 1])?.focus();
});

// F7 or another window may have changed something.
window.addEventListener('focus', async () => { st = await page.invoke('page:power-state'); render(); });

render();
