// Lumio on your phone. Signed in to the same Lumio account as Lumio Browser,
// it shows:
// - Now: what Lumio is doing on your computer, steps waiting for your OK,
//   and a box to ask Lumio something there;
// - Chats, Workflows and Tabs synced from your computers.
// Everything to and from the computer is encrypted with the account's sync
// key (sync-crypto.js); the server relays ciphertext. By default the phone
// gets the key from Lumio when you sign in; if the account uses its own
// passphrase, a computer approves the phone instead (docs/sync-managed.md).
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
// X-Lumio-Sync: the sync key routes take cookie requests only with it (a
// custom header no other site can send without asking first).
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, credentials: 'include', headers: { 'X-Lumio-Sync': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Signed out (the session ended): a key Lumio keeps leaves this phone
    // too. Otherwise (the account's own passphrase, or a server that doesn't
    // keep keys) it stays, as before: no other copy may exist.
    if (S.managed) await forgetKey().catch(() => {});
    signIn();
    throw Object.assign(new Error('Sign in again.'), { status: 401 });
  }
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
  mode: 'managed', // the account's: 'managed' (Lumio keeps the key) or 'passphrase'
  managed: false, // Lumio hands out the key (managed mode, and the server can)
  modeChanged: false, // the server says managed, but this phone keeps its own passphrase key (syncStatus)
  keyRetryAt: 0, // no key reads before this (Lumio said "too many requests")
  lastUpload: 0,
  started: false,
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
  // As Lumio last said, until it says again.
  S.mode = (await idb.get('syncMode').catch(() => null)) || 'managed';
  S.managed = (await idb.get('syncManaged').catch(() => null)) === true;
  try {
    S.account = await (await fetch('/api/account', { credentials: 'include' })).json();
  } catch {
    return render(`<div class="hero"><div class="mark"></div><h1>Can’t reach Lumio</h1><p>Check your connection, then try again.</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`);
  }
  if (!S.account?.signedIn) {
    // Signed out since the last visit (the session ended): a key Lumio keeps goes too.
    if (S.managed) await forgetKey().catch(() => {});
    return signIn();
  }
  S.device = localStorage.getItem('lumioPhoneId') || `phone-${crypto.randomUUID()}`;
  localStorage.setItem('lumioPhoneId', S.device);
  await idb.set('device', S.device);
  try {
    await api('/api/sync/devices', { method: 'POST', body: { id: S.device, name: phoneName(), kind: 'phone', platform: /Android/.test(navigator.userAgent) ? 'android' : 'ios' } });
  } catch (err) {
    return render(`<div class="hero"><div class="mark"></div><h1>Almost there</h1><p>${esc(err.message)}</p></div>`);
  }
  const status = await syncStatus();
  if (!S.managed) return e2ee(status);
  // Managed: signing in is enough. Lumio keeps the account's key.
  const saved = await savedKey(status.keyCheck);
  if (saved) {
    // Already here (an account from before managed sync): Lumio gets a copy,
    // so the account's other devices can have it too.
    if (!status.managedKey) upload(saved);
    return start();
  }
  if (status.keyCheck && !status.managedKey) return finishing(status.keyCheck);
  try {
    const r = await fetchKey();
    return r.raw ? adopt(r.raw) : finishing(r.keyCheck);
  } catch (err) {
    if (err.code === 'passphrase_mode') return e2ee(await syncStatus());
    return render(`<div class="hero"><div class="mark"></div><h1>Couldn’t connect</h1><p>${esc(err.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`);
  }
}

// The account's sync status, and its mode: managed unless it says otherwise
// (an older server says nothing: then the phone pairs, as before).
// The account's own passphrase is only turned off by a device that has its
// key (as in Lumio Browser, main/sync/engine.js remember): while this phone
// has the key it last saw the account use with its passphrase
// (syncPassphraseCheck), the account counts as managed again only once Lumio
// hands back that same key. Until then (S.modeChanged: the server's word
// alone, from a stolen session or a changed database) the phone keeps its
// key to itself: it doesn't give it to Lumio, take Lumio's, or ask to be approved.
async function syncStatus() {
  const status = await api('/api/sync');
  if (status.mode === 'passphrase') idb.set('syncPassphraseCheck', status.keyCheck || null).catch(() => {});
  let mode = status.mode === 'passphrase' ? 'passphrase' : 'managed';
  S.modeChanged = false;
  if (mode === 'managed' && S.mode === 'passphrase') {
    const last = await idb.get('syncPassphraseCheck').catch(() => null);
    const saved = await idb.get(`syncKey:${S.account.email}`).catch(() => null);
    if (saved && last && (await C.deriveKeys(C.fromB64(saved))).check === last && !(await lumioHas(saved, status))) {
      mode = 'passphrase';
      S.modeChanged = status.mode === 'managed';
    }
  }
  S.mode = mode;
  S.managed = status.managedAvailable === true && mode !== 'passphrase';
  idb.set('syncMode', S.mode).catch(() => {});
  idb.set('syncManaged', S.managed).catch(() => {});
  return status;
}

// Lumio hands back exactly the key saved here: a device that had it gave it
// to Lumio, so there's nothing left to keep from it.
async function lumioHas(saved, status) {
  if (status.mode !== 'managed' || status.managedAvailable !== true || status.managedKey !== true || Date.now() < S.keyRetryAt) return false;
  if ((await C.deriveKeys(C.fromB64(saved))).check !== status.keyCheck) return false;
  try {
    const r = await api('/api/sync/key', { method: 'POST', body: {} });
    return r.status === 'ready' && r.key === saved;
  } catch (err) {
    backOff(err);
    return false;
  }
}

// Lumio's key routes allow a few reads an hour: after "too many requests",
// none for ten minutes (its retry-after).
function backOff(err) { if (err.code === 'rate_limited') S.keyRetryAt = Date.now() + 10 * 60_000; }

// The key saved on this phone, if it's the account's (else it's removed,
// except while S.modeChanged: then it's this phone's own passphrase key).
async function savedKey(keyCheck) {
  const saved = await idb.get(`syncKey:${S.account.email}`);
  if (!saved) return null;
  const keys = await C.deriveKeys(C.fromB64(saved));
  if (keyCheck && keys.check === keyCheck) { S.keys = keys; return saved; }
  if (!S.modeChanged) await idb.del(`syncKey:${S.account.email}`);
  return null;
}

// Signed out (managed): the key leaves this phone.
async function forgetKey() {
  S.keys = null;
  const owner = S.account?.email || await idb.get('syncKeyOwner');
  if (owner) await idb.del(`syncKey:${owner}`);
  await idb.del('syncKeyOwner');
}

// The key only the account's devices have (passphrase mode, or an older
// server): a computer approves this phone, or the recovery key.
async function e2ee(status) {
  if (!status.keyCheck) return needsSync();
  await savedKey(status.keyCheck);
  if (!S.keys) return S.modeChanged ? modeChanged() : pair(status.keyCheck);
  start();
}

// The server says the account no longer uses its own passphrase, with a key
// that isn't the one on this phone: nobody is asked for a key (Lumio would
// answer with its own). The person can choose Lumio's key instead.
function modeChanged() {
  $('#nav').hidden = true;
  render(`<div class="hero"><div class="mark"></div><h1>Sync is paused</h1>
    <p>Lumio’s server says your account no longer uses your own passphrase, but this phone didn’t hear that from a device that has your key, so the key stays here.</p>
    <p>If you turned it off in Lumio Browser, or reset sync there, use the key Lumio keeps. Then Lumio could technically read what you sync.</p>
    <button class="btn primary block" onclick="location.reload()">Try again</button>
    <button class="btn block" id="use-lumio">Use the key Lumio keeps</button></div>`);
  $('#use-lumio').addEventListener('click', async () => {
    await idb.set('syncMode', 'managed').catch(() => {});
    location.reload();
  });
}

// Managed: the account's key from Lumio. { raw } once it's there, else
// { status: 'waiting', keyCheck } (an account whose key isn't on Lumio yet).
// After "too many requests", not again for a while.
async function fetchKey() {
  if (Date.now() < S.keyRetryAt) throw Object.assign(new Error('Too many requests. Try again in a few minutes.'), { code: 'rate_limited' });
  const r = await api('/api/sync/key', { method: 'POST', body: {} }).catch((err) => { backOff(err); throw err; });
  if (r.status !== 'ready') return r;
  const raw = C.fromB64(r.key);
  if (raw.length !== 32 || (await C.deriveKeys(raw)).check !== r.keyCheck) throw new Error('That key didn’t match. Try again.');
  return { ...r, raw };
}

// Managed, with the key here but not on Lumio: upload it (at most every 10
// minutes; it's checked against the account's, and failures wait for later).
function upload(key) {
  if (Date.now() - S.lastUpload < 10 * 60_000) return;
  S.lastUpload = Date.now();
  api('/api/sync/key', { method: 'PUT', body: { key } }).catch(() => {});
}

function render(html) { app.innerHTML = html; }

// Inside the Lumio app (iOS/Android), the app signs in and turns on
// notifications natively; this page asks it to.
const inApp = () => !!window.ReactNativeWebView;
const toApp = (msg) => window.ReactNativeWebView?.postMessage(JSON.stringify(msg));

function signIn() {
  $('#nav').hidden = true;
  render(`<div class="hero"><div class="mark"></div><h1>Lumio, in your pocket</h1>
    <p>See what Lumio is doing on your computer, approve its steps, and pick up your chats, from anywhere.</p>
    ${inApp() ? '<button class="btn primary block" id="app-sign-in">Sign in to Lumio</button>' : `<a class="btn primary block" href="/signin?next=${encodeURIComponent('/companion')}">Sign in to Lumio</a>`}</div>`);
  $('#app-sign-in')?.addEventListener('click', () => toApp({ type: 'sign-in' }));
}

function needsSync() {
  $('#nav').hidden = true;
  render(`<div class="hero"><div class="mark"></div><h1>Turn on Sync first</h1>
    <p>On your computer, open Lumio Browser, go to <b>Settings › Sync</b>, and turn it on. Then come back here.</p>
    <button class="btn primary block" onclick="location.reload()">I turned it on</button></div>`);
}

// ---------------------------------------------------------------- pairing
// The phone asks; the computer shows the same code and approves.
// managed: the account's key isn't on Lumio yet (an account from before
// managed sync). A computer with the latest version puts it there, and Lumio
// then approves this request itself; an older one approves it as before.
async function pair(keyCheck, { managed = false } = {}) {
  $('#nav').hidden = true;
  const kp = await C.pairKeyPair();
  const code = await C.pairCode(kp.publicKey);
  const ask = () => api('/api/sync/pair', { method: 'POST', body: { device: S.device, name: phoneName(), kind: 'phone', pubkey: kp.publicKey } });
  let req;
  try {
    req = await ask();
  } catch (err) {
    return render(`<div class="hero"><div class="mark"></div><h1>Couldn’t connect</h1><p>${esc(err.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`);
  }
  render(`<div class="hero"><div class="mark"></div>${managed ? `<h1>Finishing setup</h1>
    <p>Open Lumio Browser on a computer that already syncs. Once it has the latest version, your phone connects by itself.</p>
    <p>Using an older version? Approve <b>${esc(phoneName())}</b> there. It should show this code:</p>` : `<h1>Connect your phone</h1>
    <p>Lumio on your computer will ask to approve <b>${esc(phoneName())}</b>. Approve it only if it shows this code:</p>`}
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
  let started = Date.now();
  const check = async () => {
    if (S.keys) return;
    try {
      const r = await api(`/api/sync/pair/${req.id}`);
      if (S.keys) return;
      if (r.status === 'approved') {
        const raw = await C.unwrapFromApprover(kp.privateKey, r.approverPub, r.wrapped);
        if ((await C.deriveKeys(raw)).check !== keyCheck) throw new Error('The key didn’t match. Try again.');
        return adopt(raw);
      }
      if (r.status === 'denied') { $('#pair-err').textContent = 'Your computer said no. Reload to ask again.'; return; }
      if (r.status === 'expired' || Date.now() - started > 9 * 60_000) {
        if (!managed) { $('#pair-err').textContent = 'That request expired. Reload to ask again.'; return; }
        // Managed: ask again quietly (the same code).
        req = await ask();
        started = Date.now();
      }
    } catch (err) {
      if (err.status === 401) return; // signed out: the sign-in screen is up
      $('#pair-err').textContent = err.message;
    }
    setTimeout(check, 2000);
  };
  setTimeout(check, 2000);
  // Managed: once the key is on Lumio, get it from there.
  if (managed) {
    const poll = async () => {
      if (S.keys) return;
      let wait = 10_000;
      try {
        const st = await syncStatus();
        if (S.managed && (!st.keyCheck || st.managedKey)) {
          const r = await fetchKey();
          if (r.raw && !S.keys) return adopt(r.raw);
        }
      } catch (err) {
        if (err.status === 401) return;
        if (err.code === 'rate_limited') wait = Math.max(wait, S.keyRetryAt - Date.now()); // "too many requests": not before Lumio says
      }
      setTimeout(poll, wait);
    };
    setTimeout(poll, 10_000);
  }
}

const finishing = (keyCheck) => pair(keyCheck, { managed: true });

async function adopt(raw) {
  await idb.set(`syncKey:${S.account.email}`, C.toB64(raw));
  await idb.set('syncKeyOwner', S.account.email);
  S.keys = await C.deriveKeys(raw);
  // A new key (another device reset sync): everything is pulled again with it.
  S.records = { chats: new Map(), workflows: new Map(), tabs: new Map() };
  S.cursor = 0;
  start();
}

// ---------------------------------------------------------------- running
// Again with a new key: the views and the pull start over.
function start() {
  $('#nav').hidden = false;
  const first = !S.started;
  S.started = true;
  if (first) {
    document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => { S.chat = null; show(b.dataset.view); }));
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.get('chat')) { S.chat = hash.get('chat'); S.view = 'chats'; }
  }
  show(S.view);
  pullAll();
  pollStatus();
  pollNotices();
  if (!first) return;
  setInterval(() => { if (!document.hidden) pullAll(); }, 15_000);
  setInterval(() => { if (!document.hidden) checkKey(); }, 60_000);
  setInterval(() => { if (!document.hidden) pollStatus(); }, 2500);
  setInterval(() => { if (!document.hidden) pollNotices(); }, 10_000);
  // Seen recently: computers check for commands more often.
  setInterval(() => { if (!document.hidden) api('/api/sync/devices', { method: 'POST', body: { id: S.device, name: phoneName(), kind: 'phone' } }).catch(() => {}); }, 20_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollStatus(); pullAll(); } });
  if ('serviceWorker' in navigator && !inApp()) navigator.serviceWorker.register('/companion-sw.js').catch(() => {});
}

function show(view) {
  S.view = view;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  ({ now: renderNow, chats: renderChats, workflows: renderWorkflows, tabs: renderTabs })[view]();
}

// The account's key can change while this page is open (Reset sync, or the
// passphrase setting, on a computer).
async function checkKey() {
  const { keys } = S;
  if (!keys) return;
  try {
    let status = await syncStatus();
    if (S.keys !== keys) return;
    if (status.keyCheck === keys.check) {
      const saved = S.managed && !status.managedKey && await idb.get(`syncKey:${S.account.email}`);
      if (saved) upload(saved);
      return;
    }
    if (S.managed) {
      try {
        const r = await fetchKey();
        if (S.keys !== keys) return;
        if (r.raw) return adopt(r.raw);
        await forgetKey();
        return finishing(r.keyCheck);
      } catch (err) {
        if (err.code !== 'passphrase_mode') throw err;
        status = await syncStatus();
      }
    }
    if (S.keys !== keys) return;
    // The server says managed without this phone's passphrase key: keep it, ask nobody.
    if (S.modeChanged) { S.keys = null; return modeChanged(); }
    // The account's own passphrase: a computer approves this phone again.
    await forgetKey();
    e2ee(status);
  } catch { /* try again later */ }
}

// Chats, workflows and tabs synced from the computers (read-only here).
async function pullAll() {
  const { keys, records } = S;
  if (!keys) return;
  try {
    for (let i = 0; i < 20; i++) {
      const res = await api(`/api/sync/changes?since=${S.cursor}&device=${encodeURIComponent(S.device)}&collections=chats,workflows,tabs&limit=500`);
      if (S.keys !== keys) return; // a new key: its own pull starts over
      for (const it of res.items) {
        const map = records[it.collection];
        if (!map) continue;
        if (it.deleted) { map.delete(it.id); continue; }
        try { map.set(it.id, (await C.open(keys, it.collection, it.id, it.data)).r); } catch { /* another key */ }
      }
      if (S.keys !== keys) return;
      S.cursor = res.cursor;
      if (!res.more) break;
    }
    if (S.view !== 'now' && !document.activeElement?.matches('input, textarea')) show(S.view);
  } catch { /* try again later */ }
}

async function pollStatus() {
  const { keys } = S;
  if (!keys) return;
  try {
    const { computers } = await api('/api/companion/status');
    const list = await Promise.all(computers.map(async (c) => {
      let status = null;
      try { status = c.status ? await C.open(keys, 'companion', 'status', c.status) : null; } catch { /* old key */ }
      return { ...c, status };
    }));
    if (S.keys !== keys) return;
    S.computers = list;
    if (!S.target || !S.computers.some((c) => c.id === S.target)) S.target = (S.computers.find((c) => c.online) || S.computers[0])?.id || null;
    const sig = JSON.stringify([S.target, S.computers.map((c) => [c.id, c.online, c.status])]);
    if (S.view === 'now' && sig !== S.lastSig) renderNow();
    S.lastSig = sig;
  } catch { /* try again */ }
}

async function pollNotices() {
  if (!S.keys) return;
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
  if (inApp()) return localStorage.getItem('lumioPush') === S.device ? '' : '<div class="card notify"><p>Get a notification when Lumio finishes or needs your OK.</p><button class="btn" id="notify-on">Turn on</button></div>';
  if (!('Notification' in window) && !/iPhone|iPad/.test(navigator.userAgent)) return '';
  if (window.Notification?.permission === 'granted' && localStorage.getItem('lumioPush') === S.device) return '';
  if (/iPhone|iPad/.test(navigator.userAgent) && !standalone()) {
    return '<div class="card notify"><p>Add Lumio to your Home Screen (Share → Add to Home Screen) to get notified when Lumio finishes or needs you.</p></div>';
  }
  if (!('PushManager' in window)) return '';
  return '<div class="card notify"><p>Get a notification when Lumio finishes or needs your OK.</p><button class="btn" id="notify-on">Turn on</button></div>';
}
// The app answers with its Expo push token (or why it couldn't).
window.lumioNativePush = async (token) => {
  try {
    await api('/api/companion/push', { method: 'POST', body: { device: S.device, endpoint: `expo:${token}` } });
    localStorage.setItem('lumioPush', S.device);
    toast('Notifications are on.');
    if (S.view === 'now') renderNow();
  } catch (err) { toast(`Couldn’t turn on notifications: ${err.message}`); }
};
window.lumioNativePushError = (msg) => toast(String(msg || 'Notifications are off. You can turn them on in Settings.'));

function bindNotify() {
  $('#notify-on')?.addEventListener('click', async () => {
    if (inApp()) { toApp({ type: 'push' }); return; }
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
