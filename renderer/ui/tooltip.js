// Tooltips for the chat box's controls (Lumio's design system, lumio-ai
// docs/design-system.md §6.2): a small card 8px above the control, after
// 350 ms of hover or at once on keyboard focus, gone on leave, blur, a click
// or Esc. The words come from the control's data-tip: lines split by "\n",
// the first one in bold. Used by the usage circle, the mic and the chips that
// show only their icon in a narrow chat box.
const SHOW_MS = 350;
const GAP = 8;

export function initTooltips(scope, host) {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.id = 'composer-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  host.append(tip);
  let target = null;
  let timer = 0;

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  // The words as shown: Lumio's runtime translates the tooltip and the
  // control's name (not data-tip), so they're compared translated.
  const shown = (s) => (globalThis.lumioI18n?.t ? globalThis.lumioI18n.t(s) : s);
  function show(el) {
    const lines = String(el.dataset.tip || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !el.isConnected) return;
    target = el;
    tip.replaceChildren(...lines.map((line, i) => {
      const d = document.createElement('div');
      d.className = i ? 'tip-line' : 'tip-head';
      d.textContent = line;
      return d;
    }));
    tip.hidden = false;
    // Its name already says the same words: no need to hear them twice.
    if (norm(shown(lines.join(' · '))) !== norm(el.getAttribute('aria-label'))) el.setAttribute('aria-describedby', tip.id);
    place(el);
  }
  // Centered over the control, kept inside the host (the AI panel).
  function place(el) {
    const h = host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const left = Math.max(GAP, Math.min(r.left - h.left + r.width / 2 - w / 2, h.width - w - GAP));
    let top = r.top - h.top - tip.offsetHeight - GAP;
    if (top < GAP) top = r.bottom - h.top + GAP;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }
  function hide() {
    clearTimeout(timer);
    timer = 0;
    if (target?.getAttribute('aria-describedby') === tip.id) target.removeAttribute('aria-describedby');
    target = null;
    tip.hidden = true;
  }
  const tipped = (e) => e.target.closest?.('[data-tip]');

  scope.addEventListener('pointerover', (e) => {
    const el = tipped(e);
    if (!el || el === target) return;
    hide();
    timer = setTimeout(() => show(el), SHOW_MS);
  });
  scope.addEventListener('pointerout', (e) => {
    const el = tipped(e);
    if (el && !el.contains(e.relatedTarget)) hide();
  });
  scope.addEventListener('focusin', (e) => {
    const el = tipped(e);
    if (!el || !el.matches(':focus-visible')) return;
    hide();
    show(el);
  });
  scope.addEventListener('focusout', hide);
  scope.addEventListener('pointerdown', hide);
  // Esc closes it first; whatever else Esc does (stop a task) still happens.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !tip.hidden) hide(); }, true);

  return {
    hide,
    // A control's words changed while its tooltip shows (the usage circle after a step).
    refresh(el) { if (el === target && !tip.hidden) show(el); },
  };
}
