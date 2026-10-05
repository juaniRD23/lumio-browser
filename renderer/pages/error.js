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
};
document.getElementById('title').textContent = TITLES[code] || "This page couldn't load";
document.title = TITLES[code] || "Can't open this page";
document.getElementById('url').textContent = url;
document.getElementById('code').textContent = code === 'crashed' ? `(${desc})` : desc;
document.getElementById('retry').addEventListener('click', () => {
  if (url) window.lumioPage.invoke('page:navigate', url);
});
