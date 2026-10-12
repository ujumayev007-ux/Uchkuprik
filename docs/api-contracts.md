# API contracts

Base path: `/api`. See [openapi.yaml](openapi.yaml) for machine-readable contracts.

| Endpoint                | Authentication           | Success                                                   | Failure                                                                       |
| ----------------------- | ------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/health/live`  | Public, no business data | 200 `{ "status": "ok", "message": "Xizmat ishlayapti." }` | Network/process failure                                                       |
| `GET /api/health/ready` | Public, no business data | 200 after a PostgreSQL query                              | 503 if PostgreSQL is unavailable or shutdown has started; 429 if rate limited |

Response messages are Uzbek. Stable machine codes/statuses are English identifiers. No connection strings, database error details, hostnames, credentials, tenant IDs, software versions, or financial information are returned.

Every response gets a server-generated `X-Request-Id` and `Cache-Control: no-store`. Do not trust caller-supplied correlation IDs. Unknown routes return a sanitized Uzbek 404. Unexpected errors return a sanitized Uzbek 500. `/api` requests are limited to 600 requests per minute per session (anonymous traffic: per IP); liveness is exempt to support process probes. Limits use process-local storage until a shared store is justified.

Browser origins must match `APP_ORIGIN`; requests without `Origin` support machine health probes.

## Phase 2: identity and administration

Errors are `{ code, message, details? }` with an Uzbek `message`. Codes: `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INVALID_CREDENTIALS`, `INVALID_PIN`, `ACCOUNT_LOCKED`, `MFA_REQUIRED`, `MFA_SETUP_REQUIRED`, `MFA_INVALID`, `REAUTH_REQUIRED`, `PASSWORD_CHANGE_REQUIRED`, `TENANT_SUSPENDED`, `DEVICE_REQUIRED`, `LAST_OWNER`, `WEAK_PASSWORD`. "Step-up" means password re-authentication within 5 minutes.

| Endpoint                                                                                                        | Access                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `POST /auth/login` {tenant, username, password}                                                                 | Public, rate limited                       |
| `POST /auth/mfa/verify` {code}                                                                                  | Session pending MFA                        |
| `POST /auth/logout`, `GET /auth/me`                                                                             | Session                                    |
| `POST /auth/reauth` {password, code?}                                                                           | Password session                           |
| `POST /auth/password` {currentPassword, newPassword}                                                            | Password session                           |
| `POST /auth/mfa/setup`, `/auth/mfa/enable` {code}, `/auth/mfa/disable`                                          | Password session (disable: step-up)        |
| `GET /auth/sessions`, `POST /auth/sessions/:id/revoke`                                                          | Own sessions                               |
| `POST /auth/branch` {branchId}                                                                                  | Password session with branch access        |
| `GET /pin/device`, `POST /auth/pin` {userId, pin}                                                               | Registered device cookie                   |
| `GET /permissions`                                                                                              | Session                                    |
| `GET /users`; `POST /users`; `PATCH /users/:id`; `POST /users/:id/{status,password,pin,unlock,sessions/revoke}` | users.view; users.manage + step-up         |
| `GET /roles`; `POST /roles`; `PATCH`/`DELETE /roles/:id`                                                        | users.view; roles.manage + step-up         |
| `GET /branches`; `POST /branches`; `PATCH /branches/:id`                                                        | Session; branches.manage (create: step-up) |
| `GET /devices`; `POST /devices/register`; `POST /devices/:id/revoke`                                            | devices.manage (+ step-up)                 |
| `GET /audit-logs?action&before&limit`                                                                           | audit.view                                 |
| `GET`/`POST /platform/tenants`; `POST /platform/tenants/:id/status`                                             | Platform admin (+ step-up)                 |
| `GET /platform/audit-logs`                                                                                      | Platform admin                             |

## Phase 3: restaurant configuration

Money fields are integers in so‘m. Cost fields (`cost`) are omitted unless the caller holds `menu.cost.view`; without it, submitted costs are ignored and stored values kept.

| Endpoint                                                                                             | Access                                                                             |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /settings`; `PATCH /settings`                                                                   | Business session; settings.manage + step-up                                        |
| `GET /floor?branchId`                                                                                | tables.manage or orders.view (QR tokens only for tables.manage)                    |
| `POST /rooms`, `PATCH /rooms/:id`, `POST /tables`, `PATCH /tables/:id`, `POST /tables/:id/rotate-qr` | tables.manage, branch scope                                                        |
| `GET /menu?branchId&all`                                                                             | menu.view (`all=true` includes inactive items for menu.manage)                     |
| `POST /menu/categories`, `PATCH /menu/categories/:id`                                                | menu.manage (cycle check)                                                          |
| `POST /menu/products`, `PATCH /menu/products/:id`, `DELETE /menu/products/:id`                       | menu.manage; variants upserted by id, removed variants deactivated; delete is soft |
| `POST /menu/modifier-groups`, `PATCH /menu/modifier-groups/:id`                                      | menu.manage                                                                        |
| `PUT /menu/branch-prices` {branchId, items[{variantId, price                                         | null, isAvailable}]}                                                               | menu.manage, branch scope |

The session's active branch defaults to the user's first accessible branch at login. `priceVariants()` (backend/src/modules/menu/pricing.ts) is the only source of sale prices for orders.

## Phase 4: POS, orders, payments, shifts, reports

Order statuses: DRAFT → PLACED → PREPARING → READY → SERVED → COMPLETED; CANCELLED only from DRAFT/PLACED and only with zero net payment. Prices, modifiers, service charge and totals are computed on the server; client prices are ignored. Create and payment requests carry an `idempotencyKey`; retries return the original result (200).

| Endpoint                                                                                                            | Access                                                |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `GET /orders?branchId&scope=active                                                                                  | today                                                 | all`, `GET /orders/:id`, `GET /orders/:id/events`, `GET /orders/:id/receipt` | orders.view |
| `POST /orders` {idempotencyKey, type, tableId?, customer…, items[{variantId, quantity, modifierOptionIds}], place?} | orders.create                                         |
| `POST /orders/:id/items`, `PATCH /orders/:id/items/:itemId` (DRAFT only), `POST /orders/:id/items/:itemId/cancel`   | orders.create (after placing: orders.cancel + reason) |
| `PATCH /orders/:id` (table, customer, note), `POST /orders/:id/complete` (fully paid)                               | orders.edit                                           |
| `POST /orders/:id/place`                                                                                            | orders.create                                         |
| `POST /orders/:id/discount` {percentBp, fixed, reason}                                                              | discounts.apply                                       |
| `POST /orders/:id/cancel` {reason}                                                                                  | orders.cancel                                         |
| `POST /orders/:id/payments` {idempotencyKey, method CASH                                                            | CARD, amount, tendered?, reference?}                  | payments.accept + open shift; online methods rejected until Phase 8          |
| `POST /orders/:id/refunds` {paymentId, amount, reason}                                                              | payments.refund + step-up; cash needs an open shift   |
| `GET /shifts/current`, `POST /shifts/open`, `POST /shifts/current/movements`, `POST /shifts/:id/close`              | shifts.manage (close: own register or finance.view)   |
| `GET /shifts`, `GET /shifts/:id/report` (Z-report)                                                                  | shifts.manage (own) or reports.view                   |
| `GET /reports/sales?branchId&from&to`                                                                               | reports.view; `profit` only with finance.view         |

## Phase 5: kitchen, real-time, printing

Real-time: Socket.io at `/api/realtime` (same origin, session cookie). Server → client events only: `order.changed` {orderId, number, status}, `kitchen.changed` {orderId}, `menu.changed` {}. Clients refetch over REST; clients cannot send commands.

| Endpoint                                                                                                   | Access                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /kitchen/stations`; `POST`/`PATCH /kitchen/stations[/:id]`                                            | kitchen.access/menu.view; menu.manage                                  |
| `GET /kitchen/tickets?stationId` (no prices)                                                               | kitchen.access                                                         |
| `POST /kitchen/items/:id/status` {QUEUED                                                                   | PREPARING                                                              | READY}; `POST /kitchen/orders/:id/bump` {status, stationId?} | kitchen.access |
| `POST /orders/:id/serve`                                                                                   | orders.edit or kitchen.access                                          |
| `POST /orders/:id/priority` {0                                                                             | 1}                                                                     | orders.edit                                                  |
| `GET /queue` (numbers only)                                                                                | orders.view or kitchen.access                                          |
| `GET`/`POST`/`PATCH /printers`, `POST /printers/:id/test`, `GET /print-jobs`, `POST /print-jobs/:id/retry` | settings.manage; hosts restricted to private LAN IPv4, ports 9100–9109 |

Menu categories accept `stationId`. Order status is derived from item kitchen statuses (any started → PREPARING, all ready → READY, new items on READY/SERVED → PREPARING).

## Phase 6: warehouse, purchasing, recipes

Quantities are decimal strings in the item's base unit (g, ml, dona) with up to 3 decimals. Cost fields (`avgCost`, `value`, `unitCost`, `recipeCost`) require inventory.manage or finance.view (recipe cost also menu.cost.view).

| Endpoint                                                                                                                         | Access                                       |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `GET /inventory/items?branchId` (balances of the branch default warehouse)                                                       | inventory.view                               |
| `POST /inventory/items`, `PATCH /inventory/items/:id` (with packaging units)                                                     | inventory.manage                             |
| `GET /inventory/movements?stockItemId&limit` (ledger)                                                                            | inventory.view                               |
| `POST /inventory/adjustments` {type WASTE or ADJUSTMENT, reason, lines}                                                          | inventory.manage                             |
| `POST /inventory/stocktakes` {counts[{stockItemId, counted}]}                                                                    | inventory.manage                             |
| `POST /inventory/transfers` {toBranchId, lines}                                                                                  | inventory.manage + access to both branches   |
| `GET /inventory/alerts` (low stock with reorder suggestion)                                                                      | inventory.view                               |
| `GET /suppliers` (debt for purchasing.manage/finance.view), `POST`/`PATCH /suppliers`, `POST /suppliers/:id/payments`            | purchasing.manage (list also inventory.view) |
| `GET /purchases`, `POST /purchases`, `PATCH /purchases/:id` (DRAFT), `POST /purchases/:id/receive`, `POST /purchases/:id/cancel` | purchasing.manage                            |
| `GET`/`PUT /recipes/:variantId`                                                                                                  | menu.manage or inventory.manage              |

Completing an order deducts recipe ingredients (SALE movements) in the same transaction; with `allowNegativeStock = false` (settings) the completion is rejected with `INSUFFICIENT_STOCK` and nothing changes.

## Phase 7: customer ordering (public)

Public endpoints need no session, return 404 unless the tenant is active and `publicOrdering` is enabled, never return costs, and order creation is rate limited per IP. Online orders start as `PENDING` and reach the kitchen only after staff approval; they cannot be paid before approval.

| Endpoint                                                                                                                                                                                          | Access                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `GET /public/r/:slug` (name, branches)                                                                                                                                                            | Public                     |
| `GET /public/r/:slug/menu?branchId` (available items, branch prices)                                                                                                                              | Public                     |
| `GET /public/t/:qrToken` (table, branch, menu)                                                                                                                                                    | Public                     |
| `POST /public/orders` {idempotencyKey, source: {kind: table, token} or {kind: web, slug, branchId, type}, customerName, customerPhone?, deliveryAddress?, note?, items} → {trackingToken, number} | Public, rate limited       |
| `GET /public/orders/:trackingToken` (status, items, totals)                                                                                                                                       | Public (unguessable token) |
| `POST /orders/:id/approve`; `POST /orders/:id/reject` {reason}                                                                                                                                    | orders.approve             |

Settings: `publicOrdering` (default off). Tables expose a printable QR code for `/t/:qrToken`; rotating the token invalidates printed codes.

## Phase 8: online payments and fiscal status

Provider callbacks are authenticated by the provider protocol (no session) and are the only way an online payment is recorded. Online payments must cover the full outstanding amount; a paid PENDING order is accepted automatically.

| Endpoint                                                                                                                                                                                                                 | Access                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `POST /webhooks/payme/:configId` — Payme Merchant API JSON-RPC: CheckPerformTransaction, CreateTransaction, PerformTransaction, CancelTransaction, CheckTransaction, GetStatement (amounts in tiyin, account `order_id`) | HTTP Basic `Paycom:<cashbox key>`         |
| `POST /webhooks/click/:configId/prepare`, `/complete` — Click SHOP API (form-encoded, `merchant_trans_id` = order id)                                                                                                    | MD5 `sign_string` with the service secret |
| `GET /payments/providers` (no secrets; callback URLs to register) ; `PUT /payments/providers/:PAYME or CLICK` (secret write-only)                                                                                        | settings.manage (+ step-up for PUT)       |
| `GET /public/orders/:trackingToken/pay` → {due, links[{provider, url}]} (hosted checkout links)                                                                                                                          | Public                                    |
| `GET /payments/reconciliation?from&to` (per-provider totals, mismatches)                                                                                                                                                 | finance.view                              |

Payme rules implemented: one open transaction per order (-31052), 12-hour expiry of unperformed transactions (cancel reason 4, -31008), performed transactions cannot be cancelled by the provider (-31007; refunds go through staff approval), idempotent create/perform. Click: prepare/complete with signature checks, failed payments (negative `error`) cancel the transaction, repeated completes return -4.

Receipts include `fiscal` status (`NOT_CONFIGURED` until a certified fiscal provider adapter is configured).

## Phase 9a: customers, loyalty, coupons, feedback

| Endpoint                                                                                       | Access                            |
| ---------------------------------------------------------------------------------------------- | --------------------------------- |
| `GET /customers?q`, `GET /customers/:id` (orders, loyalty ledger)                              | customers.view                    |
| `PATCH /customers/:id` {name, birthday, marketingConsent, notes}                               | customers.manage                  |
| `POST /customers/:id/points` {points (+/-), reason}                                            | customers.manage + step-up        |
| `GET /customers-export/marketing` (CSV, consenting customers only, audited)                    | customers.manage                  |
| `POST /orders/:id/customer` {phone, name?} (upsert by normalized phone)                        | orders.create                     |
| `POST /orders/:id/coupon` {code}; `DELETE /orders/:id/coupon`                                  | orders.create                     |
| `GET`/`POST /coupons`, `PATCH /coupons/:id` {isActive}                                         | customers.manage                  |
| `POST /public/orders/:trackingToken/feedback` {rating 1-5, comment} (once, after READY)        | Public                            |
| `GET /feedback` (stats: count, average, CSAT %, open complaints), `POST /feedback/:id/resolve` | customers.view / customers.manage |

Payments accept method `LOYALTY` (requires an attached customer; 1 point = 1 so‘m). Points are earned on completion at `loyaltyEarnBp` (settings) of money paid, excluding points; refunds of loyalty payments return points. Tiers by lifetime spend: Standart, Kumush (1 mln), Oltin (5 mln), Platina (20 mln). Web orders attach the customer by phone automatically.

## Phase 9b: delivery and couriers

| Endpoint                                                                                                     | Access                                                   |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `GET /delivery/zones`; `POST`/`PATCH /delivery/zones[/:id]` {name, fee, minOrder, etaMinutes}                | delivery.manage or orders.create (list); delivery.manage |
| `POST /orders/:id/delivery-zone` {zoneId or null} (fee added to total, zone minimum on subtotal)             | orders.edit                                              |
| `POST /orders/:id/courier` {courierId or null} (courier roles only, before pickup)                           | delivery.manage                                          |
| `GET /delivery/board` (active delivery orders, couriers, consented fresh positions)                          | delivery.manage                                          |
| `GET /courier/orders`; `POST /courier/orders/:id/pickup` (order READY); `/deliver` {proof}; `/fail` {reason} | delivery.courier, own assignments only                   |
| `PUT /courier/consent` {consent}; `POST /courier/location` {lat, lng, accuracy}                              | delivery.courier; location requires consent              |
| `GET /delivery/report?from&to` (delivered, failed, fees, average minutes per courier)                        | delivery.manage or reports.view                          |

Delivering a fully paid order completes it (stock deduction, fiscal status, loyalty) through the same completion function as the cashier; unpaid deliveries stay SERVED until the cashier records the collected cash. Website delivery orders must choose a zone when the branch has zones (`zones` in the public menu).

## Phase 10: HR, payroll, finance and reports

| Endpoint                                                                                                                                   | Access                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `GET /hr/employees`; `PUT /hr/employees/:userId` {position, payType NONE/HOURLY/MONTHLY, rate, hireDate}                                   | hr.manage (+ step-up for PUT)                     |
| `GET /attendance/me`, `POST /attendance/clock-in`, `POST /attendance/clock-out`                                                            | any business session (one open record per person) |
| `GET /attendance?from&to`; `PATCH /attendance/:id` {clockIn, clockOut, note} (audited correction)                                          | hr.manage                                         |
| `GET /schedule?from&to` (own shifts, or the branch for hr.manage); `POST /schedule`; `DELETE /schedule/:id`                                | session / hr.manage (no overlapping shifts)       |
| `POST /payroll/adjustments` {userId, type BONUS/PENALTY/ADVANCE, amount, date, reason}                                                     | hr.manage + step-up                               |
| `GET /payroll/periods`, `GET /payroll/periods/:id`                                                                                         | hr.manage or finance.view                         |
| `POST /payroll/periods` {startDate, endDate}; `/:id/recalculate` (DRAFT); `/:id/export.csv`                                                | hr.manage                                         |
| `POST /payroll/periods/:id/approve` (step-up); `/:id/paid`                                                                                 | finance.manage                                    |
| `GET /expenses?from&to`; `POST /expenses`; `DELETE /expenses/:id`                                                                          | finance.view; finance.manage                      |
| `GET /finance/closed-periods`; `POST /finance/close` {month} (finished months only, step-up)                                               | finance.view; finance.manage                      |
| `GET /reports/pnl`, `/reports/pnl.csv` (revenue, COGS from stock ledger + manual costs, expenses, approved payroll, net profit)            | finance.view                                      |
| `GET /reports/branches` (costs only with finance.view), `GET /reports/kitchen` (average prep minutes, on-time %), `GET /reports/sales.csv` | reports.view                                      |

Payroll: HOURLY = regular minutes × rate/60 + daily overtime beyond `overtimeAfterMinutes` × `overtimeMultiplierBp`; MONTHLY = salary prorated by calendar days of the starting month; bonuses add, penalties and advances deduct. CSV files use a UTF-8 BOM and semicolons for Excel.

## Phase 11: SaaS plans, subscriptions and billing

| Endpoint                                                                                                                                     | Access                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /public/plans` (active plans, `signupEnabled`)                                                                                          | public                                                                 |
| `POST /public/register` {businessName, slug, branchName, ownerName, username, password, planCode, acceptTerms: true} → 201 {slug}            | public, rate-limited per IP per hour (`SIGNUP_RATE_LIMIT`, 0 disables) |
| `GET /billing` (subscription, plan, usage vs limits, plans, last 24 invoices, isOwner)                                                       | settings.manage                                                        |
| `POST /billing/plan` {planCode, billingCycle MONTHLY/YEARLY}; 409 `PLAN_USAGE_EXCEEDS` when current usage is above the new limits            | owner + step-up                                                        |
| `GET /tenant/export` (streamed JSON of all tenant tables, no credentials)                                                                    | owner + step-up, audited                                               |
| `POST /tenant/close` {confirm: slug} (tenant CLOSED, subscription CANCELLED, sessions revoked, future invoices void)                         | owner + step-up, audited                                               |
| `GET /platform/plans`; `POST /platform/plans`; `PUT /platform/plans/:id`                                                                     | platform admin (+ step-up for writes)                                  |
| `GET /platform/subscriptions`; `POST /platform/tenants/:id/subscription` {planCode, billingCycle}                                            | platform admin (+ step-up)                                             |
| `GET /platform/invoices?status`; `POST /platform/invoices/:id/pay` {reference}; `POST /platform/invoices/:id/void`                           | platform admin (+ step-up)                                             |
| `POST /platform/billing/run`; `GET /platform/analytics` (MRR, ARR, ARPA, paying tenants, open/overdue amounts, 30-day collections and churn) | platform admin                                                         |
| `POST /platform/tenants` accepts optional `planCode` to start a trial                                                                        | platform admin + step-up                                               |

`GET /auth/me` now returns `entitlements` {planCode, status, features (null = unrestricted), limits} and `billing` (trial days left, oldest open invoice) for settings managers.
Errors: `403 FEATURE_NOT_IN_PLAN` {feature} for modules outside the plan, `403 PLAN_LIMIT_REACHED` {limit, max} when creating or re-enabling branches, users or devices beyond the plan.

## Phase 12a: brands

| Endpoint                                                                                                                                                                       | Access                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `GET /brands` (with branch and category counts)                                                                                                                                | business session; plan feature `multi_brand` |
| `POST /brands`; `PUT /brands/:id` {code, name, logoUrl (https), primaryColor (#rrggbb), receiptHeader, receiptFooter, isActive, sortOrder}                                     | brands.manage, audited                       |
| `GET /reports/brands?from&to` (completed sales, orders and average check per brand and branch; branches without a brand grouped separately; only branches the user can access) | reports.view; `multi_brand`                  |

Branches (`POST /branches`, `PATCH /branches/:id`) and menu categories accept `brandId` (null = no brand / shared). `GET /menu` (selling view) returns only shared categories and those of the branch's brand; the editor view (`all=true`) returns everything with `brandId`. Order pricing rejects another brand's items with `ITEM_UNAVAILABLE`. Public storefront branches include `brand` {name, logoUrl, primaryColor} and the public menu is filtered by the branch brand. Receipts use the brand name and receipt texts when the branch has a brand.

## Phase 12b: franchise

All endpoints require the plan feature `franchise` (Enterprise).

| Endpoint                                                                                                                                                                                                                                        | Access                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `GET/POST /franchise/franchisees`, `PUT /franchise/franchisees/:id` {name, legalName, taxId (9 or 14 digits), contactName, phone, email, status, notes, branchIds}; 409 `BRANCH_FRANCHISED` when a branch already belongs to another franchisee | franchise.manage, audited                   |
| `GET/POST /franchise/contracts`, `PUT /franchise/contracts/:id` (DRAFT only, else 409 `CONTRACT_LOCKED`) {franchiseeId, brandId, number, territory, exclusive, startDate, endDate, royaltyBp, marketingFeeBp, minimumMonthlyFee}                | franchise.manage                            |
| `POST /franchise/contracts/:id/activate` (409 `TERRITORY_CONFLICT` for overlapping exclusive territories of the same brand); `POST /franchise/contracts/:id/terminate` {reason}                                                                 | franchise.manage + step-up                  |
| `GET /franchise/statements?month`; `POST /franchise/statements/generate` {month} (creates/refreshes DRAFT statements, never touches ISSUED/PAID)                                                                                                | franchise.manage                            |
| `POST /franchise/statements/:id/issue` (finished months only, recomputed); `POST /franchise/statements/:id/paid` {reference}; `GET /franchise/statements.csv?month`                                                                             | franchise.manage (+ step-up for issue/paid) |
| `GET/POST /franchise/inspections` {branchId, inspectedAt, items [{label, passed, note}], notes}; score = passed / total × 100                                                                                                                   | franchise.manage                            |
| `GET /franchise/scorecards?month` (sales, orders, 90-day average inspection score, outstanding royalties, contract end)                                                                                                                         | franchise.manage                            |
| `GET /franchise/portal` (only franchisees operating branches the user is assigned to: contracts, issued/paid statements, inspections)                                                                                                           | franchise.portal                            |
| `GET/POST /supplier-agreements`, `PUT /supplier-agreements/:id` {supplierId, brandId, title, startDate, endDate, paymentTermsDays, terms, isActive}                                                                                             | franchise.manage                            |

Royalty = royaltyBp × net sales, marketing = marketingFeeBp × net sales, where net sales = completed sales of the franchisee's branches (licensed brand only) within the month and contract dates minus refunds of those orders; if the royalty is below the minimum monthly fee the difference is added as a top-up. CSV exports neutralize leading formula characters.

## Phase 13a: operations and food safety

All endpoints require the plan feature `operations` (Pro, Enterprise). "Staff" = `operations.perform` or `operations.manage`; branch defaults to the session's active branch and is checked against the user's branch scope.

| Endpoint                                                                                                                                                                                                                                                                                                                          | Access                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `POST /operations/evidence` (raw JPEG/PNG/WebP body ≤ 2 MB; type detected from bytes) → {id}; `GET /operations/evidence/:id` (tenant and branch scoped, nosniff)                                                                                                                                                                  | staff                                      |
| `GET /operations/sops`; `POST /operations/sops`; `PUT /operations/sops/:id` (content change publishes a new version); `GET /operations/sops/:id/revisions`                                                                                                                                                                        | staff read; operations.manage write        |
| `GET/POST /operations/checklist-templates`, `PUT /operations/checklist-templates/:id` {name, kind OPENING/CLOSING/CLEANING/HACCP/OTHER, branchId, items [{label, requiresPhoto}]}                                                                                                                                                 | staff read; operations.manage write        |
| `GET /operations/checklists?branchId&date`; `POST /operations/checklists/:templateId/start` (one run per template, branch and business day); `PATCH /operations/checklist-runs/:id/items/:index` {done, note, evidenceId}; `POST /operations/checklist-runs/:id/complete` (409 `CHECKLIST_INCOMPLETE` lists missing items/photos) | staff                                      |
| `POST /operations/checklist-runs/:id/approve` (409 `SELF_APPROVAL` for the person who completed it)                                                                                                                                                                                                                               | operations.manage                          |
| `GET/POST /operations/temperatures` {point, value, minValue, maxValue, note}; out-of-range readings open a HIGH food-safety incident                                                                                                                                                                                              | staff                                      |
| `GET/POST /operations/incidents` {type, severity, title, description, evidenceIds}; `PATCH /operations/incidents/:id` {status INVESTIGATING/RESOLVED/CLOSED, rootCause, correctiveAction, preventiveAction} — resolving requires root cause and corrective action, closing requires RESOLVED                                      | staff report; operations.manage CAPA/close |
| `GET/POST /operations/handovers`; `POST /operations/handovers/:id/acknowledge` (not by the author)                                                                                                                                                                                                                                | staff                                      |
| `GET /operations/tasks?status` (staff see own/unassigned); `POST /operations/tasks` {title, assigneeId, dueAt, recurrence NONE/DAILY/WEEKLY, requiresPhoto}; `POST /operations/tasks/:id/complete` {note, evidenceId} schedules the next recurrence                                                                               | create: operations.manage; complete: staff |
| `GET /operations/batches?lot&status`; `POST /operations/batches` {stockItemId, supplierId, lotNumber, expiresAt, quantity}; `POST /operations/batches/:id/status` {status, reason} (recall applies to the same lot in every branch; RECALLED/DISPOSED are final)                                                                  | staff register; operations.manage status   |
| `GET /operations/allergens` (product × allergen matrix); `GET /operations/summary` (today's checklists, open incidents, overdue tasks, 24 h temperature alarms, batches expiring in 3 days)                                                                                                                                       | staff                                      |
