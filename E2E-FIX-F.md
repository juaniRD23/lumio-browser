# E2E fix F: report

Fixer F's group: the extensions tests (commands from the menu bar, chrome.alarms), split view (layout) and the whole of `tabs.e2e.mjs`. The failures are from CI run 37407933475 (run 3) on `v0.6.8-int` at 39a5973.

Branch `e2e-fix-f` starts from `origin/v0.6.8-int`.

**How this was checked.** Electron 43's Linux binary does download here, so the e2e files run under Xvfb. That doesn't make this a Mac, and two differences mattered:

- **Window size.** CI's Mac has a 1024x768 display. Runs with `xvfb-run -s "-screen 0 1024x768x24"` copy that.
- **Service-worker preloads.** Playwright's Electron launcher adds `--no-sandbox` on Linux, and without the sandbox Electron runs no service-worker preloads. Extension workers then have no `chrome.commands` or Lumio stand-ins. To copy the Mac here, a temporary copy of the launcher used `chromiumSandbox: true` and the tests ran as an unprivileged user.

`scripts/launch.mjs` is unchanged.

`npm test`: 911 tests, 905 pass, 0 fail, 6 skipped. The headless UI tests need `/usr/bin/google-chrome`; without it, 272 of them are skipped.

| # | Test | Cause | Confidence |
|---|------|-------|------------|
| 1 | extensions.e2e.mjs:165 extension commands | product bug, set off by the earlier test (plus a second product bug right behind it) | medium-high |
| 2 | extensions.e2e.mjs:195 chrome.alarms | product bug | high |
| 3 | layout.e2e.mjs:107 split view | test didn't fit CI's screen | high |
| 4 | tabs.e2e.mjs (whole file) | Playwright rejections after the deliberate renderer crash; source not found | low (diagnostics added) |

## 1. Extension commands from the menu bar (extensions.e2e.mjs:165)
- **Cause:**
  - The site-access test before this one reloads the test extension. That drops the extension's listeners from electron-chrome-extensions' router.
  - For a moment after the reload, its service worker isn't registered again: `startWorkerForScope` fails with "Failed to start service worker." In a sandboxed run it failed at 0 ms and worked about 500 ms later.
  - Fixer C's fallback in `sendEvent` tried to start the worker only once, then logged `[lumio] couldn't send commands.onCommand …` and dropped the event. So `onCommand` never ran.
- **Fix:** `sendEvent` now retries every 250 ms, for up to 10 s, while the extension is still loaded (`sendEvent.retry`). Each try first checks again whether the router knows the listener, so the event is delivered only once.
- **Second bug behind it:** the menu bar kept the old shortcut (`Alt+Shift+O`) after the test changed it to `Alt+Shift+P`. `ExtensionsUI.menuKeys()` caches the list, and the manager's `commandsChanged` hook rebuilt the menu from that stale cache.
  - Fix: a new `ExtensionsUI.commandsChanged()` clears the cache and rebuilds the menu. `main/main.js` calls it from the hook.
  - That check also gained a message: "the menu bar has the new shortcut".
- **Confidence:** medium-high.
  - With the sandbox on, the failure reproduced exactly as on Mac. With the fix, the whole file passed 11/11 on three runs.
  - A Mac runner may take a different time to bring the worker back. The 10 s retry covers the whole wait in the test.
- **New diagnostics:** if the onCommand wait or the new-shortcut check times out, `extDiag()` prints a `[diag] …` line with:
  - whether there is no sandbox
  - whether the extension is loaded, its path and permissions
  - the running workers for its scope
  - the router's listeners for this extension
  - Lumio's stored alarms
  - every `ext-cmd:` menu item with its accelerator and whether it's enabled
  - the open tabs
  - the last 40 extension-related lines of the app's log

  If the worker still isn't reached, that log shows the `[lumio] couldn't send …` line after the 10 s of retries.
- **Files:** `main/extension-shims.js`, `main/extensions-ui.js`, `main/main.js`, `tests/extension-access.test.mjs` (new: a worker that fails twice and then starts gets the event once; one that never starts is warned about once), `tests/extensions-manager.test.mjs` (new: `commandsChanged()` picks up a changed shortcut), `tests/e2e/extensions.e2e.mjs`.

## 2. chrome.alarms wakes the extension (extensions.e2e.mjs:195)
- **Cause:**
  - Electron 43 has its own `chrome.alarms` in extension workers (`chrome.alarms.create` is native code).
  - `preload/extension-shims.js` added Lumio's stand-in only when `!chrome.alarms`, so it was never used.
  - Electron's alarm gets scheduled (`getAll` lists it), but `onAlarm` never fired, even after 79 s.
- **Fix:** Lumio's `chrome.alarms` now replaces Electron's whenever the extension has the `alarms` permission. The comment and `docs/extensions-support.md` say so.
- **Confidence:** high. Reproduced and fixed in sandboxed runs. The test passes alone and with the whole file.
- **New diagnostics:** the same `extDiag()` output when the alarm wait times out. It includes Lumio's stored alarms and whether the worker is running.
- **Files:** `preload/extension-shims.js`, `docs/extensions-support.md`, `tests/e2e/extensions.e2e.mjs`.

## 3. Split view: the left side narrowed (layout.e2e.mjs:107)
- **Cause:** the test assumed a bigger window than CI's. There is no product bug.
  - `defaultBounds()` makes the window `min(1480, workArea − 60)` wide. On CI's 1024x768 display that's 964px; run 3's screenshots are 964x634.
  - The AI panel is open by default, so the split's page area is about 560px.
  - Each side must stay at least 260px wide (`MIN_PANE`, `main/split-view.js`). So the narrowest the left side can go is 260/560 ≈ 0.464.
  - The test's `split-ratio 0.35` was therefore clamped, giving left 255px and right 295px. `l.width < r.width * 0.7` could never pass.
  - Fixer C's focus change fixed an earlier step. This is the next one.
- **Reproduced:** at 1024x768, the unchanged test fails at line 140, as on CI.
- **Fix:** for the divider part only, the test closes the AI panel with its own close button. It then waits up to 3 s for the page area to reach 745px, which a 35/65 split needs, and reopens the panel afterwards in a `finally`.
  - The 0.35 ratio, the width check, the swap result `{left, right, ratio: 0.65}` and the saved session pair are unchanged.
- **Confidence:** high. The whole of `layout.e2e.mjs` passes 5/5 at 1024x768 and at 1280x1024.
- **New diagnostics:** if it still doesn't narrow, one line, "split view diagnostics (the left side did not narrow)", shows:
  - whether the panel was open
  - before and after the ratio change: the window's content bounds, the page area, the split state and its ratio, the page rects, and both pages' bounds
  - from the window: the divider's x and width, the split box's width and `--ratio`, and whether the panel is closed
- **Files:** `tests/e2e/layout.e2e.mjs`.

## 4. tabs.e2e.mjs (the whole file)
- **What happened:** every test in the file passed, including the sad-tab test that crashes a renderer on purpose. Then node:test reported ten unhandled rejections, "Error: Target crashed", pinned on the `before` hook where the app is launched, and that failed the file.
- **What I found:**
  - The message "Target crashed" comes from only one place in playwright-core 1.63: its dispatcher, when a call from the client side hits a page session Playwright has marked crashed.
  - Playwright never clears that mark, even though Lumio loads its sad-tab page and then the old page back into the same WebContents (Playwright issue #27917). After the crash, the reloaded page keeps sending events to that crashed session; on Linux these included 10 `Network.requestWillBeSent`.
  - node:test pins the rejections on `before` because the promises were created from the Playwright connection set up there.
  - Runs 1 and 2 didn't have this, and the same test passed. Since then, `scripts/launch.mjs` gained `app.context().on('dialog', () => {})` (52414da). That is the only change on the Playwright side, so it's a suspect, but I found no path by which it would cause this.
- **Couldn't reproduce:** with Playwright patched to log every call on a crashed session, there were none and nothing was unhandled. I tried:
  - the whole file under Xvfb
  - at 1024x768
  - with `LUMIO_SHOTS` set
  - with a Dock-like download right before the crash
  - with `--renderer-process-limit=1`
  - with the sandbox on (as an unprivileged user)

  So whatever does it on the Mac doesn't happen here, and I didn't guess at a fix.
- **What changed:** diagnostics only (`tests/e2e/tabs.e2e.mjs`).
  - A `process.on('unhandledRejection')` listener prints each rejection's stack. That stack comes from Playwright's server, so it names the Playwright code that made the call. It also prints the test it happened during, from a `beforeEach`, and how many ms after the deliberate crash.
  - node:test still fails the file on such a rejection; I checked that an extra listener doesn't hide it.
- **What the next run will show:** lines like `[tabs e2e] unhandled rejection during or after "a crashed tab…" 840ms after the deliberate crash: Error: Target crashed … at CRSession.send … at <caller>`.
  - The `<caller>` frame says which Playwright path does it. Then the fix can be aimed: close the crashed page's Playwright target, move the crash into its own short-lived app, or scope the dialog listener.
  - If the time is during `after` (closing the app), the trigger is the app quitting rather than the crash.
- **Confidence:** low that this round fixes the file; high that the next run says where the rejections come from.
- **Files:** `tests/e2e/tabs.e2e.mjs`.

## Commits
- `7e93853` e2e split view: put the AI panel away before the 35/65 divider check on CI's small screen
- `b8bf9dc` e2e tabs: say where an unhandled rejection comes from, and when
- `956cf44` Extensions: commands wait for a reloading worker, Lumio's alarms replace Electron's, the menu shows new shortcuts

## Note for later
To make Linux e2e runs exercise extension service workers the way a Mac does, `scripts/launch.mjs` would need `chromiumSandbox: true`. That needs a non-root user, so I left it alone; it's shared with fixer E.
