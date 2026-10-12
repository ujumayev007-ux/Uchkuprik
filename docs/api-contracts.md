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
