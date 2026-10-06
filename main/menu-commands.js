// Commands behind the menus in main/menu-extras.js (Tab, Developer,
// History and Bookmarks items, Spelling, Profiles), added to main.js's cmd.
const devtools = require('./devtools');
const { NEWTAB } = require('./tabs');

// deps: cur() (the focused window), store, sessions() (the tab sessions open
// now), openUrl(url, disposition, from), openInternal(url), signedIn(),
// signIn(w), openAccountPage(which, w), menuChanged()
function menuCommands({ cur, store, sessions, openUrl, openInternal, signedIn, signIn, openAccountPage, menuChanged }) {
  const active = () => { const w = cur(); return w?.tabs.active ? { w, tab: w.tabs.active, next: w.tabs.tabs.indexOf(w.tabs.active) + 1 } : null; };
  return {
    // A History or Bookmarks menu item: this tab, or a new one with ⌘/Ctrl.
    openUrl: (url, e) => openUrl(url, e?.metaKey || e?.ctrlKey ? 'tab' : 'current', cur()),
    stop: () => cur()?.tabs.stop(),
    viewSource: () => {
      const a = active();
      const url = a?.w.tabs.wc()?.getURL() || '';
      if (/^(https?|file):/.test(url)) a.w.tabs.create(`view-source:${url}`, { index: a.next });
    },
    devtoolsPanel: (panel) => devtools.open(cur()?.tabs.wc(), store, panel),
    setDevtoolsDock: (mode) => { devtools.setMode(store, cur()?.tabs.wc(), mode); menuChanged(); },
    toggleSpellcheck: () => {
      const on = store.settings.spellcheck === false;
      store.setSetting('spellcheck', on);
      for (const ses of sessions()) ses.setSpellCheckerEnabled(on);
      menuChanged();
    },
    newTabRight: () => { const a = active(); if (a) a.w.tabs.create(NEWTAB, { index: a.next }); },
    duplicateTab: () => { const a = active(); if (a) a.w.tabs.create(a.w.tabs.displayUrl(a.tab) || NEWTAB, { index: a.next }); },
    muteTab: () => { const a = active(); if (a) a.w.tabs.toggleMute(a.tab.id); },
    closeOtherTabs: () => { const a = active(); if (a) a.w.tabs.tabs.filter((t) => t.id !== a.tab.id && !t.pinned).forEach((t) => a.w.tabs.close(t.id)); },
    customizeProfile: () => openInternal('lumio://settings/#profile'),
    lumioAccount: () => { const w = cur(); if (signedIn()) openAccountPage('manage', w); else signIn(w); },
  };
}

module.exports = { menuCommands };
