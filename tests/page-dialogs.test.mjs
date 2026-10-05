// What pages can ask in their tab (main/page-dialogs.js): alert/confirm/prompt
// named after the site, with "Don't allow … to show more dialogs" from the
// second one in a row, and HTTP sign-in only for the site you're on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const d = require('../main/page-dialogs.js');

// A tab whose dialogs are answered by `answers` (one per dialog, in order).
function tabWith(answers, extra = {}) {
  const asked = [];
  const owner = { ask: async (t, spec) => { asked.push(spec); return answers.shift() || { button: spec.cancel, values: {} }; } };
  return { tab: { owner, ...extra }, asked };
}

test('alert, confirm and prompt name the site and return what the page expects', async () => {
  const { tab, asked } = tabWith([
    { button: 'ok', values: {} },
    { button: 'ok', values: {} },
    { button: 'cancel', values: {} },
    { button: 'ok', values: { value: 'Ada' } },
    { button: 'cancel', values: { value: 'ignored' } },
  ]);
  const url = 'https://shop.example:8443/cart';
  assert.equal(await d.jsDialog(tab, { kind: 'alert', message: 'Saved!', url }), null);
  assert.deepEqual(asked[0], { kind: 'js', title: 'shop.example:8443 says', message: 'Saved!', buttons: [{ id: 'ok', label: 'OK', primary: true }], cancel: 'ok' });
  assert.equal(await d.jsDialog(tab, { kind: 'confirm', message: 'Delete?', url }), true);
  assert.equal(asked[1].cancel, 'cancel', 'Esc cancels a confirm');
  assert.equal(await d.jsDialog(tab, { kind: 'confirm', message: 'Delete?', url }), false);
  assert.equal(await d.jsDialog(tab, { kind: 'prompt', message: 'Name?', value: 'Guest', url }), 'Ada');
  assert.deepEqual(asked[3].fields, [{ name: 'value', type: 'text', label: '', value: 'Guest' }]);
  assert.equal(await d.jsDialog(tab, { kind: 'prompt', message: 'Name?', url }), null);
  // A file on disk has no site to name; Lumio's own pages speak for the browser.
  assert.equal(d.jsDialogSpec({ kind: 'alert', message: 'hi', url: 'file:///Users/me/page.html' }).title, 'This page says');
  assert.equal(d.jsDialogSpec({ kind: 'confirm', message: 'Delete?', url: 'lumio://settings/' }).title, 'Lumio Browser');
});

test('from the second dialog in a row a site can be stopped; then its dialogs return at once', async () => {
  const { tab, asked } = tabWith([{ button: 'ok' }, { button: 'ok', checked: true }]);
  const url = 'https://spam.example/';
  await d.jsDialog(tab, { kind: 'alert', message: 'one', url });
  assert.equal(asked[0].checkbox, undefined, 'not on the first one');
  await d.jsDialog(tab, { kind: 'alert', message: 'two', url });
  assert.deepEqual(asked[1].checkbox, { label: "Don't allow spam.example to show more dialogs" });
  assert.equal(await d.jsDialog(tab, { kind: 'confirm', message: 'three', url }), false);
  assert.equal(await d.jsDialog(tab, { kind: 'prompt', message: 'four', url }), null);
  assert.equal(asked.length, 2, 'blocked: nothing more is shown');
  // Another site in the same tab still can.
  await d.jsDialog(tab, { kind: 'alert', message: 'hello', url: 'https://other.example/' });
  assert.equal(asked.length, 3);
});

test('"in a row" means the same site, soon after the last one', () => {
  const t0 = 1_000_000;
  const a = d.nextStreak(null, 'https://a.example', t0);
  assert.equal(a.count, 1);
  assert.equal(d.nextStreak(a, 'https://a.example', t0 + 2000).count, 2);
  assert.equal(d.nextStreak(a, 'https://b.example', t0 + 2000).count, 1);
  assert.equal(d.nextStreak(a, 'https://a.example', t0 + d.STREAK_MS + 1).count, 1);
});

test('Lumio’s own pages never offer to stop their dialogs', async () => {
  const { tab, asked } = tabWith([{ button: 'ok' }, { button: 'ok' }]);
  await d.jsDialog(tab, { kind: 'confirm', message: 'Delete this workflow?', url: 'lumio://settings/#workflows' });
  await d.jsDialog(tab, { kind: 'confirm', message: 'Delete that one too?', url: 'lumio://settings/#workflows' });
  assert.equal(asked[1].checkbox, undefined);
});

test('a helper AI’s tab answers dialogs itself: nobody is there to', async () => {
  const { tab, asked } = tabWith([], { agent: { name: 'Helper 1' } });
  assert.equal(await d.jsDialog(tab, { kind: 'confirm', message: 'Buy now?', url: 'https://shop.example/' }), false);
  assert.equal(await d.jsDialog(tab, { kind: 'prompt', message: 'Card?', url: 'https://shop.example/' }), null);
  assert.equal(asked.length, 0);
});

test('sign-in dialog: the site asking, a warning on http, the password field, and a retry note', () => {
  const s = d.authSpec({ url: 'http://intranet.example/admin', isProxy: false, host: 'intranet.example', port: 80 });
  assert.equal(s.title, 'Sign in to access this site');
  assert.equal(s.message, 'Authorization required by http://intranet.example');
  assert.equal(s.note, 'Your connection to this site is not private');
  assert.deepEqual(s.fields.map((f) => [f.name, f.type]), [['username', 'text'], ['password', 'password']]);
  assert.deepEqual(s.buttons.map((b) => b.id), ['cancel', 'signin']);
  assert.equal(s.cancel, 'cancel');
  assert.equal(d.authSpec({ url: 'https://secure.example/', host: 'secure.example', port: 443 }).note, undefined);
  assert.match(d.authSpec({ url: 'https://secure.example/', host: 'secure.example', port: 443, retry: true }).error, /didn't work/);
  const proxy = d.authSpec({ url: 'https://any.example/', isProxy: true, host: 'proxy.corp', port: 3128 });
  assert.equal(proxy.title, 'Sign in to the proxy');
  assert.equal(proxy.message, 'The proxy proxy.corp:3128 requires a username and password.');
});

test('only the site you’re on (or going to) and your proxy can ask you to sign in', () => {
  const page = 'https://news.example/today';
  assert.equal(d.authAllowed({ requestUrl: 'https://news.example/api', pageUrl: page }), true);
  assert.equal(d.authAllowed({ requestUrl: 'https://login.example/', pageUrl: page, goingTo: 'https://login.example/' }), true);
  assert.equal(d.authAllowed({ requestUrl: 'https://ads.example/frame', pageUrl: page }), false, 'another site on the page');
  assert.equal(d.authAllowed({ requestUrl: 'https://ads.example/frame', pageUrl: 'lumio://newtab/' }), false);
  assert.equal(d.authAllowed({ requestUrl: 'https://anything.example/', isProxy: true, pageUrl: page }), true);
});

test('signing in returns the typed name and password; Cancel, a helper’s tab or another site return nothing', async () => {
  const details = { url: 'https://intranet.example/', firstAuthAttempt: true };
  const authInfo = { isProxy: false, host: 'intranet.example', port: 443 };
  const view = (url) => ({ webContents: { getURL: () => url } });
  let t = tabWith([{ button: 'signin', values: { username: 'ada', password: 's3cret' } }], { view: view('https://intranet.example/home') });
  assert.deepEqual(await d.signIn(t.tab, { details, authInfo }), { username: 'ada', password: 's3cret' });
  t = tabWith([{ button: 'cancel', values: { username: 'ada', password: 'x' } }], { view: view('https://intranet.example/home') });
  assert.equal(await d.signIn(t.tab, { details, authInfo }), null);
  t = tabWith([], { view: view('https://intranet.example/'), agent: { name: 'Helper 1' } });
  assert.equal(await d.signIn(t.tab, { details, authInfo }), null);
  assert.equal(t.asked.length, 0);
  t = tabWith([], { view: view('https://elsewhere.example/') });
  assert.equal(await d.signIn(t.tab, { details, authInfo }), null);
  assert.equal(t.asked.length, 0, 'not even asked');
});
