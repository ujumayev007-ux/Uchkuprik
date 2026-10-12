# Database design

## Implemented foundation

- PostgreSQL is the selected persistent database.
- `compose.yaml` runs one isolated local database with a named volume and a loopback-only port (5433 by default).
- Environment setup generates a random local password without overwriting existing settings.
- `backend/src/database.ts` owns the connection pool with bounded connection/query timeouts and a five-connection maximum.
- Health checks use only `SELECT 1`; integration tests are read-only and do not change existing data.
- `backend/prisma/schema.prisma` and `prisma.config.ts` define the PostgreSQL provider and migration location. There are no business models, generated Prisma repositories, or migrations yet.

Do not treat an empty schema or successful probe as completed business persistence. The first domain migration belongs to Phase 2. Never run reset or force-push schema commands against user data.

## Phase 2 design constraints

Use organization/tenant as the root boundary, with brands and branches under it. Membership and branch grants must be verified from authenticated server-side context. Business tables must carry tenant scope; branch-specific data must also carry branch scope. Use composite foreign keys and tenant-scoped uniqueness where required to prevent references crossing tenant boundaries.

Design users, password/PIN hashes, devices, sessions, memberships, grants, and append-only audit events before authentication endpoints. An application write role must not be able to rewrite historical audit records. A final model and migration need authorization/integration tests before acceptance.

Use integer minor currency units or explicit fixed-precision decimals, never floating-point arithmetic for money. Phase 4 must define order/payment/shift transaction boundaries and idempotency constraints. Phase 6 must introduce an inventory movement ledger and transactional stock rules.

## Operations

Separate runtime and migration database credentials in deployment. Production runtime requires verified TLS. Restrict database access to application networks. Backups, point-in-time recovery, retention, encryption at rest, restoration drills, and migration rehearsals require deployment infrastructure; they are not implemented by a local Docker volume.
