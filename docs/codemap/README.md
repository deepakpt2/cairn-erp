# Cairn Codemap
Index of `src/` (1,324 files, 448 tables), refreshed 2026-11-15 on `development`. Tables only, no prose: each module file is Gotchas → Files (file | exports | tables) → Routes → Tables owned → Depends on → Used by → Tests.

## How to use (cheapest first)
1. **grep one row, don't read a whole file:** `grep -n 'bom-explosion' docs/codemap/modules/production.md`, `grep -rn '| quality_lot' docs/codemap/`.
2. Read the `## Gotchas` block only: `awk '/^## Gotchas/{p=1;next} /^## /{p=0} p' docs/codemap/modules/<m>.md`.
3. **`import-graph.json` (280 KB): never read it whole.** Query with `jq`:
   - imports of a file: `jq '."modules/quality/lot.ts"' docs/codemap/import-graph.json`
   - importers of a file: `jq -r 'to_entries[] | select(.value | index("platform/posting/index.ts")) | .key' docs/codemap/import-graph.json`
   - keys are paths relative to `src/`. Regenerate with `npx madge --json --ts-config tsconfig.json --extensions ts,tsx src > docs/codemap/import-graph.json`.

## Regenerating
`node scripts/codemap-index.mjs` rewrites every generated section (Files, Routes, Tables owned, Depends on, Used by, Tests, database tables) from the source and keeps the hand-written parts (title, purpose, `## Gotchas`). `--check` exits 1 when the map is stale. Refresh `import-graph.json` with madge first when imports changed. Ownership is read from the existing tables; move a row by hand to reassign a file.

## Files
| file | content |
|---|---|
| `modules/<m>.md` | one per business module (below) |
| `shared.md` | `src/platform/*`, `src/ui/*`, `src/worker/*`, `src/dev/*`, app shell; RLS / SECURITY DEFINER / jobs / demo gotchas; shared unit → users |
| `database.md` | tables per schema file; cross-module table access |
| `unassigned.md` | root config, docker, `drizzle/`, scripts, project docs |
| `import-graph.json` | raw madge graph (jq only) |

## Business modules
| Module | Purpose | Entry points | Doc |
|---|---|---|---|
| **finance** | GL, AP/AR, period close, fixed assets, consolidation, tax | `/finance/*`, `/config/{chart-of-accounts,consolidation,credit-control-areas,fiscal-year-variants,gl-accounts,intercompany-clearing}` | [modules/finance.md](modules/finance.md) |
| **foundation** | Enterprise structure & master data (partners, company codes, plants, orgs) + controlling masters/reporting/planning (cost/profit centers, internal orders, settlement, cost centre planning KP06, activity price calculation KSPI, allocation cycles/assessment KSU5) | `/foundation/*`, `/controlling/*`, `/constrained-values`, most of `/config/*` | [modules/foundation.md](modules/foundation.md) |
| **inventory** | Stock/warehouse: goods movements, batches, physical inventory, material master | `/inventory/*` (incl. `serial-numbers`), `/config/{batch-*,material-*,movement-types,valuation-classes,industry-sectors}` | [modules/inventory.md](modules/inventory.md) |
| **production** | MRP, production/planned orders, BOMs (incl. CS11/CS12 explosion, CS15 where-used), routings, confirmations, work centers | `/production/*`, `/config/{availability-check,checking-control,order-type-parameters,production-order-types,scheduling-profiles,wip-batch}` | [modules/production.md](modules/production.md) |
| **purchasing** | Requisitions, POs, RFQ/quotations, scheduling agreements, invoice verification, GR/IR | `/purchasing/*`, `/config/{delivery-completion,purchasing-orgs}` | [modules/purchasing.md](modules/purchasing.md) |
| **sales** | Sales orders, pricing procedures, delivery & shipping points, billing (plans, collective, invoice lists, down payments), rebates, returns & credit memos/requests, incompletion, output, registers/analysis, batch & serial determination | `/sales/*`, `/config/{batch-determination,billing-split,incompletion,pricing-procedure,sales-account-determination,sales-document-types,sales-returns,shipping-points}` | [modules/sales.md](modules/sales.md) |
| **people** | HR: employees, org assignments, time/leave, pay components, salary structures & readiness (payroll phase 1), payroll runs & results (phase 2), payroll posting to G/L (phase 3), salary payment (phase 4), off-cycle runs and service-side scope (phase 5), authority chart & delegation | `/people/*` (incl. `authority`, `salary-structures`, `payroll-runs`, `payroll-results`; launchpad area `people`), `/config/{pay-components,people-record-types}` | [modules/people.md](modules/people.md) |
| **quality** | QM: inspection lots, characteristics/results, usage decisions | `/quality/*` | [modules/quality.md](modules/quality.md) |
| **audit** | Auditor workspace: time-boxed scoped read-only grants, no-post rule, audited auditor, findings/requests | `/audit/{workspace,grants,findings}` | [modules/audit.md](modules/audit.md) |
| **platform** (admin) | User/role/organisation-scope administration, job monitor, notifications inbox | `/platform/*` (incl. `jobs`, `notifications`) | [modules/platform.md](modules/platform.md) |

## Boundaries
- `production_order*` tables live in inventory's schema; `customer_invoice*` in purchasing's; `output_*` in `foundation/output-schema.ts`.
- `src/modules/platform` (admin UI) ≠ `src/platform/*` (infra, `shared.md`).
- A live audit grant cuts every user to read-only centrally (`platform/auth` → `modules/audit/read-only.ts`).
- Background work runs in `npm run worker` (`src/worker/`).

## Coverage
Every `src/` file is in exactly one `modules/*.md` or `shared.md` (ownership: `src/modules/<m>` by folder; `src/app` by screen area or the services it imports). Tests are listed under the module whose code they import; contract tests that read files as text are not mapped (`ls tests | grep <topic>`). Scripts and everything else: `unassigned.md`.
