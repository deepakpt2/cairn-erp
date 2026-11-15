# Open gaps — payroll (item 4, phases 1–5b), cost centre planning (item 5), activity prices (item 6)

Recorded 2026-11-15, at commit `a52ec282` on `development`; item 6 (KSPI) added after it. These are deferred, not forgotten: each was
either out of scope by its own spec or found while building and left for a later decision. Older
deferrals made before this work stay in `DEFERRED_ISSUES.md`.

Status key: **Spec** = the item's own spec put it out of scope · **Found** = found during the build ·
**Decision** = needs a choice from the product owner before it can be built.

---

## 1. Payroll — functionality not built

| # | Gap | Kind | Notes |
|---|---|---|---|
| P1 | Statutory payroll: tax, social insurance, filing formats, country leave law | Spec | DV-001: nothing statutory ships. Amounts are configured, never legislated. |
| P2 | Retroactive accounting | Spec | A released result is frozen. A correction is a reversal plus a run in a later period. Off-cycle runs (phase 5) pay only employees no live run covers; they never recalculate. |
| P3 | End-of-service provisions | Spec | `EOS_PROVISION` components are refused by readiness, the run and structure maintenance. The demo structures no longer name EOSPROV (the component and its mapping stay). |
| P4 | Currency conversion | Spec | An employee paid in a currency other than the company's books is a run exception (`CURRENCY_DIFFERS`). |
| P5 | Payslip document or output | Spec | Results are on screen only (`/people/payroll-results`). |
| P6 | Payroll import (`PEOPLE.PAYROLL.IMPORT`, result origin `IMPORTED`) | Spec | Capability and column exist; nothing uses them. |
| P7 | Profit centre on payroll postings and payments | Spec · Decision | Nothing in the model supplies one. Needs a profit centre on the cost centre master or the position assignment — a new field. |
| P8 | One payroll document per employee | Spec | The PR document is summarised by account and cost centre. Trace is document → run → result → line. The PY payment has one line per employee. |
| P9 | Payroll's own reversal service | Spec | Reversal is the generic `/finance/document-reversal`. A reversed PR or PY leaves the run `POSTED` / the payment row standing; the run is never reopened. |
| P10 | Payment medium (bank file, DME, cheque, advice) | Spec | Phase 4 produces the accounting effect only. |
| P11 | Employee bank details | Spec | A whole run is paid from one house-bank account. |
| P12 | Partial payment / per-employee payment status | Spec | A run is paid whole, once. |
| P13 | Employee screen readiness covers the current month only | Found | `/people/employees` pay section. |

## 2. Payroll — authority and data integrity

| # | Gap | Kind | Notes |
|---|---|---|---|
| A1 | No role holds any payroll capability | Spec · Decision | `PEOPLE.PAYROLL.*`, `PEOPLE.PAYROLLRUN.EXECUTE` are withheld (history/9199). In the demo only `demo.admin` (`*`) reaches payroll. |
| A2 | In-process callers are judged on capability only | Found · Decision | The demo provisioner and the tests call payroll services with a capability list and no session; that path carries no Company Code limit. Screens and actions always pass the session. (Phase 5 / 5b put this out of scope.) |
| A3 | `assignmentFor(tx, …)` has no access check | Found | It is an internal transaction helper with no session to judge; the public `listAssignments` and readiness check are guarded instead. |
| A4 | Structure-component removal is a hard delete | Found | Added in phase 2 so EOS components can leave a structure. Calculated results keep their own lines; the change document is the only record of the removed component. |

## 3. Cost centre planning (KP06) — item 5

| # | Gap | Kind | Notes |
|---|---|---|---|
| C1 | Plan version copy (KP97/KP98) | Spec | Not built. |
| C2 | Plan version administration | Spec | Versions stay a free key of up to three characters, as for activity rates. |
| C3 | No role holds `CO.PLAN.COSTCENTER.MAINTAIN` | Spec · Decision | Only `demo.admin` can plan in the demo. |
| C4 | Assessment, distribution, activity price calculation (KSU5, KSV5, KSPI) | Spec | Downstream of planning; items #5, #6, #9 of the ranked list. |
| C5 | Annual-total spread uses equal shares only | Found | No seasonal or weighted distribution keys. |
| C6 | A cost centre with no company code is scoped against every company of its area | Found | The service needs reach over all of them to plan such a centre. |

## 3b. Activity price calculation (KSPI) — item 6

| # | Gap | Kind | Notes |
|---|---|---|---|
| K1 | Price indicator 2 (automatic on capacity) | Spec · Decision | `work_center` carries no cost centre, so there is no path to the capacity that would be the denominator. Needs a new field on the work centre master. Refused by name. |
| K2 | No iteration | Spec | One pass (`iterations: 1`). Becomes incomplete when assessment (KSU5) or distribution (KSV5) lands. |
| K3 | Two-decimal prices | Spec · Decision | `activity_rate.fixed_price`/`variable_price` are `numeric(11,2)`; the residual is reported. Widening is a migration. |
| K4 | No fixed/variable split | Spec | No fixed/variable indicator on a cost element; all cost is fixed, variable price 0. |
| K5 | A cost centre planning more than one activity type is refused | Decision (chosen) | No equivalence numbers to split the centre's cost; owner chose refusal over a guessed rule. |
| K6 | No role holds `CO.PLAN.ACTIVITYPRICE.EXECUTE` | Spec · Decision | Only `demo.admin` in the demo. |
| K7 | A calculated price goes stale when quantities change | Found | KP26 accepts the standing calculated price back unchanged; after changing a planned quantity the calculation must be run again. |
| K8 | Prices are written into existing rows only | Found | Periods a pair never planned get no row and no price (the spec allowed upserting them). |

## 4. Demo data and environment

| # | Gap | Kind | Notes |
|---|---|---|---|
| D1 | `demo.admin` carries explicit Company Code 1000 and Plant 1000/2000 scope | Found · Decision | Granted by `D9_PAYROLL_POST` (approved) because the judged posting services refuse an unscoped actor. Its practical reach is unchanged. |
| D2 | Demo failed-markers were reset by hand in erp_dev, three times | Found | `D9_PAYROLL_POST` once, `D12_CO_PLAN` twice: each time the cause was fixed, `status` set back to `RUNNING`, and the phase resumed. Status updates only, nothing deleted. A fresh install runs every phase clean (verified for D1–D11 on a scratch database; D12 was fixed after that run). |
| D3 | Leftover browser-test data in erp_dev | Found | 10000016's MGMT assignment from 2026-11-15 (phase 1); the off-cycle November run was released, posted and paid through the UI (phase 5). |
| D4 | The demo password changes with every appended demo phase | Found | By design of the resume path; the current one is in `credentials/demo-credentials.txt`. |
| D5 | Test tenants carry no `RF_BELEG` number range | Found | The payroll posting/payment/follow-up tests maintain their own. |
| D6 | Demo payment dated the last day of the period, not the day after | Found | Keeps it inside the demo's open periods. |

## 5. Pre-existing test failures — diagnosed, not fixed

| # | Test | Cause | Fix when taken up |
|---|---|---|---|
| T1 | `tests/batch-determination-contract.test.ts` — "writes one pick row per batch, numbered on from the last" | Expects the pick request key `` `${parsed.requestKey}#${index + 1}` ``; commit `0443b972` (2026-11-12) changed `src/modules/sales/delivery.ts:1269` to `#<line>.<pick>` and the test was not updated. | Update the expected string. |
| T2 | `tests/action-security.test.ts` — "posts in the session tenant under the actual user, not the form tenant" | The test inserts the user and session but grants the user no role, capability or Company Code restriction in the database; `postGlDocument` judges the session there and refuses, so the action returns `ok: false`. | Give the test user a role holding `FIN.JOURNAL.POST` and a scope for company 1000. |

Neither touches payroll or planning code. Full suite at `5ba0c777`: 4,679 / 4,681 passing — only these two.

## 6. Verification not done

| # | Gap |
|---|---|
| V1 | `npm run lint:ip` not run (it was failing before this work). |
| V2 | Full suite not re-run after phase 5b and item 5 (targeted suites only, as their specs asked). |
| V3 | Several posting events that predated phase 5 now carry labels; `/config/account-determination` was checked in the browser, other screens using `acctDet.event.*` were not. |
