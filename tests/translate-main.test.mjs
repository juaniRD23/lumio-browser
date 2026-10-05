// Translating pages, the main-process side (main/translate.js), with a
// stand-in tab, page and Lumio server: when to offer, the always / never
// choices, incognito, signing in, the batches sent to /v1/translate and what
// comes back, errors, and the right-click menu. Also reading mode's settings
// and menu (main/reader.js).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Translator } = require('../main/translate.js');
const { Reader, cleanPrefs } = require('../main/reader.js');

const FRENCH = 'Les phares guident les navires depuis plus de deux mille ans. Le phare d’Alexandrie mesurait plus de cent mètres et il était une des sept merveilles du monde. Les gardiens vivaient souvent sur place avec leur famille.';
const ENGLISH = 'Lighthouses have guided ships for more than two thousand years. The one in Alexandria was over a hundred metres tall, and it was one of the seven wonders of the world.';
const tick = () => new Promise((r) => setTimeout(r, 15));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(); } };

// Every stand-in page closes after its test, which ends its translating loop.
const pages = [];
afterEach(() => { for (const p of pages.splice(0)) p.closed = true; });

// A stand-in for one tab, its page (the in-page script answers from `batches`),
// its window and the Lumio server.
function setup({ sample = FRENCH, htmlLang = 'fr', incognito = false, signedIn = true, prefs, server, url = 'https://phares.example/histoire' } = {}) {
  const runs = [];
  const emitted = [];
  const requests = [];
  const handlers = {};
  const batches = [{ blocks: [{ id: 1, texts: ['Bonjour'] }, { id: 2, texts: ['Cliquez', 'ici'] }] }];
  const wc = {
    closed: false,
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
    isDestroyed: () => wc.closed,
    getURL: () => url,
    async executeJavaScriptInIsolatedWorld(_world, [{ code }]) {
      if (code.startsWith('(function languageSample')) return { htmlLang, sample };
      const rest = code.slice(code.lastIndexOf(')("') + 3, -1);
      const cmd = rest.slice(0, rest.indexOf('"'));
      runs.push([cmd, JSON.parse(rest.slice(rest.indexOf('", ') + 3))]);
      if (cmd === 'collect') return batches.shift() || { blocks: [] };
      return {};
    },
  };
  pages.push(wc);
  const owner = { incognito, activeId: 1, changes: 0, changed() { this.changes++; }, emit: (c, p) => emitted.push([c, p]), displayUrl: () => url };
  const tab = { id: 1, owner, view: { webContents: wc } };
  const overlaySent = [];
  const w = {
    incognito, overlayKind: null, hidden: 0,
    tabs: { activeId: 1, active: tab, get: (id) => (id === 1 ? tab : null), displayUrl: () => url },
    overlay: { webContents: { send: (_c, p) => overlaySent.push(p) } },
    hideOverlay() { this.hidden++; this.overlayKind = null; },
    emit: (c, p) => emitted.push([c, p]),
  };
  const store = { settings: prefs ? { translate: prefs } : {}, setSetting(k, v) { this.settings[k] = v; } };
  const account = {
    aiBase: 'https://lumio.test',
    token: () => (signedIn ? 'tok' : ''),
    refresh: async () => {},
    fetch: async (u, opts) => {
      const body = JSON.parse(opts.body);
      requests.push({ url: u, body, auth: opts.headers.Authorization });
      if (server) return server(body);
      return Response.json({ translations: body.blocks.map((b) => b.map((t) => `[en] ${t}`)) });
    },
  };
  const tr = new Translator({ store, account, windowOf: () => w, languages: () => ['en-US'], pollMs: 10 });
  tr.wire(tab);
  const fire = (ev, ...args) => (handlers[ev] || []).forEach((fn) => fn({}, ...args));
  const probe = () => tr.probe(tab, wc);
  return { tr, tab, wc, w, store, runs, emitted, requests, batches, overlaySent, fire, probe };
}
const prompts = (s) => s.emitted.filter(([c]) => c === 'translate-prompt');

test('a page in another language offers translating once; one in your language doesn’t', async () => {
  const s = setup();
  await s.probe();
  assert.deepEqual(s.tab.translate.lang, 'fr');
  assert.equal(s.tab.translate.status, 'offer');
  assert.equal(s.tab.translate.target, 'en');
  assert.deepEqual(prompts(s), [['translate-prompt', { tabId: 1 }]]);
  await s.probe(); // a single-page app changed the page: no second bubble
  assert.equal(prompts(s).length, 1);
  // A new page in the same tab starts over.
  s.fire('did-navigate');
  assert.equal(s.tab.translate, null);

  const en = setup({ sample: ENGLISH, htmlLang: 'en' });
  await en.probe();
  assert.equal(en.tab.translate.status, null);
  assert.equal(prompts(en).length, 0);
  // <html lang> says French but the text is clearly English: no offer.
  const wrong = setup({ sample: ENGLISH, htmlLang: 'fr' });
  await wrong.probe();
  assert.equal(wrong.tab.translate.status, null);
});

test('Translate sends what’s on screen to /v1/translate, shows it, and Show original puts it back', async () => {
  const s = setup();
  await s.probe();
  await s.tr.act(s.w, { action: 'translate', tabId: 1 });
  await until(() => s.tab.translate.status === 'translated');
  assert.equal(s.requests.length, 1);
  assert.deepEqual(s.requests[0], { url: 'https://lumio.test/v1/translate', auth: 'Bearer tok', body: { target: 'en', source: 'fr', blocks: [['Bonjour'], ['Cliquez', 'ici']] } });
  const apply = s.runs.find(([c]) => c === 'apply')[1];
  assert.deepEqual(apply.results, [{ id: 1, texts: ['[en] Bonjour'] }, { id: 2, texts: ['[en] Cliquez', '[en] ici'] }]);
  assert.equal(s.runs[0][0], 'start');
  // It keeps looking for new text as the page scrolls.
  const collects = () => s.runs.filter(([c]) => c === 'collect').length;
  const n = collects();
  await until(() => collects() > n + 2);
  await s.tr.act(s.w, { action: 'original', tabId: 1 });
  assert.equal(s.tab.translate.status, 'offer');
  assert.ok(s.runs.some(([c]) => c === 'restore'));
  const stopped = collects();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(collects(), stopped, 'it stops looking after Show original');
});

test('Always translate runs by itself, except in incognito; Never and Never this site stop the offer', async () => {
  const always = setup({ prefs: { always: ['fr'] } });
  await always.probe();
  await until(() => always.requests.length === 1);
  assert.equal(prompts(always).length, 0, 'no bubble: it just translates');
  // Show original sticks on that page, even when a single-page app changes it.
  await always.tr.act(always.w, { action: 'original', tabId: 1 });
  always.batches.push({ blocks: [{ id: 5, texts: ['Encore'] }] });
  await always.probe();
  await tick();
  assert.equal(always.requests.length, 1);
  assert.equal(always.tab.translate.status, 'offer');
  assert.equal(prompts(always).length, 0, 'and no bubble either');

  const incognito = setup({ prefs: { always: ['fr'] }, incognito: true });
  await incognito.probe();
  await tick();
  assert.equal(incognito.requests.length, 0, 'incognito only translates when asked');
  assert.equal(prompts(incognito).length, 1);

  const s = setup();
  await s.probe();
  await s.tr.act(s.w, { action: 'never', tabId: 1, value: true });
  assert.deepEqual(s.store.settings.translate.never, ['fr']);
  assert.equal(s.tab.translate.status, 'never');
  const next = setup({ prefs: s.store.settings.translate });
  await next.probe();
  assert.equal(next.tab.translate.status, 'never');
  assert.equal(prompts(next).length, 0);
  // Always and Never for one language rule each other out.
  await s.tr.act(s.w, { action: 'always', tabId: 1, value: true });
  assert.deepEqual([s.store.settings.translate.always, s.store.settings.translate.never], [['fr'], []]);

  const site = setup();
  await site.probe();
  await site.tr.act(site.w, { action: 'never-site', tabId: 1, value: true });
  assert.deepEqual(site.store.settings.translate.sites, ['phares.example']);
  assert.equal(site.tab.translate.status, 'never');
  // Incognito never remembers a site.
  const inc = setup({ incognito: true });
  await inc.probe();
  await inc.tr.act(inc.w, { action: 'never-site', tabId: 1, value: true });
  assert.equal(inc.store.settings.translate, undefined);
});

test('after a few “Not now”s for a language, Lumio only shows the button', async () => {
  let prefs;
  for (let i = 0; i < 3; i++) {
    const s = setup({ prefs });
    await s.probe();
    assert.equal(prompts(s).length, 1);
    s.w.overlayKind = 'translate';
    await s.tr.act(s.w, { action: 'dismiss', tabId: 1, refocus: true });
    assert.equal(s.w.hidden, 1);
    assert.deepEqual(s.emitted.at(-1), ['overlay-picked', { kind: 'translate', refocus: true }]);
    prefs = s.store.settings.translate;
  }
  assert.deepEqual(prefs.declined, { fr: 3 });
  const quiet = setup({ prefs });
  await quiet.probe();
  assert.equal(quiet.tab.translate.status, 'offer', 'the button is still there');
  assert.equal(prompts(quiet).length, 0);
});

test('signed out it asks to sign in; server errors show in the bubble and the batch can be sent again', async () => {
  const out = setup({ signedIn: false });
  await out.probe();
  await out.tr.act(out.w, { action: 'translate', tabId: 1 });
  assert.equal(out.tab.translate.status, 'signin');
  assert.equal(out.requests.length, 0);
  assert.equal(out.tr.bubble(out.w, out.tab).signedIn, false);

  const s = setup({ server: () => Response.json({ error: 'You’ve used your Lumio AI allowance on the Free plan for now.', code: 'usage_limit' }, { status: 429 }) });
  await s.probe();
  s.w.overlayKind = 'translate';
  await s.tr.act(s.w, { action: 'translate', tabId: 1 });
  await until(() => s.tab.translate.status === 'error');
  assert.match(s.tab.translate.error, /allowance/);
  assert.deepEqual(s.runs.find(([c]) => c === 'release')[1], { ids: [1, 2] });
  // The open bubble heard about it.
  assert.equal(s.overlaySent.at(-1).status, 'error');
  assert.match(s.overlaySent.at(-1).error, /allowance/);
});

test('choosing another language translates the page again into it', async () => {
  const s = setup();
  await s.probe();
  await s.tr.act(s.w, { action: 'translate', tabId: 1 });
  await until(() => s.tab.translate.status === 'translated');
  await s.tr.act(s.w, { action: 'target', tabId: 1, value: 'es' });
  s.batches.push({ blocks: [{ id: 1, texts: ['Bonjour'] }] }); // the page hands out its text again
  assert.ok(s.runs.some(([c]) => c === 'reset'));
  await until(() => s.requests.length === 2);
  assert.equal(s.requests[1].body.target, 'es');
  assert.equal(s.store.settings.translate.target, 'es');
  const b = s.tr.bubble(s.w, s.tab);
  assert.equal(b.target, 'es');
  assert.ok(b.languages.includes('en') && b.languages[0] === 'es');
  await s.tr.act(s.w, { action: 'original', tabId: 1 });
});

test('right-click on a page: Translate to English, or Show Original; nothing on links or text fields', async () => {
  const s = setup();
  await s.probe();
  const page = { mediaType: 'none' };
  assert.deepEqual(s.tr.menuItems(s.w, s.tab, page).map((i) => i.label), ['Translate to English']);
  assert.deepEqual(s.tr.menuItems(s.w, s.tab, { ...page, linkURL: 'https://x.example/' }), []);
  assert.deepEqual(s.tr.menuItems(s.w, s.tab, { ...page, isEditable: true }), []);
  s.tab.translate.on = true;
  assert.deepEqual(s.tr.menuItems(s.w, s.tab, page).map((i) => i.label), ['Show Original']);
  // A page already in English has nothing to offer.
  const en = setup({ sample: ENGLISH, htmlLang: 'en' });
  await en.probe();
  assert.deepEqual(en.tr.menuItems(en.w, en.tab, page), []);
  // From the menu while signed out: the bubble opens to say why.
  const out = setup({ signedIn: false });
  await out.probe();
  out.emitted.length = 0;
  out.tr.menuItems(out.w, out.tab, page)[0].click();
  await tick();
  assert.equal(out.tab.translate.status, 'signin');
  assert.deepEqual(prompts(out), [['translate-prompt', { tabId: 1 }]]);
});

test('reading mode keeps only known settings, and offers itself on web pages', async () => {
  assert.deepEqual(cleanPrefs({ font: 'serif', size: 99, spacing: 'wide', theme: 'sepia', speed: 1.5, evil: true }), { font: 'serif', size: 17, spacing: 'normal', theme: 'sepia', speed: 1.5 });
  const store = { settings: {}, setSetting(k, v) { this.settings[k] = v; } };
  const reader = new Reader({ store });
  assert.deepEqual(reader.setPrefs({ size: 20, theme: 'dark' }), { font: 'sans', size: 20, spacing: 'normal', theme: 'dark', speed: 1 });
  assert.equal(store.settings.reader.size, 20);
  const emitted = [];
  const w = { tabs: { displayUrl: (t) => t.url }, win: { webContents: { focus: () => emitted.push('focus') } }, emit: (c, p) => emitted.push([c, p]) };
  const tab = { id: 4, url: 'https://news.example/a', view: {} };
  const items = reader.menuItems(w, tab, { mediaType: 'none', selectionText: 'some text' });
  assert.deepEqual(items.map((i) => i.label), ['Open in Reading Mode']);
  items[0].click();
  assert.deepEqual(emitted, ['focus', ['reader-open', { tabId: 4 }]]);
  assert.deepEqual(reader.menuItems(w, { ...tab, url: 'lumio://settings/' }, { mediaType: 'none' }), []);
  // A PDF, or a page without an article, says why.
  const wc = { isDestroyed: () => false, getURL: () => tab.url, executeJavaScriptInIsolatedWorld: async () => null };
  const none = await reader.article(w, { ...tab, view: { webContents: wc } });
  assert.deepEqual([none.ok, none.reason], [false, 'Lumio couldn’t find an article on this page.']);
  const pdf = await reader.article(w, { ...tab, pdf: true, view: { webContents: wc } });
  assert.match(pdf.reason, /PDFs/);
});
