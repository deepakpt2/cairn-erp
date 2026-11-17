# Inventory
Stock/warehouse: goods movements, batches, physical inventory, material master. Routes: `/inventory/*` (incl. `serial-numbers`), `/config/{batch-*,material-*,movement-types,valuation-classes,industry-sectors}`. Paths relative to `src/`; tables are SQL names.

## Gotchas
- Hosts `production_order(_component)` and `production_scheduling_profile` tables + their persistence.
- Request-key replay = `pg_advisory_xact_lock` on `client/md-request/{key}` + SHA-256 payload fingerprint (`balance-update.ts`), shared by every goods movement.
- `stock_quantity` has no non-negative CHECK: negative-stock rules live in `transfer-posting.ts` / `goods-issue.ts`.
- Batch uniqueness depends on batch level (three partial unique indexes); conversion/genealogy functions typed `never` are deliberate stubs.
- Posting services verify `ServiceAuthorityContext` in-tx; tests use `tests/helpers/*-authorized.ts`.
- Initial stock (561, 9275) has no reversal; offset is retained earnings. RETURNS stock is unvalued.
- `serial_number` is a capture record, not reconciled to `stock_quantity`.

## Files (243)
| file | exports | tables |
|---|---|---|
| **app/config/batch-access-sequences/** | | |
| AccessSequenceForm.tsx | AccessSequenceForm |  |
| actions.ts | saveBatchAccessSequenceAction, deleteBatchAccessSequenceAction, saveBatchAccessStepAction, deleteBatchAccessStepAction |  |
| page.tsx | BatchAccessSequencePage |  |
| **app/config/batch-classification/** | | |
| actions.ts | saveBatchClassificationAction |  |
| ClassificationForm.tsx | ClassificationForm |  |
| page.tsx | BatchClassificationPage |  |
| **app/config/batch-condition-tables/** | | |
| actions.ts | saveBatchConditionTableAction, deleteBatchConditionTableAction |  |
| ConditionTableForm.tsx | ConditionTableForm |  |
| page.tsx | BatchConditionTablePage |  |
| **app/config/batch-conversion/** | | |
| actions.ts | checkConversionAction, executeConversionAction |  |
| ConversionForm.tsx | ConversionForm |  |
| page.tsx | BatchConversionPage |  |
| **app/config/batch-document-management/** | | |
| actions.ts | saveDocumentManagementAction |  |
| DocumentForm.tsx | DocumentForm |  |
| page.tsx | BatchDocumentManagementPage |  |
| **app/config/batch-initial-status/** | | |
| actions.ts | saveInitialBatchStatusAction |  |
| InitialStatusForm.tsx | InitialStatusForm |  |
| page.tsx | InitialBatchStatusPage |  |
| **app/config/batch-level/** | | |
| actions.ts | saveBatchLevelAction, prepareConversionAction |  |
| BatchLevelForm.tsx | BatchLevelForm |  |
| page.tsx | BatchLevelPage |  |
| **app/config/batch-management/** | | |
| page.tsx | BatchManagementImgPage |  |
| **app/config/batch-number-assignment/** | | |
| actions.ts | saveInternalAssignmentAction, saveAssignedReceiptAction |  |
| BatchNumberAssignmentForm.tsx | BatchNumberAssignmentForm |  |
| page.tsx | BatchNumberAssignmentPage |  |
| **app/config/batch-number-ranges/** | | |
| actions.ts | saveBatchIntervalAction, deleteBatchIntervalAction, adjustBatchIntervalAction |  |
| BatchNumberRangeForms.tsx | BatchNumberRangeForms |  |
| page.tsx | BatchNumberRangesPage |  |
| **app/config/batch-search-allocations/** | | |
| actions.ts | saveBatchSearchAllocationAction, deleteBatchSearchAllocationAction |  |
| AllocationForm.tsx | AllocationForm |  |
| page.tsx | BatchSearchAllocationPage |  |
| **app/config/batch-search-procedures/** | | |
| actions.ts | saveBatchSearchProcedureAction, deleteBatchSearchProcedureAction, saveBatchSearchProcedureStepAction, deleteBatchSearchProcedureStepAction |  |
| page.tsx | BatchSearchProcedurePage |  |
| SearchProcedureForm.tsx | SearchProcedureForm |  |
| **app/config/batch-status-plants/** | | |
| actions.ts | savePlantBatchStatusAction |  |
| page.tsx | PlantBatchStatusPage |  |
| PlantBatchStatusForm.tsx | PlantBatchStatusForm |  |
| **app/config/batch-status/** | | |
| actions.ts | saveBatchStatusAction |  |
| BatchStatusForm.tsx | BatchStatusForm |  |
| page.tsx | BatchStatusPage |  |
| **app/config/batch-strategy-types/** | | |
| actions.ts | saveBatchStrategyTypeAction, deleteBatchStrategyTypeAction |  |
| page.tsx | BatchStrategyTypePage |  |
| StrategyTypeForm.tsx | StrategyTypeForm |  |
| **app/config/industry-sectors/** | | |
| actions.ts | saveIndustrySectorAction, setIndustrySectorActiveAction, deleteIndustrySectorAction |  |
| IndustrySectors.tsx | IndustrySectors |  |
| page.tsx | IndustrySectorsPage |  |
| **app/config/material-groups/** | | |
| actions.ts | saveMaterialGroupAction, setMaterialGroupActiveAction, deleteMaterialGroupAction |  |
| MaterialGroups.tsx | MaterialGroups |  |
| page.tsx | MaterialGroupsPage |  |
| **app/config/material-number-ranges/** | | |
| actions.ts | saveMaterialRangeGroupAction, deleteMaterialRangeGroupAction |  |
| MaterialNumberRanges.tsx | MaterialNumberRanges |  |
| page.tsx | MaterialNumberRangesPage |  |
| **app/config/material-period-control/** | | |
| actions.ts | initializeMaterialPeriodAction, setMaterialPeriodIndicatorsAction, shiftMaterialPeriodAction |  |
| MaterialPeriodControl.tsx | MaterialPeriodControl |  |
| page.tsx | MaterialPeriodControlPage |  |
| **app/config/material-types/** | | |
| actions.ts | saveMaterialTypeAction, setMaterialTypeActiveAction, deleteMaterialTypeAction, saveAccountCategoryReferenceAction, deleteAccountCategoryReferenceAction, saveTypeValuationAction |  |
| MaterialTypes.tsx | MaterialTypes |  |
| page.tsx | MaterialTypesPage |  |
| **app/config/movement-types/** | | |
| actions.ts | saveMovementTypeAction, checkMovementTypeAction, deleteMovementTypeAction |  |
| MovementTypes.tsx | MovementTypes |  |
| page.tsx | MovementTypesPage |  |
| **app/config/mrp-controllers/** | | |
| actions.ts | saveMrpControllerAction, setMrpControllerActiveAction, deleteMrpControllerAction |  |
| MrpControllers.tsx | MrpControllers |  |
| **app/config/scheduling-profiles/** | | |
| actions.ts | saveSchedulingProfileAction, assignSchedulingProfileAction |  |
| page.tsx | SchedulingProfilesPage |  |
| SchedulingProfileForm.tsx | SchedulingProfileForm |  |
| **app/config/valuation-classes/** | | |
| actions.ts | saveReferenceAction, deleteReferenceAction, saveClassAction, deleteClassAction, assignTypeAction, checkValuationAction |  |
| page.tsx | ValuationClassesPage |  |
| ValuationClasses.tsx | ValuationClasses |  |
| **app/inventory/batch-classes/** | | |
| actions.ts | saveBatchClassAction |  |
| ClassForm.tsx | ClassForm |  |
| page.tsx | BatchClassPage |  |
| **app/inventory/batch-cockpit/** | | |
| page.tsx | BatchCockpitPage |  |
| **app/inventory/batch-pickup/** | | |
| BatchPickupShell.tsx | BatchPickupShell |  |
| page.tsx | BatchPickupPage |  |
| **app/inventory/batch-search-strategies/** | | |
| actions.ts | saveBatchSearchStrategyAction, deleteBatchSearchStrategyAction |  |
| page.tsx | BatchSearchStrategyPage |  |
| StrategyForm.tsx | StrategyForm |  |
| **app/inventory/batch-sort-sequences/** | | |
| actions.ts | saveSortSequenceAction, deleteSortSequenceAction |  |
| page.tsx | BatchSortSequencePage |  |
| SortForm.tsx | SortForm |  |
| **app/inventory/batches/** | | |
| BatchRelations.tsx | BatchRelations |  |
| DocumentTab.tsx | DocumentTab |  |
| **app/inventory/batches/change/** | | |
| actions.ts | changeBatchAction |  |
| ChangeBatchForm.tsx | ChangeBatchForm |  |
| page.tsx | ChangeBatchPage |  |
| **app/inventory/batches/display/** | | |
| page.tsx | DisplayBatchPage |  |
| **app/inventory/batches/new/** | | |
| actions.ts | createBatchAction |  |
| CreateBatchForm.tsx | CreateBatchForm |  |
| page.tsx | CreateBatchPage |  |
| **app/inventory/goods-issue/** | | |
| actions.ts | postGoodsIssueAction |  |
| GoodsIssue.tsx | GoodsIssue |  |
| page.tsx | GoodsIssuePage |  |
| **app/inventory/goods-receipt/** | | |
| actions.ts | postGoodsReceiptAction, reverseGoodsReceiptAction |  |
| GoodsReceipt.tsx | GoodsReceipt |  |
| page.tsx | GoodsReceiptPage |  |
| **app/inventory/material-document-list/** | | |
| MaterialDocumentListShell.tsx | MaterialDocumentListShell |  |
| page.tsx | MaterialDocumentListPage |  |
| **app/inventory/material-document-output/** | | |
| actions.ts | runOutputsAction, dispatchOneAction, recipientAction, downloadSlipPdfAction |  |
| MaterialDocumentOutput.tsx | MaterialDocumentOutput |  |
| page.tsx | MaterialDocumentOutputPage |  |
| **app/inventory/material-documents/** | | |
| page.tsx | MaterialDocumentPage |  |
| **app/inventory/materials/** | | |
| actions.ts | saveMaterialAction, setMaterialDeletionFlagAction |  |
| DeletionFlags.tsx | DeletionFlags |  |
| MaterialForm.tsx | MaterialForm |  |
| page.tsx | MaterialsPage |  |
| shelf-life-action.ts | saveMaterialShelfLifeAction |  |
| ShelfLifePanel.tsx | ShelfLifePanel |  |
| **app/inventory/migo/** | | |
| actions.ts | postMigoAction, postReceiptAction, postTransferAction, postReversalAction |  |
| MigoShell.tsx | MigoShell |  |
| page.tsx | MigoPage |  |
| **app/inventory/physical-inventory-count/** | | |
| actions.ts | submitCountsAction, clearCountAction |  |
| CountWorkbench.tsx | CountWorkbench |  |
| page.tsx | PhysicalInventoryCountPage |  |
| **app/inventory/physical-inventory-differences/** | | |
| actions.ts | openDifferenceWorkflowAction |  |
| DifferenceList.tsx | DifferenceList |  |
| page.tsx | PhysicalInventoryDifferencesPage |  |
| **app/inventory/physical-inventory-posting/** | | |
| actions.ts | checkPostingAction, postDifferencesAction, reversePostingAction |  |
| page.tsx | PhysicalInventoryPostingPage |  |
| PostingWorkbench.tsx | PostingWorkbench |  |
| **app/inventory/physical-inventory-recount/** | | |
| actions.ts | checkRecountAction, createRecountAction, cancelRecountAction |  |
| page.tsx | PhysicalInventoryRecountPage |  |
| RecountWorkbench.tsx | RecountWorkbench |  |
| **app/inventory/physical-inventory/** | | |
| actions.ts | createPhysicalInventoryAction, cancelPhysicalInventoryAction, cancelListedAction |  |
| CancelListed.tsx | CancelListed |  |
| page.tsx | PhysicalInventoryPage |  |
| PhysicalInventoryShell.tsx | PhysicalInventoryShell |  |
| **app/inventory/price-change/** | | |
| actions.ts | savePriceChangeAction, releaseFuturePriceAction |  |
| page.tsx | PriceChangePage |  |
| PriceChange.tsx | PriceChange |  |
| **app/inventory/reservations/** | | |
| actions.ts | createReservationAction, withdrawReservationAction, completeItemAction |  |
| page.tsx | ReservationsPage |  |
| Reservations.tsx | Reservations |  |
| **app/inventory/return-delivery/** | | |
| actions.ts | loadReferenceAction, postReturnAction |  |
| page.tsx | ReturnDeliveryPage |  |
| ReturnDeliveryShell.tsx | ReturnDeliveryShell |  |
| **app/inventory/reversal/** | | |
| actions.ts | reverseMaterialDocumentAction |  |
| page.tsx | ReversalPage |  |
| Reversal.tsx | Reversal |  |
| **app/inventory/serial-numbers/** | | |
| actions.ts | saveSerialAction |  |
| page.tsx | SerialNumbersPage |  |
| SerialNumbers.tsx | SerialNumbers |  |
| **app/inventory/shelf-life-list/** | | |
| page.tsx | ShelfLifeListPage |  |
| ShelfLifeListShell.tsx | ShelfLifeListShell |  |
| **app/inventory/stock-ageing/** | | |
| page.tsx | StockAgeingPage |  |
| StockAgeingShell.tsx | StockAgeingShell |  |
| **app/inventory/stock-overview/** | | |
| page.tsx | StockOverviewPage |  |
| StockOverviewShell.tsx | StockOverviewShell |  |
| **app/inventory/stock-posting-date/** | | |
| page.tsx | StockPostingDatePage |  |
| StockOnPostingDateShell.tsx | StockOnPostingDateShell |  |
| **app/inventory/stock-reconcile/** | | |
| actions.ts | rebuildAction |  |
| page.tsx | StockReconcilePage |  |
| ReconcileShell.tsx | ReconcileShell |  |
| **app/inventory/transfer-posting/** | | |
| actions.ts | postTransferAction, checkTransferAction, reverseTransferAction |  |
| page.tsx | TransferPostingPage |  |
| TransferPosting.tsx | TransferPosting |  |
| **app/inventory/uom-conversion/** | | |
| actions.ts | defineConversionAction, deleteConversionAction |  |
| page.tsx | UomConversionPage |  |
| UomShell.tsx | UomShell |  |
| **app/inventory/warehouse-stocks/** | | |
| page.tsx | WarehouseStocksPage |  |
| WarehouseStocksShell.tsx | WarehouseStocksShell |  |
| **modules/inventory/** | | |
| balance-update.ts | REQUEST_MISMATCH_REMEDY, postingFingerprint, quantityToken, lockRequestKey, mismatchedRequest, applyValuationDelta | material_document, material_valuation |
| batch-access-sequence.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, USAGE, APPLICATION, NOT_EXECUTED, BatchAccessSequenceError, listBatchAccessSequences, saveBatchAccessSequence, deleteBatchAccessSequence, listBatchAccessSteps, saveBatchAccessStep, deleteBatchAccessStep | batch_access_sequence, batch_access_step, batch_condition_table, batch_search_strategy, batch_strategy_type |
| batch-change.ts | ACTIVITY, ROUTE, ALIASES, LOCK_OBJECT, BatchChangeError, readBatch, changeBatch | batch, batch_level_configuration, batch_status_management, country |
| batch-class.ts | ACTIVITY, ROUTE, ALIAS, CHANGE_ALIAS, DISPLAY_ALIAS, LOCK_OBJECT, PLANT_BATCH_CLASS_TYPE, MATERIAL_BATCH_CLASS_TYPE, BATCH_CLASS_TYPES, NOT_EXECUTED, BatchClassError, listBatchClasses, saveBatchClass, evaluateBatchClass | batch_level_configuration, characteristic, class_assignment, class_type, classification_class |
| batch-classification-vocabulary.ts | CLASSIFICATION_CODES, CLASSIFICATION_MEANING |  |
| batch-classification.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, NOT_EXECUTED, BatchClassificationError, classificationOf, listBatchClassification, saveBatchClassification, batchClassificationRefusal, CLASSIFICATION_CODES, CLASSIFICATION_MEANING | movement_type |
| batch-cockpit.ts | ACTIVITY, ALIAS, ROUTE, NOT_STORED, BatchCockpitError, traceBatchGenealogy, searchBatches, readBatchCockpit | batch, material, material_document, material_document_line, plant, purchase_order, stock_quantity |
| batch-condition-table.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, USAGE, APPLICATION, ALLOWED_FIELDS, NOT_EXECUTED, BatchConditionTableError, listBatchConditionTables, saveBatchConditionTable, deleteBatchConditionTable | batch_access_step, batch_condition_table, batch_condition_table_field, batch_search_strategy |
| batch-control-use.ts | noteBatchControlUse | batch_search_allocation, batch_sort_sequence, material_document_line |
| batch-conversion.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, NOT_EXECUTED, BatchConversionError, listConversionChecks, checkBatchConversion, executeBatchConversion | batch, batch_conversion_check, batch_conversion_conflict, batch_level_configuration, batch_status_management, batch_status_plant, classification_class |
| batch-display.ts | ACTIVITY, ROUTE, ALIASES, BatchDisplayError, batchStatusLabel, displayBatch, BatchChangeError | batch |
| batch-document-management.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, NOT_EXECUTED, BatchDocumentError, documentManagementActive, getBatchDocumentManagement, saveBatchDocumentManagement, linkBatchDocument | batch_document_management |
| batch-level.ts | ACTIVITY, ROUTE, ALIASES, LOCK_OBJECT, BatchLevelError, BATCH_LEVELS, dependentBatchData, getBatchLevel, latestConversion, saveBatchLevel, prepareBatchLevelConversion, executeBatchLevelConversion, createBatchIdentity | batch, batch_level_configuration, batch_level_conversion, material, material_document_line, plant, stock_quantity |
| batch-management-img.ts | ACTIVITY, ROUTE, ALIAS, BATCH_IMG_NODES, RELATED_BATCH_NODES, NOT_OCHA, NOT_OPENED |  |
| batch-master.ts | ACTIVITY, ROUTE, ALIASES, LOCK_OBJECT, BatchMasterError, readLevel, createBatch | batch, batch_level_configuration, country, material, material_plant |
| batch-number-assignment.ts | ACTIVITY, ROUTE, ALIASES, LOCK_OBJECT, PLANT_LOCK_OBJECT, BATCH_NUMBER_OBJECT, BATCH_NUMBER_INTERVAL, BatchNumberAssignmentError, internalAssignmentActive, getInternalBatchAssignment, saveInternalBatchAssignment, listAssignedReceiptSettings, saveAssignedReceipt, assignedGoodsReceiptDecision, readAssignedGoodsReceiptDecision, productionBatchAssignment, allocateInternalBatchNumber | batch_assigned_receipt, batch_number_assignment, number_range, plant |
| batch-number-range.ts | ACTIVITY, ROUTE, ALIASES, LOCK_OBJECT, BATCH_NUMBER_OBJECT, INTERNAL_INTERVAL, EXTERNAL_INTERVAL, BATCH_NUMBER_LENGTH, BatchNumberRangeError, displayBatchNumber, getBatchNumberRanges, saveBatchNumberInterval, deleteBatchNumberInterval, adjustBatchNumberStatus, assertExternalBatchNumber | batch, number_range, number_range_allocation, number_range_object |
| batch-pickup.ts | BATCH_PICKUP_CAPABILITY, BATCH_PICKUP_ALIAS, BATCH_PICKUP_ROUTE, BatchPickupError, listBatchPickup | batch, material, material_document, material_document_line, plant |
| batch-posting.ts | BatchPostingError, resolvePostingBatch | batch, batch_level_configuration, batch_status_management, material, material_plant |
| batch-search-allocation.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, USAGE, APPLICATION, OWN_STOCK, NOT_EXECUTED, BatchSearchAllocationError, listBatchSearchAllocations, resolveBatchSearchAllocation, checkEnteredBatch, saveBatchSearchAllocation, deleteBatchSearchAllocation | batch_search_allocation, batch_search_procedure, movement_type |
| batch-search-procedure.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, USAGE, APPLICATION, NOT_EXECUTED, BatchSearchProcedureError, listBatchSearchProcedures, saveBatchSearchProcedure, deleteBatchSearchProcedure, listBatchSearchProcedureSteps, saveBatchSearchProcedureStep, deleteBatchSearchProcedureStep | batch_search_allocation, batch_search_procedure, batch_search_procedure_step, batch_strategy_type |
| batch-search-strategy.ts | ACTIVITY, ROUTE, ALIAS, CHANGE_ALIAS, DISPLAY_ALIAS, LOCK_OBJECT, USAGE, APPLICATION, NOT_EXECUTED, BatchSearchStrategyError, listStrategyKeyCombinations, listBatchSearchStrategies, resolveBatchSearchStrategy, determineBatch, saveBatchSearchStrategy, deleteBatchSearchStrategy | batch_access_step, batch_condition_table_field, batch_level_configuration, batch_search_strategy, batch_search_strategy_key, batch_strategy_type, bp_role, business_partner, material, material_group, material_plant, material_type, movement_type, plant, storage_location |
| batch-sort-sequence-vocabulary.ts | SORT_STATUS |  |
| batch-sort-sequence.ts | ACTIVITY, ROUTE, ALIAS, CHANGE_ALIAS, DISPLAY_ALIAS, LOCK_OBJECT, NOT_EXECUTED, BatchSortError, listSortSequences, saveSortSequence, deleteSortSequence, rankSuppliedCandidates, determineBatches, SORT_STATUS | batch_sort_sequence, batch_sort_sequence_criterion, characteristic, class_assignment |
| batch-status-plant.ts | ACTIVITY, ROUTE, ALIASES, LOCK_OBJECT, BatchStatusPlantError, readPlantBatchStatusActive, listPlantBatchStatus, listPlantStatusConversions, validatePlantBatchStatus, savePlantBatchStatus, executePlantStatusConversion | batch, batch_level_configuration, batch_status_management, batch_status_plant, batch_status_plant_conversion, material_document_line, plant, stock_quantity |
| batch-status.ts | ACTIVITY, ROUTE, ALIASES, LOCK_OBJECT, BatchStatusError, batchStatusScope, getBatchStatusManagement, saveBatchStatus, executeBatchStatusConversion | batch, batch_level_configuration, batch_status_management |
| batch-strategy-type.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, USAGE, APPLICATION, NOT_EXECUTED, BatchStrategyTypeError, listBatchStrategyTypes, saveBatchStrategyType, deleteBatchStrategyType | batch_access_sequence, batch_search_procedure_step, batch_search_strategy, batch_strategy_type |
| constants.ts | MATERIAL_VIEWS, MATERIAL_VIEW_CAPABILITY, MATERIAL_PANEL_VIEWS, isMaterialPanelView, MRP_TYPES, PROCUREMENT_TYPES, LOT_PROCEDURES, PRICE_CONTROLS, ITEM_CATEGORY_GROUPS |  |
| development-fixture.ts | seedDevelopmentMaterials |  |
| form-values.ts | materialFormValue |  |
| goods-issue.ts | GOODS_ISSUE_CAPABILITY, PRODUCTION_ORDER_ISSUE_CAPABILITY, SALES_GOODS_ISSUE_CAPABILITY, GOODS_ISSUE_ALIAS, GOODS_ISSUE_ROUTE, GoodsIssueError, GOODS_ISSUE_SCENARIOS, MB1A_SCENARIOS, SALES_ISSUE_SCENARIOS, MIGO_ISSUE_SCENARIOS, DELIVERED_GOODS_ISSUE_MOVEMENTS, getMaterialPeriodControlInTx, postGoodsIssue | account_determination, app_user, auth_org_restriction, cost_center, material, material_document, material_document_line, material_period_control, material_plant, material_valuation, movement_type, plant, production_order, production_order_component, reservation_item, role, role_capability, stock_quantity, user_role, user_session |
| goods-receipt.ts | GR_POST_CAPABILITY, GoodsReceiptError, DELIVERED_MOVEMENTS, accountAssignedReceiptRefusal, getReceiptOrder, getMaterialDocument, postGoodsReceipt, reverseGoodsReceipt | account_determination, app_user, auth_org_restriction, capability, document_release, material, material_document, material_document_line, material_period_control, material_plant, material_valuation, movement_type, plant, purchase_order, purchase_order_item, role, role_capability, stock_quantity, user_role, user_session |
| industry-sector-definition.ts | ACTIVITY, IndustrySectorError, INDUSTRY_SECTOR_DEFAULTS, listIndustrySectors, saveIndustrySector, setIndustrySectorActive, deleteIndustrySector | industry_sector, material |
| initial-batch-status.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, InitialBatchStatusError, decideInitialRestrictedUse, listInitialBatchStatus, saveInitialBatchStatus | batch_level_configuration, batch_status_management, batch_status_plant, material_type |
| initial-stock.ts | INITIAL_STOCK_CAPABILITY, INITIAL_STOCK_MOVEMENT, INITIAL_STOCK_DESCRIPTION, InitialStockError, postInitialStock | account_determination, app_user, auth_org_restriction, capability, material, material_document, material_document_line, material_plant, material_valuation, movement_type, plant, role, role_capability, stock_quantity, user_role, user_session |
| material-document-accounting.ts | JOURNAL_ACCOUNTING_NOTE, readJournalStatus, describeJournalAccounting, accountingForOriginal | journal_entry |
| material-document-display.ts | MATERIAL_DOC_DISPLAY_CAPABILITY, MATERIAL_DOC_DISPLAY_ALIAS, MATERIAL_DOC_DISPLAY_ROUTE, MaterialDocumentDisplayError, displayMaterialDocument | material, material_document, material_document_line, movement_type, plant |
| material-document-list.ts | MATERIAL_DOC_LIST_CAPABILITY, MATERIAL_DOC_LIST_ALIAS, DEFAULT_MAX_HITS, MAX_HITS_CAP, MaterialDocListError, listMaterialDocuments | app_user, batch, material, material_document, material_document_line, movement_type, purchase_order, stock_quantity |
| material-document-output.ts | MATERIAL_DOC_OUTPUT_CAPABILITY, MATERIAL_DOC_OUTPUT_ALIAS, MATERIAL_DOC_OUTPUT_ROUTE, MaterialDocumentOutputError, OUTPUT_MEDIA, REFUSED_MEDIA, OUTPUT_STATUSES, STATUS_ALIASES, DISPATCH_TIMES, DELIVERED_OUTPUT_TYPES, DEFAULT_MAX_HITS, MAX_HITS_CAP, recordOutputsForDocument, recordOutputsForPostedDocument, listOutputMessages, determineOutputs, renderSlipIn, renderSlip, dispatchMessage, processMaterialOutputMessage, dispatchPending, setRecipient, materialOutputPdf, materialDocumentCompanyCode | material, material_document, material_document_line, movement_type, output_message, output_type, plant |
| material-document-reversal.ts | REVERSE_CAPABILITY, MaterialReversalError, getReversalDocument, reverseMaterialDocument | journal_entry, material_document, material_document_line, material_period_control, material_valuation, movement_type, plant, stock_quantity, storage_location |
| material-group-definition.ts | ACTIVITY, MaterialGroupError, listMaterialGroups, saveMaterialGroup, setMaterialGroupActive, deleteMaterialGroup | material, material_group |
| material-number-range-groups.ts | ACTIVITY, MaterialRangeGroupError, listMaterialNumberRangeGroups, listMaterialRangeGroupOptions, saveMaterialNumberRangeGroup, deleteMaterialNumberRangeGroup | material_number_range_group, material_type, number_range |
| material-period-control.ts | ACTIVITY, MaterialPeriodError, listMaterialPeriodControl, getMaterialPeriodControl, materialPeriodAllows, initializeMaterialPeriodControl, setMaterialPeriodIndicators, shiftMaterialPeriod | company_code, fiscal_year_variant, material_period_control |
| material-shelf-life.ts | SHELF_LIFE_PERIODS, MaterialShelfLifeError, getMaterialShelfLife, saveMaterialShelfLife | material |
| material-type-definition.ts | ACTIVITY, MaterialTypeError, listMaterialTypes, listAccountCategoryReferences, listTypeValuation, listValuationPlants, saveMaterialType, setMaterialTypeActive, deleteMaterialType, saveAccountCategoryReference, deleteAccountCategoryReference, saveTypeValuation | account_category_reference, material, material_number_range_group, material_plant, material_type, material_type_valuation, number_range, plant, valuation_class_reference |
| materials.ts | MaterialError, saveMaterialView, setMaterialDeletionFlag, materialChoices, listMaterials, getMaterialDetail, requireUsableMaterial | account_category_reference, company_code, distribution_channel, industry_sector, material, material_group, material_plant, material_sales, material_type, material_type_valuation, material_uom_conversion, material_valuation, mrp_controller, number_range, planning_file, plant, purchasing_group, sales_org, unit_of_measure, valuation_class, valuation_class_reference |
| migo.ts | MIGO_CAPABILITY, MIGO_ROUTE, MIGO_ALIAS, MIGO_ACTIONS, MIGO_REFERENCES, resolveMigoCell, migoMatrix |  |
| movement-type-configuration.ts | ACTIVITY, ROUTE, MovementTypeConfigError, listMovementTypes, checkMovementType, saveMovementType, deleteMovementType | batch_search_allocation, change_document, material_document_line, movement_type, reservation_header |
| movement-type-vocabulary.ts | MOVEMENT_DIRECTIONS, MOVEMENT_REFERENCES, MOVEMENT_KINDS, MOVEMENT_STOCK_TYPES, MOVEMENT_RULES, MOVEMENT_NEGATIVE_POLICIES, MOVEMENT_ASSIGNMENTS |  |
| mrp-controller-key.ts | ACTIVITY, MRP_CONTROLLER_ROUTE, LOCK_OBJECT, mrpControllerKey, parseMrpControllerKey |  |
| mrp-controller-maintenance.ts | MrpControllerError, listMrpControllers, saveMrpController, setMrpControllerActive, deleteMrpController, seedMrpController, ACTIVITY, LOCK_OBJECT, MRP_CONTROLLER_ROUTE, mrpControllerKey, parseMrpControllerKey | material, material_plant, mrp_controller, plant |
| physical-inventory-count.ts | PHYSICAL_INVENTORY_COUNT_CAPABILITY, PHYSICAL_INVENTORY_COUNT_CORRECT_CAPABILITY, PHYSICAL_INVENTORY_COUNT_ROUTE, PHYSICAL_INVENTORY_COUNT_ALIASES, countNamedRefusal, PhysicalInventoryCountError, getCountDocument, searchCountDocuments, submitCounts, clearCount, getCountHistory, getCountStatus | change_document, material, physical_inventory_document, physical_inventory_item, plant, stock_quantity |
| physical-inventory-differences.ts | PHYSICAL_INVENTORY_DIFF_LIST_CAPABILITY, PHYSICAL_INVENTORY_DIFF_LIST_ROUTE, PHYSICAL_INVENTORY_DIFF_LIST_ALIASES, DIFFERENCE_PAGE_SIZE_DEFAULT, DIFFERENCE_PAGE_SIZE_MAX, PhysicalInventoryDifferenceError, labelOf, directionOf, listDifferences, getDifferenceDocument, openDifferenceWorkflow | currency, material, material_valuation, physical_inventory_document, physical_inventory_item, plant, storage_location |
| physical-inventory-posting-status.ts | releaseDifferenceAllocations, recomputePostingStatus | physical_inventory_difference_allocation, physical_inventory_document, physical_inventory_item |
| physical-inventory-posting.ts | PHYSICAL_INVENTORY_DIFF_POST_CAPABILITY, PHYSICAL_INVENTORY_DIFF_POST_ROUTE, PHYSICAL_INVENTORY_DIFF_POST_ALIASES, PhysicalInventoryPostingError, getDifferencePosting, validateDifferencePosting, postDifferences, getPostingHistory, reverseDifferencePosting | account_determination, currency, material, material_document, material_document_line, material_valuation, movement_type, physical_inventory_difference_allocation, physical_inventory_document, physical_inventory_item, plant, stock_quantity, storage_location |
| physical-inventory-recount.ts | PHYSICAL_INVENTORY_RECOUNT_CAPABILITY, PHYSICAL_INVENTORY_RECOUNT_ROUTE, PhysicalInventoryRecountError, validateRecount, createRecount, cancelRecount, recountPostingBlock, recountCountRemedy, syncRecountLink, getRecountSource, getRecountComparison | physical_inventory_difference_allocation, physical_inventory_document, physical_inventory_item, physical_inventory_recount_link, stock_quantity |
| physical-inventory.ts | PHYSICAL_INVENTORY_CREATE_CAPABILITY, PHYSICAL_INVENTORY_CANCEL_CAPABILITY, PHYSICAL_INVENTORY_ROUTE, PHYSICAL_INVENTORY_ALIASES, PhysicalInventoryError, writeInventoryDocument, createPhysicalInventory, cancelPhysicalInventory, listPhysicalInventory, lockStockScope, tryLockStockScope, assertInventoryCountOpen | batch, batch_level_configuration, material, material_plant, physical_inventory_document, physical_inventory_item, plant, stock_quantity |
| price-change.ts | PRICE_CHANGE_CAPABILITY, PRICE_CHANGE_ROUTE, PriceChangeError, changeMaterialPrice, releaseFuturePrices, listFuturePrices | account_determination, journal_entry, material, material_document, material_document_line, material_valuation, plant |
| production-document-quantity.ts | lineNotReversed, lineReversalDisagreement, OPEN_PRODUCTION_DOCUMENT, REVERSAL_QUANTITY_DISAGREEMENT | material, material_document_line |
| production-orders.ts | PRODUCTION_ORDER_CAPABILITY, PRODUCTION_ORDER_RELEASE_CAPABILITY, PRODUCTION_ORDER_ROUTE, PRODUCTION_ORDER_ALIAS, ProductionOrderError, getProductionOrder, previewProductionOrderBom, createProductionOrder, releaseProductionOrder | controlling_area, controlling_area_company, material, material_plant, plant, production_order, production_order_component, production_order_type |
| production-receipt.ts | PRODUCTION_RECEIPT_CAPABILITY, PRODUCTION_RECEIPT_SCENARIO, ProductionReceiptError, postProductionReceipt, receivedQuantityFor | account_determination, material, material_document, material_document_line, material_plant, material_valuation, movement_type, plant, production_order, stock_quantity |
| report-exports.ts | stockOverviewExport, materialDocumentListExport, shelfLifeExport, INVENTORY_REPORT_EXPORTS |  |
| reservations.ts | RESERVATION_CREATE_CAPABILITY, ReservationError, RESERVATION_SCENARIOS, DELIVERED_RESERVATION_MOVEMENTS, getReservation, createReservation, withdrawReservation, withdrawReservationInTx, completeReservationItem | cost_center, material, material_plant, movement_type, plant, reservation_header, reservation_item |
| return-delivery.ts | RETURN_CAPABILITY, RETURN_ALIASES, RETURN_MOVEMENT_CODE, RETURN_REVERSAL_MOVEMENT_CODE, ReturnDeliveryError, DELIVERED_RETURN_MOVEMENTS, resolveReturnMovement, getReturnableDocument, getReturnDocument, postReturnDelivery | account_determination, material, material_document, material_document_line, material_plant, material_valuation, movement_type, plant, purchase_order_item, stock_quantity |
| scheduling-profile.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, SchedulingProfileError, listSchedulingProfiles, saveSchedulingProfile, assignSchedulingProfile, readMaterialSchedulingProfile, ensureOrderBatch, NOT_EXECUTED | batch, material, material_plant, plant, production_scheduling_profile |
| schema.ts | accountCategoryReference, industrySector, materialType, materialTypeValuation, materialGroup, materialPeriodControl, materialNumberRangeGroup, valuationClass, valuationClassReference, mrpController, material, materialPlant, materialSales, materialValuation, planningFile, movementType, materialDocument, materialDocumentLine, stockQuantity, reservationHeader, reservationItem, productionOrder, productionSchedulingProfile, productionOrderComponent, physicalInventoryDocument, physicalInventoryItem, physicalInventoryDifferenceAllocation, physicalInventoryRecountLink, materialUomConversion, batchLevelConfiguration, batchLevelConversion, SERIAL_STATUSES_DB, serialNumber, batch, batchStatusManagement, batchStatusPlant, batchStatusPlantConversion, batchNumberAssignment, batchAssignedReceipt, batchConditionTable, batchConditionTableField, batchAccessSequence, batchAccessStep, batchSearchProcedure, batchSearchProcedureStep, batchSearchAllocation, batchSearchStrategy, batchSearchStrategyKey, batchStrategyType, batchSortSequence, batchSortSequenceCriterion, batchConversionCheck, batchConversionConflict, batchDocumentManagement | account_category_reference, batch, batch_access_sequence, batch_access_step, batch_assigned_receipt, batch_condition_table, batch_condition_table_field, batch_conversion_check, batch_conversion_conflict, batch_document_management, batch_level_configuration, batch_level_conversion, batch_number_assignment, batch_search_allocation, batch_search_procedure, batch_search_procedure_step, batch_search_strategy, batch_search_strategy_key, batch_sort_sequence, batch_sort_sequence_criterion, batch_status_management, batch_status_plant, batch_status_plant_conversion, batch_strategy_type, industry_sector, material, material_document, material_document_line, material_group, material_number_range_group, material_period_control, material_plant, material_sales, material_type, material_type_valuation, material_uom_conversion, material_valuation, movement_type, mrp_controller, physical_inventory_difference_allocation, physical_inventory_document, physical_inventory_item, physical_inventory_recount_link, planning_file, production_order, production_order_component, production_scheduling_profile, reservation_header, reservation_item, serial_number, stock_quantity, valuation_class, valuation_class_reference |
| serial-number.ts | SERIAL_ROUTE, SERIAL_CAPABILITY, SerialNumberError, serialNumberInput, requiresSerialFor, saveSerialNumber, listSerialNumbers, capturePickSerialsOn, releasePickSerialsOn, serialsOfPick, SERIAL_STATUSES, SERIAL_STATUS_MEANING | delivery_picking_serial, material, serial_number |
| serial-status.ts | SERIAL_STATUSES, SERIAL_STATUS_MEANING |  |
| shelf-life-list.ts | SLED_LIST_CAPABILITY, SLED_LIST_ALIAS, SLED_LIST_ROUTE, DEFAULT_MAX_HITS, MAX_HITS_CAP, ShelfLifeListError, businessDate, listShelfLife | batch, material, material_document_line, plant, stock_quantity, storage_location |
| standard-config.ts | TYPE_UPDATING_DEFAULTS, seedTypeValuationForPlant, applyMaterialDefaults | account_category_reference, industry_sector, material_group, material_type, material_type_valuation, plant, valuation_class, valuation_class_reference |
| stock-ageing.ts | STOCK_AGEING_CAPABILITY, STOCK_AGEING_ALIASES, DEFAULT_MAX_HITS, MAX_HITS_CAP, DEFAULT_STOCK_TYPE, DEFAULT_AGE_BUCKETS, MAX_AGE_BUCKETS, DEFAULT_SLOW_MOVING_DAYS, DEFAULT_NON_MOVING_DAYS, DRIFT_TOLERANCE, StockAgeingError, bucketLabels, stockAgeing | material, material_document, material_document_line, material_valuation, movement_type, plant, stock_quantity |
| stock-overview.ts | STOCK_OVERVIEW_CAPABILITY, STOCK_OVERVIEW_ALIAS, UNRESTRICTED, QUALITY, BLOCKED, EXPANSION_LEVELS, DEFAULT_MAX_HITS, MAX_HITS_CAP, StockOverviewError, stockOverview | batch_level_configuration, material, material_document, plant, stock_quantity, storage_location |
| stock-posting-date.ts | STOCK_POSTINGDATE_CAPABILITY, STOCK_POSTINGDATE_ALIAS, DEFAULT_STOCK_TYPE, DEFAULT_MAX_HITS, MAX_HITS_CAP, StockPostingDateError, stockOnPostingDate | batch, material, material_document, material_document_line, movement_type, stock_quantity, storage_location |
| stock-reconcile.ts | StockReconcileError, RECONCILE_CAPABILITY, RECONCILE_ALIASES, reconcileStock, rebuildStockDimension | material_document, material_document_line, stock_quantity |
| stock-types.ts | UNRESTRICTED, QUALITY_INSPECTION, BLOCKED, RETURNS |  |
| storage-location.ts | StorageLocationError, storageLocationRequired, proposeStorageLocation, resolveStorageLocation | material, material_type_valuation, plant, storage_location |
| transfer-posting.ts | TRANSFER_POST_CAPABILITY, TransferPostingError, getTransferDocument, transferStockAt, validateTransfer, postTransfer, postTransferInTx, reverseTransfer, DELIVERED_TRANSFER_MOVEMENTS, TRANSFER_SCENARIOS | account_determination, material, material_document, material_document_line, material_period_control, material_plant, material_valuation, movement_type, plant, stock_quantity, storage_location |
| transfer-scenarios.ts | TRANSFER_SCENARIOS, MOVEMENT_CHOICES, COUNTER_CODES, DELIVERED_TRANSFER_MOVEMENTS |  |
| unit-conversion.ts | UOM_CAPABILITY, UnitConversionError, toBaseQuantity, fromBaseQuantity, roundTo, defineUomConversion, listUomConversions, listUnitsOfMeasure, removeUomConversion, convertUnits | material, material_uom_conversion, unit_of_measure |
| valuation-class-definition.ts | ACTIVITY, ROUTE, ValuationClassError, listValuationReferences, listValuationClasses, listTypeReferences, listValuationGaps, valuationClassRefusal, postingValuationRefusal, referenceChangeBlock, saveValuationReference, deleteValuationReference, saveValuationClass, deleteValuationClass, assignMaterialTypeReference | account_category_reference, account_determination, change_document, material, material_type, material_valuation, valuation_class, valuation_class_reference |
| valuation-class-permission.ts | namedMaterialTypes, classPermittedForType |  |
| warehouse-stocks.ts | WAREHOUSE_STOCK_CAPABILITY, WAREHOUSE_STOCK_ALIAS, SCOPE_OF_LIST_OPTIONS, DEFAULT_MAX_HITS, MAX_HITS_CAP, WarehouseStockError, listWarehouseStocks, UNRESTRICTED, QUALITY_INSPECTION, BLOCKED, RETURNS | batch, material, material_document, material_valuation, plant, stock_quantity, storage_location |

## Routes (56)
`/config/batch-access-sequences` · `/config/batch-classification` · `/config/batch-condition-tables` · `/config/batch-conversion` · `/config/batch-document-management` · `/config/batch-initial-status` · `/config/batch-level` · `/config/batch-management` · `/config/batch-number-assignment` · `/config/batch-number-ranges` · `/config/batch-search-allocations` · `/config/batch-search-procedures` · `/config/batch-status-plants` · `/config/batch-status` · `/config/batch-strategy-types` · `/config/industry-sectors` · `/config/material-groups` · `/config/material-number-ranges` · `/config/material-period-control` · `/config/material-types` · `/config/movement-types` · `/config/scheduling-profiles` · `/config/valuation-classes` · `/inventory/batch-classes` · `/inventory/batch-cockpit` · `/inventory/batch-pickup` · `/inventory/batch-search-strategies` · `/inventory/batch-sort-sequences` · `/inventory/batches/change` · `/inventory/batches/display` · `/inventory/batches/new` · `/inventory/goods-issue` · `/inventory/goods-receipt` · `/inventory/material-document-list` · `/inventory/material-document-output` · `/inventory/material-documents` · `/inventory/materials` · `/inventory/migo` · `/inventory/physical-inventory-count` · `/inventory/physical-inventory-differences` · `/inventory/physical-inventory-posting` · `/inventory/physical-inventory-recount` · `/inventory/physical-inventory` · `/inventory/price-change` · `/inventory/reservations` · `/inventory/return-delivery` · `/inventory/reversal` · `/inventory/serial-numbers` · `/inventory/shelf-life-list` · `/inventory/stock-ageing` · `/inventory/stock-overview` · `/inventory/stock-posting-date` · `/inventory/stock-reconcile` · `/inventory/transfer-posting` · `/inventory/uom-conversion` · `/inventory/warehouse-stocks`

## Tables owned (53)
account_category_reference, batch, batch_access_sequence, batch_access_step, batch_assigned_receipt, batch_condition_table, batch_condition_table_field, batch_conversion_check, batch_conversion_conflict, batch_document_management, batch_level_configuration, batch_level_conversion, batch_number_assignment, batch_search_allocation, batch_search_procedure, batch_search_procedure_step, batch_search_strategy, batch_search_strategy_key, batch_sort_sequence, batch_sort_sequence_criterion, batch_status_management, batch_status_plant, batch_status_plant_conversion, batch_strategy_type, industry_sector, material, material_document, material_document_line, material_group, material_number_range_group, material_period_control, material_plant, material_sales, material_type, material_type_valuation, material_uom_conversion, material_valuation, movement_type, mrp_controller, physical_inventory_difference_allocation, physical_inventory_document, physical_inventory_item, physical_inventory_recount_link, planning_file, production_order, production_order_component, production_scheduling_profile, reservation_header, reservation_item, serial_number, stock_quantity, valuation_class, valuation_class_reference

## Depends on
finance, foundation, output, platform/auth, platform/change, platform/db, platform/document, platform/i18n, platform/lock, platform/numbering, platform/periods, platform/posting, platform/tables, platform/tenancy, production, purchasing, sales, ui/fields, ui/lock, ui/output

## Used by
dev/walkthrough-volume.ts, foundation, output, platform/tenancy, production, purchasing, quality, sales

## Tests (134)
atomic-inventory-posting, batch-access-sequence, batch-access-step, batch-assignment, batch-change, batch-class, batch-classification, batch-cockpit, batch-condition-table, batch-control-use, batch-conversion, batch-display, batch-document-management, batch-level, batch-management-img, batch-master, batch-number-assignment, batch-number-range, batch-pickup, batch-posting, batch-procurement-chain, batch-search-allocation, batch-search-procedure, batch-search-strategy, batch-sort-sequence, batch-status-plant, batch-status, batch-strategy-type, blocked-invoice, confirmation-cancel, dependent-requirement-conversion, development-fixture, document-layout-pdf, goods-issue, goods-receipt-batch-layer, goods-receipt, grir-clearing, grir-reconciliation, industry-sector-definition, initial-batch-status, initial-stock, inventory-block-invariant, invoice-account-assignment, invoice-advance-clearing, invoice-overview, invoice-verification, material-bom, material-deletion-flag, material-document-batch-display, material-document-display, material-document-list-batch, material-document-list, material-document-output, material-document-reversal-accounting, material-document-reversal, material-form-values, material-group-definition, material-number-range-groups, material-period-control, material-sales, material-type-definition, mb1b-configuration-decides, migo-component-issue, migo-matrix-ui-contract, migo-transfer, movement-type-configuration, mrp-plant-explosion, mrp-run, order-availability, order-confirmation-allocation, order-confirmation, order-information, order-operation-snapshot, parked-invoice, payment-run, physical-inventory-batch, physical-inventory-count, physical-inventory-differences, physical-inventory-posting, physical-inventory-recount, physical-inventory-ui-contract, physical-inventory, planned-order-change, planned-order-conversion, planned-order-create, planned-order-display, po-delivery-control, production-order-bom, production-order-create, production-order-display-change, production-order-settlement, production-order-technical-completion, production-order-type-assignment, production-receipt, production-reversal-quantity, production-version, purchase-contract, purchase-order-batch-display, qm-inspection-results, qm-usage-decision, quality-lot, quality-service-authorization, reservations, return-delivery-batch, return-delivery, reversal-batch, routing-execution-order-audit, routing, sales-collective-billing, sales-delivery, sales-serial-numbers, scheduling-profile, shelf-life-list, single-item-planning, single-level-planning, standard-structure-builder, stock-ageing, stock-batch-readback, stock-overview, stock-posting-date, stock-reconcile-uom, storage-location-posting, time-ticket-goods-movement, time-ticket, transfer-batch-requirement, transfer-batch, transfer-posting, unit-conversion, valuation-class-definition, vendor-ageing, vendor-balances, vendor-clearing, warehouse-stocks, wip-batch
