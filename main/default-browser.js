// "Lumio isn't your default browser [Set as default]" at startup, like
// Chrome's bar. Closing it three times, or turning it off in Settings ›
// Default browser, stops it. Never on the first run (the welcome screens
// offer it), in tests, or in a development build (which can't become the
// default).
const MAX_DISMISSALS = 3;

function shouldOffer(settings = {}, { isDefault = false, packaged = false, test = false, firstRun = false } = {}) {
  if (test || !packaged || isDefault || firstRun) return false;
  if (settings.defaultBrowserPrompt === false) return false;
  return (Number(settings.defaultBrowserDismissals) || 0) < MAX_DISMISSALS;
}

// deps: { store, infobars, makeDefault() }
function offerDefaultBrowser(w, deps) {
  deps.infobars.show(w, {
    id: 'default-browser',
    text: 'Lumio isn’t your default browser',
    actions: [{ id: 'set', label: 'Set as default', primary: true }],
    onAction: () => deps.makeDefault(),
    onClose: () => {
      const n = (Number(deps.store.settings.defaultBrowserDismissals) || 0) + 1;
      deps.store.setSetting('defaultBrowserDismissals', n);
    },
  });
}

// Settings › Default browser: "Ask at startup" (closing the bar three times
// turns it off; turning it back on starts the count again).
function register({ internalHandle, store, infobars, alive }) {
  const state = () => ({ prompt: store.settings.defaultBrowserPrompt !== false && (Number(store.settings.defaultBrowserDismissals) || 0) < MAX_DISMISSALS });
  internalHandle('page:default-prompt', ['settings'], () => state());
  internalHandle('page:set-default-prompt', ['settings'], (_ctx, on) => {
    store.setSetting('defaultBrowserPrompt', !!on);
    if (on) store.setSetting('defaultBrowserDismissals', 0);
    else for (const w of alive()) infobars.hide(w, 'default-browser');
    return state();
  });
}

module.exports = { shouldOffer, offerDefaultBrowser, register, MAX_DISMISSALS };
