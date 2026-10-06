// Preload for the browser UI (shell, overlay, a pop-up's bar, the profile
// picker and Task Manager windows, and the print preview). Exposes a narrow,
// channel-whitelisted bridge; the main process also checks that calls come
// from us.
// Bundled into preload/dist/shell.js by scripts/build-preload.mjs.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');

const INVOKE = /^(shell|omnibox|ai|site|account|passwords|update|popup|side|profiles|taskmanager|perf|print|translate|reader|share|media|shot|apps|extensions|help):/;
const SEND = /^(layout|panel|sidebar|tab|overlay|find|download|permission|ai|bookmarks|site|window|extensions|account|passwords|autofill|app|aura|update|dialog|popup|notice|hud|omnibox|groups|side|security|capture|profiles|taskmanager|perf|print|translate|reader|share|media|shot|apps|help):|^open-url$/;
const EVENTS = new Set([
  'tabs', 'downloads', 'permission', 'permission-cancel', 'permission-blocked', 'permission-reset', 'permission-focus', 'find-result', 'find-open', 'find-close', 'find-step',
  'focus-omnibox', 'panel-toggle', 'panel-open', 'ai-focus', 'ai-prefill', 'ai-event', 'ai-state', 'overlay-data',
  'overlay-picked', 'overlay-state', 'toast', 'zoom', 'fullscreen', 'agent-state', 'bookmarks', 'site-info', 'extensions-changed',
  'account', 'profile', 'passwords-prompt', 'passwords-changed', 'aura', 'update', 'update-announce', 'ai-build-doc', 'ai-open-chat',
  'ai-workflow', 'workflows-changed', 'sync-state', 'sync-pair-request', 'sidebar-changed', 'sidebar-toggle', 'dialog-data', 'notice-data',
  'ui-prefs', 'focus-pane', 'page-focus',
  'hud', 'nav-prefs', 'find-text', // main/navigation.js
  'infobars', 'tab-search', 'tab-drag-hint', // main/infobars.js, tab-search.js, tab-drag.js
  'saved-groups', 'tab-group-edit', 'side-panel', 'side-changed', // tab groups, side panel
  'profiles-changed', 'perf-alert', 'perf-state', // profiles, performance
  'translate-prompt', 'reader-open', // page tools
  'share-open', 'media', 'ai-attach', 'shot-data', 'app-state',
  'ext-activate', 'ext-menu-closed', // extensions
  'tab-layout', 'shortcut-hints', // tabs to the side and split view, keyboard shortcuts
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
  // Where a file dropped on the tab strip is on disk (renderer/ui/tabstrip.js).
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
});

// The toolbar's <browser-action-list> (extension buttons and popups).
if (location.href.startsWith('lumio://shell/')) injectBrowserAction();
