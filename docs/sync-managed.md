# Managed Lumio Sync: the build contract

Status: contract for four parallel builders (server, mac, ios, web). Date: 2026-10-08. Branch `accounts`, worktree `/Users/juan/Developer/lumio-accounts`.

What changes: by default, signing in is enough to sync, as with Chrome. The record format, encryption, HMAC record ids, collections and adapters stay exactly as they are. Only the way a device gets the account's 32-byte sync key changes.

Everything below is normative. If something here is ambiguous, do the simplest thing that keeps all four sides compatible, and note it in your report. Do not change this file. The orchestrator owns it.

Revised after review (same date): §13 lists the changes; the sections below already include them.

---

## 0. Terms

| Term | Meaning |
|---|---|
| **sync key** | 32 random bytes, the same format as today (`main/sync/crypto.js` `newKey()`). On the wire it is standard base64 with padding: 44 characters, `^[A-Za-z0-9+/]{43}=$`. |
| **key check** | `deriveKeys(raw).check`: 32 lowercase hex characters. HKDF-SHA256 with salt `lumio-sync-v1` and info `ids` gives an HMAC-SHA256 key; the check is `HMAC("lumio-sync-check")` as hex, first 32 characters. It is stored in `sync_meta.key_check`. |
| **mode** | The account's choice, stored on the server: `managed` (the default) or `passphrase`. |
| **managed** | The server keeps the sync key wrapped with `SYNC_MASTER_KEY` and gives it to any device with a valid session. |
| **passphrase** | The behavior that exists today. The key never leaves the devices. New devices join through ECDH pairing with a 6-digit code, or with the 52-character recovery key. The UI label is "Encrypt with my own passphrase". There is no typed passphrase: the secret is the recovery key (see §11). |
| **managedAvailable** | The server has a valid `SYNC_MASTER_KEY`. |
| **flow** (client-side) | `managed` when `mode === 'managed' && managedAvailable === true`. Otherwise `e2ee`, which runs today's code path unchanged. An old server sends neither field, so the flow is `e2ee`. |
| **managedKey** | The server holds a wrapped key whose check equals `sync_meta.key_check`. |
| **waiting** | Flow `managed`, the server has a `keyCheck`, and there is no managed key yet. This is an E2EE account that hasn't been migrated (§5). |

Wherever the server stores an owner, it is `users.id`, as in the other sync tables.

---

## 1. Who owns which files

| Builder | Owns (may edit) | Must not edit |
|---|---|---|
| **server** | `server/**`, including `src/sync.ts`, the new `src/sync-keys.ts`, `src/index.ts`, `src/account.ts`, `src/util.ts`, `schema.sql`, `migrations/2026-10-08-sync-keys.sql`, `scripts/setup.mjs`, `wrangler.jsonc` comments, `test/**`. Also `docs/**` except this file. | anything outside `server/` and `docs/` |
| **mac** | `main/**` (including `main/sync/crypto.js`, but only its header comment, §8.1), `renderer/**`, `preload/**`, and the root `tests/**` that exercise those: `sync-engine`, `sync-integration`, `autofill-sync`, `companion-tabs`, `sync-crypto`, `i18n`, `i18n-js`, `page-tools-main`, and the settings-stub tests | `server/`, `ios/`, `website/`, `tests/companion.test.mjs`, `tests/website-domain.test.mjs` |
| **ios** | `ios/**` | everything else |
| **web** | `website/public/**` (including `sync-crypto.js`, but only its header comment, §8.1), `tests/companion.test.mjs`, `tests/website-domain.test.mjs` | `main/`, `server/`, `ios/` |

### Rules for every builder

- This Mac crashes under load.
  - Never run Electron, e2e tests, simulators or `xcodebuild` unless your step says so.
  - `tests/companion.test.mjs` launches headless Chrome. Only run it if your step says so.
- Never deploy, never run wrangler against production, and never push.
- No real secrets anywhere. Tests use random fakes, for example `SYNC_MASTER_KEY: crypto.randomBytes(32).toString('base64')`.
- The mac and web tests that import `server/src/index.ts` exercise the server builder's code. Write them against this contract. They are expected to pass only once the server work is merged.
- Any test env without `SYNC_MASTER_KEY` behaves like today (flow `e2ee`). Existing tests that use `env = { DB }` must keep passing unchanged.

---

## 2. Server

### 2.1 Secret, Env, setup

**`src/util.ts` `Env`**

Add the following after `CONNECTIONS_KEY`:
```ts
SYNC_MASTER_KEY?: string; // base64 of 32 random bytes: wraps each managed account's sync key (sync-keys.ts). Never replace it.
```

**`wrangler.jsonc`**

Add `SYNC_MASTER_KEY` to the secrets list in the header comment, after `CODE_KEY`.

**`scripts/setup.mjs`**

1. Change the header line "It also creates the key that encrypts connected apps' tokens (once)." to:
   > It also creates, once each, the keys that encrypt connected apps' tokens, key the email codes, wrap Lumio Sync's keys, and sign phone notifications.

2. Add this block right after the `CODE_KEY` block:
   ```js
   // Lumio Sync keeps each account's sync key wrapped (AES-GCM) with this key,
   // so signing in is enough to sync (docs/sync-managed.md). Made once, here;
   // never shown. Never replace it: every managed account's key would become
   // unreadable (devices that still have it upload it again; the others wait).
   // Only made when the secret list was read, so a failed list can't replace it.
   if (listed && !existing.includes('"SYNC_MASTER_KEY"')) {
     await putSecret('SYNC_MASTER_KEY', crypto.randomBytes(32).toString('base64'));
     console.log('  ✓ Sync master key created');
   } else if (!listed) console.log('  ! Couldn’t list secrets: run setup again to create SYNC_MASTER_KEY');
   ```
   - `listed` is a new boolean. Set it to `true` inside the existing `try` that runs `wrangler secret list`, after the call succeeds.
   - Don't change the behavior of the other secrets.

**Master key loading** (`src/sync-keys.ts`)
- Decode `env.SYNC_MASTER_KEY` with `atob`, inside a `try`.
- If the result is not exactly 32 bytes, managed sync is unavailable.
- Import the key with `crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt','decrypt'])`.
- `managedAvailable(env): boolean` is true only when the key is present and decodes to 32 bytes.

### 2.2 D1: migration and schema

**New file `server/migrations/2026-10-08-sync-keys.sql`** (exactly this content):
```sql
-- 2026-10-08: managed Lumio Sync (docs/sync-managed.md). Same as schema.sql.
-- Run once:  npx wrangler d1 execute lumio --remote --file migrations/2026-10-08-sync-keys.sql
CREATE TABLE IF NOT EXISTS sync_keys (
  owner TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'managed',
  wrapped TEXT,
  key_check TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_key_events (
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_key_events_owner ON sync_key_events (owner, kind, created_at);
CREATE INDEX IF NOT EXISTS sync_key_events_ip ON sync_key_events (ip_hash, kind, created_at);
```
- Comments must not contain `;`, because `schema.test.mjs` splits statements on it.

**`server/schema.sql`**
- Add the same two tables and two indexes right after `CREATE INDEX IF NOT EXISTS sync_pairings_owner …`, with these column comments:
  ```sql
  -- Each account's sync mode and, in managed mode, its sync key wrapped with
  -- SYNC_MASTER_KEY (src/sync-keys.ts, docs/sync-managed.md). No row: managed.
  CREATE TABLE IF NOT EXISTS sync_keys (
    owner TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'managed',  -- managed | passphrase (kept by DELETE /api/sync and reset)
    wrapped TEXT,                          -- 'v1.<b64 iv>.<b64 ct>', AES-256-GCM, AAD 'lumio-sync-key|v1|<owner>'; NULL in passphrase mode, after a reset or delete, or while waiting for migration
    key_check TEXT,                        -- the wrapped key's check (equals sync_meta.key_check when usable)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- Key reads and changes, for their rate limits (kept an hour).
  CREATE TABLE IF NOT EXISTS sync_key_events (
    owner TEXT NOT NULL,
    kind TEXT NOT NULL,                    -- 'read' (key handed out, including auto-approved pairings) | 'write' (upload, mode change, reset)
    ip_hash TEXT NOT NULL,                 -- first 32 hex of SHA-256 of 'lumio-sync|' + ipKey(cf-connecting-ip)
    created_at INTEGER NOT NULL
  );
  ```
  followed by the two indexes.
- Rewrite the comment above `sync_meta` to say:
  > Lumio Sync: records encrypted on the devices with the account's sync key (the server stores ciphertext, opaque ids and collection names). In managed mode, sync_keys also holds that key, wrapped.

**Notes**
- There is no backfill: an account with no `sync_keys` row is in managed mode.
- `schema.test.mjs` checks the migration automatically.

### 2.3 Wrapping

All of this lives in the new file `src/sync-keys.ts`. Export these functions so the tests can use them:

```ts
export function managedAvailable(env: Env): boolean;
export async function keyCheckOf(raw: Uint8Array): Promise<string>;                               // 32 hex chars
export async function wrapKey(env: Env, owner: string, raw: Uint8Array): Promise<string>;         // 'v1.<iv>.<ct>'
export async function unwrapKey(env: Env, owner: string, wrapped: string): Promise<Uint8Array | null>; // null on any failure, never throws
```

**Wrapping parameters**
- **Algorithm:** AES-256-GCM. The key is `SYNC_MASTER_KEY`, the IV is 12 random bytes, and the tag is 128 bits.
- **Plaintext:** the 32 raw bytes, so the ciphertext is 48 bytes.
- **AAD:** the UTF-8 bytes of `lumio-sync-key|v1|<owner>`, where `<owner>` is `users.id`. A wrapped key copied into another account's row fails to unwrap.
- **Stored format:** `v1.` + base64(iv) + `.` + base64(ciphertext||tag), using standard base64 with padding. `v1` is the key id.
- **Future rotation (not built now):**
  - A `SYNC_MASTER_KEY_V2` would write `v2.` with AAD `…|v2|<owner>`.
  - On read, the prefix selects the master key, and a `v1` value would be re-wrapped lazily.
  - Today, unwrap accepts only `v1` and returns `null` for anything else.

**Check:** `keyCheckOf` is a WebCrypto port of `crypto.js` `deriveKeys().check`. It uses HKDF-SHA256 with salt `lumio-sync-v1` and info `ids`, derives a 256-bit HMAC-SHA256 key, signs `lumio-sync-check`, and takes the first 32 characters of the lowercase hex.

**Comparisons:** compare checks with `timingSafeEqual(te.encode(a), te.encode(b))` from `util.ts`.

**Known-answer vectors.** These were computed with today's `main/sync/crypto.js` and must pass in `server/test`:

| | |
|---|---|
| raw key | bytes `0x00..0x1f`, base64 `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=` |
| `keyCheckOf(raw)` | `31421cbcf18c4ec0d1bce11b8b47c85d` |
| `SYNC_MASTER_KEY` | `ERERERERERERERERERERERERERERERERERERERERERE=` (32 × 0x11) |
| owner | `u_test` |
| wrapped, with IV fixed at 12 × 0x22 | `v1.IiIiIiIiIiIiIiIi.F/YFSsTKmVjtNtQ3RKvn2g+C3/F+lLpcSlYQ8xX8exydM6BaDQftu9b2aEvGSP9E` |

- `unwrapKey(env, 'u_test', <that>)` returns the raw key.
- `unwrapKey(env, 'u_other', <that>)` returns `null`.

### 2.4 Request guard for key endpoints

The key endpoints are `POST /api/sync/key`, `PUT /api/sync/key`, `PUT /api/sync/mode` and `POST /api/sync/reset`. All of them are non-GET, so `index.ts`'s Origin check already applies. In addition, `keyGuard(request)` runs first:

- **Bearer request** (the `Authorization: Bearer …` header is present): no further checks. These are the apps.
- **Cookie request:** all of the following must hold, or the endpoint answers 403 `forbidden` "Not allowed.":
  - The `Origin` header is present and equal to `new URL(request.url).origin`.
  - The header `X-Lumio-Sync: 1` is present. A custom header forces a CORS preflight, and no route answers preflights.
  - `Sec-Fetch-Site`, if present, is `same-origin`.
- Every response from these endpoints goes through `json()`, so it carries `cache-control: no-store`. Never add CORS headers.

### 2.5 Rate limits

Use the table `sync_key_events`. Record each event first, then count, so parallel requests see each other. This is the same pattern as `email-auth.ts` `attempt()`.

| kind | counted on | per account / hour | per `ip_hash` / hour |
|---|---|---|---|
| `read` | every `POST /api/sync/key` call, every key a reset hands back, and every pairing auto-approved (§2.7) | 30 | 120 |
| `write` | `PUT /api/sync/key`, `PUT /api/sync/mode`, `POST /api/sync/reset` | 10 | 30 |

- **`ip_hash`:** `(await sha256('lumio-sync|' + ipKey(request.headers.get('cf-connecting-ip')))).slice(0, 32)`, with `ipKey` from `crashes.ts`.
- **Over the limit:** answer 429 `rate_limited` "Too many requests. Try again in a few minutes." with the header `retry-after: 600`. For an auto-approval, leave the pairing `pending` instead.
- **Refused requests aren't counted:** an event over the limit is deleted again, so a device that keeps asking while refused can't keep the limit from ending (it ends an hour after the last request that was served). A reset records a `write` and a `read`; when either is over the limit, neither is kept.
- **Cleanup:** `syncCleanup` (the 5-minute cron) adds `DELETE FROM sync_key_events WHERE created_at < ?1`, bound to `now - 3600_000`.
- **Reset and DELETE** do not clear these rows, so a reset can't be used to get around the limit.

### 2.6 Endpoints

All endpoints require a signed-in user; otherwise the existing 401 `sign_in_required` applies. Bodies are JSON. Error bodies use the existing shape `{ error, code }`.

**Writing the new routes**
- Add them in `routeFor`, next to the sync routes.
- Update the route doc block in `index.ts` to:
  ```
  //   GET|DELETE /api/sync, POST /api/sync/init, POST /api/sync/devices, DELETE /api/sync/devices/:id,
  //   GET  /api/sync/changes, POST /api/sync/push, GET|POST /api/sync/pair, GET|POST /api/sync/pair/:id,
  //   POST|PUT /api/sync/key, PUT /api/sync/mode, POST /api/sync/reset   (Lumio Sync; docs/sync-managed.md)
  ```

**Key material handling**
- Key material appears only in request and response bodies, never in a URL, a log or an error message.
- Wrap all WebCrypto work in `try`, and map failures to the fixed errors below. Otherwise the catch-all at `index.ts` logs `err.stack`.
- The only allowed log line is `console.error('lumio sync key: unwrap failed')`, with no arguments.

#### `GET /api/sync` (changed)

Add three fields. Everything else stays as it is.

```jsonc
{
  "keyCheck": "…|null", "since": 0, "devices": [], "usage": {}, "collections": [],   // unchanged
  "mode": "managed",            // "managed" | "passphrase" (no sync_keys row → "managed")
  "managedKey": false,          // sync_keys.wrapped IS NOT NULL AND sync_keys.key_check = sync_meta.key_check
  "managedAvailable": true      // managedAvailable(env)
}
```

`managedKey` is computed from the database. It does not try to unwrap, so it is cheap.

#### `POST /api/sync/key`: get, or create, the account's key

- **Body:** `{}`. Any body is ignored.
- **Order:** guard (§2.4), then the read rate limit, then the steps below.
- If `!managedAvailable`, answer 503 `sync_keys_unavailable` "Lumio Sync can’t hand out keys right now. Try again later."

**Algorithm**

1. Read `row = sync_keys(owner)` and `meta = sync_meta(owner)`.
2. If `row.mode === 'passphrase'`, answer 409 `passphrase_mode` "This account encrypts sync with its own passphrase. Approve this device from another one, or use the recovery key."
3. If `meta` is set, `row.wrapped` is set and `row.key_check === meta.key_check`:
   - Call `unwrapKey`.
   - **If it fails:** run `UPDATE sync_keys SET wrapped = NULL, key_check = NULL, updated_at = ?now WHERE owner = ?1 AND wrapped = ?old`, log the one allowed line, and continue to step 4.
   - **If it succeeds:** check that `keyCheckOf(raw)` equals `meta.key_check` in constant time. If they differ, treat it as a failure: null the row as above and continue to step 4. If they match, answer 200 `{ "status": "ready", "key": "<b64>", "keyCheck": "<meta.key_check>", "created": false }`.
4. If `meta` exists (with no usable wrapped key), answer 200 `{ "status": "waiting", "keyCheck": "<meta.key_check>" }`.
5. No `meta`: this is a fresh account, or one after a reset or delete.
   - Generate `raw` (`crypto.getRandomValues(new Uint8Array(32))`), then `check` and `wrapped`.
   - Run one `env.DB.batch`:
     ```sql
     INSERT OR IGNORE INTO sync_meta (owner, key_check, created_at) VALUES (?1, ?2, ?3);
     INSERT INTO sync_keys (owner, mode, wrapped, key_check, created_at, updated_at)
       SELECT ?1, 'managed', ?4, ?2, ?3, ?3 WHERE (SELECT key_check FROM sync_meta WHERE owner = ?1) = ?2
       ON CONFLICT(owner) DO UPDATE SET wrapped = excluded.wrapped, key_check = excluded.key_check, updated_at = excluded.updated_at
       WHERE sync_keys.mode = 'managed';
     ```
   - Re-read both rows.
     - If `sync_meta.key_check === check` and `sync_keys.key_check === check`, answer 200 `{ "status": "ready", "key": "<b64 raw>", "keyCheck": check, "created": true }`.
     - Otherwise another request won the race: an older client's `/api/sync/init`, a parallel read, or a mode switch. Go back to step 1, once only. If the second pass also falls through to step 5, answer `waiting` with the current `meta.key_check`.

**Errors:** 401, 403 `forbidden`, 409 `passphrase_mode`, 429 `rate_limited`, 503 `sync_keys_unavailable`.

#### `PUT /api/sync/key`: upload an existing key (migration and repair)

- **Body:** `{ "key": "<b64, 32 bytes>" }`.
- **Order:** guard, then the write rate limit, then `managedAvailable` (503 otherwise).
- **Responses:**
  - The key isn't a string matching `^[A-Za-z0-9+/]{43}=$`, or doesn't decode to 32 bytes: 400 `invalid_request` "Invalid key."
  - `row.mode === 'passphrase'`: 409 `passphrase_mode`. Never wrap a key in passphrase mode.
  - No `meta`: 409 `sync_not_set_up` "Set up sync first." Clients use `POST /api/sync/key` in that case.
  - `keyCheckOf(key)` differs from `meta.key_check` (constant-time compare): 409 `key_mismatch` "That key isn’t this account’s sync key."
  - A usable wrapped key with the same check already exists: 200 `{ "ok": true, "keyCheck": … }`. Don't rewrite it.
  - Otherwise, wrap the key and run:
    ```sql
    INSERT INTO sync_keys (owner, mode, wrapped, key_check, created_at, updated_at) VALUES (?1, 'managed', ?2, ?3, ?4, ?4)
    ON CONFLICT(owner) DO UPDATE SET wrapped = excluded.wrapped, key_check = excluded.key_check, updated_at = excluded.updated_at
    WHERE sync_keys.mode = 'managed'
    ```
    Then answer 200 `{ "ok": true, "keyCheck": "<check>" }`.

#### `PUT /api/sync/mode`: switch modes

- **Order:** guard, then the write rate limit.
- **Body, one of:**
  - `{ "mode": "passphrase", "keyCheck": "<32 hex: the check of a NEW key the device just made>" }`
  - `{ "mode": "managed", "key": "<b64: this device's current key>" }`
- Any other `mode`, or a malformed field: 400 `invalid_request`.

**To `passphrase`**
- If it is already passphrase: 409 `already_passphrase` "This account already encrypts sync with its own passphrase."
- Otherwise run one batch, which works without the master key:
  ```sql
  DELETE FROM sync_items WHERE owner = ?1;
  DELETE FROM sync_meta WHERE owner = ?1;
  DELETE FROM sync_pairings WHERE owner = ?1;
  DELETE FROM companion_messages WHERE owner = ?1;
  UPDATE sync_devices SET status = NULL, status_at = NULL WHERE owner = ?1;   -- companion status sealed with the old key
  INSERT INTO sync_meta (owner, key_check, created_at) VALUES (?1, ?2, ?3);
  INSERT INTO sync_keys (owner, mode, wrapped, key_check, created_at, updated_at) VALUES (?1, 'passphrase', NULL, NULL, ?3, ?3)
    ON CONFLICT(owner) DO UPDATE SET mode = 'passphrase', wrapped = NULL, key_check = NULL, updated_at = excluded.updated_at;
  ```
  - Devices and push subscriptions are kept.
  - Answer 200 `{ "ok": true, "mode": "passphrase", "keyCheck": "<new check>" }`.

  The server's old wrapped key is gone, and everything it could decrypt is deleted. The switching device re-uploads everything under the new key. Other devices must then be approved or use the recovery key, as today.

**To `managed`**
- Needs `managedAvailable`, otherwise 503.
- If it is already managed: 409 `already_managed` "Lumio already keeps this account’s sync key."
- Validate the key as for upload.
- If there is no `meta`: 409 `sync_not_set_up` "Set up sync first." A session alone (for example after `DELETE /api/sync`) can't make a key of its own the account's and Lumio's; the device sets sync up first (`POST /api/sync/init`), then switches.
- `keyCheckOf(key)` must equal `meta.key_check` (constant time), otherwise 409 `key_mismatch`.
- Then wrap and upsert `mode = 'managed', wrapped, key_check`, only while `sync_meta.key_check` is still that check (`INSERT … SELECT … WHERE (SELECT key_check FROM sync_meta WHERE owner = ?1) = ?check ON CONFLICT …`; no row changed: 409 `key_mismatch`).
- Answer 200 `{ "ok": true, "mode": "managed", "keyCheck": "<check>" }`.

#### `POST /api/sync/reset`: managed "Reset sync"

- **Body:** `{ "confirm": true }`, otherwise 400 `confirm_required` "Confirm that you want to reset sync."
- **Order:** guard, then the write rate limit, then `managedAvailable` (503 otherwise).
- If the mode is passphrase: 409 `passphrase_mode`. Passphrase accounts use `DELETE /api/sync`.
- Run one batch:
  ```sql
  DELETE FROM sync_items WHERE owner = ?1;
  DELETE FROM sync_meta WHERE owner = ?1;
  DELETE FROM sync_pairings WHERE owner = ?1;
  DELETE FROM companion_messages WHERE owner = ?1;
  UPDATE sync_devices SET status = NULL, status_at = NULL WHERE owner = ?1;
  UPDATE sync_keys SET wrapped = NULL, key_check = NULL, updated_at = ?2 WHERE owner = ?1;
  ```
  Devices (their rows and `last_seen`) and push subscriptions are kept.
- Then run the get-or-create from `POST /api/sync/key`, steps 1 to 5. Count it as one `read` event as well, and return its answer, normally `{ "status": "ready", "key", "keyCheck", "created": true }`.

#### `DELETE /api/sync` (changed: "Delete synced data", and older clients)

Same as today, plus `UPDATE sync_keys SET wrapped = NULL, key_check = NULL, updated_at = ?2 WHERE owner = ?1` in the same batch.
- The mode is kept, so a passphrase account stays passphrase.
- In managed mode, the next `POST /api/sync/key` creates a fresh key.

#### `GET /api/sync/pair/:id` (changed: managed auto-approval)

This keeps older builds working (the v0.6.7 Mac and the current App Store iOS app) with no approval.

The server auto-approves a pairing when all of these hold:
- The pairing is `pending` and not expired.
- The account is in managed mode.
- `managedAvailable` is true.
- A usable wrapped key exists, meaning step 3 of `POST /api/sync/key` succeeds.
- The read rate limit allows it. The approval records a `read` event.

To approve, the server wraps the raw key for the request's `pubkey` exactly as `crypto.js` `wrapForDevice` does:
1. Make an ephemeral ECDH P-256 key pair.
2. Import the requester's raw public key (65 bytes).
3. `deriveBits` 256.
4. Use HKDF-SHA256 with salt `lumio-pair-v1` and info `wrap` to get an AES-GCM-256 key.
5. Encrypt the raw key with a random 12-byte IV and no AAD.
6. `wrapped = b64(iv || ct)` and `approverPub = b64(raw public key)`.

Then run `UPDATE sync_pairings SET status = 'done', wrapped = NULL WHERE owner = ?1 AND id = ?2 AND status = 'pending'`.
- If no row changed, answer from the re-read row, as today.
- Otherwise answer `{ "status": "approved", "approverPub", "wrapped" }`.

If the import fails (a bad pubkey), leave the pairing `pending`. Nothing else about this route changes.

#### `GET /api/sync/pair?device=` (changed)

In managed mode with `managedAvailable` and a usable wrapped key, answer `{ "requests": [] }`, because the server handles those requests itself. Otherwise the route behaves as today, so older devices that have the key can still approve while migration is pending, and in passphrase mode.

#### `POST /api/sync/push` and `PUT /api/companion/status` (changed: optional `keyCheck`)

- Newer devices send `keyCheck`, the check of the key they sealed with (32 lowercase hex; anything else is 400 `invalid_request`).
- Push: the records are written only while `sync_meta.key_check` equals it, in the same transaction (`INSERT OR REPLACE … SELECT … WHERE (SELECT key_check FROM sync_meta WHERE owner = ?1) = ?9`). No row written: 409 `key_mismatch` "This account’s sync key changed." So a device whose run began before a reset or a switch to passphrase can't leave records only the old key opens.
- Companion status: the same condition on the `UPDATE`; a registered device whose key isn't the account's gets 409 `key_mismatch` (an unknown device still gets 409 `unknown_device`).
- Without `keyCheck` (older devices), both behave as before.
- Clients: on 409 `key_mismatch` from push, stop pushing and run again soon; the next run gets the new key, then uploads everything with it.

#### Unchanged

`POST /api/sync/init`, `POST /api/sync/pair`, `POST /api/sync/pair/:id`, devices, changes, and the other companion and push routes.
- `syncPush` still requires a `sync_meta` row.
- `POST /api/sync/init` stays for the `e2ee` flow and older clients.

### 2.7 Account deletion and cleanup

- In `account.ts`, add both of these to the batch, next to the other sync deletes:
  - `DELETE FROM sync_keys WHERE owner = ?1`
  - `DELETE FROM sync_key_events WHERE owner = ?1`
- Update the header comment to read "…Lumio Sync's encrypted records, its wrapped sync key, devices and pairings…".
- `syncCleanup`: delete `sync_key_events` rows older than one hour (§2.5).

### 2.8 Comments to rewrite

- `sync.ts:1-11`. The new header comment is:
  > Sync: devices store encrypted records here (…the same list…). Records are encrypted on the devices with the account's sync key; the server sees ciphertext, opaque ids and collection names. How devices get the key depends on the account's mode (sync-keys.ts, docs/sync-managed.md). In managed mode (the default), the server keeps the key wrapped with SYNC_MASTER_KEY and hands it to the account's signed-in devices. In passphrase mode, it never sees the key: a new device posts its public key, and a device that has the key approves it (after the person checks that the codes match) and posts the key wrapped for it.
- The `syncInit` 409 message stays as it is.
- `index.ts` route block (§2.6). `schema.sql` comments (§2.2). `account.ts` header (§2.7).

### 2.9 Server tests (`server/test/api.test.mjs` and a new `server/test/sync-keys.test.mjs`)

**Setup**
- Add `SYNC_MASTER_KEY: Buffer.from(crypto.randomBytes(32)).toString('base64')` to `beforeEach`'s env.
- Update the first sync test's `cleared` deepEqual to expect `mode: 'managed', managedKey: false, managedAvailable: true`.
- Add `['sync_keys','owner']` and `['sync_key_events','owner']` to the account-deletion table list.

**New tests. Each is one assertion group.**
1. The known-answer vectors (§2.3): check, unwrap, and wrong owner gives `null`.
2. A fresh account: `POST /api/sync/key` (bearer) gives `ready` with `created: true`.
   - The key decodes to 32 bytes and `keyCheckOf` equals `keyCheck`.
   - `GET /api/sync` shows that `keyCheck`, `managedKey: true`.
   - A push now succeeds.
3. A second bearer session for the same user gets the same key, with `created: false`.
4. No session gives 401. Another user's session gets its own, different key, never the first user's.
5. AAD: copy user A's `sync_keys.wrapped` and `key_check` into user B's row, and set B's `sync_meta.key_check` to A's check.
   - B's read must not return A's key: it answers `waiting`.
   - B's row ends with `wrapped` NULL.
6. Migration:
   - Init with the check of a known key K; there is no `sync_keys` row.
   - The read answers `waiting` with that `keyCheck`, and `managedKey: false`.
   - `PUT /api/sync/key` with a wrong key gives 409 `key_mismatch`.
   - `PUT /api/sync/key` with K gives 200.
   - The read now answers `ready` with K. Uploading K again gives 200, idempotent.
7. Passphrase:
   - `PUT /api/sync/mode {mode:'passphrase', keyCheck:new}` gives 200.
   - `sync_items`, `sync_pairings` and `companion_messages` are empty. `sync_meta.key_check` is the new check. `wrapped` is NULL. Devices are kept.
   - The read gives 409 `passphrase_mode`, and so does the upload.
   - `GET /api/sync` shows `mode: 'passphrase'`.
   - `DELETE /api/sync` keeps `mode: 'passphrase'`.
   - Repeating the switch gives 409 `already_passphrase`.
8. Back to managed:
   - `PUT /api/sync/mode {mode:'managed', key:wrong}` gives 409 `key_mismatch`.
   - With the right key it gives 200. The read returns that key.
9. Reset:
   - `POST /api/sync/reset` without `confirm` gives 400.
   - With `confirm` it gives a new key and a new `keyCheck`. Old items are gone, and devices are kept.
   - In passphrase mode it gives 409.
10. Auto-approval:
    - In managed mode with a key, `POST /api/sync/pair` with a real ECDH P-256 public key (node webcrypto) leads to `GET /api/sync/pair/:id` answering `approved`.
    - Unwrapping with the test's private key, using the `crypto.js` algorithm, yields the account key. The next check answers `done`.
    - `GET /api/sync/pair?device=` returns `[]`.
    - In passphrase mode the pairing stays `pending`.
11. Rate limit: the 31st read within an hour gives 429 with `retry-after`. The 11th write gives 429.
12. Cookie guard (`cookie` sign-in from `signIn()`):
    - `POST /api/sync/key` with `origin: SITE` and `X-Lumio-Sync: 1` gives 200.
    - Without `X-Lumio-Sync` it gives 403.
    - With `origin: https://evil.test` it gives 403.
    - With no Origin header it gives 403.
    - With `sec-fetch-site: cross-site` it gives 403.
    - `GET /api/sync/key` gives 404.
13. Every key response has `cache-control: no-store`. Spy on `console.error` and `console.log` during tests 2 to 10: none of the calls contain the base64 key.
14. Without `SYNC_MASTER_KEY` in env:
    - `GET /api/sync` shows `managedAvailable: false`.
    - `POST /api/sync/key` gives 503.
    - Today's init and pairing flow is unchanged, and pair requests stay `pending`.
15. Account deletion removes the `sync_keys` and `sync_key_events` rows.

Run them with `cd server && npm test`.

---

## 3. One client algorithm (Mac, iOS and web all implement this)

This replaces only the "get the key" step: `engine.js ensureKey()`, `SyncEngine.swift ensureKey()`, and `companion.js boot()`.

```text
status = GET /api/sync
remember status.mode (default 'managed') and status.managedAvailable (default false); persist them (Mac/iOS state file),
    except: a remembered 'passphrase' is sticky (§3.3): it becomes 'managed' only when Lumio hands back this device's own key
    when status.mode == 'passphrase': remember passphraseCheck = status.keyCheck
flow = (status.managedAvailable === true && status.mode !== 'passphrase') ? 'managed' : 'e2ee'

if flow == 'e2ee':
    today's code, byte for byte (init when no keyCheck; match; else pairing + recovery key)

# flow == 'managed'
load the saved key if none in memory
if have key AND status.keyCheck AND key.check == status.keyCheck:
    if !status.managedKey AND (no upload attempt in the last 10 min):
        try PUT /api/sync/key { key: b64(raw) }        # migration / repair; ignore any error, retry next time
    clear pairing state; return READY
if !status.keyCheck OR status.managedKey:
    r = POST /api/sync/key {}
    if r.status == 'ready':
        raw = b64decode(r.key); require raw.length == 32 AND deriveKeys(raw).check == r.keyCheck (else: sync error, retry next run)
        adoptKey(raw)      # existing function: saves the key, clears pairing, cursor = 0, records = {} (full merge)
        return READY
    if HTTP 409 passphrase_mode: store mode = 'passphrase'; schedule a run in 1 s; return NOT_READY (next run takes the e2ee flow)
    (r.status == 'waiting' falls through)
# waiting: an E2EE account not migrated yet
status = needs-key; keyCheck = status.keyCheck
askForKey()   # today's pairing request (so an older device can approve) + recovery key still accepted;
              # once a key exists, the server auto-approves the pending request, or the next run's POST /api/sync/key gets it
return NOT_READY
```

**Further rules**

- **Pair requests from other devices.** In flow `managed`, do not fetch or show them:
  - skip `checkRequests()`;
  - no notification;
  - `requests = []`.
  
  The server handles them.
- **Recovery key.** In waiting, entering the recovery key adopts that key. The next run then uploads it, which completes the migration.
- **Errors.**
  - 429 and 503 from the key endpoints are ordinary sync errors. Keep the current status and retry at the next scheduled run. Never retry in a tight loop.
  - After 429 `rate_limited` from a key route, make no `POST /api/sync/key` for `retry-after` seconds (600 when it isn't known): Mac `keyRetryAt`, iOS `keyRetryAt`, web `S.keyRetryAt` (its finishing poll waits that long too). Until then the run ends with the sync error "Too many requests. Try again in a few minutes."
  - 503, or `managedAvailable` turning false, puts the client in flow `e2ee` on its next run.
- **Reads.** `POST /api/sync/key` is called only when `keyCheck` is null or `managedKey` is true. Waiting devices poll the cheap `GET /api/sync`.
- **Payment methods** (`cards`) stay off by default. Nothing in this change turns them on.

### 3.1 Sign-out

**In flow `managed` only** (the remembered mode is `managed` and the server keeps keys)

An explicit sign-out, or the server ending the session (401, "You were signed out"), removes the key from the device:
- delete the saved secret (Keychain on Mac and iOS, IndexedDB on the web);
- set `raw` and `keys` to null;
- clear the pairing and the requests;
- set the cursor to 0 and the records to `{}`;
- set the status to signed-out.

The next sign-in fetches the key again and merges.

**Pitfall**
- Never clear the key just because a run sees "not signed in" or "no account info yet".
- The Mac's `account.info` is null at startup and while offline, and the iOS owner can be nil before the account loads.
- Clear the key only from the explicit sign-out and session-ended hooks below.

**In flow `e2ee`** (mode `passphrase`, or a server without `SYNC_MASTER_KEY`, or an older server): keep the key on sign-out. This is today's behavior: no other copy may exist, and otherwise every sign-in would need approval again. A sign-out that arrives before the first `GET /api/sync` after an update or account switch keeps the key too; the next managed run checks it against `keyCheck`.

### 3.2 Reset, delete, and switching modes (client side)

| Action | Who offers it | Call | Then |
|---|---|---|---|
| **Reset sync** | flow `managed`: Mac and iOS | `POST /api/sync/reset {confirm:true}` | `adoptKey(returned key)`, keep sync on, sync in 200 ms. Other devices see the new `keyCheck` with `managedKey: true`, fetch the key, `adoptKey` it and re-upload what they have. |
| **Delete synced data** | flow `e2ee`: Mac and iOS, unchanged | `DELETE /api/sync` | Today's behavior: forget the key and turn sync off on this device. The mode is kept. |
| **Encrypt with my own passphrase: on** | Mac only, needs status `ready` in flow `managed` | 1. `K2` = the pending key `syncKey:<owner>:pending` if one is saved (a retry), else `newKey()`, saved there before the request. 2. `PUT /api/sync/mode {mode:'passphrase', keyCheck: check(K2)}`. 3. Require `reply.keyCheck === check(K2)`. 4. `adoptKey(K2)`, which saves it and does a full re-upload, then remove the pending key. 5. Remember `mode = 'passphrase'`. A 4xx reply other than `already_passphrase` removes the pending key; a lost reply keeps it. `already_passphrase`: read `GET /api/sync`; if its `keyCheck` is `check(K2)`, the earlier attempt went through (continue at 4); if it's this computer's current key, it's already done; otherwise fail with "This account already uses its own passphrase. Approve this computer from a device that has the key, or use your recovery key." In the e2ee branch, before needs-key, a run adopts the pending key when its check is `status.keyCheck`. | Settings opens the recovery key only when the refreshed state is mode `passphrase` and status `ready`. `recoveryKey()` is null while `needs-key` or `error`. The other devices go to needs-key and pairing, as today. |
| **Encrypt with my own passphrase: off** | Mac only, needs status `ready` with the key | `PUT /api/sync/mode {mode:'managed', key: b64(raw)}` | Remember `mode = 'managed'`. The other devices pick up the key on their next run. |

Treat a 409 `already_managed` reply as "refresh the status, then run". No error is shown. (`already_passphrase`: see the table.)

### 3.3 A remembered passphrase is sticky (Mac, iOS, web)

Turning the account's own passphrase off is only taken from a device that has its key. Otherwise a stolen session (`DELETE /api/sync`, `POST /api/sync/init` with a key of its own, `PUT /api/sync/mode managed`) or a changed database (`sync_keys` row dropped or set to managed) would make every passphrase device hand its key to Lumio, or adopt the attacker's key and re-upload everything with it.

- `passphraseCheck`: the account's key check as last seen while the server said `mode: 'passphrase'` (Mac `sync-state.json`, iOS `SyncStateFile.passphraseCheck`, web IndexedDB `syncPassphraseCheck`).
- When the remembered mode is `passphrase`, the server says `managed`, and this device holds a key whose check is `passphraseCheck`: the device stays `passphrase` (flow `e2ee`) unless Lumio proves it already has that key: `managedAvailable`, `managedKey`, `status.keyCheck === key.check`, and `POST /api/sync/key` returns exactly this device's key (then nothing is left to keep from Lumio; this also holds when the database was changed by hand). Otherwise set `modeChanged` (only when the server explicitly says `managed`).
- While `modeChanged`: never `PUT /api/sync/key`, never adopt a key from `POST /api/sync/key`, never post a pairing request (the server would auto-approve it with its key). If the key matches `status.keyCheck`, sync goes on in the e2ee flow. If it doesn't: Mac and iOS set status `error` with "Paused to keep your sync key private: Lumio’s server says this account no longer uses your own passphrase, and this computer/device didn’t change that."; the web shows "Sync is paused" and keeps the saved key.
- The person can still choose: Mac Settings › Sync › Advanced shows a note and keeps the switch enabled (turning it off is `setMode('managed')`; `already_managed` then just remembers `managed`); iOS shows "Use the Key Lumio Keeps…" (`SyncEngine.useLumiosKey()`); the web shows "Use the key Lumio keeps".
- A device without that key (fresh, or still waiting for the passphrase key) follows the server as before. Not covered (unchanged from before managed sync): in passphrase mode, anyone with the session can answer a pending pairing request with a key of their own.

---

## 4. Old-client compatibility

| Account state → / Client ↓ | Managed with a key on the server | Managed, waiting (E2EE, not migrated) | Passphrase |
|---|---|---|---|
| **Lumio Browser v0.6.7 and the current App Store iOS app** | It sees a `keyCheck` and posts a pair request. The server auto-approves it at the next check, and the app adopts the key. It never sees other devices' requests. | Today's behavior. A device that has the key approves it. After any new client uploads, its pending request is approved automatically. | Today's behavior |
| **New Mac, iOS and web** | Signs in, fetches the key, syncs | Shows "Finishing setup" plus the pairing code and recovery field. Joins as soon as the key exists, or when an old device approves it. | Today's UI |
| **New clients against an old server** (no new fields) | flow `e2ee`: today's behavior | | |

---

## 5. Migrating existing E2EE accounts, step by step

1. **Server ships.**
   - Run the D1 migration, then `setup.mjs`, which creates `SYNC_MASTER_KEY`, then deploy.
   - Every existing account has `sync_meta` and no `sync_keys` row. That means mode `managed`, `managedKey: false`, `managedAvailable: true`.
   - Old clients behave exactly as before.
2. **The first new-version device that already has the key** runs: its key check matches and `managedKey` is false.
   - It sends `PUT /api/sync/key` with its key. The server verifies the key against `sync_meta.key_check` and wraps it.
   - Nothing is re-encrypted, and the records and cursors are untouched.
3. **Every device without the key** (Lumio Beta on the same Mac, a new iPhone build, the web companion):
   - If it's a new-version device, it shows "Finishing setup". On its next run it sees `managedKey: true`, fetches the key, adopts it (cursor 0, a full merge) and syncs.
   - If it's an old-version device with a pending pair request, the server approves the request at its next check.
4. **No new-version device has the key yet.** Example: Lumio Beta (new) is the only updated device, and stable v0.6.7 holds the key.
   - The Beta posts a pair request as well, and stable approves it with the code, as today.
   - The Beta then has the key, uploads it, and the migration is done.
   - The recovery key also works on the Beta.
5. **Passphrase accounts:** never touched.
   - Accounts in passphrase mode (`sync_keys.mode = 'passphrase'`) are never migrated.
   - The server refuses `PUT /api/sync/key` for them.
   - Clients never call `PUT /api/sync/mode {mode:'managed'}` on their own; only the Settings switch does.
   - No account has passphrase mode today, so every existing account migrates. That is the owner's decision.
6. **Repair after `SYNC_MASTER_KEY` is lost or replaced.**
   - Reads fail to unwrap, and the server nulls the wrapped key, so `managedKey` becomes false.
   - Any device that still holds the key uploads it again (step 2). Devices without it wait.

---

## 6. Mac (mac builder)

### 6.1 Engine: `main/sync/engine.js`

**Persistence**
- Store `mode` and `managedAvailable` in `sync-state.json`: `file.data.mode` (default `'managed'`) and `file.data.managedAvailable` (default `false`).
- Update both from every `GET /api/sync`.
- When another account signs in (the existing owner reset in `run()`), reset them to the defaults.

**Shape**
- `get flow()`: `this.file.data.managedAvailable === true && this.file.data.mode !== 'passphrase' ? 'managed' : 'e2ee'`.
- `state()` adds:
  - `flow`
  - `mode` (the remembered value)
  - `managedAvailable`
  
  `requests` is always `[]` in flow `managed`.

**Key handling**
- `ensureKey()` follows §3 exactly. Keep today's code as the `e2ee` branch.
- Keep `this.lastUpload` (a timestamp) to throttle the migration upload to once every 10 minutes after a failure.
- `run()` calls `checkRequests()` only in flow `e2ee`. `onPairRequest` therefore fires only in `e2ee`.

**New methods**
- `async resetSync()`
  - Managed only. Otherwise throw `Error('Reset is for accounts where Lumio keeps the sync key.')`.
  - Calls `POST /api/sync/reset`, verifies, `adoptKey`, `soon(200)`, and returns `{}`.
- `async setMode(mode)`
  - Follows §3.2.
  - If status isn't `ready`, throw `Error('Wait for sync to finish turning on first.')`.
  - Returns `{ mode }`.
- `signedOut()`
  - In flow `managed` only, call `forgetKey()` (§3.1).
  - Then `status = 'signed-out'` and `state()`.
- `forgetKey()`
  - `store.setSecret(secretName(), null)`
  - `raw = keys = pairing = keyCheck = null`
  - `requests = []`
  - `ids.clear()`
  - `file.data.cursor = 0`, `file.data.records = {}`, then save.

`deleteEverything()` is unchanged. `useRecoveryKey()` is unchanged, and it is also allowed while waiting.

**`main/account.js`**
- Add an optional `onSignedOut` constructor option.
- Call it from `signOut()`, after the session secret is cleared.
- Call it from `refresh()`'s "You were signed out" branch, only when a token was present.
- Never call it from the offline or catch path.

**`main/main.js`**
- Pass `onSignedOut: () => profile.sync?.signedOut()` to `LumioAccount` in `openProfile`.
- Add IPC handlers:
  ```js
  internalHandle('page:sync-reset', ['settings'], ({ w }) => syncReply(() => syncOf(w).resetSync()));
  internalHandle('page:sync-set-mode', ['settings'], ({ w }, mode) => syncReply(() => syncOf(w).setMode(mode === 'passphrase' ? 'passphrase' : 'managed')));
  ```
- In the Guest stub `syncOf`, add `resetSync()` and `setMode()`, both throwing the Guest error. Its `state()` adds `flow: 'e2ee'`.
- `page:sync-recovery` is unchanged. Settings shows the recovery key only in flow `e2ee`.

**Comments**
Rewrite the "end-to-end encrypted" wording to "encrypted with the account's sync key (docs/sync-managed.md)" in:
- `main/autofill.js:13`
- `main/passkeys.js:4`
- `main/share.js:5`
- `main/sync/companion.js:2`
- the comment above `new SyncEngine` in `main.js`

### 6.2 Settings › Sync: `renderer/pages/settings.html` and `settings.js`

**Markup changes, inside `#sync`**

1. In `#sync-needs`, replace the single title with:
   ```html
   <div class="title" id="sync-needs-approve">Approve this computer</div>
   <div class="title" id="sync-needs-finish" hidden>Finishing setup</div>
   <div class="desc" id="sync-needs-auto" hidden>Open Lumio on a device that already syncs. If it has the latest version, this computer turns on by itself.</div>
   ```
   The existing approve description, the code and the recovery input stay below it, unchanged.

2. Give the "Recovery key" `<h3>` the id `sync-recovery-h`, and its card the id `sync-recovery-card`. The card keeps both of its rows: Recovery key, and Delete synced data.

3. After that card, add:
   ```html
   <h3 id="sync-advanced-h" hidden>Advanced</h3>
   <div class="card" id="sync-advanced" hidden>
     <label class="row" style="cursor:pointer">
       <div class="grow"><div class="title">Encrypt with my own passphrase</div>
         <div class="desc" id="sync-mode-managed">Lumio keeps a copy of your sync key, so signing in is all a new device needs. Turn this on to keep the key only on your devices: Lumio can’t read what you sync, and new devices need your approval or your recovery key.</div>
         <div class="desc" id="sync-mode-own" hidden>Only your devices have your sync key: Lumio can’t read what you sync. New devices need your approval or your recovery key.</div></div>
       <span class="switch"><input type="checkbox" id="sync-passphrase" aria-label="Encrypt with my own passphrase"><i></i></span>
     </label>
     <div class="row" id="sync-reset-row" hidden>
       <div class="grow"><div class="title">Reset sync</div><div class="desc">Deletes everything synced from Lumio’s servers and starts over with a new key. Your devices that have sync on upload what they have again.</div></div>
       <button class="btn danger" id="sync-reset">Reset</button>
     </div>
   </div>
   ```

**`renderSync(st)` visibility rules.** Let `managed = (st.flow === 'managed')`. A missing `flow` counts as `e2ee`, so the existing test stubs render today's UI.

| Element | Shown when |
|---|---|
| `#sync-requests` content | `!managed`. Render nothing when managed. |
| `#sync-needs` | `st.on && st.status === 'needs-key'` (both flows) |
| `#sync-needs-approve` | `!managed` |
| `#sync-needs-finish`, `#sync-needs-auto` | `managed` |
| `#sync-recovery-h`, `#sync-recovery-card` | `!managed` |
| `#sync-advanced-h`, `#sync-advanced` | `st.managedAvailable === true && st.on && st.status !== 'signed-out'` |
| `#sync-passphrase` | checked when `st.mode === 'passphrase'`; disabled unless `st.status === 'ready'` |
| `#sync-mode-managed` / `#sync-mode-own` | `st.mode !== 'passphrase'` / `st.mode === 'passphrase'` |
| `#sync-reset-row` | `managed` |

**`#sync-status` text**

| State | Text |
|---|---|
| off | `Off. Your bookmarks, passwords and chats stay on this computer.` (unchanged) |
| signed-out | `Sign in to Lumio to sync.` (unchanged) |
| starting | `Turning on…` (unchanged) |
| needs-key, managed | `Finishing setup. Open Lumio on a device that already syncs.` |
| needs-key, e2ee | `Waiting for you to approve this computer.` (unchanged) |
| ready, managed | `Sync is on` + (`lastSync` ? ` · synced ${sinceText(lastSync)}` : ``) |
| ready, e2ee | `On · encrypted on your devices` + synced (unchanged) |
| error | unchanged |

**Handlers**
- **`#sync-passphrase` change**
  - Turning it on: `confirm(PASSPHRASE_ON)`. If the user declines, revert the checkbox. If they confirm, `page.invoke('page:sync-set-mode','passphrase')`. On `ok`, refresh, then click `#sync-recovery-show`, so the new recovery key appears.
  - Turning it off: `confirm(PASSPHRASE_OFF)`, then `page:sync-set-mode` with `'managed'`.
  - On an error: `alert(r.error)` and revert the checkbox.
- **`#sync-reset` click:** `confirm(RESET)`, then `page.invoke('page:sync-reset')`. On an error, `alert`. Then refresh and `loadSyncDevices()`.
- **Device removal:** the confirm text is `REMOVE_MANAGED` when managed, and the existing text otherwise.

**JS strings**
- `PASSPHRASE_ON`: `Encrypt sync with your own key? Lumio deletes its copy of your sync key and starts over with a new key that only your devices have. Your other devices need to be approved again, or set up with your recovery key.`
- `PASSPHRASE_OFF`: `Let Lumio keep a copy of your sync key? Then signing in is all a new device needs, and Lumio could technically read what you sync.`
- `RESET`: `Reset sync? Everything synced is deleted from Lumio’s servers and sync starts over with a new key. What’s on each device stays there.`
- `REMOVE_MANAGED`: `Remove this device from the list? If it’s still signed in to Lumio, it shows up again the next time it syncs. Sign out of Lumio on it to stop it syncing.`

**`renderer/pages/passwords.html:49`.** The note becomes:
> …Showing, copying, editing or exporting them asks you to confirm it’s you. Passkeys sync to your other computers with Lumio Sync, encrypted, and ask for Touch ID or Windows Hello each time a site uses one.

That is, delete "end-to-end".

The sidebar, the "Turn on Sync" Get started item and `preload/` are unchanged.

### 6.3 Spanish: `renderer/assets/i18n/es.js`

Add the new entries next to the existing Sync entries. Translate patterns with `{@when}` as the existing ones do.

| English key | Spanish |
|---|---|
| `Finishing setup` | `Terminando la configuración` |
| `Open Lumio on a device that already syncs. If it has the latest version, this computer turns on by itself.` | `Abre Lumio en un dispositivo que ya sincroniza. Si tiene la versión más reciente, esta computadora se activa sola.` |
| `Finishing setup. Open Lumio on a device that already syncs.` | `Terminando la configuración. Abre Lumio en un dispositivo que ya sincroniza.` |
| `Sync is on` | `La sincronización está activada` |
| `Sync is on · synced {@when}` | `La sincronización está activada · sincronizada {when}` |
| `Encrypt with my own passphrase` | `Cifrar con mi propia frase de contraseña` |
| `Lumio keeps a copy of your sync key, so signing in is all a new device needs. Turn this on to keep the key only on your devices: Lumio can’t read what you sync, and new devices need your approval or your recovery key.` | `Lumio guarda una copia de tu clave de sincronización, así que a un dispositivo nuevo le basta con iniciar sesión. Actívalo para que la clave quede solo en tus dispositivos: Lumio no puede leer lo que sincronizas, y los dispositivos nuevos necesitan tu aprobación o tu clave de recuperación.` |
| `Only your devices have your sync key: Lumio can’t read what you sync. New devices need your approval or your recovery key.` | `Solo tus dispositivos tienen tu clave de sincronización: Lumio no puede leer lo que sincronizas. Los dispositivos nuevos necesitan tu aprobación o tu clave de recuperación.` |
| `Reset sync` | `Restablecer la sincronización` |
| `Deletes everything synced from Lumio’s servers and starts over with a new key. Your devices that have sync on upload what they have again.` | `Borra todo lo sincronizado de los servidores de Lumio y vuelve a empezar con una clave nueva. Tus dispositivos con la sincronización activada vuelven a subir lo que tienen.` |
| `Encrypt sync with your own key? Lumio deletes its copy of your sync key and starts over with a new key that only your devices have. Your other devices need to be approved again, or set up with your recovery key.` | `¿Cifrar la sincronización con tu propia clave? Lumio borra su copia de tu clave de sincronización y vuelve a empezar con una clave nueva que solo tienen tus dispositivos. Vas a tener que aprobar de nuevo tus otros dispositivos, o configurarlos con tu clave de recuperación.` |
| `Let Lumio keep a copy of your sync key? Then signing in is all a new device needs, and Lumio could technically read what you sync.` | `¿Dejar que Lumio guarde una copia de tu clave de sincronización? Así a un dispositivo nuevo le basta con iniciar sesión, y Lumio podría técnicamente leer lo que sincronizas.` |
| `Reset sync? Everything synced is deleted from Lumio’s servers and sync starts over with a new key. What’s on each device stays there.` | `¿Restablecer la sincronización? Se borra todo lo sincronizado de los servidores de Lumio y la sincronización vuelve a empezar con una clave nueva. Lo que hay en cada dispositivo se queda ahí.` |
| `Remove this device from the list? If it’s still signed in to Lumio, it shows up again the next time it syncs. Sign out of Lumio on it to stop it syncing.` | `¿Quitar este dispositivo de la lista? Si todavía tiene la sesión de Lumio iniciada, vuelve a aparecer la próxima vez que sincronice. Cierra la sesión de Lumio en él para que deje de sincronizar.` |
| `Wait for sync to finish turning on first.` (engine) | `Primero espera a que termine de activarse la sincronización.` |
| `Reset is for accounts where Lumio keeps the sync key.` (engine) | `Restablecer es para cuentas en las que Lumio guarda la clave de sincronización.` |

**Changed key.** The passwords note: replace the existing key `'. Showing, copying, editing or exporting them asks you to confirm it’s you. Passkeys sync to your other computers with Lumio Sync, end-to-end encrypted, and ask for Touch ID or Windows Hello each time a site uses one.'` with the same text without "end-to-end". The value becomes:
> `. Para mostrarlas, copiarlas, editarlas o exportarlas, se te pide confirmar que eres tú. Las llaves de acceso se sincronizan con tus otras computadoras con Lumio Sync, cifradas, y piden Touch ID o Windows Hello cada vez que un sitio usa una.`

**Already present:** `Advanced` → `Avanzado`, `Reset` → `Restablecer`.

**`tests/i18n-js.test.mjs` `EXPECTED`:** add `'Sync is on · synced 5 min ago': 'La sincronización está activada · sincronizada hace 5 min'`.

### 6.4 Mac tests

- **`tests/sync-engine.test.mjs`:** the existing tests stay unchanged, with no master key, so they exercise the `e2ee` flow. Add a `describe` block that sets `env.SYNC_MASTER_KEY` to a random value (and deletes it again in `after`, because `env` is shared by the whole file), uses fresh users and sessions, and covers:
  1. Two computers join with no approval, and records cross between them.
  2. **Migration:**
     - Set up A and B with no master key, using pairing.
     - Then set `env.SYNC_MASTER_KEY`. A runs and uploads; `sync_keys.wrapped` is non-null.
     - A fresh computer C joins with no approval and reads A's existing records. No record is re-encrypted: the `sync_items.data` of A's earlier records is unchanged.
  3. **Lumio Beta case:** a waiting computer joins on its own once A uploads.
  4. `signedOut()` removes `syncKey:<email>` in managed mode, but not in passphrase mode. A run while `account.state().signedIn` is false does not remove it.
  5. **`setMode('passphrase')`:**
     - The other computer goes to `needs-key`, and its requests reach the switching computer. Approving it works.
     - `setMode('managed')` lets a third computer join on its own.
  6. **`resetSync()`:** the other computer adopts the new key and re-uploads, and the old records are gone.
  7. In managed mode, `state().requests` is always `[]`.
- **`sync-integration`, `autofill-sync`, `companion-tabs`, `sync-crypto`:** must pass unchanged.
- **The settings-stub tests:** unchanged. A missing `flow` is the `e2ee` UI.

---

## 7. iOS (ios builder)

### 7.1 Engine: `ios/Lumio/Sync/Core/SyncEngine.swift`

**Reply and request types**
- `StatusReply` adds `var mode: String?`, `var managedKey: Bool?` and `var managedAvailable: Bool?`.
- Add `KeyReply { status: String; key: String?; keyCheck: String?; created: Bool? }`. There is no mode reply type: iOS never switches modes.

**State**
- `SyncStateFile` adds `var mode: String?` and `var managedAvailable: Bool?`. They must be Optional so that old files still decode.
- `private(set) var flow: Flow` (`enum Flow { managed, e2ee }`) is computed from the state, as in §0.
- Expose `mode` (`"managed"` or `"passphrase"`) and `managedAvailable` for the views.

**Key handling**
- `ensureKey()` follows §3. Today's code becomes the `e2ee` branch.
- Keep a `lastUpload: Date?` throttle.
- `checkRequests()` runs only in `.e2ee`. In `.managed`, `requests = []`.

**New methods**
- `func resetSync() async -> String?` sends `POST /api/sync/reset {confirm:true}`, verifies, calls `adoptKey`, then `onWantsRun(200ms)`. It returns an error message or `nil`.
- `func signedOut()`
  - In flow `.managed` only, it calls `forgetKey()` (§3.1).
  - Then it sets `status = .signedOut` and clears `pairCode`, `requests` and `devices`.
  - `forgetKey()` stays private.

**Other engine rules**
- No mode switching on iOS: it is Mac only.
- `useRecoveryKey` is unchanged and allowed while waiting.
- `deleteEverything` is unchanged.

**Comments**
- `SyncCrypto.swift:5-6` header becomes:
  > Records are encrypted with the account's sync key. By default Lumio's server keeps a wrapped copy and gives it to signed-in devices; with the owner's passphrase option the key never reaches the server (docs/sync-managed.md).
- `SyncFeature.swift:1`: "encrypted with the account's sync key".
- `SyncContract.swift:1-3`: same rewording. Lines 17-18 become: "…doesn't have the account's sync key yet: in passphrase mode, approve it from another device or enter the recovery key; in managed mode, it's waiting for a device that has the key to update."

### 7.2 Model: `LumioSyncModel.swift`

- Implement `func sessionWillEnd() async { engine.signedOut() }`.
- `sessionDidChange(_:)`: for `.signedOut` and `.expired`, call `engine.signedOut()` and then `soon(...)`. For `.signedIn`, only `soon(...)`, as today.
- `accountWasDeleted` is unchanged.

### 7.3 Views: `SyncViews.swift` (English; iOS has no Spanish catalog)

**`SyncText.status`**

| State | Text |
|---|---|
| managed, ready | `Sync is on · synced \(since(last))`, or `Sync is on` |
| managed, needsKey | `Finishing setup. Open Lumio on a device that already syncs.` |
| e2ee | unchanged |

**`SyncSettingsSection`**
- The "Devices Asking to Sync" section and the "Set Up" badge appear only in `.e2ee`.

**`SyncDetailView`**
- **needsKey:** show `SyncSetupSection` in both flows.
  - In `.managed`, the header is `Finish Setting Up`, and a first line reads `Open Lumio on a device that already syncs. If it has the latest version, this \(SyncText.thisDevice) turns on by itself.`
  - The pair code text and the recovery field follow below that.
- **Types footer:**
  - `.managed`: `Your synced data is encrypted. Lumio keeps a copy of your sync key, so signing in is all a new device needs. Passwords, workflows and projects sync between your Macs only.`
  - `.e2ee`: unchanged.
- **`RecoveryKeySection`:** only `.e2ee`.
- **Danger section, `.managed`:**
  - Button `Reset Sync…` with accessibility identifier `sync.reset`.
  - Footer: `Deletes everything synced from Lumio’s servers and starts over with a new key. Your devices that have sync on upload what they have again.`
  - Confirmation dialog titled `Reset sync?` with the button `Reset Sync` (destructive) and the message `What’s on each device stays there.`
  - The button calls `engine.resetSync()`.
- **Danger section, `.e2ee`:** "Delete Synced Data…", unchanged.
- **New last section `Advanced`**, shown when `engine.managedAvailable`:
  - Row: `LabeledContent("Encrypt with My Own Passphrase", value: mode == "passphrase" ? "On" : "Off")`.
  - Footer, managed: `To keep your sync key only on your devices, turn this on in Lumio Browser on your Mac: Settings › Sync › Advanced.`
  - Footer, passphrase: `Only your devices have your sync key: Lumio can’t read what you sync. To change this, use Lumio Browser on your Mac.`
- **Remove-device dialog message:**
  - `.managed`: `If it’s still signed in to Lumio, it shows up again the next time it syncs.`
  - `.e2ee`: unchanged.
- The 5-second polling while `.needsKey` is unchanged in both flows.

**Companion: `CompanionCards.swift` `CompanionPairingCard`**
- When `model.link` reports a managed flow, add `var isManaged: Bool` to `SyncCompanionLink`, which reads `engine.flow == .managed`.
- In that case, the title is `Finishing Setup` and the first paragraph is `Open Lumio Browser on your computer. If it has the latest version, this \(name) connects by itself. Otherwise approve it there; it should show this code:`.
- The code, the steps and the recovery field are unchanged.

### 7.4 iOS tests (written, not run unless the step says so)

**`LumioTests/Sync/SyncTestSupport.swift` `FakeSyncServer`**
- Add `mode`, `managedAvailable` (default `true`) and `wrappedKey: Data?`.
- `GET /api/sync` returns `mode`, `managedKey` and `managedAvailable`.
- Implement `POST` and `PUT /api/sync/key`, `PUT /api/sync/mode` and `POST /api/sync/reset` per §2.6. The fake keeps the raw key; no real wrapping is needed.
- Implement pair auto-approval in managed mode using `SyncCrypto.wrap`.
- `DELETE /api/sync` clears the key and keeps the mode.
- Add a switch `legacy: Bool` that omits the new fields entirely.

**Test updates**
- `SyncEngineTests.twoDevices`: in managed mode, B becomes ready without pairing. Keep a copy of today's test with `mode = "passphrase"`.
- `recoveryKey` and `denying` move to `mode = "passphrase"`.
- `accountsAndDeleting`:
  - managed: after `signedOut()` the Keychain key is gone, and the device gets it back on the next sign-in;
  - passphrase: the key is kept, as today.

**New tests**
- Migration: the key matches and `managedKey` is false, so the device uploads.
- Waiting: the device joins once `wrappedKey` is set.
- `resetSync`: the other device adopts the new key.
- 409 `passphrase_mode` makes the device switch to the e2ee flow.
- A legacy server without the new fields gives exactly today's behavior.

**`SyncModelTests.status`**
- "Set up needed on a second device" becomes up to date in managed mode. Keep the case in passphrase mode.

**UI tests:** `LumioUITests/CompanionUITests` serves `/api/sync` without the new fields, so it stays legacy and unchanged.

---

## 8. Web (web builder)

### 8.1 Header comment of `main/sync/crypto.js` and `website/public/sync-crypto.js`

These two files must stay byte-identical (`tests/sync-crypto.test.mjs`).
- The mac builder edits `main/sync/crypto.js`. The web builder makes the identical edit in `website/public/sync-crypto.js`.
- The edit replaces only lines 6-14 (from "Everything synced is encrypted…" through "…recovery key the person wrote down.") with exactly this text, with no other change to either file:

```js
// Everything synced is encrypted on the device with the account's 32-byte
// sync key:
// - each record: AES-256-GCM, with its collection and id bound in;
// - each record's id: an HMAC of its collection and key (the server can't
//   see which sites are bookmarked or saved);
// - a check value lets a device tell whether its key matches the account's.
// How a device gets the key (docs/sync-managed.md): by default Lumio's server
// keeps a copy, wrapped with a key only the server has, and gives it to the
// account's signed-in devices. With "Encrypt with my own passphrase" the key
// never reaches the server: a new device gets it from one that has it (ECDH
// P-256, after the person approves and the 6-digit codes on both screens
// match), or from the recovery key the person wrote down.
```

### 8.2 `website/public/companion.js`

**Header comment (lines 1-8)**
> Lumio on your phone. Signed in to the same Lumio account as Lumio Browser, it shows: … (keep the list). Everything to and from the computer is encrypted with the account's sync key (sync-crypto.js); the server relays ciphertext. By default the phone gets the key from Lumio when you sign in; if the account uses its own passphrase, a computer approves the phone instead (docs/sync-managed.md).

**`api()`**
- Always send the header `X-Lumio-Sync: 1`.
- On a 401, if `S.managed` (the flow, persisted in IndexedDB as `syncManaged` and read back in `boot()`; the signed-out branch of `boot()` uses it too):
  - `await idb.del('syncKey:' + S.account?.email)`
  - `await idb.del('syncKeyOwner')`
  - set `S.keys = null`
  
  Then call `signIn()`, as today.

**State:** `S` adds `mode: 'managed'` and `managed: false`, which is the flow.

**`boot()`, after `GET /api/sync`**
- Set `S.mode = status.mode || 'managed'` and `S.managed = status.managedAvailable === true && S.mode !== 'passphrase'`.
- If `!S.managed`: today's code, unchanged (`needsSync()`, saved key, `pair()`).
- **Managed:**
  - Load the saved key. Keep it if its check equals `status.keyCheck`; otherwise delete it.
  - If a key is kept and `!status.managedKey`: `api('/api/sync/key', {method:'PUT', body:{key}}).catch(() => {})`, then `start()`.
  - Else if `!status.keyCheck || status.managedKey`:
    - `r = await api('/api/sync/key', {method:'POST', body:{}})`.
    - If `r.status === 'ready'` and `deriveKeys(fromB64(r.key)).check === r.keyCheck`: `adopt(raw)`, which starts.
    - If `r.status === 'waiting'`: `finishing(r.keyCheck)`.
    - On 409 `passphrase_mode`: set `S.mode = 'passphrase'`, `S.managed = false`, and call `pair(status.keyCheck)`.
  - Else: `finishing(status.keyCheck)`.

**New `finishing(keyCheck)`**
- It renders the same screen as `pair()`, with a different heading and intro:
  ```html
  <h1>Finishing setup</h1>
  <p>Open Lumio Browser on a computer that already syncs. Once it has the latest version, your phone connects by itself.</p>
  <p>Using an older version? Approve <b>{phoneName}</b> there. It should show this code:</p>
  ```
  followed by the code, steps and recovery details exactly as in `pair()`.
- Implement it as `pair(keyCheck, { managed: true })`.
- Additionally, every 10 s: `GET /api/sync`. If `managedKey`: `POST /api/sync/key`, then `adopt`.
- When the pair request expires in managed mode, post a new one silently instead of showing "expired".

**Key changed while running** (another device reset sync, or switched to passphrase)
- Every 60 s while visible, `GET /api/sync`.
- If `keyCheck !== S.keys.check`:
  - managed: `POST /api/sync/key`, then adopt the new key and reset `S.records` and `S.cursor = 0`;
  - otherwise delete the saved key and `pair(keyCheck)`.
- The silent `catch` blocks in `pullAll`, `pollStatus` and `pollNotices` stay as they are.

**Unchanged:** `adopt()` stays as it is: IndexedDB `syncKey:<email>` and `syncKeyOwner`. The `needsSync()` screen is reachable only in the e2ee flow.

### 8.3 Other web pages

- **`companion-sw.js`:** update the header comment only ("…decrypts them with the sync key kept on this phone"). It already copes with a missing key.
- **`account.js` sign-out:** before posting `logout`:
  ```js
  const s = await fetch('/api/sync', { credentials: 'include' }).then((r) => r.json()).catch(() => null);
  const managed = s ? s.managedAvailable === true && s.mode !== 'passphrase' && companion's syncMode !== 'passphrase' : companion's syncManaged === true;
  if (managed) { /* open IndexedDB 'lumio-companion' / store 'kv'; delete every key starting 'syncKey:' and 'syncKeyOwner' */ }
  ```
  Ignore any failure, then continue with the sign-out as today.
- **`companion.css`:** no change.

### 8.4 Privacy, FAQ, support (exact text)

**`privacy.html`**

- Keep "Last updated: October 8, 2026".
- Line 38: change "stay on your device unless you turn on Lumio Sync (below)" to "stay on your device unless Lumio Sync is on (below)".
- Replace the first `<p>` under `<h2>Lumio Sync and your computer</h2>` with these four paragraphs. The push-token paragraph after them stays.

```html
<p>Lumio Sync is on when you sign in to Lumio Browser or Lumio for iPhone and iPad, and you can turn it off in Settings › Sync. What you choose to sync (such as bookmarks, history, chats, settings, open tabs, and passwords between computers) is encrypted on your device with your account’s sync key before it’s uploaded. Payment methods sync only if you turn them on.</p>
<p><b>How the sync key is kept.</b> By default, our server also keeps a copy of your sync key, encrypted with a key only our server has, so signing in is all a new device needs to start syncing, like Google Chrome’s default sync. This means Lumio could technically decrypt your synced data. We don’t sell it, use it for advertising or use it to train AI models. When a device gets the key, a one-way hash of its network address is kept for one hour to stop abuse. Signing out of Lumio on a device removes the sync key from that device.</p>
<p><b>Encrypt with your own passphrase.</b> In Lumio Browser, Settings › Sync › Advanced, you can choose to keep the sync key only on your devices. We then delete our copy, and your synced data starts over with a new key that never reaches our server, so we can’t read it. New devices then need your approval on a device that already syncs, or your recovery key; if you lose all of them, we can’t recover your synced data. A deleted copy of a key can stay in our database’s backups for up to 30 days.</p>
<p>We keep the encrypted copies, a list of your devices with their names and random IDs, and our encrypted copy of your sync key until you reset sync or delete your synced data (Settings › Sync), or delete your account. Tasks and tabs you send between your phone and Lumio on your computer are encrypted the same way.</p>
```

- "Your choices" (line 57): change "deletes your chats, files, synced data, devices and push tokens" to "deletes your chats, files, synced data, sync key, devices and push tokens".

**`support.html`**
- Line 43: the same "…synced data, sync key, devices and push tokens…" change.
- Line 47: `<li><b>Lumio on your phone:</b> open <a href="/companion">lumio-co.online/companion</a> on your phone and sign in to the same Lumio account as Lumio Browser.</li>`

**`index.html` FAQ**
- Line 272, "Can I use Lumio on my phone?":
  > Yes. Open <b>lumio-co.online/companion</b> on your phone and sign in to the same Lumio account as Lumio Browser. You’ll see what Lumio is doing on your computer, approve its steps, run your workflows and read your chats. Your synced data is encrypted.
- Line 275, "Does it sync between devices?":
  > Yes. Sign in to your Lumio account and Lumio Sync keeps your bookmarks, history, chats, open tabs and settings the same everywhere you sign in, and your passwords between your computers. Want only your devices to hold the key? Turn on <b>Settings › Sync › Advanced › Encrypt with my own passphrase</b>.

### 8.5 Web tests

- **`tests/companion.test.mjs`.** Run it only when the step says so; it launches Chrome.
  - Add `SYNC_MASTER_KEY` to `env`.
  - The existing pairing test becomes a passphrase-mode test. Before the phone loads, insert `INSERT INTO sync_keys (owner, mode, wrapped, key_check, created_at, updated_at) VALUES ('u1','passphrase',NULL,NULL,0,0)`, so it doesn't depend on the Mac's new `setMode`.
  - Add a managed test: the Mac computer is ready, the phone loads `/companion`, and it reaches the Now view with no `.code` element. No approval call is made.
  - Keep the "server holds no readable content" assertions on `sync_items`.
- **`tests/website-domain.test.mjs`:** it should pass unchanged. Run it, since it is cheap.

---

## 9. Security checklist (every builder verifies their part)

- [ ] The key endpoints accept only a valid session. The owner is always taken from the session and never from the body.
- [ ] Cookie requests need `Origin` equal to the site, plus `X-Lumio-Sync: 1`, and are rejected when `Sec-Fetch-Site` is not `same-origin`. There are no CORS headers. There is no GET route for the key.
- [ ] Responses carry `cache-control: no-store`. The key appears only in JSON bodies, never in URLs, logs, error messages, analytics or crash reports. On the Mac, check that crash reports (`main/crash*`) and the logs never print `sync.raw` or the secrets.
- [ ] Wrapping uses AES-256-GCM with a random IV and AAD `lumio-sync-key|v1|<users.id>`. A wrapped key moved to another account fails.
- [ ] Check values are compared in constant time on the server.
- [ ] `SYNC_MASTER_KEY` exists only in Worker secrets. `setup.mjs` never overwrites it, and tests use random fakes.
- [ ] The rate limits are in place (§2.5).
- [ ] Account deletion removes `sync_keys` and `sync_key_events`. Reset and DELETE remove the wrapped key but keep the mode.
- [ ] Sign-out removes the key in flow managed only, on explicit sign-out or when the session ended, and never because the client is offline.
- [ ] Passphrase accounts are never switched to managed automatically, and the server refuses uploads for them. Leaving passphrase mode needs the account's current key (§2.6), and clients keep a remembered passphrase unless Lumio hands back their own key (§3.3).
- [ ] Payment methods (`cards`) stay off by default.

---

## 10. Order of integration

1. **server**, on its own: `cd server && npm test`.
2. **mac**, **ios** and **web**, in parallel against this contract. The mac and web tests that import `server/src/index.ts` need step 1 merged.
3. **Full `npm test`** at the root. It does not include e2e.
4. **Owner, before deploying:**
   - `npx wrangler d1 execute lumio --remote --file migrations/2026-10-08-sync-keys.sql`
   - `node scripts/setup.mjs --host lumio-co.online`, which creates `SYNC_MASTER_KEY`.
   - Then deploy.
   - The order matters: a Worker without the secret reports `managedAvailable: false` and keeps today's behavior.

---

## 11. Notes for the owner (decisions taken here; change them before building if you disagree)

1. **The label "Encrypt with my own passphrase" is kept as you asked, but nobody types a passphrase.** The secret is the existing 52-character recovery key, and the descriptions say so. Adding a real typed passphrase would change the crypto. It is out of scope here.
2. **Switching to passphrase deletes the server's synced data and re-keys.** Without this, the server would still hold data it could decrypt, and the key would still be in D1's 30-day backups. The switching computer re-uploads everything it has. Other devices need approval again.
3. **Mode switching is Mac-only.** iPhone doesn't sync passwords, passkeys, addresses, cards, workflows or projects. Re-keying from an iPhone would drop those from the server until a Mac rejoins. iOS and the web show the mode and point to the Mac.
4. **Reset in managed mode keeps sync on**, and the other signed-in devices automatically upload what they have again. To fully stop syncing, turn Sync off on each device, or delete the account.
5. **Removing a device in managed mode only removes its row.** A device that is still signed in rejoins. Signing out on it, or changing the password (which ends all sessions), is what stops it.
6. **Existing users' data is uploaded and wrapped automatically after the update**, because managed is the default. The privacy page explains this. If you want an in-app notice for those users, it isn't in this contract.
7. **Older builds (v0.6.7 Mac, the App Store iOS app) are auto-approved by the server** in managed mode, so they also get "sign in = synced". This is the same trust level as the key endpoint.

---

## 13. Changes after review

1. **Passphrase downgrade.** `PUT /api/sync/mode {mode:'managed'}` with no `sync_meta` is 409 `sync_not_set_up`, and the upsert only lands while the key is still the account's (§2.6). Clients keep a remembered passphrase unless Lumio hands back their own key, and while it doesn't they never upload, fetch or pair (§3.3).
2. **Lost answer to the passphrase switch.** The Mac saves the new key as `syncKey:<owner>:pending` before asking, reuses it on a retry, adopts it on the next run when the server shows it, and handles `already_passphrase` without claiming success; the recovery key is never shown while `needs-key`/`error` (§3.2).
3. **Companion status sealed with an old key.** The passphrase switch and reset clear `sync_devices.status`/`status_at`; computers send `keyCheck` with their status and a stale key is refused (§2.6).
4. **Rate-limit lockout.** Refused key requests aren't counted (§2.5), and clients wait `retry-after` before asking again (§3).
5. **Sign-out.** The key leaves a device only in flow `managed` (§3.1).
6. **Old-key records mid-run.** Push carries `keyCheck`, checked atomically; clients stop on `key_mismatch` and catch up on the next run. iOS `resetSync()` holds the run slot until the new key is adopted (§2.6).
