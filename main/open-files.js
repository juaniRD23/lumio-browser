// Files and links other apps ask Lumio to open: Finder and the Dock on the Mac
// ("Open With", a double-click when Lumio is the default, a file dropped on
// its icon), and the command line on Windows. Only what a tab shows as a page:
// web pages, PDFs, pictures and text. Anything else would just download.
// build/mac-documents.mjs declares the same kinds to macOS.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const OPENABLE = ['html', 'htm', 'xhtml', 'xht', 'pdf', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'txt'];
const OPENABLE_RE = new RegExp(`\\.(${OPENABLE.join('|')})$`, 'i');

// A file:// address for a file Lumio opens, or null (not one, or not there).
function fileUrl(file) {
  if (typeof file !== 'string' || file.startsWith('-') || !OPENABLE_RE.test(file)) return null;
  try {
    return fs.statSync(file).isFile() ? pathToFileURL(path.resolve(file)).href : null;
  } catch { return null; }
}

// What a command line asks Lumio to open: web addresses, and files.
function launchTargets(argv) {
  const out = [];
  for (const a of argv) {
    if (/^https?:\/\//i.test(a)) out.push(a);
    else {
      const url = fileUrl(a);
      if (url) out.push(url);
    }
  }
  return out;
}

module.exports = { OPENABLE, fileUrl, launchTargets };
