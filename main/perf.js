// Performance (Settings › Performance): Memory Saver, Energy Saver,
// performance issue alerts and preloading. These settings are app-wide, so
// they live in the first profile's settings (main/profiles.js).
//  - Memory Saver puts tabs you haven't looked at for a while to sleep
//    (TabManager.discard keeps their place and history). Its mode sets how
//    long "a while" is; sites on the "keep active" list never sleep.
//  - Energy Saver, on battery (at 20% or lower, or whenever unplugged):
//    background tabs are throttled, preloading pauses and the window's
//    animations stop (<html class="energy-saver">, see theme.css).
//  - Performance issue alerts: a background tab using a lot of memory or CPU
//    shows "Performance issues" in the toolbar, and Fix now puts it to sleep.
//  - Preload pages: connects ahead to the address bar's highlighted suggestion.
// Minutes a tab must go unseen before it sleeps.
const MEMORY_SAVER_MODES = { moderate: 240, balanced: 60, maximum: 15 };
const MEMORY_SAVER_SITES_MAX = 100;
// A background tab's process is "heavy" above these.
const ISSUE_MEMORY = 1024 ** 3; // 1 GB
const ISSUE_CPU = 70; // percent of a core, in two checks in a row
const CHECK_MS = 30_000;

const DEFAULTS = {
  memorySaver: true,
  memorySaverMode: null, // null: from the older memorySaverMinutes (or Balanced)
  memorySaverSites: [],
  energySaver: true,
  energySaverWhen: 'low', // 'low' (20% or lower) or 'unplugged'
  performanceAlerts: true,
  preloadPages: 'standard', // or 'off'
};

const settingsOf = (s = {}) => Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, s[k] ?? v]));

// Before modes there was a "Sleep tabs after" minutes setting; it maps to the nearest mode.
function memorySaverMode(s = {}) {
  if (MEMORY_SAVER_MODES[s.memorySaverMode]) return s.memorySaverMode;
  const m = Number(s.memorySaverMinutes) || 60;
  return m <= 30 ? 'maximum' : m >= 120 ? 'moderate' : 'balanced';
}

// Minutes until an unseen tab sleeps, or null when Memory Saver is off.
function sleepAfter(s = {}) {
  return s.memorySaver === false ? null : MEMORY_SAVER_MODES[memorySaverMode(s)];
}

// What someone typed in "Always keep these sites active", as a host:
// "https://www.youtube.com/watch?v=1" and "*.youtube.com" are youtube.com.
function normalizeSite(input) {
  let text = String(input || '').trim().toLowerCase().replace(/^\[\*\.\]|^\*\./, '');
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = 'https://' + text;
  let host;
  try { host = new URL(text).hostname; } catch { return null; }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!host || host.length > 253) return null;
  // A name with a dot (example.com), localhost, or an IP address.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$|^localhost$|^\[[0-9a-f:]+\]$/.test(host) ? host : null;
}

// Does the page at `url` belong to one of `sites` (or a subdomain of one)?
function keepsActive(url, sites = []) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return false; }
  return sites.some((site) => host === site || host.endsWith('.' + site));
}

// Is Energy Saver saving right now? power: { onBattery, level (0–1 or null) }.
function energySaverOn(s, power = {}) {
  const { energySaver, energySaverWhen } = settingsOf(s);
  if (!energySaver || !power.onBattery) return false;
  if (energySaverWhen === 'unplugged') return true;
  return Number.isFinite(power.level) && power.level <= 0.2;
}

// The address bar's highlighted suggestion (an overlay 'suggest' payload) as
// the origin worth connecting to ahead, if any.
function preconnectTarget(payload) {
  if (payload?.kind !== 'suggest') return null;
  const item = payload.items?.[payload.selected];
  if (!item || item.type === 'ai' || typeof item.url !== 'string') return null;
  try {
    const u = new URL(item.url);
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.origin : null;
  } catch { return null; }
}

// Background tabs whose process uses too much memory, or too much CPU now and
// at the last check. procs: [{ pid, memory (bytes), cpu (%), tabs: [{ active,
// audible, …}] }]; hotBefore: pids over the CPU line at the last check.
// Returns { heavy: [procs], hot: Set of pids over the CPU line now }.
function findIssues(procs, hotBefore = new Set(), { memory = ISSUE_MEMORY, cpu = ISSUE_CPU } = {}) {
  const hot = new Set();
  const heavy = [];
  for (const p of procs) {
    if (!p.tabs?.length || p.tabs.some((t) => t.active || t.audible)) continue;
    const busy = p.cpu >= cpu;
    if (busy) hot.add(p.pid);
    if (p.memory >= memory || (busy && hotBefore.has(p.pid))) heavy.push(p);
  }
  return { heavy, hot };
}

// Tabs' processes: pid -> [{ w, tab }] for every open page in every window.
function tabProcesses(windows) {
  const out = new Map();
  for (const w of windows) {
    for (const tab of w.tabs.tabs) {
      const wc = tab.view?.webContents;
      if (!wc || wc.isDestroyed()) continue;
      const pid = wc.getOSProcessId();
      if (!pid) continue;
      if (!out.has(pid)) out.set(pid, []);
      out.get(pid).push({ w, tab });
    }
  }
  return out;
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

class PerformanceManager {
  // store: where the settings are (the first profile's). windows: () => open
  // browser windows. toast: (w, text).
  constructor({ store, windows, toast }) {
    this.store = store;
    this.windows = windows;
    this.toast = toast;
    this.battery = { level: null, charging: null }; // from the window UI (navigator.getBattery)
    this.onBattery = false;
    this.saving = false; // Energy Saver is on right now
    this.hot = new Set();
    this.issue = null; // the alert being shown: { key, tabs }
    this.dismissed = new Map(); // tab key -> until (Not now)
    this.preconnected = new Map(); // origin -> time
  }

  get settings() { return settingsOf(this.store.settings); }

  start() {
    const { powerMonitor } = require('electron');
    try { this.onBattery = powerMonitor.isOnBatteryPower(); } catch { /* unknown: plugged in */ }
    powerMonitor.on('on-battery', () => { this.onBattery = true; this.update(); });
    powerMonitor.on('on-ac', () => { this.onBattery = false; this.update(); });
    this.store.settingsFile.onSave(() => this.update());
    // Memory Saver: once a minute, tabs nobody has looked at for a while go to sleep.
    setInterval(() => this.sleepIdle(), 60_000).unref?.();
    setInterval(() => this.checkIssues(), CHECK_MS).unref?.();
    this.update();
  }

  // ---- Memory Saver
  sleepIdle(now = Date.now()) {
    const minutes = sleepAfter(this.store.settings);
    if (!minutes) return 0;
    const sites = this.settings.memorySaverSites;
    let n = 0;
    for (const w of this.windows()) {
      if (w.ai?.isRunning()) continue; // Lumio may come back to any tab
      const tabs = w.tabs;
      for (const t of tabs.tabs) {
        if (!t.view || t.id === tabs.activeId || now - (t.lastActive || now) < minutes * 60_000) continue;
        if (!keepsActive(tabs.displayUrl(t), sites) && tabs.discard(t.id)) n++;
      }
    }
    return n;
  }

  setSites(list) {
    const sites = [...new Set((Array.isArray(list) ? list : []).map(normalizeSite).filter(Boolean))].slice(0, MEMORY_SAVER_SITES_MAX);
    this.store.setSetting('memorySaverSites', sites);
    return sites;
  }

  // ---- Energy Saver
  setBattery({ level, charging } = {}) {
    this.battery = { level: Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : null, charging: typeof charging === 'boolean' ? charging : null };
    this.update();
  }

  power() {
    // On battery when the system says so, or when the battery says it isn't charging.
    const onBattery = this.onBattery || this.battery.charging === false;
    return { onBattery, level: this.battery.level };
  }

  update() {
    const saving = energySaverOn(this.store.settings, this.power());
    if (saving === this.saving) return;
    this.saving = saving;
    for (const w of this.windows()) { this.applyWindow(w); w.emit('perf-state', this.shellState()); }
  }

  shellState() { return { energySaver: this.saving }; }

  // A new window (or one that just loaded its UI) picks up Energy Saver.
  watchWindow(w) {
    for (const wc of [w.win.webContents, w.overlay.webContents]) wc.on('did-finish-load', () => this.applyWindow(w));
  }

  applyWindow(w) {
    if (w.closed) return;
    const code = `document.documentElement.classList.toggle('energy-saver', ${this.saving})`;
    // (Background tabs are already throttled by Chromium; this turns off
    // Lumio's own animations, and preconnect() stops preloading.)
    for (const wc of [w.win.webContents, w.overlay.webContents]) if (!wc.isDestroyed()) wc.executeJavaScript(code).catch(() => {});
  }

  // A dropdown opened: the address bar's suggestions preload; the
  // performance popup opened from the keyboard takes the keyboard.
  overlayShown(w, payload) {
    if (payload?.kind === 'perf' && payload.focus) w.overlay.webContents.focus();
    this.preconnect(w, payload);
  }

  // ---- Preload pages
  preconnect(w, payload) {
    if (this.settings.preloadPages === 'off' || this.saving || w.incognito || w.profile.guest) return;
    const origin = preconnectTarget(payload);
    const now = Date.now();
    if (!origin || now - (this.preconnected.get(origin) || 0) < 10_000) return;
    this.preconnected.set(origin, now);
    if (this.preconnected.size > 200) this.preconnected.delete(this.preconnected.keys().next().value);
    try { w.profile.session.preconnect({ url: origin, numSockets: 1 }); } catch { /* not supported */ }
  }

  // ---- Performance issue alerts
  async checkIssues() {
    const { app } = require('electron');
    const windows = this.windows();
    if (!this.settings.performanceAlerts || !windows.length) { this.setIssue(null); return; }
    const owners = tabProcesses(windows);
    const procs = app.getAppMetrics().filter((m) => owners.has(m.pid)).map((m) => ({
      pid: m.pid,
      memory: (m.memory?.privateBytes || m.memory?.workingSetSize || 0) * 1024,
      cpu: m.cpu?.percentCPUUsage || 0,
      tabs: owners.get(m.pid).map(({ w, tab }) => ({ w, tab, active: tab.id === w.tabs.activeId && !w.win.isMinimized(), audible: !!tab.audible })),
    }));
    const { heavy, hot } = findIssues(procs, this.hot);
    this.hot = hot;
    const now = Date.now();
    const keep = this.settings.memorySaverSites;
    // Never a tab a Lumio AI is working in, or any tab of a window it's driving.
    const tabs = heavy.flatMap((p) => p.tabs.map((t) => ({ ...t, memory: p.memory / p.tabs.length, cpu: p.cpu })))
      .filter(({ w, tab }) => !tab.agent && !w.ai?.isRunning() && !keepsActive(w.tabs.displayUrl(tab), keep) && (this.dismissed.get(`${w.id}:${tab.id}`) || 0) < now);
    this.setIssue(tabs.length ? tabs : null);
  }

  setIssue(tabs) {
    const key = tabs ? tabs.map(({ w, tab }) => `${w.id}:${tab.id}`).sort().join(',') : null;
    if (key === (this.issue?.key || null)) return;
    this.issue = tabs ? { key, tabs } : null;
    for (const w of this.windows()) w.emit('perf-alert', this.alertPayload(w));
  }

  // The issue's tabs a window may see and act on: its own profile's (an
  // incognito window's are its incognito ones), never another profile's.
  tabsFor(w) {
    return (this.issue?.tabs || []).filter((t) => !w || t.w.profile === w.profile);
  }

  // What the toolbar's "Performance issues" button and its popup show in window w.
  alertPayload(w) {
    const tabs = this.tabsFor(w);
    if (!tabs.length) return null;
    return {
      tabs: tabs.slice(0, 6).map(({ w: tw, tab, memory, cpu }) => ({
        title: tab.title || hostOf(tw.tabs.displayUrl(tab)) || 'Tab', host: hostOf(tw.tabs.displayUrl(tab)), favicon: tab.favicon || null,
        memory: Math.round(memory), cpu: Math.round(cpu),
      })),
      count: tabs.length,
      memory: Math.round(tabs.reduce((sum, t) => sum + t.memory, 0)),
    };
  }

  // What's left of the issue once window w's tabs are handled.
  withoutTabsOf(w) {
    const rest = this.issue.tabs.filter((t) => !this.tabsFor(w).includes(t));
    this.setIssue(rest.length ? rest : null);
  }

  // Fix now: put the heavy background tabs to sleep (those from's profile owns).
  fix(from) {
    if (!this.issue) return 0;
    let freed = 0;
    let n = 0;
    for (const { w, tab, memory } of this.tabsFor(from)) {
      if (!w.closed && w.tabs.discard(tab.id)) { freed += memory; n++; }
    }
    this.withoutTabsOf(from);
    if (from && !from.closed) {
      const mb = Math.round(freed / 1024 ** 2);
      this.toast(from, n ? `${n === 1 ? 'A tab is' : `${n} tabs are`} sleeping now${mb ? `, freeing about ${mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB'}` : ''}` : 'Those tabs are busy right now. Try again in a moment.');
    }
    return n;
  }

  // Not now: don't bring these tabs up again for an hour.
  dismiss(from) {
    if (!this.issue) return;
    const until = Date.now() + 3600_000;
    for (const { w, tab } of this.tabsFor(from)) this.dismissed.set(`${w.id}:${tab.id}`, until);
    this.withoutTabsOf(from);
  }

  // ---- Settings › Performance
  pageState() {
    const s = this.settings;
    return {
      memorySaver: s.memorySaver !== false,
      mode: memorySaverMode(this.store.settings),
      modes: MEMORY_SAVER_MODES,
      sites: s.memorySaverSites,
      energySaver: !!s.energySaver,
      energySaverWhen: s.energySaverWhen === 'unplugged' ? 'unplugged' : 'low',
      saving: this.saving,
      battery: this.battery,
      alerts: s.performanceAlerts !== false,
      preload: s.preloadPages === 'off' ? 'off' : 'standard',
    };
  }

  set(key, value) {
    if (key === 'memorySaver') this.store.setSetting('memorySaver', !!value);
    else if (key === 'mode' && MEMORY_SAVER_MODES[value]) this.store.setSetting('memorySaverMode', value);
    else if (key === 'sites') this.setSites(value);
    else if (key === 'energySaver') this.store.setSetting('energySaver', !!value);
    else if (key === 'energySaverWhen' && ['low', 'unplugged'].includes(value)) this.store.setSetting('energySaverWhen', value);
    else if (key === 'alerts') { this.store.setSetting('performanceAlerts', !!value); if (!value) this.setIssue(null); }
    else if (key === 'preload' && ['standard', 'off'].includes(value)) this.store.setSetting('preloadPages', value);
    return this.pageState();
  }
}

module.exports = { PerformanceManager, memorySaverMode, sleepAfter, normalizeSite, keepsActive, energySaverOn, preconnectTarget, findIssues };
