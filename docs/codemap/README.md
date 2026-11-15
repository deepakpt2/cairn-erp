# Cairn Codemap

Persistent map of the Cairn ERP codebase (branch `development`, refreshed 2026-11-14) (Next.js App Router + Drizzle/Postgres, multi-tenant, SAP-style modules). Built from the actual code (imports, schemas, routes), not an assumed layout. Use this to find files/dependencies without rescanning the repo; update the relevant file here whenever code moves.

## Files in this folder
- `import-graph.json` — raw `madge --json` import graph of `src/` (1,296 nodes, full coverage)
- `modules/<name>.md` — one file per business module (below; 10 incl. `audit`)
- `shared.md` — cross-cutting infra (`src/platform/*`, `src/ui/*`, `src/worker/*`, auth/authority/db/tenancy & demo install/locking/posting/jobs/notifications/attention/i18n/etc.) and which modules use each piece
- `database.md` — all 438 Drizzle tables (+2 SQL-only) → owning module, cross-module reads/writes, relations
- `unassigned.md` — everything not in a module or shared.md: root config, `docker/`, `drizzle/` (baseline + `history/`), pre-existing project docs/notes

## Business modules

| Module | Purpose | Entry points | Doc |
|---|---|---|---|
| **finance** | GL, AP/AR, period close, fixed assets, consolidation, tax | `/finance/*`, `/config/{chart-of-accounts,consolidation,credit-control-areas,fiscal-year-variants,gl-accounts,intercompany-clearing}` | [modules/finance.md](modules/finance.md) |
| **foundation** | Enterprise structure & master data (partners, company codes, plants, orgs) + controlling masters/reporting (cost/profit centers, internal orders, settlement) | `/foundation/*`, `/controlling/*`, `/constrained-values`, most of `/config/*` | [modules/foundation.md](modules/foundation.md) |
| **inventory** | Stock/warehouse: goods movements, batches, physical inventory, material master | `/inventory/*` (incl. `serial-numbers`), `/config/{batch-*,material-*,movement-types,valuation-classes,industry-sectors}` | [modules/inventory.md](modules/inventory.md) |
| **production** | MRP, production/planned orders, BOMs, routings, confirmations, work centers | `/production/*`, `/config/{availability-check,checking-control,order-type-parameters,production-order-types,scheduling-profiles,wip-batch}` | [modules/production.md](modules/production.md) |
| **purchasing** | Requisitions, POs, RFQ/quotations, scheduling agreements, invoice verification, GR/IR | `/purchasing/*`, `/config/{delivery-completion,purchasing-orgs}` | [modules/purchasing.md](modules/purchasing.md) |
| **sales** | Sales orders, pricing procedures, delivery & shipping points, billing (plans, collective, invoice lists, down payments), rebates, returns & credit memos/requests, incompletion, output, registers/analysis, batch & serial determination | `/sales/*`, `/config/{batch-determination,billing-split,incompletion,pricing-procedure,sales-account-determination,sales-document-types,sales-returns,shipping-points}` | [modules/sales.md](modules/sales.md) |
| **people** | HR: employees, org assignments, time/leave, pay components, salary structures & readiness (payroll phase 1), authority chart & delegation | `/people/*` (incl. `authority`, `salary-structures`; launchpad area `people`), `/config/{pay-components,people-record-types}` | [modules/people.md](modules/people.md) |
| **quality** | QM: inspection lots, characteristics/results, usage decisions | `/quality/*` | [modules/quality.md](modules/quality.md) |
| **audit** | Auditor workspace: time-boxed scoped read-only grants, no-post rule, audited auditor, findings/requests | `/audit/{workspace,grants,findings}` | [modules/audit.md](modules/audit.md) |
| **platform** (admin) | User/role/organisation-scope administration, job monitor, notifications inbox | `/platform/*` (incl. `jobs`, `notifications`) | [modules/platform.md](modules/platform.md) |

Boundary notes (surprising but confirmed by import analysis, not guessed):
- `foundation` bundles two cohesive-but-distinct areas: enterprise structure/master data AND controlling masters/reporting.
- `purchasing`'s schema also hosts `customer_invoice(_line)`, used by finance.
- `production_order(_component)` tables physically live in `inventory`'s schema, not production's.
- The `platform` *module* (admin UI, `src/modules/platform`) is distinct from `src/platform/*` *infra* (see `shared.md`) — same name, different things.
- `output_type`/`output_message` moved from inventory's schema to `foundation/output-schema.ts` on `development`.
- `audit` reaches into `platform/auth`: `effectiveGrants()` and `verifyServiceAuthorityInTx()` call `modules/audit/read-only.ts`, so a live audit grant cuts every user's authority to read-only centrally.
- Background work runs in a separate process: `npm run worker` (`src/worker/`) claims jobs that web requests queue (see `shared.md`).

## Coverage
Every file under `src/`, `tests/`, `scripts/` appears in exactly one `modules/*.md` or `shared.md`. Everything else in the repo is in `unassigned.md`. Verified by cross-checking file lists against `find src tests scripts -type f` at build time; the `development` refresh was checked for every added file (202) and found none missing.
