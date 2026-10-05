// Back, Forward, Reload and Home in the toolbar, the way Chrome's work
// (main/navigation.js does the work):
//  - right-click Back or Forward, or press and hold it: this tab's history
//  - middle-click or ⌘/Ctrl-click: open it in a new tab (add Shift to switch
//    to it); Shift-click: a new window
//  - the mouse's own back and forward buttons, anywhere in the window
//  - Home, when it's turned on in Settings › Appearance
const IS_MAC = /Mac/.test(navigator.platform);
const HOLD = 500; // ms holding Back or Forward down before its menu opens
const HOME_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11l8-6.5 8 6.5"/><path d="M6.5 9.5V19a1 1 0 0 0 1 1H10v-5h4v5h2.5a1 1 0 0 0 1-1V9.5"/></svg>';

// Where a click opens something (the same rule as main/navigation.js).
export function disposition(e) {
  if (e.button === 1 || (IS_MAC ? e.metaKey : e.ctrlKey)) return e.shiftKey ? 'foreground' : 'background';
  if (e.shiftKey) return 'window';
  return 'current';
}

export function initNavigation({ api }) {
  const $ = (sel) => document.querySelector(sel);

  const home = document.createElement('button');
  home.id = 'home';
  home.className = 'icon-btn';
  home.hidden = true;
  home.title = 'Open the home page';
  home.setAttribute('aria-label', 'Home');
  home.innerHTML = HOME_ICON;
  $('#reload').after(home);
  const prefs = (p) => { home.hidden = !p?.showHome; };
  api.invoke('shell:nav-prefs').then(prefs).catch(() => {});
  api.on('nav-prefs', prefs);

  // History menus: right-click (or the menu key), or hold the button down.
  let held = null; // the button whose hold opened its menu: the click that ends the hold is ignored
  const historyMenu = (btn, dir) => {
    const r = btn.getBoundingClientRect();
    api.send('tab:history-menu', { dir, x: r.left, y: r.bottom + 4 });
  };
  for (const dir of ['back', 'forward']) {
    const btn = $(`#${dir}`);
    btn.title += '\nRight-click or hold to see history';
    let timer = 0;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      held = null;
      clearTimeout(timer);
      timer = setTimeout(() => { held = btn; historyMenu(btn, dir); }, HOLD);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(type, () => clearTimeout(timer));
    // The click that ends a hold comes right after pointerup; after it, clicks count again.
    btn.addEventListener('pointerup', () => setTimeout(() => { if (held === btn) held = null; }, 0));
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); clearTimeout(timer); historyMenu(btn, dir); });
  }

  // Clicks with a modifier, and middle-clicks, open in a new tab or window.
  // These run first (capturing), before shell.js's plain Back/Forward/Reload.
  const open = (which, where) => {
    if (which === 'home') api.send('tab:home', { disposition: where });
    else api.send('tab:nav-new', { which, disposition: where });
  };
  for (const which of ['back', 'forward', 'reload', 'home']) {
    const btn = $(`#${which}`);
    btn.addEventListener('click', (e) => {
      if (held === btn && e.detail > 0) { e.stopImmediatePropagation(); held = null; return; }
      const where = disposition(e);
      if (which !== 'home' && where === 'current') return;
      e.stopImmediatePropagation();
      open(which, where);
    }, true);
    btn.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      open(which, disposition(e));
    });
  }

  // The mouse's back and forward buttons over the toolbar, tabs or AI panel.
  // (On Linux Electron already makes them the window's app-command.)
  if (/Linux/.test(navigator.platform)) return;
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    api.send(e.button === 3 ? 'tab:back' : 'tab:forward');
  });
}
