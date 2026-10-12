# Deployment and environment

## Supported local foundation

Use Node.js 24/npm 11 and the root lockfile. Create environment configuration with `npm run setup:env`, then start the local database with `npm run db:up`. Compose waits for PostgreSQL health before returning. Startup and tests do not migrate, reset, or delete existing databases.

| Variable                                                             | Use                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `NODE_ENV`                                                           | `development`, `test`, or `production`                                 |
| `HOST`                                                               | API bind address; defaults to loopback                                 |
| `PORT`                                                               | API listen port, 1–65535                                               |
| `APP_ORIGIN`                                                         | Exact allowed frontend HTTP(S) origin; HTTPS required in production    |
| `DATABASE_URL`                                                       | Server-only PostgreSQL connection; verified TLS required in production |
| `LOG_LEVEL`                                                          | Validated structured-log severity                                      |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Local Compose database settings                                        |

The root `.env` is loaded without overriding deployment-provided process variables. The frontend receives no server secrets. Vite reads only the API port for its local proxy. Do not add secrets under a `VITE_` prefix.

## Production build and deployment boundaries

`npm run build` emits `backend/dist` and `frontend/dist`. Root `npm start` serves both builds from one Express process and one port. Only `frontend/dist` is exposed as static content; unknown `/api` paths remain JSON 404s. Missing frontend build output fails startup with a clear operator log. Vite development/preview servers are not production hosts. Configure a trusted proxy range deliberately before enabling IP-aware proxy handling; the current rate limit uses socket IPs, so callers behind the same proxy share the foundation quota.

See [Render setup](render-setup.md) for the existing `Uchkuprik` service. Render supplies `PORT` and `RENDER_EXTERNAL_URL`; the configuration uses the latter as the origin fallback and binds to `0.0.0.0` on Render by default. Explicit environment values take precedence. Database validation and verified production TLS remain mandatory. Root `npm start` enables frontend hosting; backend-only development keeps the Vite proxy workflow.

Use liveness for process restarts and readiness for traffic routing; do not restart repeatedly solely because the database is unavailable. SIGTERM/SIGINT stop new traffic and drain connections with a bounded shutdown deadline.

The local Compose database uses a persistent volume and loopback port. It is not a production database deployment. Production release is pending identity/tenant security, deployment-specific secret management, least-privilege database roles, verified TLS, encrypted backups, restore drills, observability, security review, and the final acceptance phase.

### Windows prerequisite blocker observed during initial validation

Docker Desktop reports `Virtual Machine Platform not enabled` and cannot start its Linux engine. Database integration tests therefore receive `ECONNREFUSED 127.0.0.1:5433`. Docker's diagnostic instructs the machine administrator to enable the Windows `VirtualMachinePlatform` optional feature and restart the computer. No Windows feature change or computer restart was performed by this increment. Alternatively, a running native or managed PostgreSQL instance can be configured in the ignored local `.env`.

Once Docker can run, execute `npm run db:up`, `npm run db:check`, and `npm run test:integration`. Then set `REQUIRE_DATABASE=true` and run the browser suite before committing or pushing. Do not disable or skip the failed database tests to pass the gate.

## Git delivery

Never invent a remote, author identity, or target branch. Review the diff, run required checks, commit the increment, push to the configured branch without force, then compare local HEAD with the remote branch. Do not claim push or CI success when a remote is absent or authentication fails.
