// "Send crash reports to Lumio" (off by default): the switch in Settings ›
// Privacy and on the last welcome screen (main/crash-reports.js). Turning it
// on starts with the next launch, because crash reporting has to start with
// the app; turning it off stops reports right away.
const page = window.lumioPage;
const box = document.getElementById('crash-reports');
const note = document.getElementById('crash-note');

function show(st) {
  box.checked = !!st.on;
  note.textContent = st.on && !st.active ? 'Starts the next time you open Lumio.'
    : !st.on && st.active ? 'Off. Lumio won’t send any more reports.' : '';
}

if (box) {
  const st = await page.invoke('page:crash-reports').catch(() => null);
  if (st) show(st);
  box.addEventListener('change', async () => {
    const next = await page.invoke('page:set-crash-reports', box.checked).catch(() => null);
    if (next) show(next);
  });
}
