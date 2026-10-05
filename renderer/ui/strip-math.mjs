// The tab strip's arithmetic, without the page (renderer/ui/tabstrip.js uses
// it; tests/tab-strip.test.mjs checks it in Node).

// Where something dropped at x lands, Chrome's way: the middle half of a tab
// is "onto that tab" (it opens there); the outer quarters are between tabs
// (a new tab there). rects: the tabs' { left, right } in order.
export function dropTarget(rects, x) {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const hot = (r.right - r.left) / 4;
    if (x < r.left + hot) return { index: i, on: null };
    if (x < r.right - hot) return { index: i, on: i };
  }
  return { index: rects.length, on: null };
}

// Between which tabs a dragged tab would go: how many tabs' middles are left of x.
export function insertIndex(rects, x) {
  return rects.filter((r) => (r.left + r.right) / 2 < x).length;
}

// Where the drop arrow points: the middle of the tab, or the gap before index.
export function markerX(rects, { index, on }) {
  if (!rects.length) return null;
  if (on != null) return (rects[on].left + rects[on].right) / 2;
  if (index <= 0) return rects[0].left;
  if (index >= rects.length) return rects[rects.length - 1].right;
  return (rects[index - 1].right + rects[index].left) / 2;
}

// Shift-click: every tab from the anchor to this one (ids in strip order).
export function rangeIds(order, anchor, id) {
  const a = order.indexOf(anchor);
  const b = order.indexOf(id);
  if (b < 0) return [];
  if (a < 0) return [id];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

// ⌘/Ctrl-click: the tab joins the selection, or leaves it (never the last one).
// Returns the new selection and the tab to show.
export function toggleId(order, selected, id, active) {
  const set = new Set(selected);
  if (set.has(id) && set.size > 1) {
    set.delete(id);
    if (id !== active) return { selected: order.filter((x) => set.has(x)), active };
    // The tab you were on left the selection: the nearest selected tab shows.
    const i = order.indexOf(id);
    const near = order.filter((x) => set.has(x)).sort((x, y) => Math.abs(order.indexOf(x) - i) - Math.abs(order.indexOf(y) - i))[0];
    return { selected: order.filter((x) => set.has(x)), active: near };
  }
  set.add(id);
  return { selected: order.filter((x) => set.has(x)), active: id };
}

// Tabs pulled this far out of the strip (px), or out of the window, leave it
// (Chrome's vertical detach distance is 15px).
export const DETACH = 15;
export function pulledOut({ x, y }, strip, view) {
  return y < strip.top - DETACH || y > strip.bottom + DETACH || x < -DETACH || x > view.width + DETACH;
}
