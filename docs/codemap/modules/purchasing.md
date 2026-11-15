# Purchasing

**Purpose:** Procure-to-pay: requisitions, POs, RFQ/quotations, outline agreements (contracts, scheduling agreements + releases), invoice verification (incl. parking, payment blocks), GR/IR clearing/reconciliation, source determination (source lists, quota arrangements, info records, vendor evaluation). Goods-receipt *posting* lives in `inventory`; purchasing only triggers/reads it.

## Files
### Requisitions & POs
- `src/modules/purchasing/requisitions.ts` — create/change PR (ME51N-style, item-only, no header). Exports: `createRequisition`, `changeRequisition`, `getRequisition`, `requisitionChoices`, `PurchaseRequisitionError`.
- `src/modules/purchasing/requisition-list.ts` — ME5A-style multi-PR search/list. Exports: `listPurchaseRequisitions`, `RequisitionListError`.
- `src/modules/purchasing/orders.ts` — create/change PO, delivery-control tolerance resolution, release-impact detection. Exports: `createOrder`, `changeOrder`, `getOrder`, `resolveItemTolerances`, `releaseImpactingChanges`, `orderChoices`.
- `src/modules/purchasing/purchase-order-list.ts` — ME2L/ME2M/ME2N/ME2C-style PO list/search. Exports: `listPurchaseOrders`, `PoListError`.
- `src/modules/purchasing/purchase-order-display.ts` — read-only PO display: items, schedules, assignments, goods/invoice events, parks, clearings, change history. Exports: `displayPurchaseOrder`, `searchPurchaseOrders`, `openPurchaseOrderDisplay`.
- `src/modules/purchasing/po-account-assignment.ts` — ME2K-style PO list filtered/grouped by account assignment (cost center/order/asset). Exports: `purchaseOrdersByAccountAssignment`, `PoAccountAssignError`.
- `src/modules/purchasing/account-assignment.ts` — shared account-assignment category vocab + judging rows against cost objects. Exports: `judgeAccountAssignments`, `ACCOUNT_ASSIGNMENT_CATEGORIES`, `isAccountAssignmentCategory`.
- `src/modules/purchasing/item-state.ts` — derives single-word PO item/header status (OPEN/PARTIALLY_DELIVERED/DELIVERED/COMPLETED/MARKED/MIXED), shared by order display/list. Exports: `purchaseItemState`, `purchaseHeaderState`.
- `src/modules/purchasing/receipt-unit-basis.ts` — SQL helpers reconciling order-unit vs base-unit received qty, preventing double/mis-conversion. Exports: `receiptUnitJoins`, `receiptQuantityInOrderUnit`, `receiptQuantityUnstateable`, `receiptMovementSign`.
- `src/modules/purchasing/follow-on.ts` — requisition→RFQ/quotation→order chain: copy requisition into RFQ, adopt quotation into order draft, settle quota base, update info record from order. Exports: `copyRequisition`, `adoptQuotation`, `settleQuota`, `updateInfoRecordFromOrder`, `orderDraftFromQuotation`, `orderDraftFromRequisition`, `convertMoney`.
- `src/modules/purchasing/release.ts` — generic document release (strategy/step/status), shared by requisitions/orders/contracts/scheduling agreements; notifies: enqueues `DOC.RELEASE.WAITING` fan-out to release-capability holders in the document's org scope, `DOC.RELEASED`/`DOC.REFUSED` to the document's creator. Exports: `releaseDocument`, `cancelDocumentRelease`, `syncDocumentRelease`, `getDocumentRelease`, `listDocumentReleases`, `assertDocumentNotReleased`.
- `src/app/purchasing/requisitions/actions.ts` — PR create/change server actions.
- `src/app/purchasing/requisitions/Requisitions.tsx` — PR create/change client component.
- `src/app/purchasing/requisitions/page.tsx` — PR create/change page.
- `src/app/purchasing/requisition-list/page.tsx` — PR list page.
- `src/app/purchasing/requisition-list/RequisitionListShell.tsx` — PR list client shell.
- `src/app/purchasing/orders/actions.ts` — PO create/change server actions.
- `src/app/purchasing/orders/Orders.tsx` — PO create/change client component.
- `src/app/purchasing/orders/page.tsx` — PO create/change page.
- `src/app/purchasing/purchase-order-list/page.tsx` — PO list page.
- `src/app/purchasing/purchase-order-list/PurchaseOrderListShell.tsx` — PO list client shell.
- `src/app/purchasing/purchase-order-display/page.tsx` — PO display screen.
- `src/app/purchasing/orders-by-account-assignment/page.tsx` — PO-by-account-assignment page.
- `src/app/purchasing/orders-by-account-assignment/PoAccountAssignmentShell.tsx` — PO-by-account-assignment client shell.

### Contracts, RFQ/Quotations, Scheduling agreements
- `src/modules/purchasing/contract.ts` — purchase contract (outline agreement) create/change/list, call-off assertion. Exports: `createPurchaseContract`, `changePurchaseContract`, `getPurchaseContract`, `listPurchaseContracts`, `contractChoices`, `assertPurchaseContractCallOff`.
- `src/modules/purchasing/contract-display.ts` — read-only contract display w/ change history. Exports: `openPurchaseContractDisplay`.
- `src/modules/purchasing/rfq.ts` — RFQ event + per-supplier RFQ create/change. Exports: `createRequestForQuotation`, `writeRequestForQuotation`, `getRequestForQuotation`, `listRecentRequestsForQuotation`, `previewRequestForQuotation`.
- `src/modules/purchasing/quotation.ts` — quotation (price against one RFQ) create/change. Exports: `createQuotation`, `changeQuotation`, `writeQuotation`, `writeQuotationChange`, `openQuotation`, `pricePerUnit`.
- `src/modules/purchasing/quotation-display.ts` — read-only quotation display. Exports: `displayQuotation`, `displayQuotationForRequest`, `listRecentDisplayedQuotations`.
- `src/modules/purchasing/quotation-comparison.ts` — side-by-side comparison of quotations for an RFQ event. Exports: `compareQuotations`.
- `src/modules/purchasing/scheduling-agreement.ts` — scheduling agreement (outline agreement, no schedule lines on creation) create/change/list. Exports: `createSchedulingAgreement`, `changeSchedulingAgreement`, `getSchedulingAgreement`, `listSchedulingAgreements`, `schedulingAgreementChoices`.
- `src/modules/purchasing/scheduling-agreement-display.ts` — read-only scheduling-agreement display w/ change history. Exports: `openSchedulingAgreementDisplay`.
- `src/modules/purchasing/scheduling-agreement-schedule.ts` — ME38-style delivery schedule line maintenance. Exports: `maintainDeliverySchedule`, `readDeliverySchedule`.
- `src/modules/purchasing/scheduling-agreement-schedule-display.ts` — read-only delivery-schedule display/history. Exports: `openDeliveryScheduleDisplay`, `deliveryScheduleHistory`.
- `src/modules/purchasing/scheduling-agreement-release.ts` — ME84-style forecast/JIT release generation + release profile config. Exports: `createSchedulingAgreementReleases`, `saveReleaseProfile`, `assignReleaseProfile`, `listSchedulingAgreementReleases`.
- `src/app/purchasing/contracts/actions.ts` — contract create/change server actions.
- `src/app/purchasing/contracts/Contracts.tsx` — contract create/change client component.
- `src/app/purchasing/contracts/page.tsx` — contract create/change page.
- `src/app/purchasing/contract-display/page.tsx` — contract display screen.
- `src/app/purchasing/rfq/actions.ts` — RFQ server actions.
- `src/app/purchasing/rfq/RequestForQuotation.tsx` — RFQ client component.
- `src/app/purchasing/rfq/page.tsx` — RFQ page.
- `src/app/purchasing/quotation/actions.ts` — quotation server actions.
- `src/app/purchasing/quotation/Quotation.tsx` — quotation client component.
- `src/app/purchasing/quotation/page.tsx` — quotation page.
- `src/app/purchasing/quotation-display/page.tsx` — quotation display screen.
- `src/app/purchasing/quotation-comparison/page.tsx` — quotation comparison screen.
- `src/app/purchasing/scheduling-agreements/actions.ts` — scheduling agreement server actions.
- `src/app/purchasing/scheduling-agreements/Agreements.tsx` — scheduling agreement client component.
- `src/app/purchasing/scheduling-agreements/page.tsx` — scheduling agreement page.
- `src/app/purchasing/scheduling-agreement-display/page.tsx` — scheduling agreement display screen.
- `src/app/purchasing/delivery-schedule/actions.ts` — delivery schedule server actions.
- `src/app/purchasing/delivery-schedule/ScheduleForm.tsx` — delivery schedule client form.
- `src/app/purchasing/delivery-schedule/page.tsx` — delivery schedule maintenance page.
- `src/app/purchasing/delivery-schedule-display/page.tsx` — delivery schedule display screen.
- `src/app/purchasing/scheduling-agreement-releases/actions.ts` — release generation server actions.
- `src/app/purchasing/scheduling-agreement-releases/ReleaseForm.tsx` — release generation client form.
- `src/app/purchasing/scheduling-agreement-releases/page.tsx` — release generation/profile page.

### Invoice verification & GR/IR
- `src/modules/purchasing/invoice-verification.ts` — post/cancel supplier invoices against POs (MIRO-style): tax, variance, account-assignment postings, asset/down-payment interplay. Exports: `postSupplierInvoice`, `cancelSupplierInvoice`, `getSupplierInvoice`, `getInvoiceOrder`, `listInvoiceTaxCodes`, `INVOICE_CAPABILITY`.
- `src/modules/purchasing/parked-invoice.ts` — park/change a not-yet-posted supplier invoice; post/delete intentionally disabled (`postParkedInvoice`/`deleteParkedInvoice` both throw). Exports: `parkSupplierInvoice`, `changeParkedInvoice`, `getParkedInvoice`, `openOrderForPark`, `listRecentParkedInvoices`.
- `src/modules/purchasing/invoice-overview.ts` — MIR6-style multi-invoice search across parked/posted/cancelled lifecycles. Exports: types `InvoiceOverviewSelection/Row/Result`, capability/alias constants (impl body truncated in scan — selection/list fn expected alongside these).
- `src/modules/purchasing/blocked-invoice.ts` — MRBR-style payment-block place/release workflow w/ event history. Exports: `placePaymentBlock`, `releasePaymentBlock`, `previewPaymentBlock`, `listBlockedInvoices`, `listBlockEvents`.
- `src/modules/purchasing/grir-clearing.ts` — MR11-style GR/IR account maintenance (clear qty/price differences) + reversal. Exports: `postGrIrClearing`, `reverseGrIrClearing`, `previewGrIrClearing`, `listGrIrResiduals`, `listGrIrMaintenance`.
- `src/modules/purchasing/grir-reconciliation.ts` — F.13/MR11-analysis-style exception listing across GR/IR balances. Exports: `listGrIrExceptions`, types `GrIrExceptionRow/ReconciliationResult`.
- `src/app/purchasing/invoice-verification/actions.ts` — invoice posting server actions.
- `src/app/purchasing/invoice-verification/InvoiceVerification.tsx` — invoice posting client component.
- `src/app/purchasing/invoice-verification/page.tsx` — invoice posting page.
- `src/app/purchasing/parked-invoice/actions.ts` — parked invoice server actions.
- `src/app/purchasing/parked-invoice/ParkedInvoice.tsx` — parked invoice client component.
- `src/app/purchasing/parked-invoice/page.tsx` — parked invoice page.
- `src/app/purchasing/invoice-overview/page.tsx` — invoice overview/search screen.
- `src/app/purchasing/blocked-invoice/actions.ts` — blocked invoice server actions.
- `src/app/purchasing/blocked-invoice/BlockedInvoiceForms.tsx` — blocked invoice client forms.
- `src/app/purchasing/blocked-invoice/page.tsx` — blocked invoice page.
- `src/app/purchasing/grir-clearing/actions.ts` — GR/IR clearing server actions.
- `src/app/purchasing/grir-clearing/GrirClearingForms.tsx` — GR/IR clearing client forms.
- `src/app/purchasing/grir-clearing/page.tsx` — GR/IR clearing page.
- `src/app/purchasing/grir-reconciliation/page.tsx` — GR/IR reconciliation exception screen.

### Source determination (source list, quota, info records, vendor evaluation)
- `src/modules/purchasing/info-record.ts` — purchasing info record (supplier/material default) create/change, org segments, prices. Exports: `createPurchasingInfoRecord`, `changePurchasingInfoRecord`, `writePurchasingInfoRecord`, `writePurchasingInfoRecordChange`, `resolvePurchasingInfoRecord`, `previewPurchasingInfoRecord`.
- `src/modules/purchasing/source-list.ts` — source list (who may supply what at which plant) create/change/resolve. Exports: `createSourceListEntry`, `changeSourceListEntry`, `writeSourceListEntry`, `writeSourceListChange`, `resolveSourceList`, `getSourceList`, `getSourceListEntry`, `listRecentSourceEntries`.
- `src/modules/purchasing/quota-arrangement.ts` — quota arrangement (relative-weight requirement sharing) create/change/rate. Exports: `createQuotaArrangement`, `changeQuotaArrangement`, `writeQuotaArrangement`, `writeQuotaChange`, `rateQuota`, `listQuotaArrangements`.
- `src/modules/purchasing/vendor-evaluation.ts` — vendor evaluation criteria + manual scoring (no automatic score persisted). Exports: `listVendorEvaluation`, `checkVendorEvaluation`, `saveManualScore`.
- `src/modules/purchasing/purchasing-org-plant-assignment.ts` — thin re-export/wrapper over foundation's purchasing-org↔plant authorization for this module's config screen. Exports: `assignPurchasingOrgPlant`, `removePurchasingOrgPlant`, `listPurchasingOrgPlantAssignments`, `checkPurchasingOrgPlant`; re-exports `assertPurchasingOrgForPlant`, `purchasingOrgMayBuyForPlant` from `../foundation/purchasing-org-plant`.
- `src/modules/purchasing/delivery-completion.ts` — company-code/plant auto-close (delivery completion) policy config + decision logic. Exports: `deliveryCompletionDecision`, `readDeliveryCompletionPolicy`, `setDeliveryCompletionPolicy`, `setDeliveryCompletionPlantPolicy`, `listDeliveryCompletionPolicy`.
- `src/modules/purchasing/schema.ts` — Drizzle schema for whole module: requisitions, POs, info records, source list, quota arrangement, release, invoice verification, GR/IR, vendor evaluation, contracts, scheduling agreements, RFQ/quotation (see Database).
- `src/app/purchasing/info-record/actions.ts` — info record server actions.
- `src/app/purchasing/info-record/InfoRecord.tsx` — info record client component.
- `src/app/purchasing/info-record/page.tsx` — info record page.
- `src/app/purchasing/source-list/actions.ts` — source list server actions.
- `src/app/purchasing/source-list/SourceList.tsx` — source list client component.
- `src/app/purchasing/source-list/page.tsx` — source list page.
- `src/app/purchasing/quota-arrangement/actions.ts` — quota arrangement server actions.
- `src/app/purchasing/quota-arrangement/QuotaArrangement.tsx` — quota arrangement client component.
- `src/app/purchasing/quota-arrangement/page.tsx` — quota arrangement page.
- `src/app/purchasing/vendor-evaluation/actions.ts` — vendor evaluation server actions.
- `src/app/purchasing/vendor-evaluation/ManualScoreForm.tsx` — manual score client form.
- `src/app/purchasing/vendor-evaluation/page.tsx` — vendor evaluation page.
- `src/app/config/delivery-completion/actions.ts` — delivery completion policy server actions.
- `src/app/config/delivery-completion/DeliveryCompletion.tsx` — delivery completion policy client component.
- `src/app/config/delivery-completion/page.tsx` — delivery completion policy config page.
- `src/app/config/purchasing-orgs/actions.ts` — purchasing org define/deactivate server actions.
- `src/app/config/purchasing-orgs/page.tsx` — purchasing org master-data config page.
- `src/app/config/purchasing-orgs/PurchasingOrgDefinitionForm.tsx` — purchasing org definition client form.
- `src/app/config/purchasing-orgs/DeactivatePurchasingOrgForm.tsx` — purchasing org deactivation client form.
- `src/app/config/purchasing-orgs/assign-company/actions.ts` — purchasing org/company code assignment server actions.
- `src/app/config/purchasing-orgs/assign-company/page.tsx` — assign purchasing org to company code page.
- `src/app/config/purchasing-orgs/assign-company/PurchasingOrgCompanyCodeAssignmentForm.tsx` — assignment client form.
- `src/app/config/purchasing-orgs/assign-plant/actions.ts` — purchasing org/plant assignment server actions.
- `src/app/config/purchasing-orgs/assign-plant/page.tsx` — assign purchasing org to plant page.
- `src/app/config/purchasing-orgs/assign-plant/AssignPlant.tsx` — assignment client component.

## Pages & API routes
- `/purchasing/requisitions`, `/purchasing/requisition-list` — create/change and list requisitions.
- `/purchasing/orders`, `/purchasing/purchase-order-list`, `/purchasing/purchase-order-display`, `/purchasing/orders-by-account-assignment` — PO lifecycle, listing, display, account-assignment view (ME2K).
- `/purchasing/contracts`, `/purchasing/contract-display` — purchase contracts.
- `/purchasing/rfq`, `/purchasing/quotation`, `/purchasing/quotation-display`, `/purchasing/quotation-comparison` — RFQ/quotation cycle.
- `/purchasing/scheduling-agreements`, `/purchasing/scheduling-agreement-display`, `/purchasing/delivery-schedule`, `/purchasing/delivery-schedule-display`, `/purchasing/scheduling-agreement-releases` — scheduling agreements, schedules, releases.
- `/purchasing/invoice-verification`, `/purchasing/parked-invoice`, `/purchasing/invoice-overview`, `/purchasing/blocked-invoice` — invoice verification lifecycle.
- `/purchasing/grir-clearing`, `/purchasing/grir-reconciliation` — GR/IR account maintenance and exceptions.
- `/purchasing/info-record`, `/purchasing/source-list`, `/purchasing/quota-arrangement`, `/purchasing/vendor-evaluation` — source determination master data.
- `/config/delivery-completion` — company/plant auto-close policy (owned by purchasing, despite `/config` path).
- `/config/purchasing-orgs`, `/config/purchasing-orgs/assign-company`, `/config/purchasing-orgs/assign-plant` — purchasing org definition/assignment. NOTE: `/config/purchasing-groups` is a **foundation** screen, not this module, despite similar name.

## Database
**Owns** (all tables in `schema.ts`, listed under Files):
- Requisitions: `purchaseRequisitionItem`, `purchaseRequisitionAssignment`
- Purchase orders: `purchaseOrder`, `purchaseOrderItem`, `purchaseOrderScheduleLine`, `purchaseOrderAssignment`
- Info records: `purchasingInfoRecord`, `purchasingInfoRecordOrg`, `purchasingInfoRecordPrice`
- Delivery completion policy: `purchaseDeliveryCompletionPolicy`, `purchaseDeliveryCompletionPlant`
- Source list: `purchasingSourceList`, `purchasingSourceListEntry`
- Quota arrangement: `purchasingQuotaArrangement`, `purchasingQuotaArrangementItem`
- Release: `documentRelease` (shared release state: requisitions/orders/contracts/scheduling agreements)
- Invoice verification: `supplierInvoice`, `supplierInvoiceItem`, `parkedSupplierInvoice`, `parkedSupplierInvoiceItem`, `supplierInvoicePaymentBlock`, `supplierInvoicePaymentBlockEvent`
- GR/IR: `grIrMaintenanceLink`
- Vendor evaluation: `vendorEvaluationCriterion`, `vendorEvaluationAssessment`
- Contracts: `purchasingContractType`, `purchaseContract`, `purchaseContractItem`
- Scheduling agreements: `schedulingAgreementType`, `schedulingAgreement`, `schedulingAgreementItem`, `schedulingAgreementScheduleLine`, `schedulingReleaseProfile`, `schedulingReleaseProfileAssignment`, `schedulingAgreementRelease`, `schedulingAgreementReleaseLine`
- RFQ/quotation: `purchasingRfqEvent`, `purchasingRfqEventItem`, `purchasingRfq`, `purchasingRfqItem`, `purchasingQuotation`, `purchasingQuotationItem`
- Also defines `customerInvoice`, `customerInvoiceLine` in same file (sales-side tables colocated here; physically in this schema file, not conceptually owned by purchasing).

**Reads/writes other modules' tables:**
- `material`, `materialGroup`, `materialPlant`, `materialUomConversion`, `materialDocumentLine`, `materialValuation`, `movementType` — **inventory** — materials ordered/received, unit conversion, reading goods-receipt/material-document data for PO display, invoice verification, GR/IR.
- `plant`, `storageLocation`, `companyCode`, `purchasingGroup`, `purchasingOrg`, `purchasingOrgPlant`, `exchangeRate`, `taxCode`, `accountDetermination` — **foundation** — org master data, purchasing-org/plant authorization.
- `businessPartner`, `bpRole`, `supplierPurchasing`, `supplierCompany` — **foundation** — supplier master data (BP role, purchasing view, company view).
- `paymentTerms` — **foundation** — referenced by orders/contracts/agreements/invoices.
- `glAccount`, `costCenter`, `internalOrder`, `controllingAreaCompany` — **finance** — account assignment objects judged by `account-assignment.ts`/`po-account-assignment.ts`.
- `clearingReset` (via `../finance/clearing-reset`), `vendor-down-payment-clearing`, `asset-acquisition` — **finance** — invoice verification interplay: payment clearing resets, down payments, asset postings.
- `valuation-class-definition`, `material-period-control`, `goods-issue` (`getMaterialPeriodControlInTx`) — **inventory** — period/valuation checks before GR/IR postings.

## Depends on
- **foundation**: org master data (purchasing org/group, company code, plant), business partner/supplier purchasing views, payment terms, exchange rates, purchasing-org↔plant authorization, release strategy definitions, characteristics (release conditions).
- **inventory**: material master, UoM conversion, material documents/movement types for goods-receipt-derived figures (received qty, batches), period control, valuation-class checks. Inventory owns actual GR posting; purchasing only reads results, triggers via PO reference.
- **finance**: G/L accounts, cost centers/internal orders (account-assignment objects), clearing-reset, vendor down-payment clearing, asset acquisition postings triggered from invoice verification.
- **Shared/platform**: `platform/db/client` (Tx), `platform/tables/tenancy` (client/audit columns), `platform/tables/reference` (currency, UoM), capability/auth framework for screen capabilities (`PROC.*` codes), `platform/auth/authority` (`KEY_OF_LEVEL`), `platform/job/queue` + `platform/notification/{notify,creator,jobs/fanout}` (release notifications).

## Used by
Purchasing is a downstream dependency of:
- **inventory** — goods-receipt posting, batch posting/pickup, return deliveries, material-document reversal, stock/batch readback all reference POs (quantities, tolerances, account assignment, GR-based IV flag) as origin document. Tests: `tests/goods-receipt.test.ts`, `tests/batch-posting.test.ts`, `tests/return-delivery.test.ts`, `tests/material-document-reversal.test.ts`.
- **finance** — vendor ageing/balances/clearing and payment run read supplier invoices and GR/IR state posted by purchasing. Tests: `tests/vendor-clearing.test.ts`, `tests/vendor-balances.test.ts`, `tests/payment-run.test.ts`.
- **MRP/planning** (`single-item-planning`, `single-level-planning` tests) — planning runs create PRs as planned orders' procurement proposals.
- **QM** (`qm-inspection-results.test.ts`, `qm-usage-decision.test.ts`, `quality-lot.test.ts`) — quality lots created from goods receipts against POs.
- Browser smoke scripts outside this module's folder (`payment-run.ts`, `quality-lots.ts`, `vendor-ageing.ts`, `vendor-balances.ts`, `vendor-clearing.ts`) exercise purchasing-originated data from finance/inventory screens.
- Config screens `config/delivery-completion` and `config/purchasing-orgs/assign-plant` are physically under `src/app/config/` but belong to purchasing (see scope note); listed under Files, not here.

## Tests
- **Requisitions/POs**: `purchase-requisition.test.ts`, `purchase-requisition-list.test.ts`, `purchase-requisition-list-ui-contract.test.ts`, `requisition-transaction.test.ts`, `purchase-order.test.ts`, `purchase-order-advance.test.ts`, `purchase-order-list.test.ts`, `purchase-order-list-ui-contract.test.ts`, `purchase-order-display.test.ts`, `purchase-order-display-ui-contract.test.ts`, `purchase-order-batch-display.test.ts`, `purchase-item-state.test.ts`, `po-delivery-control.test.ts`, `po-release-impact.test.ts`, `po-account-assignment.test.ts`, `po-account-assignment-ui-contract.test.ts`, `release-acts.test.ts`, `release-waiting.test.ts`, `workbench-agreement.test.ts`.
- **Contracts/RFQ/Quotation/Scheduling agreements**: `purchase-contract.test.ts`, `rfq.test.ts`, `rfq-schema-contract.test.ts`, `rfq-ui-contract.test.ts`, `quotation.test.ts`, `quotation-schema-contract.test.ts`, `quotation-ui-contract.test.ts`, `quotation-display.test.ts`, `quotation-display-ui-contract.test.ts`, `quotation-comparison.test.ts`, `quotation-comparison-ui-contract.test.ts`, `scheduling-agreement.test.ts`, `scheduling-agreement-schedule.test.ts`, `scheduling-agreement-release.test.ts`, `purchasing-follow-on.test.ts`.
- **Invoice verification & GR/IR**: `invoice-verification.test.ts`, `invoice-account-assignment.test.ts`, `parked-invoice.test.ts`, `parked-invoice-ui-contract.test.ts`, `invoice-overview.test.ts`, `invoice-overview-ui-contract.test.ts`, `blocked-invoice.test.ts`, `blocked-invoice-ui-contract.test.ts`, `grir-clearing.test.ts`, `grir-clearing-ui-contract.test.ts`, `grir-reconciliation.test.ts`.
- **Source determination**: `info-record.test.ts`, `info-record-ui-contract.test.ts`, `info-record-schema-contract.test.ts`, `source-list.test.ts`, `source-list-ui-contract.test.ts`, `source-list-schema-contract.test.ts`, `quota-arrangement.test.ts`, `quota-arrangement-ui-contract.test.ts`, `quota-arrangement-schema-contract.test.ts`, `vendor-evaluation.test.ts`, `vendor-evaluation-ui-contract.test.ts`.
- **Purchasing org config**: `purchasing-org-browser-target-contract.test.ts`, `purchasing-org-capability-contract.test.ts`, `purchasing-org-company-code-assignment-ui-contract.test.ts`, `purchasing-org-company-code-browser-target-contract.test.ts`, `purchasing-org-definition-ui-contract.test.ts`, `purchasing-org-maintenance-action-contract.test.ts`, `purchasing-org-plant-assignment-screen-contract.test.ts`, `purchasing-org-plant-assignment.test.ts`, `delivery-completion-policy.test.ts`.

## Scripts
- Browser smoke tests for purchasing screens: `scripts/browser-smoke/po-account-assignment.ts`, `scripts/browser-smoke/purchase-order-list.ts`, `scripts/browser-smoke/purchase-orders.ts`, `scripts/browser-smoke/purchase-requisitions.ts`, `scripts/browser-smoke/release-acts.ts`, `scripts/browser-smoke/requisition-list.ts`, `scripts/browser-smoke/scr145-return-delivery.ts` (goods-movement smoke exercising a PO-referencing return delivery; posting itself is inventory's), `scripts/browser-smoke/scr151-info-record.ts`, `scripts/browser-smoke/scr152-info-record-change.ts`, `scripts/browser-smoke/scr153-source-list.ts`, `scripts/browser-smoke/scr154-quota-arrangement.ts`, `scripts/browser-smoke/scr155-rfq.ts`, `scripts/browser-smoke/scr156-rfq-change.ts`, `scripts/browser-smoke/scr157-quotation.ts`, `scripts/browser-smoke/scr158-quotation-display.ts`, `scripts/browser-smoke/scr159-quotation-comparison.ts`, `scripts/browser-smoke/scr160-parked-invoice.ts`, `scripts/browser-smoke/scr161-invoice-overview.ts`, `scripts/browser-smoke/scr162-blocked-invoice.ts`, `scripts/browser-smoke/scr163-grir-clearing.ts`, `scripts/browser-smoke/scr164-purchase-order-display.ts`, `scripts/browser-smoke/scr165-vendor-evaluation.ts`.
- Planning-adjacent: `scripts/plan-me2k.mts` (account-assignment PO list plan), `scripts/plan-me5a.mts` (requisition list plan), `scripts/plan-po-list.mts` (PO list plan).

## Non-obvious behavior / gotchas
- Goods receipt in alt unit stores separate "entry" and "base" qty/unit pairs; naive readers comparing `base_quantity` to `purchase_order_item.quantity` (order unit) misreport by conversion factor — `receipt-unit-basis.ts` centralizes correct resolution.
- `postParkedInvoice()`/`deleteParkedInvoice()` in `parked-invoice.ts` both just `throw` (`Promise<never>`) — posting a park goes through `invoice-verification.ts`'s normal post path using the park as draft.
- `/config/purchasing-groups` (GROUP master data) belongs to **foundation**, not purchasing, despite the name. `/config/purchasing-orgs` (ORG master data) and `/config/delivery-completion` ARE purchasing's despite `/config` path.
- Purchasing never posts stock. GR against a PO is inventory's `goods-receipt.ts`/batch-posting code; purchasing only supplies PO tolerances/account-assignment/GR-based-IV flag as inputs, later reads resulting material documents via `receipt-unit-basis.ts`, `item-state.ts`, `purchase-order-display.ts`.
- `release.ts`'s `documentRelease` table/functions serve requisitions, orders, contracts, scheduling agreements uniformly by `documentCategory` — no per-document-type release table.
- Per `follow-on.ts` header comment: RFQ/quotation never consumes the requisition/RFQ it was copied from; only final order consumes requisition (up to remaining) and quota base (only for vendors already in the quota — others warned, not blocked).
- `purchase_order_assignment` check constraint enforces exactly one of cost center/internal order/asset set per row — never zero, never more than one.
- `schema.ts` comments document source-list lookup index perf (hit ~0.045ms/6 buffers, miss ~0.017ms/2 buffers on 20k entries) — deliberate, no extra index added beyond compound primary key.
- Release-waiting notification is idempotent per (category, document, release group, strategy): re-syncing an unchanged pending document doesn't re-notify; a strategy restart does. Creator notification uses the change-document trail (`creatorOf`) — no trail, no notification.
