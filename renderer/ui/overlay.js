// Floating dropdowns drawn above the page: omnibox suggestions, downloads
// and the site-information popup (lock icon).
import { icons, markSvg, avatarHtml } from './icons.js';
import { setAccent } from '/assets/theme-colors.js';
import './overlay-bookmarks.js'; // the bookmarks bar's folder menus and the star's bubble
import './overlay-groups.js'; // the tab group editor

const api = window.lumio;
const card = document.getElementById('card');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pretty = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
const size = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B');

// The address bar's suggestions (main/omnibox.js makes the rows).
const ACTION_ICONS = { clearData: 'trash', passwords: 'key', settings: 'gear', incognito: 'incognito' };
const SCOPE_ICONS = { tabs: 'tabs', bookmarks: 'star', history: 'clock' };
function suggestIcon(it) {
  if (it.type === 'ai' || it.scope === 'lumio') return markSvg(15);
  if (it.type === 'answer') return '<b class="eq" aria-hidden="true">=</b>';
  if (it.type === 'action') return icons[ACTION_ICONS[it.action]] || icons.bolt;
  if (it.type === 'keyword') return icons[SCOPE_ICONS[it.scope]] || icons.search;
  return icons[{ search: 'search', bookmark: 'star', history: 'clock', tab: 'tabs', clipboard: 'copy' }[it.type]] || icons.globe;
}
function renderSuggest({ items, selected }) {
  card.setAttribute('role', 'listbox');
  card.setAttribute('aria-label', 'Suggestions');
  const hint = (text, cls = '') => `<span class="spacer" style="flex:1"></span><span class="hint ${cls}">${text}</span>`;
  card.innerHTML = items.map((it, i) => {
    const t = `<span class="t">${esc(it.title)}</span>`;
    const u = it.url ? `<span class="u">${esc(pretty(it.url))}</span>` : '';
    let body;
    if (it.type === 'ai') body = t + hint('Ask Lumio');
    else if (it.type === 'search') body = t + (it.remote ? '' : hint(esc(it.hint || 'Search')));
    else if (it.type === 'url') body = t;
    else if (it.type === 'tab') body = t + u + hint('Switch to this tab', 'pill');
    else if (it.type === 'action') body = t + hint('Action', 'pill');
    else if (it.type === 'answer') body = t + hint('Copy');
    else if (it.type === 'keyword') body = t + hint('<kbd>Tab</kbd>');
    else body = t + u;
    const rmLabel = it.type === 'clipboard' ? 'Remove' : 'Remove from history';
    const remove = it.removable || it.type === 'clipboard' ? `<button class="rm" data-rm="${i}" tabindex="-1" title="${rmLabel}" aria-label="${rmLabel}">${icons.close}</button>` : '';
    const cls = `row ${it.type}${it.remote ? ' remote' : ''}${i === selected ? ' sel' : ''}`;
    return `<div class="${cls}" data-i="${i}" role="option" aria-selected="${i === selected}"><span class="ic">${suggestIcon(it)}</span>${body}${remove}</div>`;
  }).join('');
}

function renderDownloads({ items }) {
  const rows = items.map((d) => {
    const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
    let sub;
    let actions;
    if (d.state === 'progressing') {
      sub = `${size(d.received)}${d.total ? ' of ' + size(d.total) : ''}`;
      actions = `<button data-act="cancel" data-id="${d.id}">Cancel</button>`;
    } else if (d.state === 'completed') {
      sub = size(d.total || d.received);
      actions = `<button data-act="open" data-id="${d.id}">Open</button><button data-act="show" data-id="${d.id}">Show</button>`;
    } else {
      sub = d.state === 'cancelled' ? 'Cancelled' : 'Failed';
      actions = '';
    }
    const bar = d.state === 'progressing' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : '';
    return `<div class="dl"><div class="meta"><div class="name">${esc(d.name)}</div><div class="sub">${esc(sub)}</div>${bar}</div>${actions}</div>`;
  }).join('');
  card.innerHTML = `<div class="head"><span>Downloads</span><button data-act="clear">Clear</button></div>${rows || '<div class="dl"><div class="sub">No downloads</div></div>'}<button class="all" data-act="all">See all downloads</button>`;
}

const PERM_VALUE = (v) => (v === true ? 'allow' : v === false ? 'block' : 'ask');
function renderSiteInfo({ info }) {
  const secure = info.secure
    ? `<div class="si-status ok">${icons.lock}<div><b>Connection is secure</b><span>Info you send to this site stays private.</span></div></div>`
    : `<div class="si-status bad">${icons.warn}<div><b>Not secure</b><span>Don't enter passwords or payment info on this site.</span></div></div>`;
  const perms = info.permissions.map((p) => `
    <label class="si-perm"><span>${esc(p.label)}</span>
      <select data-perm="${esc(p.permission)}">
        ${['ask', 'allow', 'block'].map((v) => `<option value="${v}" ${PERM_VALUE(p.value) === v ? 'selected' : ''}>${v === 'ask' ? 'Ask (default)' : v === 'allow' ? 'Allow' : 'Block'}</option>`).join('')}
      </select>
    </label>`).join('');
  card.innerHTML = `
    <div class="si-host">${esc(info.host)}${info.incognito ? ' <em>Incognito</em>' : ''}</div>
    ${secure}
    <div class="si-sec">Permissions</div>
    ${perms}
    <div class="si-actions">
      <button data-si="clear">Clear cookies and site data</button>
      ${info.incognito ? '' : '<button data-si="settings">Site settings</button>'}
    </div>`;
}

function renderAccount({ account = {}, profile = {}, incognito }) {
  const item = (act, icon, label, extra = '') => `<button class="acc-item" data-acc="${act}"><span class="ic">${icon}</span><span class="t">${esc(label)}</span>${extra}</button>`;
  if (incognito) {
    card.innerHTML = `<div class="acc-head">${avatarHtml({ incognito: true, size: 56 })}<div class="acc-name">Incognito</div><div class="acc-sub">Pages here aren’t saved to history</div></div>
      <div class="acc-list">${item('page:passwords', icons.key, 'Passwords and Autofill')}${item('page:settings', icons.gear, 'Settings')}${item('close-incognito', icons.x, 'Close all incognito windows')}</div>`;
    return;
  }
  const name = profile.name || account.name || (account.signedIn ? account.email : 'Lumio Browser');
  const sub = account.signedIn ? account.email : 'Not signed in';
  const plan = account.signedIn && account.planName ? `<span class="acc-plan">Lumio ${esc(account.planName)}</span>` : '';
  let status = '';
  if (account.connecting) {
    status = `<div class="acc-box"><div class="acc-box-t">Finish signing in on the Lumio tab</div><div class="acc-box-s">Log in on the Lumio tab that opened. Lumio Browser signs in with you.</div><button class="acc-btn ghost" data-acc="cancel">Cancel</button></div>`;
  } else if (!account.signedIn) {
    status = `<div class="acc-box"><div class="acc-box-s">Sign in to use Lumio AI in this browser. It’s free to start.</div><button class="acc-btn primary" data-acc="sign-in">Sign in to Lumio</button></div>`;
  }
  const error = account.error ? `<div class="acc-error">${esc(account.error)}</div>` : '';
  const w = (account.usage?.windows || []).find((x) => x.id === 'weekly') || account.usage;
  const left = w && w.limit ? Math.max(0, Math.round((w.remaining / w.limit) * 100)) : null;
  const planLabel = account.signedIn && account.planName ? `Plan and usage` : 'Plans';
  const planExtra = account.signedIn && left != null ? `<span class="acc-meta">${left}% left</span>` : '';
  const upgrade = account.plan !== 'max' ? `<span class="acc-pill" data-acc="open:upgrade">Upgrade</span>` : '';
  card.innerHTML = `<div class="acc-head">${avatarHtml({ profile, account, size: 56 })}<div class="acc-name">${esc(name)}</div><div class="acc-sub">${esc(sub)}</div>${plan}</div>
    ${status}${error}
    <div class="acc-list">
      ${item('page:passwords', icons.key, 'Passwords and Autofill')}
      ${account.signedIn ? item('open:manage', icons.person, 'Manage your Lumio account', `<span class="acc-meta">${icons.external}</span>`) : ''}
      ${item('page:profile', icons.brush, 'Customize profile')}
      ${item('page:plan', icons.gauge, planLabel, planExtra + upgrade)}
      ${item('page:settings', icons.gear, 'Settings')}
      ${account.signedIn ? item('sign-out', icons.logout, 'Sign out of Lumio') : ''}
    </div>`;
}

// Saved accounts under a sign-in field (or a suggested strong password).
function renderAutofill({ host, accounts = [], generated }) {
  const rows = accounts.map((a) => `<button class="af-row" data-fill="${esc(a.id)}"><span class="ic">${icons.key}</span><span class="af-main"><span class="af-user">${esc(a.username || '(no username)')}</span><span class="af-dots">••••••••••</span></span></button>`).join('');
  const gen = generated ? `<button class="af-row af-gen" data-gen="1"><span class="ic">${icons.key}</span><span class="af-main"><span class="af-user">Use suggested password</span><span class="af-pw">${esc(generated)}</span><span class="af-note">Lumio will save it for ${esc(host)} when you sign up.</span></span></button>` : '';
  card.innerHTML = `${gen}${rows}<button class="af-manage" data-manage="1">Manage passwords…</button>`;
}

// "Save password?" / "Update password?" after a sign-in.
function renderPwSave({ prompt }) {
  const update = prompt.action === 'update';
  card.innerHTML = `
    <div class="pws-title">${update ? 'Update password?' : 'Save password?'}</div>
    <div class="pws-host">${esc(prompt.host)}</div>
    <label class="pws-field"><span>Username</span><input id="pws-user" type="text" value="${esc(prompt.username)}" spellcheck="false" autocomplete="off"></label>
    <label class="pws-field"><span>Password</span><span class="pws-pw"><input id="pws-pw" type="password" value="${'•'.repeat(Math.min(prompt.length || 8, 24))}" readonly><button class="pws-eye" data-eye="${prompt.id}" title="Show password">${icons.eye}</button></span></label>
    <div class="pws-actions">
      ${update ? '' : `<button class="acc-btn ghost" data-decide="never">Never for this site</button>`}
      <span style="flex:1"></span>
      <button class="acc-btn ghost" data-decide="dismiss">Not now</button>
      <button class="acc-btn primary" data-decide="save">${update ? 'Update' : 'Save'}</button>
    </div>`;
  card.dataset.prompt = String(prompt.id);
}

// "Save a passkey?" / "Sign in with a passkey" when a site asks (Lumio is the authenticator).
function renderPasskey({ prompt }) {
  const p = prompt;
  const who = (a) => esc(a.displayName && a.displayName !== a.userName ? a.displayName : a.userName || 'Account');
  const sub = (a) => (a.displayName && a.userName && a.displayName !== a.userName ? `<small>${esc(a.userName)}</small>` : '');
  let body = '';
  let ok = '';
  if (p.mode === 'create') {
    body = `<div class="pk-title">Save a passkey for ${esc(p.rpId)}?</div>
      <div class="pk-account">${icons.person}<span><b>${who(p)}</b>${sub(p)}</span></div>
      <p class="pk-note">Lumio keeps it on this computer and asks for ${navigator.platform.startsWith('Mac') ? 'Touch ID' : 'Windows Hello'} when you use it. No password needed next time.</p>`;
    ok = 'Save passkey';
  } else if (p.mode === 'get') {
    body = `<div class="pk-title">Sign in to ${esc(p.rpId)}</div>
      <div class="pk-list">${p.accounts.map((a, i) => `<label class="pk-acc"><input type="radio" name="pk" value="${esc(a.id)}" ${i === 0 ? 'checked' : ''}>${icons.person}<span><b>${who(a)}</b>${sub(a)}</span></label>`).join('')}</div>
      <p class="pk-note">With your passkey saved in Lumio.</p>`;
    ok = 'Continue';
  } else {
    body = `<div class="pk-title">No passkey for ${esc(p.rpId)}</div>
      <p class="pk-note">You don’t have a passkey for this site saved in Lumio. Sign in another way, then the site can offer to create one.</p>`;
  }
  card.innerHTML = `<div class="pk-head">${icons.key}<span>Passkey · ${esc(p.host)}</span></div>${body}
    <div class="pws-actions"><span style="flex:1"></span><button class="acc-btn ghost" data-pk="cancel">${ok ? 'Cancel' : 'OK'}</button>${ok ? `<button class="acc-btn primary" data-pk="ok">${ok}</button>` : ''}</div>`;
  card.dataset.prompt = String(p.id);
}

// A site asked to share your screen: pick a whole screen or one window.
function renderScreenShare({ share: s }) {
  const tile = (x) => `<button class="ss-tile" data-src="${esc(x.id)}" title="${esc(x.name)}">
      <span class="ss-thumb">${x.thumb ? `<img src="${esc(x.thumb)}" alt="">` : ''}</span>
      <span class="ss-name">${esc(x.screen ? (x.name || 'Entire screen') : x.name)}</span></button>`;
  const screens = s.sources.filter((x) => x.screen);
  const windows = s.sources.filter((x) => !x.screen);
  card.innerHTML = `<div class="pk-head">${icons.eye || ''}<span>${esc(s.host)} wants to see your screen</span></div>
    <div class="pk-title">Choose what to share</div>
    ${screens.length ? `<div class="ss-label">Entire screen</div><div class="ss-grid">${screens.map(tile).join('')}</div>` : ''}
    ${windows.length ? `<div class="ss-label">Window</div><div class="ss-grid">${windows.map(tile).join('')}</div>` : ''}
    <div class="pws-actions"><span style="flex:1"></span><button class="acc-btn ghost" data-ss="cancel">Cancel</button><button class="acc-btn primary" data-ss="share" disabled>Share</button></div>`;
  card.dataset.prompt = String(s.id);
}

// What's new in an update, from the release notes (a little Markdown).
function notesHtml(md) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const out = [];
  let list = false;
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trim();
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(item[1])}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    if (!line) continue;
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    out.push(h ? `<div class="up-h">${inline(h[1])}</div>` : `<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}
function renderUpdateCard({ update: u }) {
  const ready = u.status === 'ready';
  card.innerHTML = `
    <div class="up-top">${u.critical ? '<span class="up-badge">Important update</span>' : '<span class="up-badge soft">Update</span>'}</div>
    <div class="up-title">Lumio Browser ${esc(u.latest)} is here</div>
    <div class="up-sub">You have ${esc(u.current)}</div>
    ${u.notes ? `<div class="up-notes">${notesHtml(u.notes)}</div>` : ''}
    <div class="up-foot">Lumio restarts and reopens your tabs. It takes a few seconds.${navigator.platform.startsWith('Mac') ? ' If macOS then asks for your Mac password, type it and click <b>Always Allow</b>.' : ''}</div>
    <div class="pws-actions">
      ${u.notesUrl ? '<button class="acc-btn ghost" data-up="notes">Details</button>' : ''}
      <span style="flex:1"></span>
      <button class="acc-btn ghost" data-up="later">Later</button>
      <button class="acc-btn primary" data-up="now">${ready ? 'Restart now' : 'Update now'}</button>
    </div>`;
  card.dataset.notesUrl = u.notesUrl || '';
}

// Tell the browser how tall this dropdown really is.
function measure() {
  // Measure the natural height (a scroll box never reports less than it has).
  card.style.height = 'auto';
  const h = card.getBoundingClientRect().height;
  card.style.height = '';
  api.send('overlay:size', { height: Math.ceil(h) + 2 + 22 });
}
function reportSize() {
  requestAnimationFrame(measure);
  // Again once fonts and styles have settled (the first menu opens very early).
  document.fonts.ready.then(() => requestAnimationFrame(measure));
  setTimeout(measure, 150);
}

let kind = null;
api.on('overlay-data', (payload) => {
  kind = payload.kind;
  if (kind !== 'suggest') { card.removeAttribute('role'); card.removeAttribute('aria-label'); } // the same card shows every kind
  if (payload.accent) setAccent(document.documentElement, payload.accent); // { dark, light } from the shell
  if (kind === 'suggest') renderSuggest(payload);
  else if (kind === 'downloads') renderDownloads(payload);
  else if (kind === 'siteinfo') { renderSiteInfo(payload); reportSize(); }
  else if (kind === 'account') { renderAccount(payload); reportSize(); }
  else if (kind === 'autofill') { renderAutofill(payload); reportSize(); }
  else if (kind === 'pwsave') { renderPwSave(payload); reportSize(); }
  else if (kind === 'passkey') { renderPasskey(payload); reportSize(); }
  else if (kind === 'update') { renderUpdateCard(payload); reportSize(); }
  else if (kind === 'screenshare') renderScreenShare(payload);
});

card.addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-perm]');
  if (kind === 'siteinfo' && sel) api.send('site:set-permission', { permission: sel.dataset.perm, value: sel.value });
});

card.addEventListener('mousedown', async (e) => {
  if (kind === 'screenshare') {
    const tile = e.target.closest('[data-src]');
    if (tile) {
      card.querySelectorAll('.ss-tile.on').forEach((t) => t.classList.remove('on'));
      tile.classList.add('on');
      card.querySelector('[data-ss=share]').disabled = false;
      if (e.detail >= 2) api.send('overlay:pick', { kind, id: Number(card.dataset.prompt), source: tile.dataset.src }); // double-click shares
      return;
    }
    const act = e.target.closest('[data-ss]')?.dataset.ss;
    if (!act) return;
    e.preventDefault();
    const chosen = card.querySelector('.ss-tile.on')?.dataset.src || null;
    if (act === 'share' && !chosen) return;
    api.send('overlay:pick', { kind, id: Number(card.dataset.prompt), source: act === 'share' ? chosen : null });
    return;
  }
  if (kind === 'update') {
    const act = e.target.closest('[data-up]')?.dataset.up;
    if (!act) return;
    e.preventDefault();
    if (act === 'now') api.send('update:now');
    else if (act === 'later') api.send('update:later');
    else if (act === 'notes' && card.dataset.notesUrl) { api.send('open-url', card.dataset.notesUrl); api.send('update:later'); }
    api.send('overlay:pick', { kind });
    return;
  }
  if (kind === 'passkey') {
    const decision = e.target.closest('[data-pk]')?.dataset.pk;
    if (!decision) return; // choosing an account works normally
    e.preventDefault();
    const account = card.querySelector('input[name=pk]:checked')?.value || null;
    api.send('passwords:passkey', { id: Number(card.dataset.prompt), decision, account });
    return;
  }
  if (kind === 'autofill') {
    e.preventDefault();
    const fill = e.target.closest('[data-fill]')?.dataset.fill;
    if (fill) api.send('passwords:fill', { id: fill });
    else if (e.target.closest('[data-gen]')) api.send('passwords:fill', { generate: true });
    else if (e.target.closest('[data-manage]')) api.send('passwords:manage');
    else return;
    api.send('overlay:pick', { kind });
    return;
  }
  if (kind === 'pwsave') {
    const eye = e.target.closest('[data-eye]');
    if (eye) {
      e.preventDefault();
      const input = document.getElementById('pws-pw');
      if (input.type === 'password') {
        const pw = await api.invoke('passwords:reveal-pending', Number(eye.dataset.eye));
        if (pw != null) { input.value = pw; input.type = 'text'; }
      } else { input.type = 'password'; }
      return;
    }
    const decision = e.target.closest('[data-decide]')?.dataset.decide;
    if (!decision) return; // clicks in the username field work normally
    e.preventDefault();
    api.send('passwords:decide', { id: Number(card.dataset.prompt), decision, username: document.getElementById('pws-user').value });
    api.send('overlay:pick', { kind });
    return;
  }
  if (kind === 'account') {
    e.preventDefault();
    const act = e.target.closest('[data-acc]')?.dataset.acc;
    if (!act) return;
    if (act === 'sign-in') api.send('account:sign-in');
    else if (act === 'cancel') api.send('account:cancel');
    else if (act === 'sign-out') api.send('account:sign-out');
    else if (act === 'close-incognito') api.send('account:close-incognito');
    else if (act.startsWith('open:')) api.send('account:open', act.slice(5));
    else if (act.startsWith('page:')) api.send('account:page', act.slice(5));
    if (act !== 'cancel') api.send('overlay:pick', { kind });
    return;
  }
  if (kind === 'siteinfo') {
    const act = e.target.closest('[data-si]')?.dataset.si;
    if (act === 'clear') api.send('site:clear-data');
    if (act === 'settings') { api.send('site:settings'); api.send('overlay:pick', { kind }); }
    return; // let <select> menus open normally
  }
  e.preventDefault();
  if (kind === 'suggest') {
    if (e.button === 2) return;
    const rm = e.target.closest('[data-rm]');
    if (rm) { api.send('overlay:pick', { kind, index: Number(rm.dataset.rm), action: 'remove' }); return; }
    const row = e.target.closest('.row');
    // ⌘/Ctrl-click: a new tab; middle click: a background tab; ⇧-click: a new window.
    const disposition = e.button === 1 ? 'background' : e.metaKey || e.ctrlKey ? 'tab' : e.shiftKey ? 'window' : 'current';
    if (row) api.send('overlay:pick', { kind, index: Number(row.dataset.i), disposition });
  } else if (kind === 'downloads') {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    api.send('download:action', { id: btn.dataset.id, action: btn.dataset.act });
    if (['open', 'show', 'all'].includes(btn.dataset.act)) api.send('overlay:pick', { kind });
  }
});
