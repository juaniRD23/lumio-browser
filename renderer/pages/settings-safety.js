// Settings › Safety check: runs Lumio's checks (main/security.js) for
// updates, compromised passwords (Password Checkup), Safe Browsing and
// extensions, and lists sites whose unused permissions Lumio removed, with
// "Allow again". Also says what Security and Tracking protection are set to.
import { siteIcon } from '/assets/site-icons.js';

const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const hostOf = (origin) => { try { return new URL(origin).host; } catch { return origin; } };
const card = $('#safety-card');
let state = null; // { last, unused, autoRevoke, safeBrowsing }
let running = false;

// One result: tone is 'ok', 'warn', 'bad' or 'info' (then it shows its own
// icon); action is an HTML button or link.
const item = (icon, tone, title, desc, action = '') => `<div class="row sc-item ${tone}">
    <span class="sc-ic" aria-hidden="true">${siteIcon(tone === 'ok' ? 'check' : tone === 'info' ? icon : 'warn', { size: 18 })}</span>
    <div class="grow"><div class="title">${title}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div>${action}</div>`;

function updateItem(u) {
  if (!u) return item('update', 'info', 'Updates', 'Lumio couldn’t check for updates here.');
  if (u.error) return item('update', 'warn', 'Lumio couldn’t check for updates', esc(u.error), '<button class="btn" data-act="recheck">Try again</button>');
  if (u.status === 'available' || u.status === 'ready') return item('update', 'warn', `An update is available: Lumio Browser ${esc(u.latest)}`, 'Updates keep you safe from newly found security problems.', '<button class="btn primary" data-act="update">Update</button>');
  if (u.status === 'store') return item('update', 'ok', 'The Microsoft Store keeps Lumio up to date', '');
  if (['downloading', 'installing', 'manual'].includes(u.status)) return item('update', 'info', 'Lumio is getting an update', 'Check again in a minute.');
  if (u.status !== 'current') return item('update', 'info', 'Lumio couldn’t check for updates', '', '<button class="btn" data-act="recheck">Try again</button>');
  return item('update', 'ok', 'Lumio is up to date', `You have version ${esc(u.current || '')}.`);
}

function passwordsItem(p) {
  if (!p) return '';
  if (p.error && !p.checked) return item('key', 'warn', 'Lumio couldn’t check your passwords', esc(p.error), '<button class="btn" data-act="recheck">Try again</button>');
  if (!p.total) return item('key', 'ok', 'No saved passwords', 'When you save passwords, Lumio checks them for you.');
  const review = '<a class="btn" href="lumio://passwords/">Review</a>';
  if (p.compromised) return item('key', 'bad', `${plural(p.compromised, 'compromised password')}`, 'Change them now: they appeared in a data breach.', review);
  const issues = [p.reused && plural(p.reused, 'reused password'), p.weak && plural(p.weak, 'weak password')].filter(Boolean);
  if (issues.length) return item('key', 'warn', 'No compromised passwords', `But you have ${issues.join(' and ')}.`, review);
  return item('key', 'ok', 'No compromised passwords', `Lumio checked ${plural(p.total, 'password')} against known data breaches.`);
}

function safeBrowsingItem(sb) {
  return sb === 'off'
    ? item('shield', 'bad', 'Safe Browsing is off', 'Lumio isn’t warning you about dangerous sites and downloads.', '<button class="btn primary" data-act="sb-on">Turn on</button>')
    : item('shieldCheck', 'ok', 'Safe Browsing is on', 'You’re warned about dangerous sites and downloads.', '<a class="btn" href="/security">Manage</a>');
}

function extensionsItem(e) {
  if (!e) return '';
  if (e.unpacked.length) return item('puzzle', 'warn', `${plural(e.unpacked.length, 'extension')} not from the Chrome Web Store`, `${esc(e.unpacked.join(', '))}. Make sure you trust ${e.unpacked.length === 1 ? 'it' : 'them'}.`, '<a class="btn" href="lumio://extensions/">Review</a>');
  return item('puzzle', 'ok', e.on ? `${plural(e.on, 'extension')} turned on` : 'No extensions turned on', e.on ? 'All from the Chrome Web Store.' : '', e.on ? '<a class="btn" href="lumio://extensions/">Review</a>' : '');
}

function render() {
  const last = state?.last;
  const when = last ? (Date.now() - last.time < 60_000 ? 'Checked just now' : `Checked ${new Date(last.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`) : '';
  const head = `<div class="row sc-head">
      <span class="sc-ic" aria-hidden="true">${siteIcon('shieldCheck', { size: 20 })}</span>
      <div class="grow"><div class="title">Lumio can help keep you safe from data breaches, dangerous sites and more</div>
        <div class="desc" id="safety-status" aria-live="polite">${running ? 'Checking…' : esc(when)}</div></div>
      <button class="btn primary" data-act="check" ${running ? 'disabled' : ''}>${running ? '<span class="sc-spin" aria-hidden="true"></span>Checking' : last ? 'Check again' : 'Check now'}</button></div>`;
  const results = last ? updateItem(last.update) + passwordsItem(last.passwords) + safeBrowsingItem(state.safeBrowsing) + extensionsItem(last.extensions) : '';
  const unused = state?.unused || [];
  const unusedHtml = unused.length ? `<div class="row sc-sub"><div class="grow"><div class="title">Permissions removed from unused sites</div><div class="desc">You haven’t visited these sites for 90 days, so Lumio removed what you allowed them.</div></div></div>
    ${unused.map((u) => `<div class="row sc-site"><span class="sc-ic" aria-hidden="true">${siteIcon('allSites', { size: 16 })}</span><div class="grow"><div class="title">${esc(u.host)}</div><div class="desc">${esc(u.cats.join(', '))}</div></div>
      <button class="btn" data-undo="${esc(u.origin)}">Allow again</button></div>`).join('')}` : '';
  const toggle = `<label class="row sc-toggle" style="cursor:pointer"><div class="grow"><div class="title">Remove permissions from unused sites</div><div class="desc">Sites you haven’t visited for 90 days lose the permissions you allowed, like your camera or location.</div></div>
    <span class="switch"><input type="checkbox" id="auto-revoke" ${state?.autoRevoke !== false ? 'checked' : ''} aria-label="Remove permissions from unused sites"><i></i></span></label>`;
  card.innerHTML = head + results + unusedHtml + toggle;
  card.removeAttribute('aria-busy');
}

async function runCheck() {
  running = true;
  render();
  try { state = await page.invoke('page:safety-check') || state; } catch { /* keep the last results */ }
  running = false;
  render();
  card.querySelector('[data-act=check]')?.focus();
}

card.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'check' || act === 'recheck') runCheck();
  else if (act === 'update') page.invoke('page:update-now');
  else if (act === 'sb-on') { await page.invoke('page:security-set', { safeBrowsing: 'standard' }); state = { ...state, safeBrowsing: 'standard' }; render(); showSummary(); }
  const undo = e.target.closest('[data-undo]')?.dataset.undo;
  if (undo) { state = await page.invoke('page:unused-undo', undo) || state; render(); }
});
card.addEventListener('change', (e) => {
  if (e.target.id === 'auto-revoke') page.invoke('page:security-set', { autoRevoke: e.target.checked });
});

// The Security and Tracking protection rows say what's set.
async function showSummary() {
  const sec = await page.invoke('page:security').catch(() => null);
  if (!sec) return;
  $('#security-desc').textContent = sec.safeBrowsing === 'off' ? 'Safe Browsing is off: Lumio isn’t warning you about dangerous sites' : `Standard protection${sec.httpsFirst ? ' · Always use secure connections' : ''}`;
  const on = [sec.trackers === 'block' && 'Ads and trackers blocked', sec.gpc && 'Global Privacy Control on', sec.doNotTrack && 'Do Not Track on'].filter(Boolean);
  $('#tracking-desc').textContent = on.length ? on.join(' · ') : 'Ads and trackers allowed';
}

state = await page.invoke('page:safety-state').catch(() => null);
render();
showSummary();
