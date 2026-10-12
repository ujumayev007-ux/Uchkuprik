# Security baseline

## Implemented

- Zod validation rejects missing/invalid environment configuration and reports field names without secret values.
- Local database passwords use cryptographic randomness and live only in ignored `.env` files. Setup never overwrites an existing environment file.
- Production configuration requires HTTPS for the app origin and `sslmode=verify-full` for PostgreSQL. Never disable certificate validation to bypass connectivity problems.
- Helmet headers, disabled framework-identifying headers, no-store responses, a strict browser-origin allowlist, and bounded request/query timeouts.
- Readiness rate limiting; no trusted-proxy spoofing because `trust proxy` is disabled.
- Structured logs record server-generated request IDs, statuses, and duration. They omit URLs, query strings, request bodies, credentials, raw driver errors, and headers.
- React escapes rendered text; API readiness payloads are validated at the client boundary.
- No business mutation, credential, payment, or tenant endpoint is exposed by this phase.
- CI audits production and development dependencies. The lockfile is part of the delivery.
- Prisma 7.10.0's development-tool dependencies are narrowly overridden to `deepmerge-ts` 8.0.0 and `mysql2` 3.24.5 to address published advisories. Schema validation must pass with those overrides; reassess them when upgrading Prisma or introducing migrations. The runtime health API uses PostgreSQL directly and does not expose Prisma configuration processing.

## Explicitly pending

Authentication, password/PIN hashing, device binding, MFA, sessions, RBAC/ABAC, branch/tenant authorization, login throttling, immutable audit history, and privileged reauthentication are Phase 2 work. Business functionality cannot ship before those controls and isolation tests exist.

Cookie sessions will require CSRF defenses for mutations; current endpoints are read-only and issue no session cookies. In-memory request limiting is a single-process foundation, not a distributed defense. Set exact trusted proxy ranges only when the deployment topology is known.

Encryption at rest, secret rotation, backups, intrusion detection, compliance controls, and secure infrastructure depend on deployment decisions. This document does not certify production, payment, fiscal, or legal compliance.
