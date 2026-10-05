// The bar over the page when a site asks for a permission ("example.com wants
// to use your camera" · Block · Allow) in a pop-up window, which has no
// address bar chip (the browser window uses renderer/ui/permission-chip.js).
// Asks wait in line; main cancels one whose page went away. Requests come
// from main/features.js Permissions: { id, host, cats: [{ prompt }] }.
export function initPermBar(bar, api) {
  const queue = [];
  function render() {
    const p = queue[0];
    bar.hidden = !p;
    if (!p) return;
    const text = bar.querySelector('.infobar-text');
    text.textContent = '';
    const b = document.createElement('b');
    b.textContent = p.host;
    const what = (p.cats || []).map((c) => String(c.prompt || '').toLowerCase()).filter(Boolean).join(' and ');
    text.append(b, ` wants to ${what}`);
  }
  bar.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const p = queue[0];
    if (!act || !p) return;
    api.send('permission:respond', { id: p.id, decision: act === 'allow' ? 'allow' : 'block' });
    queue.shift();
    render();
  });
  // Quiet requests (a site that keeps asking) wait for the person to look, like the chip.
  api.on('permission', (p) => { if (!p.quiet) { queue.push(p); render(); } });
  api.on('permission-cancel', ({ id }) => {
    const i = queue.findIndex((p) => p.id === id);
    if (i >= 0) { queue.splice(i, 1); render(); }
  });
}
