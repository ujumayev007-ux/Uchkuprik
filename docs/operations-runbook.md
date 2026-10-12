# Operations runbook

Audience: the person deploying and operating FAST FOOD in production.

## 1. Deployment (Render)

- One web service runs `npm run build` and `npm start` (`prisma migrate deploy`, then the API, which also serves the built frontend). See `render-setup.md` for every environment variable.
- Required: `DATABASE_URL` (PostgreSQL, **UTF8 encoding**), `APP_ORIGIN` (https), `APP_SECRET_KEY` (≥ 32 random bytes, base64), `TRUST_PROXY=1`, `NODE_ENV=production`.
- Optional: `CREDENTIAL_RATE_LIMIT`, `SIGNUP_RATE_LIMIT` (`0` disables public sign-up), `METRICS_TOKEN`, `LOG_LEVEL`.
- First run: `npm run admin:create -w backend` creates the platform administrator (MFA is enforced at first login).
- Migrations are forward-only and applied on start. Never run `prisma migrate reset` or `db push` against production.

## 2. Release and rollback

1. Merge to `main` only when CI (format, typecheck, unit, integration on PostgreSQL, Playwright desktop + mobile, `npm audit`) is green.
2. Render deploys the commit; the frontend and API share the version (`RENDER_GIT_COMMIT`). Installed terminals show "Yangi versiya tayyor" and update on click; the Devices page flags outdated terminals.
3. Rollback: redeploy the previous commit in Render. Migrations are additive; a code rollback is safe as long as no later migration dropped data (none do). If a migration must be reverted, write a new forward migration.

## 3. Backups and disaster recovery

- Use Render PostgreSQL daily backups with point-in-time recovery (paid plans). Target RPO ≤ 24 h (PITR: minutes), RTO ≤ 2 h.
- Monthly restore drill: restore the latest backup into a staging database, point a staging service at it, run `npm run db:check -w backend` and sign in with a test tenant. Record the date and duration.
- Photo evidence, audit logs and all business data live in PostgreSQL, so one backup covers everything. `APP_SECRET_KEY` must be stored separately (password manager); without it encrypted secrets (MFA, Telegram, payment providers, webhook secrets) cannot be decrypted.

## 4. Monitoring

- Health: `GET /api/health/live` (process, version) and `GET /api/health/ready` (database).
- Metrics: `GET /api/metrics` with `Authorization: Bearer $METRICS_TOKEN` (requests, latency, memory, pending print/notification/webhook queues). Alert when queues keep growing or 5xx rate rises.
- Logs are structured JSON (pino) without request bodies, URLs or secrets; correlate by `requestId` (`X-Request-Id` header).
- Business-level delivery screens: Printers (failed print jobs), Notifications → Yetkazish holati, Integrations → webhook log.

## 5. Security operations

- Rotate `APP_SECRET_KEY` only with a planned re-encryption (not supported online yet — see Open items).
- Suspected account compromise: platform administrator suspends the tenant (Platform → Bizneslar); owners revoke sessions per user (Xodimlar), terminals (Qurilmalar) and API keys (Integratsiyalar).
- Audit logs are append-only and visible to tenant owners (Audit) and platform administrators (Xavfsizlik jurnali).
- Dependency updates: Renovate/Dependabot recommended; CI runs `npm audit --audit-level=high`.

## 6. Pilot rollout checklist

1. Create the business (self-service or Platform → Bizneslar), choose a plan.
2. Settings: legal name, STIR, receipt texts, service charge, stock policy.
3. Branches, rooms/tables, menu with prices; staff with roles and PINs.
4. Register each POS/kitchen terminal (Qurilmalar) and install the app (browser menu → "Ilovani o‘rnatish").
5. Printers (LAN ESC/POS), payment providers (Payme/Click merchant credentials), Telegram bot.
6. Run one full day in parallel with the old process; compare the Z-report and stock counts.
7. Fiscalization: connect a certified OFD provider before issuing fiscal receipts (not included).
