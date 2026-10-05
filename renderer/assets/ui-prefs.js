// Settings › Accessibility on <html> (main/accessibility.js stamps them into
// each page as it's served; this keeps them live). theme.css and each
// stylesheet act on the attributes. Imported by the window, the overlay and
// every lumio:// page.
const ATTR = { focusRing: 'data-focus-ring', reduceMotion: 'data-reduce-motion', largerText: 'data-large-text' };

export function applyUiPrefs(p, root = document.documentElement) {
  for (const [k, attr] of Object.entries(ATTR)) root.toggleAttribute(attr, !!p?.[k]);
}

(window.lumio || window.lumioPage)?.on('ui-prefs', (p) => applyUiPrefs(p));
