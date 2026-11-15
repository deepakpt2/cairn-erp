# Quality

QM: inspection lot (names a goods-receipt line) → characteristics/results → usage decision (ACCEPT/REJECT/BLOCK/REWORK). SAP QA32/QE51N analog. Smallest module: 1 schema, 3 services, 2 routes.

## Files
- `src/modules/quality/schema.ts` — tables `qualityLot`, `inspectionCharacteristic`, `inspectionResult`, `usageDecision`; exports `LOT_RANGE`. Lot names a receipt line, doesn't copy its data.
- `src/modules/quality/lot.ts` — lifecycle. Exports: `openLot`, `getLot`, `listLots`, `listInspectableLines`, `LOT_CAPABILITY`(`QM.LOT.CREATE`), `LOT_ROUTE`(`/quality/lots`), `LOT_OBJECT_CLASS`, `InspectionLotError`, `lotOpenInput`, types `LotSourceView`/`LotState`/`LotView`/`LotListRow`. Opening posts nothing; `openLot(input, {authorization})` verifies capability + receipt plant scope in-tx.
- `src/modules/quality/inspection-results.ts` — characteristics/results. Exports: `saveCharacteristic`, `listCharacteristics`, `recordInspectionResult`, `getInspectionResult`, `listInspectionResults`, `lotResultSummary`, `INSPECTION_RESULT_CAPABILITY`(`QM.INSPECTION.RECORD`), `INSPECTION_OBJECT_CLASS`, `InspectionResultError`, `characteristicInput`/`resultInput`, types `CharacteristicRow`/`ResultRow`/`LotResultSummary`. Recording a result verifies authority + lot plant scope.
- `src/modules/quality/usage-decision.ts` — decision + stock move. Exports: `recordUsageDecision`, `postUsageDecisionWithStock`, `getUsageDecisionView`, `getDecisionWithLot`, `USAGE_DECISION_CAPABILITY`(`QM.USAGE.DECIDE`), `USAGE_DECISION_STOCK_CAPABILITY`(`QM.STOCK.POST`, extra authority when the decision moves stock), `USAGE_DECISION_OBJECT_CLASS`, `UsageDecisionError`, `decisionInput`, types `DecisionRow`/`DecisionWithLot`. Calls `postTransferInTx` (inventory): ACCEPT→unrestricted (mvt 321), REJECT/BLOCK→blocked (mvt 323), REWORK→no movement. Optional `postingDate` input (defaults to decision date, was today).
- `src/app/quality/lots/actions.ts` — `openLotAction`: parses `line` field (`DOCUMENT#LINE`), checks capability, calls `openLot`.
- `src/app/quality/lots/Lots.tsx` — `/quality/lots` client: open-lot picker, lots list, `LotDetail` panel.
- `src/app/quality/lots/page.tsx` — `/quality/lots` server: loads `listLots`/`listInspectableLines`/`getLot`; `?document=`/`?lot=` filters.
- `src/app/quality/inspection/actions.ts` — `recordResultAction`, `saveCharacteristicAction`, `decideAction` (capability-gated); `loadInspectionWorkbench` (plain helper, not an action) parallel-fetches lot+characteristics+results+decision+summary.
- `src/app/quality/inspection/InspectionWorkbench.tsx` — `/quality/inspection` client: lot header, results summary, characteristic/result forms, decision panel (shown once `summary.allMandatoryComplete`).
- `src/app/quality/inspection/page.tsx` — `/quality/inspection` server: resolves capabilities, loads workbench on `?lot=`, wraps decision in change lock (`USAGE_DECISION`, txn code `QE51N`).

## Pages & routes
- `/quality/lots` — open lot vs. receipt line; list; detail (incl. reversal status). `?document=`, `?lot=` filters.
- `/quality/inspection` — workbench for one lot (`?lot=` required): characteristics, results, decision. No API routes, server actions only.

## Database
**Owns:** `quality_lot`, `inspection_characteristic`, `inspection_result`, `usage_decision`.
**Reads/writes others':** `material_document`/`material_document_line` (inventory, restrict-on-delete FK, live joins for all lot facts) · `stock_quantity` (inventory, via `postTransferInTx` only) · `change_document(_item)` (platform, `recordChange` on every act) · `number_range` (platform, `allocateNumber` object `INSPLOT`) · `unit_of_measure` (platform, raw-SQL unit validation). Confirmed one-directional: inventory's `batch-cockpit.ts` explicitly does not read quality.

## Depends on
- **inventory**: `materialDocument`/`materialDocumentLine` schema; `postTransferInTx` for decision stock moves.
- **platform/db** (`withTenant`,`Tx`) · **platform/change** (`recordChange`) · **platform/numbering** (`allocateNumber`, `INSPLOT`) · **platform/auth** (`can`,`requireSession`; `service-authority` `verifyServiceAuthorityInTx`/`refusePlantOutsideScopeInTx` in services) · **platform/lock** (`openChangeForSession`,`displayOnlyMessage`) · **ui/lock** (`ChangeLock`).

## Used by
Nothing in `src/` outside quality imports it — leaf module. External refs only: `tests/qm-inspection-results.test.ts`, `tests/qm-usage-decision.test.ts`, `tests/quality-lot.test.ts`, `tests/quality-inspection-action-security.test.ts`, `tests/quality-service-authorization.test.ts`, `scripts/browser-smoke/quality-lots.ts`.

## Tests
`qm-inspection-results.test.ts`, `qm-usage-decision.test.ts`, `quality-inspection-action-security.test.ts`, `quality-lot.test.ts`, `quality-service-authorization.test.ts`; helper `tests/helpers/quality-authorized.ts` (authorized wrappers `openLot`, `recordInspectionResult`, `recordUsageDecision`, `postUsageDecisionWithStock`)

## Scripts
`scripts/browser-smoke/quality-lots.ts` — `qualityLotReceipt`, 8 acceptance criteria from `docs/operational-readiness.md` §6 (picker scope, lot detail, duplicate refusal, audit, replay, no inventory-state leakage, capability-gated form, reversal reflection).

## Gotchas
- `quality_lot` has 10 columns only (no material/batch/qty/status) — every displayed fact is a live join to `material_document(_line)`, recomputed per read; `LotState` is derived, never stored.
- No inspection-plan concept: `lotResultSummary` treats every tenant characteristic as mandatory for every lot (no per-material/per-lot assignment) — documented gap.
- Stale UI copy in `lots/page.tsx`/`Lots.tsx` still says usage-decision/results "not built" though both are fully implemented and wired.
- `quality_lot` is append-only at DB grant level (UPDATE/DELETE revoked); no status/decision/results columns by design.
- One lot per receipt line enforced 3 ways: unique index, in-tx pre-check, `pg_advisory_xact_lock`; `23505` catch as backstop.
- `postUsageDecisionWithStock` shares one tx with the stock transfer — decision-insert failure rolls back the stock move too.
- REWORK inserts a decision row but never moves stock; `stockPosted` always `false` for REWORK regardless of `postStock` input.
- `loadInspectionWorkbench` lives in a `'use server'` file but isn't itself an action — plain parallel-fetch helper, returns `any` for `lot`/`summary`.
- No re-inspection cycle: a second decision on a lot is always refused (`DUPLICATE_DECISION`); REWORK requires a new lot against a new receipt.
- Service-level authority is now enforced inside the tx (not just in actions): every quality service takes `{authorization}` and refuses a lot whose receipt-line plant is outside the actor's scope; ACCEPT/REJECT/BLOCK with stock posting additionally need `QM.STOCK.POST` and transfer authority.
