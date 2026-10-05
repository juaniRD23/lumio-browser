// Credits (lumio://credits): Lumio's own license, Chromium and Electron, and
// the open-source packages and files Lumio ships, each with its license (from
// main/credits.js). Everything is set as text.
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);

function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k != null && k !== ''));
  return node;
}

const link = (href, text) => el('a', { href, textContent: text || href, target: '_blank', rel: 'noopener' });

// One project: a row that opens to its license text, or a plain row (with
// its website) when there's no text to show.
function entry({ name, version, license, url, text }) {
  const head = [
    el('span', { className: 'name', textContent: name }),
    version ? el('span', { className: 'ver', textContent: version }) : null,
    el('span', { className: 'grow' }),
    el('span', { className: 'lic', textContent: license || '' }),
  ];
  if (!text) return el('div', { className: 'plain' }, ...head, url ? link(url, 'Website') : null);
  // The text scrolls in its own box, which takes the keyboard to scroll.
  const body = el('div', { className: 'body' }, url ? link(url) : null, el('pre', { textContent: text, tabIndex: 0 }));
  return el('details', { className: 'item' }, el('summary', {}, ...head), body);
}

const data = await page.invoke('page:credits');
if (data) {
  if (data.terms) $('#terms').href = data.terms;
  if (data.privacy) $('#privacy').href = data.privacy;
  if (data.source) Object.assign($('#source'), { href: data.source, hidden: false });

  $('#lumio').append(entry({ name: 'Lumio Browser', version: data.version, license: data.license, url: data.source, text: data.licenseText }));

  // Chromium's hundreds of projects have a page of their own (or, without the file, its license online).
  const chromium = entry({ name: 'Chromium', version: data.chromium?.version, license: 'BSD-3-Clause and others' });
  chromium.append(data.chromium?.available ? el('a', { href: 'chromium.html', textContent: 'Licenses' }) : link('https://source.chromium.org/chromium/chromium/src/+/main:LICENSE', 'Licenses'));
  $('#engine').append(chromium, entry({ name: 'Electron', ...data.electron }));

  $('#packages').append(...(data.packages || []).map(entry));
  $('#bundled').append(...(data.bundled || []).map(entry));
}
