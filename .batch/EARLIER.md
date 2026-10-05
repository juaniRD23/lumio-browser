# Earlier work in this batch (b7c)
# Earlier work in batch b7c (rebuilt from logs)

## autofill-passkeys — FINISHED (run wf_8d6875f8-d47)

I built all five items: addresses, payment cards, form history, sync for addresses and cards, and passkey sync plus security keys. `npm test` passes (180 tests: 177 pass, 3 Windows-only skipped; baseline was 154). `npm test` in `server/` passes 38/38. The new e2e file is written but not run here, per the rules.

**Per item**
1. **Address autofill: done.**
   - Settings has new Addresses and Payment methods sections after "Passwords and autofill", with add, edit and delete.
   - Address fields are recognized from autocomplete attributes first, then names, ids, placeholders and labels, in English and Spanish.
   - Lumio's dropdown under the field works with the mouse and with ↑/↓, Enter and Esc. Enter picks the item instead of sending the form.
   - Only visible fields are filled, so a hidden "trap" field never gets the address, and text the person already typed is kept.
   - A "Save address?" or "Update address?" bubble appears after a form is sent. It takes keyboard focus, and "Never for this site" can be undone in Settings.
   - Addresses are stored encrypted with safeStorage.
2. **Payment methods: done.**
   - The card number is encrypted on its own. The CVC is never read, sent or stored, and after a fill the cursor goes to the empty CVC field.
   - Cards only work on secure pages (https or localhost).
   - Filling a card, or showing its number in Settings, asks every time: the existing Mac helper (Touch ID or Mac password), then `systemPreferences.promptTouchID` if the helper is missing, then Windows Hello, then a confirm dialog.
   - Lumio offers to save a card after checkout.
   - Keeping card numbers away from the AI:
     - the AI's page snapshot shows card fields only as "(filled)";
     - AI tab screenshots show those fields as dots;
     - card suggestions don't appear while the AI is running.
3. **Form history: done.** Entries are remembered per field name and encrypted. Shift+Delete or the ✕ removes one, and there's a Settings switch and a Clear button. It is never used in Incognito, sign-in forms, search boxes, or fields with sensitive names or values.
4. **Sync: done.** Addresses sync. Cards sync end-to-end encrypted but are off until the person turns them on in Settings › Sync.
5. **Passkeys: done.**
   - Lumio's own passkeys now sync end-to-end encrypted. New ones are marked as syncable to sites.
   - Passkeys made before this change must stay on their computer, because that marking can't change after creation. The Passwords page labels them "this computer only".
   - **Security keys:** Electron 43.7.7 includes Chromium's own WebAuthn with USB key support. Lumio now hands requests that ask for a security key back to that browser WebAuthn, adds a "Use a security key" choice in the passkey prompt, and shows a "touch your key" note on Mac with Cancel. Windows shows its own dialog.

**Files**
- New:
  - `main/autofill.js`, `main/autofill-store.js`
  - `preload/autofill.js` (registered as a session preload)
  - `renderer/ui/overlay-autofill.{js,css}`
  - `renderer/pages/settings-autofill.js`, `renderer/pages/autofill.css`
- Hub edits, kept small:
  - `main/main.js`: about 20 lines of wiring
  - `renderer/pages/settings.html`: sections, nav links, form-history rows
  - `renderer/pages/settings.js`: one line (new sync types)
  - `renderer/ui/overlay.js`: dispatch to the new module, and the passkey prompt's security-key choices
  - `renderer/ui/overlay.html`: one stylesheet link
  - `preload/shell.js`: allows the `autofill:` channel
- Other edits:
  - `main/passkeys.js`, `main/password-manager.js`, `preload/internal.js`
  - `main/sync/adapters.js`, `main/sync/engine.js`
  - `main/ai/tools/page-scripts.js`, `main/ai/tools/browser.js`
  - `server/src/sync.ts`
  - `renderer/pages/passwords.{html,js}`: passkey wording and the "this computer only" label
  - `README.md`

**Tests added**
- `tests/autofill-store.test.mjs`
- `tests/autofill-page.test.mjs`
- `tests/autofill-manager.test.mjs`
- `tests/autofill-ui.test.mjs`
- `tests/autofill-sync.test.mjs` (two computers syncing through the real server code)
- `tests/ai-cards.test.mjs`
- New tests in `tests/passkeys.test.mjs`
- `tests/e2e/autofill.e2e.mjs`, using Chromium's virtual USB security key, CI only
- Fixtures: `tests/fixtures/address.html`, `checkout.html`, `security-key.html`
- Updated the expected passkey flag value (`0x45` → `0x4d`) in `tests/passkeys.test.mjs` and `tests/e2e/account.e2e.mjs`

**Risks and things left undone**
- **Deploy the server before releasing this browser build.** The current live server rejects the new sync collections (passkeys, addresses, cards), which would make the whole sync upload fail for everyone.
- **Security keys are untested on a real app.** They are covered only by the e2e test on CI. A key that needs a PIN may fail on Mac, because Electron offers no PIN prompt. NFC doesn't work on Mac, and signing in with a phone (QR) isn't available.
- **Card fields inside payment iframes** (for example Stripe's) can't be filled or saved; autofill only reaches fields on the page itself.
- **Mac full-screen screenshots** taken by the AI's computer control could still show card digits if they're on screen. Only tab snapshots and tab screenshots are masked.
- **The save bubble can be lost.** It isn't shown again after a tab switch, and it's skipped if a password-save or passkey question is already showing.
- I didn't add form entries to the "Delete browsing data" dialog, because that's the privacy team's area.
- I didn't tick the matching items in `docs/launch-plan.md` (lines 124 and 268–271), to avoid merge conflicts with other teams.

## extensions-help-mac — INTERRUPTED by a usage limit (run wf_8d6875f8-d47); its partial edits are in the working tree. Its last notes:

Now the shell's toolbar module.
Now the overlay module for the puzzle menu and the new-tab prompt.
Now the server router changes.
You've hit your session limit · resets 4:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_8d6875f8-d47); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_8d6875f8-d47); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## extensions-help-mac — INTERRUPTED by a usage limit (run wf_09c26ce0-75f); its partial edits are in the working tree. Its last notes:

Now update shell.css, shell.html and shell.js to use the new pinned-only bar.
Now the headless UI test file for the new extension, help, version and flags UI.
You've hit your session limit · resets 9:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_09c26ce0-75f); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_09c26ce0-75f); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)
