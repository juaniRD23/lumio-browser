// Profiles, Guest, the Task Manager and Settings › Performance in the real
// app: each profile keeps its own session and files, windows belong to one
// profile, Guest leaves nothing behind, deleting a profile removes its data,
// and the Task Manager and Memory Saver work on real tabs.
// Run: node --test tests/e2e/profiles.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../../scripts/launch.mjs';

let L;
let site;
let base;
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
};
const windows = () => L.main(() => global.lumio.windows.map((w) => ({ id: w.id, profile: w.profile.id, guest: !!w.profile.guest, incognito: w.incognito })));

before(async () => {
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'who=visited; Path=/' });
    res.end(`<!doctype html><title>Page ${req.url}</title><p>Hello from ${req.url}</p>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${site.address().port}`;
  L = await launch();
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
});

after(async () => {
  await L?.close();
  site?.close();
});

let work; // the profile added below

test('the first profile keeps today’s files and session', async () => {
  const info = await L.main(() => {
    const p = global.lumio.profiles;
    return { ids: p.registry.ids(), partition: p.normal.partition, dir: p.normal.dir, wins: global.lumio.windows.map((w) => w.profile.id) };
  });
  assert.deepEqual(info.ids, ['default']);
  assert.equal(info.partition, 'persist:lumio');
  assert.equal(fs.realpathSync(info.dir), fs.realpathSync(L.userData));
  assert.deepEqual(info.wins, ['default']);
  assert.ok(fs.existsSync(path.join(L.userData, 'profiles.json')));
});

test('a new profile opens in its own window, with its own session, files and title', async () => {
  work = await L.main(async () => {
    const p = global.lumio.profiles;
    const added = p.registry.add({ name: 'Work', color: '#b58cff' });
    await p.start(added.id);
    return added;
  });
  assert.match(work.id, /^p[0-9a-f]{8}$/);
  assert.ok(await until(async () => (await windows()).some((w) => w.profile === work.id)), 'a window for Work');
  const info = await L.main((_e, id) => {
    const w = global.lumio.windows.find((x) => x.profile.id === id);
    return { partition: w.profile.partition, dir: w.profile.dir, front: global.lumio.current === w };
  }, work.id);
  assert.equal(info.partition, `persist:lumio-${work.id}`);
  assert.equal(info.dir, path.join(L.userData, 'Profiles', work.id));
  assert.equal(info.front, true, 'it comes to the front');
  // Its window says whose it is, and the menu lists the other profile.
  assert.ok(await until(async () => /\(Work\)$/.test(await L.shell('document.title'))));

  // Browsing in Work: its history and cookies stay in Work.
  await L.main((_e, u) => global.lumio.tabs.navigate(u), `${base}/work-page`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())) === 'Page /work-page'));
  const where = await L.main(async (_e, { id, url }) => {
    const p = global.lumio.profiles;
    const workP = p.loaded.get(id);
    const def = p.loaded.get('default');
    return {
      workHistory: workP.store.history().map((h) => h.url),
      defaultHistory: def.store.history().map((h) => h.url),
      workCookies: (await workP.session.cookies.get({ url })).length,
      defaultCookies: (await def.session.cookies.get({ url })).length,
    };
  }, { id: work.id, url: base });
  assert.deepEqual(where.workHistory, [`${base}/work-page`]);
  assert.deepEqual(where.defaultHistory, []);
  assert.equal(where.workCookies, 1);
  assert.equal(where.defaultCookies, 0, 'the first profile never saw that site’s cookie');

  // Bookmarks are the profile's own too.
  await L.main(() => global.lumio.cmd.bookmark());
  await L.main(() => { global.lumio.store.flushAll(); global.lumio.store.bookmarksFile.flush(); });
  // (Saved as a tree since batch 5: bookmark-tree.json, main/store.js.)
  const file = path.join(L.userData, 'Profiles', work.id, 'bookmark-tree.json');
  assert.ok(await until(() => Promise.resolve(fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(`${base}/work-page`))), 'in Work’s own folder');
  assert.deepEqual(await L.main((_e, id) => global.lumio.profiles.loaded.get(id).store.bookmarks().map((b) => b.url), work.id), [`${base}/work-page`]);
  assert.equal(await L.main(() => global.lumio.profiles.loaded.get('default').store.bookmarks().length), 0);
});

test('the account menu offers the other profiles, Add, Guest and Manage', async () => {
  await L.shell(`document.getElementById('account-btn').click(); true`);
  const text = await until(() => L.main(() => ((w) => (!w.overlayKind ? null : w.overlayIn === w.overlaySeq ? w.overlayKind : w.overlayKind + ':showing'))(global.lumio.current) === 'account' && global.lumio.current.overlay.webContents.executeJavaScript('document.body.innerText')));
  assert.match(text, /Other profiles[\s\S]*Person 1/i, 'the first profile, still unnamed');
  assert.match(text, /Add[\s\S]*Guest[\s\S]*Manage/);
  await L.shell(`document.getElementById('account-btn').click(); true`);
});

test('an incognito window belongs to its profile', async () => {
  await L.main(() => global.lumio.cmd.newIncognito());
  const w = await until(async () => (await windows()).find((x) => x.incognito));
  assert.equal(w.profile, work.id);
  const shared = await L.main(() => { const c = global.lumio.current; return c.incognito && c.profile.base === global.lumio.profiles.loaded.get(c.profile.id) && c.profile.store === c.profile.base.store; });
  assert.equal(shared, true, 'it shows Work’s bookmarks, in its own throwaway session');
  await L.main(() => global.lumio.current.close());
  assert.ok(await until(async () => !(await windows()).some((x) => x.incognito)));
});

test('the profile picker lists the profiles and opens one', async () => {
  await L.main(() => global.lumio.picker.open());
  assert.ok(await until(async () => (await L.main(() => global.lumio.picker.isOpen && global.lumio.picker.win.webContents.executeJavaScript('document.querySelectorAll(".card[data-id]").length'))) === 2));
  // Opening the first profile brings its window to the front and closes the picker.
  await L.main(() => global.lumio.picker.win.webContents.executeJavaScript(`document.querySelector('.card[data-id="default"]').click(); true`));
  assert.ok(await until(async () => !(await L.main(() => global.lumio.picker.isOpen))));
  assert.equal(await L.main(() => global.lumio.current.profile.id), 'default');
});

test('Guest keeps nothing: no history, and its files are gone when it closes', async () => {
  await L.main(() => global.lumio.profiles.openGuest());
  const g = await until(async () => (await windows()).find((x) => x.guest));
  assert.ok(g, 'a Guest window');
  const dir = await L.main(() => global.lumio.current.profile.dir);
  assert.ok(dir.includes('Guest Profile'));
  assert.ok(await until(async () => /\(Guest\)$/.test(await L.shell('document.title'))));
  await L.main((_e, u) => global.lumio.tabs.navigate(u), `${base}/guest-page`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())) === 'Page /guest-page'));
  assert.deepEqual(await L.main(() => global.lumio.current.profile.store.history()), [], 'no history');
  // Guest can't install apps (main/apps.js prompt): no Install dialog.
  const asked = await L.main(async () => {
    const apps = global.lumio.pageTools.apps;
    apps.prompts.clear();
    await apps.prompt(global.lumio.current, global.lumio.tabs.active);
    return apps.prompts.size;
  });
  assert.equal(asked, 0, 'no Install app dialog in Guest');
  await L.main(() => global.lumio.current.close());
  assert.ok(await until(async () => !(await windows()).some((x) => x.guest)));
  assert.ok(await until(async () => !fs.existsSync(dir), 5000), 'Guest’s folder is deleted');
});

test('Task Manager lists the browser, the GPU and each tab, and ends a tab’s process', async () => {
  await L.main(() => global.lumio.cmd.taskManager());
  assert.ok(await until(() => L.main(() => !!global.lumio.taskManager.win)));
  const rows = await until(async () => {
    const list = await L.main(() => global.lumio.taskManager.list());
    return list.some((r) => r.kind === 'tab') && list;
  });
  assert.ok(rows.some((r) => r.title === 'Browser'));
  assert.ok(rows.every((r) => Number.isInteger(r.pid) && r.memory >= 0 && r.cpu >= 0));
  assert.equal(rows.find((r) => r.title === 'Browser').canEnd, false);
  // Its page shows the processes too.
  assert.ok(await until(async () => (await L.main(() => global.lumio.taskManager.win.webContents.executeJavaScript('document.querySelectorAll("#rows tr").length'))) >= 3));

  // End process on a web page's tab: the tab shows its error page.
  await L.main((_e, u) => global.lumio.tabs.navigate(u), `${base}/to-end`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())) === 'Page /to-end'));
  const pid = await L.main(() => global.lumio.tabs.wc().getOSProcessId());
  assert.equal(await L.main((_e, p) => global.lumio.taskManager.end(p), pid), true);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getURL())).startsWith('lumio://error/'), 10_000));
  await L.main(() => global.lumio.taskManager.win.close());
});

test('Memory Saver keeps the sites on its list awake; Energy Saver quiets the window', async (t) => {
  const perf = (fn, arg) => L.main(fn, arg);
  let ids = [];
  // Even if a check fails: the settings back, and the tabs closed, for the next tests.
  t.after(() => perf((_e, made) => {
    const p = global.lumio.perf;
    p.set('sites', []);
    p.set('mode', 'balanced');
    p.setBattery({ level: 1, charging: true });
    for (const id of made) if (global.lumio.tabs.get(id)) global.lumio.tabs.close(id);
    return true;
  }, ids));
  await perf(() => global.lumio.perf.set('mode', 'maximum'));
  await perf((_e, host) => global.lumio.perf.set('sites', [host]), '127.0.0.1');
  // Two background tabs: one on the kept site, one elsewhere (a lumio:// page never sleeps, so use data:).
  ids = await L.main(async (_e, u) => {
    const tabs = global.lumio.tabs;
    const kept = tabs.create(`${u}/kept`, { active: false });
    const other = tabs.create('data:text/html,<title>Other</title>', { active: false });
    await new Promise((r) => setTimeout(r, 1500));
    for (const t of [kept, other]) t.lastActive = Date.now() - 3600_000;
    return [kept.id, other.id];
  }, base);
  await perf(() => global.lumio.perf.sleepIdle());
  const asleep = await L.main((_e, [a, b]) => [global.lumio.tabs.get(a).discarded, global.lumio.tabs.get(b).discarded], ids);
  assert.deepEqual(asleep, [false, true]);
  await perf(() => global.lumio.perf.set('sites', []));
  await perf(() => global.lumio.perf.set('mode', 'balanced'));

  // Energy Saver: on battery at 10%, the window's UI gets the class that stops animations.
  await perf(() => global.lumio.perf.setBattery({ level: 0.1, charging: false }));
  assert.ok(await until(async () => L.shell(`document.documentElement.classList.contains('energy-saver') && !document.getElementById('energy-btn').hidden`)));
  await perf(() => global.lumio.perf.setBattery({ level: 0.1, charging: true }));
  assert.ok(await until(async () => L.shell(`!document.documentElement.classList.contains('energy-saver')`)));
});

test('deleting a profile closes its windows and removes its files', async () => {
  const dir = path.join(L.userData, 'Profiles', work.id);
  assert.ok(fs.existsSync(dir));
  assert.equal(await L.main((_e, id) => global.lumio.profiles.remove(id), work.id), true);
  assert.ok(!(await windows()).some((w) => w.profile === work.id), 'its windows closed');
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(await L.main(() => global.lumio.profiles.registry.ids()), ['default']);
  assert.equal(await L.main(() => global.lumio.profiles.remove('default')), false, 'the first profile stays');
});
