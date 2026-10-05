// The bar over the page when a site asks for a permission ("example.com wants
// to use your camera" · Block · Allow), in the window and in a pop-up. Asks
// wait in line; main cancels one whose page went away.
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
    text.append(b, ` wants to ${p.label}`);
  }
  bar.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const p = queue[0];
    if (!act || !p) return;
    api.send('permission:respond', { id: p.id, allow: act === 'allow', remember: true });
    queue.shift();
    render();
  });
  api.on('permission', (p) => { queue.push(p); render(); });
  api.on('permission-cancel', ({ id }) => {
    const i = queue.findIndex((p) => p.id === id);
    if (i >= 0) { queue.splice(i, 1); render(); }
  });
}
