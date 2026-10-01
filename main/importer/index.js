// Everything Lumio can import from: Chromium browsers and Safari on this
// computer, or exported files (bookmarks HTML, passwords CSV).
const chromium = require('./chromium');
const safari = require('./safari');
const { parseBookmarksHtml } = require('./files');

const detect = () => [...chromium.detect(), ...safari.detect()];

// opts: { bookmarks, history, passwords }; returns counts (and errors) to show.
async function importFrom(id, { store, passwordStore }, opts = {}) {
  if (id === 'safari') return safari.importFrom(store, opts);
  return chromium.importFrom(id, store, { ...opts, passwordStore });
}

module.exports = { detect, importFrom, parseBookmarksHtml };
