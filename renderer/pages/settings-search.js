// Search settings: a box at the top of Settings. Typing shows only the
// settings whose words match (all the words, in any order, accents or not),
// with the matches marked, across every section; a section whose name
// matches shows whole. "/" jumps to the box and Esc clears it.
const content = document.querySelector('main.content');
const side = document.querySelector('.side');

content.insertAdjacentHTML('afterbegin', `
      <div class="settings-search" role="search">
        <div class="ss-box">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
          <input type="search" id="settings-search" placeholder="Search settings" aria-label="Search settings" aria-controls="settings-search-empty" autocomplete="off" spellcheck="false" />
          <button type="button" class="ss-clear" id="settings-search-clear" aria-label="Clear search" title="Clear search" hidden>×</button>
        </div>
      </div>
      <div class="search-empty" id="settings-search-empty" role="status" aria-live="polite" hidden>No search results found</div>
`);
const input = document.getElementById('settings-search');
const clearBtn = document.getElementById('settings-search-clear');
const empty = document.getElementById('settings-search-empty');

const HIDE = 'search-hide';
// Lowercase, without accents, with where each letter came from in the text.
function fold(text) {
  let out = '';
  const at = [];
  for (let i = 0; i < text.length; i++) {
    for (const ch of text[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()) { out += ch; at.push(i); }
  }
  return { out, at };
}
const termsOf = (q) => fold(q).out.split(/\s+/).filter(Boolean);

// The settings in a block: its rows, or the block itself when it has none.
const leafRows = (el) => [...el.querySelectorAll('.row')].filter((r) => !r.querySelector('.row'));
const pageHidden = (el) => !!el.closest('[hidden], dialog:not([open])');

function unmark() {
  for (const m of content.querySelectorAll('mark.search-hit')) {
    const parent = m.parentNode;
    m.replaceWith(document.createTextNode(m.textContent));
    parent.normalize();
  }
  for (const el of document.querySelectorAll('.' + HIDE)) el.classList.remove(HIDE);
}

// Wraps the words that match in <mark> (not inside fields and menus).
function mark(el, terms) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('select, option, textarea, script, style, svg, mark, button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.trim()) nodes.push(n);
  for (const node of nodes) {
    const { out, at } = fold(node.data);
    const spans = [];
    for (const w of terms) {
      for (let i = out.indexOf(w); i >= 0; i = out.indexOf(w, i + w.length)) spans.push([at[i], at[i + w.length - 1] + 1]);
    }
    if (!spans.length) continue;
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [spans[0]];
    for (const [a, b] of spans.slice(1)) { const last = merged[merged.length - 1]; if (a <= last[1]) last[1] = Math.max(last[1], b); else merged.push([a, b]); }
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [a, b] of merged) {
      if (a > pos) frag.append(node.data.slice(pos, a));
      const m = document.createElement('mark');
      m.className = 'search-hit';
      m.textContent = node.data.slice(a, b);
      frag.append(m);
      pos = b;
    }
    if (pos < node.data.length) frag.append(node.data.slice(pos));
    node.replaceWith(frag);
  }
}

function filter(query) {
  const terms = termsOf(query);
  unmark();
  clearBtn.hidden = !query;
  if (!terms.length) { empty.hidden = true; return; }
  // Text as shown (what the page itself hides doesn't count), all read
  // before anything is hidden here, so the page is laid out once.
  const match = (el) => {
    const t = fold(`${el.innerText} ${[...el.querySelectorAll('input[placeholder]')].map((i) => i.placeholder).join(' ')}`).out;
    return terms.every((w) => t.includes(w));
  };
  const hide = new Set();
  const marks = [];
  let found = 0;
  for (const section of content.querySelectorAll(':scope > section')) {
    if (pageHidden(section)) continue;
    const whole = match(section.querySelector('h2') || section); // the section's name matches: all of it shows
    const groups = []; // each h3 and whether anything under it shows
    let group = null;
    let any = whole;
    for (const block of section.children) {
      if (block.tagName === 'H2') { if (whole) marks.push(block); continue; }
      if (block.tagName === 'H3') {
        group = { h3: block, hit: match(block), shown: false };
        groups.push(group);
        if (group.hit) marks.push(block);
        continue;
      }
      if (pageHidden(block)) continue;
      const all = whole || !!group?.hit;
      const rows = leafRows(block).filter((r) => !pageHidden(r));
      let shown;
      if (rows.length) {
        const keep = new Set();
        for (const r of rows) {
          const hit = match(r);
          if (hit) marks.push(r);
          if (!hit && !all) { hide.add(r); continue; }
          for (let el = r; el && el !== block; el = el.parentElement) keep.add(el);
        }
        // Boxes inside the block (a card's inner group) with nothing left in them.
        for (const r of rows) for (let el = r.parentElement; el && el !== block; el = el.parentElement) if (!keep.has(el)) hide.add(el);
        shown = keep.size > 0;
      } else {
        const hit = match(block);
        if (hit) marks.push(block);
        shown = all || hit;
      }
      if (!shown) hide.add(block);
      else { any = true; if (group) group.shown = true; }
    }
    for (const g of groups) if (!g.hit && !g.shown) hide.add(g.h3);
    if (!any) hide.add(section);
    side?.querySelector(`a[href="#${CSS.escape(section.id)}"]`)?.classList.toggle(HIDE, !any);
    if (any) found++;
  }
  for (const el of hide) el.classList.add(HIDE);
  for (const el of marks) if (!el.closest('.' + HIDE)) mark(el, terms);
  empty.hidden = found > 0;
}

// Marking words changes the page's text; Lumio's translation (if any) must
// leave those pieces alone, and the watcher below mustn't see them either.
let applied = '';
function apply() {
  watcher.disconnect();
  const run = () => filter(input.value);
  if (window.lumioI18n) window.lumioI18n.untracked(run); else run();
  applied = input.value;
  watcher.observe(content, { childList: true, subtree: true });
}

// Sections that redraw (sync status, scheduled tasks…) are filtered again.
let redo = null;
const watcher = new MutationObserver(() => {
  if (!applied.trim()) return;
  clearTimeout(redo);
  redo = setTimeout(apply, 200);
});

let typing = null;
input.addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(() => { apply(); window.scrollTo({ top: 0 }); }, 120);
});
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (input.value) { input.value = ''; apply(); } else input.blur();
});
clearBtn.addEventListener('click', () => { input.value = ''; apply(); input.focus(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable], dialog')) return;
  e.preventDefault();
  input.focus();
  input.select();
});
