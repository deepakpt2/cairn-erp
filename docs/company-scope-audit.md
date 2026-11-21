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

## Fixed in phase 3a (finance leftovers)
Close cockpit: `getTaskList`, `listTaskLists` (lists of out-of-scope companies are absent), `listTasks`, `listExecutions`, `listEvents`, and every change (`createTaskListFromTemplate`, `releaseTaskList`, `executeTask`, `processScheduledExecutions`, `attachEvidence`, `signOffTask`, `overrideTaskStatus`, `reopenTask`, `finalizeTaskList`) now judge FIN.CLOSE.COCKPIT (reads also accept `.read`) plus the cycle company's explicit Company Code scope in the service's own transaction, before anything of the cycle is read; plant-limited users are refused. Behaviour change: a cockpit task for a company outside the scope is now refused by the cockpit (typed error, nothing recorded) instead of being claimed and failing in the handler. Accruals: `listDueAccruals`, `listAccrualDocuments`, `getAccrualDocument` return only companies the session may read (FIN.ACCRUAL.POST, its `.read`, or FIN.DOCUMENT.REVERSE); the cockpit's accrual handler asks for its own company only. GR/IR: `getGrIrRun` (+ CSV export route/adapter) answers a run of an out-of-scope company as not found. Consolidation: `listConsolidationAreas`/`getConsolidationWorkbench` show an area only when the session's scope covers every unit's company (otherwise empty/null); `getConsolidationMonitor`, `executeConsolidationTask`, `executeConsolidationTaskGroup` and `cancelConsolidationExecution` (previously no authorization at all) refuse the whole group when any unit's company is out of scope, the capability is missing, or the user is plant-limited; the refusal names no derived company. Tests: `tests/company-scope-cockpit-consolidation.test.ts` (7); existing cockpit/accrual/consolidation suites call through a real session. Not browser-tested.

## Fixed in phase 3b (consolidation configuration writes)
`saveArea`, `saveUnit`, `assignUnit`, `saveGroup`, `saveMethod`, `saveVersion`, `saveTask`, `activateArea` now require the verified session (`authorization` on the actor) and judge FIN.RPT.CONSOLIDATE plus an explicit Company Code scope over every company of the area's units, and over the company a `saveUnit` attaches, before anything is read or written; a refusal names no derived company. Chart-level writes (`saveDataBasis`, `saveGroupAccount`, `saveMapping`) need the session and capability only (no company data). An area with no unit yet is judged on session and capability. A plant limit does not refuse configuration. Tests in `tests/company-scope-cockpit-consolidation.test.ts`; other suites and `scripts/browser-smoke/consolidation-*.ts` call the writes through `tests/helpers/consolidation-workbench.ts` (a real finance test actor) — the browser-smoke scripts were typechecked, not run.

## Fixed in phase 4 (purchasing)
Capability plus explicit Company Code scope, judged in the service's own transaction, for: PO list (`listPurchaseOrders`: limited to readable companies, others absent; a number in another company answers as a missing one), PO display (`displayPurchaseOrder` single document -> not found for another company; `searchPurchaseOrders`/`openPurchaseOrderDisplay` limited to readable companies), invoice overview (`listInvoiceOverview` range refused as a whole before validation; `readInvoiceOverviewDocument` null for another company), blocked invoices (`listBlockedInvoices` range; `listBlockEvents`, `previewPaymentBlock`, `placePaymentBlock`, `releasePaymentBlock` answer another company's invoice as "does not stand", before the replay lookup; the recorded actor is the verified session user, `changedBy` is ignored), GR/IR (`listGrIrResiduals`, `listGrIrMaintenance`, `listGrIrExceptions` range refused whole; `previewGrIrClearing`/`postGrIrClearing` judged on the order's company before replay; `reverseGrIrClearing` on the maintenance document's company; poster = session user). Plant-limited users are refused company-wide aggregates (invoice overview, blocked list, GR/IR); document lists/displays allow them. CSV/PDF export adapters for PO list and invoice overview pass the verified session. Tests: `tests/company-scope-purchasing.test.ts`; existing suites call through real sessions. Behaviour changes: PO display/list/overview now need a session with the capability and company scope; the STO viewer test now expects a viewer outside the order's company to get not-found.
Exception: `listPurchaseOrdersForProvisioning` is an unscoped, session-less read used only by demo provisioning (`demo-procurement`, `demo-quality`); a test checks no `src/app` file imports it. Demo provisioning was typechecked, not run.
Not covered in phase 4: `previewGrIrClearing`/`reverseGrIrClearing` success paths and a cross-company reversal were not exercised adversarially (no maintenance link fixture); the blocked-invoice hold success path is covered only by the existing suite. Phase 4b/4c below adds the services that were first left out.

## Fixed in phase 4b/4c (purchasing leftovers)
Capability plus explicit Company Code scope, judged in the service's own transaction, with the recorded actor taken from the verified session (a supplied `changedBy` is ignored), for: supplier invoice posting and cancellation (`postSupplierInvoice`, `cancelSupplierInvoice`: company from the order or invoice, another company's answers "does not exist", a replayed request key is scope-checked too; `getInvoiceOrder`, `listInvoiceTaxCodes`, `getSupplierInvoice` return null/[] outside scope), parked invoices (`parkSupplierInvoice`, `previewParkedInvoice`, `changeParkedInvoice`, `previewParkedInvoiceChange` hide another company's order or park as "does not stand"; `getParkedInvoice`, `openOrderForPark`, `listRecentParkedInvoices` limited to readable companies), purchase requisitions (`createRequisition`/`changeRequisition`: company derived from item plants, requisition change of another company answers "does not exist"; `getRequisition`, `requisitionChoices`; `listPurchaseRequisitions` limited to plants of readable companies), purchase orders (`createOrder`/`changeOrder`: requested company and stored order's company judged; `getOrder`, `orderChoices`), and release (`releaseDocument`/`cancelDocumentRelease`: category capability then every company of the document; out of scope answers "needs no release"; `assertReleaseAuthority` is called first by the finance wrappers for parked journals and payment runs). A missing order or requisition answers before the requested company or plants are judged, so a probe cannot tell it from another company's (found and fixed while writing the tests). A plant limit does not refuse single-document work.
Exceptions: every `*ForProvisioning` variant (orders, requisitions, invoice posting/cancel, release, parked-journal and payment-run release) skips all checks and is for seeding, walkthroughs, MRP and fixtures; a test checks no `src/app` file references one. The MRP run (`production/mrp-run.ts`) creates and changes requisitions through the unscoped variants and has no authorization of its own: **known gap for the production phase**.
Tests: `tests/company-scope-purchasing.test.ts` (27) covers create/change/get/choices for orders and requisitions, the requisition list, release and cancel, creator = session user, spoofed `changedBy`, nothing written on refusal, no-session / no-capability / no-scope / other-tenant. About 60 existing suites now call the provisioning variants, so they no longer exercise the enforced path; only the scope suite does.
Not covered: release of parked journals and payment runs was not tested adversarially (category/company resolution is code-only); plant-level scope is not enforced on requisition or order writes (company level only); the STO branch of order create/change is judged in a pre-transaction; `follow-on.ts` (`orderDraftFromRequisition`, `orderDraftFromQuotation`), contracts, scheduling agreements (create/change/display), info records, quotations, RFQs, source lists, quota arrangements, vendor evaluation, delivery completion, goods-receipt posting (inventory `goods-receipt.ts`) and payment-run services other than release were not audited. Not browser-tested; the full suite was not run (affected suites only).

## Fixed in phase 5a (sales billing)
Capability plus explicit Company Code scope (billing documents and sales orders carry `company_code`), judged in the service's own transaction, recorded actor = verified session user, for: invoice lists (`invoiceListDueDocuments`, `listInvoiceLists`, `getInvoiceList` limited to readable companies / null for another company; `createInvoiceList` treats another company's documents as missing — explicit numbers answer "does not exist", a selection is trimmed to the caller's companies before it is grouped; `releaseInvoiceList` and `cancelInvoiceList` answer another company's list as "does not exist" before anything is read or posted) and credit memos (`createCreditMemo`, `createCreditMemoRequest`, `postCreditMemo`, `releaseBillingBlock` answer another company's invoice, memo or order as missing, including a replayed request key; `listCreditMemoRequests` limited to readable companies). The create screen already asks for SALES.CREDIT.MEMO.POST, so `createCreditMemo` accepts it as well as SALES.CREDIT_MEMO.CREATE. The scope helper moved to `src/platform/auth/scope-actor.ts` (purchasing re-exports it). Tests: `tests/company-scope-sales.test.ts` (8; fixtures are direct rows, so invoice-list create/release success paths are covered only by `sales-invoice-list`).
Exceptions: `*ForProvisioning` variants (invoice list create/release/cancel/get, credit memo create/post/request/release) skip all checks and are for seeding and fixtures; `invoiceListDueDocumentsForAttention` and `listCreditMemoRequestsForAttention` serve the attention panel, which has no session and filters every row by the viewer's scope afterwards (not re-verified end to end). Tests for both check no `src/app` file references them.
Not covered: **`postCustomerInvoice` and the whole finance AR/AP posting family have no authorization at all** (customer/vendor invoice, credit memo, down payments and requests, clearing, payment run create/background, asset acquisition/retirement/depreciation/master, G/L clearing/transfer, ledger and parked journals); `releaseInvoiceList` posts the receivable through `postCustomerInvoice` after judging the list's company, but that service can still be called directly (it is imported by `src/app/finance/customer-invoice/actions.ts`). Sales billing itself (`billing.ts`: due list, billing, cancellation, collective billing), sales orders, deliveries, quotations, rebates, down payments, billing plans, registers and analysis, and the credit-memo request screen's `getSalesOrder`/`listBillings`/`getBilling` reads were not covered. Not browser-tested; the full suite was not run.

## Still unfixed or unaudited
- Close-cockpit **template** reads/writes (`upsertTemplateTask`, `listTemplateTasks`) are tenant-level, not company data; left as is.
- **Inventory, sales and production** were only surveyed, not fixed (purchasing: see phase 4 for what is covered): a source scan found 107 exported read services (`get*/list*/search*/find*/calculate*/run*/build*/report*/display*`) in those modules whose files carry no `ServiceAuthorityContext`, `verifyServiceAuthority`, `hasOrgAccess` or company-scope reference (inventory 46, purchasing 24, production 20, sales 17; 61 of them mention a company code, the rest only a plant or neither). Many are configuration lists (batch classes, number ranges, material types) that carry no company data; the ones that do carry company/plant figures (e.g. purchasing invoice overview, blocked invoices, GR/IR reconciliation, purchase-order list/display; sales invoice list, credit memo; production order cost report; inventory material-document display, physical inventory, price change) are not yet classified or fixed. This scan is a filename-level grep, not a review: a file with authorization may still miss a path, and a file without it may be tenant-level only. Whether those modules' dimension is Company Code, Plant, or Purchasing/Sales Organization was not established. Not demonstrated at runtime.
- Document display does not filter lines by the caller's plants (phase 2 residual).
- People payroll/employee reach was already scope-checked (earlier work); not re-audited.

## Notes
- Exports are generated synchronously per request; there are no saved export artifacts or download IDs to rebind. No background report job exists; job-lease authority is supported by the shared verifier but no report path uses it.
- The consolidated export adapter reads area/workbench metadata before the service authorises; no figures.
- Tax-group semantics (all active companies of the country) were left as is.

## Phase 5b — production order cost report

**Covered** (`src/modules/production/order-cost-report.ts`, `report-exports.ts`, `src/app/production/order-cost-report/page.tsx`):
- `getProductionOrderCostReport` requires a session holding `PROD.ORDER.COST.DISPLAY` and an explicit Company Code scope.
- An order is shown only if its plant's company is in the Company Code scope and, when the caller holds a Plant scope, the plant is in it. Otherwise it answers exactly as a missing order.
- If the order carries postings of a company outside the scope, the whole report is refused (never trimmed).
- Report-export adapters pass the verified session through.
- Tests: `tests/company-scope-production.test.ts` (6 tests); existing suites use `tests/helpers/cost-report-authorized.ts`.

**Behaviour change:** an order whose plant names no company is no longer shown to anyone.

**Not covered in production:** the MRP run still uses unscoped requisition variants; order create/change/release/confirmation plant scope is not re-audited here; nothing is browser-tested.

## Phase 5c — inventory: material document display and list

Inventory is keyed by **plant**; a plant belongs to one company (`plant.company_code`). New shared helper `reachablePlantsInTx` (`src/platform/auth/scope-actor.ts`): a plant is reachable when its company is in the explicit Company Code scope and, if the caller holds a Plant scope, the plant is in it. A plant that names no company is never reachable.

**Covered:**
- `listMaterialDocuments` (MB51, incl. the report export): needs `INV.MATERIALDOC.LIST` and a session; lists only lines of reachable plants; a plant outside reach in the selection answers as a plant that does not stand.
- `displayMaterialDocument` (MB03): needs `INV.DISPLAY` and a session; a document with any line in an unreachable plant answers exactly as a missing document (a missing number answers first).
- Tests: `tests/company-scope-inventory.test.ts` (6 tests); existing suites use `tests/helpers/material-document-authorized.ts`.

**Not covered yet in inventory:** physical inventory, price change, reservations, warehouse stocks, stock overview/ageing/reconcile/shelf-life lists, batch reads, serial numbers, goods-receipt posting (uses plant-level checks only where its own service already verifies), MIGO. Document list lines of a mixed-company document are trimmed per line rather than the document refused.

## Phase 5d — inventory: stock overview (MMBE) and warehouse stocks (MB52)

**Covered:** `stockOverview` (needs `INV.STOCK.VIEW`) and `listWarehouseStocks` (needs `INV.STOCK.WAREHOUSE`), including the stock-overview report export. Both require a session, judge inside the transaction, and read only plants that are reachable (company in the explicit Company Code scope; Plant scope honoured; a plant with no company never). Transit quantities and the STO transit ledger are filtered by receiving plant. A plant selection outside reach answers as a plant that does not stand. Totals are computed from the reachable rows only. Tests: 4 more in `tests/company-scope-inventory.test.ts`.

**Still not covered in inventory:** physical inventory, price change, reservations, stock ageing/reconcile/shelf-life lists, batch reads, serial numbers, MIGO, return delivery. The drill-down links from these lists lead to the material document list, which is scoped.

## Phase 5e — inventory: price change (MR21-style) and future prices

**Found:** `changeMaterialPrice` and `releaseFuturePrices` had no session or scope check at all, took `changedBy` from the caller, and the FUTURE branch never verified that a line's plant belonged to the named company — so a caller could store a future price for another company's plant by naming a company of their own.

**Covered:** both writes and `listFuturePrices` need `INV.MATERIAL.PRICECHANGE` and a session; the named company must be in the Company Code scope; every line's plant must be reachable and belong to that company (otherwise "Plant X does not belong to company C", the same answer for a missing plant); `changed_by` is the session user; the check runs before the replay lookup. The future-price list shows reachable plants only. Tests: 5 more in `tests/company-scope-inventory.test.ts` (FUTURE path only; the CURRENT/PREVIOUS posting path is gated by the same function but not exercised adversarially).

**Still not covered in inventory:** physical inventory, reservations, stock ageing/reconcile/shelf-life lists, batch reads, serial numbers, MIGO, return delivery.

## Phase 5f — inventory: reservations

**Found:** `createReservation`, `getReservation`, `withdrawReservation` and `completeReservationItem` had no session or scope check; `changedBy` came from the caller; the screen only checked the capability.

**Covered:** all four need `INV.RESERVATION.CREATE` and a session. A reservation is reachable only if it has items and every item's plant is reachable; anything else answers as a missing reservation (`getReservation` returns null). Create refuses an unreachable plant as "does not exist"; a replayed request key whose reservation is not fully reachable is refused. The recorded user is the session user. `withdrawReservationInTx` is unchanged: it is only called by the goods issue, which verifies its own authority. Tests: 3 more in `tests/company-scope-inventory.test.ts` (reads and withdraw/complete on direct-insert fixtures; create covers the refusals only, the success path stays in `reservations.test.ts`).

**Still not covered in inventory:** physical inventory, stock ageing/reconcile/shelf-life lists, batch reads, serial numbers, MIGO, return delivery.

## Phase 5g — inventory: physical inventory (MI01, MI04, MI20, MI07, recount)

**Found:** none of the physical-inventory services checked a session, a capability or a Company Code scope. A capability alone reached any plant's count document, difference list, posting and recount. `changedBy`/`createdBy` came from the caller, and a request-key replay could return another company's document.

**Covered:** a document belongs to its plant, a plant to one company. Every service judges inside its own transaction: session, a live capability, an explicit Company Code scope (and the Plant scope when held). A plant with no company is never reachable.
- Create, cancel, list (`INV.PHYINV.CREATE`/`CANCEL`), count read/search/history/status, `submitCounts` (`INV.PHYINV.COUNT`), `clearCount` (`INV.PHYINV.COUNT.CORRECT`).
- Differences list, display and workflow (`INV.PHYINV.DIFF.LIST`); posting read, validate, post, history (`INV.PHYINV.DIFF.POST`); recount validate/create/cancel (`INV.PHYINV.RECOUNT`), source and comparison reads (any of recount, diff list, diff post).
- `reverseDifferencePosting` needs `INV.REVERSE` and every plant on the material document reachable; otherwise it answers as a missing document.
- A document outside the reach, and a plant named in a selection outside the reach, answer exactly as a missing one, before any replay lookup. Reads return null or an empty list. The recorded actor is the session user.
- Shared helper: `src/modules/inventory/phyinv-scope.ts`. Pages and actions pass `authorization`. The browser-smoke scripts scr149/scr150 sign in a scoped actor (`BROWSER_PHYINV_CAPABILITIES`).
- Tests: `tests/company-scope-inventory.test.ts` (4 physical-inventory tests); existing suites use the wrappers in `tests/helpers/material-document-authorized.ts`.

**Limits:** `reverseMaterialDocument` itself (the generic MIGO reversal) is still unscoped for non-STO documents; the physical-inventory entry point gates it, direct callers are not covered. Internal helpers (`releaseDifferenceAllocations`, `recomputePostingStatus`, `syncRecountLink`) take no authorization and are only reached through scoped services. Not browser-tested; the smoke scripts typecheck but were not run.

**Still not covered in inventory:** stock ageing/reconcile/shelf-life lists, batch reads, serial numbers, MIGO, return delivery, goods-receipt posting.

## Phase 6a — sales area: sales orders (VA01/VA02/VA03/VA05, credit release)

**Found:** `getSalesOrder`, `changeSalesOrder`, `cancelSalesOrder`, `listSalesOrderDocuments`, `salesOrderChoices` and `releaseSalesOrderCredit` checked no session, capability or scope; a capability alone reached any company's, sales org's or plant's order. Only `createSalesOrder` verified company and plant authority. The sales org, distribution channel and division levels were stored but enforced nowhere.

**Covered:** every service judges inside its own transaction before any read or replay lookup: session, live capability (`SALES.ORDER.CREATE`, release: `SALES.ORDER.RELEASE`), explicit Company Code scope. An order is reachable when its company is in scope, its sales area is inside any Sales Org / Distribution Channel / Division restriction the actor holds (a level with no restriction does not narrow), and every plant it ships from is inside any Plant scope held. Anything else answers as a missing order. Lists filter the same way; `salesOrderChoices` offers only areas of reachable companies. The recorded actor is the session user.
- Shared helper: `src/modules/sales/sales-scope.ts` (`salesActor`, `salesDocumentReachable`, `salesAreaReachable`), plus `orgLevelsAllow`/`plantsAllow` in `src/platform/auth/scope-actor.ts`.
- Tests: `tests/company-scope-sales.test.ts` (5 tests); the 42 existing `tests/sales-*` files use `tests/helpers/sales-authorized.ts`.

**Found by the adversarial test:** `salesOrderChoices` first offered sales areas of other companies (area filter ignored the company); fixed.

**Limits:** a secondary level only narrows when the actor holds a restriction of that level; Company Code stays the mandatory gate. Not browser-tested.

**Still not covered in sales:** quotations, deliveries (reads, picks, cancel), billing remainder, returns, rebates, down payments, conditions, analysis/registers, shipping point, credit-control area.

## Phase 6b — sales area: quotations

**Found:** `getQuotation`, `changeQuotation`, `listQuotations`, `rejectQuotation` checked no session or scope, took `changedBy` from the caller and read any company's quotation; `createOrderFromQuotation` read the quotation before judging reach; `createQuotation` did not check the Sales Org / Channel / Division or Plant scope.

**Covered:** every service judges inside its own transaction (session, live `SALES.QUOTATION.CREATE`, explicit Company Code scope) before reading the quotation. A quotation is reachable when its company, sales area and every item plant are inside the actor's reach (same rule as orders, `sales-scope.ts`); anything else answers as a missing quotation, with the same message as a nonexistent number. `listQuotations` filters the same way. `createQuotation` refuses an area or plant outside the scope. Change and reject record the session user. Pages and actions pass the session; `getQuotationForProvisioning` serves demo seeding only.
- Tests: 4 more in `tests/company-scope-sales.test.ts`; `tests/sales-quotation.test.ts` uses the wrappers in `tests/helpers/sales-authorized.ts`.

**Limits:** `createQuotation` still records the caller-supplied `changedBy` (the screen passes the session user); not browser-tested. `createOrderFromQuotation` creates the order through `createSalesOrder`, whose own gate applies.

**Still not covered in sales:** deliveries (reads, picks, cancel), billing remainder, returns, rebates, down payments, conditions, analysis/registers, shipping point, credit-control area.

## Phase 6c — sales area: deliveries (VL01N/VL02N/VL03N, picking, goods issue)

**Found:** `getDelivery`, `listDeliveries`, `listDeliverableOrderLines`, `confirmDeliveryPicks` and `cancelDelivery` checked no session, capability or scope, and recorded a caller-supplied `changedBy`. `createDelivery` and `postDeliveryGoodsIssue` held company and plant authority only: sales org, channel and division were not checked, and creation did not hide an order outside the reach. `registers.listDueRegister` (delivery due list) read the same unscoped list. The attention panel listed every company's deliveries.

**Covered:** reads, lists, pick, cancel and goods issue judge inside their own transaction before any read (session, a live delivery capability, explicit Company Code scope). A delivery is reachable when its company, sales area and every plant (header and items) are inside the actor's reach; otherwise it answers as a missing delivery, with the same message as a nonexistent number. `createDelivery` answers an out-of-reach order, in any item, as a missing order. Pick and cancel record the session user. `listDueRegister` takes the session. The attention panel keeps an unscoped feed (`listDeliveriesForAttention`, `listDeliverableOrderLinesForAttention`) whose rows now carry company, sales area and plant, so its existing filter by the viewer's scope covers all of them. Demo and walkthrough seeding use `*ForProvisioning` readers.
- Tests: 4 more in `tests/company-scope-sales.test.ts`; the delivery-related suites use `tests/helpers/sales-authorized.ts`.

**Limits:** the attention filter applies the viewer's *grant* scope and `auth_org_restriction`; I did not test it with a restricted viewer. `standingDetermination` and billing's use of it are unchanged. Returns deliveries are readable through `getDelivery` with the returns capability but are not otherwise reviewed here. Not browser-tested.

**Still not covered in sales:** billing remainder, returns, rebates, down payments, conditions, analysis/registers (document register), shipping point, credit-control area.

## Phase 6d — sales area: billing documents (VF01/VF02/VF03/VF04/VF11)

**Found:** `getBilling`, `listBillings`, `billingDueList`, `listBillableDeliveries`, `salesDocumentFlow` and `goodsIssueStands` checked no session, capability or scope; `cancelBillingDocument` checked none and recorded a caller-supplied `changedBy`. Creating an invoice (`createBillingFromDelivery`, `createBillingFromPlanDate`, the collective run) held Company Code and Plant authority only, not sales area; `postBillingDocument` released an *existing* open document with no authority check at all and looked the document up by delivery number before any reach judgement. The attention panel and the billing due-list register listed every company's due deliveries.

**Covered:** reads, lists, flow and cancel judge inside their own transaction (session, a live billing capability, explicit Company Code scope). A billing document is reachable when its company, sales area and every plant it bills from (its delivery, every delivery on its lines, else its order's lines) are inside the actor's reach; otherwise it answers as a missing document, with the same message as a nonexistent number. `listBillings`, `billingDueList`, `listBillableDeliveries` and `salesDocumentFlow` filter the same way. Creation from a delivery refuses an out-of-reach delivery as a missing one before anything is read; creation from a plan date judges the order's company, sales area and plant; the collective run filters its due list by reach; `postBillingDocument` judges authority and delivery reach before looking up any existing document. Cancel records the session user. The attention panel uses `billingDueListForAttention` (rows already carry company, sales area, plant); seeding and post-back reads use `getBillingForProvisioning`.
- Tests: 5 more in `tests/company-scope-sales.test.ts` (18 in the file); eight existing billing suites use `tests/helpers/sales-authorized.ts` wrappers.

**Limits:** `linkPostedInvoice` is exported but takes no authorization; it is only reached from the scoped post paths and is not imported by any page or action. The collective-run reach check reads the due list by the run's own authority. Invoice lists, credit memos and down payments are separate services, not reviewed here. Not browser-tested.

**Still not covered in sales:** returns, rebates, down payments, conditions, analysis/registers (document register), shipping point, credit-control area.

## Phase 6e-1 — sales area: returns (returns order, returns delivery, 651 receipt)

**Found:** `createReturnsOrder`, `createReturnsDelivery`, `postReturnsDelivery`, `postReturnsReceipt`, `listReturnsOrders` and `listReturnsDeliveries` checked no session, capability or scope and recorded a caller-supplied `changedBy`. A returns order could be priced from another company's invoice, and goods received back against another company's delivery.

**Covered:** each service judges session, its returns capability and explicit Company Code scope inside its own transaction, before any read. A returns order is raised only against an invoice inside the actor's reach (company, sales area, every plant); a returns delivery only against a delivery or returns order inside it (the origin delivery is judged as well); a receipt only against a delivery inside it. Otherwise the answer is the same "does not stand for this tenant" as a nonexistent number, and nothing is written. A replayed request key that points at an out-of-reach document is refused rather than answered. Both lists filter by reach. The recorded actor is the session user. `postReturnsReceiptInTx` stays internal and is only reached after the callers' own checks.
- Tests: 3 more in `tests/company-scope-sales.test.ts` (21 in the file); the returns suites use `tests/helpers/sales-authorized.ts` wrappers.

**Limits:** the generic goods-movement reversal (`reverseMaterialDocument`) of a 651 is not scoped here. Not browser-tested.

**Still not covered in sales:** rebates, down payments, conditions, analysis/registers (document register), shipping point, credit-control area.

## Phase 6e-2 — sales area: rebate agreements and down payments

**Found:** `saveRebateAgreement`, `releaseRebateAgreement`, `settleRebateAgreement`, `listRebateAgreements`, `rebateRegister`, `rebateConditionTypes` and `rebateAccrualsForBilling` checked no session, capability or scope and recorded a caller-supplied `changedBy`; settlement pays money out. `requestDownPaymentFromPlanDate`, `cancelDownPaymentRequest` and `orderDownPayments` had the same gap, and a request could be raised against any company's order.

**Covered:** rebate maintenance, release, settlement, list and register judge session, the rebate capability (settlement: `SALES.CREDIT.MEMO.POST`) and explicit Company Code scope inside their own transaction. An agreement is reachable when its sales organisation's company is inside the Company Code scope and its sales area (org, channel, division) is inside any such restriction the actor holds; a sales organisation with no company, or a blank level where the actor holds a restriction for it, is outside the reach. Save judges the sales area it names, and an existing agreement it changes. An out-of-reach agreement answers as a missing one. A billing document's provisions are read through `billingRebateAccruals`, which judges the billing document's reach first; the unscoped reader is `rebateAccrualsForBillingForProvisioning`. Down payments judge the order's reach (company, sales area, plants) through the same order check: request and withdrawal answer an out-of-reach order as a missing one (`Order X does not exist.` / not a down payment request); the register returns nothing for one. Recorded actor is the session user. `accrueRebatesForBilling`, `reverseRebateAccrualsForBilling` and `clearDownPaymentsForInvoice` stay internal, reached only from billing's already-scoped posting paths.
- Tests: 6 more in `tests/company-scope-sales.test.ts` (27 in the file); `sales-rebate` and `sales-down-payment` use the `sales-authorized` wrappers.

**Limits:** the settlement's credit memo is posted by `postCustomerCreditMemo`, whose own finance gate is outside this phase. A rebate agreement's customer is not checked against any customer-level scope (none exists). `rebateConditionTypes` is a master-data list gated by session and capability only. Not browser-tested.

**Still not covered in sales:** conditions, analysis/registers (document register), shipping point, credit-control area.

## Phase 6f — sales area: condition records, document register, analysis

**Found:** `saveSalesCondition` and `listSalesConditions` checked no session, capability or scope; `listDocumentRegister`, `listRegisterChoices` and `listAnalysis` (and the report export built on it) read every company's documents and totals.

**Covered:**
- Conditions: `saveSalesCondition` takes a required `authorization`, judges `CFG.SALES.CONDITION.MAINTAIN` and the sales area's reach (company via the sales org, plus held Sales Org / Channel / Division restrictions) in its own tx, answers an out-of-reach area as a missing one, and records the session user. `listSalesConditions` filters rows by area reach. Seeding, demo and the browser-smoke script use `*ForProvisioning` variants (never imported from `src/app`). A scoped call with `authorization: undefined` is refused (a test caught an early version that fell through to the unscoped path).
- Register: `SALES.DOCUMENTS.LIST`; each reader adds a company/area predicate in SQL; a plant-limited actor is judged per row through `orderInReach` / `deliveryInReach` / `billingInReach` over at most 2000 candidates. `listRegisterChoices` offers only reachable plants and sales orgs.
- Analysis: `SALES.ANALYSIS.LIST`; totals are filtered by company and held area levels in SQL. A plant-limited actor is refused the aggregate (a company-wide total cannot be cut by plant).
- Tests: 6 more in `tests/company-scope-sales.test.ts` (33 in the file).

**Limits:** the register's customer and material choice lists are unscoped master data (later phase). A plant-limited register read is capped at 2000 judged candidates. Not browser-tested.

**Still not covered in sales:** shipping point maintenance, credit-control area.

## Phase 6g — sales area: shipping point maintenance

**Found:** `defineShippingPoint`, `changeShippingPointStatus`, `defineShippingCondition`, `changeShippingConditionStatus`, `assignShippingPoint`, `changeShippingPointAssignmentStatus` and `listShippingPointConfiguration` checked no session, capability or scope; any caller could withdraw a dock that other companies' plants load through.

**Covered:** every call takes a required `authorization` and judges the session and `CFG.SALES.SHIPPING_POINT.DEFINE` in its own tx. Assignments are plant-keyed: the plant must be inside the actor's reachable plants. Withdrawing or restoring a tenant-wide shipping point or condition requires reach over every plant assigned through it. The recorded actor is the session user. The list shows only assignments and plants in reach. Seeding, demo and tests use `*ForProvisioning` variants (never imported from `src/app`). Tests: 3 more in `tests/company-scope-sales.test.ts` (36).

**Limits:** shipping points and conditions are tenant-wide masters with no company of their own; defining a new one needs only the capability. A user without the capability now gets an error page instead of a read-only view of `/config/shipping-points`. Not browser-tested.

**Moved:** the credit-control area is finance-module configuration and is handled with the finance leftovers.

## Phase 7a — purchasing org and purchasing group (orders, requisitions, release)

**Found:** the purchasing services judged only Company Code (and plant); a Purchasing Org or Purchasing Group restriction held in `auth_org_restriction` narrowed nothing.

**Covered:** `purchasingLevelsAllow` / `purchasingLevelsSql` (platform `scope-actor.ts`): each level narrows only when the actor holds a restriction of it; a blank value is outside a held level; `undefined` means the document has no such level. Applied to: order create/change (stored and requested org/group; a stored order outside answers as missing), `getOrder`, `orderChoices` (orgs and groups), the PO list and PO display/search (SQL predicate), requisition get/create/change (per-item group), `requisitionChoices`, the requisition list, and release (`authorizeReleaseInTx` over orders, contracts, scheduling agreements and requisitions). `readableCompaniesInTx` now also returns the verified actor. Tests: 6 more in `tests/company-scope-purchasing.test.ts` (33).

**Not covered (no scope check of any kind, company or level):** `contract`, `scheduling-agreement` (+ release, schedule), `rfq`, `quotation`, `info-record`, `source-list`, `quota-arrangement`, `vendor-evaluation`, `delivery-completion`, `follow-on`, `stock-transport-order` (its create path is judged through `judgeOrderWrite`, its other functions are not). Parked invoices and invoice verification judge company only, not org/group. Not browser-tested.

## Phase 7b — purchasing: contracts and scheduling agreements (with release, schedule and displays)

**Found:** `createPurchaseContract`, `changePurchaseContract`, `getPurchaseContract`, `contractChoices`, `listPurchaseContracts`, `openPurchaseContractDisplay`, `createSchedulingAgreement`, `changeSchedulingAgreement`, `getSchedulingAgreement`, `listSchedulingAgreements`, `schedulingAgreementChoices`, `maintainDeliverySchedule`, `readDeliverySchedule`, `createSchedulingAgreementReleases`, `listSchedulingAgreementReleases`, `openSchedulingAgreementDisplay`, `openDeliveryScheduleDisplay`, `deliveryScheduleHistory` had no session, capability, company or level check; the caller's `changedBy` was recorded.

**Covered:** every call takes a required `authorization` and judges the session and capability in its own tx (`purchasingActor`), then the document's company, purchasing org and purchasing group (`purchasingDocumentInReach`). The recorded actor is the session user. A stored document outside the reach answers as a missing one (get/display/history return null or empty; a change says "does not exist"). A replayed request key that names a document outside the reach is refused. The requested header of a create or change is judged as well. Choices and lists are filtered to the reach. A release run whose selection reaches an out-of-reach agreement is refused as a whole; a single named out-of-reach agreement is reported as not existing. `*ForProvisioning` variants serve demo, seed and tests and are never imported from `src/app` (a test greps for it).

**Limits:** `saveReleaseProfile` and `assignReleaseProfile` have no screen and no caller outside tests; they are now provisioning-only (renamed) rather than scoped. Items' plants are not separately judged against the actor's Plant scope beyond the company gate. Nothing here was browser-tested.

**Not covered (unchanged, no scope check of any kind):** `rfq`, `quotation`, `info-record`, `source-list`, `quota-arrangement`, `vendor-evaluation`, `delivery-completion`, `follow-on`, the non-create STO functions; parked invoice and invoice verification org/group.

## Phase 7c — purchasing: requests for quotation and quotations

**Found:** `createRequestForQuotation`, `previewRequestForQuotation`, `changeRequestForQuotation`, `previewRequestForQuotationChange`, `getRequestForQuotation`, `listRecentRequestsForQuotation`, `resolveRequestForQuotation`, `createQuotation`, `changeQuotation`, `previewQuotation`, `previewQuotationChange`, `openQuotation`, `getQuotation`, `listRecentQuotationRequests`, `displayQuotation`, `displayQuotationForRequest`, `listRecentDisplayedQuotations` and `compareQuotations` had no session, capability, company or level check.

**Covered:** every call takes a required `authorization`; session and capability are judged in the service's own tx. An RFQ event has no company column, so its companies are those of its plants (`plantDocumentInReach` in `scope-actor.ts`): every plant must lie in the actor's Company Code scope and any held Plant scope, and the held purchasing org / group levels must allow the event. A quotation is judged through its request's event. Out-of-reach events, requests and quotations answer as missing ("does not stand", null, empty). Create and change judge the supplied plants/org/group first and the written event afterwards (plants copied from a requisition); an out-of-reach result rolls the whole write back. The recorded actor is the session user. `*ForProvisioning` variants serve tests, demo and browser-smoke scripts and are not imported from `src/app`.

**Limits:** `writeRequestForQuotation`, `writeRequestForQuotationChange`, `writeQuotation` and `writeQuotationChange` stay exported as tx-level building blocks and carry no check of their own (used by tests only). Supplier master (V…) reads are not scoped. Nothing here was browser-tested.

**Not covered (unchanged, no scope check):** `info-record`, `source-list`, `quota-arrangement`, `vendor-evaluation`, `delivery-completion`, `follow-on`, the non-create STO functions; parked invoice and invoice verification org/group.

## Phase 7d — purchasing: info records, source lists and quota arrangements

**Found:** `createPurchasingInfoRecord`, `previewPurchasingInfoRecord`, `changePurchasingInfoRecord`, `previewPurchasingInfoRecordChange`, `findPurchasingInfoRecord`, `getPurchasingInfoRecord`, `infoRecordChoices`, `createSourceListEntry`, `previewSourceListEntry`, `changeSourceListEntry`, `previewSourceListChange`, `getSourceListEntry`, `getSourceList`, `listRecentSourceEntries`, `createQuotaArrangement`, `previewQuotaArrangement`, `changeQuotaArrangement`, `previewQuotaChange`, `getQuotaArrangement`, `listQuotaArrangements`, `listRecentQuotaArrangements` and `previewQuotaSelection` checked no company, plant or purchasing-org scope, and recorded a caller-supplied `changedBy`.

**Covered:** every call takes a required `authorization`; session and capability are judged in the service's own tx. These records carry no company column, so reach is judged by segment (`orgSegmentInReach` in `scope-actor.ts`): with a plant, as a plant document (every plant exists, its company is in the Company Code scope, a held Plant scope and Purchasing Org level allow it); without one, by the company of its purchasing organisation. Info record: a record needs at least one reachable segment, else "does not exist"; a foreign segment answers "has no segment N"; a record-level mark or reactivation needs every segment reachable; adding a segment to a named record with no reachable segment answers as a missing record; reads show only the reachable segments; choices are filtered. Source list: an entry outside the reach answers as missing; the list for a plant is hidden when the plant is unreachable and filtered by entry; a change that names a new plant or organisation judges the new values too. Quota: an arrangement is visible when its plant is reachable and at least one item's organisation is (items filtered); changing needs every item reachable; a selection touching an unreachable supplier is refused whole. The recorded actor is the session user. Original functions are `...ForProvisioning` (seeding, demo, tests, browser-smoke), never imported from `src/app`.

**Limits:** `writePurchasingInfoRecord`, `writePurchasingInfoRecordChange`, `writeSourceListEntry`, `writeSourceListChange`, `writeQuotaArrangement`, `writeQuotaChange` stay exported as tx-level building blocks without a check (tests only). Naming a duplicate partner/material in a create can still name the existing record number in the refusal. A plant paired with an organisation of another company is refused by the master check ("not assigned to plant"), not by the scope check. `resolveSourceList` and `resolvePurchasingInfoRecord` (used by order pricing and source determination) are not scoped here; they are reached through the scoped order services.

**Not covered (unchanged, no scope check):** `vendor-evaluation`, `delivery-completion`, `follow-on`, the non-create STO functions; parked invoice and invoice verification org/group.

## Phase 7e — purchasing: vendor evaluation, order drafts, delivery-completion rules, STO plants, invoice org/group

**Found:** `listVendorEvaluation`, `checkVendorEvaluation` and `saveManualScore` checked no session, capability or scope (any signed-in user could read any organisation's evaluation and save a score). `orderDraftFromRequisition` / `orderDraftFromQuotation` (the order screen's "create from" reads) were called before any authorization and copied a requisition or quotation of any company. `listDeliveryCompletionPolicy`, `setDeliveryCompletionPolicy` and `setDeliveryCompletionPlantPolicy` listed and changed every company's and plant's rule. A stock transport order judged only its receiving company: the supplying plant and the item plants were never judged. Invoice verification and parked invoices judged Company Code only; a held Purchasing Org or Group level narrowed nothing.

**Covered:** every call takes a required `authorization`; session and capability are judged in the service's own tx; the recorded actor is the session user. Vendor evaluation: the organisation's company must be in the Company Code scope and a held Purchasing Org level must name it; otherwise it answers as an organisation that does not stand (same text as a missing one); an evaluation reads the whole organisation, so a Plant-limited actor is refused it with its reason, and a manual score is refused the same way. Order drafts: needs the order capability; every plant of the source (and a held group) must be reachable, otherwise the requisition answers as missing / the quotation as null. Delivery-completion: lists only reachable companies and plants; a plant rule needs the plant reachable (else "does not exist"); a company default needs the company in scope and no Plant limit. STO: both the supplying plant and every receiving plant must be reachable (`plantDocumentInReach`), judged with the company, org and group check before anything is written. Invoices and parked invoices: `orderLevelsInReach` (platform `scope-actor.ts`) takes org and group from the purchase order; applied to invoice read, order view, post, cancel, park, park preview, parked read, order-for-park and the recent-park list (an out-of-reach document answers as a missing one). Originals kept as `...ForProvisioning` for vendor evaluation, order drafts and delivery completion.

**Limits:** `follow-on` helpers `copyRequisition`, `adoptQuotation`, `settleQuota`, `updateInfoRecordFromOrder` and `convertMoney` are tx-level and are only called by the already-scoped order, RFQ and contract services; they carry no check themselves. `readDeliveryCompletionPolicy` (tx-level, used by goods receipt) is not scoped. The STO plant check runs in the order service's judging transaction, not the STO write's own. The STO service functions `createStockTransportOrder` and `changeStockTransportOrder` remain callable without a check by any server code that imports them (only `orders.ts` does). Plant-limited users keep the company-level reach on invoice documents (not judged by plant).

**Not covered (unchanged):** the goods-movement side of stock transport orders (issue, receipt: inventory module, mapped to the inventory phase), the remaining mapping phases (inventory, controlling, finance leftovers, quality, master-data reads).

## Phase 8a — inventory: stock reports, reconciliation, serial numbers, material document output (MB90)

Same plant-reach rule as 5c: a plant is reachable when its company is in the explicit Company Code scope and, with a Plant scope held, the plant is named in it. A plant naming no company is never reachable. Each service has a `...ForProvisioning` variant (tests, seeding, scripts; never imported from `src/app`) and a scoped one that verifies session, capability and scope in its own transaction.

**Covered:**
- `stockAgeing` (`INV.STOCK.AGEING.DISPLAY`), `listShelfLife` (`INV.SLED.LIST`, also the report export), `stockOnPostingDate` (`INV.STOCK.POSTINGDATE`): only stock/lines of reachable plants are read; a named plant out of reach answers as a plant that does not stand.
- `reconcileStock` and `rebuildStockDimension` (`INV.STOCK.RECONCILE`): compare only reachable plants. The rebuild is a **write** to `stock_quantity`: it refuses a plant out of reach as missing, changes nothing there, and records the session user.
- `saveSerialNumber` / `listSerialNumbers` (`INV.SERIAL.MAINTAIN`): a unit is reachable by its plant; a plant-less unit is never reachable, so a scoped actor cannot record one. A save that would move an out-of-reach unit, or place one in an out-of-reach plant, is refused with one message ("cannot be recorded here") that does not say which case it was.
- MB90 `listOutputMessages`, `determineOutputs`, `dispatchPending`, `dispatchMessage`, `setRecipient`, `renderSlip`, `materialOutputPdf`, `materialDocumentCompanyCode` (`INV.MATERIALDOC.RECEIVEPRINT`): a document is reachable only when it has lines and every line is at a reachable plant; another message answers as "No … output stands" / "does not exist". Recorded user is the session user.
- Tests: `tests/company-scope-inventory.test.ts` (now 29+ tests): reach per company/plant scope, hidden-as-missing, no session/capability/scope/other tenant, nothing changed on refusal.

**Not covered / residual:**
- Batch master, batch cockpit/display/change, batch status and the other batch configuration services: **not scoped**. A batch at material or client level (batch level 1/2) carries no plant, so no company; a rule for it is a design decision (master-data class, phase 7). Plant-level batches carry a plant and could be scoped; this was not done.
- `dispatchPending` still enqueues the tenant-wide output sweep after verifying its own selection; the sweep sends messages other authorised users already queued, so it discloses nothing, but it is not limited to the caller's reach.
- The output job's per-message processing (`processMaterialOutputMessage`) runs as the job and is unchanged.
- Storage-location, material-type, valuation-class and other configuration lists carry no company data and were left.
- Not demonstrated at runtime; nothing browser-tested.

## Phase 9a — Production: planned orders and order confirmation

- Scoped (session, capability, Company Code scope, Plant scope; plant must name a company in reach): planned-order display/list (`PROD.PLANNEDORDER.DISPLAY`), create, change, and order confirmation load/preview/enter/get (`PROD.CONFIRM.ORDER`).
- An order at another company's plant, a no-company plant or a plant outside the Plant scope answers exactly as a missing order ("does not stand"). Create at an unreachable plant, or by copying an unreachable order, is refused; nothing is written.
- The recorded user is the session user (overrides `changedBy` / `requestedBy`).
- `...ForProvisioning` variants (tests, demo seed, scripts) run unscoped and are not imported from `src/app`.
- Tests: `tests/company-scope-production.test.ts` (8). Existing production tests repointed to the provisioning variants.
- Residual, not yet scoped: time ticket, order settlement (single and collective), MRP run, routing, work centre, BOM, availability, production-order types. Production-order display shims used by the confirmation page were not separately reviewed. Not browser-tested; full suite not run.

## Phase 9b — Production: time ticket (CO11N)

- `loadTimeTicket`, `previewTimeTicket`, `enterTimeTicket`, `getTimeTicket` now need a session, `PROD.CONFIRM.ENTER` and Company Code scope, judged in the service's own transaction. An order at a plant out of reach (another company, no company, outside the Plant scope) answers as a missing order; get returns null. The recorded user is the session user. `enterTimeTicket` takes the session from `input.authorization` (the same one carried into the automatic movements).
- `...ForProvisioning` variants run unscoped for tests, seeds and scripts.
- Tests: `tests/company-scope-production.test.ts` (10 now). Existing time-ticket tests repointed.
- Already scoped by its own check, not changed: confirmation cancel (CO13) requires an explicit Company Code and Plant scope. Residual: it answers an out-of-reach order with "not authorised" rather than as a missing one, so it discloses that the order exists.

## Phase 9c — Production: order settlement

- `settleProductionOrder` and `settleProductionOrdersCollective` now need a session, `PROD.ORDER.SETTLE` and Company Code scope, judged before any order is read. An individual order at a plant out of reach answers as a missing order (`INVALID_SELECTION`); a collective selection simply excludes such orders. The recorded user is the session user. `...ForProvisioning` variants run unscoped.
- Tests: `tests/company-scope-production.test.ts` (12 now, including test-run settlement refusals and selection filtering). Settlement and WIP tests repointed.
- Residual: only test runs are exercised by the adversarial tests (an update run goes through the same reach check but is not separately tested adversarially). The settlement posts a journal under the company ledger without a separate check of the actor's finance capability; the authority is `PROD.ORDER.SETTLE` plus scope. `order-wip` already took the session and was not changed. Still unscoped: MRP run, routing, work centre, BOM, availability, production-order types.

## Phase 9d — Production: production-order display, list and change (CO02/CO03)

- `getProductionOrderDisplay`, `listProductionOrders`, `changeProductionOrder` now need a session and Company Code scope (plus a Plant scope where held). Display and list accept `PROD.ORDER.DISPLAY` or the capability of the screen that looks an order up (`PROD.ORDER.CHANGE`, `PROD.CONFIRM.ORDER`, `PROD.CONFIRM.ENTER`); change needs `PROD.ORDER.CHANGE`.
- An order at another company's plant, a no-company plant or outside the Plant scope answers as a missing order. A listed plant out of reach "does not stand"; list and total count only orders in reach. A change records the session user.
- `...ForProvisioning` variants for tests, seeds, scripts and the services' own post-write reads (technical completion).
- Already scoped, unchanged: technical completion and its revocation (own authority + plant scope). Residual: they answer an out-of-reach order with a scope refusal rather than as a missing one.
- Tests: `tests/company-scope-production.test.ts` (14 now); 14 existing suites repointed.
- Still unscoped in production: MRP run, routing, BOM, work centre, production version, availability, capacity load, stock-requirements, STO planning, cost estimate, other reports.

## Phase 9e — Production: MRP run (MD01 / MD02 / MD03, background)

- `planMaterials`, `planSingleItem`, `planSingleLevel`, `cancelMrpRun`, `getMrpRun`, `listMrpRuns`, `getMrpRunProgress` now need a session, `PROD.MRP.RUN` (plus `PROD.MRP.REGENERATE` for regenerative, `PROD.MRP.SINGLELEVEL` for MD03) and Company Code scope.
- A run covers every plant of its range. A range holding any plant out of reach (another company, no company, outside the Plant scope, or a range with no plant) is refused as a whole, never narrowed; a single plant out of reach "does not stand". A run whose range is not wholly in reach is not shown, not listed, and answers as missing to progress and cancel. The recorded user is the session user.
- Background path: `submitMrpBackgroundRun` and every chunk re-check through `assertMrpAuthority`. That check had treated a missing Company Code restriction as unrestricted (`canWith`: "an absent level is unrestricted"); it now also requires an explicit Company Code restriction naming each plant's company (`reachablePlantsForUserInTx`), re-judged per chunk. Test planner fixtures now carry an explicit scope.
- `...ForProvisioning` variants for tests, seed and the foreground run's own post-write read.
- Tests: `tests/company-scope-production.test.ts` (17 now). Residual: the check-run tests are simulation-only; the background worker's chunk path is covered by the existing suite plus the new submission-refusal test, not a dedicated adversarial test of a user losing scope mid-run. The demand/supply reads inside a run are bounded by the run's plant range, not separately company-checked. Other users' proposals made by a run (planned orders, requisitions) are not re-scoped by a later reader beyond their own services.
- Still unscoped in production: BOM, routing, work centre, production version, availability, capacity load, stock-requirements, STO planning, cost estimate, other reports.
