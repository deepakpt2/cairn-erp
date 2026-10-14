# CAIRN — Project Log & Technical Specification (continued)

**Product:** Cairn — an enterprise resource planning system
**Hostname:** cairn.deepakpt.com
**Document status:** AGREED baseline (2026-10-08 Go) — implementation IN BUILD; screen sign-off remains per §24.1
**Created:** 2026-10-13 (v1.70) · **Part 3 of 3 — this is the live part**
**Continues:** [CAIRN.md](CAIRN.md) (§0–§26.35) · [CAIRN-2.md](CAIRN-2.md) (§26.36–§30 up to v1.69)
**Owner:** Deepak (product owner) · Built with Arena.ai Agent Mode

---

## §0.3 Document-set size and rotation rule `AGREED · v1.70`

**Owner instruction, 2026-10-13 (recorded as R-24 / D-093).**

| Rule | Detail |
|---|---|
| **Hard ceiling** | No part of the canonical log may ever exceed **400 KB (400,000 bytes)**. The 400 KB figure is read conservatively (decimal KB, the smaller interpretation), so either reading of "400kb" is satisfied. |
| **Rotation trigger** | A live part **rotates as soon as it passes 360 KB (360,000 bytes)** — i.e. once it is "becoming closer" to the ceiling, the next numbered file is started rather than waiting for the limit. |
| **New part** | The next part is created as `CAIRN-<n>.md`, continues section numbering and the change-log version sequence without a gap, and is declared the live part. |
| **Continuation notice** | The last part announces that the set continues in the new part; the new part names every earlier part it continues. Both directions are mandatory. |
| **Frozen parts** | A rotated part is frozen: further edits are limited to pointer/continuation lines and corrections that cannot be deferred (each such edit must keep the part under the ceiling). New substantive content is appended only in the live part. |
| **Measurement** | Byte size on disk (`stat -c %s`), checked in the same turn any canonical file is edited. |

**Set status at v1.70 (2026-10-13):**

| Part | Sections | Size at rotation check | State |
|---|---|---|---|
| `CAIRN.md` | §0–§26.35 | 395,959 bytes (99.0 % of ceiling) | **FROZEN** — pointer edits only |
| `CAIRN-2.md` | §26.36–§30 (through v1.69) | 398,255 bytes (99.6 % of ceiling) | **FROZEN** — pointer edits only |
| `CAIRN-3.md` | §0.3, §1.4, §2.1, §26.167+ (next), §30 continued | new — this part | **LIVE** |

**Where new work is recorded from v1.70 onward:** new requirements as §1.4 rows, new decisions as
§2.1 rows, completed batches as §26.167+ section entries (§26.36-style), and change-log versions as
§30 rows continued below. The §0.1 update protocol (same-turn recording, append-never-rewrite,
one ID per decision) remains binding across all parts.

---

## §1.4 Requirements — later clarifications, continued `AGREED · v1.70`

Rows continue the register in `CAIRN.md` §1.1–§1.2. Owner instructions of 2026-10-13.

| ID | Requirement | Interpretation |
|---|---|---|
| R-24 | **Project-log files never exceed 400 KB** | No part of the canonical log may pass 400 KB (400,000 bytes). When a live part passes 360 KB, start the next numbered file, declare it the live part, and state the continuation in both directions. Rotated parts are frozen except pointer/correction edits. Operational detail in §0.3 / D-093. |
| R-25 | **Small increments; never risk the agent interface** | Batches are sized so the agent web interface cannot time out and the working environment cannot run out of memory: one heavy operation at a time (build, browser run or database acceptance), bounded output, and long work split across batches rather than streamed in one. This refines R-22 without weakening its preservation rules. |
| R-26 | **Completion report after every batch** | Every completed batch ends with an explicit report: (a) the **main process** it belongs to, (b) the **current step** inside the approved roadmap (§25.5), (c) the **next step**, and (d) any **data/decisions required from the owner** before that step can proceed. A batch that cannot state all four is not complete. |
| R-27 | **SAP parity: functional and visually familiar** | Functionality follows SAP standard behaviour and field semantics for the equivalent process; the UI must feel familiar to an SAP user (screen flow, field order, grid/logon conventions). It is never exact UI copy: labels, wording, comments, icons and visual identity are Cairn's own (D-034, §19.5 and the trademark lint remain binding). |
| R-28 | **Mobile-ready UI** | Every new or changed page must remain usable on a phone-sized viewport (initially 390 px wide): primary flows readable and operable without page-level horizontal scrolling (wide grids may scroll inside their own container). The §24.1 page cycle gains a mobile check; the detailed acceptance bar is confirmed with the owner at the first mobile-reviewed page. |
| R-29 | **Local environment and secrets** | The repo URL, PAT and database connection string live only in `.env.local`, which is gitignored and verified untracked. If the configured remote database is unreachable from the working environment, use a local database instead and remove the unreachable connection string from `.env.local`. Secrets never appear in the log, commits, test output or UI. |
| R-30 | **SAP transaction-code gate before UI design** | Before any page is designed, the agent presents the SAP transaction code(s) the page corresponds to. The owner then supplies the form-field data to be captured. UI design/implementation starts only after those fields are provided. |
| R-31 | **SCR-021 / OVX3 field and lifecycle contract** | Required `VKORG` Sales Organization and `BUKRS` Company Code fields, each `CHAR 4` (sample `1000`); F4 chooses an existing Sales Organization from enterprise structure (OVX0) and a valid financial Company Code (OX02). One active Company Code is current per Sales Organization. Owner confirmed that another active Company Code may replace the current one with old/new audit history; clear/unassign is outside this activity. |

---

## §2.1 Decision register, continued `AGREED · v1.70`

Rows continue the register in `CAIRN.md` §2 (through D-092).

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D-093 | **Document-set rotation policy.** Ceiling 400,000 bytes per part; rotate when a live part passes 360,000 bytes; new part `CAIRN-<n>.md` continues numbering and version sequence; continuation declared in both directions; rotated parts frozen except pointer edits. §0.3 records the current part sizes. | Owner instruction 2026-10-13. At the check, `CAIRN.md` was 395,959 and `CAIRN-2.md` 398,255 bytes — both effectively at the ceiling — so `CAIRN-3.md` is created now as the live part. | 2026-10-13 |
| D-094 | **Bounded-batch protocol v2 and the completion-report contract.** (1) Batch sizing must protect the agent interface (no plausible timeout, no out-of-memory): one heavy operation at a time, bounded logs, split long work. (2) Every completed batch reports main process / current step / next step / required owner data (R-26). (3) The §24.1 page cycle gains, before design: the SAP tcode presentation and the owner's form-field data (R-30); and, before acceptance: a mobile-viewport check (R-28). (4) §25.4 remains binding for time budgets, preservation and the publish trigger. | Owner instruction 2026-10-13; operationalises R-25, R-26, R-28 and R-30. | 2026-10-13 |
| D-095 | **Environment and secret-handling policy.** Repo URL, PAT and database connection string are kept only in `.env.local` (gitignored, permissions 600); no secret is written to the canonical log, commits, output or UI. Where the remote database is unreachable from the working environment, the local development database is used and the unreachable string is removed from `.env.local` (owner retains it in their own records). **Recorded finding (2026-10-13):** `db.yyskxzdytncsatwjkiva.supabase.co:5432` resolves to IPv6 only from the workspace sandbox and no IPv6 route exists there; general outbound network verified working (GitHub reachable). The Supabase string was therefore removed from `.env.local` per R-29, and the local development database (`127.0.0.1:5432/cairn`, split `cairn`/`cairn_app` roles) is the working target. The PAT remains owner-rotated; it is used only when the owner instructs a push. | Owner instruction 2026-10-13; keeps working credentials out of the repository and unblocks local development. | 2026-10-13 |
| D-096 | **Verified remote test database target (Supavisor session pooler).** The owner-supplied replacement string (`…@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`, login `postgres.<ref>`) is verified working from the workspace sandbox with the project's own postgres.js driver: IPv4 DNS + TCP reachable, login OK, no TLS requirement, server PostgreSQL 17.11, `public` schema empty (no Cairn migrations applied yet), login role NOT superuser but `rolbypassrls=true` with `createrole`/`createdb` — i.e. it satisfies the migration runner's elevated-role check and must never be used as the runtime connection. Consequences: the string is stored in `.env.local` as `CAIRN_TEST_DATABASE_URL` and `MIGRATION_DATABASE_URL`; `DATABASE_URL` stays on the local fallback until a non-elevated application role is provisioned on the test database; migrations/seeds and the role split on the test database are the next database batch and require owner go-ahead because they write to the remote database. This supersedes the local-only interim of D-095 for test purposes (the policy of D-095 itself stands). | Owner instruction 2026-10-13 ("check if this works; if yes add to `.env.local` and use as test database"). Verification evidence recorded in §30 v1.71. | 2026-10-13 |
| D-097 | **The static remote test database is the standing acceptance environment.** Owner instruction 2026-10-13: stop provisioning a disposable database for every acceptance; run DB-backed service acceptance against the owner-supplied static test database (D-096) and add required migrations to it as the schema evolves; use a local database only if the test database is unavailable. DB-backed suites may therefore raise their fixture hook budget through `CAIRN_TEST_HOOK_TIMEOUT_MS` (default remains 30 s, so fast/local databases keep failing fast); suites are run one file at a time to stay inside the agent-interface limits. Note for the browser-acceptance batches: the guarded browser targets currently bind disposable database names/ports (`cairn_b151` … `cairn_b153`) in their own guards, so their configuration needs a reviewed adaptation (or an explicit owner decision) before they can run against the static database. | Owner instruction 2026-10-13; supersedes the per-batch disposable-database practice for service acceptance while keeping D-095's local fallback for unavailability. | 2026-10-13 |
| D-098 | **OVX3 permits audited reassignment, but not clearing, in SCR-021.** An active Sales Organization has one current active Company Code at a time; a different active Company Code may replace it, with the previous and new values recorded as security-relevant change history. Repeating the same pair is idempotent. No clear/unassign operation is provided by this activity. | Owner selected “Allow reassignment” for SCR-021 on 2026-10-14; preserves the one-Company-Code-at-a-time constraint while allowing the OVX3 mapping to be changed. | 2026-10-14 |

---

## §26 · Phase 1 screen inventory — continued

### 26.167 B-154 — Remote test database provisioned (Supavisor session pooler) `COMPLETE · OWNER-SUPPLIED TEST DATABASE · NO CODE CHANGE`

**Scope.** Bring the owner-supplied remote test database to the project's documented development
state — role split, schema, global/reference seeds and the development tenant — and point the local
environment at it, per D-096 and the owner's explicit go-ahead of 2026-10-13.

**Target.** Supavisor session pooler `aws-0-ap-northeast-2.pooler.supabase.com:5432` (IPv4), server
PostgreSQL 17.11; the `public` schema was empty at the start. Login role `postgres.<ref>` is
NOSUPERUSER with BYPASSRLS, so it serves as the elevated migration/seed role
(`MIGRATION_DATABASE_URL`, `CAIRN_TEST_DATABASE_URL`). Nothing was written before the owner's
approval; every prior contact with this database was read-only.

**Role split.** All 50 migrations were applied as the elevated role (`cairn_migration` = 50 files;
rerun skipped all 50 — idempotent). Migration `9000_policies.sql` created `cairn_app` NOSUPERUSER
NOBYPASSRLS NOCREATEDB NOCREATEROLE; its password was then replaced with a generated 32-character
hex value. **Recorded deviation:** the packaged `npm run db:sync-role` helper requires the bare
username `cairn_app`, which the Supavisor pooler cannot address (pooler roles are addressed as
`<role>.<project-ref>`), so the equivalent `ALTER ROLE … PASSWORD` DDL was executed directly; the
helper remains valid for local and self-hosted deployments. Runtime login was verified non-elevated
(`rolsuper=false`, `rolbypassrls=false`), satisfying the `assertApplicationRole` precondition.

**Seeds.** Global definitions: 60 capabilities, 52 configuration activities, 11 message-catalogue
entries, 29 registry terms + 22 aliases. Reference data: 30 countries, 26 currencies, 21 units of
measure.

**Development tenant.** Created through the runtime (non-elevated) connection using the same
`createTenant()` service the UI uses — tenant `0100` "Cairn Development": company code 1000,
administrator `dev.admin`, 10 roles, 10 operational + 1 accounting number range, 52 workbench
steps, package `INTL-STD-2`, 74 G/L accounts, development materials seeded. This exercises the
application path end-to-end on the new database rather than bypassing it.

**Verification.** Migration rerun skipped 50/50; RLS enabled **and FORCED** on tenant tables; the
runtime role sees 0 rows with no tenant setting (fail-closed) and 0 rows under a foreign tenant
setting (isolation), while tenant `0100` reads 10 roles / 11 number ranges / 74 G/L accounts;
`public` holds 79 base tables and exactly one tenant.

**Boundary.** No repository source, schema, migration, seed or service file was changed by this
batch (documentation only; local commit only, nothing pushed — the PAT was not used). No owner data
existed in, or was written to, this database beyond generated reference data and the development
tenant. `.env.local` now carries `DATABASE_URL` = restricted `cairn_app.<ref>` for the test
database, and `MIGRATION_DATABASE_URL` / `CAIRN_TEST_DATABASE_URL` = the elevated connection; the
file remains gitignored (verified) with mode 600, and no secret appears in this log.

**Next.** IP-lint repair (the SCR-020 regression below), then the owed ledger entries and DB-backed
acceptance for SCR-018/019/020 running against this provisioned database.

### 26.168 B-155 — IP-lint vendor-mark repair for the SCR-020 sources `COMPLETE · GATE GREEN · REWORDING ONLY`

**Cause.** The SCR-020 commit (`febccf5`) left 16 reference-vendor trademark occurrences across 15
lines in 10 files — the only failing gate at HEAD (`npm run lint:ip` exit 1). Occurrences: developer
comments in the new sales-organisation service and schema, `session.ts`, `reference.ts`; **one
user-visible i18n label** (`salesOrg.nameLanguageNote`); the browser assertion of that label; the
Term Registry's seeded description for SCR-020; two test titles; and a comment inside migration
`0025`. Lowercase vendor-derived identifiers (`sapLanguageKeyFromPreferences`, `sapLanguageKey`,
the `sapLanguageKey` preference key) also existed; the gate is case-sensitive to the trademarks, but
these conflicted with R-01 ("no proprietary identifiers in the product's own naming") and were
renamed in the same pass.

**Fix (rewording/renaming only; no behaviour change).** The user-visible label became
"Description is saved in your logon language ({language})." with its browser assertion updated. The
preference key is now `logonLanguage` (the reader previously accepted `logonLanguage` as an
alternative, so the acceptance fixture simply writes the canonical key); the resolver function is
`logonLanguageKeyFromPreferences`. Comments were reworded to describe the concept (one-character
logon language; currency key) without naming a vendor or its field/table identifiers. The migration
`0025` comment was reworded to "single-character English language key E".

**Migration integrity.** `0025` is a **comment-only** edit to an already-applied migration, so the
stored checksum was re-registered on the affected database before any further migration run.
Verified on the test database: stored checksum `d7febf21` → `26c1cb86`, then `db:migrate` reported
"50 migration(s) already applied" with no immutability error. **No new migration was added** (the
change carries no DDL). Any other environment that has already applied `0025` must refresh its
stored checksum the same way before its next `db:migrate`; the test database was the only known such
environment and was refreshed in this batch.

**Evidence.** `npm run lint:ip` — 350 files scanned, **0 occurrences** (previously 16). `npm run
typecheck` clean. `npm run test:browser-harness` **230/230** across 45 files. The registry was
re-seeded and the database now contains **0** vendor marks in `term_registry`, `config_activity` and
`message_catalog` descriptions (checked by query); the SCR-020 registry description reads "…Exact
on-prem GUI field parity with the reference product remains under review." `git diff --check` clean;
diff is 10 files, 21 insertions / 21 deletions. Vendor names remain only where the lint exempts
them by content: the Term Registry alias data and `scripts/lint-ip.ts` itself.

**Finding for later batches (not a defect).** DB-backed suites that hard-code a `30_000` ms
`beforeAll` hook (e.g. `tests/sales-org-maintenance.test.ts`) cannot complete against the remote
Supavisor pooler, where tenant creation takes ≈2 minutes; the hook cannot be overridden from the
CLI. Consistent with documented practice, heavy DB/browser acceptance continues on a **disposable
local PostgreSQL 17.11** with only the service/browser assertions targeted, while the remote test
database serves the application runtime, schema and seeds. No stale test tenants remain on the test
database (verified: tenant `0100` only).

**Boundary.** No schema, service, UI-behaviour or seed-content change beyond the renames/rewordings
above; no new migration; no commit/push beyond the local commit containing this entry.

### 26.169 B-156 — SCR-017/019/020 service acceptance on the static test database `PASSED · 15/15 · ONE FIXTURE DEFECT FOUND AND FIXED`

**Scope.** Run the DB-backed service acceptance for the never-accepted SCR-019 and SCR-020
implementations and re-run the touched SCR-017 suite against the owner-supplied static test database,
now the standing acceptance environment (D-097). No migrations were required or added by this batch.

**Enabling change (test infrastructure).** Seven DB-backed suites hard-coded a `30_000` ms `beforeAll`
hook, which the remote pooler cannot satisfy (tenant creation costs ≈60–90 s there; two-tenant
fixtures ≈2–3 min). Each is now `Number(process.env.CAIRN_TEST_HOOK_TIMEOUT_MS ?? 30_000)` — the local
default is unchanged and remote runs set the environment variable. Files: `sales-org-maintenance`,
`purchasing-group-maintenance`, `purchasing-org-maintenance`, `storage-location-maintenance`,
`plant-maintenance`, `plant-company-code-assignment`, `company-code-coa-assignment`. No behavioural
change; DB-free harness and typecheck unaffected.

**Defect found on first execution, fixed (fixture, not product).** On its first-ever run, the SCR-020
suite failed one assertion (`expected undefined to match object { status: 'COMPLETED' … }`). Root
cause: fixture tenants from `tests/helpers.createTenant` do not seed `config_activity_status` rows,
whereas real onboarding seeds one row per activity; the suite's `setActivity()` reset was
UPDATE-only, so it silently changed nothing, the service's (correct) `markActivityComplete` update
also matched no row, and the assertion then found no row at all. The product code was confirmed
correct: `sales-organization-maintenance.ts` completes the workbench activity in the same transaction,
matching the B-040/B-108 convention. The suite was fixed the way its sibling suites already do —
`INSERT … ON CONFLICT DO NOTHING` followed by the reset UPDATE (8 added lines, test-only).

**Results (static test database; `CAIRN_TEST_HOOK_TIMEOUT_MS=600000`, `--testTimeout=300000`):**

| Suite | Screen | Result | Wall clock |
|---|---|---|---|
| `sales-org-maintenance` | SCR-020 | **6/6 pass** | 3 m 09 s |
| `purchasing-group-maintenance` | SCR-019 | **4/4 pass** | 2 m 17 s |
| `purchasing-org-maintenance` | SCR-017 (regression on the new environment) | **5/5 pass** | 2 m 22 s |

**Verification.** After all runs the test database holds only development tenant `0100`, with zero
`T###` company codes and zero `T###` sales organisations (fixture cleanup proved by query);
`lint:ip` clean; `typecheck` clean. Covered behaviours include, per suite: normalisation, tenant
isolation, no-op silence, optimistic-version rejection, retained history, blocked/refused
deactivation paths and activity completion.

**Boundary and what remains.** No product code, schema, migration or seed changed. SCR-018 has no
DB-backed service suite — its runtime acceptance is the guarded browser target. Browser targets for
SCR-018/019/020 remain the outstanding acceptance runs and are separate heavy batches; their guards
currently bind disposable database names/ports (D-097 note), so they need a reviewed adaptation
before they can run against the static database. Nothing pushed.

*Note: from v1.70 this part also carries the batch records for B-151 onward; the §25.4 queue table
in Part 1 is frozen, so these §26 entries are the authoritative record for those batches.*

### 26.170 B-151 — SCR-018 Purchasing Organisation → Company Code assignment `IMPLEMENTED · BROWSER ACCEPTANCE PASSED · STATIC TEST DATABASE`

**Implementation (commit `c842b6a`).** Migration `0023_purchasing_org_company_code_fk.sql` adds the
same-tenant Company Code foreign key to `purchasing_org` with a fail-closed orphan preflight; a null
Company Code stays valid while an organisation is pending (B-142/D-092).
`purchasing-org-company-code-assignment.ts` implements the audited initial assignment: exactly one
active tenant-local Company Code, idempotent retry, no replacement or unassignment, workbench
completion through the shared `markActivityComplete`. Capability `CFG.PROC.PURORG.ASSIGN_COMPANY` is
separate from OX08 definition; the page is `/config/purchasing-orgs/assign-company`. No service suite
exists for this screen by design — its runtime proof is the guarded browser target.

**Acceptance (static test database, one production build).** Target `purchasing-org-company-code`,
reserved fixture **T979**: UI-created tenant has no hidden accounting intervals; OX08 definition
authority does not grant assignment; the exact-capability initial assignment writes one tenant-local
link plus a Company Code audit event; the assignment is read-only after save and visible in the OX08
detail history; the Auditor can review but has no assignment controls. Zero T979 rows remained after
the runner's guarded cleanup.

### 26.171 B-152 — SCR-019 Purchasing Group definition `IMPLEMENTED · SERVICE 4/4 · BROWSER ACCEPTANCE PASSED · STATIC TEST DATABASE`

**Implementation (commit `c842b6a`).** Migration `0024_purchasing_group_definition.sql` refuses to
widen the key rather than truncate or rewrite existing references; standalone contacts, definition
editing and audited deletion with retained history live in `purchasing-group-maintenance.ts` with
`markActivityComplete` on success. Capability `CFG.PROC.PURGROUP.DEFINE`; page `/config/purchasing-groups`.

**Acceptance.** Service suite `purchasing-group-maintenance` **4/4 pass** on the static test database
(§26.169). Browser target `purchasing-groups`, reserved fixture **T978**: UI-created tenant clean; a
new group saves contact fields without organisation assignments and stays visible to existing
purchasing consumers; inline changes append field-level history; unreferenced deletion preserves its
audited history; the Auditor can inspect while a forged mutation is rejected server-side. Zero T978
rows remained.

### 26.172 B-153 — SCR-020 Sales Organization definition `IMPLEMENTED · SERVICE 6/6 · BROWSER ACCEPTANCE PASSED · STATIC TEST DATABASE · ONE PRODUCT DEFECT FIXED (B-157)`

**Implementation (commit `febccf5`).** Migrations `0025_sales_organization_definition.sql` (localized
`sales_org_text`, CAM address link, optional OVX5 fields; Company Code stays nullable and separate),
`0026_sales_org_activity_code.sql` (approved exact code `CFG.ORG.SALESORG.DEFINE`, legacy-code merge,
checklist completion derived from actual rows) and `9022_central_address_sequence_grants.sql`.
`sales-organization-maintenance.ts` implements create/change/soft-deactivate with retained history,
logon-language description text, CAM address maintenance and `markActivityComplete`; page
`/config/sales-orgs`.

**Acceptance.** Service suite `sales-org-maintenance` **6/6 pass** on the static test database after
its fixture defect was fixed (§26.169). Browser target `sales-orgs`, reserved fixture **T977**:
**9/9 checks pass** — create with logon-language text and CAM address persisted while forged
assignment fields are ignored; vendor selection preserving the canonical partner key while detail and
audit show the ten-digit ID; change retaining ADRNR and dependent CAM fields while the
language-dependent description and Form Text are versioned; silent no-op; confirmed soft deactivation
with retained history; dependent Sales Areas blocking deactivation; inactive definitions refusing
change/reactivation; Auditor read-only separation. Zero T977 rows remained. **The first-ever run of
this target found the B-157 product defect below.**

### 26.173 B-157 — Static-database browser acceptance and the SCR-020 dialog defect `COMPLETE · PRODUCT DEFECT FIXED · ALL THREE TARGETS PASSED`

**Owner instruction applied (D-097):** browser acceptance runs against the owner-supplied static test
database instead of a per-batch disposable cluster, with a local database only as fallback.

**Harness adaptation (reviewed; no secrets in the repository).** `CAIRN_BROWSER_DB_MODE=static` selects
static mode for an explicit allowlist of three targets (`STATIC_ACCEPTANCE_TARGETS`); the binding is
derived from `CAIRN_TEST_DATABASE_URL` (host, port, database, role convention `cairn_app.<ref>` /
`postgres.<ref>`, extra connection parameters rejected), and the verifier asserts at connection time
that both roles reach the same database, the runtime role is not elevated, the migration role is
elevated, the server is PostgreSQL 17 and the schema is provisioned (≥50 recorded migrations).
Fixture safety is unchanged in both modes: only the reserved key carrying the exact fixture name and
the development flag may be deleted, and a foreign tenant on a reserved key aborts the run entirely.
Timeouts keep their contract defaults but may be raised (never lowered) through
`CAIRN_BROWSER_RUN_TIMEOUT_MS`, `CAIRN_BROWSER_NAV_TIMEOUT_MS` and `CAIRN_BROWSER_PAGE_TIMEOUT_MS`;
seven new contract test cases were added (harness 235/235). The application ran as a production build
(`npm run build` + `npm start`) because the sandbox development server did not survive the long
remote-database runs.

**Product defect found by the SCR-020 target (first ever execution).** The Central Address dialog
wrapper combined the HTML `hidden` attribute with the `flex` utility class. Author `display:flex`
overrides the browser's `[hidden] { display: none }`, so the *closed* full-screen overlay stayed
rendered on top of the form and swallowed every pointer click — Playwright reported
`<div hidden="" … class="fixed inset-0 z-50 flex …"> intercepts pointer events` on the first
coordinate-based interaction, making the page effectively unclickable outside its fields. **Fix:** the
wrapper now uses a conditional display class (`… : 'hidden'`) with `aria-hidden` mirrored, so a closed
dialog is truly `display:none` while its inputs stay mounted — closing must not discard a captured
address (conditional unmounting was tried first and rejected for exactly that reason: the address
number stopped persisting). A repository-wide guard test
(`tests/hidden-attribute-display-contract.test.ts`) now fails the suite if any `.tsx` combines
`hidden={…}` with a display utility, and the SCR-020 UI contract pins the corrected pattern.

**Acceptance-script defects fixed in the same batch (all in never-executed paths).** (1) The dialog
offers a header and a footer close with the same accessible name; the script now selects one
deterministically. (2) Four assertions in the change/deactivate deep-equals used `search_term1` while
the live column is `search_term_1` (the passing create-flow assertions confirmed the correct key).
(3) The fixture hook and the page/navigation budgets became env-overridable as recorded above.

**Evidence.** All three targets ran against the static test database on the same production build:
**SCR-018 pass · SCR-019 pass · SCR-020 9/9 checks**; service suites on the same database 15/15
(§26.169); `lint:ip` clean (350 files); `typecheck` clean; harness **235/235**; the test database was
left with only development tenant `0100` (no `T###` tenants, sales organisations or purchasing
groups). Published to `main` on owner instruction.

**Boundary.** One product file changed (`src/app/config/sales-orgs/SalesOrgDefinitionForm.tsx`) plus
harness, contract tests and this ledger. No schema, migration, seed, capability or service change; no
owner data touched.

*Still owed: owner walkthrough/sign-off for the screens recorded above, and the remaining roadmap
(SCR-021 onward). The next UI step waits for the SAP transaction codes and the owner's field list
(R-30).*


### 26.174 B-158 — SCR-021 OVX3 Sales Organization → Company Code assignment `IMPLEMENTED · SERVICE 7/7 · BROWSER ACCEPTANCE PASSED · STATIC TEST DATABASE`

**Owner input and lifecycle decision (R-31 / D-098).** The owner confirmed OVX3 and supplied the two required `CHAR 4` fields: Sales Organization (`VKORG`, F4 from configured Sales Organizations / OVX0) and Company Code (`BUKRS`, F4 from valid financial Company Codes / OX02), sample `1000`. After implementation began, the owner explicitly selected audited reassignment: one current Company Code per Sales Organization; changing to another active code is allowed and records old/new values; clearing/unassignment is not part of SCR-021. Owner walkthroughs were deferred.

**Implementation.** The existing `sales_org.company_code` column and same-tenant FK already provided the single-current-assignment storage, so no table/schema change was required. New `sales-org-company-code-assignment.ts` enforces the exact four-character uppercase keys, both completed definition prerequisites, active same-tenant Sales Organization and Company Code, and serializes choices with an advisory lock plus row lock. Same-pair retry is idempotent; initial assignment and replacement are audited as security-relevant `companyCode` changes; the update predicate compares the prior value, so concurrent edits cannot produce multiple current mappings. The screen/action at `/config/sales-orgs/assign-company` uses the exact capability `CFG.ORG.SALESORG.ASSIGN_COMPANY`, derives tenant and actor from the verified session, and offers both click and keyboard F4 search. The Sales Organization F4 lists configured rows, with inactive ones disabled and current assignments shown; Company Code F4 lists active tenant-local four-character codes only. The Sales Organization overview links to the separate assignment activity for authorized users. No clear/unassign control is present.

**Activity migration and seed.** Migration `0027_sales_org_assign_activity_code.sql` replaces the earlier placeholder `CFG.SALES.SALESORG.ASSIGN_COMPANY` with the approved `CFG.ORG.SALESORG.ASSIGN_COMPANY`, merges checklist state, derives completion from actual assignment rows, repairs prerequisite references, and adds the route. Seed data registers the non-posting Sales configure capability, route and owner-confirmed searchable alias `OVX3`; existing-tenant checklist backfill derives status from actual `sales_org.company_code` values. Onboarding marks the approved activity, and the downstream customer-sales-area remedy now points to the approved code. Applied migration count: **51**; the legacy placeholder has zero rows and the `OVX3` alias is present once.

**Acceptance.** Service suite `sales-org-company-code-assignment` **7/7 passed** on the static test database: strict key length, initial assignment and security-relevant history, idempotent retry, audited replacement, missing/inactive/cross-tenant rejection, both prerequisite gates, inactive Sales Organization rejection, and serialized concurrent choices with one current Company Code. Browser target `sales-org-company-code`, reserved fixture **T976**, passed on a production build against the same static database: exact-capability separation from the definition-only user; both F4 paths and the five-character exclusion; initial assignment with forged tenant/actor values ignored; same-pair idempotence; replacement from `1000` to `2000` with old/new audit history; Auditor read-only access; and a 390-pixel viewport with no page-level horizontal overflow. The first mobile run exposed overflow in the shared command/status bars; both now wrap on phone widths. A stale translation key found in that run was corrected. The development build marker now identifies SCR-021.

**Verification and boundary.** `npm run build` passed; `typecheck` clean; `lint:ip` clean (358 files); browser harness **247/247 across 47 files**; `git diff --check` clean. After guarded browser cleanup, the test database contains only development tenant `0100` (zero `T###` fixtures). No owner data was accessed or changed. Product code, migration, seed, UI, tests, browser target and this ledger were committed and pushed to `main` after browser acceptance, per the owner instruction.

**Next.** SCR-021 is complete. SCR-022 is next in M1b. Per R-30, its SAP transaction code(s) will be presented and verified before design; the owner’s form-field list will then be required. The three owner walkthroughs remain deferred by owner direction.
---

## §30 · Change log (continued)

Continues the change log of `CAIRN-2.md` §30 from version 1.69. Same rules: append only, one row per
recorded change, date and reason stated.

| Version | Date | Change | By |
|---|---|---|---|
| 1.70 | 2026-10-13 | **Document set rotated to a third part and the 2026-10-13 owner instructions registered.** Owner instructions recorded as R-24–R-30 and D-093–D-095: (1) canonical log parts never exceed 400 KB and rotate at 360 KB into the next numbered file with a continuation notice in both directions (§0.3); (2) increments stay small enough to protect the agent web interface from timeouts/out-of-memory (R-25); (3) every completed batch reports main process, current step, next step and required owner data (R-26/D-094); (4) strict SAP functional parity and visual familiarity without copying UI text (R-27); (5) mobile-ready UI at phone width with a new page-cycle check (R-28); (6) repo URL, PAT and DB string live only in the gitignored `.env.local`, and an unreachable remote DB is replaced by a local database and removed from `.env.local` (R-29/D-095); (7) before any UI page is designed, the SAP tcode(s) for the page are presented and the owner supplies the form fields (R-30). **Rotation executed:** at check, `CAIRN.md` was 395,959 bytes and `CAIRN-2.md` 398,255 bytes (both ≈99 % of the ceiling), so both are frozen with pointer-only edits and this file becomes the live part; §0.3 records the sizes. **Environment:** `.env.local` created at repo root (mode 600, verified untracked via `git check-ignore`), holding the repo URL, the owner's temporary PAT and local development connection strings; the Supabase string was removed because `db.yyskxzdytncsatwjkiva.supabase.co` resolves IPv6-only and the sandbox has no IPv6 route (general outbound network verified against GitHub). Local PostgreSQL 17.11 is available for provisioning (matches the documented disposable-acceptance environment). **Pending, not part of this entry:** the ledger entries for the already-pushed SCR-018/SCR-019/SCR-020 batches (B-151–B-153) and the IP-lint regression introduced by the SCR-020 commit (`febccf5`, 16 trademark occurrences; `npm run lint:ip` fails) — both are the next batches. No code, database, migration or seed change in this entry; documentation and local environment files only; no commit or push. | Agent |
| 1.71 | 2026-10-13 | **Owner-supplied replacement test-database string verified and adopted (D-096).** The new string uses the Supavisor session pooler (`aws-0-ap-northeast-2.pooler.supabase.com:5432`, login `postgres.<ref>`) and works from the workspace sandbox: IPv4 resolution (the earlier direct host is IPv6-only), TCP reachable, login OK, no TLS requirement, PostgreSQL 17.11, `createrole`/`createdb` present, `rolbypassrls=true` (qualifies as the migration runner's elevated role), and the `public` schema empty — no Cairn migration has ever been applied there and no project roles exist yet. The string is now stored in `.env.local` as `CAIRN_TEST_DATABASE_URL` and `MIGRATION_DATABASE_URL` (mode 600, verified untracked); `DATABASE_URL` deliberately remains the local fallback because the application connection must be NOSUPERUSER/NOBYPASSRLS and the test database has no such role yet. No write of any kind was performed against the test database — all checks were read-only (`select`); migrations, seeds and the role split there are the next database batch and require owner go-ahead. No code, schema, migration or seed change; documentation and local environment files only; no commit or push of this entry beyond the local docs commit. | Agent |
| 1.72 | 2026-10-13 | **Owner-supplied test database provisioned and adopted as the working target (B-154, §26.167).** Applied all 50 migrations as the elevated Supavisor-session connection (rerun skipped 50 — idempotent); migration 9000 created the `cairn_app` runtime role (NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE) whose password was then replaced with a generated value — the packaged `db:sync-role` helper cannot address pooler usernames (`<role>.<project-ref>`), so the equivalent ALTER ROLE DDL was run directly and the deviation is recorded. Seeded global definitions (60 capabilities, 52 activities, 11 messages, 29 terms + 22 aliases) and reference data (30 countries, 26 currencies, 21 units), then created development tenant `0100` through the runtime connection using the same `createTenant()` service as the UI (company code 1000, `dev.admin`, 10 roles, 11 number ranges, 52 workbench steps, INTL-STD-2, 74 G/L accounts). Verified fail-closed RLS (0 rows without a tenant setting), cross-tenant isolation (0 rows), RLS enabled+FORCED, and a non-elevated runtime role. `.env.local` now points `DATABASE_URL` at the restricted `cairn_app.<ref>` connection and keeps the elevated connection in `MIGRATION_DATABASE_URL`/`CAIRN_TEST_DATABASE_URL`; the file is gitignored (verified) and mode 600. No code, schema, migration or seed change; no owner data; nothing pushed. Still owed: the IP-lint repair and the SCR-018/019/020 ledger entries plus their DB-backed acceptance. | Agent |
| 1.73 | 2026-10-13 | **IP-lint gate repaired for the SCR-020 sources (B-155, §26.168).** Removed all 16 reference-vendor trademark occurrences (10 files, 21/21 lines; comments, one user-visible i18n label and its browser assertion, the seeded SCR-020 registry description, two test titles, migration 0025's comment) and renamed the lowercase vendor-derived identifiers to `logonLanguageKeyFromPreferences` / `logonLanguage`. Comment-only edit to the applied migration 0025 was accompanied by re-registering its stored checksum on the test database (`d7febf21` → `26c1cb86`), after which `db:migrate` reported 50 already applied with no immutability error; no new migration was added. Verified: `lint:ip` 0/350 files, typecheck clean, browser harness 230/230, registry re-seeded with zero vendor marks in browsable seeded data, `git diff --check` clean, no stale test tenants on the test database. Recorded finding: suites with hard-coded 30 s `beforeAll` hooks cannot run against the remote pooler (≈2 min tenant creation); heavy acceptance stays on disposable local PostgreSQL 17.11. Nothing pushed. | Agent |
| 1.74 | 2026-10-13 | **SCR-017/019/020 service acceptance passed on the static test database; one fixture defect found and fixed (B-156, §26.169; D-097).** Seven DB-backed suites had hard-coded 30 s fixture hooks that the remote pooler cannot satisfy; the hook budget is now env-overridable (`CAIRN_TEST_HOOK_TIMEOUT_MS`, local default unchanged). The SCR-020 suite, run for the first time ever, failed one assertion because fixture tenants carry no `config_activity_status` rows and its UPDATE-only reset (and therefore the correct service completion update) silently matched nothing; fixed the fixture the sibling suites' way (insert-then-update, 8 lines, test-only). Results on the static database: SCR-020 6/6, SCR-019 4/4, SCR-017 5/5 — 15/15, with zero leftover fixture rows, `lint:ip` and `typecheck` clean. No migration, product code, schema or seed change. Browser targets for SCR-018/019/020 remain, pending a reviewed guard adaptation for the static database. Nothing pushed. | Agent |
| 1.75 | 2026-10-13 | **SCR-018/019/020 implemented, accepted and published; the SCR-020 dialog defect found by browser acceptance was fixed (B-151–B-153, B-157; §§26.170–26.173).** Browser acceptance now runs on the owner-supplied static test database (D-097) through a reviewed static mode derived from `CAIRN_TEST_DATABASE_URL` with an explicit three-target allowlist, unchanged fixture-ownership guards and raise-only timeout overrides; the app ran as a production build for stability. The first-ever `sales-orgs` run found a real product defect: the Central Address dialog combined the HTML `hidden` attribute with the `flex` utility class, so the closed overlay stayed `display:flex` and intercepted every pointer event — fixed with a conditional display class (inputs stay mounted so a captured address still submits) and guarded repository-wide by a new test. Two acceptance-script defects were fixed in the same pass (ambiguous close-button selector; `search_term_1` key typos in the change/deactivate assertions). Results: SCR-018 pass, SCR-019 pass, SCR-020 9/9 checks on the static database against one build; service suites 15/15; lint, typecheck and harness 235/235 clean; the test database left with only development tenant `0100`. Product change limited to one file; no schema, migration or seed change. Published to `main` on owner instruction. | Agent |
| 1.76 | 2026-10-14 | **SCR-021 OVX3 Sales Organization → Company Code assignment completed, accepted and published (B-158, §26.174; R-31/D-098).** The owner supplied required `VKORG` / `BUKRS` Char 4 fields and confirmed that reassignment to another active Company Code is permitted with old/new audit history (no unassignment); walkthroughs deferred. Adds the exact-capability assignment service and mobile-ready F4 screen, migrates the placeholder activity code to `CFG.ORG.SALESORG.ASSIGN_COMPANY`, updates seed/registry (`OVX3`), and adds DB/browser acceptance. Service suite 7/7; static-DB browser target passed, including F4, idempotence, audited reassignment, capability separation, Auditor display-only and 390px no-overflow checks. Build/typecheck/lint clean; harness 247/247; test DB left with tenant `0100` only. | Agent |

---

*End of this part for now. This part is the live canonical log: it is updated in the same turn as any
change to code, schema, decision or scope (§0.1). When it passes 360,000 bytes, the next part
`CAIRN-4.md` begins and this file states that the set continues there (§0.3 / D-093).*
