// Lumio on your phone. Signed in to the same Lumio account as Lumio Browser,
// and paired with a computer that syncs (the computer approves it, after you
// check that the codes match), it shows:
// - Now: what Lumio is doing on your computer, steps waiting for your OK,
//   and a box to ask Lumio something there;
// - Chats, Workflows and Tabs synced from your computers.
// Everything to and from the computer is end-to-end encrypted with the sync
// key (sync-crypto.js); the server only relays ciphertext.
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

const C = window.LumioSyncCrypto;
const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (text) => DOMPurify.sanitize(marked.parse(String(text || ''), { breaks: true }));
const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// ---------------------------------------------------------------- storage
// IndexedDB (the service worker reads the key and cursors too).
const idb = (() => {
  const open = () => new Promise((resolve, reject) => {
    const r = indexedDB.open('lumio-companion', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
    });
  };
  return { get: (k) => tx('readonly', (s) => s.get(k)), set: (k, v) => tx('readwrite', (s) => s.put(v, k)), del: (k) => tx('readwrite', (s) => s.delete(k)) };
})();

// ---------------------------------------------------------------- server
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { signIn(); throw new Error('Sign in again.'); }
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, code: data.code });
  return data;
}

function phoneName() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Phone';
}

const S = {
  account: null,
  device: null,
  keys: null,
  view: 'now',
  chat: null, // the open chat's id
  computers: [], // { id, name, online, status }
  target: null, // the computer to work on
  records: { chats: new Map(), workflows: new Map(), tabs: new Map() },
  cursor: 0,
  noticeCursor: 0,
  sending: false,
};

// ---------------------------------------------------------------- start
async function boot() {
  try {
    S.account = await (await fetch('/api/account', { credentials: 'include' })).json();
  } catch {
    return render(`<div class="hero"><div class="mark"></div><h1>Can’t reach Lumio</h1><p>Check your connection, then try again.</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`);
  }
  if (!S.account?.signedIn) return signIn();
  S.device = localStorage.getItem('lumioPhoneId') || `phone-${crypto.randomUUID()}`;
  localStorage.setItem('lumioPhoneId', S.device);
  await idb.set('device', S.device);
  try {
    await api('/api/sync/devices', { method: 'POST', body: { id: S.device, name: phoneName(), kind: 'phone', platform: /Android/.test(navigator.userAgent) ? 'android' : 'ios' } });
  } catch (err) {
    return render(`<div class="hero"><div class="mark"></div><h1>Almost there</h1><p>${esc(err.message)}</p></div>`);
  }
  const status = await api('/api/sync');
  if (!status.keyCheck) return needsSync();
  const saved = await idb.get(`syncKey:${S.account.email}`);
  if (saved) {
    const keys = await C.deriveKeys(C.fromB64(saved));
    if (keys.check === status.keyCheck) S.keys = keys;
    else await idb.del(`syncKey:${S.account.email}`);
  }
  if (!S.keys) return pair(status.keyCheck);
  start();
}

function render(html) { app.innerHTML = html; }

function signIn() {
  $('#nav').hidden = true;
  render(`<div class="hero"><div class="mark"></div><h1>Lumio, in your pocket</h1>
    <p>See what Lumio is doing on your computer, approve its steps, and pick up your chats, from anywhere.</p>
    <a class="btn primary block" href="/signin?next=${encodeURIComponent('/companion')}">Sign in to Lumio</a></div>`);
}

function needsSync() {
  $('#nav').hidden = true;
  render(`<div class="hero"><div class="mark"></div><h1>Turn on Sync first</h1>
    <p>On your computer, open Lumio Browser, go to <b>Settings › Sync</b>, and turn it on. Then come back here.</p>
    <button class="btn primary block" onclick="location.reload()">I turned it on</button></div>`);
}

// ---------------------------------------------------------------- pairing
// The phone asks; the computer shows the same code and approves.
async function pair(keyCheck) {
  $('#nav').hidden = true;
  const kp = await C.pairKeyPair();
  const code = await C.pairCode(kp.publicKey);
  let req;
  try {
    req = await api('/api/sync/pair', { method: 'POST', body: { device: S.device, name: phoneName(), kind: 'phone', pubkey: kp.publicKey } });
  } catch (err) {
    return render(`<div class="hero"><div class="mark"></div><h1>Couldn’t connect</h1><p>${esc(err.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`);
  }
  render(`<div class="hero"><div class="mark"></div><h1>Connect your phone</h1>
    <p>Lumio on your computer will ask to approve <b>${esc(phoneName())}</b>. Approve it only if it shows this code:</p>
    <div class="code">${code.slice(0, 3)} ${code.slice(3)}</div>
    <ol class="steps"><li>Open Lumio Browser on your computer.</li><li>Click the notification, or go to <b>Settings › Sync</b>.</li><li>Check the code, then click <b>Approve</b>.</li></ol>
    <p class="err" id="pair-err"></p>
    <details><summary style="color:var(--dim)">Use your recovery key instead</summary>
      <div class="recovery"><input id="rk" placeholder="XXXX-XXXX-…" autocomplete="off" autocapitalize="characters" spellcheck="false"><button class="btn" id="rk-go">Use</button></div></details></div>`);
  $('#rk-go').addEventListener('click', async () => {
    const raw = C.fromRecovery($('#rk').value);
    if (!raw) { $('#pair-err').textContent = 'That isn’t a recovery key. It’s 13 groups of 4 letters and numbers.'; return; }
    if ((await C.deriveKeys(raw)).check !== keyCheck) { $('#pair-err').textContent = 'That recovery key is for a different account, or has a typo.'; return; }
    await adopt(raw);
  });
  const started = Date.now();
  const check = async () => {
    if (S.keys) return;
    try {
      const r = await api(`/api/sync/pair/${req.id}`);
      if (r.status === 'approved') {
        const raw = await C.unwrapFromApprover(kp.privateKey, r.approverPub, r.wrapped);
        if ((await C.deriveKeys(raw)).check !== keyCheck) throw new Error('The key didn’t match. Try again.');
        return adopt(raw);
      }
      if (r.status === 'denied') { $('#pair-err').textContent = 'Your computer said no. Reload to ask again.'; return; }
      if (r.status === 'expired' || Date.now() - started > 9 * 60_000) { $('#pair-err').textContent = 'That request expired. Reload to ask again.'; return; }
    } catch (err) { $('#pair-err').textContent = err.message; }
    setTimeout(check, 2000);
  };
  setTimeout(check, 2000);
}

async function adopt(raw) {
  await idb.set(`syncKey:${S.account.email}`, C.toB64(raw));
  await idb.set('syncKeyOwner', S.account.email);
  S.keys = await C.deriveKeys(raw);
  start();
}

// ---------------------------------------------------------------- running
function start() {
  $('#nav').hidden = false;
  document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => { S.chat = null; show(b.dataset.view); }));
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('chat')) { S.chat = hash.get('chat'); S.view = 'chats'; }
  show(S.view);
  pullAll();
  pollStatus();
  pollNotices();
  setInterval(() => { if (!document.hidden) pullAll(); }, 15_000);
  setInterval(() => { if (!document.hidden) pollStatus(); }, 2500);
  setInterval(() => { if (!document.hidden) pollNotices(); }, 10_000);
  // Seen recently: computers check for commands more often.
  setInterval(() => { if (!document.hidden) api('/api/sync/devices', { method: 'POST', body: { id: S.device, name: phoneName(), kind: 'phone' } }).catch(() => {}); }, 20_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollStatus(); pullAll(); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/companion-sw.js').catch(() => {});
}

function show(view) {
  S.view = view;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  ({ now: renderNow, chats: renderChats, workflows: renderWorkflows, tabs: renderTabs })[view]();
}

// Chats, workflows and tabs synced from the computers (read-only here).
async function pullAll() {
  try {
    for (let i = 0; i < 20; i++) {
      const res = await api(`/api/sync/changes?since=${S.cursor}&device=${encodeURIComponent(S.device)}&collections=chats,workflows,tabs&limit=500`);
      for (const it of res.items) {
        const map = S.records[it.collection];
        if (!map) continue;
        if (it.deleted) { map.delete(it.id); continue; }
        try { map.set(it.id, (await C.open(S.keys, it.collection, it.id, it.data)).r); } catch { /* another key */ }
      }
      S.cursor = res.cursor;
      if (!res.more) break;
    }
    if (S.view !== 'now' && !document.activeElement?.matches('input, textarea')) show(S.view);
  } catch { /* try again later */ }
}

async function pollStatus() {
  try {
    const { computers } = await api('/api/companion/status');
    S.computers = await Promise.all(computers.map(async (c) => {
      let status = null;
      try { status = c.status ? await C.open(S.keys, 'companion', 'status', c.status) : null; } catch { /* old key */ }
      return { ...c, status };
    }));
    if (!S.target || !S.computers.some((c) => c.id === S.target)) S.target = (S.computers.find((c) => c.online) || S.computers[0])?.id || null;
    const sig = JSON.stringify([S.target, S.computers.map((c) => [c.id, c.online, c.status])]);
    if (S.view === 'now' && sig !== S.lastSig) renderNow();
    S.lastSig = sig;
  } catch { /* try again */ }
}

async function pollNotices() {
  try {
    S.noticeCursor ||= (await idb.get('noticeCursor')) || 0;
    const res = await api(`/api/companion/messages?kind=notice&device=${encodeURIComponent(S.device)}&since=${S.noticeCursor}`);
    const first = !S.noticeCursor;
    S.noticeCursor = res.cursor;
    await idb.set('noticeCursor', res.cursor);
    if (first) return;
    for (const m of res.messages.slice(-1)) {
      try { const n = await C.open(S.keys, 'companion', 'msg', m.data); toast(`${n.title}${n.body ? ` — ${n.body}` : ''}`); } catch { /* skip */ }
    }
  } catch { /* try again */ }
}

async function command(cmd) {
  const target = S.target;
  if (!target) { toast('No computer is syncing yet.'); return false; }
  const data = await C.seal(S.keys, 'companion', 'msg', { ...cmd, at: Date.now(), from: S.device });
  await api('/api/companion/messages', { method: 'POST', body: { kind: 'command', device: S.device, target, data } });
  setTimeout(pollStatus, 1500);
  return true;
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

// ---------------------------------------------------------------- Now
function computerPicker() {
  if (S.computers.length < 2) {
    const c = S.computers[0];
    return c ? `<span class="pill"><i class="dot ${c.online ? 'on' : ''}"></i>${esc(c.name)}</span>` : '';
  }
  return `<select class="pill" id="target" aria-label="Computer">${S.computers.map((c) => `<option value="${esc(c.id)}" ${c.id === S.target ? 'selected' : ''}>${c.online ? '● ' : '○ '}${esc(c.name)}</option>`).join('')}</select>`;
}

function renderNow() {
  const c = S.computers.find((x) => x.id === S.target);
  const st = c?.status;
  const working = !!st?.running && c.online;
  const draft = $('#ask')?.value || '';
  const focused = document.activeElement?.id === 'ask';
  app.className = 'has-composer';
  render(`<div class="top"><h1>Now</h1>${computerPicker()}</div>
    ${notifyCard()}
    ${!c ? `<div class="card"><p class="sub" style="margin:0">Your computers show up here once Lumio Browser syncs on them.</p></div>`
    : `<div class="card live ${working ? 'working' : 'idle'}">
      <div class="head"><div class="orb"></div><div class="what">
        <b>${esc(working ? st.title || 'Working' : c.online ? 'Ready' : 'Offline')}</b>
        <small>${esc(working ? st.label || 'Working on it…' : c.online ? `Lumio is ready on ${c.name}.` : `Last seen ${ago(c.lastSeen)}. Open Lumio Browser on ${c.name}.`)}</small></div>
        ${working ? '<button class="stop" id="stop">Stop</button>' : ''}</div>
      ${(st?.approvals || []).map((a) => `<div class="approval" data-id="${esc(a.id)}"><b>${esc(a.label)}</b>${a.detail ? `<pre>${esc(a.detail)}</pre>` : ''}
        <div class="row"><button class="btn" data-decide="deny">Deny</button><button class="btn primary" data-decide="once">Allow</button></div></div>`).join('')}
      ${st?.reply ? `<div class="reply">${md(st.reply)}</div>` : ''}
    </div>`}
    <div class="composer"><div class="box"><textarea id="ask" rows="1" placeholder="${esc(working ? 'Add to the task, or say stop…' : `Ask Lumio on ${c?.name || 'your computer'}…`)}"></textarea>
      <button class="send" id="ask-go" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button></div></div>`);
  const ask = $('#ask');
  ask.value = draft;
  if (focused) { ask.focus(); ask.setSelectionRange(ask.value.length, ask.value.length); }
  ask.addEventListener('input', () => { ask.style.height = 'auto'; ask.style.height = `${Math.min(140, ask.scrollHeight)}px`; });
  ask.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); } });
  $('#ask-go').addEventListener('click', send);
  $('#target')?.addEventListener('change', (e) => { S.target = e.target.value; renderNow(); });
  $('#stop')?.addEventListener('click', () => command({ type: 'stop' }).then(() => toast('Stopping…')));
  app.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.closest('[data-id]').dataset.id;
    b.closest('.approval').style.opacity = '.5';
    await command({ type: 'approve', callId: id, decision: b.dataset.decide });
  }));
  bindNotify();
  async function send() {
    const text = ask.value.trim();
    if (!text || S.sending) return;
    S.sending = true;
    try {
      if (await command({ type: 'send', text, chatId: working ? st.chatId : null })) { ask.value = ''; toast(working ? 'Added to the task.' : `Sent to ${c?.name || 'your computer'}.`); }
    } catch (err) { toast(err.message); } finally { S.sending = false; }
  }
}

// ---------------------------------------------------------------- notifications
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
function notifyCard() {
  if (!('Notification' in window) && !/iPhone|iPad/.test(navigator.userAgent)) return '';
  if (window.Notification?.permission === 'granted' && localStorage.getItem('lumioPush') === S.device) return '';
  if (/iPhone|iPad/.test(navigator.userAgent) && !standalone()) {
    return '<div class="card notify"><p>Add Lumio to your Home Screen (Share → Add to Home Screen) to get notified when Lumio finishes or needs you.</p></div>';
  }
  if (!('PushManager' in window)) return '';
  return '<div class="card notify"><p>Get a notification when Lumio finishes or needs your OK.</p><button class="btn" id="notify-on">Turn on</button></div>';
}
function bindNotify() {
  $('#notify-on')?.addEventListener('click', async () => {
    try {
      if ((await Notification.requestPermission()) !== 'granted') { toast('Notifications are off. You can turn them on in Settings.'); return; }
      const { publicKey } = await api('/api/companion/vapid');
      if (!publicKey) { toast('Notifications aren’t set up on Lumio yet.'); return; }
      const reg = await navigator.serviceWorker.ready;
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (publicKey.length % 4)) % 4)), (ch) => ch.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await api('/api/companion/push', { method: 'POST', body: { device: S.device, endpoint: sub.endpoint } });
      localStorage.setItem('lumioPush', S.device);
      toast('Notifications are on.');
      renderNow();
    } catch (err) { toast(`Couldn’t turn on notifications: ${err.message}`); }
  });
}

// ---------------------------------------------------------------- Chats
function renderChats() {
  app.className = S.chat ? 'has-composer' : '';
  if (S.chat) return renderChat(S.chat);
  const list = [...S.records.chats.entries()].map(([id, c]) => ({ rid: id, ...c })).sort((a, b) => b.updatedAt - a.updatedAt);
  render(`<div class="top"><h1>Chats</h1></div>
    ${list.length ? `<div class="list">${list.map((c) => `<button class="item" data-chat="${esc(c.rid)}"><span class="t"><b>${esc(c.title || 'Chat')}</b><small>${esc(ago(c.updatedAt))}</small></span><span class="go">›</span></button>`).join('')}</div>`
    : '<div class="empty">Your Lumio chats from your computers show up here.</div>'}`);
  app.querySelectorAll('[data-chat]').forEach((b) => b.addEventListener('click', () => { S.chat = b.dataset.chat; renderChats(); }));
}

function renderChat(rid) {
  const c = S.records.chats.get(rid);
  if (!c) { S.chat = null; return renderChats(); }
  const parts = c.display.map((d) => d.kind === 'user' ? `<div class="msg user"><span>${esc(d.text)}</span></div>`
    : d.kind === 'ai' ? `<div class="msg ai">${md(d.text)}</div>`
    : d.kind === 'step' ? `<div class="msg step">${esc(d.label)}</div>` : '').join('');
  render(`<button class="back" id="back">‹ Chats</button><div class="top"><h1 style="font-size:26px">${esc(c.title || 'Chat')}</h1></div>${parts || '<div class="empty">Empty chat.</div>'}
    <div class="composer"><div class="box"><textarea id="cont" rows="1" placeholder="Continue on your computer…"></textarea>
      <button class="send" id="cont-go" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button></div></div>`);
  $('#back').addEventListener('click', () => { S.chat = null; renderChats(); });
  $('#cont-go').addEventListener('click', async () => {
    const text = $('#cont').value.trim();
    if (!text) return;
    try { if (await command({ type: 'send', text, chatId: c.id })) { $('#cont').value = ''; toast('Sent. Follow along in Now.'); show('now'); } } catch (err) { toast(err.message); }
  });
  window.scrollTo(0, document.body.scrollHeight);
}

// ---------------------------------------------------------------- Workflows
function renderWorkflows() {
  app.className = '';
  const list = [...S.records.workflows.values()].sort((a, b) => (b.lastRun || b.updatedAt) - (a.lastRun || a.updatedAt));
  render(`<div class="top"><h1>Workflows</h1></div>
    ${list.length ? list.map((w) => `<div class="card" data-wf="${esc(w.id)}"><b>${esc(w.title)}</b>
      <p class="sub" style="margin:4px 0 0">${esc(w.description || w.instructions.split('\n')[0].slice(0, 140))}</p>
      ${w.inputs.length ? `<div class="blanks">${w.inputs.map((i) => `<label>${esc(i.label)}<input data-name="${esc(i.name)}" autocomplete="off"></label>`).join('')}</div>` : ''}
      <button class="btn primary block" style="margin-top:12px" data-run>Run on your computer</button></div>`).join('')
    : '<div class="empty">Workflows you save in Lumio Browser show up here, ready to run on your computer.</div>'}`);
  app.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', async () => {
    const card = b.closest('[data-wf]');
    const values = Object.fromEntries([...card.querySelectorAll('input')].map((i) => [i.dataset.name, i.value.trim()]));
    const missing = [...card.querySelectorAll('input')].find((i) => !i.value.trim());
    if (missing) { missing.focus(); return; }
    try { if (await command({ type: 'workflow', id: card.dataset.wf, values })) { toast('Started. Follow along in Now.'); show('now'); } } catch (err) { toast(err.message); }
  }));
}

// ---------------------------------------------------------------- Tabs
function renderTabs() {
  app.className = '';
  const devices = [...S.records.tabs.values()].filter((d) => d?.windows?.length).sort((a, b) => (b.at || 0) - (a.at || 0));
  render(`<div class="top"><h1>Tabs</h1></div>
    ${devices.length ? devices.map((d) => `<div class="label">${esc(d.name)} · ${esc(ago(d.at || Date.now()))}</div>${d.windows.flatMap((w) => w.tabs).map((t) => `
      <a class="item" href="${esc(t.url)}" target="_blank" rel="noopener"><span class="t"><b>${esc(t.title || t.url)}</b><small>${esc(t.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0])}</small></span><span class="go">↗</span></a>`).join('')}`).join('')
    : '<div class="empty">Tabs open on your computers show up here.</div>'}`);
}

boot();
