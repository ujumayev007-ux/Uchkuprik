# Progress

Read this first when resuming work. Details: `implementation-plan.md`, `decisions.md`, `security.md`, `api-contracts.md`.

## Phase status

| Phase                           | Status                                                |
| ------------------------------- | ----------------------------------------------------- |
| 1 Foundation                    | Accepted 2026-10-12 (CI run 38213267724)              |
| 2 Core database and security    | Accepted 2026-10-12 (CI run 38217691786)              |
| 3 Core restaurant configuration | Implemented and validated locally; CI pending on push |
| 4–16                            | Not started                                           |

## Phase 2 — delivered

- Schema + migration `identity_and_security`: tenants (incl. reserved platform tenant), branches, users, roles, user_roles, user_branches, devices, sessions, append-only audit_logs.
- Auth: password login, lockout, TOTP MFA (forced for platform admins), device-bound 4-digit PIN with touchscreen keypad, sessions with idle/absolute expiry and revocation, step-up re-authentication, password change/reset, suspended-tenant blocking.
- Admin: users (create/edit/disable/PIN/password/unlock/revoke sessions), roles and permission matrix with anti-escalation, branches, devices, tenant audit log, platform tenants + platform audit log, account security page.
- Tools: `npm run admin:create` (first platform admin), `npm run seed:demo -w backend` (dev/E2E only).
- Evidence (local, real PostgreSQL 17): 36 unit tests, 19 integration tests, 10 Playwright tests (desktop + mobile), format, typecheck, builds, deploy smoke.

## Phase 3 — delivered

- Restaurant profile/settings (legal name, STIR, receipt texts, service charge, tenant MFA policy).
- Rooms and tables per branch with rotatable QR tokens.
- Menu: category tree, products with sizes/variants, modifier groups, branch price overrides and stop-list availability, internal cost hidden without `menu.cost.view`, soft delete, version counter with before/after audit snapshots.
- Server pricing service `priceVariants()` for Phase 4 orders.
- Evidence: 36 unit, 26 integration (7 new), 14 Playwright tests (4 new), deploy smoke.
- Deferred within §8: combos/bundles, scheduled pricing, approval workflow, bulk import/export, channel sync, image upload (needs object storage).

## Open items

1. **Render needs `APP_SECRET_KEY`** before deploying Phase 2 (see `render-setup.md`), and a first platform admin via `npm run admin:create`.
2. Approved 100-item requirements register still not supplied; traceability uses master-prompt sections.
3. `fastfood-saas/` ownership undecided (D-002).
4. Main JS bundle ~670 kB; add route-level code splitting (Phase 15 performance work at the latest).
5. Attendance/shift clock-in from §4 is scheduled with cashier shifts (Phase 4) and HR (Phase 10).

## Local database

No Docker here. A real PostgreSQL 17 runs from `embedded-postgres` binaries started with `pg_ctl` on port 5433 (outside the repo). CI remains the authoritative database gate.

## Next step

Phase 4 — Admin and cashier POS: orders with server-side pricing, cart, dine-in/takeaway/delivery, cash payments with change, receipts, cashier shifts (open/close, expected vs actual cash), refunds with approval, basic reports.
