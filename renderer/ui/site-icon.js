// The security icon in front of an address, in the window's address bar and
// a pop-up's bar: the lock; "Not secure" in red on a certificate warning, or
// a site you went past one for; a warning on plain http; a globe otherwise.
// words: say "Not secure" on plain http too (a pop-up's bar is all it has).
import { icons } from './icons.js';

export function paintSiteIcon(el, t, { words = false } = {}) {
  el.classList.remove('insecure', 'danger', 'clickable');
  el.setAttribute('aria-label', 'View site information');
  const url = t?.url || '';
  if (url && t.notSecure) {
    el.innerHTML = `${icons.warn}<span>Not secure</span>`;
    el.classList.add('danger', 'clickable');
    el.title = "Your connection to this site isn't private · View site information";
    el.setAttribute('aria-label', 'Not secure. View site information');
  } else if (url.startsWith('https:')) {
    el.innerHTML = icons.lock;
    el.title = 'Connection is secure · View site information';
    el.classList.add('clickable');
  } else if (url.startsWith('http:')) {
    el.innerHTML = words ? `${icons.warn}<span>Not secure</span>` : icons.warn;
    el.classList.add('insecure', 'clickable');
    el.title = 'Not secure · View site information';
    el.setAttribute('aria-label', 'Not secure. View site information');
  } else {
    el.innerHTML = icons.globe;
    el.title = '';
  }
}
