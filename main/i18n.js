// Lumio's own language (Settings › Languages › Lumio language): English or
// Spanish. It follows the computer's preferred languages unless the person
// picks one, and changes after a restart. The strings and the lookup live in
// renderer/assets/i18n (English is the source, like gettext):
//  - lumio:// pages get the lookup and the Spanish table at the top of their
//    <head> (localizeHtml, used by main/protocol.js) and translate themselves;
//  - menus and native dialogs are translated here as they're built, so the
//    code that builds them stays in plain English;
//  - t() is for the few other strings (notifications, and the prompts Lumio
//    writes for its AI, so it answers in the same language).
// Chromium follows too (--lang), for its own text: form messages, the PDF
// viewer, dates. The AI's replies are out of scope: it answers in the
// language you write in.
const core = require('../renderer/assets/i18n/i18n');

const LANGUAGES = ['en', 'es'];
const CHROMIUM_LANG = { en: 'en-US', es: 'es-419' };
const TABLES = { es: () => require('../renderer/assets/i18n/es') };

let current = 'en';
let compiled = null;

// The first of the computer's preferred languages Lumio speaks (else English).
function systemLanguage(preferred = []) {
  for (const tag of preferred) {
    const base = String(tag).toLowerCase().split(/[-_]/)[0];
    if (LANGUAGES.includes(base)) return base;
  }
  return 'en';
}

// setting: 'system', 'en' or 'es'. Tests stay in English unless LUMIO_LANG says.
function choose(setting, preferred, env = process.env) {
  if (LANGUAGES.includes(env.LUMIO_LANG)) return env.LUMIO_LANG;
  if (env.LUMIO_TEST) return 'en';
  if (LANGUAGES.includes(setting)) return setting;
  return systemLanguage(preferred);
}

// The locale Chromium gets for `language`: the computer's own variant of it
// when it has one ("es-AR" keeps Argentina's dates), else a general one.
function chromiumLocale(language, preferred = []) {
  const own = preferred.find((tag) => String(tag).toLowerCase().split(/[-_]/)[0] === language);
  return own ? String(own).replace(/_/g, '-') : CHROMIUM_LANG[language];
}

// Before the app is ready: picks the language and tells Chromium when it
// wouldn't follow by itself: a language picked in Settings, or Spanish found
// further down the computer's list. (Lumio in English because it doesn't
// speak the computer's language leaves Chromium in that language.)
// electron: Electron's module (tests pass stand-ins).
function init(app, setting, electron = null) {
  let preferred = [];
  try { preferred = app.getPreferredSystemLanguages(); } catch { /* keep English */ }
  current = choose(setting, preferred);
  compiled = current === 'en' ? null : core.compile(TABLES[current]());
  const first = String(preferred[0] || '').toLowerCase().split(/[-_]/)[0];
  const picked = LANGUAGES.includes(setting) || LANGUAGES.includes(process.env.LUMIO_LANG);
  if (picked || (current !== 'en' && first !== current)) app.commandLine.appendSwitch('lang', chromiumLocale(current, preferred));
  if (compiled) localizeElectron(electron || require('electron'));
  return current;
}

const lang = () => current;
const t = (text) => (compiled ? core.translate(compiled, text) : text);

// Labels Electron gives menu roles (in English): Spanish ones.
const ROLE_LABELS = {
  undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', pasteAndMatchStyle: 'Paste and Match Style', delete: 'Delete', selectAll: 'Select All',
  about: 'About Lumio Browser', services: 'Services', hide: 'Hide Lumio Browser', hideOthers: 'Hide Others', unhide: 'Show All', quit: 'Quit Lumio Browser',
  minimize: 'Minimize', zoom: 'Zoom', front: 'Bring All to Front', togglefullscreen: 'Toggle Full Screen', close: 'Close Window', window: 'Window',
};

// A menu template with its labels (and its submenus' labels) translated.
// Items marked translate: false show what people wrote or picked (bookmark
// titles, profile names, spelling suggestions) and stay as they are; ready
// MenuItems (an extension's) aren't plain templates and pass through.
function localizeTemplate(items) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!item || typeof item !== 'object' || item.type === 'separator' || Object.getPrototypeOf(item) !== Object.prototype) return item;
    if (item.translate === false) {
      const { translate, ...own } = item;
      return Array.isArray(own.submenu) ? { ...own, submenu: localizeTemplate(own.submenu) } : own;
    }
    const label = item.label ?? (item.role && ROLE_LABELS[item.role]);
    return {
      ...item,
      ...(label ? { label: t(label) } : {}),
      ...(item.sublabel ? { sublabel: t(item.sublabel) } : {}),
      ...(item.toolTip ? { toolTip: t(item.toolTip) } : {}),
      ...(Array.isArray(item.submenu) ? { submenu: localizeTemplate(item.submenu) } : {}),
    };
  });
}

// A native dialog's text and buttons translated.
function localizeDialog(opts) {
  if (!opts || typeof opts !== 'object') return opts;
  const out = { ...opts };
  for (const key of ['title', 'message', 'detail', 'checkboxLabel', 'buttonLabel', 'nameFieldLabel']) if (typeof out[key] === 'string') out[key] = t(out[key]);
  if (Array.isArray(out.buttons)) out.buttons = out.buttons.map((b) => (typeof b === 'string' ? t(b) : b));
  if (Array.isArray(out.filters)) out.filters = out.filters.map((f) => ({ ...f, name: t(f.name) }));
  return out;
}

// Every menu and dialog Lumio builds goes through these, wherever it's built
// (menu.js, tabs.js, main.js, the extensions library), so none of that code
// needs to know about languages.
function localizeElectron({ Menu, dialog }) {
  const build = Menu.buildFromTemplate.bind(Menu);
  Menu.buildFromTemplate = (template) => build(localizeTemplate(template));
  for (const name of ['showMessageBox', 'showMessageBoxSync', 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync']) {
    const native = dialog[name].bind(dialog);
    // (window, options) or (options)
    dialog[name] = (a, b) => (b === undefined ? native(localizeDialog(a)) : native(a, localizeDialog(b)));
  }
  const errorBox = dialog.showErrorBox.bind(dialog);
  dialog.showErrorBox = (title, content) => errorBox(t(title), t(content));
}

// A lumio:// page in Lumio's language: the lookup and the table go first in
// <head>, so the page is translated as it's parsed (they're same-origin
// files: the pages' CSP allows them).
function localizeHtml(html, language = current) {
  if (language === 'en') return html;
  return String(html)
    .replace(/<html\b([^>]*)\blang="[^"]*"/i, `<html$1lang="${language}"`)
    .replace(/<head>/i, `<head>\n  <script src="/assets/i18n/${language}.js"></script><script src="/assets/i18n/i18n.js"></script>`);
}

module.exports = { LANGUAGES, init, choose, systemLanguage, chromiumLocale, lang, t, localizeTemplate, localizeDialog, localizeHtml };
