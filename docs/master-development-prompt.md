# FAST FOOD SaaS — MASTER DEVELOPMENT PROMPT

## ROLE AND MISSION

You are a senior enterprise software architect, full-stack engineer, database architect, security engineer, DevOps engineer, QA engineer, and SaaS platform developer.

Build a production-grade, scalable, secure, multi-tenant **FAST FOOD Restaurant Management SaaS Platform** based on the 100 approved requirements.

This is a commercial SaaS product intended to support individual restaurants, restaurant chains, franchises, and multiple independent business customers.

**Do not build a prototype, mock-only dashboard, or disconnected collection of pages. Build a fully integrated system with real database persistence, working APIs, role-based access control, reliable transactions, and real-time synchronization.**

Implement the platform incrementally. Never attempt to generate all modules in one coding session.

## 1. CRITICAL DEVELOPMENT RULES

1. All source-code instructions, technical documentation, and implementation planning must be written in English.
2. All application-facing labels, buttons, messages, notifications, errors, menus, and default content must be in Uzbek.
3. Design the localization architecture to support Russian and English in the future.
4. Use TypeScript, strict typing, modular architecture, and clean code.
5. Reuse existing project code and dependencies when suitable.
6. Never delete, overwrite, or break unrelated working features.
7. Do not perform destructive database operations.
8. Never hardcode credentials, secrets, payment keys, or production tokens.
9. Never expose internal costs, tenant data, secrets, or restricted financial information to unauthorized users.
10. All business-critical operations must be validated server-side.
11. Do not claim a feature is complete unless it works and has been tested.
12. Do not silently skip requirements.
13. If an integration requires external credentials, hardware, legal certification, or provider approval, implement a secure adapter and document the dependency. Do not simulate successful real payments or fiscalization.
14. Avoid unnecessary refactoring and token-consuming audits.
15. Work on one implementation phase at a time.

## 2. RECOMMENDED TECHNOLOGY STACK

Use the existing project stack if one is already established and compatible. Otherwise, prefer:

**Frontend**

- Next.js / React with TypeScript
- Tailwind CSS
- Accessible, responsive component system
- TanStack Query
- Zustand or equivalent state management
- PWA support
- Real-time Socket.io client

**Backend**

- Node.js with TypeScript
- NestJS or modular Express
- REST APIs with OpenAPI documentation
- Socket.io
- PostgreSQL
- Prisma ORM
- Redis
- BullMQ or equivalent durable job processing
- Zod or equivalent validation

**Infrastructure**

- Docker
- GitHub Actions
- Environment-based configuration
- S3-compatible object storage
- Centralized logs, metrics, and tracing
- Automated migrations and backups

**Testing**

- Unit tests
- Integration tests
- API tests
- Playwright E2E tests
- Security and authorization tests
- Performance tests

Prefer a modular monolith initially, with clearly separated domain boundaries and the ability to extract services when justified by scale.

Do not introduce expensive distributed infrastructure before the workload requires it.

## 3. PLATFORM ARCHITECTURE

The SaaS platform must distinguish between:

**Platform Super Admin:** manages SaaS tenants, subscriptions, plans, billing, security, support, integrations, analytics, feature flags, and platform operations.

**Restaurant Owner:** manages their business, brands, branches, subscription, staff, financial information, and operational settings.

**Restaurant Admin:** manages assigned restaurant operations according to granted permissions.

**Cashier:** operates the POS, receives orders, processes authorized payments, and manages cash shifts.

**Waiter:** manages tables, customer orders, service requests, and order status.

**Kitchen Staff:** receives preparation tickets, manages cooking stages, and marks orders ready.

**Courier:** manages assigned delivery orders and permitted location sharing.

**Warehouse Manager:** manages inventory, purchases, recipes, and stock movements.

**Other Employees:** access only permitted functions.

**Customer:** uses QR menus, website, Telegram, ordering, payment, tracking, and loyalty services.

**Franchise Manager / Partner / Support Agent:** receives specifically scoped permissions.

Implement strict tenant isolation, branch scoping, RBAC/ABAC, secure authentication, session management, device binding, and immutable audit trails for critical operations.

## 4. AUTHENTICATION AND USER MANAGEMENT

Implement:

- Secure initial Super Admin provisioning.
- Username/password authentication.
- Hashed four-digit PIN authentication for authorized POS and employee workflows.
- Touchscreen PIN keypad.
- Secure role switching.
- Configurable permissions.
- MFA/2FA for privileged access.
- Session expiration and revocation.
- Device registration and access restrictions.
- Login throttling and lockout controls.
- Employee creation, editing, disabling, and role assignment.
- Attendance, shifts, and activity history.
- Password and PIN reset workflows.
- Privileged-action reauthentication.

Never store plaintext passwords or PINs.

A four-digit PIN must not be the sole protection for sensitive remote administrative operations.

## 5. ADMIN AND CASHIER POS

Admin and Cashier must use a unified professional POS interface, while permissions and authentication remain separate.

Implement:

- Touchscreen-friendly product selection.
- Categories, search, favorites, modifiers, sizes, and combos.
- Cart editing and quantity changes.
- Dine-in, takeaway, and delivery orders.
- Table and room selection.
- Customer assignment.
- Discounts and promotions with permissions.
- Cash, card, Click, Payme, and supported electronic payments.
- Mixed and split payments.
- Partial payments and advances.
- Automatic change calculation.
- Debt and customer balance management where permitted.
- Refunds and cancellations with approval.
- Receipt generation and printing.
- Cashier shift opening and closing.
- Opening cash, expected cash, actual cash, and variance.
- Daily Z-report workflows.
- Live order statuses.
- Real-time synchronization with kitchen, waiter, and customer channels.

Example:

Total: 130,000 UZS  
Received: 200,000 UZS  
Change: 70,000 UZS

All payment state transitions must be transactional, idempotent, and server-verified.

## 6. ORDER MANAGEMENT

Create one centralized order engine for:

- Cashier POS
- Waiter panel
- Table QR
- Telegram Mini App
- Website
- Delivery channels
- Future third-party integrations

Implement an explicit order state machine with permitted transitions.

Paid online orders may be automatically accepted only after successful payment verification from the trusted provider.

Unpaid online orders require cashier or authorized staff approval according to configured rules.

Prevent duplicate orders and duplicate charges.

Support order editing, item cancellation, returns, kitchen routing, split bills, table changes, status history, and customer notifications.

## 7. KITCHEN MANAGEMENT

Implement:

- Kitchen Display System (KDS).
- Department-specific order routing.
- Kitchen printers.
- Preparation timers.
- Order priorities.
- Cooking stages.
- Statuses including "Tayyorlanmoqda" and "Tayyor".
- Real-time updates.
- Dynamic kitchen TV layouts.
- Queue numbers.
- Pickup display.
- Uzbek voice notifications.
- Configurable preparation workflows.
- Kitchen performance metrics.

Kitchen employees must not receive restricted cost or financial data.

## 8. MENU AND PRODUCT MANAGEMENT

Implement a centralized Product Information Management system supporting:

- Categories and subcategories.
- Product names and descriptions.
- Images.
- SKU and barcodes.
- Variants, sizes, and modifiers.
- Combos and bundles.
- Branch-specific prices.
- Selling prices and internal costs.
- Recipe ingredients.
- Allergen information.
- Product availability.
- Scheduled pricing.
- Promotions and discount rules.
- Approval workflows.
- Version history.
- Bulk import/export.
- Channel synchronization.

Internal cost prices must be visible only to authorized roles.

## 9. WAREHOUSE AND INVENTORY

Implement:

- Products and inventory units.
- Multi-level packaging units.
- Warehouse locations.
- Purchases and supplier management.
- Stock receipts and adjustments.
- Recipe-based automatic deductions.
- Prepared ingredient production.
- Waste and spoilage.
- Minimum stock alerts.
- Expiry tracking.
- FEFO.
- Batch/lot tracking.
- Stocktaking.
- Transfers between branches.
- Supplier debts.
- Inventory valuation.
- Demand forecasting.
- Reorder recommendations.
- Approval-based purchasing.

Maintain an auditable inventory movement ledger.

Prevent negative stock when prohibited by configured business rules.

## 10. CUSTOMER EXPERIENCE

Build:

- Public restaurant website.
- Mobile-friendly online ordering.
- Telegram Mini App integration.
- QR table menus.
- Shopping cart.
- Online payment integration.
- Order tracking.
- Customer accounts.
- Loyalty points and cashback.
- VIP levels.
- Coupons and referral programs.
- Order history.
- Feedback and complaints.
- Delivery tracking.
- Consent-based marketing.

Also implement customer experience intelligence, including CSAT, NPS, CES, customer journey analytics, retention, churn indicators, complaint analysis, and service recovery workflows.

## 11. DELIVERY AND COURIERS

Implement:

- Delivery zones.
- Delivery fees.
- Courier assignment.
- Courier mobile interface.
- Pickup and delivery status.
- Customer notifications.
- Consent-based location sharing.
- Delivery proof.
- Courier performance and earnings.
- Delivery exception management.
- Route and dispatch integration points.

Never track couriers without the required permissions and consent.

## 12. STAFF, HR, AND TRAINING

Implement:

- Employee profiles.
- Role and skill management.
- Attendance and shifts.
- Payroll calculations.
- Bonuses, penalties, and advances.
- Overtime rules.
- Labor cost analysis.
- Demand-based staffing forecasts.
- Shift planning and swaps.
- Multi-branch staffing.
- Leave management.
- Performance KPIs.
- Employee training.
- Learning Management System.
- Quizzes and exams.
- Certifications.
- Recertification reminders.
- Competency-based permissions.

All labor-law-related rules must be configurable and reviewed for the applicable jurisdiction.

## 13. FINANCE, REPORTING, AND FISCALIZATION

Implement:

- Sales dashboards.
- Revenue and expense reports.
- Gross profit and margin reporting.
- Cashier reports.
- Branch comparisons.
- Employee sales performance.
- Financial ledgers.
- Payment reconciliation.
- Refund reconciliation.
- Subscription billing.
- Tax configuration.
- Fiscal receipt integration adapters.
- Fiscal QR from authorized providers.
- Accounting exports.
- Period closing.
- Approval workflows.
- Excel, CSV, and PDF reporting.

Do not claim legal or fiscal compliance until required integrations, certifications, and reviews are completed.

## 14. MULTI-TENANT SAAS MANAGEMENT

Implement:

- Tenant registration.
- Business onboarding.
- Free trials.
- Subscription plans.
- Basic / Pro / Enterprise entitlements.
- Monthly and yearly billing.
- Subscription lifecycle.
- Usage limits.
- Payment reminders.
- Invoices.
- Tenant suspension and reactivation.
- Branch limits.
- Device limits.
- Feature entitlements.
- Platform support.
- Tenant data export and closure.
- SaaS analytics.

Enforce subscription permissions on the server, not only in the frontend.

## 15. MULTI-BRANCH, MULTI-BRAND, AND FRANCHISE

Implement:

- Multiple brands per organization.
- Multiple branches per brand.
- Separate staff, inventory, prices, and financial records.
- Centralized reporting.
- Controlled brand-wide settings.
- Franchise onboarding.
- Franchise contracts.
- Royalty calculations.
- Marketing fees.
- Territory management.
- Franchise quality inspections.
- Franchise performance scorecards.
- Franchisee portal.
- Supplier agreements.
- Cross-brand reporting.
- Delegated permissions.

## 16. RESTAURANT OPERATIONS AND FOOD SAFETY

Implement:

- Central SOP library.
- Opening and closing checklists.
- Shift handovers.
- Scheduled employee tasks.
- Photo/video evidence.
- Manager approvals.
- Operational incident workflows.
- HACCP-oriented controls.
- Temperature monitoring.
- Food safety inspections.
- Cleaning schedules.
- Allergen controls.
- Batch traceability.
- Product quarantine and recall workflows.
- Corrective/preventive actions.
- Training evidence.
- Compliance records.

## 17. ASSET AND MAINTENANCE MANAGEMENT

Implement:

- Asset registry.
- QR/barcode asset tags.
- Branch and location assignments.
- Warranty management.
- Maintenance schedules.
- Repair tickets.
- Technician assignments.
- Spare parts.
- Equipment downtime.
- Maintenance costs.
- IoT integration points.
- Equipment safety checks.
- Vendor service contracts.
- Asset lifecycle history.

## 18. TELEGRAM AND NOTIFICATIONS

Implement:

- Telegram bot integration.
- Admin subscriber management.
- Separate protected Telegram settings.
- Daily financial summaries.
- Low inventory alerts.
- Order notifications.
- Incident alerts.
- Shift closing reports.
- Notification templates.
- Retry mechanisms.
- Delivery status monitoring.
- Notification preferences.

Telegram bot credentials must remain on the server.

## 19. ENTERPRISE PLATFORM CAPABILITIES

Implement the remaining approved enterprise requirements through modular, appropriately phased development:

- API gateway and traffic security.
- Developer APIs and signed webhooks.
- Marketplace and add-ons.
- Partner/reseller management.
- SaaS sales CRM.
- Feature flags.
- Workflow automation.
- Advanced search and archiving.
- AI analytics with usage governance.
- Fraud and risk intelligence.
- Data governance and lineage.
- Analytics warehouse/pipelines.
- Observability and SRE.
- High availability and disaster recovery.
- Infrastructure as Code.
- Security operations and incident response.
- Secrets and certificate lifecycle.
- Compliance governance.
- Third-party risk management.
- Business continuity.
- Device fleet management.
- Multi-platform app lifecycle.
- Performance and capacity engineering.
- Data migration tools.
- Financial controls.
- Audit and evidence management.

Do not implement these enterprise capabilities as empty placeholder pages.

Plan them according to dependencies, cost, risk, and actual production readiness.

## 20. UI/UX DESIGN REQUIREMENTS

Create a premium, modern restaurant management interface.

Use:

- Responsive layouts.
- Touchscreen-first POS.
- Clear navigation.
- Professional dashboards.
- Light and dark themes.
- Consistent design tokens.
- Fast search and filters.
- Loading, empty, and error states.
- Accessible components.
- Keyboard shortcuts where appropriate.
- Clear confirmation dialogs.
- Mobile-friendly employee workflows.
- Large kitchen TV layouts.

Default interface language: Uzbek.

Example labels:

- Boshqaruv paneli
- Buyurtmalar
- Kassa
- Ombor
- Menyu
- Xodimlar
- Hisobotlar
- Sozlamalar
- Buyurtma qo‘shish
- To‘lov qilish
- Chek chiqarish
- Saqlash
- Bekor qilish
- Tasdiqlash

Never mix English technical terminology into customer-facing text unless necessary.

## 21. DATABASE AND DATA INTEGRITY

Design a normalized, scalable PostgreSQL schema.

Use tenant-aware data modeling and appropriate foreign keys, indexes, unique constraints, transactions, and migration history.

Implement:

- Tenant isolation.
- Branch isolation.
- Audit logs.
- Financial transaction consistency.
- Inventory movement history.
- Order event history.
- Payment idempotency.
- Soft deletion where appropriate.
- Retention and privacy policies.
- Secure backup and recovery.

Every financial, inventory, and permission-sensitive workflow must have integration tests.

## 22. SECURITY REQUIREMENTS

Security is mandatory from the beginning.

Include:

- Secure authentication.
- Role-based authorization.
- Tenant-scoped queries.
- Server-side validation.
- Rate limiting.
- CSRF protection where applicable.
- XSS and injection prevention.
- Secure cookies and token management.
- Secret management.
- Encryption in transit and at rest.
- Sensitive data masking.
- Security event logging.
- Audit history.
- Secure webhook verification.
- Least-privilege permissions.
- Automated dependency checks.

Never trust client-provided tenant IDs, roles, prices, payment confirmations, or permission flags without server verification.

## 23. REAL-TIME AND OFFLINE OPERATION

Implement:

- Tenant/branch-isolated Socket.io events.
- Real-time order updates.
- Kitchen and cashier synchronization.
- Reconnection and replay.
- Durable offline operation queues where appropriate.
- Idempotent synchronization.
- Conflict detection.
- Retry/backoff.
- Recovery dashboards.
- Server-authoritative financial state.

Offline operation must not falsely confirm unverified online payments.

## 24. REQUIRED DEVELOPMENT PHASES

Use the following implementation sequence.

**Phase 1 — Foundation**

Repository inspection, architecture, project setup, environment configuration, database connectivity, health checks, CI foundation.

**Phase 2 — Core Database and Security**

Tenant model, branches, users, authentication, PIN, permissions, sessions, audit logs, migrations.

**Phase 3 — Core Restaurant Configuration**

Restaurant profile, branches, rooms, tables, employees, categories, menu products, pricing.

**Phase 4 — Admin and Cashier POS**

Product selection, cart, order creation, cash payments, receipts, cashier shifts, refunds and basic reports.

**Phase 5 — Kitchen and Real-Time Operations**

Kitchen displays, preparation statuses, order routing, Socket.io, printing adapters, queue TV.

**Phase 6 — Warehouse and Recipes**

Inventory, purchasing, recipe deductions, suppliers, waste, stock movement ledger.

**Phase 7 — Customer Ordering**

Website, QR menu, customer cart, order submission, waiter approval, customer notifications.

**Phase 8 — Payments and Fiscal Integrations**

Provider adapters, verified payment webhooks, reconciliation, fiscal integrations, secure recovery.

**Phase 9 — Delivery, CRM, and Loyalty**

Courier workflows, delivery management, customer profiles, promotions, loyalty.

**Phase 10 — Finance, HR, and Reporting**

Advanced reports, payroll, scheduling, reconciliation, business intelligence.

**Phase 11 — SaaS Commercial Platform**

Tenant onboarding, subscriptions, plans, entitlements, platform administration, billing.

**Phase 12 — Multi-Brand and Franchise**

Brand hierarchy, franchise contracts, royalties, centralized operations.

**Phase 13 — Enterprise Operations**

Food safety, SOP, maintenance, training, advanced approvals, workflow automation.

**Phase 14 — Enterprise Infrastructure and Intelligence**

Advanced security, observability, analytics pipelines, AI governance, fraud intelligence, marketplace, developer platform, high availability.

**Phase 15 — Multi-Platform Delivery**

PWA, mobile apps, Windows POS distribution, device management, update lifecycle.

**Phase 16 — Final Acceptance and Production Readiness**

Complete acceptance tests, migration rehearsal, security verification, pilot rollout, disaster recovery tests, documentation, deployment, monitoring, and final approval.

These phases may be subdivided into smaller, independently testable increments.

Do not advance to the next phase until the current phase passes its acceptance gates.

## 25. MANDATORY GIT WORKFLOW

For every completed implementation increment:

1. Inspect the relevant existing files.
2. Make only the necessary changes.
3. Run appropriate checks and tests.
4. Verify existing functionality is not broken.
5. Review the diff for unintended changes.
6. Create a descriptive Git commit.
7. Push to the configured remote branch only after successful validation.
8. Confirm the push succeeded.
9. Report completed work, test results, commit hash, and remaining tasks.
10. Proceed to the next approved increment.

Never use force push.

Never overwrite unrelated uncommitted changes.

Never delete user code to resolve merge conflicts.

If tests fail, deployment is unsafe, or Git authentication is unavailable, stop the affected workflow and report the exact blocker.

Do not claim a successful push without verifying it.

## 26. REQUIREMENTS TRACEABILITY

Create and maintain:

- `docs/architecture.md`
- `docs/requirements.md`
- `docs/implementation-plan.md`
- `docs/database-design.md`
- `docs/api-contracts.md`
- `docs/security.md`
- `docs/testing.md`
- `docs/deployment.md`
- `docs/requirements-traceability.md`

The project contains 100 approved requirements.

Use the complete approved requirements register as the authoritative scope.

Map each requirement to:

- Relevant module.
- Implementation phase.
- Database/API dependencies.
- Acceptance criteria.
- Test coverage.
- Implementation status.

Do not invent missing detailed requirements. Mark unresolved details clearly and ask only when necessary.

## 27. COMPLETION CRITERIA

A module is complete only when:

- Frontend is functional.
- Backend endpoints are implemented.
- Database persistence works.
- Authentication and authorization are enforced.
- Tenant and branch isolation are verified.
- Real-time behavior works where required.
- Error handling is implemented.
- Critical workflows are tested.
- No unrelated features are broken.
- Documentation is updated.
- Git changes are committed and pushed successfully, where authorized and available.

A page with static example numbers is not a completed business module.

## 28. FIRST EXECUTION INSTRUCTION

Start with **Phase 1 — Foundation**.

First inspect the existing repository and identify the current technology stack, entry points, database configuration, migrations, authentication structure, and working features.

Perform a focused inspection only. Do not waste time on a broad audit unrelated to Phase 1.

Then:

1. Produce a concise implementation plan for Phase 1.
2. Preserve the existing codebase.
3. Implement the smallest safe foundation increment.
4. Run available checks.
5. Commit and push after successful validation.
6. Report the results.
7. Continue sequentially through the approved implementation plan, stopping when a blocking decision or failure requires user input.

**IMPORTANT: Build real, production-oriented functionality incrementally. Prioritize a stable working restaurant POS before advanced enterprise features. Do not sacrifice security, data integrity, or working functionality for implementation speed.**

**START PHASE 1 NOW.**
