// Settings › System and Settings › Reset settings.
//  - Graphics acceleration: read from settings.json before Electron starts
//    (it can only be turned off then), so a change applies after a restart.
//  - The computer's proxy settings open in the system's own settings.
//  - Reset settings puts this profile's settings and the app-wide ones back
//    to their defaults. Bookmarks, history, passwords, chats, workflows,
//    scheduled tasks, extensions and the Lumio account stay.
const fs = require('fs');
const path = require('path');
const { DEFAULT_SETTINGS } = require('./store');

// The first profile's settings.json, before anything else reads it.
function readEarly(userData) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')) || {}; } catch { /* first launch */ }
  return { uiLanguage: s.uiLanguage || 'system', hardwareAcceleration: s.hardwareAcceleration !== false };
}

// Passed to the copy of Lumio that a restart from Settings opens.
const RESTARTED = '--lumio-restarted';

const PROXY_SETTINGS = {
  darwin: 'x-apple.systempreferences:com.apple.preference.network?Proxies',
  win32: 'ms-settings:network-proxy',
};

// What Reset settings puts back, in this profile and app-wide.
const PROFILE_KEYS = ['searchEngine', 'startup', 'downloadDir', 'askDownload', 'showBookmarksBar', 'offerPasswords', 'autofillPasswords', 'approvalMode', 'reasoning', 'developerMode'];
// (Also On startup's pages, the Home button, the New Tab page's look and
// Site settings' defaults, like Chrome's reset.)
const PROFILE_CLEARED = ['languages', 'spellcheck', 'spellcheckLanguages', 'startupPages', 'showHome', 'homePage', 'newTab', 'contentDefaults', 'defaultZoom', 'zoomLevels'];
const APP_DEFAULTS = {
  appearance: 'system',
  memorySaver: true,
  memorySaverMode: 'balanced',
  energySaver: true,
  energySaverWhen: 'low',
  performanceAlerts: true,
  preloadPages: 'standard',
  hardwareAcceleration: true,
  uiLanguage: 'system',
};

// profile: the profile Settings is open in. Site permissions are cleared;
// the list of sites kept active and the profile's name and picture stay.
function resetSettings(profile, rootStore) {
  const { store } = profile;
  for (const key of PROFILE_KEYS) store.setSetting(key, structuredClone(DEFAULT_SETTINGS[key]));
  for (const key of PROFILE_CLEARED) store.setSetting(key, undefined);
  store.setSetting('profile', { ...store.settings.profile, theme: DEFAULT_SETTINGS.profile.theme });
  profile.permissions?.settings?.clear(); // every site's own permissions and content settings
  for (const [key, value] of Object.entries(APP_DEFAULTS)) rootStore.setSetting(key, value);
}

class System {
  // app: Electron's. rootStore: app-wide settings. started: readEarly() at launch.
  constructor({ app, rootStore, started, argv = process.argv }) {
    Object.assign(this, { app, rootStore, started });
    this.restarted = argv.includes(RESTARTED); // this launch is such a restart
  }

  pageState() {
    const s = this.rootStore.settings;
    const acceleration = s.hardwareAcceleration !== false;
    return {
      platform: process.platform,
      hardwareAcceleration: acceleration,
      restart: acceleration !== this.started.hardwareAcceleration,
      proxy: !!PROXY_SETTINGS[process.platform],
    };
  }

  set(key, value) {
    if (key === 'hardwareAcceleration') this.rootStore.setSetting('hardwareAcceleration', !!value);
    return this.pageState();
  }

  openProxySettings(shell) {
    const url = PROXY_SETTINGS[process.platform];
    if (url) shell.openExternal(url).catch(() => {});
    return !!url;
  }

  // Quits and opens again, with the windows and tabs that were open (even
  // when Lumio starts with a new tab: main.js startProfile).
  relaunch() {
    if (process.env.LUMIO_TEST) return false;
    this.app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== RESTARTED), RESTARTED] });
    this.app.quit();
    return true;
  }

  // ctx: { internalHandle, shell, onReset(w) } from main.js. A Guest can't
  // change app-wide settings (they're the computer owner's), restart or reset.
  register({ internalHandle, shell, onReset }) {
    const guest = ({ w }) => !!w.profile.guest;
    internalHandle('page:system', ['settings'], () => this.pageState());
    internalHandle('page:set-system', ['settings'], (ctx, key, value) => (guest(ctx) ? this.pageState() : this.set(String(key), value)));
    internalHandle('page:open-proxy-settings', ['settings'], () => this.openProxySettings(shell));
    internalHandle('page:relaunch', ['settings'], (ctx) => !guest(ctx) && this.relaunch());
    internalHandle('page:reset-settings', ['settings'], (ctx) => {
      const { w } = ctx;
      if (guest(ctx)) return false;
      resetSettings(w.profile.base, this.rootStore);
      onReset?.(w);
      return true;
    });
  }
}

module.exports = { System, readEarly, resetSettings, PROFILE_KEYS, PROFILE_CLEARED, APP_DEFAULTS, PROXY_SETTINGS, RESTARTED };
