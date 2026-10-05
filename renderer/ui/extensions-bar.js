// The toolbar's extension buttons: only the pinned ones (the rest are in the
// puzzle-piece menu, main/extensions-ui.js), each a <button is="browser-action">
// from electron-chrome-extensions (preload/shell.js), which shows the icon and
// badge for the active tab and opens the popup. Right-click gives Lumio's own
// menu (pin, site access, remove). The menu and shortcuts run an extension
// through here too, so its popup opens under its button or the puzzle piece.
const PARTITION = 'persist:lumio';
const ID = /^[a-p]{32}$/;

export function initExtensionsBar({ api, button, list }) {
  const actions = window.browserAction; // missing in tests and incognito windows
  let pinned = [];
  let withAction = new Set(); // extensions that have a toolbar button
  const tabId = () => Number(list.getAttribute('tab')) || -1;
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };

  function render() {
    const want = pinned.filter((id) => ID.test(id) && withAction.has(id));
    for (const el of [...list.children]) if (!want.includes(el.id)) el.remove();
    want.forEach((id, i) => {
      let el = list.querySelector(`[id="${id}"]`);
      if (!el) {
        el = document.createElement('button', { is: 'browser-action' });
        el.id = id;
        el.className = 'ext-action';
        el.partition = PARTITION;
        el.alignment = 'bottom left';
      }
      if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
      el.tab = tabId(); // also redraws its icon and badge
    });
  }

  async function loadPins() {
    const t = await api.invoke('extensions:toolbar').catch(() => null);
    pinned = t?.pinned || [];
    render();
  }

  if (actions) {
    actions.addEventListener('update', (state) => {
      withAction = new Set((state?.actions || []).map((a) => a.id));
      render();
    });
    actions.addObserver(PARTITION);
    actions.getState(PARTITION).catch(() => {});
  }
  // The active tab changed (shell.js sets the list's tab).
  new MutationObserver(() => { for (const el of list.children) el.tab = tabId(); }).observe(list, { attributes: true, attributeFilter: ['tab'] });

  // Lumio's own right-click menu, before the library's (capture phase).
  list.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.ext-action');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    const fromKeys = !e.clientX && !e.clientY;
    api.send('extensions:context', { id: el.id, x: fromKeys ? r.left : e.clientX, y: fromKeys ? r.bottom : e.clientY });
  }, true);

  button.setAttribute('aria-haspopup', 'menu');
  button.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus where it is; the menu takes it
  button.addEventListener('click', () => {
    const r = button.getBoundingClientRect();
    api.send('extensions:menu', { rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
  });

  // Run an extension (from the menu or a keyboard shortcut).
  api.on('ext-activate', ({ id } = {}) => {
    if (!actions || !ID.test(String(id))) return;
    const pin = list.querySelector(`[id="${id}"]`);
    actions.activate(PARTITION, { eventType: 'click', extensionId: id, tabId: tabId(), alignment: 'bottom left', anchorRect: rectOf(pin || button) });
  });
  api.on('ext-menu-closed', ({ refocus } = {}) => { if (refocus) button.focus(); });
  api.on('extensions-changed', loadPins);
  loadPins();
}
