# People increment 3 — the pay structure, and the browser acceptance both earlier increments had not had

Written 2026-10-28. Nothing here is committed: the working tree carries increment 2 and this increment
together, on top of `46f7002` (increment 1, published). The owner's own edits, untracked files and the single
stash are exactly as found, `walkthrough-seed.ts` among them (md5 `b31cf1c5255101df9e0f0e74f66aefc7`).

Two things were done, and they are kept apart below because they carry different evidence: the pay-structure
slice (`9195`, service, screens, tests), and the browser acceptance of the *three* People slices against a
served production build. The acceptance run is what found four defects — one of them in published code — and
the pay slice is not claimed as accepted on the strength of its own tests.

## 1. The HR capability matrix, as the code and these runs now stand

Five states are used, and they mean different things: **verified** (a browser reached the persisted result),
**service-verified** (the rule is enforced and read back, no browser ran it), **partial** (built, with a named
piece missing), **planned gap** (the design leaves it unbuilt for a stated reason), **open decision** (nothing
can be built until somebody rules).

| §15.1 / §10.8 area | State | Evidence | What is missing, and why |
|---|---|---|---|
| Employee master | **verified in a browser** | `9193`; T820 (10 evidence lines) created E2000001, refused a second person on the same number, and left the tenant holding exactly its own employee | none for master data; a number range is the tenant's own decision |
| Configurable record types (DV-012) | **verified in a browser** | `9193`, T820 defined BANKD with a required field, added a second field, toggled its requirement, refused a duplicate code with nothing filed | list/unit/mask field kinds — no reader in this design needs one |
| Dated records: overlap, delimitation, correction | **verified in a browser** | T820 refused a record on a covered day, delimited one, wrote the replacement the day after, and the closed row still reads as it was written | — |
| Organisational structure (units, jobs, positions, hierarchy, reporting line) | **verified in a browser** | `9194`; T821 (9 lines) built the tree, refused a unit under its own child, moved a unit and a position and read both sides from `org_hierarchy` | not effective-dated: one version exists, which is what the design's §15.1 row says |
| Position assignment (position → cost centre → employee, dated) | **verified in a browser** | `9194`; T822 (9 lines) wrote a span, ended it on its own first day, refused a covered day, refused a centre not in force on the start day and accepted it for the later day, corrected values without touching the dates | `requestKey` idempotency is **not** browser-exercised (the form carries the field; the run used the key only when creating the employee through the service); a correction of a *replaced* span is service-tested only, because the screen offers no control there |
| **Pay structure — pay components** | **verified in a browser**, this increment | `9195`, `pay-components.ts`; T823 defined BASIC as an earning and read back `affects_net_pay` derived from the kind, not asked for | nothing is calculated: no bases, no retro, no wage-type grouping (see the planned gaps) |
| **Pay structure — GL and cost mapping** | **verified in a browser**, this increment | `9195`'s two tables + `pay_component_config`; T823 mapped debit 590100/credit none with a FIXED centre `A000/CC900`, refused a credit on an earning, refused `NONE` where the account demands a cost object, and both saves are filed as separate documents (`CHANGE` above `CREATE`) | posting. `posting_key` exists nowhere in `src/modules/finance/schema.ts`, so the mapping stores accounts and a cost receiver and no posting consumes it yet |
| Payroll: runs, results, payslips, deduction rules, EOS, salary payment | **planned gap** | — | R-11 keeps payroll simplified, DV-001 refuses shipped-but-wrong statutory logic; `payroll_run`, `payroll_result`, `payroll_result_line`, `payroll_posting_run`, `payroll_posting_line`, `deduction_rule*` have no tables. `9195` is the prerequisite they all cite, and it is now there |
| Time recording, leave quotas and balances | **planned gap** | — | no rule in the design states how an absence is valued or whether it gates a run |
| Reporting: headcount, personnel cost by cost centre, pay-component analysis | **planned gap**, now with something to report on | `position_assignment` carries `controlling_area`/`cost_center`; `pay_component_config` says which account and which receiver | personnel cost needs a payroll result to aggregate; headcount-over-time needs dated org objects, and §15.1's org rows are not effective-dated |
| Role grants for People capabilities | **service-verified**, this increment | `9198` adds `employee.app_user_id` with a unique index and a foreign key to `app_user(id)`; `9199` grants `PEOPLE.EMPLOYEE.CREATE`, `PEOPLE.RECORD.MAINTAIN`, `PEOPLE.ORGUNIT.CREATE`, `PEOPLE.POSITION.CREATE`, `PEOPLE.ASSIGNMENT.MAINTAIN`, `PEOPLE.TIME.ENTER`, `PEOPLE.LEAVE.VIEW` to the CONFIGURATOR role in every tenant; `SYSTEM_ROLES` carries the same grants so new tenants are born with them | payroll codes (`PEOPLE.PAYROLLRUN.EXECUTE`, `PEOPLE.PAYROLL.RESULT`, `PEOPLE.PAYROLL.POST`, `PEOPLE.PAYROLL.IMPORT`, `PEOPLE.EOS.PROVISION`, `PEOPLE.SALARY.PAYMENT`) are deliberately NOT granted — payroll remains the simplified-payroll exception (DV-001, D-013, R-11) | `tests/people-authorization.test.ts` — 14 tests: employee without a login account, voluntary link, uniqueness in both directions, clearing the link leaves the employee intact, authorized People operations succeed, identical operations by a session without the capability are refused, role revocation removes capabilities, deactivated accounts end sessions, cross-tenant access is prohibited, administrator wildcard works |
| Reference-transaction aliases (the "searchable tcode" promise) | **implemented and verified**, `9196` | T820 finds `/people/employees` by PA30 and PA40; T821 finds `/people/organization` by PPOCE and PPOME | PA30 names three §10.8 rows; one alias leads to one term, so it leads to the person (see §5) |

## 2. What the pay slice is, and what it deliberately is not

`9195_people_pay_structure.sql` adds `pay_component` and `pay_component_config` on the design's own words —
§8.10's row "pay_component, pay_component_config | Pay structure and its GL/cost mapping | Wage types (concept)"
and §15.1's "Pay components (wage-type equivalent) with their accounting mapping". Every rule in it is read off
repository evidence, and each is where the file says it came from:

* the four kinds — `EARNING`, `DEDUCTION`, `EMPLOYER_CONTRIBUTION`, `EOS_PROVISION` — are §15.2's six posting
  lines collapsed to the categories those lines need; the screen offers exactly four, and T823 counts them;
* `affects_net_pay` is not an operator choice: a CHECK pins it to `kind in (EARNING, DEDUCTION)`, following the
  precedent of `gl_account_balance_sheet_derived`, which likewise refuses to let a derived fact be typed in;
* a mapping is one row per (tenant, component, chart of accounts) holding `debit_account` and `credit_account`
  and a `cost_receiver_category` of `ASSIGNMENT`, `FIXED` or `NONE`, with the controlling area and cost centre
  present only for `FIXED` — because §15.2 charges an employee's assignment for variable pay and a fixed centre
  for standing charges, and nothing else;
* the account sides are checked against the chart: `gl_account.account_type` is `EXPENSE` on the debit side and
  `LIABILITY` on the credit side, `is_blocked_posting` and `requires_cost_object` are honoured, both sides may
  not be one account, and the centre must be in force in its area. `listAccountsForSide` and the centre query
  read the finance masters rather than copying their rules;
* undated, retire-not-delete, no `delete` granted, RLS forced, the capability `CFG.PEOPLE.PAYCOMPONENT.DEFINE`
  registered from §10.8's existing row, `route_path` set for the new screen and the term row added so the
  screen is findable.

Excluded because the evidence excludes them, not for convenience: no `posting_key` (absent from the finance
schema entirely), no calculation, bases or retro-active rules, no `deduction_rule*` (DV-001), no payroll runs,
results, payslips or EOS accrual (D-022 keeps them behind a payroll result that does not exist), and no §10.8
alias, because §10.8 lists no transaction code for pay components — 9195 says so where an alias would have
gone.

## 3. Verification of the slice itself

| Check | Result |
|---|---|
| `npx vitest run tests/people-pay-components.test.ts` | **12 passed (12)** — valid configuration, each invalid mapping, tenant isolation, persistence, both audit documents |
| `npx vitest run tests/people-org-assignment.test.ts tests/people-pay-components.test.ts tests/people-employee-master.test.ts` | **42 passed (42)** |
| `tests/migration-grant-policy.test.ts`, `tests/default-privilege-audit.test.ts`, `tests/browser-targets.test.ts`, `tests/server-action-exports.test.ts` | **411 passed (411)** — the two new tables pass the privilege audit with `grant update` only |
| `npx tsc --noEmit` | **188 error lines** = the repository baseline; **0** in `src/modules/people/*`, `src/app/people/*`, `src/app/config/pay-components/*` or the new tests |
| `npm run build` | exit 0; `.next/server/app/config/pay-components` built |
| `npm run db:migrate` on `cairn` | `Applied 1 migration(s): + 9196_people_term_aliases.sql`, then a second run reporting `319 migration(s) already applied.` — the runner is idempotent and completes normally |
| Column proof for the widened `cost_receiver_category` | `character_maximum_length = 10` on `cairn`, measured after the 9195 file was corrected and re-applied this pass |

Two earlier failures in the slice were real and were fixed, not worked around: `cost_receiver_category` was
`varchar(4)` against a `varchar(10)` vocabulary (`EMPLOYER_CONTRIBUTION` is 20 characters, the CHECK is what
keeps it legal), and switching a standing mapping away from `FIXED` inherited the old area and centre and tripped
the vocabulary refusal — `RECEIVER_VOCABULARY` now fires only on an explicitly named pair beside a non-`FIXED`
category, and the pair resolves to null otherwise.

| Full suite (`npx vitest run`, all 465 files) | **3396 passed \| 7 failed (3403)** on this tree, after `9195` and `9196` were applied to `cairn`. The seven are the same set every recent pass records and none of them touches a People path: `tests/action-security.test.ts` ×4, `tests/grir-clearing.test.ts` ×2, `tests/production-order-writer-guard.test.ts` ×1 (the CO09 browser fixture). They are listed as `docs/operational-readiness.md` §4 lists them; this pass neither fixed nor caused them. |

## 4. The browser acceptance — four targets, one served build, one scratch database

Environment, stated so it can be repeated. `cairn_b210` is the protected acceptance database and was **not**
written to, seeded with fixtures, or ledger-changed: it still holds 316 migrations with `9193` latest, exactly
`9194/9195/9196` pending, and its `9193` checksum `08804e6c` matches `cairn`'s — so no repair was needed and
none was repeated. All browser writes went to `cairn_hr_accept`, rebuilt by `~/scratch-accept.sh reset` (both
`scripts/seed.ts` and `scripts/seed-reference.ts`, 319 migrations), and the app under test was `next start -p
3100 -H 127.0.0.1` serving `npm run build`'s output — never `npm run dev`. `cairn_demo` (315, latest `9192`) was
not touched. Each target ran through `scripts/browser-smoke.ts`'s own guard (`verifyAcceptanceDatabase`), its own
freshly onboarded tenant, its own `pageerror` check and its sign-out bounce.

| Target | Result | Evidence |
|---|---|---|
| `people-employee-records` (T820) | **passed** — 10 lines, 35 asserts | workbench `Open` link → `/config/people-record-types`; define, duplicate refusal filing nothing, add field, requirement toggle; employee create and duplicate refusal; dated record, covered-day refusal, delimit, replacement, closed values intact; no delete control; search hit and miss; tenant holds only its own; PA30/PA40 resolve here |
| `people-organization` (T821) | **passed** — 9 lines, 36 asserts | both activities in the header; root and child levels; job describes position; self-parent refusal; unit move with `org_hierarchy` read back; position move; no-op save documented; retirement leaves the standing position and takes the retired job out of the choices a new position is offered; documents and tenant containment; PPOCE/PPOME resolve here |
| `people-assignments` (T822) | **passed** — 9 lines, 27 asserts | assignment written with the mapping stored rather than derived; inclusive end on the start day; covered-day refusal; centre not in force refused for the earlier start and accepted for the later one; empty correction refused; correction moved the centre and left the dates; search, `open=1` filter and the by-position link; two spans and nothing else in the tenant |
| `people-pay-components` (T823) | **passed** — 8 lines, 34 asserts | both configuration steps open from the workbench; four kinds offered and no fifth; earning defined with `affects_net_pay` derived; the account selects carry only the sides and states the chart allows; `NONE` refused where a cost object is required; credit-on-earning refused at correction with nothing changed; FIXED centre stored as a pair and read back; two documents with `CHANGE` above `CREATE`; deduction to a payable alone; search hit and miss on screen and in store; retire leaves the mapping standing and nothing deletes either |

Cases that are **not** browser-verified, with the reason rather than a silence:

* **Authorization refusal on every one of the five screens.** `9199` grants the non-payroll People capabilities
  to CONFIGURATOR in every tenant, and `SYSTEM_ROLES` carries the same grants for new tenants;
  `tests/people-authorization.test.ts` (14 tests, all passing) service-verifies authorized and refused
  operations, role revocation, account deactivation and cross-tenant containment. Nobody has watched a refusal
  happen in a browser — that requires a second user account on a screen, which no journey exercises. Blocked on
  a journey, not on the grant.
* **Correction of a replaced assignment span**, and of a replaced employee record. Both are refused by the UI
  removing the control — T820 asserts the closed row carries no correction control and says why in words — so the
  service refusal that would answer a posted correction is verified in the tests only.
* **`requestKey` idempotency** on the assignment form.
* **Cross-tenant negatives at the screen** (a second tenant listing none of the first's objects): service-tested.
* The pay screen's degradation of a stale deep link (`?component=NOPE` → nothing selected) is not asserted.

## 5. What the acceptance run found in the product

Six things. Each one was invisible to every check that existed before: the routes rendered, the services passed,
the build was clean, and the typecheck matched its baseline.

1. **Every form on the published record-type screen was broken.** `src/app/config/people-record-types/actions.ts`
   ended with `export { EMPTY };`, and a `use server` module may export async functions and nothing else, so
   submitting anything threw a Server Components exception — in a production build, on submit, with the screen
   looking perfect until then. Found on the first submission of T820. Fixed by keeping `EMPTY` in the client
   component. `tests/server-action-exports.test.ts` is the guard: it reads every actions module under `src/app`
   and refuses a value export that is not function-valued (185 cases, all passing). It swept the whole
   application in one run and found only one other file with non-function exports — `config/consolidation/actions.ts`,
   whose `export const xAction = handler(async …)` bindings are functions at runtime and therefore legal; the
   test was refined to say so rather than to leave a permanent false alarm.
2. **The two People configuration activities were unreachable from the workbench**: `config_activity.route_path`
   was NULL and neither route was in `BUILT_ROUTES`, so `WorkbenchTree` printed no `Open` link. Both halves had
   to change — the data (`9195` sets it, `scripts/seed.ts` carries it) and the compiled set in
   `src/app/config/page.tsx` — which is why this needed a rebuild, not a redeploy of code alone.
3. **Ending an assignment destroyed its own confirmation.** The notice lived inside the standing panel, and
   closing the open span is exactly what removes that panel, so the write succeeded and the screen re-rendered
   with a changed list and no sentence. `delimitAction` now redirects with the two dates and the page says the
   line above the history, from one shared sentence in `copy.ts` (`dateParam` keeps a URL parameter from
   becoming a message). This is the pattern `src/app/registry/page.tsx` already uses for its `miss=1` note.
4. **Two copies of the org refusal lied about where they were.** `ORG_CODE_FORMAT`'s remedy told an operator
   defining a unit not to type the code "into the assignment screen", and the incumbent count was described as
   "standing today" / "assigned today" while the rule — `valid_to is null or valid_to >= current_date`, deliberate
   and tested — counts a span that has not yet ended, including a planned one. Both now describe the screen the
   operator is on and the count that is actually meant; the org test's regex moved with them.
5. **A grammar slip in the pay confirmation**: `defined as a earning`, `a end-of-service provision`. `article()`
   in the pay actions picks the article from the label, and T823 asserts the corrected sentence.
6. **The alias promise had no rows behind it.** §10.8 gives PPOCE, PPOME and PA30/PA40, `9193`/`9194` wrote them
   into their descriptions, and no `term_alias` row existed — so typing a code found nothing while 287 aliases
   were already registered for older modules. `9196` registers PPOCE → `PEOPLE.ORGUNIT.CREATE`, PPOME →
   `PEOPLE.POSITION.CREATE`, and PA30/PA40 → `PEOPLE.EMPLOYEE.CREATE`. PA30 is cited by §10.8 against three
   rows at once; one alias leads to one term, so it leads to the person, as it does in the reference product, and
   the two term descriptions now say so rather than leaving an operator to conclude the search is broken.
   `PEOPLE.RECORD.MAINTAIN` has no term row of its own and no alias is invented for it. **This is an open
   question for the owner**: whether a dated-record or assignment screen should carry its own reference code,
   which would need a §10.8 change, not a migration.

One harness defect of mine, recorded because it cost a false alarm: a `next start` left on port 3100 from an
earlier build served the previous build's chunk hashes, which surfaced as "Application error: a client-side
exception" and looked exactly like a broken app. `~/restart-3100.sh` now kills by the port's owner (the process
is `next-server (v15.5.27)`, so no command-line pattern finds it) and refuses to report ready while the port is
held. **The read-only `:3000` server on `cairn_b210` was killed during this work and is not running again** —
start it with `~/restart-3100.sh`'s shape and the `.env.local` pair if the next acceptance pass wants it.

## 6. Where the numbers came from

`ls drizzle/*.sql | wc -l` = **322**. `cairn_migration` rows: `cairn` 320 (latest `9199`, no pending) and `cairn_hr_accept` 319 (latest `9196`, `9198`/`9199` pending on next reset); `cairn_b210` 316 (latest `9193`, three pending, unmodified); `cairn_demo` 315 (latest `9192`); `cairn_hr_rehearsal` no longer exists. Checksums agree across databases where a file is applied
in both: `9193 08804e6c` on `cairn` *and* `cairn_b210`, `9194 4ffaf3bc`, `9195 640d06e2`, `9196 8ee4e57a`. The
reconciliation script is `/home/cairn/ledger-check.sh`, the checksum query `/home/cairn/ck.sh`, and both read
nothing but the two lists.

The matrix in `notes/people-increment-2.md` §1 described the state before this increment; it now points here.

## 7. Left as found

The reusable test-data pack, the financial-statement acceptance, the Rust phase and every module outside People
were not touched. No `package.json` script was added. The journeys live beside the other smoke journeys
(`scripts/browser-smoke/people-*.ts`), registered as T820–T823 in `targets.ts` with `cairn_hr_accept` guards in
`database-guards.ts`, because `cairn_b210`'s no-fixture-tenants rule and these journeys' need to write cannot be
reconciled. Nothing is committed and nothing is pushed.
