// Crash reports in the real app (main/crash-reports.js), against a stand-in
// for the Lumio server's POST /api/crash:
//   - off by default: Crashpad doesn't run and errors aren't sent; the switch
//     in Settings turns it on for the next launch, and so does the one on the
//     welcome screens; no other page can change it;
//   - on: Crashpad runs with only Lumio's annotations, a main-process error
//     and a page whose process died are posted as JSON without page data,
//     turning it off stops uploads at once;
//   - a crash of the main process uploads a minidump (last: it ends the app).
// Run: node --test tests/e2e/crash-reports.e2e.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { launch, root } from '../../scripts/launch.mjs';

let L;
let server;
let base;
let profile;
const got = []; // what reached /api/crash: { kind: 'json' | 'dump' | 'unreadable', data, fields, url }
const SECRET_TITLE = 'Statement for Sam Rivera';

const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
};
const page = (code) => L.page(code);
const openSettings = async () => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), 'lumio://settings/#privacy');
  assert.ok(await until(() => page(`!!document.getElementById('crash-reports') && document.readyState === 'complete'`)));
  await L.wait(300); // crash-optin.js asked the browser for the setting
};
const switchOn = () => page(`document.getElementById('crash-reports').checked`);
const toggle = () => page(`document.getElementById('crash-reports').click(); true`);
const note = () => page(`document.getElementById('crash-note').textContent`);
const relaunch = async () => {
  await L?.close();
  L = await launch({ profile, env: { LUMIO_ACCOUNT_BASE: base, LUMIO_AI_BASE: base } });
  await until(() => L.main(() => !!global.lumio.tabs?.active), 15_000);
};

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = Buffer.concat(chunks);
    // Crashpad adds ?product=…&version=…&guid=… to the submit URL (its
    // identify_client_via_url default), so match the path like the server does.
    if (new URL(req.url, base).pathname === '/api/crash' && req.method === 'POST') {
      try {
        if (body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
        const type = req.headers['content-type'] || '';
        if (type.startsWith('multipart/form-data')) {
          const form = await new Response(body, { headers: { 'content-type': type } }).formData();
          const fields = {};
          let dump = null;
          for (const [k, v] of form) { if (typeof v === 'string') fields[k] = v; else dump = Buffer.from(await v.arrayBuffer()); }
          got.push({ kind: 'dump', fields, dump, raw: body.toString('latin1'), url: req.url });
        } else got.push({ kind: 'json', data: JSON.parse(body.toString()), raw: body.toString(), headers: req.headers, url: req.url });
      } catch (err) {
        // Answer anyway, so Crashpad doesn't sit on the request until it times out.
        got.push({ kind: 'unreadable', error: String(err), type: req.headers['content-type'], url: req.url });
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('unreadable');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('cr_' + '0'.repeat(24));
      return;
    }
    // A page with things that must never reach a crash report.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>${SECRET_TITLE}</title><h1>Account 4242</h1>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-crash-e2e-'));
  await relaunch();
});

after(async () => {
  await Promise.race([L?.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  server?.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('off by default: no crash reporter, nothing sent; turning it on waits for the next launch', async () => {
  assert.equal(await L.main(() => global.lumio.store.settings.crashReports), undefined);
  await L.main(() => { setTimeout(() => { throw new Error('not reported'); }); return true; });
  await openSettings();
  assert.equal(await switchOn(), false);
  assert.equal(await note(), '');
  await toggle();
  assert.equal(await until(async () => (await note()) === 'Starts the next time you open Lumio.'), true);
  assert.equal(await L.main(() => global.lumio.store.settings.crashReports), true);
  await L.wait(500);
  assert.deepEqual(got, [], 'nothing was sent while it was off');
});

const crashSetting = () => L.main(() => global.lumio.store.settings.crashReports);

test('the welcome screens offer the same switch, and it changes the same setting', async () => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), 'lumio://welcome/');
  assert.ok(await until(() => page(`!!document.getElementById('crash-reports') && document.readyState === 'complete'`)));
  assert.equal(await until(switchOn), true, 'on, as Settings left it');
  assert.equal(await note(), 'Starts the next time you open Lumio.');
  await toggle();
  assert.equal(await until(async () => (await crashSetting()) === false), true, 'off from the welcome screen');
  assert.equal(await note(), '');
  await toggle();
  assert.equal(await until(async () => (await crashSetting()) === true), true, 'and on again');
  assert.deepEqual(got, [], 'still nothing sent before the next launch');
});

test('only Settings and the welcome screens can change it, and websites can’t reach it at all', async () => {
  await L.main((_e, u) => global.lumio.tabs.navigate(u), 'lumio://history/');
  assert.ok(await until(() => page(`document.readyState === 'complete' && !!window.lumioPage`)));
  const answer = await page(`window.lumioPage.invoke('page:set-crash-reports', false).then(() => 'changed', (e) => String(e?.message || e))`);
  assert.match(answer, /Not allowed/);
  assert.equal(await crashSetting(), true, 'unchanged');
  await L.main((_e, u) => global.lumio.tabs.navigate(u), `${base}/statement`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())) === SECRET_TITLE));
  assert.equal(await page(`typeof window.lumioPage`), 'undefined');
});

test('on: Crashpad runs with only Lumio’s version, platform, arch and channel', async () => {
  await L.main(() => global.lumio.store.flushAll());
  await relaunch();
  const params = await L.main(({ crashReporter }) => ({ params: crashReporter.getParameters(), upload: crashReporter.getUploadToServer() }));
  assert.equal(params.upload, true);
  // The full set is checked on a real upload (last test); what's visible here must match it.
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  for (const [k, v] of Object.entries({ version: pkg.version, platform: process.platform, arch: process.arch, channel: 'dev', _companyName: 'Lumio' })) {
    if (k in params.params) assert.equal(params.params[k], v, k);
  }
  assert.doesNotMatch(JSON.stringify(params.params), /https?:|lumio:\/\/|@/, 'no addresses or emails in the annotations');
  await openSettings();
  assert.equal(await switchOn(), true);
  assert.equal(await note(), '');
});

test('a main-process error is posted as JSON, with Lumio’s own file paths only', async () => {
  await L.main((_e, home) => { setTimeout(() => { throw new Error(`boom for sam@example.com at https://secret.example/acct?id=9 in ${home}/x.json`); }); return true; }, os.homedir());
  const r = await until(async () => got.find((g) => g.kind === 'json' && g.data.type === 'js'));
  assert.ok(r, 'the report arrived');
  assert.equal(r.data.reason, 'uncaughtException');
  assert.equal(r.data.process, 'browser');
  assert.equal(r.data.channel, 'dev');
  assert.equal(r.headers.cookie, undefined, 'never the account');
  assert.doesNotMatch(r.raw, /sam@example|secret\.example|acct/);
  assert.ok(!r.raw.includes(os.homedir()), 'no home folder');
  assert.ok(!r.raw.includes(root) && !r.raw.includes(root.replace(/\\/g, '\\\\')), 'no absolute app path');
  assert.match(r.data.stack, /^Error: boom for <email> at <url> in <path>/);
});

test('a page whose process died is posted by kind and reason, never its address or title', async () => {
  await L.main(() => global.lumio.cmd.newTab());
  await L.main((_e, u) => global.lumio.tabs.navigate(u), `${base}/statement?acct=4242`);
  assert.ok(await until(async () => (await L.main(() => global.lumio.tabs.wc().getTitle())) === SECRET_TITLE));
  await L.main(() => { global.lumio.tabs.wc().forcefullyCrashRenderer(); return true; });
  const r = await until(async () => got.find((g) => g.kind === 'json' && g.data.type === 'gone' && g.data.process === 'renderer'));
  assert.ok(r, 'the report arrived');
  assert.equal(r.data.where, 'page');
  assert.ok(['killed', 'crashed', 'abnormal-exit'].includes(r.data.reason), r.data.reason);
  assert.doesNotMatch(r.raw, /Statement|Rivera|4242|127\.0\.0\.1|statement/);
});

test('turning it off stops uploads right away', async () => {
  await openSettings();
  await toggle();
  assert.equal(await until(async () => (await note()) === 'Off. Lumio won’t send any more reports.'), true);
  assert.equal(await L.main(({ crashReporter }) => crashReporter.getUploadToServer()), false);
  const before = got.length;
  await L.main(() => { setTimeout(() => { throw new TypeError('after turning it off'); }); return true; });
  await L.wait(1500);
  assert.equal(got.length, before);
  await toggle(); // back on for the last test
  assert.equal(await L.main(({ crashReporter }) => crashReporter.getUploadToServer()), true);
});

test('a crash of the main process uploads a minidump with Lumio’s annotations', async () => {
  await L.main(() => { setTimeout(() => process.crash(), 200); return true; });
  const r = await until(async () => got.find((g) => g.kind === 'dump' && g.fields.process_type === 'browser'), 45_000);
  assert.ok(r, `Crashpad uploaded the dump (got: ${JSON.stringify(got.map((g) => ({ kind: g.kind, url: g.url, process: g.fields?.process_type ?? g.data?.process, error: g.error })))})`);
  assert.equal(r.dump.subarray(0, 4).toString('latin1'), 'MDMP');
  assert.equal(r.fields._productName, 'Lumio Browser');
  assert.equal(r.fields._companyName, 'Lumio');
  assert.equal(r.fields.channel, 'dev');
  assert.equal(r.fields.platform, process.platform);
  assert.equal(r.fields.arch, process.arch);
  assert.ok(!Object.values(r.fields).some((v) => /https?:\/\/|Statement|@example/.test(v)), 'no page data in the annotations');
  // The query Crashpad adds names only the product, its version and the install's ID.
  assert.deepEqual([...new URL(r.url, base).searchParams.keys()].filter((k) => !['product', 'version', 'guid'].includes(k)), [], r.url);
});
