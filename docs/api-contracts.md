# API contracts

Base path: `/api`. See [openapi.yaml](openapi.yaml) for machine-readable contracts.

| Endpoint                | Authentication           | Success                                                   | Failure                                                                       |
| ----------------------- | ------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/health/live`  | Public, no business data | 200 `{ "status": "ok", "message": "Xizmat ishlayapti." }` | Network/process failure                                                       |
| `GET /api/health/ready` | Public, no business data | 200 after a PostgreSQL query                              | 503 if PostgreSQL is unavailable or shutdown has started; 429 if rate limited |

Response messages are Uzbek. Stable machine codes/statuses are English identifiers. No connection strings, database error details, hostnames, credentials, tenant IDs, software versions, or financial information are returned.

Every response gets a server-generated `X-Request-Id` and `Cache-Control: no-store`. Do not trust caller-supplied correlation IDs. Unknown routes return a sanitized Uzbek 404. Unexpected errors return a sanitized Uzbek 500. Readiness and other `/api` requests are limited to 120 requests per minute per source IP; liveness is exempt to support process probes. Limits use process-local storage until a shared store is justified.

Browser origins must match `APP_ORIGIN`; requests without `Origin` support machine health probes. CORS is not authentication. No business endpoint exists yet. Authentication, tenant context, permission checks, body validation, CSRF strategy, API versioning, and idempotency contracts must be added with their owning phases before mutations become available.
