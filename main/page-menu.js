// More items for the page's right-click menu. main/tabs.js asks for them one
// part of the menu at a time (link, image, media, editable, selection,
// page): Copy link text, QR codes, Copy link to highlight, a video's
// Play / Mute / Loop / Show controls / Picture in picture, Ask Lumio about an
// image, Emoji & Symbols, a frame's source and reload, and on the Mac
// Look Up and Speech.
const { app, clipboard } = require('electron');

const WORLD = 1005; // page tools' isolated world (Lumio AI uses 1001, translation 1003, reading mode 1004)
const MAC = process.platform === 'darwin';
const MAX_IMAGE = 15 * 1024 * 1024;
const web = (url) => /^https?:/i.test(url || '');
const short = (text, n = 28) => (text.length > n ? text.slice(0, n) + '…' : text);

// Runs in the page: does something to the <video> or <audio> that was
// right-clicked (found at x, y; in a frame, by its address or as the only one).
function mediaAction(action, x, y, src) {
  const all = [...document.querySelectorAll('video, audio')];
  const at = x == null ? [] : document.elementsFromPoint(x, y).filter((e) => e instanceof HTMLMediaElement);
  const el = at[0] || all.find((m) => src && m.currentSrc === src) || (all.length === 1 ? all[0] : null);
  if (!el) return false;
  if (action === 'loop') el.loop = !el.loop;
  else if (action === 'controls') el.controls = !el.controls;
  else if (action === 'mute') el.muted = !el.muted;
  else if (action === 'play') { if (el.paused) el.play().catch(() => {}); else el.pause(); }
  else if (action === 'pip' && el instanceof HTMLVideoElement) {
    if (document.pictureInPictureElement === el) document.exitPictureInPicture().catch(() => {});
    else el.requestPictureInPicture().catch(() => {});
  }
  return true;
}

// Runs in the page: a link that scrolls to and highlights the selected text
// (a text fragment, #:~:text=…). Long selections use their first and last
// words; text that appears more than once gets the words around it.
function highlightLink() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const words = (s) => s.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const text = words(sel.toString()).join(' ');
  if (!text) return null;
  // The fragment's own punctuation (- , &) must be escaped inside its parts.
  const enc = (s) => encodeURIComponent(s).replace(/-/g, '%2D');
  const page = words(document.body?.innerText || '').join(' ');
  const count = (needle) => { let n = 0; for (let i = page.indexOf(needle); i >= 0 && n < 2; i = page.indexOf(needle, i + 1)) n++; return n; };
  const all = words(text);
  const long = text.length > 80;
  const start = long ? all.slice(0, 4).join(' ') : text;
  let target = long ? `${enc(start)},${enc(all.slice(-4).join(' '))}` : enc(text);
  if (count(start) > 1) {
    const around = (start) => {
      const r = document.createRange();
      if (start) { r.setStart(document.body, 0); r.setEnd(range.startContainer, range.startOffset); } else { r.setStart(range.endContainer, range.endOffset); r.setEnd(document.body, document.body.childNodes.length); }
      const w = words(r.toString());
      return (start ? w.slice(-3) : w.slice(0, 3)).join(' ');
    };
    const before = around(true);
    const after = around(false);
    target = `${before ? enc(before) + '-,' : ''}${target}${after ? ',-' + enc(after) : ''}`;
  }
  return `${location.href.split('#')[0]}#:~:text=${target}`;
}

class PageMenu {
  // share: main/share.js (QR codes). toast(w, text): a short note in the window.
  constructor({ share, toast = () => {} }) {
    this.share = share;
    this.toast = toast;
  }

  // Items for one part of the menu; [] when there's nothing to add.
  items(w, section, tab, params) {
    const wc = tab.view?.webContents;
    if (!wc) return [];
    const out = [];
    const qr = (label, url, title) => out.push({ label, click: () => this.share?.command(w, 'qr', { url, title }) });
    const selection = (params.selectionText || '').trim();
    const mac = () => (MAC && selection ? [
      { label: `Look Up “${short(selection)}”`, click: () => wc.showDefinitionForSelection() },
      { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
    ] : []);

    if (section === 'link') {
      const text = (params.linkText || '').trim();
      if (text) out.push({ label: 'Copy Link Text', click: () => clipboard.writeText(text) });
      if (web(params.linkURL)) qr('Create QR Code for This Link', params.linkURL, text);
    } else if (section === 'image') {
      if (web(params.srcURL) || /^data:image\//i.test(params.srcURL)) out.push({ label: 'Ask Lumio About This Image', needsAI: true, click: () => this.askAboutImage(w, tab, params.srcURL) });
      if (web(params.srcURL)) qr('Create QR Code for This Image', params.srcURL, params.altText || params.titleText || '');
    } else if (section === 'media') {
      const f = params.mediaFlags || {};
      const run = (action) => () => this.mediaAction(wc, params, action);
      const video = params.mediaType === 'video';
      out.push(
        { label: f.isPaused ? 'Play' : 'Pause', click: run('play') },
        ...(f.hasAudio === false ? [] : [{ label: f.isMuted ? 'Unmute' : 'Mute', click: run('mute') }]),
        { label: 'Loop', type: 'checkbox', checked: !!f.isLooping, enabled: f.canLoop !== false, click: run('loop') },
        { label: 'Show Controls', type: 'checkbox', checked: !!f.isControlsVisible, enabled: f.canToggleControls !== false, click: run('controls') },
        ...(video ? [{ label: 'Picture in Picture', type: 'checkbox', checked: !!f.isShowingPictureInPicture, enabled: f.canShowPictureInPicture !== false, click: run('pip') }] : []),
        ...(web(params.srcURL) ? [{ label: `Copy ${video ? 'Video' : 'Audio'} Address`, click: () => clipboard.writeText(params.srcURL) }] : []),
      );
    } else if (section === 'editable') {
      if (app.isEmojiPanelSupported()) out.push({ label: MAC ? 'Emoji & Symbols' : 'Emoji', click: () => app.showEmojiPanel() });
      out.push(...mac());
    } else if (section === 'selection') {
      // Text fragments work on web pages, from the page itself (not a frame inside it).
      if (web(wc.getURL()) && !params.frame?.parent) out.push({ label: 'Copy Link to Highlight', click: () => this.copyHighlight(w, wc) });
      out.push(...mac());
    } else if (section === 'page') {
      if (web(wc.getURL())) qr('Create QR Code for This Page', wc.getURL(), tab.title);
      const frame = params.frame;
      if (frame?.parent && params.frameURL) {
        out.push(
          { label: 'View Frame Source', enabled: /^(https?|file):/i.test(params.frameURL), click: () => tab.owner.create('view-source:' + params.frameURL, { index: tab.owner.tabs.indexOf(tab) + 1 }) },
          { label: 'Reload Frame', click: () => { try { frame.reload(); } catch { /* the frame is gone */ } } },
        );
      }
    }
    return out;
  }

  // In the page itself, from the spot that was right-clicked; in a frame, in
  // that frame's own page (an isolated world only runs in the top page).
  // It counts as a click on the page, so Picture in picture and Play are allowed.
  mediaAction(wc, params, action) {
    const frame = params.frame;
    if (frame?.parent) {
      frame.executeJavaScript(`(${mediaAction})(${JSON.stringify(action)}, null, null, ${JSON.stringify(params.srcURL || '')})`, true).catch(() => {});
      return;
    }
    const zoom = wc.getZoomFactor() || 1;
    const code = `(${mediaAction})(${JSON.stringify(action)}, ${params.x / zoom}, ${params.y / zoom}, ${JSON.stringify(params.srcURL || '')})`;
    wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], true).catch(() => {});
  }

  async copyHighlight(w, wc) {
    const link = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${highlightLink})()` }]).catch(() => null);
    if (typeof link !== 'string' || !web(link)) { this.toast(w, 'Couldn’t make a link to this text'); return; }
    clipboard.writeText(link);
    this.toast(w, 'Link to highlight copied');
  }

  // The picture goes to the Lumio AI panel as an attachment, with a question to finish.
  async askAboutImage(w, tab, src) {
    let data = null;
    let type = 'image/png';
    try {
      if (/^data:image\//i.test(src)) {
        const m = /^data:(image\/[\w.+-]+)(;base64)?,(.*)$/is.exec(src);
        if (m) { type = m[1]; data = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])); }
      } else {
        // With the cookies of the tab's profile, like the page loaded it.
        const res = await tab.owner.session.fetch(src, { signal: AbortSignal.timeout(15000) });
        type = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (res.ok && type.startsWith('image/') && Number(res.headers.get('content-length') || 0) <= MAX_IMAGE) data = Buffer.from(await res.arrayBuffer());
      }
    } catch { /* couldn't get it */ }
    if (!data || !data.length || data.length > MAX_IMAGE) { this.toast(w, 'Couldn’t get this image'); return; }
    const ext = (type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*/, '');
    w.emit('ai-attach', { name: `image.${ext}`, type, data: new Uint8Array(data) });
    w.askAI('What’s in this image?', { draft: true });
  }
}

module.exports = { PageMenu, mediaAction, highlightLink };
