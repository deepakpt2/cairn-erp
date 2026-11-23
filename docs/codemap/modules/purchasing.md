# Purchasing
Requisitions, POs, RFQ/quotations, scheduling agreements, invoice verification, GR/IR. Routes: `/purchasing/*`, `/config/{delivery-completion,purchasing-orgs}`. Paths relative to `src/`; tables are SQL names.

## Gotchas
- Schema also hosts `customer_invoice(_line)` (finance reads it).
- Purchasing never posts stock: GR is inventory's `goods-receipt.ts`; purchasing reads results via `receipt-unit-basis.ts` (entry vs base unit; never compare `base_quantity` to the PO's order unit).
- `parked-invoice.ts` post/delete throw; parks post through `invoice-verification.ts`.
- `release.ts` serves every document category from one `document_release` table; release notifications are idempotent per (category, document, group, strategy).
- Release categories: PURCHASE_REQUISITION, PURCHASE_ORDER, PURCHASE_CONTRACT, SCHED_AGREEMENT, JOURNAL_ENTRY, PAYMENT_RUN (CHECK on `release_group` and `document_release`; attributes per category in foundation `RELEASE_ATTRIBUTES`). The finance ones live in finance (`parked-journal-release.ts`, `payment-run-release.ts`) and pass `preparedBy` so the preparer cannot release (case-insensitive); `assertDocumentReleased` is the gate, `syncDocumentRelease(..., {restart:true})` restarts a released document after it changed.
- `purchase_order.release_status` defaults UNRELEASED and moves only on a release act: readers use `PO_RELEASE_STATUS_SQL` / `getOrder`, which show NOT_REQUIRED when no `document_release` row stands.
- `purchase_order_assignment` CHECK: exactly one of cost centre / order / asset.
- `/config/purchasing-groups` belongs to foundation; `/config/purchasing-orgs` and `/config/delivery-completion` are purchasing.
- A stock transport order is a `purchase_order` with `document_type = STOCK_TRANSPORT`, `supplier_number` NULL and `supplying_plant` set (CHECK pins the shape; a trigger freezes the type). `stock-transport-order.ts` creates/changes it and refuses unsupported fields by name; `sto-guard.ts` refuses it from every commercial entry point (invoice, park, supplier return, supplier receipt). `release.ts` leaves TOTAL_VALUE/SUPPLIER out of an STO's attributes and `assertStoReleaseEvaluable` refuses an STO while a value/supplier strategy exists.

## Files (117)
| file | exports | tables |
|---|---|---|
| **app/config/delivery-completion/** | | |
| actions.ts | setDeliveryCompletionPolicyAction, setDeliveryCompletionPlantAction |  |
| DeliveryCompletion.tsx | DeliveryCompletion |  |
| page.tsx | DeliveryCompletionPage |  |
| **app/config/purchasing-orgs/** | | |
| actions.ts | savePurchasingOrgDefinitionAction, deactivatePurchasingOrgAction |  |
| DeactivatePurchasingOrgForm.tsx | DeactivatePurchasingOrgForm |  |
| page.tsx | PurchasingOrgsPage |  |
| PurchasingOrgDefinitionForm.tsx | PurchasingOrgDefinitionForm |  |
| **app/config/purchasing-orgs/assign-company/** | | |
| actions.ts | assignPurchasingOrgCompanyCodeAction |  |
| page.tsx | AssignPurchasingOrgCompanyCodePage |  |
| PurchasingOrgCompanyCodeAssignmentForm.tsx | PurchasingOrgCompanyCodeAssignmentForm |  |
| **app/config/purchasing-orgs/assign-plant/** | | |
| actions.ts | assignPurchasingOrgPlantAction, checkPurchasingOrgPlantAction, removePurchasingOrgPlantAction |  |
| AssignPlant.tsx | AssignPlant |  |
| page.tsx | AssignPurchasingOrgPlantPage |  |
| **app/purchasing/blocked-invoice/** | | |
| actions.ts | checkBlockedInvoiceAction, placeBlockedInvoiceAction, releaseBlockedInvoiceAction |  |
| BlockedInvoiceForms.tsx | PlaceHoldForm, ReleaseHoldForm |  |
| page.tsx | BlockedInvoicePage |  |
| **app/purchasing/contract-display/** | | |
| page.tsx | PurchaseContractDisplayPage |  |
| **app/purchasing/contracts/** | | |
| actions.ts | saveContractAction, releaseContractAction, cancelContractReleaseAction |  |
| Contracts.tsx | Contracts |  |
| page.tsx | PurchaseContractsPage |  |
| **app/purchasing/delivery-schedule-display/** | | |
| page.tsx | DeliveryScheduleDisplayPage |  |
| **app/purchasing/delivery-schedule/** | | |
| actions.ts | saveDeliveryScheduleAction |  |
| page.tsx | DeliverySchedulePage |  |
| ScheduleForm.tsx | ScheduleForm |  |
| **app/purchasing/grir-clearing/** | | |
| actions.ts | checkGrIrClearingAction, postGrIrClearingAction, reverseGrIrClearingAction |  |
| GrirClearingForms.tsx | ClearResidualForm, ReverseClearingForm |  |
| page.tsx | GrIrClearingPage |  |
| **app/purchasing/grir-reconciliation/** | | |
| page.tsx | GrIrReconciliationPage |  |
| **app/purchasing/info-record/** | | |
| actions.ts | checkInfoRecordAction, checkChangeInfoRecordAction, createInfoRecordAction, changeInfoRecordAction |  |
| InfoRecord.tsx | InfoRecordWorkbench |  |
| page.tsx | PurchasingInfoRecordPage |  |
| **app/purchasing/invoice-overview/** | | |
| page.tsx | InvoiceOverviewPage |  |
| **app/purchasing/invoice-verification/** | | |
| actions.ts | postInvoiceAction, cancelInvoiceAction |  |
| InvoiceVerification.tsx | InvoiceVerification |  |
| page.tsx | InvoiceVerificationPage |  |
| **app/purchasing/orders-by-account-assignment/** | | |
| page.tsx | OrdersByAccountAssignmentPage |  |
| PoAccountAssignmentShell.tsx | PoAccountAssignmentShell |  |
| **app/purchasing/orders/** | | |
| actions.ts | releaseOrderAction, cancelOrderReleaseAction, saveOrderAction |  |
| Orders.tsx | Orders |  |
| page.tsx | PurchaseOrdersPage |  |
| StockTransportForm.tsx | StockTransportForm |  |
| **app/purchasing/parked-invoice/** | | |
| actions.ts | checkParkedInvoiceAction, saveParkedInvoiceAction |  |
| page.tsx | ParkedInvoicePage |  |
| ParkedInvoice.tsx | ParkedInvoice |  |
| **app/purchasing/purchase-order-display/** | | |
| actions.ts | downloadPurchaseOrderPdfAction |  |
| page.tsx | PurchaseOrderDisplayPage |  |
| **app/purchasing/purchase-order-list/** | | |
| page.tsx | PurchaseOrderListPage |  |
| PurchaseOrderListShell.tsx | PurchaseOrderListShell |  |
| **app/purchasing/quota-arrangement/** | | |
| actions.ts | checkQuotaAction, createQuotaAction, checkChangeQuotaAction, changeQuotaAction, rateQuotaAction |  |
| page.tsx | PurchasingQuotaPage |  |
| QuotaArrangement.tsx | QuotaWorkbench |  |
| **app/purchasing/quotation-comparison/** | | |
| page.tsx | PurchasingQuotationComparisonPage |  |
| **app/purchasing/quotation-display/** | | |
| page.tsx | PurchasingQuotationDisplayPage |  |
| **app/purchasing/quotation/** | | |
| actions.ts | checkQuotationAction, saveQuotationAction |  |
| page.tsx | PurchasingQuotationPage |  |
| Quotation.tsx | Quotation |  |
| **app/purchasing/requisition-list/** | | |
| page.tsx | RequisitionListPage |  |
| RequisitionListShell.tsx | RequisitionListShell |  |
| **app/purchasing/requisitions/** | | |
| actions.ts | releaseRequisitionAction, cancelRequisitionReleaseAction, saveRequisitionAction |  |
| page.tsx | PurchaseRequisitionsPage |  |
| Requisitions.tsx | Requisitions |  |
| **app/purchasing/rfq/** | | |
| actions.ts | checkRfqAction, createRfqAction, checkChangeRfqAction, changeRfqAction, downloadRfqPdfAction |  |
| page.tsx | PurchasingRfqPage |  |
| RequestForQuotation.tsx | RequestForQuotation |  |
| **app/purchasing/scheduling-agreement-display/** | | |
| page.tsx | SchedulingAgreementDisplayPage |  |
| **app/purchasing/scheduling-agreement-releases/** | | |
| actions.ts | createSchedulingReleasesAction |  |
| page.tsx | SchedulingAgreementReleasesPage |  |
| ReleaseForm.tsx | ReleaseForm |  |
| **app/purchasing/scheduling-agreements/** | | |
| actions.ts | saveSchedulingAgreementAction, releaseSchedulingAgreementAction, cancelSchedulingAgreementReleaseAction |  |
| Agreements.tsx | Agreements |  |
| page.tsx | SchedulingAgreementsPage |  |
| **app/purchasing/source-list/** | | |
| actions.ts | checkSourceListAction, checkChangeSourceListAction, createSourceListAction, changeSourceListAction |  |
| page.tsx | PurchasingSourceListPage |  |
| SourceList.tsx | SourceListWorkbench |  |
| **app/purchasing/vendor-evaluation/** | | |
| actions.ts | saveManualScoreAction |  |
| ManualScoreForm.tsx | ManualScoreForm |  |
| page.tsx | VendorEvaluationPage |  |
| **modules/purchasing/** | | |
| account-assignment.ts | ACCOUNT_ASSIGNMENT_CATEGORIES, ACCOUNT_ASSIGNMENT_CODE, ACCOUNT_ASSIGNMENT_NAME, isAccountAssignmentCategory, accountAssignmentLabel, normalizeAccountAssignmentCategory, assignmentObject, judgeAccountAssignments | asset_class, asset_transaction_type, controlling_area_company, cost_center, fixed_asset, gl_account, internal_order |
| blocked-invoice.ts | BLOCKED_INVOICE_CAPABILITY, BLOCKED_INVOICE_HOLD_CAPABILITY, BLOCKED_INVOICE_ROUTE, BLOCKED_INVOICE_ALIASES, MANUAL_REASON, BlockedInvoiceError, activeBlockedInvoiceNumbers, listBlockedInvoices, listBlockEvents, previewPaymentBlock, placePaymentBlock, releasePaymentBlock | business_partner, company_code, journal_entry_line, parked_supplier_invoice, payment_document, payment_proposal_item, payment_run, purchase_order, supplier_invoice, supplier_invoice_item, supplier_invoice_payment_block, supplier_invoice_payment_block_event |
| contract-display.ts | CONTRACT_DISPLAY_ROUTE, PurchaseContractDisplayError, openPurchaseContractDisplay, CONTRACT_DISPLAY_CAPABILITY |  |
| contract.ts | CONTRACT_MAINTAIN_CAPABILITY, CONTRACT_DISPLAY_CAPABILITY, CONTRACT_LIST_CAPABILITY, CONTRACT_OBJECT_CLASS, PurchaseContractError, createPurchaseContract, createPurchaseContractForProvisioning, changePurchaseContract, changePurchaseContractForProvisioning, getPurchaseContract, getPurchaseContractForProvisioning, contractChoices, listPurchaseContracts, assertPurchaseContractCallOff | business_partner, client, company_code, controlling_area_company, cost_center, currency, document_release, gl_account, material, material_document_line, movement_type, payment_terms, plant, purchase_contract, purchase_contract_item, purchase_order, purchase_order_item, purchase_requisition_item, purchasing_contract_type, purchasing_group, purchasing_org, purchasing_quotation_item, purchasing_rfq, purchasing_rfq_event, purchasing_rfq_item, storage_location, supplier_invoice, supplier_invoice_item, supplier_purchasing_org |
| delivery-completion.ts | ACTIVITY, deliveryCompletionDecision, readDeliveryCompletionPolicy, listDeliveryCompletionPolicyForProvisioning, setDeliveryCompletionPolicyForProvisioning, setDeliveryCompletionPlantPolicyForProvisioning, DeliveryCompletionScopeError, listDeliveryCompletionPolicy, setDeliveryCompletionPolicy, setDeliveryCompletionPlantPolicy | company_code, plant, purchase_delivery_completion_plant, purchase_delivery_completion_policy |
| document-print.ts | purchaseOrderPdf, rfqPdf | purchase_order, purchase_order_item, purchasing_org, purchasing_rfq, purchasing_rfq_event, purchasing_rfq_item |
| follow-on.ts | FollowOnError, convertMoney, copyRequisition, adoptQuotation, settleQuota, updateInfoRecordFromOrder, orderDraftFromQuotationForProvisioning, orderDraftFromRequisitionForProvisioning, orderDraftFromRequisition, orderDraftFromQuotation | company_code, document_release, plant, purchase_order_item, purchase_requisition_assignment, purchase_requisition_item, purchasing_info_record, purchasing_info_record_org, purchasing_org_plant, purchasing_quota_arrangement, purchasing_quota_arrangement_item, purchasing_quotation, purchasing_quotation_item, purchasing_rfq, purchasing_rfq_event, purchasing_rfq_item, supplier_purchasing_org |
| grir-clearing.ts | GRIR_CLEARING_CAPABILITY, GRIR_CLEARING_POST_CAPABILITY, GRIR_CLEARING_REVERSE_CAPABILITY, GRIR_CLEARING_ROUTE, GRIR_CLEARING_ALIASES, GrIrClearingError, refuseNamed, listGrIrResiduals, listGrIrMaintenance, previewGrIrClearing, postGrIrClearing, reverseGrIrClearing | account_determination, company_code, gr_ir_maintenance_link, journal_entry, material_document, material_document_line, material_plant, material_valuation, movement_type, purchase_order, purchase_order_item, supplier_invoice, supplier_invoice_item |
| grir-reconciliation.ts | GRIR_RECONCILIATION_CAPABILITY, GRIR_RECONCILIATION_ROUTE, GRIR_RECONCILIATION_ALIASES, listGrIrExceptions |  |
| info-record.ts | INFO_RECORD_CAPABILITY, INFO_RECORD_OBJECT, INFO_RECORD_ROUTE, InfoRecordError, previewPurchasingInfoRecordForProvisioning, createPurchasingInfoRecordForProvisioning, writePurchasingInfoRecord, changePurchasingInfoRecordForProvisioning, writePurchasingInfoRecordChange, previewPurchasingInfoRecordChangeForProvisioning, resolvePurchasingInfoRecord, findPurchasingInfoRecordForProvisioning, getPurchasingInfoRecordForProvisioning, infoRecordChoicesForProvisioning, previewPurchasingInfoRecord, createPurchasingInfoRecord, changePurchasingInfoRecord, previewPurchasingInfoRecordChange, findPurchasingInfoRecord, getPurchasingInfoRecord, infoRecordChoices | business_partner, currency, material, material_plant, plant, purchasing_info_record, purchasing_info_record_org, purchasing_info_record_price, purchasing_org, purchasing_org_plant, supplier_purchasing_org, unit_of_measure |
| invoice-overview.ts | INVOICE_OVERVIEW_CAPABILITY, INVOICE_OVERVIEW_ROUTE, INVOICE_OVERVIEW_ALIASES, DEFAULT_MAX_HITS, MAX_HITS_CAP, MAX_DATE_SPAN_DAYS, LIFECYCLES, CATEGORIES, SORTS, InvoiceOverviewError, listInvoiceOverview, readInvoiceOverviewDocument | bp_role, business_partner, company_code, journal_entry_line, parked_supplier_invoice, parked_supplier_invoice_item, purchase_order, purchasing_org, supplier_invoice, supplier_invoice_item |
| invoice-verification.ts | INVOICE_CAPABILITY, InvoiceVerificationError, getInvoiceOrder, getInvoiceOrderForProvisioning, listInvoiceTaxCodes, getSupplierInvoice, postSupplierInvoice, postSupplierInvoiceForProvisioning, cancelSupplierInvoice, cancelSupplierInvoiceForProvisioning | account_determination, journal_entry, journal_entry_line, material_document_line, material_valuation, movement_type, parked_supplier_invoice, payment_terms, purchase_order, purchase_order_assignment, purchase_order_item, supplier_company_code, supplier_invoice, supplier_invoice_item, tax_code, vendor_down_payment, vendor_down_payment_clearing |
| item-state.ts | purchaseItemState, purchaseHeaderState |  |
| orders.ts | PO_CREATE_CAPABILITY, PO_OBJECT_CLASS, ORDER_TYPES, PurchaseOrderError, resolveItemTolerances, getOrder, getOrderForProvisioning, createOrder, createOrderForProvisioning, releaseImpactingChanges, changeOrder, changeOrderForProvisioning, orderChoices | business_partner, company_code, controlling_area_company, cost_center, document_release, gl_account, material, material_group, material_plant, payment_terms, plant, purchase_order, purchase_order_assignment, purchase_order_item, purchase_order_schedule_line, purchase_requisition_item, purchasing_group, purchasing_org, storage_location, supplier_purchasing_org, tax_code, unit_of_measure |
| parked-invoice.ts | PARKED_INVOICE_CAPABILITY, PARKED_INVOICE_ROUTE, ParkedInvoiceError, previewParkedInvoice, parkSupplierInvoice, previewParkedInvoiceChange, changeParkedInvoice, postParkedInvoice, deleteParkedInvoice, getParkedInvoice, openOrderForPark, listRecentParkedInvoices | company_code, material_document_line, movement_type, parked_supplier_invoice, parked_supplier_invoice_item, payment_terms, purchase_order, purchase_order_item, supplier_company_code, supplier_invoice, supplier_invoice_item, tax_code |
| po-account-assignment.ts | PO_ACCOUNT_ASSIGN_CAPABILITY, PO_ACCOUNT_ASSIGN_ALIAS, SCOPES, SCOPE_OF_LIST, ACCOUNT_ASSIGNMENT_CATEGORIES, COST_OBJECT_KINDS, DEFAULT_MAX_HITS, MAX_HITS_CAP, PoAccountAssignError, purchaseOrdersByAccountAssignment | business_partner, cost_center, material, material_document_line, movement_type, plant, purchase_order, purchase_order_assignment, purchase_order_item, purchase_order_schedule_line, supplier_invoice, supplier_invoice_item |
| purchase-order-display.ts | PO_DISPLAY_CAPABILITY, PO_DISPLAY_ROUTE, PurchaseOrderDisplayError, assignedShare, displayPurchaseOrder, searchPurchaseOrders, openPurchaseOrderDisplay | business_partner, change_document, change_document_item, gr_ir_maintenance_link, material, material_document, material_document_line, material_uom_conversion, movement_type, parked_supplier_invoice, parked_supplier_invoice_item, plant, purchase_order, purchase_order_assignment, purchase_order_item, purchase_order_schedule_line, purchasing_org, supplier_invoice, supplier_invoice_item |
| purchase-order-list.ts | PO_LIST_CAPABILITY, PO_LIST_ALIASES, DEFAULT_MAX_HITS, MAX_HITS_CAP, PERSPECTIVES, SCOPES, PoListError, listPurchaseOrders, listPurchaseOrdersForProvisioning | business_partner, material, material_document_line, movement_type, purchase_order, purchase_order_item, purchase_order_schedule_line, purchase_requisition_item, sto_transit_allocation, supplier_invoice, supplier_invoice_item |
| purchasing-org-plant-assignment.ts | ACTIVITY, ROUTE, PurchasingOrgPlantAssignmentError, listPurchasingOrgPlantAssignments, checkPurchasingOrgPlant, assignPurchasingOrgPlant, removePurchasingOrgPlant, assertPurchasingOrgForPlant, PURCH_ORG_PLANT_NOT_AUTHORIZED, purchasingOrgMayBuyForPlant | change_document, plant, purchase_order, purchase_order_item, purchasing_info_record_org, purchasing_org, purchasing_org_plant, purchasing_quota_arrangement, purchasing_quota_arrangement_item, purchasing_rfq_event, purchasing_rfq_event_item, purchasing_source_list_entry |
| quota-arrangement.ts | QUOTA_CAPABILITY, QUOTA_OBJECT, QUOTA_ROUTE, RATING_SCALE, QuotaError, rateQuota, previewQuotaArrangementForProvisioning, createQuotaArrangementForProvisioning, writeQuotaArrangement, previewQuotaChangeForProvisioning, changeQuotaArrangementForProvisioning, writeQuotaChange, listQuotaArrangementsForProvisioning, listRecentQuotaArrangementsForProvisioning, getQuotaArrangementForProvisioning, previewQuotaSelectionForProvisioning, previewQuotaArrangement, createQuotaArrangement, previewQuotaChange, changeQuotaArrangement, listQuotaArrangements, listRecentQuotaArrangements, getQuotaArrangement, previewQuotaSelection | bp_role, business_partner, material, material_plant, plant, purchasing_org, purchasing_quota_arrangement, purchasing_quota_arrangement_item, purchasing_source_list, purchasing_source_list_entry, supplier_purchasing_org |
| quotation-comparison.ts | QUOTATION_COMPARISON_CAPABILITY, QUOTATION_COMPARISON_ROUTE, ComparisonError, compareQuotations | business_partner, material, material_uom_conversion, plant, purchasing_org, purchasing_quotation, purchasing_quotation_item, purchasing_rfq, purchasing_rfq_event, purchasing_rfq_event_item, purchasing_rfq_item |
| quotation-display.ts | QUOTATION_DISPLAY_CAPABILITY, QUOTATION_DISPLAY_ROUTE, displayQuotation, displayQuotationForRequest, listRecentDisplayedQuotations | business_partner, change_document, change_document_item, plant, purchasing_quotation, purchasing_quotation_item, purchasing_rfq, purchasing_rfq_event, purchasing_rfq_item |
| quotation.ts | QUOTATION_CAPABILITY, QUOTATION_OBJECT, QUOTATION_ROUTE, QuotationError, pricePerUnit, previewQuotationForProvisioning, previewQuotationChangeForProvisioning, createQuotationForProvisioning, writeQuotation, changeQuotationForProvisioning, writeQuotationChange, openQuotationForProvisioning, getQuotationForProvisioning, previewQuotation, previewQuotationChange, createQuotation, changeQuotation, openQuotation, listRecentQuotationRequests, getQuotation | business_partner, material_uom_conversion, purchasing_quotation, purchasing_quotation_item, purchasing_rfq, purchasing_rfq_event, purchasing_rfq_item, unit_of_measure |
| receipt-unit-basis.ts | receiptUnitJoins, receiptQuantityInOrderUnit, receiptQuantityUnstateable, receiptMovementSign | material, material_document_line, material_uom_conversion, movement_type, purchase_order_item, unit_of_measure |
| release.ts | RELEASE_CAPABILITIES, PO_RELEASE_STATUS_SQL, ReleaseError, getDocumentRelease, getDocumentReleaseInTx, listDocumentReleases, requisitionAttributes, orderAttributes, syncDocumentRelease, assertStoReleaseEvaluable, dropDocumentRelease, assertDocumentNotReleased, assertDocumentReleased, assertReleaseAuthority, releaseDocument, releaseDocumentForProvisioning, cancelDocumentRelease, cancelDocumentReleaseForProvisioning | characteristic, document_release, parked_journal_header, payment_run_company, plant, purchase_contract, purchase_order, purchase_order_item, purchase_requisition_item, release_group, release_strategy, release_strategy_criterion, release_strategy_step, scheduling_agreement |
| report-exports.ts | purchaseOrderListExport, requisitionListExport, invoiceOverviewExport, PURCHASING_REPORT_EXPORTS |  |
| requisition-list.ts | PR_LIST_CAPABILITY, PR_LIST_ALIAS, DEFAULT_MAX_HITS, MAX_HITS_CAP, RequisitionListError, listPurchaseRequisitions | app_user, plant, purchase_order_item, purchase_requisition_item, purchasing_org_plant |
| requisitions.ts | PR_CREATE_CAPABILITY, PR_OBJECT_CLASS, REQUISITION_TYPES, PurchaseRequisitionError, getRequisition, getRequisitionForProvisioning, createRequisition, createRequisitionForProvisioning, changeRequisition, changeRequisitionForProvisioning, requisitionChoices | company_code, controlling_area_company, cost_center, employee, gl_account, material, material_group, material_plant, plant, purchase_requisition_assignment, purchase_requisition_item, purchasing_group, storage_location, unit_of_measure |
| rfq.ts | RFQ_CAPABILITY, RFQ_EVENT_OBJECT, RFQ_OBJECT, RFQ_ROUTE, RFQ_TYPE, RfqError, previewRequestForQuotationForProvisioning, createRequestForQuotationForProvisioning, writeRequestForQuotation, getRequestForQuotationForProvisioning, previewRequestForQuotationChangeForProvisioning, changeRequestForQuotationForProvisioning, writeRequestForQuotationChange, eventInReach, requestInReach, previewRequestForQuotation, createRequestForQuotation, getRequestForQuotation, listRecentRequestsForQuotation, previewRequestForQuotationChange, changeRequestForQuotation, resolveRequestForQuotation | bp_role, business_partner, company_code, material, material_plant, material_uom_conversion, plant, purchasing_group, purchasing_org, purchasing_rfq, purchasing_rfq_event, purchasing_rfq_event_item, purchasing_rfq_item, storage_location, supplier_purchasing_org, unit_of_measure |
| scheduling-agreement-display.ts | SCHEDULING_AGREEMENT_DISPLAY_ROUTE, SchedulingAgreementDisplayError, openSchedulingAgreementDisplay, SCHEDULING_AGREEMENT_DISPLAY_CAPABILITY |  |
| scheduling-agreement-release.ts | RELEASE_CREATE_CAPABILITY, RELEASE_ROUTE, RELEASE_OBJECT_CLASS, NOT_TRANSMITTED, SchedulingAgreementReleaseError, saveReleaseProfileForProvisioning, assignReleaseProfileForProvisioning, createSchedulingAgreementReleases, createSchedulingAgreementReleasesForProvisioning, listSchedulingAgreementReleases | business_partner, document_release, material_plant, number_range, scheduling_agreement, scheduling_agreement_item, scheduling_agreement_release, scheduling_agreement_release_line, scheduling_agreement_schedule_line, scheduling_agreement_type, scheduling_release_profile, scheduling_release_profile_assignment, supplier_purchasing_org |
| scheduling-agreement-schedule-display.ts | SCHEDULE_DISPLAY_ROUTE, DeliveryScheduleDisplayError, openDeliveryScheduleDisplay, deliveryScheduleHistory |  |
| scheduling-agreement-schedule.ts | SCHEDULE_MAINTAIN_CAPABILITY, SCHEDULE_DISPLAY_CAPABILITY, SCHEDULE_ROUTE, SchedulingAgreementScheduleError, maintainDeliverySchedule, maintainDeliveryScheduleForProvisioning, readDeliverySchedule | business_partner, scheduling_agreement, scheduling_agreement_item, scheduling_agreement_schedule_line, supplier_purchasing_org |
| scheduling-agreement.ts | SCHEDULING_AGREEMENT_MAINTAIN_CAPABILITY, SCHEDULING_AGREEMENT_DISPLAY_CAPABILITY, SCHEDULING_AGREEMENT_LIST_CAPABILITY, SCHEDULING_AGREEMENT_OBJECT_CLASS, SCHEDULING_AGREEMENT_CATEGORY, SCHEDULING_AGREEMENT_ROUTE, SchedulingAgreementError, SCHEDULING_AGREEMENT_READ_CAPABILITIES, createSchedulingAgreement, createSchedulingAgreementForProvisioning, changeSchedulingAgreement, changeSchedulingAgreementForProvisioning, getSchedulingAgreement, getSchedulingAgreementForProvisioning, listSchedulingAgreements, schedulingAgreementChoices | bp_role, business_partner, company_code, controlling_area_company, cost_center, currency, document_release, gl_account, material, material_plant, payment_terms, plant, purchase_requisition_item, purchasing_group, purchasing_org, scheduling_agreement, scheduling_agreement_item, scheduling_agreement_schedule_line, scheduling_agreement_type, storage_location, supplier_purchasing_org, unit_of_measure |
| schema.ts | purchaseRequisitionItem, purchaseRequisitionAssignment, purchaseOrder, purchasingInfoRecord, purchasingInfoRecordOrg, purchaseDeliveryCompletionPolicy, purchaseDeliveryCompletionPlant, purchasingInfoRecordPrice, purchasingSourceList, purchasingSourceListEntry, purchasingQuotaArrangement, purchasingQuotaArrangementItem, purchaseOrderItem, purchaseOrderScheduleLine, purchaseOrderAssignment, documentRelease, supplierInvoice, supplierInvoiceItem, customerInvoice, customerInvoiceLine, purchasingRfqEvent, purchasingRfqEventItem, purchasingRfq, purchasingRfqItem, purchasingQuotation, purchasingQuotationItem, parkedSupplierInvoice, parkedSupplierInvoiceItem, supplierInvoicePaymentBlock, supplierInvoicePaymentBlockEvent, grIrMaintenanceLink, vendorEvaluationCriterion, vendorEvaluationAssessment, purchasingContractType, purchaseContract, purchaseContractItem, schedulingAgreementType, schedulingAgreement, schedulingAgreementItem, schedulingAgreementScheduleLine, schedulingReleaseProfile, schedulingReleaseProfileAssignment, schedulingAgreementRelease, schedulingAgreementReleaseLine | customer_invoice, customer_invoice_line, document_release, gr_ir_maintenance_link, parked_supplier_invoice, parked_supplier_invoice_item, purchase_contract, purchase_contract_item, purchase_delivery_completion_plant, purchase_delivery_completion_policy, purchase_order, purchase_order_assignment, purchase_order_item, purchase_order_schedule_line, purchase_requisition_assignment, purchase_requisition_item, purchasing_contract_type, purchasing_info_record, purchasing_info_record_org, purchasing_info_record_price, purchasing_quota_arrangement, purchasing_quota_arrangement_item, purchasing_quotation, purchasing_quotation_item, purchasing_rfq, purchasing_rfq_event, purchasing_rfq_event_item, purchasing_rfq_item, purchasing_source_list, purchasing_source_list_entry, scheduling_agreement, scheduling_agreement_item, scheduling_agreement_release, scheduling_agreement_release_line, scheduling_agreement_schedule_line, scheduling_agreement_type, scheduling_release_profile, scheduling_release_profile_assignment, supplier_invoice, supplier_invoice_item, supplier_invoice_payment_block, supplier_invoice_payment_block_event, vendor_evaluation_assessment, vendor_evaluation_criterion |
| scope.ts | *../../platform/auth/scope-actor |  |
| source-list.ts | SOURCE_LIST_CAPABILITY, SOURCE_LIST_OBJECT, SOURCE_LIST_ROUTE, SourceListError, previewSourceListEntryForProvisioning, createSourceListEntryForProvisioning, writeSourceListEntry, previewSourceListChangeForProvisioning, changeSourceListEntryForProvisioning, writeSourceListChange, resolveSourceList, getSourceListEntryForProvisioning, getSourceListForProvisioning, previewSourceListEntry, createSourceListEntry, previewSourceListChange, changeSourceListEntry, getSourceListEntry, getSourceList, listRecentSourceEntries | bp_role, business_partner, material, material_plant, plant, purchasing_org, purchasing_source_list, purchasing_source_list_entry, supplier_purchasing_org |
| sto-guard.ts | STO_ORDER_TYPE, stoRefusal | purchase_order |
| stock-transport-order.ts | STO_RANGE_SUB_OBJECT, StoOrderError, createStockTransportOrder, changeStockTransportOrder, STO_ORDER_TYPE | company_code, material, material_plant, planning_file, plant, purchase_order, purchase_order_item, purchase_order_schedule_line, purchasing_group, purchasing_org, sto_transit_allocation, storage_location |
| vendor-evaluation.ts | VENDOR_EVALUATION_CAPABILITY, VENDOR_EVALUATION_ROUTE, VendorEvaluationError, listVendorEvaluationForProvisioning, checkVendorEvaluationForProvisioning, saveManualScoreForProvisioning, listVendorEvaluation, checkVendorEvaluation, saveManualScore | business_partner, material_document, material_document_line, movement_type, purchase_order, purchase_order_schedule_line, purchasing_org, supplier_invoice, supplier_invoice_item, supplier_purchasing_org, vendor_evaluation_assessment, vendor_evaluation_criterion |

## Routes (31)
`/config/delivery-completion` · `/config/purchasing-orgs` · `/config/purchasing-orgs/assign-company` · `/config/purchasing-orgs/assign-plant` · `/purchasing/blocked-invoice` · `/purchasing/contract-display` · `/purchasing/contracts` · `/purchasing/delivery-schedule-display` · `/purchasing/delivery-schedule` · `/purchasing/grir-clearing` · `/purchasing/grir-reconciliation` · `/purchasing/info-record` · `/purchasing/invoice-overview` · `/purchasing/invoice-verification` · `/purchasing/orders-by-account-assignment` · `/purchasing/orders` · `/purchasing/parked-invoice` · `/purchasing/purchase-order-display` · `/purchasing/purchase-order-list` · `/purchasing/quota-arrangement` · `/purchasing/quotation-comparison` · `/purchasing/quotation-display` · `/purchasing/quotation` · `/purchasing/requisition-list` · `/purchasing/requisitions` · `/purchasing/rfq` · `/purchasing/scheduling-agreement-display` · `/purchasing/scheduling-agreement-releases` · `/purchasing/scheduling-agreements` · `/purchasing/source-list` · `/purchasing/vendor-evaluation`

## Tables owned (44)
customer_invoice, customer_invoice_line, document_release, gr_ir_maintenance_link, parked_supplier_invoice, parked_supplier_invoice_item, purchase_contract, purchase_contract_item, purchase_delivery_completion_plant, purchase_delivery_completion_policy, purchase_order, purchase_order_assignment, purchase_order_item, purchase_order_schedule_line, purchase_requisition_assignment, purchase_requisition_item, purchasing_contract_type, purchasing_info_record, purchasing_info_record_org, purchasing_info_record_price, purchasing_quota_arrangement, purchasing_quota_arrangement_item, purchasing_quotation, purchasing_quotation_item, purchasing_rfq, purchasing_rfq_event, purchasing_rfq_event_item, purchasing_rfq_item, purchasing_source_list, purchasing_source_list_entry, scheduling_agreement, scheduling_agreement_item, scheduling_agreement_release, scheduling_agreement_release_line, scheduling_agreement_schedule_line, scheduling_agreement_type, scheduling_release_profile, scheduling_release_profile_assignment, supplier_invoice, supplier_invoice_item, supplier_invoice_payment_block, supplier_invoice_payment_block_event, vendor_evaluation_assessment, vendor_evaluation_criterion

## Depends on
finance, foundation, inventory, output, people, platform/auth, platform/change, platform/db, platform/document, platform/i18n, platform/job, platform/lock, platform/notification, platform/numbering, platform/periods, platform/posting, platform/tables, platform/tenancy, ui/fields, ui/kit, ui/lock, ui/money.ts, ui/output

## Used by
dev/walkthrough-asset.ts, dev/walkthrough-volume.ts, finance, inventory, output, platform/attention, platform/tenancy, production, ui/release

## Tests (72)
atomic-inventory-posting, attention, batch-assignment, batch-classification, batch-number-assignment, batch-number-range, batch-pickup, batch-posting, batch-procurement-chain, blocked-invoice, company-scope-purchasing, currency-precision-flows, delivery-completion-policy, document-print, finance-release, goods-receipt-batch-layer, goods-receipt, grir-clearing, grir-reconciliation, info-record, invoice-account-assignment, invoice-advance-clearing, invoice-overview, invoice-verification, material-document-reversal, parked-invoice, payment-run-background, payment-run, po-account-assignment, po-delivery-control, po-release-impact, purchase-contract, purchase-item-state, purchase-order-advance, purchase-order-batch-display, purchase-order-display, purchase-order-list, purchase-order, purchase-requisition-list, purchase-requisition, purchasing-follow-on, purchasing-org-plant-assignment, qm-inspection-results, qm-usage-decision, quality-lot, quality-service-authorization, quota-arrangement, quotation-comparison, quotation-display, quotation, release-acts, release-waiting, requisition-transaction, return-delivery-batch, return-delivery, reversal-batch, rfq, scheduling-agreement-release, scheduling-agreement-schedule, scheduling-agreement, single-item-planning, single-level-planning, source-list, stock-batch-readback, stock-transport-order-batches, stock-transport-order-reports, stock-transport-order, storage-location-posting, vendor-ageing, vendor-balances, vendor-clearing, vendor-evaluation
