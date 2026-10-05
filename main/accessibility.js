// Settings › Accessibility: a focus outline around whatever has focus, Reduce
// Motion in Lumio (whatever the system says), and larger text in Lumio's own
// interface. They reach the window, the overlay and Lumio's pages as
// attributes on <html> (renderer/assets/theme.css and ui-prefs.js): stamped
// into each page as it's served, so the first paint is right, and sent live
// with the appearance broadcast (main/theme.js) when they change.
const KEYS = ['focusRing', 'reduceMotion', 'largerText'];
const ATTR = { focusRing: 'data-focus-ring', reduceMotion: 'data-reduce-motion', largerText: 'data-large-text' };

function prefs(settings = {}) {
  const a = settings.accessibility || {};
  return Object.fromEntries(KEYS.map((k) => [k, a[k] === true]));
}

// What goes on <html> for these choices, e.g. ' data-reduce-motion=""'.
function htmlAttrs(p) {
  return KEYS.filter((k) => p[k]).map((k) => ` ${ATTR[k]}=""`).join('');
}

const key = (p) => KEYS.map((k) => (p[k] ? 1 : 0)).join('');

// deps: { internalHandle, store }
function register({ internalHandle, store }) {
  internalHandle('page:accessibility', ['settings'], () => prefs(store.settings));
  internalHandle('page:accessibility-set', ['settings'], (_ctx, k, value) => {
    if (!KEYS.includes(k)) return prefs(store.settings);
    store.setSetting('accessibility', { ...prefs(store.settings), [k]: !!value });
    return prefs(store.settings);
  });
}

module.exports = { KEYS, ATTR, prefs, htmlAttrs, key, register };
