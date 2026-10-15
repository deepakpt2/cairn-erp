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
| R-32 | **Application-native names for SCR-021 fields** | Do not use the source-system field identifiers directly in Cairn's UI or application/runtime source. User-facing fields are named `Sales Organization` and `Company Code`; code uses Cairn-native `salesOrg` and `companyCode`. Source field codes remain only in requirement/traceability records and regression checks. |
| R-33 | **Owner-supplied SCR-022 / OVXI and OVXB fields** | Distribution Channel (traceability field `VTWEG`): required, two-character alphanumeric unique key; Name (`VTEXT`): required, up to 20 characters. Division (`SPART`): required, two-character alphanumeric unique key; Name (`VTEXT`): required, up to 20 characters. Owner supplied examples `10`/`WH`, `Wholesale`, `00`/`BI`, and `Bicycles`. Application-facing terms/identifiers remain Cairn-native. |
| R-34 | **Owner-directed staged UI delivery** | Before each UI page is designed, present its SAP transaction code/form and wait for the owner-supplied field and behavior details. Deliver each page through separate bounded batches in this order: database/schema design (and migration if needed), backend business functions, supporting/helper functions, UI, then tests/acceptance. Do not bundle the complete sequence into one batch. After tests pass, report the outcome and request the next UI transaction's form details. |
| R-35 | **Publish tested UI work and prioritize unfinished-T-code dependencies** | After each UI acceptance test passes, commit and push the tested batch to `origin/main` using the owner-provided PAT without exposing or committing credentials. If the current page needs data from an unfinished T-code form, pause it; present and gather details for the supporting T-code(s), complete and test those first, then resume the paused page. Do not fabricate dependent data or skip prerequisites. |
| R-36 | **Owner-supplied OVXK fields and value help** | Sales Organization: required, `CHAR 4`, sample `1000`; F4 selects an existing Sales Organization created via OVX5. Distribution Channel: required, `CHAR 2`, sample `10`; F4 selects an existing Distribution Channel defined via OVXI. Source-system identifiers are traceability only; Cairn application labels/names remain native. |
| R-37 | **Owner-supplied OVXA fields and value help** | Sales Organization: required, `CHAR 4`, sample `1000`; F4 selects an existing Sales Organization created via OVX5. Division: required, `CHAR 2`, sample `00`; F4 selects an existing Division defined via OVXB. Cairn application labels/names remain native. |
| R-38 | **Owner-supplied SCR-024 / OKKP form fields** | Required Controlling Area key (`CHAR 4`, alphanumeric), Name (required, 30), Assignment Control (required; single-company vs cross-company assignment semantics), Currency Key (required; sample USD/EUR), and Fiscal Year Variant (required, `CHAR 2`, F4 from existing definitions); optional organizational name (30). Exact Assignment Control choices/cardinality, currency-key width, lifecycle and value-help filters remain owner-confirmation gates; do not infer them. |
| R-39 | **SCR-024 / OKKP controlling-area maintenance decisions** | Assignment Control has “Same Company Code” (at most one assigned Company Code) and “Multiple Company Codes” (several allowed); default/backfill is derived from current assignment count, with new/default `A000` single-company and audited scope changes refused back to single while multiple assignments exist. Currency is a required three-character key with active-currency value help. Fiscal Year Variant is two characters and F4 includes all existing definitions, including inactive. Normalize and freeze the Controlling Area key; audit changes to both names; no deactivate/reactivate flow. See D-106–D-110. |
| R-40 | **Pre-test publication; UI tests deferred** | Owner directs that implementation changes be pushed without waiting for UI tests; UI tests are deferred until later. This applies to future process, and untested work must not be described as accepted (D-111). |
| R-41 | **SCR-024 Assignment Control form and scope semantics** | Show “Controlling area same as company code (1:1 Relationship)” for exactly one Company Code and “Cross-company-code cost accounting (1:N Relationship)” for multiple Company Codes. In cross-company mode, all assigned Company Codes must share the same Operational Chart of Accounts and Fiscal Year Variant. Currency and Fiscal Year Variant become read-only after any actual operational transaction for an assigned Company Code; both remain editable before then. Duplicate creation is an idempotent no-op. See D-112–D-114. |
| R-42 | **SCR-024 Assignment Control copy** | Preserve the owner-provided heading, control description, option descriptions, and scope help text verbatim in the OKKP UI; do not paraphrase or substitute copy. The full copy is recorded in D-115. |
| R-43 | **UI-first staged delivery order** | For future T-code pages, deliver separate bounded stages in this order: (1) UI, (2) DB/schema, (3) backend business functions, (4) supporting functions, (5) tests/acceptance. This supersedes the stage sequence in R-34 only. The pre-UI T-code/form and owner-field intake gate, no-bundling rule, implementation publication before UI tests (R-40), no acceptance claim before tests pass, and post-test report/request for the next UI T-code remain in force. |
| R-44 | **SCR-025 / OX19 owner-supplied fields and compatibility prerequisites** | Required Controlling Area lookup (traceability `KOKRS`): Char 4 alphanumeric; F4 from previously created Controlling Areas in OKKP. Required Company Code lookup (traceability `BUKRS`): Char 4 alphanumeric; F4 from legal Company Codes in OX02. Both records must exist. For every assignment, the Company Code and Controlling Area must use the exact same Operational Chart of Accounts and the exact same Fiscal Year Variant, in either 1:1 or 1:N scope. For multiple Company Codes assigned to one Controlling Area, their currency setups must align with the Controlling Area's currency-type rules. Exact currency validation, reverse cardinality, assignment lifecycle/audit, value-help eligibility and authorization remain pending; do not infer them. |
| R-45 | **SCR-025 / OX19 owner-selected assignment rules** | Allow add, unassign and reassignment; duplicate assignments are no-ops and actual changes retain the old/new Controlling Area–Company Code relationships in history. Enforce OKKP scope: Same Company Code permits at most one Company Code per Controlling Area; Multiple Company Codes permits several; each Company Code belongs to at most one Controlling Area. F4 includes all existing tenant-local Controlling Areas and Company Codes. For the multi-company currency rule, require the Company Code local-currency key to equal the Controlling Area Currency Key. Reuse existing Controlling Area and Company Code master-data permissions; AND/OR composition, unassignment storage semantics, duplicate-attempt audit behavior, and whether currency equality also applies to 1:1 remain pending confirmation. |
| R-46 | **SCR-025 / OX19 remaining assignment rules** | Duplicate assignments leave current state unchanged but create an audit/history event. Reassignment is performed as two separate operations: unassign, then assign to the other Controlling Area. Company Code local currency must equal the Controlling Area Currency Key for both 1:1 and 1:N assignments. Both existing Controlling Area and Company Code master-data permissions are required. The active-row representation after unassignment remains pending; see B-200. |
| R-47 | **SCR-025 / OX19 unassignment representation** | Unassignment removes the relationship from the current assignments; the assignment/unassignment history remains available through immutable audit events. Reassignment remains two separate operations: unassign first, then assign to the other Controlling Area. |

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
| D-099 | **SCR-022 includes separate OVXI Distribution Channel and OVXB Division definition pages.** Each page has its own exact configure capability and tenant-local definition activity. Each key is unique, two-character alphanumeric, normalized uppercase and immutable after creation; its required name is limited to 20 characters. Create, name-only change, copy as a new entry, and audited soft deactivation are allowed; deactivation is refused while any Sales Area refers to the entry. No hard delete or reactivation. Assignment and Sales Area setup remain separate scope. | Owner approved the proposed page contract on 2026-10-14; keeps master definitions separate from sales-area assignments and preserves referenced records. | 2026-10-14 |
| D-100 | **Owner-controlled, staged UI delivery.** For every UI page, present the SAP transaction code/form and obtain the owner's field and behavior details before design. Complete database/schema work first, followed in separate bounded batches by backend business functions, supporting functions, UI, and tests/acceptance. After tests pass, state the result and request details for the next UI transaction. | Owner instruction of 2026-10-14; prevents unspecified fields from being inferred and keeps each implementation stage reviewable. | 2026-10-14 |
| D-101 | **Publish after passing UI tests and schedule unfinished-T-code prerequisites first.** Commit and push each UI batch after its acceptance test passes. If its required data comes from an unfinished T-code form, suspend the current page, complete the supporting T-code page(s) first, then resume the original page. | Owner instruction of 2026-10-14; keeps published UI work tested and avoids implementing against unfinished prerequisites. | 2026-10-14 |
| D-102 | **OVXK assignment semantics.** Sales Organizations and Distribution Channels form a tenant-local many-to-many mapping; the `(client, sales_org, distribution_channel)` pair is unique. Repeating an existing pair is an idempotent no-op. F4 selects active definitions only. A mapping may be removed only when no Sales Area references the pair; removal must retain change-document history. | Owner selections for OVXK on 2026-10-14; defines the assignment lifecycle and lookup behavior. | 2026-10-14 |
| D-103 | **OVXK-only publication before browser acceptance.** The owner directs that OVXK browser testing remain deferred until renewed approval, but explicitly authorizes pushing the current implementation now. This is a one-time exception for OVXK; R-35/D-101 remain in effect for subsequent UI work. | Owner instruction on 2026-10-14. Preserves the owner's test gate while following their explicit push instruction. | 2026-10-14 |
| D-104 | **OVXA assignment lifecycle.** Sales Organization ↔ Division is many-to-many; duplicate assignment is an idempotent no-op. F4 and assignment accept active definitions only, and both Sales Organization and Division definition activities must be complete. An unused pair may be hard-removed with change history retained; removal is blocked while any Sales Area uses the Sales Organization/Division pair, regardless of Distribution Channel. | Owner selections for OVXA on 2026-10-14; sets the relation and dependency semantics for its DB/backend stages. | 2026-10-14 |
| D-105 | **OVXG Sales Area contract.** Required VKORG (`CHAR 4`), VTWEG (`CHAR 2`) and SPART (`CHAR 2`) plus required Name (max 160). Value help includes existing definitions (including inactive ones), with VTWEG constrained by the selected Sales Organization's OVXK mapping and SPART by its OVXA mapping. Create and name-only change; key tuple is immutable; duplicate creation is an idempotent no-op. Soft deactivation retains the row/history, is blocked while any customer Sales Area refers to it, and reactivation is allowed. | Owner selections on 2026-10-14; defines OVXG storage and lifecycle before backend/UI work. | 2026-10-14 |
| D-106 | **Controlling Area assignment-scope choices and edit guard.** “Same Company Code” permits at most one Company Code assignment; “Multiple Company Codes” permits several. New/default `A000` uses the single-company choice; changes are audited, and a switch back to single is refused while more than one Company Code is assigned. | Owner selections for SCR-024 / OKKP on 2026-10-14; preserves explicit control of cross-company scope. | 2026-10-14 |
| D-107 | **Controlling Area currency contract.** Use a three-character currency key and offer active entries from the global currency catalogue in value help. | Owner selection for SCR-024 / OKKP on 2026-10-14. | 2026-10-14 |
| D-108 | **Fiscal Year Variant selection.** Use a two-character key; value help includes all existing tenant definitions, including inactive ones. | Owner selection for SCR-024 / OKKP on 2026-10-14. | 2026-10-14 |
| D-109 | **Controlling Area maintenance lifecycle.** Normalize the key to uppercase and make it immutable after creation; both Name fields may be changed with audit history; no deactivation or reactivation control is provided. | Owner selection for SCR-024 / OKKP on 2026-10-14. | 2026-10-14 |
| D-110 | **Backfill of required assignment scope.** For each existing Controlling Area, zero or one current Company Code assignment maps to “Same Company Code”; two or more map to “Multiple Company Codes”. | Owner selection for SCR-024 / OKKP on 2026-10-14. | 2026-10-14 |
| D-111 | **Pre-test publication and deferred UI testing.** The owner directs that requested implementation changes be pushed without waiting for UI tests; UI tests are deferred until later. This applies to future process. Do not claim acceptance for untested work. This supersedes the earlier push-after-acceptance timing in R-35/D-101 while leaving the other staged-delivery and safety requirements in force. | Owner instruction on 2026-10-14, clarified as standing process. | 2026-10-14 |
| D-112 | **SCR-024 Assignment Control options and cross-company prerequisite.** Use the two owner-provided choices: “Controlling area same as company code (1:1 Relationship)” (one Company Code per Controlling Area) and “Cross-company-code cost accounting (1:N Relationship)” (one Controlling Area may span multiple Company Codes). Cross-company assignments must share the same Operational Chart of Accounts and Fiscal Year Variant. The Company Code assignment activity remains separate under OX19. | Owner clarification on 2026-10-14; exact dropdown wording and cross-company compatibility gate. | 2026-10-14 |
| D-113 | **Financial field lock after actual activity.** Currency Key and Fiscal Year Variant remain editable before activity; both become read-only once any actual operational document exists for any Company Code assigned to the Controlling Area. The backend must enforce this as well as the UI, and posting/document paths must serialize with configuration changes. | Owner selection on 2026-10-14. | 2026-10-14 |
| D-114 | **Duplicate SCR-024 creation.** Repeating a Controlling Area key is an idempotent no-op: do not change values or write a change-history event; report that the key already exists. | Owner selection on 2026-10-14. | 2026-10-14 |
| D-115 | **Verbatim SCR-024 Assignment Control UI copy.** Heading: “Description of Controlling Area’s Purpose”. Control description: “Controls the relationship between Controlling Area and Company Code”. Option 1: “Controlling area same as company code (1:1 Relationship)” with “This maps Controlling Area to a single Company Code in a strict 1:1 relationship, where only one Company Code may be assigned to the Controlling Area.” Option 2: “Cross-company-code cost accounting (1:N Relationship)” with “This enables one Controlling Area to be assigned to multiple Company Codes, allowing cost accounting to be performed across all assigned Company Codes.” General help: “The scope controls whether a Controlling Area can be assigned to one or multiple Company Codes in the system.” Then “1:1 Relationship: Exactly one Company Code must be assigned to the Controlling Area.”; “1:N Relationship: One Controlling Area can be assigned to multiple Company Codes.”; and “This will determine whether cost accounting for a Controlling Area is restricted to a single Company Code or includes all cross-company costs.” Preserve the copy and punctuation verbatim in the UI. | Owner-supplied wording in the 2026-10-14 clarification. | 2026-10-14 |
| D-116 | **UI-first stage order.** Deliver each future T-code page in separate stages: UI → DB/schema → backend functions → supporting functions → tests/acceptance. This replaces only the earlier DB-first sequence in R-34/D-100. The T-code/form and owner-field gate, bounded/no-bundling discipline, R-40 publication-before-test instruction, and post-test report/request for the next T-code remain unchanged. | Owner instruction in the 2026-10-15 conversation. | 2026-10-15 |
| D-117 | **SCR-025 / OX19 assignment rules.** Permit adding, unassigning and reassigning Controlling Area–Company Code relationships; duplicate assignment is a no-op and actual changes retain the old/new relationship in history. Enforce the OKKP 1:1/1:N scope and allow each Company Code to belong to at most one Controlling Area. F4 includes all existing tenant-local records. For multi-company areas, the Company Code local-currency key must match the Controlling Area Currency Key. Reuse the existing master-data permissions; see B-199 for remaining implementation details requiring confirmation. | Owner selections received on 2026-10-15. | 2026-10-15 |
| D-118 | **SCR-025 / OX19 audit, currency and permission clarifications.** A duplicate assignment leaves mapping state unchanged but creates an audit/history event. Reassignment requires a separate unassign followed by a separate assign. Company Code local currency must equal the Controlling Area Currency Key in both 1:1 and 1:N scopes. Both existing Controlling Area and Company Code master-data permissions are required. Unassignment's active-row representation is still pending (B-200). | Owner selections received on 2026-10-15. | 2026-10-15 |
| D-119 | **SCR-025 / OX19 unassignment representation.** Unassigning removes the relationship from the current assignment set while retaining immutable assignment/unassignment audit events. Reassignment remains two separate user operations: unassign, then assign to the other Controlling Area. | Owner selection received on 2026-10-15. | 2026-10-15 |

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

### 26.175 B-159 — Remove source-system field codes from SCR-021 app text `COMPLETE · REGRESSION-GUARDED · BROWSER-REVERIFIED`

**Owner directive (R-32, 2026-10-14).** `VKORG` and `BUKRS` must not be used directly in the application. The repository audit found them only in the two SCR-021 field labels; all persisted, action and component names already used Cairn-native concepts (`salesOrg` / `companyCode`). The labels now read simply **Sales Organization** and **Company Code**. The specification and ledger retain the source-field mapping for traceability; the app/runtime does not.

**Regression guard.** Extended `tests/sales-org-company-code-assignment-contract.test.ts` to assert the native user-facing labels and scan the assignment service, action, page, form, overview and i18n catalogue for either source-field identifier. A case-insensitive repository audit found no occurrences in `src`, `scripts` or `drizzle`.

**Verification.** Production build passed; typecheck clean; `lint:ip` clean (358 files); browser harness **248/248 across 47 files**. Re-ran browser target `sales-org-company-code` against the static test database after the label change: **passed**, including F4 selection, audited reassignment, capability separation and the 390px layout. No schema, migration, seed or test-data change; browser fixture cleanup remains guarded. Commit and push follow this post-acceptance ledger update.

**Next.** SCR-022 remains next; before any design, present its verified transaction code(s), then wait for the owner's field list. Owner walkthroughs remain deferred.

### 26.176 B-160 — SCR-022 OVXI / OVXB field contract and proposed page specification `DRAFT · OWNER APPROVAL REQUIRED`

**Owner-supplied fields (R-33, 2026-10-14).**

| Page / transaction | Cairn field | Required | Format / max length | Sample | Rule |
|---|---|---:|---|---|---|
| Distribution Channel / OVXI | Distribution Channel | Yes | 2 alphanumeric characters | `10` or `WH` | Unique key describing the route through which goods/services reach customers. |
| Distribution Channel / OVXI | Name | Yes | 20 characters | `Wholesale` | Descriptive channel name. |
| Division / OVXB | Division | Yes | 2 alphanumeric characters | `00` or `BI` | Unique key for a product line, product range or business segment. |
| Division / OVXB | Name | Yes | 20 characters | `Bicycles` | Descriptive division name. |

**Existing model and scope.** The repository already has tenant-scoped `distribution_channel` and `division` tables and seeds; both tables retain an `isActive` flag. Workbench activities, routes and the standard role-grant list already separate `CFG.ORG.DISTCHANNEL.DEFINE` (`/config/distribution-channels`) from `CFG.ORG.DIVISION.DEFINE` (`/config/divisions`). They are two distinct definitions under the single SCR-022 work-queue row. The existing exact capability catalogue does not yet register these two codes. A Sales Area is a separate composite entity; assignment activities and Sales Area maintenance remain outside this batch.

**Proposed contract — not yet AGREED.** Two separate mobile-ready pages, one per SAP definition transaction and existing exact capability. Each page lists tenant-local entries and supports create, change the name only (key immutable), copy as a new entry (new key required), and audited soft deactivation. No hard delete or reactivation. Deactivation is refused while any Sales Area record refers to the key; it does not cascade or rewrite dependent data. Keys are trimmed and normalized to uppercase, then validated as exactly two ASCII letters/digits; names are trimmed, required and limited to 20 characters. Only the supplied fields are editable; actor/tenant and status metadata remain server-controlled. Create/change/deactivation write tenant-scoped audit history and complete only that definition activity. There is no value-help lookup for either field.

**Not in scope.** Distribution Channel ↔ Sales Organization assignment, Division ↔ Sales Organization assignment and Sales Area creation remain separate activities (the later OVXK / OVXA / OVXG flows). No implementation, migration, seed run or database write is authorized by this draft.

**Approval gate.** Per §24.1, implementation must wait until the owner approves or marks up this full contract, especially the two-page boundary and copy/deactivation rules. No application files changed in B-160.

### 26.177 B-161 — Owner approval of the SCR-022 definition contract `APPROVED · IMPLEMENTATION AUTHORIZED`

The owner selected **Approve as proposed** on 2026-10-14. D-099 now controls the two separate pages, independent authorities, key/name limits, normalization, copy, immutable keys, audited soft deactivation only while unreferenced, and exclusion of hard delete/reactivation/assignment/Sales Area setup. Step 2 of §24.1 is complete; implementation may begin. This approval batch changed only this ledger; no application, seed, migration or database changes.

### 26.178 B-162 — SCR-022 audited Distribution Channel / Division services `IMPLEMENTED · STATIC TEST DB 4/4`

Added `src/modules/foundation/distribution-channel-division-maintenance.ts` over the existing tenant-scoped definition tables. The two exact activity/object classes stay separate. The strict services trim and uppercase two-character ASCII alphanumeric keys; require non-empty names of at most 20 characters; serialize duplicate creation; enforce tenant-local uniqueness and optimistic audit-count versions; allow name-only change/no-op retry; and record create/change/deactivation history under the signed-in actor supplied by the future protected-action boundary. Copy will use the same create path with a new key. Soft deactivation retains the row/history and refuses any key used by any Sales Area; no delete/reactivation operation exists. The physical columns remain wider for compatibility; service validation enforces the owner-approved UI contract.

Focused service acceptance against the static owner test DB passed **4/4**, including both entity types, lowercase normalization, exact key/name boundaries, same key in separate tenants, duplicate rejection, name-only history, stale-version rejection, unreferenced deactivation, and both Sales Area guards. `typecheck` passed. Fixture cleanup was queried: only tenant `0100` remains, zero `T###` rows. No schema migration or seed execution in B-162.

**Next.** Add the two independent exact-capability registrations, session-derived protected actions, Cairn-native messages and mobile-ready definition pages; then run the DB-free contracts before browser acceptance.

### 26.179 B-163 — SCR-022 capability and term-registry registration `COMPLETE · HARNESS 251/251`

Registered `CFG.ORG.DISTCHANNEL.DEFINE` and `CFG.ORG.DIVISION.DEFINE` as separate non-posting Sales configure capabilities. Added native workbench registry terms and their search-only OVXI / OVXB aliases; the existing activities, routes and default role grants stay independently scoped. Added a DB-free contract test and included it in the pure browser-harness suite.

**Verification:** browser harness **251/251 across 48 files**, typecheck clean, `git diff --check` clean. No seed execution, database write, migration or UI change. The earlier unconfigured default Vitest invocation was stopped at connection refusal to loopback and ran no test files; the correct no-DB harness then passed.

**Next.** Build the two separately protected action/page flows and Cairn-native copy; then test security and mobile layout before running browser acceptance.

### 26.180 B-164 — SCR-022 protected definition pages and browser acceptance targets `IMPLEMENTED · STATIC GATES GREEN · LIVE ACCEPTANCE PENDING`

Implemented session-derived, exact-capability actions and separate responsive Distribution Channel and Division pages. Each page supports tenant-local create, name-only change, copy-as-new, change history, and guarded retained deactivation; search, read-only access and native Cairn labels are present. Added the UI/action contract test to the DB-free harness, plus isolated browser targets **T975/T974** for create/copy/change/deactivation, Sales Area blocking, capability separation, Auditor view and 390px overflow checks. These are registered in the D-097 static-acceptance allowlist; browser acceptance has not run yet.

The existing standard Division name `Manufactured products` (21 characters) exceeded the approved limit. The onboarding default is now `Manufactured goods` (18); no schema migration is needed because the table columns already support the records and service validation enforces the approved limit.

**Verification:** typecheck passed; browser harness **261/261 across 50 files**; IP lint scanned 371 files with no trademark findings; `git diff --check` passed. `.env.local` is gitignored and mode 600. No seed, migration, browser acceptance, commit or push has run for this batch. The earlier SCR-022 static-database service suite remains 4/4 (§26.178).

**Next.** Build the production app, run the seed on the owner static test DB, then run the two browser targets one at a time and confirm fixture cleanup before any push. No further owner data is required.

### 26.181 B-165 — SCR-022 production-browser acceptance `PASSED · BOTH TARGETS · STATIC OWNER TEST DB`

**Seed and schema.** Ran the global seed against the owner static test database after verifying the migration URL matched the configured test database. It reported 63 capabilities, 52 activities, 32 registry terms and 25 aliases. Read-only verification confirmed the two exact non-posting capabilities, their separate activity/registry routes, and the search-only OVXI/OVXB aliases. The database has 51 migrations; SCR-022 requires no migration because its tenant tables already exist.

**Browser acceptance.** Built and started the production standalone app. Target `distribution-channels` (T975) passed: exact-capability separation, 390px create form, lowercase-to-uppercase key normalization, forged actor/tenant/status fields ignored, independent copy-as-new, immutable key/name-only change, versioned audit, soft deactivation, Sales Area dependency rejection, Auditor history-only access, no browser runtime errors and protected-route sign-out. Target `divisions` (T974) passed the same corresponding checks. Both target fixtures were deleted by the guarded runner; read-only verification found only tenant `0100` afterward.

**Acceptance defects corrected.** Initial runs exposed strict-mode locator issues in the new smoke script (duplicate list headings and global copy-link counting); locators were narrowed to the intended page/detail. Review also exposed a duplicated inactive-retention notice for maintainers; both pages now render one notice and a UI contract pins the behaviour. No business-data or service-contract change resulted from these corrections.

**Final gates.** Production build passed; typecheck passed; browser harness **262/262 across 50 files**; IP lint scanned 371 files with no trademark findings; `git diff --check` passed. `CAIRN-3.md` remains well below the rotation threshold; `.env.local` is ignored and mode 600. No owner data beyond the authorized global seed and temporary owned browser tenants was touched. No commit or push yet; owner-authorized publication may follow this accepted batch.

### 26.182 B-166 — SCR-022 code published to `origin/main` `PUSHED · POST-ACCEPTANCE`

After both static-database browser targets passed and guarded cleanup was verified, code and the acceptance log were committed as `5ad742c` (`feat: add SCR-022 distribution channel and division maintenance`) and pushed to `origin/main` as a fast-forward from `5b7d3bf`. The follow-up entry records publication; no credentials were committed. `.env.local` remains gitignored and mode 600.

### 26.183 B-167 — Owner-directed staged UI delivery workflow `AGREED · DOCUMENTATION ONLY`

The owner directed that each UI development begin by presenting the relevant SAP transaction code/form and waiting for the owner's field and behavior details. Once supplied, implementation proceeds as distinct bounded stages: (1) database/schema design and any required migration, (2) backend business functions, (3) supporting/helper functions, (4) UI, and (5) tests/acceptance. The full sequence is not to be run as one batch. After tests pass, report the result and request details for the next UI transaction.

**Next form request.** The latest SCR-022 browser tests already passed in B-165 (§26.181). The deferred flows named in §26.176 are OVXK (Distribution Channel-to-Sales Organization assignment), OVXA (Division-to-Sales Organization assignment), and OVXG (Sales Area). The log does not explicitly approve their sequence; OVXK is presented as the proposed next form, pending the owner's field details. No design or implementation for it has begun.

Documentation only: no application, schema, migration, database, seed, commit, or push change.

### 26.184 B-168 — Post-test publication and prerequisite-first UI workflow `AGREED · DOCUMENTATION ONLY`

The owner instructed that after each UI acceptance test passes, the tested batch is to be committed and pushed to `origin/main` using the provided PAT; credentials must never be embedded in source, remote URLs, commits, or logs. If an active UI requires data from an unfinished T-code form, pause the active UI, present the supporting T-code and collect its field details, complete its staged build and passing acceptance first, then resume the paused UI. A failed UI test is fixed and rerun before publication.

No UI test ran in this documentation batch, so no commit or push was made. This records the owner's workflow instruction only; no application or database work occurred.

### 26.185 B-169 — OVXK field intake and database design proposal `DRAFT · OWNER FIELDS RECEIVED · LIFECYCLE OPEN`

**Owner-supplied form fields (R-36, 2026-10-14).** Sales Organization is required, `CHAR 4` (sample `1000`), with F4 from an existing OVX5 Sales Organization. Distribution Channel is required, `CHAR 2` (sample `10`), with F4 from an existing OVXI definition.

**Dependency check.** The repo already contains the tenant-scoped Sales Organization and Distribution Channel definitions and completed OVX5/OVXI flows; no unfinished definition T-code blocks this assignment. Local schema/migration review found no dedicated Sales Organization-to-Distribution Channel assignment table. The existing `sales_area` composite entity is separate and will not be changed in this OVXK database stage.

**Proposed database shape (not yet implemented or applied).** Add a tenant-scoped `sales_org_distribution_channel` relation with key `(client, sales_org, distribution_channel)`, composite same-tenant foreign keys to the two existing definition tables, standard audit columns, and tenant-forced RLS. Match the existing master key storage types (`varchar(4)`); enforce the owner's two-character uppercase alphanumeric Distribution Channel contract with a check. Use no-action parent references so definitions cannot be physically removed while assigned; whole-tenant deletion remains the cascade boundary. An additive migration after the current 0027/9022 sequence would create the table and its policy/grants; existing migrations remain immutable. This pair key permits several channels per Sales Organization and reuse of a channel across Sales Organizations.

**Owner decisions needed before finalizing DDL/page contract.** (1) Is the mapping many-to-many as proposed? (2) Should a duplicate assignment be an idempotent no-op or a user-facing error? (3) May an assignment be removed/unassigned; if so, hard removal with retained change history or soft deactivation, and should Sales Area references block removal? (4) Should F4 show only active definitions or all existing definitions? The older work queue assigns SCR-023 to Sales Area; OVXK needs a distinct queue entry/ID before its full SCR specification is frozen.

No DDL, migration, database connection, backend, helper, UI, test, commit, or push was made in this design batch. The schema proposal is pending owner confirmation; proceed to backend only after the DB stage is approved/completed.

### 26.186 B-170 — OVXK database stage implemented `DB SCHEMA AND MIGRATIONS APPLIED · TESTS DEFERRED`

**Owner decisions (D-102).** Many-to-many mapping; unique pair; duplicate retry is a no-op; F4 offers active definitions only; removal is allowed only when no Sales Area references the pair, with retained change-document history. The mapping row itself represents an active assignment; no user-maintained status field was added.

**Database design and implementation.** Added `sales_org_distribution_channel` to the foundation schema and additive migrations `0028_sales_org_distribution_channel_assignment.sql` and `9023_sales_org_distribution_channel_policies.sql`. The relation has a tenant-scoped composite key, same-tenant references to both definition tables, key-format checks, shared audit columns, a reverse lookup index, and forced tenant RLS with runtime-role grants. Migration 0028 backfilled the existing Sales Organization/Distribution Channel pairs implied by current Sales Areas. Existing migrations were not edited.

**Application to the static test database.** The provided elevated migration connection applied both new migrations; 51 earlier migrations were skipped as already applied. Read-only verification returned: 2 new migrations recorded, 1 assignment row, 0 Sales Areas without a matching assignment row, RLS enabled and forced, and one tenant-isolation policy. This was migration verification only; no UI, service, browser, or acceptance test ran. The earlier Drizzle snapshots stop at 0008, so automatic generation was not used; the new SQL follows the repository's additive hand-written migration pattern.

**Next.** Backend functions for OVXK: active-only tenant-scoped F4 queries, idempotent assignment, and guarded unassignment with audit history. Supporting-function work must then update the OVX5/OVXI deactivation guards and standard configuration to account for explicit assignments, before UI design and final tests. No UI test has passed yet; therefore nothing was committed or pushed.

### 26.187 B-171 — OVXK core backend functions `IMPLEMENTED · TESTS DEFERRED`

Added `src/modules/foundation/sales-org-distribution-channel-assignment.ts` with strict owner-field validation, active tenant-scoped F4 sources, a tenant-scoped assignment list, pair-level transaction locking, active-definition and prerequisite checks, idempotent pair creation, and audited unassignment refused whenever any Sales Area references the pair. Audit uses Cairn-native field labels and the proposed internal activity code `CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL`; its capability/activity registration remains in the supporting-functions stage. The lock helper is exported for the future Sales Area create path to share, preventing assignment removal from racing a dependent create.

No registry/action/page/supporting-function changes were made. No typecheck or tests were run, per the staged order; no UI acceptance has occurred, so nothing was committed or pushed. **Next stage:** supporting functions—register the activity/capability, synchronize new-tenant defaults, and make OVX5/OVXI deactivation checks respect this assignment relation—before building the UI.

### 26.188 B-172 — OVXK supporting functions `IMPLEMENTED · UI AND TESTS DEFERRED`

Registered `CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL` as a non-posting Sales configuration capability and Assign activity, added the `OVXK` registry alias, and made Sales Area configuration depend on this assignment activity. The registry term remains `TIER_3_MAPPED` while its page is not yet built. Existing-tenant status is backfilled from actual mapping rows; tenant creation marks the activity complete only after the standard package has inserted the default `1000/01` pair. The default insert records a mapping-level creation event when it creates a new row.

Applied the global seed to the owner-supplied static test database. Read-only verification confirmed one capability, activity, registry term and `OVXK` alias; development tenant `0100` has the activity `COMPLETED` and the `1000/01` mapping present. No tenant was created or modified by a UI flow.

Extended the OVX5 Sales Organization and OVXI Distribution Channel soft-deactivation guards to refuse deactivation while their explicit OVXK assignments exist. Added capability-protected assign and unassign server actions at `/config/sales-orgs/assign-distribution-channel`; tenant and actor come from the verified session, and success, authorization, and operation feedback resolve through the i18n catalogue. The unassign service remains the authority for blocking pairs used by any Sales Area and retaining change history.

No UI page or test changes were made. No typecheck or tests have run, and no commit or push occurred. **Next stage:** UI, gated by R-30/R-34. Before implementation, restate the OVXK form—required Sales Organization (`CHAR 4`, F4 from OVX5) and Distribution Channel (`CHAR 2`, F4 from OVXI)—and wait for the owner's UI-specific fields/layout/behavior details; do not start the page until the owner responds.

### 26.189 B-173 — OVXK UI stage `IMPLEMENTED · ACCEPTANCE DEFERRED`

After the OVXK form and confirmed lifecycle were restated, the owner confirmed on 2026-10-14 that the supplied contract was sufficient and approved a separate Cairn-native, SAP-familiar UI stage. Added the server-rendered assignment route, a required two-field form with keyboard/button F4 lookups, and a responsive current-assignment list. F4 choices come from the active-only tenant-scoped backend service; all existing pairs remain visible, including inactive source definitions. Exact-capability users can assign and remove; duplicate assignment feedback is explicit, and removal requires an inline confirmation while the backend blocks Sales Area dependencies and retains history. The Sales Organization overview now links to the activity for users with the assignment capability.

The registry remains `TIER_3_MAPPED` until UI acceptance. No typecheck, build, UI/browser test, commit or push has run. **Next stage:** tests/acceptance for OVXK; keep it separate from the UI batch, fix and rerun any failure before publishing the tested work.

### 26.190 B-174 — OVXK owner-directed pre-acceptance publication `PUSH AUTHORIZED · BROWSER TEST DEFERRED`

**Owner instruction (2026-10-14, D-103).** Defer the OVXK browser test until the owner approves again, but push the current implementation now. This is an OVXK-specific exception to the usual post-acceptance publication sequence; it does not change R-35/D-101 for future UI pages.

No browser test, build, typecheck or acceptance result is claimed. The UI remains unverified, and the registry remains `TIER_3_MAPPED` until browser acceptance. The full OVXK implementation and stage log are committed locally as `9e689ac`; push the current changes under this explicit owner instruction. When testing is later authorized, fix and rerun any failure before publishing the tested correction.

### 26.191 B-175 — OVXA field intake and database design proposal `OWNER FIELDS RECEIVED · LIFECYCLE OPEN`

**Owner-supplied form fields (R-37, 2026-10-14).** Required Sales Organization, `CHAR 4`, sample `1000`, selected from an existing OVX5 definition; required Division, `CHAR 2`, sample `00`, selected from an existing OVXB definition. Runtime/application names remain Cairn-native.

**Repository review.** `sales_org` and `division` are tenant-local definitions, but there is no explicit Sales Organization ↔ Division relation. `sales_area` stores both keys as part of its `(client, sales_org, distribution_channel, division)` identity, without a separate Sales Organization/Division assignment constraint. The proposed future Sales Area flow (OVXG) therefore needs the OVXA relation and backend dependency enforcement; its create path should acquire the corresponding pair lock to prevent removal/dependent-create races.

**Database proposal — pending lifecycle decisions.** Add a tenant-scoped `sales_org_division` relation keyed by `(client, sales_org, division)`, with same-tenant references to both definitions, a two-character Division format check, standard audit columns, reverse lookup index and forced tenant RLS. Backfill distinct `(client, sales_org, division)` pairs implied by existing Sales Areas. New-tenant default assignments belong to the later supporting-functions stage. This is a design proposal only; no schema, migration or database change has been made.

**Owner decisions required before final DDL:** (1) mapping cardinality; (2) duplicate-assignment behavior; (3) whether unused pairs may be removed and, if so, removal/history behavior and whether any Sales Area using the same Sales Organization/Division pair (across any channel) blocks removal; (4) whether F4/assignment accepts active definitions only; and (5) whether both definition activities must already be complete before assignment.

**Next.** Obtain these lifecycle decisions, then complete the database/schema stage as its own batch. OVXG remains paused until OVXA is implemented and accepted, per the prerequisite-first workflow.

### 26.192 B-176 — OVXA database/schema stage implemented and applied `DB STAGE COMPLETE · BACKEND NOT STARTED`

**Owner decisions (D-104).** Many-to-many Sales Organization ↔ Division assignment; duplicate assignment is idempotent; F4 and assignment must accept active definitions only and require both definition activities complete. An unused pair may be hard-removed with change history retained; block removal while any Sales Area uses the same Sales Organization/Division pair, regardless of channel.

**Implementation.** Declared `sales_org_division` in `src/modules/foundation/schema.ts` and added migration `0029_sales_org_division_assignment.sql` with composite tenant key, same-tenant definition references, four-character Sales Organization / two-character Division format checks, audit columns, reverse index, and distinct Sales-Area-derived pair backfill. Migration `9024_sales_org_division_policies.sql` enables and forces tenant RLS, adds the tenant policy, revokes PUBLIC access, and grants the application role only if present. New-tenant default mappings remain for the supporting-functions stage.

**Database outcome.** Applied both migrations to the owner-supplied static test database. Read-only verification confirms both migration records are present, one mapping exists, no Sales Area lacks its corresponding mapping, and the relation has forced RLS plus the tenant policy. No seed changes or other test-data writes were made.

**Scope boundary.** `git diff --check` passed. No backend/supporting functions, UI, typecheck, build, or tests were done; nothing was committed or pushed. Stop at this completed DB stage. OVXG remains paused until OVXA is implemented and accepted.

### 26.193 B-177 — OVXA backend assignment services implemented `BACKEND STAGE COMPLETE · SUPPORTING NOT STARTED`

**Implementation.** Added `src/modules/foundation/sales-org-division-assignment.ts` with tenant-validated assignment inputs, active-only OVX5/OVXB F4 data, an assignment list that retains visibility of inactive definitions, and a reusable transaction advisory lock for the future Sales Area create path. Assignment validates both source definitions as active and both definition activities as complete, then performs an idempotent insert. Removal is serialized on the same pair lock and blocked by any Sales Area using the Sales Organization/Division pair across all channels; successful creates/removals write change documents and mark the assignment activity complete.

**Verification and boundary.** `npm run typecheck` passed; `git diff --check` and whitespace checks passed. No behavioral tests were run because tests/acceptance are a later separate stage. Supporting functions (activity/capability registration, tenant status/defaults, Sales Area/deactivation guards), UI, and tests remain untouched. No commit or push. OVXG remains paused until OVXA is implemented and accepted.

### 26.194 B-178 — OVXA supporting functions implemented `SUPPORTING STAGE COMPLETE · UI NOT STARTED`

**Implementation.** Registered `CFG.ORG.SALESORG.ASSIGN_DIVISION` and its exact configure capability, OVXA search alias, and tier-3 registry entry; added the activity as a Sales Area prerequisite. Existing-tenant seeding now derives Division-definition and assignment completion from actual rows. Standard tenant setup creates the audited `1000/01` Division assignment before its `1000/01/01` Sales Area and marks the assignment complete. OVX5 and OVXB deactivation now refuse while Sales Organization/Division mappings depend on the definition. Added localized, exact-capability assign/remove server actions; no page or form was added.

**Database and verification.** Applied the updated global seed to the static test database. Read-only checks confirmed the capability, activity, OVXA alias/registry row, Sales Area prerequisite, completed Division and OVXA statuses for tenant `0100`, one mapping, and no Sales Area missing its pair. `npm run typecheck` and whitespace checks passed. No behavioral tests, UI, commit or push. OVXG remains paused until OVXA is implemented and accepted.

### 26.195 B-179 — OVXA UI implemented `UI STAGE COMPLETE · TESTS NOT STARTED`

**Implementation.** Added `/config/sales-orgs/assign-division` with the required Sales Organization (`CHAR 4`) and Division (`CHAR 2`) fields, active-only F4 choices with searchable lookup dialogs, duplicate-safe assignment feedback, current assignment display, active/inactive definition status, and confirmed removal messaging. The layout adapts to phone and desktop widths. Capability-gated links are available from both Sales Organization and Division definitions; list-only access remains available without the assignment capability. The registry remains `TIER_3_MAPPED` pending acceptance.

**Verification and boundary.** `npm run typecheck`, `git diff --check`, and whitespace checks passed. No behavioral tests, browser acceptance or production build were run; no commit or push. The separate tests/acceptance stage is next. OVXG remains paused until OVXA is implemented and accepted.

### 26.196 B-180 — OVXA accepted and published `ACCEPTED · PUSHED`

**Verification.** `npm run typecheck` passed; `npm run test:browser-harness` passed 274/274 tests across 52 files; `npm test -- tests/sales-org-division-assignment.test.ts` passed 7/7. The guarded `sales-org-division` browser target passed against local PostgreSQL 17.11 database `cairn`, including active-only F4, idempotence, cross-channel dependency blocking, audited removal/history and exact-capability access. Browser fixture `T973` was removed after the run; no remote database was used.

**Publication and prerequisites.** Commit `7f79695` was pushed to `main`; working tree was clean after push. The owner reported that local OVXK acceptance passed; OVXK was not run in this VM. OVXG is now eligible to proceed with its owner-supplied form contract.

### 26.197 B-181 — OVXG fields/lifecycle captured; database stage complete `DATABASE COMPLETE · BACKEND NOT STARTED`

**Owner contract (D-105).** Required VKORG (`CHAR 4`), VTWEG (`CHAR 2`) and SPART (`CHAR 2`) plus required Name (the existing table's 160-character limit). F4 includes existing definitions, including inactive ones; VTWEG must be linked to the selected Sales Organization via OVXK and SPART via OVXA. Create and name-only change are allowed, the three-part key is immutable, repeated creation is an idempotent no-op, and an existing Sales Area can be soft-deactivated and reactivated. Deactivation is blocked while any customer Sales Area references the tuple; records/history are retained.

**Database implementation.** Updated `sales_area` to store two-character VTWEG/SPART values, check both code formats and nonblank Name, and enforce composite foreign keys to the OVXK and OVXA mapping relations. Existing primary-key, audit columns, `is_active` and Name storage are reused; no table or RLS policy was added. Migration `0030_sales_area_assignment_constraints.sql` was applied only to the local `cairn` database. Read-only verification confirmed the column lengths, format/name checks, pair-assignment foreign keys, and migration record; the local database currently had no Sales Area rows.

**Verification and boundary.** `npm run typecheck` passed. No backend service/action, supporting-function, UI, behavioral test, browser run, commit or push was included in this stage. The next bounded stage is OVXG backend business functions.


### 26.198 B-182 — OVXG backend business functions implemented `BACKEND COMPLETE · SUPPORTING NOT STARTED`

**Implementation.** Added `src/modules/foundation/sales-area-maintenance.ts` with tenant-validated F4 choices (including inactive definitions, restricted by the selected Sales Organization's OVXK/OVXA mappings), retained Sales Area listing, prerequisite and direct-link validation, composite-key locking, idempotent create, name-only change, audited soft deactivation/reactivation, and audit-count optimistic versions. Creation acquires the shared OVXK and OVXA pair locks so a mapping cannot be removed concurrently. Deactivation is blocked by any dependent customer Sales Area.

**Concurrency boundary.** Updated `saveCustomerSalesArea` to take a shared row lock on the Sales Area while validating it, so customer-area creation/update serializes against OVXG deactivation.

**Verification and boundary.** `npm run typecheck` passed. No supporting seed/capability/action registration, UI, behavioral tests, browser acceptance, commit or push was included. The next bounded stage is OVXG supporting functions.


### 26.199 B-183 — OVXG supporting functions implemented `SUPPORTING COMPLETE · UI NOT STARTED`

**Implementation.** Registered the exact non-posting capability `CFG.ORG.SALESAREA.DEFINE`, term-registry entry and `OVXG` search alias (`TIER_3_MAPPED` pending acceptance). Added existing-tenant activity-status backfill derived from retained Sales Area rows without overwriting prior progress. Standard tenant setup now records the default `1000/01/01` Sales Area creation in change history when newly inserted. The existing workbench activity, its OVXK/OVXA prerequisites, onboarding completion and `/config/sales-areas` route path were already present.

**Verification and boundary.** `npm run typecheck` passed. The global seed ran on the local `cairn` database; read-only checks confirmed the capability, activity prerequisites/route, OVXG alias and registry entry. The local database has no tenant rows, so the onboarding-default audit path remains for later behavioral testing. No UI, behavioral/browser tests, commit or push was included. The next stage is OVXG UI.


### 26.200 B-184 — SCR-024 OKKP field intake and database-design proposal `DRAFT · OWNER FIELDS RECEIVED · OPEN DECISIONS`

### 26.201 B-185 — SCR-024 Controlling Area database stage `DB COMPLETE · BACKEND NOT STARTED`

**Owner decisions (R-39; D-106–D-110).** Assignment Control is modeled with Cairn-native values `SINGLE` and `MULTIPLE`, displayed as “Same Company Code” and “Multiple Company Codes”. Single permits at most one company assignment; multiple permits several. The existing/default `A000` starts as single; changing scope is audited and returning to single is refused while several company codes remain assigned. Existing rows are backfilled by assignment count (zero/one → single; two or more → multiple). Currency is limited to three-character keys with active-only global value help. Fiscal Year Variant remains two characters and F4 includes inactive definitions. The key is uppercase and immutable; both names are changeable with history; no deactivate/reactivate action is allowed.

**Database implementation.** The existing tenant-local `controlling_area` table is reused; no parallel master or new RLS policy is introduced. Migration `0031_controlling_area_definition.sql` narrows Name to 30 with fail-closed preflight, adds the optional 30-character `organization_name`, adds required `company_code_scope` (default `SINGLE`) and backfills multiple-assignment rows, narrows the Controlling Area Fiscal Year Variant to two characters, and adds format/nonblank checks plus same-tenant Fiscal Year Variant and global Currency references. The existing `controlling_area_company` relation remains the separate SCR-025/OX19 assignment surface. The database default keeps the existing standard-package insert compatible until the supporting-functions stage explicitly supplies the chosen default.

**Application and verification.** Applied `0031_controlling_area_definition.sql` only to local PostgreSQL database `cairn`. Read-only verification confirmed the Name/organization-name limits, required scope default, two-character variant, checks and both reference constraints; the local database currently has zero Controlling Areas and zero assignment rows. `npm run typecheck` passed; `git diff --check` passed. No backend services, supporting functions, UI, behavioral tests, UI tests or acceptance were included. No remote database was used.

**Next.** Implement the separate SCR-024 backend services: active-only currency F4, all-existing Fiscal Year Variant F4, tenant-scoped list/create/name changes and audited scope-change guard. Keep SCR-025/OX19 assignment UI separate; no UI test is authorized in this stage.


**Owner-supplied form fields (R-38, 2026-10-14).** Required Controlling Area key (`CHAR 4`, alphanumeric; sample `1000`), required Name (30; sample `Controlling Area 1000`), optional organization name (30; sample `Company Name`), required Assignment Control (single-company-code versus cross-company-code costing), required base Currency Key (sample `USD` / `EUR`), and required Fiscal Year Variant (`CHAR 2`, F4 from existing definitions; sample `K4`). The supplied Assignment Control source identifiers and the last Fiscal Year Variant description are traceability only; Cairn code/UI names remain native. The final sentence in the supplied F4 description is visibly truncated after “post ings”; the captured intent is only that the variant governs cost-accounting periods.

**Repository review.** The tenant-scoped `controlling_area` table already has the `(client, controlling_area)` primary key, `name varchar(160)`, `currency char(3)`, `fiscal_year_variant varchar(4)`, `is_active`, and audit columns. It has no organization-name or assignment-control column. The separate `controlling_area_company` relation already stores area/company-code pairs and is the database foundation for later SCR-025 / OX19; the standard package seeds area `A000` (“Standard controlling area”), the tenant currency, default variant `K4`, and one Company Code assignment. The global currency catalogue uses keys up to five characters; tenant Fiscal Year Variant definitions are stored in a separate existing table with keys up to four characters and an activity flag.

**Proposed database shape (not yet approved for DDL).** Reuse `controlling_area`; do not add a second master table or absorb OX19 assignment maintenance into SCR-024. Retain its tenant-local unique key and audit/status columns. Add a nullable Cairn-native organization-name column limited to 30 characters. Constrain the Name to 30 with a fail-closed preflight (never truncate existing data). Add a required assignment-control column only after its exact enumerated values and semantics are approved; the later OX19 service must enforce its company-code cardinality rule under an area-level lock. Enforce the four-character alphanumeric key and the two-character Fiscal Year Variant, and link the latter to the existing tenant-local definition; a preflight must refuse incompatible stored values. Preserve the existing `

### 26.203 B-187 — SCR-024 Assignment Control details and backend services `BACKEND COMPLETE · SUPPORTING NOT STARTED`

**Owner clarification (R-41; D-112–D-114).** The dropdown options are “Controlling area same as company code (1:1 Relationship)” and “Cross-company-code cost accounting (1:N Relationship)”. The first permits one Company Code per Controlling Area; the second permits multiple and requires every assigned Company Code to share the same Operational Chart of Accounts and Fiscal Year Variant. Currency and Fiscal Year Variant remain editable before activity and become read-only after an actual operational document exists for any assigned Company Code. Duplicate-key creation is an idempotent no-op. The UI has not yet been built; the exact owner wording is reserved for its later UI stage.

**Backend implementation.** Added `src/modules/foundation/controlling-area-maintenance.ts`: active-only three-character Currency F4; all-existing two-character Fiscal Year Variant F4, including inactive definitions; tenant-local listing with assignment count and financial-field lock state; unique-key create/no-op; audited name, organization-name and Assignment Control changes; optimistic history versions; reference/prerequisite checks; scope-change cardinality and cross-company consistency guards; and server-side Currency/Fiscal Year Variant lock after recorded activity. Exposed a shared Company Code-to-Controlling Area row-lock helper for the supporting-functions stage to wire into posting/document paths.

**Verification and boundary.** `npm run typecheck` passed. No behavioral tests, UI, supporting-function changes or acceptance were run. No database change was made in B-187. Next stage: supporting functions, including transaction/configuration locking and explicit standard-package scope initialization; then the separate responsive UI stage with the exact owner-provided dropdown.
A000` row and assignment unless a later owner-approved supporting-functions change says otherwise. Do not choose a required assignment-control backfill for existing rows or silently change the onboarding default.

**Open owner decisions before final DDL.** (1) Exact Assignment Control options, which option allows one versus several Company Codes, whether it can be changed after assignment, and the approved backfill for existing `A000` (currently seeded with one assignment). (2) Currency format: retain the current three-character constraint or widen to the global catalogue's full key length (up to five); whether Currency F4 should show active entries only. (3) Fiscal Year Variant F4: active definitions only or all existing definitions. (4) Lifecycle/key rules: key immutability

### 26.205 B-189 — SCR-024 Assignment Control owner copy recorded `UI COPY READY · UI NOT STARTED`

Per R-42/D-115, preserve the following owner copy exactly in the OKKP UI:

- Heading: “Description of Controlling Area’s Purpose”
- Control description: “Controls the relationship between Controlling Area and Company Code”
- Option 1: “Controlling area same as company code (1:1 Relationship)” — “This maps Controlling Area to a single Company Code in a strict 1:1 relationship, where only one Company Code may be assigned to the Controlling Area.”
- Option 2: “Cross-company-code cost accounting (1:N Relationship)” — “This enables one Controlling Area to be assigned to multiple Company Codes, allowing cost accounting to be performed across all assigned Company Codes.”
- General help: “The scope controls whether a Controlling Area can be assigned to one or multiple Company Codes in the system.” Then the exact lines “1:1 Relationship: Exactly one Company Code must be assigned to the Controlling Area.” and “1:N Relationship: One Controlling Area can be assigned to multiple Company Codes.” Finish with “This will determine whether cost accounting for a Controlling Area is restricted to a single Company Code or includes all cross-company costs.”

This is a requirements/logging update only; no UI was implemented and no UI tests ran.
 and case normalization; name/organization-name change behavior; whether deactivation/reactivation is allowed and what dependent records block it. No form field or lifecycle rule is inferred from the prior placeholder row's `is_active` column.

**Boundary and next step.** This is a schema review/proposal only: no migr

### 26.202 B-186 — SCR-024 database stage published `PUSHED · UI TEST DEFERRED`

Commit `9a7a82c` (`feat: add SCR-024 controlling area schema`) was pushed to `origin/main` as a fast-forward from `b5f923b`. It contains the database/schema stage, migration `0031`, the recorded field decisions, and the design log. Migration `0031` was applied only to local `cairn`; no remote database was used. No backend/UI work, UI test or acceptance has run. **Next:** SCR-024 backend services.
ation, application-code change, database connection/write, seed, test, commit, or push. Finalize the open items with the owner, then complete the SCR-024 database stage as its own batch. The separate SCR-025 / OX19 assignment form remains after the definition stage.


### 26.204 B-188 — SCR-024 backend services published `PUSHED · UI TEST DEFERRED`

Commit `ffb8a02` (`feat: add SCR-024 controlling area services`) was pushed to `origin/main` as a fast-forward from `227511d`. It contains the SCR-024 backend functions and the logged owner clarifications. `npm run typecheck` passed; no behavioral test, UI test or acceptance ran. The next distinct stage is supporting functions.


### 26.206 B-190 — SCR-024 supporting functions `COMPLETE · UI NOT STARTED`

- `src/platform/posting/index.ts` takes `FOR SHARE` on the assigned Controlling Area row(s) before reading posting configuration or writing a journal document. OKKP maintenance takes `FOR UPDATE`, so the activity check and financial-field change serialize against postings until commit.
- Journal posts already call `indexDocument` in the same transaction; their Company Code is indexed, so the SCR-024 activity query sees them. Updated the document-index contract: future non-journal operational writers must call `lockControllingAreaForCompanyCode` before configuration-dependent reads/business writes and index the document in that same transaction. Repository inspection found no non-journal operational document writers in current `src` (inventory files currently maintain master data, not operational transactions); no fictitious caller was added.
- `src/modules/foundation/standard-config.ts` now explicitly seeds default Controlling Area `A000` with `companyCodeScope: 'SINGLE'`. The database migration already backfills zero/one assignments to SINGLE and two-or-more to MULTIPLE; no new migration or database write was needed.
- `npm run typecheck` passed after restoring locked dependencies with `npm ci` (including the retained `@playwright/test`). No behavioral/UI tests ran; the tests stage remains separate.

**Next:** SCR-024 UI for SAP T-code OKKP / Controlling Area Definition, using the already supplied exact labels and help copy. No UI work is included here.


### 26.207 B-191 — SCR-024 / OKKP Controlling Area UI `IMPLEMENTED · UI TESTS DEFERRED`

**Screen and copy.** Added the responsive `/config/controlling-area` form for SAP T-code OKKP, gated by `CFG.COST.CONTROLLINGAREA.DEFINE`. The owner-supplied “Description of Controlling Area’s Purpose” heading, field description, both option labels/descriptions, and all scope explanation lines are rendered verbatim through the English catalogue. Assignment maintenance remains separate in OX19; the workbench opens the Define activity while the Assign activity remains pending.

**Controls.** The create form normalizes a four-character key, requires Name, supports the optional 30-character “Name of Controlling Area”, defaults Assignment Control to SINGLE, and uses F4 dialogs for active currencies and all existing Fiscal Year Variants (including inactive). Existing keys are shown read-only; audited editable fields are maintained per row with optimistic versions. Financial inputs become read-only from the backend activity flag. The 1:1 choice is unavailable while more than one Company Code remains assigned; the page displays assignment counts but provides no OX19 assignment or deactivate/reactivate controls. Capability-gated server actions use only session tenant/user identity and surface duplicate-create no-op feedback.

**Verification boundary.** `npm run typecheck` and `git diff --check` passed. No UI tests, browser acceptance, behavioral tests or database changes were made. UI tests remain deferred until after implementation publication.


### 26.208 B-192 — SCR-024 / OKKP UI published `PUSHED · UI TESTS DEFERRED`

Commit `bf7c552` (`feat: add SCR-024 OKKP maintenance UI`) was pushed to `origin/main` as a fast-forward from `debe23a`. It contains the `/config/controlling-area` UI and its log. The typecheck passed before publication; no UI/browser tests or acceptance ran, in accordance with R-40/D-111.


### 26.209 B-193 — SCR-024 test stage partial `STATIC CONTRACTS PASS · BROWSER ACCEPTANCE BLOCKED`

**Executed.** Added `tests/controlling-area-ui-contract.test.ts` to the no-DB browser-harness configuration. Its targeted run passed **7/7** (schema normalization/limits, owner copy, capability/session contract, F4 source rules, financial-field lock display, and OX19 separation). Typecheck and `git diff --check` passed.

**Harness regression run.** `npm run test:browser-harness` reported **51/53 files and 279/281 tests passing**. Two unrelated existing source-code scans failed because the global i18n file already contained Sales Area terms `VKORG`, `VTWEG`, and `SPART`; those strings were present at baseline commit `debe23a`, and the SCR-024 UI diff adds none of them. No unrelated source/test behavior was changed to mask those failures.

**Browser/DB boundary.** No live Playwright or DB-backed acceptance ran. Preflight found no `.env.local`/database environment variables, no PostgreSQL server or binaries, and connection refused at local `127.0.0.1:5432`. The configured test target remains local; uploaded remote database credentials were not used or changed, and no DB writes were attempted. Actual OKKP browser acceptance remains blocked pending restoration/start of the local test database.


### 26.210 B-194 — SCR-024 UI contract tests published `PUSHED · BROWSER ACCEPTANCE BLOCKED`

Commit `c820b95` (`test: add SCR-024 OKKP UI contracts`) was pushed to `origin/main` as a fast-forward from `574e364`. It adds the 7 passing no-DB Controlling Area UI/schema contract tests to the browser-harness suite and records B-193. No UI implementation changes were part of this test publication. Live browser acceptance remains blocked by the unavailable local PostgreSQL service; no remote database was used.


### 26.211 B-195 — SCR-024 change-form event defect fixed and published `FIX PUSHED · RETEST PASS`

**Finding and correction.** The first live browser acceptance exposed a client exception when changing Name or Name of Controlling Area: the React state updater read `event.currentTarget` after event dispatch. The form now captures both field values synchronously before calling `setValues`, preserving the existing 30-character limits and behavior.

**Publication.** Commit `1b3b888` (`fix: preserve OKKP change form values`) was pushed before the acceptance rerun. `npm run typecheck` and `git diff --check` passed; the later live run completed the edit and audit-history path without a browser runtime error.


### 26.212 B-196 — SCR-024 / OKKP local browser acceptance `PASS · OX19 SEPARATE`

**Isolated setup.** With owner authorization, provisioned disposable local PostgreSQL 17.11 database `cairn`, applied 57 migrations, seeded global/reference data and the local development tenant, and used separate loopback-only restricted runtime and elevated migration roles. Added the guarded `controlling-area` browser target on reserved fixture `T972`; only `npm run smoke:browser:controlling-area` was invoked. The guard verified `127.0.0.1:5432`, database `cairn`, and role separation. Uploaded remote DB credentials were not used or changed; no OVXK/OVXA target ran.

**Acceptance evidence.** The target passed with no browser runtime errors. It verified the standard `A000` starts Same Company Code (1:1) with one Company Code and remains editable before activity; exact owner-supplied Assignment Control copy; lowercase key normalization; active Currency F4 and inactive Fiscal Year Variant F4; create and duplicate-key no-op with no extra history; immutable key; audited changes to both names and Assignment Control; and the financial-field lock for both an indexed-document case and an actual posted journal under the assigned Company Code. After the real journal, `A000` currency/Fiscal Year Variant were read-only, while unassigned `B201` remained editable.

**Non-journal boundary and cleanup.** No non-journal operational transaction writer currently exists in `src`. A synthetic `OPEN` document-index fixture was therefore used only to exercise the generic pre-ledger lock path, then removed; it is not claimed as an actual business transaction. The browser target and OX19/SCR-025 assignment maintenance remain separate. Cleanup verification found no `T972` tenant and no synthetic document-index row. Afterward, the disposable `cairn` database and local roles were dropped and the PostgreSQL cluster stopped. Jupyter, uvicorn, the Node-kernel services and `@playwright/test` were left untouched. No remote database was contacted.

**Other tests.** `npm run typecheck`, `git diff --check`, and the targeted no-DB suite (**65/65**) passed. The full `npm run test:browser-harness` run reported **51/53 files and 281/283 tests passing**. Its same two unrelated legacy source scans fail on Sales Organization / Distribution Channel terms already present at baseline `debe23a`; no unrelated code was changed. The guarded browser-target test code is committed in `8a5e8fb` (`test: add SCR-024 OKKP browser acceptance target`) and is ready for publication with this log.


### 26.213 B-197 — Owner changes delivery sequence to UI-first `ORDER UPDATED · OX19 INTAKE PENDING`

**New standing order (R-43/D-116).** Future T-code page work proceeds through separate bounded stages in this order: **UI → DB/schema → backend → supporting functions → tests/acceptance**. This supersedes only the earlier DB-first stage sequence recorded in R-34/D-100. The requirement to present the T-code/form and wait for owner-supplied fields before UI work, the no-bundling rule, R-40 publication-before-test instruction, and the post-test report/request for the next UI T-code remain in force.

**Next page status.** SCR-025 / OX19 remains the next planned UI. The owner confirmed the T-code but has not yet supplied its form-field and behavior contract; no OX19 UI or implementation stage has started. Await those details before beginning the UI-first sequence.


### 26.214 B-198 — SCR-025 / OX19 form fields and compatibility rules captured `PARTIAL CONTRACT · CLARIFICATIONS PENDING`

**Owner-supplied fields.** The form has two required lookups: Controlling Area (Char 4 alphanumeric, F4 from definitions created via OKKP; sample `1000`) and Company Code (Char 4 alphanumeric, F4 from legal Company Codes in OX02; sample `1000`). Both source records must exist before assignment.

**Compatibility rules.** Each assignment must match the Controlling Area's exact Operational Chart of Accounts and Fiscal Year Variant, whether the Controlling Area uses 1:1 or 1:N assignment scope. When multiple Company Codes are assigned to one Controlling Area, their currency setups must align with currency-type rules in the Controlling Area definition. The OX19 UI is expected to present Cairn-native labels; source field identifiers are traceability only.

**Open gates before UI design.** The owner has not yet specified the exact currency comparison (the current OKKP definition stores a Currency Key, not a currency-type rule set), Company Code reverse-cardinality, add/remove/reassignment lifecycle, duplicate semantics, removal/history behavior, value-help eligibility filters, or authorization boundary. No UI, DB/schema, backend, supporting-function, or test work has started. Under R-30/R-43, collect these decisions before starting the UI stage.


### 26.215 B-199 — OX19 assignment rules clarified `PARTIAL CONTRACT · FINAL UI GATES OPEN`

**Owner selections (D-117).** OX19 supports add, unassign and reassign; duplicate assignment is a no-op; actual changes preserve old/new relationship history. OKKP Same Company Code allows at most one Company Code per Controlling Area, Multiple Company Codes allows several, and each Company Code may belong to at most one Controlling Area. Both F4 lists include all existing tenant-local records. For the multi-company currency rule, require the Company Code local-currency key to equal the Controlling Area Currency Key. Reuse existing Company Code and Controlling Area master-data permissions.

**Remaining UI-contract questions.** Confirm whether unassignment removes the current mapping or retains it as inactive, whether reassignment is one atomic audited move, whether a duplicate no-op produces a history event, whether the currency-key equality rule also applies in 1:1 scope, and whether authorization requires both master-data permissions or either one. No UI or implementation work has started; resolve these before the UI-first stage.


### 26.216 B-200 — OX19 audit, currency and permission rules clarified `PARTIAL CONTRACT · UNASSIGN STORAGE PENDING`

**Owner selections (D-118).** A duplicate assignment leaves current state unchanged but records an audit/history event. Reassignment is not a single operation: the user must unassign first, then separately assign the Company Code to another Controlling Area. The Company Code local-currency key must equal the Controlling Area Currency Key for both 1:1 and 1:N scope. Both existing Controlling Area and Company Code master-data permissions are required.

**Remaining gate.** The owner has not yet specified whether unassignment removes the active mapping row while retaining history, or marks/retains the row as inactive. No UI or implementation work has started; resolve this before the UI-first stage.


### 26.217 B-201 — SCR-025 / OX19 contract complete `OWNER CONTRACT COMPLETE · UI STAGE NEXT`

**Final owner contract (R-44–R-47; D-117–D-119).** The UI has required Controlling Area and Company Code lookups (Char 4 alphanumeric; F4 includes all existing tenant-local records; source records must exist). Each assignment requires exact Operational Chart of Accounts and Fiscal Year Variant matches, plus Company Code local-currency equality with the Controlling Area Currency Key in both 1:1 and 1:N scopes. OKKP scope controls area cardinality: Same Company Code permits at most one Company Code, Multiple Company Codes permits several; each Company Code belongs to at most one Controlling Area. Add, unassign and reassignment are supported; reassign by separate unassign then assign. A duplicate leaves mapping state unchanged but logs an audit event. Unassignment removes the current relationship, retaining immutable audit history. Both existing master-data permissions are required.

**Stage status.** The owner-supplied contract and clarifications are complete. Per R-43, the next separate batch is the UI stage, before DB/schema, backend, supporting functions and tests. No OX19 product code or database change has been made in this contract-intake batch.

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
| 1.77 | 2026-10-14 | **Remove source-system field identifiers from SCR-021 application labels (B-159, §26.175; R-32).** Replaced the UI labels `Sales Organization (VKORG)` and `Company Code (BUKRS)` with the app-native labels `Sales Organization` and `Company Code`; underlying code already used `salesOrg` / `companyCode`. Added a contract guard scanning the SCR-021 runtime sources and i18n for either code. Audited the repository: no such identifiers remain in `src`, `scripts` or `drizzle` (requirements retain the field mapping). Build/typecheck/lint clean; harness 248/248; static-DB SCR-021 browser target re-passed after the change. | Agent |
| 1.78 | 2026-10-14 | **SCR-022 OVXI/OVXB fields captured and proposed two-page contract drafted (B-160, §26.176; R-33).** Recorded the owner's four required fields (two-character alphanumeric key and 20-character name for each definition). Repository review found distinct pre-existing workbench activities/routes and separate role-grant entries; the proposal preserves that separation and excludes assignments/Sales Area creation. Full page contract awaits owner approval under §24.1. Documentation only; no app, seed, migration or database changes. | Agent |
| 1.79 | 2026-10-14 | **SCR-022 page specification approved (B-161, §26.177; D-099).** Owner approved the two-page OVXI/OVXB contract: separate exact capabilities, two-character uppercase keys, 20-character names, immutable keys, copy-as-new and guarded audited soft deactivation; no hard deletion/reactivation or assignments. Step 2 of §24.1 is complete. No app, seed, migration or database changes in the approval batch. | Agent |
| 1.80 | 2026-10-14 | **SCR-022 audited definition services accepted (B-162, §26.178).** Added the two tenant-scoped create/name-change/guarded-deactivation services with two-character key and 20-character name validation, locking, versioned audit history and Sales Area reference checks. Static test DB service suite passed 4/4; two fixture tenants were cleaned and only `0100` remains. Typecheck passed. Existing table columns were sufficient; no migration or seed run. Protected actions/pages and capability registration remain next. | Agent |
| 1.81 | 2026-10-14 | **SCR-022 capabilities and registry terms added (B-163, §26.179).** Registered the separate non-posting Distribution Channel and Division capabilities and search aliases; added the DB-free contract guard to the browser harness. Harness 251/251 across 48 files, typecheck and diff check clean. No seed run, database, migration or UI change. | Agent |
| 1.82 | 2026-10-14 | **SCR-022 protected pages and browser acceptance harness added (B-164, §26.180).** Implemented separate exact-capability, tenant-scoped responsive forms/actions with create, name-only change, copy-as-new and audited guarded deactivation; added UI and isolated static-DB browser contract coverage. Shortened the standard Division name to 18 characters to comply with the approved limit. Verification: typecheck, browser harness 261/261 across 50 files, IP lint 371 files clean, and diff check clean. No seed, migration or live browser run, commit or push. | Agent |
| 1.83 | 2026-10-14 | **SCR-022 seeded and accepted in production-browser tests (B-165, §26.181).** Verified the static test DB’s exact capabilities, activity/registry routes and search aliases; no migration was needed. Both Distribution Channel (T975) and Division (T974) browser targets passed individually, including 390px checks, exact-capability separation, audit, copy/change/deactivation, dependency blocks and Auditor access. Guarded cleanup left only tenant `0100`. Production build, typecheck, harness 262/262 across 50 files, IP lint and diff check passed. Publication remains the next action. | Agent |
| 1.84 | 2026-10-14 | **SCR-022 published after browser acceptance (B-166, §26.182).** Pushed code commit `5ad742c` to `origin/main` as a fast-forward from `5b7d3bf` after both static-test-database browser targets passed and fixture cleanup was verified. The global seed and temporary browser fixtures were the only owner-test-data writes; `.env.local` remains ignored and mode 600. | Agent |
| 1.85 | 2026-10-14 | **Owner-directed staged UI delivery recorded (B-167, §26.183; R-34/D-100).** For each page: present the SAP transaction code/form and wait for owner fields/details; then deliver database/schema, backend, supporting functions, UI, and tests in distinct bounded batches. After passing tests, request the next UI form's details. OVXK is presented as the proposed next form, pending owner fields. Documentation-only update; no application or database change, commit, or push. | Agent |
| 1.86 | 2026-10-14 | **Post-test push and prerequisite-first UI ordering recorded (B-168, §26.184; R-35/D-101).** Push each tested UI batch after acceptance passes; if a page depends on an unfinished T-code form, suspend it and complete the supporting T-code(s) first, then resume. No UI test ran in this documentation batch, so nothing was committed or pushed. | Agent |
| 1.87 | 2026-10-14 | **OVXK owner fields captured and DB design proposed (B-169, §26.185; R-36).** OVXK requires Sales Organization (Char 4, F4 from OVX5) and Distribution Channel (Char 2, F4 from OVXI). Repository review found no mapping table; proposed a tenant-scoped composite relation with same-tenant references, audit and forced RLS. Assignment lifecycle, F4 active filtering, duplicate semantics, and inventory ID remain for owner confirmation. No DDL, database access, application code, test, commit, or push. | Agent |
| 1.88 | 2026-10-14 | **OVXK database stage implemented and applied (B-170, §26.186; D-102).** Added the tenant-scoped many-to-many assignment relation with unique composite key, two-char channel check, same-tenant foreign keys, audit columns, reverse index and RLS policy/grants. Backfilled existing pairs implied by Sales Areas. Both migrations applied to the static test database; read-only verification confirmed 1 mapping, no Sales Area lacking a mapping, and forced RLS. Tests/UI remain deferred; no commit or push. | Agent |
| 1.89 | 2026-10-14 | **OVXK backend functions implemented (B-171, §26.187).** Added tenant-scoped active-only F4 sources, assignment listing, pair locking, definition/prerequisite checks, idempotent assign, and audited unassign blocked by any dependent Sales Area. Registry/actions/UI/supporting defaults and deactivation guards remain for the next stage; no typecheck/tests were run, and no commit or push occurred. | Agent |
| 1.90 | 2026-10-14 | **OVXK supporting functions implemented (B-172, §26.188).** Registered activity/capability and OVXK alias (registry correctly marked `TIER_3_MAPPED` pending UI), backfilled existing-tenant status, gated Sales Area setup on the assignment, added an audited `1000/01` default for new tenants and completion marking, protected OVX5/OVXI deactivation from active mapping dependencies, and added localized exact-capability assign/unassign actions. Applied the global seed to the owner-provided static test DB; read-only checks found the code/alias once and tenant `0100` completed with `1000/01`. No UI, typecheck, test, commit or push; UI begins only after the OVXK form is restated and the owner supplies remaining UI details. | Agent |
| 1.91 | 2026-10-14 | **OVXK UI stage implemented, acceptance deferred (B-173, §26.189).** Owner confirmed the field/lifecycle contract was sufficient for a Cairn-native, SAP-familiar page. Added active-only F4 lookup and mapping maintenance, responsive assignment listing/removal confirmation, and a capability-gated link from Sales Organization definitions. Registry remains `TIER_3_MAPPED` pending acceptance. No typecheck/build/tests, commit or push; tests/acceptance are the next separate stage. | Agent |
| 1.92 | 2026-10-14 | **Owner-directed OVXK push before browser acceptance (B-174, §26.190; D-103).** Owner directs that the browser test wait for renewed approval but authorizes pushing the current implementation now. The complete OVXK batch is committed locally as `9e689ac` for publication under this instruction. This OVXK-only exception does not change the post-acceptance push rule for future UI work. No browser test, typecheck or build was run; the code remains unverified and the registry remains `TIER_3_MAPPED` pending acceptance. | Agent |
| 1.93 | 2026-10-14 | **OVXA owner fields received; database design remains pending lifecycle approval (B-175, §26.191; R-37).** Captured required Sales Organization (`CHAR 4`, F4 from OVX5) and Division (`CHAR 2`, F4 from OVXB). Repository review found no explicit Sales Organization/Division mapping table; a tenant-scoped pair relation with audit, RLS and Sales Area-derived backfill is proposed. Cardinality, duplicates, removal/history, active-only selection and definition prerequisites remain for owner confirmation. No schema, migration, database or application changes. | Agent |
| 1.94 | 2026-10-14 | **OVXA database/schema stage implemented and applied (B-176, §26.192; D-104).** Added the tenant-scoped Sales Organization/Division assignment relation and applied migrations `0029`/`9024` to the static test database. Read-only checks verified 2 migration records, 1 mapping, no Sales Area lacking its pair, forced RLS and the tenant policy. Default mappings, backend/supporting functions, UI and tests remain subsequent distinct stages. `git diff --check` passed; no commit or push. | Agent |
| 1.95 | 2026-10-14 | **OVXA backend assignment services implemented (B-177, §26.193).** Added tenant validation, active-only F4 choices, assignment listing, active-definition and prerequisite checks, idempotent pair creation, audited removal blocked by Sales Areas across all channels, and the shared pair-lock contract for future Sales Area creation. `npm run typecheck` passed. Behavioral tests remain for their distinct later stage; supporting functions, UI, commit and push are not done. | Agent |
| 1.96 | 2026-10-14 | **OVXA supporting functions implemented (B-178, §26.194).** Registered exact activity/capability, OVXA registry alias, and Sales Area prerequisite; backfilled existing Division/assignment statuses; added audited standard-tenant `1000/01` mapping/completion; guarded OVX5/OVXB deactivation while assigned; added capability-protected server actions and localized messages without a page. Global seed applied to static test DB; read-only verification confirmed the metadata, prerequisite, tenant `0100` completion, one mapping, and no Sales Area missing its pair. Typecheck and whitespace checks passed; no behavioral tests, UI, commit or push. | Agent |
| 1.97 | 2026-10-14 | **OVXA UI implemented (B-179, §26.195).** Added responsive Division assignment page, active-only F4 search dialogs, required field validation, assignment/current-list views, inactive-definition indicators and confirmed removal flow; added capability-gated navigation from Sales Organization and Division definitions. `npm run typecheck` passed. Browser acceptance and other behavioral tests remain the next stage; registry stays `TIER_3_MAPPED`. No production build, commit or push. | Agent |
| 1.98 | 2026-10-14 | **OVXA tests/acceptance passed and code published (B-180, §26.196).** Typecheck passed, browser-harness 274/274 across 52 files, OVXA service tests 7/7, and the guarded local-PostgreSQL browser target passed with `T973` cleanup verified. Commit `7f79695` pushed to `main`; no remote DB used. Owner reports OVXK local acceptance passed; the VM did not run OVXK. | Agent |
| 1.99 | 2026-10-14 | **OVXG owner rules captured and database stage implemented (B-181, §26.197; D-105).** Recorded the three required keys, Name limit/edit policy, all-existing linked F4, idempotent duplicate, soft deactivation/reactivation and customer-Sales-Area dependency guard. Added Sales Area key-format/name checks and composite OVXK/OVXA assignment FKs; migration `0030` applied to local `cairn` only. Typecheck passed; no backend/UI/tests/commit/push. | Agent |
| 2.00 | 2026-10-14 | **OVXG backend functions implemented (B-182, §26.198).** Added tenant-local F4/list/create/name-change/deactivate/reactivate functions with linked OVXK/OVXA validation, pair locking, prerequisite checks, idempotency, audit history and optimistic versions; customer Sales Area saves now serialize against deactivation. Typecheck passed; supporting functions, UI and tests remain separate later stages. No commit or push. | Agent |
| 2.01 | 2026-10-14 | **OVXG supporting functions implemented (B-183, §26.199).** Registered the sales-area capability and OVXG term/alias, backfilled existing tenant checklist state from existing rows without overwriting progress, and audited the onboarding default area on insertion. Typecheck and local seed/read-only metadata checks passed; no UI/tests/commit/push. | Agent |
| 2.02 | 2026-10-14 | **SCR-024 / OKKP owner field intake and preliminary DB design (B-184, §26.200; R-38).** Recorded the supplied controlling-area key, names, assignment-control, currency and fiscal-year fields. Repository review found existing tenant-scoped controlling-area and separate company-code assignment tables; the design proposes reusing the master, adding the optional organizational name, enforcing the supplied field limits and preserving OX19 as separate scope. Assignment-control values/cardinality and backfill, currency width, F4 filters, and lifecycle/key behavior remain owner-confirmation gates. No DDL, application code, database access, test, commit or push. | Agent |
| 2.03 | 2026-10-14 | **SCR-024 / OKKP database stage completed (B-185, §26.201; R-39; D-106–D-110).** Reused the existing Controlling Area master; added the optional 30-character organization name, required single/multiple Company Code scope with count-based backfill, 30-character Name limit, two-character Fiscal Year Variant, checks and currency/variant references. Migration `0031_controlling_area_definition.sql` applied only to local `cairn`; read-only checks found zero Controlling Areas/assignment rows. Typecheck and diff check passed. No backend, supporting functions, UI or tests. Owner also set a standing pre-test publication rule (D-111): push changes without waiting for UI tests, which remain deferred. | Agent |
| 2.04 | 2026-10-14 | **SCR-024 database stage published (B-186; R-40/D-111).** Commit `9a7a82c` (`feat: add SCR-024 controlling area schema`) was pushed to `origin/main` as a fast-forward from `b5f923b`. The change includes the schema/migration and design log; only the local `cairn` database received migration `0031`. No UI test or acceptance ran, per the standing owner instruction. | Agent |
| 2.05 | 2026-10-14 | **SCR-024 Assignment Control and activity-lock contract clarified; backend services implemented (B-187, §26.203; R-41; D-112–D-114).** Owner supplied the exact 1:1 and 1:N dropdown wording, the cross-company Operational Chart of Accounts/Fiscal Year Variant prerequisite, the post-transaction Currency/Fiscal Year Variant lock, and duplicate-create no-op semantics. Added tenant-scoped list/F4/create/change services with audit versions, scope/cardinality guards, reference validation and activity checks over assigned Company Codes. Typecheck passed after restoring dependencies; no behavioral/UI tests ran. Supporting-function and UI stages remain separate; UI tests are deferred. | Agent |
| 2.06 | 2026-10-14 | **SCR-024 backend services published (B-188; R-40/D-111).** Commit `ffb8a02` (`feat: add SCR-024 controlling area services`) was pushed to `origin/main` as a fast-forward from `227511d`. The backend and SCR-024 log are published before UI testing, per the standing owner instruction. Typecheck passed; no behavioral/UI tests or acceptance ran. | Agent |
| 2.07 | 2026-10-14 | **SCR-024 Assignment Control UI copy preserved (B-189; R-42; D-115).** Recorded the owner-supplied heading, control description, both option labels and descriptions, and the general scope explanation verbatim for the later OKKP UI stage. No UI changes or tests were made. | Agent |
| 2.08 | 2026-10-15 | **SCR-024 supporting functions implemented (B-190, §26.206).** Journal posting now acquires the shared Controlling Area row lock before database reads/writes; the standard package explicitly seeds A000 as SINGLE. Existing journal indexing was confirmed; code comments define the required early lock plus same-transaction indexing contract for future non-journal operational documents. No such non-journal transaction path currently exists in `src`. Typecheck passed; no behavioral/UI tests or database changes. | Agent |
| 2.09 | 2026-10-15 | **SCR-024 / OKKP UI implemented; UI tests deferred (B-191, §26.207; D-112–D-115).** Added the responsive Controlling Area definition and maintenance page using the exact owner-supplied Assignment Control copy, active-only Currency F4, all-definition Fiscal Year Variant F4, audited edits, immutable keys and server-provided financial-field lock state. The OX19 assignment activity remains explicitly pending. Typecheck passed; no browser/UI/behavioral tests, acceptance or database changes. | Agent |
| 2.10 | 2026-10-15 | **SCR-024 / OKKP UI published before UI tests (B-192; R-40/D-111).** Commit `bf7c552` (`feat: add SCR-024 OKKP maintenance UI`) was pushed to `origin/main` as a fast-forward from `debe23a`. The UI implementation is published; UI/browser tests remain deferred. | Agent |
| 2.11 | 2026-10-15 | **SCR-024 static UI contract tests added and run; browser acceptance blocked by unavailable local DB (B-193).** The targeted no-database contract suite passed 7/7. Full browser-harness suite reported 279/281 passed; 2 unrelated legacy vendor-code scans fail on `VKORG`/`VTWEG`/`SPART` entries already present before the SCR-024 UI. No Playwright/browser run or DB test was possible: `.env.local`/database environment variables are absent, local PostgreSQL is not installed/listening at `127.0.0.1:5432`, and no remote DB was contacted. Typecheck passed. | Agent |
| 2.12 | 2026-10-15 | **SCR-024 contract-test results published (B-194).** Commit `c820b95` (`test: add SCR-024 OKKP UI contracts`) was pushed to `origin/main` as a fast-forward from `574e364`. It contains the targeted no-DB contract tests and their harness registration. Browser acceptance remains pending local database availability. | Agent |
| 2.13 | 2026-10-15 | **SCR-024 edit-form event defect corrected and pushed (B-195).** Live browser testing exposed a React `currentTarget` timing error in OKKP name edits; values are now captured synchronously before state updates. Commit `1b3b888` was pushed before acceptance was rerun. Typecheck and diff checks passed. | Agent |
| 2.14 | 2026-10-15 | **SCR-024 / OKKP local browser acceptance passed (B-196).** The isolated `controlling-area` target passed on PostgreSQL 17.11 with local-only roles; `T972` and the synthetic document-index fixture were cleaned. Targeted no-DB tests passed 65/65; full browser-harness result was 281/283 with the same two unrelated baseline Sales Area-code scans failing. No remote DB, OVXK or OVXA target was used. Target code is in commit `8a5e8fb`; OX19/SCR-025 remains separate. | Agent |
| 2.15 | 2026-10-15 | **Owner changed the future T-code delivery order to UI-first (B-197, §26.213; R-43/D-116).** Future page work now proceeds UI → DB/schema → backend → supporting functions → tests/acceptance in separate stages. The pre-UI owner-field gate and all publication/test safeguards remain. SCR-025/OX19 is still awaiting its owner-supplied field contract. | Agent |
| 2.16 | 2026-10-15 | **SCR-025/OX19 form fields and prerequisite rules recorded (B-198, §26.214; R-44).** Captured both required Char 4 lookups and the Company Code/Controlling Area existence, exact Operational Chart of Accounts and Fiscal Year Variant matching rules, plus the multi-company currency-alignment rule. Exact currency comparison, relationship reverse-cardinality, assignment lifecycle/audit, F4 eligibility and authorization remain owner-confirmation gates; no UI or implementation work began. | Agent |
| 2.17 | 2026-10-15 | **OX19 assignment semantics selected and captured (B-199, §26.215; R-45/D-117).** Recorded add/unassign/reassign, duplicate no-op, old/new history, OKKP-controlled 1:1/1:N cardinality, one Controlling Area per Company Code, all-existing tenant-local F4 and multi-company local-currency equality to the Controlling Area Currency Key; use existing master-data permissions. UI remains gated on mapping removal representation, atomic reassign semantics, duplicate-attempt audit, 1:1 currency scope, and permission-combination details. | Agent |
| 2.18 | 2026-10-15 | **OX19 audit, currency and permission rules clarified (B-200, §26.216; R-46/D-118).** Duplicate assignments are state no-ops but create audit events; reassignment is separate unassign then assign; currency-key equality applies in both 1:1 and 1:N; both existing master-data permissions are required. Whether unassignment removes the current row or retains it inactive remains owner-confirmation pending. No UI or implementation work began. | Agent |
| 2.19 | 2026-10-15 | **SCR-025/OX19 contract completed (B-201, §26.217; R-47/D-119).** Owner confirms unassignment removes the current relationship while immutable audit history is retained. The full assignment, compatibility, cardinality, F4, duplicate, currency and authorization rules are now closed. No product code or DB work in this intake batch; the UI stage is next under R-43. | Agent |

---

*End of this part for now. This part is the live canonical log: it is updated in the same turn as any
change to code, schema, decision or scope (§0.1). When it passes 360,000 bytes, the next part
`CAIRN-4.md` begins and this file states that the set continues there (§0.3 / D-093).*
