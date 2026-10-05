// Inline SVG icons (1.6px strokes, currentColor) and the Lumio mark.
const s = (d, extra = '') => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;

export const icons = {
  back: s('<path d="M15 18l-6-6 6-6"/>'),
  forward: s('<path d="M9 18l6-6-6-6"/>'),
  reload: s('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  stop: s('<path d="M6 6l12 12M18 6L6 18"/>'),
  plus: s('<path d="M12 5v14M5 12h14"/>'),
  close: s('<path d="M7 7l10 10M17 7L7 17"/>', 'width="14" height="14"'),
  star: s('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>', 'width="16" height="16"'),
  starFilled: s('<path fill="currentColor" d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>', 'width="16" height="16"'),
  download: s('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  lock: s('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 'width="14" height="14"'),
  warn: s('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>', 'width="14" height="14"'),
  search: s('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>', 'width="15" height="15"'),
  globe: s('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/>', 'width="15" height="15"'),
  clock: s('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 'width="15" height="15"'),
  moon: s('<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>', 'width="13" height="13"'),
  up: s('<path d="M6 15l6-6 6 6"/>', 'width="15" height="15"'),
  down: s('<path d="M6 9l6 6 6-6"/>', 'width="15" height="15"'),
  send: s('<path d="M12 19V5M6 11l6-6 6 6"/>', 'stroke-width="2.1"'),
  square: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>',
  chats: s('<path d="M4 5h16v11H9l-5 4z"/>', 'width="16" height="16"'),
  compose: s('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', 'width="16" height="16"'),
  expand: s('<path d="M14 4h6v6"/><path d="M20 4l-7 7"/><path d="M10 20H4v-6"/><path d="M4 20l7-7"/>', 'width="15" height="15"'),
  shrink: s('<path d="M4 14h6v6"/><path d="M10 14l-7 7"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/>', 'width="15" height="15"'),
  panel: s('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/>', 'width="16" height="16"'),
  volume: s('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9a4 4 0 0 1 0 6"/>', 'width="13" height="13"'),
  muted: s('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l4 6M21 9l-4 6"/>', 'width="13" height="13"'),
  check: s('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 'width="14" height="14"'),
  x: s('<path d="M7 7l10 10M17 7L7 17"/>', 'width="14" height="14"'),
  copy: s('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>', 'width="14" height="14"'),
  trash: s('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>', 'width="14" height="14"'),
  workflow: s('<path d="M4 6.5h9M4 12h6M4 17.5h9"/><path d="M15.5 9.5 21 13l-5.5 3.5z"/>', 'width="15" height="15"'),
  helpers: s('<circle cx="12" cy="7" r="3"/><circle cx="5.5" cy="16" r="2.5"/><circle cx="18.5" cy="16" r="2.5"/><path d="M10 9.5 7 13.8M14 9.5l3 4.3M8 16h8"/>', 'width="15" height="15"'),
  shield: s('<path d="M12 3.5l7 3v5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9v-5z"/><path d="M9 12l2 2 4-4"/>', 'width="15" height="15"'),
  bolt: s('<path d="M13 3L5 13.5h6L10.5 21 19 10.5h-6z"/>', 'width="15" height="15"'),
  mic: s('<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>', 'width="17" height="17"'),
  wave: s('<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3"/>', 'width="17" height="17"'),
  play: s('<rect x="3" y="5.5" width="18" height="13" rx="3.5"/><path d="M10.5 9.5v5l4-2.5z" fill="currentColor"/>'),
  page: s('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>', 'width="13" height="13"'),
  cursor: s('<path d="M5 3l14 7-6 1.5L10.5 18z"/>', 'width="14" height="14"'),
  keyboard: s('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>', 'width="14" height="14"'),
  eye: s('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>', 'width="14" height="14"'),
  terminal: s('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15H17"/>', 'width="14" height="14"'),
  tabs: s('<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M8 6V4h8v2"/>', 'width="14" height="14"'),
  mac: s('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>', 'width="14" height="14"'),
  scroll: s('<path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/>', 'width="14" height="14"'),
  app: s('<rect x="4" y="4" width="16" height="16" rx="4"/>', 'width="14" height="14"'),
  puzzle: s('<path d="M9 4.5a2 2 0 0 1 4 0V6h4a1 1 0 0 1 1 1v4h-1.5a2 2 0 0 0 0 4H18v4a1 1 0 0 1-1 1h-4v-1.5a2 2 0 0 0-4 0V20H5a1 1 0 0 1-1-1v-4h1.5a2 2 0 0 0 0-4H4V7a1 1 0 0 1 1-1h4z"/>', 'width="16" height="16"'),
  incognito: s('<path d="M3 11.5h18"/><path d="M6 11.5l1.8-6.2a1 1 0 0 1 1.3-.7L12 5.5l2.9-.9a1 1 0 0 1 1.3.7L18 11.5"/><circle cx="7.5" cy="16.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/><path d="M10 16.2c1.3-.8 2.7-.8 4 0"/>', 'width="15" height="15"'),
  pin: s('<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 14v6"/>', 'width="12" height="12"'),
  info: s('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>', 'width="14" height="14"'),
  folder: s('<path d="M3.5 6.5a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/>', 'width="14" height="14"'),
  more: s('<path d="M7 7l5 5-5 5M13 7l5 5-5 5"/>', 'width="13" height="13"'),
  // The ⋮ menu's rows (renderer/ui/overlay.js renderMenu).
  minus: s('<path d="M5 12h14"/>'),
  window: s('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9h17"/>', 'width="16" height="16"'),
  print: s('<path d="M7 9V4.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v5.5H7z"/>', 'width="16" height="16"'),
  tools: s('<rect x="3.5" y="8" width="17" height="11" rx="2"/><path d="M9 8V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3.5 13h17M12 12v2"/>', 'width="16" height="16"'),
  fullscreen: s('<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>', 'width="16" height="16"'),
  key: s('<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5L19 4M15.5 7.5l2.5 2.5M13.5 9.5l2 2"/>', 'width="16" height="16"'),
  person: s('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c1.2-3.3 3.9-5 7-5s5.8 1.7 7 5"/>', 'width="16" height="16"'),
  brush: s('<path d="M14.5 4.5l5 5-8 8H6.5v-5z"/><path d="M12 7l5 5"/>', 'width="16" height="16"'),
  gauge: s('<path d="M4.5 17a8 8 0 1 1 15 0"/><path d="M12 13l3.5-4"/>', 'width="16" height="16"'),
  gear: s('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M4.6 7.2l1.9 1.1M17.5 15.7l1.9 1.1M4.6 16.8l1.9-1.1M17.5 8.3l1.9-1.1"/><circle cx="12" cy="12" r="6.3"/>', 'width="16" height="16"'),
  logout: s('<path d="M14 5H6.5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1H14"/><path d="M11 12h9M17 8.5l3.5 3.5-3.5 3.5"/>', 'width="16" height="16"'),
  external: s('<path d="M14 5h5v5M19 5l-8 8"/><path d="M17 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5"/>', 'width="13" height="13"'),
  update: s('<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>', 'width="14" height="14" stroke-width="2"'),
  spinner: s('<path d="M20 12a8 8 0 1 1-8-8"/>', 'width="14" height="14" stroke-width="2"'),
  list: s('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 6l1.2 1.2L7 5M3.5 12l1.2 1.2L7 11"/><circle cx="5" cy="18" r="1.3"/>', 'width="16" height="16"'),
  stepDone: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="currentColor"/><path d="M6.3 10.3l2.4 2.4 5-5.2" fill="none" stroke="var(--panel)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stepNow: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path class="pie" d="M10 5.2A4.8 4.8 0 0 1 14.8 10H10z" fill="currentColor"/></svg>',
  stepTodo: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.6 2.4"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="5.5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="18.5" r="1.7" fill="currentColor"/></svg>',
};

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The round avatar on the account button and in its menu.
export function avatarHtml({ profile = {}, account = {}, incognito = false, size = 26 } = {}) {
  const box = `width:${size}px;height:${size}px`;
  if (incognito) return `<span class="avatar incog" style="${box}">${icons.incognito}</span>`;
  if (typeof profile.photo === 'string' && profile.photo.startsWith('data:image/')) {
    return `<span class="avatar" style="${box}"><img src="${escapeHtml(profile.photo)}" alt=""></span>`;
  }
  const name = (profile.name || account.name || account.email || '').trim();
  const letter = name ? escapeHtml([...name][0].toUpperCase()) : icons.person;
  // The avatar colors are pastels in both modes (the letter stays dark); blue is the default.
  const color = /^#[0-9a-f]{6}$/i.test(profile.color || '') ? profile.color : '#86b7ff';
  return `<span class="avatar" style="${box};background:${color};font-size:${Math.round(size * 0.46)}px">${letter}</span>`;
}

// Signal-style bars for the reasoning level (1 = low, 2 = medium, 3 = high).
export const levelBars = (n, size = 14) => `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${[0, 1, 2].map((i) => `<rect x="${1.5 + i * 5}" y="${10 - i * 4}" width="3.2" height="${4.5 + i * 4}" rx="1" fill="currentColor" opacity="${i < n ? 1 : 0.28}"/>`).join('')}</svg>`;

// The Lumio mark (lumio-usa.online's favicon), drawn in the text color so it
// shows on light and dark backgrounds; `blue` gives its dot the accent color.
export const markSvg = (size = 18, blue = false) => `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true"><path d="M35 12a21 21 0 1 0 17 19" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><circle cx="48" cy="17" r="5" fill="currentColor"${blue ? ' style="fill:var(--accent)"' : ''}/></svg>`;

// Model maker logos (Simple Icons, CC0), keyed by the "maker" in main/ai/models.js.
const brand = (d, color) => (size = 14) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${color}" aria-hidden="true" class="brand"><path d="${d}"/></svg>`;
export const makerLogos = {
  Anthropic: brand("m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z", "#d97757"),
  OpenAI: brand("M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z", "currentColor"),
};
