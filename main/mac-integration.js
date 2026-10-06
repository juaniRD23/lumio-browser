// Small macOS touches:
//  - Handoff: the page you're on (http/https, normal windows) is offered to
//    your iPhone, iPad or other Macs signed in to the same Apple Account, and
//    pages handed off from them open here (Info.plist declares
//    NSUserActivityTypeBrowsingWeb, see build/package.mjs).
//  - Look Up and Speech in a page's right-click menu, like Chrome on the Mac,
//    unless the menu already has them.
// (An AppleScript dictionary needs native Cocoa scripting support that
// Electron doesn't offer, so Lumio has none.)
const BROWSING = 'NSUserActivityTypeBrowsingWeb';
const MAC = process.platform === 'darwin';

class Handoff {
  constructor(app, { mac = MAC } = {}) {
    this.app = app;
    this.mac = mac;
    this.url = null;
  }

  // w: the window in front (or null).
  update(w) {
    if (!this.mac) return;
    const tab = w && !w.closed && !w.incognito ? w.tabs.active : null;
    const url = tab ? w.tabs.displayUrl(tab) : '';
    if (!/^https?:\/\//i.test(url)) {
      if (this.url) { this.app.invalidateCurrentActivity(); this.url = null; }
      return;
    }
    if (url === this.url) return;
    this.url = url;
    this.app.setUserActivity(BROWSING, {}, url);
  }

  // A page handed off from another device: open it (the caller's opener).
  listen(open) {
    if (!this.mac) return;
    this.app.on('continue-activity', (e, type, _info, details) => {
      const url = details?.webpageURL;
      if (type !== BROWSING || !/^https?:\/\//i.test(url || '')) return;
      e.preventDefault();
      open(url);
    });
  }
}

// Mac-only page context menu items. existing: what the menu has so far (the
// page tools may already add these; never twice).
function contextMenuItems(wc, params, existing = [], { mac = MAC } = {}) {
  if (!mac) return [];
  const has = (re) => existing.some((i) => re.test(String(i.label || '')));
  const selection = String(params.selectionText || '').trim();
  const out = [];
  if (selection && !has(/^Look Up\b/)) {
    const short = selection.length > 24 ? selection.slice(0, 24).trimEnd() + '…' : selection;
    out.push({ label: `Look Up “${short}”`, click: () => wc.showDefinitionForSelection() });
  }
  if ((selection || params.isEditable) && !has(/^Speech$/)) out.push({ label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] });
  return out;
}

module.exports = { Handoff, contextMenuItems, BROWSING };
