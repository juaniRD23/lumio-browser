// "Your connection is not private": the site's certificate failed (main/tabs.js
// sends such pages here). Going on anyway only happens from here, by the
// person, and Lumio checks it against what it recorded itself (main.js
// page:cert-*); this page only shows the details.
const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const $ = (id) => document.getElementById(id);
const host = (() => { try { return new URL(url).host; } catch { return url; } })();
const page = window.lumioPage;

$('host').textContent = host;
document.querySelectorAll('.h').forEach((el) => { el.textContent = host; });
$('code').textContent = params.get('desc') ? `NET::${params.get('desc')}` : '';
$('back').focus();

$('advanced').addEventListener('click', () => {
  const open = $('details').hidden;
  $('details').hidden = !open;
  $('advanced').setAttribute('aria-expanded', String(open));
  $('advanced').textContent = open ? 'Hide advanced' : 'Advanced';
});
$('back').addEventListener('click', () => page.invoke('page:cert-back'));
$('retry').addEventListener('click', () => { if (url) page.invoke('page:navigate', url); });
// Only a real click: not a script, and not Lumio AI (it can't work on this page at all).
$('proceed').addEventListener('click', (e) => { if (e.isTrusted) page.invoke('page:cert-proceed'); });

const info = await page.invoke('page:cert-info').catch(() => null);
if (!info) {
  // Lumio has no record of this failure (an old page from history): load it again.
  $('reason').textContent = "Its security certificate isn't valid.";
  $('retry').hidden = false;
} else {
  $('code').textContent = info.code;
  $('reason').textContent = `This server couldn't prove that it's ${info.host}. ${info.reason}`;
  const c = info.cert || {};
  $('c-subject').textContent = c.subject || '—';
  $('c-issuer').textContent = c.issuer || '—';
  $('c-from').textContent = c.validFrom || '—';
  $('c-to').textContent = c.validTo || '—';
  $('c-fp').textContent = c.fingerprint || '—';
  $('cert').hidden = false;
  $('hsts').hidden = !info.hsts;
  $('fatal').hidden = info.canProceed || info.hsts;
  $('proceed').hidden = !info.canProceed;
}
