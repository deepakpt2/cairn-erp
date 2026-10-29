# People increment 2 — the organisational structure and the assignment into it

Written 2026-10-28, on top of `notes/people-increment-1.md` (the employee master and its dated records,
`9193`, published as commit `46f7002`). This note records what the second HR increment is, what was verified,
what was deliberately left alone, and the state of the test databases it touched.

## 1. The HR capability matrix, as the code now stands

> **Superseded 2026-10-28 by `notes/people-increment-3.md` §1**, which adds the pay structure, records the
> browser acceptance of all three People slices, and separates verified from service-tested from untested. The
> table below is left as it was written for this increment.

| §15.1 area | Built | Evidence | Absent, and why |
|---|---|---|---|
| Employee master | yes | `9193`, `src/modules/people/employee-master.ts`, 13 tests | — |
| Configurable record types (DV-012) | yes | `9193`, `record-types.ts`, `/config/people-record-types` | no list/unit/mask kinds — no reader needs them yet |
| **Organisational structure** | **yes (this increment)** | `9194`, `org-structure.ts`, `/people/organization`, 12 of the 17 tests here | not effective-dated (§15.1 asks for dates on the Assignment only; the cost-centre precedent `0050`/`0052` is followed); no leading position, no vacancy or headcount planning on `position`, no org-unit ↔ company-code assignment |
| **Assignment** | **yes (this increment)** | `9194`, `assignment.ts`, `/people/assignments`, the other 5 tests | no percentage split across cost centres and no concurrent multi-position assignment (no rule in the design decides how a split divides, so one employee has one assignment standing per day); the cost centre is validated as of the assignment's first day only |
| Pay structure, deduction rules, payroll result, posting, other payments, EOS, salary payment | no | — | payroll is posting-side only (D-013, R-11) and the deduction configuration waits on which jurisdiction's rules it models |
| Time, leave quotas and balances | no | — | no rule states how an absence is valued or whether it gates a run |
| Reporting (headcount, personnel cost by cost centre, pay component analysis) | no | — | nothing to report on; and note that a headcount-over-time report cannot be written against an undated tree, only against today's |

§10.8's People codes: 6 of the 15 are registered and enforced (`PEOPLE.EMPLOYEE.CREATE`,
`PEOPLE.RECORD.MAINTAIN`, `PEOPLE.ORGUNIT.CREATE`, `PEOPLE.POSITION.CREATE`,
`PEOPLE.ASSIGNMENT.MAINTAIN`, plus the pre-existing inert `PEOPLE.PAYROLL.POST`); 9 remain codes without
tables. `CFG.PEOPLE.RECORDTYPE.DEFINE` is registered as a configuration activity. No People **role** exists:
`role_capability` was left untouched by both increments, so the screens are reachable by an administrator's
`*` pattern and by nobody else, which is the owner's open decision rather than an omission to fix here.

## 2. What the increment is

Five tables (`drizzle/9194_people_org_structure_and_assignment.sql`, 333 lines):

* `org_unit`, `job`, `position` — the masters, retired by `is_valid` and never deleted, as `9193` did for a
  record type. A position's job is a real foreign key with `restrict`.
* `org_hierarchy` — one table, two relations: `STRUCTURE` (unit under unit, position in unit) and
  `REPORTS_TO` (position to position, which is §15.1's "reporting line"). The primary key is the child, so
  **the one-parent rule is the key** — the same shape `drizzle/0052` chose for cost centre nodes, whose header
  says the unique index on the assignment *is* the rule while cycles and depth are judged above it. Cycles and
  the ten-level cap (`MAX_ORG_DEPTH`, taken from `0052` rather than re-drawn) are enforced in
  `measureChain`, which is exported and unit-tested without a database.
* `position_assignment` — keyed by (employee, first day), inclusive `valid_to`, `restrict` on both the
  employee and the position foreign keys, `request_key` for idempotent writes. Overlap is the service's, inside
  the transaction, under an advisory lock on the employee: the same division of labour `9193` drew.
  The cost centre is *not* a foreign key because the cost centre master's own key carries a from-date
  (`0050`); the controlling area is, and the code's validity across the assignment's first day is checked
  against the dated master — the idiom `src/modules/finance/schema.ts` uses for the same reason.

Two services (`org-structure.ts` 993 lines, `assignment.ts` 603 lines), each with a refusal table whose every
entry has both a sentence and a remedy; two screens (`/people/organization`, `/people/assignments`, six
files, 1382 lines) registered in `src/ui/shell/screen-catalog.ts` under `foundation` for the reason recorded
by the increment-1 entry (a `people` `ScreenArea` needs a nav label in `src/platform/i18n/index.ts`, which
carries uncommitted owner work); three capability rows and three `term_registry` rows in the migration, and
their matching rows in `scripts/seed.ts` (12 lines, verified against the diff count after the pass-85 lesson).

Nothing else in the repository was touched. No `ScreenArea`, no payroll or time table, no change to the
financial statements, no Rust, no rewrite of increment 1's functionality.

### The one correction to increment 1's reasoning

`9193` deferred this block on the ground that PA0001-style assignment data "is a *record* of a configured
type". §8.10 lists `position_assignment` as its own table with its own purpose, so it is built as one: the
record-type indirection would have made the assignment unqueryable by the reporting that names it
("personnel cost by cost centre"). What *was* carried over from `9193` is the span discipline — dated rows, an
inclusive end, append on change, `valid_to` written once, nothing deleted. The applied migration cannot be
edited (migrations are immutable), so the correction lives in `9194`'s header, in `src/modules/people/schema.ts`'s
file header, and here.

## 3. Verification, and what each result covers

Run on the test box (`/home/cairn/cairn-erp`), against the `cairn` development database the harness uses, on
2026-10-28. Each figure below is the command's own output, not an expectation.

| Check | Result |
|---|---|
| `npm run db:migrate` (9194 applied to `cairn`) | `Applied 1 migration(s): + 9194_people_org_structure_and_assignment.sql`; ledger checksum `4ffaf3bc` |
| New migration on an empty database | proven earlier this session for `9193` by a full 316-file rebuild; `9194` applied as the only pending file after that rebuild, then `316 already applied` clean |
| `npx vitest run tests/people-org-assignment.test.ts` | **17 passed (17)** |
| `npx vitest run tests/people-employee-master.test.ts` (regression of increment 1) | **13 passed (13)** |
| `npx vitest run tests/migration-grant-policy.test.ts tests/default-privilege-audit.test.ts` | **13 passed (13)** — the grant shape (delete only on `org_hierarchy`, none on the four others, no `revoke … from cairn_app`) is accepted by the audit |
| `npx tsc --noEmit` | **188 diagnostics, 0 in `src/modules/people/*`, `src/app/people/*` or the new test** — 188 is the repository's pre-existing baseline, measured the same way in the previous passes |
| `npm run build` | exit 0; `.next/server/app/people/` holds `assignments`, `employees`, `organization` |
| DB effects, measured | 5 tables, `relrowsecurity` and `relforcerowsecurity` true on all five; `cairn_app` privileges exactly: masters `SELECT/INSERT/UPDATE`, `org_hierarchy` also `DELETE`, `position_assignment` no delete; 7 `PEOPLE` capabilities, 5 People `term_registry` routes |
| Tenant isolation | in the suite: the second tenant lists none of the first's units, positions or assignments, may define the same codes as its own, and cannot name the first's employee; `getOrgUnit` on another tenant's code is a refusal, not a leak |
| Immutability of history | in the suite: `delete` and `truncate` on `position_assignment`, `position`, `org_unit` all fail with `permission denied` from the runtime role, and the rows are still there afterwards; the one delete that works is the structure's, and the test re-files the position after it |
| Full suite (`npx vitest run`, all 463 files) | **3195 passed \| 7 failed (3202)** — The seven are the ones an earlier pass recorded and this box still reproduces (`action-security.test.ts` ×4, `grir-clearing.test.ts` ×2, `production-order-writer-guard.test.ts` ×1) — none touches a People path, none was attempted here, and `docs/operational-readiness.md` §4 notes they do not reproduce on a tree carrying the owner's in-flight work. The total grew by exactly 17 over the previous pass, which is this file's new suite and nothing else |

**Not verified, explicitly:** no browser acceptance was performed for either People increment. The screens are
typechecked and built and their services are tested; no click path, no served-app form submission, and no
`scripts/browser-smoke` target covers them (HR's single browser target is the older tolerance-group screen).
That is the first thing worth doing next, and it must be done against the served production build on the test
box, never a dev server.

## 4. `cairn_b210` — the checksum discrepancy, resolved

* **Cause established.** `9193` was applied to `cairn_b210` while its text still held the pre-correction grant
  statements, because `npm run db:verify` calls `runMigrations()` for real against whatever
  `MIGRATION_DATABASE_URL` names — and in `.env.local` that is `cairn_b210`. The file was corrected afterwards,
  so the ledger recorded `5c9abd95` while the file's own checksum is `08804e6c`, and the runner reports
  *"has changed since it was applied. Migrations are immutable once applied."*
* **The objects were compared first, read-only**: 101 definition lines on each side (51 columns, 26
  constraints, 9 indexes, 5 policies, 5 RLS flags) and `cairn_app`'s effective privileges identical
  (`SELECT/INSERT/UPDATE` true, `DELETE` false on all five tables); 316 disk files against 316 ledger rows with
  0 pending and 0 orphans. Table *comments* were not compared — the first attempt at that used a bad
  `pg_describe_object` call and failed identically on both sides, which is also why an early "byte-identical"
  claim from that session was worthless.
* **Procedure rehearsed on a scratch database of my own** (`cairn_hr_rehearsal`, created, built from scratch
  with all 316 files, deliberately broken by writing the old checksum into the ledger, the fault reproduced,
  repaired, verified, dropped). The rehearsal also proved `9193`'s current text applies cleanly to an empty
  database.
* **Applied to `cairn_b210`** with preconditions asserted in the same statement (`ledger rows = 1`,
  `recorded = 5c9abd95`, `objects = 5`, `data rows = 0`): one row updated to `08804e6c`, then re-read, then
  re-counted pending = 0. Rollback value if it is ever wanted:
  `update cairn_migration set checksum='5c9abd95' where filename='9193_people_record_types_and_employee.sql';`
  Nothing else in that database was written; no reset, no re-apply, no data (it holds 0 employees, 0 records,
  0 record types, 4 capability rows and 2 People terms — those counts predate this pass).
* `cairn_demo` was not touched at all.
* **`cairn` (the working database) has one deliberate ledger edit of its own**, worth recording because it was
  my error: a file transfer that wrote a 0-byte `9194` was applied as an empty migration (checksum `811c9dc5`,
  no objects created). The empty ledger row was deleted, the real file re-transferred and applied, which is
  safe for this file because every statement in it is `if not exists`, `drop policy if exists` or an upsert.
  `9194`'s ledger row now reads `4ffaf3bc` and matches the file.

## 5. Open questions this increment did not answer

Documented rather than decided, because each needs a business ruling rather than a plausible column:

1. **How a shared person divides.** Percentages across cost centres, and whether one employee may hold two
   positions at once. Deferred to the CO/payroll discussion; the model today allows one assignment per day.
2. **Position exclusivity and vacancy.** Nothing prevents two employees standing in one position; whether that
   is a "vacancy = 0" rule or a headcount planning object is §15.1 silent on it.
3. **Dated structure.** If a report needs "the org as at a date", the tree needs spans — a larger change than
   this table, and it also implies what happens to a person's assignment when a unit moves retroactively.
4. **Employee-to-employee reporting** (PA0001's supervisor personnel number) — a record of a configured type
   until someone rules it is a first-class relation.
5. **Leading position, org-unit → company-code assignment, default cost centre per unit.** Each is a real ERP
   object; none is in §8.10's row or §15.1's line.
6. **People roles and the personnel-number interval**, both carried from increment 1. Until a role model is
   decided, no `role_capability` rows are added, and no `INTL-STD-5` number range is drawn for personnel
   numbers.
7. **Idempotency is per (employee, request key)**, so re-using a key for a different date writes nothing and
   answers "no assignment begins on that date" rather than duplicating a row. Increment 1 has the same shape;
   changing it belongs to a decision about what a replayed HR write should mean, not to this slice.

## 6. Deferred work left exactly as found

The test-data pack and the financial-statement acceptance work are untouched by this increment, as instructed.
The owner's 28 modified and 13 untracked entries, the one stash, and `walkthrough-seed.ts`
(`b31cf1c5…`) were not staged, edited or moved; increment 1's commit `46f7002` on `main` was not recommitted
or repushed. **Nothing from this increment is committed or pushed**: publication needs its own authorization.
