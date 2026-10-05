// Lumio's UI in other languages. English is the source: the strings in the
// code are the keys of a locale table (renderer/assets/i18n/es.js), like
// gettext. The same file runs in two places:
//  - main process (main/i18n.js) requires the lookup to translate menus,
//    dialogs and notifications;
//  - every lumio:// page loads it (main/protocol.js adds it, with the locale
//    table, at the top of <head> when Lumio isn't in English). It translates
//    the page as it's parsed and anything the page's scripts add later, so
//    the pages themselves stay plain English.
// Keys with placeholders are patterns: {x} is any text, {#x} a number and
// {@x} text that is itself translated, or a list of such texts joined with
// commas ("Imported {@what}." with "3 bookmarks, 2 passwords"). Text inside
// user content (page titles, bookmarks, chats, file names: SKIP below) and
// anything marked translate="no" is left alone, so a bookmark named
// "Settings" doesn't change.
(function (root) {
  'use strict';

  // Quotes and whitespace don't matter when matching: "Can't" finds "Can’t".
  const norm = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // "Back (⌘[)", "Hide (Ctrl+Shift+L)": the words before a keyboard shortcut.
  const SHORTCUT = /^(.+?)(\s*\((?:[⌘⇧⌥⌃↵]|Ctrl|Shift|Alt|Cmd|Esc|Enter|Del|Tab|F\d)[^()]*\))$/;
  const firstWord = (s) => (/^[^\s]+/.exec(s)?.[0] || '').toLowerCase();

  const PLACEHOLDER = /\{([#@]?)(\w+)\}/g;

  // A locale table ({ English: translation }) ready for lookups.
  function compile(table) {
    const exact = new Map();
    const byWord = new Map(); // patterns that start with a word, by that word
    const loose = []; // patterns that start with a placeholder
    const outputs = new Set(); // translations, which are never translated again
    let longest = 0;
    for (const [en, out] of Object.entries(table || {})) {
      const key = norm(en);
      longest = Math.max(longest, key.length);
      if (!/\{[#@]?\w+\}/.test(key)) { exact.set(key, out); outputs.add(norm(out)); continue; }
      const names = [];
      const source = key.split(/(\{[#@]?\w+\})/).map((part) => {
        const m = /^\{([#@]?)(\w+)\}$/.exec(part);
        // Its quotes match either kind; the values keep the ones they came with.
        if (!m) return escapeRe(part).replace(/'/g, "['‘’]").replace(/"/g, '["“”]');
        names.push({ name: m[2], kind: m[1] });
        // A value never spans " · " or a new line: those join separate parts.
        return m[1] === '#' ? '([-+]?\\d[\\d.,]*)' : '((?:(?! · )[^\\n])+?)';
      }).join('');
      const p = { re: new RegExp(`^${source}$`), names, out, fixed: key.replace(/\{[#@]?\w+\}/g, '').length };
      // Indexed by its first word, unless that word has a placeholder in it.
      const w = firstWord(key);
      if (w.includes('{')) loose.push(p);
      else {
        if (!byWord.has(w)) byWord.set(w, []);
        byWord.get(w).push(p);
      }
    }
    // The most specific pattern wins: "Lumio Browser {v} is here" before "Lumio {plan}".
    const bySpecific = (a, b) => b.fixed - a.fixed;
    for (const list of byWord.values()) list.sort(bySpecific);
    loose.sort(bySpecific);
    return { exact, byWord, loose, outputs, longest: longest + 200, memo: new Map() };
  }

  // A pattern's translation with the values it matched put back in.
  function fill(p, m, c, depth) {
    const values = {};
    p.names.forEach(({ name, kind }, i) => {
      values[name] = kind === '@' ? lookup(c, m[i + 1], depth + 1) ?? lookupList(c, m[i + 1], depth + 1) ?? m[i + 1] : m[i + 1];
    });
    return p.out.replace(PLACEHOLDER, (all, _kind, name) => (name in values ? values[name] : all));
  }

  // The translation of one trimmed piece of text, or null.
  function lookup(c, text, depth = 0) {
    if (depth > 3 || !text) return null;
    const key = norm(text);
    if (c.exact.has(key)) return c.exact.get(key);
    if (c.outputs.has(key)) return null; // already translated
    const shortcut = SHORTCUT.exec(key);
    if (shortcut) {
      const head = lookup(c, shortcut[1], depth + 1);
      if (head != null) return head + shortcut[2];
    }
    if (key.endsWith(':') && c.exact.has(key.slice(0, -1).trim())) return c.exact.get(key.slice(0, -1).trim()) + ':';
    // Separate lines are separate texts (a tooltip listing several tabs):
    // a pattern never joins them.
    if (text.includes('\n')) return joined(c, text, '\n', depth);
    const asWritten = String(text).replace(/\s+/g, ' ').trim();
    for (const p of [...(c.byWord.get(firstWord(key)) || []), ...c.loose]) {
      const m = p.re.exec(asWritten);
      if (m) return fill(p, m, c, depth);
    }
    // Parts joined with " · " ("Paused · 2 MB of 9 MB").
    return text.includes(' · ') ? joined(c, text, ' · ', depth) : null;
  }

  // Each part of text split at sep translated, or null if none is.
  function joined(c, text, sep, depth) {
    const parts = text.split(sep);
    const done = parts.map((part) => (part.trim() ? lookup(c, part, depth + 1) : null));
    return done.some((d) => d != null) ? parts.map((part, i) => (done[i] == null ? part : part.replace(part.trim(), done[i]))).join(sep) : null;
  }

  // "3 bookmarks, 2 passwords": each item translated, or null if none is.
  function lookupList(c, text, depth) {
    const items = text.split(', ');
    if (items.length < 2) return null;
    const done = items.map((item) => lookup(c, item, depth));
    return done.some((d) => d != null) ? items.map((item, i) => done[i] ?? item).join(', ') : null;
  }

  // The translation of `text` (keeping the spaces around it), or `text` itself.
  // Answers are remembered: the same labels come back with every redraw.
  function translate(c, text) {
    if (!c || typeof text !== 'string' || !/[A-Za-z]/.test(text) || text.length > c.longest) return text;
    if (c.memo.has(text)) return c.memo.get(text);
    if (c.memo.size > 5000) c.memo.clear();
    const out = translateNew(c, text);
    c.memo.set(text, out);
    return out;
  }
  function translateNew(c, text) {
    const found = lookup(c, text.trim());
    if (found == null) return text;
    const lead = /^\s*/.exec(text)[0];
    const trail = /\s*$/.exec(text)[0];
    return lead + found + trail;
  }

  const core = { compile, translate, norm };
  if (typeof module === 'object' && module.exports) { module.exports = core; return; }

  // ------------------------------------------------------------- pages
  const lang = document.documentElement.lang || 'en';
  const table = root.LUMIO_LOCALES?.[lang];
  if (!table) return;
  const c = compile(table);
  const t = (text) => translate(c, text);

  // User content, per page (lumio://<host>/): left as it is. Tab and page
  // titles, bookmarks, history, file and printer names, chats and what the
  // AI wrote or did (its steps name things on web pages).
  const SKIP = {
    shell: '.tab > .title, .bm-item > span, .msg, .approval pre, .a-detail, .s-label, #plan-list .t, #plan-now, .helper b, .helper small, .li-title, #effort-model, #context-chip span, .vb-cap, .sb-chat .sb-t, .sb-row[data-wf] .sb-t, .sb-row[data-open]:not(.sb-more) .sb-t, .sb-project .sb-t, #sb-results, #wf-menu .mt, .wf-head span, .fname b, .dn b, .ctx span',
    overlay: '.row .t, .row .u, .dl .name, .si-host, .acc-name, .acc-profile .t, .acc-email, .af-row:not(.af-gen) .af-user, .af-pw, .pws-host, .pk-account b, .pk-account small, .pk-acc b, .pk-acc small, .ss-name, .up-notes, .pf-title, .pf-host',
    picker: '.card:not(.add) .name, .card .email',
    newtab: '.site .name, .bm span, .chat .ct, .idea.wf span, #hello em',
    history: '.item .title, .closed-item .t',
    bookmarks: '.bm-row .t, .bm-row .u',
    downloads: '.dl .name, .dl .file',
    passwords: '.pw-item .site, .pw-item .user, .head h3, .kv .text',
    extensions: '.ext .meta .name, .ext .meta .desc',
    settings: '#me-name, #me-email, #dl-dir, .wf-row .title, .wf-row .desc, .sched-row .title, .sched-row .prompt, .tip-row .title, .tip-row .desc, .site .title, #sync-name, #phone-url, .recovery',
    error: '#url, #code',
  };
  // Elements whose own tooltip and names for screen readers are user content
  // (a tab's title and address, a bookmark's), though what's inside them is Lumio's.
  const USER_ATTRS = { shell: '.tab, .bm-item, #account-btn' };
  const host = location.protocol === 'lumio:' ? location.hostname : (location.pathname.split('/').pop() || '').replace(/\.html$/, '');
  const skipSel = ['script', 'style', 'textarea', 'code', 'pre', 'kbd', '[contenteditable]', '[translate="no"]', SKIP[host]].filter(Boolean).join(', ');
  const userAttrs = USER_ATTRS[host] || null;
  // ...and whose names for screen readers are (a tab's and a bookmark's are its title).
  const userLabels = { shell: '.tab, .bm-item' }[host] || null;
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'aria-description', 'aria-roledescription', 'label'];
  const skipped = (el) => !!el?.closest(skipSel);
  // A text box's own labels (placeholder, title) are Lumio's, not what's typed in it.
  const attrsSkipped = (el) => skipped(el.matches('textarea, [contenteditable]') ? el.parentElement : el);
  // What this script wrote, so its own changes aren't looked up again.
  const wrote = new WeakMap(); // text node -> text, element -> { attribute: value }

  function setText(node) {
    const v = node.data;
    if (!v.trim() || wrote.get(node) === v) return;
    const out = t(v);
    if (out !== v) { wrote.set(node, out); node.data = out; }
  }
  // Placeholders Lumio itself puts among user content.
  const OWN = new Set(['New Tab', 'New Incognito Tab', 'Untitled', 'Not signed in', '(no username)', 'Account', 'Chat', 'Entire screen', 'Guest', 'Incognito', 'Project']);
  function text(node) {
    if (!skipped(node.parentElement) || OWN.has(norm(node.data))) setText(node);
  }
  function attr(el, name) {
    const v = el.getAttribute(name);
    const user = name === 'title' ? userAttrs : /^aria-(label|description)$/.test(name) ? userLabels : null;
    if (user && el.matches(user) && !OWN.has(norm(v || ''))) return;
    const mine = wrote.get(el);
    if (!v || mine?.[name] === v) return;
    const out = t(v);
    if (out === v) return;
    wrote.set(el, { ...mine, [name]: out });
    el.setAttribute(name, out);
  }
  function attrs(el) {
    if (attrsSkipped(el)) return;
    for (const a of ATTRS) if (el.hasAttribute(a)) attr(el, a);
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && el.value) el.value = t(el.value);
  }
  // An element and everything in it (text in user content only when it's
  // one of Lumio's own placeholders, like "Untitled").
  function element(el) {
    attrs(el);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) text(n);
      else attrs(n);
    }
  }
  function handle(records) {
    for (const r of records) {
      if (r.type === 'characterData') text(r.target);
      else if (r.type === 'attributes') { if (!attrsSkipped(r.target)) attr(r.target, r.attributeName); } else {
        for (const n of r.addedNodes) {
          if (!n.isConnected) continue;
          if (n.nodeType === 3) text(n);
          else if (n.nodeType === 1) element(n);
        }
      }
    }
  }
  // Watches from the top of <head>, so text is translated as it's parsed,
  // before the first paint, and whenever the page changes it.
  const observer = new MutationObserver(handle);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  document.addEventListener('DOMContentLoaded', () => element(document.documentElement));

  // Messages the page shows with alert() and confirm().
  for (const name of ['alert', 'confirm', 'prompt']) {
    const native = window[name];
    if (typeof native === 'function') window[name] = (message, ...rest) => native.call(window, t(String(message ?? '')), ...rest);
  }

  root.lumioI18n = {
    lang,
    t,
    // Runs fn without translating what it changes (Settings search marks
    // the words that match: those pieces of text aren't UI strings).
    untracked(fn) {
      handle(observer.takeRecords());
      try { return fn(); } finally { observer.takeRecords(); }
    },
  };
})(typeof self !== 'undefined' ? self : this);
