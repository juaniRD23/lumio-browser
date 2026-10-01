// Preload for the browser UI (shell + overlay). Exposes a narrow, channel-
// whitelisted bridge; the main process also checks that calls come from us.
// Bundled into preload/dist/shell.js by scripts/build-preload.mjs.
const { contextBridge, ipcRenderer } = require('electron');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');

const INVOKE = /^(shell|omnibox|ai|site|account|passwords|update):/;
const SEND = /^(layout|panel|tab|overlay|find|download|permission|ai|bookmarks|site|window|extensions|account|passwords|app|aura|update):|^open-url$/;
const EVENTS = new Set([
  'tabs', 'downloads', 'permission', 'permission-cancel', 'find-result', 'find-open', 'find-close', 'find-step',
  'focus-omnibox', 'panel-toggle', 'panel-open', 'ai-focus', 'ai-prefill', 'ai-event', 'ai-state', 'overlay-data',
  'overlay-picked', 'toast', 'zoom', 'fullscreen', 'agent-state', 'bookmarks', 'site-info', 'extensions-changed',
  'account', 'profile', 'passwords-prompt', 'passwords-changed', 'aura', 'update', 'update-announce', 'ai-build-doc', 'ai-open-chat',
]);

contextBridge.exposeInMainWorld('lumio', {
  invoke: (channel, ...args) => (INVOKE.test(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('blocked'))),
  send: (channel, ...args) => { if (SEND.test(channel)) ipcRenderer.send(channel, ...args); },
  on: (channel, fn) => {
    if (!EVENTS.has(channel)) return () => {};
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});

// The toolbar's <browser-action-list> (extension buttons and popups).
if (location.href.startsWith('lumio://shell/')) injectBrowserAction();
