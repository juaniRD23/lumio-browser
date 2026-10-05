// Color helpers for the headless light and dark tests (shell.test.mjs,
// pages-theme.test.mjs). Colors are [r, g, b].

// Relative luminance: 0 is black, 1 is white.
export const luminance = (rgb) => rgb
  .map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);

// WCAG contrast of two colors, from 1 (same) to 21 (black on white).
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// A page's colors as they end up on screen: `tokens` resolved for its
// appearance, and what shows behind each of `parts` (see-through parts show
// their parents; parts the page doesn't have are left out).
export const readColors = (page, { tokens = [], parts = [] }) => page.evaluate(({ tokens, parts }) => {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  // Paints colors over each other and reads the pixel, so any CSS color, and
  // any stack of see-through ones, comes out as [r, g, b].
  const paint = (...colors) => {
    ctx.clearRect(0, 0, 1, 1);
    for (const c of colors) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); }
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  };
  const probe = document.body.appendChild(document.createElement('i')); // inside body, which incognito recolors
  const token = (name) => { probe.style.color = `var(${name})`; return paint(getComputedStyle(probe).color); };
  const behind = (el) => { const layers = []; for (; el; el = el.parentElement) layers.unshift(getComputedStyle(el).backgroundColor); return paint(...layers); };
  const found = parts.map((p) => [p, document.querySelector(p)]).filter(([, el]) => el);
  const out = { tokens: Object.fromEntries(tokens.map((t) => [t, token(t)])), parts: Object.fromEntries(found.map(([p, el]) => [p, behind(el)])) };
  probe.remove();
  return out;
}, { tokens, parts });
