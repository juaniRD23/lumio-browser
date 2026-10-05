// Settings › Accessibility (main/accessibility.js). A change applies to the
// window, its menus and Lumio's pages at once, this one included.
import { applyUiPrefs } from '/assets/ui-prefs.js';

const page = window.lumioPage;
const boxes = [...document.querySelectorAll('[data-a11y]')];

function show(p) {
  for (const b of boxes) b.checked = !!p?.[b.dataset.a11y];
}
show(await page.invoke('page:accessibility').catch(() => null));
for (const b of boxes) {
  b.addEventListener('change', async () => {
    const p = await page.invoke('page:accessibility-set', b.dataset.a11y, b.checked);
    show(p);
    applyUiPrefs(p); // without waiting for the broadcast
  });
}
page.on('ui-prefs', show);
