// Bookmarks as a tree, like Chrome's: three fixed folders (Bookmarks bar,
// Other bookmarks, Mobile bookmarks) that hold bookmarks and folders.
// A folder is { id, title, time, pos, children: [] }; a bookmark is
// { id, title, url, time, pos, favicon? }.
//
// pos is a number that grows along a folder, and a folder's list is always
// in that order. Something added or moved gets a pos between its new
// neighbors', so its siblings never change: that's what lets two devices
// apply each other's changes (Lumio Sync) without renumbering, and both end
// with the same order.
//
// Saved in userData/bookmark-tree.json. Versions before folders kept a flat
// list in bookmarks.json: the first time, that list becomes the Bookmarks bar
// (same order, titles and icons) and the old file is left as it was.
//
// Lumio Sync uses two collections (main/sync/adapters.js): "bookmarkTree"
// has one record per bookmark or folder, with its parent and pos;
// "bookmarks" keeps the flat, one-record-per-address list older versions of
// Lumio understand. syncedTree/applySyncedTree and legacyEntries/
// applyLegacy below are their two sides. Bookmarks that come from that flat
// list (moved over from bookmarks.json, or sent by an older device) are
// marked `legacy`: every device makes the same ones from it, so they stay
// out of bookmarkTree until someone moves, sorts or edits them.
const crypto = require('crypto');

const ROOTS = [['bar', 'Bookmarks bar'], ['other', 'Other bookmarks'], ['mobile', 'Mobile bookmarks']];
const ROOT_IDS = new Set(ROOTS.map(([id]) => id));
const WEB = /^(https?|file):/i;
const MAX_TITLE = 300;
const MAX_URL = 4096;
const RECENT = 5; // folders the star's bubble offers first

const isFolder = (n) => Array.isArray(n?.children);
const newId = () => 'b' + crypto.randomBytes(9).toString('base64url');
// The same address gets the same id on every device, so bookmarks from before
// folders (and ones only older devices know about) line up when they sync.
const urlId = (url) => 'u' + crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 16);
// Imported ones get theirs from where they go, so importing the same file on
// two computers makes the same bookmarks, not two of each, once they sync.
const placeId = (parentId, what) => 'i' + crypto.createHash('sha256').update(`${parentId}\n${what}`).digest('hex').slice(0, 16);
const cleanTitle = (t) => String(t ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_TITLE);
// A web or file address that parses ("https://" alone doesn't), else ''.
const cleanUrl = (u) => {
  const s = String(u ?? '').trim();
  if (s.length > MAX_URL || !WEB.test(s)) return '';
  try { new URL(s); } catch { return ''; }
  return s;
};
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const clamp = (i, n) => Math.max(0, Math.min(Number.isFinite(+i) ? Math.floor(+i) : n, n));

// Folders first, then by name (numbers in names sort as numbers), like Chrome's "Sort by name".
const byName = (a, b) => (isFolder(b) - isFolder(a)) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
// A folder's order. Two at the same pos (added in the same spot on two devices) go by id, the same everywhere.
const byPos = (a, b) => a.pos - b.pos || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const renumber = (list) => list.forEach((n, i) => { n.pos = i + 1; });

// Puts nodes in a folder before what's at `index` now (null: at the end),
// with positions between their new neighbors'.
function insert(folder, index, nodes) {
  const list = folder.children;
  const at = clamp(index ?? list.length, list.length);
  const lo = list[at - 1]?.pos;
  const hi = list[at]?.pos;
  const k = nodes.length;
  const start = lo ?? (hi != null ? hi - k - 1 : 0);
  const step = ((hi ?? start + k + 1) - start) / (k + 1);
  nodes.forEach((n, i) => { n.pos = start + step * (i + 1); });
  list.splice(at, 0, ...nodes);
  // No room left between two neighbors (after many inserts in one spot): number the folder again.
  if (!nodes.every((n, i) => n.pos > (i ? nodes[i - 1].pos : lo ?? -Infinity) && n.pos < (hi ?? Infinity))) renumber(list);
}

// A node from outside (an undo, an import): only the fields Lumio keeps, with
// sane values. Returns null for anything that isn't a bookmark or folder.
function sanitize(n, depth = 0) {
  if (!n || typeof n !== 'object' || depth > 40) return null;
  const time = Number(n.time) > 0 ? Number(n.time) : Date.now();
  const id = typeof n.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(n.id) && !ROOT_IDS.has(n.id) ? n.id : newId();
  if (isFolder(n)) {
    const children = n.children.map((c) => sanitize(c, depth + 1)).filter(Boolean);
    renumber(children);
    return { id, title: cleanTitle(n.title) || 'Folder', time, children };
  }
  const url = cleanUrl(n.url);
  if (!url) return null;
  const favicon = typeof n.favicon === 'string' && /^(https?:|data:image\/)/.test(n.favicon) && n.favicon.length < 200_000 ? n.favicon : null;
  return { id, title: cleanTitle(n.title) || url, url, time, ...(favicon ? { favicon } : {}) };
}

function emptyRoots() {
  return Object.fromEntries(ROOTS.map(([id, title]) => [id, { id, title, time: Date.now(), children: [] }]));
}

class BookmarkTree {
  // file: a JsonFile (main/store.js) whose data is the tree, or null the
  // first time. legacy: the flat list from bookmarks.json, if there is one.
  constructor(file, { legacy = null } = {}) {
    this.file = file;
    this.cache = null;
    const fresh = !file.data || typeof file.data !== 'object' || !file.data.roots;
    if (fresh) file.data = { version: 2, roots: emptyRoots(), recent: [] };
    this.repair();
    if (fresh) {
      if (Array.isArray(legacy)) this.migrate(legacy);
      file.save(true);
    }
  }

  get data() { return this.file.data; }
  get roots() { return ROOTS.map(([id]) => this.data.roots[id]); }
  root(id) { return this.data.roots[id] || null; }

  // Fixes what a hand-edited or half-written file could get wrong: missing
  // roots, bad nodes, ids used twice, and positions out of order.
  repair() {
    const d = this.data;
    const seen = new Set(ROOT_IDS);
    const fix = (list, depth) => {
      const out = (Array.isArray(list) ? list : []).flatMap((n) => {
        if (!n || typeof n !== 'object' || depth > 40) return [];
        const c = sanitize(isFolder(n) ? { ...n, children: [] } : n);
        if (!c) return [];
        if (seen.has(c.id)) c.id = newId();
        seen.add(c.id);
        c.pos = Number(n.pos);
        if (isFolder(c)) c.children = fix(n.children, depth + 1);
        else if (n.legacy === true) c.legacy = true;
        return [c];
      });
      if (!out.every((n, i) => Number.isFinite(n.pos) && (!i || byPos(out[i - 1], n) < 0))) renumber(out);
      return out;
    };
    d.roots ||= {};
    for (const [id, title] of ROOTS) {
      const r = d.roots[id];
      d.roots[id] = { id, title, time: Number(r?.time) || Date.now(), children: fix(r?.children, 0) };
    }
    d.recent = (Array.isArray(d.recent) ? d.recent : []).filter((id) => typeof id === 'string');
    d.version = 2;
  }

  // The flat list from before folders goes on the Bookmarks bar.
  migrate(list) {
    const bar = this.data.roots.bar;
    const taken = new Set();
    for (const b of list) {
      const n = sanitize({ ...b, id: undefined });
      if (!n || isFolder(n)) continue;
      const id = urlId(n.url);
      if (!taken.has(id)) n.id = id;
      taken.add(n.id);
      insert(bar, null, [{ ...n, legacy: true }]);
    }
  }

  // Every change goes through here: the file saves soon and the indexes are rebuilt.
  changed(now = false) {
    this.cache = null;
    this.file.save(now);
  }

  // id -> { node, parent }, and address -> bookmarks with it (in tree order).
  index() {
    if (this.cache) return this.cache;
    const byId = new Map();
    const byUrl = new Map();
    const walk = (folder) => {
      for (const n of folder.children) {
        byId.set(n.id, { node: n, parent: folder });
        if (isFolder(n)) walk(n);
        else { const l = byUrl.get(n.url); if (l) l.push(n); else byUrl.set(n.url, [n]); }
      }
    };
    for (const r of this.roots) { byId.set(r.id, { node: r, parent: null }); walk(r); }
    this.cache = { byId, byUrl };
    return this.cache;
  }

  get(id) { return this.index().byId.get(id)?.node || null; }
  parentOf(id) { return this.index().byId.get(id)?.parent || null; }
  folder(id) { const n = this.get(id); return isFolder(n) ? n : null; }
  has(url) { return this.index().byUrl.has(url); }
  byUrl(url) { return this.index().byUrl.get(url) || []; }
  // Is `id` the folder `ancestor`, or inside it?
  within(id, ancestor) {
    for (let n = this.get(id); n; n = this.parentOf(n.id)) if (n.id === ancestor) return true;
    return false;
  }
  rootOf(id) {
    let n = this.get(id);
    while (n && this.parentOf(n.id)) n = this.parentOf(n.id);
    return n?.id || null;
  }

  // Every bookmark (not folders), in order: the bar, then Other, then Mobile.
  urls() {
    const out = [];
    const walk = (f) => { for (const n of f.children) { if (isFolder(n)) walk(n); else out.push(n); } };
    this.roots.forEach(walk);
    return out;
  }
  // Every folder, in order, with how deep it is (the roots are 0).
  folders() {
    const out = [];
    const walk = (f, depth) => { out.push({ id: f.id, title: f.title, depth }); for (const n of f.children) if (isFolder(n)) walk(n, depth + 1); };
    for (const r of this.roots) walk(r, 0);
    return out;
  }
  // The newest bookmarks first.
  recent(n = 12) { return this.urls().slice().sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, n); }

  // ---- changes
  add(parentId, index, { title, url, favicon, time } = {}) {
    const parent = this.folder(parentId);
    const node = parent && sanitize({ title, url, favicon, time });
    if (!node) return null;
    insert(parent, index, [node]);
    this.changed();
    return node;
  }
  addFolder(parentId, index, title, time) {
    const parent = this.folder(parentId);
    if (!parent) return null;
    const node = { id: newId(), title: cleanTitle(title) || 'New folder', time: Number(time) || Date.now(), children: [] };
    insert(parent, index, [node]);
    this.changed();
    return node;
  }
  // Rename (folders and bookmarks) or change the address (bookmarks, web
  // addresses only). Returns false if there's no such bookmark.
  update(id, { title, url } = {}) {
    const n = this.get(id);
    if (!n || ROOT_IDS.has(id)) return false;
    if (typeof title === 'string' && cleanTitle(title)) n.title = cleanTitle(title);
    if (!isFolder(n) && typeof url === 'string' && cleanUrl(url)) n.url = cleanUrl(url);
    delete n.legacy; // someone here cared about it: it syncs like any other
    this.changed();
    return true;
  }
  // Moves bookmarks and folders (keeping their order) into a folder, before
  // what's at `index` now. A folder can't go inside itself.
  move(ids, parentId, index) {
    const parent = this.folder(parentId);
    if (!parent) return false;
    const moving = new Set([...ids].filter((id) => !ROOT_IDS.has(id) && this.get(id) && !this.within(parentId, id)));
    // A folder and something inside it: moving the folder takes it along.
    const top = this.outermost(moving);
    if (!top.length) return false;
    let at = clamp(index ?? parent.children.length, parent.children.length);
    const nodes = top.map((id) => {
      const from = this.parentOf(id);
      const i = from.children.findIndex((c) => c.id === id);
      if (from === parent && i < at) at--;
      const [n] = from.children.splice(i, 1);
      delete n.legacy;
      return n;
    });
    insert(parent, at, nodes);
    this.changed();
    return true;
  }
  // Removes bookmarks and folders (with what's in them). Returns what's
  // needed to put them back (restore), in the order they were.
  remove(ids) {
    const top = this.outermost(new Set([...ids].filter((id) => !ROOT_IDS.has(id) && this.get(id))));
    const removed = top.map((id) => {
      const parent = this.parentOf(id);
      return { parentId: parent.id, index: parent.children.findIndex((c) => c.id === id), node: structuredClone(this.get(id)) };
    });
    if (!removed.length) return [];
    for (const r of removed) {
      const parent = this.folder(r.parentId);
      parent.children = parent.children.filter((c) => c.id !== r.node.id);
    }
    this.changed();
    return removed;
  }
  // Undo: puts removed bookmarks back where they were (or at the end of
  // Other bookmarks if their folder is gone too).
  restore(entries) {
    let count = 0;
    const list = (Array.isArray(entries) ? entries : []).slice(0, 5000);
    for (const e of list.slice().sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0))) {
      const node = sanitize(e?.node);
      if (!node) continue;
      // Never two of the same id: anything already back gets a new one.
      const ids = new Set(this.index().byId.keys());
      const reId = (n) => { if (ids.has(n.id)) n.id = newId(); ids.add(n.id); if (isFolder(n)) n.children.forEach(reId); };
      reId(node);
      const home = this.folder(e.parentId);
      insert(home || this.root('other'), home ? e.index : null, [node]);
      this.cache = null;
      count++;
    }
    if (count) this.changed();
    return count;
  }
  // Every bookmark of this address, wherever it is.
  removeUrl(url) {
    const nodes = this.byUrl(url);
    if (!nodes.length) return 0;
    this.remove(nodes.map((n) => n.id));
    return nodes.length;
  }
  // Sort a folder's contents by name; returns the old order (for undo).
  sort(folderId) {
    const f = this.folder(folderId);
    if (!f) return null;
    const before = f.children.map((c) => c.id);
    f.children.sort(byName);
    this.settle(f);
    return before;
  }
  // Put a folder's contents in this order (ids it doesn't have are skipped,
  // ones not listed stay at the end).
  reorder(folderId, ids) {
    const f = this.folder(folderId);
    if (!f || !Array.isArray(ids)) return false;
    const pos = new Map(ids.map((id, i) => [id, i]));
    f.children.sort((a, b) => (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity));
    this.settle(f);
    return true;
  }
  // A folder put in a new order: new positions, which sync.
  settle(f) {
    renumber(f.children);
    f.children.forEach((c) => delete c.legacy);
    this.changed();
  }

  // The folders the star's bubble offers first: the latest used first.
  useFolder(id) {
    if (!this.folder(id)) return;
    this.data.recent = [id, ...this.data.recent.filter((x) => x !== id)].slice(0, RECENT);
    this.file.save();
  }
  recentFolders() { return this.data.recent.filter((id) => this.folder(id)); }
  // Where a new bookmark goes: the folder used last, else the bar (like Chrome).
  lastFolder() { return this.recentFolders()[0] || 'bar'; }

  // A page's icon, learned when it's open: its bookmarks take it, and
  // bookmarks on the same site that have no icon yet take it too (imported
  // ones come without one). Returns whether anything changed.
  learnIcon(url, favicon) {
    const host = hostOf(url);
    let changed = false;
    for (const b of this.urls()) {
      const match = b.url === url ? b.favicon !== favicon : !b.favicon && host && hostOf(b.url) === host;
      if (match) { b.favicon = favicon; changed = true; }
    }
    if (changed) this.changed();
    return changed;
  }

  // ---- import and export
  // Adds bookmarks from another browser or a file. `tree` is
  // { bar, other, mobile } (lists of bookmarks and folders), or a flat list
  // for the bar. Addresses already bookmarked are skipped, and folders with
  // the same name in the same place are merged, so importing again adds
  // nothing. With `folder` (a name), bar bookmarks go in a folder of that name
  // on the bar unless the bar is still empty, like Chrome's "Imported from …".
  // Returns how many bookmarks were added.
  import(tree, { folder = null } = {}) {
    const src = Array.isArray(tree) ? { bar: tree } : tree || {};
    const have = new Set(this.index().byUrl.keys());
    const taken = new Set(this.index().byId.keys());
    const idFor = (parentId, what) => { const id = placeId(parentId, what); const ok = !taken.has(id); taken.add(id); return ok ? id : newId(); };
    let added = 0;
    // Into `into` (made now, or already in the tree): what's new from `list`.
    const merge = (into, list, depth = 0) => {
      for (const raw of Array.isArray(list) ? list : []) {
        if (depth > 40 || !raw || typeof raw !== 'object') continue;
        if (Array.isArray(raw.children)) {
          const title = cleanTitle(raw.title) || 'Folder';
          const f = into.children.find((c) => isFolder(c) && c.title === title) || { id: idFor(into.id, `folder\n${title}`), title, time: Number(raw.time) || Date.now(), children: [] };
          mergeInto(into, f, raw.children, depth + 1);
          continue;
        }
        const url = cleanUrl(raw.url);
        if (!url || have.has(url) || !/^https?:/i.test(url)) continue;
        have.add(url);
        insert(into, null, [{ id: idFor(into.id, url), title: cleanTitle(raw.title) || url, url, time: Number(raw.time) || Date.now() }]);
        added++;
      }
    };
    // A folder that's new goes in only if something was added to it.
    const mergeInto = (into, f, list, depth) => {
      const made = !into.children.includes(f);
      const before = added;
      merge(f, list, depth);
      if (made && added > before) insert(into, null, [f]);
    };
    const bar = this.data.roots.bar;
    if (folder && bar.children.length && src.bar?.length) {
      const name = cleanTitle(folder);
      mergeInto(bar, bar.children.find((c) => isFolder(c) && c.title === name) || { id: idFor('bar', `folder\n${name}`), title: name, time: Date.now(), children: [] }, src.bar, 1);
    } else {
      merge(bar, src.bar);
    }
    merge(this.data.roots.other, src.other);
    merge(this.data.roots.mobile, src.mobile);
    this.changed(true);
    return added;
  }

  // The "Netscape bookmark file" every browser imports, with folders, laid
  // out like Chrome's export: the bar as a toolbar folder, Other bookmarks at
  // the top level, Mobile bookmarks as a folder.
  toHtml() {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const secs = (t) => Math.round((t || Date.now()) / 1000);
    const lines = [];
    const items = (list, pad) => {
      for (const n of list) {
        if (isFolder(n)) folder(n, pad);
        else lines.push(`${pad}<DT><A HREF="${esc(n.url)}" ADD_DATE="${secs(n.time)}">${esc(n.title)}</A>`);
      }
    };
    const folder = (f, pad, attrs = '') => {
      lines.push(`${pad}<DT><H3 ADD_DATE="${secs(f.time)}"${attrs}>${esc(f.title)}</H3>`, `${pad}<DL><p>`);
      items(f.children, pad + '    ');
      lines.push(`${pad}</DL><p>`);
    };
    const { bar, other, mobile } = this.data.roots;
    folder(bar, '    ', ' PERSONAL_TOOLBAR_FOLDER="true"');
    items(other.children, '    ');
    if (mobile.children.length) folder(mobile, '    ');
    return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<!-- This is an automatically generated file.\n     It will be read and overwritten.\n     DO NOT EDIT! -->\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${lines.join('\n')}\n</DL><p>\n`;
  }

  // Of a set of ids, the ones not inside another one of them, in tree order.
  outermost(set) {
    const out = [];
    const walk = (f) => { for (const n of f.children) { if (set.has(n.id)) out.push(n.id); else if (isFolder(n)) walk(n); } };
    this.roots.forEach(walk);
    return out;
  }

  // ---- Lumio Sync: the tree, one record per bookmark or folder (key: its
  // id), apart from `legacy` ones (see the top).
  syncedTree() {
    const out = [];
    const walk = (f) => f.children.forEach((n) => {
      if (isFolder(n)) { out.push([n.id, { parent: f.id, pos: n.pos, title: n.title, time: n.time, folder: true }]); walk(n); } else if (!n.legacy) out.push([n.id, { parent: f.id, pos: n.pos, title: n.title, url: n.url, time: n.time }]);
    });
    this.roots.forEach(walk);
    return out;
  }

  // Other devices' changes to the tree: [{ key: id, record | null }].
  // Returns the keys it couldn't use (the engine deletes those everywhere).
  applySyncedTree(changes) {
    const rejected = [];
    const touched = new Set(); // folders to put in order
    const upserts = changes.filter((c) => c.record);
    // Folders first, parents before what's in them; then bookmarks.
    let folders = upserts.filter((c) => c.record.folder);
    for (let guard = 0; folders.length && guard < 50; guard++) {
      const next = folders.filter((c) => !this.applyNode(c.key, c.record, touched, rejected, false));
      if (next.length === folders.length) break;
      folders = next;
    }
    for (const c of folders) this.applyNode(c.key, c.record, touched, rejected, true); // parent never came: Other bookmarks
    for (const c of upserts.filter((x) => !x.record.folder)) this.applyNode(c.key, c.record, touched, rejected, true);
    // Deleted elsewhere. What's inside a deleted folder and wasn't deleted
    // too (it changed here meanwhile) moves up instead of being lost.
    const deleted = new Set(changes.filter((x) => !x.record).map((x) => x.key));
    const survivors = (n) => (isFolder(n) ? n.children.flatMap((x) => (deleted.has(x.id) ? survivors(x) : [x])) : []);
    for (const key of deleted) {
      if (ROOT_IDS.has(key)) continue;
      const n = this.get(key);
      if (!n) continue;
      const parent = this.parentOf(key);
      parent.children.splice(parent.children.indexOf(n), 1, ...survivors(n));
      this.cache = null;
      touched.add(parent.id);
    }
    for (const id of touched) this.folder(id)?.children.sort(byPos);
    this.changed();
    return rejected;
  }

  // One synced bookmark or folder. Returns false if its folder isn't here
  // yet (and `orphan` is false); with `orphan`, it goes in Other bookmarks.
  applyNode(id, r, touched, rejected, orphan) {
    if (ROOT_IDS.has(id)) { rejected.push(id); return true; }
    const folder = !!r.folder;
    const url = folder ? '' : cleanUrl(r.url);
    if (!folder && !url) { rejected.push(id); return true; }
    let parent = this.folder(r.parent);
    if (!parent) { if (!orphan) return false; parent = this.root('other'); }
    const title = cleanTitle(r.title) || (folder ? 'Folder' : url);
    let n = this.get(id);
    if (n && isFolder(n) !== folder) { rejected.push(id); return true; }
    if (!n) {
      // A copy made here from the flat list (see the top): this replaces it.
      if (!folder) this.removeUrlQuietly(url, { legacyOnly: true });
      n = folder ? { id, title, time: Number(r.time) || Date.now(), children: [] } : { id, title, url, time: Number(r.time) || Date.now() };
      parent.children.push(n);
    } else {
      n.title = title;
      if (!folder) n.url = url;
      if (Number(r.time) > 0) n.time = Number(r.time);
      delete n.legacy;
      const from = this.parentOf(n.id);
      // A folder can't move into itself (two devices moving folders into each other).
      if (from !== parent && !(folder && this.within(parent.id, n.id))) {
        from.children.splice(from.children.indexOf(n), 1);
        parent.children.push(n);
      }
    }
    this.cache = null;
    const at = this.parentOf(n.id);
    n.pos = Number.isFinite(Number(r.pos)) && r.pos !== null ? Number(r.pos) : Math.max(0, ...at.children.filter((c) => c !== n).map((c) => c.pos)) + 1;
    touched.add(at.id);
    return true;
  }

  // ---- Lumio Sync: the flat list older versions understand (key: the
  // address; the first bookmark of each address, in tree order).
  legacyEntries() {
    const seen = new Set();
    const out = [];
    for (const b of this.urls()) {
      if (seen.has(b.url)) continue;
      seen.add(b.url);
      out.push([b.url, { url: b.url, title: b.title, time: b.time, pos: out.length }]);
    }
    return out;
  }

  // Changes to the flat list (from older devices, and the copy newer ones
  // keep for them). The tree decides where things are, so this only renames,
  // removes an address everywhere, or adds an address that isn't here at all,
  // near where it was in that list.
  applyLegacy(changes) {
    for (const c of changes.slice().sort((a, b) => (Number(a.record?.pos) || 0) - (Number(b.record?.pos) || 0))) {
      if (!c.record) { this.removeUrlQuietly(c.key); continue; }
      const url = cleanUrl(c.record.url);
      if (!url || url !== c.key) continue;
      const title = cleanTitle(c.record.title) || url;
      const have = this.byUrl(url);
      if (have.length) { have[0].title = title; continue; }
      const flat = this.urls();
      const next = flat[clamp(c.record.pos, flat.length)];
      const parent = next && this.rootOf(next.id) === 'bar' ? this.parentOf(next.id) : this.root('bar');
      const at = next && parent === this.parentOf(next.id) ? parent.children.indexOf(next) : null;
      const id = this.get(urlId(url)) ? newId() : urlId(url);
      insert(parent, at, [{ id, title, url, time: Number(c.record.time) || Date.now(), legacy: true }]);
      this.cache = null;
    }
    this.changed();
  }
  // Removes bookmarks of an address without saving (part of a bigger change):
  // all of them, or only the copies made from the flat list.
  removeUrlQuietly(url, { legacyOnly = false } = {}) {
    for (const n of this.byUrl(url)) {
      if (legacyOnly && !n.legacy) continue;
      const p = this.parentOf(n.id);
      p.children.splice(p.children.indexOf(n), 1);
      this.cache = null;
    }
  }
}

module.exports = { BookmarkTree, ROOTS, ROOT_IDS, isFolder, urlId, sanitize, cleanUrl };
