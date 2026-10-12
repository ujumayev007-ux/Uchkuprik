# Requirements baseline

The user-supplied master development prompt is the available scope source, preserved in `master-development-prompt.md`. It refers to a separate approved register of 100 requirements, but that register is not present. Original requirement IDs, detailed acceptance criteria, and approvals cannot be inferred. Mapping against that register is pending receipt.

## Binding delivery constraints

- Implement one phase at a time. Do not pass a phase until its acceptance gates are satisfied.
- Use English for code instructions and documentation, Uzbek for application-facing text, and strict TypeScript.
- Preserve existing work; never use destructive database operations or force pushes.
- Validate critical operations on the server, enforce tenant/branch isolation, hash credentials, and protect financial and cost data.
- Never claim successful payments, fiscalization, integration, tests, or Git pushes without verification.
- Commit and push validated increments to the configured remote. Missing repository identity, authentication, or remote is an explicit delivery blocker.
- Every financial, inventory, and permission-sensitive workflow needs integration tests before acceptance.

## Phase 1 acceptance criteria

1. Reproducible dependency installation with committed lockfile and documented runtime.
2. Both workspaces type-check and build with strict typing.
3. Startup validates required configuration without logging secret values.
4. Liveness works independently of PostgreSQL; readiness succeeds only after a real query and fails safely on a database outage.
5. The Uzbek responsive screen reflects actual API readiness, supports retry, and handles failures.
6. Automated configuration, HTTP, security-baseline, database, and browser checks pass.
7. CI runs the same checks against real PostgreSQL; local results and unexecuted checks are reported honestly.
8. Required architecture, API, security, database, testing, deployment, planning, and traceability documents exist.
9. The increment is reviewed, committed, pushed, and its remote commit verified when Git access is available.

## Unresolved inputs

- Complete approved 100-item register and original requirement IDs.
- Git remote is confirmed as `https://github.com/ujumayev007-ux/Uchkuprik.git`, with existing `main` history preserved. Repository-local author settings use the connected GitHub profile. Git delivery remains blocked by the failing real-database acceptance gate.
- Production hosting, domain, secret manager, database provider, recovery objectives, and budget (needed before deployment, not for local scaffolding).
- Tenant onboarding rules, privileged provisioning method, MFA choices, and initial permission matrix (resolve in Phase 2).
- Payment/fiscal provider credentials and approvals, printer hardware, Telegram bot credentials, and jurisdiction-specific rules (later owning phases).

No production deployment or external integration is included in the first increment.
