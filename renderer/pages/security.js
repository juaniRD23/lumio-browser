// Settings › Privacy and security › Security (lumio://settings/security):
// Safe Browsing, Always use secure connections, secure DNS and certificates.
// And › Tracking protection (/trackingProtection): ads and trackers, Do Not
// Track, Global Privacy Control and WebRTC. The settings live in
// main/security.js; "Ads and trackers" is a site setting (main/site-settings.js).
import '/keys.js';
import { accentFor, setAccent } from '/assets/theme-colors.js';
import { siteIcon } from '/assets/site-icons.js';

const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
let s = null;

const toggle = (key, title, desc, on, icon) => `<label class="row option switch-row">
    <span class="ic">${siteIcon(icon)}</span>
    <div class="grow"><div class="title">${title}</div><div class="desc">${desc}</div></div>
    <span class="switch"><input type="checkbox" data-key="${key}" ${on ? 'checked' : ''} aria-label="${esc(title.replace(/<[^>]+>/g, ''))}"><i></i></span></label>`;

function ago(t) {
  if (!t) return '';
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'} ago` : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// What Safe Browsing's lists look like now.
function listStatus(l) {
  if (!l) return '';
  if (l.ready) return `Lists updated ${ago(l.updated)} · ${l.count.toLocaleString()} sites`;
  if (l.error) return 'Lumio couldn’t download the lists yet. It tries again every hour.';
  return 'Lumio downloads the lists a few seconds after it starts.';
}

// ---------------------------------------------------------------- Security
function securityView() {
  document.title = 'Security';
  $('#title').textContent = 'Security';
  const mac = s.platform === 'darwin';
  const dnsOn = s.secureDns.on !== false;
  view.innerHTML = `
    <p class="lead">Lumio protects you from dangerous sites, downloads and connections.</p>
    <h3>Safe Browsing</h3>
    <div class="card modes" role="radiogroup" aria-label="Safe Browsing">
      <label class="row option"><input type="radio" name="sb" value="standard" ${s.safeBrowsing !== 'off' ? 'checked' : ''} />
        <span class="ic">${siteIcon('shieldCheck')}</span>
        <div class="grow"><div class="title">Standard protection</div>
          <div class="desc">Warns you about sites and downloads on public lists of dangerous sites, and about sites that copy well-known ones. Lumio downloads the lists and checks them here: the sites you visit aren’t sent anywhere.</div>
          <div class="desc status" id="lists">${esc(listStatus(s.lists))}</div></div></label>
      <label class="row option"><input type="radio" name="sb" value="off" ${s.safeBrowsing === 'off' ? 'checked' : ''} />
        <span class="ic">${siteIcon('shield', { blocked: true })}</span>
        <div class="grow"><div class="title">No protection (not recommended)</div>
          <div class="desc">Doesn’t warn you about dangerous sites or files from them. Files with misleading names and insecure downloads still ask first.</div></div></label>
    </div>
    <h3>Advanced</h3>
    <div class="card">
      ${toggle('httpsFirst', 'Always use secure connections', 'Open sites over https, and warn you before opening one that doesn’t support it. Addresses on your computer or local network are left alone.', s.httpsFirst, 'lock')}
      ${toggle('dnsOn', 'Use secure DNS', 'Look up sites over an encrypted connection, so the network you’re on can’t see or change which sites you visit.', dnsOn, 'dns')}
      <div class="row dns-row" id="dns-row" ${dnsOn ? '' : 'hidden'}>
        <span class="ic"></span>
        <div class="grow">
          <label class="dns-label" for="dns-provider">Provider</label>
          <select class="field" id="dns-provider">${s.providers.map((p) => `<option value="${p.id}" ${s.secureDns.provider === p.id ? 'selected' : ''}>${esc(p.id === 'os' ? 'With your current service provider' : p.name)}</option>`).join('')}</select>
          <form class="dns-custom" id="dns-custom" ${s.secureDns.provider === 'custom' ? '' : 'hidden'}>
            <input class="field" name="template" value="${esc(s.secureDns.custom)}" placeholder="https://dns.example/dns-query" aria-label="Custom secure DNS address" autocomplete="off" spellcheck="false" />
            <button class="btn" type="submit">Save</button>
          </form>
          <div class="desc" id="dns-msg" aria-live="polite">${s.secureDns.provider === 'os' ? 'Uses encrypted DNS when your provider offers it, and your usual DNS when it doesn’t.' : ''}</div>
        </div>
      </div>
      <div class="row">
        <span class="ic">${siteIcon('certificate')}</span>
        <div class="grow"><div class="title">Manage certificates</div><div class="desc">${mac ? 'Opens Keychain Access, where your Mac keeps the certificates Lumio trusts and the ones you use to sign in to sites.' : 'Opens your computer’s certificate manager.'}</div><div class="desc err" id="cert-msg" hidden></div></div>
        <button class="btn" id="certs" ${s.certManager ? '' : 'disabled'}>Open ${siteIcon('external', { size: 14 })}</button>
      </div>
    </div>`;
  view.querySelectorAll('input[name=sb]').forEach((r) => r.addEventListener('change', async () => { s = await page.invoke('page:security-set', { safeBrowsing: r.value }); $('#lists').textContent = listStatus(s.lists); }));
  const msg = (text, bad = false) => { $('#dns-msg').textContent = text; $('#dns-msg').classList.toggle('err', bad); };
  $('#dns-provider').addEventListener('change', async (e) => {
    const provider = e.target.value;
    $('#dns-custom').hidden = provider !== 'custom';
    if (provider === 'custom') { msg('Enter the address of a DNS-over-HTTPS server.'); $('#dns-custom').template.focus(); return; }
    s = await page.invoke('page:security-set', { secureDns: { on: true, provider } });
    msg(provider === 'os' ? 'Uses encrypted DNS when your provider offers it, and your usual DNS when it doesn’t.' : 'Saved.');
  });
  $('#dns-custom').addEventListener('submit', async (e) => {
    e.preventDefault();
    const template = e.target.template.value.trim();
    msg('Checking…');
    const res = await page.invoke('page:secure-dns-test', template);
    if (!res?.ok) { msg(res?.error || 'This doesn’t look like a secure DNS provider.', true); return; }
    s = await page.invoke('page:security-set', { secureDns: { on: true, provider: 'custom', custom: template } });
    msg('Saved. Lumio now looks up sites with this provider.');
  });
  $('#certs').addEventListener('click', async () => {
    const res = await page.invoke('page:manage-certificates');
    $('#cert-msg').hidden = !!res?.ok;
    $('#cert-msg').textContent = res?.ok ? '' : res?.error || 'Couldn’t open the certificate manager.';
  });
}

// ---------------------------------------------------------------- Tracking protection
function trackingView() {
  document.title = 'Tracking protection';
  $('#title').textContent = 'Tracking protection';
  view.innerHTML = `
    <p class="lead">Choose how much sites, and the companies behind their ads, can learn about you.</p>
    <div class="card">
      ${toggle('trackers', 'Block ads and trackers', 'Stops well-known ad networks and trackers that other companies load on the pages you visit. The site you’re on is never blocked.', s.trackers === 'block', 'trackers')}
      <a class="row link" href="/content/trackers"><span class="ic"></span><div class="grow"><div class="title">Sites with their own setting</div><div class="desc">${s.trackerSites ? `${s.trackerSites} site${s.trackerSites === 1 ? '' : 's'}` : 'If a site doesn’t work right, allow its ads and trackers here'}</div></div><span class="chev">${siteIcon('chevron', { size: 16 })}</span></a>
      ${toggle('gpc', 'Send Global Privacy Control', 'Asks sites not to sell or share your personal information. Some laws require sites to honor it.', s.gpc, 'signal')}
      ${toggle('doNotTrack', 'Send a “Do Not Track” request', 'Most sites ignore it. It can also make your browser easier to tell apart.', s.doNotTrack, 'signal')}
      ${toggle('webrtcProtect', 'Protect your local network address', 'Video calls and file sharing on sites use only your public address, so sites can’t see the addresses of your devices at home or at work.', s.webrtcProtect, 'network')}
    </div>
    <p class="hint foot">Changes apply to pages as they load.</p>`;
}

view.addEventListener('change', async (e) => {
  const input = e.target.closest('input[data-key]');
  if (!input) return;
  const key = input.dataset.key;
  if (key === 'trackers') {
    await page.invoke('page:site-set-default', 'trackers', input.checked ? 'block' : 'allow');
    return;
  }
  if (key === 'dnsOn') {
    $('#dns-row').hidden = !input.checked;
    s = await page.invoke('page:security-set', { secureDns: { on: input.checked } });
    return;
  }
  s = await page.invoke('page:security-set', { [key]: input.checked });
});

// The page's accent follows the profile's theme color, like Settings.
page.invoke('page:settings').then((st) => st && setAccent(document.documentElement, accentFor(st.profile?.theme))).catch(() => {});
$('#back').innerHTML = siteIcon('back', { size: 18 });
s = await page.invoke('page:security');
if (!s) view.innerHTML = '<div class="card"><div class="row"><div class="desc err">Couldn’t load this page.</div></div></div>';
else if (location.pathname.startsWith('/trackingProtection')) trackingView();
else securityView();
view.removeAttribute('aria-busy');
