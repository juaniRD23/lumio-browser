// Bookmarks as a tree (main/bookmarks.js): the three main folders, moving
// and removing with undo, sorting, importing with folders, the Netscape
// file both ways, and both sides of Lumio Sync (the tree, and the flat list
// older versions of Lumio use).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BookmarkTree, urlId, ROOTS } = require('../main/bookmarks.js');
const { parseBookmarksHtml } = require('../main/importer/files.js');

// A stand-in for the JsonFile the store gives it.
function memFile(data = null) {
  return { data, saves: 0, save() { this.saves++; }, flush() {} };
}
const tree = (legacy) => new BookmarkTree(memFile(), { legacy });
const titles = (folder) => folder.children.map((n) => n.title);
// A folder's contents as nested titles: ['A', ['Folder', ['B']]].
const shape = (folder) => folder.children.map((n) => (n.children ? [n.title, shape(n)] : n.title));

test('three main folders; the old flat list becomes the Bookmarks bar, in order, with icons', () => {
  const t = tree([
    { url: 'https://a.example/', title: 'A', time: 5, favicon: 'data:image/png;base64,AAAA' },
    { url: 'https://b.example/', title: 'B', time: 6 },
    { url: 'https://a.example/', title: 'A again', time: 7 },
    { url: 'javascript:alert(1)', title: 'Nope' },
  ]);
  assert.deepEqual(t.roots.map((r) => [r.id, r.title]), ROOTS);
  assert.deepEqual(titles(t.root('bar')), ['A', 'B', 'A again']);
  const [a, b, again] = t.root('bar').children;
  assert.equal(a.favicon, 'data:image/png;base64,AAAA');
  assert.equal(a.time, 5);
  // Ids come from the address, so every device migrating the same list agrees.
  assert.equal(a.id, urlId('https://a.example/'));
  assert.equal(b.id, urlId('https://b.example/'));
  assert.notEqual(again.id, a.id, 'a second bookmark of the same page gets its own id');
  assert.deepEqual(t.root('other').children, []);
});

test('a damaged file is repaired: missing folders, bad entries and repeated ids', () => {
  const file = memFile({ roots: { bar: { children: [
    { id: 'x1', title: 'Good', url: 'https://good.example/' },
    { id: 'x1', title: 'Same id', url: 'https://same.example/' },
    { title: 'No address' },
    { id: 'f1', title: 'Folder', children: [{ id: 'bad id!', title: 'Inside', url: 'https://in.example/' }, 'junk'] },
  ] } } });
  const t = new BookmarkTree(file);
  assert.deepEqual(shape(t.root('bar')), ['Good', 'Same id', ['Folder', ['Inside']]]);
  const ids = t.urls().map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(t.root('other') && t.root('mobile'));
});

test('add, folders, rename, edit the address, move (not into itself), and the index stays right', () => {
  const t = tree();
  const a = t.add('bar', null, { url: 'https://a.example/', title: 'A' });
  const work = t.addFolder('bar', null, 'Work');
  const b = t.add(work.id, null, { url: 'https://b.example/', title: 'B' });
  const deep = t.addFolder(work.id, 0, 'Deep');
  assert.deepEqual(shape(t.root('bar')), ['A', ['Work', [['Deep', []], 'B']]]);
  assert.equal(t.add('bar', null, { url: 'javascript:alert(1)' }), null, 'only web addresses');
  assert.equal(t.add('bar', null, { url: 'https://' }), null, 'that parse');
  assert.equal(t.add('nope', null, { url: 'https://x.example/' }), null);

  assert.equal(t.update(b.id, { title: '  Bee  ', url: 'https://bee.example/' }), true);
  assert.equal(t.get(b.id).title, 'Bee');
  t.update(b.id, { url: 'javascript:alert(1)', title: '' });
  assert.equal(t.get(b.id).url, 'https://bee.example/', 'a bad address or an empty name keeps the old one');
  assert.equal(t.get(b.id).title, 'Bee');
  assert.equal(t.update('bar', { title: 'Mine' }), false, 'the main folders keep their names');
  assert.ok(t.has('https://bee.example/') && !t.has('https://b.example/'));

  // A folder can't go inside itself or one of its folders.
  assert.equal(t.move([work.id], deep.id, 0), false);
  assert.equal(t.move([work.id], work.id, 0), false);
  // Moving a folder with something inside it moves the folder (with it).
  assert.equal(t.move([b.id, work.id], 'other', null), true);
  assert.deepEqual(shape(t.root('bar')), ['A']);
  assert.deepEqual(shape(t.root('other')), [['Work', [['Deep', []], 'Bee']]]);
  assert.equal(t.parentOf(b.id).id, work.id);
  assert.equal(t.rootOf(b.id), 'other');
  assert.equal(t.within(b.id, work.id), true);

  // Reorder inside a folder: the index counts what's there now.
  const c = t.add('bar', null, { url: 'https://c.example/', title: 'C' });
  const d = t.add('bar', null, { url: 'https://d.example/', title: 'D' });
  t.move([a.id], 'bar', 3);
  assert.deepEqual(titles(t.root('bar')), ['C', 'D', 'A']);
  t.move([d.id, a.id], 'bar', 0);
  assert.deepEqual(titles(t.root('bar')), ['D', 'A', 'C']);
  t.move([c.id], 'bar', 1);
  assert.deepEqual(titles(t.root('bar')), ['D', 'C', 'A']);
  assert.deepEqual(t.folders().map((f) => [f.title, f.depth]), [['Bookmarks bar', 0], ['Other bookmarks', 0], ['Work', 1], ['Deep', 2], ['Mobile bookmarks', 0]]);
});

test('remove and undo put everything back where it was, folders with their contents', () => {
  const t = tree();
  const [a, b, c] = ['a', 'b', 'c'].map((x) => t.add('bar', null, { url: `https://${x}.example/`, title: x.toUpperCase() }));
  const f = t.addFolder('other', null, 'Folder');
  t.add(f.id, null, { url: 'https://in.example/', title: 'In' });
  const before = JSON.stringify(t.data.roots);
  const removed = t.remove([a.id, c.id, f.id, f.children[0].id]);
  assert.equal(removed.length, 3, 'what\'s inside a removed folder goes with it');
  assert.deepEqual(titles(t.root('bar')), ['B']);
  assert.equal(t.has('https://in.example/'), false);
  // Through IPC, as the manager page sends it back.
  assert.equal(t.restore(structuredClone(removed)), 3);
  assert.equal(JSON.stringify(t.data.roots), before);
  assert.ok(t.get(b.id));
  // Restoring twice never makes two of the same id.
  t.restore(structuredClone(removed));
  const ids = [...t.index().byId.keys()];
  assert.equal(new Set(ids).size, ids.length);
  // A bookmark whose folder is gone too lands in Other bookmarks.
  const lost = t.remove([t.root('bar').children[0].id]);
  lost[0].parentId = 'gone';
  t.restore(lost);
  assert.equal(t.root('other').children.at(-1).title, 'A');
  // removeUrl removes every bookmark of the page.
  assert.equal(t.removeUrl('https://a.example/'), 2);
  assert.equal(t.has('https://a.example/'), false);
});

test('sort by name (folders first) and undo it; the star bubble remembers folders used lately', () => {
  const t = tree();
  for (const name of ['beta', 'Alpha', 'item 10', 'item 9']) t.add('bar', null, { url: `https://${name.replace(' ', '')}.example/`, title: name });
  const z = t.addFolder('bar', null, 'Zed');
  const before = t.sort('bar');
  assert.deepEqual(titles(t.root('bar')), ['Zed', 'Alpha', 'beta', 'item 9', 'item 10']);
  t.reorder('bar', before);
  assert.deepEqual(titles(t.root('bar')), ['beta', 'Alpha', 'item 10', 'item 9', 'Zed']);
  assert.equal(t.lastFolder(), 'bar');
  t.useFolder(z.id);
  t.useFolder('other');
  t.useFolder('nope');
  assert.deepEqual(t.recentFolders(), ['other', z.id]);
  t.remove([z.id]);
  assert.deepEqual(t.recentFolders(), ['other']);
  assert.equal(t.lastFolder(), 'other');
});

test('import keeps folders, skips what\'s already here, and merges folders of the same name', () => {
  const t = tree();
  t.add('bar', null, { url: 'https://have.example/', title: 'Have' });
  const src = {
    bar: [{ url: 'https://have.example/', title: 'dup' }, { title: 'Work', children: [{ url: 'https://jira.example/', title: 'Jira' }, { title: 'Empty', children: [] }] }],
    other: [{ url: 'https://other.example/', title: 'Other' }, { url: 'ftp://no.example/', title: 'no' }],
    mobile: [{ url: 'https://phone.example/', title: 'Phone' }],
  };
  assert.equal(t.import(src, { folder: 'Imported from Chrome' }), 3);
  // The bar had bookmarks, so the bar's go in a folder on it, like Chrome's.
  assert.deepEqual(shape(t.root('bar')), ['Have', ['Imported from Chrome', [['Work', ['Jira']]]]]);
  assert.deepEqual(shape(t.root('other')), ['Other']);
  assert.deepEqual(shape(t.root('mobile')), ['Phone']);
  assert.equal(t.import(src, { folder: 'Imported from Chrome' }), 0, 'importing again adds nothing');
  assert.equal(t.root('bar').children.length, 2);
  // Into an empty bar: straight on the bar.
  const fresh = tree();
  fresh.import(src, { folder: 'Imported from Chrome' });
  assert.deepEqual(shape(fresh.root('bar')), ['dup', ['Work', ['Jira']]]);
});

test('the Netscape file: folders out and back in, with the bar, Other and Mobile bookmarks', () => {
  const t = tree();
  t.add('bar', null, { url: 'https://a.example/?x=1&y="2"', title: 'A <&>', time: 1700000000000 });
  const f = t.addFolder('bar', null, 'Work & play');
  t.add(f.id, null, { url: 'https://b.example/', title: 'B' });
  t.addFolder(f.id, null, 'Inner');
  t.add('other', null, { url: 'https://c.example/', title: 'C' });
  const o = t.addFolder('other', null, 'Recipes');
  t.add(o.id, null, { url: 'https://soup.example/', title: 'Soup' });
  t.add('mobile', null, { url: 'https://phone.example/', title: 'Phone' });
  const html = t.toHtml();
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /<H3 ADD_DATE="\d+" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar<\/H3>/);
  assert.match(html, /HREF="https:\/\/a\.example\/\?x=1&amp;y=&quot;2&quot;" ADD_DATE="1700000000">A &lt;&amp;&gt;<\/A>/);
  const back = parseBookmarksHtml(html);
  const plain = (list) => list.map((n) => (n.children ? [n.title, plain(n.children)] : [n.title, n.url]));
  assert.deepEqual(plain(back.bar), [['A <&>', 'https://a.example/?x=1&y="2"'], ['Work & play', [['B', 'https://b.example/'], ['Inner', []]]]]);
  assert.deepEqual(plain(back.other), [['C', 'https://c.example/'], ['Recipes', [['Soup', 'https://soup.example/']]]]);
  assert.deepEqual(plain(back.mobile), [['Phone', 'https://phone.example/']]);
  const copy = tree();
  assert.equal(copy.import(back), 5);
  assert.deepEqual(shape(copy.root('bar')), shape(t.root('bar')).map((x) => (Array.isArray(x) ? [x[0], ['B']] : x)), 'empty folders aren\'t imported');
});

test('icons: a page\'s icon goes to its bookmarks, and to ones on the same site without an icon', () => {
  const t = tree();
  t.add('bar', null, { url: 'https://www.site.example/a', title: 'A' });
  const f = t.addFolder('other', null, 'F');
  t.add(f.id, null, { url: 'https://site.example/b', title: 'B', favicon: 'https://site.example/own.png' });
  assert.equal(t.learnIcon('https://site.example/', 'https://site.example/i.png'), true);
  assert.deepEqual(t.urls().map((b) => b.favicon), ['https://site.example/i.png', 'https://site.example/own.png']);
  assert.equal(t.learnIcon('https://site.example/', 'https://site.example/i.png'), false);
});

// ---------------------------------------------------------------- Lumio Sync
// Two devices' trees, kept in step the way the sync engine does it: each
// side's records (key -> record), and the changes between two snapshots.
const records = (t) => new Map(t.syncedTree().map(([k, r]) => [k, JSON.stringify(r)]));
function changes(before, after) {
  const out = [];
  for (const [k, r] of after) if (before.get(k) !== r) out.push({ key: k, record: JSON.parse(r) });
  for (const k of before.keys()) if (!after.has(k)) out.push({ key: k, record: null });
  return out;
}

test('sync: the tree goes across, folders and order included, and edits and deletes follow', () => {
  const a = tree();
  const b = tree();
  const work = a.addFolder('bar', null, 'Work');
  const deep = a.addFolder(work.id, null, 'Deep');
  a.add(deep.id, null, { url: 'https://deep.example/', title: 'Deep page' });
  a.add('bar', 0, { url: 'https://first.example/', title: 'First' });
  a.add(work.id, 0, { url: 'https://jira.example/', title: 'Jira' });
  const snapA = records(a);
  // Children before parents in the list: the order records arrive in is up to the server.
  b.applySyncedTree(changes(new Map(), snapA).reverse());
  assert.deepEqual(shape(b.root('bar')), shape(a.root('bar')));
  assert.deepEqual(records(b), snapA);

  // A renames, moves and deletes; B gets just those changes.
  const before = records(a);
  a.update(work.id, { title: 'Job' });
  a.move([a.byUrl('https://first.example/')[0].id], deep.id, 0);
  a.remove([a.byUrl('https://jira.example/')[0].id]);
  b.applySyncedTree(changes(before, records(a)));
  assert.deepEqual(shape(b.root('bar')), [['Job', [['Deep', ['First', 'Deep page']]]]]);

  // A folder deleted on A while B added something in it: that moves up instead of being lost.
  const snap = records(a);
  b.add(deep.id, null, { url: 'https://new-on-b.example/', title: 'New on B' });
  a.remove([deep.id]);
  b.applySyncedTree(changes(snap, records(a)));
  assert.deepEqual(shape(b.root('bar')), [['Job', ['New on B']]]);
});

// A small stand-in for the sync engine (main/sync/engine.js) and its
// server: each device sends what changed since it last synced and takes
// others' changes unless it changed the same record meanwhile.
function syncLoop(...trees) {
  const server = new Map(); // key -> { r (JSON or null), seq, from }
  let seq = 0;
  const dev = trees.map(() => ({ last: new Map(), cursor: 0 }));
  const pull = (i) => {
    const t = trees[i];
    const d = dev[i];
    const local = records(t);
    const take = [...server.entries()].filter(([k, v]) => v.seq > d.cursor && v.from !== i
      && (v.r !== null || d.last.has(k)) // a delete of something it never had
      && (!local.has(k) || !d.last.has(k) || local.get(k) === d.last.get(k)));
    t.applySyncedTree(take.map(([k, v]) => ({ key: k, record: v.r && JSON.parse(v.r) })));
    for (const [k, v] of take) { if (v.r === null) d.last.delete(k); else d.last.set(k, v.r); }
    d.cursor = seq;
  };
  const push = (i) => {
    const d = dev[i];
    const now = records(trees[i]);
    for (const [k, r] of now) if (d.last.get(k) !== r) { server.set(k, { r, seq: ++seq, from: i }); d.last.set(k, r); }
    for (const k of [...d.last.keys()]) if (!now.has(k)) { server.set(k, { r: null, seq: ++seq, from: i }); d.last.delete(k); }
  };
  // Rounds of: everyone pulls, then everyone pushes (so both send before
  // seeing the other's), until nothing changes.
  const settle = () => {
    for (let n = 0; n < 10; n++) {
      const at = seq;
      trees.forEach((_, i) => pull(i));
      trees.forEach((_, i) => push(i));
      if (seq === at) return n;
    }
    throw new Error('never settled');
  };
  return { pull, push, settle };
}

test('sync: importing the same file on two computers makes the same bookmarks, not two of each', () => {
  const a = tree();
  const b = tree();
  const file = { bar: [{ title: 'Work', children: [{ url: 'https://jira.example/', title: 'Jira', time: 5 }] }, { url: 'https://news.example/', title: 'News', time: 6 }] };
  a.import(file);
  b.import(file);
  b.add('other', null, { url: 'https://only-b.example/', title: 'Only B' });
  assert.deepEqual(records(a), new Map([...records(b)].filter(([, r]) => !r.includes('only-b'))));
  syncLoop(a, b).settle();
  assert.deepEqual(records(a), records(b));
  assert.deepEqual(shape(a.root('bar')), [['Work', ['Jira']], 'News']);
  assert.deepEqual(shape(a.root('other')), ['Only B']);
});

test('sync: two computers that had the flat list end up with one tree, without doubles', () => {
  const flat = ['a', 'b', 'c'].map((x, i) => ({ url: `https://${x}.example/`, title: x.toUpperCase(), time: i + 1 }));
  // A moved to this version first: it put B in a folder and bookmarked D.
  const a = tree(flat);
  const f = a.addFolder('bar', null, 'Folder');
  a.move([a.byUrl('https://b.example/')[0].id], f.id, null);
  a.add('bar', null, { url: 'https://d.example/', title: 'D', time: 4 });
  // B, still on an older version, got D as part of the flat list; then it moved to this one.
  const b = tree([...flat, { url: 'https://d.example/', title: 'D', time: 4 }]);
  syncLoop(a, b).settle();
  assert.deepEqual(records(a), records(b));
  for (const t of [a, b]) {
    assert.deepEqual(shape(t.root('bar')), ['A', 'C', ['Folder', ['B']], 'D']);
    assert.equal(t.urls().length, 4);
  }
});

test('sync: the order settles on both devices, even when both add in the same spot at once', () => {
  const a = tree();
  const b = tree();
  const loop = syncLoop(a, b);
  a.add('bar', null, { url: 'https://first.example/', title: 'First' });
  a.add('bar', null, { url: 'https://last.example/', title: 'Last' });
  loop.settle();
  // Both add between First and Last before syncing.
  a.add('bar', 1, { url: 'https://from-a.example/', title: 'From A' });
  b.add('bar', 1, { url: 'https://from-b.example/', title: 'From B' });
  b.add('bar', 0, { url: 'https://top.example/', title: 'Top' });
  assert.equal(loop.settle() <= 2, true, 'settles quickly, without going back and forth');
  assert.deepEqual(records(a), records(b));
  assert.deepEqual(shape(a.root('bar')), shape(b.root('bar')));
  assert.deepEqual(shape(a.root('bar')).filter((x) => !x.startsWith('From')), ['Top', 'First', 'Last']);
});

test('sync: moves, renames and deletes on two devices at once all land, and nothing is lost', () => {
  const a = tree();
  const b = tree();
  const loop = syncLoop(a, b);
  const work = a.addFolder('bar', null, 'Work');
  const home = a.addFolder('bar', null, 'Home');
  for (const x of ['one', 'two', 'three']) a.add(work.id, null, { url: `https://${x}.example/`, title: x });
  loop.settle();
  assert.deepEqual(records(a), records(b));
  // A moves "one" home and renames Work; B deletes "two" and adds "four" to Work.
  a.move([a.byUrl('https://one.example/')[0].id], home.id, null);
  a.update(work.id, { title: 'Job' });
  b.remove([b.byUrl('https://two.example/')[0].id]);
  b.add(work.id, 0, { url: 'https://four.example/', title: 'four' });
  loop.settle();
  assert.deepEqual(records(a), records(b));
  assert.deepEqual(shape(a.root('bar')), [['Job', ['four', 'three']], ['Home', ['one']]]);
  // Each moves a folder into the other at the same time: one of them wins, neither disappears.
  a.move([work.id], home.id, null);
  b.move([home.id], work.id, null);
  loop.settle();
  assert.deepEqual(records(a), records(b));
  assert.ok(a.get(work.id) && a.get(home.id));
  assert.equal(a.urls().length, 3);
});

test('sync: a bookmark in a folder that never arrived goes to Other bookmarks; bad records are refused', () => {
  const t = tree();
  const rejected = t.applySyncedTree([
    { key: 'k1', record: { parent: 'missing-folder', pos: 0, title: 'Orphan', url: 'https://orphan.example/' } },
    { key: 'k2', record: { parent: 'bar', pos: 0, title: 'Bad', url: 'javascript:alert(1)' } },
    { key: 'bar', record: { parent: 'other', pos: 0, title: 'Root?', folder: true } },
    { key: 'f1', record: { parent: 'f2', pos: 0, title: 'Loop 1', folder: true } },
    { key: 'f2', record: { parent: 'f1', pos: 0, title: 'Loop 2', folder: true } },
  ]);
  assert.deepEqual(rejected.sort(), ['bar', 'k2']);
  assert.equal(t.parentOf('k1').id, 'other');
  // Two folders inside each other can't both be: one stays in Other bookmarks.
  assert.ok(['f1', 'f2'].some((id) => t.parentOf(id).id === 'other'));
  assert.equal(t.root('bar').children.length, 0);
});

test('sync with older Lumio: the flat list still syncs, and its changes apply sanely', () => {
  const t = tree();
  const work = t.addFolder('bar', null, 'Work');
  t.add('bar', null, { url: 'https://a.example/', title: 'A', time: 1 });
  t.add(work.id, null, { url: 'https://b.example/', title: 'B', time: 2 });
  t.add('other', null, { url: 'https://a.example/', title: 'A copy', time: 3 });
  // What older devices see: each address once, in order.
  assert.deepEqual(t.legacyEntries(), [
    ['https://b.example/', { url: 'https://b.example/', title: 'B', time: 2, pos: 0 }],
    ['https://a.example/', { url: 'https://a.example/', title: 'A', time: 1, pos: 1 }],
  ]);
  // An older device renames B, adds C and deletes A.
  t.applyLegacy([
    { key: 'https://b.example/', record: { url: 'https://b.example/', title: 'B renamed', time: 2, pos: 0 } },
    { key: 'https://c.example/', record: { url: 'https://c.example/', title: 'C', time: 4, pos: 2 } },
    { key: 'https://a.example/', record: null },
    { key: 'https://evil.example/', record: { url: 'https://other.example/', title: 'key and address differ' } },
  ]);
  assert.deepEqual(shape(t.root('bar')), [['Work', ['B renamed']], 'C']);
  assert.deepEqual(shape(t.root('other')), [], 'deleted everywhere it was');
  assert.equal(t.has('https://other.example/'), false);
  // Bookmarks only an older device has stay out of the tree's records (every
  // newer device makes the same one) until someone here changes them.
  const c = t.byUrl('https://c.example/')[0];
  assert.equal(c.legacy, true);
  assert.equal(c.id, urlId('https://c.example/'));
  assert.ok(!records(t).has(c.id));
  t.update(c.id, { title: 'C mine' });
  assert.ok(records(t).has(c.id));
});

test('sync with older Lumio: a newer device\'s record replaces the copy made from the flat list', () => {
  const t = tree();
  t.applyLegacy([{ key: 'https://x.example/', record: { url: 'https://x.example/', title: 'X', time: 1, pos: 0 } }]);
  const f = 'folder1';
  t.applySyncedTree([
    { key: f, record: { parent: 'other', pos: 0, title: 'Saved', folder: true } },
    { key: 'bnew', record: { parent: f, pos: 0, title: 'X in a folder', url: 'https://x.example/' } },
  ]);
  assert.equal(t.byUrl('https://x.example/').length, 1);
  assert.deepEqual(shape(t.root('other')), [['Saved', ['X in a folder']]]);
  assert.deepEqual(shape(t.root('bar')), []);
});
