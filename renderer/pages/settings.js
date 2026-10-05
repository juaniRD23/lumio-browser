import './keys.js';
import { THEME_COLORS, accentFor, setAccent } from '/assets/theme-colors.js';
const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const AVATAR_COLORS = ['#86b7ff', '#b58cff', '#7ee2a8', '#ffb86b', '#ff8fc7', '#ff7a7a', '#ffd479', '#e4e4e7'];

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
    manual: /Mac/.test(navigator.platform) ? `The ${u.latest} installer is open. Drag Lumio Browser into Applications to finish.` : `The ${u.latest} installer is open. Follow it to finish.`,
    store: 'The Microsoft Store keeps Lumio Browser up to date.',
  }[u.status] || '';
  status.textContent = u.error || text;
  const canInstall = ['available', 'ready'].includes(u.status);
  action.textContent = canInstall ? (u.status === 'ready' ? 'Restart to update' : 'Update now') : 'Check for updates';
  action.classList.toggle('primary', canInstall);
  action.disabled = ['checking', 'downloading', 'installing'].includes(u.status);
  action.hidden = u.status === 'store';
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
  renderAccount(); // reloads the subscription too
});

// ------------------------------------------------------------ profile
function renderProfile() {
  const p = s.profile;
  if (document.activeElement !== $('#p-name')) $('#p-name').value = p.name || '';
  $('#p-name').placeholder = s.account.name || 'Your name';
  $('#p-preview').innerHTML = avatar(p, s.account, 34);
  $('#p-photo-remove').hidden = !p.photo;
  $('#p-colors').innerHTML = AVATAR_COLORS.map((c) => `<button class="swatch ${p.color === c && !p.photo ? 'on' : ''}" style="background:${c}" data-color="${c}" title="${c}" aria-label="Avatar color ${c}"></button>`).join('');
  // Each swatch shows the shade the current appearance uses.
  $('#p-themes').innerHTML = Object.entries(THEME_COLORS).map(([id, c]) => `<button class="swatch ${p.theme === id ? 'on' : ''}" style="background:light-dark(${c.light},${c.dark})" data-theme="${id}" title="${id}" aria-label="Theme ${id}"></button>`).join('');
  setAccent(document.documentElement, accentFor(p.theme));
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
      ${a.plan === 'free' ? '<button class="btn primary" id="see-plans">See plans</button>' : ''}</div>${usage}`;
  $('#see-plans')?.addEventListener('click', () => $('#billing').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  loadBilling();
}

// ------------------------------------------------------------ subscription
// Subscribe (Lumio's payment window, never a Stripe tab), switch plans,
// cancel with a reason, resume, update the card. The Lumio server does the
// Stripe side (main.js billingCall / openCheckout).
const DESCS = {
  go: 'Thousands of messages, about 120 browser tasks and 55 pictures a week, with GPT-6 Luna, Ling and DeepSeek.',
  plus: 'Thousands of messages and hundreds of browser tasks a week, about 100 pictures, and Claude Sonnet, GPT-6.1 Sol, Gemini and Grok in Chat.',
  pro: 'About 6× Plus, and every model, including Claude Opus and GPT-6 Astra.',
  max: 'About 11× Plus, and every model.',
};
const ORDER = ['free', 'go', 'plus', 'pro', 'max'];
const BRANDS = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', jcb: 'JCB', diners: 'Diners Club', unionpay: 'UnionPay' };
const day = (t) => new Date(t).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
let bill = null; // the last answer from page:billing
let billOpen = null; // 'change' | 'cancel' | null
let billNote = null; // { text, bad } shown at the top after an action
let loadingBill = false;
let reloadBill = false;

async function loadBilling() {
  if (!s.account.signedIn) { $('#billing').hidden = true; return; }
  $('#billing').hidden = false;
  if (loadingBill) { reloadBill = true; return; }
  loadingBill = true;
  if (!bill) $('#billing-card').innerHTML = '<div class="bill-msg">Loading your subscription…</div>';
  try { bill = await page.invoke('page:billing'); } catch { bill = { ok: false, error: 'Couldn’t load your subscription.' }; }
  loadingBill = false;
  if (reloadBill) { reloadBill = false; loadBilling(); return; }
  renderBilling();
}

function renderBilling() {
  const card = $('#billing-card');
  if (!bill?.ok) {
    card.innerHTML = `<div class="bill-msg"><span class="err">${esc(bill?.error || 'Couldn’t load your subscription.')}</span> <button class="btn" id="bill-retry">Try again</button></div>`;
    $('#bill-retry').onclick = () => { bill = null; loadBilling(); };
    return;
  }
  const note = billNote ? `<div class="bill-note ${billNote.bad ? 'bad' : ''}" role="status">${esc(billNote.text)}</div>` : '';
  const sub = bill.subscription;
  $('#billing-title').textContent = sub ? 'Subscription' : 'Choose a plan';
  // A plan from a code: when it ends; any plan can still be bought.
  const codeNote = bill.code ? `<div class="bill-note" role="status">You’re on Lumio ${esc(bill.code.planName)} from a code${bill.code.until ? `, until ${esc(day(bill.code.until))}` : ''}. After that you’re on Free, unless you subscribe.</div>` : '';
  const codeForm = `<form class="bill-code" id="bill-code" autocomplete="off">
      <label for="bill-code-input">Have a code?</label>
      <input class="field" id="bill-code-input" placeholder="PLUS-XXXX-XXXX-XXXX" spellcheck="false" maxlength="40">
      <button class="btn" type="submit" id="bill-code-go">Use code</button>
    </form>`;
  if (!sub) {
    card.innerHTML = `${note}${codeNote}<div class="bill-plans">${(bill.allPlans || bill.plans).map((p) => `
      <article class="bill-plan ${p.id === 'plus' ? 'pick' : ''}">
        <div class="bp-name">${esc(p.name)}${p.id === 'plus' ? '<span class="pill">Most popular</span>' : ''}</div>
        <div class="bp-price">$${p.price}<small> a month</small></div>
        <p class="bp-desc">${esc(DESCS[p.id] || '')}</p>
        <button class="btn ${p.id === 'plus' ? 'accent' : ''}" data-subscribe="${esc(p.id)}">Subscribe</button>
      </article>`).join('')}</div>
      <p class="bill-fine">You pay securely inside Lumio. Cancel anytime: you keep your plan until the end of the month you paid for.</p>
      ${codeForm}`;
    card.querySelectorAll('[data-subscribe]').forEach((b) => { b.onclick = () => subscribe(b.dataset.subscribe, b); });
    $('#bill-code').onsubmit = (e) => { e.preventDefault(); redeem(); };
    return;
  }

  const name = `Lumio ${bill.planName}`;
  const cardText = sub.card ? `${BRANDS[sub.card.brand] || sub.card.brand} ending ${sub.card.last4}` : '';
  const state = sub.status === 'past_due' ? { pill: '<span class="pill bad">Payment problem</span>', desc: 'Your last payment didn’t go through. Update your card to keep your plan.' }
    : sub.canceling ? { pill: '<span class="pill warn">Ending</span>', desc: `Ends on ${day(sub.periodEnd)}. After that you’re on Free.` }
      : { pill: '<span class="pill ok">Active</span>', desc: `Renews on ${day(sub.periodEnd)}${cardText ? ` · ${cardText}` : ''}` };
  const others = (bill.allPlans || bill.plans).filter((p) => p.id !== bill.plan);
  card.innerHTML = `${note}
    <div class="bill-top">
      <div class="grow"><div class="title">${esc(name)} · $${sub.price} a month</div><div class="desc">${esc(state.desc)}</div></div>
      ${state.pill}
    </div>
    <div class="bill-actions">
      ${sub.canceling ? `<button class="btn accent" id="bill-resume">Keep ${esc(name)}</button>` : ''}
      <button class="btn ${billOpen === 'change' ? 'on' : ''}" id="bill-change">Change plan</button>
      <button class="btn ${sub.status === 'past_due' ? 'accent' : ''}" id="bill-card">${sub.status === 'past_due' ? 'Update card' : 'Card and invoices'}</button>
      <span class="spacer"></span>
      ${sub.canceling ? '' : `<button class="btn danger ${billOpen === 'cancel' ? 'on' : ''}" id="bill-cancel">Cancel subscription</button>`}
    </div>
    ${billOpen === 'change' ? `<div class="bill-panel">${others.map((p) => {
      const up = ORDER.indexOf(p.id) > ORDER.indexOf(bill.plan);
      return `<div class="bill-row">
        <div class="grow"><div class="title">${esc(p.name)} · $${p.price} a month</div><div class="desc">${esc(DESCS[p.id] || '')}</div>
          <div class="desc confirm" hidden>${up ? 'You pay the difference for the rest of this month now, and the bigger allowance starts right away.' : 'Your weekly allowance gets smaller right away. The unused part of this month is credited to your next bill.'}</div></div>
        <button class="btn ${up ? 'accent' : ''}" data-switch="${esc(p.id)}">${up ? 'Upgrade' : 'Switch'}</button>
      </div>`;
    }).join('')}</div>` : ''}
    ${billOpen === 'cancel' ? `<form class="bill-panel bill-cancel" id="cancel-form">
      <div class="title">Why are you canceling?</div>
      <div class="desc">You keep ${esc(name)} until ${esc(day(sub.periodEnd))}, then you’re on Free. Your answer goes straight to the people who build Lumio.</div>
      <div class="reasons">${bill.reasons.map((r) => `<label class="reason"><input type="radio" name="reason" value="${esc(r.id)}"><span>${esc(r.label)}</span></label>`).join('')}</div>
      <textarea class="field" id="cancel-comment" rows="3" maxlength="1000" placeholder="Anything else you’d like to tell us? (optional)"></textarea>
      <div class="bill-form-row"><span class="cancel-msg err" id="cancel-msg"></span><button type="button" class="btn" id="cancel-keep">Keep my plan</button><button type="submit" class="btn danger-fill" id="cancel-go">Cancel subscription</button></div>
    </form>` : ''}`;

  $('#bill-change').onclick = () => { billOpen = billOpen === 'change' ? null : 'change'; billNote = null; renderBilling(); };
  $('#bill-cancel')?.addEventListener('click', () => { billOpen = billOpen === 'cancel' ? null : 'cancel'; billNote = null; renderBilling(); $('#cancel-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  $('#bill-card').onclick = async () => { await page.invoke('page:billing-card'); bill = null; loadBilling(); };
  $('#bill-resume')?.addEventListener('click', () => act($('#bill-resume'), 'page:billing-resume', undefined, `You’re keeping ${name}. Nothing else changes.`));
  card.querySelectorAll('[data-switch]').forEach((b) => {
    b.onclick = () => {
      // First click shows what happens; the second one switches.
      if (!b.dataset.sure) { b.dataset.sure = '1'; b.closest('.bill-row').querySelector('.confirm').hidden = false; b.textContent = 'Confirm'; return; }
      const p = (bill.allPlans || bill.plans).find((x) => x.id === b.dataset.switch);
      act(b, 'page:billing-change', p.id, `You’re on Lumio ${p.name} now.`);
    };
  });
  $('#cancel-keep')?.addEventListener('click', () => { billOpen = null; renderBilling(); });
  $('#cancel-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const reason = new FormData(e.target).get('reason');
    if (!reason) { $('#cancel-msg').textContent = 'Choose a reason first. It helps us make Lumio better.'; return; }
    act($('#cancel-go'), 'page:billing-cancel', { reason, comment: $('#cancel-comment').value }, `Canceled. You keep ${name} until ${day(sub.periodEnd)}, then you’re on Free. Thanks for telling us why.`);
  });
}

// Runs a billing action, then shows the new state with a short note.
async function act(button, channel, arg, done) {
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Working…';
  const res = await page.invoke(channel, arg).catch(() => ({ ok: false, error: 'That didn’t work. Try again.' }));
  if (!res?.ok) {
    button.disabled = false;
    button.textContent = label;
    billNote = { text: res?.error || 'That didn’t work. Try again.', bad: true };
    renderBilling();
    return;
  }
  billOpen = null;
  billNote = { text: done };
  renderBilling();
  s.account = await page.invoke('page:account');
  renderAccount(); // shows the new plan and reloads the subscription
}

// A plan code: a month of a plan, from the people who make Lumio.
async function redeem() {
  const input = $('#bill-code-input');
  const code = input.value.trim();
  if (!code) { input.focus(); return; }
  const button = $('#bill-code-go');
  button.disabled = true;
  button.textContent = 'Checking…';
  const res = await page.invoke('page:billing-redeem', code).catch(() => ({ ok: false }));
  if (res?.ok) {
    billNote = { text: `You’re on Lumio ${res.planName} until ${day(res.until)}. Enjoy!` };
    s.account = await page.invoke('page:account');
    bill = null;
    renderAccount();
    return;
  }
  billNote = { text: res?.error || 'That code didn’t work. Try again.', bad: true };
  renderBilling();
  $('#bill-code-input').value = code;
}

async function subscribe(plan, button) {
  button.disabled = true;
  button.textContent = 'Opening…';
  billNote = null;
  // Resolves when the payment window closes.
  const res = await page.invoke('page:billing-subscribe', plan).catch(() => ({ ok: false }));
  s.account = await page.invoke('page:account');
  if (res?.ok && s.account.plan !== 'free') billNote = { text: `Welcome to Lumio ${s.account.planName}! Your bigger weekly allowance is ready.` };
  else if (res && !res.ok && res.error) billNote = { text: res.error, bad: true };
  bill = null;
  renderAccount();
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
// The rows open their own pages; these show what's set.
if (s.platform !== 'darwin') $('#clear-keys').textContent = 'Ctrl+Shift+Delete';
page.invoke('page:site-settings').then((ss) => {
  const tpc = ss?.categories.find((c) => c.id === 'thirdPartyCookies');
  if (tpc) $('#tpc-desc').textContent = tpc.text[tpc.value];
}).catch(() => {});

// ------------------------------------------------------------ appearance, search, downloads, startup, default
// Theme: System, Light or Dark. It can also change from the View menu or another device.
const appearanceRadios = document.querySelectorAll('input[name=appearance]');
const showAppearance = (value) => appearanceRadios.forEach((r) => { r.checked = r.value === value; });
showAppearance(s.appearance);
appearanceRadios.forEach((r) => r.addEventListener('change', () => page.invoke('page:set-setting', 'appearance', r.value)));
page.on('appearance', showAppearance);

$('#bm-bar').checked = s.showBookmarksBar;
$('#bm-bar').addEventListener('change', (e) => page.invoke('page:set-setting', 'showBookmarksBar', e.target.checked));

$('#engine').innerHTML = s.engines.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
$('#engine').value = s.searchEngine;
$('#engine').addEventListener('change', (e) => page.invoke('page:set-setting', 'searchEngine', e.target.value));

$('#dl-dir').textContent = s.downloadDir;
// Memory Saver
$('#mem-saver').checked = s.memorySaver !== false;
$('#mem-after').value = String(s.memorySaverMinutes || 60);
$('#mem-after-row').classList.toggle('dim', !$('#mem-saver').checked);
$('#mem-saver').addEventListener('change', (e) => { page.invoke('page:set-setting', 'memorySaver', e.target.checked); $('#mem-after-row').classList.toggle('dim', !e.target.checked); });
$('#mem-after').addEventListener('change', (e) => page.invoke('page:set-setting', 'memorySaverMinutes', Number(e.target.value)));

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
perms();
if (location.hash) document.querySelector(location.hash)?.scrollIntoView();

// ---- Scheduled tasks
const STATUS = { running: 'Running now', done: 'Last run finished', error: 'Last run had a problem', stopped: 'Last run was stopped' };
const TRASH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
function nextText(t) {
  if (t.paused) return 'Paused';
  if (t.done || !t.nextRun) return 'Done';
  const d = new Date(t.nextRun);
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Next: today at ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Next: tomorrow at ${time}`;
  return `Next: ${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`;
}
async function loadSchedules() {
  let data;
  try { data = await page.invoke('page:schedules'); } catch { return; }
  const list = $('#sched-list');
  list.innerHTML = data.tasks.map((t) => `
    <div class="row sched-row ${t.paused || t.done ? 'paused' : ''}" data-id="${esc(t.id)}">
      <div class="grow">
        <div class="title"><b>${esc(t.title)}</b></div>
        <div class="desc">${esc(t.when)} · ${esc(nextText(t))}${t.lastStatus ? ` · ${esc(STATUS[t.lastStatus] || '')}` : ''}</div>
        <div class="prompt" title="${esc(t.prompt)}">${esc(t.prompt)}</div>
      </div>
      <div class="acts">
        ${t.lastChatId ? '<button class="btn ghost" data-act="open">Open chat</button>' : ''}
        <button class="btn" data-act="run" ${t.lastStatus === 'running' ? 'disabled' : ''}>Run now</button>
        ${t.done ? '' : `<label class="switch" title="${t.paused ? 'Turn on' : 'Pause'}"><input type="checkbox" data-act="pause" ${t.paused ? '' : 'checked'} aria-label="On"><i></i></label>`}
        <button class="btn ghost icon-btn" data-act="delete" title="Delete" aria-label="Delete ${esc(t.title)}">${TRASH}</button>
      </div>
    </div>`).join('');
}
$('#sched-list').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (!b || !id) return;
  if (b.dataset.act === 'delete') {
    const title = e.target.closest('[data-id]').querySelector('b').textContent;
    if (!confirm(`Delete “${title}”? Lumio won’t run it anymore.`)) return;
    await page.invoke('page:schedule-remove', id);
  } else if (b.dataset.act === 'run') {
    b.disabled = true;
    const r = await page.invoke('page:schedule-run', id);
    if (!r.ok) alert(r.error);
  } else if (b.dataset.act === 'open') await page.invoke('page:schedule-open', id);
  loadSchedules();
});
$('#sched-list').addEventListener('change', async (e) => {
  if (e.target.dataset.act !== 'pause') return;
  await page.invoke('page:schedule-update', e.target.closest('[data-id]').dataset.id, { paused: !e.target.checked });
  loadSchedules();
});
function showSchedForm(on) {
  $('#sched-form').hidden = !on;
  $('#sched-intro').hidden = on;
  $('#sched-err').textContent = '';
  if (on) {
    const d = new Date(Date.now() + 86400000);
    $('#sched-date').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    $('#sched-prompt').focus();
  }
}
function syncRepeat() {
  const r = $('#sched-repeat').value;
  $('#sched-weekday').hidden = r !== 'weekly';
  $('#sched-date').hidden = r !== 'once';
}
$('#sched-new').addEventListener('click', () => showSchedForm(true));
$('#sched-cancel').addEventListener('click', () => { $('#sched-form').reset(); syncRepeat(); showSchedForm(false); });
$('#sched-repeat').addEventListener('change', syncRepeat);
$('#sched-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const repeat = $('#sched-repeat').value;
  const spec = { title: $('#sched-title').value, prompt: $('#sched-prompt').value, repeat, time: $('#sched-time').value };
  if (repeat === 'weekly') spec.weekday = $('#sched-weekday').value;
  if (repeat === 'once') spec.date = $('#sched-date').value;
  const r = await page.invoke('page:schedule-add', spec);
  if (!r.ok) { $('#sched-err').textContent = r.error; return; }
  $('#sched-form').reset();
  syncRepeat();
  showSchedForm(false);
  loadSchedules();
});
syncRepeat();
loadSchedules();
setInterval(() => { if (!document.hidden) loadSchedules(); }, 15000);

// ---- Site tips (main/site-tips.js)
async function loadTips() {
  let sites = [];
  try { sites = (await page.invoke('page:site-tips')).sites || []; } catch { return; }
  $('#tips-intro').hidden = sites.length > 0;
  $('#tips-list').innerHTML = sites.map((s) => s.tips.map((t) => `
    <div class="row tip-row" data-site="${esc(s.site)}" data-tip="${esc(t.tip)}">
      <div class="grow"><div class="title"><b>${esc(s.site)}</b></div><div class="desc">${esc(t.tip)}</div></div>
      <div class="acts"><button class="btn ghost icon-btn" data-act="forget" title="Forget this tip" aria-label="Forget this tip for ${esc(s.site)}">${TRASH}</button></div>
    </div>`).join('')).join('');
}
$('#tips-list').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-act="forget"]')?.closest('.tip-row');
  if (!row) return;
  await page.invoke('page:site-tip-remove', row.dataset.site, row.dataset.tip);
  loadTips();
});
loadTips();

// ---- Workflows
const PENCIL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
let workflowsCache = [];
async function loadWorkflows() {
  try { workflowsCache = (await page.invoke('page:workflows')).workflows || []; } catch { return; }
  $('#wf-intro').hidden = workflowsCache.length > 0;
  $('#wf-list').innerHTML = workflowsCache.map((w) => `
    <div class="row wf-row" data-id="${esc(w.id)}">
      <div class="grow">
        <div class="title"><b>${esc(w.title)}</b></div>
        <div class="desc">${esc(w.description || w.instructions.split('\n')[0].slice(0, 120))}</div>
        <div class="prompt">${w.inputs.length ? `Asks for ${esc(w.inputs.map((i) => i.label).join(', '))} · ` : ''}${w.runs ? `Run ${w.runs} time${w.runs === 1 ? '' : 's'}` : 'Not run yet'}${w.startUrl ? ` · Starts at ${esc(w.startUrl.replace(/^https?:\/\//, '').slice(0, 40))}` : ''}</div>
      </div>
      <div class="acts">
        <button class="btn" data-act="run">Run</button>
        <button class="btn ghost" data-act="schedule" title="Run it on a schedule">Schedule</button>
        <button class="btn ghost icon-btn" data-act="edit" title="Edit" aria-label="Edit ${esc(w.title)}">${PENCIL}</button>
        <button class="btn ghost icon-btn" data-act="delete" title="Delete" aria-label="Delete ${esc(w.title)}">${TRASH}</button>
      </div>
    </div>`).join('');
}
function editWorkflow(row, w) {
  if (row.nextElementSibling?.classList.contains('wf-edit')) { row.nextElementSibling.remove(); return; }
  const form = document.createElement('form');
  form.className = 'sched-form wf-edit';
  form.innerHTML = `<input class="field" name="title" maxlength="60" value="${esc(w.title)}" aria-label="Name">
    <textarea class="field" name="instructions" rows="6" maxlength="6000" aria-label="Instructions">${esc(w.instructions)}</textarea>
    <input class="field" name="startUrl" maxlength="2000" placeholder="Start page (optional)" value="${esc(w.startUrl || '')}" aria-label="Start page">
    <div class="desc" style="color:var(--label)">Put anything that changes each run in curly braces, like {item}: Lumio asks for it when the workflow runs.</div>
    <div class="sched-actions"><span class="desc err"></span><button type="button" class="btn ghost" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>`;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const r = await page.invoke('page:workflow-update', w.id, { title: f.get('title'), instructions: f.get('instructions'), startUrl: f.get('startUrl') });
    if (!r.ok) { form.querySelector('.err').textContent = r.error; return; }
    form.remove();
    loadWorkflows();
  });
  form.querySelector('[data-cancel]').addEventListener('click', () => form.remove());
  row.after(form);
  form.querySelector('textarea').focus();
}
$('#wf-list').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  const row = e.target.closest('[data-id]');
  if (!b || !row) return;
  const w = workflowsCache.find((x) => x.id === row.dataset.id);
  if (!w) return;
  if (b.dataset.act === 'run') {
    const r = await page.invoke('page:workflow-run', w.id);
    if (!r.ok) alert(r.error);
  } else if (b.dataset.act === 'edit') editWorkflow(row, w);
  else if (b.dataset.act === 'delete') {
    if (!confirm(`Delete the workflow “${w.title}”?`)) return;
    await page.invoke('page:workflow-remove', w.id);
    loadWorkflows();
  } else if (b.dataset.act === 'schedule') {
    // The scheduled task form, filled in with this workflow.
    showSchedForm(true);
    $('#sched-title').value = w.title;
    $('#sched-prompt').value = `${w.startUrl ? `Start at ${w.startUrl}\n` : ''}${w.instructions}`;
    $('#scheduled').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (w.inputs.length) $('#sched-err').textContent = `Replace ${w.inputs.map((i) => `{${i.name}}`).join(', ')} with what it should use each time.`;
  }
});
loadWorkflows();
setInterval(() => { if (!document.hidden) loadWorkflows(); }, 15000);

// ---- Sync
const SYNC_TYPES = [['bookmarks', 'Bookmarks'], ['passwords', 'Passwords'], ['history', 'History'], ['tabs', 'Open tabs'], ['chats', 'Lumio chats'], ['workflows', 'Workflows'], ['projects', 'Projects'], ['settings', 'Settings']];
const sinceText = (t) => {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} minutes ago` : s < 86400 ? `${Math.round(s / 3600)} hours ago` : new Date(t).toLocaleDateString();
};
const PHONE_IC = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>';
const LAPTOP_IC = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>';
let syncState = null;
function renderSync(st) {
  syncState = st;
  $('#sync-on').checked = st.on;
  $('#sync-status').textContent = !st.on ? 'Off. Your bookmarks, passwords and chats stay on this computer.'
    : st.status === 'signed-out' ? 'Sign in to Lumio to sync.'
    : st.status === 'needs-key' ? 'Waiting for you to approve this computer.'
    : st.status === 'ready' ? `On · encrypted on your devices${st.lastSync ? ` · synced ${sinceText(st.lastSync)}` : ''}`
    : st.status === 'error' ? `Couldn’t sync: ${st.error || 'try again later.'}`
    : 'Turning on…';
  $('#sync-needs').hidden = !(st.on && st.status === 'needs-key');
  $('#sync-phone').hidden = !(st.on && st.status === 'ready' && st.siteUrl);
  if (st.siteUrl) $('#phone-url').textContent = `${st.siteUrl.replace(/^https?:\/\//, '')}/companion`;
  $('#sync-name').textContent = `“${st.deviceName}”`;
  $('#sync-code').textContent = st.pairCode ? st.pairCode.replace(/(\d{3})/, '$1 ') : '…';
  $('#sync-types').hidden = !st.on;
  $('#sync-types').innerHTML = SYNC_TYPES.map(([k, label]) => `<label><input type="checkbox" data-type="${k}" ${st.types[k] ? 'checked' : ''}> ${label}</label>`).join('');
  $('#sync-requests').innerHTML = (st.requests || []).map((r) => `
    <div class="row sync-request" data-id="${esc(r.id)}">
      <div class="grow"><div class="title">“${esc(r.name)}” wants to sync</div>
        <div class="desc">Only approve it if it shows the code <b class="code-inline">${esc(r.code.replace(/(\d{3})/, '$1 '))}</b>. It will be able to see your bookmarks, passwords, history and chats.</div></div>
      <button class="btn" data-answer="deny">Deny</button><button class="btn primary" data-answer="approve">Approve</button>
    </div>`).join('');
}
async function loadSyncDevices() {
  const r = await page.invoke('page:sync-devices').catch(() => null);
  const list = r?.ok ? r.devices || [] : [];
  const me = syncState?.deviceId;
  $('#sync-devices').innerHTML = list.length ? list.map((d) => `
    <div class="row" data-device="${esc(d.id)}">
      <span class="dev-ic">${d.kind === 'phone' ? PHONE_IC : LAPTOP_IC}</span>
      <div class="grow"><div class="title">${esc(d.name)}${d.id === me ? ' <span class="pill">This computer</span>' : ''}</div>
        <div class="desc">${Date.now() - d.lastSeen < 120000 ? 'Active now' : `Last synced ${sinceText(d.lastSeen)}`}</div></div>
      ${d.id === me ? '' : '<button class="btn ghost" data-remove>Remove</button>'}
    </div>`).join('')
    : `<div class="row"><div class="desc">${syncState?.status === 'ready' ? 'Only this computer so far. Sign in to Lumio on another computer, or on your phone at the Lumio website, to sync it.' : 'Your devices show here once sync is on.'}</div></div>`;
}
async function refreshSync() {
  renderSync(await page.invoke('page:sync'));
}
$('#sync-on').addEventListener('change', async (e) => { renderSync(await page.invoke('page:sync-set', { on: e.target.checked })); setTimeout(refreshSync, 1500); });
$('#sync-types').addEventListener('change', async (e) => {
  const k = e.target.dataset.type;
  if (k) renderSync(await page.invoke('page:sync-set', { types: { [k]: e.target.checked } }));
});
$('#sync-requests').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-answer]');
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (!b || !id) return;
  b.disabled = true;
  const r = await page.invoke('page:sync-answer', id, b.dataset.answer === 'approve');
  if (!r.ok) alert(r.error);
  refreshSync();
  setTimeout(loadSyncDevices, 4000);
});
$('#sync-recovery-go').addEventListener('click', async () => {
  $('#sync-recovery-err').textContent = '';
  const r = await page.invoke('page:sync-use-recovery', $('#sync-recovery-input').value);
  if (!r.ok) { $('#sync-recovery-err').textContent = r.error; return; }
  $('#sync-recovery-input').value = '';
  refreshSync();
});
$('#sync-recovery-show').addEventListener('click', async () => {
  const box = $('#sync-recovery');
  if (!box.hidden) { box.hidden = true; $('#sync-recovery-show').textContent = 'Show'; return; }
  const { key } = await page.invoke('page:sync-recovery');
  box.textContent = key || 'Turn sync on first.';
  box.hidden = false;
  $('#sync-recovery-show').textContent = 'Hide';
});
$('#sync-devices').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-remove]') && e.target.closest('[data-device]')?.dataset.device;
  if (!id || !confirm('Remove this device from sync? It stops getting your synced data until it’s approved again.')) return;
  await page.invoke('page:sync-remove-device', id);
  loadSyncDevices();
});
$('#sync-delete').addEventListener('click', async () => {
  if (!confirm('Delete everything synced from Lumio’s servers and turn sync off? What’s on each device stays there.')) return;
  const r = await page.invoke('page:sync-delete-all');
  if (!r.ok) alert(r.error);
  refreshSync();
  loadSyncDevices();
});
refreshSync().then(loadSyncDevices);
setInterval(() => { if (!document.hidden) refreshSync(); }, 3000);
setInterval(() => { if (!document.hidden) loadSyncDevices(); }, 30000);

$('#phone-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(`${syncState.siteUrl}/companion`); $('#phone-copy').textContent = 'Copied'; setTimeout(() => { $('#phone-copy').textContent = 'Copy link'; }, 1600); } catch {}
});
