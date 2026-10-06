# E2E fix C: report

Fixer C's group: passkeys, autofill, extensions and help (batch 7c); the ⋮ menu (batch 3); page tools (7b); split view, Name window and protocol handlers (7d); and the AI approvals test. Failures come from CI run 37401840855 at bf72189.

Branch `e2e-fix-c` starts from `merge-v0.6.8` at 0f9f5d3 ("MERGE DONE"). Some failures were already fixed on merge-v0.6.8 after the CI run, by cfbdf27 ("e2e follows the merge"). Those are marked below.

I couldn't run Electron or the e2e suite here (no Mac, no display). Every fix comes from reading the test code, the product code, git history and the CI log.

`npm test`: 906 tests, 899 pass, 6 skipped, 1 fail. The failure is "the media popover…" in `tests/page-tools-ui.test.mjs`, which none of these changes touch. That file passes 13/13 when run alone (tried twice), so it looks like a load flake.

Categories: 1 = product bug, 2 = test out of date after the merge, 3 = cascade from an earlier test, 4 = CI timing.

| # | Test | Cat. | Confidence |
|---|------|------|------------|
| 1 | account.e2e.mjs:94 passkeys | 4 | medium-high |
| 2 | app.e2e.mjs:266 deny / Auto mode | 2 | high |
| 3 | autofill.e2e.mjs:89 address save | 2 (+3 cleanup) | high |
| 4 | autofill.e2e.mjs:167 form entries | 2 (+3 cleanup) | high |
| 5 | browser.e2e.mjs:514 the ⋮ menu | 1 | high |
| 6 | extensions.e2e.mjs:165 extension commands | 1 (likely) | medium-low |
| 7 | extensions.e2e.mjs:189 chrome.alarms | 1 (likely) | medium-low |
| 8 | extensions.e2e.mjs:253 lumio://version, flags-lite | 2 (fixed upstream) | high |
| 9 | layout.e2e.mjs:107 split view focus | 1 | medium |
| 10 | page-tools.e2e.mjs:59 Translate bubble | 1 | medium |
| 11 | power-user.e2e.mjs:65 Name window | 2 (fixed upstream) | high |
| 12 | power-user.e2e.mjs:194 Protocol handlers | 2 (fixed upstream) | medium-high |

## 1. passkeys (account.e2e.mjs:94): category 4
- **Root cause:**
  - At bf72189, the `overlayKind` helper reported `'passkey'` as soon as main called `showOverlay`, before the overlay had drawn the card.
  - The test then read an empty `body.innerText`. This was the app's first overlay, so it was the slowest to appear.
  - cfbdf27 already changed `overlayKind` to wait until the overlay is shown.
- **Fix:** as a backstop, the "Save a passkey for localhost? … Sam Tester … sam@example.com" and "Sign in to localhost … Sam Tester" checks now wait with `until()` for the text to appear, then assert the same regular expressions.
- **Confidence:** medium-high.
  - Both the waits and the rendered text now match.
  - Remaining risk: if the overlay page hadn't loaded when the first `showOverlay` arrived, nothing sends it again. It has more than a second to load in this test.
- **Files:** `tests/e2e/account.e2e.mjs`

## 2. deny stops that action (app.e2e.mjs:266): category 2
- **Root cause:** batch 3 (motion) adds a `changed` class to a finished step, which plays the spinner-to-result animation (`renderer/ui/ai-panel.js`). The test compared the whole `className`, so it got `'step denied changed'`.
- **Fix:** the test drops `changed` from the step's classes and still asserts exactly `'step denied'`.
- **Confidence:** high. The CI value was exactly `'step denied changed'`.
- **Files:** `tests/e2e/app.e2e.mjs`

## 3. address saved and filled (autofill.e2e.mjs:89): category 2, plus category 3 cleanup
- **Root cause:**
  - In the merged layout, CI's 964×635 window has the AI panel and the bookmarks bar open, which leaves the page about 510px tall.
  - `address.html`'s form is about 900px tall, so `#zip`, `#email` and the submit button `#go` are below the fold.
  - The test's real mouse clicks (`sendInputEvent`) landed on nothing, so the form was never submitted and "Save address?" never appeared.
  - The 15.6s duration fits: retries on each off-screen field plus the 10s wait.
- **Fix:**
  - `clickOnce` scrolls the element into view first (`block: 'nearest'`, which does nothing when it's already visible). If the page scrolled, it waits 150ms so the scroll event comes before the click.
  - The click itself is unchanged: still a real, trusted click.
  - The card test now restores the `autofillCards` setting in a `finally` block.
- **Confidence:** high. The timings and screenshots match, and the card test, whose form fits on screen, passes.
- **Files:** `tests/e2e/autofill.e2e.mjs`

## 4. form entries (autofill.e2e.mjs:167): category 2, plus category 3 cleanup
- **Root cause:** the same as #3. The `#nick` field sits around y≈1300, so it was never typed into.
- **Fix:**
  - The same scrolling `clickOnce`.
  - The incognito part closes every incognito window in a `finally` block, so a failure can't leave one in front for later tests.
- **Confidence:** high.
- **Files:** `tests/e2e/autofill.e2e.mjs`

## 5. the ⋮ menu (browser.e2e.mjs:514): category 1
- **Root cause:**
  - The `app:menu` handler in `main/main.js` called `w.profile.bookmarks.isBookmarked(url)`.
  - After batch 5, `profile.bookmarks` is the `BookmarksService`, and that has no `isBookmarked`; only the store has it. The bad call came in where the bookmarks merge met the overlay ⋮ menu.
  - So every ⋮ click threw a TypeError inside the IPC listener, the menu was never shown, and the `on()` wrapper logged nothing.
- **Fix:** `w.profile.store.isBookmarked(url)`, the same call `tabs.js` uses for the star.
- **New unit test:** `tests/merged-menus.test.mjs` checks that every `profile.bookmarks.X(` call in `main.js` exists on `BookmarksService`. It fails on the old code.
- **Confidence:** high. The throw happened on every click, on every platform.
- **Files:** `main/main.js`, `tests/merged-menus.test.mjs`

## 6 and 7. extension commands (extensions.e2e.mjs:165) and chrome.alarms (:189): category 1, likely
- **Root cause (inferred; the log shows no extension error):**
  - Both events went through electron-chrome-extensions' `router.sendEvent`. It only delivers to listeners it has seen being added, and it does nothing at all when it has none.
  - The site-access test just before reloads the extension three times. That drops its listeners, and a service worker that kept running, or that registered its listeners before the library was watching it, never registers them again.
  - Main-to-worker events had never run on CI before: batch 7c's e2e file was "written, not run".
- **Fix:**
  - New `sendEvent()` in `main/extension-shims.js`. If the router knows a listener of that extension's, it delivers as before.
  - Otherwise, for an MV3 worker, it wakes the worker with `startWorkerForScope` and sends `crx-<event>` on the same channel the library uses, so the event is never delivered twice.
  - `runCommand` and the alarm stand-in both use it.
  - In test runs, extension workers' warnings and errors now go to the app's log, so the next CI log will show the cause if this still fails.
  - The shortcuts e2e test closes its pop-up and `cmd-*` pages in a `finally` block.
- **New unit tests:** in `tests/extension-access.test.mjs`.
- **Confidence:** medium-low. This fixes the explanation that fits the evidence, but I couldn't confirm it.
- **Files:** `main/extension-shims.js`, `main/extensions.js`, `tests/extension-access.test.mjs`, `tests/e2e/extensions.e2e.mjs`

## 8. lumio://version and lumio://flags-lite (extensions.e2e.mjs:253): category 2, fixed upstream
- **Root cause:** the test clicked `[data-flag=forceDark]`, but that flag moved to Settings › Appearance (`main/force-dark.js`).
- **Fix:** already on merge-v0.6.8 in cfbdf27. The test now checks that the flag is gone, checks the note pointing to Settings › Appearance, and toggles `smoothScrolling` instead. I checked it against `main/flags.js` and the flags-lite page.
- **Confidence:** high.
- **Files:** none.

## 9. split view focus (layout.e2e.mjs:107): category 1
- **Root cause (inferred):**
  - The focused side is tracked by `webContents` `'focus'` events.
  - Chromium only fires that event when focus actually changes. When the pair is made, the newest (right) page already holds the keyboard while the left side is activated.
  - Focusing or clicking the right page then fires no event, so it could never become the focused side. The screenshot shows the left side active.
- **Fix:** `TabManager.activate()` in `main/tabs.js`: when one side of a pair is activated and the other side holds the keyboard, the activated side gets it. This is skipped when another window is in front, because focusing would raise this one.
- **Unit test:** `tests/split-view.test.mjs`'s stand-in page now behaves like Chromium (it only reports real focus changes). A new test fails without the fix.
- **Confidence:** medium. Something on Mac I couldn't observe could still move focus back to the left side.
- **Files:** `main/tabs.js`, `tests/split-view.test.mjs`

## 10. Translate bubble (page-tools.e2e.mjs:59): category 1
- **Root cause:**
  - Main sends the translate offer once per page.
  - The window's UI dropped it whenever the address bar was focused, even when the person hadn't typed. This is the first test in the file, and the new tab page puts the caret in the address bar.
  - The test navigates from main, so the bar stays focused and untouched (`shell.js` already handles that case for showing the address). The offer was thrown away, and the button showed with no bubble, which matches the CI failure point.
  - A tab's hover card also blocked the offer.
- **Fix:**
  - `renderer/ui/shell.js`: "typing" now means the bar is focused and the person typed since focusing it (`omniFocused && omniEdited`).
  - `renderer/ui/translate.js`: a hover card gives way to the bubble. A forced open (from the menu) is unchanged.
- **Unit test:** `tests/translate-ui.test.mjs`. The "not while you type" case now really types, and both new cases are covered.
- **Confidence:** medium. The cause fits the evidence well, but some other dropdown state stuck on CI would still drop the offer.
- **Files:** `renderer/ui/shell.js`, `renderer/ui/translate.js`, `tests/translate-ui.test.mjs`

## 11. Name window (power-user.e2e.mjs:65): category 2, fixed upstream
- **Root cause:** the merged `main/menu.js` uses `role: 'window'`, which is still macOS's Window menu that lists windows by name. The test expected batch 7d's `'windowMenu'`.
- **Fix:** cfbdf27 already changed the e2e check to `/^window$/i`. I also fixed `tests/power-user.test.mjs`, which still expected `'windowMenu'` on Mac and contradicted `tests/menus.test.mjs`.
- **Confidence:** high. CI's actual value was `'window'`.
- **Files:** `tests/power-user.test.mjs`

## 12. Protocol handlers (power-user.e2e.mjs:194): category 2, fixed upstream
- **Root cause:** the test read `#permbar`, which after batch 6 exists only in pop-up windows. Browser windows now ask through the address-bar chip and its bubble, so the script threw.
- **Fix:** cfbdf27 rewrote the test to use the permission bubble, and the product code sends batch 6's request shape. I extended the headless test in `tests/power-user.test.mjs` to check:
  - the request's `cats`
  - `quiet: false`, so the bubble opens by itself
  - that the bubble's `{id, decision: 'allow'}` answer saves the handler
- **Confidence:** medium-high. CI never reached the later steps (a real `mailto:` click, and the Settings list).
- **Files:** `tests/power-user.test.mjs`

## Outside this group
The CI log has about 65 uncaught "Cannot read properties of undefined (reading 'id')" errors from `TabManager.state()` (`main/tabs.js`, which reads `t.view.webContents.id` while a view's webContents is undefined). None of these failures is caused by it, so I left it alone.
