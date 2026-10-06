# E2E fixer B: navigation and tabs (batch 4), tab groups (batch 5), profiles and platform (batch 7a)

Branch `e2e-fix-b`, from `merge-v0.6.8` at e038778. The failures are the ones from Mac CI run 37401840855 at bf72189.
It merges cleanly with the newer `merge-v0.6.8` head (0f9f5d3, "MERGE DONE"). On that merged result, all five of
my e2e files pass on Linux (navigation 10/10, organize 6/6, profiles 9/9, tabs 11/11). Platform passes except the
Linux-only test noted under failure 6.

## How this was checked

The task assumed the app couldn't run here. It can: I downloaded the Electron 43.7.7 Linux binary (its sha256 matches
`node_modules/electron/checksums.json`) and ran the real app under Xvfb (`ELECTRON_DISABLE_SANDBOX=1 xvfb-run …
node --test tests/e2e/<file>`). Six of the nine failures reproduced on Linux exactly as on the Mac, and every fix
was confirmed there:

- the bubble fix was also confirmed in reverse: without it, the Mac's "moved to the right" failure came back
- the files before and after the fixes:

| file | before (Linux) | after (Linux) |
|---|---|---|
| tests/e2e/navigation.e2e.mjs | 8/10 (the two below) | 10/10, also with `LUMIO_SHOTS` set |
| tests/e2e/organize.e2e.mjs | 4/6 | 6/6 |
| tests/e2e/profiles.e2e.mjs | 8/9 | 9/9 |
| tests/e2e/platform.e2e.mjs | my test passes | my test passes (see below) |
| tests/e2e/tabs.e2e.mjs | 10/11, plus a flaky test | 11/11 four runs in a row (1 Mac-only skip) |

Linux is not the Mac. The Mac-only parts (two-finger swipe, ⌘ keys, the Dock) were checked by reading the code,
and for the menu keys by building the Mac menu template headlessly with `process.platform = 'darwin'`.

`npm test` passes (899 pass, 0 fail, 6 skipped, server tests included). Some runs had one or two failures, each time
in a different headless-Chrome UI test (popovers-ui, page-tools-ui, print). Each of those files passes when run
on its own, and none of them loads the code changed here. The unchanged base flakes the same way: 1 and 2 such
failures in two runs (popovers-ui, hud).

## The failures

### 1. navigation.e2e.mjs:86 — hovering a link: "moved to the right"
- **Category:** 1 (product bug)
- **Root cause:** `PageHud.onSize()` runs each time the bubble's text changes size. It re-checked the pointer with
  `screen.getCursorScreenPoint()`, which overrode the side the page's own mouse event (`before-mouse-event`) had
  just picked. Pointing at the corner link moved the bubble right, then the new address resized it and it went back
  left. In real use this can happen with a stale cursor. On CI the real cursor is nowhere near the page, so it
  always happened.
- **Fix:** the hud remembers the last mouse-move position from the page it is watching and uses it in
  `pointer()`. The screen cursor is only a fallback before any event has arrived, and the memory is cleared when
  the watched page changes.
- **Unit test:** `tests/navigation.test.mjs` "the status bubble moves to the other corner … and stays there as it
  resizes". It fails without the fix.
- **Confidence: high.** The Linux run failed with exactly the Mac error ("moved to the right") without the fix, and
  passed 3 out of 3 runs with it.
- **Files:** `main/page-hud.js`, `tests/navigation.test.mjs`

### 2. navigation.e2e.mjs:114 — middle-click on Forward: the copy tab is `undefined`
- **Category:** 1 (product bug)
- **Root cause:** the copy did open, with the right history, but it became the active tab. The test then looked
  one tab past it. `electron-chrome-extensions` treats every tab it starts tracking as the active one
  (`observeTab` calls `onActivated`), then calls Lumio's `selectTab` hook, which activates the tab and focuses
  its window. Normal background tabs escape this by accident: `create()` makes their view before the tab is in
  the strip, so the hook can't find them. A tab made lazily and given its view afterwards gets pulled to the
  front. That covers `openEntry` (middle-click Back/Forward/Reload, history-menu items in a new tab) and
  `rebuild()` (a background tab remade after a site-setting change).
- **Fix:** `ExtensionManager.addTab()` ignores the library's select request for the tab it is adding. Then
  `onViewCreated` (main.js) tells the library which tab is really shown, but only when the new tab is already in
  the strip and isn't the active one.
- **Confidence: high.** Reproduced on Linux with the same `undefined`. A stack trace showed the activation coming
  from `observeTab`. The test passes with the fix.
- **Files:** `main/extensions.js`, `main/main.js`

### 3. navigation.e2e.mjs:143 — mouse back button / swipe: `UnknownVizError`
- **Category:** 4 (timing on CI), in the screenshot helper rather than in what the test checks
- **Root cause:** the failure came from `L.shot()` → `global.lumio.snapshot()`, right after the swipe arrow's view
  was first made and shown. On macOS, `capturePage()` on a view with no frame yet rejects with `UnknownVizError`,
  and that failed the whole test. Everything before the screenshot (mouse back went back once, the arrow showed)
  had passed.
- **Fix:** `snapshot()` (test-only, main.js) tries each view over the window again for up to about 1 s. If the
  view still has nothing drawn, it is left out of the picture instead of failing the test. Capturing the window
  itself still throws as before.
- **Confidence: medium.** Not reproducible on Linux (the swipe part is Mac-only, and capturing there succeeds at
  once). The fix covers both how this error happens (no frame yet: retry; never drawn: skip). The rest of the
  swipe test (swipe forward, arrow hides) never ran on CI; it reads correctly against `Navigation.onSwipe` and
  `PageHud.swipe`.
- **Files:** `main/main.js`

### 4. navigation.e2e.mjs:165 — shortcuts: `'View Page Source'` was `undefined`
- **Category:** 2 (test out of date). The merge session already fixed it at cfbdf27 ("e2e follows the merge"),
  after the CI run.
- **Root cause:** batch 7c's View › Developer menu (main/menu-extras.js) replaced batch 4's item, and the label is
  now "View Source". "Bookmark All Tabs" is now "Bookmark All Tabs…", and Delete Browsing Data is now batch 6's
  settings page.
- **Fix:** none needed on this branch. I checked that every Mac key the test expects (View Source ⌘⌥U, JavaScript
  Console ⌘⌥J, Downloads ⌘⌥L, Ask Lumio ⌘J, Report an Issue… ⌥⇧I, Home ⌘⇧H, Stop ⌘.) is what the Mac menu
  template really has, by building it with `process.platform = 'darwin'`. The test passes on Linux.
- **Confidence: high.**
- **Files:** none

### 5. organize.e2e.mjs:103 — a tab opened from a grouped tab: still 2 tabs
- **Category:** 2 (test out of date after another batch), plus 3 (no cleanup)
- **Root cause:** the test clicked a `target=_blank` link from `executeJavaScript`, which has no user gesture.
  Batch 2's pop-up blocker (merged before batch 5) only lets a page open a tab right after the person clicks or
  types, so it blocked the tab, as it should. The product behavior being tested (a tab opened from a grouped tab
  joins the group) works.
- **Fix:** the test clicks the link with real `sendInputEvent` mouse events, the same way popups.e2e.mjs does. The
  window is reset in a `finally` block. Without it, the leftover tabs also made the next test, "saved groups",
  fail on Linux.
- **Confidence: high.** Reproduced on Linux; the file now passes 6/6.
- **Files:** `tests/e2e/organize.e2e.mjs`

### 6. platform.e2e.mjs:106 — Reset settings: `store.addBookmarkAt is not a function`
- **Category:** 2. The merge session already fixed it at cfbdf27 (`store.marks.add` / `store.marks.removeUrl`,
  batch 5's bookmarks tree).
- **Fix:** none needed. The test passes on Linux at this head and checks the same behavior: Reset puts the search
  engine back and keeps the bookmark.
- **Confidence: high.**
- **Files:** none
- **Not in my group:** the next test in the file, "Settings in the real app has the search box…", fails on Linux
  both before and after these changes, and passed on the Mac. It looks Linux-only.

### 7. profiles.e2e.mjs:56 — a new profile: ENOENT `bookmarks.json`
- **Category:** 2. The merge session already fixed it at cfbdf27: since batch 5, bookmarks are saved as a tree in
  `bookmark-tree.json`, and the test now reads that profile's own store.
- **Fix:** none needed. It passes on Linux.
- **Confidence: high.**
- **Files:** none

### 8. profiles.e2e.mjs:166 — Memory Saver: `[false, false]`, expected `[false, true]`
- **Category:** 1 (product bug), plus 3 (no cleanup)
- **Root cause:** `TabManager.discard()` refuses any tab whose `webContents.isBeingCaptured()` is true. Chromium
  counts DevTools' focus emulation as a capture, and Playwright (the e2e driver) turns it on for every page, so
  under the driver every tab reports being captured and none can sleep. Measured: inside Lumio under the driver,
  every webContents (even a plain new view) reports `true`; in bare Electron without the driver, `false`. The
  check also missed what it was meant for: a background tab using the camera or microphone isn't "captured", so
  it could be put to sleep in the middle of a call.
- **Fix:** `discard()` now asks Lumio's own capture tracker (`hooks.captureOf`, main/capture.js). That covers the
  camera, microphone and screen dots, and a tab shared to another page. The e2e test puts Memory Saver's mode,
  its site list and the battery back, and closes its tabs, in `t.after()` even when a check fails.
- **Unit test:** `tests/split-view.test.mjs` "Memory Saver: a tab using the camera or shared to another page stays
  awake; isBeingCaptured() alone doesn't".
- **Confidence: high.** Reproduced on Linux with the same `[false, false]`; the file now passes 9/9.
- **Files:** `main/tabs.js`, `tests/split-view.test.mjs`, `tests/e2e/profiles.e2e.mjs`

### 9. tabs.e2e.mjs:192 — many tabs: "the tab you're on is in view"
- **Category:** 4 (timing)
- **Root cause:** the test read the strip as soon as it had the `scrolls` class. The strip brings the active tab
  into view with a smooth scroll that starts a moment later (`reveal()` and `settled()` in
  renderer/ui/tabstrip.js), so the test saw it mid-scroll. On the unchanged base under Linux it failed 3 runs out
  of 4.
- **Fix:** `until()` waits until the active tab is in view, + is visible and the start fades, then each condition
  is still asserted with its own message. Nothing checked was weakened.
- **Also in this file:**
  - "several tabs at once" was flaky (it failed 1 or 2 times in 5, also on the base). The tabs `reset()` closed
    can still be folding away (`.closing`) in the strip, so the Shift-click could land on one of them. It now
    waits for the five live tabs and ignores closing ones.
  - The `[lumio] unhandled rejection … reading 'isDestroyed'` at tabs.js `fallback` (also in the CI log) is fixed:
    a tab restored with its history and closed before it loaded has no `view.webContents` any more.
- **Confidence: high.** Reproduced; the file passed 4 runs in a row.
- **Files:** `tests/e2e/tabs.e2e.mjs`, `main/tabs.js`

## All files changed
- `main/page-hud.js` — the bubble keeps away from the page's last pointer
- `main/extensions.js`, `main/main.js` (onViewCreated) — a background tab stays in the background
- `main/main.js` (snapshot) — test screenshots wait for views that haven't drawn yet
- `main/tabs.js` — Memory Saver uses Lumio's capture indicators; restore fallback guard
- `tests/navigation.test.mjs`, `tests/split-view.test.mjs` — new unit tests
- `tests/e2e/organize.e2e.mjs`, `tests/e2e/profiles.e2e.mjs`, `tests/e2e/tabs.e2e.mjs` — test updates and cleanup
