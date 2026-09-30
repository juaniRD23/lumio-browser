chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  document.getElementById('title').textContent = `Active tab: ${tabs[0]?.title || 'unknown'}`;
});
document.getElementById('open').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-tab', url: 'https://example.com/' }));
