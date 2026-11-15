# Production

**Purpose:** MRP/shop-floor execution, discrete mfg. MD01/MD02/MD03 demand planning; planned-order create/convert to production orders; BOM/routing/production-version/work-center maintenance; CO11N/CO15/CO13 confirmations (trigger component issues + FG receipts); order settlement to cost centers/internal orders; COGI postprocessing queue for failed confirmation-driven goods movements.

## Files
### MRP & planning
- `src/modules/production/mrp-run.ts` — MD01/MD02/MD03 engine. Exports: `planMaterials`, `planSingleItem`, `planSingleLevel`, `getMrpRun`, `listMrpRuns`, `cancelMrpRun`
- `src/modules/production/mrp-explosion.ts` — BOM explosion into dependent requirements, one planned order. Exports: `explodePlannedSupply`, `componentRequirementQuantity`, `ExplosionDiagnostic`, `SCALE`, `DEPTH_LIMIT` (the last two shared with the BOM explosion report)
- `src/modules/production/bom-explosion.ts` — CS11/CS12 `explodeBom` and CS15 `whereUsedBom` (item 8), read-only. Reproduces MRP's walk exactly: `componentRequirementQuantity`, `SCALE`, `DEPTH_LIMIT`, cycle rule, `selectProductionVersion` (`PLANNING`, base unit) for the top and every lower BOM, conversion to the component base unit before recursing; explodes MAKE only (BUY → `BUY_NOT_EXPLODED`, other types → `NOT_MAKE`), phantoms passed through with their components one level below; bulk/co-product/issuing-plant/special-procurement items shown but not recursed (MRP does not plan them). A named usage+alternative overrides the version; with no quantity the BOM base quantity is exploded. Where-used lists any parent BOM whatever its procurement type, BOM quantities per base only, with cycle and depth rules; `allScopedPlants` reads every plant in the user's Plant scope. Authority `PROD.BOM.DISPLAY` + Plant scope (no new capability; registry `PROD.BOM.EXPLOSION` with aliases CS11/CS12/CS15, migration 9285).
- `src/modules/production/mrp-structure.ts` — multi-level structural BOM walk, diagnostics. Exports: `structuralBomLevels`
- `src/modules/production/stock-requirements.ts` — MD04 list. Exports: `stockRequirementsList`
- `src/modules/production/conversion-outcome.ts` — shared vocab, planned-order conversion results. Exports: `ConversionStatus`, `DemandReconciliation`, `summarizeConversionResults`
- `src/app/production/mrp-run/{actions.ts,MrpRunWorkbench.tsx,page.tsx}`, `single-item-planning/{actions.ts,SingleItemWorkbench.tsx,page.tsx}`, `single-level-planning/{actions.ts,SingleLevelWorkbench.tsx,page.tsx}`, `stock-requirements/{StockRequirementsShell.tsx,page.tsx}` — MD01/MD02/MD03/MD04 UIs resp.

### Planned orders
- `src/modules/production/planned-order-create.ts` — MD11 create. Exports: `createPlannedOrder`
- `src/modules/production/planned-order-change.ts` — MD12 change. Exports: `changePlannedOrder`
- `src/modules/production/planned-order-display.ts` — MD13 display/list. Exports: `getPlannedOrder`, `listPlannedOrders`
- `src/modules/production/planned-order-conversion.ts` — CO40/CO41 convert to production order(s), single/collective; delegates creation to `inventory/production-orders.ts`; input now carries `authorization: ServiceAuthorityContext`. Exports: `convertPlannedOrder`, `convertPlannedOrders`, `previewPlannedOrderConversion`, `listConvertiblePlannedOrders`, `listConversionLog`
- `src/app/production/planned-order-create/{actions.ts,PlannedOrderCreateForm.tsx,page.tsx}`
- `src/app/production/planned-order-change/{actions.ts,PlannedOrderForm.tsx,page.tsx}`
- `src/app/production/planned-order-display/page.tsx`
- `src/app/production/planned-order-conversion/{actions.ts,ConvertForm.tsx,page.tsx}`
- `src/app/production/planned-order-conversion-collective/{actions.ts,CollectiveForm.tsx,page.tsx}`

### Production orders (change/display/status/settlement)
- `src/modules/production/production-order-change.ts` — CO02 change + technical completion; requires `authorization` (`ServiceAuthorityContext`) + order plant in scope. Exports: `changeProductionOrder`, `technicallyCompleteProductionOrder`, `revokeTechnicalCompletion`
- `src/modules/production/production-order-display.ts` — CO03 display/list. Exports: `getProductionOrderDisplay`, `listProductionOrders`
- `src/modules/production/production-order-status.ts` — status model, shared change/confirmation/settlement. Exports: `ProductionOrderStatus`, `confirmationBlockReason`, `productionOrderMayBeCharged`
- `src/modules/production/production-order-type.ts` — OPJH order-type config. Exports: `saveProductionOrderType`, `listProductionOrderTypes`
- `src/modules/production/order-type-parameters.ts` — OPL8 plant/order-type params (config). Exports: `saveOrderTypeParameter`, `readProductionVersionSelection`
- `src/modules/production/order-settlement.ts` — settle order(s) to receivers; company code resolved from the order's plant. Exports: `settleProductionOrder`, `settleProductionOrdersCollective`
- `src/modules/production/settlement-configuration.ts` — settlement rule/profile assignment per order/order type. Exports: `saveProductionOrderSettlementConfiguration`, `assignProductionOrderTypeSettlementProfile`, `getSettlementConfiguration`
- `src/modules/production/order-cost-report.ts` — cost report display; company code joined from plant. Exports: `getProductionOrderCostReport`
- `src/modules/production/order-information.ts` — COOIS multi-order/planned-order list, saved layouts. Exports: `runOrderInformation`, `listOrderInformationLayouts`
- `src/modules/production/order-bom-snapshot.ts` — freezes BOM components onto new order. Exports: `resolveOrderBomSnapshot`
- `src/modules/production/order-operation-snapshot.ts` — freezes routing operations onto new order. Exports: `resolveOrderOperationSnapshot`, `insertOrderOperationSnapshot`
- `src/app/production/orders/{actions.ts,OrderCreate.tsx,page.tsx}` — creation entry (delegates to inventory)
- `src/app/production/production-order-change/{actions.ts,OrderChangeForm.tsx,page.tsx}`
- `src/app/production/production-order-display/page.tsx`
- `src/app/production/order-information/{actions.ts,OrderInformationResult.tsx,page.tsx}`
- `src/app/production/order-cost-report/page.tsx`
- `src/app/production/order-settlement/{actions.ts,SettlementForm.tsx,page.tsx}`
- `src/app/config/production-order-types/{actions.ts,ProductionOrderTypeForm.tsx,page.tsx}`
- `src/app/config/order-type-parameters/{actions.ts,OrderTypeParameterForm.tsx,page.tsx}`

### Order availability & checking control (config + ATP)
- `src/modules/production/availability-check.ts` — OVZ2/OPJL/OVZ9/OPJJ config: checking groups, rules, scope-of-check, assignment
- `src/modules/production/checking-control.ts` — OPJK config, per plant/order type/business function. Exports: `saveCheckingControl`, `checkingControlRefusal`
- `src/modules/production/order-availability.ts` — CO09 ATP check vs order's components (all-zero elements count as nothing available). Exports: `checkOrderAvailability`
- `src/modules/production/order-availability-commitment.ts` — commit/release/reset component availability commitments, append-only event log. Exports: `commitOrderComponentAvailability`, `resetOrderComponentAvailability`
- `src/app/config/availability-check/{actions.ts,AvailabilityCheckForm.tsx,page.tsx}`
- `src/app/config/checking-control/{actions.ts,CheckingControlForm.tsx,page.tsx}`
- `src/app/production/order-availability/{actions.ts,OrderAvailabilityWorkbench.tsx,page.tsx}`

### BOMs
- `src/modules/production/material-bom.ts` — BOM config (usage/status/item-category) + CS01/CS02/CS03-style CRUD. Exports: `createMaterialBom`, `changeMaterialBom`, `selectEffectiveMaterialBom`, `saveBomUsage`, `saveBomStatus`, `saveBomItemCategory`
- `src/modules/production/material-bom-display.ts` — thin display re-export. Exports: `displayMaterialBom`, `listMaterialBomsForDisplay`
- `src/app/production/boms/{actions.ts,BomForm.tsx,ConfigForms.tsx,page.tsx}`
- `src/app/production/bom-display/page.tsx`
- `src/app/production/bom-explosion/page.tsx` — CS11/CS12/CS15 report (GET: `mode`, `materialNumber`, `plant`, `keyDate`, `depth`, `quantity`, `usage`, `alternative`, `productionVersion`, `allPlants`); diagnostics on their rows.

### Routings & work centers
- `src/modules/production/routing.ts` — routing config (task-list type/usage/status/control key/std value key) + standard routing CRUD. Exports: `createRouting`, `changeRouting`, `selectEffectiveRouting`, `saveRoutingControlKey`, etc.
- `src/modules/production/routing-display.ts` — thin display re-export. Exports: `displayRouting`, `listRoutingsForDisplay`
- `src/modules/production/work-center.ts` — CR01-style work center + capacity + costing CRUD, category config. Exports: `createWorkCenter`, `changeWorkCenter`, `saveWorkCenterCategory`
- `src/modules/production/work-center-display.ts` — thin display re-export. Exports: `displayWorkCenter`
- `src/app/production/routings/{actions.ts,ConfigForms.tsx,RoutingForm.tsx,page.tsx}`
- `src/app/production/routing-display/page.tsx`
- `src/app/production/work-centers/{actions.ts,CategoryForm.tsx,WorkCenterForm.tsx,page.tsx}`
- `src/app/production/work-center-display/page.tsx`

### Production versions
- `src/modules/production/production-version.ts` — MKAL-style CRUD, check, lock/delete, selection. Exports: `createProductionVersion`, `changeProductionVersion`, `checkProductionVersion`, `lockProductionVersion`, `deleteProductionVersion`, `selectProductionVersion`, `saveProductionVersionRule`
- `src/modules/production/production-version-display.ts` — thin display re-export
- `src/app/production/production-versions/{actions.ts,VersionForm.tsx,page.tsx}`
- `src/app/production/production-version-display/page.tsx`

### Confirmations & time tickets
- `src/modules/production/order-confirmation.ts` — CO15 header-level confirmation. Exports: `enterOrderConfirmation`, `previewOrderConfirmation`, `loadOrderConfirmation`, `getOrderConfirmation`
- `src/modules/production/time-ticket.ts` — CO11N operation-level confirmation; passes optional `authorization` through to movement posting. Exports: `enterTimeTicket`, `previewTimeTicket`, `loadTimeTicket`, `getTimeTicket`
- `src/modules/production/confirmation-movements.ts` — turns confirmation into planned component-issue/receipt movements. Exports: `planConfirmationMovements`, `plannedMovements`, `postedMovements`, `movementStands`
- `src/modules/production/confirmation-cancel.ts` — CO13 cancel posted confirmation. Exports: `cancelConfirmation`, `loadConfirmationCancellation`
- `src/modules/production/confirmation-display.ts` — search/detail display. Exports: `searchProductionConfirmations`, `getProductionConfirmationDisplay`
- `src/app/production/order-confirmation/{actions.ts,OrderConfirmationWorkbench.tsx,page.tsx}`
- `src/app/production/time-ticket/{actions.ts,TimeTicketWorkbench.tsx,page.tsx}`
- `src/app/production/confirmation-cancel/{actions.ts,ConfirmationCancelWorkbench.tsx,page.tsx}`
- `src/app/production/confirmation-display/{loading.tsx,page.tsx}`

### COGI — confirmation goods-movement postprocessing
- `src/modules/production/production-goods-movement-failures.ts` — durable work-item queue: persist intent, claim/lease, attempt (posts with the claimant's authority), recover abandoned, correction revisions; enqueues a `POSTING.FAILED` fan-out notification on first failure. Exports: `persistConfirmationMovementIntents`, `claimProductionGoodsMovementFailure`, `attemptProductionGoodsMovementFailure`, `recoverAbandonedProductionGoodsMovementFailure`, `AutomaticMovementAuthorityError`
- `src/modules/production/production-cogi.ts` — COGI workbench logic over queue. Exports: `listProductionCogiFailures`, `correctProductionCogiFailure`, `retryProductionCogiFailure`, `discardProductionCogiFailure`
- `src/modules/production/production-cogi-auth.ts` — authorization/scope guard. Exports: `requireProductionCogiAuthorityInTx`, `requireProductionCogiFailureScopeInTx`
- `src/app/production/cogi/{actions.ts,ProductionCogiWorkbench.tsx,page.tsx}`

### WIP batch & scheduling profile config
- `src/modules/production/wip-batch.ts` — OMCWB one-way WIP-batch activation flag. Exports: `saveWipBatchActivation`, `wipBatchActive`, `getWipBatchActivation`
- `src/app/config/wip-batch/{actions.ts,WipForm.tsx,page.tsx}`
- `src/app/config/scheduling-profiles/{actions.ts,SchedulingProfileForm.tsx,page.tsx}` — UI only; logic (`readMaterialSchedulingProfile`, `SchedulingProfileError`) lives in `src/modules/inventory/scheduling-profile.ts`

### Schema
- `src/modules/production/schema.ts` — all Drizzle tables owned by this module (see Database)

## Pages & API routes
- `/production/mrp-run`, `/production/single-item-planning`, `/production/single-level-planning` — MD01/MD02/MD03
- `/production/stock-requirements` — MD04
- `/production/planned-order-create`, `/production/planned-order-change`, `/production/planned-order-display` — MD11/MD12/MD13
- `/production/planned-order-conversion`, `/production/planned-order-conversion-collective` — CO40/CO41
- `/production/orders` — direct order create (delegates inventory)
- `/production/production-order-change`, `/production/production-order-display` — CO02/CO03, incl. technical completion
- `/production/order-information` — COOIS
- `/production/order-cost-report` — cost report display
- `/production/order-settlement` — settle to cost center/internal order/GL account
- `/production/order-availability` — CO09, commit/reset
- `/production/order-confirmation` — CO15
- `/production/time-ticket` — CO11N
- `/production/confirmation-cancel` — CO13
- `/production/confirmation-display` — search/detail
- `/production/cogi` — COGI workbench
- `/production/bom-explosion` — BOM explosion (CS11/CS12) and where-used (CS15), `PROD.BOM.DISPLAY`
- `/production/boms`, `/production/bom-display` — CS01/CS02/CS03-style
- `/production/routings`, `/production/routing-display` — standard routing
- `/production/work-centers`, `/production/work-center-display` — CR01-style
- `/production/production-versions`, `/production/production-version-display` — MKAL-style
- `/config/availability-check` — OVZ2/OPJL/OVZ9/OPJJ
- `/config/checking-control` — OPJK
- `/config/order-type-parameters` — OPL8
- `/config/production-order-types` — OPJH
- `/config/scheduling-profiles` — UI here; logic in `src/modules/inventory/scheduling-profile.ts`
- `/config/wip-batch` — OMCWB

## Database
**Owns:** `planned_order`, `mrp_run`, `mrp_dependent_requirement`, `wip_batch_activation`, `work_center_category`, `work_center`, `work_center_capacity`, `work_center_costing`, `bom_usage`, `bom_status`, `bom_item_category`, `material_bom`, `material_bom_item`, `routing_task_list_type`, `routing_usage`, `routing_status`, `routing_control_key`, `routing_standard_value_key`, `routing_standard_value_parameter`, `routing`, `routing_sequence`, `routing_material_assignment`, `routing_operation`, `routing_operation_value`, `routing_component_allocation`, `production_version_rule`, `production_version`, `production_version_finding`, `production_confirmation`, `production_confirmation_activity`, `production_confirmation_operation`, `production_confirmation_cancellation`, `production_order_operation`, `production_order_operation_value`, `report_layout`, `availability_checking_group`, `availability_checking_rule`, `availability_check_scope`, `production_order_type`, `production_order_type_parameter`, `production_checking_control`, `production_order_type_settlement_profile`, `production_order_settlement_distribution_rule`, `production_goods_movement_failure`, `production_goods_movement_failure_line`, `production_goods_movement_failure_attempt`, `production_goods_movement_failure_revision`, `production_order_availability_run`, `production_order_component_commitment_event`.

**Reads/writes other modules' tables:**
- `production_order`, `production_order_component`, `material`, `material_plant`, `material_document` — owned by **inventory** (`src/modules/inventory/schema.ts`). Production creates/reads orders via `inventory/production-orders.ts`; confirmation/COGI posts issues+receipts via inventory's `goods-issue.ts`/`production-receipt.ts`. Inventory posts; production decides when/what.
- `plant`, `storage_location`, `factory_calendar`, `settlement_profile`, `cost_center` — owned by **foundation** (`src/modules/foundation/schema.ts`). Referenced on nearly every master table; factory calendars for work-center capacity; settlement profile/cost center read during settlement (`order-settlement.ts`, `settlement-configuration.ts`).

## Depends on
- **inventory** — order header/component persistence (`production-orders.ts`), unit conversion (`unit-conversion.ts`), goods issue/receipt posting (`goods-issue.ts`, `production-receipt.ts`), reversal/quantity helpers (`production-document-quantity.ts`), accounting notes (`material-document-accounting.ts`), storage-location resolution, scheduling-profile config (backs `/config/scheduling-profiles`)
- **foundation** — plant, storage location, factory calendar, settlement profile, cost center master data
- Shared/platform — `platform/tables/tenancy` (client scoping, audit cols), `platform/tables/reference` (UoM), `platform/auth/current` (capability/session checks), `platform/auth/service-authority` (in-tx actor/scope verification), `platform/lock/enqueue` (change-lock enforcement), `platform/job/queue` + `platform/notification/jobs/fanout` (COGI failure notifications)

## Used by
- `src/modules/inventory/production-orders.ts` — imports order status parser, BOM/operation snapshot resolvers, WIP-batch flag reader (inventory owns order tables, production owns rules populating them)
- All `src/app/config/{availability-check,checking-control,order-type-parameters,production-order-types,wip-batch}/*` — thin UI over this module's config logic
- ~70 `tests/*` files exercise production directly/via UI-contract; cross-module: `requisition-transaction.test.ts`, `material-document-reversal-accounting.test.ts`, `reservations.test.ts`, `migo-component-issue.test.ts`, `goods-issue.test.ts` (assert on production-order-triggered inventory postings)
- `scripts/browser-smoke/{co09-availability,co11n-movement,production-order-create}.ts`

## Tests
- **MRP & planning:** `mrp-run.test.ts`, `mrp-run-ui-contract.test.ts`, `mrp-plant-explosion.test.ts`, `mrp-structure.test.ts`, `single-item-planning.test.ts`, `single-item-planning-ui-contract.test.ts`, `single-level-planning.test.ts`, `single-level-planning-ui-contract.test.ts`, `stock-requirements.test.ts`, `stock-requirements-ui-contract.test.ts`, `dependent-requirement-conversion.test.ts`, `co14-registry.test.ts`
- **Planned orders:** `planned-order-create.test.ts`, `planned-order-create-ui-contract.test.ts`, `planned-order-change.test.ts`, `planned-order-change-ui-contract.test.ts`, `planned-order-display.test.ts`, `planned-order-display-ui-contract.test.ts`, `planned-order-conversion.test.ts`, `planned-order-conversion-ui-contract.test.ts`
- **Production orders — change/display/type/settlement/cost:** `production-order-display-change.test.ts`, `production-order-change-ui-contract.test.ts`, `production-order-create-ui-contract.test.ts`, `production-order-type.test.ts`, `production-order-type-assignment.test.ts`, `production-order-settlement.test.ts`, `production-order-cost-report-contract.test.ts`, `production-order-technical-completion.test.ts`, `production-order-bom.test.ts`, `production-order-writer-guard.test.ts`, `order-information.test.ts`, `order-information-ui-contract.test.ts`, `order-type-parameters.test.ts`, `production-documentation-consistency.test.ts`
- **Availability / checking control:** `order-availability.test.ts`, `order-availability-ui-contract.test.ts`, `order-availability-commitment-contract.test.ts`, `availability-check.test.ts`, `availability-check-ui-contract.test.ts`, `checking-control.test.ts`
- **BOMs / routings / versions / work centers:** `material-bom.test.ts`, `routing.test.ts`, `routing-execution-order-audit.test.ts`, `production-version.test.ts`, `work-center.test.ts`
- **Confirmations / time tickets / cancellation:** `order-confirmation.test.ts`, `order-confirmation-ui-contract.test.ts`, `order-confirmation-allocation.test.ts`, `order-operation-snapshot.test.ts`, `time-ticket.test.ts`, `time-ticket-ui-contract.test.ts`, `time-ticket-goods-movement.test.ts`, `confirmation-cancel.test.ts`, `confirmation-cancel-ui-contract.test.ts`, `confirmation-display-contract.test.ts`, `production-receipt.test.ts`, `production-reversal-quantity.test.ts`
- **COGI:** `production-cogi-correction.test.ts`, `production-cogi-ui-contract.test.ts`
- **Locking / screen guards:** `production-change-lock-enforcement.test.ts`, `production-lock-acquisition.test.ts`, `production-master-lock-enforcement.test.ts`, `production-screen-lock.test.ts`
- **WIP batch:** `wip-batch.test.ts`
- **Test helpers:** `tests/helpers/confirmation-cancel-actor.ts`, `tests/helpers/production-cogi-actor.ts`, `tests/helpers/production-actor.ts` (`createProductionActor`, `grantActorPlants`, `refreshActorPlants`, `PRODUCTION_ACTOR_CAPABILITIES`)

## Scripts
`scripts/browser-smoke/co09-availability.ts` (CO09 availability UI), `co11n-movement.ts` (CO11N confirmation + goods movement), `production-order-create.ts` (order creation), `stock-requirements.ts` (MD04 list); `scripts/plan-md04.mts` (standalone MD04-style planning)

## Non-obvious behavior / gotchas
- Display modules (`material-bom-display.ts`, `routing-display.ts`, `production-version-display.ts`, `work-center-display.ts`) are one-line re-export shims over maintain modules — no separate display logic.
- `confirmation-movements.ts` only plans/records movements; actual posting + COGI failure persistence split across `production-goods-movement-failures.ts` and inventory's `goods-issue.ts`/`production-receipt.ts`. Confirmation inserted before movement tx starts, so failed posting rolls back only the movement; work item marked FAILED/BLOCKED for COGI.
- `wip_batch_activation` is one-row-per-client flag, "cannot be revoked" once `X` per its comment — no code path to turn off; `createWipBatch()` always throws (`never`), feature unimplemented.
- `production_confirmation_cancellation` enforces "one active cancellation per confirmation" via DB trigger (`drizzle/9172`), not partial unique index — partial index can't see across table (per schema comment).
- Routing/BOM/production-version "alternatives" and "valid-to" dates exist because engineering change management is deliberately absent — schema comments call this a simplification boundary, not a bug.
- `/config/scheduling-profiles` sits under this module's file scope but logic (`SchedulingProfileError`, `saveSchedulingProfile`, `assignSchedulingProfile`) lives entirely in `src/modules/inventory/scheduling-profile.ts` — inventory's UI on a production-adjacent route.
- `production_order_type_settlement_profile`/`production_order_settlement_distribution_rule` mirror internal-order settlement tables but keyed on production order/order type — settlement posts only when profile assignment, allocation assignment, and distribution rule agree on receiver (enforced in `settlement-configuration.ts`, not just DB constraint).
- `production_order.company_code` no longer exists (migration 9272): settlement, cost report, CO13 cancel and COGI scope all derive company code from the order's plant (`plant.company_code`), so re-assigning a plant changes it retroactively.
- COGI retry (`attemptProductionGoodsMovementFailure`) refuses with `AutomaticMovementAuthorityError` when the claim has no user authority — automatic movements never post without a person.
