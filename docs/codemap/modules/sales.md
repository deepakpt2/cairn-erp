# Sales
Sales orders, pricing procedures, delivery & shipping points, billing (plans, collective, invoice lists, down payments), rebates, returns & credit memos/requests, incompletion, output, registers/analysis, batch & serial determination. Routes: `/sales/*`, `/config/{batch-determination,billing-split,incompletion,pricing-procedure,sales-account-determination,sales-document-types,sales-returns,shipping-points}`. Paths relative to `src/`; tables are SQL names.

## Gotchas
- No counters: delivered/billed/exposure summed live (`fulfillment-quantities.ts`, `exposure.ts`); returns (LR/RE) excluded.
- Billing is two-stage: row OPEN before `postCustomerInvoice`, POSTED only via `linkPostedInvoice` (retryable).
- Credit checked at delivery creation, pick and goods issue. One delivery = one plant.
- `/sales/credit-memo` is finance code (`finance/customer-credit-memo`); the sales G2/CR flow is `/sales/credit-memo-request`.
- Import cycles: `sales/credit-memo` ↔ `finance/customer-credit-memo` ↔ `sales/partners`; `sales/delivery` ↔ inventory reversal.
- `rebate.ts` posts accruals directly via `platform/posting.postJournalEntry`.
- Invoice lists use type `IL` (constant wins over the header comment). Document types are rows (9226).
- `batch-sort-rules.ts` exists to keep `postgres` out of the client bundle.
- ATP (`availability.ts`): `availableToPromise` counts stock, the scope's supply elements (MD04 rows, base unit, by date) and other orders' promises (unless scope `sales_requirements` is blank); `planOrderLines` decides quantity AND date; the order rule is the document type's `availability_check_rule`, blank = `OR` (never "no check"). A material with no group is confirmed in full.
- `availability-check.ts` is the on-demand check: simulate (writes nothing) vs check (writes line + schedule + change document); an unconfigured line is reported, not thrown.
- Demo phase `D17_SALES_AVAILABILITY`: group D1 on TRAD-JUICE at plant 2000 only; no document type names a rule.
- Quotation (`quotation.ts`, tables `sales_quotation*`): its own tables because `availableToPromise` counts promises through `sales_order_schedule`; it plans with `planOrderLines` but writes `sales_quotation_schedule` only. No credit, incompletion or output. Expiry is computed on read (`isExpired`), never written. Copy = `createSalesOrder` with reference `AG` + number; prices are re-determined on the order date. Conditions/partners category `QUOTATION`. Change documents use `CHANGE` (no `UPDATE` type). Demo phase `D18_SALES_QUOTATION`.

## Files (105)
| file | exports | tables |
|---|---|---|
| **app/config/batch-determination/** | | |
| actions.ts | saveBatchRuleAction |  |
| BatchDetermination.tsx | BatchDetermination |  |
| page.tsx | BatchDeterminationPage |  |
| **app/config/billing-split/** | | |
| actions.ts | setSplitCriterionAction |  |
| BillingSplit.tsx | BillingSplit |  |
| page.tsx | BillingSplitPage |  |
| **app/config/incompletion/** | | |
| actions.ts | saveIncompletionStatusGroupAction, changeIncompletionStatusGroupAction, saveIncompletionProcedureAction, saveIncompletionProcedureFieldAction, withdrawIncompletionProcedureFieldAction, assignIncompletionProcedureAction, withdrawIncompletionAssignmentAction |  |
| IncompletionSetup.tsx | IncompletionSetup |  |
| page.tsx | IncompletionPage |  |
| **app/config/pricing-procedure/** | | |
| actions.ts | defineConditionTypeAction, changeConditionTypeAction, defineProcedureAction, changeProcedureAction, addStepAction, changeStepAction, defineDeterminationAction, changeDeterminationAction |  |
| page.tsx | PricingProcedurePage |  |
| PricingProcedureSetup.tsx | PricingProcedureSetup |  |
| **app/config/sales-account-determination/** | | |
| actions.ts | defineAccountDeterminationAction, changeAccountDeterminationAction |  |
| page.tsx | SalesAccountDeterminationPage |  |
| SalesAccountDeterminationSetup.tsx | SalesAccountDeterminationSetup |  |
| **app/config/sales-document-types/** | | |
| actions.ts | defineDocumentTypeAction, changeDocumentTypeAction, setDocumentTypeActiveAction |  |
| page.tsx | SalesDocumentTypesPage |  |
| SalesDocumentTypeSetup.tsx | SalesDocumentTypeSetup |  |
| **app/config/sales-returns/** | | |
| actions.ts | saveReturnsConfigurationAction |  |
| page.tsx | SalesReturnsConfigurationPage |  |
| ReturnsChainSetup.tsx | ReturnsChainSetup |  |
| **app/config/shipping-points/** | | |
| actions.ts | defineShippingPointAction, changeShippingPointAction, defineShippingConditionAction, changeShippingConditionAction, assignShippingPointAction, changeShippingPointAssignmentAction |  |
| page.tsx | ShippingPointsPage |  |
| ShippingConditionSetup.tsx | ShippingConditionSetup |  |
| ShippingPointAssignmentSetup.tsx | ShippingPointAssignmentSetup |  |
| ShippingPointSetup.tsx | ShippingPointSetup |  |
| **app/sales/analysis/** | | |
| page.tsx | SalesAnalysisPage |  |
| **app/sales/billing-plans/** | | |
| actions.ts | saveBillingPlanAction |  |
| BillingPlans.tsx | BillingPlans |  |
| page.tsx | SalesBillingPlansPage |  |
| **app/sales/billing/** | | |
| actions.ts | createBillingAction, billDueListAction, billPlanDateAction, cancelBillingAction, requestDownPaymentAction, cancelDownPaymentAction, rebillDeliveryAction |  |
| Billing.tsx | Billing |  |
| page.tsx | SalesBillingPage |  |
| **app/sales/conditions/** | | |
| actions.ts | saveConditionAction |  |
| Conditions.tsx | Conditions |  |
| page.tsx | SalesConditionsPage |  |
| **app/sales/credit-memo-request/** | | |
| actions.ts | createCreditMemoRequestAction, releaseBillingBlockAction, createCreditMemoAction, postCreditMemoAction |  |
| CreditMemoRequest.tsx | CreditMemoRequest |  |
| page.tsx | SalesCreditMemoRequestPage |  |
| **app/sales/credit-memo/** | | |
| actions.ts | postCreditMemoAction, cancelCreditMemoAction |  |
| CreditMemo.tsx | CreditMemo |  |
| page.tsx | SalesCreditMemoPage |  |
| **app/sales/delivery/** | | |
| actions.ts | createDeliveryAction, confirmPicksAction, postGoodsIssueAction, cancelDeliveryAction, releaseDeliveryCreditAction |  |
| Delivery.tsx | Delivery |  |
| page.tsx | SalesDeliveryPage |  |
| **app/sales/documents/** | | |
| page.tsx | SalesDocumentsPage |  |
| **app/sales/incomplete/** | | |
| page.tsx | IncompleteDocumentsPage |  |
| **app/sales/invoice-lists/** | | |
| actions.ts | createInvoiceListAction, releaseInvoiceListAction, cancelInvoiceListAction |  |
| InvoiceLists.tsx | InvoiceLists |  |
| page.tsx | SalesInvoiceListsPage |  |
| **app/sales/orders/** | | |
| actions.ts | createOrderAction, changeOrderAction, cancelOrderAction, releaseCreditAction |  |
| availability-actions.ts | simulateAvailabilityAction, confirmAvailabilityAction |  |
| AvailabilityPanel.tsx | AvailabilityPanel |  |
| Orders.tsx | ItemGrid, Orders |  |
| page.tsx | SalesOrdersPage |  |
| **app/sales/output/** | | |
| actions.ts | runSalesOutputAction, dispatchSalesOutputAction, reissueSalesOutputAction, setSalesOutputRecipientAction, saveOutputConditionAction, setOutputConditionStatusAction, downloadSalesOutputPdfAction |  |
| page.tsx | SalesOutputPage |  |
| SalesOutput.tsx | SalesOutput |  |
| **app/sales/quotations/** | | |
| actions.ts | createQuotationAction, changeQuotationAction, rejectQuotationAction, createOrderFromQuotationAction, downloadQuotationPdfAction |  |
| page.tsx | SalesQuotationsPage |  |
| Quotations.tsx | Quotations |  |
| **app/sales/rebate-agreements/** | | |
| actions.ts | saveRebateAgreementAction, releaseRebateAgreementAction, settleRebateAgreementAction |  |
| page.tsx | SalesRebateAgreementsPage |  |
| RebateAgreements.tsx | RebateAgreements |  |
| **app/sales/returns/** | | |
| actions.ts | createReturnsOrderAction, createReturnsDeliveryAction, receiveReturnsDeliveryAction |  |
| page.tsx | SalesReturnsPage |  |
| Returns.tsx | Returns |  |
| **modules/sales/** | | |
| account-determination-maintenance.ts | ACCOUNT_DETERMINATION_CAPABILITY, ACCOUNT_DETERMINATION_OBJECT_CLASS, AccountDeterminationMaintenanceError, listAccountDetermination, defineAccountDetermination, changeAccountDeterminationStatus | chart_of_accounts, gl_account, sales_account_determination, sales_org |
| account-determination.ts | ACCOUNT_DETERMINATION_ROUTE, ACCOUNT_KEYS, DELIVERED_ACCOUNT_DETERMINATION, SalesAccountDeterminationError, determineSalesAccount, determineLineAccounts | sales_account_determination |
| analysis.ts | ANALYSIS_KINDS, ANALYSIS_KIND_MEANING, GROUP_BY, GROUP_BY_MEANING, PERIODS, ANALYSIS_LIMIT, listAnalysis | billing_document, billing_document_line, business_partner, delivery, delivery_line, material, sales_area, sales_condition_type, sales_document_condition, sales_document_type, sales_order, sales_order_line, sales_returns_configuration |
| availability-check.ts | AVAILABILITY_CHECK_CAPABILITY, AVAILABILITY_CHECK_ROUTE, SalesAvailabilityError, simulateSalesOrderAvailability, checkSalesOrderAvailability | sales_order, sales_order_line, sales_order_schedule |
| availability.ts | AVAILABILITY_ROUTE, ORDER_CHECKING_RULE, DELIVERY_CHECKING_RULE, AvailabilityError, DEFAULT_HORIZON_DAYS, availableAt, availableToPromise, planOrderLines, confirmOrderLines, writeScheduleLines, scheduleLinesOf | availability_check_scope, availability_checking_group, availability_checking_rule, delivery, delivery_line, material_plant, material_sales, sales_order, sales_order_line, sales_order_schedule, stock_quantity |
| batch-determination.ts | BATCH_DETERMINATION_ROUTE, BATCH_DETERMINATION_CAPABILITY, batchRuleInput, BatchDeterminationError, saveBatchDeterminationRule, listBatchDeterminationRules, determineBatches, determineBatchesOn, determineBatchesForDelivery, SORT_RULES, SORT_RULE_MEANING | batch, stock_quantity |
| batch-sort-rules.ts | SORT_RULES, SORT_RULE_MEANING |  |
| billing-plan.ts | BILLING_PLAN_ROUTE, BILLING_PLAN_CAPABILITY, BILLING_PLAN_OBJECT_CLASS, BillingPlanError, billingPlanDateInput, billingPlanSaveInput, itemKey, plansForItems, planTypeChoices, getBillingPlan, listBillingPlans, listBillablePlanDates, loadBillablePlanDate, saveBillingPlan, markPlanDateBilled, releasePlanDateForBilling | sales_billing_plan, sales_billing_plan_date, sales_billing_plan_type, sales_order, sales_order_line |
| billing.ts | BILLING_CAPABILITY, BILLING_CANCEL_CAPABILITY, BILLING_ROUTE, BILLING_OBJECT_CLASS, BILLING_SPLIT_ROUTE, SPLIT_DEFINE_CAPABILITY, REVENUE_EVENT, BillingError, billingCreateInput, billingCancelInput, listSplitCriteria, saveSplitCriterion, setSplitCriterionStatus, groupDueList, billDueList, billingPlanDateBillingInput, getBilling, billingDueList, listBillableDeliveries, listBillings, chartOfAccountsFor, revenueAccountFor, INVOICE_LIST_SCHEDULES, SALES_BILLING_CREATE_CAPABILITY, createBillingFromDelivery, createBillingFromPlanDate, linkPostedInvoice, postBillingDocument, cancelBillingDocument, salesDocumentFlow, goodsIssueStands | account_determination, billing_document, billing_document_line, company_code, customer_sales_area, delivery, delivery_line, incompletion_status_group, material_document_line, material_sales, sales_billing_plan, sales_billing_plan_date, sales_billing_split_criterion, sales_document_partner, sales_document_type, sales_incompletion_log, sales_order, sales_order_line |
| conditions.ts | CONDITION_CAPABILITY, CONDITION_OBJECT_CLASS, CONDITION_ROUTE, CONDITION_ALIASES, ConditionError, conditionInput, saveSalesCondition, listSalesConditions | bp_role, business_partner, currency, material, sales_area, sales_condition_record, sales_condition_type |
| credit-memo.ts | CREDIT_MEMO_TRANSACTION, CREDIT_MEMO_ROUTE, CREDIT_MEMO_REQUEST_CAPABILITY, CREDIT_MEMO_RELEASE_CAPABILITY, CREDIT_MEMO_POST_CAPABILITY, CreditMemoError, createCreditMemo, postCreditMemo, createCreditMemoRequest, releaseBillingBlock, listCreditMemoRequests | billing_document, billing_document_line, sales_order, sales_order_line |
| delivering-plant.ts | CUSTOMER_MASTER_ROUTE, MATERIAL_MASTER_ROUTE, DeliveringPlantError, deliveryTermsFor, deliveringPlantFor | customer_sales_area, material_sales |
| delivery.ts | DELIVERY_CAPABILITY, DELIVERY_PICK_CAPABILITY, DELIVERY_GOODS_ISSUE_CAPABILITY, DELIVERY_ROUTE, DELIVERY_OBJECT_CLASS, DELIVERY_GOODS_ISSUE_MOVEMENT, DeliveryError, deliveryItemInput, deliveryCreateInput, deliveryPickItemInput, deliveryPickInput, deliveryIssueInput, deliveryCancelInput, standingDetermination, getDelivery, listDeliverableOrderLines, listDeliveries, SALES_DELIVERY_CREATE_CAPABILITY, createDelivery, confirmDeliveryPicks, postDeliveryGoodsIssue, cancelDelivery | billing_document, business_partner, credit_determination, delivery, delivery_line, delivery_picking, incompletion_status_group, material, plant, sales_incompletion_log, sales_order, sales_order_line, unit_of_measure |
| document-type-maintenance.ts | DOCUMENT_TYPE_OBJECT_CLASS, SalesDocumentTypeError, listSalesDocumentTypes, defineSalesDocumentType, changeSalesDocumentType, setSalesDocumentTypeActive, activeSalesDocumentTypes, DOCUMENT_TYPE_DEFINE_CAPABILITY | availability_checking_rule, billing_document, delivery, number_range, sales_document_type, sales_order |
| document-type.ts | STANDARD_ORDER_TYPE, STANDARD_QUOTATION_TYPE, STANDARD_DELIVERY_TYPE, STANDARD_BILLING_TYPE, STANDARD_BILLING_CANCELLATION_TYPE, STANDARD_RETURNS_DELIVERY_TYPE, STANDARD_RETURNS_ORDER_TYPE, STANDARD_CREDIT_MEMO_TYPE, STANDARD_CREDIT_MEMO_REQUEST_TYPE, STANDARD_DOWN_PAYMENT_REQUEST_TYPE, STANDARD_INVOICE_LIST_TYPE, STANDARD_REBATE_SETTLEMENT_TYPE, STANDARD_SALES_DOCUMENT_TYPES, salesDocumentTypeFor, DOCUMENT_TYPE_ROUTE, DOCUMENT_TYPE_DEFINE_CAPABILITY, DOCUMENT_TYPE_REMEDY | sales_document_type |
| down-payment.ts | DOWN_PAYMENT_OBJECT_CLASS, DownPaymentError, downPaymentRequestInput, downPaymentCancelInput, requestDownPaymentFromPlanDate, cancelDownPaymentRequest, orderDownPayments, clearDownPaymentsForInvoice | billing_document, billing_document_line, customer_down_payment_request, down_payment_request_fulfillment, sales_down_payment_request, special_gl_config |
| exposure.ts | openSalesCommitments | billing_document, delivery, delivery_line, sales_order, sales_order_line |
| fulfillment-quantities.ts | orderLineProgress, fulfillmentDocumentsOf, deliveredOf, billedOf | billing_document, billing_document_line, delivery, delivery_line |
| goods-issue-reversal.ts | GoodsIssueReversalError, refuseGoodsIssueReversal, noteGoodsIssueReversed | billing_document, delivery, delivery_line |
| incompletion.ts | INCOMPLETION_CAPABILITY, INCOMPLETION_PROCESS_CAPABILITY, INCOMPLETION_ROUTE, INCOMPLETION_WORKLIST_ROUTE, ORDER_ROUTE, DELIVERY_ROUTE, INCOMPLETION_STATUS_GROUP_OBJECT_CLASS, INCOMPLETION_PROCEDURE_OBJECT_CLASS, INCOMPLETION_PROCEDURE_FIELD_OBJECT_CLASS, INCOMPLETION_ASSIGNMENT_OBJECT_CLASS, BLOCKED_FUNCTIONS, IncompletionError, checkableFields, evaluateIncompletion, readIncompletion, blockingEntries, describeBlocked, blockedFor, listIncompleteDocuments, listIncompletionConfiguration, saveIncompletionStatusGroup, changeIncompletionStatusGroupStatus, saveIncompletionProcedure, changeIncompletionProcedureStatus, saveIncompletionProcedureField, withdrawIncompletionProcedureField, assignIncompletionProcedure, withdrawIncompletionAssignment | delivery, delivery_line, delivery_picking, incompletion_assignment, incompletion_group, incompletion_procedure, incompletion_procedure_field, incompletion_status_group, sales_document_partner, sales_document_type, sales_incompletion_log, sales_order, sales_order_line, sales_order_schedule |
| invoice-list.ts | INVOICE_LIST_OBJECT_CLASS, INVOICE_LIST_TYPE, INVOICE_LIST_CREATE_CAPABILITY, INVOICE_LIST_RELEASE_CAPABILITY, INVOICE_LIST_ROUTE, InvoiceListError, invoiceListDueDocuments, getInvoiceList, listInvoiceLists, createInvoiceListInputSchema, createInvoiceList, releaseInvoiceList, cancelInvoiceList | billing_document, billing_document_line, company_code, customer_sales_area, material_sales, sales_document_partner, sales_invoice_list_item, tax_code |
| material-sales.ts | MATERIAL_SALES_ROUTE, MaterialSalesError, readMaterialSales, assertMaterialSalesArea | material_sales |
| output.ts | SALES_OUTPUT_ROUTE, SALES_OUTPUT_CAPABILITY, SALES_OUTPUT_ADMIN_CAPABILITY, SALES_OUTPUT_OBJECT_CLASS, OUTPUT_CONDITION_OBJECT_CLASS, SALES_OUTPUT_CATEGORIES, DELIVERED_SALES_OUTPUT_TYPES, CATEGORY_OUTPUT_TYPE, SalesOutputError, ACCESS_SEQUENCE_VIEW, determineSalesOutputs, recordSalesOutputs, processSalesOutputMessage, renderSalesDocument, dispatchSalesOutput, reissueSalesOutput, setSalesOutputRecipient, listSalesOutput, determineSalesOutputsForSelection, dispatchPendingSalesOutput, saveOutputConditionRecord, listOutputConditionRecords, setOutputConditionRecordStatus, salesOutputTypeChoices, salesOutputPdf | billing_document, billing_document_line, business_partner, delivery, delivery_line, material, output_condition_record, output_message, output_type, sales_order, sales_order_line, sales_org |
| partners.ts | PARTNER_CAPABILITY, PARTNER_OBJECT_CLASS, PARTNER_ROUTE, PARTNER_ALIASES, PartnerError, isPartnerFunction, resolvePartners, documentPartners, writeDocumentPartners, partnersForDocument, listPartnerFunctions, listCustomerPartners, saveCustomerPartner, changeCustomerPartnerStatus, partnerAddress | bp_role, business_partner, customer_sales_partner, sales_document_partner, sales_partner_function |
| pricing-procedure-maintenance.ts | PRICING_DEFINE_CAPABILITY, PRICING_PROCEDURE_OBJECT_CLASS, CONDITION_TYPE_OBJECT_CLASS, DETERMINATION_OBJECT_CLASS, CONDITION_CLASSES, CALCULATION_TYPES, CONDITION_LEVELS, PricingProcedureMaintenanceError, listPricingConfiguration, defineConditionType, changeConditionType, definePricingProcedure, changePricingProcedure, addPricingProcedureStep, changePricingProcedureStep, defineProcedureDetermination, changeProcedureDetermination, conditionRecordsStanding | sales_area, sales_condition_record, sales_condition_type, sales_document_condition, sales_order, sales_pricing_procedure, sales_pricing_procedure_step, sales_procedure_determination |
| pricing-procedure.ts | PRICING_PROCEDURE_ROUTE, STANDARD_PRICING_PROCEDURE, DELIVERED_CONDITION_TYPES, DELIVERED_PRICING_STEPS, STANDARD_DOCUMENT_PRICING_PROCEDURE, PricingProcedureError, roundAmount, resolvePricingProcedure, priceDocument, taxStep, TAX_CONDITION_TYPE, TAX_ACCOUNT_KEY, TAX_STEP_NUMBER, taxConditionFor, writeDocumentConditions, documentConditionsOf, salesDocumentConditionsOf, scaleLineConditions, pricingProcedureDeterminationRows | company_code, material_valuation, sales_condition_record, sales_condition_type, sales_document_condition, sales_pricing_procedure_step, sales_procedure_determination, tax_code |
| pricing.ts | PricingError, resolveCustomerSalesData, assertMaterialAtPlant | customer_sales_area, material_plant |
| quotation-print.ts | salesQuotationPdf | material, sales_quotation, sales_quotation_line |
| quotation.ts | SALES_QUOTATION_CAPABILITY, SALES_QUOTATION_CREATE_CAPABILITY, SALES_QUOTATION_ROUTE, SALES_QUOTATION_OBJECT_CLASS, QUOTATION_REFERENCE_TYPE, SalesQuotationError, quotationLineInput, quotationCreateInput, quotationChangeInput, getQuotation, createQuotation, changeQuotation, listQuotations, rejectQuotation, createOrderFromQuotation, quotationChoices, STANDARD_QUOTATION_TYPE | bp_role, business_partner, sales_area, sales_order, sales_quotation, sales_quotation_line, sales_quotation_schedule |
| rebate.ts | REBATE_ROUTE, REBATE_CAPABILITY, REBATE_SETTLEMENT_CAPABILITY, REBATE_TRANSACTION, REBATE_AGREEMENT_OBJECT_CLASS, REBATE_ACCRUAL_OBJECT_CLASS, RebateError, saveRebateAgreement, releaseRebateAgreement, listRebateAgreements, rebateAccrualsForBilling, rebateRegister, rebateConditionTypes, accrueRebatesForBilling, reverseRebateAccrualsForBilling, settleRebateAgreement | billing_document, billing_document_line, bp_role, business_partner, company_code, customer_sales_area, material_sales, sales_condition_record, sales_condition_type, sales_order, sales_rebate_accrual, sales_rebate_agreement |
| registers.ts | REGISTER_KINDS, REGISTER_KIND_MEANING, REGISTER_LIMIT, listDocumentRegister, listDueRegister, listRegisterChoices | billing_document, business_partner, delivery, material, plant, sales_area, sales_document_type, sales_order, sales_order_line, sales_returns_configuration |
| report-exports.ts | salesAnalysisExport, SALES_REPORT_EXPORTS |  |
| returns-configuration.ts | RETURNS_CONFIGURATION_ROUTE, RETURNS_DEFINE_CAPABILITY, ReturnsConfigurationError, returnsChain, getReturnsConfiguration, saveReturnsConfiguration | movement_type, sales_document_type, sales_order, sales_returns_configuration |
| returns.ts | RETURNS_RECEIPT_TRANSACTION, RETURNS_ROUTE, RETURNS_ORDER_CAPABILITY, RETURNS_DELIVERY_CAPABILITY, RETURNS_RECEIPT_CAPABILITY, RETURNS_RECEIPT_CODE, RETURNS_RECEIPT_REVERSAL_CODE, ReturnsError, DELIVERED_RETURNS_RECEIPT_MOVEMENT, DELIVERED_RETURNS_MOVEMENTS, ensureReturnsMovements, resolveReturnsMovement, postReturnsReceipt, postReturnsReceiptInTx, RETURNS_DELIVERY_TRANSACTION, createReturnsDelivery, postReturnsDelivery, RETURNS_ORDER_TRANSACTION, createReturnsOrder, listReturnsOrders, listReturnsDeliveries | billing_document, billing_document_line, business_partner, delivery, delivery_line, material, material_document, material_document_line, movement_type, plant, sales_order, sales_order_line, stock_quantity |
| sales-order.ts | SALES_ORDER_CAPABILITY, SALES_ORDER_RELEASE_CAPABILITY, SALES_ORDER_OBJECT_CLASS, SALES_ORDER_ROUTE, SalesOrderError, key, isoDate, optionalKey, orderLineInput, orderCreateInput, orderChangeInput, round2, creditAreaFor, priceLines, getSalesOrder, SALES_ORDER_CREATE_CAPABILITY, createSalesOrder, changeSalesOrder, cancelSalesOrder, listSalesOrderDocuments, salesOrderChoices, releaseSalesOrderCredit | bp_role, business_partner, company_code, credit_determination, customer_credit, material, plant, sales_area, sales_order, sales_order_line, sales_order_schedule, unit_of_measure |
| schema.ts | ORDER_STATUSES, ORDER_LINE_STATUSES, salesDocumentType, salesReturnsConfiguration, salesOrder, salesOrderLine, salesOrderSchedule, salesQuotation, salesQuotationLine, salesQuotationSchedule, salesConditionType, salesConditionRecord, salesPricingProcedure, salesPricingProcedureStep, salesProcedureDetermination, salesAccountDetermination, salesDocumentCondition, salesTableNames, shippingCondition, shippingPoint, shippingPointDetermination, DELIVERY_STATUSES, delivery, deliveryLine, deliveryPicking, deliveryPickingSerial, BILLING_STATUSES, billingDocument, billingDocumentLine, BILLING_SPLIT_CRITERIA, DELIVERED_SPLIT_CRITERIA, salesInvoiceListItem, salesBillingSplitCriterion, salesBillingPlanType, DELIVERED_BILLING_PLAN_TYPES, BILLING_PLAN_DATE_STATUSES, BILLING_PLAN_DATE_RULES, salesBillingPlan, salesBillingPlanDate, salesDownPaymentRequest, DOWN_PAYMENT_REQUEST_STATUSES, REBATE_AGREEMENT_STATUSES, salesRebateAgreement, REBATE_ACCRUAL_STATUSES, salesRebateAccrual, PARTNER_FUNCTIONS, PARTNER_DOCUMENT_CATEGORIES, DELIVERED_PARTNER_FUNCTIONS, salesPartnerFunction, customerSalesPartner, salesDocumentPartner, INCOMPLETION_GROUPS, INCOMPLETION_DOCUMENT_CATEGORIES, DELIVERED_INCOMPLETION_GROUPS, incompletionGroup, incompletionStatusGroup, incompletionProcedure, incompletionProcedureField, incompletionAssignment, salesIncompletionLog, salesBatchDeterminationRule | billing_document, billing_document_line, customer_sales_partner, delivery, delivery_line, delivery_picking, delivery_picking_serial, incompletion_assignment, incompletion_group, incompletion_procedure, incompletion_procedure_field, incompletion_status_group, sales_account_determination, sales_batch_determination_rule, sales_billing_plan, sales_billing_plan_date, sales_billing_plan_type, sales_billing_split_criterion, sales_condition_record, sales_condition_type, sales_document_condition, sales_document_partner, sales_document_type, sales_down_payment_request, sales_incompletion_log, sales_invoice_list_item, sales_order, sales_order_line, sales_order_schedule, sales_partner_function, sales_pricing_procedure, sales_pricing_procedure_step, sales_procedure_determination, sales_quotation, sales_quotation_line, sales_quotation_schedule, sales_rebate_accrual, sales_rebate_agreement, sales_returns_configuration, shipping_condition, shipping_point, shipping_point_determination |
| shipping-point-maintenance.ts | SHIPPING_POINT_CAPABILITY, SHIPPING_POINT_OBJECT_CLASS, SHIPPING_CONDITION_OBJECT_CLASS, SHIPPING_POINT_DETERMINATION_OBJECT_CLASS, ShippingPointMaintenanceError, listShippingPointConfiguration, defineShippingPoint, changeShippingPointStatus, defineShippingCondition, changeShippingConditionStatus, assignShippingPoint, changeShippingPointAssignmentStatus | customer_sales_area, material_sales, plant, shipping_condition, shipping_point, shipping_point_determination |
| shipping-point.ts | SHIPPING_POINT_ROUTE, SHIPPING_POINT_ALIASES, ShippingPointError, shippingPointFor, shippingConditionOf, loadingGroupOf | customer_sales_area, material_sales, shipping_condition, shipping_point, shipping_point_determination |

## Routes (23)
`/config/batch-determination` · `/config/billing-split` · `/config/incompletion` · `/config/pricing-procedure` · `/config/sales-account-determination` · `/config/sales-document-types` · `/config/sales-returns` · `/config/shipping-points` · `/sales/analysis` · `/sales/billing-plans` · `/sales/billing` · `/sales/conditions` · `/sales/credit-memo-request` · `/sales/credit-memo` · `/sales/delivery` · `/sales/documents` · `/sales/incomplete` · `/sales/invoice-lists` · `/sales/orders` · `/sales/output` · `/sales/quotations` · `/sales/rebate-agreements` · `/sales/returns`

## Tables owned (42)
billing_document, billing_document_line, customer_sales_partner, delivery, delivery_line, delivery_picking, delivery_picking_serial, incompletion_assignment, incompletion_group, incompletion_procedure, incompletion_procedure_field, incompletion_status_group, sales_account_determination, sales_batch_determination_rule, sales_billing_plan, sales_billing_plan_date, sales_billing_plan_type, sales_billing_split_criterion, sales_condition_record, sales_condition_type, sales_document_condition, sales_document_partner, sales_document_type, sales_down_payment_request, sales_incompletion_log, sales_invoice_list_item, sales_order, sales_order_line, sales_order_schedule, sales_partner_function, sales_pricing_procedure, sales_pricing_procedure_step, sales_procedure_determination, sales_quotation, sales_quotation_line, sales_quotation_schedule, sales_rebate_accrual, sales_rebate_agreement, sales_returns_configuration, shipping_condition, shipping_point, shipping_point_determination

## Depends on
finance, foundation, inventory, output, platform/auth, platform/change, platform/db, platform/i18n, platform/notification, platform/numbering, platform/periods, platform/posting, platform/tables, production, ui/fields, ui/kit, ui/output

## Used by
dev/walkthrough-volume.ts, finance, foundation, inventory, output, platform/attention, platform/tenancy

## Tests (27)
document-print, material-sales, sales-account-determination, sales-analysis, sales-availability, sales-batch-determination, sales-billing-plan, sales-collective-billing, sales-delivery-terms, sales-delivery, sales-document-type-maintenance, sales-document-type, sales-down-payment, sales-incompletion, sales-invoice-list, sales-order-progress, sales-order, sales-output, sales-partners, sales-pricing-chain, sales-pricing-procedure, sales-quotation, sales-rebate, sales-registers, sales-returns-configuration, sales-serial-numbers, sales-shipping-point
