// Embedded frames (iframes) for Lumio AI's browser tools. Sites put whole apps
// in one (Excel for the web's workbook, editors, Office and OneDrive viewers,
// checkout and payment fields), often from another site, which Chromium runs
// in a process of its own. Each frame runs the same page scripts as the top
// page (page-scripts.js) through Electron's WebFrameMain, in the frame's own
// JavaScript world (an isolated world only runs in the top page), so what a
// frame answers is that frame's word, used only for that frame.
//
// Input for an element in a frame goes to the tab at the element's place on
// the page (its place in the frame plus the frame's place in each frame
// around it), through DevTools' Input domain, which Chromium routes like the
// person's own input: a click to the frame under the point, keys and text to
// the frame that has focus, even in another process.
// (webContents.sendInputEvent() only reaches the top page's process.)
const crypto = require('crypto');
const scripts = require('./page-scripts');
const { markSynthetic } = require('../../synthetic-input');

const DEPTH = 3; // frames in frames in frames, no deeper
const MAX_FRAMES = 8; // frames read for one read_page
const FRAME_TEXT = 4000; // a frame's text, at most
const MIN_SIDE = 24; // smaller frames (trackers, pixels) aren't read
const COVERED = 0.3; // a frame showing less of itself than this is covered
const BIG = 0.25; // a frame showing this much of the page counts for the stuck check
const PROBE_MS = 800; // a frame that hasn't answered by then is skipped
const READ_MS = 3000;
const ACT_MS = 4000;
const SEND_MS = 3000; // a DevTools input command (it waits for the page)
// Where a frame keeps the card fields it hides for a screenshot (maskCards):
// the frame's own scripts share its world, so not under a name they know.
const MASK_KEY = `__lumio${crypto.randomBytes(6).toString('hex')}`;

// Payment providers' card and bank fields, which shops embed from the
// provider: Lumio never reads, types, pastes or clicks in them, whatever a
// page says. Matched on the frame's origin, which the page can't change.
const PAYMENT_HOSTS = [
  'stripe.com', 'stripe.network', 'stripecdn.com', 'adyen.com', 'adyenpayments.com', 'braintreegateway.com',
  'braintree-api.com', 'paypal.com', 'paypalobjects.com', 'checkout.com', 'squareup.com', 'squarecdn.com',
  'recurly.com', 'chargebee.com', 'paddle.com', 'klarna.com', 'affirm.com', 'authorize.net', 'worldpay.com',
  'cybersource.com', 'mollie.com', 'razorpay.com', 'bluesnap.com', 'spreedly.com', 'vgs.io', 'verygoodvault.com',
  'basistheory.com', 'evervault.com', 'tokenex.com', 'shopifyinc.com', 'pay.google.com', 'payments.amazon.com',
  'pay.amazon.com', 'globalpay.com', 'globalpayments.com', 'nmi.com', 'paysafe.com', 'payu.com', 'mercadopago.com',
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function within(promise, ms, what = 'The frame didn’t answer.') {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what)), ms); }),
  ]);
}

// A frame that's gone throws when it's read: these answer null (or []) instead.
const safe = (fn, fallback = null) => { try { return fn() ?? fallback; } catch { return fallback; } };
const alive = (f) => !!f && safe(() => !f.detached && !(f.isDestroyed && f.isDestroyed()), false);
const idOf = (f) => safe(() => f.frameTreeNodeId);
const parentOf = (f) => safe(() => f.parent);
const childrenOf = (f) => (alive(f) ? safe(() => [...f.frames], []).filter(alive) : []);
const urlOf = (f) => safe(() => f.url, '');
function originOf(f) {
  const o = safe(() => f.origin, '');
  if (o && o !== 'null') return o;
  try { return new URL(urlOf(f)).origin; } catch { return o || ''; }
}
const isTop = (f) => !parentOf(f);
// Only web content is read: not a PDF viewer's or an error page's frame.
const readable = (f) => /^(https?|about|data|blob):/i.test(urlOf(f));

function paymentHost(origin) {
  let host = '';
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return ''; }
  return PAYMENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? host : '';
}
// The payment provider's host if this frame or one around it is a payment frame.
function payment(frame) {
  for (let f = frame, depth = 0; f && !isTop(f) && depth < 10; f = parentOf(f), depth++) {
    const host = paymentHost(originOf(f));
    if (host) return host;
  }
  return '';
}

// Runs a page script in a frame (in its own world), giving up after `ms`.
function inFrame(frame, fn, arg = {}, ms = ACT_MS) {
  const code = `(${fn.toString()})(${JSON.stringify(arg)})`;
  return within(Promise.resolve().then(() => frame.executeJavaScript(code)), ms);
}

// Runs a page script in the top page (top: browser.js's inPage, in Lumio's
// isolated world; main: the tab's main frame) or in a frame.
function runner(top, main) {
  const mainId = idOf(main);
  return (frame, fn, arg = {}, ms) => (!frame || (mainId != null && idOf(frame) === mainId) ? top(fn, arg) : inFrame(frame, fn, arg, ms));
}

function byId(wc, id) {
  return safe(() => wc.mainFrame.framesInSubtree, []).find((f) => alive(f) && idOf(f) === id) || null;
}

// The addresses of a tab's frames (for site tips: Excel's workbook is one).
function urls(wc) {
  return safe(() => wc.mainFrame.framesInSubtree, []).filter((f) => alive(f) && !isTop(f)).slice(0, 30).map(urlOf).filter(Boolean);
}

// ------------------------------------------------------------ matching
// Which frame element in a parent page shows which child frame. A parent's
// window.length counts its child frames in the order the browser keeps them
// (both in the order they were made; frames in shadow roots aren't in its
// window), so when the parent's frames are all in its window and as many as
// the browser lists, child p is window[p] there: when each frame that answers
// finds that same index for itself (window.parent[i] is its window), that's
// the match (trusted), whatever a frame or the page says otherwise. Else the
// frames' own word on their index (only if it isn't another frame's place),
// a mark left by an earlier read (unless the page copied it), the frame's
// name, its address and its size (the frame's viewport is the element's
// content box). A payment provider's frame is never paired by a frame's own
// word: only by its place (trusted) or its element's address; and a payment
// provider's element shows no other frame. A frame and an element left over
// on their own go together unless something says they don't. kids: [{ id,
// index, trusted, name, url, origin, vw, vh }] (index, vw, vh from the frame
// itself, when it answered); els: frameInfo().frames. Returns Map(frame id ->
// element).
function matchFrames(kids, els) {
  const marks = new Map();
  for (const e of els) if (e.key) marks.set(e.key, (marks.get(e.key) || 0) + 1);
  const originOfSrc = (src) => { try { return new URL(src).origin; } catch { return ''; } };
  const allowed = (k, e) => {
    if (k.trusted) return k.index >= 0 && e.index === k.index;
    const kidPays = !!paymentHost(k.origin);
    const elPays = !!paymentHost(originOfSrc(e.src));
    if (elPays && !kidPays) return false;
    if (kidPays && !elPays) return false;
    return true;
  };
  const score = (k, e) => {
    if (!allowed(k, e)) return -Infinity;
    if (k.trusted) return 20;
    let s = 0;
    if (k.index >= 0 && e.index === k.index) s += 8;
    if (e.key && marks.get(e.key) === 1 && e.key === String(k.id)) s += 6;
    if (k.name && e.name === k.name) s += 4;
    if (e.src && e.src === k.url) s += 3;
    else if (e.src && originOfSrc(e.src) === k.origin) s += 2;
    if (k.vw > 0 && e.cw > 0) s += Math.abs(e.cw - k.vw) <= 2 && Math.abs(e.ch - k.vh) <= 2 ? 2 : -3;
    return s;
  };
  const pairs = [];
  for (const k of kids) for (const e of els) { const s = score(k, e); if (s >= 3) pairs.push({ k, e, s }); }
  pairs.sort((a, b) => b.s - a.s);
  const out = new Map();
  const used = new Set();
  for (const p of pairs) {
    if (out.has(p.k.id) || used.has(p.e)) continue;
    // As good a match elsewhere for this frame or this element: unsure, so neither.
    const tie = pairs.some((q) => q !== p && q.s === p.s && ((q.k === p.k && !used.has(q.e)) || (q.e === p.e && !out.has(q.k.id))));
    if (tie) continue;
    out.set(p.k.id, p.e);
    used.add(p.e);
  }
  const kidsLeft = kids.filter((k) => !out.has(k.id));
  const elsLeft = els.filter((e) => !used.has(e));
  if (kidsLeft.length === 1 && elsLeft.length === 1 && !kidsLeft[0].trusted && score(kidsLeft[0], elsLeft[0]) >= 0) out.set(kidsLeft[0].id, elsLeft[0]);
  return out;
}

// ------------------------------------------------------------ geometry
// Where a frame element's content (the frame's viewport) starts in its parent
// page's viewport, in that page's CSS px: its border box (which already
// counts the page's scroll and transforms) plus its border and padding,
// scaled like the box (a transform: the box over its layout size).
function contentBox(g) {
  const kx = g.ow > 0 ? g.width / g.ow : 1;
  const ky = g.oh > 0 ? g.height / g.oh : 1;
  return { x: g.left + (g.bl + g.pl) * kx, y: g.top + (g.bt + g.pt) * ky, w: g.cw * kx, h: g.ch * ky, kx, ky };
}

// One CSS px of a frame in its parent page's: one of the parent's unless the
// frame is scaled (transform, CSS zoom): then the content box over the frame's
// viewport (child: its size, as the frame says). null when either is empty.
const finite = (...v) => v.every((n) => typeof n === 'number' && Number.isFinite(n));
function scaleOf(box, child) {
  if (!finite(box.x, box.y, box.w, box.h, child?.vw, child?.vh) || box.w < 1 || box.h < 1 || !(child.vw > 0) || !(child.vh > 0)) return null;
  const near = (a, b) => Math.abs(a - b) <= 0.02 * Math.max(a, b);
  return {
    sx: near(box.w / child.vw, box.kx) ? box.kx : box.w / child.vw,
    sy: near(box.h / child.vh, box.ky) ? box.ky : box.h / child.vh,
  };
}

// A point in a frame's viewport (CSS px) in its parent page's: inside only
// when it's in the frame's content box as the parent measured it (whatever
// the frame says about its own size) and in the parent's viewport, where a
// click would reach it.
function outward(p, child, g) {
  const box = contentBox(g);
  const k = scaleOf(box, child);
  if (!k || !finite(p?.x, p?.y)) return { x: NaN, y: NaN, inside: false };
  const x = box.x + p.x * k.sx;
  const y = box.y + p.y * k.sy;
  const inFrame = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
  const inView = x >= 0 && y >= 0 && x < g.vw && y < g.vh;
  return { x, y, inside: inFrame && inView };
}

// And back: a point in the parent page's viewport in the frame's (null when
// it isn't over the frame's content).
function inward(p, child, g) {
  const box = contentBox(g);
  const k = scaleOf(box, child);
  if (!k || !finite(p?.x, p?.y)) return null;
  if (p.x < box.x || p.x >= box.x + box.w || p.y < box.y || p.y >= box.y + box.h) return null;
  return { x: (p.x - box.x) / k.sx, y: (p.y - box.y) / k.sy };
}

// The part of a frame the person can see (vis, in its parent's viewport) in
// the frame's own viewport, for reading the frames in it.
function clipIn(vis, child, g) {
  const box = contentBox(g);
  const k = vis && scaleOf(box, child);
  if (!k) return null;
  const x1 = Math.max(vis.x, box.x);
  const y1 = Math.max(vis.y, box.y);
  const x2 = Math.min(vis.x + vis.w, box.x + box.w);
  const y2 = Math.min(vis.y + vis.h, box.y + box.h);
  if (x2 <= x1 || y2 <= y1) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: (x1 - box.x) / k.sx, y: (y1 - box.y) / k.sy, w: (x2 - x1) / k.sx, h: (y2 - y1) / k.sy };
}

// The page's CSS px to the view's DIPs (sendInputEvent): page zoom applies to
// every frame in the tab alike.
const toDip = (p, zoom) => ({ x: Math.round(p.x * zoom), y: Math.round(p.y * zoom) });

// ------------------------------------------------------------ reading
// The child frames of a page (`parent`, the top page's WebFrameMain or a
// frame) and where each one is: probed (each frame's own window index and
// size), matched to the page's frame elements, which are marked for the
// tools; with what read_page does with each: 'read', 'payment', 'unreadable'
// (no scripts, no answer, not web content), 'offscreen', 'covered' (in view
// but mostly under something else). Frames hidden, see-through, tiny or
// clipped to a sliver aren't listed; unplaced counts those that couldn't be
// matched to an element (or past the first 24). vw, vh: the page's viewport.
// opts.clip: the part of `parent` the person can see (its own px); opts.point:
// at, the frame at that point ({ unknown } for a frame element that couldn't
// be matched), for click_at.
async function survey(parent, run, opts = {}) {
  const all = childrenOf(parent);
  const kids = all.slice(0, 24);
  if (!kids.length) return { frames: [], vw: 0, vh: 0, unplaced: 0, at: null };
  const info = await run(parent, scripts.frameInfo, { ...(opts.clip ? { clip: opts.clip } : {}), ...(opts.point ? { point: opts.point } : {}) }, PROBE_MS).catch(() => null);
  const els = Array.isArray(info?.frames) ? info.frames : [];
  const probes = await Promise.all(kids.map((k) => (readable(k) && !paymentHost(originOf(k))
    ? inFrame(k, scripts.frameInfo, { self: true }, PROBE_MS).catch(() => null)
    : null)));
  // Child p is window[p] in the parent when the parent's frames are all in
  // its window, as many as the browser lists, and every frame that answers
  // says so too (one that doesn't is wrong about itself, or lying).
  const aligned = !!info && info.count === all.length && !info.shadow;
  const own = probes.map((pr) => (pr && Number.isInteger(pr.index) && pr.index >= 0 ? pr.index : -1));
  const ordered = aligned && own.some((s, p) => s === p) && own.every((s, p) => s < 0 || s === p);
  const list = kids.map((k, p) => ({
    frame: k, id: idOf(k), name: safe(() => k.name, ''), url: urlOf(k), origin: originOf(k),
    index: ordered ? p : aligned && own[p] !== p ? -1 : own[p], trusted: ordered,
    vw: probes[p]?.vw || 0, vh: probes[p]?.vh || 0, answered: !!probes[p],
  }));
  const match = matchFrames(list, els);
  const marks = [];
  for (const k of list) { const e = match.get(k.id); if (e) marks.push([e.i, e.index, k.id]); }
  if (marks.length || els.some((e) => e.key)) await run(parent, scripts.frameInfo, { mark: marks }, PROBE_MS).catch(() => {});
  const out = [];
  let unplaced = all.length - kids.length;
  for (const k of list) {
    const el = match.get(k.id);
    if (!el) {
      // Not a hidden tracker (as it says itself) or a payment frame: worth a note.
      const tiny = k.answered && (k.vw < MIN_SIDE || k.vh < MIN_SIDE);
      if (!tiny && !paymentHost(k.origin)) unplaced++;
      continue;
    }
    if (!el.shown || el.width < MIN_SIDE || el.height < MIN_SIDE) continue; // hidden, see-through or tiny
    const vis = el.vis && el.vis.w >= 1 && el.vis.h >= 1 ? el.vis : null;
    const offscreen = !el.inView || (!vis && el.scroller);
    if (!offscreen && (!vis || vis.w < MIN_SIDE || vis.h < MIN_SIDE)) continue; // clipped to a sliver
    const status = paymentHost(k.origin) ? 'payment' : offscreen ? 'offscreen' : !(el.hit >= COVERED) ? 'covered'
      : !readable(k.frame) || !k.answered ? 'unreadable' : 'read';
    out.push({ ...k, el, area: Math.max(0, el.seen || 0), clip: vis && clipIn(vis, k, el), status });
  }
  let at = null;
  if (opts.point && info && info.at !== -1 && info.at != null) {
    const el = typeof info.at === 'number' ? els.find((e) => e.i === info.at) : null;
    const k = el && list.find((x) => match.get(x.id) === el);
    at = k ? { ...k, el } : { unknown: true };
  }
  return { frames: out.sort((a, b) => b.area - a.area), vw: info?.vw || 0, vh: info?.vh || 0, unplaced, at };
}

// How much of the page the frames it'll read cover (0 to 1), for read_page's budget.
function coverage({ frames, vw, vh }) {
  const area = frames.filter((f) => f.status === 'read').reduce((sum, f) => sum + f.area, 0);
  return vw > 0 && vh > 0 ? Math.min(1, area / (vw * vh)) : 0;
}

const unreadNote = (origin) => (/^https?:/.test(origin)
  ? `Embedded frame from ${origin} couldn't be read (it allows no scripts or didn't answer); use screenshot_tab to see it and click_at to click in it.`
  : 'An embedded document (a PDF or plugin) couldn\'t be read; use screenshot_tab to see it and click_at to click in it.');
const plural = (n, one, many) => (n > 1 ? many : one);

// What a frame's snapshot (run in the frame's own world, so the frame's word)
// may put in read_page: at most `max` lines, each one line of at most 300
// characters and numbered as snapshot numbers them, from `start` on (a line
// that isn't ends the list); refs (with a short name and role) only for those
// lines; at most maxText of text; a one-line title. null: not a snapshot.
const ONE_LINE = /[\r\n\u2028\u2029\u0085\v\f]+/g;
const oneLine = (s, n) => (typeof s === 'string' || typeof s === 'number' ? String(s) : '').replace(ONE_LINE, ' ').trim().slice(0, n);
function cleanSnap(snap, { start, max, maxText }) {
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.lines)) return null;
  const given = snap.meta && typeof snap.meta === 'object' ? snap.meta : {};
  const lines = [];
  const meta = {};
  for (const raw of snap.lines.slice(0, Math.max(0, max))) {
    const ref = start + lines.length + 1;
    const line = oneLine(raw, 300);
    if (!line.startsWith(`[${ref}] `)) break;
    const m = Object.prototype.hasOwnProperty.call(given, ref) && given[ref] && typeof given[ref] === 'object' ? given[ref] : {};
    meta[ref] = { name: oneLine(m.name, 80) || 'element', role: oneLine(m.role, 30) || 'element' };
    lines.push(line);
  }
  const text = maxText > 0 && typeof snap.text === 'string' ? snap.text.slice(0, maxText + 40) : '';
  const total = Number.isFinite(snap.total) ? Math.min(100_000, Math.max(lines.length, Math.round(snap.total))) : lines.length;
  return { lines, meta, text, total, title: oneLine(snap.title, 80) };
}

// Reads the frames survey() found in the top page, a level at a time (the
// frames on the page, then the frames in those…), at most DEPTH deep and
// MAX_FRAMES in all, the biggest first; the frames of a level at once, each
// with its share of what's left of the element and text budget (by how much
// of the page it shows) and its own range of refs from `start` on. Returns the
// sections (what each frame showed, cleaned: cleanSnap), the refs' meta (each
// with its frame's id), the ids read (big: those showing much of the page),
// and notes on frames it couldn't or didn't read.
async function read(found, run, { start, elements, text, includeText }) {
  const sections = [];
  const meta = {};
  const notes = [];
  const done = [];
  const big = [];
  let next = start;
  let offscreen = 0;
  let covered = 0;
  let skipped = 0;
  let unplaced = found.unplaced || 0;
  const page = found.vw * found.vh;
  let level = found.frames.map((f) => ({ ...f, depth: 1, share: page > 0 ? f.area / page : 0 }));
  while (level.length) {
    const reading = [];
    for (const f of level) {
      if (f.status === 'payment') notes.push(`Embedded payment frame from ${f.origin}: Lumio doesn't read, type or paste in payment fields; the user fills them in.`);
      else if (f.status === 'offscreen') offscreen++;
      else if (f.status === 'covered') covered++;
      else if (f.status === 'unreadable') notes.push(unreadNote(f.origin));
      else reading.push(f);
    }
    // Each frame's budget up front, the biggest first.
    const shares = reading.reduce((sum, f) => sum + f.share, 0);
    let elementsLeft = elements;
    let textLeft = includeText ? text : 0;
    let from = next;
    const jobs = [];
    for (const f of reading) {
      const share = shares > 0 ? f.share / shares : 1 / reading.length;
      const max = elementsLeft > 0 ? Math.min(elementsLeft, Math.max(15, Math.round(elements * share))) : 0;
      const maxText = textLeft > 0 ? Math.min(FRAME_TEXT, textLeft, Math.max(400, Math.round(text * share))) : 0;
      if (done.length + jobs.length >= MAX_FRAMES || (!max && !maxText)) { skipped++; continue; }
      jobs.push({ f, max, maxText, start: from });
      elementsLeft -= max;
      textLeft -= maxText;
      from += max;
    }
    const snaps = await Promise.all(jobs.map((j) => inFrame(j.f.frame, scripts.snapshot, { max: j.max, maxText: j.maxText, start: j.start }, j.f.share >= 0.2 ? READ_MS : READ_MS / 2).catch(() => null)));
    const deeper = [];
    jobs.forEach((j, n) => {
      const got = cleanSnap(snaps[n], j);
      if (!got) { notes.push(unreadNote(j.f.origin)); return; }
      done.push(j.f.id);
      if (j.f.share >= BIG) big.push(j.f.id);
      const site = safe(() => new URL(j.f.origin).host, '') || j.f.origin;
      for (const [ref, m] of Object.entries(got.meta)) if (!(ref in meta)) meta[ref] = { ...m, frame: j.f.id, site };
      next = Math.max(next, j.start + got.lines.length);
      elements -= got.lines.length;
      text -= got.text.length;
      sections.push({ id: j.f.id, origin: j.f.origin, url: urlOf(j.f.frame) || j.f.url, title: got.title, lines: got.lines, total: got.total, text: got.text });
      if (childrenOf(j.f.frame).length) deeper.push(j.f);
    });
    // The frames in those: found at once; past DEPTH (or MAX_FRAMES), counted.
    const room = done.length < MAX_FRAMES;
    const inner = await Promise.all(deeper.map((f) => (room ? survey(f.frame, run, { clip: f.clip }).catch(() => null) : null)));
    level = [];
    inner.forEach((got, n) => {
      const f = deeper[n];
      if (!got) { skipped += childrenOf(f.frame).filter((k) => !paymentHost(originOf(k))).length; return; }
      unplaced += got.unplaced;
      const area = got.vw * got.vh;
      for (const g of got.frames) {
        if (f.depth < DEPTH) level.push({ ...g, depth: f.depth + 1, share: f.share * (area > 0 ? g.area / area : 0) });
        else if (g.status === 'read') skipped++;
      }
    });
    level.sort((a, b) => b.share - a.share);
  }
  if (offscreen) notes.push(`(${offscreen} more embedded ${plural(offscreen, 'frame', 'frames')} outside the visible part of the page: scroll to ${plural(offscreen, 'it', 'them')} and read_page again.)`);
  if (covered) notes.push(`(${covered} more embedded ${plural(covered, 'frame', 'frames')} mostly covered by something else on the page, not read: close what covers ${plural(covered, 'it', 'them')} and read_page again.)`);
  if (skipped) notes.push(`(${skipped} more embedded ${plural(skipped, 'frame', 'frames')} not read; use screenshot_tab to see ${plural(skipped, 'it', 'them')}.)`);
  if (unplaced) notes.push(`(${unplaced} embedded ${plural(unplaced, 'frame', 'frames')} couldn't be placed on the page; use screenshot_tab to see ${plural(unplaced, 'it', 'them')}.)`);
  return { sections, meta, read: done, big, notes, next };
}

// ------------------------------------------------------------ acting
// A frame's element in its parent page (its box, and the query that found
// it): by its window index when that's its place among its parent's frames
// (as the frame says too: then the page can't point it elsewhere), else by
// its mark, else by the window index it gives (the page redrew it; it's
// marked again). Never an element that shows a payment provider's frame
// (by the browser's order, or its address) when this frame isn't one.
const payInside = (f) => safe(() => f.framesInSubtree, []).filter(alive).map((x) => paymentHost(originOf(x))).find(Boolean) || '';
async function boxOf(run, parent, child) {
  const id = idOf(child);
  const all = childrenOf(parent);
  const p = all.findIndex((k) => idOf(k) === id);
  const self = await inFrame(child, scripts.frameInfo, { self: true }, PROBE_MS).catch(() => null);
  const index = Number.isInteger(self?.index) && self.index >= 0 ? self.index : -1;
  const query = { id, index, byIndex: p >= 0 && index === p, count: all.length };
  const g = await run(parent, scripts.frameInfo, { box: query }, ACT_MS).catch(() => null);
  if (!g || g.error) return null;
  const other = g.count === all.length && !g.shadow && Number.isInteger(g.index) && g.index >= 0 && g.index !== p ? all[g.index] : null;
  let srcHost = '';
  try { srcHost = g.src ? paymentHost(new URL(g.src).origin) : ''; } catch { /* not an address */ }
  if ((other && payInside(other)) || (srcHost && !payInside(child))) return null;
  return { g, query, self };
}

// A point in a frame's viewport (local: { x, y }) carried out through each
// frame around it to the top page's viewport (CSS px), each step bounded by
// the frame's element as the page around it measured it. error 'gone' when a
// frame's element can't be found, 'hidden' when it isn't shown, 'out' when
// the point isn't visible there (with the page where it isn't: scroll the
// frame's element into view there).
async function outwards(run, frame, local) {
  let p = { x: local.x, y: local.y };
  const steps = [];
  for (let f = frame, parent = parentOf(f); parent; f = parent, parent = parentOf(f)) {
    const found = await boxOf(run, parent, f);
    if (!found) return { error: 'gone' };
    const { g, query, self } = found;
    if (g.shown === false) return { error: 'hidden' };
    // The frame's own size only for its scale (CSS zoom); the bounds are the element's.
    const box = contentBox(g);
    const size = self?.vw > 0 && self?.vh > 0 ? { vw: self.vw, vh: self.vh } : { vw: box.w / box.kx, vh: box.h / box.ky };
    const o = outward(p, size, g);
    if (!o.inside) return { error: 'out', parent, query };
    steps.push({ parent, query, at: { x: o.x, y: o.y } });
    p = o;
  }
  return { x: p.x, y: p.y, steps };
}

// Where the element with this ref in `frame` is on the page: scrolled into
// view in its frame (Chromium also scrolls the frames around it), then
// measured out through each frame. x, y: the top page's CSS px; covered: what
// covers the point inside its frame (a note, as on the page). An error when a
// page around it covers the frame there or doesn't show it: the click would
// go to something else.
async function place(frame, ref, run) {
  // (What the frame answers is its word: its own error text isn't passed on.)
  const missing = (got) => (got && typeof got === 'object'
    ? { error: `No element [${ref}] in its embedded frame now. Call read_page again to get fresh refs.` }
    : { error: `Element [${ref}] is in an embedded frame that didn't answer. Call read_page again, or use screenshot_tab and click_at.` });
  const first = await inFrame(frame, scripts.locate, { ref }, ACT_MS);
  if (!first || typeof first !== 'object' || first.error) return missing(first);
  for (let tries = 0; ; tries++) {
    await wait(80); // a scroll in another process lands
    const local = await inFrame(frame, scripts.locate, { ref, scroll: false }, ACT_MS);
    if (!local || typeof local !== 'object' || local.error) return missing(local);
    if (!(local.width > 0 && local.height > 0)) return { error: `Element [${ref}] isn't shown in its embedded frame now. Call read_page again.` };
    const at = await outwards(run, frame, local);
    if (at.error === 'gone') return { error: `The embedded frame with element [${ref}] moved or was replaced. Call read_page again.` };
    if (at.error === 'hidden') return { error: `The embedded frame with element [${ref}] isn't shown on the page now. Call read_page again.` };
    if (at.error === 'out') {
      if (tries) return { error: `Element [${ref}] is outside the visible part of its embedded frame. Scroll it into view (scroll with its ref), or use screenshot_tab and click_at.` };
      await run(at.parent, scripts.frameInfo, { box: { ...at.query, scroll: true } }, ACT_MS).catch(() => {});
      continue;
    }
    // What the page around each frame has at the point: the frame, or input won't reach it.
    // (The top page's answer is Lumio's own; a frame's that doesn't answer is let be.)
    const checks = await Promise.all(at.steps.map((s) => run(s.parent, scripts.frameInfo, { box: { ...s.query, at: s.at } }, PROBE_MS).catch(() => null)));
    const blocked = checks.findIndex((g, n) => (!g ? n === checks.length - 1 : g.error || g.covered));
    if (blocked >= 0) {
      const what = checks[blocked]?.covered;
      return { error: what ? `Element [${ref}] is in an embedded frame that's covered there by ${what}. Close or move what covers it (or scroll), then read_page again.` : `Element [${ref}]'s embedded frame couldn't be checked on the page. Call read_page again.` };
    }
    return {
      x: at.x, y: at.y, width: local.width, height: local.height,
      sensitive: !!local.sensitive, isSelect: !!local.isSelect, editable: !!local.editable,
      covered: local.covered ? oneLine(local.covered, 80) || 'something' : null,
    };
  }
}

// Whether `frame` is `outer` or inside it.
function inside(frame, outer) {
  const id = idOf(outer);
  for (let f = frame, depth = 0; f && depth < 20; f = parentOf(f), depth++) if (idOf(f) === id) return true;
  return false;
}

// Where keyboard focus is (the browser's own focused frame, so wherever the
// keys and text would go, at any depth), and whether it's a password, payment
// or ID field there (or a payment frame). inFrame: it's in a frame (frame,
// with its url); unknown: in a frame that can't be checked (no scripts, no
// answer) or the page and the browser don't agree yet. keep: a sensitive
// field keeps focus (scripts.focusCheck). Nothing runs in a payment frame.
async function focus(wc, top, { keep = false } = {}) {
  const main = safe(() => wc.mainFrame);
  const check = await top(scripts.focusCheck, { keep });
  const focused = safe(() => wc.focusedFrame);
  const inner = focused && alive(focused) && idOf(focused) !== idOf(main) ? focused : null;
  if (!inner) {
    if (check?.sensitive) return { sensitive: true, inFrame: !!check.frame, frame: null, url: '' };
    // The page says one of its frames has focus, the browser that the page has it.
    if (check?.frame) return { sensitive: false, unknown: true, inFrame: true, frame: null, url: '' };
    return { sensitive: false, inFrame: false, frame: null, url: '' };
  }
  const host = payment(inner);
  if (host) return { sensitive: true, payment: host, inFrame: true, frame: inner, url: urlOf(inner) };
  if (check?.sensitive) return { sensitive: true, inFrame: true, frame: inner, url: urlOf(inner) }; // a frame that looks like a card field's
  const own = readable(inner) ? await inFrame(inner, scripts.focusCheck, { keep }, ACT_MS).catch(() => null) : null;
  if (!own || typeof own !== 'object' || own.frame) return { sensitive: false, unknown: true, inFrame: true, frame: inner, url: urlOf(inner) };
  return { sensitive: !!own.sensitive, inFrame: true, frame: inner, url: urlOf(inner) };
}

// What's at a point on the page (the top page's CSS px) for click_at: frame,
// the embedded frame there (null: the page itself), which only DevTools'
// input reaches; payment: a payment provider's frame is there, or may be
// (a frame there that couldn't be told apart, with one in it or beside it).
// It follows frames in frames only as far as it takes to rule a payment frame out.
async function frameAt(wc, top, point) {
  const main = safe(() => wc.mainFrame);
  if (!main || !childrenOf(main).length) return { frame: null };
  const run = runner(top, main);
  const payIn = payInside;
  let parent = main;
  let p = point;
  let hit = null;
  for (let depth = 0; depth < 8; depth++) {
    const found = await survey(parent, run, { point: p }).catch(() => null);
    const around = childrenOf(parent).map((k) => payIn(k) || paymentHost(originOf(k))).find(Boolean) || '';
    if (!found) return around ? { frame: hit || parent, payment: around } : { frame: hit, unsure: true };
    if (!found.at) return { frame: hit };
    if (found.at.unknown) return around ? { frame: hit || parent, payment: around } : { frame: hit || parent };
    const k = found.at;
    const host = payment(k.frame);
    if (host) return { frame: k.frame, payment: host };
    hit = k.frame;
    const inside = payIn(k.frame);
    if (!inside) return { frame: hit };
    const q = k.answered ? inward(p, k, k.el) : null;
    if (!q) return { frame: hit, payment: inside };
    parent = k.frame;
    p = q;
  }
  return { frame: hit, payment: payIn(hit) || undefined };
}

// Card fields in every frame shown as dots (on) for a screenshot, or back.
async function mask(wc, on) {
  const kids = safe(() => wc.mainFrame.framesInSubtree, []).filter((f) => alive(f) && !isTop(f) && readable(f)).slice(0, 20);
  await Promise.all(kids.map((f) => inFrame(f, scripts.maskCards, { on, key: MASK_KEY }, 400).catch(() => {})));
}

// What these frames show (scripts.pageState), for telling whether a step
// changed anything there.
async function states(wc, ids, volatile) {
  const list = (ids || []).slice(0, 4).map((id) => byId(wc, id)).filter(Boolean);
  const got = await Promise.all(list.map((f) => inFrame(f, scripts.pageState, { volatile }, 400).catch(() => '')));
  return got.filter((s) => typeof s === 'string' && s).map((s) => s.slice(0, 64)).join('|');
}

// ------------------------------------------------------------ input
// Sends DevTools Input commands to the tab: true once sent, false when
// DevTools couldn't attach or took none (then the caller uses sendInputEvent,
// which still reaches frames in the page's own process). Attached only for
// these, unless something else had it attached already.
async function devtools(wc, commands) {
  const dbg = safe(() => wc.debugger);
  if (!dbg) return false;
  let mine = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); mine = true; }
  } catch { return false; }
  let sent = 0;
  try {
    for (const [method, params] of commands) { await within(dbg.sendCommand(method, params), SEND_MS, 'The page didn’t take the input.'); sent++; }
  } catch { /* the page went away or stopped on a dialog: what went is enough */ } finally {
    if (mine) { try { dbg.detach(); } catch { /* already gone */ } }
  }
  return sent > 0;
}

// x, y: the top page's CSS px (DevTools' Input domain applies the page zoom).
function click(wc, x, y, count = 1) {
  const at = { x, y, button: 'left' };
  const commands = [['Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }]];
  for (let i = 1; i <= count; i++) {
    commands.push(['Input.dispatchMouseEvent', { ...at, type: 'mousePressed', clickCount: i, buttons: 1 }]);
    commands.push(['Input.dispatchMouseEvent', { ...at, type: 'mouseReleased', clickCount: i, buttons: 0 }]);
  }
  return devtools(wc, commands);
}

function wheel(wc, x, y, deltaY) {
  return devtools(wc, [['Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }], ['Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }]]);
}

function insertText(wc, text) {
  return devtools(wc, [['Input.insertText', { text }]]);
}

// A key (browser.js's keyCode names: 'Enter', 'Up', 'A'…; key: what was
// asked, its case kept) with modifiers ('meta', 'control', 'alt', 'shift'),
// as the key events DevTools sends.
const NAMED = {
  Enter: [13, 'Enter', 'Enter', '\r'], Tab: [9, 'Tab', 'Tab', ''], Escape: [27, 'Escape', 'Escape', ''], Backspace: [8, 'Backspace', 'Backspace', ''],
  Delete: [46, 'Delete', 'Delete', ''], Space: [32, ' ', 'Space', ' '], Up: [38, 'ArrowUp', 'ArrowUp', ''], Down: [40, 'ArrowDown', 'ArrowDown', ''],
  Left: [37, 'ArrowLeft', 'ArrowLeft', ''], Right: [39, 'ArrowRight', 'ArrowRight', ''], Home: [36, 'Home', 'Home', ''], End: [35, 'End', 'End', ''],
  PageUp: [33, 'PageUp', 'PageUp', ''], PageDown: [34, 'PageDown', 'PageDown', ''],
};
for (let n = 1; n <= 12; n++) NAMED[`F${n}`] = [111 + n, `F${n}`, `F${n}`, ''];
const BITS = { alt: 1, control: 2, meta: 4, shift: 8 };
function keyEvents({ keyCode, key, modifiers }) {
  const bits = modifiers.reduce((m, k) => m | (BITS[k] || 0), 0);
  const plain = !modifiers.some((m) => m !== 'shift');
  let vk;
  let name;
  let code;
  let text;
  if (NAMED[keyCode]) [vk, name, code, text] = NAMED[keyCode];
  else if (key.length === 1) {
    const upper = key.toUpperCase();
    name = modifiers.includes('shift') ? upper : key;
    vk = /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0;
    code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(upper) ? `Digit${upper}` : '';
    text = name;
  } else { vk = 0; name = key; code = ''; text = ''; }
  if (!plain) text = '';
  const base = { modifiers: bits, windowsVirtualKeyCode: vk, key: name, code };
  return [
    { ...base, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text, unmodifiedText: text } : {}) },
    { ...base, type: 'keyUp' },
  ];
}
function keys(wc, parsed) {
  markSynthetic(wc); // not the person: Esc here doesn't stop Lumio
  return devtools(wc, keyEvents(parsed).map((e) => ['Input.dispatchKeyEvent', e]));
}

module.exports = {
  DEPTH, MAX_FRAMES, FRAME_TEXT, MASK_KEY, PAYMENT_HOSTS,
  matchFrames, contentBox, outward, inward, toDip, keyEvents, cleanSnap,
  inFrame, runner, byId, urls, payment, paymentHost, survey, coverage, read, place, outwards, focus, frameAt, inside, mask, states,
  click, wheel, insertText, keys, childrenOf, idOf,
};
