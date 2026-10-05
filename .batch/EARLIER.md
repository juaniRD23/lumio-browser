# Earlier work in this batch (b7d)
# Earlier work in batch b7d (rebuilt from logs)

## vertical-split — FINISHED (run wf_11dde92d-adc)

Both features are built: tabs to the side, and split view. `npm test` passes with 181 tests: 178 pass, 0 fail, and 3 skipped (the existing Windows-only tests). I could not launch the app here, so nothing has been tried in Electron. The new e2e file only runs on CI.

**1. Vertical tabs — done**
- **How to turn it on:** "Show Tabs to the Side" is a checkbox in the tab right-click menu and in the strip's empty-area menu. Settings › Appearance has a "Show tabs to the side" switch that applies to every open window.
- **Per window:** each window saves its own on/off and collapsed state with the session. New windows start with the last choice made.
- **Where the column sits:** the strip's row goes away and the toolbar becomes the top row. The Mac window buttons and the "show sidebar" button move to the start of the toolbar. On Windows, the caption buttons are resized to match the toolbar.
- **Expanded:** icon, title, close button, and audio and helper-AI dots. Pinned tabs show as tiles at the top. There is a "New tab" row at the end.
- **Collapsed:** icons only (44px wide). Hovering for 350ms opens a full list over the page. That list has to be drawn in the overlay view, because pages cover the window's own HTML. Main checks the pointer position and closes it when the pointer leaves.
- **Interactions:** click, middle-click to close, right-click menu, and drag to reorder all work. Keyboard: arrows, Home/End, Enter/Space to open, Delete to close, Alt+Shift+arrows to move, Shift+F10 for the menu, Esc back to the page.
- **The Lumio sidebar:** I kept it as its own full-height column at the far left with its own ⌘⇧S toggle. The tabs column sits beside the pages, under the toolbar, where the strip's tabs were. Each column has one job and one toggle, and nothing jumps between places. The cost is that both columns open together take about 476px; collapsing the tabs or hiding the sidebar gives that back.

**2. Split view — done**
- **Starting a split:** right-click a tab › "Add Tab to New Split View". It pairs with the tab you're on, or with a new tab page if it is the tab you're on. You can also drag a tab from the strip or the column onto the left or right 30% of the page; a preview appears and letting go makes the split. There is also "Open Link in Split View" on links.
- **On screen:** each side has a slim 30px bar with its site and buttons to swap, separate or close that side. The divider can be dragged or moved with the keyboard; double-click or Enter evens it out. The focused side gets an accent ring, and both tabs show a split icon in the strip and the column.
- **Focus:** clicking into the other page makes it the focused side, and the toolbar shows that side. The find bar, the zoom badge, page tools and the AI panel all act on the focused side.
- **Permissions:** the permission bar still spans both pages, but a chip on the asking side's bar says "Asks to…".
- **Other behaviour:** closing one side leaves the other with the whole page area. Pairs stay next to each other in the strip and are saved with the session. Pinned tabs can't be split.
- **Where the layout lives:** the page-slot layout is in `TabManager.layout()` in `main/tabs.js`, not `main/window.js`. The shell measures the two panes and reports where each page goes, so the pages line up exactly with the drawn panes.

**Files**
- New: `main/split-view.js`, `main/tab-layout.js`, `renderer/ui/vertical-tabs.js` and `.css`, `renderer/ui/split-view.js` and `.css`, `renderer/ui/tab-rows.js` (shared row code), `renderer/ui/tab-flyout.js`.
- Hub edits, kept small:
  - `main/tabs.js`: about 60 changed lines across layout, activate, close, detach, move, pin, sleep, state and session.
  - `main/main.js`: new IPC channels, the menu items, and the session `layout` field.
  - `main/window.js`: the layout option, the flyout hooks, and the overlay is no longer re-added when it is already on top.
  - One or two lines each in `renderer/ui/shell.js`, `renderer/ui/shell.html`, `renderer/ui/overlay.js`, `preload/shell.js` (new `tab-layout` event), `main/store.js` (`verticalTabs: false`), and the Settings page.
- `shell.js` gained two hook lines inside `startTabDrag` for drag-to-edge. The animations and navigation teams are likely to touch the same function, so expect a small merge there.

**Tests added**
- `tests/split-view.test.mjs` (16 tests): runs the real `TabManager` against stand-ins for Electron's views.
- `tests/tab-layout.test.mjs` (11 tests): the per-window logic, plus headless Chrome tests of the column, keyboard, drag, flyout, panes, divider, drag-to-edge, permission chip, and light/dark.
- `tests/e2e/layout.e2e.mjs` (4 tests, CI only).

**Risky or left undone**
- Never run in Electron. These rely on behaviour I couldn't check:
  - the page's `focus` event firing when you click into the other side;
  - pointer capture continuing while a tab is dragged over a page;
  - the cursor check that closes the flyout;
  - the Windows caption-button resize and toolbar drag areas.
- On Windows with tabs to the side, the toolbar has little room left to drag the window by. I added a small grip at its start and made the top of the tabs column draggable.
- A window that opens with tabs to the side may show the top strip for a moment until the UI starts, the same way the sidebar does today.
- The zoom badge hides when you switch sides, as it does when you switch tabs.
- I did not update `README.md` or `docs/launch-plan.md`, to avoid conflicts with the other teams.

## power-user — INTERRUPTED by a usage limit (run wf_11dde92d-adc); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_11dde92d-adc); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_11dde92d-adc); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## power-user — INTERRUPTED by a usage limit (run wf_a7c80419-92a); its partial edits are in the working tree. Its last notes:

Now the settings page: remove the autoscroll row and rename the section.
Now fix the name-window answer focus behavior.
Now the preload shim and the IPC.
You've hit your session limit · resets 9:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_a7c80419-92a); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_a7c80419-92a); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)
