// "Name this window": a small box the overlay draws over the top of the page
// (main/window-name.js opens it). Enter saves, Esc or Cancel closes it, and
// so does clicking back into the page. An empty name goes back to the usual title.
const api = window.lumio;
const card = document.getElementById('card');
const MAX = 80; // as main/window-name.js

const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = 'name-window.css';
document.head.append(css);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let open = false;
let answered = false;

function answer(payload) {
  if (!open || answered) return;
  answered = true;
  api.send('window:name', payload);
}

api.on('overlay-data', (payload) => {
  if (payload?.op && payload.op !== 'show') return; // overlay.js's steps in and out
  open = payload?.kind === 'namewindow';
  document.body.classList.toggle('namewindow', open);
  if (!open) return;
  answered = false;
  const where = payload.mac ? 'the Window menu, Mission Control and the Dock' : 'the taskbar and when you switch windows';
  card.innerHTML = `<form class="nw" role="dialog" aria-modal="true" aria-labelledby="nw-title" aria-describedby="nw-hint">
      <div class="pws-title" id="nw-title">Name this window</div>
      <label class="pws-field"><span id="nw-hint">Shown in ${where}.</span>
        <input id="nw-name" type="text" maxlength="${MAX}" value="${esc(payload.name)}" placeholder="Like “Work” or “Trip planning”" spellcheck="false" autocomplete="off"></label>
      <div class="pws-actions">
        <span style="flex:1"></span>
        <button type="button" class="acc-btn ghost" data-nw="cancel">Cancel</button>
        <button type="submit" class="acc-btn primary">Save</button>
      </div>
    </form>`;
  const input = card.querySelector('#nw-name');
  input.focus();
  input.select();
  // The box is as tall as what's in it, like the other popups.
  document.fonts.ready.then(() => requestAnimationFrame(() => {
    if (!open) return;
    card.style.height = 'auto';
    const h = card.getBoundingClientRect().height;
    card.style.height = '';
    api.send('overlay:size', { height: Math.ceil(h) + 2 + 22 });
  }));
  card.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); answer({ name: input.value }); });
  card.querySelector('[data-nw=cancel]').addEventListener('click', () => answer({ cancel: true }));
});

// The overlay's own handler turns presses into dropdown picks; this box
// needs normal clicks (placing the cursor, pressing its buttons).
document.addEventListener('mousedown', (e) => { if (open) e.stopPropagation(); }, true);
document.addEventListener('keydown', (e) => {
  if (open && e.key === 'Escape') { e.preventDefault(); answer({ cancel: true }); }
});
// Clicking back into the page (or another app) closes it, like a menu.
window.addEventListener('blur', () => { if (open) answer({ cancel: true, blur: true }); });
