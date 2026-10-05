// Sessions, the way Chrome keeps them:
//  - each tab's back/forward pages are saved with it (up to 6 on either side
//    of the page it's on, like Chrome), so Back still works after a restart,
//    in a reopened tab or window, and in a duplicated tab
//  - if Lumio didn't quit properly last time, it doesn't reopen the old
//    windows by itself (a page that crashed it could crash it again); a
//    "Restore pages?" bar offers them instead
//  - when Lumio starts without reopening them (Settings › On startup), the
//    last session's windows wait in Recently Closed, so ⇧⌘T brings them back
// The parts that don't need Electron are plain functions (tests/sessions.test.mjs).
const fs = require('fs');
const path = require('path');

const KEEP = 6; // Chrome's gMaxPersistNavigationCount: pages kept on each side of the current one
const MAX_PAGE_STATE = 64 * 1024; // a page's scroll position and form fields, when small enough
const MAX_URL = 8192;
const MARKER = 'Lumio Running'; // there while Lumio runs; a clean quit removes it
const NEWTAB = 'lumio://newtab/';

// An error page stands for the address that failed: restoring it tries again.
function realUrl(url) {
  const s = String(url || '');
  if (!s.startsWith('lumio://error')) return s;
  try { return new URL(s).searchParams.get('url') || ''; } catch { return ''; }
}

// The sad-tab page shown after a tab's page crashed (main/tabs.js).
function isCrashPage(url) {
  if (!String(url || '').startsWith('lumio://error')) return false;
  // 'hung': "Exit page" in "Page unresponsive" stopped it.
  try { return ['crashed', 'hung'].includes(new URL(url).searchParams.get('code')); } catch { return false; }
}

// A tab's history as sessions keep it: { entries: [{ url, title, pageState? }], index },
// or null when there's nothing to go back or forward to. Also tidies history
// read back from disk, so a damaged session file can't feed odd entries in.
function trimHistory(entries, index) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const at = Number.isInteger(index) && index >= 0 && index < entries.length ? index : entries.length - 1;
  const out = [];
  let current = -1;
  for (let i = Math.max(0, at - KEEP); i <= Math.min(entries.length - 1, at + KEEP); i++) {
    const e = entries[i] && typeof entries[i] === 'object' ? entries[i] : {};
    const raw = typeof e.url === 'string' ? e.url : '';
    const url = realUrl(raw);
    if (!url || url.length > MAX_URL) { if (i === at) current = out.length - 1; continue; }
    // A failed page and its error page are the same page.
    if (url !== raw && out.length && out[out.length - 1].url === url) { if (i === at) current = out.length - 1; continue; }
    const entry = { url, title: typeof e.title === 'string' ? e.title.slice(0, 300) : '' };
    if (url === raw && typeof e.pageState === 'string' && e.pageState.length <= MAX_PAGE_STATE) entry.pageState = e.pageState;
    out.push(entry);
    if (i === at) current = out.length - 1;
  }
  if (!out.length) return null;
  return { entries: out, index: Math.max(0, current) };
}

// The history of one of Lumio's tabs: from its page, or the history a tab
// keeps while it isn't loaded (restored and not opened yet, or asleep).
function historyOf(tab) {
  const wc = tab?.view?.webContents;
  if (wc && !wc.isDestroyed()) {
    const h = wc.navigationHistory;
    const live = trimHistory(h.getAllEntries(), h.getActiveIndex());
    if (live) return live;
  }
  return tab?.savedHistory ? trimHistory(tab.savedHistory.entries, tab.savedHistory.index) : null;
}

// What opens at launch. plan: main/startup.js's startupPlan(); lastSession:
// the windows saved last time. After a crash nothing reopens by itself and
// the bar offers the last session; whenever the session isn't reopened, its
// windows also wait in Recently Closed (so closing the bar doesn't lose them).
function launchPlan(plan, { crashed = false, lastSession = [] } = {}) {
  const last = Array.isArray(lastSession) ? lastSession.filter((w) => w && Array.isArray(w.tabs) && w.tabs.length) : [];
  if (crashed) return { windows: [], urls: plan.urls || [], offer: last.length ? last : null, recent: last };
  return { windows: plan.windows || [], urls: plan.urls || [], offer: null, recent: (plan.windows || []).length ? [] : last };
}

// A file in the profile that's there only while Lumio runs: still there at
// launch means the last run ended without quitting (a crash, a force quit,
// the power went out). Like Chrome's "exit type".
class RunMarker {
  constructor(dir) { this.file = path.join(dir, MARKER); }
  start() {
    let unclean = false;
    try { unclean = fs.existsSync(this.file); } catch { /* treat as clean */ }
    try { fs.writeFileSync(this.file, String(process.pid)); } catch { /* read-only profile: no crash bar */ }
    return unclean;
  }
  // Only this run's marker (another copy of Lumio that started and gave way
  // to this one must not take it).
  end() {
    try {
      if (fs.readFileSync(this.file, 'utf8') === String(process.pid)) fs.rmSync(this.file, { force: true });
    } catch { /* already gone */ }
  }
}

// The "Restore pages?" bar and Recently Closed's copy of the last session.
// deps: { infobars, createWindow(opts), recentlyClosed: [], recentChanged() }
class Sessions {
  constructor(deps) {
    this.deps = deps;
    this.offer = null; // the crashed session's windows, until restored or dismissed
    this.offered = []; // ...and their Recently Closed entries
  }

  // Called once at launch, before the first window opens. plan: what
  // Settings › On startup opens; lastSession: the windows saved last time.
  // earlier: crashed windows from a run before that weren't restored (pending()).
  begin(plan, lastSession, dir, earlier = []) {
    this.marker = new RunMarker(dir);
    const crashed = this.marker.start();
    const out = launchPlan(plan, { crashed, lastSession });
    this.offer = out.offer;
    const now = Date.now();
    const add = (s) => {
      const entry = { kind: 'window', ...s, title: s.tabs[Math.min(s.active || 0, s.tabs.length - 1)]?.title || 'Window', time: now };
      this.deps.recentlyClosed.push(entry);
      return entry;
    };
    const kept = launchPlan({}, { crashed: true, lastSession: earlier }).recent;
    this.kept = kept.map(add);
    for (const s of out.recent) {
      const entry = add(s);
      if (crashed) this.offered.push(entry);
    }
    return out;
  }

  // The crashed session's windows still waiting in Recently Closed. The
  // session file keeps them (store.saveSession), so they aren't lost when
  // the new windows are saved over them, or if Lumio stops again.
  pending() {
    const recent = this.deps.recentlyClosed;
    return [...(this.kept || []), ...this.offered].filter((e) => recent.includes(e) && e.tabs?.length)
      .map(({ tabs, active, bounds, maximized }) => ({ tabs, active, bounds, ...(maximized ? { maximized } : {}) }));
  }

  // Browsing data's "Recently closed" was cleared: nothing left to restore.
  forget(windows = []) {
    this.offer = null;
    this.offered = [];
    this.kept = [];
    for (const w of windows) this.deps.infobars.hide(w, 'restore');
  }

  // A clean quit: next launch reopens normally.
  end() { this.marker?.end(); }

  // The bar, in the first window that opens after a crash.
  offerRestore(w) {
    if (!this.offer || !w) return;
    this.deps.infobars.show(w, {
      id: 'restore',
      title: 'Restore pages?',
      text: 'Lumio didn’t shut down correctly.',
      actions: [{ id: 'restore', label: 'Restore', primary: true }],
      onAction: (win) => this.restore(win),
      onClose: () => { this.offer = null; },
    });
  }

  // Reopens the crashed session: its first window's tabs in this window (in
  // place of a new tab page nobody used), the others as windows of their own.
  restore(w) {
    this.offer = null;
    // Only the windows still waiting: one already reopened from Recently
    // Closed (whole) isn't opened twice, and one reopened tab by tab keeps
    // only the tabs left. Back open, so no longer under Recently Closed.
    const recent = this.deps.recentlyClosed;
    const list = [];
    for (const entry of this.offered.splice(0)) {
      const i = recent.indexOf(entry);
      if (i < 0) continue;
      recent.splice(i, 1);
      if (entry.tabs?.length) list.push(entry);
    }
    if (!list.length) return;
    this.deps.recentChanged?.();
    const target = w && !w.closed && !w.incognito ? w : null;
    list.forEach((s, i) => {
      if (i === 0 && target) this.restoreInto(target, s);
      else this.deps.createWindow({ tabs: s.tabs, active: s.active, bounds: s.bounds, maximized: !!s.maximized });
    });
  }

  restoreInto(w, s) {
    const m = w.tabs;
    const blank = m.tabs.length === 1 && isUnusedNewTab(m.tabs[0]) ? m.tabs[0] : null;
    m.restore(s.tabs, s.active);
    if (blank && m.tabs.length > 1) m.close(blank.id);
  }
}

function isUnusedNewTab(tab) {
  const url = tab.pendingUrl || tab.url || '';
  if (url !== NEWTAB) return false;
  const wc = tab.view?.webContents;
  return !wc || wc.isDestroyed() || wc.navigationHistory.length() <= 1;
}

module.exports = { Sessions, RunMarker, trimHistory, historyOf, launchPlan, realUrl, isCrashPage, KEEP, MAX_PAGE_STATE };
