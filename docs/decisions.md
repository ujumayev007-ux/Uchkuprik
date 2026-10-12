# Decision log

Newest first. Each entry records the decision, its reason, and what would reverse it.

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
