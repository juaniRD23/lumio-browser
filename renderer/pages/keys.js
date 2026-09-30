// On Windows and Linux, show Ctrl/Shift/Alt/Enter instead of the Mac key
// symbols in text, tooltips and placeholders (including text added later).
const MAC = /Mac/.test(navigator.platform);

export function keyLabel(text) {
  if (MAC) return text;
  return String(text).replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+').replace(/⌥/g, 'Alt+').replace(/↵/g, 'Enter').replace(/\+\+/g, '+');
}

function swap(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/[⌘⇧⌥↵]/.test(n.nodeValue)) n.nodeValue = keyLabel(n.nodeValue);
  }
  const els = root.querySelectorAll ? [root, ...root.querySelectorAll('[title],[placeholder],[aria-label]')] : [];
  for (const el of els) {
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      const v = el.getAttribute?.(attr);
      if (v && /[⌘⇧⌥↵]/.test(v)) el.setAttribute(attr, keyLabel(v));
    }
  }
}

if (!MAC) {
  const start = () => {
    swap(document.body);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') { if (/[⌘⇧⌥↵]/.test(r.target.nodeValue)) r.target.nodeValue = keyLabel(r.target.nodeValue); } else r.addedNodes.forEach((n) => (n.nodeType === 1 ? swap(n) : n.nodeType === 3 && /[⌘⇧⌥↵]/.test(n.nodeValue) && (n.nodeValue = keyLabel(n.nodeValue))));
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
}
