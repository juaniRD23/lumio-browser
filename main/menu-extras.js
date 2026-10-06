// Parts of the application menu (main/menu.js) laid out like Chrome's on the
// Mac: recently visited pages in History, the bookmarks bar's items in
// Bookmarks, Profiles, Tab, View › Developer, the Edit menu's Spelling,
// Substitutions and Speech, and Help. Plain templates, no Electron imports
// (tested in tests/menus.test.mjs).
const { LABELS: DOCK_LABELS, MODES: DOCK_MODES } = require('./devtools');

const MAC = process.platform === 'darwin';
const RECENT = 12;
const BOOKMARKS = 40;
const cut = (s, n = 60) => (s.length > n ? s.slice(0, n) + '…' : s);
const k = (mac, win) => (MAC ? mac : win);

// History › Recently Visited: the latest web pages, each once.
function recentHistory(store) {
  const seen = new Set();
  const out = [];
  const history = store.history();
  for (let i = history.length - 1; i >= 0 && out.length < RECENT; i--) {
    const h = history[i];
    if (!/^https?:/.test(h.url || '') || seen.has(h.url)) continue;
    seen.add(h.url);
    out.push({ url: h.url, title: h.title || h.url });
  }
  return out;
}

// What the menus show from Lumio's data (main.js menuState spreads it in).
function state({ store, account, devtoolsDock }) {
  const a = account?.state() || {}; // not there yet in the first moments after launch
  return {
    recentHistory: recentHistory(store),
    bookmarkItems: store.bookmarks().slice(0, BOOKMARKS).map((b) => ({ url: b.url, title: b.title || b.url })),
    profileName: store.settings.profile?.name || a.name || 'Lumio Browser',
    signedIn: !!a.signedIn,
    devtoolsDock,
    spellcheck: store.settings.spellcheck !== false,
  };
}

const historyItems = (s, cmd) => (s.recentHistory?.length ? [
  { type: 'separator' },
  { label: 'Recently Visited', enabled: false },
  ...s.recentHistory.map((h) => ({ label: cut(h.title), toolTip: h.url, click: (_item, _win, e) => cmd.openUrl(h.url, e) })),
] : []);

const bookmarkItems = (s, cmd) => (s.bookmarkItems?.length ? [
  { type: 'separator' },
  ...s.bookmarkItems.map((b) => ({ label: cut(b.title), toolTip: b.url, click: (_item, _win, e) => cmd.openUrl(b.url, e) })),
] : []);

// Chrome's Mac Edit menu extras. Spelling follows Lumio's setting for tabs
// (Electron's spell checker role would only change the window's own UI).
const editExtras = (s, cmd) => (MAC ? [
  { type: 'separator' },
  { label: 'Spelling and Grammar', submenu: [{ label: 'Check Spelling While Typing', type: 'checkbox', checked: s.spellcheck !== false, click: cmd.toggleSpellcheck }] },
  { label: 'Substitutions', submenu: [{ role: 'showSubstitutions' }, { type: 'separator' }, { role: 'toggleSmartQuotes' }, { role: 'toggleSmartDashes' }, { role: 'toggleTextReplacement' }] },
  { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
] : []);

// View › Developer. hidden(accel, click) makes a shortcut-only item.
function developerMenu(s, cmd, hidden) {
  return {
    label: 'Developer',
    submenu: [
      { label: 'View Source', accelerator: k('Cmd+Alt+U', 'Ctrl+U'), click: cmd.viewSource },
      { label: 'Developer Tools', accelerator: k('Cmd+Alt+I', 'Ctrl+Shift+I'), click: cmd.devtools },
      ...(MAC ? [] : [hidden('F12', cmd.devtools)]),
      { label: 'Inspect Elements', accelerator: k('Cmd+Alt+C', 'Ctrl+Shift+C'), click: () => cmd.devtoolsPanel('inspect') },
      { label: 'JavaScript Console', accelerator: k('Cmd+Alt+J', 'Ctrl+Shift+J'), click: () => cmd.devtoolsPanel('console') },
      { type: 'separator' },
      ...DOCK_MODES.map((m) => ({ label: DOCK_LABELS[m], type: 'radio', checked: s.devtoolsDock === m, click: () => cmd.setDevtoolsDock(m) })),
      ...(cmd.isDev ? [{ type: 'separator' }, { label: 'Browser UI Developer Tools', accelerator: 'CmdOrCtrl+Alt+Shift+I', click: cmd.shellDevtools }] : []),
    ],
  };
}

// The Mac menu bar's Profiles menu: the one local profile for now.
const profilesMenu = (s, cmd) => ({
  label: 'Profiles',
  submenu: [
    { label: cut(s.profileName || 'Lumio Browser', 40), type: 'radio', checked: true },
    { type: 'separator' },
    { label: 'Customize Profile…', click: cmd.customizeProfile },
    { label: s.signedIn ? 'Manage Your Lumio Account…' : 'Sign In to Lumio…', click: cmd.lumioAccount },
  ],
});

// The Mac menu bar's Tab menu. Its shortcuts work on every platform from
// the Window menu (menu.js); here they're listed on the Mac.
const tabMenu = (cmd) => ({
  label: 'Tab',
  submenu: [
    { label: 'New Tab to the Right', click: cmd.newTabRight },
    { type: 'separator' },
    { label: 'Select Next Tab', accelerator: 'Cmd+Alt+Right', click: () => cmd.cycle(1) },
    { label: 'Select Previous Tab', accelerator: 'Cmd+Alt+Left', click: () => cmd.cycle(-1) },
    { type: 'separator' },
    { label: 'Duplicate Tab', click: cmd.duplicateTab },
    { label: 'Pin Tab', click: cmd.pinTab },
    { label: 'Mute Site', click: cmd.muteTab },
    { type: 'separator' },
    { label: 'Move Tab to New Window', click: cmd.moveTabToNewWindow },
    { label: 'Close Other Tabs', click: cmd.closeOtherTabs },
  ],
});

const HELP_ITEMS = (cmd) => [
  { label: k('Lumio Browser Help', 'Help center'), ...(MAC ? {} : { accelerator: 'F1' }), click: cmd.helpCenter },
  { label: k('Report an Issue…', 'Report an issue…'), accelerator: 'Alt+Shift+I', click: cmd.reportIssue },
  { label: k('What’s New', 'What’s new'), click: cmd.whatsNew },
];

// Help in the menu bar (the Mac adds its search box to it).
const helpMenu = (cmd) => ({
  role: 'help',
  label: 'Help',
  submenu: [
    ...HELP_ITEMS(cmd),
    { type: 'separator' },
    { label: 'Version Info', click: cmd.versionPage },
    { label: 'Experiments', click: cmd.flagsPage },
    { type: 'separator' },
    { label: 'Terms of Service', click: cmd.terms },
    { label: 'Privacy Policy', click: cmd.privacy },
    { label: 'Open-Source Licenses', click: cmd.credits },
  ],
});

// ⋮ › Help.
const helpSubmenu = (cmd) => ({
  label: 'Help',
  submenu: [{ label: 'About Lumio Browser', click: cmd.about }, { type: 'separator' }, ...HELP_ITEMS(cmd)],
});

module.exports = { state, recentHistory, historyItems, bookmarkItems, editExtras, developerMenu, profilesMenu, tabMenu, helpMenu, helpSubmenu, RECENT, BOOKMARKS };
