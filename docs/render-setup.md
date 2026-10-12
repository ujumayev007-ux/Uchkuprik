# Render setup: existing Uchkuprik service

Target: `https://uchkuprikfastfood.onrender.com`, repository `ujumayev007-ux/Uchkuprik`, branch `main`.

The screenshot shows a failed deployment of `37475eb`. That commit includes only backend files and lacks the workspace manifest, root TypeScript configuration, frontend, and lockfile. This is a confirmed repository dependency problem; the exact Render build log has not been retrieved. Uploading only `backend/` cannot build this workspace correctly.

## 1. Create PostgreSQL

In Render, choose **New → Postgres** and create a database for this project. The database is a separate resource from the existing Web Service. Select the same region as the service. Review the available plan and its limits before creating it; do not assume a free database is suitable for production retention or availability. No database is provisioned automatically by this change.

This foundation requires verified database TLS in production. For a Render database, use its **External Database URL**, with `sslmode=verify-full` as a query parameter. If the URL has no query string, append `?sslmode=verify-full`; otherwise add/update the parameter with `&`. Use the full hostname, never one of its resolved IP addresses. Do not put the URL in source code or chat.

Render documents that its private internal database endpoints use self-signed certificates and do not support `verify-full`. This increment deliberately retains certificate verification and uses the public, Render-managed TLS endpoint. A private endpoint requires a separately reviewed trust configuration before use. If external access is restricted, allow the complete outbound ranges shown by this Web Service's **Connect → Outbound** panel. The previously supplied ranges are `74.220.48.0/24` and `74.220.56.0/24`; recheck the panel when changing regions or network settings.

## 2. Configure the existing Web Service

Open **Uchkuprik → Settings** and use:

| Field             | Value                                   |
| ----------------- | --------------------------------------- |
| Branch            | `main`                                  |
| Root Directory    | Empty (repository root), not `backend`  |
| Build Command     | `npm ci --include=dev && npm run build` |
| Start Command     | `npm start`                             |
| Health Check Path | `/api/health/ready`                     |

The root `.nvmrc` selects Node.js 24. Remove/update any conflicting older `NODE_VERSION` override. The build needs development dependencies because TypeScript and Vite compile the applications. `npm start` serves `frontend/dist` and the API from one Express process. No Vite development server or second public port is needed.

In **Environment**, configure:

| Key              | Value                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`       | `production`                                                                                                                                                                               |
| `HOST`           | `0.0.0.0`                                                                                                                                                                                  |
| `APP_ORIGIN`     | `https://uchkuprikfastfood.onrender.com`                                                                                                                                                   |
| `DATABASE_URL`   | Your database's external URL with `sslmode=verify-full`                                                                                                                                    |
| `APP_SECRET_KEY` | 32 random bytes, base64. **Required since Phase 2.** Generate once (for example with `openssl rand -base64 32`) and keep it stable: changing it invalidates MFA enrolments and staff PINs. |

`npm start` applies pending database migrations (`prisma migrate deploy`, non-destructive) before starting. Create the first platform administrator once from the Render Shell: `PLATFORM_ADMIN_USERNAME=<login> PLATFORM_ADMIN_PASSWORD=<strong password> npm run admin:create`, then sign in with business code `platform` and enrol MFA. On Render, `TRUST_PROXY` defaults to 1.

Optional: `CREDENTIAL_RATE_LIMIT` (logins, PIN and public orders per IP per minute, default 20). For online payments register the callback URLs shown on the "Onlayn to‘lovlar" page in the Payme/Click merchant cabinets; they must be reachable over public HTTPS.

Render supplies `PORT` automatically; do not copy the local `.env` to Render. The code also understands Render's `RENDER_EXTERNAL_URL` if `APP_ORIGIN` is absent. A custom domain requires updating `APP_ORIGIN` accordingly. `DATABASE_URL` remains required; a missing or invalid database configuration must not appear as a healthy deployment.

`render.yaml` records equivalent settings for a future Blueprint. Merely committing that file does not reconfigure an existing manually created service.

## 3. Validate and deploy

Before commit/push, run the repository checks and the real database integration suite. `npm run test:deploy` separately verifies the compiled single-service process, static assets, API boundaries, and truthful 503 behavior when PostgreSQL is unavailable. It does not substitute for a healthy database test.

After validated source is pushed and the service settings/environment are saved, use **Manual Deploy → Deploy latest commit** if the deployment does not start automatically. Confirm all three:

1. `/` loads the Uzbek interface.
2. `/api/health/live` returns HTTP 200.
3. `/api/health/ready` returns HTTP 200 after querying PostgreSQL.

The readiness health check intentionally blocks a successful deployment if the database is unavailable. A green build alone does not prove database connectivity. The foundation is not yet a functional restaurant POS.

## References

- [Render web services and port binding](https://render.com/docs/web-services)
- [Default environment variables](https://render.com/docs/environment-variables)
- [Node.js version selection](https://render.com/docs/node-version)
- [PostgreSQL connections and TLS](https://render.com/docs/postgresql-creating-connecting)
- [Outbound IP ranges](https://render.com/docs/outbound-ip-addresses)
