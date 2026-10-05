// Bookmarks from an exported file: the "Netscape bookmark file" HTML that
// Safari (File > Export > Bookmarks), Chrome, Edge and Firefox all make.
// Folders are kept: the browser's toolbar folder becomes the Bookmarks bar,
// a "Mobile bookmarks" folder becomes Mobile bookmarks, and everything else
// goes in Other bookmarks (as Chrome lays out its own export).
const unescape = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const text = (html) => unescape(String(html).replace(/<[^>]+>/g, '').trim());
const attr = (attrs, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)?.[1];
// What other browsers call their bookmarks bar, when the file doesn't mark it.
const BAR_NAMES = /^(bookmarks bar|bookmarks toolbar|favorites bar|favorites|favourites)$/i;

// Returns { bar, other, mobile }: lists of { title, url, time } and
// { title, time, children }.
function parseBookmarksHtml(html) {
  const top = { children: [] };
  const stack = [top];
  let pending = null; // a folder whose <DL> comes next
  const re = /<DL\b[^>]*>|<\/DL\s*>|<H3\b([^>]*)>([\s\S]*?)<\/H3\s*>|<A\s+([^>]*)>([\s\S]*?)<\/A\s*>/gi;
  for (const m of String(html).matchAll(re)) {
    const tag = m[0].slice(0, 3).toUpperCase();
    const here = stack[stack.length - 1];
    if (tag === '<DL') { if (pending) { stack.push(pending); pending = null; } continue; }
    if (tag === '</D') { if (stack.length > 1) stack.pop(); continue; }
    if (tag === '<H3') {
      const added = Number(attr(m[1], 'ADD_DATE'));
      pending = { title: text(m[2]) || 'Folder', time: added ? added * 1000 : Date.now(), children: [], attrs: m[1] };
      here.children.push(pending);
      continue;
    }
    const href = attr(m[3], 'HREF');
    if (!href || !/^https?:/i.test(unescape(href))) continue;
    const added = Number(attr(m[3], 'ADD_DATE'));
    here.children.push({ url: unescape(href), title: text(m[4]) || unescape(href), time: added ? added * 1000 : Date.now() });
  }
  const out = { bar: [], other: [], mobile: [] };
  const marked = top.children.some((n) => n.attrs && /PERSONAL_TOOLBAR_FOLDER\s*=\s*"true"/i.test(n.attrs));
  let barTaken = false;
  for (const n of top.children) {
    const attrs = n.attrs || '';
    delete n.attrs;
    if (!n.children) { out.other.push(n); continue; }
    if (/com\.apple\.ReadingList/i.test(attrs)) continue; // Safari's reading list isn't bookmarks
    if (!barTaken && (marked ? /PERSONAL_TOOLBAR_FOLDER\s*=\s*"true"/i.test(attrs) : BAR_NAMES.test(n.title))) { out.bar.push(...n.children); barTaken = true; continue; }
    if (/UNFILED_BOOKMARKS_FOLDER\s*=\s*"true"/i.test(attrs)) { out.other.push(...n.children); continue; }
    if (/^mobile bookmarks$/i.test(n.title)) { out.mobile.push(...n.children); continue; }
    out.other.push(n);
  }
  const strip = (list) => list.forEach((n) => { if (n.children) { delete n.attrs; strip(n.children); } });
  strip(out.bar); strip(out.other); strip(out.mobile);
  return out;
}

module.exports = { parseBookmarksHtml };
