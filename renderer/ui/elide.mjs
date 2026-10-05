// Shortening a link's address to fit the status bubble, the way Chrome does:
// the site stays whole and the middle of the rest gives way to "…".
// measure(text) -> width in px. Pure, and .mjs so tests/hud.test.mjs can run it in Node.

const ELLIPSIS = '…';

// Keeps as much of the start and end as fits around a "…".
export function elideMiddle(text, max, measure) {
  if (measure(text) <= max) return text;
  const chars = Array.from(text); // never split an emoji or accented letter
  const cut = (keep) => {
    const front = Math.ceil(keep / 2);
    const back = keep - front;
    return chars.slice(0, front).join('') + ELLIPSIS + (back ? chars.slice(chars.length - back).join('') : '');
  };
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(cut(mid)) <= max) lo = mid; else hi = mid - 1;
  }
  return cut(lo);
}

// https://www.example.com/a/very/long/path?q=1 -> https://www.example.com/a/ve…h?q=1
export function elideUrl(url, max, measure) {
  if (measure(url) <= max) return url;
  const m = /^([a-z][\w+.-]*:\/\/[^/?#]*)(.+)$/i.exec(url);
  if (!m) return elideMiddle(url, max, measure);
  const room = max - measure(m[1]);
  // A long site name gets shortened too, rather than leaving no room for the rest.
  if (room < measure('/a…b?') * 2) return elideMiddle(url, max, measure);
  return m[1] + elideMiddle(m[2], room, measure);
}

// What the bubble shows for an address: readable letters for %-escapes, but
// spaces, invisible characters and right-to-left marks stay escaped, since
// they can make one address look like another.
export function displayUrl(url) {
  let text = String(url || '');
  try { text = decodeURI(text); } catch { /* keep it as it is */ }
  return text.replace(/[\s\u0000-\u001f\u007f-\u009f­؜ᅟᅠ᠎​-‏‪-‮⁠-⁩ㅤ﻿ﾠ]/g, (c) => encodeURIComponent(c));
}
