// Customize Lumio: the side sheet on the New Tab page (renderer/pages/
// newtab-customize.js). Theme and accent are the existing settings
// (appearance, profile.theme); the New Tab's own choices live in
// settings.newTab, which Lumio Sync carries. Your own background image stays
// on this computer, in the profile folder, and is never synced.
const fs = require('fs');
const path = require('path');

const BACKGROUNDS = ['none', 'aurora', 'dusk', 'meadow', 'custom'];
const IMAGE_FILE = 'newtab-background.jpg';
const IMAGE_MAX = 2560; // px on the long side; plenty for a full screen

// The saved choices, checked (they can come from another device).
function prefs(settings = {}) {
  const p = settings.newTab || {};
  return {
    background: BACKGROUNDS.includes(p.background) ? p.background : 'none',
    shortcuts: p.shortcuts !== false,
    recent: p.recent !== false,
  };
}

// A change from the page: only known keys and values.
function patch(settings, key, value) {
  const next = prefs(settings);
  if (key === 'background' && BACKGROUNDS.includes(value)) next.background = value;
  else if (key === 'shortcuts' || key === 'recent') next[key] = !!value;
  else return null;
  return next;
}

// deps: { internalHandle, store, dir, dialog, nativeImage, theme, setProfile }
function register({ internalHandle, store, dir, dialog, nativeImage, theme, setProfile }) {
  const file = path.join(dir, IMAGE_FILE);
  const image = () => {
    try { return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`; } catch { return null; }
  };
  function state() {
    const p = prefs(store.settings);
    const img = p.background === 'custom' ? image() : null;
    // Chosen on another computer, without the picture here: no background.
    if (p.background === 'custom' && !img) p.background = 'none';
    return { ...p, image: img, appearance: theme.appearance(), theme: store.settings.profile?.theme || 'blue' };
  }
  internalHandle('page:customize', ['newtab'], () => state());
  internalHandle('page:customize-set', ['newtab'], (_ctx, key, value) => {
    if (key === 'appearance') { if (theme.APPEARANCES.includes(value)) store.setSetting('appearance', value); return state(); }
    if (key === 'theme') { setProfile({ theme: value }); return state(); }
    const next = patch(store.settings, key, value);
    if (next) store.setSetting('newTab', next);
    return state();
  });
  internalHandle('page:customize-image', ['newtab'], async ({ w }) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(w.win, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif'] }],
    });
    if (canceled || !filePaths[0]) return state();
    let img = nativeImage.createFromPath(filePaths[0]);
    if (img.isEmpty()) return { ...state(), error: 'That image couldn’t be opened.' };
    const { width, height } = img.getSize();
    if (Math.max(width, height) > IMAGE_MAX) img = img.resize(width >= height ? { width: IMAGE_MAX, quality: 'best' } : { height: IMAGE_MAX, quality: 'best' });
    fs.writeFileSync(file, img.toJPEG(85));
    store.setSetting('newTab', { ...prefs(store.settings), background: 'custom' });
    return state();
  });
  return { state };
}

module.exports = { register, prefs, patch, BACKGROUNDS };
