// Takes the website's screenshots from the real app (throwaway profile):
// the Lumio agent booking a table, a page summary, the model picker, the
// account menu, passwords, extensions, incognito and history.
// Run: node website/tools/shots.mjs   (writes website/public/shots/*.jpg)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, root } from '../../scripts/launch.mjs';
import { startDemoModel } from './demo-model.mjs';
import { startMockLumio } from '../../tests/mock-lumio.mjs';

const OUT = path.join(root, 'website', 'public', 'shots');
const DEMO = path.join(root, 'website', 'tools', 'demo');
fs.mkdirSync(OUT, { recursive: true });

const site = http.createServer((q, r) => {
  const f = path.join(DEMO, new URL(q.url, 'http://x').pathname.slice(1) || 'osteria.html');
  if (!f.startsWith(DEMO) || !fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'content-type': 'text/html' });
  r.end(fs.readFileSync(f));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;
const model = await startDemoModel();
const lumio = await startMockLumio({ plan: 'pro' });
const L = await launch({ env: { LUMIO_OPENROUTER_BASE: model.base, LUMIO_ACCOUNT_BASE: lumio.base, LUMIO_TEST_AUTH: 'allow' } });

const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await L.wait(150); } };
async function save(name) {
  await L.wait(350);
  const png = path.join(OUT, name + '.png');
  await L.shot(png);
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', png, '--out', path.join(OUT, name + '.jpg')], { stdio: 'ignore' });
  fs.rmSync(png);
  console.log('saved', name);
}
const go = async (url, title) => { await L.main((_e, u) => global.lumio.tabs.navigate(u), url); await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())).includes(title)); await L.wait(400); };
const ask = (t) => L.shell(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(t)}; p.dispatchEvent(new Event('input')); document.getElementById('send').click(); return true })()`);
const blur = () => L.shell(`document.activeElement?.blur(); true`);

await until(() => L.main(() => !!global.lumio?.tabs?.active), 20000);
await L.main(() => global.lumio.ai.setKey('sk-or-demo-key'));
await L.main(() => global.lumio.store.setSetting('aiSource', 'openrouter'));
await L.main(() => global.lumio.store.setSetting('profile', { name: 'Sam', color: '#86b7ff', photo: null, theme: 'blue' }));
// A little history and a couple of bookmarks so pages look lived-in.
await L.main(() => {
  const s = global.lumio.store;
  const now = Date.now();
  const sites = [['https://news.ycombinator.com/', 'Hacker News'], ['https://www.wikipedia.org/', 'Wikipedia'], ['https://github.com/', 'GitHub'], ['https://www.nytimes.com/', 'The New York Times'], ['https://maps.google.com/', 'Google Maps'], ['https://open.spotify.com/', 'Spotify']];
  s.importHistory(sites.flatMap(([url, title], i) => [{ url, title, time: now - i * 3600000 }, { url, title, time: now - 86400000 - i * 5400000 }]));
  s.toggleBookmark('https://github.com/', 'GitHub');
  s.toggleBookmark('https://www.wikipedia.org/', 'Wikipedia');
  s.setSetting('showBookmarksBar', true);
});

// 1. The agent booking a table, paused on an approval.
await go(`${base}/osteria.html`, 'Osteria');
await blur();
await ask('Book a table for 2 tonight at 8pm under Sam Rivera, sam@example.com');
let approvals = 0;
for (let i = 0; i < 160 && (await L.main(() => global.lumio.ai.isRunning())); i++) {
  if (await L.shell(`!!document.querySelector('.approval [data-d="once"]:not(:disabled)')`)) {
    approvals++;
    const label = await L.shell(`document.querySelector('.approval').innerText`);
    if (/Reserve table/.test(label)) await save('agent-approval');
    await L.shell(`document.querySelector('.approval [data-d="once"]:not(:disabled)').click(); true`);
  }
  await L.wait(200);
}
await L.wait(500);
await save('agent-done');

// 2. Summarize an article.
await L.main(() => { global.lumio.tabs.create('about:blank'); });
await go(`${base}/article.html`, 'Night Skies');
await L.shell(`document.getElementById('newchat-btn').click(); true`);
await ask('Summarize this page');
await until(async () => !(await L.main(() => global.lumio.ai.isRunning())));
await save('summary');

// 3. The model picker.
await L.shell(`document.getElementById('model-btn').click(); true`);
await until(() => L.shell(`document.querySelectorAll('#model-list [data-id]').length === 6 && document.querySelector('#model-list .li-sub').textContent.includes('$')`));
await save('models');
await L.shell(`document.getElementById('model-btn').click(); true`);

// 4. Account menu (signed in to Lumio Pro).
await L.main(() => global.lumio.account.startSignIn());
const id = await until(() => L.main(() => global.lumio.account.pending?.id));
await fetch(lumio.base + '/api/auth/desktop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve', id }) });
await until(() => L.main(() => global.lumio.account.state().signedIn));
await L.main(() => { const w = global.lumio.current; w.tabs.close(w.tabs.tabs.find((t) => (t.url || '').includes('desktop-connect'))?.id); });
await go(`${base}/article.html`, 'Night Skies');
await L.shell(`document.getElementById('account-btn').click(); true`);
await until(() => L.main(() => global.lumio.current.overlayKind === 'account'));
await save('account');
await L.shell(`window.lumio.send('overlay:hide'); true`);

// 5. Passwords.
await L.main(() => {
  const p = global.lumio.passwords.store;
  p.save({ origin: 'https://github.com', username: 'sam-rivera', password: 'kT9#vQ2!mZr8wL4x' });
  p.save({ origin: 'https://accounts.spotify.com', username: 'sam@example.com', password: 'summer2024' });
  p.save({ origin: 'https://www.nytimes.com', username: 'sam@example.com', password: 'summer2024' });
  p.save({ origin: 'https://login.microsoftonline.com', username: 'sam.rivera@outlook.com', password: 'Qw!9xLp2#Rt6vN8e' });
});
await go('lumio://passwords/', 'Passwords');
await L.page(`document.querySelector('.pw-item').click(); true`);
await L.page(`document.querySelector('[data-act=reveal]').click(); true`);
await save('passwords');

// 6. Extensions.
await L.main((_e, p) => global.lumio.extensions.loadUnpacked(p), path.join(root, 'tests', 'fixtures', 'ext-hello'));
await go('lumio://extensions/', 'Extensions');
await save('extensions');

// 7. History.
await go('lumio://history/', 'History');
await save('history');

// 8. Settings: plan.
await go('lumio://settings/#plan', 'Settings');
await save('settings-plan');

// 9. Incognito.
await L.main(() => global.lumio.createWindow({ incognito: true }));
await until(() => L.main(() => global.lumio.current.incognito));
await L.wait(1200);
await save('incognito');

await L.close();
site.close(); model.server.close(); lumio.server.close();
