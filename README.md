# Uchkuprik — FAST FOOD SaaS

A restaurant management platform developed in acceptance-gated increments. Application text is Uzbek; engineering documentation is English.

## Current scope

Phase 1 foundation: strict TypeScript npm workspaces, a React/Vite status screen, an Express API, validated environment configuration, a real read-only PostgreSQL probe, Prisma schema configuration, automated tests, and a GitHub Actions workflow. Restaurant operations, authentication, tenants, and business persistence start in later phases. This is not a production-ready POS yet.

## Local development

Prerequisites: Node.js 24, npm 11, a running PostgreSQL instance (native or Docker), and available ports 4000, 5173, and 5433. Docker is optional if a native or managed database is already configured.

```sh
npm ci
npm run setup:env
npm run db:up
npm run db:check
npm run dev
```

Open http://localhost:5173. The frontend proxies `/api` to the API on port 4000. The status screen displays the actual readiness response; PostgreSQL downtime produces a visible unavailable state.

`setup:env` creates an ignored root `.env` with a cryptographically random local database password. Existing files are preserved and no credentials are printed. If using an existing PostgreSQL instance, configure `DATABASE_URL` locally and omit `db:up`. Never paste real credentials into Git or chat.

```sh
npm run check
npm run db:validate
npm run test:integration
npx playwright install chromium
npm run test:e2e
```

Integration tests require real PostgreSQL and fail if it is unavailable. Browser tests use the real API by default and cover explicit error cases using controlled network failures. Set `REQUIRE_DATABASE=true` to require the connected state in E2E tests, as CI does.

```sh
npm run build
npm start
```

For the compiled single-service preview, set `APP_ORIGIN=http://localhost:4000` in the launching shell and open that origin. `npm start` serves the compiled frontend and API together. `npm run test:deploy` verifies this packaging with production validation enabled and an intentionally unavailable database. Stop a Compose database with `npm run db:stop`; this preserves its volume. No reset, destructive migration, or volume deletion command is part of setup.

For the existing Render service, follow [Render setup](docs/render-setup.md): repository-root build `npm ci --include=dev && npm run build`, start `npm start`, and a real `DATABASE_URL` in the Render environment. Creating only a Web Service does not create PostgreSQL.

## Documentation

- [Architecture](docs/architecture.md)
- [Requirements and unresolved scope](docs/requirements.md)
- [Implementation plan and gates](docs/implementation-plan.md)
- [Database design](docs/database-design.md)
- [API contracts](docs/api-contracts.md)
- [Security](docs/security.md)
- [Testing](docs/testing.md)
- [Deployment](docs/deployment.md)
- [Existing Render service setup](docs/render-setup.md)
- [Requirements traceability](docs/requirements-traceability.md)

The separate approved 100-item requirements register has not been provided. Do not interpret the master prompt's capability lists as an invented, approved numbered register.
