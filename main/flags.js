// lumio://flags-lite: a few experimental switches, saved in settings
// ("flags") and applied as Chromium command-line switches when Lumio starts,
// so a change needs a restart. Kept small on purpose.
const fs = require('fs');
const path = require('path');

const FLAGS = [
  {
    id: 'smoothScrolling',
    name: 'Smooth scrolling',
    description: 'Animate scrolling with the mouse wheel and keyboard.',
    default: true,
    switches: (on) => (on ? [] : [['disable-smooth-scrolling']]),
  },
  {
    id: 'forceDark',
    name: 'Dark mode for all websites',
    description: 'Show websites in dark colors, even ones that don’t have a dark mode. Some sites, and Lumio’s own light pages, may look wrong.',
    default: false,
    features: (on) => (on ? ['WebContentsForceDark'] : []),
  },
  {
    id: 'parallelDownloading',
    name: 'Parallel downloading',
    description: 'Download big files in several parts at once, which can be faster.',
    default: false,
    features: (on) => (on ? ['ParallelDownloading'] : []),
  },
];

// The saved choices, filled in with defaults.
function values(saved = {}) {
  return Object.fromEntries(FLAGS.map((f) => [f.id, typeof saved[f.id] === 'boolean' ? saved[f.id] : f.default]));
}

// Command-line switches and features for a set of choices.
function switchesFor(saved) {
  const v = values(saved);
  const switches = FLAGS.flatMap((f) => (f.switches ? f.switches(v[f.id]) : []));
  const features = FLAGS.flatMap((f) => (f.features ? f.features(v[f.id]) : []));
  return { switches, features };
}

// What this launch started with (lumio://flags-lite shows "restart to apply"
// when the saved choices differ).
let applied = values();

// Before the app is ready: read the saved choices straight from settings.json.
function applyAtStartup(app, userData) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).flags || {}; } catch { /* first launch */ }
  applied = values(saved);
  const { switches, features } = switchesFor(saved);
  for (const [name, value] of switches) app.commandLine.appendSwitch(name, value);
  if (features.length) {
    // Merged with any features already asked for, which this would otherwise replace.
    const existing = app.commandLine.getSwitchValue('enable-features');
    app.commandLine.appendSwitch('enable-features', [existing, ...features].filter(Boolean).join(','));
  }
}

// For the page: each flag, its saved value, and whether a restart is needed.
function state(saved = {}) {
  const v = values(saved);
  return {
    flags: FLAGS.map((f) => ({ id: f.id, name: f.name, description: f.description, value: v[f.id], default: f.default })),
    restart: FLAGS.some((f) => v[f.id] !== applied[f.id]),
  };
}

function set(saved = {}, id, value) {
  if (!FLAGS.some((f) => f.id === id)) return saved;
  return { ...saved, [id]: !!value };
}

module.exports = { FLAGS, values, switchesFor, applyAtStartup, state, set };
