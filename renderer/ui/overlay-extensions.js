// Extensions drawn above the page (main/extensions-ui.js decides what's in them):
//  - 'extensions': the puzzle-piece menu. Each extension that's on: run it,
//    pin it to the toolbar, and (under ⋮) where it may read and change
//    sites. It has the keyboard focus: arrows, Home/End, Enter, Esc. It
//    closes when it loses focus, like a menu.
//  - 'ntp-override': "Change back to Lumio's new tab page?" the first time an
//    extension's new tab page shows.
import { icons } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const KINDS = new Set(['extensions', 'ntp-override']);
let api = null;
let open = null; // id of the extension whose ⋮ panel is open
let last = null; // the menu's latest contents

const STATUS = {
  granted: 'Can read and change this site',
  withheld: 'Not allowed on this site',
  none: '',
};

export function render(kind, payload, card, bridge) {
  api = bridge;
  delete card.dataset.prompt;
  if (kind === 'extensions') {
    if (payload.fresh) open = null; // just opened: everything folded
    renderMenu(payload, card);
  } else renderNtp(payload, card);
}

function renderMenu(payload, card) {
  last = payload;
  const items = payload.items || [];
  if (!items.some((x) => x.id === open)) open = null;
  const keep = document.activeElement?.closest?.('[data-act]');
  const keepSel = keep ? `[data-id="${keep.closest('[data-id]')?.dataset.id}"] [data-act="${keep.dataset.act}"]${keep.dataset.choice ? `[data-choice="${keep.dataset.choice}"]` : ''}` : null;
  const row = (x) => {
    const status = STATUS[x.here] || '';
    const choices = [
      ['click', 'When you click the extension'],
      ...(x.host ? [['site', `On ${x.host}`]] : []),
      ['all', 'On all sites'],
    ];
    const panel = open === x.id ? `
      <div class="xm-panel" role="group" aria-label="${esc(x.name)} options" data-id="${esc(x.id)}" data-key="${esc(x.key)}">
        ${x.here !== 'none' || x.access !== 'all' ? `<div class="xm-label">This can read and change site data</div>
          ${choices.map(([c, label]) => `<button class="xm-choice" role="menuitemradio" aria-checked="${x.choice === c}" data-act="access" data-choice="${c}" ${x.changeable ? '' : 'disabled'}><i class="xm-radio"></i><span>${esc(label)}</span></button>`).join('')}
          ${x.changeable ? '' : '<div class="xm-hint">Unpacked extensions keep the access their manifest asks for.</div>'}` : ''}
        <button class="xm-choice" role="menuitem" data-act="details"><span class="xm-ic-sm">${icons.gear}</span><span>Manage extension</span></button>
      </div>` : '';
    return `
      <div class="xm-row ${x.hasAction ? '' : 'no-action'}" data-id="${esc(x.id)}" data-key="${esc(x.key)}">
        <button class="xm-main" role="menuitem" data-act="activate" ${x.hasAction ? '' : 'aria-disabled="true"'} title="${esc(x.hasAction ? x.name : `${x.name} has no toolbar button`)}">
          <span class="xm-ic">${x.icon ? `<img src="${esc(x.icon)}" alt="">` : icons.puzzle}</span>
          <span class="xm-text"><span class="xm-name">${esc(x.name)}</span>${status ? `<span class="xm-status ${x.here}">${esc(status)}</span>` : ''}</span>
        </button>
        ${x.hasAction ? `<button class="xm-btn xm-pin ${x.pinned ? 'on' : ''}" role="menuitemcheckbox" aria-checked="${x.pinned}" data-act="${x.pinned ? 'unpin' : 'pin'}" aria-label="${x.pinned ? 'Unpin' : 'Pin'} ${esc(x.name)}" title="${x.pinned ? 'Unpin from toolbar' : 'Pin to toolbar'}">${icons.pin}</button>` : ''}
        <button class="xm-btn xm-more" aria-haspopup="true" aria-expanded="${open === x.id}" data-act="more" aria-label="More options for ${esc(x.name)}" title="More options">${icons.dots}</button>
      </div>${panel}`;
  };
  card.innerHTML = `
    <div class="xm" role="menu" aria-label="Extensions">
      <div class="xm-head">Extensions</div>
      ${items.length ? `<div class="xm-list">${items.map(row).join('')}</div>` : '<div class="xm-empty">No extensions are on. Add some from the Chrome Web Store.</div>'}
      <button class="xm-manage" role="menuitem" data-act="manage"><span class="xm-ic-sm">${icons.gear}</span><span>Manage extensions</span></button>
    </div>`;
  const again = keepSel && card.querySelector(keepSel);
  (again || card.querySelector('.xm-main:not([aria-disabled])') || card.querySelector('.xm-manage')).focus({ preventScroll: true });
  measure(card);
}

function renderNtp({ name }, card) {
  card.innerHTML = `
    <div class="xn" role="alertdialog" aria-labelledby="xn-title" aria-describedby="xn-note">
      <div class="xn-head">${icons.puzzle}<span>New tab page</span></div>
      <div class="xn-title" id="xn-title">Change back to Lumio’s new tab page?</div>
      <p class="xn-note" id="xn-note">“${esc(name)}” changed what you see when you open a new tab.</p>
      <div class="xn-actions">
        <span class="grow"></span>
        <button class="acc-btn ghost" data-ntp="keep">Keep it</button>
        <button class="acc-btn primary" data-ntp="revert">Change it back</button>
      </div>
    </div>`;
  card.querySelector('[data-ntp=revert]').focus({ preventScroll: true });
  measure(card);
}

// The card asks for the height it really needs.
function measure(card) {
  requestAnimationFrame(() => {
    card.style.height = 'auto';
    const h = card.getBoundingClientRect().height;
    card.style.height = '';
    api.send('overlay:size', { height: Math.ceil(h) + 2 + 22 });
  });
}

export function click(kind, e, card) {
  if (kind === 'ntp-override') {
    const b = e.target.closest('[data-ntp]');
    if (b) api.send('extensions:ntp', { decision: b.dataset.ntp });
    return;
  }
  if (kind !== 'extensions') return;
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return;
  const holder = b.closest('[data-id]');
  const msg = { act: b.dataset.act, id: holder?.dataset.id, key: holder?.dataset.key };
  if (msg.act === 'more') {
    open = open === msg.id ? null : msg.id;
    renderMenu(last, card);
    card.querySelector(`.xm-row[data-id="${msg.id}"] .xm-more`)?.focus();
    return;
  }
  if (msg.act === 'access') msg.choice = b.dataset.choice;
  api.send('extensions:menu-act', msg);
}

export function keydown(kind, e, card) {
  if (kind === 'ntp-override') {
    if (e.key === 'Escape') { e.preventDefault(); api.send('extensions:ntp', { decision: 'later' }); }
    return;
  }
  if (kind !== 'extensions') return;
  // Up and down go from row to row (and through an open panel's choices);
  // left and right along a row.
  const items = [...card.querySelectorAll('.xm-main, .xm-choice:not([disabled]), .xm-manage')].filter((b) => b.offsetParent !== null);
  const at = document.activeElement;
  const i = items.indexOf(at.closest?.('.xm-row')?.querySelector('.xm-main') || at);
  const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
  if (e.key === 'Escape') {
    e.preventDefault();
    const panel = document.activeElement?.closest('.xm-panel');
    if (panel) { open = null; renderMenu(last, card); card.querySelector(`.xm-row[data-id="${panel.dataset.id}"] .xm-more`)?.focus(); return; }
    api.send('extensions:menu-close', { refocus: true });
  } else if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i < 0 ? items.length - 1 : i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(items.length - 1);
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    // Along the row: run it, pin, more.
    const row = document.activeElement?.closest('.xm-row');
    if (!row) return;
    const inRow = [...row.querySelectorAll('button')];
    const j = inRow.indexOf(document.activeElement) + (e.key === 'ArrowRight' ? 1 : -1);
    if (inRow[j]) { e.preventDefault(); inRow[j].focus(); }
  }
}

// The menu closes when the window or page is clicked (it loses focus).
export function blur(kind) {
  if (kind === 'extensions') api?.send('extensions:menu-close', {});
}
