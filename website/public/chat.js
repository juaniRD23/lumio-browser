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
const LEVEL = { low: 1, medium: 2, high: 3 };
const IDEAS = [
  { title: 'Explain something', text: 'Explain how compound interest works, with a simple example.' },
  { title: 'Write for me', text: 'Write a friendly email asking my landlord to fix the heating.' },
  { title: 'Plan it', text: 'Plan a 3-day trip to Lisbon on a budget.' },
  { title: 'Brainstorm', text: 'Give me 10 name ideas for a small coffee shop.' },
];

let chatId = null;
let busy = null; // AbortController while a reply streams

// ---------------------------------------------------------------- setup
const saved = (() => { try { return localStorage.getItem('lumio-reasoning'); } catch { return null; } })();
if (saved && LEVEL[saved]) $('#reasoning').value = saved;
function renderBars() { document.querySelector('.bars').dataset.level = LEVEL[$('#reasoning').value]; }
$('#reasoning').addEventListener('change', () => { renderBars(); try { localStorage.setItem('lumio-reasoning', $('#reasoning').value); } catch { /* private mode */ } });
renderBars();

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
      body: JSON.stringify({ chatId, text, reasoning: $('#reasoning').value, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { location.replace('/signin?next=/chat'); return; }
      thinking.remove();
      notice(data.error || 'Lumio couldn’t answer. Try again.', data.code === 'usage_limit');
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
  const id = location.hash.slice(1);
  if (/^c_[a-f0-9]{20}$/.test(id)) await openChat(id);
  else newChat();
  loadList();
})();
