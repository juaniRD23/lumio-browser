// main/profiles.js: the list of profiles. The first profile keeps today's
// files and session (nothing moves for people updating); new ones get their
// own folder and session; deleting one removes its files (again at the next
// launch, for files that were still in use) and never anything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProfileRegistry, DEFAULT_PROFILE, COLORS, nextName, nextColor } = require('../main/profiles.js');
const { Store } = require('../main/store.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-profiles-'));

test('an existing install becomes the first profile, with the same files and session', () => {
  const root = tmp();
  // Someone updating: their settings, bookmarks and history are already in userData.
  const before = new Store(root, null);
  before.setSetting('profile', { name: 'Juan', color: '#7ee2a8', photo: null, theme: 'green' });
  before.marks.add(before.marks.roots[0].id, null, { title: 'Example', url: 'https://example.com/' });
  before.flushAll();
  before.bookmarksFile.flush();

  const reg = new ProfileRegistry(root);
  assert.deepEqual(reg.ids(), [DEFAULT_PROFILE]);
  assert.equal(reg.dirOf(DEFAULT_PROFILE), root, 'the first profile stays in userData');
  assert.equal(reg.partitionOf(DEFAULT_PROFILE), 'persist:lumio', 'and keeps its cookies and logins');
  assert.equal(new Store(reg.dirOf(DEFAULT_PROFILE), null).bookmarks()[0].url, 'https://example.com/');
  assert.deepEqual(reg.describe(DEFAULT_PROFILE), { id: 'default', name: 'Juan', color: '#7ee2a8', theme: 'green', photo: null, email: null, isDefault: true });
  assert.equal(reg.wantsPicker(), false, 'one profile: no picker');
});

test('adding a profile gives it its own folder, session, name and color', () => {
  const root = tmp();
  const reg = new ProfileRegistry(root);
  const work = reg.add({ name: '  Work   stuff ', color: '#ff8fc7' });
  assert.match(work.id, /^p[0-9a-f]{8}$/);
  assert.equal(work.name, 'Work stuff');
  assert.equal(work.color, '#ff8fc7');
  assert.equal(reg.dirOf(work.id), path.join(root, 'Profiles', work.id));
  assert.equal(reg.partitionOf(work.id), `persist:lumio-${work.id}`);
  // Its own settings, history and bookmarks; it skips the first-run welcome.
  const store = new Store(reg.dirOf(work.id), null);
  assert.equal(store.settings.profile.name, 'Work stuff');
  assert.equal(store.settings.onboarded, true);
  assert.deepEqual(store.bookmarks(), []);

  // No name or color: the next free ones.
  const next = reg.add({});
  assert.equal(next.name, 'Person 3');
  assert.notEqual(next.color, work.color);
  assert.equal(reg.wantsPicker(), true, 'several profiles: the picker shows at launch');
  reg.showPicker = false;
  assert.equal(new ProfileRegistry(root).wantsPicker(), false, 'unless "Show on startup" is off');
});

test('the picker shows the Lumio account of a profile that isn’t open', () => {
  const reg = new ProfileRegistry(tmp());
  assert.equal(reg.remember(DEFAULT_PROFILE, { email: 'sam@example.com', accountName: 'Sam' }), true);
  assert.equal(reg.remember(DEFAULT_PROFILE, { email: 'sam@example.com', accountName: 'Sam' }), false, 'nothing new');
  assert.equal(reg.describe(DEFAULT_PROFILE).name, 'Sam', 'no profile name: the account name');
  assert.equal(reg.describe(DEFAULT_PROFILE).email, 'sam@example.com');
  assert.equal(reg.describe(DEFAULT_PROFILE, { name: 'Home' }).name, 'Home', 'an open profile passes its live settings');
});

test('deleting a profile removes its files and session, now and at the next launch', () => {
  const root = tmp();
  const reg = new ProfileRegistry(root);
  const work = reg.add({ name: 'Work' });
  reg.setLastUsed(work.id);
  reg.setLastOpen([DEFAULT_PROFILE, work.id]);
  const partition = reg.partitionDir(work.id);
  fs.mkdirSync(partition, { recursive: true });
  fs.writeFileSync(path.join(partition, 'Cookies'), 'x');
  const keep = path.join(root, 'Extensions');
  fs.mkdirSync(keep);

  assert.equal(reg.remove(DEFAULT_PROFILE), false, 'the first profile holds the app’s settings and stays');
  assert.equal(reg.remove(work.id), true);
  assert.equal(fs.existsSync(reg.dirOf(work.id)), false);
  assert.equal(fs.existsSync(partition), false);
  assert.deepEqual(reg.ids(), [DEFAULT_PROFILE]);
  assert.equal(reg.lastUsed(), DEFAULT_PROFILE);
  assert.deepEqual(reg.lastOpen(), [DEFAULT_PROFILE]);

  // The session may write again before Lumio quits: the next launch cleans up.
  fs.mkdirSync(partition, { recursive: true });
  const again = new ProfileRegistry(root);
  assert.equal(again.data.trash.length, 2);
  again.emptyTrash();
  assert.equal(fs.existsSync(partition), false);
  assert.deepEqual(again.data.trash, []);
  assert.equal(fs.existsSync(keep), true, 'nothing else is touched');
});

test('the trash only ever deletes profile folders inside userData', () => {
  const root = tmp();
  const outside = tmp();
  const reg = new ProfileRegistry(root);
  reg.data.trash.push(outside, root, path.join(root, 'Extensions'), path.join(root, 'Profiles', '..', '..'));
  fs.mkdirSync(path.join(root, 'Extensions'));
  reg.emptyTrash();
  assert.equal(fs.existsSync(outside), true);
  assert.equal(fs.existsSync(path.join(root, 'Extensions')), true);
  assert.equal(fs.existsSync(path.join(root, 'profiles.json')), true);
});

test('Guest’s folder is wiped at launch', () => {
  const root = tmp();
  const reg = new ProfileRegistry(root);
  const dir = reg.guestDir(1);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'history.json'), '[]');
  assert.equal(reg.rm(reg.guestDir(2)), true, 'one Guest session’s folder can go on its own');
  reg.emptyTrash();
  assert.equal(fs.existsSync(reg.guestRoot), false);
});

test('names and colors for new profiles', () => {
  assert.equal(nextName(['Juan']), 'Person 2');
  assert.equal(nextName(['Juan', 'Person 2']), 'Person 3');
  assert.equal(nextName(['Person 2', 'x']), 'Person 3');
  assert.equal(nextColor([COLORS[0], COLORS[1]]), COLORS[2]);
  assert.ok(COLORS.includes(nextColor(COLORS)));
});

test('a broken profiles.json still has the first profile', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'profiles.json'), JSON.stringify({ profiles: [{ id: '../../etc' }, null, { id: 'p0123abcd' }], showPicker: 'yes' }));
  const reg = new ProfileRegistry(root);
  assert.deepEqual(reg.ids(), [DEFAULT_PROFILE, 'p0123abcd']);
  assert.equal(reg.showPicker, true);
});
