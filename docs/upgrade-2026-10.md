# FastFood upgrade (October 2026): technical notes

Source checkpoint: git tag `baseline-before-upgrade-20261021` (before this upgrade).
Release numbers: server `1.14.4`, Admin/Kassa/Ofitsiant/Oshxona/TV applications `1.4.0`,
Owner `1.8.0`. (The request called the Owner "1.14.3"; that is the server/client number —
the Owner application had its own number, 1.7.0.)

## What exists, what was added

| Area                                                           | Status before                          | This upgrade                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Central registry (customers, licences, devices, policy, audit) | existed (control plane)                | + pending **registrations**, durable **Owner events** (unread/history), registry settings                          |
| Trial                                                          | local 14 days, per install             | + server-authorised **exact-hour trial** (default 72 h) started at the first activation; legacy installs unchanged |
| Signed licences / grants / offline lease                       | existed (Ed25519, `maxOfflineMinutes`) | reused; a grant never outlives the licence end, so a trial lease can not pass 72 h                                 |
| Local-network-only operation                                   | not enforced                           | **enforced** on REST and realtime for self-hosted installs; Owner-only expiring exception                          |
| Receipt designer                                               | existed (templates, widths, logo, …)   | unchanged (verified by its existing tests)                                                                         |
| Reports                                                        | one screen, no files                   | + **Excel / Word / PDF** from one dataset, per-restaurant layout, preview, inventory sections                      |
| Inventory alerts                                               | "low" flag, Telegram notice            | + ledger-driven **alerts** (LOW/CRITICAL/OUT), acknowledge/resolve, sound, reminders                               |
| Customer queue (TV)                                            | web page `/navbat`                     | + **TV application** (HDMI display selection, read-only `display` role, stale-data banner)                         |
| LAN auto-connect, Oshxona application, kitchen accept/reject   | done earlier (1.14.3 / 1.3.0)          | —                                                                                                                  |
| Android `ofitsiant.apk` / `tv.apk`, Android TV                 | APK 1.13.0 (waiter)                    | **not changed** (see "Pending")                                                                                    |

## Architecture map (relevant parts)

- `backend/src/modules/control/*` — central plane (also runs on every install in `CONTROL_PLANE=false` mode):
  `registry.ts` (registrations, events, trial licences), `network.ts` (approved network decision),
  `manage.routes.ts` (Owner API), `device.routes.ts` (device channel), `runtime.ts` (install side).
- `backend/src/modules/reports/*` — `sales.ts`/`inventory.ts` datasets → `document.ts` (layout, permissions,
  one `ReportDoc`) → `export/{xlsx,docx,pdf}.ts`.
- `backend/src/modules/inventory/{alert-sync,stock-alerts}.ts` — alerts are raised inside `postMovement`
  (the single stock ledger entry point, under the balance row lock).
- `admin-desktop/*` — one thin Electron shell, five applications (`PANEL_KIND` = admin, cashier, waiter,
  kitchen, tv). `desktop/*` — the server application (PostgreSQL, API, beacon `lan.cjs`).
- `owner-desktop/*` — Owner application (unchanged shell; the console is the web UI served by the central server).

## Central registry and trial

1. First launch of a self-hosted server (and every ten minutes while unlinked): `runtime.register()` sends a
   request signed with the install's own key (`POST /control/device/register`). It carries install id,
   computer name, version, restaurant name, first-install date, whether a local licence exists. It grants
   nothing; a forged, stale (clock skew) or malformed request is refused and creates nothing.
2. The centre records one registration per key fingerprint and one `registration.new` event
   (`dedupeKey = reg:<fingerprint>`; retries, restarts and upgrades repeat the same key and create nothing).
   Events are rows (`control_events`), so they wait for the Owner while the Owner application is closed.
3. **Automatic trial** (Owner can switch it off and set the hours, default 72): only for a _new_ installation
   — first-install date within 24 h, no local licence, no earlier registration with the same install id or
   restaurant key. The centre creates a customer + a trial licence whose clock has not started, and seals
   the key for the registering device. The device receives it in the answer (or on the next retry) and
   activates; **the trial starts at that activation** (`trialStartedAt`) and ends exactly `trialHours` later
   (`expiresAt = start + hours`, millisecond precision). Re-activation (restart, reinstall of the app) does not
   move the end; a second computer with the same key is refused (`maxInstalls = 1`).
4. Anything else (older install, already licensed, repeated id) stays `PENDING` for the Owner, who assigns it
   to a customer with a trial (once per customer) or a licence (`POST /control/registrations/:id/assign`).
   This is the controlled mapping path for legacy customers: **an upgrade never turns a licensed restaurant
   into a trial** — its local licence keeps working and it only appears in the Owner's list.
5. Converting a trial: `POST /control/licenses/:id/renew` (clears `trialHours`; the paid term starts now;
   same activation, data untouched).

Anti-abuse and honest limits: trial eligibility is keyed by install id, install key, restaurant key and the
first-install marker that survives deleting the data folder. A person who wipes **every** marker and the
restaurant data can obtain a new trial — a customer-controlled computer can not prevent that; the Owner sees
each registration (`label`, `lastIp`, `installedAt`) and can disable automatic trials. Clock rollback is handled
by the control layer's monotonic clock and by trusting the server-signed `issuedAt` of every grant.

### Licence states and timing

`pending` (registration), `trial`, `licensed`, `expired`, `suspended`, `revoked` (+ `blocked` by remote block).
Commercial state (licence) and connectivity (last contact/online) are separate fields in the Owner lists.

- Heartbeat 60 s. Offline lease = `policy.maxOfflineMinutes` (Owner-set per customer, 0 = online only),
  capped by the licence end. Revocation/suspension reaches an online server within about one heartbeat; an
  **offline** server learns when it reconnects or when its lease ends — at most `maxOfflineMinutes` later.
- Expired: new operations return `402 LICENSE_EXPIRED`; sign-in, the licence screen and **data export**
  (`/reports/export|preview|layout`, `/tenant/export`) stay open. Requests are gated individually, so a
  transaction that already committed is never undone.

## Local-network-only operation (self-hosted installs)

Decision (`control/network.ts`, applied after the session is loaded, before routes, and at every WebSocket
connect and re-check): the TCP **connection address** must be loopback or inside one of the server's own
network-card subnets (IPv4 subnet match; IPv6 link-local or same /64). Headers (`X-Forwarded-For`, `Host`,
…), SSIDs, public IPs and client claims are never used. Hosted (cloud) restaurants are not affected.

- Blocked: `403 NETWORK_NOT_APPROVED` (Uzbek message). `GET /api/network/status` answers from anywhere with the
  reason (no restaurant addresses).
- **Owner exception** (`PUT /control/customers/:id/policy`, `networkOverride`): 1–90 days, optional role list,
  mandatory reason, audited, revocable (`null`). It travels in the signed grant. Under it the user must still
  sign in (only `/api/auth/*` and `/api/pin/*` are reachable unauthenticated) and, if roles are listed, hold one.
  A restaurant Admin or a local file can not set it. Expiry is evaluated per request from the signed time, so an
  offline server honours the end date; **revocation** reaches an offline server when it next syncs.
- Not provided / limits: application code can not prove physical Wi-Fi membership. Traffic that arrives through
  a router that forwards or NATs it from the same subnet looks local. Strict physical separation needs the router
  (VLAN/guest isolation, no port forwarding) — do not open WAN ports. Same-PC and VPN clients: a VPN address
  outside the cards' subnets is blocked unless the Owner grants the exception.

## Reports and exports

`GET /reports/export?format=xlsx|docx|pdf&from&to&branchId`, `GET /reports/preview`, `GET|PUT /reports/layout`,
`GET /reports/inventory`. All three files and the preview are rendered from one `ReportDoc`, built from the
restaurant's saved layout (sections, order, hidden columns) **and** the caller's permissions (inventory sections
need `inventory.view`; cost/profit follow the existing finance flags). Business dates follow the branch time zone;
money is so'm without decimals; text cells that start with `= + - @` are stored with a leading apostrophe
(no formula injection). The Word/PDF fonts: Latin + Cyrillic (DejaVu Sans, bundled). _"exe" in the request was
read as Excel (.xlsx)._ Files were validated structurally (ZIP/XML/PDF markers and content); they have not been
opened in Microsoft Office or Adobe Reader in this environment.

## Inventory alerts

`stock_alerts` (one active alert per item+warehouse, partial unique index) is updated in `postMovement` and when an
item's minimum/active flag changes: LOW (< minimum), CRITICAL (< `criticalPercent` of minimum), OUT (≤ 0). A worse
level re-opens an acknowledged alert; replenishing resolves it and the next shortage alerts again. Settings
(`enabled`, `soundEnabled`, `criticalPercent`, `reminderMinutes`) are per restaurant; mute is per device. The Admin
shows a bell with the unacknowledged count, a pop-up and one sound per new/worse alert, then a reminder every
`reminderMinutes` until someone acknowledges. A device without audio only loses the sound.

## TV application

`FastFood-TV-Setup-1.4.0.exe`: fullscreen `/navbat` on the chosen display (default: first non-primary display,
menu → _Ekran_ to choose; re-placed when a cable is plugged/unplugged). It never takes focus on start and plays
the ready announcements without a tap. Sign in once with a `display` account (role "Mijoz ekrani (TV)",
permission `queue.view` only: it can read `/api/queue`, nothing else). If the connection drops, a red banner says
the data may be stale. **Not verified on a real HDMI monitor** in this environment (only one display).

## Compatibility matrix (what was run)

| Server         | Older shells / APK                | Result                                                                                   |
| -------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| 1.14.4         | Admin/Kassa/Ofitsiant 1.2.0–1.3.0 | work (manual address); gain auto-connect after updating to 1.4.0                         |
| 1.14.4         | Kitchen screen of older web build | "Tayyor/Tayyorlanmoqda" now require "Qabul qilish" first (409 `ACCEPT_REQUIRED`)         |
| 1.14.4         | `ofitsiant.apk` 1.13.0            | unchanged workflow; no auto-discovery; local-network rule applies to its connection      |
| 1.14.4 + Owner | Owner 1.7.0 console               | works; the new tabs (Hodisalar, Ro'yxatdan o'tganlar, tarmoq istisnosi) need Owner 1.8.0 |

## Backup, upgrade and recovery

- Server application: before every upgrade it takes a verified logical backup (`backups/<time>-before-<version>`) and
  a daily one (`daily-YYYY-MM-DD.ndjson.gz`, restore-checked). Data lives outside the install folder
  (`%APPDATA%\FastFood-Data`), secrets are DPAPI-sealed in `secrets.enc`.
- Migrations in this release are **additive** (new tables/columns only) and repeatable (`prisma migrate deploy`
  is idempotent): `kitchen_accept`, `report_layouts`, `stock_alerts`, `network_policy`, `registry_trial`.
- Recovery: close the application, reinstall the previous installer, and — only if you must go back past a
  migration — restore the matching backup taken _before_ the upgrade together with the matching application
  version. Orders accepted after the upgrade are in the newer database only; restoring an older backup discards
  them, so export reports first. Copying an old EXE over a migrated database is **not** a rollback.
- Never install a version older than the data's version (1.8.0 over 1.14.x wrote a new `secrets.json` and could
  not open the database: reinstall 1.14.x, nothing is lost).

## Pending / needs hardware or accounts

- Real two-computer Wi-Fi test of discovery and of the local-network rule; real HDMI display; Android devices.
- `ofitsiant.apk` / `tv.apk` (Android TV) were **not** rebuilt or extended; APK signing continuity is untouched
  (the keystore is in `%USERPROFILE%\.fastfood`).
- Code signing (installers are unsigned; Windows/antivirus may warn).
- Deployment of the central server: pushing `main` redeploys the Render service (migrations run on start).
