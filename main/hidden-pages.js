// Pages Lumio AI loads out of sight (web_search, read_url): never shown, so
// they can't download files or ask for permissions (main/features.js checks).
const hidden = new WeakSet();
module.exports = { hidden, isHidden: (wc) => !!wc && hidden.has(wc) };
