// Lists on Lumio's pages (downloads, history, bookmarks) change in place: rows
// that stay are updated, not rebuilt, so focus, hover and selection survive;
// new rows rise in and removed rows fold away (pages.css .enter / .leaving).

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.hasAttribute('data-reduce-motion');

// Makes `from` look like `to`, keeping the elements that are still there.
function morph(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) { from.replaceWith(to); return; }
  if (from.nodeType === Node.TEXT_NODE) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return; }
  if (from.nodeType !== Node.ELEMENT_NODE) return;
  for (const a of [...from.attributes]) if (!to.hasAttribute(a.name) && a.name !== 'data-key') from.removeAttribute(a.name);
  for (const a of to.attributes) if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
  const a = [...from.childNodes];
  const b = [...to.childNodes];
  b.forEach((n, i) => { if (a[i]) morph(a[i], n); else from.append(n); });
  a.slice(b.length).forEach((n) => n.remove());
}

const drawn = new WeakMap(); // row -> the HTML it was drawn from

const build = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

// Fades a row away, then removes it; the rows below slide up into its place
// (FLIP: they're moved with transforms, not by animating its height).
export function leave(el) {
  if (!el || el.classList.contains('leaving')) return Promise.resolve();
  if (reduced() || !el.isConnected) { el.remove(); return Promise.resolve(); }
  el.classList.add('leaving');
  el.inert = true;
  return new Promise((done) => {
    let gone = false;
    const end = () => {
      if (gone) return;
      gone = true;
      const below = [];
      for (let n = el.nextElementSibling; n && below.length < 40; n = n.nextElementSibling) below.push([n, n.getBoundingClientRect().top]);
      el.remove();
      for (const [n, top] of below) {
        const dy = top - n.getBoundingClientRect().top;
        if (dy) n.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      }
      done();
    };
    el.addEventListener('animationend', end, { once: true });
    setTimeout(end, 400); // in case no animation runs
  });
}

// Shows `entries` ([{ key, html }]) in `box`, changing only what differs.
// The first call (or { animate: false }) draws without motion.
export function patchList(box, entries, { animate = box.dataset.drawn === '1' } = {}) {
  const old = new Map();
  for (const el of box.children) if (el.dataset.key && !el.classList.contains('leaving')) old.set(el.dataset.key, el);
  // Anything not drawn by patchList (a first innerHTML) is replaced.
  for (const el of [...box.children]) if (!el.dataset.key) el.remove();
  let prev = null;
  for (const { key, html } of entries) {
    let el = old.get(key);
    if (el) {
      old.delete(key);
      if (drawn.get(el) !== html) {
        const entering = el.classList.contains('enter');
        morph(el, build(html));
        el.classList.toggle('enter', entering);
        drawn.set(el, html);
      }
    } else {
      el = build(html);
      el.dataset.key = key;
      drawn.set(el, html);
      if (animate && !reduced()) {
        el.classList.add('enter');
        el.addEventListener('animationend', () => el.classList.remove('enter'), { once: true });
      }
    }
    const at = prev ? prev.nextSibling : box.firstChild;
    if (at !== el) box.insertBefore(el, at);
    prev = el;
  }
  for (const el of old.values()) (animate ? leave(el) : el.remove());
  box.dataset.drawn = '1';
}
