// Colors that stay the same in light and dark, so Lumio's CSS writes them out
// instead of using a token from renderer/assets/theme.css. Any other hex,
// rgb(), hsl(), white or black in renderer/ui/*.css or renderer/pages/*.css
// fails tests/color-literals.test.mjs. Each entry covers the rules whose
// selector matches `rule`, in the files that match `file` (any file without one).
export const ALLOWED = [
  { why: 'Incognito is always dark (the site info’s Incognito chip only shows there)', rule: /incog|^\.si-host em$/ },
  { why: 'The screen glow and its Stop pill are a fixed dark overlay (aura.html is always dark)', file: /ui\/aura\.css$/, rule: /./ },
  { why: 'The Update button is the same blue in both (update.e2e checks it)', file: /ui\/shell\.css$/, rule: /^\.update-btn\b/ },
  { why: 'The thinking-effort slider is a picture: white stars on deep blues', file: /ui\/shell\.css$/, rule: /^\.slider \.s-(fill|knob)$/ },
  { why: 'The voice orb is a lit sphere', file: /ui\/shell\.css$/, rule: /^\.voice-bar \.vb-orb i$/ },
  { why: 'Recording red, with white on it', file: /ui\/shell\.css$/, rule: /^\.(mic-btn|voice-bar \.vb-mute)\.on$/ },
  { why: 'Dark buttons that sit on pictures', file: /ui\/shell\.css$/, rule: /^\.(att \.x|made-img \.acts button)$/ },
  { why: 'White on fixed fills: app and browser logos, file-type chips, switch knobs', rule: /\.logo$|^\.ficon$|^\.switch i::after$/ },
  { why: 'An avatar’s initial: avatar colors are pastels in both', rule: /(^| )\.avatar$/ },
  { why: 'The faint edge around a color swatch', file: /pages\/settings\.css$/, rule: /^\.swatch$/ },
  { why: 'The select arrow is an image, which can’t read tokens, so there’s one per appearance', file: /pages\/settings\.css$/, rule: /^:root/ },
  { why: 'A picture of the macOS Keychain dialog, in its own light and dark colors', file: /pages\/welcome\.css$/, rule: /^\.mock\b/ },
];
