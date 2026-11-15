# Finance

**Purpose:** GL (chart of accounts, journal postings, parking, clearing, reversal), AP/AR (invoices, credit memos, down payments, payments, dunning, credit management, ageing), period close (accruals, FX valuation, GR/IR reclass, close cockpit, carryforward), fixed assets (acquisition, depreciation, retirement), group consolidation (data basis, areas, units, monitor, consolidated statements).

## Files

### src/modules/finance — GL core, journal & clearing
- `src/modules/finance/schema.ts` — core Drizzle schema (largest file, 2490 lines): `glAccount`, `journalEntry`/`journalEntryLine` (universal journal) + all finance subledger/run tables (see Database).
- `src/modules/finance/gl-account-group-schema.ts` — `glAccountGroup`, `glAccountGroupFieldStatus` (FS00 field-status matrix), `groupChartAccounts` (consolidation target accounts).
- `src/modules/finance/gl-account-group-maintenance.ts` — account group CRUD + field-status matrix. Exports: `listAccountGroups`, `accountGroupFieldStatusMatrices`, `accountGroupChoices`, `groupAccountChoices`.
- `src/modules/finance/gl-account-vocabulary.ts` — shared vocabulary (account types, field statuses, language keys) used by schema/services/FS00 screen. Exports: `GL_ACCOUNT_FIELDS`, `ACCOUNT_TYPES`, `GL_ACCOUNT_TYPES`, `deriveGlAccountType`, `deriveIsBalanceSheet`.
- `src/modules/finance/gl-account-transfer.ts` — transfer GL account company-code segment between company codes. Exports: `listAccountSegments`, `transferGlAccounts`.
- `src/modules/finance/gl-document.ts` — FB50-style direct GL document posting; lines may carry an `internalOrder` (validated: company, validity, deletion/posting lock); `postGlDocument(input, {tx?, authorization?})` verifies capability + company-code scope in-tx. Exports: `postGlDocument`.
- `src/modules/finance/gl-balances.ts` — balance/balance-report queries. Exports: `getGlBalances`, `getGlBalanceReport`.
- `src/modules/finance/gl-clearing.ts` — manual GL open-item clearing. Exports: `getGlClearing`, `clearGlItems`.
- `src/modules/finance/journal-items.ts` — journal line item list/filter report (FBL*-style). Exports: `getJournalItems`.
- `src/modules/finance/ledger-journal.ts` — status-derivation helper for ledger journal views. Exports: `ledgerJournalStatus`.
- `src/modules/finance/document-display.ts` — journal document display, drill-down, document flow. Exports: `getJournalDocument`, `resolveDocumentNumber`.
- `src/modules/finance/document-reversal.ts` — document reversal (FB08). Exports: `getDocumentForReversal`, `reverseDocument`.
- `src/modules/finance/parked-journal.ts` — park/edit/complete/post/delete preliminary journal docs (FV50/FBV0). Exports: `parkJournal`, `editParkedJournal`, `completeParkedJournal`, `postParkedJournal`, `deleteParkedJournal`, `listParkedJournals`, `getParkedJournal`.
- `src/modules/finance/clearing-reset.ts` — reset/undo open-item clearing (FBRA). Exports: `getClearingDocument`, `resetClearing`, `resetClearingTx`.
- `src/modules/finance/chart-of-accounts-copy.ts` — bulk-copy chart of accounts + GL accounts to new chart. Exports: `copyChartOfAccounts`, `listChartCopies`.

### src/modules/finance — AR (customer) processes
- `src/modules/finance/customer-invoice.ts` — FB70 customer invoice post/cancel; lines may post by `components` (split revenue accounts) with caller-supplied `taxAmount`/`taxAccount` (billing-driven), else tax determined from code. Exports: `postCustomerInvoice`, `cancelCustomerInvoice`, `getCustomerInvoice`, `listCustomerInvoiceTaxCodes`.
- `src/modules/finance/customer-credit-memo.ts` — FB75 customer credit memo; can reference/partially cancel an invoice; billing reference must match the billing's payer partner (`sales/partners`), not just its sold-to. Exports: `postCustomerCreditMemo`, `getCustomerCreditMemo`.
- `src/modules/finance/customer-clearing.ts` — manual clearing of open customer items (F-32). Exports: `getCustomerClearing`, `clearCustomerItems`.
- `src/modules/finance/customer-balances.ts` — customer balance display report. Exports: `getCustomerBalances`.
- `src/modules/finance/customer-ageing.ts` — customer open-item ageing report. Exports: `getCustomerAgeing`.
- `src/modules/finance/customer-down-payment.ts` — customer down payment (special G/L, DZ journal) posting (F-29). Exports: `postCustomerDownPayment`, `getCustomerDownPayments`.
- `src/modules/finance/customer-down-payment-request.ts` — customer down payment noted item/request (F-37), no journal until fulfilled. Exports: `createCustomerDownPaymentRequest`, `createCustomerDownPaymentRequestTx`, `reverseCustomerDownPaymentRequest`, `reverseCustomerDownPaymentRequestTx` (withdraw; refused once any receipt stands against it), `applyRequestFulfillment`, `getCustomerDownPaymentRequests`.
- `src/modules/finance/customer-down-payment-clearing.ts` — transfers standing down payments against open invoices (F-39). Exports: `getCustomerDownPaymentClearing`, `getCustomerDownPaymentClearingTx`, `clearCustomerDownPayments`, `clearCustomerDownPaymentsTx` (`*Tx` variants used by `sales/down-payment.ts`).
- `src/modules/finance/incoming-payment.ts` — incoming customer payment with clearing (F-28); input `authorization` checked for capability + company-code scope. Exports: `getReceivables`, `postIncomingPayment`.
- `src/modules/finance/dunning.ts` — dunning run (propose/exclude/finalize/cancel) over overdue customer items (F150); propose/finalize take `{authorization}` and check every run company code is in scope. Exports: `proposeDunningRun`, `excludeDunningAccount`, `finalizeDunningRun`, `cancelDunningRun`, `getDunningRun`, `listDunningRuns`.
- `src/modules/finance/credit.ts` — customer credit master (FD32), credit-check evaluation, credit exposure monitor (F.31); a newly BLOCKED sales document enqueues a `CREDIT.BLOCKED` fan-out to credit-release holders (credit control area/sales org scope), release notifies the order's creator (`CREDIT.RELEASED`). Exports: `getCustomerCredit`, `saveCustomerCredit`, `evaluateCreditCheck`, `getCreditExposure`, `listCreditAudit`.
- `src/modules/finance/credit-control-area-contract.ts` — shared constants/activities for credit control area maintenance screen+service.
- `src/modules/finance/credit-control-area-maintenance.ts` — credit control area setup CRUD (config screen under src/app/config). Exports: `listCreditControlAreaSetup`, `createCreditControlAreaSetup`.
- `src/modules/finance/walkthrough-credit-preflight.ts` — reads foundation company-code/credit-control-area state to preflight seed walkthrough's credit scenario. Exports: `readWalkthroughCreditPrerequisiteSnapshot`, `walkthroughCreditPrerequisiteError`.
- `src/modules/finance/ageing-derivation.ts` — shared ageing-item derivation used by customer+vendor ageing reports. Exports: `deriveAgeingItems`, `aggregateAgeingPartners`, `validateAgeingSelection`.

### src/modules/finance — AP (vendor) processes
- `src/modules/finance/vendor-invoice.ts` — FB60 vendor invoice post/cancel. Exports: `postVendorInvoice`, `cancelVendorInvoice`, `getVendorInvoice`, `listVendorInvoiceTaxCodes`.
- `src/modules/finance/vendor-credit-memo.ts` — FB65 vendor credit memo. Exports: `postVendorCreditMemo`, `getVendorCreditMemo`.
- `src/modules/finance/vendor-clearing.ts` — manual clearing of open vendor items (F-44). Exports: `getVendorClearing`, `clearVendorItems`.
- `src/modules/finance/vendor-balances.ts` — vendor balance display report. Exports: `getVendorBalances`.
- `src/modules/finance/vendor-ageing.ts` — vendor open-item ageing report, with CSV export. Exports: `getVendorAgeing`, `vendorAgeingCsv`.
- `src/modules/finance/vendor-down-payment.ts` — vendor down payment (special G/L, KA journal) posting (F-48), optionally against a PO. Exports: `postVendorDownPayment`, `getVendorDownPayments`, `judgeAdvanceOrder`, `resolveSpecialGlAccount`.
- `src/modules/finance/vendor-down-payment-request.ts` — vendor down payment noted item/request (F-47). Exports: `createVendorDownPaymentRequest`, `applyVendorRequestFulfillment`, `getVendorDownPaymentRequests`.
- `src/modules/finance/vendor-down-payment-clearing.ts` — transfers standing vendor down payments against open invoices (F-54), optionally tied to a PO/invoice from procurement. Exports: `getDownPaymentClearing`, `clearDownPayments`, `getOrderAdvances`.
- `src/modules/finance/outgoing-payment.ts` — outgoing vendor payment with clearing (F-53); `{authorization}` capability + company-code scope check. Exports: `getPayables`, `postOutgoingPayment`.
- `src/modules/finance/payment-run.ts` — automatic payment run (F110): parameters, proposal generation, execution, cancellation. Exports: `createPaymentRun`, `generateProposal`, `executePaymentRun`, `cancelPaymentRun`, `listBankChoices`.

### src/modules/finance — Intercompany & GR/IR
- `src/modules/finance/intercompany.ts` — intercompany posting (FB01, two balanced journals in one transaction) + OBYA pair-clearing-account config. Exports: `postIntercompany`, `saveIntercompanyConfig`, `deleteIntercompanyConfig`, `listIntercompanyConfigs`, `listCompanyChoices`.
- `src/modules/finance/grir-reclass.ts` — GR/IR reclassification analysis + accrual run (F.19-style); `{authorization}` capability + company-code scope check. Exports: `executeGrIrAnalysis`, `getGrIrRun`, `grIrCsv`.

### src/modules/finance — Period close & reporting
- `src/modules/finance/accrual.ts` — accrual/deferral document posting with scheduled reversal (FBS1); passes `authorization` through to `postGlDocument`. Exports: `postAccrualDocument`, `listDueAccruals`, `executeAccrualReversal`, `listAccrualDocuments`.
- `src/modules/finance/fx-valuation.ts` — FX valuation run on open items/balances (FAGL_FC_VAL/F.05). Exports: `executeFxValuation`, `getFxValuationRun`, `fxValuationCsv`.
- `src/modules/finance/close-cockpit.ts` — period-end close task template/task-list engine with dependency graph, execution log, event trail. Exports: `createTaskListFromTemplate`, `releaseTaskList`, `executeTask`, `processScheduledExecutions`, `attachEvidence`, `signOffTask`, `findDependencyCycle`.
- `src/modules/finance/carryforward.ts` — balance carryforward/year-end close (F.16/FAGLGVTR): balance-sheet openings derived at read time, P&L accounts transferred to retained earnings; passes `authorization` through to its GL posting. Exports: `executeCarryforward`, `getCarryforwardRun`, `listCarryforwardRuns`, `listCarryforwardResults`.
- `src/modules/finance/trial-balance.ts` — trial balance/financial statement calculation engine (also backs balance sheet & P&L versions). Exports: `calculateTrialBalance`, `listStatementVersions`.
- `src/modules/finance/balance-sheet.ts` — balance sheet statement view. Exports: `calculateBalanceSheet`.
- `src/modules/finance/profit-loss.ts` — P&L statement view (re-exports `TrialBalanceError`). Exports: `calculateProfitLoss`.
- `src/modules/finance/cash-flow-vocabulary.ts` — cash flow statement vocabulary (methods, account classes, selection/result types).
- `src/modules/finance/cash-flow.ts` — cash flow statement calculation (re-exports vocabulary). Exports: `calculateCashflow`.
- `src/modules/finance/subledger-tie-out.ts` — reconciles GL reconciliation accounts against AR/AP subledger totals. Exports: `calculateSubledgerTie`.
- `src/modules/finance/tax-report.ts` — tax advance return execution/report (tax_return_run); `{authorization}` capability + company-code scope check. Exports: `executeTaxReport`, `listTaxReturnRuns`.

### src/modules/finance — Fixed assets
- `src/modules/finance/asset-master.ts` — asset master create/change/deactivate, assignment + depreciation-parameter maintenance. Exports: `createAsset`, `changeAsset`, `changeAssetAssignment`, `changeAssetDepreciation`, `deactivateAsset`.
- `src/modules/finance/asset-acquisition.ts` — asset acquisition posting/simulation/reversal. Exports: `simulateAssetAcquisition`, `recordAssetAcquisition`, `postAssetAcquisition`, `reverseAssetAcquisition`, `getAssetTransactions`.
- `src/modules/finance/asset-depreciation.ts` — depreciation run execution (planned/repeat/restart/unplanned) (AFAB). Exports: `executeDepreciationRun`, `listDepreciationRuns`, `getDepreciationRunItems`, `getPostedDepreciation`.
- `src/modules/finance/asset-retirement.ts` — asset retirement posting (complete/percent/amount scope) + reversal. Exports: `simulateAssetRetirement`, `postAssetRetirement`, `reverseAssetRetirement`, `listRetireableAssets`, `getAssetRetirements`.
- `src/modules/finance/asset-history.ts` — asset value/transaction history sheet report, with CSV export. Exports: `getAssetHistorySheet`, `assetHistoryCsv`.

### src/modules/finance — Consolidation
- `src/modules/finance/consolidation-vocabulary.ts` — consolidation domain vocabulary (folders, data providers, method/task kinds, area/unit/group shapes).
- `src/modules/finance/consolidation-workbench.ts` — config workbench for data basis, areas, units, groups, mappings, methods, versions, tasks (re-exports vocabulary). Exports: `getConsolidationWorkbench`, `saveDataBasis`, `saveArea`, `saveUnit`, `saveGroup`, `assignUnit`, `saveGroupAccount`, `saveMapping`, `saveMethod`, `saveVersion`, `saveTask`.
- `src/modules/finance/consolidation-monitor-vocabulary.ts` — monitor-specific vocabulary (execution modes, task/execution statuses, error/warning policies, supported task types).
- `src/modules/finance/consolidation-monitor.ts` — executes/tracks consolidation task runs (re-exports monitor vocabulary). Exports: `getConsolidationMonitor`, `executeConsolidationTask`, `executeConsolidationTaskGroup`, `cancelConsolidationExecution`.
- `src/modules/finance/consolidated-statements-vocabulary.ts` — consolidated statement view/section vocabulary.
- `src/modules/finance/consolidated-statements.ts` — calculates consolidated financial statements across consolidation units (re-exports vocabulary). Exports: `calculateConsolidatedStatements`.

### src/app/config/chart-of-accounts — Chart of accounts config screens
- `actions.ts` — server actions: save/activate chart of accounts and group chart of accounts.
- `page.tsx` — chart of accounts maintenance page.
- `ChartOfAccountsForm.tsx` — create/edit form.
- `ChartOfAccountsList.tsx` — list.
- `ChartLifecycleControl.tsx` — activate/deactivate control.
- `ChartOfAccountsValueHelp.tsx` — F4 value-help picker for a chart.
- `GroupChartOfAccounts.tsx` — group chart of accounts (OB13) maintenance UI.
- `copy/actions.ts` — server action wrapping `copyChartOfAccounts`.
- `copy/page.tsx` — copy chart of accounts page.
- `copy/CopyChartForm.tsx` — copy chart form.

### src/app/config/consolidation — Consolidation config screen
- `actions.ts` — server actions (`saveBasisAction`, `saveAreaAction`, `saveUnitAction`, `saveGroupAction`, `assignUnitAction`, `saveGroupAccountAction`, `saveMappingAction`, more) wrapping consolidation-workbench service calls.
- `ConsolidationWorkbenchShell.tsx` — workbench shell UI (tabs for data basis/areas/units/groups/mappings/methods/versions/tasks).
- `page.tsx` — consolidation config page.

### src/app/config/credit-control-areas
- `actions.ts` — server action `createCreditControlAreaAction`.
- `CreditControlAreaSetup.tsx` — setup UI.
- `page.tsx` — config page.

### src/app/config/fiscal-year-variants
- `actions.ts` — save/activate fiscal year variant + periods.
- `FiscalYearVariants.tsx` — maintenance UI.
- `page.tsx` — config page.
- `assign-company-codes/actions.ts` — server action `assignFiscalYearVariantAction`.
- `assign-company-codes/page.tsx` — assignment page.
- `AssignCompanyCodesUI.tsx` — assignment UI (fiscal year variant to company codes).

### src/app/config/gl-accounts — GL account master (FS00) config screens
- `actions.ts` — server actions: save/block/delete GL account, save account group, set account group active, save field-status row.
- `fieldStatus.ts` — baseline field-status fallback vocabulary (used when no DB row exists for a field).
- `page.tsx` — GL accounts landing page.
- `GlAccountInitialScreen.tsx` — FS00 "initial screen" (chart/account/company selection).
- `GlAccountModeScreen.tsx` — create/change/display mode screen shell.
- `GlAccountFields.tsx` — field-by-field form renderer driven by field-status matrix.
- `GlAccountDialog.tsx` — modal dialog wrapper for account create/edit.
- `GlAccountsList.tsx` — list/search.
- `GlAccountValueHelp.tsx` — F4 value-help picker for a GL account.
- `AccountGroups.tsx` — account group registry + field-status matrix maintenance UI.
- `new/page.tsx` — create-mode page.
- `edit/page.tsx` — change-mode page.
- `view/page.tsx` — display-mode page.
- `transfer/page.tsx` — account transfer page.
- `transfer/TransferShell.tsx` — transfer-between-company-codes UI.

### src/app/config/intercompany-clearing
- `actions.ts` — save/delete OBYA intercompany clearing pair config.
- `IntercompanyClearing.tsx` — clearing config UI.
- `page.tsx` — config page.

### src/app/finance — Journal & GL screens
- `journal/page.tsx` — journal area landing page.
- `journal/new/actions.ts`, `JournalForm.tsx`, `page.tsx` — FB50-style direct GL posting screen.
- `journal/park/actions.ts`, `ParkedJournal.tsx`, `page.tsx` — park/complete/post/delete parked journal screen.
- `journal/document/DocumentDisplay.tsx`, `page.tsx` — journal document display/drill-down screen.
- `journal/items/ItemsForm.tsx`, `page.tsx` — journal line items report screen.
- `journal/balances/BalancesForm.tsx`, `BalanceReportForm.tsx`, `page.tsx` — GL balance / balance report screens.
- `gl-clearing/actions.ts`, `GlClearing.tsx`, `page.tsx` — GL open-item clearing screen.
- `clearing-reset/ResetForm.tsx`, `page.tsx` — clearing reset (FBRA) screen.
- `document-reversal/page.tsx` — document reversal screen.
- `trial-balance/TrialBalanceShell.tsx`, `page.tsx` — trial balance screen.
- `balance-sheet/BalanceSheetShell.tsx`, `page.tsx` — balance sheet screen.
- `profit-loss/ProfitLossShell.tsx`, `page.tsx` — P&L screen.
- `cash-flow/CashflowShell.tsx`, `page.tsx` — cash flow statement screen.
- `subledger-tie-out/SubledgerTieShell.tsx`, `page.tsx` — subledger tie-out screen.
- `tax/report/TaxReportForm.tsx`, `page.tsx` — tax report screen.

### src/app/finance — AR screens
- `customer-invoice/actions.ts`, `CustomerInvoice.tsx`, `page.tsx` — FB70 customer invoice posting screen.
- `customer-clearing/actions.ts`, `CustomerClearing.tsx`, `page.tsx` — F-32 customer clearing screen.
- `customer-balances/page.tsx` — customer balance display.
- `customer-ageing/page.tsx` — customer ageing report.
- `customer-down-payment/actions.ts`, `CustomerDownPayment.tsx`, `page.tsx` — F-29 down payment screen.
- `customer-down-payment-request/actions.ts`, `CustomerDownPaymentRequest.tsx`, `page.tsx` — F-37 request screen.
- `customer-down-payment-clearing/actions.ts`, `CustomerDownPaymentClearing.tsx`, `page.tsx` — F-39 clearing screen.
- `incoming-payment/actions.ts`, `IncomingPayment.tsx`, `page.tsx` — F-28 incoming payment screen.
- `dunning/page.tsx` — dunning run screen.
- `credit/actions.ts`, `CreditShell.tsx`, `page.tsx` — FD32 credit master screen.
- `credit-monitor/CreditMonitorShell.tsx`, `page.tsx` — F.31 credit monitor screen.
- `credit-release/actions.ts`, `CreditReleaseShell.tsx`, `page.tsx` — blocked sales-order credit release screen.
- `vendor-credit-memo/actions.ts`, `VendorCreditMemo.tsx`, `page.tsx` — FB65 vendor credit memo screen (also used against customer invoices — see module file).

### src/app/finance — AP screens
- `vendor-invoice/actions.ts`, `VendorInvoice.tsx`, `page.tsx` — FB60 vendor invoice posting screen.
- `vendor-clearing/actions.ts`, `VendorClearing.tsx`, `page.tsx` — F-44 vendor clearing screen.
- `vendor-balances/page.tsx` — vendor balance display.
- `vendor-ageing/page.tsx`, `vendor-ageing/export/route.ts` — vendor ageing report + CSV export route.
- `vendor-down-payment/actions.ts`, `VendorDownPayment.tsx`, `page.tsx` — F-48 down payment screen.
- `vendor-down-payment-request/actions.ts`, `VendorDownPaymentRequest.tsx`, `page.tsx` — F-47 request screen.
- `vendor-down-payment-clearing/actions.ts`, `VendorDownPaymentClearing.tsx`, `page.tsx` — F-54 clearing screen.
- `outgoing-payment/actions.ts`, `OutgoingPayment.tsx`, `page.tsx` — F-53 outgoing payment screen.
- `payment-run/actions.ts`, `PaymentRun.tsx`, `page.tsx` — F110 payment run screen.

### src/app/finance — Intercompany & GR/IR screens
- `intercompany/actions.ts`, `IntercompanyPosting.tsx`, `page.tsx` — intercompany posting screen.
- `grir-reclass/GrIrForm.tsx`, `page.tsx`, `export/route.ts` — GR/IR reclass screen + CSV export.

### src/app/finance — Period close & asset screens
- `accruals/AccrualShell.tsx`, `actions.ts`, `page.tsx` — accrual posting/reversal screen.
- `fx/valuation/ValuationForm.tsx`, `page.tsx`, `export/route.ts` — FX valuation run screen + CSV export.
- `close-cockpit/CloseCockpitShell.tsx`, `actions.ts`, `page.tsx` — close cockpit screen.
- `carryforward/CarryforwardShell.tsx`, `actions.ts`, `page.tsx` — balance carryforward screen.
- `assets/page.tsx` — fixed assets landing page.
- `assets/new/AssetCreate.tsx`, `actions.ts`, `page.tsx` — asset master create screen.
- `assets/change/AssetChange.tsx`, `actions.ts`, `page.tsx` — asset master change screen.
- `assets/acquire/AcquireForm.tsx`, `actions.ts`, `page.tsx` — asset acquisition screen.
- `assets/depreciate/DepreciateForm.tsx`, `actions.ts`, `page.tsx` — depreciation run screen.
- `assets/retire/RetireForm.tsx`, `actions.ts`, `page.tsx` — asset retirement screen.
- `assets/history/HistoryForm.tsx`, `page.tsx`, `export/route.ts` — asset history sheet screen + CSV export.

### src/app/finance — Consolidation screens
- `consolidated-statements/ConsolidatedStatementsShell.tsx`, `page.tsx` — consolidated statements screen.
- `consolidation-monitor/ConsolidationMonitorShell.tsx`, `actions.ts`, `page.tsx` — consolidation monitor screen.

## Pages & API routes
- `/finance/journal`, `/finance/journal/new`, `/finance/journal/park`, `/finance/journal/document`, `/finance/journal/items`, `/finance/journal/balances` — direct posting, parking, document display, line-item and balance reports.
- `/finance/gl-clearing`, `/finance/clearing-reset`, `/finance/document-reversal` — GL open-item clearing, clearing reset, document reversal.
- `/finance/trial-balance`, `/finance/balance-sheet`, `/finance/profit-loss`, `/finance/cash-flow`, `/finance/subledger-tie-out`, `/finance/tax/report` — statement/reporting screens.
- `/finance/customer-invoice`, `/finance/customer-clearing`, `/finance/customer-balances`, `/finance/customer-ageing` — AR core screens.
- `/finance/customer-down-payment`, `/finance/customer-down-payment-request`, `/finance/customer-down-payment-clearing` — AR special-GL down payment screens.
- `/finance/incoming-payment`, `/finance/dunning`, `/finance/credit`, `/finance/credit-monitor`, `/finance/credit-release` — AR payments, dunning, credit management.
- `/finance/vendor-invoice`, `/finance/vendor-clearing`, `/finance/vendor-balances`, `/finance/vendor-ageing` (+ `/export`) — AP core screens.
- `/finance/vendor-down-payment`, `/finance/vendor-down-payment-request`, `/finance/vendor-down-payment-clearing` — AP special-GL down payment screens.
- `/finance/outgoing-payment`, `/finance/payment-run` — AP payments and automatic payment run.
- `/finance/vendor-credit-memo` — vendor and customer credit memo screen (shared route).
- `/finance/intercompany` — intercompany posting.
- `/finance/grir-reclass` (+ `/export`) — GR/IR reclassification run.
- `/finance/accruals`, `/finance/fx/valuation` (+ `/export`), `/finance/close-cockpit`, `/finance/carryforward` — period close screens.
- `/finance/assets`, `/finance/assets/new`, `/finance/assets/change`, `/finance/assets/acquire`, `/finance/assets/depreciate`, `/finance/assets/retire`, `/finance/assets/history` (+ `/export`) — fixed asset screens.
- `/finance/consolidated-statements`, `/finance/consolidation-monitor` — consolidation runtime screens.
- `/config/chart-of-accounts` (+ `/copy`), `/config/gl-accounts` (+ `/new`, `/edit`, `/view`, `/transfer`), `/config/consolidation`, `/config/credit-control-areas`, `/config/fiscal-year-variants` (+ `/assign-company-codes`), `/config/intercompany-clearing` — finance-owned config screens.

## Database
**Owns** (schema.ts files): `gl_account`, `gl_account_group`, `gl_account_group_field_status`, `group_chart_accounts`, `gl_account_company`, `gl_account_transfer_run`, `gl_account_transfer_result`, `journal_entry`, `journal_entry_line`, `journal_posting_request`, `tax_return_run`, `fx_valuation_run`, `fx_valuation_item`, `grir_reclass_run`, `grir_reclass_item`, `accrual_document`, `closing_task_template`, `closing_task_template_dependency`, `closing_task_list`, `closing_task_instance`, `closing_task_dependency`, `closing_execution_log`, `closing_task_event`, `carryforward_run`, `carryforward_result`, `payment_run`, `payment_run_company`, `payment_run_method`, `payment_proposal_item`, `payment_document`, `outgoing_payment`, `vendor_down_payment`, `vendor_down_payment_clearing`, `customer_down_payment`, `customer_down_payment_clearing`, `customer_down_payment_clearing_item`, `customer_down_payment_request`, `down_payment_request_fulfillment`, `vendor_down_payment_request`, `vendor_dp_request_fulfillment`, `asset_class`, `depreciation_area`, `depreciation_key`, `fixed_asset`, `asset_assignment`, `asset_depreciation`, `asset_transaction_type`, `asset_transaction`, `asset_retirement`, `asset_depreciation_run`, `asset_depreciation_run_item`, `asset_depreciation_posting`, `parked_journal_header`, `parked_journal_line`, `incoming_payment`, `reversal_reason`, `accounting_reversal_link`, `clearing_reset`, `dunning_run`, `dunning_run_company`, `dunning_run_account`, `dunning_run_item`, `dunning_notice`, `vendor_invoice`, `vendor_invoice_line`, `credit_risk_category`, `credit_representative_group`, `customer_credit_group`, `credit_block_reason`, `customer_credit`, `credit_change_audit`, `credit_determination`, `credit_release_event`, `financial_statement_version`, `financial_statement_node`, `financial_statement_assignment`, `consolidation_data_basis`, `consolidation_dimension`, `consolidation_area`, `consolidation_unit`, `consolidation_group`, `consolidation_unit_assignment`, `consolidation_group_account`, `consolidation_account_mapping`, `consolidation_method`, `consolidation_version`, `consolidation_task`, `consolidation_execution`, `consolidation_execution_log`, `consolidation_task_status`, `residual_reason`, `gl_clearing_allocation`, `gl_clearing_residual`, `intercompany_clearing_config`, `intercompany_document_header`.

**Reads/writes tables owned by other modules:**
- `chart_of_accounts`, `group_chart_of_accounts`, `company_code`, `credit_control_area`, `fiscal_year_variant`, `business_partner`, `customer_company`/`supplier_company`, `payment_terms`, `bank_account`, `house_bank`, `payment_method`, `exchange_rate`, `document_type` — owned by **foundation**; finance reads constantly for account/company/partner master data, payment-terms baseline-date derivation, bank/payment-method lookups in payment postings.
- `customer_invoice`, `customer_invoice_line`, `supplier_invoice` — owned by **purchasing** (module-boundary quirk: both customer- and supplier-side invoice-verification tables live in `src/modules/purchasing/schema.ts`); finance reads for ageing, dunning, incoming/down-payment clearing, GL clearing, credit-memo cancellation matching.
- `purchase_order` — owned by **purchasing**; read by vendor down payment / down payment clearing to resolve the order an advance was raised against.
- `billing_document` — owned by **sales**; read by `customer-credit-memo.ts` when a credit memo is issued against a billing document.
- `activeBlockedInvoiceNumbers` (blocked-invoice helper) — owned by **purchasing**; read by `payment-run.ts` to exclude blocked invoices from the payment proposal.

## Depends on
- Other modules:
  - **foundation** — company codes, chart of accounts, credit control areas, fiscal year variants, business partners, customer/supplier company extensions, payment terms, bank/house bank/payment method master data. Nearly every finance service resolves ≥1 foundation master record before posting.
  - **purchasing** — `customer_invoice`/`supplier_invoice`/`purchase_order` tables + blocked-invoice helper, used by ageing, dunning, down-payment, clearing, payment-run flows reconciling against invoice-verification documents.
  - **sales** — `billing_document` + `sales/partners` (`documentPartners`, payer check), used only by customer credit memo issuance.
  - No direct dependency on **controlling** found in this module's scope; cost/profit center fields on journal lines are plain varchar FK-free columns.
- Shared/platform:
  - `@/platform/tables/tenancy` — `client`, `auditColumns` on every table (multi-tenant scoping, standard audit columns).
  - `@/platform/db/client` — `withTenant`/`Tx` transaction wrapper used by virtually every service function.
  - `@/platform/posting` (+ `/decimal`) — canonical posting engine (`postJournalEntry`, `PostingError`) every document-creating flow posts through, plus decimal/scaled-amount helpers.
  - `@/platform/periods` (+ `/windows`) — period derivation/validation (`derivePosition`, `getCompanyCode`) enforcing open posting periods.
  - `@/platform/numbering` — document/run number range assignment.
  - `@/platform/lock/enqueue` — advisory locking for concurrent run execution (payment run, depreciation run, clearing).
  - `@/platform/auth/capability-policy`, `@/platform/auth/current`, `@/platform/auth/session` — capability codes (e.g. `FIN.JOURNAL.POST`, `FIN.CREDIT.MAINTAIN`) and actor/session resolution.
  - `@/platform/auth/service-authority` — in-tx actor/capability/company-code scope verification (`verifyServiceAuthorityInTx`) for posting services.
  - `@/platform/job/queue`, `@/platform/notification/{notify,creator,jobs/fanout}` — credit block/release notifications (`credit.ts`).
  - `@/platform/change` — `recordChange` audit-trail logging on mutations.
  - `@/platform/i18n` — localized labels/messages in service and screen code.
  - `@/platform/tables/reference` — shared reference-table helpers.
  - `@/ui/*` — shared UI component library used throughout `src/app/finance` and `src/app/config/*` screens (38 files import from it).

## Used by
- **sales** module (`src/app/sales/credit-memo/actions.ts`, `CreditMemo.tsx`, `page.tsx`) imports `@/modules/finance/customer-credit-memo` and `@/modules/finance/customer-invoice` (`cancelCustomerInvoice`, `listCustomerInvoiceTaxCodes`) to drive sales-side credit memo screen; `src/modules/sales/down-payment.ts` calls the `*Tx` down-payment request/clearing functions.
- **foundation** and **purchasing** modules import finance's `journalEntry`/`journalEntryLine` schema types (e.g. `src/modules/foundation/chart-of-accounts-maintenance.ts`, `cost-center-definition.ts`, `tax-code-definition.ts`, `internal-order.ts`, `src/modules/purchasing/invoice-verification.ts`) to type account-assignment fields and join against journal lines.
- Many `tests/*.test.ts` files exercise finance services directly (contract, schema-contract, completion/workflow tests) — see Tests.
- `scripts/browser-smoke/*.ts` smoke-drive nearly every finance screen end to end, plus cross-module smoke scripts (`sales-order-to-invoice.ts`, `cost-center-report.ts`, `profit-center-report.ts`) traversing into finance screens as part of a larger walkthrough.

## Tests
tests/accrual.test.ts, tests/asset-acquisition.test.ts, tests/asset-depreciation.test.ts, tests/asset-history.test.ts, tests/asset-master.test.ts, tests/asset-retirement.test.ts, tests/balance-sheet-index-contract.test.ts, tests/balance-sheet.test.ts, tests/carryforward.test.ts, tests/cash-flow-schema-contract.test.ts, tests/cash-flow.test.ts, tests/chart-of-accounts-copy.test.ts, tests/chart-of-accounts-migration-contract.test.ts, tests/clearing-reset.test.ts, tests/close-cockpit.test.ts, tests/consolidated-statements-schema-contract.test.ts, tests/consolidated-statements.test.ts, tests/consolidation-monitor-schema-contract.test.ts, tests/consolidation-monitor.test.ts, tests/consolidation-workbench-schema-contract.test.ts, tests/consolidation-workbench.test.ts, tests/credit-notification.test.ts, tests/helpers/finance-actor.ts, tests/credit-control-area-atomicity.test.ts, tests/credit-control-area-capability.test.ts, tests/credit-control-area-maintenance-contract.test.ts, tests/credit-control-area-maintenance.test.ts, tests/credit-control-area-validation.test.ts, tests/credit-monitor.test.ts, tests/credit-release.test.ts, tests/credit.test.ts, tests/customer-ageing.test.ts, tests/customer-balances.test.ts, tests/customer-clearing.test.ts, tests/customer-credit-memo.test.ts, tests/customer-down-payment-clearing.test.ts, tests/customer-down-payment-request.test.ts, tests/customer-down-payment.test.ts, tests/customer-invoice.test.ts, tests/document-display.test.ts, tests/document-reversal.test.ts, tests/dunning.test.ts, tests/fx-valuation.test.ts, tests/gl-account-activity-registry.test.ts, tests/gl-account-master-maintenance.test.ts, tests/gl-account-master-schema-contract.test.ts, tests/gl-account-transfer.test.ts, tests/gl-balances.test.ts, tests/gl-clearing-schema-contract.test.ts, tests/gl-clearing.test.ts, tests/gl-document.test.ts, tests/gl-reporting-completion.test.ts, tests/gl-reporting-index-contract.test.ts, tests/gl-reporting-suite.test.ts, tests/grir-reclass.test.ts, tests/helpers/credit-control-area-authorized.ts, tests/incoming-payment-completion.test.ts, tests/incoming-payment.test.ts, tests/intercompany-schema-contract.test.ts, tests/intercompany.test.ts, tests/invoice-advance-clearing.test.ts, tests/journal-document-display-ui-contract.test.ts, tests/journal-document-display.test.ts, tests/journal-items.test.ts, tests/outgoing-payment-completion.test.ts, tests/outgoing-payment.test.ts, tests/parked-journal.test.ts, tests/payment-run.test.ts, tests/profit-loss.test.ts, tests/statement-version-onboarding.test.ts, tests/subledger-tie-out.test.ts, tests/subledger-tie-schema-contract.test.ts, tests/tax-code-definition.test.ts, tests/tax-report.test.ts, tests/trial-balance.test.ts, tests/vendor-ageing.test.ts, tests/vendor-balances.test.ts, tests/vendor-clearing.test.ts, tests/vendor-credit-memo.test.ts, tests/vendor-down-payment-clearing.test.ts, tests/vendor-down-payment-request.test.ts, tests/vendor-down-payment.test.ts, tests/vendor-invoice.test.ts, tests/walkthrough-credit-preflight.test.ts

## Scripts
scripts/browser-smoke/accrual.ts, scripts/browser-smoke/asset-acquisition.ts, scripts/browser-smoke/asset-depreciation.ts, scripts/browser-smoke/asset-history.ts, scripts/browser-smoke/asset-master.ts, scripts/browser-smoke/asset-retirement.ts, scripts/browser-smoke/balance-sheet.ts, scripts/browser-smoke/carryforward.ts, scripts/browser-smoke/cash-flow.ts, scripts/browser-smoke/chart-of-accounts-copy.ts, scripts/browser-smoke/chart-of-accounts.ts, scripts/browser-smoke/checks.ts, scripts/browser-smoke/clearing-reset.ts, scripts/browser-smoke/close-cockpit.ts, scripts/browser-smoke/consolidated-statements.ts, scripts/browser-smoke/consolidation-monitor.ts, scripts/browser-smoke/consolidation-workbench.ts, scripts/browser-smoke/cost-center-report.ts, scripts/browser-smoke/credit-monitor.ts, scripts/browser-smoke/credit-release.ts, scripts/browser-smoke/credit.ts, scripts/browser-smoke/customer-ageing.ts, scripts/browser-smoke/customer-balances.ts, scripts/browser-smoke/customer-clearing.ts, scripts/browser-smoke/customer-down-payment-clearing.ts, scripts/browser-smoke/customer-down-payment-request.ts, scripts/browser-smoke/customer-down-payment.ts, scripts/browser-smoke/customer-invoice.ts, scripts/browser-smoke/document-display.ts, scripts/browser-smoke/document-reversal.ts, scripts/browser-smoke/dunning.ts, scripts/browser-smoke/fiscal-year-variants.ts, scripts/browser-smoke/fx-valuation.ts, scripts/browser-smoke/gl-account-transfer.ts, scripts/browser-smoke/gl-accounts.ts, scripts/browser-smoke/gl-balances.ts, scripts/browser-smoke/gl-clearing.ts, scripts/browser-smoke/gl-document.ts, scripts/browser-smoke/gl-reporting-suite.ts, scripts/browser-smoke/gl-reporting.ts, scripts/browser-smoke/grir-reclass.ts, scripts/browser-smoke/incoming-payment-completion.ts, scripts/browser-smoke/incoming-payment.ts, scripts/browser-smoke/intercompany.ts, scripts/browser-smoke/journal-document-display.ts, scripts/browser-smoke/journal-items.ts, scripts/browser-smoke/outgoing-payment-completion.ts, scripts/browser-smoke/outgoing-payment.ts, scripts/browser-smoke/parked-journal.ts, scripts/browser-smoke/payment-run.ts, scripts/browser-smoke/profit-center-report.ts, scripts/browser-smoke/profit-loss.ts, scripts/browser-smoke/statement-version-acceptance.ts, scripts/browser-smoke/subledger-tie-out.ts, scripts/browser-smoke/tax-report.ts, scripts/browser-smoke/trial-balance.ts, scripts/browser-smoke/vendor-ageing.ts, scripts/browser-smoke/vendor-balances.ts, scripts/browser-smoke/vendor-clearing.ts, scripts/browser-smoke/vendor-credit-memo.ts, scripts/browser-smoke/vendor-down-payment-clearing.ts, scripts/browser-smoke/vendor-down-payment-request.ts, scripts/browser-smoke/vendor-down-payment.ts, scripts/browser-smoke/vendor-invoice.ts, scripts/plan-fb03.mts

## Non-obvious behavior / gotchas
- `gl_account.isBalanceSheet` derived, check-pinned, not user input: constraint `gl_account_balance_sheet_derived` forces `isBalanceSheet = (glAccountType = 'BALANCE_SHEET')`; DB only rejects inconsistent writes, doesn't compute the value — services must still set it correctly.
- `journal_entry_line.amountLocal`/`amountDocument` always positive; direction lives in `debitCredit` ('S'/'H'). Check constraint enforces amount > 0 — never encode sign in amount.
- No balance-summary tables for GL or assets: balances, ageing, trial balance, carryforward openings, asset NBV all derived at read time from `journal_entry_line` (or `asset_transaction`/`asset_retirement`), not a running-totals table.
- Carryforward never closes the prior period, safely re-runnable: P&L transfer document lands inside source year's totals, so re-running only posts the still-untransferred delta; a test run changes nothing (per `carryforward.ts` header comment).
- Down payment requests (customer and vendor) are "noted items" with no journal until receipt/payment fulfills them — `customer_down_payment_request`/`vendor_down_payment_request` are the document of record; no GL posting at request creation.
- Credit check exposure includes unbilled commitments: `evaluateCreditCheck` in `credit.ts` adds un-billed sales order/delivery commitments (via `openSalesCommitments`, swallowed to `'0'` on error) on top of open AR exposure before comparing to credit limit.
- Intercompany posting is two balanced journals in one DB transaction — either side failing rolls back both; each line stamps a trading-partner company (VBUND/RCOMP parity) for consolidation elimination. OBYA clearing account resolution falls back from pair-specific override to company code's configured account; validated as extended to that company code before posting (3 distinct failure messages: missing account, account not in chart, account not extended to company).
- "purchasing" module, not finance, owns `customer_invoice`/`supplier_invoice` tables despite the customer-facing name — module-boundary quirk; finance's ageing, dunning, clearing, credit-memo code all read these cross-module.
- Vendor/customer down payment clearing never creates value, only transfers it: applied totals (settles vs. applies) must agree by construction; partially-applied item keeps original line open alongside new offsetting line ("standing partial model") rather than mutating original; remaining amounts always derived from journal lines, never a side table.
- Close cockpit tasks form a DAG with explicit cycle detector (`findDependencyCycle`, DFS over task→predecessor edges): task templates/lists carry self-referencing parent/predecessor FKs with `taskId <> predecessorTaskId` checks, but cross-task cycles only caught at application layer, not DB.
- Group-side consolidation account master (`group_chart_accounts`) ships with no maintenance UI — exists only to be referenced by `gl_account.groupAccountNumber`, intentionally starts empty until a consolidation round populates it (per schema comment, "R-51/D-123").
- Posting services (`gl-document`, payments, dunning, GR/IR, tax report, accrual, carryforward) now refuse without a live `authorization` (`{userId, sessionId}`) even though the option is typed optional — callers outside `src/app` (scripts, seeds, tests) must pass one; tests use `tests/helpers/finance-actor.ts` (`financePoster`/`financeInputPoster` wrappers).
- `CREDIT.BLOCKED` fan-out is idempotent per (sales document, determination) and fires only on a transition into BLOCKED; recipients are resolved by the job worker, not in the posting tx.
