# Quality
QM: inspection lots, characteristics/results, usage decisions. Routes: `/quality/*`. Paths relative to `src/`; tables are SQL names.

## Gotchas
- `quality_lot` is append-only (UPDATE/DELETE revoked) with 10 columns; every lot fact is a live join to `material_document(_line)`; `LotState` derived.
- One lot per receipt line: unique index + in-tx pre-check + `pg_advisory_xact_lock`, `23505` as backstop.
- `postUsageDecisionWithStock` shares one tx with `postTransferInTx` (321 / 323); REWORK never moves stock. Stock-moving decisions also need `QM.STOCK.POST`.
- Services take `{authorization}` and refuse a lot whose plant is outside scope (in-tx).
- No inspection plan: every characteristic is mandatory for every lot. No re-inspection (`DUPLICATE_DECISION`).

## Files (10)
| file | exports | tables |
|---|---|---|
| **app/quality/inspection/** | | |
| actions.ts | recordResultAction, saveCharacteristicAction, decideAction, loadInspectionWorkbench |  |
| InspectionWorkbench.tsx | InspectionWorkbench |  |
| page.tsx | InspectionPage |  |
| **app/quality/lots/** | | |
| actions.ts | openLotAction |  |
| Lots.tsx | Lots |  |
| page.tsx | QualityLotsPage |  |
| **modules/quality/** | | |
| inspection-results.ts | INSPECTION_RESULT_CAPABILITY, INSPECTION_OBJECT_CLASS, InspectionResultError, characteristicInput, resultInput, saveCharacteristic, listCharacteristics, recordInspectionResult, getInspectionResult, listInspectionResults, lotResultSummary | inspection_characteristic, inspection_result, material_document, material_document_line, quality_lot, unit_of_measure |
| lot.ts | LOT_CAPABILITY, LOT_ROUTE, LOT_OBJECT_CLASS, InspectionLotError, lotOpenInput, openLot, getLot, listLots, listInspectableLines | material_document, material_document_line, quality_lot |
| schema.ts | LOT_RANGE, qualityLot, inspectionCharacteristic, inspectionResult, usageDecision | inspection_characteristic, inspection_result, quality_lot, usage_decision |
| usage-decision.ts | USAGE_DECISION_CAPABILITY, USAGE_DECISION_STOCK_CAPABILITY, USAGE_DECISION_OBJECT_CLASS, UsageDecisionError, decisionInput, recordUsageDecision, postUsageDecisionWithStock, getUsageDecisionView, getDecisionWithLot | inspection_result, quality_lot, usage_decision |

## Routes (2)
`/quality/inspection` · `/quality/lots`

## Tables owned (4)
inspection_characteristic, inspection_result, quality_lot, usage_decision

## Depends on
inventory, platform/auth, platform/change, platform/db, platform/lock, platform/numbering, platform/tables, ui/lock

## Used by
dev/walkthrough-volume.ts, platform/tenancy

## Tests (5)
qm-inspection-results, qm-usage-decision, quality-inspection-action-security, quality-lot, quality-service-authorization
