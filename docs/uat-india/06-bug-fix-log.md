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
