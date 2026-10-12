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

## Phase 3 schema (migrations `restaurant_configuration`, `restaurant_constraints`)

`tenant_profiles` (1:1 tenant), `rooms`, `dining_tables` (unique name per branch, rotatable `qrToken`), `menu_categories` (self-referencing tree, tenant-scoped parent FK), `products` (soft delete, `version`, unique SKU/barcode per tenant), `product_variants` (every product has ≥1; price and internal cost), `branch_variant_prices` (override price and availability per branch), `modifier_groups`, `modifier_options`, `product_modifier_groups`. All child relations use composite `(tenantId, id)` foreign keys; CHECK constraints reject negative amounts, invalid selection bounds, seats outside 1–100 and service charge above 30 %.

## Phase 4 schema (migrations `orders_payments_shifts`, `order_discount_rule`)

`cash_shifts` (one OPEN per register via partial unique index), `cash_movements`, `order_counters` (daily number per branch, atomic upsert), `orders` (totals, discount rule, idempotency key unique per tenant), `order_items` (name/price/cost/modifier snapshots), `order_events`, `payments`, `refunds`. Payments, refunds, cash movements and order events are append-only (triggers reject UPDATE/DELETE). CHECK constraints: positive payment/refund amounts, tendered ≥ amount, discount ≤ subtotal, refunded ≤ paid, net paid ≤ total. Concurrent payments are serialized with `SELECT … FOR UPDATE` on the order row.

## Phase 5 schema (migrations `kitchen_realtime_printing`, `kitchen_print_tracking`)

`kitchen_stations`; `menu_categories.stationId`; order item kitchen fields (`stationId` and `prepTimeMinutes` snapshots, `kitchenStatus`, `prepStartedAt`, `readyAt`, `kitchenPrintedAt`); `orders.priority` (0/1) and `readyAt`; `printers`; `print_jobs` (payload bytes, status, attempts, backoff `nextTryAt`; claimed with `FOR UPDATE SKIP LOCKED`).

## Phase 6 schema (migration `warehouse_recipes`)

`stock_items` (base unit G/ML/PCS, min stock), `stock_units` (packaging factors), `warehouses` (one default per branch, partial unique index), `stock_balances` (quantity, weighted average cost; row-locked on every change), `stock_movements` (append-only ledger with `balanceAfter`, typed RECEIPT/SALE/WASTE/ADJUSTMENT/TRANSFER_IN/TRANSFER_OUT/STOCKTAKE and references), `suppliers`, `purchases` + `purchase_lines` (entered unit, factor, base quantity, so‘m prices), `supplier_payments` (append-only), `recipe_lines` (per variant), `tenant_profiles.allowNegativeStock`. Quantities use NUMERIC(14,3), costs NUMERIC(14,4); money stays integer so‘m.
