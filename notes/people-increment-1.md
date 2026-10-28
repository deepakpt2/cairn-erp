# People module, increment 1 — the employee master and its dated records

2026-10-28. Working tree on the verification box (`/home/cairn/cairn-erp`), databases `cairn` for migrations and
service tests. Nothing here is committed or pushed; no `cairn_demo`/`cairn_b210` data was written by me (see
"Deviation the owner must know about").

## 1. What the inspection found, and how it was found

The brief asked for HR "brought into working condition". The repository says there was no HR workflow to bring
into condition — the module did not exist. Every claim below is a command that was run, not an inference.

| HR/People layer | Evidence read this pass | Verdict before this pass |
|---|---|---|
| Employee master (`employee`, `employee_record`) | no table in `drizzle/` (315 files), no `src/modules/people`, no `src/app/people` | absent |
| Configurable record types (DV-012) | `CFG.PEOPLE.RECORDTYPE.DEFINE` in `scripts/seed.ts:114` as a `config_activity` only — no capability row, no screen, no service | registered as an intention, inert |
| Pay components, deduction rules | `CFG.PEOPLE.PAYCOMPONENT.DEFINE`, `CFG.PEOPLE.DEDUCTION.DEFINE` at `scripts/seed.ts:115-116` | registered as an intention, inert |
| Org units, positions, jobs, `position_assignment` | no tables, no codes reached | absent |
| Time, absence, leave quota | `PEOPLE.TIME.ENTER` / `PEOPLE.LEAVE.VIEW` not in `capability`; the only `personnel` field in `src/` is free text on `production/{time-ticket,order-confirmation}` | absent |
| Payroll run / result / import / payslip | not in `capability`, no tables | absent |
| Payroll posting (FI/CO) | `PEOPLE.PAYROLL.POST` **is** registered (`scripts/seed.ts:392`, `posting: true`) and doc type `PR` ships in the standard package (`standard-config.ts:285`) — but there is no writer and no `payroll_posting_run` table | a capability granted over nothing to execute |
| Employee tolerance groups | `drizzle/0047` + `9031`, `src/modules/foundation/employee-tolerance-definition.ts`, `/config/tolerance-groups`, one test file | built — and it is an AP/AR credit control, not HR |

`docs/operational-readiness.md` §1 said the same in the repo's own words: `| HR | 1 (employee_tolerance_group) | 0
| 0 | 1 | 1 | absent apart from an AP/AR tolerance control |`. So this pass did not repair a broken workflow; it
laid the first working one on the design `CAIRN.md` already approves (§8.10 tables, §10.8 codes, §11 rule 9,
§15.1-15.3, D-013, R-11, DV-001, DV-012).

## 2. What was built

Five tables, two services, two screens, one focused test file:

- `drizzle/9193_people_record_types_and_employee.sql` — `record_type`, `record_field`, `employee`,
  `employee_record`, `record_field_value`; RLS forced on all five (D-041); per-table `grant update` and no
  revoke (see §5); the three `capability` rows; the `term_registry` routes; the `comment on` lines.
- `src/modules/people/schema.ts` (182 lines) — the drizzle definitions and the screen contract (routes,
  capability codes, change-document object classes), registered in `src/platform/schema.ts`.
- `src/modules/people/record-types.ts` (441 lines) — `defineRecordType`, `getRecordType`, `listRecordTypes`,
  `changeRecordType` (retire/restore), `addRecordField`, `changeRecordField`.
- `src/modules/people/employee-master.ts` (774 lines) — `createEmployee`, `changeEmployee`, `getEmployee`,
  `listEmployees`, `createRecord`, `delimitRecord`, `changeRecordValues`.
- `/people/employees` (71 + 192 + 400 lines) and `/config/people-record-types` (67 + 190 + 263 lines), plus two
  `screen-catalog.ts` entries and the seed-list rows (`scripts/seed.ts`: 3 capabilities, 2 term rows with
  `PA30`/`PA40`/`PA90` as search aliases).

The business rules the code enforces, each traceable to a line of the approved design:

1. **A change is a new dated record, not an overwrite** (§8.10). A record is keyed by
   (employee, type, valid-from) and covers its span inclusively; writing a record over any day another record
   of the same type covers is refused, naming the record in the way.
2. **No record is ever deleted.** DELETE and TRUNCATE are not granted to the runtime role and the services never
   issue one; a test proves the refusal at the database, not by reading the code.
3. **What a record asks for is configured** (DV-012). Each field declares `TEXT`, `NUMBER` or `DATE`, and the
   kind decides which column the answer is stored in — so an ill-typed answer is refused instead of flattened
   into text, and a required field must be answered.
4. **A definition is retired, not deleted.** `is_valid = false` stops new records and keeps every standing one
   readable (the OBA4 shape); `restrict` on the record's foreign key means a type with history cannot be
   removed at all.
5. **A field's kind cannot be renamed while records answer it** — that would strand values in a column no
   reader consults.
6. **No payroll is calculated, posted, or implied.** No pay component, run, result, payslip or posting table
   was created, and the capability rows say the screens post nothing (D-013, R-11, §15.3).

## 3. Verification evidence

| Check | Result |
|---|---|
| `npm run db:migrate` (target `cairn`) | `Applied 1 migration(s): + 9193_people_record_types_and_employee.sql`, 315 already applied |
| `npx vitest run tests/people-employee-master.test.ts` | **13 passed (13)**, 1.7 s |
| ACL gates: `tests/migration-grant-policy.test.ts` + `tests/default-privilege-audit.test.ts` | **13 passed (13)** (9 + 4) |
| `npx tsc --noEmit` | 188 diagnostics total = the recorded baseline; **0** in `src/modules/people`, `src/app/people`, `src/app/config/people-record-types`, `tests/people-employee-*` |
| `npm run build` | `✓ Compiled successfully in 78s`, exit 0; routes emitted: `ƒ /config/people-record-types 3.53 kB`, `ƒ /people/employees 4.41 kB` |
| Neighbourhood regressions (the 100 files whose text reads `screen-catalog`/`term_registry`/`config_activity`/`capability`) | all pass except `tests/action-security.test.ts` ×4 — recorded as pre-existing at `docs/operational-readiness.md:450`, on owner-modified files, in tables this slice does not touch |
| **Whole suite** (`npx vitest run`, 462 files, 651 s) | **3178 passed / 7 failed (3185)**; `✓ tests/people-employee-master.test.ts (13 tests)` inside that run; the seven are `action-security` ×4, `grir-clearing` ×2, `production-order-writer-guard` ×1 — the pre-existing set this repo already records, none in People, none in a catalogue this pass edited |

What the 13 tests actually pin, beyond the happy path: `TYPE_EXISTS` and a twice-listed field code write
nothing at all; retirement blocks new records but not reads; a required field added after history stands
neither rewrites nor hides the old record (it only blocks the *next* write and the next correction); the
kind check is per field and the zero case is proved on an untouched type; a `DATE` answer lands in
`date_value` with `text_value`/`number_value` null; a number keeps its two decimal places (`2` reads back
`2.00`); overlapping and same-day records are refused; `valid_to` is written once and twice-delimiting is
refused; a superseded record refuses both correction and delimiting; an empty box keeps the stored answer
rather than blanking it; `delete`/`truncate` on `employee`, `employee_record` and `record_field_value` all
return `permission denied` to `cairn_app`; a second tenant using the *same* personnel number is invisible to
the first; change documents exist for the definition, the master and every dated record, keyed
`PERNR/TYPE/YYYY-MM-DD`; no posting-relevant `PEOPLE` code exists except the pre-existing payroll posting.

## 4. Not verified, and what is still blocked

- **Not browser-accepted.** The two screens compile and are registered, but no Playwright target was run:
  `cairn_b210` — the acceptance database — is deliberately not migrated by this pass, so the screens have
  never been served. "Built and service-verified" is all the claim this pass supports.
- **Payroll calculation stays blocked, unchanged.** `docs/operational-readiness.md` §4 item 4: the deduction
  configuration "cannot be built without a decision on which jurisdiction's rules it models". Nothing in this
  slice works around that; no `deduction_rule` table was created even though §8.10 names one.
- **Two behaviours are decisions this slice made and the owner should confirm**, both stated in the migration's
  own comment block rather than slipped in: (a) the newest open record of a type may be corrected in place, and
  (b) ending a record writes its last day exactly once. Both are narrow readings of "not an overwrite"; if the
  owner prefers pure append-only, `changeRecordValues` and the `grant update` on `employee_record` come out and
  a record's end is implied by the record that follows.
- **No authorization for a People role.** `role_capability` grants only `CFG.PEOPLE.RECORDTYPE.DEFINE`, to the
  roles that already define the company code; `PEOPLE.EMPLOYEE.CREATE` and `PEOPLE.RECORD.MAINTAIN` are reached
  today by `ADMINISTRATOR`'s `*` and by nobody else. Widening them is the owner's call, not a migration's.
- **No personnel-number interval.** `PEOPLE.*` master numbers are caller-supplied, as supplier numbers are. A
  number-range object would mean a standard-package version bump (current `INTL-STD-4`).
- **Not built, in the order the design asks for them:** `org_unit`/`position`/`job`/`org_hierarchy`/
  `position_assignment` (next — assignment data is a record of a configured type, which is why it follows the
  record types and not the other way round); pay components with GL/cost-centre mapping; `payroll_result` +
  `payroll_result_line` + import; `payroll_posting_run`/`_line` against §11 rule 9; EOS provision; time,
  absence, leave quota; the two headcount/cost reports.

## 5. Deviation the owner must know about

`npm run db:verify` sources `.env.local`, and `tests/migration-grant-policy.test.ts` calls `runMigrations()`
itself — so running `db:verify` while `.env.local` names the acceptance database **applied 9193 to
`cairn_b210`** as a side effect. Measured afterwards, read-only:

- 5 new tables with 0 rows; 4 `capability` rows for module `PEOPLE`; 2 `term_registry` rows; 0
  `role_capability` rows; `cairn_migration` at 316 files. No existing row in any table was changed, and the
  tenant-0100 data the browser acceptance measures is untouched.

The file was then corrected twice (per-table grant declarations, then dropping the `revoke ... from cairn_app`
lines — see §5 of `docs/migration-authoring.md` notes below), so `cairn_b210`'s ledger row for
`9193_people_record_types_and_employee.sql` carries a checksum for text that no longer exists and the runner
will refuse it (`Migration 9193_… has changed since it was applied`). The schema on `cairn_b210` is
equivalent; only the ledger is stale. The repair is one line, run by the owner against that database:

```sql
update cairn_migration
   set checksum = '08804e6c'
 where filename = '9193_people_record_types_and_employee.sql';
```

I did not run it: `cairn_b210` is read-only to me by standing instruction. `cairn`'s ledger was re-recorded
through the runner itself (delete the row, re-apply the file — its DDL is idempotent), which is why the
`db:migrate` line above shows it applied.

Worth recording for the next author: **run the gates with the test env, not `npm run db:verify`, when a
migration is new** —

```sh
set -a; . ./.env.development.example; set +a
npx vitest run tests/migration-grant-policy.test.ts tests/default-privilege-audit.test.ts
```

## 6. Why the grant block reads the way it does

`tests/migration-grant-policy` holds every table that carries a `revoke … from cairn_app` line to *no* UPDATE,
DELETE *and* TRUNCATE: a revoke to that role is read as a declaration that the table is immutable (9185-9187,
9016, 9017). A dated record has to have its last day written once, so these five tables are not immutable in
that sense and must not pretend to be — they grant `update` and claim nothing else, and DELETE/TRUNCATE are
denied because 9186's default for a table the migration role creates is SELECT and INSERT. "History cannot be
deleted" is therefore enforced by the absence of a grant and proved live by a test, not asserted by a revoke
the semantics would contradict.
