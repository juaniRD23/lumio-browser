# Batch 6 (privacy and security): result

## Summary
- The site-controls work was finished by an earlier agent (see EARLIER.md).
- The security code was mostly written in the WIP commit. This run checked that each sub-item is built and wired in, and found nothing missing in the code.
- What was missing: headless UI tests and an e2e suite for the security features, and the skeptical review. Both are done now, and every high and medium finding is fixed.
- `npm test`, root: 232 tests, 227 pass, 0 fail, 5 skipped (the Windows-only tests skip here). At the start it was 212 tests, 207 pass, 5 skipped. That only ran once the Electron binary was installed (`node node_modules/electron/install.js`). Without it, `tests/site-settings.test.mjs` fails because `main/features.js` requires `electron`.
- `npm test`, server/: 38 pass, 0 fail. The server was not touched.
- The e2e tests have NOT been run. They only pass `node --check`, and they run on CI.

## Items
### 1. Security: done (all 9 sub-items built; e2e not run yet)
1. **HTTPS-First:** done. `main/navigation-guard.js` plus the interstitial page. It is off by default. IPs, single-word names, local top-level domains and non-default ports are never upgraded.
2. **Secure DNS:** done. `main/secure-dns.js`: OS default, Cloudflare, Google, Quad9 or a custom address. A custom address is checked before it is saved, and the setting is applied at startup and whenever it changes.
3. **Safe Browsing:** done. `main/safe-browsing.js`.
   - **Lists:** Phishing.Database (MIT) and ShadowWhisperer's malware list (Unlicense). URLhaus and OpenPhish were not used because they need a key or a paid plan for use in a product. The lists are downloaded daily and checked on this computer as hashed prefixes, so no visited URL is ever sent anywhere.
   - **Warnings:** a red "Dangerous site" interstitial, where "visit this unsafe site" is only inside Details. Downloads from listed sites, with double extensions, or over http from an https page wait for Keep or Discard.
   - **Setting:** Standard protection or No protection.
4. **Certificates:** done. Manage certificates opens Keychain Access. The client-certificate chooser lists subject, issuer and valid-until, and remembers the choice per host for the session (`main/certificates.js`, `renderer/ui/overlay-security.*`). It is a separate module from any launch-blockers certificate viewer.
5. **Password Checkup and Safety check:** done. Only the first 5 hex characters of each SHA-1 leave the computer, with padding. It counts compromised, reused and weak passwords and flags each one. Safety check covers updates, passwords, Safe Browsing and extensions, plus unused-permission revocations with an undo.
6. **Lookalike / IDN protection:** done.
   - The omnibox shows punycode for mixed-script and confusable names.
   - A "Did you mean …?" warning covers well-known sites and the sites you visit most.
   - The insecure form warning offers Send anyway or Go back.
7. **Device choosers:** done. USB, HID, serial and Bluetooth get a chooser with Connect and Cancel. File System Access write access asks "Let site edit files?". Read access to a file the person picked is allowed without asking.
8. **Privacy extras:** done.
   - **Ads and trackers:** "Block ads and trackers" is ON by default, using a small built-in list of tracker domains through `webRequest` and no new dependency. The site you're on is never blocked, and a site can be allowed in Site settings. @ghostery/adblocker-electron was not used, so the build doesn't gain a large runtime dependency and filter-list downloads.
   - **GPC:** on by default, sending the header and `navigator.globalPrivacyControl`. Do Not Track is off by default, like Chrome.
   - **WebRTC:** `default_public_interface_only` is on by default.
   - **Unused permissions:** removed after 90 days unless the site was visited, and only for sites with a recorded visit time, so people upgrading don't lose permissions.
9. **Capture indicators:** done. Tabs using the camera, microphone or screen get a red dot, and a "Sharing this tab" bar has Stop sharing. The screen-share picker lists other tabs, with their sound when the site asks. On macOS without the Screen Recording permission, the system picker is used, and it can't share a tab.

### 2. Tests: done (e2e not run yet)
- **Unit:** `tests/security.test.mjs`, which already existed and now has 2 more from the review.
- **Headless UI:** `tests/security-ui.test.mjs`, 18 tests (later 20 counting light/dark variants). It covers the Security and Tracking protection pages, every interstitial kind, Safety check, Check passwords, the device and certificate choosers, risky downloads with Keep/Discard, the screen-share picker's tab and audio options, and the capture bar and recording dot. Each runs in light and dark with contrast checks, keyboard checks and IPC assertions.
- **e2e:** `tests/e2e/security.e2e.mjs`, 20 tests:
  - Safe Browsing ×4: warning plus Back to safety, a new tab, proceeding from Details, No protection
  - HTTPS-First ×4: off by default, upgrades, fallback warning plus Continue, local addresses
  - Lookalikes; IDN display; insecure form
  - Dangerous downloads ×2: misleading name, insecure download
  - Tracking protection; GPC/DNT headers; secure DNS settings; capture indicators
  - Settings › Security; Settings › Tracking protection; Password Checkup with a stubbed fetch
- **How the e2e tests run:** the TLS certificate is generated with openssl into a temp dir at run time and never committed; tests that need it skip without openssl. Host names are `*.lumio-e2e.net`, because `.dev` is on the HSTS preload list.
- **Test-only code added:**
  - `main/security.js` gains a `certificate-error` hook that trusts one certificate by SHA-256 fingerprint. It is active only when both `LUMIO_TEST` and `LUMIO_TEST_TRUST_CERT` are set.
  - `scripts/launch.mjs` gains an `args` option, used for `--use-fake-device-for-media-stream`.
- **Unverified until CI runs the e2e tests:**
  - Electron fires `certificate-error` for the self-signed certificate.
  - A refused connection on an upgraded load (-102) shows the HTTPS-First warning.
  - The fake camera works on macOS CI; the test skips if `getUserMedia` fails.
  - `item.pause()` in `will-download` takes effect before a small download finishes.
  - Chromium's own insecure-form or mixed-download blocking doesn't act before Lumio's warnings.

### 3. Skeptical review: done
| Sev | Where | Finding | Fixed |
|---|---|---|---|
| High | main/ai/tools/browser.js | Lumio AI could read and click a security warning (visit unsafe site / Send anyway / Continue), or open `lumio://interstitial/?…` itself. A prompt injection could get through Safe Browsing this way. | Yes. On a warning page the AI may only navigate away or go back, and `safeUrl` refuses interstitial URLs. A test was added. |
| Medium | main/navigation-guard.js | A stopped HTTPS-First upgrade left a stale entry, so the next http visit warned without trying https. | Yes, with a test |
| Medium | renderer/ui/capture-bar.js | After switching tabs and back, the bar was empty and red, with no Stop button. | Yes, with a test |
| Medium | main/window.js | Another dropdown replacing the screen-share picker left `getDisplayMedia` waiting forever. | Yes |
| Medium (a11y) | renderer/ui/overlay.js | Keep and Discard in the downloads bubble didn't work from the keyboard. | Yes, with a test |
| Low | overlay-security.css, overlay.css | Small text below 4.5:1 contrast on the dark popover. | Yes (now `--muted`) |
| Low | settings-safety.js | Plural wording when only 1 password is compromised. | Yes |
| Low | overlay.js | The screen-share picker didn't report its size. | Yes |
| Low | capture-bar.js | Stop sharing stayed disabled if stopping failed. | Yes (re-enables after 5 s) |
| Low | passwords.js/.css | The Compromised flag reused the "reused" class. | Yes |
| Low | site-settings.css | A select cut off "Block in Incognito (default)". | Yes |
| Low | tabs.js | Interstitial URLs are saved with the session and come back as the rebuilt warning. A form's "Send anyway" then reloads without the form data. | No (harmless; hub file) |
| Low | security.js | `lookalikeData` re-reads the whole history at most once a minute. | No |
| Low | features.js | Risky downloads rely on `pause()` in `will-download` working in time. | No (check on CI) |
| Low | browsing-data / site-data | Deleting all site data clears the whole session, which may include extensions' storage, as the old code did. | No (check in the real app) |
| Low | device-chooser.js | Uses the tab's top-level site, not the embedded frame's. | No (frames need `allow=` anyway) |
| Low | navigation-guard.js | `isUpgrade()` is unused. It is kept as the hook for the launch-blockers certificate interstitial. | No |

Things the review checked and found sound:
- Privileged IPC only answers Lumio's own pages in a tab's top frame.
- The test hooks are gated on `LUMIO_TEST`.
- Password Checkup sends only 5 hex characters.
- Incognito keeps nothing, and its listeners and timers are cleaned up when its windows close.
- No URLs leave the device.
- The AI's waits on navigation are time-bounded, so warning pages and paused downloads can't hang it.
- The permissions migration keeps every value.

Screenshots of every new UI in light and dark were saved to `dist/review-shots/` and checked (dist is not committed).

## Not done / risky
- None of the e2e suites (security, site-controls) have run.
- The riskiest pieces are:
  - Insecure-content tab rebuild, from site controls.
  - HTTPS-First fallback codes.
  - The download pause timing.
- Pop-up blocker integration: the launch-blockers batch must read `profile.permissions.settings.value(origin, 'popups') === 'allow'`.
- External protocol handlers are not listed in Settings yet.
- No new runtime dependencies.

## Merge hints (shared files changed)
- `main/main.js`: Security, SiteControls and BrowsingData set-up, setupScreenShare/shareAnswer (tab sharing), siteInfo, removed old clearData and permission handlers.
- `main/tabs.js`: loadFailed hook, the `shown` lookalike-safe address, capture state.
- `main/window.js`: the `showOverlay` cancel logic, the loadFailed/captureOf hooks.
- `main/features.js`: Permissions rewritten, the Downloads danger gate. The launch-blockers batch likely touches this too.
- `main/ai/tools/browser.js`: `tabFor` and `safeUrl`.
- `main/menu.js`, `main/protocol.js` (SETTINGS_PAGES), `preload/shell.js` (SEND regex), `preload/internal.js`.
- `renderer/ui/shell.{html,js,css}`, `overlay.{html,js,css}`, `renderer/pages/settings.{html,js,css}`, `history.*`, `passwords.*`, `downloads.js`.
- `renderer/assets/theme.css` (new tokens in both palettes), `scripts/launch.mjs` (`args` option).
