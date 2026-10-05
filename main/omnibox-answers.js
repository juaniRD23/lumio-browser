// Answers shown in the address bar while you type: arithmetic ("2+2*3",
// "15% of 80", "sqrt(2)") and simple unit conversions ("10 km in miles").
// A small parser of its own, never eval, so typed text can't run code.
// Pure functions, no Electron imports (tests/omnibox.test.mjs).

const MAX_LEN = 100;
const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  ln: Math.log, log: Math.log10, exp: Math.exp, round: Math.round, floor: Math.floor, ceil: Math.ceil,
};
const CONSTS = { pi: Math.PI, 'π': Math.PI, e: Math.E };

// "2 × (3 + 4)" -> [2, '*', '(', 3, '+', 4, ')']. Unknown words fail.
function tokenize(text) {
  const out = [];
  const s = text.toLowerCase();
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = /^(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?/.exec(s.slice(i));
    if (num) { out.push(Number(num[0])); i += num[0].length; continue; }
    if (s.startsWith('**', i)) { out.push('^'); i += 2; continue; }
    if ('+-*/^()%'.includes(ch)) { out.push(ch); i++; continue; }
    if ('×·x'.includes(ch)) { out.push('*'); i++; continue; }
    if (ch === '÷') { out.push('/'); i++; continue; }
    if (ch === '−') { out.push('-'); i++; continue; }
    const word = /^[a-zπ]+/.exec(s.slice(i));
    if (!word) return null;
    const w = word[0];
    if (w in FUNCS || w in CONSTS || w === 'of') out.push({ word: w });
    else return null;
    i += w.length;
  }
  return out;
}

// Recursive descent: expr = term (± term)*; term = power (×÷ power)*;
// power = unary (^ power)?; unary = ± unary | postfix; postfix = primary %?
function evaluate(tokens) {
  let pos = 0;
  let depth = 0;
  let operators = 0; // binary operators, % and functions seen: a bare number isn't a sum
  const peek = () => tokens[pos];
  const isOp = (t, op) => t === op;
  function primary() {
    const t = tokens[pos++];
    if (typeof t === 'number') return t;
    if (t === '(') {
      if (++depth > 20) throw new Error('too deep');
      const v = expr();
      if (tokens[pos++] !== ')') throw new Error(') expected');
      depth--;
      return v;
    }
    if (t && t.word in CONSTS) return CONSTS[t.word];
    if (t && t.word in FUNCS) {
      operators++;
      if (tokens[pos] !== '(') throw new Error('( expected');
      return FUNCS[t.word](primary());
    }
    throw new Error('unexpected');
  }
  function postfix() {
    let v = primary();
    if (isOp(peek(), '%')) {
      pos++;
      operators++;
      v /= 100;
      // "15% of 80"
      if (peek()?.word === 'of') { pos++; v *= unary(); }
    }
    return v;
  }
  function unary() {
    if (isOp(peek(), '-')) { pos++; return -unary(); }
    if (isOp(peek(), '+')) { pos++; return unary(); }
    return postfix();
  }
  function power() {
    const base = unary();
    if (isOp(peek(), '^')) { pos++; operators++; return base ** power(); }
    return base;
  }
  function term() {
    let v = power();
    while (isOp(peek(), '*') || isOp(peek(), '/')) {
      const op = tokens[pos++];
      operators++;
      const r = power();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function expr() {
    let v = term();
    while (isOp(peek(), '+') || isOp(peek(), '-')) {
      const op = tokens[pos++];
      operators++;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const value = expr();
  if (pos !== tokens.length) throw new Error('trailing input');
  return { value, operators };
}

function formatNumber(v, digits = 12) {
  if (Object.is(v, -0)) v = 0;
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) return v.toExponential(6).replace(/\.?0+e/, 'e');
  return String(Number(v.toPrecision(digits)));
}

// "2+2" -> { expr: '2+2', value: 4, answer: '4' }. Null for anything that
// isn't plain arithmetic, a bare number, or looks like a date or phone number.
function calculate(raw) {
  const text = String(raw || '').trim().replace(/=\s*$/, '').trim();
  if (!text || text.length > MAX_LEN) return null;
  if (/^\d{4}-\d{1,2}-\d{1,2}$|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$|^\(?\d{3}\)?[\s-]\d{3}-?\d{4}$|^\d{3}-\d{4}$/.test(text)) return null;
  const tokens = tokenize(text);
  if (!tokens || !tokens.length) return null;
  let result;
  try { result = evaluate(tokens); } catch { return null; }
  if (!result.operators || !Number.isFinite(result.value)) return null;
  return { expr: text, value: result.value, answer: formatNumber(result.value) };
}

// ---------------------------------------------------------------- units
// Each unit: its kind, how many base units it is, the names people type.
const UNITS = [
  // length (meters)
  ['length', 0.001, 'mm', ['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres']],
  ['length', 0.01, 'cm', ['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres']],
  ['length', 1, 'm', ['m', 'meter', 'meters', 'metre', 'metres']],
  ['length', 1000, 'km', ['km', 'kilometer', 'kilometers', 'kilometre', 'kilometres']],
  ['length', 0.0254, 'in', ['in', 'inch', 'inches', '"']],
  ['length', 0.3048, 'ft', ['ft', 'foot', 'feet', "'"]],
  ['length', 0.9144, 'yd', ['yd', 'yard', 'yards']],
  ['length', 1609.344, 'mi', ['mi', 'mile', 'miles']],
  ['length', 1852, 'nmi', ['nmi', 'nautical mile', 'nautical miles']],
  // mass (kilograms)
  ['mass', 1e-6, 'mg', ['mg', 'milligram', 'milligrams']],
  ['mass', 0.001, 'g', ['g', 'gram', 'grams', 'gramme', 'grammes']],
  ['mass', 1, 'kg', ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms']],
  ['mass', 1000, 't', ['t', 'tonne', 'tonnes', 'metric ton', 'metric tons']],
  ['mass', 0.028349523125, 'oz', ['oz', 'ounce', 'ounces']],
  ['mass', 0.45359237, 'lb', ['lb', 'lbs', 'pound', 'pounds']],
  ['mass', 6.35029318, 'st', ['st', 'stone', 'stones']],
  // volume (liters, US customary)
  ['volume', 0.001, 'ml', ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres']],
  ['volume', 0.01, 'cl', ['cl', 'centiliter', 'centiliters', 'centilitre', 'centilitres']],
  ['volume', 1, 'L', ['l', 'liter', 'liters', 'litre', 'litres']],
  ['volume', 0.00492892159375, 'tsp', ['tsp', 'teaspoon', 'teaspoons']],
  ['volume', 0.01478676478125, 'tbsp', ['tbsp', 'tablespoon', 'tablespoons']],
  ['volume', 0.0295735295625, 'fl oz', ['fl oz', 'floz', 'fluid ounce', 'fluid ounces']],
  ['volume', 0.2365882365, 'cups', ['cup', 'cups']],
  ['volume', 0.473176473, 'pt', ['pt', 'pint', 'pints']],
  ['volume', 0.946352946, 'qt', ['qt', 'quart', 'quarts']],
  ['volume', 3.785411784, 'gal', ['gal', 'gallon', 'gallons']],
  // time (seconds)
  ['time', 0.001, 'ms', ['ms', 'millisecond', 'milliseconds']],
  ['time', 1, 's', ['s', 'sec', 'secs', 'second', 'seconds']],
  ['time', 60, 'min', ['min', 'mins', 'minute', 'minutes']],
  ['time', 3600, 'h', ['h', 'hr', 'hrs', 'hour', 'hours']],
  ['time', 86400, 'days', ['d', 'day', 'days']],
  ['time', 604800, 'weeks', ['wk', 'week', 'weeks']],
  // speed (meters per second)
  ['speed', 1, 'm/s', ['m/s', 'mps', 'meters per second']],
  ['speed', 1 / 3.6, 'km/h', ['km/h', 'kmh', 'kph', 'kmph', 'kilometers per hour']],
  ['speed', 0.44704, 'mph', ['mph', 'mi/h', 'miles per hour']],
  ['speed', 0.3048, 'ft/s', ['ft/s', 'fps', 'feet per second']],
  ['speed', 1852 / 3600, 'kn', ['kn', 'kt', 'knot', 'knots']],
  // temperature (handled below)
  ['temp', 0, '°C', ['c', '°c', 'celsius', 'centigrade', 'degrees celsius', 'degrees c']],
  ['temp', 0, '°F', ['f', '°f', 'fahrenheit', 'degrees fahrenheit', 'degrees f']],
  ['temp', 0, 'K', ['k', 'kelvin', 'kelvins']],
].map(([kind, factor, label, names]) => ({ kind, factor, label, names }));
const BY_NAME = new Map(UNITS.flatMap((u) => u.names.map((n) => [n, u])));

const toKelvin = { '°C': (v) => v + 273.15, '°F': (v) => (v - 32) * (5 / 9) + 273.15, K: (v) => v };
const fromKelvin = { '°C': (v) => v - 273.15, '°F': (v) => (v - 273.15) * (9 / 5) + 32, K: (v) => v };

const unitOf = (name) => BY_NAME.get(name.trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' '));

// "10 km in miles" -> { value: 6.21371, answer: '6.21371 mi', title: '10 km = 6.21371 mi' }
function convert(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > MAX_LEN) return null;
  const m = /^(-?(?:\d+(?:\.\d+)?|\.\d+))\s*([a-z°"'/ ]+?)\s+(?:to|in|into|as|=)\s+([a-z°"'/ ]+?)\s*\??$/i.exec(text);
  if (!m) return null;
  const from = unitOf(m[2]);
  const to = unitOf(m[3]);
  if (!from || !to || from.kind !== to.kind || from === to) return null;
  const n = Number(m[1]);
  const value = from.kind === 'temp' ? fromKelvin[to.label](toKelvin[from.label](n)) : (n * from.factor) / to.factor;
  if (!Number.isFinite(value)) return null;
  const answer = `${formatNumber(value, 6)} ${to.label}`;
  return { value, answer, title: `${formatNumber(n, 12)} ${from.label} = ${answer}` };
}

// The answer row for what's typed, if any: { title, answer }.
function answerFor(text) {
  const c = convert(text);
  if (c) return { title: c.title, answer: c.answer };
  const r = calculate(text);
  if (r) return { title: `= ${r.answer}`, answer: r.answer };
  return null;
}

module.exports = { calculate, convert, answerFor, formatNumber };
