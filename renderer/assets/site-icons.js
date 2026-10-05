// Icons for site settings, shared by the browser UI (permission chip and
// bubble, site info) and the Site settings pages. Same style as
// renderer/ui/icons.js: 1.7px strokes in currentColor.
const svg = (d, size) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const PATHS = {
  geolocation: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  camera: '<rect x="3" y="6.5" width="12.5" height="11" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3z"/>',
  microphone: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
  notifications: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  backgroundSync: '<path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3.5v3.6h-3.6M5.5 20.5v-3.6h3.6"/>',
  automaticDownloads: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  protectedContent: '<path d="M12 3.5l7 3v5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9v-5z"/><circle cx="12" cy="10.5" r="2"/><path d="M12 12.5v3.5"/>',
  midi: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M9 12v7M15 12v7M7.5 5v7h3V5M13.5 5v7h3V5"/>',
  usb: '<path d="M12 3v14"/><circle cx="12" cy="19" r="2"/><path d="M12 13l-4-3V7.5M12 11.5l4-3V6.5"/><path d="M6.8 5h2.4v2.4H6.8z"/><circle cx="16" cy="5.3" r="1.2"/>',
  serial: '<path d="M7 8h10v4a5 5 0 0 1-10 0z"/><path d="M10 4v4M14 4v4M12 17v4"/>',
  hid: '<path d="M7 8.5h10a4 4 0 0 1 4 4l-.5 3.2a2.5 2.5 0 0 1-4.3 1.2L15 15.5H9l-1.2 1.4a2.5 2.5 0 0 1-4.3-1.2L3 12.5a4 4 0 0 1 4-4z"/><path d="M8 10.8v3M6.5 12.3h3M15.5 11.5h.01M17.5 13.2h.01"/>',
  bluetooth: '<path d="M7 7.5l10 9-5 4.5V3l5 4.5-10 9"/>',
  fileEditing: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 16.5l5-5 2 2-5 5H9z"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5v-1h6v1M8.5 10h7M8.5 14h5"/>',
  windowManagement: '<rect x="3" y="5" width="11" height="9" rx="1.5"/><rect x="10" y="10" width="11" height="9" rx="1.5"/>',
  idleDetection: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c1.2-3.3 3.9-5 7-5s5.8 1.7 7 5"/>',
  screenShare: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
  javascript: '<path d="M8.5 7.5l-4.5 4.5 4.5 4.5M15.5 7.5l4.5 4.5-4.5 4.5"/>',
  images: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8 8.5"/>',
  popups: '<path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  sound: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>',
  insecureContent: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  siteData: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  thirdPartyCookies: '<path d="M20.5 12.5a8.5 8.5 0 1 1-9-9 3 3 0 0 0 4 3.6 3 3 0 0 0 5 5.4z"/><path d="M8.5 9.5h.01M8 14.5h.01M12.5 13h.01M15.5 16.5h.01"/>',
  pdfDocuments: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 16.5h4"/>',
  autoplay: '<rect x="3" y="5.5" width="18" height="13" rx="3.5"/><path d="M10.5 9.5v5l4-2.5z"/>',
  trackers: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/><path d="M4 20L20 4"/>',
  // Security settings (renderer/pages/security.js)
  shield: '<path d="M12 3.5l7 3v5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9v-5z"/>',
  shieldCheck: '<path d="M12 3.5l7 3v5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9v-5z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  dns: '<rect x="3.5" y="4.5" width="17" height="6" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="6" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  certificate: '<rect x="3.5" y="4.5" width="17" height="12" rx="1.5"/><path d="M7 8.5h10M7 12h5"/><circle cx="16" cy="15.5" r="2.2"/><path d="M14.8 17.3l-.8 3.2 2-1 2 1-.8-3.2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  update: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  puzzle: '<path d="M9 4.5a2 2 0 0 1 4 0V6h4v4h1.5a2 2 0 0 1 0 4H17v4.5H5V14h1.5a2 2 0 0 0 0-4H5V6h4z"/>',
  signal: '<path d="M12 20v-6M8.5 20v-3M15.5 20v-9M19 20V7M5 20v-1"/>',
  network: '<circle cx="12" cy="5.5" r="2"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/><path d="M12 7.5v4.5M12 12l-5.2 4.8M12 12l5.2 4.8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  allSites: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8"/><path d="M17 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5"/>',
};

// An icon by category id (or one of the extras above). blocked adds a slash.
export function siteIcon(id, { size = 18, blocked = false } = {}) {
  return svg((PATHS[id] || PATHS.allSites) + (blocked ? '<path d="M4 4l16 16"/>' : ''), size);
}
