// lumio://version: Lumio's version and what it's built on, like chrome://version.
import './keys.js';
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const v = await page.invoke('page:version-info');
const rows = [
  [v.name, `${v.version}${v.beta ? ' (Beta)' : ''}`],
  ['Chromium', v.chromium],
  ['Electron', v.electron],
  ['V8', v.v8],
  ['Node.js', v.node],
  ['System', v.os],
  ['User agent', v.userAgent],
  ['Executable path', v.executable],
  ['Profile path', v.profile],
  ['Command line', v.commandLine],
];
$('#info').innerHTML = rows.map(([k, val]) => `<div class="kv"><span>${esc(k)}</span><code>${esc(val)}</code></div>`).join('');

$('#copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(rows.map(([k, val]) => `${k}: ${val}`).join('\n'));
    $('#copy').textContent = 'Copied';
    setTimeout(() => { $('#copy').textContent = 'Copy'; }, 1600);
  } catch { /* nothing to copy into */ }
});
$('#notes').addEventListener('click', () => page.invoke('page:open', v.notesUrl, 'tab'));
