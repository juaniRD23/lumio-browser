// Floating dropdowns drawn above the page: omnibox suggestions, downloads,
// the site-information popup (lock icon), prompts, blocked pop-ups, tab hover
// cards and the ⋮ menu. main/window.js shows and hides them (see "Showing and hiding").
import { icons, markSvg, avatarHtml } from './icons.js';
import { setAccent } from '/assets/theme-colors.js';
import { animate } from './motion.js';
import '/assets/ui-prefs.js';
import { renderZoom, initZoom } from './overlay-zoom.js';
import { renderTabSearch, initTabSearch } from './overlay-tabsearch.js';
import './overlay-bookmarks.js'; // the bookmarks bar's folder menus and the star's bubble
import './overlay-groups.js'; // the tab group editor
import { siteIcon } from '/assets/site-icons.js';
import { permissionBubble } from './overlay-site.js';
import { securityChoosers } from './overlay-security.js';
import { renderPerf, perfAction } from './overlay-perf.js';
import { initTranslateBubble } from './overlay-translate.js';
import { initShareBubble, initInstallDialog } from './overlay-share.js';
import { initMediaHub } from './overlay-media.js';
import * as autofillUi from './overlay-autofill.js';
import * as extUi from './overlay-extensions.js';
import * as helpUi from './overlay-help.js';
import './tab-flyout.js'; // the collapsed tabs column's flyout (kind 'vtabs')
import './name-window.js'; // Name Window… (kind 'namewindow')

const api = window.lumio;
const card = document.getElementById('card');
const bubble = permissionBubble({ api, card });
const choosers = securityChoosers({ api, card, onResize: () => fit() });

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pretty = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
const size = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B');

// Omnibox suggestions (main/omnibox.js makes the rows): the site's icon, the
// words you typed in bold, and what kind of suggestion it is (search, Ask
// Lumio, history, bookmark, open tab, action…). One highlight (.sel-pill)
// glides to the selected row, from the arrow keys in the address bar or the
// pointer here (which tells the address bar).
const KIND_ICON = { history: icons.clock, bookmark: icons.star, url: icons.globe, tab: icons.tabs };
const KIND_NAME = { history: 'From your history', bookmark: 'Bookmarked', tab: 'Open tab' };
const ACTION_ICONS = { clearData: 'trash', passwords: 'key', settings: 'gear', incognito: 'incognito' };
const SCOPE_ICONS = { tabs: 'tabs', bookmarks: 'star', history: 'clock' };
function suggestIcon(it) {
  if (it.type === 'ai' || it.scope === 'lumio') return markSvg(15);
  if (it.type === 'answer') return '<b class="eq" aria-hidden="true">=</b>';
  if (it.type === 'action') return icons[ACTION_ICONS[it.action]] || icons.bolt;
  if (it.type === 'keyword') return icons[SCOPE_ICONS[it.scope]] || icons.search;
  return icons[{ search: 'search', bookmark: 'star', history: 'clock', tab: 'tabs', clipboard: 'copy' }[it.type]] || icons.globe;
}
function marked(text, query) {
  const words = String(query || '').trim().split(/\s+/).filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return esc(text);
  // split() keeps what a capture group matched at the odd places.
  return String(text ?? '').split(new RegExp(`(${words.join('|')})`, 'i')).map((part, i) => (i % 2 ? `<b>${esc(part)}</b>` : esc(part))).join('');
}
let suggestKey = '';
let suggestSel = -1;
function renderSuggest({ items, selected, query }, fresh) {
  const key = JSON.stringify([query, items]);
  if (fresh || key !== suggestKey) {
    suggestKey = key;
    card.setAttribute('role', 'listbox');
    card.setAttribute('aria-label', 'Suggestions');
    const hint = (text, cls = '') => `<span class="spacer"></span><span class="hint ${cls}">${text}</span>`;
    card.innerHTML = '<i class="sel-pill" aria-hidden="true"></i>' + items.map((it, i) => {
      let lead = suggestIcon(it);
      let tag = '';
      if (it.favicon && KIND_ICON[it.type]) {
        lead = `<img src="${esc(it.favicon)}" alt="">`;
        if (KIND_NAME[it.type]) tag = `<span class="tag" title="${KIND_NAME[it.type]}">${KIND_ICON[it.type]}</span>`;
      }
      const t = `<span class="t">${marked(it.title, query)}</span>`;
      const u = it.url ? `<span class="u">${marked(pretty(it.url), query)}</span>` : '';
      let body;
      if (it.type === 'ai') body = `<span class="t">${esc(it.title)}</span>` + hint('Ask Lumio');
      else if (it.type === 'search') body = `<span class="t">${esc(it.title)}</span>` + (it.remote ? '' : hint(esc(it.hint || 'Search')));
      else if (it.type === 'url') body = t + '<span class="spacer"></span>';
      else if (it.type === 'tab') body = t + u + hint('Switch to this tab', 'pill');
      else if (it.type === 'action') body = `<span class="t">${esc(it.title)}</span>` + hint('Action', 'pill');
      else if (it.type === 'answer') body = `<span class="t">${esc(it.title)}</span>` + hint('Copy');
      else if (it.type === 'keyword') body = `<span class="t">${esc(it.title)}</span>` + hint('<kbd>Tab</kbd>');
      else body = t + u + tag;
      const rmLabel = it.type === 'clipboard' ? 'Remove' : 'Remove from history';
      const remove = it.removable || it.type === 'clipboard' ? `<button class="rm" data-rm="${i}" tabindex="-1" title="${rmLabel}" aria-label="${rmLabel}">${icons.close}</button>` : '';
      return `<div class="row ${it.type}${it.remote ? ' remote' : ''}" data-i="${i}" role="option" aria-selected="false"><span class="ic">${lead}</span>${body}${remove}</div>`;
    }).join('');
    // A site icon that won't load gives way to the kind's.
    card.querySelectorAll('.row .ic img').forEach((img) => {
      img.onerror = () => { img.outerHTML = KIND_ICON[img.closest('.row').classList[1]] || icons.globe; };
    });
    suggestSel = -1;
  }
  selectRow(selected);
}
function selectRow(i) {
  const pill = card.querySelector('.sel-pill');
  const row = card.querySelector(`.row[data-i="${i}"]`);
  if (!pill) return;
  card.querySelectorAll('.row[aria-selected=true]').forEach((r) => r.setAttribute('aria-selected', 'false'));
  pill.classList.toggle('on', !!row);
  if (!row) { suggestSel = -1; return; }
  row.setAttribute('aria-selected', 'true');
  // A highlight that wasn't anywhere starts on its row instead of gliding there.
  pill.classList.toggle('still', suggestSel < 0);
  pill.style.transform = `translateY(${row.offsetTop}px)`;
  pill.getBoundingClientRect();
  pill.classList.remove('still');
  suggestSel = i;
}
// The rows come in one after another, all within 120 ms.
function revealRows() {
  const rows = [...card.querySelectorAll('.row')];
  const step = Math.min(10, 30 / Math.max(1, rows.length - 1));
  rows.forEach((row, i) => animate(row, [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: 1, delay: Math.round(i * step), fill: 'backwards' }));
}
// The pointer moving over a row selects it (not a row that slid under a
// still pointer: then nothing moved).
card.addEventListener('pointermove', (e) => {
  if (kind !== 'suggest' || (!e.movementX && !e.movementY)) return;
  const row = e.target.closest('.row');
  const i = row ? Number(row.dataset.i) : -1;
  if (i < 0 || i === suggestSel) return;
  selectRow(i);
  api.send('overlay:hover', i);
});

function renderDownloads({ items }) {
  const rows = items.map((d) => {
    // A risky file waits for Keep or Discard (main/security.js says why).
    if (d.danger) {
      return `<div class="dl danger" role="group" aria-label="${esc(d.danger.title)}: ${esc(d.name)}"><span class="dl-warn">${icons.warn}</span><div class="meta"><div class="name">${esc(d.name)}</div><div class="dl-why"><b>${esc(d.danger.title)}</b> ${esc(d.danger.detail)}</div>
        <div class="dl-acts"><button class="dl-discard" data-act="discard" data-id="${d.id}">Discard</button><button data-act="keep" data-id="${d.id}">Keep</button></div></div></div>`;
    }
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

// Each setting: its default, or what this site is set to.
const VALUE_WORDS = { ask: 'Ask', quiet: 'Ask quietly', allow: 'Allow', block: 'Block', session: 'Clear on exit', 'block-incognito': 'Block in Incognito' };
function renderSiteInfo({ info }) {
  const secure = info.certError || info.certBypass
    ? `<div class="si-status danger">${icons.warn}<div><b>Your connection to this site isn't private</b><span>${info.certBypass ? "You chose to visit it although its security certificate isn't valid. Don't enter passwords or payment info here." : "Its security certificate isn't valid."}</span>${info.certBypass ? '<button data-si="cert-revoke">Turn on warnings</button>' : ''}</div></div>`
    : info.secure
      ? `<div class="si-status ok">${icons.lock}<div><b>Connection is secure</b><span>Info you send to this site stays private.</span></div></div>`
      : `<div class="si-status bad">${icons.warn}<div><b>Not secure</b><span>Don't enter passwords or payment info on this site.</span></div></div>`;
  const perms = info.permissions.map((p) => `
    <label class="si-perm">${siteIcon(p.permission, { size: 16 })}<span>${esc(p.label)}</span>
      <select data-perm="${esc(p.permission)}" ${p.reload ? 'data-reload' : ''} aria-label="${esc(p.label)}">
        <option value="default" ${p.value ? '' : 'selected'}>${VALUE_WORDS[p.default] || 'Default'} (default)</option>
        ${p.options.map((v) => `<option value="${v}" ${p.value === v ? 'selected' : ''}>${VALUE_WORDS[v]}</option>`).join('')}
      </select>
    </label>`).join('');
  const custom = info.permissions.some((p) => p.value);
  card.innerHTML = `
    <div class="si-host">${esc(info.host)}${info.incognito ? ' <em>Incognito</em>' : ''}</div>
    ${secure}
    <div class="si-sec">Permissions</div>
    ${perms}
    <div class="si-reload" ${info.reload ? '' : 'hidden'}><span>Reload this page to use your new settings.</span><button data-si="reload">Reload</button></div>
    <div class="si-data">${siteIcon('thirdPartyCookies', { size: 16 })}<span>Cookies and site data</span><small>${info.cookies === 1 ? '1 cookie' : `${info.cookies || 0} cookies`}</small></div>
    ${info.trackers ? `<div class="si-data si-trackers">${siteIcon('trackers', { size: 16 })}<span>Ads and trackers blocked on this page</span><small>${info.trackers}</small></div>` : ''}
    <div class="si-actions">
      <button data-si="clear">Clear cookies and site data</button>
      ${custom ? '<button data-si="reset">Reset permissions</button>' : ''}
      ${info.incognito ? '' : '<button data-si="settings">Site settings</button>'}
    </div>`;
}

// The other profiles to switch to, and Add, Guest and Manage profiles.
function profilesSection(profiles = [], guest = false) {
  const others = profiles.filter((p) => !p.current);
  const rows = others.map((p) => `<button class="acc-item acc-profile" data-acc="profile:${esc(p.id)}">${avatarHtml({ profile: p, size: 22 })}<span class="t">${esc(p.name)}</span>${p.email ? `<span class="acc-meta acc-email">${esc(p.email)}</span>` : ''}</button>`).join('');
  return `<div class="acc-list acc-profiles">
      ${others.length ? `<div class="acc-sec">${guest ? 'Profiles' : 'Other profiles'}</div>${rows}` : ''}
      <div class="acc-tools">
        <button class="acc-tool" data-acc="profiles:add">${icons.plus}<span>Add</span></button>
        ${guest ? '' : `<button class="acc-tool" data-acc="profiles:guest">${icons.person}<span>Guest</span></button>`}
        <button class="acc-tool" data-acc="profiles:manage">${icons.users}<span>Manage</span></button>
      </div>
    </div>`;
}

function renderAccount({ account = {}, profile = {}, incognito, guest, profiles }) {
  const item = (act, icon, label, extra = '') => `<button class="acc-item" data-acc="${act}"><span class="ic">${icon}</span><span class="t">${esc(label)}</span>${extra}</button>`;
  if (guest) {
    card.innerHTML = `<div class="acc-head">${avatarHtml({ guest: true, size: 56 })}<div class="acc-name">Guest</div><div class="acc-sub">Nothing you do here is kept after you close Guest</div></div>
      <div class="acc-list">${item('page:settings', icons.gear, 'Settings')}${item('close-guest', icons.x, 'Close Guest')}</div>
      ${profilesSection(profiles, true)}`;
    return;
  }
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
    </div>
    ${profilesSection(profiles)}`;
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

// "Save a passkey?" / "Sign in with a passkey" when a site asks (Lumio is the
// authenticator), with a way to use a security key instead, and the note
// shown while a site waits for one.
function renderPasskey({ prompt }) {
  const p = prompt;
  const who = (a) => esc(a.displayName && a.displayName !== a.userName ? a.displayName : a.userName || 'Account');
  const sub = (a) => (a.displayName && a.userName && a.displayName !== a.userName ? `<small>${esc(a.userName)}</small>` : '');
  let body = '';
  let ok = '';
  if (p.mode === 'create') {
    body = `<div class="pk-title">Save a passkey for ${esc(p.rpId)}?</div>
      <div class="pk-account">${icons.person}<span><b>${who(p)}</b>${sub(p)}</span></div>
      <p class="pk-note">Lumio saves it with your passwords, syncs it if Lumio Sync is on, and asks for ${navigator.platform.startsWith('Mac') ? 'Touch ID' : 'Windows Hello'} when you use it. No password needed next time.</p>`;
    ok = 'Save passkey';
  } else if (p.mode === 'get') {
    body = `<div class="pk-title">Sign in to ${esc(p.rpId)}</div>
      <div class="pk-list">${p.accounts.map((a, i) => `<label class="pk-acc"><input type="radio" name="pk" value="${esc(a.id)}" ${i === 0 ? 'checked' : ''}>${icons.person}<span><b>${who(a)}</b>${sub(a)}</span></label>`).join('')}</div>
      <p class="pk-note">With your passkey saved in Lumio.</p>`;
    ok = 'Continue';
  } else if (p.mode === 'key') {
    body = `<div class="pk-title">Use your security key</div>
      <p class="pk-note">Insert your security key and touch it when it blinks. If you don’t have one for ${esc(p.host)}, cancel and sign in another way.</p>`;
  } else {
    body = `<div class="pk-title">No passkey for ${esc(p.rpId)}</div>
      <p class="pk-note">You don’t have a passkey for this site saved in Lumio. Use a security key, or sign in another way and the site can offer to create a passkey.</p>`;
    ok = 'Use a security key';
  }
  const other = p.mode === 'create' || p.mode === 'get' ? '<button class="acc-btn ghost" data-pk="key">Use a security key</button>' : '';
  card.innerHTML = `<div class="pk-head">${icons.key}<span>${p.mode === 'key' ? 'Security key' : 'Passkey'} · ${esc(p.host)}</span></div>${body}
    <div class="pws-actions">${other}<span style="flex:1"></span><button class="acc-btn ghost" data-pk="cancel">Cancel</button>${ok ? `<button class="acc-btn primary" data-pk="${p.mode === 'none' ? 'key' : 'ok'}">${ok}</button>` : ''}</div>`;
  card.dataset.prompt = String(p.id);
}

// A site asked to share your screen: pick another tab (with its sound), a
// whole screen or one window.
function renderScreenShare({ share: s }) {
  const tile = (x) => `<button class="ss-tile" data-src="${esc(x.id)}" title="${esc(x.name)}">
      <span class="ss-thumb">${x.thumb ? `<img src="${esc(x.thumb)}" alt="">` : ''}</span>
      <span class="ss-name">${esc(x.screen ? (x.name || 'Entire screen') : x.name)}</span></button>`;
  const tabRow = (t) => `<button class="ss-tab" data-src="${esc(t.id)}" data-tab>
      ${t.favicon ? `<img src="${esc(t.favicon)}" alt="">` : `<span class="ss-fav">${icons.globe}</span>`}
      <span class="ss-txt"><b>${esc(t.name)}</b>${t.url ? `<small>${esc(pretty(t.url))}</small>` : ''}</span></button>`;
  const screens = s.sources.filter((x) => x.screen);
  const windows = s.sources.filter((x) => !x.screen);
  const tabs = s.tabs || [];
  card.innerHTML = `<div class="pk-head">${icons.eye || ''}<span>${esc(s.host)} wants to see your screen</span></div>
    <div class="pk-title">Choose what to share</div>
    ${tabs.length ? `<div class="ss-label">Tab</div><div class="ss-tabs">${tabs.map(tabRow).join('')}</div>` : ''}
    ${screens.length ? `<div class="ss-label">Entire screen</div><div class="ss-grid">${screens.map(tile).join('')}</div>` : ''}
    ${windows.length ? `<div class="ss-label">Window</div><div class="ss-grid">${windows.map(tile).join('')}</div>` : ''}
    ${s.screensOff ? '<p class="ss-note">To share your whole screen or another app’s window, turn on Lumio Browser in System Settings › Privacy &amp; Security › Screen Recording.</p>' : ''}
    <div class="pws-actions">${s.audio ? '<label class="ss-audio" hidden><input type="checkbox" id="ss-audio" checked> Also share tab audio</label>' : ''}<span style="flex:1"></span><button class="acc-btn ghost" data-ss="cancel">Cancel</button><button class="acc-btn primary" data-ss="share" disabled>Share</button></div>`;
  card.dataset.prompt = String(s.id);
}
// Choosing in the screen sharing picker, with the mouse or the keyboard.
function pickShare(e) {
  const tile = e.target.closest('[data-src]');
  const send = (source) => api.send('overlay:pick', { kind: 'screenshare', id: Number(card.dataset.prompt), source, audio: card.querySelector('#ss-audio')?.checked !== false });
  if (tile) {
    card.querySelectorAll('[data-src].on').forEach((t) => t.classList.remove('on'));
    tile.classList.add('on');
    card.querySelector('[data-ss=share]').disabled = false;
    const audio = card.querySelector('.ss-audio');
    if (audio) audio.hidden = !('tab' in tile.dataset); // only a tab's sound can be shared
    if (e.detail >= 2) send(tile.dataset.src); // double-click shares
    return;
  }
  const act = e.target.closest('[data-ss]')?.dataset.ss;
  if (!act) return;
  e.preventDefault();
  const chosen = card.querySelector('[data-src].on')?.dataset.src || null;
  if (act === 'share' && !chosen) return;
  send(act === 'share' ? chosen : null);
}

// Pop-ups the page tried to open by itself: open one (it opens as if the
// page had, after a click), or always allow the site. Keyboard: the first
// one has focus, Tab moves, Enter picks, Esc closes.
function renderPopups({ host, allowed, items }) {
  const list = items.map((p) => `<button class="pop-item" data-pb="${p.id}" title="${esc(p.url)}">${esc(pretty(p.url) || p.url)}</button>`).join('');
  // Only a website can be always allowed (not a file on this computer).
  const choices = host ? `
    <div class="pop-choices" role="radiogroup" aria-label="Pop-ups on this site">
      <label class="pop-choice"><input type="radio" name="pb" value="allow" ${allowed ? 'checked' : ''}><span>Always allow pop-ups and redirects from <b>${esc(host)}</b></span></label>
      <label class="pop-choice"><input type="radio" name="pb" value="block" ${allowed ? '' : 'checked'}><span>Continue blocking</span></label>
    </div>` : '';
  card.innerHTML = `
    <div class="pop-title" id="pop-title">Pop-ups blocked:</div>
    <div class="pop-list" role="group" aria-labelledby="pop-title">${list}</div>
    ${choices}
    <div class="pws-actions">
      ${host ? '<button class="acc-btn ghost" data-pb-act="manage">Manage</button>' : ''}
      <span style="flex:1"></span>
      <button class="acc-btn primary" data-pb-act="done">Done</button>
    </div>`;
  card.querySelector('.pop-item')?.focus();
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

// A tab's hover card (main/window.js showHoverCard). The view spans the tab
// strip and --x puts the card under its tab, so moving along the tabs slides
// the card over instead of opening it again.
let cardTab = null;
// "120 MB", "1.2 GB", like the Task manager.
const memoryText = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
function renderHoverCard(p, fresh) {
  const before = cardTab;
  const shown = card.querySelector('.hc-shot img')?.getAttribute('src') || null;
  cardTab = p.id;
  // A new card appears where it is; one that's up glides to its new tab.
  card.classList.toggle('still', fresh);
  card.style.setProperty('--x', `${p.x}px`);
  const dot = /^#[0-9a-f]{3,8}$/i.test(p.agent?.color || '') ? ` style="--c: ${p.agent.color}"` : '';
  card.innerHTML = `
    <div class="hc-text">
      <div class="hc-title">${esc(p.title)}</div>
      ${p.site ? `<div class="hc-site">${esc(p.site)}</div>` : ''}
      ${p.sleeping ? `<div class="hc-note">${icons.moon}<span>Sleeping (saved memory)</span></div>` : ''}
      ${!p.sleeping && p.memory > 0 ? `<div class="hc-mem">Memory usage: ${esc(memoryText(p.memory))}</div>` : ''}
      ${p.agent ? `<div class="hc-note"><i class="hc-dot"${dot}></i><span>${esc(p.agent.name)} is working here: ${esc(p.agent.title)}</span></div>` : ''}
    </div>
    ${p.shot ? `<div class="hc-shot">${p.preview ? `<img src="${esc(p.preview)}" alt="">` : icons.globe}</div>` : ''}`;
  if (fresh) {
    card.getBoundingClientRect(); // in place before anything glides
    card.classList.remove('still');
  } else if (p.id !== before) {
    animate(card.querySelector('.hc-text'), [{ opacity: 0.35 }, { opacity: 1 }], { duration: 2 });
  } else if (p.preview && p.preview !== shown) {
    animate(card.querySelector('.hc-shot img'), [{ opacity: 0 }, { opacity: 1 }], { duration: 3 }); // a fresh picture came in
  }
}
// The pointer on the card's view has left its tab: the card vanishes, and
// the view goes once that empty frame is drawn (two frames), so it never
// takes a click meant for the toolbar or the page under it.
document.addEventListener('pointermove', () => {
  if (kind !== 'hovercard' || !entered) return;
  entered = false;
  stopMotion();
  card.classList.remove('shown');
  afterPaint(() => api.send('tab:hovercard', { hide: true, now: true }));
});

// ------------------------------------------------------------------ ⋮ menu
// Chrome's main menu (main/menu.js buildBrowserMenu; main/window.js runs
// what you pick): rows with icons and shortcuts, submenus that slide out
// beside their row, a live zoom row and an edit row. The view covers the
// window, so a click outside the menu only closes it, as with a native
// menu. Keyboard: arrows, Enter or Space, Escape, and typing the start of a
// label. The window keeps the keyboard while the menu is open and sends its
// keys here (op 'key'); after a click in the menu, keys come here directly.
let menu = null; // { stack: [{ panel, items, sel, cell, from }], level, typed, typedAt }
let menuHover = 0;
const pickable = (it) => !!it && !!(it.id || it.submenu || it.type === 'zoom' || it.type === 'edit');
const cellsOf = (row) => (row ? [...row.querySelectorAll('button[data-cell]')] : []);

function menuRow(it, i) {
  if (it.type === 'separator') return '<div class="msep" role="separator"></div>';
  if (it.type === 'header') return `<div class="mhead">${esc(it.label)}</div>`;
  const tip = (label, key) => esc(key ? `${label} (${key})` : label);
  if (it.type === 'zoom') {
    return `<div class="mrow" data-i="${i}" role="group" aria-label="Zoom"><span class="t">Zoom</span>
      <button data-cell="0" data-id="${it.out}" title="${tip('Zoom out', it.keys.out)}" aria-label="Zoom out">${icons.minus}</button>
      <span class="zoom-val" aria-live="polite">${esc(it.level)}%</span>
      <button data-cell="1" data-id="${it.in}" title="${tip('Zoom in', it.keys.in)}" aria-label="Zoom in">${icons.plus}</button>
      <i class="mdiv"></i>
      <button data-cell="2" data-id="${it.fullscreen}" title="${tip('Full screen', it.keys.fullscreen)}" aria-label="Full screen">${icons.fullscreen}</button></div>`;
  }
  if (it.type === 'edit') {
    return `<div class="mrow" data-i="${i}" role="group" aria-label="Edit"><span class="t">Edit</span>
      ${['cut', 'copy', 'paste'].map((op, c) => `<button class="word" data-cell="${c}" data-id="${it[op]}" title="${esc(it.keys[op])}">${op[0].toUpperCase() + op.slice(1)}</button>`).join('')}</div>`;
  }
  const check = it.checked != null;
  const lead = check ? (it.checked ? icons.check : '') : it.favicon ? `<img src="${esc(it.favicon)}" alt="">` : icons[it.icon] || ''; // icon: a name in icons.js
  return `<div class="mi" data-i="${i}" role="${check ? 'menuitemcheckbox' : 'menuitem'}"${check ? ` aria-checked="${it.checked}"` : ''}${it.submenu ? ' aria-haspopup="menu" aria-expanded="false"' : ''}>`
    + `<span class="ic">${lead}</span><span class="t">${esc(it.label)}</span>`
    + `${it.accel ? `<span class="k">${esc(it.accel)}</span>` : ''}${it.submenu ? `<span class="chev">${icons.forward}</span>` : ''}</div>`;
}

// level: 0 for the menu, 1 for a submenu. A panel holds the keyboard while
// it's in use (when this view has it) and names its selected row in
// aria-activedescendant, so screen readers follow the highlight.
function menuPanel(items, level) {
  const panel = document.createElement('div');
  panel.className = 'mpanel';
  panel.setAttribute('role', 'menu');
  panel.tabIndex = -1;
  panel.innerHTML = '<i class="hl" aria-hidden="true"></i>' + items.map(menuRow).join('');
  panel.querySelectorAll('[data-i]').forEach((row) => {
    row.id = `m${level}-${row.dataset.i}`;
    cellsOf(row).forEach((b) => { b.id = `${row.id}-${b.dataset.cell}`; });
  });
  panel.querySelectorAll('img').forEach((img) => { img.onerror = () => { img.outerHTML = icons.globe; }; });
  return panel;
}

// at: the panel's top right corner, under ⋮.
function renderMenu(p) {
  clearTimeout(menuHover);
  card.innerHTML = '';
  menu = { stack: [], level: 0, typed: '', typedAt: 0 };
  const at = p.at || { right: p.width - 8, top: 8 };
  const panel = menuPanel(p.items, 0);
  panel.style.right = `${Math.max(8, p.width - at.right)}px`;
  panel.style.top = `${at.top}px`;
  panel.style.maxHeight = `${p.height - at.top - 8}px`;
  card.append(panel);
  panel.focus({ preventScroll: true });
  menu.stack.push({ panel, items: p.items, sel: -1, cell: -1 });
  if (p.keyboard) moveSel(1); // opened from the keyboard: the first row is ready
}

// The selected row gets the highlight, which glides between rows; in a row
// of buttons, the button is highlighted instead. cell -1: none of them.
function setSel(level, i, cell = -1) {
  const s = menu.stack[level];
  if (!s) return;
  s.sel = i;
  s.cell = cell;
  menu.level = level;
  s.panel.querySelectorAll('.sel').forEach((el) => el.classList.remove('sel'));
  const hl = s.panel.querySelector('.hl');
  const row = s.panel.querySelector(`[data-i="${i}"]`);
  const cells = cellsOf(row);
  if (!row || cells.length) {
    hl.classList.remove('on');
    cells[cell]?.classList.add('sel');
  } else {
    row.classList.add('sel');
    hl.classList.toggle('still', !hl.classList.contains('on'));
    hl.style.height = `${row.offsetHeight}px`;
    hl.style.transform = `translateY(${row.offsetTop}px)`;
    hl.getBoundingClientRect();
    hl.classList.remove('still');
    hl.classList.add('on');
  }
  const current = cells.length ? cells[cell] : row;
  if (current) s.panel.setAttribute('aria-activedescendant', current.id);
  else s.panel.removeAttribute('aria-activedescendant');
  if (document.activeElement !== s.panel) s.panel.focus({ preventScroll: true });
  // Keep it in view in a long menu (without scrolling anything else).
  if (row && row.offsetTop < s.panel.scrollTop) s.panel.scrollTop = row.offsetTop;
  else if (row && row.offsetTop + row.offsetHeight > s.panel.scrollTop + s.panel.clientHeight) s.panel.scrollTop = row.offsetTop + row.offsetHeight - s.panel.clientHeight;
}

function moveSel(dir) {
  const s = menu.stack[menu.level];
  const n = s.items.length;
  for (let k = 1, i = s.sel; k <= n; k++) {
    i = s.sel < 0 && k === 1 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
    if (pickable(s.items[i])) { setSel(menu.level, i, cellsOf(s.panel.querySelector(`[data-i="${i}"]`)).length ? 0 : -1); return; }
  }
}

function openSub(level, i, keyboard = false) {
  clearTimeout(menuHover);
  const parent = menu.stack[level];
  const it = parent.items[i];
  if (menu.stack[level + 1]?.from !== i) {
    closeSubs(level + 1);
    setSel(level, i);
    const row = parent.panel.querySelector(`[data-i="${i}"]`);
    const panel = menuPanel(it.submenu, level + 1);
    const vw = card.clientWidth;
    const vh = card.clientHeight;
    panel.style.maxHeight = `${vh - 16}px`;
    card.append(panel);
    // Beside its row: to the right if there's room, else to the left (⋮ is at
    // the window's right edge), and on screen.
    const pr = parent.panel.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const toRight = pr.right - 4 + panel.offsetWidth <= vw - 8;
    panel.style.left = `${toRight ? pr.right - 4 : Math.max(8, pr.left + 4 - panel.offsetWidth)}px`;
    panel.style.top = `${Math.max(8, Math.min(rr.top - 7, vh - 8 - panel.offsetHeight))}px`;
    row.classList.add('open');
    row.setAttribute('aria-expanded', 'true');
    animate(panel, [{ opacity: 0, transform: `translateX(${toRight ? -8 : 8}px)` }, { opacity: 1, transform: 'none' }], { duration: 2 });
    menu.stack.push({ panel, items: it.submenu, sel: -1, cell: -1, from: i });
  }
  if (keyboard) { menu.level = level + 1; moveSel(1); }
}

// Closes the submenus from this level down (a quick fade).
function closeSubs(level) {
  while (menu.stack.length > Math.max(1, level)) {
    const s = menu.stack.pop();
    const row = menu.stack[menu.stack.length - 1].panel.querySelector(`[data-i="${s.from}"]`);
    row?.classList.remove('open');
    row?.setAttribute('aria-expanded', 'false');
    s.panel.style.pointerEvents = 'none';
    const a = animate(s.panel, [{ opacity: 1 }, { opacity: 0 }], { duration: 1, easing: 'in' });
    if (a) { a.onfinish = () => s.panel.remove(); a.oncancel = a.onfinish; } else s.panel.remove();
  }
  menu.level = Math.min(menu.level, menu.stack.length - 1);
}
function backTo(level) {
  const from = menu.stack[level + 1]?.from;
  closeSubs(level + 1);
  if (from != null) setSel(level, from);
}

function activate(level, i, cell, keyboard = false) {
  const s = menu.stack[level];
  const it = s?.items[i];
  if (!it) return;
  if (it.submenu) { openSub(level, i, keyboard); return; }
  const id = it.id || cellsOf(s.panel.querySelector(`[data-i="${i}"]`))[cell]?.dataset.id;
  if (id) api.send('overlay:menu', { id });
}

function typeAhead(ch) {
  const now = performance.now();
  menu.typed = (now - menu.typedAt < 700 ? menu.typed : '') + ch.toLowerCase();
  menu.typedAt = now;
  const s = menu.stack[menu.level];
  const n = s.items.length;
  // The same letter again steps through the rows that start with it.
  const same = [...menu.typed].every((c) => c === menu.typed[0]);
  const prefix = same ? menu.typed[0] : menu.typed;
  const first = same ? s.sel + 1 : Math.max(0, s.sel);
  for (let k = 0; k < n; k++) {
    const i = (first + k) % n;
    const it = s.items[i];
    if (pickable(it) && it.label.toLowerCase().startsWith(prefix)) { setSel(menu.level, i, cellsOf(s.panel.querySelector(`[data-i="${i}"]`)).length ? 0 : -1); return; }
  }
}

function menuKey(key) {
  if (!menu) return;
  const s = menu.stack[menu.level];
  const it = s.items[s.sel];
  const cells = cellsOf(s.panel.querySelector(`[data-i="${s.sel}"]`));
  const typing = menu.typed && performance.now() - menu.typedAt < 700;
  if (key.length !== 1) menu.typed = ''; // any other key starts the typing over
  if (key === 'ArrowDown') moveSel(1);
  else if (key === 'ArrowUp') moveSel(-1);
  else if (key === 'Home') { s.sel = -1; moveSel(1); }
  else if (key === 'End') { s.sel = -1; moveSel(-1); }
  else if (key === 'ArrowRight') {
    if (cells.length && s.cell < cells.length - 1) setSel(menu.level, s.sel, s.cell + 1);
    else if (it?.submenu) openSub(menu.level, s.sel, true);
  } else if (key === 'ArrowLeft') {
    if (cells.length && s.cell > 0) setSel(menu.level, s.sel, s.cell - 1);
    else if (menu.level > 0) backTo(menu.level - 1);
  } else if (key === 'Enter' || (key === ' ' && !typing)) activate(menu.level, s.sel, s.cell, true);
  else if (key === 'Escape') {
    if (menu.level > 0) backTo(menu.level - 1);
    else api.send('overlay:menu', { close: true });
  } else if (key === 'Tab') api.send('overlay:menu', { close: true });
  else if (key.length === 1) typeAhead(key);
}

function setZoom(level) {
  const el = card.querySelector('.zoom-val');
  const was = parseInt(el?.textContent, 10);
  if (!el || was === level) return;
  el.textContent = `${level}%`;
  animate(el, [{ opacity: 0.4, transform: `translateY(${level > was ? 3 : -3}px)` }, { opacity: 1, transform: 'none' }], { duration: 2 });
}

// The pointer selects what it's on and opens a submenu after a moment. On
// the way to an open submenu it may cross other rows: that one stays a
// little longer.
card.addEventListener('pointermove', (e) => {
  if (kind !== 'menu' || !menu || (!e.movementX && !e.movementY)) return;
  const level = menu.stack.findIndex((s) => s.panel === e.target.closest('.mpanel'));
  const row = e.target.closest('[data-i]');
  if (level < 0 || !row) return;
  const i = Number(row.dataset.i);
  const cell = e.target.closest('button[data-cell]');
  const s = menu.stack[level];
  if (s.sel !== i || menu.level !== level || s.cell !== (cell ? Number(cell.dataset.cell) : -1)) setSel(level, i, cell ? Number(cell.dataset.cell) : -1);
  const open = menu.stack[level + 1];
  clearTimeout(menuHover);
  if (open?.from === i) closeSubs(level + 2);
  else if (open || s.items[i].submenu) {
    menuHover = setTimeout(() => { closeSubs(level + 1); if (s.items[i].submenu) openSub(level, i); }, open ? 250 : 120);
  }
});
// Off the menu: nothing stays selected, except a row whose submenu is open.
card.addEventListener('pointerout', (e) => {
  if (kind !== 'menu' || !menu || e.relatedTarget?.closest?.('.mpanel')) return;
  const s = menu.stack[menu.stack.length - 1];
  if (s.sel >= 0) setSel(menu.stack.length - 1, -1);
});
card.addEventListener('click', (e) => {
  if (kind !== 'menu' || !menu) return;
  const level = menu.stack.findIndex((s) => s.panel === e.target.closest('.mpanel'));
  const row = e.target.closest('[data-i]');
  if (level < 0 || !row) return;
  const cell = e.target.closest('button[data-cell]');
  if (cellsOf(row).length && !cell) return; // the row's name, not one of its buttons
  activate(level, Number(row.dataset.i), cell ? Number(cell.dataset.cell) : 0);
});
// A click anywhere else closes it (and goes no further).
document.addEventListener('mousedown', (e) => {
  if (kind !== 'menu' || !entered || e.target.closest('.mpanel')) return;
  e.preventDefault();
  api.send('overlay:menu', { close: true });
});
document.addEventListener('keydown', (e) => {
  if (kind !== 'menu' || !entered) return;
  // A shortcut closes it (and still does what it does).
  if (e.metaKey || e.ctrlKey || e.altKey) {
    if (!/^(Meta|Control|Alt|Shift|AltGraph)$/.test(e.key)) api.send('overlay:menu', { close: true });
    return;
  }
  e.preventDefault();
  menuKey(e.key);
});

// ------------------------------------------------------------------ showing and hiding
// main/window.js shows a dropdown in steps, so a new one never flashes what
// was there before: 'show' draws it unseen and answers overlay:ready (with
// its height, for those that fit what's in them); then main puts the view
// on top and sends 'in', its entrance, which grows from its button
// (payload.origin). 'out' plays the exit and answers overlay:gone once an
// empty frame is drawn, so main can take the view off. Anything without an
// op is new content for what's showing. Each step can cut the last one short.
const RENDER = {
  suggest: renderSuggest, downloads: renderDownloads, siteinfo: renderSiteInfo, account: renderAccount, autofill: renderAutofill,
  pwsave: renderPwSave, passkey: renderPasskey, update: renderUpdateCard, screenshare: renderScreenShare, popups: renderPopups, hovercard: renderHoverCard, menu: renderMenu,
  zoom: (p) => renderZoom(card, p), tabsearch: (p) => renderTabSearch(card, p),
  permission: (p) => bubble.show(p), // overlay-site.js
  device: (p) => choosers.show(p), clientcert: (p) => choosers.show(p), // overlay-security.js
  perf: (p) => renderPerf(card, p), // overlay-perf.js
};
// These keep the size main gives them; the rest are as tall as what's in them.
const FIXED = new Set(['suggest', 'downloads', 'screenshare', 'menu', 'bm-menu', 'bm-edit', 'tab-group']);
// These draw in a layer of their own over the whole view (overlay-bookmarks.js,
// overlay-groups.js); the card stays out of the way.
const OWN_LAYER = new Set(['bm-menu', 'bm-edit', 'tab-group']);
const PAGE_TOOLS = new Set(['translate', 'share', 'install', 'media']);
// Where each comes in from (scaled toward its button, unless said here).
const ENTER_FROM = { suggest: 'scale(.99, .96)', hovercard: 'translateY(-4px) scale(.98)' };
let kind = null;
let seq = 0; // the step main is on
let entered = false; // on screen
let leaving = false; // playing its exit
let waiting = false; // drawn, waiting for the last one's empty frame to be on screen

const afterPaint = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));
// The element that moves in: the card, or the menu's own panel (its card is
// the whole window).
const surface = () => (kind === 'menu' && card.querySelector('.mpanel')) || card;
function stopMotion() {
  for (const a of card.getAnimations({ subtree: true })) a.cancel();
}

function show(p) {
  seq = p.seq;
  entered = false;
  leaving = false;
  stopMotion();
  card.classList.remove('shown');
  card.removeAttribute('style');
  if (OWN_LAYER.has(p.kind)) card.style.display = 'none';
  card.removeAttribute('role');
  card.removeAttribute('aria-label');
  kind = p.kind;
  document.body.dataset.kind = kind;
  if (kind !== 'hovercard') cardTab = null;
  if (kind !== 'permission') bubble.hide();
  if (!choosers.owns(kind)) choosers.show(p); // (forgets the last one)
  fitBody(p);
  RENDER[kind]?.(p, true);
  aim(p.origin);
  const s = seq;
  // (If main didn't wait for this, its window being hidden, only the height is news.)
  const ready = () => {
    if (s !== seq) return;
    waiting = false;
    api.send('overlay:ready', { seq: s, height: FIXED.has(kind) ? null : naturalHeight() });
  };
  // Something may still be on screen: let the empty frame be drawn first
  // (and until then, new content waits for this answer too: see fit).
  waiting = !!p.wait;
  if (waiting) afterPaint(ready); else ready();
  if (!FIXED.has(kind) && document.fonts.status !== 'loaded') document.fonts.ready.then(() => { if (s === seq) fit(); });
}

function update(p) {
  if (p.kind !== kind) return;
  fitBody(p);
  RENDER[kind]?.(p, false);
  if (!FIXED.has(kind)) fit();
}

function enter() {
  entered = true;
  waiting = false;
  card.classList.add('shown');
  animate(surface(), [{ opacity: 0, transform: ENTER_FROM[kind] || 'scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: kind === 'suggest' ? 2 : 3 });
  if (kind === 'suggest') revealRows();
}

// Leaves from wherever it is (an entrance cut short fades from there).
function leave(now) {
  const s = seq;
  const from = getComputedStyle(surface());
  const keyframes = [{ opacity: from.opacity, transform: surface() === card ? from.transform : 'none' }, { opacity: 0, transform: 'scale(.98)' }];
  entered = false;
  leaving = !now;
  stopMotion();
  card.classList.remove('shown');
  if (now) return;
  const a = animate(card, keyframes, { duration: kind === 'suggest' || kind === 'hovercard' ? 1 : 2, easing: 'in' });
  const done = () => afterPaint(() => {
    if (s !== seq || !leaving) return;
    leaving = false;
    api.send('overlay:gone', { seq: s });
  });
  if (a) a.onfinish = done; else done();
}

// Lays it out at the view's size even before the view has it.
function fitBody(p) {
  if (!p.width) return;
  document.body.style.width = `${p.width}px`;
  document.body.style.height = FIXED.has(kind) && p.height ? `${p.height}px` : '';
}

// Grows from its button: origin is that point in the view.
function aim(origin) {
  const el = surface();
  if (!origin) return;
  const r = el.getBoundingClientRect();
  el.style.transformOrigin = `${Math.round(origin.x - r.left)}px ${Math.round(origin.y - r.top)}px`;
  if (el !== card) card.style.transformOrigin = `${origin.x}px ${origin.y}px`;
}

// Its natural height, and room for the shadow (a scroll box never reports
// less than it has).
function naturalHeight() {
  card.style.height = 'auto';
  const h = card.getBoundingClientRect().height;
  card.style.height = '';
  return Math.ceil(h) + 2 + 22;
}
// What's in it changed: before it's on screen that's a new overlay:ready,
// after it's overlay:size.
function fit() {
  if (leaving || waiting) return;
  if (entered) api.send('overlay:size', { height: naturalHeight() });
  else api.send('overlay:ready', { seq, height: naturalHeight() });
}

// Page tools: the translate bubble, Share, Install app and media controls
// (they handle their own clicks and keys; overlay-translate.js,
// overlay-share.js, overlay-media.js). Async changes (a QR code drawn, a
// track changing) re-measure like any other new content.
const toolFit = () => requestAnimationFrame(() => { if (PAGE_TOOLS.has(kind)) fit(); });
const translateBubble = initTranslateBubble(card, api, () => kind === 'translate');
const isOpen = (k) => kind === k;
const pageTools = { share: initShareBubble(card, api, isOpen, toolFit), install: initInstallDialog(card, api, isOpen, toolFit), media: initMediaHub(card, api, isOpen, toolFit) };
RENDER.translate = (p) => translateBubble.render(p);
for (const k of Object.keys(pageTools)) RENDER[k] = (p) => pageTools[k].render(p);
// Autofill's address and card dropdowns and Save bubble, the puzzle-piece
// menu and the new tab page question, Report an issue (overlay-autofill.js,
// overlay-extensions.js, overlay-help.js: they measure themselves).
for (const ui of [autofillUi, extUi, helpUi]) for (const k of ui.KINDS) RENDER[k] = (p, first) => ui.render(k, p, card, api, first);

api.on('overlay-data', (p) => {
  if (p.op === 'in') { if (p.seq === seq && !entered) enter(); return; }
  if (p.op === 'out') { seq = p.seq; leave(!!p.now); return; }
  if (p.op === 'key') { if (kind === 'menu' && entered) menuKey(p.key); return; }
  if (p.op === 'zoom') { if (kind === 'menu') setZoom(p.level); return; }
  if (p.accent) setAccent(document.documentElement, p.accent); // { dark, light } from the shell
  if (p.op === 'show') show(p);
  else update(p);
});
card.addEventListener('click', (e) => { autofillUi.click(kind, e, card); extUi.click(kind, e, card); });
document.addEventListener('keydown', (e) => { autofillUi.keydown(kind, e, card); extUi.keydown(kind, e, card); helpUi.keydown(kind, e, card); });
window.addEventListener('blur', () => extUi.blur(kind));

// Blocked pop-ups: clicks (and Enter on a button) pick; Esc closes.
card.addEventListener('click', (e) => {
  if (kind !== 'popups') return;
  const item = e.target.closest('[data-pb]');
  const act = e.target.closest('[data-pb-act]')?.dataset.pbAct;
  if (item) api.send('site:popup-open', Number(item.dataset.pb));
  else if (act === 'manage') api.send('site:settings');
  else if (act === 'done') {
    const choice = card.querySelector('input[name=pb]:checked')?.value;
    if (choice) api.send('site:popups-allow', choice === 'allow');
  } else return;
  api.send('overlay:pick', { kind });
});
document.addEventListener('keydown', (e) => {
  if (kind === 'popups' && e.key === 'Escape') { e.preventDefault(); api.send('overlay:pick', { kind }); }
});
initZoom(card, api, () => kind);
initTabSearch(card, api, () => kind);

// The performance popup's buttons answer clicks and keys (overlay-perf.js).
card.addEventListener('click', (e) => { if (kind === 'perf') perfAction(e, api); });
document.addEventListener('keydown', (e) => { if (kind === 'perf' && e.key === 'Escape') api.send('perf:close'); });

card.addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-perm]');
  if (kind !== 'siteinfo' || !sel) return;
  api.send('site:set-permission', { permission: sel.dataset.perm, value: sel.value });
  // JavaScript, images and insecure content apply when the page loads again.
  if ('reload' in sel.dataset) { card.querySelector('.si-reload').hidden = false; fit(); }
});

// The screen sharing picker with the keyboard: Enter or Space on a choice, Esc to cancel.
card.addEventListener('click', (e) => {
  if (kind === 'screenshare' && e.detail === 0) pickShare(e);
  // Keep or Discard a risky download with the keyboard too (the mouse acts on mousedown below).
  if (kind === 'downloads' && e.detail === 0) downloadAct(e);
});
card.addEventListener('keydown', (e) => {
  if (kind !== 'screenshare' || e.key !== 'Escape') return;
  e.preventDefault();
  api.send('overlay:pick', { kind, id: Number(card.dataset.prompt), source: null });
});

card.addEventListener('mousedown', async (e) => {
  if (kind === 'popups') return; // its buttons and choices work like normal ones (see above)
  if (kind === 'tabsearch') return; // overlay-tabsearch.js has its own
  if (kind === 'permission' || choosers.owns(kind)) return; // overlay-site.js and overlay-security.js handle their own clicks
  if (kind === 'perf') return;
  if (PAGE_TOOLS.has(kind)) return; // their buttons, boxes and lists work normally (overlay-translate.js, overlay-share.js, overlay-media.js)
  if (autofillUi.KINDS.has(kind)) { autofillUi.mousedown(kind, e, card); return; }
  if (extUi.KINDS.has(kind) || helpUi.KINDS.has(kind)) return; // buttons and fields work normally
  if (kind === 'screenshare') {
    if (!e.target.closest('#ss-audio, .ss-audio')) pickShare(e);
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
    else if (act === 'close-guest') api.send('account:close-guest');
    else if (act.startsWith('profile:')) api.send('profiles:open', act.slice(8));
    else if (act === 'profiles:add') api.send('profiles:manage', 'add');
    else if (act === 'profiles:guest') api.send('profiles:guest');
    else if (act === 'profiles:manage') api.send('profiles:manage');
    else if (act.startsWith('open:')) api.send('account:open', act.slice(5));
    else if (act.startsWith('page:')) api.send('account:page', act.slice(5));
    if (act !== 'cancel') api.send('overlay:pick', { kind });
    return;
  }
  if (kind === 'siteinfo') {
    const act = e.target.closest('[data-si]')?.dataset.si;
    if (act === 'clear') api.send('site:clear-data');
    if (act === 'cert-revoke') api.send('site:cert-revoke');
    if (act === 'reset') api.send('site:reset-permissions');
    if (act === 'reload') { api.send('tab:reload'); api.send('overlay:pick', { kind }); }
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
  } else if (kind === 'downloads') downloadAct(e);
});

function downloadAct(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  api.send('download:action', { id: btn.dataset.id, action: btn.dataset.act });
  if (['open', 'show', 'all'].includes(btn.dataset.act)) api.send('overlay:pick', { kind });
}
