// Keyboard access to the window (WAI-ARIA tabs pattern, Chrome's F6):
//  - The tab strip is one Tab stop. Left/Right move between tabs, Home/End go
//    to the first and last, Enter or Space switches to the focused tab, and
//    Delete closes it.
//  - F6 / Shift+F6 (the app menu sends focus-pane, so it works from the page
//    too) go round the toolbar, the bookmarks bar, the page, the AI panel and
//    the sidebar, skipping parts that are hidden.
//  - Screen readers hear when a download finishes (politely).

export function initA11y({ api, tabsEl, address }) {
  const tabs = () => [...tabsEl.querySelectorAll('.tab:not(.closing)')];

  // One tab takes Tab: the focused one while the strip has focus, otherwise
  // the selected one. The buttons inside tabs stay out of the Tab order
  // (Delete closes, the context menu mutes).
  function syncStops() {
    const all = tabs();
    const focused = all.find((el) => el === document.activeElement);
    const stop = focused || all.find((el) => el.getAttribute('aria-selected') === 'true') || all[0];
    for (const el of all) {
      el.tabIndex = el === stop ? 0 : -1;
      for (const b of el.querySelectorAll('button')) b.tabIndex = -1;
    }
    for (const el of tabsEl.querySelectorAll('.tab.closing')) el.tabIndex = -1;
  }
  new MutationObserver(syncStops).observe(tabsEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'class'] });
  tabsEl.addEventListener('focusin', syncStops);
  syncStops();

  function focusTab(el) {
    if (!el) return;
    el.focus();
    syncStops();
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  tabsEl.addEventListener('keydown', (e) => {
    const el = e.target.closest?.('.tab');
    if (!el || e.target !== el || e.metaKey || e.ctrlKey || e.altKey) return;
    const all = tabs();
    const i = all.indexOf(el);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step) focusTab(all[(i + step + all.length) % all.length]);
    else if (e.key === 'Home') focusTab(all[0]);
    else if (e.key === 'End') focusTab(all.at(-1));
    else if (e.key === 'Enter' || e.key === ' ') api.send('tab:activate', el._id);
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      // Focus goes to the tab that takes its place.
      const next = all[i + 1] || all[i - 1];
      api.send('tab:close', el._id);
      requestAnimationFrame(() => focusTab(next && next.isConnected && !next.classList.contains('closing') ? next : tabs()[Math.min(i, tabs().length - 1)]));
    } else return;
    e.preventDefault();
  });

  // ---- icon-only buttons get their tooltip as a name (without the shortcut)
  for (const b of document.querySelectorAll('button[title]:not([aria-label])')) {
    if (!b.textContent.trim()) b.setAttribute('aria-label', b.title.replace(/\s*\([^)]*\)\s*$/, ''));
  }

  // ---- downloads, announced once each
  const live = document.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  live.id = 'a11y-announce';
  document.body.append(live);
  const was = new Map(); // id -> state
  api.on('downloads', ({ items = [] } = {}) => {
    const said = [];
    for (const d of items) {
      const before = was.get(d.id);
      if (before === 'progressing' && d.state === 'completed') said.push(`${d.name} finished downloading`);
      was.set(d.id, d.state);
    }
    if (said.length) live.textContent = said.join('. ');
    const busy = items.filter((d) => d.state === 'progressing').length;
    document.querySelector('#downloads')?.setAttribute('aria-label', busy ? `Downloads, ${busy} in progress` : 'Downloads');
  });

  // ---- F6
  const visible = (el) => !!el && !el.hidden && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0;
  const firstIn = (box) => [...box.querySelectorAll('button, a[href], input, textarea, [tabindex]:not([tabindex="-1"])')].find((el) => !el.disabled && visible(el));
  const PANES = [
    { id: 'toolbar', box: () => document.querySelector('#toolbar'), also: () => document.querySelector('#tabstrip'), focus: () => { address.focus(); address.select(); } },
    { id: 'bookmarks', box: () => document.querySelector('#bookmarks-bar'), focus: (box) => firstIn(box)?.focus() },
    { id: 'page', page: true },
    { id: 'panel', box: () => document.querySelector('#panel'), focus: () => document.querySelector('#prompt')?.focus() },
    { id: 'sidebar', box: () => document.querySelector('#sidebar'), focus: (box) => firstIn(box)?.focus() },
  ];
  const shown = (p) => {
    if (p.page) return true;
    const box = p.box();
    if (!visible(box)) return false;
    if (p.id === 'panel') return !document.body.classList.contains('panel-closed');
    if (p.id === 'sidebar') return !document.body.classList.contains('sidebar-closed');
    if (p.id === 'bookmarks') return !!firstIn(box);
    return true;
  };
  function paneOf(el) {
    return PANES.findIndex((p) => !p.page && (p.box()?.contains(el) || p.also?.()?.contains(el)));
  }
  api.on('focus-pane', ({ dir = 1, fromPage = false } = {}) => {
    const at = fromPage ? PANES.findIndex((p) => p.page) : paneOf(document.activeElement);
    // Not in any part yet: F6 starts at the toolbar.
    let i = at < 0 ? (dir > 0 ? -1 : 0) : at;
    for (let n = 0; n < PANES.length; n++) {
      i = (i + dir + PANES.length) % PANES.length;
      const p = PANES[i];
      if (!shown(p)) continue;
      if (p.page) { api.send('tab:focus-page'); return; }
      p.focus(p.box());
      return;
    }
  });
}
