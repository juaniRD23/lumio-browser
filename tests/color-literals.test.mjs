// Light and dark come from the color tokens in renderer/assets/theme.css, and
// a color written straight into the browser's CSS only looks right in one of
// them. This fails on any hex, rgb(), hsl(), white or black in renderer/ui and
// renderer/pages stylesheets unless tests/color-literals.allow.mjs lists it as
// a color that stays the same in both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED } from './color-literals.allow.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['renderer/ui', 'renderer/pages'].flatMap((dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.css')).map((f) => `${dir}/${f}`));
// %23 is # inside a data: URL.
const COLOR = /(?:#|%23)(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?)\([^)]*\)|\b(?:white|black)\b/gi;

// A rule's declarations: its body split at semicolons outside quotes and
// brackets (a data: URL has semicolons of its own).
function declarations(body) {
  const out = [''];
  let quote = null;
  let depth = 0;
  for (const ch of body) {
    if (quote) { if (ch === quote) quote = null; } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && !depth) { out.push(''); continue; }
    out[out.length - 1] += ch;
  }
  return out;
}

// Every color written out in a stylesheet's declarations (selectors like
// #add-tabs aren't colors), with the rule and property it's in.
function literals(css) {
  const found = [];
  for (const [, prelude, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const rule = prelude.split(';').pop().trim().replace(/\s+/g, ' ');
    for (const decl of declarations(body)) {
      const colon = decl.indexOf(':');
      const property = decl.slice(0, colon).trim();
      // A mask's color only sets how much shows through.
      if (colon < 0 || /^(-webkit-)?mask/.test(property)) continue;
      for (const [color] of decl.slice(colon + 1).matchAll(COLOR)) found.push({ rule, property, color });
    }
  }
  return found;
}

test('finds colors in values and data: URLs, not in selectors or masks', () => {
  const css = `@import url('/assets/theme.css');
    #add-tabs, .bed:hover { color: var(--text); }
    @media (prefers-color-scheme: light) { .a { mask-image: linear-gradient(#000, transparent); --arrow: url("data:image/svg+xml;utf8,<svg stroke='%23999'/>"); border: 1px solid rgba(0, 0, 0, .2) } }
    /* #fff in a comment */ .b { background: white }`;
  assert.deepEqual(literals(css).map((l) => `${l.rule} ${l.property} ${l.color}`), ['.a --arrow %23999', '.a border rgba(0, 0, 0, .2)', '.b background white']);
});

test('the browser’s CSS uses color tokens, apart from colors that stay the same in light and dark', () => {
  const used = new Set();
  const loose = [];
  for (const file of FILES) {
    for (const l of literals(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      const entry = ALLOWED.find((e) => (!e.file || e.file.test(file)) && e.rule.test(l.rule));
      if (entry) used.add(entry);
      else loose.push(`${file}: ${l.rule} { ${l.property}: ${l.color} }`);
    }
  }
  assert.deepEqual(loose, [], 'Use a token from renderer/assets/theme.css (add one there if none fits). A color that really stays the same in light and dark goes in tests/color-literals.allow.mjs, with why.');
  assert.deepEqual(ALLOWED.filter((e) => !used.has(e)).map((e) => e.why), [], 'allowed colors that no longer appear: remove them from tests/color-literals.allow.mjs');
});
