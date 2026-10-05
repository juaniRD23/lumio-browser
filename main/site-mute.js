// Mute site (the tab menu), like Chrome's: every tab of that site goes quiet,
// now and whenever one opens later, until it's unmuted. Normal windows keep
// the list in settings (Settings › Privacy › Muted sites); incognito windows
// keep their own changes until they close, and never write them down.
// The speaker on a tab still mutes just that tab.
const originOf = (url) => {
  try {
    const u = new URL(String(url || ''));
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch { return null; }
};

const MAX_SITES = 500;

class SiteMute {
  constructor(store) {
    this.store = store;
    this.incognito = new Map(); // origin -> muted, for incognito windows
  }

  list() {
    const v = this.store.settings.mutedSites;
    return Array.isArray(v) ? v.filter((o) => typeof o === 'string') : [];
  }

  isMuted(origin, incognito = false) {
    if (!origin) return false;
    if (incognito && this.incognito.has(origin)) return this.incognito.get(origin);
    return this.list().includes(origin);
  }

  set(origin, muted, incognito = false) {
    if (!origin) return;
    if (incognito) { this.incognito.set(origin, !!muted); return; }
    const rest = this.list().filter((o) => o !== origin);
    this.store.setSetting('mutedSites', muted ? [...rest, origin].slice(-MAX_SITES) : rest);
  }

  forgetIncognito() { this.incognito.clear(); }

  // After a tab's page commits: muted if its site is, unmuted if it was only
  // muted because of the site it left. A tab muted with its speaker stays muted.
  apply(tab, url) {
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const muted = this.isMuted(originOf(url), tab.owner.incognito);
    if (muted) {
      if (!tab.muted) {
        wc.setAudioMuted(true);
        Object.assign(tab, { muted: true, muteReason: 'site' });
        tab.owner.changed();
      }
    } else if (tab.muted && tab.muteReason === 'site') {
      wc.setAudioMuted(false);
      Object.assign(tab, { muted: false, muteReason: null });
      tab.owner.changed();
    }
  }
}

module.exports = { SiteMute, originOf };
