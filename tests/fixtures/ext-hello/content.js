// Marks the page, then asks the background worker how many tabs are open.
document.documentElement.dataset.lumioExt = 'content-script-ran';
chrome.runtime.sendMessage({ type: 'count-tabs' }, (reply) => {
  document.documentElement.dataset.lumioExtTabs = String(reply?.tabs ?? 'none');
});
