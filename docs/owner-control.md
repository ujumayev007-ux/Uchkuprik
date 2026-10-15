# SUPER_OWNER central control

Extends the existing vendor ("Sotuvchi paneli") with a central server. Nothing of the
earlier GitHub-gist licence flow was removed: installs that are not linked to the
central server behave exactly as before.

## Roles and trust

| Part                           | Holds                                                           | Never holds                             |
| ------------------------------ | --------------------------------------------------------------- | --------------------------------------- |
| Central server (control plane) | Ed25519 **signing key** (`CONTROL_SIGNING_KEY`), control tables | —                                       |
| Owner app (EXE)                | Device key (OS secure storage), central server URL              | passwords, signing keys, DB credentials |
| Customer app (EXE + APK)       | Central **public** key, grant, its own device key               | any Owner credential or signing secret  |
| Restaurant employees           | their own login / PIN                                           | licence activation grants no access     |

`backend/src/modules/control/` is the shared code (catalog, policy, grant state machine,
signing helpers); `owner-desktop/` is the separate Owner application.

## How a customer is controlled

1. Owner creates a customer and issues a licence. The plaintext key
   (`FFL-XXXXX-XXXXX-XXXXX-XXXXX`, 100 random bits) is shown once; only an HMAC-SHA256
   with a server secret is stored.
2. The cashier computer activates with the key (Licence page → “Markaziy server bilan
   aloqa”). The install sends its **device public key** and proves possession by
   signing the request. The licence binds to the first local restaurant (tenant) that
   activates it; another restaurant is refused (`TENANT_MISMATCH`).
3. Every 60 s the install posts a **signed heartbeat** (counter + timestamp, replay
   protected). The answer is a server-signed document with a fresh **grant** (policy
   version, capabilities, expiry), pending commands and an optional staged update.
4. All checks run in the backend on every request (`enforceControl`, `authenticate`).
   The UI only mirrors the result.

## Timing (explicit)

| What                            | Value                                                                     |
| ------------------------------- | ------------------------------------------------------------------------- |
| Online connection check         | every **60 s** (`timing.heartbeatIntervalMs`)                             |
| Brief network-failure tolerance | **5 min** since the last good check, full online rules                    |
| Presence “online” (Owner view)  | heartbeat within **3 min**                                                |
| Offline authorization           | `maxOfflineMinutes` from the last good check (Owner sets it per customer) |
| Online-only customers           | grant valid 10 min after each check; then new operations stop             |
| Request signature freshness     | ±5 min                                                                    |
| Owner session                   | idle 30 min, absolute 8 h; step-up window 5 min                           |

**Limitation (also shown in the Owner UI):** Owner changes take effect when the install
receives them. A device that is disconnected keeps its previous grant until it
reconnects or the grant expires.

## Offline model

State machine (`grant.ts`, pure and unit-tested): `ONLINE` → `OFFLINE` (grant) →
`EXPIRED`, plus `BLOCKED`. Expired/online-only: new operations (all non-GET) are
refused with Uzbek messages; saved orders and data stay readable and sign-in works.

- Per feature **online** and **offline** switches (`features[key].online/offline`).
  Internet-dependent features (online ordering, payments providers, Telegram, API) can
  never be offline-enabled.
- Offline `orders.create` / `orders.edit` only from the **Cashier panel**: the request
  must carry `X-Panel: cashier`, come from the cashier computer itself (loopback) or a
  terminal registered with panel `CASHIER`, and the user needs `pos.access`.
- Offline, LAN terminals must be **registered devices** (`LOCAL_DEVICE_REQUIRED`).
  Kitchen terminals keep reading and updating tickets through the local service.
- Clock rollback: effective time = max(system clock, stored high-water mark, elapsed
  process time). A clock found behind the high-water mark demands a fresh contact
  (`CLOCK_ROLLBACK`) before new operations.

## Feature catalog and delegation

`catalog.ts` lists every panel, module, action, button, report field and financial
visibility switch with the API routes it guards (a test fails when a route is not
classified). Per customer the Owner sets `ON`, `OFF` or `ADMIN` (delegated to the
restaurant Admin, who then decides per role in Litsenziya → Admin funksiyalari).

Cost price, margin and net profit are hidden from **Cashier-class** users by default
(`fin.cashier.cost|margin|profit`, default OFF); only the Owner can switch them on or
delegate them. `fin.cost|margin|profit` and `field.report.*` switch them off for
everyone.

### Per-role decisions and parameters

Every feature can also carry **per-role overrides** (`roles.<roleKey>.enabled`) and
**parameters** (`params`, plus `roles.<roleKey>.params`) declared in the catalog
(`ParamDef`: int with min/max and optional `ownerCap`, bool, enum). A role override
applies to the users holding that role and a user with several roles keeps what any
of them allows; a global `OFF` is always final. For a delegated (`ADMIN`) feature the
restaurant Admin may set parameter values (`feature_settings.params`); numbers marked
`ownerCap` can only be lowered below the Owner's value.

The resolved result for the signed-in user is `me.ordering` (`modules/control/ordering.ts`)
and is enforced by the order routes — the UI only mirrors it:

| Setting                                | Feature key(s)                                                        | Parameters                                                           |
| -------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Order types                            | `orders.type.dine_in\|takeaway\|delivery`                             | –                                                                    |
| «Mijoz» button (order without a table) | `orders.walkin`                                                       | –                                                                    |
| Assign / change table                  | `orders.table.assign` (`POST /orders/:id/table`, `PATCH /orders/:id`) | –                                                                    |
| Discounts                              | `discounts.percent`, `discounts.fixed` (+ `discounts.apply`)          | `maxPercent`, `maxFixed`                                             |
| Order display mode (Cashier/Waiter)    | `orders.display`                                                      | `defaultMode`; switch = may the user change it                       |
| Customer TV                            | `tv.display`, `tv.voice`                                              | `layout`, `showPreparing`, `showReady`, `repeat`, `volume`, `phrase` |
| Waiter Android alerts                  | `waiter.notify`                                                       | `sound`, `voice`, `volume`, `repeat`, `reminderSeconds`              |

Order table changes, details edits, item additions/changes and discounts are written
to the audit log (`order.table.assign`, `order.update`, `order.items.add`,
`order.item.change`, `order.discount` with the previous values).

### Live events and the Android alert service

`order.table_needed` / `order.table_assigned` (branch room) and `config.changed`
(tenant room; also published when an install receives a new policy version) travel over
the existing Socket.io channel. Waiter tablets in the Android app use
`GET /api/live/alerts` (Server-Sent Events, same session cookie, feature
`waiter.notify`): it sends `config`, `snapshot` (guests still waiting, so a reconnect
cannot miss one), `walkin`, `assigned` and `bye`. The native `AlertService` announces
each order id once (ids are persisted), speaks «Yangi mijoz buyurtmasi. Stolni
belgilang.» with Android text-to-speech (Uzbek voice, Turkish as fallback) and shows a
notification with the order number and a «Stol belgilash» action.

## Synchronisation

Outbox (`sync_operations`) is durable and idempotent by operation id; the server keeps
a per-customer ledger. Same id + same content → `DUPLICATE`; same business key with
different content → `CONFLICT` (shown in Owner and install UIs, retry is explicit).
Internet-dependent queues (Telegram notifications, webhooks) are listed as “navbatda”
and never shown as completed.

## Updates

Releases (`EXE`/`APK`) carry URL + SHA-256 + a server signature. Stage: draft, staged
(percentage, stable bucket per install), all, withdrawn; optional minimum version.
The desktop only installs a release whose signature verifies against the central
public key and whose hash matches, and refuses while orders are open (never
interrupts a sale). A minimum version blocks only **new orders**, after the
`minVersionFrom` moment.

## Backups

`npm run backup -w backend -- create <file>` writes a logical backup and restores it
into a scratch database to compare every table (`verify`). The desktop does this daily
(last 7 kept); the Owner console has “Zaxira nusxa va tiklashni tekshirish”.

## Operations runbook

```text
# 1. keys (once) — private key only on the central server
npm run control:keygen -w backend

# 2. central server environment
CONTROL_PLANE=true  CONTROL_SIGNING_KEY=<base64 PEM>  (+ DATABASE_URL, APP_SECRET_KEY, SERVE_FRONTEND=true)
npm run db:migrate

# 3. first owner (authenticator secret is printed once)
OWNER_EMAIL=... OWNER_NAME=... OWNER_PASSWORD=... npm run control:owner -w backend

# 4. builds (public data only)
CONTROL_URL=https://central.example CONTROL_PUBLIC_KEY=<public> node desktop/build.mjs
OWNER_URL=https://central.example node owner-desktop/build.mjs
# EXE signing: set CSC_LINK / CSC_KEY_PASSWORD (.pfx); the APK build signs with the release key.
```

First Owner device: the first sign-in with a valid authenticator code enrolls that
device; later devices stay `PENDING` until approved from an approved device (or
`OWNER_DEVICE_FINGERPRINT=… npm run control:owner`).

## Remaining limitations

- Owner sign-in works only from the Owner EXE (device key); there is no browser login.
- Android terminals are clients of the cashier computer; they do not keep their own
  offline queue (the cashier computer's database is the durable store).
- Hosted (cloud) tenants have no offline mode; their policy comes straight from the
  linked `control_customers` row.
- Windows code-signing needs your certificate; unsigned builds are for testing only.

## Test channel (isolated from production)

`BUILD_CHANNEL=test` builds isolated TEST installers (`desktop/release-test`,
`owner-desktop/release-test`): own app id, data folder (`FastFood-Test-Data`), Electron
profile, ports (8788 / 54331), no vendor watchers, no production status/report
settings, and a local `http://127.0.0.1:<port>` central address is allowed. A production
build never accepts a plain-http address. Simple hosting steps: `owner-control-hosting-uz.md`.
