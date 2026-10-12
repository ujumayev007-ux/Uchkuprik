# Progress

Read this first when resuming work. Details: `implementation-plan.md`, `decisions.md`, `security.md`, `api-contracts.md`.

## Phase status

| Phase                        | Status                                                            |
| ---------------------------- | ----------------------------------------------------------------- |
| 1 Foundation                 | Accepted 2026-10-12 (CI run 38213267724)                          |
| 2 Core database and security | Implemented and validated locally (see below); CI pending on push |
| 3–16                         | Not started                                                       |

## Phase 2 — delivered

- Schema + migration `identity_and_security`: tenants (incl. reserved platform tenant), branches, users, roles, user_roles, user_branches, devices, sessions, append-only audit_logs.
- Auth: password login, lockout, TOTP MFA (forced for platform admins), device-bound 4-digit PIN with touchscreen keypad, sessions with idle/absolute expiry and revocation, step-up re-authentication, password change/reset, suspended-tenant blocking.
- Admin: users (create/edit/disable/PIN/password/unlock/revoke sessions), roles and permission matrix with anti-escalation, branches, devices, tenant audit log, platform tenants + platform audit log, account security page.
- Tools: `npm run admin:create` (first platform admin), `npm run seed:demo -w backend` (dev/E2E only).
- Evidence (local, real PostgreSQL 17): 36 unit tests, 19 integration tests, 10 Playwright tests (desktop + mobile), format, typecheck, builds, deploy smoke.

## Open items

1. **Render needs `APP_SECRET_KEY`** before deploying Phase 2 (see `render-setup.md`), and a first platform admin via `npm run admin:create`.
2. Approved 100-item requirements register still not supplied; traceability uses master-prompt sections.
3. `fastfood-saas/` ownership undecided (D-002).
4. Main JS bundle ~670 kB; add route-level code splitting (Phase 15 performance work at the latest).
5. Attendance/shift clock-in from §4 is scheduled with cashier shifts (Phase 4) and HR (Phase 10).

## Local database

No Docker here. A real PostgreSQL 17 runs from `embedded-postgres` binaries started with `pg_ctl` on port 5433 (outside the repo). CI remains the authoritative database gate.

## Next step

Phase 3 — core restaurant configuration: restaurant profile/settings, rooms and tables, menu categories, products with variants/modifiers, branch prices and internal costs (cost visible only with `menu.cost.view`).
