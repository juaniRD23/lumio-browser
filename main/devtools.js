// Developer tools for a tab, docked like Chrome's: on the right or bottom of
// the page, or in their own window. Lumio remembers the last choice
// (settings.devtoolsDock). DevTools' own dock menu still works for the open
// panel; Lumio's choice applies the next time they open.
const MODES = ['right', 'bottom', 'undocked'];
const LABELS = { right: 'Dock to Right', bottom: 'Dock to Bottom', undocked: 'Undock into Separate Window' };

const mode = (store) => (MODES.includes(store.settings.devtoolsDock) ? store.settings.devtoolsDock : 'right');

// Runs once DevTools' page is ready (right away if it already is).
function whenOpen(wc, fn) {
  const run = () => {
    const dt = wc.devToolsWebContents;
    if (!dt) return;
    const go = () => dt.executeJavaScript(fn).catch(() => {});
    if (dt.isLoading()) dt.once('did-stop-loading', go); else go();
  };
  if (wc.isDevToolsOpened()) run(); else wc.once('devtools-opened', run);
}

// panel: 'console' or 'inspect' (pick an element on the page); none toggles them.
function open(wc, store, panel) {
  if (!wc || wc.isDestroyed()) return;
  if (!panel && wc.isDevToolsOpened()) { wc.closeDevTools(); return; }
  if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: mode(store) });
  if (panel === 'console') whenOpen(wc, 'DevToolsAPI.showPanel("console")');
  if (panel === 'inspect') whenOpen(wc, 'DevToolsAPI.enterInspectElementMode()');
}

// A new dock choice; open DevTools move there now.
function setMode(store, wc, next) {
  if (!MODES.includes(next)) return;
  store.setSetting('devtoolsDock', next);
  if (wc && !wc.isDestroyed() && wc.isDevToolsOpened()) {
    wc.closeDevTools();
    wc.openDevTools({ mode: next });
  }
}

module.exports = { MODES, LABELS, mode, open, setMode };
