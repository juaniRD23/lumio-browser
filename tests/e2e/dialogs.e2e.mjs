// End-to-end tests for what a page can ask in its tab, drawn by Lumio over
// the page (main/dialog-view.js): alert/confirm/prompt, "Leave site?" when
// closing, reloading or closing the window, "Page unresponsive", HTTP
// sign-in (and a frame from another site that may not ask), and "Your
// connection is not private" for a bad certificate.
// Run: npm run test:e2e   (set LUMIO_SHOTS=/some/dir to save screenshots)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from '../../scripts/launch.mjs';

const SHOTS = process.env.LUMIO_SHOTS;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-dialogs-e2e-'));
let L;
let site;
let base;
let secure; // https with a self-signed certificate (when openssl is there to make one)
let secureBase;

const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await L.shot(path.join(SHOTS, name + '.png')); } };
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return v;
    await L.wait(150);
  }
};
const title = () => L.main(() => global.lumio.tabs.wc().getTitle());
const url = () => L.main(() => global.lumio.tabs.wc().getURL());
const go = async (u, expect) => {
  await L.main((_e, x) => global.lumio.tabs.navigate(x), u);
  assert.ok(await until(async () => (await title()) === expect), `loaded ${expect}`);
};
// The active tab's dialog, as main sees it and as the dialog view shows it.
// (A page waiting on its alert() can't run scripts, so these never ask the page.)
const dialog = () => L.main(() => {
  const w = global.lumio.current;
  const tab = w.tabs.active;
  const d = tab?.dialogs?.[0];
  return { shown: w.win.contentView.children.includes(w.dialogs.view), kinds: (tab?.dialogs || []).map((x) => x.spec.kind), title: d?.spec.title || null, checkbox: !!d?.spec.checkbox };
});
const inDialog = (code) => L.main((_e, c) => global.lumio.current.dialogs.view.webContents.executeJavaScript(c), code);
const dialogText = () => inDialog('document.getElementById("card").innerText');
const press = (id) => inDialog(`document.querySelector('#d-buttons [data-id="${id}"]').click(); true`);
const key = (keyCode) => L.main((_e, k) => {
  const wc = global.lumio.current.dialogs.view.webContents;
  wc.focus();
  wc.sendInputEvent({ type: 'keyDown', keyCode: k });
  wc.sendInputEvent({ type: 'keyUp', keyCode: k });
  return true;
}, keyCode);
const waitDialog = (kind) => until(async () => { const d = await dialog(); return d.shown && d.kinds[0] === kind && d; });
const noDialog = () => until(async () => { const d = await dialog(); return !d.shown && !d.kinds.length; });
// A real click in the page: it counts as using the page (Chrome's rule for "Leave site?").
// Scrolled into view first, as a person would (the page area can be short).
const clickPage = (sel = 'body') => L.main(async (_e, s) => {
  const wc = global.lumio.tabs.wc();
  const r = await wc.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(s)}); el.scrollIntoView({ block: 'center', behavior: 'instant' }); const b = el.getBoundingClientRect(); return { x: Math.round(b.x + Math.min(b.width / 2, 40)), y: Math.round(b.y + Math.min(b.height / 2, 20)) } })()`);
  wc.focus();
  wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  return true;
}, sel);
const tabCount = () => L.main(() => global.lumio.tabs.tabs.length);

const LEAVE_PAGE = `<title>Draft</title><textarea id="t">unsaved</textarea>
  <script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });
  sessionStorage.loads = (+sessionStorage.loads || 0) + 1;</script>`;

before(async () => {
  site = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/leave') { r.writeHead(200, { 'content-type': 'text/html' }); r.end(LEAVE_PAGE); return; }
    // A page with unsaved changes that keeps trying to go somewhere by itself.
    if (u.pathname === '/trap') { r.writeHead(200, { 'content-type': 'text/html' }); r.end(LEAVE_PAGE.replace('<title>Draft</title>', '<title>Trap</title>') + `<script>document.addEventListener('mousedown', () => setInterval(() => { location.href = '/next'; }, 150), { once: true });</script>`); return; }
    // A form on a page that always asks before leaving (it doesn't stop asking when you send it).
    if (u.pathname === '/form') { r.writeHead(200, { 'content-type': 'text/html' }); r.end(LEAVE_PAGE.replace('<title>Draft</title>', '<title>Form</title>') + `<form method="post" action="/sent"><input name="note" value="hello"><button id="send">Send</button></form>`); return; }
    if (u.pathname === '/sent') {
      let body = '';
      q.on('data', (c) => { body += c; });
      q.on('end', () => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(`<title>Sent ${q.method} ${body}</title>`); });
      return;
    }
    if (u.pathname === '/framed-auth') {
      // localhost isn't 127.0.0.1: the frame is another site.
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(`<title>Framed</title><iframe src="http://localhost:${site.address().port}/auth"></iframe>`);
      return;
    }
    if (u.pathname.startsWith('/auth')) {
      const ok = q.headers.authorization === `Basic ${Buffer.from('ada:s3cret').toString('base64')}`;
      r.writeHead(ok ? 200 : 401, { 'content-type': 'text/html', ...(ok ? {} : { 'www-authenticate': 'Basic realm="Lumio test"' }) });
      r.end(ok ? '<title>Signed in as ada</title>' : '<title>401</title><p>Not signed in</p>');
      return;
    }
    const name = u.pathname.slice(1) || 'home';
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<title>Page ${name}</title><h1>${name}</h1>`);
  });
  await new Promise((res) => site.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${site.address().port}`;
  // A self-signed certificate for 127.0.0.1, made fresh (no key kept in the repo).
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem'), '-days', '2', '-subj', '/CN=Lumio test', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }); // Git's openssl on Windows would turn /CN=… into a path
    secure = https.createServer({ key: fs.readFileSync(path.join(tmp, 'key.pem')), cert: fs.readFileSync(path.join(tmp, 'cert.pem')) }, (q, r) => {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end('<title>Self-signed page</title><h1>made it</h1>');
    });
    await new Promise((res) => secure.listen(0, '127.0.0.1', res));
    secureBase = `https://127.0.0.1:${secure.address().port}`;
  } catch { secure = null; }
  L = await launch();
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
  await L.wait(600);
});

after(async () => {
  // Nothing left that could hold up quitting with "Leave site?".
  await L?.main(() => { for (const w of global.lumio.windows) for (const t of w.tabs.tabs) t.touched = false; return true; }).catch(() => {});
  await L?.close();
  site?.close();
  secure?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('alert, confirm and prompt appear in the tab, named after the site, and the page gets the answer', async () => {
  try { await alertsConfirmPrompt(); } finally {
    // Never leave the page waiting on a dialog for the next test.
    await L.main(() => { const t = global.lumio.tabs; if (t.active) t.dismiss(t.active); return true; }).catch(() => {});
  }
});
async function alertsConfirmPrompt() {
  await go(`${base}/alerts`, 'Page alerts');
  const host = new URL(base).host;
  await L.page(`setTimeout(() => { alert('Saved!'); window.r0 = 'after alert'; }, 0); true`);
  assert.ok(await waitDialog('js'));
  assert.equal((await dialog()).title, `${host} says`);
  assert.ok(await until(async () => /Saved!/.test(await dialogText())), 'the page’s message');
  assert.deepEqual(await inDialog(`[...document.querySelectorAll('#d-buttons button')].map((b) => b.textContent)`), ['OK'], 'an alert has only OK');
  await key('Enter');
  assert.ok(await noDialog());
  assert.equal(await until(() => L.page('window.r0')), 'after alert', 'the page went on once it was answered');

  await L.page(`setTimeout(() => { window.r1 = confirm('Delete the draft?'); }, 0); true`);
  assert.ok(await waitDialog('js'), 'shown over the page');
  assert.equal((await dialog()).title, `${host} says`);
  assert.match(await dialogText(), /Delete the draft\?/);
  await shot('70-confirm');
  await press('ok');
  assert.ok(await noDialog());
  assert.equal(await L.page('window.r1'), true);

  await L.page(`setTimeout(() => { window.r2 = prompt('Your name?', 'Guest'); }, 0); true`);
  assert.ok(await waitDialog('js'));
  assert.equal(await inDialog('document.querySelector("#d-fields input").value'), 'Guest');
  await inDialog('document.querySelector("#d-fields input").value = "Ada"; true');
  await key('Enter');
  assert.ok(await noDialog());
  assert.equal(await L.page('window.r2'), 'Ada', 'prompt() works (Electron alone has none)');

  await L.page(`setTimeout(() => { window.r3 = confirm('Sure?'); }, 0); true`);
  assert.ok(await waitDialog('js'));
  await key('Escape');
  assert.ok(await noDialog());
  assert.equal(await L.page('window.r3'), false, 'Esc cancels');
}

test('dialogs in a row: the second offers "Don’t allow … to show more dialogs", and then they stop', async () => {
  // A tab of its own: dialogs in a row, and a site's block, are counted per tab.
  const home = await L.main(() => global.lumio.tabs.activeId);
  const id = await L.main((_e, u) => global.lumio.tabs.create(u).id, `${base}/spam`);
  try {
    assert.ok(await until(async () => (await title()) === 'Page spam'));
    await L.page(`setTimeout(() => { alert('one'); alert('two'); window.r = confirm('three'); window.done = true; }, 0); true`);
    assert.ok(await waitDialog('js'));
    assert.equal((await dialog()).checkbox, false);
    await press('ok');
    assert.ok(await until(async () => (await dialog()).checkbox), 'the second one offers it');
    assert.match(await dialogText(), /Don't allow 127\.0\.0\.1:\d+ to show more dialogs/);
    await inDialog('document.querySelector("#d-check input").click(); true');
    await press('ok');
    assert.ok(await until(() => L.page('window.done === true')));
    assert.equal(await L.page('window.r'), false, 'the third returned at once');
    assert.equal((await dialog()).kinds.length, 0);
  } finally {
    await L.main((_e, [x, h]) => { const t = global.lumio.tabs; t.close(x, { force: true }); t.activate(h); return true; }, [id, home]);
  }
});

test('a dialog belongs to its tab: switching tabs hides it, coming back shows it again', async () => {
  await go(`${base}/owner`, 'Page owner');
  const owner = await L.main(() => global.lumio.tabs.activeId);
  await L.page(`setTimeout(() => { window.r = confirm('Still there?'); }, 0); true`);
  assert.ok(await waitDialog('js'));
  await L.main(() => global.lumio.cmd.newTab());
  assert.ok(await until(async () => !(await dialog()).shown), 'hidden on another tab');
  await L.main((_e, id) => global.lumio.tabs.activate(id), owner);
  assert.ok(await waitDialog('js'), 'back again');
  await press('ok');
  assert.equal(await until(() => L.page('window.r')), true);
  // Close the extra new tab.
  await L.main(() => { const t = global.lumio.tabs; t.close(t.tabs.at(-1).id); });
});

test('"Leave site?" when closing a page you typed in: Cancel keeps it, Leave closes it', async () => {
  // A page you never used closes without asking (Chrome's rule).
  await L.main((_e, u) => { global.lumio.tabs.create(u); }, `${base}/leave`);
  assert.ok(await until(async () => (await title()) === 'Draft'));
  let before = await tabCount();
  await L.main(() => global.lumio.cmd.closeTab());
  assert.equal(await tabCount(), before - 1);
  assert.equal((await dialog()).kinds.length, 0);

  await L.main((_e, u) => { global.lumio.tabs.create(u); }, `${base}/leave`);
  assert.ok(await until(async () => (await title()) === 'Draft'));
  before = await tabCount();
  await clickPage('#t');
  await L.main(() => global.lumio.cmd.closeTab());
  assert.ok(await waitDialog('leave'));
  assert.equal((await dialog()).title, 'Leave site?');
  assert.match(await dialogText(), /Changes you made may not be saved/);
  await shot('71-leave-site');
  await key('Escape');
  assert.ok(await noDialog());
  assert.equal(await tabCount(), before, 'Cancel keeps the tab');
  assert.equal(await L.page('document.getElementById("t").value'), 'unsaved');

  // Reloading asks "Reload site?"; Reload reloads.
  await clickPage('#t');
  await L.main(() => global.lumio.cmd.reload(false));
  assert.ok(await waitDialog('leave'));
  assert.equal((await dialog()).title, 'Reload site?');
  await press('leave');
  assert.ok(await until(async () => (await L.page('sessionStorage.loads').catch(() => null)) === '2'), 'reloaded once');

  await clickPage('#t');
  await L.main(() => global.lumio.cmd.closeTab());
  assert.ok(await waitDialog('leave'));
  await press('leave');
  assert.ok(await until(async () => (await tabCount()) === before - 1), 'Leave closes it');
});

test('a link the page follows after asking: "Leave site?" first, then the page goes', async () => {
  await go(`${base}/leave`, 'Draft');
  await clickPage('#t');
  await L.page(`setTimeout(() => { location.href = ${JSON.stringify(`${base}/next`)}; }, 0); true`);
  assert.ok(await waitDialog('leave'));
  await press('leave');
  assert.ok(await until(async () => (await title()) === 'Page next'));
});

test('a page that keeps leaving by itself can’t push away “Leave site?” about closing it', async () => {
  await L.main((_e, u) => { global.lumio.tabs.create(u); }, `${base}/trap`);
  assert.ok(await until(async () => (await title()) === 'Trap'));
  const before = await tabCount();
  await clickPage('#t'); // the page starts going to /next every 150 ms
  assert.ok(await waitDialog('leave'), 'its first try asks; the next ones wait for another click');
  await L.main(() => global.lumio.cmd.closeTab());
  await L.wait(500); // closing runs its beforeunload: the question is now about closing
  const first = await L.main(() => global.lumio.tabs.active.dialogs[0].id);
  await L.wait(1200); // eight more tries by the page
  assert.equal(await L.main(() => global.lumio.tabs.active.dialogs?.[0]?.id), first, 'still the question about closing it');
  assert.equal(await title(), 'Trap', 'and the page stayed where it was');
  await press('leave');
  assert.ok(await until(async () => (await tabCount()) === before - 1), 'Leave closes it');
});

test('a form you send on a page that always asks goes, with its data, without “Leave site?”', async () => {
  await go(`${base}/form`, 'Form');
  await clickPage('#send');
  assert.ok(await until(async () => (await title()) === 'Sent POST note=hello'), 'posted, not loaded as a plain page');
  assert.equal((await dialog()).kinds.length, 0);
});

test('closing a window asks for each page that would lose changes; staying keeps the window whole', async () => {
  await L.main((_e, u) => global.lumio.createWindow({ urls: [u] }), `${base}/leave`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.windows.length)) === 2));
  assert.ok(await until(async () => (await title()) === 'Draft'));
  await L.main((_e, u) => { global.lumio.tabs.create(u, { active: false }); }, `${base}/plain`);
  await clickPage('#t');
  await L.main(() => global.lumio.cmd.closeWindow());
  assert.ok(await waitDialog('leave'));
  await press('cancel');
  assert.ok(await noDialog());
  assert.equal(await L.main(() => global.lumio.windows.length), 2, 'the window stays');
  assert.equal(await tabCount(), 2, 'with all its tabs');
  await clickPage('#t');
  await L.main(() => global.lumio.cmd.closeWindow());
  assert.ok(await waitDialog('leave'));
  await press('leave');
  assert.ok(await until(async () => (await L.main(() => global.lumio.windows.length)) === 1), 'closed after Leave');
  const closed = await L.main(() => global.lumio.recentlyClosed.at(-1));
  assert.equal(closed.kind, 'window');
  assert.equal(closed.tabs.length, 2, 'Recently Closed has the whole window');
});

test('"Page unresponsive": Wait leaves it, it goes away by itself, Exit page stops a page stuck in a loop', async () => {
  await go(`${base}/busy`, 'Page busy');
  // Chromium never reports a page as unresponsive while DevTools is attached
  // to it (it might be paused on a breakpoint), and the test driver is. So
  // the test raises Chromium's event itself; the rest is real.
  const stuck = () => L.main(() => { global.lumio.tabs.wc().emit('unresponsive'); return true; });
  await stuck();
  assert.ok(await waitDialog('unresponsive'));
  assert.match(await dialogText(), /Page unresponsive[\s\S]*You can wait for it to become responsive or exit the page/);
  await shot('72-unresponsive');
  await key('Escape'); // Wait
  assert.ok(await noDialog());
  await stuck();
  assert.ok(await waitDialog('unresponsive'));
  await L.main(() => { global.lumio.tabs.wc().emit('responsive'); return true; });
  assert.ok(await noDialog(), 'gone when the page answers again');
  // A page really stuck in a loop (for a minute at most): the dialog still
  // works, since it isn't part of the page, and Exit page ends it.
  await L.page('setTimeout(() => { const end = Date.now() + 60_000; while (Date.now() < end); }, 0); true');
  await L.wait(300);
  await stuck();
  assert.ok(await waitDialog('unresponsive'));
  await press('exit');
  assert.ok(await until(async () => (await url()).startsWith('lumio://error/?code=hung')), 'the tab says the page stopped responding');
  assert.ok(await until(async () => (await title()) === 'This page stopped responding'));
});

test('HTTP sign-in: the dialog names the site and warns on http; Sign in works, a wrong password asks again, Cancel shows the 401 page', async () => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), `${base}/auth`);
  assert.ok(await waitDialog('auth'));
  const text = await dialogText();
  assert.match(text, /Sign in to access this site/);
  assert.match(text, new RegExp(`Authorization required by ${base.replace(/[.]/g, '\\.')}`));
  assert.match(text, /Your connection to this site is not private/);
  assert.equal(await inDialog('document.querySelector("input[name=password]").type'), 'password');
  await shot('73-sign-in');
  await inDialog('document.querySelector("input[name=username]").value = "ada"; document.querySelector("input[name=password]").value = "s3cret"; true');
  await press('signin');
  assert.ok(await until(async () => (await title()) === 'Signed in as ada'));

  // Another site (localhost isn't 127.0.0.1). A wrong password asks again, saying so.
  const other = base.replace('127.0.0.1', 'localhost');
  await L.main((_e, u) => global.lumio.tabs.navigate(u), `${other}/auth`);
  assert.ok(await waitDialog('auth'));
  assert.match(await dialogText(), new RegExp(`Authorization required by ${other.replace(/[.]/g, '\\.')}`));
  const firstId = await L.main(() => global.lumio.tabs.active.dialogs[0].id);
  await inDialog('document.querySelector("input[name=username]").value = "ada"; document.querySelector("input[name=password]").value = "wrong"; true');
  await press('signin');
  assert.ok(await until(async () => { const id = await L.main(() => global.lumio.tabs.active.dialogs?.[0]?.id ?? null); return id !== null && id !== firstId; }), 'asked again');
  assert.ok(await until(async () => /That username and password didn't work\. Try again\./.test(await dialogText())), 'saying the last try didn’t work');
  assert.equal(await inDialog('document.querySelector("input[name=password]").value'), '', 'the password typed before is gone');
  // Cancel shows the site's own page.
  await press('cancel');
  assert.ok(await until(async () => (await title()) === '401'));
});

test('HTTP sign-in from a frame of another site on the page is refused without asking', async () => {
  await go(`${base}/framed-auth`, 'Framed');
  const frameTitle = () => L.main(() => global.lumio.tabs.wc().mainFrame.frames[0]?.executeJavaScript('document.title') ?? null);
  assert.equal(await until(frameTitle), '401', 'the frame shows the site’s own 401 page');
  assert.equal((await dialog()).kinds.length, 0, 'nobody was asked for a password');
});

test('a bad certificate: "Your connection is not private", Advanced, Proceed only by a real click, then "Not secure"', async (t) => {
  if (!secureBase) { t.skip('openssl not available to make a certificate'); return; }
  await go(`${base}/before-cert`, 'Page before-cert');
  await L.main((_e, u) => global.lumio.tabs.navigate(u), `${secureBase}/`);
  assert.ok(await until(async () => (await url()).startsWith('lumio://error/cert.html')), 'the warning page');
  assert.ok(await until(async () => (await title()) === 'Privacy error'));
  const warning = await L.main(() => global.lumio.tabs.state().tabs.find((t) => t.id === global.lumio.tabs.activeId));
  assert.deepEqual([warning.url, warning.notSecure], [`${secureBase}/`, true], 'the address bar keeps the site, marked not secure');
  assert.ok(await until(() => L.page(`/^NET::ERR_CERT_(AUTHORITY|COMMON_NAME)_INVALID$/.test(document.getElementById('code').textContent)`)));
  assert.equal(await L.page(`document.getElementById('details').hidden && document.getElementById('proceed').getClientRects().length === 0`), true, 'no Proceed in sight before Advanced');
  await L.page(`document.getElementById('advanced').click(); true`);
  assert.ok(await until(() => L.page(`!document.getElementById('proceed').hidden`)), 'Proceed is offered (an IP address can’t use HSTS)');
  assert.match(await L.page(`document.getElementById('cert').innerText`), /Issued to\s+Lumio test/);
  await shot('74-cert-warning');
  // A script can't press it; Lumio AI isn't allowed on the page at all.
  await L.page(`document.getElementById('proceed').click(); true`);
  await L.wait(500);
  assert.ok((await url()).startsWith('lumio://error/cert.html'), 'still on the warning');
  await clickPage('#proceed');
  assert.ok(await until(async () => (await title()) === 'Self-signed page'), 'went past it');
  const state = await L.main(() => global.lumio.tabs.state().tabs.find((t) => t.id === global.lumio.tabs.activeId));
  assert.equal(state.notSecure, true);
  if (!(await until(() => L.shell(`document.getElementById('site-icon').textContent === 'Not secure'`)))) {
    // What the address bar shows instead, and where the keyboard is.
    console.error('site icon:', JSON.stringify(await L.shell(`({ text: document.getElementById('site-icon').textContent, title: document.getElementById('site-icon').title, cls: document.getElementById('site-icon').className, active: document.activeElement?.id || document.activeElement?.tagName, hasFocus: document.hasFocus(), omnibox: document.getElementById('omnibox').className, address: document.getElementById('address').value })`).catch((e) => e.message)),
      JSON.stringify(await L.main(() => ({ pageFocused: global.lumio.tabs.wc().isFocused(), shellFocused: global.lumio.win.webContents.isFocused(), windowFocused: global.lumio.win.isFocused() }))));
  }
  assert.equal(await L.shell(`document.getElementById('site-icon').textContent`), 'Not secure');
  const info = await L.shell(`window.lumio.invoke('site:info')`);
  assert.deepEqual([info.secure, info.certBypass], [false, true]);
  await shot('75-not-secure');

  // "Turn on warnings" in the site information forgets it.
  await L.shell(`window.lumio.send('site:cert-revoke'); true`);
  assert.ok(await until(async () => (await url()).startsWith('lumio://error/cert.html')), 'warned again');
  // Back to safety: the page before the site.
  await L.page(`document.getElementById('back').click(); true`);
  assert.ok(await until(async () => (await title()) === 'Page before-cert'));
});

test('HSTS is recognized from the browser’s own list, so such sites never get "Proceed"', async () => {
  // accounts.google.com is on Chromium's built-in HSTS list: the network stack
  // upgrades it to https before connecting. 127.0.0.1 can't use HSTS.
  const hsts = await L.main(() => {
    const { certErrors, profiles } = global.lumio;
    return Promise.all([certErrors.usesHsts(profiles.normal.session, 'accounts.google.com'), certErrors.usesHsts(profiles.normal.session, '127.0.0.1:443')]);
  });
  assert.deepEqual(hsts, [true, false]);
});
