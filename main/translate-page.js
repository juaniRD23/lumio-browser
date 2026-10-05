// The part of page translation that runs inside the page, in an isolated
// world (the page's own scripts can't see it). It finds the page's text,
// hands it out a batch at a time as it comes into view, swaps translations
// into the text nodes themselves (so links, buttons, inputs and the rest of
// the markup stay exactly as they were) and can put the original back.
//
// main/translate.js runs it as `(translatePage)(command, arg)`; it keeps its
// state on the isolated world's window between calls, until the page goes
// away. Self-contained: it's turned into a string and run in the page.
function translatePage(cmd, arg) {
  const T = window.__lumioTranslate || (window.__lumioTranslate = create());
  return T[cmd] ? T[cmd](arg || {}) : null;

  function create() {
    // Never translated: code, things people type into, and anything the page
    // marks as not to be translated.
    const SKIP = 'script, style, noscript, template, textarea, input, select, option, code, pre, kbd, samp, var, svg, math, canvas, iframe, object, [translate="no"], .notranslate, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
    // Inline elements are part of their paragraph; anything else starts a block.
    const INLINE = new Set(['A', 'ABBR', 'ACRONYM', 'B', 'BDI', 'BDO', 'BIG', 'CITE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'INS', 'LABEL', 'MARK', 'NOBR', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U']);
    const LETTER = /\p{L}/u;
    const MAX_PIECE = 5000; // longer runs of text are left as they are

    const blocks = new Map(); // block element -> { id, el, nodes, sending }
    const byId = new Map();
    const tracked = new WeakSet(); // text nodes already in a block
    const original = new WeakMap(); // text node -> the page's own text
    const translated = new WeakMap(); // text node -> its translation (kept for "Translate" again)
    const shown = new WeakMap(); // text node -> the text Lumio put there
    const tried = new WeakSet(); // sent, but the model left it out
    const near = new Set(); // blocks on or near the screen
    let on = false;
    let nextId = 1;
    let sentChars = 0;
    let pageLimit = Infinity; // a page's limit (an endless feed shouldn't use up the allowance)

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const rec = blocks.get(e.target);
        if (!rec) continue;
        if (e.isIntersecting) near.add(rec); else if (!rec.sending) near.delete(rec);
      }
    }, { rootMargin: '100% 0px' }); // a screen ahead, so text is ready as it scrolls in

    // New content (infinite scroll, single-page apps) and text the page
    // itself changes after Lumio translated it.
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') r.addedNodes.forEach((n) => scan(n));
        else if (r.type === 'characterData' && tracked.has(r.target) && r.target.data !== shown.get(r.target)) {
          original.set(r.target, r.target.data);
          translated.delete(r.target);
          tried.delete(r.target);
          shown.delete(r.target);
        }
      }
    });

    const wanted = (node) => {
      if (!LETTER.test(node.data) || tracked.has(node)) return false;
      const parent = node.parentElement;
      return !!parent && !parent.closest(SKIP);
    };
    function blockOf(el) {
      while (el.parentElement && el !== document.body && INLINE.has(el.tagName)) el = el.parentElement;
      return el;
    }
    function scan(root) {
      if (!root || !document.body) return;
      if (root.nodeType === Node.TEXT_NODE) { if (wanted(root)) add(root); return; }
      if (root.nodeType !== Node.ELEMENT_NODE) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (wanted(n)) add(n);
    }
    function add(node) {
      tracked.add(node);
      original.set(node, node.data);
      const el = blockOf(node.parentElement);
      let rec = blocks.get(el);
      if (!rec) {
        rec = { id: nextId++, el, nodes: [], sending: null };
        blocks.set(el, rec);
        byId.set(rec.id, rec);
        if (on) io.observe(el);
      }
      rec.nodes.push(node);
    }
    function show(node, text) {
      const o = original.get(node) || '';
      const value = (o.match(/^\s*/)[0]) + text + (o.match(/\s*$/)[0]);
      shown.set(node, value);
      if (node.data !== value) node.data = value;
    }
    const waiting = (node) => node.isConnected && !translated.has(node) && !tried.has(node) && original.get(node).length <= MAX_PIECE;
    const pending = (rec) => !rec.sending && rec.el.isConnected && rec.nodes.some(waiting);
    const inView = (el) => {
      const r = el.getBoundingClientRect();
      return (r.width || r.height) && r.bottom > -innerHeight && r.top < innerHeight * 2;
    };
    const status = () => ({ on, total: blocks.size, waiting: [...near].filter(pending).length, sentChars });

    return {
      // Starts (or restarts) translating: what was translated before shows
      // again right away, and the rest follows as it comes into view.
      start({ maxPageChars = 200_000 } = {}) {
        on = true;
        pageLimit = maxPageChars;
        scan(document.body);
        for (const rec of blocks.values()) {
          io.observe(rec.el);
          if (rec.el.isConnected && inView(rec.el)) near.add(rec);
          for (const n of rec.nodes) if (translated.has(n) && n.isConnected) show(n, translated.get(n));
        }
        if (document.body) mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        return status();
      },
      // The next batch: blocks on or near the screen, in page order.
      collect({ maxChars = 3500, maxBlocks = 60, maxPieces = 300 } = {}) {
        if (!on) return { blocks: [], ...status() };
        const out = [];
        let chars = 0;
        let pieces = 0;
        const list = [...near].filter(pending).sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        for (const rec of list) {
          if (sentChars >= pageLimit) break;
          const nodes = rec.nodes.filter(waiting);
          const texts = nodes.map((n) => original.get(n).trim());
          const size = texts.reduce((a, t) => a + t.length, 0);
          if (out.length && (chars + size > maxChars || out.length >= maxBlocks || pieces + texts.length > maxPieces)) break;
          if (texts.length > maxPieces || size > maxChars * 2) { nodes.forEach((n) => tried.add(n)); continue; } // too big for one batch
          rec.sending = nodes;
          out.push({ id: rec.id, texts });
          chars += size;
          pieces += texts.length;
          sentChars += size;
        }
        return { blocks: out, capped: sentChars >= pageLimit, ...status() };
      },
      // Translations for a batch: shown now if translating is still on.
      apply({ results = [] } = {}) {
        let n = 0;
        for (const { id, texts } of results) {
          const rec = byId.get(id);
          if (!rec?.sending) continue;
          rec.sending.forEach((node, i) => {
            const t = Array.isArray(texts) && typeof texts[i] === 'string' && texts[i].trim() ? texts[i].trim() : null;
            if (!t) { tried.add(node); return; }
            translated.set(node, t);
            if (on && node.isConnected && node.data === (shown.get(node) ?? original.get(node))) { show(node, t); n++; }
          });
          rec.sending = null;
        }
        return { applied: n, ...status() };
      },
      // A batch that failed: its text can be sent again.
      release({ ids = [] } = {}) {
        for (const id of ids) {
          const rec = byId.get(id);
          if (rec?.sending) { sentChars -= rec.sending.reduce((a, n) => a + original.get(n).trim().length, 0); rec.sending = null; }
        }
        return status();
      },
      // Shows the page's own text again (translations are kept, so turning
      // translation back on is instant).
      restore() {
        on = false;
        io.disconnect();
        mo.disconnect();
        near.clear();
        let n = 0;
        for (const rec of blocks.values()) {
          rec.sending = null;
          for (const node of rec.nodes) {
            if (shown.has(node) && node.data === shown.get(node)) { node.data = original.get(node); n++; }
            shown.delete(node);
          }
        }
        return { restored: n, ...status() };
      },
      // Back to the original and forget the translations (another language).
      reset() {
        const r = this.restore();
        for (const rec of blocks.values()) for (const node of rec.nodes) { translated.delete(node); tried.delete(node); }
        sentChars = 0;
        return r;
      },
    };
  }
}

// What the page offers for spotting its language: <html lang> (or
// Content-Language) and a sample of its readable text.
function languageSample() {
  const meta = document.querySelector('meta[http-equiv="content-language" i]')?.getAttribute('content') || '';
  const htmlLang = document.documentElement.getAttribute('lang') || meta.split(',')[0] || '';
  let sample = '';
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && sample.length < 3000; n = walker.nextNode()) {
      if (!/\p{L}/u.test(n.data) || n.parentElement?.closest('script, style, noscript, template, code, pre, textarea, [translate="no"], .notranslate')) continue;
      sample += n.data.replace(/\s+/g, ' ').trim() + ' ';
    }
  }
  return { htmlLang, sample: sample.slice(0, 3000) };
}

module.exports = { translatePage, languageSample };
