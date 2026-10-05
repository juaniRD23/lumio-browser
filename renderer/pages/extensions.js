// lumio://extensions — three views in one page:
//   /             the extensions, developer mode (load unpacked, pack, update)
//   /?id=<key>    one extension's details: site access, file access, pin, remove
//   /shortcuts    keyboard shortcuts for extension commands
import './keys.js';
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PUZZLE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M9 4.5a2 2 0 0 1 4 0V6h4a1 1 0 0 1 1 1v4h-1.5a2 2 0 0 0 0 4H18v4a1 1 0 0 1-1 1h-4v-1.5a2 2 0 0 0-4 0V20H5a1 1 0 0 1-1-1v-4h1.5a2 2 0 0 0 0-4H4V7a1 1 0 0 1 1-1h4z"/></svg>';
const IS_MAC = /Mac/.test(navigator.platform);
const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} bytes`);

let state = { available: false, developerMode: false, items: [] };
let view = 'list';

function msg(text, where = '#msg') {
  $(where).hidden = !text;
  $(where).textContent = text || '';
}

// ---------------------------------------------------------------- routing
function route() {
  const u = new URL(location.href);
  const id = u.searchParams.get('id');
  view = u.pathname.replace(/\/$/, '') === '/shortcuts' ? 'shortcuts' : id ? 'details' : 'list';
  $('#view-list').hidden = view !== 'list';
  $('#view-details').hidden = view !== 'details';
  $('#view-shortcuts').hidden = view !== 'shortcuts';
  if (view === 'details') showDetails(id);
  else if (view === 'shortcuts') showShortcuts();
  else { document.title = 'Extensions'; load(); }
}
function go(href) {
  history.pushState(null, '', href);
  route();
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', route);
document.addEventListener('click', (e) => {
  const to = e.target.closest('[data-go]');
  if (to) { e.preventDefault(); go(to.dataset.go); }
});

// ---------------------------------------------------------------- the list
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
        <button class="btn small ghost" data-act="details" aria-label="Details for ${esc(x.name)}">Details</button>
        ${x.type === 'unpacked' ? '<button class="btn small ghost" data-act="reload">Reload</button>' : ''}
        <button class="btn small ghost danger" data-act="remove" aria-label="Remove ${esc(x.name)}">Remove</button>
        <span class="grow"></span>
        <label class="switch" title="${x.enabled ? 'Turn off' : 'Turn on'}"><input type="checkbox" data-act="toggle" aria-label="${esc(x.name)} on" ${x.enabled ? 'checked' : ''}><i></i></label>
      </div>
    </div>`).join('');
}

async function load() {
  state = await page.invoke('page:extensions');
  if (view === 'list') render();
}

$('#grid').addEventListener('click', async (e) => {
  if (e.target.closest('[data-store]')) { page.invoke('page:open-webstore'); return; }
  const card = e.target.closest('.ext');
  const act = e.target.closest('button[data-act]')?.dataset.act;
  if (!card || !act) return;
  const key = card.dataset.key;
  const item = state.items.find((x) => x.key === key);
  if (act === 'details') go(`/?id=${encodeURIComponent(key)}`);
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
$('#pack').addEventListener('click', async () => {
  const res = await page.invoke('page:extension-pack');
  if (res?.ok) msg(`Packed. Extension: ${res.crx}${res.pem ? ` · Key (keep it safe, you need it for new versions): ${res.pem}` : ''}`);
  else if (res && !res.canceled) msg(res.error || 'Could not pack that folder.');
});
$('#update').addEventListener('click', async () => {
  $('#update').disabled = true;
  msg('Updating extensions…');
  await page.invoke('page:extension-update');
  $('#update').disabled = false;
  msg('Extensions are up to date.');
  load();
});
$('#store').addEventListener('click', () => page.invoke('page:open-webstore'));
$('#to-shortcuts').addEventListener('click', () => go('/shortcuts'));

// ---------------------------------------------------------------- details
let details = null;
const ACCESS = [
  ['click', 'When you click the extension', 'Its button and menu still work, but it can’t read or change sites.'],
  ['sites', 'On specific sites', 'It runs only on the sites you list.'],
  ['all', 'On all sites', 'What it asked for when you added it.'],
];

function row(title, body, extra = '') {
  return `<div class="row"><div class="grow"><div class="title">${title}</div>${body ? `<div class="desc">${body}</div>` : ''}</div>${extra}</div>`;
}
function switchHtml(id, on, { disabled = false, label } = {}) {
  return `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${esc(label)}"><i></i></label>`;
}

function renderDetails() {
  const d = details;
  const a = d.access;
  // The site list sits under "On specific sites", while that's the choice.
  const sitesHtml = `<div class="sites">
        ${a.sites.map((s) => `<div class="site"><span>${esc(s)}</span><button class="iconbtn" data-site="${esc(s)}" aria-label="Remove ${esc(s)}" title="Remove">✕</button></div>`).join('') || '<div class="note" style="margin:4px 0">No sites yet.</div>'}
        <form class="site-add" id="site-add"><input class="field" id="site-input" placeholder="example.com or *.example.com" aria-label="Add a site" spellcheck="false" autocomplete="off"><button class="btn small" type="submit">Add</button></form>
      </div>`;
  const accessHtml = !a.applies ? '<p class="note">It doesn’t ask to read or change sites.</p>' : `
    <div class="card"><div class="access" role="radiogroup" aria-label="Site access">
      ${ACCESS.map(([mode, label, desc]) => `
        <label class="opt ${a.changeable ? '' : 'disabled'}"><input type="radio" name="access" value="${mode}" ${a.mode === mode ? 'checked' : ''} ${a.changeable ? '' : 'disabled'}>
          <span><b>${label}</b><small>${desc}</small></span></label>
        ${mode === 'sites' && a.mode === 'sites' ? sitesHtml : ''}`).join('')}
    </div></div>
    ${a.changeable ? '<p class="note">Pages that are already open need a reload.</p>' : `<p class="note">${d.type === 'unpacked' ? 'Unpacked extensions keep the access their manifest asks for.' : 'This extension can’t be limited.'}</p>`}`;
  $('#view-details').innerHTML = `
    <button class="back" type="button" data-go="/" aria-label="Back to extensions"><span aria-hidden="true">‹</span> Extensions</button>
    <div class="d-head">
      <span class="d-icon">${d.icon ? `<img src="${esc(d.icon)}" alt="">` : PUZZLE}</span>
      <div class="grow"><h1>${esc(d.name)}</h1>${d.error ? `<div class="err">${esc(d.error)}</div>` : ''}</div>
      ${switchHtml('d-enabled', d.enabled, { label: `${d.name} on` })}
    </div>
    <div class="card">
      ${row('Description', esc(d.description || 'No description.'))}
      ${row('Version', esc(d.version || '—'))}
      ${row('Size', esc(size(d.size || 0)))}
      ${d.id ? row('ID', `<code>${esc(d.id)}</code>`) : ''}
      ${d.type === 'unpacked' ? row('Source', `<code>${esc(d.path)}</code>`) : ''}
    </div>
    <h2>Permissions</h2>
    <div class="card">${d.permissions.length ? `<ul class="perms">${d.permissions.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : row('It doesn’t ask for any special permissions.', '')}</div>
    ${d.limitations.length ? `<h2>May not work fully in Lumio</h2><div class="card"><ul class="perms warn">${d.limitations.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    <h2>Site access</h2>
    ${accessHtml}
    <h2>Settings</h2>
    <div class="card">
      ${d.hasAction ? row('Pin to toolbar', 'Show its button next to the address bar.', switchHtml('d-pin', d.pinned, { disabled: !d.enabled || !d.id, label: 'Pin to toolbar' })) : ''}
      ${row('Allow in Incognito', 'Lumio can’t run extensions in Incognito windows yet.', switchHtml('d-incognito', false, { disabled: true, label: 'Allow in Incognito' }))}
      ${row('Allow access to file URLs', 'Let it read pages and files you open from your computer.', switchHtml('d-files', d.fileAccess, { label: 'Allow access to file URLs' }))}
      ${d.commands.length ? row('Keyboard shortcuts', esc(d.commands.filter((c) => c.shortcut).length ? `${d.commands.filter((c) => c.shortcut).length} set` : 'None set'), '<button class="btn small" type="button" data-go="/shortcuts">Change</button>') : ''}
      ${d.options && d.enabled && d.id ? row('Extension options', '', `<button class="btn small" type="button" id="d-options">Open</button>`) : ''}
      ${d.homepage ? row(d.type === 'store' && /chromewebstore/.test(d.homepage) ? 'View in Chrome Web Store' : 'Extension website', '', `<button class="btn small" type="button" id="d-home">Open</button>`) : ''}
      ${row('Remove extension', '', `<button class="btn small danger" type="button" id="d-remove">Remove</button>`)}
    </div>`;
  document.title = d.name;
}

async function showDetails(key) {
  const d = await page.invoke('page:extension-details', key);
  if (view !== 'details') return;
  if (!d) {
    $('#view-details').innerHTML = '<button class="back" type="button" data-go="/"><span aria-hidden="true">‹</span> Extensions</button><div class="hero-empty"><h3>That extension isn’t here anymore</h3></div>';
    return;
  }
  details = d;
  renderDetails();
}
const refreshDetails = () => showDetails(details.key);

$('#view-details').addEventListener('change', async (e) => {
  if (!details) return;
  const t = e.target;
  if (t.id === 'd-enabled') { await page.invoke('page:extension-toggle', details.key, t.checked); refreshDetails(); }
  if (t.id === 'd-pin') await page.invoke('page:extension-pin', details.id, t.checked);
  if (t.id === 'd-files') { await page.invoke('page:extension-file-access', details.key, t.checked); refreshDetails(); }
  if (t.name === 'access') {
    await page.invoke('page:extension-set-access', details.key, { mode: t.value, sites: details.access.sites });
    await refreshDetails();
    document.querySelector(`input[name=access][value="${t.value}"]`)?.focus();
  }
});
$('#view-details').addEventListener('click', async (e) => {
  if (!details) return;
  const site = e.target.closest('[data-site]')?.dataset.site;
  if (site) { await page.invoke('page:extension-set-access', details.key, { mode: 'sites', sites: details.access.sites.filter((s) => s !== site) }); await refreshDetails(); $('#site-input')?.focus(); }
  if (e.target.closest('#d-options')) page.invoke('page:extension-options', details.id, details.options);
  if (e.target.closest('#d-home')) page.invoke('page:open', details.homepage, 'tab');
  if (e.target.closest('#d-remove') && await page.invoke('page:extension-remove', details.key, details.name)) go('/');
});
$('#view-details').addEventListener('submit', async (e) => {
  if (e.target.id !== 'site-add') return;
  e.preventDefault();
  const value = $('#site-input').value.trim();
  if (!value) return;
  await page.invoke('page:extension-set-access', details.key, { mode: 'sites', sites: [...details.access.sites, value] });
  await refreshDetails();
  $('#site-input')?.focus();
});

// ---------------------------------------------------------------- shortcuts
// What a key press means as a shortcut, in Chrome's words ("Command+Shift+Y").
const CODES = { Comma: 'Comma', Period: 'Period', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Space: 'Space', Insert: 'Insert', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPrevTrack', MediaPlayPause: 'MediaPlayPause', MediaStop: 'MediaStop' };
function shortcutFromEvent(e, mac = IS_MAC) {
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : CODES[e.code];
  if (!key) return null;
  const mods = [];
  if (mac) { if (e.metaKey) mods.push('Command'); if (e.ctrlKey) mods.push('MacCtrl'); } else if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

let shortcuts = { extensions: [] };
let recording = null; // the box being typed in

async function showShortcuts() {
  document.title = 'Keyboard shortcuts';
  shortcuts = await page.invoke('page:extension-shortcuts');
  if (view !== 'shortcuts') return;
  const list = shortcuts.extensions || [];
  $('#sc-list').innerHTML = !shortcuts.available ? '<div class="hero-empty"><h3>Extensions couldn’t start</h3>Restart Lumio Browser and try again.</div>'
    : !list.length ? '<div class="hero-empty"><h3>No shortcuts to set</h3>None of your extensions that are on have commands.</div>'
      : list.map((x) => `
      <h2 class="sc-name"><span class="d-icon sm">${x.icon ? `<img src="${esc(x.icon)}" alt="">` : PUZZLE}</span>${esc(x.name)}</h2>
      <div class="card">${x.commands.map((c) => `
        <div class="row">
          <div class="grow"><div class="title">${esc(c.description)}</div>${c.suggested && c.suggested !== c.shortcut ? '<div class="desc">Its suggested shortcut is turned off or changed.</div>' : ''}</div>
          <button class="sc-box ${c.shortcut ? '' : 'empty'}" type="button" data-id="${esc(x.id)}" data-name="${esc(c.name)}" aria-label="Shortcut for ${esc(c.description)}: ${esc(c.label || 'none')}">${esc(c.label || 'Not set')}</button>
          ${c.shortcut ? `<button class="iconbtn" type="button" data-clear data-id="${esc(x.id)}" data-name="${esc(c.name)}" aria-label="Clear the shortcut for ${esc(c.description)}" title="Clear">✕</button>` : '<span class="iconbtn-space"></span>'}
        </div>`).join('')}</div>`).join('');
}

async function setShortcut(box, value) {
  const res = await page.invoke('page:extension-set-shortcut', box.dataset.id, box.dataset.name, value);
  msg(res?.ok ? '' : res?.error || 'That shortcut can’t be used.', '#sc-msg');
  if (res?.ok) await showShortcuts();
  return res?.ok;
}

function startRecording(box) {
  stopRecording();
  recording = box;
  box.classList.add('recording');
  box.dataset.was = box.textContent;
  box.textContent = 'Type a shortcut';
  page.invoke('page:extension-recording', true);
}
function stopRecording() {
  if (!recording) return;
  const box = recording;
  recording = null;
  box.classList.remove('recording');
  if (box.dataset.was != null) box.textContent = box.dataset.was;
  page.invoke('page:extension-recording', false);
}

$('#sc-list').addEventListener('click', async (e) => {
  const clear = e.target.closest('[data-clear]');
  if (clear) { await setShortcut(clear, ''); return; }
  const box = e.target.closest('.sc-box');
  if (box) { if (recording === box) stopRecording(); else startRecording(box); }
});
$('#sc-list').addEventListener('focusout', (e) => { if (recording && e.target === recording) stopRecording(); });
$('#sc-list').addEventListener('keydown', async (e) => {
  const box = recording;
  if (!box || e.target !== box) return;
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return; // wait for the key itself
  if (e.key === 'Tab') { stopRecording(); return; } // moves on as usual
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { stopRecording(); return; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey) { stopRecording(); await setShortcut(box, ''); return; }
  const value = shortcutFromEvent(e);
  if (!value) { msg('Use a letter, number, arrow or a few other keys with Ctrl or Alt.', '#sc-msg'); return; }
  const { id, name } = box.dataset;
  stopRecording();
  const ok = await setShortcut(box, value);
  document.querySelector(`.sc-box[data-id="${id}"][data-name="${CSS.escape(name)}"]`)?.focus();
  if (!ok) startRecording(document.querySelector(`.sc-box[data-id="${id}"][data-name="${CSS.escape(name)}"]`));
});
window.addEventListener('blur', stopRecording);

window.addEventListener('focus', () => { if (view === 'list') load(); else if (view === 'details' && details) refreshDetails(); });

route();
