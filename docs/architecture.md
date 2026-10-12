# Architecture

## Inspection baseline

The workspace originally contained empty `README.md`, `.gitignore`, two `package.json` files, backend TypeScript configuration and entry point, and frontend Vite configuration and `App.tsx`. Empty folders suggested a React/Vite frontend and Node/Prisma backend. There was no executable feature, dependency lockfile, environment configuration, database schema, migration, authentication, or Git repository. No working user code was replaced.

## Phase 1 decisions

- Preserve the `frontend/` and `backend/` layout and use npm workspaces with one lockfile.
- Use React/Vite for the existing frontend entry point and modular Express for the backend. Keep TypeScript strict in both workspaces.
- Use PostgreSQL with a bounded `pg` pool for the foundation read-only health query. Prepare Prisma configuration now; introduce generated Prisma repositories alongside reviewed domain models in Phase 2.
- Separate app construction from process startup so HTTP behavior can be tested without listening on a fixed port.
- Use an explicit Uzbek message catalog in each application boundary. Add reviewed Russian and English catalogs later; do not mix untranslated default labels into the UI.
- Provide a genuine service-status page until authenticated restaurant functionality exists. No dashboard metrics, transactions, or role identities are fabricated.
- Use Docker only for local PostgreSQL at this stage. Redis, queues, Socket.io, storage, and distributed infrastructure are introduced when their workflow requires them.

## Runtime flow

```text
Browser -> same-origin /api proxy -> Express -> bounded PostgreSQL pool
                                    |
                                    +-> structured, sanitized request logs
```

In the compiled Render deployment, Express also serves `frontend/dist` directly. Frontend and API share one origin and one port; the Vite proxy is only used during development. The repository root remains the build context because backend and frontend depend on shared workspace configuration.

`GET /api/health/live` checks process availability without database access. `GET /api/health/ready` executes `SELECT 1`, returns 503 on failure, and becomes unavailable during graceful shutdown. Database outages do not crash the API or masquerade as healthy readiness.

## Planned domain boundaries

Identity and access; organizations/brands/branches; menu; order engine; payments; shifts; kitchen; inventory; customers; delivery; HR; finance; subscriptions; franchise; operational compliance; platform operations. Keep them in a modular monolith first. Domain services will own transactions; channels must call the same order engine.

The initial status API exposes no tenant data. Phase 2 must introduce verified identity and tenant/branch scoping before any business endpoint is exposed. Health endpoints are intentionally public.

## References

- [Vite getting started](https://vite.dev/guide/)
- [Prisma configuration reference](https://docs.prisma.io/docs/orm/reference/prisma-config-reference)
- [Prisma PostgreSQL connector](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql)
