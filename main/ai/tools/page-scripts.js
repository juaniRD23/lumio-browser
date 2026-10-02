// Scripts injected into web pages (in an isolated JS world, sharing the DOM).
// Each is a plain function serialized with toString(), so it must be
// self-contained. Tested against fixtures in tests/e2e.test.mjs.

function snapshot(opts) {
  const MAX = opts.max ?? 220;
  const maxText = opts.maxText ?? 6000;
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
    const ref = i + 1;
    el.setAttribute('data-lumio-ref', String(ref));
    const role = roleOf(el);
    const name = nameOf(el);
    let line = `[${ref}] ${role}${name ? ` "${name}"` : ''}`;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const t = (el.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') { if (el.checked) line += ' checked'; }
      else if (t === 'password') { if (el.value) line += ' (filled)'; }
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
        const short = u.origin === location.origin ? u.pathname + u.search : u.host + u.pathname;
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

// Scrolls the element into view and returns its center (CSS px) plus
// whether something else covers that point, and whether it's a sensitive field.
function locate(opts) {
  const el = document.querySelector(`[data-lumio-ref="${opts.ref}"]`);
  if (!el) return { error: `No element [${opts.ref}] on the page. Call read_page again to get fresh refs.` };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
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
  };
}

// Checks whatever element actually has keyboard focus right now (a click on
// a label or wrapper can move focus into a password field). Blurs it if sensitive.
function focusCheck() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { sensitive: false, none: true };
  if (el.tagName === 'IFRAME') {
    const hint = [el.src, el.name, el.title, el.id].join(' ');
    if (/(stripe|card|payment|checkout|braintree|adyen|cvc|cvv|secure|pay)/i.test(hint)) { el.blur(); return { sensitive: true }; }
    return { sensitive: false, frame: true };
  }
  const hints = [el.type, el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder'),
    el.labels && el.labels[0] ? el.labels[0].innerText : ''].join(' ').toLowerCase();
  const sensitive = el.type === 'password'
    || /(^|\s)(cc-|one-time-code|current-password|new-password)/.test(el.getAttribute('autocomplete') || '')
    || /(password|passcode|passwd|card.?number|credit.?card|cc.?num|cvv|cvc|csc|security code|expir|iban|routing|account.?number|ssn|social security|passport|\bpin\b)/.test(hints);
  if (sensitive) el.blur();
  return { sensitive };
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

function scrollInfo() {
  return { y: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight), vh: window.innerHeight };
}

// A fake cursor that glides to where Lumio is about to click.
function cursor(opts) {
  const g = window;
  if (opts.remove) {
    if (g.__lumioCursor) { g.__lumioCursor.host.remove(); g.__lumioCursor = null; }
    return true;
  }
  if (!g.__lumioCursor || !g.__lumioCursor.host.isConnected) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .c{position:fixed;left:0;top:0;transform:translate(-100px,-100px);transition:transform .42s cubic-bezier(.22,1,.36,1);filter:drop-shadow(0 2px 6px rgba(0,0,0,.45)) drop-shadow(0 0 10px rgba(134,183,255,.7));}
      .r{position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid rgba(134,183,255,.95);opacity:0;}
      .r.go{animation:ring .5s ease-out;}
      @keyframes ring{from{opacity:1;transform:var(--p) scale(.3)}to{opacity:0;transform:var(--p) scale(1.4)}}
    </style>
    <svg class="c" width="22" height="22" viewBox="0 0 24 24"><path d="M4 2.5l15.5 8.2-6.6 1.7-3.3 6.3z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>
    <div class="r"></div>`;
    (document.body || document.documentElement).appendChild(host);
    g.__lumioCursor = { host, c: root.querySelector('.c'), r: root.querySelector('.r') };
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
    root.innerHTML = `<style>
      .g{position:fixed;inset:0;pointer-events:none;opacity:0;animation:in .5s ease-out forwards,breathe 2.8s ease-in-out .5s infinite;
        box-shadow:inset 0 0 0 1.5px rgba(140,196,255,.95),inset 0 0 14px 4px rgba(70,160,255,.7),inset 0 0 46px 12px rgba(40,136,255,.45),inset 0 0 120px 30px rgba(40,136,255,.18);}
      @keyframes in{to{opacity:1}}
      @keyframes breathe{0%,100%{opacity:1}50%{opacity:.7}}
      @media (prefers-reduced-motion:reduce){.g{animation:none;opacity:1}}
    </style><div class="g"></div>`;
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

module.exports = { youtube, snapshot, locate, focusCheck, selectContents, selectOption, scrollInfo, cursor, aura };
