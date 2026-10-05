# Batch 7d (layout and power-user): result

Branch: `batch7d-layout`. Nothing was run in Electron and the e2e tests weren't run (they run on CI).

## Items
- **Vertical tabs and split view: done.** An earlier agent finished these (see EARLIER.md). This run fixed one failing headless test. After you collapsed the column under the pointer, the flyout opened without you moving the pointer, because the shrinking column makes Chromium re-send pointer events. Now the flyout opens only after the pointer really moves (`renderer/ui/vertical-tabs.js`).
- **1. power-user: done.** The interrupted agents had finished nearly all of it. This run checked it and finished the rest.
  - **Name window: done.** It's in Window › Name Window… and in the strip's right-click menu. It becomes the window's title, so the macOS Window menu and the Dock show it. It's saved in the session and in the reopen-window list (`main/window-name.js`, `renderer/ui/name-window.js`).
  - **Keyboard shortcuts: done.** `lumio://settings/shortcuts` lists every menu command that has a shortcut or an id. You can record new keys, reset one command, or reset all. If the keys belong to another command, it asks before taking them over; menu roles like Copy and Quit and system keys are refused. The choices are stored in `settings.shortcuts` and applied to the menu at startup and right away when changed, to the ⋮ menu too. Tooltips show the new keys (`main/shortcuts.js`, `renderer/ui/shortcut-hints.js`).
  - **Caret browsing: done, built differently from the task.** F7 or View › Caret Browsing turns it on, asking the first time, and Settings › Keyboard has a switch. The task said to use an isolated-world script. Electron 43 has Chromium's own caret browsing (`webContents.setCaretBrowsingEnabled`), the same one Chrome's F7 uses, so Lumio uses that instead: it's more reliable and screen readers follow it (`main/caret-browsing.js`).
  - **Middle-click autoscroll: skipped.** It's Windows-only in Chrome, as the task said.
  - **Force dark mode for web contents: done.** It's under Settings › Appearance, marked Experimental, with a Relaunch button until the change takes effect.
    - At startup Lumio adds `--blink-settings=forceDarkModeEnabled=true`, the setting Chrome's flag ends in. Chrome's own code is what reads the `WebContentsForceDark` feature, and that code isn't in Electron, so the feature alone wouldn't do anything.
    - This run also adds `--enable-features=WebContentsForceDark`, as the task asked. It's harmless.
    - A headless test confirms in Chromium that the Blink switch darkens pages.
    - While force dark is on, Lumio itself is dark and the Theme choice is disabled, because the switch would also darken Lumio's own pages.
    - Relaunch reopens your windows (`main/force-dark.js`).
  - **Protocol handlers: done.** Electron 43 ignores `navigator.registerProtocolHandler`.
    - A main-world shim in `preload/internal.js` (tab top frames only) runs the same checks Chrome does and sends the request to main, which checks again using the real origin.
    - The permission bar asks "<site> wants to open all email links"; Allow or Block is remembered.
    - Matching links go to the site's handler URL in a new tab next to the current one. Links Lumio opens itself, like bookmarks or the address bar, also go there.
    - Settings › Privacy and security › Protocol handlers lists both allowed and blocked sites, each with Remove.
    - **Limits** (also written at the top of `main/protocol-handlers.js`):
      - Only top frames can register.
      - Incognito uses saved handlers but can't add one.
      - Each scheme has one handler.
      - Only schemes on the HTML spec's safe list and `web+` schemes are allowed.
      - Only links opened inside Lumio are routed, because Lumio isn't the computer's mail app.
      - A page's own links are routed only within 5 seconds after a click or key press in it (a review fix).
- **2. Tests: done.** Every feature has unit or headless tests (`tests/power-user.test.mjs`, `tests/shortcuts.test.mjs`, `tests/split-view.test.mjs`, `tests/tab-layout.test.mjs`) and e2e tests.
- **3. Review: done.** A fresh subagent did it; findings are below. Screenshots in light and dark are in `dist/review-shots/`, which isn't committed.

## Review findings
| Sev | Feature | Finding | Fixed |
|---|---|---|---|
| medium | protocol handlers | A page script or an ad iframe could open a handler tab every second without you doing anything. Now it needs a click or key press in the last 5 s, and each press opens one tab. | yes |
| low | protocol handlers | A page a helper AI was browsing could ask to become a handler. Those tabs are now refused. | yes |
| low | vertical tabs | Settings' "Show tabs to the side" switch went stale after changing it from the right-click menu. It now refreshes when Settings gets focus. | yes |
| low | vertical tabs | The collapsed column's flyout opened after collapsing even though the pointer didn't move. This was the failing test above. | yes |
| low | vertical tabs | Backspace on a focused tab row closes the tab. This was kept on purpose and only applies inside the list. | no |
| low | force dark | If a page's "Leave this page?" prompt cancels the quit after Relaunch, Lumio still restarts at the next quit. This is rare. | no |
| low | protocol handlers | A background tab can ask, the same as existing permissions do. The bar names the site. | no |
| low | vertical tabs | The page resizes when the column's width animation ends, not during it. Cosmetic only. | no |

The review found no high-severity problems. Checked and OK:
- IPC origin checks.
- Text escaping in the Settings and shortcuts lists.
- Session restore of the layout, name and splits.
- Incognito.
- Memory Saver with split view.
- Timers and leaks.
- Keyboard and aria labels.
- Theme tokens in light and dark.

## npm test
- **Root:** 217 tests, 212 pass, 0 fail, 5 skipped (Windows-only and Mac-only tests).
- **Before this run:** 211 pass, 1 fail.
- **server/:** 38 tests, 38 pass (no server changes).

## e2e tests (tests/e2e, not run here)
- `layout.e2e.mjs`:
  - tabs to the side: the column replaces the strip…
  - tabs to the side: the collapsed column's flyout closes…
  - split view: two pages side by side…
  - split view: closing one side leaves the other…
- `power-user.e2e.mjs`:
  - Name window…
  - Keyboard shortcuts…
  - Caret browsing…
  - Force dark: the switch waits for a relaunch…
  - Force dark: started with it on…
  - Protocol handlers… (updated in the review to click with real input, and to check that a script's `click()` opens no tab)

## Risky
- None of this has run in Electron. Some things are unverified until CI runs the e2e tests:
  - focus and pointer behavior in split view and the flyout;
  - `input-event` types used for the click-or-key-press check;
  - the Blink switch in a packaged build.
- Force dark changes Chromium startup switches, which affects every page, including Lumio's.

## Merge hints
Shared files changed (keep both sides when merging):
- `main/main.js`: IPC channels, cmd entries, the strip context menu, the session `layout`/`name` fields, `powerUser.setup`, and `snapshot()`, which now pastes both split sides.
- `main/tabs.js`: about 60 lines for split and layout.
- `main/window.js`.
- `main/menu.js`: `buildMenu` now uses `menuTemplate()` and `shortcuts.apply`; new Window and View items.
- `main/store.js`: `verticalTabs`.
- `main/theme.js`.
- `main/protocol.js`.
- `preload/shell.js`: events.
- `preload/internal.js`: the protocol-handler shim.
- `renderer/ui/shell.js`:
  - imports and init;
  - two hooks in `startTabDrag`, which the animations and navigation batches likely also touch;
  - split state;
  - the strip's right-click menu.
- `renderer/ui/shell.html` and `renderer/ui/overlay.js`: imports.
- `renderer/pages/settings.html`, `settings.js` and `settings.css`: a new Keyboard section, rows under Appearance, and the Protocol handlers card.
- README and docs weren't updated, to avoid conflicts.
