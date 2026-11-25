# BUG FIX LOG — India UAT work

**Application code only.** This log lists changes to the application itself. Defects in the
installer and fixture code I wrote are in a separate section at the end, so that this list answers
the question it exists to answer: *what did we change in the product, and why?*

Each entry is a genuine defect in the application (not a data problem), approved by the owner
before any code changed, fixed minimally, and committed on its own with a test that reproduces it.

Rules this log obeys, from the brief:

- A bug is recorded here only when the application behaves wrongly **against its own intended
  design or standard accounting logic** — a wrong posting, a crash, a calculation error.
- Data that does not fit the application is a **data** problem and is fixed in the fixtures, never
  by weakening the application. Those are not in this log; they are in `02-gap-list.md`.
- A missing feature is a **GAP**, not a bug. It is recorded in `02-gap-list.md` and is not built.

**Numbering.** Bug 002 is not missing: it was an installer defect, and it now lives under
"Installer defects" at the end as **ID-002**. The numbers are not renumbered so that a reference in
a commit message or a review thread still points at the same thing.

---

## Bug 001 — A shifted fiscal year (April–March) cannot resolve dates in January to March

| Field | Value |
|---|---|
| Status | **FIXED** |
| Discovered | During Step 1 audit, confirming whether an Apr–Mar fiscal year is configuration-only |
| Approved | Owner, before the fix was applied |
| Commit | `28bed70d861482a2a315256e15532e9a944978fd` |
| Files changed | `src/platform/periods/index.ts`, `tests/periods.test.ts` |
| Application code changed | 1 line of logic + comment |

### What failed

`derivePosition()` in `src/platform/periods/index.ts` decides which fiscal year and posting
period a posting date falls in. It tested only two candidate fiscal years — the posting date's own
calendar year and the one after it:

```ts
for (const fiscalYear of [dateYear, dateYear + 1]) {
```

In a fiscal year that starts in April, January, February and March belong to the fiscal year that
**started in the previous calendar year**. That candidate was never tried, so any posting dated in
those three months fell through to:

> `Posting date 2027-01-15 does not fall in any period of fiscal year variant A4.`

Measured over the calendar year 2026 with an Apr–Mar variant built by the real
`buildPeriodRows` + `periodWindows`:

```
2026 as a whole year: 90 of 365 days resolve to NO PERIOD
first failures: 2026-01-01, 2026-01-02, …
2026-01-15 should be FY2025 period 10 → null
2026-06-15 should be FY2026 period 3  → {fiscalYear:2026, period:3}
control, calendar-year variant 2026: 0 unresolved days
```

90 days is exactly 1 January – 31 March.

### Why it is a bug and not a data problem

The product clearly intends to support shifted years, and several parts already do:

- `buildPeriodRows({ startMonth: 4 })` builds periods 10–12 with `yearShift: 1`.
- `periodWindows()` correctly starts each period the day after the previous one ends, and the year
  after the last period of the previous fiscal year.
- `saveFiscalYearVariant` accepts `isCalendarYear: false`, and `saveFiscalYearPeriods` maintains
  the hand-written list.
- An April-to-March variant fixture (`S4` / `aprilYear()`) already exists in
  `tests/fiscal-year-variant-maintenance.test.ts`.

The function's own comment states the intent:

> "A date near a year boundary can belong to the fiscal year that started in the previous calendar
> year or to the one starting in this, so both are tested…"

— and then tested `dateYear` and `dateYear + 1`, which is not "both". The code contradicted its
stated design. An April–March year is the Indian and British convention, so this is a real
calculation error against standard accounting logic, not a data defect.

### Blast radius

`derivePosition` has 132 call sites: every goods movement, goods receipt, supplier and customer
invoice, billing document, payment, payroll run and journal. Nothing in Phases 0–2 calls it
directly, but every Phase 3 posting does.

### Coverage before the fix

`tests/periods.test.ts` exercised only the calendar-year `K4` variant, including a "covers every
day of the year, with no gaps" test — which passed, because for a calendar year the missing
candidate cannot match. The existing shifted-year test in
`tests/fiscal-year-variant-maintenance.test.ts` asserted only `2026-05-15`, a date that does not
need the previous year.

### The fix

One line, in `src/platform/periods/index.ts`:

```ts
for (const fiscalYear of [dateYear - 1, dateYear, dateYear + 1]) {
```

Why it is safe: period windows are contiguous and non-overlapping. For a calendar-year variant the
extra `dateYear - 1` candidate produces windows ending 31 December of the previous year, which
cannot contain a date in `dateYear`. For a shifted variant it is the only candidate that can
contain January–March. For a year-dependent variant it reads that year's row set (or falls back to
the `calendarYear = 0` rows).

### Tests added (`tests/periods.test.ts`)

1. **`places January to March in the fiscal year that started the previous April`** — asserts
   `2026-04-01` → FY2026/1, `2026-06-15` → FY2026/3, `2026-12-31` → FY2026/9, **`2027-01-15` →
   FY2026/10**, **`2027-02-10` → FY2026/11**, **`2027-03-31` → FY2026/12**.
2. **`covers every day of a shifted year, with no gaps`** — walks all 365 days of 2026 and asserts
   zero unresolved. This is the direct regression guard: it used to miss 90 days.
3. **`keeps each shifted year contiguous across the boundary`** — `2027-03-31` is FY2026/12 and
   `2027-04-01` is FY2027/1.
4. **`never resolves a calendar-year date into the previous fiscal year`** — the harmlessness
   proof requested by the owner: on `K4`, `2026-01-01`, `2026-03-31` and `2026-12-31` all resolve
   to fiscal year 2026, so the extra candidate cannot mis-assign a calendar-year date.

### Verification

- **Reproduction proved both ways.** With the fix reverted, exactly the three shifted-year tests
  fail (`3 failed | 11 passed`); with the fix applied, `14 passed`.
- `tests/periods.test.ts` — 14 passed.
- `tests/periods.test.ts`, `tests/fiscal-year-variant-maintenance.test.ts`,
  `tests/fiscal-year-variant-assignment.test.ts`, `tests/carryforward.test.ts`,
  `tests/retained-earnings.test.ts` — **55 passed, 0 failed**.
- Full suite — **6038 passed, 22 failed, 42 skipped (6102)**. All 22 failures are pre-existing and
  unrelated (authorization, password recovery, mail, menu/screen catalogue, report export,
  source-keyword hygiene, worker split, demo safety matrix). A representative subset of 8 of the
  19 failing files was re-run with this change stashed and failed identically (10 failed | 129
  passed), so none is caused by this fix.
- Typecheck: 13 errors, identical in count with this change stashed. All 13 are in unrelated files
  (`tests/ensure-migrator-role.test.ts`, `tests/payment-*.test.*`,
  `.next/types/.../payment-file/route.ts`). **No type error in `src/platform/periods/index.ts` or
  `tests/periods.test.ts`.**
- Commit: `28bed70d861482a2a315256e15532e9a944978fd` on `development`. Tests in that run were
  taken against the working tree of that commit.

### Not fixed in this commit

Nothing else. Per the owner's instruction the commit contains only this defect; every other
calendar-year assumption found is reported in `03-calendar-year-assumption-report.md` with no code
change.

---

## Bug 003 — A route file exports a non-route symbol, so the production build cannot succeed

| Field | Value |
|---|---|
| Status | **FIXED** |
| Discovered | The owner's `docker compose build` failed at `Dockerfile:24` (`npm run build`) |
| Approved | Owner, before the fix was applied |
| Commit | `e5add696` |
| Files changed | `src/app/people/payroll-runs/payment-file/route.ts` |
| Application code changed | 4 lines deleted |

### What failed

```
src/app/people/payroll-runs/payment-file/route.ts
Type error: Route "src/app/people/payroll-runs/payment-file/route.ts" does not match the
required types of a Next.js Route.
  "getPaymentFile" is not a valid Route export field.
```

A Next.js route module may export only the HTTP verbs and a fixed set of route options
(`dynamic`, `revalidate`, `runtime`, …). This one also exported a plain function.

### Why it is a bug and not a data problem

Deterministic, total, and independent of the data: the build's generated route-type check rejects
any export outside the permitted set, so `next build` cannot pass. Nothing in the UAT dataset,
fixtures or environment can change that.

### Pre-existing, and how long

`git blame` attributes the line to `2ca9cb76` (2026-11-22, "Add salary payment files, employee bank
details and controlled reissue"). The same two lines are present on `aa8bc08b`, the commit before
any India UAT work, so **the repository has not built since 2026-11-22**.

### Why the export was dead

Nothing imports `getPaymentFile` from the route:

| File | Imports it from |
|---|---|
| `src/app/people/payroll-runs/page.tsx:26` | `@/modules/people/payroll-payment-file` |
| `tests/payroll-payment-file.test.ts:46` | `../../modules/people/payroll-payment-file` |

The only importer of the route is `tests/payroll-payment-file.test.ts:53`, which uses `GET`,
`POST` and `dynamic` — never the re-export.

### The fix

Delete the `getPaymentFile` import and the `export { getPaymentFile };` line. Four lines, no
behaviour change: the route serves the same GET and POST.

### Verification

| Check | Result |
|---|---|
| `next build` on a scratch worktree at `aa8bc08b` with the fix applied | **Compiled successfully in 2.2 min**, type check passed, route table printed |
| `next build` without the fix | Fails at the type check, as the owner saw |
| `tsc --noEmit` on this tree | The `.next/types/.../payment-file/route.ts` error is **gone** |
| `tests/payroll-payment-file.test.ts` | **21 passed** |

### Not fixed in this commit

The 12 remaining `tsc` errors, all in four `tests/` files (`ensure-migrator-role`,
`payment-file-artifact`, `payment-reissue.ui`, `payroll-payment-reissue`). They do **not** block the
build — Next type-checks only the app tree it generates, and the successful build above proves
it — and they are pre-existing, listed in `08-failing-test-triage.md`.

### A note on how this was missed

I ran `tsc --noEmit` several times during this work and saw this error each time, alongside 12 in
`tests/`. I classified the set as "pre-existing and unrelated" and moved on — correct that it was
pre-existing, wrong that it was unrelated: it stops the build. A `next build` in CI would have
caught it in one line, which is why the triage now distinguishes build-blocking errors from test
errors.

---

# Installer defects (not application code)

Defects I introduced in the installer and fixtures. They are recorded because the installer is a
deliverable and a reader deserves to know what went wrong in it, but they are **not** changes to
the application's behaviour and do not belong in the log above.

## ID-002 — the installer created company code `1000` instead of `IN01`

| Field | Value |
|---|---|
| Status | **FIXED** |
| Discovered | Owner's pre-test review, checking what `A000` held |
| Application code changed | **none** — installer and fixtures only |
| Commit | `67599eb3` |

### What failed

The brief says the company code is `IN01`, and `fixtures/company/IN01/company.json` carries
`identity.companyCode: "IN01"`. But the installer read `structure.companyCode` from
`fixtures/core/organisation.json`, where the neutral pattern carried the product's standard key
`1000`. Everything downstream used `1000` — plant assignments, cost centres, partner company
views, scopes — while the guide and the reset used `IN01`. Two sources of truth, disagreeing.

### Why it is a layering mistake rather than a typo

A company code belongs to the **legal entity**, not to the neutral structure pattern. A second
company in the same tenant would carry a different code on the same pattern. Putting it in `core/`
was wrong for exactly the reason the fixture split exists: `core/` holds only what is country-
*and* company-neutral.

### The fix

`core/` no longer carries `companyCode`; `FixtureSet.companyCode` is `company.identity.companyCode`,
and phases 0, 1 and 2 read the company folder. Verified: company code now installs as `IN01`, and
`tests/in01-install-contract.test.ts` asserts the neutral file has no company code.

## ID-003 — the demo warehouse clerks could not pick, so D3_SALES stopped

| Field | Value |
|---|---|
| Status | **FIXED** |
| Discovered | The owner's `demo:provision` run, which stopped at `D3_SALES` |
| Application code changed | **none** — demo fixtures only |
| Commit | `86570093` |
| Files changed | `src/platform/tenancy/demo-people.ts`, `tests/demo-sales.test.ts` |

### What failed

```
Dummy-data provisioning failed in D3_SALES:
You do not hold the authority SALES.DELIVERY.PICK.
```

`D1_PROCUREMENT` and `D2_PRODUCTION` completed; the run died on the first **pick** of the sales
chain. The partial installation was left in place and marked failed, as designed.

### Why it is a fixture defect and not an application bug

The service was right. Commit `1819f764` ("Sales: company, sales-area and plant scope for
deliveries") added a `SALES.DELIVERY.PICK` check to `confirmDeliveryPicks`. The demo phase picks as
`demo.warehouse1` and `demo.warehouse2`, which hold `DEMO_WH_CLERK_MFG` and `DEMO_WH_CLERK_DIST` —
and those two roles were never given the new authority. They held:

```
INV.*, QM.LOT.CREATE, SALES.GI.POST, SALES.RETURNS.RECEIPT.POST, AUDIT.TRAIL.VIEW
```

`INV.*` is a whole-segment match: it reaches every `INV.` capability and nothing under `SALES.`.
So the clerk could ship the goods issue (`SALES.GI.POST`) but not ready it (`SALES.DELIVERY.PICK`).
Nothing in the application needed to change; the fixture roles had drifted behind the service's
authority list.

### The fix

Both warehouse-clerk roles now hold `SALES.DELIVERY.PICK` alongside the authorities they already
had for shipping. The clerk who empties the shelf is the clerk who picks it, which is what the
surrounding comment already said the role was for. The two roles are told apart by the plant they
stand in, not by what they may do, so both carry the same list.

### Verification

Run on `cairn_dp_pickcheck_20261125_140249`, a disposable database created for the purpose and
dropped afterwards — never a persistent one.

| Check | Result |
|---|---|
| `demo:provision` before the fix | Stops at `D3_SALES` with the refusal above |
| `demo:provision` after the fix | `D3_SALES \| COMPLETED \| {picks: 5, orders: 6, deliveries: 5, goodsIssues: 5}` |
| The tenant's own rows (`set local cairn.client='DMO1'`) | 5 deliveries, 5 picked or goods-issued, 7 pick rows |
| Regression test against the pre-fix source | Fails, naming the missing authority |
| `tests/demo-sales.test.ts` | 15 passed |

The regression test reads the role blocks in `demo-people.ts` and refuses a warehouse role that
can ship a delivery but not pick one. Proven both ways: with the authority removed the test fails;
with it restored, it passes.

## ID-004 — D7 assigned no structure to the HR employees, so D9 could not release the run

| Field | Value |
|---|---|
| Status | **FIXED** |
| Discovered | The same end-to-end run, after ID-003 was fixed and D3 no longer stopped it |
| Application code changed | **none** — demo fixtures only |
| Commit | `5e1330df` |
| Files changed | `src/platform/tenancy/demo-payroll.ts`, `tests/demo-provisioning-contract.test.ts` |

### What failed

With ID-003 fixed the run continued past `D3_SALES` and stopped at `D9_PAYROLL_POST`:

> `D9_PAYROLL_POST: run … still names 10000020 (NO_STRUCTURE), 10000101 (NO_STRUCTURE),
> 10000102 (NO_STRUCTURE), 10000103 (NO_STRUCTURE).`

### Why it is a fixture defect and not a payroll bug

Payroll behaved exactly as designed, and the design is deliberate on both sides:

- `proposePayrollRun` (D8) selects **every active employee** of the company for the period and
  records a named reason for anyone it cannot pay. It does not silently skip them.
- `recalculatePayrollRun` (D9) refuses to release a run that still names an exception, because a
  released result is frozen and a partly-paid run is not a payroll.

The four people it named are the HR population — Rania Khoury, Bassam Idris, Salma Nabil and
Hadi Mourad (10000101–10000103 and 10000020). They were added to `B_PEOPLE` by `dbd53a36`
("People: leave policies, plant/company scope, position tiers and hire approval") on 2026-11-19.
`D7_PAYROLL`'s assignment list was last touched by `5ba0c777` on 2026-11-15 — four days earlier —
and was never extended, so it assigned the fifteen employees that existed when it was written and
left the four that came after with no structure at all.

### The fix

The four HR employees are assigned in `D7_PAYROLL` with the rest: the HR Manager on `MGMT` and the
three HR staff on `STAFF`, at demonstration bases consistent with their tier. Payroll behaviour is
untouched — no engine change, no tolerance for exceptions, no skip. The controller (10000016)
remains the one deliberate exception, because D9 exists to show an exception being cleared.

### Verification

- A cross-phase invariant test now pins the rule: every employee `B_PEOPLE` hires, except the one
  named as `DEMO_PAYROLL_UNASSIGNED`, holds a structure by the time D8 proposes the run. It reads
  the employee list and the three phases that assign or hire, so a fifth HR employee added later
  without a structure fails the test rather than the installation.
- Proven both ways: with the four lines removed the test fails and names all four employees; with
  the fix restored it passes.
- End-to-end on `cairn_dp_d9check_20261125_143051`, a disposable database created for the purpose
  and dropped afterwards. The whole installation runs `A_FOUNDATION` → `D19_RELEASE` with exit 0.

| Check | Result |
|---|---|
| `D7_PAYROLL` / `D8_PAYROLL_RUN` / `D9_PAYROLL_POST` | COMPLETED / COMPLETED / COMPLETED |
| D8 detail | 21 employees, **1** exception — the controller, by design |
| D9 detail | POSTED, document `1000/2026/100`, debit `56961.7200` |
| `payroll_run` at the run's period | POSTED, 22 employees, **0** exceptions |
| Employees holding a structure | 23 of 23, including 10000101–10000103 and 10000020 |
| `tests/demo-provisioning-contract.test.ts` | 10 passed |

## ID-005 — the IN01 roles could not reach twelve Phase 3/4 steps

| Field | Value |
|---|---|
| Status | **FIXED** |
| Discovered | The owner asked whether ID-003's root cause also affected IN01 |
| Application code changed | **none** — fixtures only |
| Files changed | `fixtures/core/organisation.json`, `fixtures/company/IN01/company.json`, `tests/demo-sales.test.ts`, `tests/demo-organisation.test.ts` |

### What failed

IN01 builds its roles from `fixtures/core/organisation.json`, a **second copy** of the twelve
`DEMO_*` roles that the demo keeps in `demo-people.ts`. ID-003 fixed the demo copy. The fixture
copy still lacked `SALES.DELIVERY.PICK`, so `in01.dispatch` could not pick a delivery — the same
defect, still live for the company the UAT guide is written against.

A dry-run of every Phase 3/4 step against that fixture found **twelve** refusals, not one:

| Section | Account | Role | Refused because |
|---|---|---|---|
| 3.1.4, 3.4 | `in01.ap` | `DEMO_ACCOUNTANT` | lacks `PROC.INV.RECORD` |
| 3.2.5 | `in01.controller` | `DEMO_CONTROLLER` | lacks `PROD.ORDER.SETTLE` |
| 3.3.1 | `in01.sales` | `DEMO_SALES_CLERK` | no Plant scope; the quotation service requires one |
| 3.3.2 | `in01.sales` | `DEMO_SALES_CLERK` | no Plant scope; cannot raise **or release** an order |
| 3.3.3 | `in01.sales` | `DEMO_SALES_CLERK` | no Plant scope; cannot create the delivery |
| 3.3.3 | `in01.dispatch` | `DEMO_WH_CLERK_DIST` | lacks `SALES.DELIVERY.PICK` |
| 3.3.4 | `in01.sales` | `DEMO_SALES_CLERK` | no Plant scope; cannot bill |
| 4.1 | `in01.controller` | `DEMO_CONTROLLER` | lacks `PROC.GRIR.MAINTAIN.POST` |
| 4.2 | `in01.controller` | `DEMO_CONTROLLER` | lacks `FIN.ASSET.DEPRECIATE` and `FIN.JOURNAL.POST` |
| 4.4 | `in01.controller` | `DEMO_CONTROLLER` | lacks `CFG.COST.ALLOCATION.DEFINE` |
| 4.6 | `in01.controller` | `DEMO_CONTROLLER` | lacks `FIN.CLOSE.COCKPIT` |

The Plant-scope rows are the subtle ones. `sales-order.ts`, `delivery.ts`, `billing.ts` and
`quotation.ts` call `verifyServiceAuthorityInTx` **without** `requirePlantScope: false`, and that
function fails closed for an actor holding no Plant grant. A capability alone was therefore not
enough, and the guide's own 1.4 note — "`DEMO_SALES_CLERK` … cannot move stock" — says nothing
about a delivery being a plant document. The demo had already given its own `demo.sales` both
plants for this reason; IN01 had not.

### The fix

Fixture only, as the owner directed:

- `in01.dispatch` (`DEMO_WH_CLERK_DIST`) gets `SALES.DELIVERY.PICK` through the shared role.
- `in01.ap` (`DEMO_ACCOUNTANT`) gets `PROC.INV.RECORD`.
- `in01.sales` gets plants `1000` and `2000`, mirroring the demo's `demo.sales`.
- The controller gets exactly six authorities: `PROD.ORDER.SETTLE`, `PROC.GRIR.MAINTAIN.POST`,
  `FIN.ASSET.DEPRECIATE`, `FIN.JOURNAL.POST`, `CFG.COST.ALLOCATION.DEFINE`, `FIN.CLOSE.COCKPIT`.
  Named, never a wildcard.

**Nothing breaks segregation of duties.** The controller still cannot raise an order, record a
supplier invoice, post a goods receipt or issue stock — asserted in
`tests/in01-role-authority.test.ts`. The accountant/releaser separation is a **person**-level rule,
not a role one: `releaseDocument` refuses a releaser who is the document's preparer
("was prepared by you; you cannot release it"), so `FIN.*` including `FIN.JOURNAL.RELEASE` on the
accountant was never a breach, and the demo's `D19_RELEASE` depends on exactly that structure.

### Verification

The full dry-run after the fix — 50 authorities across 34 guide steps, every Phase 3 and Phase 4
section, including the release, approval, payroll, quality, display and report steps:

```
steps=50  refusals=0
```

Each of the twelve refusals above was reproduced first by reverting both fixtures to `HEAD` and
re-running the test: it named every one, including all five Plant-scope rows. With the fix applied
it passes.

## ID-006 — the twelve roles were defined twice, so a fix to one left the other wrong

| Field | Value |
|---|---|
| Status | **FIXED** |
| Discovered | While fixing ID-005: the demo copy and the fixture copy had drifted apart |
| Application code changed | **none** — fixture and platform-module wiring only |
| Files changed | `src/platform/tenancy/demo-people.ts`, `fixtures/core/organisation.json` |

### What failed

`demo-people.ts` restated all twelve roles inline; `fixtures/core/organisation.json` carried the
same twelve for the IN01 installer. They were identical when written and then diverged twice:

1. `1819f764` added `SALES.DELIVERY.PICK` to the delivery service. Neither copy followed, which is
   ID-003.
2. ID-003 fixed the **demo** copy only, which left the two copies actively disagreeing —
   `DEMO_WH_CLERK_MFG` and `DEMO_WH_CLERK_DIST` held the pick in one file and not the other.

Two sources of truth for one grant is the defect; ID-003 was its first symptom and ID-005 its
second.

### The fix

`demo-people.ts` now **reads** the roles from `fixtures/core/organisation.json` instead of restating
them. The fixture is the right home: `core/` is where a country-neutral role belongs, the
fixture-driven installer already reads it, and the demo's operations image ships it. One copy
remains, so a role can be wrong in exactly one place. The reasoning that used to live in code
comments (why the production clerk holds `INV.GI.POST`, why the controller may hold
`FIN.JOURNAL.POST`) moved into the module docblock, where it still sits next to the code that
grants it.

### Verification

- `tests/in01-role-authority.test.ts` refuses a `code: 'DEMO_…', name: …` block in
  `demo-people.ts`, so the second copy cannot come back.
- The full demo installation was re-run end to end on a disposable database
  (`cairn_dp_roles_20261125_150049`, dropped afterwards): 23 phases complete, exit 0, 23 roles
  created, and the created rows carry the added authorities (`SALES.DELIVERY.PICK` on both
  warehouse clerks and the sales clerk; `FIN.JOURNAL.POST` on the controller).
- `tests/demo-organisation.test.ts`, `tests/demo-sales.test.ts` — 27 passed.

## ID-007 — the deployment-invariant test still expected the pre-`166e1789` command

| Field | Value |
|---|---|
| Status | **FIXED** |
| Discovered | While confirming the Dockerfile's effect on `db:sync-role` |
| Application code changed | **none** |
| Files changed | `tests/demo-safety-matrix.test.ts` |

### What failed

`tests/demo-safety-matrix.test.ts` asserted `steps[0] === 'npm run db:sync-role'`. `166e1789`
("Create the migration role on deployments and migrate as it") put `db:ensure-migrator` in front,
so the test failed on `development` for a reason that had nothing to do with the demo.

### The fix

The test's claim is that the demo step runs **last**, so a refused installation stops the
application. It now asserts that directly: the last step is `demo:provision`, the first is
`db:ensure-migrator`, and migrations precede reference data precede the demo. The exact
sync-role bracketing is already asserted, and still passes, in
`tests/docker-provisioning-contract.test.ts`.

**Answering the owner's question:** the CMD change does not affect `db:sync-role` on a fresh
deployment. Both `db:sync-role` calls remain, still bracketing `db:migrate`. On a fresh volume
`docker/postgres/10-app-role.sh` creates both roles before the container runs, so
`db:ensure-migrator` finds the role present and exits 0 without changing anything. On a volume
initialised before that script existed, it creates the missing role — which is the defect it was
added to fix.

## ID-008 — the IN01 installer crashed on a shared ledger instead of refusing

| Field | Value |
|---|---|
| Status | **FIXED** |
| Discovered | The owner's first `in01-install.ts` run, against a database the demo had already filled |
| Application code changed | **none** — installer only |
| Files changed | `src/platform/tenancy/in01-reset.ts`, `scripts/in01-install.ts`, `tests/in01-install-contract.test.ts` |

### What failed

```
India install failed: duplicate key value violates unique constraint "demo_installation_one_uq"
    at ErrorResponse (…/node_modules/postgres/cjs/src/connection.js:815:30)
    …
```

Reached by running the documented C6 command against a database where `demo:provision` had already
run, which is what the `migrate` service's CMD does on every `docker compose up`.

### Why it is an installer defect

`demo_installation_one_uq` is an index on `((true))` — **one row for the whole table**, whoever
wrote it — because the marker's meaning is "this database is installer-made". Both datasets share
the table and are told apart by `operation`.

- `claimDemoInstallation` selects **every** row, then refuses a foreign operation by name: *"This
  database holds a demo dataset from build X; this build produces Y."*
- `claimInstallation` (IN01) selected `where operation = 'in01-uat-dataset/2026-11'`, so a row the
  demo had written was **invisible to it**. It concluded the database was unclaimed, inserted, and
  PostgreSQL answered with `23505`.

Measured on a disposable database holding only the demo's row:

```
IN01 claim saw:   0
Actually existed: DEMO_PROVISION_V1 | COMPLETED
Index permits:     1
```

So IN01 could never report the conflict, and the operator got a constraint violation naming an
index rather than the dataset standing in their way.

### The fix

1. The claim now reads **every** ledger row and refuses a foreign `operation` by name, saying which
   dataset holds the database and what to do — the mirror of `claimDemoInstallation`'s check. The
   cross-database refusal is unchanged.
2. `scripts/in01-install.ts` prints an `In01ResetError` as a refusal with its remedy, the way the
   reset path already did, instead of a five-frame stack trace. A refusal is a decision, not a
   crash.

### Verification

Reproduced, then fixed, on disposable databases (both dropped afterwards):

| Scenario | Before | After |
|---|---|---|
| Fresh database | Installs, exit 0 | Installs, exit 0; a second run is idempotent, exit 0 |
| Database already holding `DEMO_PROVISION_V1` | `23505` on `demo_installation_one_uq` | `India installer refused:` names the dataset and the remedy, exit 1, no stack |

The refusal now reads:

```
India installer refused:
  This database already holds the dataset DEMO_PROVISION_V1 (cairn_…), not this one.
  The India UAT dataset needs its own empty database: set CAIRN_DATABASE_NAME and
  ENABLE_DUMMY_DATA=false before the first `docker compose up`, as 00-HOW-TO-START §C2–C3 says.
```

`tests/in01-install-contract.test.ts` pins both halves: the claim carries no `where operation =`
predicate and does refuse a foreign operation, and the index really is `((true))`. 41 tests pass.

### Not fixed in this commit

The owner's `.env` still carries `ENABLE_DUMMY_DATA=true` and the default database name. §C2–C3 of
`00-HOW-TO-START.md` require `CAIRN_DATABASE_NAME=cairn_in01_uat` and `ENABLE_DUMMY_DATA=false`
**before the first** `up`, so the two datasets never share a database in the first place. That is
operator configuration, not code, and it is the owner's to change.
