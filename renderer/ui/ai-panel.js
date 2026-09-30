// Lumio AI side panel: chat, streaming replies, tool steps, approvals,
// model picker, chat history. All model/tool work happens in the main process.
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { icons, markSvg, makerLogos } from './icons.js';

const SUGGESTIONS = [
  { title: 'Summarize this page', text: 'Summarize this page in a few bullet points.', page: true },
  { title: 'Find something for me', text: 'Search the web for the best-reviewed noise-cancelling headphones under $200 and compare the top 3.' },
  { title: 'Do it for me', text: 'Open Google Maps and find coffee shops open now near me.' },
  { title: 'Help on my Mac', text: 'What apps are running on my Mac right now?' },
];

const RISK_LABEL = { browser: 'Browser action', mac: 'Controls your Mac', shell: 'Runs on your Mac' };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

marked.setOptions({ gfm: true, breaks: true });
const PURIFY = { FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input', 'video', 'audio', 'source', 'object', 'embed'], FORBID_ATTR: ['style'] };
const renderMd = (text) => DOMPurify.sanitize(marked.parse(String(text || '')), PURIFY);

export function initPanel({ api, getActiveTab, onLayout, setRunning }) {
  const body = document.body;
  const messages = $('#messages');
  const prompt = $('#prompt');
  const sendBtn = $('#send');
  const chip = $('#context-chip');

  let ai = { hasKey: false, ready: false, source: 'openrouter', lumio: {}, model: '', modelName: '', mode: 'ask', running: false, vision: true };
  let chatId = null;
  let panelOpen = true;
  let includePage = true;
  const includedUrl = new Map(); // chatId -> last page URL sent as context
  let live = null; // { textEl, textBuf, thinkingEl, steps: Map }
  let models = null;

  // ------------------------------------------------------------ chrome
  $('#panel-mark').innerHTML = markSvg(18);
  $('#chats-btn').innerHTML = icons.chats;
  $('#newchat-btn').innerHTML = icons.compose;
  $('#panel-close').innerHTML = icons.panel;
  sendBtn.innerHTML = icons.send;

  function setOpen(open, save = true) {
    panelOpen = open;
    body.classList.toggle('panel-closed', !open);
    $('#ai-toggle').classList.toggle('on', open);
    if (save) api.send('panel:set', { open });
    onLayout();
    if (open) requestAnimationFrame(() => prompt.focus());
  }
  $('#ai-toggle').addEventListener('click', () => setOpen(!panelOpen));
  $('#panel-close').addEventListener('click', () => setOpen(false));
  api.on('panel-toggle', () => setOpen(!panelOpen));
  api.on('ai-focus', () => { if (!panelOpen) setOpen(true); prompt.focus(); });

  // resize
  const resizer = $('#resizer');
  resizer.addEventListener('pointerdown', (e) => {
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('dragging');
    const move = (ev) => {
      const w = Math.max(320, Math.min(760, window.innerWidth - ev.clientX - 8));
      document.documentElement.style.setProperty('--panel-w', w + 'px');
      onLayout();
    };
    const up = () => {
      resizer.classList.remove('dragging');
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
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) continue;
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
    $('#model-name').textContent = ai.modelShort || ai.modelName || 'Model';
    $('#model-logo').innerHTML = makerLogos[ai.modelMaker]?.(13) || '';
    $('#model-btn').title = `Model: ${ai.modelName}`;
    document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === ai.mode));
    const running = ai.running && ai.runChatId === chatId;
    sendBtn.classList.toggle('stop', running);
    sendBtn.innerHTML = running ? icons.square : icons.send;
    sendBtn.title = running ? 'Stop (Esc)' : 'Send (↵)';
    sendBtn.disabled = !running && (!prompt.value.trim() || !ai.ready);
    setRunning(!!ai.running);
    spin(!!ai.running);
    if (!chatId && !messages.querySelector('.msg')) renderEmpty();
  }

  api.on('ai-state', (s) => {
    const before = `${ai.ready}|${ai.source}|${JSON.stringify(ai.lumio || {})}`;
    ai = s;
    renderState();
    // Signing in, upgrading or adding a key changes the empty panel's setup card.
    if (messages.querySelector('.empty') && before !== `${ai.ready}|${ai.source}|${JSON.stringify(ai.lumio || {})}`) renderEmpty();
  });

  document.querySelectorAll('#mode button').forEach((b) => b.addEventListener('click', async () => {
    ai = await api.invoke('ai:set-mode', b.dataset.mode);
    renderState();
  }));

  // ------------------------------------------------------------ context chip
  function renderChip() {
    const t = getActiveTab();
    const web = t && /^https?:/.test(t.url || '');
    chip.hidden = !web;
    if (!web) return;
    chip.classList.toggle('off', !includePage);
    chip.querySelector('i').innerHTML = t.favicon ? `<img src="${esc(t.favicon)}" alt="">` : icons.page;
    chip.querySelector('span').textContent = t.title || t.url;
    chip.querySelector('button').textContent = includePage ? '×' : '+';
    chip.title = includePage ? 'Lumio will read this page with your message. Click × to leave it out.' : 'Click + to include this page.';
  }
  chip.addEventListener('click', () => { includePage = !includePage; renderChip(); });

  // ------------------------------------------------------------ composer
  function autosize() {
    prompt.style.height = 'auto';
    prompt.style.height = Math.min(180, prompt.scrollHeight) + 'px';
    renderState();
  }
  prompt.addEventListener('input', autosize);
  prompt.addEventListener('focus', () => $('#composer').classList.add('focused'));
  prompt.addEventListener('blur', () => $('#composer').classList.remove('focused'));
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    if (e.key === 'Escape' && ai.running) { e.preventDefault(); api.send('ai:stop'); }
  });
  sendBtn.addEventListener('click', () => {
    if (ai.running && ai.runChatId === chatId) api.send('ai:stop');
    else submit();
  });

  async function submit(textOverride, forcePage) {
    const text = (textOverride ?? prompt.value).trim();
    if (!text) return;
    if (!ai.ready) { renderEmpty(); $('#key-input')?.focus(); return; }
    if (ai.running) { notice('Lumio is still working. Press Stop first.'); return; }
    const t = getActiveTab();
    const url = t?.url || '';
    const web = /^https?:/.test(url);
    const wantPage = web && (forcePage || (includePage && includedUrl.get(chatId) !== url));
    if (textOverride == null) { prompt.value = ''; autosize(); }
    const res = await api.invoke('ai:send', { chatId, text, includePage: wantPage });
    if (!res.ok) { notice(res.error); return; }
    if (wantPage) includedUrl.set(res.chatId, url);
  }

  // ------------------------------------------------------------ rendering
  function scrollDown(force) {
    const near = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 140;
    if (force || near) messages.scrollTop = messages.scrollHeight;
  }

  function notice(text, cls = '') {
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
      // Two ways in: a paid Lumio plan, or the person's own OpenRouter key.
      const l = ai.lumio || {};
      const plan = l.connecting
        ? `<p>Approve the sign-in in the tab that opened on lumio-usa.online.</p>`
        : l.signedIn && !l.paid
          ? `<p>Your Lumio plan is ${esc(l.planName || 'Free')}. Lumio AI in the browser needs Plus, Pro or Max.</p><button class="btn primary" id="lumio-upgrade">Upgrade your plan</button>`
          : !l.signedIn
            ? `<p>Use your Lumio plan: no key needed on Plus, Pro or Max.</p><button class="btn primary" id="lumio-sign-in">Sign in to Lumio</button>`
            : '';
      const keyHint = ai.source === 'lumio' && l.signedIn && l.paid ? '' : `<div class="or"><span>or use your own OpenRouter key</span></div>`;
      el.innerHTML = `
        <div class="hero-mark">${markSvg(26)}</div>
        <h2>Set up Lumio AI</h2>
        ${plan}
        ${keyHint}
        <div class="keycard">
          <label for="key-input">OpenRouter API key</label>
          <p class="hint">Stored encrypted with your system keychain. <span class="link" data-href="https://openrouter.ai/keys">Get a key →</span></p>
          <div class="row"><input id="key-input" type="password" placeholder="sk-or-v1-…" spellcheck="false" autocomplete="off"><button class="btn primary" id="key-save">Connect</button></div>
          <div class="err" hidden></div>
        </div>`;
      messages.append(el);
      el.querySelector('#lumio-sign-in')?.addEventListener('click', () => api.send('account:sign-in'));
      el.querySelector('#lumio-upgrade')?.addEventListener('click', () => api.send('account:open', 'upgrade'));
      const input = el.querySelector('#key-input');
      const save = async () => {
        const btn = el.querySelector('#key-save');
        btn.disabled = true;
        btn.textContent = 'Checking…';
        const res = await api.invoke('ai:set-key', input.value);
        btn.disabled = false;
        btn.textContent = 'Connect';
        if (!res.ok) { const err = el.querySelector('.err'); err.hidden = false; err.textContent = res.error; return; }
        ai = await api.invoke('ai:state');
        renderEmpty();
        renderState();
        prompt.focus();
      };
      el.querySelector('#key-save').addEventListener('click', save);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      return;
    }
    el.innerHTML = `
      <div class="hero-mark">${markSvg(26)}</div>
      <h2>What can I do for you?</h2>
      <p>Ask anything, or tell me what to do. I can read and use web pages${ai.macAvailable ? ' and control your Mac' : ''}, and I'll ask before I act.</p>
      ${ai.ephemeral ? '<p class="incog-note">You’re incognito: chats here aren’t saved.</p>' : ''}
      <div class="suggestions">${SUGGESTIONS.map((s, i) => `<button class="suggestion" data-i="${i}"><b>${esc(s.title)}</b>${esc(s.text)}</button>`).join('')}</div>`;
    messages.append(el);
    el.querySelectorAll('.suggestion').forEach((b) => b.addEventListener('click', () => {
      const s = SUGGESTIONS[Number(b.dataset.i)];
      submit(s.text, !!s.page);
    }));
  }

  function userEl(text, ctx) {
    const el = document.createElement('div');
    el.className = 'msg user';
    if (ctx?.title) {
      const c = document.createElement('div');
      c.className = 'ctx';
      c.innerHTML = `${icons.page}<span></span>`;
      c.querySelector('span').textContent = ctx.title;
      el.append(c);
    }
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    el.append(b);
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
    return el;
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
    const code = a.risk === 'shell' || /\n/.test(detail);
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


  function permissionHint(summary) {
    if (!summary) return;
    const which = /screen recording/i.test(summary) ? 'screen' : /accessibility/i.test(summary) ? 'accessibility' : null;
    if (!which) return;
    const el = notice(`Lumio needs the ${which === 'screen' ? 'Screen Recording' : 'Accessibility'} permission to do this.`, 'info');
    const b = document.createElement('button');
    b.className = 'btn';
    b.style.marginLeft = '8px';
    b.textContent = 'Open System Settings';
    b.addEventListener('click', () => api.send('ai:mac-permissions-open', which));
    el.append(b);
  }

  function renderChat(display) {
    messages.innerHTML = '';
    for (const d of display) {
      if (d.kind === 'user') messages.append(userEl(d.text, d.ctx));
      else if (d.kind === 'ai') messages.append(aiEl(d.text));
      else if (d.kind === 'step') messages.append(stepEl(d));
      else if (d.kind === 'approval' && !d.decision) messages.append(approvalEl(d));
      else if (d.kind === 'note') notice(d.text, 'info');
      else if (d.kind === 'error') notice(d.text);
    }
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
    live.textEl.classList.remove('streaming');
    live.textEl.innerHTML = renderMd(live.textBuf);
    decorate(live.textEl);
    live.textEl = null;
    live.textBuf = '';
  }

  let frame = 0;
  function flushText() {
    frame = 0;
    if (!live?.textEl) return;
    live.textEl.innerHTML = renderMd(live.textBuf);
    scrollDown();
  }

  api.on('ai-event', (ev) => {
    if (ev.type === 'user') {
      if (!chatId || chatId === ev.chatId) {
        if (!chatId) messages.innerHTML = '';
        chatId = ev.chatId;
        messages.append(userEl(ev.text, ev.ctx));
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
        if (!frame) frame = requestAnimationFrame(flushText);
        break;
      case 'text_end':
        endText();
        break;
      case 'step': {
        if (!live) break;
        endText();
        thinking(false);
        const el = stepEl({ ...ev, status: 'running' });
        live.steps.set(ev.id, el);
        messages.append(el);
        scrollDown();
        break;
      }
      case 'approval':
        messages.append(approvalEl(ev));
        scrollDown(true);
        if (!panelOpen) setOpen(true);
        break;
      case 'approval_done': {
        // The step chip above already shows the outcome; drop the card.
        const el = messages.querySelector(`.approval[data-id="${CSS.escape(ev.id)}"]`);
        if (el) el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 160 }).onfinish = () => el.remove();
        break;
      }
      case 'step_done': {
        const el = live?.steps.get(ev.id);
        if (el) {
          setStepStatus(el, ev.status, ev.summary);
          if (ev.thumb) {
            const img = document.createElement('img');
            img.className = 'step-thumb';
            img.src = ev.thumb;
            img.alt = 'Screenshot';
            el.after(img);
          }
          if (ev.status === 'error') permissionHint(ev.summary);
        }
        scrollDown();
        break;
      }
      case 'done':
        endText();
        thinking(false);
        if (ev.reason === 'max_steps') notice('Stopped after 30 steps. Say "continue" to keep going.', 'info');
        if (ev.reason === 'length') notice('The reply was cut off because it got too long.', 'info');
        break;
      case 'stopped':
        endText();
        thinking(false);
        notice('Stopped.', 'info');
        break;
      case 'error':
        endText();
        thinking(false);
        notice(ev.message);
        break;
      case 'end':
        endText();
        thinking(false);
        messages.querySelectorAll('.step.running').forEach((el) => setStepStatus(el, 'error', 'Stopped'));
        messages.querySelectorAll('.approval:not(.done)').forEach((el) => el.classList.add('done'));
        live = null;
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

  // ------------------------------------------------------------ model menu
  const modelMenu = $('#model-menu');
  const modelBtn = $('#model-btn');
  const modelList = $('#model-list');

  function price(m) {
    if (m.prompt == null) return '';
    const f = (n) => (n >= 1 ? String(+n.toFixed(2)) : n.toFixed(2));
    return `$${f(m.prompt)} / $${f(m.completion)} per 1M tokens`;
  }
  function renderModels() {
    if (!models) { modelList.innerHTML = '<div class="list-empty">Loading…</div>'; return; }
    modelList.innerHTML = models.map((m) => {
      const off = m.available === false;
      const sub = m.lumio ? [m.maker, m.note].filter(Boolean).join(' · ')
        : off ? 'Not available on OpenRouter right now' : [m.maker, price(m)].filter(Boolean).join(' · ');
      return `<button class="list-item model-row ${m.id === ai.model ? 'current' : ''} ${off ? 'unavailable' : ''}" role="option" aria-selected="${m.id === ai.model}" data-id="${esc(m.id)}">
        <span class="logo">${makerLogos[m.maker]?.(18) || ''}</span>
        <span class="li-main"><span class="li-title">${esc(m.name)}</span><span class="li-sub">${esc(sub)}</span></span>
        <span class="check">${m.id === ai.model ? icons.check : ''}</span>
      </button>`;
    }).join('');
  }
  function closeModels() {
    modelMenu.hidden = true;
    modelBtn.setAttribute('aria-expanded', 'false');
  }
  async function openModels() {
    $('#chat-menu').hidden = true;
    modelMenu.hidden = false;
    modelBtn.setAttribute('aria-expanded', 'true');
    renderModels();
    models = await api.invoke('ai:models').catch(() => models);
    renderModels();
    (modelList.querySelector('.current') || modelList.querySelector('button'))?.focus();
  }
  modelBtn.addEventListener('click', () => (modelMenu.hidden ? openModels() : closeModels()));
  modelMenu.addEventListener('keydown', (e) => {
    const rows = [...modelList.querySelectorAll('button')];
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.stopPropagation(); closeModels(); modelBtn.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[(i + 1) % rows.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); rows[(i - 1 + rows.length) % rows.length]?.focus(); }
  });
  modelList.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (!id) return;
    ai = await api.invoke('ai:set-model', id);
    closeModels();
    renderState();
    prompt.focus();
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
    chatId = id;
    live = ai.running && ai.runChatId === id ? { textEl: null, textBuf: '', thinkingEl: null, steps: new Map() } : null;
    renderChat(chat.display);
    if (live) {
      messages.querySelectorAll('.step.running').forEach((el) => live.steps.set(el.dataset.id, el));
      const last = messages.lastElementChild;
      if (last?.classList.contains('ai')) { live.textEl = last; live.textBuf = chat.display[chat.display.length - 1].text; last.classList.add('streaming'); }
    }
    renderState();
  }
  function newChat() {
    chatId = null;
    live = null;
    messages.innerHTML = '';
    renderEmpty();
    renderState();
    prompt.focus();
  }
  $('#newchat-btn').addEventListener('click', () => { chatMenu.hidden = true; newChat(); });
  document.addEventListener('mousedown', (e) => {
    if (!modelMenu.hidden && !e.target.closest('#model-menu, #model-btn')) closeModels();
    if (!e.target.closest('#chat-menu, #chats-btn')) chatMenu.hidden = true;
  });

  // ------------------------------------------------------------ from main
  api.on('ai-prefill', ({ text, includePage: page, send }) => {
    setOpen(true);
    if (send) { submit(text, page); return; }
    prompt.value = text;
    autosize();
    if (page) { includePage = true; renderChip(); }
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  });

  return {
    init(data) {
      ai = data.ai;
      document.documentElement.style.setProperty('--panel-w', (data.panel.width || 380) + 'px');
      setOpen(data.panel.open !== false, false);
      renderEmpty();
      renderState();
      renderChip();
    },
    open() { if (!panelOpen) setOpen(true); },
    sendText(text) { submit(text); },
    onTabChange(_tab, switched) {
      if (switched) includePage = true;
      renderChip();
    },
  };
}
