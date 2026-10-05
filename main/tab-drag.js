// Dragging tabs out of the strip, like Chrome: pulled far enough out, the
// tab (or the selected tabs) becomes a window of its own that follows the
// pointer; let go over another window's tab strip and it joins that window
// there. The pages keep running the whole time (they move, they don't reload).
// A window's only tab drags the whole window.
//
// The window the drag started in keeps the pointer until the button comes up
// (renderer/ui/tabstrip.js sends where it is, in screen coordinates). Each
// window's shell says where its strip is, and shows where tabs would land.

const ATTACH_MARGIN = 16; // px above and below a strip that still count as over it

class TabDrag {
  // deps: { alive(), cur(), strip: TabStrip }
  constructor(deps) {
    this.deps = deps;
    this.drag = null; // { source, win, ids, grab, created, target, index, origin }
  }

  // The window whose tab strip is under a screen point (not the one being dragged).
  targetAt(x, y, except) {
    const wins = this.deps.alive().filter((w) => w !== except && w.incognito === this.drag.win.incognito && !w.win.isMinimized() && w.win.isVisible());
    const front = this.deps.cur();
    wins.sort((a, b) => (b === front) - (a === front));
    for (const w of wins) {
      const c = w.win.getContentBounds();
      const s = w.stripRect || { x: 0, y: 0, width: c.width, height: 40 };
      const px = x - c.x;
      const py = y - c.y;
      if (px >= s.x && px <= s.x + s.width && py >= s.y - ATTACH_MARGIN && py <= s.y + s.height + ATTACH_MARGIN) return { w, x: px, y: py };
    }
    return null;
  }

  // The tabs left the strip. ids: the tabs dragged (in strip order); screen:
  // where the pointer is; grab: where it is in the window (so the new window
  // appears with the tab under the pointer).
  start(source, { ids, screenX, screenY, grabX, grabY } = {}) {
    if (this.drag || !Array.isArray(ids) || ![screenX, screenY, grabX, grabY].every(Number.isFinite)) return null;
    const list = source.tabs.tabs.filter((t) => ids.includes(t.id)).map((t) => t.id);
    if (!list.length) return null;
    const grab = { x: Math.round(grabX), y: Math.round(grabY) };
    const origin = list.map((id) => source.tabs.tabs.findIndex((t) => t.id === id));
    if (list.length >= source.tabs.tabs.length) {
      // The window's every tab: the window itself moves.
      this.drag = { source, win: source, ids: list, grab, created: false, target: null, index: null, origin };
    } else {
      const [width, height] = source.win.getSize();
      const bounds = { x: Math.round(screenX - grab.x), y: Math.round(screenY - grab.y), width, height };
      const win = this.deps.strip.moveToNewWindow(source, list, { bounds, inactive: true, focus: false });
      if (!win) return null;
      this.drag = { source, win, ids: list, grab, created: true, target: null, index: null, origin };
    }
    this.move({ screenX, screenY });
    return this.drag.win;
  }

  move({ screenX, screenY } = {}) {
    const d = this.drag;
    if (!d || ![screenX, screenY].every(Number.isFinite) || d.win.closed) return;
    d.win.win.setPosition(Math.round(screenX - d.grab.x), Math.round(screenY - d.grab.y));
    const hit = this.targetAt(screenX, screenY, d.win);
    if (d.target && d.target !== hit?.w) this.hint(d.target, null);
    if (!hit) {
      if (d.target) d.win.win.setOpacity?.(1);
      d.target = null;
      return;
    }
    if (d.target !== hit.w) { d.index = null; d.win.win.setOpacity?.(0.6); }
    d.target = hit.w;
    this.hint(hit.w, { x: hit.x, count: d.ids.length });
  }

  // Shows (or hides) where the tabs would land in a window's strip.
  hint(w, where) { if (!w.closed) w.emit('tab-drag-hint', where); }

  // That window's shell worked out the tab index under the pointer.
  setIndex(w, index) {
    if (this.drag?.target === w && Number.isInteger(index) && index >= 0) this.drag.index = index;
  }

  // The button came up: join the window under the pointer, or stay a window.
  end({ screenX, screenY } = {}) {
    const d = this.drag;
    if (!d) return null;
    if ([screenX, screenY].every(Number.isFinite)) this.move({ screenX, screenY });
    this.drag = null;
    if (d.target) this.hint(d.target, null);
    if (d.win.closed) return null;
    d.win.win.setOpacity?.(1);
    if (d.target && !d.target.closed) {
      const ids = d.win.tabs.tabs.filter((t) => d.ids.includes(t.id)).map((t) => t.id);
      return this.deps.strip.moveTabs(d.win, ids, d.target, { index: d.index });
    }
    if (d.created) d.win.win.show();
    d.win.focus();
    return d.win;
  }

  // Esc, or the drag was lost: the tabs go back where they were.
  cancel() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.target) this.hint(d.target, null);
    if (!d.created || d.win.closed) return;
    d.win.win.setOpacity?.(1);
    if (d.source.closed) { d.win.win.show(); return; }
    const ids = d.win.tabs.tabs.filter((t) => d.ids.includes(t.id)).map((t) => t.id);
    this.deps.strip.moveTabs(d.win, ids, d.source, { index: Math.min(...d.origin) });
  }

  // on: main.js's helper (it finds the sender's window).
  register({ on }) {
    on('tab:tear', (w, msg) => this.start(w, msg || {}));
    on('tab:drag-move', (w, msg) => { if (this.drag?.source === w) this.move(msg || {}); });
    on('tab:drag-end', (w, msg) => { if (this.drag?.source === w) this.end(msg || {}); });
    on('tab:drag-cancel', (w) => { if (this.drag?.source === w) this.cancel(); });
    on('tab:drag-index', (w, index) => this.setIndex(w, Number(index)));
    // Where each window's tab strip is (window coordinates), for dropping tabs on it.
    on('tab:strip-rect', (w, r) => {
      if (r && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k]))) w.stripRect = { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  }
}

module.exports = { TabDrag, ATTACH_MARGIN };
