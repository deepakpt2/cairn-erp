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
5. **QM inspection model** — needs a requirement first: nothing in `CAIRN.md` asks for inspection lots.

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
* Evidence run on the box for this commit: `tests/sales-order.test.ts` 17/17 (create, pricing from the record,
  tax by company country, every refusal — no record, over-precise quantity, unknown unit, material not at the
  plant, blocked customer sales area, unknown sales area, replay of a repeated submission, change with a stale
  version and with a silently dropped item, rejection keeping its reason, credit block then authorized release
  then a refused second release, a fresh determination when a change takes the order over the limit, cancel once
  and the transitions that no longer exist, and a condition change closing the span it replaced);
  `npm run db:verify` 13/13 after applying `drizzle/9190`; `tsc --noEmit` 152, none of them in a sales file;
  `screen-links`, `production-documentation-consistency`, `credit-release`, `credit-monitor`, `customer-invoice`,
  `purchase-order` and `browser-target-constrained-driving` green in the same run (8 files, 54 tests).
* Not done, and recorded rather than glossed: there is no browser target for either new screen yet, because the
  journey a target would drive does not end at an order — see DI-020. The delivery, goods-issue and billing links,
  the rest of the pricing vocabulary (DI-018) and the exposure basis (DI-019) are the next three entries.
