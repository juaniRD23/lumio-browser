// A tab whose page crashed shows lumio://error/?code=crashed (main/tabs.js)
// with a Reload button, like Chrome's sad tab. Reload goes back to the page
// that crashed (keeping its place in the tab's history) and drops the
// crashed page from the history, so Forward doesn't lead back to it.
const { isCrashPage } = require('./sessions');

function reloadCrashed(w, tab) {
  const wc = tab?.view?.webContents;
  if (!wc || wc.isDestroyed()) return false;
  const h = wc.navigationHistory;
  const at = h.getActiveIndex();
  const here = h.getEntryAtIndex(at)?.url || '';
  if (!isCrashPage(here)) return false;
  let failed = '';
  try { failed = new URL(here).searchParams.get('url') || ''; } catch { /* no address */ }
  if (at > 0 && failed && h.getEntryAtIndex(at - 1)?.url === failed) {
    wc.once('did-navigate', () => {
      if (!wc.isDestroyed() && isCrashPage(h.getEntryAtIndex(at)?.url)) h.removeEntryAtIndex(at);
    });
    h.goToIndex(at - 1);
    return true;
  }
  // The page crashed before it was in the history: load its address again.
  if (failed) w.tabs.navigate(failed, tab.id);
  return !!failed;
}

function register({ internalHandle }) {
  internalHandle('page:reload-crashed', ['error'], ({ w, tab }) => reloadCrashed(w, tab));
}

module.exports = { register, reloadCrashed };
