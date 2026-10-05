// Tab groups' main-process side, wired up by main.js: the tab menu's group
// items, the group editor (drawn in the overlay by
// renderer/ui/overlay-groups.js), moving and collapsing groups, moving one to
// a new window, and saved groups (main/saved-groups.js) at the left end of
// the bookmarks bar. Each window's groups are its TabManager's
// `tabs.groups` (main/tab-groups.js).
const { Menu } = require('electron');
const { JsonFile } = require('./store');
const { SavedGroups } = require('./saved-groups');
const { COLORS } = require('./tab-groups');

const NEWTAB = 'lumio://newtab/';
const COLOR_NAMES = { grey: 'Grey', blue: 'Blue', red: 'Red', yellow: 'Yellow', green: 'Green', pink: 'Pink', purple: 'Purple', cyan: 'Cyan', orange: 'Orange' };
const groupName = (g, count) => g.title || `${count} tab${count === 1 ? '' : 's'}`;

class GroupsService {
  // windows(): the open BrowserWins. createWindow(opts): a new window.
  // detached(w, tab): a tab is leaving w (extensions forget it).
  constructor({ dir, windows, createWindow, detached = () => {} }) {
    this.windows = windows;
    this.createWindow = createWindow;
    this.detached = detached;
    this.saved = new SavedGroups(new JsonFile(dir, 'saved-groups.json', { groups: [] }));
    this.saved.onChange(() => this.broadcast());
  }

  // ---- what the windows show
  payload() { return this.saved.list().map(({ id, title, color, tabs }) => ({ id, title, color, count: tabs.length, open: !!this.findOpen(id) })); }
  broadcast() {
    clearTimeout(this.broadcastTimer);
    this.broadcastTimer = setTimeout(() => {
      const list = this.payload();
      for (const w of this.windows()) if (!w.incognito) w.emit('saved-groups', list);
    }, 30);
  }

  // The open group that is this saved group's copy: { w, group }.
  findOpen(savedId) {
    for (const w of this.windows()) {
      if (w.incognito) continue;
      for (const g of w.tabs.groups.list.values()) if (g.savedId === savedId) return { w, group: g };
    }
    return null;
  }

  // Open groups that are saved: their copies follow them. Runs after every
  // change to a window's tabs (main.js onSessionChanged).
  follow() {
    const claimed = new Set();
    for (const w of this.windows()) {
      if (w.incognito) continue;
      for (const g of w.tabs.groups.list.values()) {
        if (!g.savedId) continue;
        // Deleted elsewhere, or a second open copy (a closed window reopened
        // while its saved group was open again): only the first one follows,
        // so the two don't overwrite each other's pages.
        if (!this.saved.get(g.savedId) || claimed.has(g.savedId)) { g.savedId = null; w.tabs.changed(); continue; }
        claimed.add(g.savedId);
        this.saved.update(g.savedId, { title: g.title, color: g.color, tabs: this.pages(w, g.id) });
      }
    }
    // Whether each saved group is open (the dot on the bar) can change too.
    const open = JSON.stringify(this.payload().map((g) => g.open));
    if (open !== this.lastOpen) { this.lastOpen = open; this.broadcast(); }
  }
  pages(w, groupId) { return w.tabs.groups.tabsOf(groupId).map((t) => ({ url: t.pendingUrl || t.url, title: t.title })); }

  // ---- the tab's right-click menu (main/tab-strip.js tabMenu). ids: the
  // tabs it acts on (every selected tab, when the right-clicked one is selected).
  menuItems(w, tab, ids = [tab.id]) {
    const groups = w.tabs.groups;
    const tabs = ids.map((id) => w.tabs.get(id)).filter((t) => t && !t.pinned);
    if (!tabs.length) return [];
    const list = tabs.map((t) => t.id);
    const s = list.length > 1 ? 's' : '';
    const shared = tabs.every((t) => t.groupId && t.groupId === tabs[0].groupId) ? tabs[0].groupId : null;
    const others = groups.state().filter((g) => g.id !== shared);
    const items = [];
    if (others.length) {
      items.push({
        label: `Add Tab${s} to Group`,
        submenu: [
          { label: 'New Group', click: () => this.newGroup(w, list) },
          { type: 'separator' },
          ...others.map((g) => ({ label: `${groupName(g, g.count)} (${COLOR_NAMES[g.color]})`, click: () => groups.add(list, g.id) })),
        ],
      });
    } else {
      items.push({ label: `Add Tab${s} to New Group`, click: () => this.newGroup(w, list) });
    }
    if (tabs.some((t) => t.groupId)) items.push({ label: 'Remove from Group', click: () => groups.remove(list.filter((id) => w.tabs.get(id)?.groupId)) });
    return items;
  }

  // A new group, then its editor to name it, like Chrome.
  newGroup(w, tabIds) {
    const g = w.tabs.groups.create(tabIds);
    if (g) setTimeout(() => w.emit('tab-group-edit', { id: g.id }), 60); // once the chip is drawn
    return g;
  }

  // ---- the group editor's buttons
  action(w, id, act) {
    const groups = w.tabs.groups;
    const g = groups.get(id);
    if (!g) return;
    const members = groups.tabsOf(id);
    if (act === 'new-tab') {
      w.tabs.create(NEWTAB, { index: w.tabs.tabs.indexOf(members[members.length - 1]) + 1, groupId: id });
      if (g.collapsed) groups.update(id, { collapsed: false });
    } else if (act === 'ungroup') groups.ungroup(id);
    else if (act === 'close') {
      // The last tabs in the window: a new tab stays, so the window doesn't close.
      if (members.length === w.tabs.tabs.length) w.tabs.create(NEWTAB);
      for (const t of members) w.tabs.close(t.id);
    } else if (act === 'move-window') this.moveToNewWindow(w, id);
    else if (act === 'save' && !w.incognito) {
      if (g.savedId && this.saved.get(g.savedId)) return;
      g.savedId = this.saved.save({ title: g.title, color: g.color, tabs: this.pages(w, id) });
      if (g.savedId) w.emit('toast', { text: 'Group saved' });
      w.tabs.changed();
    } else if (act === 'unsave' && g.savedId) {
      this.saved.remove(g.savedId);
      g.savedId = null;
      w.emit('toast', { text: 'Group no longer saved' });
      w.tabs.changed();
    }
  }

  // The group's tabs, pages and all, in a new window; the group comes along.
  moveToNewWindow(w, id) {
    const groups = w.tabs.groups;
    const g = groups.get(id);
    const members = groups.tabsOf(id);
    if (!g || !members.length || members.length === w.tabs.tabs.length) return null;
    const props = { ...g };
    groups.ungroup(id);
    const moved = members.map((t) => { const tab = w.tabs.detach(t.id); if (tab) this.detached(w, tab); return tab; }).filter(Boolean);
    const nw = this.createWindow({ incognito: w.incognito, adopt: moved[0] });
    moved.slice(1).forEach((t) => nw.tabs.adopt(t, { active: false }));
    nw.tabs.groups.create(moved.map((t) => t.id), { id: props.id, title: props.title, color: props.color, savedId: props.savedId });
    return nw;
  }

  // ---- saved groups on the bookmarks bar
  // Open already: go to it. Otherwise its pages open in a new group at the
  // end of this window (the first one loads, the rest when you go to them).
  openSaved(w, id) {
    const s = this.saved.get(id);
    if (!s) return;
    const open = this.findOpen(id);
    if (open) {
      const first = open.w.tabs.groups.tabsOf(open.group.id)[0];
      if (first) open.w.tabs.activate(first.id);
      open.w.focus();
      return;
    }
    if (!w || w.incognito) w = this.windows().find((x) => !x.incognito) || this.createWindow({});
    const made = s.tabs.map((p, i) => w.tabs.create(p.url, { active: i === 0, lazy: i !== 0, title: p.title }));
    w.tabs.groups.create(made.map((t) => t.id), { title: s.title, color: s.color, savedId: s.id });
  }

  savedMenu(w, id) {
    const s = this.saved.get(id);
    if (!s) return;
    const open = this.findOpen(id);
    Menu.buildFromTemplate([
      { label: open ? 'Go to Group' : 'Open Group', click: () => this.openSaved(w, id) },
      { type: 'separator' },
      { label: 'Delete Group', click: () => {
        if (open) { open.group.savedId = null; open.w.tabs.changed(); } // its chip stops showing it's saved
        this.saved.remove(id);
        w.emit('toast', { text: 'Saved group deleted' });
      } },
    ]).popup({ window: w.win });
  }

  register({ on }) {
    const str = (v) => (typeof v === 'string' ? v : '');
    on('groups:update', (w, { id, title, color, collapsed } = {}) => {
      w.tabs.groups.update(str(id), { title: typeof title === 'string' ? title : undefined, color: COLORS.includes(color) ? color : undefined, collapsed: typeof collapsed === 'boolean' ? collapsed : undefined });
    });
    on('groups:action', (w, { id, action } = {}) => this.action(w, str(id), str(action)));
    on('groups:move', (w, { id, before } = {}) => w.tabs.groups.move(str(id), Number.isInteger(before) ? before : null));
    on('groups:open-saved', (w, id) => this.openSaved(w, str(id)));
    on('groups:saved-context', (w, id) => this.savedMenu(w, str(id)));
    // The editor opened with the keyboard takes the keys; closed, they go back to the strip.
    on('groups:overlay-focus', (w) => { if (!w.overlay.webContents.isDestroyed()) w.overlay.webContents.focus(); });
    on('overlay:pick', (w, item) => { if (item?.kind === 'tab-group' && item.refocus) w.win.webContents.focus(); });
  }
}

module.exports = { GroupsService };
