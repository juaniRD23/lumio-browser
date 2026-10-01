// Bookmarks from an exported file: the "Netscape bookmark file" HTML that
// Safari (File > Export > Bookmarks), Chrome, Edge and Firefox all make.
const unescape = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

function parseBookmarksHtml(html) {
  const out = [];
  for (const m of String(html).matchAll(/<A\s+([^>]*)>([\s\S]*?)<\/A>/gi)) {
    const href = /HREF\s*=\s*"([^"]*)"/i.exec(m[1])?.[1];
    if (!href || !/^https?:/i.test(href)) continue;
    const added = Number(/ADD_DATE\s*=\s*"(\d+)"/i.exec(m[1])?.[1]);
    const title = unescape(m[2].replace(/<[^>]+>/g, '').trim());
    out.push({ url: unescape(href), title: title || unescape(href), time: added ? added * 1000 : Date.now() });
  }
  return out;
}

module.exports = { parseBookmarksHtml };
