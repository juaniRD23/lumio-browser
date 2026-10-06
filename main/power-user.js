// Power-user features, wired in from one place: window names
// (main/window-name.js), keyboard shortcuts (shortcuts.js), caret browsing
// (caret-browsing.js), force dark (force-dark.js) and protocol handlers
// (protocol-handlers.js), with their part of Settings
// (renderer/pages/settings-power.js, shortcuts.html).
const { app, dialog, ipcMain } = require('electron');
const shortcuts = require('./shortcuts');
const windowName = require('./window-name');
const caret = require('./caret-browsing');
const forceDark = require('./force-dark');
const { ProtocolHandlers } = require('./protocol-handlers');

let deps = null;
let handlers = null;

// Every tab's page, in every window (normal and incognito).
const tabWebContents = () => deps.windows().flatMap((w) => w.tabs.tabs.map((t) => t.view?.webContents).filter((wc) => wc && !wc.isDestroyed()));
const isTab = (wc) => !!deps.tabOf(wc);
const changedMenu = () => deps.menuChanged();

// How a command's shortcut looks now ('F7'), or '' when it has none.
const keyFor = (id) => shortcuts.list(deps.menuTemplate(), deps.store.settings.shortcuts).find((c) => c.id === id)?.display || '';
// The keys the window's tooltips should name (renderer/ui/shortcut-hints.js).
const hintsNow = () => shortcuts.hints(deps.menuTemplate(), deps.store.settings.shortcuts);

function state() {
  return {
    caretBrowsing: caret.isOn(deps.store),
    caretKey: keyFor('caret-browsing'),
    forceDark: forceDark.state(deps.store),
    protocolHandlers: handlers.list(),
    verticalTabs: !!deps.store.settings.verticalTabs, // a tab's menu may have changed it since Settings opened
  };
}

// d: { store, on, handle, internalHandle (main.js's IPC helpers), windows(),
// tabOf(wc), menuChanged(), menuTemplate() (the application menu as it is
// now) }. Called once, before the first window opens.
function setup(d) {
  deps = d;
  const { store, on, handle, internalHandle } = d;
  handlers = new ProtocolHandlers({ store, tabOf: d.tabOf });

  // Each tab's pages: caret browsing and protocol handler links.
  app.on('web-contents-created', (_e, wc) => {
    caret.watch(wc, { store, isTab });
    handlers.watch(wc);
  });

  on('window:name', (w, answer) => windowName.answer(w, answer || {}));

  // A page's navigator.registerProtocolHandler and unregisterProtocolHandler
  // (preload/internal.js), and the permission bar's answer (the bar answers
  // Permissions on the same channel).
  ipcMain.on('ph:register', (e, { scheme, url } = {}) => {
    if (e.senderFrame && e.senderFrame === e.sender.mainFrame) handlers.register(e.sender, e.senderFrame.url, scheme, url);
  });
  ipcMain.on('ph:unregister', (e, { scheme, url } = {}) => {
    if (e.senderFrame && e.senderFrame === e.sender.mainFrame) handlers.unregister(e.sender, e.senderFrame.url, scheme, url);
  });
  on('permission:respond', (_w, { id, allow } = {}) => handlers.respond(id, !!allow));

  // Settings: lumio://settings/shortcuts, and the rows settings-power.js adds.
  // New keys go into the menu and the windows' tooltips right away.
  const shortcutsChanged = () => {
    changedMenu();
    const hints = hintsNow();
    for (const w of deps.windows()) w.emit('shortcut-hints', hints);
  };
  shortcuts.registerIpc({ internalHandle, store, template: d.menuTemplate, changed: shortcutsChanged });
  handle('shell:shortcut-hints', () => hintsNow());
  internalHandle('page:power-state', ['settings'], () => state());
  internalHandle('page:power-set', ['settings'], (_ctx, key, value) => {
    if (key === 'caretBrowsing') caret.set(!!value, { store, tabs: tabWebContents, changed: changedMenu });
    if (key === 'forceDarkPages') store.setSetting(forceDark.KEY, !!value);
    return state();
  });
  internalHandle('page:protocol-handler-remove', ['settings'], (_ctx, scheme, origin) => { handlers.remove(String(scheme), String(origin)); return state(); });
  // (Its Relaunch button: main/system.js page:relaunch, which asks confirmRelaunch first.)
}

// Before any Relaunch / Restart button: asks first only when Lumio AI is busy.
async function confirmRelaunch(w) {
  if (deps.windows().some((x) => x.ai?.isRunning())) {
    const { response } = await dialog.showMessageBox(w.win, {
      type: 'question',
      message: 'Relaunch Lumio Browser?',
      detail: 'Lumio AI is working on a task right now; relaunching will stop it. Your windows and tabs come back.',
      buttons: ['Relaunch', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return false;
  }
  return true;
}

// The commands main.js adds to its cmd object (menus and shortcuts).
const nameWindow = (w) => windowName.ask(w);
const toggleCaretBrowsing = (w) => w && caret.toggle(w, { store: deps.store, tabs: tabWebContents, changed: changedMenu, dialog, key: keyFor('caret-browsing') });

// What the application menu shows of these.
const menuState = (store) => ({ caretBrowsing: caret.isOn(store), shortcuts: store.settings.shortcuts || {}, darkForced: forceDark.active() });

module.exports = { setup, nameWindow, toggleCaretBrowsing, menuState, confirmRelaunch, restoreAfterRelaunch: () => forceDark.relaunched() };
