// Autofill on web pages: a session preload in every tab (main/autofill.js
// registers it). It runs in an isolated world, so pages can't see or call it.
//  - Finds address, payment card and ordinary text fields (autocomplete
//    attributes first, then names, ids, placeholders and labels, in English
//    and Spanish).
//  - Asks Lumio for its dropdown under the field the person clicks or types
//    in, and fills only what they pick there (arrow keys, Enter, Esc and
//    Shift+Delete work from the field).
//  - Notices forms the person sends, so Lumio can offer to save an address or
//    a card, and remember form entries.
// Only visible fields are filled, so a page can't collect an address through
// fields the person doesn't see. Card fields only work on secure pages, and
// card security codes (CVC) are never read. Sign-in fields are left to
// preload/internal.js (passwords).
const { ipcRenderer } = require('electron');

if (/^https?:$/.test(window.location.protocol) && window === window.top) autofill();

function autofill() {
  // ---------------------------------------------------------------- what a field is for
  const AUTOCOMPLETE = {
    name: 'name', 'given-name': 'given', 'additional-name': 'middle', 'family-name': 'family', organization: 'organization',
    'street-address': 'street', 'address-line1': 'line1', 'address-line2': 'line2', 'address-line3': 'line3',
    'address-level1': 'state', 'address-level2': 'city', 'postal-code': 'zip', country: 'country', 'country-name': 'country',
    tel: 'phone', 'tel-national': 'phone', email: 'email',
    'cc-name': 'cc-name', 'cc-given-name': 'cc-given', 'cc-family-name': 'cc-family', 'cc-number': 'cc-number',
    'cc-exp': 'cc-exp', 'cc-exp-month': 'cc-exp-month', 'cc-exp-year': 'cc-exp-year', 'cc-csc': 'cc-csc',
  };
  // Checked in order against a field's words; the first match wins.
  const CARD_RULES = [
    ['cc-csc', /\b(cvc2?|cvv2?|cvn|csc|cid|security code|card code|verification (code|number|value)|c[oó]digo de seguridad)\b/],
    ['cc-name', /\b(name on (the )?(credit |debit )?card|card ?holder|holder ?name|cardholder|cc ?name|nombre (en|del titular|que aparece)|titular)\b/],
    ['cc-number', /\b(card ?(number|num|no)|cc ?(num|number)|ccnum|cardnumber|(credit|debit) ?card|n[uú]mero de (la )?tarjeta|tarjeta de (cr[eé]dito|d[eé]bito))\b/],
  ];
  // Only inside a form that has a card number field.
  const CARD_FORM_RULES = [
    ['cc-exp-month', /\b(exp(iry|iration)? ?(date )?month|month|mes( de (vencimiento|expiraci[oó]n))?|mm)\b/],
    ['cc-exp-year', /\b(exp(iry|iration)? ?(date )?year|year|a[nñ]o|yy|yyyy|aa|aaaa)\b/],
    ['cc-exp', /\b(exp(iry|iration)?( date)?|expires|valid (thru|through|until)|mm ?yy(yy)?|vencimiento|caducidad)\b/],
  ];
  const ADDRESS_RULES = [
    ['email', /\b(e ?mail|correo( electr[oó]nico)?)\b/],
    ['phone', /\b(phone|tel|telephone|mobile|cell( ?phone)?|tel[eé]fono|celular|m[oó]vil)\b/],
    ['zip', /\b(zip( ?code)?|postal( ?code)?|post ?code|postcode|c[oó]digo postal|cp)\b/],
    ['country', /\b(country|pa[ií]s|nation)\b/],
    ['state', /\b(state|province|region|county|prefecture|estado|provincia|address level ?1)\b/],
    ['city', /\b(city|town|locality|suburb|ciudad|localidad|municipio|address level ?2)\b/],
    ['line2', /\b(address ?(line)? ?2|addr ?2|street ?2|apartment|apt|suite|unit|floor|building|piso|depto|apartamento)\b/],
    ['organization', /\b(company|organi[sz]ation|business|employer|empresa|organizaci[oó]n|compa[nñ][ií]a)\b/],
    ['given', /\b(first ?name|given ?name|fname|forename|first|nombres?)\b/],
    ['family', /\b(last ?name|family ?name|surname|lname|last|apellidos?)\b/],
    ['middle', /\b(middle ?name|mname|middle)\b/],
    ['line1', /\b(address ?(line)? ?1|addr ?1|street|address|addr|calle|direcci[oó]n|domicilio)\b/],
    ['name', /\b(full ?name|your ?name|name|nombre completo|recipient)\b/],
  ];
  const NOT_A_NAME = /\b(user|login|account|screen|display|nick|file|domain|host|pet|company|business)\b/;
  const CARD_TYPES = new Set(['cc-name', 'cc-given', 'cc-family', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc']);
  const ADDRESS_TYPES = new Set(['name', 'given', 'middle', 'family', 'organization', 'street', 'line1', 'line2', 'line3', 'city', 'state', 'zip', 'country', 'phone', 'email']);
  const GROUP = { given: 'name', middle: 'name', family: 'name', line1: 'street', line2: 'street', line3: 'street' };
  // Never remembered as form entries.
  const SENSITIVE = /(password|passcode|passwd|pass ?phrase|card|cvv|cvc|csc|security code|iban|routing|account ?(number|no)|ssn|social security|passport|tax ?id|\bpin\b|otp|one ?time|verification|auth(entication)? code|2fa|mfa|token|secret|captcha)/;
  const NO_HISTORY_AC = /^(off|false|nope|no|one-time-code|new-password|current-password|cc-.*)$/;

  const isInput = (el) => el instanceof HTMLInputElement;
  const isSelect = (el) => el instanceof HTMLSelectElement;
  const isArea = (el) => el instanceof HTMLTextAreaElement;
  function fieldEl(el) {
    if (isArea(el)) return !el.disabled && !el.readOnly;
    if (isSelect(el)) return !el.disabled;
    return isInput(el) && !el.disabled && !el.readOnly && /^(text|email|tel|url|number)$/.test(el.type);
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom + window.scrollY <= 0) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }
  const scopeOf = (el) => el?.form || el?.closest?.('form') || document;
  const hasPassword = (scope) => [...scope.querySelectorAll('input[type=password]')].some(visible);

  function labelText(el) {
    if (el.labels && el.labels[0]) return el.labels[0].innerText;
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
    // A label written just before the field, without for=.
    const prev = el.previousElementSibling;
    if (!el.getAttribute('aria-label') && !el.placeholder && prev && /^(LABEL|SPAN|DIV|P|B|STRONG)$/.test(prev.tagName) && prev.innerText.length < 60) return prev.innerText;
    return '';
  }
  // A field's words, split so rules can match whole words: "billingPostalCode" -> "billing postal code".
  const words = (el) => [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), labelText(el)]
    .filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.[\]:#*/]+/g, ' ').toLowerCase();
  const tokens = (el) => String(el.getAttribute('autocomplete') || '').toLowerCase().trim().split(/\s+/);

  function classify(el, cardForm) {
    const t = tokens(el);
    for (let i = t.length - 1; i >= 0; i--) if (AUTOCOMPLETE[t[i]]) return AUTOCOMPLETE[t[i]];
    if (t.some((x) => /^(username|current-password|new-password|one-time-code)$/.test(x))) return null;
    const w = words(el);
    for (const [type, re] of CARD_RULES) if (re.test(w)) return type;
    if (cardForm) for (const [type, re] of CARD_FORM_RULES) if (re.test(w)) return type;
    for (const [type, re] of ADDRESS_RULES) {
      if ((type === 'name' || type === 'given' || type === 'family') && NOT_A_NAME.test(w)) continue;
      if (re.test(w)) return type === 'line1' && isArea(el) ? 'street' : type;
    }
    if (isInput(el) && el.type === 'email') return 'email';
    if (isInput(el) && el.type === 'tel') return 'phone';
    return null;
  }

  // The fields of a form (or of the page, for fields outside any form), each
  // with what it's for.
  function fieldsOf(scope) {
    const els = [...scope.querySelectorAll('input, select, textarea')].filter((el) => fieldEl(el) && visible(el));
    const cardForm = els.some((el) => classify(el, false) === 'cc-number');
    const list = els.map((el) => ({ el, type: classify(el, cardForm) })).filter((f) => f.type);
    // "Nombre" without "Apellido" is the whole name; a second address line 1 is line 2.
    if (list.some((f) => f.type === 'given') && !list.some((f) => f.type === 'family')) list.forEach((f) => { if (f.type === 'given') f.type = 'name'; });
    const ones = list.filter((f) => f.type === 'line1');
    if (ones.length === 2 && !list.some((f) => f.type === 'line2')) ones[1].type = 'line2';
    return list;
  }
  const groups = (fields) => new Set(fields.filter((f) => ADDRESS_TYPES.has(f.type)).map((f) => GROUP[f.type] || f.type));
  function addressForm(fields) {
    const g = groups(fields);
    return g.size >= 3 && (g.has('street') || g.has('city') || g.has('zip'));
  }

  // Ordinary fields whose entries Lumio may remember: never sign-in, card or
  // secret fields, and not search boxes or fields with their own suggestions.
  function historyKey(el) {
    if (!isInput(el) || !/^(text|email|tel|url)$/.test(el.type)) return null;
    if (el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete') || el.hasAttribute('list')) return null;
    if (tokens(el).some((x) => NO_HISTORY_AC.test(x))) return null;
    if (SENSITIVE.test(words(el))) return null;
    return (el.name || el.id || '').slice(0, 80) || null;
  }

  // What the dropdown under this field should offer.
  function modeOf(el) {
    if (!fieldEl(el) || isSelect(el) || !visible(el)) return null;
    const scope = scopeOf(el);
    const fields = fieldsOf(scope);
    const type = fields.find((f) => f.el === el)?.type;
    if (type && CARD_TYPES.has(type)) return type !== 'cc-csc' && window.isSecureContext ? { mode: 'card', field: type } : null;
    const login = hasPassword(scope); // sign-in forms belong to the password dropdown
    const key = login ? null : historyKey(el);
    if (type && ADDRESS_TYPES.has(type) && addressForm(fields)) return { mode: 'address', field: type, key };
    return key ? { mode: 'history', key } : null;
  }

  // ---------------------------------------------------------------- the dropdown
  const typed = new WeakSet(); // fields the person typed in
  const filled = new WeakSet(); // fields Lumio filled
  // Saving asks for the person's own input: a page filling and sending a form
  // by itself never gets "Save address?" or "Save card?".
  const touched = (el) => typed.has(el) || filled.has(el);
  let menu = null; // { el, count, sel } while Lumio's dropdown is under a field
  let anchor = null; // the field the last dropdown was under
  let seq = 0;
  let timer = null;

  async function suggest(el) {
    const m = modeOf(el);
    if (!m || (m.mode === 'card' && el.value)) { hide(); return; }
    const id = ++seq;
    const r = el.getBoundingClientRect();
    const res = await ipcRenderer.invoke('af:query', { ...m, prefix: m.mode === 'card' ? '' : el.value || '', rect: { x: r.left, top: r.top, bottom: r.bottom, width: r.width } }).catch(() => null);
    if (id !== seq) { if (res?.count) ipcRenderer.send('af:hide'); return; } // something newer happened meanwhile
    menu = res?.count ? { el, count: res.count, sel: -1 } : null;
    if (menu) anchor = el;
  }
  function hide() {
    seq++;
    if (!menu) return;
    menu = null;
    ipcRenderer.send('af:hide');
  }
  async function remove(index) {
    const m = menu;
    const res = await ipcRenderer.invoke('af:remove', { index }).catch(() => null);
    if (menu !== m || !res) return;
    if (!res.count) { menu = null; return; }
    m.count = res.count;
    m.sel = Math.min(m.sel, m.count - 1);
    ipcRenderer.send('af:select', { index: m.sel });
  }

  const textField = (el) => fieldEl(el) && !isSelect(el);
  document.addEventListener('click', (e) => {
    if (e.isTrusted && textField(e.target) && e.target === document.activeElement) suggest(e.target);
  }, true);
  document.addEventListener('input', (e) => {
    if (!e.isTrusted || !fieldEl(e.target)) return;
    const el = e.target;
    typed.add(el);
    if (el !== document.activeElement || isSelect(el)) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (document.activeElement === el) suggest(el); }, 60);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    const el = e.target;
    if (menu && el === menu.el) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        menu.sel = e.key === 'ArrowDown' ? (menu.sel + 1) % menu.count : menu.sel <= 0 ? menu.count - 1 : menu.sel - 1;
        ipcRenderer.send('af:select', { index: menu.sel });
      } else if (e.key === 'Enter' && menu.sel >= 0) {
        // Picks the item instead of sending the form.
        e.preventDefault();
        e.stopImmediatePropagation();
        const index = menu.sel;
        menu = null;
        ipcRenderer.send('af:pick', { index });
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && e.shiftKey && menu.sel >= 0) {
        e.preventDefault();
        remove(menu.sel);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hide();
      } else if (e.key === 'Tab') hide();
      return;
    }
    if (e.key === 'ArrowDown' && !e.altKey && textField(el) && !isArea(el)) suggest(el);
  }, true);
  document.addEventListener('focusout', () => setTimeout(() => { if (menu && document.activeElement !== menu.el) hide(); }, 250), true);
  // The dropdown doesn't follow the field, so it closes when the field moves
  // (not when some other box on the page scrolls, like a carousel).
  window.addEventListener('scroll', (e) => { if (menu && (e.target === document || e.target.contains?.(menu.el))) hide(); }, true);
  window.addEventListener('resize', () => { if (menu) hide(); });
  window.addEventListener('pagehide', () => { if (menu) hide(); });

  // ---------------------------------------------------------------- filling what the person picked
  const SETTERS = new Map([HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement].map((C) => [C, Object.getOwnPropertyDescriptor(C.prototype, 'value').set]));
  function setValue(el, value) {
    // The prototype's setter, so pages built with React and the like see the change.
    SETTERS.get(isSelect(el) ? HTMLSelectElement : isArea(el) ? HTMLTextAreaElement : HTMLInputElement).call(el, value);
    filled.add(el);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const lc = (s) => String(s ?? '').trim().toLowerCase();
  const pad2 = (n) => String(n).padStart(2, '0');
  const US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
  // Country names (English and Spanish) to two-letter codes, built once from the browser's own list.
  let countries = null;
  function countryCode(v) {
    const s = lc(v).replace(/\./g, '');
    if (!s) return '';
    if (/^[a-z]{2}$/.test(s)) return s;
    if (!countries) {
      countries = new Map([['usa', 'us'], ['united states of america', 'us'], ['uk', 'gb'], ['great britain', 'gb'], ['england', 'gb']]);
      const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      for (const lang of ['en', 'es']) {
        let names;
        try { names = new Intl.DisplayNames([lang], { type: 'region' }); } catch { continue; }
        for (const a of A) for (const b of A) {
          const name = names.of(a + b);
          if (name && name !== a + b && !/unknown/i.test(name)) countries.set(lc(name), (a + b).toLowerCase());
        }
      }
    }
    return countries.get(s) || '';
  }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  // "04", "4 - April", "April" or "abril" -> 4.
  function monthOf(text) {
    const t = lc(text);
    const n = Number(t.match(/^\d{1,2}\b/)?.[0]);
    if (n >= 1 && n <= 12) return n;
    const i = Math.max(MONTHS.indexOf(t.slice(0, 3)), MESES.indexOf(t.slice(0, 3)));
    return i >= 0 ? i + 1 : null;
  }

  // The option of a <select> that means this value.
  function option(select, type, v) {
    const opts = [...select.options].filter((o) => !o.disabled && (o.value || o.text.trim()));
    const is = (o, wanted) => wanted.some((w) => w && (lc(o.value) === w || lc(o.text) === w));
    if (type === 'country') {
      const code = countryCode(v.country);
      return opts.find((o) => is(o, [lc(v.country)])) || (code && opts.find((o) => countryCode(o.value) === code || countryCode(o.text) === code));
    }
    if (type === 'state') {
      const s = lc(v.state);
      const abbr = Object.keys(US_STATES).find((k) => lc(k) === s || lc(US_STATES[k]) === s);
      return opts.find((o) => is(o, [s, abbr && lc(abbr), abbr && lc(US_STATES[abbr])]));
    }
    if (type === 'cc-exp-month') return opts.find((o) => Number(o.value) === v.expMonth || monthOf(o.text) === v.expMonth);
    if (type === 'cc-exp-year') return opts.find((o) => is(o, [String(v.expYear), String(v.expYear).slice(2)]));
    return opts.find((o) => is(o, [lc(v[type])]));
  }

  // The value for a field of this type, or '' to leave it alone.
  function valueFor(el, type, v) {
    if (isSelect(el)) return option(el, type, v)?.value ?? '';
    const parts = String(v.name || '').trim().split(/\s+/);
    const family = parts.length > 1 ? parts.pop() : '';
    const lines = String(v.street || '').split('\n');
    switch (type) {
      case 'given': case 'cc-given': return parts.join(' ');
      case 'family': case 'cc-family': return family;
      case 'middle': case 'line3': return '';
      case 'cc-name': return v.name || '';
      case 'street': return isArea(el) ? v.street : lines.join(', ');
      case 'line1': return lines[0] || '';
      case 'line2': return lines.slice(1).join(', ');
      case 'cc-number': return v.number || '';
      case 'cc-exp-month': return v.expMonth ? pad2(v.expMonth) : '';
      case 'cc-exp-year': return v.expYear ? (el.maxLength === 2 || /^(yy|aa)$/i.test(el.placeholder) ? String(v.expYear).slice(2) : String(v.expYear)) : '';
      case 'cc-exp': {
        if (!v.expMonth || !v.expYear) return '';
        const long = /yyyy|aaaa/i.test(el.placeholder) || el.maxLength >= 7;
        const sep = / \/ /.test(el.placeholder) ? ' / ' : '/';
        return pad2(v.expMonth) + sep + (long ? String(v.expYear) : String(v.expYear).slice(2));
      }
      default: return v[type] || '';
    }
  }

  ipcRenderer.on('af:closed', () => { menu = null; });
  ipcRenderer.on('af:fill', (_e, msg) => {
    menu = null;
    const el = anchor && document.contains(anchor) ? anchor : document.activeElement;
    if (!msg || !el || !fieldEl(el)) return;
    if (msg.mode === 'history') { setValue(el, String(msg.value || '')); return; }
    const want = msg.mode === 'card' ? CARD_TYPES : ADDRESS_TYPES;
    const v = msg.values || {};
    const fields = fieldsOf(scopeOf(el));
    for (const f of fields) {
      if (!want.has(f.type) || f.type === 'cc-csc') continue;
      if (f.el !== el && !isSelect(f.el) && f.el.value) continue; // keep what the person typed
      const value = valueFor(f.el, f.type, v);
      if (value !== '' && value != null && value !== f.el.value) setValue(f.el, value);
    }
    // The security code is never saved: put the cursor there to type it.
    const csc = msg.mode === 'card' && fields.find((f) => f.type === 'cc-csc' && !f.el.value);
    if (csc) csc.el.focus();
  });

  // ---------------------------------------------------------------- noticing a form sent
  function luhn(n) {
    if (!/^\d{12,19}$/.test(n)) return false;
    let sum = 0;
    for (let i = 0; i < n.length; i++) { let d = Number(n[n.length - 1 - i]); if (i % 2) { d *= 2; if (d > 9) d -= 9; } sum += d; }
    return sum % 10 === 0;
  }
  const valueOf = (el) => (isSelect(el) ? (el.value ? (el.options[el.selectedIndex]?.text || el.value).trim() : '') : el.value.trim());

  let lastSent = 0;
  let lastKey = '';
  function capture(scope, withHistory) {
    const fields = fieldsOf(scope).filter((f) => f.type !== 'cc-csc'); // never read the security code
    const get = (type) => fields.filter((f) => f.type === type).map((f) => valueOf(f.el)).find(Boolean) || '';
    let address = null;
    if (addressForm(fields)) {
      address = {
        name: get('name') || [get('given'), get('middle'), get('family')].filter(Boolean).join(' '),
        organization: get('organization'),
        street: get('street') || [get('line1'), get('line2'), get('line3')].filter(Boolean).join('\n'),
        city: get('city'), state: get('state'), zip: get('zip'), country: get('country'), phone: get('phone'), email: get('email'),
      };
      const n = Object.values(address).filter(Boolean).length;
      if (n < 3 || !(address.street || (address.city && address.zip))) address = null;
      if (address && !fields.some((f) => ADDRESS_TYPES.has(f.type) && touched(f.el))) address = null;
    }
    let card = null;
    const number = get('cc-number').replace(/[\s-]/g, '');
    if (window.isSecureContext && luhn(number) && fields.some((f) => f.type === 'cc-number' && touched(f.el))) {
      let expMonth = monthOf(get('cc-exp-month'));
      let expYear = Number(get('cc-exp-year').match(/\d{2,4}/)?.[0]) || null;
      const exp = get('cc-exp').match(/^(\d{1,2})\s*[/\-. ]?\s*(\d{2}|\d{4})$/);
      if (exp) { expMonth = Number(exp[1]); expYear = Number(exp[2]); }
      card = { number, name: get('cc-name') || [get('cc-given'), get('cc-family')].filter(Boolean).join(' '), expMonth, expYear };
    }
    const history = [];
    if (withHistory && !hasPassword(scope)) {
      for (const el of scope.querySelectorAll('input')) {
        const key = typed.has(el) && fieldEl(el) && visible(el) && historyKey(el);
        const f = fields.find((x) => x.el === el);
        if (!key || (f && (CARD_TYPES.has(f.type) || (address && ADDRESS_TYPES.has(f.type))))) continue;
        const value = el.value.trim();
        if (value) history.push({ key, value: value.slice(0, 200) });
      }
    }
    if (!address && !card && !history.length) return;
    // The same form sent twice (its button, then its submit) goes to Lumio once.
    const key = JSON.stringify([address, card]);
    if (key === lastKey && !history.length && Date.now() - lastSent < 60_000) return;
    lastKey = key;
    lastSent = Date.now();
    ipcRenderer.send('af:captured', { address, card, history: history.slice(0, 30) });
  }
  const SEND_WORDS = /\b(submit|continue|next|save|place order|order|pay|buy|checkout|check out|confirm|sign up|register|send|enviar|continuar|siguiente|guardar|pagar|comprar|confirmar|registrar)/i;
  document.addEventListener('submit', (e) => { if (e.target instanceof HTMLFormElement) capture(e.target, true); }, true);
  // Checkouts that send with a button and script instead of a real form submit.
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const btn = e.target.closest?.('button, input[type=submit], input[type=image], [role=button]');
    if (!btn) return;
    const text = [btn.innerText, btn.value, btn.getAttribute('aria-label')].filter(Boolean).join(' ');
    if (btn.type !== 'submit' && !SEND_WORDS.test(text)) return;
    const scope = scopeOf(btn);
    setTimeout(() => capture(scope, false), 0);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.isTrusted && e.key === 'Enter' && textField(e.target) && !isArea(e.target) && e.target.form) capture(e.target.form, true);
  }, true);
}
