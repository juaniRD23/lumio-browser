import './keys.js';
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EYE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';

let state = await page.invoke('page:passwords');
let selected = null; // entry id, or 'new'
let revealed = null; // { id, password, note } after confirming it's you
let editing = false;
let filter = null; // 'compromised' | 'weak' | 'reused' | null
// Password Checkup (main/password-checkup.js): counts, and each password's
// result by id (true: in a data breach). Only checked when asked.
let checkup = await page.invoke('page:password-checkup').catch(() => null);
let checking = false;
const compromised = (e) => checkup?.flags?.[e.id] === true;
const flagged = (e, f) => (f === 'compromised' ? compromised(e) : e[f]);

$('#vault-name').textContent = state.platform === 'darwin' ? 'macOS Keychain' : state.platform === 'win32' ? 'Windows account' : 'system keychain';

function msg(text, bad = false) {
  $('#msg-row').hidden = !text;
  $('#msg').textContent = text || '';
  $('#msg').classList.toggle('err', bad);
}

function icon(origin) {
  return `<img src="${esc(origin)}/favicon.ico" alt="" loading="lazy">`;
}
function fixIcons(root) {
  root.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => { img.outerHTML = '<span class="dot"></span>'; }));
}

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const list = state.entries.filter((e) => (!q || e.site.toLowerCase().includes(q) || e.username.toLowerCase().includes(q))
    && (!filter || flagged(e, filter)));
  $('#unavailable').hidden = state.available;
  const weak = state.entries.filter((e) => e.weak).length;
  const reused = state.entries.filter((e) => e.reused).length;
  const bad = state.entries.filter(compromised).length;
  const checked = checkup?.checked ? `Checked ${new Date(checkup.checked).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : 'Not checked for data breaches yet';
  $('#checkup').hidden = !state.entries.length;
  $('#checkup').innerHTML = `<span class="note" style="margin:0">Checkup:</span>
    ${bad ? `<button data-filter="compromised" class="bad ${filter === 'compromised' ? 'on' : ''}">${bad} compromised</button>` : ''}
    ${reused ? `<button data-filter="reused" class="${filter === 'reused' ? 'on' : ''}">${reused} reused</button>` : ''}
    ${weak ? `<button data-filter="weak" class="${filter === 'weak' ? 'on' : ''}">${weak} weak</button>` : ''}
    ${filter ? '<button data-filter="">Show all</button>' : ''}
    <span class="grow"></span>
    <span class="note checkup-status" aria-live="polite">${checking ? 'Checking…' : esc(checkup?.error || checked)}</span>
    <button class="check-btn" data-check ${checking ? 'disabled' : ''} title="Checks your passwords against known data breaches. Only the first 5 characters of each password’s hash leave this computer.">Check passwords</button>`;
  if (!state.entries.length) {
    $('#list').innerHTML = '<div class="placeholder">No saved passwords yet.<br>Lumio offers to save them when you sign in, or you can import a CSV below.</div>';
    return;
  }
  $('#list').innerHTML = list.length ? list.map((e) => `
    <button class="pw-item ${selected === e.id ? 'sel' : ''}" data-id="${esc(e.id)}" role="listitem">
      ${icon(e.origin)}
      <span class="meta"><span class="site" style="display:block">${esc(e.site)}</span><span class="user" style="display:block">${esc(e.username || '(no username)')}</span></span>
      ${compromised(e) ? '<span class="flag compromised">Compromised</span>' : ''}${e.reused ? '<span class="flag reused">Reused</span>' : ''}${e.weak ? '<span class="flag weak">Weak</span>' : ''}
    </button>`).join('') : '<div class="placeholder">No passwords match.</div>';
  fixIcons($('#list'));
}

function renderDetail() {
  const d = $('#detail');
  if (selected === 'new') {
    d.innerHTML = `<h3 style="margin-bottom:14px">Add password</h3>
      <label class="kv"><span>Site</span><input class="field" id="f-site" placeholder="https://example.com" spellcheck="false"></label>
      <label class="kv"><span>Username</span><input class="field" id="f-user" spellcheck="false" autocomplete="off"></label>
      <label class="kv"><span>Password</span><span class="val"><input class="field" id="f-pass" type="text" spellcheck="false" autocomplete="off"><button class="btn small" data-act="generate">Generate</button></span></label>
      <label class="kv"><span>Note</span><textarea class="field" id="f-note"></textarea></label>
      <div class="note err" id="f-err" hidden></div>
      <div class="actions"><button class="btn small primary" data-act="create">Save</button><button class="btn small ghost" data-act="cancel">Cancel</button></div>`;
    $('#f-site').focus();
    return;
  }
  const e = state.entries.find((x) => x.id === selected);
  if (!e) { d.innerHTML = '<div class="placeholder">Select a password to see it.</div>'; return; }
  const shown = revealed?.id === e.id;
  if (editing && shown) {
    d.innerHTML = `<div class="head"><span class="big-ico">${icon(e.origin)}</span><h3>${esc(e.site)}</h3></div>
      <label class="kv"><span>Username</span><input class="field" id="e-user" value="${esc(e.username)}" spellcheck="false" autocomplete="off"></label>
      <label class="kv"><span>Password</span><span class="val"><input class="field" id="e-pass" type="text" value="${esc(revealed.password)}" spellcheck="false" autocomplete="off"><button class="btn small" data-act="generate">Generate</button></span></label>
      <label class="kv"><span>Note</span><textarea class="field" id="e-note">${esc(revealed.note || '')}</textarea></label>
      <div class="actions"><button class="btn small primary" data-act="save">Save</button><button class="btn small ghost" data-act="cancel-edit">Cancel</button></div>`;
    fixIcons(d);
    return;
  }
  const used = e.lastUsed ? new Date(e.lastUsed).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Never';
  d.innerHTML = `<div class="head"><span class="big-ico">${icon(e.origin)}</span><h3><a href="${esc(e.origin)}">${esc(e.site)}</a></h3></div>
    <div class="kv"><span>Username</span><span class="val"><span class="text">${esc(e.username || '(no username)')}</span><button class="btn small" data-act="copy-user">Copy</button></span></div>
    <div class="kv"><span>Password</span><span class="val"><span class="text mono">${shown ? esc(revealed.password) : '••••••••••••'}</span><button class="iconbtn" data-act="${shown ? 'hide' : 'reveal'}" title="${shown ? 'Hide' : 'Show'}">${EYE}</button><button class="btn small" data-act="copy">Copy</button></span></div>
    ${shown && revealed.note ? `<div class="kv"><span>Note</span><span class="text" style="white-space:pre-wrap">${esc(revealed.note)}</span></div>` : ''}
    ${compromised(e) ? `<p class="note err" style="margin:4px 0 0">This password appeared in a data breach. Change it now, on the site and here. <a href="${esc(e.origin)}/.well-known/change-password">Change password</a></p>` : ''}
    ${e.weak || e.reused ? `<p class="note err" style="margin:4px 0 0">${e.reused ? 'This password is used on other sites too. ' : ''}${e.weak ? 'This password is weak. ' : ''}Change it on the site, then update it here.</p>` : ''}
    <p class="note" style="margin:10px 0 0">Last used: ${esc(used)}</p>
    <div class="actions"><button class="btn small" data-act="edit">Edit</button><button class="btn small danger" data-act="delete">Delete</button></div>`;
  fixIcons(d);
}

async function reload() {
  state = await page.invoke('page:passwords');
  checkup = await page.invoke('page:password-checkup').catch(() => checkup); // a changed password isn't flagged anymore
  renderList();
  renderDetail();
  renderPasskeys();
}

$('#list').addEventListener('click', (e) => {
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (!id) return;
  selected = id;
  editing = false;
  if (revealed?.id !== id) revealed = null;
  renderList();
  renderDetail();
});
$('#checkup').addEventListener('click', async (e) => {
  if (e.target.closest('[data-check]')) {
    checking = true;
    renderList();
    checkup = await page.invoke('page:password-checkup-run').catch(() => ({ ...checkup, error: 'Couldn’t check your passwords. Try again later.' }));
    checking = false;
    if (checkup?.compromised) filter = 'compromised';
    renderList();
    renderDetail();
    $('#checkup [data-check]')?.focus();
    return;
  }
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  filter = b.dataset.filter || null;
  renderList();
});
$('#search').addEventListener('input', renderList);
$('#add').addEventListener('click', () => { selected = 'new'; editing = false; renderList(); renderDetail(); });

$('#detail').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const entry = state.entries.find((x) => x.id === selected);
  if (act === 'generate') {
    const pw = await page.invoke('page:password-generate');
    ($('#f-pass') || $('#e-pass')).value = pw;
  } else if (act === 'cancel') { selected = null; renderDetail(); renderList(); }
  else if (act === 'create') {
    const res = await page.invoke('page:password-add', { origin: $('#f-site').value.trim().replace(/^(?!https?:\/\/)/, 'https://'), username: $('#f-user').value, password: $('#f-pass').value, note: $('#f-note').value || undefined });
    if (!res.ok) { $('#f-err').hidden = false; $('#f-err').textContent = res.error; return; }
    selected = res.id;
    await reload();
  } else if (act === 'reveal' || act === 'edit') {
    const res = await page.invoke('page:password-reveal', entry.id);
    if (!res.ok) return;
    revealed = { id: entry.id, password: res.password, note: res.note };
    editing = act === 'edit';
    renderDetail();
  } else if (act === 'hide') { revealed = null; renderDetail(); }
  else if (act === 'cancel-edit') { editing = false; renderDetail(); }
  else if (act === 'copy') {
    const res = await page.invoke('page:password-copy', entry.id);
    if (res.ok) { e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1500); }
  } else if (act === 'copy-user') {
    await navigator.clipboard.writeText(entry.username).catch(() => {});
    e.target.textContent = 'Copied';
    setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
  } else if (act === 'save') {
    const res = await page.invoke('page:password-edit', entry.id, { username: $('#e-user').value, password: $('#e-pass').value, note: $('#e-note').value });
    if (!res.ok) return;
    revealed = { id: entry.id, password: $('#e-pass').value, note: $('#e-note').value };
    editing = false;
    await reload();
  } else if (act === 'delete') {
    if (!confirm(`Delete the saved password for ${entry.username || entry.site}?`)) return;
    await page.invoke('page:password-delete', entry.id);
    selected = null;
    revealed = null;
    await reload();
  }
});

// ---- settings, import/export, never-saved ----
$('#offer').checked = state.offer;
$('#autofill').checked = state.autofill;
$('#offer').addEventListener('change', (e) => page.invoke('page:set-setting', 'offerPasswords', e.target.checked));
$('#autofill').addEventListener('change', (e) => page.invoke('page:set-setting', 'autofillPasswords', e.target.checked));
$('#import').addEventListener('click', async () => {
  const res = await page.invoke('page:passwords-import');
  if (res.canceled) return;
  if (!res.ok) { msg(res.error, true); return; }
  msg(`Imported ${res.added} new and updated ${res.updated} password${res.updated === 1 ? '' : 's'}${res.skipped ? ` · skipped ${res.skipped}` : ''}.`);
  await reload();
});
$('#export').addEventListener('click', async () => {
  const res = await page.invoke('page:passwords-export');
  if (res.ok) msg(`Exported ${res.count} password${res.count === 1 ? '' : 's'}. Delete the file when you’re done with it.`);
});

function renderNever() {
  const never = state.never;
  $('#never-title').hidden = !never.length;
  $('#never').hidden = !never.length;
  $('#never').innerHTML = never.map((site) => `<div class="row"><div class="grow"><div class="title">${esc(site.replace(/^https?:\/\//, ''))}</div></div><button class="btn small" data-site="${esc(site)}">Remove</button></div>`).join('');
}
// Passkeys Lumio made for sites (it's the authenticator).
function renderPasskeys() {
  const keys = state.passkeys || [];
  $('#passkeys-title').hidden = !keys.length;
  $('#passkeys').hidden = !keys.length;
  const date = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  $('#passkeys').innerHTML = keys.map((k) => `<div class="row"><div class="grow"><div class="title">${esc(k.rpId)}</div><div class="desc">${esc(k.userName || k.displayName || 'Account')} · created ${esc(date(k.created))}${k.lastUsed && k.lastUsed !== k.created ? ` · last used ${esc(date(k.lastUsed))}` : ''}</div></div><button class="btn small danger" data-passkey="${esc(k.id)}">Delete</button></div>`).join('');
}
$('#passkeys').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-passkey]')?.dataset.passkey;
  if (!id) return;
  const k = (state.passkeys || []).find((x) => x.id === id);
  if (!confirm(`Delete the passkey for ${k?.rpId || 'this site'}? You’ll need another way to sign in there, and the site may still list it until you remove it in its settings.`)) return;
  const ok = await page.invoke('page:passkey-delete', id);
  if (!ok) msg('Couldn’t delete that passkey.', true);
  state = await page.invoke('page:passwords');
  renderPasskeys();
});

$('#never').addEventListener('click', async (e) => {
  const site = e.target.closest('[data-site]')?.dataset.site;
  if (!site) return;
  await page.invoke('page:password-never-remove', site);
  state = await page.invoke('page:passwords');
  renderNever();
});

renderList();
renderDetail();
renderPasskeys();
renderNever();
