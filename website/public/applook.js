// Logos for connected apps (simple brand-colored tiles), shared by Chat and
// the account page.
export const GLYPH = {
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.5 19a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18.4 9.1 5 5 0 0 1 17.5 19z"/></svg>',
  drive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M8.5 3.5h7l6 10.5-3.5 6h-12L2.5 14z"/><path d="M8.5 3.5 15 14H2.5M15.5 3.5 9 14l3 6"/></svg>',
};
export const APP_LOOK = {
  google_drive: ['#1E8E3E', GLYPH.drive], gmail: ['#D93025', GLYPH.mail], google_calendar: ['#1A73E8', GLYPH.cal],
  outlook: ['#0F6CBD', GLYPH.mail], outlook_calendar: ['#0F6CBD', GLYPH.cal], onedrive: ['#0364B8', GLYPH.cloud],
  word: ['#185ABD', 'W'], powerpoint: ['#C43E1C', 'P'], excel: ['#107C41', 'X'],
};
export const appLogo = (id) => { const [bg, g] = APP_LOOK[id] || ['#444', '?']; return `<span class="logo" style="background:${bg}">${g}</span>`; };
