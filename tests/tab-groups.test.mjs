// Tab groups (main/tab-groups.js), saved groups (main/saved-groups.js) and
// the reading list (main/reading-list.js), without Electron: a stand-in tab
// manager holds the tabs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TabGroups, COLORS } = require('../main/tab-groups.js');
const { SavedGroups } = require('../main/saved-groups.js');
const { ReadingList, idFor } = require('../main/reading-list.js');

// Enough of a TabManager for groups: tabs in strip order, the active one,
// activate(), create() (at an index) and changed().
function manager(n = 6, { pinned = 0 } = {}) {
  let next = 1;
  const m = {
    tabs: [],
    activeId: null,
    changes: 0,
    get active() { return m.tabs.find((t) => t.id === m.activeId) || null; },
    activate(id) { m.activeId = id; m.groups.onActivate(m.tabs.find((t) => t.id === id)); },
    create(url = 'lumio://newtab/', { index } = {}) { const t = { id: next++, url, pinned: false, groupId: null }; m.tabs.splice(index ?? m.tabs.length, 0, t); m.activeId = t.id; return t; },
    changed() { m.changes++; },
  };
  for (let i = 0; i < n; i++) m.tabs.push({ id: next++, url: `https://t${i + 1}.example/`, pinned: i < pinned, groupId: null });
  m.activeId = m.tabs[0]?.id ?? null;
  m.groups = new TabGroups(m);
  return m;
}
const ids = (m) => m.tabs.map((t) => t.id);
const groupsOf = (m) => m.tabs.map((t) => t.groupId);

test('a new group gathers its tabs next to the first one, with the next free color', () => {
  const m = manager(6);
  const g = m.groups.create([2, 5], { title: '  Trip\n' });
  assert.equal(g.title, 'Trip');
  assert.equal(g.color, 'grey', 'Chrome’s first color');
  assert.deepEqual(ids(m), [1, 2, 5, 3, 4, 6]);
  assert.deepEqual(groupsOf(m), [null, g.id, g.id, null, null, null]);
  const h = m.groups.create([6]);
  assert.equal(h.color, 'blue', 'the next color no group uses');
  assert.equal(COLORS.length, 9);
  assert.ok(m.changes > 0);
});

test('pinned tabs never join a group, and pinning one takes it out', () => {
  const m = manager(4, { pinned: 1 });
  assert.equal(m.groups.create([1]), null);
  const g = m.groups.create([1, 2, 3]);
  assert.deepEqual(m.groups.tabsOf(g.id).map((t) => t.id), [2, 3]);
  m.tabs[1].pinned = true;
  m.groups.normalize();
  assert.deepEqual(m.groups.tabsOf(g.id).map((t) => t.id), [3]);
});

test('add puts tabs at the group’s end; remove takes a middle tab out to just after the group', () => {
  const m = manager(6);
  const g = m.groups.create([2, 3, 4]);
  m.groups.add([6], g.id);
  assert.deepEqual(ids(m), [1, 2, 3, 4, 6, 5]);
  m.groups.remove([3]);
  assert.deepEqual(ids(m), [1, 2, 4, 6, 3, 5]);
  assert.deepEqual(groupsOf(m), [null, g.id, g.id, g.id, null, null]);
  // The last tab out: the group is gone after the next update.
  m.groups.remove([2, 4, 6]);
  m.groups.normalize();
  assert.equal(m.groups.get(g.id), null);
});

test('collapsing the group you’re in moves you to the nearest tab outside it, or a new tab', () => {
  const m = manager(4);
  const g = m.groups.create([2, 3]);
  m.activate(3);
  m.groups.update(g.id, { collapsed: true });
  assert.equal(m.activeId, 4, 'the tab after the group');
  // Going to a tab in a collapsed group opens it.
  m.activate(2);
  assert.equal(m.groups.get(g.id).collapsed, false);
  // Every tab in the group: a new tab after it.
  const solo = manager(2);
  const all = solo.groups.create([1, 2]);
  solo.groups.update(all.id, { collapsed: true });
  assert.equal(solo.tabs.length, 3);
  assert.equal(solo.activeId, solo.tabs[2].id);
  assert.equal(solo.tabs[2].groupId, null);
});

test('update keeps the name short and the color one of the nine', () => {
  const m = manager(2);
  const g = m.groups.create([1]);
  m.groups.update(g.id, { title: 'x'.repeat(500), color: 'magenta' });
  assert.equal(g.title.length, 100);
  assert.equal(g.color, 'grey');
  m.groups.update(g.id, { color: 'cyan' });
  assert.equal(g.color, 'cyan');
});

test('moving a whole group: before a tab, to the end, never into pinned tabs or another group', () => {
  const m = manager(7, { pinned: 1 });
  const a = m.groups.create([2, 3]);
  const b = m.groups.create([5, 6]);
  m.groups.move(a.id, null);
  assert.deepEqual(ids(m), [1, 4, 5, 6, 7, 2, 3]);
  m.groups.move(a.id, 1); // before the pinned tab: after it instead
  assert.deepEqual(ids(m), [1, 2, 3, 4, 5, 6, 7]);
  m.groups.move(a.id, 6); // inside group b: before it
  assert.deepEqual(ids(m), [1, 4, 2, 3, 5, 6, 7]);
  assert.deepEqual(m.groups.tabsOf(b.id).map((t) => t.id), [5, 6]);
});

test('a tab dragged inside a group joins it; dragged away from it, it leaves', () => {
  const m = manager(5);
  const g = m.groups.create([2, 3, 4]);
  // Tab 5 dropped between 2 and 3.
  const five = m.tabs.splice(4, 1)[0];
  m.tabs.splice(2, 0, five);
  m.groups.afterMove(five);
  assert.equal(five.groupId, g.id);
  // Tab 2 dropped at the start, next to no group tab: it leaves.
  const two = m.tabs.splice(1, 1)[0];
  m.tabs.splice(0, 0, two);
  m.groups.afterMove(two);
  assert.equal(two.groupId, null);
  // The group's last tab moved one step right, past nothing: still at the edge, it stays.
  const m2 = manager(3);
  const h = m2.groups.create([1, 2]);
  m2.groups.afterMove(m2.tabs[1]);
  assert.equal(m2.tabs[1].groupId, h.id);
});

test('normalize keeps groups in one piece and drops groups this window doesn’t have', () => {
  const m = manager(5);
  const g = m.groups.create([1, 2]);
  m.tabs[4].groupId = g.id; // a tab that ended up apart (opened elsewhere)
  m.tabs[3].groupId = 'gNotHere'; // came from another window
  m.groups.normalize();
  assert.deepEqual(ids(m), [1, 2, 5, 3, 4]);
  assert.deepEqual(groupsOf(m), [g.id, g.id, g.id, null, null]);
});

test('groups go to the session file and come back, collapsed ones too, never hiding the tab you’re on', () => {
  const m = manager(4);
  const g = m.groups.create([2, 3], { title: 'Trip', color: 'red' });
  m.groups.update(g.id, { collapsed: true });
  const saved = m.groups.session();
  const list = m.tabs.map((t) => ({ url: t.url, ...(t.groupId ? { group: t.groupId } : {}) }));
  assert.deepEqual(saved, [{ id: g.id, title: 'Trip', color: 'red', collapsed: true }]);

  const back = manager(0);
  const made = list.map((t) => back.create(t.url));
  back.activeId = made[1].id; // the tab you were on is in the group
  back.groups.restore(saved, list, made);
  assert.deepEqual(groupsOf(back), [null, g.id, g.id, null]);
  assert.equal(back.groups.get(g.id).title, 'Trip');
  assert.equal(back.groups.get(g.id).collapsed, false);
  // Junk in the file is ignored.
  const junk = manager(0);
  const jm = [junk.create('https://a.example/')];
  junk.groups.restore([null, { id: 5 }, { id: 'gx', color: 'neon', title: 7 }], [{ group: 'gx' }], jm);
  assert.equal(junk.groups.get('gx').color, 'grey');
});

// ---------------------------------------------------------------- saved groups
const file = (data) => ({ data, saves: 0, save() { this.saves++; } });

test('saved groups: save, follow the open group without needless writes, delete; only web pages', () => {
  const f = file(null);
  const s = new SavedGroups(f, { now: () => 1000 });
  assert.equal(s.save({ title: 'Empty', color: 'red', tabs: [{ url: 'lumio://settings/' }] }), null, 'nothing worth saving');
  const id = s.save({ title: 'Trip', color: 'blue', tabs: [{ url: 'https://a.example/', title: 'A' }, { url: 'file:///etc/passwd' }, { url: 'lumio://newtab/', title: 'New Tab' }] });
  assert.deepEqual(s.get(id).tabs.map((t) => t.url), ['https://a.example/', 'lumio://newtab/']);
  const writes = f.saves;
  assert.equal(s.update(id, { title: 'Trip', color: 'blue', tabs: s.get(id).tabs }), false);
  assert.equal(f.saves, writes, 'unchanged: not written');
  assert.equal(s.update(id, { tabs: [] }), false, 'all its tabs closed: it keeps its pages');
  assert.equal(s.update(id, { title: 'Summer', tabs: [{ url: 'https://b.example/', title: 'B' }] }), true);
  assert.deepEqual(s.list().map((g) => [g.title, g.tabs.length]), [['Summer', 1]]);
  assert.ok(s.remove(id));
  assert.deepEqual(s.list(), []);
});

test('saved groups sync: records in, junk out', () => {
  const s = new SavedGroups(file({ groups: [] }), { now: () => 5 });
  const rejected = s.applySynced([
    { key: 'sAbc', record: { title: 'From the iMac', color: 'green', tabs: [{ url: 'https://x.example/', title: 'X' }], created: 1, updated: 2 } },
    { key: 'sBad', record: { title: 'Nothing to open', color: 'green', tabs: [{ url: 'javascript:alert(1)' }] } },
    { key: '../evil', record: { title: 'Bad id', tabs: [{ url: 'https://y.example/' }] } },
  ]);
  assert.deepEqual(rejected.sort(), ['../evil', 'sBad']);
  assert.deepEqual(s.syncEntries(), [['sAbc', { title: 'From the iMac', color: 'green', tabs: [{ url: 'https://x.example/', title: 'X' }], created: 1, updated: 2 }]]);
  s.applySynced([{ key: 'sAbc', record: null }]);
  assert.deepEqual(s.list(), []);
});

// ---------------------------------------------------------------- the reading list
test('reading list: add, read and unread, remove and undo; unread first, newest first', () => {
  let now = 100;
  const list = new ReadingList(file(null), { now: () => now });
  assert.equal(list.add('lumio://settings/', 'Settings'), null, 'only web pages');
  assert.equal(list.add('javascript:alert(1)'), null);
  const a = list.add('https://a.example/post', 'Post A', 'data:image/png;base64,AAAA');
  now = 200;
  const b = list.add('https://b.example/', '');
  assert.equal(b.title, 'https://b.example/', 'no title: the address');
  assert.equal(list.unread(), 2);
  assert.deepEqual(list.list().map((x) => x.id), [b.id, a.id]);
  assert.ok(list.setRead(b.id, true));
  assert.equal(list.setRead(b.id, true), false, 'already read');
  assert.deepEqual(list.list().map((x) => [x.id, x.read]), [[a.id, false], [b.id, true]]);
  // Adding a page that's there already: unread again, at the top.
  now = 300;
  list.add('https://b.example/', 'B again');
  assert.deepEqual(list.list().map((x) => [x.title, x.read]), [['B again', false], ['Post A', false]]);
  assert.equal(list.items.length, 2);
  const gone = list.remove(a.id);
  assert.equal(list.has('https://a.example/post'), false);
  assert.ok(list.restore(gone));
  assert.equal(list.get(a.id).favicon, 'data:image/png;base64,AAAA');
  assert.equal(list.restore({ ...gone, id: 'rforged' }), false, 'an undo can’t make up ids');
  assert.equal(idFor('https://a.example/post'), a.id);
});

test('reading list sync: no icons sent, records checked against their ids', () => {
  const list = new ReadingList(file({ items: [] }), { now: () => 9 });
  list.add('https://a.example/', 'A', 'data:image/png;base64,AAAA');
  const [[key, record]] = list.syncEntries();
  assert.equal(record.favicon, undefined);
  assert.deepEqual(Object.keys(record).sort(), ['added', 'read', 'title', 'updated', 'url']);
  const other = new ReadingList(file({ items: [] }));
  const rejected = other.applySynced([
    { key, record: { ...record, read: true } },
    { key: idFor('https://b.example/'), record: { url: 'https://evil.example/', title: 'Swapped' } },
  ]);
  assert.equal(rejected.length, 1);
  assert.deepEqual(other.list().map((x) => [x.url, x.read]), [['https://a.example/', true]]);
  other.applySynced([{ key, record: null }]);
  assert.equal(other.items.length, 0);
});
