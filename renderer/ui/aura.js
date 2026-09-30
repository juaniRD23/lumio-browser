// The glow, Stop pill and Stop bar shown while Lumio works (see
// main/ai/indicators.js and main/ai/screen-aura.js).
import { markSvg } from './icons.js';

const $ = (s) => document.querySelector(s);
const api = window.lumio;
const mode = new URLSearchParams(location.search).get('mode') || 'glow';
document.body.classList.add(mode);

if (mode === 'pill' || mode === 'bar') {
  const pill = $('#pill');
  pill.hidden = false;
  $('#mark').innerHTML = markSvg(16);
  $('#title').textContent = mode === 'pill' ? 'Lumio is controlling your computer' : 'Lumio is working';
  $('#stop').addEventListener('click', () => {
    $('#stop').disabled = true;
    api?.send(mode === 'pill' ? 'aura:stop' : 'ai:stop');
  });
  // Tell main how big the pill is, so the window/view around it fits it.
  const report = () => {
    const r = pill.getBoundingClientRect();
    api?.send('aura:size', { width: Math.ceil(r.width), height: Math.ceil(r.height) });
  };
  new ResizeObserver(report).observe(pill);
  document.fonts.ready.then(report);
}

api?.on('aura', (d = {}) => {
  if (typeof d.label === 'string') $('#step').textContent = d.label;
  if (d.reset) { $('#stop').disabled = false; document.body.classList.remove('out'); }
  if (d.out) document.body.classList.add('out');
});
