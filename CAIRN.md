# CAIRN — Project Log & Technical Specification

**Product:** Cairn — an enterprise resource planning system
**Hostname:** cairn.deepakpt.com
**Document status:** AGREED baseline (2026-10-08 Go) — implementation IN BUILD; screen sign-off remains per §24.1
**Created:** 2026-10-08 · **Last updated:** 2026-10-12 (v1.20 — B-105 Company Code define capability)
**Owner:** Deepak (product owner) · Built with Arena.ai Agent Mode

---

## §0 · How to use this file

**This file is the single source of truth for the Cairn project.** Before reading any source
file to answer a question about how the system works, read here first. If the answer is not
here, that is a defect in this document, and the fix is to add it here.

### 0.1 Update protocol (binding)

| Rule | Detail |
|---|---|
| **One file** | All architecture, decisions, scope, page specs, walkthrough results and open questions live here. No parallel design docs. |
| **Append, never rewrite history** | Section §30 records every change with a date and reason. Superseded decisions are struck through and marked `SUPERSEDED BY D-xxx`, never deleted. |
| **Every decision gets an ID** | `D-nnn` for decisions, `DV-nnn` for intentional divergences from SAP, `R-nn` for requirements, `FND-nnn` for defects/findings, `SCR-nnn` for screens, `TST-nnn` for test cases. |
| **Status markers** | Every section carries one: `DRAFT` · `AGREED` · `FROZEN` · `IN BUILD` · `SIGNED OFF` · `DEFERRED`. |
| **Update cadence** | This file is updated in the same turn as any change to code, schema, decision or scope. A code change without a corresponding entry here is not complete. |
| **Red-line protocol** | The product owner marks up sections in place or replies with the section number. Agent response: apply, log in §30, restate the change. |

### 0.2 Contents

| § | Section | Status |
|---|---|---|
| 1 | Requirements register | AGREED |
| 2 | Decision register | AGREED |
| 3 | Conformance model & Divergence Register | AGREED |
| 4 | Naming, codes & IP boundary | AGREED |
| 5 | Platform architecture & engine design | DRAFT |
| 6 | Organizational model & multi-tenancy | DRAFT |
| 7 | Configuration Workbench & Standard Configuration Package | DRAFT |
| 8 | Data model | DRAFT |
| 9 | Master data model | DRAFT |
| 10 | Module scope & transaction inventory | DRAFT |
| 11 | Golden flows with accounting entries | DRAFT |
| 12 | MRP design | DRAFT |
| 13 | Production order costing | DRAFT |
| 14 | Finance & Record-to-Report detail | DRAFT |
| 15 | People (HR subset) | DRAFT |
| 16 | Audit & external verification | DRAFT |
| 17 | Output & document production | DRAFT |
| 18 | Data migration & bulk import | DRAFT |
| 19 | UI/UX design system | DRAFT |
| 20 | Repository & code architecture | DRAFT |
| 21 | Background jobs & worker | DRAFT |
| 22 | Deployment architecture (Docker) | DRAFT |
| 23 | Security & access control | DRAFT |
| 24 | Testing, page gathering & debugging protocol | DRAFT |
| 25 | Phase plan & Milestone 1 acceptance | DRAFT |
| 26 | Phase 1 screen inventory | DRAFT |
| 27 | Open items | OPEN |
| 28 | Risk register | OPEN |
| 29 | Glossary & alias examples | DRAFT |
| 30 | Change log | LIVE |

---

## §1 · Requirements register `AGREED`

Numbered so future discussions can cite `R-06` rather than re-explaining intent.

### 1.1 Core requirements (from initial brief)

| ID | Requirement | Interpretation |
|---|---|---|
| R-01 | No proprietary SAP codes or names in the product | Our own codes, names and schema throughout. SAP identifiers exist only as searchable alias metadata (§4). |
| R-02 | Replicate all SAP transactions | Tiered: Tier 1 + Tier 2 built and working; Tier 3 mapped in the registry and developed on demand (§3). |
| R-03 | Feel similar to SAP, modern looks, own IP | SAP's *workflow, form data and mental model* preserved; visual identity, component shapes and naming are ours (§19). |
| R-04 | Same company structure | Client → company code → plant → storage location, plus purchasing org, sales org, controlling area, with SAP's define/assign pattern (§6). |
| R-05 | Same procedure for document approval | Configurable release strategies: value thresholds, multi-level release, release codes, workflow (§7.6). |
| R-06 | An SAP implementation plan must port directly | The configuration process mirrors SAP's IMG tree: same define/assign semantics, same sequence dependencies, same gating. Delivered by the Configuration Workbench (§7) plus bulk import (§18). |
| R-07 | Module coverage | Foundation, MM (procurement/inventory), PP, SD, FICO, People, General Audit. |
| R-08 | Iterative page-by-page build | Each transaction page is specified, implemented, walked through with the product owner, debugged, and signed off (§24). |
| R-09 | M1 end-to-end | Company creation → production → sale → invoice clearing → audit, fully working. |
| R-10 | P2P, O2C, R2R faithful | Procure-to-Pay, Order-to-Cash, Record-to-Report exactly as SAP for regular mid-size companies (§11). |

### 1.2 Later clarifications

| ID | Requirement | Interpretation |
|---|---|---|
| R-11 | Payroll simplified but integrated | Salary and other payments post to FI and charge cost centres. No statutory tax/social-insurance calculation. Deduction rules are configurable. External payroll results can be imported and posted (§15). |
| R-12 | General audit = external verification | A read-only auditor capability proving company state: drill-through, tie-outs, change history, number-range integrity, period-close evidence, access review, evidence export (§16). |
| R-13 | Bulk import | Template-driven staging → validation → simulation → post, with saved sessions and dependency ordering (§18). |
| R-14 | Banking in v1 | Payment run (proposal → review → execute), payment methods, house banks, bank statement import, automatic clearing, dunning (§14.6). |
| R-15 | Multi-tenancy | True tenant partitioning via client. Development tenant created by the agent; the product owner's tenant created manually through the UI, one page at a time during testing. Two companies within the owner's tenant. |
| R-16 | Docker deployment | Containerised. Traefik is external and already installed. Our compose ships app, worker, postgres, pgbouncer, dragonfly, migrate, backup (§22). |
| R-17 | Manufacturing first | The first product sold is manufactured, so PP is in M1. MRP is option C: the full planning run (§12). |
| R-18 | Edge cases may diverge | Exactness required for regular mid-size company usage. Edge cases may be simplified or different, provided the structure and a config hook remain so alignment is additive later. Tracked in the Divergence Register (§3.3). |
| R-19 | Language | English first, built i18n-ready from day one (locale layer, message catalogue, no hardcoded UI strings). |
| R-20 | Documentation | This single file is the master project log (§0). |
| R-21 | Document output | Business documents must be producible: purchase order, delivery note, invoice, payment advice, dunning letter, goods label, financial statements (§17). |
| R-22 | Execution batches capped at 15 minutes | Explicit owner correction on 2026-10-09: preserve all work/data so far; no large combined stages. One bounded change per batch, with time reserved for verification and a checkpoint. Split rather than overrun; do not reset preserved data. |
| R-23 | Owner-test guidance after each batch | Owner requests the screen/function to check, dummy form records, expected results and negative/error checks after completion, so manual bug testing can proceed. |

### 1.3 Explicitly out of scope (agreed)

| item | Reason |
|---|---|
| Statutory payroll tax/social insurance calculation | Cannot be replicated correctly, and shipping wrong statutory logic is a liability (R-11, DV-001). |
| Reproducing SAP's visual identity, screens or trademarks | Legal boundary, and not the goal (R-01, R-03, DV-008). |
| Tier 3 transactions in the first delivery | Registry-mapped and searchable; built on demand (R-02, DV-009). |
| ABAP-equivalent user exits and modifications | Replaced by documented extension points (DV-010). |
| Raw table maintenance of configuration | All config through validated screens (DV-011). |
| Industry solutions, country versions, add-ons | Only the international standard template is delivered (§7). |

---

## §2 · Decision register `AGREED`

Locked decisions. To change one, add a new entry that supersedes it; never edit in place.

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D-001 | **Stack:** Next.js (App Router) full-stack, TypeScript, server actions for mutations | Fastest path to a clickable, debuggable system; server actions map naturally onto "post a document" transactions. | 2026-10-08 |
| D-002 | **Database:** PostgreSQL 17 | Real MVCC, schemas per module, sequences, and row-level locking that maps onto SAP's enqueue model. Required for R-10 "exact backend transactions". | 2026-10-08 |
| D-003 | **Data access:** Drizzle ORM with SQL migrations, versioned in repo | Typed schema, migrations under our control, no magic. Raw SQL permitted inside engine code where clarity demands it. | 2026-10-08 |
| D-004 | **Cache & queue backing:** Dragonfly, behind an internal cache interface | Redis-protocol compatible. License note (§22.7): BSL 1.1, converts to Apache 2.0 on a future date; internal use unencumbered. Interface makes switching to Valkey a config change. | 2026-10-08 |
| D-005 | **Auth:** session-cookie auth, own credential provider, own role/authorization model | Avoids third-party coupling in an audit-critical system. Sessions backed by Dragonfly. | 2026-10-08 |
| D-006 | **Multi-tenancy:** `client` column on all tenant-scoped tables + PostgreSQL row-level security + per-client configuration | Cheap now, brutal to retrofit. Development tenant = agent; production tenant created through the UI. | 2026-10-08 |
| D-007 | **Deployment:** Docker Compose; Traefik external | Traefik network `proxy`, entrypoint `web`, host `cairn.deepakpt.com`, no certresolver (TLS terminated upstream). | 2026-10-08 |
| D-008 | **i18n:** locale layer and message catalogue from day one; ship English | Retrofitting i18n is expensive; RTL support later must not require layout rework. | 2026-10-08 |
| D-009 | **Name:** Cairn | Chosen by product owner. Brand name is kept out of all code identifiers (§4) so a rename is cosmetic. | 2026-10-08 |
| D-010 | **Transaction tiering:** build Tier 1 + Tier 2; map Tier 3 in registry | Only viable definition of "all transactions" (R-02). | 2026-10-08 |
| D-011 | **PP in Milestone 1; MRP = full planning run (option C)** | Chosen for SAP-user familiarity over delivery speed (R-17). | 2026-10-08 |
| D-012 | **Production costing:** structure exact, depth deferred | Order as cost collector, activity rates, settlement and variance are exact; overhead application, WIP and variance-category split deferred with hooks (§13). | 2026-10-08 |
| D-013 | **Payroll:** posting-side only | Cost centres and GL correct; statutory calculation excluded (R-11). | 2026-10-08 |
| D-014 | **Audit:** Auditor Workspace with read-only role and evidence export | Matches R-12 (external auditor verifying state). | 2026-10-08 |
| D-015 | **UI:** SAP behaviour taxonomy, Cairn visual identity | Keep command box, dense grids, function keys, variant selection screens, document flow and change log buttons; change all visuals (§19). | 2026-10-08 |
| D-016 | **Naming:** own code grammar `MODULE.OBJECT.ACTION`; SAP identifiers as search aliases | Satisfies R-01 and keeps SAP users oriented (R-03). | 2026-10-08 |
| D-017 | **Document principle:** no data change without a document; nothing posted is ever deleted, only reversed | Foundational invariant; makes R-12 possible. | 2026-10-08 |
| D-018 | **Locking:** PostgreSQL advisory locks implementing named lock objects | Application-level enqueue semantics, portable and debuggable, no gap in the number-range path. | 2026-10-08 |
| D-019 | **Number ranges:** database-backed, gap-free allocation, per object/type/year, with a buffered option | SAP behaviour; gap-free is required for the number-range integrity report (§16.5). | 2026-10-08 |
| D-020 | **Conformance tiers A/B/C plus a living Divergence Register** | Turns R-18 from a sentiment into an auditable artefact (§3). | 2026-10-08 |
| D-021 | **Milestone 1 sequenced M1a→M1e** | Keeps a large milestone debuggable and gives the product owner working software earlier (§25). | 2026-10-08 |
| D-022 | **All long-running work on the worker container** | Next.js request handlers must not run MRP, payment runs, payroll posting, closes, or report generation (§21). | 2026-10-08 |
| D-023 | **Backups:** dedicated container, scheduled `pg_dump`, retention policy, restore procedure documented and tested | Mandatory for an audit-grade system. | 2026-10-08 |
| D-024 | **Network isolation:** only `app` joins the Traefik `proxy` network; db, pgbouncer and cache are internal-only | Reduces attack surface; auditors ask. | 2026-10-08 |
| D-025 | **Development split:** code is developed and debugged natively in the agent sandbox (PostgreSQL 17 + Node 20); the container stack is authored here and validated by the product owner on the host | Docker is not available inside the agent sandbox — confirmed 2026-10-08. | 2026-10-08 |
| D-026 | **Prepared statements disabled for pooled connections** | PgBouncer in transaction mode breaks server-side prepared statements. Migrations use a direct, non-pooled connection. (§22.4) | 2026-10-08 |
| D-027 | **Forwarded-header trust enabled** | TLS terminates outside Traefik's control; without this, generated URLs and secure cookies are wrong (§22.3). | 2026-10-08 |
| D-028 | **Intercompany postings in Milestone 1** — cross-company-code transactions with automatic mirror document, intercompany reconciliation accounts, and elimination at consolidation | Product owner decision (§27 item 2). Both company codes transact with each other from the start. | 2026-10-08 |
| D-029 | **Credit management with default blocking behaviour** — static credit check per credit control area; exposure = open orders + open deliveries + open invoices; documents over the limit are blocked and released only through a controlled release workflow | Product owner decision: use standard blocking behaviour (§27 item 3). | 2026-10-08 |
| D-030 | **Number display format is our own and readable** (e.g. `POF-2026-000123`), with an optional classic zero-padded numeric display for users who prefer it | Product owner accepted recommendation (§27 item 6). Cleaner identity, familiar option retained. | 2026-10-08 |
| D-031 | **Backup policy:** generational retention (14 daily / 8 weekly / 12 monthly), WAL archiving enabled from the start for point-in-time recovery, automated weekly restore verification with logged result, backups encrypted at rest | Product owner delegated the choice (§27 item 8). An untested backup is not a backup. | 2026-10-08 |
| D-032 | **Notifications: approval inbox is always the system of record; email notification is optional per user** | Product owner decision (§27 item 9). No workflow step may depend on email delivery. | 2026-10-08 |
| D-033 | **Mail server is configured in the application through a UI screen**, with credentials encrypted at rest — not environment-only | Product owner will supply SMTP data through the UI (§27 item 5). Makes the deployment self-service and keeps secrets out of compose files. | 2026-10-08 |
| D-034 | **Anti-imitation checklist is binding on every screen** (§19.5) | Product owner directive: keep the behavioural familiarity, but avoid visual or expressive copying. Legal safeguard and a design requirement. | 2026-10-08 |
| D-035 | **Money is exact decimal arithmetic** — scaled BigInt helpers in the posting engine, never floating point | 0.1 + 0.2 must equal 0.3 when a trial balance depends on it. Enforced at the engine and at `numeric(23,4)` in the schema. | 2026-10-08 |
| D-036 | **Number ranges use fiscal-year sentinel 0 for "not year-dependent"** | Discovered during the build: fiscal_year is part of the primary key, and key columns cannot be NULL. A sentinel removes every `IS NOT DISTINCT FROM` from the allocation path. | 2026-10-08 |
| D-037 | **`role_capability` stores capability PATTERNS, with no foreign key** | Correction of an initial mistake: the FK to concrete capabilities is simply wrong, because `PROC.*` is a pattern, not a row. Patterns resolve at authorisation time, so a new purchasing capability automatically reaches the buyer role. | 2026-10-08 |
| D-038 | **Tenant directory exposed through narrow `SECURITY DEFINER` functions**, never by giving the application an elevated connection | Listing tenants is inherently cross-tenant. A whitelisted function returns only the columns needed and cannot read business data — one mistake cannot silently disable row-level security application-wide. | 2026-10-08 |
| D-039 | **Migration numbering: generated `0000+`, hand-written `9000+`** | Hand-written migrations (policies, admin functions) must always sort after the tables they attach to, and must never collide with drizzle-kit's own counter. | 2026-10-08 |
| D-040 | **Application and migration database roles are separate** (`cairn_app` NOSUPERUSER NOBYPASSRLS; `cairn` owns the schema) | Without this split, RLS would be decorative: the owner or a superuser bypasses every policy. | 2026-10-08 |
| D-041 | **Every tenant-scoped table cascades from `client`.** A table with a `client` column carries a real foreign key with `ON DELETE CASCADE` (migration `9002`). | Deleting a tenant is a lifecycle operation, not a cosmetic one. Without the constraint, deleting the tenant row left every account, document, number range and configuration row behind as an orphan — invisible in the UI, still in the database, and still held by the row-level security policy for a tenant that no longer exists. Found because test cleanup appeared to work while leaking exhausted number ranges into the next run. The rule is stated once and enforced in the schema so a table added later cannot miss it. | 2026-10-08 |
| D-042 | **Number ranges resolve year-specific first, then year-independent; the displayed year comes from the document.** | A tenant should be configured once and post in any year; asking an administrator to re-maintain ranges every January is exactly the annual chore the reference model is criticised for. A range defined for a fiscal year wins for that year, and a range defined with sentinel year `0` (D-036) serves every year. The display is `PREFIX-YYYY-NNNNNN` using the **document's** fiscal year, because a year-independent range has no year of its own to print — and a number without its year is ambiguous to a reader, which D-030 exists to prevent. | 2026-10-08 |
| D-043 | **Standard package delivery excludes FI document number ranges.** `INTL-STD-1` defines accounts, company code, plants and roles; number ranges remain a configuration activity (`CFG.PLT.NUMBERRANGE.DEFINE`) on the workbench. | This matches the reference model rather than diverging from it: FI document number ranges are maintained by the customer per company code, not shipped. A tenant created through the UI therefore cannot post until the checklist step is done, which is the correct instruction to give the user rather than a defect to paper over. MM and SD ranges differ and are revisited when those modules land (M1c). | 2026-10-08 |
| D-044 | **Authentication and sessions are server-side, and the tenant comes from the session rather than the URL.** Sign-in takes three fields — tenant, user, password — and the session cookie carries `client.token`, opaque and unsigned. Tokens are 256 bits of randomness, stored only as a SHA-256 hash, in `user_session` (D-005); sessions are 12 hours with sliding renewal in the final quarter, and revoking one takes effect immediately. | Two choices here deserve their reasons on the record. (1) **The tenant key is an input rather than a lookup.** A tenant is the partition that row-level security enforces, so finding a user requires knowing the tenant before any row is read — either a cross-tenant lookup function outside RLS, or asking. We ask, and the cookie is deliberately unsigned: tampering with the client half only re-points the lookup at a tenant where that token does not exist, since possession of the token is the whole credential. (2) **Screens take the tenant from the session, never from a query string.** Every page previously accepted `?client=`, which was a fine development convenience and is not acceptable once sessions exist — it would let a signed-in user of one tenant read another's ledgers. The tenant switcher on the workbench is removed for the same reason: switching tenant means signing in as one of its users. ~~Onboarding stays reachable without a session, because it creates the tenant's first administrator and there is no session to have yet.~~ **Superseded by D-057: production first setup requires the private owner token; subsequent setup also requires an authorised session.** | 2026-10-08 |
| D-045 | **Every write action independently authenticates and authorises.** Tenant and audit actor come only from the verified session; submitted `client`, `changedBy` and `postedBy` fields are ignored. A protected page is not an authorisation boundary. | The two pre-auth write wrappers still trusted a form tenant and recorded `CONFIGURATOR`. Posting and period maintenance now use `requireSession` plus the exact named capability at the action boundary; errors name the missing authority. The posting form is now behind a server page and receives actual company/currency/document-type choices instead of hardcoded development defaults. | 2026-10-09 |
| D-046 | **Accounting numbering is company-scoped and type-assigned; document identity is separate from presentation.** `number_range` key includes `company_code` (`*` for tenant-wide operational objects). Document types select their configured range; international accounting types share `GENERAL`. New journal keys are `company/year/value`, with `display_number` retaining readable or classic presentation. | Independent identical ranges for each accounting type could issue the same number; different company codes must legitimately be able to issue the same display number. The engine now uses the configured assignment rather than the type code, and stores the full identity in journal lines, flow/index/status records and allocation evidence. Existing document keys are never rewritten. A defined specific year that is blocked, exhausted or external is authoritative and cannot be bypassed with a year-independent fallback. Maintenance is locked, audited, prevents overlapping intervals, reserves blocked numbers, and never resets counters or deletes intervals. | 2026-10-09 |
| D-047 | **Migration role has BYPASSRLS; application role must not.** The owner/admin role needs elevation for forced-RLS data migrations and the narrow security-definer functions. Runtime defaults to `cairn_app`; both boundaries check actual role privileges and fail closed when misconfigured. | Recreating the sandbox with a non-bypass owner made administrative reads silently empty. Giving the app that privilege would break isolation, so only the separate migration role receives it. A second finding: the code's old no-environment fallback used the owner despite D-040. The runtime fallback is now restricted, and tenant key interpolation rejects invalid keys instead of sanitising them into another scope. | 2026-10-09 |
| D-048 | **Store literal capability patterns and honour wildcard suffixes.** A terminal `*` covers the remaining path; an interior `*` consumes exactly one segment, then matching continues. | Real-browser onboarding exposed a seed conversion of every leading-wildcard pattern into `SYSTEM.WILDCARD`, which granted the first administrator no usable permissions and discarded the auditor's display-only suffix. Standard roles now retain their literal patterns; migration 9004 repairs the two known roles without widening custom roles. The matcher also now checks suffixes after interior wildcards, so `*.*.DISPLAY` cannot grant posting or configuration writes. | 2026-10-09 |
| D-049 | **Material master first slice is view-scoped and staged.** Basic data, purchasing, MRP settings and plant valuation use separate save contracts, tenant scope, change evidence and optimistic version checks. Quantities/prices validate stored precision before exact-decimal conversion; stock quantity/value remain read-only. Financial valuation read/write authorities are separate from inventory maintenance. | Records the material code already written before the interrupted stage, not a new feature in this checkpoint. Basic/organisational view completion and blocking are checked through a shared operational gate; relevant plant changes flag the planning file. Full planning execution and the other master views remain pending. Source/backend verification is complete; the new material browser walkthrough and production build are not. | 2026-10-09 |
| D-050 | **Hard execution budget: 15 minutes per batch, one small outcome.** Plan at most 10 minutes of implementation, reserve 2 minutes for focused verification and 3 for recording/checkpointing. Default to one batch per reply. Stop adding scope at the 10-minute mark; split unfinished work instead of continuing into a timeout. | The owner interrupted the previous oversized stage after multiple timeout errors. No cross-module feature bundling, no unrelated refactors hidden in a page change, and no resetting current data to recover from a timeout. A newly discovered unrelated defect is recorded for its own batch; only a small blocking correction that fits the remaining budget belongs in the current one. | 2026-10-09 |
| D-051 | **Publish source, not runtime credentials or business backups.** Repository: `https://github.com/deepakpt2/cairn-erp`, branch `main`. Preserve existing repository history and license; exclude actual environment files, database dumps, checkpoint archives, screenshots, dependencies and generated builds. ~~A one-time credential is used only in process memory, never in Git URLs/configuration, source or this log.~~ **Local persistence superseded by D-052; credentials remain excluded from Git, public source and this log.** | The owner requested publication to this repository. Its existing GPL v3 license is retained unchanged; the repository is public. `.env.example` contains explicitly development-only values and a replace-before-use session-secret placeholder. This request does not change ERP scope or authorise deleting/resetting current data. | 2026-10-09 |
| D-052 | **Owner-approved private local credential persistence.** Store repository URL and the owner-supplied token in `.env.local` as `GITHUB_REPO_URL` and `GITHUB_PAT`, with owner-only `0600` permissions. Keep the file ignored/untracked; no `NEXT_PUBLIC_` prefix, token in Git URLs/configuration, public source, project log or source archives. | Explicit owner instruction on 2026-10-10: rotation will be done later; save these values locally and exclude them from Git. Supersedes only D-051's memory-only credential clause, not its public-source boundary. Existing local configuration is preserved; no GitHub operation or token rotation is performed in this batch. | 2026-10-10 |
| D-053 | **Ship real deployment slices, not nonexistent services.** The first Docker batch includes app, PostgreSQL 17 and a one-shot migration/reference job. Next standalone output runs as non-root; app uses restricted `cairn_app`, while only migration tools receive the owner URL. Existing Traefik `proxy`/`web` integration is retained without a Traefik service or certresolver. | The owner found Docker files missing from the published checkpoint. The full §22 target stack remains required, but worker, PgBouncer, Dragonfly, scheduled/WAL backups and restore verification get separate tested batches rather than fake commands or an oversized phase. Configuration/build checks are not represented as a successful Docker-host deployment. | 2026-10-10 |
| D-054 | **Synchronize the managed runtime role before Docker migrations.** The one-shot operations job reads the actual `DATABASE_URL` password, uses a separate owner connection to create/alter only `cairn_app`, enforces restricted role flags, then verifies runtime authentication before applying schema migrations. Existing-volume recovery is an explicit local-admin credential repair, never deletion/reset. | The owner reported PostgreSQL SQLSTATE 28P01 for `cairn_app`. Persistent volumes retain passwords, and legacy applied migration 9000 creates a missing role with a development fallback. That migration remains immutable; the deployment job now establishes the configured role first. Owner passwords changed on an existing volume require the documented local-socket repair. | 2026-10-10 |
| D-055 | **Default Compose deployment uses project `.env`, without repeated env-file flags.** `.env.example` is now the deployment template; the old local-Node template moves to `.env.development.example`, and `.env.docker.example` remains a compatibility template only. Keep explicit whitelisted container variables rather than passing the whole file into the app. | Owner clarification: the host was changed to `.env` and the owner does not want `--env-file .env.docker` on every command. Compose already loads project `.env`; the problem is potentially stale containers/stored role passwords, not the supported filename. Existing actual secret files are never overwritten or committed. | 2026-10-10 |
| D-056 | **Database connection URLs use a Cairn-specific private-network alias.** PostgreSQL stays on `cairn_internal` with alias `cairn-postgres`; app and migration runtime/owner URLs all use that alias, never generic `db` or a hardcoded IP. App remains on the existing external proxy for Traefik. | The owner diagnostic confirmed equal credentials but app-side `db` DNS resolved 172.18.0.9 while the intended database was 172.31.0.2. This is a shared-network wrong-target collision, not a stored-password mismatch. Correct routing and recreate connection pools; no password reset, volume deletion or ERP-data edit is required. | 2026-10-10 |
| D-057 | **Production web tenant provisioning is deployment-owner controlled, not public registration.** First tenant requires a configured private `CAIRN_PROVISIONING_TOKEN` of at least 32 characters. Once any tenant exists, both that token and a verified session with `CFG.PLT.CLIENT.ONBOARD` are required. Recheck admission under a global transaction advisory lock before the insert; client-side flags cannot authorize it. | Owner correctly identified public onboarding as a security risk. Missing/wrong owner token fails closed, even for administrators. Existing users/data stay unchanged. Anonymous production directory/launchpad access is closed; signed-in directories show only their own tenant. Only an explicitly server-configured development environment retains the isolated fixture path. This supersedes D-044's unrestricted onboarding clause, not its session/tenant isolation rules. | 2026-10-10 |
| D-058 | **Payment Methods v1 is a tenant-scoped, country-specific definition catalogue.** Key each method by tenant + ISO country + 1–2-character uppercase ASCII alphanumeric code; the same code may have a different meaning in another country. Each definition has a description, allowed direction (`OUTGOING`, `INCOMING`, or `BOTH`) and active state. Ship no standard method rows. | Owner approved one shared master with direction eligibility, definitions-only scope, and no generic seed entries. Future company-code assignments resolve their code against that company code’s country and required direction: Supplier = outgoing, Customer = incoming. B-018/B-019 Customer values remain format-only until a separate integration batch. Supplier/customer permissions, house-bank eligibility, payment-medium formats and payment execution remain separate work; no transaction behavior is implied. | 2026-10-11 |
| D-059 | **Partner bank and contact v1 records are partner-wide, valid-dated, audited, and privacy-preserving.** Bank details are a multi-record partner-general dataset shared for a dual-role partner; contact persons are also partner-general, while the existing general email/phone remain organisation-level values. | Owner-approved bank fields: account holder, country, bank name/code, IBAN or local account number, BIC/SWIFT, valid-from/to and active state. Full bank identifiers must be encrypted at rest, masked in ordinary views and history, and revealed only via a separate audited authority; generic change history must never contain plaintext identifiers. No company-code/role assignment, default payment choice, payment-method permission, house-bank eligibility, or payment execution is included. Contact persons carry name, title/function, email, phone, validity and active state, with at most one primary at a time per partner. Log contact-data views/changes; mask personal email/phone in history and end-date/inactivate records, with hard deletion only through an approved retention/privacy workflow. Country-profile data coverage and encryption-key implementation remain follow-up work. | 2026-10-11 |
| D-060 | **Partner bank fields are governed by fail-closed country profiles and standards-based identifier validation.** A bank country without a defined profile cannot accept a bank record. | Require account holder and bank country; each country's profile determines whether IBAN or local account number is required and whether bank code/BIC is mandatory. Bank name remains optional. Normalize IBAN uppercase without spaces, validate country prefix against bank country, country-specific length and MOD-97 checksum; validate supplied BIC/SWIFT syntax, but never claim bank/account existence. Valid-from is required, valid-to optional with inclusive endpoints; reject valid-to before valid-from. Multiple records may overlap; active state is independent; never hard-delete a bank record. Owner approved in B-047. | 2026-10-11 |
| D-061 | **Initial bank-validation profile coverage is IN, KW, GB, US and JP.** A profile must be implemented and verified for each before that country's bank details can be stored; unprofiled countries fail closed (D-060). | Owner-selected initial country set in B-048. All five ISO-2 codes are already in the 30-country reference seed; this selects profile work only, not profile readiness. Other countries may be added through later explicit profile work. | 2026-10-11 |
| D-062 | **Kuwait partner-bank capture uses an IBAN-only profile.** Account holder and country remain required; require a bank-issued KW IBAN, do not accept a separate local account number, and derive the four-letter bank code from the IBAN. | CBK states Kuwait's IBAN was activated in 2011 and describes its 30-character structure, including `KW`, two check digits, a four-letter bank code and a 22-character account component; the account-holding bank issues the IBAN. SWIFT Registry Release 103 (Sep 2026) specifies `KW2!n4!a22!c`, length 30, with the bank identifier in BBAN positions 1–4. Normalize to uppercase electronic form, remove spaces, enforce country/length/pattern and MOD-97; do not claim account existence. BIC is optional in this non-payment master-data record; if supplied, syntax-check it, leaving payment-routing requirements to a later payment slice. Sources: [CBK IBAN page](https://www.cbk.gov.kw/en/payment-systems/iban), [CBK implementation manual](https://www.cbk.gov.kw/en/images/iban-9721_v60_tcm10-9721.pdf), [SWIFT IBAN Registry](https://www.swift.com/resource/iban-registry-pdf). | 2026-10-11 |
| D-063 | **India partner-bank capture uses a local account number plus IFSC, not an IBAN.** Account holder and country remain required; require the supplied local account identifier and the beneficiary-branch IFSC. | RBI describes IFSC as an 11-character alphanumeric branch-routing code with four alphabetic bank characters, `0` in position 5 and six branch characters; normalize to uppercase and validate syntax as `^[A-Z]{4}0[A-Z0-9]{6}$`, with no directory or account-existence lookup in this slice. Keep the account number opaque and exact: RBI's 2013 committee report documents bank-specific number structures, so impose no India-wide length/pattern/check digit, padding or truncation and preserve leading zeros. The report's India IBAN material was a proposal opened for comment, not an implemented national format; SWIFT IBAN Registry Release 103 has no `IN` profile. Bank name and BIC are optional for this non-payment master-data record; BIC syntax-checking, if supplied, does not equate IFSC with BIC or settle later payment-routing needs. Sources: [RBI NEFT FAQ](https://www.rbi.org.in/scripts/faqview.aspx?id=60), [RBI Technical Committee report](https://www.rbi.org.in/scripts/PublicationReportDetails.aspx?ID=695), [RBI consultation press release](https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=27975), [SWIFT IBAN Registry](https://www.swift.com/resource/iban-registry-pdf). | 2026-10-11 |
| D-064 | **United Kingdom partner-bank capture uses a GB IBAN.** Account holder and country remain required; require a bank-issued GB IBAN rather than a local-account-only entry. | Normalize to uppercase electronic form without spaces; require 22 characters matching `^GB[0-9]{2}[A-Z]{4}[0-9]{14}$` and a valid MOD-97 check. The four-letter institution identifier is embedded in positions 5–8; the six-digit sort code and eight-digit account number are embedded in positions 9–14 and 15–22, so do not request duplicate local-account/routing fields. Bank name and BIC are optional for this non-payment master-data record; syntax-check supplied BIC, but do not claim bank/account existence or payment-rail eligibility. Sources: [SWIFT IBAN Registry Release 103](https://www.swift.com/resource/iban-registry-pdf), [Pay.UK Standard — UK IBAN format](https://www.wearepay.uk/wp-content/uploads/2018/10/Pay.UK-Standard-Format-of-the-IBAN-issued-in-the-UK-October18.pdf). | 2026-10-11 |
| D-065 | **United States partner-bank capture uses a local account number plus ABA routing transit number (RTN), not an IBAN.** Account holder and country remain required; the required RTN occupies the existing bank-code field. | Require exactly nine ASCII digits matching `^[0-9]{9}$`; the first two digits must be in ABA's bank/legacy-thrift routing-symbol ranges `01–12` or `21–32`. Validate the ABA check digit using the 3-7-1 mod-10 rule: `3(d1+d4+d7)+7(d2+d5+d8)+(d3+d6+d9) ≡ 0 (mod 10)`. Treat the account number as opaque: preserve leading zeros and impose no U.S.-wide length, pattern, checksum, padding or truncation. Do not query a live directory or assert that an RTN is assigned/current, suitable for a particular ACH/wire/check rail, or that an account exists. Bank name and BIC are optional for this non-payment master-data record; syntax-check supplied BIC. SWIFT IBAN Registry Release 103 has no `US` profile. Sources: [ABA Routing Number Policy & Procedures](https://www.aba.com/news-research/analysis-guides/routing-number-policy-procedures), [ABA routing-number registry information](https://www.aba.com/about-us/routing-number), [Apache Commons Validator ABA check-digit reference](https://commons.apache.org/proper/commons-validator/apidocs/org/apache/commons/validator/routines/checkdigit/ABANumberCheckDigit.html), [SWIFT IBAN Registry Release 103](https://www.swift.com/resource/iban-registry-pdf). | 2026-10-11 |
| D-066 | **Japan partner-bank capture uses a local account number plus the domestic institution-and-branch code, not an IBAN.** Account holder and country remain required; no new field is added. | Require the complete four-digit financial-institution code plus three-digit branch/store code in the existing bank-code field as a seven-digit numeric composite (`^[0-9]{7}$`), preserving leading zeros. Require the associated bank-supplied local account number as opaque text; impose no nationwide length/pattern/checksum or zero-padding/truncation rule. For Japan Post Bank, capture the interbank-transfer representation and code supplied by its official conversion guidance; do not algorithmically convert its separate symbol/number identifier or perform directory/account-existence lookup. Bank name and BIC are optional for this non-payment master-data record; syntax-check supplied BIC. Account type and payment-rail-specific variants remain outside D-059. SWIFT IBAN Registry Release 103 has no `JP` profile. Sources: [SWIFT IBAN Registry Release 103](https://www.swift.com/resource/iban-registry-pdf), [Japanese Bankers Association member/code directory](https://www.zenginkyo.or.jp/abstract/outline/organization/member-01/), [MUFG branch-code/account-number guidance](https://www.bk.mufg.jp/ebusiness/gplus/listofbranchesinjapan.html), [Japan Post Bank transfer-format guidance](https://www.jp-bank.japanpost.jp/kojin/sokin/furikomi/kouza/kj_sk_fm_kz_1.html). | 2026-10-11 |
| D-067 | **Full partner-bank identifiers use a versioned app-managed keyring; key IDs are authenticated with the ciphertext and bound to the record context.** | Owner selected high-entropy keys delivered through deployment secrets, key IDs, retained prior keys for decryption during rotation and later re-encryption, and no external KMS. B-054 implements AES-256-GCM with random 96-bit nonces and 128-bit authentication tags; envelope version, key ID, tenant/client, partner, bank-record ID, and field are authenticated as associated data. The primitive encrypts with the active key and can decrypt with a retained prior key; it does not load keys, authorize or audit reveals, mask history, or persist data. Key provisioning and the remaining safeguards stay separate prerequisites; no bank identifiers may be stored until the full gate is satisfied. | 2026-10-11 |
| D-068 | **The app-managed keyring is loaded lazily from one deployment-secret value, with strict validation and no fallback.** | B-055 sets `CAIRN_BANK_DATA_KEYRING_JSON` to a JSON object with exactly `activeKeyId` and `keys`; each key ID maps to canonical unpadded base64url for exactly 32 random bytes. The parser accepts at most 16 keys, requires the active ID to exist, rejects unknown fields/malformed values, and emits a generic error that never includes the secret. Compose passes the variable only to the app container, not the migration job. Templates contain comments only; actual key material remains in the deployment secret channel, with old keys retained until re-encryption is verified. This is an implementation contract, not approval to store bank identifiers. | 2026-10-11 |
| D-069 | **Key rotation uses an authenticated envelope transform, not an implicit database mutation.** | B-056 fully authenticates/decrypts an envelope with its recorded key ID and record context, then encrypts under the supplied keyring's active ID with a fresh nonce; valid envelopes already under the active key are authenticated and returned unchanged. The helper returns only ciphertext and performs no persistence, logging, history write, key retirement, or reveal authorization. Future callers own transactional storage, monitoring/audit policy, bulk re-encryption, verification, and old-key retirement. | 2026-10-11 |
| D-070 | **Generic change history for partner bank/contact records is projected through a privacy allowlist on both write and read.** | `partner_bank` histories mask IBAN/local-account/account-identifier values; `partner_contact` histories mask personal email/phone values. Unknown and nested fields are omitted; free-form reasons and caller field labels are suppressed, and read-time projection also redacts any older stored value. `business_partner` organization-level email/phone history remains unchanged. Bank/contact callers must use opaque record keys. This is a history safeguard only: ordinary views, encryption/storage integration, and reveal authorization remain separate work. | 2026-10-11 |
| D-071 | **Full bank-account identifiers may be revealed only through a dedicated, audited operation.** | Owner selected `SEC.PARTNER.BANK.REVEAL`, normal capability-pattern matching, plus `FND.PARTNER.DISPLAY`; therefore `FND.*`/`AUDIT.*` do not imply reveal, while the Administrator `*` pattern does. One operation may select one or more IBAN/local-account fields only; bank code/BIC and contact coordinates are outside reveal scope. Require one controlled purpose code (`PARTNER_SUPPORT`, `DATA_CORRECTION`, `AUDIT_REVIEW`, `LEGAL_REGULATORY`) and log every authenticated attempt to `audit_access_log` with session-derived actor/tenant, opaque partner and bank-record IDs, field names, outcome and fixed denial code—never values, ciphertext or key material. Commit the success audit event before returning plaintext; audit persistence failure denies the reveal. Harden the existing log against UPDATE/DELETE at the database layer before reveal implementation. | 2026-10-11 |
| D-072 | **Audit-log protection revokes direct runtime mutation, while full tenant deletion retains its current cascade.** | B-059 revokes `UPDATE`, `DELETE`, and `TRUNCATE` on `audit_access_log` from `cairn_app` while preserving `SELECT` and `INSERT`. Owner explicitly chose to retain the existing `client` → `audit_access_log` `ON DELETE CASCADE` as a permitted whole-tenant lifecycle/retention exception; no FK or tenant-delete-policy change is included. Thus append-only protection applies to direct runtime log-row mutation, not authorized tenant deletion. | 2026-10-11 |
| D-073 | **Bank reveal is a two-stage, session-bound audit boundary; authorization alone is not a completed reveal.** | B-060 validates the owner-selected `FND.PARTNER.DISPLAY` + `SEC.PARTNER.BANK.REVEAL` authorities, selected IBAN/local-account field names and controlled purpose codes, and records only safe metadata. An `AUTHORIZED` gate event is not proof plaintext was released. The later data service must record a terminal `SUCCESS` or fixed-code `DENIED` event in the same tenant transaction and commit before returning any plaintext. No decrypt, storage, route or plaintext is part of B-060. | 2026-10-11 |
| D-074 | **Ordinary bank-identifier detail views may show only a limited suffix; list views expose no suffix.** | Owner selected fixed `••••` in list/summary views and `••••` plus the final four characters in detail views for IBAN and local account identifiers. Never preserve original length or country prefix; identifiers of four or fewer characters remain fully masked to prevent accidental full-value disclosure. History remains fully masked as D-070, and any complete value still requires the separately audited reveal capability. | 2026-10-11 |
| D-075 | **Normal-view bank projections reuse the strict bank-history allowlist but apply a separate display mask.** | B-062 uses `••••` for list/summary and the final-four detail form from D-074; ciphertext aliases, unknown fields and nested values are omitted. Safe allowlisted metadata may remain, while the history projection continues to use `[masked]` for every sensitive identifier. This is a pure projection only, not authorization, storage or UI integration. | 2026-10-11 |
| D-076 | **The KW bank profile is a pure IBAN-only validator; no separate local account is accepted.** | B-063 enforces `KW` + two check digits + four-letter bank code + 22 alphanumeric account characters, uppercases and removes ASCII spaces, and validates MOD-97. It derives the bank code from IBAN positions 5–8; optional BIC receives syntax-only validation, with no account/bank existence lookup. Account holder and KW country are required. The helper is not registered, activated or connected to storage. | 2026-10-11 |
| D-077 | **The IN bank profile is a pure local-account + IFSC validator; account identifiers remain opaque.** | B-064 requires account holder and country `IN`, preserves the non-empty local account number exactly without country-wide syntax/length/checksum/padding/truncation rules, and normalizes the IFSC in the existing bank-code field before enforcing `^[A-Z]{4}0[A-Z0-9]{6}$`. Reject a non-empty IBAN. Optional BIC is syntax-checked only. No directory/account lookup, persistence or profile activation. | 2026-10-11 |
| D-078 | **The GB bank profile is a pure bank-issued IBAN validator.** | B-065 removes ASCII spaces, uppercases, enforces the 22-character `GB` structure and MOD-97, derives the four-letter bank code from IBAN positions 5–8, and rejects a separate non-empty local account number. Optional BIC is syntax-checked only; no directory/account-existence or payment-rail assertion. No profile activation or storage integration. | 2026-10-11 |
| D-079 | **The US bank profile requires an opaque local account number and a syntactically/check-digit-valid ABA routing number.** | B-065 preserves the non-empty account number exactly without a U.S.-wide pattern/length rule. It requires nine ASCII routing digits, ABA symbol range `01–12` or `21–32`, and the 3-7-1 mod-10 check. Optional BIC receives syntax-only validation; reject a non-empty IBAN. No live directory, assignment/currentness, payment-rail, or account-existence claim; no profile activation or storage integration. | 2026-10-11 |
| D-080 | **The JP bank profile requires a seven-digit institution-plus-branch code and an opaque local account number.** | B-065 preserves leading zeros in the existing bank-code field and preserves the non-empty local account number exactly, with no nationwide account-number length/pattern/checksum or padding/truncation rule. Reject a non-empty IBAN. Optional BIC is syntax-checked only; no directory/account-existence lookup or account-number conversion. No profile activation or storage integration. | 2026-10-11 |
| D-081 | **The partner read route enforces `FND.PARTNER.DISPLAY` before accessing partner data.** | B-066 checks the session capability in `/foundation/partners` before reading search parameters, listing/fetching partners, or loading history; maintenance actions remain separately guarded by `FND.PARTNER.MAINTAIN`. This establishes the actual display-authority prerequisite for any future reveal flow, but does not implement reveal. Opaque bank-record-ID handling remains an independent unresolved gate. | 2026-10-11 |
| D-082 | **Bank-record IDs are server-generated random UUIDv4 values; future reads/reveals must use tenant-, partner- and ID-scoped lookup.** | B-067 adds a cryptographic UUIDv4 generator and tightens the B-060 audit-boundary shape check to canonical lowercase UUIDv4. UUID syntax alone does not establish provenance. A future service must ignore raw client-supplied IDs as authority, load the row under the authenticated session tenant and selected partner, and use the matched row's ID for audit/encryption context. No bank table, row creation, lookup, persistence, or reveal path is included; the opacity gate remains until that scoped data path uses this contract. | 2026-10-11 |
| D-083 | **Bank-data encryption/decryption contexts accept only canonical UUIDv4 bank-record IDs.** | B-068 enforces UUIDv4 shape at the encryption AAD boundary and types the context ID as `BankRecordId`, preventing ad hoc sequential IDs from being used accidentally in code or ciphertext context. This is format enforcement, not provenance: database reads must still be constrained by authenticated tenant, partner and ID before any reveal path. No schema, persistence or data flow is added. | 2026-10-11 |
| D-084 | **A pure batch transformer may re-encrypt supplied bank-data envelopes without exposing plaintext or persisting results.** | B-069 authenticates each non-null field with its client/partner/UUIDv4-row/field context, writes under the active key, preserves nulls and already-current ciphertext, and returns ciphertext only. Invalid input fails the whole transformation. Database chunking/transactionality, scan completeness, verification of old-key retirement, audit/monitoring and persistence remain caller/operational responsibilities. | 2026-10-11 |
| D-085 | **A supplied ciphertext batch can be authenticated with an active-key-only keyring as a local rotation check.** | B-070 requires a keyring containing only its active key, authenticates every non-null envelope/context in the caller-supplied rows, and returns counts only. A passing batch proves nothing about omitted/unscanned database rows, concurrent writes, persistence, or global key retirement. Operational completeness and verified retirement remain separate. | 2026-10-11 |

---

## §3 · Conformance model & Divergence Register `AGREED`

### 3.1 Why this exists

R-02 demands exactness; R-18 permits divergence on edge cases. Without a written rule, the two
requirements erode each other silently. Every screen, engine and posting is therefore classified
into one of three tiers, and every known divergence is registered.

### 3.2 Conformance tiers

| Tier | Name | Rule | Test |
|---|---|---|---|
| **A** | **Exact** | Must behave as the reference system does. An implementation plan ports directly. | Differential test against documented reference behaviour: same inputs → same documents, same postings, same document flow. |
| **B** | **Equivalent** | Our own codes, schema and screens; semantically identical: same inputs, same outputs, same accounting, same sequence. | Traceability test: every reference field/step has a named counterpart in our schema or screen. |
| **C** | **Divergent by design** | Structure and a configuration hook preserved; behaviour simplified or different. | Registered in §3.3 with an alignment estimate. |

**Rule of assignment:** standard mid-size company usage → Tier A or B. Genuinely specialist,
rarely-used, legally-uncertain or disproportionate functionality → Tier C.

### 3.3 Divergence Register (living)

Reviewed at every page walkthrough. "Align later" = effort to reach Tier A/B if ever required.

| ID | Divergence | Tier | Hook that keeps it alignable | Align later |
|---|---|---|---|---|
| DV-001 | No statutory payroll tax/social-insurance calculation | C | Payroll results can be imported and posted; deduction rule engine is configurable per jurisdiction | High — needs real country rules; deliberately never built |
| DV-002 | No overhead application via costing sheet | C | Production order costing structure supports additional cost components; order is already a cost collector | Medium |
| DV-003 | No WIP calculation and reversal at period end | C | Order carries collected costs and status; WIP is an additional period-end posting into the existing structure | Medium |
| DV-004 | Variance not split into price/quantity/mix/yield categories | C | Single variance GL, but order stores actual vs target quantity and value, so categories are derivable | Medium |
| DV-005 | No capacity planning, capacity levelling or finite scheduling | C | Work centre and operation records carry capacity-relevant fields; scheduling uses infinite capacity | High |
| DV-006 | Scrap, co-products, by-products and subcontracting not modelled | C | Order component and operation records have the structural slots reserved | Medium |
| DV-007 | MRP parameter depth reduced (no planning strategies beyond make-to-stock, no forecast consumption) | C | MRP area and material planning fields exist; strategy field reserved | Medium |
| DV-008 | Visual identity, screen layouts and iconography deliberately not reproduced | C | Behaviour taxonomy preserved, so SAP users need no retraining (R-03) | Permanent by design |
| DV-009 | Tier 3 transactions are registry entries, not built screens | C | Registry entry carries metadata; building it later is an additive screen implementation | On demand |
| DV-010 | No user exits, BAdIs or modifications; extension points instead | C | Documented extension hooks at posting, validation and output stages | Medium |
| DV-011 | No raw configuration table maintenance screens | C | All configuration is exposed through validated Configuration Workbench activities (R-06) | Permanent by design |
| DV-012 | People module uses our own record-type system instead of infotype numbering | C | Record types carry validity dating and alias metadata, so the date-delineated behaviour is identical | Low |
| DV-013 | Asset accounting simplified: straight-line and declining balance, no investment management | C | Depreciation area and method tables exist | Low |
| DV-014 | No profit-centre derivation variants; derivation is rule-based and configurable | C | Derivation rule table, extensible | Low |

---

## §4 · Naming, codes & IP boundary `AGREED`

### 4.1 The boundary

| Reproduce | Do not reproduce |
|---|---|
| Business concepts, workflow order, field semantics, organisational structure, document flow, define/assign configuration pattern | Source code, table and field identifiers, transaction codes, screen designs, icons, colour schemes, trademarks, product names |
| Number ranges, fiscal year variants, posting periods, release strategies, condition technique as *concepts* | Their implementation, their exact screens, their internal technical key names in our schema |

**Code of conduct for the build:** our identifiers are ours. Reference-system identifiers appear
only in the alias registry as search metadata, and in this document where traceability is required.

### 4.2 Module codes

| Module | Code | Covers |
|---|---|---|
| Platform | `PLT` | Tenancy, users, roles, registry, jobs |
| Foundation | `FND` / `CFG` | Enterprise structure and configuration |
| Procurement | `PROC` | Requisitions, RFQ, purchasing, vendor invoicing |
| Inventory | `INV` | Goods movements, stock, warehousing, counting |
| Production | `PROD` | BOM, routing, MRP, production orders |
| Sales | `SALES` | Inquiry to billing, returns, pricing |
| Finance | `FIN` | GL, AP, AR, assets, banking, closing |
| Costing | `COST` | Cost centres, activity types, internal orders, profitability |
| People | `PEOPLE` | Employees, org, time, payroll posting |
| Audit | `AUDIT` | Auditor workspace, trail, integrity, evidence |

### 4.3 Code grammar

```
Transaction code :  MODULE.OBJECT.ACTION           e.g.  PROC.PO.CREATE
Configuration    :  CFG.AREA.OBJECT.ACTION         e.g.  CFG.FIN.COMPANYCODE.DEFINE
Report           :  MODULE.RPT.NAME                e.g.  FIN.RPT.TRIALBALANCE
List / worklist  :  MODULE.LIST.NAME               e.g.  SALES.LIST.OPENORDERS
```

Actions: `CREATE` `CHANGE` `DISPLAY` `POST` `REVERSE` `CANCEL` `RELEASE` `APPROVE` `EXECUTE`
`DEFINE` `ASSIGN` `COPY` `CONVERT` `SETTLE` `CLOSE` `SIMULATE` `IMPORT` `EXPORT` `PRINT`.

### 4.4 Alias registry (the Term Registry)

A first-class, searchable subsystem. Typing a reference-system identifier lands the user on our
equivalent screen, table, config activity or concept note — **and states the coverage tier**.

| Search term type | Example input | Result |
|---|---|---|
| Reference transaction code | `ME21N` | Opens `PROC.PO.CREATE`, labelled "reference alias · Tier 1 · built" |
| Reference table | `BSEG` | Opens data-model entry for `journal_entry_line` |
| Reference feature | `release strategy` | Opens `CFG.PROC.RELEASE.DEFINE` |
| Our own code | `PROC.PO.CREATE` | Direct navigation |
| Concept | `GR/IR clearing` | Concept note + related screens + postings |

**Coverage tiers exposed to users:** `Tier 1 built` · `Tier 2 configured` · `Tier 3 mapped (not built)`.

**Schema (planned):**

| Table | Purpose |
|---|---|
| `term_registry` | One row per term: type, external system, external identifier, our code, our table, coverage tier, status, notes, search vector |
| `term_alias` | Many-to-many synonyms for a registry entry (multiple reference codes may map to one of our screens) |
| `term_relation` | Links terms to each other (screen ↔ table ↔ config activity ↔ concept) |

**Design consequences:** every screen registers itself with metadata (code, alias set, fields,
actions). This powers the command box, alias search, navigation — and auto-generates part of the
page inventory in §26. The registry is populated as pages are reviewed (R-08), so it doubles as
our implementation guide.

---

## §5 · Platform architecture & engine design `DRAFT`

### 5.1 Principle

Modules do not talk to each other directly. Features are composed from a small set of platform
engines that own the invariants. A goods receipt in Inventory and a goods issue in Sales both go
through the same material-document engine, the same numbering engine and the same posting engine.
This is why the system stays consistent as modules multiply.

### 5.2 Engines

| # | Engine | Owns | Key behaviours | Used by |
|---|---|---|---|---|
| E1 | **Identity & access** | Users, roles, authorization objects, field-value restrictions, access log | Role-based capability + org-level restriction (e.g. restricted to a company code or plant) | All |
| E2 | **Organizational graph** | Client, company code, plant, storage location, purchasing org, sales org, controlling area | Define/assign semantics with dependency gating; asks "can this step run yet?" | All config |
| E3 | **Number range** | Ranges per object/type/fiscal year, intervals, current number | Gap-free allocation; DB-locked or buffered intervals; never reuses a number | Every document |
| E4 | **Enqueue / locking** | Named lock objects, lock modes (exclusive/shared), lock table view | PostgreSQL advisory locks, ordered acquisition to avoid deadlocks, stale-lock recovery | Posting, MRP, payment run, close |
| E5 | **Document engine** | Generic document contract, statuses, flow links, reversal links, change documents | Document principle; reversal never deletion; every document traceable to origin | All modules |
| E6 | **Posting engine** | Account determination, currency conversion, tax calculation, posting period validation, balanced-entry invariant | Single atomic transaction: logistics documents + accounting document + flow links + numbering | INV, PROC, SALES, PROD, FIN, PEOPLE |
| E7 | **Valuation engine** | Stock value, standard price, moving average, price differences, exchange differences | Valuation class determines accounting behaviour; price control per material/plant | INV, PROD, FIN |
| E8 | **Pricing engine** | Condition types, access sequences, pricing procedures, scales, condition records, calculation rules | Deterministic re-pricing on document change; traceable calculation per line | SALES, PROC |
| E9 | **Availability engine** | Stock/requirements ledger, confirmed quantities, availability check | Requirements derived from sales orders, reservations, dependent requirements; ATP by date | SALES, PROD |
| E10 | **MRP engine** | Planning file, net requirements, lot sizing, lead-time offsetting, BOM explosion, exceptions, planned orders | Net-change and regenerative runs; produces planned orders and purchase requisitions (§12) | PROD, PROC |
| E11 | **Costing engine** | Cost estimates, activity rates, cost absorption, variance, settlement, WIP (deferred) | Order as cost collector; actual vs target; settlement to GL (§13) | PROD, COST |
| E12 | **Payment engine** | Payment proposal, selection rules, payment methods, ranking, payment medium, clearing | Proposal → review → execute; reversible run; reconciliation to bank | FIN |
| E13 | **Release / approval** | Release strategies, release groups, release codes, prerequisites, workflow steps, status | Value/field-triggered; multi-level; blocks downstream documents until released (R-05) | PROC, SALES, FIN, PEOPLE |
| E14 | **Change document** | Field-level before/after values, reason, user, timestamp | Applies to master data and configuration; powers audit drill-through (§16) | All |
| E15 | **Reporting** | Financial statements, balances, line-item reports, drill-through, export | Every figure drills to its source document | FIN, COST, AUDIT |
| E16 | **Import / migration** | Templates, staging, validation, simulation, posting, sessions, dependency ordering | Simulation before posting; same validations as manual entry (§18) | All |
| E17 | **Output** | Output definitions, conditions, PDF/print generation, email, archive | Queued on worker; artefacts stored and reproducible (§17) | All |
| E18 | **Job & scheduling** | Job definitions, queues, runs, logs, retries, scheduling | All long tasks on the worker (D-022) | All |

### 5.3 Anatomy of a posting (worked contract)

Example: goods receipt against a purchase order. One database transaction, ordered phases.

| # | Phase | Effect | Failure result |
|---|---|---|---|
| 1 | Authorisation | Check user capability + org restriction | Abort, message, no state change |
| 2 | Locking | Acquire lock objects (material, plant, PO line) in fixed order | Abort or wait per policy |
| 3 | Validation | PO exists, is released, open quantity sufficient, posting period open, material active in plant | Abort with field-level messages |
| 4 | Valuation | Determine price, compute value, resolve price difference against standard price | Abort if valuation class missing |
| 5 | Number allocation | Consume material document number and accounting document number, gap-free | Abort, interval untouched |
| 6 | Document creation | Material document + lines written, status set | Abort |
| 7 | Stock update | Stock and value updated on the stock segment | Abort |
| 8 | Purchase-order history | Quantity and value updated on the PO line; consumption recorded | Abort |
| 9 | Account determination | Business event → GL accounts via configured keys | Abort if incomplete → message names the missing configuration |
| 10 | Accounting document | Balanced document written; books must balance or the whole transaction aborts | Abort |
| 11 | Document flow | Links written: PO → goods receipt | Abort |
| 12 | Change/audit trail | Entry written with user, timestamp, document numbers | Abort |
| 13 | Release locks | Locks released; post-commit jobs queued (output, availability, costing) | Locks always released in a finally block |
| 14 | Commit | Single commit; everything above is atomic | — |

**Invariant:** an unbalanced accounting document is structurally impossible. Enforced at the
schema level (deferred constraint) and again in the engine.

### 5.4 Document model

Each document class has its own header and line tables (clarity, performance, faithful structure)
**plus** a shared contract so the platform engines work uniformly.

Shared columns on every document header: `client`, `document_type`, `document_number`,
`fiscal_year`, `document_date`, `posting_date`, `posting_period`, `status`, `created_by`,
`created_at`, `reversal_of`, `reversed_by`, `origin_document`, `reference`.

Central cross-cutting tables:

| Table | Purpose |
|---|---|
| `document_flow_link` | Directed graph: predecessor → successor with type and quantity/value context |
| `document_status_history` | Every status transition with user, timestamp, reason |
| `change_document` / `change_document_item` | Field-level changes on master data and configuration |
| `document_index` | Lightweight search index across all document classes for global search and drill-through |

**Why not one fat document table:** the reference system's per-application document tables exist
for good reasons — different line semantics, different volumes, different retention. A single EAV
table would make financial reporting and MRP both slow and unclear.

---

## §6 · Organizational model & multi-tenancy `DRAFT`

### 6.1 Structure

```
Client (tenant)
├── Company code .......................... legal entity, books its own balance sheet
│     ├── Chart of accounts (assigned)
│     ├── Fiscal year variant (assigned)
│     ├── Currency
│     └── Plant* ......................... production / storage site
│           └── Storage location ......... physical stock area
├── Controlling area ...................... cost accounting boundary; may span company codes
├── Credit control area ................... shared credit limit boundary; may span companies
│     ├── Cost centre hierarchy
│     ├── Activity types
│     └── Profit centres / internal orders
├── Purchasing organisation ............... negotiates and buys; may serve many plants
│     └── Purchasing groups .............. buyer teams
└── Sales organisation .................... sells; legal responsibility for sales
      ├── Distribution channel
      ├── Division ........................ product line
      └── Sales office / sales group
```

\* A plant is assigned to exactly one company code; a storage location to exactly one plant.

### 6.2 The define/assign pattern (core of R-06)

Configuration is a graph. Almost every config activity either **defines** an object or **assigns**
it to another. The Workbench enforces dependencies and refuses out-of-order steps.

Worked example — the company code chain:

| Step | Activity code | Depends on | Produces |
|---|---|---|---|
| 1 | `CFG.FIN.CURRENCY.CHECK` | — | Currency codes exist |
| 2 | `CFG.FIN.COUNTRY.CHECK` | — | Country codes exist |
| 3 | `CFG.FIN.COA.DEFINE` | Countries | Chart of accounts |
| 4 | `CFG.FIN.COMPANYCODE.DEFINE` | Countries, currency | Company code |
| 5 | `CFG.FIN.COMPANYCODE.ASSIGN_COA` | 3, 4 | Chart of accounts adopted |
| 6 | `CFG.FIN.FYV.DEFINE` | — | Fiscal year variant |
| 7 | `CFG.FIN.COMPANYCODE.ASSIGN_FYV` | 4, 6 | 12 or 13 periods with special periods |
| 8 | `CFG.FIN.POSTINGPERIOD.DEFINE` | 4, 7 | Posting period variant |
| 9 | `CFG.FIN.COMPANYCODE.ASSIGN_PPV` | 4, 8 | Open/closed periods per account type |
| 10 | `CFG.FIN.NUMBERRANGE.DEFINE` | 4 | Document number ranges |
| 11 | `CFG.FIN.ACCTDET.DEFINE` | 4, 5 | Business event → GL account mapping |
| 12 | `CFG.ORG.PLANT.DEFINE` | 4 | Plant |
| 13 | `CFG.ORG.PLANT.ASSIGN_COMPANY` | 12 | Ownership |
| 14 | `CFG.ORG.STORAGELOC.DEFINE` | 12 | Storage location |
| 15 | `CFG.PROC.PURORG.DEFINE` | 4 | Purchasing organisation |
| 16 | `CFG.PROC.PURORG.ASSIGN_COMPANY` | 4, 15 | Buying authority |
| 17 | `CFG.PROC.PURORG.ASSIGN_PLANT` | 12, 15 | Plant procurement |
| 18 | `CFG.SALES.SALESORG.DEFINE` | 4 | Sales organisation |
| 19 | `CFG.SALES.SALESORG.ASSIGN_COMPANY` | 4, 18 | Selling entity |
| 20 | `CFG.COST.CONTROLLINGAREA.DEFINE` | 4 | Controlling area |
| 21 | `CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY` | 4, 20 | Cost accounting scope |
| 22 | `CFG.COST.COSTCENTER.DEFINE` | 20 | Cost centres with hierarchy and responsible person |
| 23 | `CFG.COST.ACTIVITYTYPE.DEFINE` | 20 | Activity types (labour, machine, utilities) |
| 24 | `CFG.COST.ACTIVITYRATE.CONFIRM` | 22, 23 | Rate per activity type per cost centre per period |

**This sequence, its gating and its wording are what make an SAP implementation plan portable
(R-06).** Each row becomes a Workbench step with a checklist, prerequisites, and a
"what this enables next" pointer.

### 6.3 Multi-tenancy (R-15)

| Aspect | Design |
|---|---|
| Partition key | `client` on every tenant-scoped table; enforced by PostgreSQL row-level security, not only by application code |
| Configuration scope | Configuration belongs to the **client**, not the company code. A new company code inherits the chart of accounts and most settings and defines only what is specific to it — the reason adding a second company is fast. |
| Company scope | One client may hold several company codes that transact with each other (intercompany). |
| Development tenant | Created by the agent for building and automated tests. |
| Owner tenant | Created **through the UI** during page testing, one page at a time. Tenant onboarding is therefore a first-class, tested feature of Phase 1, not a seed script. |
| Company count | Two company codes within the owner tenant; intercompany postings supported when configured. |
| Number ranges | Per client per object. Tenants never share a range. |
| Isolation test | A dedicated test suite asserts that no query can cross clients with a deliberately mis-scoped request. |

## §7 · Configuration Workbench & Standard Configuration Package `DRAFT`

### 7.1 The Configuration Workbench

The equivalent of the reference system's implementation guide, but as a guided, validated,
dependency-aware tree.

| Capability | Detail |
|---|---|
| Tree navigation | Areas → sub-areas → activities, mirroring an implementation plan's structure so R-06 holds |
| Prerequisites | Each activity declares prerequisites; blocked activities explain *why* they are blocked and what to do first |
| Define/assign marker | Every activity is labelled **Define** or **Assign**, preserving the mental model |
| Validation on entry | Field-level validation plus cross-checks against existing configuration |
| Checklist | Per-company-code and per-module readiness with percentage completion |
| Change log | Every configuration change writes a change document with before/after values (§E14) |
| Where-used | "What depends on this?" before allowing a change — prevents breaking live postings |
| Transport-ready | Configuration export/import as a package, so a proven setup can be replicated to another client |
| Alias search | Reference-system activity identifiers resolve here via the Term Registry (§4.4) |

### 7.2 Tenancy onboarding

Creating a new client runs a wizard covering: client identity and keys → activate standard
configuration package → create first company code → assign chart of accounts, fiscal year variant,
posting periods → create plant and storage location → purchasing organisation → sales
organisation → controlling area → cost centres and activity types → number ranges → account
determination → tax codes → payment terms → users and roles → first login credentials.

This wizard is tested as a product feature (R-15), and it *is* the demonstration of R-06.

### 7.3 Standard Configuration Package (`INTL-STD-2`)

Shipped, versioned, activatable in one action, and used as the fixture for every automated test.

| Group | Contents |
|---|---|
| Enterprise structure | 1 client, 1 company code, 1 controlling area, 1 plant, 1 storage location, 1 purchasing org, 1 purchasing group, 1 sales org, 1 distribution channel, 1 division |
| Financial | Own chart of accounts (~300 accounts, international structure), fiscal year variant (calendar, 12 periods + 4 special), posting period variant, tolerance groups, currencies (local, group, hard) with rate tables, exchange rate types |
| Account determination | Complete mapping of business events → GL accounts for inventory, GR/IR clearing, price difference, consumption, COGS, revenue, tax, bank, salary, provisions, variance |
| Document types & number ranges | Every document class: material documents, accounting documents, purchase orders, sales orders, deliveries, billing documents, production orders, confirmations, payment runs, imports, and more |
| Pricing | Condition types, access sequences, pricing procedures for sales (base price, discounts, surcharges, freight, tax) and for purchasing |
| Tax | Standard VAT, zero-rated, exempt, input tax, reverse charge-capable structure; rates configurable per jurisdiction |
| Procurement | Material types (finished, semi-finished, raw, trading, service), material groups, purchasing info records, release strategy for purchase orders by value threshold, approval levels |
| Supplier partner functions | Tenant catalogue entries for `ORDERING_PARTNER`, `DELIVERY_PARTNER`, and `INVOICE_SENDER`; initial cardinality is unique for all three; no supplier assignments are shipped |
| Production | Work centre, activity types and rates, BOM usage types, routing usage, MRP controllers, lot sizing procedures, scheduling parameters, production scheduling profile |
| Sales | Customer account groups, sales document types, item categories, delivery types, billing types, output types, delivery and billing blocks |
| Master data samples | ~60 materials, ~30 vendors, ~40 customers, cost centres, GL accounts, BOMs and routings for manufactured items, opening stock and balances |
| People | Pay structure components, deduction rule set (illustrative), symbol → GL mapping, EOS provision rates |
| Roles | Administrator, configurator, buyer, planner, production clerk, warehouse clerk, sales clerk, accountant, controller, auditor (read-only), plus SoD conflict rules |

**Sample data set purpose:** the first sale-to-cash flow must be runnable within minutes of tenant
creation. An ERP with empty master data cannot be evaluated.

### 7.4 Data-modelling conventions

| Convention | Rule |
|---|---|
| Table naming | Singular snake_case domain words: `material`, `purchase_order_line`, `journal_entry` |
| Tenant key | `client` first column on every tenant-scoped table |
| Org keys | `company_code`, `plant`, `storage_location`, `purchasing_org`, `sales_org`, `controlling_area` where applicable — always the codes the business uses, not surrogate integers |
| Master keys | Business-meaningful codes: material number, vendor number, GL account number. Surrogates only where the business key is not stable |
| Amounts | `numeric(23,4)` — no floating point, ever |
| Quantities | `numeric(23,3)` with the unit of measure alongside |
| Dates | `date` for business dates, `timestamptz` for technical |
| Audit columns | `created_by`, `created_at`, `changed_by`, `changed_at` on all tables; change documents capture field-level history |
| Soft delete | Master data is blocked (`blocking_flag`, `valid_to`) rather than deleted; documents are never deleted (D-017) |
| Enumerations | Database-level enums or lookup tables, never magic strings in code |

---

## §8 · Data model `DRAFT`

Grouped by domain. This is the authoritative list; column-level DDL is produced in Phase 0 and
will be appended as a reference to the generated schema. Reference-system aliases are shown only
as search metadata.

### 8.1 Platform

| Table | Purpose | Alias (search only) |
|---|---|---|
| `client` | Tenant: key, name, currency, fiscal year variant default, status | Mandant |
| `client_settings` | Per-tenant feature flags, numbering display format, locale | — |
| `user`, `user_role`, `role`, `role_capability`, `capability` | Identity and authorisation | USR02, AGR_USERS |
| `auth_org_restriction` | Limits a user to company codes / plants / purchasing orgs | — |
| `number_range`, `number_range_interval` | Ranges and current state per object, type, fiscal year | NRIV |
| `lock_object`, `lock_state` | Named lock definitions and live lock view | ENQUEUE |
| `term_registry`, `term_alias`, `term_relation` | Alias registry (§4.4) | — |
| `message_catalog` | Message codes, severity, text, variables, i18n keys | Message classes |
| `document_flow_link` | Document graph | VBFA (concept) |
| `change_document`, `change_document_item` | Field-level change history | CDHDR, CDPOS |
| `job_definition`, `job_run`, `job_log` | Worker jobs | SM36, SM37 |
| `output_definition`, `output_condition`, `output_artifact` | Document output (§17) | NACE, NAST |
| `config_activity`, `config_activity_status`, `config_package`, `config_package_item` | Workbench (§7) | IMG |
| `import_session`, `import_row`, `import_error` | Import pipeline (§18) | LSMW / Migration Cockpit |
| `audit_access_log` | Who accessed what, including read-only auditor activity | — |

### 8.2 Foundation / organisation

| Table | Purpose | Alias (search only) |
|---|---|---|
| `company_code` | Legal entity, currency, chart of accounts, fiscal year variant | T001 |
| `chart_of_accounts` | Account list definition, language, length of account number | T004 |
| `gl_account`, `gl_account_company_code` | Chart-level and company-code-level account data | SKA1, SKB1 |
| `controlling_area`, `controlling_area_company` | Cost accounting boundary and assignment | TKA01, TKA02 |
| `cost_center`, `cost_center_hierarchy`, `cost_center_node` | Cost centres and standard hierarchy | CSKS, CSKH |
| `activity_type`, `activity_rate` | Activity types and rates per cost centre per period | CSLA, COKL |
| `cost_element` | Cost element linking to GL account | CSKA |
| `profit_center`, `profit_center_hierarchy` | Profit centres and hierarchy | CEPC, CEPH |
| `plant`, `storage_location` | Sites and areas | T001W, T001L |
| `purchasing_org`, `purchasing_group` | Buying entities and buyer groups | T024E, T024 |
| `sales_org`, `distribution_channel`, `division`, `sales_area` | Selling structure | TVKO, TVTW, TSPA, TVKBZ |
| `currency`, `exchange_rate`, `exchange_rate_type` | Currencies and rates | TCURC, TCURR |
| `fiscal_year_variant`, `fiscal_year_period` | Period structures including special periods | T009, T009B |
| `posting_period_variant`, `posting_period_rule` | Open/closed period control per account type | T010O, T010P |
| `country`, `region`, `unit_of_measure`, `uom_conversion` | Reference data | T005, T006, T006A |
| `tax_code`, `tax_jurisdiction`, `tax_rate` | Tax determination | T007A, T007B |
| `payment_terms`, `payment_method`, `house_bank`, `bank_account` | Payment configuration | T052, T042Z, T012, T012K |
| `tolerance_group`, `tolerance_key` | Posting tolerances and limits | T043, T043S |
| `document_type`, `number_range_assignment` | Document types and their ranges | T003, T003N |

### 8.3 Account determination & valuation

| Table | Purpose | Alias (search only) |
|---|---|---|
| `account_determination` | Our key → GL account, per chart of accounts / valuation area / transaction key | T030 |
| `transaction_key` | Business event keys: goods receipt inventory, GR/IR clearing, price difference, consumption, change in stock, COGS, revenue, revenue deduction, tax, exchange difference, variance, WIP, salary, provision, bank | — (reference keys mapped as aliases) |
| `valuation_area`, `valuation_class` | Valuation boundaries and material valuation behaviour | T001K, T025 |
| `material_valuation` | Price control (standard / moving average), standard price, moving average price, value | MBEW |
| `material_valuation_history` | Valuation changes over time for audit | — |

### 8.4 Materials & inventory (Inventory)

| Table | Purpose | Alias (search only) |
|---|---|---|
| `material`, `material_description` | Material master, general data and descriptions | MARA, MAKT |
| `material_plant` | Plant-level data incl. MRP and valuation parameters | MARC, MBEW |
| `material_storage` | Storage-location-level data | MARD |
| `material_sales`, `material_sales_org` | Sales data per sales org / channel | MVKE |
| `material_purchasing` | Purchasing data per plant | MARC (purchasing fields) |
| `material_type`, `material_group`, `industry_sector` | Classification | T134, T023, T137 |
| `material_component` | BOM / component where-used links | MAST, STPO |
| `stock_segment`, `stock_quantity` | Unrestricted, quality, blocked, returns stock per material/plant/sloc/batch | MARD, MCHB |
| `material_document`, `material_document_line` | Every goods movement; the inventory book of record | MKPF, MSEG |
| `movement_type` | Movement types with their account-determination semantics | T156, T156X |
| `batch`, `batch_characteristic` | Batches and their characteristics | MCH1, AUSP |
| `physical_inventory_document`, `physical_inventory_item` | Counting documents and differences | IKPF, ISEG |
| `stock_transfer_order` | Plant-to-plant transfer including the delivery leg | EKKO (STO type) |
| `reservation`, `reservation_item` | Reserved stock for orders and cost centres | RESB |
| `purchase_order_history` | Ordered / delivered / invoiced quantities and values per PO line | EKBE |

### 8.5 Procurement

| Table | Purpose | Alias (search only) |
|---|---|---|
| `purchase_requisition`, `purchase_requisition_line` | Internal demand requests | EBAN |
| `rfq`, `rfq_line`, `supplier_quotation`, `supplier_quotation_line` | Requests for quotation and responses | EKKO/EKPO (RFQ types) |
| `purchase_order`, `purchase_order_line` | Purchase orders | EKKO, EKPO |
| `po_schedule_line` | Delivery schedules | EKET |
| `po_release`, `po_release_status` | Approval status per release step | — |
| `purchasing_info_record` | Vendor-material price and lead-time agreements | EINA, EINE |
| `source_list`, `quota_arrangement` | Determines which vendor to buy from | EORD, EQUK |
| `gr_ir_item` | Open goods-receipt/invoice-receipt items, and their clearing state | — (clearing worklist) |
| `vendor_invoice`, `vendor_invoice_line`, `vendor_invoice_tax` | Invoice verification documents | RBKP, RSEG |
| `vendor_invoice_hold`, `invoice_block_reason` | Parked, blocked and payment-blocked invoices | — |
| `vendor_evaluation` | Delivery reliability and price history (reporting) | — |

### 8.6 Production & MRP

| Table | Purpose | Alias (search only) |
|---|---|---|
| `bill_of_material`, `bom_line`, `bom_usage` | BOM headers, components, usages (production, engineering, costing) | MAST, STKO, STPO |
| `routing`, `routing_operation`, `routing_usage` | Routings and operations | MAPL, PLPO |
| `work_center`, `work_center_capacity` | Work centres, formulas, capacity parameters (capacity planning itself deferred) | CRHD, KAKO |
| `production_version` | Alternative production versions | MKAL |
| `mrp_area`, `mrp_parameters` | MRP scope and per-material planning parameters | MDLL, MARC |
| `planning_run`, `planning_file_entry` | Planning run header and net-change entries | MDVM, MDVL |
| `planned_order`, `planned_order_component` | MRP output before conversion | PLAF, RESB |
| `mrp_exception` | Exception messages produced by a run | MDTB (concept) |
| `dependent_requirement` | Component demand derived from BOM explosion | RESB (dependent) |
| `production_order`, `production_order_component`, `production_order_operation` | Orders as shop-floor instruction and cost collector | AUFK, AFKO, AFPO, RESB, AFVC |
| `production_confirmation`, `confirmation_activity` | Confirmations with yields, scrap, activity hours | AFRU, AFVV |
| `order_status_history` | Created → released → partially delivered → technically complete → closed | TJ02 (concept) |
| `cost_estimate`, `cost_estimate_item`, `standard_cost` | Simplified standard cost estimate (§13.4) | KEKO, KEPH |
| `order_settlement_rule`, `settlement_document` | Settlement receivers and results | COBRA |
| `variance_record` | Actual vs target per order | — |
| `scrap_reason` | Reason catalogue (structural slot; scrap flow deferred DV-006) | — |

### 8.7 Sales

| Table | Purpose | Alias (search only) |
|---|---|---|
| `inquiry`, `inquiry_line` | Pre-sales enquiries | VBAK (inquiry types) |
| `sales_quotation`, `sales_quotation_line` | Formal quotations with validity | VBAK (quotation types) |
| `sales_order`, `sales_order_line`, `sales_order_schedule_line` | Sales orders | VBAK, VBAP, VBEP |
| `sales_document_status` | Overall and per-item status (open, partially delivered, billed) | VBUK (concept) |
| `delivery`, `delivery_line`, `delivery_picking`, `delivery_packaging` | Outbound deliveries, picking, packing | LIKP, LIPS |
| `billing_document`, `billing_document_line` | Invoices, credit memos, debit memos, cancellations | VBRK, VBRP |
| `sales_document_reason` | Order and rejection reasons | TVAG |
| `returns_order`, `returns_delivery`, `returns_reason` | Returns handling | VBAK (returns type) |
| `customer_payment`, `payment_allocation` | Incoming payments and their allocation to invoices | — |
| `dunning_run`, `dunning_item`, `dunning_level` | Dunning programme and level configuration | F150, T047 |
| `availability_check_log` | Result of each availability check for auditability | — |
| `condition_type`, `access_sequence`, `pricing_procedure`, `pricing_procedure_step`, `condition_record`, `condition_scale` | Pricing engine configuration and data (E8) | V/06, V/07, V/08, KONV, KONP |
| `condition_document`, `condition_document_line` | The priced conditions actually used on a document | KONV |

### 8.8 Finance

| Table | Purpose | Alias (search only) |
|---|---|---|
| `journal_entry`, `journal_entry_line` | Universal journal: all accounting documents with all their lines | BKPF, BSEG / ACDOCA |
| `gl_account_balance` | Period balances per account, with drill-through to line items | FAGLFLEXT (concept) |
| `open_item`, `cleared_item`, `clearing_document` | Subledger and GL open item management and clearing | BSIK, BSIH, BSAK |
| `vendor_line_item`, `customer_line_item` | Subledger line items | BSEG (vendor/customer) |
| `vendor_company_code`, `customer_company_code` | Subledger company-code segments (reconciliation account, payment terms) | LFB1, KNB1 |
| `customer_sales_area` | Sales-area subledger data | KNVV |
| `business_partner`, `bp_role`, `bp_bank_detail`, `bp_contact` | Unified partner model with roles; one partner can be vendor and customer | BUT000, LFA1, KNA1 |
| `payment_run`, `payment_proposal_item`, `payment_item`, `payment_medium` | Payment engine (E12) | F110, REGUH, REGUP |
| `bank_statement`, `bank_statement_line`, `bank_reconciliation` | Statement import and automatic clearing | FF.5, FEBAN |
| `asset_master`, `asset_depreciation_area`, `depreciation_run`, `asset_transaction` | Fixed assets | ANLA, ANLB, AFAB |
| `accrual_document`, `accrual_plan` | Accruals and deferrals with reversal | — |
| `fx_valuation_run`, `fx_valuation_item` | Foreign-currency revaluation at period end | FAGL_FC_VAL |
| `period_close_task`, `period_close_status` | Closing cockpit per period, per company code | — |
| `balance_carryforward_run`, `balance_carryforward_log` | Year-end carryforward of balances and open items | FAGLGVTR |
| `intercompany_document`, `intercompany_clearing` | Cross-company-code postings and clearing | — |

### 8.9 Costing

| Table | Purpose | Alias (search only) |
|---|---|---|
| `cost_center_plan`, `cost_center_actual` | Planned and actual line items per cost centre | COSS, COSP |
| `internal_order`, `internal_order_line` | Internal orders as cost collectors | AUFK, COEP |
| `assessment_cycle`, `distribution_cycle`, `allocation_result` | Period allocation (assessment / distribution) | KSU1, KSV1 |
| `activity_price_result` | Periodic activity price calculation and revaluation | KSPI |
| `profit_center_line_item` | Profit centre postings for profitability reporting | GLPCT (concept) |
| `budget_document`, `budget_line` | Budgets and their availability control | BPGE |
| `costing_run`, `costing_run_item` | Product costing runs (simplified; cost component split deferred) | CK40N |

### 8.10 People

| Table | Purpose | Alias (search only) |
|---|---|---|
| `employee`, `employee_record` | Employee master with date-delineated records (a change is a new dated record, not an overwrite) | PA0000 series (concept) |
| `record_type`, `record_field`, `record_field_value` | Configurable record types replacing fixed numbering (DV-012) | Infotype definition |
| `org_unit`, `position`, `job`, `org_hierarchy` | Organisational structure | PA0001, PA1000 |
| `position_assignment` | Position → cost centre → employee assignment | PA0001 |
| `pay_component`, `pay_component_config` | Pay structure and its GL/cost mapping | Wage types (concept) |
| `payroll_run`, `payroll_result`, `payroll_result_line` | Payroll results, imported or calculated by configured rules | RT (concept) |
| `deduction_rule`, `deduction_rule_condition` | Configurable deduction logic (§15.3) | — |
| `payroll_posting_run`, `payroll_posting_line` | Posting payroll to GL and cost centres | — |
| `eos_provision_run`, `eos_provision_line` | End-of-service benefit accrual posting | — |
| `time_recording`, `absence`, `attendance`, `leave_quota` | Time data | PA2001, PA2002, PA2006 |

### 8.11 Audit

| Table | Purpose |
|---|---|
| `audit_finding` | Auditor findings raised against a period or document with status and response |
| `tie_out_definition`, `tie_out_result` | Reconciliations run and their results (GL ↔ subledger, stock ↔ GL, GR/IR ↔ open items) |
| `number_range_integrity_run`, `number_range_integrity_result` | Gap analysis per range and period |
| `sod_rule`, `sod_violation` | Segregation-of-duties rules and detected conflicts |
| `evidence_export`, `evidence_export_item` | Generated evidence packs with hash manifest |
| `auditor_access_grant` | Time-boxed read-only auditor access with scope |

---

## §9 · Master data model `DRAFT`

Master data screens follow the reference system's **view / tab structure** because that structure is
what experienced users navigate by (R-03). Each view is a tab with its own fields, and views can be
created and maintained independently by different departments.

### 9.1 Material master views

| View | Order | Key content |
|---|---|---|
| Basic data | 1 | Description, unit of measure, material type, material group, industry sector, gross/net weight, EAN |
| Purchasing | 2 | Purchasing group, order unit, over/underdelivery tolerance, purchasing info record link, manufacturer part number (structural) |
| MRP | 3 | MRP type, MRP controller, lot size, reorder point, safety stock, planned delivery time, in-house production time, scheduling margin |
| Forecasting | 4 | Historical consumption, forecast parameters (structural; forecast consumption deferred DV-007) |
| Production | 5 | Production scheduling profile, backflush flag, tolerance limits, in-house production time, issue storage location |
| Sales | 6 | Sales org data, item category group, delivering plant, tax classification, material statistics group |
| Sales general / plant | 7 | Units of measure conversions, sales text, negative stock allowed |
| Accounting / Costing | 8 | Valuation class, price control (standard / moving average), standard price, moving average price, current stock value |
| Storage | 9 | Storage conditions, temperature, container requirements, shelf life |
| Quality | 10 | Inspection setup (structural; no QM module) |
| Warehouse | 11 | Storage bin and strategy (structural; no WM module) |

Statuses per view: **Incomplete** → **Created** → **Maintained** → **Blocked for use**. Incomplete
materials can be saved, allowing staged data entry across departments, exactly as users expect.

### 9.2 Business partner model

One partner record with roles, rather than separate vendor and customer master records. Roles
carry the segment data.

| Role | Segment data | Key fields |
|---|---|---|
| Vendor (general) | `business_partner` + general company data | Name, addresses, tax numbers, partner-wide bank details and contact persons (D-059) |
| Vendor (company code) | `vendor_company_code` | Reconciliation account, payment terms, payment methods, dunning procedure, cash discount, tolerance group |
| Vendor (purchasing org) | `vendor_purchasing_org` | Order currency, incoterms, purchasing group, partner functions |
| Customer (general) | `business_partner` | Name, addresses, tax numbers, payment behaviour; shared partner-wide bank/contact records where present (D-059) |
| Customer (company code) | `customer_company_code` | Reconciliation account, payment terms, dunning procedure, interest indicator, tolerance group |
| Customer (sales area) | `customer_sales_area` | Sales district, delivering plant, pricing procedure, complete delivery flag, order combination |

**Partner bank/contact v1 (D-059):** bank details are multiple partner-wide records shared if a partner
has both Supplier and Customer roles. Capture account holder, bank country, bank name/code, IBAN or
local account number, BIC/SWIFT, validity dates and active state; do not add company/role assignments,
a default-payment choice, payment-method permissions, house-bank eligibility or payment execution in
this slice. Full account identifiers must be encrypted at rest, masked in normal views and change
history, and revealable only through a separate audited authority; generic history must never contain
plaintext identifiers. D-060 defines the fail-closed country-profile rules, strict IBAN/BIC checks, and
validity semantics; a missing bank-country profile rejects saving. Initial profile work covers IN, KW,
GB, US and JP (D-061); source-backed rules for all five are recorded in D-062 through D-066, and pure
validators plus a fail-closed dispatcher now exist (§§26.80–26.82, 26.88). None is activated in a bank
save path; countries outside that set remain blocked. B-072 adds a ciphertext-only, tenant-RLS table, but
the app role is read-only and no records can yet be written. B-076 adds a display-only metadata tab whose list
view uses the fixed D-074 mask; this does not read/decrypt ciphertext. Normal-detail suffix handling remains
unintegrated. Operational key rotation/re-encryption and verified retirement, full ordinary-view masking, and
audited terminal-reveal integration remain prerequisites to storing full identifiers.

Contacts are multiple partner-wide named persons; current general email/phone remain organisation-level
values. Each person has name, title/function, email, phone, validity dates and active state, with at most
one primary per partner. Log contact-data access/changes, mask personal email/phone in history, and
end-date/inactivate records; hard deletion requires the approved retention/privacy workflow.

This mirrors the reference system's partner structure and is essential for the intercompany and
one-partner-many-roles cases (R-15).

### 9.3 Master data screens

| Screen | Purpose |
|---|---|
| Material create / change / display | View tabs, status per view, copy-from-material, mass maintenance |
| BOM create / change / display | Single-level and multi-level explosion, usage types, alternative BOMs |
| Routing create / change / display | Operations, work centres, times, sequence, reference operation sets |
| Work centre create / change | Formulas, capacity, cost centre assignment, activity types |
| Business partner create / change | Role selection then role-specific segment screens |
| GL account create / change | Chart-level then company-code-level; account groups; field status |
| Cost centre create / change | Hierarchy assignment, responsible person, activity types, budget |
| Activity type / rate | Rates per cost centre per period with version |
| Condition record maintenance | Pricing records per condition type with scales and validity |
| Bank master / house bank account | Banks, accounts, payment methods permitted |
| Employee create / change | Date-delineated records (§15) |
| Number range maintenance | Ranges per object, type, year, with current state |
| Release strategy configuration | Value thresholds, release codes, prerequisites, workflow |

---

## §10 · Module scope & transaction inventory `DRAFT`

Tier 1 = built and working. Tier 2 = configuration, built and working. Tier 3 = registry entry only,
built on demand.

### 10.1 Foundation & platform (Tier 2)

`CFG.PLT.CLIENT.DEFINE` · `CFG.PLT.USER.CREATE` · `CFG.PLT.ROLE.DEFINE` · `CFG.PLT.AUTH.ASSIGN` ·
`CFG.PLT.NUMBERRANGE.DEFINE` · `CFG.PLT.MESSAGE.DISPLAY` · `CFG.ORG.COMPANYCODE.DEFINE` ·
`CFG.ORG.COMPANYCODE.ASSIGN_COA` · `CFG.ORG.PLANT.DEFINE` · `CFG.ORG.PLANT.ASSIGN_COMPANY` ·
`CFG.ORG.STORAGELOC.DEFINE` · `CFG.ORG.PURORG.DEFINE` · `CFG.ORG.PURORG.ASSIGN_COMPANY` ·
`CFG.ORG.PURORG.ASSIGN_PLANT` · `CFG.ORG.SALESORG.DEFINE` · `CFG.ORG.SALESORG.ASSIGN_COMPANY` ·
`CFG.ORG.DISTCHANNEL.DEFINE` · `CFG.ORG.DIVISION.DEFINE` · `CFG.ORG.SALESAREA.DEFINE` ·
`CFG.COST.CONTROLLINGAREA.DEFINE` · `CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY` ·
`CFG.FIN.COA.DEFINE` · `CFG.FIN.COA.COPY` · `CFG.FIN.GLACCOUNT.CREATE` · `CFG.FIN.COA.ASSIGN` ·
`CFG.FIN.FYV.DEFINE` · `CFG.FIN.FYV.ASSIGN` · `CFG.FIN.PPV.DEFINE` · `CFG.FIN.PPV.ASSIGN` ·
`CFG.FIN.CURRENCY.DEFINE` · `CFG.FIN.EXRATE.MAINTAIN` · `CFG.FIN.TAXCODE.DEFINE` ·
`CFG.FIN.PAYTERMS.DEFINE` · `CFG.FIN.PAYMENTMETHOD.DEFINE` · `CFG.FIN.HOUSEBANK.DEFINE` ·
`CFG.FIN.DOCTYPE.DEFINE` · `CFG.FIN.TOLERANCE.DEFINE` · `CFG.FIN.ACCTDET.DEFINE` ·
`CFG.PROC.PURGROUP.DEFINE` · `CFG.PROC.RELEASE.DEFINE` · `CFG.PROC.INFO.RECORD` ·
`CFG.PROC.SOURCELIST.MAINTAIN` · `CFG.INV.MOVETYPE.CONFIG` · `CFG.INV.MATERIALTYPE.DEFINE` ·
`CFG.PROD.WORKCENTER.DEFINE` · `CFG.PROD.ACTIVITYTYPE.DEFINE` · `CFG.PROD.ACTIVITYRATE.CONFIRM` ·
`CFG.PROD.MRPCONTROLLER.DEFINE` · `CFG.PROD.LOTSIZE.DEFINE` · `CFG.PROD.SCHEDULING.CONFIG` ·
`CFG.SALES.SALESDOCTYPE.DEFINE` · `CFG.SALES.ITEMCATEGORY.DEFINE` · `CFG.SALES.PRICING.DEFINE` ·
`CFG.SALES.CONDITION.MAINTAIN` · `CFG.SALES.ACCOUNTGROUP.DEFINE` · `CFG.SALES.OUTPUT.DEFINE` ·
`CFG.PEOPLE.RECORDTYPE.DEFINE` · `CFG.PEOPLE.PAYCOMPONENT.DEFINE` · `CFG.PEOPLE.DEDUCTION.DEFINE` ·
`CFG.WORKFLOW.RELEASE.STEP` · `CFG.IMPORT.TEMPLATE.DEFINE` · `CFG.FIN.INTERCOMPANY.DEFINE` ·
`CFG.FIN.CREDIT.DEFINE` · `CFG.PLT.MAIL.DEFINE`

### 10.2 Procurement (MM) — Tier 1

| Code | Purpose | Alias |
|---|---|---|
| `PROC.REQ.CREATE` | Purchase requisition create/change/display | ME51N / ME52N / ME53N |
| `PROC.REQ.RELEASE` | Requisition approval | ME54N |
| `PROC.REQ.LIST` | Requisition worklist, convert to PO | ME5A |
| `PROC.RFQ.CREATE` | RFQ create/change/display | ME41 |
| `PROC.QUOTE.ENTER` | Enter supplier quotation, price comparison | ME47 / ME49 |
| `PROC.PO.CREATE` | Purchase order create/change/display | ME21N / ME22N / ME23N |
| `PROC.PO.RELEASE` | PO approval per release strategy | ME29N |
| `PROC.PO.LIST` | PO worklist by vendor, plant, date, status | ME2M |
| `PROC.PO.DISPLAY_FLOW` | Document flow from a purchase order | ME23N (flow) |
| `PROC.INV.RECORD` | Supplier invoice verification, 2- and 3-way match | MIRO |
| `PROC.INV.RELEASE` | Release blocked invoices | MRBR |
| `PROC.INV.PARK` | Park an invoice without posting | MIR7 |
| `PROC.INV.LIST` | Vendor invoice worklist | MIR6 |
| `PROC.GRIR.ANALYSE` | GR/IR clearing analysis and adjustment | MR11 |
| `PROC.VENDOR.EVALUATION` | Delivery and price performance report | ME61 |
| `PROC.BALANCE.LIST` | Vendor balance and due analysis | FK10N |
| `PROC.STATEMENT.VIEW` | Vendor account statement | FK10N (statement) |
| `PROC.INFO.RECORD.MAINTAIN` | Maintain purchasing info records | ME11 / ME12 |
| `PROC.SOURCELIST.MAINTAIN` | Maintain source lists | ME01 |
| `PROC.QUOTA.MAINTAIN` | Quota arrangements | MEQ1 |
| `PROC.PRICECOMPARE.VIEW` | Compare quotations across vendors | ME49 |

### 10.3 Inventory (MM-IM) — Tier 1

| Code | Purpose | Alias |
|---|---|---|
| `INV.GR.POST` | Goods receipt against PO, order, or without reference | MIGO |
| `INV.GI.POST` | Goods issue: to order, cost centre, delivery | MIGO / MB1A |
| `INV.TRANSFER.POST` | Stock transfer between storage locations and plants | MIGO / MB1B |
| `INV.DISPLAY` | Display material document | MB03 |
| `INV.REVERSE` | Reverse a material document | MBST |
| `INV.STOCK.VIEW` | Stock overview by material, plant, storage location | MMBE |
| `INV.STOCKAGE.ANALYSE` | Stock ageing and slow-moving analysis | — |
| `INV.PHYINV.CREATE` | Physical inventory document create | MI01 |
| `INV.PHYINV.ENTERCOUNT` | Enter count results | MI04 |
| `INV.PHYINV.DIFF` | Post inventory differences | MI07 |
| `INV.RESERVATION.CREATE` | Create reservation for materials | MB21 |
| `INV.BATCH.MAINTAIN` | Batch master maintain | MSC1N |
| `INV.MOVEMENTTYPE.UK` | Display movement type configuration | OMJJ |
| `INV.STOCK.VALUATION` | Material valuation and price change | MR21 / MM03 |
| `INV.STO.CREATE` | Stock transport order create and monitor | ME21N (STO) |
| `INV.MATERIALDOC.LIST` | Material document list by movement, date, plant | MB51 |
| `INV.MATERIALDOC.RECEIVEPRINT` | Print goods receipt note | MB90 |

### 10.4 Production & MRP (PP) — Tier 1

| Code | Purpose | Alias |
|---|---|---|
| `PROD.BOM.CREATE` | BOM create/change/display, single and multi-level | CS01 / CS02 / CS03 |
| `PROD.BOM.EXPLODE` | Multi-level BOM explosion, where-used list | CS11 / CS12 / CS15 |
| `PROD.ROUTING.CREATE` | Routing create/change/display | CA01 / CA02 / CA03 |
| `PROD.WORKCENTER.CREATE` | Work centre create/change | CR01 / CR02 |
| `PROD.MRP.RUN` | MRP planning run, single-item or plant-wide | MD01 / MD02 |
| `PROD.MRP.PLANFILE` | Planning file and net-change entries | MD21 |
| `PROD.MRP.EXCEPTIONS` | Exception monitor for a planning run | MD06 |
| `PROD.MRP.STOCKREQ` | Stock/requirements list per material and plant | MD04 |
| `PROD.MRP.SETTINGS` | MRP parameters per material and plant | MM02 (MRP views) |
| `PROD.PLANNEDORDER.CONVERT` | Convert planned order to production order | MD11 / CO41 |
| `PROD.PLANNEDORDER.MAINTAIN` | Change planned orders, firming | MD11 / MD12 |
| `PROD.ORDER.CREATE` | Production order create/change/display | CO01 / CO02 / CO03 |
| `PROD.ORDER.RELEASE` | Release order, print shop papers | CO02 / CO04 |
| `PROD.ORDER.COMPONENT.LIST` | Missing parts and component availability | CO24 |
| `PROD.ORDER.GI` | Goods issue components to order | MIGO / MB1A 261 |
| `PROD.CONFIRM.ENTER` | Confirmation of operations, hours, yield, scrap | CO11N / CO15 |
| `PROD.ORDER.GR` | Goods receipt of finished or semi-finished product | MIGO 101 |
| `PROD.ORDER.COSTS` | Order cost analysis, actual vs target | CO03 / KOB1 |
| `PROD.ORDER.SETTLE` | Settle order, post variance | KO88 |
| `PROD.ORDER.CLOSE` | Technically complete and close | CO02 / KO88 |
| `PROD.COSTESTIMATE.CREATE` | Simplified standard cost estimate | CK11N |
| `PROD.COSTESTIMATE.RELEASE` | Mark and release standard cost | CK24 |
| `PROD.ORDER.LIST` | Production order worklist | COOIS |
| `PROD.CAPACITY.LOAD` | Rough capacity load display (load only; levelling deferred DV-005) | CM01 |
| `PROD.MRP.AREA.MAINTAIN` | MRP areas | OPPQ / MDLL |

### 10.5 Sales (SD) — Tier 1

| Code | Purpose | Alias |
|---|---|---|
| `SALES.INQUIRY.CREATE` | Customer enquiry create/change/display | VA11 / VA12 / VA13 |
| `SALES.QUOTE.CREATE` | Quotation create/change/display | VA21 / VA22 / VA23 |
| `SALES.ORDER.CREATE` | Sales order create/change/display | VA01 / VA02 / VA03 |
| `SALES.ORDER.RELEASE` | Order approval per release strategy (R-05) | VA02 (release) |
| `SALES.AVAILABILITY.CHECK` | Availability check for material and date | VA03 (ATP) |
| `SALES.ORDER.LIST` | Order worklist by customer, material, status | VA05 |
| `SALES.DELIVERY.CREATE` | Outbound delivery create, single or collective | VL01N / VL10 |
| `SALES.DELIVERY.PICK` | Picking confirmation, quantity and batch | VL02N (picking) |
| `SALES.DELIVERY.PACK` | Packing and handling units (basic) | VL02N (packing) |
| `SALES.GI.POST` | Post goods issue from delivery | VL02N |
| `SALES.BILLING.CREATE` | Create invoice, credit memo, debit memo | VF01 |
| `SALES.BILLING.LIST` | Billing due list and worklists | VF04 |
| `SALES.BILLING.CANCEL` | Cancel a billing document (reversal) | VF11 |
| `SALES.RETURNS.CREATE` | Returns order and returns delivery | VA01 (returns) / VL01N |
| `SALES.CREDITMEMO.CREATE` | Credit memo for returns | VF01 (credit memo) |
| `SALES.DUNNING.RUN` | Dunning proposal and printing | F150 (SD side) |
| `SALES.PAYMENT.ENTER` | Incoming payment entry and allocation | F-28 |
| `SALES.CUSTOMER.BALANCE` | Customer balance and due items | FD10N |
| `SALES.STATEMENT.VIEW` | Customer account statement | FD10N (statement) |
| `SALES.PRICING.ANALYSE` | Condition analysis on a sales document | VA03 (conditions) |
| `SALES.BLOCKED.ORDERS` | Credit or delivery blocked orders worklist | V.23 / VKM3 |
| `SALES.OUTPUT.PRINT` | Print order confirmation, delivery note, invoice | VF31 / VL71 |
| `SALES.ORDER.FLOW` | Document flow from order to billing and payment | VA03 (flow) |
| `SALES.INCOMPLETION.CHECK` | Incompletion log and fixes | V.02 |

### 10.6 Finance (FI) — Tier 1

| Code | Purpose | Alias |
|---|---|---|
| `FIN.JOURNAL.POST` | Post a general journal entry | FB50 |
| `FIN.JOURNAL.PARK` | Park a journal entry | FV50 |
| `FIN.JOURNAL.REVERSE` | Reverse any accounting document | FB08 |
| `FIN.JOURNAL.DISPLAY` | Display accounting document | FB03 |
| `FIN.JOURNAL.LIST` | Line item report with drill-through | FAGLL03 |
| `FIN.GL.BALANCE` | Account balances by period | FS10N |
| `FIN.GL.MASTER.CREATE` | GL account create/change/display | FS00 |
| `FIN.GL.MASTER.LIST` | Chart of accounts listing | FSP0 |
| `FIN.AP.INVOICE.POST` | Vendor invoice posting (direct, non-PO) | FB60 |
| `FIN.AP.CREDITMEMO.POST` | Vendor credit memo | FB65 |
| `FIN.AP.PAYMENT.POST` | Manual vendor payment | F-53 |
| `FIN.AP.PAYMENTRUN.EXECUTE` | Automatic payment run, proposal to execute | F110 |
| `FIN.AP.CLEAR` | Clear vendor open items | F-44 |
| `FIN.AP.BALANCE` | Vendor balances and due items | FK10N |
| `FIN.AP.AGEING` | Vendor ageing analysis | S_ALR_87012085 |
| `FIN.AR.INVOICE.POST` | Customer invoice posting (direct) | FB70 |
| `FIN.AR.PAYMENT.ENTER` | Incoming payment and clearing | F-28 |
| `FIN.AR.CLEAR` | Clear customer open items | F-32 |
| `FIN.AR.BALANCE` | Customer balances and due items | FD10N |
| `FIN.AR.AGEING` | Customer ageing analysis | S_ALR_87012178 |
| `FIN.AR.DUNNING.RUN` | Dunning programme | F150 |
| `FIN.BANK.STATEMENT.IMPORT` | Import bank statement | FF.5 |
| `FIN.BANK.STATEMENT.POST` | Post and reconcile statement lines | FEBAN |
| `FIN.BANK.AUTOCLEAR` | Automatic clearing rules and run | F.13 |
| `FIN.ASSET.CREATE` | Asset master create/change | AS01 / AS02 |
| `FIN.ASSET.ACQUIRE` | Asset acquisition posting | ABZON / F-90 |
| `FIN.ASSET.RETIRE` | Asset retirement | ABAVN |
| `FIN.ASSET.DEPRECIATE` | Depreciation run | AFAB |
| `FIN.ASSET.REPORT` | Asset history sheet (basic) | S_ALR_87011990 |
| `FIN.TAX.POST` | Tax posting and tax code handling | FB50 |
| `FIN.TAX.REPORT` | Tax return basis listing | — |
| `FIN.FX.VALUATE` | Foreign-currency revaluation run | FAGL_FC_VAL |
| `FIN.GRIR.RECLASS` | GR/IR reclassification at period end | F.19 |
| `FIN.ACCRUAL.POST` | Accrual and deferral postings | FBS1 |
| `FIN.CLOSE.PERIOD` | Open and close posting periods | OB52 |
| `FIN.CLOSE.COCKPIT` | Period-end close task list and status | — |
| `FIN.CLOSE.CARRYFORWARD` | Balance and open item carryforward | FAGLGVTR |
| `FIN.RPT.TRIALBALANCE` | Trial balance | F.01 |
| `FIN.RPT.BALANCESHEET` | Balance sheet with comparatives | — |
| `FIN.RPT.PROFITLOSS` | Profit and loss statement | — |
| `FIN.RPT.CASHFLOW` | Cash flow statement (indirect, basic) | — |
| `FIN.RPT.COSTCENTER.ACTUAL` | Cost centre actual vs plan | KS13 |
| `FIN.RPT.PROFITCENTER` | Profit centre reporting | KE5Z |
| `FIN.RPT.SUBLEDGER.TIE` | GL to subledger tie-out report | — |
| `FIN.CONFIG.ACCTDET.VIEW` | Display account determination | OBYC |
| `FIN.DOC.FLOW` | Accounting document flow and source document | FB03 (flow) |
| `FIN.IC.POST` | Intercompany posting with automatic mirror document (D-028) | — |
| `FIN.IC.CLEAR` | Clear an intercompany balance against its mirror | — |
| `FIN.RPT.CONSOLIDATE` | Consolidation with intercompany elimination entries | — |
| `FIN.CREDIT.MAINTAIN` | Credit master, limit and risk category per customer (D-029) | FD32 |
| `FIN.CREDIT.MONITOR` | Credit exposure, limit utilisation and blocked documents | F.31 |
| `FIN.CREDIT.RELEASE` | Release credit-blocked orders and deliveries, with reason | VKM3 |
| `FIN.RPT.CONSOLIDATE.STMT` | Consolidated balance sheet and profit and loss | — |

### 10.7 Costing (CO) — Tier 1

| Code | Purpose | Alias |
|---|---|---|
| `COST.CENTER.CREATE` | Cost centre create/change/display | KS01 / KS02 / KS03 |
| `COST.CENTER.HIERARCHY` | Standard hierarchy maintenance | OKKP |
| `COST.CENTER.PLAN` | Cost centre planning | KP06 |
| `COST.ACTIVITYTYPE.CREATE` | Activity type create/change | KL01 / KL02 |
| `COST.ACTIVITYRATE.CONFIRM` | Confirm activity prices per period | KP26 |
| `COST.ACTIVITY.RESULT` | Activity price calculation and revaluation | KSPI |
| `COST.ALLOCATION.ASSESS` | Assessment cycle run | KSU5 |
| `COST.ALLOCATION.DISTRIBUTE` | Distribution cycle run | KSV5 |
| `COST.INTERNALORDER.CREATE` | Internal order create/change/display | KO01 / KO02 / KO03 |
| `COST.INTERNALORDER.BUDGET` | Internal order budget and availability | KO22 |
| `COST.INTERNALORDER.SETTLE` | Internal order settlement | KO88 |
| `COST.PROFITCENTER.CREATE` | Profit centre create/change | KE51 / KE52 |
| `COST.PROFITCENTER.REPORT` | Profit centre reporting | KE5Z |
| `COST.COSTCENTER.REPORT` | Cost centre report actual vs plan vs budget | KS13 |
| `COST.ORDER.COSTANALYSE` | Order cost analysis | KOB1 |
| `COST.BUDGET.MAINTAIN` | Budget entry and availability control | KO22 / KSB1 |
| `COST.RPT.COSTCENTER.ANALYSE` | Cost centre analysis with drill-through | KS13 |

### 10.8 People — Tier 1

| Code | Purpose | Alias |
|---|---|---|
| `PEOPLE.EMPLOYEE.CREATE` | Employee create/change/display with dated records | PA30 / PA40 |
| `PEOPLE.RECORD.MAINTAIN` | Maintain a dated record type | PA30 |
| `PEOPLE.ORGUNIT.CREATE` | Organisational unit maintain | PPOCE |
| `PEOPLE.POSITION.CREATE` | Position maintain | PPOME |
| `PEOPLE.ASSIGNMENT.MAINTAIN` | Position/employee/cost centre assignment | PA30 |
| `PEOPLE.TIME.ENTER` | Absence and attendance entry | PA30 / CAT2 |
| `PEOPLE.LEAVE.VIEW` | Leave quota and balance | PT50 |
| `PEOPLE.PAYROLLRUN.EXECUTE` | Payroll run (configured rules) or result import | PC00_M99_CALC |
| `PEOPLE.PAYROLL.RESULT` | Payroll result review | PC00_M99_DISPLAY |
| `PEOPLE.PAYROLL.POST` | Post payroll to GL and cost centres | PC00_M99_CIPE |
| `PEOPLE.PAYROLL.IMPORT` | Import external payroll results | — |
| `PEOPLE.EOS.PROVISION` | End-of-service benefit accrual posting | — |
| `PEOPLE.SALARY.PAYMENT` | Salary payment run (via payment engine) | F110 |
| `PEOPLE.RPT.HEADCOUNT` | Headcount and personnel cost reporting | S_AHR_61015507 |
| `PEOPLE.RPT.COSTBYCC` | Personnel costs by cost centre | — |

### 10.9 Audit — Tier 1

| Code | Purpose | Alias |
|---|---|---|
| `AUDIT.WORKSPACE` | Auditor home: scope, period, findings, evidence | — |
| `AUDIT.TRAIL.VIEW` | Change document and document trail query | — |
| `AUDIT.TRAIL.DISPLAY` | Field-level before/after for one object | S_ALR_87012050 |
| `AUDIT.DRILLDOWN` | Drill from financial statement to source document | — |
| `AUDIT.TIEOUT.RUN` | Run tie-out reconciliations | — |
| `AUDIT.NUMBERRANGE.CHECK` | Number range gap and integrity report | — |
| `AUDIT.PERIOD.EVIDENCE` | Period close evidence pack | — |
| `AUDIT.ACCESS.REVIEW` | Who has access to what | — |
| `AUDIT.SOD.ANALYSE` | Segregation-of-duties conflict analysis | — |
| `AUDIT.FINDING.RAISE` | Raise and track an auditor finding | — |
| `AUDIT.EVIDENCE.EXPORT` | Generate a hash-manifested evidence pack | — |
| `AUDIT.ACCESS.GRANT` | Time-boxed read-only auditor access | — |

### 10.10 Reports & lists (Tier 1, cross-module)

`FND.RPT.CONFIG.CHECKLIST` · `FND.RPT.MASTER.DATA` · `PROC.RPT.SPEND` · `PROC.RPT.OPENPO` ·
`INV.RPT.STOCKVALUE` · `INV.RPT.MOVEMENTS` · `PROD.RPT.ORDERSTATUS` · `PROD.RPT.WIP` ·
`SALES.RPT.BACKLOG` · `SALES.RPT.REVENUE` · `FIN.RPT.TRIALBALANCE` · `FIN.RPT.BALANCESHEET` ·
`FIN.RPT.PROFITLOSS` · `AUDIT.RPT.EVIDENCE`

### 10.11 Tier 3 examples (registry-only until requested)

Physical inventory sampling, LIFO/FIFO valuation layers, transfer pricing, material ledger
(actual costing), joint venture accounting, treasury and cash management, credit management with
external agencies (basic credit checks are in scope), profitability analysis by segment with
CO-PA characteristics derivation, long-term planning and simulation versions, Kanban and
repetitive manufacturing, process manufacturing, warehouse management with bins and strategies,
variant configuration, batch determination strategies, quality management, maintenance, project
system, investment management, travelling expenses, recruitment, training and event management,
personnel development, capacity requirements planning with finite scheduling, EDI/IDoc interfaces,
foreign trade and customs, real estate, industry solutions, and country-specific legal reporting.
Each has a registry entry explaining what it does, why it is deferred, and what would be required
to build it.

---

## §11 · Golden flows with accounting entries `DRAFT`

The three flows in R-10. Postings are representative of the standard configuration package with a
finished good on standard price control. All amounts are illustrative.

### 11.1 P2P — Procure to Pay

| # | Step | Transaction | Purchase order history | Accounting document |
|---|---|---|---|---|
| 1 | Demand identified | `PROC.REQ.CREATE` | — | None |
| 2 | Requisition released | `PROC.REQ.RELEASE` | — | None |
| 3 | RFQ sent to vendors | `PROC.RFQ.CREATE` | — | None |
| 4 | Quotations entered, compared | `PROC.QUOTE.ENTER` | — | None |
| 5 | Purchase order created | `PROC.PO.CREATE` | Ordered qty and value | None (budget commitment in CO) |
| 6 | PO released per strategy | `PROC.PO.RELEASE` | — | None |
| 7 | Goods received | `INV.GR.POST` | Delivered qty and value | **Dr** Inventory (raw material stock) · **Cr** GR/IR clearing. Price difference against standard price → **Dr/Cr** Price difference |
| 8 | Vendor invoice received | `PROC.INV.RECORD` | Invoiced qty and value | **Dr** GR/IR clearing · **Dr** Input tax · **Cr** Vendor (reconciliation). Price or quantity variance beyond tolerance blocks the item |
| 9 | Invoice released | `PROC.INV.RELEASE` | — | None |
| 10 | Payment run proposal | `FIN.AP.PAYMENTRUN.EXECUTE` | — | None (proposal is reviewable and reversible) |
| 11 | Payment executed | same | — | **Dr** Vendor · **Cr** Bank. Cash discount taken if within terms → **Cr** Cash discount received |
| 12 | GR/IR residual analysis | `PROC.GRIR.ANALYSE` | — | Clearing adjustment for GR without invoice or invoice without GR |
| 13 | Period-end GR/IR reclass | `FIN.GRIR.RECLASS` | — | **Dr/Cr** GR/IR clearing → accrued liability or goods received not invoiced |

### 11.2 O2C — Order to Cash

| # | Step | Transaction | Status effect | Accounting document |
|---|---|---|---|---|
| 1 | Customer enquiry | `SALES.INQUIRY.CREATE` | — | None |
| 2 | Quotation issued | `SALES.QUOTE.CREATE` | Validity tracked | None |
| 3 | Sales order created | `SALES.ORDER.CREATE` | Order open, availability check run | None (revenue recognition deferred to billing) |
| 4 | Order released (if strategy applies) | `SALES.ORDER.RELEASE` | Released for delivery | None |
| 5 | Delivery created | `SALES.DELIVERY.CREATE` | Delivery open, stock reserved | None |
| 6 | Picking confirmed | `SALES.DELIVERY.PICK` | Picked | None |
| 7 | Goods issue posted | `SALES.GI.POST` | Delivery complete, stock reduced | **Dr** Cost of goods sold · **Cr** Finished goods inventory (at standard cost) |
| 8 | Billing document created | `SALES.BILLING.CREATE` | Billing complete | **Dr** Customer (reconciliation) · **Cr** Revenue · **Cr** Output tax. Revenue reductions from pricing conditions post to their own accounts |
| 9 | Customer invoice printed / sent | `SALES.OUTPUT.PRINT` | Output logged | None |
| 10 | Incoming payment entered | `SALES.PAYMENT.ENTER` | Invoice cleared | **Dr** Bank · **Cr** Customer. Cash discount → **Dr** Cash discount allowed |
| 11 | Open items cleared | automatic or `FIN.AR.CLEAR` | Item cleared | Clearing document links payment and invoice |
| 12 | Overdue follow-up | `FIN.AR.DUNNING.RUN` | Dunning level advanced | Dunning charges and interest if configured |
| 13 | Statement issued | `SALES.STATEMENT.VIEW` | — | None |

### 11.3 R2R — Record to Report

| # | Step | Transaction | Effect |
|---|---|---|---|
| 1 | Daily postings | all modules | Documents accumulate; balances update continuously |
| 2 | GR/IR reclassification | `FIN.GRIR.RECLASS` | Deliveries not yet invoiced to accrued liability; invoices not yet delivered to prepayment |
| 3 | Inventory revaluation differences | `INV.STOCK.VALUATION` | Price changes for moving-average materials |
| 4 | Production order settlement | `PROD.ORDER.SETTLE` | Variances posted to GL; WIP where applicable (deferred DV-003) |
| 5 | Cost centre allocation | `COST.ALLOCATION.ASSESS` / `.DISTRIBUTE` | Overheads moved to receiving cost objects |
| 6 | Activity price calculation | `COST.ACTIVITY.RESULT` | Under/over absorption settled |
| 7 | Depreciation run | `FIN.ASSET.DEPRECIATE` | **Dr** Depreciation expense (by cost centre) · **Cr** Accumulated depreciation |
| 8 | Accruals and deferrals | `FIN.ACCRUAL.POST` | **Dr** Expense · **Cr** Accrual liability, with automatic reversal in the next period |
| 9 | Payroll posting | `PEOPLE.PAYROLL.POST` | **Dr** Salary and personnel cost by cost centre · **Cr** Payables, deductions, provisions |
| 10 | FX revaluation | `FIN.FX.VALUATE` | Unrealised gains and losses on open foreign-currency items; reversal on the first day of the next period |
| 11 | Subledger tie-out | `AUDIT.TIEOUT.RUN` | AP and AR control accounts reconciled to vendor and customer balances; stock reconciled to GL |
| 12 | Close periods | `FIN.CLOSE.PERIOD` | Posting locked per account type |
| 13 | Trial balance | `FIN.RPT.TRIALBALANCE` | Debits equal credits, verified structurally |
| 14 | Statements | `FIN.RPT.BALANCESHEET` / `.PROFITLOSS` | Comparatives from prior periods and prior year |
| 15 | Carryforward | `FIN.CLOSE.CARRYFORWARD` | Balance sheet balances and open items carried to the new year |
| 16 | Evidence pack | `AUDIT.EVIDENCE.EXPORT` | Export for external verification |

### 11.4 Document flow example

```
Purchase requisition 10000001
  └─ Purchase order 4500000123        (created from requisition)
       ├─ Goods receipt 4900000456     (delivered qty 100, value 6,000)
       ├─ Vendor invoice 5100000789    (invoiced 100, value 6,120)
       └─ Vendor payment 2000000345    (cleared 6,120, discount 61.20)

Sales order 0000001234
  └─ Production order 1000045          (make-to-stock supply, MRP-generated)
       ├─ Component goods issue 4900000501
       ├─ Confirmations 1000045-01..03
       ├─ Finished goods receipt 4900000520
       └─ Settlement 3000001
  └─ Delivery 0080001234
       └─ Goods issue 4900000600        (COGS 5,000)
  └─ Invoice 90000123                   (revenue 8,000, tax 400)
       └─ Incoming payment 1500000456  (cleared 8,400)
```

Every node is clickable and drills to the source document — this is the backbone of both daily work
and the audit workspace (§16).

---

## §12 · MRP design `DRAFT`

Option C confirmed: the full planning run is in Milestone 1 (R-17, D-011).

### 12.1 Scope of the planning run

| Element | In M1 | Notes |
|---|---|---|
| Planning file and net-change run | Yes | Only materials with changed relevant fields are planned |
| Regenerative (plant-wide) run | Yes | Full replan of all materials in scope |
| Net requirements calculation | Yes | Requirements minus available stock and firm receipts |
| Safety stock and reorder point | Yes | Both planning approaches |
| Lot sizing | Yes | Lot-for-lot, fixed lot, period lot (weekly/monthly), reorder point |
| Lead-time offsetting | Yes | Planned delivery time, in-house production time, goods receipt processing time |
| BOM explosion, single and multi-level | Yes | Dependent requirements generated for components |
| Low-level code | Yes | Correct sequencing of multi-level explosion |
| Scheduling | Yes | Backward and forward scheduling with basic floats |
| Exception messages | Yes | Our own exception codes; reference numbers registered as aliases |
| Output: planned orders | Yes | Internal production |
| Output: purchase requisitions | Yes | Externally procured components, subject to release strategy |
| Conversion: planned order → production order | Yes | Single and collective |
| Pegging (demand ↔ supply links) | Yes | Feeds document flow and the stock/requirements list |
| Firming and manual planning | Yes | Planner can firm or override the system proposal |
| Forecast consumption, planning strategies beyond make-to-stock | Deferred (DV-007) | Field reserved |
| Capacity requirements planning and levelling | Deferred (DV-005) | Work centre load display only |
| Multi-plant planning runs and MRP areas | Partial | MRP areas maintained; plant-level run is the M1 path |

### 12.2 Run sequence

```
1  Read planning file entries (or all materials in scope for a regenerative run)
2  Determine low-level codes for the material population
3  For each material in low-level-code sequence:
     a  Gather requirements: sales orders, reservations, dependent requirements,
        safety stock, forecast (deferred), manual reservations
     b  Gather receipts: stock on hand, open purchase orders, open production orders,
        open planned orders (unless not firmed), in-transit transfers
     c  Net = requirements − receipts  (per date bucket)
     d  If net > 0 → lot-size it
     e  Schedule: backward from requirement date using lead times (or forward if past due)
     f  Create planned order  OR  purchase requisition (per procurement type)
     g  Explode BOM one level → dependent requirements for components
     h  Evaluate exceptions → write exception messages
     i  Update pegging links
4  Write results, planning run log, and statistics
5  Queue post-processing: availability recalculation, MRP list, exception summary
```

Run modes: **online single item** (planner, immediate feedback), **background plant-wide**
(worker job, §21), **net-change**, **regenerative**. Every run stores its inputs and results so the
planner can compare a run against the previous one.

### 12.3 Planner screens (the real test of familiarity)

| Screen | Purpose | Alias |
|---|---|---|
| Stock / requirements list | The planner's home. Receipts and requirements in one date-ordered list with running balance, exception column, firming, and drill-through to every document | MD04 |
| MRP list | Frozen snapshot of the last run for a material, for comparison | MD05 |
| Planning run log | What the last run did, with statistics and messages | MD01 (log) |
| Exception monitor | All materials with exceptions for a plant, grouped by exception code | MD06 |
| Missing parts list | Components that cannot cover a production order | CO24 |
| Planning file | Net-change entries and their status | MD21 |
| Collective conversion | Convert planned orders to production orders in bulk | CO41 |

### 12.4 Exception codes (our own)

| Our code | Meaning | Reference alias |
|---|---|---|
| `EXC.NEW_ORDER` | New order proposal created | 01 |
| `EXC.BRING_FORWARD` | Reschedule receipt earlier | 10 |
| `EXC.POSTPONE` | Reschedule receipt later | 15 |
| `EXC.CANCEL` | Proposal no longer required | 20 |
| `EXC.SHORTAGE` | Material shortage on requirement date | 96 |
| `EXC.EXCESS` | Excess stock | 30 |
| `EXC.LEADTIME` | Lead time cannot be met | 25 |
| `EXC.NO_SOURCE` | No valid source of supply | 05 |

Reference numbers are registered as searchable aliases only; our codes are the product's own (R-01).

### 12.5 Data produced by a run

`planning_run` (header, mode, scope, statistics) → `planning_file_entry` (net-change log) →
`planned_order` + `planned_order_component` (output) → `dependent_requirement` (component demand) →
`mrp_exception` (messages) → `document_flow_link` (pegging). All are visible to the auditor.

---

## §13 · Production order costing `DRAFT`

D-012: structure exact, depth deferred. C is chosen so a native user finds what they expect; the
deferred items are registered as DV-002, DV-003, DV-004, DV-005, DV-006.

### 13.1 The order as shop-floor instruction and cost collector

| # | Step | Order effect | Accounting |
|---|---|---|---|
| 1 | Create order | Components from BOM, operations from routing, target costs calculated | None (commitment) |
| 2 | Release | Reservations active, order status released | None |
| 3 | Goods issue components | Order debited with material cost | **Dr** Order (material consumption) · **Cr** Component inventory |
| 4 | Activity confirmation | Order debited with activity cost at rate | **Dr** Order (activity cost) · **Cr** Cost centre (activity absorbed) |
| 5 | Overhead application | *Deferred (DV-002)* — structural slot present | — |
| 6 | Goods receipt of finished good | Order credited at standard cost | **Dr** Finished goods inventory · **Cr** Order |
| 7 | Variance at settlement | Actual vs target difference | **Dr/Cr** Order · **Cr/Dr** Variance account |
| 8 | Settlement | Costs cleared from order to receivers | Settlement document with receivers |
| 9 | WIP at period end | *Deferred (DV-003)* — structure present | — |

### 13.2 Worked example (the M1 acceptance case)

Finished good `FG-1000`, standard price 100.00 per unit. Order for 10 units. Standard cost estimate:
components 60.00, activities 2.0 hours at 20.00 per hour = 40.00.

**Standard cost = 100.00**

Actual execution:

| Event | Document | Debit | Credit | Amount |
|---|---|---|---|---|
| Issue 10 × components | Material document | Order | Raw material inventory | 600.00 |
| Confirm 2.4 h × 10 at 20.00 | Confirmation + activity posting | Order | Cost centre (activity) | 480.00 |
| Receive 10 units at standard | Material document | FG inventory | Order | 1,000.00 |
| Settlement | Settlement document | Variance account | Order | 80.00 |

Order balance: 600 + 480 (debits) − 1,000 (credit) = **80.00 debit → unfavourable variance**,
settled to the variance account. The variance is 40.00 price or rate variance (hours over target)
and 40.00 quantity-driven, but not split in M1 (DV-004).

**Cost centre side:** the cost centre absorbed 480.00 of activity while carrying, say, 500.00 of
actual salary and overhead cost → 20.00 under-absorption, visible in the cost centre report and
settled by activity price calculation (`COST.ACTIVITY.RESULT`) at period end. This is precisely why
activity rates and cost centre integration are core, not optional (R-11, D-013).

### 13.3 Standard cost estimate (simplified, M1)

| Input | Source |
|---|---|
| Component quantities × prices | BOM lines × material prices (standard or moving average per price control) |
| Operation hours × rates | Routing operations × activity type rates for the responsible cost centre |
| Cost component split | Deferred; single total stored in M1 |
| Marking and release of a standard cost | Simple: estimate confirmed → standard price updated with validity date, change documented |
| Costing run (mass) | Deferred (Tier 3) — `PROD.COSTESTIMATE.CREATE` handles one material at a time in M1 |

### 13.4 Order statuses

`Created` → `Released` → `Partially confirmed` → `Delivered` → `Technically complete` → `Closed`.
Only a closed order is settled and locked. Status transitions are change-documented and appear in
the auditor's drill-through.

## §14 · Finance & Record-to-Report detail `DRAFT`

### 14.1 Universal journal

One journal entry table with all lines (GL, vendor, customer, asset, cost object), replacing the
reference system's separate GL and subledger document tables. Every line carries the full set of
account assignments:

`client` · `company_code` · `document_number` · `fiscal_year` · `line_number` · `posting_date` ·
`document_date` · `posting_period` · `document_type` · `reference` · `header_text` · `line_text` ·
`gl_account` · `company_code_account` · `debit_credit` · `amount_local` · `amount_document` ·
`amount_group` · `currency_document` · `exchange_rate` · `tax_code` · `tax_amount` ·
`business_partner` · `cost_center` · `profit_center` · `internal_order` · `production_order` ·
`asset` · `material` · `plant` · `quantity` · `unit_of_measure` · `clearing_document` ·
`clearing_date` · `reversal_flag` · `reversal_of` · `origin_document` · `created_by`

**Benefit of unification:** one table answers "show me everything that happened to this cost centre",
"show me the source of this P&L line", and "reconcile GL to subledger" without joining a dozen
tables. It is also what makes drill-through from statement to source document fast.

### 14.2 Subledgers

| Aspect | Design |
|---|---|
| Vendor open items | Every vendor line item carries an automatic reconciliation account posting; control account balance must equal the sum of vendor balances (tie-out, §16.4) |
| Customer open items | Same for customer reconciliation account |
| Clearing | Clearing document references both open items, records discount taken, exchange differences and residue; never deletes either item |
| Down payments | Special GL indicator with alternative reconciliation account (structural, basic support in M1) |
| Credit memos and debit memos | Same document family as invoices with opposite sign; full reversal semantics |

### 14.3 Posting periods and closing

| Control | Design |
|---|---|
| Posting period variant | Open and closed periods per account type (general, vendor, customer, asset, material) |
| Close sequence | Materials → production settlement → subledger → GL → reporting |
| Close cockpit | Task list with owners, statuses, dependencies, and evidence per period |
| Special periods | Available for year-end adjustments without reopening a normal period |
| Reopening | Possible and fully change-documented; never silent |
| Year-end carryforward | Balance sheet account balances and open items carried; P&L accounts reset. Idempotent and re-runnable |

### 14.4 Currency

| Aspect | Design |
|---|---|
| Currencies | Company code local currency, group currency, hard currency; document currency |
| Rate types | Buying, selling, average; maintained per period with change history |
| Conversion at posting | Rate from the posting date, stored on the line so the document is self-contained and re-producible |
| Exchange differences | Realised on clearing, unrealised at period end via revaluation with automatic reversal |

### 14.5 Assets (simplified, DV-013)

Acquisition, retirement, transfer, and depreciation runs with straight-line and declining-balance
methods. Depreciation posts to expense accounts by cost centre, so asset cost reaches product cost
and cost centre reporting. Investment management, insurance, and leasing are Tier 3.

### 14.6 Banking (R-14)

| Capability | Detail |
|---|---|
| Payment run | Selection of due items → proposal (reviewable, changeable, reversible) → execution → payment medium file → reconciliation with bank |
| Payment methods | Bank transfer, cheque, and configurable country methods; method permission per vendor and per bank account |
| Ranking and grouping | Payment by due date, discount period exploitation, grouping rules, payment blocking |
| House banks | Bank master, accounts, permitted payment methods, available balance view |
| Statement import | Configurable format import (standard ISO-ish and delimited templates) |
| Automatic clearing | Rule-based matching of statement lines to open items: amount, reference, date windows; residual items and partial clearing |
| Dunning | Dunning levels, charges, interest, letter output, blocking of further dunning on dispute |

**Payment Methods master v1 (D-058):** tenant-defined country-specific records keyed by country and a
1–2-character uppercase alphanumeric code, with description, allowed direction (`OUTGOING`, `INCOMING`,
or `BOTH`), and active state. No methods are seeded. Company-code country supplies context when later
code-backed Supplier/Customer defaults are integrated. Vendor/customer and house-bank eligibility,
payment-medium formats, and payment execution remain separate slices; this catalogue alone does not
permit or execute a payment.

### 14.7 Intercompany (cross-company-code postings) — D-028

Both company codes in the tenant transact with each other. This is a core SAP capability and is
now in Milestone 1.

| Aspect | Design |
|---|---|
| Triggers | Intercompany sale (A sells to B), intercompany stock transfer, intercompany service, cross-company cost allocation |
| Customer/vendor duality | The partner is a customer in the selling company code and a vendor in the buying one — the reason the business partner model in §9.2 exists |
| Pricing | Intercompany pricing conditions (transfer price markup) held as condition records on the intercompany customer, so the transfer price is configuration, not code |
| Automatic mirror | Posting the intercompany invoice in company A creates the corresponding payable in company B without a second manual entry, with both documents linked in the document flow |
| Reconciliation accounts | Dedicated intercompany reconciliation accounts per company-code pair, separate from normal trade receivables and payables, so IC balances are identifiable at all times |
| Clearing | IC invoice and its mirror document clear through IC clearing accounts |
| Consistency check | `AUDIT.TIEOUT.RUN` asserts the IC balance in A equals the mirror balance in B — a mismatch is a finding |
| Consolidation | A consolidation report eliminates IC receivables against IC payables and IC revenue against IC cost of goods sold, producing group statements from the same data |
| Deferred | Elimination of profit in inventory, equity consolidation, minority interests, currency translation of foreign subsidiaries — Tier 3 |

Worked example — A sells 10 units at a transfer price of 120 to B (B's entity is
company code 2000):

| Company | Debit | Credit | Amount |
|---|---|---|---|
| A (1000) | IC receivable (B) | | 1,200 |
| A (1000) | | Revenue (intercompany) | 1,200 |
| B (2000) | Inventory | | 1,200 |
| B (2000) | | IC payable (A) | 1,200 |

At consolidation the 1,200 receivable and payable are eliminated against each other.

### 14.8 Credit management — D-029

| Aspect | Design |
|---|---|
| Credit control area | Organisational unit above company code and sales area (§6.1). One or more company codes and sales areas may share a single credit limit — the standard grouping behaviour |
| Credit master | Per customer: credit limit, limit currency, risk category, credit group, and a manual block flag |
| Exposure calculation | Open sales orders (not yet delivered) + open deliveries (not yet billed) + open invoices (not yet paid) + special liabilities. Recomputed on change, not on a schedule |
| Check points | Sales order creation, delivery creation, and goods issue. A document that breaches the limit receives a credit block |
| Blocked document handling | Worklist for blocked orders and deliveries; release requires authority, records the user, the reason, and the amount released — release is itself change-documented and SoD-checked |
| No postings | The credit check creates no accounting document; it prevents one. Stated explicitly so no one looks for a posting that does not exist |
| Reporting | Credit exposure and limit utilisation per customer, blocked document list, days-sales-outstanding and oldest open item, release history |

Credit limits are advisory only if configured that way — the product owner can set a warning
threshold beneath the hard limit, matching standard practice.

---

## §15 · People (HR subset) `DRAFT`

D-013 and R-11: everything that touches FI and CO is built and correct; statutory calculation is
deliberately not built.

### 15.1 What is built

| Area | Detail |
|---|---|
| Employee master | Date-delineated records: a change creates a new dated record rather than overwriting history, so any past date can be reconstructed exactly |
| Organisational structure | Org units, positions, jobs, hierarchy, reporting line |
| Assignment | Position → cost centre → employee, with validity dates |
| Pay structure | Pay components (wage-type equivalent) with their accounting mapping |
| Deduction rules | Configurable conditions and formulas per jurisdiction (no shipped statutory logic) |
| Payroll result | Calculated by configured rules, or imported from an external provider |
| **Payroll posting** | Generates an accounting document: gross pay and employer costs debited to cost centres and cost objects; net pay, deductions, and provisions credited |
| Other payments | Bonuses, advances, expense reimbursements, each with its own posting key |
| End-of-service provision | Periodic accrual posting to a provision account, charged to cost centres (GCC-relevant) |
| Salary payment | Executed through the payment engine (E12) |
| Time | Absences, attendances, leave quotas and balances |
| Reporting | Headcount, personnel cost by cost centre, pay component analysis |

### 15.2 Posting example

Salary run for 100 employees, gross 250,000, employee deductions 25,000, employer contributions
(configured) 30,000, EOS accrual 10,000:

| Debit | Credit | Amount |
|---|---|---|
| Salary expense — by cost centre | | 250,000 |
| Employer contribution expense — by cost centre | | 30,000 |
| EOS provision expense — by cost centre | | 10,000 |
| | Net pay payable | 225,000 |
| | Deductions payable (by deduction type) | 25,000 |
| | EOS provision liability | 10,000 |
| | Employer contribution payable | 30,000 |

Every line carries cost centre, profit centre, and the source payroll run — so personnel cost is
visible in cost centre reports and profit centre profitability, and an auditor can trace a salary
cost back to the run and the employee.

### 15.3 Explicitly not built (DV-001)

Statutory income tax, social insurance, statutory filing formats, retro-calculation and payroll
re-runs across closed periods, and country-specific leave law. The application states this plainly
in the People module rather than approximating it. External results can be imported and posted so
the general ledger is never wrong.

---

## §16 · Audit & external verification `DRAFT`

R-12 and D-014: the auditor is a first-class user, not a report.

### 16.1 Auditor Workspace

| Capability | Detail |
|---|---|
| Scoped access | Time-boxed read-only grant limited to companies, periods, and modules |
| No posting rights | Structurally impossible to post, change or delete; the role cannot hold a posting capability |
| Audited auditor | The auditor's own access and queries are logged — including what they looked at and what they exported |
| Working state | Findings, notes, bookmarks, and requests to management persist with status and response |

### 16.2 Drill-through

Financial statement line → account balance → line items → journal entry → source document (purchase
order, sales order, material document, payroll run) → master data as it was at posting date (from
change documents, not current values). Every hop is a link, not a reconciliation exercise.

### 16.3 Change history

Field-level before/after with user, timestamp, reason, and the transaction used — for master data
and configuration. Special attention to vendor bank details, payment terms, pricing conditions, and
user authorisations, which is where fraud lives.

### 16.4 Tie-outs (`AUDIT.TIEOUT.RUN`)

| Tie-out | Assertion |
|---|---|
| AP control account = sum of vendor balances | Subledger integrity |
| AR control account = sum of customer balances | Subledger integrity |
| Inventory GL = sum of stock valuation | Materials ↔ finance integrity |
| GR/IR clearing = open goods receipts + open invoices | Cut-off correctness |
| Revenue recognition vs billing vs goods issue | Revenue completeness |
| Payroll expense vs payroll runs vs payments | Personnel cost completeness |
| Intercompany balances in both companies agree | Group consistency |
| Number range continuity per document type | No hidden deletions |
| Journal debits = credits per period | Bookkeeping |

### 16.5 Number range integrity

For every range: expected count versus actual count, gaps detected, and the reason for any gap.
Because allocation is locked and gap-free (D-019, E3), a gap means something happened outside the
application, which is itself a finding.

### 16.6 Period close evidence

Which periods were open, when they were closed, by whom, what postings occurred after closing and
under what authority, and which adjustments used special periods.

### 16.7 Access review and segregation of duties

Who can do what, and role-conflict rules (`sod_rule`) detecting combinations that should never
coexist — e.g. create vendor and execute payment, post journal entry and configure the chart of
accounts, receive goods and approve the invoice.

### 16.8 Evidence export

A generated pack — documents, listings, tie-out results, change histories, finding statuses —
with a hash manifest so the recipient can prove nothing was altered after export.

---

## §17 · Output & document production `DRAFT`

R-21. An ERP that cannot produce a document is not usable.

| Output | Trigger | Format | Notes |
|---|---|---|---|
| Purchase order | On save or on release | PDF, email | Print layout, conditions, delivery schedule, terms |
| Request for quotation | On release | PDF, email | To multiple vendors |
| Goods receipt note | On posting | PDF | Movement details, batch, storage location |
| Supplier invoice cover | On posting | PDF | For internal filing |
| Order confirmation | On sales order save | PDF, email | Availability and price |
| Delivery note | On delivery creation | PDF | Picking list variant too |
| Picking list | On delivery creation | PDF | Warehouse copy with storage locations and batches |
| Invoice | On billing | PDF, email | Tax-compliant layout, payment terms |
| Credit memo | On billing cancellation | PDF | |
| Customer statement | On demand or scheduled | PDF, email | Open items and ageing |
| Dunning letter | Dunning run | PDF, email | Per dunning level |
| Payment advice | Payment run execution | PDF, email | Remittance details per vendor |
| Payment medium file | Payment run execution | Bank file | Configurable format |
| Cheque | Payment run | PDF | Where applicable |
| Asset depreciation schedule | Depreciation run | PDF, XLSX | |
| Shop papers | Production order release | PDF | Operation ticket, component list, confirmation slip |
| Financial statements | On demand | PDF, XLSX | Balance sheet, P&L, trial balance, cash flow |
| Audit evidence pack | On demand | PDF, ZIP | With hash manifest |

**Notifications (D-032).** The approval inbox is always the system of record — every approval,
release and blocked document appears there regardless of any other channel. Email notification is
optional and per user, and **no workflow step may depend on email delivery**: if the mail server is
unreachable, approvals still work. Email carries a link to the document, never an action that
bypasses authorisation. The mail server is configured through `CFG.PLT.MAIL.DEFINE` (D-033).

**Architecture:** output definition (layout) + output condition (when, to whom, which medium) →
queued job on the worker (E18) → PDF rendered → archived as `output_artifact` with reproducibility
inputs stored, so any document can be re-generated identically years later. Reprinting never
changes the original.

---

## §18 · Data migration & bulk import `DRAFT`

R-13. This is the mechanism that makes R-06 real: an implementation plan becomes an ordered set of
import files plus configuration definitions.

### 18.1 Pipeline

```
Template download  →  Upload to staging  →  Validate  →  Simulate (dry run)  →  Post  →  Verify
     ↑                                                    |
     └────────────── error log with row numbers ──────────┘
```

| Stage | Behaviour |
|---|---|
| Template | One per object, column-headed, with a data-dictionary sheet, mandatory-field marks, and example rows |
| Staging | Raw rows stored per session; nothing touches live data |
| Validation | Same validators as manual entry — no back doors. Errors carry row and column references and plain-language reasons |
| Simulation | Full dry run including dependency checks and document generation logic, rolled back at the end, producing a results preview |
| Posting | Executed in dependency order, each object through its normal create path so change documents and audit trail are produced identically |
| Session | Saved, re-runnable, and resumable; failed rows can be corrected and re-posted without reloading everything |
| Verification | Post-load tie-outs and counts reported |

### 18.2 Import objects (M1 and Phase 2)

Organisation (company code, plant, storage location, purchasing org, sales org, controlling area),
chart of accounts and GL accounts, cost centres and activity types, business partners with roles
and segments, materials with all views, BOMs, routings, work centres, pricing and condition
records, purchasing info records and source lists, opening stock per storage location including
batches, open vendor items and balances, open customer items and balances, GL opening balances,
open purchase orders, open sales orders, open production orders, assets with acquisition values and
depreciation start dates, employees with dated records.

### 18.3 Import safety rules

- Import runs post through the normal document path, so **every imported balance has a real
  document** and can be reversed (D-017).
- Imports run on the worker, never in a request handler (D-022).
- An import session is attributable: who uploaded, when, what file hash, how many rows.
- Re-importing the same file is detected and refused unless explicitly forced, preventing
  duplicate postings.

---

## §19 · UI/UX design system `DRAFT`

R-03 and D-015: **own the visuals, keep the behaviour.**

### 19.1 Behaviours preserved (what makes a native user productive)

| Behaviour | Detail |
|---|---|
| Command box | Type any of our codes or any reference alias, jump straight there. Always at the top. |
| Dense data grids | Sortable, filterable, column freeze, subtotals, totals, layout variants, export |
| Function keys | F3 back, F8 execute, F1 help, Ctrl+S save, Enter confirm; shown in the status bar |
| Selection screens | Multi-field selection criteria with saved variants, before every list report |
| Same field order and grouping | On the same business screens, fields appear in the same order and grouping as users expect, so knowledge transfers |
| Document flow button | On every document, showing the full predecessor/successor graph |
| Change log button | On every master record and configuration item |
| Status bar | Menu path, transaction code, message line, F-key hints |
| Status and traffic indicators | Document status visible at a glance in lists |
| Worklists | "Due today" style lists that drive daily work rather than requiring navigation |
| Keyboard-first | A full flow can be completed without a mouse |
| Incremental save of incomplete master data | Save partially maintained records and complete them later |
| Where-used and drill-through everywhere | No dead ends in navigation |

### 19.2 Visual identity (ours)

| Element | Direction |
|---|---|
| Palette | Warm neutral base with a single deep accent; no grey-blue corporate imitation |
| Typography | Modern system stack, tabular figures for all numbers (mandatory for aligned columns) |
| Density | Compact by default with a comfortable mode; ERP users want rows, not cards |
| Components | Flat, sharp-edged, high information density; no rounded pill aesthetic |
| Iconography | Our own set, geometric, consistent stroke weight |
| Logo & mark | **Placeholder for now** (§27 item 10). A neutral geometric placeholder is used until the identity package is produced; nothing in the code depends on the artwork, so swapping it later is a single asset change |
| Motion | Minimal — used only to indicate state change, never decorative |
| Dark mode | Supported |
| Accessibility | Keyboard navigable, visible focus, WCAG AA contrast, screen-reader labels on all form fields |
| Responsive | Desktop-first (ERP reality) but usable on tablet for approvals and worklists |

### 19.3 Screen archetypes

| Archetype | Used for | Structure |
|---|---|---|
| **Entry screen** | Creating a document | Header fields, tabbed detail, live totals, validation on field exit, action bar |
| **Worklist** | Daily operations | Selection screen → grid → drill-through, with status filters and bulk actions |
| **Master data** | Material, partner, GL account | View tabs with independent status, navigator tree, mass maintenance |
| **Configuration activity** | Workbench | Prerequisites panel, field form, dependency links, change log |
| **Plan board** | MRP, production | Hierarchical grid with expandable levels, exception column, action shortcuts |
| **Analysis** | Reports | Selection screen, hierarchy, drill-through, export, saved layouts |
| **Approval inbox** | Release strategies | Queue with document preview, approve/reject with reason, delegate |

### 19.4 Localisation readiness (R-19, D-008)

No hardcoded user-visible strings — all text resolves through the message catalogue with an i18n
key. Layouts use logical CSS properties (start/end, not left/right) so right-to-left languages can
be added without rework. Date, number, currency and name formats resolve from locale. Ship English.

### 19.5 Anti-imitation checklist (binding — D-034)

R-18 permits behavioural divergence; this checklist enforces **expressive** divergence. It is a
review gate at step 2 and step 7 of the page cycle (§24.1), and it exists as much for legal safety
as for design identity: business concepts and workflows are not protectable, but copying a product's
visual expression, screen designs, icons or marks is a genuine legal exposure (RK-11).

| # | Rule | Applies to |
|---|---|---|
| AI-01 | No reproduction of the reference product's colour palette, gradients, chrome, title bars, button shapes or spacing rhythm | Every screen |
| AI-02 | No imitation of its icon set, logo, fonts, sounds, splash screens or help navigation style | Everywhere |
| AI-03 | Screen composition is ours: field **order and grouping** may match (that is workflow knowledge), but layout, grid, spacing and visual hierarchy are our own | Every form |
| AI-04 | Our screen titles and labels use our own vocabulary; reference terms appear only inside the clearly-labelled alias lookup | Everywhere |
| AI-05 | Reference identifiers and trademarks never appear in navigation, page titles, messages, exports, emails or generated documents | Everywhere |
| AI-06 | No marketing claim of being, being derived from, or being endorsed by the reference product. Compatibility is described as *workflow familiarity* | Product copy |
| AI-07 | Automated enforcement: a lint rule fails the build if a reference trademark string appears anywhere in user-facing text outside the alias registry data | CI |

**Note on terminology hygiene:** the alias registry exists so experienced users can find things fast.
It is presented as a lookup aid (*"you searched ME21N — here is the equivalent"*), never as our own
naming. Users can hide reference terms entirely through a preference.

---

## §20 · Repository & code architecture `DRAFT`

### 20.1 Structure

```
cairn/
├── CAIRN.md                      ← this document (source of truth)
├── docker/                       compose files, dockerfiles, entrypoints, backup scripts
├── drizzle/                      SQL migrations, versioned
├── src/
│   ├── app/                      Next.js App Router: routes, layouts, server actions
│   ├── platform/                 the engines (§5) — no module-specific logic
│   │   ├── auth/  org/  numbering/  lock/  document/  posting/  valuation/
│   │   ├── pricing/  availability/  mrp/  costing/  payment/  release/
│   │   ├── change/  reporting/  import/  output/  jobs/  cache/  i18n/
│   │   └── messages/             message catalogue
│   ├── modules/                  one folder per business module
│   │   └── <module>/
│   │        ├── schema.ts        tables (Drizzle)
│   │        ├── domain.ts        pure business rules, no I/O
│   │        ├── services.ts      transactional use cases (the only place posting happens)
│   │        ├── queries.ts       read models for lists and reports
│   │        ├── registry.ts      screen metadata: code, aliases, fields, actions
│   │        └── ui/              screens for this module
│   ├── ui/                       shared components: grid, field, selection screen, status bar
│   └── worker/                   worker entrypoint (same image, different command)
├── tests/                        unit, integration, golden-flow, isolation, conformance
└── scripts/                      seeding, standard config activation, fixtures
```

### 20.2 Layering rules (enforced by lint and review)

1. `domain` never imports I/O. It is pure and therefore testable without a database.
2. Only `services` may open a transaction, allocate numbers, or post documents.
3. `ui` never talks to the database directly — it calls services and queries.
4. Modules never import each other's internals; cross-module effects go through platform engines.
   Procurement does not "call sales"; procurement posts a document and the document engine writes
   the flow links and posts the accounting consequences.
5. The screen registry is the single declaration of a screen's existence — navigation, the command
   box, alias search, and the documentation inventory all read from it.

### 20.3 Registration and discoverability

Each module contributes: tables, services, screens, registry entries, import templates, output
definitions, message texts, and seed data. Adding a screen means adding one registry entry — the
command box, alias search, navigation tree and the page inventory in §26 all update from it. This
is what keeps §26 from drifting out of date.

---

## §21 · Background jobs & worker `DRAFT`

D-022. Anything that can take more than a second or two runs on the worker.

| Job | Trigger | Notes |
|---|---|---|
| MRP run | Manual or scheduled | Per material or plant-wide; progress reported; cancellable |
| Payment run proposal and execution | Manual | Proposal reviewable before execution |
| Payroll calculation and posting | Manual or scheduled | Posting produces accounting documents |
| Depreciation run | Period end | Per company code, per period |
| Period close tasks | Manual | Sequential with dependencies |
| Balance carryforward | Year end | Idempotent |
| FX revaluation | Period end | With automatic reversal |
| Bank statement import and auto-clearing | Manual or polled | Matching rules engine |
| Dunning run | Scheduled | Proposal then output |
| Import validation, simulation and posting | Manual | Large files |
| Report and output generation | On demand | PDF/XLSX renders |
| Backup | Scheduled | See §22.6 |
| Health and integrity checks | Scheduled | Tie-outs, number range checks |

**Design:** job definitions with parameters, queues with concurrency limits, retries with backoff,
structured logs, progress and result storage, and a job monitor screen for administrators. Long
jobs hold no HTTP request and survive a web container restart.

---

## §22 · Deployment architecture `DRAFT`

### 22.1 Containers

| Service | Image | Role | Network exposure |
|---|---|---|---|
| `app` | our image, Next.js standalone | Web UI and server actions | Joined to `proxy` and `cairn_internal` |
| `worker` | same image, worker entrypoint | All long-running jobs (§21) | `cairn_internal` only |
| `db` | `postgres:17-alpine` | Database | `cairn_internal` only |
| `pgbouncer` | `edoburu/pgbouncer` | Connection pooling | `cairn_internal` only |
| `cache` | Dragonfly | Sessions, queue backing, config cache | `cairn_internal` only |
| `migrate` | our image, one-shot | Schema migration + standard config activation | `cairn_internal`, exits |
| `backup` | `postgres:17-alpine` + cron | Scheduled dumps, retention, verification | `cairn_internal` only |

**Networks:** `proxy` (external, created by the host, Traefik attaches to it) and
`cairn_internal` (internal-only, no route out). Only `app` joins both (D-024).

**Volumes:** database data, backup archives, output artefacts (generated documents), Dragonfly
persistence.

**Implementation status (v0.12):** `Dockerfile`, `.dockerignore`, `docker-compose.yml`,
`.env.docker.example` and `docker/postgres/10-app-role.sh` now implement the **core app/db/migrate
slice only**. The table above is the target stack, not a claim that worker, pooling/cache or scheduled
backup services already exist. Current setup and exact verification are in §26.13.

### 22.2 Traefik integration (external, not in our compose)

Labels on the `app` service:

```
traefik.enable=true
traefik.docker.network=proxy
traefik.http.routers.cairn.rule=Host(`cairn.deepakpt.com`)
traefik.http.routers.cairn.entrypoints=web
traefik.http.services.cairn.loadbalancer.server.port=3000
```

No certresolver configured — TLS is terminated by the service in front of Traefik. If TLS later
moves into Traefik, add an entrypoint and certresolver; no application code changes.

### 22.3 Forwarded headers (D-027)

The application trusts `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For` from the
known proxy chain only. Without this, generated URLs use the internal hostname and secure cookies
may be dropped — presenting as broken redirects and failed logins.

### 22.4 Connection pooling (D-026)

PgBouncer in **transaction** mode. Server-side prepared statements must be disabled on pooled
connections, or the application will intermittently fail with confusing protocol errors. The
migration container connects **directly** to PostgreSQL in session semantics, not through the
pooler.

### 22.5 Startup order

```
db healthy → migrate (runs, exits 0) → app + worker start → worker begins consuming jobs
```

Health checks gate each step. The app never starts against an unmigrated schema.

### 22.6 Backup & recovery (D-023)

| Aspect | Design |
|---|---|
| Method | `pg_dump` custom format on schedule, plus **continuous WAL archiving** so point-in-time recovery is available (D-031) |
| Retention | Generational: **14 daily · 8 weekly · 12 monthly**. Each generation pruned by age, never by count-in-the-dark |
| Verification | **Automated weekly restore** of the newest dump into a scratch schema, followed by row-count and tie-out integrity checks. The result is logged and surfaced in the job monitor — a silent backup failure is the real risk |
| Encryption | Backups encrypted at rest; the key is held outside the backup volume |
| Restore | Documented, scripted and **rehearsed before M1 sign-off**, with the measured restore time recorded here |
| Offsite | Host-level responsibility; the app's job is to guarantee a verified, restorable artefact exists |
| Audit relevance | Backup, restore and verification events are logged; auditors ask how data loss is prevented |

### 22.7 Licence note

Dragonfly is source-available under BSL 1.1, converting to Apache 2.0 on a future change date.
Internal use is unrestricted; the restriction targets offering it to third parties as a hosted
service. If Cairn is ever offered as a service to others, check this clause or switch to Valkey
through the cache interface (`D-004`). PostgreSQL, PgBouncer, Traefik and Redis/Valkey are under
permissive licences.

### 22.8 Configuration and secrets

Environment-driven configuration with no secrets in the repository: database credentials, session
secret, cache URL, application base URL, proxy trust settings, retention policies, timezone, and
locale defaults. Separately privileged database roles: an application role with no data-definition
rights (NOSUPERUSER NOBYPASSRLS), and a migration role that owns the schema and has BYPASSRLS
for forced-RLS data migrations and narrowly exposed administration functions (D-047).

**Mail server (D-033).** SMTP settings are **not** environment-only. They are configured in the
application through `CFG.PLT.MAIL.DEFINE` and stored encrypted at rest, with the password
write-only in the UI (set and replace, never displayed). A connection test and a test send are part
of the screen. An optional environment value provides only first-boot bootstrap, and once set
through the UI the stored value wins. Mail outages never block a workflow step (D-032).

---

## §23 · Security & access control `DRAFT`

| Area | Design |
|---|---|
| Authentication | Session cookie, HTTP-only, secure, same-site; password hashing with a modern adaptive algorithm; optional two-factor for administrators and approvers |
| Authorisation | Capability-based per transaction code, with organisational restrictions (company code, plant, purchasing org, sales org, cost centre) |
| Field-level control | Sensitive fields restricted by role: partner bank identifiers are encrypted at rest and masked in normal views/history; full reveal requires a separate audited authority (D-059). Payment terms, pricing conditions and standard prices are also role-restricted. |
| Segregation of duties | Rule catalogue detecting forbidden combinations, evaluated on every role assignment (§16.7) |
| Release strategies | Approval thresholds enforced server-side; a document above threshold cannot be posted unreleased by any user |
| Audit | Every access, change, approval, export and failed authorisation attempt is logged |
| Session security | Idle timeout, forced logout, session listing per user with remote revocation |
| Data protection | Personal data (employees, contacts) isolated, access-logged, and exportable/deletable subject to retention |
| Tenant isolation | Row-level security plus a dedicated isolation test suite |
| Transport | TLS terminated upstream; internal traffic on an isolated network |
| Secrets | Environment-injected, rotated, never logged |

---

## §24 · Testing, page gathering & debugging protocol `DRAFT`

R-08 is a process, so the process itself is specified.

### 24.1 The per-page cycle

| # | Step | Output |
|---|---|---|
| 1 | **Gather** — the page's business purpose and every field, action, validation, and consequence are captured in this document using the template in §24.2 | `SCR-nnn` section filled in |
| 2 | **Confirm** — product owner reviews and marks up the page spec before code is written | Spec status → AGREED |
| 3 | **Implement** — screen, service, validations, registry entry, message texts | Code + registry entry |
| 4 | **Automated test** — happy path, boundary, negative, reversal; asserting **database state, generated documents, and accounting entries**, not just the UI | `TST-nnn` cases passing |
| 5 | **Walkthrough** — product owner performs the transaction in their own tenant, created page by page | Walkthrough notes |
| 6 | **Debug** — discrepancies logged as findings with IDs and fixed | `FND-nnn` entries, closed |
| 7 | **Sign off** — status recorded with date, tester, and any divergence raised | Status → SIGNED OFF; DV entry if needed |

### 24.2 Page specification template

Every screen gets this in §26 (Phase 1) and in later phase sections:

```
SCR-nnn  ·  <Our screen name>
Code:          MODULE.OBJECT.ACTION
Aliases:       reference identifiers, searchable only
Conformance:   Tier A / B / C
Purpose:       one paragraph, business language
Prerequisites: configuration, master data, authorisations
Fields:        name · label · type · length · mandatory · default · derivation · validation · alias
Actions:       button/function key · effect · confirmation · authorisation
Creates:       documents, number ranges consumed, flow links, change documents
Postings:      exact debit/credit lines with account determination keys
Edge cases:    boundaries, negative paths, reversals, locking behaviour
Divergences:   DV-nnn if any
Tests:         TST-nnn list
Status:        DRAFT → AGREED → IN BUILD → SIGNED OFF
```

### 24.3 Test layers

| Layer | Scope | Tooling |
|---|---|---|
| Unit | Pure domain rules: pricing calculation, tax, lot sizing, depreciation, date logic | Fast, no database |
| Integration | Engine behaviour: numbering under concurrency, locking, posting atomicity, reversal, rollback | Database-backed |
| Golden flow | P2P, O2C, PP, R2R executed end to end against a freshly activated standard configuration, asserting final trial balance and every intermediate document | Database-backed |
| Isolation | Tenant separation; attempts to cross clients fail | Database-backed |
| Conformance | Reference behaviours: known inputs → expected documents and postings (§3.2) | Database-backed |
| Regression | Every closed finding gains a permanent test so it cannot return | Database-backed |
| Performance | MRP on a realistic material population; financial reports over multi-year data; grid paging | Database-backed |

**Standard configuration as fixture:** every integration, golden-flow and regression test starts
from `INTL-STD-2` (§7.3) activated into a throwaway schema. Deterministic, reproducible, and it
proves the configuration package itself.

### 24.4 Debugging facilities (built in, not bolted on)

| Facility | Purpose |
|---|---|
| Document flow explorer | See the whole chain for any document |
| Posting trace | For any accounting line: which rule, which account determination key, which configuration produced it |
| Configuration completeness checker | Names the missing configuration behind any failure |
| Lock monitor | Live lock view with holder and waiter, stale-lock release |
| Number range monitor | Current state per range, gaps, allocation history |
| Message log | Per user session, with technical detail attached to each message |
| Job monitor | Queue state, run history, logs, retry |
| Time-travel view | Reconstruct master data as of any past date from change documents |

---

## §25 · Phase plan & Milestone 1 acceptance `DRAFT`

### 25.1 Milestone 1 (frozen definition, R-09)

**Company creation → production → sale → invoice clearing → audit, fully working.**

| Step | Sub-milestone | Content | Deliverable state |
|---|---|---|---|
| M1a | **Substrate** — `IN BUILD` | Schema conventions, engines E3/E4/E5/E6/E14, message catalogue, registry, auth, Configuration Workbench, tenant onboarding wizard | A new tenant can be created through the UI |
| M1b | **Foundation** | Full enterprise structure and financial configuration; standard configuration package; master data screens (material, business partner, GL account, cost centre, work centre, BOM, routing, conditions); import templates for these | A company is fully configured and populated with master data |
| M1c | **Procure to Pay** | Requisition → PO → release → goods receipt → invoice verification → payment run → GR/IR analysis, with banking and statement import | A raw material is purchased, invoiced, paid and reconciled |
| M1d | **Production** | MRP run → planned orders → production orders → component issue → confirmations → finished goods receipt → settlement; activity rates; standard cost estimate | A finished good is produced from MRP demand, with variances settled |
| M1e | **Order to Cash + R2R + Audit** | Sales order (with credit check, D-029) → delivery → goods issue → billing → AR → incoming payment → clearing; dunning; **intercompany sale between the two company codes with automatic mirror posting and elimination** (D-028); period close; trial balance, P&L, balance sheet, consolidated statements; auditor workspace with drill-through, tie-outs, evidence export | The full loop closes, consolidates, and is externally verifiable |

### 25.2 Milestone 1 acceptance criteria

1. A new tenant can be created through the UI by a non-technical user, guided by the Workbench.
2. Every configuration activity in §6.2 exists, is gated by prerequisites, and writes change documents.
3. The full flow in §11 completes with **no manual database intervention**.
4. Every accounting document is balanced; the engine makes an unbalanced document impossible.
5. Every posting traces to a source document, and every source document shows its successors.
6. Nothing posted is deleted; all corrections are reversible documents.
7. MRP produces planned orders from real demand, exceptions are visible, and conversion to production orders works.
8. Production order actual cost, standard cost, and variance are all reported and settled to GL.
9. Salary and other personnel costs post to cost centres and are visible in cost centre reporting.
10. Trial balance balances; P&L and balance sheet are produced with comparatives.
11. The auditor workspace can drill from a statement line to the original source document and export a hash-manifested evidence pack.
12. Tenant isolation is proven by test; the second company code can be created and transacts independently.
13. The Docker stack runs on the host behind Traefik at `cairn.deepakpt.com`.
14. Backups run, and a restore has been demonstrated.
15. No proprietary identifiers appear in the product's own naming, schema or UI (R-01), verified by a lint rule over the codebase and a check over the registry.
16. **Intercompany (D-028):** a sale from company code 1000 to 2000 produces the invoice in 1000 and the mirror payable in 2000 automatically; the tie-out report proves both sides agree; the consolidation report eliminates them.
17. **Credit (D-029):** an order that breaches the customer's credit limit is blocked at order entry, appears in the blocked worklist, and can only proceed through an authorised, reason-coded release.
18. **Anti-imitation (D-034):** the checklist in §19.5 is applied to every Phase 1 screen, and the trademark lint rule passes.

### 25.3 Later phases

| Phase | Content |
|---|---|
| 2 | MM depth: RFQ and quotation comparison, source lists and quota arrangements, physical inventory, batches, vendor evaluation, purchasing conditions |
| 3 | SD depth: pricing procedures in full, condition exclusions, credit management, shipping and packing, returns and credit memos, incompletion logs, output determination |
| 4 | FICO depth: asset accounting full, allocations, activity price calculation, internal orders and budgets, accruals, FX revaluation, cash flow statement, profitability analysis |
| 5 | Costing depth: overhead application (DV-002), WIP (DV-003), variance categories (DV-004), costing runs |
| 6 | MRP enhancements: planning strategies, forecast consumption (DV-007), capacity requirements and levelling (DV-005) |
| 7 | People: time management depth, leave workflows, personnel cost planning, reporting |
| 8 | Audit depth: continuous auditing rules, automated SoD monitoring, finding workflow with management response |
| 9 | Tier 3 implementation on request, one transaction at a time, using the same page cycle (§24.1) |


### 25.4 Bounded execution queue `AGREED · D-050`

This changes **how the work is delivered**, not the M1 scope or acceptance criteria above.
Each batch has one declared outcome and a maximum 15-minute wall-clock budget. Default: one
batch per reply, then a concise result/checkpoint. Do not silently start a second module in the
same long response. If a listed item proves too large, divide it again before implementation.

**Batch contract:** state the small target → implement only that target → run its focused checks →
record completed/unfinished work here → preserve changed source and any database changes → stop.
At 10 minutes, stop feature work and use the remaining time for validation/checkpointing. A timeout
means inspect the existing process/output and split the task, never rerun an unchanged long command.
No `bootstrap:reset`, database reset, tenant removal, or reseeding to recover an interrupted stage.
Isolated, explicitly identified test fixtures may be used in a verification batch; owner data is never
part of fixture cleanup. Full-suite, build/release, and backup/restore checks are separate batches
when combining them would jeopardise the time budget.

**Publish trigger (owner instruction, 2026-10-11):** once the full system is implemented and a UI test is
ready for the owner to run, push the completed state to the configured Git remote and inform the owner.
Do not push interim or partial module batches before that trigger.

| Batch | One outcome | Implementation budget | State |
|---|---|---|---|
| B-000 | Preserve the current database/source and record this smaller execution plan | ≤5 min | **DONE — this checkpoint; no feature/database mutation** |
| B-001 | Split the existing browser acceptance script into independently runnable targets | ≤10 min | **DONE — 23 pure harness tests and foundation browser target passed; no ERP feature/schema change** |
| B-002 | Publish/verify the already-written material **Basic data** view, including staged saves | ≤10 min | **DONE — production preview rebuilt; staged/basic/copy/history browser flow passed; one form-reset defect fixed** |
| B-003 | Verify the existing material **Purchasing** view and its plant/unit/tolerance rules | ≤10 min | **DONE — staged/completed/maintained purchasing flow, exact tolerances, unchanged save, conversion refusal and read-only authority passed** |
| B-004 | Verify the existing material **MRP settings** view and net-change flag | ≤10 min | **DONE — staged/no-op/complete/maintained settings, exact quantities, net-change, validation and read-only authority passed; no planning execution** |
| B-005 | Verify the existing material **Valuation** view and financial read/write boundaries | ≤10 min | **DONE — staged/prices/currency/no-op/stock guard, display-only finance and warehouse price denial passed** |
| B-006 | Payment terms: one lookup/schema/defaults service slice | ≤10 min | **DONE — tenant master, versioned/audited service, due-date calculation and additive defaults tested** |
| B-007 | Payment terms: one maintenance page and focused tests | ≤10 min | **DONE — protected list/create/change/history and saved-date preview browser passed** |
| B-008 | Business partner **general data backend** only | ≤10 min | **DONE — staged/audited general identity and stable supplier/customer role rows; no organisation segments** |
| B-009 | Business partner **general data UI** only | ≤10 min | **DONE — protected general create/change/search/history, dual-role/block lifecycle and read-only UI passed** |
| B-010 | Supplier **company-code segment backend** only | ≤10 min | **DONE — company-scoped reconciliation/terms/staging/blocking/version controls tested** |
| B-011 | Supplier **company-code segment UI** only | ≤10 min | **DONE — scoped financial form/history, staged/no-op/maintained/block lifecycle and authority checks passed** |
| B-012 | Supplier **purchasing-organisation segment backend** only | ≤10 min | **DONE — scoped buying defaults, delivery terms, blocks, references/version/RLS and plant gate tested** |
| B-013 | Supplier **purchasing-organisation segment UI** only | ≤10 min | **DONE — scoped buying form/history, status/block/validation and procurement authority passed** |
| B-014 | Customer **company-code backend** only | ≤10 min | **DONE — scoped AR/terms/staging/blocks/version/history/use controls tested** |
| B-015 | Customer **company-code UI** only | ≤10 min | **DONE — scoped AR form/history, finance access, status/block/validation lifecycle passed** |
| B-016 | Customer **sales-area backend** only | ≤10 min | **DONE — pricing/delivery master defaults, staging/blocks/version/audit and operational gate tested; no order posting** |
| B-017 | Customer **sales-area UI** only | ≤10 min | **DONE — protected sales-area maintenance on the partner Customer tab; no order posting** |
| B-018 | Customer company **payment-methods/dunning-procedure fields backend** only | ≤10 min | **DONE — code-only payment-method set and dunning procedure on the company segment; validated, versioned, audited; no UI inputs yet** |
| B-019 | Customer company payment-method/dunning UI only | ≤10 min | **DONE — editable/read-only fields and existing authority/version/audit path; automated browser acceptance passed in B-023 and owner-reported walkthrough pass recorded in B-097 (§26.35, §26.39, §26.114)** |
| B-020 | Customer company interest-indicator/tolerance-group fields, backend only | ≤10 min | **DONE — code-only defaults; migration, service and action acceptance passed in isolated PostgreSQL test DB (§26.36, §26.38)** |
| B-021 | Customer company interest-indicator/tolerance-group UI only | ≤10 min | **DONE — editable/display-only fields and access behavior; automated browser acceptance passed in B-023 and owner-reported walkthrough pass recorded in B-097 (§26.37, §26.39, §26.114)** |
| B-022 | Apply migration 0010 in an isolated dev DB and run B-020 service/action tests | ≤10 min | **DONE — isolated PostgreSQL 17.11 test DB; all 24 migrations including 0010 applied; 65/65 DB service/action tests pass (§26.38)** |
| B-023 | Run customer-company browser acceptance for B-019/B-021 | ≤10 min | **COMPLETE — automated browser target passed; owner reported all walkthrough checks passed in B-097 (§26.39, §26.114)** |
| B-024 | Close B-017 customer sales-area browser acceptance; add focused target if needed | ≤10 min | **COMPLETE — focused browser target passed; owner reported all walkthrough checks passed in B-097 (§26.40, §26.114)** |
| B-025 | Capture and approve partner-function semantics before implementation | ≤10 min | **DONE — roles, direction, cardinality/default and validity scope approved (§26.41)** |
| B-026 | Supplier partner-function catalogue/assignment schema and tenant RLS only | ≤10 min | **DONE — migrations 0011/9013 applied and default-deny verified in isolated PostgreSQL (§26.42)** |
| B-027 | Supplier partner-function read services only | ≤10 min | **DONE — tenant-scoped catalogue and assignment queries; database read/isolation tests pass (§26.43)** |
| B-028 | Seed the approved supplier partner-function catalogue in standard tenant configuration only | ≤10 min | **DONE — INTL-STD-2 seeds all three Cairn functions with owner-selected UNIQUE initial settings (§26.44)** |
| B-029 | Supplier purchasing partner assignment writes and cardinality/default enforcement only | ≤10 min | **DONE — audited create/replace/remove, tenant isolation, optimistic versions, unique/multiple rules and optional default behavior tested (§26.45)** |
| B-030 | Protected server actions for supplier partner-function reads and writes only | ≤10 min | **DONE — session-derived tenant/actor, purchasing capability gates, display/audit reads and action-security tests (§26.46)** |
| B-031 | Display-only supplier partner-function panel on Supplier Purchasing view | ≤10 min | **DONE — authority-gated catalogue/assignment cards and empty/default/inactive states (§26.47)** |
| B-032 | Supplier partner-function assignment editor on Supplier Purchasing view only | ≤10 min | **DONE — unique add/replace, multiple add/default, versioned remove; browser acceptance passed in B-033 (§26.48–49)** |
| B-033 | Dedicated live-browser acceptance for the supplier partner-function assignment editor | ≤10 min | **AUTOMATED ACCEPTANCE PASSED — dev-fixture lifecycle and authority coverage; fixture cleanup confirmed (§26.49)** |
| B-034 | UI-only disabled placeholders for four Supplier company-code defaults | ≤10 min | **DONE — fields appear in maintenance/display views, have no submitted names or save path; focused checks pass; live browser acceptance pending because isolated dev DB credentials are not configured (§26.50)** |
| B-035 | Define Payment Methods master v1 semantics and scope | ≤10 min | **DONE — owner-approved country-scoped codes, shared direction, definitions-only scope, and no standard seeds (D-058; §26.51)** |
| B-036 | Payment Methods master tenant-scoped schema and RLS only | ≤10 min | **IMPLEMENTED — table/constraints in 0012, forced tenant RLS/grants in 9014, schema registration and DB contract tests; migrations applied and schema/RLS acceptance passed 3/3 on disposable PostgreSQL 17.11 (§26.52)** |
| B-037 | Payment Methods tenant-scoped read services only | ≤10 min | **IMPLEMENTED — country/code get and country list, requested-direction filter includes BOTH, inactive rows retained unless activeOnly; DB read acceptance passed as part of the focused 8/8 service suite (§26.53)** |
| B-038 | Payment Methods audited create/change/retire service only | ≤10 min | **IMPLEMENTED — expected-version tenant-scoped create/change and soft retire with required actor/reason and field history; DB lifecycle/version/audit acceptance passed in the focused suite (§26.54); no server action, UI, seed, or partner-field integration** |
| B-039 | Payment Methods protected create/change/retire server actions and capability registration only | ≤10 min | **DONE — session-derived tenant/actor, `CFG.FIN.PAYMENTMETHOD.DEFINE` enforcement, grantable capability catalogue entry, forged/unauthorized/anonymous action tests (§26.56); no UI, payment-method data seed, or partner integration** |
| B-040 | Payment Methods workbench activity and status lifecycle only | ≤10 min | **DONE — seeded activity, idempotent NOT_STARTED backfill for existing tenants, writes mark it COMPLETED without downgrading; DB checks passed (§26.57); no UI** |
| B-041 | Payment Methods workbench route, registry entry and read-only list/detail/history UI only | ≤10 min | **DONE — tenant-scoped country/method review, detail and change history; workbench/registry links point to the built route; no editor** |
| B-042 | Payment Methods create/change editor form only | ≤10 min | **DONE — capability-gated create/change form uses B-039 protected save action, expected version and required reason; retirement UI remains separate** |
| B-043 | Payment Methods soft-retire confirmation UI only | ≤10 min | **DONE — capability-gated explicit confirmation, required acknowledgment/reason, expected version, and B-039 protected soft-retire action; no deletion** |
| B-044 | Add dedicated Payment Methods browser acceptance target only | ≤10 min | **DONE — `npm run smoke:browser:payment-methods`, guarded T989 fixture; create/change/retire, audit/activity state, display-only access and forged-query checks implemented; target selection passes** |
| B-045 | Run Payment Methods browser acceptance on a fresh disposable development DB only | ≤10 min | **AUTOMATED ACCEPTANCE PASSED — fresh PostgreSQL 17.11 fixture completed the target; tenant, method and test user cleanup verified (§26.62); no owner/production data used; product-owner walkthrough/sign-off remains pending (§24.1)** |
| B-046 | Capture and approve partner bank/contact v1 page rules only | ≤10 min | **DONE — owner approved partner-wide scope, bank fields, encryption/masking/reveal/audit policy, contact model and retention boundaries (D-059; §26.63); no code or data mutation** |
| B-047 | Define country-specific requiredness and validation rules for partner bank fields only | ≤10 min | **DONE — owner approved fail-closed country profiles, holder/country requirements, strict country-matched IBAN checksum/length, BIC syntax validation, and inclusive valid-from/to semantics with overlapping records allowed (D-060; §26.64)** |
| B-048 | Select the initial countries for partner bank validation profiles only | ≤10 min | **DONE — owner selected IN, KW, GB, US and JP; all are in the reference seed; no profile records added (D-061; §26.65)** |
| B-049 | Verify and record the Kuwait (KW) bank-validation profile requirements only | ≤10 min | **DONE — CBK and SWIFT Registry Release 103 confirm KW IBAN-only structure, length, bank identifier and issue/validation limits; profile specification recorded as D-062 (§26.66); no code or activation** |
| B-050 | Verify and record the India (IN) bank-validation profile requirements only | ≤10 min | **DONE — RBI IFSC and account-number sources plus current SWIFT registry verified; D-063 / §26.67 records local-account-number + IFSC rules and no India IBAN; research only, no code/profile activation or bank data** |
| B-051 | Verify and record the United Kingdom (GB) bank-validation profile requirements only | ≤10 min | **DONE — SWIFT and Pay.UK establish a 22-character GB IBAN with embedded bank, sort-code and account components; D-064 / §26.68 records the IBAN-only profile; research only, no code/profile activation or bank data** |
| B-052 | Verify and record the United States (US) bank-validation profile requirements only | ≤10 min | **DONE — ABA routing-number structure/check digit and current SWIFT registry verified; D-065 / §26.69 records nine-digit RTN plus opaque local account number; research only, no code/profile activation or bank data** |
| B-053 | Verify and record the Japan (JP) bank-validation profile requirements only | ≤10 min | **DONE — SWIFT, Japanese Bankers Association, MUFG and Japan Post sources verified; D-066 / §26.70 records domestic institution+branch code and local account handling; research only, no code/profile activation or bank data** |
| B-054 | Implement the versioned bank-data authenticated-encryption primitive only | ≤10 min | **DONE — AES-256-GCM envelope; key ID and tenant/partner/record/field context are authenticated; active-key writes and retained-key reads support later rotation; six focused tests, typecheck and diff check pass. No key loading, reveal/audit, masking/history, schema/database integration or bank identifiers (§26.71; D-067)** |
| B-055 | Define and implement fail-closed app-keyring configuration from deployment secrets only | ≤10 min | **DONE — lazy `CAIRN_BANK_DATA_KEYRING_JSON` parser accepts exactly the active ID plus up to 16 canonical 32-byte base64url keys; no default/fallback, generic errors, and Compose passes it only to the app. Seven pure tests pass; no actual keys, bank data, database, or storage integration (§26.72; D-068)** |
| B-056 | Add a safe envelope re-encryption helper for retained-key rotation only | ≤10 min | **DONE — authenticates before no-op; old-key envelopes are decrypted with the retained ID and re-encrypted under the active ID with a fresh nonce; wrong context/missing key/tampering fail closed. Eight encryption tests and seven keyring tests pass; no persistence, logs, DB, or bank data (§26.73; D-069)** |
| B-057 | Add a bank/contact change-history projection that masks sensitive values before generic history | ≤10 min | **DONE — `recordChange` writes allowlisted snapshots with IBAN/account identifiers and named-contact email/phone fully masked; free-form reasons/labels are withheld, unknown fields dropped, and `changeHistory` re-redacts stored values. Five isolated tests pass; no bank storage or database (§26.74; D-070)** |
| B-058 | Specify the separate authorization and audit contract for bank-data reveal only | ≤10 min | **DONE — owner selected `SEC.PARTNER.BANK.REVEAL` plus partner DISPLAY (normal matching; Administrator `*` inherits), selected IBAN/local-account fields only, required controlled purpose codes, every authenticated attempt logged before release, fail-closed audit, and DB-enforced append-only hardening (§26.75; D-071). No implementation or data** |
| B-059 | Add database-enforced direct-mutation protection to `audit_access_log` only | ≤10 min | **DONE — new migration revokes runtime UPDATE/DELETE/TRUNCATE while preserving SELECT/INSERT; parent-tenant cascade remains the owner-approved lifecycle exception (D-072). Two development-tenant integration tests added but not run without a confirmed disposable DB; typecheck and diff check pass. No reveal endpoint or bank data** |
| B-060 | Implement the session-bound bank-reveal authorization/audit writer boundary only | ≤10 min | **DONE — validated both authorities, field/purpose allowlists and opaque keys; added safe `AUTHORIZED`/denial attempt rows plus terminal-outcome writer; registered display/reveal capabilities in seed code but granted no new role pattern. Seven isolated tests pass; typecheck/diff check pass; no DB, decrypt, data path or UI (§26.77; D-073)** |
| B-061 | Specify the normal-view masking format for bank identifiers only | ≤10 min | **DONE — lists show fixed `••••`; details show `••••` + final four characters, with no original length/country prefix; values ≤4 chars remain fully masked; history stays fully masked (D-074; §26.78)** |
| B-062 | Implement the pure normal-view bank-identifier projection only | ≤10 min | **DONE — `projectPartnerBankNormalView` reuses the strict bank allowlist, applies the fixed list/detail masks, fully hides ≤4-character values, and drops ciphertext/unknown/nested fields. Three new pure tests pass; focused privacy/reveal suites pass 15/15; typecheck/diff check pass; no storage, route, UI or database (§26.79; D-075)** |
| B-063 | Implement the pure Kuwait (`KW`) bank-validation profile only | ≤10 min | **DONE — pure helper enforces KW IBAN normalization/structure/MOD-97, required holder/country, IBAN-only capture, derived bank code and optional BIC syntax; four tests pass; typecheck/diff check pass; no activation, persistence or bank data (§26.80; D-076)** |
| B-064 | Implement the pure India (`IN`) bank-validation profile only | ≤10 min | **DONE — pure helper requires holder/country, local account and IFSC; preserves the opaque account exactly, rejects IBAN, and syntax-checks IFSC/optional BIC. Five isolated tests, typecheck and diff check pass; no activation, persistence or bank data (§26.81; D-077)** |
| B-065 | Implement the remaining pure GB, US and JP bank-validation profiles together | ≤10 min | **DONE — pure validators enforce GB IBAN/MOD-97, US ABA routing structure/check digit plus opaque account, and JP seven-digit institution/branch code plus opaque account. Fourteen isolated tests; typecheck/diff check pass; no activation, persistence or bank data (§26.82; D-078–D-080)** |
| B-066 | Enforce the existing `FND.PARTNER.DISPLAY` capability in the partner read route only | ≤10 min | **DONE — `/foundation/partners` checks display access before route parameters or partner/history reads; denial regression test passes; typecheck/diff check pass. No bank data or reveal path (§26.83; D-081)** |
| B-067 | Establish server-generated opaque bank-record ID contract only | ≤10 min | **DONE — `generateBankRecordId` creates canonical random UUIDv4 IDs; B-060 boundary validates UUIDv4 shape and rejects malformed IDs without logging them. Eleven focused tests, typecheck and diff check pass. UUID shape is not provenance; no table, lookup, storage or reveal path (§26.84; D-082)** |
| B-068 | Enforce UUIDv4 bank-record IDs in the encryption context only | ≤10 min | **DONE — encryption/decryption AAD context requires the `BankRecordId` brand and validates canonical UUIDv4 at runtime. Nineteen focused ID/reveal/encryption tests pass; typecheck and diff check pass. No schema, database, bank data or reveal path (§26.85; D-083)** |
| B-069 | Add pure batch re-encryption for supplied encrypted bank fields only | ≤10 min | **DONE — transforms caller-supplied rows/fields to the active key, preserves null/current envelopes, returns ciphertext only, and fails closed on invalid envelopes. Three new batch tests; 22 focused ID/reveal/encryption tests pass; typecheck/diff check pass. No DB scan, persistence or retirement verification (§26.86; D-084)** |
| B-070 | Add active-key-only verification for supplied encrypted bank fields only | ≤10 min | **DONE — authenticates each non-null field/context in a supplied batch against a one-key active keyring; old-key envelopes or retained-key rings fail closed. Two new tests; 24 focused ID/reveal/encryption tests pass; typecheck/diff check pass. No DB scan completeness or global retirement proof (§26.87; D-085)** |
| B-071 | Add a pure dispatcher for implemented partner-bank country profiles only | ≤10 min | **DONE — normalizes country and dispatches only KW/IN/GB/US/JP to their pure validators; missing and unsupported countries fail closed. Three dispatcher tests plus all five profile suites pass (26 tests total); typecheck passes. No save-path integration, storage, schema, or bank data (§26.88)** |
| B-072 | Add the ciphertext-only partner-bank table schema and read-only tenant RLS only | ≤10 min | **DONE — typed schema plus migrations add UUIDv4-scoped, valid-dated partner rows; identifiers have envelope-only columns, forced tenant RLS, and app-role SELECT only. Four typed-schema/static-contract tests and typecheck pass. No migration application, write service, bank rows or values (§26.89)** |
| B-073 | Accept partner-bank migrations, constraints and RLS on a disposable PostgreSQL cluster only | ≤10 min | **DONE — all migrations passed on fresh disposable PostgreSQL 17.11; verified envelope/UUID/date/version/FK constraints, forced tenant RLS, SELECT-only privileges, tenant isolation, partner-delete block, and tenant cascade. The first run exposed PostgreSQL's repetition-count limit; additive migration 0014 corrected the bound without changing 0013. Cluster and synthetic fixtures removed; no owner/production data (§26.90)** |
| B-074 | Add a display-authorized, read-only partner-bank metadata lookup scoped by session tenant, partner and UUIDv4 row ID | ≤10 min | **DONE — requires `FND.PARTNER.DISPLAY`, derives tenant only from the authenticated session, and binds tenant + selected partner + UUIDv4 bank-row ID in the query. Returns allowlisted non-ciphertext metadata and the matched database row's ID only. Four focused tests and typecheck pass. No reveal/decryption, writes, UI or persistent DB access (§26.91)** |
| B-075 | Add a display-authorized, read-only partner-bank metadata list scoped by session tenant and partner | ≤10 min | **DONE — derives tenant from the authenticated session, binds tenant + partner, returns every matched row's ID and allowlisted non-ciphertext metadata, includes inactive history, and sorts deterministically. Four added tests (eight total) and typecheck pass. No DB access, writes, decryption, reveal, or UI (§26.92)** |
| B-076 | Add a display-only, masked partner-bank metadata tab to the Business Partner view | ≤10 min | **DONE — explicit `BANKS` tab only; reuses the display-authorized list service and shows only allowlisted metadata plus the fixed `••••` list mask. No identifiers, edit controls, decryption or reveal. Four focused UI/route tests, typecheck and production build pass; no live database/browser acceptance (§26.93)** |
| B-077 | Extend Business Partner browser acceptance to cover the read-only bank metadata tab | ≤10 min | **IMPLEMENTED — T992 target now checks the empty bank-list state, absence of Save/reveal controls for maintainer and display-only users, and return to General data. Typecheck and browser-harness (66/66) pass; target not run at B-077 completion (§26.94)** |
| B-078 | Review Drizzle metadata and run B-077 empty/read-only browser acceptance on a disposable PostgreSQL cluster | ≤10 min | **DONE — all 32 lexical migrations and B-077 target passed on a fresh disposable PostgreSQL 17.11 cluster; T992 cleanup verified; no owner/production data (§26.95)** |
| B-079 | Publish the pending bank-data batch on owner instruction only | ≤10 min | **DONE — one-time owner-directed exception pushed commits `9a39286` and `057e19c`; no-partial-push rule remains for future batches (§26.96)** |
| B-080 | Add the session/tenant/partner/UUIDv4-scoped D-074 masked detail reader only | ≤10 min | **DONE — row-derived crypto context; only mask + final four returned; six synthetic focused tests pass; no route/UI or real data (§26.97)** |
| B-081 | Wire the versioned keyring loader and D-074 reader into a read-only partner-bank detail UI | ≤10 min | **DONE — selected-row detail link/panel, generic unavailable state on keyring/crypto failure, no save/reveal; build and focused tests pass; live acceptance completed by B-082 (§26.98–26.99)** |
| B-082 | Run synthetic D-074 masked-detail browser acceptance on a disposable loopback database | ≤10 min | **AUTOMATED ACCEPTANCE PASSED — both maintainer and display-only viewer saw `••••` + synthetic final four; no save/reveal/plaintext; T992 partner/bank cleanup verified and cluster removed (§26.99)** |
| B-083 | Add a pure fail-closed readiness gate for the approved bank-profile authoring set | ≤10 min | **DONE — IN/KW/GB/US/JP report not-ready until a persisted profile is configured; missing/unsupported countries deny; validator success does not imply readiness. No persistence or save integration (§26.100)** |
| B-084 | Persist global profile policy revision/readiness for the approved country set; keep the runtime read-only | ≤10 min | **DONE — global country-keyed table, SELECT-only app privilege, seed defines five initial NOT_READY rows; same-revision seed runs preserve state and policy revision changes reset to NOT_READY. Fresh-cluster migration/seed acceptance passed in B-086 (§26.101, §26.103)** |
| B-085 | Add a read-only readiness service for the shared global partner-bank profile registry | ≤10 min | **DONE — only a current-revision READY row returns PROFILE_READY; missing, stale, non-ready and unsupported profiles deny; runtime role is checked and DB errors propagate. App-role integration and seed-state transitions passed in B-086; no activation or bank save path (§26.102–103)** |
| B-086 | Accept the global profile registry and readiness service on a disposable PostgreSQL cluster | ≤10 min | **PASSED — 34 migrations and reference seeds; app SELECT-only privileges, denied update, 5 NOT_READY rows, reader transitions, same-revision preservation and revision-change reset verified. Zero tenant/partner/bank rows; cluster removed; no owner/production DB (§26.103)** |
| B-087 | Register the approved profile-activation capability and fixed evidence code only | ≤10 min | **DONE — added `CFG.FND.PARTNER.BANKPROFILE.ACTIVATE` to the capability catalogue with no role grants, plus fixed evidence `PROFILE_VALIDATION_ACCEPTED`; existing Administrator `*` semantics remain. No activation action, audit table or profile mutation (§26.104)** |
| B-088 | Add a pure validator for the one-way profile-activation command only | ≤10 min | **DONE — requires an approved country, exact current policy revision, positive PostgreSQL integer version and fixed evidence code; rejects free-text/unknown fields and targets only READY. No actor check, DB write, audit or activation service (§26.105)** |
| B-089 | Add the global profile-activation audit schema and deny direct runtime access only | ≤10 min | **DONE — fixed-field global audit schema constrains actor scope, policy revision, one-way state transition, versions, evidence and UUIDv4 event ID; `PUBLIC`/app privileges revoked. No activation writer or DB application (§26.106)** |
| B-090 | Add a private atomic profile-activation database function only | ≤10 min | **DONE — row-locks and verifies revision/version/status, updates only `NOT_READY`→`READY`, then inserts the fixed audit event in the same function transaction. `PUBLIC`/app EXECUTE revoked; no runtime grant or service caller; SQL not applied (§26.107)** |
| B-091 | Add the capability-checked activation service/action and narrowly grant function execution | ≤10 min | **DONE — verified-session actor only, fixed evidence and strict command validation; uses the atomic function under tenant scope. `9020` grants only function EXECUTE to `cairn_app`; no role-capability grants or UI (§26.108)** |
| B-092 | Disposable PostgreSQL acceptance for activation migrations, function and runtime privileges | ≤10 min | **DONE — all 38 migrations and seeds passed on fresh local PostgreSQL 17.11; success/audit, concurrent one-way guard, stale/invalid denials, rollback on audit failure, direct-table privilege denials, no role grants and zero tenant/partner/bank rows verified. Cluster and artifacts removed; no remote/persistent DB (§26.109)** |
| B-093 | Add a capability-gated global profile-readiness/activation page only | ≤10 min | **DONE — separate `/foundation/partners/bank-profiles` route is gated by the activation capability, displays current policy/revision/status/version, and offers the one-way action only for current `NOT_READY` rows. No bank-record controls or reveal; 59 focused tests, typecheck, IP lint and diff check pass (§26.110)** |
| B-094 | Run cookie-backed browser acceptance for the activation route/action on disposable local PostgreSQL; remove all fixtures and temporary infrastructure | ≤10 min | **PASSED — anonymous, display-only denial, exact capability, Administrator `*`, one-way activation, forged-form resistance and fixed audit evidence verified in headless Chromium against a fresh PostgreSQL 17.11 database. Two authorized activations audited; zero partner/bank rows; all app/DB/browser fixtures removed (§26.111)** |
| B-095 | Run Chromium acceptance for stale-policy and missing-registry profile states on disposable local PostgreSQL; remove fixtures and temporary infrastructure | ≤10 min | **PASSED — stale KW and missing JP rows had no activation forms; current IN/GB/US `NOT_READY` rows retained forms with expected policy/version. No action submitted, activation audit, partner, or bank row created; all disposable fixtures and infrastructure removed (§26.112)** |
| B-096 | Publish the complete pending partner-bank batch, B-080–B-095, to `main` on explicit owner instruction | ≤10 min | **PUBLISHED — all 45 pending paths committed as `3035c9b` and fast-forward pushed to `deepakpt2/cairn-erp:main`; `.env.local` was not committed and no database was touched (§26.113)** |
| B-097 | Record owner walkthrough outcome for B-023/B-024 | ≤10 min | **DONE — owner reported both walkthroughs complete and all checks passed; no per-step evidence or environment details supplied; documentation only, no independent re-run (§26.114)** |
| B-098 | Add Supplier company-code Payment Methods storage only | ≤10 min | **DONE — nullable code-set column and additive migration 0017 plus schema-contract test; no master validation, service/action, UI, DB migration or seed application (§26.115)** |
| B-099 | Validate Supplier company-code Payment Methods in the save service only | ≤10 min | **DONE — canonical code set checked against same-tenant, same-country active OUTGOING/BOTH definitions; explicit blank clears, omission preserves, history is security-relevant; DB acceptance not run (§26.116)** |
| B-100 | Wire the protected Supplier Payment Methods action and eligible choices only | ≤10 min | **DONE — existing maintain action conditionally forwards the field using session-derived identity; choice service returns only active same-country OUTGOING/BOTH methods; UI remains disabled; DB acceptance not run (§26.117)** |
| B-101 | Add the capability-gated Supplier Payment Methods selector using eligible choices only | ≤10 min | **DONE — maintain-only checkbox editor, display-only saved value, explicit clear and stale-choice removal; remaining defaults stay disabled. No DB access; browser acceptance remains separate (§26.118)** |
| B-102 | Prepare Supplier Payment Methods live-browser acceptance only | ≤10 min | **TARGET UPDATED — supplier-company browser case now covers filtering, the ten-method cap, persistence, display-only access, stale-choice removal and explicit clear. Live run remains separate (§26.119)** |
| B-103 | Accept Supplier company Payment Methods migration and service behavior on fresh local PostgreSQL only | ≤10 min | **PASSED — fresh loopback PostgreSQL 17.11; 39 migrations and two shared seeds applied, Supplier service suite 25/25, fixtures removed with zero tenant/partner/default/payment/bank rows (§26.120)** |
| B-104 | Complete Supplier Payment Methods live-browser acceptance on a verified disposable local database; remove temporary infrastructure | ≤10 min | **PASSED — `supplier-company` alone passed in headless Chromium against local PostgreSQL 17.11 using the production standalone build; filtering, ten-code cap, persistence, read-only authority, stale-method removal and explicit clear covered. No B-104 migration/service-suite rerun; fixtures and temporary infrastructure removed (§26.121). No remote DB, commit or push.** |
| B-105 | Register the Company Code define capability only | ≤10 min | **DONE — added `CFG.ORG.COMPANYCODE.DEFINE` as a grantable, non-posting Foundation configuration capability; contract tests preserve no-role-grant and wildcard behavior. No action, UI, migration, seed execution or database access (§26.122). No remote DB, commit or push.** |

The approved dependency-ordered completion roadmap is in §25.5. A roadmap package is not permission
to combine large work into one batch: before implementation, declare one outcome, split it to fit the
≤10-minute feature budget, and run only that batch in the reply. PostgreSQL-gated acceptance items do
not authorize touching an owner/production database; unrelated development may proceed while a gate is
blocked. Do not drop requirements to meet the time budget; preserve partial work and continue in the
next bounded batch.


### 25.5 Approved completion roadmap `AGREED · SEQUENCING ONLY`

**Owner-approved sequence (2026-10-11).** This is the route from the B-021 state at that time through M1
acceptance and the later phases already agreed in §25.3. It orders work; it does not create new product
requirements or authorise undocumented field semantics. The detailed screen cycle in §24.1 remains
binding. Every package below must be split into actual one-outcome B-series batches under §25.4; each
reply does one such batch, ≤10 minutes of feature work. Large modules are not single batches.

#### 25.5.1 Acceptance-gate status

**B-022, B-023 and B-024 are complete.** B-022's isolated-database acceptance passed (§26.38).
B-023's customer-company and B-024's sales-area automated browser targets passed (§26.39–40); on
2026-10-12, the owner reported both manual walkthroughs complete with all checks passed (§26.114).
The walkthrough result is owner-reported; no per-step evidence or environment details were supplied,
and it was not independently re-run by the agent.

No B-022–B-024 acceptance gate remains outstanding. This closes only those listed acceptance outcomes;
it does not constitute overall M1 sign-off, production approval, or release/deployment. Do not access
an owner/production database for this record.

#### 25.5.2 M1b — foundation, configuration, and master data

Execute prerequisites in the define/assign order of §6.2. For every screen, follow §24.1 and split
schema/service, UI/authority, and test/browser work into separate bounded batches where necessary.

1. **Partner functions:** B-025 semantics are approved, B-026–B-032 implement the tenant-scoped catalogue,
   assignments and protected display/maintenance, and B-033 dedicated live-browser acceptance passed in a
   disposable development fixture (§26.41–49). PO determination remains a separate future outcome. Do not
   add unapproved role types, effective dates, plant/sub-range levels, or transaction behavior.
2. **Payment Methods and Supplier company-code defaults:** B-034 adds disabled, non-persisted placeholders
   for the four §9.2 Supplier defaults. B-035 records the owner-approved country-scoped, no-seed master
   semantics (D-058). B-036 adds the catalogue table and forced tenant RLS; B-037 adds tenant-scoped
   country/code reads; B-038 adds versioned, audited create/change and non-destructive retire services
   (§26.52–54). B-039 adds session-derived protected write actions and the grantable configuration
   capability (§26.56). All migrations and focused DB acceptance passed on a fresh disposable PostgreSQL
   17.11 cluster. B-040 registers the workbench activity and status lifecycle (§26.57). B-041 adds the
   workbench/registry entry and read-only list/detail/history route (§26.58); B-042 adds capability-gated
   create/change forms through the existing protected action (§26.59). B-043 adds versioned soft-retire
   confirmation (§26.60). B-044 adds a guarded dedicated browser target; B-045 ran it on a fresh
   disposable development database and passed the full lifecycle/access checks, then verified fixture
   cleanup (§26.62). Neither batch uses owner/production data. B-098 adds nullable Supplier company-code
   storage (§26.115), B-099 adds country/direction validation in the save service (§26.116), and B-100
   wires the existing protected action and eligible method choices (§26.117). B-101 adds the
   maintain-only selector, display-only saved value and explicit clear/stale-choice handling (§26.118).
   The selector uses only eligible choices; live browser acceptance and disposable migration acceptance
   remain separate. Per owner instruction, do not push these partial module batches; push and notify only
   when a user-runnable UI test is ready after full-system implementation.
   Dunning procedure, cash discount, and tolerance group remain disabled until their own required
   masters/semantics are available.
3. **Business-partner bank/contact data:** B-046 captured owner-approved v1 semantics/security
   boundaries (D-059), and B-047 approved fail-closed country-profile validation and date rules (D-060).
   B-048 selected IN, KW, GB, US and JP as the initial profile set (D-061). B-049–B-053 recorded
   source-backed specifications for KW, IN, GB, US and JP (D-062–D-066); initial profile-authoring scope
   is complete. B-083 adds a pure fail-closed readiness resolver for the D-061 set. B-084 adds a global country-keyed
   policy-revision/readiness registry and idempotent seed for five initial `NOT_READY` rows; a policy-revision change
   resets a row to `NOT_READY`. B-085 adds a read-only runtime lookup that reports ready only for an explicitly READY
   row matching the current policy revision. B-086 applied all 34 migrations and reference seeds on a fresh
   disposable PostgreSQL 17.11 cluster, verified five `NOT_READY` rows, SELECT-only runtime privileges, reader
   transitions, same-revision preservation and policy-revision reset, then removed the cluster; no tenant, partner
   or bank rows remained. B-087 registers `CFG.FND.PARTNER.BANKPROFILE.ACTIVATE` without role grants and defines
   fixed evidence code `PROFILE_VALIDATION_ACCEPTED`; Administrator wildcard semantics are unchanged. B-088 adds a
   pure activation-command validator for exact current revision/version, fixed evidence and one-way READY target,
   rejecting free text. B-089 adds a fixed-field global activation audit schema and revokes direct PUBLIC/app access.
   B-090 adds a private atomic SECURITY DEFINER function; B-091 adds the verified-session capability-checked service
   and server action, with actor client/user derived from the session and fixed evidence. Migration `9020` grants only
   function EXECUTE to `cairn_app`; B-092 accepts all 38 migrations/seeds and activation/privilege/rollback behavior
   on disposable PostgreSQL 17.11, then removes the cluster. B-093 adds a separate capability-gated global profile
   page with activation forms only for current `NOT_READY` rows. B-094 passes cookie-backed browser acceptance on a
   disposable PostgreSQL 17.11 database: viewer denial, exact-capability and Administrator `*` allowance, two one-way
   activations and fixed audit evidence; its temporary T094 role grants were fixtures only, not seeds (§26.111). B-095
   passes real-browser stale/missing fail-closed acceptance: stale KW and missing JP had no forms, while current IN/GB/US
   `NOT_READY` rows retained their expected activation forms. No action was submitted, and zero activation audits,
   partners or bank rows remained; T095's exact-capability grant was fixture-only (§26.112). B-096 then publishes the
   complete pending B-080–B-095 partner-bank batch to `main` on explicit owner instruction (§26.113). No persistent or
   remote DB, bank save or reveal is added. B-063 adds only a pure
   KW validator (D-076; §26.80), B-064
   adds only a pure IN validator (D-077; §26.81), and B-065 adds only pure GB/US/JP validators
   (D-078–D-080; §26.82); B-066 adds the explicit partner display-route guard
   (D-081; §26.83). B-054 adds only the versioned AES-256-GCM primitive (D-067; §26.71); B-055
   adds a lazy, fail-closed deployment-secret parser and app-only Compose
   injection (D-068; §26.72), but no actual key value or bank-data caller. B-056 adds a pure authenticated
   envelope re-encryption helper (D-069; §26.73), not a database migration or key-retirement process.
   B-057 installs allowlisted write-time and read-time change-history masking (D-070; §26.74); B-058
   defines the audited reveal contract (D-071; §26.75); B-059 revokes direct audit-log row mutation while
   retaining the approved tenant-delete cascade exception (D-072; §26.76); B-060 adds the session-bound
   authorization and safe audit-writer boundary, but not a data path (D-073; §26.77). Before any product bank-data
   write/reveal workflow exists, operational rotation/re-encryption and verified old-key retirement remain required,
   as does integration of the authorized terminal reveal outcome with the encrypted data path. Ordinary-view
   masking is now integrated: B-076's fixed list mask, B-080/B-081's scoped detail suffix UI, and B-082's live
   synthetic-only acceptance (§26.99). B-061 selected the normal-view suffix policy (D-074; §26.78), and B-062 implemented its pure
   allowlisted projection (D-075; §26.79); B-063 added the pure KW validator (D-076; §26.80), B-064
   added the pure IN validator (D-077; §26.81), and B-065 added pure GB/US/JP validators (D-078–D-080;
   §26.82); B-066 enforces `FND.PARTNER.DISPLAY` in the existing route (D-081; §26.83), and B-067 adds
   the UUIDv4 ID generator/format guard (D-082; §26.84), B-068 enforces that format in encryption AAD
   contexts (D-083; §26.85), B-069 adds a pure batch re-encryption transform (D-084; §26.86), B-070
   adds active-key-only verification for supplied batches (D-085; §26.87), B-071 adds a pure dispatcher for
   the five implemented country validators (§26.88), and B-072 adds the typed `partner_bank` schema with
   ciphertext-only identifier columns and forced tenant RLS (§26.89). B-073 applied all migrations only on a
   fresh disposable PostgreSQL 17.11 cluster, verified the constraints/RLS/privileges, and removed its cluster
   and synthetic rows (§26.90); no persistent application DB or owner/production database was used. The app role
   remains SELECT-only and the table is not a write path. B-073 also adds migration 0014 after a live test caught
   PostgreSQL's regex repetition-count limit in the initial envelope constraint. B-074 adds a read-only, display-
   authorized metadata lookup constrained by authenticated session tenant, selected partner and UUIDv4 bank-row ID
   (§26.91); it returns allowlisted non-ciphertext metadata and the ID from the matched database row. B-075 adds an
   all-row metadata list scoped to the session tenant and selected partner, retaining inactive rows and returning
   matched row IDs only (§26.92). B-076 adds an explicit display-only `BANKS` tab using the fixed list mask
   (§26.93); it queries the list service only when that tab is selected. No bank-record write service, database
   scan, scan-completeness proof, or verified global key retirement exists. Country validators remain unactivated
   in an application save path or connected to bank storage. B-074/B-075 do not retrieve encrypted account fields,
   decrypt, or execute audited reveal. B-076/B-081 expose no plaintext identifiers or maintenance controls. B-077 added empty/read-only browser checks;
   B-078 ran them on a disposable cluster. B-082 expanded and passed the live target with one strictly guarded
   synthetic encrypted fixture for both maintainer and display-only roles. Runtime reads used `cairn_app`; only the
   fixture insert used a separate privileged connection restricted to loopback `cairn_test` and the owned T992
   development tenant; cleanup was verified. Any future reveal still
   requires its own authorized and audited path and must resolve the row under tenant/partner/ID scope before using
   its database ID;
   UUID syntax alone does not establish row provenance. Then build bank and contact records through separate bounded
   backend, UI, access-control and test batches.
4. **Enterprise structure (SCR-012–025):** finish company/chart assignments, plants/storage locations,
   purchasing and sales organisations/assignments, channels/divisions/sales areas, and controlling-area
   assignments in dependency order.
5. **Financial configuration (SCR-026–040):** complete chart of accounts/G/L masters; fiscal-year and
   posting-period variants; currency/exchange/tax; payment methods and house banks; document types,
   tolerances, and account determination.
6. **Costing configuration (SCR-041–045):** cost centres and hierarchy, activity types and rates, and
   profit centres, including the relationships required by M1 posting and reporting.
7. **Remaining M1 masters (SCR-048–055):** material type/group and required material views; work
   centres, BOMs, routings; purchasing info records; sales pricing conditions; and MRP parameters.
   Confirm every page field/action in §24.1 rather than inferring unspecified rules.
8. **Master-data migration:** templates first, then the import session workbench with staging,
   shared validation, dry-run simulation, dependency-ordered posting, resumability, duplicate-file
   protection, and verification through normal services.

#### 25.5.3 M1c — Procure to Pay

Build and verify the §11.1 minimum golden flow in this order:

1. Purchase requisition create/change, approval, worklist, and conversion path.
2. Purchase order headers/lines/schedules, vendor/material defaults, release strategy, and document
   flow.
3. Goods receipt with stock/value, PO history, account determination, balanced FI posting, and
   reversal.
4. Supplier invoice verification and two-/three-way matching, including park/block/release paths.
5. GR/IR analysis and vendor open-item/balance tie-outs.
6. Payment proposal/review/execution, payment medium, bank statement import, and reconciliation/auto-
   clearing.
7. Procurement reports and the P2P end-to-end regression, including balances and accounting entries.

#### 25.5.4 M1d — MRP and Production

Build and verify the §11 / §12 / §13 production path in dependency order:

1. Planning data, BOM explosion, lead-time/lot-sizing rules, planning-file entries, dependent
   requirements, and exceptions.
2. Single-item then plant-wide MRP runs; planned orders and purchase requisitions; exception and
   stock/requirements displays.
3. Planned-order maintenance/conversion, production-order creation/status/release, component
   availability, and reservations.
4. Component goods issue, operation confirmations, finished-goods receipt, document flow, and
   reversal/status controls.
5. Standard cost estimate/release, actual-versus-target analysis, variance, settlement, and order
   close for the §13.2 worked case.
6. Golden-flow and focused performance tests proving demand → supply → production → settlement.

#### 25.5.5 M1e — Order to Cash, Record to Report, People, and Audit

Deliver the M1 baseline in this order; advanced depth remains in later phases:

1. **Credit (D-029):** credit-control assignments, customer credit master, exposure, order/delivery/GI
   checks, blocked-document worklist, authorised reason-coded release, and tests.
2. **Sales:** pricing/availability, enquiry/quotation/order rules in the agreed M1 cut, order release,
   and source-document flow.
3. **Delivery and billing:** delivery creation, picking/packing, goods issue, billing/AR open items,
   credit/debit memo and cancellation/reversal paths.
4. **Receivables:** incoming payment, allocation/clearing, dunning, customer balances/statements, and
   AR-to-GL tie-outs.
5. **Intercompany (D-028):** configured intercompany accounts, dual customer/vendor relationship,
   automatic mirror posting, linked flow, clearing, consistency tie-out, and elimination.
6. **R2R:** close cockpit and evidence; M1-period FX/accrual/carryforward/asset scope; trial balance,
   balance sheet, P&L and the agreed M1 reports with drill-through and reconciliations.
7. **People (R-09 acceptance):** dated employee/org/position/cost-centre data, pay components and
   configurable deductions; imported or configured payroll results, payroll posting, end-of-service
   provision, salary payment and personnel-cost reporting. Statutory payroll calculations remain out
   of scope (DV-001).
8. **Audit:** read-only scoped access, workspace/findings, document/change drill-through, tie-outs,
   number-range/period evidence, access/SoD review, and hash-manifested export.

#### 25.5.6 M1 cross-cutting release and sign-off

1. Reusable output definitions, reproducible PDF/artifact generation, archive, mail-server UI, and
   optional notifications that never gate workflow.
2. Worker/job execution and the job, lock, and message-monitoring needed by long-running flows.
3. Transactional/opening-data imports through normal document paths with idempotency and tie-outs.
4. Host deployment verification: Docker, Traefik/proxy, secrets, startup/migration order, pooling,
   access controls, and operational health.
5. Backup retention/WAL and a rehearsed restore; record measured results.
6. Full P2P, MRP/production, O2C, R2R, intercompany, People, audit, tenant-isolation, security, and
   conformance acceptance; owner walkthroughs and sign-off under §24.1.

#### 25.5.7 After M1 — agreed phase order

Do not start these until M1 sign-off. Follow §25.3: **Phase 2** MM purchasing/inventory depth; **Phase
3** SD depth; **Phase 4** FICO depth; **Phase 5** costing depth; **Phase 6** MRP enhancements;
**Phase 7** People depth; **Phase 8** audit depth; **Phase 9** Tier-3 items only on request, one
transaction at a time. Each phase gets its own dependency and page-gathering plan before implementation.

**Scope reconciliation:** §10 lists RFQ/quotation, source-list/quota, and physical-inventory/batch
items broadly, while §25.3 places much of that depth in Phase 2. The approved planning default is to
ship the §25.1 M1 end-to-end P2P path first and schedule the explicitly deferred depth in Phase 2; the
§10 items remain on the roadmap, not dropped. Baseline D-029 credit and D-028 intercompany stay in M1;
Phase 3 contains further SD/credit depth, not a removal of the M1 controls.

---

## §26 · Phase 1 screen inventory `DRAFT`

Screens are specified one at a time during the page-by-page cycle. This table is the work queue and
progress tracker. Each row is expanded into a full §24.2 specification when its turn comes.

### 26.1 Platform

| ID | Our screen name | Code | Aliases | Status |
|---|---|---|---|---|
| SCR-001 | Tenant administration | `CFG.PLT.CLIENT.DEFINE` | — | **BUILT** (list view) |
| SCR-002 | Tenant onboarding wizard | `CFG.PLT.CLIENT.ONBOARD` | — | **BUILT** (single step) |
| SCR-003 | User administration | `CFG.PLT.USER.CREATE` | SU01 | DRAFT |
| SCR-004 | Roles and capabilities | `CFG.PLT.ROLE.DEFINE` | PFCG | DRAFT |
| SCR-005 | Number range maintenance | `CFG.PLT.NUMBERRANGE.DEFINE` | SNRO | **BUILT · automated UI walkthrough passed · owner sign-off pending** |
| SCR-006 | Term registry search | `PLT.REGISTRY.SEARCH` | Command field | **BUILT** |
| SCR-007 | Configuration workbench | `CFG.WORKBENCH` | SPRO | **BUILT** (tree, progress, gating) |
| SCR-008 | Change document viewer | `AUDIT.TRAIL.DISPLAY` | — | DRAFT |
| SCR-009 | Job monitor | `PLT.JOB.MONITOR` | SM37 | DRAFT |
| SCR-010 | Lock monitor | `PLT.LOCK.MONITOR` | SM12 | DRAFT |
| SCR-011 | Message log | `PLT.MESSAGE.LOG` | SM13 | DRAFT |

### 26.2 Enterprise structure

| ID | Our screen name | Code | Aliases | Status |
|---|---|---|---|---|
| SCR-012 | Company code define | `CFG.ORG.COMPANYCODE.DEFINE` | OX02 | DRAFT |
| SCR-013 | Company code assign chart of accounts | `CFG.ORG.COMPANYCODE.ASSIGN_COA` | — | DRAFT |
| SCR-014 | Plant define | `CFG.ORG.PLANT.DEFINE` | OX10 | DRAFT |
| SCR-015 | Plant assign to company code | `CFG.ORG.PLANT.ASSIGN_COMPANY` | — | DRAFT |
| SCR-016 | Storage location define | `CFG.ORG.STORAGELOC.DEFINE` | OX09 | DRAFT |
| SCR-017 | Purchasing organisation define | `CFG.ORG.PURORG.DEFINE` | OX08 | DRAFT |
| SCR-018 | Purchasing organisation assign | `CFG.ORG.PURORG.ASSIGN_COMPANY` | — | DRAFT |
| SCR-019 | Purchasing group define | `CFG.PROC.PURGROUP.DEFINE` | — | DRAFT |
| SCR-020 | Sales organisation define | `CFG.ORG.SALESORG.DEFINE` | — | DRAFT |
| SCR-021 | Sales organisation assign | `CFG.ORG.SALESORG.ASSIGN_COMPANY` | — | DRAFT |
| SCR-022 | Distribution channel and division | `CFG.ORG.DISTCHANNEL.DEFINE` | — | DRAFT |
| SCR-023 | Sales area define | `CFG.ORG.SALESAREA.DEFINE` | — | DRAFT |
| SCR-024 | Controlling area define | `CFG.COST.CONTROLLINGAREA.DEFINE` | OKKP | DRAFT |
| SCR-025 | Controlling area assign | `CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY` | — | DRAFT |

### 26.3 Financial configuration

| ID | Our screen name | Code | Aliases | Status |
|---|---|---|---|---|
| SCR-026 | Chart of accounts define | `CFG.FIN.COA.DEFINE` | OB13 | DRAFT |
| SCR-027 | Chart of accounts copy | `CFG.FIN.COA.COPY` | OBY7 | DRAFT |
| SCR-028 | GL account create and manage | `CFG.FIN.GLACCOUNT.CREATE` | FS00 | DRAFT |
| SCR-029 | Fiscal year variant define | `CFG.FIN.FYV.DEFINE` | OB29 | DRAFT |
| SCR-030 | Fiscal year variant assign | `CFG.FIN.FYV.ASSIGN` | OB37 | DRAFT |
| SCR-031 | Posting period variant define | `CFG.FIN.PPV.DEFINE` | OBBO | DRAFT |
| SCR-032 | Posting period variant assign | `CFG.FIN.PPV.ASSIGN` | OBBP | DRAFT |
| SCR-033 | Currency and exchange rates | `CFG.FIN.EXRATE.MAINTAIN` | OB08 | DRAFT |
| SCR-034 | Tax codes | `CFG.FIN.TAXCODE.DEFINE` | FTXP | DRAFT |
| SCR-035 | Payment terms | `CFG.FIN.PAYTERMS.DEFINE` | OBB8 | **BUILT — backend and maintenance UI tested; owner sign-off pending** |
| SCR-036 | Payment methods | `CFG.FIN.PAYMENTMETHOD.DEFINE` | FBZP | Schema/RLS B-036, reads B-037, audited writes B-038, protected actions/capability B-039, activity/status lifecycle B-040, read-only route/list/detail/history B-041, create/change UI B-042, soft-retire UI B-043; dedicated browser target B-044 and isolated browser acceptance/cleanup B-045 passed (§26.62); DB acceptance passed; product-owner walkthrough/sign-off pending (§24.1) |
| SCR-037 | House banks and accounts | `CFG.FIN.HOUSEBANK.DEFINE` | FI12 | DRAFT |
| SCR-038 | Document types and number ranges | `CFG.FIN.DOCTYPE.DEFINE` | OBA7 | DRAFT |
| SCR-039 | Tolerances | `CFG.FIN.TOLERANCE.DEFINE` | OBA4 | DRAFT |
| SCR-040 | Account determination | `CFG.FIN.ACCTDET.DEFINE` | OBYC | DRAFT |
| SCR-041 | Cost centre create and manage | `COST.CENTER.CREATE` | KS01 | DRAFT |
| SCR-042 | Cost centre hierarchy | `COST.CENTER.HIERARCHY` | OKKP | DRAFT |
| SCR-043 | Activity type define | `CFG.COST.ACTIVITYTYPE.DEFINE` | KL01 | DRAFT |
| SCR-044 | Activity rate confirm | `COST.ACTIVITYRATE.CONFIRM` | KP26 | DRAFT |
| SCR-045 | Profit centre define | `COST.PROFITCENTER.CREATE` | KE51 | DRAFT |

### 26.4 Master data

| ID | Our screen name | Code | Aliases | Status |
|---|---|---|---|---|
| SCR-046 | Material type define | `CFG.INV.MATERIALTYPE.DEFINE` | OMS2 | DRAFT |
| SCR-047 | Material group define | `CFG.INV.MATERIALGROUP.DEFINE` | OMSF | DRAFT |
| SCR-048 | Material create and change | `INV.MATERIAL.CREATE` | MM01 / MM02 / MM03 | **IN BUILD — four implemented views UI verified; other views/imports and owner sign-off remain pending** |
| SCR-049 | Business partner create and change | `FND.PARTNER.CREATE` | BP / XK01 / XD01 | **IN BUILD — general, supplier/customer company-code, supplier purchasing and customer sales-area segments implemented; payment/dunning codes added; read-only masked bank metadata tab implemented (B-076); bank/contact maintenance and owner screen sign-off remain pending** |
| SCR-050 | Work centre create | `PROD.WORKCENTER.CREATE` | CR01 | DRAFT |
| SCR-051 | BOM create and change | `PROD.BOM.CREATE` | CS01 | DRAFT |
| SCR-052 | Routing create and change | `PROD.ROUTING.CREATE` | CA01 | DRAFT |
| SCR-053 | Purchasing info record | `PROC.INFO.RECORD.MAINTAIN` | ME11 | DRAFT |
| SCR-054 | Pricing conditions | `CFG.SALES.CONDITION.MAINTAIN` | VK11 | DRAFT |
| SCR-055 | MRP parameters per material | `PROD.MRP.SETTINGS` | MM02 | DRAFT |

### 26.5 Data migration

| ID | Our screen name | Code | Aliases | Status |
|---|---|---|---|---|
| SCR-056 | Import template download | `CFG.IMPORT.TEMPLATE.DEFINE` | LSMW | DRAFT |
| SCR-057 | Import session workbench | `FND.IMPORT.SESSION` | LSMW / LTMC | DRAFT |

### 26.6 Cross-company, credit, notification & mail (added v0.2)

| ID | Our screen name | Code | Aliases | Status |
|---|---|---|---|---|
| SCR-058 | Intercompany account configuration | `CFG.FIN.INTERCOMPANY.DEFINE` | OBYA | DRAFT |
| SCR-059 | Credit control area and credit master | `CFG.FIN.CREDIT.DEFINE` | OBA3 / FD32 | DRAFT |
| SCR-060 | Credit exposure and blocked documents | `FIN.CREDIT.MONITOR` | F.31 / VKM3 | DRAFT |
| SCR-061 | Consolidation with elimination | `FIN.RPT.CONSOLIDATE` | — | DRAFT |
| SCR-062 | Mail server configuration | `CFG.PLT.MAIL.DEFINE` | SCOT | DRAFT |
| SCR-063 | Notification preferences | `PLT.NOTIFY.PREFS` | — | DRAFT |

**Note on the new IDs:** these were added after the Phase 1 inventory was first written, because
decisions D-028, D-029, D-032 and D-033 introduced them. IDs are never reused or renumbered;
new work appends (§0.1).

**Parallel track:** the reference-system identifiers in the alias column above are the initial
registry seed. They are search metadata only and never appear in the product's own naming (R-01).


### 26.7 Implemented page contracts and verification (2026-10-09)

**SCR-005 — Number ranges (`/config/number-ranges`).** Define/change interval: business object,
company scope, range key, fiscal year (`0` = all years), first/last number, display prefix/width/style,
active/blocked, and mandatory maintenance reason. Last issued is read-only. Existing lower limits
and presentation are immutable; the upper limit can change but never fall below the high-water mark.
No delete/reset/external/buffered controls are offered. New definitions lock the whole object/scope
before checking overlap; editing additionally locks the counter row against concurrent allocation.
Blocked intervals still reserve their numbers. Numeric inputs are safe integers; padding fits the
upper bound. History shows field-level before/after values, actor, reason and control flags; allocation
evidence records both the document year and the interval year, with a link to the consuming document.
The accounting readiness panel uses the allocator's resolution rules, names each missing/blocked
company/range, and completes the workbench activity only when all active companies have usable
assigned accounting intervals. **Customer-created tenants have no FI intervals** (D-043); their
10 operational intervals remain provisioned. The development fixture explicitly configures one
accounting interval through the maintenance service (11 total), never by resetting a live counter.

**Write-boundary/security findings:** D-045–D-048 above. Onboarding now marks the tenant, roles and
first-user steps complete, since those objects already exist; migration 9005 repairs older checklists.
The journal action derives fiscal position from the company's actual variant, local currency from
the company, and actor/tenant from the session. This first form intentionally refuses foreign currency
with an explicit remedy until exchange-rate maintenance is built; it no longer silently treats a
foreign document currency as local currency. Journal identity/presentation split is D-046.

**Automated acceptance:** TypeScript clean; **85/85** database/action tests (25 range maintenance,
7 write-boundary tests, 1 extra wildcard-suffix regression); IP lint clean; both HTTP smoke suites pass;
production `npm run build` succeeds. `npm run smoke:browser` uses Chromium and creates a fresh
development fixture through the onboarding UI, signs in, confirms no hidden FI ranges, creates the
accounting interval through the actual form/action, verifies checklist completion, posts in KWD as
the real administrator while deliberately submitting a forged tenant, reads the document and allocation
history back, rejects an unbalanced posting without consuming a number, and proves the posting page
requires sign-in. Test fixtures alone are cascaded away afterwards; the owner's tenant is untouched.
**This is automated verification, not a claim of owner sign-off.**

**Operating notes:** The 2 GB sandbox cannot reliably run a webpack dev server plus Chromium once
several pages have compiled (observed RSS >1.2 GB and navigation stalls). Use a short production build
and `npm run start` for the live preview/browser acceptance; stop the server before rebuilding to keep
peak memory bounded. `next.config.ts` limits build parallelism and enables webpack memory optimisation.
Preview development origins are allowed only when `CAIRN_ENV=development`; production action origin
is `cairn.deepakpt.com`. After a sandbox rebuild: install PostgreSQL 17 and `npm ci`, provision the two
roles (`cairn` owner/admin BYPASSRLS; `cairn_app` NOSUPERUSER NOBYPASSRLS). **Preserved data now has a
checkpoint (§26.8): restore its database dump rather than resetting or reconstructing it from seed.**
`npm run bootstrap:reset` is only for a deliberately empty, disposable database with no preserved data;
it is not a recovery step for this project. For the saved database, restore the dump, apply only new
migrations/non-destructive bootstrap steps if needed, build, and start on `0.0.0.0:3000`. Browser acceptance
additionally needs `npx playwright install --with-deps chromium`. Dependency folders, the PostgreSQL
cluster and `.next` are excluded from snapshots; source and migrations persist.

**Current boundary:** Foundation configuration is still IN BUILD, not M1b complete: material/partner,
work centre/BOM/routing, tax/payment/account-determination, exchange-rate screens and master-data imports
remain. The material four-view source/backend is now held at the checkpoint below; its UI release is
not yet verified. B-002 Basic Data publication/verification is complete (§26.10); the next batch is B-003 Purchasing only in §25.4.
R-08 page walkthroughs and owner sign-off remain open.


### 26.8 Preserved checkpoint after the interrupted material stage `IN BUILD`

**Owner instruction (2026-10-09):** keep all work/data to this point, and reduce future changes so each
can finish in 15 minutes. This checkpoint performs no migrations, reseeding, feature changes, resets
or deletes. It records the partial stage honestly and leaves the currently running verified preview
in place.

**Retained source/backend:** `src/modules/inventory/{schema,constants,materials,standard-config,
development-fixture}.ts`, `src/app/inventory/materials/{page,MaterialForm,actions}.tsx/ts`, the schema
root registration, migrations `0002_material_master.sql` and `9006_material_master_policies.sql`,
capability/registry/locale additions, development sample masters, and extended tests/browser script.
Eight new tenant tables have forced RLS and tenant-cascade references: material type/group,
valuation class, MRP controller, material, material plant, material valuation and planning file.
Basic, purchasing, MRP and accounting views are independently maintainable; no executable MRP,
production/sales/storage/forecast/quality/warehouse views or unit-conversion maintenance is claimed.
The material operational gate refuses incomplete/blocked records. Master maintenance cannot alter
inventory quantities or book value, and changing valuation settings with stock requires a separate
balanced revaluation process. Separate finance authority gates price reads, writes and price history.
Stale edits are refused using version checks; no-op saves avoid audit noise. Test cleanup was also
restricted to identifiable development fixtures so it cannot silently remove a similarly keyed
non-fixture tenant. Session/status context and working-screen launchpad links were updated in source.

**Last completed verification before interruption:** TypeScript clean, IP lint clean, **110/110**
automated tests (23 material tests and 9 action-boundary tests included). The number-range onboarding
→ posting browser flow had already passed on the prior production build. The expanded browser script
for material views/financial-read denial was written but **not run successfully yet**; the source
containing the material pages has **not been production-built/released yet**. The live port-3000
preview still serves the last verified foundation/number-range build (`/signin` rechecked 200 during
this checkpoint). Material route publication, browser acceptance and any small blocking fixes are
B-001–B-005, not an assumed completed deliverable. Owner sign-off is still pending.

**Persistent backup:** `/home/user/cairn/checkpoints/2026-10-09_0127_UTC/`

| Artifact | Purpose |
|---|---|
| `database.dump` | Full PostgreSQL custom-format schema/data dump, including migration history and application identities/audit records; owner directives omitted for restore portability |
| `source.tar.gz` | Current source, migrations, tests, package lock and this master log; generated dependencies/build/cache files and local credentials excluded |
| `data-counts.csv` | Read-only database checkpoint counts |
| `SHA256SUMS` | Integrity checks for the three checkpoint artifacts |

Database snapshot verified readable with `pg_restore --list`; this is **not** a claim that a full
restore rehearsal has been completed. Snapshot counts: **1 tenant, 1 user, 74 G/L accounts, 11 number
ranges, 1 posted journal, 3 materials, 3 plant segments, 3 valuations, 3 planning-file rows, 15 change
documents and 10 applied migrations**. The three development masters (`RAW-STEEL`, `PACK-CARTON`,
`FG-BRACKET`) remain intact; no stock was fabricated. Backups contain private business/identity data
and stay in the private workspace, not source control or public assets. The database dump is saved
under a persisted workspace path because the running PostgreSQL installation itself is excluded
from workspace snapshots. Do not use a reset/seed reconstruction as a substitute for this backup.

For a sandbox rebuild: recreate PostgreSQL and the documented separate roles, create an empty target
database, then restore `database.dump` with `pg_restore --no-owner` using the owning/admin connection.
Restore privileges rely on the `cairn_app` role existing. The source archive excludes local environment
credentials; keep/re-provide the workspace environment configuration separately. Only after restoring
should new migrations and non-destructive checks run. Do not restore destructively over a newer live
database without an explicit recovery decision and a fresh checkpoint.


### 26.9 B-001 — independently runnable browser targets `COMPLETE`

**Scope:** test harness only. No ERP service, page, database schema, applied migration or seed was
changed. The existing live foundation preview remains running; material pages still await B-002's
build/publication and subsequent view-specific acceptance. This batch started at 01:36:58 UTC and
finished within the owner's 15-minute budget.

`scripts/browser-smoke.ts` now runs **one** named target per
invocation; no-argument execution defaults to the previously verified foundation regression, not a
combined all-module walk. `scripts/browser-smoke/targets.ts` contains pure target/argument/fixture
validation, while `scripts/browser-smoke/checks.ts` contains the extracted existing UI interactions.
The four material targets each create their own prerequisite Basic view through the UI; purchasing,
MRP and valuation do not depend on running the other plant views first. Each named target has its own
reserved T### key; the guard requires the exact key, fixture name and development flag before any
stale-fixture cleanup. Business records are created through UI actions. The already-existing warehouse
identity fixture remains SQL-only because the user-administration screen is pending, and is confined
to the valuation case. Never run two invocations of the same target concurrently.

| Command | Single target / boundary |
|---|---|
| `npm run smoke:browser:foundation` | Onboard, configure numbering, post/read a journal, reject unbalanced input and verify evidence |
| `npm run smoke:browser:material-basic` | Basic material create/read only |
| `npm run smoke:browser:material-purchasing` | Purchasing view, with fresh UI-created Basic prerequisite |
| `npm run smoke:browser:material-mrp` | Planning settings/net-change flag, with fresh UI-created Basic prerequisite |
| `npm run smoke:browser:material-valuation` | Valuation/currency/history and financial price-read denial, with fresh Basic prerequisite |
| `npm run smoke:browser -- --list` | Lists targets without opening the browser/database |
| `npm run test:browser-harness` | Pure argument/fixture-guard tests; dedicated config has no database setup or purge |

Each browser run has a 120-second work deadline (raced against the complete target, including database
assertions), short per-action/navigation timeouts, bounded failure diagnostics and guarded cleanup.
The deadline fails the target instead of starting another one. TypeScript and IP lint pass; **23/23**
focused harness tests pass. The final foundation browser target passed in about **4 seconds** against
the existing production preview, covering the actual server actions, forged-tenant refusal, no number
consumption on unbalanced posting, allocation/change drill-through and anonymous-page refusal. No
other target ran. **Material targets remain unexecuted**, pending the rebuilt material routes.

The before/after preserved database counts match the B-000 snapshot: 1 tenant/user/journal, 74 G/L
accounts, 11 ranges, 3 material/plant/valuation/planning rows each, 15 change documents and 10 applied
migrations. Only the specifically owned temporary T998 browser fixture was created and removed; no
owner/development-business data was reset, reseeded or removed. The last full ERP suite remains the
prior **110/110** run; do not claim a new combined full-suite total from this focused check.

B-001 backup: `checkpoints/2026-10-09_0145_UTC/` contains a fresh `database.dump`, updated
`source.tar.gz`, `data-counts.csv` and `SHA256SUMS`. The B-000 backup is retained unchanged. Custom
dump readability and artifact checksums are checked; a full restore rehearsal is still a separate
pending task. The next batch is **B-002 — publish and verify Basic data only**.


### 26.10 B-002 — Material Basic Data published and verified `COMPLETE`

**Scope:** publish the retained material source and verify **Basic Data only**. The existing production
preview was stopped before each short build to stay within sandbox memory limits. The corrected app
now runs on `0.0.0.0:3000`, process **`cairn-0048add8`**, production build
**`nWUJxBkxB676o5vBVFqgp`**. This is the sandbox preview, not deployment at the production hostname.
The material route, launchpad links and session-derived header/footer are now live. Other retained
views are present in this build but their browser walkthroughs are **still pending**; no full material
conformance, executable MRP, P2P or end-to-end manufactured flow is claimed.

**Verified through the real browser and server action** (`npm run smoke:browser:material-basic`,
final passing run ~4.6 seconds):

- Fresh tenant/administrator created through onboarding; no hidden accounting interval.
- Complete Basic material created and read back, with no plant/valuation segments fabricated.
- Incomplete Basic data saved with a missing description/base unit. Forged tenant `0100` and actor
  `FORGED` fields are ignored; the session tenant/user remain authoritative.
- Completion promotes **INCOMPLETE → CREATED**. An unchanged resave retains version 2 and status,
  rather than changing data or losing the selected unit.
- Exact weights `3.500` / `3.250` KG maintained, promoting **CREATED → MAINTAINED**, version 3.
- Change history displays the real actor, completion and weight-maintenance reasons, before/after
  values and control-change flags. The footer displays the signed-in fixture client/user.
- Material-list search works; **Copy basic data** starts with an empty new number and copies basic
  values only, never creating plant or valuation records.
- Anonymous access redirects to sign-in; no browser runtime errors. Other material targets did not run.

**Findings and corrections:**

| Finding | Result |
|---|---|
| FND-001 — committed form defaults could erase selected units on resave | Real product defect. React action reset restored the uncontrolled select's previous blank default even after the saved record had a base unit. `MaterialForm` now keys its inner form by the committed view version, remounting fields from the fresh saved snapshot. The same Basic browser flow now proves completion followed by unchanged resave preserves unit/status/version. This corrects the shared form mechanism; other views still need their scheduled checks. |
| FND-002 — description locator also matched HTML metadata | Test defect, not a service defect. Browser description inputs are now explicitly scoped to `input[name="description"]`. |
| FND-003 — SPA navigation allowed typing into the departing form | Test synchronisation defect. Create-to-detail/copy transitions now wait for the appropriate readonly/editable material-number field before further input. No arbitrary sleeps or enlarged timeouts. |

**Verification:** corrected production build passed (~27.5 seconds), TypeScript clean, IP lint clean
(102 scanned files), **133/133 automated tests across 9 files passed** in ~11.2 seconds, and the focused
Basic browser target passed. The saved full-page history screenshot was inspected: Basic fields/status,
exact weights, explicit pending views, readable audit evidence and signed-in footer are present.
This is automated verification, **not owner sign-off**. Browser acceptance for Purchasing/MRP/Valuation
is B-003/B-004/B-005, not implicitly granted by compilation or service tests.

**Preservation:** no migration, database reset or reseed. Only identified browser/unit fixtures were
created and cleaned. Preserved database counts exactly match before/after: 1 tenant, 1 user, 74 G/L
accounts, 11 ranges, 1 posted journal, 3 materials/plant segments/valuations/planning rows each,
15 change documents and 10 applied migrations. Existing development samples and stock were not edited.

**Checkpoint:** `checkpoints/2026-10-09_0219_UTC/` contains `database.dump`, `source.tar.gz`,
`data-counts.csv`, `material-basic-history-review.png` and `SHA256SUMS`; earlier checkpoints remain.
Dump readability and artifact checksums are verified, not a substitute for the pending restore rehearsal.
Batch started at 02:07:39 UTC and completed within the 15-minute cap; no additional feature batch started.
**Next: B-003 — Purchasing view verification only.**


### 26.11 GitHub source publication `COMPLETE`

**Owner request:** publish the current Cairn source to
[deepakpt2/cairn-erp](https://github.com/deepakpt2/cairn-erp). This publication-only batch interrupts
no ERP milestone; **B-003 Purchasing remains next**. No application/database feature change,
migration, reset or reseed is part of this batch.

**Repository preflight:** public repository, default branch `main`; its pre-existing commit
`33f39ff0764040ea7d9af8192992321affacc9ac` contains a GPL v3 `LICENSE`. That license and history are
preserved, with normal fast-forward commits only. Incomplete local Git metadata was repaired and
`main` tracks `origin/main`. The credential-free origin is `https://github.com/deepakpt2/cairn-erp.git`.
Actual credentials are never saved in `.git/config`, a credential store, source, environment templates,
backups or this project log. The owner should revoke/rotate the one-time token after use because it
was shared in chat. The GitHub connector is unsupported in this session; publication uses Git/HTTPS.

**Public-source boundary:** `.gitignore` now excludes `.env` and other real environment files,
`checkpoints/`, `.arena/`, database dumps, private credentials, generated builds and dependencies.
`.env.example` is deliberately safe: documented development defaults and a session-secret placeholder,
not the real local secret. SQL migrations, source, tests, package lock and this single master log are
included; current database records, captures and restore backups stay private/local. The existing
license is not replaced. Last application verification remains B-002's **133/133 tests and Basic-only
browser acceptance**; this publication is not production deployment or verification of pending views.

**Publication result:** Verified normal fast-forward push to `main`. Source snapshot commit
`67fd7dbdd9eeb89dba5abd172478becf7e508afb` is based on the existing license commit, preserving repository history.
The remote branch was checked against that exact source commit. This confirmation is committed as
an additional documentation-only follow-up; no force push, history rewrite or credential storage.
The tracked tree contains 118 files including the original license; staged-path and credential-pattern
checks passed. Existing business data and local backups were not uploaded or modified. One existing
extra blank line at EOF in the number formatter was removed for clean patch whitespace; no behaviour
changed. Source-only backup is saved under `checkpoints/2026-10-09_1541_UTC/`; prior database backups
remain private and unchanged. The application is still IN BUILD with Basic Data verified and the
remaining material browser targets/P2P/manufacturing flow pending. **Next: B-003 Purchasing only.**


### 26.12 Private local repository credentials `COMPLETE · D-052`

The owner explicitly requested local persistence while deferring token rotation. `.env.local` now
contains **`GITHUB_REPO_URL`** and **`GITHUB_PAT`**; the value of the credential is intentionally not
included here. Existing local variables, if any, are preserved. The file was written atomically with
owner-only **0600** permissions. It uses server/private names, never the client-exposed `NEXT_PUBLIC_`
prefix. This is a plaintext local environment file protected by permissions, not an encrypted vault.

Verified: `.gitignore` already excludes the file via `.env.*` (and the explicit local-env rule);
`git check-ignore` confirms it, `git ls-files` confirms it is untracked, and a check of committed source
found no copy of the credential. No token was printed, committed or pushed; no GitHub API/push,
credential rotation, application change, migration or database operation was performed. The secret
must stay out of source archives and future screenshots/logging. No copy is added to `.env.example`.
This private setup updates the local project log only; the public repository remains at the previous
verified publication commit until another explicitly requested source push. **B-003 Purchasing remains
next**; this is a separate short configuration batch, not continuation into ERP development.


### 26.13 Core Docker packaging `COMPLETE — host deployment unverified`

**Owner finding:** Docker/Compose files were missing from the published checkpoint. They had been
planned in §22 but not implemented. This bounded batch adds the **current working app's core**:

| File | Purpose |
|---|---|
| `Dockerfile` | Node 22 multi-stage dependencies, one-shot operations and non-root standalone app targets |
| `.dockerignore` | Excludes actual environment files (including `.env.local` and its Git credential), checkpoints, captures, dependencies, generated builds and private data |
| `docker-compose.yml` | PostgreSQL 17 → healthy DB → migration/reference job → app; persistent DB volume, private DB network and existing external Traefik network |
| `.env.example` | Default deployment template with empty required secrets; copy to ignored `.env` only for a new installation, never overwrite existing secrets |
| `docker/postgres/10-app-role.sh` | Initializes restricted `cairn_app` only for an empty PostgreSQL volume; SQL-bound password input, no schema/data reset |
| `next.config.ts` | Adds standalone output and explicit current-project tracing root, preventing nested-workspace output paths/outside-context tracing |

**Traefik:** no Traefik container, network **`proxy`**, entrypoint **`web`**, host
**`cairn.deepakpt.com`**, backend port 3000, no certresolver (upstream TLS). Database has no published
host port. App receives only the restricted database URL; migration receives the separate elevated
owner URL and runs existing immutable migrations plus global/reference seeds. It does **not** run
`bootstrap:reset`, `dev:tenant`, opening-stock seeding or automatic customer configuration. The named
PostgreSQL volume is retained across normal redeploys. Initialization scripts run only on an empty
volume; changing `.env` passwords later does not update passwords inside an existing database.
The official PostgreSQL owner is elevated; the web role explicitly cannot be superuser or bypass RLS.

**Setup on the Docker host:**

```sh
if [ ! -f .env ]; then cp .env.example .env; fi
chmod 600 .env
# Run this THREE times; put different results in the two DB password and session-secret fields:
openssl rand -hex 32
# Keep CAIRN_HOST=cairn.deepakpt.com; the existing action-origin configuration matches that host.
docker network inspect proxy
# Quiet validation avoids printing expanded secrets:
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs migrate app
```

Use current Docker Compose (v2+ syntax); the `proxy` network must already belong to the existing
Traefik setup. Do not add a certresolver or a second proxy container. Do not delete the database volume
to repair configuration; backup/restore is a separate deliberate recovery operation. Database passwords
must be URL-safe (letters/digits/underscore/hyphen; generated hex is recommended), since Compose embeds
them in connection URLs. Templates have empty values, so missing required secrets fail configuration.
A different hostname also needs the action-origin configuration changed; it is not just a label edit.

**Verified here:** Compose `config --quiet` passed using checksum-verified official CLI **v5.6.0**
and dummy validation values; YAML/security/startup invariants and shell syntax pass. The standalone
production build passed in a secret-free Docker-equivalent context, including TypeScript/framework
checks, and produced `server.js` at the required path. Its sign-in page returned HTTP 200 and expected
content; the temporary packaging-check process was stopped. No environment files or backups appeared
in the standalone artifact. The 23 pure harness tests and IP lint pass. The first nested-context build
exposed an inferred tracing-root path; explicit `outputFileTracingRoot` fixes it.

**Not verified:** this sandbox has **no Docker engine**, so no image-layer build, fresh PostgreSQL
container/role initialization, full Compose boot, database-backed request, or actual Traefik-host/TLS
reachability is claimed. The temporary standalone check had no PostgreSQL; database-dependent preview
requests reported connection refusal, as expected. The present image health check covers web-server
sign-in response; deeper database-backed readiness/hardening belongs in the Docker-host validation.
Last full ERP suite remains B-002's **133/133**; it was not rerun against a database in this packaging
batch. Worker, PgBouncer, Dragonfly, scheduled encrypted dumps/WAL/retention and restore rehearsal are
still pending §22 requirements. This is **not** final production/M1 sign-off.

**Data/security:** no live database was reset, migrated, seeded or edited in this sandbox. Prior private
backups remain untouched. `.env.local` stays ignored and outside image context; only the safe Docker
template is published. **Publication result:** Normal fast-forward source push verified on `main`, deployment commit
`d004b2cbcf32709983073d43d3e9a94b67d74ad5`; this confirmation is a documentation-only follow-up. No force push or
credential publication. The
ERP queue remains **B-003 Purchasing**; the next deployment slice should validate this core stack on
a Docker-capable host before adding other services. Source checkpoint: `checkpoints/2026-10-09_2204_UTC/`.


### 26.14 Database authentication failure — in-place recovery `FIX PUBLISHED / HOST VERIFICATION PENDING`

**Observed on owner host:** app starts, then PostgreSQL rejects user `cairn_app` with SQLSTATE **28P01**.
Next.js "Ready" confirms the server process, not successful database authentication. The supplied log
proves login rejection, not which configuration/initialization path caused it. Likely causes include
an existing volume retaining a different role password, a differently resolved environment value, or
the initialization script not creating the role. Source inspection confirmed a relevant legacy path:
`9000_policies.sql` creates a missing role with `cairn_app_dev`. It does not change an existing role's
password. That applied migration is **not edited** or replayed destructively.

**Correction:** `scripts/sync-db-app-role.ts` / `npm run db:sync-role` now precedes Docker migrations.
It requires explicit application/owner URLs, the `cairn_app` runtime username and matching database
names; reads the password from the runtime URL; connects through the owner; checks role-management
permission; uses PostgreSQL `format` with bound text values to create/alter the managed role safely;
enforces NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE/NOINHERIT; closes connections; and verifies
restricted authentication with the application URL. No tenant, stock, ledger or master-data table
is written. Owner authentication failure stops startup; raw URLs/passwords are not printed.

**Existing-volume repair:** `docker/postgres/sync-credentials.sh` reads the current database container's
configured secrets and uses its local admin socket. It aligns owner/app role passwords in a single
transaction, creating a missing restricted app role if necessary. It never resets/deletes the database,
volume, schema, tenant or business documents. This recovery assumes the official container's local
owner socket authentication; custom hardened socket-auth setups need their existing admin connection.
Changing owner credentials in environment alone cannot authorize the migration job against an old
stored password, hence the explicit repair step.

**Owner-host commands (use the SAME env file used for deployment):**

```sh
git pull
# Recreate if configuration changed; retain the existing PostgreSQL data volume:
docker compose up -d db
# Read current container secrets without echoing them or putting a password in shell history:
docker compose exec -T db sh -s < docker/postgres/sync-credentials.sh
# Rebuild the new operations entrypoint and recreate app/migration processes:
docker compose up -d --build --force-recreate migrate app
docker compose logs --tail=50 migrate app
```

Project `.env` is now the default (D-055); an explicitly selected alternate file must be used consistently. Do not send secret values or expanded
Compose/connection configuration. Do not delete the volume or run reset/bootstrap-reset. App recreation
also clears the cached failed role-check/pool and loads the currently configured password; simple
`restart` does not update changed container environment. A repaired missing role still receives schema
permissions through the normal migration path; if roles were manually deleted after migrations,
additional grant recovery is a distinct reviewed operation, not permission widening in this script.

**Verification:** 12 mocked/pure credential tests + 23 existing harness tests = **35/35 focused tests**
passed; TypeScript, IP lint and the standalone production build passed. CLI missing-configuration guard
was exercised: fails non-zero before any connection, with values withheld. Shell syntax passes. Tests
cover existing/missing roles, no development password fallback, safe formatting, closed connections,
privilege refusal, runtime elevation refusal, explicit URLs and matching databases. The initial
incorrect test mutated an owner username instead of database path; the assertion setup was corrected.
No live host/container database was accessed here; successful owner-host repair remains **unverified**
until the owner runs these commands. The last complete ERP database suite remains 133/133 from B-002.
Database-aware application readiness remains a separate follow-up (current image health checks sign-in).
No private environment/credential files are published. **Publication result:** Normal fast-forward source push verified, fix commit
`eb9df4b000fd2309a6b12e02909da1e1a8956003`; this confirmation is a documentation-only follow-up. Host repair remains
pending the owner commands. Source checkpoint: `checkpoints/2026-10-09_2241_UTC/`. ERP feature queue
remains B-003 Purchasing; this is a bounded deployment-authentication fix only.


### 26.15 Default `.env` deployment clarification `COMPLETE / HOST REPAIR PENDING`

The owner clarified that deployment now uses `.env` and requests plain Docker Compose commands.
**That filename is supported automatically.** Merely renaming a configuration file does not alter
passwords stored in PostgreSQL or values in an already-created container. The repeated log matches the
previous error, so fresh failure after rebuilding is not yet independently established. A mismatch can
remain when repair used one file while app creation used another, or a container was only restarted.

**Changes:** default deployment template is now `.env.example` with the required keys
`CAIRN_OWNER_DB_PASSWORD`, `CAIRN_APP_DB_PASSWORD`, `SESSION_SECRET` and the agreed hostname. The former
local development template is retained separately as `.env.development.example`. `.env.docker.example`
is a legacy optional template, not required. Compose hints/runbooks now refer to `.env` and plain
commands. No `env_file: .env` block is added: Compose interpolation and explicit service whitelists
keep owner/Git credentials out of the web container. Existing `.env`/`.env.local` values are untouched;
private permissions were reasserted as 0600 and tracked shell executable modes restored after workspace
snapshot reconstruction.

**Owner host — keep current secrets and repair in place:**

```sh
git pull
# Keep your configured .env. Do NOT copy a blank example over an existing file.
chmod 600 .env
docker compose config --quiet
docker compose up -d db
docker compose exec -T db sh -s < docker/postgres/sync-credentials.sh
docker compose up -d --build --force-recreate migrate app
# Refresh the application, then inspect fresh logs rather than old startup output:
docker compose logs --since=5m --tail=80 migrate app
```

Make sure `.env` has all three nonempty required secret keys above; do not send their values. Database
passwords must be URL-safe (hex recommended). Shell-exported values can override `.env`; if overriding
these keys intentionally, use the same effective configuration for every command. No database-volume
removal, schema reset, stock/ledger edit or actual host connection is part of this clarification.

**Verified:** official checksum-verified Compose CLI v5.6.0 loaded an isolated project `.env` with
**no `--env-file` flag**; `config --quiet` passed. Its resolved dummy configuration has matching
DB/application/migration passwords, a restricted application URL, no owner URL/Git credential in the
app and the same Traefik/private-network rules. Shell syntax and patch whitespace pass. Configuration
checks use dummy values only; the host's real login remains unverified until the owner runs the repair.
Prior credential logic/build/tests remain as §26.14; this is a configuration/documentation change only.
**Publication result:** Normal fast-forward source push verified, default-env commit
`8b659899b53163bdf5f092d1231663e986f39e3f`; this confirmation is a documentation-only follow-up. Host
authentication/repair remains pending owner execution. Source checkpoint:
`checkpoints/2026-10-10_0311_UTC/`. No new ERP feature batch has started.


### 26.16 Migration login succeeds but app login fails `DIAGNOSIS / HOST EVIDENCE PENDING`

**New owner evidence:** fresh logs show `db:sync-role` successfully authenticating with `cairn_app`,
then 10 migrations skipped and global/reference seeds completed; the app still reports 28P01. This
establishes successful runtime-role authentication **from the migration container to its target**.
It does not establish that the app has the same actual container configuration, resolves the same
server, or retried after a previously cached failed check. Further password resets are not justified
without distinguishing these paths. The next step is read-only comparison, not schema/data repair.

**Diagnostic delivered:** `scripts/diagnose-docker-db.py` uses host Python 3 and Docker CLI. It reads
actual app/migrate/db container inspection into memory only and outputs safe booleans/metadata:
exact URL/password equality, app password vs current DB-container setting, app user/host/database,
app start time, migration exit status, expected DB IPs and app-side DNS resolution. If the traced app
image has a separately requireable PostgreSQL driver, it additionally probes restricted login with
SELECT-only server identity; otherwise it reports that the direct probe is unavailable. Never prints
raw environment/inspection, passwords, hashes, connection strings, SQL error detail or private tokens.
No image/server/database/credential configuration is changed by this diagnostic.

```sh
git pull
python3 scripts/diagnose-docker-db.py
```

Paste only this redacted output. Run in the repo directory with the same plain Compose/default `.env`
setup. A short `docker compose restart app` may clear a prior process-cached failure, but is not a fix
for different connection settings or a wrong target; do not rotate passwords again or delete volumes.

**Interpretation:** a URL/password mismatch points to stale or overridden container settings. DNS
addresses outside the expected Cairn database indicate wrong-target resolution. The generic hostname
`db` is a possible cross-network collision because app joins the shared `proxy` network while migrate
joins only the private network; this is a hypothesis, not a confirmed host finding. Equal settings
and correct DNS with successful direct login would instead focus investigation on app process/cache
or image behavior. Do not claim a root cause before host results are available.

**Verified here:** five pure Python redaction/comparison tests pass, and Python syntax compilation and
patch whitespace checks pass. The diagnostic was not run on the owner's Docker host; this sandbox
has no Docker engine. No ERP feature, database, credential rotation or deployment configuration change
is performed in this batch. Actual auth resolution remains pending host output. **Publication result:**
Normal fast-forward source push verified, diagnostic commit `0c09e30ec0307ceabcb9d6c99cdde8a9ebbe461f`;
this confirmation is a documentation-only follow-up. Host diagnostic remains pending. Source checkpoint:
`checkpoints/2026-10-10_0326_UTC/`. The ERP feature queue remains B-003 Purchasing.


### 26.17 Confirmed wrong database DNS target `FIX PUBLISHED / HOST VERIFICATION PENDING`

**Owner diagnostic evidence:** actual app/migrate URLs and decoded passwords match; app password
matches the DB container setting; migration exits 0. Intended Cairn DB address is **172.31.0.2**, while
app-side `db` resolves **172.18.0.9**, and `dns_resolves_only_expected_database` is **false**. The app
joins both `cairn_cairn_internal` and the shared `proxy` network; migration joins the private network
only. This confirms the generic hostname reaches the wrong target from the app. The diagnostic's
direct-login probe is unavailable because the driver is bundled, but the DNS mismatch itself is clear.
The earlier stored-password hypothesis is superseded for this reported host failure; do not reset
passwords again or widen permissions.

**Correction:** `docker-compose.yml` adds private DB alias **`cairn-postgres`** and updates all three
application/migration connection URL hosts to it. Database service name `db`, persistent `postgres_data`
volume, role names, secrets, Traefik `proxy`/`web`, upstream TLS and app ports remain unchanged. Database
still has no proxy attachment or public port. No fixed IP is used—container IPs can change normally.
This changes only routing/container configuration, not images, schema, credentials or business data.

**Owner host:**

```sh
git pull
docker compose config --quiet
# Apply the DB's private alias, retaining the data volume:
docker compose up -d db
# Load the new host into both containers and clear previous DNS/connection state:
docker compose up -d --force-recreate migrate app
python3 scripts/diagnose-docker-db.py
# Refresh the site, then inspect fresh application/migration output:
docker compose logs --since=5m --tail=80 migrate app
```

No image rebuild is required for this Compose-only change. Do not run the password-repair script,
reset/bootstrap-reset, delete data volumes or hardcode either diagnostic IP. Expected diagnostic:
`application_host` is `cairn-postgres`; its `resolved_addresses` correspond to the reported current
`expected_db_addresses`; `dns_resolves_only_expected_database` is **true**. Verify page access and new
logs after updating; successful host remediation is not yet claimed.

**Verified here:** official Compose CLI config/quiet and resolved JSON checks pass: private alias exists,
all three URL hosts match it, app/migration runtime URLs agree, DB remains private, persistent volume
unchanged and Traefik integration retained. **8/8 pure Python tests** (5 redaction and 3 routing
regressions) pass, along with patch whitespace checks. No Docker engine exists in this sandbox; no
actual owner-host database/container was modified here. No ERP code/feature change or credential
rotation. **Publication result:** Normal fast-forward routing fix push verified, commit
`ab7776b2b70ddd5d59a5f516fd868571598d9b32`; this confirmation is a documentation-only follow-up.
Owner-host remediation remains pending the commands above. Source checkpoint:
`checkpoints/2026-10-10_0342_UTC/`. The ERP queue remains B-003 Purchasing.


### 26.18 Production tenant provisioning security `FIX PUBLISHED / HOST VERIFICATION PENDING`

**Owner finding:** publicly reachable tenant creation is not appropriate for production ERP. The
previous onboarding action accepted anonymous requests; RLS protects existing tenant rows but does
not prevent unapproved account creation/resource abuse. This is a real admission-control gap, not
an acceptable consequence of first-admin setup. Prior advice to use unrestricted `/clients/new` is
superseded by D-057.

**New production rules:**

1. First setup, with no existing tenant: configured private deployment-owner provisioning token is
   required; anonymous requests without the exact token are refused before hashing or writes.
2. After initialization: the same owner token **and** a valid signed-in user with capability
   `CFG.PLT.CLIENT.ONBOARD` are required. Possessing a tenant's broad administrator role alone is not
   enough without the server-owner token.
3. Missing/weak configured token disables web provisioning; unknown/missing environment is not treated
   as development. Token comparison uses fixed-length SHA-256 digests and timing-safe comparison.
4. Admission is rechecked in the tenant creation transaction, after acquiring a global advisory lock
   and reading initialization state through the existing narrow tenant-directory function. A second
   anonymous request from a stale first-setup page cannot race the first committed setup.
5. Tenant type/actor/authority submitted by the browser cannot disable production checks. Audit actor
   is `OWNER_BOOTSTRAP` for first setup or the verified requesting user thereafter.

**Scope:** added `src/platform/tenancy/provisioning.ts`, the independent server-action gate and a
trusted internal admission callback before tenant inserts. New server page wraps `TenantForm` and
requires sign-in/authority once initialized. Production `/clients` and `/` now require authentication;
production tenant directory/launchpad summaries filter to the signed-in tenant rather than expose
other clients. Existing database tables/migrations/tenant/admin records are not changed. Trusted local
CLI provisioning remains an operator action, not an HTTP signup endpoint. Explicit development mode
keeps the existing fixture walkthrough, but must never be exposed as production.

**Owner-host configuration:** add a separate, strong random token to the existing private `.env`:

```sh
openssl rand -hex 32
# Save the generated result locally as CAIRN_PROVISIONING_TOKEN in .env; do not share it.
git pull
docker compose up -d --build --force-recreate migrate app
```

Never overwrite existing database/session secrets with an example file. The Compose app alone receives
`CAIRN_PROVISIONING_TOKEN`; it is server-only, not `NEXT_PUBLIC_`, not passed to DB/migration and never
returned in UI/status/history. Open `/clients/new` for first setup and enter that private token in the
masked owner-access field. After the first tenant exists, anonymous access redirects to sign-in; later
provisioning requires authorized sign-in plus token. Blanking/removing the token and recreating app
locks all further web provisioning without affecting normal existing-user login or business records.
The safe example templates show an empty value, never a real token. Global capability metadata is
seeded by the normal migration job; existing administrator wildcard patterns already resolve it.

**Verification:** **53/53 focused tests** pass (23 target-selection, 12 credential, 12 provisioning
policy/lock-order checks, 6 actual server-action tests with request/transactional creation mocked).
Tests cover missing/wrong token, fail-closed unset environment, explicit development fixtures,
owner first setup, later anonymous/unauthorised refusal, token+capability requirement, audit spoofing
and stale first-setup recheck. TypeScript, framework/standalone production build and IP lint pass;
8 Python deployment/redaction regressions pass. Compose production/owner-token YAML invariants pass.
No live owner-host/database was accessed; the transaction lock/count behavior was mocked, not claimed
as a live PostgreSQL concurrency demonstration. The full ERP database suite was not rerun. Database
state/data, users and passwords were not edited/reset; only admission code/config changes.
This is a focused fix, **not a claim of complete production security sign-off** (rate limits, broader
permission/SoD coverage and the remaining modules still need their planned verification).

**Publication result:** Normal fast-forward security push verified, commit
`2f6902921de9ddb1612972281c9d9288021895c7`; this confirmation is a documentation-only follow-up.
Production host validation remains pending owner deployment. Source checkpoint:
`checkpoints/2026-10-10_0507_UTC/`. No additional ERP feature batch has started.


### 26.19 B-003 — Material Purchasing browser acceptance `COMPLETE`

**Scope:** Purchasing view only, using its existing Basic prerequisite. No MRP/valuation/PO feature
expansion, ERP form/schema/service change, or owner-host deployment was performed. Extended only
`scripts/browser-smoke/checks.ts`; `npm run smoke:browser:material-purchasing` passed in ~7 seconds.

**Verified via actual UI/server action:**

- Fresh isolated T995 tenant/admin through development-mode onboarding, then Basic material through UI.
- Order unit defaults to the material base unit KG. Purchasing can stage with a missing group:
  **INCOMPLETE**, plant-segment version 1, scope plant 1000.
- Group 001, exact over/under tolerances **5.25 / 1.75**, manufacturer part MFG-PURCH-001 complete it:
  **CREATED**, version 2. An unchanged resave preserves values/status/version.
- Group 002 and revised manufacturer part produce **MAINTAINED**, version 3.
- Alternative order unit LB is refused with the explicit missing material-conversion remedy, without
  changing stored KG/version. Conversion maintenance remains pending; no fake conversion is applied.
- Global Basic version stays 1; MRP remains NOT_CREATED; no valuation record is fabricated.
- Purchasing creation/completion/maintenance reasons, before/after fields, actor and session-derived
  footer are visible in history. Full-page history/error screenshot was inspected.
- A warehouse-only role can read the Purchasing view but has no purchasing Save form. Only that
  authorization user/role is a direct SQL fixture (user-admin screen remains pending); all business
  records were created through UI. Anonymous access redirects to sign-in; no browser runtime errors.

**Environment recovery/data preservation:** sandbox system services/dependencies had been discarded
between turns. Installed PostgreSQL 17 and browser/runtime tooling, confirmed no existing Cairn DB/roles,
and restored **the preserved B-002 custom dump** into a newly created database using the existing
private local connection settings. No reset/bootstrap-reset or seed reconstruction. This demonstrates
readability/full restore and checkpoint row-count agreement, not the planned scheduled restore/tie-out
service. Before/after browser/full-suite counts match exactly: **1 tenant, 1 user, 74 GL accounts,
11 ranges, 1 posted journal, 3 material/plant/valuation/planning rows each, 15 change documents and
10 applied migrations**. Only identified development fixtures were created/cleaned; original dev
business records and prior backups remain unchanged. The owner's remote host/database was not touched.

**Verification:** TypeScript and standalone build pass; **163/163 Vitest tests across 12 files pass**
(including provisioning/server-action/credential tests), **8/8 Python deployment tests pass**, IP lint
clean (108 files). Browser acceptance uses explicit development environment for disposable fixtures;
production owner-token protections remain in source and are covered by the same full test suite. This
is not an independent live production bootstrap/concurrency security sign-off or owner sign-off.
The existing Purchasing UI/service required no product correction in this batch.

**Sandbox preview:** current standalone source runs as process **`cairn-dbbb8691`**, `0.0.0.0:3000`;
`/signin` HTTP 200 rechecked. MRP/valuation views remain scheduled for their own browser acceptance.
Latest source/testing metadata is retained in this log; no claim of full material/master conformance,
P2P, MRP execution, billing/clearing or full manufacturing flow.

**Checkpoint:** `checkpoints/2026-10-10_1221_UTC/` includes current `database.dump`, `source.tar.gz`,
`repository.bundle`, `data-counts.csv`, `material-purchasing-history-review.png` and integrity hashes.
No real environment file/GitHub credential is put in source archives or public commits. **Publication
result:** Normal fast-forward verification-source push checked on `main`, commit
`c7b32ff831c1cfd311b4c683d8c787ce5e496214`; this confirmation is a documentation-only follow-up. Next is **B-004 MRP settings only**.


### 26.20 B-004 — Material MRP settings browser acceptance `COMPLETE`

**Scope:** plant-level planning **settings only**. No MRP execution/netting, planned/production orders,
BOM/routing, purchasing feature expansion or valuation acceptance in this batch. Extended the isolated
MRP browser target and corrected one demonstrated shared form-default bug.

**Real UI/server-action acceptance** (`npm run smoke:browser:material-mrp`, ~5.5 seconds after fix):

- Fresh T996 fixture through explicit development onboarding; Basic material created through UI.
- Missing controller stages MRP as **INCOMPLETE**, plant version 1. An untouched resave stays incomplete
  with no data/version change—it must not silently choose a controller.
- Controller 001, FIXED lot **100.000**, min/max **10.000 / 200.000**, safety stock **12.375**, delivery
  time 7 days complete the view as **CREATED**, version 2. Unchanged resave preserves it.
- REORDER method, reorder point **25.500** and safety stock **13.125** produce **MAINTAINED**, version 3.
  The relevant save reflags net-change and records browser.admin. For this check only, SQL marks the
  isolated fixture's previous flag consumed; no owner planning state is touched and no engine run is
  implied.
- Invalid maximum lot 5 below minimum 10 is refused; stored max 200/version 3 remain unchanged.
- Global Basic version stays 1, Purchasing remains NOT_CREATED, no valuation record is fabricated.
- Planning reasons, field-level audit changes and correct tenant/user footer are visible; full-page
  history/error screenshot inspected. Warehouse-only authority has read access but no planning Save
  form. Only the authorization identity is SQL-seeded (user-admin UI pending); business records use UI.
  Anonymous access redirects, no browser runtime errors.

**FND-004 — persisted unset field was replaced by new-record default:** the original form helper used
`initial[name] ?? fallback`, so saved null MRP controller was redisplayed as 001. A no-op resave therefore
changed the record to CREATED. Corrected with browser-safe `materialFormValue`: **undefined** uses a
new-record default, **null** is intentionally blank, while zero/false/exact strings are preserved.
The same helper applies consistently to the existing material forms. Five pure regression tests were
added; the full Purchasing browser target also passed after this shared correction. No existing record
is rewritten by the fix; it changes how saved unset fields are displayed/submitted.

**Verification:** TypeScript and corrected standalone build pass; **168/168 Vitest tests across 13
files** pass; **8/8 Python deployment tests** pass; IP lint clean (110 files); MRP-only acceptance and
Purchasing regression pass. Production provisioning tests remain part of the suite; disposable browser
fixtures use explicit development mode. This is automated acceptance, not owner sign-off, live
production bootstrap verification or complete material/MRP conformance. Valuation remains B-005.

**Preservation:** before/after DB counts match: 1 tenant/user/journal, 74 GL accounts, 11 ranges,
3 material/plant/valuation/planning rows each, 15 change documents, 10 applied migrations. Original
samples/book quantities/private environment files and prior backups unchanged; no reset, migration,
seed reconstruction or owner-host database operation. Only named fixtures were created/cleaned.

**Current sandbox preview:** corrected standalone source runs as **`cairn-f778c2c1`**, `0.0.0.0:3000`.
The previous preview was stopped before build to bound memory. This is not production deployment.
Owner-host update, if desired, requires an image rebuild because the field-default correction is
application code: `git pull` then `docker compose up -d --build app` (private `.env` retained).

**Checkpoint:** `checkpoints/2026-10-10_1243_UTC/` includes current `database.dump`, source archive,
repository bundle, counts, `material-mrp-history-review.png` and checksums. No private credentials or
captures enter Git. **Publication result:** Normal fast-forward correction/acceptance push verified, commit
`46082e8904bac075c0760e3a719e5e2c43750714`; this confirmation is a documentation-only follow-up. Next:
**B-005 Material Valuation only**. Full MRP execution remains its later M1d milestone.


### 26.21 B-005 — Material Valuation browser acceptance `COMPLETE`

**Scope:** existing Accounting/Costing **valuation settings**, not goods postings, standard-cost
estimation, stock revaluation documents or the full inventory/costing flow. Extended its browser
harness only; no ERP page/service/schema change was needed.

**Actual UI/server-action acceptance** (`npm run smoke:browser:material-valuation`, ~7.8 seconds):

- Fresh T997 fixture and Basic material through explicit development onboarding/UI.
- RAW type defaults to MOVING_AVERAGE. Blank valuation class stages **INCOMPLETE**, version 1;
  unchanged resave preserves the intentionally unset class/status/version.
- Currency is company-derived **KWD**. Currency/book quantity/book value are spans, not editable
  inputs. Deliberately forged USD, quantity 999 and value 999999 submitted to the action are ignored;
  initial stored book quantity/value remain zero.
- RAW_INVENTORY, moving price **12.3456**, price unit **10.000** complete **CREATED**, version 2.
  Unchanged resave preserves exact values/version.
- With zero stock, switching to STANDARD and price **25.6789** maintains the view, version 3.
  Zero price unit is refused without changing version.
- **Isolated guard fixture only:** SQL represents pre-existing book stock of 10.000/value 25.6789
  inside T997, because goods posting is not implemented. This is not an inventory posting or owner
  opening stock. A subsequent attempted price 30.0000 is refused; version 3, stored price, quantity
  and book value are preserved. Global Basic version stays 1 and no plant purchasing/MRP segments
  are fabricated. The entire fixture is safely cleaned after the test.
- Valuation/control-change reasons, before/after audit fields and real session footer are visible;
  full-page history/refusal screenshot inspected.
- A finance reviewer with **FIN.MATERIAL.VALUATION.DISPLAY only** can read valuation/history but has
  no Save form. A warehouse-only user cannot see prices/history or maintain valuation; serialized
  HTML was checked for both known test price values and neither is present. Anonymous access
  redirects; no browser runtime errors. Identity/role fixtures are direct SQL because user admin UI
  remains pending; all actual master/business setup above uses UI.

**Test fixture correction:** initial attempt used nonexistent role-capability column
`capability_pattern`; the actual schema column is `capability_code` (stores literal patterns). The
fixture was corrected, not the schema/migration/product permissions. All valuation/business checks
had already passed before that fixture error. No product defect was found in the completed target.

**Verification:** TypeScript, **168/168 Vitest tests across 13 files**, **8/8 Python deployment tests**,
IP lint (110 files) and focused valuation browser acceptance pass. Current product build remains the
B-004 corrected standalone build; this test/log-only batch does not require an owner-host image rebuild.
Basic, Purchasing, MRP settings and Valuation now each have successful isolated browser walkthroughs.
This does not imply full material conformance: Production/Sales/Storage/Forecast/Quality/Warehouse
views, unit conversions, revaluation/costing, imports and operational flows remain pending. Owner
sign-off is still pending.

**Preservation:** before/after DB counts match: 1 tenant/user/journal, 74 GL accounts, 11 ranges,
3 material/plant/valuation/planning rows each, 15 change documents, 10 applied migrations. No original
stock/book values, users, documents, private env files or owner-host data changed. No reset, migration
or seed reconstruction. The owner environment is not used for the fixture stock/identity simulations.

**Checkpoint:** `checkpoints/2026-10-10_1259_UTC/` includes current custom DB dump, source archive,
repository bundle, counts, valuation-history screenshot and hashes; previous checkpoints retained.
No private credentials/captures are committed. **Publication result:** Normal fast-forward valuation-acceptance push verified, commit
`d79547512f618cd7be3a9c8319a53c3d01f6acf5`; this confirmation is a documentation-only follow-up. Next: **B-006 Payment terms backend/defaults only**, before partner company data.


### 26.22 B-006 — Payment terms backend/defaults `COMPLETE · UI PENDING`

Added tenant-scoped `payment_terms` (64 schema tables total), generated migration
`0003_payment_terms.sql` and additive forced-RLS/grant migration `9007_payment_terms_policies.sql`.
Both applied successfully; **12 migrations** total. Existing migration files/checksums are unchanged.
The new table cascades on tenant deletion, default-denies unscoped application reads and enforces
baseline, net-day, coherent discount-day/percentage and positive-version constraints in SQL.

**Service/contract:** `payment-terms.ts` creates/maintains/lists/reads definitions with schema validation,
exact two-decimal percentages, transaction advisory+row locks, expected-version refusal, no-op
preservation and field-level change evidence. Required change reason; baseline, due/discount settings
and active state are control-relevant. No public endpoint is added: B-007 must authenticate and derive
tenant/actor at its action boundary. Inactive terms cannot resolve a new payment schedule.

**Date calculation:** pure `payment-term-dates.ts` explicitly selects DOCUMENT_DATE, POSTING_DATE or
ENTRY_DATE, validates real ISO dates, adds UTC calendar days across months/leap years, and returns net
and up to two cash-discount deadlines/percentages with term code/master version/baseline. It never
silently substitutes another date or uses floating-point discount arithmetic. Future invoice services
must persist that schedule/version; editing a master must not recalculate posted invoice facts. No
invoice/subledger/payment execution integration is claimed in this batch.

**Additive international starting defaults:** IMMEDIATE, NET15, NET30, NET60, and D2_10_NET30
(2.00% within 10 days, net 30). Standard-package activation inserts missing definitions only; existing
customer definitions are never overwritten. Development 0100 alone received these five definitions
through a guarded additive call, with configuration audit records. Existing production/customer tenants
are not silently backfilled. No maintenance page/working registry route or completed UI checklist step
is claimed yet. Fixed-date/month-end/day-limit variants, installments, payment methods, discount posting
and calendar-specific processing remain future slices; this is the ordinary day-offset first slice,
not full payment-term conformance.

**Verification:** **19 new tests** cover defaults, exact/audited writes, no-op/stale/concurrent updates,
additive preservation, malformed discounts/days, inactive resolution, RLS isolation/unscoped default-deny,
SQL null/percentage coherence, cascade cleanup, leap/month-end calendars, explicit baselines and
schedule version. TypeScript and standalone build pass; **187/187 Vitest tests across 14 files** pass;
IP lint clean (117 files). The table's null checks explicitly reject missing days with a nonzero
percentage instead of relying on PostgreSQL's nullable CHECK semantics. No browser walkthrough applies
until the maintenance UI exists.

**Preservation:** original business counts are unchanged: 1 posted journal and 3 material/plant/
valuation/planning records each; no stock/financial document or original master view edited/reset.
Expected additive changes are the new empty schema/table/policies, migration history and five audited
payment configuration rows for the named development fixture. No reset/bootstrap-reset or migration
rewrite. Current sandbox preview rebuilt and restarted as **`cairn-79c663a0`**, `0.0.0.0:3000`; no owner
host/database was operated from here. Owner deployment needs `git pull` then
`docker compose up -d --build --force-recreate migrate app` to apply the additive schema before app.

Checkpoint: `checkpoints/2026-10-10_1314_UTC/` contains current private DB/source/history/count artifacts
and hashes; prior backups remain. **Publication result:** Normal fast-forward backend push verified, commit
`2ae2423d2204d7251c842e6922ca30dd6c1729de`; this confirmation is a documentation-only follow-up.
Next: **B-007 Payment terms maintenance page/action only**, then partner segments.


### 26.23 B-007 — Payment terms maintenance and owner test plan `COMPLETE`

Working route **`/config/payment-terms`**, command **`CFG.FIN.PAYTERMS.DEFINE`**. Added protected
list/search, create/change form, active flag, required reason, saved-version due-date preview and
field-level audit history. Command/Workbench route and capability seeded; catalogue now **39
capabilities, 17 terms, 16 aliases** (51 config activities unchanged). A successful/no-op authorized
save marks the define/assign activity complete. Read-only logged-in users can inspect definitions and
preview; maintenance requires the configuration capability. No invoice/payment posting is performed.

**Security:** server action independently requires session/capability; derives client and audit actor
from session, ignores forged fields and validates through the locked/versioned backend. The client
form receives only business values/version, never technical tenant/audit fields. Persisted committed
version remounts uncontrolled fields; optional discount days remain blank, percentages exact strings.
Create mode always sends version 0; duplicate code cannot reset/update an existing master. Preview is
explicitly saved data/version, not unsaved edits. Editing does not recalculate posted schedules.

**Verified:** fresh T993 owner UI creates TESTPAY, 2.00% at 10 days/1.00% at 20/net 30; baseline
2026-10-10 gives discount dates **2026-10-20/2026-10-30** and net **2026-11-09**. No-op keeps version 1;
net 5 is refused, net 45 updates version 2; history/search/checklist/anonymous refusal pass. Screenshot
inspected. Added three action-security regressions for forged actor/tenant, FIN-only write denial and
anonymous calls. **191/191 Vitest tests**, 8 Python regressions, TypeScript/production standalone build,
IP lint (120 files) and focused browser acceptance pass. No product correction needed after first
browser run. No live owner-host security/bootstrap or complete invoice conformance claim.

**Preservation:** original journal/material/plant/valuation/planning counts unchanged; five development
payment definitions unchanged; temporary test definitions/identities cleanly removed. No migration,
reset or stock/document edits. Only global command/capability seed and completion metadata behavior
are added. Sandbox standalone process **`cairn-1c10ede3`**, `0.0.0.0:3000`. Deployment:
`git pull` then `docker compose up -d --build --force-recreate migrate app` (keep private `.env`).

**Owner manual check (R-23):** use a development tenant, not live payment policy. Open the command
above; Create payment terms, add these fresh codes, and enter a reason for every save:

| Field | TEST30 | TEST2D |
|---|---|---|
| Description | Test net 30 | Test two discounts |
| Baseline source | Document date | Document date |
| Net days | 30 | 30 |
| Discount 1 days / percent | blank / 0.00 | 10 / 2.00 |
| Discount 2 days / percent | blank / 0.00 | 20 / 1.00 |
| Active | checked | checked |
| Reason | Owner UI test | Owner UI discount test |

Open saved record, Preview dates with **2026-10-10**. TEST30 net due **2026-11-09**, no discount
lines. TEST2D same net due plus **2026-10-20 (2.00%)** and **2026-10-30 (1.00%)**. Change net days to
45 and save with reason: net due **2026-11-24**, discount dates unchanged; history shows actor and
30→45. Save unchanged with a reason: no data change/version/audit noise. Search by code/description.

Negative tests: net days 5 with discount day 10; discount 2 before discount 1; second percent 3.00 above
first 2.00; percentage 2.001/101; negative days; blank description/reason; duplicate code creation.
Each must be blocked/refused without overwriting saved values. Two tabs: save in A then edit stale B;
B must refuse and request reload. Toggle inactive and verify list/history; inactive terms are unusable
by runtime schedule services (invoice integration pending). A FIN-only/ordinary user must have no
maintenance authority; direct forged action is also refused. Sign out and open the route: redirect.
Do not expect deletion, invoice posting, fixed/month-end variants or installments in this slice.

Checkpoint `checkpoints/2026-10-10_1336_UTC/`: private database/source/repository/review artifacts and
checksums. **Publication result:** Normal fast-forward maintenance UI push verified, commit
`b6cfde75246acd971a25969613936117f57cb3d0`; this confirmation is a documentation-only follow-up. Next: B-008 partner
general backend only. Owner walkthrough feedback should include tenant/code, inputs, expected/actual
result and screenshot without passwords/provisioning tokens.


### 26.24 B-008 — General business partner backend `COMPLETE · UI PENDING`

Added `business_partner` and stable `bp_role` tables (66 schema tables), generated immutable
`0004_business_partner_general.sql` plus additive `9008_business_partner_policies.sql`; **14 applied
migrations** total. Both tables have forced default-deny tenant RLS, restricted runtime grants and
client cascades; role rows also reference the tenant-composite partner key with cascade.

**General-only contract:** externally entered own-IP partner number, immutable ORGANIZATION/PERSON
category, display names/search term, one primary country/region/street/city/postal address, tax number,
email and phone; global blocking flag, version and staged INCOMPLETE/CREATED/MAINTAINED status. Name,
configured country and city complete this first general slice. One identity may carry SUPPLIER and/or
CUSTOMER roles. No company-code reconciliation/payment fields, purchasing org/sales area, bank accounts,
multiple addresses/contacts, credit management or payment behaviour integration are fabricated.

**Service:** validated tenant writes, advisory+row locks, expected versions, no-op preservation, audited
field/control changes and reason. Country must exist, email must be valid, roles cannot duplicate;
category cannot change after creation. Role removal is deactivation, never deletion; reactivation keeps
stable rows/created metadata for future segment references. General operational gate refuses missing,
incomplete/blocked general data or inactive role. This gate is only a prerequisite—future transactions
must additionally require completed company/organisation segments. Trusted backend functions are not
public server actions; B-009 must derive tenant/actor and independently enforce authority.

**Verification:** **16 new tests** cover create/stage/complete, dual roles, stable deactivation/reactivation,
no-op audit/version, stale/concurrent edits, block/unblock use gate, malformed country/email/key/roles/
reason, immutable category, isolation/unscoped default-deny, search and cascade. **207/207 Vitest tests
across 15 files**, 8 Python regressions, TypeScript/standalone build and IP lint (126 files) pass. No
browser claim until UI exists. Applied migrations unchanged except the two new files; no reset/reseed.
Original journals/material/plant/valuation/payment-term counts are unchanged; **zero partner/role rows**
remain outside cleaned test fixtures. No default business partners were inserted into owner/dev data.

**Preview:** rebuilt current standalone as **`cairn-f6964ef5`**, `0.0.0.0:3000`. Owner-host schema update:
`git pull` then `docker compose up -d --build --force-recreate migrate app` (keep actual private `.env`).
A working partner command/route is **not yet registered**; do not expect a new Create partner screen.

**Owner checks/dummy data (R-23):** today, verify the migration logs show successful additive 0004/9008
and existing login/material/payment-term screens still work. No partner form is available to add data
in this backend-only batch. Reserve these values for B-009, using a development tenant:

| Field | Future dummy value |
|---|---|
| Partner number / category | TESTSUPP01 / ORGANIZATION |
| Name / search term | Demo Industrial Supply / DEMOSUPP |
| Country / region | KW / Farwaniya |
| Street / city / postal code | Test Street 10 / Kuwait City / 80000 |
| Tax number | DEMO-TAX-001 (fictional; not a real tax registration) |
| Email / phone | orders@example.com / +965 5550 0100 |
| General role / blocked | SUPPLIER / false |
| Reason | Owner general-partner test |

Future form tests: save missing city as incomplete; complete city; add CUSTOMER on the same number;
deactivate/reactivate SUPPLIER without duplicating identity; block/unblock with a reason; no-op/stale
resave; reject ZZ country, malformed email, duplicate roles and attempted category conversion. These
are future UI instructions, not a claim that supplier invoices/POs/customer sales are available now.
No real bank details should be entered in this general-only slice.

Private checkpoint: `checkpoints/2026-10-10_1401_UTC/` includes current DB/source/history/count artifacts
and hashes. **Publication result:** Normal fast-forward general-backend push verified, commit
`283f6d754ce413d946730ad9bc223792783d204b`; this confirmation is a documentation-only follow-up. Next: **B-009
Business partner general maintenance page/action**, with company/purchasing/sales segments still separate.


### 26.25 B-009 — General business partner maintenance `COMPLETE`

Working page **`/foundation/partners`**; commands **`FND.PARTNER.CREATE`** (new form),
**`FND.PARTNER.DISPLAY`** / **`FND.PARTNER.MAINTAIN`** (list/maintenance). New independent write capability
FND.PARTNER.MAINTAIN; global catalogue now **40 capabilities, 20 terms, 19 aliases**, 51 config activities
unchanged. General partner launchpad tile added. Supplier company, purchasing, customer company, sales
and bank segments are explicit disabled/pending tabs; no working-looking placeholder link.

Form: number, immutable category after creation, two names/search term, supplier/customer roles,
configured country, region/street/city/postal code, tax/email/phone, global blocking and required reason.
Staged saves allowed; name/country/city complete the current slice. Search by number/name/search term,
summary/status, read-only fallback and field-level control history. Only business primitives are sent
to the client form, not tenant/audit metadata. Server action independently authenticates/authorizes and
derives tenant/actor; posted client/changedBy fields are ignored. No company or organisation segments
are created by selecting a general role. No bank/operational payment/PO/sales capability implied.

**Verification:** TypeScript/standalone build/IP lint (129 files), **211/211 automated Vitest tests**
across 15 files, 8 Python deployment regressions, and fresh T992 real-browser target pass. Browser
covers missing-city INCOMPLETE, city completion CREATED, no-op version preservation, dual roles,
supplier deactivation/reactivation with stable role rows, reasoned block/unblock, invalid injected ZZ
country refused, search/control history, pending tabs and warehouse read-only behavior; anonymous
route redirects. Commit-version waits avoid typing/reading stale SPA forms. Added action tests for
forged tenant/actor, INV-only write denial and anonymous action refusal. No product correction needed
following the first focused browser run. Screenshot inspected, owner sign-off still pending.

**Preservation:** partner/role tables remain **empty outside cleaned test fixtures**; original 1 journal,
3 materials and 5 payment terms unchanged; 14 applied migrations unchanged. No new migration/reset,
stock/customer-row edits or remote-host operation. Only global command/capability seed is additive.
Current sandbox process **`cairn-4b14b0d5`**, `0.0.0.0:3000`. Owner deployment:
`git pull` then `docker compose up -d --build --force-recreate migrate app` (keep private .env).

**Owner test data (R-23):** use a development tenant; fresh TESTSUPP01 and optional TESTCUST01 numbers.

| Field | TESTSUPP01 | TESTCUST01 |
|---|---|---|
| Category / Name | Organization / Demo Industrial Supply | Organization / Demo Retail Customer |
| Search term | DEMOSUPP | DEMOCUST |
| Country / region | KW / Farwaniya | KW / Hawalli |
| Street / city / postal | Test Street 10 / Kuwait City / 80000 | Test Street 20 / Hawalli / 30000 |
| Tax number | DEMO-TAX-001 | DEMO-TAX-002 |
| Email / phone | orders@example.com / +965 5550 0100 | buyer@example.com / +965 5550 0200 |
| General roles / Blocked | Supplier / unchecked | Customer / unchecked |
| Reason | Owner supplier general test | Owner customer general test |

Tax/contact values are fictional. Name2 can be blank. Start TESTSUPP01 with city blank: save should be
INCOMPLETE; open saved partner, enter city and reason: CREATED. Add Customer role to same record:
MAINTAINED, one identity/two roles. Untick Supplier/save: role deactivated, not a duplicate/deleted
partner; recheck restores same identity. Block/unblock with reasons, verify summary and history.
Unchanged save must preserve version/audit. Search by DEMOSUPP or code. Use two tabs for stale-edit
refusal. Invalid email, missing reason, malformed/duplicate number or category conversion must be
blocked/refused (category field is readonly after creation); configured country choices exclude ZZ,
and the backend also rejects forged ZZ. Ordinary warehouse user gets no Save form; anonymous route
redirects. Organization segments/bank fields remain pending, so do not expect PO/invoice/sales posting.
Report tenant, partner code, inputs, expected/actual behavior and a screenshot without credentials.

Private checkpoint `checkpoints/2026-10-10_1429_UTC/` contains DB/source/history/review artifacts/hashes.
**Publication result:** Normal fast-forward general UI push verified, commit
`34a0fc0a555b61255860d872d69eedb746a3b8ff`; this confirmation is a documentation-only follow-up. Next: **B-010 supplier company
backend**, with company UI in the following batch.


### 26.26 B-010 — Supplier company-code backend `COMPLETE · UI PENDING`

Added `supplier_company_code` (67 tables), generated immutable `0005_supplier_company.sql` and additive
`9009_supplier_company_policies.sql`; **16 applied migrations**. Tenant forced-RLS/default-deny/grants,
client cascade and composite references to stable SUPPLIER role, company, company-chart GL account and
payment terms. The company chart is server-derived, never trusted from submitted values.

Company settings: partner/company key, supplier role, reconciliation account, payment terms, company
blocking, staged INCOMPLETE/CREATED/MAINTAINED and version/audit. General supplier must exist with active
role; company must be active; reconciliation account must belong to that company chart, be unblocked
and VENDOR reconciliation; payment terms must be active. Blank assignments may stage an incomplete
view. Shared general-partner advisory lock, row locks, optimistic version, no-op preservation, reasons
and control-change history. Company usability gate additionally requires complete/unblocked general
partner, active supplier role, complete/unblocked company settings and still-valid assignments.

No company views are fabricated for other companies; tests show the same supplier's 1000/2000 records
stay independent. Reconciliation-account changes are conservatively refused once partner-linked
accounting exists; reviewed migration/zero-balance reclassification workflow is future work, not a
claim of full reconciliation-master conformance. Posted ledger facts are not rewritten. Future invoice
services must snapshot assignments/term versions. Journal partner assignment width is currently 20
versus master 40; align before full AP posting integration, not by editing historical facts here.
Payment methods, banking, withholding/dunning/tolerances, purchasing/sales segments, open-item/payment
processing and invoice posting are not implemented by this master slice.

**Verification:** 18 new tests for stage/complete, valid chart/vendor account, wrong/inactive/blocked
assignments, customer-only refusal, no-op/stale/concurrent edits, company/global blocking, isolation,
cascade, two-company independence and linked-ledger protection. The linked ledger is an isolated
balanced posting-engine fixture, not owner financial data. **229/229 Vitest tests across 16 files**,
8 Python regressions, TypeScript/standalone/IP lint (135 files) pass. No browser test until B-011 UI.

**Preservation:** discarded sandbox services restored from the latest B-009 custom dump into a
confirmed empty database/roles; no reset/reseed/overwrite. Original journals/materials/partners/payment
terms unchanged; zero supplier-company rows remain outside cleaned fixtures. Only two additive
migrations changed schema/history. Owner host not operated from here. Preview process **cairn-033c9f49**,
0.0.0.0:3000. Apply on owner host with `git pull` then
`docker compose up -d --build --force-recreate migrate app`, keep private .env.

**Owner check/R-23:** no company form yet. Check additive migration success and existing partner/general
and payment-term screens. Reserve: general partner **TESTSUPP01**, active Supplier role/general data
complete; company **1000**; reconciliation **200000** (Trade payables, VENDOR); payment terms **NET30**;
company block unchecked; reason **Owner supplier accounting test**. Expected future form state CREATED;
blank account/terms stages INCOMPLETE, customer cash/AR accounts 100000/110000 must be refused, inactive
terms refused, company blocking only blocks that company, stale tab refuses, audit shows reason/user.
Do not add assignments by manual SQL or expect invoices/payments in this backend-only batch.

Private checkpoint: `checkpoints/2026-10-10_1458_UTC/` with DB/source/history/count/hashes. **Publication
result:** Normal supplier-company backend push verified, commit `29fd94e1c9050f7f90208121a7273641d38839c3`;
this confirmation is a documentation-only follow-up. Next B-011 supplier company UI/action only.


### 26.27 B-011 — Supplier company-code maintenance `COMPLETE`

Partner page now links the active Supplier's **Supplier company code** tab. Working command
**FIN.SUPPLIER.COMPANY.MAINTAIN** opens partner selection; direct route `/foundation/partners` with
`partner`, `view=SUPPLIER_COMPANY`, `company` identifies the scoped view. Company selector, derived
chart/currency spans, unblocked supplier reconciliation dropdown, active payment terms, company-only
block and required reason; status/version/no-op preservation and company-specific control history.
Other supplier purchasing/customer/sales/bank tabs remain disabled pending work.

**Authority:** separate FIN.SUPPLIER.COMPANY.MAINTAIN and FIN.SUPPLIER.COMPANY.DISPLAY (or audit read)
protect financial view/history; general FND authority alone does not grant access. Server action
independently checks session/maintain, derives tenant/actor and ignores submitted chart/currency.
Readonly finance renders no Save; non-finance receives missing-display authority, not accounting
history. Choices are tenant-scoped and based on selected company chart. Global catalogue now **42
capabilities/21 terms/19 aliases**, 51 configuration activities. No schema migration in this UI batch.

**Verified:** TypeScript/standalone build/IP lint (137 files), **233/233 Vitest tests across 16 files**,
8 Python deployment regressions and actual isolated T991 browser target passed. Browser covers
fresh UI general Supplier prerequisite, incomplete/no-op company view, 200000/NET30 completion,
NET15 maintenance, company block/unblock, injected 100000 cash reconciliation refusal without mutation,
company history and non-finance form/history denial; anonymous access redirects. Three new real-action
security regressions cover forged tenant/actor/chart, FND-only denial and anonymous rejection. Browser
runtime tooling discarded after prior snapshot was reinstalled; no arbitrary waits/timeout inflation.
No product correction was required. Screenshot inspected; owner sign-off and production-host rollout
still pending. Two-company independence/linked accounting safeguards remain tested by B-010 backend.

**Preservation:** original 1 journal/3 materials/5 payment terms unchanged; partner and supplier-company
rows remain zero outside cleaned test fixtures; 16 applied migrations unchanged. No data reset,
financial posting or owner-host operation. Only scoped UI/service choices, registry/capability seed and
tests changed. Sandbox process **cairn-b233ba96**, 0.0.0.0:3000. Owner rollout: `git pull` then
`docker compose up -d --build --force-recreate migrate app`, keep private .env.

**Owner checks/dummy data (R-23):** in a development tenant, general TESTSUPP01 must have Name/country/
city complete and Supplier role active. Open FND.PARTNER.DISPLAY → partner → Supplier company code;
or FIN.SUPPLIER.COMPANY.MAINTAIN → select partner. Choose company 1000 and Select company.

| Field | Dummy assignment |
|---|---|
| Company code | 1000 |
| Chart / currency | Read-only, derived from chosen company; CAIRN / its configured local currency |
| Reconciliation account | 200000 — Trade payables |
| Payment terms | NET30 |
| Blocked for company | unchecked |
| Reason | Owner supplier company test |

First save blank account/terms with a reason: INCOMPLETE. Fill the assignments above/save: CREATED.
Save unchanged with reason: no change/version/audit noise. Change terms NET15/save: MAINTAINED and
history NET30→NET15, actor/reason. Toggle company blocking with reasons; general partner/global flag
must stay unchanged. Selecting another existing company must show its independent view—not copy
1000 silently. Chart/currency must have no editing control. No supplier/general role: tab unavailable.

Negative checks: Cash 100000/customer 110000 must not appear in reconciliation choices; backend also
refuses forged values. Inactive terms must not appear/are refused. Empty reason blocks save. Two tabs:
save A, then stale B must request reload. FND-only/warehouse user cannot view/maintain financial fields
or company history; FIN display-only can review without Save. Sign-out route redirects. Reconciliation
change after linked accounting is conservatively refused. No invoice, banking or PO functionality is
implied by this company master; payment methods/dunning/tolerances/withholding remain later work.

Private checkpoint `checkpoints/2026-10-10_1536_UTC/` includes DB/source/history/review artifacts/hashes.
**Publication result:** Normal supplier-company UI push verified, commit
`e3aeeade55ec68dd7c146d4f4a3ad57735671a56`; this confirmation is a documentation-only follow-up. Next B-012 supplier purchasing
backend only, not a purchasing form/order workflow in the same batch.


### 26.28 B-012 — Supplier purchasing-organisation backend `COMPLETE · UI PENDING`

Added `supplier_purchasing_org` (68 tables), generated immutable `0006_supplier_purchasing.sql` and
additive forced-RLS/grant `9010_supplier_purchasing_policies.sql`; **18 applied migrations** total.
Composite references bind stable Supplier role, purchasing organisation, group and optional payment
terms; currency uses global reference. Tenant cascade/default-deny remain enforced.

Backend stores order currency, purchasing group, standard delivery-term code/location, optional
purchasing payment-term override, org-only block, staged status/version and audit. Requires active
general Supplier role and active purchasing organisation/assigned company; currency must be active,
group active and either generic or valid for this organisation, payment-term override active. Supported
delivery codes EXW/FCA/FAS/FOB/CFR/CIF/CPT/CIP/DAP/DPU/DDP; location without code is refused. Selected code
with missing location may stage INCOMPLETE; currency/group plus coherent optional delivery data completes
this first slice. No delivery code/term override is also a valid ordinary default.

Shared partner advisory lock, row lock, expected-version refusal, no-op preservation, required reason
and control-change history. Operational gate requires complete/unblocked general Supplier and current
usable purchasing defaults; supplied plant must be real/active and explicitly assigned to the org.
Does not require a fabricated accounting-company segment for purchasing default use; invoice services
must separately require completed supplier accounting. Company settings/general data are not copied
or overwritten; two organisation views remain independent. Future PO documents must snapshot defaults.
No purchase requisition/order/release, goods receipt, pricing/info record, banking, partner-function
relationships or payment execution is implemented in this slice. Order currency is a default, not a
claim that foreign-currency financial posting now works.

**Verification:** 19 new tests cover stage/completion/use, optional defaults, missing/customer-only
role, invalid org/currency/group/terms/delivery/location/reason, no-op audit/version, stale/concurrent
updates, org blocking/current-reference recheck, multi-org isolation/cross-group refusal, active-plant
assignment, tenant/unscoped isolation, inactive terms and cascade. **252/252 Vitest tests across 17
files**, 8 Python deployment tests, TypeScript/standalone build/IP lint (143 files) pass. No purchasing
browser claim until B-013. Existing migration checksums untouched; only the two additions applied.

**Preservation:** original journal/material/general partner/supplier-company/payment-term counts
unchanged; zero purchasing rows remain outside cleaned fixtures. No default supplier/company/purchasing
master was invented for existing users. No reset/reseed/owner-host operation. Preview process
**cairn-2b8ca286**, 0.0.0.0:3000. Owner update: `git pull` then
`docker compose up -d --build --force-recreate migrate app`, retain private .env. New Purchasing tab
is not enabled by this backend batch; Supplier company UI remains available for the owner's later review.

**Owner check/R-23:** confirm additive 0006/9010 migration completion (18 total) and existing general,
company and payment-term screens still work; do not add purchasing rows through SQL. Reserve for B-013:
general **TESTSUPP01** active Supplier, purchasing org **1000**, order currency **USD** (or active KWD
for local testing), purchasing group **001**, delivery term **FCA**, location **Kuwait City**, optional
terms **NET30**, org block unchecked, reason **Owner supplier purchasing test**. Future form expected
CREATED; missing currency/group/location stages incomplete; bad/inactive/cross-org group and invalid
currency/delivery code must be refused; no-op/stale checks preserve data, org block remains independent
of general/company blocks. No PO/receipt/invoice posting is available yet. User will check forms later;
no owner sign-off is inferred from continuation.

Private checkpoint `checkpoints/2026-10-10_1554_UTC/` stores DB/source/history/count artifacts and hashes.
**Publication result:** Normal purchasing-backend push verified, commit
`78dc1c7c6fdda9cc7968cbe761acbb045255ac82`; this confirmation is a documentation-only follow-up. Next B-013 supplier purchasing UI.


### 26.29 B-013 — Supplier purchasing defaults UI `COMPLETE`

Active Supplier partner now has a **Purchasing organisation** tab on `/foundation/partners`.
Command **PROC.SUPPLIER.PURCHASING.MAINTAIN** opens selection; `view=SUPPLIER_PURCHASING` and `org`
identify the segment. Fields: order currency, valid purchasing group, delivery code/location, optional
purchasing payment-term override, organisation-only block, required reason and saved status/version.
New records prefill the organisation's company currency; saved unset values remain blank. Scope/company
identities are readonly. General/supplier company data and their blocks/terms are not rewritten.

Separate PROC.SUPPLIER.PURCHASING.DISPLAY/MAINTAIN (audit read allowed) protect commercial fields and
history. Server action independently authenticates, authorizes and derives tenant/actor; posted values
cannot bypass active org/currency/group/term rules. FND/FIN/warehouse authority alone does not grant
purchasing writes. Choices filter active organisations/companies/currencies/terms and active generic
or selected-org groups. Scoped control history requires read authority; general/financial histories
remain distinct. Catalogue **44 capabilities/22 terms/19 aliases**; 51 activities unchanged.

**Verified:** TypeScript/standalone build/IP lint (145 files), **256/256 Vitest tests across 17 files**,
8 Python regressions, isolated T990 Purchasing browser and Supplier company regression all pass. Browser
uses UI general Supplier prerequisite, initial KWD/default incomplete view, no-op version preservation,
USD/001/FCA/Kuwait City/NET30 completion, location/NET15 maintenance, org block/unblock, injected ZZZ
currency refusal without mutation, scoped history and warehouse read/form/history denial; no company
accounting segment is fabricated. Three new action regressions cover tenant/actor forgery, FIN-only
denial and anonymous calls. Screenshot inspected; no product correction needed after the first
focused browser run. Owner later form reviews/sign-off are still pending, not inferred from Continue.

Original journals/material/general partners/supplier company/payment terms unchanged; zero purchasing
rows remain outside cleaned fixtures; 18 migrations unchanged. No reset/migration/financial posting.
Current sandbox process **cairn-1b05b65b**, 0.0.0.0:3000. Owner deployment: `git pull` then
`docker compose up -d --build --force-recreate migrate app`, retain existing private .env.

**Later owner test (R-23):** test tenant, complete TESTSUPP01 with active Supplier. Open
FND.PARTNER.DISPLAY → record → Purchasing organisation, select 1000. Defaults: order USD (or active local
currency), group 001, delivery code FCA, location Kuwait City, optional terms NET30, org block off,
reason **Owner supplier purchasing test**. Save with group blank: INCOMPLETE; complete group/location:
CREATED. Unchanged save must keep version/history. Change location to Test receiving site and override
NET15/save: MAINTAINED; company NET30 must stay unchanged. Block/unblock organisation with reasons,
verify general/company flags unchanged and audit actor/values/reason. Another existing org must show
its own record, not copy silently. Optional code+location may both be blank; location without code is
refused, selected code without location stays incomplete.

Negative: inactive/unknown currency, cross-org/inactive group or inactive payment terms refused;
dropdowns must exclude them. Blank reason blocks. Two tabs stale B refuses after A save. Supplier role
missing/inactive tab unavailable. Users without procurement read authority must see no commercial form
or scoped history; display-only has no Save. Sign-out route redirects. No PO/receipt/invoice, partner
function relationship, price/info-record or payment execution is enabled by this master screen.

Private checkpoint `checkpoints/2026-10-10_1612_UTC/`: DB/source/history/review/count artifacts/hashes.
**Publication result:** Normal procurement UI push verified, commit
`46dec8494f28b029816521f91507b558c5681e74`; this confirmation is a documentation-only follow-up. Next queue now explicitly
splits Customer company backend/UI (B-014/15) and sales-area backend/UI (B-016/17); remaining masters,
imports/P2P/MRP/other accepted scope continue in bounded slices without silent scope removal.


### 26.30 B-014 — Customer company-code backend `COMPLETE · UI PENDING`

Added `customer_company_code` (69 tables), generated immutable `0007_customer_company.sql` plus
additive `9011_customer_company_policies.sql`; **20 applied migrations**. Forced/default-deny RLS,
client cascade and composite references to stable CUSTOMER role, company/chart AR account and terms.
Fields: company-scoped reconciliation/payment assignments, derived chart, company-only block,
staged INCOMPLETE/CREATED/MAINTAINED, version/audit. No sales-area/open-item/credit/billing data fabricated.

Requires active Customer role and active company, unblocked **CUSTOMER** reconciliation account in
assigned chart and active payment terms. Empty account/terms may stage; operational gate additionally
requires complete/unblocked general Customer and usable company settings/current references. Shared
partner advisory/row locks, version/no-op/reason/control evidence. Reconciliation or chart changes
are conservatively refused after partner/company-linked accounting exists; review/reclassification
workflow remains future work, and historical ledger/schedule facts are never rewritten. Invoice
services must snapshot assignments and due schedules, not dynamically recalculate old documents.
Dual-role supplier and customer company settings are independent, as are different companies.

**Verification:** 20 new actual DB tests cover stage/complete, derived chart/AR validation, supplier-only
refusal, invalid/inactive/blocked references, no-op/stale/concurrent writes, company/general blocking,
isolation/unscoped default-deny, cascade, two companies, linked accounting guard, dual-role supplier
preservation and current company/role use checks. **276/276 Vitest tests across 18 files**, 8 Python
regressions, TypeScript/standalone build/IP lint (151 files) pass. No Customer-company browser claim
until B-015. Legacy schemas/migration checksums stay unchanged except two additive migrations.

Discarded sandbox services recovered by restoring preserved B-013 DB dump into a confirmed empty
new database/roles, not reset/reseed/overwrite. Original journal/material/general partner/supplier
company/purchasing/payment-term counts unchanged; **zero customer company rows** outside cleaned
fixtures. No owner-host database/schema operation from here, no default customer seeded. Preview
process **cairn-25f2449e**, 0.0.0.0:3000. Owner update: `git pull` then
`docker compose up -d --build --force-recreate migrate app`, keep private .env.

**Owner checks/R-23:** confirm additive migration success (20 total) and existing general/supplier/
payment-term forms still work. Customer company tab remains pending; no new company form today.
Reserve general **TESTCUST01** with active Customer and complete name/KW/city; company **1000**,
reconciliation **110000 — Trade receivables**, payment terms **NET30**, company block unchecked,
reason **Owner customer accounting test**. Future valid form should be CREATED, blank assignments
INCOMPLETE, AP/cash 200000/100000 rejected, no-op/stale behavior protected and history reason/actor.
Company block must not change general or supplier-side flag; different companies stay independent.
Do not create accounting assignments through manual SQL or expect billing/clearing/credit processing.
Journal business-partner width remains 20 vs master 40; align before full subledger integration.
Dunning/interest/tolerances/payment methods remain later slices, not complete FI customer conformance.

Private checkpoint `checkpoints/2026-10-10_1644_UTC/`: DB/source/history/count/hashes. **Publication
result:** Normal AR backend push verified, commit `b5195d03eb0f5e19a6448747eb53810ddbf5223b`;
this confirmation is a documentation-only follow-up. Next B-015 customer company UI/action only.
Owner reviews/sign-off remain pending, not inferred from continuation.


### 26.31 B-015 — Customer company-code maintenance UI `COMPLETE`

Active Customer now links **Customer company code** on `/foundation/partners`. Command
**FIN.CUSTOMER.COMPANY.MAINTAIN** opens partner selection; `view=CUSTOMER_COMPANY`/`company` identify
the scoped AR view. Company selector, server-derived chart/currency spans, valid unblocked CUSTOMER
reconciliation accounts, active payment terms, company block/reason/status and scoped control history.
Independent FIN.CUSTOMER.COMPANY.DISPLAY/MAINTAIN (audit read allowed); Supplier-specific permission
alone cannot maintain AR. General FND authority alone grants no financial access. Server action derives
session tenant/actor, ignores posted chart, independently checks authority and delegates validation/
locking/version to B-014. Customer-only role exposes no active Supplier maintenance; inactive/missing
Customer direct view is refused. Other general/supplier/purchasing branches remain unchanged.

Catalogue **46 capabilities/23 terms/19 aliases**; 51 activities. New customer-company labels use
`custco` namespace: an initial reused `cc.title` collided with an existing company-code label and was
caught by typecheck before deployment, then corrected. No schema migration in this UI slice.

**Verified:** TypeScript/standalone build, IP lint (153 files), **280/280 Vitest tests across 18 files**,
8 Python deployment tests; real T988 Customer-company browser plus Supplier-company and Supplier-
purchasing regressions pass. Customer browser creates a Customer-only general identity through UI,
stages/no-op company view, completes 110000/NET30, maintains NET15, blocks/unblocks, rejects injected
100000 without changing stored AR/version, shows scoped history and denies warehouse financial
form/history; anonymous access redirects. Three added action-security tests cover tenant/actor/chart
forgery, supplier-only authority denial and anonymous requests. Screenshot inspected. Actual owner
host rollout/reviews remain pending; no sign-off or complete AR/billing workflow is inferred.

Original 1 journal/3 materials/5 terms unchanged; general/supplier/customer/purchasing tables empty
outside cleaned fixtures; **20 migrations** unchanged. No reset/schema/stock/owner-host mutation.
Current sandbox process **cairn-330ac069**, 0.0.0.0:3000. Owner update: `git pull` then
`docker compose up -d --build --force-recreate migrate app`, keep private .env.

**Owner manual test/R-23:** use test tenant; TESTCUST01 general Name/KW/city complete, Customer role
active. FND.PARTNER.DISPLAY → record → Customer company code, or FIN.CUSTOMER.COMPANY.MAINTAIN → select
record. Select company 1000. Dummy account **110000 — Trade receivables**, terms **NET30**, company
block unchecked, reason **Owner customer accounting test**. Derived chart normally CAIRN, currency
must equal chosen company (readonly). Save blank account/terms with reason → INCOMPLETE; fill valid
values → CREATED; unchanged save → no version/audit noise. NET15 → MAINTAINED with 30→15 history and
correct actor/reason. Block/unblock → company flag/history, general and supplier flags unchanged.
Other existing company → independent view, no silent copy. Partner can be Supplier+Customer without
AP/AR assignments overwriting one another.

Negative: Cash/AP 100000/200000 must not be offered in AR choices; forged values refused. Inactive
terms excluded/refused. Empty reason blocks. Category/general role absence disables tab/direct
maintenance. Two tabs stale B refuses after A save. Supplier-only/general/warehouse authority cannot
maintain AR; no customer-display authority means no customer accounting history/form. Display-only
finance may read without Save. Sign-out route redirects. Linked accounting prevents casual recon/chart
changes. No sales-area, billing/clearing, dunning/interest or credit processing enabled by this master.
Report tenant/partner/company, inputs/expected/actual and screenshot without credentials.

Private checkpoint `checkpoints/2026-10-10_1708_UTC/` stores DB/source/history/review/hashes. **Publication
result:** Normal AR UI push verified, commit `b8fcd33d68f4d0cddfd797c7cd8e01a2a9048b9e`;
this confirmation is a documentation-only follow-up. Next B-016 Customer sales-area backend only.

### 26.32 B-016 — Customer sales-area backend `COMPLETE · UI PENDING`

Added `customer_sales_area` (**70 tables**), generated immutable `0008_customer_sales_area.sql` plus
additive `9012_customer_sales_area_policies.sql`; **22 applied migrations**. Forced/default-deny RLS,
tenant cascade, and composite references to the stable CUSTOMER role, the existing `sales_area`
(sales org / distribution channel / division), and the delivering `plant`. Primary key is
partner + sales org + distribution channel + division, so one customer keeps independent sales areas.

Fields: optional sales district, delivering plant, pricing procedure code, complete-delivery flag,
order-combination flag, block, staged `sales_status` INCOMPLETE/CREATED/MAINTAINED, version and audit.
A view is **CREATED** only when a delivering plant and a pricing procedure are both set; the two flags
and sales district are optional defaults. Sales district and pricing procedure accept up to six
capital letters or digits and are stored as codes only: no sales-district master exists, and no
pricing-procedure master or condition engine (E8) exists yet, so these codes are not validated
against any reference. They must gain a master-data foreign key when those masters are built.

Save requires an existing active general CUSTOMER role; the sales area, its sales organisation and
that organisation's company code must be active. A delivering plant must be active and belong to the
sales organisation's company code. Saves take the same partner advisory lock as other partner segments
and a row lock, check expected version (stale views refused), preserve no-ops, require a reason, and
record change history under transaction `SALES.CUSTOMER.SALESAREA.MAINTAIN` with security-relevant fields
`deliveringPlant`, `pricingProcedure`, `completeDelivery`, `orderCombination`, `isBlocked`. The B-014
company settings and supplier segments are not modified; Supplier and Customer roles remain independent.

Operational gate `requireCustomerSalesArea` (for future order/delivery services) re-checks general
Customer usability (general data complete and unblocked, role active), segment complete and unblocked,
and the sales-area/organisation/company/plant references at each use. Sales-area blocks affect only that
area; a general partner block affects all areas. Derived sales organisation/company are never copied
onto the segment. No sales order, quotation, delivery, pricing condition, billing, credit or open-item
data is created or enabled.

Catalogue unchanged at **46 capabilities/23 terms/19 aliases; 51 activities**. The transaction code
`SALES.CUSTOMER.SALESAREA.MAINTAIN` is recorded in change history but **is not yet a registered
capability**; B-017 must register it, with its own DISPLAY/MAINTAIN authority, before the screen is
exposed. No registry or navigation change was made in this batch.

**Verified:** `npm run typecheck` clean; `npm run build` passes; IP lint clean (159 files scanned);
**302/302 Vitest tests across 19 files** (22 new in `tests/customer-sales-areas.test.ts`: staging and
completion, derived validation, supplier-only/unknown partner refusal, 9 invalid or inactive-reference
cases without writes, inactive organisation/company at use, no-op/stale history, concurrent version race,
sibling-area block independence, multi-area listing order, general-block and removed-role gates, inactive
plant at use, dual-role company-segment preservation, tenant isolation with default-deny, cascade);
8 Python deployment regressions pass. The Customer company (B-014) suite still passes unchanged.

Verification ran in a new local PostgreSQL 18 cluster created inside this sandbox for this batch (test-only
tenants, reference data seeded; no owner or previously checkpointed database was touched). Preservation
counts for owner data therefore cannot be evidenced from this batch. Nothing was reset, reseeded or
mutated outside the test fixtures, and no owner-host operation was performed.

**Owner update (R-23):** `git pull`, then `docker compose up -d --build --force-recreate migrate app`,
keeping the private `.env`. Confirm additive migrations `0008`/`9012` apply (22 total) and that the
existing general, supplier and customer company screens still work. There is no new screen to check
yet; do not add sales-area rows through SQL.

**Future B-017 test data (reserved, not created):** TESTCUST01 active Customer; sales area **1000 / 01 / 01**
(standard "Direct sales — manufactured products"); delivering plant **1000**; pricing procedure **RVAA01**
(dummy code); sales district **KW01** (optional); complete-delivery and order-combination off; reason
**Owner customer sales-area test**. Expected: blank plant or pricing procedure → INCOMPLETE; both set →
CREATED; plant from another company, inactive plant, unknown sales area or sales district/procedure
longer than six characters → refused; stale and unchanged saves behave as in §26.31; block affects only
this sales area. Sales-area change guards for linked order/delivery documents are not built and must be
added before those documents exist.

Private checkpoint not created in this batch. Next **B-017 customer sales-area UI** only.


### 26.33 B-017 — Customer sales-area maintenance UI `COMPLETE · AUTOMATED BROWSER ACCEPTANCE PASSED · OWNER WALKTHROUGH REPORTED PASSED (§26.114)`

An active Customer partner now has a **Sales area** tab on `/foundation/partners`, replacing the former
pending placeholder. Command **SALES.CUSTOMER.SALESAREA.MAINTAIN** opens selection; `view=CUSTOMER_SALES`
and `area=ORG/DC/DIV` identify the segment. The selector lists only active sales areas whose sales
organisation and company code are active; an unknown or missing `area` falls back to the first choice.

Fields: sales area and organisation (readonly), company code and currency (readonly, derived), delivering
plant (active plants of that company code only), pricing procedure code, sales district code, complete-
delivery and order-combination flags, block, required reason, saved status and version. New records start
blank. Unchanged saves report "No customer sales-area data changed." Read-only users see the stored values
without a Save control. Pricing procedure and sales district are normalised to capitals by the server action.

Authority: **SALES.CUSTOMER.SALESAREA.DISPLAY** (audit read allowed) and **…MAINTAIN** are separate capabilities.
FIN.CUSTOMER.COMPANY authority alone does not expose or change sales-area data, and the reverse is also true.
Server action derives tenant and actor from the session; posted values are validated by the B-016 service,
which also owns locking, version and history. Customer role missing
or inactive hides the segment link, and direct access shows the role-required message; the sales-area history uses the same scoped history panel as other segments.

Registration: the two capabilities and the term-registry entry `SALES.CUSTOMER.SALESAREA.MAINTAIN` (route
`/foundation/partners?view=CUSTOMER_SALES`, search aliases VD02/VD03 only) were added to the seed catalogue.
Catalogue is now **48 capabilities / 24 terms / 21 aliases**; 51 activities unchanged. **Existing databases
must run `npm run seed` once** after the update so the new capabilities and term exist; the role that
should maintain sales areas needs the capability granted through the normal role administration.

**Verified:** typecheck and IP lint (161 files) clean; `next build` passes; **306/306 Vitest tests across 19
files** (3 new action-security tests: tenant/actor derivation and code normalisation with forged tenant/
actor, AR-only authority denial, anonymous redirect; 1 new choice-list test: active areas only, company-
scoped plants, unknown-key fallback); 8 Python deployment regressions pass; Customer-company (B-014/15)
suite still passes. **Server-rendered check** against a running dev server with three isolated test users
in a fresh verification tenant: maintainer sees the form, Save, plant/procedure/district fields and the
1000/01/01 choice; display-only reader sees the values with the read-only notice and no Save; a user with
only unrelated stock authority sees the authority message; general, company-code and unknown-area requests
return 200; the Customer company view still renders. **Not run at the time:** a browser-driven save/history acceptance.
At B-017 implementation time, this sandbox had no Chromium and the Playwright browser download host was
outside the allowed network, so no browser target was added for that batch. Action-level save behaviour
is covered by the Vitest action tests. The focused B-024 maintainer-flow browser target has since passed
(§26.40); it does not repeat user switching for display-only or finance-only denial. The original
server-rendered role checks and accounting-only action denial above remain the recorded automated
coverage for those boundaries. The owner later reported the B-024 walkthrough passed; see §26.114.
No per-step notes or environment details were supplied.

Verification data lived only in a throwaway test tenant created for this batch in the sandbox database.
No owner data was touched, and no migration was added in this batch (still 22 applied migrations).

**Owner update (R-23):** `git pull`, then `docker compose up -d --build --force-recreate migrate app`, keeping
the private `.env`. Run the seed step (`npm run seed` with the migration connection) once so the two new
capabilities and the term entry exist. Then, for a test tenant, select customer **TESTCUST01** with
an active Customer role. Open the Sales area tab, choose **1000 / 01 / 01**, select delivering plant **1000**,
enter pricing procedure **RVAA01** (dummy code), reason **Owner customer sales-area test**, and save: expected
Created. Blank plant or procedure: Incomplete. Unchanged save: no new version. Lowercase `rvaa01` is shown
and stored as RVAA01. Block/unblock affects only that area. Sign in with a display-only user: values visible,
no Save. Sign in with a user holding only FIN.CUSTOMER.COMPANY authority: the sales-area form is refused.
Do not create sales-area rows through SQL.

**Limitations:** sales-district and pricing-procedure codes have no master yet; no pricing condition engine,
sales order, delivery, billing, credit or open-item behaviour is enabled; no sales-area change guard exists
for linked order/delivery documents because none exist yet.

Private checkpoint not created in this batch. Next: **B-018**, to be declared at the start of the next
bounded batch. Candidates from the remaining Customer and partner scope: customer company payment-method
and dunning-procedure segment fields, partner function relationships, or the next Phase 1 master in §25.3.

### 26.34 B-018 — Customer company payment-methods and dunning-procedure fields, backend `COMPLETE · UI PENDING (B-019)`

Chosen from the §26.33 candidates: the payment-method and dunning-procedure segment fields of the
customer company-code view, **backend only**, continuing the backend→UI batch pattern.

**Schema:** one additive migration `0009_customer_company_payment_dunning.sql` adds two nullable
columns to `customer_company_code`: `payment_methods` varchar(40) and `dunning_procedure` varchar(4).
**23 applied migrations**; forced RLS/default-deny, grants and cascade behaviour are unchanged because
the table's policies already cover the new columns. No new table, no new capability, no seed change:
the fields belong to the existing `FIN.CUSTOMER.COMPANY.DISPLAY/MAINTAIN` authority scope and the
existing `FIN.CUSTOMER.COMPANY.MAINTAIN` transaction code.

**Semantics (service layer, `saveCustomerCompany`):**
- **Payment methods** are stored as a normalised set: input is split on commas/spaces, trimmed,
  capitalised, deduplicated and sorted, then joined with commas (for example ` t , c,C ` → `C,T`).
  Each code must be one or two capital letters/digits; at most ten codes. Reordered or duplicated
  input therefore compares equal and is reported as "No customer company data changed." Blank clears.
- **Dunning procedure** is one code of up to four capital letters/digits, capitalised server-side
  (for example `ma04` → `MA04`). Blank clears.
- Both are **code-only**: no payment-method master (§14.6 SCR-036) and no dunning-procedure master
  exist yet, so nothing is foreign-keyed; validation is format-only, as with pricing-procedure and
  sales-district codes in the B-016 sales area.
- Fields join the existing staged-save pipeline: same advisory/row locking, optimistic version,
  no-op preservation, reason requirement, change-document snapshot (both fields are flagged
  security-relevant in history, §16.3) and tenant RLS. They do **not** affect the completeness gate:
  status is still driven by reconciliation account + payment terms, and `requireCustomerCompany` is
  unchanged. Payment runs and dunning execution remain R-14/§14.6 work, not this slice.
- The server action forwards both fields (capitalised) from form data; absent form fields read as
  blank, which matches current database state, so existing behaviour is untouched until the B-019
  form exposes the inputs.

**Verified:** typecheck and IP lint (**162 files**) clean; `next build` passes; **315/315 Vitest
tests across 19 files** in a freshly provisioned development cluster (23 migrations, bootstrap, dev
tenant) — 9 new customer-company tests: normalisation, reorder-no-op, dunning-only change with
version bump and security-relevant history item, blank-clear preserving payment methods, refusal of
long/oversize/over-count codes without writing, and completeness-gate independence; 8 Python
deployment regressions pass; customer sales-area (B-016/17) suite still passes. **Not run:** a
browser-driven check — the fields have no form controls yet (that is B-019), and this sandbox has no
Chromium.

No owner data was touched; verification used isolated test tenants only. No private checkpoint was
created in this batch.

**Owner update (R-23):** `git pull`, then `docker compose up -d --build --force-recreate migrate app`,
keeping the private `.env`. Confirm migration `0009_customer_company_payment_dunning.sql` applied
(23 total). **No reseed is required** — no new capabilities or terms. No new UI is visible in this
batch: the Customer company tab works exactly as before; the payment-method and dunning-procedure
inputs appear with B-019. Manual browser checks for this batch are therefore limited to regression:
open the Customer company tab for an existing customer, save with a reason, and confirm the usual
Created/unchanged behaviour. Do not set the new columns through SQL.

**Limitations:** payment-method and dunning-procedure masters do not exist; no payment run, dunning
run, interest calculation, tolerance or open-item behaviour is enabled; the fields are not yet
snapshot-consumed by any document service because no AR documents exist yet. Interest indicator and tolerance group (§9.2) were left for later slices; B-020 now addresses their
code-only backend storage in §26.36.

Next: **B-019**, to be declared at the start of the next bounded batch. Natural candidate: the
matching **UI** for these two fields on the Customer company tab; other candidates remain partner
function relationships or the next Phase 1 master.

---

### 26.35 B-019 — Customer company payment-method/dunning UI `COMPLETE · AUTOMATED BROWSER ACCEPTANCE PASSED · OWNER WALKTHROUGH REPORTED PASSED (§26.114)`

**Scope:** expose the B-018 `payment_methods` and `dunning_procedure` fields on the existing
Customer company-code view. This is UI wiring only: no schema/migration, route, capability, term/master
seed, payment execution or dunning execution was added. No new authority is created; the existing
`FIN.CUSTOMER.COMPANY.DISPLAY` / `FIN.CUSTOMER.COMPANY.MAINTAIN` boundary remains in force.

**UI:**
- `CustomerCompanyPanel` now receives both persisted fields from the tenant-scoped customer-company
  record. Maintainers get editable controls; authorised display-only users get read-only values. A user
  without the existing display authority still receives neither field nor value.
- Payment methods accept a comma/space-separated set of up to ten unique one- or two-character
  alphanumeric codes. The backend continues to canonicalise case/order/deduplication; blank clears it.
  Dunning procedure is an optional one-to-four-character alphanumeric code, canonicalised by the
  existing service; blank clears it. The form's labels and shared help text explain that these are
  code-only values and the master data does not exist yet.
- Both values travel through the existing authenticated server action, staged save, optimistic
  version/no-op check and security-relevant change history. They do not change the completion or
  operational gate, which remains driven by reconciliation account and payment terms. No payment run,
  dunning run, billing, clearing or sales document is enabled.
- The existing isolated customer-company browser target now exercises canonical persistence, reload
  display, reordered-input no-op, history and denial of code values to a non-finance user. The existing
  action-security test now submits these fields through the session-derived action.

**Verification at implementation time:** `npm run typecheck`, `npm run build`, `npm run lint:ip` (162
files) and `npm run test:browser-harness` (**58/58**) passed. The browser/DB acceptance was not run then
because PostgreSQL was unavailable. The combined customer-company browser target subsequently passed
in B-023 against the isolated development database (§26.39). No owner/production data was used; no
migration or reseed is required for this UI slice. The owner later reported the walkthrough passed; see §26.114.

**Owner manual test (R-23):** in a development/test tenant, open an active Customer partner such as
`TESTCUST01` → **Customer company code** → company `1000`. Keep reconciliation `110000` and terms
`NET30`; do not use real payment/dunning data. Enter payment methods `t, c,C`, dunning procedure `ma04`,
and reason `Owner payment/dunning UI test`; save. Expect the controls to reload as `C,T` and `MA04`,
version to increase once, status to remain based on the account/terms, and change history to show both
fields as security-relevant. Save reordered `T C` and `MA04` with a new reason: expect “No customer
company data changed” and no version increment. Clear both values with a reason: expect blank fields and
one version/history change, without changing the completeness rules.

Negative/access checks: eleven unique method codes, a method code longer than two characters, or
non-alphanumeric code text must be refused without changing saved data; a dunning value containing
punctuation must be refused (the input itself is capped at four characters). Missing reason blocks save.
A display-only finance user can see the saved codes but has no Save control; a user without customer
company display authority cannot see the codes/history; signed-out access redirects. These fields are
not yet consumed by any invoice/payment/dunning service.

At B-019 close, B-020 was selected and is now complete; B-021 UI is also implemented. The combined
B-019/B-021 automated customer-company browser target passed in B-023 (§26.39). The owner later
reported the customer-company walkthrough passed (§26.114).


### 26.36 B-020 — Customer company interest-indicator and tolerance-group fields, backend only `IMPLEMENTED · DATABASE ACCEPTANCE PASSED IN B-022`

**Scope:** optional code-only defaults on the existing Customer company-code segment, as listed in
§9.2. This is a backend slice only: no controls were added to the Customer company screen. No interest
indicator/tolerance master, foreign key, calculation, tolerance enforcement, invoice/open-item/payment
behavior, capability, transaction code or seed change is implied.

**Schema and migration:** `customer_company_code` now declares nullable `interest_indicator` and
`tolerance_group`, both varchar(4). The additive migration is
`drizzle/0010_customer_company_interest_tolerance.sql`; it follows and does not rewrite the existing
`0009_customer_company_payment_dunning.sql`. The migration runner applies SQL files in lexical order
and checksum-locks applied files. Tenant RLS, grants, keys and cascades are unchanged.

**Service semantics:**
- Each field is an optional one-to-four-character alphanumeric code. The service trims and uppercases
  it (` i1 ` → `I1`); blank/whitespace normalises to `null`; punctuation and values longer than four
  characters are rejected. No master validation or foreign key exists yet.
- An explicitly supplied blank clears a stored value. An omitted field is different: it preserves the
  existing value. The server action checks `FormData.has()` so older Customer company forms that do
  not submit these new controls cannot accidentally erase data. A new row with an omitted field stores
  `null`.
- When supplied, both values use the existing staged-save/optimistic-version/no-op pipeline and are
  included in before/after change history as security-relevant fields. Case/whitespace-only edits are
  no-ops; real changes bump the version. The accounting completeness status and operational gate
  remain based on the existing reconciliation-account/payment-terms rules; these defaults neither
  complete nor block a segment.
- The existing `FIN.CUSTOMER.COMPANY.DISPLAY` / `FIN.CUSTOMER.COMPANY.MAINTAIN` authority remains the
  sole boundary. No UI-visible behavior changes in this batch.

**Tests and verification:** a pure normalization suite was added to the browser harness. The DB-backed
customer-company tests cover canonical save, security-relevant history, case-only no-op, omitted-value
preservation, blank clear, invalid values and completeness-gate independence. The action-security test
also verifies that the existing form path forwards explicit codes and that a legacy form omitting them
preserves them. **At B-020 implementation time:** `npm run typecheck`, `npm run build`, `npm run lint:ip`
(164 files), `npm run test:browser-harness` (**64/64**) and `git diff --check` passed; PostgreSQL was
unavailable then. **Subsequent DB acceptance:** B-022 applied the migrations and ran the customer-company
and action-security suites against an isolated local PostgreSQL 17.11 database; **65/65 tests passed**
(§26.38). No owner or production database/tenant was used.

**Owner update:** migration 0010 was applied only to the isolated local test database in B-022. Other
development/test deployments should apply it through the normal migration service; it is the 24th SQL
migration when starting from 0000. No reference reseed is required by this schema change. The current
screen intentionally has no interest/tolerance inputs, so these values became user-maintainable only in
the later B-021 UI slice. Do not set them through production SQL.

**Limitations:** values are format-checked codes only. There is no master lookup, interest calculation,
interest posting, tolerance calculation/enforcement, open-item processing, billing or payment use. DB
migration/service/action acceptance passed in the isolated test database; browser acceptance passed in
B-023, and the owner-reported walkthrough outcome is recorded in B-097 (§26.114).

At B-020 close, **B-021** was selected and is now implemented (§26.37). B-022 database acceptance
passed (§26.38), and B-023 automated browser acceptance has since passed (§26.39). The owner walkthrough
was still pending at this point and was later reported passed in B-097 (§26.114).


### 26.37 B-021 — Customer company interest-indicator/tolerance-group UI `IMPLEMENTED · AUTOMATED BROWSER ACCEPTANCE PASSED · OWNER WALKTHROUGH REPORTED PASSED (§26.114)`

**Scope:** expose the B-020 `interest_indicator` and `tolerance_group` values on the existing Customer
company-code panel. UI wiring only: no schema, migration, service rules, route, capability, seed, master
lookup, interest calculation or tolerance enforcement change. Existing
`FIN.CUSTOMER.COMPANY.DISPLAY` / `FIN.CUSTOMER.COMPANY.MAINTAIN` authorities remain the only access
boundary.

**UI and behavior:**
- The tenant-scoped persisted values are included in the panel props. Maintainers get optional text
  inputs capped at four characters and constrained to letters/digits; blank is allowed to clear a
  value. The existing B-020 service remains authoritative for trimming, uppercasing, validation,
  no-op/version handling and security-relevant change history.
- Authorised display-only finance users see the two values as read-only text and have no Save control.
  A user without Customer company display authority still does not receive the segment, code values or
  its history. No new authority or registry entry was added.
- Shared help text now identifies all four payment/dunning/interest/tolerance values as format-checked
  codes only, and states that their masters and execution/calculation behavior are not available.
- The customer-company browser target now exercises interest/tolerance canonical save, persisted
  reload, canonical no-op, blank clear and restore, security-relevant history, display-only read access
  without edit controls, and denial to a non-finance user. The DB-backed target was not run during B-021;
  B-022 subsequently prepared the isolated database and verified the underlying service/action behavior.

**Verification at implementation time:** `npm run typecheck`, `npm run build`, `npm run lint:ip` (164
files), `npm run test:browser-harness` (**64/64**) and `git diff --check` passed. B-022 later applied the
migrations and passed 65 customer-company/action-security DB tests (§26.38). The B-023 Playwright target
`npm run smoke:browser:customer-company` has now passed against a development fixture (§26.39). The
owner later reported the customer-company walkthrough passed (§26.114). No owner/production database
or tenant was used.

**Owner manual test (R-23):** after the B-020 migration 0010 is applied in a development/test tenant,
open active customer `TESTCUST01` → **Customer company code** → `1000`. With the existing valid account
and terms, enter interest indicator `i1` and tolerance group `t1` and save with a reason. Expect `I1` and
`T1` after reload, one version increment, and both fields flagged in change history. Resave lowercase
`i1` / `t1` and expect no version increment; clear both explicitly and expect null/blank values with
one version/history update, without changing segment completeness or operational eligibility. A
finance display-only user must see the values but have no Save control; a user with no Customer company
display authority must not see the values or history. Punctuation or values longer than four characters
must be rejected by the service; the inputs also provide browser constraints.

**Deployment:** B-021 itself adds no migration and needs no reseed. When deploying the combined B-020/B-021
state, apply migration 0010 using the normal migration service first (24 total if the 23-migration B-018
baseline is current). Do not write values through production SQL.

**Limitations:** codes are not validated against masters; they do not drive interest calculation/posting,
tolerance calculation/enforcement, open-item handling, billing, payment or dunning. No document service
consumes them yet.

The B-024 focused automated sales-area target has passed (§26.40). The owner subsequently reported both
B-023 and B-024 walkthroughs complete with all checks passed (§26.114). B-025 follows the completed
automated acceptance gates; other M1 acceptance criteria remain governed by §24.1.


### 26.38 B-022 — B-020 migration and database acceptance `COMPLETE · ISOLATED TEST DATABASE`

**Isolation:** Provisioned a fresh PostgreSQL 17.11 cluster for this workspace only. The application
server listens on loopback `127.0.0.1:55432`; the dedicated database is `cairn_b022_test`, with a
superuser migration role (`cairn`) and a restricted application role (`cairn_app`, no `BYPASSRLS`).
The instance is isolated from owner/production data and uses no production host or credentials. Local
test connection settings are kept outside the repository under `/home/user/.arena/cairn-b022.env`;
that file is not part of Git. The database server is left running for the next B-023 browser batch.

**Migration and reference setup:** `npm run db:migrate` applied all **24 migrations** in lexical order,
including `0010_customer_company_interest_tolerance.sql` and the RLS/policy migrations through 9012.
The normal migration runner recorded each checksum. `npm run seed:reference` populated 30 countries,
26 currencies and 21 units of measure; no tenant fixture or owner data was imported.

**Acceptance:** `npm run test -- tests/customer-companies.test.ts tests/action-security.test.ts` passed:
**2 files, 65/65 tests**. This covers customer-company create/change/no-op/clear/version/history,
B-020 normalization and validation, completeness independence, tenant isolation, and session-derived
action/security boundaries. Test fixtures ran only in the dedicated disposable database and cleaned up.

**Result / next:** B-022 is complete. Migration 0010 and the B-020 service/action acceptance passed in
this isolated PostgreSQL environment. At B-022 close, the B-019/B-021 customer-company browser target
had not yet run; it subsequently passed in B-023 (§26.39). The owner walkthrough had not yet been
recorded at that time; the owner later reported B-023/B-024 walkthroughs complete with all checks passed
(§26.114). Do not apply this local database or its test data to an owner/production tenant.


### 26.39 B-023 — B-019/B-021 customer-company browser acceptance `AUTOMATED PASS · OWNER WALKTHROUGH REPORTED PASSED (§26.114)`

**Environment and fixture:** ran `npm run smoke:browser:customer-company` with the isolated B-022
PostgreSQL database and local development app. Playwright Chromium 156 (Playwright revision 1248) was
installed for this acceptance. The harness created development fixture tenant `T988` through the UI,
with the reserved name `Browser verification tenant`; it did not use an owner tenant or any existing
customer records. The harness removed the fixture in cleanup, and a follow-up query confirmed zero
matching `T988` fixture rows remain. Test data was disposable, as authorised by the owner.

**Result:** the target passed with exit code 0 and no browser page errors. It verified UI onboarding;
customer-company accounting staged/completed/blocked lifecycle; B-019 payment-method/dunning values;
B-021 interest/tolerance canonical save, persisted reload, no-op, explicit clear/restore and version
behavior; security-relevant change history; invalid reconciliation-account refusal; finance display-only
access without Save controls; denial of values/history to non-finance users; and signed-out protection.
The run also confirmed the fixture had no hidden accounting number ranges.

**Owner walkthrough:** on 2026-10-12, the owner confirmed the B-023 and B-024 walkthroughs were complete
and selected “All checks passed” (§26.114). No per-step evidence or environment details were supplied;
this is an owner-reported result, not an independent re-run. The procedures remain documented in
§26.35, §26.37 and §26.33.


### 26.40 B-024 — B-017 customer sales-area browser acceptance `AUTOMATED PASS · OWNER WALKTHROUGH REPORTED PASSED (§26.114)`

**Environment and fixture:** ran `npm run smoke:browser -- --target customer-sales-area` against the
isolated B-022 PostgreSQL database and local development app using Playwright Chromium. The harness
created development fixture `T987` through onboarding, then created customer `TESTCUST01` through the
UI. The target exited **0** within its 120-second deadline with no browser runtime errors. Harness
cleanup completed; a follow-up query found **zero** `T987` rows matching the reserved fixture name and
development flag. Only disposable development data was used; no owner/production tenant or data was touched.

**Browser acceptance:** verified tenant onboarding has no hidden accounting intervals; UI creation and
opening of an active Customer partner; active sales area `1000/01/01` and delivering-plant choice `1000`;
staged save as Incomplete (version 1); completed save as Created (version 2) with plant `1000`,
canonicalised pricing procedure `RVAA01`, sales district `KW01`, and both delivery flags; persisted UI
readback after submitting the sales-area selector GET; canonical no-op without a version increment;
area-scoped block/unblock; and security-relevant change history, including the pricing-procedure control
change. The browser harness also verified signed-out access redirects from `/foundation/partners` and
reported no page errors.

**Coverage boundary and owner walkthrough:** this target exercises the authorised maintainer lifecycle;
it does not switch to display-only or finance-only users in the browser. The original B-017
server-rendered role checks and accounting-only action denial remain documented in §26.33. The owner
later reported the B-024 manual walkthrough complete with all checks passed (§26.114); no per-step
evidence or environment details were supplied. This outcome is limited to B-023/B-024 and does not
constitute overall M1 sign-off.

**Verification after the target:** `npm run typecheck`, `npm run test:browser-harness` (**65/65 across 5
files**) and `git diff --check` passed. No application/schema/migration changes were made for B-024.


### 26.41 B-025 — Supplier purchasing partner-function semantics `APPROVED · B-026–B-032 IMPLEMENTED · B-033 BROWSER ACCEPTANCE PASSED · PO DETERMINATION PENDING`

**Scope:** decision capture only. No schema, service, UI, capability, seed, migration or transaction
behavior is added here. Implementation remains subject to the bounded batch discipline in §25.4.

**Owner-approved semantics:**
- **Roles:** the supplier being maintained is the implicit primary/fallback partner. The purchasing-
  organisation assignment set is limited to an ordering address, goods supplier, and invoicing party.
  Do not add a separate pay-to partner in this slice. Use Cairn-owned product labels and keys; do not
  copy proprietary reference-system codes or names (§4, R-01).
- **Direction:** assignments are directed from the focal supplier and purchasing organisation to the
  related supplier. Do not create a reciprocal relationship automatically; maintain the other supplier's
  outbound assignment separately if required.
- **Cardinality/default:** each role has a configured unique-or-multiple rule. A unique role allows at
  most one assigned partner for the focal supplier and purchasing organisation. A multiple role allows
  several; at most one may be marked default. If none is default, the user chooses among eligible partners
  when a consuming transaction is introduced.
- **Validity and scope:** this M1 slice stores the current purchasing-organisation assignment only. No
  valid-from/to dates; replacing a current assignment uses the ordinary version/audit history. Defer
  plant- and supplier-sub-range-specific overrides.

**Reference basis:** SAP Help describes the primary vendor as the fallback plus ordering-address,
goods-supplier and invoicing-party roles, with purchasing-organisation data and more-specific plant or
supplier-sub-range variants. [SAP Help — Partner Roles in Purchasing](https://help.sap.com/docs/SAP_ERP/967e1c2a6a8c4183b7e07d28e7574445/c080b65334e6b54ce10000000a174cb4.html).
SAP Learning describes the configurable unique/multiple behavior, optional default, and selection when
multiple partners exist without a default. [SAP Learning — Using Partner Functions in Purchasing](https://learning.sap.com/courses/purchasing-in-sap-s-4hana/using-partner-functions-in-purchasing).
These sources inform workflow semantics only; Cairn keeps its own vocabulary and codes.

**Implementation status:** B-026 added the tenant-scoped schema and forced RLS (§26.42), intentionally
without catalogue rows. B-028 seeds the approved Cairn-owned functions and explicit initial cardinality settings into
standard-package tenant activation (§26.44). B-029 adds the audited assignment write service and
cardinality/default enforcement (§26.45); B-030 adds session-derived protected actions (§26.46), B-031
the read panel (§26.47), and B-032 the assignment editor (§26.48). B-033 browser acceptance passed (§26.49);
PO determination remains pending.


### 26.42 B-026 — Supplier partner-function schema and tenant RLS `COMPLETE · WRITE SERVICE ADDED IN B-029`

**Scope:** storage only for the B-025-approved directed supplier purchasing-organisation assignments.
Added `supplier_partner_function` for each tenant's role name, active flag and unique/multiple policy,
and `supplier_purchasing_partner` for owner supplier, purchasing organisation, function, related Supplier,
default flag, version and audit columns. Cairn-owned function keys are `ORDERING_PARTNER`,
`DELIVERY_PARTNER`, and `INVOICE_SENDER`; the SQL constraint rejects unapproved keys. Composite foreign
keys bind owner, related Supplier and function to the same tenant. A partial unique index guarantees at
most one default for a supplier/function/organisation. No valid-from/to columns or plant/sub-range scope.

Added immutable `drizzle/0011_supplier_purchasing_partners.sql` and
`drizzle/9013_supplier_purchasing_partner_policies.sql`; registered the TypeScript schema in the
Foundation schema root. Both new tables use ENABLE + FORCE RLS with default-deny tenant policies and
restricted `cairn_app` grants. The app role was verified `NOSUPERUSER NOBYPASSRLS`. Dynamic unique-versus-
multiple enforcement, tenant catalogue seeding, actor-derived service writes, version locking and change
history are **not** implemented in this batch. No PO or other transaction behavior was added.

**Database verification:** provisioned a fresh isolated PostgreSQL 17.11 cluster on loopback port 55432
and dedicated empty `cairn_b026_test`; applied all **26 migrations**, including 0011 and 9013. Confirmed
both tables have row security and FORCE enabled, the default-only unique index exists, the app role has no
RLS bypass, an unscoped read sees zero rows and an unscoped write is denied by RLS. No tenant/business
fixtures, owner/production data, or credentials from outside this disposable environment were used.

**Verification:** `npm run typecheck`, `npm run test:browser-harness` (**65/65 across 5 files**) and
`git diff --check` passed. At B-026 completion the catalogue had no tenant rows; B-028 later seeds
standard-package tenants with the approved initial settings (§26.44), and B-029 later adds assignment
writes (§26.45). Tenant-level configuration UI remains pending.


### 26.43 B-027 — Supplier partner-function read services `COMPLETE · WRITE SERVICE ADDED IN §26.45`

**Scope:** added tenant-scoped query functions only in
`src/modules/foundation/supplier-purchasing-partners.ts`. `listSupplierPartnerFunctions` returns the
configured catalogue, including inactive rows for maintenance/review. `listSupplierPurchasingPartners`
returns the chosen supplier/purchasing-organisation assignments with function labels/cardinality,
default/version, and linked Supplier name/status/block/role-active state. Inactive links remain visible
for correction rather than being silently hidden. Both queries explicitly scope by tenant; the assignment
query also filters by focal supplier and purchasing organisation and orders by function, default, and
related supplier. No writes, UI, action, capability, seed, or cardinality default was added.

**Database acceptance at B-027 completion:** `npm run test -- tests/supplier-purchasing-partners.test.ts`
passed **2/2 tests** on the isolated B-026 PostgreSQL database. It verified configured and inactive
function rows, assignment labels/default/order and linked Supplier state, empty results for another
tenant/organisation, and unscoped default-deny reads. B-028 later extended the same test file (§26.44). Fixtures are development tenants created through the test helpers and are
removed by teardown.

**Verification:** `npm run typecheck` passed. No schema or migration change was needed. At B-027 completion
the catalogue was still unseeded; B-028 later adds standard-package initialization (§26.44), and B-029
later adds mutation/cardinality enforcement (§26.45). Protected UI and browser acceptance remain pending.


### 26.44 B-028 — Supplier partner-function catalogue initialization `COMPLETE · ASSIGNMENT WRITES ADDED IN §26.45`

**Scope:** added the three Cairn-owned supplier partner-function definitions to the versioned standard
tenant configuration package, now `INTL-STD-2`. Initial `allows_multiple` is explicitly `false` for
`ORDERING_PARTNER`, `DELIVERY_PARTNER`, and `INVOICE_SENDER`, as selected by the owner for all three
roles. Cairn labels are “Ordering partner”, “Delivery partner”, and “Invoice sender”. The seed is
idempotent and only inserts missing rows; it does not overwrite existing tenant settings when the package
is reapplied. It runs in the existing tenant-scoped package transaction and records the catalogue count in
the package change document.

No partner assignments, default assignments, UI, mutation service, cardinality enforcement, schema
change, migration, or transaction determination behavior was added. `is_default` remains false unless a
future assignment is explicitly made default; choosing a cardinality setting does not designate a partner.
Existing tenants are not globally backfilled by this change; the definitions are inserted when the standard
package runs or is reapplied for that tenant. B-029 subsequently adds assignment writes (§26.45).

**Verification:** `npm run typecheck`, the supplier partner-function database suite (**4/4**), and the
full `npm run test` suite (**335/335 across 21 files**) passed. The focused suite checks the three exact
seeded function keys/labels/initial values, confirms package re-application preserves tenant edits, retains
a tenant-level multiple-rule fixture for B-027 reads, and verifies scoped assignment queries.
`npm run test:browser-harness` (**65/65**) and `git diff --check` passed. No migration was needed; testing
used only disposable development tenants in the isolated B-026 PostgreSQL database.


### 26.45 B-029 — Supplier purchasing partner assignment write service `COMPLETE · EDITOR / BROWSER ACCEPTANCE PASSED IN §26.49`

**Scope:** added `src/modules/foundation/supplier-purchasing-partner-writes.ts` with tenant-scoped,
audited create/update, atomic replacement and removal operations. Writes require an existing focal Supplier
role and purchasing-organisation segment, an active purchasing organisation and function, and an active
related Supplier role in the same tenant. The fixed `SUPPLIER` relation remains enforced by the schema.
There are no effective dates, plant/sub-range overrides, reciprocal links or separate pay-to role.

**Cardinality and defaults:** the service takes the active function's tenant configuration under lock and
serializes writes per focal supplier / purchasing organisation / function. `allows_multiple=false` permits
at most one assignment; a second is rejected. `allows_multiple=true` permits several and does not auto-pick
a default. At most one multiple-role assignment may be default: explicitly choosing another transfers the
default atomically and versions/audits the previous default. No default is promoted when a default is
removed. A unique function cannot be marked default; a single unique assignment is the only choice and the
approved optional-default rule applies to multiple-valued functions.

**Concurrency/audit:** expected version is `0` for create and the current row version for update, replace or
remove. Stale edits fail with a reload remedy. Replacing is transactional, versions the new row from the
replaced row, and records removal plus creation history; default transfers version and audit both affected
rows. No-op saves do not write history. The optional default is never inferred from insertion order.

**Verification:** `npm run typecheck`, `npm run test -- tests/supplier-purchasing-partner-writes.test.ts`
(**4/4**), the full Vitest suite (**339/339 across 22 files**), the browser harness (**65/65**) and
`git diff --check` passed. DB tests cover unique rejection, multiple assignment with no default, default
transfer, version conflicts, atomic replacement/removal, supplier/function/segment validation, concurrent
unique-role adds, change history and tenant isolation. Testing used only disposable development tenants in
the isolated B-026 PostgreSQL database. No schema/migration, action, capability, UI, or PO determination
behavior was added in B-029; B-030 later adds session-derived protected server actions (§26.46). B-031 adds display-only UI (§26.47), and B-032 adds assignment controls (§26.48); browser acceptance and PO determination remain pending.


### 26.46 B-030 — Protected supplier partner-function server actions `COMPLETE · BROWSER ACCEPTANCE PASSED IN §26.49`

**Scope:** added `src/app/foundation/partners/partner-function-actions.ts`. The read action returns the
Cairn-owned catalogue and scoped supplier/purchasing-organisation assignments only when the session has
`PROC.SUPPLIER.PURCHASING.DISPLAY`, `PROC.SUPPLIER.PURCHASING.MAINTAIN`, or `AUDIT.WORKSPACE`. Save
and remove actions independently require `PROC.SUPPLIER.PURCHASING.MAINTAIN`. Each action requires a
verified session; tenant and audit actor come only from that session. Forged `client`/`changedBy` form
values are ignored. Mutations revalidate `/foundation/partners`. No new capability was needed; the existing
purchasing authority boundary is reused.

**Verification:** extended `tests/action-security.test.ts` for tenant/actor derivation, a display-only read,
maintain-only mutation denial, anonymous requests, scoped readback and audit actor. Focused action-security
tests pass **30/30**; full Vitest passes **342/342 across 22 files**. `npm run typecheck`, `npm run build`,
browser harness (**65/65**), IP lint (**172 files**) and `git diff --check` passed. No UI,
capability/schema change, migration or PO determination was added in B-030. B-031 later adds a display-only panel (§26.47), and B-032 adds assignment editing (§26.48); browser acceptance remains pending.


### 26.47 B-031 — Supplier partner-function read panel `COMPLETE · EDITOR / BROWSER ACCEPTANCE PASSED IN §§26.48–49`

**Scope:** added `SupplierPartnerFunctionsPanel` to the existing `SUPPLIER_PURCHASING` view. The
server-rendered panel groups assignments by configured function and shows Cairn label/code, unique or
multiple setting, inactive-function state, assigned Supplier number/name/status, inactive-role or block
indicators, and the default marker. It explains the focal Supplier fallback, shows an explicit empty state,
and, for multiple assignments with no default, states that a consuming transaction must ask the user to
choose. Text is routed through the i18n catalogue.

The page fetches catalogue and assignment rows only when the selected partner has an active Supplier role
and the session holds purchasing DISPLAY/MAINTAIN or AUDIT.WORKSPACE authority. Tenant scope comes from
the server session. The panel is display-only: no add/replace/remove controls were added in this slice.

**Verification:** typecheck, full Vitest (**342/342 across 22 files**), browser harness (**65/65**),
production build, IP lint (**173 files**) and `git diff --check` passed. No dedicated live-browser acceptance of this panel has run yet. B-032 later adds the assignment editor (§26.48); browser acceptance remains a separate batch. No schema/migration, service, action or PO determination changes were made in B-031.


### 26.48 B-032 — Supplier partner-function assignment editor `COMPLETE · BROWSER ACCEPTANCE PASSED IN §26.49`

**Scope:** extended the Supplier Purchasing partner-function panel for maintainers. A unique function with
no current assignment can add one; with one current row it can atomically replace it. If legacy data has
multiple rows under a unique function, the UI blocks add/replace and offers row-level removal to resolve
it. Multiple-valued functions can add distinct Suppliers, optionally set a default, change/unset a default
on an existing row, and remove assignments. For a multiple-configured function, the no-default reminder
appears whenever one or more assignments exist and none is default, including the single-assignment case.
Removal does not promote another row. Each mutation requires a reason and uses the row version; the
existing server actions derive tenant/actor and enforce maintain authority. Controls remain hidden from
read-only users.

Supplier choices come from same-tenant active Supplier roles; status/block state is included in option
labels. The picker shows at most 200 candidates and discloses that limit even when every returned choice is
already assigned. Assignment controls are not enabled until the focal supplier purchasing-organisation
segment exists. The standard package still seeds
all three functions as unique; this batch does not add a cardinality-configuration editor, so multiple/default
controls appear only for a tenant whose function is already configured as multiple. No assignment is
created automatically and no default is inferred.

**Verification:** `npm run typecheck`, full Vitest (**343/343 across 22 files**), browser harness (**65/65**),
production build, IP lint (**173 files**) and `git diff --check` passed. Dedicated live-browser acceptance
passed in B-033 (§26.49). No schema/migration or PO determination behavior was added in B-032.


### 26.49 B-033 — Supplier partner-function editor browser acceptance `AUTOMATED ACCEPTANCE PASSED`

**Scope:** extended the bounded `supplier-purchasing` Playwright target to exercise the assignment editor
through the actual Supplier Purchasing page and protected server actions. Onboarding created disposable
development tenant `T990`; focal and related Supplier identities were created through the UI. The target
confirmed the standard three-function catalogue is unique and empty, and that editor controls remain
withheld until the focal purchasing-organisation segment exists. After the segment was saved, the unique
`ORDERING_PARTNER` flow successfully added, replaced and removed an assignment, with persisted readback.

To cover future multiple configuration without adding cardinality UI or changing the standard defaults,
the test changed only `DELIVERY_PARTNER.allows_multiple` in this disposable fixture. The browser then
added two distinct related Suppliers, verified the no-default reminder with one assignment, added an
optional default, unset it, transferred it to the other row, and removed the current default. The remaining
assignment was not promoted and correctly remained without a default. A read-only `AUDITOR` could see the
assignment and no-default explanation but received no assignment forms/buttons; a warehouse-only user
could not read purchasing data/history. The common target also verified signed-out redirect and recorded
no browser runtime errors.

**Data safety:** `T990` was created through onboarding and cleaned up by the guarded fixture cleanup. A
post-run query confirmed zero matching development-tenant rows. Only this disposable tenant's multiple
rule was changed for test coverage; no owner/production data, deployment, PO, receipt, invoice, or other
transaction behavior was touched. This automated browser acceptance is not an owner walkthrough/sign-off.

**Verification:** `npm run typecheck`, `npm run test:browser-harness` (**65/65 across 5 files**),
`npm run smoke:browser -- --target supplier-purchasing` (passed; no page errors), and `git diff --check`
passed. Playwright Chromium and its Linux runtime dependencies were installed in the sandbox for this run.
No product schema or migration changed.


### 26.50 B-034 — Supplier company-code pending defaults placeholders `IMPLEMENTATION COMPLETE · LIVE BROWSER ACCEPTANCE PENDING`

**Scope:** added a four-field **Additional company-code defaults** group to the Supplier company-code
maintenance and authorised display-only views: Payment methods, Dunning procedure, Cash discount, and
Tolerance group. Each field is an explicitly disabled, read-only form control showing “Master
configuration pending”; the group explains that these are planning-only and not saved. In the editable
view the group is outside the existing save form and its controls have no `name`, so they cannot enter
`FormData`. The helper is shared with the read-only view. No `CompanyFields`, server action, service,
schema, migration, capability, save/persistence, or business behavior was added or changed.

**Dependency decision:** the owner selected Payment Methods as the first related master. B-035 captured
its v1 semantics; B-036–B-045 implemented and accepted the master. At B-034 close, all four Supplier
placeholders were disabled. B-098 now adds only the nullable Supplier payment-method storage column; its
control remains disabled pending country/direction validation, protected save behavior, UI and acceptance.
Dunning procedure, cash discount, and tolerance group remain disabled until their own required masters exist.

**Verification:** `npm run typecheck`, `npm run build`, `npm run lint:ip` (173 files),
`npm run test:browser-harness` (65/65), and `git diff --check` passed. The `supplier-company` Playwright
target now asserts the presence of exactly four disabled, non-submitted fields. Live browser acceptance
was not run: this worktree has no configured `DATABASE_URL` for the isolated development database, and
a read-only connection check failed authentication before any fixture was created or database mutation
was attempted. No owner/production data was accessed. Owner walkthrough/sign-off remains pending.


### 26.51 B-035 — Payment Methods master v1 semantics and scope `OWNER APPROVED · SCHEMA ADDED IN B-036`

**Outcome:** captured the owner-approved v1 definition contract only. No source, schema, migration, seed,
service, UI, supplier/customer integration, or payment behavior changed in B-035.

**Decision D-058:** the master is tenant-scoped and country-specific. Its natural key is
`(client, country, paymentMethodCode)`, where `country` is the existing ISO country reference and the
method code is 1–2 uppercase ASCII letters/digits. Codes may be reused in another country with a distinct
meaning. Each definition has a description, one allowed-direction value (`OUTGOING`, `INCOMING`, or
`BOTH`), and an active flag. The master contains definitions only; the standard configuration package
ships no generic methods.

Later code-backed company defaults resolve methods using the company code’s country and direction:
Supplier company defaults require an outgoing method, Customer company defaults an incoming method. The
existing Customer company field remains format-only until its own integration batch; this decision does
not change its current validation or stored values. Method permissions per Supplier/Customer, house-bank
eligibility, payment-medium/file formats, payment proposals/execution, and payment clearing are out of
this master slice and remain separate work. Supplier placeholders from B-034 stay disabled until the
master and its relevant integration are implemented.

**Verification:** owner-approved design recorded in D-058 and §14.6. B-036 adds the schema/RLS layer
(§26.52), B-037 adds read services (§26.53), and B-038 adds audited maintenance services (§26.54).
Their migrations and focused DB acceptance subsequently passed on a disposable local PostgreSQL 17.11
cluster (§26.55). `git diff --check` passed. No database connection or data change was required in B-035.


### 26.52 B-036 — Payment Methods master schema and tenant RLS `IMPLEMENTED · ISOLATED DB ACCEPTANCE PASSED (§26.55)`

**Scope:** added the `payment_method` table and registered it through the Foundation schema root. The
natural key is `(client, country, method_code)`; the tenant key cascades from `client`, and `country`
references the shared ISO country table. The table stores description, allowed direction, active state,
version, and standard audit columns. Database checks enforce the 1–2 uppercase alphanumeric code, a
nonblank description, one of `OUTGOING`/`INCOMING`/`BOTH`, and positive version. B-036 covered storage
and RLS only; read/write services were implemented separately in B-037/B-038 (§26.53–54). No method seed,
UI, company-field integration, payment permission, or payment execution is included.

**Migrations:** additive DDL is `0012_payment_method_master.sql`; forced tenant RLS, a default-deny
`cairn.client` policy, and `cairn_app` CRUD grants are `9014_payment_method_policies.sql`. The application
role cannot read or write another tenant’s rows or operate unscoped. Both files run through the existing
checksum-tracked migration runner; no prior migration was edited.

**Tests:** added `tests/payment-method-schema.test.ts` for same-code reuse across countries, duplicate-key
and database-domain rejection, RLS read/write isolation, forced-RLS flags, defaults, and tenant-cascade
cleanup. Its DB acceptance was pending at the B-036 implementation checkpoint; it subsequently passed 3/3
in the fresh disposable PostgreSQL 17.11 run (§26.55), alongside application of all 28 migrations.

**Verification:** `npm run typecheck`, `npm run build`, `npm run lint:ip` (177 files),
`npm run test:browser-harness` (65/65), and `git diff --check` passed. Isolated schema/migration acceptance
subsequently passed (§26.55). No owner/production database was accessed.


### 26.53 B-037 — Payment Methods tenant-scoped read services `IMPLEMENTED · DB ACCEPTANCE PASSED (§26.55)`

**Scope:** added `src/modules/foundation/payment-methods.ts` with read-only `getPaymentMethod` and
`listPaymentMethods` functions. Both validate inputs, execute through `withTenant`, and explicitly constrain
by tenant. The get key is tenant + country + method code; country and method code are trimmed and
canonicalised to uppercase only after ASCII-format validation. `getPaymentMethod` returns inactive rows
for review and returns `null` when the key does not exist.

`listPaymentMethods` is country-scoped and ordered by code. It includes inactive definitions by default;
`activeOnly: true` filters them out. A requested `OUTGOING` or `INCOMING` use includes definitions with
that direction **and** `BOTH`, so callers can use it for future Supplier/Customer choices. It does not
accept `BOTH` as a requested use. The B-037 batch added no write path; audited writes are separate B-038
work (§26.54). No action, UI, seed, payment behavior, or partner-field integration was added.

**Tests:** added `tests/payment-methods.test.ts` for country/code resolution and canonicalization, country
separation, direction + `BOTH` behavior, inactive handling, tenant isolation, and invalid-key/filter refusal.
At the B-037 implementation checkpoint its DB tests were pending; the read-service cases subsequently
passed in the focused 8/8 service-test run (§26.55). No database mutation was attempted in B-037 itself.

**Verification:** `npm run typecheck`, `npm run test:browser-harness` (65/65), `npm run lint:ip` (179 files),
and `git diff --check` passed. Isolated DB acceptance for B-036–B-038 subsequently passed (§26.55).
No owner/production database was accessed.


### 26.54 B-038 — Payment Methods audited create/change/retire service only `IMPLEMENTED · DB ACCEPTANCE PASSED (§26.55)`

**Scope:** extended `src/modules/foundation/payment-methods.ts` with `savePaymentMethod` for create/change
and `retirePaymentMethod` for non-destructive retirement. Both validate the tenant + country + method-code
key, required actor, reason, and expected version, then execute inside `withTenant` with an explicit full
key filter. Create requires expected version 0 and persists version 1; changes require the exact current
version and increment it. Advisory transaction locks serialize service writes to the same key. The country
must exist in the shared reference catalogue. An unchanged save is silent and creates no history.

Retirement sets `isActive=false`, increments the version, and retains the definition for review; a repeated
retire at the current version is a no-op. All actual writes use `recordChange` with required reason/actor
and before/after field snapshots. The supported audit types remain `CREATE` and `CHANGE`; retirement is
audited as a `CHANGE` to the active flag, without inventing a `RETIRE` change type. No configuration
activity completion is assumed. There is no server action, UI, seed, payment execution, Supplier/Customer
integration, or migration in this batch.

**Tests:** extended `tests/payment-methods.test.ts` with create/change/retire history, versions and stale
write rejection, no-op behavior, retained inactive reads, same country/code isolation across tenants, and
invalid/missing write cases. The focused DB run passed `tests/payment-methods.test.ts` (8/8) and
`tests/payment-method-schema.test.ts` (3/3); the B-038 lifecycle, stale-version, audit, no-op, and soft-retire
cases all passed (§26.55).

**Verification:** `npm run typecheck`, `npm run test:browser-harness` (65/65), `npm run lint:ip` (179 files),
and `git diff --check` passed. B-036–B-038 DB acceptance passed on a disposable local PostgreSQL 17.11
cluster; it was stopped and its temporary data directory removed after confirming fixture cleanup. No
owner/production data was used. Configuration UI and Supplier integration remain separate follow-on batches.


### 26.55 B-036–B-038 — Disposable PostgreSQL database acceptance `PASSED`

**Setup:** PostgreSQL 17.11 server binaries were already available in the workspace environment, though not
on `PATH`. To avoid reusing the pre-existing local cluster of unknown provenance, created a brand-new,
temporary cluster and `cairn_b038_test` database on loopback only (port 55433). No `.env.local` change was
made; the app and migration URLs were supplied only to the commands for this isolated test database.
Applied all 28 migrations, including `0012_payment_method_master.sql` and
`9014_payment_method_policies.sql`, then loaded shared reference fixtures required by the tests.

**Results:** `npx vitest run tests/payment-method-schema.test.ts tests/payment-methods.test.ts` passed:
2 files, 11/11 tests. The schema/RLS suite passed 3/3; the Payment Methods service suite passed 8/8,
covering B-037 reads and B-038 create/change/retire, tenant isolation, optimistic versions, audit history,
no-op and retained-inactive behavior. The application role passed its non-elevated role check.

**Cleanup:** test teardown succeeded, and a read-only check confirmed zero development test tenants remained.
The temporary PostgreSQL process was stopped and its data directory removed. The existing local cluster,
owner/production databases, and their data were not accessed. No package, application schema, or migration
file was changed for this acceptance outcome.


### 26.56 B-039 — Payment Methods protected write actions and capability registration `DONE`

**Scope:** added `src/app/config/payment-methods/actions.ts` with session-protected create/change and retire
actions. Both require `CFG.FIN.PAYMENTMETHOD.DEFINE`; the tenant and actor come only from the verified
session, while reason, expected version, and method fields are parsed from the form and validated by the
B-038 service. Forged `client` and `changedBy` form values are ignored. Expected version is rejected when
missing rather than silently treating it as a create. Successful writes revalidate the future Payment
Methods route and configuration workbench. The action module does not add a page or read action.

Added the grantable `CFG.FIN.PAYMENTMETHOD.DEFINE` capability to `scripts/seed.ts` and localized success
messages. No Payment Method data is seeded and no role grants are changed. At the B-039 boundary, no
workbench activity existed, so these actions did not depend on an activity-status row; B-040 subsequently
registered the activity and added lifecycle completion (§26.57). No UI, schema/migration, payment
execution, or Supplier/Customer integration was added in B-039.

**Tests:** extended `tests/action-security.test.ts` for authorized create + soft retire, session-derived
tenant/actor despite forged form fields, denial without the capability, and anonymous redirects. On a fresh
disposable PostgreSQL 17.11 database with migrations and global/reference seed applied,
`npx vitest run tests/action-security.test.ts -t 'Payment Method'` passed all 3 selected tests (30 unrelated
tests skipped). The capability catalogue row was verified; teardown left zero test tenants.

**Verification:** `npm run typecheck`, `npm run test:browser-harness` (65/65), `npm run lint:ip` (180 files),
and `git diff --check` passed. The temporary database process and data directory were removed; the
pre-existing local cluster and owner/production databases were not accessed. B-040 activity/status
lifecycle is recorded in §26.57; B-041 read-only UI and later browser acceptance remain separate.


### 26.57 B-040 — Payment Methods workbench activity and status lifecycle only `DONE`

**Scope:** registered `CFG.FIN.PAYMENTMETHOD.DEFINE` (“Define payment methods”) in the configuration
activity catalogue, with the existing client-definition prerequisite, `STANDARD` stage, and future route
`/config/payment-methods`. Seed now backfills a missing `NOT_STARTED` status row for existing tenants;
`ON CONFLICT DO NOTHING` preserves any status already recorded. Standard tenant setup can also initialize
the registered activity for new tenants. This batch adds no workbench route, term-registry entry, or UI.

**Completion behavior:** successful Payment Method create/change and retire operations mark the activity
`COMPLETED` in the same tenant transaction as the maintenance and audit write. Valid no-op save and
already-inactive retire confirmations also mark it complete; validation, concurrency, or persistence
failures do not. Activity status is not reset by re-seeding. No method data is seeded and Supplier/Customer
integration remains out of scope.

**Tests and acceptance:** extended `tests/payment-methods.test.ts` to seed status rows for its tenant
fixtures and assert that a successful write completes the activity. On a fresh disposable PostgreSQL 17.11
cluster/database, applied all 28 migrations and reference seed; `npx vitest run
tests/payment-method-schema.test.ts tests/payment-methods.test.ts` passed 11/11 tests, and
`npx vitest run tests/action-security.test.ts -t 'Payment Method'` passed 3 selected tests (30 unrelated
tests skipped). A dedicated seed check confirmed a newly backfilled row starts `NOT_STARTED`, then remains
`COMPLETED` after re-seeding. The temporary cluster was stopped and its test data directory removed; the
pre-existing local cluster and owner/production databases were not used.

**Verification:** `npm run typecheck`, `npm run test:browser-harness` (65/65), `npm run lint:ip`
(180 files), and `git diff --check` passed. No application migration or payment-method data seed was
added. No UI or browser acceptance is included.
B-041 (workbench route, registry entry, and read-only list/detail/history) is next; see §25.5.2 and the
batch queue. No commit or push was made; the full-system/user-runnable UI-test publish trigger remains in §25.4.


### 26.58 B-041 — Payment Methods workbench route, registry entry and read-only UI `DONE`

**Scope:** built `/config/payment-methods` as an authenticated, read-only review screen. The verified
session supplies the tenant; the screen offers the global country catalogue, lists that tenant's
country-specific definitions (including inactive rows), and displays a selected method and its audited
change history. Added the route to the workbench's built-route allowlist and registered
`CFG.FIN.PAYMENTMETHOD.DEFINE` in the term registry so both entry points resolve. New labels are localized
through the English catalogue. B-041 added no create/change/retire controls, new actions, method data, or
Supplier/Customer integration; B-042 subsequently added create/change forms (§26.59), with retire UI in
B-043.

**Verification:** `npm run typecheck`, `npm run lint:ip` (181 files), `npm run test:browser-harness`
(65/65), and `git diff --check` passed. This batch did not run dedicated Payment Methods database or
live-browser acceptance; B-045 remains the separate browser run. The B-044 target is recorded in §26.61. Process check found no Cairn app,
Vitest, or PostgreSQL process running; the persistent platform Jupyter service was left untouched. No
commit or push was made; the full-system/user-runnable UI-test publish trigger remains in §25.4.


### 26.59 B-042 — Payment Methods create/change editor form only `DONE`

**Scope:** added the client-side `PaymentMethodForm` for capability-authorized creation and change on the
B-041 route. The page shows create/change controls only when the session holds
`CFG.FIN.PAYMENTMETHOD.DEFINE`; the form submits only to B-039's protected save action, which continues to
derive tenant and actor from the verified session. Create requires a country-scoped 1–2 character code;
existing codes are immutable. Both modes require description, allowed direction, active state and a
maintenance reason. Create sends expected version zero; change sends the version read by the page. Success
provides a link to the saved definition, while validation/authority errors retain a remedy. Read-only users
have no editor controls. No retire control, new action, method seed, or partner integration was added;
versioned soft retirement is B-043.

**Verification:** `npm run typecheck`, `npm run build` (Payment Methods route compiled as dynamic),
`npm run lint:ip` (182 files), `npm run test:browser-harness` (65/65), and `git diff --check` passed.
No dedicated Payment Methods database or live-browser acceptance was run; B-045 remains the separate
browser run after the B-044 target implementation (§26.61). No commit or push was made; the
full-system/user-runnable UI-test publish trigger remains in §25.4.


### 26.60 B-043 — Payment Methods soft-retire confirmation UI only `DONE`

**Scope:** added `RetirePaymentMethodForm` to the detail view for authorized users when the selected method
is active. It uses B-039's existing protected retire action, submitting the page's expected version, the
country/method key, and a required maintenance reason. A disclosure/confirmation step explains that
retirement marks the definition inactive but retains its record and audit history; an acknowledgment
checkbox is required before submitting. The action remains a versioned soft change, never a delete. On
success the user can reopen the saved definition; action errors and remedies remain visible. Inactive rows
show no retire control. No new action, schema, seed, or Supplier/Customer integration was added.

**Verification:** `npm run typecheck`, `npm run build` (Payment Methods route compiled as dynamic),
`npm run lint:ip` (183 files), `npm run test:browser-harness` (65/65), and `git diff --check` passed.
The generic harness is not Payment Methods browser acceptance; no dedicated database or live-browser run
was made. The B-044 browser target is recorded in §26.61; B-045 is next. No commit or push was made; the
full-system/user-runnable UI-test publish trigger remains in §25.4.


### 26.61 B-044 — Payment Methods dedicated browser acceptance target only `IMPLEMENTED`

**Scope:** added the isolated browser target `payment-methods` on reserved development key `T989`, runnable
as `npm run smoke:browser:payment-methods`. The existing runner creates the tenant through the UI and only
removes it if the key is the exact owned development fixture. The scenario covers workbench discovery and
initial status, empty country catalogue, UI create/change/soft-retire with version and audit evidence,
activity completion, and a no-payment-authority user who can display the active method/history but has no
create/change/retire controls. It also tries forged `client=0100` and `edit=1` query parameters. The
read-only user's identity/role is a test-only fixture; business method records are created through the UI.
The post-signout route check now targets `/config/payment-methods`.

**Verification:** `npm run typecheck`, browser-harness target-selection tests (66/66), `npm run lint:ip`
(183 files), `npm run smoke:browser -- --list`, and `git diff --check` passed. This verifies target
registration, not the browser acceptance itself. No Cairn app or PostgreSQL process/DB URL was running or
configured during this batch; B-045 will set up a fresh disposable development database, run this target,
and verify cleanup. No commit or push was made; the full-system/user-runnable UI-test publish trigger
remains in §25.4.


### 26.62 B-045 — Payment Methods fresh-database browser acceptance and fixture cleanup `PASSED`

**Environment:** ran `npm run smoke:browser:payment-methods` against a newly initialized disposable PostgreSQL 17.11 database (`cairn_b045_test`) with all 28 repository migrations and the reference/application seeds. The guarded target created development fixture `T989` through the onboarding UI. No pre-existing local database, owner tenant, or production data was used.

**Browser acceptance:** the dedicated target passed all steps: onboarding left accounting intervals unconfigured; the Payment Methods workbench exposed the new tenant's empty catalogue; authorized create/change kept the method code immutable and produced versioned history/audit evidence under the signed-in actor; the configuration activity completed; a display-only user could view but not maintain the definition; forged `client=0100` and `edit=1` query parameters did not grant cross-tenant access or edit controls; and versioned soft retirement preserved the inactive definition and history. The retirement success feedback was initially lost on revalidation because the parent unmounted the form when the detail became inactive. The UI was corrected to keep the form component mounted for editable detail and pass its active state, allowing the success message to render before the inactive control hides; the retirement feedback assertion then passed. The browser sign-in helper waits for `domcontentloaded` on the root redirect. This is automated acceptance only; product-owner walkthrough/sign-off remains pending under §24.1.

**Cleanup and verification:** target cleanup removed the owned T989 fixture. Direct post-run checks returned zero fixture tenants, zero `payment_method` rows, and zero `app_user` rows for T989. The Next.js app and PostgreSQL test server were stopped, and `/tmp/cairn-b045-pg` was removed. `npm run typecheck`, the dedicated browser target, `npm run test:browser-harness` (66/66), `npm run lint:ip` (183 files), and `git diff --check` passed. This batch changed no database schema, migration, seed data, payment execution, or Supplier/Customer integration. No commit or push was made; the full-system/user-runnable UI-test publish trigger remains in §25.4.


### 26.63 B-046 — Business-partner bank/contact v1 rules `AGREED`

**Owner-approved scope (D-059):** bank details are multiple partner-wide records, shared where one partner
has both Supplier and Customer roles. Fields are account holder, bank country, bank name/code, IBAN or
local account number, BIC/SWIFT, valid-from/to, and active state. Full bank identifiers must be encrypted
at rest, masked in ordinary views and change history, and revealed only through a separate audited
authority; generic change history must never hold the plaintext identifiers. No company-code or role
assignment, default payment selection, payment-method permission, house-bank eligibility, or payment
execution is added here.

Contacts are multiple partner-wide named people; the existing general email/phone stay as organisation-
level values. Each contact has name, title/function, email, phone, validity dates and active state, with at
most one primary at a time per partner. Log contact-data views and changes; mask personal email/phone in
history; end-date/inactivate records, with hard deletion only through an approved retention/privacy
workflow.

**Implementation gates:** country-specific bank-field requiredness and format validation, plus encryption-
key provisioning/rotation and the separate reveal/audit path, remain to be defined and implemented before
full bank identifiers can be stored. The current general partner schema has no bank/contact record tables;
its change history records supplied before/after values, and no bank-field encryption/reveal path exists.
B-047 is next to define bank field requiredness/validation. This was a requirements-only batch: no source,
schema, database, or real partner data changed. No commit or push; the full-system publish trigger remains
in §25.4.

**Status update:** B-047 subsequently approved the profile-driven requiredness, validation, and date
rules (D-060; §26.64). Initial country coverage and encryption-key/reveal implementation remain.


### 26.64 B-047 — Partner bank country-profile validation and date semantics `AGREED`

**Owner-approved validation policy (D-060):** account holder and bank country are required. A country
profile decides whether IBAN or local account number is required, and whether bank code/BIC is mandatory;
bank name is optional. Saving fails closed if no profile exists for the bank country. Normalize IBAN to
uppercase without spaces; verify that its country prefix matches the bank country, then check the
country-specific length and MOD-97 checksum. Validate supplied BIC/SWIFT syntax, but do not claim to verify
that the bank or account exists. Local account formats follow their country profile.

Valid-from is required; valid-to is optional. Both endpoints are inclusive; reject a valid-to date earlier
than valid-from. Overlapping validity periods are allowed because several accounts may be valid
simultaneously. Active state is separate from dates, and bank records are never hard-deleted.

**Boundary:** this approves the validation policy, not country-profile data coverage or implementation.
No profile rows, code, schema, database or bank identifiers were added. Encryption-key provisioning,
rotation and audited reveal infrastructure must still precede storage of real/full account identifiers.
Initial country coverage is the next requirements step, B-048. No commit or push; the full-system publish
trigger remains in §25.4. `git diff --check` passed.

**Status update:** B-048 subsequently selected `IN`, `KW`, `GB`, `US`, and `JP` as the initial profile set;
no country-profile records exist yet (§26.65). B-049 begins source-backed profile verification with KW.


### 26.65 B-048 — Initial partner bank-profile country set selected `AGREED`

Owner selected the first country-profile coverage as `IN`, `KW`, `GB`, `US`, and `JP` (ISO-2 codes;
D-061). All five already exist in the shared 30-country reference seed. This selects profile-authoring
scope only: no country validation profile has been defined or enabled, and D-060 continues to reject
bank records for every country until its required profile exists. Other countries remain outside the
initial set unless explicitly added later.

No code, schema, country-profile rows, database, or real bank identifiers changed. `git diff --check`
passed. B-049 will verify the KW profile requirements from authoritative sources before any profile is
implemented. No commit or push; the full-system publish trigger remains in §25.4.

**Status update:** B-049 subsequently verified the KW rules from CBK and the SWIFT Registry (D-062; §26.66).
The country profile is still not implemented; B-050 will verify IN next.


### 26.66 B-049 — Kuwait (KW) bank-validation profile specification `VERIFIED`

**Authoritative profile sources:** the Central Bank of Kuwait states that Kuwait's registered IBAN format
was activated on 2011-01-01 and links its implementation manual. The CBK manual describes the KW IBAN as
30 characters: `KW`, two check digits, a 26-character BBAN consisting of a four-letter bank code and a
22-character account component; it says the account-holding bank generates the customer's IBAN and the
electronic form contains no spaces. The SWIFT Registration Authority's current IBAN Registry Release 103
(Sep 2026) confirms `KW2!n4!a22!c`, total length 30, BBAN length 26, and a four-letter bank identifier in
BBAN positions 1–4. Sources: [CBK IBAN page](https://www.cbk.gov.kw/en/payment-systems/iban), [CBK implementation manual](https://www.cbk.gov.kw/en/images/iban-9721_v60_tcm10-9721.pdf), and [SWIFT IBAN Registry](https://www.swift.com/resource/iban-registry-pdf).

**KW profile specification (D-062):** account holder and bank country are required; country is `KW`.
Require a bank-issued IBAN; do not accept a separate local account number and do not generate an IBAN from
one. Normalize by removing spaces and uppercasing, then require exactly 30 characters matching
`^KW[0-9]{2}[A-Z]{4}[A-Z0-9]{22}$` and a valid MOD-97 check. The four-letter bank identifier is embedded
at normalized IBAN positions 5–8; derive it rather than asking for a separately entered bank code. Bank
name is optional. BIC/SWIFT is optional for this partner-data capture slice; validate syntax if supplied,
but leave payment-routing requirements to the later payment workflow. No validation claims that a bank
or account exists. Valid-from/to and active-state behavior follow D-060.

**Boundary:** this records verified KW profile rules only. It does not implement or activate a country
profile and adds no code, schema, database row, or bank data. Full identifiers remain blocked until the
encryption-key/reveal/audit path is implemented. B-050 will verify India's profile next. No commit or push;
the full-system publish trigger remains in §25.4. `git diff --check` passed.


### 26.67 B-050 — India (IN) bank-validation profile specification `VERIFIED`

**Authoritative profile sources:** RBI's NEFT FAQ says a beneficiary's bank-branch IFSC and account
number are supplied for NEFT beneficiary identification. It defines IFSC as an 11-character
alphanumeric code identifying a participating bank-branch: positions 1–4 identify the bank, position 5
is `0`, and positions 6–11 identify the branch. RBI's 2013 Technical Committee report describes
bank-specific variation in account-number structures and discusses an India IBAN design; the RBI release
issued with that report invited comments before implementation was considered. The current SWIFT IBAN
Registry Release 103 (Sep 2026) has no `IN` IBAN profile. Sources: [RBI NEFT FAQ](https://www.rbi.org.in/scripts/faqview.aspx?id=60), [RBI Technical Committee report](https://www.rbi.org.in/scripts/PublicationReportDetails.aspx?ID=695), [RBI consultation press release](https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=27975), and [SWIFT IBAN Registry](https://www.swift.com/resource/iban-registry-pdf).

**IN profile specification (D-063):** account holder and bank country are required; country is `IN`.
Require the local bank account number and the beneficiary-branch IFSC as the profile's bank code;
do not accept an IBAN for this profile. Normalize IFSC to uppercase and require exactly 11 characters
matching `^[A-Z]{4}0[A-Z0-9]{6}$`. This is syntax validation only: do not perform live directory lookup,
claim the branch/account exists, or equate IFSC with BIC/SWIFT. Treat the local account number as an
opaque bank-specific identifier: preserve leading zeros and do not impose a country-wide length, syntax,
checksum, padding or truncation rule. Bank name is optional. BIC/SWIFT is optional for this non-payment
partner-data slice; if supplied, apply the generic syntax check and leave later payment-routing needs to
the payment workflow. RBI also lists account type in NEFT beneficiary instructions; it remains a
transaction-specific field outside D-059's bank-master field set. Validity dates and active state follow
D-060.

**Boundary:** this records verified IN profile rules only. It does not implement or activate a country
profile and adds no code, schema, database row, or bank data. Full identifiers remain blocked until the
encryption-key/reveal/audit path is implemented. B-051 will verify the GB profile next. No commit or push;
the full-system publish trigger remains in §25.4. `git diff --check` passed.


### 26.68 B-051 — United Kingdom (GB) bank-validation profile specification `VERIFIED`

**Authoritative profile sources:** SWIFT IBAN Registry Release 103 (Sep 2026) lists the UK format as
`GB2!n4!a6!n8!n`, length 22. Pay.UK's UK IBAN standard explains the BBAN components: a four-letter
institution code derived from the bank BIC, six-digit sort code, and eight-digit account number. Sources:
[SWIFT IBAN Registry Release 103](https://www.swift.com/resource/iban-registry-pdf) and [Pay.UK Standard — UK IBAN format](https://www.wearepay.uk/wp-content/uploads/2018/10/Pay.UK-Standard-Format-of-the-IBAN-issued-in-the-UK-October18.pdf).

**GB profile specification (D-064):** account holder and bank country are required; country is `GB`.
Require a bank-issued IBAN; do not accept a local-account-only entry. Normalize by removing spaces and
uppercasing, then require exactly 22 characters matching `^GB[0-9]{2}[A-Z]{4}[0-9]{14}$` and a valid
MOD-97 check. Derive the four-letter institution identifier from normalized IBAN positions 5–8 for the
existing bank-code field; the sort code is positions 9–14 and account number positions 15–22. Do not ask
for duplicate local account/sort-code entry. Bank name is optional. BIC/SWIFT is optional for this
non-payment master-data slice; syntax-check if supplied, but do not assert bank/account existence or
payment-rail eligibility. Validity dates and active state follow D-060.

**Boundary:** this records verified GB profile rules only. It does not implement or activate a country
profile and adds no code, schema, database row, or bank data. Full identifiers remain blocked until the
approved encryption-key/reveal/audit safeguards exist. B-052 and B-053 record US and JP next. No commit
or push; the full-system publish trigger remains in §25.4. `git diff --check` passed.


### 26.69 B-052 — United States (US) bank-validation profile specification `VERIFIED`

**Authoritative profile sources:** the American Bankers Association's Routing Number Policy specifies a
nine-digit routing number made up of the Federal Reserve routing symbol, institution identifier and
check digit. It also states that regular routing numbers may be used for electronic transactions; that
does not identify which number is correct for a particular payment rail. Sources: [ABA Routing Number Policy & Procedures](https://www.aba.com/news-research/analysis-guides/routing-number-policy-procedures), [ABA routing-number registry information](https://www.aba.com/about-us/routing-number), and the [Apache Commons Validator ABA check-digit reference](https://commons.apache.org/proper/commons-validator/apidocs/org/apache/commons/validator/routines/checkdigit/ABANumberCheckDigit.html). SWIFT IBAN Registry Release 103 (Sep 2026) has no `US` IBAN profile: [SWIFT IBAN Registry](https://www.swift.com/resource/iban-registry-pdf).

**US profile specification (D-065):** account holder and bank country are required; country is `US`.
Require the local account number and a nine-digit ABA routing transit number (RTN), stored in the
existing bank-code field; do not accept an IBAN. Require `^[0-9]{9}$`; the first two digits must be in ABA's bank/legacy-thrift routing-symbol ranges
`01–12` or `21–32`. Validate the ABA check digit with the standard 3-7-1 mod-10 rule:
`3(d1+d4+d7)+7(d2+d5+d8)+(d3+d6+d9) ≡ 0 (mod 10)`. Treat the account number as an opaque
bank-specific value: preserve leading zeros and impose no U.S.-wide length, syntax, checksum, padding
or truncation rule. Validate the RTN's structure/check digit only; do not look up an active directory,
claim institutional assignment, infer ACH/wire/check eligibility, or claim account existence. Bank name
is optional. BIC/SWIFT is optional for this non-payment master-data slice; syntax-check if supplied.
Validity dates and active state follow D-060.

**Boundary:** this records verified US profile rules only. It does not implement or activate a country
profile and adds no code, schema, database row, or bank data. Full identifiers remain blocked until the
approved encryption-key/reveal/audit safeguards exist. B-053 records JP next. No commit or push; the
full-system publish trigger remains in §25.4. `git diff --check` passed.


### 26.70 B-053 — Japan (JP) bank-validation profile specification `VERIFIED`

**Authoritative profile sources:** SWIFT IBAN Registry Release 103 (Sep 2026) contains no `JP` IBAN
profile. The Japanese Bankers Association's code directory lists four-digit financial-institution codes;
MUFG documents a three-digit branch code and the associated account number. Japan Post Bank instructs
customers to use its transfer-specific institution/store/account representation and provides official
conversion guidance from its separate symbol/number format. Sources: [SWIFT IBAN Registry Release 103](https://www.swift.com/resource/iban-registry-pdf), [Japanese Bankers Association code directory](https://www.zenginkyo.or.jp/abstract/outline/organization/member-01/), [MUFG branch-code/account-number guidance](https://www.bk.mufg.jp/ebusiness/gplus/listofbranchesinjapan.html), and [Japan Post Bank transfer-format guidance](https://www.jp-bank.japanpost.jp/kojin/sokin/furikomi/kouza/kj_sk_fm_kz_1.html).

**JP profile specification (D-066):** account holder and bank country are required; country is `JP`.
Require a local account number and the domestic institution-plus-branch identifier; do not accept an
IBAN. To fit D-059's approved field set without adding a branch column, the existing bank-code field
carries the four-digit institution code followed by the three-digit branch/store code as one seven-digit
value matching `^[0-9]{7}$`; preserve leading zeros. Treat the bank-supplied account number as opaque and
exact; impose no nationwide length, syntax, checksum, padding or truncation rule. For Japan Post Bank,
use the bank's transfer-format branch/store code and account number from its official guidance; do not
algorithmically convert the separate symbol/number identifier in this profile. Bank name and BIC/SWIFT
are optional for this non-payment master-data slice; syntax-check BIC if supplied. Account type and
payment-rail-specific requirements remain outside D-059. No live directory, branch/account-existence or
network-eligibility claim. Validity dates and active state follow D-060.

**Boundary:** this records verified JP profile rules only. It does not implement or activate a country
profile and adds no code, schema, database row, or bank data. Full identifiers remain blocked until the
approved encryption-key/reveal/audit safeguards exist. B-051–B-053 are now complete; all five D-061
initial-country specifications are recorded, but none is implemented or enabled. No commit or push; the
full-system publish trigger remains in §25.4. `git diff --check` passed.


### 26.71 B-054 — Versioned bank-data encryption primitive `IMPLEMENTED — NOT INTEGRATED`

**Decision and scope (D-067):** the owner selected a versioned app-managed keyring whose high-entropy
keys are supplied through deployment secrets, with key IDs, retention of prior keys during rotation,
and no external KMS. This batch implements only the server-side cryptographic primitive in
`src/platform/security/bank-data-encryption.ts`; it neither reads deployment configuration nor stores or
reveals bank data.

**Cryptographic contract:** AES-256-GCM, a fresh random 96-bit nonce per encryption, and a 128-bit
authentication tag. The canonical unpadded-base64url envelope is
`cbd1.<key-id>.<nonce>.<ciphertext>.<tag>`. Key material must be 32 bytes; key IDs match
`^[A-Za-z0-9_-]{1,32}$`. The envelope version, key ID, tenant/client, partner number, bank-record ID,
and stable field name are serialized as authenticated associated data, so moving ciphertext between
keys, tenants, partners, rows, or fields fails authentication. Encryption always uses the supplied
keyring's active key; decryption resolves the key ID from the supplied keyring, allowing retained
old-key reads while a later bounded re-encryption process remains future work. Nonempty UTF-8 values
are limited to 4,096 bytes; context components must be nonempty and bounded, and field names must be
stable ASCII identifiers. Errors expose no plaintext, ciphertext, context, or key material.

`encryptBankData` and `decryptBankData` intentionally do not load or provision keys, authorize a caller,
write a reveal audit, mask normal views/history, or access the database. A caller must not expose the
plaintext result except through the future separately authorized and audited reveal path. Focused tests
cover round-trip and ciphertext secrecy, nonce uniqueness, tenant/partner/record/field and key-ID
binding, ciphertext tampering, missing prior keys, active-key rotation behavior, malformed envelopes,
and invalid key material/context. Six tests pass; `npm run typecheck` and `git diff --check` pass.

**Boundary:** no key configuration or real key material was read, written, or committed. No schema,
migration, database, profile, contact, bank-record service, UI, masking/history filter, reveal authority,
or bank identifier was added. Test inputs are non-bank placeholders with ephemeral test-only keys.
B-055's separate keyring configuration is recorded in §26.72; bank-record storage remains blocked until
the full D-059/D-060/D-067/D-068 security gate is complete. No commit or push; §25.4's full-system publish
trigger remains authoritative.


### 26.72 B-055 — Fail-closed deployment-secret keyring configuration `IMPLEMENTED — NOT INTEGRATED`

**Configuration contract (D-068):** the runtime secret is `CAIRN_BANK_DATA_KEYRING_JSON`, a JSON object
with exactly two properties: `activeKeyId` and `keys`. `keys` maps each valid key ID to canonical,
unpadded base64url encoding of exactly 32 bytes; the active ID must exist, there must be 1–16 keys, and
unknown top-level properties, malformed JSON, invalid IDs, noncanonical encoding, wrong key sizes, and
oversized values fail closed. High-entropy bytes must be generated by a cryptographically secure source;
the parser checks byte size/encoding, not entropy. Prior IDs/keys must remain available until ciphertext
written with them has been re-encrypted and verified.

`src/platform/security/bank-data-keyring.ts` exposes a lazy environment loader and a pure parser. Importing
the module does not read the environment. Missing or invalid configuration throws one generic typed error
without echoing the supplied JSON or key bytes; there is no generated, hard-coded, or development fallback.
Docker Compose passes the variable only into the application container, not the migration job. `.env.example`
and `.env.development.example` contain comments/placeholders only; no actual key values were read, written,
or committed. No current service calls the loader, so this does not enable or authorize bank-data access.

Seven pure tests pass for active/retained keys, unset configuration, malformed/unsupported shapes, missing
active keys, encoding/size/ID validation, key-count limits, and generic error redaction. The focused encryption
and keyring suites pass 13/13; `npm run typecheck` and `git diff --check` pass. No database setup or test
global cleanup ran.

**Boundary:** no deployment key was generated or provisioned; tests used only ephemeral test keys. No
database, schema, key-rotation/re-encryption job, profile, bank/contact service, reveal authority,
masking/history safeguard, or bank identifier was added. B-056's pure envelope helper is recorded in §26.73;
operational migration and key retirement remain future work. Full partner-bank storage remains blocked until
the D-059/D-060/D-067/D-068 security gate is complete. No commit or push; §25.4's full-system publish trigger
remains authoritative.


### 26.73 B-056 — Authenticated bank-data envelope re-encryption helper `IMPLEMENTED — PURE`

**Contract (D-069):** `reencryptBankData(envelope, context, keyring)` first fully authenticates and decrypts
the envelope using the key ID and context-bound associated data. If the envelope is already under the active
key ID, it returns the original string only after that verification succeeds. Otherwise, it encrypts the
transient plaintext with the supplied active key and a fresh nonce, returning a new versioned envelope; it
never returns or logs plaintext. Invalid/tampered ciphertext, a mismatched client/partner/record/field, or a
missing retained old key fails closed with the existing generic cryptography error.

The helper is pure with respect to storage: it does not update a row, write audit/history, authorize a reveal,
retire keys, or schedule a bulk migration. Callers must own any transaction, persistence, re-encryption
progress tracking, post-migration verification, and old-key retirement. The prior key must remain available
until all ciphertext using it has been migrated and verified.

Two added focused tests cover old-to-active re-encryption, ciphertext-only return, same-key idempotence,
verification before no-op, tamper/context refusal, and missing-prior-key failure. The encryption suite passes
8/8 and, with the seven B-055 keyring tests, the focused security suites pass 15/15. Typecheck and diff check
pass; tests use ephemeral keys and no database setup/global cleanup.

**Boundary:** no database, schema, bank field, real key, bank identifier, reveal authority, masking/history
safeguard, operational re-encryption job, or key-retirement behavior was added. Bank storage stays blocked;
B-057's history redaction boundary and separately audited reveal remain prerequisites. No commit or push;
§25.4's full-system publish trigger remains authoritative.

**Status update (v0.72):** B-057's write/read history redaction is recorded in §26.74. Ordinary-view masking,
separately audited reveal, and operational rotation/old-key retirement remain outstanding.


### 26.74 B-057 — Partner bank/contact history redaction `IMPLEMENTED — HISTORY ONLY`

**Privacy contract (D-070):** the generic `recordChange` path now applies an allowlisted projection before
serializing snapshots for the canonical object classes `partner_bank` and `partner_contact`. Bank IBAN,
local-account/account-number/account-identifier values (including ciphertext-column aliases) are replaced
with the fixed `[masked]` marker. Named-contact email and phone fields are likewise fully masked; no last
characters or length are retained. Approved non-sensitive fields such as account holder, country, bank name,
bank code/BIC, contact name/title/function, validity, active state and primary state remain in history.
Unknown and nested fields are dropped rather than serialized.

For these classes the generic free-form `reason` and caller-supplied field labels are omitted, because they
could smuggle sensitive values; safe field labels are regenerated from field names. Sensitive changes whose
before/after values both project to `[masked]` are still recorded when their in-memory source values differ;
true no-ops remain silent. The source values are used only for this equality check and never enter history.
`changeHistory` also reprojects stored values on read, replaces stored field labels, strips reasons and drops
unknown fields, providing defense in depth for any older/miswritten item. Organization-level
`business_partner` email/phone history remains unchanged. Future writers must use the exported canonical
object-class constants and opaque record IDs; alternate object classes are not covered by this policy.

Five isolated tests cover bank and contact masking on create/change, unknown-field and reason/label
suppression, masked change vs true no-op, read-time redaction of stored values, and preservation of general
partner email/phone. Typecheck and `git diff --check` pass; no database setup/global cleanup ran.

**Boundary:** this safeguards generic history only. It does not implement ordinary-view masking, at-rest
column integration, reveal authorization/audit, bank/contact storage, or key rotation operations. No schema,
migration, database, real bank identifier, or deployment key was added. B-058 must specify the separate
audited reveal contract; bank storage remains blocked until the full security gate is complete. No commit or
push; §25.4's full-system publish trigger remains authoritative.

**Status update (v0.73):** B-058 has specified the reveal contract (§26.75, D-071); audit-log hardening and
all reveal/view/storage implementations remain pending.


### 26.75 B-058 — Bank-data reveal authorization and audit contract `SPECIFIED — NOT IMPLEMENTED`

**Owner-selected policy (D-071):** a reveal requires both `FND.PARTNER.DISPLAY` and the dedicated
`SEC.PARTNER.BANK.REVEAL` capability, using the normal capability-pattern matcher. `FND.*` and `AUDIT.*`
do not match the `SEC` namespace, but the Administrator's `*` does grant reveal. Check the verified session
and both authorities before reading/decrypting a record. Missing-capability messages follow D-045; no
unauthorized request may expose whether a bank record exists.

One operation may request one or more allowlisted account-identifier fields—IBAN and/or local account number.
It does not reveal bank code/BIC, named-contact email/phone, or other fields. Require exactly one controlled
purpose code: `PARTNER_SUPPORT`, `DATA_CORRECTION`, `AUDIT_REVIEW`, or `LEGAL_REGULATORY`; no free-text
reason is accepted or logged.

Every authenticated operation attempt, successful or denied, is recorded in the existing tenant-scoped
`audit_access_log`. Success uses `event_type=READ`; missing authority uses `CAPABILITY_DENIED`; other
validation, record, or cryptographic denials use `READ` with a fixed denial code. Use
`transaction_code=SEC.PARTNER.BANK.REVEAL`, `object_type=partner_bank`, and an opaque bank-record `object_key`.
Tenant, actor ID and username come only from the verified session; the fixed-schema `detail` may contain the
partner key, selected field names, outcome, approved purpose code and fixed denial code. Never log identifier
values, ciphertext, key IDs/material, or raw invalid input. An unauthenticated request redirects to sign-in;
without a verified tenant/actor, no tenant-scoped reveal event is written.

The success audit row must commit before any plaintext is returned. If audit persistence fails, deny the reveal
and return no plaintext. Authorization, field/purpose validation, missing-record and cryptographic failures
also return no plaintext; non-authorization failures use a generic response that does not distinguish record
existence or expose cryptographic details. B-059 must first add database-enforced UPDATE/DELETE protection
for runtime access to `audit_access_log` (the current runtime grants include both). This batch changed no code,
capability catalogue, schema, migration, database or data; no tests were applicable. No commit or push; bank
data remains blocked pending implementation of the complete security gate.

**Status update (v0.74):** B-059 revoked direct runtime mutation of `audit_access_log` (§26.76). The owner
explicitly retained the existing whole-tenant `ON DELETE CASCADE` as a lifecycle/retention exception (D-072).


### 26.76 B-059 — Runtime audit-log mutation protection `IMPLEMENTED — DIRECT DML`

Added immutable migration `drizzle/9015_audit_access_log_append_only.sql`. It revokes `UPDATE`, `DELETE`,
and `TRUNCATE` from `cairn_app` on `audit_access_log`; existing `SELECT` and `INSERT` grants remain, so
runtime history can still be read and written. The change is narrowly scoped to this table. No trigger is
needed for direct DML because PostgreSQL rejects the operation at privilege check.

The owner explicitly selected the existing full-tenant `client` → `audit_access_log` `ON DELETE CASCADE`
as a permitted lifecycle/retention exception. B-059 leaves that FK and tenant-delete behavior unchanged;
whole-tenant deletion can still remove that tenant's logs through the cascade. This is the stated limit of
the direct-row append-only guarantee (D-072), not protection against every privileged lifecycle action.

Added `tests/audit-access-log-append-only.test.ts` to verify runtime SELECT/INSERT remain allowed, UPDATE/
DELETE/TRUNCATE are denied, and a tenant cascade still cleans the isolated development fixture. The integration
test was not run because no confirmed disposable development database was available; no database or owner/
production data was accessed. Typecheck and `git diff --check` pass. No reveal endpoint, capability entry,
bank data, or new audit table was added. No commit or push; §25.4's full-system publish trigger remains.

**Status update (v0.75):** B-060 adds the verified-session reveal gate and safe attempt/final-outcome writer
(§26.77, D-073). It remains a non-data boundary; no bank identifier is stored or returned.


### 26.77 B-060 — Session-bound reveal authorization and audit writer `IMPLEMENTED — NO DATA PATH`

Added `src/platform/security/bank-data-reveal.ts`. It requires a verified `SessionContext`, checks both
`FND.PARTNER.DISPLAY` and `SEC.PARTNER.BANK.REVEAL` using the existing matcher, validates requested fields
against `iban`/`localAccountNumber`, restricts purpose to the four D-071 codes, and accepts only safe-format
partner/bank-record keys. Tenant, actor ID and username are taken from the session; request-supplied identity,
free text, unknown fields and invalid key text are never copied into the audit detail.

`authorizeAndRecordBankRevealAttempt` inserts a safe `READ` or `CAPABILITY_DENIED` event. For an allowed
request its `AUTHORIZED` outcome means only that the gate passed—not that plaintext was read. The future
data service must then call `recordBankRevealOutcome` with terminal `SUCCESS` or a fixed-code `DENIED`, in the
same transaction, and return plaintext only after commit. Audit-write failures throw a generic denial error;
a caller must return logged denials from the transaction rather than throw inside it and roll back the event.
Neither helper reads data, decrypts ciphertext, nor returns plaintext.

Registered `FND.PARTNER.DISPLAY` and `SEC.PARTNER.BANK.REVEAL` in the idempotent global capability seed;
no role grant, command route or user interface was added, and the seed was not run. Normal role-pattern
semantics remain: Administrator `*` grants reveal, while `FND.*`/`AUDIT.*` do not. Seven isolated fake-Tx
tests pass for explicit/wildcard authority, session-derived actor/tenant, safe audit metadata, denied/invalid
requests, terminal outcomes and audit-write failure. Typecheck and `git diff --check` pass. No database,
key, bank record, decryption path or UI was used or added. No commit or push; §25.4's full-system publish
trigger remains authoritative.

**Status update (v0.76):** B-061 specifies ordinary-view identifier masking in §26.78 (D-074); implementation
remains a separate pure-projection batch. History stays fully masked, and the audited reveal gate is unchanged.


### 26.78 B-061 — Normal-view bank-identifier masking format `SPECIFIED — NOT IMPLEMENTED`

Owner selected a fixed `••••` marker for list/summary views and `••••` followed by the final four characters
for detail views of IBAN and local account number. Do not retain the country prefix or original identifier
length. If an identifier has four or fewer characters, show only `••••` so a short local account can never
become fully visible through the suffix rule. Use the final four characters as stored; never normalize or
change the underlying local account value for display. This does not alter bank code/BIC treatment, named
contact behavior or the full-value audited reveal flow. History remains fully `[masked]` under D-070.

B-061 was a policy-only batch: no code, UI, bank data, database or tests changed. D-074 records the choice;
B-062 implements the pure view projection only. No commit or push; §25.4's full-system publish trigger remains
authoritative.

**Status update (v0.77):** B-062 adds the pure allowlisted projection in §26.79 (D-075); no normal-view
route currently uses it. B-063 begins the first country-profile validator, KW only.


### 26.79 B-062 — Pure normal-view bank-identifier projection `IMPLEMENTED — NOT INTEGRATED`

Added `src/platform/security/partner-bank-view.ts`. `projectPartnerBankNormalView` reuses B-057's strict
`partner_bank` allowlist, then applies D-074: list mode returns fixed `••••`; detail mode returns `••••` plus
only the last four characters when the value exceeds four characters. Short values remain fully masked; empty,
null and undefined values remain empty/absent. Ciphertext aliases, unknown fields and nested non-sensitive
values are omitted; safe allowlisted metadata is preserved. A malformed nested value in an identifier field
is replaced by the fixed mask rather than exposed.

Three pure tests cover list and detail formats, suffix/length/country-prefix hiding, short values, empty values,
ciphertext omission, and unknown/nested-field dropping. The new tests plus B-057 history and B-060 reveal
boundary suites pass 15/15. Typecheck and `git diff --check` pass; no database, bank record, decryption, route
or UI was used or added. This helper does not authorize reads and no existing view calls it yet. No commit or
push; §25.4's full-system publish trigger remains authoritative.

**Status update (v0.78):** B-063 implements the pure KW profile helper (§26.80, D-076). It is not persisted,
activated, or connected to any bank-data flow.


### 26.80 B-063 — Pure Kuwait (`KW`) bank-profile validator `IMPLEMENTED — NOT ACTIVATED`

Added `src/platform/security/bank-profile-kw.ts`. It requires a non-empty account holder and country `KW`,
normalizes the IBAN to uppercase after removing ASCII spaces, and validates the exact 30-character
`KW` + check digits + four-letter bank code + 22-character alphanumeric account format. MOD-97 is checked
with a streaming remainder. The profile rejects any separate non-empty local account number and derives the
bank code from IBAN positions 5–8; an optional supplied bank code is accepted only if it matches that derived
value. Optional BIC/SWIFT is normalized and syntax-checked only; no directory, bank or account-existence
lookup occurs. Failures return fixed error codes, never raw input.

Four pure tests pass using only a synthetic KW-format identifier; they cover normalization/derivation, optional
BIC, KW-only/IBAN-only requiredness, structure/checksum, and mismatch/invalid-BIC failures. Typecheck and
`git diff --check` pass. No database, profile registry/activation, schema, bank storage, actual bank value,
decryption, or UI was used or added. This helper is not called by any save path. B-064 (IN profile) is next;
no commit or push; §25.4's full-system publish trigger remains authoritative.

**Status update (v0.79):** B-064 adds the pure IN profile helper (§26.81, D-077). It is not persisted,
activated, or connected to any bank-data flow.


### 26.81 B-064 — Pure India (`IN`) bank-profile validator `IMPLEMENTED — NOT ACTIVATED`

Added `src/platform/security/bank-profile-in.ts`. The pure helper requires a non-empty account holder and
country `IN`. It requires a non-empty local account number and returns it exactly as supplied, preserving
leading zeros and any bank-specific representation; it imposes no India-wide account-number length, syntax,
checksum, padding, or truncation rule. Non-string account input is rejected with a fixed error. The profile
rejects a non-empty IBAN. It requires IFSC in the existing `bankCode` field, trims and uppercases it, and
validates exactly `^[A-Z]{4}0[A-Z0-9]{6}$`. Optional BIC/SWIFT is normalized and syntax-checked only. No
IFSC directory, bank, branch, account-existence, or payment-rail lookup occurs; account type remains outside
this bank-master profile. Failures expose only fixed error codes, and unknown input properties are not returned.

Five isolated tests pass with synthetic identifiers only. They cover IFSC/BIC/country normalization, exact
opaque account preservation without a national format/length rule, required fields, IBAN rejection, invalid
IFSC/BIC and rejection of non-string account input. Typecheck and `git diff --check` pass. No profile registry
or activation, persistence, schema, database, bank storage/data, decryption, save path, route, or UI was used
or added. The helper is not enabled or called by any save path. No commit or push; §25.4's full-system publish
trigger remains authoritative.

**Status update (v0.80):** B-065 adds pure GB, US and JP validators (§26.82, D-078–D-080). All five
initial-country validators are still unregistered, unactivated and disconnected from bank-data flows.


### 26.82 B-065 — Pure GB, US and JP bank-profile validators `IMPLEMENTED — NOT ACTIVATED`

Added `src/platform/security/bank-profile-gb.ts`, `bank-profile-us.ts` and `bank-profile-jp.ts`.

**GB:** Requires account holder and country `GB`; removes ASCII spaces, uppercases, enforces the 22-character
`GB` + check digits + four-letter institution code + 14-digit format, and validates MOD-97. Derives the bank
code from IBAN positions 5–8, checks any supplied bank code for consistency, and rejects a separate non-empty
local account number. Optional BIC receives syntax-only validation; no account/branch lookup or payment-rail
claim is made.

**US:** Requires account holder, country `US`, an opaque non-empty local account number, and a nine-digit ABA
routing transit number in `bankCode`. It enforces the `01–12` or `21–32` routing-symbol range and the 3-7-1
mod-10 check digit. The account number is preserved exactly with no U.S.-wide length, pattern, checksum,
padding or truncation rule. Optional BIC receives syntax-only validation. No live directory, assignment/currentness,
payment-rail or account-existence claim is made; a non-empty IBAN is rejected.

**JP:** Requires account holder, country `JP`, an opaque non-empty local account number and exactly seven ASCII
digits in `bankCode` for the institution-plus-branch composite. Leading zeros in both identifiers are preserved;
no nationwide local-account format/length/checksum or padding/truncation rule is imposed. Optional BIC receives
syntax-only validation. No directory/account lookup or Japan Post symbol/number conversion is performed; for
Japan Post the caller must supply the transfer-compatible representation described by D-066. A non-empty IBAN
is rejected.

Four GB, five US and five JP isolated tests pass with synthetic fixtures only (14 total). They cover country and
identifier normalization, GB structure/MOD-97/derived bank code, US routing range/check digit, JP composite
format, opaque account preservation, optional/invalid BIC, required fields and IBAN/local-account rejection.
Typecheck and `git diff --check` pass. No profile registry or activation, persistence, schema, database, bank
data, encryption/decryption, save path, route or UI was used or added. These helpers are not called by any save
path. No commit or push; §25.4's full-system publish trigger remains authoritative.

**Status update (v0.81):** B-066 enforces `FND.PARTNER.DISPLAY` before partner data reads on the actual
`/foundation/partners` route (§26.83, D-081). No reveal path is added; opaque bank-record-ID handling remains
unresolved and blocks any future reveal execution path.


### 26.83 B-066 — Partner display-route authorization `IMPLEMENTED — NO BANK DATA PATH`

`src/app/foundation/partners/page.tsx` now checks the session's `FND.PARTNER.DISPLAY` capability immediately
after session resolution and before awaiting route/search parameters or calling partner, company, country, or
history read services. A missing capability receives the explicit missing-authority message without any partner
data query. The page code label now identifies the display authority. `FND.PARTNER.MAINTAIN` remains a separate
write authority enforced by the existing UI condition and server actions; supplier/customer segment reads retain
their own capability checks.

Added `tests/partner-display-page-auth.test.tsx`. Its denial case verifies the actual page guard is evaluated
before `searchParams` can be read. The isolated route test passes; typecheck and `git diff --check` pass. The test
used a mocked session and no database. No bank data, reveal route, decryption, or bank-record-ID handling was
added; B-060's ID-opacity concern remains a blocker before any reveal execution path. No commit or push;
§25.4's full-system publish trigger remains authoritative.

**Status update (v0.82):** B-067 defines server-generated UUIDv4 bank-row IDs and tightens the reveal
boundary's shape check (§26.84, D-082). This does not establish ID provenance; a tenant/partner-scoped row
lookup is still required before any reveal path.


### 26.84 B-067 — Bank-record ID generation contract `IMPLEMENTED — NO STORAGE OR REVEAL`

Added `src/platform/security/bank-record-id.ts`. `generateBankRecordId()` uses Node's cryptographic `randomUUID`
to create a canonical lowercase UUIDv4; `BankRecordId` is a compile-time brand, and `isBankRecordId()` checks
UUIDv4 shape only. B-060's reveal-audit boundary now accepts only that shape and returns `INVALID_OBJECT_KEY`
for malformed/sequential IDs, writing a null audit object key rather than echoing the invalid input.

This is not proof that a well-shaped UUID was generated by the app or belongs to the requested partner. The
future repository must generate IDs with this helper and resolve every requested row under the session-derived
tenant, selected partner and supplied ID, then use the matched row's ID for audit/encryption context. It must
never treat a raw client-provided UUID as a trusted record reference. No partner-bank table, row creation, lookup,
persistence, database, bank value, reveal path or decryption was added; the opacity blocker remains until that
scoped data path is implemented and verified.

Three ID-helper tests and eight B-060 boundary tests pass (11 total), including a test documenting that UUID
shape alone cannot attest provenance. Typecheck and `git diff --check` pass. No commit or push; §25.4's
full-system publish trigger remains authoritative.

**Status update (v0.83):** B-068 enforces the UUIDv4 record-ID format at the encryption-context boundary
(§26.85, D-083). Tenant/partner-scoped row lookup is still absent and remains a prerequisite before reveal.


### 26.85 B-068 — UUIDv4 enforcement in bank-data encryption context `IMPLEMENTED — NO STORAGE OR REVEAL`

`src/platform/security/bank-data-encryption.ts` now types `BankDataContext.bankRecordId` as `BankRecordId` and
runtime-validates it with `isBankRecordId()` before including it in GCM associated data. Encrypt, decrypt and
re-encrypt therefore reject noncanonical/non-v4 record IDs with the existing generic crypto error. Valid row IDs
remain bound to the authenticated client, partner, field and key ID as before.

The pure crypto layer does not establish where a valid-shaped ID came from. A future bank repository must create
row IDs with `generateBankRecordId()` and load records using authenticated tenant + selected partner + ID before
any reveal operation; B-068 does not implement that lookup. Eight encryption tests, three ID-helper tests and
eight B-060 audit-boundary tests pass (19 total). Typecheck and `git diff --check` pass. No schema, persistence,
database, bank data, reveal route or decryption caller was added. No commit or push; §25.4's full-system publish
trigger remains authoritative.

**Status update (v0.84):** B-069 adds a pure batch re-encryption transformer (§26.86, D-084). It operates
only on rows supplied by a caller; no database scan or old-key retirement verification is implemented.


### 26.86 B-069 — Pure batch bank-data re-encryption `IMPLEMENTED — NO PERSISTENCE`

Added `reencryptBankDataBatch` to `src/platform/security/bank-data-encryption.ts`. It accepts one bounded
caller-supplied set of records, validates UUIDv4 row IDs and per-field authenticated context, re-encrypts each
non-null envelope with the active key, authenticates and preserves already-current envelopes, preserves nulls,
and returns ciphertext-only row projections plus a changed-field count. It does not mutate inputs, return
plaintext, read/write a database, log values, or persist partial results; an invalid envelope fails the call.

Three new batch tests cover re-encryption, current-key no-op, null preservation, input immutability, ciphertext-only
output and fail-closed invalid input. Together with the ID and reveal-boundary suites, 22 focused tests pass.
Typecheck and `git diff --check` pass. No actual bank values, schema, database scan, persistence, operational
monitoring, exhaustive re-encryption verification or old-key retirement was used or added. A future runner must
process all rows in bounded tenant-scoped transactions, verify every envelope against the active key and retire
prior keys only after verified completion. No commit or push; §25.4's full-system publish trigger remains
authoritative.

**Status update (v0.93):** B-078 closes B-077's live-acceptance gap on a fresh disposable PostgreSQL 17.11 cluster.
The custom runner applied all 32 lexical SQL migrations, then the T992 Business Partner target passed for both the
maintainer and a display-only user: Bank Details showed the empty state without Save or reveal controls. The Drizzle
journal/snapshots ending at 0008 are not read by this runner and did not affect acceptance; future Drizzle Kit
migration generation still requires a separate metadata reconciliation. The target cleaned up T992, verified absent;
the cluster used only a private Unix socket with TCP disabled and was removed. `npm run typecheck`, browser-harness
(66/66), and `git diff --check` pass. No owner/production or persistent development database, bank rows, or real
identifiers were accessed. B-076's view remains read-only; encryption-key retirement, encrypted writes/reveal, and
contact UI remain separate gates. No commit or push.

**Status update (v0.94):** After B-078, the owner explicitly instructed a one-time publication of the pending bank-data
batch to `main`, overriding §25.4's full-system gate for this batch only. The standing no-partial-push rule remains
for future batches. Commit `9a39286` was pushed successfully; §26.96 records the publication. No credential was
included in the commit, remote URL, or source.


### 26.87 B-070 — Active-key verification for supplied batches `IMPLEMENTED — NO GLOBAL RETIREMENT PROOF`

Added `verifyBankDataBatchOnActiveKey` to `src/platform/security/bank-data-encryption.ts`. It requires a keyring
with exactly one key—the active key—then checks each non-null envelope's key ID and authenticates/decrypts it
against the record's client, partner, UUIDv4 row ID and field context. It returns only the active key ID and
record/field counts; it does not return plaintext. Retained-key rings and prior-key envelopes fail closed.

Two tests cover a successfully re-encrypted batch, rejection of an old-key envelope, and refusal of a keyring
that still includes prior keys. Thirteen encryption tests plus three ID-helper and eight audit-boundary tests pass
(24 total). Typecheck and `git diff --check` pass. The verifier only speaks for supplied rows; it does not prove
a database scan was complete, cover concurrent writes, persist results, or authorize retiring any key. No database,
real bank data, schema, reveal path, or commit/push was used.


### 26.88 B-071 — Pure partner-bank country-profile dispatcher `IMPLEMENTED — NOT INTEGRATED`

Added `validatePartnerBankProfile` in `src/platform/security/partner-bank-profile.ts`. It trims and uppercases
the country code, then dispatches only to the implemented KW, IN, GB, US, or JP pure validator. Missing country
returns `COUNTRY_REQUIRED`; any other country returns `PROFILE_UNAVAILABLE`; there is no fallback profile.
Country-specific validation remains in the individual profile helpers and follows D-060–D-066/D-076–D-080.

Added three synthetic dispatcher tests covering all five country paths, country-code normalization, and missing/
unsupported-country rejection. The dispatcher suite and all five profile suites passed: 26 tests across six files.
`npm run typecheck` passes. This helper does not activate profile validation in an application save path, persist
records, create schema or database state, establish profile readiness beyond these helpers, or contain real bank
data. No lookup, reveal path, commit, or push was added.


### 26.89 B-072 — Ciphertext-only partner-bank schema and read-only RLS `IMPLEMENTED — TESTED IN B-073`

Added `partner_bank` to the typed Foundation schema and registered it at the schema root. Migration
`0013_partner_bank_master.sql` defines the partner-wide row with a server-generated UUIDv4 key, required
holder/country, optional bank metadata, validity dates, active/version/audit fields, and exactly one of two
account-identifier envelope columns: `iban_ciphertext` or `local_account_number_ciphertext`. There are no
plaintext identifier columns. Database checks require the `cbd1` envelope shape, UUIDv4 variant/version,
nonblank holder, valid date order and positive version; overlapping validity remains allowed. Tenant deletion
follows D-041's client cascade; deleting a partner row directly is blocked while bank records exist.

Migration `0013_partner_bank_master.sql` enables and forces RLS immediately, with no policy yet, so the table
default-denies even if the existing `9000` migration or its default privileges grant DML. Migration
`9016_partner_bank_policies.sql` installs the scoped SELECT policy, revokes all app-role privileges previously
granted by `9000`, and grants only SELECT; the app cannot insert, update, delete or truncate partner-bank rows.
Four typed-schema/static-contract tests and `npm run typecheck` passed at B-072 completion; at that point, no
migration had been applied. B-073's disposable acceptance later caught PostgreSQL's repetition-count limit in
the initial envelope regex. Migration `0014_partner_bank_envelope_bound.sql` replaces those constraints using a
PostgreSQL-safe nonempty payload pattern and a 5,540-character total-envelope cap, without editing `0013`.
See §26.90 for final live acceptance. The shape constraint does not authenticate ciphertext. No bank-row service, save path, scoped lookup, bank data, UI, reveal path, commit or push was added.


### 26.90 B-073 — Disposable PostgreSQL acceptance for partner-bank schema `PASSED — CLUSTER REMOVED`

Downloaded/extracted PostgreSQL 17.11 binaries under a temporary `/tmp` directory, initialized a fresh local
cluster with host connections disabled, and applied every SQL migration in `drizzle/` in lexical order. The
cluster used only local Unix-socket connections. Synthetic development tenants `T991`/`T992`, partners, and
placeholder envelopes were created only inside this disposable database; the cluster, package files, and test
rows were removed by the cleanup trap. No configured, owner, production, or persistent development database was
contacted.

The first fixture insert exposed a PostgreSQL ARE repetition-count limit: the initial migration's `{1,5462}`
regex could not be evaluated. Kept migration `0013` unchanged and added `0014_partner_bank_envelope_bound.sql`.
It uses a nonempty URL-safe payload pattern plus a total-envelope cap of 5,540 characters, matching the 4,096-byte
plaintext limit; the 5,540-character boundary was accepted and 5,541 was rejected. All migrations, including
`0014` and `9016`, then applied successfully.

Live checks passed: multiple same-partner records with overlapping validity were accepted; missing/both identifier
envelopes, plaintext in a ciphertext column, a non-v4 UUID, blank holder, inverted dates, version zero, unknown
country and oversize envelope were rejected. Forced RLS flags were both true. The `cairn_app` role had SELECT but
not INSERT/UPDATE/DELETE/TRUNCATE; unscoped reads returned no rows, tenant-scoped reads saw only their tenant,
and cross-tenant reads were hidden. App-role DELETE was denied, direct partner deletion was blocked while bank
rows existed, and tenant deletion cascaded to the synthetic bank rows under D-041. Five typed-schema/static
contract tests and `npm run typecheck` pass; `git diff --check` passes.

This proves the migration/constraint/RLS behavior only on the temporary PostgreSQL cluster. It does not prove
ciphertext authenticity, operational key rotation or global retirement, nor add a bank-row service, write path,
scoped lookup, UI, reveal path or contact storage. No commit or push.


### 26.91 B-074 — Read-only, scoped partner-bank metadata lookup `IMPLEMENTED — NO REVEAL OR UI`

Added `lookupPartnerBankMetadata` in `src/modules/foundation/partner-bank-reads.ts`. It requires
`FND.PARTNER.DISPLAY` through the existing capability matcher, validates the session-derived tenant, selected partner
number and canonical UUIDv4 row ID, then calls `withTenant` using the session tenant. Its single-row query binds
`partner_bank.client`, `partner_bank.partner_number`, and `partner_bank.bank_record_id` together. The result is a
strict allowlist of non-ciphertext metadata plus `bankRecordId` from the matched database row; encrypted IBAN and
local-account columns are not selected, and no account-identifier plaintext, decryption or reveal authority is involved.
Invalid selectors, invalid returned row IDs and absent rows return `null`; callers cannot supply a tenant.

Four focused tests verify authorization denial without a query, the tenant/partner/row-ID SQL predicates and bound
values, the metadata-only projection, and invalid/missing-row behavior. `npm run typecheck` and `git diff --check`
pass. Tests use a fake tenant transaction and Drizzle PostgreSQL SQL rendering; no live or persistent database was
accessed. No writes, audit/reveal integration, save path, route, UI, masking projection, bank values, commit or push
were added. Normal bank identifiers remain subject to D-074 masking, and any future reveal must retain all existing
authorization, audit-before-return, fail-closed audit, encryption, provenance and key-retirement gates. The metadata
lookup is not an encrypted-row reveal loader.


### 26.92 B-075 — Read-only, scoped partner-bank metadata list `IMPLEMENTED — NO REVEAL OR UI`

Added `listPartnerBankMetadata` to `src/modules/foundation/partner-bank-reads.ts`, reusing the single-row metadata
allowlist from B-074. It requires `FND.PARTNER.DISPLAY`, validates the session-derived tenant and selected partner,
then runs through `withTenant` with explicit predicates on `partner_bank.client` and `partner_bank.partner_number`.
No caller-supplied tenant is accepted. The projection excludes both encrypted account-identifier columns and any
plaintext IBAN/local-account field; every returned row ID is UUIDv4-checked and comes from that database row.

The query returns all matching rows, including inactive and out-of-validity history, without an implicit truncation.
Rows are ordered by `validFrom` descending and UUIDv4 row ID ascending for deterministic display. Invalid selectors or
an invalid-shaped row ID fail closed as `null`; a valid partner with no rows returns an empty list.

Four added tests cover display denial without a query, tenant/partner predicates and parameters, stable ordering,
inactive-row inclusion, metadata-only projection, invalid selectors, empty results, and malformed database IDs. The
focused metadata-read suite passes 8/8; `npm run typecheck` and `git diff --check` pass. Tests use a fake tenant
transaction and Drizzle PostgreSQL SQL rendering; no live or persistent database was accessed. Tests use only synthetic
metadata placeholders; no bank rows were persisted. No real account identifiers, ciphertext, decryption, writes,
audit/reveal path, masking projection, route, UI, or commit/push were added. Ordinary-view
masking and all existing encryption, UUID-provenance, key-retirement, and audited-reveal gates remain unchanged.



### 26.93 B-076 — Display-only masked bank metadata tab `IMPLEMENTED — NO LIVE DB/BROWSER ACCEPTANCE`

Added the explicit `BANKS` tab to the selected-partner navigation in `src/app/foundation/partners/page.tsx` and a
server-rendered `PartnerBankMetadataPanel`. The query runs only when that tab is selected; the existing general view
and other segments do not call the partner-bank list service. The route's existing `FND.PARTNER.DISPLAY` guard remains
before search-parameter reads, and the panel receives only B-075's session-tenant/partner-scoped metadata result.

The panel is display-only and shared across Supplier/Customer roles. It shows account holder, country, bank name/code,
BIC, validity dates and active state. The identifier column renders only the fixed `••••` list mask from D-074, with an
accessible “masked” label. Bank-record IDs are used only as render keys and are not printed; ciphertext and full
identifier values are not queried or passed to the component. No edit, save, reveal, detail-suffix, or history action
is exposed on this tab. It is available only to the already-authorized partner-display route.

Two panel-render tests cover safe metadata, fixed masking, row-ID/ciphertext omission and empty/unavailable states. Two
route tests verify display denial avoids the bank read and the explicit `BANKS` tab alone invokes the list service with
the authenticated session and matched partner. The focused tests pass 4/4; typecheck, production build,
and `git diff --check` pass. A temporary
Vitest configuration used JSX automatic mode and disabled destructive global setup; it was removed. No live database,
migration application, browser acceptance, actual bank row or real account identifier was used. The new tab requires
the bank migrations in the target database; acceptance must use a fresh disposable development database only.

This does not add bank/contact maintenance, operational key rotation/re-encryption, old-key retirement, normal-detail
suffix display, audited reveal/decryption, or contact views. D-074's summary mask is integrated only for this tab; the
full bank-data gate remains closed. No commit or push; §25.4's full-system publish trigger remains authoritative.



### 26.94 B-077 — Business Partner browser target coverage for bank metadata `IMPLEMENTED — ACCEPTED IN B-078`

Extended `scripts/browser-smoke/checks.ts`'s existing `business-partners` target (reserved development fixture T992).
After creating the partner through the UI, the target opens the `BANKS` tab, verifies the no-record empty state, and
asserts that neither save nor reveal controls appear. It returns to General data and later repeats the empty-state and
no-maintenance/no-reveal checks after signing in as a display-only warehouse user. The target creates no bank row or
bank/account value; the fixed-mask rendering remains covered by B-076's component test. The target label was updated
to describe its bank-summary coverage.

At B-077 completion, `npm run typecheck` and `npm run test:browser-harness` (66/66) passed, and
`npm run smoke:browser -- --list` confirmed the updated Business Partner target was selectable. Live acceptance was
then pending because no confirmed disposable database was available; §26.95 records the subsequent B-078 acceptance.
The target's fixture guard still refuses to delete a tenant unless it matches the exact reserved T992 development
fixture. No commit or push; §25.4's full-system publish trigger remains authoritative.


### 26.95 B-078 — Drizzle metadata review and disposable B-077 browser acceptance `PASSED — CLUSTER REMOVED`

**Metadata review.** At this revision, `drizzle/meta/_journal.json` and snapshots end at `0008`, while the SQL
folder continues through `0014` and policy files through `9016`. `src/platform/db/migrate.ts` does not read Drizzle
metadata: it applies every `drizzle/*.sql` file in lexical order and records its filename/checksum in
`cairn_migration`. The discrepancy therefore did not affect the fresh-database acceptance procedure. Metadata was not
changed; future Drizzle Kit generation/snapshot-diff behavior remains unreviewed and must be resolved separately
before relying on that workflow.

**Disposable acceptance.** Extracted PostgreSQL 17.11 binaries under `/tmp`, initialized a fresh cluster with TCP
listening disabled, host authentication rejected, and a private Unix socket only. A local migration role had
`BYPASSRLS`; `cairn_app` was non-superuser and did not bypass RLS. The custom runner applied all 32 SQL migrations;
shared reference and global catalogue seeds loaded into that disposable database. No configured, unverified,
persistent development, owner, or production database was contacted.

`npm run smoke:browser:business-partners` passed on the built app against the disposable database. The T992 fixture
was created through onboarding and cleaned by the target; a post-run query confirmed no T992 development fixture
remained. Maintainer and display-only partner viewer both saw the Bank Details empty state with no Save or reveal
controls. The existing partner create/maintain/no-op, dual-role, block/unblock, invalid-country, search, and history
checks also passed. No bank record, bank/account value, ciphertext, or real identifier was created or read.

The browser harness now satisfies the optional owner-token form field with a per-run random value only if that field
is rendered; the runner remains development-only. Its synthetic T992 warehouse viewer is granted
`FND.PARTNER.DISPLAY` without `FND.PARTNER.MAINTAIN`, so the view-only assertion exercises an authorized display user.
`npm run typecheck`, `npm run test:browser-harness` (66/66), and `git diff --check` pass. The app and cluster were
stopped; temporary cluster and extracted package files were removed. The PAT in `.env.local` was not read or
revealed; its contents were left unchanged and the file was restored. No commit or push; §25.4's full-system publish
trigger remains authoritative.


### 26.96 B-079 — Owner-directed publication of the bank-data batch `PUSHED TO MAIN`

After B-078, on 2026-10-11 the owner explicitly directed a push of the pending bank-data worktree to `main`. This was
a one-time exception to §25.4's full-system publish gate; the standing no-partial-push instruction remains in force
for future batches. The 47-file source/test/migration/documentation batch was committed as
`9a39286 feat: add partner bank-data foundations and read-only view` (4,464 insertions, 39 deletions) and fast-forward
pushed from `39e3d35` to the documented repository's `main`; `origin/main` now tracks the branch.

The PAT in ignored `.env.local` was used only for authentication through a temporary askpass helper. Its value was
not staged, committed, placed in the remote URL/Git configuration, or displayed; the helper was removed. A staged-file
check confirmed none of the 47 paths contained the PAT or recognizable GitHub-token material. `.env.local` remains
ignored and untracked. No database or bank data was accessed for publication.


### 26.97 B-080 — Scoped D-074 detail mask reader `IMPLEMENTED — NOT UI-INTEGRATED`

Added server-side `getPartnerBankMaskedDetail` in `src/modules/foundation/partner-bank-detail-view.ts`. It requires
actual `FND.PARTNER.DISPLAY`, derives tenant from the authenticated session, and loads exactly one row with tenant,
selected partner, and UUIDv4 bank-row ID bound together. After matching all three values, it uses the database row's
client, partner number, and row ID as authenticated-decryption context. The query selects only approved metadata and
the two ciphertext columns; it selects no identifier plaintext column. Exactly one non-null, non-empty identifier
envelope is required. The service applies the existing D-074 detail projection internally and returns only the identifier kind
and `••••` plus the final four characters; it returns no plaintext, ciphertext, or row ID. Crypto errors remain generic.

The caller must provide the keyring explicitly; the deployment keyring loader is not yet connected. This service is
not wired to a route or UI and provides no save control, full-value reveal authority, reveal audit operation, or
plaintext-returning response. Six focused synthetic-envelope tests use a fake tenant transaction and verify
capability denial, tenant/partner/row-ID predicates, ciphertext-only selection, IBAN/local-account masking,
row mismatch and malformed-envelope rejection, and generic authenticated-decryption failure. The focused suite (6/6),
`npm run typecheck`, browser harness (66/66), and `git diff --check` pass. No database, real bank data, browser
acceptance, commit or push. §25.4's full-system publish trigger remains authoritative; a read-only detail UI is a
separate next slice.


### 26.98 B-081 — Read-only D-074 bank-detail UI integration `IMPLEMENTED — LIVE SYNTHETIC ACCEPTANCE IN §26.99`

The Business Partner Bank Details tab now adds a `View details` link per metadata row. The opaque UUIDv4 is carried
as the `bank` selector only; the page passes it with the authenticated session and matched partner to
`getPartnerBankMaskedDetail`, whose tenant + partner + row-ID query and row-derived crypto context remain the
security boundary. The server loads the versioned deployment keyring on demand only for an explicitly selected
bank detail. The new read-only detail panel receives only the safe DTO and shows the account kind, fixed `••••`
mask plus final four characters, and allowlisted bank metadata. It also provides a back-to-list link. Keyring
configuration and authenticated-decryption errors render a generic unavailable state; other server/database errors
are not converted into record-not-found responses.

No save/edit controls, full-value reveal, reveal authority/audit path, plaintext response, schema, or write behavior
was added. No keyring secret was provisioned, no real bank data or database row was used, and no live browser/database
acceptance was run. Four isolated no-database focused test files pass 14/14 (scoped reader 6, metadata panel 2,
detail panel 2, route integration/authorization 4); `npm run typecheck`, production build, browser harness (66/66),
IP lint (223 files), and `git diff --check` pass. No commit or push; §25.4's full-system publication trigger remains
authoritative.


### 26.99 B-082 — Synthetic D-074 masked-detail browser acceptance `PASSED — CLUSTER REMOVED`

Extended the guarded `business-partners` browser target with one synthetic encrypted `partner_bank` fixture because
there is no product write path. The fixture writer requires an explicit `CAIRN_SMOKE_FIXTURE_DATABASE_URL` and
refuses writes unless the database is `cairn_test`, the server address is `127.0.0.1`, the connection is elevated,
and the exact `T992` owned browser tenant is marked development with the UI-created partner present and no prior bank
row. A fresh random UUIDv4 and a synthetic-only identifier were encrypted using a per-run test keyring; the keyring
file was mode 0600 under `/tmp` and removed after the run. App reads continued through `cairn_app` with its
SELECT-only bank-table privilege.

On a fresh local PostgreSQL 17.11 cluster, the browser target applied all 32 migrations and shared seeds, onboarded
T992 through the UI, confirmed the empty bank state, inserted only the guarded synthetic ciphertext fixture, and
passed for both the maintainer and a display-only viewer. Both saw the fixed list mask and detail `••••4321`; neither
page contained the synthetic full value or ciphertext, and neither offered Save or reveal controls. No page errors.
Post-run verification showed zero T992 tenant, partner, and bank rows; the app and database were stopped, and the
cluster, extracted PostgreSQL package, and test keyring were removed. `npm run smoke:browser:business-partners`,
`npm run typecheck`, browser harness (66/66), IP lint (223 files), and `git diff --check` pass. No owner/production
or persistent development database, real bank data, schema change, commit or push. §25.4 remains the full-system
publish gate.


### 26.100 B-083 — Initial fail-closed bank-profile readiness boundary `IMPLEMENTED — EXTENDED BY B-085`

At B-083 completion, `src/platform/security/partner-bank-profile-readiness.ts` provided a pure deny-only readiness
query for the owner-approved D-061 authoring set (`IN`, `KW`, `GB`, `US`, `JP`). It normalized country input and
returned `PROFILE_NOT_READY` for every approved country until persisted configuration existed; missing and unsupported
countries also denied. Validator availability or a successful pure validation was not treated as profile readiness.
B-085 later extends this module with row/revision resolution and adds a read-only database lookup (§26.102); readiness
still does not grant bank-save authority.

B-083 added no profile persistence, readiness activation, country-profile data, validator-to-save integration, save
service, schema/migration, or bank values. Eight focused synthetic/no-DB tests passed at that batch, including all five
approved countries and the validator-success/readiness separation; typecheck, IP lint (225 files), and `git diff --check`
passed. No DB, browser acceptance, commit or push. §25.4's full-system publication trigger remains authoritative.


### 26.101 B-084 — Shared global bank-profile readiness registry `IMPLEMENTED — ACCEPTED IN §26.103`

Following the selected global governance model, added `partner_bank_country_profile` as a shared, country-keyed
registry with source-policy revision (`D-062`–`D-066`), readiness status (`NOT_READY`/`READY`), version and audit
columns. The country FK binds each row to global reference data; no tenant key or RLS is appropriate for this shared
policy table. Additive migration `0015_partner_bank_country_profile.sql` creates it, and `9017` revokes all runtime
privileges then grants only `SELECT` to `cairn_app` (the application cannot activate or rewrite profiles).

`seed-reference.ts` defines idempotent rows for the five D-061 countries, initially `NOT_READY`. A repeated seed for
the same policy revision preserves status/version; changing the policy revision resets that row to `NOT_READY`, bumps
version and records a system change. At B-084 completion, the static B-083 resolver was not yet wired to this table
and no runtime readiness reader existed; B-085 adds the read-only lookup in §26.102. There is still no activation action,
profile authoring UI, bank save path or reveal path.

Twelve focused no-database schema/readiness tests passed at B-084 completion; typecheck, IP lint (229 files), and
`git diff --check` passed. No database or migration was executed in B-084, and no Drizzle Kit metadata snapshot was
reconciled. B-086 later applied and accepted the migrations/seeds on a fresh disposable cluster (§26.103); no
owner/production or real bank data was used. No commit or push. §25.4 remains the full-system publish gate.


### 26.102 B-085 — Read-only global profile-readiness service `IMPLEMENTED — ACCEPTED IN §26.103`

Added `readPartnerBankProfileReadiness` in `src/modules/foundation/partner-bank-profile-readiness.ts`. Missing and
unsupported country inputs are rejected before DB access. For one of the five approved countries, the service verifies
the runtime application role, then selects only `policy_revision` and `readiness_status` from the global registry using
the normalized country key; it does not establish a tenant scope because the table is shared reference configuration.
Database/role errors propagate, so callers must fail closed. The pure resolver returns ready only for an explicit
`READY` registry row whose policy revision matches the current D-062–D-066 mapping. This is profile readiness only,
not permission to save bank data.

`createPartnerBankProfileReadinessReader` supports deterministic no-database service tests. The tests cover preflight
no-query behavior, ready state, stale revisions, not-ready/missing rows, and registry failure. Combined profile
resolver/schema/service suites passed 19/19; typecheck, IP lint (231 files), and `git diff --check` passed. No database
migration/seed was executed in B-085; B-086 later accepted the reader against the app role on a disposable cluster
(§26.103). No activation route, bank save/reveal path, UI or real bank data. No commit or push; §25.4 remains the
full-system publish gate.


### 26.103 B-086 — Disposable PostgreSQL acceptance for B-084/B-085 `PASSED — CLUSTER REMOVED`

Initialized a fresh PostgreSQL 17.11 cluster under `/tmp`, created a new `cairn_test` database, and applied all 34
lexical migrations, including `0015` and `9017`. `npm run seed:reference` created exactly five global profile rows for
IN/KW/GB/US/JP at `NOT_READY`, with policy revisions D-063, D-062, D-064, D-065 and D-066 respectively. The database
identity query reported the expected test database, local address/port and elevated migration role.

Verified the global registry has no RLS, `cairn_app` can read all five rows, and that role has no INSERT/UPDATE/DELETE
privilege; an attempted UPDATE was denied. The B-085 service, using `cairn_app`, reported KW not-ready initially,
then ready only after a synthetic `READY` status was set in this disposable DB for matching D-062. A same-revision
reference-seed rerun preserved that status/version. After staging a stale revision, the seed reset the row to D-062
and `NOT_READY`, incremented version and set `changed_by=SYSTEM`; the runtime service returned not-ready again. The
other four profiles remained blocked. This temporary status toggle was not a product activation.

Final counts were zero tenants, partners and bank rows, with the five global profile rows. The PostgreSQL server was
stopped, temporary cluster/package/test script removed, and final listener check showed port 55433 closed. No remote,
owner/production or persistent database, real bank data, bank-save/reveal path, commit or push. `npm run db:migrate`,
`npm run seed:reference`, the runtime-role check and B-085 service integration all passed; §25.4 remains the
full-system publish gate.


### 26.104 B-087 — Register profile-activation capability and fixed evidence code `IMPLEMENTED — NO ACTION`

Following the owner-approved activation contract, added the stable capability identifier
`CFG.FND.PARTNER.BANKPROFILE.ACTIVATE` and fixed evidence code `PROFILE_VALIDATION_ACCEPTED` in
`src/platform/security/partner-bank-profile-activation.ts`. The global seed catalogue registers the capability as
Foundation `CONFIGURE`, non-posting. It adds no `role_capability` grants; existing Administrator `*` wildcard
semantics remain unchanged, and other roles receive no new authority by this batch.

This is catalogue-only groundwork. No activation action, profile mutation, dedicated global audit table, role grant,
UI or database seed was added/run. Two focused tests verify catalogue registration, no seeded grants, controlled
evidence and existing wildcard semantics; combined profile registry/readiness/capability suites pass 21/21.
Typecheck, IP lint (233 files), and `git diff --check` pass. No commit or push; §25.4 remains the full-system
publication gate.


### 26.105 B-088 — Pure partner-bank profile activation command contract `IMPLEMENTED — NO MUTATION`

Added `validatePartnerBankProfileActivationCommand` to the profile activation security module. It accepts only the
four approved fields: country, expected policy revision, expected row version, and fixed evidence code. It
canonicalizes an approved country, requires an exact match to its current D-062–D-066 policy revision, requires a
positive PostgreSQL `integer` version, and accepts only `PROFILE_VALIDATION_ACCEPTED`. Unknown fields/free-text are
rejected; the output fixes the transition target to `READY`, with no deactivate or caller-selected target status.

This is a pure contract only: it does not check session capability, read current row status, write the profile,
create audit evidence, or authorize activation. Eleven focused command tests plus readiness/schema/capability suites
pass (32/32); typecheck, IP lint (234 files), and `git diff --check` pass. No database, migration, seed, UI, bank data,
commit or push. §25.4 remains the full-system publication gate.


### 26.106 B-089 — Global profile-activation audit schema `IMPLEMENTED — DISPOSABLE DB-ACCEPTED §26.109`

Added `partner_bank_profile_activation_audit` as a global fixed-field table for the approved app activation contract.
It records an event UUIDv4, actor tenant key + user UUID snapshot, country, policy revision, `NOT_READY`→`READY`
transition, previous/new row versions, fixed `PROFILE_VALIDATION_ACCEPTED` evidence, and timestamp. There are no
free-text fields or actor foreign keys that could make tenant/user deletion erase global evidence. Constraints bind
the country to reference data, validate the 2–4-character actor key/revision shapes, require the one-way state transition, and require
`new_version = previous_version + 1`.

Migration `0016_partner_bank_profile_activation_audit.sql` creates the table; `9018` revokes all direct `PUBLIC` and
`cairn_app` privileges. It is global, so it has no tenant RLS. No activation writer, capability-checked action, or
status mutation is implemented yet; a later narrow atomic writer must append the audit event and change the registry
in one transaction. Three focused schema-contract tests plus the profile/readiness/activation suites pass (35/35);
typecheck, IP lint (238 files), and `git diff --check` pass. At B-089 completion no migration had been applied; B-092
later applied and accepted it on a disposable local PostgreSQL cluster (§26.109). No persistent/remote database,
bank data, commit or push. §25.4 remains the full-system publication gate.


### 26.107 B-090 — Private atomic activation database function `IMPLEMENTED — DISPOSABLE DB-ACCEPTED §26.109`

Added `cairn_activate_partner_bank_profile` in migration `9019_partner_bank_profile_activation_function.sql`.
The function validates UUIDv4 event identity, the 2–4-character actor tenant key, uppercase country, current-format
policy revision, positive expected integer version, and the fixed evidence code. It locks the global country row,
requires the expected policy revision and version, refuses an already-READY row, and updates only
`NOT_READY`→`READY`, incrementing the version and setting the registry actor/timestamp. It then inserts the dedicated
global audit event with the locked before-state and new version in the same PostgreSQL function call; an insert failure
aborts the statement and rolls back the readiness update. No target status or free text is accepted.

The SECURITY DEFINER routine uses only schema-qualified tables and `search_path = pg_catalog`. At B-090 completion,
`PUBLIC` and `cairn_app` EXECUTE were explicitly revoked; B-091 later adds the narrow app grant only alongside the
capability-checked, verified-session action, and B-092 accepts the whole path on a disposable cluster (§26.109).
Three static function-contract tests plus readiness/schema/activation suites pass (38/38); typecheck, IP lint (240
files), and `git diff --check` pass. No persistent/remote database, role-capability grants, bank data, commit or push.
§25.4 remains the full-system publication gate.


### 26.108 B-091 — Capability-checked activation service and server action `IMPLEMENTED — DISPOSABLE DB-ACCEPTED §26.109`

Added a server-side activation service and `activatePartnerBankProfileAction`. The service requires the exact
`CFG.FND.PARTNER.BANKPROFILE.ACTIVATE` capability (preserving Administrator `*` matching), validates the strict
command, and derives both actor client and UUID from the verified session. The action reads only country, expected
policy revision and expected version; it supplies fixed `PROFILE_VALIDATION_ACCEPTED` evidence itself. No caller can
choose actor identity, target state, evidence text or another mutation. The service invokes only the atomic database
function inside `withTenant(session.client, ...)`, so the application-role guard and tenant scope are established
before the global operation; success is returned only after the transaction commits.

Migration `9020_partner_bank_profile_activation_function_runtime.sql` grants only EXECUTE on that exact function to
`cairn_app`, while preserving revoked direct UPDATE/INSERT/DELETE privileges on the registry/audit tables. It adds
no `role_capability` grants. Eight service tests and two server-action/grant contract tests, plus the profile/readiness/
activation suites, pass (48/48); typecheck, IP lint (245 files), and `git diff --check` pass. At B-091 completion no
migration/seed had been applied; B-092 later exercised the migrations and activation on a disposable local cluster
(§26.109). At B-091 completion the action was not UI-wired; B-093 later adds the dedicated page (§26.110). No
persistent/remote database, bank save/reveal, bank data, commit or push. Remote DB identity remains unverified; §25.4
remains the full-system publication gate.


### 26.109 B-092 — Disposable PostgreSQL acceptance for audited profile activation `PASSED — CLUSTER REMOVED`

Provisioned a fresh PostgreSQL 17.11 cluster under `/tmp`; it listened only on a private Unix socket with TCP disabled.
The custom lexical migration runner applied all 38 SQL migrations, including `0015`–`0016` and `9017`–`9020`.
`seed:reference` and `seed` completed. The five global profile rows were all `NOT_READY`; the activation capability
was present as non-posting Foundation `CONFIGURE` with no `role_capability` grant. No user, tenant, partner, or bank
record was seeded.

The actual server-side activation service called the atomic function through `cairn_app`/`withTenant` using a
synthetic capability-bearing session: KW changed from `NOT_READY` version 1 to `READY` version 2, and the audit row
matched the session-derived tenant/user, country, D-062 revision, before/after status, versions and fixed evidence.
Two simultaneous GB calls at version 1 produced exactly one activation/audit event; the other returned
`PROFILE_ALREADY_READY`. Direct function checks rejected stale policy revision, stale version, unavailable profile,
invalid evidence and malformed country without changing profile rows.

Privilege checks confirmed `cairn_app` is NOSUPERUSER/NOBYPASSRLS, retains profile SELECT but has no profile UPDATE/
INSERT, and has no direct SELECT/INSERT/UPDATE/DELETE/TRUNCATE on the audit table. It has EXECUTE only on the narrow
activation function; PUBLIC does not. Direct audit read/insert and profile update attempts failed with
`insufficient_privilege`. A deliberate duplicate audit-event fixture caused SQLSTATE `23505`; the function call
rolled back the preceding status update, leaving IN `NOT_READY` version 1. The collision fixture was deleted.
Final disposable counts: zero tenants, partners and bank records; two successful activation audit events (KW and GB).

The run exercised the service with a synthetic `SessionContext`; it did not perform a browser/cookie login flow.
All temporary cluster, downloaded package, test script and logs were removed. No remote, owner, persistent development
or production database was contacted; no persistent profile state, commit or push. B-093 subsequently added the
separate UI route (§26.110); browser acceptance remains pending. Bank-record saves/plaintext reveal remain out of
scope. §25.4 remains the full-system publication gate.


### 26.110 B-093 — Capability-gated global profile activation page `IMPLEMENTED — BROWSER ACCEPTANCE PENDING`

Added `/foundation/partners/bank-profiles` as a separate global configuration page rather than placing country policy
activation inside an individual partner's bank-record view. The page requires a verified session and the exact
`CFG.FND.PARTNER.BANKPROFILE.ACTIVATE` capability; its link is shown from Partners only to that capability. A
read-only server query builds the five-country view model with current/registry policy revision, status and row version.
Missing, stale-revision or invalid rows fail closed and have no activation form. Only a current-revision `NOT_READY`
row gets an action with country, expected policy revision and expected version. The server action still supplies the
fixed evidence code and derives actor from session; the page offers no status override, free-text rationale, bank-row
save or plaintext reveal.

Added readiness/status translations, a view-model resolver, and UI/page-contract tests. The focused profile,
activation, panel and existing bank-display suites pass 59/59; typecheck, IP lint (251 files), and `git diff --check`
pass. No database or seed was run in this batch; B-092 remains the disposable PostgreSQL acceptance. The new route
has not had browser acceptance, and no persistent/remote profile state, bank data, commit or push was touched.
§25.4 remains the full-system publication gate.


### 26.111 B-094 — Cookie-backed browser acceptance for B-093 route and action `PASSED — DISPOSABLE INFRASTRUCTURE REMOVED`

Built the production standalone Next app and exercised it in headless Chromium against a fresh PostgreSQL 17.11 cluster.
The cluster lived under `/tmp`, accepted TCP only on loopback `127.0.0.1:55494` plus a private Unix socket, and hosted only
`cairn_b094`. The run verified its database identity before applying all 38 lexical SQL migrations, `seed:reference`,
and `seed`. The seeded activation capability was non-posting Foundation `CONFIGURE`; all five approved profiles began
`NOT_READY` at version 1. `role_capability` was empty before fixtures. The runtime `cairn_app` role was
`NOSUPERUSER NOBYPASSRLS`, had profile SELECT but no profile mutation, and had no direct activation-audit access.

Created a temporary `T094` tenant, three synthetic users and cookie-backed server sessions only in that database: a
`FND.PARTNER.DISPLAY` viewer, an exact-capability activator, and an `ADMINISTRATOR` role holding `*`. These four
temporary role-capability rows were acceptance fixtures, not seed changes or grants to any persistent role.

Browser checks passed: anonymous access redirected to sign-in; the display-only viewer saw no navigation link, was
denied on direct route access, and was refused by the actual server action when a form rendered for an authorized user
was submitted with the viewer cookie. The denied JP attempt left its profile at `NOT_READY` version 1 and emitted no
activation-audit event. The exact capability exposed all five current policy/revision/status/version rows and their activation controls.
The exact-capability user activated KW and the `ADMINISTRATOR` `*` user activated GB, each through the browser UI from
`NOT_READY` v1 to `READY` v2; each completed row lost its action, with no reverse control. Forged extra form values for
actor, evidence, target status and rationale did not affect the result. Exactly two activation-audit rows recorded the session-derived
`T094` actors, D-062/KW and D-064/GB, `NOT_READY`→`READY`, versions 1→2, and fixed evidence
`PROFILE_VALIDATION_ACCEPTED`. IN, JP and US remained `NOT_READY` v1. No browser page errors; zero partner or bank rows;
no Save/reveal path was exposed.

The production build and browser acceptance passed. The app and PostgreSQL processes were stopped; the disposable
cluster/database, downloaded PostgreSQL package, browser binaries/dependencies, fixture tokens/script and `.next` build
were removed, and ports 3000/55494 were closed. No remote, owner, persistent development or production database was
contacted; no bank identifiers, persistent profile change, commit or push. Bank-record saves and plaintext reveal remain
out of scope. §25.4 remains the full-system publication gate.


### 26.112 B-095 — Fail-closed browser acceptance for stale and missing profile rows `PASSED — DISPOSABLE INFRASTRUCTURE REMOVED`

Built the production standalone Next app and exercised it in headless Chromium against a freshly initialized PostgreSQL
17.11 cluster under `/tmp`. The cluster listened only on loopback `127.0.0.1:55495` plus a private Unix socket and hosted
only `cairn_b095`; before migrations, the run verified database name, loopback address, port, server version, primary
status and zero public tables. Applied all 38 lexical SQL migrations, `seed:reference` and `seed`. All five approved
profiles began at their current D-062–D-066 policy revisions, `NOT_READY`, version 1; `role_capability` was empty. The
runtime `cairn_app` role was `NOSUPERUSER NOBYPASSRLS`, had profile SELECT but no UPDATE, and had no activation-audit
SELECT access.

Created only disposable local tenant `T095` and a synthetic user/role with the exact
`CFG.FND.PARTNER.BANKPROFILE.ACTIVATE` capability. This one role grant was an acceptance fixture, not a seed or
persistent grant. The fixture made KW stale (`D-061` vs current `D-062`) and removed the JP registry row; IN, GB and US
remained current `NOT_READY` version 1.

Chromium verified an anonymous route request redirected to sign-in, then signed in through the real cookie-backed UI.
The page rendered the closed five-country view: stale KW displayed `Policy revision mismatch` and missing JP displayed
`Registry row missing`; neither row had a form or button. Current IN/GB/US rows each retained exactly one activation
form with the current expected policy revision and version 1. Three activation controls appeared in total. No
activation was submitted; no Save or Reveal control, browser page error or console error was observed.

Post-run verification found four registry rows (KW stale; JP absent; IN/GB/US still `NOT_READY` version 1), zero
activation-audit rows, zero partners and zero bank rows. The app and database were stopped; the cluster, extracted
PostgreSQL package/client, browser binaries and system dependencies, temporary fixture scripts, `.next` build,
`node_modules`, and transient Playwright caches were removed. No remote, owner, persistent development or production DB,
real bank identifiers, activation, commit or push was involved. Bank-record saves and plaintext reveal remain out of
scope; §25.4 remains the full-system publication gate.


### 26.113 B-096 — Owner-directed publication of the complete B-080–B-095 partner-bank batch `PUBLISHED — FAST-FORWARD`

The owner explicitly directed a full commit and push of the complete pending partner-bank batch. All 45 staged paths
were committed as `3035c9b` (`feat: add partner bank profile readiness and activation`) with the repository identity
`deepakpt2`, then fast-forward pushed from `057e19c` to `deepakpt2/cairn-erp:main`. The remote branch and local `main`
were verified at the new commit; the worktree is clean. No force push was used.

For authentication, the PAT was read from ignored `.env.local` and supplied only through a temporary askpass helper.
The token was not staged, committed, written into the remote URL/config, or emitted in logs; `.env.local` remains
untracked/ignored and is not in the commit. This publication was expressly owner-directed and applies only to the
complete pending B-080–B-095 batch; §25.4 remains the gate for future publication. No database was contacted or
changed during publication; no real bank values were included.


### 26.114 B-097 — Owner-reported B-023/B-024 walkthrough outcome `COMPLETE — OWNER REPORTED PASS`

On 2026-10-12, the owner confirmed that both the B-023 Customer company and B-024 Customer Sales area
walkthroughs were complete and selected “All checks passed.” This is an owner-reported result. No
per-step notes, screenshots, or test-environment details were supplied, and the agent did not
independently re-run the walkthroughs or access the application, host, or database for verification.

The report closes only the B-023/B-024 owner-walkthrough outcomes; it is not an overall M1 sign-off,
production approval, or deployment instruction. The walkthrough procedures remain in §§26.33, 26.35
and 26.37. This documentation-only update made no application or database changes.


### 26.115 B-098 — Supplier company-code Payment Methods storage only `SCHEMA ADDED · MIGRATION NOT APPLIED`

Added nullable `payment_methods varchar(40)` to the existing tenant/company-code-scoped
`supplier_company_code` segment and registered it in the typed Drizzle schema. Additive migration
`0017_supplier_company_payment_methods.sql` adds only that column; the existing tenant RLS policy
continues to protect the table, so no separate policy migration was introduced. Added a static schema
contract covering the nullable column, composite company key, and non-destructive migration.

This is storage only. It adds no Supplier write-path behavior, country/direction lookup, validation
against active `OUTGOING`/`BOTH` Payment Methods, server action, UI control, seed row, or payment
execution. The Supplier field remains disabled. No database migration was applied, and no persistent,
remote, owner, or production database was accessed or changed.

**Verification:** the no-database schema-contract test is registered in the browser-harness configuration;
`npm run test:browser-harness` passed **68/68 across 6 files**, including both new contract checks.
`npm run typecheck`, `npm run lint:ip` (253 files), and `git diff --check` passed. The normal Vitest
configuration invokes database global setup and failed before collection with
`ECONNREFUSED 127.0.0.1:5432`; the connection was refused and no database was reached or modified.

**Follow-up:** B-099 canonicalizes and validates explicitly submitted codes against active
`OUTGOING`/`BOTH` definitions for the company-code country (§26.116). B-100 wires the session-derived
protected action and eligible choices (§26.117). The UI remains disabled pending its separate implementation
and browser acceptance. Any database acceptance must apply migration 0017 only to a verified disposable
database. Payment execution, bank-record saves and plaintext reveal remain outside this slice.


### 26.116 B-099 — Supplier Payment Methods save-service validation only `IMPLEMENTED · DATABASE ACCEPTANCE NOT RUN`

Extended `saveSupplierCompany` with optional `paymentMethods` input. Supplied code sets are trimmed,
uppercased, deduplicated, sorted, limited to ten unique one-or-two-character alphanumeric codes, and
validated in the same tenant transaction against the assigned company code's country. Each selected
method must exist for that tenant/country and be active with `OUTGOING` or `BOTH` direction. The lookup
locks matching definition rows `FOR SHARE`, so concurrent direction/active-state maintenance cannot
invalidate the check before the Supplier save commits. Unknown, inactive, wrong-country, and
`INCOMING`-only choices fail with a generic validation error.

An omitted field preserves existing data for legacy callers; an explicit blank clears the set. The value
participates in normal no-op/version handling and is recorded as security-relevant history. It does not
affect company-segment completeness or enable a payment transaction. The protected action and Supplier
UI are unchanged, so the field remains disabled and this service path is not yet user-reachable.

Added pure normalization/eligibility tests and DB-backed service cases for outgoing/BOTH acceptance,
canonicalization, country/direction/activity denials, explicit clear, omitted-field preservation, history,
no-op and completeness independence. The database cases were not run because no verified disposable
PostgreSQL test database was available; no migration or seed was applied and no database was accessed.

**Verification:** `npm run test:browser-harness` passed **74/74 across 7 files**; `npm run typecheck`,
`npm run lint:ip` (254 files), and `git diff --check` passed.

**Follow-up:** B-100 adds the session-derived protected action and active country/outgoing choices
(§26.117). The editable selector and browser acceptance remain separate work. No payment execution,
bank-record save, plaintext reveal, remote DB access, commit, or push occurred in this batch.


### 26.117 B-100 — Protected Supplier Payment Methods action and eligible choices only `WIRED · UI PENDING`

The existing `FIN.SUPPLIER.COMPANY.MAINTAIN` action now conditionally forwards `paymentMethods` only
when the form includes that field. Tenant and actor continue to come exclusively from the verified session;
legacy forms that omit the field preserve the stored assignment, while an explicit blank remains a clear.
No new capability or action route was introduced. The Supplier form still has no Payment Methods
control, so the field is not yet user-accessible.

`supplierCompanyChoices` now returns active Payment Methods for the selected company code's country,
scoped by tenant and filtered to `OUTGOING` or `BOTH`. It does not include inactive, incoming-only, or
other-country methods. The existing company, account, and payment-term choice queries also carry explicit
tenant predicates.

Added a database-free action/choice source-contract test and a DB-backed choice-service case. The DB case
was not run because no verified disposable PostgreSQL environment was available; migration 0017 was not
applied and no database was accessed.

**Verification:** `npm run test:browser-harness` passed **76/76 across 8 files**; `npm run typecheck`,
`npm run lint:ip` (255 files), and `git diff --check` passed.

**Next:** render the eligible methods in a capability-gated Supplier company-code selector, while preserving
authorised display-only values and existing omitted-field behavior. Keep the UI/browser acceptance and any
disposable migration test as separate bounded work; do not add payment execution. No bank-record save,
plaintext reveal, remote DB access, commit, or push occurred.


### 26.118 B-101 — capability-gated Supplier Payment Methods selector `IMPLEMENTED · LIVE BROWSER ACCEPTANCE SEPARATE`

Wired `supplierCompanyChoices.paymentMethods` and the stored company-code value into the existing
Supplier company panel. The Payment Methods checkbox editor appears only for users with the existing
`FIN.SUPPLIER.COMPANY.MAINTAIN` capability; authorized display-only users continue to see the saved code
set without controls. No new capability was added. Choices remain constrained by B-100 to active,
same-tenant, same-country `OUTGOING`/`BOTH` methods.

The editor supports at most ten selected codes, preserves saved selections that are still eligible, and
shows previously saved but now-ineligible codes as checked items that must be unchecked before a save can
succeed. A hidden comma-delimited field is submitted even when empty, so clearing every selection remains
an explicit clear; legacy callers omitting the field still preserve the stored value through B-100. The
Dunning procedure, Cash discount, and Tolerance group placeholders remain disabled pending their masters.
This is a supplier default only; it does not execute payments.

Added English help/status strings and a no-database UI source-contract test. **Verification:**
`npm run test:browser-harness` passed **78/78 across 9 files**; `npm run typecheck`, `npm run lint:ip`
(256 files), and `git diff --check` passed. DB-backed Supplier tests were not run. Migration 0017 remains
unapplied; no database was accessed. Live browser acceptance was not run and remains a separate batch.
No commit or push occurred.

**Next:** run live browser acceptance separately and, only against a verified disposable database, test
migration/service acceptance. Keep payment execution, bank-record saves and plaintext reveal outside scope.


### 26.119 B-102 — Supplier Payment Methods browser acceptance target preparation `TARGET UPDATED · LIVE RUN BLOCKED`

Updated the `supplier-company` Playwright target for the B-101 selector. It now expects only the three
remaining company defaults to be disabled; verifies the initially empty explicit field; creates synthetic
KW and US definitions through the Payment Methods UI; confirms same-country active `OUTGOING`/`BOTH`
filtering, the ten-selection cap and reload persistence; and exercises authorized display-only access,
retirement/stale-choice removal and explicit clear. Added a database-free browser-target source-contract
test. No new database fixtures were created during this preparation.

**Verification:** `npm run test:browser-harness` passed **81/81 across 10 files**; `npm run typecheck`,
`npm run lint:ip` (257 files), and `git diff --check` passed. The live target was not run: no database URL
or local PostgreSQL service/tools were available, and migration 0017 remains unapplied. A fresh disposable,
migrated database is required. No database was accessed or modified. No commit or push.

**Next:** perform migration/service acceptance on a verified disposable database in a separate batch; then
run this live browser target against a fresh disposable, migrated test database. Do not use an owner,
production or unidentified remote database.


### 26.120 B-103 — Supplier Payment Methods migration and service acceptance `PASSED · DISPOSABLE LOCAL ONLY`

With owner authorization, installed PostgreSQL 17.11 and created a fresh disposable `cairn_test` cluster
bound only to `127.0.0.1`. Before applying any migration or seed, verified over TCP that the target was
`cairn_test` on loopback, PostgreSQL 17.11, as the disposable-cluster `postgres` migration superuser.
The app connection was separately verified as `cairn_app` with `NOSUPERUSER` and `NOBYPASSRLS`.

Applied all **39** lexical SQL migrations, including `0017_supplier_company_payment_methods.sql`, then
ran the global-definition and shared-reference seeds. The DB-backed `tests/supplier-companies.test.ts`
suite passed **25/25**, covering persisted outgoing/BOTH choices, tenant/country/direction validation,
explicit clear, omitted-field preservation, history/version handling and completeness independence.

After testing, verified 39 migration records and the 0017 record, with **zero tenants, partners, Supplier
company-code rows, Payment Method rows or partner-bank rows**. Stopped and removed the disposable cluster,
its temporary data and the PostgreSQL packages installed for this batch. No owner/production/remote
connection was used. The live browser target was not run; it remains a separate batch. No commit or push.


### 26.121 B-104 — Supplier Payment Methods live-browser acceptance `PASSED · DISPOSABLE LOCAL ONLY`

Used the freshly provisioned `cairn_test` PostgreSQL 17.11 cluster bound only to `127.0.0.1:55432`.
Its local identity was verified before the B-104 setup applied the existing 39 migrations and two shared
seeds. This was browser-only acceptance: B-104 did not rerun migrations/seeds or the Supplier service suite
from B-103. No owner, production or remote database was accessed.

Built the optimized Next standalone app and ran only `npm run smoke:browser:supplier-company` in headless
Playwright Chromium v1248. The single target passed with no browser runtime errors. The run covered the
empty/no-choice state and disabled pending defaults; same-country active `OUTGOING`/`BOTH` filtering;
exclusion of incoming-only and other-country methods; ten selectable methods with the eleventh disabled;
save/reload persistence; non-finance denial and authorized display-only access without controls; retiring
saved `B1`, removing the stale choice, and explicitly clearing the remaining selection. Synthetic payment
method definitions were created through the audited Payment Methods service as isolated fixtures so the
browser target remained focused on Supplier company selection; the `B1` retirement and Supplier edits were
performed through the UI. The fixture setup is not a substitute for the separate Payment Methods UI target.

The smoke runner removed its `T991` fixture. Verified zero tenants, partners, Supplier company-code rows,
Payment Method rows and partner-bank rows after the run. Stopped the app and removed the disposable cluster,
temporary database data/logs, PostgreSQL packages installed for this batch and the Playwright Chromium
binary cache. Apt autoremove also removed 29 newly installed Chromium runtime packages that were no longer
needed; shared system dependencies were retained. `npm run build` passed; final browser-harness, typecheck,
IP lint and diff-check results are recorded in the v1.19 change log. No commit or push.


### 26.122 B-105 — Company Code define capability registration only `CAPABILITY READY · ACTION/UI PENDING`

Started the Enterprise Structure roadmap at SCR-012 by registering `CFG.ORG.COMPANYCODE.DEFINE` in the
global capability catalogue as module `FND`, action `CONFIGURE`, and non-posting. A database-free contract
test checks the seed entry, confirms this batch adds no tenant-role grants, and preserves exact-capability
and Administrator `*` behavior.

This is only capability registration: it is not yet wired to the Company Code route, a server action, or a
form, and it grants no default role. No schema or migration changed; no seed was executed and no database
was accessed. Typecheck, browser harness, IP lint and diff-check results are recorded in the v1.20 change
log. No remote database, commit or push.

**Next:** add the protected Company Code define path in a separate bounded batch, keeping the define/assign
order in §6.2 and the current Company Code assignment-field constraints explicit.


## §27 · Open items `RESOLVED v0.2`

All ten items below were resolved by the product owner on 2026-10-08. Kept here (never deleted) with
their resolutions so the reasoning is traceable. **No items are currently open.**

| # | Item | Resolution | Ref |
|---|---|---|---|
| 1 | UI density vs airiness | **Compact by default**, with a comfortable mode. Product owner added a constraint: keep the density but **avoid visual imitation** — so grids stay dense in our own visual language, governed by the checklist in §19.5 | D-034 |
| 2 | Intercompany automation depth | **Automatic cross-company posting in M1**, with mirror documents, IC reconciliation accounts and elimination at consolidation (§14.7) | D-028 |
| 3 | Credit management | **Yes, with standard blocking behaviour** — order and delivery block on limit breach, controlled release with reason (§14.8) | D-029 |
| 4 | Returns flow | **Phase 3**, as recommended — not in the first O2C delivery | §25.3 |
| 5 | Mail server | **Product owner supplies SMTP data through the UI**; credentials encrypted at rest; screen `CFG.PLT.MAIL.DEFINE` (§22.8) | D-033 |
| 6 | Number display format | **Our own readable format** (`POF-2026-000123`), with an optional classic zero-padded display for users who prefer it | D-030 |
| 7 | Tenant creation | **Product owner creates their own tenant manually** through the UI, page by page during testing. **Agent creates the development tenant from the start** for build and test | D-006 |
| 8 | Backup retention and PITR | **14 daily / 8 weekly / 12 monthly**, WAL archiving on for point-in-time recovery, weekly verified restore (§22.6) | D-031 |
| 9 | Approval notifications | **Inbox always; email optional per user.** No workflow step may depend on email delivery (§17) | D-032 |
| 10 | Visual identity package | **Placeholder logo and neutral assets for now**; real identity package later. No code depends on the artwork (§19.2) | §19.2 |

### 27.1 Items expected to arise during the build

Recorded here as a standing reminder that the page cycle (§24.1) will surface new questions. Each
becomes a numbered item when raised, and is resolved rather than left to drift.

| Watch item | Raised by | Expected |
|---|---|---|
| Field-level details of each screen as it is gathered | Walkthroughs | Continuously through M1b–M1e |
| Intercompany transfer pricing markup percentage and account setup | Accountant user | Before M1e testing |
| Consolidation presentation format (management vs statutory layout) | Product owner | Before SCR-061 |
| Whether credit limits should be per credit control area or per sales area in practice | Product owner | During SCR-059 walkthrough |
| Print/PDF layout approval for each business document | Product owner | During §17 output work |

---

## §28 · Risk register `OPEN`

| ID | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| RK-01 | **Production order costing** is the hardest part of M1 — cost flow, rates, variance, settlement | M1 delay | High | Build last within M1d, isolate behind the costing engine, use the worked example in §13.2 as the acceptance case, and start with a single material |
| RK-02 | **MRP** is a large subsystem added late to scope | M1 delay | High | Implement after the manual-order path works; keep the online single-item run first, plant-wide run second |
| RK-03 | Scope breadth across nine modules | Sustained effort | Certain | Strict tiering (D-010), incremental phases, page-by-page cycle so value lands continuously |
| RK-04 | **Numbering under concurrency** producing duplicates or gaps | Data integrity, audit failure | Medium | Advisory locks + gap-free allocation, tested under concurrent load before M1c |
| RK-05 | Financial reporting performance at volume | Unusable reports | Medium | Balances table with drill-through rather than summing all lines; index strategy designed in Phase 0; performance tests in §24.3 |
| RK-06 | **i18n retrofit** if the locale layer is skipped under time pressure | Rework across every screen | Medium | Enforce no-hardcoded-strings lint rule from the first commit (R-19) |
| RK-07 | Container stack validated only at the end | Deployment surprises | Medium | Author compose early; product owner validates the stack on the host during M1a, not at the end |
| RK-08 | Divergence drift — quietly becoming "not SAP-like" | Fails R-02 intent | Medium | Divergence Register reviewed at every walkthrough (§3.3) |
| RK-09 | Single small development environment (2 vCPU, modest memory) slowing builds and tests | Slower cycles | High | Keep dependencies lean, avoid heavy build tooling, run targeted tests rather than the full suite each change |
| RK-10 | Docker unavailable in the agent sandbox | Cannot self-verify deployment | Certain | Native development here; container validation by the product owner (D-025) |
| RK-11 | Legal or trademark exposure on the product name or on reference aliases | Renaming, legal cost | Low | Own naming throughout; aliases used factually as search metadata only; trademark search recommended before branding spend |
| RK-12 | Statutory payroll expectation creeping back into scope | Legal exposure if built wrong | Low | Hard exclusion documented (R-11, DV-001) and surfaced in the product |
| RK-13 | Tenant isolation defect | Cross-tenant data exposure | Low | Row-level security plus a dedicated isolation test suite (§24.3), run every build |

---

## §29 · Glossary & alias examples `DRAFT`

Reference identifiers appear here and in the registry **only as search metadata** (R-01). They are a
courtesy to experienced users, never part of the product's own naming.

### 29.1 Core concepts

| Our term | Meaning | Reference alias |
|---|---|---|
| Client | Tenant; complete data and configuration partition | Mandant / client |
| Company code | Legal entity that keeps its own books | Buchungskreis / company code |
| Controlling area | Cost accounting boundary, may span company codes | Kostenrechnungskreis |
| Plant | Production or storage site belonging to one company code | Werk |
| Storage location | Stock area within a plant | Lagerort |
| Purchasing organisation | Entity that negotiates and issues purchase orders | Einkaufsorganisation |
| Sales organisation | Entity legally responsible for sales | Verkaufsorganisation |
| Document principle | No data change without a document | Belegprinzip |
| Document flow | The graph linking predecessor and successor documents | Belegfluss |
| Number range | Server-allocated, gap-free document numbering | Nummernkreis |
| Release strategy | Configurable multi-level approval by value and criteria | Freigabestrategie |
| Account determination | Configuration mapping business events to GL accounts | Kontenfindung |
| Condition technique | Rule-based pricing and output determination | Konditionstechnik |
| Movement type | Classifies a goods movement and drives its accounting | Bewegungsart |
| Good receipt / invoice receipt clearing | Interim account bridging goods receipt and invoice | Wareneingang/Rechnungsprüfung |
| Activity type | Measure of cost centre output, priced by a rate | Leistungsart |
| Bill of material | Structured component list for a product | Stückliste |
| Routing | Ordered operations with times and work centres | Arbeitsplan |
| Work centre | Resource where operations are performed, linked to a cost centre | Arbeitsplatz |
| Planned order | MRP proposal not yet converted to a real order | Planauftrag |
| Cost collector | Object that gathers costs before settlement | Kostensammler |
| Variance | Difference between actual and target cost | Abweichung |
| Settlement | Transfer of collected costs to receivers | Abrechnung |
| Subledger | Vendor and customer open item accounting | Nebenbuch |
| Tie-out | Reconciliation proving two views agree | Abstimmung |
| Universal journal | Single line-item table carrying all account assignments | ACDOCA concept |
| Evidence pack | Exported audit bundle with hash manifest | — |

### 29.2 Registry examples (searchable aliases)

| Search input | Lands on | Coverage |
|---|---|---|
| `ME21N` | `PROC.PO.CREATE` | Tier 1 built |
| `MIGO` | `INV.GR.POST` | Tier 1 built |
| `MIRO` | `PROC.INV.RECORD` | Tier 1 built |
| `MD04` | `PROD.MRP.STOCKREQ` | Tier 1 built |
| `CO01` | `PROD.ORDER.CREATE` | Tier 1 built |
| `VA01` | `SALES.ORDER.CREATE` | Tier 1 built |
| `VF01` | `SALES.BILLING.CREATE` | Tier 1 built |
| `FB50` | `FIN.JOURNAL.POST` | Tier 1 built |
| `F110` | `FIN.AP.PAYMENTRUN.EXECUTE` | Tier 1 built |
| `FS00` | `CFG.FIN.GLACCOUNT.CREATE` | Tier 2 configured |
| `OBYC` | `CFG.FIN.ACCTDET.DEFINE` | Tier 2 configured |
| `BSEG` | `journal_entry_line` (data model) | Reference |
| `MARA` | `material` (data model) | Reference |
| `VBAK` | `sales_order` (data model) | Reference |
| `MD61` | Long-term planning / forecast | Tier 3 mapped, not built |
| `CK40N` | Mass costing run | Tier 3 mapped, not built |
| `LTMC` | `FND.IMPORT.SESSION` | Tier 1 built |

---

## §30 · Change log `LIVE`

| Version | Date | Change | By |
|---|---|---|---|
| 0.1 | 2026-10-08 | Document created. Requirements register (R-01…R-21), decision register (D-001…D-027), conformance model and Divergence Register (DV-001…DV-014), naming and IP boundary, engine architecture, organisational model and multi-tenancy, Configuration Workbench and standard configuration package, full data model, master data model, module scope and transaction inventory (~300 Tier 1, ~90 Tier 2), golden flows with accounting entries, MRP design, production order costing, finance detail, People subset, audit workspace, output production, import pipeline, UI/UX system, repository architecture, worker and jobs, Docker deployment, security, testing and page-cycle protocol, phase plan and M1 acceptance criteria, Phase 1 screen inventory (57 screens), open items, risks, glossary. | Agent |
| 0.2 | 2026-10-08 | **All §27 open items resolved by the product owner.** New decisions D-028…D-034. Added: §14.7 Intercompany (automatic mirror posting, IC reconciliation accounts, elimination; in M1), §14.8 Credit management (blocking behaviour, exposure calculation, controlled release; in M1), §19.5 binding Anti-imitation checklist with automated trademark lint, credit control area added to the organisational model (§6.1), mail server configured through the UI with encrypted credentials (§22.8), notification policy — inbox always, email optional, no email-dependent workflow (§17), concrete backup policy with WAL archiving and weekly verified restore (§22.6), number display format decided (§4 grammar, D-030), §17 output list extended with consolidated statements, six new finance transaction codes, M1e scope extended with intercompany and credit, acceptance criteria 16–18 added, screens SCR-058…SCR-063 added (Phase 1 inventory now 63 screens). §25.1 M1e redefined. §27 converted from OPEN to RESOLVED with a forward-looking watch list. | Agent |
| 0.3 | 2026-10-08 | **M1a substrate built and tested.** New decisions D-035…D-040, all arising from the build itself. Delivered: PostgreSQL 17 schema (33 tables, 25 under row-level security with FORCE), `cairn_app`/`cairn` role split (D-040), migration runner with immutable checksums and the `9000+` hand-written convention (D-039), engines E3 numbering (gap-free, proven under 40-way concurrency and rollback), E4 locking (advisory locks, ordered acquisition, contention log), E5 document flow and index, E6 posting with exact decimal money (D-035) and a database-enforced balance invariant, E14 change documents, term registry (§4.4) with working command-bar resolution, Configuration Workbench rendering the 51-step define/assign chain with prerequisite gating, tenant onboarding creating client, settings, 10 roles, 13 number ranges and the workbench checklist in one transaction. **22 automated tests passing** across numbering, posting and tenant isolation. Next.js app builds and serves; development tenant 0100 created through the same service the UI uses. Four defects found and fixed during the build: duplicate primary keys, a missing module registration in the schema root, an unscoped workbench query that RLS correctly default-denied, and a wrong foreign key on `role_capability` (D-037). | Agent |
| 0.4 | 2026-10-08 | **M1b foundation screens built, and the first real defect found through them.** Delivered: posting period maintenance with a visual period grid per account type (`CFG.PLT.PERIODRULE.DEFINE`, backed by the period engine E7), G/L account master list (`FIN.GL.MASTER.LIST`, grouped by account class with search), plant and storage location maintenance (`CFG.ORG.PLANT.DEFINE`), journal entry list with document detail and a posting form that derives the fiscal year and period from the posting date. Configuration Workbench now links only to screens that exist and marks the rest "Screen pending" — no link in the product produces a 404. Registry extended to 13 terms and 12 aliases (`FIN.JOURNAL.POST`, `CFG.PLT.NUMBERRANGE.DEFINE`). **33 automated tests passing**, plus two end-to-end suites: `npm run smoke` (every page, rendered content, cross-tenant isolation through the web layer) and `npm run smoke:posting` (post a balanced document, read it back through the list and detail views, refuse an unbalanced one with the difference stated, refuse a closed period with the period and open range named, confirm the configuration change is recorded with field-level before/after detail and flagged security-relevant). Four defects found and fixed: **(1)** number ranges were only ever resolved for an exactly matching fiscal year, so a tenant with year-independent ranges could not post at all — resolved as D-042; **(2)** tenant deletion left orphans in 43 of 44 tenant-scoped tables — resolved as D-041; **(3)** test cleanup ran unscoped, so row-level security silently deleted nothing and stale test state leaked into later runs, surfacing as an unrelated numbering failure — cleanup is now scoped and fails loudly if it removes nothing; **(4)** the displayed document number carried no year when it came from a year-independent range. | Agent |
| 0.5 | 2026-10-08 | **Authentication, sessions, and the trademark lint — the layer every later screen now sits on.** Built: the logon screen (tenant, user, password, plain form, no client-side JavaScript required to sign in), `src/platform/auth/session.ts` (sign-in, lockout after five failed attempts, server-side sessions, sliding renewal, revocation, capability resolution through roles), `src/platform/auth/current.ts` (`getSession` / `requireSession` / `requireCapability`), and route handlers for sign-in and sign-out. Every protected page now takes its tenant from the session; `?client=` is ignored and the workbench tenant switcher is gone. A new `npm run lint:ip` walks the source tree and fails the build if a reference vendor's trademark appears anywhere a user could read it — the Term Registry is the only exemption, and it is exempted by content rather than by a path guess, so moving the registry cannot silently widen the exemption. It found one real occurrence (a comment in the test helpers) which was reworded. **Two defects found by the new tests and both fixed in the code rather than in the assertion:** (1) the first capability matcher granted any authority that *began with* a held pattern, so `PROC.PO.CREATE` would have granted `PROC.PO.CREATE.APPROVE` — now matched segment by segment with the held pattern required to account for the whole required path and no more; (2) sign-in threw inside the tenant transaction, so a rolled-back transaction discarded the failed-attempt counter and the audit row together — a lockout that never happened and an access log that recorded nothing, while the caller still saw the correct error. `signIn` now commits the attempt and raises the exception afterwards. Also fixed: redirects were absolute and pointed at `0.0.0.0:3000`, which would have sent users to a host that does not resolve behind the reverse proxy; they are now relative. **52 automated tests passing** (19 of them new), both smoke suites green and both rewritten to sign in through the real logon screen — so if signing in breaks, they fail. | Agent |
| 0.6 | 2026-10-09 | **Number range maintenance and real-browser acceptance.** D-045–D-048: capability-gated write actions with session-derived tenant/actor; company-scoped accounting ranges; configured type assignment to shared GENERAL; stable company/year/value journal keys separate from display; authoritative blocked/exhausted year-specific controls; safe interval maintenance with locking, immutable starts/formats, reserved blocked numbers and allocation drill-through. Fixed D-043 implementation drift: onboarding was still creating FI ranges although the standard package did not; customer tenants now require the visible maintenance step, while only the development fixture configures it automatically through the same service. Real Chromium walkthrough caught the administrator wildcard seed and an interior wildcard matcher defect; both repaired, including existing standard roles. Fixed misleading onboarding checklist state for tenant/roles/user, the unrestricted runtime database fallback, and migration-role silent RLS no-ops with privilege preflight checks. Production build and browser flow pass; **85 automated tests passing**, both HTTP smoke suites and trademark lint clean. Dev-server/Chromium memory stalls resolved by using a short production build and a lightweight production preview; R-22 records the short verified batch instruction. Header no longer claims the accepted baseline is awaiting red-line. §26.7 contains the page contract, verification, limitations and reproducible sandbox procedure; owner sign-off remains pending. | Agent |
| 0.7 | 2026-10-09 | **Preservation checkpoint and owner-requested 15-minute batch cap.** Records the interrupted material-master slice without claiming its UI release is complete: eight tenant tables/policies, four view services/forms, staged statuses, exact quantities/prices, versioned edits, operational gating, separate financial price authorities, development sample masters and extended tests. Last completed checks: TypeScript/IP lint clean and **110 automated tests passing**; material browser acceptance and production build/release remain pending. The prior number-range preview is left running. Saved a full readable PostgreSQL dump and a source archive with checksums under `checkpoints/2026-10-09_0127_UTC`; no database mutation, reset, reseed or deletion in this checkpoint. D-049 documents retained material semantics; D-050 and revised R-22 enforce one small batch, ≤10 minutes implementation plus verification/checkpoint time within 15 minutes total. §25.4 replaces broad execution runs with named test/view/backend slices; §26.8 records the exact retained state, backup and safe restore procedure. | Agent |
| 0.8 | 2026-10-09 | **B-001 complete within the 15-minute batch budget.** Split the monolithic browser acceptance into five independently runnable targets, with foundation-only default, fresh per-target guarded fixtures, pure argument/ownership validation, 120-second work deadline and bounded diagnostics/cleanup. Material cases no longer require other plant views first. Added explicit npm commands and a pure Vitest harness configuration with no database setup/purge. TypeScript/IP lint clean, **23 focused harness tests passing**, and the existing foundation browser flow passes in about 4 seconds; only its own temporary fixture was touched and preserved database counts match before/after. Saved a new database/source checkpoint without replacing B-000. No ERP feature, page, schema, migration or seed change; material targets still unexecuted pending B-002 publication. §25.4 queue updated and §26.9 records commands, boundaries and verification. | Agent |
| 0.9 | 2026-10-09 | **B-002 complete: Material Basic Data published and browser-verified within the 15-minute cap.** Rebuilt/restarted the production preview to publish retained material pages and session/launchpad changes. Expanded only the Basic target to test incomplete save, completion, unchanged resave, exact weight maintenance, actor/tenant forgery refusal, visible history/footer, search and basic-only copy. Found and fixed FND-001: action reset restored stale uncontrolled select defaults and could remove the saved unit; inner form now remounts from the committed view version. FND-002/FND-003 fix description metadata collision and SPA navigation synchronisation in the test, without arbitrary waits. Corrected production build, TypeScript/IP lint, **133 automated tests** and Basic-only browser acceptance pass. Preserved database counts match before/after, no reset/reseed/migration, fresh backup and review image saved. Other material view walkthroughs remain pending; B-003 Purchasing is next. §26.10 contains the verified contract, findings, live process/build identity and limitations; owner sign-off remains pending. | Agent |
| 0.10 | 2026-10-09 | **Owner-requested GitHub source publication checkpoint.** D-051 records the public repository/branch and source-only boundary. Repaired local Git metadata, fetched existing `main` history and retained the repository GPL v3 license unchanged. Added private-artifact/credential exclusions and a safe development environment template. No ERP feature, database reset, migration or reseed; B-003 Purchasing remains next. Normal fast-forward source push verified; §26.11 records the source commit and confirmation. No token or private artifacts are committed. | Agent |
| 0.11 | 2026-10-10 | **Owner-approved private local Git configuration.** D-052 supersedes the memory-only part of D-051: repository URL and supplied token saved in ignored/untracked `.env.local`, owner-only 0600, with server-only variable names. Credential values are absent from this log, committed source and environment examples; no push, token rotation, application/database change or reset. §26.12 records checks and the private-file boundary. B-003 Purchasing remains next. | Agent |
| 0.12 | 2026-10-10 | **Core Docker deployment files added after the owner found them missing.** D-053 ships app/db/migrate only; worker, pooling/cache and scheduled backups remain separate pending slices. Added multi-stage non-root standalone Dockerfile, build-secret exclusions, Compose with existing Traefik proxy/web/no-certresolver, safe secret template and restricted database-role initialization without resets. Standalone/tracing-root settings correct artifact location. Compose configuration, YAML/security/shell checks, secret-free standalone build, sign-in HTTP smoke, 23 focused tests and IP lint pass; no Docker engine exists here, so full image/container/database/Traefik deployment is explicitly unverified. No current database or private-credential upload. §22 implementation status and §26.13 contain scope, setup, checks and limitations. Normal source push and remote ref verified; deployment commit recorded in §26.13. | Agent |
| 0.13 | 2026-10-10 | **Docker database authentication repair after owner-reported 28P01.** D-054 adds a managed runtime credential synchronization/verification step before migrations and an explicit existing-volume local-admin recovery script. Enforces restricted app role, safe server-side password formatting, explicit owner/runtime URLs and no business-table changes. Legacy applied migration 9000 remains unchanged; its missing-role development fallback can no longer override fresh managed deployment credentials. Added 12 credential tests to pure harness; 35 focused tests, TypeScript/IP lint, shell syntax and standalone build pass. Actual host repair is not claimed; owner commands, env-file consistency, volume preservation and restart behavior are documented in §26.14. No database reset/data edits or secret publication. Normal source push verified; fix commit recorded in §26.14. Owner-host repair remains unverified. | Agent |
| 0.14 | 2026-10-10 | **Default `.env` Docker Compose deployment after owner clarification.** D-055 standardizes the production template and runbooks on automatically loaded `.env`, preserving the local development template separately and legacy Docker template compatibility. No repeated env-file flags or whole-file environment injection; existing real secret values are untouched/ignored. Plain Compose config validated in an isolated dummy project with matching DB/app/migrate credentials; shell/whitespace checks pass. In-place credential repair and fresh-log commands now use plain Compose. Actual host authentication remains pending owner execution; no database reset/edit or feature changes. §26.15 records the filename-versus-stored-password distinction, checks and preservation boundary. Normal source push verified; default-env commit recorded in §26.15. Host repair remains unverified. | Agent |
| 0.15 | 2026-10-10 | **Read-only split-connection diagnosis after fresh migration/app logs.** Migration verifies app-role login and seeds succeed while app still gets 28P01, so further password resets are stopped. Added a safe Docker inspection/DNS/optional login diagnostic plus five passing pure redaction tests. No secrets/connection strings printed, no database or deployment changes, no root-cause claim without host output. §26.16 records evidence, commands, possible shared-network `db` collision and interpretation. Host diagnosis/resolution remains pending; normal source push verified and diagnostic commit recorded in §26.16. | Agent |
| 0.16 | 2026-10-10 | **Confirmed wrong-target database DNS collision fixed in Compose.** Owner diagnostic proves app/migration credentials match but app resolves generic `db` to 172.18.0.9 instead of Cairn DB 172.31.0.2. D-056 adds private alias `cairn-postgres` and points all runtime/owner URLs to it; keeps service/volume, roles/secrets and existing Traefik unchanged. Compose resolved-config checks and 8 Python redaction/routing tests pass. Owner must apply the alias/recreate containers and verify DNS; no password reset, image rebuild, volume removal or ERP-data change. §26.17 records evidence, commands and expected outcomes. Normal routing fix push verified; commit recorded in §26.17. Host remediation not yet verified. | Agent |
| 0.17 | 2026-10-10 | **Production tenant admission security after owner concern.** D-057 closes anonymous signup: first setup requires deployment-owner token, later setup requires token plus verified provisioning capability; global transaction lock/init recheck before tenant insert prevents stale bootstrap admission. Independent server-action gate, server page wrapper and masked owner field added; production directory/launchpad require sign-in and filter own tenant. Safe optional server-only token configuration added; blank locks web provisioning, existing users/data unchanged. 53 focused tests, TypeScript/standalone build/IP lint and 8 Python regressions pass; no live host/PG concurrency claim or complete security sign-off. §26.18 supersedes public-onboarding advice and documents configuration/limits. Normal security push verified; commit recorded in §26.18. Host validation remains pending. | Agent |
| 0.18 | 2026-10-10 | **B-003 complete: material Purchasing UI accepted in a bounded batch.** Extended only its browser target for staged/complete/maintained plant data, exact tolerances/manufacturer part, unchanged-save preservation, unsupported-unit refusal, visible history/footer and warehouse read-only access. No MRP/valuation/PO feature changes or ERP product correction. Recovered discarded sandbox services by restoring the preserved B-002 database dump into a fresh empty DB—not a reset/reseed; original checkpoint counts match before/after. Standalone/typecheck, **163 Vitest tests**, 8 Python regressions, IP lint and real Purchasing-only browser pass. Fresh private DB/source/review checkpoint saved; owner remote data untouched. §26.19 records scope/results/limitations; B-004 planning settings is next. Normal verification-source push verified; commit recorded in §26.19. | Agent |
| 0.19 | 2026-10-10 | **B-004 complete: Material MRP settings UI accepted within its small-batch scope.** Tested staged/complete/maintained plant settings, exact quantities, unchanged resave, reorder net-change reflag, invalid lot refusal, visible history/footer and warehouse read-only authority. Found FND-004: null saved controller wrongly used a new-record default and auto-completed on resave; browser-safe value helper now distinguishes null/undefined, with five regressions. No existing-record rewrite or MRP engine/valuation/purchasing expansion. Typecheck/standalone build, **168 Vitest tests**, 8 Python tests, MRP acceptance and Purchasing regression pass; private DB counts unchanged. Fresh checkpoint saved; shared UI correction needs owner image rebuild. §26.20 records results/limitations and B-005 valuation is next. Normal correction/acceptance push verified; commit recorded in §26.20. | Agent |
| 0.20 | 2026-10-10 | **B-005 complete: Material Valuation UI accepted.** Expanded only its browser target for incomplete/complete/maintained/no-op settings, exact moving/standard prices and price unit, company-derived currency, forged/read-only stock-value refusal, positive unit validation, existing-stock change guard, visible financial history and separate finance-display/warehouse denial. Guard stock and auth identities are isolated SQL fixtures, not new postings or owner data. Fixed only a test column-name mismatch, not schema/product code. 168 Vitest tests, 8 Python tests, typecheck/IP lint and real valuation browser pass; data counts unchanged and private checkpoint saved. All four implemented views individually verified, not full material/operational conformance. §26.21 records limitations; B-006 payment-term backend is next. Normal valuation-acceptance push verified; commit recorded in §26.21. | Agent |
| 0.21 | 2026-10-10 | **B-006 complete: payment-term backend/defaults, UI pending.** Added one tenant-cascading forced-RLS master and additive 0003/9007 migrations (12 applied, existing immutable). Versioned/locked/audited service validates exact discount tiers, no-op/stale concurrency and active status; pure explicit-baseline UTC due/discount-date result carries master version for future document snapshots. Five additive standard defaults wired into fresh package activation and guarded development 0100 only; existing definitions/business records untouched. 19 new tests; 187 total, typecheck/standalone build/IP lint pass. Fixed-date/month-end/instalments and invoice/payment execution remain pending; no fake working UI route. §26.22 records contracts/preservation and B-007 page is next. Normal backend push verified; commit recorded in §26.22. | Agent |
| 0.22 | 2026-10-10 | **B-007 complete: protected payment-term maintenance UI.** Added own-code list/search/create/change/history and saved baseline-date preview, independent session/capability action, safe defaults/version behavior and checklist completion. Registered working screen/capability (39 caps/17 terms/16 aliases). Three new action-security tests and isolated browser case; 191 automated tests, 8 Python regressions, standalone/typecheck/IP lint and real form/date/error/history/search/checklist pass. Original records unchanged, no migrations or invoice/payment execution. R-23 records mandatory owner check instructions/dummy data; §26.23 includes TEST30/TEST2D expected dates and negative/stale/authority checks. B-008 partner general backend next. Normal maintenance UI push verified; commit recorded in §26.23. | Agent |
| 0.23 | 2026-10-10 | **B-008 complete: general business partner backend only.** Added two tenant-cascading forced-RLS tables and additive 0004/9008 migrations (14 applied). Validated/locked/versioned/audited general identity supports staged address, immutable category, supplier/customer dual roles, stable role deactivation, block/use gates and no-op preservation. No bank/company/purchasing/sales/operational capability fabricated. 16 new tests; 207 total, 8 Python regressions, typecheck/standalone/IP lint pass; original business/config rows unchanged, no partner fixtures retained or owner-host edits. §26.24 gives backend checks and future TESTSUPP01 dummy form data; UI is B-009 next. Normal general-backend push verified; commit recorded in §26.24. | Agent |
| 0.24 | 2026-10-10 | **B-009 complete: protected general partner maintenance UI.** Registered own create/display/maintain commands and capability (40 caps/20 terms/19 aliases), launchpad and general-only form/list/search/status/history with explicit pending segments. Server session/authority/context checks, safe business-only props, immutable category/number, staged saves, roles and blocking supported. Three action regressions plus browser target; 211 tests, 8 Python checks, typecheck/standalone/IP lint and real general lifecycle/read-only browser pass; no owner data or schema change. §26.25 provides TESTSUPP01/TESTCUST01 dummy records, expected/negative/stale checks; B-010 company backend next. Normal general UI push verified; commit recorded in §26.25. | Agent |
| 0.25 | 2026-10-10 | **B-010 complete: supplier company backend, UI pending.** Added company-scoped forced-RLS/cascading master and immutable 0005/9009 additions (16 migrations). Derives chart and validates active supplier/company, vendor reconciliation and payment terms; stages, blocks, versions, audits and preserves no-ops. General/use gates and linked-accounting recon protection; no invoice/bank/purchasing flow implied. 18 new tests; 229 total, 8 Python, standalone/typecheck/IP lint pass, original data preserved via dump restoration and fixture cleanup. §26.26 documents dummy 1000/200000/NET30 assignments, width/reclassification caveats and B-011 next. Normal backend push verified; commit recorded in §26.26. | Agent |
| 0.26 | 2026-10-10 | **B-011 complete: supplier company financial UI.** Active Supplier tab/company selector, derived chart/currency, valid reconciliation/terms, stages/version/no-op/block and scoped history; separate financial read/write authority at page/action. Registered command/caps (42/21/19), added three action tests and isolated browser target. 233 tests, 8 Python, standalone/typecheck/IP lint and live scoped form/refusal/history/non-finance browser pass; original data/schema preserved. §26.27 has dummy 1000/200000/NET30 and positive/negative/stale checks, screenshot/private checkpoint. No invoice/bank/purchasing expansion; B-012 backend next. Normal UI push verified; commit recorded in §26.27. | Agent |
| 0.27 | 2026-10-10 | **B-012 complete: supplier purchasing-organisation backend, UI pending.** Added forced-RLS/cascading master plus immutable 0006/9010 additions (18 applied). Validates active org/company/currency/group/optional terms, delivery code/location, stable supplier role, stages/blocks/version/audit and plant assignment; independent org data, no company defaults copied. 19 new tests; 252 total, 8 Python, standalone/typecheck/IP lint pass; original data unchanged. §26.28 gives future 1000/USD/001/FCA/Kuwait City/NET30 form data and negative checks; no PO/stock/payment/partner-function flow implied. User review remains pending and B-013 UI is next. Normal purchasing-backend push verified; commit recorded in §26.28. | Agent |
| 0.28 | 2026-10-10 | **B-013 complete: procurement-protected supplier purchasing UI.** Added active Supplier tab/org selector and currency/group/delivery/location/optional-term/block/reason/status/history panel; independent server action/tenant-actor/PROC authority, safe filtered choices and unset preservation. 44 caps/22 terms/19 aliases; three action tests plus browser target. 256 tests, 8 Python, build/typecheck/IP lint, Purchasing browser and Company regression pass; original data/schema unchanged. §26.29 keeps later owner review pending and provides dummy/positive/negative/stale checks. Explicit next customer company/sales-area split B-014…17 added; no PO/stock/payment functionality implied. Normal procurement UI push verified; commit recorded in §26.29. | Agent |
| 0.29 | 2026-10-10 | **B-014 complete: customer company backend, UI pending.** Added tenant/RLS/cascading company AR master and immutable 0007/9011 additions (20 applied), active customer/chart-account/terms validation, staged/block/version/audit/use checks and linked recon/chart protection. Supplier and customer data remain separate on one dual-role identity; no sales/invoice/credit flow implied. 20 new tests; 276 total, 8 Python, standalone/typecheck/IP lint pass. Original data preserved by dump recovery/fixture cleanup. §26.30 gives future 1000/110000/NET30 assignments and positive/negative limitations; B-015 form next. Normal AR backend push verified; commit recorded in §26.30. | Agent |
| 0.30 | 2026-10-10 | **B-015 complete: Customer company AR maintenance UI.** Added Customer-only tab/company selector/derived chart-currency/valid AR-terms/block/history panel, separate FIN Customer read/write caps and independent session-derived action. 46 caps/23 terms; caught/fixed i18n namespace collision at typecheck. Three action tests and browser target; 280 tests, 8 Python, standalone/typecheck/IP lint, Customer browser and two Supplier regressions pass. Original data/schema preserved, owner reviews/rollout pending. §26.31 includes TESTCUST01/1000/110000/NET30 dummy/checks; no billing/clearing/credit flow implied and B-016 backend next. Normal AR UI push verified; commit recorded in §26.31. | Agent |
| 0.31 | 2026-10-10 | **B-016 complete: customer sales-area backend, UI pending.** Added forced-RLS/cascading `customer_sales_area` master plus immutable 0008/9012 additions (22 applied, 70 tables). Validates active customer role, sales area/organisation/company and same-company delivering plant; delivery/pricing defaults, flags, blocks, staging, version, audit and operational gate. Pricing procedure and sales district are code-only until their masters exist. 22 new tests; 302 total, 8 Python, typecheck/build/IP lint pass; Customer company regression unchanged. §26.32 gives dummy TESTCUST01/1000/01/01/RVAA01 future data and limitations; B-017 sales-area UI is next. Next B-017 sales-area UI. | Agent |
| 0.32 | 2026-10-10 | **B-017 complete: customer sales-area maintenance UI, browser acceptance pending.** Added Sales area tab on active Customer partners with separate SALES.CUSTOMER.SALESAREA DISPLAY/MAINTAIN authority, scoped area selector, plant/procedure/district/flags/block/reason/status/history and server action. Catalogue now 48/24/21 with seed rerun required. 3 action tests and 1 choice test added; 306 Vitest, 8 Python, typecheck/build/IP lint pass; SSR checks for maintainer/reader/no-authority roles pass. No browser run (no Chromium in sandbox). §26.33 gives owner steps and B-018 selection is next. | Agent |
| 0.33 | 2026-10-11 | **B-018 complete: customer company payment-methods/dunning-procedure fields, backend only.** Additive migration 0009 adds nullable `payment_methods` varchar(40) and `dunning_procedure` varchar(4) to `customer_company_code` (23 applied). Service normalises the payment-method set (capitalise/dedupe/sort, ≤10 codes of 1–2 chars) and the dunning code (≤4 capital letters/digits), both code-only until their masters exist; fields join version/no-op/history/RLS pipeline and are flagged security-relevant; completeness gate and operational gate unchanged; server action forwards fields with no visible UI change. No new capability, no reseed. 9 new tests; 315 Vitest across 19 files, 8 Python, typecheck/build/IP lint (162 files) pass in a freshly provisioned dev cluster. §26.34 records semantics, owner steps and limitations; B-019 (matching UI) is the natural next. | Agent |
| 0.34 | 2026-10-11 | **B-019 complete: customer company payment-method/dunning UI only.** Exposed the B-018 fields in the existing company-code form and authorised read-only view, populated them from persisted tenant data, and retained the existing session-derived action, version/no-op, change-history and authority behavior. No schema, migration, capability, seed or payment/dunning execution change. Added a focused action assertion and extended the customer-company browser target for canonical save/reload/no-op/history/access checks; the DB-backed target is not run in this fresh workspace because PostgreSQL is unavailable. Typecheck, production build, IP lint and 58 pure harness tests pass. §26.35 records behavior and owner walkthrough steps; B-020 is the next selected backend slice. | Agent |
| 0.35 | 2026-10-11 | **B-020 implementation complete: customer-company interest-indicator/tolerance-group backend only; DB acceptance pending.** Added nullable varchar(4) fields and additive migration 0010, preserving 0009. Both optional code-only fields trim, uppercase and accept 1–4 alphanumeric characters; explicit blank clears and an omitted field preserves stored values for legacy callers. They join the existing version/no-op/security-relevant history pipeline but do not affect completeness or operational use. No UI, master FK, calculation, enforcement, seed or capability change. Added pure normalizer coverage, DB-backed lifecycle/audit/validation tests, and an action-security legacy-form regression; DB-backed tests and migration application remain unrun because PostgreSQL is unavailable. Typecheck, production build, IP lint (164 files), 64 pure harness tests and diff check pass. §26.36 records behavior and limitations; B-021 is to be selected next. | Agent |
| 0.36 | 2026-10-11 | **B-021 implementation complete: customer company interest-indicator/tolerance-group UI; browser acceptance pending.** The existing Customer company panel now passes stored values to editable controls and authorised display-only values; codes remain max-four-character alphanumeric inputs, canonicalised by the B-020 service. The existing action/session-derived authority and omitted-field compatibility remain intact. Extended the isolated customer-company browser target for canonical save/reload, no-op, clear/restore, history and display-only/non-finance boundaries. No schema, migration, capability, seed or service behavior change. Typecheck, production build, IP lint (164 files), 64 pure harness tests and diff check pass; DB-backed browser smoke cannot run without PostgreSQL. §26.37 records owner steps; B-022 remains for selection. | Agent |
| 0.37 | 2026-10-11 | **Owner-approved dependency-ordered completion roadmap.** Added §25.5 from outstanding B-020/B-021/B-017 acceptance through M1b–M1e, M1 release/sign-off, then Phases 2–9. Added pending B-022–B-024 acceptance gates and B-025 partner-function rule capture to the bounded queue. Roadmap packages must still be split into ≤10-minute one-outcome batches; no code, schema, migration or database changes in this update. §25.5 records the M1/Phase-2 scope reconciliation and keeps D-028/D-029 baseline acceptance in M1. | Agent |
| 0.38 | 2026-10-11 | **B-022 complete: isolated PostgreSQL migration/database acceptance passed.** Provisioned fresh local PostgreSQL 17.11, loopback-only on port 55432, using dedicated `cairn_b022_test`; applied all 24 SQL migrations including 0010 and seeded reference data. Customer-company and action-security DB suites pass, 65/65 tests. B-023 customer-company browser acceptance is next; the test server remains available locally. No owner/production DB or tenant touched. No code or migration-file changes were made; the schema was applied only to the disposable local test database. §26.38 records setup and results. | Agent |
| 0.39 | 2026-10-11 | **B-023 automated browser acceptance passed for B-019/B-021.** Ran the isolated `customer-company` Playwright target against the B-022 PostgreSQL database using a UI-created, disposable development fixture `T988`; all save/reload/no-op/clear/restore/history, finance display-only, non-finance denial, validation and sign-out checks passed, with no page errors. The harness cleaned up its fixture (zero matching rows afterward). Owner walkthrough/sign-off and B-024 sales-area browser acceptance remain pending. CAIRN updated; no code or migration-file changes in this batch. §26.39 records scope and result. | Agent |
| 0.40 | 2026-10-11 | **B-024 automated browser acceptance passed for B-017.** Added focused `customer-sales-area` Playwright target using disposable UI-created dev fixture `T987`; verified sales-area staged/completed saves, plant choice, canonical defaults, persisted readback, no-op, scoped block/unblock, history, and signed-out protection. Target passed within deadline with no browser errors; cleanup query confirmed zero matching fixture rows. Display-only/finance-only browser switching is not covered by this target; B-017 SSR/action checks remain documented and the owner walkthrough is pending. Typecheck, 65-test browser harness and diff check pass. §26.40 records scope and boundaries; no schema or migration changes. | Agent |
| 0.41 | 2026-10-11 | **B-025 supplier partner-function semantics approved; implementation pending.** Owner approved primary supplier as fallback plus ordering-address, goods-supplier and invoicing-party assignments; no separate pay-to role; directed, non-reciprocal relationships; per-role unique/multiple cardinality with one optional default and user selection when absent; current purchasing-organisation scope without effective dates or plant/sub-range overrides. Reference semantics checked against SAP Help and SAP Learning; Cairn codes/labels remain proprietary-safe. No code/schema changes. §26.41 records decisions; partner-function implementation is next in separate bounded batches. | Agent |
| 0.42 | 2026-10-11 | **B-026 supplier partner-function storage and RLS complete; service pending.** Added tenant-scoped function-rule and purchasing-assignment tables, own function keys, composite same-tenant foreign keys, version/audit fields and one-default partial unique index. Added migrations 0011/9013 and schema registration. Applied all 26 migrations in a fresh isolated PostgreSQL 17.11 `cairn_b026_test`; verified FORCE RLS, default-deny reads/writes and restricted app-role flags. Typecheck, 65-test browser harness and diff check pass. Catalogue not seeded; role cardinality enforcement/service/UI remain future batches. No owner/production data or transaction behavior touched. §26.42 records results. | Agent |
| 0.43 | 2026-10-11 | **B-027 supplier partner-function read services passed.** Added tenant-scoped catalogue and assignment queries, including function/cardinality labels, defaults, versions and related Supplier status; inactive relationships remain visible for maintenance. Database tests pass 2/2, covering ordering, tenant/scope isolation and unscoped default-deny reads; typecheck passes. No write/service action, UI, seed or schema migration in this batch. §26.43 records behavior; assignment mutation/cardinality enforcement follows in a separate bounded batch. | Agent |
| 0.44 | 2026-10-11 | **B-028 initializes the owner-approved supplier partner-function catalogue in standard tenants.** Advanced the standard package to `INTL-STD-2`; each tenant package run inserts missing Cairn-owned `ORDERING_PARTNER`, `DELIVERY_PARTNER`, and `INVOICE_SENDER` rows with explicit initial `allowsMultiple=false` and Cairn labels, preserving existing tenant settings on reapplication. Owner selected UNIQUE for all three. Added DB coverage for seeded values, preserving tenant edits on re-application, and B-027 query/isolation coverage (4/4 supplier tests). Typecheck, full Vitest suite, 65-test browser harness and diff check pass. No assignments, defaults, write service, enforcement, UI, schema or migration change. §26.44 records scope; assignment behavior remains pending. | Agent |
| 0.45 | 2026-10-11 | **B-029 supplier partner assignment write service passed.** Added tenant-scoped audited create/update, atomic replacement and remove; enforced active function/role/scope checks, configured unique/multiple cardinality, no default for unique functions, optional single default for multiple functions, default transfer, optimistic versions and per-slot concurrency locks. No-op writes are silent; removals and default changes are audited. Four focused DB tests, 339 total Vitest tests, typecheck, 65 browser-harness tests and diff check pass in the isolated development database. No UI, action/capability or PO determination. §26.45 records limits; protected UI is next. | Agent |
| 0.46 | 2026-10-11 | **B-030 protected supplier partner-function server actions passed.** Added scoped catalogue/assignment reads and create/replace/remove actions; read requires purchasing DISPLAY/MAINTAIN or AUDIT.WORKSPACE and writes require purchasing MAINTAIN. Tenant and actor are session-derived; forged client/actor values ignored; anonymous calls redirect. Three action-security regressions added (30/30 action-security tests). Full Vitest (342/342), typecheck/build, browser harness (65/65), IP lint (172 files) and diff check pass. No UI, new capability, migration or PO determination. §26.46 records scope; maintenance UI is next. | Agent |
| 0.47 | 2026-10-11 | **B-031 display-only supplier partner-function panel added.** Integrated the authority-gated read view into the Supplier Purchasing tab, grouped by function and showing cardinality, active state, related supplier status/blocking, default and empty/no-default states. New UI labels use i18n. Typecheck, full Vitest (342/342), browser harness (65/65), production build, IP lint (173 files) and diff check pass. Dedicated live-browser acceptance and editing controls remain pending. No schema, migration or PO behavior. §26.47 records scope; assignment editor next. | Agent |
| 0.48 | 2026-10-11 | **B-032 supplier partner-function assignment editor added.** Maintain users can add/replace unique assignments, add multiple assignments, designate/change/unset their optional default, and remove rows with reason/version controls. Pickers query same-tenant active Supplier roles, advertise the 200-row limit, and stay disabled until a purchasing-org segment exists. Existing session-derived actions remain the only write path; no cardinality setting is invented or changed. Typecheck, full Vitest (343/343), browser harness (65/65), production build, IP lint (173 files) and diff check pass. Dedicated editor browser acceptance and PO determination remain pending. §26.48 records limits; browser acceptance next. | Agent |
| 0.49 | 2026-10-11 | **B-033 dedicated supplier partner-function live-browser acceptance passed.** Extended the disposable `supplier-purchasing` Playwright target with segment-gate, unique add/replace/remove, configured-multiple add/default set/unset/transfer/removal, read-only Auditor and unrelated-authority checks. The multiple rule was altered only in the UI-created T990 dev fixture; guarded cleanup ran and post-run query confirmed no T990 fixture remains. No browser errors. `npm run typecheck`, browser harness (65/65), focused target and diff check pass; no app schema/migration, transaction behavior, owner/production data, commit or deployment. §26.49 records coverage and boundary. | Agent |
| 0.50 | 2026-10-11 | **B-034 Supplier company-code UI-only pending defaults.** Added disabled, read-only placeholders for payment methods, dunning procedure, cash discount, and tolerance group to both maintenance and authorised display-only panels; they are outside the save form, have no submitted names, and have no persistence/action/schema behavior. Updated the `supplier-company` browser target to assert four disabled, non-submitted fields. Typecheck, production build, IP lint, 65 browser-harness tests and diff check pass. Live Playwright acceptance remains pending because no authenticated isolated development `DATABASE_URL` was configured; the read-only connection check failed before a fixture or database mutation. Payment Methods is the owner-selected first master; B-035 captures its v1 semantics/scope. §26.50 records scope and boundary. | Agent |
| 0.51 | 2026-10-11 | **B-035 Payment Methods master v1 semantics approved.** Owner selected a tenant+country+1–2-character uppercase alphanumeric identity, a shared catalogue with `OUTGOING`/`INCOMING`/`BOTH` eligibility, description and active state, definitions-only scope, and no standard seed methods. Future Supplier/Customer code assignments resolve by company-code country and direction; current Customer code-only validation remains unchanged. Vendor/customer and house-bank permissions, payment-medium formats, and execution stay separate. No code/schema/seed/database changes; D-058 and §26.51 record the decision; B-036 schema/RLS is next. `git diff --check` passes. | Agent |
| 0.52 | 2026-10-11 | **B-036 Payment Methods schema and tenant RLS implemented.** Added `payment_method` to the typed Foundation schema with country/code primary key, ISO country and tenant FKs, direction/domain/code/description/version checks, audit metadata, and additive migrations `0012_payment_method_master.sql` / `9014_payment_method_policies.sql` (ENABLE + FORCE RLS and app-role grants). Added DB-backed schema/RLS tests for country reuse, constraints, isolation, defaults, and cascade. Typecheck, build, IP lint (177), 65 browser-harness tests and diff check pass. DB-backed test/migration application remains pending because isolated development credentials are unavailable; no database/owner data touched. §26.52 records limits; B-037 read service is next. | Agent |
| 0.53 | 2026-10-11 | **B-037 Payment Methods read services implemented.** Added tenant-scoped, validated get/list reads by country and code; list supports requested `OUTGOING`/`INCOMING` use (including `BOTH`) and optional active-only filtering while retaining inactive rows by default. Added DB-backed read tests for canonicalization, country resolution, filters, tenant isolation and invalid inputs; not run because isolated dev DB credentials are unavailable. No schema, migration, write service, UI, seed, payment execution, or partner-field integration. Typecheck, 65 browser-harness tests, IP lint (179 files) and diff check pass. §26.53 records limits; B-038 write service is next. | Agent |
| 0.54 | 2026-10-11 | **B-038 Payment Methods audited maintenance service implemented.** Added tenant-scoped, expected-version create/change and non-destructive retire with required actor/reason, same-key advisory transaction locks, optimistic concurrency, no-op silence, and before/after change history (retire is a `CHANGE` to `isActive`, using only supported change types). Added DB-backed lifecycle, stale-version, audit, no-op, soft-retire, and cross-tenant key-reuse tests; not run because isolated dev DB credentials are unavailable. Typecheck, browser harness (65/65), IP lint (179 files), and diff check pass. No action, UI, seed, payment execution, Supplier/Customer integration, migration, or DB access. §26.54 records limits; protected configuration UI is separate. | Agent |
| 0.55 | 2026-10-11 | **B-036–B-038 isolated PostgreSQL acceptance passed.** Initialized a fresh disposable local PostgreSQL 17.11 cluster; applied all 28 migrations and seeded only shared reference fixtures. Focused schema/RLS and Payment Methods service tests passed 11/11 (3 schema + 8 read/write service); application role check passed. Test tenants were cleaned (zero remained), and the server plus temporary data directory were removed. The pre-existing local cluster and owner/production databases were not accessed. No package, schema, or migration file changed. §26.55 records setup/results; protected configuration UI and Supplier integration remain separate. | Agent |
| 1.20 | 2026-10-12 | **B-105 begins Enterprise Structure at SCR-012 by registering the Company Code define capability only.** Added `CFG.ORG.COMPANYCODE.DEFINE` as module FND, CONFIGURE, non-posting; a no-DB contract test ensures no tenant-role grants and preserves wildcard semantics. No server action, UI, schema, migration, seed execution or database access. Browser harness 83/83, typecheck, IP lint (258 files), and diff check pass. No remote DB, commit or push. §26.122 records scope. | Agent |
| 1.19 | 2026-10-12 | **B-104 passes Supplier Payment Methods browser-only acceptance on disposable local PostgreSQL.** Verified local identity before B-104 setup applied the existing 39 migrations and two shared seeds; this batch did not rerun migration/service acceptance. The `supplier-company` target alone passed in headless Chromium v1248 against the optimized standalone Next build with no browser errors, covering filtering, ten-selection cap, persistence, authority boundaries, stale-choice removal and explicit clear. Synthetic definitions used audited service fixtures; Supplier selection and `B1` retirement were exercised in the UI. The runner left zero tenants, partners, Supplier company rows, Payment Method rows or partner-bank rows. App, cluster/data/logs, temporary PostgreSQL packages and Chromium binaries removed; apt autoremove removed 29 no-longer-needed runtime packages while shared system dependencies were retained. `npm run build`, browser harness 81/81, typecheck, IP lint (257 files) and diff check pass. No remote DB, commit or push. §26.121 records scope. | Agent |
| 1.18 | 2026-10-12 | **B-103 passes disposable migration/service acceptance for Supplier Payment Methods.** Fresh local PostgreSQL 17.11 bound only to 127.0.0.1; identity verified before migration/seed. Applied all 39 migrations (including 0017) and the two shared seeds; `tests/supplier-companies.test.ts` passes 25/25. Final counts: zero tenants, partners, Supplier company rows, Payment Method rows or partner-bank rows. Cluster/data/packages removed. No remote DB or live browser target; the latter remains separate. §26.120 records scope. No commit or push. | Agent |
| 1.17 | 2026-10-12 | **B-102 prepares the Supplier Payment Methods live-browser target.** The supplier-company target now covers empty/no-choice state, same-country OUTGOING/BOTH filtering, an 11th-choice disable after ten selections, persistence, authorized display-only, stale-choice removal and explicit clear. Added a no-DB target-contract test. Browser harness 81/81 and typecheck pass; IP lint and diff check pass. Live target was not run because no local disposable DB URL/service was available; migration 0017 remains unapplied and no database was accessed. §26.119 records the blocked gate. No commit or push. | Agent |
| 1.16 | 2026-10-12 | **B-101 adds the capability-gated Supplier Payment Methods selector.** The existing maintain capability controls the checkbox editor; display-only users retain saved-value access. Eligible methods are wired from the tenant/country-scoped choices, empty selection submits an explicit clear, and stale saved choices can be removed. The other three company defaults remain disabled. Browser harness 78/78, typecheck, IP lint (256 files), and diff check pass. DB tests and live browser acceptance remain separate; migration 0017 unapplied and no database accessed. §26.118 records scope. No commit or push. | Agent |
| 1.15 | 2026-10-12 | **B-100 wires the Supplier Payment Methods action and eligible-choice service.** The existing maintain action conditionally passes the new field while tenant/actor remain session-derived; the choice query returns only active same-country `OUTGOING`/`BOTH` methods with explicit tenant filters. No UI control or new capability yet. Browser harness 76/76, typecheck, IP lint (255 files), and diff check pass. DB choice test not run; no migration or database access. §26.117 records scope; selector UI and browser acceptance remain. No commit or push. | Agent |
| 1.14 | 2026-10-12 | **B-099 adds country/direction-aware Supplier Payment Methods save-service validation.** Canonicalizes code sets; validates all selected methods against the same tenant and company country, requiring active `OUTGOING`/`BOTH`, and locks definition rows during save. Explicit blank clears, omission preserves, and changes are security-relevant/versioned. Added pure tests plus DB service cases; the latter were not run without a verified disposable DB. Browser harness 74/74, typecheck, IP lint (254 files), and diff check pass. No action/UI, migration application, database access, commit or push. §26.116 records boundary; action/UI are next. | Agent |
| 1.13 | 2026-10-12 | **B-098 adds nullable Supplier company-code Payment Methods storage only.** Added the schema field, additive migration `0017`, a static schema contract, and registered it in the database-free browser-harness suite. No validation/service/action/UI or database migration was applied. Browser harness: 68/68; typecheck, IP lint (253 files), and diff check pass. Default Vitest global setup attempted `127.0.0.1:5432` and was refused before collection; no database was reached. §26.115 records limits; next is country/direction-aware save validation. No commit or push. | Agent |
| 1.12 | 2026-10-12 | **B-097 records the owner's reported pass for the B-023/B-024 walkthroughs.** Updated acceptance status based on the owner's confirmation that both walkthroughs were complete and all checks passed. Per-step evidence and test-environment details were not supplied; no independent verification, app/host/database access, deployment, commit, or push occurred in this documentation-only update. §26.114 records the scope and distinction. | Agent |
| 1.11 | 2026-10-12 | **B-096 publishes the complete pending B-080–B-095 partner-bank batch on explicit owner instruction.** All 45 paths committed as `3035c9b` and fast-forward pushed from `057e19c` to `deepakpt2/cairn-erp:main` as the repository user. The ignored `.env.local` PAT was supplied only through a temporary askpass helper; it was not committed, stored in the remote URL/config, or logged. `.env.local` is not in the commit; no database changed and no real bank values were included. §26.113 records scope. | Agent |
| 1.10 | 2026-10-12 | **B-095 passes real-browser fail-closed acceptance for stale and missing profile rows.** Fresh loopback PostgreSQL 17.11; all 38 migrations and both shared seeds passed. A disposable T095 exact-capability fixture made KW stale (D-061 vs current D-062) and removed JP's registry row. Chromium confirmed neither fail-closed row had an activation form, while current IN/GB/US `NOT_READY` rows retained controls with expected revision/version. No action submitted; zero activation audits, partners or bank rows; no browser errors or Save/Reveal controls. Production app, DB, fixture, PostgreSQL/browser dependencies and build removed. No remote/persistent DB, bank values, commit or push. §26.112 records scope. | Agent |
| 1.09 | 2026-10-12 | **B-094 passes cookie-backed browser acceptance for the capability-gated profile page/action.** Fresh PostgreSQL 17.11 loopback cluster; all 38 SQL migrations and both shared seeds passed. No role grant existed before temporary T094 fixtures. Chromium verified anonymous sign-in redirect, display-only route/action denial, exact-capability access and Administrator `*`; KW and GB transitioned only `NOT_READY` v1→`READY` v2. Forged actor/evidence/status/reason fields were ignored; exactly two activation-audit rows held session-derived actors and fixed evidence. No browser errors, partner/bank rows, or reveal/save controls. App, DB, fixtures, browser binaries/dependencies and build removed; no remote/persistent DB, bank values, commit or push. §26.111 records scope. | Agent |
| 1.08 | 2026-10-12 | **B-093 adds the capability-gated global partner-bank profile UI.** New `/foundation/partners/bank-profiles` route and Partners navigation link require `CFG.FND.PARTNER.BANKPROFILE.ACTIVATE`. Read-only view shows current policy, registry revision, readiness and version for the five approved profiles; missing/stale/invalid states fail closed. Only current `NOT_READY` rows get a one-way form with expected revision/version; fixed evidence and session-derived actor remain server-only. No bank-row save/reveal or role-capability grant. 59 focused profile/activation/UI/bank-display tests pass; typecheck, IP lint (251 files), diff check pass. No DB run or browser acceptance; no persistent state, commit or push. §26.110 records limits. | Agent |
| 1.07 | 2026-10-12 | **B-092 passes disposable PostgreSQL acceptance for the audited activation path.** On a fresh PG 17.11 Unix-socket-only cluster, all 38 lexical migrations and reference/global seeds applied. Verified five NOT_READY profiles, non-posting activation capability with no role grant, NOSUPERUSER/NOBYPASSRLS app role, exact function EXECUTE grant and denied direct profile/audit-table access. The real service/DB call activated synthetic KW and recorded matching audit; concurrent GB calls yielded one activation/event; stale/malformed requests denied; duplicate audit ID raised 23505 and rolled back the status change. Final disposable data: zero tenants, partners, bank rows; two activation events. Cluster, package and test script removed. No remote/persistent DB, bank identifiers, commit or push. §26.109 records scope; UI remains separate. | Agent |
| 1.06 | 2026-10-12 | **B-091 adds the capability-checked partner-bank profile activation service and server action.** Requires `CFG.FND.PARTNER.BANKPROFILE.ACTIVATE`, derives actor tenant/user only from the verified session, validates country/revision/version, fixes evidence server-side, and calls the atomic function inside tenant scope. Migration `9020` grants only exact-function EXECUTE to `cairn_app`; no role-capability grants or table DML. Eight service tests plus two action/grant contract tests and 38 previous focused tests pass (48/48 total); typecheck, IP lint (245 files), and diff check pass. No DB migration/seed applied, UI wired, profile changed, bank saved/revealed, commit or push. §26.108 records the boundary. | Agent |
| 1.05 | 2026-10-12 | **B-090 adds a private atomic activation database function.** It locks the global profile row, checks policy revision/status/expected version, changes only `NOT_READY`→`READY` with version +1, then inserts the fixed-field audit event in the same transaction. SECURITY DEFINER search path is locked to `pg_catalog`; `PUBLIC` and app EXECUTE are revoked, with no runtime grant. Three static function-contract tests plus profile/readiness/activation suites pass (38/38); typecheck, IP lint (240 files), and diff check pass. SQL not applied or live-tested; no capability service/action or profile change. §26.107 records the limits. No commit or push. | Agent |
| 1.04 | 2026-10-11 | **B-089 adds the global partner-bank profile activation audit schema.** Fixed-field table records actor tenant/user IDs, country, policy revision, one-way status transition, versions, fixed evidence and event timestamp; constraints reject free-text and inconsistent transitions. Migration `0016` creates the table; `9018` revokes all direct `PUBLIC`/app access. Three schema-contract tests plus profile/readiness/activation suites pass (35/35); typecheck, IP lint (238 files), and diff check pass. SQL not applied; no activation writer or profile mutation. No commit or push. §26.106 records the boundary. | Agent |
| 1.03 | 2026-10-11 | **B-088 adds a pure profile-activation command validator.** Requires an approved country, exact current D-062–D-066 policy revision, positive PostgreSQL integer version, and fixed `PROFILE_VALIDATION_ACCEPTED` evidence. Rejects unknown/free-text fields and fixes target status to `READY`; no session authorization, database mutation or audit writer. Eleven focused command tests plus resolver/schema/capability suites pass (32/32); typecheck, IP lint (234 files), diff check pass. No DB, seed, activation action, UI, bank data, commit or push. §26.105 records limits. | Agent |
| 1.02 | 2026-10-11 | **B-087 registers the profile-activation capability and fixed evidence code.** Added `CFG.FND.PARTNER.BANKPROFILE.ACTIVATE` to the global capability catalogue as non-posting Foundation configuration, without role grants; existing Administrator `*` semantics remain. Added fixed evidence `PROFILE_VALIDATION_ACCEPTED`. Two focused tests; combined profile suites pass 21/21, typecheck, IP lint (233 files), and diff check pass. No activation action, audit table, role grants, DB seed/run, UI, commit or push. §26.104 records the boundary. | Agent |
| 1.01 | 2026-10-11 | **B-086 passes disposable PostgreSQL acceptance for the global profile registry and readiness service.** Applied all 34 lexical migrations to fresh PostgreSQL 17.11, seeded five NOT_READY profiles, verified app-role SELECT-only privileges and denied UPDATE, then tested the B-085 service's not-ready → synthetic ready → same-revision preserve → stale-revision reset lifecycle. The profile table had no tenant/bank rows; final counts were zero tenants/partners/bank rows. Server, cluster, extracted package and test script removed; no remote/owner/production DB or real bank data. No activation, bank save/reveal, commit or push. §26.103 records results. | Agent |
| 1.00 | 2026-10-11 | **B-085 adds a read-only global bank-profile readiness service.** The runtime checks its app role and reads only the country’s policy revision/status; only an explicitly `READY` row matching the current D-062–D-066 policy revision resolves ready. Missing, stale, non-ready, missing-country and unsupported inputs fail closed; DB errors propagate. Six service tests plus the profile resolver/schema suites pass (19/19); typecheck, IP lint (231 files), and diff check pass. SQL was not applied at B-085 completion; B-086 later accepted migration/seed and runtime behavior. No activation, bank save/reveal, UI, commit or push. §26.102 records the boundary. | Agent |
| 0.99 | 2026-10-11 | **B-084 adds the global profile-readiness registry schema and seed.** Shared country-keyed table ties readiness to owner-approved policy revisions; the app role receives SELECT only. The reference seed defines IN/KW/GB/US/JP as initial `NOT_READY` rows, preserves status for the same revision, and resets to `NOT_READY` if policy revision changes. Twelve focused schema/readiness tests, typecheck, IP lint (229 files), and diff check pass. SQL migration/seed were not executed at B-084 completion; B-085 later adds the read-only reader and B-086 passes the disposable PostgreSQL acceptance. No bank save/reveal, commit, or push. §26.101/103 record the boundaries. | Agent |
| 0.98 | 2026-10-11 | **B-083 adds the initial pure deny-only bank-profile readiness boundary.** At B-083 completion, the D-061 authoring set (`IN`, `KW`, `GB`, `US`, `JP`) returned not-ready until persisted configuration existed; missing and unsupported countries failed closed. Tests proved validator success did not imply readiness. Eight focused no-DB tests, typecheck, IP lint (225 files), and diff check passed. No profile persistence/activation, save integration, schema, database, browser run, bank values, commit or push. B-085 later extends the resolver and adds a read-only registry service (§26.102). | Agent |
| 0.97 | 2026-10-11 | **B-082 passes live D-074 masked-detail acceptance with synthetic data only.** Extends the `business-partners` target with a strict fixture guard requiring an explicit elevated fixture URL, loopback `cairn_test`, and owned development T992 tenant. Fresh disposable PostgreSQL 17.11 with all 32 migrations/seeds; per-run 32-byte keyring and synthetic encrypted identifier. Maintainer and display-only viewer both see the fixed list mask and `••••4321` detail suffix without plaintext/ciphertext or Save/Reveal controls. T992 tenant/partner/bank row cleanup confirmed; app server stopped, cluster and extracted package removed, and keyring deleted. Target, typecheck, browser harness (66/66), IP lint (223 files), and diff check pass. No owner/production data, real bank data, schema change, commit or push. §26.99 records scope. | Agent |
| 0.96 | 2026-10-11 | **B-081 integrates the D-074 read-only bank detail view.** Metadata rows link to a selected record; the server loads the deployment keyring on demand and calls the scoped mask reader, while the panel receives only the D-074 safe DTO. Keyring/crypto failures show a generic unavailable state. Four focused no-DB suites pass 14/14; typecheck, production build, browser harness (66/66), IP lint (223 files) and diff check pass. No save, full-value reveal, key provisioning, database/live-browser acceptance, real data, commit or push. §26.98 records scope. | Agent |
| 0.95 | 2026-10-11 | **B-080 implements the scoped D-074 bank-detail mask reader, not yet UI-integrated.** Requires actual `FND.PARTNER.DISPLAY`; scopes the read by authenticated tenant, selected partner and UUIDv4 row ID; uses the matched row's identifiers for crypto context; returns only the D-074 suffix mask. Six synthetic focused tests, typecheck, browser harness (66/66) and diff check pass. No route/UI, save, full-value reveal, database, or real bank data. No commit or push; §25.4 full-system publish trigger remains. §26.97 records scope. | Agent |
| 0.94 | 2026-10-11 | **Owner-directed one-time publication of the bank-data batch to `main`.** Owner explicitly authorized an exception to the full-system publish gate for this batch only; future no-partial-push restriction remains. Committed 47 source/test/migration/doc paths as `9a39286 feat: add partner bank-data foundations and read-only view` and fast-forward pushed from `39e3d35` to `origin/main`. PAT from ignored `.env.local` used only for authentication through temporary askpass; no credential in source, commit, remote URL/config, or logs; staged-file secret check passed. §26.96 records scope. | Agent |
| 0.93 | 2026-10-11 | **B-078 reviews the Drizzle metadata gap and passes B-077's live browser target on a disposable PostgreSQL 17.11 database.** Confirms the custom runner ignores metadata and applies 32 lexical SQL migrations; Drizzle Kit metadata reconciliation remains separate. The T992 Business Partner target passes maintainer and display-only Bank Details checks; cleanup verified, private Unix socket only, TCP disabled, temporary cluster/app removed. Smoke onboarding uses only an ephemeral per-run value if its owner field is rendered; the synthetic viewer has `FND.PARTNER.DISPLAY` without maintain. Typecheck, browser-harness (66/66), and diff check pass. No bank records/values, persistent/owner/production DB, `.env.local` content access/change, commit or push. §26.95 records results. | Agent |
| 0.92 | 2026-10-11 | **B-077 extends Business Partner browser target coverage for the bank metadata tab.** The T992 target asserts the empty state and absence of save/reveal controls for maintainer and display-only users. Typecheck and browser-harness (66/66) pass; selection list confirms the target. Live browser/database acceptance was not run; no DB, bank rows or real identifiers touched. §26.94 records limits; no commit or push. | Agent |
| 0.91 | 2026-10-11 | **B-076 integrates a display-only Bank Details tab for Business Partners.** It loads B-075 metadata only on explicit selection and renders only allowlisted fields plus D-074's fixed `••••` list mask; no account identifiers, ciphertext, edit or reveal. Two panel and two route tests, typecheck, production build and diff check pass. No live database/browser acceptance, real bank data, commit or push; §26.93 records scope. | Agent |
| 0.90 | 2026-10-11 | **B-075 adds a display-authorized, read-only partner-bank metadata list.** The query is scoped by session tenant and selected partner, includes inactive records, returns only database row IDs and allowlisted non-ciphertext metadata, and uses deterministic order. Four new cases; focused suite 8/8 and typecheck pass. No DB access, persisted bank data, real identifiers, decryption, writes, reveal, or UI; §26.92 documents the boundary. No commit or push. | Agent |
| 0.89 | 2026-10-11 | **B-074 adds a display-authorized, read-only partner-bank metadata lookup.** Requires `FND.PARTNER.DISPLAY`, derives tenant from the authenticated session, and binds tenant + partner + UUIDv4 bank-row ID; returns allowlisted non-ciphertext metadata and the matched row's ID. Four focused tests and typecheck pass. No DB access, writes, decryption, reveal path or UI; §26.91 records the scope. No commit or push. | Agent |
| 0.88 | 2026-10-11 | **B-073 accepts partner-bank migrations and RLS on a fresh disposable PostgreSQL 17.11 cluster.** All migrations applied; live tests verified constraints including the 5,540-character envelope boundary, forced RLS, app-role SELECT-only privileges, tenant isolation, partner-delete block, and D-041 tenant cascade. The first run found PostgreSQL's regex repetition-count limit; additive migration `0014_partner_bank_envelope_bound.sql` corrected it without editing `0013`. The temporary cluster and synthetic fixtures were removed. Five static schema-contract tests, typecheck and diff check pass. No owner/production data, write service or reveal path; §26.90 records limits. No commit or push. | Agent |
| 0.87 | 2026-10-11 | **B-072 adds a ciphertext-only partner-bank table schema with forced tenant RLS and read-only app access.** The typed schema and additive migrations enforce UUIDv4/date/version/envelope-shape checks, retain client tenant cascade, and block direct partner deletion while rows exist. Four typed-schema/static-contract tests and typecheck pass; no migration application, persistent database or bank rows at B-072 completion. No write service, save path, UI or reveal path. §26.89 records the boundary. No commit or push. | Agent |
| 0.86 | 2026-10-11 | **B-071 adds a pure fail-closed dispatcher for the implemented KW/IN/GB/US/JP partner-bank validators.** Three dispatcher tests plus all five profile suites pass (26 total); typecheck and diff check pass. Missing/unsupported countries fail closed. The dispatcher is not connected to a save path or storage; no schema, database, or bank values. §26.88 records the boundary. No commit or push. | Agent |
| 0.85 | 2026-10-11 | **B-070 adds active-key-only verification for supplied ciphertext batches.** The verifier requires a one-key active keyring, checks key IDs and authenticates each non-null envelope/context, returning counts only. Two new tests; 24 focused ID/reveal/encryption tests pass; typecheck and diff check pass. It does not prove DB scan completeness or global key retirement; no database or bank data. D-085 / §26.87 document the limit. No commit or push. | Agent |
| 0.84 | 2026-10-11 | **B-069 adds a pure batch re-encryption transformer for supplied encrypted bank fields.** It authenticates each field context, re-encrypts old-key envelopes under the active key, preserves current envelopes and nulls, and returns ciphertext only; no DB read/write or key-retirement claim. Three new tests; 22 focused ID/reveal/encryption tests pass; typecheck and diff check pass. No actual bank data, schema, database scan, persistence or reveal path. D-084 / §26.86 document the boundary. No commit or push. | Agent |
| 0.83 | 2026-10-11 | **B-068 enforces the UUIDv4 bank-record ID policy at the encryption/decryption context boundary.** `BankDataContext.bankRecordId` uses the `BankRecordId` brand and receives runtime UUIDv4 validation before GCM AAD construction. Nineteen focused encryption/ID/audit tests pass; typecheck and diff check pass. This checks shape only; tenant/partner/ID-scoped lookup remains mandatory before any reveal path. No schema, persistence, database or bank data. D-083 / §26.85 document the boundary. No commit or push. | Agent |
| 0.82 | 2026-10-11 | **B-067 establishes server-generated UUIDv4 bank-record IDs and applies canonical-shape validation at the B-060 audit boundary.** Invalid/sequential IDs are denied and omitted from the audit object key; three ID helper tests plus eight reveal-boundary tests pass. Typecheck and diff check pass. UUID shape is not provenance: tenant/partner/ID-scoped row lookup remains mandatory before any reveal path. No bank table, row persistence, database, bank values, or reveal route. D-082 / §26.84 document the contract. No commit or push. | Agent |
| 0.81 | 2026-10-11 | **B-066 enforces `FND.PARTNER.DISPLAY` in the partner list/detail route before any partner-data reads.** Missing authority gets a fixed denial message before route parameters are awaited; existing maintenance actions remain independently gated by `FND.PARTNER.MAINTAIN`. One isolated route-guard regression test passes; typecheck and diff check pass. No bank data, reveal path, decryption or database use. D-081 / §26.83 document the authorization check; bank-record-ID opacity still blocks future reveal execution. No commit or push. | Agent |
| 0.80 | 2026-10-11 | **B-065 implements the remaining pure GB, US and JP bank-profile validators together.** GB enforces its 22-character IBAN structure/MOD-97 and derives the bank code; US validates ABA routing range/check digit with an opaque local account; JP requires the seven-digit institution/branch code with an opaque local account. Fourteen isolated synthetic-data tests pass; typecheck and diff check pass. No activation, persistence, schema, database, bank data, lookup, save path or UI. D-078–D-080 / §26.82 document the boundaries. No commit or push. | Agent |
| 0.79 | 2026-10-11 | **B-064 implements the pure India (`IN`) bank-profile validator only.** It requires holder/country, a local account number preserved exactly, and IFSC normalized/validated in `bankCode`; rejects a non-empty IBAN and syntax-checks optional BIC only. Five isolated synthetic-data tests pass; typecheck and diff check pass. No country-wide account-number rules, lookup, profile activation, persistence, schema, bank data, database, save path or UI. D-077 / §26.81 document the boundary. No commit or push. | Agent |
| 0.78 | 2026-10-11 | **B-063 implements the pure Kuwait (`KW`) bank-profile validator only.** It requires account holder and KW country; normalizes uppercase and ASCII spaces, validates the 30-character KW IBAN structure and MOD-97, rejects a separate non-empty local account number, derives bank code from IBAN positions 5–8 (and checks any supplied code), and syntax-checks optional BIC without external lookup. Four synthetic-data tests pass; typecheck and diff check pass. No profile registry/activation, persistence, schema, bank storage/data, database or UI. D-076 / §26.80 document the contract; B-064 India profile is next. No commit or push. | Agent |
| 0.77 | 2026-10-11 | **B-062 implemented a pure normal-view bank-identifier projection.** It reuses the B-057 strict bank-field allowlist, applies D-074 list/detail masks, fully masks values up to four characters, drops ciphertext and unknown/nested fields, and preserves safe metadata. Three new tests; focused B-057/B-060/B-062 privacy suites pass 15/15; typecheck and diff check pass. No bank schema, storage, data, database, decryption, route or UI. D-075 / §26.79 document the boundary; helper is not integrated into a view. B-063 Kuwait profile validator is next; no commit or push. | Agent |
| 0.76 | 2026-10-11 | **B-061 specified normal-view masking only.** Owner selected fixed `••••` in list/summary views and `••••` plus the final four characters in detail views for IBAN/local account identifiers; identifiers four or fewer characters remain fully masked, no original length or country prefix is shown, and history remains fully masked. D-074 / §26.78 record the rule. No code, UI, data or database changes; no tests applicable. B-062 pure projection is next; no commit or push. | Agent |
| 0.75 | 2026-10-11 | **B-060 added the session-bound bank-reveal authorization/audit writer boundary only.** The helper requires partner display plus reveal capability, validates IBAN/local-account fields and controlled purpose codes, takes actor/tenant from the verified session, and logs safe gate events plus terminal success/denial metadata without plaintext. Added capability catalogue seed entries but no role grants, route or UI; seed not run. Seven isolated fake-Tx tests pass; typecheck/diff check pass; no database, bank record or decryption. D-073 / §26.77 document that `AUTHORIZED` is not a completed reveal and terminal result must commit before plaintext return. B-061 normal-view mask format decision is next; no commit or push. | Agent |
| 0.74 | 2026-10-11 | **B-059 blocks direct runtime mutation of `audit_access_log`.** New immutable migration `9015_audit_access_log_append_only.sql` revokes UPDATE/DELETE/TRUNCATE from `cairn_app`, preserving SELECT/INSERT. The owner retained the existing whole-tenant `client` → log `ON DELETE CASCADE` as a lifecycle/retention exception (D-072). Added a development-tenant integration test for privileges, allowed writes and cascade cleanup; not run because no confirmed disposable DB was available. Typecheck and diff check pass; no database or owner/production data accessed. No reveal action, capability registration, bank data, commit or push. B-060 reveal authorization/audit writer boundary is next. | Agent |
| 0.73 | 2026-10-11 | **B-058 specified the separate bank-identifier reveal authorization and audit contract only.** Owner selected `SEC.PARTNER.BANK.REVEAL` plus `FND.PARTNER.DISPLAY`, normal wildcard matching (so Administrator `*` grants it), selected IBAN/local-account fields only, and required controlled purposes `PARTNER_SUPPORT`, `DATA_CORRECTION`, `AUDIT_REVIEW`, `LEGAL_REGULATORY`. Every authenticated attempt is audited; success must be committed before returning plaintext, and audit failure denies the reveal. Existing `audit_access_log` must be hardened against runtime UPDATE/DELETE before reveal implementation. D-071 / §26.75 record denial/logging behavior; no code, capability registration, schema, migration, database or data changed. B-059 append-only audit-log protection is next; no commit or push. | Agent |
| 0.72 | 2026-10-11 | **B-057 privacy projection integrated at generic history write and read boundaries.** Canonical `partner_bank`/`partner_contact` histories use allowlists; full IBAN/account identifiers and named-contact email/phone are replaced with `[masked]`, unknown/nested fields and free-form reasons/labels are omitted, and old stored items are redacted again on read. Organization-level `business_partner` contacts remain unchanged. Five isolated tests pass for create/change/no-op/read-redaction/general-contact behavior; typecheck and diff check pass; no database setup, bank storage, key or real identifiers. D-070 / §26.74 record exact scope and require future writers to use canonical object-class constants and opaque record IDs. B-058 audited-reveal contract remains next; ordinary-view masking and bank-data storage remain blocked. No commit or push; full-system publish trigger remains. | Agent |
| 0.71 | 2026-10-11 | **B-056 authenticated envelope re-encryption helper only.** Added `reencryptBankData`: it authenticates/decrypts using the recorded key ID and tenant/partner/record/field AAD, re-encrypts old-key envelopes with the supplied active key and fresh nonce, and verifies then no-ops already-current ciphertext. Generic failures; no persistence, audit/history, logging, key retirement, or bulk migration. Eight encryption tests plus seven keyring tests pass (15 total); typecheck and diff check pass. No schema, database, deployment keys, bank data, reveal authority, masking/history safeguards, or storage integration. D-069 / §26.73 records behavior; B-057 history redaction is next. No commit or push; full-system publish trigger remains. | Agent |
| 0.70 | 2026-10-11 | **B-055 fail-closed deployment-secret keyring configuration only.** Added lazy `CAIRN_BANK_DATA_KEYRING_JSON` parser for strict JSON with active key ID and 1–16 canonical unpadded base64url 32-byte keys; no fallback, generated/default key, raw-value error output, or integration into bank-data callers. Compose passes the secret only to the app; templates contain comments only. Seven keyring tests and six encryption tests pass (13 total), typecheck and diff check pass; no actual deployment key, schema, database, bank record, reveal/masking/history path or country-profile activation. D-068 / §26.72 record the contract; B-056 re-encryption helper is next. No commit or push; full-system publish trigger remains. | Agent |
| 0.69 | 2026-10-11 | **B-054 implements the versioned bank-data encryption primitive only.** D-067 records the selected app-managed keyring and AES-256-GCM contract: random 96-bit nonce, 128-bit tag, key ID and tenant/partner/record/field bound as AAD, active-key encryption and retained-prior-key decryption. Six isolated unit tests, typecheck and diff check pass. No deployment-secret loader/key material, reveal authority/audit, masking/history safeguards, schema/database integration, profile activation or bank identifiers. §26.71 documents the contract and strict boundary; B-055 keyring configuration is next. No commit or push; full-system publish trigger remains. | Agent |
| 0.68 | 2026-10-11 | **B-051–B-053 verified the remaining initial bank-validation profiles together.** D-064 records GB bank-issued IBAN-only validation (`GB`, 22 characters, MOD-97; bank/sort/account components embedded). D-065 records US local account + 9-digit ABA RTN with check digit, no active-directory or payment-rail claim. D-066 records JP local account + seven-digit institution/branch composite in the existing bank-code field, with Japan Post's official transfer-format exception. Source links are recorded in §§26.68–26.70. All five D-061 profiles now have research specifications (D-062–D-066), but none is implemented or enabled; no code/schema/database/profile rows/real bank values. Encryption/reveal/masking safeguards still block identifier storage. `git diff --check` passes; no commit or push. | Agent |
| 0.67 | 2026-10-11 | **B-050 India bank-validation profile verified from authoritative sources.** RBI's NEFT FAQ specifies branch IFSC and account number; IFSC syntax is 11 characters (`^[A-Z]{4}0[A-Z0-9]{6}$`). RBI's committee report describes bank-specific account-number formats and its India IBAN design was consultation-stage; current SWIFT Registry Release 103 has no IN profile. D-063 records required local account number + IFSC, opaque account-number handling, optional BIC for this non-payment master, no directory/account-existence lookup, and account type deferred to transactions. No profile implementation/activation, code/schema/database/profile rows/real bank values. §26.67 records the source-backed rules; B-051 GB is next. `git diff --check` passes. | Agent |
| 0.66 | 2026-10-11 | **B-049 Kuwait bank-validation profile verified from authoritative sources.** CBK documents Kuwait's IBAN adoption/activation and 30-character structure, account-bank issuance, and no-space electronic form; SWIFT's current Registry Release 103 (Sep 2026) confirms `KW2!n4!a22!c`, length 30, BBAN length 26 and embedded four-letter bank identifier. D-062 specifies bank-issued IBAN only for KW; no separate local-account entry, derived bank code, optional BIC in this non-payment master. Profile not implemented/activated; no code/schema/database/profile rows/real bank values. §26.66 records source-backed rules; India profile research B-050 is next. `git diff --check` passes. | Agent |
| 0.65 | 2026-10-11 | **B-048 initial bank-validation countries selected.** Owner selected `IN`, `KW`, `GB`, `US`, and `JP`; all exist in the current 30-country shared reference seed. This sets profile-authoring scope only; no country profiles, code/schema, database rows, or bank identifiers were added. D-061 and §26.65 record the set; all countries remain blocked until their profile exists. B-049 source-backed Kuwait profile verification is next. `git diff --check` passes. | Agent |
| 0.64 | 2026-10-11 | **B-047 partner-bank validation policy approved.** Country profiles are fail-closed: account holder/country required; profile selects the required IBAN or local account and bank-code/BIC fields; bank name optional. IBAN normalization, country match, country-length and MOD-97 validation; BIC syntax only, no account-existence claim. Valid-from required, valid-to optional/inclusive, overlaps allowed, active independent, no hard deletion. No profile rows, code, schema, database, or real identifiers added. D-060 and §26.64 record policy; initial supported countries (B-048) and encryption-key/reveal infrastructure remain. `git diff --check` passes. | Agent |
| 0.63 | 2026-10-11 | **B-046 partner bank/contact v1 rules approved.** Owner selected partner-wide valid-dated bank records with the standard holder/country/bank/IBAN-or-local-account/BIC fields, encryption-at-rest, masked views/history and separate audited reveal; no company/role/default/payment/house-bank execution behavior. Contact persons are multiple partner-wide records with one primary, date validity, logged reads/changes, masked personal email/phone history and retention-controlled deletion; existing general email/phone remain organisation-level. Country-specific field requiredness/validation and key provisioning/rotation remain prerequisites. No code/schema/database/real data changes. D-059 and §26.63 record approval; B-047 validation rules are next. `git diff --check` passes. | Agent |
| 0.62 | 2026-10-11 | **B-045 Payment Methods isolated browser acceptance passed.** Ran the dedicated target on a fresh disposable PostgreSQL 17.11 database after all 28 migrations and reference/application seeds. UI onboarding, create/change/history/audit/activity, display-only, forged tenant/edit and soft-retire checks passed. Fixed retirement-success feedback lost during revalidation and adjusted the browser helper's root redirect wait. Cleanup confirmed zero T989 tenant, method, and user rows; stopped the app/database and removed the temporary cluster. Typecheck, target, browser harness (66/66), IP lint (183 files), and diff check pass. No owner/production data, schema/migration/seed behavior, partner integration, commit or push. §26.62 records results; owner walkthrough/sign-off remains pending; the full-system publish trigger remains. | Agent |
| 0.61 | 2026-10-11 | **B-044 Payment Methods dedicated browser target implemented, not yet run.** Added `npm run smoke:browser:payment-methods` with guarded disposable T989 tenant setup/cleanup and UI coverage for workbench status, create/change/soft-retire, history, display-only access, and forged tenant/edit queries. Typecheck, target-selection browser harness (66/66), IP lint (183 files), smoke target listing, and diff check pass. No live browser/database acceptance or push; B-045 will execute the target on a fresh disposable development DB. §26.61 records the scope. | Agent |
| 0.60 | 2026-10-11 | **B-043 Payment Methods soft-retire confirmation UI.** Added capability-gated retirement for active methods, using the existing session-protected, versioned soft-retire action. Requires explicit acknowledgment and reason; the inactive definition and audit trail remain. No hard delete, new action, schema, seed, or partner integration. Typecheck, production build, IP lint (183 files), browser harness (65/65), and diff check pass. No dedicated Payment Methods database/browser acceptance, commit, or push; B-044 browser acceptance remains. §26.60 records the scope. | Agent |
| 0.59 | 2026-10-11 | **B-042 Payment Methods create/change editor form.** Added capability-gated create/change controls using the existing session-protected save action, immutable method code on change, required reason and expected-version checks, plus success/error feedback. No retire controls, new server action, method data seed, or partner integration. Typecheck, production build, IP lint (182 files), browser harness (65/65), and diff check pass. No dedicated Payment Methods browser/database acceptance, commit, or push; B-043 retire UI and B-044 browser acceptance remain. §26.59 records the scope. | Agent |
| 0.58 | 2026-10-11 | **B-041 Payment Methods read-only workbench route.** Added an authenticated, tenant-scoped country/method list, detail and change-history view; registered the route with the workbench and term registry. Inactive methods remain visible. No editor, new action, seeded method data, or Supplier/Customer integration. Typecheck, IP lint (181 files), browser harness (65/65), and diff check pass. No dedicated database/browser acceptance, commit, or push; B-042 create/change UI, B-043 retire UI, and B-044 browser acceptance remain. §26.58 records the scope. | Agent |
| 0.57 | 2026-10-11 | **B-040 Payment Methods workbench activity/status lifecycle.** Registered `CFG.FIN.PAYMENTMETHOD.DEFINE`; seed adds only missing tenant `NOT_STARTED` statuses and preserves existing progress, while successful create/change/retire and valid no-op confirmations complete the activity in the same transaction. The activity and seed backfill were verified on a fresh disposable PostgreSQL 17.11 cluster; 11 Payment Method service/schema tests and 3 Payment Method action-security tests passed. Typecheck, browser harness (65/65), IP lint (180 files), and diff check pass. No UI, registry entry, payment-method data, or Supplier/Customer integration; no commit or push. §26.57 records the outcome; B-041 read-only configuration UI is next. | Agent |
| 0.56 | 2026-10-11 | **B-039 Payment Methods protected write actions and capability registration.** Added create/change and soft-retire server actions guarded by `CFG.FIN.PAYMENTMETHOD.DEFINE`; tenant and actor are session-derived, forged form values ignored, missing expected version rejected, and success invalidates the Payment Methods/workbench paths. Added the capability catalogue entry and translated success messages without adding method data or a config activity. Action-security tests passed 3/3 for authorised create+retire, capability denial and anonymous redirects on a fresh isolated PostgreSQL 17.11 database; the capability row was verified and fixtures cleaned. Typecheck, browser harness (65/65), IP lint (180 files), and diff check passed. No UI, schema/migration, payment execution, or partner integration. §26.56 records behavior; B-040 status lifecycle followed, with UI still pending. | Agent |

---

*End of document. This file is updated in the same turn as any change to code, schema, decision or
scope — a code change without a corresponding entry here is not complete (§0.1).*
