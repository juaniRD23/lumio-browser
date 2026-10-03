// Keys Lumio AI presses in a page (press_key, paste_text) go through the same
// before-input-event as the person's. Esc there means "stop Lumio" (main/tabs.js),
// so the AI pressing Esc in a page mustn't stop itself.
const recent = new WeakMap(); // webContents -> when the AI last sent a key
module.exports = {
  markSynthetic(wc) { recent.set(wc, Date.now()); },
  isSynthetic(wc) { return Date.now() - (recent.get(wc) || 0) < 400; },
};
