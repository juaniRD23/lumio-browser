// Search tabs (⇧⌘A, or the button at the end of the tab strip), like
// Chrome's: every open tab in every window of this kind (normal or
// incognito), the ones you used last first, and the recently closed tabs and
// windows. renderer/ui/overlay-tabsearch.js draws it and searches it.
const RECENT = 12; // recently closed entries listed

// A site's icon for the list. Incognito's list shows only icons it already
// has: fetching one would happen outside the incognito profile.
const iconOf = (favicon, incognito) => (typeof favicon === 'string' && (incognito ? /^data:image\//.test(favicon) : /^(https?:|data:image\/)/.test(favicon)) ? favicon : null);

const hostOf = (url) => {
  try {
    const u = new URL(url);
    return /^(https?|file):$/.test(u.protocol) ? (u.host || u.pathname.split('/').pop() || '') : '';
  } catch { return ''; }
};

class TabSearch {
  // deps: { alive(), recentlyClosed: [], reopenClosed(index), ownsClosed(w, entry) }
  constructor(deps) {
    this.deps = deps;
    this.watched = new WeakSet(); // windows whose list closes when it loses the keyboard
  }

  row(w, t, front) {
    const url = w.tabs.displayUrl(t);
    return {
      windowId: w.id,
      tabId: t.id,
      title: t.title || url || 'New Tab',
      url,
      host: hostOf(url),
      favicon: iconOf(t.favicon, w.incognito),
      internal: (t.pendingUrl || t.url || '').startsWith('lumio:'),
      current: front && t.id === w.tabs.activeId,
      audible: !!t.audible,
      muted: !!t.muted,
      crashed: !!t.crashed,
      lastActive: t.lastActive || 0,
    };
  }

  // What the list shows for window w.
  data(w) {
    const wins = this.deps.alive().filter((x) => x.incognito === w.incognito);
    const tabs = wins.flatMap((x) => x.tabs.tabs.map((t) => this.row(x, t, x === w)))
      .sort((a, b) => (b.current - a.current) || (b.lastActive - a.lastActive));
    // (A profile's own closed tabs and windows: ownsClosed(w, entry).)
    const list = w.incognito || w.profile?.guest ? w.closedTabs.map((e, index) => ({ kind: 'tab', ...e, index }))
      : this.deps.recentlyClosed.map((e, index) => ({ ...e, index })).filter((e) => this.deps.ownsClosed?.(w, e) ?? true);
    const closed = list.map((e) => ({
      index: e.index,
      kind: e.kind,
      title: e.kind === 'window' ? `${e.tabs.length} tab${e.tabs.length === 1 ? '' : 's'}` : e.title || e.url,
      url: e.kind === 'window' ? '' : e.url,
      host: e.kind === 'window' ? (e.tabs || []).map((t) => hostOf(t.url)).filter(Boolean).slice(0, 3).join(', ') : hostOf(e.url),
      favicon: iconOf(e.favicon, w.incognito),
      time: e.time || 0,
    })).reverse().slice(0, RECENT);
    return { tabs, closed, incognito: w.incognito };
  }

  // Switch to a tab (and its window).
  open(w, { windowId, tabId } = {}) {
    const x = this.deps.alive().find((y) => y.id === windowId && y.incognito === w.incognito);
    const tab = x?.tabs.get(tabId);
    if (!tab) return false;
    x.tabs.activate(tab.id);
    x.focus();
    tab.view?.webContents.focus();
    return true;
  }

  close(w, { windowId, tabId } = {}) {
    const x = this.deps.alive().find((y) => y.id === windowId && y.incognito === w.incognito);
    if (!x?.tabs.get(tabId)) return;
    const bounds = w.overlay.getBounds();
    x.tabs.close(tabId);
    // The list stays open with the tab gone (unless it was this window's last).
    if (w.closed) return;
    const data = { kind: 'tabsearch', ...this.data(w), update: true };
    if (w.overlayKind === 'tabsearch') { w.overlay.webContents.send('overlay-data', data); return; }
    // Closing the tab you're on shows another one, which closes dropdowns: open it again.
    w.showOverlay(bounds, data);
    w.overlay.webContents.focus();
  }

  // Clicking anywhere else (the page, the toolbar, another app) closes the
  // list, like Chrome's. Checked a moment later: the list may have just
  // taken the keyboard back (above).
  closeOnBlur(w) {
    if (this.watched.has(w)) return;
    this.watched.add(w);
    const wc = w.overlay.webContents;
    wc.on('blur', () => setTimeout(() => {
      if (w.closed || w.overlayKind !== 'tabsearch' || wc.isDestroyed() || wc.isFocused()) return;
      w.hideOverlay();
      w.emit('overlay-picked', { kind: 'tabsearch' });
    }, 0));
  }

  // A recently closed tab or window. Incognito keeps its own list.
  reopen(w, index) {
    if (!Number.isInteger(index)) return;
    if (!w.incognito) { this.deps.reopenClosed(index); return; }
    const [e] = w.closedTabs.splice(index, 1);
    if (e) w.tabs.create(e.url, { index: e.index, title: e.title, pinned: e.pinned, history: e.history });
  }

  // handle/on: main.js's helpers (they find the sender's window).
  register({ handle, on }) {
    handle('shell:tab-search', (w) => this.data(w));
    on('overlay:show', (w, msg) => {
      if (msg?.payload?.kind !== 'tabsearch') return;
      w.overlay.webContents.focus(); // typing searches
      this.closeOnBlur(w);
    });
    on('overlay:pick', (w, item) => {
      if (item?.kind !== 'tabsearch') return;
      if (item.action === 'open') this.open(w, item);
      else if (item.action === 'reopen') this.reopen(w, Number(item.index));
      // Esc: back to where you were (the page, or the button it opened from).
      else if (item.refocus === 'shell') w.win.webContents.focus();
      else if (item.refocus === 'page') w.tabs.wc()?.focus();
    });
    on('tab:search-close', (w, msg) => this.close(w, msg || {}));
  }
}

module.exports = { TabSearch, hostOf, iconOf };
