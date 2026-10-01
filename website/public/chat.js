// Lumio Chat: conversations saved to the account (/api/chats), replies
// streamed as NDJSON from /api/chat and rendered as sanitized Markdown.
// The + menu attaches files (up to 10) and turns connected apps on or off;
// the ring next to Send shows how much of the plan is used.
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { ACCEPT, MAX_FILES, kindOf, uploadFile } from '/attach.js';
import { buildFile, save } from '/docmaker.js';
import { appLogo } from '/applook.js';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Links and pictures only to the web; models sometimes invent local paths.
const md = (text) => {
  const html = DOMPurify.sanitize(marked.parse(text || '', { breaks: true }));
  const t = document.createElement('template');
  t.innerHTML = html;
  t.content.querySelectorAll('img').forEach((img) => { if (!/^https:\/\//.test(img.getAttribute('src') || '')) img.remove(); });
  t.content.querySelectorAll('a').forEach((a) => {
    if (!/^https?:\/\//.test(a.getAttribute('href') || '')) a.replaceWith(...a.childNodes);
    else { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  });
  return t.innerHTML;
};
const thread = $('#thread');
const prompt = $('#prompt');
const sendBtn = $('#send');
const EFFORT = [
  { id: 'low', name: 'Low', desc: 'Quick answers. Uses the least of your plan.' },
  { id: 'medium', name: 'Medium', desc: 'Balanced: good for most things.' },
  { id: 'high', name: 'High', desc: 'Thinks longer on hard problems.' },
];
const PLAN_NAMES = { plus: 'Plus', pro: 'Pro', max: 'Max' };
const IDEAS = [
  { title: 'Explain something', text: 'Explain how compound interest works, with a simple example.' },
  { title: 'Write for me', text: 'Write a friendly email asking my landlord to fix the heating.' },
  { title: 'Plan it', text: 'Plan a 3-day trip to Lisbon on a budget.' },
  { title: 'Brainstorm', text: 'Give me 10 name ideas for a small coffee shop.' },
];

let chatId = null;
let busy = null; // AbortController while a reply streams

// ---------------------------------------------------------------- setup
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

// Popovers (effort, model): one open at a time; Esc or a click outside closes.
function popover(btn, pop, onOpen) {
  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  function open() {
    document.querySelectorAll('.pop').forEach((p) => { if (p !== pop) { p.hidden = true; p.previousElementSibling?.setAttribute('aria-expanded', 'false'); } });
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    onOpen?.();
  }
  function close() { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close(); });
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
  return { open, close };
}

// Thinking effort: a slider that snaps to Low / Medium / High.
let effort = Math.max(0, EFFORT.findIndex((e) => e.id === recall('lumio-reasoning')));
if (!recall('lumio-reasoning')) effort = 1;
const slider = $('#effort-slider');
function renderEffort(p = effort / (EFFORT.length - 1)) {
  const e = EFFORT[effort];
  slider.style.setProperty('--p', p);
  slider.setAttribute('aria-valuenow', effort);
  slider.setAttribute('aria-valuetext', e.name);
  $('#effort-label').textContent = e.name;
  $('#effort-desc').textContent = e.desc;
  $('#effort-name').textContent = e.name;
  $('#effort-bars').dataset.level = effort + 1;
  document.querySelectorAll('.ticks button').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === effort));
}
function setEffort(i) {
  effort = Math.max(0, Math.min(EFFORT.length - 1, i));
  remember('lumio-reasoning', EFFORT[effort].id);
  renderEffort();
}
const effortPop = popover($('#effort-btn'), $('#effort-pop'), () => slider.focus());
slider.addEventListener('pointerdown', (e) => {
  slider.setPointerCapture(e.pointerId);
  slider.classList.add('dragging');
  const at = (ev) => {
    const r = slider.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (ev.clientX - r.left - 15) / (r.width - 30)));
    effort = Math.round(p * (EFFORT.length - 1));
    renderEffort(p);
  };
  at(e);
  const move = (ev) => at(ev);
  const up = () => {
    slider.classList.remove('dragging');
    slider.removeEventListener('pointermove', move);
    setEffort(effort);
  };
  slider.addEventListener('pointermove', move);
  slider.addEventListener('pointerup', up, { once: true });
  slider.addEventListener('pointercancel', up, { once: true });
});
slider.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
  if (step) { e.preventDefault(); setEffort(effort + step); }
  else if (e.key === 'Home') setEffort(0);
  else if (e.key === 'End') setEffort(EFFORT.length - 1);
  else if (e.key === 'Enter') { effortPop.close(); prompt.focus(); }
});
document.querySelectorAll('.ticks button').forEach((b) => b.addEventListener('click', () => setEffort(Number(b.dataset.i))));
renderEffort();

// Models: the server lists them, with the ones above your plan locked.
let models = [];
let model = recall('lumio-model');
const costBars = (c) => `<span class="cost" data-c="${c}" title="How fast it uses your plan" aria-label="Cost ${c} of 4"><i></i><i></i><i></i><i></i></span>`;
function renderModels() {
  const current = models.find((m) => m.id === model);
  $('#model-name').textContent = current?.name || 'Lumio';
  const group = (title, list) => list.length ? `<div class="group">${title}</div>` + list.map((m) => `
    <button type="button" class="model ${m.available ? '' : 'locked'}" role="option" aria-selected="${m.id === model}" data-id="${esc(m.id)}">
      <span class="m-name">${esc(m.name)} <small>${esc(m.maker)}</small></span>
      <span class="m-blurb">${esc(m.blurb)}</span>
      <span class="m-side">${m.available ? costBars(m.cost) : `<span class="lock">${PLAN_NAMES[m.minimumPlan] || 'Upgrade'}</span>`}<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg></span>
    </button>`).join('') : '';
  $('#model-pop').innerHTML = group('Your plan', models.filter((m) => m.available)) + group('Upgrade for more', models.filter((m) => !m.available))
    + '<div class="foot">' + costBars(4) + 'Bigger models use your plan faster.</div>';
}
popover($('#model-btn'), $('#model-pop'), () => $('#model-pop [aria-selected="true"]')?.focus());
$('#model-pop').addEventListener('click', (e) => {
  const b = e.target.closest('.model');
  if (!b) return;
  const m = models.find((x) => x.id === b.dataset.id);
  if (!m) return;
  if (!m.available) { location.href = `/account?plan=${m.minimumPlan}#plans`; return; }
  model = m.id;
  remember('lumio-model', model);
  renderModels();
  $('#model-pop').hidden = true;
  $('#model-btn').setAttribute('aria-expanded', 'false');
  prompt.focus();
});
$('#model-pop').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const all = [...$('#model-pop').querySelectorAll('.model')];
  const i = all.indexOf(document.activeElement);
  all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
});
async function loadModels() {
  const data = await fetch('/api/chat/models').then((r) => r.json()).catch(() => null);
  if (!data?.models) return;
  models = data.models;
  if (!models.some((m) => m.id === model && m.available)) model = data.default;
  renderModels();
}

// ---------------------------------------------------------------- composer
const ready = () => attachments.filter((a) => a.status === 'ready');
function autosize() {
  prompt.style.height = 'auto';
  prompt.style.height = Math.min(220, prompt.scrollHeight) + 'px';
  const uploading = attachments.some((a) => a.status === 'busy');
  sendBtn.disabled = !busy && (uploading || (!prompt.value.trim() && !ready().length));
}
prompt.addEventListener('input', autosize);
prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!sendBtn.disabled) $('#composer').requestSubmit(); } });
$('#open-side').addEventListener('click', () => document.body.classList.add('side-open'));
$('#close-side').addEventListener('click', () => document.body.classList.remove('side-open'));

function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 4200);
}

// File looks.
function fileLook(name = '', mime = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = { pdf: ['PDF', '#D93025'], docx: ['DOC', '#185ABD'], doc: ['DOC', '#185ABD'], pptx: ['PPT', '#C43E1C'], xlsx: ['XLS', '#107C41'], csv: ['CSV', '#107C41'], md: ['MD', '#555b66'], txt: ['TXT', '#555b66'], html: ['HTML', '#b4570a'], json: ['JSON', '#555b66'] };
  return map[ext] || (mime.startsWith('text/') ? ['TXT', '#555b66'] : [ext.slice(0, 4).toUpperCase() || 'FILE', '#555b66']);
}
const ficon = (name, mime) => { const [label, color] = fileLook(name, mime); return `<span class="ficon" style="background:${color}">${esc(label)}</span>`; };
const fileMeta = (f) => (f.pages ? `${f.pages} page${f.pages === 1 ? '' : 's'}` : f.slides ? `${f.slides} slides` : f.sheets ? `${f.sheets} sheet${f.sheets === 1 ? '' : 's'}` : f.truncated ? 'Long file (cut short)' : fileLook(f.name, f.mime)[0]);

// ---------------------------------------------------------------- attachments
let attachments = []; // { key, file, name, kind, status: busy | ready | error, files: [server files], preview }
const fileInput = $('#file-input');
fileInput.accept = ACCEPT;
function renderTray() {
  const tray = $('#tray');
  tray.hidden = !attachments.length;
  tray.innerHTML = attachments.map((a) => {
    const cls = `att ${a.preview ? 'pic' : ''} ${a.status === 'busy' ? 'busy' : ''} ${a.status === 'error' ? 'err' : ''}`;
    const body = a.preview ? `<img src="${a.preview}" alt="">`
      : `${ficon(a.name, a.file.type)}<span class="fname"><b>${esc(a.name)}</b><small>${a.status === 'busy' ? 'Reading…' : a.status === 'error' ? 'Couldn’t attach' : esc(a.files[0] ? fileMeta(a.files[0]) : '')}</small></span>`;
    return `<div class="${cls}" title="${esc(a.error || a.name)}">${body}<button type="button" class="x" data-key="${a.key}" aria-label="Remove ${esc(a.name)}">✕</button></div>`;
  }).join('');
  autosize();
}
$('#tray').addEventListener('click', (e) => {
  const key = e.target.closest('[data-key]')?.dataset.key;
  if (!key) return;
  const a = attachments.find((x) => x.key === key);
  if (a?.preview) URL.revokeObjectURL(a.preview);
  attachments = attachments.filter((x) => x.key !== key);
  renderTray();
});
function addFiles(list) {
  for (const file of list) {
    if (attachments.length >= MAX_FILES) { toast(`You can attach up to ${MAX_FILES} files per message.`); break; }
    const kind = kindOf(file);
    const a = { key: crypto.randomUUID(), file, name: file.name, kind, status: 'busy', files: [], preview: kind === 'image' ? URL.createObjectURL(file) : null };
    attachments.push(a);
    uploadFile(file)
      .then((files) => { a.files = files; a.status = 'ready'; })
      .catch((err) => { a.status = 'error'; a.error = err.message; toast(err.message); })
      .finally(renderTray);
  }
  renderTray();
}
$('#add-files').addEventListener('click', () => { plusPop.close(); fileInput.click(); });
fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; prompt.focus(); });
prompt.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); dragDepth = 0; $('#drop').hidden = true; addFiles([...e.dataTransfer.files]); });

// ---------------------------------------------------------------- connections (in the + menu)
let apps = [];
const offApps = () => { try { return new Set(JSON.parse(recall('lumio-apps-off') || '[]')); } catch { return new Set(); } };
const enabledApps = () => { const off = offApps(); return apps.filter((a) => a.connected && !off.has(a.id)).map((a) => a.id); };
async function loadApps() {
  const data = await fetch('/api/connections').then((r) => r.json()).catch(() => null);
  apps = data?.apps || [];
  renderApps();
}
function renderApps() {
  const off = offApps();
  $('#apps').innerHTML = apps.length ? apps.map((a) => `
    <div class="app-row">${appLogo(a.id)}<span class="an"><b>${esc(a.name)}</b><small>${esc(a.connected ? a.account || 'Connected' : a.blurb)}</small></span>
      ${a.connected ? `<label class="switch" title="Use ${esc(a.name)} in chats"><input type="checkbox" data-app="${a.id}" ${off.has(a.id) ? '' : 'checked'} aria-label="Use ${esc(a.name)}"><i></i></label>`
        : a.available ? `<a class="connect" href="#" data-connect="${a.id}">Connect</a>` : '<span class="soon">Soon</span>'}
    </div>`).join('') : '<div class="apps-empty">Couldn’t load connections.</div>';
}
$('#apps').addEventListener('change', (e) => {
  const id = e.target.dataset.app;
  if (!id) return;
  const off = offApps();
  if (e.target.checked) off.delete(id); else off.add(id);
  remember('lumio-apps-off', JSON.stringify([...off]));
});
$('#apps').addEventListener('click', (e) => {
  const id = e.target.closest('[data-connect]')?.dataset.connect;
  if (!id) return;
  e.preventDefault();
  try { sessionStorage.setItem('lumio-chat', chatId || ''); } catch { /* fine */ }
  location.href = `/api/connect/${id}/start?next=${encodeURIComponent('/chat')}`;
});
const plusPop = popover($('#plus-btn'), $('#plus-pop'), () => { loadApps(); $('#add-files').focus(); });

// ---------------------------------------------------------------- usage ring
const RING = 2 * Math.PI * 8.5;
let usage = null;
const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function renderUsage(u) {
  usage = u;
  const used = u.limit ? Math.min(1, u.used / u.limit) : 1;
  $('#ring-fg').style.strokeDasharray = RING;
  $('#ring-fg').style.strokeDashoffset = RING * (1 - used);
  const btn = $('#usage-btn');
  btn.classList.toggle('high', used >= 0.8 && used < 1);
  btn.classList.toggle('full', used >= 1);
  btn.title = `Usage: ${Math.round(used * 100)}% of this week’s used`;
  if (!$('#usage-pop').hidden) renderUsagePop();
}
function renderUsagePop() {
  const u = usage;
  if (!u) return;
  const used = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 100;
  const refill = u.used > 0 && u.fullAt ? `<p>It refills bit by bit as the week goes on, and fully by <b>${esc(when(u.fullAt))}</b>.</p>` : '<p>Your full weekly usage is available.</p>';
  $('#usage-pop').innerHTML = `
    <div class="u-top"><span class="u-plan">Lumio ${esc(u.planName)}</span>${u.plan !== 'max' ? '<a class="btn small accent" href="/account#plans">Upgrade</a>' : ''}</div>
    <div class="u-label">Weekly usage</div>
    <div class="u-bar"><i style="width:${used}%"></i></div>
    <div class="u-nums"><span><b>${used}%</b> used</span><span>${100 - used}% left</span></div>
    ${refill}
    <p>Chat, pictures and Lumio Browser share it. No 5-hour limits.</p>`;
}
popover($('#usage-btn'), $('#usage-pop'), renderUsagePop);

async function me() {
  const [a, u] = await Promise.all([fetch('/api/account').then((r) => r.json()), fetch('/api/usage').then((r) => r.json())]);
  if (!a.signedIn) { location.replace('/signin?next=' + encodeURIComponent('/chat')); return false; }
  const name = a.profile?.name || a.email;
  $('#me-name').textContent = name;
  $('#me-avatar').innerHTML = a.profile?.picture ? `<img src="${esc(a.profile.picture)}" alt="" referrerpolicy="no-referrer">` : esc(name.trim()[0]?.toUpperCase() || '?');
  const w = u.usage;
  const left = w.limit ? Math.round((w.remaining / w.limit) * 100) : 0;
  $('#me-plan').textContent = `Lumio ${w.planName} · ${left}% left`;
  renderUsage(w);
  return true;
}

// ---------------------------------------------------------------- chats list
async function loadList() {
  const { chats } = await fetch('/api/chats').then((r) => r.json());
  $('#chat-list').innerHTML = chats.length ? chats.map((c) => `<a class="chat-item ${c.id === chatId ? 'current' : ''}" href="/chat#${esc(c.id)}" data-id="${esc(c.id)}"><span>${esc(c.title)}</span><button class="del" data-del="${esc(c.id)}" title="Delete chat" aria-label="Delete chat">✕</button></a>`).join('')
    : '<div class="list-empty">Your chats show up here.</div>';
}
$('#chat-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]')?.dataset.del;
  if (del) {
    e.preventDefault();
    if (!confirm('Delete this chat? Its files and pictures are deleted too.')) return;
    await fetch(`/api/chats/${del}`, { method: 'DELETE' });
    if (del === chatId) newChat();
    loadList();
    return;
  }
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (id) { e.preventDefault(); openChat(id); document.body.classList.remove('side-open'); }
});

// ---------------------------------------------------------------- thread
function scrollDown() { thread.scrollTop = thread.scrollHeight; }
function userEl(text, files = [], previews = []) {
  const d = document.createElement('div');
  d.className = 'msg user';
  if (files.length) {
    d.innerHTML = `<div class="files">${files.map((f, i) => (f.kind === 'image'
      ? `<a class="att pic" href="${esc(f.url)}" target="_blank" rel="noopener" title="${esc(f.name)}"><img src="${esc(previews[i] || f.url)}" alt="${esc(f.name)}"></a>`
      : `<div class="att" title="${esc(f.name)}">${ficon(f.name, f.mime)}<span class="fname"><b>${esc(f.name)}</b><small>${esc(fileMeta(f))}</small></span></div>`)).join('')}</div>`;
  }
  if (text) { const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text; d.append(b); }
  return d;
}
function aiEl(text) { const d = document.createElement('div'); d.className = 'msg ai'; d.innerHTML = md(text); return d; }
function madeEl() { const d = document.createElement('div'); d.className = 'made'; return d; }
function fileCard(f) {
  if (f.kind === 'image') {
    const fig = document.createElement('figure');
    fig.className = 'made-img';
    fig.innerHTML = `<img src="${esc(f.url)}" alt="${esc(f.prompt || f.name)}" loading="lazy"><div class="acts"><a href="${esc(f.url)}" target="_blank" rel="noopener">Open</a><a href="${esc(f.url)}" download="${esc(f.name)}">Download</a></div>`;
    fig.querySelector('img').addEventListener('load', scrollDown, { once: true });
    return fig;
  }
  const card = document.createElement('div');
  card.className = 'doc-card';
  card.innerHTML = `${ficon(f.name, f.mime)}<span class="dn"><b>${esc(f.name)}</b><small>${esc(({ pdf: 'PDF document', docx: 'Word document', pptx: 'PowerPoint deck', csv: 'Spreadsheet (CSV)', md: 'Markdown', txt: 'Text file', html: 'Web page' })[f.format] || 'File')}</small></span><button type="button" class="btn small">Download</button>`;
  const btn = card.querySelector('button');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    try {
      const doc = await fetch(`/api/files/${f.id}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error())));
      save(await buildFile({ name: doc.name, format: doc.format, text: doc.text, title: doc.title }), doc.name);
    } catch { toast('Couldn’t make that file. Try again.'); } finally { btn.disabled = false; btn.textContent = 'Download'; }
  });
  return card;
}
const USING = { gmail_search: 'Searching Gmail', gmail_read: 'Reading an email', drive_search: 'Searching Google Drive', drive_read: 'Reading a Drive file', calendar_events: 'Checking Google Calendar', outlook_search: 'Searching Outlook', outlook_read: 'Reading an email', outlook_events: 'Checking Outlook Calendar', onedrive_search: 'Searching OneDrive', onedrive_read: 'Reading a OneDrive file' };
function usingEl(ev) { const d = document.createElement('div'); d.className = 'using'; d.innerHTML = `${appLogo(ev.app)}<span>${esc(USING[ev.tool] || `Using ${ev.name}`)}</span>`; return d; }

function empty() {
  thread.innerHTML = `<div class="empty"><h2>What can I help with?</h2><p>Ask anything, attach files, or ask for a picture or a document.</p>
    <div class="ideas">${IDEAS.map((i, n) => `<button class="idea" data-i="${n}"><b>${esc(i.title)}</b>${esc(i.text)}</button>`).join('')}</div>
    <p class="browser-note">Want Lumio to use websites for you? <a href="/#download">Get Lumio Browser</a>.</p></div>`;
  thread.querySelectorAll('.idea').forEach((b) => b.addEventListener('click', () => { prompt.value = IDEAS[Number(b.dataset.i)].text; autosize(); $('#composer').requestSubmit(); }));
}
function notice(text, upgrade) {
  const n = document.createElement('div');
  n.className = 'notice err';
  n.textContent = text;
  if (upgrade) { const a = document.createElement('a'); a.className = 'btn small accent'; a.href = '/account#plans'; a.textContent = 'Upgrade'; n.append(a); }
  thread.append(n);
  scrollDown();
}

function newChat() {
  chatId = null;
  history.replaceState(null, '', '/chat');
  $('#title').textContent = 'New chat';
  empty();
  loadList();
  prompt.focus();
}
$('#new-chat').addEventListener('click', () => { newChat(); document.body.classList.remove('side-open'); });

async function openChat(id) {
  const res = await fetch(`/api/chats/${id}`);
  if (!res.ok) { newChat(); return; }
  const chat = await res.json();
  chatId = chat.id;
  history.replaceState(null, '', `/chat#${chat.id}`);
  $('#title').textContent = chat.title;
  thread.innerHTML = '';
  for (const m of chat.messages) {
    if (m.role === 'user') { thread.append(userEl(m.content, m.files || [])); continue; }
    if (m.content) thread.append(aiEl(m.content));
    if (m.files?.length) { const box = madeEl(); m.files.forEach((f) => box.append(fileCard(f))); thread.append(box); }
  }
  scrollDown();
  loadList();
}

// ---------------------------------------------------------------- send
$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) { busy.abort(); return; }
  const text = prompt.value.trim();
  const sending = ready();
  const files = sending.flatMap((a) => a.files);
  if (!text && !files.length) return;
  if (files.length > MAX_FILES) { toast(`That’s ${files.length} files (a scanned PDF counts each page). Attach up to ${MAX_FILES}.`); return; }
  prompt.value = '';
  attachments = attachments.filter((a) => !sending.includes(a));
  renderTray();
  thread.querySelector('.empty')?.remove();
  thread.append(userEl(text, files, sending.flatMap((a) => a.files.map(() => a.preview))));
  const thinking = document.createElement('div');
  thinking.className = 'thinking';
  thinking.innerHTML = '<svg class="mark-spin" viewBox="0 0 64 64" aria-hidden="true"><path d="M35 12a21 21 0 1 0 17 19" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><circle cx="48" cy="17" r="5" fill="currentColor"/></svg>Thinking…';
  thread.append(thinking);
  scrollDown();
  busy = new AbortController();
  sendBtn.classList.add('stop');
  sendBtn.disabled = false;
  sendBtn.setAttribute('aria-label', 'Stop');
  let el = null;
  let made = null;
  let text2 = '';
  let frame = 0;
  const flush = () => { frame = 0; if (el) { el.innerHTML = md(text2); scrollDown(); } };
  const before = (node) => thread.insertBefore(node, thinking.isConnected ? thinking : null);
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: busy.signal,
      body: JSON.stringify({ chatId, text, files: files.map((f) => f.id), apps: enabledApps(), model, reasoning: EFFORT[effort].id, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { location.replace('/signin?next=/chat'); return; }
      thinking.remove();
      notice(data.error || 'Lumio couldn’t answer. Try again.', data.code === 'usage_limit' || data.code === 'model_plan_required');
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let cut;
      while ((cut = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, cut);
        buf = buf.slice(cut + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'chat') { const fresh = !chatId; chatId = ev.chatId; $('#title').textContent = ev.title; history.replaceState(null, '', `/chat#${chatId}`); if (fresh) loadList(); }
        else if (ev.type === 'delta') {
          if (!el) { el = aiEl(''); el.classList.add('streaming'); before(el); thinking.remove(); }
          text2 += ev.content;
          if (!frame) frame = requestAnimationFrame(flush);
        } else if (ev.type === 'using') { before(usingEl(ev)); scrollDown(); }
        else if (ev.type === 'making') {
          made ??= madeEl(); thread.append(made);
          const ph = document.createElement('div'); ph.className = 'making'; ph.textContent = 'Making a picture…'; made.append(ph); thinking.remove(); scrollDown();
        } else if (ev.type === 'file') {
          made ??= madeEl(); if (!made.isConnected) thread.append(made);
          const ph = made.querySelector('.making');
          if (ph && ev.file.kind === 'image') ph.replaceWith(fileCard(ev.file)); else made.append(fileCard(ev.file));
          scrollDown();
        } else if (ev.type === 'notice') { made?.querySelector('.making')?.remove(); notice(ev.message, ev.code === 'usage_limit'); }
        else if (ev.type === 'error') { thinking.remove(); made?.querySelector('.making')?.remove(); notice(ev.message, ev.code === 'usage_limit'); }
      }
    }
  } catch (err) {
    thinking.remove();
    if (err.name !== 'AbortError') notice('Lost the connection. Try again.');
  } finally {
    flush();
    el?.classList.remove('streaming');
    thinking.remove();
    made?.querySelector('.making')?.remove();
    busy = null;
    sendBtn.classList.remove('stop');
    sendBtn.setAttribute('aria-label', 'Send');
    autosize();
    me();
  }
});

// ---------------------------------------------------------------- start
(async () => {
  if (!(await me())) return;
  loadModels();
  loadApps();
  const q = new URLSearchParams(location.search);
  if (q.has('connected')) toast(`${apps.find((a) => a.id === q.get('connected'))?.name || 'App'} connected. Lumio can use it in your chats.`);
  if (q.has('connect_error')) toast(({ denied: 'Access wasn’t allowed, so the app isn’t connected.', cancelled: 'Connecting was cancelled.', unavailable: 'That connection isn’t available yet.' })[q.get('connect_error')] || 'Couldn’t connect that app. Try again.');
  let id = location.hash.slice(1);
  if (!id && (q.has('connected') || q.has('connect_error'))) { try { id = sessionStorage.getItem('lumio-chat') || ''; sessionStorage.removeItem('lumio-chat'); } catch { /* fine */ } }
  if (/^c_[a-f0-9]{20}$/.test(id)) await openChat(id);
  else newChat();
  loadList();
})();
