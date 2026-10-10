# CAIRN — Project Log & Technical Specification

**Product:** Cairn — an enterprise resource planning system
**Hostname:** cairn.deepakpt.com
**Document status:** AGREED baseline (2026-10-08 Go) — implementation IN BUILD; screen sign-off remains per §24.1
**Created:** 2026-10-08 · **Last updated:** 2026-10-10 (v0.17 — deployment-owner tenant provisioning security)
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

### 7.3 Standard Configuration Package (`INTL-STD-1`)

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
| Vendor (general) | `business_partner` + general company data | Name, addresses, tax numbers, bank details, contact persons |
| Vendor (company code) | `vendor_company_code` | Reconciliation account, payment terms, payment methods, dunning procedure, cash discount, tolerance group |
| Vendor (purchasing org) | `vendor_purchasing_org` | Order currency, incoterms, purchasing group, partner functions |
| Customer (general) | `business_partner` | Name, addresses, tax numbers, payment behaviour |
| Customer (company code) | `customer_company_code` | Reconciliation account, payment terms, dunning procedure, interest indicator, tolerance group |
| Customer (sales area) | `customer_sales_area` | Sales district, delivering plant, pricing procedure, complete delivery flag, order combination |

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
| Field-level control | Sensitive fields restricted by role: vendor bank details, payment terms, pricing conditions, standard prices |
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
from `INTL-STD-1` (§7.3) activated into a throwaway schema. Deterministic, reproducible, and it
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

| Batch | One outcome | Implementation budget | State |
|---|---|---|---|
| B-000 | Preserve the current database/source and record this smaller execution plan | ≤5 min | **DONE — this checkpoint; no feature/database mutation** |
| B-001 | Split the existing browser acceptance script into independently runnable targets | ≤10 min | **DONE — 23 pure harness tests and foundation browser target passed; no ERP feature/schema change** |
| B-002 | Publish/verify the already-written material **Basic data** view, including staged saves | ≤10 min | **DONE — production preview rebuilt; staged/basic/copy/history browser flow passed; one form-reset defect fixed** |
| B-003 | Verify the existing material **Purchasing** view and its plant/unit/tolerance rules | ≤10 min | **NEXT — purchasing only** |
| B-004 | Verify the existing material **MRP settings** view and net-change flag | ≤10 min | Pending; no executable planning run in this batch |
| B-005 | Verify the existing material **Valuation** view and financial read/write boundaries | ≤10 min | Pending; stock/value remain read-only |
| B-006 | Payment terms: one lookup/schema/defaults service slice | ≤10 min | Pending; prerequisite for partner company segments |
| B-007 | Payment terms: one maintenance page and focused tests | ≤10 min | Pending; backend already available from B-006 |
| B-008 | Business partner **general data backend** only | ≤10 min | Pending; no company/purchasing/sales segments |
| B-009 | Business partner **general data UI** only | ≤10 min | Pending |
| B-010 | Supplier **company-code segment backend** only | ≤10 min | Pending |
| B-011 | Supplier **company-code segment UI** only | ≤10 min | Pending |
| B-012 | Supplier **purchasing-organisation segment backend** only | ≤10 min | Pending |
| B-013 | Supplier **purchasing-organisation segment UI** only | ≤10 min | Pending |

All remaining work (customer segments, cost centres, work centres, BOM, routing, configuration,
imports, P2P, production/MRP execution, O2C, banking, closing, audit and deployment) follows the same
backend/view/rule-sized pattern. These are not single large future batches. Resolve their dependencies
and declare a ≤10-minute implementation target at each batch start. Do not drop the standing scope
requirements to meet the time budget; preserve partial work and continue in the next bounded batch.

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
| SCR-035 | Payment terms | `CFG.FIN.PAYTERMS.DEFINE` | OBB8 | DRAFT |
| SCR-036 | Payment methods | `CFG.FIN.PAYMENTMETHOD.DEFINE` | FBZP | DRAFT |
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
| SCR-048 | Material create and change | `INV.MATERIAL.CREATE` | MM01 / MM02 / MM03 | **IN BUILD — Basic Data published/UI verified; Purchasing/MRP/Valuation walkthroughs and owner sign-off pending** |
| SCR-049 | Business partner create and change | `FND.PARTNER.CREATE` | BP / XK01 / XD01 | DRAFT |
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

---

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

---

*End of document. This file is updated in the same turn as any change to code, schema, decision or
scope — a code change without a corresponding entry here is not complete (§0.1).*
