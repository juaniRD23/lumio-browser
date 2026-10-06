// The tab strip's work in the main process, the way Chrome does it:
//  - the tab menu (right-click a tab) and the strip's own menu (right-click
//    the empty part of the strip)
//  - several tabs at once: Shift-click and ⌘/Ctrl-click select tabs in
//    renderer/ui/tabstrip.js; the menu and ⌘W then act on all of them
//  - Duplicate keeps the tab's back/forward history
//  - moving tabs to another window (or a new one) without reloading them
//  - Mute site: every tab of that site (main/site-mute.js)
//  - links, text and files dropped on the strip
// Dragging tabs out of a window is main/tab-drag.js; tab search is main/tab-search.js.
const { Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { parseInput } = require('./omnibox');
const { historyOf } = require('./sessions');
const { originOf } = require('./site-mute');
const { reloadCrashed } = require('./sad-tab');

const NEWTAB = 'lumio://newtab/';
const MAX_DROP = 20; // files opened from one drop

// What a dropped link or text may open: web pages and files. Never data:,
// javascript: (it becomes a search), other apps' schemes, or Lumio's own
// pages (a web page could hand one over to be dragged; type those instead).
const droppable = (url) => /^(https?|file):/i.test(url) || /^view-source:https?:/i.test(url);

// A window in "Move tab to another window ›": its tab's title and how many more.
function windowLabel(w) {
  const title = String(w.tabs.active?.title || 'Window').replace(/\s+/g, ' ').trim();
  const short = title.length > 40 ? title.slice(0, 40) + '…' : title;
  const more = w.tabs.tabs.length - 1;
  const label = more > 0 ? `${short} and ${more} more tab${more === 1 ? '' : 's'}` : short;
  return process.platform === 'darwin' ? label : label.replace(/&/g, '&&');
}

// The tab menu. c says what it acts on; act(command, arg) runs a command.
// extra: other parts' items, { groups } (tab groups), { reading } (reading
// list), { split } (split view) and { layout } (tabs to the side).
function tabMenuTemplate(c, act, extra = {}) {
  const s = c.many ? 's' : '';
  const shortcut = (accelerator) => ({ accelerator, registerAccelerator: false });
  const move = c.windows.length
    ? {
      label: `Move Tab${s} to Another Window`,
      submenu: [
        { label: 'New Window', enabled: c.canNewWindow, click: () => act('moveToNew') },
        { type: 'separator' },
        ...c.windows.map((x) => ({ label: x.label, click: () => act('moveTo', x.id) })),
      ],
    }
    : { label: `Move Tab${s} to New Window`, enabled: c.canNewWindow, click: () => act('moveToNew') };
  return [
    { label: 'New Tab to the Right', click: () => act('newRight') },
    ...(extra.groups || []),
    move,
    { type: 'separator' },
    { label: 'Reload', click: () => act('reload') },
    { label: 'Duplicate', click: () => act('duplicate') },
    { label: c.pinned ? `Unpin Tab${s}` : `Pin Tab${s}`, click: () => act('pin') },
    { label: c.siteMuted ? `Unmute Site${s}` : `Mute Site${s}`, click: () => act('mute') },
    ...(extra.reading || []),
    ...(extra.split || []),
    { type: 'separator' },
    { label: `Close Tab${s}`, ...shortcut('CmdOrCtrl+W'), click: () => act('close') },
    { label: 'Close Other Tabs', enabled: c.othersClosable, click: () => act('closeOthers') },
    { label: 'Close Tabs to the Right', enabled: c.rightClosable, click: () => act('closeRight') },
    { type: 'separator' },
    { label: 'Reopen Closed Tab', ...shortcut('CmdOrCtrl+Shift+T'), enabled: c.closedCount > 0, click: () => act('reopen') },
    { label: 'Bookmark All Tabs', ...shortcut('CmdOrCtrl+Shift+D'), click: () => act('bookmarkAll') },
    ...(extra.layout?.length ? [{ type: 'separator' }, ...extra.layout] : []),
  ];
}

// Right-click on the strip itself. extra: other parts' items (Name Window…,
// tabs to the side).
function stripMenuTemplate(c, act, extra = []) {
  return [
    { label: 'New Tab', accelerator: 'CmdOrCtrl+T', registerAccelerator: false, click: () => act('newTab') },
    { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', registerAccelerator: false, enabled: c.closedCount > 0, click: () => act('reopen') },
    { label: 'Bookmark All Tabs', accelerator: 'CmdOrCtrl+Shift+D', registerAccelerator: false, click: () => act('bookmarkAll') },
    ...(extra.length ? [{ type: 'separator' }, ...extra] : []),
  ];
}

class TabStrip {
  // deps: { alive(), createWindow(opts), recentlyClosed: [], ownsClosed(w, entry), reopenClosed(w),
  //         bookmarkAllTabs(w), removeExtensionTab(wc), siteMute,
  //         menuExtras(w, ids, tab): { groups, reading, split, layout } items for the tab menu,
  //         stripExtras(w): items for the strip's own menu }
  constructor(deps) {
    this.deps = deps;
    this.wired = new WeakSet();
  }

  // ---------------------------------------------------------------- selection
  // The shell's selected tabs (always including the one you're on).
  setSelection(w, ids) {
    const list = Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id) && w.tabs.get(id)) : [];
    w.tabSelection = list;
  }

  // What a command on this tab acts on: every selected tab if it's one of
  // them, else just it. In strip order.
  targets(w, id) {
    const sel = (w.tabSelection || []).filter((x) => w.tabs.get(x));
    const ids = sel.length > 1 && sel.includes(id) ? sel : [id];
    return w.tabs.tabs.filter((t) => ids.includes(t.id)).map((t) => t.id);
  }

  // ⌘W: the selected tabs, or the one you're on.
  closeSelected(w) {
    if (!w?.tabs.activeId) return;
    for (const id of this.targets(w, w.tabs.activeId)) w.tabs.close(id);
  }

  // ---------------------------------------------------------------- menus
  closedCount(w) {
    if (w.incognito || w.profile?.guest) return w.closedTabs.length;
    return this.deps.recentlyClosed.filter((e) => this.deps.ownsClosed?.(w, e) ?? true).length;
  }

  menuContext(w, ids) {
    const m = w.tabs;
    const tabs = ids.map((id) => m.get(id)).filter(Boolean);
    const last = Math.max(...tabs.map((t) => m.tabs.indexOf(t)));
    return {
      many: tabs.length > 1,
      pinned: tabs.every((t) => t.pinned),
      siteMuted: this.allMuted(w, tabs),
      canNewWindow: m.tabs.length > tabs.length,
      windows: this.deps.alive().filter((x) => x !== w && x.incognito === w.incognito && x.profile === w.profile).map((x) => ({ id: x.id, label: windowLabel(x) })),
      othersClosable: m.tabs.some((t) => !ids.includes(t.id) && !t.pinned),
      rightClosable: m.tabs.slice(last + 1).some((t) => !ids.includes(t.id) && !t.pinned),
      closedCount: this.closedCount(w),
    };
  }

  tabMenu(w, msg = {}) {
    const id = Number(msg.id);
    if (!w.tabs.get(id)) return null;
    const ids = this.targets(w, id);
    const extra = this.deps.menuExtras?.(w, ids, w.tabs.get(id)) || {};
    const menu = Menu.buildFromTemplate(tabMenuTemplate(this.menuContext(w, ids), (cmd, arg) => this.run(w, cmd, ids, id, arg), extra));
    menu.popup({ window: w.win });
    return menu;
  }

  stripMenu(w) {
    const menu = Menu.buildFromTemplate(stripMenuTemplate({ closedCount: this.closedCount(w) }, (cmd) => this.run(w, cmd, [], null), this.deps.stripExtras?.(w) || []));
    menu.popup({ window: w.win });
    return menu;
  }

  // A menu command. ids: the tabs it acts on (in strip order); id: the one right-clicked.
  run(w, cmd, ids, id, arg) {
    const m = w.tabs;
    const live = () => ids.filter((x) => m.get(x));
    const unpinned = (t) => !t.pinned && !ids.includes(t.id);
    switch (cmd) {
      case 'newTab': return m.create(NEWTAB);
      case 'newRight': return m.create(NEWTAB, { index: m.tabs.indexOf(m.get(id)) + 1, groupId: m.get(id)?.groupId || null });
      case 'moveToNew': return this.moveToNewWindow(w, live());
      case 'moveTo': {
        const to = this.deps.alive().find((x) => x.id === arg && x.incognito === w.incognito && x.profile === w.profile);
        return to ? this.moveTabs(w, live(), to) : null;
      }
      case 'reload': for (const t of live().map((x) => m.get(x))) if (!(t.crashed && reloadCrashed(w, t))) t.view?.webContents.reload(); return null;
      case 'duplicate': return this.duplicate(w, live());
      case 'pin': {
        const pin = !live().every((x) => m.get(x).pinned);
        for (const x of pin ? live() : live().reverse()) m.setPinned(x, pin);
        return null;
      }
      case 'mute': return this.muteSites(w, live());
      case 'close': for (const x of live()) m.close(x); return null;
      case 'closeOthers': for (const t of m.tabs.filter(unpinned)) m.close(t.id); return null;
      case 'closeRight': {
        const last = Math.max(...live().map((x) => m.tabs.indexOf(m.get(x))));
        for (const t of m.tabs.slice(last + 1).filter(unpinned)) m.close(t.id);
        return null;
      }
      case 'reopen': return this.deps.reopenClosed(w);
      case 'bookmarkAll': return this.deps.bookmarkAllTabs(w);
      default: return null;
    }
  }

  // ---------------------------------------------------------------- duplicate
  // Each tab's copy goes right after it, with the same back/forward history,
  // and the (last) copy is the tab you're on.
  duplicate(w, ids) {
    const m = w.tabs;
    let copy = null;
    for (const id of ids) {
      const tab = m.get(id);
      if (!tab) continue;
      copy = m.create(m.displayUrl(tab) || NEWTAB, { index: m.tabs.indexOf(tab) + 1, title: tab.title, history: historyOf(tab), pinned: tab.pinned, active: false });
    }
    if (copy) m.activate(copy.id);
    return copy;
  }

  // ---------------------------------------------------------------- moving tabs between windows
  // Takes tabs out of a window without closing their pages (and out of the
  // extensions' view of that window).
  detachTabs(w, ids) {
    const out = [];
    for (const id of ids) {
      const tab = w.tabs.detach(id);
      if (!tab) continue;
      this.deps.detached?.(w, tab); // its print preview belongs to the old window
      if (tab.view && !w.incognito) this.deps.removeExtensionTab(tab.view.webContents, w);
      out.push(tab);
    }
    return out;
  }

  // Into another window, at index (the end by default). The last one moved
  // is the tab you're on there. A window left with no tabs closes.
  moveTabs(from, ids, to, { index = null, focus = true } = {}) {
    // A tab keeps its page and session: only to another window of the same profile (and incognito or not).
    if (to === from || to.incognito !== from.incognito || to.profile !== from.profile) return null;
    const tabs = this.detachTabs(from, ids);
    if (!tabs.length) return null;
    let at = index == null ? to.tabs.tabs.length : index;
    for (const tab of tabs) to.tabs.adopt(tab, { index: at++, active: false });
    to.tabs.activate(tabs[tabs.length - 1].id);
    if (!from.tabs.tabs.length) from.close();
    if (focus) to.focus();
    return to;
  }

  // A window of their own (not the window's every tab: there'd be nothing to move).
  moveToNewWindow(from, ids, opts = {}) {
    if (!ids.length || ids.length >= from.tabs.tabs.length) return null;
    const active = ids.includes(from.tabs.activeId) ? from.tabs.activeId : ids[0];
    const tabs = this.detachTabs(from, ids);
    if (!tabs.length) return null;
    const w = this.deps.createWindow({ ...opts, profile: from.profile?.base, incognito: from.incognito, adopt: tabs[0] });
    for (const tab of tabs.slice(1)) w.tabs.adopt(tab, { active: false });
    w.tabs.activate((tabs.find((t) => t.id === active) || tabs[0]).id);
    return w;
  }

  // ---------------------------------------------------------------- mute site
  allMuted(w, tabs) {
    return tabs.every((t) => {
      const origin = originOf(w.tabs.displayUrl(t));
      return origin ? this.deps.siteMute.isMuted(origin, w.incognito) : t.muted;
    });
  }

  // Mutes the sites of these tabs (or unmutes them, if they all are), in
  // every window. Pages that aren't websites mute just their tab.
  muteSites(w, ids) {
    const m = w.tabs;
    const tabs = ids.map((id) => m.get(id)).filter(Boolean);
    const mute = !this.allMuted(w, tabs);
    for (const t of tabs) {
      const origin = originOf(m.displayUrl(t));
      if (origin) this.deps.siteMute.set(origin, mute, w.incognito);
      else if (t.muted !== mute) m.toggleMute(t.id);
      else continue;
      // Unmuting the site unmutes the tab you asked about, however it was muted.
      if (origin && !mute && t.muted && t.view) { t.view.webContents.setAudioMuted(false); Object.assign(t, { muted: false, muteReason: null }); m.changed(); }
    }
    this.applyMutes();
  }

  applyMutes() {
    for (const x of this.deps.alive()) for (const t of x.tabs.tabs) if (t.view) this.deps.siteMute.apply(t, t.view.webContents.getURL());
  }

  // Each tab's page, once: a muted site stays muted as it navigates.
  onViewCreated(_w, tab) {
    const wc = tab.view?.webContents;
    if (!wc || this.wired.has(wc)) return;
    this.wired.add(wc);
    wc.on('did-navigate', (_e, url) => this.deps.siteMute.apply(tab, url));
  }

  // ---------------------------------------------------------------- drops
  // A link, text or files dropped on the strip (renderer/ui/tabstrip.js): on a
  // tab, that tab opens it; between tabs, a new tab there.
  drop(w, msg = {}) {
    const m = w.tabs;
    const urls = [];
    if (Array.isArray(msg.files) && msg.files.length) {
      for (const f of msg.files.slice(0, MAX_DROP)) {
        if (typeof f !== 'string' || f.length > 4096 || !path.isAbsolute(f)) continue;
        try { if (fs.statSync(f).isFile()) urls.push(pathToFileURL(f).href); } catch { /* gone */ }
      }
    } else {
      const raw = typeof msg.url === 'string' && msg.url ? msg.url : typeof msg.text === 'string' ? msg.text : '';
      const parsed = raw.length <= 8192 ? parseInput(raw, m.searchTemplate()) : null;
      if (parsed) urls.push(parsed.url);
    }
    const ok = urls.filter(droppable);
    if (!ok.length) return [];
    const on = msg.on == null ? null : m.get(Number(msg.on));
    let index = Number.isInteger(msg.index) ? msg.index : m.tabs.length;
    ok.forEach((url, i) => {
      if (i === 0 && on) { m.activate(on.id); m.navigate(url, on.id); return; }
      m.create(url, { index: index++, active: i === 0 });
    });
    return ok;
  }

  // ---------------------------------------------------------------- IPC
  register({ on, internalHandle }) {
    // Settings › Privacy › Muted sites
    internalHandle('page:muted-sites', ['settings'], () => this.deps.siteMute.list());
    internalHandle('page:unmute-site', ['settings'], (_ctx, origin) => {
      this.deps.siteMute.set(String(origin || ''), false);
      this.applyMutes();
      return this.deps.siteMute.list();
    });
    on('tab:context', (w, msg) => this.tabMenu(w, typeof msg === 'object' && msg ? msg : { id: msg }));
    on('tab:strip-context', (w) => this.stripMenu(w));
    on('tab:selection', (w, ids) => this.setSelection(w, ids));
    // Several selected tabs dragged together: `before` is how many of the
    // other tabs end up in front of them.
    on('tab:move-many', (w, msg) => {
      const m = w.tabs;
      const ids = Array.isArray(msg?.ids) ? msg.ids : [];
      const block = m.tabs.filter((t) => ids.includes(t.id));
      const others = m.tabs.filter((t) => !ids.includes(t.id));
      const before = Number(msg?.before);
      if (!block.length || !Number.isInteger(before) || before < 0) return;
      const order = [...others.slice(0, before), ...block, ...others.slice(before)];
      order.forEach((t, i) => { if (m.tabs[i] !== t) m.move(t.id, i); });
    });
    on('tab:drop', (w, msg) => this.drop(w, msg || {}));
  }
}

module.exports = { TabStrip, tabMenuTemplate, stripMenuTemplate, windowLabel, droppable };
