// Preload for extension pages and service workers (chrome-extension:// only;
// registered on the normal profile by main/extension-shims.js). Adds
// chrome.alarms, chrome.sidePanel and chrome.identity where Electron has no
// such API; each call goes to Lumio through electron-chrome-extensions'
// router, which knows the calling extension. It runs before that library's
// own preload, which seals the chrome object afterwards.
const { contextBridge, ipcRenderer } = require('electron');

// A service worker's preload has no `location`; install() checks it's an extension's.
if (process.type === 'service-worker' || globalThis.location?.protocol === 'chrome-extension:') {
  const bridge = {
    call: (id, name, ...args) => ipcRenderer.invoke('crx-msg', id, `lumio.${name}`, ...args),
    listen: (id, name, fn) => {
      ipcRenderer.send('crx-add-listener', id, `lumio.${name}`);
      ipcRenderer.on(`crx-lumio.${name}`, (_e, ...args) => fn(...args));
    },
  };
  try {
    contextBridge.exposeInMainWorld('__lumioExtShims', bridge);
    contextBridge.executeInMainWorld({ func: install });
  } catch { /* the extension keeps the APIs it has */ }
}

// Runs in the extension's own world, so it must be self-contained.
function install() {
  const bridge = globalThis.__lumioExtShims;
  delete globalThis.__lumioExtShims;
  const chrome = globalThis.chrome;
  const id = chrome?.runtime?.id;
  if (!bridge || !id || Object.isFrozen(chrome)) return;
  const manifest = chrome.runtime.getManifest?.() || {};
  const perms = new Set(manifest.permissions || []);

  // Promise style, or the callback style older extensions use.
  const api = (name) => (...args) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const p = bridge.call(id, name, ...args);
    if (!cb) return p;
    p.then((v) => cb(v), (err) => { console.warn(`chrome.${name}: ${err?.message || err}`); cb(undefined); });
    return undefined;
  };
  const event = (name) => {
    const fns = new Set();
    let listening = false;
    return {
      addListener(fn) {
        fns.add(fn);
        if (!listening) { listening = true; bridge.listen(id, name, (...a) => fns.forEach((f) => { try { f(...a); } catch (e) { console.error(e); } })); }
      },
      removeListener(fn) { fns.delete(fn); },
      hasListener(fn) { return fns.has(fn); },
      hasListeners() { return fns.size > 0; },
    };
  };
  const define = (key, value) => Object.defineProperty(chrome, key, { value, enumerable: true, configurable: true });

  if (!chrome.alarms && perms.has('alarms')) {
    define('alarms', {
      create: (...args) => {
        const name = typeof args[0] === 'string' ? args.shift() : '';
        return api('alarms.create')(name, args[0] || {}, ...args.slice(1));
      },
      get: (...args) => api('alarms.get')(...(typeof args[0] === 'string' ? args : ['', ...args])),
      getAll: api('alarms.getAll'),
      clear: (...args) => api('alarms.clear')(...(typeof args[0] === 'string' ? args : ['', ...args])),
      clearAll: api('alarms.clearAll'),
      onAlarm: event('alarms.onAlarm'),
    });
  }

  if (!chrome.sidePanel && (perms.has('sidePanel') || manifest.side_panel)) {
    define('sidePanel', {
      setOptions: api('sidePanel.setOptions'),
      getOptions: api('sidePanel.getOptions'),
      setPanelBehavior: api('sidePanel.setPanelBehavior'),
      getPanelBehavior: api('sidePanel.getPanelBehavior'),
      open: api('sidePanel.open'),
    });
  }

  if (!chrome.identity && perms.has('identity')) {
    const unsupported = (what) => (...args) => {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const err = new Error(`${what} isn’t available in Lumio Browser.`);
      if (cb) { console.warn(err.message); cb(undefined); return undefined; }
      return Promise.reject(err);
    };
    define('identity', {
      getRedirectURL: (p = '') => `https://${id}.chromiumapp.org/${String(p).replace(/^\//, '')}`,
      launchWebAuthFlow: api('identity.launchWebAuthFlow'),
      getAuthToken: unsupported('Signing in with the browser’s Google account'),
      removeCachedAuthToken: (_d, cb) => (cb ? cb() : Promise.resolve()),
      getProfileUserInfo: (...args) => {
        const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        const info = { email: '', id: '' };
        if (cb) { cb(info); return undefined; }
        return Promise.resolve(info);
      },
    });
  }
}
