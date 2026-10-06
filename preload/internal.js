// Preload for tab pages. It runs in an isolated world, so websites can't see
// or call anything here.
//  - Lumio's own lumio:// pages get a small bridge; normal websites see nothing.
//    The main process re-checks the sender's URL and host.
//  - On http(s) pages it helps with passwords: it notices sign-ins the person
//    typed, shows saved accounts when they click a sign-in field, and fills
//    only what they pick in Lumio's own dropdown. Passwords are never exposed
//    to the page before that choice.
//  - Passkeys: navigator.credentials.create()/get() for public keys go to
//    Lumio (main/password-manager.js), which asks the person, confirms it's
//    them and answers as the authenticator. The page only gets the result.
//  - alert(), confirm() and prompt() are answered in Lumio's own dialog in the
//    tab (main/page-dialogs.js) instead of Electron's app-wide boxes (it has
//    no prompt() at all).
//  - It tells Lumio about a click in a frame from another site, which lets
//    the page open a pop-up, and about a form the person sends, which leaves
//    the page without "Leave site?" (main/tabs.js).
//  - Security (main/security.js): a secure page sending a form to an http
//    address is reported, so Lumio can ask first; pages see
//    navigator.globalPrivacyControl when that's on; and the page's camera,
//    microphone and screen tracks are counted for the tab's capture
//    indicators, with "Stop sharing" ending its screen tracks.
const { contextBridge, ipcRenderer } = require('electron');

if (window.location.protocol === 'lumio:') {
  const EVENTS = new Set(['appearance', 'ui-prefs', 'bookmarks-changed']); // what the browser tells its pages
  contextBridge.exposeInMainWorld('lumioPage', {
    invoke: (channel, ...args) => (/^page:/.test(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('blocked'))),
    on: (channel, fn) => { if (EVENTS.has(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload)); },
  });
}

// Every page in a tab, Lumio's own too (Settings asks before deleting).
// Frames don't get them: main/tabs.js turns Electron's off, so theirs return
// at once, like a blocked dialog.
if (/^(https?|file|lumio|chrome-extension):$/.test(window.location.protocol) && window === window.top) {
  try {
    contextBridge.executeInMainWorld({
      func: installDialogs,
      // Synchronous, so the page waits for the answer like with the real ones.
      args: [(kind, message, value) => ipcRenderer.sendSync('js-dialog', { kind, message, value })],
    });
  } catch { /* the page keeps none: Electron's are off */ }
}

// A click in a frame from another site (a "Sign in with…" or "Pay with…"
// button, a link in an embedded video) never reaches Lumio as a click on the
// page. But the page shares the frame's activation, and a page can't fake
// that. So while focus is in a frame, look at it often (between a click's
// mouse-down and mouse-up), and tell Lumio: the click counts for opening a
// pop-up (main/tabs.js).
if (/^(https?|file):$/.test(window.location.protocol) && window === window.top) {
  const inFrame = () => document.activeElement?.tagName === 'IFRAME';
  let timer = 0;
  let was = false;
  const look = () => {
    if (!inFrame()) { clearInterval(timer); timer = 0; was = false; return; }
    // Once per click: activation stays on for a few seconds after it, which
    // mustn't count as many clicks.
    const now = !!navigator.userActivation?.isActive;
    if (now && !was) ipcRenderer.send('user-activation');
    was = now;
  };
  // Focus went into a frame (the page itself gets no more events): watch until it's back.
  window.addEventListener('blur', () => setTimeout(() => {
    look();
    if (inFrame() && !timer) timer = setInterval(look, 50);
  }, 0));

  // A form the person sends (a click, or Enter) leaves the page without
  // "Leave site?", so its data still goes (main/tabs.js). Only a real one:
  // a page can't fake the activation, and a form it stops itself doesn't count.
  window.addEventListener('submit', (e) => {
    if (!e.defaultPrevented && navigator.userActivation?.isActive) ipcRenderer.send('form-sent');
  });
}

if (/^https?:$/.test(window.location.protocol) && window === window.top) {
  passwordHelper();
  securityHelper();
  try {
    contextBridge.executeInMainWorld({
      func: installPasskeys,
      args: [{
        request: (kind, payload) => ipcRenderer.invoke('pk:request', { ...payload, kind }),
        cancel: () => ipcRenderer.send('pk:cancel'),
      }],
    });
  } catch { /* the page keeps its own navigator.credentials */ }
  // Share buttons (navigator.share) and media controls (main/share.js, main/media.js).
  let mediaRun = null;
  try {
    contextBridge.executeInMainWorld({
      func: installPageApis,
      args: [{
        share: (data) => ipcRenderer.invoke('share:web', data),
        mediaActions: (list) => ipcRenderer.send('media:actions', list),
        mediaConnect: (run) => { mediaRun = run; },
      }],
    });
  } catch { /* the page keeps Electron's own */ }
  ipcRenderer.on('media:session', (_e, msg) => { try { mediaRun?.(String(msg?.action || ''), msg?.details || {}); } catch { /* the page's handler failed */ } });
}

// Runs in the page's own world (before its scripts), so it must be
// self-contained; only `bridge` reaches back to Lumio.
// - navigator.share() and canShare() open Lumio's share popover. Files can't
//   be shared, so canShare({ files }) is false and sites share a link instead.
// - navigator.mediaSession.setActionHandler() still works as before, and the
//   handlers are also kept here so the toolbar's media controls can run them
//   (previous / next track, the site's own play and pause).
function installPageApis(bridge) {
  const native = (name, fn) => {
    const f = { [name](...args) { return fn.apply(this, args); } }[name];
    Object.defineProperty(f, 'toString', { value: () => `function ${name}() { [native code] }` });
    return f;
  };
  if (window.isSecureContext && window.Navigator) {
    let busy = false;
    const check = (data) => {
      if (data == null || typeof data !== 'object') throw new TypeError('Failed to execute \'share\' on \'Navigator\': No known share data fields supplied.');
      if (data.files && data.files.length) throw new DOMException('Lumio can’t share files from websites.', 'NotAllowedError');
      const out = {};
      if (data.title !== undefined) out.title = String(data.title);
      if (data.text !== undefined) out.text = String(data.text);
      if (data.url !== undefined) {
        let u;
        try { u = new URL(String(data.url), document.baseURI); } catch { throw new TypeError('Invalid URL'); }
        if (!/^https?:$/.test(u.protocol)) throw new TypeError('Invalid URL');
        out.url = u.href;
      }
      if (!out.title && !out.text && !out.url) throw new TypeError('Failed to execute \'share\' on \'Navigator\': No known share data fields supplied.');
      return out;
    };
    const share = native('share', async (data) => {
      if (busy) throw new DOMException('An earlier share has not yet completed.', 'InvalidStateError');
      if (navigator.userActivation && !navigator.userActivation.isActive) throw new DOMException('Must be handling a user gesture to perform a share request.', 'NotAllowedError');
      const clean = check(data);
      busy = true;
      try {
        const res = await bridge.share(clean);
        if (!res || res.error) throw new DOMException(res?.message || 'Share canceled', res?.error || 'AbortError');
      } finally {
        busy = false;
      }
    });
    const canShare = native('canShare', (data) => { try { check(data); return true; } catch { return false; } });
    Object.defineProperty(window.Navigator.prototype, 'share', { value: share, writable: true, configurable: true, enumerable: true });
    Object.defineProperty(window.Navigator.prototype, 'canShare', { value: canShare, writable: true, configurable: true, enumerable: true });
  }
  const MS = window.MediaSession;
  if (MS && MS.prototype.setActionHandler) {
    const handlers = new Map();
    const set = MS.prototype.setActionHandler;
    MS.prototype.setActionHandler = native('setActionHandler', function setActionHandler(action, handler) {
      const result = set.call(this, action, handler); // throws for an unknown action, as before
      if (typeof handler === 'function') handlers.set(String(action), handler); else handlers.delete(String(action));
      bridge.mediaActions([...handlers.keys()]);
      return result;
    });
    bridge.mediaConnect((action, details) => {
      const h = handlers.get(action);
      if (h) h.call(navigator.mediaSession, { ...details, action });
    });
  }
}

// Back and forward from the mouse's buttons and (on a Mac) two-finger swipes,
// and Alt/Option-click to download a link: main/navigation.js does them.
if (/^(https?|file|lumio):$/.test(window.location.protocol) && window === window.top) navigationHelper();

// Runs in the page's own world (before its scripts), so it must be
// self-contained. `ask` reaches Lumio, which names the site itself (the page
// only gives the text). Like Chrome, no dialogs while the page is unloading.
function installDialogs(ask) {
  const currentEvent = Object.getOwnPropertyDescriptor(window, 'event')?.get;
  const unloading = () => /^(beforeunload|pagehide|unload)$/.test(currentEvent?.call(window)?.type || '');
  const text = (v) => (v === undefined ? '' : String(v));
  const native = (name, fn) => {
    const f = { [name](...args) { return fn(...args); } }[name];
    Object.defineProperty(f, 'toString', { value: () => `function ${name}() { [native code] }` });
    return f;
  };
  window.alert = native('alert', (message) => { if (!unloading()) ask('alert', text(message)); });
  window.confirm = native('confirm', (message) => !unloading() && ask('confirm', text(message)) === true);
  window.prompt = native('prompt', (message, value) => {
    if (unloading()) return null;
    const answer = ask('prompt', text(message), text(value));
    return typeof answer === 'string' ? answer : null;
  });
}

// Runs in the page's own world (before its scripts), so it must be
// self-contained. Only `bridge` reaches back to Lumio, and Lumio decides the
// origin itself, so a page can only ever ask for its own site's passkeys.
function installPasskeys(bridge) {
  const C = window.navigator.credentials;
  const PKC = window.PublicKeyCredential;
  if (!C || !PKC) return;
  const nativeCreate = C.create.bind(C);
  const nativeGet = C.get.bind(C);
  const b64 = (v) => {
    const u = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const bin = (s) => {
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(t + '==='.slice((t.length + 3) % 4));
    const u = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
    return u.buffer;
  };
  const plain = (v) => {
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return b64(v);
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = plain(v[k]); return o; }
    return v;
  };
  const own = (obj, props) => { for (const k of Object.keys(props)) Object.defineProperty(obj, k, { value: props[k], enumerable: true, configurable: true }); return obj; };
  function build(kind, c) {
    const R = kind === 'create' ? window.AuthenticatorAttestationResponse : window.AuthenticatorAssertionResponse;
    const response = Object.create(R ? R.prototype : Object.prototype);
    if (kind === 'create') {
      own(response, {
        clientDataJSON: bin(c.clientDataJSON), attestationObject: bin(c.attestationObject),
        getTransports: () => c.transports.slice(), getAuthenticatorData: () => bin(c.authenticatorData),
        getPublicKey: () => bin(c.publicKey), getPublicKeyAlgorithm: () => c.publicKeyAlgorithm,
        toJSON: () => ({ clientDataJSON: c.clientDataJSON, attestationObject: c.attestationObject, authenticatorData: c.authenticatorData, publicKey: c.publicKey, publicKeyAlgorithm: c.publicKeyAlgorithm, transports: c.transports.slice() }),
      });
    } else {
      own(response, {
        clientDataJSON: bin(c.clientDataJSON), authenticatorData: bin(c.authenticatorData), signature: bin(c.signature),
        userHandle: c.userHandle ? bin(c.userHandle) : null,
        toJSON: () => ({ clientDataJSON: c.clientDataJSON, authenticatorData: c.authenticatorData, signature: c.signature, ...(c.userHandle ? { userHandle: c.userHandle } : {}) }),
      });
    }
    const ext = kind === 'create' && c.credProps ? { credProps: { rk: true } } : {};
    return own(Object.create(PKC.prototype), {
      id: c.id, rawId: bin(c.id), type: 'public-key', response, authenticatorAttachment: 'platform',
      getClientExtensionResults: () => JSON.parse(JSON.stringify(ext)),
      toJSON: () => ({ id: c.id, rawId: c.id, type: 'public-key', response: response.toJSON(), authenticatorAttachment: 'platform', clientExtensionResults: JSON.parse(JSON.stringify(ext)) }),
    });
  }
  async function run(kind, options) {
    const signal = options.signal;
    const abortError = () => signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    if (signal?.aborted) throw abortError();
    let onAbort;
    const aborted = new Promise((_, reject) => { onAbort = () => { bridge.cancel(); reject(abortError()); }; signal?.addEventListener('abort', onAbort, { once: true }); });
    try {
      const res = await Promise.race([bridge.request(kind, { publicKey: plain(options.publicKey), mediation: options.mediation || null }), aborted]);
      if (!res || res.error) throw new DOMException(res?.message || 'The operation either timed out or was not allowed.', res?.error || 'NotAllowedError');
      return build(kind, res.credential);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
  const native = (name, fn) => {
    const f = { [name](...args) { return fn.apply(this, args); } }[name];
    Object.defineProperty(f, 'toString', { value: () => `function ${name}() { [native code] }` });
    return f;
  };
  C.create = native('create', (options) => (options && options.publicKey ? run('create', options) : nativeCreate(options)));
  C.get = native('get', (options) => (options && options.publicKey ? run('get', options) : nativeGet(options)));
  PKC.isUserVerifyingPlatformAuthenticatorAvailable = native('isUserVerifyingPlatformAuthenticatorAvailable', async () => true);
  PKC.isConditionalMediationAvailable = native('isConditionalMediationAvailable', async () => true);
  if (typeof PKC.getClientCapabilities === 'function') {
    const caps = PKC.getClientCapabilities.bind(PKC);
    PKC.getClientCapabilities = native('getClientCapabilities', async () => ({
      ...(await caps().catch(() => ({}))),
      conditionalCreate: false, conditionalGet: true, hybridTransport: false,
      passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true,
    }));
  }
}

function securityHelper() {
  if (window.location.protocol === 'https:') {
    document.addEventListener('submit', (e) => {
      // A button's formaction reads as the page's own address when it has none.
      const action = e.submitter?.hasAttribute?.('formaction') ? e.submitter.formAction : e.target?.action;
      if (typeof action === 'string' && /^http:/i.test(action)) ipcRenderer.send('sec:form', action);
    }, true);
  }
  let flags = {};
  try { flags = ipcRenderer.sendSync('sec:flags') || {}; } catch { /* keep the defaults */ }
  try {
    contextBridge.executeInMainWorld({
      func: installPageWatch,
      args: [{ gpc: !!flags.gpc }, {
        report: (counts) => ipcRenderer.send('capture:report', counts),
        onStop: (fn) => ipcRenderer.on('capture:stop', () => fn()),
      }],
    });
  } catch { /* the page keeps its own media functions */ }
}

// Runs in the page's own world before its scripts (self-contained, like
// installPasskeys). The counts are only a hint: Lumio turns an indicator off
// only when they account for every capture it allowed (main/capture.js).
function installPageWatch(flags, bridge) {
  if (flags.gpc && !('globalPrivacyControl' in Navigator.prototype)) {
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get() { return true; }, configurable: true, enumerable: true });
  }
  const md = window.navigator.mediaDevices;
  const Track = window.MediaStreamTrack;
  if (!md || !Track) return;
  const tracks = new Map(); // track -> 'camera' | 'microphone' | 'display'
  const settled = { camera: 0, microphone: 0, display: 0 }; // finished requests, allowed or not
  let timer = 0;
  const send = () => {
    timer = 0;
    const live = { camera: 0, microphone: 0, display: 0 };
    for (const [t, kind] of tracks) { if (t.readyState === 'live') live[kind]++; else tracks.delete(t); }
    bridge.report({ settled: { ...settled }, live });
  };
  const report = () => { if (!timer) timer = setTimeout(send, 60); };
  const watch = (t, kind) => { if (tracks.has(t)) return; tracks.set(t, kind); t.addEventListener('ended', report); };
  const native = (name, f) => {
    Object.defineProperty(f, 'name', { value: name });
    Object.defineProperty(f, 'toString', { value: () => `function ${name}() { [native code] }` });
    return f;
  };
  const nativeStop = Track.prototype.stop;
  const nativeClone = Track.prototype.clone;
  Track.prototype.stop = native('stop', function stop() { nativeStop.call(this); if (tracks.has(this)) report(); });
  Track.prototype.clone = native('clone', function clone() {
    const copy = nativeClone.call(this);
    if (tracks.has(this)) { watch(copy, tracks.get(this)); report(); }
    return copy;
  });
  const wrap = (name, kindOf, asked) => {
    const original = md[name];
    if (typeof original !== 'function') return;
    md[name] = native(name, async function (...args) {
      try {
        const stream = await original.apply(md, args);
        for (const t of stream.getTracks()) watch(t, kindOf(t));
        return stream;
      } finally {
        for (const k of asked(args[0] || {})) settled[k]++;
        report();
      }
    });
  };
  wrap('getUserMedia', (t) => (t.kind === 'video' ? 'camera' : 'microphone'), (c) => [...(c.video ? ['camera'] : []), ...(c.audio ? ['microphone'] : [])]);
  wrap('getDisplayMedia', () => 'display', () => ['display']);
  // "Stop sharing": the screen tracks end as if the person stopped them in the browser.
  bridge.onStop(() => {
    for (const [t, kind] of tracks) {
      if (kind !== 'display' || t.readyState !== 'live') continue;
      nativeStop.call(t);
      t.dispatchEvent(new Event('ended'));
    }
    report();
  });
}

function passwordHelper() {
  const typed = new WeakSet(); // fields the person typed into, or Lumio filled
  let lastSent = 0;
  let activeField = null;
  let shown = false;

  const isInput = (el) => el instanceof HTMLInputElement;
  const isPassword = (el) => isInput(el) && el.type === 'password';
  const isText = (el) => isInput(el) && /^(text|email|tel|search|)$/i.test(el.getAttribute('type') || 'text');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
  };
  const scopeOf = (el) => el?.form || el?.closest?.('form') || document;
  const passwordsIn = (scope) => [...scope.querySelectorAll('input[type=password]')].filter(visible);
  const isNewPassword = (el) => /new-password/i.test(el.autocomplete || '');

  function usernameFor(scope, anchor) {
    const inputs = [...scope.querySelectorAll('input')].filter((el) => isText(el) && visible(el));
    const hinted = inputs.find((el) => /username|email/i.test(el.autocomplete || ''));
    if (hinted) return hinted;
    if (!anchor) return inputs[0] || null;
    const before = inputs.filter((el) => el.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before[before.length - 1] || null;
  }

  document.addEventListener('input', (e) => { if (e.isTrusted && isInput(e.target)) typed.add(e.target); }, true);

  // ---- noticing a sign-in ----
  function capture(scope) {
    const filled = passwordsIn(scope).filter((p) => p.value && typed.has(p));
    if (!filled.length) return;
    const now = Date.now();
    if (now - lastSent < 1500) return;
    lastSent = now;
    // Sign-up and change-password forms: save the new password.
    const fresh = filled.find(isNewPassword) || (filled.length >= 2 ? filled[filled.length - 1] : null);
    const password = (fresh || filled[0]).value;
    const username = (usernameFor(scope, filled[0])?.value || '').trim();
    if (password.length > 512 || username.length > 300) return;
    ipcRenderer.send('pw:captured', { username, password, isNew: !!fresh });
  }
  document.addEventListener('submit', (e) => capture(e.target), true);
  // Sign-ins that don't use a real form submit: a button click, or Enter.
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const btn = e.target.closest?.('button, input[type=submit], input[type=button], [role=button]');
    if (!btn) return;
    const scope = scopeOf(btn);
    if (passwordsIn(scope).some((p) => p.value)) setTimeout(() => capture(scope), 0);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.isTrusted && e.key === 'Enter' && isPassword(e.target)) capture(scopeOf(e.target));
  }, true);

  // ---- suggestions ----
  function loginField(el) {
    if (!isInput(el) || el.disabled || el.readOnly || !visible(el)) return false;
    if (isPassword(el)) return true;
    return isText(el) && passwordsIn(scopeOf(el)).length > 0;
  }
  function signUpForm(el) {
    const pws = passwordsIn(scopeOf(el));
    return isNewPassword(el) || pws.some(isNewPassword) || pws.length >= 2;
  }
  async function suggest(el) {
    const wantsNew = isPassword(el) && signUpForm(el);
    const res = await ipcRenderer.invoke('pw:query', { newPassword: wantsNew }).catch(() => null);
    if (!res || (!res.accounts && !res.generate)) return;
    activeField = el;
    const r = el.getBoundingClientRect();
    shown = true;
    ipcRenderer.send('pw:show', { x: r.left, y: r.bottom, width: r.width });
  }
  function hide() {
    if (!shown) return;
    shown = false;
    ipcRenderer.send('pw:hide');
  }
  document.addEventListener('click', (e) => { if (e.isTrusted && loginField(e.target)) suggest(e.target); }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (e.key === 'ArrowDown' && loginField(e.target) && !shown) suggest(e.target);
    else if (e.key === 'Escape' || (e.key.length === 1 && shown)) hide();
  }, true);
  document.addEventListener('focusout', () => setTimeout(() => { if (document.activeElement !== activeField) hide(); }, 250), true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('pagehide', hide);

  // ---- filling what the person picked ----
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  function setValue(input, value) {
    input.focus();
    nativeValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    typed.add(input);
  }
  ipcRenderer.on('pw:fill', (_e, { username, password, generated }) => {
    shown = false;
    const anchor = activeField && document.contains(activeField) ? activeField : document.activeElement;
    const scope = scopeOf(anchor);
    const pws = passwordsIn(scope);
    if (generated) {
      // New password + confirm; on a change form, skip the current-password field.
      const targets = pws.length >= 3 ? pws.slice(1) : pws.filter((p) => !p.value || isNewPassword(p) || pws.length === 2);
      (targets.length ? targets : [anchor]).forEach((p) => isPassword(p) && setValue(p, password));
      return;
    }
    const user = usernameFor(scope, pws[0] || anchor);
    if (user && username) setValue(user, username);
    if (pws[0]) setValue(pws[0], password);
  });
}

function navigationHelper() {
  // The mouse's back (3) and forward (4) buttons. Main goes there unless
  // Chromium already did, or the page used the click itself. (On Linux
  // Electron turns them into the window's app-command as they're pressed.)
  const BUTTONS = { 3: 'back', 4: 'forward' };
  if (process.platform !== 'linux') {
    window.addEventListener('mousedown', (e) => {
      if (e.isTrusted && BUTTONS[e.button]) ipcRenderer.send('nav:mouse', { phase: 'down' });
    }, true);
    window.addEventListener('mouseup', (e) => {
      const dir = BUTTONS[e.button];
      if (!e.isTrusted || !dir) return;
      setTimeout(() => { if (!e.defaultPrevented) ipcRenderer.send('nav:mouse', { phase: 'up', dir }); }, 0);
    }, true);
  }

  // Alt/Option-click on a link the page didn't handle itself downloads it.
  // Listening late (on window, bubbling) lets the page's own handlers go first.
  window.addEventListener('click', (e) => {
    if (!e.isTrusted || e.defaultPrevented || e.button !== 0 || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const link = e.composedPath()[0]?.closest?.('a[href], area[href]');
    if (!link || !/^(https?|data|blob):/i.test(link.href)) return;
    e.preventDefault();
    ipcRenderer.send('nav:download', link.href);
  });

  if (process.platform === 'darwin') swipeHelper();
}

// macOS: two fingers sideways past the page's edge go back or forward, like
// Chrome. A gesture is a run of wheel events; its first moves decide whether
// it's a sideways swipe or an ordinary scroll. Main draws the arrow and decides.
function swipeHelper() {
  const GAP = 150; // ms without wheel events that ends a gesture
  let g = null; // { dx, dir, ax, ay, prev, decay, blocked }
  let frame = 0;
  let timer = 0;

  const send = (end) => { if (g && !g.blocked && g.dir) ipcRenderer.send('nav:swipe', { dx: g.dx, end }); };
  const end = () => { cancelAnimationFrame(frame); frame = 0; send(true); };

  // A page can turn swipes off for itself (overscroll-behavior-x on its root).
  const swipesOff = () => [document.documentElement, document.body].some((el) => el && getComputedStyle(el).overscrollBehaviorX !== 'auto');
  // Could the element under the pointer, or anything around it, still scroll that way?
  const scrolls = (el, dir) => {
    const root = document.scrollingElement;
    for (let n = el; n; n = n.parentElement || (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null)) {
      if (n.nodeType !== 1 || n.scrollWidth <= n.clientWidth + 1) continue;
      const style = getComputedStyle(n);
      if (n !== root && !/^(auto|scroll|overlay)$/.test(style.overflowX)) continue;
      if (n === root && /^(hidden|clip)$/.test(style.overflowX)) continue;
      const max = n.scrollWidth - n.clientWidth;
      const left = style.direction === 'rtl' ? max - Math.abs(n.scrollLeft) : n.scrollLeft;
      if (dir < 0 ? left > 1 : left < max - 1) return true;
    }
    return false;
  };

  function onWheel(e, target) {
    clearTimeout(timer);
    timer = setTimeout(() => { end(); g = null; }, GAP);
    if (!g) g = { dx: 0, dir: 0, ax: 0, ay: 0, prev: 0, decay: 0, blocked: false };
    if (g.blocked) return;
    if (e.defaultPrevented || e.ctrlKey || e.shiftKey || e.deltaMode !== 0) { g.blocked = true; return; }
    if (!g.dir) {
      g.ax += e.deltaX;
      g.ay += Math.abs(e.deltaY);
      if (Math.abs(g.ax) + g.ay < 6) return; // too little to tell yet
      if (Math.abs(g.ax) <= g.ay * 1.5) { g.blocked = true; return; } // an ordinary scroll
      g.dir = Math.sign(g.ax);
      if (swipesOff() || scrolls(target, g.dir)) { g.blocked = true; return; }
    }
    g.dx = g.dir * Math.max(0, g.dir * (g.dx + e.deltaX)); // swiping back past the start stops at 0
    // Momentum after the fingers lift shrinks steadily: that's letting go.
    const size = Math.abs(e.deltaX);
    g.decay = size && size < g.prev * 0.97 ? g.decay + 1 : 0;
    g.prev = size;
    if (g.decay >= 5) { end(); g.blocked = true; return; }
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; send(false); });
  }
  // Passive, and handled a moment later so the page's own handlers go first
  // (the element under the pointer is noted now: inside a shadow root it's gone later).
  window.addEventListener('wheel', (e) => {
    if (!e.isTrusted) return;
    const target = e.composedPath()[0] || e.target;
    setTimeout(() => onWheel(e, target), 0);
  }, { capture: true, passive: true });
}
