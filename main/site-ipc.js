// IPC for site settings: the permission bubble and chips in the browser UI
// (renderer/ui/permission-chip.js, overlay-site.js) and the Site settings,
// Third-party cookies and Delete browsing data pages
// (lumio://settings/content…, /cookies, /clearBrowserData).
const { CATEGORIES, BY_ID, originOf, exceptionValues } = require('./site-settings');
const { RANGES } = require('./browsing-data');

const DECISIONS = ['allow', 'once', 'block', 'dismiss'];
const RANGE_VALUES = Object.values(RANGES);

// on / internalHandle: main.js's IPC helpers. normal(): the normal profile.
function registerSiteIpc({ on, internalHandle, normal, store, siteData, browsingData, openInternal }) {
  const settings = () => normal().permissions.settings;
  const category = (c) => ({ ...c, value: settings().defaultOf(c.id), count: settings().exceptionsFor(c.id).length, exceptions: exceptionValues(c) });

  // ---- the bubble and chips (browser UI) ----
  on('permission:respond', (w, { id, decision } = {}) => {
    if (DECISIONS.includes(decision)) w.profile.permissions.respond(Number(id), decision);
  });
  // "Allow for this site" on something Lumio blocked on this page.
  on('permission:allow-blocked', (w, { wcId, cat } = {}) => {
    const tab = w.tabs.tabs.find((t) => t.view?.webContents.id === wcId);
    const origin = tab && originOf(tab.view.webContents.getURL());
    if (!origin || !BY_ID[cat] || BY_ID[cat].kind === 'global') return;
    w.profile.permissions.set(origin, cat, 'allow');
    if (BY_ID[cat].kind === 'content') tab.view.webContents.reload();
    else w.emit('toast', { text: 'Allowed. Reload the page to use it.' });
  });
  on('permission:manage', (w, cat) => {
    w.hideOverlay();
    openInternal(BY_ID[cat] ? `lumio://settings/content/${cat}` : 'lumio://settings/content');
  });
  // Opened from the keyboard: the bubble takes focus (it's its own page).
  on('permission:focus-bubble', (w) => { if (w.overlayKind === 'permission') w.overlay.webContents.focus(); });
  // Esc in the bubble: back to the chip, so the keyboard isn't lost.
  on('permission:bubble-closed', (w, { refocus } = {}) => {
    if (w.overlayKind === 'permission') w.hideOverlay();
    if (refocus) { w.win.webContents.focus(); w.emit('permission-focus', {}); }
  });

  // ---- Site settings pages ----
  internalHandle('page:site-settings', ['settings'], () => ({
    categories: CATEGORIES.map(category),
    // Recent activity: the last sites whose settings changed.
    recent: settings().sites().sort((a, b) => b.time - a.time).slice(0, 4),
  }));
  internalHandle('page:site-category', ['settings'], (_ctx, id) => {
    const c = BY_ID[id];
    return c ? { category: category(c), sites: settings().exceptionsFor(id) } : null;
  });
  internalHandle('page:site-set-default', ['settings'], (_ctx, id, value) => settings().setDefault(String(id), String(value)));
  internalHandle('page:site-set', ['settings'], (_ctx, origin, id, value) => settings().set(String(origin || ''), String(id), value == null ? undefined : String(value)));
  internalHandle('page:site-reset', ['settings'], (_ctx, origin) => settings().resetSite(String(origin || '')));
  internalHandle('page:site-all', ['settings'], ({ sender }) => siteData.list(sender));
  internalHandle('page:site-details', ['settings'], async ({ sender }, input) => {
    const origin = originOf(input);
    if (!origin) return null;
    const s = settings();
    return {
      ...(await siteData.details(origin, sender)),
      host: new URL(origin).host,
      favicon: store.faviconFor(origin + '/'),
      settings: CATEGORIES.filter((c) => exceptionValues(c).length).map((c) => ({
        id: c.id, label: c.label, kind: c.kind, value: s.exception(origin, c.id) ?? null, default: s.defaultOf(c.id), exceptions: exceptionValues(c), text: c.text,
      })),
    };
  });
  // site: a registrable domain, as the All sites list names it.
  internalHandle('page:site-delete', ['settings'], (_ctx, site, opts) => (/^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/i.test(String(site)) ? siteData.deleteSite(String(site), { permissions: !!opts?.permissions }) : false));
  internalHandle('page:site-delete-all', ['settings'], () => siteData.deleteAll());

  // ---- Delete browsing data ----
  internalHandle('page:clear-data-counts', ['settings'], (_ctx, range) => browsingData.counts({ range: RANGE_VALUES.includes(range) ? range : 0 }));
}

module.exports = { registerSiteIpc };
