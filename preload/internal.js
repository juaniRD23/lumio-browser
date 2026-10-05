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
const { contextBridge, ipcRenderer } = require('electron');

if (window.location.protocol === 'lumio:') {
  const EVENTS = new Set(['appearance']); // what the browser tells its pages
  contextBridge.exposeInMainWorld('lumioPage', {
    invoke: (channel, ...args) => (/^page:/.test(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('blocked'))),
    on: (channel, fn) => { if (EVENTS.has(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload)); },
  });
}

if (/^https?:$/.test(window.location.protocol) && window === window.top) {
  passwordHelper();
  try {
    contextBridge.executeInMainWorld({
      func: installPasskeys,
      args: [{
        request: (kind, payload) => ipcRenderer.invoke('pk:request', { ...payload, kind }),
        cancel: () => ipcRenderer.send('pk:cancel'),
      }],
    });
  } catch { /* the page keeps its own navigator.credentials */ }
}

// navigator.registerProtocolHandler (and unregister…), which Electron ignores:
// Lumio asks the person and remembers the site's handler (main/protocol-handlers.js).
if (/^https?:$/.test(window.location.protocol) && window === window.top) {
  try {
    contextBridge.executeInMainWorld({
      func: installProtocolHandlers,
      args: [{
        register: (scheme, url) => ipcRenderer.send('ph:register', { scheme, url }),
        unregister: (scheme, url) => ipcRenderer.send('ph:unregister', { scheme, url }),
      }],
    });
  } catch { /* the page keeps the built-in one, which does nothing */ }
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

// Runs in the page's own world, so it must be self-contained. It checks what
// the HTML standard checks, so a page gets the same errors as in Chrome, and
// hands the rest to Lumio, which checks again (it knows the real origin).
function installProtocolHandlers(bridge) {
  const proto = window.Navigator && window.Navigator.prototype;
  if (!proto || !window.isSecureContext) return;
  const SAFE = ['bitcoin', 'cabal', 'dat', 'did', 'doi', 'dweb', 'ethereum', 'ftp', 'geo', 'hyper', 'im', 'ipfs', 'ipns', 'irc', 'ircs', 'magnet',
    'mailto', 'matrix', 'mms', 'news', 'nntp', 'openpgp4fpr', 'sftp', 'sip', 'sms', 'smsto', 'ssb', 'ssh', 'tel', 'urn', 'webcal', 'wtai', 'xmpp'];
  // The scheme and the full handler URL, or the error Chrome throws.
  function check(name, args) {
    if (args.length < 2) throw new TypeError(`Failed to execute '${name}' on 'Navigator': 2 arguments required, but only ${args.length} present.`);
    const s = String(args[0]).toLowerCase();
    if (!SAFE.includes(s) && !/^web\+[a-z]+$/.test(s)) throw new DOMException(`The scheme '${s}' doesn't belong to the scheme allowlist. Please prefix non-allowlisted schemes with the string 'web+'.`, 'SecurityError');
    const raw = String(args[1]);
    if (!raw.includes('%s')) throw new DOMException(`The url provided ('${raw}') does not contain '%s'.`, 'SyntaxError');
    let u;
    try { u = new URL(raw, document.baseURI); } catch { throw new DOMException(`The url provided ('${raw}') is not valid.`, 'SyntaxError'); }
    if (!/^https?:$/.test(u.protocol) || u.origin !== window.location.origin) throw new DOMException('Can only register custom handler in the document\'s origin.', 'SecurityError');
    return [s, u.href];
  }
  const methods = {
    registerProtocolHandler(scheme, url) { bridge.register(...check('registerProtocolHandler', arguments)); },
    unregisterProtocolHandler(scheme, url) { bridge.unregister(...check('unregisterProtocolHandler', arguments)); },
  };
  for (const [name, fn] of Object.entries(methods)) {
    Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true, enumerable: true });
  }
}
