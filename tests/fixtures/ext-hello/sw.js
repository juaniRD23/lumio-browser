chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'count-tabs') {
    chrome.tabs.query({}, (tabs) => sendResponse({ tabs: tabs.length }));
    return true;
  }
  if (msg?.type === 'open-tab') {
    chrome.tabs.create({ url: msg.url }, (tab) => sendResponse({ id: tab?.id }));
    return true;
  }
  return false;
});
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.set({ installedAt: Date.now() }));
