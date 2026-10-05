// The "Pop-up blocked" icon in an address bar (the window's and a pop-up's).
// It shows while the page has blocked pop-ups, says so in words for a moment
// when a new one is blocked, and opens the list (overlay kind 'popups'):
// open one, or always allow the site.
import { icons } from './icons.js';

const FRESH_MS = 4000;

export function popupsButton(btn, api) {
  btn.innerHTML = `${icons.popupBlocked}<span class="label">Pop-up blocked</span>`;
  btn.title = 'Pop-ups were blocked on this page';
  btn.setAttribute('aria-label', 'Pop-ups were blocked on this page');
  let seen = { id: null, count: 0 };
  let timer = 0;
  return {
    // t: the tab on screen, from the 'tabs' state.
    render(t) {
      const count = t?.popupsBlocked || 0;
      btn.hidden = !count;
      if (t?.id !== seen.id || !count) btn.classList.remove('fresh');
      else if (count > seen.count) {
        btn.classList.add('fresh');
        clearTimeout(timer);
        timer = setTimeout(() => btn.classList.remove('fresh'), FRESH_MS);
      }
      seen = { id: t?.id ?? null, count };
    },
    // Opens the list under the button. Resolves false when there's nothing to list.
    async show() {
      const info = await api.invoke('site:popups');
      if (!info) return false;
      const r = btn.getBoundingClientRect();
      const width = 340;
      api.send('overlay:show', {
        rect: { x: Math.max(0, r.right - width - 12 + 8), y: r.bottom + 6, width: width + 24, height: 190 + info.items.length * 34 },
        payload: { kind: 'popups', focus: true, ...info },
      });
      return true;
    },
  };
}
