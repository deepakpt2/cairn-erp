# Open gaps — payroll (item 4, phases 1–5b), cost centre planning (item 5), activity prices (item 6), assessment (item 7), BOM explosion (item 8), internal order line items (item 11)

Recorded 2026-11-15, at commit `a52ec282` on `development`; items 6 (KSPI), 7 (KSU5), 8 (CS11/CS12/CS15) and 11 (KOB1) added after it. These are deferred, not forgotten: each was
either out of scope by its own spec or found while building and left for a later decision. Older
deferrals made before this work stay in `DEFERRED_ISSUES.md`.

Status key: **Spec** = the item's own spec put it out of scope · **Found** = found during the build ·
**Decision** = needs a choice from the product owner before it can be built.

---

## 1. Payroll — functionality not built

| # | Gap | Kind | Notes |
|---|---|---|---|
| P1 | Statutory payroll: tax, social insurance, filing formats, country leave law | Spec | DV-001: nothing statutory ships. Amounts are configured, never legislated. |
| P2 | Retroactive accounting | Spec | A released result is frozen. A correction is a reversal plus a run in a later period. Off-cycle runs (phase 5) pay only employees no live run covers; they never recalculate. |
| P3 | End-of-service provisions | Spec | `EOS_PROVISION` components are refused by readiness, the run and structure maintenance. The demo structures no longer name EOSPROV (the component and its mapping stay). |
| P4 | Currency conversion | Spec | An employee paid in a currency other than the company's books is a run exception (`CURRENCY_DIFFERS`). |
| P5 | Payslip document or output | Spec | Results are on screen only (`/people/payroll-results`). |
| P6 | Payroll import (`PEOPLE.PAYROLL.IMPORT`, result origin `IMPORTED`) | Spec | Capability and column exist; nothing uses them. |
| P7 | Profit centre on payroll postings and payments | Spec · Decision | Nothing in the model supplies one. Needs a profit centre on the cost centre master or the position assignment — a new field. |
| P8 | One payroll document per employee | Spec | The PR document is summarised by account and cost centre. Trace is document → run → result → line. The PY payment has one line per employee. |
| P9 | Payroll's own reversal service | Spec | Reversal is the generic `/finance/document-reversal`. A reversed PR or PY leaves the run `POSTED` / the payment row standing; the run is never reopened. |
| P10 | Payment medium (bank file, DME, cheque, advice) | Spec | Phase 4 produces the accounting effect only. |
| P11 | Employee bank details | Spec | A whole run is paid from one house-bank account. |
| P12 | Partial payment / per-employee payment status | Spec | A run is paid whole, once. |
| P13 | Employee screen readiness covers the current month only | Found | `/people/employees` pay section. |

## 2. Payroll — authority and data integrity

| # | Gap | Kind | Notes |
|---|---|---|---|
| A1 | No role holds any payroll capability | Spec · Decision | `PEOPLE.PAYROLL.*`, `PEOPLE.PAYROLLRUN.EXECUTE` are withheld (history/9199). In the demo only `demo.admin` (`*`) reaches payroll. |
| A2 | In-process callers are judged on capability only | Found · Decision | The demo provisioner and the tests call payroll services with a capability list and no session; that path carries no Company Code limit. Screens and actions always pass the session. (Phase 5 / 5b put this out of scope.) |
| A3 | `assignmentFor(tx, …)` has no access check | Found | It is an internal transaction helper with no session to judge; the public `listAssignments` and readiness check are guarded instead. |
| A4 | Structure-component removal is a hard delete | Found | Added in phase 2 so EOS components can leave a structure. Calculated results keep their own lines; the change document is the only record of the removed component. |

## 3. Cost centre planning (KP06) — item 5

| # | Gap | Kind | Notes |
|---|---|---|---|
| C1 | Plan version copy (KP97/KP98) | Spec | Not built. |
| C2 | Plan version administration | Spec | Versions stay a free key of up to three characters, as for activity rates. |
| C3 | No role holds `CO.PLAN.COSTCENTER.MAINTAIN` | Spec · Decision | Only `demo.admin` can plan in the demo. |
| C4 | Assessment, distribution, activity price calculation (KSU5, KSV5, KSPI) | Spec | Downstream of planning; items #5, #6, #9 of the ranked list. |
| C5 | Annual-total spread uses equal shares only | Found | No seasonal or weighted distribution keys. |
| C6 | A cost centre with no company code is scoped against every company of its area | Found | The service needs reach over all of them to plan such a centre. |

## 3b. Activity price calculation (KSPI) — item 6

| # | Gap | Kind | Notes |
|---|---|---|---|
| K1 | Price indicator 2 (automatic on capacity) | Spec · Decision | `work_center` carries no cost centre, so there is no path to the capacity that would be the denominator. Needs a new field on the work centre master. Refused by name. |
| K2 | No iteration | Spec | One pass (`iterations: 1`). Becomes incomplete when assessment (KSU5) or distribution (KSV5) lands. |
| K3 | Two-decimal prices | Spec · Decision | `activity_rate.fixed_price`/`variable_price` are `numeric(11,2)`; the residual is reported. Widening is a migration. |
| K4 | No fixed/variable split | Spec | No fixed/variable indicator on a cost element; all cost is fixed, variable price 0. |
| K5 | A cost centre planning more than one activity type is refused | Decision (chosen) | No equivalence numbers to split the centre's cost; owner chose refusal over a guessed rule. |
| K6 | No role holds `CO.PLAN.ACTIVITYPRICE.EXECUTE` | Spec · Decision | Only `demo.admin` in the demo. |
| K7 | A calculated price goes stale when quantities change | Found | KP26 accepts the standing calculated price back unchanged; after changing a planned quantity the calculation must be run again. |
| K8 | Prices are written into existing rows only | Found | Periods a pair never planned get no row and no price (the spec allowed upserting them). |

## 3c. Assessment and distribution cycles (KSU5, KSV5) — items 7 and 9

| # | Gap | Kind | Notes |
|---|---|---|---|
| S1 | Distribution cycles (KSV5) | **Closed** | Built by item #9: a distribution runs, preserving each sender's G/L account; see S11–S17. |
| S2 | Order receivers | Spec | Receivers are cost centres or groups only; orders need a receiver-type dimension and an order-validity judge. |
| S3 | Fixed-amount sending | Spec | Sender rule is POSTED (net posted actuals) only. |
| S4 | Variable portions by tracing factor | Spec | Needs a tracing-factor master; refused by name. |
| S5 | No iteration | Spec | One pass (`iterations: 1`); chained segments read the senders' cost before the run. `allocatePass` is the body a loop would call. |
| S6 | No role holds `CFG.COST.ALLOCATION.DEFINE`, `CO.ASSESSMENT.EXECUTE` or `CO.DISTRIBUTION.EXECUTE` | Spec · Decision | Only `demo.admin` in the demo. |
| S7 | Cross-company cycles | Decision (chosen) | A run whose centres span company codes is refused by name: one document per company and no cross-company clearing account. |
| S8 | Currency asymmetry, deliberate | Decision (chosen) | The cost-centre report warns and excludes foreign-currency lines; a run refuses a company whose currency is not the area's. The report can show less; a run must not silently send less. |
| S9 | Cross-company and currency-mismatch refusals are not covered by a test | **Closed** | Item #9: a copy of company 1000 plus its assignment to the area is all it took; both refusals are tested at the end of `tests/cost-allocation-cycle.test.ts`. |
| S10 | Cancelling a run trusts the document's REVERSED status | **Closed** | Item #9: the assessment cancel test and the distribution re-run test reverse through `reverseDocument` (an AB document), then cancel. |
| S11 | Assessment and distribution identify allocation output differently | Decision (chosen) | Assessment excludes lines on its own account (so a manual posting to that account is not assessable, and a distribution's output *is* assessable); distribution excludes by document. Left as shipped; not harmonised. Distribution→assessment chaining works, assessment→distribution does not. |
| S12 | A centre on a live run's document cannot be distributed in that period | Decision (chosen) | Excluding allocation documents hides a sender's own relief, so a second cycle would relieve it twice; the run is refused, naming the run and cycle. Order-independent, reproducible results; chaining across cycles needs iteration (S5). Cancelling the earlier run frees the centre. |
| S13 | The allocation-output exclusion is client-wide, by document number and company | Decision (chosen) | Matches `client` + `company` + number + year for the document and `client` + `company` + `reversal_of` for its reversal (`journal_entry` stores no year beside `reversal_of`; one document reverses an original). A cancelled run's document stays excluded. |
| S14 | `assessed_total` and the `assessment_*` names serve distribution too | Debt | `assessed_total` is the amount relieved for either kind; `assessment_account` is null for a distribution (CHECK by `category`). Renaming a shipped column is churn for a cosmetic gain. |
| S15 | FIXED_AMOUNT in distribution is checked against the segment total | Decision (chosen) | The fixed amounts must sum to the senders' total; each (sender, account) group is split in proportion and the cents settled in the largest group, so each receiver gets exactly its amount. A share that would change sign is refused. |
| S16 | An unrecognised category is unreachable end to end | Found | The cycle's CHECK allows ASSESSMENT and DISTRIBUTION only; the service's refusal is tested through `executeCapabilityFor`. |
| S17 | A distribution document can be large | Found | groups × (1 + receivers) lines; `postGlDocument` imposes no line limit. Nothing is truncated or split. |

## 3d. BOM explosion and where-used (CS11 / CS12 / CS15) — item 8

| # | Gap | Kind | Notes |
|---|---|---|---|
| B1 | Explosion by order (CS13) and BOM comparison (CS14) | Spec | An order's BOM is snapshotted separately (`order-bom-snapshot.ts`). |
| B2 | Only MAKE materials are exploded below the top | Decision (chosen) | Matches MRP; BUY and other procurement types stop with a named note. SAP's CS12 would explode any material with a BOM. |
| B3 | Bulk, co-product, issuing-plant and special-procurement items are shown but not recursed | Found | Mirrors MRP, which does not plan them; each carries a note. |
| B4 | No costing of the structure | Spec | Item #11 (CK11N). Quantities only. |
| B5 | Where-used shows BOM quantities only | Spec | By design: walking upward there is no parent quantity. |
| B6 | The explosion reads one plant | Spec | An issuing plant other than the BOM's is shown, never switched to. |
| B7 | A unit that loses its conversion after BOM maintenance stops the branch | Found | BOM maintenance refuses such a unit; the report reports it (`UNIT`) if a conversion is later removed. |

## 3e. Internal order line items (KOB1) — item 11

| # | Gap | Kind | Notes |
|---|---|---|---|
| L1 | One order at a time | Spec | KOB1 accepts a list or range of orders; the report takes one. Also stated in the report's own `gaps`. |
| L2 | No role holds `CO.ORDER.COST.DISPLAY` | Spec · Decision | Granted exactly as `PROD.ORDER.COST.DISPLAY`: exact-grant-only (`capability-policy.ts`) and in no role, so `*` and `CO.*` do not reach it and no demo account can open the screen until someone is granted it by name. |
| L3 | No commitments (KOB2), plan, budget or budget-vs-actual | Spec | Budget tables exist; a comparison is a possible later item. |
| L4 | No net in order currency when local currencies differ | Decision (chosen) | Totals per (company, document currency, local currency) stay complete; the net is null and the gap names the currencies. Same rule as the cost-centre report and assessment. |
| L5 | No index on `journal_entry_line.internal_order` | Found | The production-order sibling has a partial index; adding one is a schema change, which this item excluded. The read uses the client/document join; add `(client, internal_order) where internal_order is not null` if the report gets slow. |
| L6 | Orders as allocation receivers | Spec | Gap S2 above; when it closes, allocation lines appear here with no change. |
| L7 | Settlement covered by a fixture, not a real run | Found | Test 16 writes a document with origin `order_settlement`, as `order-settlement.ts` posts it; the demo order IO-00000001 shows real settlement lines (document 1000/2026/90). |

## 3f. Standard cost estimate (CK11N / CK13N) — item 12

| # | Gap | Kind | Notes |
|---|---|---|---|
| E1 | No costing variant | Spec | One rule set, hard-coded and stated on the screen. `order-type-parameters.ts` says costing is not configured. |
| E2 | No overhead | Spec | No costing sheet exists. Overhead is stored as zero (a CHECK enforces it) and shown with the reason. |
| E3 | `workCenterCosting.formula` is not evaluated | Spec | So a work centre with several costing lines is refused: one operation quantity cannot be split across activity types. Same decision as KSPI. |
| E4 | Not costed, refused by name | Spec | Co-products, special procurement, external processing (item or operation control key), subcontracting. |
| E5 | One material at a time | Spec | The costing run over many materials (CK41N) and releasing to the material master (CK24, item #25) are separate items. **Nothing here writes `standardPrice`** (test 19). |
| E6 | Cost component split is by origin, not the spec's literal reading | Decision | Material = every bought component at every level, activity = every operation at every level, so a made sub-assembly's operations stay visible as activity. Read literally, "material = Σ component costs" would put them in material. Total is the same. |
| E7 | Added to the spec's tables | Decision | `in_total` on items (a made component's own lines explain its roll-up line and are not added twice), `controlling_area`, `plan_version` and `request_key` on the header, `item_text`, and a `NOT_COSTED` price source (an operation whose control key is not relevant for costing is listed at zero rather than hidden). The component column is `component_material` (the spec named two columns `materialNumber`). |
| E8 | Activity lines carry the assembly's own level | Decision | 0 for the finished material, the roll-up line's level for a sub-assembly's operations. |
| E9 | BOTH and phantom | Decision | A BOTH material costs as made when a production version resolves, else from its price. A phantom is costed from its BOM alone and rolled into its parent; it needs no routing. A MAKE material with no routing, or a BOM or routing not released for costing, is refused. |
| E10 | The default lot size needs a version that covers 1 unit | Found | The BOM base quantity is read through a probe at quantity 1; a production version whose lot range excludes 1 refuses with its own message. Enter the lot size explicitly. |
| E11 | Fiscal year of the costing date is found among year, year + 1 and year - 1 | Found | `planningContext` takes a fiscal year, not a date; shifted year variants are covered, nothing beyond one year either way. |
| E12 | Demo operation hours are assumptions | Found | D16 filled the missing operation quantities and work centre costing lines, only where empty. The hours are invented (they make the estimate about twice the existing standard price of FG-CHOC); change them in `/production/routings` and cost again. |
| E13 | Display needs the create capability | Decision | No separate display code. The capability is granted to no role (as `CO.PLAN.COSTCENTER.MAINTAIN`); the demo administrator reaches it through its wildcard role. |

## 3g. Sales availability check (ATP) — item 13

The engine (`sales/availability.ts`) existed before this item and runs when an order is created or changed and when a delivery is created. This item extended it: supply counted over time, a confirmed date, a document-type rule, `salesRequirements`, and an on-demand check with a preview.

| # | Gap | Kind | Notes |
|---|---|---|---|
| A1 | The check stays automatic on create and change | Decision | The spec said on demand only; it already ran automatically. Left as it is. The new action re-asks and previews; it never replaces the automatic check. |
| A2 | No replenishment lead time | Spec | None is stored. A confirmed date is the date supply stands, not a transport-adjusted promise date. |
| A3 | One confirmation per line; "later" means all of it later | Decision | A line is never split across dates. If the full quantity stands only later (inside the horizon) the line is confirmed in full on that date (`delayed`); delivery's own door check still limits what ships today. Where it never stands, what stands at the requested date is confirmed and the remainder is reported undated. |
| A4 | Other orders' promises subtract regardless of date | Found | An order promised against a later receipt still reduces the near-term availability of the next order. Conservative: it can understate, never double-promise. |
| A5 | Sales requirements come from confirmed promises, not requested quantities | Found | MD04 carries no sales-order element, so demand an order asked for and was not confirmed is not subtracted. |
| A6 | Production-order scope `F` means released | Decision | There is no firming indicator on production orders. `F` counts released (and technically complete) orders, as the production availability check reads it. The spec said to refuse `F`; it is honoured instead, and not covered by a test (needs production-order fixtures). |
| A7 | Restricted-use stock is refused | Spec | No such stock bucket. A scope asking for it is refused naming the flag. |
| A8 | A missing scope row: tolerated for the default rule, refused for a named one | Decision | The default rule OR has always counted stock and promises with no scope and keeps doing so; a rule a document type names must have a scope for each group. |
| A9 | Orders are always document type OR | Found | `createSalesOrder` takes the standard order type; a rule named on a type therefore applies to every order until order types are selectable. Blank is OR, not "no check" (the spec's reading would have switched checking off for every existing order). |
| A10 | The horizon is a year past the latest date asked for | Decision | Plus the stock/requirements list's hit limit (500): if truncated the search ends at the last element returned. A receipt beyond the horizon is not searched for. |
| A11 | Delivery's door check now counts the LF scope's supply | Found | Elements dated up to today (past receipts unless `B`). With no supply flags set the door check is unchanged. |
| A12 | The demo has no open supply for its demo material | Found | Both TRAD-JUICE purchase orders were received, so the erp_dev demo shows a stock-only partial confirmation. The receipts path is proved in tests. Two cancelled orders (SO-0000007, SO-0000008) remain from sizing the demo order against the customer's credit headroom. |
| A13 | Migration 9288 was corrected by 9289 | Found | 9288 had been edited after it was applied and the ledger refused it; it is restored and 9289 widens `item_text` and clears the registry row's `our_table`. |

## 3h. MRP exception monitor (MD06) — item 15

| # | Gap | Kind | Notes |
|---|---|---|---|
| M1 | No MRP controller grouping (MD07) | Spec | No MRP controller master exists (item #18). |
| M2 | Plant scope only | Spec | MD04 refuses an MRP area; so does the monitor. |
| M3 | Recomputed on every run; ~16–20 ms per material | Found | Measured on the demo (11 materials in 173 ms, 5 in 85–118 ms): 50 materials is about a second, 500 about 8–10 s, more for materials with long lists. The default stays 50; the ceiling (500, refused above) is for a deliberate scan. |
| M4 | The scan runs in material-number order, not urgency | Found | When the limit stops it, the unscanned materials may include urgent ones. Reported on the screen and in `warnings`; raise the limit or narrow the range. |
| M5 | Counts are MD04's, per row | Found | A shortage usually carries a safety-breach row with it, so a shortage material shows both; totals sum rows, not materials. |
| M6 | First exception date is that of the most urgent code | Decision | The spec said "first date short"; a material with only a breach or only past-due rows has no such date, so the date of its worst code is used. |
| M7 | The exceptions filter keeps materials with any selected code | Decision | Each row still shows all its counts (they must equal MD04's); totals are the sums over the rows shown. |
| M8 | The excluded count is within the material range | Decision | NONE and blank types are counted over the range asked for, and a material with no plant view is not counted anywhere. |
| M9 | Existing demo roles hold a snapshot of expanded capabilities | Found | Demo provisioning expands `PROD.*` / `SALES.*` into exact codes when it runs, so on the existing erp_dev `demo.planner` lacks `PROD.MRP.EXCEPTION` and `demo.sales` lacks `SALES.ORDER.AVAILABILITY.CHECK` until a role is granted them. A fresh install gets both; `demo.admin` holds `*`. |
| M10 | Drill-through not clicked in a browser | Found | No signed-in browser session was used. Verified by the exact-URL test, by MD04's page reading the same `material` and `plant` parameters, and by the route compiling on the dev server. |
| M11 | Authority by session, not `heldCapabilities` | Decision | Like every other service here: the signed-in session is judged, with the user's Plant scope, before any planning data is read. |

## 4. Demo data and environment

| # | Gap | Kind | Notes |
|---|---|---|---|
| D1 | `demo.admin` carries explicit Company Code 1000 and Plant 1000/2000 scope | Found · Decision | Granted by `D9_PAYROLL_POST` (approved) because the judged posting services refuse an unscoped actor. Its practical reach is unchanged. |
| D2 | Demo failed-markers were reset by hand in erp_dev, three times | Found | `D9_PAYROLL_POST` once, `D12_CO_PLAN` twice: each time the cause was fixed, `status` set back to `RUNNING`, and the phase resumed. Status updates only, nothing deleted. A fresh install runs every phase clean (verified for D1–D11 on a scratch database; D12 was fixed after that run). |
| D3 | Leftover browser-test data in erp_dev | Found | 10000016's MGMT assignment from 2026-11-15 (phase 1); the off-cycle November run was released, posted and paid through the UI (phase 5). |
| D4 | The demo password changes with every appended demo phase | Found | By design of the resume path; the current one is in `credentials/demo-credentials.txt`. |
| D5 | Test tenants carry no `RF_BELEG` number range | Found | The payroll posting/payment/follow-up tests maintain their own. |
| D6 | Demo payment dated the last day of the period, not the day after | Found | Keeps it inside the demo's open periods. |

## 5. Pre-existing test failures — diagnosed, not fixed

| # | Test | Cause | Fix when taken up |
|---|---|---|---|
| T1 | `tests/batch-determination-contract.test.ts` — "writes one pick row per batch, numbered on from the last" | Expects the pick request key `` `${parsed.requestKey}#${index + 1}` ``; commit `0443b972` (2026-11-12) changed `src/modules/sales/delivery.ts:1269` to `#<line>.<pick>` and the test was not updated. | Update the expected string. |
| T2 | `tests/action-security.test.ts` — "posts in the session tenant under the actual user, not the form tenant" | The test inserts the user and session but grants the user no role, capability or Company Code restriction in the database; `postGlDocument` judges the session there and refuses, so the action returns `ok: false`. | Give the test user a role holding `FIN.JOURNAL.POST` and a scope for company 1000. |

Neither touches payroll or planning code. Full suite at `5ba0c777`: 4,679 / 4,681 passing — only these two.

## 6. Verification not done

| # | Gap |
|---|---|
| V1 | `npm run lint:ip` not run (it was failing before this work). |
| V2 | Full suite not re-run after phase 5b and item 5 (targeted suites only, as their specs asked). |
| V3 | Several posting events that predated phase 5 now carry labels; `/config/account-determination` was checked in the browser, other screens using `acctDet.event.*` were not. |
