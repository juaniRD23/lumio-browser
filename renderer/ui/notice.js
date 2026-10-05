// "Press Esc to exit full screen" / "Press Esc to show your cursor", over a
// page that took the whole screen or hid the pointer (main/access-notice.js
// shows this view and takes it away). It only shows; Esc itself is Chromium's.
const api = window.lumio;
const $ = (s) => document.querySelector(s);
const bubble = $('#bubble');

// Main sizes the view to the bubble.
function report() {
  if (bubble.hidden) return;
  const r = bubble.getBoundingClientRect();
  api.send('notice:size', { width: Math.ceil(r.width), height: Math.ceil(r.height) });
}

function render(d) {
  bubble.hidden = !d;
  if (!d) return;
  $('#n-title').textContent = d.title || '';
  $('#n-what').textContent = d.action || '';
  // Each notice gets its full four seconds: start the animation over.
  bubble.style.animation = 'none';
  void bubble.offsetWidth;
  bubble.style.animation = '';
  report();
}

new ResizeObserver(report).observe(bubble);
document.fonts.ready.then(report);
api.on('notice-data', render);
