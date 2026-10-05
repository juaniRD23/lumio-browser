// The profile's theme colors (Settings › Customize profile). Each has a shade
// for dark backgrounds and a deeper one that reads on white (at least 4.5:1);
// /assets/theme.css uses the one for the current appearance.
export const THEME_COLORS = {
  blue: { dark: '#86b7ff', light: '#2563eb' },
  purple: { dark: '#b58cff', light: '#7c3aed' },
  green: { dark: '#7ee2a8', light: '#15803d' },
  orange: { dark: '#ffb86b', light: '#c2410c' },
  pink: { dark: '#ff8fc7', light: '#c8236e' },
  mono: { dark: '#e4e4e7', light: '#27272a' },
};

export const accentFor = (theme) => THEME_COLORS[theme] || THEME_COLORS.blue;

// Makes { dark, light } the accent of an element (usually <html>).
export function setAccent(el, { dark, light }) {
  el.style.setProperty('--accent-dark', dark);
  el.style.setProperty('--accent-light', light);
}
