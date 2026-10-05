// Fuzzy search for tab search (overlay-tabsearch.js): the letters you type,
// in order, anywhere in a title or address. Whole words, word starts and runs
// of letters rank higher, like Chrome's tab search. Plain functions
// (tests/tab-strip.test.mjs).

const isBoundary = (text, i) => i === 0 || /[\s\-_./:?#&=()[\],|]/.test(text[i - 1]) || (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]));

// { score, marks } with the matched character positions, or null.
export function fuzzyMatch(query, text) {
  const q = String(query || '').trim().toLowerCase();
  const t = String(text || '');
  if (!q) return { score: 0, marks: [] };
  const lower = t.toLowerCase();
  // A run of the query as typed beats scattered letters.
  const at = lower.indexOf(q);
  if (at >= 0) {
    const marks = Array.from({ length: q.length }, (_, k) => at + k);
    return { score: 100 + q.length * 4 + (isBoundary(t, at) ? 30 : 0) + (at === 0 ? 20 : 0) - at * 0.1, marks };
  }
  // Each letter at the next word start if there is one, else the next match.
  const marks = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    let pick = -1;
    for (let i = from; i < lower.length; i++) {
      if (lower[i] !== ch) continue;
      if (pick < 0) pick = i;
      if (isBoundary(t, i)) { pick = i; break; }
      if (marks.length && i === marks[marks.length - 1] + 1) break; // keep a run going
    }
    if (pick < 0) return null;
    const prev = marks[marks.length - 1];
    score += 1 + (isBoundary(t, pick) ? 8 : 0) + (prev != null && pick === prev + 1 ? 5 : 0) - Math.min(3, (pick - from) * 0.05);
    marks.push(pick);
    from = pick + 1;
  }
  return { score, marks };
}

// The items that match, best first. keys: [[field, weight]]; each result
// carries the marks per field, for highlighting.
export function fuzzySearch(items, query, keys) {
  const q = String(query || '').trim();
  if (!q) return items.map((item) => ({ item, score: 0, marks: {} }));
  const out = [];
  items.forEach((item, order) => {
    let best = null;
    const marks = {};
    for (const [key, weight] of keys) {
      const m = fuzzyMatch(q, item[key]);
      if (!m) continue;
      marks[key] = m.marks;
      const s = m.score * weight;
      if (!best || s > best) best = s;
    }
    if (best != null) out.push({ item, score: best, marks, order });
  });
  return out.sort((a, b) => b.score - a.score || a.order - b.order).map(({ item, score, marks }) => ({ item, score, marks }));
}

// Text with the matched letters wrapped in <mark> (escaped). marks are
// UTF-16 positions, so they're counted that way (an emoji is two).
export function highlight(text, marks = []) {
  const esc = (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c);
  const set = new Set(marks);
  let out = '';
  let open = false;
  let pos = 0;
  for (const ch of String(text ?? '')) {
    const on = set.has(pos);
    if (on !== open) { out += on ? '<mark>' : '</mark>'; open = on; }
    out += esc(ch);
    pos += ch.length;
  }
  return open ? out + '</mark>' : out;
}
