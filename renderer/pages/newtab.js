import './keys.js';
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const MARK = '<svg viewBox="0 0 64 64" width="40" height="40"><path d="M35 12a21 21 0 1 0 17 19" fill="none" stroke="#ededee" stroke-width="7" stroke-linecap="round"/><circle cx="48" cy="17" r="5" fill="#86b7ff"/></svg>';
$('#mark').innerHTML = MARK;
const hour = new Date().getHours();
// "Good morning, Juan" (the name in the accent color), or "Up late, Juan?"
function greet(name) {
  const h = $('#hello');
  h.textContent = hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  if (name) { const em = document.createElement('em'); em.textContent = name; h.append(', ', em); }
  if (hour < 5) h.append('?');
}
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
// After picking an idea, ↵ asks Lumio instead of searching.
let asking = false;
let data = null; // from page:newtab-data, below
function setAsking(on) {
  asking = on;
  $('#box').classList.toggle('asking', on);
  renderHint();
}
function submit(ask) {
  const text = q.value.trim();
  if (!text) { q.focus(); return; }
  if (ask) page.invoke('page:ask-ai', text); else page.invoke('page:navigate', text);
  if (ask) { q.value = ''; setAsking(false); }
}
$('#box').addEventListener('submit', (e) => { e.preventDefault(); submit(asking); });
q.addEventListener('input', () => { if (!q.value.trim() && asking) setAsking(false); });
$('#ask').addEventListener('click', () => submit(true));
q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(true); } });

data = await page.invoke('page:newtab-data').catch(() => ({ topSites: [], bookmarks: [], engine: 'Google', chats: [] }));
greet(data.incognito ? null : data.name);
if (data.incognito) {
  document.body.classList.add('incognito');
  $('#incog').hidden = false;
  $('#mark').innerHTML = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#d6c2ff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5h18"/><path d="M6 11.5l1.8-6.2a1 1 0 0 1 1.3-.7L12 5.5l2.9-.9a1 1 0 0 1 1.3.7L18 11.5"/><circle cx="7.5" cy="16.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/><path d="M10 16.2c1.3-.8 2.7-.8 4 0"/></svg>';
  document.querySelector('.brand .word').textContent = 'Incognito';
  document.title = 'New Incognito Tab';
}
function renderHint() {
  if (!data) return;
  $('#hint').textContent = !data.aiReady
    ? `↵ searches ${data.engine} · Sign in to Lumio (top right) to ask Lumio AI. It’s free to start.`
    : asking ? '↵ asks Lumio' : `↵ searches ${data.engine} · ⌘↵ asks Lumio`;
}
renderHint();

// "How can I help you?" with ideas to start from, and recent chats.
const svg = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IDEAS = [
  { label: 'Make a picture', text: 'Make a picture of ', icon: '<path d="m14.6 3.4 6 6-8.8 8.8a3 3 0 0 1-2.1.9H6.4l-2.2 2.2-1.4-1.4L5 17.7v-3.3a3 3 0 0 1 .9-2.1z"/><path d="m11 7 6 6"/>' },
  { label: 'Write a document', text: 'Write a one-page document about ', icon: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>' },
  { label: 'Plan a trip', text: 'Plan a 3-day trip to ', icon: '<circle cx="12" cy="10" r="3"/><path d="M12 21s-7-5.6-7-11a7 7 0 0 1 14 0c0 5.4-7 11-7 11z"/>' },
  { label: 'Compare', text: 'Compare the best ', icon: '<path d="M12 3v18M7 21h10M4 7h16"/><path d="m4 7-2.5 6a3 3 0 0 0 5 0z"/><path d="m20 7-2.5 6a3 3 0 0 0 5 0z"/>' },
  { label: 'Explain', text: 'Explain in simple words: ', icon: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5.6 1 .6 1.7V16h6v-.5c0-.7 0-1.2.6-1.7A6 6 0 0 0 12 3z"/>' },
];
const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 3600) return s < 60 ? 'just now' : `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
if (data.aiReady && !data.incognito) {
  $('#sub').hidden = false;
  $('#ideas').hidden = false;
  $('#ideas').innerHTML = IDEAS.map((x, i) => `<button type="button" class="idea" data-i="${i}">${svg(x.icon)}<span>${esc(x.label)}</span></button>`).join('');
  $('#ideas').addEventListener('click', (e) => {
    const idea = IDEAS[e.target.closest('.idea')?.dataset.i];
    if (!idea) return;
    q.value = idea.text;
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
    setAsking(true);
  });
  // Saved workflows: one click runs one (the panel asks for any blanks).
  page.invoke('page:workflows').then(({ workflows = [] } = {}) => {
    if (!workflows.length) return;
    const wf = workflows.slice(0, 4);
    const row = document.createElement('div');
    row.className = 'ideas wf-ideas';
    row.innerHTML = wf.map((w, i) => `<button type="button" class="idea wf" data-i="${i}" title="Run your workflow “${esc(w.title)}”">${svg('<path d="M4 6.5h9M4 12h6M4 17.5h9"/><path d="M15.5 9.5 21 13l-5.5 3.5z"/>')}<span>${esc(w.title)}</span></button>`).join('');
    row.addEventListener('click', (e) => {
      const w = wf[e.target.closest('.wf')?.dataset.i];
      if (w) page.invoke('page:workflow-run', w.id);
    });
    $('#ideas').after(row);
  }).catch(() => {});
  if (data.chats?.length) {
    $('#recent').hidden = false;
    $('#chats').innerHTML = data.chats.map((c) => `<button type="button" class="chat" data-id="${esc(c.id)}">
      <span class="ct">${esc(c.title || 'Chat')}</span><span class="ca">${svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/>')}${esc(ago(c.updatedAt))}</span></button>`).join('');
    $('#chats').addEventListener('click', (e) => {
      const id = e.target.closest('.chat')?.dataset.id;
      if (id) page.invoke('page:open-chat', id);
    });
  }
}

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
