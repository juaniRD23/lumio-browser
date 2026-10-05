// Browser tools: read and operate web pages in Lumio's own tabs. Input is
// sent as real (trusted) mouse/keyboard events via webContents.sendInputEvent.
const scripts = require('./page-scripts');
const { parseInput, displayUrl } = require('../../omnibox');
const { markSynthetic } = require('../../synthetic-input');

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
const stopped = (tab) => !!tab?.dialogs?.some((d) => d.spec.kind === 'js' || d.spec.kind === 'unresponsive');
function dialogNote(tab) {
  const kind = tab?.dialogs?.[0]?.spec.kind;
  return kind ? `Tab ${tab.id} is showing ${DIALOGS[kind] || 'a dialog'}, which only the user can answer. Ask them to answer it, then go on.` : '';
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

function tabFor(ctx, id, { activate = false } = {}) {
  const tab = id ? ctx.tabs.get(id) : ctx.tabs.active;
  if (!tab) throw new Error(id ? `There is no tab ${id}. Use list_tabs.` : 'No tab is open.');
  ctx.tabs.ensureView(tab);
  if (activate && ctx.tabs.activeId !== tab.id) ctx.tabs.activate(tab.id);
  const wc = tab.view.webContents;
  const url = wc.getURL() || tab.url || '';
  if (url.startsWith('lumio://settings')) throw new Error("Lumio can't read or operate its own Settings page. Ask the user to change settings themselves.");
  // Going past a security warning is the person's call alone.
  if (url.startsWith('lumio://error/cert')) throw new Error("This tab shows a security warning (the site's certificate isn't valid). Lumio can't continue past it: ask the user what to do.");
  const note = dialogNote(tab);
  if (note) throw new Error(note);
  pageTabs.set(wc, tab);
  ctx.onPage?.(wc); // the page glows while Lumio works on it
  return { tab, wc, url };
}

function pageLine(wc) {
  const note = dialogNote(pageTabs.get(wc));
  return `Page is now: "${wc.getTitle()}" — ${wc.getURL()}${note ? `\n${note}` : ''}`;
}

function refName(ctx, tabId, ref) {
  const tab = tabId ? ctx.tabs.get(tabId) : ctx.tabs.active;
  const meta = tab && ctx.refs.get(tab.id);
  const name = meta?.[ref]?.name;
  return name ? `“${name.length > 40 ? name.slice(0, 40) + '…' : name}”` : `element [${ref}]`;
}

function activeHost(ctx, tabId) {
  const tab = tabId ? ctx.tabs.get(tabId) : ctx.tabs.active;
  return tab ? hostOf(ctx.tabs.displayUrl(tab)) : '';
}

function safeUrl(ctx, input) {
  const parsed = parseInput(input, ctx.tabs.searchTemplate());
  if (!parsed) throw new Error('Empty URL.');
  if (/^(file|view-source|data|javascript):/i.test(parsed.url)) throw new Error('Lumio can only open web pages (http/https).');
  if (/^lumio:\/\/settings/i.test(parsed.url)) throw new Error("Lumio can't open its own Settings page.");
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

const KEY_NAMES = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'Backspace',
  delete: 'Delete', del: 'Delete', space: 'Space', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown',
};
const MODS = { cmd: 'meta', command: 'meta', meta: 'meta', ctrl: 'control', control: 'control', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift' };

function pressKey(wc, combo) {
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean);
  const modifiers = [];
  let key = '';
  for (const p of parts) {
    const m = MODS[p.toLowerCase()];
    if (m) modifiers.push(m); else key = p;
  }
  if (!key) throw new Error(`No key in "${combo}".`);
  const lower = key.toLowerCase();
  // Editing shortcuts go through webContents (sendInputEvent bypasses the menu on macOS).
  if (modifiers.includes('meta') && key.length === 1) {
    const shift = modifiers.includes('shift');
    const edit = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: shift ? 'redo' : 'undo' }[lower];
    if (edit) { wc[edit](); return; }
  }
  const keyCode = KEY_NAMES[lower] || (key.length === 1 ? key.toUpperCase() : key);
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

async function thumbOf(image, width = 320) {
  return 'data:image/jpeg;base64,' + image.resize({ width, quality: 'good' }).toJPEG(70).toString('base64');
}

const tools = [
  {
    name: 'read_page',
    risk: 'read',
    icon: 'page',
    description: 'Read a tab: its URL, title, the interactive elements (with [ref] numbers for click/type) and the visible text. Call again after the page changes; refs are renumbered each time.',
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
      const snap = await inPage(wc, scripts.snapshot, { maxText: a.include_text === false ? 0 : 7000 });
      ctx.refs.set(tab.id, snap.meta);
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
      if (snap.frames) parts.push('', `(${snap.frames} embedded frame(s) not included; use screenshot_tab to see them.)`);
      return { text: parts.join('\n'), summary: `${snap.lines.length} elements` };
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
      const { wc } = tabFor(ctx, a.tab_id, { activate: true });
      if (ctx.background) { // a helper's hidden tab: click through the page
        const res = await inPage(wc, scripts.domClick, { ref: a.ref, double: !!a.double });
        if (res.error) throw new Error(res.error);
        await settle(wc);
        return { text: `Clicked [${a.ref}]. ${pageLine(wc)}` };
      }
      const info = await inPage(wc, scripts.locate, { ref: a.ref });
      if (info.error) throw new Error(info.error);
      const z = wc.getZoomFactor();
      await moveCursor(ctx, wc, info.x, info.y, false);
      await mouseClick(wc, Math.round(info.x * z), Math.round(info.y * z), a.double ? 2 : 1);
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
      const { wc } = tabFor(ctx, a.tab_id, { activate: true });
      const info = await inPage(wc, scripts.locate, { ref: a.ref });
      if (info.error) throw new Error(info.error);
      if (info.sensitive) {
        return { text: 'Refused: this looks like a password, payment, or ID field. Ask the user to fill it in themselves.', summary: 'Sensitive field, left for you', status: 'blocked' };
      }
      if (info.isSelect) throw new Error('That element is a dropdown; use select_option.');
      if (ctx.background) { // a helper's hidden tab: type through the page
        const res = await inPage(wc, scripts.domType, { ref: a.ref, text: String(a.text), clear: a.clear !== false, submit: !!a.submit });
        if (res.error) throw new Error(res.error);
        if (a.submit) await settle(wc); else await wait(150);
        return { text: `Typed into [${a.ref}]${a.submit ? ' and pressed Enter' : ''}. ${pageLine(wc)}` };
      }
      const z = wc.getZoomFactor();
      await moveCursor(ctx, wc, info.x, info.y, false);
      await mouseClick(wc, Math.round(info.x * z), Math.round(info.y * z));
      await moveCursor(ctx, wc, info.x, info.y, true);
      await wait(60);
      const focus = await inPage(wc, scripts.focusCheck);
      if (focus.sensitive) {
        return { text: 'Refused: focus landed on a password, payment, or ID field. Ask the user to fill it in themselves.', summary: 'Sensitive field, left for you', status: 'blocked' };
      }
      if (a.clear !== false) await inPage(wc, scripts.selectContents, { ref: a.ref });
      await wc.insertText(String(a.text));
      if (a.submit) { await wait(120); pressKey(wc, 'Enter'); await settle(wc); } else await wait(150);
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
      const { wc } = tabFor(ctx, a.tab_id, { activate: true });
      const text = String(a.text ?? '');
      if (!text) throw new Error('Nothing to paste.');
      if (a.ref) {
        const info = await inPage(wc, scripts.locate, { ref: a.ref });
        if (info.error) throw new Error(info.error);
        if (info.sensitive) return { text: 'Refused: this looks like a password, payment, or ID field. Ask the user to fill it in themselves.', summary: 'Sensitive field, left for you', status: 'blocked' };
        const z = wc.getZoomFactor();
        await moveCursor(ctx, wc, info.x, info.y, false);
        await mouseClick(wc, Math.round(info.x * z), Math.round(info.y * z));
        await moveCursor(ctx, wc, info.x, info.y, true);
        await wait(80);
      }
      const focus = await inPage(wc, scripts.focusCheck).catch(() => ({}));
      if (focus.sensitive) return { text: 'Refused: focus is on a password, payment, or ID field. Ask the user to fill it in themselves.', summary: 'Sensitive field, left for you', status: 'blocked' };
      // Through the real clipboard (sites like Google Sheets only split rows and
      // columns on a real paste); whatever the user had copied is put back.
      const { clipboard } = require('electron');
      // Google Sheets: a cell being edited takes the whole paste as its text,
      // so leave editing first (Esc keeps the cell selected), and paste the rows
      // as a table too, which Sheets always spreads over the cells.
      const sheet = /^https:\/\/docs\.google\.com\/spreadsheets\//.test(wc.getURL());
      const grid = /[\t\n]/.test(text.trim());
      if (sheet && grid) { pressKey(wc, 'Escape'); await wait(120); }
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
      const { wc } = tabFor(ctx, a.tab_id, { activate: true });
      const res = await inPage(wc, scripts.selectOption, { ref: a.ref, value: a.value });
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
      const printable = String(a.keys).length === 1 || /^(shift\+).$/i.test(a.keys) || /\+v$/i.test(a.keys);
      if (printable && (await inPage(wc, scripts.focusCheck)).sensitive) {
        return { text: 'Refused: the focused field is a password, payment, or ID field. Ask the user to fill it in themselves.', summary: 'Sensitive field, left for you', status: 'blocked' };
      }
      pressKey(wc, a.keys);
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
      if (ctx.background) { // a helper's hidden tab: scroll through the page
        const res = await inPage(wc, scripts.domScroll, { ref: a.ref, down: a.direction !== 'up', amount: Math.min(5, Math.max(0.1, a.amount || 0.8)) });
        await wait(300);
        return `Scrolled ${a.direction}. Now at ${res.scrollY} of ${res.scrollHeight}px.`;
      }
      const bounds = tab.view.getBounds();
      let x = Math.round(bounds.width / 2);
      let y = Math.round(bounds.height / 2);
      if (a.ref) {
        const info = await inPage(wc, scripts.locate, { ref: a.ref });
        if (!info.error) { const z = wc.getZoomFactor(); x = Math.round(info.x * z); y = Math.round(info.y * z); }
      }
      // Chromium caps each wheel event, so big scrolls go out as several.
      let px = Math.round(bounds.height * Math.min(5, Math.max(0.1, a.amount || 0.8)));
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      while (px > 0) {
        const step = Math.min(px, Math.round(bounds.height * 0.8));
        wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: a.direction === 'up' ? step : -step, canScroll: true });
        px -= step;
        await wait(120);
      }
      await wait(350);
      const s = await inPage(wc, scripts.scrollInfo);
      return `Scrolled ${a.direction}. Now at ${s.y} of ${s.height}px (viewport ${s.vh}px).`;
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
      const { tab, wc } = tabFor(ctx, a.tab_id, { activate: true });
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
      const { tab, wc } = tabFor(ctx, a.tab_id, { activate: true });
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
      let img;
      try { img = await wc.capturePage(); } finally { await ctx.onCapture?.(wc, false); }
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
      await moveCursor(ctx, wc, x / z, y / z, false);
      await mouseClick(wc, x, y, a.double ? 2 : 1);
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
      if (ctx.tabs.get(a.tab_id)) await new Promise((r) => setTimeout(r, 400));
      return ctx.tabs.get(a.tab_id) ? `Tab ${a.tab_id} is asking the user to confirm leaving the page; it closes if they agree.` : `Closed tab ${a.tab_id}.`;
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

module.exports = { tools, clearCursors, pageContext, allTabsContext, tabPdf, YOUTUBE_VIDEO, videoText, pressKey, inPage, settle };
