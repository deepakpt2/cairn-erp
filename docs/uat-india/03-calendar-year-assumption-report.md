# Calendar-year assumptions — findings report

Requested with bug 001's approval: *"Separately, check for other places that may assume fiscal
year = calendar year … Report findings as a list. Do not change them; I will decide per item."*

**No code was changed for any item in this report.** Bug 001 is the only fix
(`28bed70d861482a2a315256e15532e9a944978fd`).

Method: grep for `getFullYear()` / `getUTCFullYear()`, `slice(0,4)` on date strings, and
explicit year arithmetic across `src/`. Each candidate was then read in context to decide whether
it produces a **wrong result** or merely a **default value**.

Severity: **A** = wrong result once a shifted year is used · **B** = correct result, but a
misleading default · **C** = correct and unrelated.

---

## A. Produces a wrong result under an April–March year

### A1 — `journalRangeReadiness` defaults to the calendar year, and is what the *posting path* checks

`src/modules/foundation/number-ranges.ts:122`

```ts
export async function journalRangeReadiness(tx, client, fiscalYear = new Date().getUTCFullYear())
```

Four callers omit the year, and three of them are inside the write path
(`number-ranges.ts:228, 332, 400`). In an Apr–Mar company on, say, 15 February 2027, this checks
readiness for fiscal year **2027**. The range that will actually be consumed is either year 2027 or
the year-0 fallback — and the demo creates its interval as `fiscalYear: 0` — so the check can pass
or fail on the wrong year.

The *allocation* itself is correct: `platform/posting/index.ts:198-205` passes
`input.fiscalYear`, and `platform/numbering/index.ts:216-224` selects the year-specific interval
with a year-0 fallback. So this is a **readiness display / guard**, not a numbering defect.

**Impact:** the "number ranges ready" state can name the wrong fiscal year; with year-specific
intervals a company could be told it is ready when the year it will post into has none.

### A2 — `exchangeRate` validFrom is always 1 January

`src/modules/foundation/standard-config.ts:823-824`

```ts
const today = new Date();
const validFrom = `${today.getUTCFullYear()}-01-01`;
```

Emitted by the standard package for the seeded FX rates. For an Apr–Mar company the rate set
starts at 1 January, months before the fiscal year begins — harmless for rate lookup (it only
needs a date earlier than the first posting), but the seeded rate's validity does not align with
the fiscal year a user sees, and a rate that is later "corrected for the year" would have to be
maintained from January. **B**, unless a rate is ever re-derived per fiscal year.

---

## B. Correct result, misleading default

These read an explicit year when one is supplied and fall back to the calendar year only when it
is absent. They are not wrong, but on an Apr–Mar company a blank field will show `2027` for a
fiscal year that began in April 2026 — which reads as a bug to a user and will read as one to the
UAT tester.

| # | Location | Note |
|---|---|---|
| B1 | `src/modules/finance/report-exports.ts:34, 152, 306, 338` | Balance sheet, P&L, trial balance, cash-flow exports default `fiscalYear` to the calendar year and periods to 1–12. A period *number* is variant-agnostic here (it comes from the ledger), so the only defect is the year default and the 1–12 range implying Jan–Dec. |
| B2 | `src/app/finance/consolidation-monitor/actions.ts:32` | Same pattern for the consolidation monitor. |
| B3 | `src/app/controlling/cost-center-report/page.tsx:39`, `profit-center-report/page.tsx:32`, `cost-center-planning/page.tsx:67` | Screen defaults. |
| B4 | `src/app/config/activity-rates/page.tsx:54-55` | Activity-rate year defaults to the calendar year. |
| B5 | `src/app/config/number-ranges/RangeForm.tsx:32` | New-interval form pre-fills the calendar year. This is the human-facing half of A1. |
| B6 | `src/app/config/fiscal-year-variants/FiscalYearVariants.tsx` (`thisYear`) | The screen windows year-0 rows against the **current calendar year**, so an April variant previews 1 Apr of *this* year rather than the fiscal year in progress. `fiscal-year-variant-maintenance.ts:139` does the same for the derived start/end. |
| B7 | `src/app/inventory/physical-inventory-count/page.tsx:132`, `physical-inventory-differences/page.tsx:52` | Default the fiscal year on a new count. |
| B8 | `src/app/config/factory-calendars/FactoryCalendarForms.tsx:103-105` | Holiday year defaults. |
| B9 | `src/app/config/posting-periods/page.tsx`, `src/app/finance/*` screens (vendor/customer balances, journal balances, subledger tie-out, trial balance, P&L, balance sheet, consolidated statements) | Same "default to this calendar year" pattern throughout. |

---

## C. Checked and correct — no assumption found

Recorded so the owner can see what was cleared, not only what is outstanding.

| Area | Finding |
|---|---|
| **Year-end close / carry-forward** (`finance/carryforward.ts:159-161`) | Takes `targetFiscalYear` explicitly and derives `sourceYear = target - 1`. Correct for any variant. |
| **Depreciation** (`finance/asset-depreciation.ts:243-301`) | Takes `fiscalYear` and `postingPeriod`, then validates them with `derivePosition` and `periodWindows` against the company's variant. This was *actively broken* for Apr–Mar before bug 001 and is correct now. |
| **Payroll** (`people/payroll-run.ts:113, 1508, 1164`) | `fiscalYear` and `period` are explicit inputs; period dates come from `periodDates(...)`, and the posting date is judged by `derivePosition`. Correct. |
| **Posting number allocation** (`platform/posting/index.ts:198-205`, `platform/numbering/index.ts:216-224`) | Passes the document's real fiscal year; a year-specific interval wins over year 0. Correct. |
| **Financial statements** (`finance/balance-sheet.ts:204-209`, `trial-balance.ts`, `profit-loss.ts`) | Read `fiscal_year` and `posting_period` from the ledger rows; opening balances are `fiscal_year < selected`. Variant-agnostic. Correct. |
| **`periodWindows` / `buildPeriodRows`** (`platform/periods/windows.ts`, `index.ts:352-406`) | Explicitly model `yearShift` for shifted years. Correct. |
| **Leave year** (`people/leave-absence.ts:136`, `leave-report.ts:178`, `leave-ledger.ts:242`) | Uses the **calendar year** for `leave_quota` (`schema.ts:1195`), which is a deliberate leave-year concept, not the fiscal year. Correct as designed — but note it means an Indian company's EL/CL year is the calendar year unless the owner wants an April leave year (would be a **new feature**, not a fix). |
| **`slice(0,4)` on dates** (`sales/output.ts`, `audit/workspace.ts`, `production/cost-estimate.ts`, `foundation/factory-calendar.ts`) | These take the calendar year of a *document date* for a key or a filter, not a fiscal year. Correct in context. |
| **`purchasing/invoice-verification.ts:1217`** | Falls back to `Number(postingDate.slice(0,4))` **only when the company has no fiscal-year variant assigned** — an already-refused state. Correct as a fallback. |

---

## What I would change first, if you approve

In order of risk, with the smallest change each:

1. **A1** — make the posting-path callers pass the document's fiscal year rather than defaulting.
   This is the only item that can produce a wrong *guard* decision in the write path.
2. **B1/B2** — have the report exports and the consolidation action default from the company's
   variant (derive "the fiscal year containing today"), so a blank field shows the year in progress.
3. **B6** — window the variant screen against the fiscal year in progress rather than the calendar
   year.
4. **B3–B5, B7–B9** — cosmetic defaults on screens; lowest value, largest surface.

Nothing here is proposed as a change in this step.
