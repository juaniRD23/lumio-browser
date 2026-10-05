// Lumio's UI in Spanish (renderer/assets/i18n, main/i18n.js): the lookup,
// the table, the language Lumio picks, menus and dialogs, and every page and
// popup of the browser served in Spanish in headless Chrome with a stand-in
// for the browser: nothing that has a translation is left in English, and
// what people wrote (tab titles, bookmarks, names) is never translated.
// The headless part is skipped when Google Chrome isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../renderer/assets/i18n/i18n.js');
const es = require('../renderer/assets/i18n/es.js');
const i18n = require('../main/i18n.js');
const { resolveFile, CSP, PAGE_HOSTS } = require('../main/protocol.js');

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const skip = !CHROME && 'Google Chrome not installed';
const ES = core.compile(es);
const tr = (s) => core.translate(ES, s);

// ---------------------------------------------------------------- the lookup
test('the lookup: exact text, spacing and quotes, shortcuts, patterns', () => {
  const c = core.compile({
    'Save': 'Guardar',
    "Can't open this page": 'No se puede abrir',
    'Back': 'Atrás',
    'Delete “{name}”?': '¿Borrar “{name}”?',
    '{#n} pages': '{n} páginas',
    'Paused': 'En pausa',
    'Next: {@when} at {time}': 'Próxima: {when} a las {time}',
    'today': 'hoy',
    'Imported {@what}.': 'Se importó: {what}.',
    '{#n} bookmarks': '{n} favoritos',
    'Lumio {plan}': 'Lumio {plan}',
    'Lumio Browser {v} is here': 'Ya llegó Lumio Browser {v}',
    'Settings': 'Configuración',
  });
  const t = (s) => core.translate(c, s);
  assert.equal(t('Save'), 'Guardar');
  assert.equal(t('  Save\n'), '  Guardar\n', 'the spaces around it stay');
  assert.equal(t('Can’t   open this page'), 'No se puede abrir', 'curly quotes and extra spaces match');
  assert.equal(t('Back (⌘[)'), 'Atrás (⌘[)', 'a shortcut after the words stays');
  assert.equal(t('Settings:'), 'Configuración:');
  assert.equal(t('Delete “Work”?'), '¿Borrar “Work”?', 'what fills a placeholder is kept as is');
  assert.equal(t('12 pages'), '12 páginas');
  assert.equal(t('twelve pages'), 'twelve pages', '{#n} is a number');
  assert.equal(t('Paused · 2 MB'), 'En pausa · 2 MB', 'parts joined with " · "');
  assert.equal(t('Next: today at 8:00'), 'Próxima: hoy a las 8:00', '{@…} is translated too');
  assert.equal(t('Next: Mon 6 at 8:00'), 'Próxima: Mon 6 a las 8:00');
  assert.equal(t('Imported 3 bookmarks, 1 item.'), 'Se importó: 3 favoritos, 1 item.', 'lists of translated texts');
  assert.equal(t('Lumio Browser 1.2 is here'), 'Ya llegó Lumio Browser 1.2', 'the most specific pattern wins');
  assert.equal(t('Guardar'), 'Guardar');
  assert.equal(t('Configuración'), 'Configuración', 'a translation is never translated again');
  assert.equal(t('12'), '12');
  assert.equal(t('x'.repeat(5000)), 'x'.repeat(5000));
  assert.equal(tr('Tab: News\nIncognito tab: Settings'), 'Pestaña: News\nPestaña de incógnito: Settings', 'each line on its own; titles stay');
});

// ---------------------------------------------------------------- the table
test('the Spanish table: placeholders kept, written for people', () => {
  const names = (s) => [...new Set([...s.matchAll(/\{[#@]?(\w+)\}/g)].map((m) => m[1]))].sort().join(',');
  for (const [en, out] of Object.entries(es)) {
    assert.equal(names(out), names(en), `“${en}” keeps its placeholders`);
    assert.equal(en, en.trim(), `“${en}” has no spaces around it`);
    assert.doesNotMatch(out, /\b(vosotros|ordenador|móvil|podéis|tenéis|vuestr)/i, `“${out}”: neutral Latin American Spanish`);
    assert.doesNotMatch(out, /\b(podés|tenés|querés|hacé|elegí)\b/, `“${out}”: tú, not vos`);
  }
  assert.ok(Object.keys(es).length > 1200);
});

// Brand and product names, and text that's the same in Spanish.
const SAME = new Set(['Lumio', 'Lumio Browser', 'Lumio AI', 'Lumio AI (⌘⇧L)', 'Beta', 'Auto', 'Chat', 'Chats', 'Mac', 'Color', 'CPU', 'A3', 'A4', 'A5', 'Chrome Web Store', 'Browser', 'Touch ID', 'Windows Hello', 'English', 'Español', 'example.com', 'Lumio Browser Safe Storage']);

// Every text and label in the pages' HTML has a translation.
test('every text in Lumio’s pages and windows has a Spanish translation', () => {
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'label'];
  const missing = [];
  for (const dir of ['renderer/ui', 'renderer/pages']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(ROOT, dir, f), 'utf8').replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<svg\b[\s\S]*?<\/svg>/gi, '');
      const texts = html.replace(/<[^>]*>/g, '\u0000').split('\u0000').map((s) => s.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
      for (const m of html.matchAll(/<[a-z][^>]*>/gi)) for (const a of ATTRS) { const v = new RegExp(`\\s${a}="([^"]*)"`).exec(m[0]); if (v) texts.push(v[1]); }
      for (const s of texts) {
        if (!/[A-Za-z]{2}/.test(s) || SAME.has(s)) continue;
        if (tr(s) === s) missing.push(`${f}: ${s}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

// ---------------------------------------------------------------- choosing the language
test('Lumio’s language: the setting, else the computer’s, else English', () => {
  const env = {};
  assert.equal(i18n.systemLanguage(['fr-FR', 'es-AR', 'en-US']), 'es', 'the first one Lumio speaks');
  assert.equal(i18n.systemLanguage(['de-DE']), 'en');
  assert.equal(i18n.systemLanguage(['ES_mx']), 'es');
  assert.equal(i18n.choose('system', ['es-419'], env), 'es');
  assert.equal(i18n.choose('en', ['es-419'], env), 'en', 'the setting wins');
  assert.equal(i18n.choose('es', ['en-US'], env), 'es');
  assert.equal(i18n.choose('xx', ['en-US'], env), 'en', 'an unknown setting is System');
  assert.equal(i18n.choose('es', [], { LUMIO_TEST: '1' }), 'en', 'tests run in English');
  assert.equal(i18n.choose('en', [], { LUMIO_TEST: '1', LUMIO_LANG: 'es' }), 'es', 'unless they ask');
  assert.equal(i18n.chromiumLocale('es', ['en-US', 'es-AR']), 'es-AR', 'the computer’s own variant');
  assert.equal(i18n.chromiumLocale('es', ['en-US']), 'es-419');
});

// A stand-in for Electron's app, Menu and dialog.
function fakeElectron(preferred) {
  const switches = [];
  const built = [];
  const shown = [];
  const app = { getPreferredSystemLanguages: () => preferred, commandLine: { appendSwitch: (k, v) => switches.push([k, v]) } };
  const Menu = { buildFromTemplate: (t) => { built.push(t); return t; } };
  const dialog = {
    showMessageBox: (a, b) => { shown.push(b ?? a); return Promise.resolve({ response: 0 }); },
    showMessageBoxSync: (a, b) => { shown.push(b ?? a); return 0; },
    showOpenDialog: (a, b) => { shown.push(b ?? a); return Promise.resolve({ canceled: true }); },
    showOpenDialogSync: () => null,
    showSaveDialog: (a, b) => { shown.push(b ?? a); return Promise.resolve({ canceled: true }); },
    showSaveDialogSync: () => null,
    showErrorBox: (title, content) => shown.push({ title, content }),
  };
  return { app, Menu, dialog, switches, built, shown };
}

test('in Spanish, menus and dialogs Lumio builds come out in Spanish', async () => {
  const saved = { LUMIO_TEST: process.env.LUMIO_TEST, LUMIO_LANG: process.env.LUMIO_LANG };
  delete process.env.LUMIO_TEST;
  delete process.env.LUMIO_LANG;
  try {
    // English on an English computer: nothing changes, Chromium is left alone.
    let e = fakeElectron(['en-US']);
    assert.equal(i18n.init(e.app, 'system', e), 'en');
    assert.deepEqual(e.switches, []);
    assert.equal(i18n.t('Save'), 'Save');
    // A French computer: Lumio speaks English and leaves Chromium in French.
    e = fakeElectron(['fr-FR']);
    assert.equal(i18n.init(e.app, 'system', e), 'en');
    assert.deepEqual(e.switches, []);
    // Spanish picked in Settings: Chromium too, in the computer's variant.
    e = fakeElectron(['en-US', 'es-MX']);
    assert.equal(i18n.init(e.app, 'es', e), 'es');
    assert.deepEqual(e.switches, [['lang', 'es-MX']]);
    assert.equal(i18n.lang(), 'es');
    assert.equal(i18n.t('Save'), 'Guardar');

    const menu = e.Menu.buildFromTemplate([
      { label: 'File', submenu: [{ label: 'New Tab', accelerator: 'CmdOrCtrl+T' }, { type: 'separator' }, { role: 'quit' }, { label: 'Bookmark this page', sublabel: 'Save', toolTip: 'Close' }] },
      { role: 'copy' },
      { label: 'Search Google for “hola”' },
    ]);
    assert.equal(menu[0].label, 'Archivo');
    assert.equal(menu[0].submenu[0].label, 'Nueva pestaña');
    assert.equal(menu[0].submenu[0].accelerator, 'CmdOrCtrl+T');
    assert.deepEqual(menu[0].submenu[1], { type: 'separator' });
    assert.equal(menu[0].submenu[2].label, 'Salir de Lumio Browser', 'roles get a Spanish label');
    assert.equal(menu[0].submenu[3].sublabel, 'Guardar');
    assert.equal(menu[1].label, 'Copiar');
    assert.equal(menu[2].label, 'Buscar “hola” en Google');
    // What people wrote or picked stays as it is: a bookmark named "Settings",
    // a spelling suggestion. An extension's ready-made item passes through.
    class MenuItem { constructor(o) { Object.assign(this, o); } }
    const ready = new MenuItem({ label: 'Settings' });
    const mine = e.Menu.buildFromTemplate([{ label: 'Settings', translate: false, click() {} }, { label: 'Bookmarks', translate: false, submenu: [{ label: 'Delete' }] }, ready]);
    assert.equal(mine[0].label, 'Settings');
    assert.equal('translate' in mine[0], false, 'Electron doesn’t get the mark');
    assert.equal(mine[1].label, 'Bookmarks');
    assert.equal(mine[1].submenu[0].label, 'Borrar', 'its submenu is still Lumio’s');
    assert.equal(mine[2], ready);
    assert.equal(i18n.t('2 Tabs (Settings)'), '2 pestañas (Settings)', 'a closed window in History');

    await e.dialog.showMessageBox({}, { message: 'Export passwords?', detail: 'It doesn’t ask for any special permissions.', buttons: ['Export', 'Cancel'], checkboxLabel: 'Never' });
    assert.deepEqual(e.shown.at(-1), { message: '¿Exportar las contraseñas?', detail: 'No pide ningún permiso especial.', buttons: ['Exportar', 'Cancelar'], checkboxLabel: 'Nunca' });
    await e.dialog.showOpenDialog({ title: 'Images', filters: [{ name: 'Images', extensions: ['png'] }] });
    assert.deepEqual(e.shown.at(-1), { title: 'Imágenes', filters: [{ name: 'Imágenes', extensions: ['png'] }] });
    e.dialog.showErrorBox('Not allowed', 'Save');
    assert.deepEqual(e.shown.at(-1), { title: 'No permitido', content: 'Guardar' });
    // The extension install dialog lists what it may do, one per line.
    assert.equal(i18n.t('It can:\n• Read and change all your data on all websites'), 'Puede:\n• Leer y cambiar todos tus datos en todos los sitios web');
  } finally {
    i18n.init(fakeElectron(['en-US']).app, 'en', fakeElectron([]));
    Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
  }
});

test('Lumio’s pages get the Spanish table first thing in <head>', () => {
  const file = resolveFile(new URL('lumio://settings/'), PAGE_HOSTS);
  const html = fs.readFileSync(file, 'utf8');
  assert.equal(i18n.localizeHtml(html, 'en'), html, 'English pages are served as they are');
  const out = i18n.localizeHtml(html, 'es');
  assert.match(out, /<html lang="es"/);
  assert.match(out, /<head>\s*<script src="\/assets\/i18n\/es\.js"><\/script><script src="\/assets\/i18n\/i18n\.js"><\/script>/);
  for (const f of ['es.js', 'i18n.js']) assert.ok(fs.existsSync(resolveFile(new URL(`lumio://settings/assets/i18n/${f}`), PAGE_HOSTS)), `${f} is served to the pages`);
  const dark = String(html).replace(/<html\b/i, '<html data-appearance="dark"');
  assert.match(i18n.localizeHtml(dark, 'es'), /<html data-appearance="dark" lang="es"/, 'works with an incognito page’s dark mark');
});

// ---------------------------------------------------------------- every page in Spanish
const servers = [];
const base = {};
const UI = new Set(['shell', 'overlay', 'picker', 'taskmanager', 'print', 'aura']);
async function serve(host) {
  const hosts = UI.has(host) ? UI : PAGE_HOSTS;
  const server = http.createServer((req, res) => {
    const url = new URL(`lumio://${host}${req.url}`);
    let file = resolveFile(url, hosts);
    if (url.pathname.startsWith('/web/') && file && !fs.existsSync(file)) file = path.join(ROOT, 'website', 'public', url.pathname.slice(5));
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    if (file.endsWith('.html')) body = i18n.localizeHtml(body, 'es'); // what main/protocol.js serves when Lumio is in Spanish
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-security-policy': CSP });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  base[host] = `http://127.0.0.1:${server.address().port}`;
}

let browser;
before(async () => {
  if (!CHROME) return;
  for (const host of [...UI, 'newtab']) await serve(host);
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
after(async () => { await browser?.close(); servers.forEach((s) => s.close()); });

// Opens one of Lumio's pages in Spanish with a stand-in browser (like
// platform-ui.test.mjs): `answers` are what its calls return.
async function open(host, answers, { file = `${host}.html`, bridge = UI.has(host) ? 'lumio' : 'lumioPage', ready, colorScheme = 'light' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 }, colorScheme, locale: 'es-AR' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.addInitScript(({ answers, bridge }) => {
    const handlers = {};
    window.__sent = [];
    window.__last = performance.now();
    window.__emit = (channel, payload) => (handlers[channel] || []).forEach((fn) => fn(payload));
    window[bridge] = {
      invoke: async (channel) => { window.__last = performance.now(); return structuredClone(answers[channel] ?? null); },
      send: (channel, ...args) => window.__sent.push([channel, ...args]),
      on: (channel, fn) => { (handlers[channel] ||= []).push(fn); return () => {}; },
    };
  }, { answers, bridge });
  await page.goto(`${base[UI.has(host) ? host : 'newtab']}/${file}`);
  if (ready) await page.waitForFunction(ready, null, { timeout: 10_000 });
  await page.waitForFunction(() => performance.now() - window.__last > 200);
  return { page, errors };
}

// What people wrote in the stand-in data below, on purpose in words that
// have a translation: it must stay as it is.
const USER = ['History', 'Settings', 'Downloads', 'Bookmarks', 'Password', 'Use the search box', 'History\nhttps://example.com/', 'Settings\nhttps://example.com/'];

// What the page shows (text and labels) that has a translation but is still in English.
async function leftovers(page, { keep = USER } = {}) {
  const shown = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!n.data.trim() || el.closest('script, style, [hidden], template') || el.closest('[translate="no"]')) continue;
      out.push(n.data);
    }
    for (const el of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
      if (el.closest('[hidden]')) continue;
      for (const a of ['title', 'placeholder', 'aria-label']) if (el.getAttribute(a)) out.push(el.getAttribute(a));
    }
    out.push(document.title);
    return out;
  });
  // (A Spanish word can also be an English one: "Red" is Network here.)
  return [...new Set(shown.filter((s) => tr(s) !== s && !ES.outputs.has(core.norm(s)) && !keep.includes(s.trim())))];
}

const now = Date.now();
const DAY = 864e5;
const ACCOUNT = { signedIn: true, name: 'Juan', email: 'juan@example.com', plan: 'plus', planName: 'Plus', usage: { windows: [{ id: 'weekly', limit: 100, remaining: 62, used: 38, fullAt: now + DAY }] } };
const PAGE_ANSWERS = {
  'page:settings': {
    account: ACCOUNT, profile: { name: 'Juan', color: '#7ee2a8', theme: 'blue' }, startup: 'newtab', downloadDir: '/tmp/Downloads', askDownload: false,
    offerPasswords: true, autofillPasswords: true, platform: 'darwin', searchEngine: 'google', engines: [{ id: 'google', name: 'Google' }],
    approvalMode: 'ask', showBookmarksBar: false, appearance: 'system', ai: { reasoning: 'medium', macAvailable: true }, version: '0.6.7', update: null, isDefault: false,
    importSources: [{ id: 'chrome', name: 'Chrome', passwords: true }], sitePermissions: [{ origin: 'https://meet.google.com', perms: { media: true, notifications: false } }],
  },
  'page:account': ACCOUNT,
  'page:billing': { ok: true, plan: 'plus', planName: 'Plus', subscription: { status: 'active', price: 20, periodEnd: now + 20 * DAY, card: { brand: 'visa', last4: '4242' } }, allPlans: [{ id: 'plus', name: 'Plus', price: 20 }, { id: 'pro', name: 'Pro', price: 100 }], reasons: [] },
  'page:sync': { on: true, status: 'ready', lastSync: now - 60e3, siteUrl: 'https://lumio.test', deviceName: 'Mac', deviceId: 'd1', types: { bookmarks: true, passwords: false }, requests: [] },
  'page:sync-devices': { ok: true, devices: [{ id: 'd1', name: 'Mac', lastSeen: now }, { id: 'd2', name: 'Pixel', lastSeen: now - DAY }] },
  'page:site-tips': { sites: [{ site: 'amazon.com', tips: [{ tip: 'Use the search box' }] }] },
  'page:schedules': { signedIn: true, tasks: [{ id: 's1', title: 'Settings', when: 'Every day at 8:00 AM', nextRun: now + 3600e3, prompt: 'Summarize the news', lastStatus: 'done' }] },
  'page:workflows': { workflows: [{ id: 'w1', title: 'Check prices', description: '', instructions: 'Check {item}', inputs: [{ name: 'item', label: 'Item' }], runs: 2, startUrl: 'https://shop.example' }] },
  'page:mac-permissions': { accessibility: true, screen: false },
  'page:performance': { memorySaver: true, mode: 'balanced', sites: ['docs.google.com'], energySaver: true, energySaverWhen: 'low', alerts: true, preload: 'standard', energyNow: false },
  'page:profiles': { count: 2, guest: false },
  'page:languages': { ui: { setting: 'system', running: 'es', system: 'es', restart: false }, languages: ['es-AR', 'en-US'], custom: false, choices: ['de', 'en-US', 'es-AR', 'fr'], spellcheck: { on: true, mac: true, available: [], languages: [] } },
  'page:system': { platform: 'darwin', hardwareAcceleration: true, restart: false, proxy: true },
  'page:newtab-data': { topSites: [{ url: 'https://github.com/', title: 'GitHub' }], bookmarks: [{ url: 'https://example.com/', title: 'Settings' }], engine: 'Google', aiReady: true, incognito: false, name: 'Juan', chats: [{ id: 'c1', title: 'Downloads', updatedAt: now - 3600e3 }], workflows: [] },
  'page:history': [{ url: 'https://example.com/a', title: 'History', time: now - 60e3 }, { url: 'https://example.com/b', title: 'Example page', time: now - DAY }],
  'page:other-tabs': [],
  'page:recently-closed': [{ kind: 'window', title: 'Window', tabs: [{ title: 'A', url: 'https://a.example' }, { title: 'B', url: 'https://b.example' }], time: now - 120e3 }],
  'page:downloads': [{ id: 'a', name: 'Downloads.pdf', url: 'https://example.com/r.pdf', state: 'progressing', paused: true, received: 4e6, total: 1e7, time: now }, { id: 'b', name: 'photo.png', url: 'https://example.com/p.png', state: 'completed', total: 2e6, exists: false, time: now - DAY }, { id: 'c', name: 'x.zip', url: 'https://example.com/x.zip', state: 'cancelled', time: now - DAY }],
  'page:bookmarks': [{ url: 'https://example.com/', title: 'Bookmarks' }, { url: 'https://github.com/', title: 'GitHub' }],
  'page:bookmarks-bar': true,
  'page:welcome-state': { platform: 'darwin', sources: [{ id: 'chrome', name: 'Chrome', passwords: true }, { id: 'safari', name: 'Safari', passwords: false }], account: { signedIn: false } },
  'page:passwords': { available: true, platform: 'darwin', entries: [{ id: 'p1', site: 'example.com', origin: 'https://example.com', username: 'Password', weak: true, reused: true, lastUsed: now - DAY }], passkeys: [{ id: 'k1', rpId: 'github.com', userName: 'juan', created: now - 9 * DAY, lastUsed: now - DAY }], never: ['bank.example'], offer: true, autofill: true },
  'page:extensions': { available: true, developerMode: true, items: [{ key: 'abc', id: 'abc', name: 'Dark Reader', description: 'Dark mode for every website', version: '4.9', enabled: true, type: 'store', icon: null, options: 'options.html' }, { key: '/x', id: null, name: 'Mine', version: '1', enabled: false, type: 'unpacked', path: '/x', error: 'Folder or manifest.json is missing' }] },
};

const PAGES = [
  ['settings', { ready: () => document.querySelector('#lang-list li') && document.querySelector('#sched-list .row') }],
  ['newtab', { ready: () => document.querySelector('#marks-wrap:not([hidden])') }],
  ['history', { ready: () => document.querySelector('#list .item') }],
  ['downloads', { ready: () => document.querySelector('#list .dl') }],
  ['bookmarks', { ready: () => document.querySelector('#list .bm-row') }],
  ['passwords', { ready: () => document.querySelector('#list .pw-item') }],
  ['extensions', {}],
  ['error', { file: 'error.html?code=-105&url=https%3A%2F%2Fexample.com' }],
  ['welcome', {}],
];

test('Lumio’s pages in Spanish: all of it, and not what people wrote', { skip }, async () => {
  for (const [name, opts] of PAGES) {
    const { page, errors } = await open(name, PAGE_ANSWERS, opts);
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `es-${name}.png`), fullPage: name !== 'settings' });
    assert.equal(await page.getAttribute('html', 'lang'), 'es', name);
    assert.deepEqual(await leftovers(page), [], `${name}: nothing left in English`);
    if (name === 'settings') {
      assert.equal(await page.textContent('.side-title'), 'Configuración');
      assert.equal(await page.textContent('#languages h2'), 'Idiomas');
      assert.equal(await page.getAttribute('#settings-search', 'placeholder'), 'Buscar en la configuración');
      assert.equal(await page.textContent('#sched-list .title b'), 'Settings', 'a task’s name stays as written');
      assert.match(await page.textContent('#sched-list .desc'), /^Todos los días a las 8:00 AM · Próxima: /);
      assert.match(await page.textContent('#lang-list li .title'), /^español/, 'language names in Spanish');
      // Searching works on the Spanish words.
      await page.fill('#settings-search', 'idioma');
      await page.waitForFunction(() => document.querySelector('#languages mark.search-hit'));
      assert.equal(await page.isVisible('#languages'), true);
      assert.equal(await page.isVisible('#privacy'), false);
      assert.deepEqual(await leftovers(page), [], 'marking matches doesn’t bring English back');
    }
    if (name === 'newtab') {
      assert.equal(await page.textContent('#marks .bm > span:last-child'), 'Settings', 'a bookmark’s name stays as written');
      assert.match(await page.textContent('#hello'), /^(¿Trasnochando|Buenos días|Buenas tardes|Buenas noches), Juan\??$/);
    }
    if (name === 'history') assert.equal(await page.textContent('#list .item .title'), 'History', 'page titles stay as written');
    if (name === 'downloads') {
      assert.match(await page.textContent('#list .dl .name'), /^Downloads\.pdf$/);
      assert.match(await page.textContent('#list .dl .sub'), /^En pausa · 4\.0 MB de 10\.0 MB · example\.com$/);
    }
    if (name === 'passwords') assert.equal(await page.textContent('#list .pw-item .user'), 'Password', 'a username stays as written');
    if (name === 'error') assert.equal(await page.textContent('h1'), 'No se puede acceder a este sitio');
    await page.close();
    assert.deepEqual(errors, [], `${name}: no errors`);
  }
});

const AI = { ready: true, lumio: { signedIn: true, plan: 'free', planName: 'Free', usage: { used: 0.3, fullAt: now + DAY } }, model: 'm', modelName: 'Mock', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [{ id: 'low', name: 'Low', desc: 'Fastest, and uses the least of your plan' }, { id: 'medium', name: 'Medium', desc: 'Balanced: good for most tasks' }, { id: 'high', name: 'High', desc: 'Thinks longer on hard tasks, and uses more' }], mode: 'ask', running: false, vision: true, macAvailable: true, workflows: true };
const INIT = {
  tabs: { activeId: 1, tabs: [{ id: 1, title: 'History', url: 'https://example.com/', favicon: null, loading: false, canGoBack: true }, { id: 2, title: 'New Tab', url: '', internal: true }] },
  downloads: [{ id: 'd', name: 'a.pdf', state: 'completed', total: 1e6 }], panel: { open: true, width: 380 }, ai: AI,
  bookmarks: { items: [{ url: 'https://example.com/', title: 'Settings' }], show: true },
  account: ACCOUNT, profile: { name: 'Juan', color: '#7ee2a8', theme: 'blue' }, incognito: false, guest: false, profiles: [], extensions: false, platform: 'darwin', version: '0.6.7', update: null,
};

test('the browser window in Spanish: toolbar, tabs, chat panel and sidebar', { skip }, async () => {
  const answers = { 'shell:init': INIT, 'ai:state': AI, 'ai:chats': [], 'ai:connections': { apps: [] }, 'perf:alert': null };
  const { page, errors } = await open('shell', answers, { ready: () => document.getElementById('mode-name')?.textContent === 'Preguntar' });
  if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, 'es-shell.png') });
  assert.deepEqual(await leftovers(page), []);
  assert.equal(await page.getAttribute('#address', 'placeholder'), 'Busca o escribe una URL');
  assert.equal(await page.textContent('#tabs .tab .title'), 'History', 'tab titles stay as written');
  assert.match(await page.getAttribute('#tabs .tab', 'title'), /^History\n/, 'and so do their tooltips');
  assert.equal(await page.textContent('.bm-item span'), 'Settings', 'bookmark names too');
  assert.equal(await page.textContent('#tabs .tab:nth-child(2) .title'), 'Nueva pestaña', 'Lumio’s own “New Tab” is translated');
  // Things the browser says later are translated as they appear.
  await page.evaluate(() => window.__emit('toast', { text: 'Bookmarked' }));
  assert.equal(await page.textContent('#toast'), 'Se agregó a favoritos');
  await page.evaluate(() => window.__emit('permission', { id: 1, host: 'meet.google.com', label: 'use your camera' }));
  assert.equal(await page.textContent('#permbar .infobar-text'), 'meet.google.com quiere usar tu cámara');
  await page.evaluate(() => window.__emit('update', { status: 'downloading', progress: 40, latest: '0.7.0', current: '0.6.7' }));
  assert.equal(await page.textContent('#update-btn .label'), 'Actualizando… 40%');
  await page.close();
  assert.deepEqual(errors, []);
});

const POPUPS = {
  suggest: { kind: 'suggest', items: [{ type: 'ai', title: 'History of Rome' }, { type: 'search', title: 'Settings' }, { type: 'history', title: 'Downloads', url: 'https://example.com/' }], selected: 0 },
  downloads: { kind: 'downloads', items: [{ id: 'a', name: 'Settings.pdf', state: 'progressing', received: 2e6, total: 9e6 }, { id: 'b', name: 'b.zip', state: 'completed', total: 1e6 }, { id: 'c', name: 'c.zip', state: 'cancelled' }] },
  siteinfo: { kind: 'siteinfo', info: { host: 'example.com', secure: false, incognito: true, permissions: [{ permission: 'media', label: 'Camera and microphone', value: true }] } },
  account: { kind: 'account', account: ACCOUNT, profile: { name: 'Juan' }, profiles: [{ id: 'default', name: 'Juan', current: true }, { id: 'p1', name: 'Settings' }] },
  guest: { kind: 'account', guest: true, account: {}, profile: {}, profiles: [{ id: 'default', name: 'Juan' }] },
  incognito: { kind: 'account', incognito: true, account: {}, profile: {} },
  autofill: { kind: 'autofill', host: 'example.com', accounts: [{ id: 'a', username: '' }], generated: 'Xy7#pQ2!' },
  pwsave: { kind: 'pwsave', prompt: { id: 1, host: 'example.com', username: 'juan', length: 9, action: 'save' } },
  passkey: { kind: 'passkey', prompt: { id: 2, mode: 'create', rpId: 'github.com', host: 'github.com', userName: 'juan', displayName: 'Juan' } },
  nopasskey: { kind: 'passkey', prompt: { id: 3, mode: 'none', rpId: 'github.com', host: 'github.com' } },
  screenshare: { kind: 'screenshare', share: { id: 4, host: 'meet.google.com', sources: [{ id: 's', screen: true, name: '' }, { id: 'w', name: 'Settings' }] } },
  update: { kind: 'update', update: { status: 'available', latest: '0.7.0', current: '0.6.7', notes: '- Faster tabs', notesUrl: 'https://example.com' } },
  perf: { kind: 'perf', alert: { count: 3, tabs: [{ title: 'Settings', host: 'a.example', memory: 2 * 1024 ** 3, cpu: 3 }] } },
};

test('popups over the page in Spanish, with what people wrote left alone', { skip }, async () => {
  const { page, errors } = await open('overlay', {});
  for (const [name, payload] of Object.entries(POPUPS)) {
    await page.evaluate((p) => window.__emit('overlay-data', p), payload);
    if (process.env.LUMIO_SHOTS) await page.screenshot({ path: path.join(process.env.LUMIO_SHOTS, `es-overlay-${name}.png`) });
    assert.deepEqual(await leftovers(page), [], `${name}: nothing left in English`);
  }
  await page.evaluate((p) => window.__emit('overlay-data', p), POPUPS.account);
  assert.equal(await page.textContent('.acc-profile .t'), 'Settings', 'a profile’s name stays as written');
  await page.evaluate((p) => window.__emit('overlay-data', p), POPUPS.downloads);
  assert.equal(await page.textContent('.dl .name'), 'Settings.pdf');
  assert.equal(await page.textContent('.dl .sub'), '2.0 MB de 9.0 MB');
  await page.close();
  assert.deepEqual(errors, []);
});

test('the profile picker, Task Manager and print preview in Spanish', { skip }, async () => {
  const profiles = { profiles: [{ id: 'default', name: 'Juan', color: '#86b7ff', email: 'juan@example.com', isDefault: true }, { id: 'p1', name: 'Settings', color: '#b58cff', email: null }], showPicker: true, platform: 'darwin' };
  let { page, errors } = await open('picker', { 'profiles:state': profiles }, { ready: () => document.querySelectorAll('.card').length === 3 });
  assert.equal(await page.textContent('h1'), '¿Quién está usando Lumio?');
  assert.equal(await page.textContent('.card[data-id="p1"] .name'), 'Settings');
  assert.equal(await page.textContent('.card[data-id="p1"] .email'), 'Sin sesión iniciada');
  assert.deepEqual(await leftovers(page), []);
  await page.close();
  assert.deepEqual(errors, []);

  const MB = 1024 ** 2;
  const rows = [
    { pid: 10, kind: 'browser', title: 'Browser', others: [], memory: 300 * MB, cpu: 1, network: null, canEnd: false },
    { pid: 31, kind: 'gpu', title: 'GPU process', others: [], memory: 120 * MB, cpu: 9, network: null, canEnd: false },
    { pid: 40, kind: 'extension', title: 'Extension: Dark Reader', others: [], memory: 90 * MB, cpu: 0, network: 0, canEnd: true },
  ];
  ({ page, errors } = await open('taskmanager', { 'taskmanager:list': rows }, { ready: () => document.querySelectorAll('#rows tr').length === 3 }));
  assert.equal(await page.textContent('#row-40 .t'), 'Extensión: Dark Reader');
  assert.match(await page.textContent('#summary'), /^3 procesos · 510\.0 MB en total$/);
  assert.deepEqual(await leftovers(page), []);
  await page.close();
  assert.deepEqual(errors, []);

  ({ page, errors } = await open('print', { 'print:init': { title: 'Report', settings: {} }, 'print:printers': [], 'print:preview': { ok: false } }, { ready: () => /preview/.test(document.getElementById('status').textContent) || document.getElementById('status').textContent.length > 5 }));
  assert.equal(await page.textContent('#print-title'), 'Imprimir');
  assert.equal(await page.textContent('#status'), 'No se pudo crear una vista previa de esta página.');
  assert.equal(await page.title(), 'Imprimir: Report');
  assert.deepEqual(await leftovers(page), []);
  await page.close();
  assert.deepEqual(errors, []);
});
