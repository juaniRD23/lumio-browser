# Earlier work in this batch (b7a)
# Earlier work in batch b7a (rebuilt from logs)

## profiles-perf — FINISHED (run wf_6030456a-699)

I built all three parts. Profiles, Task Manager and Performance are done except tab memory in hover cards, which I skipped because this branch has no hover-card API. `npm test` passes: 180 tests, 177 pass, 0 fail, 3 skipped (they only run on Windows). I didn't launch the app, so none of this has run in real Electron. The new e2e file is written but only runs on CI.

**1. Profiles: done**
- **Existing users:** the current data becomes the first profile and nothing moves: same files in userData, same `persist:lumio` session. Its `settings.json` also keeps the app-wide settings (appearance, performance, update state).
- **New profiles:** each gets `userData/Profiles/<id>` and its own `persist:lumio-<id>` session. Each has its own history, bookmarks, settings, passwords, chats, extensions, Lumio sign-in, sync and phone link. Each profile shows up in Sync as its own device, e.g. "MacBook (Work)".
- **Startup:** "Who's using Lumio?" shows at launch when there are 2+ profiles, with a "Show on startup" toggle. Otherwise the profiles that were open at quit come back. The picker also handles Add, Edit, Guest mode and delete. Delete asks for confirmation, signs the profile out of Lumio, closes its windows and removes its folders, and finishes cleanup at the next launch for files still in use. It works with the keyboard and in light and dark.
- **Switching:** the account menu has Other profiles plus Add, Guest and Manage. There's a Profiles menu on the Mac, and Settings › You and Lumio has a Manage profiles button.
- **Which profile a window belongs to:** the avatar and window title show it ("(Work)", "(Guest)").
- **Incognito:** works per profile, with one throwaway session per profile.
- **Guest:** in-memory session, no history, its own temporary folder. On the last Guest window closing it signs out of Lumio and wipes everything. Guest can't open incognito windows.
- **Picker closed without a choice:** on Windows Lumio quits, like Chrome. On the Mac it stays in the Dock.

**2. Task Manager: done**
- Opens with Shift+Esc on Windows, from Window › Task Manager on the Mac, from the ⋮ menu, and from Settings › Performance.
- Lists the browser, GPU, utility processes, each tab, extensions and Lumio's own windows, with Memory, CPU, Network and Process ID. It refreshes every second.
- Columns sort; arrow keys choose a row; Enter or double-click shows that tab; Esc closes the window.
- End process only works on pages and extensions, never on the browser, GPU or Lumio's own windows.
- The Network column is an estimate: it only counts the page's own requests, and sites that don't allow timing count as 0.

**3. Performance: done, except hover cards**
- **Memory Saver modes:** Moderate (4 h), Balanced (1 h) and Maximum (15 min). The old "sleep after" setting maps to the nearest mode.
- **"Always keep these sites active":** a list in Settings; subdomains count too.
- **Performance issues alert:** a toolbar button appears when a background tab uses more than 1 GB, or more than 70% CPU in two checks 30 seconds apart. Its popup has Fix now, Not now and Settings, and works with the keyboard.
- **Preload pages:** Standard or No preloading. It connects ahead to the address bar's highlighted suggestion, never in incognito or Guest.
- **Energy Saver:** turns on at 20% battery or lower, or whenever unplugged. It slows background tabs (except a tab a helper AI is working in), pauses preloading, adds an `energy-saver` class that the theme reads to stop animations, and shows a leaf button.

**Risks and things left undone**
- **Merges:** `main/main.js` changed a lot, because every handler now uses the window's own profile. Expect conflicts in `clearData`, `page:settings`, `page:set-setting` and the startup block.
- **AI projects:** the AI panel now actually receives chat projects. They were silently missing before, so project instructions will start applying.
- **First profile:** it can't be deleted, because it holds the app-wide settings.
- **Scheduled tasks:** they only run for profiles opened since launch.
- **Energy Saver on tabs:** background tabs are already throttled by default, so the real savings come from turning off animations and pausing preloading.
- **Not built:** preloading when hovering new-tab-page shortcuts, and per-profile Windows desktop shortcuts.
- **Sync:** I added the new Memory Saver mode to the synced settings so it travels like the old setting did.

**Files**
- Changed: `main/main.js`, `main/window.js`, `main/tabs.js`, `main/extensions.js`, `main/password-manager.js`, `main/menu.js`, `main/protocol.js`, `main/sync/adapters.js`, `preload/shell.js`, `renderer/assets/theme.css`, `renderer/pages/settings.html`, `renderer/pages/settings.js`, `renderer/ui/icons.js`, `renderer/ui/overlay.css`, `renderer/ui/overlay.js`, `renderer/ui/shell.css`, `renderer/ui/shell.js`
- New, main process: `main/profiles.js`, `main/picker.js`, `main/perf.js`, `main/task-manager.js`
- New, profile picker: `renderer/ui/picker.html`, `renderer/ui/picker.css`, `renderer/ui/picker.js`
- New, Task Manager: `renderer/ui/taskmanager.html`, `renderer/ui/taskmanager.css`, `renderer/ui/taskmanager.js`
- New, toolbar and popups: `renderer/ui/perf.js`, `renderer/ui/perf.css`, `renderer/ui/overlay-perf.js`, `renderer/ui/overlay-perf.css`
- New, Settings: `renderer/pages/settings-perf.js`, `renderer/pages/settings-perf.css`, `renderer/pages/settings-profiles.js`

**Tests added**
- `tests/profiles.test.mjs`: 8 tests
- `tests/perf.test.mjs`: 9 tests
- `tests/platform-ui.test.mjs`: 9 headless-Chrome tests covering the picker, Task Manager, window title and toolbar buttons, account menu, performance popup and Settings › Performance, in light and dark
- `tests/e2e/profiles.e2e.mjs`: 9 tests, not run here

All paths are under `/Users/juan/Developer/lumio-browser-b7a`.

## print-settings-i18n — INTERRUPTED by a usage limit (run wf_6030456a-699); its partial edits are in the working tree. Its last notes:

Now the Settings additions. First the Languages section module.
Let me do a quick smoke check of the new Settings sections and print page in headless Chrome before writing the translation table.
The print preview renders correctly. Now the biggest piece: the Spanish table. Let me gather the full candidate list including the new files.
You've hit your session limit · resets 4:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_6030456a-699); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_6030456a-699); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## print-settings-i18n — INTERRUPTED by a usage limit (run wf_9a6c10a5-15c); its partial edits are in the working tree. Its last notes:

Now I'll write the Spanish table. First, the shell, panel and common strings.
You've hit your session limit · resets 9:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_9a6c10a5-15c); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_9a6c10a5-15c); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)
