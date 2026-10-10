// Browser tools: read and operate web pages in Lumio's own tabs. Input is
// sent as real (trusted) mouse/keyboard events via webContents.sendInputEvent
// (in an embedded frame, through DevTools' Input domain: frames.js).
const crypto = require('crypto');
const scripts = require('./page-scripts');
const frames = require('./frames');
const { parseInput, displayUrl } = require('../../omnibox');
const { markSynthetic } = require('../../synthetic-input');
const { classify } = require('../../external-protocols');

const WORLD = 1001;
const TAB_ID = { type: 'integer', description: 'Tab id (defaults to the active tab)' };

// A dialog a page raises in its tab (alert(), "Leave site?", sign-in…) is the
// person's to answer: Lumio AI can't see or press it. It's told instead, and
// never waits on a page stopped by its own alert() or that hung.
const DIALOGS = {
  js: 'a message from the page',
  leave: '"Leave site?" (the page has unsaved changes)',
  auth: 'a sign-in prompt',
  external: 'a prompt to open another app',
  unresponsive: '"Page unresponsive"',
};
const pageTabs = new WeakMap(); // a tab's webContents -> the tab (tabFor, pageContext)
// A page stops on its own alert, or on one in another tab or pop-up that
// shares its process (an alert() there stops this page too).
const sharedStop = (tab) => { const wc = tab?.view?.webContents; return !!(wc && !wc.isDestroyed?.() && tab.owner?.hooks?.dialogInProcess?.(wc)); };
const stopped = (tab) => !!tab?.dialogs?.some((d) => d.spec.kind === 'js' || d.spec.kind === 'unresponsive') || sharedStop(tab);
function dialogNote(tab) {
  const kind = tab?.dialogs?.[0]?.spec.kind;
  if (kind) return `Tab ${tab.id} is showing ${DIALOGS[kind] || 'a dialog'}, which only the user can answer. Ask them to answer it, then go on.`;
  return sharedStop(tab) ? `Tab ${tab.id} is waiting on a dialog in another tab or pop-up, which only the user can answer. Ask them to answer it, then go on.` : '';
}

function inPage(wc, fn, arg = {}) {
  const code = `(${fn.toString()})(${JSON.stringify(arg)})`;
  const run = wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
  const tab = pageTabs.get(wc);
  if (!tab) return run;
  // The page may stop on a dialog meanwhile (it answers a click with
  // confirm()): it can't finish this until the person answers, so don't wait.
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => { if (stopped(tab)) { clearInterval(timer); reject(new Error(dialogNote(tab))); } }, 100);
    run.then(resolve, reject).finally(() => clearInterval(timer));
  });
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// The top page's runner for frames.js (Lumio's isolated world, with the dialog check).
const topRun = (wc) => (fn, arg) => inPage(wc, fn, arg);
// The embedded frames pageState looks at too: those the tab's last read_page
// read that show much of the page (Excel's workbook), and those Lumio acted in
// since (not an ad or a ticker that changes all the time).
const frameReads = new WeakMap(); // webContents -> { big: [frame id], acted: Set(frame id) }

// Resolves once the page stops loading (or after `max` ms).
function settle(wc, max = 8000) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (!wc.isDestroyed()) wc.removeListener('did-stop-loading', finish);
      setTimeout(resolve, 150);
    };
    const timer = setTimeout(finish, max);
    // Long enough for a click to start a navigation, short enough not to drag every action.
    setTimeout(() => {
      if (wc.isDestroyed() || !wc.isLoading()) finish();
      else wc.once('did-stop-loading', finish);
    }, 220);
  });
}

function hostOf(url) {
  try { return new URL(url).host || url; } catch { return url; }
}

// Lumio's own pages that change its settings, extensions, experiments or
// saved passwords, show its profile path, or hold the person's own choices
// (the welcome screens' crash reports), and the downloads, history and
// bookmarks pages (opening a flagged download, clearing history, reading it
// all): the person uses them, never Lumio.
const PRIVATE_PAGE = /^lumio:\/\/(settings|extensions|flags-lite|passwords|version|apps|welcome|downloads|history|bookmarks)(?![\w-])/i;

// leaving: the tool only takes the tab elsewhere (navigate, go_back).
function tabFor(ctx, id, { activate = false, leaving = false } = {}) {
  const tab = id ? ctx.tabs.get(id) : ctx.tabs.active;
  if (!tab) throw new Error(id ? `There is no tab ${id}. Use list_tabs.` : 'No tab is open.');
  ctx.tabs.ensureView(tab);
  if (activate && ctx.tabs.activeId !== tab.id) ctx.tabs.activate(tab.id);
  const wc = tab.view.webContents;
  const url = wc.getURL() || tab.url || '';
  if (PRIVATE_PAGE.test(url)) throw new Error("Lumio can't read or operate its own Settings, Extensions, Passwords, Version, Experiments, welcome, Downloads, History or Bookmarks pages. Ask the user to change these themselves.");
  // Going past a security warning is the person's call alone.
  if (!leaving && url.startsWith('lumio://error/cert')) throw new Error("This tab shows a security warning (the site's certificate isn't valid). Lumio can't continue past it: ask the user what to do.");
  const note = dialogNote(tab);
  if (note) throw new Error(note);
  pageTabs.set(wc, tab);
  // Continuing past a security warning (main/navigation-guard.js) is the
  // person's call: a page could have told the AI to click through it.
  if (!leaving && url.startsWith('lumio://interstitial')) throw new Error("This tab shows a Lumio security warning about the site. Lumio can't continue past it: go back, open another page, or ask the user.");
  ctx.onPage?.(wc); // the page glows while Lumio works on it
  return { tab, wc, url };
}

// A link the page tried to open in another app while Lumio worked on it
// (main.js openExternalLink stopped it): said once, the next time Lumio looks
// at the tab, so it doesn't think the app opened.
function blockedNote(tab) {
  const scheme = tab?.blockedApp;
  if (!scheme) return '';
  tab.blockedApp = null;
  const web = scheme === 'mailto' ? 'for email, the user’s webmail, like Gmail or Outlook on the web' : 'like the page’s "Open in browser" or "Join from your browser" option';
  return `Tab ${tab.id} tried to open a ${scheme}: link in another app. Lumio stays in the browser, so nothing opened: use the web version in a tab instead (${web}).`;
}

function pageLine(wc) {
  const tab = pageTabs.get(wc);
  const note = [dialogNote(tab), blockedNote(tab)].filter(Boolean).join('\n');
  return `Page is now: "${wc.getTitle()}" — ${wc.getURL()}${note ? `\n${note}` : ''}`;
}

// The embedded frame a ref from read_page is in (null: the top page).
function refFrame(ctx, tab, wc, ref) {
  const id = ctx.refs?.get(tab.id)?.[ref]?.frame;
  if (id == null) return null;
  const frame = frames.byId(wc, id);
  if (!frame) throw new Error(`Element [${ref}] was in an embedded frame that's gone. Call read_page again.`);
  frameReads.get(wc)?.acted.add(id);
  return frame;
}

// What a page script in an embedded frame answers is that frame's word (it
// runs in the frame's own world): its words in Lumio's replies stay on one
// short line, its numbers numbers.
const oneLine = (v, n) => String(v ?? '').replace(/[\r\n\u2028\u2029\u0085]+/g, ' ').trim().slice(0, n);
function tidy(res) {
  if (!res || typeof res !== 'object') return { error: 'The embedded frame didn’t answer. Call read_page again.' };
  const out = { ...res };
  if (out.error) out.error = `The embedded frame says: ${oneLine(out.error, 200)}`;
  for (const k of ['selected', 'covered']) if (out[k] != null) out[k] = oneLine(out[k], 80);
  for (const k of ['scrollY', 'scrollHeight', 'y', 'height', 'vh']) if (k in out && !Number.isFinite(out[k])) out[k] = 0;
  return out;
}

// Whether a ref from read_page was in an embedded frame (whatever became of it).
const frameRef = (ctx, tab, ref) => ctx.refs?.get(tab.id)?.[ref]?.frame != null;

// A page script in the top page, or in the frame a ref is in.
const runIn = (wc, frame, fn, arg) => (frame ? frames.inFrame(frame, fn, arg).then(tidy) : inPage(wc, fn, arg));

// Where the element with this ref is (scripts.locate): x, y in the top page's
// CSS px, an element in a frame measured out through the frames around it.
const locateRef = (wc, frame, ref) => (frame ? frames.place(frame, ref, frames.runner(topRun(wc), wc.mainFrame)) : inPage(wc, scripts.locate, { ref }));

// Payment providers' fields in their own frames (frames.js PAYMENT_HOSTS),
// and focus in a frame that can't be checked, stay the person's.
const paymentRefusal = (host) => ({ text: `Refused: that's in a payment frame (from ${host}). Ask the user to fill in payment details themselves.`, summary: 'Payment field, left for you', status: 'blocked' });
const uncheckedRefusal = () => ({ text: 'Refused: focus is in an embedded frame Lumio can’t check for password, payment or ID fields. Ask the user to type there themselves.', summary: 'Unchecked field, left for you', status: 'blocked' });

// Where focus is after a click on an element in `frame` (frames.focus);
// elsewhere: in another embedded frame than that one (or one in it), where
// the text would go instead (asked again once: the browser may not know yet).
async function focusAfterClick(wc, frame) {
  for (let tries = 0; ; tries++) {
    const focus = await frames.focus(wc, topRun(wc));
    if (!frame || focus.sensitive || focus.unknown || !focus.frame || frames.inside(focus.frame, frame)) return focus;
    if (tries) return { ...focus, elsewhere: true };
    await wait(120);
  }
}

function refName(ctx, tabId, ref) {
  const tab = tabId ? ctx.tabs.get(tabId) : ctx.tabs.active;
  const meta = tab && ctx.refs.get(tab.id);
  const name = meta?.[ref]?.name;
  // An element in an embedded frame says which site's it is (the frame named it).
  const site = meta?.[ref]?.site ? ` in a frame from ${meta[ref].site}` : '';
  return `${name ? `“${name.length > 40 ? name.slice(0, 40) + '…' : name}”` : `element [${ref}]`}${site}`;
}

function activeHost(ctx, tabId) {
  const tab = tabId ? ctx.tabs.get(tabId) : ctx.tabs.active;
  return tab ? hostOf(ctx.tabs.displayUrl(tab)) : '';
}

function safeUrl(ctx, input) {
  const parsed = parseInput(input, ctx.tabs.searchTemplate());
  if (!parsed) throw new Error('Empty URL.');
  if (/^(file|view-source|data|javascript):/i.test(parsed.url)) throw new Error('Lumio can only open web pages (http/https).');
  if (PRIVATE_PAGE.test(parsed.url)) throw new Error("Lumio can't open its own Settings, Extensions, Passwords, Version, Experiments, welcome, Downloads, History or Bookmarks pages.");
  if (/^lumio:\/\/(interstitial|error)/i.test(parsed.url)) throw new Error('Lumio can only open web pages (http/https).');
  // Lumio AI stays in the browser: no links that open another app (mailto:…).
  if (classify(parsed.url) !== 'web') throw new Error('Lumio works only in web pages and can’t open other apps. Use the web version in a tab instead (for email, the user’s webmail, like Gmail or Outlook on the web).');
  return parsed.url;
}

async function moveCursor(ctx, wc, x, y, click) {
  if (!ctx.showCursor) return;
  try {
    await inPage(wc, scripts.cursor, { x, y, click });
    if (!click) await wait(200); // the pointer's glide (.24s) is mostly done
  } catch { /* page may block injection; not critical */ }
}

async function mouseClick(wc, xDip, yDip, count = 1, button = 'left') {
  wc.sendInputEvent({ type: 'mouseMove', x: xDip, y: yDip });
  for (let i = 1; i <= count; i++) {
    wc.sendInputEvent({ type: 'mouseDown', x: xDip, y: yDip, button, clickCount: i });
    wc.sendInputEvent({ type: 'mouseUp', x: xDip, y: yDip, button, clickCount: i });
  }
}

// A click at a point on the page (the top page's CSS px). An element in an
// embedded frame gets it through DevTools, which reaches frames from other
// sites too; the top page's (or when DevTools can't attach), sendInputEvent's in DIPs.
async function clickAt(wc, x, y, count, inFrame) {
  if (inFrame && await frames.click(wc, x, y, count)) return;
  const z = wc.getZoomFactor();
  await mouseClick(wc, Math.round(x * z), Math.round(y * z), count);
}

const KEY_NAMES = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'Backspace',
  delete: 'Delete', del: 'Delete', space: 'Space', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown',
};
const MODS = { cmd: 'meta', command: 'meta', meta: 'meta', ctrl: 'control', control: 'control', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift' };

// "cmd+shift+z" -> the key, its keyCode name, the modifiers, and the
// webContents editing command it is (edit), if any.
function parseKeys(combo) {
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean);
  const modifiers = [];
  let key = '';
  for (const p of parts) {
    const m = MODS[p.toLowerCase()];
    if (m) modifiers.push(m); else key = p;
  }
  if (!key) throw new Error(`No key in "${combo}".`);
  const lower = key.toLowerCase();
  const edit = modifiers.includes('meta') && key.length === 1 ? { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: modifiers.includes('shift') ? 'redo' : 'undo' }[lower] || null : null;
  return { key, keyCode: KEY_NAMES[lower] || (key.length === 1 ? key.toUpperCase() : key), modifiers, edit };
}

function pressKey(wc, combo) {
  const { key, keyCode, modifiers, edit } = parseKeys(combo);
  // Editing shortcuts go through webContents (sendInputEvent bypasses the menu
  // on macOS); they reach the focused frame, wherever it is.
  if (edit) { wc[edit](); return; }
  markSynthetic(wc); // not the person: Esc here doesn't stop Lumio
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  const plain = !modifiers.some((m) => m !== 'shift');
  if (plain) {
    if (keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    else if (keyCode === 'Space') wc.sendInputEvent({ type: 'char', keyCode: ' ', modifiers });
    else if (key.length === 1) wc.sendInputEvent({ type: 'char', keyCode: modifiers.includes('shift') ? key.toUpperCase() : key, modifiers });
  }
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

// Keys and text for whatever has focus (frames.focus): in an embedded frame
// through DevTools, which sends them to that frame even when it runs in
// another process (sendInputEvent and insertText only reach the top page's).
async function sendKeys(wc, combo, focus) {
  if (focus?.inFrame) {
    const parsed = parseKeys(combo);
    if (!parsed.edit && await frames.keys(wc, parsed)) return;
  }
  pressKey(wc, combo);
}
async function typeText(wc, focus, text) {
  if (focus?.inFrame && await frames.insertText(wc, text)) return;
  await wc.insertText(text);
}

// Excel for the web's workbook (a frame from officeapps.live.com, /x/ for Excel).
const EXCEL_WEB = /^https:\/\/([^/?#]+\.officeapps\.live\.com\/x\/|excel\.cloud\.microsoft\/)/i;
// A page's own elements and text, and its embedded frames' together, at most.
const PAGE_ELEMENTS = 220;
const PAGE_TEXT = 7000;

async function thumbOf(image, width = 320) {
  return 'data:image/jpeg;base64,' + image.resize({ width, quality: 'good' }).toJPEG(70).toString('base64');
}

const tools = [
  {
    name: 'read_page',
    risk: 'read',
    icon: 'page',
    description: 'Read a tab: its URL, title, the interactive elements (with [ref] numbers for click/type) and the visible text, with those of the embedded frames shown on it. Call again after the page changes; refs are renumbered each time.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        include_text: { type: 'boolean', description: 'Include page text (default true). Set false for just the elements.' },
      },
    },
    label: (a, ctx) => `Reading ${activeHost(ctx, a.tab_id) || 'the page'}`,
    async run(a, ctx) {
      const { tab, wc } = tabFor(ctx, a.tab_id);
      if (wc.isLoading()) await settle(wc, 6000);
      const withText = a.include_text !== false;
      // Embedded frames shown on the page (frames.js) share the budget with
      // it, by how much of the page they cover; the rest of it goes to them.
      const run = frames.runner(topRun(wc), wc.mainFrame);
      const found = frames.childrenOf(wc.mainFrame).length ? await frames.survey(wc.mainFrame, run).catch(() => null) : null;
      const cover = found ? Math.min(0.8, frames.coverage(found)) : 0;
      const snap = await inPage(wc, scripts.snapshot, {
        max: Math.max(60, Math.round(PAGE_ELEMENTS * (1 - cover))),
        maxText: withText ? Math.max(1500, Math.round(PAGE_TEXT * (1 - cover))) : 0,
      });
      const meta = { ...snap.meta };
      ctx.refs.set(tab.id, meta); // the page's refs, whatever its frames do
      frameReads.set(wc, { big: [], acted: new Set() });
      const parts = [
        `Tab ${tab.id}: "${snap.title}"`,
        `URL: ${snap.url}`,
        `Viewport ${snap.viewport} · scrolled ${snap.scrollY} of ${snap.scrollHeight}px`,
        `Interactive elements (${snap.lines.length}${snap.total > snap.lines.length ? ` of ${snap.total}` : ''}):`,
        snap.lines.join('\n') || '(none)',
      ];
      if (snap.text) parts.push('', 'Page text:', snap.text);
      // A YouTube video's transcript, once per video per task (it's long).
      if (a.include_text !== false && YOUTUBE_VIDEO.test(snap.url) && !(ctx.videosRead ??= new Set()).has(snap.url)) {
        ctx.videosRead.add(snap.url);
        const v = await inPage(wc, scripts.youtube, { max: 30000 }).catch(() => null);
        if (v?.transcript) parts.push('', 'Video transcript (from YouTube):', v.transcript);
      }
      let count = snap.lines.length;
      if (found?.frames.length || found?.unplaced) {
        let got = null;
        try {
          got = await frames.read(found, run, { start: snap.lines.length, elements: PAGE_ELEMENTS - snap.lines.length, text: withText ? PAGE_TEXT - (snap.text || '').length : 0, includeText: withText });
        } catch { parts.push('', '(The embedded frames on this page couldn\'t be read this time; use screenshot_tab to see them.)'); }
        if (got) {
          // A frame's refs never stand for the page's.
          for (const [ref, m] of Object.entries(got.meta)) if (!Object.prototype.hasOwnProperty.call(meta, ref)) meta[ref] = m;
          frameReads.set(wc, { big: got.big, acted: new Set() });
          // Each frame's part says where it comes from (an embedded site's
          // words aren't the page's) and where it ends, by a mark it can't know.
          const end = `End of frame ${crypto.randomBytes(4).toString('hex')}`;
          for (const f of got.sections) {
            count += f.lines.length;
            parts.push('', `Embedded frame from ${f.origin}${f.title ? ` ("${f.title}")` : ''}: part of this page, but its content comes from that site. Its refs work like the page's. Its part ends at "${end}".`);
            parts.push(`Interactive elements in it (${f.lines.length}${f.total > f.lines.length ? ` of ${f.total}` : ''}):`, f.lines.join('\n') || '(none)');
            if (f.text) parts.push('Frame text:', f.text);
            parts.push(`${end}.`);
          }
          if (got.notes.length) parts.push('', ...got.notes);
        }
      }
      const blocked = blockedNote(tab);
      if (blocked) parts.push('', blocked);
      return { text: parts.join('\n'), summary: `${count} elements` };
    },
  },
  {
    name: 'click',
    risk: 'browser',
    icon: 'cursor',
    description: 'Click an element by its [ref] from the latest read_page.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'integer', description: 'Element ref from read_page' }, double: { type: 'boolean', description: 'Double-click' }, tab_id: TAB_ID },
      required: ['ref'],
    },
    label: (a, ctx) => `Click ${refName(ctx, a.tab_id, a.ref)}`,
    detail: (a, ctx) => `Click ${refName(ctx, a.tab_id, a.ref)} on ${activeHost(ctx, a.tab_id)}`,
    async run(a, ctx) {
      const { tab, wc } = tabFor(ctx, a.tab_id, { activate: true });
      const frame = refFrame(ctx, tab, wc, a.ref);
      const pay = frame && frames.payment(frame);
      if (pay) return paymentRefusal(pay);
      if (ctx.background) { // a helper's hidden tab: click through the page
        const res = await runIn(wc, frame, scripts.domClick, { ref: a.ref, double: !!a.double });
        if (res.error) throw new Error(res.error);
        await settle(wc);
        return { text: `Clicked [${a.ref}]. ${pageLine(wc)}` };
      }
      const info = await locateRef(wc, frame, a.ref);
      if (info.error) throw new Error(info.error);
      await moveCursor(ctx, wc, info.x, info.y, false);
      await clickAt(wc, info.x, info.y, a.double ? 2 : 1, !!frame);
      await moveCursor(ctx, wc, info.x, info.y, true);
      await settle(wc);
      const note = info.covered ? `\nNote: the click point was covered by ${info.covered}; the click may have hit that instead.` : '';
      return { text: `Clicked [${a.ref}]. ${pageLine(wc)}${note}` };
    },
  },
  {
    name: 'type',
    risk: 'browser',
    icon: 'keyboard',
    description: 'Type text into a field by its [ref]. Replaces what is there unless clear=false. Set submit=true to press Enter afterwards. Refuses password, payment and ID fields.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'integer' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter after typing' },
        clear: { type: 'boolean', description: 'Replace existing text (default true)' },
        tab_id: TAB_ID,
      },
      required: ['ref', 'text'],
    },
    label: (a, ctx) => `Type “${String(a.text).slice(0, 30)}${String(a.text).length > 30 ? '…' : ''}” into ${refName(ctx, a.tab_id, a.ref)}`,
    detail: (a, ctx) => `Type into ${refName(ctx, a.tab_id, a.ref)} on ${activeHost(ctx, a.tab_id)}${a.submit ? ' and press Enter' : ''}:\n${a.text}`,
    async run(a, ctx) {
      const { tab, wc } = tabFor(ctx, a.tab_id, { activate: true });
      const frame = refFrame(ctx, tab, wc, a.ref);
      const pay = frame && frames.payment(frame);
      if (pay) return paymentRefusal(pay);
      // A helper's hidden tab only needs to know what the field is, not where it is on the page.
      const info = await (ctx.background && frame ? runIn(wc, frame, scripts.locate, { ref: a.ref }) : locateRef(wc, frame, a.ref));
      if (info.error) throw new Error(info.error);
      if (info.sensitive) {
        return { text: 'Refused: this looks like a password, payment, or ID field. Ask the user to fill it in themselves.', summary: 'Sensitive field, left for you', status: 'blocked' };
      }
      if (info.isSelect) throw new Error('That element is a dropdown; use select_option.');
      if (ctx.background) { // a helper's hidden tab: type through the page
        const res = await runIn(wc, frame, scripts.domType, { ref: a.ref, text: String(a.text), clear: a.clear !== false, submit: !!a.submit });
        if (res.error) throw new Error(res.error);
        if (a.submit) await settle(wc); else await wait(150);
        return { text: `Typed into [${a.ref}]${a.submit ? ' and pressed Enter' : ''}. ${pageLine(wc)}` };
      }
      await moveCursor(ctx, wc, info.x, info.y, false);
      await clickAt(wc, info.x, info.y, 1, !!frame);
      await moveCursor(ctx, wc, info.x, info.y, true);
      await wait(60);
      const focus = await focusAfterClick(wc, frame);
      if (focus.sensitive) {
        return { text: 'Refused: focus landed on a password, payment, or ID field. Ask the user to fill it in themselves.', summary: 'Sensitive field, left for you', status: 'blocked' };
      }
      if (focus.unknown) return uncheckedRefusal();
      if (focus.elsewhere) throw new Error(`The click on [${a.ref}] put focus in another embedded frame, not that field's. Call read_page again.`);
      if (a.clear !== false) await runIn(wc, frame, scripts.selectContents, { ref: a.ref });
      await typeText(wc, focus, String(a.text));
      if (a.submit) { await wait(120); await sendKeys(wc, 'Enter', focus); await settle(wc); } else await wait(150);
      return { text: `Typed into [${a.ref}]${a.submit ? ' and pressed Enter' : ''}. ${pageLine(wc)}` };
    },
  },
  {
    name: 'paste_text',
    risk: 'browser',
    icon: 'keyboard',
    description: 'Paste text where the cursor is, or into an element by [ref] (clicked first). Fills a whole spreadsheet range at once with tab-separated rows.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, ref: { type: 'integer', description: 'Click this element first (optional)' }, tab_id: TAB_ID },
      required: ['text'],
    },
    label: (a) => {
      const t = String(a.text || '');
      const rows = t.split('\n').filter(Boolean).length;
      return t.includes('\t') && rows > 1 ? `Paste ${rows} rows` : `Paste “${t.slice(0, 30)}${t.length > 30 ? '…' : ''}”`;
    },
    detail: (a, ctx) => `Paste into ${a.ref ? refName(ctx, a.tab_id, a.ref) : 'the selected place'} on ${activeHost(ctx, a.tab_id)}:\n${a.text}`,
    async run(a, ctx) {
      const { tab, wc } = tabFor(ctx, a.tab_id, { activate: true });
      const text = String(a.text ?? '');
      if (!text) throw new Error('Nothing to paste.');
      let clicked = null; // the frame clicked into (or 'page')
      if (a.ref) {
        const frame = refFrame(ctx, tab, wc, a.ref);
        const pay = frame && frames.payment(frame);
        if (pay) return paymentRefusal(pay);
        const info = await locateRef(wc, frame, a.ref);
        if (info.error) throw new Error(info.error);
        if (info.sensitive) return { text: 'Refused: this looks like a password, payment, or ID field. Ask the user to fill it in themselves.', summary: 'Sensitive field, left for you', status: 'blocked' };
        await moveCursor(ctx, wc, info.x, info.y, false);
        await clickAt(wc, info.x, info.y, 1, !!frame);
        await moveCursor(ctx, wc, info.x, info.y, true);
        await wait(80);
        clicked = frame || 'page';
      }
      const focus = await focusAfterClick(wc, clicked === 'page' ? null : clicked).catch(() => ({}));
      if (focus.sensitive) return { text: 'Refused: focus is on a password, payment, or ID field. Ask the user to fill it in themselves.', summary: 'Sensitive field, left for you', status: 'blocked' };
      if (focus.unknown) return uncheckedRefusal();
      if (focus.elsewhere) throw new Error(`The click on [${a.ref}] put focus in another embedded frame, not that field's. Call read_page again.`);
      // Through the real clipboard (sites like Google Sheets only split rows and
      // columns on a real paste); whatever the user had copied is put back.
      const { clipboard } = require('electron');
      // Google Sheets: a cell being edited takes the whole paste as its text,
      // so leave editing first (Esc keeps the cell selected), and paste the rows
      // as a table too, which Sheets always spreads over the cells. Excel for
      // the web too (in its workbook's frame): Esc first, then the rows.
      const sheet = /^https:\/\/docs\.google\.com\/spreadsheets\//.test(wc.getURL());
      const excel = EXCEL_WEB.test(focus.url || wc.getURL());
      const grid = /[\t\n]/.test(text.trim());
      if ((sheet || excel) && grid) { await sendKeys(wc, 'Escape', focus); await wait(120); }
      const esc = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const table = sheet && grid ? `<table>${text.replace(/\r/g, '').replace(/\n+$/, '').split('\n').map((row) => `<tr>${row.split('\t').map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>` : null;
      const formats = clipboard.availableFormats();
      const saved = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: formats.some((f) => f.startsWith('image/')) ? clipboard.readImage() : null };
      try {
        if (table) clipboard.write({ text, html: `<meta charset="utf-8">${table}` }); else clipboard.writeText(text);
        wc.focus();
        wc.paste();
        await wait(450);
      } finally {
        if (saved.image && !saved.image.isEmpty()) clipboard.write({ image: saved.image, ...(saved.text ? { text: saved.text } : {}) });
        else if (saved.text || saved.html || saved.rtf) clipboard.write({ text: saved.text, html: saved.html, rtf: saved.rtf });
        else clipboard.clear();
      }
      const rows = text.split('\n').filter(Boolean).length;
      return { text: `Pasted ${rows > 1 ? `${rows} rows` : `${text.length} characters`}. Check the result with read_page or screenshot_tab if it matters. ${pageLine(wc)}` };
    },
  },
  {
    name: 'select_option',
    risk: 'browser',
    icon: 'cursor',
    description: 'Choose an option in a <select> dropdown by its [ref], matching option text or value.',
    parameters: { type: 'object', properties: { ref: { type: 'integer' }, value: { type: 'string' }, tab_id: TAB_ID }, required: ['ref', 'value'] },
    label: (a, ctx) => `Choose “${a.value}” in ${refName(ctx, a.tab_id, a.ref)}`,
    detail: (a, ctx) => `Choose “${a.value}” in ${refName(ctx, a.tab_id, a.ref)} on ${activeHost(ctx, a.tab_id)}`,
    async run(a, ctx) {
      const { tab, wc } = tabFor(ctx, a.tab_id, { activate: true });
      const frame = refFrame(ctx, tab, wc, a.ref);
      const pay = frame && frames.payment(frame);
      if (pay) return paymentRefusal(pay);
      const res = await runIn(wc, frame, scripts.selectOption, { ref: a.ref, value: a.value });
      if (res.error) throw new Error(res.error);
      await wait(200);
      return `Selected "${res.selected}".`;
    },
  },
  {
    name: 'press_key',
    risk: 'browser',
    icon: 'keyboard',
    description: 'Press a key or shortcut in the active tab, e.g. "Enter", "Escape", "Tab", "Down", "cmd+a".',
    parameters: { type: 'object', properties: { keys: { type: 'string' }, tab_id: TAB_ID }, required: ['keys'] },
    label: (a) => `Press ${a.keys}`,
    detail: (a, ctx) => `Press ${a.keys} on ${activeHost(ctx, a.tab_id)}`,
    async run(a, ctx) {
      const { wc } = tabFor(ctx, a.tab_id, { activate: true });
      const parsed = parseKeys(a.keys);
      const printable = String(a.keys).length === 1 || /^(shift\+).$/i.test(a.keys) || /\+v$/i.test(a.keys);
      const plain = parsed.modifiers.every((m) => m === 'shift');
      // Keys that only leave a field (Tab, Esc) or submit it (Enter), and
      // those that change or copy what's in it (typing, Backspace, Delete,
      // cut, copy, paste, select all, undo).
      const leaves = plain && (parsed.keyCode === 'Tab' || parsed.keyCode === 'Escape');
      const submits = plain && parsed.keyCode === 'Enter';
      const edits = printable || !!parsed.edit || parsed.keyCode === 'Backspace' || parsed.keyCode === 'Delete';
      // Where focus is decides where the keys go; Enter, Tab or Esc leave the field as it is.
      let focus = {};
      try { focus = await frames.focus(wc, topRun(wc), { keep: leaves || submits }); } catch (err) { if (edits) throw err; }
      // A payment provider's field: nothing but leaving it. A password, card or
      // ID field: nothing but leaving or submitting it (the user filled it in).
      if (focus.payment && !leaves) return paymentRefusal(focus.payment);
      if (focus.sensitive && !leaves && !submits) {
        return { text: 'Refused: the focused field is a password, payment, or ID field. Ask the user to fill it in themselves.', summary: 'Sensitive field, left for you', status: 'blocked' };
      }
      if (focus.unknown && edits) return uncheckedRefusal();
      await sendKeys(wc, a.keys, focus);
      await settle(wc, 4000);
      return `Pressed ${a.keys}. ${pageLine(wc)}`;
    },
  },
  {
    name: 'scroll',
    risk: 'read',
    icon: 'scroll',
    description: 'Scroll the page (or the element under [ref]) up or down by a number of screens (default 0.8).',
    parameters: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' }, ref: { type: 'integer' }, tab_id: TAB_ID },
      required: ['direction'],
    },
    label: (a) => `Scroll ${a.direction}`,
    async run(a, ctx) {
      const { tab, wc } = tabFor(ctx, a.tab_id, { activate: true });
      let frame = null;
      try { frame = a.ref ? refFrame(ctx, tab, wc, a.ref) : null; } catch { /* its frame is gone: scroll the page */ }
      if (frame && frames.payment(frame)) frame = null; // nothing runs there: the page scrolls
      if (ctx.background) { // a helper's hidden tab: scroll through the page
        const res = await runIn(wc, frame, scripts.domScroll, { ref: frame || !a.ref || !frameRef(ctx, tab, a.ref) ? a.ref : 0, down: a.direction !== 'up', amount: Math.min(5, Math.max(0.1, a.amount || 0.8)) });
        await wait(300);
        return `Scrolled ${a.direction}${frame ? ' in the embedded frame' : ''}. Now at ${res.scrollY} of ${res.scrollHeight}px.`;
      }
      const bounds = tab.view.getBounds();
      const z = wc.getZoomFactor();
      let x = Math.round(bounds.width / 2);
      let y = Math.round(bounds.height / 2);
      let at = null; // the point, in the page's CSS px, when it's in an embedded frame
      let located = false;
      if (a.ref && (frame || !frameRef(ctx, tab, a.ref))) {
        const info = await locateRef(wc, frame, a.ref).catch(() => ({ error: true }));
        if (!info.error) { x = Math.round(info.x * z); y = Math.round(info.y * z); located = true; if (frame) at = info; }
      }
      // The middle of the page is an embedded frame that's most of it (Excel's
      // workbook), or the page itself can't scroll that way: the wheel goes in there.
      const middle = located ? null : await inPage(wc, scripts.scrollInfo).catch(() => null);
      const intoMiddle = middle?.frame > 0 && (middle.frame >= 0.6 || !(a.direction === 'up' ? middle.up : middle.down));
      if (intoMiddle) at = { x: x / z, y: y / z };
      // Chromium caps each wheel event, so big scrolls go out as several.
      let px = Math.round(bounds.height * Math.min(5, Math.max(0.1, a.amount || 0.8)));
      let devtools = !!at;
      if (!devtools) wc.sendInputEvent({ type: 'mouseMove', x, y });
      while (px > 0) {
        const step = Math.min(px, Math.round(bounds.height * 0.8));
        if (devtools) devtools = await frames.wheel(wc, at.x, at.y, (a.direction === 'up' ? -step : step) / z);
        if (!devtools) wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: a.direction === 'up' ? step : -step, canScroll: true });
        px -= step;
        await wait(120);
      }
      await wait(350);
      const inner = located && frame ? await runIn(wc, frame, scripts.scrollInfo).catch(() => null) : null;
      if (inner && !inner.error) return `Scrolled ${a.direction} in the embedded frame. Now at ${inner.y} of ${inner.height}px (viewport ${inner.vh}px).`;
      const s = await inPage(wc, scripts.scrollInfo);
      return `Scrolled ${a.direction}${intoMiddle ? ' (in the embedded frame in the middle of the page)' : ''}. Now at ${s.y} of ${s.height}px (viewport ${s.vh}px).`;
    },
  },
  {
    name: 'navigate',
    risk: 'browser',
    icon: 'globe',
    description: 'Open a URL (or search terms) in the current tab.',
    parameters: { type: 'object', properties: { url: { type: 'string' }, tab_id: TAB_ID }, required: ['url'] },
    label: (a) => `Open ${displayUrl(a.url).slice(0, 50)}`,
    detail: (a) => `Open ${a.url}`,
    async run(a, ctx) {
      const url = safeUrl(ctx, a.url);
      const { tab, wc } = tabFor(ctx, a.tab_id, { activate: true, leaving: true });
      ctx.tabs.navigate(url, tab.id);
      await settle(wc, 15000);
      return pageLine(wc);
    },
  },
  {
    name: 'go_back',
    risk: 'browser',
    icon: 'globe',
    description: 'Go back (or forward) in the tab history.',
    parameters: { type: 'object', properties: { forward: { type: 'boolean' }, tab_id: TAB_ID } },
    label: (a) => (a.forward ? 'Go forward' : 'Go back'),
    async run(a, ctx) {
      const { tab, wc } = tabFor(ctx, a.tab_id, { activate: true, leaving: true });
      const h = wc.navigationHistory;
      if (a.forward ? !h.canGoForward() : !h.canGoBack()) return `Can't go ${a.forward ? 'forward' : 'back'}. ${pageLine(wc)}`;
      // Through the tabs, so a page with unsaved changes asks the person first.
      if (a.forward) ctx.tabs.forward(tab.id); else ctx.tabs.back(tab.id);
      await settle(wc);
      return pageLine(wc);
    },
  },
  {
    name: 'screenshot_tab',
    risk: 'read',
    icon: 'eye',
    description: 'Take a screenshot of a tab to see its layout, images, canvases or embedded frames. Pixel coordinates can be used with click_at.',
    parameters: { type: 'object', properties: { tab_id: TAB_ID } },
    label: () => 'Look at the page',
    async run(a, ctx) {
      const { tab, wc } = tabFor(ctx, a.tab_id);
      const bounds = tab.view.getBounds();
      await ctx.onCapture?.(wc, true); // keep Lumio's own glow out of the picture
      await inPage(wc, scripts.maskCards, { on: true }).catch(() => {}); // and card numbers
      await frames.mask(wc, true); // in frames too (a payment provider's card fields)
      let img;
      try { img = await wc.capturePage(); } finally {
        await inPage(wc, scripts.maskCards, { on: false }).catch(() => {});
        await frames.mask(wc, false);
        await ctx.onCapture?.(wc, false);
      }
      const width = Math.min(1280, bounds.width);
      const shot = img.resize({ width, quality: 'good' });
      const size = shot.getSize();
      ctx.lastTabShot = { tabId: tab.id, scale: size.width / bounds.width };
      return {
        text: `Screenshot of tab ${tab.id} (${size.width}x${size.height}px). ${pageLine(wc)}`,
        image: 'data:image/jpeg;base64,' + shot.toJPEG(72).toString('base64'),
        thumb: await thumbOf(img),
      };
    },
  },
  {
    name: 'click_at',
    risk: 'browser',
    icon: 'cursor',
    description: 'Click at pixel coordinates from the latest screenshot_tab of that tab (for things without a ref, like canvases).',
    parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean' } }, required: ['x', 'y'] },
    label: (a) => `Click at (${Math.round(a.x)}, ${Math.round(a.y)})`,
    detail: (a, ctx) => `Click at (${Math.round(a.x)}, ${Math.round(a.y)}) on ${activeHost(ctx)}`,
    async run(a, ctx) {
      const shot = ctx.lastTabShot;
      if (!shot) throw new Error('Take a screenshot_tab first.');
      const { wc } = tabFor(ctx, shot.tabId, { activate: true });
      const x = Math.round(a.x / shot.scale);
      const y = Math.round(a.y / shot.scale);
      const z = wc.getZoomFactor();
      // An embedded frame there gets the click through DevTools (the view's
      // own input doesn't reach a frame from another site); never a payment
      // provider's, or one that may be.
      const where = await frames.frameAt(wc, topRun(wc), { x: x / z, y: y / z }).catch(() => ({ frame: null }));
      if (where.payment) return paymentRefusal(where.payment);
      await moveCursor(ctx, wc, x / z, y / z, false);
      if (!(where.frame && await frames.click(wc, x / z, y / z, a.double ? 2 : 1))) await mouseClick(wc, x, y, a.double ? 2 : 1);
      await moveCursor(ctx, wc, x / z, y / z, true);
      await settle(wc);
      return `Clicked. ${pageLine(wc)}`;
    },
  },
  {
    name: 'list_tabs',
    risk: 'read',
    icon: 'tabs',
    description: 'List open tabs with their ids.',
    parameters: { type: 'object', properties: {} },
    label: () => 'Check open tabs',
    run(_a, ctx) {
      return ctx.tabs.tabs.map((t) => `[${t.id}]${t.id === ctx.tabs.activeId ? ' (active)' : ''} ${t.title} — ${ctx.tabs.displayUrl(t) || 'new tab'}`).join('\n');
    },
  },
  {
    name: 'open_tab',
    risk: 'browser',
    icon: 'tabs',
    description: 'Open a URL in a new tab (it becomes the active tab unless background=true).',
    parameters: { type: 'object', properties: { url: { type: 'string' }, background: { type: 'boolean' } }, required: ['url'] },
    label: (a) => `Open ${displayUrl(a.url).slice(0, 50)} in a new tab`,
    detail: (a) => `Open a new tab: ${a.url}`,
    async run(a, ctx) {
      const url = safeUrl(ctx, a.url);
      const tab = ctx.tabs.create(url, { active: !a.background });
      ctx.onPage?.(tab.view.webContents);
      await settle(tab.view.webContents, 15000);
      return `Opened tab ${tab.id}. ${pageLine(tab.view.webContents)}`;
    },
  },
  {
    name: 'switch_tab',
    risk: 'read',
    icon: 'tabs',
    description: 'Switch to another tab by id.',
    parameters: { type: 'object', properties: { tab_id: { type: 'integer' } }, required: ['tab_id'] },
    label: (a, ctx) => `Switch to “${(ctx.tabs.get(a.tab_id)?.title || 'tab ' + a.tab_id).slice(0, 40)}”`,
    run(a, ctx) {
      const { wc } = tabFor(ctx, a.tab_id, { activate: true });
      return `Switched to tab ${a.tab_id}. ${pageLine(wc)}`;
    },
  },
  {
    name: 'close_tab',
    risk: 'browser',
    icon: 'tabs',
    description: 'Close a tab by id.',
    parameters: { type: 'object', properties: { tab_id: { type: 'integer' } }, required: ['tab_id'] },
    label: (a, ctx) => `Close “${(ctx.tabs.get(a.tab_id)?.title || 'tab ' + a.tab_id).slice(0, 40)}”`,
    async run(a, ctx) {
      if (!ctx.tabs.get(a.tab_id)) throw new Error(`There is no tab ${a.tab_id}.`);
      ctx.tabs.close(a.tab_id);
      // A page you've used runs its beforeunload first and may ask "Leave site?".
      // Wait for its page to close, or for the question, whichever comes first.
      const asking = () => !!ctx.tabs.get(a.tab_id)?.dialogs?.some((d) => d.spec.kind === 'leave');
      for (let t = 0; t < 1500 && ctx.tabs.get(a.tab_id) && !asking(); t += 100) await wait(100);
      if (!ctx.tabs.get(a.tab_id)) return `Closed tab ${a.tab_id}.`;
      return asking() ? `Tab ${a.tab_id} is asking the user to confirm leaving the page; it closes if they agree.` : `Tab ${a.tab_id} is still closing.`;
    },
  },
  {
    name: 'wait',
    risk: 'read',
    icon: 'clock',
    description: 'Wait a few seconds for something to load or finish (max 10).',
    parameters: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] },
    label: (a) => `Wait ${Math.min(10, Math.max(0.5, a.seconds || 1))}s`,
    async run(a, ctx) {
      // Stop ends the wait right away.
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.min(10, Math.max(0.5, a.seconds || 1)) * 1000);
        function done() { clearTimeout(timer); ctx.signal?.removeEventListener('abort', done); resolve(); }
        ctx.signal?.addEventListener('abort', done);
      });
      if (ctx.signal?.aborted) throw new Error('Stopped');
      return 'Done waiting.';
    },
  },
];

// A short hash of what a tab shows (scripts.pageState), so the AI can tell
// whether its last step changed anything: '' when there's nothing to read.
// The frames the last read_page read count too (an edit in Excel's workbook).
async function pageState(tab, volatile) {
  const wc = tab?.view?.webContents;
  if (!wc || wc.isDestroyed() || PRIVATE_PAGE.test(wc.getURL())) return '';
  const top = Promise.race([inPage(wc, scripts.pageState, { volatile }), wait(1000).then(() => '')]).catch(() => '');
  const seen = frameReads.get(wc);
  const ids = seen ? [...new Set([...seen.big, ...seen.acted])] : [];
  if (!ids.length) return top;
  const [page, inFrames] = await Promise.all([top, frames.states(wc, ids, volatile).catch(() => '')]);
  return inFrames ? `${page}|${inFrames}` : page;
}

// Removes the fake cursor from every tab (called when a run ends).
async function clearCursors(tabs) {
  for (const t of tabs.tabs) {
    if (!t.view || t.view.webContents.isDestroyed()) continue;
    try { await inPage(t.view.webContents, scripts.cursor, { remove: true }); } catch { /* ignore */ }
  }
}

// Text of the active page, for "Include this page" context.
const YOUTUBE_VIDEO = /^https:\/\/(www\.|m\.)?youtube\.com\/(watch\?|shorts\/|live\/)/;

function videoText(v) {
  const len = v.seconds ? ` · ${Math.floor(v.seconds / 60)}:${String(v.seconds % 60).padStart(2, '0')} long` : '';
  return [
    `YouTube video: ${v.title}${v.channel ? ` · by ${v.channel}` : ''}${len}`,
    v.description ? `Description:\n${v.description}` : '',
    v.transcript ? `Transcript:\n${v.transcript}` : '(This video has no transcript, so only the title and description are available.)',
  ].filter(Boolean).join('\n\n');
}

// What "Include this page" sends: the page's readable text, or for a YouTube
// video its details and transcript.
async function pageContext(tabs, tab = tabs.active, { maxText = 12000 } = {}) {
  if (!tab?.view) return null;
  const wc = tab.view.webContents;
  const url = wc.getURL();
  if (!/^https?:/.test(url)) return null;
  // A page waiting on its own alert() can't be read until the person answers it.
  if (stopped(tab)) return { tabId: tab.id, title: wc.getTitle(), url, text: '', favicon: tab.favicon };
  pageTabs.set(wc, tab);
  if (YOUTUBE_VIDEO.test(url)) {
    try {
      const v = await inPage(wc, scripts.youtube, { max: Math.max(maxText, 60000) });
      if (v && !v.error) return { tabId: tab.id, title: v.title, url, text: videoText(v), favicon: tab.favicon, video: true, transcript: !!v.transcript };
    } catch {}
  }
  try {
    const snap = await inPage(wc, scripts.snapshot, { max: 0, maxText });
    return { tabId: tab.id, title: snap.title, url: snap.url, text: snap.text, favicon: tab.favicon };
  } catch {
    return { tabId: tab.id, title: wc.getTitle(), url, text: '', favicon: tab.favicon };
  }
}

// "Ask about my tabs": every open web tab's text, each tab getting an equal
// share of the budget. Sleeping tabs (Memory Saver) are listed by title only.
const ALL_TABS_BUDGET = 90000;
const ALL_TABS_MAX = 30;
async function allTabsContext(tabs) {
  const web = tabs.tabs.filter((t) => /^(https?:|file:.*\.pdf$)/i.test(tabs.displayUrl(t) || ''));
  const list = web.slice(0, ALL_TABS_MAX);
  const per = Math.max(2500, Math.floor(ALL_TABS_BUDGET / Math.max(1, list.length)));
  const read = await Promise.all(list.map(async (t) => {
    const base = { tabId: t.id, title: t.title || '', url: tabs.displayUrl(t), favicon: t.favicon };
    if (!t.view || t.discarded) return { ...base, text: '', note: 'asleep (Memory Saver), not read' };
    if (t.pdf) return { ...base, text: '', note: 'a PDF; open it and ask Lumio to summarize it' };
    let timer;
    const page = await Promise.race([pageContext(tabs, t, { maxText: per }), new Promise((r) => { timer = setTimeout(r, 6000, null); })]).catch(() => null);
    clearTimeout(timer);
    return page ? { ...base, title: page.title || base.title, text: (page.text || '').slice(0, per) } : { ...base, text: '', note: 'couldn’t be read' };
  }));
  return { tabs: read, skipped: web.length - list.length };
}

// The PDF open in a tab, fetched with that tab's cookies so signed-in
// documents work too. The panel reads it with pdf.js.
const MAX_PDF = 30 * 1024 * 1024;
async function tabPdf(tabs, tabId) {
  const tab = tabId == null ? tabs.active : tabs.tabs.find((t) => t.id === tabId);
  if (!tab?.view || !tab.pdf) return { error: 'That tab isn’t showing a PDF.' };
  const wc = tab.view.webContents;
  const url = wc.getURL();
  const name = decodeURIComponent((new URL(url).pathname.split('/').pop() || 'document.pdf')).replace(/[\u0000-\u001f]/g, ' ').slice(0, 120) || 'document.pdf';
  try {
    let data;
    if (url.startsWith('file:')) {
      const file = require('url').fileURLToPath(url);
      const st = await require('fs').promises.stat(file);
      if (st.size > MAX_PDF) return { error: 'That PDF is over 30 MB.' };
      data = await require('fs').promises.readFile(file);
    } else if (/^https?:/.test(url)) {
      const res = await wc.session.fetch(url);
      if (!res.ok) return { error: `Couldn’t download the PDF (${res.status}).` };
      if (Number(res.headers.get('content-length')) > MAX_PDF) return { error: 'That PDF is over 30 MB.' };
      data = Buffer.from(await res.arrayBuffer());
      if (data.length > MAX_PDF) return { error: 'That PDF is over 30 MB.' };
    } else return { error: 'That tab isn’t showing a PDF.' };
    return { name: /\.pdf$/i.test(name) ? name : `${name}.pdf`, data: new Uint8Array(data), tabId: tab.id, title: tab.title, url, favicon: tab.favicon };
  } catch (err) {
    return { error: `Couldn’t read the PDF: ${err.message}` };
  }
}

module.exports = { tools, clearCursors, pageState, pageContext, allTabsContext, tabPdf, YOUTUBE_VIDEO, videoText, pressKey, parseKeys, inPage, settle, PRIVATE_PAGE };
