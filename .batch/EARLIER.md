# Earlier work in this batch (b3)

## tabs-window — FINISHED

I finished batch 3 (motion, the tab strip and the window chrome) in `/Users/juan/Developer/lumio-browser-b3`. Batch 2 is being done separately in `/Users/juan/Developer/lumio-browser`, and I only read it to keep my changes from conflicting with it. `npm test`: 164 tests, 161 pass, 0 fail, 3 skipped (they were skipped before my changes). As required, I did not launch the app or run the e2e suite, so nothing has been checked in the real Electron app yet. All the visual checks were in headless Chrome 154, in light and dark; the app runs Chromium 150, which supports everything used.

**What I built**
1. **Motion tokens:** durations `--dur-1…5` (90/140/200/280/380 ms), curves `--ease-out`, `--ease-in`, `--ease-in-out`, and a spring `--ease-spring` with about 4% overshoot. The old `--ease` now points to `--ease-out`. One Reduce Motion rule set in `theme.css` covers the browser UI and all pages: everything finishes at once, but loading spinners keep turning. A small helper, `renderer/ui/motion.js`, gives scripts the same tokens and skips animations under Reduce Motion.
2. **Tab strip:**
   - A new tab grows in from nothing while its icon pops and its title fades in; a closed tab folds away.
   - Closing with the × or a middle-click keeps the other tabs' widths while the pointer stays on the strip, so the next × lands under the cursor. They spread out again once the pointer leaves.
   - Drag and drop puts the tab in its new place right away and lands it with the spring; it no longer snaps back for a frame. Dragging to the very last position now works (it didn't before).
   - Switching tabs fades the old highlight and springs in the new one. Pinning animates the tab down to its small size.
   - Nothing animates on the first draw or a restored session.
   - The narrow-tab check now also updates when the window is resized.
3. **Tab hover cards:** after 500 ms on a tab, a card shows the title (2 lines), the site, a page picture, "Sleeping (saved memory)" and any helper AI working there. It replaces the old tooltip and draws over the page. Once a card is up it slides straight to the next tab. Pictures are taken when you leave a tab and on hover for the tab you're on, kept in memory per window (so incognito previews stay in their own window), and never saved to disk.
4. **Load progress:** a thin accent line along the bottom of the address bar. It jumps to real loading milestones (started, the page answered, its document is ready), creeps between them, then fills and fades. Switching tabs shows the right state at once.
5. **Bars:**
   - **Find bar:** now floats over the right end of the address bar, so nothing in the toolbar or page moves. It steps aside while you type an address.
   - **Bookmarks bar and permission bar:** slide open and shut, and the page follows frame by frame, the same way it already follows the AI panel. I chose this over a permission bubble because the bubble would share the one overlay with menus and hover cards and could hide a question that must stay until answered. The reasons are in the CSS comments.
   - **Downloads button:** its space opens smoothly instead of shoving the toolbar.
6. **Toasts:** they float over the end of the URL instead of squeezing it. A new one goes in front with older ones stacked behind; each gets its full reading time (2–6 s), pauses on hover, and is announced politely to screen readers. Long notes wrap to two lines.
7. **Address bar:** the icons at its end open and close their own space smoothly; tab switches swap the toolbar instantly. The focus ring fades on its own layer, the lock and search icons crossfade, and the star pops when you bookmark.

**Files changed:** `renderer/assets/theme.css`, `renderer/ui/shell.js`, `renderer/ui/shell.css`, `renderer/ui/overlay.js`, `renderer/ui/overlay.css`, `renderer/ui/icons.js` (a moon icon), `main/tabs.js`, `main/window.js`, `main/main.js` (one IPC line), `tests/e2e/browser.e2e.mjs`. New: `renderer/ui/motion.js`. `shell.html` and the preload are unchanged.

**Tests added:**
- `tests/motion.test.mjs`: 10 headless tests covering tokens and Reduce Motion, tab open/close, the frozen widths, drag/drop and pinning, hover cards in the window and the overlay, load progress, the bars and find bar, toasts with a contrast check in light and dark, and the address bar icons.
- `tests/shell-page.mjs`: a test harness I made separate from `shell.test.mjs` because batch 2 is also editing that file.
- One e2e test at the end of `browser.e2e.mjs` (hover card with a picture, progress reaches 1). It needs a CI run.

**Left undone or risky:**
- The picture of a tab you've left is taken while that tab is hidden, which hasn't been tried in the real app. The e2e test only checks the picture of the active tab. Tabs opened in the background have no picture until you've viewed them once.
- Tab widths animate through the strip's layout rather than transforms. That layout work stays inside the tab strip and never moves the page.
- The find bar covers the star and the end of the URL while it's open.
- The hover card spans the strip width but disappears as soon as the pointer reaches it, so it shouldn't swallow clicks meant for the toolbar.
- If the browser itself closes a menu, the window can keep thinking a menu is open (this was already the case). Hover cards then stay off until the next click.
- **Merge with batch 2:** both batches edit the same overlay and window files, and the `tab:close` line in `main.js`. The bar animations are pure CSS, so batch 2's new `permbar.js` and pop-up-blocked button in the address bar get them with no extra work. Any test that counts `.tab` elements right after a close should use `.tab:not(.closing)`, because closed tabs stay briefly while they fold.
- **Not in this task:** animations for the other dropdowns, tab strip overflow scrolling, and keyboard navigation of tabs. I also left the old per-component Reduce Motion rules in `shell.css`; they're now redundant, but removing them would widen the diff.

## menus — FINISHED

Batch 3's menus and popovers task is finished in `/Users/juan/Developer/lumio-browser-b3`. `npm test` ran 177 tests: 174 pass, 0 fail, 3 skipped (Windows-only, skipped before too). The app and the e2e suite were not launched, so nothing has been checked in real Electron yet; the visual checks ran in headless Chrome in light and dark. Nothing touched the iPhone simulator, and git was left alone.

An earlier run of this task had already done most of the work and stopped before reporting. This run reviewed it, fixed what was wrong and added tests. The audit JSON (`.../scratchpad/audit.json`) no longer exists, so this run worked from the task text only.

**What I built**
1. **Every popover animates in and out each time.** This covers suggestions, downloads, site info, account, password save/autofill, passkey, update card, screen share and the hover card.
   - The overlay draws the new popover unseen and reports its height. Only then is the view put on top, and it grows from its button (scale .96→1 plus a fade; suggestions come down from the top).
   - On close it plays a shorter exit and tells main once an empty frame is drawn. Only then does the view come off, so the old content never flashes. If no answer comes, the view is removed after 400 ms anyway.
   - Opening another popover in the middle of an exit cuts the exit short and works.
   - Reduce Motion: popovers appear and disappear instantly.
   - **Fixes this run:**
     - Content that changed during that wait could put the view on screen before the old frame was cleared.
     - A popover opened while its window was hidden kept the wrong height.
     - A popover that another view (the AI's working bar) went over now comes back on top when it updates.
2. **Chrome-style ⋮ menu on all platforms.** On the Mac the native menu bar stays too. It replaces the native popup and uses the same `cmd.*` handlers.
   - Sections: New tab / New window / New Incognito window; Passwords and autofill, History ›, Downloads, Bookmarks and lists ›, Extensions ›; a live Zoom row (− 100% + and full screen); Print…, Find…, Save page as…, More tools › (Clear browsing data…, Developer tools); an Edit row (Cut, Copy, Paste); Settings, Help ›, Quit/Exit. There is no Task manager yet, so that item is left out.
   - Shortcuts shown next to items are taken from the real app menu.
   - Submenus slide out on hover or the Right arrow. Keyboard: arrows, Home/End, Enter/Space, Esc, Tab and type-ahead. The highlight glides between rows.
   - **Changes this run:**
     - Help had placeholder Terms, Privacy and licenses entries for commands that don't exist. It now holds About and "What's new", which opens the release notes once the updater has found them.
     - A menu opened from the keyboard now takes the keyboard itself and names the selected row for screen readers (`aria-activedescendant`). Opened with the mouse, the window keeps the keyboard so text being edited stays as it was.
3. **Omnibox suggestions:**
   - Each row shows the site's icon, with a small clock or star tag for history and bookmarks. Without an icon it shows the row-type icon: clock, star, search glass or the Lumio mark.
   - The text you typed is in bold.
   - Rows come in one after another, all within 120 ms.
   - One highlight glides between rows with the arrow keys.
   - Behaviour change: hovering a row now selects it, so Enter opens that row even though the address bar still shows what you typed. The old code only highlighted rows on hover.
4. Right-click (context) menus are unchanged and still native.

**Files changed (this task):** `main/menu.js`, `main/window.js`, `main/main.js`, `main/omnibox.js`, `main/ai/indicators.js`, `preload/shell.js` (one event name), `renderer/ui/overlay.js`, `renderer/ui/overlay.css`, `renderer/ui/shell.js`, `renderer/ui/shell.html` (⋮ button), `renderer/ui/icons.js`, `renderer/pages/history.js` (`?clear=1` opens Clear browsing data), `tests/e2e/browser.e2e.mjs`.

**Tests added:**
- `tests/popovers.test.mjs` (10 tests): the show/hide steps in main, keyboard hand-off, the menu's entries and shortcuts, and that the preload lets every channel through. Two of these and the What's new check were added this run.
- `tests/popovers-ui.test.mjs` (4 headless tests): popovers coming in, going out and cut short; the new waiting check (confirmed to fail without the fix); suggestions; the menu's keyboard, submenus, zoom, screen-reader focus and contrast in light and dark; the window's ⋮ button.
- One e2e test for the ⋮ menu in `tests/e2e/browser.e2e.mjs`, which needs a CI run.

**Left undone or risky:**
- Keyboard focus handed between views (window ↔ overlay ↔ page) is only tested with stand-ins, not in real Electron.
- The window decides the keyboard came from the page if it took focus less than 150 ms before the click on ⋮. That is a guess about timing.
- When the window keeps the keyboard (menu opened with the mouse), screen readers stay on the ⋮ button rather than following the menu.
- The account and downloads popovers still can't be used from the keyboard; this was already the case.
- There is no shortcut to open the menu (Chrome's Alt+F / F10).
- Help › What's new only appears once the updater has checked for releases.
- Merging with batch 2: both batches touch `app:menu`, `overlay:hide` and `tab:hovercard` in `main.js`, plus `window.js` `showOverlay`/`hideOverlay`. Any test that expects the overlay attached the moment `showOverlay` is called must now wait for it to be ready.

## panel-pages — INTERRUPTED by a usage limit; its partial edits are in the last WIP commit. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## a11y — INTERRUPTED by a usage limit; its partial edits are in the last WIP commit. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## motion-qa — INTERRUPTED by a usage limit; its partial edits are in the last WIP commit. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## panel-pages — INTERRUPTED by a usage limit; its partial edits are in the last WIP commit. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## a11y — INTERRUPTED by a usage limit; its partial edits are in the last WIP commit. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## motion-qa — INTERRUPTED by a usage limit; its partial edits are in the last WIP commit. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## panel-pages — INTERRUPTED by a usage limit; its partial edits are in the last WIP commit. Its last notes:

(none)
