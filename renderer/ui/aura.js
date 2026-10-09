// The Stop bar shown over the page while Lumio works in the browser (see
// main/ai/indicators.js).
import { markSvg } from './icons.js';

const $ = (s) => document.querySelector(s);
const api = window.lumio;
const mode = new URLSearchParams(location.search).get('mode') || 'bar';
document.body.classList.add(mode);

if (mode === 'bar') {
  const pill = $('#pill');
  pill.hidden = false;
  $('#mark').innerHTML = markSvg(16);
  $('#stop').addEventListener('click', () => {
    $('#stop').disabled = true;
    api?.send('ai:stop');
  });
  // Tell main how big the bar is, so the view around it fits it.
  const report = () => {
    const r = pill.getBoundingClientRect();
    api?.send('aura:size', { width: Math.ceil(r.width), height: Math.ceil(r.height) });
  };
  new ResizeObserver(report).observe(pill);
  document.fonts.ready.then(report);
}

api?.on('aura', (d = {}) => {
  if (typeof d.label === 'string') $('#step').textContent = d.label;
  if (d.reset) $('#stop').disabled = false;
});
