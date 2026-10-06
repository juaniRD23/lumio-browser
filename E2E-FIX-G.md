# E2E fixes — fixer G (run 37412372516, `v0.6.8-next`)

There was no Mac to test on. The causes below come from the run 4 log and its diagnostics, a comparison with run 3, the product code, `electron-chrome-extensions`, and Electron and Chromium sources.

`npm test`: 905 of 912 pass. The one failure was "the media popover" in tests/page-tools-ui.test.mjs, which passed twice when its file was run alone; fixer E also saw it fail on the unchanged branch. An earlier full run also had failures in the credits and full-screen bubble UI tests. Those files pass on their own here, on both this branch and `v0.6.8-next`.

Each file starts its own app with a fresh profile (scripts/launch.mjs), and `tabs.e2e.mjs` runs after all the files involved here. So its leftovers can't explain the four new failures. The cascades found were all within a single file.

| Test | Cause | Fix | Confidence |
|---|---|---|---|
| browser:125 new windows / session | Test race: on a Mac the first window's late focus event made it current again, so `/two` replaced `/one` | Drive the new window by id, wait for the session, clean up in `finally` | medium-high |
| browser:146 pinned tabs | Cascade: the test above left its second window open; `sessionWindows()[0]` was the other window | Read the window it pinned in, wait for the save, unpin in `finally` | high |
| omnibox:98 switch to tab | Regression from fixer E's `page-focus`: the window comes to the front after `focusBar` and hands the keyboard back to the page, which blurs the bar and hides the suggestions | `focusBar` waits for the window and then its UI to have the keyboard; `finally` closes windows | medium-high |
| platform:54 print preview | Test race: Cancel closes the preview's page while `executeJavaScript` is waiting for an answer, so the call hangs and hits the 30 s timeout | Clicks run after the script answers; `inPrint` resolves to null if the page closes | high |
| lifecycle:125 notice goes by itself | Product: after Esc on a Mac the page stayed in full screen inside the normal window; the next request got no window change and no notice | The page leaves full screen once the window is out; test 1 checks it | medium-high |
| popups:439 window management | Test out of date: Chromium asks for window management only with transient activation | The request comes from a real click; the sound check runs first | high |
| extensions:183 commands from the menu bar | Product: worker events went through the library's router, which tries once with no retry and may hit the previous load's worker | Lumio always delivers worker events, with retry, to the newest worker | medium |

## 1. New windows and the session (tests/e2e/browser.e2e.mjs)
- **Cause:** `go()` navigates `global.lumio.tabs`, which is the last-focused window. `createWindow` makes the new window current. On the Mac, though, the first window's own OS `focus` event can arrive later; for example, `navigate()` calls `webContents.focus()`, which focuses the owner window. When that happens, the first window becomes current again, `/two` loads in it over `/one`, and the session holds `[[/two], [new tab]]`. The new window only came to the front later. That fits the cascade below, where the pinned tab went into the second window. Run 3 passed by timing.
- **Fix (test):**
  - The new window is driven by its id: navigate it, wait for its title, then close it.
  - The session is awaited with `until()` instead of a fixed 600 ms wait.
  - The test asserts that the first window is the one that stays.
  - A `finally` closes every window but the first.
  - On a timeout the test prints the windows, the current window and the saved session.
- **Files:** tests/e2e/browser.e2e.mjs.

## 2. Pinned tabs (browser.e2e.mjs): cascade
- **Cause:** test 1 failed before closing its second window. The pin then went into the current window (the second), while `sessionWindows()[0]` is the first.
- **Fix (test):**
  - The test reads the saved window that has `/pin-me` and requires it to be first and pinned. That is the same check as before, now aimed at the right window.
  - It waits for the save instead of sleeping.
  - It unpins in a `finally`.

## 3. Switch to a tab in another window (tests/e2e/omnibox.e2e.mjs): regression from fixer E
- **Cause:**
  - The test calls `windows[0].focus()`, and `focusBar` then immediately focuses the shell and the field.
  - On a Mac the window comes to the front a moment later and gives the keyboard back to the view that last had it, here the page.
  - Since fixer E, the page's `focus` event sends `page-focus`, and the shell blurs the address bar. That hides the suggestion dropdown 160 ms later, so the rows stay empty.
  - Before fixer E the field kept a stale focus, which hid this race.
- **Product:** unchanged. When the page really has the keyboard, the bar shouldn't look focused (Chrome behaves the same way).
- **Fix (test):**
  - `focusBar` waits for `win.isFocused()`, then focuses the window's UI and waits for `webContents.isFocused()`, and only then focuses the field. It applies to every test that uses `focusBar`.
  - A diagnostic `focusState()` is printed on a timeout.
  - A `finally` closes the extra windows.

## 4. Print preview (tests/e2e/platform.e2e.mjs)
- **Cause:** the error was the 30 s `L.main` timeout around `inPrint`, about 3.8 s after the start, i.e. at the last step. `inPrint('…cancel.click(); true')` makes the page send `print:close` synchronously. Main closes the preview's webContents, sometimes before the script's answer comes back. Electron's `executeJavaScript` never settles for a page that closed, so the call hung until the timeout. Run 3 won the race.
- **Fix (test):**
  - The Cancel and Save clicks run in a `setTimeout`, after the script has answered.
  - `inPrint` races the call against the page's `destroyed` event.
- **Files:** tests/e2e/platform.e2e.mjs.

## 5. The full-screen notice goes by itself (tests/e2e/lifecycle.e2e.mjs): product
- **Cause:**
  - Run 4's diagnostic: `{"window":false,"tab":null,"notice":null,"page":true}`. The window was out of full screen, yet the page still had `document.fullscreenElement`.
  - While a Mac window animates out of full screen, Electron's `IsFullscreenForTabOrPending()` is still true, so the renderer is told it is still full screen. Nothing corrects that afterwards.
  - The page's next `requestFullscreen()` then resolves inside the renderer. There is no `enter-html-full-screen`, so no notice.
  - Runs 1 and 2 passed only because the test before this one failed before pressing Esc. Fixer E's wait for the animation could not help.
- **Fix (product):** in main/tabs.js `leave-html-full-screen`, once the window has left full screen (`leave-full-screen`, and again 1 s later), a page that still has `document.fullscreenElement` calls `exitFullscreen()`. It is skipped if the tab went full screen again in the meantime.
- **Fix (test):** the Esc test now also asserts that the page left full screen, so this can't hide behind a later test again.
- **Confidence:** medium-high. If it fails, the new assertion will point at it directly.
- **Unit test:** tests/lifecycle.test.mjs checks that the page is let out only after the window's `leave-full-screen`, with a gesture.
- **Files:** main/tabs.js, tests/e2e/lifecycle.e2e.mjs, tests/lifecycle.test.mjs.

## 6. Window management (tests/e2e/popups.e2e.mjs): test out of date
- **Cause:**
  - In Chromium 150 (Electron 43), `getScreenDetails()` calls `RequestPermission` only with transient user activation. Without it, it does a quiet `HasPermission`, which goes to the check handler. That answers false because the setting is "ask", so the call rejects.
  - `L.page()` runs scripts without a gesture, so Lumio's request handler was never called and the chip stayed empty (`chip: null` in run 4).
  - Notifications don't need activation, which is why those bubbles worked.
- **Fix (test):**
  - The sound check (autoplay needs a click) runs first. The click leaves sticky activation, which would spoil it if it came second.
  - Then a `/screens` page calls `getScreenDetails()` from a real click.
  - The bubble must still open by itself. The page must still be waiting for an answer, then get `NotAllowedError` after Block.
  - The setting is reset in a `finally`.
  - On a timeout the test prints the page's activation, permission status and Lumio's setting.
- **Files:** tests/e2e/popups.e2e.mjs.

## 7. Extension keyboard shortcuts (tests/e2e/extensions.e2e.mjs): product
- **Cause:**
  - Fixer F's retry only ran when the router didn't know the listener. The run 4 diagnostic shows the router knew it again (`commands.onCommand: ["service-worker"]`), so the event went to `router.sendEvent`.
  - `router.sendEvent` calls `startWorkerForScope` once and only `console.error`s a failure. That line was outside the test's log filter (hence "0 of 0 lines").
  - After the site-access reloads, two `sw.js` workers ran for the scope. The event may also have gone to the previous load's worker.
  - The alarms test passing says nothing about this: its alarm fires during `before()`, before any reload.
- **Fix (product, main/extension-shims.js):**
  - An extension with a service worker always gets its events from Lumio, with the 10 s retry, sent to the newest running worker for its scope (highest version id). Its listening pages still get the event directly.
  - Under `LUMIO_TEST`, each delivery logs `[lumio] <event> -> <id> worker vN (started vM)`.
- **Test:**
  - Waits 15 s, past the retry deadline, so a final warning shows up.
  - Lists running workers with version and pid.
  - The log filter keeps the library's errors.
  - The unit test in tests/extension-access.test.mjs follows the new delivery.
- **Confidence:** medium. If it still fails, the new log lines show which worker got the event. If the newest worker got it and still no tab opened, the next step is an acknowledgement from preload/extension-shims.js.
- **Files:** main/extension-shims.js, tests/e2e/extensions.e2e.mjs, tests/extension-access.test.mjs.
