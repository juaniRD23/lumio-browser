# Earlier work in this batch (b7b)
# Earlier work in batch b7b (rebuilt from logs)

## translate-read — FINISHED (run wf_c17c8bde-c8b)

Translate pages and reading mode both work, and Live Caption is skipped. Root `npm test`: 185 tests, 182 pass, 0 fail, 3 skipped (Windows-only). `npm test` in `server/`: 43 pass, 0 fail. The server type-check (`tsc`) is clean. I didn't launch the app or run e2e. Nothing is committed.

**1. Translate pages: done**
- **Detection:** a small local detector (`main/translate-detect.js`) guesses the language from a sample of the page text, by writing system first and then by common short words. `<html lang>` is the fallback, and the text wins when the two disagree. The user's languages come from the system's preferred languages.
- **Button and bubble:** a translate button in the address bar. The bubble asks "Translate this page?" with Not now and Translate, then shows progress, Show original and Try again. It has a "Translate to" list and three checkboxes: Always translate <lang>, Never translate <lang>, Never translate this site.
  - The bubble opens by itself once per page, and stops opening itself after 3 "Not now"s for a language (the button stays).
  - If you're signed out it says "Sign in to translate".
  - Clicking the page closes it.
  - It works with the keyboard: Esc, arrows, Enter.
- **Other ways in:** View › Translate Page… and the page right-click menu (Translate to <lang> / Show Original).
- **In the page:** text nodes are swapped in place, so links, inputs and markup stay untouched. Code, inputs, `translate="no"` and `.notranslate` are never sent. Translation follows scrolling and new content, Show original restores everything, and translating again is instant.
  - Each page load is capped at 200,000 characters, so an endless feed can't drain the allowance.
- **Server:** new `POST /v1/translate` in `server/src/translate.ts`.
  - It takes up to 100 blocks / 12,000 characters per batch and uses numbered lines, with a guard against instructions hidden in page text.
  - Each batch is charged through `reserve`/`settle` (new step kind `translate`, also shown on the admin spend page) and limited to 40 batches a minute.
  - Model: Ling 3.0 Flash, the cheapest on output tokens, which is most of the cost here. GPT-6 Luna takes over if Ling is down, and holds are sized at the pricier rate.
- **Incognito:** Always translate never applies, the site checkbox is hidden, and nothing is translated without a click.

**2. Reading mode: done**
- **Extraction:** Mozilla Readability (the library behind Firefox Reader View), added as `@mozilla/readability`, Apache-2.0, no dependencies of its own. Extracting articles has endless edge cases, so I chose the proven library over a custom extractor.
  - It runs in an isolated world on a copy of the page, so the page isn't changed. The result is sanitized to plain article markup in the window's UI.
- **The view:** settings for font (sans/serif), size, spacing, and theme (Auto follows Lumio, Light, Dark, Sepia). Sepia has new tokens for light and dark in `renderer/assets/theme.css`, and choices are saved in `settings.reader`.
- **Read aloud:** uses Lumio's existing voice (`ai:voice-speak`) in pieces of a few whole sentences each. The current sentence is highlighted and scrolled into view. There's play/pause, previous/next sentence, a speed list from 0.75× to 2×, and clicking a sentence while reading jumps there.
- **Opening it:** a book button in the address bar (shown when the page looks like an article), the right-click item "Open in Reading Mode", and View › Reading Mode.
- **Side panel:** `createReaderView()` is self-contained, so the organizing team's side panel can host it later. For now it has its own column to the right of the page.

**3. Live Caption: skipped**, as asked (post-launch).

**Files**
- New: `main/translate.js`, `main/translate-detect.js`, `main/translate-page.js`, `main/reader.js`, `renderer/ui/translate.js`, `renderer/ui/translate.css`, `renderer/ui/overlay-translate.js`, `renderer/ui/overlay-translate.css`, `renderer/ui/reading-mode.js`, `renderer/ui/reading-mode.css`, `server/src/translate.ts`
- Small edits: `main/main.js`, `main/tabs.js` (2 lines), `main/menu.js` (2 items), `preload/shell.js`, `renderer/ui/shell.js`, `renderer/ui/shell.html` (2 stylesheet links), `renderer/ui/overlay.js`, `renderer/ui/overlay.css`, `renderer/assets/theme.css`, `server/src/index.ts`, `server/src/models.ts`, `server/src/usage.ts`, `server/src/spend.ts`, `server/schema.sql` (comment only), `website/public/admin.js`, `package.json`, `package-lock.json`, `README.md`, `tests/mock-lumio.mjs`, `server/test/api.test.mjs` (one assertion)

**Tests added**
- `tests/translate-detect.test.mjs`, `tests/translate-page.test.mjs`, `tests/translate-main.test.mjs`, `tests/translate-ui.test.mjs`, `tests/reading-mode.test.mjs`, `tests/reader-extract.test.mjs`
- `server/test/translate.test.mjs`
- `tests/e2e/page-tools.e2e.mjs` with fixture `tests/fixtures/article-fr.html`, for CI only.

**Risky or left undone**
- **Not run here:** the e2e file.
- **Merge risk:** the new dependency will conflict in `package-lock.json` if other branches add dependencies; re-running `npm install` fixes it.
- **English voice only:** the server only allows English voices, so non-English articles are read with an English voice.
- **Not synced:** translate and reading settings (`settings.translate`, `settings.reader`) aren't synced and have no Settings page yet.
- **Not translated:** page titles (so history keeps the original), attributes like placeholder and alt, and content inside shadow DOM.
- **Mouse listener on every tab:** each tab has a listener for page mouse events, used only to close the bubble when you click the page.

## media-share — INTERRUPTED by a usage limit (run wf_c17c8bde-c8b); its partial edits are in the working tree. Its last notes:

Now wire these into overlay.js and overlay.css.
Now the app launchers module (pure helpers for icons and OS launchers).
Now the app window's title bar UI.
You've hit your session limit · resets 4:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_c17c8bde-c8b); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_c17c8bde-c8b); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## media-share — INTERRUPTED by a usage limit (run wf_d8305c62-b5e); its partial edits are in the working tree. Its last notes:

Now let me write the lumio://apps page.
Now the UI test file.
You've hit your session limit · resets 9:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_d8305c62-b5e); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_d8305c62-b5e); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)
