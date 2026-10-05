// Application menu. Accelerators here are the browser's keyboard shortcuts;
// they work no matter which view (shell, page, AI panel) has focus. On
// Windows the menu bar is hidden: the same menu still provides the shortcuts.
// The ⋮ button opens buildBrowserMenu() on every platform.
const { Menu } = require('electron');

const MAC = process.platform === 'darwin';

const short = (label) => (label.length > 60 ? label.slice(0, 60) + '…' : label);

function buildMenu(cmd, state = {}) {
  const hidden = (accelerator, click) => ({ label: accelerator, accelerator, click, visible: false, acceleratorWorksWhenHidden: true });
  const tabKeys = Array.from({ length: 9 }, (_, i) => hidden(`CmdOrCtrl+${i + 1}`, () => cmd.tabIndex(i + 1)));

  const template = [
    ...(MAC ? [{
      label: 'Lumio Browser',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: cmd.settings },
        { label: 'Delete Browsing Data…', accelerator: 'Cmd+Shift+Backspace', click: cmd.clearBrowsingData },
        { label: 'Extensions', click: cmd.extensions },
        { label: 'Make Lumio Your Default Browser', click: cmd.makeDefault },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }, // every way to quit asks first about downloads and pages (main.js before-quit)
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: cmd.newTab },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: cmd.newWindow },
        { label: 'New Incognito Window', accelerator: 'CmdOrCtrl+Shift+N', click: cmd.newIncognito },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: cmd.reopenTab },
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: cmd.openFile },
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: cmd.focusOmnibox },
        ...(MAC ? [] : [hidden('Alt+D', cmd.focusOmnibox)]),
        hidden('F6', () => cmd.focusPane(1)), hidden('Shift+F6', () => cmd.focusPane(-1)),
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: cmd.closeTab },
        ...(MAC ? [] : [hidden('Ctrl+F4', cmd.closeTab)]),
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: cmd.closeWindow },
        { type: 'separator' },
        { label: 'Save Page As…', accelerator: 'CmdOrCtrl+S', click: cmd.savePage },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: cmd.print },
        { label: 'Print Using System Dialog…', accelerator: MAC ? 'Cmd+Alt+P' : 'Ctrl+Shift+P', click: cmd.printSystemDialog },
        ...(MAC ? [] : [{ type: 'separator' }, { label: 'Settings', accelerator: 'Ctrl+,', click: cmd.settings }, { label: 'Delete Browsing Data…', accelerator: 'Ctrl+Shift+Delete', click: cmd.clearBrowsingData }, { role: 'quit', label: 'Exit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: cmd.find },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => cmd.findStep(true) },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: () => cmd.findStep(false) },
        ...(MAC ? [{ label: 'Use Selection for Find', accelerator: 'Cmd+E', click: cmd.useSelectionForFind }] : []),
        ...(MAC ? [] : [hidden('F3', () => cmd.findStep(true)), hidden('Shift+F3', () => cmd.findStep(false))]),
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => cmd.reload(false) },
        { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => cmd.reload(true) },
        ...(MAC ? [{ label: 'Stop', accelerator: 'Cmd+.', click: cmd.stop }] : [hidden('F5', () => cmd.reload(false)), hidden('Ctrl+F5', () => cmd.reload(true)), hidden('Shift+F5', () => cmd.reload(true))]),
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => cmd.zoom(1) },
        hidden('CmdOrCtrl+=', () => cmd.zoom(1)),
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => cmd.zoom(-1) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => cmd.zoom(0) },
        { type: 'separator' },
        {
          label: 'Appearance',
          submenu: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]
            .map(([id, label]) => ({ label, type: 'radio', checked: state.appearance === id, click: () => cmd.setAppearance(id) })),
        },
        { label: 'Always Show Bookmarks Bar', type: 'checkbox', checked: !!state.bookmarksBar, accelerator: 'CmdOrCtrl+Shift+B', click: cmd.toggleBookmarksBar },
        { label: 'Show/Hide Sidebar', accelerator: 'CmdOrCtrl+Shift+S', click: cmd.toggleSidebar },
        { label: 'Show/Hide Lumio AI', accelerator: 'CmdOrCtrl+Shift+L', click: cmd.togglePanel },
        { label: 'Ask Lumio', accelerator: MAC ? 'Cmd+J' : 'Ctrl+Shift+K', click: cmd.focusAI },
        { type: 'separator' },
        { label: 'View Page Source', accelerator: MAC ? 'Cmd+Alt+U' : 'Ctrl+U', click: cmd.viewSource },
        { label: 'Developer Tools', accelerator: MAC ? 'Cmd+Alt+I' : 'Ctrl+Shift+I', click: cmd.devtools },
        { label: 'JavaScript Console', accelerator: MAC ? 'Cmd+Alt+J' : 'Ctrl+Shift+J', click: cmd.console },
        ...(MAC ? [] : [hidden('F12', cmd.devtools)]),
        ...(cmd.isDev ? [{ label: 'Browser UI Developer Tools', accelerator: 'CmdOrCtrl+Alt+Shift+I', click: cmd.shellDevtools }] : []),
        { type: 'separator' },
        { role: 'togglefullscreen', ...(MAC ? {} : { accelerator: 'F11' }) },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: MAC ? 'Cmd+[' : 'Alt+Left', click: cmd.back },
        { label: 'Forward', accelerator: MAC ? 'Cmd+]' : 'Alt+Right', click: cmd.forward },
        ...(MAC ? [hidden('Cmd+Left', cmd.back), hidden('Cmd+Right', cmd.forward)] : []),
        { label: 'Home', accelerator: MAC ? 'Cmd+Shift+H' : 'Alt+Home', click: cmd.home },
        { type: 'separator' },
        { label: 'Recently Closed', enabled: false },
        // A closed window opens whole, or one of its tabs. (Page titles aren't translated.)
        ...(state.recentlyClosed || []).map((e) => (e.tabs?.length > 1
          ? { label: short(e.label), translate: false, submenu: [{ label: 'Restore Window', click: () => cmd.reopenClosed(e.index) }, { type: 'separator' }, ...e.tabs.map((t, i) => ({ label: short(t), translate: false, click: () => cmd.reopenClosed(e.index, i) }))] }
          : { label: short(e.label), translate: false, click: () => cmd.reopenClosed(e.index) })),
        { type: 'separator' },
        { label: 'Show All History', accelerator: MAC ? 'Cmd+Y' : 'Ctrl+H', click: cmd.history },
        { label: 'Downloads', accelerator: MAC ? 'Cmd+Alt+L' : 'Ctrl+J', click: cmd.downloads },
        ...(MAC ? [hidden('Cmd+Shift+J', cmd.downloads)] : []),
      ],
    },
    {
      label: 'Bookmarks',
      submenu: [
        { label: 'Bookmark This Page…', accelerator: 'CmdOrCtrl+D', click: cmd.bookmark },
        { label: 'Bookmark All Tabs…', accelerator: 'CmdOrCtrl+Shift+D', click: cmd.bookmarkAllTabs },
        { label: 'Bookmark Manager', accelerator: MAC ? 'Cmd+Alt+B' : 'Ctrl+Shift+O', click: cmd.bookmarksManager },
        ...(MAC ? [hidden('Cmd+Shift+O', cmd.bookmarksManager)] : []),
        { type: 'separator' },
        { label: 'Add Tab to Reading List', click: cmd.addToReadingList },
        { label: 'Show Reading List', click: () => cmd.sidePanel('reading') },
      ],
    },
    {
      label: 'Profiles',
      submenu: [
        ...(state.profiles || []).map((p) => ({ label: p.name, translate: false, type: 'checkbox', checked: !!p.current, click: () => cmd.openProfile(p.id) })),
        { type: 'separator' },
        { label: 'Manage Profiles…', click: cmd.profilePicker },
        { label: 'Add Profile…', click: cmd.addProfile },
        { label: 'Open Guest Window', click: cmd.newGuest },
      ],
    },
    {
      label: 'Window',
      submenu: [
        ...(MAC ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }] : []),
        { label: 'Task Manager', ...(MAC ? {} : { accelerator: 'Shift+Escape' }), click: cmd.taskManager },
        { type: 'separator' },
        { label: 'Pin/Unpin Tab', click: cmd.pinTab },
        { label: 'Move Tab to New Window', click: cmd.moveTabToNewWindow },
        { label: 'Search Tabs…', accelerator: 'CmdOrCtrl+Shift+A', click: cmd.tabSearch },
        { type: 'separator' },
        { label: 'Show Next Tab', accelerator: MAC ? 'Cmd+Shift+]' : 'Ctrl+PageDown', click: () => cmd.cycle(1) },
        { label: 'Show Previous Tab', accelerator: MAC ? 'Cmd+Shift+[' : 'Ctrl+PageUp', click: () => cmd.cycle(-1) },
        hidden('Ctrl+Tab', () => cmd.cycle(1)),
        hidden('Ctrl+Shift+Tab', () => cmd.cycle(-1)),
        ...(MAC ? [hidden('Cmd+Alt+Right', () => cmd.cycle(1)), hidden('Cmd+Alt+Left', () => cmd.cycle(-1))] : []),
        ...tabKeys,
        ...(MAC ? [{ type: 'separator' }, { role: 'front' }] : []),
      ],
    },
    {
      role: 'help', // the Mac adds its menu search here
      submenu: [
        { label: 'Lumio Browser Help', ...(MAC ? {} : { accelerator: 'F1' }), click: cmd.help },
        { type: 'separator' },
        { label: 'Terms of Service', click: cmd.terms },
        { label: 'Privacy Policy', click: cmd.privacy },
        { label: 'Open-Source Licenses', click: cmd.credits },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// The ⋮ menu, laid out like Chrome's. Its entries are data: menuModel()
// turns them into what the overlay draws (renderer/ui/overlay.js renderMenu)
// and the actions main/window.js runs. Each shortcut shown is one the
// application menu above really has. state: main.js menuState() plus the
// window's zoom (in %), whether its page is bookmarked, the bookmarks,
// open(url) and edit('cut' | 'copy' | 'paste') for that window, and
// whatsNew() when there are release notes to open.
function buildBrowserMenu(cmd, state = {}) {
  const k = (mac, win) => (MAC ? mac : win);
  const SEP = { type: 'separator' };
  const recent = (state.recentlyClosed || []).slice(0, 8);
  const marks = (state.bookmarks || []).slice(0, 20);
  return [
    { label: 'New tab', icon: 'plus', accel: 'CmdOrCtrl+T', run: cmd.newTab },
    { label: 'New window', icon: 'window', accel: 'CmdOrCtrl+N', run: cmd.newWindow },
    { label: 'New Incognito window', icon: 'incognito', accel: 'CmdOrCtrl+Shift+N', run: cmd.newIncognito },
    SEP,
    { label: 'Passwords and autofill', icon: 'key', run: cmd.passwords },
    {
      label: 'History',
      icon: 'clock',
      submenu: [
        { label: 'History', icon: 'clock', accel: k('Cmd+Y', 'Ctrl+H'), run: cmd.history },
        SEP,
        ...(recent.length ? [{ type: 'header', label: 'Recently closed' }] : []),
        // A closed window opens whole, or one of its tabs.
        ...recent.map((e, i) => (e.tabs?.length > 1
          ? { label: e.label, icon: 'tabs', submenu: [{ label: 'Restore window', icon: 'tabs', accel: i === 0 ? 'CmdOrCtrl+Shift+T' : '', run: () => cmd.reopenClosed(e.index) }, SEP, ...e.tabs.map((t, j) => ({ label: short(t), icon: 'globe', run: () => cmd.reopenClosed(e.index, j) }))] }
          : { label: e.label, favicon: e.favicon, icon: e.window ? 'tabs' : 'globe', accel: i === 0 ? 'CmdOrCtrl+Shift+T' : '', run: () => cmd.reopenClosed(e.index) })),
      ],
    },
    { label: 'Downloads', icon: 'download', accel: k('Cmd+Alt+L', 'Ctrl+J'), run: cmd.downloads },
    {
      label: 'Bookmarks and lists',
      icon: 'star',
      submenu: [
        { label: state.bookmarked ? 'Remove bookmark' : 'Bookmark this tab', icon: state.bookmarked ? 'starFilled' : 'star', accel: 'CmdOrCtrl+D', run: cmd.bookmark },
        { label: 'Show bookmarks bar', type: 'checkbox', checked: !!state.bookmarksBar, accel: 'CmdOrCtrl+Shift+B', run: cmd.toggleBookmarksBar },
        { label: 'Bookmark all tabs…', icon: 'tabs', accel: 'CmdOrCtrl+Shift+D', run: cmd.bookmarkAllTabs },
        { label: 'Bookmark manager', icon: 'folder', accel: k('Cmd+Alt+B', 'Ctrl+Shift+O'), run: cmd.bookmarksManager },
        SEP,
        { label: 'Add tab to reading list', icon: 'list', run: cmd.addToReadingList },
        { label: 'Show reading list', icon: 'list', run: cmd.sidePanel && (() => cmd.sidePanel('reading')) },
        SEP,
        ...marks.map((b) => ({ label: b.title || b.url, favicon: b.favicon, icon: 'globe', run: () => state.open(b.url) })),
      ],
    },
    {
      label: 'Extensions',
      icon: 'puzzle',
      submenu: [
        { label: 'Manage Extensions', icon: 'puzzle', run: cmd.extensions },
        { label: 'Visit Chrome Web Store', icon: 'external', run: cmd.webStore },
      ],
    },
    SEP,
    { type: 'zoom', level: state.zoom ?? 100, out: () => cmd.zoom(-1), in: () => cmd.zoom(1), fullscreen: cmd.fullscreen, keys: { out: 'CmdOrCtrl+-', in: 'CmdOrCtrl+Plus', fullscreen: k('Ctrl+Cmd+F', 'F11') } },
    SEP,
    { label: 'Print…', icon: 'print', accel: 'CmdOrCtrl+P', run: cmd.print },
    { label: 'Find…', icon: 'search', accel: 'CmdOrCtrl+F', run: cmd.find },
    { label: 'Save page as…', icon: 'page', accel: 'CmdOrCtrl+S', run: cmd.savePage },
    {
      label: 'More tools',
      icon: 'tools',
      submenu: [
        { label: 'Delete browsing data…', icon: 'trash', accel: k('Cmd+Shift+Backspace', 'Ctrl+Shift+Delete'), run: cmd.clearBrowsingData },
        { label: 'Task manager', icon: 'gauge', accel: MAC ? '' : 'Shift+Escape', run: cmd.taskManager },
        SEP,
        { label: 'Developer tools', icon: 'terminal', accel: k('Cmd+Alt+I', 'Ctrl+Shift+I'), run: cmd.devtools },
        ...(cmd.isDev ? [{ label: 'Browser UI developer tools', icon: 'terminal', accel: 'CmdOrCtrl+Alt+Shift+I', run: cmd.shellDevtools }] : []),
      ],
    },
    SEP,
    { type: 'edit', cut: () => state.edit('cut'), copy: () => state.edit('copy'), paste: () => state.edit('paste'), keys: { cut: 'CmdOrCtrl+X', copy: 'CmdOrCtrl+C', paste: 'CmdOrCtrl+V' } },
    SEP,
    { label: 'Settings', icon: 'gear', accel: k('Cmd+,', 'Ctrl+,'), run: cmd.settings },
    {
      label: 'Help',
      icon: 'info',
      submenu: [
        { label: 'About Lumio Browser', icon: 'info', run: cmd.about },
        // The release notes, once the updater has looked them up (menuModel()
        // leaves it out until then).
        { label: 'What’s new', icon: 'external', run: state.whatsNew },
        SEP,
        { label: 'Terms of Service', icon: 'page', run: cmd.terms },
        { label: 'Privacy Policy', icon: 'page', run: cmd.privacy },
        { label: 'Open-source licenses', icon: 'page', run: cmd.credits },
      ],
    },
    { label: MAC ? 'Quit Lumio Browser' : 'Exit', icon: 'logout', accel: MAC ? 'Cmd+Q' : '', run: cmd.quit },
  ];
}

// An accelerator as menus show it: ⇧⌘N on the Mac, Ctrl+Shift+N elsewhere.
const MAC_MODS = { cmdorctrl: '⌘', commandorcontrol: '⌘', cmd: '⌘', command: '⌘', ctrl: '⌃', control: '⌃', alt: '⌥', option: '⌥', shift: '⇧' };
const KEY_NAMES = { plus: '+', left: '←', right: '→', up: '↑', down: '↓' };
function accelLabel(accel, mac = MAC) {
  if (!accel) return '';
  const parts = accel.split(/\+(?!$)/);
  const key = parts.pop();
  if (!mac) return [...parts.map((m) => (/^(cmdorctrl|commandorcontrol|cmd|command)$/i.test(m) ? 'Ctrl' : m)), key].join('+');
  const mods = parts.map((m) => MAC_MODS[m.toLowerCase()] || m);
  return ['⌃', '⌥', '⇧', '⌘'].filter((m) => mods.includes(m)).join('') + (KEY_NAMES[key.toLowerCase()] || key);
}

// buildBrowserMenu()'s entries as the overlay draws them (plain data, with
// shortcuts written out), and what each one does by id. Commands this build
// doesn't have are left out, and so are the separators that leaves stranded.
function menuModel(entries, { mac = MAC } = {}) {
  const actions = new Map();
  let n = 0;
  const act = (run, keepOpen = false) => {
    const id = `m${++n}`;
    actions.set(id, { run, keepOpen });
    return id;
  };
  const build = (list) => {
    const out = [];
    for (const e of list) {
      if ('run' in e && typeof e.run !== 'function') continue;
      let item;
      if (e.type === 'separator') item = { type: 'separator' };
      else if (e.type === 'header') item = { type: 'header', label: e.label };
      // Zoom's − and + leave the menu open, so you can watch the number change.
      else if (e.type === 'zoom') {
        item = { type: 'zoom', label: 'Zoom', level: e.level, out: act(e.out, true), in: act(e.in, true), fullscreen: act(e.fullscreen), keys: { out: accelLabel(e.keys.out, mac), in: accelLabel(e.keys.in, mac), fullscreen: accelLabel(e.keys.fullscreen, mac) } };
      } else if (e.type === 'edit') {
        item = { type: 'edit', label: 'Edit', cut: act(e.cut), copy: act(e.copy), paste: act(e.paste), keys: { cut: accelLabel(e.keys.cut, mac), copy: accelLabel(e.keys.copy, mac), paste: accelLabel(e.keys.paste, mac) } };
      } else {
        item = { label: e.label, icon: e.icon || '', favicon: e.favicon || '', accel: accelLabel(e.accel, mac) };
        if (e.type === 'checkbox') item.checked = !!e.checked;
        if (e.submenu) {
          item.submenu = build(e.submenu);
          if (!item.submenu.some((x) => x.type !== 'separator' && x.type !== 'header')) continue;
        } else item.id = act(e.run);
      }
      if (item.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator')) continue;
      out.push(item);
    }
    while (out[out.length - 1]?.type === 'separator') out.pop();
    return out;
  };
  return { items: build(entries), actions };
}

module.exports = { buildMenu, buildBrowserMenu, menuModel, accelLabel };
