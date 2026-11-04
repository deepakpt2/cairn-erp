# Production-order cost basis — design proposal

**Status:** the first bounded, read-only actual-posting report is implemented as a partial DI-012 slice. The complete DI-012 cost-basis work remains open.
**Prepared:** 2026-11-04, after CO09 Slice 2.
**Scope boundary:** no MIGO or CO15 changes. No persistent database access, migration, or posting behavior change.

## Implemented first slice

- Migration `9215_production_order_cost_report.sql` creates a `security_invoker` view over posted/reversed journal lines assigned to a production order, adds an order-ledger index, and registers the dedicated route/capability. It was validated only on the newly created disposable `cairn_migration_test_20261104_di012r9` (338 migrations recorded, including 9215), then dropped after confirming its owner and zero active sessions; no persistent database was migrated.
- `PROD.ORDER.COST.DISPLAY` is exact-grant-only, so broad role patterns do not grant this report. The page is `/production/order-cost-report`; the production-order display points to it instead of refusing the cost lookup without an alternative.
- Totals are grouped by company, document currency, and local currency. Debit, credit, and signed net are shown separately; no currencies are converted or silently combined. Fiscal-year/period filters apply to journal posting periods, and reversal rows remain visible.
- Material-document details are source/drilldown evidence only and do not add a second amount. Confirmation activity quantities are not monetarily valued; there is no activity-rate estimate, WIP calculation, variance categorization, settlement, or posting action.
- Service/contract and settlement reconciliation tests cover exact arithmetic, period filters, no cross-tenant lookup, and pre-/post-settlement actuals. The settlement suite passed all 6 tests in the full run; the report contract passed all 5. The browser target passed on the documented server at commit `f090334`, proving exact capability setup, filtered/unfiltered totals and line counts, source detail, and no report writes. The full `npm test` run at `813e117` completed with 3,706 passed and 33 failed across 18 files (3,739 total); two documentation-consistency failures directly related to this slice were corrected afterward, and the updated focused documentation/contract/browser-target gate passed 236/236. The full suite was not rerun after those documentation/test-harness-only corrections, so the full-suite gate remains not green.

## Recommendation

The first bounded slice is implemented at `/production/order-cost-report`. It reads posted or reversed journal lines assigned to the selected order through an invoker-security view, and displays debit, credit, and net by company and document/local currency, with posting period, G/L, journal/source references, and material/plant detail. No material-document value is added a second time. The report is read-only and the existing settlement service is unchanged. WIP, variance categorization, target/standard cost, and activity-cost posting remain separate decisions and later slices.

## Source review

| Source | What is persisted today | Design consequence |
|---|---|---|
| `journal_entry_line` | Production-order assignment, company code, G/L, debit/credit, document and local amounts, currency; postings are linked to a journal header and status. | This is the monetary ledger source for the report. Use the production-order assignment and posting period. Preserve debit and credit columns as well as net; do not reconstruct accounting value from quantities. |
| Production-order settlement (`src/modules/production/order-settlement.ts`) | Reads journal lines assigned to the production order, checks company/currency and settlement-period scope, nets signed balances by G/L, and posts only when profile, allocation assignment, and rule are configured. | Settlement already consumes posted order actuals. A report should reconcile to that same scope and not double-count settlement journals or restate the settlement service. |
| `material_document_line` and its header | Quantity, entry/base unit, unit price, value/currency, order/item reference, direction, and reversal lineage. | Use these as source-document drilldown and reconciliation evidence, not as a second amount to add to journal lines. The posting journal is authoritative for currency-valued accounting totals. |
| CO11N confirmations and `production_confirmation_activity` | Confirmed quantities by operation/activity parameter and unit, plus confirmation posting date. | These are actual quantities, not monetary actuals. No activity-rate amount or rate snapshot is stored with the confirmation. |
| `work_center_costing` | Effective-dated work-center to cost-center/activity-type mapping and a formula key. | The mapping is mutable configuration, not a frozen order cost assignment. The work-center module explicitly says the formula key is stored but not calculated. Do not apply formulas or silently attribute historic confirmations using a changed mapping. |
| `activity_rate` | Plan version, fiscal year/period, planned quantity, fixed and variable prices, and price unit. | These are plan rates, not actual rates. Valuing confirmation activity with them would be a plan-rate estimate, not posted actual cost. Keep it out of the actual ledger total unless the owner authorizes and labels a separate estimate. |
| Production-order master | Newer orders snapshot company, controlling area, and currency; older rows may lack these values. | The report must expose missing context as a data gap, not guess a company or currency. |

## Important distinction

“Actual activity quantity” and “actual activity cost” are different. A confirmation can store actual time/activity quantities, but this code does not currently create an activity-cost journal posting from them. Multiplying those quantities by `activity_rate` would use a **planning** rate; it would not become an actual accounting posting merely because the quantity came from a confirmation.

Likewise, goods-movement amounts already have material-document values and journal postings. Combining both ledgers in one sum would double-count. The report shows each assigned journal amount once and retains its source-origin reference plus material/plant details; a material-document amount is not added again.

## Implemented report behavior

The service and page implement the following bounded first slice:

1. One order or a bounded order selection; tenant-scoped and capability-gated.
2. Rows from posted journal lines assigned to the selected production order, joined to their journal headers and source origins.
3. Period filtering based on the actual journal posting period and the configured fiscal-year variant; no inferred period from confirmation date or order dates.
4. Display G/L account, debit, credit, net, amount/currency, posting date/period, document reference, and order. Keep both document/local currency semantics explicit; refuse or flag mixed/missing order currency rather than convert without an approved exchange-rate policy.
5. Retain the journal source-origin class/key, document reference, material, and plant as source evidence. Material-document values are not included as extra report amounts. Reversal source rows remain visible and net through their posted journal lines.
6. Confirmation quantities are explicitly described as unvalued and are not monetarily shown in this slice. Do not multiply them by a plan rate.
7. No settlement, journal write, stock write, status change, accumulated counter, or source-document mutation.

## Later decisions for DI-012 beyond the implemented first slice

- **Activity costing:** decide separately whether to authorize actual activity-cost postings. Confirmation quantities remain unvalued here; plan rates are not actuals.
- **WIP, target/standard cost, and variance:** define accounting policy and source basis before any valuation, WIP calculation, or variance category is implemented.
- **Additional currency and period policies:** any conversion, closed-period treatment, or broader grouping must be separately specified; the report preserves document and local currencies separately and filters by fiscal year/period.
- **Receipt valuation:** the report presents the actual assigned journal lines as posted. Do not interpret net balances as a production variance without approved target-cost rules.

## Acceptance criteria after authorization

- Report amounts reconcile exactly to the selected production-order journal lines by currency, G/L, and period, including reversals.
- Material-document drilldown reconciles without adding the same value twice.
- Debit, credit, and net totals remain separately visible; mixed currencies are never silently summed.
- Missing company/currency/source context is reported as a gap, not filled with defaults.
- Confirmation activities are shown only as quantities unless a separate valuation policy is approved; no plan-rate result is labeled actual.
- No database write occurs on report execution; tests prove tenant isolation, authorization, period boundaries, reversal behavior, and reconciliation to journal entries.
- The migration is rehearsed only on a newly created owner-approved disposable database on the documented test server, then dropped with the runbook ownership/session safeguards. Persistent databases remain untouched without separate authorization.

## Explicitly deferred

This proposal does not implement a standard/target cost estimate, WIP calculation, variance categories, overhead, activity-cost journal posting, automatic or collective MIGO recovery, CO15 behavior, or settlement changes. Those require separate business rules and authorization. The first slice does not authorize or implement any of these later features.
