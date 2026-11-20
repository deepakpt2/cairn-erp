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

## Fixed in phase 1 (mutations)
`reverseDocument`/`getDocumentForReversal` (FIN.DOCUMENT.REVERSE), `executeFxValuation`/`getFxValuationRun` + FX CSV export (FIN.FX.VALUATE), `executeAccrualReversal` (judged before the document is read), and the close-cockpit `ACCRUAL_REVERSALS`/`FX_VALUATION` handlers (`executeTask`/`processScheduledExecutions` now take the verified session; a handler without authorization fails the task, posts nothing). Capability + explicit Company Code scope are judged in the posting transaction before any replay; plant-limited users are refused; a replayed request key is bound to the same company/document/run; the recorded poster is the verified session user. Tests: `tests/company-scope-mutations.test.ts`. Behaviour change: a close-cockpit task now needs the executing user to hold FIN.DOCUMENT.REVERSE / FIN.FX.VALUATE for the cycle's company. Still open on this path: the cockpit's own task-list reads/status changes and `listDueAccruals`/`getAccrualDocument` reads are not company-scoped (phase 3).

## Fixed in phase 2 (reads)
`getGlBalances`/`getGlBalanceReport` (FIN.GL.BALANCE, whole multi-company request), `getJournalItems` (FIN.JOURNAL.LIST), `getJournalDocument`/`resolveDocumentNumber` (FIN.JOURNAL.DISPLAY or FIN.DOC.FLOW), `getAssetHistorySheet` (FIN.ASSET.REPORT, whole company range), `calculateSubledgerTie`, `getVendorBalances`/`getCustomerBalances`, `getVendorAgeing`/`getCustomerAgeing`, and the export adapters/routes that call them (they pass the verified session). Each judges capability + explicit Company Code scope inside its own transaction before reading; a request naming any out-of-scope company is refused whole; ledger-style reads refuse plant-limited users. Document display is a single-document read, so a plant limit does not refuse it; a document of an out-of-scope company (also via a wrong typed company or a parked number) is `NOT_FOUND`, and a bare-number resolve ignores out-of-scope documents. Behaviour change: a company that is not configured and one outside the caller's scope now give the same refusal (existence is not disclosed). Tests: `tests/company-scope-reads.test.ts`; existing read suites call the services through a real session (`withClientAuth`). Not browser-tested. Residual: document display does not filter lines by the caller's plants.

## Confirmed unfixed (source shows no authorization in the service; not demonstrated at runtime)
`grir-reclass` run read and consolidation workbench/monitor reads. Inventory, sales, purchasing, production and people exports/services were **not audited** in this pass (people payroll/employee reach was already scope-checked).

## Notes
- Exports are generated synchronously per request; there are no saved export artifacts or download IDs to rebind. No background report job exists; job-lease authority is supported by the shared verifier but no report path uses it.
- The consolidated export adapter reads area/workbench metadata before the service authorises; no figures.
- Tax-group semantics (all active companies of the country) were left as is.
