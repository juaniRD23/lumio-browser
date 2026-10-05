// Capture indicators: a red dot on tabs that use your camera, microphone or
// screen, and the "Sharing this tab" bar (renderer/ui/capture-bar.js).
//
// Lumio sees camera and microphone captures start itself: it grants them
// (main/features.js). Screens, windows and tabs are picked in Lumio's picker
// (main.js), except on macOS 15 and later, where macOS shows its own picker
// and only the page knows what was shared. Ends are harder: Chromium doesn't
// tell, so the page's preload (preload/internal.js) counts its live tracks
// and reports them. A report only turns an indicator off once it accounts
// for every capture Lumio granted, so a page that hides from the count keeps
// its dot on until it navigates away or closes. A shared Lumio tab is
// watched with webContents.isBeingCaptured().
//
// "Stop sharing" asks the page's preload to stop its screen tracks; a page
// still sharing two seconds later is reloaded, which always ends them.

const KINDS = ['camera', 'microphone'];

class CaptureTracker {
  // findTab(wcId) → { w, tab } | null. onChange(wcId, state) after a change.
  // poll: how often shared tabs are checked; stopWait: how long Stop sharing
  // waits for the page before reloading it.
  constructor({ findTab, onChange = () => {}, poll = 1000, stopWait = 2000 }) {
    this.findTab = findTab;
    this.onChange = onChange;
    this.pages = new Map(); // wcId -> { grants: { camera, microphone }, asked, shares: [], report }
    this.timer = null;
    this.poll = poll;
    this.stopWait = stopWait;
  }

  page(wcId) {
    if (!this.pages.has(wcId)) this.pages.set(wcId, { grants: { camera: 0, microphone: 0 }, asked: 0, shares: [], report: null });
    return this.pages.get(wcId);
  }

  // A page was allowed what it asked for: the camera and/or microphone, or
  // to ask for your screen (screenShare).
  granted(wcId, cats) {
    const media = cats.filter((c) => KINDS.includes(c));
    if (wcId == null || (!media.length && !cats.includes('screenShare'))) return;
    const p = this.page(wcId);
    for (const c of media) p.grants[c]++;
    if (cats.includes('screenShare')) p.asked++;
    if (media.length) this.changed(wcId);
  }

  // The person chose what a page may see: kind 'screen', 'window' or 'tab'
  // (target: the shared tab's webContents id).
  shared(wcId, { kind, title = '', target = null, host = '' }) {
    if (wcId == null) return;
    const share = { kind, title, target, host, seen: false, ended: false, at: Date.now() };
    this.page(wcId).shares.push(share);
    this.changed(wcId);
    if (target != null) this.changed(target);
    this.watch();
  }

  // The page's own count (preload/internal.js): settled getUserMedia /
  // getDisplayMedia calls and live tracks. Untrusted: it can only end
  // captures it fully accounts for.
  report(wcId, r) {
    const p = this.pages.get(wcId);
    if (!p || !r || typeof r !== 'object') return;
    const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
    p.report = {
      settled: { camera: n(r.settled?.camera), microphone: n(r.settled?.microphone), display: n(r.settled?.display) },
      live: { camera: n(r.live?.camera), microphone: n(r.live?.microphone), display: n(r.live?.display) },
    };
    const live = p.shares.filter((s) => !s.ended);
    if (live.length && p.report.live.display === 0 && p.report.settled.display >= p.shares.length) {
      live.forEach((s) => { s.ended = true; });
      live.forEach((s) => s.target != null && this.changed(s.target));
    } else if (!live.length && p.asked > 0 && p.report.live.display > 0) {
      // Shared through macOS's own picker: Lumio only knows the site was
      // allowed to ask, so the page's own count turns the indicator on.
      p.shares.push({ kind: 'screen', title: '', target: null, host: '', seen: true, ended: false, at: Date.now() });
    }
    this.changed(wcId);
  }

  // The page went away (navigated or closed): everything it captured ended.
  ended(wcId) {
    const p = this.pages.get(wcId);
    if (!p) return;
    this.pages.delete(wcId);
    this.changed(wcId);
    for (const s of p.shares) if (s.target != null) this.changed(s.target);
  }

  // What a tab's indicators show.
  state(wcId) {
    const p = this.pages.get(wcId);
    const out = { camera: false, microphone: false, screen: null, sharedTo: null };
    if (p) {
      for (const c of KINDS) {
        const r = p.report;
        out[c] = p.grants[c] > 0 && !(r && r.settled[c] >= p.grants[c] && r.live[c] === 0);
      }
      const live = p.shares.filter((s) => !s.ended);
      if (live.length) out.screen = live.at(-1).kind === 'tab' ? `tab:${live.at(-1).title}` : live.at(-1).kind;
    }
    // Is this tab shown to another page?
    for (const [capturer, q] of this.pages) {
      const s = q.shares.find((x) => x.target === wcId && !x.ended);
      if (s) { out.sharedTo = s.host || 'another tab'; out.capturer = capturer; break; }
    }
    return out.camera || out.microphone || out.screen || out.sharedTo ? out : null;
  }

  changed(wcId) { this.onChange(wcId, this.state(wcId)); }

  // Shared tabs: isBeingCaptured() says when the capture really runs.
  watch() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.poll);
    this.timer.unref?.();
  }

  check() {
    let watching = false;
    for (const [wcId, p] of this.pages) {
      for (const s of p.shares.filter((x) => x.kind === 'tab' && !x.ended)) {
        const target = this.findTab(s.target)?.tab.view?.webContents;
        const live = !!target && !target.isDestroyed() && target.isBeingCaptured();
        if (live) s.seen = true;
        // It ended, or never started within a few seconds.
        if ((s.seen && !live) || (!s.seen && Date.now() - s.at > 6000) || !target) {
          s.ended = true;
          this.changed(wcId);
          this.changed(s.target);
        } else watching = true;
      }
    }
    if (!watching) { clearInterval(this.timer); this.timer = null; }
  }

  // "Stop sharing" on the page that captures (or on the tab it shows).
  stop(wcId) {
    const capturer = this.pages.has(wcId) && this.pages.get(wcId).shares.some((s) => !s.ended) ? wcId : this.state(wcId)?.capturer;
    const wc = capturer != null ? this.findTab(capturer)?.tab.view?.webContents : null;
    if (!wc || wc.isDestroyed()) return false;
    wc.send('capture:stop');
    setTimeout(() => {
      const p = this.pages.get(capturer);
      if (!p || wc.isDestroyed()) return;
      const still = p.shares.filter((s) => !s.ended);
      const tabStill = still.filter((s) => s.kind === 'tab').some((s) => this.findTab(s.target)?.tab.view?.webContents.isBeingCaptured());
      if (still.some((s) => s.kind !== 'tab') || tabStill) wc.reload();
      else if (still.length) { still.forEach((s) => { s.ended = true; }); this.changed(capturer); still.forEach((s) => s.target != null && this.changed(s.target)); }
    }, this.stopWait).unref?.();
    return true;
  }
}

// Tabs a page may share: the other tabs of its profile with a page loaded.
// windows: the profile's open windows.
function shareableTabs(windows, requester) {
  const out = [];
  for (const w of windows) {
    for (const t of w.tabs.tabs) {
      const wc = t.view?.webContents;
      if (!wc || wc === requester || wc.isDestroyed()) continue;
      out.push({ id: `tab:${wc.id}`, wcId: wc.id, name: t.title || wc.getURL(), url: w.tabs.displayUrl(t), favicon: t.favicon || null, tab: true });
    }
  }
  return out;
}

module.exports = { CaptureTracker, shareableTabs };
