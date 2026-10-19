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

### Verification status of the ordering controls

Covered by automated tests (`backend/test/ordering*.test.ts`, `uzbek-number.test.ts`,
the offline cases in `control-install.integration.test.ts`): per-role enforcement,
discount limits, table assignment, delegation caps, the guest journey with partial
payment, receipt/report/audit consistency, simultaneous edits, tenant isolation.
Checked in a real browser against a throw-away tenant: delivery order created and
assigned to a courier by a Cashier, «Mijoz» order → waiter alert → table assignment
with live updates on every open panel, customer-TV announcement de-duplication across a
connection loss, Admin and Owner pages at phone, tablet, 1024×600 and desktop sizes.
The Android service logic that does not depend on Android (`SseReader`, `SeenOrders`)
is run on a plain JVM by `android/test/StreamProbe.java`.
**Not verified on a device:** notification, text-to-speech, screen-off and restart
behaviour of `AlertService` — see `docs/android-sinov-royxati-uz.md`.

### Server portability

The control plane can be moved to another host or a VPS without reissuing licences or
re-activating installs: see `docs/server-migration.md` (Uzbek: `docs/server-kochirish-uz.md`).
In short: the same database, `APP_SECRET_KEY` and `CONTROL_SIGNING_KEY`; installs switch by
themselves when the old server announces the new address (`CONTROL_RELOCATE_URL`, adopted
only after a signed, verified heartbeat), or by hand (Litsenziya → «Markaziy server
manzili»); the client EXE honours `%APPDATA%\FastFood-Data\control-server.json` and the Owner
EXE has Owner → «Server manzili…». `scripts/verify-server.mjs --compare` checks a new
server against the old one.

### Owner access to hosted restaurant data

For restaurants hosted on the central server (a customer linked to a tenant) the Owner can
browse branches, devices, roles, employees, settings, receipt templates and orders
(`/api/control/customers/:id/data/*`): tenant-scoped through the customer record, read-only,
personal data (employees, orders) behind a fresh password+code, every read audited
(`data.view.*`), no password/PIN/token hashes selected. The Owner can suspend or restore an
employee (sessions end at once, audited). Restaurants running on their own computer keep
their data there; the centre sees only what the install reports.

### Forgotten passwords and PINs (Owner)

The Owner sets a **new** password or PIN for a restaurant Admin or employee without ever
seeing the old one (Owner → customer → «Restoran ma’lumotlari» → Xodimlar → «Parol / PIN
tiklash»; API `POST /api/control/customers/:id/data/users/:userId/password` or `/pin`).
It needs a fresh password + code (step-up) and an explicit `confirm: true`; the password
must meet the normal rule (10+ characters, letters and digits). Only a hash is stored (the
same hashing as normal sign-in), the new secret is never written to a log or an audit row,
every session of the employee ends, the account is unlocked and the employee must choose
their own password at the next sign-in. The reset touches the user row and its sessions
only: the tenant, the database, orders, history and the licence are never recreated or
changed. It is audited centrally (`data.user.password.reset`, `data.user.pin.set|remove`)
and in the restaurant's own audit log (`user.password.reset.owner`, …), with no secret.

### Application packages

| Package                | For                                                                      | Connects to                                    |
| ---------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| FastFood (client EXE)  | Shared POS: Cashier, Waiter and Kitchen panels, server + database inside | itself (and the central server for licences)   |
| FastFood Admin (EXE)   | Restaurant administrator: staff, roles, tables, printers, settings, menu | the restaurant's server address (set on start) |
| FastFood Owner (EXE)   | The Owner (SUPER_OWNER)                                                  | the central server                             |
| FastFood (Android APK) | Waiter: opens the waiter screen, alerts for guest orders                 | the restaurant computer's address              |

After sign-in the client EXE opens the panel that matches the account (waiter → Waiter,
cashier → Cashier, kitchen → Kitchen; managers land on the dashboard) and the menu offers
only the other panels the account's permissions and the Owner's switches allow. The server
enforces the same rules. The Admin EXE always opens the management dashboard; it stores no
restaurant data and no password, accepts plain `http` only for local-network addresses,
and its address can be changed later (menu «Server manzili…») without rebuilding.

### Local test central server

`node scripts/test-control-plane.mjs setup | start | status | code | stop` runs an isolated
TEST central server on `http://127.0.0.1:4100` with its own database
(`fastfood_control_pilot`), its own throw-away signing key and a test Owner. Secrets live in
`%LOCALAPPDATA%\FastFood-TestControl`, never in the repository, and nothing in a production
installer contains them (the Owner and Admin build scripts refuse a production build whose
files contain test flags, a local address or test credentials).

### Advertising and remote design (Owner)

Tables (additive migration `20261020090000_branding`): `branding_media` (validated picture/video
bytes), `branding_designs` (Owner layers: key `global` or a customer id), `tenant_designs` (a
restaurant Admin's layer, only while delegated), `ad_campaigns`/`ad_targets`, `ad_stats` (display
counters), `ad_deliveries` (which install received which version), `branding_cache` (an install's
last verified bundle).

- **Media** is judged by its own bytes (PNG/JPEG/WEBP/GIF ≤ 3 MB, MP4/WEBM ≤ 20 MB); SVG, HTML and
  anything else is refused. Files are served with `nosniff`, `Content-Security-Policy: sandbox` and
  an ETag (`/api/branding/media/:id`).
- **Design** is layered and sparse: defaults ← Owner global ← Owner per restaurant ← restaurant Admin
  (only when the feature `design.admin` is ON for that restaurant). Deleting a layer restores the one
  below it. Six skins: `classic`, `premium`, `blue`, `emerald`, `minimal`, `luxury`; per panel
  (`admin`, `cashier`, `waiter`, `kitchen`, `customer`) a skin and a sign-in skin; login background,
  logo, accent colour, welcome text; splash title/subtitle/logo.
- **Campaigns** target all or selected customers, panels, a time window, frequency (`everyMinutes`,
  `maxPerDay`), priority; the feature `ads.display` (default ON) switches advertising off for one
  restaurant. A fullscreen campaign must be closable or have an auto-close timer.
- **Delivery.** Hosted restaurants read the control tables directly and screens are told by the
  Socket.io event `branding.changed`. Installed restaurants get a `branding` bundle (design + campaigns
  - media checksums) inside the signed heartbeat answer whenever their reported `brandingVersion` differs
    (≈ 60 s); the files come over the signed device channel `POST /control/device/media` (only files of the
    restaurant's own bundle) and are checked against the signed sha256 before they are stored; the bundle
    is reported as complete only when every file is present. Display counters travel back as cumulative
    `ad_stats` sync operations (the centre keeps the larger value, so retries never double count).
- **Screens** keep the last design and campaign list in `localStorage` (applied before the first paint
  and used when the server cannot be reached). The ad engine never covers a payment dialog, a sale in
  progress (cart), printing, any open dialog or a screen touched in the last 5 s; the kitchen only gets
  banners; covering ads are dismissed the moment work starts.
- **Routes.** Owner: `/api/control/{media,ads,design,customers/:id/design}` (audited with old/new
  values; destructive actions need `confirm: true`, global changes need step-up). Restaurant:
  `/api/branding/login` (public), `/api/branding`, `/api/branding/ads/:id/event`,
  `/api/branding/admin[/media]` (settings permission + delegation).
- **Cold starts.** The web application treats a gateway error or an HTML page where JSON is expected
  as "server waking up", shows its own branded reconnect screen in Uzbek and reconnects by itself; the
  Owner and Admin applications show a branded splash and wait for `/api/health/live` (JSON
  `status: ok`) before opening the page. Hosting names and addresses appear only under
  «Texnik ma’lumot» / «Murakkab sozlama».

### Owner session that stays until the computer restarts

The Owner application sends `keep: true` at sign-in (only after password, approved device key and a
valid code). The session then lives 7 days absolute / 12 hours idle (an ordinary sign-in keeps 8 hours /
30 minutes). The application ends it itself: at start it compares the boot moment (and a shutdown or
log-off marker written on Windows `session-end`) with the last run and, when they differ, calls
`/api/control/owner/logout` (best effort) and removes the cookie. Closing and reopening the
application does not sign out. Step-up (password + code) for sensitive actions is unchanged.
