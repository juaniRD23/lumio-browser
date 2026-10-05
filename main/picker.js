// "Who's using Lumio?": the profile picker window. It shows at launch when
// there are several profiles (unless "Show on startup" is off) and from the
// account menu's Manage profiles. Its page (renderer/ui/picker.*) opens,
// adds and deletes profiles through main.js ('profiles:…' messages).
const path = require('path');
const theme = require('./theme');

const SHELL_PRELOAD = path.join(__dirname, '..', 'preload', 'dist', 'shell.js');

class ProfilePicker {
  // state: () => what the page shows ({ profiles, showPicker, … }).
  // onClosed: the window closed (main.js decides whether Lumio quits).
  constructor({ state, onClosed = () => {} }) {
    this.state = state;
    this.onClosed = onClosed;
    this.win = null;
  }

  isOurs(wc) { return !!this.win && !this.win.isDestroyed() && this.win.webContents === wc; }
  get isOpen() { return !!this.win && !this.win.isDestroyed(); }

  // mode: 'pick' (choose a profile) or 'add' (straight to adding one).
  open({ mode = 'pick' } = {}) {
    const { BrowserWindow } = require('electron');
    if (this.isOpen) {
      this.win.webContents.send('profiles-changed', { ...this.state(), mode });
      this.win.show();
      this.win.focus();
      return this.win;
    }
    const win = new BrowserWindow({
      width: 820, height: 600, minWidth: 560, minHeight: 460, center: true,
      title: 'Lumio Browser', show: false, autoHideMenuBar: true,
      backgroundColor: theme.colors(theme.isDark()).frame,
      webPreferences: { preload: SHELL_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    this.win = win;
    const stopTheme = theme.onChange(() => { if (!win.isDestroyed()) win.setBackgroundColor(theme.colors(theme.isDark()).frame); });
    win.on('closed', () => { stopTheme(); if (this.win === win) this.win = null; this.onClosed(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => { if (!process.env.LUMIO_HIDDEN) { win.show(); win.focus(); } });
    win.loadURL(`lumio://picker/${mode === 'add' ? '#add' : ''}`);
    return win;
  }

  // The list changed (a profile was added, renamed, signed in or deleted).
  changed() { if (this.isOpen) this.win.webContents.send('profiles-changed', this.state()); }

  close() { if (this.isOpen) this.win.close(); }
}

module.exports = { ProfilePicker };
