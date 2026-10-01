import './keys.js';
const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const AVATAR_COLORS = ['#86b7ff', '#b58cff', '#7ee2a8', '#ffb86b', '#ff8fc7', '#ff7a7a', '#ffd479', '#e4e4e7'];
const THEMES = { blue: '#86b7ff', purple: '#b58cff', green: '#7ee2a8', orange: '#ffb86b', pink: '#ff8fc7', mono: '#e4e4e7' };

let s = await page.invoke('page:settings');
$('#version').textContent = 'v' + s.version;

// ---- updates (About)
function renderUpdate(u) {
  const status = $('#update-status');
  const action = $('#update-action');
  action.disabled = false;
  action.classList.remove('primary');
  if (!u) { status.textContent = 'Updates are checked in installed copies of Lumio Browser.'; return; }
  const text = {
    idle: 'Lumio Browser checks for updates automatically.',
    checking: 'Checking for updates…',
    current: `You have the latest version (${u.current}).`,
    available: `Lumio Browser ${u.latest} is available.`,
    downloading: `Downloading ${u.latest}… ${u.progress || 0}%`,
    ready: `Lumio Browser ${u.latest} is downloaded and ready to install.`,
    installing: 'Restarting to finish the update…',
    manual: `The ${u.latest} installer is open. Drag Lumio Browser into Applications to finish.`,
  }[u.status] || '';
  status.textContent = u.error || text;
  const canInstall = ['available', 'ready'].includes(u.status);
  action.textContent = canInstall ? (u.status === 'ready' ? 'Restart to update' : 'Update now') : 'Check for updates';
  action.classList.toggle('primary', canInstall);
  action.disabled = ['checking', 'downloading', 'installing'].includes(u.status);
}
renderUpdate(s.update);
$('#update-action').addEventListener('click', async () => {
  const u = s.update;
  $('#update-action').disabled = true;
  if (u && ['available', 'ready'].includes(u.status)) {
    $('#update-status').textContent = `Downloading ${u.latest}…`;
    s.update = await page.invoke('page:update-now');
  } else {
    $('#update-status').textContent = 'Checking for updates…';
    s.update = await page.invoke('page:check-updates');
  }
  renderUpdate(s.update);
});
if (s.platform !== 'darwin') {
  document.querySelectorAll('.mac-only').forEach((el) => { el.hidden = true; });
  document.querySelectorAll('.kbd-mod').forEach((el) => { el.textContent = 'Ctrl+'; });
}

function avatar(profile, account, size) {
  const box = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.46)}px`;
  if (profile.photo && profile.photo.startsWith('data:image/')) return `<span class="avatar" style="${box}"><img src="${esc(profile.photo)}" alt=""></span>`;
  const name = (profile.name || account.name || account.email || '').trim();
  const letter = name ? esc([...name][0].toUpperCase()) : '?';
  return `<span class="avatar" style="${box};background:${esc(profile.color || '#86b7ff')}">${letter}</span>`;
}

// ------------------------------------------------------------ account
let pollTimer = null;
function renderAccount() {
  const a = s.account;
  const p = s.profile;
  $('#me-avatar').innerHTML = avatar(p, a, 44);
  $('#me-name').textContent = p.name || a.name || (a.signedIn ? a.email : 'Lumio Browser');
  $('#me-email').textContent = a.signedIn ? a.email : 'Not signed in';
  $('#me-plan').hidden = !a.planName;
  $('#me-plan').textContent = a.planName ? `Lumio ${a.planName}` : '';
  $('#me-plan').className = 'pill' + (a.paid ? ' ok' : '');
  $('#sign-in').hidden = a.signedIn || a.connecting;
  $('#manage').hidden = !a.signedIn;
  $('#sign-out').hidden = !a.signedIn;
  $('#connecting').hidden = !a.connecting;
  $('#account-error').hidden = !a.error;
  $('#account-error .desc').textContent = a.error || '';
  renderPlan();
  clearTimeout(pollTimer);
  if (a.connecting) pollTimer = setTimeout(async () => { s.account = await page.invoke('page:account'); renderAccount(); }, 1500);
}
$('#sign-in').addEventListener('click', async () => {
  const res = await page.invoke('page:account-sign-in');
  s.account = await page.invoke('page:account');
  if (!res?.ok) s.account.error = res?.error || s.account.error;
  renderAccount();
});
$('#cancel-sign-in').addEventListener('click', async () => { s.account = await page.invoke('page:account-cancel'); renderAccount(); });
$('#sign-out').addEventListener('click', async () => { s.account = await page.invoke('page:account-sign-out'); renderAccount(); });
$('#manage').addEventListener('click', () => page.invoke('page:account-open', 'manage'));
window.addEventListener('focus', async () => {
  if (!s.account.signedIn && !s.account.connecting) return;
  s.account = await page.invoke('page:account-refresh');
  renderAccount();
});

// ------------------------------------------------------------ profile
function renderProfile() {
  const p = s.profile;
  if (document.activeElement !== $('#p-name')) $('#p-name').value = p.name || '';
  $('#p-name').placeholder = s.account.name || 'Your name';
  $('#p-preview').innerHTML = avatar(p, s.account, 34);
  $('#p-photo-remove').hidden = !p.photo;
  $('#p-colors').innerHTML = AVATAR_COLORS.map((c) => `<button class="swatch ${p.color === c && !p.photo ? 'on' : ''}" style="background:${c}" data-color="${c}" title="${c}" aria-label="Avatar color ${c}"></button>`).join('');
  $('#p-themes').innerHTML = Object.entries(THEMES).map(([id, c]) => `<button class="swatch ${p.theme === id ? 'on' : ''}" style="background:${c}" data-theme="${id}" title="${id}" aria-label="Theme ${id}"></button>`).join('');
  document.documentElement.style.setProperty('--accent', THEMES[p.theme] || THEMES.blue);
  renderAccount();
}
async function saveProfile(patch) {
  s.profile = await page.invoke('page:set-profile', patch);
  renderProfile();
}
let nameTimer;
$('#p-name').addEventListener('input', (e) => { clearTimeout(nameTimer); nameTimer = setTimeout(() => saveProfile({ name: e.target.value }), 300); });
$('#p-colors').addEventListener('click', (e) => { const c = e.target.closest('[data-color]')?.dataset.color; if (c) saveProfile({ color: c, photo: null }); });
$('#p-themes').addEventListener('click', (e) => { const t = e.target.closest('[data-theme]')?.dataset.theme; if (t) saveProfile({ theme: t }); });
$('#p-photo').addEventListener('click', async () => { s.profile = await page.invoke('page:profile-photo'); renderProfile(); });
$('#p-photo-remove').addEventListener('click', () => saveProfile({ photo: null }));

// ------------------------------------------------------------ plan
function when(t) {
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
// The plan, and how much of this week's limit is left.
function renderPlan() {
  const a = s.account;
  if (!a.signedIn) {
    $('#plan-card').innerHTML = `<div class="plan-top"><div class="grow"><div class="plan-name">Lumio</div><div class="desc">Sign in to see your plan and how much of your weekly limit is left.</div></div><button class="btn" id="plan-sign-in">Sign in</button></div>`;
    $('#plan-sign-in').onclick = () => $('#sign-in').click();
    return;
  }
  const w = (a.usage?.windows || []).find((x) => x.id === 'weekly') || a.usage;
  const left = w?.limit ? Math.max(0, Math.min(100, Math.round((w.remaining / w.limit) * 100))) : null;
  const usage = left == null ? '' : `
    <div class="usage">
      <div class="usage-top"><span class="title">Weekly limit</span><span class="usage-left"><b>${left}%</b> left</span></div>
      <div class="meter"><i style="width:${left}%"></i></div>
      <div class="desc">${w.used > 0 && w.fullAt ? `Fully refilled by ${esc(when(w.fullAt))}` : 'All of this week’s usage is available'} · No 5-hour limits</div>
    </div>`;
  $('#plan-card').innerHTML = `<div class="plan-top"><div class="grow"><div class="desc">Your plan</div><div class="plan-name">Lumio ${esc(a.planName || 'Free')}</div></div>
      ${a.plan !== 'max' ? '<button class="btn primary" data-open="upgrade">Upgrade</button>' : ''}
      <button class="btn" data-open="billing">Manage billing</button></div>${usage}`;
  $('#plan-card').querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => page.invoke('page:account-open', b.dataset.open); });
}

// ------------------------------------------------------------ Lumio AI: thinking effort + approvals
document.querySelectorAll('input[name=reasoning]').forEach((r) => {
  r.checked = r.value === s.ai.reasoning;
  r.addEventListener('change', () => page.invoke('page:set-setting', 'reasoning', r.value));
});
document.querySelectorAll('input[name=mode]').forEach((r) => {
  r.checked = r.value === s.approvalMode;
  r.addEventListener('change', () => page.invoke('page:set-setting', 'approvalMode', r.value));
});

async function perms() {
  if (s.platform !== 'darwin') {
    $('#perm-note').textContent = s.ai.macAvailable
      ? 'Lumio can use the mouse, keyboard and take screenshots on this PC. It asks before doing so unless you choose Bypass.'
      : 'Computer control isn’t available on this system.';
    return;
  }
  try {
    const p = await page.invoke('page:mac-permissions');
    for (const k of ['accessibility', 'screen']) {
      const el = $('#perm-' + k);
      if (p[k] === undefined) { el.textContent = 'Unknown'; continue; }
      el.textContent = p[k] ? 'On' : 'Off';
      el.className = 'pill ' + (p[k] ? 'ok' : 'bad');
    }
    if (p.error) $('#perm-note').textContent = p.error;
  } catch (e) { $('#perm-note').textContent = String(e.message || e); }
}
document.querySelectorAll('[data-perm]').forEach((b) => b.addEventListener('click', () => page.invoke('page:mac-permissions-open', b.dataset.perm)));
window.addEventListener('focus', perms);

// ------------------------------------------------------------ passwords
$('#offer-pw').checked = s.offerPasswords;
$('#autofill-pw').checked = s.autofillPasswords;
$('#offer-pw').addEventListener('change', (e) => page.invoke('page:set-setting', 'offerPasswords', e.target.checked));
$('#autofill-pw').addEventListener('change', (e) => page.invoke('page:set-setting', 'autofillPasswords', e.target.checked));

// ------------------------------------------------------------ privacy
$('#clear').addEventListener('click', async () => {
  const what = [...document.querySelectorAll('.checks input[value]:checked')].map((i) => i.value);
  if (!what.length) return;
  $('#clear').disabled = true;
  await page.invoke('page:clear-data', { range: 0, what });
  $('#clear').disabled = false;
  $('#clear-status').textContent = 'Cleared.';
});

const PERM_NAMES = { geolocation: 'Location', media: 'Camera and microphone', notifications: 'Notifications', 'clipboard-read': 'Clipboard', midi: 'MIDI devices', midiSysex: 'MIDI devices', 'display-capture': 'Screen sharing', 'idle-detection': 'Idle detection' };
function renderSites() {
  const list = s.sitePermissions.filter((x) => Object.keys(x.perms).length);
  if (!list.length) {
    $('#site-list').innerHTML = '<div class="row"><div class="desc">When you allow or block a site from using your camera, location or notifications, it shows up here.</div></div>';
    return;
  }
  $('#site-list').innerHTML = list.map((site) => `
    <div class="row site" data-origin="${esc(site.origin)}">
      <div class="grow"><div class="title">${esc(site.origin.replace(/^https?:\/\//, ''))}</div>
        <div class="desc">${Object.entries(site.perms).map(([p, v]) => `${esc(PERM_NAMES[p] || p)}: <b style="color:${v ? 'var(--ok)' : 'var(--danger)'}">${v ? 'Allowed' : 'Blocked'}</b>`).join(' · ')}</div></div>
      <button class="btn" data-reset>Reset</button>
    </div>`).join('');
}
$('#site-list').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-reset]')?.closest('.site');
  if (!row) return;
  const site = s.sitePermissions.find((x) => x.origin === row.dataset.origin);
  for (const p of Object.keys(site?.perms || {})) await page.invoke('page:set-site-permission', site.origin, p, 'ask');
  s = await page.invoke('page:settings');
  renderSites();
});

// ------------------------------------------------------------ appearance, search, downloads, startup, default
$('#bm-bar').checked = s.showBookmarksBar;
$('#bm-bar').addEventListener('change', (e) => page.invoke('page:set-setting', 'showBookmarksBar', e.target.checked));

$('#engine').innerHTML = s.engines.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
$('#engine').value = s.searchEngine;
$('#engine').addEventListener('change', (e) => page.invoke('page:set-setting', 'searchEngine', e.target.value));

$('#dl-dir').textContent = s.downloadDir;
$('#dl-ask').checked = s.askDownload;
$('#dl-ask').addEventListener('change', (e) => page.invoke('page:set-setting', 'askDownload', e.target.checked));
$('#dl-change').addEventListener('click', async () => { $('#dl-dir').textContent = await page.invoke('page:choose-download-dir'); });

document.querySelectorAll('input[name=startup]').forEach((r) => {
  r.checked = r.value === s.startup;
  r.addEventListener('change', () => page.invoke('page:set-setting', 'startup', r.value));
});

if (s.isDefault) { $('#make-default').disabled = true; $('#make-default').textContent = 'Default'; }
$('#make-default').addEventListener('click', async () => {
  const ok = await page.invoke('page:make-default');
  $('#default-desc').textContent = ok ? 'Your system will ask you to confirm.' : 'Only the installed app can become the default browser.';
});

// ------------------------------------------------------------ import
const sources = s.importSources;
if (!sources.length) {
  $('#import-from').innerHTML = '<option>No other browsers found</option>';
  $('#import-from').disabled = true;
  $('#import-go').disabled = true;
} else {
  $('#import-from').innerHTML = sources.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
}
function importPwOption() {
  const src = sources.find((b) => b.id === $('#import-from').value);
  $('#import-pw-wrap').hidden = !src?.passwords;
}
$('#import-from').addEventListener('change', importPwOption);
importPwOption();
function importSaid(text, ok) {
  const desc = $('#import-desc');
  desc.textContent = text;
  desc.style.color = ok ? 'var(--ok)' : 'var(--danger)';
}
const counted = (res) => {
  const parts = [];
  if (res.bookmarks) parts.push(`${res.bookmarks} bookmark${res.bookmarks === 1 ? '' : 's'}`);
  if (res.history) parts.push(`${res.history} history entr${res.history === 1 ? 'y' : 'ies'}`);
  const pw = res.passwords ? res.passwords.added + res.passwords.updated : 0;
  if (pw) parts.push(`${pw} password${pw === 1 ? '' : 's'}`);
  return parts.length ? `Imported ${parts.join(', ')}${res.browser ? ` from ${res.browser}` : ''}.` : 'Nothing new to import.';
};
$('#import-go').addEventListener('click', async () => {
  const bookmarks = $('#import-bm').checked;
  const history = $('#import-hist').checked;
  const passwords = !$('#import-pw-wrap').hidden && $('#import-pw').checked;
  if (!bookmarks && !history && !passwords) return;
  $('#import-go').disabled = true;
  $('#import-go').textContent = 'Importing…';
  $('#import-access').hidden = true;
  const res = await page.invoke('page:import', $('#import-from').value, { bookmarks, history, passwords });
  $('#import-go').disabled = false;
  $('#import-go').textContent = 'Import';
  if (res.needsAccess) { $('#import-access').hidden = false; importSaid(res.error, false); return; }
  if (!res.ok) { importSaid(res.error, false); return; }
  importSaid(counted(res) + (res.passwordError ? ` ${res.passwordError}` : ''), !res.passwordError);
});
$('#import-open-access').addEventListener('click', () => page.invoke('page:open-disk-access'));
document.querySelectorAll('[data-import-file]').forEach((b) => b.addEventListener('click', async () => {
  const res = await page.invoke('page:import-file', b.dataset.importFile);
  if (res.canceled) return;
  if (!res.ok) importSaid(res.error || 'Couldn’t import that file.', false);
  else importSaid(counted(res), true);
}));

// ------------------------------------------------------------ sidebar highlight
const links = [...document.querySelectorAll('.side a')];
const spy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id));
  }
}, { rootMargin: '-10% 0px -80% 0px' });
document.querySelectorAll('main section').forEach((sec) => spy.observe(sec));

renderProfile();
renderSites();
perms();
if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
