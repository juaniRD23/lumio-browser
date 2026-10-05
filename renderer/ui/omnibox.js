// The address bar while you type. The rows come from the main process
// (main/omnibox-service.js) and overlay.js draws them above the page.
//  - Inline autocomplete: the rest of a site you go to shows selected after
//    the caret; typing through it keeps it, Backspace removes it.
//  - Chips: "yt " (or yt + Tab) searches YouTube, "@tabs " searches open
//    tabs; Backspace at the start leaves the chip.
//  - Clicking the empty bar shows the pages you visit most and a link you
//    just copied.
//  - Keys: ↑↓ or Tab choose, Enter goes, ⌥Enter opens a new tab (⌘Enter too
//    on the Mac), ⇧Enter a new window, Ctrl+Enter adds www. and .com,
//    ⇧Delete removes a page from history, ⌘⇧V pastes and goes, Esc closes
//    the list and then puts the address back.
const IS_MAC = /Mac/.test(navigator.platform);
const ROW_H = 38;
const LABEL = 'Address and search bar';

export function initOmnibox({ api, address, box, activeTab, ask, edited, overlay }) {
  // The chip at the start of the bar, and what screen readers hear.
  const chip = document.createElement('span');
  chip.id = 'omni-chip';
  chip.hidden = true;
  box.insertBefore(chip, address);
  const live = document.createElement('div');
  live.className = 'omni-live';
  live.setAttribute('aria-live', 'polite');
  document.body.append(live);
  address.setAttribute('role', 'combobox');
  address.setAttribute('aria-autocomplete', 'both');
  address.setAttribute('aria-haspopup', 'listbox');
  address.setAttribute('aria-expanded', 'false');

  let rows = []; // the dropdown's rows
  let sel = 0; // the chosen row; -1 when none is (the empty bar's list)
  let madeFor = null; // { text, keyword } the rows were made for
  let seq = 0;
  let inline = null; // { typed, completion } while a completion shows after the caret
  let mode = null; // { keyword, chip, scope? } while a chip shows
  let keywords = []; // the shortcuts that become a chip
  let remoteTimer = 0;
  let announceTimer = 0;

  const focused = () => document.activeElement === address;
  const typedText = () => (inline ? inline.typed : address.value);
  const fresh = () => !!madeFor && overlay.open() && madeFor.text === typedText() && madeFor.keyword === (mode?.keyword || null);
  const caretAtEnd = () => address.selectionStart === address.value.length && address.selectionEnd === address.value.length;
  const rowKey = (r) => `${r.type}|${r.url || ''}|${r.title}`;

  // ---------------------------------------------------------------- the list
  function render() {
    if (!rows.length) { close(); return; }
    const r = box.getBoundingClientRect();
    overlay.show(
      { x: r.left - 12, y: r.bottom + 2, width: r.width + 24, height: rows.length * ROW_H + 12 + 26 },
      { kind: 'suggest', items: rows, selected: sel },
    );
    address.setAttribute('aria-expanded', 'true');
  }

  function close() {
    overlay.hide();
    address.setAttribute('aria-expanded', 'false');
  }

  // Screen readers hear the chosen row right away, and how many rows there
  // are once typing pauses.
  function say(text, wait = 120) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { live.textContent = text; }, wait);
  }
  function describe(r) {
    const kind = { tab: 'open tab', history: 'history', bookmark: 'bookmark', search: 'search', action: 'action', answer: 'answer', clipboard: 'link you copied', ai: 'ask Lumio', keyword: 'shortcut' }[r.type] || '';
    const where = r.url && !/^(search|keyword|ai|answer|action)$/.test(r.type) ? `, ${r.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}` : '';
    return `${r.title}${where}, ${kind}, ${sel + 1} of ${rows.length}`;
  }

  // Shows or hides the completion as the first row is chosen or not.
  function showCompletion() {
    if (!inline) return;
    if (sel === 0) {
      address.value = inline.typed + inline.completion;
      address.setSelectionRange(inline.typed.length, address.value.length);
    } else {
      address.value = inline.typed;
    }
  }

  function setRows(list, text, { allowInline = true, keep = false } = {}) {
    const keepKey = keep && rows[sel] && sel > 0 ? rowKey(rows[sel]) : null;
    rows = Array.isArray(list) ? list : [];
    madeFor = { text, keyword: mode?.keyword || null };
    sel = 0;
    if (keepKey) sel = Math.max(0, rows.findIndex((r) => rowKey(r) === keepKey));
    const completion = rows[0]?.inline;
    if (allowInline && completion && (inline || caretAtEnd())) {
      inline = { typed: text, completion };
      showCompletion();
    } else if (inline) {
      address.value = inline.typed;
      inline = null;
    }
    render();
    if (rows.length && !keep) say(`${rows.length} suggestion${rows.length === 1 ? '' : 's'}`, 600);
  }

  async function refresh({ allowInline = true } = {}) {
    const text = typedText();
    const my = ++seq;
    clearTimeout(remoteTimer);
    if (!text.trim() && !mode?.scope) { rows = []; close(); return; }
    const req = { text, keyword: mode?.keyword, inline: allowInline };
    const list = await api.invoke('omnibox:suggest', req);
    if (my !== seq || !focused()) return;
    setRows(list, text, { allowInline });
    // Then the search engine's suggestions, once typing pauses.
    if (mode?.scope) return;
    remoteTimer = setTimeout(async () => {
      const more = await api.invoke('omnibox:suggest', { ...req, remote: true });
      if (my !== seq || !focused() || !more) return;
      setRows(more, text, { allowInline, keep: true });
    }, 150);
  }

  // The empty bar: pages you visit most, and a link you just copied.
  async function zero() {
    const my = ++seq;
    clearTimeout(remoteTimer);
    inline = null;
    const list = await api.invoke('omnibox:zero');
    if (my !== seq || !focused() || address.value || mode) return;
    rows = Array.isArray(list) ? list : [];
    madeFor = { text: '', keyword: null };
    sel = -1;
    render();
  }

  const requery = () => (!typedText() && !mode ? zero() : refresh({ allowInline: false }));

  function move(delta) {
    if (!rows.length) return;
    sel = sel < 0 ? (delta > 0 ? 0 : rows.length - 1) : (sel + delta + rows.length) % rows.length;
    showCompletion();
    render();
    say(describe(rows[sel]));
  }

  // ---------------------------------------------------------------- chips
  function enterMode(k, rest = '') {
    mode = { keyword: k.keyword, chip: k.chip, scope: k.scope || null };
    inline = null;
    chip.textContent = k.chip;
    chip.hidden = false;
    address.setAttribute('aria-label', `${k.chip}. Type what to search for`);
    address.value = rest;
    address.setSelectionRange(rest.length, rest.length);
    say(k.chip);
    refresh();
  }

  function exitMode() {
    if (!mode) return null;
    const k = mode;
    mode = null;
    chip.hidden = true;
    address.setAttribute('aria-label', LABEL);
    return k;
  }

  // "yt " typed at the start: the chip, with what's after the space.
  function typedKeyword(e) {
    if (mode || e.inputType !== 'insertText' || e.data !== ' ') return false;
    const m = /^(\S+) ([\s\S]*)$/.exec(address.value);
    if (!m || address.selectionStart !== m[1].length + 1) return false;
    const k = keywords.find((x) => !x.tabOnly && x.keyword.toLowerCase() === m[1].toLowerCase());
    if (!k) return false;
    enterMode(k, m[2]);
    return true;
  }

  // Tab after a shortcut ("yt", "google.com", or the start of "@tabs").
  function tabKeyword() {
    const v = typedText().trim().toLowerCase();
    if (!v || /\s/.test(v)) return null;
    return keywords.find((x) => x.keyword.toLowerCase() === v)
      || (v.startsWith('@') ? keywords.find((x) => x.scope && x.keyword.startsWith(v)) : null)
      || null;
  }

  // ---------------------------------------------------------------- going
  function finish() {
    clearTimeout(remoteTimer);
    seq++;
    inline = null;
    exitMode();
    close();
    address.blur();
  }

  function go(req, disposition = 'current') {
    api.send('omnibox:open', { ...req, disposition });
    finish();
  }

  function pick(row, disposition = 'current') {
    if (!row) return;
    if (row.type === 'keyword') {
      address.focus(); // after a click in the dropdown, before the chip (focusing shows the address)
      enterMode(keywords.find((k) => k.keyword === row.keyword) || { keyword: row.keyword, chip: row.title, scope: row.scope }, '');
      return;
    }
    if (row.type === 'ai') { finish(); ask(row.title); return; }
    if (row.type === 'tab') { api.send('omnibox:switch-tab', { tabId: row.tabId, windowId: row.windowId }); finish(); return; }
    if (row.type === 'action') { api.send('omnibox:action', row.action); finish(); return; }
    if (row.type === 'answer') { api.send('omnibox:copy', row.answer); finish(); return; }
    go({ url: row.url, kind: row.type }, disposition);
  }

  // ⇧Delete keeps the list open; the × in the dropdown closes it (clicking
  // there takes focus from the bar), so the browser says it worked.
  async function removeRow(i) {
    const row = rows[i];
    if (!row || !(row.removable || row.type === 'clipboard')) return;
    await api.invoke('omnibox:remove', { url: row.url, type: row.type, toast: !focused() });
    say(`Removed ${row.title}`);
    if (focused()) requery();
  }

  function enter(e) {
    const text = typedText().trim();
    // ⌥Enter: a new tab (and ⌘Enter on the Mac, as before); ⇧Enter: a new window.
    const disposition = e.altKey || (IS_MAC && e.metaKey) ? 'tab' : e.shiftKey ? 'window' : 'current';
    if (e.ctrlKey && !e.metaKey && !mode && text) { go({ input: text, www: true }, disposition); return; }
    if (fresh() && sel >= 0 && rows[sel]) { pick(rows[sel], disposition); return; }
    if (!text) return;
    if (mode?.scope === 'lumio') { finish(); ask(text); return; }
    if (mode?.scope === 'history') { go({ url: `lumio://history/?q=${encodeURIComponent(text)}`, kind: 'search' }, disposition); return; }
    if (mode?.scope) return; // @tabs or @bookmarks with nothing that matches
    go({ input: text, keyword: mode?.keyword }, disposition);
  }

  // ---------------------------------------------------------------- events
  address.addEventListener('input', (e) => {
    edited();
    if (typedKeyword(e)) return;
    const deleting = /^delete/.test(e.inputType || '');
    // Typing the next letter of the completion keeps the rest of it.
    if (inline && e.inputType === 'insertText' && e.data && address.value === inline.typed + e.data
      && inline.completion.toLowerCase().startsWith(e.data.toLowerCase())) {
      const rest = inline.completion.slice(e.data.length);
      inline = rest ? { typed: address.value, completion: rest } : null;
      if (inline) { address.value += rest; address.setSelectionRange(inline.typed.length, address.value.length); }
    } else {
      inline = null;
    }
    if (!address.value && !mode) { zero(); return; }
    refresh({ allowInline: !deleting && (!!inline || caretAtEnd()) });
  });

  // Moving the caret or clicking into the text keeps the completion as typed.
  const settle = () => {
    if (inline && (address.selectionStart !== inline.typed.length || address.selectionEnd !== address.value.length)) inline = null;
  };
  address.addEventListener('mouseup', settle);
  address.addEventListener('keyup', (e) => { if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) settle(); });

  address.addEventListener('click', () => { if (!address.value && !mode && !overlay.open()) zero(); });

  address.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      if (!overlay.open()) { requery(); return; }
      move(k === 'ArrowDown' ? 1 : -1);
    } else if (k === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const kw = !e.shiftKey && !mode ? tabKeyword() : null;
      if (kw) { e.preventDefault(); enterMode(kw, ''); return; }
      if (overlay.open() && rows.length) { e.preventDefault(); move(e.shiftKey ? -1 : 1); }
    } else if (k === 'Enter') {
      e.preventDefault();
      enter(e);
    } else if (k === 'Backspace' && mode && address.selectionStart === 0 && address.selectionEnd === 0) {
      // Leave the chip: its shortcut goes back in front of the text.
      e.preventDefault();
      const rest = address.value;
      const was = exitMode();
      address.value = rest ? `${was.keyword} ${rest}` : was.keyword;
      address.setSelectionRange(was.keyword.length, was.keyword.length);
      refresh({ allowInline: false });
    } else if (k === 'Delete' && e.shiftKey && fresh() && sel >= 0) {
      e.preventDefault();
      removeRow(sel);
    } else if ((IS_MAC ? e.metaKey : e.ctrlKey) && e.shiftKey && k.toLowerCase() === 'v') {
      e.preventDefault();
      api.send('omnibox:paste-go');
      finish();
    } else if (k === 'Escape') {
      e.preventDefault();
      if (overlay.open() || inline) {
        // First Esc: close the list (and drop the completion).
        if (inline) { address.value = inline.typed; inline = null; }
        seq++;
        clearTimeout(remoteTimer);
        close();
        return;
      }
      exitMode();
      address.value = activeTab()?.url || '';
      address.blur();
      api.send('tab:focus-page');
    }
  });

  // Right-click: editing, Paste and Go, search engine settings (drawn by the main process).
  address.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.send('omnibox:context', { selection: address.selectionStart !== address.selectionEnd, empty: !address.value });
  });

  return {
    // The bar got focus: get the shortcuts that make a chip.
    onFocus() {
      api.invoke('omnibox:keywords').then((list) => { keywords = Array.isArray(list) ? list : []; }).catch(() => {});
    },
    // It lost focus: the chip and any completion go (the toolbar shows the address again).
    onBlur() {
      clearTimeout(remoteTimer);
      inline = null;
      exitMode();
      address.setAttribute('aria-expanded', 'false');
    },
    // A row clicked in the dropdown (overlay.js).
    onPicked(msg) {
      if (msg.action === 'remove') { removeRow(msg.index); return; }
      pick(rows[msg.index], msg.disposition);
    },
  };
}
