// Everything Lumio can import from: Chromium browsers, Firefox and Safari on
// this computer (each profile, when a browser has several), or exported
// files (bookmarks HTML, passwords CSV).
const chromium = require('./chromium');
const firefox = require('./firefox');
const safari = require('./safari');
const { parseBookmarksHtml } = require('./files');

const detect = () => [...chromium.detect(), ...firefox.detect(), ...safari.detect()];

// opts: { bookmarks, history, passwords }; returns counts (and errors) to show.
async function importFrom(id, { store, passwordStore }, opts = {}) {
  if (id === 'safari') return safari.importFrom(store, opts);
  if (/^firefox(:|$)/.test(id)) return firefox.importFrom(id, store, opts);
  return chromium.importFrom(id, store, { ...opts, passwordStore });
}

module.exports = { detect, importFrom, parseBookmarksHtml };
