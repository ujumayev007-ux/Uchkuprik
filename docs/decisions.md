# Decision log

Newest first. Each entry records the decision, its reason, and what would reverse it.

## D-009 — Online ordering flow (2026-10-12)

- **Decision:** QR and website orders enter a dedicated `PENDING` status and are approved by staff with `orders.approve` (waiters and cashiers by default) before the kitchen sees them; customers track via a token link with polling; payment happens at the counter until verified online payments exist (Phase 8). Online ordering is disabled per tenant by default.
- **Reason:** The master prompt requires approval of unpaid online orders and forbids treating unverified payments as paid.
- **Reversal:** Auto-accept paid orders once provider-verified payments land in Phase 8.

## D-008 — Inventory model (2026-10-12)

- **Decision:** Base-unit decimal quantities (g/ml/pcs) with packaging-unit conversion at entry; weighted average costing per warehouse; recipes per variant deducted when an order is COMPLETED (not when placed), so cancellations need no reversal; one default warehouse per branch; inter-branch transfers are immediate (no in-transit state); negative stock allowed by default and configurable per tenant.
- **Reason:** Matches common fast-food practice (deduction at sale close) with exact arithmetic and a single audited write path.
- **Reversal:** Add lots/expiry (FEFO), in-transit transfers, prepared-ingredient production and modifier recipes in a follow-up increment.

## D-007 — Real-time and printing architecture (2026-10-12)

- **Decision:** Socket.io events are notifications only; REST remains the single read/write path, and every reconnect triggers a refetch ("replay by refetch"). An in-process event bus serves one API instance. Kitchen printing is server-side raw TCP (ESC/POS) through a durable `print_jobs` queue; receipts print from the browser (80 mm layout).
- **Reason:** No authorization logic or financial data duplicated in socket payloads; at-least-once printing with retries and a recovery screen.
- **Reversal:** Add the Socket.io Redis adapter and a Redis/Postgres bus for multiple instances; add a local print agent for cloud deployments whose server cannot reach restaurant LANs (Phase 15).

## D-006 — Counter payments and refund approval (2026-10-12)

- **Decision:** The POS records CASH and CARD (external bank terminal, optional slip reference) only. Click, Payme and Uzum are rejected as manual entries and will only be accepted from verified provider callbacks (Phase 8). Refund approval = `payments.refund` permission plus password re-authentication by the approver; cashiers do not hold it by default. Paying a DRAFT order places it.
- **Reason:** Never simulate or self-declare online payments; a 4-digit PIN session cannot approve money leaving the business.
- **Reversal:** Add an in-store supervisor-override flow if owners require it, still without PIN-only approval.

## D-005 — Phase 2 identity architecture (2026-10-12)

- **Decision:** Prisma 7 client (pg adapter) for persistence with hand-reviewed SQL migrations. Platform administrators live in a reserved `PLATFORM` tenant so one `(tenantId, username)` uniqueness rule covers everyone. Opaque server-side sessions in SameSite=Strict httpOnly cookies (no JWT). scrypt via Node crypto (no native deps) for passwords and PINs; PIN input is HMAC-keyed with a secret derived from `APP_SECRET_KEY`. PIN login only on registered devices; PIN sessions can never step up. TOTP implemented in-house (RFC 6238 vectors tested). Branch access = all branches or explicit list.
- **Reason:** Instant revocation, simple CSRF story, no extra infrastructure, and a 4-digit PIN is never the sole protection for administrative operations.
- **Reversal:** Move rate limiting/session cache to Redis when running multiple instances.

## D-004 — CI is the authoritative database gate (2026-10-12)

- **Decision:** Database acceptance gates are satisfied by the GitHub Actions run against a real PostgreSQL, since no local database is available. Phase 1 accepted on run 38213267724.
- **Reversal:** Run gates locally too once Docker or native PostgreSQL is available.

## D-003 — Commit the non-database Phase 1 foundation before the database gate (2026-10-12)

- **Decision:** Commit and push the foundation that passes formatting, typecheck, unit/API tests, builds, and the deploy smoke test, even though the real PostgreSQL integration gate has not passed.
- **Reason:** Approved by the user. Remote `main` contained only backend files, so the remote checkout was not runnable. Local Docker cannot start (virtualization disabled), and no native PostgreSQL is installed.
- **Constraint:** Phase 1 stays **not accepted** until `npm run db:check`, `npm run test:integration`, and E2E with `REQUIRE_DATABASE=true` pass against a real database (locally or in CI). Phase 2 must not start before that.

## D-002 — `fastfood-saas/` is excluded pending ownership (2026-10-12)

- **Decision:** An untracked parallel scaffold (`fastfood-saas/`, NestJS + Redis + i18n package) appeared in the working tree. Its origin is unknown to the user. It is left untouched, excluded from Prettier (`.prettierignore`) and from Git via the local `.git/info/exclude`, and is not committed.
- **Reason:** Two competing foundations must not both be canonical; deleting or merging unknown work would violate the repository protection rules.
- **Reversal:** If the user adopts it, plan a migration increment; if rejected, the user may archive it outside the repo.

## D-001 — Root stack (2026-10-12)

- **Decision:** The canonical codebase is the root npm workspace: Express 5 + Zod (backend), React + Vite (frontend), PostgreSQL + Prisma, Vitest, Playwright, GitHub Actions, Render single-service deployment.
- **Reason:** It existed first, is tested, and satisfies the master prompt's "modular Express" option. NestJS is not required.
