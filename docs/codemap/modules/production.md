# Production
MRP, production/planned orders, BOMs (incl. CS11/CS12 explosion, CS15 where-used), routings, confirmations, work centers. Routes: `/production/*`, `/config/{availability-check,checking-control,order-type-parameters,production-order-types,scheduling-profiles,wip-batch}`. Paths relative to `src/`; tables are SQL names.

## Gotchas

- Background MD01 (`mrp-background.ts`, job `MRP.PLANT.RUN`, queue INTENSIVE): a material goes PENDING→RUNNING→COMPLETED in ONE tx with its proposals (`planMaterialInTx`), so the run tables are the checkpoint. Lock order is job_run then mrp_run (`cancelMrpRun`). Trigger `mrp_run_job_ended` closes the run when its job ends FAILED/CANCELLED by any path. Only the foreground path is capped by `MRP_FOREGROUND_LIMIT`.
- `production_order(_component)` tables live in **inventory**'s schema; the component list is a frozen BOM snapshot (`order-bom-snapshot.ts`).
- `production_order.company_code` dropped (9272): always derived from the order's plant.
- Confirmation is inserted before the movement tx; a failed goods movement rolls back only the movement and queues a COGI row. COGI retry refuses without a user authority (`AutomaticMovementAuthorityError`).
- One active cancellation per confirmation is a trigger (`drizzle/9172`), not an index.
- `*-display.ts` files are re-export shims over the maintain modules. `createWipBatch()` always throws (unbuilt).
- `/config/scheduling-profiles` logic lives in `inventory/scheduling-profile.ts`.
- BOM explosion (`bom-explosion.ts`) reuses `mrp-explosion.ts` rules (MAKE-only recursion, phantom pass-through, `DEPTH_LIMIT`); keep the two in step.
- Demo phase `D15_BOM_STRUCTURE`: PH-GLAZE phantom + FG-CHOC alt 02 that no production version selects (MRP unchanged).
- Cost estimate (`cost-estimate.ts`): costing is bottom-up, cache key `(material, plant, quantity)` (fixed-quantity items make cost per unit vary with quantity); never writes `material_valuation` (CK24 is a later item); overhead is a CHECK-enforced zero; `selectProductionVersion` accepts `context: 'COSTING'` (the old refusal is gone).
- Demo phase `D16_COST_ESTIMATE` fills costing data only where missing (PP01 flag, operation hours, work centre costing lines) and saves one FG-CHOC estimate.
- MRP exception monitor (`mrp-exception-monitor.ts`): reads `stockRequirementsList` per planned material (REQUIREMENTS/REORDER only; NONE and blank counted, not scanned) and never recomputes an exception; bounded scan (default 50, ceiling 500, refused above) with both truncation layers reported; read-only.
- `sto-planning.ts` feeds MD04 and the MRP run with stock transport orders: not-yet-issued and in-transit supply at the receiving plant, open issue requirement at the supplying plant, each once; both `stock-requirements.ts` and `mrp-run.ts` exclude `STOCK_TRANSPORT` from their purchase-order queries.
- Activity costing (`activity-costing.ts`): a confirmed activity quantity is valued at the PLAN rate of the work-center costing line whose `parameter` it carries (`rate_basis = PLAN_RATE`, never called an actual rate) and posted order Dr / sender cost centre Cr on the one `PRODUCTION_ACTIVITY` account. One `production_confirmation_cost` row per (confirmation, parameter): FAILED / NOT_CONFIGURED are recoverable exceptions (the confirmation is never refused), POSTED carries the journal, REVERSED the reversal. Cancellation reverses the stored journal in its own transaction; confirmations that predate costing are only ever costed by an explicit action (`processUncostedConfirmations`).
- Financial WIP (`order-wip.ts`): actual-cost net balance (cost debits − output credits, by account class from the account determination), posts only the delta against `production_order_wip_posting` (append-only; WIP lines carry no production order). `order-settlement.ts` refuses a non-TECO order and unwinds standing WIP in its own transaction; `wip-batch.ts` is unrelated (batch management).
- Sales demand: `sales/sales-demand.ts` is the one projection MD04 and MRP read (open requested qty per schedule line; goods issue reduces it, reversal restores it, an unissued delivery does not). Order / goods-issue / reversal services mark `planning_file` in their own transaction.

## Files (148)
| file | exports | tables |
|---|---|---|
| **app/config/availability-check/** | | |
| actions.ts | saveCheckingGroupAction, saveCheckingRuleAction, assignCheckingGroupAction, saveScopeAction |  |
| AvailabilityCheckForm.tsx | AvailabilityCheckForm |  |
| page.tsx | AvailabilityCheckPage |  |
| **app/config/checking-control/** | | |
| actions.ts | saveCheckingControlAction |  |
| CheckingControlForm.tsx | CheckingControlForm |  |
| page.tsx | CheckingControlPage |  |
| **app/config/order-type-parameters/** | | |
| actions.ts | saveOrderTypeParameterAction |  |
| OrderTypeParameterForm.tsx | OrderTypeParameterForm |  |
| page.tsx | OrderTypeParametersPage |  |
| **app/config/production-order-types/** | | |
| actions.ts | saveProductionOrderTypeAction |  |
| page.tsx | ProductionOrderTypesPage |  |
| ProductionOrderTypeForm.tsx | ProductionOrderTypeForm |  |
| **app/config/wip-batch/** | | |
| actions.ts | saveWipBatchAction |  |
| page.tsx | WipBatchPage |  |
| WipForm.tsx | WipForm |  |
| **app/production/bom-display/** | | |
| page.tsx | MaterialBomDisplayPage |  |
| **app/production/bom-explosion/** | | |
| page.tsx | BomExplosionPage |  |
| **app/production/boms/** | | |
| actions.ts | saveUsageAction, saveStatusAction, saveItemCategoryAction, saveBomAction |  |
| BomForm.tsx | BomForm |  |
| ConfigForms.tsx | UsageForm, StatusForm, ItemCategoryForm |  |
| page.tsx | MaterialBomsPage |  |
| **app/production/capacity-load/** | | |
| page.tsx | CapacityLoadPage |  |
| **app/production/cogi/** | | |
| actions.ts | correctProductionCogiAction, retryProductionCogiAction, discardProductionCogiAction |  |
| page.tsx | ProductionCogiPage |  |
| ProductionCogiWorkbench.tsx | ProductionCogiWorkbench |  |
| **app/production/confirmation-cancel/** | | |
| actions.ts | cancelConfirmationAction |  |
| ConfirmationCancelWorkbench.tsx | ConfirmationCancelWorkbench |  |
| page.tsx | ConfirmationCancelPage |  |
| **app/production/confirmation-display/** | | |
| loading.tsx | ConfirmationDisplayLoading |  |
| page.tsx | ConfirmationDisplayPage |  |
| **app/production/cost-estimate/** | | |
| actions.ts | createCostEstimateAction |  |
| CostEstimateForm.tsx | CostEstimateForm |  |
| page.tsx | CostEstimatePage |  |
| **app/production/mrp-exception-monitor/** | | |
| page.tsx | MrpExceptionMonitorPage |  |
| **app/production/mrp-run/** | | |
| actions.ts | planMaterialsAction, cancelMrpRunAction, mrpRunProgressAction, mrpRunViewAction |  |
| MrpRunWorkbench.tsx | MrpRunWorkbench |  |
| page.tsx | MrpRunPage |  |
| **app/production/order-availability/** | | |
| actions.ts | commitAvailabilityAction, resetAvailabilityAction |  |
| OrderAvailabilityWorkbench.tsx | OrderAvailabilityWorkbench |  |
| page.tsx | OrderAvailabilityPage |  |
| **app/production/order-confirmation/** | | |
| actions.ts | enterOrderConfirmationAction |  |
| OrderConfirmationWorkbench.tsx | OrderConfirmationWorkbench |  |
| page.tsx | OrderConfirmationPage |  |
| **app/production/order-cost-report/** | | |
| page.tsx | ProductionOrderCostReportPage |  |
| **app/production/order-information/** | | |
| actions.ts | saveOrderInformationLayoutAction |  |
| OrderInformationResult.tsx | OrderInformationResultView |  |
| page.tsx | OrderInformationPage |  |
| **app/production/order-settlement/** | | |
| actions.ts | runWipAction, costBackfillAction, settleProductionOrderAction |  |
| page.tsx | ProductionOrderSettlementPage |  |
| SettlementForm.tsx | ProductionOrderSettlementForm |  |
| WipForm.tsx | WipForm |  |
| **app/production/orders/** | | |
| actions.ts | createOrderAction, releaseOrderAction |  |
| OrderCreate.tsx | OrderCreate |  |
| page.tsx | ProductionOrdersPage |  |
| **app/production/planned-order-change/** | | |
| actions.ts | changePlannedOrderAction |  |
| page.tsx | PlannedOrderChangePage |  |
| PlannedOrderForm.tsx | PlannedOrderForm |  |
| **app/production/planned-order-conversion-collective/** | | |
| actions.ts | convertPlannedOrdersAction |  |
| CollectiveForm.tsx | CollectiveForm |  |
| page.tsx | CollectiveConversionPage |  |
| **app/production/planned-order-conversion/** | | |
| actions.ts | convertPlannedOrderAction |  |
| ConvertForm.tsx | ConvertForm |  |
| page.tsx | PlannedOrderConversionPage |  |
| **app/production/planned-order-create/** | | |
| actions.ts | createPlannedOrderAction |  |
| page.tsx | PlannedOrderCreatePage |  |
| PlannedOrderCreateForm.tsx | PlannedOrderCreateForm |  |
| **app/production/planned-order-display/** | | |
| page.tsx | PlannedOrderDisplayPage |  |
| **app/production/production-order-change/** | | |
| actions.ts | changeProductionOrderAction, technicallyCompleteProductionOrderAction, revokeTechnicalCompletionAction |  |
| OrderChangeForm.tsx | OrderChangeForm |  |
| page.tsx | ProductionOrderChangePage |  |
| **app/production/production-order-display/** | | |
| page.tsx | ProductionOrderDisplayPage |  |
| **app/production/production-version-display/** | | |
| page.tsx | ProductionVersionDisplayPage |  |
| **app/production/production-versions/** | | |
| actions.ts | saveVersionAction, copyVersionAction, checkVersionAction, lockVersionAction, deleteVersionAction, saveRuleAction |  |
| page.tsx | ProductionVersionsPage |  |
| VersionForm.tsx | VersionForm |  |
| **app/production/routing-display/** | | |
| page.tsx | RoutingDisplayPage |  |
| **app/production/routings/** | | |
| actions.ts | saveTaskListTypeAction, saveUsageAction, saveStatusAction, saveControlKeyAction, saveStandardValueKeyAction, saveRoutingAction |  |
| ConfigForms.tsx | TaskListTypeForm, UsageForm, StatusForm, ControlKeyForm, StandardValueKeyForm |  |
| page.tsx | RoutingsPage |  |
| RoutingForm.tsx | RoutingForm |  |
| **app/production/single-item-planning/** | | |
| actions.ts | planSingleItemAction |  |
| page.tsx | SingleItemPlanningPage |  |
| SingleItemWorkbench.tsx | SingleItemWorkbench |  |
| **app/production/single-level-planning/** | | |
| actions.ts | planSingleLevelAction |  |
| page.tsx | SingleLevelPlanningPage |  |
| SingleLevelWorkbench.tsx | SingleLevelWorkbench |  |
| **app/production/stock-requirements/** | | |
| page.tsx | StockRequirementsPage |  |
| StockRequirementsShell.tsx | StockRequirementsShell |  |
| **app/production/time-ticket/** | | |
| actions.ts | enterTimeTicketAction |  |
| page.tsx | TimeTicketPage |  |
| TimeTicketWorkbench.tsx | TimeTicketWorkbench |  |
| **app/production/work-center-display/** | | |
| page.tsx | WorkCenterDisplayPage |  |
| **app/production/work-centers/** | | |
| actions.ts | saveCategoryAction, saveWorkCenterAction |  |
| CategoryForm.tsx | CategoryForm |  |
| page.tsx | WorkCentersPage |  |
| WorkCenterForm.tsx | WorkCenterForm |  |
| **modules/production/** | | |
| activity-costing.ts | ACTIVITY_COST_EVENT, ACTIVITY_COST_RATE_BASIS, ACTIVITY_COST_BASIS_LABEL, ACTIVITY_COST_DOCUMENT_TYPE, ACTIVITY_COST_LOCK, WORK_CENTER_ROUTE, ACCOUNT_DETERMINATION_ROUTE, ActivityCostError, unitFactor, costConfirmationInTx, costConfirmation, previewConfirmationCost, reverseConfirmationCostInTx, activityCostsOfOrder, activityCostsOfConfirmation, listUncostedConfirmations, processUncostedConfirmations | account_determination, activity_rate, activity_type, company_code, controlling_area, cost_center, plant, production_confirmation, production_confirmation_activity, production_confirmation_cancellation, production_confirmation_cost, production_order, settlement_document, unit_of_measure, work_center_costing |
| availability-check.ts | ACTIVITY, ROUTE, ALIASES, LOCK_OBJECT, AVAILABILITY_CHECK_GAPS, AvailabilityCheckError, availabilityCheckRefusal, listAvailabilityCheck, saveCheckingGroup, saveCheckingRule, assignCheckingGroup, saveScopeOfCheck | availability_check_scope, availability_checking_group, availability_checking_rule, material_plant |
| bom-explosion.ts | BOM_EXPLOSION_CAPABILITY, BOM_EXPLOSION_ROUTE, BomExplosionError, explodeBom, whereUsedBom | bom_item_category, material, material_bom, material_bom_item, material_plant, plant |
| capacity-load.ts | CAPACITY_LOAD_CAPABILITY, CAPACITY_LOAD_ROUTE, CAPACITY_LOAD_ALIAS, CAPACITY_LOAD_DEFAULT_LIMIT, CAPACITY_LOAD_LIMIT_CEILING, DEFAULT_WORKING_DAYS_PER_WEEK, CAPACITY_PERIODS, CAPACITY_ORDER_STATUSES, UNASSIGNED_CATEGORY, CapacityLoadError, isoWeekKey, bucketKey, effectiveDailyMinutes, windowShares, checkWindow, requirementOf, loadCapacityReport, drillDownFor | planned_order, plant, production_order, production_order_operation, production_order_operation_value, routing_operation, routing_operation_value, work_center, work_center_capacity |
| checking-control.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, PRODUCTION_ORDER_CATEGORY, CHECKING_CONTROL_GAPS, CheckingControlError, holdsCheckingControlAuthority, checkingControlRefusal, listCheckingControls, saveCheckingControl | availability_checking_rule, plant, production_checking_control, production_order_type |
| confirmation-cancel.ts | CONFIRMATION_CANCEL_CAPABILITY, CONFIRMATION_CANCEL_ROUTE, CONFIRMATION_CANCEL_ALIAS, ConfirmationCancelError, holdsConfirmationCancelAuthority, loadConfirmationCancellation, cancelConfirmation | app_user, auth_org_restriction, capability, material, plant, production_confirmation, production_confirmation_activity, production_confirmation_cancellation, production_confirmation_operation, production_order, production_order_operation, role, role_capability, user_role, user_session |
| confirmation-display.ts | CONFIRMATION_DISPLAY_ROUTE, CONFIRMATION_DISPLAY_PAGE_SIZE, CONFIRMATION_DISPLAY_MAX_PAGE, ConfirmationDisplayError, validateConfirmationDisplaySelection, searchProductionConfirmations, getProductionConfirmationDisplay | material, material_document, material_document_line, movement_type, plant, production_confirmation, production_confirmation_activity, production_confirmation_cancellation, production_confirmation_operation, production_order, production_order_operation, production_order_operation_value, work_center |
| confirmation-movements.ts | CONFIRMATION_MOVEMENT_CODES, movementRequestKey, planConfirmationMovements, movementConfiguration, plannedMovements, postedMovements, movementStands | material, material_document, material_document_line, material_plant, production_confirmation_cancellation, production_goods_movement_failure, production_goods_movement_failure_line, production_order_component |
| conversion-outcome.ts | CONVERSION_STATUSES, DEMAND_RECONCILIATIONS, pairedConversion, conversionOutcomeText, summarizeConversionResults |  |
| cost-estimate.ts | COST_ESTIMATE_CAPABILITY, COST_ESTIMATE_ROUTE, DEFAULT_PLAN_VERSION, OVERHEAD_NOTE, CostEstimateError, materialAmount, activityAmount, createCostEstimate, getCostEstimate, listCostEstimates | activity_rate, bom_item_category, bom_status, company_code, material, material_bom, material_bom_item, material_cost_estimate, material_cost_estimate_item, material_plant, material_valuation, plant, routing, routing_control_key, routing_operation, routing_status, work_center_costing |
| material-bom-display.ts | displayMaterialBom, listMaterialBomsForDisplay |  |
| material-bom.ts | BOM_ACTIVITY, BOM_CREATE_CAPABILITY, BOM_CHANGE_CAPABILITY, BOM_DISPLAY_CAPABILITY, BOM_ROUTE, BOM_DISPLAY_ROUTE, BOM_LOCK, BOM_OBJECT, MaterialBomError, bomCapability, holdsMaterialBomAuthority, createMaterialBom, changeMaterialBom, getMaterialBom, listMaterialBoms, resolveMaterialBom, selectEffectiveMaterialBom, listBomUsages, listBomStatuses, listBomItemCategories, saveBomUsage, saveBomStatus, saveBomItemCategory | bom_item_category, bom_status, bom_usage, material, material_bom, material_bom_item, material_plant, plant, production_order, unit_of_measure |
| mrp-background.ts | MRP_PLANT_JOB, submitMrpBackgroundRun, getMrpRunProgress, getMrpRunProgressForProvisioning, runMrpPlantChunk | job_run, mrp_run, plant |
| mrp-exception-monitor.ts | MRP_EXCEPTION_CAPABILITY, MRP_EXCEPTION_ROUTE, MRP_EXCEPTION_ALIAS, MRP_EXCEPTION_DEFAULT_LIMIT, MRP_EXCEPTION_LIMIT_CEILING, EXCEPTION_CODES, MrpExceptionError, drillDownFor, mrpExceptionMonitor | material_plant, plant |
| mrp-explosion.ts | SCALE, DEPTH_LIMIT, componentRequirementQuantity, explodePlannedSupply | material_bom, material_bom_item, mrp_dependent_requirement, planned_order, production_order, production_order_component |
| mrp-run.ts | MRP_RUN_CAPABILITY, MRP_REGENERATE_CAPABILITY, MRP_RUN_ROUTE, MRP_SINGLE_ROUTE, MRP_SINGLE_LEVEL_ROUTE, MRP_SINGLE_LEVEL_CAPABILITY, MRP_RUN_ALIASES, MRP_SINGLE_ALIAS, MRP_SINGLE_LEVEL_ALIAS, MRP_FOREGROUND_LIMIT, MrpRunError, clean, mrpNamedRefusal, selectionOf, sameSelection, rows, viewOf, candidates, loadCandidate, nextLine, closeRun, planMaterialInTx, storeStructuralLevels, singleItemRefusal, singleLevelRefusal, planMaterials, planSingleItem, planSingleLevel, cancelMrpRun, getMrpRun, listMrpRuns, planMaterialsForProvisioning, planSingleItemForProvisioning, planSingleLevelForProvisioning, cancelMrpRunForProvisioning, getMrpRunForProvisioning, listMrpRunsForProvisioning | document_release, job_run, material, material_document, material_document_line, material_plant, movement_type, mrp_dependent_requirement, mrp_run, planned_order, planning_file, plant, production_order, production_order_component, purchase_order, purchase_order_item, purchase_order_schedule_line, purchase_requisition_item, reservation_header, reservation_item, stock_quantity |
| mrp-structure.ts | STRUCTURAL_DEPTH_LIMIT, structuralBomLevels | material_bom, material_bom_item, material_plant, production_version, routing |
| order-availability-commitment.ts | OrderAvailabilityCommitmentError, holdsOrderAvailabilityCommitAuthority, holdsOrderAvailabilityResetAuthority, commitOrderComponentAvailability, resetOrderComponentAvailability | production_order_availability_run, production_order_component, production_order_component_commitment_event |
| order-availability.ts | ORDER_AVAILABILITY_ORDER_CAPABILITY, ORDER_AVAILABILITY_ELEMENTS_CAPABILITY, ORDER_AVAILABILITY_ROUTE, ORDER_AVAILABILITY_ALIAS, ORDER_AVAILABILITY_GAPS, ORDER_AVAILABILITY_UNSUPPORTED_PARAMETERS, orderAvailabilityRefusal, holdsOrderAvailabilityAuthority, OrderAvailabilityError, elementUnitKey, resolveElementUnits, businessFunctionForStatus, scopeDocumentStates, checkOrderAvailability | material, material_plant, planned_order, production_checking_control, production_order, production_order_component, production_order_component_commitment_event |
| order-bom-snapshot.ts | OrderBomSnapshotError, resolveOrderBomSnapshot | bom_item_category, material, material_bom, material_bom_item, material_plant, plant |
| order-confirmation.ts | ORDER_CONFIRMATION_CAPABILITY, ORDER_CONFIRMATION_ROUTE, ORDER_CONFIRMATION_ALIAS, OrderConfirmationError, orderConfirmationRefusal, holdsOrderConfirmationAuthority, operationEffectQuantity, scaledEffectWithinLimit, loadOrderConfirmation, previewOrderConfirmation, enterOrderConfirmation, getOrderConfirmation, loadOrderConfirmationForProvisioning, previewOrderConfirmationForProvisioning, enterOrderConfirmationForProvisioning, getOrderConfirmationForProvisioning | material_plant, production_confirmation, production_confirmation_cancellation, production_confirmation_operation, production_order, production_order_operation |
| order-cost-report.ts | PRODUCTION_ORDER_COST_REPORT_CAPABILITY, PRODUCTION_ORDER_COST_REPORT_ROUTE, ProductionOrderCostReportError, holdsProductionOrderCostReportAuthority, getProductionOrderCostReport | plant, production_order |
| order-information.ts | ORDER_INFORMATION_CAPABILITY, ORDER_INFORMATION_ROUTE, ORDER_INFORMATION_ALIAS, ORDER_INFORMATION_DEFAULT_LIMIT, ORDER_INFORMATION_MAX_LIMIT, OrderInformationError, orderInformationLists, orderInformationFields, orderInformationRefusal, holdsOrderInformationAuthority, runOrderInformation, listOrderInformationLayouts, saveOrderInformationLayout | material, material_document, material_document_line, material_plant, movement_type, mrp_dependent_requirement, planned_order, production_confirmation, production_confirmation_cancellation, production_confirmation_operation, production_order, production_order_component, production_order_operation, report_layout |
| order-operation-snapshot.ts | OrderOperationSnapshotError, resolveOrderOperationSnapshot, insertOrderOperationSnapshot | production_order_operation, production_order_operation_value, routing, routing_control_key, routing_operation, routing_operation_value, routing_standard_value_parameter, routing_status |
| order-settlement.ts | PROD_ORDER_SETTLEMENT_CAPABILITY, PROD_ORDER_SETTLEMENT_ROUTE, ProductionOrderSettlementError, productionOrderSettlementPosting, settleProductionOrder, settleProductionOrdersCollective, settleProductionOrderForProvisioning, settleProductionOrdersCollectiveForProvisioning | allocation_structure_assignment, company_code, controlling_area, cost_center, fiscal_year_period, fiscal_year_variant, gl_account, journal_entry, journal_entry_line, plant, production_order, production_order_settlement_distribution_rule, production_order_type_settlement_profile, settlement_document, settlement_profile |
| order-type-parameters.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, PRODUCTION_ORDER_CATEGORY, ORDER_PARAMETER_GAPS, OrderTypeParameterError, holdsOrderTypeParameterAuthority, orderTypeParameterRefusal, listOrderTypeParameters, saveOrderTypeParameter, productionVersionSelectionOf, readProductionVersionSelection, productionVersionForSelection | plant, production_order_type, production_order_type_parameter, routing_task_list_type |
| order-wip.ts | WIP_METHOD, WIP_CAPABILITY, WIP_BALANCE_EVENT, WIP_CHANGE_EVENT, WIP_ORIGIN_CLASS, SETTLEMENT_ORIGIN_CLASS, WIP_DOCUMENT_TYPE, ACCOUNT_DETERMINATION_ROUTE, WIP_MAX_ORDERS, WIP_METHOD_STATEMENT, WipError, wipPostingsOfOrder, postedWip, calculateWip, postWipDelta, runWip, unwindWipForSettlementInTx | account_determination, company_code, fiscal_year_period, fiscal_year_variant, journal_entry, journal_entry_line, plant, production_order, production_order_type, production_order_wip_posting |
| planned-order-change.ts | PLANNED_ORDER_CHANGE_CAPABILITY, PLANNED_ORDER_CHANGE_ROUTE, PLANNED_ORDER_CHANGE_ALIAS, PLANNED_ORDER_LOCK, PlannedOrderChangeError, plannedOrderChangeRefusal, holdsPlannedOrderChangeAuthority, changePlannedOrder, changePlannedOrderForProvisioning | material_plant, mrp_dependent_requirement, planned_order, planning_file, production_order, unit_of_measure |
| planned-order-conversion.ts | PLANNED_ORDER_CONVERT_CAPABILITY, PLANNED_ORDER_CONVERT_ROUTE, PLANNED_ORDER_CONVERT_ALIAS, PLANNED_ORDER_CONVERT_COLLECTIVE_CAPABILITY, PLANNED_ORDER_CONVERT_COLLECTIVE_ROUTE, PLANNED_ORDER_CONVERT_COLLECTIVE_ALIAS, CONVERSION_LIMIT, PlannedOrderConversionError, plannedOrderConversionRefusal, holdsPlannedOrderConvertAuthority, holdsPlannedOrderCollectiveAuthority, previewPlannedOrderConversion, listConvertiblePlannedOrders, convertPlannedOrder, notAttemptedConversion, rolledBackConversion, convertPlannedOrders, listConversionLog | change_document, material, material_bom, material_bom_item, material_plant, mrp_dependent_requirement, planned_order, plant, production_order, production_order_component, production_order_type |
| planned-order-create.ts | PLANNED_ORDER_CREATE_CAPABILITY, PLANNED_ORDER_CREATE_ROUTE, PLANNED_ORDER_CREATE_ALIAS, PlannedOrderCreateError, plannedOrderCreateRefusal, holdsPlannedOrderCreateAuthority, createPlannedOrder, createPlannedOrderForProvisioning | material, material_plant, planned_order, planning_file, plant, unit_of_measure |
| planned-order-display.ts | PLANNED_ORDER_DISPLAY_CAPABILITY, PLANNED_ORDER_DISPLAY_ROUTE, PLANNED_ORDER_DISPLAY_ALIAS, PLANNED_ORDER_LIST_LIMIT, PlannedOrderDisplayError, plannedOrderDisplayRefusal, holdsPlannedOrderDisplayAuthority, getPlannedOrder, getPlannedOrderForProvisioning, listPlannedOrders, listPlannedOrdersForProvisioning | material, material_plant, mrp_controller, mrp_dependent_requirement, planned_order, plant, production_order |
| production-cogi-auth.ts | PRODUCTION_COGI_CAPABILITY, PRODUCTION_COGI_ROUTE, PRODUCTION_COGI_ALIAS, ProductionCogiAuthorizationError, holdsProductionCogiAuthority, requireProductionCogiAuthorityInTx, requireProductionCogiFailureScopeInTx | app_user, auth_org_restriction, capability, plant, production_order, role, role_capability, user_role, user_session |
| production-cogi.ts | ProductionCogiError, listProductionCogiFailures, getProductionCogiFailure, applyProductionCogiCorrections, correctProductionCogiFailure, retryProductionCogiFailure, discardProductionCogiFailure, PRODUCTION_COGI_ALIAS, PRODUCTION_COGI_CAPABILITY, PRODUCTION_COGI_ROUTE | plant, production_goods_movement_failure, production_goods_movement_failure_attempt, production_goods_movement_failure_line, production_goods_movement_failure_revision, production_order |
| production-goods-movement-failures.ts | AutomaticMovementAuthorityError, MovementFailurePersistenceError, fingerprintStoredMovementPayload, persistConfirmationMovementIntents, confirmationMovementOutcomes, listProductionGoodsMovementFailures, getProductionGoodsMovementFailure, recoverAbandonedProductionGoodsMovementFailure, claimProductionGoodsMovementFailure, executeClaimedProductionGoodsMovementFailure, releaseProductionGoodsMovementFailure, attemptProductionGoodsMovementFailure, processPendingConfirmationMovements, waitForConfirmationMovementSettlement, listProductionGoodsMovementFailureDetails, failuresForOrderInTx, originalPostingInput, productionMovementStatus | plant, production_confirmation_cancellation, production_goods_movement_failure, production_goods_movement_failure_attempt, production_goods_movement_failure_line, production_goods_movement_failure_revision, production_order |
| production-order-change.ts | PRODUCTION_ORDER_CHANGE_CAPABILITY, PRODUCTION_ORDER_CHANGE_ROUTE, PRODUCTION_ORDER_CHANGE_ALIAS, PRODUCTION_ORDER_LOCK, ProductionOrderChangeError, productionOrderChangeRefusal, holdsProductionOrderChangeAuthority, technicallyCompleteProductionOrder, revokeTechnicalCompletion, changeProductionOrder, changeProductionOrderForProvisioning | material, material_document_line, material_plant, production_confirmation, production_order, production_order_component, production_order_component_commitment_event, unit_of_measure |
| production-order-display.ts | PRODUCTION_ORDER_DISPLAY_CAPABILITY, PRODUCTION_ORDER_DISPLAY_ROUTE, PRODUCTION_ORDER_DISPLAY_ALIAS, PRODUCTION_ORDER_LIST_LIMIT, ProductionOrderDisplayError, productionOrderDisplayRefusal, holdsProductionOrderDisplayAuthority, getProductionOrderDisplay, listProductionOrders, getProductionOrderDisplayForProvisioning, listProductionOrdersForProvisioning | change_document, journal_entry, material, material_document, material_document_line, plant, production_confirmation, production_confirmation_cancellation, production_confirmation_operation, production_order, production_order_component, production_order_operation, production_order_operation_value |
| production-order-status.ts | PRODUCTION_ORDER_STATUSES, PRODUCTION_ORDER_SUPPLY_STATUSES, parseProductionOrderStatus, productionOrderMayBeCharged, confirmationBlockReason, priorStatusFromRelease |  |
| production-order-type.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, PRODUCTION_ORDER_CATEGORY, ORDER_TYPE_GAPS, ProductionOrderTypeError, holdsOrderTypeAuthority, productionOrderTypeRefusal, listProductionOrderTypes, saveProductionOrderType | production_order_type |
| production-version-display.ts | displayProductionVersion, listProductionVersionsForDisplay |  |
| production-version.ts | PRODUCTION_VERSION_ACTIVITY, PRODUCTION_VERSION_CREATE_CAPABILITY, PRODUCTION_VERSION_CHANGE_CAPABILITY, PRODUCTION_VERSION_DISPLAY_CAPABILITY, PRODUCTION_VERSION_CHECK_CAPABILITY, PRODUCTION_VERSION_LOCK_CAPABILITY, PRODUCTION_VERSION_DELETE_CAPABILITY, PRODUCTION_VERSION_ROUTE, PRODUCTION_VERSION_DISPLAY_ROUTE, PRODUCTION_VERSION_LOCK, PRODUCTION_VERSION_OBJECT, ProductionVersionError, productionVersionCapability, holdsProductionVersionAuthority, createProductionVersion, changeProductionVersion, copyProductionVersion, getProductionVersion, listProductionVersions, checkProductionVersion, lockProductionVersion, deleteProductionVersion, selectProductionVersion, saveProductionVersionRule, listProductionVersionChoices | bom_status, material, material_bom, material_plant, planned_order, production_order, production_version, production_version_finding, production_version_rule, routing, routing_material_assignment, routing_status, storage_location, unit_of_measure |
| report-exports.ts | productionOrderCostExport, stockRequirementsExport, PRODUCTION_REPORT_EXPORTS |  |
| routing-display.ts | displayRouting, listRoutingsForDisplay |  |
| routing.ts | ROUTING_ACTIVITY, ROUTING_CREATE_CAPABILITY, ROUTING_CHANGE_CAPABILITY, ROUTING_DISPLAY_CAPABILITY, ROUTING_ROUTE, ROUTING_DISPLAY_ROUTE, ROUTING_LOCK, ROUTING_OBJECT, RoutingError, routingCapability, holdsRoutingAuthority, createRouting, changeRouting, getRouting, listRoutings, resolveRouting, selectEffectiveRouting, saveRoutingTaskListType, saveRoutingUsage, saveRoutingStatus, saveRoutingControlKey, saveRoutingStandardValueKey, listRoutingConfiguration | material, material_bom_item, material_plant, plant, production_order, routing, routing_component_allocation, routing_control_key, routing_material_assignment, routing_operation, routing_operation_value, routing_sequence, routing_standard_value_key, routing_standard_value_parameter, routing_status, routing_task_list_type, routing_usage, unit_of_measure, work_center |
| schema.ts | plannedOrder, mrpRun, wipBatchActivation, workCenterCategory, workCenter, workCenterCapacity, workCenterCosting, bomUsage, bomStatus, bomItemCategory, materialBom, materialBomItem, routingTaskListType, routingUsage, routingStatus, routingControlKey, routingStandardValueKey, routingStandardValueParameter, routing, routingSequence, routingMaterialAssignment, routingOperation, routingOperationValue, routingComponentAllocation, productionVersionRule, productionVersion, productionVersionFinding, mrpDependentRequirement, productionConfirmation, productionConfirmationActivity, productionConfirmationOperation, productionConfirmationCancellation, productionOrderOperation, productionOrderOperationValue, reportLayout, availabilityCheckingGroup, availabilityCheckingRule, availabilityCheckScope, productionOrderType, productionOrderTypeParameter, productionCheckingControl, productionOrderTypeSettlementProfile, productionOrderSetttlementDistributionRule, productionGoodsMovementFailure, productionGoodsMovementFailureLine, productionGoodsMovementFailureAttempt, productionGoodsMovementFailureRevision, productionOrderAvailabilityRun, productionOrderComponentCommitmentEvent, materialCostEstimate, materialCostEstimateItem, productionConfirmationCost, productionOrderWipPosting | availability_check_scope, availability_checking_group, availability_checking_rule, bom_item_category, bom_status, bom_usage, material_bom, material_bom_item, material_cost_estimate, material_cost_estimate_item, mrp_dependent_requirement, mrp_run, planned_order, production_checking_control, production_confirmation, production_confirmation_activity, production_confirmation_cancellation, production_confirmation_cost, production_confirmation_operation, production_goods_movement_failure, production_goods_movement_failure_attempt, production_goods_movement_failure_line, production_goods_movement_failure_revision, production_order_availability_run, production_order_component_commitment_event, production_order_operation, production_order_operation_value, production_order_settlement_distribution_rule, production_order_type, production_order_type_parameter, production_order_type_settlement_profile, production_order_wip_posting, production_version, production_version_finding, production_version_rule, report_layout, routing, routing_component_allocation, routing_control_key, routing_material_assignment, routing_operation, routing_operation_value, routing_sequence, routing_standard_value_key, routing_standard_value_parameter, routing_status, routing_task_list_type, routing_usage, wip_batch_activation, work_center, work_center_capacity, work_center_category, work_center_costing |
| settlement-configuration.ts | SETTLEMENT_RULE_CAPABILITY, SETTLEMENT_RULE_ROUTE, SHARED_MASTER_FIELDS, SettlementConfigurationError, getSettlementConfiguration, lockSettlementRuleForProductionOrder, assignProductionOrderTypeSettlementProfile, saveProductionOrderSettlementConfiguration | allocation_structure_assignment, company_code, cost_center, gl_account, plant, production_order, production_order_settlement_distribution_rule, production_order_type_settlement_profile, settlement_document, settlement_profile |
| sto-planning.ts | stoQuantityNumber, stoPlanningElements | material, purchase_order, purchase_order_item, purchase_order_schedule_line, sto_transit_allocation |
| stock-requirements.ts | STOCK_REQUIREMENTS_CAPABILITY, STOCK_REQUIREMENTS_ALIAS, MRP_AVAILABLE_STOCK_TYPES, PERIOD_SPLITS, DEFAULT_MAX_HITS, MAX_HITS_CAP, StockRequirementsError, stockRequirementsList | material, material_document, material_document_line, material_plant, movement_type, mrp_dependent_requirement, planned_order, plant, production_order, production_order_component, purchase_order, purchase_order_item, purchase_order_schedule_line, purchase_requisition_item, reservation_header, reservation_item, stock_quantity |
| time-ticket.ts | TIME_TICKET_CAPABILITY, TIME_TICKET_ROUTE, TIME_TICKET_ALIAS, TIME_TICKET_LOCK, TimeTicketError, ORDER_OPERATION_SNAPSHOT_MISSING, timeTicketRefusal, holdsTimeTicketAuthority, rows, dateOf, quantityText, clock, plainQuantity, decimalsOf, orderQuantityOf, headerOf, operationsOf, remainingText, loadTimeTicket, previewTimeTicket, enterTimeTicket, getTimeTicket, loadTimeTicketForProvisioning, previewTimeTicketForProvisioning, enterTimeTicketForProvisioning, getTimeTicketForProvisioning | material, material_plant, production_confirmation, production_confirmation_activity, production_confirmation_cancellation, production_confirmation_operation, production_order, production_order_operation, production_order_operation_value, unit_of_measure |
| wip-batch.ts | ACTIVITY, ROUTE, ALIAS, LOCK_OBJECT, NOT_EXECUTED, WipBatchError, wipBatchActive, readWipBatchFlag, getWipBatchActivation, saveWipBatchActivation, createWipBatch | batch_level_configuration, wip_batch_activation |
| work-center-display.ts | displayWorkCenter |  |
| work-center.ts | WORK_CENTER_ACTIVITY, WORK_CENTER_CREATE_CAPABILITY, WORK_CENTER_CHANGE_CAPABILITY, WORK_CENTER_DISPLAY_CAPABILITY, WORK_CENTER_ROUTE, WORK_CENTER_DISPLAY_ROUTE, WORK_CENTER_LOCK, WORK_CENTER_OBJECT, WorkCenterError, workCenterCapability, holdsWorkCenterAuthority, minutesBetween, saveWorkCenterCategory, listWorkCenterCategories, listWorkCenters, getWorkCenter, createWorkCenter, changeWorkCenter, listStandardValueParameters | activity_type, controlling_area_company, cost_center, factory_calendar, plant, routing_standard_value_parameter, unit_of_measure, work_center, work_center_capacity, work_center_category, work_center_costing |
| **modules/production/jobs/** | | |
| plant-run.ts | mrpPlantRunJob |  |

## Routes (38)
`/config/availability-check` · `/config/checking-control` · `/config/order-type-parameters` · `/config/production-order-types` · `/config/wip-batch` · `/production/bom-display` · `/production/bom-explosion` · `/production/boms` · `/production/capacity-load` · `/production/cogi` · `/production/confirmation-cancel` · `/production/confirmation-display` · `/production/cost-estimate` · `/production/mrp-exception-monitor` · `/production/mrp-run` · `/production/order-availability` · `/production/order-confirmation` · `/production/order-cost-report` · `/production/order-information` · `/production/order-settlement` · `/production/orders` · `/production/planned-order-change` · `/production/planned-order-conversion-collective` · `/production/planned-order-conversion` · `/production/planned-order-create` · `/production/planned-order-display` · `/production/production-order-change` · `/production/production-order-display` · `/production/production-version-display` · `/production/production-versions` · `/production/routing-display` · `/production/routings` · `/production/single-item-planning` · `/production/single-level-planning` · `/production/stock-requirements` · `/production/time-ticket` · `/production/work-center-display` · `/production/work-centers`

## Tables owned (53)
availability_check_scope, availability_checking_group, availability_checking_rule, bom_item_category, bom_status, bom_usage, material_bom, material_bom_item, material_cost_estimate, material_cost_estimate_item, mrp_dependent_requirement, mrp_run, planned_order, production_checking_control, production_confirmation, production_confirmation_activity, production_confirmation_cancellation, production_confirmation_cost, production_confirmation_operation, production_goods_movement_failure, production_goods_movement_failure_attempt, production_goods_movement_failure_line, production_goods_movement_failure_revision, production_order_availability_run, production_order_component_commitment_event, production_order_operation, production_order_operation_value, production_order_settlement_distribution_rule, production_order_type, production_order_type_parameter, production_order_type_settlement_profile, production_order_wip_posting, production_version, production_version_finding, production_version_rule, report_layout, routing, routing_component_allocation, routing_control_key, routing_material_assignment, routing_operation, routing_operation_value, routing_sequence, routing_standard_value_key, routing_standard_value_parameter, routing_status, routing_task_list_type, routing_usage, wip_batch_activation, work_center, work_center_capacity, work_center_category, work_center_costing

## Depends on
finance, foundation, inventory, output, platform/auth, platform/change, platform/db, platform/i18n, platform/job, platform/lock, platform/notification, platform/numbering, platform/periods, platform/posting, platform/tables, platform/tenancy, purchasing, sales, ui/kit, ui/lock, ui/output

## Used by
dev/walkthrough-volume.ts, inventory, output, platform/tenancy, sales, worker/jobs.ts

## Tests (60)
availability-check, bom-explosion, capacity-load, checking-control, company-scope-production, confirmation-cancel, cost-estimate, dependent-requirement-conversion, goods-issue, material-bom, material-document-reversal-accounting, migo-component-issue, mrp-background, mrp-exception-monitor, mrp-plant-explosion, mrp-run, mrp-structure, order-availability-commitment-contract, order-availability, order-confirmation-allocation, order-confirmation-ui-contract, order-confirmation, order-information, order-operation-snapshot, order-type-parameters, planned-order-change, planned-order-conversion-ui-contract, planned-order-conversion, planned-order-create, planned-order-display, production-activity-costing, production-cogi-correction, production-cogi-ui-contract, production-order-bom, production-order-cost-report-contract, production-order-display-change, production-order-settlement, production-order-technical-completion, production-order-type-assignment, production-order-type, production-order-wip, production-order-writer-guard, production-receipt, production-reversal-quantity, production-screen-lock, production-version, reservations, routing-execution-order-audit, routing, sales-availability, sales-demand-planning, sales-quotation, single-item-planning, single-level-planning, stock-requirements, stock-transport-order-reports, time-ticket-goods-movement, time-ticket, wip-batch, work-center
