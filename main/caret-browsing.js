// Caret browsing (F7, View › Caret Browsing, or Settings › Keyboard): a
// text cursor in pages that moves with the arrow keys; Shift selects.
// Electron 43 has Chromium's own (webContents.caretBrowsingEnabled), the
// same as Chrome's F7, so no page script is needed and screen readers
// follow the cursor. It's one setting
// for every tab. Turning it on with F7 asks first, until the person says yes
// once: the key is easy to hit by accident and pages then act differently.

const isOn = (store) => store.settings.caretBrowsing === true;

// A tab's page follows the setting (as it loads, and when it changes).
function follow(wc, on) {
  if (!wc || wc.isDestroyed() || wc.isCaretBrowsingEnabled() === on) return;
  wc.setCaretBrowsingEnabled(on);
}

function watch(wc, { store, isTab }) {
  wc.on('dom-ready', () => { if (isTab(wc)) follow(wc, isOn(store)); });
}

// tabs: the tabs' webContents. changed: the View menu shows the new state.
function set(on, { store, tabs, changed }) {
  store.setSetting('caretBrowsing', !!on);
  for (const wc of tabs()) follow(wc, !!on);
  changed();
}

// F7 or the menu, in window `w`. key: how the shortcut looks now ('F7').
// While the question is up, pressing F7 again doesn't ask a second time.
let asking = false;
async function toggle(w, { store, tabs, changed, dialog, key = 'F7' }) {
  const on = !isOn(store);
  if (on && store.settings.caretBrowsingAsked !== true) {
    if (asking) { changed(); return false; }
    asking = true;
    const { response } = await dialog.showMessageBox(w.win, {
      type: 'question',
      message: 'Turn on caret browsing?',
      detail: `Caret browsing puts a text cursor in pages, so you can move around with the arrow keys and select text with Shift.${key ? ` Press ${key} again to turn it off.` : ''}`,
      buttons: ['Turn On', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    }).finally(() => { asking = false; });
    if (response !== 0) { changed(); return false; } // the menu's checkmark goes back
    store.setSetting('caretBrowsingAsked', true);
  }
  set(on, { store, tabs, changed });
  if (!w.closed) w.emit('toast', { text: on ? `Caret browsing is on${key ? `. Press ${key} to turn it off.` : ''}` : 'Caret browsing is off' });
  return on;
}

module.exports = { isOn, follow, watch, set, toggle };
