# Moving the central server (Render → another host or a VPS)

Moving the repository is **not** enough. The server's identity lives in its database and
in two keys. This document lists everything that has to move, how to move it, how to
check it and how to go back. Nothing here changes production by itself: the live server
and its address stay as they are until the cut-over steps in section 8 are run on purpose.

Simple Uzbek instructions: `docs/server-kochirish-uz.md`.

## 1. What must stay the same

| Must be preserved                                                                      | Why                                                                                                                                                               | Where it lives                         |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Database** (every table)                                                             | Licences, activations, device public keys, policies, owners and their approved devices, audit trail, sync ledger, releases, customers' data of hosted restaurants | PostgreSQL                             |
| **`APP_SECRET_KEY`**                                                                   | Seals authenticator secrets and keys the licence-key hashes (`HMAC`). A different value makes every issued licence key unverifiable and breaks Owner MFA          | Server environment                     |
| **`CONTROL_SIGNING_KEY`** (Ed25519 private key)                                        | Installs accept only grants signed by it. A new key would require re-activating every install                                                                     | Server environment                     |
| **Public address** (preferably a custom domain)                                        | Installs report to a stored address; Owner/client builds know a default address                                                                                   | DNS                                    |
| Vendor licence signing key (`~/.fastfood/vendor-license-private.pem` on the vendor PC) | Signs legacy licence documents; not on the server                                                                                                                 | Vendor PC — unchanged by a server move |

There are **no uploaded files on the server's disk**: receipt photos, checklist/incident
evidence and asset photos are stored in PostgreSQL (`evidence_files`, …), so the database
backup contains them. Logs are not needed for a move.

Licences are never reissued: the `control_licenses` rows (key hashes, expiry, device
limits) and `control_activations` (one per installed device) are restored as they are.

## 2. Environment variable names

Values are never written in this repository. `deploy/vps/fastfood.env.example` is a
fill-in template.

| Name                                                                                                                       | Secret                              | Purpose                                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `NODE_ENV`                                                                                                                 | no                                  | `production`                                                              |
| `HOST`, `PORT`                                                                                                             | no                                  | Listen address/port (the reverse proxy forwards to it)                    |
| `APP_ORIGIN`                                                                                                               | no                                  | Public HTTPS address; used for CORS, cookies and payment callback URLs    |
| `TRUST_PROXY`                                                                                                              | no                                  | Number of proxy hops in front (1 for Caddy/Render)                        |
| `DATABASE_URL`                                                                                                             | **yes**                             | PostgreSQL connection string (`sslmode=verify-full` for remote databases) |
| `APP_SECRET_KEY`                                                                                                           | **yes**                             | See section 1 — transfer unchanged                                        |
| `CONTROL_PLANE`                                                                                                            | no                                  | `true` on the central server                                              |
| `CONTROL_SIGNING_KEY`                                                                                                      | **yes**                             | See section 1 — transfer unchanged                                        |
| `CONTROL_RELOCATE_URL`                                                                                                     | no                                  | Old server only: new address announced to installs                        |
| `CONTROL_URL`, `CONTROL_PUBLIC_KEY`, `CONTROL_DEVICE_KEY`                                                                  | key = public / device key = **yes** | Install side (desktop launcher sets them); not used on the central server |
| `METRICS_TOKEN`                                                                                                            | **yes**                             | Optional bearer token of `/api/metrics`                                   |
| `CREDENTIAL_RATE_LIMIT`, `SIGNUP_RATE_LIMIT`                                                                               | no                                  | Rate limits                                                               |
| `SERVE_FRONTEND`, `ALLOW_SAME_HOST_ORIGIN`, `SELF_HOSTED`, `INSTALL_ID`, `INSTALLED_AT`, `LICENSE_STATUS_URL`, `LOG_LEVEL` | no                                  | Install/desktop/diagnostic options; not needed on the central server      |

Secrets are transferred only through a channel you control (encrypted archive handed
over in person or an encrypted file copied with `scp`), never through chat, e‑mail or
this repository. Check them with fingerprints, not by reading them (section 6).

## 3. Server address and the apps

- **Use a custom domain** (for example `control.<your-domain>`) from now on and keep it
  as the only address you hand out. Render supports custom domains: point the domain at
  Render today, and a later move is only a DNS change.
- **Client EXE.** The address baked at build time can be overridden **without
  rebuilding**: put `{"url":"https://control.example.uz"}` in
  `%APPDATA%\FastFood-Data\control-server.json` (or set `FASTFOOD_CONTROL_URL`). The public
  signing key stays the baked one, because a moved server keeps its key.
- **Already activated installs** store the address they report to. Two ways to switch
  them, both verified (the new address must answer a signed heartbeat for that same
  activation, signed by the trusted key, before it is adopted — otherwise nothing changes):
  1. _Automatic:_ set `CONTROL_RELOCATE_URL` on the **old** server. Every install learns the
     new address from its next signed heartbeat answer (about a minute) and switches.
  2. _Manual:_ Litsenziya → «Markaziy server manzili» → «Manzilni almashtirish» on that
     install (same verification).
- **Owner EXE.** Menu **Owner → Server manzili…** changes the address (https only, the
  address must answer `/api/control/info` as a control plane, confirmation dialog).
  The device key and the approved-device status are kept.
- Android phones talk to the restaurant computer, not to the central server: nothing to do.

## 4. Backup and restore

All state is in PostgreSQL. Two equivalent methods:

**A. Built-in logical backup** (no extra tools; verifies itself by restoring into a scratch
database and comparing row counts per table):

```
npm run backup -w backend -- create /path/fastfood-YYYY-MM-DD.ndjson.gz
npm run backup -w backend -- verify /path/fastfood-YYYY-MM-DD.ndjson.gz
npm run db:migrate                       # on the NEW empty database
npm run backup -w backend -- restore /path/fastfood-YYYY-MM-DD.ndjson.gz
```

`restore` needs an empty, already migrated database; it replaces the rows the migrations
seed (for example plans) with the backed-up ones.

**B. `pg_dump`** (available on a VPS): `pg_dump -Fc -f fastfood.dump "$DATABASE_URL"` and
`pg_restore --no-owner -d "$NEW_DATABASE_URL" fastfood.dump`.

What to check after a restore (run against the new database): the counts of
`control_customers`, `control_licenses`, `control_activations`, `control_policies`,
`control_owners`, `control_owner_devices`, `control_audit_logs`, `tenants`, `users`,
`orders` equal those of the old database. `scripts/verify-server.mjs` (section 6) compares
the keys; the backup tool's own verification compares every table.

Schedule backups on the new server with `deploy/vps/fastfood-backup.timer` (daily, 14 days
kept) and copy the folder to another machine. Test a restore on a scratch database
at least once a month.

## 5. Installing on a VPS (Ubuntu 24.04 example)

1. Packages: PostgreSQL 17, Node.js 24, Caddy 2, git. Create the database and a user
   (password from a password manager). Create a system user `fastfood`.
2. Code: `git clone <repository> /opt/fastfood`, then
   `npm ci --include=dev && npm run build`.
3. Environment: `/etc/fastfood/fastfood.env` from `deploy/vps/fastfood.env.example`
   (`chown root:fastfood`, `chmod 640`). Put the **same** `APP_SECRET_KEY` and
   `CONTROL_SIGNING_KEY` as the old server.
4. Database: restore (section 4) **or**, for a brand-new database, `npm run db:migrate`
   (the unit's `npm start` also applies pending migrations on every start).
5. Service: `deploy/vps/fastfood.service` → `/etc/systemd/system/`, then
   `systemctl enable --now fastfood`.
6. HTTPS: `deploy/vps/Caddyfile` → `/etc/caddy/Caddyfile` with your domain; Caddy obtains the
   certificate. Open ports 80 and 443 only; PostgreSQL stays on `127.0.0.1`.
7. Scheduled jobs: **none outside the application.** Print queue, licence sync, billing
   lifecycle, notification delivery, webhooks and the control heartbeat are timers inside
   the server process, so a single running instance is enough. Only the backup timer
   (section 4) is external.
8. Socket.io (`/api/realtime`) and the Android alert stream (`/api/live/alerts`) pass through
   the Caddyfile above; with another proxy enable WebSocket upgrade and disable response
   buffering for these paths.
9. Telegram bots **poll** from inside the server. Two running servers with the same bot
   tokens fight each other, so the old server must be stopped (or its bots disabled) when
   the new one takes over.
10. Payment providers (Click, Payme, Uzum): callback/redirect URLs are built from
    `APP_ORIGIN`. After the cut-over, enter the new URLs shown on the payments page (_To‘lovlar_) in each
    provider's merchant cabinet. Do this on the day of the switch; payments in flight
    during the switch are confirmed by the provider's retries.
11. Backups of the VPS itself (provider snapshots) are not a substitute for section 4.

## 6. Verifying a server

```
node scripts/verify-server.mjs https://new.example.uz --compare https://old.example.uz
```

It checks HTTPS, `/api/health/live` and `/ready` (database), HSTS, that the control plane
is on, Socket.io, that the Android alert stream is reachable, the Owner page, and — with
`--compare` — that the **signing key fingerprint** and the **`APP_SECRET_KEY` check value**
equal the old server's (both are published, secret-free, by `/api/control/info`). A mismatch
means the keys were not carried over: stop and fix it before switching anything.

Then, with a test Owner or the real one: sign in from the Owner EXE (an approved device
keeps working), open one customer, confirm its licence, devices and policy are there.

## 7. Pilot first: one register

Do not move every restaurant at once.

1. Build **test packages** (`BUILD_CHANNEL=test`, separate profile and ports) pointing at the
   _new_ server's staging copy (a restored copy of a backup, never the production database).
2. Choose one restaurant and **one cash register**. On that register only, set
   `control-server.json` to the new address (or use «Manzilni almashtirish»).
3. Watch for a full business day: heartbeat in the Owner (online), a policy change arrives,
   an order and a payment work, offline→online sync completes, the licence still shows its
   original expiry, no new activation appeared.
4. Only then set `CONTROL_RELOCATE_URL` on the old server so the rest follow.

## 8. Cut-over runbook

1. **T‑7 days:** custom domain in place; new server installed and verified from a restored
   copy; pilot (section 7) passed.
2. **Window (a quiet hour):** announce it. On the old server stop writes: scale it down or
   put it in maintenance (installs keep working from their offline grant for the period the
   Owner configured — check `maxOfflineMinutes` of each customer first).
3. Final backup → restore into the new database → `verify-server.mjs --compare`.
4. Switch DNS to the new server (low TTL set a day earlier). Old and new must not both
   accept traffic for long: Telegram bots and the print/notification workers are single-instance.
5. Update payment-provider callback URLs (section 5.10).
6. On the **old** server (still reachable at its old address) set `CONTROL_RELOCATE_URL` to
   the new https address so installs that still use the old address switch by themselves.
   The old server needs its database and keys only to answer these heartbeats; keep it
   until the Owner shows every install on the new address (last contact times).
7. Watch the Owner overview and audit for a day. Then retire the old server.

## 9. Rollback

- Before step 4 of the runbook nothing was switched: just stop the new server.
- After DNS moved: point DNS back to the old server (still holding the old database and
  keys). Installs that already adopted the new address use whichever server answers that
  address, so switch DNS, not individual installs. If the new server accepted writes, take a
  backup of it first and decide which side holds the truth: the old database does not
  contain the new server's later heartbeats, which is harmless (they repeat), but may lack
  newly created licences or policy changes — copy those through the Owner panel.
- An install can always be returned manually (Litsenziya → «Markaziy server manzili»).
- Never delete the old database or the keys until the new server has run for a full billing
  period and backups of the new server restore cleanly.

## 10. Known limits

- **Render free database expires on 2026‑11‑14.** Moving (or paying for the database) must
  happen before that date; take a backup well before and test it.
- The VPS files in `deploy/vps/` are templates written for this server; they were not run on
  a real VPS in this repository's checks. The Caddy and systemd files have not been validated
  by `caddy validate` / `systemd-analyze verify` here. Run both on the VPS before the pilot.
- Restaurants that run on their own computer keep their data there; moving the central
  server does not move or touch it.
