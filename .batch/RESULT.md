batch3-motion

# Batch 3 (motion and polish): result

All four items are done, pushed to `batch3-motion`. I didn't launch the Electron app or run the e2e suite here, as the task said. Everything was checked in headless Chromium 141; the app ships Chromium 150, which supports everything used.

## Test counts
- **Before I changed anything:** `npm test` ran 174 tests: 167 passed, 2 failed, 5 skipped. Both failures were in the ⋮ menu tests from the WIP commit: they expected macOS shortcuts (⌘, and ⌃⌘F) while running on Linux, where the menu shows ⌃ and F11.
- **Now, root `npm test`** (it includes `server/test`): 195 tests, 190 pass, 0 fail, 5 skipped. The skips are the same ones as before: Windows-only, Mac-only and Safari.
- **`npm test` in server/:** 38 pass, 0 fail. I didn't change the server.
- **Flakiness:** I ran the six headless UI test files together 5 times after the last fixes, with no failures.

## Items

### 1. Menus and popovers: done (earlier agents), test fix only
The WIP commit already held the finished work (EARLIER.md, "menus"). I checked it with the capture script below: every popover animates in from its button and out again, with no flash of old content.

My only change here: the two failing tests now expect the shortcuts of the platform they run on (`tests/popovers.test.mjs`, `tests/popovers-ui.test.mjs`).

### 2. AI panel, internal pages, Customize Lumio: done

**AI panel (`renderer/ui/ai-panel.js`, shell.css):**
- **Opening a chat:** a saved chat opens at once. Its history gets `.old`, which turns its animations off; only messages that arrive afterwards rise in.
- **Streaming:**
  - The reply is drawn about 10 times a second (`STREAM_MS = 100`), not every frame.
  - Finished blocks are parsed once and kept. Only the last block, the one still being written, is parsed again. A block ends at a blank line outside a ``` code fence (`stableEnd`).
  - When the answer ends, the whole text is drawn once more and gets its copy buttons.
- **Screen readers:** `#messages` no longer has `aria-live`, which made them read every word. A polite `#ai-announce` region now reads each finished answer once, plus notices. Saved chats are not read when opened.
- **Scrolling:** I removed `scroll-behavior: smooth`, which fought with following new words.
  - The chat sticks to the bottom while Lumio writes.
  - If you scroll up, it stays where you are and a "Jump to latest" pill appears. The pill fades and rises in, and is hidden from the keyboard and screen readers while it isn't shown.
- **Steps and checklist:**
  - A finished step's spinner pops into its result, and a check mark draws itself.
  - A finished plan step's check does the same.
  - Helper rows, notices and step pictures rise in.
  - Approval cards fade out on the shared easing (instantly under Reduce Motion).

**Internal pages:**
- **Shared helper:** `renderer/pages/page-motion.js`.
  - `patchList` is a keyed list update. Rows that stay are changed in place, so focus, hover and selection survive. New rows rise in; removed rows fade out.
  - `leave` removes a row; the rows below it slide up using transforms, not by animating its height.
- **Downloads:** no longer rebuilds the whole list every second, so buttons keep focus. The progress bar now moves with `scaleX` instead of width, and has `role=progressbar`.
- **History:** removing entries fades them out and slides the rest up. A day left empty goes too.
- **Bookmarks:** uses `patchList`; a deleted row fades out.
- **Entrance and empty states:** every page rises in once (`.wrap`, `.layout`). The New Tab page comes in one section at a time. Empty and loading states share one style in pages.css.
- **Dialogs** (Clear browsing data): rise in over a fading scrim and drop away when closed. This is CSS only (`@starting-style`, `allow-discrete`).
- **Settings:**
  - Clicking a side-nav link scrolls smoothly (instantly under Reduce Motion), focuses the section heading and updates the URL hash.
  - The nav highlight now slides from link to link as you scroll. It uses transforms and sets `aria-current`, and picks the last section when you reach the bottom of the page.
  - A scroll you start yourself (wheel, keys) takes over from a click's scroll.

**Customize Lumio** (New Tab page: a "Customize" button at the bottom right, hidden in incognito):
- **Files:** `main/customize.js` in main, and `renderer/pages/newtab-customize.js` plus `customize.css` on the page. Background colors are new tokens in `theme.css` (`--ntbg-*`, `--sheet-scrim`), in both palettes.
- **The sheet:**
  - Slides in from the right edge (leaves a little faster than it comes), over a scrim, with the page behind it made inert.
  - Esc closes it and puts focus back on the Customize button.
  - All choices are radios, so arrow keys move between them.
- **What it offers:**
  - Theme: System / Light / Dark, the existing `appearance` setting.
  - Color: the existing profile theme colors, through `setProfile`. The New Tab page now uses your accent color too; before, it was always blue.
  - Background: None, Aurora, Dusk, Meadow, or your own image. A new choice fades in.
  - Show shortcuts on/off; Show "Pick up where you left off" on/off.
- **Where it's stored:** `settings.newTab`, which Lumio Sync carries (added `newTab` to `SETTINGS` in `main/sync/adapters.js`).
- **Your own image:** stays on this computer as `userData/newtab-background.jpg`, scaled down to at most 2560 px and never synced. If another device picks "your image" and this one has no picture, it shows no background.

### 3. Accessibility and keyboard: done
- **Tab strip** (`renderer/ui/a11y.js`), following the WAI-ARIA tabs pattern:
  - The strip is one Tab stop.
  - Left/Right move between tabs (wrapping around), Home/End jump to the ends.
  - Enter or Space switches to the focused tab. Delete (or the Mac's delete key) closes it, and focus moves to the next tab.
  - The ×/mute buttons inside tabs stay out of the Tab order.
  - A focused tab shows a focus ring and its ×.
- **F6 / Shift+F6:** hidden app-menu items (`main/menu.js`) call `cmd.focusPane`. The window then goes round: toolbar (address bar selected), bookmarks bar, page, AI panel, sidebar, skipping hidden parts. This works from the page too. Cmd/Ctrl+L is unchanged. On Windows/Linux, F6 used to just focus the address bar; it now cycles, like Chrome. I didn't add Alt+Shift+T (it was optional).
- **Focus rings:** a default `:focus-visible` ring using `--focus-ring` everywhere (theme.css, zero specificity, so controls that draw their own keep it).
  - Controls that only appeared on hover also appear for the keyboard: tab ×, chat-list delete, copy on code, sidebar chevrons and dots, history row actions and checkboxes, bookmark rows.
  - Text fields that draw no outline show focus on their border instead.
- **Screen readers:**
  - Toasts were already polite.
  - A finished download is announced once, and the Downloads button says how many are in progress.
  - AI answers are announced once each.
  - Icon-only buttons get their tooltip as a name.
  - Suggestions already used listbox/option and the ⋮ menu already used menu/menuitem.
- **Reduce Motion:**
  - It applies everywhere: the global rule in theme.css, and `reduced()` in `motion.js`, which now also obeys the Lumio setting.
  - Scripts that checked `matchMedia` directly (AI panel, Settings, page-motion) obey it too.
  - The Customize sheet fades in place instead of sliding.
- **Less transparency and more contrast:** `prefers-reduced-transparency` makes glass surfaces solid. `prefers-contrast: more` makes lines and secondary text stronger and the focus ring the full accent color.
- **Settings › Accessibility** (new section in Settings and the side nav; `main/accessibility.js`, `renderer/pages/settings-a11y.js`):
  - "Show a focus outline around objects": a ring on anything that has focus, even from a click.
  - "Reduce motion in Lumio": same as the system setting, whatever the system says.
  - "Larger text in Lumio's interface": text ×1.15 in tab titles, the address bar, bookmarks, the chat and chat box, popovers, ⋮ menu text, and whole internal pages.
  - **How they're delivered:** they go through the appearance broadcast. `main/theme.js` now includes them in its change key, and `BrowserWin.applyAppearance` and `TabManager.applyAppearance` send `ui-prefs` to the window, the overlay and lumio:// pages. `main/protocol.js` also stamps them onto each page's `<html>` as it's served, so the first paint is already right. `renderer/assets/ui-prefs.js` keeps them live. The settings are stored locally and not synced.
- **Headless tests:** `tests/a11y.test.mjs` covers:
  - Tab strip keyboard, ring and ×; icon-button names.
  - F6 order.
  - The download announcement.
  - Reduce Motion from the system and from the setting: nothing lasts longer than 2 ms, and scripts skip theirs.
  - Settings › Accessibility switches, live updates, focus ring and larger text.
  - Hover-only controls showing on focus; text scale.
  - The main process: checking the values, stamping them on pages, and the broadcast.
  - Contrast and transparency.
- **⋮ menu keyboard** stays covered by `tests/popovers-ui.test.mjs`.

### 4. Motion and visual QA: done
`node tests/motion-capture.mjs` (a script, not part of `npm test`) drives the window, overlay and pages in headless Chrome. Outputs, in dist/ (gitignored, so not committed; re-run the script to regenerate):
- **`dist/motion-shots/<moment>-<n>.png`:** 130 frames covering 33 moments, played at a fifth of their speed.
  - Tabs open, close and reorder; the find bar, permission bar, toast and load progress.
  - Each popover in and out: suggest, downloads, site info, account, password save, passkey, update, screen share, hover card. The ⋮ menu in, submenu, and out.
  - AI message in and step done; streaming.
  - Customize opening and closing; Settings scroll-spy.
- **`dist/batch3-shots/`**, each in light and dark:
  - `menu-submenu-{light,dark}.png`
  - `hover-card-*.png`
  - `progress-bar-*.png`
  - `customize-{none,aurora,dusk,meadow}-*.png`
  - `settings-accessibility-*.png`
  - `jump-to-latest-*.png`
- **`dist/motion-report.json`:** frame times, Reduce Motion results, and the CSS transitions that animate layout.

**Frame times** (longest gap between frames): 17 ms for tab open, tab close, popover open and AI streaming of about 200 chunks. The 95th percentile was 17 ms everywhere.

**Reduce Motion** (system and setting): window, overlay and pages all have nothing longer than 1 ms, and the Customize sheet doesn't slide (`transform: none`).

**What I looked at in the frames:**
- Popovers grow from their buttons (the account menu from the top right, suggestions from the top).
- The ⋮ submenu slides out beside its row.
- The Customize sheet slides in from the right edge.
- Chat messages and steps rise in, and a step's check pops in and draws.
- There are no flashes of old content and no overlapping glitches.

### Review findings
| # | Severity | Finding | Fixed |
|---|---|---|---|
| 1 | Medium | Pressing F6 then Shift+F6 within one frame put focus back in the address bar: its focus handler called `select()` a frame later, and `select()` takes focus. | Yes (`shell.js`: only selects if it still has focus) |
| 2 | Medium | Settings scroll-spy: a late `scrollend` from an earlier scroll could move the highlight off the section you just clicked. | Yes |
| 3 | Medium | With Larger text, suggestions and the downloads popover were sized for 38 px/54 px rows, so long lists were cut off. | Yes (`textScale()` in `a11y.js`) |
| 4 | Medium | The Downloads page redrew the whole list every second, losing focus and hover. | Yes |
| 5 | Medium | The whole chat was `aria-live`, so screen readers read streaming answers word by word. | Yes |
| 6 | Medium | `#messages` used smooth scrolling, which fought with following new words. | Yes |
| 7 | Medium | Streaming re-parsed the whole answer as markdown every frame. | Yes |
| 8 | Medium | Opening and closing the AI panel animates its width; the bookmarks and permission bars animate their height; tab widths animate (layout, not transform). This is by design: the native page view must be resized with them each frame (EARLIER.md explains the bars and tabs). Headless frame times are fine, but this hasn't been timed in the real app. | No (by design) |
| 9 | Low | Things that still animate layout: the task checklist folding (`max-height`), the Update button's progress and the effort slider's fill (`width`), the welcome page's dots. None of these happen while you browse. | No |
| 10 | Low | While streaming, a list split by blank lines can show as separate lists until the answer ends, then it's redrawn whole once (a small settle at the end). | No |
| 11 | Low | The menu tests assumed macOS shortcuts. | Yes |

## E2E tests added (`tests/e2e/browser.e2e.mjs`, need a CI run)
- `Settings › Accessibility reaches the window, the overlay and pages at once; F6 goes round to the page and back`
- `Customize Lumio: the New Tab sheet saves a background and what the page shows`
- From earlier agents in this batch: `hover cards: …`, `the ⋮ menu: …`

## Not done or risky
- **Not run in Electron:**
  - The new e2e tests.
  - F6 from inside a web page (it relies on a hidden menu accelerator, as Cmd+L does).
  - `webContents.isFocused()` deciding that the page has focus.
  - Larger text's zoom in the real overlay views.
- **Larger text scope:** websites keep their size. In the window only selected text grows (tabs, address, bookmarks, chat); toolbar heights stay fixed.
- **Customize image:** the picked image is read with `nativeImage`. HEIC support depends on macOS.
- **Accessibility settings aren't synced.** I treated them as per-computer; add `accessibility` to `SETTINGS` if you want them synced.
- **Streaming:** the "only the last block" rule splits blocks at blank lines. Unusual markdown (reference links defined later, 4-space-indented code with blank lines) can look slightly different until the answer finishes, then it's drawn whole.
- **No new dependencies.**

## Merge hints (shared files I changed)
- **main/main.js:**
  - `require('./accessibility')`
  - `setPageAttributes(...)` before `registerUiProtocol`
  - `cmd.focusPane`
  - two `register(...)` lines after `page:open-chat`
- **main/menu.js:** the File menu's `F6` line, now `focusPane` on all platforms.
- **main/window.js:** 2 lines in `applyAppearance`.
- **main/tabs.js:** 1 line in `applyAppearance`.
- **main/theme.js:** the change key and `uiPrefs`.
- **main/protocol.js:** `setPageAttributes` and the HTML stamp.
- **main/sync/adapters.js:** `SETTINGS` gains `newTab`.
- **preload/shell.js** and **preload/internal.js:** `EVENTS` gain `ui-prefs` and `focus-pane`.
- **renderer/ui/shell.js:**
  - imports, and an `initA11y` call after `sidebar.init`
  - the address `select()` guard
  - `textScale()` in two popover heights
- **renderer/ui/shell.html:** `#messages` attributes.
- **renderer/ui/shell.css:** the `#messages` scroll rule, step/plan animations, Jump pill, `.sr-only`, and an accessibility section appended at the end.
- **renderer/ui/overlay.js:** 1 import. **overlay.css:** a section appended at the end.
- **renderer/assets/theme.css:** New Tab background tokens; Reduce-motion attribute, focus, text-scale, transparency and contrast blocks.
- **Settings:** settings.html (nav link and section), settings.js (sidebar highlight rewritten), settings.css (nav indicator).
- **Pages:** pages.css, lists.css, history.css/js, downloads.js, bookmarks.js, newtab.html/js/css; one `ui-prefs` import line in each page script.
- **New files:**
  - `main/accessibility.js`, `main/customize.js`
  - `renderer/ui/a11y.js`, `renderer/assets/ui-prefs.js`
  - `renderer/pages/page-motion.js`, `newtab-customize.js`, `customize.css`, `settings-a11y.js`
  - tests: `panel-motion`, `pages-motion`, `pages-page`, `customize`, `a11y`, and `motion-capture.mjs`
- **Test harnesses:** `tests/pages-page.mjs` is a separate harness, so `pages-theme.test.mjs`, which other batches may edit, stays untouched.
