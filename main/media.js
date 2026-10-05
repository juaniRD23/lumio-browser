// Global media controls: a toolbar button shows while tabs play sound, and
// its popover lists them with play/pause, previous and next track, seeking,
// Picture in picture and Go to tab (renderer/ui/media.js draws the button,
// renderer/ui/overlay-media.js the popover).
//
// What's playing comes from the page's Media Session (title, artist,
// artwork) and its <video> and <audio> elements, read in an isolated world.
// Previous / next track, and a site's own play / pause, use the handlers the
// page gave navigator.mediaSession.setActionHandler(): a small shim in the
// page's world keeps them (preload/internal.js), and Lumio asks it to run one.
// Media inside frames (an embedded video) can be played, paused and put in
// Picture in picture, but its title is the tab's.
const { ipcMain } = require('electron');

const WORLD = 1005; // page tools' isolated world (see main/page-menu.js)
const ACTIONS = new Set(['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward', 'stop']);

// Runs in the page: what's playing and the element that plays it.
function probeMedia() {
  const all = [...document.querySelectorAll('video, audio')];
  const score = (m) => (!m.paused && !m.ended ? 4 : 0) + (m.currentTime > 0 ? 2 : 0) + (m.videoWidth ? 1 : 0);
  const el = all.filter((m) => m.readyState > 0).sort((a, b) => score(b) - score(a))[0] || null;
  const ms = navigator.mediaSession;
  const md = ms && ms.metadata;
  return {
    title: md?.title || '',
    artist: md?.artist || '',
    album: md?.album || '',
    artwork: md?.artwork ? [...md.artwork].map((a) => ({ src: a.src, sizes: a.sizes || '' })) : [],
    state: ms?.playbackState || 'none',
    el: el ? {
      paused: el.paused,
      duration: Number.isFinite(el.duration) ? el.duration : null,
      time: el.currentTime,
      video: !!el.videoWidth,
      pip: !!document.pictureInPictureElement && document.pictureInPictureElement === el,
      canPip: !!el.videoWidth && document.pictureInPictureEnabled && !el.disablePictureInPicture,
    } : null,
  };
}

// Runs in the page (or a frame): plays, pauses, seeks or opens Picture in
// picture without the site's help. Pausing pauses everything playing.
function controlMedia(action, value) {
  const all = [...document.querySelectorAll('video, audio')];
  const playing = all.filter((m) => !m.paused && !m.ended);
  const el = playing[0] || all.filter((m) => m.currentTime > 0)[0] || all.find((m) => m.readyState > 0);
  if (!el) return false;
  if (action === 'pause') playing.forEach((m) => m.pause());
  else if (action === 'play') el.play().catch(() => {});
  else if (action === 'seek' && Number.isFinite(value)) el.currentTime = Math.max(0, value);
  else if (action === 'pip') {
    const video = el.videoWidth ? el : all.find((m) => m.videoWidth);
    if (!video) return false;
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else video.requestPictureInPicture().catch(() => {});
  }
  return true;
}

// The biggest picture a site gave for what's playing (https or an inline image only).
function bestArtwork(list = []) {
  const size = (s) => Math.max(0, ...String(s || '').split(/\s+/).map((x) => Number(x.split(/x/i)[0]) || 0));
  return (Array.isArray(list) ? list : []).filter((a) => typeof a?.src === 'string' && /^(https:|data:image\/)/i.test(a.src) && a.src.length < 200_000)
    .sort((a, b) => size(b.sizes) - size(a.sizes))[0]?.src || null;
}

class MediaHub {
  // windows(): every open browser window.
  constructor({ windows }) {
    this.windows = windows;
    this.wired = new WeakSet();
    this.timer = null;
    this.sent = new WeakMap(); // window -> the button state it was last sent
  }

  // Notes when a tab starts and stops playing. A tab shows in the popover
  // once it has made sound (muted autoplay videos on a page don't count),
  // until it goes to another page or closes.
  wire(tab) {
    const wc = tab.view?.webContents;
    if (!wc || this.wired.has(wc)) return;
    this.wired.add(wc);
    const mine = () => !wc.isDestroyed() && tab.view?.webContents === wc;
    const set = (patch) => { if (!mine()) return; tab.media = { playing: false, heard: false, ...tab.media, ...patch }; this.changed(); };
    wc.on('media-started-playing', () => set({ playing: true }));
    wc.on('media-paused', () => set({ playing: false }));
    wc.on('audio-state-changed', (e) => { if (e.audible) set({ heard: true, playing: true }); });
    wc.on('did-navigate', () => { tab.media = null; tab.mediaActions = null; this.changed(); });
    wc.once('destroyed', () => { if (tab.view?.webContents === wc || !tab.view) tab.media = null; this.changed(); });
  }

  // Tabs with something to control, for windows like `w` (incognito ones see only incognito tabs).
  tabs(w) {
    const out = [];
    for (const x of this.windows()) {
      if (x.incognito !== w.incognito) continue;
      for (const t of x.tabs.tabs) if (t.view && t.media?.heard) out.push({ w: x, tab: t });
    }
    return out;
  }

  state(w) {
    const list = this.tabs(w);
    return { count: list.length, playing: list.some(({ tab }) => tab.media.playing) };
  }

  // The toolbar button in every window: shown while there's something to control.
  changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      for (const w of this.windows()) {
        const state = this.state(w);
        const last = this.sent.get(w);
        if (last && last.count === state.count && last.playing === state.playing) continue;
        this.sent.set(w, state);
        w.emit('media', state);
      }
    }, 120);
  }

  async probe(wc) {
    const run = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), 800))]);
    let info = await run(wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${probeMedia})()` }]).catch(() => null));
    if (info && !info.el) {
      // An embedded player: its state, from the first frame that has one.
      for (const frame of wc.mainFrame.framesInSubtree.filter((f) => f.parent).slice(0, 8)) {
        const got = await run(frame.executeJavaScript(`(${probeMedia})()`).catch(() => null));
        if (got?.el) { info = { ...info, el: got.el, framed: true }; break; }
      }
    }
    return info;
  }

  // The popover's list, one row per tab. An embedded player's answer comes
  // from the frame's own page, so only plain numbers and yes/no are kept.
  async list(w) {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return Promise.all(this.tabs(w).map(async ({ w: x, tab }) => {
      const wc = tab.view.webContents;
      const info = (await this.probe(wc)) || {};
      const acts = new Set(tab.mediaActions || []);
      const el = info.el && typeof info.el === 'object' ? info.el : null;
      const duration = num(el?.duration);
      return {
        tabId: tab.id,
        windowId: x.id,
        title: String(info.title || tab.title || ''),
        artist: String(info.artist || ''),
        host: (() => { try { return new URL(x.tabs.displayUrl(tab)).host.replace(/^www\./, ''); } catch { return ''; } })(),
        favicon: tab.favicon || null,
        artwork: bestArtwork(info.artwork),
        playing: el ? !el.paused : info.state === 'playing' || !!tab.media.playing,
        canPrev: acts.has('previoustrack'),
        canNext: acts.has('nexttrack'),
        duration: duration && duration < 360000 ? duration : null, // live streams have no end
        time: num(el?.time),
        canSeek: !!duration && !info.framed,
        pip: el?.pip === true,
        canPip: el?.canPip === true,
        current: x === w && x.tabs.activeId === tab.id,
      };
    }));
  }

  find(w, tabId) { return this.tabs(w).find(({ tab }) => tab.id === Number(tabId)) || null; }

  // A button in the popover.
  async act(w, { tabId, action, value } = {}) {
    const found = this.find(w, tabId);
    if (!found) return false;
    const { w: x, tab } = found;
    const wc = tab.view.webContents;
    if (action === 'goto') {
      x.tabs.activate(tab.id);
      x.focus();
      w.hideOverlay();
      w.emit('overlay-picked', { kind: 'media' });
      return true;
    }
    const acts = new Set(tab.mediaActions || []);
    const site = { prev: 'previoustrack', next: 'nexttrack', play: 'play', pause: 'pause', seek: 'seekto' }[action];
    if (site && acts.has(site)) {
      // It counts as a click on the page, so the site may start playing.
      await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: '0' }], true).catch(() => {});
      wc.send('media:session', { action: site, details: action === 'seek' ? { seekTime: Number(value) || 0, fastSeek: false } : {} });
      return true;
    }
    if (!['play', 'pause', 'seek', 'pip'].includes(action)) return false;
    const code = `(${controlMedia})(${JSON.stringify(action)}, ${Number.isFinite(Number(value)) ? Number(value) : 'null'})`;
    const done = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], true).catch(() => false);
    if (done || action === 'seek') return !!done;
    for (const frame of wc.mainFrame.framesInSubtree.filter((f) => f.parent).slice(0, 8)) {
      if (await frame.executeJavaScript(code, true).catch(() => false)) return true;
    }
    return false;
  }

  // tabOfWc(wc): { w, tab } for a tab's page (the shim reports its handlers).
  register({ handle, on, tabOfWc }) {
    handle('media:state', (w) => this.state(w));
    handle('media:list', (w) => this.list(w));
    handle('media:action', (w, payload) => this.act(w, payload || {}));
    on('media:focus', (w) => w.overlay.webContents.focus());
    on('media:refocus', (w) => w.win.webContents.focus());
    ipcMain.on('media:actions', (e, list) => {
      const found = tabOfWc(e.sender);
      if (!found || e.senderFrame !== e.sender.mainFrame || !Array.isArray(list)) return;
      found.tab.mediaActions = list.filter((a) => ACTIONS.has(a));
    });
  }
}

module.exports = { MediaHub, probeMedia, controlMedia, bestArtwork };
