# Company-scope authorization audit

Scope of this pass: finance statements, tax return, cash flow, consolidation, their CSV/PDF export route, and intercompany. Verified by source reading and by `tests/company-scope-authorization.test.ts` (real persisted sessions, two companies, two tenants).

Rule (`src/platform/auth/company-scope.ts`): live session or job lease → live capability → explicit Company Code scope (an empty restriction list is never unrestricted, wildcard/admin roles included) → every company actually read or written is in scope, judged in the service's own transaction. A plant-limited user (Plant scope leaving a company plant uncovered) is refused company-wide aggregates and postings. A group/multi-company request is refused whole; derived companies are not named.

| Path | Company derivation | Status |
|---|---|---|
| trial-balance, balance-sheet, profit-loss (`calculate*`) | supplied `companyCode` | fixed, tested; P&L authorises FIN.RPT.PROFITLOSS only |
| cash-flow | every supplied code | fixed, tested (full and `.read` capability) |
| consolidated-statements | companies of stored units (group/unit) | fixed, tested; refused as a whole |
| tax-report `executeTaxReport` | selected + every company a tax group expands to | fixed, tested; no partial stamping |
| tax-report `listTaxReturnRuns` | run company / group expansion | fixed, tested |
| `/reports/export/[report]` + adapters | adapter passes verified session to the same services | fixed for the 5 statement adapters; tested at adapter boundary |
| intercompany post | sending + receiving, both, before replay | fixed, tested (no journal/header/change on denial; replay pair-bound) |
| intercompany config save/delete/list, company choices | both companies | fixed, tested |
| pages: statements, cash flow, intercompany (+config), tax | selectors filtered by `authorizedCompanyCodes` | fixed (not browser-tested) |

## Confirmed unfixed (source shows no authorization in the service; not demonstrated at runtime)
`finance/gl-balances` (+ GL balance export), `journal-items`, `vendor-balances`, `customer-balances`, `vendor-ageing`, `customer-ageing`, `asset-history`, `subledger-tie-out`, `fx-valuation` (mutating), `document-display` (`getJournalDocument`), `document-reversal` (`reverseDocument`, mutating), `grir-reclass` run read, the dedicated export adapters of those reports, and consolidation workbench/monitor reads. Inventory, sales, purchasing, production and people exports/services were **not audited** in this pass (people payroll/employee reach was already scope-checked).

## Notes
- Exports are generated synchronously per request; there are no saved export artifacts or download IDs to rebind. No background report job exists; job-lease authority is supported by the shared verifier but no report path uses it.
- The consolidated export adapter reads area/workbench metadata before the service authorises; no figures.
- Tax-group semantics (all active companies of the country) were left as is.
