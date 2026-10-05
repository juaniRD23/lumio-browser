// Links that open another app (main/external-protocols.js): which schemes may
// leave the browser, when Lumio opens the app, asks "Open <App>?" or does
// nothing (Chrome's rules), and what the prompt says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const x = require('../main/external-protocols.js');

test('apps get mailto:, tel:, zoommtg:, slack:…; the browser keeps web schemes; dangerous ones never leave', () => {
  for (const url of ['mailto:ada@example.com', 'tel:+15551234', 'zoommtg://zoom.us/join?confno=1', 'slack://open', 'spotify:track:1', 'msteams:/l/meetup', 'ms-word:ofe|u|https://x.example/a.docx', 'x-apple.systempreferences:com.apple.preference']) {
    assert.equal(x.classify(url), 'external', url);
  }
  for (const url of ['https://example.com/', 'http://a.example', 'about:blank', 'blob:https://a.example/1', 'lumio://settings/', 'chrome-extension://abc/page.html']) {
    assert.equal(x.classify(url), 'web', url);
  }
  // They run code, open files or reach into Windows.
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'view-source:https://a.example', 'vbscript:x', 'shell:startup', 'search-ms:query=x', 'search:query=x', 'ms-msdt:/id', 'ms-officecmd:x', 'ms-settings:privacy', 'ms-appinstaller:?source=x', 'C:/Windows/notepad.exe', 'hcp://x', 'its:x']) {
    assert.equal(x.classify(url), 'blocked', url);
  }
  assert.equal(x.classify(''), 'invalid');
  assert.equal(x.classify('not a url'), 'invalid');
});

test('when Lumio opens the app, asks first, or does nothing', () => {
  const site = 'https://zoom.us';
  const zoom = 'zoommtg://zoom.us/join?confno=1';
  // A page's first one asks; mailto: opens the mail app right away, like Chrome.
  assert.equal(x.decide({ url: zoom, origin: site, topOrigin: site }), 'ask');
  assert.equal(x.decide({ url: 'mailto:ada@example.com', origin: site, topOrigin: site }), 'launch');
  // "Always allow" for this site and scheme.
  assert.equal(x.decide({ url: zoom, origin: site, topOrigin: site, remembered: true }), 'launch');
  // Once a page has launched or asked, the next waits for a click in the page.
  assert.equal(x.decide({ url: zoom, origin: site, topOrigin: site, locked: true }), 'deny');
  assert.equal(x.decide({ url: 'mailto:a@b.c', origin: site, topOrigin: site, locked: true, remembered: true }), 'deny');
  // A frame from another site (an ad) needs a click first; the page's own frames don't.
  assert.equal(x.decide({ url: zoom, origin: 'https://ads.example', topOrigin: site, isMainFrame: false }), 'deny');
  assert.equal(x.decide({ url: zoom, origin: 'https://ads.example', topOrigin: site, isMainFrame: false, activated: true }), 'ask');
  assert.equal(x.decide({ url: zoom, origin: site, topOrigin: site, isMainFrame: false }), 'ask');
  // A frame without a site (a sandboxed frame) only after a click.
  assert.equal(x.decide({ url: zoom, origin: null, topOrigin: site, isMainFrame: false }), 'deny');
  assert.equal(x.decide({ url: zoom, origin: null, topOrigin: site, isMainFrame: false, activated: true }), 'ask');
  // A page with no site yet (a new tab sent on to the app, "Join on Zoom")
  // asks, even for mailto:, and never offers "Always allow".
  assert.equal(x.decide({ url: zoom, origin: null, topOrigin: null }), 'ask');
  assert.equal(x.decide({ url: 'mailto:a@b.c', origin: null, topOrigin: null }), 'ask');
  // Typed in the address bar (or a bookmark): the person asked for it.
  assert.equal(x.decide({ url: zoom, typed: true, locked: true }), 'ask');
  assert.equal(x.decide({ url: 'mailto:a@b.c', typed: true }), 'launch');
  // Never: dangerous or web schemes, however it's asked.
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'search-ms:query=x', 'https://a.example/']) {
    assert.equal(x.decide({ url, typed: true, origin: site, topOrigin: site, activated: true, remembered: true }), 'deny', url);
  }
});

test('the prompt: "Open <App>?", the site in full, the always-allow box, and Cancel as the main button', () => {
  const spec = x.askSpec({ app: 'zoom.us', origin: 'https://zoom.us' });
  assert.deepEqual(spec, {
    kind: 'external',
    title: 'Open zoom.us?',
    message: 'https://zoom.us wants to open this application.',
    checkbox: { label: 'Always allow zoom.us to open links of this type in the associated app' },
    buttons: [{ id: 'open', label: 'Open zoom.us' }, { id: 'cancel', label: 'Cancel', primary: true }],
    cancel: 'cancel',
  });
  // Typed, or a page without a site: nothing to remember. Incognito remembers nothing.
  const typed = x.askSpec({ app: 'Slack', origin: null });
  assert.equal(typed.message, 'A website wants to open this application.');
  assert.equal(typed.checkbox, undefined);
  assert.equal(x.askSpec({ app: 'Slack', origin: 'https://app.slack.com', incognito: true }).checkbox, undefined);
});

test('what reaches the app is escaped; app names and remembered choices', () => {
  assert.equal(x.escapeUrl('mailto:a b@x.com?subject="hi"<x>'), 'mailto:a%20b@x.com?subject=%22hi%22%3Cx%3E');
  assert.equal(x.escapeUrl('zoommtg://zoom.us/join?confno=1&pwd=a%20b#x'), 'zoommtg://zoom.us/join?confno=1&pwd=a%20b#x', 'what is already escaped stays');
  assert.equal(x.escapeUrl('slack://café'), 'slack://caf%C3%A9');
  assert.equal(x.escapeUrl('tel:1\n2'), 'tel:1%0A2');
  assert.equal(x.escapeUrl('tel:\uD800'), null, 'a broken character gives up');
  assert.equal(x.appLabel('zoom.us.app'), 'zoom.us');
  assert.equal(x.appLabel('Slack.exe'), 'Slack');
  assert.equal(x.appLabel(''), '');
  assert.equal(x.permissionKey('ZoomMtg://zoom.us/j'), 'openExternal:zoommtg');
  assert.equal(x.originOf('https://zoom.us/j/1?x=2'), 'https://zoom.us');
  assert.equal(x.originOf('file:///Users/me/a.html'), null);
  assert.equal(x.originOf('about:blank'), null);
});
