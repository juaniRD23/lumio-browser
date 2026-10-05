// The new tab page's shortcuts, like Chrome's: "My shortcuts" (start as
// your most visited sites; add, edit or remove them, up to 10) or "Most
// visited sites" (picked from history; removing one hides that site), or
// hidden. Kept in settings.ntpShortcuts:
//   { mode: 'custom' | 'mostVisited', custom: [{ url, title }] | null,
//     blocked: [url], hidden: false }
// custom stays null until the first change, so it follows history until then.
// The last change can be undone (one level, like Chrome's "Undo").
const { topSites } = require('./omnibox');

const MAX_CUSTOM = 10;
const MAX_MOST = 8;
const MAX_TITLE = 100;
// For a new profile with no history yet.
const STARTERS = [
  { url: 'https://www.google.com/', title: 'Google' },
  { url: 'https://www.youtube.com/', title: 'YouTube' },
  { url: 'https://github.com/', title: 'GitHub' },
  { url: 'https://lumio-usa.online/', title: 'Lumio' },
];

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// What someone typed in the URL field: a web address, or null.
function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s || /\s/.test(s) || s.length > 2048) return null;
  // No scheme typed ("localhost:3000" is a host and port, not one): https.
  if (!/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.href;
  } catch { return null; }
}

function read(settings) {
  const s = settings.ntpShortcuts || {};
  const item = (x) => (x && typeof x.url === 'string' ? { url: x.url, title: String(x.title || '').slice(0, MAX_TITLE) } : null);
  return {
    mode: s.mode === 'mostVisited' ? 'mostVisited' : 'custom',
    custom: Array.isArray(s.custom) ? s.custom.map(item).filter(Boolean).slice(0, MAX_CUSTOM) : null,
    blocked: Array.isArray(s.blocked) ? s.blocked.filter((u) => typeof u === 'string').slice(-200) : [],
    hidden: !!s.hidden,
  };
}

function mostVisited(state, history) {
  const blocked = new Set(state.blocked);
  const list = topSites(history, MAX_MOST + blocked.size).filter((t) => !blocked.has(t.url));
  return (list.length ? list : STARTERS.filter((t) => !blocked.has(t.url))).slice(0, MAX_MOST);
}

// What the new tab page shows: { mode, hidden, items, custom (editable), canAdd }.
function tiles(settings, history) {
  const s = read(settings);
  const custom = s.mode === 'custom';
  const items = custom && s.custom ? s.custom : mostVisited(s, history);
  return { mode: s.mode, hidden: s.hidden, items: items.map((t) => ({ url: t.url, title: t.title || hostOf(t.url) })), custom, canAdd: custom && items.length < MAX_CUSTOM };
}

class NtpShortcuts {
  constructor({ store }) {
    this.store = store;
    this.undoState = undefined; // what the last change replaced (null: nothing was set)
  }

  tiles() { return tiles(this.store.settings, this.store.history()); }

  save(next) {
    this.undoState = this.store.settings.ntpShortcuts ?? null;
    this.store.setSetting('ntpShortcuts', next);
    return this.tiles();
  }

  // The custom list, made from what's shown the first time it's changed.
  customList() {
    const s = read(this.store.settings);
    return s.custom ? s.custom.slice() : mostVisited(s, this.store.history()).map(({ url, title }) => ({ url, title }));
  }

  // Add (index null) or edit the shortcut at index. Returns the new tiles, or { error }.
  put(index, { url, title } = {}) {
    const s = read(this.store.settings);
    if (s.mode !== 'custom') return { error: 'Choose “My shortcuts” to add your own.' };
    const href = normalizeUrl(url);
    if (!href) return { error: 'Type a web address, like example.com' };
    const list = this.customList();
    const entry = { url: href, title: String(title || '').trim().slice(0, MAX_TITLE) || hostOf(href) };
    if (index == null) {
      if (list.length >= MAX_CUSTOM) return { error: `You can have up to ${MAX_CUSTOM} shortcuts.` };
      if (list.some((t) => t.url === href)) return { error: 'That shortcut is already here.' };
      list.push(entry);
    } else {
      const i = Number(index);
      if (!Number.isInteger(i) || !list[i]) return { error: 'That shortcut is gone.' };
      if (list.some((t, j) => j !== i && t.url === href)) return { error: 'That shortcut is already here.' };
      list[i] = entry;
    }
    return this.save({ ...s, custom: list });
  }

  // Removes a shortcut (in Most visited, hides that site from it).
  remove(url) {
    const s = read(this.store.settings);
    if (s.mode === 'custom') return this.save({ ...s, custom: this.customList().filter((t) => t.url !== url) });
    return this.save({ ...s, blocked: [...s.blocked.filter((u) => u !== url), String(url)] });
  }

  // Back to the start: My shortcuts follow history again, nothing hidden.
  reset() {
    const s = read(this.store.settings);
    return this.save({ ...s, custom: null, blocked: [] });
  }

  set({ mode, hidden } = {}) {
    const s = read(this.store.settings);
    if (mode === 'custom' || mode === 'mostVisited') s.mode = mode;
    if (typeof hidden === 'boolean') s.hidden = hidden;
    return this.save(s);
  }

  undo() {
    if (this.undoState === undefined) return this.tiles();
    const prev = this.undoState;
    this.undoState = undefined;
    this.store.setSetting('ntpShortcuts', prev);
    return this.tiles();
  }

  register({ internalHandle }) {
    const nt = (fn) => ({ w }, ...args) => (w.incognito ? { hidden: true, items: [], incognito: true } : fn(...args));
    internalHandle('page:ntp-shortcuts', ['newtab'], nt(() => this.tiles()));
    internalHandle('page:ntp-shortcut-save', ['newtab'], nt((index, entry) => this.put(index ?? null, entry || {})));
    internalHandle('page:ntp-shortcut-remove', ['newtab'], nt((url) => this.remove(String(url || ''))));
    internalHandle('page:ntp-shortcuts-set', ['newtab'], nt((opts) => this.set(opts || {})));
    internalHandle('page:ntp-shortcuts-reset', ['newtab'], nt(() => this.reset()));
    internalHandle('page:ntp-shortcuts-undo', ['newtab'], nt(() => this.undo()));
  }
}

module.exports = { NtpShortcuts, tiles, normalizeUrl, read, MAX_CUSTOM, MAX_MOST, STARTERS };
