import './keys.js';
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const MARK = '<svg viewBox="0 0 64 64" width="40" height="40"><path d="M35 12a21 21 0 1 0 17 19" fill="none" stroke="#eee" stroke-width="7" stroke-linecap="round"/><circle cx="48" cy="17" r="5" fill="#eee"/></svg>';
$('#mark').innerHTML = MARK;
$('#ask').insertAdjacentHTML('afterbegin', MARK.replace('width="40" height="40"', 'width="14" height="14"'));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function icon(url, cls) {
  let origin = '';
  try { origin = new URL(url).origin; } catch {}
  const letter = esc((host(url)[0] || '?').toUpperCase());
  return `<span class="${cls}" data-letter="${letter}"><img src="${esc(origin)}/favicon.ico" alt="" loading="lazy"></span>`;
}
function fixIcons(root) {
  root.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => { const p = img.parentElement; img.remove(); if (p.dataset.letter) p.textContent = p.dataset.letter; });
  });
}

const q = $('#q');
function submit(ask) {
  const text = q.value.trim();
  if (!text) { q.focus(); return; }
  if (ask) page.invoke('page:ask-ai', text); else page.invoke('page:navigate', text);
  if (ask) q.value = '';
}
$('#box').addEventListener('submit', (e) => { e.preventDefault(); submit(false); });
$('#ask').addEventListener('click', () => submit(true));
q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(true); } });

const data = await page.invoke('page:newtab-data');
if (data.incognito) {
  document.body.classList.add('incognito');
  $('#incog').hidden = false;
  $('#mark').innerHTML = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#d6c2ff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5h18"/><path d="M6 11.5l1.8-6.2a1 1 0 0 1 1.3-.7L12 5.5l2.9-.9a1 1 0 0 1 1.3.7L18 11.5"/><circle cx="7.5" cy="16.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/><path d="M10 16.2c1.3-.8 2.7-.8 4 0"/></svg>';
  document.querySelector('.brand .word').textContent = 'Incognito';
  document.title = 'New Incognito Tab';
}
$('#hint').textContent = data.aiReady
  ? `↵ searches ${data.engine} · ⌘↵ asks Lumio`
  : `↵ searches ${data.engine} · Sign in to Lumio (top right) to ask Lumio AI. It’s free to start.`;

const sites = data.incognito ? [] : data.topSites.length ? data.topSites : [
  { url: 'https://www.google.com/', title: 'Google' },
  { url: 'https://www.youtube.com/', title: 'YouTube' },
  { url: 'https://github.com/', title: 'GitHub' },
  { url: 'https://lumio-usa.online/', title: 'Lumio' },
];
$('#sites').innerHTML = sites.map((s) => `<a class="site" href="${esc(s.url)}" title="${esc(s.title)}">${icon(s.url, 'ico')}<span class="name">${esc(host(s.url))}</span></a>`).join('');
fixIcons($('#sites'));

if (data.bookmarks.length && !data.incognito) {
  $('#marks-wrap').hidden = false;
  $('#marks').innerHTML = data.bookmarks.map((b) => `<a class="bm" href="${esc(b.url)}" title="${esc(b.url)}">${icon(b.url, 'bi')}<span>${esc(b.title || host(b.url))}</span></a>`).join('');
  fixIcons($('#marks'));
}
