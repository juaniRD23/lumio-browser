# Protected content (DRM)

Netflix, Spotify, Disney+, Prime Video and similar sites only play in a browser that has Google's **Widevine** module. Stock Electron doesn't have it. Lumio can be built with **castlabs' Electron for Content Security (ECS)** instead: the same Electron, with Widevine support. castlabs publishes an ECS release for each recent Electron version, for example `v43.7.7+wvcus` for Electron 43.7.7.

An ECS app also needs a production **VMP signature**. Without one, most services refuse to play or drop to low resolution. castlabs' free **EVS** service makes that signature during the build.

All of this is **off** until you finish the one-time steps below. Normal builds are unchanged, and `package.json` keeps stock Electron. DRM builds are Mac only, like Lumio while Windows is paused.

## One-time steps for the owner

1. **Install the EVS client** (Python 3.7 or newer):
   ```sh
   python3 -m pip install --upgrade castlabs-evs
   ```
   If pip refuses with "externally-managed-environment" (Homebrew Python), use a virtual environment instead:
   ```sh
   python3 -m venv ~/.evs
   ~/.evs/bin/python -m pip install --upgrade castlabs-evs
   ```
   Then put `export EVS_PYTHON=~/.evs/bin/python` in your shell profile, so builds use that Python. In the commands below, use `~/.evs/bin/python` in place of `python3`.

2. **Create a free EVS account.** The command asks for your email, name, organization (`Lumio`), an account name and a password, then emails you a confirmation code to type in:
   ```sh
   python3 -m castlabs_evs.account signup
   ```
   Make only one account. If you get locked out, use `python3 -m castlabs_evs.account reset` instead of signing up again.

3. **Log in on this Mac.** You only need this for DRM builds on this Mac. The sign-in lasts about a month; after that, run it again:
   ```sh
   python3 -m castlabs_evs.account reauth
   ```

4. **Add two repository secrets on GitHub:** Settings › Secrets and variables › Actions › New repository secret.
   - `EVS_ACCOUNT_NAME`: the account name from step 2.
   - `EVS_PASSWORD`: its password.

   Never put these in the repo, in `.env` files or in workflow files. The workflows read them only from the secrets.

5. **Make a test build:** Actions › Release Lumio Browser › Run workflow, with **Test build** checked.
   - The build log should say `DRM build (LUMIO_DRM=1): castlabs Electron 43.7.7+wvcus` and `VMP signing … with castlabs EVS`.
   - Download the run's artifact, open the Apple Silicon DMG, and copy **Lumio Browser.app** into a new, empty folder, for example `~/Desktop/drm-test`. Then check its signature:
     ```sh
     python3 -m castlabs_evs.vmp verify-pkg --name-hint "Lumio Browser" ~/Desktop/drm-test
     ```
     It should say the signature is valid. "Valid for development only" means the production signing didn't happen.
   - Open that copy of Lumio. The first launch downloads Widevine, so it may show "Getting protected content ready…" for a few seconds.
   - Go to https://castlabs.github.io/wv-vmp-lab/, leave the backend on UAT and click **Load Content**. The log should say `PLATFORM_SOFTWARE_VERIFIED` or better.
   - Then play something on Netflix or Spotify.

After that, every release and every Lumio Beta is a DRM build. To pause DRM builds without deleting the secrets, add a repository **variable** (not a secret) named `LUMIO_DRM`, set to `0`.

## How the build switch works

`build/drm.mjs` decides, and `tests/drm.test.mjs` checks it.

- **When it's a DRM build:** when `LUMIO_DRM=1`, or on CI when both EVS sign-in variables are set. `LUMIO_DRM=0` always turns it off. Anything else is a normal build, exactly as before.
- **Which Electron:** the castlabs release that matches `devDependencies.electron`. Today that's `https://github.com/castlabs/electron-releases#v43.7.7+wvcus`. ECS isn't on npm, so castlabs' instructions install it from that GitHub address. castlabs releases about once a month. When it has no build of the exact version, Lumio uses castlabs' newest stable release of the same major.
  - `build/package.mjs` installs it into `node_modules` with `npm install --no-save`, so `package.json` and `package-lock.json` don't change. `npm ci` puts stock Electron back.
  - Worktrees whose `node_modules` links to the main checkout share that Electron.
- **Safety checks:**
  - A DRM build with stock Electron, or another major, in `node_modules` stops with an error. It can never ship without Widevine.
  - A normal build with castlabs' Electron left in `node_modules` packages stock Electron anyway.
  - A DRM build that would also package Windows (`--release` without `--mac`) stops before it installs anything.
- **Packaging:**
  - `@electron/packager` downloads castlabs' zips from their GitHub releases and checks them against castlabs' `checksums.json`.
  - It skips writing the asar integrity digest into Electron Framework. EVS signs castlabs' binaries only as castlabs built them. Electron runs fine without the digest, which only matters with the asar-integrity fuse, and Lumio doesn't turn that fuse on.
- **VMP signing:** `python3 -m castlabs_evs.vmp sign-pkg --name-hint "<app>" <folder>` signs the folder that holds the `.app`.
  - It makes a streaming signature, the right kind for ECS 42 and later.
  - On the Mac, VMP signing must come **before** code signing, which seals it in (castlabs' rule). The order is: VMP sign, then Developer ID sign (or ad hoc), then notarize and staple, then the DMG.
- **No extra entitlements:**
  - Google signs the Widevine module, and macOS only loads a library signed by another team where library validation is off.
  - Chromium loads Widevine in Electron's Plugin helper. `@electron/osx-sign` signs that helper with Chromium's plugin entitlements, which turn library validation off, like Chrome.
  - castlabs' FAQ suggests turning library validation off for the whole app. Lumio keeps it on for the app itself, which is safer.
  - If Widevine ever fails to load on a signed build, Console shows "different Team IDs". That entitlement is the place to look.
- **Workflows:** `release.yml` (the Mac job) and `beta.yml` set `HAS_EVS` from the secrets and the `LUMIO_DRM` variable. Only when it's true do they:
  1. install Python and the EVS client;
  2. sign in with `castlabs_evs.account --no-ask reauth`, passing `EVS_ACCOUNT_NAME` and `EVS_PASSWD` (the names EVS reads) to that one step only;
  3. set `LUMIO_DRM=1` for the build;
  4. sign out (`deauth`) at the end, even when the build fails.

Useful commands:

```sh
node build/drm.mjs --status               # what a build here would do
node build/drm.mjs --install-electron     # swap in castlabs' Electron (then: npm start)
LUMIO_DRM=1 npm run build:app             # a DRM build of this Mac's app (asks for the EVS password if the sign-in expired)
npm ci                                    # back to stock Electron
```

## In the app

`main/drm.js` only does something on castlabs' Electron, which has the `components` API. On stock Electron, Lumio starts exactly as before and Settings doesn't change.

- **At launch:** it calls `components.whenReady([WIDEVINE_CDM_ID])` as soon as the app is ready, while extensions and the rest of start-up load. The first window waits for it.
  - Widevine is downloaded from Google on the first launch. It isn't bundled, because castlabs and Google don't allow that. Later launches are ready at once, and updates happen in the background.
  - If it takes more than a second, a small "Getting protected content ready…" window shows (`renderer/ui/drm-wait.html`). **Open now**, Enter or Esc skips the wait.
  - Lumio never waits more than 15 seconds. If Widevine fails, for example when offline, Lumio opens anyway and logs why. ECS tries again on the next launch.
- **Settings › Privacy and security** gets a **Protected content IDs** card under Site settings, on DRM builds only (`renderer/pages/protected-content.js`). It says sites can play protected content and whether Widevine is ready: "Getting ready…", "Ready · Widevine 4.10…" or "Couldn't get it ready…".
- **The permission:** "Protected content IDs" is Electron's `mediaKeySystem` permission, handled with the other site permissions in `main/features.js`. Widevine on the Mac plays without it.
- **Tests:** e2e tests run stock Electron. `LUMIO_TEST_DRM_MS` stands in for castlabs' API there (`tests/e2e/drm.e2e.mjs`).

## Good to know

- **Electron upgrades:** when you bump `electron` in `package.json`, run `node build/drm.mjs --status` to see whether castlabs has a matching release. castlabs aims to support the three newest stable majors, like Electron.
- **Crash reports from DRM builds:** symbolize their minidumps with castlabs' symbols, not Electron's. They're in the castlabs release: `electron-v<version>+wvcus-darwin-<arch>-symbols.zip`.
- **Windows (paused):** when Windows builds come back, two things change:
  - VMP signing must come **after** Authenticode signing on Windows, before the zip, the setup program and the Store package.
  - castlabs doesn't recommend ECS inside the Microsoft Store package. Widevine may not work in the MSIX.
- **Universal Mac apps:** Lumio builds separate Apple Silicon and Intel apps, so castlabs' universal-binary workaround isn't needed.
- **No credentials in the repo:** only you and the GitHub secret know the EVS password. The EVS client keeps only its sign-in tokens, in your home folder on this Mac.
