# Database design

## Implemented foundation

- PostgreSQL is the selected persistent database.
- `compose.yaml` runs one isolated local database with a named volume and a loopback-only port (5433 by default).
- Environment setup generates a random local password without overwriting existing settings.
- `backend/src/database.ts` owns the connection pool with bounded connection/query timeouts and a five-connection maximum.
- Health checks use only `SELECT 1`; integration tests are read-only and do not change existing data.
- Prisma 7 schema with versioned SQL migrations in `backend/prisma/migrations`; the runtime uses the generated client with the `pg` driver adapter. `npm start` runs `prisma migrate deploy` (non-destructive).

## Phase 2 schema (migration `identity_and_security`)

| Table                         | Purpose / key constraints                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenants`                     | Business root (kind BUSINESS) plus one reserved PLATFORM tenant (partial unique index); slug format check; status ACTIVE/SUSPENDED/CLOSED. |
| `branches`                    | Tenant-scoped; unique `(tenantId, code)`; soft delete.                                                                                     |
| `users`                       | Unique `(tenantId, username)`; password/PIN hashes, encrypted TOTP secret, last TOTP step, lockout counters, `allBranches`.                |
| `roles`                       | Per-tenant permission sets; `systemKey` for seeded roles.                                                                                  |
| `user_roles`, `user_branches` | Composite FKs on `tenantId` make cross-tenant links impossible.                                                                            |
| `devices`                     | Registered terminals bound to a branch; token hash only.                                                                                   |
| `sessions`                    | Token hash, method (PASSWORD/PIN), MFA state, re-auth time, idle/absolute expiry, revocation.                                              |
| `audit_logs`                  | Append-only (trigger rejects UPDATE/DELETE/TRUNCATE).                                                                                      |

Conventions: UUIDv7 keys, snake_case table names, camelCase columns, integer minor units for money (Phase 4 onward), every business table carries `tenantId` and, where relevant, `branchId`.

## Operations

Separate runtime and migration database credentials in deployment. Production runtime requires verified TLS. Restrict database access to application networks. Backups, point-in-time recovery, retention, encryption at rest, restoration drills, and migration rehearsals require deployment infrastructure; they are not implemented by a local Docker volume.
