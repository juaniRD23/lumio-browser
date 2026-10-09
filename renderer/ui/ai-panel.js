// Lumio AI side panel: chat, streaming replies, tool steps, approvals,
// model picker, chat history. All model/tool work happens in the main process.
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { icons, markSvg, levelBars } from './icons.js';
import { reduced } from './motion.js';
import { initVoice } from './voice.js';
import { initWorkflows } from './panel-workflows.js';
import { initExtras, filesEl, madeEl } from './panel-extras.js';

const LEVEL = { low: 1, medium: 2, high: 3 }; // reasoning level -> bars

const SUGGESTIONS = [
  { title: 'Summarize this page', text: 'Summarize this page in a few bullet points.', page: true },
  { title: 'Find something for me', text: 'Search the web for the best-reviewed noise-cancelling headphones under $200 and compare the top 3.' },
  { title: 'Do it for me', text: 'Open Google Maps and find coffee shops open now near me.' },
  { title: 'Make a spreadsheet', text: 'Open Excel on the web and start a simple monthly budget for me.' },
];

// Approval modes, for the button under the chat box.
const MODES = { ask: { name: 'Ask', icon: icons.shield }, auto: { name: 'Auto', icon: icons.bolt }, bypass: { name: 'Bypass', icon: icons.warn } };

const RISK_LABEL = { browser: 'Browser action' };

const $ = (s) => document.querySelector(s);
// Prompts Lumio writes for you, in Lumio's language (renderer/assets/i18n).
const tr = (text) => window.lumioI18n?.t(text) ?? text;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

marked.setOptions({ gfm: true, breaks: true });
const PURIFY = { FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input', 'video', 'audio', 'source', 'object', 'embed'], FORBID_ATTR: ['style'] };
const renderMd = (text) => DOMPurify.sanitize(marked.parse(String(text || '')), PURIFY);

// While a reply streams, only its unfinished last block is parsed again; the
// blocks before it are drawn once. Returns where the finished blocks end: the
// last blank line that isn't inside a ``` code fence.
export function stableEnd(text, from = 0) {
  let end = from;
  let fence = false;
  let i = from;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    const line = text.slice(i, nl < 0 ? text.length : nl);
    if (nl < 0) break; // the last line may still be growing
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && !line.trim() && i > from) end = nl + 1;
    i = nl + 1;
  }
  return end;
}
const STREAM_MS = 100; // redraw a streaming reply about 10 times a second

export function initPanel({ api, getActiveTab, onLayout, setRunning }) {
  const body = document.body;
  const messages = $('#messages');
  const prompt = $('#prompt');
  const sendBtn = $('#send');
  const chip = $('#context-chip');

  let ai = { ready: false, lumio: {}, model: '', modelName: '', reasoning: 'medium', reasoningName: 'Medium', reasoningLevels: [], mode: 'ask', running: false, vision: true };
  let chatId = null;
  let panelOpen = true;
  let includePage = true;
  let includeTabs = false; // "Ask about my tabs": the next message reads every open tab
  let chatProject = null; // the open chat's project (or the one a new chat will start in)
  let projectsCache = [];
  const chatWatchers = new Set(); // the sidebar follows which chat is open
  const includedUrl = new Map(); // chatId -> last page URL sent as context
  let live = null; // { textEl, textBuf, thinkingEl, steps: Map }
  let plan = null; // the current chat's checklist from update_plan

  // + menu (files, connections), attachments tray, usage ring, made files.
  const extras = initExtras({ api, getAi: () => ai, onChange: () => renderState(), notice: (t) => notice(t) });
  // Dictation and hands-free voice mode.
  $('#mic-btn').innerHTML = icons.mic;
  $('#voice-btn').innerHTML = icons.wave;
  const voice = initVoice({
    api, prompt, autosize: () => autosize(), notice: (t) => notice(t),
    submit: (text, opts) => submit(text, undefined, null, opts),
    isReady: () => !!ai.ready,
    isBusy: () => !!(ai.running && ai.runChatId === chatId),
    getChatId: () => chatId,
    onChange: () => renderState(),
  });
  $('#voice-bar .vb-mute').innerHTML = icons.mic;
  // Saved workflows: / in the chat box, the blanks card, Save as workflow.
  const wf = initWorkflows({
    api, prompt, autosize: () => autosize(), notice: (t) => notice(t),
    isEnabled: () => !!ai.workflows,
    run: (id, values) => runWorkflow(id, values),
    onSave: () => submit(tr('Save what you just did as a workflow I can run again. Make the steps general, with {blanks} for anything that changes each time.')),
  });
  // Runs a saved workflow in a new chat.
  async function runWorkflow(id, values) {
    if (!ai.ready) { renderEmpty(); return false; }
    if (ai.running) { notice('Lumio is still working. Press Stop first, then run the workflow.'); return false; }
    newChat();
    const res = await api.invoke('ai:send', { chatId: null, workflow: { id, values } });
    if (!res.ok) { notice(res.error); return false; }
    return true;
  }
  api.on('ai-workflow', ({ id }) => { setOpen(true); wf.open(id); });
  let lastAsk = null; // the latest message's context, to know a workflow run

  // ------------------------------------------------------------ chrome
  $('#panel-mark').innerHTML = markSvg(18);
  $('#chats-btn').innerHTML = icons.chats;
  $('#newchat-btn').innerHTML = icons.compose;
  $('#panel-close').innerHTML = icons.panel;
  sendBtn.innerHTML = icons.send;

  function setOpen(open, save = true) {
    panelOpen = open;
    if (!open) setFull(false);
    body.classList.toggle('panel-closed', !open);
    $('#panel').inert = !open;
    $('#ai-toggle').classList.toggle('on', open);
    if (save) api.send('panel:set', { open });
    onLayout();
    if (open) requestAnimationFrame(() => prompt.focus());
  }
  // The page follows the sliding panel through the slot's ResizeObserver;
  // report once more when the slide ends so the final size is exact.
  $('#panel').addEventListener('transitionend', (e) => { if (e.target === e.currentTarget && e.propertyName === 'width') onLayout(); });
  $('#ai-toggle').addEventListener('click', () => setOpen(!panelOpen));
  $('#panel-close').addEventListener('click', () => setOpen(false));
  api.on('panel-toggle', () => setOpen(!panelOpen));
  api.on('panel-open', () => { if (!panelOpen) setOpen(true); });
  api.on('ai-focus', () => { if (!panelOpen) setOpen(true); prompt.focus(); });

  // ------------------------------------------------------------ full-size chat
  // Asking from the new tab page opens the chat over the whole page area, like
  // a chat page. Switching tabs, going to another page, or Lumio starting to
  // work on a page puts it back beside the page.
  const PAGE_TOOLS = new Set(['read_page', 'click', 'click_at', 'type', 'press_key', 'scroll', 'select_option', 'navigate', 'go_back', 'open_tab', 'switch_tab', 'close_tab', 'screenshot_tab']);
  let full = null; // { tabId, url } of the tab it covers, while full size
  function setFull(on) {
    if (!!full === !!on) return;
    const t = getActiveTab();
    full = on ? { tabId: t?.id ?? null, url: t?.url || '' } : null;
    body.classList.toggle('chat-full', !!full);
    renderFull();
    if (full) { api.send('panel:full', { on: true }); return; }
    // Show the page again where the slot is now, without a frame at the old size.
    requestAnimationFrame(() => {
      const r = $('#slot').getBoundingClientRect();
      api.send('panel:full', { on: false, slot: { x: r.left, y: r.top, width: r.width, height: r.height } });
    });
  }
  function renderFull() {
    const b = $('#expand-btn');
    b.innerHTML = full ? icons.shrink : icons.expand;
    b.title = full ? 'Show the page' : 'Full-size chat';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(!!full));
    const close = $('#panel-close');
    close.innerHTML = full ? icons.x : icons.panel;
    close.title = full ? 'Close chat (⌘⇧L)' : 'Hide (⌘⇧L)';
  }
  $('#expand-btn').addEventListener('click', () => setFull(!full));
  renderFull();

  // resize
  const resizer = $('#resizer');
  resizer.addEventListener('pointerdown', (e) => {
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('dragging');
    body.classList.add('resizing'); // follow the pointer without the open/close easing
    const move = (ev) => {
      const w = Math.max(320, Math.min(760, window.innerWidth - ev.clientX - 8));
      document.documentElement.style.setProperty('--panel-w', w + 'px');
      onLayout();
    };
    const up = () => {
      resizer.classList.remove('dragging');
      body.classList.remove('resizing');
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--panel-w'), 10);
      api.send('panel:set', { width: w });
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
  });

  // spinning mark while working (same idea as the Lumio web app)
  const spinners = [];
  function spin(active) {
    for (const el of [$('#panel-mark'), $('#ai-toggle .mark')]) {
      let s = spinners.find((x) => x.el === el);
      if (!s) { s = { el, anim: null }; spinners.push(s); }
      if (reduced()) continue;
      if (active) {
        s.anim ??= el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 1200, iterations: Infinity });
      } else if (s.anim) {
        const angle = ((s.anim.currentTime || 0) % 1200) / 1200 * 360;
        const target = Math.ceil((angle + 60) / 360) * 360;
        s.anim.cancel();
        s.anim = null;
        el.animate([{ transform: `rotate(${angle}deg)` }, { transform: `rotate(${target}deg)` }], { duration: 300 + (target - angle) * 2, easing: 'cubic-bezier(.3,.3,.3,1)' });
      }
    }
  }

  // ------------------------------------------------------------ state
  function renderState() {
    const level = LEVEL[ai.reasoning] || 2;
    $('#reasoning-bars').innerHTML = levelBars(level);
    $('#reasoning-name').textContent = ai.reasoningName || 'Medium';
    $('#reasoning-btn').title = `Thinking effort: ${ai.reasoningName || 'Medium'} (${ai.modelName})`;
    if (!$('#reasoning-menu').hidden && !$('#effort-slider').classList.contains('dragging')) renderModels();
    renderMode();
    const running = ai.running && ai.runChatId === chatId;
    const steering = running && !!prompt.value.trim(); // typing while it works: Send adds to the task
    sendBtn.classList.toggle('stop', running && !steering);
    sendBtn.innerHTML = running && !steering ? icons.square : icons.send;
    sendBtn.title = steering ? 'Add to the task (↵)' : running ? 'Stop (Esc)' : 'Send (↵)';
    prompt.placeholder = running ? 'Add to the task, or tell Lumio to stop…' : 'Ask Lumio, or tell it what to do…';
    sendBtn.disabled = !running && ((!prompt.value.trim() && !extras.ready()) || extras.busy() || !ai.ready);
    // An empty box offers voice mode where Send is (and Send comes back as you type).
    const talk = document.body.classList.contains('voice-on') || (!running && ai.ready && !prompt.value.trim() && !extras.ready() && !extras.busy());
    sendBtn.hidden = !!talk;
    $('#voice-btn').hidden = !talk;
    extras.renderRing();
    setRunning(!!ai.running);
    spin(!!ai.running);
    planEl.classList.toggle('live', !!(ai.running && ai.runChatId === chatId));
    if (!chatId && !messages.querySelector('.msg')) renderEmpty();
  }

  // ------------------------------------------------------------ task progress
  const planEl = $('#plan');
  const planList = $('#plan-list');
  $('#plan-head .plan-ic').innerHTML = icons.list;
  const STEP_ICON = { done: icons.stepDone, in_progress: icons.stepNow, pending: icons.stepTodo };
  const STEP_WORD = { done: 'Done', in_progress: 'In progress', pending: 'Not started' };
  function setPlanCollapsed(collapsed) {
    planEl.classList.toggle('collapsed', collapsed);
    $('#plan-head').setAttribute('aria-expanded', String(!collapsed));
  }
  $('#plan-head').addEventListener('click', () => setPlanCollapsed(!planEl.classList.contains('collapsed')));
  function renderPlan(changed = false) {
    planEl.hidden = !plan;
    planEl.classList.toggle('live', !!(ai.running && ai.runChatId === chatId));
    if (!plan) return;
    const before = [...planList.children].map((li) => li.dataset.key);
    planList.innerHTML = '';
    plan.forEach((step, i) => {
      const li = document.createElement('li');
      li.className = `plan-step ${step.status}`;
      li.dataset.key = `${step.status}:${step.title}`;
      li.innerHTML = `<span class="ic" role="img" aria-label="${STEP_WORD[step.status]}">${STEP_ICON[step.status]}</span><span class="t"></span>`;
      li.querySelector('.t').textContent = step.title;
      if (changed && before[i] !== li.dataset.key) li.classList.add('flash');
      planList.append(li);
    });
    const done = plan.filter((x) => x.status === 'done').length;
    $('#plan-count').textContent = `${done}/${plan.length}`;
    $('#plan-now').textContent = (plan.find((x) => x.status === 'in_progress') || plan.find((x) => x.status === 'pending'))?.title || '';
  }
  function showPlan(items, { changed = false } = {}) {
    const first = !plan && items;
    plan = items || null;
    if (first) setPlanCollapsed(false);
    renderPlan(changed);
  }

  api.on('ai-state', (s) => {
    const key = (x) => `${x.ready}|${!!x.lumio?.signedIn}|${!!x.lumio?.connecting}`;
    const before = key(ai);
    ai = s;
    renderState();
    renderSuggest();
    // Signing in or out changes the empty panel's card.
    if (messages.querySelector('.empty') && before !== key(ai)) renderEmpty();
  });

  // ------------------------------------------------------------ approvals
  // One button shows the mode; its menu has Ask, Auto and Bypass.
  const modeBtn = $('#mode-btn');
  const modeMenu = $('#mode-menu');
  modeMenu.querySelectorAll('[data-mode]').forEach((b) => {
    b.querySelector('.mi').innerHTML = MODES[b.dataset.mode].icon;
    b.querySelector('.tick').innerHTML = icons.check;
  });
  // (Runs from renderState, which can come before the lines below.)
  function renderMode() {
    const m = MODES[ai.mode] ? ai.mode : 'ask';
    const btn = $('#mode-btn');
    $('#mode-ic').innerHTML = MODES[m].icon;
    $('#mode-name').textContent = MODES[m].name;
    btn.classList.toggle('auto', m === 'auto');
    btn.classList.toggle('bypass', m === 'bypass');
    btn.title = `Approvals: ${MODES[m].name}`;
    $('#mode-menu').querySelectorAll('[data-mode]').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === m);
      b.setAttribute('aria-checked', String(b.dataset.mode === m));
    });
  }
  function closeMode() { modeMenu.hidden = true; modeBtn.setAttribute('aria-expanded', 'false'); }
  function openMode() {
    document.querySelectorAll('#composer .popover').forEach((p) => { if (p !== modeMenu) p.hidden = true; });
    document.querySelectorAll('#composer [aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    modeMenu.hidden = false;
    modeBtn.setAttribute('aria-expanded', 'true');
    (modeMenu.querySelector('.menu-row.on') || modeMenu.querySelector('.menu-row')).focus();
  }
  modeBtn.addEventListener('click', () => (modeMenu.hidden ? openMode() : closeMode()));
  modeMenu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    closeMode();
    ai = await api.invoke('ai:set-mode', b.dataset.mode);
    renderState();
    prompt.focus();
  });
  modeMenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeMode(); modeBtn.focus(); return; }
    const rows = [...modeMenu.querySelectorAll('.menu-row')];
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) { e.preventDefault(); rows[(rows.indexOf(document.activeElement) + step + rows.length) % rows.length].focus(); }
  });
  document.addEventListener('mousedown', (e) => { if (!modeMenu.hidden && !e.target.closest('#mode-menu, #mode-btn')) closeMode(); });

  // ------------------------------------------------------------ context chip
  function renderChip() {
    renderSuggest();
    const t = getActiveTab();
    if (includeTabs) {
      chip.hidden = false;
      chip.classList.remove('off');
      chip.querySelector('i').innerHTML = icons.tabs;
      chip.querySelector('span').textContent = 'All open tabs';
      chip.querySelector('button').textContent = '×';
      chip.title = 'Lumio will read all your open tabs with your message. Click × to just use this page.';
      return;
    }
    const web = t && /^(https?:|file:.*\.pdf)/i.test(t.url || '');
    chip.hidden = !web;
    if (!web) return;
    chip.classList.toggle('off', !includePage);
    chip.querySelector('i').innerHTML = t.favicon ? `<img src="${esc(t.favicon)}" alt="">` : icons.page;
    chip.querySelector('span').textContent = t.title || t.url;
    chip.querySelector('button').textContent = includePage ? '×' : '+';
    chip.title = includePage ? 'Lumio will read this page with your message. Click × to leave it out.' : 'Click + to include this page.';
  }
  chip.addEventListener('click', () => {
    if (includeTabs) includeTabs = false;
    else includePage = !includePage;
    renderChip();
  });
  $('#add-tabs').addEventListener('click', () => {
    extras.closePlus();
    includeTabs = true;
    renderChip();
    if (!prompt.value.trim()) { prompt.value = 'Which of my tabs '; autosize(); }
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  });

  // ------------------------------------------------------------ summarize suggestion
  // On a YouTube video or a PDF, one tap summarizes it (once per chat and page).
  const VIDEO = /^https:\/\/(www\.|m\.)?youtube\.com\/(watch\?|shorts\/|live\/)/;
  const summarized = new Set(); // `${chatId}|${url}`
  const suggestBtn = $('#page-suggest');
  function suggestKind(t) {
    if (!t) return null;
    if (t.pdf) return 'pdf';
    if (VIDEO.test(t.url || '')) return 'video';
    return null;
  }
  function renderSuggest() {
    const t = getActiveTab();
    const kind = suggestKind(t);
    const show = kind && ai.ready && !summarized.has(`${chatId}|${t.url}`);
    suggestBtn.hidden = !show;
    if (!show) return;
    suggestBtn.dataset.kind = kind;
    suggestBtn.innerHTML = `${kind === 'video' ? icons.play : icons.page}<span>Summarize this ${kind === 'video' ? 'video' : 'PDF'}</span>`;
  }
  suggestBtn.addEventListener('click', async () => {
    const t = getActiveTab();
    const kind = suggestKind(t);
    if (!kind) return;
    if (ai.running) { notice('Lumio is still working. Press Stop first.'); return; }
    summarized.add(`${chatId}|${t.url}`);
    renderSuggest();
    let res = null;
    if (kind === 'video') res = await submit(tr('Summarize this video: a one-line takeaway first, then the key points with their timestamps.'), true);
    else {
      const items = await readTabPdf(t);
      if (items) res = await submit(tr('Summarize this PDF: a one-line takeaway first, then the key points.'), false, items);
    }
    if (res?.chatId) summarized.add(`${res.chatId}|${t.url}`);
    renderSuggest();
  });

  // The PDF open in a tab, read like an attached file.
  async function readTabPdf(t) {
    const wait = notice('Reading the PDF…', 'info');
    try {
      const got = await api.invoke('ai:tab-pdf', t.id);
      if (got.error) { notice(got.error); return null; }
      return await extras.read(new File([got.data], got.name, { type: 'application/pdf' }));
    } catch (err) {
      notice(`Couldn’t read the PDF: ${err.message}`);
      return null;
    } finally { wait.remove(); }
  }

  // ------------------------------------------------------------ composer
  function autosize() {
    prompt.style.height = 'auto';
    prompt.style.height = Math.min(180, prompt.scrollHeight) + 'px';
    renderState();
  }
  prompt.addEventListener('input', () => { autosize(); wf.onInput(); });
  prompt.addEventListener('blur', () => setTimeout(() => wf.closeMenu(), 150));
  prompt.addEventListener('focus', () => $('#composer').classList.add('focused'));
  prompt.addEventListener('blur', () => $('#composer').classList.remove('focused'));
  prompt.addEventListener('keydown', (e) => {
    if (wf.onKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    if (e.key === 'Escape' && ai.running) { e.preventDefault(); api.send('ai:stop'); }
  });
  sendBtn.addEventListener('click', () => {
    if (ai.running && ai.runChatId === chatId && !prompt.value.trim()) api.send('ai:stop');
    else submit();
  });

  async function submit(textOverride, forcePage, extraFiles = null, { voice = false } = {}) {
    const text = (textOverride ?? prompt.value).trim();
    const useFiles = textOverride == null;
    if (!text && !(useFiles && extras.ready())) return;
    if (!ai.ready) { renderEmpty(); $('#key-input')?.focus(); return; }
    // While Lumio works on this chat, a message joins the task ("actually,
    // use Best Buy"; "stop" stops it).
    if (ai.running && ai.runChatId === chatId && text) {
      if (useFiles && extras.ready()) { notice('Add files after Lumio finishes, or press Stop first.'); return; }
      if (useFiles) { prompt.value = ''; autosize(); }
      const res = await api.invoke('ai:steer', { chatId, text, voice });
      if (!res.ok && !res.notRunning) { notice(res.error); return res; }
      if (res.ok) return res;
    }
    if (ai.running) { notice('Lumio is still working on another chat. Press Stop first.'); return; }
    if (useFiles && extras.busy()) { notice('Still reading your files. Send again in a moment.'); return; }
    const attachments = useFiles ? extras.take() : (extraFiles || []);
    if (attachments === null) return;
    const t = getActiveTab();
    const url = t?.url || '';
    const web = /^https?:/.test(url) || !!t?.pdf;
    const tabs = includeTabs;
    let wantPage = !tabs && web && (forcePage || (includePage && includedUrl.get(chatId) !== url));
    if (textOverride == null) { prompt.value = ''; autosize(); }
    // A PDF's text comes from the file itself (the page only shows the viewer).
    if (wantPage && t.pdf) {
      wantPage = false;
      const items = await readTabPdf(t);
      if (items) {
        if (attachments.length + items.length > 10) { notice('That’s too many files with this PDF. Attach up to 10.'); return; }
        attachments.push(...items);
        includedUrl.set(chatId, url);
      }
    }
    const res = await api.invoke('ai:send', { chatId, text, includePage: wantPage, includeTabs: tabs, attachments, voice, ...(chatId ? {} : { projectId: chatProject }) });
    if (!res.ok) { notice(res.error); return; }
    if (tabs) { includeTabs = false; renderChip(); }
    if (wantPage || (t?.pdf && includedUrl.get(chatId) === url)) includedUrl.set(res.chatId, url);
    return res;
  }

  // ------------------------------------------------------------ rendering
  // The chat sticks to the bottom while Lumio writes, unless the person
  // scrolled up to read; then a pill offers the way back.
  let stick = true;
  const jumpWrap = document.createElement('div');
  jumpWrap.className = 'jump-wrap';
  jumpWrap.innerHTML = `<button id="jump-latest" type="button" class="jump-latest" tabindex="-1" aria-hidden="true">${icons.arrowDown}<span>Jump to latest</span></button>`;
  const jump = jumpWrap.firstElementChild;
  messages.after(jumpWrap);
  const fromBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight;
  function showJump(on) {
    if (jump.classList.contains('show') === on) return;
    jump.classList.toggle('show', on);
    jump.tabIndex = on ? 0 : -1;
    jump.setAttribute('aria-hidden', String(!on));
  }
  messages.addEventListener('scroll', () => {
    stick = fromBottom() < 32;
    if (stick) showJump(false);
  }, { passive: true });
  jump.addEventListener('click', () => { scrollDown(true); prompt.focus(); });
  function scrollDown(force) {
    if (force) stick = true;
    if (stick) { messages.scrollTop = messages.scrollHeight; showJump(false); }
    else if (fromBottom() > 32) showJump(true);
  }

  // Screen readers hear each finished answer once, not every word as it streams.
  const announcer = document.createElement('div');
  announcer.className = 'sr-only';
  announcer.setAttribute('aria-live', 'polite');
  announcer.id = 'ai-announce';
  messages.after(announcer);
  function announce(text) {
    const t = String(text || '').replace(/[#*_`>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return;
    announcer.textContent = '';
    // A fresh node, a frame later, so the same words twice are still read.
    requestAnimationFrame(() => { announcer.textContent = `${t.length > 600 ? t.slice(0, 600) + '…' : t}`; });
  }

  // Under a finished task: how long it took, and where the time went.
  function timingEl(t) {
    const sec = (ms) => (ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000));
    const el = document.createElement('div');
    el.className = 'task-timing';
    el.textContent = `Done in ${sec(t.ms)} s · ${t.steps} steps · thinking ${sec(t.modelMs)} s, actions ${sec(t.toolMs)} s`;
    return el;
  }

  let replaying = false; // drawing a saved chat: nothing to announce
  function notice(text, cls = '') {
    if (!replaying) announce(text);
    const el = document.createElement('div');
    el.className = 'notice ' + cls;
    el.textContent = text;
    messages.querySelector('.empty')?.remove();
    messages.append(el);
    scrollDown(true);
    return el;
  }

  function renderEmpty() {
    messages.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'empty';
    if (!ai.ready) {
      // Lumio AI runs on the person's Lumio plan. Free includes a little.
      const l = ai.lumio || {};
      el.innerHTML = `
        <div class="hero-mark">${markSvg(34, true)}</div>
        <h2>Sign in to use Lumio AI</h2>
        ${l.connecting
    ? '<p>Continue with Google on the Lumio tab that opened. Lumio Browser signs in with you.</p>'
    : `<p>Lumio AI runs on your Lumio account. It’s free to start, and paid plans from $10 a month give you much more.</p>
        <button class="btn primary" id="lumio-sign-in">Sign in to Lumio</button>`}`;
      messages.append(el);
      el.querySelector('#lumio-sign-in')?.addEventListener('click', () => api.send('account:sign-in'));
      return;
    }
    el.innerHTML = `
      <div class="hero-mark">${markSvg(34, true)}</div>
      <h2>What can I help with?</h2>
      <p>Ask anything, or tell me what to do. I can read and use web pages, and I'll ask before I act.</p>
      ${ai.ephemeral ? '<p class="incog-note">You’re incognito: chats here aren’t saved.</p>' : ''}
      <div class="suggestions">${SUGGESTIONS.map((s, i) => `<button class="suggestion" data-i="${i}"><b>${esc(s.title)}</b>${esc(s.text)}</button>`).join('')}</div>`;
    messages.append(el);
    el.querySelectorAll('.suggestion').forEach((b) => b.addEventListener('click', () => {
      const s = SUGGESTIONS[Number(b.dataset.i)];
      submit(tr(s.text), !!s.page);
    }));
  }

  function userEl(text, ctx, files) {
    const el = document.createElement('div');
    el.className = 'msg user';
    if (files?.length) el.append(filesEl(files));
    if (ctx?.title) {
      const c = document.createElement('div');
      c.className = 'ctx';
      c.innerHTML = `${ctx.workflow ? icons.workflow : ctx.scheduled ? icons.clock : ctx.tabs ? icons.tabs : ctx.video ? icons.play : icons.page}<span></span>`;
      c.querySelector('span').textContent = ctx.title;
      el.append(c);
    }
    if (text) {
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = text;
      el.append(b);
    }
    return el;
  }

  function aiEl(text, streaming) {
    const el = document.createElement('div');
    el.className = 'msg ai' + (streaming ? ' streaming' : '');
    el.innerHTML = renderMd(text);
    decorate(el);
    return el;
  }

  function decorate(el) {
    el.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.copy')) return;
      const b = document.createElement('button');
      b.className = 'icon-btn small copy';
      b.title = 'Copy';
      b.innerHTML = icons.copy;
      b.addEventListener('click', () => {
        navigator.clipboard.writeText(pre.querySelector('code')?.innerText || pre.innerText);
        b.innerHTML = icons.check;
        setTimeout(() => { b.innerHTML = icons.copy; }, 1200);
      });
      pre.append(b);
    });
  }

  function stepEl(s) {
    const el = document.createElement('div');
    el.className = 'step ' + (s.status || 'running');
    el.dataset.id = s.id;
    el.innerHTML = `<span class="s-icon">${icons[s.icon] || icons.app}</span><span class="s-label"></span><span class="s-state"></span>`;
    el.querySelector('.s-label').textContent = s.label;
    setStepStatus(el, s.status || 'running', s.summary);
    if (s.helpers?.length) {
      const frag = document.createDocumentFragment();
      frag.append(el);
      for (const h of s.helpers) setHelperRow(el, h, frag);
      return frag;
    }
    return el;
  }

  // Helper AIs (send_helpers): one row each under the step, in the helper's
  // color (the same as the dot on its tab). Click a row to watch its tab.
  function setHelperRow(stepEl, h, into = null) {
    let list = into ? into.querySelector?.(`.helpers[data-parent="${CSS.escape(stepEl.dataset.id)}"]`) : stepEl.nextElementSibling;
    if (!list?.classList?.contains('helpers')) {
      list = document.createElement('div');
      list.className = 'helpers';
      list.dataset.parent = stepEl.dataset.id;
      if (into) into.append(list); else stepEl.after(list);
    }
    let row = list.querySelector(`[data-n="${h.n}"]`);
    if (!row) {
      row = document.createElement('button');
      row.type = 'button';
      row.className = 'helper';
      row.dataset.n = h.n;
      row.innerHTML = '<i class="h-dot"></i><span class="h-main"><b></b><small></small></span><span class="h-state"></span>';
      row.addEventListener('click', () => { if (row.dataset.tab) api.send('tab:activate', Number(row.dataset.tab)); });
      list.append(row);
    }
    row.style.setProperty('--c', h.color);
    row.classList.toggle('working', h.status === 'working');
    row.classList.toggle('failed', h.status === 'failed' || h.status === 'stopped');
    if (h.tabId) row.dataset.tab = h.tabId;
    row.title = `Helper ${h.n} (${h.colorName || ''})${h.status === 'working' ? ': click to watch its tab' : ''}`;
    row.querySelector('b').textContent = h.title;
    row.querySelector('small').textContent = h.label || '';
    row.querySelector('.h-state').innerHTML = h.status === 'working' ? '<span class="spinner"></span>' : h.status === 'done' ? icons.check : icons.x;
  }

  function setStepStatus(el, status, summary) {
    el.className = 'step ' + status;
    const st = el.querySelector('.s-state');
    st.innerHTML = status === 'running' ? '<span class="spinner"></span>' : status === 'ok' ? icons.check : status === 'blocked' ? icons.warn : icons.x;
    if (summary) el.title = summary;
    const label = el.querySelector('.s-label');
    if (!label.dataset.base) label.dataset.base = label.textContent;
    const suffix = status === 'denied' ? 'denied' : (status === 'error' || status === 'blocked') ? summary : '';
    label.textContent = suffix ? `${label.dataset.base} — ${suffix}` : label.dataset.base;
  }

  function approvalEl(a) {
    const el = document.createElement('div');
    el.className = 'approval';
    el.dataset.id = a.id;
    const detail = a.detail && a.detail !== a.label ? a.detail : '';
    const code = /\n/.test(detail);
    el.innerHTML = `
      <div class="a-title"><span></span></div>
      <div class="a-detail"></div>
      ${code ? '<pre></pre>' : ''}
      <div class="a-actions">
        <button class="btn primary" data-d="once">Allow</button>
        <button class="btn" data-d="task">Allow for this task</button>
        <button class="btn ghost" data-d="deny">Deny</button>
      </div>`;
    el.querySelector('.a-title span').textContent = `Lumio wants to: ${a.label}`;
    el.querySelector('.a-detail').textContent = RISK_LABEL[a.risk] || '';
    if (code) el.querySelector('pre').textContent = detail;
    else if (detail) el.querySelector('.a-detail').textContent += ` · ${detail}`;
    el.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => {
      api.send('ai:approve', { callId: a.id, decision: b.dataset.d });
      el.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    }));
    return el;
  }


  // Out of Lumio allowance: offer the upgrade right in the chat.
  function limitNotice(text) {
    const el = notice(text, 'info');
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.style.marginLeft = '8px';
    b.textContent = 'Upgrade';
    b.addEventListener('click', () => api.send('account:open', 'upgrade'));
    el.append(b);
    return el;
  }

  function renderChat(display) {
    messages.innerHTML = '';
    replaying = true;
    for (const d of display) {
      if (d.kind === 'user') messages.append(userEl(d.text, d.ctx, d.files));
      else if (d.kind === 'made') messages.append(madeEl(d.file, api));
      else if (d.kind === 'ai') messages.append(aiEl(d.text));
      else if (d.kind === 'step') messages.append(stepEl(d));
      else if (d.kind === 'approval' && !d.decision) messages.append(approvalEl(d));
      else if (d.kind === 'note') notice(d.text, 'info');
      else if (d.kind === 'timing') messages.append(timingEl(d));
      else if (d.kind === 'error') { if (d.code === 'usage_limit') limitNotice(d.text); else notice(d.text); }
    }
    replaying = false;
    // History appears at once; only what arrives from now on moves in.
    for (const el of messages.querySelectorAll(':scope > *, .helper')) el.classList.add('old');
    showJump(false);
    scrollDown(true);
  }

  // ------------------------------------------------------------ live events
  function thinking(on) {
    if (!live) return;
    if (on && !live.thinkingEl) {
      live.thinkingEl = document.createElement('div');
      live.thinkingEl.className = 'thinking';
      live.thinkingEl.innerHTML = '<span class="spinner"></span><span class="shimmer">Thinking…</span>';
      messages.append(live.thinkingEl);
      scrollDown();
    } else if (!on && live.thinkingEl) {
      live.thinkingEl.remove();
      live.thinkingEl = null;
    }
  }

  function endText() {
    if (!live?.textEl) return;
    clearTimeout(frame);
    frame = 0;
    live.textEl.classList.remove('streaming');
    live.textEl.innerHTML = renderMd(live.textBuf);
    decorate(live.textEl);
    live.said = (live.said ? live.said + ' ' : '') + live.textBuf;
    live.textEl = null;
    live.textBuf = '';
    live.stable = 0;
    live.tail = [];
    scrollDown();
  }

  // Draws the streaming reply: blocks that are finished are parsed once and
  // stay; only the last one is parsed again. At most every STREAM_MS.
  let frame = 0;
  let lastFlush = 0;
  function queueFlush() {
    if (frame) return;
    const wait = Math.max(0, STREAM_MS - (performance.now() - lastFlush));
    frame = setTimeout(() => requestAnimationFrame(flushText), wait);
  }
  function flushText() {
    frame = 0;
    lastFlush = performance.now();
    const l = live;
    if (!l?.textEl) return;
    l.stable ??= 0;
    l.tail ??= [];
    for (const n of l.tail) n.remove();
    const end = stableEnd(l.textBuf, l.stable);
    if (end > l.stable) {
      const done = document.createElement('template');
      done.innerHTML = renderMd(l.textBuf.slice(l.stable, end));
      l.textEl.append(done.content);
      l.stable = end;
    }
    const tail = document.createElement('template');
    tail.innerHTML = renderMd(l.textBuf.slice(l.stable));
    l.tail = [...tail.content.childNodes];
    l.textEl.append(tail.content);
    scrollDown();
  }

  api.on('ai-event', (ev) => {
    voice.onEvent(ev);
    if (ev.chatId === chatId || !chatId) {
      if (ev.type === 'user' && !ev.mid) lastAsk = ev.ctx || null;
      // Ended early (an error, Stop, stuck or the safety limit): nothing to save as a workflow.
      if ((ev.type === 'error' || ev.type === 'stopped' || (ev.type === 'done' && (ev.reason === 'stuck' || ev.reason === 'max_steps'))) && live) live.failed = true;
    }
    if (ev.type === 'user') {
      // A scheduled task shows up in an empty panel, unless you're typing there.
      if ((!chatId && !(ev.background && prompt.value.trim())) || chatId === ev.chatId) {
        if (!chatId) messages.innerHTML = '';
        if (chatId !== ev.chatId) { chatId = ev.chatId; chatChanged(); }
        if (ev.mid) {
          // Said while Lumio works: its next words start a new reply below this.
          if (live) {
            if (frame) { clearTimeout(frame); flushText(); } // finish drawing the reply so far
            thinking(false);
            endText();
          }
        } else showPlan(null); // each request starts fresh; the AI posts a new checklist if it needs one
        messages.append(userEl(ev.text, ev.ctx, ev.files));
        if (ev.mid && live) thinking(true);
        scrollDown(true);
      }
      return;
    }
    if (ev.chatId !== chatId) return;
    switch (ev.type) {
      case 'start':
        live = { textEl: null, textBuf: '', thinkingEl: null, steps: new Map() };
        thinking(true);
        break;
      case 'thinking':
        if (!live?.textEl) thinking(true);
        break;
      case 'text':
        if (!live) break;
        thinking(false);
        if (!live.textEl) {
          live.textEl = aiEl('', true);
          messages.append(live.textEl);
        }
        live.textBuf += ev.delta;
        queueFlush();
        break;
      case 'text_end':
        endText();
        break;
      case 'step': {
        if (full && PAGE_TOOLS.has(ev.name)) setFull(false); // let them watch the page
        if (!live) break;
        endText();
        thinking(false);
        const el = stepEl({ ...ev, status: 'running' });
        live.steps.set(ev.id, el);
        messages.append(el);
        scrollDown();
        break;
      }
      case 'made':
        endText();
        thinking(false);
        messages.append(madeEl(ev.file, api));
        scrollDown(true);
        break;
      case 'plan':
        showPlan(ev.items, { changed: true });
        break;
      case 'approval':
        messages.append(approvalEl(ev));
        scrollDown(true);
        if (!panelOpen) setOpen(true);
        break;
      case 'approval_done': {
        // The step chip above already shows the outcome; drop the card.
        const el = messages.querySelector(`.approval[data-id="${CSS.escape(ev.id)}"]`);
        if (el) el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-4px) scale(.98)' }], { duration: reduced() ? 0 : 140, easing: 'cubic-bezier(.55, 0, 1, .45)' }).onfinish = () => el.remove();
        break;
      }
      case 'helper': {
        const el = live?.steps.get(ev.parent) || messages.querySelector(`.step[data-id="${CSS.escape(ev.parent || '')}"]`);
        if (el) { setHelperRow(el, ev.helper); scrollDown(); }
        break;
      }
      case 'step_done': {
        const el = live?.steps.get(ev.id);
        if (el) {
          setStepStatus(el, ev.status, ev.summary);
          el.classList.add('changed'); // the spinner turns into its result
          if (ev.thumb) {
            const img = document.createElement('img');
            img.className = 'step-thumb';
            img.src = ev.thumb;
            img.alt = 'Screenshot';
            el.after(img);
          }
        }
        scrollDown();
        break;
      }
      case 'done':
        endText();
        thinking(false);
        if (ev.note) notice(ev.note, 'info'); // why it ended before Lumio was done (stuck, the safety limit, a cut-off reply)
        if (ev.timing?.steps > 1) { messages.append(timingEl(ev.timing)); scrollDown(); }
        break;
      case 'stopped':
        endText();
        thinking(false);
        notice('Stopped.', 'info');
        break;
      case 'error':
        endText();
        thinking(false);
        if (ev.code === 'usage_limit') limitNotice(ev.message);
        else notice(ev.message);
        break;
      case 'end':
        endText();
        thinking(false);
        messages.querySelectorAll('.step.running').forEach((el) => setStepStatus(el, 'error', 'Stopped'));
        messages.querySelectorAll('.approval:not(.done)').forEach((el) => el.classList.add('done'));
        // A task with several steps that finished well: offer to save it.
        if (live && !live.failed && live.steps.size >= 2 && !lastAsk?.workflow && !lastAsk?.scheduled) {
          const steps = [...live.steps.keys()];
          if (!steps.some((id) => messages.querySelector(`.step[data-id="${CSS.escape(id)}"] .s-label`)?.textContent.startsWith('Saving workflow'))) {
            wf.offerSave([...messages.querySelectorAll('.msg.ai')].at(-1) || messages.lastElementChild);
          }
        }
        if (live?.said) announce(`Lumio: ${live.said}`);
        live = null;
        planEl.classList.remove('live');
        // A finished checklist folds away; it's still one click away.
        if (plan && plan.every((x) => x.status === 'done')) setTimeout(() => { if (plan?.every((x) => x.status === 'done')) setPlanCollapsed(true); }, 1600);
        break;
      default:
        break;
    }
  });

  // links in answers open in a new tab
  messages.addEventListener('click', (e) => {
    const a = e.target.closest('a[href], [data-href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') || a.dataset.href;
    if (/^https?:\/\//i.test(href)) api.send('open-url', href);
  });

  // ------------------------------------------------------------ thinking effort
  // One model; people choose how hard it thinks, on a slider that snaps to
  // each level. The popover also shows how much of their plan is left.
  const modelMenu = $('#reasoning-menu');
  const modelBtn = $('#reasoning-btn');
  const slider = $('#effort-slider');
  const levels = () => (ai.reasoningLevels?.length ? ai.reasoningLevels : [{ id: 'low', name: 'Low', desc: '' }, { id: 'medium', name: 'Medium', desc: '' }, { id: 'high', name: 'High', desc: '' }]);
  const levelIndex = () => Math.max(0, levels().findIndex((r) => r.id === ai.reasoning));

  function allowance() {
    const l = ai.lumio || {};
    const u = l.usage;
    const pct = u && u.limit ? Math.max(0, Math.min(100, Math.round((u.remaining / u.limit) * 100))) : null;
    const plan = l.planName ? `Lumio ${esc(l.planName)}` : 'Your Lumio plan';
    const left = pct == null ? '' : ` · ${pct}% left`;
    const more = l.plan !== 'max' ? '<button class="link" id="reasoning-upgrade" type="button">Get more</button>' : '';
    return `<span>${plan}${left}</span>${more}`;
  }
  // i: the level to show; p: where the knob sits (0-1), while dragging.
  function renderEffort(i = levelIndex(), p) {
    const L = levels();
    const r = L[i] || L[0];
    slider.style.setProperty('--p', p ?? (L.length > 1 ? i / (L.length - 1) : 0));
    slider.setAttribute('aria-valuemax', String(L.length - 1));
    slider.setAttribute('aria-valuenow', String(i));
    slider.setAttribute('aria-valuetext', r.name);
    $('#effort-model').textContent = ai.modelName || '';
    $('#effort-label').textContent = r.name;
    $('#effort-desc').textContent = r.desc || '';
    $('#effort-ticks').innerHTML = L.map((x, n) => `<button type="button" data-i="${n}" class="${n === i ? 'on' : ''}">${esc(x.name)}</button>`).join('');
  }
  function renderModels() {
    renderEffort();
    $('#reasoning-foot').innerHTML = allowance();
    $('#reasoning-upgrade')?.addEventListener('click', () => { closeModels(); api.send('account:open', 'upgrade'); });
  }
  async function setEffort(i) {
    const L = levels();
    const r = L[Math.max(0, Math.min(L.length - 1, i))];
    if (r && r.id !== ai.reasoning) {
      ai.reasoning = r.id; // show it right away; the main process confirms
      renderEffort();
      ai = await api.invoke('ai:set-reasoning', r.id);
      renderState();
    }
    renderEffort();
  }
  function closeModels() {
    modelMenu.hidden = true;
    modelBtn.setAttribute('aria-expanded', 'false');
  }
  function openModels() {
    $('#chat-menu').hidden = true;
    modelMenu.hidden = false;
    modelBtn.setAttribute('aria-expanded', 'true');
    renderModels();
    slider.focus();
  }
  modelBtn.addEventListener('click', () => (modelMenu.hidden ? openModels() : closeModels()));
  modelMenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeModels(); modelBtn.focus(); }
  });
  slider.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (step) { e.preventDefault(); setEffort(levelIndex() + step); }
    else if (e.key === 'Home') { e.preventDefault(); setEffort(0); }
    else if (e.key === 'End') { e.preventDefault(); setEffort(levels().length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); closeModels(); prompt.focus(); }
  });
  slider.addEventListener('pointerdown', (e) => {
    slider.setPointerCapture(e.pointerId);
    slider.classList.add('dragging');
    let i = levelIndex();
    const at = (ev) => {
      const r = slider.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (ev.clientX - r.left - 15) / (r.width - 30)));
      i = Math.round(p * (levels().length - 1));
      renderEffort(i, p);
    };
    at(e);
    const up = () => {
      slider.classList.remove('dragging');
      slider.removeEventListener('pointermove', at);
      setEffort(i);
    };
    slider.addEventListener('pointermove', at);
    slider.addEventListener('pointerup', up, { once: true });
    slider.addEventListener('pointercancel', up, { once: true });
  });
  $('#effort-ticks').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) setEffort(Number(b.dataset.i));
  });

  // ------------------------------------------------------------ chats menu
  const chatMenu = $('#chat-menu');
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  async function openChats() {
    closeModels();
    chatMenu.hidden = false;
    const list = await api.invoke('ai:chats');
    $('#chat-list').innerHTML = list.length
      ? '<div class="list-label">Chats</div>' + list.map((c) => `<div class="list-item ${c.id === chatId ? 'current' : ''}" data-id="${esc(c.id)}" role="button">
          <span class="li-main"><span class="li-title">${esc(c.title)}</span><span class="li-sub">${ago(c.updatedAt)}</span></span>
          <button class="icon-btn small li-del" data-del="${esc(c.id)}" title="Delete">${icons.trash}</button></div>`).join('')
      : '<div class="list-empty">No chats yet</div>';
  }
  $('#chats-btn').addEventListener('click', () => (chatMenu.hidden ? openChats() : (chatMenu.hidden = true)));
  $('#chat-list').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]')?.dataset.del;
    if (del) {
      e.stopPropagation();
      await api.invoke('ai:delete-chat', del);
      if (del === chatId) newChat();
      openChats();
      return;
    }
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (!id) return;
    chatMenu.hidden = true;
    await loadChat(id);
  });
  async function loadChat(id) {
    const chat = await api.invoke('ai:chat', id);
    if (!chat) return;
    if (id !== chatId) voice.stop();
    chatId = id;
    chatProject = chat.projectId || null;
    chatChanged();
    live = ai.running && ai.runChatId === id ? { textEl: null, textBuf: '', thinkingEl: null, steps: new Map() } : null;
    renderChat(chat.display);
    showPlan(chat.plan || null);
    renderSuggest();
    if (live) {
      messages.querySelectorAll('.step.running').forEach((el) => live.steps.set(el.dataset.id, el));
      const last = messages.lastElementChild;
      if (last?.classList.contains('ai')) {
        live.textEl = last;
        live.textBuf = chat.display[chat.display.length - 1].text;
        live.tail = [...last.childNodes]; // redrawn with the next words
        last.classList.add('streaming');
      }
    }
    renderState();
  }
  function newChat(projectId = null) {
    voice.stop();
    chatId = null;
    chatProject = projectId;
    chatChanged();
    live = null;
    showPlan(null);
    messages.innerHTML = '';
    renderEmpty();
    renderState();
    renderSuggest();
    prompt.focus();
  }
  $('#newchat-btn').addEventListener('click', () => { chatMenu.hidden = true; newChat(chatProject); });

  // ------------------------------------------------------------ projects
  // "Choose project" under the chat box: a new chat starts in it; an open
  // chat moves into it. Projects are made and managed in the sidebar too.
  const projectBtn = $('#project-btn');
  const projectMenu = $('#project-menu');
  projectBtn.querySelector('.pi').innerHTML = icons.folder || '';
  function chatChanged() {
    renderProject();
    for (const fn of chatWatchers) fn({ chatId, projectId: chatProject });
  }
  async function loadProjects() {
    projectsCache = (ai.workflows ? await api.invoke('ai:projects').catch(() => null) : null) || [];
    renderProject();
    return projectsCache;
  }
  // (Can run before the lines below have: looks its button up each time.)
  function renderProject() {
    const btn = $('#project-btn');
    btn.hidden = !ai.workflows; // not in incognito
    const p = projectsCache.find((x) => x.id === chatProject);
    btn.querySelector('.pn').textContent = p ? p.name : 'Choose project';
    btn.classList.toggle('set', !!p);
  }
  function closeProjectMenu() { projectMenu.hidden = true; projectBtn.setAttribute('aria-expanded', 'false'); }
  async function openProjectMenu() {
    document.querySelectorAll('#composer .popover').forEach((x) => { if (x !== projectMenu) x.hidden = true; });
    await loadProjects();
    projectMenu.innerHTML = `<div class="list-label">${chatId ? 'Move this chat to' : 'Start this chat in'}</div>
      ${projectsCache.map((p) => `<button type="button" class="menu-row${p.id === chatProject ? ' on' : ''}" data-project="${esc(p.id)}"><span class="mi">${icons.folder || ''}</span><span class="mt"><b>${esc(p.name)}</b>${p.instructions ? `<small>${esc(p.instructions.slice(0, 70))}</small>` : ''}</span></button>`).join('')}
      <button type="button" class="menu-row${!chatProject ? ' on' : ''}" data-project=""><span class="mi">–</span><span class="mt"><b>No project</b></span></button>
      <form class="project-new"><input placeholder="New project name" maxlength="60" aria-label="New project name"><button class="btn" type="submit">Create</button></form>`;
    projectMenu.hidden = false;
    projectBtn.setAttribute('aria-expanded', 'true');
  }
  async function pickProject(id) {
    chatProject = id || null;
    if (chatId) await api.invoke('ai:chat-move', chatId, chatProject);
    closeProjectMenu();
    chatChanged();
  }
  projectBtn.addEventListener('click', () => (projectMenu.hidden ? openProjectMenu() : closeProjectMenu()));
  projectMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-project]');
    if (b) pickProject(b.dataset.project);
  });
  projectMenu.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = projectMenu.querySelector('.project-new input').value.trim();
    if (!name) return;
    const r = await api.invoke('ai:project-add', { name });
    if (!r.ok) { notice(r.error); return; }
    await loadProjects();
    pickProject(r.project.id);
  });
  document.addEventListener('mousedown', (e) => { if (!projectMenu.hidden && !e.target.closest('#project-menu, #project-btn')) closeProjectMenu(); });
  api.on('sidebar-changed', () => loadProjects());
  document.addEventListener('mousedown', (e) => {
    if (!modelMenu.hidden && !e.target.closest('#reasoning-menu, #reasoning-btn')) closeModels();
    if (!e.target.closest('#chat-menu, #chats-btn')) chatMenu.hidden = true;
  });

  // ------------------------------------------------------------ from main
  api.on('ai-prefill', ({ text, includePage: page, send, full: wantFull }) => {
    setOpen(true);
    if (wantFull) {
      // From the new tab page: a fresh chat, full size.
      chatMenu.hidden = true;
      setFull(true);
      if (ai.running) {
        prompt.value = text;
        autosize();
        notice('Lumio is still working on another task. Press Stop, or send this when it’s done.', 'info');
        return;
      }
      newChat();
      if (!ai.ready) { prompt.value = text; autosize(); } // kept for after signing in
      if (send) submit(text, false);
      return;
    }
    if (send) { submit(text, page); return; }
    prompt.value = text;
    autosize();
    if (page) { includePage = true; renderChip(); }
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  });

  api.on('ai-open-chat', async ({ id, full: wantFull }) => {
    setOpen(true);
    chatMenu.hidden = true;
    if (wantFull) setFull(true);
    await loadChat(id);
    prompt.focus();
  });

  return {
    init(data) {
      ai = data.ai;
      document.documentElement.style.setProperty('--panel-w', (data.panel.width || 380) + 'px');
      setOpen(data.panel.open !== false, false);
      renderEmpty();
      renderState();
      renderChip();
      loadProjects();
      // The saved open/closed state applies instantly; only later toggles slide.
      requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove('no-anim')));
    },
    open() { if (!panelOpen) setOpen(true); },
    close() { if (panelOpen) setOpen(false); },
    isOpen: () => panelOpen,
    sendText(text) { submit(text); },
    // For the sidebar.
    newTask({ projectId = null, full: wantFull = false } = {}) {
      setOpen(true);
      chatMenu.hidden = true;
      if (wantFull) setFull(true);
      newChat(projectId);
    },
    async openChat(id, { full: wantFull = false } = {}) {
      setOpen(true);
      chatMenu.hidden = true;
      if (wantFull) setFull(true);
      await loadChat(id);
      prompt.focus();
    },
    prefill(text) {
      setOpen(true);
      prompt.value = text;
      autosize();
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    },
    runWorkflow(id) { setOpen(true); wf.open(id); },
    chat() { return { chatId, projectId: chatProject }; },
    ai() { return ai; },
    onChatChange(fn) { chatWatchers.add(fn); },
    onTabChange(tab, switched) {
      if (full && (switched || tab?.id !== full.tabId || (tab?.url || '') !== full.url)) setFull(false);
      if (switched) includePage = true;
      renderChip();
    },
  };
}
