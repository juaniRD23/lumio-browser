// Lumio Chat: conversations saved to the account (/api/chats), replies
// streamed as NDJSON from /api/chat and rendered as sanitized Markdown.
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (text) => DOMPurify.sanitize(marked.parse(text || '', { breaks: true }));
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

function autosize() { prompt.style.height = 'auto'; prompt.style.height = Math.min(220, prompt.scrollHeight) + 'px'; sendBtn.disabled = !busy && !prompt.value.trim(); }
prompt.addEventListener('input', autosize);
prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
$('#open-side').addEventListener('click', () => document.body.classList.add('side-open'));
$('#close-side').addEventListener('click', () => document.body.classList.remove('side-open'));

async function me() {
  const [a, u] = await Promise.all([fetch('/api/account').then((r) => r.json()), fetch('/api/usage').then((r) => r.json())]);
  if (!a.signedIn) { location.replace('/signin?next=' + encodeURIComponent('/chat')); return false; }
  const name = a.profile?.name || a.email;
  $('#me-name').textContent = name;
  $('#me-avatar').innerHTML = a.profile?.picture ? `<img src="${esc(a.profile.picture)}" alt="" referrerpolicy="no-referrer">` : esc(name.trim()[0]?.toUpperCase() || '?');
  const w = u.usage;
  const left = w.limit ? Math.round((w.remaining / w.limit) * 100) : 0;
  $('#me-plan').textContent = `Lumio ${w.planName} · ${left}% left`;
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
    if (!confirm('Delete this chat?')) return;
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
function userEl(text) { const d = document.createElement('div'); d.className = 'msg user'; d.innerHTML = '<div class="bubble"></div>'; d.firstChild.textContent = text; return d; }
function aiEl(text) { const d = document.createElement('div'); d.className = 'msg ai'; d.innerHTML = md(text); return d; }
function empty() {
  thread.innerHTML = `<div class="empty"><h2>What can I help with?</h2><p>Ask anything. Lumio remembers this conversation.</p>
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
  for (const m of chat.messages) thread.append(m.role === 'user' ? userEl(m.content) : aiEl(m.content));
  scrollDown();
  loadList();
}

// ---------------------------------------------------------------- send
$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) { busy.abort(); return; }
  const text = prompt.value.trim();
  if (!text) return;
  prompt.value = '';
  autosize();
  thread.querySelector('.empty')?.remove();
  thread.append(userEl(text));
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
  let text2 = '';
  let frame = 0;
  const flush = () => { frame = 0; if (el) { el.innerHTML = md(text2); scrollDown(); } };
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: busy.signal,
      body: JSON.stringify({ chatId, text, model, reasoning: EFFORT[effort].id, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
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
          if (!el) { thinking.remove(); el = aiEl(''); el.classList.add('streaming'); thread.append(el); }
          text2 += ev.content;
          if (!frame) frame = requestAnimationFrame(flush);
        } else if (ev.type === 'error') { thinking.remove(); notice(ev.message, ev.code === 'usage_limit'); }
      }
    }
  } catch (err) {
    thinking.remove();
    if (err.name !== 'AbortError') notice('Lost the connection. Try again.');
  } finally {
    flush();
    el?.classList.remove('streaming');
    thinking.remove();
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
  const id = location.hash.slice(1);
  if (/^c_[a-f0-9]{20}$/.test(id)) await openChat(id);
  else newChat();
  loadList();
})();
