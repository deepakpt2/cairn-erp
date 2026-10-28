# Operational readiness — PP, SD/AR, QM, HR

Measured on 2026-10-27 against `origin/main` (`c92061d`). This file states what a production company can
actually run end to end through the screens, and what it cannot. It does not repeat the per-tcode audits
under `docs/`; it reads them and the code, and it records only numbers that a stated command reproduces.

## 1. What is there

| Area | Tables | Registered codes | Pages | Browser targets | Test files | Verdict |
|---|---|---|---|---|---|---|
| PP | 62 | 38 (`PROD.*`, `CFG.PROD.*`) | 52 | 30 | 91 | deep and usable end to end |
| SD | 38 (AR, credit, dunning, payments) | 27 | 21 | 32 | 62 | AR tail usable, document chain absent |
| QM | 8 (characteristics, classes, batch status) | 8 (`INV.BATCH*`) | 25 | 5 | 44 | configuration and batch disposition only |
| HR | 1 (`employee_tolerance_group`) | 0 | 0 | 1 | 1 | absent apart from an AP/AR tolerance control |

Counts come from `ls src/app/<area>`, `grep -c pgTable` over `src/modules/*/schema.ts` and the satellite
tables the barrel `src/platform/schema.ts` pulls in, and from `scripts/browser-smoke/targets.ts` (170
targets). The same measurement is `/home/user/p39-coverage.txt` in the working area.

The table above was taken on 2026-10-27 at `c92061d` and it has not been re-taken since, so two of its rows now
read as history rather than as state: the SD line ("document chain absent") describes the tree before
`9896197` delivered delivery, picking, goods issue and billing for an order line, and the QM line's page, target
and test counts are re-measured below, where the commands are stated. The PP and HR rows were not re-measured
in the pass that produced the QM numbers, so they are left as they were taken rather than quietly refreshed.

**PP, the chain a factory runs.** BOM and routing masters, production version, CO01 order create with a
version-derived component snapshot, release, 261 component issue through MIGO/MB1A, operation
confirmations, 101 + R08 finished-goods receipt, technical completion and its reversal. Each step posts
its own document and journal, and the order reads its availability in CO09 (read-only by design). The one
thing the chain does not carry is money: `PROD.ORDER.SETTLE` is registered as a posting capability with
no implementation, which is DI-012.

**SD, what exists is AR.** Sales organization, sales area and customer master configuration; credit
masters, tolerance groups, dunning, customer invoice posting and its linked cancellation, incoming
payment with discount and residual handling, clearing, balances and ageing, down payments. What does not
exist at all is the document chain in front of it: no quotation, no sales order, no outbound delivery or
picking, no customer goods issue, no billing from delivery, no customer return, no customer credit memo.
The credit-control engine (`checkSalesDocumentCredit`, `releaseDocument`, `reblockDocument`, …) is fully
built and called by nothing in `src/`: the screen that would produce a sales document, and therefore the
document a credit check reads, is the missing piece. The five `SALES.*` capability codes in
`scripts/seed.ts` are grantable and reach nothing (see the pass log: 10 of 249 codes are unreferenced).

**QM** is configuration without an inspection model: characteristics, classes, batch status and the
batch-level controls. There is no inspection lot, no results recording, no usage decision and no
nonconformance record — and `CAIRN.md` carries no requirement for one (the QM grep returns nothing in the
specification), so this is an open product decision, not a dropped milestone.

**HR** is one table: the employee tolerance group an AP/AR credit check reads. Payroll has approved
tables (`payroll_run`, `payroll_result`, `payroll_result_line`, `payroll_posting_run`,
`payroll_posting_line`), an approved posting rule and an explicit scope line — statutory tax and social
insurance are out of scope (`CAIRN.md` §1.3, R-11, D-013) — and none of it is built. 15 of the 16
approved `PEOPLE.*` codes are not registered either.

## 2. UI-level acceptance evidence, 2026-10-27

Every target below ran against a Next production build of the tree above on the verification box, each
against its own disposable tenant database, with the server log checked for errors
(`server_errors=0` in part 1). The number after `checks` is the count of evidence lines the target
printed — an assertion that a step of the workflow reached its persisted result, not a screenshot.

Part 1 — PP, AR, credit, QM configuration, and the inventory movements (23 targets): **21 pass, 2 fail**.

    production-order-create 4  migo-component-issue 3  customer-invoice 6  incoming-payment 5
    incoming-payment-completion 5  customer-clearing 5  credit-release 6  co11n-movement 11
    migo-production-receipt 3  stock-requirements 9  settlement-configuration 9  movement-types 9
    customer-ageing 6  dunning 6  credit 6  credit-monitor 5  customer-sales-area 4  characteristics 6
    classes 6  tolerance-groups 7  migo-transfer-posting 2
    FAILED: goods-issue (waits for a status line the screen no longer prints, :217),
            physical-inventory (waits for `[data-cancel="PI-2026-0000001"]`, a document-numbered anchor)

Part 2 — fixed assets, vendor side, parked and outgoing payments (19 targets): **5 pass, 14 fail**.

    asset-history 5  asset-master 6  journal-document-display 6  vendor-credit-memo 4  vendor-invoice 4

The 14 failures are not product defects. Eleven wait for a `section[aria-labelledby=…]` that the screen
no longer uses (`aq-entry`, `dp-entry`, `rt-reverse`, `op-header`, `cdpc-header`, `vdpc-header`,
`info-record-create`) or for a status paragraph, and three for a suggestion list. They are stale targets:
the harness drifted from the DOM while no test executed it. DI-015 holds the list, and the guard below
pins the class of drift this pass found — 21 targets, 46 lines, across 22 files — so it cannot recur
quietly.

`tests/browser-target-constrained-driving.test.ts` is the new guard: a name the page renders as a closed
constrained field must not be addressed as `input[name="…"]`, and an open one must not be addressed as
`select[name="…"]`. It reads `CLOSED_KINDS` from the module the component reads, resolves which control a
name is per page (the page the target navigated to, or the route the runner opened), and fails with the
file, line, route and remedy. Proven load-bearing twice: it found the five `goods-issue`/`reservations`
lines this pass repaired, and a one-line mutant (`reservations.ts:80`) failed it with the exact message.

## 3. What this pass changed

* `src/modules/production/production-version.ts` — the quantity scale check now measures the digits that
  a rounding would drop rather than the length of the fraction text. `quantityText` was handed the
  order's planned quantity as `orderQuantity.toFixed(3)` by `order-bom-snapshot.ts:85`, so every material
  whose base unit carries no decimal places — `PC`, `EA`, `BOX`, `SET`, `DAY` in the delivered reference
  data — was refused at CO01 with "Quantity has more decimal places than the unit allows" for a number the
  user typed without a decimal point. A genuinely over-precise value is still refused, and
  `tests/production-order-bom.test.ts` now covers both directions with a count-unit material. This was
  the one defect blocking a core workflow that this pass found.
* `scripts/browser-smoke/closed-fields.ts` (new) — `chooseClosed(scope, name, value)` waits for the
  select, waits for the option the dependent context unlocks, then chooses it. An `<option>` is never
  "visible" on its own, so the wait is for `attached`.
* 22 target files — closed constrained fields are driven with `chooseClosed`; five fixtures stopped
  choosing a material type by sort order and name the type their valuation class belongs to; three
  fixtures stopped asserting copy the screens no longer print (`difference 0.00` became
  `Allocated 850.00 · unassigned 0.00.`); `credit-release` opens each row's `<details>` before it asserts
  the Release button is enabled, which is what proves the change-lock grant rather than assuming it;
  `production-order-create` seeds through the services the movement flow uses and no longer types
  component rows CO01 does not offer.

## 4. Milestones in dependency order

1. **PP money basis** — DI-012. Cost, variance and settlement all wait on it, and it needs a schema and
   business-rule decision the repository has not been given.
2. **SD document chain** — quotation → order → delivery and picking → goods issue → billing. It needs a
   table set, not only screens; the AR tail it would feed is already built and proven above. A customer
   credit memo is the one piece that looks cheap and is not: `customer_invoice` already admits
   `category = 'CREDIT_MEMO'` but has no `credit_of` column, so it needs one nullable column — a
   migration authorization.
3. **Credit control wiring** — the engine exists; the sales document that would call it does not. Land
   with 2, not before.
4. **Payroll** — the statutory scope decision is already made (none); what is missing is the runs, the
   earnings and deduction configuration per jurisdiction, payslips and the posting. It cannot be built
   without a decision on which jurisdiction's rules the deduction configuration models.
5. **QM inspection model** — needs a requirement first: nothing in `CAIRN.md` asks for inspection lots. The
   coverage was re-measured and the smallest coherent workflow was written out on 2026-10-28, in "Quality
   management: verified coverage and the minimum viable workflow" below; DI-022, DI-023 and DI-024 hold the three
   decisions it waits on. No code was built in that pass.

Reproduce the numbers with `bash /home/cairn/p39-wide.sh 1` and `2` on the verification box, and
`bash ~/run-box-tests.sh <tag> tests/browser-target-constrained-driving.test.ts` for the guard.

## Sales order entry, as it stands after this commit

The first link of the order-to-invoice chain is live at the service level and on two screens:

* `/sales/orders` (`SALES.ORDER.CREATE`) creates, changes, rejects an item and cancels a sales order. The header
  carries the value the credit check judged, and the standing `credit_determination` for the order number is what
  reads as blocked. An unauthorized session sees the list without the forms.
* `/sales/conditions` (`CFG.SALES.CONDITION.MAINTAIN`) maintains the price one customer and material carries for
  a period. A sales order takes its prices from these records and nowhere else: an item no record prices is
  refused rather than priced at zero, and the record the order read is named on the line.
* Evidence run on the box for the order commit, and run again here for the fulfillment one:
  `tests/sales-order.test.ts` 17/17 (create, pricing from the record,
  tax by company country, every refusal — no record, over-precise quantity, unknown unit, material not at the
  plant, blocked customer sales area, unknown sales area, replay of a repeated submission, change with a stale
  version and with a silently dropped item, rejection keeping its reason, credit block then authorized release
  then a refused second release, a fresh determination when a change takes the order over the limit, cancel once
  and the transitions that no longer exist, and a condition change closing the span it replaced). The change case
  holds a 400.00 limit rather than the 200.00 it was written with: since DI-019 a standing sales commitment of the
  same customer is in the credit basis, and the previous case's order is one;
  `npm run db:verify` 13/13 after applying `drizzle/9190`; `tsc --noEmit` 152, none of them in a sales file;
  `screen-links`, `production-documentation-consistency`, `credit-release`, `credit-monitor`, `customer-invoice`,
  `purchase-order` and `browser-target-constrained-driving` green in the same run (8 files, 54 tests).
* Not done, and recorded rather than glossed: there is no browser target for either new screen yet, because the
  journey a target would drive does not end at an order — see DI-020. The delivery, goods-issue and billing links,
  the rest of the pricing vocabulary (DI-018) and the exposure basis (DI-019) are the next three entries.

## Sales fulfillment and billing, as it stands after DI-020

The rest of the chain is written and now **run**: `drizzle/9191`, `src/modules/sales/{delivery,billing,
fulfillment-quantities,exposure}.ts`, the 601/602 scenario in `src/modules/inventory/goods-issue.ts`, the two
screens `/sales/delivery` and `/sales/billing`, their server actions and catalog entries, `tests/
sales-delivery.test.ts` (9/9), and one browser target `sales-order-to-invoice` on fixture key T871 — the target
below was written while the test server was out of reach, and has since been run there and passed (DI-021).

**Every gate that can run without a browser has now run on the test box**, on its `cairn_b210` database, against the
committed tree: `db:migrate` applies `+ 9191` over 313, `npm run db:verify` passes 13/13, the sixteen focused and
neighbouring suites pass 125 tests (sales fulfillment 9, sales order 17, goods issue 14, MIGO component issue 10,
customer invoice 3, the three credit suites 10, account determination 13, the two material-document reversal suites
14, document reversal 4, reversal batch 2, atomic posting 11, block invariant 6), the whole suite is 3,145 of
3,152 tests with the seven misses traced to the owner's uncommitted work rather than to this change (a `c10f707`
worktree reproduces the same six, assertion for assertion), `tsc --noEmit` reports its baseline 152 with none in a
file of this change, `lint:ip` its baseline 141 with nothing new, and `npm run build` exits 0 with
`ƒ /sales/orders`, `ƒ /sales/delivery` and `ƒ /sales/billing` in the manifest.

> **Later the same day (DI-027): the suite no longer runs in this database.** `npm run test:db` provisions a
> scratch database of the suite's own (`cairn` by default) and a whole-suite `vitest run` refuses a database the
> browser guards name, so the figures above were re-measured on the scratch database at **457 of 460 files and
> 3,159 of 3,166 tests** — a new isolation test accounts for the file and the five tests, and the seven misses
> are the same seven, reproduced alone on a freshly provisioned database. The twenty-four extra failures the
> first full-suite run on `cairn_b210` had shown were fixture tenants deleting one another, and are gone; the
> baseline seven are behaviour assertions and were not touched. Re-running the whole suite on `cairn_b210` is
> now refused by design — focused gates and `npm run db:verify` still run there, and every run prints
> `Test setup: database <name> on <host>:<port>.` so a number can never be read without knowing its database.

Browser acceptance has **run on the box and passed**: `npm run smoke:browser --
--target sales-order-to-invoice` exits 0 twice in a row against a served `next start` build — eleven steps echoed
as they passed, 24 assertions between them, `Browser errors: []`, and the identity guard verifying `cairn_b210`
before the first click. DI-021 records the run, the six corrections it required (every one of them in the harness
or in the two sales screens, none in a service), and the legs the target deliberately does not drive. The earlier
note in these pages that no browser target had been launched is the history of the workspace pass, not the state
of the chain.

What the design commits to, and what a reviewer should read the code against:

* **One author of the delivered quantity.** Nothing is copied onto the order line or the delivery line to make
  progress readable: `fulfillment-quantities.ts` sums it from the delivery and billing rows that stand, which is
  why a cancelled delivery returns the quantity to the order and why the same arithmetic freezes an order line.
* **The movement is the inventory engine's, not a parallel one.** `postDeliveryGoodsIssue` calls
  `postGoodsIssue(..., 'SALES', { tx })` inside its own transaction, so stock, valuation, the material document
  and the journal commit or roll back with the delivery status. The link back is `delivery.material_document_number`
  plus the deterministic request key `sd-gi-<client>-<deliveryNumber>`, because `material_document_line` holds no
  sales columns; `material_doc_display` therefore shows the delivery's movement as its own document, and the
  reversal is MBST's `reverseMaterialDocument`, which is the only act that takes the stock back and refuses a
  second reversal of a line.
* **The invoice is the accounting service's, not a parallel one.** A billing document prices from the order line
  and its condition record, computes tax from the tax master the order used, and posts through
  `postCustomerInvoice` with the billing number as the customer `reference`; `cancelBillingDocument` cancels
  through `cancelCustomerInvoice`. A `uniqueIndex (client, delivery_number)` on `billing_document` is what makes
  "billed once" a database fact.
* **Credit is a refusal at three points and a hold at the fourth.** Delivery creation, picking and the goods issue
  refuse a standing block; a breach the goods issue itself causes blocks the *receivable* (the movement is never
  undone by a credit act). The billing document stays OPEN and holds the invoice until a release stands, and
  re-submitting it then posts the same document rather than a second one.
* **Every gate has now run, on the box and on persisted rows** — migrate, `db:verify`, the focused suites and the
  whole suite, `tsc`, `lint:ip`, the build, and the browser journey DI-021 carries. What stays open on this chain
  is substantive rather than unverified, and DI-020 keeps it: the journey stops at the posted receivable, so no
  payment or clearing is driven from the sales side, and a delivery whose billing document was cancelled cannot be
  billed again until the credit-memo path exists — `billing_document_delivery_uq` is left exactly as it is.

## Quality management: verified coverage and the minimum viable workflow (2026-10-28)

Written as a discovery pass. **Nothing was built in it**: no schema, no service, no screen and no migration was
touched, and the Sales chain at `7b65271` was not reopened. Every number below is reproducible from the command
printed beside it, on this tree. A second pass the same day built slice 1 — the inspection lot — and its own
measurements, the two places where the picture below is now behind the tree, and the status of every decision are
recorded in §6; sections 1 to 5 are left as the discovery pass measured them, because those are the numbers the
decisions were taken on.

### 1. What the QM scope is, measured

| What | Command | Result |
|---|---|---|
| QM tables | `grep -n "pgTable('" src/modules/foundation/characteristic-schema.ts` (the five classification tables `characteristic`, `characteristic_value`, `class_type`, `classification_class`, `class_assignment`) plus `batch_status_management`, `batch_status_plant`, `batch_status_plant_conversion` in `src/modules/inventory/schema.ts` | **8** — the same eight the 2026-10-27 table counted. No `inspection_*`, `quality_*`, `lot`, `result` or `nonconformance` table exists: `grep -rl "inspection_lot\|usage_decision\|quality_notification\|nonconformance" src/` is empty |
| QM capability codes | `grep -oE "code: '[A-Z0-9._]+'" scripts/seed.ts \| sort -u` | **no `QM.*` code at all** (0). Eight operational codes — `INV.BATCH.CREATE`, `.CHANGE`, `.DISPLAY`, `.COCKPIT`, `.PICKUP`, `INV.BATCHCLASS.MAINTAIN`, `INV.BATCHSORT.MAINTAIN` and `INV.BATCHSTRATEGY.MAINTAIN` — and fourteen `CFG.INV.BATCH*.DEFINE` plus `CFG.PROD.WIPBATCH.DEFINE`. Every one of the twenty-three is referenced from at least three files under `src/`, so none is a grantable code reaching nothing, which is how the pre-milestone `SALES.*` codes failed |
| QM screens | `find src/app -type d \( -name "*batch*" -o -name "*charact*" -o -name "*class*" -o -name "*shelf*" \)` keeping those with a `page.tsx` | **26 directories, 72 files**; 24 of them are QM or batch disposition once `/config/valuation-classes` and `/finance/grir-reclass` are set aside. The 2026-10-27 table said 25 under a looser scope |
| QM browser targets | `grep -oE "\{ id: '[a-z0-9-]+'" scripts/browser-smoke/targets.ts` over 171 ids, then the batch/characteristic/class labels | **3**: `characteristics` (SCR-057 CT04), `classes` (SCR-058 CL02), `batch-document-management`. None of them appears in DI-015's list of stale targets, so all three are current, and two of them are named as passing in §2 above |
| QM tests | `ls tests/ \| grep -icE "batch\|charact\|class\|shelf"` | **45 files, 153 tests, 45/45 and 153/153 passed on the test box at `7b65271`** (`npx vitest run` over that file list, 89.9 s), with `npm run db:verify` at 13/13 on `cairn_b210` in the same session. The 2026-10-27 table's 44 counted one file fewer under a slightly narrower pattern |
| Refusals that mark the boundary | `grep -rn "inspection\|quality" src/modules/production/order-confirmation.ts src/modules/inventory/batch-cockpit.ts src/modules/purchasing/blocked-invoice.ts` | Three honest refusals where a QM act would sit: "An inspection lot is not stored. Nothing was read." (`batch-cockpit.ts:159`, filter refused at `:30`), "A quality inspection is not stored. None was created." (`order-confirmation.ts:90`), "A quality block is not on this screen." (`blocked-invoice.ts:155`) |

**Correction to the previous evidence, in the direction of less, not more:** the QM row's "25 pages, 5 browser
targets, 44 test files" is 24, 3 and 45 by the commands above. No page or test count was interpreted as a
workflow; the classification below is read out of the services and their callers.

### 2. Coverage, capability by capability

| Capability | Verdict | Evidence |
|---|---|---|
| Inspection-lot creation, source-document linkage | **absent at the discovery pass; the record and the screen landed the same day — see §6** | Then: no table, no code, no route, and `batch-cockpit.ts:159` refused the lot it did not store. Now: `quality_lot` (9192), `QM.LOT.CREATE`, `/quality/lots`, one lot per material-document line. The decision half of the row is still absent |
| Inspection characteristics, inspection plans | **implemented as classification only** | CT04/CL04-class masters are built, maintained and browser-accepted (`characteristic-definition.ts`, `class-definition.ts`, `characteristic-schema.ts`). They describe *objects*, not *inspections*: no plan binds characteristics to a material for a purpose, and `class_assignment` hangs characteristics at positions inside a class (`characteristic-schema.ts:94-118`) — there is no object-to-class assignment table |
| Results recording and validation | **absent** | Nothing stores a result. The characteristic model already carries the validation that a result would need — `dataFormat ∈ CHAR,NUM,DATE,TIME,CURR`, `decimalPlaces`, `negativeValuesAllowed`, `intervalsAllowed`, `requiredEntry`, `valueAssignment` (`characteristic-schema.ts:19-38`) — but no caller reads it for a measurement |
| Usage decision | **absent as a document; the disposition levers exist and are verified** | See the next two rows |
| Stock disposition | **implemented and enforced, but unreachable in one direction** | Quality stock is a real segment; a goods issue reads `stockType = 'UNRESTRICTED'` and nothing else (`goods-issue.ts:660`), so quality and blocked stock cannot be consumed; the sales chain inherits that through `sales/delivery.ts:31`; 321 releases quality to unrestricted as a posted transfer with its counter (`transfer-scenarios.ts:52-57`, `drizzle/9086:74`), and the counter is refused by hand on purpose (`transfer-posting.ts:87-91`). Nothing can post *into* quality — DI-022 |
| Batch status and inventory integration | **implemented, verified, and the strongest existing control** | `restricted_use` (`schema.ts:980-981`, ZUSTD: blank unrestricted, `X` restricted) is set at creation from the initial-status decision (`batch-master.ts:277-297`, OMAB) and changed by `batch-change.ts` only where status management is effective (OMCS scope `batch-status.ts`, plant activation `batch-status-plant.ts`, level from OMCE). It is *enforced* at the posting gate `resolvePostingBatch` (`batch-posting.ts`), which eleven modules call — goods issue, goods receipt, production receipt, production orders, transfer posting, return delivery, physical inventory, stock overview, stock posting date, purchasing orders — and it refuses with "Batch X is restricted. No stock was posted." plus the honest remedy that 341/342 do not exist. `tests/batch-posting.test.ts:158` holds it, and it passed on the box |
| Nonconformance, quality notifications | **absent** | No table, no term, no code. The only quality scoring in the tree is a manual supplier-scorecard criterion (`vendor_evaluation_criterion`, seeded `('QUALITY','Quality','MANUAL','NONE',…)` at `scripts/seed.ts:1052`) |
| Audit history | **implemented for everything that writes** | `recordChange` on each batch and classification module, read back through `changeHistory` (as `/inventory/batch-classes` does), material document lines stamped with their segment, `version` optimistic tokens on the batch master, `requestKey` on batch creation. No second history table is needed for a lot |
| Authorization and concurrency | **implemented in the batch scope** | One capability per act (the twenty-three codes above), `pg_advisory_xact_lock`-style document locks in the newer chains, forced RLS with tenant isolation on every table in scope, append-only grants where a row is a record |
| Reversal | **implemented where a document is posted** | A transfer or a movement reverses through its own counter; a batch status change posts nothing and is therefore corrected by a new change, not by a reversal — which is a fact a QM decision has to respect rather than route around |
| Production integration | **refused at the confirmation; respected in availability** | `order-confirmation.ts:90` refuses an inspection at confirmation. `includeQualityStock` in the checking profile already decides whether quality-inspection stock counts as available (`order-availability.ts:633`, `availability-check.ts:509`), so an in-process or final inspection would change what CO09 and MRP say about a material *without touching either screen* |
| Procurement integration | **no routing in, no hold on payables** | The receipt hard-codes its segment (`goods-receipt.ts:604,615`; `production-receipt.ts:519`); no material says inspection is required (DI-023); `supplier_invoice_payment_block_reason_ck check (reason = 'MANUAL')` makes a quality hold impossible (DI-024) |

Read together: **"configuration and batch disposition only" is confirmed**, with the qualification that the
disposition half is stronger than the 2026-10-27 note implied — a restricted batch is refused at every posting
entry point in the system, and quality stock cannot be consumed at all. What is missing is not enforcement. It is
a document that decides, and a way in.

### 3. The minimum viable workflow this architecture supports

The approved requirements do not contain an inspection rule. `CAIRN.md:770` gives the material master's Quality
view as "Inspection setup (structural; no QM module)", and §10.11 lists quality management among the Tier 3
functions that are "registry-only until requested". So the workflow below is *derived* from what the built model
can already say, and it is a proposal for approval rather than an implementation plan already agreed.

Four acts, each of which maps onto a mechanism that exists and is verified:

1. **A lot is opened against the receipt that needs deciding.** One row: the material document number and line it
   comes from, material, plant, batch, quantity, the segment the stock stands in, and a status
   (`OPEN → DECIDED`). It creates nothing in stock and posts nothing. `MATDOC` linkage is enough to make the
   source unambiguous, because the movement line already carries the segment and the batch.
2. **A result may be recorded against the lot, as values on characteristics.** Reusing `characteristic` and its
   validation (format, decimals, negative sign, required entry) means no new value arithmetic, and it stays an
   *observation*: nothing in this act may change stock, a batch or a balance. Whether slice 1 needs this at all is
   decision D3 below.
3. **A usage decision is recorded, and its only effect is the batch indicator.** Accept leaves `restricted_use`
   blank; reject sets it to `X`; conditional accept records the decision and leaves the batch restricted until a
   second decision lifts it. This reuses the write path `batch-change.ts` already owns, with its OMCS/OMCU scope
   test, its version guard, its refusal to change a batch that status management does not govern, and its
   `recordChange` audit — so the decision is enforced by eleven posting entry points the moment it is stored, with
   no new enforcement anywhere.
4. **A segment change, where quarantine is wanted, is a visible transfer, never a side effect.** 321 (or its
   configured twin) posts as a material document with a counter. A decision that quietly moved stock would be the
   one thing this design must not do.

Mandatory now, and deferrable later. Mandatory: the lot as the document that makes "waiting for quality"
answerable; the decision with an effect only on the batch indicator; the enforcement already provided by
`resolvePostingBatch` and by the unrestricted-only read at issue; audit, idempotency, capability and version on
every act. Deferrable: sampling procedures, tolerance limits and any automatic accept, inspection plans binding
characteristics to a material, results recording itself (D3), quality notifications and follow-up, a certificate
of analysis, dashboards, a quality hold on payables (DI-024), and history reporting beyond the change documents
that already exist.

The constraints on existing workflows that follow if the minimal shape is approved: a receipt stays whole but may
land in quality (DI-022's narrow route), so goods issue, transfer out, production issue, reservation consumption
and the sales delivery chain all simply *see less available stock* — which is already their behaviour, not a new
rule; MRP and CO09 change only through the `includeQualityStock` flag already in the checking profile; the
invoice side is untouched unless the owner takes D4.

### 4. What the owner has to decide, separated from what is already settled

Already settled by the repository, and not open for re-litigation by this plan: the stock segment model and its
unrestricted-only issue; the ZUSTD batch indicator, its scope from OMCE/OMCS/OMCU, and its enforcement at posting;
321 as the release movement with its counter reversal-only; characteristics and classes as maintained masters;
`recordChange`, `version`, `requestKey`, forced RLS and per-act capabilities as the shape of every new document;
that number ranges need no migration for a new object code (`src/platform/numbering/index.ts:299-306`).

Open, in the order they have to be answered:

* **D1 — Is "under inspection" the stock segment, the batch indicator, or both?** *Minimal proposal:* both, with
  different jobs: the segment for goods that must not be consumed by anyone, the batch indicator for goods that
  may move but are not released. Neither needs a table; the pair is what makes the decision enforceable.
* **D2 — What decides that a receipt needs inspection?** *Minimal proposal:* the person and the movement type —
  configure a receipt movement whose `destination_stock_type` is `QUALITY`, already maintainable at
  `/config/movement-types`, and honour that column on the receipt line (DI-022). No migration, no new field, and
  a tenant that does not configure it is unaffected. *The alternative:* an inspection-relevance flag on
  `material_plant`, which is automatic and needs a migration plus the tenth material view, which is not built
  (DI-023). Recommend the first for slice 1 and the second only if routing must be automatic.
* **D3 — Does a lot hold results, or only a decision?** *Minimal proposal:* decision only, with the free text of
  the lot explaining what was found. Results are the first thing to add after the lot is real, reusing the
  characteristic validation that exists, and they should not be built as a schema guess now.
* **D4 — Does inspection hold the payable?** *Minimal proposal:* no, not yet. It needs the check-constraint
  change in DI-024 and a lot to be open against; the row is recorded so the lever is not lost.
* **D5 — Does an open lot constrain MRP, availability or a delivery today?** *Minimal proposal:* no new rule. If
  D1 uses the segment, the existing reads already exclude quality stock from issue, and the checking profile
  already states whether quality stock counts as available; if D1 uses only the batch indicator, `CO09` and the
  sales chain honour it through the posting gate. Either way nothing in `production/` or `sales/` is edited, which
  is also what keeps this off the owner's in-flight work.

### 5. The staged plan, in dependency order

Each slice is independently verifiable, none is a big patch, and none reopens the Sales chain.

**Slice 0 — decide, and record the decision.** No code. D1 to D5 answered in `CAIRN.md`; the `QM.*` capability
namespace, the tier rows and a registry row per new screen added to `scripts/seed.ts` at the same moment the first
screen lands, so the registry stops promising an entry it does not have. *Check:* the documentation suites below,
which read the files rather than the intent.

**Slice 1 — the lot, with no power over stock.** *Landed the same day; read §6 before taking this paragraph
as the built shape, because two columns it lists were deliberately not built.* New table `quality_lot` (client, lot number, `material_document_
number` + `material_document_year` + line, material, plant, batch, quantity, unit, segment at opening, status,
decision columns nullable, `request_key` unique for opening, `version`, audit columns) in one migration under
`drizzle/`, with `enable row level security`, `force`, the `tenant_isolation` policy on both `using` and
`with check`, and `revoke all from public` — the recipe `drizzle/9191_sales_delivery_billing.sql` carries and
`tests/migration-grant-policy.test.ts` and `tests/default-privilege-audit.test.ts` police. Service
`src/modules/quality/lot.ts` with `openLot`, `listLots`, `getLot`; capability `QM.LOT.CREATE`; the lot number from
`defineRange` under object code `INSPLOT`, which needs no migration. Screen `/quality/lots` with the open form and
the list, its `screen-catalog.ts` entry, its related-screen links, and one registry row. Reuse: `withTenant`,
`recordChange`, `requireSession`/`can`, `defineRange`, and the `Delivery.tsx`/`Billing.tsx` shapes for the list
with a `?document=` filter. *Tests:* open from a real goods receipt, refuse a document line that does not exist,
refuse the same submission twice by `requestKey`, refuse a change on a stale version, read the row back from the
tables with the tenant set. *Browser (separate environment):* receive, open the lot at `/quality/lots`, see the
movement, the batch and the segment named on the lot; `db:verify` untouched. *Depends on:* nothing but the
decision D1/D2. *Needs authorization:* a migration.

**Slice 2 — the decision, whose only effect is the batch indicator.** `decideLot(client, lot, { decision,
reason, expectedVersion, requestKey })` writes the decision in the same transaction as the batch write performed
through the logic `batch-change.ts` already owns (the OMCS/OMCU effectiveness test, the refusal to change what
status management does not govern, the `recordChange` audit). `OPEN → DECIDED` is one-way; re-deciding is a new
lot act, never an overwrite. *Tests:* reject ⇒ `goods-issue` refuses that batch with "is restricted. No stock was
posted."; accept ⇒ the same issue goes through; a decided lot cannot be decided again; a conditional decision
leaves the batch restricted; the refusal texts name the lot. *Browser:* reject a lot, watch the goods issue fail,
accept it from the lot or at `/inventory/batches/change`, watch the issue post. *Depends on:* slice 1, and on
`batch-posting.ts` staying as it is. *Needs authorization:* none beyond slice 1's.

**Slice 3 — quarantine at receipt, honouring the configuration.** Replace the two `'UNRESTRICTED'` literals at
`goods-receipt.ts:604,615` with the movement row's `destinationStockType` when it stands, and make the reversal
read the segment off the document line. No alias is added to `MOVEMENT_ALIASES` and the 322 counter stays
reversal-only (`transfer-posting.ts:87-91`), so a person still cannot hand-enter a counter. **This slice edits
`src/modules/inventory/goods-receipt.ts`, which the owner has uncommitted changes in right now**, together with
`return-delivery.ts` and `unit-conversion.ts`; it is sequenced after that work lands, and if the owner's changes
already route the segment, slice 3 shrinks to tests. *Tests:* a configured receipt movement lands the line in
quality; NULL changes nothing, so the whole inventory suite passes unedited; an issue from quality fails by name;
the reversal returns to the segment it came from; the value and the journal are the same as before, because the
segment is not a valuation dimension. *Depends on:* purchasing, inventory, batches. *Needs authorization:* none —
this is where the model already says yes.

**Slice 4 — results, tolerance and reports, only after D3.** Either values on characteristics against a lot
(no new tables if the classification model is enough) or a `quality_result` table with `numeric(13,3)` values and
an explicit, owner-written rule for what passes. Sampling is not in this slice and must not be invented here: if a
sampling rule is wanted, it arrives as its own decision with its own tests. *Depends on:* slices 1 and 2, and on a
requirement that does not exist yet.

Out of scope for the whole sequence, and left where the refusals already state it: 341/342 batch status
movements, class-type 023 classification at goods movement (`batch-classification.ts` refuses it, and posting a
movement that names it is refused before stock or a journal), a quality hold on supplier invoices (DI-024), and
any change to `sales/` (the brief is explicit, and nothing in the above gives a reason to reopen it).

### 6. Slice 1, as built: the inspection lot, and where each decision now stands

Owner instruction of 2026-10-28, applied here: the D1–D5 baseline in §4 is the **proposed** baseline, approved
**for this slice only** — it is not a ruling on quality management as a whole, and where a proposal met an
established requirement the pass stopped at the boundary and wrote the conflict down instead of resolving it by
editing behaviour.

**What exists now**, all of it in this pass and none of it in a file the owner holds:

| Piece | Path | What it is |
|---|---|---|
| The table | `drizzle/9192_quality_inspection_lot.sql`, `src/modules/quality/schema.ts`, registered in `src/platform/schema.ts` | `quality_lot`: client, `lot_number`, the source `(material_document_number, material_document_line)`, `inspection_note`, `request_key`, audit columns. `cairn_migration` holds it; `drizzle/` now runs to 9192 |
| Its rights | same migration | forced RLS with the `tenant_isolation` policy on `using` and `with check`, `revoke all … from public`, and the deliberate declaration `revoke update, delete, truncate … from cairn_app` — the table is append-only in this slice, so slice 2 must bring its own `grant update` |
| Its number | `src/platform/tenancy/index.ts` `STANDARD_RANGES` | `INSPLOT`, `QL` prefix, seven digits, displayed `QL-0000001`. No migration for an interval: `number_range.object_code` is free-form. A tenant created before this entry gets the named refusal at the save, not a silent fallback — the same arrangement the sales documents use |
| The service | `src/modules/quality/lot.ts` | `openLot`, `getLot`, `listLots`, `listInspectableLines`. One capability `QM.LOT.CREATE`, `withTenant` on every read, `requestKey` idempotency, `pg_advisory_xact_lock` on the source line, `recordChange` under object class `quality_lot`, and an error class whose refusals name the document, the line and the lot |
| The screen | `src/app/quality/lots/{page.tsx,actions.ts,Lots.tsx}` | the open form (a picker over receipt lines that still stand and carry no lot), the filter `?document=`, the list, and `?lot=` reading one lot with the receipt facts beside it. `actions.ts` refuses without the code and hands back the service's own remedy text |
| Its registrations | `src/ui/shell/screen-catalog.ts`, `screen-links.ts`, `scripts/seed.ts`, migration 9192 | a `SCREENS` entry (family `quality-inspection`) and `ALSO` links both ways to the goods-movement screens, the code in the capability array, the code granted to roles that already hold `INV.GR.POST` or `INV.BATCH.CHANGE`, and the first `term_registry` row for module `QM` (`TIER_2_CONFIGURED`, route `/quality/lots`) |

**Two corrections to §5's sketch, both made from reading the tables rather than before it.** The sketch listed
material, plant, batch, quantity, unit and "segment at opening" as columns, plus a status column, decision
columns and a copied `material_document_year`. None of the seven was built:

* the line owns all six of those facts and the material document owns the year — the reference is the key
  `(client, material_document_number, line_number)`, and a copy would be a second claim about goods the
  inventory engine already recorded;
* a `status` column reachable by exactly one value, and `decision` columns no act could write, are placeholders.
  A lot's standing is therefore **derived**: `OPEN` while its line stands, `SOURCE_REVERSED` once the document
  is reversed in full or that line is named by a reversal line — read from the ledger, so a lot cannot
  contradict a posting. Slice 2 adds the transition, the version guard and the grant, together.

**Where each decision stands.**

| Decision | Status after this pass | What that rests on |
|---|---|---|
| D1 — segment plus batch indicator, each for its own job | **Adopted for this slice, unbuilt as a workflow.** | No code of D1's was needed to open a lot, and none was changed: the segment and `restricted_use` keep exactly their current meanings, so nothing in `inventory/` behaves differently. Owner approval for the rest of QM is still outstanding |
| D2 — honour `movement_type.destination_stock_type` at receipt | **BLOCKED, and this is where the pass stops.** | Trace complete, and it is three readers, not one: `transfer-posting.ts:114-115` (transfer scenarios), `physical-inventory-posting.ts:393-400` (a difference posting is checked against the movement's named segment), `movement-type-configuration.ts:276-282` (both-or-neither validation at `/config/movement-types`). No receipt reads it: `goods-receipt.ts:604,615` and `production-receipt.ts:519` write `UNRESTRICTED`; `DELIVERED_MOVEMENTS` (`goods-receipt.ts:59-74`) carries no stock-type fields, so the row has to be read inside the posting transaction. New finding, in the direction of *less* work: the reversal already reads the segment off the line (`goods-receipt.ts:813-886`), so §5's slice 3 is only those two receipt sites. Left unimplemented because all of them are in `src/modules/inventory/goods-receipt.ts`, which the owner holds uncommitted (+75/−14 at this pass, all of it unit conversion at receipt, nothing about the segment). No posting semantics were changed to make a plan look finished |
| D3 — a lot holds a request, not a result, and posts nothing | **Built and measured.** | `tests/quality-lot.test.ts` compares stock balances, valuation, the batch row with its version, the tenant's document count and the receipt's journal lines before and after opening — equal, and asserted as equal — while the lot reads the movement, batch and segment off the line |
| D4 — no hold on the vendor payable | **Untouched, as proposed.** | No migration touching `supplier_invoice_payment_block_reason_ck`; DI-024 stands unedited |
| D5 — no new MRP, availability or delivery rule | **Honoured.** | `production/`, `sales/` and `finance/` were not edited. Quality stock continues to be governed by `includeQualityStock` (`order-availability.ts:633`) and by the posting gates; the availability workbench's dirty owner files were left alone |

**Verified, in the sandbox against a migrated and seeded database (`cairn_b210`, migrations through 9192).** The
table read back as: `relrowsecurity` and `relforcerowsecurity` both true, one `tenant_isolation` policy on
`ALL`, `cairn_app` holding `select` and `insert` but neither `update` nor `delete`, and `public` holding nothing;
one `capability` row and one `term_registry` row for module `QM`. `npm run db:verify` **13/13**;
`tests/quality-lot.test.ts` **8/8** (open from a real goods receipt, no duplicated columns and the audit trail,
unknown line, second lot refused by name, request-key replay, reversal-derived standing plus the refusal of a
reversal line and of a reversed receipt, blocked-interval refusal, tenant isolation and the denied rewrite); the
QM scope `ls tests/ | grep -icE "batch|charact|class|shelf"` = **45 files / 153 tests, all passed**, identical to
§1's measurement; `tests/screen-links.test.ts` **6/6**. Scoped `tsc` (the quality module, its screen, tenancy and
the two screen-registry files, and the new test) is clean; the errors the sandbox's repo-wide `tsc` reports inside
`goods-issue.ts` and `goods-receipt.ts` are the owner's in-flight work in this tree, not this pass's.
`lint:ip` is **141** occurrences, the recorded baseline, with **0** pointing at a file of this pass. On this same
tree `npm run test` is **459 files / 3,186 tests, all passing** — the seven failures an earlier pass listed
(`action-security.test.ts` ×4, `grir-clearing.test.ts` ×2, `production-order-writer-guard.test.ts` ×1) did not
reproduce: those three files read 36, 4 and 3 tests, all green, and the owner's untracked guard test is among
them. On the test box, where only these fifteen paths were added to `f538fa7`: `npm run db:migrate` applied 9192,
`db:verify` **13/13**, `tests/quality-lot.test.ts` **8/8**, the QM scope **45/45 files and 153/153 tests**,
`next build` exit **0** with `ƒ /quality/lots` in the route table (3.24 kB, dynamic), and repo-wide
`tsc --noEmit` at **152** errors — the recorded baseline, none of them in a file of this pass.

**Browser acceptance: run, on the dedicated test box, and passed.** The criteria below were written as
acceptance a *reviewer* should hold the slice to, and they have now been executed there — not against a
development server, and not by a route test: `npm run smoke:browser -- --target quality-lot-receipt`, the
slice's own browser target, on the box's served `next start` build of this tree. Its fixture key is **T872**,
the only unreserved key between sales' T871 and settlement's T873, and the runner's own guard line opens every
run: `Verified QM9192 local loopback database: cairn_b210 on 127.0.0.1:5432; runtime role restricted,
migration role elevated.` It exits **0 twice in a row**, each run creating its tenant through `/clients/new`
and eleven journey steps answering ✓ with no browser error, so no claim below rests on a code path a human
never clicked.

Per criterion, and what a browser cannot reach: (1) the picker offered exactly the standing receipt line and
nothing else, and choosing it drew **`QL-0000001`** from the interval ✓ — including the refusal of a session
whose tenant had no line to offer, and the handle `/quality/lots` opening the screen from the command bar.
(2) the detail named document, line, movement, material, plant, storage location, batch, both quantity pairs
and the segment the posting left, and **its link was clicked** to `/inventory/material-documents` on that
document ✓. (3) the covered line left the candidate list the moment the lot stood, and the second attempt on it
was refused by name (`Lot QL-0000001 already stands against MD-00000001 line 1.`) with the line still carrying
exactly one row ✓. (4) *repeating the submission was not reachable in a browser, and the reason is a fact about
the screen*: the request key is generated per render and the covered line is gone from the form that would
resend it, so replay was taken through `openLot` against the same rows the browser was showing — same key, same
number, `replayed: true`, no second row — and the sentence the screen turns that into
(`Lot … was already opened by this submission; nothing was created twice.`) is quoted here rather than claimed.
(5) stock rows, valuation, the batch row with its version and `restricted_use`, the document and line counts and
the receipt's journal lines were read whole before and after every quality act and compared with a deep
equality ✓; no movement was posted, so the stock overview and the CO09 figures have nothing new to read.
(6) reversing the receipt from `/inventory/goods-receipt` displayed the lot as **Source reversed** and named the
reversal document on it, while the lot row itself did not change by one column ✓ — the standing is read, never
written back. (7) a second signed-in session, in the platform's own `AUDITOR` role, read both lots, was shown
the read-only sentence and was offered no opening form; and because a refusal-on-save cannot be pressed from a
render that contains no save, the proof of that gate is the reverse direction: granting `QM.LOT.CREATE` to that
role made the form appear on the next read, and revoking it took it away — the affordance follows the
authorization surface, which is what the action's `can()` answer enforces. (8) with no `INSPLOT` interval the
save was refused by name and pointed at `/config/number-ranges`, and nothing was written ✓; the reversal's own
line, being a line that records goods going back, is not offered ✓ and is refused on the way in.

Six corrections the run required, every one of them in the target's own file and none in a service: the empty
tenant's sentence is `No inspection lot has been opened in this tenant yet.`; quantities render at
`5.000 PC`, the three decimals `quantity()` gives a `numeric`; the target must define
`RF_BELEG / 1000 / GENERAL` as the other movement targets do, or the receipt screen answers
`No number range is defined for RF_BELEG / 1000 / GENERAL` before its form can be reached; candidate rows are
counted by their radios, because the opening form also carries a `label` for the note; and the audit column
holds the platform's uppercased actor, as every other screen's does. The sixth is an observation the run earned
and did not fix: `scripts/browser-smoke/goods-receipt.ts` still drives the purchase-order grid with
`form > div select`, and the grid has since wrapped its header fields in a `fieldset` — so that target's order
step no longer matches the screen, which is why this journey creates its order through `createOrder` and keeps
the *receipt*, which is what slice 1 posts against, in the browser. It belongs to the owner's harness work and is
recorded here rather than repaired beside it.

What that does and does not make true: `/quality/lots` is accepted as what slice 1 claims to be — a record with
no power over goods. It is **not** the quality-inspection workflow becoming operational: no result, no sampling
rule and no usage decision exists, so nothing in this chain can yet tell a person whether goods may move.

**What is still open, stated as blockers rather than as backlog.** The usage decision (slice 2) needs the
`grant update`, a `version` column and the batch write performed through the rules `batch-change.ts` already
owns, and it is the first act with any power over goods. Quarantine at receipt (D2, DI-022) waits on the owner's
`goods-receipt.ts` landing. Results, tolerances and sampling (D3's second half, slice 4) wait on an
owner-written rule. Two smaller gaps are recorded rather than paved over: quality management has no screen area
of its own — adding one means `ScreenArea`, `SCREEN_AREAS` and a `nav.area.quality` label in
`src/platform/i18n/index.ts`, a file the owner is editing, which is why `/quality/lots` sits in the Inventory
area under its own family, and the same catalogue has no `nav.area.sales` either, so that section heading
renders its key (measured, not fixed here); and the lot has a single code, so a read-only QM role cannot exist
until a display code is asked for (DI-025).
