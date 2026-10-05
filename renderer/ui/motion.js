// Motion for the browser UI (shell and overlay). Durations and curves are the
// tokens in /assets/theme.css (--dur-1…5, --ease-out/in/in-out/spring), so
// script animations move like the CSS ones. With Reduce Motion on, nothing
// moves: CSS transitions finish at once (theme.css) and these skip theirs.
const media = matchMedia('(prefers-reduced-motion: reduce)');
// (Or Settings › Accessibility › Reduce motion in Lumio: main/accessibility.js.)
export const reduced = () => media.matches || document.documentElement.hasAttribute('data-reduce-motion');

const tokens = new Map();
function token(name) {
  if (!tokens.has(name)) tokens.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  return tokens.get(name);
}
// --dur-1…5, in milliseconds.
export const dur = (step) => parseFloat(token(`--dur-${step}`)) || 0;
// --ease-out, --ease-in, --ease-in-out or --ease-spring.
export const ease = (name) => token(`--ease-${name}`) || 'ease';

// A Web Animation on the shared tokens: duration is a --dur step, easing an
// --ease name. Returns null (and does nothing) with Reduce Motion on.
export function animate(el, keyframes, { duration = 3, easing = 'out', ...opts } = {}) {
  if (!el || reduced()) return null;
  return el.animate(keyframes, { duration: dur(duration), easing: ease(easing), ...opts });
}

// Stops an element's animation by id (see slide), leaving it where its
// layout puts it.
export function cancel(el, id) {
  for (const a of el.getAnimations()) if (a.id === id) a.cancel();
}

// FLIP: an element that moved in the layout glides from where it was on
// screen (dx px to the side) to its new place.
export function slide(el, dx, opts = {}) {
  cancel(el, 'slide');
  return animate(el, [{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { id: 'slide', ...opts });
}

// Makes a change without the CSS transitions of these elements and what's in
// them: a tab switch swaps the toolbar at once, like the page it shows.
export function instantly(els, change) {
  for (const el of els) el.classList.add('instant');
  try {
    change();
  } finally {
    els[0]?.getBoundingClientRect(); // styles settle while transitions are off
    for (const el of els) el.classList.remove('instant');
  }
}
