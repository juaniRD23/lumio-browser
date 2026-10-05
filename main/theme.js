// Light and dark (Settings › Appearance › Theme, and View › Appearance).
// The setting becomes nativeTheme.themeSource, which Chromium passes on to
// every page as prefers-color-scheme: Lumio's UI and pages (their colors in
// renderer/assets/theme.css follow it live) and websites, like Chrome. It also
// themes native menus, dialogs and the title bar. Native backgrounds can't
// read CSS, so colors() gives them. Incognito windows are always dark.
const APPEARANCES = ['system', 'light', 'dark'];

// frame: the window behind the UI (--bg in theme.css). page: Lumio's own
// pages before they paint (their --bg; dark keeps the page slot's color).
// symbol: the Windows caption buttons.
const COLORS = {
  light: { frame: '#f3f3f5', page: '#f3f3f5', symbol: '#5f5f66' },
  dark: { frame: '#070708', page: '#0c0c0d', symbol: '#a8a8a8' },
  incognito: { frame: '#0d0b12', page: '#0c0c0d', symbol: '#a8a8a8' },
};

let nativeTheme = null; // Electron's (a stand-in in tests)
let store = null;
let last = null;
const listeners = new Set();

const appearance = () => (APPEARANCES.includes(store.settings.appearance) ? store.settings.appearance : 'system');
const isDark = (incognito = false) => incognito || nativeTheme.shouldUseDarkColors;
const colors = (dark, incognito = false) => COLORS[incognito ? 'incognito' : dark ? 'dark' : 'light'];

// Tests run dark unless they ask for light, so screenshots don't depend on
// the computer they run on.
const systemSource = () => (!process.env.LUMIO_TEST ? 'system' : process.env.LUMIO_APPEARANCE === 'light' ? 'light' : 'dark');

function apply() {
  const a = appearance();
  const source = a === 'system' ? systemSource() : a;
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
  changed();
}

// Listeners hear when the setting or the light/dark it comes to changes.
function changed() {
  const key = `${appearance()}/${isDark()}`;
  if (key === last) return;
  last = key;
  for (const fn of listeners) fn();
}

// Called once, before any window opens. Changes to the setting (from
// Settings, the menu or Lumio Sync) and to the system's appearance apply live.
function init(opts) {
  ({ nativeTheme, store } = opts);
  last = null;
  apply();
  nativeTheme.on('updated', changed);
  store.settingsFile.onSave(apply);
}

function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { APPEARANCES, init, appearance, isDark, colors, onChange };
