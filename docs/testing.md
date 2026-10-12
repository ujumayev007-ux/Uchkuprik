# Testing

## Commands and evidence

| Command                        | Coverage                                                                                                                            | Dependency                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `npm run format:check`         | Repository formatting                                                                                                               | Installed dev tools                                     |
| `npm run typecheck`            | Strict frontend/backend types                                                                                                       | Installed dependencies                                  |
| `npm test`                     | Environment validation, real Express request handling, readiness failures, CORS, headers, redaction, rate limit, shutdown readiness | No database; probe dependency controlled by tests       |
| `npm run build`                | Backend JS and frontend production assets                                                                                           | Installed dependencies                                  |
| `npm run db:validate`          | Prisma configuration/schema validity                                                                                                | Root environment                                        |
| `npm run db:check`             | Read-only query using actual PostgreSQL connection                                                                                  | Running PostgreSQL                                      |
| `npm run test:integration`     | Real query and health API plus rejected real connection                                                                             | Running PostgreSQL; no skip fallback                    |
| `npm run test:e2e`             | Real API status, retry, theme, mobile layout; explicit network/invalid-payload tests                                                | Chromium; real DB required when `REQUIRE_DATABASE=true` |
| `npm audit --audit-level=high` | Known runtime and development dependency advisories                                                                                 | Registry access                                         |

`npm run check` runs formatting, type checks, unit/API checks, and both production builds. PostgreSQL integration is a separate mandatory acceptance gate so an unavailable database is never hidden by skipped tests. CI starts a real PostgreSQL service and requires a healthy database in browser tests.

`npm run test:deploy` starts the compiled root `npm start` entry point with production validation and checks the Uzbek HTML, compiled JavaScript, API routes, protected file paths, and honest 503 readiness when PostgreSQL is unavailable. This validates Render packaging without claiming a live Render deploy or a healthy database.

Test fixtures contain synthetic credentials only. Tests perform no destructive database operations. Browser error simulations are test-only and are not used by application runtime code.

Use `npm audit --audit-level=high` for the complete dependency graph, including development tooling; CI enforces this broader audit.

If Playwright's Chromium download is unavailable on Windows but Google Chrome is installed, set `$env:PLAYWRIGHT_CHANNEL='chrome'` before running `npm run test:e2e`. This starts a separate headless test browser and does not use the user's browser profile. CI installs Chromium directly.

Each increment must record actual outcomes and blockers in the delivery report. A committed workflow is not evidence that remote CI ran successfully. No restaurant workflow, tenant isolation, payment, or inventory test is claimed before its implementation phase.
