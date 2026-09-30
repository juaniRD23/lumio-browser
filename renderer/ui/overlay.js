// Floating dropdowns drawn above the page: omnibox suggestions, downloads
// and the site-information popup (lock icon).
import { icons, markSvg, avatarHtml } from './icons.js';

const api = window.lumio;
const card = document.getElementById('card');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pretty = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
const size = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B');

function renderSuggest({ items, selected }) {
  card.innerHTML = items.map((it, i) => {
    const icon = it.type === 'ai' ? markSvg(15) : it.type === 'search' ? icons.search : it.type === 'bookmark' ? icons.star : it.type === 'history' ? icons.clock : icons.globe;
    let body;
    if (it.type === 'ai') body = `<span class="t">${esc(it.title)}</span><span class="spacer" style="flex:1"></span><span class="hint">Ask Lumio</span>`;
    else if (it.type === 'search') body = `<span class="t">${esc(it.title)}</span><span class="spacer" style="flex:1"></span><span class="hint" style="color:#7c7c80">Search</span>`;
    else if (it.type === 'url') body = `<span class="t">${esc(it.title)}</span>`;
    else body = `<span class="t">${esc(it.title)}</span><span class="u">${esc(pretty(it.url))}</span>`;
    return `<div class="row ${it.type} ${i === selected ? 'sel' : ''}" data-i="${i}"><span class="ic">${icon}</span>${body}</div>`;
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
    status = `<div class="acc-box"><div class="acc-box-t">Approve on lumio-usa.online</div><div class="acc-box-s">Check that the page shows this code, then click Connect.</div><div class="acc-code">${esc(account.code || '')}</div><button class="acc-btn ghost" data-acc="cancel">Cancel</button></div>`;
  } else if (!account.signedIn) {
    status = `<div class="acc-box"><div class="acc-box-s">Sign in to see your Lumio plan and use it for the AI in this browser.</div><button class="acc-btn primary" data-acc="sign-in">Sign in to Lumio</button></div>`;
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
  if (payload.accent) document.documentElement.style.setProperty('--accent', payload.accent);
  if (kind === 'suggest') renderSuggest(payload);
  else if (kind === 'downloads') renderDownloads(payload);
  else if (kind === 'siteinfo') { renderSiteInfo(payload); reportSize(); }
  else if (kind === 'account') { renderAccount(payload); reportSize(); }
  else if (kind === 'autofill') { renderAutofill(payload); reportSize(); }
  else if (kind === 'pwsave') { renderPwSave(payload); reportSize(); }
});

card.addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-perm]');
  if (kind === 'siteinfo' && sel) api.send('site:set-permission', { permission: sel.dataset.perm, value: sel.value });
});

card.addEventListener('mousedown', async (e) => {
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
    const row = e.target.closest('.row');
    if (row) api.send('overlay:pick', { kind, index: Number(row.dataset.i) });
  } else if (kind === 'downloads') {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    api.send('download:action', { id: btn.dataset.id, action: btn.dataset.act });
    if (['open', 'show', 'all'].includes(btn.dataset.act)) api.send('overlay:pick', { kind });
  }
});
