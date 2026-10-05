// Split view: two tabs side by side in a window's page area, like Chrome's.
// A window can hold several pairs. Activating either tab of a pair shows
// both, and the active tab is the focused side: the toolbar, find bar, zoom
// and Lumio AI all work on it. The pair sits next to each other in the tab
// strip, left side first.
//
// The shell draws the two panes (a title bar over each page, the divider)
// and reports where each page goes (layout:split); until it does, the slot's
// halves are used. No Electron here, so the bookkeeping is unit-tested.

const MIN_PANE = 260; // narrowest a side can be dragged, in px
const GAP = 10; // fallback layout only: the divider between the pages
const BAR = 30; // fallback layout only: the title bar over each page

const num = (v) => Number.isFinite(v);
const cleanRect = (r) => (r && num(r.x) && num(r.y) && num(r.width) && num(r.height)
  ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) }
  : null);

// Keeps both sides at least MIN_PANE wide (or half each in a narrow slot).
function clampRatio(ratio, width = 0) {
  const r = num(ratio) ? ratio : 0.5;
  const min = width > 0 ? Math.min(0.5, MIN_PANE / width) : 0.2;
  return Math.max(min, Math.min(1 - min, r));
}

// Where each page goes before the shell has measured its panes.
function fallbackRects(slot, ratio) {
  const inner = Math.max(2, slot.width - GAP);
  const leftW = Math.round(inner * clampRatio(ratio, slot.width));
  const y = slot.y + BAR;
  const height = Math.max(1, slot.height - BAR);
  return {
    left: { x: slot.x, y, width: Math.max(1, leftW), height },
    right: { x: slot.x + leftW + GAP, y, width: Math.max(1, slot.width - leftW - GAP), height },
  };
}

class SplitViews {
  // manager: the window's TabManager (tabs, get, activeId, activate, create, navigate, changed, layout, hooks).
  constructor(manager, { newTabUrl } = {}) {
    this.m = manager;
    this.newTabUrl = newTabUrl;
    this.pairs = []; // { left, right, ratio }: tab ids
    this.rects = null; // the shell's last report: { left, right, a, b }
    this.preview = null; // a tab dragged to the page's edge: where the active page goes meanwhile
  }

  pairOf(id) { return this.pairs.find((p) => p.left === id || p.right === id) || null; }
  partnerOf(id) {
    const p = this.pairOf(id);
    return p ? (p.left === id ? p.right : p.left) : null;
  }
  sideOf(id) {
    const p = this.pairOf(id);
    return p ? (p.left === id ? 'left' : 'right') : null;
  }
  // On screen right now: the active tab, or the other side of its pair.
  isShown(id) { return id === this.m.activeId || (this.m.activeId != null && this.partnerOf(this.m.activeId) === id); }

  // Pairs base with other; other goes on `side`. Earlier pairs of either tab end.
  create(baseId, otherId, side = 'right') {
    const m = this.m;
    const a = m.get(baseId);
    const b = m.get(otherId);
    if (!a || !b || a === b || a.pinned || b.pinned) return null;
    this.drop(baseId);
    this.drop(otherId);
    const pair = side === 'left' ? { left: otherId, right: baseId, ratio: 0.5 } : { left: baseId, right: otherId, ratio: 0.5 };
    this.pairs.push(pair);
    this.pack(pair, baseId);
    this.preview = null;
    m.changed();
    return pair;
  }

  // "Add Tab to New Split View" (tab context menu): the tab and the one
  // you're on side by side, or the tab and a new tab page to pick from.
  addToNew(id) {
    const m = this.m;
    const tab = m.get(id);
    if (!tab || tab.pinned) return null;
    const active = m.active;
    if (active && active.id !== id && !active.pinned && !this.pairOf(active.id)) {
      const pair = this.create(active.id, id, 'right');
      m.activate(id);
      return pair;
    }
    const fresh = m.create(this.newTabUrl, { active: false, index: m.tabs.indexOf(tab) + 1 });
    const pair = this.create(id, fresh.id, 'right');
    m.activate(fresh.id);
    m.hooks?.focusOmnibox?.();
    return pair;
  }

  // A tab dropped on an edge of the page: it takes that side, next to the tab
  // you were on (or the one you used last).
  dropOnEdge(id, { base, side } = {}) {
    const m = this.m;
    const fits = (t) => t && t.id !== id && !t.pinned;
    const other = fits(m.get(base)) ? m.get(base) : m.tabs.filter(fits).sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))[0];
    if (other && this.create(other.id, id, side === 'left' ? 'left' : 'right')) m.activate(id);
    else this.setPreview(null);
  }

  // A link opened "in split view": in the other side, or a new side next to this tab.
  openBeside(id, url) {
    const m = this.m;
    const partner = this.partnerOf(id);
    if (partner != null) { m.navigate(url, partner); m.activate(partner); return; }
    const tab = m.get(id);
    if (!tab || tab.pinned) return;
    const fresh = m.create(url, { active: false, index: m.tabs.indexOf(tab) + 1 });
    this.create(id, fresh.id, 'right');
    m.activate(fresh.id);
  }

  // Back to two separate tabs; if the pair was on screen, the focused side stays.
  separate(id) {
    const partner = this.drop(id);
    if (partner == null) return;
    const m = this.m;
    if (m.activeId === id || m.activeId === partner) m.activate(m.activeId); // shows only that one again
    m.changed();
  }

  swap(id) {
    const p = this.pairOf(id);
    if (!p) return;
    [p.left, p.right] = [p.right, p.left];
    p.ratio = 1 - p.ratio;
    this.rects = null; // the shell reports the swapped panes next
    this.pack(p, p.right);
    this.m.layout();
    this.m.changed();
  }

  setRatio(id, ratio) {
    const p = this.pairOf(id);
    if (!p || !num(ratio)) return;
    p.ratio = clampRatio(ratio, this.m.slot?.width);
    this.m.changed();
  }

  // A tab left its pair (closed, moved to another window, pinned): the pair
  // ends. Returns the other side's id, or null.
  drop(id) {
    const p = this.pairOf(id);
    if (!p) return null;
    this.pairs.splice(this.pairs.indexOf(p), 1);
    if (this.rects && (this.rects.left === id || this.rects.right === id)) this.rects = null;
    return p.left === id ? p.right : p.left;
  }

  // Keeps a pair next to each other in the strip, left first, moving the
  // side that isn't `anchorId`.
  pack(pair, anchorId) {
    const list = this.m.tabs;
    const left = list.find((t) => t.id === pair.left);
    const right = list.find((t) => t.id === pair.right);
    if (!left || !right || list.indexOf(right) === list.indexOf(left) + 1) return;
    if (anchorId === pair.left) {
      list.splice(list.indexOf(right), 1);
      list.splice(list.indexOf(left) + 1, 0, right);
    } else {
      list.splice(list.indexOf(left), 1);
      list.splice(list.indexOf(right), 0, left);
    }
  }

  // After a tab moved in the strip, its other side follows it.
  follow(id) {
    const p = this.pairOf(id);
    if (p) this.pack(p, id);
  }

  // A new tab opened at `index` goes after a pair rather than between its sides.
  insertIndex(index) {
    if (index == null) return index;
    const list = this.m.tabs;
    const before = list[index - 1];
    const p = before && this.pairs.find((x) => x.left === before.id);
    return p && list[index]?.id === p.right ? index + 1 : index;
  }

  // ---------------------------------------------------------------- layout
  // The shell's measured panes, for the pair it measured.
  setRects(msg) {
    const a = cleanRect(msg?.a);
    const b = cleanRect(msg?.b);
    this.rects = a && b && num(msg.left) && num(msg.right) ? { left: msg.left, right: msg.right, a, b } : null;
    this.m.layout();
  }

  // A tab is being dragged to an edge of the page: the active page moves
  // to the half it will take (null puts it back).
  setPreview(rect) {
    this.preview = cleanRect(rect);
    this.m.layout();
  }

  // The visible pair's pages and where each goes, or null when the active tab isn't in one.
  panes() {
    const m = this.m;
    const p = this.pairOf(m.activeId);
    if (!p) return null;
    const left = m.get(p.left);
    const right = m.get(p.right);
    if (!left || !right) return null;
    const r = this.rects && this.rects.left === p.left && this.rects.right === p.right ? { left: this.rects.a, right: this.rects.b } : fallbackRects(m.slot, p.ratio);
    return [{ tab: left, rect: r.left }, { tab: right, rect: r.right }];
  }

  // ---------------------------------------------------------------- state and session
  // For the shell: the pair on screen.
  state() {
    const p = this.pairOf(this.m.activeId);
    return p ? { left: p.left, right: p.right, ratio: p.ratio } : null;
  }

  // What the session file keeps for a tab: its pair number and side, when
  // both sides are saved.
  sessionFields(tab, saved) {
    const p = this.pairOf(tab.id);
    if (!p || !saved.some((t) => t.id === this.partnerOf(tab.id))) return {};
    return { split: { pair: this.pairs.indexOf(p), side: p.left === tab.id ? 'left' : 'right', ratio: Math.round(p.ratio * 1000) / 1000 } };
  }

  // Pairs again the restored tabs (created in the order of `list`).
  restore(list, created) {
    const groups = new Map();
    list.forEach((t, i) => {
      const s = t?.split;
      if (!s || !created[i] || !Number.isInteger(s.pair) || !['left', 'right'].includes(s.side)) return;
      const g = groups.get(s.pair) || {};
      g[s.side] = created[i];
      g.ratio = s.ratio;
      groups.set(s.pair, g);
    });
    for (const g of groups.values()) {
      if (!g.left || !g.right) continue;
      const pair = this.create(g.left.id, g.right.id, 'right');
      if (pair) pair.ratio = clampRatio(g.ratio);
    }
  }

  // ---------------------------------------------------------------- menus
  // Tab context menu items.
  menuItems(tab) {
    if (this.pairOf(tab.id)) {
      return [
        { label: 'Swap Sides', click: () => this.swap(tab.id) },
        { label: 'Separate Tabs', click: () => this.separate(tab.id) },
      ];
    }
    return [{ label: 'Add Tab to New Split View', enabled: !tab.pinned, click: () => this.addToNew(tab.id) }];
  }
}

module.exports = { SplitViews, clampRatio, fallbackRects, MIN_PANE };
