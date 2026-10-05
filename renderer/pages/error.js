import '/assets/ui-prefs.js';
const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const code = params.get('code') || '';
const desc = params.get('desc') || '';
const TITLES = {
  '-105': "This site can't be reached",
  '-106': "You're offline",
  '-102': 'The site refused to connect',
  '-118': 'The connection timed out',
  '-137': "This site can't be reached",
  '-200': "This site's security certificate isn't valid",
  '-201': "This site's certificate has expired or isn't valid yet",
  '-202': "This site's security certificate isn't trusted",
  '-310': 'This page redirects too many times',
  crashed: 'This tab crashed',
  hung: 'This page stopped responding', // you chose "Exit page"
};
document.getElementById('title').textContent = TITLES[code] || "This page couldn't load";
document.title = TITLES[code] || "Can't open this page";
document.getElementById('url').textContent = url;
document.getElementById('code').textContent = code === 'crashed' ? `(${desc})` : desc;
// A crashed tab (Chrome's sad tab): a sad face, and Reload goes back to the
// page that crashed, in its place in the tab's history (main/sad-tab.js).
const crashed = code === 'crashed';
if (crashed) {
  document.getElementById('sad').hidden = false;
  document.getElementById('plain').hidden = true;
  document.getElementById('why').hidden = false;
  document.getElementById('retry').textContent = 'Reload';
}
document.getElementById('retry').addEventListener('click', async () => {
  if (crashed && await window.lumioPage.invoke('page:reload-crashed').catch(() => false)) return;
  if (url) window.lumioPage.invoke('page:navigate', url);
});
