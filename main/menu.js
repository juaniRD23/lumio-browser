// Application menu. Accelerators here are the browser's keyboard shortcuts;
// they work no matter which view (shell, page, AI panel) has focus. On
// Windows the menu bar is hidden: the same menu still provides the shortcuts,
// and the ⋮ button opens buildBrowserMenu() instead.
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
        { role: 'quit' },
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
        ...(MAC ? [] : [hidden('Alt+D', cmd.focusOmnibox), hidden('F6', cmd.focusOmnibox)]),
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: cmd.closeTab },
        ...(MAC ? [] : [hidden('Ctrl+F4', cmd.closeTab)]),
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: cmd.closeWindow },
        { type: 'separator' },
        { label: 'Save Page As…', accelerator: 'CmdOrCtrl+S', click: cmd.savePage },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: cmd.print },
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
        // A closed window opens whole, or one of its tabs.
        ...(state.recentlyClosed || []).map((e) => (e.tabs?.length > 1
          ? { label: short(e.label), submenu: [{ label: 'Restore Window', click: () => cmd.reopenClosed(e.index) }, { type: 'separator' }, ...e.tabs.map((t, i) => ({ label: short(t), click: () => cmd.reopenClosed(e.index, i) }))] }
          : { label: short(e.label), click: () => cmd.reopenClosed(e.index) })),
        { type: 'separator' },
        { label: 'Show All History', accelerator: MAC ? 'Cmd+Y' : 'Ctrl+H', click: cmd.history },
        { label: 'Downloads', accelerator: MAC ? 'Cmd+Alt+L' : 'Ctrl+J', click: cmd.downloads },
        ...(MAC ? [hidden('Cmd+Shift+J', cmd.downloads)] : []),
      ],
    },
    {
      label: 'Bookmarks',
      submenu: [
        { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: cmd.bookmark },
        { label: 'Bookmark All Tabs', accelerator: 'CmdOrCtrl+Shift+D', click: cmd.bookmarkAllTabs },
        { label: 'Bookmark Manager', accelerator: MAC ? 'Cmd+Alt+B' : 'Ctrl+Shift+O', click: cmd.bookmarksManager },
        ...(MAC ? [hidden('Cmd+Shift+O', cmd.bookmarksManager)] : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        ...(MAC ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }] : []),
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
      role: 'help',
      submenu: [{ label: 'Lumio Browser Help', ...(MAC ? {} : { accelerator: 'F1' }), click: cmd.help }],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// The ⋮ menu (Windows), laid out like Chrome's.
function buildBrowserMenu(cmd, state = {}) {
  const k = (mac, win) => (MAC ? mac : win);
  return Menu.buildFromTemplate([
    { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: cmd.newTab },
    { label: 'New window', accelerator: 'CmdOrCtrl+N', click: cmd.newWindow },
    { label: 'New Incognito window', accelerator: 'CmdOrCtrl+Shift+N', click: cmd.newIncognito },
    { type: 'separator' },
    { label: 'Passwords and autofill', click: cmd.passwords },
    { label: 'History', accelerator: k('Cmd+Y', 'Ctrl+H'), click: cmd.history },
    { label: 'Downloads', accelerator: k('Cmd+Alt+L', 'Ctrl+J'), click: cmd.downloads },
    { label: 'Delete browsing data…', accelerator: k('Cmd+Shift+Backspace', 'Ctrl+Shift+Delete'), click: cmd.clearBrowsingData },
    {
      label: 'Bookmarks',
      submenu: [
        { label: 'Bookmark this page', accelerator: 'CmdOrCtrl+D', click: cmd.bookmark },
        { label: 'Show bookmarks bar', type: 'checkbox', checked: !!state.bookmarksBar, accelerator: 'CmdOrCtrl+Shift+B', click: cmd.toggleBookmarksBar },
        { label: 'Bookmark manager', accelerator: k('Cmd+Alt+B', 'Ctrl+Shift+O'), click: cmd.bookmarksManager },
      ],
    },
    { label: 'Extensions', click: cmd.extensions },
    { type: 'separator' },
    { label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', click: () => cmd.zoom(1) },
    { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => cmd.zoom(-1) },
    { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => cmd.zoom(0) },
    { type: 'separator' },
    { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: cmd.print },
    { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: cmd.find },
    { label: 'Save page as…', accelerator: 'CmdOrCtrl+S', click: cmd.savePage },
    { label: 'Developer tools', accelerator: k('Cmd+Alt+I', 'Ctrl+Shift+I'), click: cmd.devtools },
    { type: 'separator' },
    { label: 'Settings', click: cmd.settings },
    { label: 'About Lumio Browser', click: cmd.about },
    { type: 'separator' },
    { role: 'quit', label: MAC ? 'Quit Lumio Browser' : 'Exit' },
  ]);
}

module.exports = { buildMenu, buildBrowserMenu };
