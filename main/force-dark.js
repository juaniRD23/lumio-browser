// Force dark mode for web contents (Settings › Appearance, experimental):
// Chromium darkens light websites as it draws them, like Chrome's
// chrome://flags/#enable-force-dark.
//
// Chrome's flag turns on a feature ("WebContentsForceDark") that isn't
// built into Electron 43, but the Blink setting it ends in is, and a
// command-line switch sets it: --blink-settings=forceDarkModeEnabled=true.
// Switches are read when the app starts, so a change needs a relaunch;
// Settings shows a Relaunch button until then.
//
// The switch reaches every page Chromium draws, Lumio's own window and
// pages too, and while the computer prefers light it darkens all of them
// (tests/power-user.test.mjs checks this in Chrome). So while it's on, Lumio
// itself is dark (main/theme.js): then Lumio's pages and sites with a dark
// theme of their own use their real dark colors, and only the rest are
// darkened, and the window's native parts match.

const fs = require('fs');
const path = require('path');

const KEY = 'forceDarkPages';
const RESTORE = '--lumio-restore-session'; // a relaunch reopens the windows, whatever On startup says
let startedWith = false;

// Before the app is ready (the Store isn't open yet, so it reads the file).
function applyAtStartup(app) {
  try { startedWith = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'))[KEY] === true; } catch { startedWith = false; }
  if (startedWith) appendValue(app.commandLine, 'blink-settings', 'forceDarkModeEnabled=true');
  return startedWith;
}

// Adds to a comma-separated switch instead of replacing what's there
// (Chromium reads only the last copy of a switch).
function appendValue(commandLine, name, value) {
  const prev = commandLine.hasSwitch(name) ? commandLine.getSwitchValue(name) : '';
  commandLine.appendSwitch(name, prev ? `${prev},${value}` : value);
}

// Whether this run of Lumio started with it on.
const active = () => startedWith;

// on: the setting. active: what this run of Lumio started with.
const state = (store) => ({ on: store.settings[KEY] === true, active: startedWith });

// Quits and starts again; the windows and tabs come back.
function relaunch(app, argv = process.argv) {
  app.relaunch({ args: [...argv.slice(1).filter((a) => a !== RESTORE), RESTORE] });
  app.quit();
}
const relaunched = (argv = process.argv) => argv.includes(RESTORE);

module.exports = { KEY, applyAtStartup, appendValue, active, state, relaunch, relaunched, RESTORE };
