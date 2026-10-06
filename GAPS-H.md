# Gaps H: app windows, prompt(), autofill dropdown accessibility, pop-up permission chip

Branch `gaps-h`, from `v0.6.8-next` (376163a). None of the four gaps was already done on that branch: app windows answered `pk:request` with "use the browser's own WebAuthn", their passwords/autofill messages found no tab, `prompt()` returned null, the dropdown had no live announcements, and pop-ups dropped quiet permission requests.

How it was checked:
- `npm test`: 921 tests, 915 pass, 0 fail, 6 skipped. The baseline run had 13 failures, but only because the Electron binary wasn't downloaded yet. With it installed, the baseline passes too.
- The new e2e file `tests/e2e/app-windows.e2e.mjs` (5 tests) ran in real Electron on Linux under Xvfb. All 5 pass with this branch (3 runs). All 5 fail on the `v0.6.8-next` code.
  - Linux here has no keychain, so for these local runs only I launched with `--password-store=basic` and `safeStorage.setUsePlainTextEncryption(true)`. That change was not committed. On the Mac CI, the Keychain does this job.
- Regression runs of existing e2e suites on this branch:
  - Pass: `autofill`, `dialogs`, `site-controls`, `share-media`, `app-windows`.
  - `popups` #11 ("window management asks first") fails, and fails the same way on the base code. It's fixer G's area.
  - `account` #12 fails on Linux only: it expects the platform string `windows` on any non-Mac.
  - All of this still needs a run on the Mac CI.

## 1. Passwords, passkeys and autofill in installed-app windows

**What I built.** An app window (`main/apps.js` `AppWindow`) now acts as a one-page tab holder. It reuses the existing modules rather than copying them:
- **`AppTabs`**: a one-page stand-in for `TabManager`. It has `tabs`, `active`, `activeId`, `wc()`, `byWebContents()`, and borrows `TabManager.prototype.ask/answer/dismiss` for the page's dialog queue.
- **Its own overlay view** (`lumio://overlay/`). It runs the browser window's own overlay code, through a new small module, `main/overlay-host.js` (`lendOverlay` / `wireOverlay`). The passwords dropdown, "Save password?", the passkey prompt, the address/card dropdown and "Save address/card?" all look and work as in a tab.
- **Profile**: `profile` is the profile the app was installed from, through a new `profile(id)` option that `main.js` passes as `appProfile`. This is the same profile whose session the site already used.
- **`main.js` lookups**:
  - New `pageOfWc(wc) = tabOfWc(wc) || apps.holderOf(wc)`. The page lookups use it: `PasswordManager` and `AutofillManager` `findTab`, their page-message routing, `js-dialog`, and HTTP sign-in (`app.on('login')`).
  - `tabOfWc` itself is unchanged, so share, security, `internalHandle` and the rest never see app windows.
  - The old `orElse` that sent app windows to native WebAuthn is gone.
- **What the app window's own UI may call.** The title bar, overlay and dialog view reach `main.js`'s `on`/`handle` through `apps.uiOwner(wc, channel)`, and only for the channels in `UI_CHANNELS`:
  - `overlay:show/hide/size/pick`
  - `passwords:fill/decide/passkey/reveal-pending/manage`
  - `autofill:pick/remove/manage/decide`
  - Every other browser call is still refused for app windows, and the site itself can never be a UI owner.
- **Title bar** (`renderer/ui/app-window.*`):
  - A key button (`aria-label` "Save password") that opens the same `pwsave` bubble, and brings it back after it's closed.
  - A `role=status` toast ("Password saved", "Card saved").
  - Colours use theme tokens and are checked in light and dark.
- **Closing the window or leaving the page**: a pending passkey request, `prompt()` or dropdown gets "no", and the dropdown closes on resize.

**Tests.**
- `tests/app-window-sites.test.mjs` (new). It uses the real `PasswordManager`, `AutofillManager`, page-dialogs, dialog view and `BrowserWin` overlay code, with a stand-in Electron. It checks:
  - Profile routing, including old apps with no profile.
  - The `uiOwner` channel allowlist.
  - Passwords are offered and filled only from the app's profile. Another profile's entry id is refused, and no password reaches the overlay.
  - "Save password?" goes to the title bar and saves into the app's profile.
  - Passkey creation is refused when Touch ID (`LUMIO_TEST_AUTH`) says no, and works when it says yes, into the right profile. Closing the window cancels a waiting request.
  - The address dropdown and filling.
  - A dropdown asked for before the overlay loads is shown again once it has loaded.
- `tests/page-tools-ui.test.mjs`: the title bar's key, bubble, keyboard and toast, in light and dark.
- `tests/e2e/app-windows.e2e.mjs` (CI): passwords dropdown and fill, "Save password?" and save, passkey create and sign-in (platform attachment), address dropdown and fill.

**Risks.**
- **Touch ID / user verification**: the code paths are unchanged (`authorize`, `verifyPerson`, `AutofillManager.verify`). Their system dialogs now attach to the app window.
- **Wrong profile in a browser window**: "Manage passwords…" and "Manage addresses…" from an app window open lumio://passwords or settings in the front browser window. That window may belong to another profile, which then shows its own data, not the app's. Nothing leaks, but it can be the wrong profile.
- **Permission prompts unchanged**: site permission prompts in app windows still use the existing native message box.
- **Cost**: each app window now creates an overlay view up front, which is one more renderer while it's open. The dialog view is created only when a dialog first shows.

## 2. `prompt()` in app windows

**What I built.** `alert()`, `confirm()` and `prompt()` in an app window now all go through `main/page-dialogs.js` `jsDialog` and `main/dialog-view.js`, the same as tabs and pop-ups. You get Lumio's card over the app's page, titled "<site> says", with a text field for `prompt()` and "Don't allow … to show more dialogs" from the second dialog in a row.
- The old native `showMessageBox` branch is removed, so `alert()`/`confirm()` match tabs too.
- A navigation, a crashed page or closing the window answers the dialog as cancelled.
- HTTP sign-in (Basic/Digest) in app windows now gets the same "Sign in to access this site" card instead of being cancelled.

**Tests.** `tests/app-window-sites.test.mjs` covers prompt with default text, OK and Cancel, confirm, the block-more checkbox, navigation dismissal and window close. The e2e test covers prompt and confirm in real Electron.

**Risks.**
- The card covers the page view only. The app's title bar (Back, Reload) stays usable, as in a tab, and either one dismisses the dialog.
- `dialogInProcess` doesn't count app windows. That only affects the "Page unresponsive" heuristic.

## 3. Autofill dropdown accessibility

**What I built** (`renderer/ui/overlay-autofill.js`, `.css`).
- **Roles**: the list is `role=listbox`, with `aria-activedescendant` pointing at the highlighted option. Options have ids and `aria-posinset`/`aria-setsize`.
- **Announcements**: a polite, atomic live region (`#ff-live`) sits outside the redrawn card. It says, as the dropdown opens or what it offers changes: "Saved addresses, 2. Use the arrow keys to choose and Enter to fill."
  - As the arrows move, it reads the item and its position: "Visa •••• 4242, Sam Tester, 1 of 2". The saved text is marked `translate="no"`.
  - The same highlight isn't read twice.
- **Keyboard**: unchanged. Arrows, Enter and Esc stay in the field (`preload/autofill.js`), and the mouse still keeps the focus in the page.
- **Why not `aria-expanded`/`aria-controls`/`aria-activedescendant` on the field**: the comment in the file explains it. Chromium can't link nodes across views, and Lumio doesn't write into the site's own fields.
- **Spanish** added in `es.js` and checked in `tests/i18n-js.test.mjs`.

**Tests.** `tests/autofill-ui.test.mjs` covers roles, ids, active option, live text on open, on arrow moves, no repeats, a changed list, the untranslated span, the hidden region and mouse behaviour. The e2e test checks the live region in a real app window.

**Risks.** How promptly VoiceOver reads a live region in a view without focus can vary by macOS version. It needs a manual check on a Mac.

## 4. Permission chip in pop-up windows

**What I built.**
- **The chip**: the pop-up's bar has the browser window's chip (`renderer/ui/permission-chip.js`, with new `accept` and `anchor` options; the defaults leave the browser window as it was). It sits in the address box and takes quiet requests (notifications, by default) and "… blocked" notices. Its bubble ("Allow for this site" / "Continue blocking") opens under the address box. It works from the keyboard and has a polite live region.
- **The permission bar**: requests that ask still use the existing bar over the page, so the existing pop-up tests are unchanged.
- **Pop-up dropdowns were broken**: `PopupWin` borrowed only `showOverlay`/`hideOverlay` and never set `overlaySeq`/`overlayIn`. Its dropdowns (site info, Save password, blocked pop-ups) could never come in, and `hideOverlay` would throw (`overlayClosed` missing). It now uses `overlay-host.js` like app windows.
- **A page that asks as it opens**: the pop-up's bar now holds its messages (permission questions, Save password, toasts) until it has loaded. Before, a page asking right away was never shown, in the existing bar too. This was found by the new e2e test.

**Tests.**
- `tests/popup-ui.test.mjs` (light and dark): the quiet chip and its contrast, the keyboard order (lock, chip, address), the bubble payload and position, answered or cancelled requests, loud requests still in the bar, and blocked or reset notices.
- e2e: a pop-up's `Notification.requestPermission()` shows the quiet chip; its bubble (drawn by the pop-up's own overlay) allows it, and the choice is remembered for the site.

**Risks.**
- Fixer G is working on `popups.e2e.mjs`. I didn't edit it: my e2e is in the new `tests/e2e/app-windows.e2e.mjs`.
- `main/popup-window.js` changed in three small places: the overlay wiring, the bar queue and `lendOverlay`. If G touches the same lines, the merge should be easy to resolve.

## Files
- **New**:
  - `main/overlay-host.js`
  - `tests/app-window-sites.test.mjs`
  - `tests/e2e/app-windows.e2e.mjs`
  - `GAPS-H.md`
- **Changed**:
  - `main/apps.js`
  - `main/main.js` (lookups and routing only)
  - `main/popup-window.js`
  - `renderer/ui/app-window.{html,css,js}`
  - `renderer/ui/popup.{html,js}`
  - `renderer/ui/permission-chip.js`
  - `renderer/ui/overlay-autofill.{js,css}`
  - `renderer/ui/overlay.js` (one line)
  - `renderer/assets/i18n/es.js`
  - `docs/launch-plan.md`
  - tests: `autofill-ui`, `popup-ui`, `page-tools-ui`, `i18n-js`
