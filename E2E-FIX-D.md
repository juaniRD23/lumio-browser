# E2E fix D: crash-reports minidump upload

Branch `e2e-fix-d`, from `merge-v0.6.8` (0f9f5d3). CI run 37404928404.

## Failing test

`tests/e2e/crash-reports.e2e.mjs`: "a crash of the main process uploads a minidump with Lumio's annotations". It failed with `AssertionError: Crashpad uploaded the dump` (actual `undefined`) after 45 s.

## Cause: the test's mock server (the product code works)

Crashpad adds the client's identity to the submit URL. `identify_client_via_url` is on by default, and Electron doesn't turn it off. So the minidump is posted to

```
/api/crash?product=Electron&version=43.7.7&guid=<install id>
```

and not to a bare `/api/crash`. The mock server in the test only matched `req.url === '/api/crash'`. The upload therefore fell through to the HTML "Statement for Sam Rivera" page the mock serves for every other URL, with a `200`. Crashpad took that `200` as a successful upload, recorded it, and logged nothing. The test kept waiting for a `dump` entry that never came.

The CI log supports this:
- Crashpad got as far as building the upload: `minidump_to_upload_parameters.cc:67 duplicate annotation name platform` appears about 0.3 s after `process.crash()`. That function only runs inside `UploadReport`, after the uploads-enabled and rate-limit checks.
- After that there is no Crashpad error. A refused connection, a non-200 status or an App Transport Security block would have logged one. Crashpad's 60 s upload timeout is longer than the test's 45 s, but nothing in the mock could have stalled the request: a parse error would also have shown up as an unhandled rejection in the test runner, and none did.
- The JSON reports passed because `main/crash-reports.js` posts them with `fetch` to the bare `/api/crash`.

I checked the real Worker. `server/src/index.ts` routes on `url.pathname`, so it already accepts Crashpad's URL. This is not a product bug.

## Fix

- **`tests/e2e/crash-reports.e2e.mjs`**:
  - The mock matches on the path (`new URL(req.url, base).pathname`), like the Worker does.
  - If a body can't be parsed, the mock records it as `unreadable` and answers `400`. Before, the request would hang until Crashpad's 60 s timeout.
  - The "Crashpad uploaded the dump" message now lists everything that did arrive (kind, URL, process, error), so a future failure says why.
  - A new check: the query Crashpad adds carries only `product`, `version` and `guid`, never page data.
  - Every other assertion is unchanged. The test still checks for a real `MDMP` from the browser process, with Lumio's annotations.
- **`server/test/crash.test.mjs`**: Crashpad uploads in the server tests now go to `/api/crash?product=Electron&version=43.7.7&guid=…`, like real ones. The existing check that the guid is never stored now also covers the URL copy.

To check the parsing, I sent a Crashpad-style upload (gzipped, chunked, `---MultipartBoundary-…---` boundary, query string) to the fixed mock under Node. It parsed into the expected fields and an `MDMP` dump. The old `req.url === '/api/crash'` check returned false for that same request.

## Checks

- `cd server && npm test`: 71/71 pass.
- `npm test`: 896 pass, 1 fail. The failure is a different headless UI test on each run (`page-tools-ui` media popover, `status bubble`, …). The untouched base also fails one per run, and the failing test passes when re-run on its own (`node --test --test-name-pattern="media popover" tests/page-tools-ui.test.mjs`). The crash unit tests (`tests/crash-reports.test.mjs`, `server/test/crash.test.mjs`) all pass, 43/43.
- I couldn't run the e2e test here because there is no Mac.

**Confidence: high.** The path mismatch is certain and it explains the silent "success". If anything else turns up on the Mac, the new assertion message will name it. The likeliest candidate is the dump's `process_type` field, which Electron sets to `browser` for the main process.

Notes for the owner (no change made):
- The `duplicate annotation name platform` warning is harmless. Electron sets its own `platform` key, so Lumio's identical `globalExtra.platform` is discarded. The server reads either one.
- Because of `identify_client_via_url`, the install guid travels in the request URL to `/api/crash`. The Worker never stores it, but any request logging (Cloudflare logs) would capture it. Electron offers no switch to turn this off.

## Home test (navigation.e2e.mjs, fixer B's file, not edited)

**Verdict: Home is not a cascade of the mouse back-button failure, and it is not a Home bug either.** Both tests failed at a screenshot, not at a behavior check:

- Back button: line 158, `await shot('nav-02-swipe-arrow')`.
- Home: line 234, `await shot('nav-04-home')`.

In both, `global.lumio.snapshot()` (`main/main.js`) failed in `webContents.capturePage()` with `UnknownVizError`, meaning Viz had no frame to copy.

- In the Home test, every Home assertion passed before the shot: hidden by default, shown when turned on, and a click opens the chosen page. The shot comes right after `global.lumio.cmd.home()`, which starts another load of the same page, so the tab's view is mid-navigation when it's captured.
- In the swipe test, the shot comes right after the new swipe-arrow `WebContentsView` became visible, before its page has painted.
- The back-button failure left the swipe arrow on screen, and the Home failure left the Home button on. Both are visible in `nav-03-clear-data.png` and `nav-05-zoom-bubble.png`. But those screenshots, taken before and after Home with the stuck arrow still visible, succeeded. So the leftover state didn't cause Home's error.

Suggested fix for fixer B:
- In the Home test, wait for the load that `cmd.home()` starts to finish (`!wc.isLoading()`, title `Page my-home`) before `shot()`.
- In the swipe test, wait a frame or two after the arrow shows.
- Or make the test-only `snapshot()` retry `capturePage()` once after a short wait on `UnknownVizError`.
- Also, put each test's cleanup in `try/finally`, so a failed shot doesn't leave the arrow or the Home button for later tests.

## Files

- `tests/e2e/crash-reports.e2e.mjs`
- `server/test/crash.test.mjs`
- `E2E-FIX-D.md`
