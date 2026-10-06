// Lumio's dropdowns and bubbles (renderer/ui/overlay.html) in windows other
// than the browser's: a pop-up (main/popup-window.js) and an installed app's
// window (main/apps.js). They borrow the browser window's own code for it
// (main/window.js BrowserWin: show, the entrance, sizing, the exit), so the
// passwords dropdown, "Save password?", passkeys and autofill look and
// behave the same everywhere. The window needs: win, overlay (a view loading
// lumio://overlay/), emit(channel, payload), and app.onPasskeyPromptClosed.
const OVERLAY_METHODS = ['showOverlay', 'hideOverlay', 'overlayReady', 'overlayClosed', 'overlayGone', 'detachOverlay'];

// Gives a window class the browser window's overlay methods.
function lendOverlay(Cls, BrowserWin) {
  for (const m of OVERLAY_METHODS) Cls.prototype[m] = BrowserWin.prototype[m];
}

// Its starting state, and the overlay's "drawn" and "gone" answers.
function wireOverlay(holder) {
  holder.overlayKind = null;
  holder.overlaySeq = 0;
  holder.overlayIn = -1;
  const ipc = holder.overlay.webContents.ipc;
  ipc?.on('overlay:ready', (_e, msg) => holder.overlayReady(msg || {}));
  ipc?.on('overlay:gone', (_e, msg) => holder.overlayGone(msg || {}));
}

module.exports = { lendOverlay, wireOverlay, OVERLAY_METHODS };
