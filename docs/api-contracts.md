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
