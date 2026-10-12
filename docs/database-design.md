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

## Phase 7 schema (migration `public_ordering`)

`OrderStatus` gains `PENDING`; `orders.trackingToken` (unique, random); `tenant_profiles.publicOrdering`. Online orders use the same order engine (server pricing, modifiers, numbering, events) with channel QR or WEB.

## Phase 8 schema (migration `payment_providers_fiscal`)

`payment_provider_configs` (per tenant and provider, encrypted secret), `provider_transactions` (provider-side lifecycle CREATED/PERFORMED/CANCELLED, unique per provider external id, linked payment), `fiscal_receipts` (per order, NOT_CONFIGURED/PENDING/REGISTERED/FAILED). Online payments are ordinary `payments` rows (method PAYME/CLICK, no shift, idempotency key `<provider>:<external id>`).

## Phase 9a schema (migration `crm_loyalty_coupons`)

`customers` (unique normalized phone per tenant, consent with timestamp, points, lifetime stats), `loyalty_entries` (append-only ledger with balance), `coupons` (percent or fixed, min order, max uses enforced by conditional update), `feedback` (one per order, rating CHECK 1-5, resolution), `orders.customerId`/`couponId`, `PaymentMethod.LOYALTY`, `tenant_profiles.loyaltyEarnBp`.

## Phase 9b schema (migration `delivery_couriers`)

`delivery_zones` (per branch fee, minimum order, ETA), `courier_profiles` (consent with timestamp and last position), order delivery fields (`deliveryZoneId`, `deliveryFee` included in totals, `courierId`, `deliveryStatus` UNASSIGNED/ASSIGNED/PICKED_UP/DELIVERED/FAILED, timestamps, proof, failure reason).

## Phase 10 schema (migration `hr_finance`)

`employee_profiles`, `attendance_records` (one open record per user via partial unique index, clockOut after clockIn), `scheduled_shifts`, `payroll_periods` (unique per tenant and dates; DRAFT/APPROVED/PAID), `payroll_lines`, `payroll_adjustments` (append-only), `expenses`, `closed_periods` (YYYY-MM), tenant overtime rules.

## Phase 11 schema (migrations `saas_billing`, `saas_billing_tenant_fk`)

`plans` (code unique, monthly/yearly price in so‘m, nullable limits = unlimited, feature keys, trial days; CHECK constraints), `subscriptions` (one per tenant, TRIALING/ACTIVE/PAST_DUE/SUSPENDED/CANCELLED, billing cycle, current period, `suspendedForBilling`), `invoices` (sequential number, unique per subscription and period start, OPEN/PAID/VOID, due date, payment reference), `tenants.closedAt`. Default plans BASIC, PRO and ENTERPRISE are seeded by the migration with placeholder prices editable by the platform administrator. Tenants without a subscription (provisioned before Phase 11) keep unrestricted access.

## Phase 12a schema (migrations `brands`, `multi_brand_feature`)

`brands` (unique code per tenant, CHECK on code and colour format), nullable `branches.brandId` and `menu_categories.brandId` with composite (tenantId, brandId) foreign keys so a brand can never be attached across tenants. The ENTERPRISE plan gains the `multi_brand` feature.

## Phase 12b schema (migration `franchise`)

`franchisees`, nullable `branches.franchiseeId` (composite tenant FK), `franchise_contracts` (unique number per tenant; fee CHECKs 0–50%; DRAFT/ACTIVE/TERMINATED), `royalty_statements` (unique per contract and month; DRAFT/ISSUED/PAID), `inspections` (append-only trigger, score CHECK 0–100), `supplier_agreements`. The migration adds the `franchise` feature to the Enterprise plan and seeds the `franchisee` system role (franchise.portal, reports.view, branches.view) for existing tenants.

## Phase 13a schema (migration `operations`)

`sop_documents` + append-only `sop_revisions`, `checklist_templates`, `checklist_runs` (unique per template, branch and business date), `evidence_files` (bytea, ≤ 2 MB, image types only, append-only), `temperature_logs` (append-only, range CHECK), `incidents` (CAPA fields), `shift_handovers`, `ops_tasks` (recurrence), `stock_batches` (lot register with status workflow). The migration grants `operations.perform` to the admin, cashier, waiter, kitchen and warehouse system roles and the `operations` feature to the Pro and Enterprise plans.

## Phase 13b schema (migration `assets_training`)

`assets` (tag unique per tenant), `maintenance_plans`, `repair_tickets` (parts JSON, labour/parts costs, downtime window, approval link), `asset_events` (append-only lifecycle history), `service_contracts`, `courses`, `training_records` (append-only certificates with expiry), `approval_requests`; `ops_tasks.maintenancePlanId` and nullable `createdById` (automation-created tasks); `tenant_profiles.repairApprovalThreshold`.

## Phase 14a schema (migration `notifications`)

`telegram_configs` (encrypted bot token, hashed webhook secret, daily summary hour and last sent date), `notification_subscribers` (chat id unique per tenant, link code, events, branch filter), `notification_templates` (per-tenant overrides), `notification_jobs` (outbox: status, attempts, sanitized last error, next try). The database must use UTF8 encoding (emoji and Uzbek text); the API refuses to start in production on a non-UTF8 database.

## Phase 14b schema (migration `developer_platform`)

`api_keys` (hash unique, prefix, scopes, last used, revoked), `webhook_endpoints` (encrypted signing secret, events), `webhook_deliveries` (outbox with status, attempts, response status, sanitized error). The Enterprise plan gains `developer_api`.
