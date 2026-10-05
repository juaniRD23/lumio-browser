// Tab groups in one window, like Chrome's: a named, colored set of tabs that
// sit next to each other in the strip, with a chip before them that collapses
// and expands them. A tab is in a group when tab.groupId names one of this
// window's groups; pinned tabs never are.
//
// The TabManager (main/tabs.js) owns one of these as `tabs.groups` and calls
// normalize() before it tells the window about a change, so whatever moved
// (a drag, a tab opened from a grouped tab, a tab closed) the groups stay
// together and empty ones go away. Saved groups (main/saved-groups.js) are
// copies of a group kept to reopen later; a group remembers its copy in
// savedId.
const crypto = require('crypto');

// Chrome's nine group colors, in its order. The window draws them from
// theme tokens (--group-<color>), so each has a light and a dark shade.
const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const MAX_TITLE = 100;

const newGroupId = () => 'g' + crypto.randomBytes(6).toString('base64url');
const cleanTitle = (t) => String(t ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_TITLE);
const cleanColor = (c) => (COLORS.includes(c) ? c : null);

class TabGroups {
  // manager: the TabManager (tabs, activeId, activate(), create(), changed()).
  constructor(manager) {
    this.m = manager;
    this.list = new Map(); // id -> { id, title, color, collapsed, savedId }
  }

  get(id) { return this.list.get(id) || null; }
  tabsOf(id) { return this.m.tabs.filter((t) => t.groupId === id); }
  groupOf(tab) { return tab?.groupId ? this.get(tab.groupId) : null; }

  // The color a new group gets: the first one no group here uses, like Chrome.
  nextColor() {
    const used = new Set([...this.list.values()].map((g) => g.color));
    return COLORS.find((c) => !used.has(c)) || COLORS[this.list.size % COLORS.length];
  }

  // A new group of these tabs (moved next to the first one), or null.
  create(tabIds, { title = '', color = null, id = null, collapsed = false, savedId = null } = {}) {
    const tabs = this.pick(tabIds);
    if (!tabs.length) return null;
    const group = { id: typeof id === 'string' && !this.list.has(id) ? id : newGroupId(), title: cleanTitle(title), color: cleanColor(color) || this.nextColor(), collapsed: !!collapsed, savedId: savedId || null };
    this.list.set(group.id, group);
    for (const t of tabs) t.groupId = group.id;
    this.gather(group.id, tabs[0]);
    this.m.changed();
    return group;
  }

  // Puts tabs in an existing group, at its end.
  add(tabIds, groupId) {
    const group = this.get(groupId);
    const tabs = this.pick(tabIds);
    if (!group || !tabs.length) return false;
    const members = this.tabsOf(groupId);
    for (const t of tabs) {
      if (t.groupId === groupId) continue;
      t.groupId = groupId;
      this.m.tabs.splice(this.m.tabs.indexOf(t), 1);
      const last = members.length ? this.m.tabs.indexOf(members[members.length - 1]) : this.m.tabs.length - 1;
      this.m.tabs.splice(last + 1, 0, t);
      members.push(t);
    }
    if (group.collapsed) group.collapsed = false;
    this.m.changed();
    return true;
  }

  // Takes tabs out of their groups. Ones in the middle of a group move to
  // just after it, so the rest stays together.
  remove(tabIds) {
    const tabs = this.pick(tabIds, { grouped: true });
    for (const t of tabs) {
      const members = this.tabsOf(t.groupId);
      t.groupId = null;
      const rest = members.filter((x) => x !== t && x.groupId);
      if (!rest.length) continue;
      const i = this.m.tabs.indexOf(t);
      const last = this.m.tabs.indexOf(rest[rest.length - 1]);
      if (i < last) {
        this.m.tabs.splice(i, 1);
        this.m.tabs.splice(this.m.tabs.indexOf(rest[rest.length - 1]) + 1, 0, t);
      }
    }
    if (tabs.length) this.m.changed();
    return tabs.length > 0;
  }

  // The group goes; its tabs stay where they are.
  ungroup(groupId) {
    if (!this.list.has(groupId)) return false;
    for (const t of this.tabsOf(groupId)) t.groupId = null;
    this.list.delete(groupId);
    this.m.changed();
    return true;
  }

  // Name, color, collapsed. Collapsing the group that has the tab you're on
  // moves you to the nearest tab outside it (a new tab when there's none).
  update(groupId, { title, color, collapsed } = {}) {
    const g = this.get(groupId);
    if (!g) return null;
    if (title !== undefined) g.title = cleanTitle(title);
    if (cleanColor(color)) g.color = color;
    if (typeof collapsed === 'boolean' && collapsed !== g.collapsed) {
      g.collapsed = collapsed;
      if (collapsed && this.m.active?.groupId === groupId) this.leave(groupId);
    }
    this.m.changed();
    return g;
  }

  leave(groupId) {
    const tabs = this.m.tabs;
    const at = tabs.indexOf(this.m.active);
    const visible = (t) => t.groupId !== groupId && !this.get(t.groupId)?.collapsed;
    const after = tabs.slice(at + 1).find(visible);
    const before = tabs.slice(0, at).reverse().find(visible);
    const next = after || before;
    if (next) this.m.activate(next.id);
    else {
      const members = this.tabsOf(groupId);
      this.m.create(undefined, { index: tabs.indexOf(members[members.length - 1]) + 1 });
    }
  }

  // A tab you go to (Ctrl+Tab, a click in the overview, Lumio switching tabs)
  // opens its collapsed group, like Chrome.
  onActivate(tab) {
    const g = this.groupOf(tab);
    if (g?.collapsed) g.collapsed = false;
  }

  // Moves the whole group so it starts before `beforeTabId` (null: at the end).
  // Never into the pinned tabs, or into the middle of another group.
  move(groupId, beforeTabId) {
    const members = this.tabsOf(groupId);
    if (!members.length) return false;
    const tabs = this.m.tabs;
    const rest = tabs.filter((t) => t.groupId !== groupId);
    let at = beforeTabId == null ? rest.length : rest.findIndex((t) => t.id === beforeTabId);
    if (at < 0) return false;
    while (at < rest.length && rest[at].pinned) at++;
    // Inside another group: go to that group's start.
    while (at > 0 && at < rest.length && rest[at].groupId && rest[at].groupId === rest[at - 1].groupId) at--;
    rest.splice(at, 0, ...members);
    tabs.splice(0, tabs.length, ...rest);
    this.m.changed();
    return true;
  }

  // After a tab was moved by itself (dragged in the strip): it joins the group
  // it was dropped inside, stays in its own if it's still at that group's edge,
  // and otherwise leaves it.
  afterMove(tab) {
    if (!tab || tab.pinned) return;
    const tabs = this.m.tabs;
    const i = tabs.indexOf(tab);
    const left = tabs[i - 1]?.groupId || null;
    const right = tabs[i + 1]?.groupId || null;
    if (left && left === right) tab.groupId = left;
    else if (tab.groupId && tab.groupId !== left && tab.groupId !== right) tab.groupId = null;
    const g = this.groupOf(tab);
    if (g?.collapsed) g.collapsed = false;
  }

  // Groups stay in one piece (gathered where their first tab is), pinned tabs
  // and tabs with a group this window doesn't have leave theirs, and empty
  // groups go. Called before every update of the window.
  normalize() {
    const tabs = this.m.tabs;
    for (const t of tabs) if (t.groupId && (t.pinned || !this.list.has(t.groupId))) t.groupId = null;
    const seen = new Set();
    for (let i = 0; i < tabs.length; i++) {
      const id = tabs[i].groupId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      this.gather(id, tabs[i]);
    }
    for (const id of [...this.list.keys()]) if (!seen.has(id)) this.list.delete(id);
  }

  // Moves the group's tabs together, right after `first`, keeping their order.
  gather(groupId, first) {
    const tabs = this.m.tabs;
    const members = tabs.filter((t) => t.groupId === groupId);
    const rest = tabs.filter((t) => t.groupId !== groupId || t === first);
    const at = rest.indexOf(first);
    rest.splice(at, 1, ...members);
    tabs.splice(0, tabs.length, ...rest);
  }

  // The tabs asked for, in strip order: never pinned ones.
  pick(tabIds, { grouped = false } = {}) {
    const want = new Set((Array.isArray(tabIds) ? tabIds : [tabIds]).map(Number));
    return this.m.tabs.filter((t) => want.has(t.id) && !t.pinned && (!grouped || t.groupId));
  }

  // ---- for the window, the session file and saved groups
  state() {
    return [...this.list.values()].map((g) => ({ ...g, count: this.tabsOf(g.id).length }));
  }

  // What the session file keeps; tabs say their group in sessionTabs().
  session() {
    return [...this.list.values()].map(({ id, title, color, collapsed, savedId }) => ({ id, title, color, collapsed, ...(savedId ? { savedId } : {}) }));
  }

  // Back from the session file: `list` is the saved tabs (each may name a
  // group) and `made` the tabs made from them, in the same order.
  restore(groups = [], list = [], made = []) {
    const found = new Map();
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g || typeof g.id !== 'string' || found.has(g.id)) continue;
      found.set(g.id, { id: g.id, title: cleanTitle(g.title), color: cleanColor(g.color) || 'grey', collapsed: !!g.collapsed, savedId: typeof g.savedId === 'string' ? g.savedId : null });
    }
    list.forEach((saved, i) => {
      const t = made[i];
      if (t && saved?.group && found.has(saved.group) && !t.pinned) t.groupId = saved.group;
    });
    for (const g of found.values()) this.list.set(g.id, g);
    this.normalize();
    // The tab you were on can't be hidden in a collapsed group.
    this.onActivate(this.m.active);
  }
}

module.exports = { TabGroups, COLORS, cleanTitle, newGroupId };
