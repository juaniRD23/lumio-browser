// Lumio's dropdowns and bubbles (renderer/ui/overlay.html) in windows other
// than the browser's: a pop-up (main/popup-window.js) and an installed app's
// window (main/apps.js). They borrow the browser window's own code for it
// (main/window.js BrowserWin: show, the entrance, sizing, the exit), so the
// passwords dropdown, "Save password?", passkeys and autofill look and
// behave the same everywhere. The window needs: win, overlay (a view loading
// lumio://overlay/), emit(channel, payload), and app.onPasskeyPromptClosed.
const OVERLAY_METHODS = ['showOverlay', 'hideOverlay', 'overlayReady', 'overlayClosed', 'overlayGone', 'detachOverlay'];

// Gives a window class the browser window's overlay methods. These windows
// can ask for a dropdown as soon as they open (a site in an app window
// focusing its sign-in field), before the overlay's page has loaded and can
// hear it: what was asked for then is shown again once it has (wireOverlay).
function lendOverlay(Cls, BrowserWin) {
  for (const m of OVERLAY_METHODS) Cls.prototype[m] = BrowserWin.prototype[m];
  Cls.prototype.showOverlay = function showOverlay(rect, payload) {
    this.overlayEarly = this.overlayLoaded === false ? { rect, payload } : null;
    return BrowserWin.prototype.showOverlay.call(this, rect, payload);
  };
}

// Its starting state, and the overlay's "loaded", "drawn" and "gone".
function wireOverlay(holder) {
  holder.overlayKind = null;
  holder.overlaySeq = 0;
  holder.overlayIn = -1;
  holder.overlayLoaded = false;
  holder.overlayEarly = null;
  const wc = holder.overlay.webContents;
  wc.once?.('did-finish-load', () => {
    holder.overlayLoaded = true;
    const early = holder.overlayEarly;
    holder.overlayEarly = null;
    // Still wanted (not hidden or replaced meanwhile): shown again, from the
    // start (not closed first, so a passkey question isn't answered "no").
    if (early && holder.overlayKind && holder.overlayKind === early.payload?.kind && !holder.closed) {
      holder.overlayKind = null;
      holder.showOverlay(early.rect, early.payload);
    }
  });
  wc.ipc?.on('overlay:ready', (_e, msg) => holder.overlayReady(msg || {}));
  wc.ipc?.on('overlay:gone', (_e, msg) => holder.overlayGone(msg || {}));
}

module.exports = { lendOverlay, wireOverlay, OVERLAY_METHODS };
