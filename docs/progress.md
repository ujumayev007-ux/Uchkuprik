# Progress

Read this first when resuming work. Details: `implementation-plan.md`, `decisions.md`, `security.md`, `api-contracts.md`.

## Phase status

| Phase                           | Status                                                |
| ------------------------------- | ----------------------------------------------------- |
| 1 Foundation                    | Accepted 2026-10-12 (CI run 38213267724)              |
| 2 Core database and security    | Accepted 2026-10-12 (CI run 38217691786)              |
| 3 Core restaurant configuration | Accepted 2026-10-12 (CI run 38220426823)              |
| 4 Admin and cashier POS         | Accepted 2026-10-12 (CI run 38233375759)              |
| 5 Kitchen and real-time         | Accepted 2026-10-12 (CI run 38236006895)              |
| 6 Warehouse and recipes         | Accepted 2026-10-12 (CI run 38237834743)              |
| 7 Customer ordering             | Implemented and validated locally; CI pending on push |
| 8–16                            | Not started                                           |

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

## Phase 4 — delivered

- Order engine with state machine, server pricing and modifier validation, daily order numbers, idempotency, row locking, append-only events.
- Touch POS (`/kassa`): categories, search, size/modifier picker, cart, order types, tables, delivery details, shift gate; payment dialog with split/partial payments, quick cash and change; success screen and 80 mm receipt.
- Orders page with detail, history, discount, item/order cancellation, refunds, pay remaining, complete.
- Cashier shift page: open, pay-in/out, close with counted cash and variance, Z-report print, shift history.
- Sales report with payment methods, top products, cashiers and (finance.view only) gross profit.
- Evidence: 36 unit, 36 integration (10 new financial tests incl. concurrent double-payment), 16 Playwright tests (POS flow: 130 000 total, 200 000 received, 70 000 change).
- Deferred: favourites, combos, customer debt (Phase 9), printer adapters and real-time sync (Phase 5), online payment providers and fiscal receipts (Phase 8), attendance clock-in (Phase 10).

## Phase 5 — delivered

- Socket.io real-time layer (cookie auth, tenant/branch rooms, origin check, revalidation, refetch on reconnect) and live indicator in the shell.
- Kitchen display (`/oshxona`): station filter, tickets sorted by rush/age, timers with prep-time colours, tap-to-advance items, bump preparing/ready, serve.
- Queue TV (`/navbat`): preparing/ready numbers, Uzbek voice announcement with chime fallback.
- Kitchen stations (menu tab) and category routing; printers page with test page, job list and retry; ESC/POS kitchen tickets printed once per item.
- Evidence: 40 unit, 41 integration (5 new: socket isolation/auth, routing, status derivation, priority, TCP printing with retry), 18 Playwright (live POS → kitchen → queue).
- Deferred: Redis adapter (multi-instance), local print agent for cloud deployments, kitchen performance metrics (Phase 10).

## Phase 6 — delivered

- Stock items with packaging units, default warehouse per branch, immutable stock ledger with row-locked balances and weighted average cost.
- Suppliers with debt and payments; purchases (draft → receive) in packaging units.
- Recipes per variant with live recipe cost; automatic deduction on order completion; configurable negative-stock rule.
- Waste, adjustments, stocktake with differences, inter-branch transfers, low-stock alerts with reorder suggestion.
- UI: Ombor page (stock, purchases, suppliers, ledger), recipe dialog on menu cards, settings toggle.
- Evidence: 40 unit, 48 integration (7 new), 20 Playwright tests.
- Deferred within §9: batch/lot and expiry tracking (FEFO), prepared-ingredient production, approval-based purchasing, demand forecasting (Phase 14), modifier-option recipes.

## Phase 7 — delivered

- Public storefront `/r/:slug` (branch, takeaway/delivery, menu, cart, checkout) and table QR menu `/t/:token`; order tracking `/buyurtma/:token`.
- PENDING online orders through the shared engine; staff approve/reject from a live banner (chime), approval sends the order to the kitchen.
- Settings toggle with public link; printable table QR cards.
- Evidence: 40 unit, 53 integration (5 new), 24 Playwright tests (guest QR order → live approval → tracking; website delivery).
- Deferred: Telegram Mini App channel (Phase 9/14), customer accounts and loyalty (Phase 9), online payment (Phase 8).

## Open items

1. **Render needs `APP_SECRET_KEY`** before deploying Phase 2 (see `render-setup.md`), and a first platform admin via `npm run admin:create`.
2. Approved 100-item requirements register still not supplied; traceability uses master-prompt sections.
3. `fastfood-saas/` ownership undecided (D-002).
4. Main JS bundle ~670 kB; add route-level code splitting (Phase 15 performance work at the latest).
5. Attendance/shift clock-in from §4 is scheduled with cashier shifts (Phase 4) and HR (Phase 10).

## Local database

No Docker here. A real PostgreSQL 17 runs from `embedded-postgres` binaries started with `pg_ctl` on port 5433 (outside the repo). CI remains the authoritative database gate.

## Next step

Phase 8 — Payments and fiscal integrations: provider adapter interface (Click, Payme, Uzum), signed webhook verification with replay protection, idempotent payment capture into the existing ledger, reconciliation report, fiscal receipt adapter interface. Real provider credentials and fiscal certification are external dependencies and must be documented, not simulated.
