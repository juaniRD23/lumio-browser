// Settings › Languages: Lumio's own language (main/i18n.js), the languages
// websites are asked for (the Accept-Language header) and spell check. The
// website languages and spell check belong to each profile and apply to its
// sessions (incognito ones too) as soon as they change, from Settings, Reset
// settings or another device (Lumio Sync); Lumio's language is app-wide and
// applies after a restart.
const i18n = require('./i18n');

// Languages offered under "Add a language" (the page shows their names).
const CHOICES = [
  'af', 'ar', 'bg', 'bn', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'en', 'en-AU', 'en-CA', 'en-GB', 'en-US', 'es', 'es-419', 'es-AR', 'es-CL', 'es-CO', 'es-ES', 'es-MX', 'es-US',
  'et', 'eu', 'fa', 'fi', 'fil', 'fr', 'fr-CA', 'fr-FR', 'ga', 'gl', 'gu', 'he', 'hi', 'hr', 'hu', 'id', 'is', 'it', 'ja', 'kn', 'ko', 'lt', 'lv', 'ml', 'mr', 'ms',
  'nb', 'nl', 'pl', 'pt', 'pt-BR', 'pt-PT', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'vi', 'zh', 'zh-CN', 'zh-HK', 'zh-TW', 'zu',
];
const MAX_LANGUAGES = 20;
const TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// "es_ar" and "ES-ar" are "es-AR"; anything that isn't a language tag is dropped.
function cleanTag(tag) {
  const parts = String(tag || '').trim().replace(/_/g, '-').split('-').filter(Boolean);
  if (!parts.length) return null;
  const out = [parts[0].toLowerCase(), ...parts.slice(1).map((p) => (p.length === 2 ? p.toUpperCase() : p.length === 4 ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))].join('-');
  return TAG.test(out) ? out : null;
}

function cleanList(list) {
  const out = [];
  for (const tag of Array.isArray(list) ? list : []) {
    const t = cleanTag(tag);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_LANGUAGES);
}

// The computer's preferred languages, like ['es-AR', 'en-US'].
function systemLanguages(app) {
  let list = [];
  try { list = cleanList(app.getPreferredSystemLanguages()); } catch { /* none */ }
  if (!list.length) { try { list = cleanList([app.getLocale()]); } catch { /* none */ } }
  return list.length ? list : ['en-US'];
}

// The profile's list, or the computer's until the person changes it.
const preferred = (store, app) => (Array.isArray(store.settings.languages) && store.settings.languages.length ? cleanList(store.settings.languages) : systemLanguages(app));

// Accept-Language, like Chrome's: each regional language followed by its
// base language when the list doesn't have it ("es-AR,es,en-US,en"); the
// network stack adds the q-values.
function acceptLanguages(list) {
  const out = [];
  for (const tag of list) {
    if (!out.includes(tag)) out.push(tag);
    const base = tag.split('-')[0];
    if (base !== tag && !list.includes(base) && !out.includes(base)) out.push(base);
  }
  return out.join(',');
}

// Spell check languages the session can use (Windows and Linux; a Mac's
// spelling follows the language you type in, from the system's dictionaries).
function spellcheckLanguages(ses, store) {
  if (process.platform === 'darwin') return [];
  const available = ses.availableSpellCheckerLanguages || [];
  const want = Array.isArray(store.settings.spellcheckLanguages) ? store.settings.spellcheckLanguages : null;
  return want ? want.filter((l) => available.includes(l)) : null; // null: Electron's default
}

function apply(ses, store, app) {
  try { ses.setUserAgent(ses.getUserAgent(), acceptLanguages(preferred(store, app))); } catch { /* keep the default */ }
  ses.setSpellCheckerEnabled(store.settings.spellcheck !== false);
  const langs = spellcheckLanguages(ses, store);
  if (langs?.length) { try { ses.setSpellCheckerLanguages(langs); } catch { /* keep the current ones */ } }
}

// A profile's session (or its incognito one): apply now, and again whenever
// these settings change.
function attach(ses, store, app) {
  const key = () => JSON.stringify([store.settings.languages, store.settings.spellcheck, store.settings.spellcheckLanguages]);
  let last = key();
  apply(ses, store, app);
  store.settingsFile.onSave(() => {
    const now = key();
    if (now === last) return;
    last = now;
    apply(ses, store, app);
  });
}

// What Settings › Languages shows. started: the language Lumio is running in.
function pageState({ store, session: ses }, rootStore, app) {
  const setting = i18n.LANGUAGES.includes(rootStore.settings.uiLanguage) ? rootStore.settings.uiLanguage : 'system';
  let systemPreferred = [];
  try { systemPreferred = app.getPreferredSystemLanguages(); } catch { /* none */ }
  const want = i18n.choose(setting, systemPreferred, { ...process.env, LUMIO_TEST: '', LUMIO_LANG: '' });
  return {
    ui: { setting, running: i18n.lang(), system: i18n.systemLanguage(systemPreferred), restart: want !== i18n.lang() },
    languages: preferred(store, app),
    custom: Array.isArray(store.settings.languages) && store.settings.languages.length > 0,
    choices: CHOICES,
    spellcheck: {
      on: store.settings.spellcheck !== false,
      mac: process.platform === 'darwin',
      available: process.platform === 'darwin' ? [] : ses.availableSpellCheckerLanguages || [],
      languages: process.platform === 'darwin' ? [] : ses.getSpellCheckerLanguages?.() || [],
    },
  };
}

// Settings › Languages: what the page reads and changes. ctx: { internalHandle, rootStore, app }.
function register({ internalHandle, rootStore, app }) {
  const state = (w) => pageState(w.profile, rootStore, app);
  internalHandle('page:languages', ['settings'], ({ w }) => state(w));
  internalHandle('page:set-ui-language', ['settings'], ({ w }, value) => {
    rootStore.setSetting('uiLanguage', i18n.LANGUAGES.includes(value) ? value : 'system');
    return state(w);
  });
  // null goes back to the computer's languages.
  internalHandle('page:set-languages', ['settings'], ({ w }, list) => {
    const clean = list == null ? null : cleanList(list);
    w.profile.store.setSetting('languages', clean && clean.length ? clean : undefined);
    return state(w);
  });
  internalHandle('page:set-spellcheck', ['settings'], ({ w }, { on, languages } = {}) => {
    const { store, session: ses } = w.profile;
    if (typeof on === 'boolean') store.setSetting('spellcheck', on);
    if (Array.isArray(languages)) {
      const available = ses.availableSpellCheckerLanguages || [];
      store.setSetting('spellcheckLanguages', languages.filter((l) => available.includes(l)).slice(0, MAX_LANGUAGES));
    }
    return state(w);
  });
}

module.exports = { CHOICES, cleanTag, cleanList, systemLanguages, preferred, acceptLanguages, apply, attach, pageState, register };
