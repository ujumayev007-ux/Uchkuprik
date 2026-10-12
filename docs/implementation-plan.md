# Implementation plan

## Phase 1: foundation

Smallest safe increment: initialize the existing empty layout, validate configuration, connect a read-only database probe, expose health APIs, display their actual state in Uzbek, and add reproducible checks and documentation.

| Step | Work                                                             | Acceptance evidence                                           |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| 1    | Focused repository inspection                                    | Baseline recorded in architecture document                    |
| 2    | Strict TypeScript workspaces, dependency lock, environment setup | Clean install, typecheck, production build                    |
| 3    | PostgreSQL/Prisma configuration and health API                   | Real database integration suite, unavailable-connection check |
| 4    | Uzbek status UI, responsive layout, themes, failure/retry states | Desktop and mobile E2E checks                                 |
| 5    | Security baseline, CI, required documents                        | HTTP security tests, audit, formatting, diff review           |
| 6    | Commit and configured-branch push                                | Commit hash and matching remote HEAD                          |

Do not start Phase 2 until local acceptance gates pass and Git delivery blockers are resolved. No business tables or migrations are created in Phase 1.

## Approved phase sequence

| Phase | Scope                                      | Dependency / exit gate                                                                                        |
| ----- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 1     | Foundation                                 | Repeatable setup, real connectivity, checks, Git delivery                                                     |
| 2     | Core database and security                 | Tenant/branch models, hashed passwords/PINs, MFA, sessions, permission and isolation tests, migrations, audit |
| 3     | Restaurant configuration                   | Authorized persistent profiles, rooms/tables, staff, menu/pricing                                             |
| 4     | Admin/cashier POS                          | Server-priced orders, transactional cash/shift/refund flows, receipts, critical integration tests             |
| 5     | Kitchen and real-time operations           | Isolated events, permitted state transitions, reconnect behavior, printer adapters                            |
| 6     | Warehouse and recipes                      | Inventory ledger and transactional deductions, negative-stock rules                                           |
| 7     | Customer ordering                          | Shared order engine, QR/web channels, approval flows                                                          |
| 8     | Payments and fiscal integrations           | Verified provider callbacks, idempotency, reconciliation, documented approvals                                |
| 9     | Delivery, CRM, loyalty                     | Assigned couriers, consent, delivery states, loyalty integrity                                                |
| 10    | Finance, HR, reporting                     | Authorized ledgers/reporting, configurable labor/payroll rules                                                |
| 11    | SaaS commercial platform                   | Tenant onboarding, server-enforced plans and entitlements, billing                                            |
| 12    | Multi-brand and franchise                  | Delegated scope, contracts, royalties, central controls                                                       |
| 13    | Enterprise operations                      | Food safety, SOP, maintenance, learning, approvals                                                            |
| 14    | Enterprise infrastructure and intelligence | Security/observability, analytics, governance, resilience, developer platform                                 |
| 15    | Multi-platform delivery                    | PWA, offline queue integrity, mobile/Windows distribution, device lifecycle                                   |
| 16    | Acceptance and production readiness        | Pilot, migration rehearsal, recovery drill, security review, monitored deployment and final approval          |

Later phases require separate testable increments and detailed contracts before implementation. The plan preserves scope but does not mark unbuilt features complete.
