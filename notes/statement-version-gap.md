# Financial statement version — gap analysis and the smallest plan-aligned resolution

Investigated 2026-10-28 on the dedicated test box, database `cairn`, tenant `W100`.
Nothing in this document is inferred from what an SAP-like system normally has: every
rule below is quoted or read out of this repository, and every claim about behaviour was
executed. No file in the repository was changed by this investigation.

---

## 1. Headline: the gap is narrower than `notes/coverage-reconciliation.md` said

That note records the three closing reports as **"unsupported: no implemented writer"**,
with the sentence *"no `insert into financial_statement_version` exists in `src/`"*. The
second half is true and still true — there is no **module** or **screen** that writes the
version. The conclusion was too broad: a supported provisioning path does exist, and I
had not found it.

| path | what it does | verified state |
|---|---|---|
| `scripts/seed.ts:977-1015`, invoked by **`npm run seed`** (and by `npm run bootstrap`, whose step 2 is this script) | *"Seeding the standard financial statement version…"*: inserts version `INT` / *International financial statement* on chart `CA01`, 8 nodes (`BS`→`ASSETS`,`LIAEQ`→`LIABILITIES`,`EQUITY`,`PL`→`REVENUE`,`EXPENSES`), 5 account-range assignments with presentation signs — all guarded by `where exists (select 1 from chart_of_accounts … 'CA01')` and `on conflict do nothing` | `cairn_b210`: `0100/INT(CA01,active=true)`, nodes=8, assignments=5. `cairn` and `cairn_demo` before this probe: **no rows at all** (0/0/0) |
| `scripts/browser-smoke/{trial-balance,balance-sheet,profit-loss}.ts:33-54` | the browser-acceptance journeys build their own version `T01` with **four nodes and two assignments via `tx.execute(sql\`insert into financial_statement_…\`)`** | read 2026-10-28; a smoke target that writes configuration by hand is itself the evidence that no service call is available to it |
| `src/app/finance/{trial-balance,balance-sheet,profit-loss}/` | the three screens are **read-only pages**: `page.tsx` calls `requireSession`, `can(session, TRIAL_BALANCE_CAPABILITY)`, `listStatementVersions(...)` and defaults `statementVersion: params.statementVersion ?? versions[0]?.version ?? ''`; there is **no `actions.ts`** in any of the three directories | so a tenant with no version shows an empty selector and the module's refusal, never a form to define one |

So the accurate statement of the gap is:

> The statement version is **delivered at installation** (the standard data seed) and is
> **not maintainable in the application**: no module function, no configuration activity,
> no capability code and no screen writes `financial_statement_version`,
> `financial_statement_node` or `financial_statement_assignment`.
> A tenant created *after* the installation seed — which is exactly how `cairn`,
> `cairn_demo` and every `--fresh` test database is created — has nothing to report on,
> because the seed's insert joins `client` rows that did not exist yet.

That last clause is the mechanism of the three skipped steps, and it is worth stating
plainly: the walkthrough seed calls `createTenant` + `applyStandardStructure` and never
runs `npm run seed`, so the ordering (`clients exist → then the version joins them`) is
never satisfied for its tenant.

## 2. What a usable version must satisfy — read out of the code, not invented

### 2.1 The schema (`drizzle/0115_financial_statement_version.sql`, `src/modules/finance/schema.ts:1886-1930`)

| table | keys and constraints, verbatim |
|---|---|
| `financial_statement_version` | PK `(client, version)`; `version varchar(10)`, `name varchar(80)`, `chart_of_accounts varchar(4)`; `is_active boolean not null default true`; FK `(client, chart_of_accounts) → chart_of_accounts ON DELETE CASCADE`; FK to `client` |
| `financial_statement_node` | PK `(client, version, node)`; `node varchar(20)`, `description varchar(120)`, `parent_node varchar(20)` nullable, `sequence integer default 0`; FK `(client, version) → financial_statement_version ON DELETE CASCADE`; **self-FK** `(client, version, parent_node) → financial_statement_node (client, version, node) ON DELETE CASCADE`; `CHECK (parent_node is null or parent_node <> node)` |
| `financial_statement_assignment` | PK `(client, version, node, account_from, account_to)`; `account_from`/`account_to varchar(10)`; `presentation_sign varchar(8) default 'NORMAL'` with `CHECK (presentation_sign in ('NORMAL','INVERTED'))`; `CHECK (account_from <= account_to)`; FK to the node `ON DELETE CASCADE` |

The migration's own header states the lifecycle: *"Configuration only — the statement
derives balances from the posted journal and **persists nothing**."* It also adds
`journal_entry (client, company_code, fiscal_year, posting_period)`, which the report
aggregation depends on (`tests/balance-sheet-index-contract.test.ts` guards that index).

### 2.2 The rules the readers enforce (`src/modules/finance/trial-balance.ts:110-151`; `balance-sheet.ts` repeats the same block)

1. `ledger` must be in `STATEMENT_LEDGERS = ['0L']` — *"Ledger X is not configured."*
2. `fiscalYear` integer 1900-2199; `1 ≤ periodFrom ≤ periodTo ≤ 16`, else *"The period range is invalid."*
3. The company code must stand, and **the version's chart must equal the company's chart**:
   *"Statement version %s binds to chart X, but company Y uses Z."*
4. The version row must exist — *"Financial statement version %s does not stand."* with the
   remedy *"Configure the FSV first."* — and must be active (*"stands inactive."*).
5. `if (nodes.length === 0) fail("Statement version %s has no nodes.")` — one node is the floor.
6. Nodes are read ordered by `sequence, node`; depth is derived from `parent_node`.
7. Assignments are resolved over the accounts that actually have postings: the **first node in
   statement order wins** for an account covered twice, and the double coverage is reported as a
   warning rather than double-counted (`trial-balance.ts:205-221`).
8. Accounts with postings but no assignment are **not** dropped silently: they return in
   `unassigned` and produce a warning; an account missing from the chart likewise warns.
9. Period 13-16 only count when `includeSpecialPeriods` is set, otherwise the cutoff is clamped
   to 12 with a warning.
10. `balance-sheet.ts` adds `calculationType ∈ BALANCE_CALCULATION_TYPES = ['ACCUMULATED',
    'MOVEMENT', 'COMBINED']` and `summaryLevel` within `MIN/MAX_SUMMARY_LEVEL`;
    `currentYearResult` is non-null **only** under `COMBINED` (`:338`).
11. `profit-loss.ts` does not re-read the version: it consumes the balance-sheet result and keeps
    the accounts where `!isBalanceSheet` (`:95-151`). The P&L/balance-sheet split therefore comes
    from `gl_account.is_balance_sheet`, which the schema pins by check to `gl_account_type`
    (`finance/schema.ts:108-120`) — **not** from anything in the version.
12. Tenant scoping: no RLS on these three tables (`pg_class.relrowsecurity = false`, measured on
    `cairn`); isolation is entirely `withTenant(client, …)` plus an explicit `client = ${client}`
    predicate in every query. The app role has the DML it needs
    (`information_schema.role_table_grants`: `SELECT, INSERT, UPDATE, DELETE` for `cairn_app` on
    all three tables) — so no grant work is required to write them from a service.

### 2.3 The minimum that makes all three screens answer

From 3-6 above, and no further accounting doctrine: **one** version row bound to the company's
own chart and active, **at least one** node, **at least one** assignment whose range covers an
account that carries postings. Everything else (the eight-node hierarchy, the inverted signs) is
the quality of the presentation, not a precondition. The shipped standard is 8 + 5 because a
useful statement needs the balance-sheet side and the P&L side separated with signs, and because
`COMBINED` reports the year's result in equity terms.

## 3. Measured proof that this is all that was missing

Experiment on `cairn` / `W100` (the tenant already carrying slices A-E), 2026-10-28:

```
== pre-state: statement versions standing for W100            → (none)
== npm run seed   → seed_exit=0, log line: "Seeding the standard financial statement version…"
== post-state: version=INT chart=CA01 active=true nodes=8 assignments=5
== trial balance INT: 8 node(s), 0 unassigned, 0 warning(s)
     debit turnover 5349359.60 / credit turnover 5349359.60 in INR, chart CA01
     node BS (depth 0) 6607732.80 · ASSETS (depth 1, 6 accounts) 3010726.80
     LIAEQ (depth 1) 3597006.00 · LIABILITIES (depth 2, 3 accounts) 296606.00
== balance sheet ACCUMULATED/MOVEMENT/COMBINED (level 1): 2 node(s), 0 unassigned,
     result null / null / -586279.20                            (COMBINED only, per rule 10)
== profit and loss ACCUMULATED/MOVEMENT/COMBINED: 1 node(s), 0 rows outside the hierarchy
== refusal for an unknown version, verbatim: "Financial statement version NOPE does not stand."
== ledger cross-check, FY2026 periods 1-9, company 1000: debit=5349359.6000 credit=5349359.6000
```

The turnover the trial balance reports equals the direct ledger sum to the last decimal, which is
the read-back that the derivation is honest and that nothing was persisted by the run. The probe
file was deleted after the run (`tmp-fsv-check.ts` never entered the repository).

**Status of the three capabilities after this experiment:** *calculation executed with read-back
evidence* on `cairn`, with the standard `INT` version installed by the documented `npm run seed`.
Browser acceptance of `/finance/trial-balance`, `/finance/balance-sheet` and `/finance/profit-loss`
was still not run at the time of writing; it has since been done on `cairn_b210` under a read-only
ruling, with the trial balance and the invalid-version refusal checked against the services — see
§7.4 and `notes/statement-version-browser-acceptance.md`, where standing a tenant in a browser stays
out of reach because creating one is a write. A user without `FIN.RPT.*`/`FIN.*`/`*` sees the page's "no authority"
state; `CONTROLLER` holds `FIN.RPT.*`, `ACCOUNTANT` holds `FIN.*`, `CONFIGURATOR` holds `CFG.*`,
`ADMINISTRATOR` holds `*` (`role_capability`, measured on `cairn` and identical on `cairn_b210`),
so the capability patterns already cover any new `CFG.FIN.*` code without a grant change.

## 4. Proposed resolutions, smallest first

### Option A — install the standard version in the onboarding flow *(recommended; smallest plan-aligned production change)*

The repository's own rule for this data is on the first line of the seed that currently carries it:
*"Tenant-specific data belongs in the onboarding flow, not here"* (`scripts/seed.ts:6`). The
onboarding flow is `applyStandardStructure` / `applyStandardStructureInTransaction`
(`src/platform/tenancy/standard-structure.ts:166-205`), which already builds the chart, the company
code, the controlling area and the plants for a client in one transaction — and which the walkthrough
seed, `create-dev-tenant` and every acceptance database run. Moving (not copying) the FSV block there
means a tenant can never be created without the statement its reports need, and `npm run seed`'s
`on conflict do nothing` block can then be reduced to a backfill for pre-existing tenants.

Files:
* `src/platform/tenancy/standard-structure.ts` — one more step in `applyStandardStructureInTransaction`,
  inserting the same 1 + 8 + 5 rows through the drizzle tables already defined in
  `src/modules/finance/schema.ts` (no SQL, no new table, `onConflictDoNothing` so re-running is safe).
* `scripts/seed.ts` — replace lines 977-1015 with a backfill comment pointing at the onboarding step,
  or keep it verbatim as the idempotent backfill (owner's preference; it is already `on conflict do nothing`).
* No migration for schema. Optionally `drizzle/9xxx_statement_version_onboarding.sql` inserting the
  standard version for tenants that already exist and lack it, in the shape of
  `9106_omsk_valuation_class.sql`'s backfill block.
* Tests: extend the standard-structure test with "a new tenant can immediately run a trial balance"
  (call `listStatementVersions` then `calculateTrialBalance`), and a re-entrancy test (apply the
  structure twice, assert 8 nodes still).

Schema implications: none — the tables, keys and checks already exist.
Authorization: none — a structure step is not a user-facing activity, so no capability is needed.
Effort: ~40 lines of production code plus one test file.

### Option B — a real configuration activity (`Define financial statement version`) *(the complete answer, larger)*

Only if the owner wants the version maintainable rather than merely present. Modelled exactly on the
house pattern for config writers, `src/modules/foundation/account-determination.ts`:

* `src/modules/finance/statement-version.ts` — `export const ACTIVITY = 'CFG.FIN.STATEMENT.DEFINE'`;
  `getStatementVersion`, `listStatementNodes`, `listStatementAssignments`,
  `saveStatementVersion`, `saveStatementNode`, `saveStatementAssignment`, plus the three deletes;
  each input a zod schema (`version` 1-10, `name` ≤80, `node` ≤20, `description` ≤120,
  `accountFrom`/`accountTo` ≤10 with `from ≤ to`, `presentationSign ∈ NORMAL|INVERTED`), each write
  inside `withTenant`, `select … .for('update')` on the header, `CREATE`/`CHANGE` existence
  refusals, `recordChange(tx, {objectClass, objectKey, changeType, transactionCode: ACTIVITY,
  reason, after, fieldLabels, securityRelevantFields: ['accountFrom','accountTo']})` and
  `markActivityComplete(tx, client, ACTIVITY, changedBy)` — the same spine as OBYC's writer.
* Rules the service must not over-claim, taken from §2.2: overlapping ranges are *tolerated* by the
  readers (first node wins + warning), so the writer may warn but must not assert exclusivity; a node
  delete **cascades** to its assignments by FK, so deleting a node is a real removal and must be
  refused while a child node references it (the self-FK cascades too, which is worth surfacing rather
  than relying on); an assignment may name an account range with no `gl_account` rows behind it — the
  readers accept that today, and whether to validate it against the chart is a decision for the owner
  (see §5).
* `src/app/config/financial-statement-versions/{page.tsx,actions.ts,StatementVersionShell.tsx}` —
  the three-panel screen (header, node tree, assignment table), `requireCapability(ACTIVITY)` in
  `actions.ts`, `assertChangeForSession({lockObject: 'FINANCIAL_STATEMENT_VERSION', argument:
  version + '/' + node})` for CHANGE, `revalidatePath`, and the three report pages left untouched so
  their selectors simply start finding versions.
* `drizzle/9xxx_scrXXX_statement_version.sql` — `capability` insert, `config_activity` insert
  (`area='FINANCIAL_ACCOUNTING'`, `kind='DEFINE'`, `prerequisites='CFG.FIN.COA.DEFINE'`,
  `route_path='/config/financial-statement-versions'`, `wizard_stage='STANDARD'`),
  `config_activity_status` backfill by `EXISTS (select 1 from financial_statement_version)`,
  `term_registry` + `term_alias` rows, in the order and style of `9106_omsk_valuation_class.sql`.
  No `role_capability` insert is needed: `CFG.*` already grants it to `CONFIGURATOR`.
  RLS/grants: the three tables predate the policy convention; if the owner wants parity with new
  config tables, `ENABLE/FORCE ROW LEVEL SECURITY` + the `tenant_isolation` policy belongs in this
  migration — a deliberate, separately reviewable choice, since every reader already names the client.
* `src/platform/i18n/index.ts` — message keys in the `acctDet.*` style (`stmtVer.created`,
  `stmtVer.changed`, `stmtVer.unchanged`, `stmtVer.unexpected`, …).
* Tests: `tests/statement-version.test.ts` (validation refusals, CREATE/CHANGE, idempotent re-save,
  two-tenant isolation via `createTenant`, audit row appears, deactivating a version makes
  `calculateTrialBalance` refuse with "stands inactive"); a report test that **replaces** the raw
  fixture in `tests/trial-balance.test.ts:38-54` with the service, then runs all three calculations;
  `tests/config-activity-registry.test.ts`-style assertions for the new migration's rows.
* Browser acceptance on the dedicated box only: a `scripts/browser-smoke` target that creates the
  version through the screen instead of `tx.execute(sql…)`; the existing three targets then either
  keep their own `T01` fixture or switch to the service.

### Option C — walkthrough seed only *(no production code, zero risk, does not close the gap)*

Insert the standard 1 + 8 + 5 rows in the execution copy's finance-configuration step, mirroring
`scripts/seed.ts:977-1015` verbatim, exactly as slices A and D seed `account_determination`,
`credit_risk_category` and the number ranges. This makes the walkthrough show real statements and
turns the three skipped steps into executed evidence; it changes no behaviour for any tenant and
claims no new capability code. It must be reported as what it is: **the seed standing in for a
missing activity**, not the activity existing.

**Recommendation:** Option A, plus Option C for this walkthrough run so the three report steps stop
being skipped while A lands. Option B only if the owner wants controllers to maintain the hierarchy
themselves — which is the part of the gap that is genuinely a product decision.

## 5. Open business rules to confirm before any code (these are decisions, not omissions)

1. Is the standard `INT` version meant to be every tenant's default (Option A implies yes), or only
   what the installation seed offers?
2. Does a node deletion cascading away its assignments (§4 Option B, from the FK) match the intent,
   or must the writer refuse while an assignment names the node?
3. Overlapping account ranges: the readers warn and pick the first node. Should the writer refuse a
   range that overlaps a sibling, or preserve the reader's tolerance?
4. Assignment ranges are not checked against `gl_account` today. Should saving refuse a range with no
   account in the chart behind it?
5. The P&L/BS distinction comes from `gl_account.gl_account_type`, not from the version. Confirm the
   version is presentation-only and must not carry its own kind flag.
6. `currentYearResult` exists only under `COMBINED`. Confirm the balance-sheet screen's default
   calculation type for a walkthrough, so the number the user sees first is the one the seed proves.

## 6. Acceptance criteria for whichever option is taken

* A tenant created by the chosen path answers `listStatementVersions` with the standard version
  (for `cairn`/`W100` today that returned `[{"version":"INT","name":"International financial
  statement","chartOfAccounts":"CA01"}]`).
* `calculateTrialBalance` over FY2026 periods 1-9 returns 8 nodes, 0 unassigned, 0 warnings, and
  debit turnover equal to credit turnover **and** equal to a direct `journal_entry_line` sum for the
  same company, year and periods (measured: 5349359.60 / 5349359.60 / 5349359.6000).
* `calculateBalanceSheet` and `calculateProfitLoss` return at least one node each, and
  `currentYearResult` is non-null only under `COMBINED` (measured: null, null, −586279.20).
* The refusal strings of §2.2 still appear for the states they describe — an unknown version, an
  inactive version, a wrong chart, an empty node set — so a fix does not quietly delete a guard.
* For Option B additionally: the screen saves, the change document names the security-relevant
  fields, the config activity flips to `COMPLETED`, the report page's selector shows the new
  version, and the walkthrough/`--fresh` databases no longer need a hand-written fixture.
* Evidence stays separated as it has been throughout: type check, runtime exit code, database
  read-back, and browser acceptance are four different claims, and only the first three exist today.

## 7. Resolution as implemented (Options A and C)

Option B — the configuration activity, a `statement-version.ts` writer, and the registry migration —
was not authorized and has not been built. What follows is what A and C became.

### 7.1 A — the version stands with the tenant

`src/modules/foundation/standard-config.ts` (656 → 760 lines):

* `STANDARD_STATEMENT_VERSION` is now the **only** definition of the standard layout in the
  product: version `INT`, name `International financial statement`, the eight nodes and the five
  account ranges, copied verbatim from the installation seed so that no numbers moved.
* `applyStandardPackage` writes it inside the tenant's own creation transaction, after the retained
  earnings determination and before the fiscal-year variants: the header (bound to the chart the
  package just created), then the nodes in catalogue order (parents before children, which the
  self-referencing FK needs), then the assignments. Every insert is `onConflictDoNothing()` on the
  same `tx`, like the rest of the package, so a repeated activation and the seed's backfill are both
  no-ops.
* `PackageResult` gained `statementVersion`, and the package's change document now names
  `statementVersion`, `statementNodes` and `statementAssignments` — read back from
  `change_document_item` after the run.
* `STANDARD_PACKAGE_VERSION` moved `'INTL-STD-3'` → `'INTL-STD-4'`, because the artefacts a tenant
  receives changed; `tests/tenant-creation-service.test.ts` asserts the new value.

`scripts/seed.ts` keeps its statement-version block, re-commented as what it now is: the backfill
for tenants an earlier package created, pointing at `STANDARD_STATEMENT_VERSION` as the owner. It
is not a second definition and it was not changed in behaviour.

Schema, constraints, isolation, transaction boundary and report semantics are untouched: the
inserts go through the existing drizzle tables, with `client` on every row, inside the transaction
the caller opened, and no reader or column was edited.

### 7.2 C — the walkthrough's own step

`notes/walk-e.ts` gained one step, *statement version: the layout the closing reports read, from the
standard package*, ahead of the closing-reports step. It calls `listStatementVersions`; it inserts
only when the version does not stand, and even then it inserts the package's own
`STANDARD_STATEMENT_VERSION` rows through the same tables and the same `onConflictDoNothing`, so the
walkthrough can never become a competing standard. It persists no report output: the three reports
are calculated by `calculateTrialBalance`, `calculateBalanceSheet` and `calculateProfitLoss`.

### 7.3 The six decisions of §5, disposed of

1. `INT` as the onboarding default — authorized by this brief (Option A); implemented in the package.
2. Node deletion cascading away assignments — still open: A and C add no delete path, and Option B
   (which would need one) is not authorized.
3. Overlapping ranges stay tolerated by the writer-less path — no refusal was added.
4. Ranges are not validated against `gl_account` — kept, and moot for the standard rows because they
   are derived from the shipped chart.
5. The version stays presentation-only; no kind flag was added.
6. `currentYearResult` non-null only under `COMBINED` — asserted as such in
   `tests/statement-version-onboarding.test.ts` rather than redefined.

One finding the implementation deliberately did **not** "fix": the shipped `EXPENSES` range ends at
`599999`, and the chart carries three accounts above it (`600000`, `610000`, `620000` — the cost
centre allocation and assessment band). Widening the range would change an established statement, so
the rows stand as the reference defines them and the three accounts remain reachable but outside the
statement; `gl_account` rows outside the assigned ranges were counted in the run: 3. The owners
still have to decide whether that band belongs in the financial statement.

### 7.4 Evidence, separated as always

* **type check**: `npx tsc --noEmit` on the tree — 188 error lines, of which **0** name
  `standard-config.ts`, `scripts/seed.ts`, `tests/statement-version-onboarding.test.ts` or
  `tests/tenant-creation-service.test.ts`; with the two untracked execution copies moved aside the
  count is 164, i.e. 24 of the 188 belong to the copies (12 each), the same pre-existing diagnostic
  set `walkthrough-seed.ts` carries. `npx tsc --noEmit -p tsconfig.sliceDE.json` — 12 own errors,
  none in slice E's added region.
* **tests**: `npx vitest run tests/statement-version-onboarding.test.ts
  tests/tenant-creation-service.test.ts tests/trial-balance.test.ts tests/balance-sheet.test.ts
  tests/profit-loss.test.ts tests/standard-structure-builder.test.ts
  tests/balance-sheet-index-contract.test.ts` on `cairn` (provisioned by
  `npm run test:db -- --database cairn --fresh --yes`) — 7 files, 28 tests, **all pass**. The new
  file's six cases: the version, nodes and ranges a new tenant stands; idempotency of a second
  package application; parents before children and range sanity; all three reports with trial-balance
  turnover compared against an aggregate over `journal_entry_line`; `currentYearResult` null under
  `ACCUMULATED` and non-null under `COMBINED`; the unknown-version refusal with remedy
  `Configure the FSV first.`; and a tenant created without the package standing nothing — the
  isolation case. No test inserts a version itself: tenants come from `createTenant` only.
* **full suite**: `npx vitest run` on the same database — 458 passed / 3 failed files, 3165 passed /
  7 failed tests, 461 files. The failing files are `tests/action-security.test.ts`,
  `tests/grir-clearing.test.ts` and `tests/production-order-writer-guard.test.ts` — the same
  3-file/7-test set the tree carried before this change, and no failure message in the run mentions
  a statement version, `financial_statement*` or `standard-config`.
* **runtime**: `npm run test:db -- --database cairn --fresh --yes` then
  `npx tsx walkthrough-seed-sliceDE.ts --client=W100` (copy md5 `9e8928e416a5748f958bbcc167043c9f`,
  identical on both sides) — exit 0, `WALKTHROUGH READY`, 2 skipped steps (vendor clearing and
  dunning, both blocked by data as before; the closing-reports step that used to be skipped now
  runs). The coverage block has 136 lines for 136 distinct codes; measured with the same extraction
  the archived pre-change run log gives 133, and the difference is exactly the three `FIN.RPT.*`
  codes.
* **database read-back** on `cairn`: `version row: client=W100 version=INT chart=CA01 active=true
  created_by=WALKTHROUGH`, 8 nodes, 5 ranges (`100000-199999→ASSETS/NORMAL`,
  `200000-279999→LIABILITIES/INVERTED`, `280000-299999→EQUITY/INVERTED`,
  `300000-399999→REVENUE/INVERTED`, `400000-599999→EXPENSES/NORMAL`), 0 orphan child nodes, 0 rows
  violating the self-parent CHECK, 0 inverted ranges. The seed's backfill ran *during* provisioning,
  when the database held 0 clients, and `created_by` on the standing row is the walkthrough actor —
  so the rows came from onboarding, not from a later `npm run seed`. The trial balance covered
  `5349109.60` debit against `5349109.60` credit on version `INT`, 8 rows, 0 warnings, 0 unassigned.
* **the guarded databases**: read-only counts only — `cairn_b210` still 1 client / 1 version / 8
  nodes / 5 ranges, `cairn_demo` still 1 client / 0 / 0 / 0. `walkthrough-seed.ts` is byte-identical
  (`b31cf1c5255101df9e0f0e74f66aefc7`), no owner file was touched, nothing was committed or pushed.
* **browser acceptance: run for the screens, not for the onboarding write.** `/finance/trial-balance`,
  `/finance/balance-sheet` and `/finance/profit-loss` were opened in headless Chromium against the
  served production build on `cairn_b210` under the owner's read-only ruling: 12 of 17 steps passed,
  none failed, and creating a tenant — which is what steps 1 and 2 of that journey need — stayed out
  of reach, so it remains service-level evidence. The run, its five measurements of read-only-ness,
  the zero-posting state of the acceptance tenant and one intermittent React #418 are all written up
  in `notes/statement-version-browser-acceptance.md`.
