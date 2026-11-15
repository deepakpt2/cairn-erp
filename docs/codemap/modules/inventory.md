# Inventory

**Purpose:** Stock/warehouse management: goods movement posting (issue, receipt, transfer, return, reversal, MIGO), material master (plant/valuation/period views), batch management end-to-end (master data, classification, status, search strategies, number ranges), physical inventory (count, post differences, recount), IMG config driving all of it (movement types, valuation classes, material types/groups, industry sectors). Also hosts production-order persistence layer and scheduling-profile config, since production orders snapshot components against inventory stock and post goods-issue/receipt through this module's posting primitives.

## Files

### Schema
- `src/modules/inventory/schema.ts` — all Drizzle tables: material master/valuation, movement types, material documents, stock quantity, reservations, material sales view (MVKE), serial-number master, production orders (persistence only — see gotchas), physical inventory, UoM conversion, batch mgmt config/master. Exports: `material`, `materialPlant`, `materialValuation`, `materialType`, `materialTypeValuation`, `materialGroup`, `materialPeriodControl`, `materialNumberRangeGroup`, `industrySector`, `accountCategoryReference`, `valuationClass`, `valuationClassReference`, `mrpController`, `planningFile`, `movementType`, `materialDocument`, `materialDocumentLine`, `stockQuantity`, `reservationHeader`, `reservationItem`, `materialSales`, `serialNumber`, `SERIAL_STATUSES_DB`, `productionOrder`, `productionOrderComponent`, `productionSchedulingProfile`, `physicalInventoryDocument`, `physicalInventoryItem`, `physicalInventoryDifferenceAllocation`, `physicalInventoryRecountLink`, `materialUomConversion`, `batch`, `batchLevelConfiguration`, `batchLevelConversion`, `batchStatusManagement`, `batchStatusPlant`, `batchStatusPlantConversion`, `batchNumberAssignment`, `batchAssignedReceipt`, `batchConditionTable`, `batchConditionTableField`, `batchAccessSequence`, `batchAccessStep`, `batchSearchProcedure`, `batchSearchProcedureStep`, `batchSearchAllocation`, `batchSearchStrategy`, `batchSearchStrategyKey`, `batchStrategyType`, `batchSortSequence`, `batchSortSequenceCriterion`, `batchConversionCheck`, `batchConversionConflict`, `batchDocumentManagement`. (`outputType`/`outputMessage` moved to `foundation/output-schema`.)

### Goods movements & posting
- `src/modules/inventory/goods-issue.ts` — MB1A/MIGO/sales goods issue posting; MB1A, order issue (261) and customer issue (601) check session authority + plant scope (261/601 also need `PROD.ORDER.GI`/`SALES.GI.POST`). Exports: `postGoodsIssue`, `GOODS_ISSUE_SCENARIOS`, `MB1A_SCENARIOS`, `MIGO_ISSUE_SCENARIOS`, `GoodsIssueError`, `getMaterialPeriodControlInTx`, `PRODUCTION_ORDER_ISSUE_CAPABILITY`, `SALES_GOODS_ISSUE_CAPABILITY`.
- `src/modules/inventory/goods-receipt.ts` — MIGO/PO goods receipt posting, incl. account-assigned-item refusal and reversal. Exports: `postGoodsReceipt`, `reverseGoodsReceipt`, `getReceiptOrder`, `getMaterialDocument`, `accountAssignedReceiptRefusal`, `GoodsReceiptError`, `DELIVERED_MOVEMENTS`.
- `src/modules/inventory/migo.ts` — MIGO action×reference matrix (which pairs wire to a real posting flow). Exports: `resolveMigoCell`, `migoMatrix`, `MIGO_ACTIONS`, `MIGO_REFERENCES`.
- `src/modules/inventory/transfer-posting.ts` — storage-location/plant/stock-type transfer posting + reversal, incl. 453/457/459 out of returns stock (posts stock vs `RETURNS_TRANSFER` journal); takes `ServiceAuthorityContext` (capability + both plants in scope). Exports: `postTransfer`, `postTransferInTx`, `reverseTransfer`, `validateTransfer`, `getTransferDocument`, `transferStockAt`, `TransferPostingError`.
- `src/modules/inventory/transfer-scenarios.ts` — delivered transfer movement/scenario catalogue (data only), incl. returns-stock 453/457/459 (+454/458/460 reversals). Exports: `TRANSFER_SCENARIOS`, `MOVEMENT_CHOICES`, `DELIVERED_TRANSFER_MOVEMENTS`, `COUNTER_CODES`. **Client-safe** (imported by the `TransferPosting` client component): may import only `stock-types.ts`, never a service — importing `warehouse-stocks` once pulled `next/headers` into the browser bundle and broke `next build`.
- `src/modules/inventory/stock-types.ts` — import-free stock type constants `UNRESTRICTED`, `QUALITY_INSPECTION`(`'QUALITY'`), `BLOCKED`, `RETURNS`; re-exported by `warehouse-stocks.ts`.
- `src/modules/inventory/return-delivery.ts` — MBRL vendor return-delivery posting against PO receipt. Exports: `postReturnDelivery`, `getReturnableDocument`, `getReturnDocument`, `resolveReturnMovement`, `ReturnDeliveryError`, `DELIVERED_RETURN_MOVEMENTS`.
- `src/modules/inventory/material-document-reversal.ts` — generic MBST reversal of any posted material document line; defers to `sales/goods-issue-reversal` to refuse/record reversal of a delivery goods issue. Exports: `reverseMaterialDocument`, `getReversalDocument`, `MaterialReversalError`.
- `src/modules/inventory/material-document-accounting.ts` — journal-entry linkage/status of a material document for display. Exports: `readJournalStatus`, `describeJournalAccounting`, `accountingForOriginal`.
- `src/modules/inventory/material-document-display.ts` — MB03 single-document display. Exports: `displayMaterialDocument`, `MaterialDocumentDisplayError`.
- `src/modules/inventory/material-document-list.ts` — MB51 multi-document search/list. Exports: `listMaterialDocuments`, `MaterialDocListError`.
- `src/modules/inventory/material-document-output.ts` — MB90 output (slip) determination/dispatch; writes to the shared `foundation/output-schema` queue as category `MATERIAL_DOCUMENT` (application `IN`), stores rendered slip, notifies on failure via `foundation/output-notify`. Exports: `recordOutputsForDocument`, `renderSlip`, `renderSlipIn`, `DELIVERED_OUTPUT_TYPES`, `MaterialDocumentOutputError`.
- `src/modules/inventory/balance-update.ts` — shared posting primitives: request-key replay/fingerprint locking, valuation balance (moving-average) update every poster calls. Exports: `applyValuationDelta`, `lockRequestKey`, `mismatchedRequest`, `postingFingerprint`, `quantityToken`, `REQUEST_MISMATCH_REMEDY`.
- `src/modules/inventory/storage-location.ts` — resolves/requires a storage location for a posting line. Exports: `resolveStorageLocation`, `proposeStorageLocation`, `storageLocationRequired`, `StorageLocationError`.
- `src/modules/inventory/reservations.ts` — MB21 reservation create/withdraw (planned future issues). Exports: `createReservation`, `withdrawReservation`, `withdrawReservationInTx`, `completeReservationItem`, `getReservation`, `ReservationError`, `RESERVATION_SCENARIOS`.
- `src/modules/inventory/initial-stock.ts` — MIGO 561 initial stock entry: material doc + stock + valuation + one journal (stock vs retained earnings) at the material's own price; no UI yet (used by `platform/tenancy/demo-procurement.ts`). Exports: `postInitialStock`, `INITIAL_STOCK_CAPABILITY`, `INITIAL_STOCK_MOVEMENT`, `INITIAL_STOCK_DESCRIPTION`, `InitialStockError`, `InitialStockAuthorizationContext`, `PostInitialStockInput`, `InitialStockView`.
- `src/modules/inventory/price-change.ts` — MR21-style standard/moving-average price change + future-price release. Exports: `changeMaterialPrice`, `releaseFuturePrices`, `listFuturePrices`, `PriceChangeError`.

### Stock reporting
- `src/modules/inventory/stock-overview.ts` — MMBE stock overview tree (plant/storage location/batch/stock type). Exports: `stockOverview`, `StockOverviewError`.
- `src/modules/inventory/warehouse-stocks.ts` — MB52 warehouse stock list; shows returns stock separately and excludes it from value. Exports: `listWarehouseStocks`, `WarehouseStockError`, `RETURNS` (re-exported from `stock-types.ts`).
- `src/modules/inventory/stock-posting-date.ts` — MB5B stock as of a posting date. Exports: `stockOnPostingDate`, `StockPostingDateError`.
- `src/modules/inventory/stock-reconcile.ts` — MB5L book-vs-derived stock drift check/rebuild. Exports: `reconcileStock`, `rebuildStockDimension`, `StockReconcileError`.
- `src/modules/inventory/shelf-life-list.ts` — MB5M shelf-life expiration list. Exports: `listShelfLife`, `businessDate`, `ShelfLifeListError`.
- `src/modules/inventory/unit-conversion.ts` — material-specific alternative UoM conversions. Exports: `toBaseQuantity`, `fromBaseQuantity`, `defineUomConversion`, `listUomConversions`, `removeUomConversion`, `listUnitsOfMeasure`, `UnitConversionError`.

### Serial numbers
- `src/modules/inventory/serial-number.ts` — serial-number master (one unit of a `serialManaged` material) + delivery-pick serial capture/release (writes `sales` `deliveryPickingSerial`). Exports: `saveSerialNumber`, `listSerialNumbers`, `requiresSerialFor`, `capturePickSerialsOn`, `releasePickSerialsOn`, `serialsOfPick`, `serialNumberInput`, `SerialNumberError`, `SERIAL_ROUTE`, `SERIAL_CAPABILITY`, `SERIAL_STATUSES`, `SERIAL_STATUS_MEANING`.
- `src/modules/inventory/serial-status.ts` — browser-safe serial status vocabulary (keeps `postgres` out of the client bundle). Exports: `SERIAL_STATUSES`, `SERIAL_STATUS_MEANING`, `SerialStatus`.

### Batch management — master data
- `src/modules/inventory/batch-master.ts` — MSC1N batch creation. Exports: `createBatch`, `readLevel`, `BatchMasterError`.
- `src/modules/inventory/batch-change.ts` — MSC2N batch change. Exports: `changeBatch`, `readBatch`, `BatchChangeError`.
- `src/modules/inventory/batch-display.ts` — MSC3N batch display. Exports: `displayBatch`, `batchStatusLabel`, `BatchDisplayError`.
- `src/modules/inventory/batch-cockpit.ts` — BMBC batch cockpit search/stock/document view. Exports: `searchBatches`, `readBatchCockpit`, `traceBatchGenealogy` (stub — `never`), `BatchCockpitError`.
- `src/modules/inventory/batch-pickup.ts` — MB5C batches-without-movement-in-period listing. Exports: `listBatchPickup`, `BatchPickupError`.
- `src/modules/inventory/batch-posting.ts` — resolves batch a posting line should use/create. Exports: `resolvePostingBatch`, `BatchPostingError`.
- `src/modules/inventory/batch-control-use.ts` — records batch-master function invocation (audit helper). Exports: `noteBatchControlUse`.
- `src/modules/inventory/batch-class.ts` — BMC1/2/3 batch class (classification type) assignment. Exports: `BatchClassError`, `PLANT_BATCH_CLASS_TYPE`, `MATERIAL_BATCH_CLASS_TYPE`.

### Batch management — search & sort strategy
- `src/modules/inventory/batch-search-strategy.ts` — MBC1/2/3 batch search strategy records. Exports: `listBatchSearchStrategies`, `listStrategyKeyCombinations`, `BatchSearchStrategyError`.
- `src/modules/inventory/batch-sort-sequence.ts` — CU70/71/72 batch sort sequence maintenance. Exports: `listSortSequences`, `BatchSortError`.
- `src/modules/inventory/batch-sort-sequence-vocabulary.ts` — sort-sequence status vocabulary. Exports: `SORT_STATUS`.

### Batch management — IMG configuration
- `src/modules/inventory/batch-access-sequence.ts` — OMCX access sequence/step config. Exports: `listBatchAccessSequences`, `saveBatchAccessSequence`, `deleteBatchAccessSequence`, `listBatchAccessSteps`, `saveBatchAccessStep`, `deleteBatchAccessStep`, `BatchAccessSequenceError`.
- `src/modules/inventory/batch-classification.ts` — OMCV movement-type batch classification config. Exports: `listBatchClassification`, `saveBatchClassification`, `batchClassificationRefusal`, `classificationOf`, `BatchClassificationError`.
- `src/modules/inventory/batch-classification-vocabulary.ts` — classification code vocabulary. Exports: `CLASSIFICATION_CODES`, `CLASSIFICATION_MEANING`, `ClassificationCode`.
- `src/modules/inventory/batch-condition-table.ts` — OMA1 condition table (IMG customer key fields) config. Exports: `listBatchConditionTables`, `saveBatchConditionTable`, `deleteBatchConditionTable`, `BatchConditionTableError`.
- `src/modules/inventory/batch-conversion.ts` — OMCT batch level/status conversion feasibility check (never executes). Exports: `checkBatchConversion`, `listConversionChecks`, `executeBatchConversion` (stub — `never`), `BatchConversionError`.
- `src/modules/inventory/batch-document-management.ts` — ODOC client-level document management flag. Exports: `getBatchDocumentManagement`, `saveBatchDocumentManagement`, `documentManagementActive`, `linkBatchDocument` (stub — `never`), `BatchDocumentError`.
- `src/modules/inventory/batch-level.ts` — OMCE batch level (client/material/plant) config + conversion prep. Exports: `dependentBatchData`, `BatchLevelCode`, `BATCH_LEVELS`, `BatchLevelError`.
- `src/modules/inventory/batch-management-img.ts` — IMG node tree for batch management area (display only). Exports: `BATCH_IMG_NODES`, `RELATED_BATCH_NODES`, `NOT_OCHA`, `NOT_OPENED`.
- `src/modules/inventory/batch-number-assignment.ts` — OMCZ internal/external batch number assignment activation (client + plant). Exports: `BatchNumberAssignmentError`, `BATCH_NUMBER_OBJECT`.
- `src/modules/inventory/batch-number-range.ts` — OMAD batch number range intervals. Exports: `getBatchNumberRanges`, `saveBatchNumberInterval`, `deleteBatchNumberInterval`, `displayBatchNumber`, `BatchNumberRangeError`.
- `src/modules/inventory/batch-search-allocation.ts` — OMCG movement-type → search procedure allocation. Exports: `listBatchSearchAllocations`, `saveBatchSearchAllocation`, `deleteBatchSearchAllocation`, `resolveBatchSearchAllocation`, `checkEnteredBatch`, `BatchSearchAllocationError`.
- `src/modules/inventory/batch-search-procedure.ts` — OMCY search procedure/step config. Exports: `listBatchSearchProcedures`, `saveBatchSearchProcedure`, `deleteBatchSearchProcedure`, `listBatchSearchProcedureSteps`, `saveBatchSearchProcedureStep`, `BatchSearchProcedureError`.
- `src/modules/inventory/batch-status.ts` — OMCS client batch-status-management activation. Exports: `getBatchStatusManagement`, `saveBatchStatus`, `executeBatchStatusConversion` (stub), `batchStatusScope`, `BatchStatusError`.
- `src/modules/inventory/batch-status-plant.ts` — OMCU plant-level batch-status activation. Exports: `listPlantBatchStatus`, `savePlantBatchStatus`, `validatePlantBatchStatus`, `listPlantStatusConversions`, `readPlantBatchStatusActive`, `BatchStatusPlantError`.
- `src/modules/inventory/batch-strategy-type.ts` — OMCW strategy type (condition type) config. Exports: `listBatchStrategyTypes`, `saveBatchStrategyType`, `deleteBatchStrategyType`, `BatchStrategyTypeError`.
- `src/modules/inventory/initial-batch-status.ts` — OMAB initial restricted-use decision per material type. Exports: `decideInitialRestrictedUse`, `listInitialBatchStatus`, `saveInitialBatchStatus`, `InitialBatchStatusError`.

### Material master & config
- `src/modules/inventory/materials.ts` — MM01-style material master save (all views, incl. SALES view → `material_sales` per sales org/channel; sales unit must have a UoM conversion) + deletion flag. Exports: `saveMaterialView`, `setMaterialDeletionFlag`, `materialChoices`, `listMaterials`, `getMaterialDetail`, `requireUsableMaterial`, `MaterialError`.
- `src/modules/inventory/material-shelf-life.ts` — per-material shelf-life fields (MARA SLED data). Exports: `getMaterialShelfLife`, `saveMaterialShelfLife`, `SHELF_LIFE_PERIODS`, `MaterialShelfLifeError`.
- `src/modules/inventory/material-group-definition.ts` — material group IMG config. Exports: `listMaterialGroups`, `saveMaterialGroup`, `setMaterialGroupActive`, `deleteMaterialGroup`, `MaterialGroupError`.
- `src/modules/inventory/material-number-range-groups.ts` — MMNR number range group config. Exports: `listMaterialNumberRangeGroups`, `saveMaterialNumberRangeGroup`, `deleteMaterialNumberRangeGroup`, `listMaterialRangeGroupOptions`, `MaterialRangeGroupError`.
- `src/modules/inventory/material-period-control.ts` — OMSY company-code posting period control, incl. period shift. Exports: `listMaterialPeriodControl`, `getMaterialPeriodControl`, `initializeMaterialPeriodControl`, `setMaterialPeriodIndicators`, `shiftMaterialPeriod`, `materialPeriodAllows`, `MaterialPeriodError`.
- `src/modules/inventory/material-type-definition.ts` — material type + account category reference + type valuation config. Exports: `listMaterialTypes`, `saveMaterialType`, `setMaterialTypeActive`, `deleteMaterialType`, `listAccountCategoryReferences`, `listTypeValuation`, `MaterialTypeError`.
- `src/modules/inventory/industry-sector-definition.ts` — MM01 industry sector master config. Exports: `listIndustrySectors`, `saveIndustrySector`, `setIndustrySectorActive`, `deleteIndustrySector`, `INDUSTRY_SECTOR_DEFAULTS`, `IndustrySectorError`.
- `src/modules/inventory/movement-type-configuration.ts` — movement type master config (direction, rules, account assignment, difference-posting event wiring). Exports: `listMovementTypes`, `saveMovementType`, `deleteMovementType`, `checkMovementType`, `MovementTypeConfigError`.
- `src/modules/inventory/movement-type-vocabulary.ts` — movement type enum vocabulary shared by config and posting code. Exports: `MOVEMENT_DIRECTIONS`, `MOVEMENT_REFERENCES`, `MOVEMENT_KINDS`, `MOVEMENT_STOCK_TYPES`, `MOVEMENT_RULES`, `MOVEMENT_NEGATIVE_POLICIES`, `MOVEMENT_ASSIGNMENTS`.
- `src/modules/inventory/valuation-class-definition.ts` — valuation class + account-category-reference assignment config. Exports: `listValuationClasses`, `saveValuationReference`, `listValuationReferences`, `listTypeReferences`, `listValuationGaps`, `valuationClassRefusal`, `postingValuationRefusal`, `referenceChangeBlock`, `ValuationClassError`.
- `src/modules/inventory/valuation-class-permission.ts` — pure helper: which material types a valuation class permits. Exports: `namedMaterialTypes`, `classPermittedForType`.
- `src/modules/inventory/standard-config.ts` — default type-valuation/material defaults seeded for new plant or tenant. Exports: `seedTypeValuationForPlant`, `applyMaterialDefaults`, `TYPE_UPDATING_DEFAULTS`.
- `src/modules/inventory/constants.ts` — material view vocabulary + view→capability map shared across material master screens. Exports: `MATERIAL_VIEWS` (incl. `SALES` → `SD.MATERIAL.SALES.MAINTAIN`), `MATERIAL_VIEW_CAPABILITY`, `MATERIAL_PANEL_VIEWS`, `isMaterialPanelView`, `MRP_TYPES`, `PROCUREMENT_TYPES`, `LOT_PROCEDURES`, `PRICE_CONTROLS`, `ITEM_CATEGORY_GROUPS`.
- `src/modules/inventory/form-values.ts` — tiny form-state helper for material master forms. Exports: `materialFormValue`.
- `src/modules/inventory/development-fixture.ts` — dev-only seed of sample materials. Exports: `seedDevelopmentMaterials`.

### Physical inventory
- `src/modules/inventory/physical-inventory.ts` — MI01/MI02 document create/cancel + stock-scope lock every physical-inventory flow takes. Exports: `createPhysicalInventory`, `cancelPhysicalInventory`, `listPhysicalInventory`, `writeInventoryDocument`, `lockStockScope`, `tryLockStockScope`, `assertInventoryCountOpen`, `PhysicalInventoryError`.
- `src/modules/inventory/physical-inventory-count.ts` — MI04 count entry/correction. Exports: `submitCounts`, `clearCount`, `getCountDocument`, `searchCountDocuments`, `getCountHistory`, `getCountStatus`, `countNamedRefusal`, `PhysicalInventoryCountError`.
- `src/modules/inventory/physical-inventory-differences.ts` — MI20 difference list + difference-workflow entry point. Exports: `listDifferences`, `getDifferenceDocument`, `openDifferenceWorkflow`, `labelOf`, `directionOf`, `PhysicalInventoryDifferenceError`.
- `src/modules/inventory/physical-inventory-posting.ts` — MI07 difference posting (+ reversal) — the one physical-inventory path writing a material document. Exports: `postDifferences`, `reverseDifferencePosting`, `getDifferencePosting`, `validateDifferencePosting`, `getPostingHistory`, `PhysicalInventoryPostingError`.
- `src/modules/inventory/physical-inventory-posting-status.ts` — recomputes item posting status, releases difference-allocation locks after posting/reversal. Exports: `recomputePostingStatus`, `releaseDifferenceAllocations`.
- `src/modules/inventory/physical-inventory-recount.ts` — MI11 recount creation/cancellation + recount-vs-original comparison. Exports: `createRecount`, `cancelRecount`, `validateRecount`, `getRecountSource`, `getRecountComparison`, `syncRecountLink`, `recountPostingBlock`, `recountCountRemedy`, `PhysicalInventoryRecountError`.

### Production-order persistence (hosted here, owned conceptually by production)
- `src/modules/inventory/production-orders.ts` — CO01 production order create/release persistence; snapshots BOM/routing (via `../production/*` services) onto order at creation; create/release require `options.authorization` (`ServiceAuthorityContext`) + plant scope. Exports: `createProductionOrder`, `releaseProductionOrder`, `getProductionOrder`, `previewProductionOrderBom`, `ProductionOrderError`.
- `src/modules/inventory/production-receipt.ts` — production-order goods receipt (order's own-material receipt), built on same posting primitives as `goods-receipt.ts`; requires `options.authorization` + company-code/plant scope. Exports: `postProductionReceipt`, `receivedQuantityFor`, `ProductionReceiptError`.
- `src/modules/inventory/production-document-quantity.ts` — SQL fragment helpers for "is this line reversed / does its reversal quantity disagree" used by production reporting. Exports: `lineNotReversed`, `lineReversalDisagreement`, `OPEN_PRODUCTION_DOCUMENT`, `REVERSAL_QUANTITY_DISAGREEMENT`.
- `src/modules/inventory/scheduling-profile.ts` — OPKP production scheduling profile config (release-on-create/batch-creation policy), plant assignment, order-time snapshot read. Exports: `listSchedulingProfiles`, `saveSchedulingProfile`, `assignSchedulingProfile`, `readMaterialSchedulingProfile`, `ensureOrderBatch`, `SchedulingProfileError`.

### Pages — inventory transactions (`src/app/inventory/**`)
- `src/app/inventory/goods-issue/page.tsx`, `GoodsIssue.tsx`, `actions.ts` — MB1A goods issue screen.
- `src/app/inventory/goods-receipt/page.tsx`, `GoodsReceipt.tsx`, `actions.ts` — goods receipt against a PO.
- `src/app/inventory/migo/page.tsx`, `MigoShell.tsx`, `actions.ts` — MIGO unified transaction shell.
- `src/app/inventory/transfer-posting/page.tsx`, `TransferPosting.tsx`, `actions.ts` — transfer posting screen.
- `src/app/inventory/return-delivery/page.tsx`, `ReturnDeliveryShell.tsx`, `actions.ts` — MBRL return delivery.
- `src/app/inventory/reversal/page.tsx`, `Reversal.tsx`, `actions.ts` — MBST material document reversal.
- `src/app/inventory/reservations/page.tsx`, `Reservations.tsx`, `actions.ts` — MB21 reservations.
- `src/app/inventory/price-change/page.tsx`, `PriceChange.tsx`, `actions.ts` — material price change.
- `src/app/inventory/material-documents/page.tsx` — MB03 material document display.
- `src/app/inventory/material-document-list/page.tsx`, `MaterialDocumentListShell.tsx` — MB51 document list.
- `src/app/inventory/material-document-output/page.tsx`, `MaterialDocumentOutput.tsx`, `actions.ts` — MB90 output.
- `src/app/inventory/stock-overview/page.tsx`, `StockOverviewShell.tsx` — MMBE.
- `src/app/inventory/warehouse-stocks/page.tsx`, `WarehouseStocksShell.tsx` — MB52.
- `src/app/inventory/stock-posting-date/page.tsx`, `StockOnPostingDateShell.tsx` — MB5B.
- `src/app/inventory/stock-reconcile/page.tsx`, `ReconcileShell.tsx`, `actions.ts` — MB5L.
- `src/app/inventory/shelf-life-list/page.tsx`, `ShelfLifeListShell.tsx` — MB5M.
- `src/app/inventory/serial-numbers/page.tsx`, `SerialNumbers.tsx`, `actions.ts` — serial-number master list/maintain.
- `src/app/inventory/uom-conversion/page.tsx`, `UomShell.tsx`, `actions.ts` — material UoM conversion maintenance.
- `src/app/inventory/materials/page.tsx`, `MaterialForm.tsx`, `DeletionFlags.tsx`, `ShelfLifePanel.tsx`, `actions.ts`, `shelf-life-action.ts` — MM01/02/03-style material master screen.
- `src/app/inventory/batches/display/page.tsx`, `batches/change/page.tsx`, `ChangeBatchForm.tsx`, `change/actions.ts`, `batches/new/page.tsx`, `CreateBatchForm.tsx`, `new/actions.ts`, `BatchRelations.tsx`, `DocumentTab.tsx` — MSC1N/2N/3N batch master.
- `src/app/inventory/batch-cockpit/page.tsx` — BMBC.
- `src/app/inventory/batch-pickup/page.tsx`, `BatchPickupShell.tsx` — MB5C.
- `src/app/inventory/batch-classes/page.tsx`, `ClassForm.tsx`, `actions.ts` — BMC1/2/3.
- `src/app/inventory/batch-search-strategies/page.tsx`, `StrategyForm.tsx`, `actions.ts` — MBC1/2/3.
- `src/app/inventory/batch-sort-sequences/page.tsx`, `SortForm.tsx`, `actions.ts` — CU70/71/72.
- `src/app/inventory/physical-inventory/page.tsx`, `PhysicalInventoryShell.tsx`, `CancelListed.tsx`, `actions.ts` — MI01/MI02.
- `src/app/inventory/physical-inventory-count/page.tsx`, `CountWorkbench.tsx`, `actions.ts` — MI04.
- `src/app/inventory/physical-inventory-differences/page.tsx`, `DifferenceList.tsx`, `actions.ts` — MI20.
- `src/app/inventory/physical-inventory-posting/page.tsx`, `PostingWorkbench.tsx`, `actions.ts` — MI07.
- `src/app/inventory/physical-inventory-recount/page.tsx`, `RecountWorkbench.tsx`, `actions.ts` — MI11.

### Pages — IMG/config screens (`src/app/config/**`)
- `src/app/config/batch-access-sequences/page.tsx`, `AccessSequenceForm.tsx`, `actions.ts` — OMCX.
- `src/app/config/batch-classification/page.tsx`, `ClassificationForm.tsx`, `actions.ts` — OMCV.
- `src/app/config/batch-condition-tables/page.tsx`, `ConditionTableForm.tsx`, `actions.ts` — OMA1.
- `src/app/config/batch-conversion/page.tsx`, `ConversionForm.tsx`, `actions.ts` — OMCT.
- `src/app/config/batch-document-management/page.tsx`, `DocumentForm.tsx`, `actions.ts` — ODOC.
- `src/app/config/batch-initial-status/page.tsx`, `InitialStatusForm.tsx`, `actions.ts` — OMAB.
- `src/app/config/batch-level/page.tsx`, `BatchLevelForm.tsx`, `actions.ts` — OMCE.
- `src/app/config/batch-management/page.tsx` — OCHA IMG node tree.
- `src/app/config/batch-number-assignment/page.tsx`, `BatchNumberAssignmentForm.tsx`, `actions.ts` — OMCZ.
- `src/app/config/batch-number-ranges/page.tsx`, `BatchNumberRangeForms.tsx`, `actions.ts` — OMAD.
- `src/app/config/batch-search-allocations/page.tsx`, `AllocationForm.tsx`, `actions.ts` — OMCG.
- `src/app/config/batch-search-procedures/page.tsx`, `SearchProcedureForm.tsx`, `actions.ts` — OMCY.
- `src/app/config/batch-status/page.tsx`, `BatchStatusForm.tsx`, `actions.ts` — OMCS.
- `src/app/config/batch-status-plants/page.tsx`, `PlantBatchStatusForm.tsx`, `actions.ts` — OMCU.
- `src/app/config/batch-strategy-types/page.tsx`, `StrategyTypeForm.tsx`, `actions.ts` — OMCW.
- `src/app/config/industry-sectors/page.tsx`, `IndustrySectors.tsx`, `actions.ts` — MM01 industry sectors.
- `src/app/config/material-groups/page.tsx`, `MaterialGroups.tsx`, `actions.ts` — material group config.
- `src/app/config/material-number-ranges/page.tsx`, `MaterialNumberRanges.tsx`, `actions.ts` — MMNR.
- `src/app/config/material-period-control/page.tsx`, `MaterialPeriodControl.tsx`, `actions.ts` — OMSY.
- `src/app/config/material-types/page.tsx`, `MaterialTypes.tsx`, `actions.ts` — material type config.
- `src/app/config/movement-types/page.tsx`, `MovementTypes.tsx`, `actions.ts` — movement type config.
- `src/app/config/valuation-classes/page.tsx`, `ValuationClasses.tsx`, `actions.ts` — valuation class config.

## Pages & API routes
- `/inventory/goods-issue`, `/inventory/goods-receipt`, `/inventory/migo`, `/inventory/transfer-posting`, `/inventory/return-delivery`, `/inventory/reversal` — goods movement posting screens (MB1A, GR, MIGO, transfer, MBRL, MBST).
- `/inventory/reservations` — MB21 reservations.
- `/inventory/price-change` — material price change / future price release.
- `/inventory/material-documents`, `/inventory/material-document-list`, `/inventory/material-document-output` — MB03/MB51/MB90 document display, search, output.
- `/inventory/stock-overview`, `/inventory/warehouse-stocks`, `/inventory/stock-posting-date`, `/inventory/stock-reconcile`, `/inventory/shelf-life-list` — MMBE/MB52/MB5B/MB5L/MB5M reporting.
- `/inventory/uom-conversion` — material UoM conversion maintenance.
- `/inventory/serial-numbers` — serial-number master.
- `/inventory/materials` — material master (MM01/02/03-style, all views).
- `/inventory/batches/{new,change,display}`, `/inventory/batch-cockpit`, `/inventory/batch-pickup`, `/inventory/batch-classes`, `/inventory/batch-search-strategies`, `/inventory/batch-sort-sequences` — batch master and batch-specific strategy/class/sort maintenance.
- `/inventory/physical-inventory`, `/inventory/physical-inventory-count`, `/inventory/physical-inventory-differences`, `/inventory/physical-inventory-posting`, `/inventory/physical-inventory-recount` — MI01/02, MI04, MI20, MI07, MI11.
- `/config/batch-*` (access-sequences, classification, condition-tables, conversion, document-management, initial-status, level, management, number-assignment, number-ranges, search-allocations, search-procedures, status, status-plants, strategy-types) — batch management IMG.
- `/config/industry-sectors`, `/config/material-groups`, `/config/material-number-ranges`, `/config/material-period-control`, `/config/material-types`, `/config/movement-types`, `/config/valuation-classes` — material master and movement-type IMG config.
- `/config/scheduling-profiles` — OPKP scheduling profile config; `actions.ts`/`page.tsx`/`SchedulingProfileForm.tsx` live under `src/app/config/scheduling-profiles/` (outside this module's file scope) but call into `src/modules/inventory/scheduling-profile.ts`.

## Database
**Owns these tables/models** (from `src/modules/inventory/schema.ts`): `accountCategoryReference`, `industrySector`, `materialType`, `materialTypeValuation`, `materialGroup`, `materialPeriodControl`, `materialNumberRangeGroup`, `valuationClass`, `valuationClassReference`, `mrpController`, `material`, `materialPlant`, `materialValuation`, `planningFile`, `movementType`, `materialDocument`, `materialDocumentLine`, `stockQuantity`, `reservationHeader`, `reservationItem`, `materialSales`, `serialNumber`, `productionOrder`, `productionSchedulingProfile`, `productionOrderComponent`, `physicalInventoryDocument`, `physicalInventoryItem`, `physicalInventoryDifferenceAllocation`, `physicalInventoryRecountLink`, `materialUomConversion`, `batchLevelConfiguration`, `batchLevelConversion`, `batch`, `batchStatusManagement`, `batchStatusPlant`, `batchStatusPlantConversion`, `batchNumberAssignment`, `batchAssignedReceipt`, `batchConditionTable`, `batchConditionTableField`, `batchAccessSequence`, `batchAccessStep`, `batchSearchProcedure`, `batchSearchProcedureStep`, `batchSearchAllocation`, `batchSearchStrategy`, `batchSearchStrategyKey`, `batchStrategyType`, `batchSortSequence`, `batchSortSequenceCriterion`, `batchConversionCheck`, `batchConversionConflict`, `batchDocumentManagement`.

Note: `productionOrder`, `productionOrderComponent`, `productionSchedulingProfile` live in this module's schema file, populated/queried by `production-orders.ts`/`scheduling-profile.ts` here, though conceptually "production order" is production module's business object — see gotchas.

**Reads/writes tables owned by other modules:**
- `outputType`, `outputMessage` (foundation `output-schema`) — MB90 queue, filtered to category `MATERIAL_DOCUMENT`.
- `salesOrg`, `distributionChannel` (foundation) — FKs/validation for `material_sales`.
- `deliveryPickingSerial` (sales) — `serial-number.ts` captures/releases pick serials.
- `plant`, `purchasingGroup` (foundation) — every plant-scoped table FKs to `plant`; goods movement/transfer postings validate plant and storage location exist there.
- `purchaseOrder`, `purchaseOrderItem`, `documentRelease` (purchasing) — `goods-receipt.ts`/`return-delivery.ts` read PO/PO item to post receipt or return against it and check account assignment/delivery-completion policy.
- `journalEntry` (finance) — `price-change.ts` reads/links journal entry a price change posts.
- Production module tables/services (`order-bom-snapshot`, `order-operation-snapshot`, `production-order-status`, `wip-batch`, `productionOrderType` from `production/schema`) — `production-orders.ts` snapshots BOM/routing and order type at order creation.

## Depends on
- **purchasing** — `goods-receipt.ts` imports `../purchasing/delivery-completion` (over/under-delivery policy), `../purchasing/account-assignment`; `goods-receipt.ts`/`return-delivery.ts` import `purchaseOrder`/`purchaseOrderItem`/`documentRelease` from `../purchasing/schema` to post against a PO.
- **production** — `production-orders.ts` imports `../production/order-bom-snapshot`, `../production/order-operation-snapshot`, `../production/production-order-status`, `../production/wip-batch`, `productionOrderType` from `../production/schema`.
- **finance** — `price-change.ts` imports `journalEntry` from `../finance/schema`.
- **sales** — `serial-number.ts` imports `deliveryPickingSerial` from `../sales/schema`; `material-document-reversal.ts` imports `../sales/goods-issue-reversal`.
- **foundation** — `../foundation/schema` (`plant`, `purchasingGroup`), `../foundation/account-determination`, `../foundation/business-partner-schema`, `../foundation/characteristic-schema` (batch classification), `../foundation/number-ranges`, `../foundation/services`, `../foundation/output-schema`, `../foundation/output-notify`.
- Shared/platform: `platform/auth/current`, `platform/auth/session`, `platform/auth/service-authority`, `platform/change`, `platform/db/client`, `platform/document`, `platform/numbering`, `platform/periods`, `platform/posting`, `platform/posting/decimal`, `platform/tables/audit-trail`, `platform/tables/numbering`, `platform/tables/reference`, `platform/tables/tenancy`, `platform/tenancy`.

## Used by
Grep of `@/modules/inventory` outside this module's own src files turned up only:
- **production** — `src/app/production/production-versions/page.tsx`, `routings/page.tsx`, `boms/page.tsx` import `material` from `@/modules/inventory/schema` (material picker); `src/app/production/order-information/page.tsx` imports `MATERIAL_DOC_DISPLAY_CAPABILITY`; `src/app/production/orders/{actions.ts,page.tsx}` import from `@/modules/inventory/production-orders` (production-order UI calls order create/release logic hosted here).
- **purchasing** — `src/app/purchasing/info-record/actions.ts` imports `UnitConversionError` from `@/modules/inventory/unit-conversion` (info-record UoM validation reuses inventory's conversion error type).
- **config (scheduling-profiles)** — `src/app/config/scheduling-profiles/{page.tsx,actions.ts,SchedulingProfileForm.tsx}` import from `@/modules/inventory/scheduling-profile` (OPKP config UI, route is `/config/*` not `/inventory/*`).
- **sales** — many `src/modules/sales/*` import `../inventory/schema` plus `goods-issue`, `serial-number`, `warehouse-stocks`, `unit-conversion`, `storage-location`, `material-document-output`, `balance-update`.
- **quality** — `lot.ts`, `usage-decision.ts`, `schema.ts` import inventory schema/posting.

Other modules (people, hr-adjacent, etc.) don't import inventory directly; stock/goods-movement effects reach them only through posted `material_document` rows, not direct calls.

## Tests
- **Goods movement & posting:** `atomic-inventory-posting.test.ts`, `goods-issue.test.ts`, `goods-issue-ui-contract.test.ts`, `goods-receipt.test.ts`, `goods-receipt-batch-layer.test.ts`, `migo-component-issue.test.ts`, `migo-matrix-ui-contract.test.ts`, `migo-transfer.test.ts`, `transfer-posting.test.ts`, `transfer-posting-ui-contract.test.ts`, `initial-stock.test.ts`, `helpers/transfer-authorized.ts`, `transfer-batch.test.ts`, `transfer-batch-requirement.test.ts`, `return-delivery.test.ts`, `return-delivery-batch.test.ts`, `return-delivery-ui-contract.test.ts`, `reversal-batch.test.ts`, `storage-location-posting.test.ts`, `inventory-block-invariant.test.ts`, `reservations.test.ts`, `reservation-ui-contract.test.ts`, `scheduling-profile.test.ts`, `production-order-create.test.ts`, `mb1b-configuration-decides.test.ts`, `mb1b-configuration-ui-contract.test.ts`, `mb1b-movement-config-contract.test.ts`, `movement-type-configuration.test.ts`, `movement-type-configuration-screen-contract.test.ts`, `helpers/goods-issue-authorized.ts`, `helpers/goods-receipt-authorized.ts`.
- **Material documents (display/list/output/reversal):** `material-document-batch-display.test.ts`, `material-document-display.test.ts`, `material-document-display-ui-contract.test.ts`, `material-document-list.test.ts`, `material-document-list-batch.test.ts`, `material-document-list-index-contract.test.ts`, `material-document-list-ui-contract.test.ts`, `material-document-output.test.ts`, `material-document-output-ui-contract.test.ts`, `material-document-reversal.test.ts`, `material-document-reversal-accounting.test.ts`, `material-document-reversal-ui-contract.test.ts`.
- **Batch management:** `batch-access-sequence.test.ts`, `batch-access-step.test.ts`, `batch-assignment.test.ts`, `batch-catalogue-sentences.test.ts`, `batch-change.test.ts`, `batch-class.test.ts`, `batch-classification.test.ts`, `batch-cockpit.test.ts`, `batch-condition-table.test.ts`, `batch-control-use.test.ts`, `batch-conversion.test.ts`, `batch-display.test.ts`, `batch-document-management.test.ts`, `batch-level.test.ts`, `batch-management-img.test.ts`, `batch-master.test.ts`, `batch-number-assignment.test.ts`, `batch-number-range.test.ts`, `batch-pickup.test.ts`, `batch-posting.test.ts`, `batch-procurement-chain.test.ts`, `batch-search-allocation.test.ts`, `batch-search-procedure.test.ts`, `batch-search-strategy.test.ts`, `batch-sort-sequence.test.ts`, `batch-status.test.ts`, `batch-status-plant.test.ts`, `batch-strategy-type.test.ts`, `initial-batch-status.test.ts`, `stock-batch-readback.test.ts`.
- **Physical inventory:** `mi04-count-schema-contract.test.ts`, `mi04-count-ui-contract.test.ts`, `mi07-posting-schema-contract.test.ts`, `mi11-recount-schema-contract.test.ts`, `mi20-difference-ui-contract.test.ts`, `mi20-index-decision.test.ts`, `physical-inventory.test.ts`, `physical-inventory-batch.test.ts`, `physical-inventory-count.test.ts`, `physical-inventory-differences.test.ts`, `physical-inventory-posting.test.ts`, `physical-inventory-posting-ui-contract.test.ts`, `physical-inventory-recount.test.ts`, `physical-inventory-recount-ui-contract.test.ts`, `physical-inventory-ui-contract.test.ts`.
- **Material master & config:** `development-fixture.test.ts`, `industry-sector-definition.test.ts`, `material-deletion-flag.test.ts`, `material-form-values.test.ts`, `material-group-definition.test.ts`, `material-number-range-groups.test.ts`, `material-period-control.test.ts`, `material-type-definition.test.ts`, `materials.test.ts`, `shelf-life-list.test.ts`, `valuation-class-definition.test.ts`.
- **Stock reporting:** `stock-overview.test.ts`, `stock-overview-ui-contract.test.ts`, `stock-posting-date.test.ts`, `stock-posting-date-ui-contract.test.ts`, `stock-reconcile-uom.test.ts`, `warehouse-stocks.test.ts`, `warehouse-stocks-ui-contract.test.ts`.
- **Cross-cutting / hygiene:** `hygiene-vocabulary.ts`, `source-keyword-hygiene.test.ts`.

## Scripts
- `scripts/browser-smoke/batch-document-management.ts`, `goods-issue.ts`, `goods-receipt.ts`, `industry-sectors.ts`, `invoice-verification.ts`, `material-deletion-flag.ts`, `material-document-display.ts`, `material-document-list.ts`, `material-document-output.ts`, `material-document-reversal.ts`, `material-groups.ts`, `material-number-ranges.ts`, `material-period-control.ts`, `material-types.ts`, `migo-component-issue.ts`, `migo-production-receipt.ts`, `migo-transfer-posting.ts`, `movement-types.ts`, `physical-inventory.ts`, `production-order-cost-report.ts`, `reservations.ts`, `scr146-mb1b-configuration.ts`, `scr147-mi04-count.ts`, `scr148-mi20-differences.ts`, `scr149-mi07-posting.ts`, `scr150-mi11-recount.ts`, `stock-overview.ts`, `stock-posting-date.ts`, `transfer-posting.ts`, `valuation-classes.ts`, `warehouse-stocks.ts`.
- `scripts/plan-mb03.mts`, `plan-mb1a.mts`, `plan-mb1b.mts`, `plan-mb21.mts`, `plan-mb51.mts`, `plan-mb52.mts`, `plan-mb5b.mts`, `plan-mb90.mts`, `plan-mbst.mts`, `plan-mmbe.mts`.

## Non-obvious behavior / gotchas
- Production orders (`productionOrder`, `productionOrderComponent`, `productionSchedulingProfile`) defined in `inventory/schema.ts`; persistence logic (`production-orders.ts`, `production-receipt.ts`, `scheduling-profile.ts`) in `src/modules/inventory/`, though BOM/routing snapshot logic they call lives in `src/modules/production/`. Component list is a frozen snapshot at creation — changing source BOM later never rewrites an existing order.
- `stock_quantity` has no non-negative DB check by design: a row check can't see storage-location's negative-stock-allowed config; guard lives in app code (`transfer-posting.ts`/`goods-issue.ts`), not schema.
- Request-key replay = advisory-lock + fingerprint, not a unique index: `balance-update.ts`'s `lockRequestKey` takes `pg_advisory_xact_lock` keyed on `client/md-request/{requestKey}` before insert; `mismatchedRequest` compares SHA-256 fingerprint of posting payload — same key+same payload replays silently, same key+different payload refused. Shared by `goods-issue`, `goods-receipt`, `transfer-posting`, `return-delivery`, `physical-inventory-posting`, `production-receipt`.
- `movementType.movementKind = 'INVENTORY_DIFFERENCE'` has CHECK-level shape constraint (`movement_type_difference_shape_ck`): difference movement must be RECEIPT/ISSUE against `PHYSICAL_INVENTORY`, and if valuation-relevant must carry `inventoryEvent`/`offsetEvent`/`offsetModifier` — MI07 posting event wiring is config-as-data, not hardcoded.
- Batch identity has no single-column uniqueness: which of `(material, plant, batchNumber)`, `(material, batchNumber)`, `(batchNumber)` must be unique depends on `batchLevelAtCreation`, enforced via three `where`-qualified unique indexes (`batch_plant_level_uq`, `batch_material_level_uq`, `batch_client_level_uq`). Batch level frozen at creation; level-wide conversion only checks feasibility (`batch-conversion.ts`, `batch-level.ts`) or stores a refusal row. `executeBatchConversion`, `executeBatchStatusConversion`, `linkBatchDocument`, `traceBatchGenealogy` typed `never` — deliberate unimplemented stubs, not bugs.
- Physical inventory differences post through normal material-document path via `physical-inventory-posting.ts` calling same balance/request-key primitives as goods movements; link between difference item and resulting material-document line is its own table (`physicalInventoryDifferenceAllocation`) with a "reversed quantity" column (not a status enum) — partially-reversed posting is representable.
- `production_order.company_code` dropped (migration 9272): company code is always read from the order's plant; only `controlling_area` is snapshotted at creation.
- Initial stock (561, `INV.INITIAL_STOCK.POST`, migration 9275) has no reversal movement — MBST refuses it; movement type row is created in the tenant catalogue on first post, not by migration. Offset is retained earnings, not a clearing account.
- Returns stock (`stock_type = 'RETURNS'`, from 651) is not valuated: MB52 excludes it from value, and 453/457/459 out of it post a journal (`INVENTORY` vs `RETURNS_TRANSFER`) as value enters stock.
- `serial_number` is a capture record, not the stock ledger — nothing reconciles serial rows against `stock_quantity`. Serial-required switch is `material.serial_managed` (pick capture); `requires_serial` on movement type still blocks transfers/PI.
- Posting services (`transfer-posting`, `production-orders`, `production-receipt`, MB1A/261/601 issue) now verify a `ServiceAuthorityContext` (`{userId, sessionId}`) inside the tx; tests use `tests/helpers/*-authorized.ts` / `*-actor.ts` wrappers.
