# E2E fixes — fixer E (security keys, bad certificate, full-screen notice, pop-ups, protocol handlers)

Failures are from CI run 37407933475 on `v0.6.8-int`. Branch: `e2e-fix-e`. There was no Mac to test on, so the causes
below come from the CI log, the run 3 screenshots, the product code and Electron's source (`native_window_mac.mm`,
`electron_api_web_contents.cc` on main). `npm test` passes, except "the media popover" in
tests/page-tools-ui.test.mjs. It is a headless-Chrome flake, and it also failed once on the unchanged branch. Another
`npm test` run had failures in tests/lifecycle-ui.test.mjs and tests/credits.test.mjs, coming from the Electron
binary missing here. They passed when run again.

## Summary

| Test | Cause | Fix | Confidence |
|---|---|---|---|
| autofill.e2e.mjs:204 security keys | Test race left by the test before it (cascade) | Wait until the incognito window has closed | high |
| dialogs.e2e.mjs:367 bad certificate | Product: the address bar stayed "focused" after the page took the keyboard | `page-focus` from main lets go of the address bar | medium-high |
| lifecycle.e2e.mjs:125 notice goes by itself | CI timing: asked again while the Mac was still leaving full screen | Wait for the exit to finish | medium-high |
| popups.e2e.mjs:218 sized pop-up title | Product race: the bar's own `<title>` replaced the page's | Ignore `page-title-updated` on the pop-up window | high |
| popups.e2e.mjs:430 window management | Product: chip bubble wouldn't open while the address field was the shell's activeElement | Open unless the person is typing an address, plus `page-focus` | medium-high |
| power-user.e2e.mjs:210 protocol handlers | Same as above | Same | medium-high |

## 1. Security keys (autofill.e2e.mjs:204): cascade from the test before it
- **Cause:** "form entries" (the test before it) types into a page in an incognito window. It then closes that window
  in a `finally` block, but `w.close()` doesn't close it at once. The page was typed in (`tab.touched`), so
  `confirmClose()` runs its beforeunload first. That takes a moment, and during it the incognito window is still
  `global.lumio.current`. The security-key test's `go()` navigates that dying window's tab. When the window closes,
  `title()` reads the normal window's tab, which is still "Shipping — Test Shop". So it never sees "Security Key Test
  Site". Runs 1 and 2 didn't show this: "form entries" failed before it opened the incognito window. Now that it
  passes, the race shows up.
- **Fix (test):** after closing, the `finally` waits until no incognito window is left and the current window isn't
  incognito.
- **Diagnostics:** if the window doesn't close, the test prints each window's state (closing, confirming, its tabs:
  title, touched, closing). If `go()` times out, it prints every window, whether it's the current one, and its tabs
  (title, URL, active).
- **Confidence:** high.
- **Files:** tests/e2e/autofill.e2e.mjs.

## 2. Bad certificate, "Not secure" (dialogs.e2e.mjs:367): product
- **Cause:** screenshot `run3/shots/74-cert-warning.png` shows the address bar focused on the warning page: blue ring,
  search icon, caret. `73-sign-in.png` shows the same while the HTTP sign-in dialog's field also has the caret.
  `paintSiteIcon` is skipped while `omniFocused` is set (renderer/ui/shell.js `siteIcon`), so after "Proceed" the
  icon stayed the search icon. The state was right: `notSecure: true`, which the test also checks. Two things cause
  this:
  - When only a page view takes focus, the address field stays the shell's `document.activeElement`.
  - On CI's Macs the shell document doesn't get its blur when another view in the window takes the keyboard, so
    `omniFocused` stays true. The two carets in screenshot 73 show this.
- **Fix (product):**
  - main/tabs.js: when the active tab's page gets focus (the webContents `focus` event, which already handled split
    view), main sends `page-focus` to the window's shell.
  - preload/shell.js: allows the new `page-focus` event.
  - renderer/ui/shell.js: on `page-focus`, the shell blurs the address field. If it still thinks the field is
    focused, it runs the blur handler (`addressBlurred`) itself, so the site's icon ("Not secure", the lock) comes
    back. This is also what Chrome does: the omnibox gives up focus when the page takes the keyboard.
- **Confidence:** medium-high. This relies on Electron emitting the page's `focus` event on the Mac. The sign-in
  dialog's caret in screenshot 73 suggests the views do get focus there.
- **Diagnostics:** if the icon doesn't read "Not secure", the test prints:
  - the icon's text, title and class;
  - the shell's activeElement, `hasFocus()`, the omnibox's classes and the address;
  - whether the page, the shell and the window are focused, from main.
- **Files:** main/tabs.js, preload/shell.js, renderer/ui/shell.js, tests/e2e/dialogs.e2e.mjs.

## 3. The full-screen notice goes by itself (lifecycle.e2e.mjs:125): CI timing
- **Cause:** the test before it passed, but took 8.5 s. In run 2 the same test failed at 3.5 s, so its final
  `until(!isFullScreen, 5000)`, which isn't asserted, almost certainly timed out: the Mac was still leaving full
  screen. This test then calls `requestFullscreen()` again. During an HTML full-screen transition, Electron's
  `IsFullscreenForTabOrPending()` returns true, so `OnEnterFullscreenModeForTab` returns early. Electron never emits
  `enter-html-full-screen`, while Blink still reports the page as full screen, which is why the
  `requestFullscreen()` promise resolved. Lumio never hears about it, so there is no notice and `fullscreenTab` stays
  null.
- **Fix (test):** before asking again, wait until the window is out of full screen (up to 20 s), then 1.5 s more for
  the end of the animation.
- **Not changed (product):** a page that asks for full screen during the Mac's exit animation is ignored by
  Electron, without a notice. It is rare for a person (Esc, then full screen again within about a second). Working
  around it would mean following `fullscreenchange` from the page preload, which is outside this fix.
- **Confidence:** medium-high.
- **Diagnostics:**
  - "still full screen before asking again" with the window, `fullscreenTab` and notice state.
  - "no notice" with the same state, plus `document.fullscreenElement` and whether the notice view exists and is
    ready.
  - If the window never leaves full screen (a transition stuck on CI), the first line shows it.
- **Files:** tests/e2e/lifecycle.e2e.mjs.

## 4. Sized pop-up, window title (popups.e2e.mjs:218): product race
- **Cause:** `PopupWin` sets the window title from the page's (`onChanged` → `setTitle`). The pop-up's own bar page
  (renderer/ui/popup.html) has `<title>Pop-up</title>`, though. When the bar finishes loading, Electron's default
  `page-title-updated` handling renames the window. If the page's title ("Pay here") arrived first, nothing set it
  again, and the window stayed "Pop-up". That depends on load order, which matches fixer A's "one unexplained Linux
  failure in ~11 runs" and the Mac failing every time.
- **Fix (product):** the pop-up window `preventDefault()`s `page-title-updated`, the same way main/window-name.js
  keeps a named window's title. Only the page's title names it.
- **Confidence:** high.
- **Diagnostics:** if the title is still wrong, the test prints the window's title and its page's `document.title`.
- **Files:** main/popup-window.js, tests/e2e/popups.e2e.mjs.

## 5 and 6. The bubble doesn't open by itself (popups.e2e.mjs:430, window management; power-user.e2e.mjs:210, protocol handlers): product
- **Cause:** `autoOpen()` in renderer/ui/permission-chip.js didn't open a question's bubble when
  `document.activeElement?.id === 'address'`. When the page has the keyboard, the field still stays the shell's
  activeElement, because only the page view took focus. Any window whose address bar was ever focused never got the
  bubble by itself. Two examples:
  - Every new window starts that way: the New Tab page focuses the address bar.
  - power-user's L relaunches for Force dark, and the protocol-handler test runs in that fresh window.

  Questions in the site-controls tests open fine because their window's address bar wasn't the last thing focused.
  This is the same Mac focus problem as #2.
- **Fix (product):**
  - The bubble opens by itself unless the person is typing an address: `isTyping = omniFocused && omniEdited`, the
    same rule the Translate bubble uses.
  - The `page-focus` fix from #2 also clears the stale activeElement.
- **Confidence:** medium-high. Another overlay still open (`overlayKind`) would also stop it, and the diagnostics
  will show that.
- **Diagnostics:** if the bubble doesn't open, both tests print:
  - the window's `overlayKind`, `overlayIn`, `overlaySeq`;
  - the page's URL and whether the page and the shell are focused;
  - the shell's activeElement, `hasFocus()` and omnibox classes, and the chip's text (null if no question reached
    it).

  The protocol-handler test also prints the saved handlers.
- **Files:** renderer/ui/permission-chip.js, renderer/ui/shell.js, tests/e2e/popups.e2e.mjs,
  tests/e2e/power-user.e2e.mjs.

## Noticed, not changed
- The Mac's full-screen exit can take more than 5 s on CI. lifecycle.e2e.mjs:93 waits 5 s at its end and doesn't
  check the result. Test #3 now waits, so later tests start out of full screen.
