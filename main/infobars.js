// Bars across the top of the page, like Chrome's infobars: "Restore pages?"
// after a crash (main/sessions.js) and "Lumio isn't your default browser"
// (main/default-browser.js). Each window has its own; renderer/ui/infobars.js
// draws them and sends back which button was pressed.
//
// A bar: { id, title?, text, actions: [{ id, label, primary? }],
//          onAction(w, actionId), onClose(w) }
class Infobars {
  constructor() {
    this.bars = new WeakMap(); // window -> Map(id -> bar)
  }

  of(w) {
    let map = this.bars.get(w);
    if (!map) { map = new Map(); this.bars.set(w, map); }
    return map;
  }

  // What the window draws (no functions).
  list(w) {
    return [...this.of(w).values()].map(({ id, title, text, actions }) => ({ id, title: title || '', text, actions }));
  }

  show(w, bar) {
    if (!w || w.closed) return;
    this.of(w).set(bar.id, bar);
    w.emit('infobars', this.list(w));
  }

  hide(w, id) {
    if (!w || !this.of(w).delete(id)) return;
    if (!w.closed) w.emit('infobars', this.list(w));
  }

  // The bar's button (action) or its close button (no action).
  act(w, id, action) {
    const bar = this.of(w).get(String(id || ''));
    if (!bar) return;
    this.hide(w, bar.id);
    if (action && bar.actions.some((a) => a.id === action)) bar.onAction?.(w, action);
    else bar.onClose?.(w);
  }

  // handle/on: main.js's helpers (they find the sender's window).
  register({ handle, on }) {
    handle('shell:infobars', (w) => this.list(w));
    on('window:infobar', (w, msg) => this.act(w, msg?.id, msg?.action || null));
  }
}

module.exports = { Infobars };
