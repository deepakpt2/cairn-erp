# Finance
GL, AP/AR, period close, fixed assets, consolidation, tax. Routes: `/finance/*`, `/config/{chart-of-accounts,consolidation,credit-control-areas,fiscal-year-variants,gl-accounts,intercompany-clearing}`. Paths relative to `src/`; tables are SQL names.

## Gotchas

- Background payment run (`payment-run-background.ts`, jobs `PAYMENT.RUN.PROPOSAL`/`PAYMENT.RUN.EXECUTE`, queue INTENSIVE): one active `payment_run_operation` per run; `generateProposal`/`cancelPaymentRun`/`executePaymentRun`/release acts refuse while one is active. Proposal stages into `payment_proposal_stage` and publishes proposal + restarted release in one tx. Execution IS `executePaymentRun` (one tx) with `beforeExecute` (fence + current-grant check) and `afterExecute` (operation SUCCEEDED) hooks, so payments and their record commit together.
- Journal amounts are always > 0; direction is `debit_credit` (S/H). No balance tables: balances, ageing, NBV are derived from `journal_entry_line` / `asset_transaction` at read time.
- `postGlDocument` (gl-document.ts) is idempotent on `requestKey`, runs `onPosted` in the caller's tx, and refuses without `authorization` (`{userId, sessionId}`); tests use `tests/helpers/finance-actor.ts`.
- Intercompany = two balanced journals in one tx, each line stamped with the trading partner.
- Down-payment requests are noted items (no journal until paid). Clearing never mutates the original line (standing partial model).
- `gl_account.is_balance_sheet` is CHECK-pinned to account type; services must still set it.
- Close cockpit DAG cycles are caught in app code (`findDependencyCycle`), not the DB.
- `CREDIT.BLOCKED` fan-out fires on transition only; recipients resolved by the job worker.
- Foundation's `services.ts` writes finance's `gl_account` (cross-module write).
- Parked journals and payment runs can be claimed by a release strategy: `postParkedJournal` / `executePaymentRun` refuse while PENDING; direct posting (FIN.JOURNAL.POST) is not gated. A new proposal restarts a run's release; deleting a parked journal or cancelling a run drops its `document_release` row. Demo actors are upper case (`DEMO.ACCOUNTANT`); a lower-case name cannot be notified.

## Files (232)
| file | exports | tables |
|---|---|---|
| **app/config/chart-of-accounts/** | | |
| actions.ts | saveChartOfAccountsAction, setChartOfAccountsActiveAction, saveGroupChartOfAccountsAction, setGroupChartOfAccountsActiveAction |  |
| ChartLifecycleControl.tsx | ChartLifecycleControl |  |
| ChartOfAccountsForm.tsx | ChartOfAccountsForm, ActionMessage |  |
| ChartOfAccountsList.tsx | ChartOfAccountsList |  |
| ChartOfAccountsValueHelp.tsx | ChartOfAccountsValueHelp, ChartLanguageField |  |
| GroupChartOfAccounts.tsx | GroupChartOfAccountsPanel, GroupChartOfAccountsForm, GroupChartOfAccountsList |  |
| page.tsx | ChartOfAccountsPage |  |
| **app/config/chart-of-accounts/copy/** | | |
| actions.ts | copyChart |  |
| CopyChartForm.tsx | CopyChartForm |  |
| page.tsx | CopyChartOfAccountsPage |  |
| **app/config/consolidation/** | | |
| actions.ts | saveBasisAction, saveAreaAction, saveUnitAction, saveGroupAction, assignUnitAction, saveGroupAccountAction, saveMappingAction, saveMethodAction, saveVersionAction, saveTaskAction, activateAreaAction |  |
| ConsolidationWorkbenchShell.tsx | ConsolidationWorkbenchShell |  |
| page.tsx | ConsolidationWorkbenchPage |  |
| **app/config/credit-control-areas/** | | |
| actions.ts | createCreditControlAreaAction |  |
| CreditControlAreaSetup.tsx | CreditControlAreaSetup |  |
| page.tsx | CreditControlAreasPage |  |
| **app/config/fiscal-year-variants/** | | |
| actions.ts | saveFiscalYearVariantAction, setFiscalYearVariantActiveAction, saveFiscalYearPeriodsAction |  |
| AssignCompanyCodesUI.tsx | AssignmentMessage, AssignCompanyCodesUI |  |
| FiscalYearVariants.tsx | ActionMessage, FiscalYearVariantForm, FiscalYearVariantPanel, FiscalYearVariantList |  |
| page.tsx | FiscalYearVariantsPage |  |
| **app/config/fiscal-year-variants/assign-company-codes/** | | |
| actions.ts | assignFiscalYearVariantAction |  |
| page.tsx | AssignFiscalYearVariantPage |  |
| **app/config/gl-accounts/** | | |
| AccountGroups.tsx | AccountGroupsPanel |  |
| actions.ts | saveGlAccountAction, setGlAccountBlocksAction, deleteGlAccountAction, saveAccountGroupAction, setAccountGroupActiveAction, saveAccountGroupFieldStatusAction |  |
| fieldStatus.ts | ACCOUNT_TYPES, DEFAULT_FIELD_STATUS, DEFAULT_LANGUAGE_KEY, DEFAULT_SORT_KEY, FIELD_STATUSES, GL_ACCOUNT_FIELDS, GL_ACCOUNT_TYPES, RECONCILIATION_TYPES, STORAGE_MANDATORY_FIELDS, SUPPORTED_LANGUAGE_KEYS, accountNumberInRange, deriveGlAccountType, deriveIsBalanceSheet, isBalanceSheetAccountType, resolveFieldStatus |  |
| GlAccountDialog.tsx | GlAccountActionMessage, GlAccountDialog, ReasonField |  |
| GlAccountFields.tsx | GlAccountFields |  |
| GlAccountInitialScreen.tsx | GlAccountInitialScreen |  |
| GlAccountModeScreen.tsx | GlAccountModeScreen |  |
| GlAccountsList.tsx | GlAccountsList |  |
| GlAccountValueHelp.tsx | GlAccountValueHelp |  |
| page.tsx | GlAccountsPage |  |
| **app/config/gl-accounts/edit/** | | |
| page.tsx | EditGlAccountPage |  |
| **app/config/gl-accounts/new/** | | |
| page.tsx | NewGlAccountPage |  |
| **app/config/gl-accounts/transfer/** | | |
| page.tsx | ScreenPage |  |
| TransferShell.tsx | TransferShell |  |
| **app/config/gl-accounts/view/** | | |
| page.tsx | ViewGlAccountPage |  |
| **app/config/intercompany-clearing/** | | |
| actions.ts | saveIntercompanyConfigAction, deleteIntercompanyConfigAction |  |
| IntercompanyClearing.tsx | IntercompanyClearing |  |
| page.tsx | IntercompanyClearingPage |  |
| **app/finance/accruals/** | | |
| AccrualShell.tsx | AccrualShell |  |
| actions.ts | postAccrualAction, reverseAccrualAction |  |
| **app/finance/assets/** | | |
| page.tsx | AssetsPage |  |
| **app/finance/assets/acquire/** | | |
| AcquireForm.tsx | AcquireForm |  |
| actions.ts | simulateAction, postAction, reverseAction |  |
| page.tsx | AcquireAssetPage |  |
| **app/finance/assets/change/** | | |
| actions.ts | changeAction, assignmentAction, depreciationAction, deactivateAction |  |
| AssetChange.tsx | AssetChange |  |
| page.tsx | ChangeAssetPage |  |
| **app/finance/assets/depreciate/** | | |
| actions.ts | executeAction |  |
| DepreciateForm.tsx | DepreciateForm |  |
| page.tsx | DepreciatePage |  |
| **app/finance/assets/history/** | | |
| HistoryForm.tsx | HistoryForm |  |
| page.tsx | AssetHistoryPage |  |
| **app/finance/assets/history/export/** | | |
| route.ts | GET |  |
| **app/finance/assets/new/** | | |
| actions.ts | createAction |  |
| AssetCreate.tsx | AssetCreate |  |
| page.tsx | CreateAssetPage |  |
| **app/finance/assets/retire/** | | |
| actions.ts | simulateAction, postAction, reverseAction |  |
| page.tsx | RetireAssetPage |  |
| RetireForm.tsx | RetireForm |  |
| **app/finance/balance-sheet/** | | |
| BalanceSheetShell.tsx | BalanceSheetShell |  |
| page.tsx | ScreenPage |  |
| **app/finance/carryforward/** | | |
| actions.ts | executeCarryforwardAction |  |
| CarryforwardShell.tsx | CarryforwardShell |  |
| **app/finance/cash-flow/** | | |
| CashflowShell.tsx | CashflowShell |  |
| page.tsx | CashflowPage |  |
| **app/finance/clearing-reset/** | | |
| page.tsx | ClearingResetPage |  |
| ResetForm.tsx | ResetForm |  |
| **app/finance/close-cockpit/** | | |
| actions.ts | createListAction, releaseListAction, finalizeListAction, processScheduledAction, executeTaskAction, evidenceAction, signoffAction, overrideAction, reopenAction |  |
| CloseCockpitShell.tsx | CloseCockpitShell |  |
| **app/finance/consolidated-statements/** | | |
| ConsolidatedStatementsShell.tsx | ConsolidatedStatementsShell |  |
| page.tsx | ConsolidatedStatementsPage |  |
| **app/finance/consolidation-monitor/** | | |
| actions.ts | executeTaskAction, executeTaskGroupAction, cancelExecutionAction |  |
| ConsolidationMonitorShell.tsx | ConsolidationMonitorShell |  |
| page.tsx | ConsolidationMonitorPage |  |
| **app/finance/credit-monitor/** | | |
| CreditMonitorShell.tsx | CreditMonitorShell |  |
| page.tsx | ScreenPage |  |
| **app/finance/credit-release/** | | |
| actions.ts | recheckAction, releaseAction, bulkReleaseAction, rejectAction, reblockAction |  |
| CreditReleaseShell.tsx | CreditReleaseShell |  |
| page.tsx | ScreenPage |  |
| **app/finance/credit/** | | |
| actions.ts | loadCreditAction, saveCreditAction |  |
| CreditShell.tsx | CreditShell |  |
| page.tsx | ScreenPage |  |
| **app/finance/customer-ageing/** | | |
| page.tsx | CustomerAgeingPage |  |
| **app/finance/customer-balances/** | | |
| page.tsx | CustomerBalancesPage |  |
| **app/finance/customer-clearing/** | | |
| actions.ts | clearAction |  |
| CustomerClearing.tsx | CustomerClearing |  |
| page.tsx | CustomerClearingPage |  |
| **app/finance/customer-down-payment-clearing/** | | |
| actions.ts | postCustomerClearingAction |  |
| CustomerDownPaymentClearing.tsx | CustomerDownPaymentClearing |  |
| page.tsx | CustomerDownPaymentClearingPage |  |
| **app/finance/customer-down-payment-request/** | | |
| actions.ts | postRequestAction |  |
| CustomerDownPaymentRequest.tsx | CustomerDownPaymentRequest |  |
| page.tsx | CustomerDownPaymentRequestPage |  |
| **app/finance/customer-down-payment/** | | |
| actions.ts | postDownPaymentAction |  |
| CustomerDownPayment.tsx | CustomerDownPayment |  |
| page.tsx | CustomerDownPaymentPage |  |
| **app/finance/customer-invoice/** | | |
| actions.ts | postInvoiceAction, cancelInvoiceAction |  |
| CustomerInvoice.tsx | CustomerInvoice |  |
| page.tsx | CustomerInvoicePage |  |
| **app/finance/document-reversal/** | | |
| page.tsx | DocumentReversalPage |  |
| **app/finance/dunning/** | | |
| page.tsx | DunningPage |  |
| **app/finance/fx/valuation/** | | |
| page.tsx | FxValuationPage |  |
| ValuationForm.tsx | ValuationForm |  |
| **app/finance/fx/valuation/export/** | | |
| route.ts | GET |  |
| **app/finance/gl-clearing/** | | |
| actions.ts | clearAction |  |
| GlClearing.tsx | GlClearing |  |
| page.tsx | GlClearingPage |  |
| **app/finance/grir-reclass/** | | |
| GrIrForm.tsx | GrIrForm |  |
| page.tsx | GrIrReclassPage |  |
| **app/finance/grir-reclass/export/** | | |
| route.ts | GET |  |
| **app/finance/incoming-payment/** | | |
| actions.ts | postPaymentAction |  |
| IncomingPayment.tsx | IncomingPayment |  |
| page.tsx | IncomingPaymentPage |  |
| **app/finance/intercompany/** | | |
| actions.ts | postIntercompanyAction |  |
| IntercompanyPosting.tsx | IntercompanyPosting |  |
| page.tsx | IntercompanyPage |  |
| **app/finance/journal/** | | |
| page.tsx | JournalPage |  |
| **app/finance/journal/balances/** | | |
| BalanceReportForm.tsx | BalanceReportForm |  |
| BalancesForm.tsx | BalancesForm |  |
| page.tsx | GlBalancesPage |  |
| **app/finance/journal/document/** | | |
| DocumentDisplay.tsx | DocumentDisplay |  |
| page.tsx | JournalDocumentPage |  |
| **app/finance/journal/items/** | | |
| ItemsForm.tsx | ItemsForm |  |
| page.tsx | JournalItemsPage |  |
| **app/finance/journal/new/** | | |
| actions.ts | postJournalAction |  |
| JournalForm.tsx | JournalForm |  |
| **app/finance/journal/park/** | | |
| actions.ts | parkAction, completeAction, postAction, deleteAction, releaseJournalAction, cancelJournalReleaseAction |  |
| page.tsx | ParkedJournalPage |  |
| ParkedJournal.tsx | ParkedJournal |  |
| **app/finance/outgoing-payment/** | | |
| actions.ts | postPaymentAction |  |
| OutgoingPayment.tsx | OutgoingPayment |  |
| page.tsx | OutgoingPaymentPage |  |
| **app/finance/payment-run/** | | |
| actions.ts | createRunAction, proposalAction, executeAction, cancelOperationAction, paymentOperationStatusAction, cancelRunAction, releaseRunAction, cancelRunReleaseAction |  |
| page.tsx | PaymentRunPage |  |
| PaymentRun.tsx | PaymentRun |  |
| **app/finance/profit-loss/** | | |
| page.tsx | ScreenPage |  |
| ProfitLossShell.tsx | ProfitLossShell |  |
| **app/finance/subledger-tie-out/** | | |
| SubledgerTieShell.tsx | SubledgerTieShell |  |
| **app/finance/tax/report/** | | |
| page.tsx | TaxReportPage |  |
| TaxReportForm.tsx | TaxReportForm |  |
| **app/finance/trial-balance/** | | |
| TrialBalanceShell.tsx | TrialBalanceShell |  |
| **app/finance/vendor-ageing/export/** | | |
| route.ts | GET |  |
| **app/finance/vendor-balances/** | | |
| page.tsx | VendorBalancesPage |  |
| **app/finance/vendor-clearing/** | | |
| actions.ts | clearAction |  |
| page.tsx | VendorClearingPage |  |
| VendorClearing.tsx | VendorClearing |  |
| **app/finance/vendor-credit-memo/** | | |
| actions.ts | postMemoAction, cancelMemoAction |  |
| page.tsx | VendorCreditMemoPage |  |
| VendorCreditMemo.tsx | VendorCreditMemo |  |
| **app/finance/vendor-down-payment-clearing/** | | |
| actions.ts | postClearingAction |  |
| page.tsx | VendorDownPaymentClearingPage |  |
| VendorDownPaymentClearing.tsx | VendorDownPaymentClearing |  |
| **app/finance/vendor-down-payment-request/** | | |
| actions.ts | postVendorRequestAction |  |
| page.tsx | VendorDownPaymentRequestPage |  |
| VendorDownPaymentRequest.tsx | VendorDownPaymentRequest |  |
| **app/finance/vendor-down-payment/** | | |
| actions.ts | postDownPaymentAction |  |
| page.tsx | VendorDownPaymentPage |  |
| VendorDownPayment.tsx | VendorDownPayment |  |
| **app/finance/vendor-invoice/** | | |
| actions.ts | postInvoiceAction, cancelInvoiceAction |  |
| page.tsx | VendorInvoicePage |  |
| VendorInvoice.tsx | VendorInvoice |  |
| **modules/finance/** | | |
| accrual.ts | ACCRUAL_CAPABILITY, AccrualError, postAccrualDocument, getAccrualDocument, listDueAccruals, listAccrualDocuments, executeAccrualReversal | accounting_reversal_link, accrual_document, journal_entry, journal_entry_line, reversal_reason |
| ageing-derivation.ts | AgeingDerivationError, validateAgeingSelection, deriveAgeingItems, aggregateAgeingPartners | business_partner, customer_invoice, gl_account, journal_entry, journal_entry_line, payment_terms, special_gl_config, supplier_invoice, vendor_invoice |
| asset-acquisition.ts | ASSET_ACQUIRE_CAPABILITY, AssetAcquisitionError, ASSET_ACQUISITION_CLASS, simulateAssetAcquisition, recordAssetAcquisition, postAssetAcquisition, reverseAssetAcquisition, markAssetAcquisitionsReversedTx, getAssetTransactions | asset_class, asset_depreciation, asset_transaction, asset_transaction_type, document_type, fixed_asset, gl_account |
| asset-depreciation.ts | ASSET_DEPRECIATE_CAPABILITY, AssetDepreciationError, ASSET_DEPRECIATION_RUN_CLASS, executeDepreciationRun, listDepreciationRuns, getDepreciationRunItems, getPostedDepreciation | asset_assignment, asset_class, asset_depreciation, asset_depreciation_posting, asset_depreciation_run, asset_depreciation_run_item, asset_retirement, asset_transaction, depreciation_key, document_type, fiscal_year_period, fixed_asset, gl_account |
| asset-history.ts | ASSET_REPORT_CAPABILITY, AssetHistoryError, getAssetHistorySheet, assetHistoryCsv | asset_depreciation, asset_depreciation_posting, asset_retirement, asset_transaction, company_code, depreciation_area, fiscal_year_period, fixed_asset |
| asset-master.ts | ASSET_CREATE_CAPABILITY, ASSET_CHANGE_CAPABILITY, AssetMasterError, ASSET_CLASS, createAsset, changeAsset, changeAssetAssignment, changeAssetDepreciation, deactivateAsset, getAsset, listAssets | asset_assignment, asset_class, asset_depreciation, cost_center, depreciation_area, depreciation_key, fixed_asset, plant, profit_center |
| asset-retirement.ts | ASSET_RETIRE_CAPABILITY, AssetRetirementError, ASSET_RETIREMENT_CLASS, simulateAssetRetirement, postAssetRetirement, reverseAssetRetirement, getAssetRetirements, listRetireableAssets | asset_class, asset_depreciation_posting, asset_retirement, asset_transaction, asset_transaction_type, document_type, fixed_asset, gl_account |
| balance-sheet.ts | BALANCE_SHEET_CAPABILITY, BALANCE_CALCULATION_TYPES, DEFAULT_BALANCE_CALCULATION_TYPE, MIN_SUMMARY_LEVEL, MAX_SUMMARY_LEVEL, DEFAULT_SUMMARY_LEVEL, calculateBalanceSheet | exchange_rate, financial_statement_assignment, financial_statement_node, financial_statement_version, gl_account, journal_entry, journal_entry_line |
| carryforward.ts | CARRYFORWARD_CAPABILITY, CLOSE_LEDGERS, DEFAULT_LEDGER, RUN_STATUSES, RESULT_STATUSES, CarryforwardError, executeCarryforward, getCarryforwardRun, listCarryforwardRuns, listCarryforwardResults | account_determination, carryforward_result, carryforward_run, gl_account, journal_entry, journal_entry_line |
| cash-flow-vocabulary.ts | CASHFLOW_CAPABILITY, CASHFLOW_ROUTE, CASHFLOW_LEDGER, CASHFLOW_METHODS, CASHFLOW_METHOD_LABELS, ACCOUNT_CLASSES |  |
| cash-flow.ts | CashflowError, calculateCashflow, *./cash-flow-vocabulary | account_determination, asset_class, bank_account, company_code, fiscal_year_period, fiscal_year_variant, gl_account, journal_entry, journal_entry_line |
| chart-of-accounts-copy.ts | copyChartOfAccounts, listChartCopies | change_document, chart_of_accounts, gl_account, gl_account_group, gl_account_group_field_status, group_chart_accounts |
| clearing-reset.ts | CLEARING_RESET_CAPABILITY, ClearingResetError, getClearingDocument, resetClearingTx, resetClearing | clearing_reset, gl_clearing_allocation, gl_clearing_residual, journal_entry, journal_entry_line |
| close-cockpit.ts | CLOSE_COCKPIT_CAPABILITY, TASK_LIST_ID_MAX, TASK_ID_MAX, TASK_NAME_MAX, TASK_LIST_STATUSES, TASK_STATUSES, EXECUTION_MODES, EXECUTION_STATUSES, CLOSE_TASK_HANDLERS, CLOSE_TASK_HANDLER_CODES, CloseCockpitError, periodEndDate, findDependencyCycle, upsertTemplateTask, listTemplateTasks, createTaskListFromTemplate, getTaskList, listTaskLists, listTasks, listExecutions, listEvents, releaseTaskList, executeTask, processScheduledExecutions, attachEvidence, signOffTask, overrideTaskStatus, reopenTask, finalizeTaskList | closing_execution_log, closing_task_dependency, closing_task_event, closing_task_instance, closing_task_list, closing_task_template, closing_task_template_dependency, journal_entry |
| consolidated-statements-vocabulary.ts | CONSOLIDATED_STATEMENTS_CAPABILITY, CONSOLIDATED_STATEMENTS_ROUTE, STATEMENT_VIEWS, STATEMENT_VIEW_LABELS, STATEMENT_SECTIONS, SECTION_LABELS |  |
| consolidated-statements.ts | ConsolidatedStatementsError, calculateConsolidatedStatements, *./consolidated-statements-vocabulary | company_code, consolidation_account_mapping, consolidation_area, consolidation_group, consolidation_group_account, consolidation_task_status, consolidation_unit, consolidation_unit_assignment, consolidation_version, fiscal_year_period, fiscal_year_variant, gl_account, journal_entry, journal_entry_line |
| consolidation-monitor-vocabulary.ts | CONSOLIDATE_CAPABILITY, CONSOLIDATION_MONITOR_ROUTE, CONSOLIDATION_MONITOR_AUTHORITIES, EXECUTION_MODES, EXECUTION_MODE_LABELS, MONITOR_TASK_STATUSES, EXECUTION_STATUSES, ERROR_POLICIES, WARNING_POLICIES, SUPPORTED_TASK_TYPES |  |
| consolidation-monitor.ts | ConsolidationMonitorError, getConsolidationMonitor, executeConsolidationTask, executeConsolidationTaskGroup, cancelConsolidationExecution, CONSOLIDATE_CAPABILITY, *./consolidation-monitor-vocabulary | company_code, consolidation_account_mapping, consolidation_area, consolidation_execution, consolidation_execution_log, consolidation_group, consolidation_method, consolidation_task, consolidation_task_status, consolidation_unit, consolidation_unit_assignment, consolidation_version, fiscal_year_period, fiscal_year_variant, journal_entry, journal_entry_line |
| consolidation-vocabulary.ts | CONSOLIDATION_CAPABILITY, CONSOLIDATION_FOLDERS, DATA_PROVIDERS, METHOD_KINDS, TASK_TYPES |  |
| consolidation-workbench.ts | ConsolidationError, DIMENSION_SOURCES, listConsolidationAreas, getConsolidationWorkbench, saveDataBasis, saveArea, saveUnit, saveGroup, assignUnit, saveGroupAccount, saveMapping, saveMethod, saveVersion, saveTask, activateArea, *./consolidation-vocabulary | chart_of_accounts, company_code, consolidation_account_mapping, consolidation_area, consolidation_data_basis, consolidation_dimension, consolidation_group, consolidation_group_account, consolidation_method, consolidation_task, consolidation_unit, consolidation_unit_assignment, consolidation_version, fiscal_year_variant, gl_account |
| credit-control-area-contract.ts | CREDIT_CONTROL_AREA_ACTIVITY, CREDIT_CONTROL_AREA_LOCKS, CREDIT_CONTROL_AREA_DEFAULTS |  |
| credit-control-area-maintenance.ts | creditControlAreaSetupValuesSchema, filterCreditControlAreaSetupByCompanyScope, CreditControlAreaMaintenanceError, listCreditControlAreaSetup, createCreditControlAreaSetup, CREDIT_CONTROL_AREA_CAPABILITY, CREDIT_CONTROL_AREA_ACTIVITY, CREDIT_CONTROL_AREA_DEFAULTS | app_user, auth_org_restriction, company_code, credit_control_area, currency, role, role_capability, user_role, user_session |
| credit.ts | CREDIT_CAPABILITY, CREDIT_DECISIONS, CREDIT_BLOCK_REASONS, CreditError, getCreditExposure, getCustomerCredit, listCreditConfig, saveCustomerCredit, listCreditAudit, evaluateCreditCheck, CREDIT_MONITOR_CAPABILITY, listCreditMonitor, CREDIT_RELEASE_CAPABILITY, CREDIT_OVERRIDE_CAPABILITY, DETERMINATION_STATUSES, checkSalesDocumentCredit, listCreditDeterminations, recheckDocument, releaseDocument, releaseDocumentsBulk, rejectReleaseRequest, reblockDocument, listReleaseEvents | business_partner, company_code, credit_change_audit, credit_control_area, credit_determination, credit_release_event, currency, customer_credit, exchange_rate, journal_entry, journal_entry_line |
| customer-ageing.ts | CUSTOMER_AGEING_CAPABILITY, CustomerAgeingError, getCustomerAgeing |  |
| customer-balances.ts | CUSTOMER_BALANCE_CAPABILITY, CustomerBalanceError, getCustomerBalances | customer_company_code, journal_entry, journal_entry_line |
| customer-clearing.ts | CUSTOMER_CLEARING_CAPABILITY, CustomerClearingError, getCustomerClearing, clearCustomerItems | change_document, change_document_item, customer_company_code, journal_entry, journal_entry_line |
| customer-credit-memo.ts | CUSTOMER_CREDIT_MEMO_CAPABILITY, CustomerCreditMemoError, getCustomerCreditMemo, postCustomerCreditMemo | account_determination, billing_document, customer_company_code, customer_invoice, customer_invoice_line, payment_terms, profit_center, tax_code |
| customer-down-payment-clearing.ts | CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY, CustomerDownPaymentClearingError, getCustomerDownPaymentClearing, getCustomerDownPaymentClearingTx, clearCustomerDownPayments, clearCustomerDownPaymentsTx | customer_company_code, customer_down_payment, customer_down_payment_clearing, customer_down_payment_clearing_item, customer_invoice, journal_entry, journal_entry_line |
| customer-down-payment-request.ts | CUSTOMER_DOWN_PAYMENT_REQUEST_CAPABILITY, CustomerDownPaymentRequestError, resolveRequestTarget, createCustomerDownPaymentRequest, createCustomerDownPaymentRequestTx, fulfilledSoFar, getCustomerDownPaymentRequests, applyRequestFulfillment, reverseCustomerDownPaymentRequest, reverseCustomerDownPaymentRequestTx, downPaymentCreditLine | customer_company_code, customer_down_payment_request, document_type, down_payment_request_fulfillment, journal_entry_line, special_gl_config |
| customer-down-payment.ts | CUSTOMER_DOWN_PAYMENT_CAPABILITY, CustomerDownPaymentError, postCustomerDownPayment, getCustomerDownPayments | customer_company_code, customer_down_payment, journal_entry_line |
| customer-invoice.ts | CUSTOMER_INVOICE_CAPABILITY, CustomerInvoiceError, getCustomerInvoice, listCustomerInvoiceTaxCodes, postCustomerInvoice, cancelCustomerInvoice | account_determination, customer_company_code, customer_invoice, customer_invoice_line, payment_terms, profit_center, tax_code |
| document-display.ts | DOCUMENT_FLOW_CAPABILITY, FIN_JOURNAL_DISPLAY_CAPABILITY, DocumentDisplayError, getJournalDocument, resolveDocumentNumber | customer_company_code, journal_entry, journal_entry_line, parked_journal_header, supplier_company_code |
| document-reversal.ts | DOCUMENT_REVERSE_CAPABILITY, DocumentReversalError, getDocumentForReversal, reverseDocument | accounting_reversal_link, journal_entry, journal_entry_line, reversal_reason |
| dunning.ts | DUNNING_CAPABILITY, DunningError, getDunningRun, listDunningRuns, proposeDunningRun, excludeDunningAccount, finalizeDunningRun, cancelDunningRun | customer_company_code, customer_invoice, dunning_notice, dunning_run, dunning_run_account, dunning_run_company, dunning_run_item, journal_entry, journal_entry_line |
| fx-valuation.ts | FX_VALUATION_CAPABILITY, FxValuationError, FX_RATE_TYPES, executeFxValuation, getFxValuationRun, fxValuationCsv | account_determination, exchange_rate, fx_valuation_item, fx_valuation_run, gl_account, journal_entry, journal_entry_line |
| gl-account-group-maintenance.ts | accountGroupValuesSchema, accountGroupMaintenanceInputSchema, accountGroupLifecycleInputSchema, accountGroupFieldStatusInputSchema, GlAccountGroupMaintenanceError, listAccountGroups, accountGroupFieldStatusMatrices, accountGroupChoices, groupAccountChoices, saveAccountGroup, setAccountGroupActive, saveAccountGroupFieldStatus | chart_of_accounts, gl_account, gl_account_group, gl_account_group_field_status, group_chart_accounts |
| gl-account-group-schema.ts | glAccountGroup, glAccountGroupFieldStatus, groupChartAccounts, ACCOUNT_TYPES, FIELD_STATUSES, GL_ACCOUNT_FIELDS, GL_ACCOUNT_TYPES, RECONCILIATION_TYPES, SUPPORTED_LANGUAGE_KEYS | gl_account_group, gl_account_group_field_status, group_chart_accounts |
| gl-account-transfer.ts | GL_ACCOUNT_TRANSFER_CAPABILITY, GlAccountTransferError, listAccountSegments, transferGlAccounts | gl_account, gl_account_company, gl_account_transfer_result, gl_account_transfer_run |
| gl-account-vocabulary.ts | GL_ACCOUNT_FIELDS, FIELD_STATUSES, ACCOUNT_TYPES, GL_ACCOUNT_TYPES, RECONCILIATION_TYPES, SUPPORTED_LANGUAGE_KEYS, DEFAULT_LANGUAGE_KEY, DEFAULT_SORT_KEY, deriveGlAccountType, deriveIsBalanceSheet, isBalanceSheetAccountType, accountNumberInRange, DEFAULT_FIELD_STATUS, resolveFieldStatus, STORAGE_MANDATORY_FIELDS, GL_ACCOUNT_FIELD_LABELS | client |
| gl-balances.ts | GL_BALANCE_CAPABILITY, GlBalanceError, getGlBalances, getGlBalanceReport | exchange_rate, gl_account, journal_entry, journal_entry_line |
| gl-clearing.ts | GL_CLEARING_CAPABILITY, GlClearingError, getGlClearing, clearGlItems | account_determination, change_document, change_document_item, customer_invoice, document_type, employee_tolerance_group, exchange_rate, gl_account, gl_account_company, gl_clearing_allocation, gl_clearing_residual, journal_entry, journal_entry_line, residual_reason, supplier_invoice, vendor_invoice |
| gl-document.ts | GL_DOCUMENT_CAPABILITY, GlDocumentError, postGlDocument | cost_center, document_type, gl_account, gl_account_company, internal_order, journal_entry, journal_entry_line, journal_posting_request, profit_center |
| grir-reclass.ts | GRIR_RECLASS_CAPABILITY, GrIrReclassError, executeGrIrAnalysis, getGrIrRun, grIrCsv | account_determination, grir_reclass_item, grir_reclass_run, material_document, material_document_line, movement_type, purchase_order, purchase_order_item, supplier_invoice, supplier_invoice_item |
| incoming-payment.ts | IncomingPaymentError, getReceivables, INCOMING_PAYMENT_CAPABILITY, postIncomingPayment | account_determination, customer_company_code, customer_invoice, employee_tolerance_group, incoming_payment, journal_entry, journal_entry_line, payment_terms |
| intercompany.ts | INTERCOMPANY_CAPABILITY, INTERCOMPANY_CONFIG_CAPABILITY, IntercompanyError, listIntercompanyConfigs, saveIntercompanyConfig, deleteIntercompanyConfig, postIntercompany, listCompanyChoices | change_document, change_document_item, company_code, document_type, exchange_rate, gl_account, gl_account_company, intercompany_clearing_config, intercompany_document_header, journal_entry_line |
| journal-items.ts | JOURNAL_ITEMS_CAPABILITY, JournalItemsError, JOURNAL_ITEMS_CAP, getJournalItems, JOURNAL_ITEM_PAGE_SIZES, DEFAULT_ITEMS_PAGE_SIZE | gl_account, gl_account_company, journal_entry, journal_entry_line |
| ledger-journal.ts | LEDGER_JOURNAL_STATUSES, ledgerJournalStatus |  |
| outgoing-payment.ts | OUTGOING_PAYMENT_CAPABILITY, OutgoingPaymentError, getPayables, postOutgoingPayment | account_determination, employee_tolerance_group, journal_entry, journal_entry_line, outgoing_payment, payment_terms, supplier_company_code, vendor_invoice |
| parked-journal-release.ts | JOURNAL_RELEASE_CATEGORY, JOURNAL_RELEASE_CAPABILITY, parkedJournalAttributes, syncParkedJournalRelease, assertParkedJournalReleased, getParkedJournalRelease, releaseParkedJournal, cancelParkedJournalRelease | parked_journal_header, parked_journal_line |
| parked-journal.ts | PARKED_JOURNAL_CAPABILITY, ParkedJournalError, parkJournal, editParkedJournal, completeParkedJournal, postParkedJournal, deleteParkedJournal, listParkedJournals, getParkedJournal | cost_center, document_type, gl_account, parked_journal_header, parked_journal_line, profit_center, tax_code |
| payment-run-background.ts | PAYMENT_PROPOSAL_JOB, PAYMENT_EXECUTE_JOB, submitPaymentProposal, submitPaymentExecution, cancelPaymentOperation, listPaymentOperations, getPaymentOperation, runPaymentProposalChunk, runPaymentExecuteChunk | bank_account, job_run, payment_proposal_item, payment_proposal_stage, payment_run, payment_run_operation, supplier_company_code |
| payment-run-release.ts | PAYMENT_RUN_RELEASE_CATEGORY, PAYMENT_RUN_RELEASE_CAPABILITY, paymentRunReleaseKey, paymentRunAttributes, syncPaymentRunRelease, assertPaymentRunReleased, getPaymentRunRelease, releasePaymentRun, cancelPaymentRunRelease | payment_run |
| payment-run.ts | PAYMENT_RUN_CAPABILITY, RUN_CLASS, PaymentRunError, round2, runKey, activePaymentOperation, assertNoActivePaymentOperation, loadRun, getPaymentRun, listPaymentRuns, listBankChoices, createPaymentRun, openItems, supplierMethods, generateProposal, executePaymentRun, cancelPaymentRun | bank_account, house_bank, journal_entry, journal_entry_line, payment_document, payment_method, payment_proposal_item, payment_run, payment_run_company, payment_run_method, payment_run_operation, supplier_company_code, supplier_invoice |
| profit-loss.ts | PROFIT_LOSS_CAPABILITY, calculateProfitLoss, TrialBalanceError |  |
| report-exports.ts | trialBalanceExport, balanceSheetExport, profitLossExport, vendorBalancesExport, customerBalancesExport, vendorAgeingExport, customerAgeingExport, journalItemsExport, glBalancesExport, cashFlowExport, consolidatedStatementsExport, assetHistoryExport, grIrExport, FINANCE_REPORT_EXPORTS |  |
| schema.ts | glAccount, journalEntry, journalEntryLine, journalPostingRequest, taxReturnRun, fxValuationRun, fxValuationItem, grirReclassRun, grirReclassItem, accrualDocument, closingTaskTemplate, closingTaskTemplateDependency, closingTaskList, closingTaskInstance, closingTaskDependency, closingExecutionLog, closingTaskEvent, carryforwardRun, carryforwardResult, paymentRun, paymentRunOperation, paymentProposalStage, paymentRunCompany, paymentRunMethod, paymentProposalItem, paymentDocument, outgoingPayment, vendorDownPayment, vendorDownPaymentClearing, customerDownPayment, customerDownPaymentClearing, customerDownPaymentClearingItem, customerDownPaymentRequest, downPaymentRequestFulfillment, vendorDownPaymentRequest, vendorDpRequestFulfillment, assetClass, depreciationArea, depreciationKey, fixedAsset, assetAssignment, assetDepreciation, assetTransactionType, assetTransaction, assetRetirement, assetDepreciationRun, assetDepreciationRunItem, assetDepreciationPosting, parkedJournalHeader, parkedJournalLine, incomingPayment, reversalReason, accountingReversalLink, clearingReset, dunningRun, dunningRunCompany, dunningRunAccount, dunningRunItem, dunningNotice, vendorInvoice, vendorInvoiceLine, creditRiskCategory, creditRepresentativeGroup, customerCreditGroup, creditBlockReason, customerCredit, creditChangeAudit, creditDetermination, creditReleaseEvent, financialStatementVersion, financialStatementNode, financialStatementAssignment, glAccountCompany, glAccountTransferRun, glAccountTransferResult, consolidationDataBasis, consolidationDimension, consolidationArea, consolidationUnit, consolidationGroup, consolidationUnitAssignment, consolidationGroupAccount, consolidationAccountMapping, consolidationMethod, consolidationVersion, consolidationTask, consolidationExecution, consolidationExecutionLog, consolidationTaskStatus, residualReason, glClearingAllocation, glClearingResidual, intercompanyClearingConfig, intercompanyDocumentHeader | accounting_reversal_link, accrual_document, asset_assignment, asset_class, asset_depreciation, asset_depreciation_posting, asset_depreciation_run, asset_depreciation_run_item, asset_retirement, asset_transaction, asset_transaction_type, carryforward_result, carryforward_run, clearing_reset, closing_execution_log, closing_task_dependency, closing_task_event, closing_task_instance, closing_task_list, closing_task_template, closing_task_template_dependency, consolidation_account_mapping, consolidation_area, consolidation_data_basis, consolidation_dimension, consolidation_execution, consolidation_execution_log, consolidation_group, consolidation_group_account, consolidation_method, consolidation_task, consolidation_task_status, consolidation_unit, consolidation_unit_assignment, consolidation_version, credit_block_reason, credit_change_audit, credit_determination, credit_release_event, credit_representative_group, credit_risk_category, customer_credit, customer_credit_group, customer_down_payment, customer_down_payment_clearing, customer_down_payment_clearing_item, customer_down_payment_request, depreciation_area, depreciation_key, down_payment_request_fulfillment, dunning_notice, dunning_run, dunning_run_account, dunning_run_company, dunning_run_item, financial_statement_assignment, financial_statement_node, financial_statement_version, fixed_asset, fx_valuation_item, fx_valuation_run, gl_account, gl_account_company, gl_account_transfer_result, gl_account_transfer_run, gl_clearing_allocation, gl_clearing_residual, grir_reclass_item, grir_reclass_run, incoming_payment, intercompany_clearing_config, intercompany_document_header, journal_entry, journal_entry_line, journal_posting_request, outgoing_payment, parked_journal_header, parked_journal_line, payment_document, payment_proposal_item, payment_proposal_stage, payment_run, payment_run_company, payment_run_method, payment_run_operation, residual_reason, reversal_reason, tax_return_run, vendor_down_payment, vendor_down_payment_clearing, vendor_down_payment_request, vendor_dp_request_fulfillment, vendor_invoice, vendor_invoice_line |
| subledger-tie-out.ts | SUBLEDGER_TIE_CAPABILITY, TIE_LEDGER, SubledgerTieError, calculateSubledgerTie | company_code, customer_company_code, gl_account, journal_entry, journal_entry_line, supplier_company_code |
| tax-report.ts | TAX_REPORT_CAPABILITY, TaxReportError, executeTaxReport, listTaxReturnRuns | account_determination, company_code, document_type, journal_entry, journal_entry_line, tax_code, tax_return_run |
| trial-balance.ts | TRIAL_BALANCE_CAPABILITY, STATEMENT_LEDGERS, TrialBalanceError, calculateTrialBalance, listStatementVersions | exchange_rate, financial_statement_assignment, financial_statement_node, financial_statement_version, gl_account, journal_entry, journal_entry_line |
| vendor-ageing.ts | VENDOR_AGEING_CAPABILITY, VendorAgeingError, getVendorAgeing, vendorAgeingCsv |  |
| vendor-balances.ts | VENDOR_BALANCE_CAPABILITY, VendorBalanceError, getVendorBalances | journal_entry, journal_entry_line, supplier_company_code |
| vendor-clearing.ts | VENDOR_CLEARING_CAPABILITY, VendorClearingError, getVendorClearing, clearVendorItems | journal_entry, journal_entry_line, supplier_company_code |
| vendor-credit-memo.ts | VENDOR_CREDIT_MEMO_CAPABILITY, VendorCreditMemoError, getVendorCreditMemo, postVendorCreditMemo | account_determination, cost_center, payment_terms, profit_center, supplier_company_code, tax_code, vendor_invoice, vendor_invoice_line |
| vendor-down-payment-clearing.ts | VENDOR_DOWN_PAYMENT_CLEARING_CAPABILITY, VendorDownPaymentClearingError, getDownPaymentClearingTx, getDownPaymentClearing, getOrderAdvances, clearDownPaymentsTx, clearDownPayments | journal_entry, journal_entry_line, purchase_order, supplier_company_code, vendor_down_payment, vendor_down_payment_clearing, vendor_invoice |
| vendor-down-payment-request.ts | VENDOR_DOWN_PAYMENT_REQUEST_CAPABILITY, VendorDownPaymentRequestError, resolveRequestTarget, createVendorDownPaymentRequest, fulfilledSoFar, getVendorDownPaymentRequests, applyVendorRequestFulfillment, downPaymentDebitLine | document_type, journal_entry_line, special_gl_config, supplier_company_code, vendor_down_payment_request, vendor_dp_request_fulfillment |
| vendor-down-payment.ts | VENDOR_DOWN_PAYMENT_CAPABILITY, VendorDownPaymentError, resolveSpecialGlAccount, judgeAdvanceOrder, postVendorDownPayment, getVendorDownPayments | journal_entry_line, purchase_order, special_gl_config, supplier_company_code, vendor_down_payment, vendor_down_payment_request |
| vendor-invoice.ts | VENDOR_INVOICE_CAPABILITY, VendorInvoiceError, getVendorInvoice, listVendorInvoiceTaxCodes, postVendorInvoice, cancelVendorInvoice | account_determination, cost_center, payment_terms, profit_center, supplier_company_code, tax_code, vendor_invoice, vendor_invoice_line |
| walkthrough-credit-preflight.ts | readWalkthroughCreditPrerequisiteSnapshot, walkthroughCreditPrerequisiteError | company_code, credit_control_area |
| **modules/finance/jobs/** | | |
| payment-run.ts | paymentProposalJob, paymentExecuteJob |  |

## Routes (61)
`/config/chart-of-accounts` · `/config/chart-of-accounts/copy` · `/config/consolidation` · `/config/credit-control-areas` · `/config/fiscal-year-variants` · `/config/fiscal-year-variants/assign-company-codes` · `/config/gl-accounts` · `/config/gl-accounts/edit` · `/config/gl-accounts/new` · `/config/gl-accounts/transfer` · `/config/gl-accounts/view` · `/config/intercompany-clearing` · `/finance/assets` · `/finance/assets/acquire` · `/finance/assets/change` · `/finance/assets/depreciate` · `/finance/assets/history` · `/finance/assets/history/export` · `/finance/assets/new` · `/finance/assets/retire` · `/finance/balance-sheet` · `/finance/cash-flow` · `/finance/clearing-reset` · `/finance/consolidated-statements` · `/finance/consolidation-monitor` · `/finance/credit-monitor` · `/finance/credit-release` · `/finance/credit` · `/finance/customer-ageing` · `/finance/customer-balances` · `/finance/customer-clearing` · `/finance/customer-down-payment-clearing` · `/finance/customer-down-payment-request` · `/finance/customer-down-payment` · `/finance/customer-invoice` · `/finance/document-reversal` · `/finance/dunning` · `/finance/fx/valuation` · `/finance/fx/valuation/export` · `/finance/gl-clearing` · `/finance/grir-reclass` · `/finance/grir-reclass/export` · `/finance/incoming-payment` · `/finance/intercompany` · `/finance/journal` · `/finance/journal/balances` · `/finance/journal/document` · `/finance/journal/items` · `/finance/journal/park` · `/finance/outgoing-payment` · `/finance/payment-run` · `/finance/profit-loss` · `/finance/tax/report` · `/finance/vendor-ageing/export` · `/finance/vendor-balances` · `/finance/vendor-clearing` · `/finance/vendor-credit-memo` · `/finance/vendor-down-payment-clearing` · `/finance/vendor-down-payment-request` · `/finance/vendor-down-payment` · `/finance/vendor-invoice`

## Tables owned (97)
accounting_reversal_link, accrual_document, asset_assignment, asset_class, asset_depreciation, asset_depreciation_posting, asset_depreciation_run, asset_depreciation_run_item, asset_retirement, asset_transaction, asset_transaction_type, carryforward_result, carryforward_run, clearing_reset, closing_execution_log, closing_task_dependency, closing_task_event, closing_task_instance, closing_task_list, closing_task_template, closing_task_template_dependency, consolidation_account_mapping, consolidation_area, consolidation_data_basis, consolidation_dimension, consolidation_execution, consolidation_execution_log, consolidation_group, consolidation_group_account, consolidation_method, consolidation_task, consolidation_task_status, consolidation_unit, consolidation_unit_assignment, consolidation_version, credit_block_reason, credit_change_audit, credit_determination, credit_release_event, credit_representative_group, credit_risk_category, customer_credit, customer_credit_group, customer_down_payment, customer_down_payment_clearing, customer_down_payment_clearing_item, customer_down_payment_request, depreciation_area, depreciation_key, down_payment_request_fulfillment, dunning_notice, dunning_run, dunning_run_account, dunning_run_company, dunning_run_item, financial_statement_assignment, financial_statement_node, financial_statement_version, fixed_asset, fx_valuation_item, fx_valuation_run, gl_account, gl_account_company, gl_account_group, gl_account_group_field_status, gl_account_transfer_result, gl_account_transfer_run, gl_clearing_allocation, gl_clearing_residual, grir_reclass_item, grir_reclass_run, group_chart_accounts, incoming_payment, intercompany_clearing_config, intercompany_document_header, journal_entry, journal_entry_line, journal_posting_request, outgoing_payment, parked_journal_header, parked_journal_line, payment_document, payment_proposal_item, payment_proposal_stage, payment_run, payment_run_company, payment_run_method, payment_run_operation, residual_reason, reversal_reason, tax_return_run, vendor_down_payment, vendor_down_payment_clearing, vendor_down_payment_request, vendor_dp_request_fulfillment, vendor_invoice, vendor_invoice_line

## Depends on
foundation, output, platform/auth, platform/change, platform/db, platform/i18n, platform/job, platform/lock, platform/notification, platform/numbering, platform/periods, platform/posting, platform/tables, platform/tenancy, purchasing, sales, ui/fields, ui/lock, ui/output, ui/release

## Used by
dev/walkthrough-asset.ts, dev/walkthrough-volume.ts, foundation, inventory, output, people, platform/attention, platform/posting, platform/tenancy, production, purchasing, sales

## Tests (104)
accrual, asset-acquisition, asset-depreciation, asset-history, asset-master, asset-retirement, balance-sheet, blocked-invoice, carryforward, cash-flow, clearing-reset, close-cockpit, consolidated-statements, consolidation-monitor, consolidation-workbench, controlling-settlement-reversal-contract, cost-allocation-cycle, cost-allocation-distribution, cost-center-report, credit-control-area-atomicity, credit-control-area-maintenance, credit-control-area-validation, credit-monitor, credit-notification, credit-release, credit, customer-ageing, customer-balances, customer-clearing, customer-credit-memo, customer-down-payment-clearing, customer-down-payment-request, customer-down-payment, customer-invoice, document-display-contract, document-display, document-reversal, dunning, finance-release, fx-valuation, gl-account-transfer, gl-balances, gl-clearing, gl-document, gl-reporting-completion, gl-reporting-suite, grir-reclass, incoming-payment-completion, incoming-payment, intercompany, internal-order-cost-report, internal-order, invoice-account-assignment, invoice-advance-clearing, journal-document-display, journal-items, material-document-reversal-accounting, material-sales, outgoing-payment-completion, outgoing-payment, parked-journal, payment-run-background, payment-run, payroll-posting, profit-center-report, profit-loss, purchase-order-advance, salary-payment, sales-analysis, sales-availability, sales-batch-determination, sales-billing-plan, sales-collective-billing, sales-delivery-terms, sales-delivery, sales-document-type-maintenance, sales-down-payment, sales-incompletion, sales-invoice-list, sales-order-progress, sales-order, sales-output, sales-partners, sales-pricing-chain, sales-pricing-procedure, sales-quotation, sales-rebate, sales-registers, sales-serial-numbers, sales-shipping-point, statement-version-onboarding, subledger-tie-out, tax-report, trial-balance, vendor-ageing, vendor-balances, vendor-clearing, vendor-credit-memo, vendor-down-payment-clearing, vendor-down-payment-request, vendor-down-payment, vendor-invoice, walkthrough-credit-preflight, walkthrough-seed-contract
