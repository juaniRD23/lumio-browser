# E2E fix I: run 5 (37415173182)

Nine failures, five causes. `npm test`: 918 pass, 0 fail. I couldn't run Electron here, so each cause below comes from run 5's diagnostics, the product code and the Electron/Chromium behaviour behind it. Where a cause can't be proven without a Mac, the test prints what it needs on timeout.

## 1. DRM: the four "waiting window shows" checks (drm.e2e.mjs:53, 69, 83, 96)

**Cause.** No waiting window was visible within 4–5 s of launch. The DRM wait doesn't come after the extensions wait. `drm.setup()` starts it at app-ready, alongside the extensions, and `startProfile` awaits both, so the total is the longer of the two, not their sum. The product order is right. The trouble was that the window was only *created* at the one-second mark. A first window's page process on a slow CI Mac can take seconds to start, so `ready-to-show` came late. With the first test's 4 s download, the wait could end before the window was ready, and then the window correctly never shows. A second problem made it worse: each failing test skipped `L.close()`, which came after its asserts. So every later DRM test started next to one or more leftover Lumios (some on a 60 s wait), on an already slow machine.

**Fix.**
- `main/drm.js`: the window is created hidden at 300 ms. It is shown at 1 s, or as soon as its page has loaded after that, and never once the wait is over. A Widevine that's already installed (every launch after the first) is ready well before 300 ms, so no window is made.
- `main/drm.js` also keeps a timeline of the wait: started, window made, ready, shown, done. `main/main.js` adds `drm.mark()` for "extensions ready" and "opening its windows", and `global.lumio.drmTimeline()` exposes it.
- `tests/e2e/drm.e2e.mjs`:
  - The first test uses a 9 s download, so the window is sure to get its turn. It still checks that the window is visible before the browser's window exists, then that Settings says it's ready.
  - The window gets 8 s to show. If it doesn't, the test prints the timeline and every window.
  - Every test closes its app in `finally`.
- Unit tests cover the preload, the timeline, and a slow-loading window that shows late or not at all.

**Confidence.** Medium–high. The leftover apps and the 4 s edge are certain. If the window is still late, the printed timeline will show which step was slow.

**Files.** main/drm.js, main/main.js, tests/drm.test.mjs, tests/e2e/drm.e2e.mjs

## 2. chrome.alarms (extensions.e2e.mjs:217)

**Cause.** The diagnostics show Lumio's alarm went off and reached the worker (`lumio.alarms.onAlarm -> … worker v0`). The alarm list was empty afterwards, and later workers (v2, v3) didn't set the alarm again, which they would have if `rang` hadn't been stored. So the listener ran and called `chrome.tabs.create`, yet the current window had no alarm tab.

The extension's worker starts during `extensions.init()`, before `startProfile` opens any window, and the test's alarm goes off 1.5 s later. On a slow Mac no browser window existed yet. The `createTab` hook then fell back to `createWindow({ profile })`, which made a separate window just for the alarm tab, and `startProfile` opened the real window beside it. That second window is the one `lumio.tabs` (and the person) looks at. In real use, this means an extension that opens a tab at startup gets a stray extra window.

**Fix.**
- `main/main.js`: while a profile's windows are being opened, `p.opening` is pending. An extension's `tabs.create` during that time waits for those windows (20 s at most) and puts the tab there. The library already awaits `createTab`.
- `main/extension-shims.js`: `sidePanel.open` handles `createTab` being async.
- The e2e diagnostics now list every window's tabs.

**Confidence.** Medium–high. Every observation in the log fits this, and nothing else explains a listener that ran but left no tab. If it still fails, the diagnostics will show the tab in another window or nowhere.

**Files.** main/main.js, main/extension-shims.js, tests/e2e/extensions.e2e.mjs

## 3. Full screen: "the page left full screen too" (lifecycle.e2e.mjs:103), and "the notice goes by itself" (:128), which fails because of it

**Cause.** The second test's diagnostics show `{"window":false,"tab":null,"notice":null,"page":true}`: the window and Lumio were out of full screen, but the page still had `document.fullscreenElement`. Fixer G's `document.exitFullscreen()` didn't help, for this reason:

1. A page learns whether it's in full screen from its view's visual properties, which Chromium sends on a resize.
2. During the Mac's exit animation, Electron's `IsFullscreenForTabOrPending` still answers "full screen" (it's an HTML transition). Every resize of the window happens during that animation.
3. After the animation, Electron re-sends visual properties only for a window's *own* webContents (`BrowserWindow::OnWindowLeaveFullScreen`), never for a tab's `WebContentsView`.
4. The page's own `exitFullscreen()` goes to Electron, which is already out, so nothing is sent and the promise waits forever.

A page stuck like this gets no new `enter-html-full-screen` on its next request, so no notice appears. That is the second failure.

**Fix.**
- `main/tabs.js`: once the window has left full screen (and again 1 s and 2.5 s later), a page that still says it's in full screen has its view made one pixel shorter and then put back. That resize makes Chromium send the visual properties again, now saying "not full screen". The `exitFullscreen()` call stays as a fallback. A page that has already left is left alone.
- Unit tests cover both cases.
- The e2e test prints the window, tab and view state if the page still doesn't leave.

**Confidence.** Medium–high. It matches the diagnostics and Electron's code path exactly, but only a Mac run can confirm it.

**Files.** main/tabs.js, tests/lifecycle.test.mjs, tests/e2e/lifecycle.e2e.mjs

## 4. "Switch to this tab" (omnibox.e2e.mjs:112)

**Cause.** Fixer G's waiting worked as designed, but on the wrong window. The diagnostics show `current: 2`, window 2 focused, and the dropdown open in window 2. Window 2 is the new window whose own active tab is "Page beta", and the current tab is never offered as a switch.

`createWindow` focuses a new window on its UI's `ready-to-show`. On CI's Mac that came after its *page* had loaded, which is what the test waited for, and so after the test had already brought window 1 forward. Window 2 then took the front, and `lumio.current`, back, and `focusBar` focused it.

**Fix (test).** The test waits until the new window is shown, then brings window 1 forward. It checks that window 1 is current and in front (printing the focus state if not) and asserts that typing happens there.

**Confidence.** High.

**Files.** tests/e2e/omnibox.e2e.mjs

## 5. "⌘⇧A opens tab search" (tabs.e2e.mjs:226)

**Cause.** The same race as in 4: the test creates a window, waits for its page, focuses the first window and opens tab search. The new window's late `ready-to-show` focus then took `lumio.current` back, so the check, which looks at `lumio.current`, never saw tab search in the first window. ⌘⇧A is still bound: "Search Tabs…" with `CmdOrCtrl+Shift+A`, unchanged by batch 7d, whose shortcuts change an accelerator only when the person picks a new one. No earlier test leaves focus behind: each test starts with `reset()`.

**Fix (test).** The test waits for the new window to show, brings the first window forward and checks that it's current. It checks that the menu item still has ⌘⇧A, looks for tab search in that window by id, and prints the windows' state if tab search doesn't open.

**Confidence.** High.

**Files.** tests/e2e/tabs.e2e.mjs
