// Scripts injected into web pages (in an isolated JS world, sharing the DOM;
// in an embedded frame, in the frame's own world: frames.js). Each is a plain
// function serialized with toString(), so it must be self-contained. Tested in
// headless Chrome (tests/ai-cards, page-overlays, ai-frames-page) and in the
// app (tests/e2e).

// opts.start: refs go on from there (an embedded frame's come after the page's).
function snapshot(opts) {
  const MAX = opts.max ?? 220;
  const maxText = opts.maxText ?? 6000;
  const start = opts.start || 0;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (MAX > 0) document.querySelectorAll('[data-lumio-ref]').forEach((el) => el.removeAttribute('data-lumio-ref'));

  const SEL = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary', 'label[for]',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]', '[role=menuitem]',
    '[role=menuitemcheckbox]', '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]',
    '[role=searchbox]', '[role=slider]', '[contenteditable=""]', '[contenteditable=true]', '[onclick]',
  ].join(',');

  const clean = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  // Card numbers and security codes never go to the AI: only that they're filled.
  const luhn = (n) => { let sum = 0; for (let i = 0; i < n.length; i++) { let d = Number(n[n.length - 1 - i]); if (i % 2) { d *= 2; if (d > 9) d -= 9; } sum += d; } return sum % 10 === 0; };
  const cardField = (el) => /(^|\s)cc-(number|csc)\b/.test(el.getAttribute('autocomplete') || '')
    || /(card.?num|cc.?num|cvv|cvc|csc|security.?code)/i.test([el.name, el.id, el.getAttribute('aria-label'), el.placeholder].join(' '))
    || (/^\d{12,19}$/.test(el.value.replace(/[\s-]/g, '')) && luhn(el.value.replace(/[\s-]/g, '')));
  const visibleRect = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
    return r;
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.labels && el.labels.length) {
      // A label wrapped around its control would otherwise also read out the
      // control's own text (every option of a <select>, for example).
      const label = el.labels[0].cloneNode(true);
      label.querySelectorAll('select, textarea, input, button, datalist').forEach((c) => c.remove());
      const t = clean(label.textContent);
      if (t) return t;
    }
    const tag = el.tagName;
    if (tag === 'INPUT' && /^(submit|button|reset)$/i.test(el.type)) return clean(el.value);
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      const t = clean(el.innerText);
      if (t) return t;
    }
    const img = el.querySelector && el.querySelector('img[alt], svg[aria-label]');
    if (img) { const t = clean(img.getAttribute('alt') || img.getAttribute('aria-label')); if (t) return t; }
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'LABEL') return 'label';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'password') return 'password';
      if (t === 'range') return 'slider';
      if (t === 'file') return 'file';
      return t === 'search' ? 'searchbox' : 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  };

  const seen = new Set();
  const inView = [];
  const offView = [];
  for (const el of MAX > 0 ? document.querySelectorAll(SEL) : []) {
    if (seen.has(el)) continue;
    seen.add(el);
    const r = visibleRect(el);
    if (!r) continue;
    // Labels only matter when their control is hidden (custom checkboxes etc.).
    if (el.tagName === 'LABEL' && (!el.control || visibleRect(el.control))) continue;
    // Skip a clickable nested in an already-listed link/button with the same text.
    const parent = el.parentElement && el.parentElement.closest('a[href],button,[role=button],[role=link]');
    if (parent && seen.has(parent) && !/INPUT|TEXTAREA|SELECT/.test(el.tagName)) continue;
    const visible = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    (visible ? inView : offView).push(el);
  }
  const chosen = inView.concat(offView).slice(0, MAX);
  const lines = [];
  const meta = {};
  chosen.forEach((el, i) => {
    const ref = start + i + 1;
    el.setAttribute('data-lumio-ref', String(ref));
    const role = roleOf(el);
    const name = nameOf(el);
    let line = `[${ref}] ${role}${name ? ` "${name}"` : ''}`;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const t = (el.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') { if (el.checked) line += ' checked'; }
      else if (t === 'password' || (el.value && cardField(el))) { if (el.value) line += ' (filled)'; }
      else if (el.value) line += ` value="${clean(el.value, 60)}"`;
      if (!name && el.placeholder) line += ` placeholder="${clean(el.placeholder, 40)}"`;
    } else if (el.tagName === 'SELECT') {
      const opt = el.options[el.selectedIndex];
      line += ` selected="${clean(opt ? opt.text : '', 40)}"`;
      const opts = [...el.options].slice(0, 12).map((o) => clean(o.text, 30)).filter(Boolean);
      if (opts.length) line += ` options=[${opts.join(' | ')}${el.options.length > 12 ? ' | …' : ''}]`;
    } else if (role === 'checkbox' || role === 'switch' || role === 'tab' || role === 'option') {
      const st = el.getAttribute('aria-checked') || el.getAttribute('aria-selected');
      if (st === 'true') line += ' checked';
    }
    if (el.tagName === 'A') {
      try {
        const u = new URL(el.href, location.href);
        // Not a web page (mailto:, ms-excel:, tel:…): its scheme shows, so
        // Lumio knows the link would open another app.
        const web = u.protocol === 'http:' || u.protocol === 'https:';
        const short = !web ? u.href : u.origin === location.origin ? u.pathname + u.search : u.host + u.pathname;
        if (short && short !== '/') line += ` → ${clean(short, 60)}`;
      } catch (_) { /* ignore */ }
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' disabled';
    if (i >= inView.length) line += ' (offscreen)';
    lines.push(line);
    meta[ref] = { name: name || role, role };
  });

  let text = '';
  if (maxText > 0) {
    const main = document.querySelector('main, article, [role=main]');
    const source = main && main.innerText.length > 400 ? main : document.body;
    text = (source ? source.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length > maxText) text = text.slice(0, maxText) + '\n…[page text truncated]';
  }
  return {
    url: location.href,
    title: document.title,
    viewport: `${vw}x${vh}`,
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    lines,
    meta,
    total: inView.length + offView.length,
    frames: document.querySelectorAll('iframe').length,
    text,
  };
}

// Scrolls the element into view (unless scroll: false) and returns its center
// (CSS px) plus whether something else covers that point, and whether it's a
// sensitive field. vw, vh: the viewport it's measured in.
function locate(opts) {
  const el = document.querySelector(`[data-lumio-ref="${opts.ref}"]`);
  if (!el) return { error: `No element [${opts.ref}] on the page. Call read_page again to get fresh refs.` };
  if (opts.scroll !== false) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + Math.min(r.width / 2, Math.max(4, r.width - 4)));
  const y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  let covered = null;
  if (top && top !== el && !el.contains(top) && !top.contains(el)) {
    covered = `${top.tagName.toLowerCase()} "${String(top.innerText || top.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40)}"`;
  }
  const target = el.tagName === 'LABEL' && el.control ? el.control : el;
  const hints = [target.type, target.name, target.id, target.getAttribute('autocomplete'), target.getAttribute('aria-label'), target.getAttribute('placeholder'),
    target.labels && target.labels[0] ? target.labels[0].innerText : ''].join(' ').toLowerCase();
  const sensitive = target.type === 'password'
    || /(^|\s)(cc-|one-time-code|current-password|new-password)/.test(target.getAttribute('autocomplete') || '')
    || /(password|passcode|passwd|card.?number|credit.?card|cc.?num|cvv|cvc|csc|security code|expir|iban|routing|account.?number|ssn|social security|passport|\bpin\b)/.test(hints);
  const editable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'searchbox' || el.getAttribute('role') === 'combobox';
  return {
    x, y, width: Math.round(r.width), height: Math.round(r.height), covered, sensitive, editable,
    tag: el.tagName.toLowerCase(),
    isSelect: el.tagName === 'SELECT',
    vw: window.innerWidth, vh: window.innerHeight,
  };
}

// Checks whatever element actually has keyboard focus right now (a click on
// a label or wrapper can move focus into a password field). Blurs it if
// sensitive (unless opts.keep: a key like Enter or Tab is pressed there).
// Focus in an embedded frame: which one (its mark from read_page and its
// window index), so frames.js checks the field in there too.
function focusCheck(opts) {
  const keep = !!(opts && opts.keep);
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { sensitive: false, none: true };
  if (el.tagName === 'IFRAME' || el.tagName === 'FRAME' || el.tagName === 'OBJECT') {
    const hint = [el.src, el.name, el.title, el.id].join(' ');
    if (/(stripe|card|payment|checkout|braintree|adyen|cvc|cvv|secure|pay)/i.test(hint)) { if (!keep) el.blur(); return { sensitive: true }; }
    let index = -1;
    for (let i = 0; i < window.length; i++) if (window[i] === el.contentWindow) { index = i; break; }
    return { sensitive: false, frame: true, key: el.getAttribute('data-lumio-frame') || '', index };
  }
  const hints = [el.type, el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder'),
    el.labels && el.labels[0] ? el.labels[0].innerText : ''].join(' ').toLowerCase();
  const sensitive = el.type === 'password'
    || /(^|\s)(cc-|one-time-code|current-password|new-password)/.test(el.getAttribute('autocomplete') || '')
    || /(password|passcode|passwd|card.?number|credit.?card|cc.?num|cvv|cvc|csc|security code|expir|iban|routing|account.?number|ssn|social security|passport|\bpin\b)/.test(hints);
  if (sensitive && !keep) el.blur();
  return { sensitive };
}

// While Lumio takes a screenshot for the AI, card numbers and security codes
// in fields show as dots (the person sees them again right after). Runs in
// Lumio's isolated world, so the page can't see what it keeps; in an
// embedded frame (a payment provider's card fields), in the frame's own world,
// under a key that changes each time Lumio starts (opts.key).
function maskCards(opts) {
  const luhn = (n) => { let sum = 0; for (let i = 0; i < n.length; i++) { let d = Number(n[n.length - 1 - i]); if (i % 2) { d *= 2; if (d > 9) d -= 9; } sum += d; } return sum % 10 === 0; };
  const cardField = (el) => /(^|\s)cc-(number|csc)\b/.test(el.getAttribute('autocomplete') || '')
    || /(card.?num|cc.?num|cvv|cvc|csc|security.?code)/i.test([el.name, el.id, el.getAttribute('aria-label'), el.placeholder].join(' '))
    || (/^\d{12,19}$/.test(el.value.replace(/[\s-]/g, '')) && luhn(el.value.replace(/[\s-]/g, '')));
  const masked = opts.key // field -> its own text-security style
    ? (window[opts.key] || Object.defineProperty(window, opts.key, { value: new Map(), configurable: true })[opts.key])
    : (window.__lumioMasked ||= new Map());
  if (opts.on) {
    for (const el of document.querySelectorAll('input')) {
      if (!el.value || el.type === 'password' || masked.has(el) || !cardField(el)) continue;
      masked.set(el, [el.style.getPropertyValue('-webkit-text-security'), el.style.getPropertyPriority('-webkit-text-security')]);
      el.style.setProperty('-webkit-text-security', 'disc', 'important');
    }
    // Answers once the dots are painted (a hidden tab paints no frames, so not forever).
    if (masked.size) return new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(() => done(masked.size))); setTimeout(() => done(masked.size), 120); });
  } else {
    for (const [el, [value, priority]] of masked) {
      if (value) el.style.setProperty('-webkit-text-security', value, priority); else el.style.removeProperty('-webkit-text-security');
    }
    masked.clear();
  }
  return masked.size;
}

// Selects the current contents of a field so the next insertText replaces it.
function selectContents(opts) {
  const el = document.querySelector(`[data-lumio-ref="${opts.ref}"]`);
  if (!el) return false;
  el.focus();
  if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    el.select();
  } else if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return true;
}

function selectOption(opts) {
  const el = document.querySelector(`[data-lumio-ref="${opts.ref}"]`);
  if (!el) return { error: `No element [${opts.ref}]. Call read_page again.` };
  if (el.tagName !== 'SELECT') return { error: `[${opts.ref}] is not a <select>. Click it instead.` };
  const want = String(opts.value).toLowerCase().trim();
  const opt = [...el.options].find((o) => o.value.toLowerCase() === want || o.text.toLowerCase().trim() === want)
    || [...el.options].find((o) => o.text.toLowerCase().includes(want));
  if (!opt) return { error: `No option matching "${opts.value}". Options: ${[...el.options].map((o) => o.text.trim()).slice(0, 30).join(' | ')}` };
  el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: opt.text.trim() };
}

// A short hash of what the page shows: its text (with what changes on its
// own, like clock times, taken out: opts.volatile), its fields' values and
// how far it and the boxes in the middle of it are scrolled. It tells the AI
// whether a step changed anything; it never leaves the computer.
function pageState(opts) {
  const fields = [];
  for (const el of document.querySelectorAll('input:not([type=password]):not([type=hidden]), textarea, select')) {
    fields.push(el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value);
    if (fields.length >= 500) break;
  }
  const scrolled = [Math.round(window.scrollY)];
  for (let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2); el; el = el.parentElement) {
    if (el.scrollTop) scrolled.push(Math.round(el.scrollTop));
  }
  let text = document.body ? document.body.innerText : '';
  if (opts.volatile) text = text.replace(new RegExp(opts.volatile, 'gi'), '#');
  const all = `${text}\u0001${fields.join('\u0001')}\u0001${scrolled.join(',')}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < all.length; i++) h = Math.imul(h ^ all.charCodeAt(i), 16777619);
  return `${all.length}:${(h >>> 0).toString(36)}`;
}

// frame: how much of the viewport the embedded frame in the middle of the
// page covers (0: none there), for the wheel to go in there when it's most of
// the page (Excel's workbook) or the page itself can't scroll that way (up,
// down).
function scrollInfo() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mid = document.elementFromPoint(vw / 2, vh / 2);
  let frame = 0;
  if (mid && /^(IFRAME|FRAME|OBJECT|EMBED)$/.test(mid.tagName)) {
    const r = mid.getBoundingClientRect();
    const seen = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    frame = vw > 0 && vh > 0 ? Math.round((100 * seen) / (vw * vh)) / 100 : 0;
  }
  const height = Math.round((document.scrollingElement || document.documentElement).scrollHeight);
  const y = Math.round(window.scrollY);
  return { y, height, vh, frame, up: y > 0, down: y + vh < height - 1 };
}

// The embedded frames in this document (iframes, also in open shadow roots),
// for frames.js. Each one's window index (window[i] is its window: the frame
// finds the same number for itself with opts.self, even from another site),
// name, address, mark from an earlier read_page, and its box: border box in
// the viewport (CSS px, after transforms), layout size, borders, padding and
// content size, from which frames.js works out where its content starts.
// Whether the person can see it: shown (not hidden, and at least half opaque
// with its ancestors' opacity and filter), vis (the part in view, clipped by
// the viewport, opts.clip and every ancestor that clips its overflow; null:
// none), hit (the share of points in vis where the frame is what's on top,
// not covered, also not by something that lets clicks through), seen (vis's
// area times hit). count: window.length; shadow: frames not in it (in shadow
// roots), which frames.js needs to know to trust window indexes.
// opts.self: just this document's own index in its parent and viewport size.
// opts.mark: [[i, index, id]] marks those frames (data-lumio-frame=id) after
// frames.js matched them. opts.box: { id, index, byIndex, count, scroll, at }:
// one frame's box, found by its window index (byIndex, when this document's
// frames are all in its window and count of them: the page can't move that),
// else its mark, else its index; with at (a point in this document), what
// covers that point if it isn't the frame. opts.point (list): at, the frame
// (i) at that point (-1: none of these; other: a frame element that isn't).
function frameInfo(opts) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let index = -1;
  try {
    if (window.parent !== window) for (let i = 0; i < window.parent.length; i++) if (window.parent[i] === window) { index = i; break; }
  } catch (_) { /* ignore */ }
  if (opts.self) return { index, vw, vh, url: location.href };
  const found = [];
  const collect = (root, depth) => {
    found.push(...root.querySelectorAll('iframe, frame, object'));
    if (depth >= 3) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.shadowRoot) collect(n.shadowRoot, depth + 1);
  };
  collect(document, 0);
  const winIndex = (el) => { for (let i = 0; i < window.length; i++) if (window[i] === el.contentWindow) return i; return -1; };
  const withWindow = found.filter((el) => el.contentWindow);
  const shadow = withWindow.filter((el) => winIndex(el) < 0).length;
  const px = (v) => parseFloat(v) || 0;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      left: r.left, top: r.top, width: r.width, height: r.height, ow: el.offsetWidth, oh: el.offsetHeight,
      bl: el.clientLeft, bt: el.clientTop, pl: px(cs.paddingLeft), pt: px(cs.paddingTop),
      cw: el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight), ch: el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
      vw, vh,
    };
  };
  // Up from an element, out of shadow roots too.
  const up = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  const opacity = (el) => {
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = up(n)) {
      const cs = getComputedStyle(n);
      o *= Number(cs.opacity);
      for (const m of String(cs.filter || '').matchAll(/opacity\(\s*([\d.]+)(%?)\s*\)/g)) o *= Math.min(1, Number(m[1]) / (m[2] ? 100 : 1));
    }
    return o;
  };
  const shownOf = (el) => {
    const cs = getComputedStyle(el);
    const styled = typeof el.checkVisibility === 'function'
      ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })
      : cs.display !== 'none' && cs.visibility !== 'hidden';
    return styled && opacity(el) >= 0.5;
  };
  // The part of the frame in view: in the viewport (and opts.clip, the part of
  // this document its own frame shows), inside every ancestor that clips
  // (overflow, contain: paint) up to one that's fixed. scroller: one of those
  // scrolls (the frame may be scrolled out of its view, not hidden).
  const visOf = (el) => {
    const r = el.getBoundingClientRect();
    let x1 = Math.max(r.left, 0);
    let y1 = Math.max(r.top, 0);
    let x2 = Math.min(r.right, vw);
    let y2 = Math.min(r.bottom, vh);
    const c = opts.clip;
    if (c) { x1 = Math.max(x1, c.x); y1 = Math.max(y1, c.y); x2 = Math.min(x2, c.x + c.w); y2 = Math.min(y2, c.y + c.h); }
    const inView = x2 > x1 && y2 > y1;
    let scroller = false;
    for (let n = el; n && n.nodeType === 1;) {
      if (getComputedStyle(n).position === 'fixed') break;
      n = up(n);
      if (!n || n === document.documentElement || n === document.body) break;
      const cs = getComputedStyle(n);
      const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || /paint|strict|content/.test(cs.contain || '');
      if (!clips) continue;
      if (/auto|scroll/.test(cs.overflowX + cs.overflowY)) scroller = true;
      const b = n.getBoundingClientRect();
      const left = b.left + n.clientLeft;
      const top = b.top + n.clientTop;
      x1 = Math.max(x1, left); y1 = Math.max(y1, top);
      x2 = Math.min(x2, left + n.clientWidth); y2 = Math.min(y2, top + n.clientHeight);
    }
    const vis = x2 - x1 >= 1 && y2 - y1 >= 1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
    return { vis, inView, scroller };
  };
  // What's on top at a point, in the frame element's tree (a shadow root's
  // own hit test, so not its host), and the same with every element taking
  // pointer events (an overlay that lets clicks through still hides what's
  // under it, when it paints there).
  const rootOf = (el) => { const r = el.getRootNode(); return r && typeof r.elementFromPoint === 'function' ? r : document; };
  let forcedSheet = null;
  try { forcedSheet = new CSSStyleSheet(); forcedSheet.replaceSync('*{pointer-events:auto!important}'); } catch (_) { forcedSheet = null; }
  const forced = (fn) => {
    if (!forcedSheet) return fn(false);
    const before = document.adoptedStyleSheets;
    try { document.adoptedStyleSheets = [...before, forcedSheet]; return fn(true); } catch (_) { return fn(false); } finally {
      try { document.adoptedStyleSheets = before; } catch (_) { /* ignore */ }
    }
  };
  const paints = (t) => {
    if (opacity(t) < 0.2) return false;
    if (/^(IMG|VIDEO|CANVAS|SVG|IFRAME|FRAME|OBJECT|EMBED|INPUT|TEXTAREA|SELECT|BUTTON|PICTURE)$/i.test(t.tagName)) return true;
    const cs = getComputedStyle(t);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    const m = /rgba?\(([^)]*)\)/.exec(cs.backgroundColor || '');
    const alpha = m ? (m[1].split(/[\s,/]+/).filter(Boolean)[3] ?? '1') : '0';
    if (Number(String(alpha).replace('%', '')) / (String(alpha).includes('%') ? 100 : 1) >= 0.2) return true;
    return [...t.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  };
  const describe = (t) => `${t.tagName.toLowerCase()} "${String(t.innerText || t.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40)}"`;
  // Points over the part in view (a 4 by 4 grid): which show the frame.
  const grid = (v) => {
    const pts = [];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) pts.push([v.x + ((i + 0.5) * v.w) / 4, v.y + ((j + 0.5) * v.h) / 4]);
    return pts;
  };
  const veiledAt = (el, x, y, on) => {
    if (!on) return null;
    const t = rootOf(el).elementFromPoint(x, y);
    return t && t !== el && paints(t) ? t : null;
  };

  if (opts.mark) {
    for (const el of found) if (el.hasAttribute('data-lumio-frame')) el.removeAttribute('data-lumio-frame');
    let marked = 0;
    for (const [i, idx, id] of opts.mark) {
      const el = found[i];
      if (el && (idx < 0 || winIndex(el) === idx)) { el.setAttribute('data-lumio-frame', String(id)); marked++; }
    }
    return { marked };
  }
  if (opts.box) {
    const want = String(opts.box.id);
    let el = null;
    if (opts.box.byIndex && opts.box.index >= 0 && window.length === opts.box.count && !shadow) el = withWindow.find((f) => winIndex(f) === opts.box.index) || null;
    if (!el) el = found.find((f) => f.getAttribute('data-lumio-frame') === want) || null;
    if (!el && opts.box.index >= 0) el = withWindow.find((f) => winIndex(f) === opts.box.index) || null;
    if (!el) return { error: 'gone' };
    if (el.getAttribute('data-lumio-frame') !== want) {
      for (const f of found) if (f !== el && f.getAttribute('data-lumio-frame') === want) f.removeAttribute('data-lumio-frame');
      el.setAttribute('data-lumio-frame', want);
    }
    if (opts.box.scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const raw = el.getAttribute(el.tagName === 'OBJECT' ? 'data' : 'src');
    let src = '';
    try { src = raw ? new URL(raw, location.href).href : ''; } catch (_) { /* ignore */ }
    const out = { ...box(el), index: winIndex(el), count: window.length, shadow, src, shown: shownOf(el) };
    if (opts.box.at) {
      const { x, y } = opts.box.at;
      const top = rootOf(el).elementFromPoint(x, y);
      if (top !== el) out.covered = top ? describe(top) : 'nothing (outside the page)';
      else {
        const veil = forced((on) => veiledAt(el, x, y, on));
        if (veil) out.covered = describe(veil);
      }
    }
    return out;
  }
  const frames = [];
  const entries = [];
  found.forEach((el, i) => {
    if (!el.contentWindow) return; // an <object> showing an image or plugin
    const raw = el.getAttribute(el.tagName === 'OBJECT' ? 'data' : 'src');
    let src = '';
    try { src = raw ? new URL(raw, location.href).href : ''; } catch (_) { /* ignore */ }
    const shown = shownOf(el);
    const { vis, inView, scroller } = shown ? visOf(el) : { vis: null, inView: false, scroller: false };
    const pts = vis ? grid(vis) : [];
    const plain = pts.map(([x, y]) => rootOf(el).elementFromPoint(x, y) === el);
    entries.push({ el, pts, plain });
    frames.push({ i, index: winIndex(el), name: el.getAttribute('name') || '', src, key: el.getAttribute('data-lumio-frame') || '', shown, inView, scroller, vis, hit: 0, seen: 0, ...box(el) });
  });
  // One pass with every element taking pointer events, for all the frames.
  const veiled = entries.some((e) => e.plain.some(Boolean))
    ? forced((on) => entries.map(({ el, pts, plain }) => pts.map(([x, y], k) => plain[k] && !!veiledAt(el, x, y, on))))
    : entries.map(({ pts }) => pts.map(() => false));
  frames.forEach((f, n) => {
    const { pts, plain } = entries[n];
    const shows = pts.filter((_, k) => plain[k] && !veiled[n][k]).length;
    f.hit = pts.length ? shows / pts.length : 0;
    f.seen = f.vis ? Math.round(f.vis.w * f.vis.h * f.hit) : 0;
  });
  let at;
  if (opts.point) {
    let t = document.elementFromPoint(opts.point.x, opts.point.y);
    while (t && t.shadowRoot && t.shadowRoot.elementFromPoint) {
      const inner = t.shadowRoot.elementFromPoint(opts.point.x, opts.point.y);
      if (!inner || inner === t) break;
      t = inner;
    }
    at = t ? found.indexOf(t) : -1;
    if (at < 0 && t && /^(IFRAME|FRAME|OBJECT|EMBED)$/.test(t.tagName)) at = 'other';
  }
  return { index, vw, vh, url: location.href, count: window.length, shadow, frames, ...(opts.point ? { at } : {}) };
}

// A fake cursor that glides to where Lumio is about to click.
function cursor(opts) {
  const g = window;
  if (opts.remove) {
    if (g.__lumioCursor) { g.__lumioCursor.host.remove(); g.__lumioCursor = null; }
    return true;
  }
  if (!g.__lumioCursor || !g.__lumioCursor.host.isConnected) {
    // Built element by element: Google Docs, Sheets, Gmail and YouTube enforce
    // Trusted Types, which refuse innerHTML strings (even from this world).
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    const css = `.c{position:fixed;left:0;top:0;transform:translate(-100px,-100px);transition:transform .24s cubic-bezier(.22,1,.36,1);filter:drop-shadow(0 2px 6px rgba(0,0,0,.45)) drop-shadow(0 0 10px rgba(134,183,255,.7));}
      .r{position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid rgba(134,183,255,.95);opacity:0;}
      .r.go{animation:ring .5s ease-out;}
      @keyframes ring{from{opacity:1;transform:var(--p) scale(.3)}to{opacity:0;transform:var(--p) scale(1.4)}}`;
    try { const sheet = new CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets = [sheet]; } catch (_) { const st = document.createElement('style'); st.textContent = css; root.append(st); }
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'c'); svg.setAttribute('width', '22'); svg.setAttribute('height', '22'); svg.setAttribute('viewBox', '0 0 24 24');
    const arrow = document.createElementNS(NS, 'path');
    arrow.setAttribute('d', 'M4 2.5l15.5 8.2-6.6 1.7-3.3 6.3z'); arrow.setAttribute('fill', '#fff'); arrow.setAttribute('stroke', '#111'); arrow.setAttribute('stroke-width', '1.3'); arrow.setAttribute('stroke-linejoin', 'round');
    svg.append(arrow);
    const ring = document.createElement('div');
    ring.className = 'r';
    root.append(svg, ring);
    (document.body || document.documentElement).appendChild(host);
    g.__lumioCursor = { host, c: svg, r: ring };
  }
  const { c, r } = g.__lumioCursor;
  c.style.transform = `translate(${opts.x - 4}px, ${opts.y - 3}px)`;
  if (opts.click) {
    r.style.setProperty('--p', `translate(${opts.x}px, ${opts.y}px)`);
    r.style.transform = `translate(${opts.x}px, ${opts.y}px)`;
    r.classList.remove('go');
    void r.offsetWidth;
    r.classList.add('go');
  }
  return true;
}

// A soft blue glow around the page while Lumio works on it. It ignores the
// mouse, and it's hidden (hidden: true) while Lumio takes its own screenshot
// of the tab, so the model doesn't see it.
function aura(opts) {
  const g = window;
  if (opts.remove) {
    if (g.__lumioAura) { g.__lumioAura.remove(); g.__lumioAura = null; }
    return true;
  }
  if (!g.__lumioAura || !g.__lumioAura.isConnected) {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    const css = `.g{position:fixed;inset:0;pointer-events:none;opacity:0;animation:in .5s ease-out forwards,breathe 2.8s ease-in-out .5s infinite;
        box-shadow:inset 0 0 0 1.5px rgba(140,196,255,.95),inset 0 0 14px 4px rgba(70,160,255,.7),inset 0 0 46px 12px rgba(40,136,255,.45),inset 0 0 120px 30px rgba(40,136,255,.18);}
      @keyframes in{to{opacity:1}}
      @keyframes breathe{0%,100%{opacity:1}50%{opacity:.7}}
      @media (prefers-reduced-motion:reduce){.g{animation:none;opacity:1}}`;
    try { const sheet = new CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets = [sheet]; } catch (_) { const st = document.createElement('style'); st.textContent = css; root.append(st); }
    const glow = document.createElement('div');
    glow.className = 'g';
    root.append(glow);
    (document.body || document.documentElement).appendChild(host);
    g.__lumioAura = host;
  }
  const hide = !!opts.hidden;
  if ((g.__lumioAura.style.visibility === 'hidden') === hide) return true;
  g.__lumioAura.style.visibility = hide ? 'hidden' : 'visible';
  // Resolve after the change is on screen, so a capture right after misses it.
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
}

// The open YouTube video's details and transcript, for "Summarize this
// video". Runs in Lumio's isolated world, so it re-reads the watch page's HTML
// (same origin, always the current video even after YouTube's in-page
// navigation) instead of the page's own JavaScript objects. Without a transcript
// it returns just the title and description.
async function youtube(opts) {
  const max = opts.max || 60000;
  const pull = (html, name) => {
    const at = html.indexOf(name);
    if (at < 0) return null;
    const start = html.indexOf('{', at);
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } }
    }
    return null;
  };
  const id = new URL(location.href).searchParams.get('v') || (location.pathname.match(/^\/(?:shorts|live)\/([\w-]{6,})/) || [])[1];
  if (!id) return { error: 'No video is open.' };
  const html = await (await fetch(`/watch?v=${id}`, { credentials: 'include' })).text();
  const player = pull(html, 'ytInitialPlayerResponse = ') || {};
  const d = player.videoDetails || {};
  const out = { id, title: d.title || document.title, channel: d.author || '', seconds: Number(d.lengthSeconds) || 0, description: String(d.shortDescription || '').slice(0, 4000), transcript: "" };

  // YouTube only serves captions to its own player (with a token the page
  // makes), so Lumio opens the page's "Show transcript" panel and reads it,
  // then closes the panel again if it wasn't open.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const segs = () => [...document.querySelectorAll('ytd-transcript-segment-renderer, transcript-segment-view-model')];
  const panel = () => document.querySelector('ytd-engagement-panel-section-list-renderer[target-id*="transcript"]');
  const wasOpen = panel()?.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
  if (!segs().length) {
    const button = () => document.querySelector('ytd-video-description-transcript-section-renderer button, button[aria-label="Show transcript"]');
    if (!button()) { document.querySelector('ytd-text-inline-expander #expand, #description-inline-expander #expand, tp-yt-paper-button#expand')?.click(); await wait(400); }
    button()?.click();
    for (let i = 0; i < 40 && !segs().length; i++) await wait(200);
    await wait(300);
  }
  const lines = segs().map((el) => {
    const time = (el.querySelector('.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp')?.textContent || '').trim();
    const t = (el.querySelector('.segment-text, .ytAttributedStringHost, [role="text"]')?.textContent || '').replace(/\s+/g, ' ').trim();
    return t ? (time ? `[${time}] ${t}` : t) : '';
  }).filter(Boolean);
  if (lines.length && !wasOpen) panel()?.querySelector('#visibility-button button, button[aria-label="Close transcript"]')?.click();

  let text = lines.join('\n');
  if (text.length > max) text = text.slice(0, max) + '\n[… transcript shortened]';
  out.transcript = text;
  return out;
}

// Helper AIs work in background tabs, which have no visible page to send
// real mouse and keyboard input to, so they act through the page instead.
// (Lumio's own tab keeps using real input.)
function domClick(opts) {
  const el = document.querySelector(`[data-lumio-ref="${opts.ref}"]`);
  if (!el) return { error: `No element [${opts.ref}] on the page. Call read_page again to get fresh refs.` };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  for (const type of ['pointerdown', 'mousedown']) el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { ...at, pointerType: 'mouse', isPrimary: true }));
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  for (const type of ['pointerup', 'mouseup']) el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { ...at, pointerType: 'mouse', isPrimary: true }));
  el.click();
  if (opts.double) el.dispatchEvent(new MouseEvent('dblclick', at));
  return { ok: true };
}

// Types into a field through the page (React and similar frameworks see it as
// typing). Password, payment and ID fields are refused before this runs.
function domType(opts) {
  const el = document.querySelector(`[data-lumio-ref="${opts.ref}"]`);
  if (!el) return { error: `No element [${opts.ref}] on the page. Call read_page again to get fresh refs.` };
  const target = el.tagName === 'LABEL' && el.control ? el.control : el;
  target.scrollIntoView({ block: 'center', behavior: 'instant' });
  if (typeof target.focus === 'function') target.focus({ preventScroll: true });
  const text = String(opts.text);
  if (target.isContentEditable) {
    if (opts.clear !== false) document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
  } else if ('value' in target) {
    const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const next = opts.clear === false ? `${target.value}${text}` : text;
    if (set) set.call(target, next); else target.value = next;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  } else return { error: `Element [${opts.ref}] isn't a text field.` };
  if (opts.submit) {
    const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const go = target.dispatchEvent(new KeyboardEvent('keydown', key));
    target.dispatchEvent(new KeyboardEvent('keyup', key));
    if (go && target.form) {
      if (typeof target.form.requestSubmit === 'function') target.form.requestSubmit(); else target.form.submit();
    }
  }
  return { ok: true };
}

// Scrolls the page (or the element with that ref) through the page.
function domScroll(opts) {
  const el = opts.ref ? document.querySelector(`[data-lumio-ref="${opts.ref}"]`) : null;
  const box = el || document.scrollingElement || document.documentElement;
  const dy = Math.round((opts.down ? 1 : -1) * window.innerHeight * opts.amount);
  box.scrollBy({ top: dy, behavior: 'instant' });
  return { scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement.scrollHeight };
}

// A search results page (Google, Bing, DuckDuckGo, Brave…): the results'
// titles, real URLs and snippets, plus the top of the page (answer boxes) and
// the side panel (knowledge panels). For web_search, read out of sight.
function serp(opts) {
  const max = opts.max || 8;
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const here = location.hostname.replace(/^www\./, '');
  const text = clean(document.body ? document.body.innerText : '');
  if (/\/sorry\//.test(location.pathname) || /unusual traffic|are you a robot|captcha/i.test(text.slice(0, 2000))) return { blocked: true, url: location.href };
  const ownSite = (h) => h === here || h.endsWith('.' + here) || (/(^|\.)google\.[a-z.]+$/.test(h) && /google\./.test(here));
  const realUrl = (a) => {
    let href = a.href;
    try {
      const u = new URL(href);
      if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname === '/ck/a') {
        const p = u.searchParams.get('u') || '';
        if (p.startsWith('a1')) href = atob(p.slice(2).replace(/-/g, '+').replace(/_/g, '/'));
      } else if (u.pathname === '/url' && (u.searchParams.get('q') || u.searchParams.get('url'))) href = u.searchParams.get('q') || u.searchParams.get('url');
      else if (u.searchParams.get('uddg')) href = u.searchParams.get('uddg');
    } catch (_) { /* keep it */ }
    return href;
  };
  const results = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('a h3, a h2, h3 a, h2 a')) {
    if (results.length >= max) break;
    const a = el.tagName === 'A' ? el : el.closest('a');
    const heading = el.tagName === 'A' ? el.closest('h2, h3') : el;
    if (!a || !heading) continue;
    const title = clean(heading.innerText);
    const url = realUrl(a);
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) { continue; }
    if (!/^https?:/.test(url) || title.length < 3 || ownSite(host) || seen.has(url)) continue;
    seen.add(url);
    // The result's box: grow until it would take in the next result.
    let box = heading;
    let best = heading;
    for (let i = 0; i < 7 && box.parentElement && box.parentElement !== document.body; i++) {
      box = box.parentElement;
      if (box.querySelectorAll('h2, h3').length > 1) break;
      best = box;
      if (clean(box.innerText).length > title.length + 120) break;
    }
    const snippet = clean(clean(best.innerText).replace(title, '')).slice(0, 320);
    results.push({ title: title.slice(0, 200), url, snippet });
  }
  const main = document.querySelector('#rso, #b_results, #links, [data-testid="mainline"], main, [role=main]') || document.body;
  const side = document.querySelector('#rhs, #b_context, aside');
  return {
    url: location.href,
    engine: here,
    results,
    top: clean(main ? main.innerText : '').slice(0, 1500),
    side: side ? clean(side.innerText).slice(0, 900) : '',
  };
}

module.exports = { domClick, domType, domScroll, youtube, snapshot, locate, focusCheck, selectContents, selectOption, pageState, scrollInfo, cursor, aura, serp, maskCards, frameInfo };
