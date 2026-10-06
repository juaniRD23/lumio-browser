// Where a window shows its tabs: across the top (the tab strip) or in a
// column at the side, "Show tabs to the side" (Chrome's vertical tabs). The
// column can be collapsed to icons; hovering it then shows the full list as
// a flyout over the page (renderer/ui/tab-flyout.js).
//
// Each window remembers its own choice (it's saved with the session). New
// windows start with the last choice made (settings.verticalTabs).

const TOOLBAR_H = 46; // with tabs at the side, the toolbar is the window's top row
const STRIP_H = 40; // the tab strip, otherwise (window.js titleBarOverlay)

// A window's starting layout: what it was saved with, else the default.
function initial(store, saved) {
  if (saved && typeof saved === 'object') return { vertical: !!saved.vertical, collapsed: !!saved.collapsed };
  return { vertical: !!store.settings.verticalTabs, collapsed: false };
}

// Changes a window's layout. Turning the column on or off also becomes the
// default for new windows.
function set(w, patch = {}, store) {
  const next = { ...w.tabLayout };
  if (typeof patch.vertical === 'boolean') {
    next.vertical = patch.vertical;
    if (store.settings.verticalTabs !== patch.vertical) store.setSetting('verticalTabs', patch.vertical);
  }
  if (typeof patch.collapsed === 'boolean') next.collapsed = patch.collapsed;
  if (next.vertical === w.tabLayout.vertical && next.collapsed === w.tabLayout.collapsed) return;
  w.tabLayout = next;
  apply(w);
  w.app.onSessionChanged?.();
}

// Tells the window's UI, and on Windows lines the caption buttons up with
// the row they now sit in.
function apply(w) {
  if (w.closed) return;
  // The flyout only belongs to a collapsed column.
  if (w.overlayKind === 'vtabs' && !(w.tabLayout.vertical && w.tabLayout.collapsed)) w.hideOverlay();
  if (process.platform !== 'darwin') {
    try { w.win.setTitleBarOverlay({ height: captionHeight(w.tabLayout) }); } catch { /* no caption overlay */ }
  }
  w.emit('tab-layout', w.tabLayout);
}

// Windows' caption buttons: as tall as the top row.
const captionHeight = (layout) => (layout?.vertical ? TOOLBAR_H : STRIP_H);

// "Show Tabs to the Side" (a checkbox), for the tab and tab strip menus.
function menuItems(w, store) {
  const items = [{ label: 'Show Tabs to the Side', type: 'checkbox', checked: !!w.tabLayout.vertical, click: () => set(w, { vertical: !w.tabLayout.vertical }, store) }];
  if (w.tabLayout.vertical) items.push({ label: w.tabLayout.collapsed ? 'Expand Tabs' : 'Collapse Tabs', click: () => set(w, { collapsed: !w.tabLayout.collapsed }, store) });
  return items;
}

// The flyout over the page closes once the pointer leaves it. Asked of the
// OS, because a pointer that never moved into it sends the page no events.
function watchFlyout(w) {
  const { screen } = require('electron');
  clearInterval(w.flyoutTimer);
  w.flyoutTimer = setInterval(() => {
    if (w.closed || w.overlayKind !== 'vtabs') { clearInterval(w.flyoutTimer); return; }
    const p = screen.getCursorScreenPoint();
    const c = w.win.getContentBounds();
    const b = w.overlay.getBounds();
    if (!insideFlyout({ x: p.x - c.x, y: p.y - c.y }, b)) w.hideOverlay();
  }, 120);
}
// The flyout's view has a transparent edge on the right for its shadow.
const insideFlyout = (pt, b) => pt.x >= b.x - 2 && pt.x <= b.x + b.width - 14 && pt.y >= b.y - 2 && pt.y <= b.y + b.height + 2;

module.exports = { initial, set, captionHeight, menuItems, watchFlyout, insideFlyout };
