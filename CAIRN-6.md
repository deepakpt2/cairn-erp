# Cairn — Project Log & Technical Specification (continued)

**Product:** Cairn — an enterprise resource planning system
**Hostname:** cairn.deepakpt.com
**Document status:** AGREED baseline (2026-10-08 Go) — implementation IN BUILD; screen sign-off remains per §24.1
**Created:** 2026-10-19 (v2.374) · **Part 6 of 6 — this is the live part**
**Continues:** [CAIRN.md](CAIRN.md) (§0–§26.35) · [CAIRN-2.md](CAIRN-2.md) (§26.36–§30 through v1.69) · [CAIRN-3.md](CAIRN-3.md) (§0.3, §1.4 R-24–R-72, §2.1 D-093–D-139, §26.167–§26.259, §30 v1.70–v2.61) · [CAIRN-4.md](CAIRN-4.md) (§1.4 R-73–R-98, §26.260–§26.364, §30 v2.62–2.169) · [CAIRN-5.md](CAIRN-5.md) (§26.365–§26.555, §30 v2.170–2.373)
**Owner:** Deepak (product owner) · Built with Arena.ai Agent Mode

---

## §0.3 Document-set size and rotation rule `AGREED · v1.70`

The rule recorded in `CAIRN-3.md` §0.3 (R-24 / D-093) is unchanged and binding: no part may exceed
400,000 bytes; a live part rotates as soon as it passes 360,000 bytes; the next part continues section
and version numbering without a gap; both the outgoing and the incoming part carry a continuation
notice; a rotated part is frozen to pointer edits and corrections that cannot be deferred; size is
measured on disk in the same turn any canonical file is edited.

**Set status at v2.374 (2026-10-19):** `CAIRN-5.md` passed the rotation trigger at 361,576 bytes and
is frozen to pointer edits; this part continues §26 from 26.556 and §30 from 2.374. SCR-083 (F-29) is
the last round closed in part 5; SCR-084 (F-39) opens here.

---

## §26.556 — SCR-084 contract R-132: clear customer down payment (F-39)

The owner supplied the F-39 field package (2026-10-19); SAP codes stand as search aliases only. This round mirrors R-130 (SCR-082) on the customer side and completes the customer advance chain (F-29 → F-39). **The owner's accounting correction is accepted in full:** a clearing is a real transfer posting, never a marking exercise — one journal moves the applied value off the indicator's alternative reconciliation account onto the customer's ordinary reconciliation account, and only then are fully applied items stamped.

**Contract decisions.** (1) *Document type and indicator are configuration, never constants of the business logic:* the clearing journal posts under **DZ** — the delivered customer-payment document type, judged by the posting engine against the tenant's configured document types (the package's AB is declined: in the delivered configuration AB permits G/L accounts only and could not carry customer partner lines); the special G/L indicator resolves through the standing AR special G/L configuration, company scope first, then tenant-wide, and an unconfigured indicator is refused by name — `A` is never hardcoded. (2) *Allocation grid, pairwise:* the clearing's unit is an **allocation** — one down-payment item, one invoice item, one positive amount. One down payment may settle several invoices and one invoice may draw on several down payments; partial clearing is valid and unallocated balances stay open. Each allocation is judged: same tenant, company and customer on both items; the source an eligible open down-payment item of the chosen indicator; the target an eligible open standard receivable; the sum allocated per item never above its remaining balance. The journal aggregates the allocations per item — debit the alternative account per down payment applied (`Applied from …`), credit the ordinary reconciliation account per invoice settled (`Settles …`) — so the document balances by construction and the unassigned difference is zero; there is no difference posting in a clearing. (3) *The allocation-mapping table is **adopted** this round* (a deliberate departure from the R-127–R-131 declines, on the package's explicit requirement): `customer_down_payment_clearing` carries the clearing header in the house payment-record pattern (client scope, journal document number as the clearing number, resolved alternative account, request-key idempotency, audit columns) and `customer_down_payment_clearing_item` carries one row per allocation, linking both source journal lines by (client, document number, fiscal year, line number) under composite foreign keys, with the allocated amount and currency. The **journal lines remain the balance authority** — remaining balances derive from the posted lines (original less offsetting lines naming it), never from the mapping; the header's cleared total is a summary reconciled to the committed allocation rows during posting, and role conditions (customer, indicator, eligibility) are judged in the service because foreign keys cannot express them. (4) *Eligibility and balances:* down-payment items are the open, unstamped credit lines of standing `customer_down_payment` receipts for the chosen indicator on the resolved alternative account; invoice items are the customer's open debit items on the ordinary reconciliation account; reversed and fully cleared items never appear (posted journals only). Remaining amounts are re-read under the clearing's advisory lock (`${client}/custdpclr/${company}/${customer}`) after the request-key replay check, exactly as the standing clearings. (5) *Customer and period judging:* the customer must stand extended to the company and unblocked, with a reconciliation account; the fiscal position derives from the company's fiscal-year variant and the posting date through the standing period machinery; the clearing date stamps fully applied items. (6) *Currency:* one clearing settles one currency — items and the clearing currency must agree, or the clearing is refused naming the currencies.

**Deferred by name:** foreign-currency conversion and exchange-rate differences (mixed-currency clearings are refused, not converted), cash-discount and residual-difference postings, tax adjustment on clearing, down-payment requests (F-37), drafts, a server-side posting simulation (the screen totals the allocation grid client-side), and reset or reversal of a clearing beyond the standing clearing-reset (FIN.CLEARING.RESET) and journal-reversal machinery. Stage order: 1 the `/finance/customer-down-payment-clearing` screen → 2 schema (clearing header + allocation mapping, migration) → 3 service and screen wiring → 4 supporting (capability and term) → 5 tests and browser acceptance. Same-stage bookkeeping: B-540 / §26.556 / §30 row 2.374.

---

## §26.557 — SCR-084 stage 1: the customer down-payment clearing screen

**B-541.** Stage 1 of R-132. The `/finance/customer-down-payment-clearing` screen stands as a shell mirroring its vendor twin, shaped for pairwise allocation: selection criteria (company, customer, configured indicator), the two open-item grids (advances with allocated-here tracking; invoices with due dates), and an allocation builder — one row per application of a down payment to an invoice, with per-item over-allocation judged live in the form. Posting stands disabled until the service lands in stage 3; no reads or writes stand yet. A stub module carries the capability `FIN.AR.DOWNPAYMENT.CLEAR` and the clearing vocabulary. Same-stage bookkeeping: B-541 / §26.557 / §30 row 2.375.

## §26.558 — SCR-084 stage 2: clearing header and allocation mapping schema

**B-542.** Stage 2 of R-132. `customer_down_payment_clearing` carries the clearing header in the house payment-record pattern (resolved alternative account remembered, cleared total as a reconciled summary, request key, audit columns), and `customer_down_payment_clearing_item` carries one row per pairwise allocation under composite foreign keys to both source journal lines and to the header — the package's mapping table adapted to house widths and client scope (migration `0094_customer_down_payment_clearing.sql`, applied; **157 migrations**; foreign keys and positive-amount checks verified by read-back). The journal lines stay the balance authority. Typecheck clean. Same-stage bookkeeping: B-542 / §26.558 / §30 row 2.376.

## §26.559 — SCR-084 stage 3: clearing service and wired screen

**B-543.** Stage 3 of R-132. `clearCustomerDownPayments` judges the pairwise allocations under the clearing's advisory lock after the request-key replay check: the customer extended and unblocked, the indicator resolved through AR configuration, every source line re-read and re-judged (role, company, account, side, unstamped, remaining balance), one currency per clearing. It posts the DZ transfer journal — the alternative account debits per down payment applied, the ordinary reconciliation account credits per invoice settled — stamps fully applied items in place with their offsetting lines, writes the clearing header and one mapping row per allocation, and reconciles the header total to the committed rows before the change document. The screen is live through its server action: the allocation builder serialises its rows to the service, and the message names the cleared total and the items cleared in full. Typecheck clean. Same-stage bookkeeping: B-543 / §26.559 / §30 row 2.377.

## §26.560 — SCR-084 stage 4: clearing capability seeded

**B-544.** Stage 4 of R-132. The capability `FIN.AR.DOWNPAYMENT.CLEAR` (F-39 as search alias) joins the seed with its full-parity term — **117 capabilities / 68 config activities / 91 terms / 100 aliases**. The special G/L maintenance already carries the AR account type, so the indicator's configuration remains the tenant's own. Registry check reads the new term back. Same-stage bookkeeping: B-544 / §26.560 / §30 row 2.378.

## §26.561 — SCR-084 acceptance and closure

**B-545 — SCR-084 CLOSED with browser acceptance.** Targeted suite 3/3 (refusal paths by role and currency, the pairwise DZ transfer with its mapping rows read back, the full-consumption stamp), **full suite 1360 green** (1356 + 3 SCR-084 + 1 fixture); browser **T912 green** against the production build (DB cairn_b210:5432): an 8,000 advance and a 1,200 invoice stood open, 1,000 was allocated through the allocation builder, and the database remembered journal 1000/2026/3 debiting the alternative account 230000, crediting the ordinary receivable account 110000, with its mapping row for 1000.0000. Seed twice idempotent at 117 capabilities / 91 terms; the database stands at 157 migrations. The customer advance chain (F-29 → F-39) stands complete, as the vendor chain (F-48 → F-54) before it. Deferred by name from R-132: F-37 down-payment requests, foreign-currency conversion and differences, discount/difference postings, tax adjustment, drafts, server-side simulation, and clearing reset beyond the standing machinery. **Next: T-code F-37 — customer down payment request** (the noted-item request that precedes an F-29 receipt; its vendor twin F-47 remains queued with it); the owner's package is requested.

## §26.562 — SCR-085 contract R-133: customer down payment request (F-37)

The owner supplied the F-37 field package (2026-10-19); SAP codes stand as search aliases only. **The package's central distinction is accepted in full:** a down-payment request is a noted (statistical) item — it creates no receivable, no cash receipt and no general-ledger movement; the actual receipt remains F-29's act, and fulfillment is an explicit allocation link from the request to the posted F-29 line.

**Contract decisions.** (1) *No journal for a request.* The package's accounting-header document identity and any statistical journal line are **declined**: the house posting engine posts balanced documents only, and an empty or one-sided header would corrupt the journal invariants every balance reads from. The request record is itself the document — it draws its number from a new `CUSTDPREQ` number-range object (joining the object catalogue and the tenant builder's default ranges), derives its fiscal year from the posting date through the standing fiscal-year-variant machinery, and judges the posting period for the customer account type exactly as a posting would. Its document type is entered (DZ by default) and **validated against the tenant's configured document types** — it must exist and permit customer account type D — never assumed. (2) *Request indicators are configuration with a target.* `special_gl_config` gains a nullable target-indicator column: a row carrying a target is a noted-item request indicator (the package's F) mapping to the actual down-payment indicator expected at fulfillment (the package's A); a row without one is an actual indicator. The special G/L maintenance learns the target, and the shared resolution refuses a noted indicator for an actual posting, naming the target to post against — so F and A stay tenant configuration, never constants. (3) *Fulfillment through F-29.* The receipt gains optional request allocations: under the payment's standing advisory lock, each named request is re-read and judged — same customer and company, the receipt's indicator equal to the request's target, one currency (request, receipt and allocation alike; conversion is deferred), the request neither closed nor reversed. The allocated amount defaults to the lesser of the receipt and the request's remaining amount, may be named smaller, and may never exceed the remaining amount — over-fulfillment is refused naming the remainder, there being no configured tolerance this round. One receipt may allocate to several requests; one request may be fulfilled by several receipts. (4) *Derivation, not storage, is truth for amounts.* The fulfillment table is **adopted** with composite foreign keys to the request and to the actual F-29 journal line; fulfilled and remaining amounts derive from its ACTIVE rows, and the request's stored status (OPEN / PARTIAL / FULFILLED) advances atomically with each fulfillment. Statuses CLOSED and REVERSED stand reserved in the constraint; their workflows are deferred. (5) *The customer* must stand extended to the company and unblocked, as at receipt.

**Deferred by name:** the vendor twin (F-47), request closure and reversal workflows (and fulfillment resolution on reversal), drafts, foreign-currency fulfillment, credit-exposure inclusion of open requests, duplicate-reference rules beyond the standing reference width, and request reporting beyond the screen's open-request list. Stage order: 1 the `/finance/customer-down-payment-request` screen → 2 schema (request + fulfillment tables, special G/L target column, migration) → 3 services (request lifecycle, F-29 fulfillment, noted-indicator guard) and screen wiring → 4 supporting (capability, term, number-range object, special G/L maintenance) → 5 tests and browser acceptance. Same-stage bookkeeping: B-546 / §26.562 / §30 row 2.380.

## §26.563 — SCR-085 stage 1: the down-payment request screen

**B-547.** Stage 1 of R-133. The `/finance/customer-down-payment-request` screen stands as a shell: the request form (company, customer, document/posting/due dates, amount, currency, request indicator, document type, reference) with the noted-item explanation, and the open-requests grid — requested, fulfilled, remaining, target indicator, status — rendered empty. Posting stands disabled until the service lands in stage 3; no reads or writes stand yet. A stub module carries the capability `FIN.AR.DOWNPAYMENT.REQUEST` and the request vocabulary. Same-stage bookkeeping: B-547 / §26.563 / §30 row 2.381.

## §26.564 — SCR-085 stage 2: request and fulfillment schema

**B-548.** Stage 2 of R-133. `customer_down_payment_request` carries the noted item in the house record pattern (drawn number, derived fiscal year, due date distinct from both document dates, reserved lifecycle statuses under check), and `down_payment_request_fulfillment` links each fulfillment to its request and to the actual F-29 journal line under composite foreign keys, its ACTIVE rows the derivation source for fulfilled amounts. `special_gl_config` gains the nullable target indicator that marks a request indicator (migration `0095_customer_down_payment_request.sql`, applied; **158 migrations**; column and constraints verified by read-back). No journal table is touched — the request moves no account. Typecheck clean. Same-stage bookkeeping: B-548 / §26.564 / §30 row 2.382.

## §26.565 — SCR-085 stage 3: request service, F-29 fulfillment, wired screens

**B-549.** Stage 3 of R-133. `createCustomerDownPaymentRequest` judges the customer, resolves the request indicator to its configured target (refusing an indicator configured without one, by name), validates the entered document type against the tenant's configured types and the posting period for the customer account type, draws the CUSTDPREQ number, and writes the noted item — no journal is created and no account moves. `applyRequestFulfillment` runs inside the F-29 receipt's transaction under its lock: the request is re-read for update, judged for customer, company, target indicator and currency, and the allocation (defaulting to the lesser of the receipt's unallocated part and the remainder, never above the remainder) is written as an ACTIVE link to the receipt's credit line while the request's status advances. The shared indicator resolution now refuses a noted indicator for an actual posting, naming its target. Both screens are live: the request form posts and lists open requests with derived amounts, and the receipt form gained its optional request and fulfill-amount fields. Neighbouring down-payment suites (9 tests) stand green through the guard. Typecheck clean. Same-stage bookkeeping: B-549 / §26.565 / §30 row 2.383.

## §26.566 — SCR-085 stage 4: request capability, number-range object, special G/L target

**B-550.** Stage 4 of R-133. The capability `FIN.AR.DOWNPAYMENT.REQUEST` (F-37 as search alias) joins the seed with its full-parity term — **118 capabilities / 68 config activities / 92 terms / 101 aliases** — and the special G/L term learns the request target. `CUSTDPREQ` joins the number-range object catalogue, the object roster and the tenant builder's default ranges (prefix CR), so new tenants draw request numbers from birth and standing tenants define the interval in number-range maintenance. The special G/L maintenance now carries the target through its list and form: naming a target makes an indicator a request indicator, blank leaves it actual, and a self-target is refused. Typecheck clean. Same-stage bookkeeping: B-550 / §26.566 / §30 row 2.384.

## §26.567 — SCR-085 acceptance and closure

**B-551 — SCR-085 CLOSED with browser acceptance.** Targeted suite 3/3 (refusals by name; the noted item posting with zero journals in the tenant; F-29 fulfillment deriving PARTIAL then FULFILLED with over-fulfillment and wrong-indicator receipts refused), **full suite 1364 green** (1360 + 3 SCR-085 + 1 fixture); browser **T911 green** against the production build (DB cairn_b210:5432): indicator F stood configured with target A, request CR-0000001 posted through the form, a 2,000 receipt fulfilled it in part, and the database remembered the ACTIVE 2000.0000 link, the PARTIAL standing, and exactly one journal in the tenant — the receipt's. Seed twice idempotent at 118 capabilities / 92 terms; the database stands at 158 migrations. The customer advance chain now runs request → receipt → clearing (F-37 → F-29 → F-39). Deferred by name from R-133: the vendor twin (F-47), request closure and reversal workflows with their fulfillment resolution, foreign-currency fulfillment, credit-exposure inclusion, duplicate-reference rules, drafts and request reporting beyond the open-request list. **Next: T-code F-47 — vendor down payment request** (the vendor twin of this round: a noted item fulfilled by an F-48 payment); the owner's package is requested.

## §26.568 — SCR-086 contract R-134: vendor down payment request (F-47)

The owner supplied the F-47 field package (2026-10-19); SAP codes stand as search aliases only. This round mirrors R-133 (SCR-085) on the vendor side and completes the vendor advance chain (F-47 → F-48 → F-54). **The package's central distinction is accepted in full:** the request is a noted (statistical) item — no vendor liability, no bank movement, no journal; the actual disbursement remains F-48's act, linked back by explicit fulfillment allocations.

**Contract decisions.** (1) *No journal for a request,* exactly as R-133 ruled for customers: the request record is itself the document, drawing its number from a new `VENDDPREQ` number-range object (catalogue, roster and tenant builder defaults, prefix VR), deriving its fiscal year from the posting date, judging the posting period for the vendor account type, and validating the entered document type (KA by default) against the tenant's configured types — it must exist and permit vendor account type K, never assumed. (2) *Request indicators are the same configuration:* the AP rows of `special_gl_config` carry the target the SCR-085 column already provides; the shared resolution already refuses a noted indicator for an actual F-48 posting, naming its target. (3) *The vendor must stand extended* to the company; following the package, the company payment block does **not** refuse the request — a request is not a disbursement — while F-48's standing blocked-vendor judging enforces the block before any money moves (a deliberate, recorded difference from the customer side, where the single company block is a master block judged at both acts). Approval workflows beyond that standing block are deferred. (4) *Fulfillment through F-48,* mirroring R-133: optional request allocations on the payment, judged inside its transaction under its lock — same vendor and company, the payment's indicator equal to the request's target, one currency, the allocation defaulting to the lesser of the payment's unallocated part and the remainder and never above it. The vendor fulfillment table links each allocation to the request and to the payment's debit line on the alternative account under composite foreign keys; fulfilled and remaining amounts derive from its ACTIVE rows and the stored status advances atomically. (5) *History is append-only:* fulfillment rows are never deleted; reset and reversal create compensating status, as on the customer side.

**Deferred by name:** request closure and reversal workflows with their fulfillment resolution, payment approval workflows, the purchase-order reference (absent from the package's field matrix, as in R-129), foreign-currency fulfillment, drafts, duplicate-reference rules beyond the standing width, and request reporting beyond the screen's open-request list. Stage order: 1 the `/finance/vendor-down-payment-request` screen → 2 schema (vendor request + fulfillment tables, migration) → 3 services (request lifecycle, F-48 fulfillment) and screen wiring → 4 supporting (capability, term, number-range object) → 5 tests and browser acceptance. Same-stage bookkeeping: B-552 / §26.568 / §30 row 2.386.

## §26.569 — SCR-086 stage 1: the vendor down-payment request screen

**B-553.** Stage 1 of R-134. The `/finance/vendor-down-payment-request` screen stands as a shell mirroring its customer twin: the request form (company, vendor, document/posting/due dates, amount, currency, request indicator, document type KA by default, reference) with the noted-item explanation, and the open-requests grid rendered empty. Posting stands disabled until the service lands in stage 3; no reads or writes stand yet. A stub module carries the capability `FIN.AP.DOWNPAYMENT.REQUEST` and the request vocabulary. Same-stage bookkeeping: B-553 / §26.569 / §30 row 2.387.

## §26.570 — SCR-086 stage 2: vendor request and fulfillment schema

**B-554.** Stage 2 of R-134. `vendor_down_payment_request` carries the vendor noted item in the house record pattern (drawn number, derived fiscal year, due date distinct from both document dates, reserved lifecycle statuses under check), and `vendor_dp_request_fulfillment` links each fulfillment to its request and to the actual F-48 journal line under composite foreign keys, its ACTIVE rows the derivation source (migration `0096_vendor_down_payment_request.sql`, applied; **159 migrations**). The special G/L target column from SCR-085 already serves the AP side, so no configuration change is needed. No journal table is touched. Typecheck clean. Same-stage bookkeeping: B-554 / §26.570 / §30 row 2.388.

## §26.571 — SCR-086 stage 3: vendor request service, F-48 fulfillment, wired screens

**B-555.** Stage 3 of R-134. `createVendorDownPaymentRequest` judges the vendor's extension (the payment block deliberately not judged — it is a disbursement control), resolves the AP request indicator to its configured target, validates the entered KA document type against the tenant's configured types and the posting period for the vendor account type, draws the VENDDPREQ number, and writes the noted item with no journal. `applyVendorRequestFulfillment` runs inside the F-48 payment's transaction under its lock — request re-read for update, vendor, company, target indicator and currency judged, the allocation defaulting to the lesser of the payment's unallocated part and the remainder — linking the payment's debit line on the alternative account while the status advances. Both screens are live, and the payment form gained its optional request and fulfill-amount fields. Neighbouring down-payment suites (9 tests) stand green. Typecheck clean. Same-stage bookkeeping: B-555 / §26.571 / §30 row 2.389.

## §26.572 — SCR-086 stage 4: vendor request capability and number-range object

**B-556.** Stage 4 of R-134. The capability `FIN.AP.DOWNPAYMENT.REQUEST` (F-47 as search alias) joins the seed with its full-parity term — **119 capabilities / 68 config activities / 93 terms / 102 aliases**. `VENDDPREQ` joins the number-range object catalogue, the object roster and the tenant builder's default ranges (prefix VR), as CUSTDPREQ did for customers; standing tenants define the interval in number-range maintenance. The AP request indicators reuse the SCR-085 special G/L target column, so no further configuration work stands. Typecheck clean. Same-stage bookkeeping: B-556 / §26.572 / §30 row 2.390.

## §26.573 — SCR-086 acceptance and closure

**B-557 — SCR-086 CLOSED with browser acceptance.** Targeted suite 3/3 (refusals by name; the noted item posting with zero journals — a blocked vendor's request standing while its F-48 payment is refused; F-48 fulfillment deriving PARTIAL then FULFILLED with over-fulfillment and wrong-indicator payments refused), **full suite 1368 green** (1364 + 3 SCR-086 + 1 fixture); browser **T910 green** against the production build (DB cairn_b210:5432): indicator F stood configured with target A, request VR-0000001 posted through the form, a 4,000 payment fulfilled it in part, and the database remembered the ACTIVE 4000.0000 link, the PARTIAL standing, and exactly one journal in the tenant — the payment's. Seed twice idempotent at 119 capabilities / 93 terms; the database stands at 159 migrations. Both advance chains now run complete: vendor F-47 → F-48 → F-54 and customer F-37 → F-29 → F-39. Deferred by name from R-134: request closure and reversal workflows with their fulfillment resolution, payment approvals, the purchase-order reference, foreign-currency fulfillment, drafts and request reporting beyond the open-request list. **Next: T-code FV50 — park a journal entry** (FIN.JOURNAL.PARK, the first standing Roadmap item in the finance core: a parked document stands complete but unposted, outside every balance, until it is posted or deleted by its own act); the owner's package is requested. (Correction recorded at closure: FBRA was first named here in error — reset cleared items already stands implemented as FIN.CLEARING.RESET, and the clearing rounds' deferral was only ever of dependency handling beyond it.)

## §26.574 — SCR-087 contract R-135: park a journal entry (FV50)

**Standing instruction recorded (owner, 2026-10-19):** every completion report now names the next **two** T-codes in order — the next round and the one after it — so packages can be prepared ahead. This applies from the SCR-086 closure onward.

The owner supplied the FV50 field package (2026-10-19); SAP codes stand as search aliases only. **The package's central principle is accepted in full:** parking stores a preliminary document in dedicated staging tables without touching posted balances; the accounting engine remains the sole authority when the parked document is finally posted, and the parked record is retained afterwards as an immutable reference to the canonical document.

**Contract decisions.** (1) *Staging, house-shaped:* `parked_journal_header` and `parked_journal_line` adapted to house scope and widths (client, audit columns); the package's separate audit table is **declined** — the standing change documents carry the append-only audit with actor and reason, and the header additionally stamps who completed, posted or deleted and when. No foreign key ties the parked header to the journal: before posting there is nothing to point at. (2) *Number identity:* the parked document draws its own number from a new `PARKDOC` number-range object (catalogue, roster, tenant defaults; prefix PK). Posted numbers continue to come from the posting engine's ranges, so parked and posted numbers differ and the header retains the posted reference explicitly, exactly as the package permits. (3) *Completeness is a judged transition, not a save mode:* while PARKED a document may stand incomplete and unbalanced — but any supplied G/L account must exist, any supplied amount must be positive, and edits are version-checked (the expected version must match, and every edit returns a COMPLETED document to PARKED for re-judging). Save-as-complete runs the completeness gate: every line complete, accounts standing, supplied cost/profit centres and tax codes standing, debits equal credits. Final posting revalidates everything through the posting engine — period, document type (SA is configuration, validated like any type, never assumed), balance — in one transaction under the header's row lock, so a retry can never post twice. (4) *Authorisation stands apart per act:* parking and editing take `FIN.JOURNAL.PARK`; posting a parked document additionally takes the standing `FIN.JOURNAL.POST` at the screen, so the parker need not be the poster. Deletion is a logical status with a mandatory reason, never a physical delete. (5) *The assignment field* is carried on the parked line and retained on the parked record; the house journal line has no assignment column, so it is not carried into the posted document — recorded here rather than silently dropped. Document-currency amounts post through the engine as every house document does; exchange-rate derivation stands with the deferred foreign-currency work.

**Deferred by name:** approval and rejection workflow (COMPLETED stands ready without it; REJECTED is reserved in the status constraint), workflow routing by amount or type, foreign-currency conversion and parallel currencies, parked-document reports beyond the screen's list, and reversal of the posted document beyond the standing FB08-equivalent reversal. Stage order: 1 the `/finance/journal/park` screen → 2 schema (staging tables, migration) → 3 service (lifecycle + atomic posting) and screen wiring → 4 supporting (capability, term, number-range object) → 5 tests and browser acceptance. Same-stage bookkeeping: B-558 / §26.574 / §30 row 2.392.

## §26.575 — SCR-087 stage 1: the park-a-journal screen

**B-559.** Stage 1 of R-135. The `/finance/journal/park` screen stands as a shell: the parking form (header data and the line grid with cost/profit centre, tax code, assignment and line text, debits, credits and difference totalled live with the unbalanced-parking note) and the parked-documents list with status and posted-as reference, rendered empty. Parking stands disabled until the service lands in stage 3; no reads or writes stand yet. A stub module carries the capability `FIN.JOURNAL.PARK` and the parked-document vocabulary. Same-stage bookkeeping: B-559 / §26.575 / §30 row 2.393.

## §26.576 — SCR-087 stage 2: parked journal staging schema

**B-560.** Stage 2 of R-135. `parked_journal_header` carries the preliminary document (drawn number, derived fiscal year, status under check with REJECTED reserved, optimistic version, the posted reference consistent by check once POSTED) and `parked_journal_line` its staged lines under a composite foreign key to the header, positive amounts and S/H sides under check, the assignment retained on the parked record (migration `0097_parked_journal.sql`, applied; **160 migrations**). No journal table is touched and no foreign key points at one — before posting there is nothing to point at. Typecheck clean. Same-stage bookkeeping: B-560 / §26.576 / §30 row 2.394.

## §26.577 — SCR-087 stage 3: parked-journal service and wired screen

**B-561.** Stage 3 of R-135. The service carries the whole lifecycle: park (supplied accounts judged standing, amounts positive, document type configured, PARKDOC number drawn, replay by request key), version-checked edit (a stale version refused by name; any edit returns the document to PARKED), save-as-complete (the completeness gate — type, accounts, supplied cost/profit centres and tax codes standing, debits equal credits), atomic posting (completeness re-judged, then the posting engine posts under the header's row lock and the parked record stamps its canonical reference; posting a POSTED document returns it unchanged), and logical deletion with a mandatory reason. The screen is live through four server actions: park/edit with the serialised line grid, and per-row save-as-complete, post and delete in the parked list; posting additionally takes the standing journal-posting capability at the action, apart from parking. Typecheck clean. Same-stage bookkeeping: B-561 / §26.577 / §30 row 2.395.

## §26.578 — SCR-087 stage 4: parking capability and number-range object

**B-562.** Stage 4 of R-135. The capability `FIN.JOURNAL.PARK` (FV50 as search alias) joins the seed with its full-parity term — **120 capabilities / 68 config activities / 94 terms / 103 aliases**. `PARKDOC` joins the number-range object catalogue, the object roster and the tenant builder's default ranges (prefix PK), so new tenants draw parked numbers from birth and standing tenants define the interval in number-range maintenance. Typecheck clean. Same-stage bookkeeping: B-562 / §26.578 / §30 row 2.396.

## §26.579 — SCR-087 closed: FV50 park a journal entry accepted

**B-563. SCR-087 is CLOSED.** The FV50 package is delivered at full parity under R-135. A G/L document parks into dedicated staging tables under its own drawn number (PARKDOC, prefix PK) without moving any account; while PARKED it may stand incomplete and unbalanced, with supplied accounts judged standing and supplied amounts positive. Save-as-complete is a judged transition — document type configured, every line's account and supplied cost/profit centre and tax code standing, debits equal credits — and any edit, guarded by the optimistic version, returns a completed document to PARKED for re-judging. Posting revalidates everything and converts atomically through the posting engine under the header's row lock, so a retry returns the standing document rather than posting twice; the parked record is then retained, naming its canonical document, and deletion of a posted document is refused towards reversal. Deletion otherwise is a reasoned logical status, never a row delete. Posting additionally takes the standing journal-posting capability at the screen, apart from parking.

Acceptance evidence: targeted suite 3/3 (parking with zero journals and request-key replay, unknown-account refusal, stale-version refusal, unbalanced completion refused, atomic posting with the posted reference retained, no double posting, reasoned deletion); full suite **1372 green**; browser **T909 green** against the production build (tenant T909: parked PK- number with no journal behind it, judged COMPLETED, posted as a balanced document through the engine, the parked record standing POSTED with its reference). Seed twice idempotent at **120 capabilities / 68 config activities / 94 terms / 103 aliases**; database at **160 migrations**. Environment note: a typecheck starved alongside the production server in this 2 GB sandbox — the server stands stopped for builds and typechecks, per the standing repair notes. Deferred by name (R-135): approval and rejection workflow, workflow routing, foreign-currency conversion and parallel currencies, parked-document reporting beyond the screen's list. Same-stage bookkeeping: B-563 / §26.579 / §30 row 2.397. `FUNCTIONS-AND-ROADMAP.md` moved FV50 to Implemented in the same turn.

## §26.580 — SCR-088 contract R-136: G/L line item report (FAGLL03)

The owner supplied the FAGLL03 field package (2026-10-19); SAP codes stand as search aliases only. **The package's central principle is accepted in full:** a strictly read-only line-item report over the canonical journal, tenant taken from the session and never from the client, reporting indexes on the standing tables rather than a duplicate reporting ledger, a server-enforced hit cap with an explicit truncation indicator, subtotals never combining unlike currencies, and closed periods remaining displayable because period locks govern posting, not inquiry.

**Contract decisions.** (1) *House shape of the ledger:* the canonical keys are the journal's own — document number and fiscal year on header and line, the line additionally carrying company code — and the join follows them exactly. Amounts display in document and local currency as stored; there is no parallel currency to show. (2) *Three package filters are declined by name, not silently dropped:* the ledger filter (the house keeps a single ledger; it returns with multi-ledger accounting), the assignment filter and the special-G/L filter (neither is stored on a posted journal line, so filtering on them would invent data). (3) *Open/cleared* is judged from the line's clearing document — the house clearing invariant — and only for accounts standing open-item-managed: lines on other accounts carry no status, display none, and are excluded when Open or Cleared is selected, exactly as the package directs. (4) *Selection:* G/L account from required, to optional and defaulting to from; one or more company codes, each validated standing; fiscal year, posting-date and document-date ranges, document number and type, profit centre, cost centre and reference (substring) optional; the date interval validated, with no assumption about where a fiscal year starts. (5) *Output* stands in the stable order posting date, document, line; subtotals group by company, account and currency for document amounts and by company and account for local amounts; the cap stands at 5,000 hits enforced server-side with the limit-plus-one truncation signal, and an empty result is stated as such, never confused with truncation. (6) *Drill-through* opens the standing FB03-equivalent document display on the document's own key. (7) *Indexes only:* migration 0098 adds a line index on (client, company, account, year, document, line) and a header index on (client, company, posting date, document); no table is created and nothing is mutated by reading.

**Deferred by name:** multi-ledger selection, assignment and special-G/L line filters (awaiting those fields on posted lines), saved layouts, column configuration and sorting choices, export, and keyset pagination beyond the capped page. Stage order: 1 the `/finance/journal/items` screen → 2 reporting indexes → 3 service and screen wiring → 4 supporting (capability, term) → 5 tests and browser acceptance. Same-stage bookkeeping: B-564 / §26.580 / §30 row 2.398.

## §26.581 — SCR-088 stage 1: the line-item report screen

**B-565.** Stage 1 of R-136. The `/finance/journal/items` screen stands as a shell: the selection (account range, company codes, fiscal year, posting-date boundaries, document, type, assignments, reference, hit cap and the All/Open/Cleared radio with its open-item note) and the results grid rendered empty with its no-match and truncation wordings in place. No query stands behind it yet; the Execute button judges only the capability. A stub module carries `FIN.JOURNAL.LIST` and the report vocabulary. Same-stage bookkeeping: B-565 / §26.581 / §30 row 2.399.

## §26.582 — SCR-088 stage 2: reporting indexes

**B-566.** Stage 2 of R-136. The journal header gains (client, company, posting date, document) and the journal line gains (client, company, account, year, document, line) — declared in the Drizzle definitions and applied by migration `0098_journal_item_report_indexes.sql` (**161 migrations**). Nothing else changes: the report will read the canonical tables exactly as they stand. Typecheck clean. Same-stage bookkeeping: B-566 / §26.582 / §30 row 2.400.

## §26.583 — SCR-088 stage 3: line-item query and wired screen

**B-567.** Stage 3 of R-136. `getJournalItems` reads the canonical journal in one parameterised query over the full composite join: account range with the from-account judged standing, every named company code judged configured, fiscal-year, posting- and document-date, document, type, assignment and reference filters composed independently, and open/cleared judged from the line's clearing document on open-item-managed accounts only — other accounts' lines carry no status and fall away under Open or Cleared. Results stand in stable posting-date, document, line order under the server-enforced 5,000 cap with the limit-plus-one truncation signal; subtotals group by company, account and currency over the displayed lines, local amounts kept apart by company currency. The screen executes over GET parameters, states errors with their remedies, distinguishes no-match from truncation, and drills each document into the standing FB03-equivalent display. Typecheck clean. Same-stage bookkeeping: B-567 / §26.583 / §30 row 2.401.

## §26.584 — SCR-088 stage 4: line-item report capability

**B-568.** Stage 4 of R-136. The capability `FIN.JOURNAL.LIST` (FAGLL03 as search alias) joins the seed with its full-parity term — **121 capabilities / 68 config activities / 95 terms / 104 aliases**. Typecheck clean. Same-stage bookkeeping: B-568 / §26.584 / §30 row 2.402.

## §26.585 — SCR-088 closed: FAGLL03 G/L line item report accepted

**B-569. SCR-088 is CLOSED.** The FAGLL03 package is delivered at full parity under R-136: a strictly read-only line-item report over the canonical journal, the tenant bound from the session, reporting indexes only (migration 0098) and no table of its own. The selection judges the from-account standing and every named company code configured, composes account range, fiscal year, posting- and document-date, document, type, assignment and reference filters independently, and enforces the 5,000-hit cap server-side with an explicit truncation signal distinct from an empty result. Open and cleared judge from the line's clearing document on open-item-managed accounts only; other lines carry no status and fall away under those choices. Subtotals group by company, account and currency over the displayed lines, local amounts kept apart; every document drills into the standing FB03-equivalent display; closed periods stay displayable, because reading checks no period at all. Three package filters stand declined by name in the contract — ledger (single-ledger house), assignment and special-G/L (neither stored on a posted line) — rather than simulated.

Acceptance evidence: targeted suite 3/3 (range and subtotals with judged selection and refused intervals, clearing judged both ways with non-open-item accounts excluded, cap truncation, cross-tenant emptiness); full suite **1376 green**; browser **T908 green** against the production build (tenant T908: lines and subtotals read, the cleared payables line under Cleared with its clearing document, drill-through into the document display, the journal verified untouched). One build incident: a production build started alongside the live server clobbered `.next` and the first browser attempt met the wreckage; a clean solo rebuild restored it — the standing rule (server stopped for builds) is reaffirmed in the repair notes. Seed twice idempotent at **121 capabilities / 68 config activities / 95 terms / 104 aliases**; database at **161 migrations**. Deferred by name (R-136): multi-ledger selection, assignment and special-G/L filters, saved layouts, export, keyset pagination. Same-stage bookkeeping: B-569 / §26.585 / §30 row 2.403. `FUNCTIONS-AND-ROADMAP.md` moved FAGLL03 to Implemented in the same turn.

## §26.586 — SCR-089 contract R-137: G/L account balances by period (FS10N)

The owner supplied the FS10N field package (2026-10-19); SAP codes stand as search aliases only. **The package's central corrections are accepted in full:** opening balance, period turnover and cumulative closing balance are distinct figures and stand as separate rows of one chained calculation; closed periods remain reportable because period locks govern posting, not inquiry; special-period activity is never merged silently into period 12; and unlike currencies are never combined.

**Contract decisions.** (1) *Derivation, not projection:* the house settled this at SCR-069 — balances derive at read time from the canonical journal, so no balance table stands to drift from the ledger and reconciliation holds by construction. The package's maintained projection with its reconciliation job is therefore **declined by name as a standing design**, recorded here rather than silently omitted; should journal volume ever demand it, the projection arrives as its own round with the posting engine as its single writer. (2) *The chain:* one account in one company for one fiscal year (required, interpreted by the company's configured variant); the opening balance is the signed debit-positive sum of every earlier year's posted lines; each period's debit and credit turnover sums its posted lines by the document's stored posting period; net change and cumulative closing chain period by period. Only documents standing POSTED count, exactly as the customer and vendor balances judge. (3) *Special periods* appear as their own periods 13 onward only when the caller includes them and the company's variant configures them, and drill by stored period, never by calendar date. (4) *Currency view* mirrors SCR-069: the company currency shows local amounts; a single document currency the account's lines carry shows document amounts; anything else is refused by name. The ledger selection is declined (single-ledger house, returning with multi-ledger). (5) *Drill-through* opens the FAGLL03 line items for the account, company, year and period — which requires the line-item report to accept a posting-period filter, added under this contract as a supporting change to SCR-088's surface; the opening balance carries no drill, as no carryforward process stands to detail. (6) The account is judged standing in the tenant and, where the company names its chart, in that chart; the report reads, and mutates nothing.

**Deferred by name:** the maintained balance projection and reconciliation job, multi-ledger balances, a document-currency balance view spanning mixed currencies, opening-balance/carryforward detail, and export. Stage order: 1 the `/finance/journal/balances` screen → 2 derivation service's schema needs (none new — the SCR-088 indexes serve) recorded as an index review → 3 service, the line-item period filter, and screen wiring → 4 supporting (capability, term) → 5 tests and browser acceptance. Same-stage bookkeeping: B-570 / §26.586 / §30 row 2.404.

## §26.587 — SCR-089 stage 1: the account balances screen

**B-571.** Stage 1 of R-137. The `/finance/journal/balances` screen stands as a shell: the selection (account, company, fiscal year, currency, the special-periods inclusion) and the annual grid — opening, debit and credit turnover, net change, closing, item count and the line-item drill per period — rendered empty. No derivation stands behind it yet. A stub module carries `FIN.GL.BALANCE` and the balance vocabulary. Same-stage bookkeeping: B-571 / §26.587 / §30 row 2.405.

## §26.588 — SCR-089 stage 2: index review, no schema change

**B-572.** Stage 2 of R-137. The derivation reads lines by (client, company, account) across years and joins headers by their primary key; the SCR-088 line index `jel_company_account_idx` on (client, company_code, gl_account, fiscal_year, document_number, line_number) serves both the prior-year opening sum and the selected year's per-period turnover without a further index. No migration stands in this stage — recorded as a reviewed decision rather than passed over silently. Same-stage bookkeeping: B-572 / §26.588 / §30 row 2.406.

## §26.589 — SCR-089 stage 3: balance derivation, period filter, wired screen

**B-573.** Stage 3 of R-137. `getGlBalances` judges the company configured, the account standing and — where the company names its chart — standing in that chart, then derives in one pass over the account's POSTED lines: opening as the signed sum of every earlier year, turnover by stored posting period, net change and cumulative closing chained, special periods appended only when included and configured on the company's variant. The currency view mirrors SCR-069: company currency shows local amounts, a single carried document currency shows document amounts, anything else is refused by name rather than converted. As a supporting change under this contract, the FAGLL03 report now accepts a posting-period filter, so each period's drill lands on exactly its lines, specials included. The screen executes over GET parameters and states errors with their remedies. Typecheck clean. Same-stage bookkeeping: B-573 / §26.589 / §30 row 2.407.

## §26.590 — SCR-089 stage 4: balance capability

**B-574.** Stage 4 of R-137. The capability `FIN.GL.BALANCE` (FS10N as search alias) joins the seed with its full-parity term — **122 capabilities / 68 config activities / 96 terms / 105 aliases**. Typecheck clean. Same-stage bookkeeping: B-574 / §26.590 / §30 row 2.408.

## §26.591 — SCR-089 closed: FS10N G/L account balances accepted

**B-575. SCR-089 is CLOSED.** The FS10N package is delivered at full parity under R-137 on the SCR-069 precedent: balances derive at read time from the canonical journal, so no projection stands to drift and reconciliation holds by construction. Opening, turnover and closing stand as distinct chained figures — the opening is every earlier year's signed sum and never period 1 turnover; debit and credit turnover sum by the document's stored posting period; closing chains opening plus cumulative net change. Special periods stand apart, only when included and configured on the company's variant, and drill — like every period — by stored period into the FAGLL03 report, which gained the posting-period filter under this contract. The currency view refuses what it cannot display without conversion; the account is judged standing and, where the company names its chart, standing in that chart; the ledger selection and the maintained-projection design stand declined by name in the contract.

**One gap found and named, not hidden:** the posting engine has no special-period entry path — a December date derives period 12 and the engine demands the specified period equal the derived one — so a document can only stand in period 13 or beyond if a future round teaches the engine to post there. The balances and the drill already read stored special periods correctly, proven against a directly stored period-13 document in both the test suite and the browser; **special-period posting is deferred by name** to its own round, alongside the other R-137 deferrals (the maintained projection, multi-ledger balances, mixed document-currency views, carryforward detail, export).

Acceptance evidence: targeted suite 3/3 (the chain with opening judged against period 1, specials apart with period drill, refused accounts and currencies); full suite **1380 green**; browser **T907 green** against the production build (tenant T907: opening 1,000.00 chained to closing, special 13 separate at 1,350.00, period-3 drill onto its line items, journal untouched). Seed twice idempotent at **122 capabilities / 68 config activities / 96 terms / 105 aliases**; database at **161 migrations** (this round added none, by reviewed decision). Same-stage bookkeeping: B-575 / §26.591 / §30 row 2.409. `FUNCTIONS-AND-ROADMAP.md` moved FS10N to Implemented in the same turn.

## §26.592 — SCR-090 contract R-138: FB03 document display completed, with flow

The owner supplied the FB03 architectural review (2026-10-19); SAP codes stand as search aliases only. This round delivers the roadmap's FIN.DOC.FLOW as the completion of the standing FB03-equivalent display: **the package's central principle is accepted in full** — a faithful, read-only window into the canonical posted document, retrieved by its complete key, with reversal and related-document navigation, stored amounts never recalculated, historical documents displayable regardless of period closure, and parked documents treated as the distinct lifecycle they are. The standing display is reworked where it falls short of that standard: today it resolves a bare document number (limit 1, any year), shows a partial header, totals nothing, and links nowhere.

**Contract decisions.** (1) *Composite-key retrieval:* document number, company code and fiscal year are supplied and resolved exactly; the fiscal year is never derived or silently replaced. The house document identity is (tenant, number, year) — company stands as a validated attribute rather than a key part, and that divergence from the package's key sketch is recorded here, not hidden: a company mismatch answers "not found within the authorized scope", disclosing nothing. Bare-number links from other screens keep working by resolving the unique document or refusing ambiguity by name. (2) *The complete document:* full header (type, dates, period, currencies with the stored exchange rate, reference, header text, status, origin, posted by and at), every line in stable line-number order with all assignments, tax code and clearing state, and debit/credit totals judged independently in document and local currency — both stored views side by side, so the package's display-currency preference is declined by name as unnecessary. (3) *Flow:* reversal references navigate both ways; line clearing documents link to their own display; the origin names its source (the parked document links back to its parking screen); previous/next navigation walks documents within company and year; the retained change history for the document displays beneath. Reversal is never performed here. (4) *Parked distinction:* this display covers posted documents including REVERSED originals; a parked number answers that it stands parked in its own lifecycle and links to FV50 — never conflated with the ledger. (5) *No schema change:* the journal primary keys already are the lookup the package indexes for; stage 2 records that verification rather than adding a redundant index. Reading mutates nothing, checks no posting period, and takes the tenant from the session alone.

**Deferred by name:** per-company-code authorization grants beyond the session and capability (the house has none to check), attachments, saved display variants and document comparison, tax-detail drill beyond the stored tax code, and subledger detail screens beyond the links that already exist. Stage order: 1 the reworked display screen → 2 key/index verification → 3 document service and wiring → 4 supporting (FIN.DOC.FLOW capability and term) → 5 tests and browser acceptance. Same-stage bookkeeping: B-576 / §26.592 / §30 row 2.410.

## §26.593 — SCR-090 stage 1: the document display screen

**B-577.** Stage 1 of R-138. A dedicated `/finance/journal/document` screen stands as a shell beside the untouched document list: the composite-key lookup (number, company, fiscal year) with its not-found and stands-parked outcomes worded, and the document sections — full header, line grid with every assignment, per-currency totals, document flow and change history — rendered empty. No retrieval stands behind it yet. A stub module carries `FIN.DOC.FLOW` and the display vocabulary. Same-stage bookkeeping: B-577 / §26.593 / §30 row 2.411.

## §26.594 — SCR-090 stage 2: key verification, no index added

**B-578.** Stage 2 of R-138. Verified against the live database rather than assumed: `journal_entry` stands primary-keyed on (client, document_number, fiscal_year) and `journal_entry_line` on (client, document_number, fiscal_year, line_number) — precisely the composite lookup and stable line ordering the review prescribes, so the recommended index would duplicate the primary key and is **not** created. Company-code validation rides on the retrieved header, per the contract's recorded key divergence. No migration stands in this stage. Same-stage bookkeeping: B-578 / §26.594 / §30 row 2.412.

## §26.595 — SCR-090 stage 3: document retrieval, flow and wired display

**B-579.** Stage 3 of R-138. `getJournalDocument` retrieves by the complete supplied key — a company mismatch answers not-found-in-scope, disclosing nothing — and composes the whole document: full header with stored rate and origin, lines in stable order with every assignment and clearing state, totals judged independently in document and local currency, flow links walking the reversal chain both ways, the origin (a parked document links back to its parking screen), each line's clearing document, and previous/next navigation within company and year — plus the retained change history for `documentNumber/fiscalYear`. A parked number answers as its own lifecycle with its FV50 link. Bare-number links from older screens resolve uniquely or refuse ambiguity by name, and the FAGLL03 drill now lands on this composite display. Reversal is displayed, never performed here. Typecheck clean. Same-stage bookkeeping: B-579 / §26.595 / §30 row 2.413.

## §26.596 — SCR-090 stage 4: document flow capability

**B-580.** Stage 4 of R-138. The capability `FIN.DOC.FLOW` joins the seed with its full-parity term — **123 capabilities / 68 config activities / 97 terms / 105 aliases**. Typecheck clean. Same-stage bookkeeping: B-580 / §26.596 / §30 row 2.414.

## §26.597 — SCR-090 closed: FB03 document display and flow accepted

**B-581. SCR-090 is CLOSED.** The FB03 review package is delivered at full parity under R-138 at a dedicated `/finance/journal/document` display beside the untouched document list. Retrieval takes the complete supplied key — number, company, fiscal year, the year never derived or replaced; a company mismatch answers not-found-in-scope and discloses nothing; bare-number links resolve uniquely or refuse ambiguity by name. The display carries the full header with the stored exchange rate and origin, every line in stable order with all assignments, tax code and clearing state, totals judged independently in document and local currency, flow walking the reversal chain both ways, the origin (a parked document links back to its parking screen), each line's clearing document and previous/next navigation within company and year — and the retained change history beneath. A parked number answers as its own lifecycle with its FV50 link, never conflated with the ledger; reversal is displayed and never performed here; a closed period displays like any other, because reading checks none. The house key divergence (company as validated attribute rather than key part) stands recorded in the contract; the prescribed index stands verified as the existing primary key and was not duplicated (stage 2). The FAGLL03 drill now lands on this display.

Acceptance evidence: targeted suite 3/3 (composite retrieval with silent scope mismatches, reversal chain walked both ways with the retained REVERSE history, parked answered as parked, previous/next and bare-number resolution); full suite **1384 green**; browser **T906 green** against the production build (tenant T906: REVERSED original with reference and per-currency totals, flow to the reversal and back, REVERSE history read, journal count unchanged). Environment note: the sandbox wipe took Chromium and its system libraries mid-round; both were restored and the run re-verified. Seed twice idempotent at **123 capabilities / 68 config activities / 97 terms / 105 aliases**; database at **161 migrations** (none added, by verified decision). Deferred by name (R-138): per-company authorization grants, attachments, display variants, tax-detail drill beyond the stored code. Same-stage bookkeeping: B-581 / §26.597 / §30 row 2.415. `FUNCTIONS-AND-ROADMAP.md` moved FIN.DOC.FLOW to Implemented in the same turn.

## §26.598 — SCR-091 contract R-139: asset master creation and change (AS01 / AS02)

The owner supplied the AS01/AS02 implementation package (2026-10-19); SAP codes stand as search aliases only. **Inspection first, as directed:** no asset machinery stands in the house at all — no asset master, class, depreciation area or key, no asset number range — so this round lays that foundation on the canonical pieces that do stand (tenants, company codes, cost/profit centres, number ranges, change documents), creating no parallel systems. Master data only: AS01/AS02 post nothing, retire nothing, and depreciate nothing; acquisition (ABZON), the depreciation run (AFAB) and retirement (ABAVN) follow as their own rounds, and asset values therefore carry no posted history to protect yet — a fact the change rules state rather than assume away.

**Contract decisions.** (1) *Configuration:* `asset_class` (numbering policy INTERNAL or EXTERNAL, quantity management, active), `depreciation_area` and `depreciation_key` stand as tenant configuration; the standard package delivers area 01 (book depreciation), straight-line and declining-balance keys, and machinery/vehicle/building classes so a new tenant creates assets from birth, every default overridable as tenant data. The asset-class row is the screen-layout authority the package demands: it governs numbering, quantity requirement and the depreciation defaults the form pre-fills — judged again server-side, never trusted from the client. (2) *Master:* `fixed_asset` under the complete key (tenant, company, main number, sub-number 0000 default), descriptions at contract widths, inventory number unique within company when supplied (partial unique index), quantity/unit, capitalization and deactivation dates, lifecycle status, optimistic version. Time-dependent assignments stand in `asset_assignment` under [validFrom, validTo) intervals with the composite asset key, overlap judged transactionally under the asset's lock and history never rewritten; depreciation parameters stand per area in `asset_depreciation`, useful life as years and periods separately under positive-range checks. (3) *Numbering:* internal numbers draw from a new `ASSETNR` range object per company; external numbers are validated unused; a count of similar assets creates distinct mains — never sub-numbers — atomically, the whole batch rolling back on any failure; sub-number creation requires its main to stand. (4) *Change (AS02):* identity, company and class immutable; descriptions, inventory fields and quantity change under version check; assignment changes append intervals (closing the open one) so history stays queryable; depreciation-key and life changes are prospective and audited, touching no posted value; deactivation is a status with a date, never a retirement; physical deletion is not offered at all this round. Every write records change documents with actor and before/after on the standing audit trail.

**Deferred by name:** acquisition, transfer, retirement and depreciation posting; depreciation recalculation on parameter change beyond prospective effect (no depreciation engine stands yet); asset-class reclassification workflow; asset transactions/balances/history-sheet; configuration screens for classes, areas and keys (the tables and delivered defaults stand; maintenance screens follow with the asset-accounting configuration round); physical deletion and archiving. Stage order: 1 the tabbed `/finance/assets` screens (create, list, change) → 2 schema (asset configuration, master, assignments, depreciation parameters; migration) + delivered standard defaults → 3 service (create incl. batch and sub-numbers, change, deactivation) and screen wiring → 4 supporting (capabilities, terms, ASSETNR range) → 5 tests and browser acceptance. Same-stage bookkeeping: B-582 / §26.598 / §30 row 2.416.

## §26.599 — SCR-091 stage 1: the asset screens

**B-583.** Stage 1 of R-139. The tabbed AS01 creation screen (General, Time-dependent assignments, Depreciation areas) stands at `/finance/assets/new` with the complete field matrix — company, class, similar-asset count, external number and sub-number, descriptions at contract widths, inventory and serial, quantity/unit, capitalization, the interval-worded assignment tab and dynamic depreciation-area rows — and the AS02 list/change entry at `/finance/assets`, both inert. A stub module carries `FIN.ASSET.CREATE` / `FIN.ASSET.CHANGE` and the asset vocabulary. Same-stage bookkeeping: B-583 / §26.599 / §30 row 2.417.

## §26.600 — SCR-091 stage 2: asset schema and delivered defaults

**B-584.** Stage 2 of R-139. Six tables stand under migration `0099_asset_master.sql` (**162 migrations**): `asset_class`, `depreciation_area` and `depreciation_key` as tenant configuration; `fixed_asset` under the complete key (tenant, company, main, sub) with a partial unique index on supplied inventory numbers; `asset_assignment` as [validFrom, validTo) intervals under a composite foreign key with the interval under check; `asset_depreciation` per area with useful-life checks (years ≥ 0, periods 0–11, combined life positive). The standard package now delivers area 01, straight-line and declining-balance keys, and machinery/vehicle/building classes to every new tenant, overridable as tenant data. Typecheck clean. Same-stage bookkeeping: B-584 / §26.600 / §30 row 2.418.

## §26.601 — SCR-091 stage 3: asset service and wired screens

**B-585.** Stage 3 of R-139. The service carries creation and change whole: company and active class judged, class numbering obeyed (internal draws from ASSETNR, external validates the supplied number unused, similar assets become distinct mains atomically and never sub-numbers, a sub-number requires its standing main), quantity judged where the class manages it, assignments and depreciation areas judged against standing cost/profit centres, plants, areas and keys, class defaults pre-filling depreciation where none is given, and inventory numbers unique per company. Change locks the asset row: identity, company and class immutable by construction, master edits version-checked, assignment changes close the open interval and append so history is preserved, depreciation changes prospective and audited, deactivation a reasoned status — never a retirement, and nothing anywhere posts. Every write lands change documents with before/after. The tabbed create form, asset list and four-section change screen are live through server actions. Typecheck clean. Same-stage bookkeeping: B-585 / §26.601 / §30 row 2.419.

## §26.602 — SCR-091 stage 4: asset capabilities and number range

**B-586.** Stage 4 of R-139. The capabilities `FIN.ASSET.CREATE` and `FIN.ASSET.CHANGE` (AS01 and AS02 as search aliases) join the seed with full-parity terms — **125 capabilities / 68 config activities / 99 terms / 107 aliases**. `ASSETNR` joins the number-range object catalogue, the object roster and the tenant builder's default ranges (prefix AS), so internally numbered classes draw from birth. Typecheck clean. Same-stage bookkeeping: B-586 / §26.602 / §30 row 2.420.

## §26.603 — SCR-091 closed: AS01/AS02 asset master accepted

**B-587. SCR-091 is CLOSED.** The AS01/AS02 package is delivered at full parity under R-139, on foundations laid this round because inspection found no asset machinery standing: tenant asset-class, depreciation-area and depreciation-key configuration (delivered defaults through the standard package), the composite-keyed asset master, [validFrom, validTo) assignment intervals with preserved history, and per-area depreciation parameters with useful life as years and periods apart (migration 0099). Creation obeys the class: internal numbers drawn per tenant from ASSETNR, external numbers validated unused, similar assets created as distinct mains atomically — including a named refusal where a batch would share one unique inventory number, a flaw the acceptance tests caught in the first service draft — sub-numbers only under a standing main, and quantity judged where the class manages it. Change is version-checked with identity, company and class immutable; assignment changes close and append intervals; depreciation changes are prospective and audited; deactivation is a reasoned status, never a retirement; nothing anywhere posts, and every write stands on the change-document audit.

Acceptance evidence: targeted suite 4/4 (numbering policies, batch atomicity, sub-number rules, named configuration refusals, stale versions, interval overlap refused with history preserved, tenant isolation, audit presence); full suite **1389 green**; browser **T905 green** against the production build (tenant T905: tabbed creation as AS-0000001, rename at version 2, assignment appended with the first interval closed, three audit documents, zero journals). Two screen defects were caught by that browser run and fixed before acceptance — tab panels unmounting their inputs on submit, and a version-keyed remount wiping the change screen's own success message. Seed twice idempotent at **125 capabilities / 68 config activities / 99 terms / 107 aliases**; database at **162 migrations**. Deferred by name (R-139): acquisition ABZON (next round), depreciation run and recalculation beyond prospective effect, retirement, reclassification workflow, asset transactions and history sheet, configuration maintenance screens, physical deletion. Same-stage bookkeeping: B-587 / §26.603 / §30 row 2.421. `FUNCTIONS-AND-ROADMAP.md` moved FIN.ASSET.CREATE to Implemented in the same turn.

## §26.604 — SCR-092 contract R-140: asset acquisition with automatic offsetting (ABZON)

The owner supplied the ABZON implementation package (2026-10-19); SAP codes stand as search aliases only. **Inspection first, as directed:** the SCR-091 asset master stands; no asset transaction model, no asset-class account determination and no asset transaction types stand, and the chart already delivers ASSETS reconciliation accounts. **The package's central design is accepted in full:** a vendor-less acquisition posted only through the canonical engine — debit the asset class's configured reconciliation account, credit the entered offsetting account — with the asset transaction as a value record linked to the accounting document, never a second ledger.

**Contract decisions.** (1) *Configuration, not constants:* `asset_class` gains its acquisition reconciliation account (the standard package wires machinery to 150000 and vehicles to 152000; a class without determination refuses by name), and `asset_transaction_type` stands as tenant configuration with a delivered acquisition type. Document type is validated as tenant configuration like every house posting; nothing assumes an example type, ledger or currency. (2) *The value record:* `asset_transaction` preserves the complete acquisition — company, asset key, document number and year, transaction type, document/posting/asset-value dates (the value date distinct and never substituted by the posting date), amount and currency, offsetting account, status ACTIVE/REVERSED with its reversal reference, and the request key under a partial unique index. Asset values derive from ACTIVE rows; no derived balance is ever written directly. (3) *Posting:* one transaction under the asset's row and advisory locks — judges replayed by request key, asset active and standing, offsetting account standing, reconciliation-free and distinct from the asset account, period derived from the posting date, then the engine posts and the transaction records in the same commit. The first acquisition sets the capitalization date when unset and fills unstated depreciation starts with the value date. (4) *Simulation* runs the identical judges and determination and persists nothing — no allocation, no record, no posting audit. (5) *Reversal* is asset-aware: a dedicated reversal reverses the journal through the engine and flips the transaction to REVERSED with its link, refusing a second reversal; the standing FB08-equivalent refuses acquisition documents towards this path, so asset values cannot be orphaned by a finance-only reversal. Multi-ledger and parallel-currency postings stand declined with the house's single-ledger design; tax on acquisition likewise awaits its configuration.

**Deferred by name:** acquisition through a vendor (F-90), investment support and grants, partial acquisition value adjustments and transaction types beyond acquisition, depreciation recalculation (no depreciation run stands), asset transfer and retirement (next-named rounds), and transaction-type configuration screens. Stage order: 1 the guided `/finance/assets/acquire` screen (entry, simulation preview, confirmation) → 2 schema (class determination column, transaction types, asset transaction record; migration) → 3 service (simulate, post, reverse), the FB08 guard, and screen wiring → 4 supporting (capability, term) → 5 tests and browser acceptance. Same-stage bookkeeping: B-588 / §26.604 / §30 row 2.422.

## §26.605 — SCR-092 stage 1: the acquisition screen

**B-589.** Stage 1 of R-140. The guided `/finance/assets/acquire` screen stands as a shell: the full field matrix (company, asset and sub-number, the three distinct dates, document type, currency, amount, offsetting account, transaction type, reference and text) and the simulation preview section, rendered empty with its asset/offsetting debit-credit table in place. Both Simulate and Post stand disabled until the service lands; a stub module carries `FIN.ASSET.ACQUIRE` and the acquisition vocabulary. Same-stage bookkeeping: B-589 / §26.605 / §30 row 2.423.

## §26.606 — SCR-092 stage 2: acquisition schema and configuration

**B-590.** Stage 2 of R-140. Migration `0100_asset_acquisition.sql` (**163 migrations**) adds the asset class's reconciliation-account determination, `asset_transaction_type` as tenant configuration (acquisition kind only, widening with its rounds), and `asset_transaction` — the value record under its complete asset-and-document key, a composite foreign key to the asset, positive amounts under check, the request key under a partial unique index. The standard package wires machinery to 150000 and vehicles to 152000 and delivers the ACQ transaction type; buildings deliberately carry no determination until configured, so the refusal path stands exercised by default data. Typecheck clean. Same-stage bookkeeping: B-590 / §26.606 / §30 row 2.424.

## §26.607 — SCR-092 stage 3: acquisition service, FB08 guard, wired screens

**B-591.** Stage 3 of R-140. Simulate and post share one judge: company configured, asset standing and active, class determination present, transaction type an active acquisition, document type configured (the standard package now delivers AA for asset acquisition), offsetting account standing, reconciliation-free and distinct from the asset account, and the asset value date carried distinctly from the posting date. Posting runs under the asset's advisory and row locks with request-key replay first, posts debit-asset/credit-offsetting through the engine, records the value transaction in the same commit, capitalizes at the value date on first acquisition and fills unstated depreciation starts. The dedicated reversal reverses the journal and flips the value record in one transaction, and the standing FB08-equivalent now refuses acquisition documents towards it, so asset values cannot be orphaned. The guided screen is live: simulate (side-effect-free), post, and the asset-aware reversal section. Typecheck clean. Same-stage bookkeeping: B-591 / §26.607 / §30 row 2.425.

## §26.608 — SCR-092 stage 4: capability, ABZON alias, navigation

**B-592.** Seed grows by one capability (FIN.ASSET.ACQUIRE, 126 total) and by the ABZON alias term for the acquisition screen — closing the alias recheck deferred from SCR-091 (F-90): the class-2000 reconciliation default now lands through the finalized recon defaults of stage 2 (152000 for class 2000, 150000 for 1000). The asset list gains the acquire entry. Same-stage bookkeeping: B-592 / §26.608 / §30 row 2.426.

## §26.609 — SCR-092 closed: ABZON asset acquisition accepted (R-140)

**B-593. SCR-092 is closed.** ABZON acquisition stands production-grade: vendor-less posting only through the canonical engine (debit the class reconciliation account, credit the entered offsetting account), simulation running the identical judges and persisting nothing, request-key idempotent posting under the asset's locks, first acquisition capitalizing at the asset value date, and an asset-aware reversal while the standing FB08-equivalent refuses acquisition documents so values cannot be orphaned. Acceptance: `tests/asset-acquisition.test.ts` 6/6 (journal shape with no vendor line, totals from ACTIVE rows, replay, named refusals incl. the undetermined class 3000, closed period, reversal plus FB08 guard, audit CREATE/REVERSE); full suite **1396 passed**; production build green; browser target `asset-acquisition` **T904 passed** (create → simulate writes nothing → post `1000/2026/1` → asset-aware reversal, all verified in the database), and `asset-master` T905 re-passed. Two latent defects surfaced and were fixed in this round: SCR-091's tab panels combined `hidden` with a display utility (B-157 guard) — panels now wrap the grid inside the hidden element — and React 19's form-action reset wiped uncontrolled entry fields between Simulate and Post, so the acquisition entry is now controlled. Deferred by name (R-140): acquisition through vendor (F-90), investment support/grants, partial value adjustments, transaction types beyond acquisition, depreciation recalculation, transfer/retirement, transaction-type configuration screens. Next per the roadmap: FIN.ASSET.RETIRE (ABAVN), then FIN.ASSET.DEPRECIATE (AFAB). Same-stage bookkeeping: B-593 / §26.609 / §30 row 2.427.

## §26.610 — SCR-093 contract: ABAVN asset retirement by scrapping (R-141)

**B-594.** Owner package of 2026-10-19 (SAP codes aliases only). Inspection finding: the asset value model of SCR-092 stands (ACTIVE `asset_transaction` rows are the acquisition authority; the journal is the financial authority), but **no depreciation run or depreciation posting stands** — that is FIN.ASSET.DEPRECIATE (AFAB), the next round but one. Accumulated depreciation therefore stands at zero against every asset today, and retirement mathematics is built proportionally so the depreciation round plugs into the same value records without rework. Retirement needs account determination the chart does not yet carry per class.

R-141 decisions:
1. **Account determination per asset class**: `asset_class.accum_depr_account` and `asset_class.retirement_loss_account` join `recon_account`. The standard package delivers a new chart account `590000` Loss on asset retirement and wires class 1000 → accum `150100` / loss `590000`, class 2000 → accum `152100` / loss `590000`; class 3000 stays deliberately undetermined and refuses by name. No account number is hardcoded in the posting service.
2. **Value records**: a new `asset_retirement` value record (one per asset posting, linked by the canonical document identity) carries scope (COMPLETE / PERCENT / AMOUNT), the requested percentage or amount, retired acquisition value, accumulated depreciation reversed, net-book-value loss, the three dates, status ACTIVE/REVERSED, reversal link and the request key. Asset values always derive: acquired = Σ ACTIVE acquisitions, retired = Σ ACTIVE retirements, remaining = acquired − retired. `fixed_asset.status` gains `RETIRED` by migration; the check vocabulary of `asset_transaction_type.kind` gains `RETIREMENT`, and the delivered type is `RET` (Retirement by scrapping, no proceeds) — tenant configuration, never an assumed `210`.
3. **Retirement basis, unambiguous**: PERCENT takes a percentage of the *remaining* retireable acquisition value; AMOUNT names an *acquisition-value* amount to retire (never net book value), bounded by the remaining value. Accumulated depreciation reversed is the proportional share of posted accumulated depreciation (complete retirement takes all of it, deterministically, with no rounding residue); loss = retired acquisition − depreciation reversed. Posted accumulated depreciation reads through one helper that sums depreciation value records — zero until the depreciation run stands, which the simulation states openly.
4. **Posting shape** (engine only): credit the class reconciliation account with the retired acquisition value; debit accumulated depreciation (when it stands above zero) and debit the retirement loss account with the loss; zero lines are omitted; no proceeds, receivable or payable ever arises from scrapping. Complete retirement sets the asset `RETIRED` with the value date as its deactivation date; partial retirement leaves the asset ACTIVE. Reversal is asset-aware (the FB08-equivalent also refuses retirement documents), flips the value record, and restores `ACTIVE` when a complete retirement is reversed.
5. Held as in SCR-092: simulation runs the identical judges and persists nothing; posting is request-key idempotent under the asset's advisory and row locks with revalidation inside the commit; simulate/post/reverse are separately authorized server-side (posting and reversal also take the journal posting capability); the currency is judged against the standing acquisition currency, never trusted from the client.

Deferred by name: retirement with proceeds or a customer (ABAVN revenue variants), depreciation recalculation and the depreciation run itself (AFAB), transfers, retirement of assets under construction, mass retirement, transaction-type and account-determination configuration screens. Stage order UI → DB/schema → backend → supporting → tests/acceptance. Same-stage bookkeeping: B-594 / §26.610 / §30 row 2.428.

## §26.611 — SCR-093 stage 1: retirement screens and module vocabulary

**B-595.** Stage 1 of R-141: `asset-retirement.ts` carries the vocabulary (capability `FIN.ASSET.RETIRE`, scopes COMPLETE/percent/AMOUNT, preview/result shapes), and `/finance/assets/retire` stands as an inert guided shell with the field matrix, the percentage/amount conditional fields, and the complete-retirement warning. Buttons stay disabled until the service lands in stage 3. Same-stage bookkeeping: B-595 / §26.611 / §30 row 2.429.

## §26.612 — SCR-093 stage 2: retirement determination, value record, RETIRED state

**B-596.** Stage 2 of R-141. Migration `0101_asset_retirement.sql` (164 migrations): the asset class gains `accum_depr_account` and `retirement_loss_account`; `fixed_asset.status` gains `RETIRED`; transaction-type kinds gain `RETIREMENT`; and `asset_retirement` stands as the retirement value record (scope, basis, retired acquisition, depreciation reversed, loss, three dates, status, reversal link, request key) under composite keys and range checks. The standard package delivers chart account `590000` Loss on asset retirement, wires classes 1000/2000 determination (150100/152000-accum, 590000 loss), and delivers the `RET` retirement type. Same-stage bookkeeping: B-596 / §26.612 / §30 row 2.430.

## §26.613 — SCR-093 stage 3: retirement service, FB08 guard, wired screens

**B-597.** Stage 3 of R-141. Simulate and post share one judge: company configured, asset standing and ACTIVE (RETIRED and deactivated refused by name), full class determination (recon, accumulated depreciation, loss — each named when missing), transaction type an active retirement-without-proceeds, document type configured, and values derived from ACTIVE records with the currency judged against the standing acquisition currency. The basis is unambiguous: PERCENT of the remaining retireable acquisition value, AMOUNT as an acquisition-value amount bounded by the remainder, COMPLETE as the remainder; accumulated depreciation reverses proportionally (zero until the depreciation run stands, stated openly in the preview) and the loss is the difference. Posting runs under the asset's advisory and row locks with request-key replay first, posts credit-asset / debit-depreciation / debit-loss through the engine, records the retirement value record in the same commit, and completes the asset to RETIRED at the value date when its value is fully retired. The asset-aware reversal restores ACTIVE; the FB08-equivalent now refuses retirement documents too. The guided screen is live with an asset selection carrying derived book values, controlled entry fields (the React form-action reset lesson of SCR-092), and the complete-retirement warning. Same-stage bookkeeping: B-597 / §26.613 / §30 row 2.431.

## §26.614 — SCR-093 stage 4: capability, ABAVN alias, navigation

**B-598.** Seed grows by one capability (FIN.ASSET.RETIRE, 127 total) and by the ABAVN alias term for the retirement screen; the asset list gains the retire entry. Seeded twice, idempotent. Same-stage bookkeeping: B-598 / §26.614 / §30 row 2.432.

## §26.615 — SCR-093 closed: ABAVN retirement by scrapping accepted (R-141)

**B-599. SCR-093 is closed.** Retirement by scrapping stands production-grade on the SCR-092 foundation: values derive from ACTIVE acquisition records less ACTIVE retirement records, the write-off posts only through the canonical engine (credit the class reconciliation account; debit accumulated depreciation for its proportional share and the class loss account for the remaining book value; no proceeds, receivable or payable), and the retirement rides its document as a value record — never a second ledger. The basis is unambiguous by configuration: COMPLETE takes the remaining value, PERCENT takes a share of the remainder, AMOUNT names an acquisition-value amount bounded by the remainder; repeated partials can never retire more than stands. A value-complete retirement sets the asset RETIRED at the value date; the asset-aware reversal restores ACTIVE, and the FB08-equivalent refuses retirement documents. Acceptance: `tests/asset-retirement.test.ts` 7/7 (proportional simulation, balanced percent/amount partials, completion and refusal thereafter, request-key replay, named configuration/currency/value refusals, closed period, reversal with restored eligibility plus the FB08 guard, audit CREATE/REVERSE); full suite **1404 passed** (the standard-chart count expectation moved 74 → 75 with the delivered `590000` account); production build green; browser target `asset-retirement` **T903 passed** (create → acquire → simulate writes nothing → 25% scrapping posted `1000/2026/2` → asset-aware reversal, all verified in the database). One honest dependency stands recorded: **no depreciation has ever posted** — the depreciation run is FIN.ASSET.DEPRECIATE (AFAB) — so accumulated depreciation reversed is proportional over a posted figure that stands at zero today; the mathematics, determination and preview already carry it, and AFAB plugs into the same value records. Deferred by name (R-141): retirement with proceeds or a customer, depreciation recalculation, transfers, assets under construction, mass retirement, configuration screens for transaction types and account determination. Next per the roadmap: FIN.ASSET.DEPRECIATE (AFAB), then FIN.ASSET.REPORT (S_ALR_87011990). Same-stage bookkeeping: B-599 / §26.615 / §30 row 2.433.

## §26.616 — SCR-094 contract: AFAB depreciation run (R-142)

**B-600.** Owner package of 2026-10-19 (SAP codes aliases only). Inspection finding: depreciation parameters stand per asset and area (SCR-091: key method STRAIGHT_LINE/DECLINING_BALANCE, useful life, start date) and account determination stands per class for acquisition and retirement (SCR-092/093), but nothing has ever calculated or posted depreciation — SCR-093's retirement reverses a proportional share of *posted* depreciation that stands at zero until this round lands. This round builds the run and plugs straight into that helper.

R-142 decisions:
1. **Run model**: `asset_depreciation_run` (one execution: company, fiscal year, period, run type 1–4, test flag, posting date, document type, status SIMULATED/COMPLETED/COMPLETED_WITH_WARNINGS/FAILED, totals, restart reference, executor and timestamps) and `asset_depreciation_run_item` (one row per asset × area: calculated amount, previously posted, adjustment, determination, account assignment, item status, document reference, diagnostics). Run ids are generated UUIDs. A test run persists its run record and items as the execution log — no financial mutation: no journal, no posting record, no asset change.
2. **Posted depreciation ledger-of-record**: `asset_depreciation_posting` holds, per asset × area × fiscal year × period, the amount actually posted, its run and document. It is a value record in the SCR-092 sense (the journal stays the financial authority) and it is the source SCR-093's proportional reversal now reads. The primary key makes a duplicate period posting impossible; a repeat run updates the period row to the recalculated amount and posts only the signed adjustment.
3. **Calculation** (per asset × area, from standing configuration — nothing hardcoded): depreciable base = ACTIVE acquisitions − ACTIVE retirements; start = depreciation start date, falling back to capitalization; life from the area row. Straight-line: base / life months. Declining balance: remaining book value × 2 / life months (the house convention for the method word, the key carrying no rate). The period amount is capped at the remaining book value, assets whose start lies after the period end or whose life/value is exhausted stand SKIPPED with the reason on the item, fully retired assets never depreciate, and every amount rounds to cents deterministically. Posting groups journal lines by account and assignment (debit the class depreciation-expense account with the asset's current cost centre, credit the class accumulated-depreciation account) into one engine document per run (delivered type AF).
4. **Determination**: `asset_class.depreciation_expense_account` joins the class determination; the standard package wires 1000/2000 → `520000`. A class missing any determination fails its items by name and the live run refuses rather than posting partially — a run either commits whole or stands FAILED with the reason recorded (the failed header is written after rollback, so a restart can reference it). Run types: 1 Planned and 2 Repeat post; 3 Restart requires a FAILED run of the same company/period and re-executes it whole (a failed run posted nothing, so nothing can duplicate); 4 Unplanned is refused by name — it takes a separately recorded extraordinary transaction this round does not build. Live runs serialize on a per-company/period advisory lock; test runs never lock.
5. Held as before: three dates stay distinct (document date is the posting date the user confirms; the period derives from it and must equal the selected year/period), simulate = test run, authorization is separate per action (live posting and restart also take the journal posting capability), and posted documents are corrected only by reversal or a repeat adjustment — never edited.

Deferred by name: unplanned/extraordinary depreciation transactions, area-specific posting rules and parallel ledgers (every configured area calculates and posts today; the delivered package carries exactly one area), depreciation re-calculation after retroactive value changes beyond the repeat adjustment, mass simulation lists beyond the run log, background job scheduling (the run executes in the request, its log is the record). Stage order UI → DB/schema → backend → supporting → tests/acceptance. Same-stage bookkeeping: B-600 / §26.616 / §30 row 2.434.

## §26.617 — SCR-094 stage 1: depreciation run screens and vocabulary

**B-601.** Stage 1 of R-142: `asset-depreciation.ts` carries the vocabulary (capability `FIN.ASSET.DEPRECIATE`, run types 1–4, run/item statuses, run input and result shapes), and `/finance/assets/depreciate` stands as an inert shell with the run field matrix — company, year, period, run type, test flag, document type, posting date, restart and unplanned references — and the execution-log section. Buttons stay disabled until the service lands in stage 3. Same-stage bookkeeping: B-601 / §26.617 / §30 row 2.435.

## §26.618 — SCR-094 stage 2: run tables, posted-value record, expense determination

**B-602.** Stage 2 of R-142. Migration `0102_asset_depreciation_run.sql` (165 migrations): `asset_depreciation_run` (execution log header with run type, test flag, status, totals, document and restart references), `asset_depreciation_run_item` (per asset × area outcome under a run-unique asset key), and `asset_depreciation_posting` (posted amount per asset × area × year × period, keyed so a duplicate period posting is impossible) — plus `asset_class.depreciation_expense_account`, wired 1000/2000 → `520000` in the standard package. Same-stage bookkeeping: B-602 / §26.618 / §30 row 2.436.

## §26.619 — SCR-094 stage 3: run service, SCR-093 plug-in, wired screens

**B-603.** Stage 3 of R-142. One calculation serves test and live runs: per asset × area, the depreciable base derives from ACTIVE acquisitions less ACTIVE retirements, straight-line charges base/life-months, declining balance charges book value × 2/life-months, capped at the remaining book value, with start dates, elapsed life, already-posted periods and retired/deactivated assets standing as named item outcomes. A live run refuses whole on any failed determination (nothing posts partially; the FAILED header is recorded after rollback so a restart can reference it), serializes per company/period, posts one grouped engine document (debit class expense at the asset's current cost centre, credit class accumulated depreciation), and upserts the posted-depreciation records the repeat run adjusts against — and SCR-093's retirement now reads that same record for its proportional depreciation reversal, closing the dependency recorded at B-599. Run types: planned/repeat/restart execute; unplanned is refused by name toward its extraordinary-transaction round. The screen is live with controlled fields, explicit live confirmation, the execution log, recent runs and document drill-through. Same-stage bookkeeping: B-603 / §26.619 / §30 row 2.437.

## §26.620 — SCR-094 stage 4: capability, AFAB alias, navigation

**B-604.** Seed grows by one capability (FIN.ASSET.DEPRECIATE, 128 total) and by the AFAB alias term for the depreciation run screen; the asset list gains the depreciation-run entry. Seeded twice, idempotent. Same-stage bookkeeping: B-604 / §26.620 / §30 row 2.438.

## §26.621 — SCR-094 closed: AFAB depreciation run accepted (R-142)

**B-605. SCR-094 is closed.** The depreciation run stands production-grade: one calculation serves test and live runs — per asset × area, base from ACTIVE acquisitions less ACTIVE retirements effective by the period end, straight-line at base/life-months, declining balance at book value × 2/life-months, capped at remaining book value, with start dates, elapsed life, posted periods and retired or valueless assets as named item outcomes in the run log. Test runs persist only the log; live runs serialize per company/period, refuse whole on any failed determination (the FAILED header recorded after rollback, restartable by reference), post one grouped engine document (debit class expense at the asset's current assignment, credit class accumulated depreciation), and record posted depreciation per asset × area × period — the record repeat runs adjust against (a declining-balance repeat adjusts by recalculation alone, as the suite proves) and SCR-093's retirement now reads for its proportional reversal, closing the dependency recorded at B-599: retirement after a posted run reverses 50.00 of depreciation on a 50% retirement of a 12,000 asset with 100 posted, exactly as calculated. Acceptance: `tests/asset-depreciation.test.ts` 7/7; full suite **1412 passed**; production build green; browser target `asset-depreciation` **T902 passed** (create → acquire → test run mutates nothing → confirmed live run posted `1000/2026/2`, journal and posting record verified). Two platform lessons were paid for again and are now written into the screens: submitter name/value does not reach a server action (the mode travels as a controlled hidden field), and uncontrolled inputs still reset between actions. Deferred by name (R-142): unplanned/extraordinary depreciation, area-specific posting rules and parallel ledgers, retroactive recalculation beyond the repeat adjustment, background scheduling. Next per the roadmap: FIN.ASSET.REPORT (S_ALR_87011990), then the FI-AA block closes and the roadmap's next function follows. Same-stage bookkeeping: B-605 / §26.621 / §30 row 2.439.

## §26.622 — SCR-095 contract: S_ALR_87011990 asset history sheet (R-143)

**B-606.** Owner package of 2026-10-19 (SAP codes aliases only). Inspection finding: every value the sheet needs already stands in canonical records — acquisitions and retirements as ACTIVE value rows with asset value dates (SCR-092/093), posted depreciation per asset × area × period (SCR-094), and the asset master. This round creates **no balance or result table**: the sheet is a read-only aggregation over those records, and transfers stand at zero because no transfer function exists yet — the columns display, and the report says so.

R-143 decisions:
1. **Windows by asset value date**: the fiscal year's start and end derive from the company's fiscal-year variant (period windows); beginning balances take ACTIVE movements whose asset value date precedes the year, current-year movements take those inside the year up to the reporting date (default the fiscal year's last period end). REVERSED records never count, so reversals and partial retirements cannot double-count. Beginning acquisition stands net of retirements effective before the year.
2. **Depreciation by area from posted records only**: opening accumulated depreciation sums `asset_depreciation_posting` for earlier fiscal years; the year's depreciation sums the selected area's postings whose period end falls on or before the reporting date; test runs never reach the posting record and so never reach the sheet. Accumulated depreciation on retirements sums the depreciation actually reversed on ACTIVE retirement rows of the year. Ending accumulated = opening + year − on-retirements; NBV = ending acquisition − ending accumulated.
3. **Ranges and totals**: company code, asset class, asset number and subnumber accept single values or from–to ranges, all judged server-side against the tenant; subtotals stand per asset class and currency (amounts of different currencies are never added together), grand totals per currency. Sort version and display variant are accepted and honestly reported as not yet configured — the delivered layout is class → asset → subnumber.
4. **Read-only and bounded**: the report writes nothing (no run record, no audit-of-posting — the execution is a query, witnessed by the suite's unchanged journal count), paginates asset rows (default page 100), and aggregates in set-based queries per movement family, not per asset. Drill-down opens the asset display (AS03-equivalent change screen in display use) per row; the CSV export re-runs the same judged selection server-side. Indexes are added only where the report's date-bounded aggregation is not already served (migration 0103: posting-date composites on the two transaction families and a year/period composite on the posting record).
5. Authorization: the report takes its own capability (FIN.ASSET.REPORT) for display and export alike; another tenant's data is unreachable by construction of the tenant-scoped queries.

Deferred by name: transfers in/out and other movement classifications (no transfer function stands), saved layouts/sort versions and user variants, additional depreciation areas' parallel valuation (areas beyond the selected one are simply not the sheet's subject), historical reconstruction before the SCR-092 value records (the sheet reports that limitation rather than inventing opening balances), Excel formats beyond CSV. Stage order UI → DB/schema → backend → supporting → tests/acceptance. Same-stage bookkeeping: B-606 / §26.622 / §30 row 2.440.

## §26.623 — SCR-095 stage 1: history sheet screens and vocabulary

**B-607.** Stage 1 of R-143: `asset-history.ts` carries the vocabulary (capability `FIN.ASSET.REPORT`, selection ranges, sheet row and totals shapes), and `/finance/assets/history` stands as an inert shell with the selection matrix (company/class/asset ranges, fiscal year, depreciation area, reporting date, sort version, layout) and the sheet section. Buttons stay disabled until the service lands in stage 3. Same-stage bookkeeping: B-607 / §26.623 / §30 row 2.441.

## §26.624 — SCR-095 stage 2: report indexes (no new tables)

**B-608.** Stage 2 of R-143 creates no table — the contract forbids a balance store behind a read-only sheet. Migration `0103_asset_history_indexes.sql` (166 migrations) adds only the composites the date-bounded aggregation is not already served by: `(client, company_code, asset_value_date)` on both transaction families and `(client, company_code, fiscal_year, posting_period)` on the depreciation posting record; the per-asset indexes of SCR-092/093/094 already cover the drill paths. Same-stage bookkeeping: B-608 / §26.624 / §30 row 2.442.

## §26.625 — SCR-095 stage 3: aggregation service, sheet and CSV export

**B-609.** Stage 3 of R-143. `getAssetHistorySheet` judges the selection server-side (company range against the tenant, area configured, reporting date inside the selected fiscal year per company calendar), then aggregates in three set-based queries: ACTIVE acquisitions and retirements bucketed by asset value date against the fiscal-year window, and posted depreciation for the selected area bucketed by fiscal year and period end — REVERSED records never count, test runs never reach the posting record, and beginning balances stand net of earlier retirements. Rows reconcile by construction (beginning + acquisitions − retirements = ending; NBV = ending acquisition − ending depreciation), subtotals stand per class and currency, grand totals per currency, and the page paginates at 100 (cap 500). The sheet runs from a judged GET so it is bookmarkable; the CSV export re-runs the identical selection and streams every row. Drill-down opens the asset display per row. Nothing is written. Same-stage bookkeeping: B-609 / §26.625 / §30 row 2.443.

## §26.626 — SCR-095 stage 4: capability, S_ALR alias, navigation

**B-610.** Seed grows by one capability (FIN.ASSET.REPORT, 129 total) and by the S_ALR_87011990 alias term for the history sheet; the asset list gains the history entry. Seeded twice, idempotent. Same-stage bookkeeping: B-610 / §26.626 / §30 row 2.444.

## §26.627 — SCR-095 stage 5: service tests and browser target

**B-611.** Five service tests prove the sheet reconciles per asset, class and currency (beginning plus movements equals ending; NBV after depreciation), honours prior-year and mid-year reporting dates, excludes test-run depreciation and reversed retirements, filters and paginates without losing totals, exports CSV, refuses invalid selections, and mutates nothing; browser target T901 is registered and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-611 / §26.627 / §30 row 2.445.

## §26.628 — SCR-095 closure: asset history sheet (R-143 complete)

**B-612.** SCR-095 is closed. The asset history sheet (FIN.ASSET.REPORT, alias S_ALR_87011990) is accepted end to end: beginning balances stand net of earlier retirements, current-year movements and posted-only area depreciation reconcile per asset, class and currency, test runs and reversed records never count, the sheet is read-only and paginated with CSV export and drill-down, and tenant isolation holds. Evidence: bookkeeping §§26.622–26.627 (B-606–B-611), five service tests, full suite 1418, production build green, browser target T901 passing on the production build (acquire 12,000, depreciate 100, sheet shows 11,900 book value, no mutation), seed 129 capabilities / 103 terms / 111 aliases, migrations at 166. Deferred by name under R-143: asset transfers (another round), saved sort versions and layouts, parallel valuation beyond the selected area, pre-recording history by construction. Next named SCRs in order: **SCR-096 (FIN.TAX.POST / FB50)** then FIN.TAX.REPORT; their packages are awaited — no contract is drafted before the owner's fields arrive.

## §26.629 — SCR-096 contract: FB50 G/L document entry parity (R-144)

**B-613.** Owner package received 2026-10-19 for SAP FB50 (Enter G/L Account Document), the SCR-096 / FIN.TAX.POST roadmap row. **R-144 settles:** FB50 already stands as the house capability FIN.JOURNAL.POST (alias FB50, conformance A), so this round creates no parallel capability, screen or document table; it reworks the standing journal-entry screen and posting path to the supplied package. (1) Header carries Company Code, Document Date, Posting Date, Document Type, Currency, Reference (≤16) and Header Text (≤25 at the screen; canonical storage stays wider); the document type is chosen from configured types and never assumed — SA in the package is an example, and the G/L account is identified by its account number (SAKNR), never by a house-bank identifier. (2) The line grid gains Profit Center and Assignment beside G/L Account, S/H indicator, positive Amount, Cost Center and Line Text, with add/insert/copy/delete, live debit/credit/difference totals, field-level errors, account value help, posting disabled until the document is valid and balanced, and a confirmation summary before posting; after posting the document number and fiscal year show with navigation to document display. Drafts ride the standing parked-journal workflow (SCR-087) — no second draft store. (3) Canonically the journal line gains the Assignment the parked line already retains (today it is dropped at posting); no parallel gl_document tables. Constraints amount > 0 and indicator in (S,H) stand in the database as well as the engine. (4) A server service judges the whole document before the engine: company active and assigned, document type configured and active, currency the company currency (foreign-currency entry stays refused by name until exchange-rate maintenance lands — the standing behaviour, honestly kept), fiscal position and open period from the posting date, every account standing in the company's chart and unblocked, cost centre valid for company and posting date, profit centre valid for the posting date, required cost object honoured. Posting stays through the canonical engine in one transaction; a client-supplied request key makes a duplicate submission return the original document instead of posting twice. (5) Lifecycle is the standing one: parked drafts editable until posting, posted documents immutable, reversal only through the FB08-equivalent workflow. Deferred by name: foreign-currency FB50 entry, tax-code lines on this screen (tax codes stand on the parked screen and tax configuration; the package names no line tax field), approval workflow beyond capability authorization.

## §26.630 — SCR-096 stage 1: FB50 entry screen rework

**B-614.** Stage 1 of R-144. The standing journal-entry screen now carries the supplied FB50 shape: Document Date beside Posting Date, configured document types with no assumed default, company currency with its precision shown, Reference and Header Text at package widths, and a line grid with Profit Center and Assignment, insert/copy/delete per line, account value help, field-level errors, live totals, posting disabled until valid and balanced, and a confirmation summary naming company, type, total and date before the post dispatches. A hidden request key travels with the form for the stage-3 idempotency judgment, drafts link to the standing parked-journal screen, and a successful post links into document display. Same-stage bookkeeping: B-614 / §26.630 / §30 row 2.448.

## §26.631 — SCR-096 stage 2: canonical assignment, line constraints, request registry

**B-615.** Stage 2 of R-144, migration `0104_gl_document_entry.sql` (167 migrations). The canonical journal line gains `assignment varchar(18)` — the field the parked line already retained and posting used to drop — plus database checks pinning the debit/credit indicator to S/H and both amounts above zero. A small `journal_posting_request` registry (client + request key → produced document) stands as idempotency bookkeeping only; it is not a document table, and no parallel gl_document header or line tables are created, per the package's reuse instruction. Same-stage bookkeeping: B-615 / §26.631 / §30 row 2.449.

## §26.632 — SCR-096 stage 3: judged G/L posting service

**B-616.** Stage 3 of R-144. `postGlDocument` is the judged front door of the standing posting engine for directly entered G/L documents: inside one transaction it replays a known request key to its original document, validates the company (active, assignments standing), the two-character active document type permitting G/L account types, the company currency and its precision, every account in the company's chart unblocked (required cost object honoured), cost centres valid for company and posting date, profit centres valid for the posting date, positive amounts and balance — then posts through the canonical engine, which revalidates period openness under its locks, and records the request key against the produced document. The engine and the parked-journal posting path now carry the line assignment into the canonical record, and a reversal mirrors it. The entry action derives nothing from browser-supplied tenant fields. Same-stage bookkeeping: B-616 / §26.632 / §30 row 2.450.

## §26.633 — SCR-096 stage 4: catalogue wording and document display

**B-617.** Supporting stage of R-144. The FIN.JOURNAL.POST catalogue description now states the FB50 entry behaviour this round delivers (no new capability, term or alias — the counts stand at 129 / 103 / 111), and document display shows the line assignment beside cost and profit centre so what FB50 captures stays visible on the posted document. Same-stage bookkeeping: B-617 / §26.633 / §30 row 2.451.

## §26.634 — SCR-096 stage 5: service tests and browser target

**B-618.** Three service tests cover the package scenarios against the judged service: a balanced document posts with cost centre, profit centre and assignment on the canonical lines and a duplicate request key returns the same document with exactly one journal behind it; unbalanced, zero-amount, unknown account, invalid cost/profit centre, foreign currency, over-precision amount, unconfigured type and impossible date are each refused with nothing written; reversal through the canonical workflow mirrors the assignment and the pair nets to zero in the ledger. Browser target T900 (gl-document) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-618 / §26.634 / §30 row 2.452.

## §26.635 — SCR-096 closure: FB50 G/L document entry (R-144 complete)

**B-619.** SCR-096 is closed. The FB50 entry screen (FIN.JOURNAL.POST, alias FB50) now carries the supplied package end to end: full header with document date and configured document type (no assumed default), currency at its precision, an editable grid with profit centre and assignment, insert/copy/delete, value help, field-level errors, live totals, posting disabled until valid and balanced, and a confirmation summary; posting is judged server-side inside the transaction (company, type, chart, blocked accounts, cost-object requirement, cost/profit centre validity, currency precision, open period via the engine) and a request key returns the original document on duplicate submission. The canonical line keeps the assignment (migration 0104, 167 total), document display shows it, reversal mirrors it, and drafts ride the parked-journal workflow. Evidence: bookkeeping §§26.629–26.634 (B-613–B-618), three service tests, full suite 1422, production build green, browser target T900 passing on the production build (JE-2026-000001 posted through the confirmation, assignment in the database, resubmission posting no duplicate), seed unchanged at 129 capabilities / 103 terms / 111 aliases. Deferred by name under R-144: foreign-currency FB50 entry, tax-code lines on this screen, approval workflow beyond capability authorization. Next named SCRs in order: **SCR-097 (FIN.TAX.REPORT)** then FIN.FX.VALUATE (FAGL_FC_VAL); their packages are awaited — no contract is drafted before the owner's fields arrive.

## §26.636 — SCR-097 contract: advance return for tax on sales/purchases (R-145)

**B-620.** Owner package received 2026-10-19 for SAP S_ALR_87012357 (Advance Return for Tax on Sales/Purchases), the SCR-097 / FIN.TAX.REPORT roadmap row. **R-145 settles:** (1) The report extracts from the canonical tax record this product actually keeps: journal lines carrying a tax code are the tax lines (input tax posted debit, output tax posted credit, each at the TAX account determination), grouped by tax code and its configured account key for the company country, over a posting-date window. Tax amounts are therefore posted fact; **tax base is derived** from the standing code rate where the rate is above zero and is labelled derived wherever shown — no BSET-equivalent base table is invented, and a zero-rate code reports its tax amount with the base named not derivable. Reversed documents net through their mirrors, so a reversed tax line contributes nothing. (2) Selection: Company Code (required), Tax on Sales/Purchases Group (optional — when given, the run spans the tenant's active company codes in the return country and says so), Posting Date From/To (required), Tax Return Country (required, must equal the company country whose tax codes govern), Test Run (default on), Do Not Update Documents, Electronic Advance Return, Corrected Tax Return, and the conditional Tax Payable/Receivable Clearing G/L. (3) Test runs write nothing but their execution log entry is only written for update runs — a test run leaves no records at all beyond the on-screen result; an update run writes one `tax_return_run` log row (house-named, client-keyed) and stamps the included journal lines with the run id, so a later update run excludes already-reported lines while a corrected return re-includes them. (4) When an update run names a clearing account, one transfer document posts through the canonical engine on the window's end date: a net payable (output over input) debits the TAX determination account and credits the clearing account, a net receivable the mirror — engine period openness governs, closed periods refuse the transfer while reporting stays allowed. (5) The Electronic Advance Return flag is recorded on the run; an authority file format is deferred by name (no statutory format is configured in the product). Own capability FIN.TAX.REPORT gates display and execution; tenant isolation and server-side authorization hold throughout; amounts use decimal arithmetic. Deferred by name: statutory electronic file formats, per-box statutory layouts beyond the code/account-key classification, tax base as posted fact (arrives with a tax-line base record, another round).

## §26.637 — SCR-097 stage 1: tax return screen shell

**B-621.** Stage 1 of R-145: the FIN.TAX.REPORT vocabulary (selection, line and result types), the `/finance/tax/report` selection screen with test-run defaulting on and mode options explicit, and the result grid shape (code, account key, rate, derived base, input/output tax, net) — execution lands in stage 3. One clarification to R-145 point (3): the execution log records **every** execution including test runs, as the package's audit-trail requirement demands; test runs still stamp nothing, transfer nothing and lock nothing. Same-stage bookkeeping: B-621 / §26.637 / §30 row 2.455.

## §26.638 — SCR-097 stage 2: run log, reported stamp, extraction index

**B-622.** Stage 2 of R-145, migration `0105_tax_return_run.sql` (168 migrations): the `tax_return_run` execution log (every execution, test runs included), the `tax_return_run_id` stamp on the canonical journal line, and the tax-code extraction index. House names throughout — client, never tenant_id; no BSET/T001 vocabulary in the schema. Same-stage bookkeeping: B-622 / §26.638 / §30 row 2.456.

## §26.639 — SCR-097 stage 3: extraction, stamping and clearing transfer

**B-623.** Stage 3 of R-145. `executeTaxReport` judges the selection (valid window, active company, return country equal to the company country whose codes govern, one currency across a group), extracts the canonical tax record — journal lines carrying a tax code, debit as input tax and credit as output tax, reversed documents netting through their mirrors — and derives the base from the standing rate, labelled derived. Every execution writes its run-log row; an update run stamps the reported lines (a corrected return re-includes them), and with a clearing account named it posts the net transfer through the canonical engine on the window's end date, atomically with the stamps. The report screen executes from its judged GET selection. Same-stage bookkeeping: B-623 / §26.639 / §30 row 2.457.

## §26.640 — SCR-097 stage 4: capability, S_ALR alias, navigation

**B-624.** Seed grows by one capability (FIN.TAX.REPORT, 130 total) and by the S_ALR_87012357 alias term; the journal list gains the tax-return entry. Seeded twice, idempotent. Same-stage bookkeeping: B-624 / §26.640 / §30 row 2.458.

## §26.641 — SCR-097 stage 5: service tests and browser target

**B-625.** Four service tests cover the return: test-mode extraction by code and account key with derived bases and net payable while stamping nothing; update stamping with stamped-line exclusion and corrected re-inclusion; the clearing transfer (TAX determination account against the clearing account for the net) posted atomically, with reversal mirrors netting rather than reclassifying; and country/window refusals. Browser target T899 (tax-report) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-625 / §26.641 / §30 row 2.459.

## §26.642 — SCR-097 closure: advance return for tax (R-145 complete)

**B-626.** SCR-097 is closed. The advance return for tax on sales/purchases (FIN.TAX.REPORT, alias S_ALR_87012357) is accepted end to end: extraction from the canonical tax-coded journal lines by tax code and account key over a judged posting-date window, tax base derived from the standing rate and labelled derived, test runs changing no source document while every execution stands in the audit log, update runs stamping reported lines with corrected-return re-inclusion, the net clearing transfer posted atomically through the engine, and reversal mirrors netting rather than reclassifying. Evidence: bookkeeping §§26.636–26.641 (B-620–B-625), four service tests, full suite 1427, production build green, browser target T899 passing on the production build (input 100 at I1, output 200 at O1, net payable shown, nothing stamped), seed 130 capabilities / 104 terms / 112 aliases, migrations at 168. Deferred by name under R-145: statutory electronic file formats, per-box statutory layouts beyond the code/account-key classification, tax base as posted fact. Next named SCRs in order: **SCR-098 (FIN.FX.VALUATE / FAGL_FC_VAL)** then FIN.GRIR.RECLASS (F.19); their packages are awaited — no contract is drafted before the owner's fields arrive.

## §26.643 — SCR-098 contract: foreign currency valuation (R-146)

**B-627.** Owner package received 2026-10-19 for FAGL_FC_VAL (Foreign Currency Valuation), the SCR-098 / FIN.FX.VALUATE roadmap row. **R-146 settles:** (1) Eligible items come from the canonical journal: foreign-currency lines (document currency different from the company local currency) on or before the valuation key date, in documents neither reversed nor themselves reversals. Open Items mode takes lines on open-item-managed accounts that stand uncleared at the key date; G/L Balances mode takes the remaining balance-sheet accounts grouped per account and currency — the two modes never double-count an account. (2) The valuation rate is the standing exchange rate of the method's rate type (the standing BUYING / SELLING / AVERAGE types are the configured methods this product holds), latest validity on or before the key date, ratios applied; **a missing rate is a named refusal, never a substituted current rate**. The Valuation Area is a run dimension recorded on every run (delivered default LOCAL); per-area accounting-principle configuration is deferred by name. (3) Adjustment per item is signed: required local amount (foreign amount at the valuation rate, signed by the line's indicator) minus carrying local amount. A positive adjustment debits the source account and credits the FX gain account; a negative one credits the source and debits the FX loss account — one rule covering asset and liability directions. Gain/loss accounts resolve through account determination events FXGAIN and FXLOSS (added to the catalogue this round; the package's warning stands — no OBYC KDF assumption). (4) New audit tables fx_valuation_run and fx_valuation_item only (no equivalent exists): every execution persists its protocol including the exact rates used; test runs persist no financial posting and alter no accounting data; a live run posts one balanced document per run through the canonical engine, atomically — failure completes nothing. A second live valuation of the same source item, area and key date is refused by name unless the first stands reversed; a request key makes duplicate submissions return the original run. (5) When a Reversal Date is named on a live run, the valuation document is reversed through the canonical reversal workflow on that date (its period judged by the engine like any posting). Reporting a closed period is allowed; posting into one is not. Own capability FIN.FX.VALUATE; results export as CSV from the persisted protocol. Deferred by name: valuation-area/accounting-principle configuration, business-day calendars for reversal dates, per-company parallel currencies beyond the local currency.

## §26.644 — SCR-098 stage 1: valuation screen shell

**B-628.** Stage 1 of R-146: the FIN.FX.VALUATE vocabulary (selection, item and result types with per-item status and error), the `/finance/fx/valuation` selection screen with test-run defaulting on, open-item/balance switches, reversal-date field and the protocol grid shape with CSV export entry. Execution lands in stage 3. Same-stage bookkeeping: B-628 / §26.644 / §30 row 2.462.

## §26.645 — SCR-098 stage 2: valuation run and item protocol

**B-629.** Stage 2 of R-146, migration `0106_fx_valuation_run.sql` (169 migrations): `fx_valuation_run` (one row per execution, request-key unique, status TEST/COMPLETED/REVERSED, gain/loss totals and generated-document references) and `fx_valuation_item` (per-item source reference, foreign and carrying amounts, the exact valuation rate used, required amount, signed adjustment, gain/loss classification, status and error). Canonical documents, rates and balances are reused untouched. Same-stage bookkeeping: B-629 / §26.645 / §30 row 2.463.

## §26.646 — SCR-098 stage 3: valuation service, posting and protocol export

**B-630.** Stage 3 of R-146. `executeFxValuation` judges the selection (configured rate type as method, fiscal year agreeing with the posting date), selects canonical foreign-currency items — uncleared open items on open-item-managed accounts, remaining balance-sheet accounts grouped per account and currency, reversed and reversal documents excluded — values each at the latest standing rate on or before the key date with ratios applied (a missing rate is an item error and blocks a live post, never a substituted rate), and applies the one signed adjustment rule through FXGAIN/FXLOSS account determination (catalogue events added this stage). Test runs persist only the protocol; live runs post one balanced document atomically, refuse already-valued items by name, reverse on the named date through the canonical workflow, and replay by request key. The protocol exports as CSV from the persisted run. Same-stage bookkeeping: B-630 / §26.646 / §30 row 2.464.

## §26.647 — SCR-098 stage 4: capability, FAGL_FC_VAL alias, navigation

**B-631.** Seed grows by one capability (FIN.FX.VALUATE, 131 total) and by the FAGL_FC_VAL alias term; the journal list gains the FX valuation entry. Seeded twice, idempotent. Same-stage bookkeeping: B-631 / §26.647 / §30 row 2.465.

## §26.648 — SCR-098 stage 5: service tests and browser target

**B-632.** Four service tests cover the valuation: test-mode calculation with the receivable's gain and the liability's loss classified under the one signed rule while posting nothing; a live run posting and reversing on the named date, freeing its items for a rerun, and a third valuation refused per item with no document; a missing GBP rate named as an item error blocking the live post; and method/scope/fiscal-year refusals. Browser target T898 (fx-valuation) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-632 / §26.648 / §30 row 2.466.

## §26.649 — SCR-098 closure: foreign currency valuation (R-146 complete)

**B-633.** SCR-098 is closed. Foreign currency valuation (FIN.FX.VALUATE, alias FAGL_FC_VAL) is accepted end to end: canonical foreign-currency open items and balance-sheet balances valued at the latest standing rate on or before the key date with ratios applied, a missing rate named as an item error and blocking any live post, the one signed gain/loss rule resolved through FXGAIN/FXLOSS determination, live runs posting one balanced document atomically with per-item duplicate refusal, reversal-and-rerun through the canonical workflow, request-key replay, and the protocol persisted with the exact rates used and exportable as CSV. Evidence: bookkeeping §§26.643–26.648 (B-627–B-632), four service tests, full suite 1432, production build green, browser target T898 passing on the production build (EUR 1,000 carried at 270, valued at 300, gain classified, nothing posted), seed 131 capabilities / 105 terms / 113 aliases, migrations at 169. Deferred by name under R-146: valuation-area/accounting-principle configuration, business-day calendars for reversal dates, parallel currencies beyond the local currency. Next named SCRs in order: **SCR-099 (FIN.GRIR.RECLASS / F.19)** then FIN.ACCRUAL.POST (FBS1); their packages are awaited — no contract is drafted before the owner's fields arrive.

## §26.650 — SCR-099 contract: GR/IR clearing account analysis (R-147)

**B-634.** Owner package received 2026-10-19 for F.19 (GR/IR Clearing Account Analysis), the SCR-099 / FIN.GRIR.RECLASS roadmap row. **R-147 settles:** (1) The analysis stands per purchase order item from canonical history up to the key date: goods-receipt quantities from material document lines signed by movement direction (receipts positive, receipt reversals negative, reversed source documents excluded), valued at the order price (quantity × net price / price unit — the basis the GR/IR credit actually posted at); invoiced quantities and net values from posted supplier-invoice items signed by category (invoice and subsequent debit positive, credit memo and subsequent credit negative; cancelled invoices and their cancellation mirrors both excluded). Returns and partial movements are therefore movements in the same signed sums, never special cases. (2) Open quantity = received − invoiced; open value likewise. Classification per item: RECONCILED within a 0.01 tolerance on both; GOODS_RECEIVED_NOT_INVOICED when both stand positive; INVOICED_NOT_RECEIVED when both stand negative; VALUE_DIFFERENCE when quantities reconcile but value does not; QUANTITY_DIFFERENCE for the remaining mixed cases. Values decide with quantities — never quantity alone. (3) Analysis and posting stay separate: Create Accruals off, or any test run, generates no accounting document. A live accrual posts the open value per eligible item against the GR/IR clearing account from account determination (GR_IR_CLEARING / WRX): goods received not invoiced debits GR/IR and credits the named accrual account, the mirror direction for invoiced not received. It never posts amounts already accrued: a prior live accrual for the same item and fiscal year refuses the item by name unless that run stands reversed. (4) New audit tables grir_reclass_run and grir_reclass_item only; the protocol persists source references, quantities, values, classification, status and errors for every execution, test runs included as audit only. Posting and reversal dates are judged by the canonical engine (closed periods refuse the posting, never the analysis); a named reversal date reverses the accrual document through the canonical workflow. A request key returns the original run on resubmission; results export as CSV from the persisted protocol. Display Variant is accepted and honestly reported as not configured (the delivered grouping purchase order → item stands). Own capability FIN.GRIR.RECLASS. Deferred by name: saved display variants, configured tolerance groups beyond the 0.01 house tolerance, delivery-cost-specific classifications, business-day calendars.

## §26.651 — SCR-099 stage 1: GR/IR analysis screen shell

**B-635.** Stage 1 of R-147: the FIN.GRIR.RECLASS vocabulary (selection, item with classification vocabulary, result), the `/finance/grir-reclass` selection screen keeping analysis and accrual creation visibly separate with test mode defaulted, and the protocol grid shape with CSV export entry. Execution lands in stage 3. Same-stage bookkeeping: B-635 / §26.651 / §30 row 2.469.

## §26.652 — SCR-099 stage 2: GR/IR run and item protocol

**B-636.** Stage 2 of R-147, migration `0107_grir_reclass_run.sql` (170 migrations): `grir_reclass_run` (request-key unique, status TEST/COMPLETED/REVERSED, accrual total and generated-document references) and `grir_reclass_item` (PO/vendor/material/plant references, ordered/received/invoiced/open quantities and values, classification, accrual reference, status and error). Purchase orders, material documents, supplier invoices and accounting documents are reused untouched. Same-stage bookkeeping: B-636 / §26.652 / §30 row 2.470.

## §26.653 — SCR-099 stage 3: analysis, accrual posting and protocol export

**B-637.** Stage 3 of R-147. `executeGrIrAnalysis` judges the selection (valid key date and range; accrual creation requires its posting date, document type and account), then computes the signed canonical history per purchase order item — material-document quantities by movement direction with reversed sources excluded, supplier-invoice quantities and values signed by category with cancelled invoices and their mirrors excluded — and classifies on quantity and value together. A live accrual posts the open value per eligible item against the GR/IR clearing account from determination, atomically with the protocol, refuses items already accrued for the fiscal year unless that run stands reversed, and reverses on the named date through the canonical workflow; a request key replays the original run. The protocol exports as CSV from the persisted run. Same-stage bookkeeping: B-637 / §26.653 / §30 row 2.471.

## §26.654 — SCR-099 stage 4: capability, F.19 alias, navigation

**B-638.** Seed grows by one capability (FIN.GRIR.RECLASS, 132 total) and by the F.19 alias term; the journal list gains the GR/IR analysis entry. Seeded twice, idempotent. Same-stage bookkeeping: B-638 / §26.654 / §30 row 2.472.

## §26.655 — SCR-099 stage 5: service tests and browser target

**B-639.** Three service tests cover the analysis: classification on quantity and value together (goods received not invoiced at 4/400; a value difference at 0/−50) in test mode posting nothing; a live accrual posting and reversing on the named date, re-accruing after the reversal, then refusing duplicates per item; and the analysis/posting separation with half-specified accruals refused. Browser target T897 (grir-reclass) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-639 / §26.655 / §30 row 2.473.

## §26.656 — SCR-099 closure: GR/IR clearing account analysis (R-147 complete)

**B-640.** SCR-099 is closed. The GR/IR clearing account analysis (FIN.GRIR.RECLASS, alias F.19) is accepted end to end: per purchase order item, goods-receipt history signed by movement direction and valued at the order price, invoice history signed by category with cancelled invoices and their mirrors excluded, open quantity and value classified together in five classes, analysis rigorously separated from posting, live accruals posting the open value against the GR/IR clearing account from determination once per item and fiscal year with reversal-and-reaccrual through the canonical workflow, and the protocol persisted with CSV export. Evidence: bookkeeping §§26.650–26.655 (B-634–B-639), three service tests, full suite 1436, production build green, browser target T897 passing on the production build (10 received against 6 invoiced classified goods received not invoiced at 400, nothing posted), seed 132 capabilities / 106 terms / 114 aliases, migrations at 170. Deferred by name under R-147: saved display variants, configured tolerance groups beyond the house 0.01, delivery-cost-specific classifications, business-day calendars. Next named SCRs in order: **SCR-100 (FIN.ACCRUAL.POST / FBS1)** then FIN.CLOSE.COCKPIT; their packages are awaited — no contract is drafted before the owner's fields arrive.

## §26.657 — SCR-100 contract: accrual/deferral document entry and reversal (R-148)

**B-641.** Owner package received 2026-10-19 for FBS1 (Enter Accrual/Deferral Document) with F.81 reversal processing, the SCR-100 / FIN.ACCRUAL.POST roadmap row. **R-148 settles:** (1) Entry rides the judged G/L posting of SCR-096: the same company/type/currency/account/assignment judgments and the canonical engine, extended atomically — the accrual metadata (reversal date, reversal reason from the standing reversal-reason configuration, reversal status, reversal document reference, execution user and timestamp) writes in the same transaction as the document through a posting hook, so a failed posting leaves no metadata and a posted document never stands without its reversal data. No separate accrual header/line tables: one `accrual_document` metadata table keyed by the canonical document identity (client, company code, document number, fiscal year). (2) Reversal Date and Reversal Reason are required at entry; the reason must stand active in the reversal-reason configuration (two characters). Same-period reversal is permitted — no contrary configured policy stands, and the contract names that rather than inventing one. (3) F.81 processing lists accrual documents whose reversal date is due and whose status stands PENDING; executing a reversal posts through the canonical document-reversal workflow (exactly-one-reversal link, advisory lock, request-key replay), then marks the metadata REVERSED with the reversal document reference — a retry after any interruption reconciles from the standing link rather than reversing twice. A failed reversal leaves the original posted and eligible. Manual reversal of an accrual document through the document-reversal screen remains possible and the metadata reconciles the same way. (4) Drafts ride the standing parked-journal workflow; posted documents are immutable and corrections are reversal and repost. Own capability FIN.ACCRUAL.POST governs entry, display and reversal execution. Deferred by name: recurring accrual schedules beyond the single named reversal date, configured same-period-reversal policy, approval workflow.

## §26.658 — SCR-100 stage 1: accrual entry screen shell

**B-642.** Stage 1 of R-148: the FIN.ACCRUAL.POST vocabulary (line input and document view types), the `/finance/accruals` entry shell carrying the required reversal date and reason beside the FB50-shaped header, and the F.81 due-list shape. The judged posting action and reversal execution land in stage 3. Same-stage bookkeeping: B-642 / §26.658 / §30 row 2.476.

## §26.659 — SCR-100 stage 2: accrual metadata table

**B-643.** Stage 2 of R-148, migration `0108_accrual_document.sql` (171 migrations): one `accrual_document` metadata table keyed by the canonical document identity with a tenant-safe composite foreign key to the journal header, reversal date/reason/status, reversal document reference and execution user/timestamp — the reversal-consistency check makes a REVERSED status without its document impossible. No accrual header or line tables duplicate the ledger. Same-stage bookkeeping: B-643 / §26.659 / §30 row 2.477.

## §26.660 — SCR-100 stage 3: judged accrual posting and F.81 reversal service

**B-644.** Stage 3 of R-148. The G/L document service gains an in-transaction posting hook, and `postAccrualDocument` writes the accrual metadata (standing active reversal reason judged, reversal date on or after the posting date) through it, so document and metadata commit or roll back together. `listDueAccruals` selects PENDING accruals whose date has arrived on still-posted journals; `executeAccrualReversal` posts the mirror through the canonical document-reversal workflow and marks the metadata, reconciling from the standing link on any retry. The entry screen carries the full grid with live totals, and each due row executes its reversal in place. Same-stage bookkeeping: B-644 / §26.660 / §30 row 2.478.

## §26.661 — SCR-100 stage 4: capability, FBS1/F.81 aliases, navigation

**B-645.** Seed grows by one capability (FIN.ACCRUAL.POST, 133 total) and by the accrual term carrying both the FBS1 and F.81 search aliases; the journal list gains the accruals entry. Seeded twice, idempotent. Same-stage bookkeeping: B-645 / §26.661 / §30 row 2.479.

## §26.662 — SCR-100 stage 5: service tests and browser target

**B-646.** Three service tests cover the accrual lifecycle: posting with reversal metadata committed in the same transaction and request-key replay; rollback of the whole document when the reversal reason does not stand (no orphan metadata, no partial journal) and reversal-before-posting refusal; the due list opening exactly at the reversal date and the reversal executing exactly once through the canonical workflow with the original marked reversed. Browser target T896 (accrual) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-646 / §26.662 / §30 row 2.480.

## §26.663 — SCR-100 closed: accrual and deferral documents (FBS1/F.81) accepted

**B-647.** R-148 stands implemented and accepted. **Suites:** full vitest 197 files, **1440/1440** (was 1436/1436; +3 accrual service tests, +1 revised browser-target registry). **Browser:** target accrual (**T896**) passed against the production build — accrual posted with reversal metadata, due reversal executed from the list, database metadata naming the reversal document. **Clock:** the round opened 09:42 and closed 10:27 (45 min wall) — over the 39-minute box solely on infrastructure: the 2 GB VM repeatedly OOM-killed the production build's type-check worker until a 3 GB swapfile was added (sudo), after which the build finished in 81 seconds; implementation itself occupied the first 15 minutes. The swapfile lives outside the workspace and may need recreating after a sandbox rebuild (noted for the environment memory). Deferred by R-148 itself: recurring accrual schedules beyond the single reversal date, configured same-period-reversal policy, approval workflow. Same-stage bookkeeping: B-647 / §26.663 / §30 row 2.481.

## §26.664 — FX valuation re-run after reversal (small correction)

**B-648.** A working-tree correction surfaced during SCR-100's acceptance (the suite ran green over it): the FX-valuation duplicate guard counted items of reversed live runs as still standing, so a valuation could never be re-run after its reversal. The guard now excludes `REVERSED` runs, mirroring the GR/IR accrual rule of SCR-099. Same-stage bookkeeping: B-648 / §26.664 / §30 row 2.482.

## §26.665 — SCR-101 contract: period-end close cockpit (FIN.CLOSE.COCKPIT, CLOCO)

**B-649. R-149 (owner package, 2026-10-19).** The closing cockpit organises period-end work as task lists over a closing cycle (company code, fiscal year, posting period), built from reusable templates and executed through registered handlers only — never arbitrary client-supplied programs.

**Data (no duplicate workflow/job/audit tables).** Five fresh tables: `closing_task_list` (cycle key client+company+task list CHAR(30)+Fiscal Year+period, description, status INITIAL/RELEASED/FINALIZED, optional template reference, audit users/timestamps); `closing_task_template` and `closing_task_template_dependency` (reusable definitions: task CHAR(30), name, parent task for hierarchy, sequence, registered handler code, owner, critical-path flag, evidence/sign-off requirements); `closing_task_instance` and `closing_task_dependency` (the period-specific copies with lifecycle status, attempt count, last execution reference, evidence reference, sign-off record); `closing_execution_log` (append-only: execution id, attempt, FOREGROUND/BACKGROUND mode, initiator, start/end, status, result summary, error details, background reference, generated document reference); `closing_task_event` (append-only audit of release, execution, retry, override, sign-off, evidence and finalization, with actor and mandatory reason where the act demands one). Composite keys and foreign keys scope everything to tenant and cycle; dependency rows forbid self-reference in the table and cycles in the service.

**Handlers (closed registry).** A task names a handler code from a fixed registry: `PERIOD_STATUS` (reporting — period journal counts, never blocked by posting-period rules), `ACCRUAL_REVERSALS` (posting — executes due accrual reversals at the period end through SCR-100), `FX_VALUATION` (posting — live valuation at a validated key date through SCR-098), `MANUAL_CONFIRMATION` (manual — completes on execution subject to gates). Each handler receives only validated cycle context (company, Fiscal Year, period, tenant, actor). Posting handlers inherit the canonical open-period checks of the services they call; unknown handler codes are refused at template/instance save and at release.

**Lifecycle and gates.** Task list INITIAL → RELEASED → FINALIZED; task INITIAL → RELEASED → RUNNING → COMPLETED, failures to ERROR, gate- or dependency-blocked to BLOCKED. Release validates acyclic dependencies and registered handlers. Execution refuses until every predecessor is COMPLETED, takes an execution lock by atomic status transition (no simultaneous duplicate execution of one instance), increments attempts, and appends its log. A task is COMPLETED only when the handler reports success **and** required evidence is recorded and required sign-off is given; otherwise it waits BLOCKED and a finalize-gates action completes it when the conditions stand. BACKGROUND executions are recorded SCHEDULED and are never marked complete until the scheduled runner actually executes their handler. Failed tasks keep their logs and may retry; finalizing a list is refused while any task is incomplete, in error, blocked, missing evidence, or awaiting sign-off. **Completing a task list never closes or locks the financial period** — period closure remains an explicit, separately authorised act outside this SCR. Manual status overrides require the cockpit capability and a mandatory reason, preserve prior history, and land in the append-only event trail; reopening a completed task likewise preserves history (rerun accounting risk is surfaced on the task before retry is allowed). The workspace shows the cycle tree with owners, predecessors, statuses, history, critical-path flags, completion percentage, failed/blocked counts and overdue markers where deadlines are configured (deadline column carried on instances; overdue judged against it). Evidence is a recorded reference/note with generating-document links where handlers produce them; binary attachment storage is deferred by name. Capability `FIN.CLOSE.COCKPIT`; aliases CLOCO/CLOCOC (+FCLOCO/FCLOCOC).

Deferred by name: binary evidence attachments, deadline calendars/escalations, cross-cycle task copying UI beyond template instantiation, background job infrastructure beyond the in-workspace scheduled runner. Same-stage bookkeeping: B-649 / §26.665 / §30 row 2.483.

## §26.666 — SCR-101 stage 1: close-cockpit vocabulary and workspace shell

**B-650.** The cockpit vocabulary stands in `src/modules/finance/close-cockpit.ts`: list and task lifecycles, execution modes and statuses, and the closed handler registry (`PERIOD_STATUS`, `ACCRUAL_REVERSALS`, `FX_VALUATION`, `MANUAL_CONFIRMATION`) with reporting/posting/manual kinds. `/finance/close-cockpit` renders the cycle selector (task list, company, year, period, mode, status and owner filters), the cycle table with progress, and the hierarchical task table with critical-path markers; nothing posts yet. Same-stage bookkeeping: B-650 / §26.666 / §30 row 2.484.

## §26.667 — SCR-101 stage 2: close-cockpit tables (migration 0109)

**B-651.** Migration `0109_close_cockpit.sql` (172 total, applied) creates the seven cockpit structures: reusable task templates with their dependency edges; period task lists; period task instances with hierarchy, gates, attempts and due dates; instance dependencies with self-reference refused in the table; the append-only execution log (attempt, mode, status, result, error, generated document); and the append-only event trail. Composite keys and foreign keys scope every row to tenant and closing cycle. Drizzle schemas mirror the migration. Same-stage bookkeeping: B-651 / §26.667 / §30 row 2.485.

## §26.668 — SCR-101 stage 3: cockpit lifecycle service and wired workspace

**B-652.** `close-cockpit.ts` now carries the full lifecycle: template save with handler whitelisting and circular-dependency refusal; task-list instantiation copying definitions and edges; release validating handlers and acyclicity; execution behind predecessor gating and an atomic RUNNING claim (attempt counted, exactly-once), running the closed handler registry — period status report, due accrual reversals (SCR-100), FX valuation (SCR-098), manual confirmation — into the append-only execution log; completion gated on evidence/sign-off (BLOCKED until satisfied, completed by the gate actions); BACKGROUND executions recorded SCHEDULED and settled only by the scheduled runner, never pre-marked complete; reasoned overrides and reopens preserving history; finalization refused while any task stands open, and explicitly period-neutral. The workspace is wired end to end (create, release, execute/schedule, evidence, sign-off, override, reopen, finalize, execution log and event trail views). Same-stage bookkeeping: B-652 / §26.668 / §30 row 2.486.

## §26.669 — SCR-101 stage 4: capability, CLOCO aliases, standard template, navigation

**B-653.** Seed grows by the FIN.CLOSE.COCKPIT capability (134 total), the close-cockpit term carrying the CLOCO/CLOCOC/FCLOCO/FCLOCOC aliases (108 terms), and a delivered MONTH_END template for every tenant (period status → accrual reversals + FX valuation → signed-off review, critical path marked). The journal list gains the cockpit entry. Seeded twice, idempotent. Same-stage bookkeeping: B-653 / §26.669 / §30 row 2.487.

## §26.670 — SCR-101 stage 5: service tests and browser target

**B-654.** Four service tests cover the cockpit: handler whitelisting and circular-template refusal; predecessor gating, gated completion (evidence then sign-off), finalize-refusal while open and the execution log content; background scheduling that settles only through the runner before a clean finalization; and reasoned override/reopen preserving attempts and the event trail. One fix landed during the stage: the execution-log insert passes an ISO timestamp string (the driver rejects Date objects in raw templates). Browser target T895 (close-cockpit) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-654 / §26.670 / §30 row 2.488.

## §26.671 — SCR-101 closed: period-end close cockpit (CLOCO) accepted

**B-655.** R-149 stands implemented and accepted. **Suites:** full vitest 198 files, **1445/1445** (was 1440/1440; +4 cockpit service tests, +1 revised browser-target registry). **Browser:** target close-cockpit (**T895**) passed against the production build — cycle created from a template, released, first task executed to completion with its handler result in the execution log, gated successor still waiting. **Clock:** the round opened 10:33 and closed 10:43 (10 min; the swapfile from SCR-100 kept the build healthy). Everything the owner package demanded within one round stands: templates vs instances, dependency circles refused at save and release, registered handlers only, predecessor/evidence/sign-off gates, background scheduling that never pre-completes, reasoned overrides and reopens with preserved history, completion metrics, and finalization that never touches period locking. Deferred by R-149 itself: binary evidence attachments (references recorded instead), deadline calendars/escalations, cross-cycle copying beyond template instantiation, external background-job infrastructure. Same-stage bookkeeping: B-655 / §26.671 / §30 row 2.489.

## §26.672 — SCR-102 contract: G/L balance carryforward (FIN.CLOSE.CARRYFORWARD, F.16/FAGLGVTR)

**B-656. R-150 (owner package, 2026-10-19).** The carryforward moves a closed source year into the target year for one ledger (CHAR(2)) and multiple company codes, test-run first, with every execution preserved as its own run — repeat runs are first-class, never blocked by a key.

**Canonical shape (no duplicate balance tables).** Cairn balances derive from the posted journal at read time, so opening balances need no summary table: a balance-sheet account's target opening *is* its cumulative posted balance through the source year-end, and the run records that per account, currency and profit centre in its result rows. P&L accounts close by a real closing-transfer document: posted through the judged G/L entry into the source year at its calendar end, it zeroes each P&L account's cumulative balance against the configured retained earnings account — historical P&L postings are never deleted or altered. Because the transfer lands inside the source-year totals, the arithmetic is self-correcting: a repeat run recomputes the still-untransferred P&L balance and posts only that delta (zero delta → no document), and late prior-year adjustments are picked up by the next run the same way. Retained earnings resolves through account determination: a new posting event `RETAINED_EARNINGS` (balance-sheet kind, no valuation class or modifier) joins the SCR-089 catalogue, resolved per company chart before any update posting — a missing determination refuses the update run by name while test runs report it as an exception. The ledger vocabulary is the delivered leading ledger `0L`; further configured ledgers are deferred by name until multi-ledger configuration stands.

**Runs and concurrency.** `carryforward_run` (run id, ledger, source/target year, company selection, test flag, status RUNNING/COMPLETED/FAILED, actor, timestamps, totals: accounts processed, balances carried, P&L transferred, errors, transfer document reference) and `carryforward_result` (per company/account/category/currency/profit-centre: source closing balance, target opening balance, status CARRIED/TRANSFERRED/EXCEPTION with detail) are the only new tables; both keyed tenant-safely, runs repeatable by construction. An update run first stands RUNNING; a second update run for the same tenant+company+ledger+target year while one stands RUNNING is refused (test runs never block). Company codes process per-company (one transfer document each), a company failure records its exception and fails the run without rolling back companies already carried — resumable by rerunning, since reruns are delta-only.

**Judging.** Target year must follow the source year (source = target − 1 under the calendar fiscal variant; company fiscal-year variants are validated to stand). Posting the transfer inherits canonical open-period judging: a closed source period refuses by the canonical message, never silently. **The carryforward never closes the prior year nor locks any period** — closure stays the separate controlled process of SCR-101's contract note. Capability `FIN.CLOSE.CARRYFORWARD`; aliases F.16/FAGLGVTR (+F.07 reserved for the future subledger carryforward, not claimed here). Deferred by name: non-leading ledgers, subledger (AR/AP/AA) carryforward, document-currency opening balances beyond the local-currency record (transaction-currency result rows are recorded where lines carry them, at stored amounts without conversion).

Same-stage bookkeeping: B-656 / §26.672 / §30 row 2.490.

## §26.673 — SCR-102 stage 1: carryforward vocabulary, run sheet, retained-earnings event

**B-657.** The carryforward vocabulary stands in `src/modules/finance/carryforward.ts` (ledger vocabulary `0L`, run/result statuses, selection and view shapes), `/finance/carryforward` renders the run sheet (selection, latest run, run history, result protocol) with nothing executing yet, and the account-determination catalogue gains the `RETAINED_EARNINGS` posting event (balance-sheet kind) that stage 3 resolves per chart. Same-stage bookkeeping: B-657 / §26.673 / §30 row 2.491.

## §26.674 — SCR-102 stage 2: carryforward run protocol (migration 0110)

**B-658.** Migration `0110_carryforward.sql` (173 total, applied) creates only the protocol structures R-150 permits: `carryforward_run` (repeat executions keyed by run id, target = source + 1 enforced, test flag, totals, transfer document references, actor and timestamps) and `carryforward_result` (per company/account/category/profit-centre/currency closing and opening balances, retained-earnings account and transfer document where applicable, CARRIED/TRANSFERRED/EXCEPTION status). Openings themselves stay derived from the journal — no balance-summary table. Drizzle schemas mirror the migration. Same-stage bookkeeping: B-658 / §26.674 / §30 row 2.492.

## §26.675 — SCR-102 stage 3: carryforward execution service and wired run sheet

**B-659.** `executeCarryforward` validates the ledger vocabulary and target year, stands the run RUNNING (refusing a concurrent update run over the same company/ledger/year while allowing test runs freely), then per company derives cumulative balances from the posted journal, records balance-sheet openings, and — in update mode — posts one judged closing-transfer document per company at the source year-end zeroing each P&L account against the determined retained earnings account. Because the transfer lands inside the source-year totals, reruns post only the remaining delta and late adjustments flow through identically; a missing retained-earnings determination fails the update by name and marks test-run P&L rows EXCEPTION. The run closes with totals and status, every result row persisted. The run sheet is wired (execute with test-first default, latest run, history, result protocol). Same-stage bookkeeping: B-659 / §26.675 / §30 row 2.493.

## §26.676 — SCR-102 stage 4: capability, F.16/FAGLGVTR aliases, navigation

**B-660.** Seed grows by the FIN.CLOSE.CARRYFORWARD capability (135 total) and the carryforward term carrying the F.16 and FAGLGVTR aliases (109 terms); the journal list gains the carryforward entry. Seeded twice, idempotent. Same-stage bookkeeping: B-660 / §26.676 / §30 row 2.494.

## §26.677 — SCR-102 stage 5: service tests and browser target

**B-661.** Three service tests cover the carryforward: unconfigured-ledger refusal; the full delta lifecycle — test run posting nothing with openings recorded, update run closing P&L into retained earnings inside the source year, a zero-delta repeat posting nothing, and a late prior-year adjustment carried by a delta-only transfer; and the missing retained-earnings determination surfacing as protocol exceptions on a FAILED run. Two fixes landed in the stage: the retained-earnings account earns a result row even with no prior balance, and a test-side journal-count expectation was corrected. Browser target T894 (carryforward) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-661 / §26.677 / §30 row 2.495.

## §26.678 — SCR-102 closed: G/L balance carryforward (F.16/FAGLGVTR) accepted

**B-662.** R-150 stands implemented and accepted. **Suites:** full vitest 199 files, **1449/1449** (was 1445/1445; +3 carryforward service tests, +1 revised browser-target registry). **Browser:** target carryforward (**T894**) passed against the production build — test run posting nothing with openings recorded, update run closing the P&L balance into retained earnings, both runs preserved. **Clock:** the round opened 10:51 and closed 11:02 (11 min). The self-correcting delta design proved itself in tests: update closes P&L inside the source year, a zero-delta repeat posts nothing, a late prior-year adjustment carries through a delta-only transfer, and the missing retained-earnings determination fails the run with named exceptions. Deferred by R-150 itself: non-leading ledgers, subledger (AR/AP/AA) carryforward, document-currency openings beyond the local-currency record. Same-stage bookkeeping: B-662 / §26.678 / §30 row 2.496.

## §26.679 — Intercompany items deferred to last (owner decision)

**B-663.** Owner decision (2026-10-19): FIN.IC.POST and FIN.IC.CLEAR are deferred to the end of the roadmap. Dependency check before recording: no built or roadmapped function consumes intercompany postings — subledgers, close, credit and reports stand alone; the only forward reference is consolidation context (D-028), itself unbuilt, and the company-code intercompany clearing account field already standing is dormant configuration, not a dependency. The related "Intercompany config" roadmap row travels with them. FUNCTIONS-AND-ROADMAP.md marks all three Deferred (B-663) in the same turn, per the maintenance rule. The queue therefore continues with FIN.CREDIT.MAINTAIN (FD32), then FIN.CREDIT.MONITOR (F.31). Same-stage bookkeeping: B-663 / §26.679 / §30 row 2.497.

## §26.680 — SCR-103 contract: customer credit management (FIN.CREDIT.MAINTAIN, FD32)

**B-664. R-151 (owner package, 2026-10-19).** Credit management per customer and credit control area on the canonical masters: the customer is the standing business partner, the credit control area is the SCR-era configuration (with its currency and warning threshold), and exposure derives from canonical FI-AR data at read time.

**Data (migration 0111, no duplicate masters).** `customer_credit` keyed (client, customer, credit control area) with tenant-safe foreign keys to the partner and the area: credit limit (non-negative, checked in the table), credit currency (the area's currency), risk category, representative group, limit valid-to, customer credit group, block flag and block reason, audit users/timestamps, and an optimistic-locking version. Four small configuration tables carry the judged vocabularies the package names — `credit_risk_category` (CHAR(3)), `credit_representative_group` (CHAR(3)), `customer_credit_group` (CHAR(4)), `credit_block_reason` (CHAR(2)) — each tenant-scoped and activatable. `credit_change_audit` is append-only: one row per changed field with previous/new values, actor, timestamp and the change reason every save must state. Keys are immutable: customer or area changes mean a new record, never an in-place key edit (no delete path is offered; correction is a new record plus audit).

**Exposure and checks.** Exposure is the customer's open FI-AR receivables — posted journal lines for the partner with no clearing document — summed across every company code assigned to the credit control area, in the area currency; open sales orders, deliveries and billing components are deferred by name because no SD order canon stands yet (the monitor of SCR-104 inherits this service). Available credit and utilization derive from limit and exposure; an expired limit (valid-to before today) exposes as expired rather than silently valid. `evaluateCreditCheck` is the explicit integration surface later SD checks will call, and it never bypasses: no credit record → BLOCK (NO_CREDIT_RECORD); manual hold → BLOCK (MANUAL_HOLD); expired limit → BLOCK (LIMIT_EXPIRED); zero limit → BLOCK (ZERO_LIMIT); exposure plus the checked amount above the limit → BLOCK (LIMIT_EXCEEDED); at or above the area's configured warning threshold → WARN; otherwise OK. A manual hold requires a block reason whenever active block reasons stand configured. Saves validate every configured reference, reject negative limits and precision beyond the credit currency, write record and audit rows atomically, and refuse stale versions instead of overwriting a concurrent edit. Changes take effect in the next evaluation immediately — no sales-document updates are needed because checks always read the standing record.

Deferred by name: SD order/delivery/billing exposure components and their event-driven refresh (no SD canon), field-level permission granularity beyond the FIN.CREDIT.MAINTAIN capability, credit-record migration tooling for key changes. Same-stage bookkeeping: B-664 / §26.680 / §30 row 2.498.

## §26.681 — SCR-103 stage 1: credit vocabulary and credit-sheet shell

**B-665.** The credit vocabulary stands in `src/modules/finance/credit.ts` (decisions, never-bypass block reasons, record/exposure/check/audit views) and `/finance/credit` renders the credit sheet: customer + area selection, the overview stats (limit, exposure, available, utilization, open receivables, risk, validity, hold) and the change-history table. Nothing saves yet. Same-stage bookkeeping: B-665 / §26.681 / §30 row 2.499.

## §26.682 — SCR-103 stage 2: credit tables (migration 0111)

**B-666.** Migration `0111_customer_credit.sql` (174 total, applied) creates the four judged vocabularies (risk category CHAR(3), representative group CHAR(3), customer credit group CHAR(4), block reason CHAR(2)), the `customer_credit` record keyed (tenant, customer, credit control area) with non-negative limit, hold-requires-reason, and optimistic-locking version, and the append-only `credit_change_audit` (one row per changed field, previous/new values, actor, reason). Tenant-safe composite foreign keys bind partner, area and every vocabulary. Drizzle schemas mirror the migration. Same-stage bookkeeping: B-666 / §26.682 / §30 row 2.500.

## §26.683 — SCR-103 stage 3: credit service and wired credit sheet

**B-667.** `credit.ts` now carries the record lifecycle: configuration judged on every save (area active with its currency and precision, risk category, representative group, credit group, and a mandatory active block reason behind any hold), a stated change reason on every save, optimistic-locking version refusal, and one append-only audit row per changed field written in the same transaction. Exposure derives from open FI-AR items across the area's companies; `evaluateCreditCheck` implements the never-bypass ladder (no record, hold, expired, zero, exceeded → BLOCK; warning threshold → WARN). The credit sheet is wired end to end (load, overview, edit with hold/reason, history). Same-stage bookkeeping: B-667 / §26.683 / §30 row 2.501.

## §26.684 — SCR-103 stage 4: capability, FD32 alias, credit vocabularies, navigation

**B-668.** Seed grows by the FIN.CREDIT.MAINTAIN capability (136 total), the credit-management term carrying the FD32 alias (110 terms), and delivered credit vocabularies for every tenant (risk categories A/B/C, representative group 001, block reasons 01–03). The journal list gains the credit entry. Seeded twice, idempotent. Same-stage bookkeeping: B-668 / §26.684 / §30 row 2.502.

## §26.685 — SCR-103 stage 5: service tests and browser target

**B-669.** Three service tests cover credit management: the never-bypass ladder (missing record blocks; warning at the area threshold; exceeded, held and expired all block with distinct reasons); judged saves (configuration, negativity, mandatory reason, valid customer) with exposure derived from open receivables, utilization, per-field audit with previous/new values, and stale-version refusal; hold requires an active block reason. One fix landed in the stage: audit amount comparisons in the test are numeric (audit stores scale-4 renderings). Browser target T893 (credit) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-669 / §26.685 / §30 row 2.503.

## §26.686 — SCR-103 stage 5 fix: credit hold column renamed (migration 0112)

**B-670.** The FS00 schema-contract guard reserves the bare `is_blocked` flag name to the G/L account master vocabulary (split posting/creation flags); the credit record's hold flag therefore takes the domain name `is_on_hold` via migration `0112_credit_hold_column.sql` (175 total, applied), with the Drizzle schema, service SQL and audit field renamed to match. Behaviour is unchanged. Same-stage bookkeeping: B-670 / §26.686 / §30 row 2.504.

## §26.687 — SCR-103 closed: customer credit management (FD32) accepted

**B-671.** R-151 stands implemented and accepted. **Suites:** full vitest 200 files, **1453/1453** (was 1449/1449; +3 credit service tests, +1 revised browser-target registry). **Browser:** target credit (**T893**) passed against the production build (re-run after the B-670 rename) — explicit no-record notice, judged save with stated reason, field audit visible, record standing at version 1. **Clock:** the round opened 11:33 and closed 11:47 (14 min, including the schema-contract rename fix). The never-bypass ladder is proven end to end: missing record, manual hold, expired limit, zero limit and exceeded limit each block with distinct reasons, and the area warning threshold warns. Deferred by R-151 itself: SD order/delivery/billing exposure components (no SD order canon stands), field-level permission granularity beyond the capability, credit-record migration tooling for key changes. Same-stage bookkeeping: B-671 / §26.687 / §30 row 2.505.

## §26.688 — SCR-104 contract: credit exposure monitor (FIN.CREDIT.MONITOR, F.31)

**B-672. R-152 (owner package, 2026-10-19).** The monitor is strictly read-only: one row per customer and credit control area, computed at execution time in a single tenant transaction (one consistent snapshot) from the SCR-103 credit records and the canonical open FI-AR items. No transaction tables are created and no calculated exposure is persisted as authoritative data.

**Indexes only (migration 0113).** The package's composite index does not stand equivalently — `customer_credit` is keyed (customer, area) — so migration 0113 adds `(client, credit_control_area, customer)` on the credit record and `(client, business_partner, clearing_document)` on journal lines for the open-item aggregation. Nothing else is created.

**Calculation.** Exposure aggregates source data per customer before joining to the credit record (no row multiplication): AR exposure is the open, uncleared receivables of SCR-103, optionally narrowed to one company code; total exposure equals the AR component today. The order, delivery and billing components have no SD canon to read (deferred in R-151) — the grid shows them as **unavailable**, never as silent zeros, and the total is labelled AR-based until those components land; when they do, the staged amounts must transfer between components rather than add, on the R-151 precedent. Utilization is exposure/limit with zero and missing limits shown explicitly (no division by zero, no misleading percentage); available credit may go negative. Customers with exposure but no credit record appear with a NO_CREDIT_RECORD flag — the monitor never hides a customer the checks would block. Filters judge every value (area, company, customer range, risk category, representative group against standing configuration), support limit-exceeded-only and blocked-only, sort by utilization, and cap the page with a total count. A reporting currency converts exposure and limit with the standing exchange-rate configuration (configured rate type, latest rate on or before today, ratio-aware on the SCR-098 precedent); a missing rate keeps the area currency and flags the row rather than converting wrongly. Drill-downs preserve context: the customer links to the FD32 credit sheet (SCR-103) and to the FBL5N-equivalent customer line items, both under their own authorization. Posting-period rules never filter the report — open-item visibility follows the report's own criteria.

Deferred by name: order/delivery/billing exposure components (await the SD canon), export beyond the standing report patterns, persisted exposure snapshots. Capability `FIN.CREDIT.MONITOR`. Same-stage bookkeeping: B-672 / §26.688 / §30 row 2.506.

## §26.689 — SCR-104 stage 1: monitor vocabulary and overview shell

**B-673.** The monitor vocabulary joins `credit.ts` (filter, row — with the SD components explicitly nullable-unavailable — and result shapes) and `/finance/credit-monitor` renders the filter panel and the exposure grid with breach highlighting and FD32 drill-down links. Nothing computes yet. Same-stage bookkeeping: B-673 / §26.689 / §30 row 2.507.

## §26.690 — SCR-104 stage 2: monitor indexes (migration 0113)

**B-674.** Migration `0113_credit_monitor_indexes.sql` (176 total, applied) adds exactly the two access paths R-152 permits: `(client, credit_control_area, customer)` on the credit record — the package's composite, which did not stand equivalently against the (customer, area) key — and `(client, business_partner, clearing_document)` on journal lines for the open-item aggregation. No tables, no persisted exposure. Drizzle schemas declare both indexes. Same-stage bookkeeping: B-674 / §26.690 / §30 row 2.508.

## §26.691 — SCR-104 stage 3: monitor service and wired overview

**B-675.** `listCreditMonitor` computes the overview in one tenant transaction: every filter judged against standing configuration, exposure aggregated per customer and area before the record join (no row multiplication), exposure-only customers surfaced with a NO_CREDIT_RECORD flag rather than hidden, utilization and availability derived with zero/missing limits explicit, the exceeded/blocked filters applied after computation, sorting by utilization, and optional reporting-currency conversion through the standing ratio-aware rates — a missing rate flags the row instead of converting wrongly. The overview page is wired (GET filters, error surface, FD32 drill-downs, breach and expired highlighting). Same-stage bookkeeping: B-675 / §26.691 / §30 row 2.509.

## §26.692 — SCR-104 stage 4: capability, F.31 alias, navigation

**B-676.** Seed grows by the FIN.CREDIT.MONITOR capability (137 total, display-only) and the exposure-monitor term carrying the F.31 alias (111 terms); the credit sheet links to the monitor. Seeded twice, idempotent. Same-stage bookkeeping: B-676 / §26.692 / §30 row 2.510.

## §26.693 — SCR-104 stage 5: service tests and browser target

**B-677.** Three service tests cover the monitor: one-snapshot computation (utilization, negative availability, no-record flagging, SD components null-unavailable, sorting); the exceeded/blocked/risk filters with every filter value judged; and reporting-currency conversion with the missing-rate flag (the fixture's delivered USD→EUR rate is cleared first so the missing path is genuinely under test). Browser target T892 (credit-monitor) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-677 / §26.693 / §30 row 2.511.

## §26.694 — SCR-104 closed: credit exposure monitor (F.31) accepted

**B-678.** R-152 stands implemented and accepted. **Suites:** full vitest 201 files, **1457/1457** (was 1453/1453; +3 monitor service tests, +1 revised browser-target registry). **Browser:** target credit-monitor (**T892**) passed against the production build — recorded customer at 80% utilization, unrecorded exposure flagged, and the record's version proving the monitor wrote nothing. **Clock:** the round opened 12:18 and closed 12:25 (7 min). The overview computes in one snapshot with aggregated-before-join exposure, judged filters, flagged missing-rate conversion, and the SD components explicitly unavailable until the sales canon stands. Deferred by R-152 itself: order/delivery/billing exposure components, export beyond standing report patterns, persisted exposure snapshots. Same-stage bookkeeping: B-678 / §26.694 / §30 row 2.512.

## §26.695 — SCR-105 contract: release credit-blocked documents (FIN.CREDIT.RELEASE, VKM3)

**B-679. R-153 (owner package, 2026-10-19).** No sales-document canon stands in the product today, so the package's own fallback governs: a **credit determination record** keyed by tenant and sales-document key is the single authoritative credit status — no duplicate sales-document table and no second status store. When the SD canon lands, its documents bind to these determinations by key without changing the status model. Determinations are created by `checkSalesDocumentCredit`, the SD integration surface: it evaluates the SCR-103 credit check for a presented document (customer, credit control area, order value and currency, document date, sales organization) and records the outcome.

**Data (migration 0114).** `credit_determination` (determination id; sales document CHAR(20), document date, sales organization, customer, credit control area — tenant-safe foreign keys to partner and area; order value/currency; status BLOCKED/PASSED/RELEASED; reason code from the SCR-103 ladder or a release reason; exposure and limit captured at determination; release user/timestamp, override flag and approval reference; supersedes reference forming the per-document chain; optimistic-locking version; audit timestamps) and `credit_release_event`, append-only (CHECK, RELEASE, OVERRIDE_RELEASE, REJECT, REBLOCK with actor, mandatory reason where the act demands one, approval reference, before/after statuses). History is never deleted: every re-check, release, rejection and reblock supersedes rather than edits. Indexes align with (tenant, area, status, date), customer and sales organization.

**Processing.** The overview judges every filter (area, sales organization, customer and document ranges, representative group via the credit record, date range) and shows current determinations — blocked by default, released only when requested — with exposure/limit/utilization read live from SCR-103, never treating the report's calculations as the status. Per document: **recheck** re-evaluates against current limits and supersedes; **release** confirms the document still stands blocked, re-evaluates, and only releases when the fresh check passes — a still-failing document needs the separate override privilege (`FIN.CREDIT.OVERRIDE`, distinct from release) with mandatory justification and approval reference, and is never silently bypassed; **reject** records the release-request decision with a mandatory reason and leaves the document blocked and untouched; **reblock** of a released document runs a fresh determination first, then blocks again by authorized transition, preserving the release history. Each act is version-checked (a concurrent change reports the actual result, never overwrites), status change and event commit atomically, and bulk release processes each document independently with per-document success/failure results. A release creates nothing downstream — no delivery, goods issue, invoice or accounting entry — and FI posting-period locks are not a release prerequisite. FI posting authorization alone never grants release rights (dedicated capability). Document drill-downs link to the FD32 credit sheet; a VA03-equivalent document display arrives with the SD canon (deferred by name, with real sales-order headers/items, workflow eligibility refresh and approval workflows).

Same-stage bookkeeping: B-679 / §26.695 / §30 row 2.513.

## §26.696 — SCR-105 stage 1: release-queue vocabulary and shell

**B-680.** The release vocabulary joins `credit.ts` (determination statuses, the queue row with at-check and current credit figures, filters, per-document outcomes, and the separate override capability) and `/finance/credit-release` renders the selection panel and determination queue with FD32 drill-downs. Nothing acts yet. Same-stage bookkeeping: B-680 / §26.696 / §30 row 2.514.

## §26.697 — SCR-105 stage 2: credit determination tables (migration 0114)

**B-681.** Migration `0114_credit_determination.sql` (177 total, applied) creates the determination record (document key, date, sales organization, customer, area, order value/currency, BLOCKED/PASSED/RELEASED status with the released-only-with-actor invariant enforced, check-time exposure/limit, release and override fields, supersedes chain, version) and the append-only `credit_release_event` trail, with scope and document indexes. Drizzle schemas mirror the migration. Same-stage bookkeeping: B-681 / §26.697 / §30 row 2.515.

## §26.698 — SCR-105 stage 3: determination and release service, wired queue

**B-682.** `checkSalesDocumentCredit` records determinations from the SCR-103 evaluation (BLOCKED on any block reason, PASSED otherwise, check-time figures captured, CHECK event written); the queue lists current determinations per document with live exposure joined from the monitor. Release re-evaluates and only releases on a passing fresh check — a still-failing document needs the separate override privilege with mandatory justification and approval reference; reject records the decision and leaves the document untouched; reblock always runs a fresh determination first; concurrent changes report actual results instead of overwriting; bulk release processes documents independently with per-document outcomes. The queue UI is wired (filters, bulk selection, per-row recheck/release/reject/reblock). Same-stage bookkeeping: B-682 / §26.698 / §30 row 2.516.

## §26.699 — SCR-105 stage 4: capabilities, VKM3 alias, navigation

**B-683.** Seed grows by the FIN.CREDIT.RELEASE and FIN.CREDIT.OVERRIDE capabilities (139 total — the override deliberately separate from release) and the release-queue term carrying the VKM3 alias (112 terms); the monitor links to the release queue. Seeded twice, idempotent. Same-stage bookkeeping: B-683 / §26.699 / §30 row 2.517.

## §26.700 — SCR-105 stage 5: service tests and browser target

**B-684.** Four service tests cover the release lifecycle: determinations recorded from the check with the blocked queue defaulting correctly; release paths (plain refusal, override without privilege, override without justification, justified override with approval reference and event); reasoned reject leaving the document blocked, recheck after a limit raise, and reblock on a fresh determination with history preserved in the determination chain; and bulk release with independent per-document outcomes including stale and unknown documents. Browser target T891 (credit-release) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-684 / §26.700 / §30 row 2.518.

## §26.701 — SCR-105 closed: release credit-blocked documents (VKM3) accepted

**B-685.** R-153 stands implemented and accepted. **Suites:** full vitest 202 files, **1462/1462** (was 1457/1457; +4 release service tests, +1 revised browser-target registry). **Browser:** target credit-release (**T891**) passed against the production build — blocked queue, release refused on a still-failing fresh check, release granted after the limit raise, actor standing on the released determination. One UI fix landed during acceptance: the per-row action forms were un-nested from the bulk form (HTML forbids nested forms; bulk selection now associates by form id). **Clock:** the round opened 12:41 and the build/test phase closed at 12:53 (12 min to acceptance; closure recorded same turn). The determination store is the single credit status, superseded never edited, with the override as a genuinely separate privilege. Deferred by R-153 itself: VA03-equivalent document display and downstream workflow eligibility (both arrive with the SD canon, whose documents bind to these determinations by key), approval workflows. Same-stage bookkeeping: B-685 / §26.701 / §30 row 2.519.

## §26.702 — SCR-106 contract: trial balance / F.01 statement (FIN.RPT.TRIALBALANCE)

**B-686. R-154 (owner package, 2026-10-19).** F.01 is read-only and derives everything from the posted journal in one snapshot — no totals are persisted as authoritative balances. One gap is closed inside this round: **no financial-statement-version (FSV) canon stands**, so the configuration structures arrive here and the report resolves them dynamically; nothing statutory is hardcoded.

**FSV configuration (migration 0115).** `financial_statement_version` (tenant, version, name, bound chart of accounts), `financial_statement_node` (version, node, description, parent node, sequence — hierarchy enforced tenant-safely, no self-parenting), and `financial_statement_assignment` (version, node, account range from/to, presentation sign NORMAL/INVERTED — a node carries subtotal semantics by hierarchy). A delivered standard version binds to the standard chart with asset, liability, equity, revenue and expense ranges as configuration data tenants may replace; overlapping assignments are refused at maintenance-check time and, defensively, the report counts an account once (first node by sequence) and warns. An FSV maintenance screen is deferred by name; a journal index `(client, company_code, fiscal_year, posting_period)` joins the migration for the aggregation.

**Calculation (canonical balance semantics).** Per account: opening = every posting in years before the fiscal year; turnover = the selected period range (special periods 13–16 only when explicitly included and present); balance at cutoff = opening + turnover through the period-to — never turnover added to a figure that already contains it. Debit and credit turnover are reported separately for the range. Nodes aggregate their accounts (ranges resolved against the company's chart at run time), signs applied per assignment, subtotals roll up the hierarchy, expandable to account-level drill rows (the trial-balance detail) and on to FS10N-equivalent balances and line items by stored period. Accounts with balances but no assignment are never silently omitted: they surface in an explicit unassigned-accounts warning with their amounts. Comparative figures use the identical rules on the comparison year (defaulting to corresponding periods); variance and variance % carry explicit zero-denominator handling. Output currency converts from the company currency through the standing ratio-aware rates (missing rate → warning, figures stay in company currency). Retained earnings and the current-year result present through the FSV's own equity/P&L assignments per SCR-102's closing semantics. Ledger vocabulary is the delivered `0L` of SCR-102. Period validity judges against the company's fiscal-year variant (posting locks never gate reporting). Display variants/saved layouts are deferred by name. Capability `FIN.RPT.TRIALBALANCE`; aliases F.01 (+FS10N/FAGLL03 remain the drill-downs' own codes).

Same-stage bookkeeping: B-686 / §26.702 / §30 row 2.520.

## §26.703 — SCR-106 stage 1: statement vocabulary and report shell

**B-687.** The statement vocabulary stands in `src/modules/finance/trial-balance.ts` (selection, node/account rows, result with warnings and unassigned accounts under the FIN.RPT.TRIALBALANCE capability) and `/finance/trial-balance` renders the selection panel and the hierarchical statement grid with account drill-down links to the standing FS10N-equivalent balances. Nothing computes yet. Same-stage bookkeeping: B-687 / §26.703 / §30 row 2.521.

## §26.704 — SCR-106 stage 2: FSV canon and journal index (migration 0115)

**B-688.** Migration `0115_financial_statement_version.sql` (178 total, applied) creates the financial statement version (bound to a chart), its node hierarchy (self-parenting refused), and account-range assignments with NORMAL/INVERTED presentation signs — configuration only — plus the `(client, company_code, fiscal_year, posting_period)` journal index the aggregation scans by. Drizzle schemas mirror the migration. Same-stage bookkeeping: B-688 / §26.704 / §30 row 2.522.

## §26.705 — SCR-106 stage 3: statement calculation service and wired report

**B-689.** `calculateTrialBalance` validates company, chart and FSV compatibility, then aggregates the journal once per account — opening from earlier years, range debit/credit turnover, turnover through the cutoff, comparative equivalents — before mapping into the dynamically resolved FSV hierarchy. Assignments count an account once (first node in statement order) with duplicate warnings; presentation signs apply per assignment; balances at cutoff are opening plus turnover through the cutoff, never double-counted; unassigned accounts with balances surface in warnings and their own list; zero comparatives yield null variance percentages; output currency converts through ratio-aware rates with a missing-rate warning. The report page is wired with company/version selects and account drill-downs. Same-stage bookkeeping: B-689 / §26.705 / §30 row 2.523.

## §26.706 — SCR-106 stage 4: capability, F.01 alias, standard FSV, navigation

**B-690.** Seed grows by the FIN.RPT.TRIALBALANCE capability (140 total), the statement term carrying the F.01 alias (113 terms), and a delivered standard FSV (INT: balance sheet with assets/liabilities/equity, profit and loss with revenue/expenses, presentation signs set) for every tenant standing on the standard chart. The journal list gains the trial-balance entry. Seeded twice, idempotent. Same-stage bookkeeping: B-690 / §26.706 / §30 row 2.524.

## §26.707 — SCR-106 stage 5: service tests and browser target

**B-691.** Four service tests cover the statement: canonical derivation (prior-year opening, range turnover, cutoff balance, inverted presentation, comparatives and variance with hierarchy rollup, balanced total turnover); unassigned accounts named with their balances; special periods excluded by default with a warning and included on request; version judging and graceful missing comparatives. Browser target T890 (trial-balance) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-691 / §26.707 / §30 row 2.525.

## §26.708 — SCR-106 CLOSED: F.01 trial balance accepted

**B-692.** FIN.RPT.TRIALBALANCE is accepted. Production build green; browser target T890 passed (Assets node carries the derived cutoff balance, account drill row shows its balance in company currency, re-running the statement persisted nothing); full suite 1467/1467 (203 files). The read-only statement derives opening, range turnover and cutoff balance from the posted journal in one snapshot over the configured financial statement version (standard INT seeded), with comparatives, ratio-aware currency conversion, and unassigned accounts named never dropped. Deferred by name (R-154): FSV maintenance screen, display variants/saved layouts. FUNCTIONS-AND-ROADMAP flipped same turn (trial balance Implemented; 140 capabilities / 113 business terms). Next SCR: FIN.RPT.BALANCESHEET (balance sheet with comparatives); its package is awaited. The SCR after: FIN.RPT.CASHFLOW. Same-stage bookkeeping: B-692 / §26.708 / §30 row 2.526.

## §26.709 — SCR-107 contract: balance sheet / P&L statement (FIN.RPT.BALANCESHEET)

**B-693. R-155 (owner package S_ALR_87012284, 2026-10-19).** A second read-only statement over the SCR-106 canon — same FSV tables, same posted-journal snapshot, no new balance or totals tables (§3). What is new: (1) **Balance calculation type** — `ACCUMULATED` (closing = opening + movements through cutoff; default), `MOVEMENT` (net movement strictly inside the selected range, opening excluded), `COMBINED` (balance-sheet accounts by `gl_account_type` take closing logic, P&L accounts take range movement; the net P&L movement is carried in the result as the explicit current-year result figure, while the retained-earnings account keeps its posted closing balance under the SCR-102 year-end rules). (2) **Summary report level** (default 1) folds deeper nodes into their displayed ancestor and merges their account rows upward — presentation only, the accounting calculation never changes. (3) The grid gains an **opening-balance column** beside period debit/credit, closing, comparative, variance and variance % (zero denominator → null, as SCR-106). Judged and settled: comparison range defaults to the corresponding periods when a comparison year is given without periods; periods validate against the company's fiscal-year variant with special periods 13–16 only when explicitly included (clamp + warning, as SCR-106); output currency converts ratio-aware via AVERAGE rates with a missing-rate warning; ledger stays the configured `0L`; OB52 never blocks reporting on closed periods; the report header echoes cutoff, fiscal year, ledger, currency, calculation type and comparison basis. Index duty (§3) is stage 2: verify the 0115 header index and add the aligned line-side index — no duplicate balance-summary table is created, the journal remains the only authority. Drill-down: FS10N-equivalent account balances and the standing journal line-items screen, both capability-guarded. **Deferred by name:** output layout/variant persistence (as SCR-106), FSV maintenance screen. Capability `FIN.RPT.BALANCESHEET`; S_ALR_87012284 (+ S_PL0_86000028, FC10) search aliases only. Stage order: UI shell → schema/index → service → supporting → tests/acceptance. Same-stage bookkeeping: B-693 / §26.709 / §30 row 2.527.

## §26.710 — SCR-107 stage 1: statement vocabulary and report shell

**B-694.** The balance-sheet module stands with the three balance calculation types (ACCUMULATED default, MOVEMENT, COMBINED), summary-level bounds (1–9, default 1) and the selection/result vocabulary carrying the opening-balance column and the COMBINED current-year result. The `/finance/balance-sheet` shell renders the full §1 selection (company, FSV, reporting and comparison ranges, special periods, output currency, calculation type, summary level, ledger `0L`) and the §2 grid skeleton, inert until the service lands in stage 3; i18n `bs.*` keys added. The aligned index follows in stage 2. Same-stage bookkeeping: B-694 / §26.710 / §30 row 2.528.

## §26.711 — SCR-107 stage 2: index duty verified, no new migration

**B-695.** Package §3 resolves to verification, not new schema: the canonical aggregation already carries the aligned indexes — header `journal_entry_company_year_period_idx (client, company_code, fiscal_year, posting_period)` (migration 0115, Drizzle-mirrored) and line `jel_company_account_idx (client, company_code, gl_account, fiscal_year, …)` plus `jel_account_idx` (migration 0098). The ledger is the configured `0L` vocabulary rather than a stored column (SCR-106), so no 0116 is issued and the count stays 178; `tests/balance-sheet-index-contract.test.ts` (3 green) pins the alignment across migration SQL and the Drizzle mirror so drift fails loudly, and confirms the statement persists no totals. The calculation service follows in stage 3. Same-stage bookkeeping: B-695 / §26.711 / §30 row 2.529.

## §26.712 — SCR-107 stage 3: statement calculation service

**B-696.** `calculateBalanceSheet` stands: one journal snapshot (opening / range turnover / through-cutoff, current and comparative) mapped through the FSV exactly as SCR-106, then judged per account by the calculation type — ACCUMULATED closing, MOVEMENT range-only with opening excluded, COMBINED splitting on `gl_account.is_balance_sheet` with the net P&L movement carried as the explicit current-year result. The grid gains the opening column; variance % keeps the zero-denominator null rule; comparison ranges validate independently and default to the corresponding periods; summary-level folding merges folded accounts into their displayed ancestor after roll-up, so presentation never changes a figure. The shell renders the full §2 grid with CSV export and drill-down to account balances and journal line items. Interactive node collapse and amount sorting are deferred by name (the FSV sequence is the configured order). Capability and seed follow in stage 4. Same-stage bookkeeping: B-696 / §26.712 / §30 row 2.530.

## §26.713 — SCR-107 stage 4: capability, aliases, navigation

**B-697.** Seed grows by the FIN.RPT.BALANCESHEET capability (141 total), the statement term carrying the S_ALR_87012284, S_PL0_86000028 and FC10 search aliases (114 terms / 129 aliases), and the journal list gains the balance-sheet entry beside the trial balance. Seeded twice, idempotent. Tests and browser acceptance follow in stage 5. Same-stage bookkeeping: B-697 / §26.713 / §30 row 2.531.

## §26.714 — SCR-107 stage 5: service tests and browser target

**B-698.** Four service tests cover the statement (accumulated opening/closing with comparatives; movement strictly in range; combined closing/movement split with the 3500 current-year result; summary-level folding that merges accounts upward without moving a figure, plus judged calculation type, summary level and comparison range) — 7 green with the stage-2 index contract. Browser target T889 (balance-sheet) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-698 / §26.714 / §30 row 2.532.

## §26.715 — SCR-107 CLOSED: balance sheet / P&L statement accepted

**B-699.** FIN.RPT.BALANCESHEET is accepted. Production build green; browser target T889 passed (COMBINED closing balance on the Assets node, account closing in company currency, explicit current-year result, re-run persisted nothing); full suite 1475/1475. The statement reuses the SCR-106 FSV canon and posted-journal snapshot with three calculation types — accumulated, movement, combined with the net P&L movement as the explicit current-year result — an opening-balance column, independently validated comparatives, and summary-level folding that is presentation-only; the §3 index duty verified against migrations 0098/0115 with no new table and no new migration (178 stands). Deferred by name (R-155): output layout/variant persistence, FSV maintenance screen, interactive node collapse and amount sorting. FUNCTIONS-AND-ROADMAP flipped same turn (balance sheet Implemented; 141 capabilities / 114 business terms). Next SCR: FIN.RPT.CASHFLOW (S_ALR_87012271 direct / S_ALR_87012272–73 indirect); its package is awaited. The SCR after: FIN.RPT.PROFITLOSS. Same-stage bookkeeping: B-699 / §26.715 / §30 row 2.533.

## §26.716 — SCR-108 contract: G/L reporting suite over the standing reports (owner ruling)

**B-700. R-156 (owner package "S_ALR_87012271/72/73 — G/L Reporting Suite", 2026-10-19; scope ruled by the owner the same day).** The package does not specify the roadmap's cash-flow statement: it specifies a G/L balance report and G/L line-item reports, which overlap the accepted FIN.GL.BALANCE (FS10N, SCR-089) and FIN.JOURNAL.LIST (FAGLL03, SCR-088). The owner ruled: **SCR-108 enhances the standing reports**; FIN.RPT.CASHFLOW stays Roadmap awaiting its own package; S_ALR_87012271 becomes a search alias of the balance term, S_ALR_87012272/73 of the line-item term. Judged against the standing code, the gaps are: (1) a **balance report over ranges** — company-code and account ranges, per-account opening (all earlier posted years, the canon carryforward postings already ride inside it; no double count), range debit/credit turnover, net change, closing through the cutoff, separate debit-balance and credit-balance columns, account-group (`gl_account.account_group`) subtotals, currencies kept separate, special periods only when included (clamp + warn), drill-down into line items; (2) **line items**: the `assignment` column, pagination with a total count (the 5000 server cap stays as a safety), and CSV export — open/cleared already judges canonically from clearing data on open-item-managed accounts, period and posting-date filters already combine, FB03-equivalent drill already stands. Opening-balance "carryforward" (§2.2) means the settled derivation, never a stored totals table; §4's index duty is verification (0098/0115/company-date + clearing indexes), no duplicate tables. The suite stays governed by the standing capabilities FIN.GL.BALANCE and FIN.JOURNAL.LIST; ledger remains the configured `0L`. **Deferred by name:** output layout/variant persistence (as SCR-106/107), multi-ledger reporting, the cash-flow statement itself. Stage order: UI shell → index verification → services → aliases → tests/acceptance. Same-stage bookkeeping: B-700 / §26.716 / §30 row 2.534.

## §26.717 — SCR-108 stage 1: reporting-suite vocabulary and shells

**B-701.** The balance-report vocabulary stands in `gl-balances.ts` (range selection, per-account rows with the split debit/credit balance columns, account-group subtotals) beside the standing single-account view, and the balances screen gains the inert range-report form and §2 grid skeleton; `journal-items.ts` gains the pagination vocabulary (page sizes 50/100/250). Calculations follow in stage 3. Same-stage bookkeeping: B-701 / §26.717 / §30 row 2.535.

## §26.718 — SCR-108 stage 2: index duty verified, no new migration

**B-702.** Package §4 resolves to verification again: the balance path is served by `jel_company_account_idx (client, company_code, gl_account, fiscal_year, …)` (migration 0098), line items by `journal_entry_company_date_idx` plus the clearing indexes `jel_clearing_idx` / `journal_entry_line_partner_open_idx` — all Drizzle-mirrored, no duplicate index and no new table, so the count stays 178. `tests/gl-reporting-index-contract.test.ts` (3 green) pins the alignment. The services follow in stage 3. Same-stage bookkeeping: B-702 / §26.718 / §30 row 2.536.

## §26.719 — SCR-108 stage 3: balance report and line-item pagination

**B-703.** `getGlBalanceReport` stands: one journal aggregation by company and account (opening from earlier years, range turnover, through-cutoff columns — closing never double-counts), account-group subtotals, split debit/credit balance columns, zero rows for selected accounts without postings, and drill-down into line items; the balances screen executes it beside the untouched single-account view. Line items gain the `assignment` column and real pagination (a composed-conditions count plus page fetch; the 5000 cap stays as the safety and the legacy default), with page/total display and CSV export on both reports. Capabilities follow in stage 4. Same-stage bookkeeping: B-703 / §26.719 / §30 row 2.537.

## §26.720 — SCR-108 stage 4: suite aliases seeded

**B-704.** The three package codes join the catalogue as search aliases only — S_ALR_87012271 on the FIN.GL.BALANCE term, S_ALR_87012272/73 on FIN.JOURNAL.LIST (141 capabilities / 114 terms / 132 aliases; seeded twice, idempotent). No new capability: the suite rides the standing FS10N/FAGLL03 authorizations. Tests and browser acceptance follow in stage 5. Same-stage bookkeeping: B-704 / §26.720 / §30 row 2.538.

## §26.721 — SCR-108 stage 5: service tests and browser target

**B-705.** Four service tests cover the suite (balance derivation with split balances and reconciling group subtotals; judged ledger/range/company; assignment with disjoint pagination and totals; canonical open/cleared judging with combined period + date filters) — 7 green with the stage-2 index contract. Browser target T888 (gl-reporting) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-705 / §26.721 / §30 row 2.539.

## §26.722 — SCR-108 CLOSED: G/L reporting suite accepted

**B-706.** The S_ALR_87012271/72/73 suite is accepted as enhancements to the standing reports (owner ruling, R-156): a range balance report with account-group subtotals and split debit/credit balances beside the FS10N account view, and line items with the assignment column, true pagination and CSV export over the canonical clearing judgement. Production build green; browser target T888 passed (derived closing over the range, group subtotals, paginated items carrying the assignment, re-runs persisted nothing); full suite 1483/1483. No new migration (178 stands), no new capability — the suite rides FIN.GL.BALANCE and FIN.JOURNAL.LIST. Deferred by name: output layout/variant persistence, multi-ledger reporting, and FIN.RPT.CASHFLOW itself, which remains Roadmap awaiting its own package. FUNCTIONS-AND-ROADMAP updated same turn (suite aliases on the two standing rows; 141 capabilities / 114 business terms). Next SCR: FIN.RPT.CASHFLOW (the cash-flow statement) — package awaited; the SCR after: FIN.RPT.PROFITLOSS. Same-stage bookkeeping: B-706 / §26.722 / §30 row 2.540.

## §26.723 — SCR-109 contract: G/L reporting suite completion (owner package re-issued)

**B-707. R-157 (owner package "S_ALR_87012271/72–73 — General Ledger Reporting Suite", re-issued 2026-10-19).** The owner re-issues the suite under the same codes, so S_ALR_87012271/72/73 stay with the suite and FIN.RPT.CASHFLOW remains Roadmap for its own package. Judged against SCR-108 as delivered, the gaps are: (1) balance-report subtotals split by **company code** as well as account group and currency, so multi-company runs never blend companies sharing a currency; (2) an optional **output currency** on the balance report — validated, converted per company through the standing ratio-aware AVERAGE rates, a missing rate warns and keeps company currency (the statements' rule), currencies otherwise kept separate; (3) the line-item grid shows **document date** and **reference** (both already carried in the row); (4) drill-down carries **period context** (the single period when the range is one period) and the items view offers a **return link** rebuilding the balance-report selection; (5) the §2 "summary figures" wording is settled against canon: **no balance-summary table stands** (SCR-069/089/102/106) — the grouped SQL snapshot over the posted journal is the canonical summary, reconciled by construction, and no duplicate table is created; direct execution of the line-item report stands beside drill-down (accepted SCR-088 behavior). Index duty (§3) is verification, already pinned by the SCR-108 contract test. **Deferred by name:** layout variant persistence, multi-ledger balances (ledger stays the configured `0L`, validated), user-selected sorting/grouping beyond company/group/currency. Stage order: UI → index verification → services → supporting → tests/acceptance. Same-stage bookkeeping: B-707 / §26.723 / §30 row 2.541.

## §26.724 — SCR-109 stage 1: suite UI completion

**B-708.** The line-item grid gains the document-date and reference columns (data already carried by the row), the items view offers the balance-report return link rebuilding the originating selection, and the balance-report form takes the output-currency field. Services follow in stage 3. Same-stage bookkeeping: B-708 / §26.724 / §30 row 2.542.

## §26.725 — SCR-109 stage 2: summary-canon verification extended

**B-709.** The SCR-108 index contract grows the SCR-109 assertions: neither reporting service reads or writes a balance-summary/totals table (the grouped journal snapshot is the canonical summary), the balance aggregation groups by company and account, and line items order on the indexed header posting-date path. No schema change; 178 migrations stand. Services follow in stage 3. Same-stage bookkeeping: B-709 / §26.725 / §30 row 2.543.

## §26.726 — SCR-109 stage 3: company-split subtotals and output currency

**B-710.** The balance report converts into a validated output currency through the standing ratio-aware AVERAGE rates (missing rate warns, company currency kept) and its subtotals now key by company, account group and currency; the drill-down carries the posting period whenever the reported range is a single period. Services compile green. Supporting seed follows in stage 4. Same-stage bookkeeping: B-710 / §26.726 / §30 row 2.544.

## §26.727 — SCR-109 stage 4: suite descriptions in the catalogue

**B-711.** The FIN.GL.BALANCE and FIN.JOURNAL.LIST term descriptions now describe the suite as delivered (range report, company-split subtotals, output currency, pagination, assignment, return link); counts unchanged (141 capabilities / 114 terms / 132 aliases; seeded twice, idempotent). Tests and browser acceptance follow in stage 5. Same-stage bookkeeping: B-711 / §26.727 / §30 row 2.545.

## §26.728 — SCR-109 stage 5: completion tests and browser target

**B-712.** Three service tests cover the completion (output-currency conversion at the seeded rate with company-split subtotals all converted; missing rate warns and keeps company currency while bad codes are judged; document date and reference exposed on line items) — 8 green with the extended index contract. Browser target T887 (gl-reporting-suite) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-712 / §26.728 / §30 row 2.546.

## §26.729 — SCR-109 CLOSED: G/L reporting suite completion accepted

**B-713.** The suite completion is accepted: balance-report subtotals split by company, account group and currency; a validated output currency converts through the standing ratio-aware AVERAGE rates with the missing-rate warning; line items show document date and reference; drill-down carries period context and the items view returns to the originating balance report. Production build green; browser target T887 passed (drill lands with the document date standing, the return link rebuilds the selection, nothing persisted beyond the fixture); full suite 1489/1489. No new migration, capability or term — the suite keeps riding FIN.GL.BALANCE and FIN.JOURNAL.LIST with its S_ALR_87012271/72/73 aliases. Deferred by name: layout variant persistence, multi-ledger balances, user-selected sorting/grouping — and FIN.RPT.CASHFLOW, which remains Roadmap awaiting the owner's cash-flow package. FUNCTIONS-AND-ROADMAP updated same turn (As-of SCR-109; counts unchanged). Next SCR: FIN.RPT.CASHFLOW (cash-flow statement) — package awaited; the SCR after: FIN.RPT.PROFITLOSS. Same-stage bookkeeping: B-713 / §26.729 / §30 row 2.547.

## §26.730 — SCR-110 contract: FS15 G/L account master transfer with company-code segment (SAP parity)

**B-714. R-158 (owner package FS15, 2026-10-19; scope ruled SAP parity by the owner the same day).** This ERP never built the company-code segment of the G/L master: `gl_account` stands once per chart and every company on the chart shares it, so the package's copy target does not exist. Parity therefore builds it: **`gl_account_company`** (tenant, company code, account — unique) carrying account currency, tax category, open-item management, sort key and posting block, backfilled by migration for every company standing on each chart, inheriting the chart-level values so standing behavior is preserved. Wiring rule, settled: **where a segment row stands it governs; the chart-level flag remains the fallback** (line-item open/cleared judgement and the posting block read segment-first), so no accepted behavior changes the day the table lands. FS15 itself (source ≠ target, both on the selected chart, range filter, test run default, with-company-data default, overwrite default off) copies segment rows source → target company with per-account `CREATED / UPDATED / SKIPPED / ERROR` protocol; chart-level records are never overwritten for a company difference — under a shared chart they report SKIPPED by construction, and a genuinely missing chart record (target company on the same chart always sees it, so this is a guard) would be created only when absent entirely. Runs persist as execution metadata in `gl_account_transfer_run` / `gl_account_transfer_result` (run id + per-account key, so accounts re-transfer freely) — including test runs, which never touch master data; live runs validate every referenced value first (companies, chart assignment, currency, account existence) and apply in one transaction, recording completed / failed / partially failed honestly. Segment maintenance stands only through FS15 in this round plus a read-only segment list on the account display; a standalone segment editor and chart-level flag retirement are deferred by name. Capability `CFG.FIN.GLACCOUNT.TRANSFER`; FS15 search alias only; the utility posts nothing and period locks never block it. Stage order: UI shell → segment/run schema + backfill → transfer service + consumer wiring → capability/term/navigation → tests/acceptance. Same-stage bookkeeping: B-714 / §26.730 / §30 row 2.548.

## §26.731 — SCR-110 stage 1: transfer vocabulary and shell

**B-715.** The transfer module carries the segment, selection and protocol vocabulary (capability `CFG.FIN.GLACCOUNT.TRANSFER`), and `/config/gl-accounts/transfer` renders the full §1 selection — source/target companies, chart, account range, test-run / with-company-data / overwrite policy with hidden-field checkbox semantics — over an empty protocol grid, inert until stage 3. The segment schema follows in stage 2. Same-stage bookkeeping: B-715 / §26.731 / §30 row 2.549.

## §26.732 — SCR-110 stage 2: company-code segment schema and backfill

**B-716.** Migration 0116 (179 total) stands: `gl_account_company` (unique per tenant/company/account, FKs to the chart account and the company), backfilled for every company standing on each chart inheriting chart-level open-item/sort/block values with the company currency (75 rows in the development tenant), plus `gl_account_transfer_run` / `gl_account_transfer_result` with run-id + per-account keys so accounts re-transfer freely in later runs; status and action checks mirror the protocol vocabulary. Drizzle mirrored. The transfer service follows in stage 3. Same-stage bookkeeping: B-716 / §26.732 / §30 row 2.550.

## §26.733 — SCR-110 stage 3: transfer service and segment wiring

**B-717.** `transferGlAccounts` stands: companies and chart judged, every in-range account judged before any write, segments created/updated/skipped per the test-run and overwrite policy in one transaction with the run protocol (test runs persist protocol only), and invalid source values (a malformed segment currency) report ERROR instead of being substituted. The segment now governs where it stands: line-item open/cleared judgement coalesces segment-over-chart, posting refuses on a segment posting block naming the company, and the account display lists segments read-only beside the chart record. The transfer screen executes on submit (test run by default). Capability and alias follow in stage 4. Same-stage bookkeeping: B-717 / §26.733 / §30 row 2.551.

## §26.734 — SCR-110 stage 4: transfer capability and FS15 alias

**B-718.** Seed grows by the `CFG.FIN.GLACCOUNT.TRANSFER` config activity and capability (142 total), and the transfer term carrying the FS15 search alias (115 terms / 133 aliases), routed at `/config/gl-accounts/transfer`; administrators hold it through the wildcard. Seeded twice, idempotent. Tests and browser acceptance follow in stage 5. Same-stage bookkeeping: B-718 / §26.734 / §30 row 2.552.

## §26.735 — SCR-110 stage 5: transfer tests and browser target

**B-719.** Four service tests cover FS15 (test run previews and persists protocol only; live create → skip → overwrite-update; chart-only skipping and judged selections; segment-first posting block and open-item judgement) — green with the registry. Browser target T886 (gl-account-transfer) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-719 / §26.735 / §30 row 2.553.

## §26.736 — SCR-110 CLOSED: FS15 G/L account master transfer accepted

**B-720.** FS15 is accepted with SAP parity: the company-code segment of the G/L master now stands (migration 0116, backfilled from chart values), governs where it stands (open-item judgement and posting blocks read it first, chart flags remain the fallback), and transfers between company codes on a shared chart under test-run/overwrite policy with a persisted per-account protocol — chart-level records never overwritten for a company difference, nothing posted. Production build green; browser target T886 passed (test run previews CREATED copying nothing, live run creates the segment, zero journals); full suite 1494/1494. Deferred by name: a standalone segment editor (segments maintain through FS15, display read-only), chart-level flag retirement, and FIN.RPT.CASHFLOW, still Roadmap awaiting its package. FUNCTIONS-AND-ROADMAP updated same turn (As-of SCR-110; 142 capabilities / 115 business terms). Next SCR: FIN.RPT.CASHFLOW (cash-flow statement) — package awaited; the SCR after: FIN.RPT.PROFITLOSS. Same-stage bookkeeping: B-720 / §26.736 / §30 row 2.554.

## §26.737 — Roadmap decision: cash-flow statement later, SCR-111 proceeds to profit & loss

**B-721 (owner decision, 2026-10-19).** The owner confirms S_ALR_87012271/72/73 were fully given and are delivered as the G/L reporting suite (SCR-108/109 closed); a distinct cash-flow statement (operating/investing/financing) is still wanted **later**, under its own package when the owner sends it. FIN.RPT.CASHFLOW stays Roadmap; its aliases are settled with that package (the three S_ALR codes remain on the suite terms). SCR-111 proceeds to **FIN.RPT.PROFITLOSS**; its package is awaited. Same-turn bookkeeping: B-721 / §26.737 / §30 row 2.555.

## §26.738 — SCR-111 contract: profit and loss statement (FIN.RPT.PROFITLOSS)

**B-722. R-159 (owner package S_ALR_87012284 re-issued for the P&L statement, 2026-10-19).** A dedicated profit and loss statement over the SCR-106/107 canon — same FSV tables, same posted-journal snapshot, nothing persisted. What is new: (1) **P&L-only presentation** — the statement restricts to profit-and-loss accounts (judged by `gl_account.is_balance_sheet`), drops balance-sheet-only subtrees, and recomputes node roll-ups from the kept accounts, so no balance-sheet figure can leak into a P&L total; (2) **range vs year-to-date** — every account and node carries both the period movement strictly inside the selected range and the cumulative movement through the cutoff (periods 1..cutoff), with comparative equivalents computed independently for the comparison year and range, variance and zero-denominator variance % as settled; (3) the net result stays explicit as the current-year result. Calculation reuses `calculateBalanceSheet` under COMBINED (its rows gain the account class and the two year-to-date figures), and the P&L service filters and re-rolls — one snapshot, no second aggregation. Special periods only when included (clamp + warn); output currency ratio-aware with the missing-rate warning; summary level folds presentation-only; unassigned P&L accounts named, never dropped; drill-down to FS10N-equivalent balances and FAGLL03-equivalent line items with company/ledger/year/account/period context. §3's index duty is verification (0098/0115, as SCR-107). Alias settled: S_ALR_87012284 stays with the balance-sheet term; **S_PL0_86000028 is ceded to the P&L term** (the balance sheet keeps S_ALR_87012284 + FC10), since an alias lives on exactly one term. **Deferred by name:** layout variant persistence, interactive node collapse, sorting (as SCR-107/109). Capability `FIN.RPT.PROFITLOSS`. Stage order: UI shell → index verification → service → supporting → tests/acceptance. Same-stage bookkeeping: B-722 / §26.738 / §30 row 2.556.

## §26.739 — SCR-111 stage 1: P&L vocabulary and shell

**B-723.** The profit-loss module carries the P&L-only vocabulary (range movement and year-to-date movement side by side, independent comparatives, the explicit result) and `/finance/profit-loss` renders the full selection over an inert grid; i18n `pl.*` keys added. Index verification follows in stage 2. Same-stage bookkeeping: B-723 / §26.739 / §30 row 2.557.

## §26.740 — SCR-111 stage 2: index and snapshot verification

**B-724.** Package §3 resolves to verification, as SCR-107: the P&L statement reuses the SCR-106 journal snapshot and FSV tables, whose aligned indexes stand in migrations 0098/0115; the index contract now also asserts the derivation classifies accounts from the master (`is_balance_sheet`) and persists nothing. No new table, no new migration (179 stands). (The stage-2 test rode in the stage-1 commit — recorded here as its own stage entry; the stages are not merged again.) The service follows in stage 3. Same-stage bookkeeping: B-724 / §26.740 / §30 row 2.558.

## §26.741 — SCR-111 stage 3: P&L service over the combined statement

**B-725.** `calculateProfitLoss` stands: one COMBINED snapshot whose account rows now carry the master account class and both cumulative figures, then balance-sheet accounts are removed and every surviving node's totals are re-rolled from its kept accounts — a node survives only when its subtree holds a P&L account, so no balance-sheet figure leaks into a P&L total. Range movement and year-to-date movement stand side by side with independent comparatives; unassigned P&L accounts are named. The `/finance/profit-loss` report renders the grid with CSV export and both drill-downs. Capability and alias follow in stage 4. Same-stage bookkeeping: B-725 / §26.741 / §30 row 2.559.

## §26.742 — SCR-111 stage 4: capability, alias cession, navigation

**B-726.** Seed grows by the FIN.RPT.PROFITLOSS capability (143 total) and the profit-and-loss term (116 terms); **S_PL0_86000028 is ceded from the balance-sheet term to the P&L term** through a repair delete in the OX09 precedent (the balance sheet keeps S_ALR_87012284 + FC10; aliases stay 133), and the journal list gains the profit-and-loss entry. Seeded twice, idempotent; the alias ownership verified in the database. Tests and browser acceptance follow in stage 5. Same-stage bookkeeping: B-726 / §26.742 / §30 row 2.560.

## §26.743 — SCR-111 stage 5: P&L tests and browser target

**B-727.** Two service tests cover the statement (P&L-only node set with range beside year-to-date movements and independent comparatives; balance-sheet accounts dropped entirely and quiet ranges zeroing without error) — green with the SCR-107 regression suite. Browser target T885 (profit-loss) is registered with its acceptance-database guard and stays unaccepted until the browser run after the push. Same-stage bookkeeping: B-727 / §26.743 / §30 row 2.561.

## §26.744 — SCR-111 CLOSED: profit and loss statement accepted

**B-728.** FIN.RPT.PROFITLOSS is accepted: a P&L-only statement over the SCR-107 combined snapshot — balance-sheet accounts removed, node totals re-rolled from kept accounts, range movement beside year-to-date movement with independent comparatives and the explicit current-year result. Production build green; browser target T885 passed (Revenue movement standing, no balance-sheet node present, explicit result, nothing persisted); full suite 1498/1498. S_PL0_86000028 now belongs to the P&L term (ceded from the balance sheet, which keeps S_ALR_87012284 + FC10). Deferred by name: layout variant persistence, interactive node collapse, sorting; FIN.RPT.CASHFLOW remains for its own later package (B-721). FUNCTIONS-AND-ROADMAP flipped same turn (P&L Implemented; 143 capabilities / 116 business terms). Next SCR: FIN.RPT.COSTCENTER.ACTUAL (cost centre actual vs plan); its package is awaited. The SCR after: FIN.RPT.PROFITCENTER. Same-stage bookkeeping: B-728 / §26.744 / §30 row 2.562.

## §26.745 — SCR-112 contract: cost centers actual/plan/variance (FIN.RPT.COSTCENTER.ACTUAL)

**B-729. R-160 (owner package S_ALR_87013611, 2026-10-19; S_ALR_87013614 and KSB1N ride as aliases, KSB1N as the drill layer).** Canon check: actuals stand as journal lines carrying a cost centre (cost element = the posted G/L account — primary cost elements are the only posting source in canon; **secondary cost elements and internal allocations have no engine yet and are deferred by name**); activity plan quantities/prices stand in `activity_rate`; but **cost-element plan values have no table**, so stage 2 builds the minimal `cost_center_plan` (controlling area, plan version in the standing ≤3-char vocabulary default `000`, fiscal year, period, cost centre, cost element, planned amount) — plan-data entry UI deferred by name, this round maintains plan rows through fixtures/seed only. Settled: missing plan data is **null, never zero** (variance % null on missing or zero plan; an unknown version warns and reports actuals with missing plan rather than failing); variance = actual − plan with favorable/unfavorable judged by the element's account type (EXPENSE over plan unfavorable, REVENUE over plan favorable, else unrated); cost centres not valid in a reported period are excluded and named; figures aggregate in controlling-area currency from `amount_local`, lines posted in a differing company currency excluded with a warning (conversion deferred); range totals and year-to-date (periods 1..cutoff) stand as distinct measures; planned activity quantities and fixed/variable prices show where `activity_rate` stands, actual quantities null (no actual-allocation source in canon); group selection resolves through standing cost-centre groups, the tree through the SCR-042 hierarchy; closed periods report normally. Drill-down: centre/element → journal line items filtered by cost centre → document display, context preserved. Index duty is verification (journal cost-centre and header paths; the plan table keys itself). Capability `FIN.RPT.COSTCENTER.ACTUAL`; no posting, no reposting, ever. Stage order: UI shell → plan schema + index verification → report service → supporting → tests/acceptance. Same-stage bookkeeping: B-729 / §26.745 / §30 row 2.563.

## §26.746 — SCR-112 stage 1: report vocabulary and shell

**B-730.** The cost-center-report module carries the actual/plan vocabulary (plan as nullable — missing is never zero — variance status judged by account type, range beside year-to-date), and `/controlling/cost-center-report` renders the full §1 selection over an inert grid. The plan schema follows in stage 2. Same-stage bookkeeping: B-730 / §26.746 / §30 row 2.564.

## §26.747 — SCR-112 stage 2: cost-element plan table

**B-731.** Migration 0117 (180 total) builds `cost_center_plan` keyed by tenant, controlling area, plan version, fiscal year, period, cost centre and cost element (period and version checks; FK to the controlling area) — the one canon table the actual/plan comparison was missing, with plan-entry UI deferred by name. Journal index paths verified; `tests/cost-center-report-index-contract.test.ts` (3 green) pins the alignment, and actuals keep deriving from the journal. The report service follows in stage 3. Same-stage bookkeeping: B-731 / §26.747 / §30 row 2.565.

## §26.748 — SCR-112 stage 3: cost-centre report service

**B-732.** `calculateCostCenterReport` (appended to the stage-1 vocabulary module) resolves the controlling area and its companies, judges centre validity per fiscal year, resolves group membership through `cost_center_group_leaf` ranges, aggregates POSTED journal actuals on `amount_local` (debit-positive) for the period range and periods 1..cutoff, joins `cost_center_plan` by version (default `000`) with plan signed by account type (REVENUE negative), and derives variance = actual − plan with missing plan null — never zero — and variance % null on missing/zero plan; status follows the signed variance (negative favourable, positive unfavourable). Hierarchy placement is judged at fiscal-year end through `cost_center_node_assignment`; unplaced centres gather under an explicit outside-hierarchy row; centres without validity in the year are excluded and named; foreign-currency lines are excluded with a warning, as is absent plan. Planned activity quantities and fixed/variable prices come from `activity_rate`; actual quantities stay null. The report page executes live and renders `reportError`; `tsc` is green and the stage-2 contract test holds at 3/3. Supporting seed follows in stage 4. Same-stage bookkeeping: B-732 / §26.748 / §30 row 2.566.

## §26.749 — SCR-112 stage 4: capability, aliases and navigation

**B-733.** Seed carries the `FIN.RPT.COSTCENTER.ACTUAL` capability and its registry term at `/controlling/cost-center-report`, with aliases S_ALR_87013611 (primary), S_ALR_87013614 and KSB1N (drill layer) all living on the one term; the journal page links the report (`journal.costCenterReport`). Seeded twice idempotent — catalogue 144 capabilities / 117 terms / 136 aliases, all three aliases verified solely on FIN.RPT.COSTCENTER.ACTUAL. Acceptance follows in stage 5. Same-stage bookkeeping: B-733 / §26.749 / §30 row 2.567.

## §26.750 — SCR-112 stage 5: service tests and browser target

**B-734.** `tests/cost-center-report.test.ts` (3 green) proves the signed comparison (expense over plan Unfavorable, revenue over plan Favorable), range beside periods 1..cutoff, missing plan null with null variance and status, excluded centres named, the outside-hierarchy group, the activity plan, the unknown-version warning, and read-only behaviour. Browser target T884 stands registered across targets/checks/database-guards. The shell grid rendering gap found against the stage-1 shell was completed under B-732 before acceptance. Full suite, production rebuild and browser acceptance follow before closure. Same-stage bookkeeping: B-734 / §26.750 / §30 row 2.568.

## §26.751 — SCR-112 closed: cost centre actual/plan report accepted

**B-735.** SCR-112 / FIN.RPT.COSTCENTER.ACTUAL is closed. The full suite stands at 1505/1505, the production build is green, and browser target T884 passed (actual 5,000.00 against plan 4,500.00 judged Unfavorable under the hierarchy group; the report persisted nothing). The cost centre actual/plan/variance report reads journal cost lines against the `cost_center_plan` table with missing plan null — never zero — hierarchy placement judged at fiscal-year end, group resolution through ranged leaves, excluded centres named, and planned activity quantities and prices from standing activity rates. Catalogue: 144 capabilities / 117 terms / 136 aliases; FUNCTIONS-AND-ROADMAP flips FIN.RPT.COSTCENTER.ACTUAL to Implemented (SCR-112, B-735) with headline alias S_ALR_87013611. Deferred by name: secondary cost elements and internal allocations, the plan-entry UI, actual activity quantities, and currency conversion. Next in the frozen order: SCR-113 / FIN.RPT.PROFITCENTER, then FIN.RPT.SUBLEDGER.TIE; FIN.RPT.CASHFLOW follows under its own later package (B-721), and intercompany items remain last (B-663). Same-stage bookkeeping: B-735 / §26.751 / §30 row 2.569.

## §26.752 — SCR-113 contract: profit centre actual line items (KE5Z)

**B-736 / R-161.** Owner package KE5Z (Profit Center: Actual Line Items) lands as FIN.RPT.PROFITCENTER, settled against canon. Source is the journal itself — `journal_entry` + `journal_entry_line` POSTED lines carrying a `profit_center` (the universal-journal equivalent of §14.1); no classic PCA tables stand and none are added, and no report-specific posting tables. Selection: controlling area (validated, required); profit centre single/range/group (groups resolve through `profit_center_group_leaf` ranges, mirroring SCR-112); fiscal year; period from/to (1–16, from ≤ to); G/L account range; ledger required, default `0L` — canon carries the one leading ledger, so any other ledger is refused naming that only the leading ledger stands (multi-ledger remains deferred as under SCR-108/109); optional document number exact/range; maximum hits default 5000, validated positive with a hard cap of 50000, applied server-side with a truncation indicator and narrower-filter guidance when exceeded. Each row shows company, document number, fiscal year, line, posting and document dates, document type, ledger, profit centre, G/L account, debit/credit, document currency and signed amount, local currency and signed amount, assignment, reference, line text, and the recorded originating objects (cost centre, internal order, production order, business partner, material, plant) plus origin class/key from the header. Totals stand by profit centre, G/L account and currency, document-currency and local totals kept separate, never converted together. Lines keep the profit centre recorded at posting — never re-derived from current master; selected centres must belong to the controlling area, and centres without validity in the reported year are named; closed periods never suppress history. Read-only throughout. Drill-down reaches the accounting document display with selection context preserved on return. Deferred by name: partner profit centre (not recorded on canon lines), G/L account groups (no master stands — ranges only), KE5Y plan line items and profit-centre planning, interactive sorting/filtering (fixed server order: profit centre, account, posting date, document, line), and direct operational-document navigation beyond the journal display's origin reference. Route `/controlling/profit-center-report`; alias KE5Z on the FIN.RPT.PROFITCENTER term. Stage order: 1 vocabulary/shell, 2 schema/index check, 3 line-item service, 4 seed/navigation, 5 tests/acceptance. Same-stage bookkeeping: B-736 / §26.752 / §30 row 2.570.

## §26.753 — SCR-113 stage 1: line-item vocabulary and shell

**B-737.** `src/modules/foundation/profit-center-report.ts` carries the KE5Z vocabulary: selection (controlling area, profit centre range/group, fiscal year, periods, ledger default `0L`, account and document ranges, maximum hits default 5000 capped at 50000), the line shape (document/line/dates/type, profit centre, account, signed document and local amounts, assignment, reference, text, originating objects, origin class/key), totals by profit centre/account/currency, and an always-indicated truncation flag. The `/controlling/profit-center-report` page and shell render the full §1 selection over the inert line grid; execution arrives in stage 3. `tsc` green. Index check follows in stage 2. Same-stage bookkeeping: B-737 / §26.753 / §30 row 2.571.

## §26.754 — SCR-113 stage 2: profit-centre journal index

**B-738.** The index check found the account, cost-centre and header paths standing but no profit-centre path: migration 0118 (181 total) adds `jel_profitcenter_idx` on `(client, profit_center, fiscal_year, company_code)` over `journal_entry_line`, mirrored in the Drizzle schema — tenant first, aligned to the KE5Z query, declaring no new tables. `tests/profit-center-report-index-contract.test.ts` (3 green) pins the alignment and the vocabulary's single-ledger and no-partner-column settlements; `tsc` green. The line-item service follows in stage 3. Same-stage bookkeeping: B-738 / §26.754 / §30 row 2.572.

## §26.755 — SCR-113 stage 3: profit centre line-item service

**B-739.** `listProfitCenterLines` (appended to the stage-1 vocabulary module) refuses any ledger but `0L` by name, validates the area, its companies, the period range and the ranges, resolves profit centres from master validity in the reported year (group membership through `profit_center_group_leaf` ranges; named bounds that do not stand in the area are refused; invalid centres are excluded and named), then reads POSTED journal lines as recorded at posting — never re-derived — signed by debit/credit in both document and local currency, ordered profit centre/account/posting date/document/line, windowed server-side at the hit limit with an indicated truncation. Totals aggregate the complete selection by profit centre, account and both currencies, kept separate so they reconcile to the canonical lines. The page executes live, renders `reportError`, and each document number drills to the journal document display; the GET selection preserves context on return. `tsc` green, stage-2 contract holds 3/3. Supporting seed follows in stage 4. Same-stage bookkeeping: B-739 / §26.755 / §30 row 2.573.

## §26.756 — SCR-113 stage 4: capability, alias and navigation

**B-740.** Seed carries the `FIN.RPT.PROFITCENTER` capability and its registry term at `/controlling/profit-center-report` with alias KE5Z living on the one term; the journal page links the report (`journal.profitCenterReport`). Seeded twice idempotent — catalogue 145 capabilities / 118 terms / 137 aliases, KE5Z verified solely on FIN.RPT.PROFITCENTER. Acceptance follows in stage 5. Same-stage bookkeeping: B-740 / §26.756 / §30 row 2.574.

## §26.757 — SCR-113 stage 5: service tests and browser target

**B-741.** `tests/profit-center-report.test.ts` (4 green) proves lines listed as recorded with signed amounts and reconciling totals, the hit-limit window with totals complete over the full selection, group resolution with exclusion leaves in display order, named refusals for non-leading ledgers and unknown profit centres, and read-only behaviour; browser target T883 stands registered across targets/checks/database-guards. One settlement sharpened in this stage: profit-centre groups resolve `E` (exclude) leaves in display order per SCR-042 canon — and the same check exposed that the SCR-112 cost-centre resolver treats every leaf as an inclusion, a named follow-up recorded here rather than silently left. Full suite, production rebuild and browser acceptance follow before closure. Same-stage bookkeeping: B-741 / §26.757 / §30 row 2.575.

## §26.758 — SCR-113 closed: profit centre actual line items accepted

**B-742.** SCR-113 / FIN.RPT.PROFITCENTER is closed. The full suite stands at 1513/1513, the production build is green, and browser target T883 passed (the posted line stands with its profit centre and signed amount; the report persisted nothing). Profit centre actual line items read the posted journal exactly as recorded — never re-derived — with the leading-ledger refusal by name, group resolution honouring exclusion leaves in display order, a server-side hit limit whose truncation is always indicated, and totals reconciling by profit centre, account and currency. Catalogue: 145 capabilities / 118 terms / 137 aliases; FUNCTIONS-AND-ROADMAP flips FIN.RPT.PROFITCENTER to Implemented (SCR-113, B-742), alias KE5Z. Deferred by name: partner profit centre, G/L account groups, KE5Y plan line items, interactive sorting/filtering. Named follow-up: the SCR-112 cost-centre group resolver still treats every leaf as an inclusion (E leaves ignored) — repair with tests under its own bookkeeping. Next in the frozen order: FIN.RPT.SUBLEDGER.TIE, then FIN.CONSOLIDATE and FIN.CONSOLIDATE.STMT; FIN.RPT.CASHFLOW follows under its own later package (B-721), and intercompany items remain last (B-663). Same-stage bookkeeping: B-742 / §26.758 / §30 row 2.576.

## §26.759 — SCR-114 contract: clear G/L account, manual clearing (F-03)

**B-743 / R-162.** Owner package F-03 (Clear G/L Account) supersedes the announced SCR-114 scope: the tie-out report (FIN.RPT.SUBLEDGER.TIE, F.03 Reconciliation) stays Roadmap and follows after; this round builds manual G/L clearing as FIN.GL.CLEAR, following the FIN.AR.CLEAR / FIN.AP.CLEAR house pattern. Settled against canon: the screen takes company code, G/L account, clearing date (default today), an operator-selected document type validated against configured document types (never a universal hardcoded type), and filters (document number, posting date, assignment, reference, amount). The account must stand extended to the company and stand open-item managed, judged segment-first on `gl_account_company.is_open_item_managed` with the chart flag as fallback (SCR-110 settlement). Open items are POSTED journal lines of that company/account with no clearing document, shown with selection controls and a running signed balance; cleared, reversed and parked items never appear. Posting revalidates every item inside one transaction under row locks (`select … for update`), refuses any item already cleared by another session naming the clearing document, requires one document currency across the selection, and requires the signed local difference to be exactly zero — tolerance-based difference posting is deferred by name (as residual clearing stood deferred under AR), never silently discarded. A balanced clearing posts a real offsetting accounting document through the standing posting engine (`postJournalEntry`: period controls, numbering and reversal rules included) and stamps `clearing_document`/`clearing_date` on the source lines and the clearing lines atomically; the clearing document number and fiscal year return with navigation to the document display. Clearing date in a closed period is rejected by the posting engine's period controls. No new tables; clearing history rides the change-document audit (user, timestamp, company, account, items, document, amounts). Reset rides the standing FBRA workflow (FIN.CLEARING.RESET). Deferred by name: tolerance difference posting, partial/residual clearing, multi-currency clearing, automatic clearing (F.13, already Deferred with FF.5). Route `/finance/gl-clearing`; alias F-03 on the FIN.GL.CLEAR term. Stage order: 1 UI shell, 2 schema/index check, 3 clearing service, 4 seed/navigation, 5 tests/acceptance. Same-stage bookkeeping: B-743 / §26.759 / §30 row 2.577.

## §26.760 — SCR-114 stage 1: G/L clearing shell

**B-744.** `src/modules/finance/gl-clearing.ts` carries the F-03 vocabulary (capability FIN.GL.CLEAR, item/view shapes, error class) and `/finance/gl-clearing` renders the selection (company, account, document/assignment/reference filters), the open-item grid with selection controls and running signed difference, the clearing/document/posting date and document-type fields with confirm gate, and cleared history — all over the inert vocabulary; loading and posting arrive in stage 3. `tsc` green. Schema/index check follows in stage 2. Same-stage bookkeeping: B-744 / §26.760 / §30 row 2.578.

## §26.761 — SCR-114 stage 2: clearing schema check, no migration

**B-745.** The check found the canon complete: `clearing_document`/`clearing_date` stand on `journal_entry_line` with `jel_clearing_idx`, open-item management stands on both the chart account and the company segment, and `jel_company_account_idx` serves the open-item read — so SCR-114 adds no migration (181 stand) and no clearing-allocation table; the stamped clearing reference is the relationship, as under AR/AP clearing. `tests/gl-clearing-schema-contract.test.ts` (3 green) pins the canon and the deferred-difference settlement. The clearing service follows in stage 3. Same-stage bookkeeping: B-745 / §26.761 / §30 row 2.579.

## §26.762 — SCR-114 stage 3: G/L clearing service

**B-746.** `getGlClearing` and `clearGlItems` land in the stage-1 vocabulary module, mirroring the FIN.AR.CLEAR pattern: the account is judged extended to the company and open-item managed (segment-first, chart fallback); open items are POSTED uncleared lines with document/assignment/reference/date filters; clearing re-reads every item under row locks inside one transaction with an advisory lock per company/account, refuses items already cleared naming the clearing document, requires one currency and an exactly-zero signed difference (tolerance named deferred), validates the operator-selected document type against configured types, posts the offsetting clearing document through the standing posting engine (period controls included), stamps source and clearing lines atomically, and records the change-document audit with request-key replay. The page loads the view on selection and the shell posts through the server action. `tsc` green. Supporting seed follows in stage 4. Same-stage bookkeeping: B-746 / §26.762 / §30 row 2.580.

## §26.763 — SCR-114 stage 4: capability and alias

**B-747.** Seed carries the `FIN.GL.CLEAR` capability and its registry term at `/finance/gl-clearing` with alias F-03 living on the one term (no journal-page link, following the FIN.AR.CLEAR screen pattern — discovery rides the registry route). Seeded twice idempotent — catalogue 146 capabilities / 119 terms / 138 aliases, F-03 verified solely on FIN.GL.CLEAR. Acceptance follows in stage 5. Same-stage bookkeeping: B-747 / §26.763 / §30 row 2.581.

## §26.764 — SCR-114 stage 5: service tests and browser target

**B-748.** `tests/gl-clearing.test.ts` (4 green) proves the open-item-management refusal, the open-item listing at zero standing balance, the unbalanced-selection and unconfigured-document-type refusals, the clearing journal posting with source and clearing lines stamped, request-key replay without a second clearing, and the already-cleared refusal naming the clearing document; browser target T882 stands registered across targets/checks/database-guards. Full suite, production rebuild and browser acceptance follow before closure. Same-stage bookkeeping: B-748 / §26.764 / §30 row 2.582.

## §26.765 — SCR-114 closed: clear G/L account accepted

**B-749.** SCR-114 / FIN.GL.CLEAR is closed. The full suite stands at 1521/1521, the production build is green, and browser target T882 passed (two balancing items cleared, source and clearing lines stamped in the database). Manual G/L clearing judges the account extended and open-item managed segment-first, locks and revalidates every item at posting, posts a real offsetting clearing document through the standing posting engine under an operator-selected configured document type, stamps lines atomically, replays on request key, and audits through change documents; reset rides the standing FBRA workflow. Catalogue: 146 capabilities / 119 terms / 138 aliases; FUNCTIONS-AND-ROADMAP carries FIN.GL.CLEAR as Implemented (SCR-114, B-749), alias F-03. Deferred by name: tolerance-based difference posting, partial/residual and multi-currency clearing. Next in the frozen order: FIN.RPT.SUBLEDGER.TIE (the F.03 Reconciliation report), then FIN.CONSOLIDATE / FIN.CONSOLIDATE.STMT; FIN.RPT.CASHFLOW follows under its own later package (B-721), intercompany last (B-663), and the SCR-112 exclusion-leaf resolver repair stands as a named follow-up. Same-stage bookkeeping: B-749 / §26.765 / §30 row 2.583.

## §26.766 — SCR-115 contract: G/L to subledger tie-out (F.03 Reconciliation)

**B-750 / R-163.** Owner research settles the tie-out shape: the G/L balance of each reconciliation account (FS10N side, alias standing on FIN.GL.BALANCE) matched against the subledger total (FBL1N/FBL5N side). FIN.RPT.SUBLEDGER.TIE therefore compares, per company code, fiscal year and cumulative periods 1..period-to, every G/L account whose `reconciliation_type` stands CUSTOMERS or VENDORS: the account total over all POSTED journal lines against the subledger total over the lines carrying a business partner, both signed on `amount_local`, with the difference named TIED or EXCEPTION — never netted away. Under each account, partner rows carry each partner's total, and partnerless lines (direct postings to a reconciliation account) stand as the exception detail, since a reconciliation account should only ever move through its subledger. A second exception names partners whose posted lines stand on an account other than the reconciliation account their company segment assigns. Selection: company (required), fiscal year, period to (1–16), optional account range; ledger `0L` only, refused by name as before; read-only, closed periods report normally. Drill-down: account and partner rows reach the journal line-item report with company, account and year context preserved. Balances stand in company local currency per company; document-currency totals are not mixed in. Aliases: FAGLB03 (owner research) and F.03 on the FIN.RPT.SUBLEDGER.TIE term; FS10N stays on FIN.GL.BALANCE and FBL1N/FBL5N remain with the partner reports. Deferred by name: ASSETS and MATERIAL reconciliation types, period-movement (non-cumulative) comparison, and multi-ledger. Route `/finance/subledger-tie-out`. Stage order: 1 vocabulary/shell, 2 index check, 3 tie-out service, 4 seed/navigation, 5 tests/acceptance. Same-stage bookkeeping: B-750 / §26.766 / §30 row 2.584.

## §26.767 — SCR-115 stage 1: tie-out vocabulary and shell

**B-751.** `src/modules/finance/subledger-tie-out.ts` carries the F.03 vocabulary: selection (company, fiscal year, period to, ledger `0L`, account range), ACCOUNT/PARTNER rows with G/L total beside subledger total, difference and TIED/EXCEPTION status, and the partnerless exception counters. The `/finance/subledger-tie-out` page and shell render the selection over the inert grid with journal-items drill links staged; execution arrives in stage 3. `tsc` green. Index check follows in stage 2. Same-stage bookkeeping: B-751 / §26.767 / §30 row 2.585.

## §26.768 — SCR-115 stage 2: tie-out index check, no migration

**B-752.** The check found the canon complete: reconciliation types stand on the chart account with the CUSTOMERS/VENDORS/ASSETS/MATERIAL vocabulary, `jel_account_idx` serves the account total and the partner index path the subledger total — so SCR-115 adds no migration (181 stand) and no tie-out tables; both totals derive from the one journal at read time. `tests/subledger-tie-schema-contract.test.ts` (3 green) pins the canon. The tie-out service follows in stage 3. Same-stage bookkeeping: B-752 / §26.768 / §30 row 2.586.

## §26.769 — SCR-115 stage 3: subledger tie-out service

**B-753.** `calculateSubledgerTie` (appended to the stage-1 vocabulary module) refuses any ledger but `0L` by name, resolves the company and its chart, takes every CUSTOMERS/VENDORS reconciliation account, and compares — cumulatively through period-to over POSTED lines — the account total against the partner-carrying subledger total, naming each account TIED or EXCEPTION with the difference never netted away. Partner rows break the subledger total down by partner; partnerless lines stand as counted exception detail with a warning; partners posting away from their segment-assigned reconciliation account are named. The page executes live and renders `reportError`; account rows drill to the journal line-item report. `tsc` green. Supporting seed follows in stage 4. Same-stage bookkeeping: B-753 / §26.769 / §30 row 2.587.

## §26.770 — SCR-115 stage 4: capability, aliases and navigation

**B-754.** Seed carries the `FIN.RPT.SUBLEDGER.TIE` capability and its registry term at `/finance/subledger-tie-out`, aliases FAGLB03 and F.03 living on the one term while FS10N stays verified on FIN.GL.BALANCE; the journal page links the report (`journal.subledgerTie`). Seeded twice idempotent — catalogue 147 capabilities / 120 terms / 140 aliases. Acceptance follows in stage 5. Same-stage bookkeeping: B-754 / §26.770 / §30 row 2.588.

## §26.771 — SCR-115 stage 5: service tests and browser target

**B-755.** `tests/subledger-tie-out.test.ts` (4 green) proves the named exception where partnerless lines stand on a reconciliation account (7,500 against 7,000, difference 500), the TIED verdict for an account moving only through its subledger, partner rows, the misassignment warning for a partner posting away from its segment account, the non-leading-ledger refusal, and read-only behaviour; browser target T881 stands registered across targets/checks/database-guards. Full suite, production rebuild and browser acceptance follow before closure. Same-stage bookkeeping: B-755 / §26.771 / §30 row 2.589.

## §26.772 — SCR-115 closed: subledger tie-out accepted

**B-756.** SCR-115 / FIN.RPT.SUBLEDGER.TIE is closed. The full suite stands at 1529/1529, the production build is green, and browser target T881 passed (the account stands as a named exception: 7,500.00 against 7,000.00; the report persisted nothing). Per company, fiscal year and cumulative periods, every CUSTOMERS/VENDORS reconciliation account compares its account total against its partner-carrying total, differences named TIED or EXCEPTION at zero tolerance, partner rows under each account, partnerless direct postings as the exception detail, and misassigned partners named. Acceptance found one genuine gap — `GlDocumentLineInput` did not carry `businessPartner` although the posting engine stamps it — completed under B-755 before the build passed. Catalogue: 147 capabilities / 120 terms / 140 aliases; FUNCTIONS-AND-ROADMAP flips FIN.RPT.SUBLEDGER.TIE to Implemented (SCR-115, B-756), alias FAGLB03 (F.03 also on the term). Deferred by name: ASSETS and MATERIAL reconciliation types, period-movement comparison, multi-ledger. Next in the frozen order: FIN.CONSOLIDATE, then FIN.CONSOLIDATE.STMT; FIN.RPT.CASHFLOW follows under its own later package (B-721), intercompany last (B-663), and the SCR-112 exclusion-leaf resolver repair stands as a named follow-up. Same-stage bookkeeping: B-756 / §26.772 / §30 row 2.590.

## §26.773 — SCR-116 contract: consolidation workbench (UCWB)

**B-757 / R-164.** Owner package UCWB lands as FIN.RPT.CONSOLIDATE, a configuration workbench — never an execution or posting transaction. Settled against canon: the workbench at `/config/consolidation` organizes five folders (Data Basis, Master Data, Consolidation Chart & Mappings, Methods, Task Hierarchies) under a consolidation area (CHAR 4) carrying its data basis, consolidation chart (CHAR 4), fiscal-year variant (CHAR 2) and status. The data basis binds the standing journal provider only (BW providers deferred by name; no SAP BW table names enter the schema) with dimensions drawn from standing journal characteristics. Master data stores consolidation units (each bound to a standing company code) and groups with acyclic parents; unit-to-group assignments are time-dependent and reject overlapping validity. The consolidation chart holds group accounts and source-account mappings validated against standing charts and accounts. Methods are configuration only, kinded CURRENCY_TRANSLATION / INTERCOMPANY_ELIMINATION / INVESTMENT / OTHER — intercompany elimination execution stays deferred to last (B-663). Versions are CHAR 3 keys (actual/plan words in titles). Task hierarchies carry a stable task ID, parent, sequence, type, validity interval, and references to method/unit/group that must stand before save; incomplete configuration cannot activate — activation judges basis, chart, variant, at least one unit and one task, and only an ACTIVE area may serve later execution. Every write is transactional with a mandatory reason and one change document; history is corrected by versioning, never deleted. Transports are not assumed (no CTS in a standalone ERP) and are deferred by name, as are the UCMON monitor/execution (which owns task status and runs) and FIN.CONSOLIDATE.STMT consolidated statements. Capability FIN.RPT.CONSOLIDATE; alias UCWB on the term. Stage order: 1 workbench shell, 2 schema, 3 configuration service, 4 seed/navigation, 5 tests/acceptance. Same-stage bookkeeping: B-757 / §26.773 / §30 row 2.591.

## §26.774 — SCR-116 stage 1: workbench vocabulary and shell

**B-758.** `src/modules/finance/consolidation-workbench.ts` carries the UCWB vocabulary (folders, journal-only provider, method kinds, task types, area/unit/group/assignment/chart/mapping/method/version/task shapes) and `/config/consolidation` renders the area context, the five-folder tree and per-folder grids over the inert vocabulary; maintenance arrives in stage 3. `tsc` green. Schema follows in stage 2. Same-stage bookkeeping: B-758 / §26.774 / §30 row 2.592.

## §26.775 — SCR-116 stage 2: consolidation configuration schema

**B-759.** Migration 0119 (182 total) builds eleven normalized configuration tables — data basis (journal provider only), dimensions, area (FK to basis and fiscal-year variant, DRAFT/ACTIVE), units (FK to company code), groups (self-parent), time-dependent unit assignments with validity checks, group accounts, account mappings, methods, versions, and tasks carrying method/unit/group foreign keys — mirrored in the Drizzle schema; no results, postings or BW names. `tests/consolidation-workbench-schema-contract.test.ts` (3 green) pins the alignment; `tsc` green. The configuration service follows in stage 3. Same-stage bookkeeping: B-759 / §26.775 / §30 row 2.593.

## §26.776 — SCR-116 stage 3: consolidation configuration service

**B-760.** The workbench service lands on the stage-1 module: data bases bind the journal provider with dimensions judged against standing journal characteristics; areas judge basis and fiscal-year variant; units judge the company code; groups and tasks judge parents acyclically; unit assignments refuse overlapping validity per unit; mappings judge source chart, source account and group account; tasks refuse references to unconfigured methods, units or groups; activation refuses incomplete areas naming what is missing. Every write takes a mandatory reason and records one change document; the shell posts each folder's maintenance through server actions and the page loads areas and view live. `tsc` green. Supporting seed follows in stage 4. Same-stage bookkeeping: B-760 / §26.776 / §30 row 2.594.

## §26.777 — SCR-116 stage 4: capability and alias

**B-761.** Seed carries the `FIN.RPT.CONSOLIDATE` capability and its registry term at `/config/consolidation` with alias UCWB living on the one term (discovery rides the registry route, following the config-screen pattern). Seeded twice idempotent — catalogue 148 capabilities / 121 terms / 141 aliases, UCWB verified solely on FIN.RPT.CONSOLIDATE. Acceptance follows in stage 5. Same-stage bookkeeping: B-761 / §26.777 / §30 row 2.595.

## §26.778 — SCR-116 stage 5: service tests and browser target

**B-762.** `tests/consolidation-workbench.test.ts` (3 green) proves dimension/reason/reference refusals, acyclic groups, overlap-refused assignments, mapping and task configuration, activation refused while incomplete then ACTIVE, and that configuration posts nothing; browser target T880 stands registered across targets/checks/database-guards. Full suite, production rebuild and browser acceptance follow before closure. Same-stage bookkeeping: B-762 / §26.778 / §30 row 2.596.

## §26.779 — SCR-116 closure: consolidation workbench accepted

**B-763, recorded 2026-10-19.** SCR-116 / FIN.RPT.CONSOLIDATE (UCWB, R-164) is accepted and closed: full suite **1536/1536**, production build green, **browser target T880 PASSED**. Consolidation configuration now stands as normalized, versioned configuration: data basis bound to the JOURNAL provider, areas with cons chart and fiscal-year variant, units bound to company codes, acyclic groups, overlap-refused unit assignments, group accounts and source mappings, configuration-only methods, versions, task hierarchies, and the activation gate — every write with a mandatory reason and one change document, and configuration never posts. A stage-5 build failure (client shell importing service vocabulary through the database client) was corrected by splitting `consolidation-vocabulary.ts` from the service module, committed separately under B-762 before acceptance ran. Catalogue 148 capabilities / 121 terms / 141 aliases; migrations 182. Deferred by name: transports, the UCMON-equivalent monitor (FIN.CONSOLIDATE), BW providers, FIN.RPT.CONSOLIDATE.STMT. Next: FIN.CONSOLIDATE (UCMON / CX20, consolidation monitor and execution) — awaiting its field package; the workbench stands ready to be executed by it. Second-next: consolidated statements FIN.RPT.CONSOLIDATE.STMT (CX20). Same-stage bookkeeping: B-763 / §26.779 / §30 row 2.597.

## §26.780 — SCR-117 contract: consolidation monitor (CX20)

**B-764 / R-165.** Owner package CX20 lands as FIN.CONSOLIDATE, the consolidation monitor at `/finance/consolidation-monitor`, separate from UCWB configuration (FIN.RPT.CONSOLIDATE). The monitor selects an ACTIVE consolidation area, a configured group valid for the period, a configured version, fiscal year and posting period judged against the area's fiscal-year variant, an optional root task as the task-group filter, an optional unit inside the selected group, and Test Run by default or Update Run. It displays the configured units in the group against the ordered task hierarchy; task order and prerequisites derive from UCWB parentage and sequence, never a hardcoded task sequence. Parent tasks are prerequisites for the same tenant, area, group/unit scope, version, fiscal year and period, and are revalidated under lock immediately before execution. Current task state stands apart from immutable execution history: every attempt receives a unique run ID and records scope, task configuration fingerprint, mode, status, user, start/end, duration, summary, counts, warnings, errors and generated-document references. States move OPEN → RUNNING → COMPLETED/WARNING/ERROR, with BLOCKED naming unmet prerequisites or unavailable processing; repeated attempts never overwrite earlier runs. Test runs simulate and commit no consolidation result or journal; Update runs invoke only processing adapters that stand. This round's adapters are journal data collection and configuration/data validation over the JOURNAL provider; currency translation, investment consolidation and intercompany elimination remain BLOCKED by name until their engines exist (intercompany last, B-663), so the monitor never invents consolidation journals. A database partial uniqueness guard plus a transactional recheck prevents duplicate simultaneous runs of one task scope. View, test, update, log and period-control authorities are separate capability checks; the monitor displays period standing and links to OB52 but never opens or closes FI periods itself. No task definition, method or dependency is maintained here — UCWB remains their owner. Stage order: 1 monitor vocabulary and shell, 2 execution schema, 3 monitor/execution service, 4 capability and aliases, 5 tests/acceptance. Same-stage bookkeeping: B-764 / §26.780 / §30 row 2.598.

## §26.781 — SCR-117 stage 1: monitor vocabulary and shell

**B-765.** `consolidation-monitor-vocabulary.ts` carries the client-safe FIN.CONSOLIDATE vocabulary (Test/Update modes, task and execution states, error policies, scope, matrix and immutable-log shapes, and the standing adapter boundary), and `/finance/consolidation-monitor` renders the area/group/version/year/period/task-group/unit/mode selection, Refresh, the unit-by-task monitor matrix and the execution-history panel over UCWB configuration. Execution controls arrive with the service in stage 3. `tsc` green. Execution schema follows in stage 2. Same-stage bookkeeping: B-765 / §26.781 / §30 row 2.599.

## §26.782 — SCR-117 stage 2: consolidation execution schema

**B-766.** Migration 0120 (183 total) builds `consolidation_execution` (unique run ID, full scope, task configuration fingerprint and snapshot, attempt number, mode, state, user, timing, duration, summary, counts and generated-document references), append-only `consolidation_execution_log`, and `consolidation_task_status` as the separate current/latest-run row. Tenant-aware foreign keys run into UCWB area/group/unit/version/task; a partial unique index refuses a second RUNNING attempt for the same task scope. The schema-contract test (3 green) pins the alignment; `tsc` green. The monitor service follows in stage 3. Same-stage bookkeeping: B-766 / §26.782 / §30 row 2.600.

## §26.783 — SCR-117 stage 3: monitor and execution service

**B-767.** The CX20 service validates an ACTIVE area, group assignment for the period, version and fiscal-year-variant period; derives task order from UCWB sequence and parentage; revalidates prerequisites by mode under the run reservation; and records every attempt separately from current status. Test and Update runs invoke the standing JOURNAL data-collection and validation adapters only — translation, investment and intercompany task types record BLOCKED attempts naming the deferred engine. Warning handling is policy-controlled, task-group execution walks the configured subtree in dependency order with a stop/continue error policy, duplicate RUNNING scopes are refused by service check and database guard, and a running attempt can be cancelled back to OPEN without rewriting history. The live shell executes individual tasks or task groups under separate Test/Update authorities and shows immutable logs under the log authority. `tsc` green. Supporting seed follows in stage 4. Same-stage bookkeeping: B-767 / §26.783 / §30 row 2.601.

## §26.784 — SCR-117 stage 4: capability and aliases

**B-768.** Seed carries the `FIN.CONSOLIDATE` capability (FIN / EXECUTE / posting false) and its registry term at `/finance/consolidation-monitor` with aliases CX20 and UCMON living on the one term; UCWB remains solely on FIN.RPT.CONSOLIDATE. Seeded twice idempotent — catalogue 149 capabilities / 122 terms / 143 aliases. Acceptance follows in stage 5. Same-stage bookkeeping: B-768 / §26.784 / §30 row 2.602.

## §26.785 — SCR-117 stage 5: service tests and browser target

**B-769.** `tests/consolidation-monitor.test.ts` (4 green) proves the undefined-period refusal, parent-before-child gating in the same execution mode, warning-policy blocking and allowance, test success never satisfying an update prerequisite, task-group stop-on-error, deferred currency-translation blocking, preserved repeated attempts, duplicate-running refusal, cancellation recovery, and that no journal posts; browser target T879 stands registered across targets/checks/database-guards. Full suite, production rebuild and browser acceptance follow before closure. Same-stage bookkeeping: B-769 / §26.785 / §30 row 2.603.

## §26.786 — SCR-117 closure: consolidation monitor accepted

**B-770, recorded 2026-10-19.** SCR-117 / FIN.CONSOLIDATE (CX20, R-165) is accepted and closed: full suite **1544/1544**, production build green, **browser target T879 PASSED**. The consolidation monitor now executes what UCWB configures: task order and parent prerequisites derive from the configured hierarchy and are revalidated by execution mode when each run is reserved; every attempt carries a unique run ID, configuration fingerprint, timing, counts and append-only logs in immutable history, while current task status stands as a separate row; duplicate simultaneous runs are refused by service check and database guard; cancelled runs recover to OPEN without rewriting history. Test runs simulate and never satisfy update prerequisites; only the standing JOURNAL data-collection and validation adapters execute — currency translation, investment consolidation and intercompany elimination record BLOCKED attempts naming their deferred engines (intercompany last, B-663), and no consolidation journal is invented. Acceptance first exposed a stale SCR-116 vocabulary-contract path left by the stage-5 vocabulary split, corrected under B-769 before the suite passed. Catalogue 149 capabilities / 122 terms / 143 aliases; migrations 183. Deferred by name: the translation/investment/intercompany processing engines, consolidated results persistence, and FIN.RPT.CONSOLIDATE.STMT. Next: FIN.RPT.CONSOLIDATE.STMT consolidated statements (CX20 statement output) — awaiting its field package; the workbench and monitor stand ready to feed it. Second-next: FIN.RPT.CASHFLOW cash flow statement (S_ALR_87012271) under its own later package (B-721). Same-stage bookkeeping: B-770 / §26.786 / §30 row 2.604.

## §26.787 — SCR-118 contract: consolidated statements

**B-771 / R-166.** Owner directs proceeding at discretion with SAP parity. FIN.RPT.CONSOLIDATE.STMT lands as Consolidated statements at `/finance/consolidated-statements`, a read-only report over the consolidation configuration and monitor state — not a second CX20 (CX20/UCMON remain solely on FIN.CONSOLIDATE; no separate classic SAP statements transaction stands, so the term carries no SAP alias). Selection follows the SAP consolidation global parameters: an ACTIVE consolidation area, its consolidation group, version, fiscal year and period (judged against the area fiscal-year variant), a statement view (Balance Sheet or Income Statement), an optional consolidation unit inside the group, and an optional comparison against the previous fiscal year at the same period. Rows are the UCWB group accounts — the consolidation chart's FS items — classified into statement sections from the account types of their mapped source accounts (ASSET/LIABILITY/EQUITY to the balance sheet, REVENUE/EXPENSE to the income statement; a group account whose mappings mix sections stands named as unclassified, never silently placed). Amounts read POSTED journal lines of the group units' company codes through the UCWB source-account mappings: year-to-date balance and period movement, signed debit-minus-credit in local currency, per unit with a group total. Journal lines no mapping covers are totalled and named as an unmapped warning, never dropped; a statement balance check names any non-zero sum. The report displays the scope's CX20 collection/validation standing and states plainly that totals aggregate reported data — currency translation and intercompany eliminations have not been executed (their engines stand deferred, intercompany last, B-663), so the statements are pre-elimination until those engines land. No schema is expected (standing journal and mapping indexes carry the read); the report posts nothing and stores nothing. Stage order: 1 statement vocabulary and shell, 2 schema/index check, 3 statement service, 4 capability and term, 5 tests/acceptance. Same-stage bookkeeping: B-771 / §26.787 / §30 row 2.605.

## §26.788 — SCR-118 stage 1: statement vocabulary and shell

**B-772.** `consolidated-statements-vocabulary.ts` carries the client-safe FIN.RPT.CONSOLIDATE.STMT vocabulary (global-parameter selection, balance-sheet/income-statement views, FS sections, per-unit row and result shapes), and `/finance/consolidated-statements` renders the selection, the FS-item matrix with section totals, the warnings and balance-check panels, and the CX20 monitor-standing panel over UCWB configuration. Amounts arrive with the service in stage 3. `tsc` green. Index check follows in stage 2. Same-stage bookkeeping: B-772 / §26.788 / §30 row 2.606.

## §26.789 — SCR-118 stage 2: schema and index check

**B-773.** No migration: the statement read aggregates POSTED journal lines on the standing company/fiscal-year/period entry index and the company/account line index, maps source accounts onto FS items through the UCWB mapping and group-account tables of migration 0119, and reads CX20 standing from the status table of migration 0120. `tests/consolidated-statements-schema-contract.test.ts` (3 green) pins those paths and the read-only vocabulary. The statement service follows in stage 3. Same-stage bookkeeping: B-773 / §26.789 / §30 row 2.607.

## §26.790 — SCR-118 stage 3: statement service

**B-774.** `calculateConsolidatedStatements` validates the ACTIVE area, group assignment at period end, version and fiscal-year-variant period; classifies each FS item from its mapped source account types (mixed-section items stand named unclassified); aggregates POSTED journal lines per unit company through the mappings with exact scaled-decimal arithmetic (year-to-date, period movement, optional previous-year comparison); totals unmapped lines as a named warning; reports the all-lines balance check; and displays the scope's CX20 standing with the pre-elimination warning. The page executes live. `tsc` green. Supporting seed follows in stage 4. Same-stage bookkeeping: B-774 / §26.790 / §30 row 2.608.

## §26.791 — SCR-118 stage 4: capability and term

**B-775.** Seed carries the `FIN.RPT.CONSOLIDATE.STMT` capability (FIN / DISPLAY / posting false) and its registry term at `/finance/consolidated-statements`; the term carries no SAP alias (no separate classic statements transaction stands — CX20/UCMON remain solely on FIN.CONSOLIDATE). Seeded twice idempotent — catalogue 150 capabilities / 123 terms / 143 aliases. Acceptance follows in stage 5. Same-stage bookkeeping: B-775 / §26.791 / §30 row 2.609.

## §26.792 — SCR-118 stage 5: service tests and browser target

**B-776.** `tests/consolidated-statements.test.ts` (3 green) proves the undefined-period refusal, FS classification and per-unit aggregation (850 year-to-date, −150 period movement, 500 comparison), the zero balance check with the named unmapped line, income-statement sections, and that the report persists nothing; browser target T878 stands registered across targets/checks/database-guards. Full suite, production rebuild and browser acceptance follow before closure. Same-stage bookkeeping: B-776 / §26.792 / §30 row 2.610.

## §26.793 — SCR-118 closure: consolidated statements accepted

**B-777, recorded 2026-10-19.** SCR-118 / FIN.RPT.CONSOLIDATE.STMT is accepted and closed: full suite **1551/1551**, production build green, **browser target T878 PASSED**. Consolidated balance sheet and income statement now read over the UCWB consolidation chart on SAP global-parameter parity: FS items classify from their mapped source account types (mixed-section items named unclassified), POSTED journal lines of the group units aggregate through the mappings per unit with group totals, year-to-date and period movement, optional previous-year comparison, unmapped lines totalled and named, the all-lines balance check displayed, and CX20 monitor standing shown with the plain pre-elimination warning — translation and intercompany eliminations remain deferred engines (intercompany last, B-663), and the report posts and stores nothing. The term carries no SAP alias (no separate classic statements transaction stands). One browser-fixture expectation (850 from the service fixture) was corrected to the browser fixture's own 750 under B-776 before acceptance passed. Catalogue 150 capabilities / 123 terms / 143 aliases; migrations 183. Deferred by name: elimination/translation-adjusted statements once their engines land, statement of changes in equity and consolidated cash flow presentation (the latter under FIN.RPT.CASHFLOW's own package). Next: FIN.RPT.CASHFLOW cash flow statement (S_ALR_87012271) under its own later package (B-721) — awaiting the owner's direction or field package. Second-next: the SCR-112 cost-centre group resolver exclusion-leaf repair, a named follow-up awaiting its own round. Same-stage bookkeeping: B-777 / §26.793 / §30 row 2.611.

## §26.794 — SCR-119 contract: cash flow statement

**B-778 / R-167.** Owner-approved contract (proposal FIN-RPT-CASHFLOW-CONTRACT.md, approved as-is 2026-10-19): FIN.RPT.CASHFLOW at `/finance/cash-flow`, a read-only cash flow statement over the posted journal, capability DISPLAY / posting false, aliases S_ALR_87012271 (Direct), S_ALR_87012272 and S_ALR_87012273 (Indirect Variants 1/2) on the one term. Selection: one or more company codes (multi-company totals only within one local currency, otherwise per-company columns), fiscal year and period range judged per company fiscal-year variant, method INDIRECT (default) or DIRECT, leading ledger only, optional previous-year comparison. Derivation classifies every account by standing configuration in precedence order — house-bank G/L accounts are cash; CUSTOMERS/VENDORS reconciliation accounts are trade receivables/payables; BSX-determined accounts are inventories; asset-determination accounts are fixed assets/accumulated depreciation; EQUITY and non-vendor LIABILITY accounts are financing (named assumption); P&L types are operating; anything else stands totalled and named unclassified. Indirect reads balance movements opening-to-closing with the depreciation add-back; direct reads offsetting lines of cash-touching documents; a reconciliation check ties the three sections to the cash movement and names any difference. No migration expected. Stage order: 1 vocabulary/shell, 2 index check, 3 derivation service, 4 capability/aliases, 5 tests/acceptance (browser T877). Same-stage bookkeeping: B-778 / §26.794 / §30 row 2.612.

## §26.795 — SCR-119 stage 1: cash-flow vocabulary and shell

**B-779, recorded 2026-10-19.** Stage 1 of SCR-119 stands: `src/modules/finance/cash-flow-vocabulary.ts` carries the client-safe vocabulary — capability `FIN.RPT.CASHFLOW`, route `/finance/cash-flow`, leading ledger `0L`, methods INDIRECT/DIRECT, the eight account classes (CASH, RECEIVABLES, PAYABLES, INVENTORY, FIXED_ASSETS, FINANCING, OPERATING_PL, UNCLASSIFIED), and the selection/line/section/result types with per-company amounts, totals only when currencies are comparable, previous-year comparison, the reconciliation difference and named unclassified rows. `src/app/finance/cash-flow/page.tsx` and `CashflowShell.tsx` render the selection (company codes, fiscal year, period From/To, method, ledger, previous-year toggle), the three-section statement matrix with per-company columns, opening/closing/net-cash and reconciliation lines, the unclassified-accounts table and the warnings panel; amounts arrive with the derivation service in stage 3. The shell imports vocabulary only (never the service), per the client-bundle canon. TypeScript green; the stage committed separately. Same-stage bookkeeping: B-779 / §26.795 / §30 row 2.613.

## §26.796 — SCR-119 stage 2: schema and index check

**B-780, recorded 2026-10-19.** Stage 2 of SCR-119 is an index check, and no migration stands (183 total): the cash-flow read aggregates POSTED journal lines per company, fiscal year and period on `journal_entry_company_year_period_idx` and per company/account on `jel_company_account_idx`; cash derives from `bank_account.gl_account`; receivables/payables from the `gl_account` reconciliation vocabulary (CUSTOMERS / VENDORS); inventories from `account_determination` (event INVENTORY, alias BSX, on `account_determination_chart_event_idx`); fixed assets and accumulated depreciation from the `asset_class` determination fields; periods judge against the company fiscal-year variant's regular periods. `tests/cash-flow-schema-contract.test.ts` pins all of these plus the read-only vocabulary (6/6). The sandbox restore (`restore-env.sh`) rebuilt PostgreSQL, migrations, seed and bootstrap for this round; the stage-2 suite ran against the restored `cairn_b210` cluster. The derivation service follows in stage 3. Same-stage bookkeeping: B-780 / §26.796 / §30 row 2.614.

## §26.797 — SCR-119 stage 3: cash-flow derivation service

**B-781, recorded 2026-10-19.** Stage 3 of SCR-119 stands: `src/modules/finance/cash-flow.ts` implements `calculateCashflow` over POSTED journal lines, and the page executes live. Each company classifies its chart by standing configuration in precedence order — house-bank G/L accounts are CASH; CUSTOMERS/VENDORS reconciliation accounts are trade receivables/payables; INVENTORY (BSX) determination accounts are inventories; asset-class reconciliation and accumulated-depreciation accounts are fixed assets (the expense-side determination accounts follow their P&L type and land in operating); EQUITY and non-vendor LIABILITY accounts are financing under the named contract assumption; REVENUE/EXPENSE accounts are operating; anything else stands UNCLASSIFIED, totalled and named. INDIRECT derives net income from P&L movements, adds back the accumulated-depreciation movement, and reads working-capital changes opening-to-closing; DIRECT reads the offsetting lines of cash-touching documents (multi-cash-line and cash-to-cash documents named in warnings). Opening/closing cash, net change and a reconciliation difference (sections vs cash movement, explained by the unclassified lines, never forced) close the statement; optional previous-year comparison derives the same periods of the prior fiscal year. Refusals name the cause: unknown company, no chart, no fiscal-year variant, periods the variant does not define, a company with no house-bank G/L account, and any ledger other than the leading ledger 0L. Multi-company totals stand only when every company shares one local currency, otherwise per-company columns stand. TypeScript green. Supporting seed follows in stage 4. Same-stage bookkeeping: B-781 / §26.797 / §30 row 2.615.

## §26.798 — SCR-119 stage 4: capability, term and aliases

**B-782, recorded 2026-10-19.** Stage 4 of SCR-119 stands: the seed carries capability `FIN.RPT.CASHFLOW` (FIN / DISPLAY / posting false) and the term `FIN.RPT.CASHFLOW` ("Cash flow statement", route `/finance/cash-flow`, TIER_1_BUILT). The aliases S_ALR_87012271, S_ALR_87012272 and S_ALR_87012273 stood parked on FIN.GL.BALANCE and FIN.JOURNAL.LIST; on the SCR-111 single-owner precedent they are ceded to the cash-flow term (seed deletes them from the former terms before insert, and the registry entries no longer list them), so the alias count stands unchanged while ownership moves. Seeded twice, idempotent: catalogue **151 capabilities / 124 terms / 143 aliases**; migrations 183. Acceptance follows in stage 5. Same-stage bookkeeping: B-782 / §26.798 / §30 row 2.616.

## §26.799 — SCR-119 stage 5: service tests and browser target

**B-783, recorded 2026-10-19.** Stage 5 of SCR-119 stands: `tests/cash-flow.test.ts` carries six service tests over a tenant whose standing chart already classifies some accounts (the fixture sets every used account's reconciliation type explicitly, so the derived classes are exactly the configured ones): refusals for an undefined variant period, a bankless company named, and a non-leading ledger; the INDIRECT derivation (net income 3700, depreciation add-back 500, working-capital effects, section nets 1700 / −3000 / 10000, opening 2000 → closing 10100, reconciliation difference −600 explained by the one unclassified account); the DIRECT derivation from offsetting lines reaching the same section nets; and multi-currency per-company columns with no combined total, persisting nothing (12/12 with the stage-2 contract). Browser target **T877** (`cash-flow`, SCR-119 local loopback guard) stands registered in targets, checks and database guards (169/169 with the target contracts). Full suite, production rebuild and browser acceptance follow before closure. Same-stage bookkeeping: B-783 / §26.799 / §30 row 2.617.

## §26.800 — SCR-119 closure: cash flow statement accepted

**B-784, recorded 2026-10-19.** SCR-119 / FIN.RPT.CASHFLOW is accepted and closed: full suite **1564/1564**, production build green, **browser target T877 PASSED**. The cash flow statement stands at `/finance/cash-flow` as contracted (R-167, approved as proposed): one or more company codes; fiscal year and period range judged per company fiscal-year variant; INDIRECT (default) or DIRECT method; leading ledger 0L only; optional previous-year comparison. Every account classifies from standing configuration in precedence order — house-bank G/L accounts are cash, CUSTOMERS/VENDORS reconciliation accounts are trade receivables/payables, BSX (INVENTORY) determination accounts are inventories, asset-class determination accounts are fixed assets/accumulated depreciation (expense-side determination accounts follow their P&L type), EQUITY and non-vendor LIABILITY accounts are financing under the named assumption, P&L accounts are operating, and anything else stands totalled and named unclassified, never dropped. Indirect reads balance movements opening-to-closing with the depreciation add-back; direct reads the offsetting lines of cash-touching documents, multi-cash-line and cash-to-cash documents named in warnings. Opening cash → closing cash and the reconciliation difference (sections vs cash movement, explained by the unclassified lines, never forced) close the statement. Multi-company totals stand only within one local currency, otherwise per-company columns stand. Refusals name the cause: unknown company, no chart, no variant, undefined periods, a company with no house-bank G/L account, any other ledger. The report posts nothing and stores nothing; no migration stands (183). The aliases S_ALR_87012271/72/73 were ceded to this term from the G/L balance/line-item terms where they stood parked (SCR-111 single-owner precedent), so the catalogue stands at **151 capabilities / 124 terms / 143 aliases**. One browser-script locator (exact heading) was corrected under stage 5 before acceptance passed. The round opened with a sandbox restore (PostgreSQL, node_modules, Chromium and the `.git` refs rebuilt from `.env.local`; see §26.796). Deferred by name: group-level (consolidated) cash flow presentation with elimination/translation engines (intercompany last, B-663); tolerance difference posting, partial/residual and multi-currency clearing (SCR-114); CSV export (SCR-113). Next: the SCR-112 cost-centre group resolver exclusion-leaf repair (FIN.RPT.COSTCENTER.ACTUAL, **S_ALR_87013611**) as its own round, awaiting the owner's direction. Second-next: the SCR-113 CSV export for profit-centre reporting (FIN.RPT.PROFITCENTER, **KE5Z**). Same-stage bookkeeping: B-784 / §26.800 / §30 row 2.618.

## §26.801 — Walkthrough seed delivered (owner tooling, no app code)

**B-785, recorded 2026-10-19.** At the owner's direction, a standalone walkthrough seed stands at `/home/user/walkthrough-seed.ts` (workspace file, deliberately **not** in the repository and not wired into build/migrate/seed): after a fresh install (`db:migrate` → `seed:reference` → `seed`), one command (`npx tsx walkthrough-seed.ts [--client=XXXX]`) creates a tenant through the standing `createTenant` service with an administrator (`admin` / password printed by the script), applies the standard structure, re-points company 1000 ("Meridian Auto Components Pvt Ltd", INR, Asia/Kolkata) to a new April–March fiscal-year variant **V3** (FY named by its April start year; Jan–Mar periods carry yearShift +1), and seeds complete standing configuration and master data — house bank on the bank G/L account, GST tax codes G18/G0 with TAX determination, payment terms/methods, cost centres, 3 vendors and 2 customers with company/purchasing data, 4 valuated materials, number ranges — so **every implemented transaction can be used immediately with no prior data entry** (the owner's main requirement). History is posted through the real services: opening balances, three full purchase-to-procure cycles (PO → goods receipt → invoice verification; two settled by an executed F110 payment run, the third left open), two GST customer invoices (the first received and cleared via incoming payment, the second left open), rent/salary journals on cost centres; 15 journals stand. Proven in this environment on tenant W103 (2026-10-19): login as the walkthrough admin succeeds with Full access; cash flow FY2026 closes 1,879,000 with reconciliation difference 0; trial balance, balance sheet, G/L line items and customer balances render the seeded data. **Findings logged for the next round, not fixed (owner instruction: this round touches no app code):** (1) vendor ageing (FIN.AP.AGEING / S_ALR_87012085) over open partner lines counts F110 payment-run payment lines as still open (the run stamps the cleared invoice lines but not its own payment lines, unlike F-53/F-28 which self-stamp) and admits any partner's uncleared lines regardless of reconciliation account or supplier role (a customer's open receivable was aged as a supplier) — candidate **SCR-120**: judge whether F110 payment lines should self-stamp and/or the ageing selection should restrict to AP reconciliation accounts of supplier partners, with the customer-ageing mirror checked at the same time. (2) Material period control is initialize-once; a walkthrough spanning several periods must shift it forward period by period (MMPV-style) — handled inside the seed via `shiftMaterialPeriod`, no app change needed. Same-stage bookkeeping: B-785 / §26.801 / §30 row 2.619.

## §26.802 — Walkthrough seed shipped in the deployment (owner direction)

**B-786, recorded 2026-10-19.** Superseding the loose-file delivery of §26.801 at the owner's instruction: `walkthrough-seed.ts` now stands in the **repository root**, so the Docker operations image (`migrate` service, target `operations`, full source + tsx) bakes it in at `/app/walkthrough-seed.ts` via `COPY . .`, and `docker-compose.yml` additionally mounts the host copy over that path for the migrate service (`./walkthrough-seed.ts:/app/walkthrough-seed.ts:ro`) so the seed can be refreshed without rebuilding the image. The file header carries the exact commands: after a fresh `docker compose up -d` (migrate completed), `docker compose run --rm migrate npx tsx walkthrough-seed.ts [--client=XXXX]`; explicitly not in the runtime-only `app` container, and no `.env.local` inside containers (Compose injects the URLs). The script is unchanged in behavior and re-proven from the repo root in this environment (tenant W104, full run clean); the container execution itself could not be run here (no Docker in this sandbox) and stands on the verified Dockerfile/Compose semantics. Deployment/test tooling only — no application source changed; the file embeds the walkthrough admin password by design (demo credential for a fictional tenant). Same-stage bookkeeping: B-786 / §26.802 / §30 row 2.620.

## §26.803 — SCR-121 contract: retained earnings account definition (OB53)

**B-787 / R-168.** Owner package (2026-10-19): OB53 (Define Retained Earnings Account) as the next round; SCR-120 (ageing repair) and the SCR-112 exclusion-leaf repair queue behind it. Verified standing state: `account_determination` already carries an unkeyed `RETAINED_EARNINGS` event (alias only, never in codes) which balance carryforward reads, but no package seeds it (a fresh tenant's carryforward refuses "Configure the retained earnings account determination"), `gl_account` carries no retained-earnings indicator, and no OB53 definition screen stands. Contract: (1) a dedicated definition screen at `/config/retained-earnings` (config activity, alias OB53) maintaining, per chart of accounts, the retained earnings account for each one-character retained earnings indicator (exactly one of A–Z/0–9, `X` the standing convention), with mandatory reason and one change document per save, hard delete allowed only while no P&L account carries the indicator; the account must stand in the same chart as an EQUITY balance-sheet account. Determinations stay in the standing `account_determination` table with the indicator in the general-modifier slot of the `RETAINED_EARNINGS` event (valuation class always blank), so the OBYC catalogue and this screen read one source; the event's `usesGeneralModifier` becomes true. (2) Migration 0121: `gl_account.retained_earnings_indicator` (one character, stored only on P&L-statement accounts; check-pinned). (3) The G/L account screen gains the indicator for P&L accounts and enforces the owner's forcing rule: saving a P&L account refuses, naming OB53, when no determination stands for its (chart, indicator); a blank indicator on a P&L account likewise refuses. (4) Balance carryforward closes P&L accounts per indicator to the indicator's retained earnings account and refuses naming every P&L account whose indicator lacks a determination (reruns post only the delta, as today). (5) The standard package seeds indicator `X` on its P&L accounts and the `X` determination to its retained-earnings equity account, so a fresh tenant passes from day one. Capability `CFG.FIN.RETAINED.DEFINE` (FIN / CONFIGURE / posting false), term CONFIG_ACTIVITY with alias OB53; expected catalogue 152/125/144, migrations 184. Stage order: 1 vocabulary/shell, 2 schema (migration 0121 + indicator/event wiring), 3 definition service + FS00 enforcement + carryforward rework, 4 package seed + capability/term, 5 tests/acceptance (browser T876). Same-stage bookkeeping: B-787 / §26.803 / §30 row 2.621.

## §26.804 — SCR-121 stage 1: retained-earnings vocabulary and shell

**B-788, recorded 2026-10-19.** Stage 1 of SCR-121 stands: `src/modules/foundation/retained-earnings-vocabulary.ts` carries the client-safe vocabulary — activity `CFG.FIN.RETAINED.DEFINE`, route `/config/retained-earnings`, the `RETAINED_EARNINGS` determination event, standard indicator `X`, and the determination row/chart types. `src/app/config/retained-earnings/page.tsx` and `RetainedEarnings.tsx` render the configured-determinations grid (chart, indicator, retained earnings account and name, carrying P&L account count), the maintain form (chart, one-character indicator, account, mandatory reason) and the delete form with its in-use warning; the shell imports vocabulary only and the forms wire to the service in stage 3. TypeScript green; the stage committed separately. Same-stage bookkeeping: B-788 / §26.804 / §30 row 2.622.

## §26.805 — SCR-121 stage 2: retained-earnings schema

**B-789, recorded 2026-10-19.** Stage 2 of SCR-121 stands: migration **0121** (184 total) adds `gl_account.retained_earnings_indicator` (one character) with check `gl_account_retained_indicator_ck` pinning it to P&L-statement accounts in A–Z/0–9; the Drizzle schema carries the same column and check. The `RETAINED_EARNINGS` posting event now declares `usesGeneralModifier: true`, so the indicator lives in the determination's general-modifier slot (valuation class always blank) and the OBYC catalogue and the OB53 screen read one source. `tests/retained-earnings-schema-contract.test.ts` pins the column, the check, the event wiring and the client-safe vocabulary (3/3); migration applied cleanly over the standing dev cluster. The definition service, FS00 enforcement and carryforward rework follow in stage 3. Same-stage bookkeeping: B-789 / §26.805 / §30 row 2.623.

## §26.806 — SCR-121 stage 3: definition service, FS00 enforcement, carryforward rework

**B-790, recorded 2026-10-19.** Stage 3 of SCR-121 stands: `src/modules/foundation/retained-earnings.ts` maintains the per-chart, per-indicator determinations over the standing `account_determination` rows (indicator in the general-modifier slot, valuation class blank) with the standing reason judge, one change document per save, the same-chart EQUITY balance-sheet account judge, and hard delete refused — naming the first carrier — while any P&L account of the chart carries the indicator; `/config/retained-earnings` is wired to the service through server actions. The G/L account master (FS00) carries the retained earnings indicator for P&L accounts (pre-filled with the standing `X` on create, editable in one character), and `upsertGlAccount` enforces the owner's forcing rule on screen saves (`CREATE`/`CHANGE`): a P&L save refuses naming OB53 when the indicator is blank or its (chart, indicator) determination does not stand; provisioning upserts (mode omitted, standard package included) keep the stored value, so seeding is never blocked before the determination exists. Balance carryforward now closes P&L accounts per indicator — one closing line per indicator to its own retained earnings account inside the one transfer document — and an update run refuses naming every P&L account with a nonzero balance whose indicator lacks a determination (a test run marks those rows EXCEPTION naming OB53); reruns still post only the delta. `tests/retained-earnings.test.ts` pins the definition refusals, the FS00 forcing rule, and the in-use delete refusal (3/3); the SCR-102 carryforward and SCR-028 G/L master suites were reworked to the new contract (determinations defined through the OB53 service with indicator X, GENA membership counts adjusted) and the full suite stands at **1570/1570**. The package seed and capability/term registration follow in stage 4. Same-stage bookkeeping: B-790 / §26.806 / §30 row 2.624.

## §26.807 — SCR-121 stage 4: package seed and catalogue registration

**B-791, recorded 2026-10-19.** Stage 4 of SCR-121 stands: the standard package (`applyStandardPackage`) now stamps retained earnings indicator `X` on every P&L account it delivers and seeds the matching determination — event `RETAINED_EARNINGS`, valuation class blank, indicator in the general-modifier slot, account `290000` — into the delivered chart, so a fresh tenant's carryforward passes from day one and FS00's forcing rule is satisfiable out of the box; existing package rows are untouched (insert-on-conflict-do-nothing, as the package has always behaved). The reference seed registers the round in all three catalogues: configuration activity `CFG.FIN.RETAINED.DEFINE` (FINANCIAL_ACCOUNTING, after `CFG.FIN.COA.DEFINE`, route `/config/retained-earnings`), capability `CFG.FIN.RETAINED.DEFINE` (FIN / CONFIGURE / posting false), and CONFIG_ACTIVITY term `CFG.FIN.RETAINED.DEFINE` titled "Define retained earnings account" with search alias **OB53** (alias only, never in codes). The seeded catalogue now stands at **152 capabilities / 125 terms / 144 aliases**, verified against the reference database after `npm run seed`. The SCR-040 account-determination suite now expects the one seeded determination row and the retained-earnings test pins the package carrier count; the full suite stands at **1570/1570**. Tests and browser acceptance (T876) follow in stage 5. Same-stage bookkeeping: B-791 / §26.807 / §30 row 2.625.

## §26.808 — SCR-121 closure: OB53 retained earnings definition accepted

**B-792, recorded 2026-10-19.** SCR-121 is **CLOSED**. Stage 5 stands: browser target `retained-earnings` (**T876**, reserved fixture tenant on `cairn_b210:5432`) passes against the production build — the package-seeded indicator `X` (chart CA01 → account 290000) stands on the definition grid; a second indicator `Z → 291000` is defined through the screen and lands as a determination row (general-modifier slot, valuation class blank) with a change document; deleting the seeded indicator refuses because the delivered P&L accounts carry it; and FS00 refuses to save P&L account 300000 under undefined indicator `Q`, naming OB53, leaving the stored account untouched (the database truth section pins determinations `{X→290000, Z→291000}`, the untouched indicator, and the change document). The full suite stands at **1571/1571** (228 files) and the production build is green. SCR-121 delivered: the OB53 definition screen at `/config/retained-earnings` (mandatory reason, one change document per save, hard delete only while no P&L account carries the indicator, same-chart EQUITY account judged), migration 0121 (`gl_account.retained_earnings_indicator`, P&L-only, check-pinned), the FS00 indicator with its CREATE/CHANGE forcing rule (provisioning upserts unforced), carryforward closing per indicator and refusing — naming the accounts — where an indicator lacks a determination, and the standard-package seed of indicator `X` with its determination so fresh tenants pass from day one. Capability, configuration activity and CONFIG_ACTIVITY term `CFG.FIN.RETAINED.DEFINE` stand registered with search alias OB53; the catalogue stands at **152 capabilities / 125 terms / 144 aliases**, migrations **184**. `FUNCTIONS-AND-ROADMAP.md` reflects the closure. Next round per the queue: **SCR-120** — vendor ageing repair (the walkthrough finding: F110 payment lines standing open to ageing and ageing not restricted to the AP reconciliation role; customer-ageing mirror S_ALR_87012178 to be checked in the same round) — then **SCR-112** exclusion-leaf repair. Same-stage bookkeeping: B-792 / §26.808 / §30 row 2.626.


## §26.809 — SCR-120 contract: vendor ageing analysis repair and parity (S_ALR_87012085)

**B-793 / R-169, recorded 2026-10-20 (package received 2026-10-19).** Owner package: S_ALR_87012085 — Vendor Payment History / Open Item Aging Report, reworking the standing `FIN.AP.AGEING` (SCR-066). Verified standing state: the SCR-066 derivation admits **every** journal line carrying a business partner — customer receivable lines, payment debit lines and any other partner line all age as vendor items (the walkthrough defect: customer C20000 aged as a vendor; vendor V20000 showed its F110 payment standing open although paid) — and the F110 payment run stamps clearing only on the invoice lines it clears, never on its own vendor payment lines, unlike F-53/F-28 which self-stamp theirs. Contract: (1) **Item eligibility** — an ageing item is a POSTED journal line, in a selected company code, on a G/L account of the company's chart whose reconciliation type is `VENDORS`, carrying a business partner; the vendor is named from the partner master. Special G/L lines (standing on the alternative reconciliation accounts of `AP` special G/L indicators) are excluded unless *Include Special G/L* is selected, and then carry their indicator resolved from the special G/L definition (company-specific row wins over the tenant-wide row). Nothing is double-counted: a line stands once, by its account. (2) **Historical standing** — as of the key date: posted on or before it, and not cleared on or before it (clearing judged by the line's clearing stamp, so an item cleared after the key date stands, at its full line amount). Because the product clears whole lines, a standing line's remaining open amount is its signed line amount; partial payments stand as their own open items and net inside the vendor total, and residual items stand on their own — this is the standing clearing model's equivalent of SAP's partial/residual accounting and is stated on the screen. Clearing reset erases stamps, so pre-reset history cannot be reconstructed; stated as a limitation, as on the standing reports. (3) **F110 repair** — the payment run self-stamps its own vendor payment lines (clearing document = the payment document, clearing date = run posting date), exactly as F-53/F-28 do, so paid vendors stop ageing their own payments; ageing itself needs no payment special-case. (4) **Due dates** — from the canonical payment-term service (`paymentSchedule`): an item whose journal originates from a supplier invoice (invoice verification) or a direct vendor invoice ages on that invoice's baseline date plus its payment terms, recomputed (the stored due date when the terms no longer stand); any other item (manual journal, payment) ages on its posting date. Overdue days = max(0, key date − due date); buckets: not yet due, then three strictly increasing positive thresholds (default 30/60/90), boundaries single-counted. (5) **Selection** — company codes single or range (each must stand; results grouped per company, never summed across currencies), vendor (supplier) range, key date (default today), special G/L toggle, three ageing intervals, summarization level (Vendor / Document / Line item), sort (Vendor, Document date, Posting date, Baseline date, Due date, Overdue days), and CSV export of the standing selection through the standing route-export precedent (GR/IR reclass). **Output layout variant is deferred**: no layout/variant framework exists in the product; recorded here as the round's one explicit deferral for a later round rather than inventing a parallel store. (6) **Output** — per company: vendor rows (number, name, item count, not-yet-due, three buckets, over, total, currency) reconciling exactly to the item derivation; drill to line items (document, fiscal year, line, type, posting/document/baseline/due dates, overdue days, original amount, remaining amount, document currency, special G/L indicator, payment terms, clearing document/date where cleared after the key date) and onward links to the vendor line-item display and FB03 document display carrying company/vendor/document/fiscal-year context; explicit empty state. Read-only: nothing posts, clears, or writes; OB52 period status never suppresses historical items. (7) **Server-side derivation** — eligibility, standing and range filters run in SQL; vendor aggregates computed from the same filtered derivation; line detail served per vendor drill (paged), never the whole ledger in memory; standing indexes verified by query plan (migration 0122 only if a real gap shows). Authorization is the standing model (capability `FIN.AP.AGEING` + tenant isolation); company/vendor authorization objects do not exist in the product and selection validation stands in their place — stated, not hidden. (8) **Customer mirror**: the identical derivation defect in `FIN.AR.AGEING` (S_ALR_87012178) is repaired with the same standing rules on `CUSTOMERS` reconciliation accounts as a same-defect repair inside this round (the owner's package is vendor-only; the mirror carries no new fields). Capability and term already stand (catalogue unchanged at 152/125/144); the term description is refreshed to the repaired derivation. Stage order: 1 selection/grid UI over the standing service, 2 SQL-standing + index verification (schema only if needed), 3 backend derivation rework + F110 self-stamp + mirror repair, 4 seed description refresh + CSV export route, 5 tests/acceptance (browser target T931 rework). Same-stage bookkeeping: B-793 / §26.809 / §30 row 2.627.


## §26.810 — SCR-120 stage 1: ageing selection and output shape

**B-794, recorded 2026-10-20.** Stage 1 of SCR-120 stands: `/finance/vendor-ageing` now carries the package's full selection shape — company code from/to range (results grouped per company, never summed across currencies; the standing single `companyCode` parameter still resolves), supplier from/to, key date (default today), the three ageing thresholds, summarization level (Vendor totals / Document details / Line items), sort (Vendor, Document date, Posting date, Baseline date, Due date, Overdue days) and the *Include special G/L transactions* toggle — over the standing SCR-066 derivation. The vendor grid shows number, name (partner master), item count, the five buckets, total and currency, with the company total reconciling to the derivation; document summarization groups the standing items per document; line rows carry the FB03 document-display link with company/fiscal-year context and the drill keeps the vendor-balances (FBL1N-equivalent) link; the screen states the standing clearing model (a standing item's remaining amount is its full line amount, partial payments stand as their own open items, pre-reset standing is not reconstructible) and shows the explicit empty state. TypeScript green. Still to land: the repaired derivation itself (reconciliation-account eligibility, special G/L inclusion, canonical payment-term due dates, baseline/document dates) and the F110 self-stamp in stage 3, the SQL/index verification in stage 2, and the seed refresh plus CSV export in stage 4 — until then the grid ages by the SCR-066 rules. Same-stage bookkeeping: B-794 / §26.810 / §30 row 2.628.


## §26.811 — SCR-120 stage 2: query-plan and index verification (no migration)

**B-795, recorded 2026-10-20.** Stage 2 of SCR-120 stands as a verification stage: the repaired derivation's predicates were checked against the standing index inventory and proven by `EXPLAIN (ANALYZE, BUFFERS)` on 90,000 synthetic journal lines (30,000 balanced documents, two company codes, 50 vendor and 50 customer partners, a third of the vendor lines cleared) in a scratch tenant, removed afterwards. The plan drives from the chart's `VENDORS` reconciliation accounts (the derivation's account set) into `journal_entry_line` by index (`jel_account_idx`; the company-scoped shape is equally served by `jel_company_account_idx` on client + company + account) and joins `journal_entry` by its primary key, with the company/date/status filters applied on the entry — 40 ms execution at that volume. The remaining predicates are already served: key-date standing on `clearing_date` is a heap filter over the account's lines, the supplier range rides `journal_entry_line_partner_open_idx` (client + partner + clearing document), and the company/date selection rides `journal_entry_company_date_idx`. **No new index is created and migration 0122 does not exist** — the round adds no schema, and the migration count stays 184; adding an index the planner does not need would only tax every posting. The backend derivation rework follows in stage 3. Same-stage bookkeeping: B-795 / §26.811 / §30 row 2.629.


## §26.812 — SCR-120 stage 3: ageing derivation rework, F110 self-stamp, mirror repair

**B-796, recorded 2026-10-20.** Stage 3 of SCR-120 stands: one shared derivation (`src/modules/finance/ageing-derivation.ts`) now serves vendor ageing and — as the same-defect mirror repair — customer ageing. An ageing item is a POSTED journal line in the company on an account of the company's chart carrying the side's reconciliation type (`VENDORS`/`CUSTOMERS`) with a business partner, so customer receivable lines, vendor payable lines on the other side, expense lines carrying a partner, and every other stray partner line no longer age (the walkthrough defect, reproduced and pinned by test). Special G/L items stand on the alternative reconciliation accounts of the side's indicators: unselected, those accounts leave the derivation entirely; selected, their lines join carrying the indicator (company-specific definition wins). Standing stays historical on the clearing stamp; due dates are recomputed from the origin invoice's baseline plus its payment terms through `calculatePaymentSchedule` — supplier-invoice (invoice verification), direct vendor invoice, and customer invoice origins all resolve, the stored due date serves when the terms no longer stand, and items without an invoice origin age on posting date; a test proves the recompute by stretching NET30 from 30 to 45 days and watching the item leave overdue. The F110 payment run now self-stamps its own vendor payment lines (clearing document = the payment document, clearing date = run posting date) exactly as F-53/F-28 do, pinned in the payment-run suite, so a paid vendor's payment never stands open downstream; ageing keeps no payment special-case. Item rows now carry document type, document/baseline dates, payment terms, special G/L indicator, document-currency amount and clearing standing, vendor/customer rows carry partner name and item count, and the vendor screen passes the special G/L toggle and sort through. The SCR-066/070 suites pass unchanged under the repaired derivation; new SCR-120 acceptance (3 tests) pins eligibility, terms recomputation, special G/L selection on both sides, and cleared-pair historical standing. Full suite **1574/1574**. The seed description refresh and CSV export follow in stage 4. Same-stage bookkeeping: B-796 / §26.812 / §30 row 2.630.


## §26.813 — SCR-120 stage 4: CSV export and catalogue refresh

**B-797, recorded 2026-10-20.** Stage 4 of SCR-120 stands: the vendor ageing selection exports to CSV through `/finance/vendor-ageing/export` (capability-guarded like the screen, the standing route-export precedent of GR/IR reclass), carrying the full item detail — company, supplier and name, document key, document type, posting/document/baseline dates, payment terms, due date, overdue days, bucket, special G/L indicator, document-currency original amount, remaining amount and clearing standing — for exactly the selection the screen aged, with an Export CSV action on each company section. The seed's capability and term descriptions for `FIN.AP.AGEING` and the `FIN.AR.AGEING` mirror now state the repaired derivation (reconciliation-account eligibility, canonical payment-term due dates, special G/L selection); the reference seed re-applied cleanly and the catalogue is unchanged at **152 capabilities / 125 terms / 144 aliases**, as the contract recorded. The screen subtitle states the same rules. Tests and browser acceptance (T931 rework) follow in stage 5. Same-stage bookkeeping: B-797 / §26.813 / §30 row 2.631.

## §26.814 — SCR-120 closure: vendor ageing repair accepted

**B-798, recorded 2026-10-20.** SCR-120 is **CLOSED**. Stage 5 stands: browser target `vendor-ageing` (**T931 reworked**, reserved fixture tenant on `cairn_b210:5432`) passes against the production build — order, receipt and two verified invoices (500 + 300), a manual payment standing as its own open debit item, and a customer receivable of 999 in the same ledger: ageing as of 2026-12-20 shows only the vendor subledger (−300.00 across 1 supplier, 3 items, the customer item absent), the invoices aged 35 days on their payment-term due dates and the payment item 61; clearing stamps dated 2026-10-21 leave the pair standing as of 2026-10-20 and gone as of 2026-12-20; a special G/L debit on the alternative account stays out by default and joins at +200.00 when selected; an item drills through to its accounting document (FB03 shape) and the selection exports to CSV carrying the same rows. The full suite stands at **1574/1574** (228 files) and the production build is green. SCR-120 delivered the walkthrough-finding repair: ageing population restricted to the side's reconciliation-account lines (special G/L alternatives by selection) through one shared derivation serving vendor and customer ageing; due dates recomputed from the origin invoice's baseline and payment terms; the F110 payment run self-stamping its own vendor payment lines so a paid vendor never stands open downstream; free company/supplier ranges, summarization and sort on the screen, and CSV export. **Deferred, by name (contract §26.809):** output layout variants (no standing variant framework; report-specific tables forbidden) and reporting-currency conversion (ageing reports in company-code currency, document currency preserved per item). Migrations stay **184** (stage 2 proved no new index is needed); catalogue unchanged **152/125/144**. `FUNCTIONS-AND-ROADMAP.md` reflects the closure. The walkthrough ageing finding (W103) is thereby closed: its database truth was always correct, and the two derivation defects that misread it are repaired and pinned. Next round per the queue: **SCR-112 exclusion-leaf repair** (cost centre actual/plan report, S_ALR_87013611), then **SCR-113 CSV export** (KE5Z). Same-stage bookkeeping: B-798 / §26.814 / §30 row 2.632.

## §26.815 — SCR-112 repair contract: exclusion leaves, actual/plan/variance (S_ALR_87013611)

**B-799 / R-170.** Owner package (2026-10-20): S_ALR_87013611 (Cost Centers: Actual/Plan/Variance, CO-OM-CCA) — the round the queue named at B-741/B-742/B-784: repair of the SCR-112 report (FIN.RPT.COSTCENTER.ACTUAL, closed B-735) whose cost-centre group resolver ignores exclusion leaves. Verified standing state: `calculateCostCenterReport` (src/modules/foundation/cost-center-report.ts) selects only `val_from, val_to` from `cost_center_group_leaf` and admits a centre when **any** leaf matches — the `val_sign` (I/E, check-pinned) and `display_order` columns the schema has carried since SCR-042 are never read, so an E leaf never removes anything. The two sibling resolvers already honour the canon: the profit-centre report (SCR-113, profit-center-report.ts) folds leaves sequentially in display order (matching I includes, matching E excludes, later leaves win), and the cost-centre hierarchy membership (cost-center-hierarchy.ts) applies I/E the same way; the report is the single defective site, and no other consumer resolves group membership for reporting. Contract: (1) **Repair** — the report's group resolver resolves leaves sequentially in display order (`display_order, val_from`), a matching I leaf includes and a matching E leaf excludes, exactly the SCR-042 canon; group membership then intersects the standing range and fiscal-year-validity selection as today, centres without validity stay named as excluded, and an empty resolution still refuses by name. No schema change stands (migrations stay 184, catalogue unchanged 152/125/144). (2) **Drill-down** — the one package behaviour within reach that the delivered report lacks: each centre/element row drills to its contributing journal line items (`/finance/journal/items` with cost-centre and fiscal-year context, the standing FAGLL03-shape display), the plan side being the `cost_center_plan` rows the report already reads. (3) **Package audit, re-affirmed by name as deferred** (delivered at B-735 or impossible on canon today): cost element *groups* (no master stands; ranges only), display-currency views beyond controlling-area currency and currency conversion, output layout variants (no standing variant framework), actual activity quantities and actual unit rates (no actual-quantity source without the allocation engine), secondary cost elements and internal allocations (deferred at B-735), the plan-entry UI, interactive sorting/filtering (fixed server order), and execution audit logging (no standing report-audit policy; the report posts nothing, as its siblings). Plan-version handling stands as delivered: the key is format-judged, an unknown version warns and plans stand null — missing plan is never dressed as zero. Stage order, adapted to a single-site repair: 1 backend resolver + service tests, 2 UI drill + browser acceptance (T884 extension) and closure; each stage separately committed and pushed. Same-stage bookkeeping: B-799 / §26.815 / §30 row 2.633.

## §26.816 — SCR-112 repair stage 1: exclusion-leaf resolver

**B-800, recorded 2026-10-20.** Stage 1 of the SCR-112 repair stands: the cost-centre report's group resolver now selects `val_sign` and resolves the group's leaves sequentially in display order (`display_order, val_from`) — a matching I leaf includes, a matching E leaf excludes, later leaves win — replacing the any-leaf-matches inclusion that ignored exclusions entirely; the wording rides with the SCR-042 canon comment, matching the profit-centre resolver (SCR-113) and the hierarchy membership judge. Nothing else in the derivation moved: membership still intersects the centre range and fiscal-year-validity selection, invalid centres stay named, an empty resolution still refuses by name. `tests/cost-center-report.test.ts` gains the repair test (4/4 with the standing suite): an I range with a later E single excludes CC2000 while CC1000 reports (centre −4,000 across its elements, expense element 5,000), an E-then-I order re-includes CC1000, and an E range covering the whole inclusion resolves empty and refuses naming the selection. TypeScript green. The line-item drill and browser acceptance follow in stage 2. Same-stage bookkeeping: B-800 / §26.816 / §30 row 2.634.

## §26.817 — SCR-112 repair closure: exclusion leaves accepted

**B-801, recorded 2026-10-20.** The SCR-112 repair round is **CLOSED**. Stage 2 stands: centre and element rows of the report now drill to their contributing journal line items (`/finance/journal/items` with account range, cost centre, fiscal year — and the controlling area's company codes, which the report result now carries, since the items report refuses without them), and browser target `cost-center-report` (**T884 extended**) passes against the production build: actual 5,000.00 against plan 4,500.00 judged Unfavorable under the hierarchy group as before; then, under group OPSX (I range CC9001–CC9999 followed by E CC9002), the excluded centre and its 7,000.00 leave the grouped report entirely; an element row drills through to the journal line items of CC9001; and the report persisted nothing beyond the two fixture postings. The full suite stands at **1575/1575** (228 files) and the production build is green. The repair in one line: the report's group resolver folds I/E leaves sequentially in display order (SCR-042 canon), so exclusion leaves — defined since SCR-042 but silently ignored by this one resolver — now exclude, re-include, and empty exactly as the profit-centre resolver and hierarchy membership already judged. **Re-affirmed deferred by name (§26.815):** cost element groups, display-currency conversion, layout variants, actual activity quantities and unit rates, secondary cost elements and internal allocations, plan-entry UI, interactive sorting/filtering, execution audit logging. No schema change stands; migrations **184**, catalogue **152/125/144**. `FUNCTIONS-AND-ROADMAP.md` reflects the repair. Next round per the queue: **SCR-113 CSV export** (profit-centre reporting, KE5Z), then the SCR-114 clearing follow-ups (tolerance difference posting first). Same-stage bookkeeping: B-801 / §26.817 / §30 row 2.635.

## §26.818 — SCR-113 contract: KE5Z profit-centre line-item CSV export

**B-802 / R-171.** Owner package (2026-10-20): KE5Z (Profit Center: Actual Line Items, EC-PCA) — the export follow-up named deferred at SCR-113's closure (B-742) against the delivered FIN.RPT.PROFITCENTER report (`/controlling/profit-center-report`, closed B-742, browser T883). Verified standing state: the report reads POSTED journal lines as recorded (profit centre, account, signed document/local amounts, originating objects and origin class/key), resolves profit-centre groups honouring E leaves in display order, refuses any ledger but the leading `0L` by name, caps hits server-side (default 5,000, cap 50,000) with an explicit truncation flag and totals reconciled over the full selection; the vendor-ageing round (SCR-120 stage 4) set the export precedent — a capability-guarded route handler exporting exactly the selection the screen ran, CSV built in the service module. Contract: (1) **Export** — `GET /controlling/profit-center-report/export` under the same capability the screen judges (`FIN.RPT.PROFITCENTER.read`), parsing the same selection the page parses, running the same `listProfitCenterLines` derivation, and returning `profit-center-lines-{area}-{year}.csv` carrying every line-item column the grid shows (company, document/display number, fiscal year, line, posting/document dates, type, ledger, profit centre and name, G/L account, debit/credit, document currency and signed amount, local currency and signed amount, assignment, reference, line text, cost centre, internal/production order, partner, material, plant, origin class/key). The export carries exactly the window the screen shows for that selection — same hit limit; when the window is truncated the CSV opens with a `# TRUNCATED` comment naming the limit, so a partial file is never mistaken for the complete selection. An **Export CSV** action stands on the report screen beside Execute. (2) **Package audit, re-affirmed by name as deferred** (settled at B-736/B-742 and unchanged by this package): partner profit centre (not recorded on canon lines), G/L account *groups* (no master; ranges only), KE5Y plan line items, interactive sorting/filtering and column selection/layout variants (fixed server order stands), pagination beyond the hit-limit window (truncation is always indicated with narrower-selection guidance), parallel ledgers beyond 0L, execution audit logging (no standing report-audit policy; the report posts nothing), and operational-document navigation beyond the accounting-document display and its origin reference. Read-only throughout; no schema change (migrations stay 184, catalogue unchanged 152/125/144). Stage order: 1 export route + CSV builder + screen action, 2 tests + browser acceptance (T883 extension) and closure; each stage separately committed and pushed. Same-stage bookkeeping: B-802 / §26.818 / §30 row 2.636.

## §26.819 — SCR-113 stage 1: export route and screen action

**B-803, recorded 2026-10-20.** Stage 1 of SCR-113 stands: `profitCenterLinesCsv` in the profit-centre report service renders one executed selection to CSV — every line-item column the grid shows, amounts at four decimals, RFC-style quoting — opening with a `# TRUNCATED at {maxHits} hits` comment when the hit-limit window cut the selection, so a partial file never reads as complete. `GET /controlling/profit-center-report/export` guards on the same `FIN.RPT.PROFITCENTER.read` capability the screen judges, parses the same selection the page parses (controlling area required, ledger and hit limits under the standing rules and refusals), runs the same `listProfitCenterLines` derivation, and returns `profit-center-lines-{area}-{year}.csv` as an attachment; ProfitCenterReportError maps to a 400 with its remedy, as the ageing export precedent set. The report screen carries an **Export CSV** action beside Execute, addressed at the standing selection. TypeScript green. Tests and browser acceptance (T883 extension) follow in stage 2. Same-stage bookkeeping: B-803 / §26.819 / §30 row 2.637.

## §26.820 — SCR-113 closure: KE5Z CSV export accepted

**B-804, recorded 2026-10-20.** SCR-113 is **CLOSED**. Stage 2 stands: `tests/profit-center-report.test.ts` (5/5) pins the export against the standing fixture — the CSV opens with its header, carries exactly the shown window (revenue row with PC1000, −7000.0000 and its line text), and a hit-limit window of one line opens with the `# TRUNCATED at 1 hits` marker over header plus the single line; browser target `profit-center-report` (**T883 extended**) passes against the production build: the posted line stands with its profit centre and signed amount, the Export CSV action stands on the screen, and the export route downloads the same selection as CSV (header first, the PC9001/400000 line at 5000.0000), persisting nothing. The full suite stands at **1576/1576** (228 files) and the production build is green. SCR-113 delivered the named KE5Z follow-up: a capability-guarded CSV export of exactly the profit-centre line-item selection the screen shows — same derivation, same hit-limit window, truncation marked in the file itself. **Re-affirmed deferred by name (§26.818):** partner profit centre, G/L account groups, KE5Y plan line items, interactive sorting/filtering and layout variants, pagination beyond the hit-limit window, parallel ledgers, execution audit logging, operational-document navigation beyond the document display. No schema change stands; migrations **184**, catalogue **152/125/144**. `FUNCTIONS-AND-ROADMAP.md` reflects the closure. Next round per the queue: the **SCR-114 clearing follow-ups — tolerance difference posting first** (manual G/L clearing family, F-03), then partial/residual and multi-currency clearing; intercompany items remain last (B-663). Same-stage bookkeeping: B-804 / §26.820 / §30 row 2.638.

## §26.821 — SCR-114 follow-up contract: tolerance difference posting for manual G/L clearing

**B-805.** Owner package (2026-10-20): F-03 (Clear G/L Account, manual clearing) — the tolerance-difference follow-up named first among the SCR-114 deferrals (delivered B-741, browser T882). Verified standing state: `clearGlItems` (`FIN.GL.CLEAR`) clears open items of an open-item-managed account through one balanced clearing journal (advisory lock per company/account, request-key idempotency, row locks with revalidation, single-currency selections) and refuses any nonzero difference by name; the tolerance canon already stands — OBA4 employee tolerance groups carry payment-difference amount and percentage limits split revenue/expense (`employee_tolerance_group`), the default group of a company resolves company-scope else tenant-wide, and the payment screens judge a difference permitted when it stands within **both** the absolute limit and the percentage limit (the smaller binds), posting it through the `PAYMENT_DIFFERENCE` account determination (alias DIF, modifiers REV/EXP by side). Contract: (1) **Service** — a nonzero selected difference within the default tolerance group's limits for its side (a debit difference judged on the expense pair, a credit on the revenue pair; percentage judged against the gross selected volume) posts as one additional line of the clearing journal on the PAYMENT_DIFFERENCE determined account, so the journal balances and the items clear in full; the clearing journal's own-line clearing stamp narrows to the cleared account's lines, so the difference line stands as an ordinary revenue/expense line of the clearing document. Beyond tolerance — or when no default group or no determination stands — the clearing refuses by name with the remedy, exactly as nonzero differences refuse today; nothing is ever silently rounded away. (2) **Screen** — the clearing view carries the default group's four difference limits; the selection panel judges the live difference against them, names a within-tolerance difference as posting to the difference account, and enables Post for it; beyond tolerance stays blocked with its reason. The service re-judges at posting under lock. **Re-affirmed deferred by name:** partial/residual clearing (the next SCR-114 follow-up; a tolerated difference clears items in full and is not a partial allocation), multi-currency clearing (one clearing settles one currency, refused by name today), cash-discount and exchange-rate differences in this screen (the payment screens own them), draft state, and an allocation table (the canon clearing stamps and change document are the standing relationship). No schema change (migrations stay 184, catalogue unchanged). Stage order: 1 service + tests, 2 screen + browser acceptance (T882 extension) and closure; each stage separately committed and pushed. Same-stage bookkeeping: B-805 / §26.821 / §30 row 2.639.

## §26.822 — SCR-114 follow-up stage 1: difference posting in the clearing service

**B-806, recorded 2026-10-20.** Stage 1 of the SCR-114 tolerance follow-up stands: `clearGlItems` now judges a nonzero selected difference under the default tolerance group (company scope else tenant-wide, as the payment screens resolve it) — a debit difference on the expense limits, a credit on the revenue limits, percentage against the gross selected volume, both limits holding with the smaller binding — and posts it as one additional line of the clearing journal on the `PAYMENT_DIFFERENCE` determined account (EXP/REV modifier by side), so the journal balances and the selected items clear in full. The clearing journal's own-line stamp narrows to the cleared account's lines, leaving the difference line standing as an ordinary expense/revenue line of the clearing document, and the change document names a posted difference and its account. Beyond tolerance, with no default group, or with no determination standing, the clearing refuses by name with its remedy — nothing is rounded away. The clearing view now carries the default group's four difference limits for the screen's live judgement. Acceptance: `tests/gl-clearing.test.ts` **7/7** — no-group refusal, within-tolerance posting (difference of 5 debited to the determined EXP account, unstamped, items cleared), beyond-tolerance refusal with no journal written, beside the standing balanced/replay cases; TypeScript green. (This stage also absorbed an environment restore: `npm ci` and the PostgreSQL restore after a sandbox wipe.) The screen and browser acceptance (T882 extension) follow in stage 2. Same-stage bookkeeping: B-806 / §26.822 / §30 row 2.640.

## §26.823 — SCR-114 follow-up CLOSED: tolerance difference posting accepted

**B-807, recorded 2026-10-20.** The tolerance difference follow-up stands closed. Stage 2: the clearing screen judges the live difference against the default group's limits (debit on the expense pair, credit on the revenue pair, percentage against the gross selected volume, the smaller of absolute and percentage binding) and names the outcome in place — a balanced selection states it balances, a within-tolerance difference states it posts to the payment difference account and enables Post, a beyond-tolerance difference names the ceiling on this selection, and a group-less tenant is told the difference must stand at zero; the service re-judges at posting under the advisory lock and row locks, so the screen never decides alone. Acceptance: `tests/gl-clearing.test.ts` 7/7 (no-group refusal, within-tolerance posting of a 5 difference as an unstamped expense line on the determined PAYMENT_DIFFERENCE account with the items cleared, beyond-tolerance refusal with no journal written, replay and already-cleared refusals unchanged); the source contract test now pins the delivered tolerance posting and the still-deferred partial/residual clearing in the vocabulary header; **T882 (extended) PASSED** against the production build — two balancing items clear and stamp, then a pair standing 5 apart judges within tolerance on screen, posts, leaves the difference as an ordinary unstamped expense line, and clears the items; full suite **1579/1579 (228 files)**; build and TypeScript green. **Deferred/re-affirmed by name:** partial and residual clearing (the next SCR-114 follow-up — a tolerated difference clears items in full and is not partial allocation), multi-currency clearing (one clearing still settles one currency), cash-discount and exchange-rate differences in this screen (the payment screens own them), draft state, and an allocation table (the standing clearing stamp and change document remain the relationship). No schema change: migrations stay **184**, catalogue unchanged at **152 capabilities / 125 terms / 144 aliases** (the tolerance canon already stood from OBA4 and the PAYMENT_DIFFERENCE event). Cost measured: contract 02:24 → closure 02:56, one continuous sitting with an environment restore (node_modules, PostgreSQL, Chromium). Same-stage bookkeeping: B-807 / §26.823 / §30 row 2.641.

## §26.824 — SCR-114 advanced clearing contract: partial, residual, and multi-currency (F-03 / F-32 / F-44)

**B-808.** Owner package (2026-10-20), the second and third SCR-114 follow-ups in one round. Standing canon judged first: the clearing service carries the source items' local amounts, stamps cleared lines in place, and already resolves the OBA4 default group and the `PAYMENT_DIFFERENCE` determination; the act of clearing is a balanced clearing journal on the same account, so a lone item can never clear — partial and residual clearing therefore both operate on a **selection whose settlements offset**, exactly as SAP's G/L clearing does:

- **STANDARD** (delivered): every selected item clears in full; a difference stands at zero or within the default tolerance group (B-805).
- **PARTIAL**: each selected item carries a settlement amount, defaulting to its remaining open balance and reducible by the operator; the settlements must offset under the standing rules. An item settled below its remaining balance **stays open for the balance** — it is not stamped cleared, no residual item is created, and each applied amount stands on a normalized allocation record. Its remaining open balance derives as original amount − applied allocations, never double-counted; later clearings settle the remainder.
- **RESIDUAL**: the same settlement entry, but an item settled below its remaining balance **closes fully and its remainder becomes a new open item**: a residual line of the clearing document on the same account, same side as the original, carrying the configured residual reason code and lineage to the original item, clearing document, reason and generated amount. The residual amount is system-calculated (remaining − settlement), never typed; the original item's amount and identity are never reused. Inherited attributes: account, business partner, currency, company, and the clearing document's dates; payment-term and baseline-date inheritance into the ageing derivation is **deferred by name** (the line model carries no terms columns; residual items age from the clearing document's posting date until a terms-carrying residual rule exists).
- **MULTI-CURRENCY**: same-currency clearing stays the default. Cross-currency clearing runs only when the operator asks for it and every source currency carries a rate to the company's local currency at the clearing date (AVERAGE type, standing quote convention) — a missing rate refuses naming the currency pair and the exchange-rate table. The clearing document posts in the local currency; each clearing line carries the source item's **original local carrying amount** (carved proportionally for a partial settlement), so the account reverses exactly; the translated settlement values must offset in local currency (refused naming the leftover), and the realized exchange difference — the signed sum of the carved carrying amounts — posts to the `FXGAIN` or `FXLOSS` account determination (the canon's own events; SAP's OBYC key KDF is a search alias only and is never assumed universal). Currency precision follows the configured currency decimals; no two-decimal assumption.

**Schema (migration 9062, first new migration since 184):** `gl_clearing_allocation` (tenant, company, G/L account, clearing document/fiscal year/line, source document/fiscal year/line, allocated amount, currency, clearing method, audit) keyed one row per clearing line × source line; `gl_clearing_residual` (tenant, company, G/L account, clearing document/fiscal year/line, original document/fiscal year/line, residual document/fiscal year/line, reason code, generated amount, currency, audit); `residual_reason` master (tenant, three-character key at T041C parity, description, active flag, audit — deactivation only, never a delete). All tenant-aware; rows are immutable history and never physically deleted; reset lifts allocations through the standing reset workflow and records the reversal lineage.

**Deferred by name:** cross-currency partial and residual (cross-currency stands standard-clearing only this round), exchange-rate difference *valuation* of open items (this round posts realized differences at clearing only), residual payment-term/baseline inheritance into ageing (above), and drafts. Stage order: 1 schema + contract test, 2 partial, 3 residual, 4 multi-currency, 5 screen + reset integration + browser acceptance + closure; each separately committed and pushed. Same-stage bookkeeping: B-808 / §26.824 / §30 row 2.642.

## §26.825 — SCR-114 advanced clearing stage 1: the normalized records

**B-809, recorded 2026-10-20.** Migration **9062** (`drizzle/9062_gl_clearing_advanced.sql`, the 185th) adds the three records the advanced clearing needs, none of which duplicates the ledger: `gl_clearing_allocation` — one row per clearing line × source line carrying the applied amount, currency and method (STANDARD/PARTIAL/RESIDUAL), keyed on the full clearing and source identities, an active flag and reset number for the standing reset workflow, with a source lookup index and positive-amount and method checks; `gl_clearing_residual` — the residual lineage (clearing document/fiscal year/line, original item, residual line, reason code, generated amount, currency), indexed by original item; and `residual_reason` — the tenant's three-character residual reason master at T041C parity, deactivation only. Every table carries forced row-level security with one tenant policy and the `cairn_app` grant, identical to every tenant registry. Acceptance: the schema contract test **6/6** (tables, checks, indexes, RLS parity, Drizzle columns), TypeScript green, migration applied cleanly (**185** migrations now). Same-stage bookkeeping: B-809 / §26.825 / §30 row 2.643.

## §26.826 — SCR-114 advanced clearing stage 2: partial clearing

**B-810, recorded 2026-10-20.** `clearGlItems` takes a clearing method (`STANDARD` default, `PARTIAL`, `RESIDUAL`) and a per-item settlement amount (blank settles the remaining balance). In PARTIAL the offset line applies just the settlement, the item's remaining open balance derives as its local amount minus its active allocations (proportional carving for foreign currency), and an item settled below its balance **stays open, unstamped, with no residual replacement**; an item settled in full clears. Every offset writes one normalized `gl_clearing_allocation` row keyed to the clearing line and the source line, and the open-item view now carries `applied` and `remaining` so prior allocations show. Settlements must still offset — a debit difference on the expense limits, a credit on the revenue, both tolerance limits holding — and a settlement above the remaining balance, at or below zero, or an unbalanced selection refuses by name. Acceptance: `tests/gl-clearing.test.ts` **9/9** — a 600 settlement on a 1,000 item leaves it open for 400 with one PARTIAL allocation while its 600 counterpart clears, a later standard clearing settles the 400 remainder, and over-settlement, zero settlement and imbalance each refuse; the seven standing standard/tolerance cases pass unchanged. Same-stage bookkeeping: B-810 / §26.826 / §30 row 2.644.

## §26.827 — SCR-114 advanced clearing stage 3: residual clearing

**B-811, recorded 2026-10-20.** RESIDUAL closes an item in full and re-stands its remainder as a new open item: the clearing document offsets every selected item at its full remaining balance, each remainder line stands on the same account and the same side as its original with the partner inherited, the residual reason is validated against the configured, active three-character master, and the lineage lands in `gl_clearing_residual` (clearing line, original item, residual line, reason, amount). A residual line is never stamped — it is the new open item — while the original stands cleared with its amount and identity untouched. The residual amount is computed, never typed; residual clearing without a remainder, without a reason, or with an unconfigured reason refuses by name. Acceptance: **11/11** — a 1,000 item settled at 400 against a 400 counterpart closes both originals, generates exactly one 600 residual (lineage `R01`, residual line = the open line), and the three refusals hold. Same-stage bookkeeping: B-811 / §26.827 / §30 row 2.645.

## §26.828 — SCR-114 advanced clearing stage 4: multi-currency clearing

**B-812, recorded 2026-10-20.** Cross-currency clearing stands when the operator asks for it: the selection may span currencies only then (same-currency stays the default and a mixed selection without the flag refuses by name), every source currency must carry an AVERAGE rate to the company's local currency on or before the clearing date (a missing rate refuses naming the pair and the exchange-rate maintenance), the settlements must offset after translation at the clearing-date rates, and the clearing document posts in the **local currency** carrying each source item's original local carrying amount, so the account reverses exactly. The realized exchange difference — the signed sum of the released carrying values — posts to the `FXGAIN` or `FXLOSS` account determination (refused by name when the determination does not stand), which is the canon's own event pair; no SAP key is assumed. Cross-currency stands for standard clearing only, as contracted. Acceptance: **12/12** — 100 EUR carried at 0.30 (30 local) against 100 GBP carried at 0.31 (31 local) clear at matching 0.30 closing rates, the document posts 31 debit against 30 + 1 credit with the 1 gain on the determined FXGAIN account, both items close, the same selection without the flag refuses ("one clearing settles one currency"), and a JPY item without a rate refuses naming the pair. Same-stage bookkeeping: B-812 / §26.828 / §30 row 2.646.

## §26.829 — SCR-114 advanced clearing stage 5 and CLOSURE: screen, reset, acceptance

**B-813 (stage 5a), B-814 (stage 5b), B-815 (stage 5c and closure), recorded 2026-10-20.** The screen carries the whole contract: a clearing-method selector (standard, partial, residual), a per-item settlement input that defaults to the remaining balance, a residual-reason field shown only under residual clearing, a cross-currency tick that appears only when the selection spans currencies, and Applied / Remaining columns fed by the allocation record; the confirmation names the method and, where one was generated, the residual item and its reason. Reset integration (stage 5a): the standing clearing-reset workflow now lifts allocations as **history** — rows stand inactive with the reset number, restoring the source items' remaining balances — and a clearing that generated residual items refuses a plain reset by name, pointing at the reversal workflow, because lifting the stamps alone would leave the residual line open beside the reopened originals. Acceptance: **T882 (extended) PASSED** against the production build — the standard pair clears and stamps, the tolerance pair posts its 5 difference unstamped, a 1,000 item settled at 600 posts by partial clearing and stands open with 400 remaining and one active allocation, and a 500 item settled at 200 posts by residual clearing re-standing exactly one 300 residual line under reason R01 with the lineage naming the open line; the residual leg selects its own documents because the 400 partial remainder rightly still stands open. Service suite `tests/gl-clearing.test.ts` **14/14**; full suite **1589/1589 (228 files)**; build and TypeScript green. **Deferred/re-affirmed by name:** cross-currency partial and residual clearing (cross-currency stands for standard clearing only, refused by name), exchange-rate difference **valuation** of open items (this round posts realized differences at clearing; FX valuation is its own delivered screen), residual payment-term and baseline-date inheritance into the ageing derivation (the line model carries no terms columns — residual items age from the clearing document's posting date until a terms-carrying residual rule exists), and drafts. Migrations **185** (9062 adds the allocation, residual-lineage and reason records; the reason master is deactivated, never deleted). Catalogue unchanged at **152 capabilities / 125 terms / 144 aliases** — F-03 is an alias of a delivered capability and the new records extend it rather than adding one. Same-stage bookkeeping: B-815 / §26.829 / §30 row 2.647.

## §26.830 — SCR-114 follow-up contract: residual terms inheritance, cross-currency partial/residual, FX routing

**B-816.** Owner package (2026-10-20): the three named deferrals from the advanced clearing closure — residual payment-term inheritance into ageing, cross-currency clearing beyond standard, and realized-FX account routing with a spread tolerance. Standing canon judged first: `journal_entry_line` carries no terms or baseline columns while the ageing derivation resolves due dates only from the origin invoice (`supplier_invoice`, `vendor_invoice`, `customer_invoice`), so a residual item today ages from the clearing document's posting date; the clearing document posts in the local currency with each source item's original carrying carve and routes the realized difference to the `FXGAIN`/`FXLOSS` determinations; cross-currency stands standard-only. Contract:

- **Residual terms inheritance — line-level.** Migration **9063** adds `payment_terms` (≤12) and `baseline_date` to `journal_entry_line`, both nullable; a line carrying them **wins over origin resolution** in `deriveAgeingItems`, so the due date computes from the line's own terms and baseline through the standing `calculatePaymentSchedule`. Residual generation stamps them from the source item's resolvable origin invoice when the operator keeps *Inherit payment terms* checked (the package's default); when the source has no resolvable origin the inheritance stands not applicable — the fields stay blank and the residual ages from the clearing posting date, stated on the screen — never a refusal, because a residual is legitimate without a terms-bearing origin. *Inherit assignment* stamps the source line's assignment onto the residual line. Every stamping is recorded in the change document.
- **Cross-currency partial and residual.** PARTIAL and RESIDUAL join STANDARD in cross-currency mode. Each item settles in its own currency; applied amounts translate at the clearing date's AVERAGE rates and must offset in the local currency; the document posts local; each source item's released carrying value is its proportional carve; a residual line re-stands in the **source item's own currency** and carries its own remaining carve, so the account stays exact. A translated imbalance refuses by name as it does today.
- **Realized-FX account routing.** An optional per-clearing `fxDifferenceAccount` (the package's OBA1/F-05 override) must exist in the company's chart **and** stand extended to the company (the SKB1 parity check), must be a P&L account (`PL_STATEMENT`), and must not be the cleared account itself; when named it replaces the `FXGAIN`/`FXLOSS` determination for that clearing only, and the change document records the override beside the determined default. When absent the determinations stand as delivered.
- **Spread tolerance.** An optional `exchangeRateSpreadTolerancePercent`: when set, a realized difference whose absolute value exceeds that percentage of the gross translated settlement volume refuses by name (stating the actual percentage and the ceiling) and names the two remedies — set the FX account override explicitly, or widen the tolerance. When not set, no ceiling stands (the delivered behaviour). The tolerance never silently swallows a difference.
- **Audit and lifecycle.** Inheritance flags, the inherited terms/baseline/assignment, the currencies and clearing-date rates, the FX account override and the variance amount all land in the clearing's change document (the canon audit record — the package's separate inheritance-log table is deliberately **not** added: it would duplicate the normalized change-document items Cairn already writes for every clearing, and the round adds no second audit store). Reset keeps the standing rules: allocations lift as history and a residual-bearing clearing refuses a plain reset naming the reversal path. Posting periods stay judged by `derivePosition` (OB52 parity). Line-item inspection (FBL3N/FBL5N) rides the standing `/finance/journal/items` drill.

**Deferred by name:** residual documents as their own document type (the residual line lives in the clearing document, as contracted), FX *valuation* of open items (its own delivered screen), and drafts. Stage order: 1 schema + contract test, 2 terms inheritance + ageing, 3 cross-currency partial/residual, 4 FX routing + spread tolerance, 5 screen + browser acceptance + closure; each separately committed and pushed. Same-stage bookkeeping: B-816 / §26.830 / §30 row 2.648.

## §26.831 — SCR-114 follow-up stage 1: the line carries its own terms

**B-817, recorded 2026-10-20.** Migration **9063** (the 186th) adds `payment_terms` (≤12) and `baseline_date` to `journal_entry_line`, both nullable, with column comments stating the precedence rule; the posting engine's `PostingLineInput` and its inserted values carry both fields, so a line's terms travel through the canonical posting path rather than around it. Nothing reads them yet — the ageing derivation and the residual stamping land in stage 2. Acceptance: schema contract **8/8** (migration shape, Drizzle columns, posting-engine pass-through), TypeScript green, migration applied cleanly (**186** migrations). Same-stage bookkeeping: B-817 / §26.831 / §30 row 2.649.

## §26.832 — SCR-114 follow-up stage 2: inheritance stamped, ageing precedence proven

**B-818, recorded 2026-10-20.** Residual generation now reads the source item's origin invoice (supplier, vendor or customer path) and, when *Inherit payment terms* stands on (the default), stamps its payment terms and baseline date onto the residual line; *Inherit assignment* stamps the source line's assignment. Both switches stand per clearing, and the change document records the flags, the inherited values and the residual reason beside the existing FX and tolerance entries. A source with no resolvable origin inherits nothing — the fields stand blank and the residual ages from the clearing posting date, never a refusal. The ageing derivation reads the line's own terms **ahead of** origin resolution: a line carrying `payment_terms` computes its due date from its own baseline through `calculatePaymentSchedule`, and origin invoices are consulted only for lines without them, so the standing SCR-066/070/120 behaviour is unchanged for every ordinary line. Acceptance: `tests/gl-clearing.test.ts` **16/16** — a residual off an 800 invoice (NET30, baseline 2026-04-28, assignment PO-778) settles at 200 and its 600 residual line carries all three values; with both switches off the same clearing stamps none of them. `tests/vendor-ageing.test.ts` **5/5** — a NET60 line with baseline 2026-12-01 posted on 2026-10-10 judges due 2027-01-30, not overdue at 2026-12-20, which the posting-date fallback could never produce. Same-stage bookkeeping: B-818 / §26.832 / §30 row 2.650.

## §26.833 — SCR-114 follow-up stage 3: cross-currency partial clearing

**B-819, recorded 2026-10-20.** PARTIAL joins STANDARD in cross-currency mode: each item settles in its own currency, applied amounts translate at the clearing-date rates and must offset in the local currency, and each offset line carries its proportional **carrying** carve, so the realized exchange difference lands only on the settled portion. One narrowing is recorded against the contract: **cross-currency RESIDUAL is refused by name** — a residual must re-stand in its source item's currency, but a journal line carries its document's currency, so a foreign residual inside a local-currency clearing document cannot be represented faithfully; the refusal names that reason and offers the two remedies. Acceptance: **18/18** — a 1,000 EUR item (0.30 carrying) settled at 600 across a GBP 600 counterpart leaves 400 EUR = 120 local open with one active allocation while the GBP item clears, the document balances, and the residual attempt refuses. Same-stage bookkeeping: B-819 / §26.833 / §30 row 2.651.

## §26.834 — SCR-114 follow-up stage 4: realized-FX routing and spread tolerance

**B-820, recorded 2026-10-20.** An optional `fxDifferenceAccount` names the account a realized exchange difference posts to, replacing the standing `FXGAIN`/`FXLOSS` determination for that clearing only — after four validations, in order: the account stands in the company chart, it is not the cleared account itself, it stands extended to the company (the SKB1 parity), and it is a `REVENUE`/`EXPENSE` account. An optional `exchangeRateSpreadTolerancePercent` puts a ceiling on the realized difference as a share of the gross translated settlement: beyond it the clearing refuses, stating the actual percentage and the ceiling and naming both remedies (name the FX account explicitly, or widen the tolerance); within it — or with no tolerance set — the difference posts. Both facts land in the change document (`exchangeAccountOverride`, `spreadTolerancePercent`) beside the difference amount. Acceptance: **21/21** — a 1 EUR difference routes to an explicitly named P&L account on the credit side; a nonexistent account, a balance-sheet account and the cleared account itself each refuse by name; a difference of 1 on a gross of 300 refuses at a 0.1% tolerance and posts at 5%. Same-stage bookkeeping: B-820 / §26.834 / §30 row 2.652.

## §26.835 — SCR-114 follow-up stage 5 and CLOSURE: screen, acceptance, round closed

**B-821, recorded 2026-10-20.** The clearing screen carries the follow-up: under residual clearing two switches stand **checked by default** — *Inherit payment terms* and *Inherit assignment* — and under a cross-currency selection two fields appear — *Realized FX account* (blank keeps the standing determination) and *Spread tolerance %* (blank keeps no ceiling). The action passes all four through the service, which re-validates every one of them. Acceptance: **T882 (extended) PASSED** against the production build — thirteen legs, the new ones posting an 800 invoice-backed item (origin `vendor_invoice` VI-B1, NET30, baseline 2026-04-14, assignment PO-B1) against a 200 credit by residual clearing, after asserting both inheritance switches stand checked, and reading back the generated 600 residual line carrying `NET30`, the source baseline and `PO-B1`. Service suite `tests/gl-clearing.test.ts` **21/21**, `tests/vendor-ageing.test.ts` **5/5**, schema contract **8/8**; full suite **1599/1599 (228 files)**; build and TypeScript green. Migrations **186** (9063 adds the two line columns). Catalogue unchanged at **152 capabilities / 125 terms / 144 aliases** — the round extends F-03 rather than adding a capability.

**Deferrals re-affirmed by name:** cross-currency **residual** clearing (refused by name — a residual must re-stand in its source currency while a journal line carries its document currency; lifting this needs a per-line currency model), residual documents as their own document type, FX *valuation* of open items (its own delivered screen), and drafts. The package's separate `clearing_terms_inheritance_log` table stays deliberately unbuilt: the change document already records the flags, the inherited terms/baseline/assignment, the FX override, the tolerance and the variance for every clearing. Same-stage bookkeeping: B-821 / §26.835 / §30 row 2.653.

## §26.836 — SCR-122 contract: intercompany posting and OBYA clearing configuration

**B-822.** Owner package (2026-10-20): intercompany posting (FB01 parity) with automatic OBYA mirror posting and trading-partner stamping — the last item in the clearing queue (B-663). Standing canon judged first: `company_code.intercompany_clearing_account` already carries the OBYA clearing account per company (seeded `110100` by the standard structure) but nothing posts through it; `journal_entry_line` carries the posting company and a business partner but **no trading partner**; consolidated statements stand pre-elimination with eliminations deferred by name, so the trading-partner stamp is forward-looking data rather than a live elimination input. Contract:

- **Configuration (OBYA).** A new `intercompany_clearing_config` keyed by tenant × sending × receiving company, carrying optional clearing-account overrides for each side and an optional default document currency. Resolution is pair-override first, then each company's standing OBYA clearing account; a side with neither refuses by name. A configuration screen (`/config/intercompany-clearing`) lists, creates and deletes pairs; both companies must stand in the tenant, be active, and differ.
- **Posting (FB01 parity).** One submission posts **two balanced journals in one transaction**: the sending document carries the operator's lines plus one clearing line on the sending side's OBYA account for the balancing remainder; the receiving document carries the reversed operator lines plus one clearing line on the receiving side's OBYA account. Each journal posts through `postJournalEntry`, so period validation (OB52 parity), numbering, document flow and audit all ride the canon; the two documents link to each other through a new `intercompany_document_header` record (sending and receiving document identities, dates, currency, reference, status). No document is left posted without its partner — the single transaction is the guarantee.
- **Trading partner (VBUND/RCOMP).** Migration **9064** adds `trading_partner_company` to `journal_entry_line`. Every intercompany line — operator lines and clearing lines, both documents — stamps the *other* company, so a consolidation elimination can read the pair from the ledger when that engine lands.
- **Currency.** The transaction currency governs the operator lines; each company's document translates to its own local currency through the clearing-date rate service (identical currency means a rate of 1); a missing rate refuses naming the pair and the company. Both documents must balance in their own local currency; a failure anywhere rolls back both.
- **Clearing (F-03 parity).** The OBYA balances are ordinary open-item-managed G/L balances: the standing `FIN.GL.CLEAR` screen clears them when settlement occurs, with the delivered tolerance, partial, residual and cross-currency rules. Nothing IC-specific is added to clearing.
- **Audit.** One change document per posting names both documents, both companies, the clearing accounts used, the currency and the operator; the configuration screen writes its own change documents.

Capabilities: **`FIN.IC.POST`** (posting) and **`CFG.FIN.IC.DEFINE`** (configuration, term alias **OBYA**), added to the catalogue. **Deferred by name:** automatic partner-document reversal propagation (reversing one side does not yet reverse the other — the pairing record makes it visible, and the reversal engine remains single-document), intercompany profit elimination (the consolidation engine stays deferred), IC invoices/orders (only journal postings), and drafts. Stage order: 1 schema + contract test, 2 posting service + tests, 3 configuration and posting screens + catalogue, 4 browser acceptance + closure; each separately committed and pushed. Same-stage bookkeeping: B-822 / §26.836 / §30 row 2.654.

## §26.837 — SCR-122 stage 1: the intercompany records

**B-823, recorded 2026-10-20.** Migration **9064** (the 187th) adds three things and duplicates nothing: `intercompany_clearing_config` (ordered company pair, optional clearing-account overrides per side, optional default currency, distinct-pair check) — the OBYA clearing account itself stays on the company master as it always has; `intercompany_document_header` (sending document identity, receiving company and partner document identity, dates, currency, reference, status) keyed on the sending document with a partner lookup index, so neither document of a pair stands without the other; and `trading_partner_company` on `journal_entry_line` (VBUND/RCOMP parity), carrying the other company of the pair so a future elimination can read it from the ledger. Both new tables carry forced row-level security with one tenant policy and the `cairn_app` grant. Acceptance: schema contract **4/4** (records, RLS parity, Drizzle columns, OBYA reuse), TypeScript green, migrations at **187**. Same-stage bookkeeping: B-823 / §26.837 / §30 row 2.655.

## §26.838 — SCR-122 stage 2: the posting service

**B-824, recorded 2026-10-20.** `postIntercompany` posts the pair: the operator's primary lines fill the sending document, one clearing line on the sending side's OBYA account balances it, and the receiving document mirrors the primary lines with its own OBYA clearing line — both through `postJournalEntry`, in one transaction, with a request key that replays rather than repeats. The clearing account resolves pair-override first and the company's standing OBYA account second, validated to exist in the chart and stand extended to the company; the transaction currency translates to each company's local currency at the posting date's AVERAGE rate, a missing rate refusing and naming the company. Operator lines that already balance refuse by name (there would be no intercompany clearing to post). Both documents stamp the other company as their trading partner, the pairing lands in `intercompany_document_header`, and the change document names both documents, both companies, both clearing accounts, the currency and the operator. Configuration rides the same module: `saveIntercompanyConfig` validates both companies exist, are active and differ, checks any override clearing account against that side's chart and requires a balance-sheet type; deletion is refused once the pair has served a posting, and the change documents record both acts. Acceptance: `tests/intercompany.test.ts` **6/6** — the pair posts two balanced documents with four stamped lines (verified per company), the pairing row names the partner document, replay posts nothing new, the OBYA balance clears through the standing `FIN.GL.CLEAR`, self-pairing / unknown partner / pre-balanced lines each refuse, and the configuration validates, refuses deletion once served and deletes an unused pair. Same-stage bookkeeping: B-824 / §26.838 / §30 row 2.656.

## §26.839 — SCR-122 stage 3 and CLOSURE: screens, catalogue, acceptance

**B-825 (stage 3), B-826 (stage 4), B-827 (closure), recorded 2026-10-20.** Two screens carry the round. `/config/intercompany-clearing` (capability `CFG.FIN.IC.DEFINE`, term alias OBYA) lists the configured pairs with each side's clearing account and default currency — blank showing "company OBYA account" / "company currency" so the fallback is never a mystery — saves a pair from company pickers, and offers Delete, which the service refuses for any pair that has served a posting. `/finance/intercompany` (capability `FIN.IC.POST`, alias FB01) takes the sending and receiving company, dates, document type, currency and reference over an editable line grid, and states in place that only the sending side's primary lines are entered because the OBYA clearing lines are generated. The catalogue gains **two capabilities** (`FIN.IC.POST`, `CFG.FIN.IC.DEFINE`) and **two terms** (the OBYA configuration activity and the FB01 posting transaction with its OBYA alias), reaching **154 capabilities / 127 terms / 146 aliases**. Acceptance: **T920 PASSED** against the production build — six legs: the pair configured on screen and read back from the pair table, one posting producing two documents, both company ledgers balancing independently, every one of the four lines stamping the other company, the 5,000 primary line standing on both sides, and the pairing record naming the partner document with status POSTED. `tests/intercompany.test.ts` **6/6**; schema contract **4/4**; browser-target guard **159/159**; full suite **1610/1610 (230 files)**; build and TypeScript green. Migrations **187**.

**Two incidents recorded honestly.** (1) The acceptance target first claimed reserved key **T885**, which was already the profit/loss target; the harness's fixture-ownership rule meant that run recreated the profit/loss tenant. The intercompany target moved to the free key **T920**, was re-proven there, and the displaced `profit-loss` target was re-run green — no standing target was left broken. (2) The build exhausted memory twice because the sandbox's swapfile does not survive between runs; restoring it (`sudo fallocate -l 3G /swapfile-cairn && mkswap && swapon`) returns the build to ~2m20s, and that step belongs in the standing restore script.

**Deferred/re-affirmed by name:** reversing one side of a pair does not yet reverse the other (the pairing record makes the orphan visible; the reversal engine stays single-document), intercompany profit elimination (the consolidation engine stays deferred — the trading-partner stamp is the forward-looking data it will read), IC invoices and orders (journal postings only), and drafts. **FIN.IC.CLEAR was deliberately not created as a capability**: the OBYA balances are ordinary open-item balances and the standing `FIN.GL.CLEAR` screen clears them with the delivered tolerance, partial, residual and cross-currency rules. Same-stage bookkeeping: B-827 / §26.839 / §30 row 2.657.

## §26.840 — SCR-123 contract: purchase requisition list display (ME5A)

**B-828.** Owner package (2026-10-20): procurement opened with **ME5A — purchase requisitions, list display**, the first of the procurement roadmap items. Standing canon judged first: `purchase_requisition_item` (SCR-055, ME51N/ME52N/ME53N) already carries the requisition number and item, material and short text, quantity and unit, requisition date and delivery date, plant, storage location, purchasing group, material group, estimated price and currency, account-assignment category (`COST_CENTER` or blank), the marked-for-deletion flag and the creating user; **conversion** is derivable because `purchase_order_item` carries `requisition_number`/`requisition_item`; **purchasing organisation** is not carried on the item but is assigned per plant through `purchasing_org_plant`. The transaction is read-only and adds no state:

- **Selection.** Ranges for purchasing group, plant, material and purchasing organisation; exact requisitioner; requisition-date from/to; account-assignment category (`COST_CENTER` or none); *Display closed requisitions* (default off); maximum hits with the standing truncation marker. Every range endpoint is validated against its master when supplied — a plant, purchasing group or material that does not stand refuses by name rather than returning an empty list that looks like "no demand".
- **Purchasing organisation is derived**, not stored: a requisition item belongs to every organisation its plant is assigned to, so an org filter matches when **any** assignment falls in the range, and the row shows the mapped organisations. A plant mapped to no organisation stands visible with an empty organisation, never dropped.
- **Conversion status is derived** from live purchase-order items citing the requisition item: ordered quantity excludes lines marked for deletion; **OPEN** at zero, **PARTIAL** above zero and below the requisition quantity, **CONVERTED** at or above it. Open quantity is the requisition quantity less ordered, floored at zero (an over-delivered conversion never shows negative demand).
- **Closed** means converted or marked for deletion; the toggle decides whether such items appear. Rows carry requisition/item, material, short text, quantity, unit, ordered and open quantities, requisition and delivery dates, plant, purchasing group, organisations, account assignment, requisitioner, estimated price and currency.
- **Drill-down.** Each row links to the standing requisition display `/purchasing/requisitions?req={number}` (the ME53N equivalent).
- **Performance.** Migration **9065** adds the package's composite index on `(client, plant, purchasing_group, requisition_date)` **only if** a measured plan at realistic volume justifies it; otherwise stage 2 records a verification-only decision, as the SCR-120 stage-2 precedent did. Either outcome is published before the service lands.

**Deferred by name:** the tracking-number filter (the standing requisition item carries no such field and the create screen does not capture one — it arrives with a change transaction that can maintain it), display variants beyond the single grid (the ALV/standard-list choice, consistent with the layout-variant deferrals of SCR-112/113), requisition release-status display (release belongs to its own round), and exporting. Capability **`PROC.REQ.LIST`** with alias **ME5A**. Stage order: 1 contract, 2 index decision, 3 service + tests, 4 screen, 5 browser acceptance + closure; each separately committed and pushed. Same-stage bookkeeping: B-828 / §26.840 / §30 row 2.658.

## §26.841 — SCR-123 stage 2: index decision is verification-only (no migration 9065)

**B-829.** The contract made migration 9065 conditional on a measured plan. Measured, and it is not justified.

**Method.** `scripts/plan-me5a.mts` (committed as the evidence for this decision) seeds a throwaway tenant — 60,000 `purchase_requisition_item` rows over 10 plants × 8 purchasing groups × 24 months, 20,000 `purchase_order_item` rows citing half of them, plus the plant / purchasing-group / business-partner masters the foreign keys need — gathers statistics in a separate session so they are visible to the measured plans, and times the exact list query the service will issue (left join to the aggregated live conversion per requisition item, ordered requisition-date descending, `limit 500`). Three selection shapes, with and without the candidate index `(client, plant, purchasing_group, requisition_date)`, which is dropped afterwards; the tenant is destroyed.

| selection | no index | with candidate index | plan used |
| --- | --- | --- | --- |
| plant 1003, groups 001–002, 3 months | 33.3 ms | 25.6 ms | Seq Scan → Hash Right Join (index version: Index Scan using the candidate) |
| plants 1002–1005, groups 001–004, 6 months | 37.1 ms | 38.3 ms | Seq Scan on `purchase_requisition_item` → Hash Right Join on the conversion aggregate |
| all plants, all groups, 12 months | 176.0 ms | 73.9 ms (parallel seq scan both arms — planner ignores the index; difference is cache warmth) | Parallel Seq Scan → Hash Left Join |

**Decision — verification-only, no migration 9065.** The candidate index is chosen only for the narrowest shape, where it saves about 8 ms on a warm-cache 33 ms query, and it changes nothing for the medium shape (38.3 ms against 37.1 ms means the planner declines it). The two dominant costs are the top-N sort and the aggregate over `purchase_order_item`, which the index does not touch — `po_item_requisition_idx (client, requisition_number, requisition_item)` already serves the join. Adding a third index to a write-path table for an 8 ms gain in one of three shapes would spend write amplification on a read that already answers in well under a second at three times the pilot's expected volume. Migrations stand at **187**; the next migration number remains 9065, unused.

**For the service.** Stage 3 issues the query as measured (aggregate then left join, ordered by requisition date descending, `limit maxHits + 1` to prove truncation) and needs no schema change. If a later round makes the requisition table materially larger — or adds a filter shape the measurement did not cover — this decision is re-measured with the same harness rather than assumed.

Same-stage bookkeeping: B-829 / §26.841 / §30 row 2.659. Next stage 3: `PROC.REQ.LIST` service and tests.

## §26.842 — SCR-123 stages 3–5 and CLOSURE: the requisition list, its screen and ME5A acceptance

**B-830.** ME5A is delivered and closed.

**Stage 3 — the service (`PROC.REQ.LIST`).** `src/modules/purchasing/requisition-list.ts` issues the query the stage-2 measurement pinned: the live conversion aggregate over `purchase_order_item` (excluding lines marked for deletion) left-joined to the requisition items, ordered requisition-date descending, `limit maxHits + 1` so truncation is proven rather than guessed. The contract's decisions stand as written: the purchasing organisation is derived through `purchasing_org_plant` and an organisation filter matches when **any** plant assignment falls in range; a plant mapped to no organisation shows with an empty organisation and is never dropped; `OPEN`/`PARTIAL`/`CONVERTED` derive from live order items with the open quantity floored at zero; **closed** means converted or marked for deletion and the toggle decides visibility, with a standing note whenever closed rows are hidden. Every supplied range endpoint is judged against its master and refuses by name — plant, purchasing group, purchasing organisation and material too. Two guards were added beyond the literal contract because the alternative is an empty list that lies: an unknown requisitioner refuses (judged against `app_user` or against an existing requisition creator, so the historical `SYSTEM` creator stays selectable), and an impossible date refuses — JavaScript rolls `2026-02-30` over to 2 March, so the validator round-trips the calendar date instead of trusting `Date.parse`. Capability and the ME5A alias registered in the seed (`PROC.REQ.LIST`, terms 1, alias 1).

**Stage 4 — the screen.** `/purchasing/requisition-list`: selection panel for the four ranges, requisitioner, date range, account assignment (all / cost centre / none), the *Display closed requisitions* toggle and maximum hits; a grid carrying every row field the contract names plus the derived status; truncation and hidden-closed notices (`role="status"` / `role="note"`); refusal in `role="alert"`; each row drills to `/purchasing/requisitions?req={number}`. i18n keys `reqList.*` (46 keys). Browser target **`requisition-list`** registered on fixture key **T873** — the whole T9xx window is now allocated (T876–T999 all stand reserved), so the next free reserved key below that window was taken and the guard's 160 targets stand green.

**Stage 5 — acceptance. T873 PASSED, 6 legs:** the list shows open and partial requisitions and hides converted and marked ones by default; the toggle brings them back with `CONVERTED` and `MFD` derived on screen, and the row for the plant mapped to two organisations shows both (`O210, O220`); the plant range narrows the list; the organisation filter matches through the plant assignment (the doubly-mapped plant stands under either organisation); an unknown plant refuses by name in the alert rather than answering an empty list; a row drills down to the requisition display at `?req=9100000001`. Two harness corrections were needed and are recorded rather than hidden: the header command bar carries its own *Execute*, so the target scopes clicks to `form[aria-label="Selection"]`, and the refusal alert collides with Next's route announcer, so it filters the alert by its text.

**Gates.** Service **9/9**; UI contract **6/6**; target guard **160/160**; **full suite 1626/1626 across 232 files**; production build clean with `/purchasing/requisition-list` at 216 B / 106 kB; **T873 PASSED**. Catalogue **155 capabilities / 128 terms / 147 aliases** (seed re-run, counts read from the database). Migrations stand at **187** — stage 2 measured the candidate index and declined it, so no schema change landed in this round.

**Deferred by name, unchanged:** the tracking-number filter (BEDZN — the requisition item carries no such field; it arrives with a change transaction that can maintain it), display variants beyond this grid, requisition release-status display, and export.

Same-stage bookkeeping: B-830 / §26.842 / §30 row 2.660. The procurement roadmap continues with the next package the owner supplies.

## §26.843 — SCR-124 contract: purchase order list display (ME2L and the sibling perspectives)

**B-831.** Owner package (2026-10-20): procurement continues with the **purchasing report suite — ME2L purchase orders by vendor, with ME2M (by material), ME2N (by PO number) and ME2C (by material group)**. The frozen roadmap carries this as `PROC.PO.LIST`, "PO worklist by vendor, plant, date, status", with ME2M as its alias; the package makes **ME2L** the primary perspective, and all four real transaction codes are carried as search aliases on the one capability. Standing canon judged first — the purchase order already carries everything the package selects on: the header has supplier, purchasing organisation and group, company code, currency, document date and release status; the item has material, material group, plant, quantity and unit, net price with its price unit, net value, account-assignment category, the marked-for-deletion flag and the requisition number/item link; the schedule line carries the delivery date. No masters are added, and the transaction is read-only: **no state, no table**.

- **One engine, four perspectives.** `PROC.PO.LIST` takes a perspective — **VENDOR** (ME2L), **MATERIAL** (ME2M), **ORDER** (ME2N), **MATERIAL_GROUP** (ME2C) — which fixes the primary sort and marks the primary selector, exactly as the package's "grouped primarily by" describes. Every other selector stands available at the same time, as SAP's list displays allow combined selection; the perspective never hides a filter.
- **Selection.** Ranges for vendor, purchasing organisation, purchasing group, plant, material, material group and purchase order number; document-date from/to; maximum hits with the standing truncation marker. Every endpoint is judged against its master and refuses by name (vendor against `business_partner`, organisation against `purchasing_org`, group against `purchasing_group`, plant against `plant`, material against `material`, material group against `material_group`). A document-number range is a scan, not a master lookup, so its endpoints are not judged — but **from equal to** must name a purchase order that stands, or the selection refuses rather than answering an empty list.
- **Scope of selection** (required, defaulting to all): **All items**; **Still to be delivered** — ordered less delivered above zero; **Still to be invoiced** — delivered less invoiced above zero; **Completed** — delivered at or above ordered and invoiced at or above ordered. Both quantities are derived from posted history, never from a status column: **delivered** is the signed base quantity of the material-document lines citing the order item (a receipt adds, a reversal subtracts, and a cancelled material document contributes nothing); **invoiced** is the invoiced quantity of supplier-invoice items citing it whose invoice stands posted (a cancelled invoice contributes nothing). An order item carrying no schedule line shows an empty delivery date — the list never invents one.
- **Deletion and release.** A marked item shows its flag and its derived quantities, and appears under **All items** only: a marked commitment is not outstanding work, so it never stands in the "still to be" or "completed" scopes. The header release status (`UNRELEASED`/`RELEASED`) stands on every row as the package's status badge.
- **Requisition conversion linkage.** Each row names the requisition and item it converts, with the requisition's requested quantity so committed demand reads against the original demand; an item converting nothing shows no link.
- **Rows.** Purchase order/item, vendor code and name, purchasing organisation, purchasing group, company code, document date, material, short text, material group, plant, quantity and unit, net price with price unit, net value and currency, delivery date, release status, deletion flag, requisition number/item and requested quantity, delivered, invoiced, open delivery, open invoice, account-assignment category, derived status.
- **Drill-down.** Each row links to the standing purchase order display `/purchasing/orders?order={number}` (the ME23N equivalent).
- **Authorization and isolation.** The capability gates the screen; tenant scope comes from the session and row-level security enforces it — the package's company-code and vendor-master authorisations map to that capability gate in this canon, which carries no per-company authorisation model, and none is invented here.
- **Performance.** The package recommends a composite index on the header's tenant, vendor, organisation and document date. Stage 2 measures the real list query at volume and either takes **migration 9065** (still unused — SCR-123 measured and declined it) or records a verification-only decision, published before the service lands, as SCR-120 and SCR-123 did.

**Deferred by name:** the *Scope of List* presentation variants (ALV grid against standard list — the single grid ships, the same deferral as SCR-112, SCR-113 and SCR-123), the purchase-order history line-item drill (the EKBE equivalent) beyond the document display, release-strategy detail (the strategy behind `UNRELEASED` is its own round), and exporting. Capability **`PROC.PO.LIST`**, aliases **ME2L, ME2M, ME2N, ME2C**. Stage order: 1 contract, 2 index decision, 3 service + tests, 4 screen, 5 browser acceptance + closure; each separately committed and pushed. Same-stage bookkeeping: B-831 / §26.843 / §30 row 2.661.

## §26.844 — SCR-124 stage 2: index decision is verification-only (migration 9065 stays unused)

**B-832.** The package recommends a composite index on the header — tenant, vendor, purchasing organisation, document date. Measured, and it does not earn a migration.

**Method.** `scripts/plan-po-list.mts` (committed as this decision's evidence) seeds a throwaway tenant with 8,000 purchase orders × 5 items (**40,000 order items**), **20,000 goods-receipt lines** and **12,000 supplier-invoice items** citing them, plus the vendor, organisation, group, plant, material and movement-type masters the foreign keys need; statistics are gathered in a separate session; the exact list query the service will issue is timed — items joined to their headers, left-joined to the signed goods-receipt aggregate and the posted-invoice aggregate, ordered by the vendor perspective, `limit 501`. Three shapes, with and without `(client, supplier_number, purchasing_org, document_date)`, which is dropped afterwards.

| selection | no index | with candidate index | what the planner did |
| --- | --- | --- | --- |
| vendor V00007, org O100, 3 months | 1.36 ms | 0.17 ms | index chosen; both shapes already sub-2 ms |
| vendors V00010–V00060, all orgs, 6 months | 187.1 ms | 174.4 ms | index chosen on the header, but the item scan and the two aggregates dominate |
| all vendors, all orgs, 12 months | 223.8 ms | 220.3 ms | planner ignores the index; both arms scan |

**Decision — verification-only, no migration.** The index is worth 1.2 ms on a 1.4 ms query and about 7 % on the medium shape, and it is ignored outright on the broad one. Every shape that a user actually waits on is dominated by the sequential scan over `purchase_order_item` and the two aggregate joins over material documents and supplier invoices, none of which a header index touches; `po_item_requisition_idx` already serves the requisition link. A 500-row page answering in under a quarter of a second at 40,000 order items does not justify write amplification on every purchase order creation. **Migration 9065 stays unused; migrations stand at 187** — the second consecutive measured decline, and the harness ships so the decision can be re-measured rather than re-argued if volume or a filter shape changes.

**For the service.** Stage 3 issues the query as measured — aggregate before limiting, `limit maxHits + 1` to prove truncation, no schema change.

Same-stage bookkeeping: B-832 / §26.844 / §30 row 2.662. Next stage 3: the `PROC.PO.LIST` service and tests.

## §26.845 — SCR-124 stages 3–5 and CLOSURE: the order list, its screen and ME2L acceptance

**B-833.** The purchasing report suite is delivered and closed.

**Stage 3 — the service (`PROC.PO.LIST`).** `src/modules/purchasing/purchase-order-list.ts` is one engine behind the four perspectives the package names — **VENDOR** (ME2L, the primary), **MATERIAL** (ME2M), **ORDER** (ME2N) and **MATERIAL_GROUP** (ME2C). Each perspective fixes the primary sort while every other selector stays available, as SAP's list displays allow combined selection; the perspective answers to its code **or** its SAP alias, because a user typing ME2N should not have to know an internal name. The scope of selection is derived from posted history, never from a status column: **delivered** is the signed base quantity of material-document lines citing the order item — a receipt adds, a reversal subtracts, and a document that is not `POSTED` contributes nothing; **invoiced** is the invoiced quantity of supplier-invoice items whose invoice stands posted. The four scopes follow from those two quantities. A marked item shows its flag and quantities under **All items** only, never as outstanding work. The requisition linkage names the requisition and item converted and that requisition's requested quantity; a line converting nothing carries no quantity rather than a zero that would read as demand. Every supplied range endpoint is judged against its master and refuses by name, with one deliberate exception recorded in the contract: a document-number **range** is a scan, so only a single number (from equal to) must stand.

**Stage 4 — the screen.** `/purchasing/purchase-order-list`: perspective and scope selectors, the full range set (vendor, organisation, group, plant, material, material group, order, document dates) and maximum hits; a 25-column grid carrying every field the package names plus the derived quantities, open delivery and open invoice, and the requisition link; truncation in `role="status"`, refusal in `role="alert"`, and each row drilling to `/purchasing/orders?order={number}`. i18n keys `poList.*` (55). Browser target **`purchase-order-list`** on fixture key **T874**.

**Stage 5 — acceptance. T874 PASSED, 5 legs:** with three orders carrying posted history, the list derives `COMPLETED`, `PARTIALLY_DELIVERED` and `DELIVERED` (delivered, not yet invoiced) on screen and shows the vendor name; *still to be delivered* narrows to the outstanding commitment alone; the by-order perspective re-sorts the grid by document number; an unknown vendor refuses by name in the alert rather than answering an empty list; a row drills down to the purchase order display. One environment incident is recorded rather than hidden: the first run failed on a missing client chunk because a **stale server from the previous round was still listening on port 3000** while the rebuilt `.next` stood on disk — the runner's onboarding page consequently 404'd a chunk. The old process was killed and the acceptance re-ran clean; the lesson is that killing the previous `next-server` must be verified by port before a rebuilt server is started.

**Gates.** Service **8/8**; UI contract **8/8**; target guard **161/161**; **full suite 1643/1643 across 234 files**; production build clean; **T874 PASSED**. Catalogue **156 capabilities / 129 terms / 151 aliases** (seed re-run, counts read from the database) — the four real transaction codes ME2L, ME2M, ME2N and ME2C all stand as aliases on the one capability. Migrations stand at **187**: the recommended header index was measured in stage 2 and declined, so no schema change landed — the second consecutive measured decline, with both harnesses retained.

**Deferred by name, unchanged:** the *Scope of List* presentation variants (ALV grid against standard list — the single grid ships), the purchase-order history line-item drill beyond the document display, release-strategy detail, and exporting.

Same-stage bookkeeping: B-833 / §26.845 / §30 row 2.663. The procurement roadmap continues with the next package the owner supplies.

## §26.846 — SCR-125 contract: material document list (MB51)

**B-834.** Owner package (2026-10-20): inventory continues with **MB51 — the material document list**. The frozen roadmap carries it as `INV.MATERIALDOC.LIST`, "material document list by movement, date, plant", alias MB51. Canon judged first: `material_document` carries the document number, year, document and posting dates, header text, status (`POSTED`/`REVERSED`), the reversal links, the journal document it posted and its creator; `material_document_line` carries the line number, movement type, material, plant, storage location, stock type, entry and base quantity with units, unit price with price unit, currency, value, the purchase-order number and item it cites, and item text. Storage locations and movement types stand as masters. The transaction is read-only — no state, no table — and its drill-down target already exists as a read: `getMaterialDocument()`.

- **Selection.** Ranges for material, plant, storage location, movement type and purchase order, a **required posting-date range**, an optional document-date range, a stock type and a user name; maximum hits with the standing truncation marker. **The posting-date range is required** as the package states: a list over an unbounded ledger is a scan of history, not a question, so the list refuses by name when no posting-date bound stands.
- **Movement type is the canon's key, not SAP's number.** Cairn's movement types are semantic (`GOODS_RECEIPT_PO`, `RECEIPT_REVERSAL`, with a direction and reference category), and the standing rule holds SAP keywords to search aliases — so the filter judges the standing movement type and refuses by name; the package's 101 / 201 / 311 are search aids only, never values in the database. The F4 offers the standing types with their direction.
- **Special stock.** The package's indicator (Q for project stock, E for sales-order stock) has no counterpart in this canon: those special stocks do not stand, and none is invented. What stands is the **stock type** the ledger records (`UNRESTRICTED` today) — the filter takes it, validated against the stock types standing in the tenant's stock and ledger; project and sales-order special stock are **deferred by name** until a round carries them.
- **Traceability.** Each row names the purchase order and item it cites, so a goods receipt is auditable against the order it received (the delivered quantity SCR-124 derives is exactly the sum of these lines), and the journal document the material document posted.
- **History is never hidden.** A document that stands `REVERSED` is listed with that status, and its reversal stands as its own document with a `REVERSAL` direction — reversals appear, they do not cancel the evidence. Closed posting periods never suppress history, the standing principle of every display round.
- **Rows.** Material document and year, item, movement type and direction, material and description, entry quantity and unit, base quantity and unit, unit price with price unit, value and currency, plant, storage location, stock type, posting date, document date, header text, document status, the purchase order and item cited, item text, creator, and the journal document.
- **Drill-down.** Each row links to the material document display `/inventory/material-documents?document={number}` — the MB03 equivalent, a read-only screen built in this round on the same capability (a report and its drill share it; no second capability is invented).
- **Authorization and isolation.** The capability gates both screens; tenant scope comes from the session and row-level security enforces it. Plant, storage-location and vendor-master authorisations map to that capability gate, as in SCR-124.
- **Performance.** Stage 2 measures the real list query at ledger volume — the package recommends a composite index spanning plant, material and posting date — and either takes **migration 9065** (still unused) or records a verification-only decision, published before the service lands.

**Deferred by name:** the *Scope of List* presentation variants (ALV grid against standard list — the single grid ships, as in SCR-112, SCR-113, SCR-123 and SCR-124), project and sales-order special stock (the Q/E indicators — the canon carries none), batch and serial-number selection (not carried), and exporting. Capability **`INV.MATERIALDOC.LIST`**, alias **MB51**. Stage order: 1 contract, 2 index decision, 3 service + tests, 4 screen and the document display, 5 browser acceptance + closure; each separately committed and pushed. Same-stage bookkeeping: B-834 / §26.846 / §30 row 2.664.

## §26.847 — SCR-125 stage 2: the date index is taken (migration 9065)

**B-835.** The first measured **yes** in three rounds. The package recommends one composite over plant, material and posting date; that index cannot exist in this canon as written — plant and material stand on `material_document_line`, the posting date on `material_document` — so the measurement tested what the schema can actually carry: a header date index, alone and with a line index beside it.

**Method.** `scripts/plan-mb51.mts` seeds a throwaway tenant with 20,000 material documents × 3 lines (**60,000 ledger lines**) over 10 plants, 50 materials and 4 storage locations, gathers statistics, and times the list query — lines joined to headers and movement types, the required posting-date range, ordered newest first, `limit 501`.

| selection | no index | header date index | + line plant/material index |
| --- | --- | --- | --- |
| one material, one month | 5.37 ms | 3.30 ms | 3.61 ms |
| plants Q100–Q104, 3 months | 36.05 ms | **4.34 ms** | 4.19 ms |
| all materials, all plants, 12 months | 71.74 ms | **3.02 ms** | — |

**Decision — migration 9065, one index.** `md_posting_date_idx on material_document (client, posting_date)`. The win is structural, not marginal: the plan flips from a sequential scan of the whole line table to a backward walk of the date index stopping at the hit limit, so the broad selection falls from 71.7 ms to 3.0 ms and the plant selection from 36.1 ms to 4.3 ms. It is the required posting-date range that makes this safe and strong — without a date bound there is no index path at all, which is the same reason the contract requires the range. The second index earns nothing (3.61 ms against 3.30 ms; the planner declines it) and `material_document_line_material_idx` already serves the material predicate, so **no line index is added**. Migrations go from 187 to **188**; 9065 is the first migration this canon has taken since SCR-122.

**For the service.** Stage 3 issues the query as measured — header joined to line, newest first, `limit maxHits + 1` — and the required posting-date range is what keeps it on the index.

Same-stage bookkeeping: B-835 / §26.847 / §30 row 2.665. Next stage 3: the `INV.MATERIALDOC.LIST` service and tests.

## §26.848 — SCR-125 stages 3–5 and CLOSURE: the ledger list, the document display and MB51 acceptance

**B-836.** MB51 is delivered and closed.

**Stage 3 — the service (`INV.MATERIALDOC.LIST`).** `src/modules/inventory/material-document-list.ts` reads the ledger for a **required** posting-date window, joining each line to its header, its movement type (for the direction) and the material master (for the description). The contract's decisions hold as written: the posting-date range refuses by name when absent or inverted; movement types are judged as the canon's own keys and SAP's 101/201/311 stay search aids; every supplied endpoint is judged against its master; a purchase-order **range** scans while a single number must stand; a stock type is judged against the types standing in the stock and the ledger, and its refusal says plainly that project and sales-order special stocks are not carried; a user is judged against `app_user` or against a standing document creator. Reversed documents are listed with their status, their reversals stand as documents of their own, and a warning says so rather than leaving the reader to wonder.

**Stage 4 — the screens.** `/inventory/material-document-list` carries the whole selection (material, plant, storage location, movement type, posting dates — required on the form — document dates, stock type, purchase order, user, maximum hits) and a 23-column grid; the journal document links into the finance journal. The drill-down is a **new read-only display** at `/inventory/material-documents?document={number}` — the MB03 equivalent — built on the existing `getMaterialDocument()` read and gated by the same capability, because a report and its drill are one capability. i18n keys `mdList.*` (55) and `mdDoc.*` (16). Browser target **`material-document-list`** on fixture key **T875**.

**Stage 5 — acceptance. T875 PASSED, 5 legs:** the April window lists every line with the material description, the movement direction and the order cited, and a reversed document stands visible with its status; the list refuses to run without a posting-date window; the canon movement type narrows the ledger to the reversal alone; an unknown plant refuses by name; the drill opens the read-only document display with its lines.

**Three defects were caught and fixed inside the round, recorded rather than smoothed over.** (1) The stage-2 index-contract test asserted that the line material index appears in the Drizzle mirror; it does not — it shipped with the ledger in migration 0073 — so the test was corrected to read the shipped migration, in a separate follow-up commit. (2) `tsc` caught a duplicated `mdList.stockType` i18n key before the screen was committed. (3) The acceptance leg itself caught a real gap: the document display omitted the line text and stock type the ledger records, so `MaterialDocumentView` was extended and the display re-rendered rather than the assertion weakened — a test that bends to the code is worth nothing. A fourth, environmental: `pkill -f "next-server"` matches the invoking shell's own command line and kills it; the pattern must exclude itself (`next[-]server`), and the port is verified free before a rebuilt server starts (the lesson recorded at SCR-124).

**Gates.** Service **7/7**; UI contract **8/8**; index contract **2/2**; target guard **162/162**; **full suite 1661/1661 across 237 files**; production build clean with both routes at 222 B; **T875 PASSED**. Catalogue **157 capabilities / 130 terms / 152 aliases**. **Migrations 188** — migration 9065 is the first this canon has taken since SCR-122, and it was taken on measured evidence.

**Deferred by name, unchanged:** the *Scope of List* presentation variants (single grid ships), project and sales-order special stock (the Q/E indicators — no counterpart stands), batch and serial-number selection, and exporting.

Same-stage bookkeeping: B-836 / §26.848 / §30 row 2.666. The inventory roadmap continues with the next package the owner supplies.

## §26.849 — SCR-126 contract: stocks on posting date (MB5B)

**B-837.** Owner package (2026-10-20): inventory continues with **MB5B — stocks on posting date**, a rollforward of opening, receipts, issues and closing stock across a date window. **This capability is not on the frozen roadmap.** The roadmap carries `INV.STOCK.VIEW` (MMBE, the current stock overview) and defers `INV.RPT.STOCKVALUE` and `INV.RPT.MOVEMENTS` to a later phase; none of them is a date-window rollforward. MB5B therefore lands as a **new capability, `INV.STOCK.POSTINGDATE`, with alias MB5B**, and it does **not** satisfy `INV.STOCK.VIEW` — a position as of a past date is not a current overview — so MMBE stays on the roadmap untouched.

- **Selection.** **Material range and plant range are required**, as the package states; a **start and end reporting date are required**; storage location range, stock type (defaulting to `UNRESTRICTED`) and *display zero stock lines* (default off) stand optional. Maximum hits with the standing truncation marker. Every supplied endpoint is judged against its master and refuses by name; the end date may not precede the start date.
- **The rollforward is read from the immutable ledger, not by unwinding the snapshot.** The package describes starting from the current stock snapshot and stripping out later movements, which is how SAP must work when history is not queryable. This canon keeps every movement, so the exact figures come straight from it: **opening** is the signed sum of movements posted before the start date, **receipts** the positive movements inside the window, **issues** the negative ones, **closing** their sum. Deriving opening by subtracting from a snapshot would compound any drift between the snapshot and the ledger into the past. That deviation from the package's method is deliberate and is recorded here.
- **The snapshot is a control, not a source.** Where the window's end reaches or passes the latest posting date in the tenant, the closing quantity is compared with `stock_quantity` and any difference stands as a **warning naming the material, plant, storage location and both figures** — never silently reconciled, never used to adjust the report.
- **Reversed documents contribute nothing**, exactly as in MB51: a document that does not stand `POSTED` is out of the sum, while a reversal is its own movement carrying the opposite direction. Signed values follow the same rule, so a receipt adds value and its reversal takes it back.
- **Rows.** Material and description, plant, storage location, stock type, base unit, opening quantity and value, receipts quantity and value, issues quantity and value, closing quantity and value. Zero-stock lines are suppressed by default and appear on request.
- **Drill-down.** Each row links to the MB51 list already delivered, filtered to that material, plant and the same posting window — the package's "audit the movements behind the delta" is the previous round, reused.
- **Batch and valuation type are deferred by name**: the canon carries no batch master and no valuation type on the ledger line, and none is invented.
- **Authorization and isolation.** The capability gates the screen; tenant scope comes from the session and row-level security enforces it; plant and storage-location authorisations map to that gate, as in SCR-124 and SCR-125.
- **Performance.** Stage 2 measures the rollforward at ledger volume — the package recommends a line index on plant and material — and either takes **migration 9066** or records a verification-only decision, published before the service lands.

**Deferred by name:** batch and valuation type, the *Scope of List* presentation variants (single grid ships, as in every display round since SCR-112), stock ageing (`INV.STOCKAGE.ANALYSE` is its own item) and exporting. Capability **`INV.STOCK.POSTINGDATE`**, alias **MB5B**. Stage order: 1 contract, 2 index decision, 3 service + tests, 4 screen, 5 browser acceptance + closure; each separately committed and pushed. Same-stage bookkeeping: B-837 / §26.849 / §30 row 2.667.

## §26.850 — SCR-126 stage 2: index decision is verification-only (migration 9066 not taken)

**B-838.** The package recommends a composite index on the ledger line — tenant, plant, material. Measured on top of the posting-date index taken at SCR-125, and it does not earn a migration.

**Method.** `scripts/plan-mb5b.mts` seeds a throwaway tenant with **40,000 ledger lines** over 10 plants, 50 materials, 4 storage locations and a full year, gathers statistics, and times the rollforward the service will issue: one pass over the ledger up to the end date folded in a single aggregate into opening (posted before the start), receipts and issues (inside the window) and the corresponding values, grouped by material, plant, storage location and stock type.

| selection | standing indexes | plus `(client, plant, material_number)` | plan |
| --- | --- | --- | --- |
| one material, one plant, 1 month | 1.59 ms | 1.67 ms | `material_document_line_material_idx`, hash join to the header |
| 5 materials, plants Q100–Q104, 3 months | 12.02 ms | 10.90 ms | same index, nested-loop onto the header key |
| all materials, all plants, 12 months | 118.4 ms | 111.9 ms | same index throughout |

**Decision — verification-only, no migration 9066.** The planner never chooses the candidate: it already walks `material_document_line_material_idx` for the material predicate and the header primary key for the date, and adding plant to the index buys 1 ms on the medium arm and 6 ms on the broad one — inside the run-to-run noise of a 118 ms query, and paid for by write amplification on every goods movement. Two facts make this safe rather than merely convenient: **the material and plant ranges are required**, so the normal shapes are the two cheap ones (2 ms and 12 ms), and the posting-date index from SCR-125 already bounds the scan to the window. **Migrations stand at 188**; 9066 stays unused.

**For the service.** Stage 3 issues the rollforward as measured — one aggregate over the ledger up to the end date, `limit maxHits + 1` on the grouped rows — and adds no schema.

Same-stage bookkeeping: B-838 / §26.850 / §30 row 2.668. Next stage 3: the `INV.STOCK.POSTINGDATE` service and tests.

## §26.851 — SCR-126 closed: MB5B stocks on posting date delivered

**B-839.** MB5B is delivered as the new capability `INV.STOCK.POSTINGDATE` at `/inventory/stock-on-posting-date`, with the rollforward read from the immutable ledger and the stock master standing only as a control.

**What stands.** The screen takes a required material range, a required plant range, an optional storage location range, a required reporting window, a stock type defaulting to unrestricted, a display-zero-stock-lines flag defaulting to off, and a bounded hit count. The grid carries material, description, plant, storage location, stock type, base unit, and opening, receipts, issues and closing in both quantity and value, with each row drilling into the MB51 list filtered to that row and the same window. Refusal by name covers an unknown material, plant or storage location, an unknown stock type, an inverted range, an impossible date and a non-positive hit count. Tenant scope comes from the session; the capability gate is the only authorization layer.

**Method recorded.** Opening is the signed sum of everything posted before the window, receipts the positive movements inside it, issues the negative ones, and closing their sum — never a snapshot unwound backwards, which would compound drift into the past. Reversed documents contribute nothing, and a reversal stands as its own movement with the opposite sign. In this canon stock leaves through a movement whose direction is `REVERSAL`; there is no separate `ISSUE` direction, so the issue column is exactly the negative movements of the window and the fixture documents goods issues that way — recorded so nobody later reads the column as a missing direction.

**The stock master as a control.** When the window reaches the latest posting date in the tenant, the closing quantity is compared with `stock_quantity` and any difference stands as a warning naming the material, plant, storage location and both figures. Nothing is reconciled and nothing is adjusted: the ledger figure stands as computed. The suite pins this on a drifted material whose closing 4.000 is warned against 1.000 on hand and still shown as 4.000.

**Index decision.** Stage 2 measured the package's recommended line index at 40,000 ledger lines and declined it (B-838, §26.850): the planner walks the existing material index in every shape, and the candidate bought 1 ms on the medium arm and 6 ms on a 118 ms broad one. **No migration was taken; migrations stand at 188.**

**Deferred by name.** Batch and valuation type (neither stands on the ledger line), Scope-of-List variants, stock ageing, and exporting.

**Acceptance.** Service 8/8; UI contract 9/9; target guard held at 162 targets; **suite 1679/1679 across 239 files**; build clean; **T826 PASSED 7 legs** — April rolls opening 10 forward through receipts 5 and issues 2 to closing 13 while a reversed receipt of 99 contributes nothing; the netted-to-zero line stays hidden until asked for; a missing material range and an unknown plant each refuse by name; a closing position that disagrees with the stock master is warned about with both figures and never adjusted; and the row drills into the ledger list for the same material and window. Catalogue **158 capabilities / 131 terms / 153 aliases**.

**Commits.** `89fc9e2` contract · `5bcdbdf` stage 2 · `362ca62` stage 3 · `e0653a0` stage 4 · closure commit.

Same-stage bookkeeping: B-839 / §26.851 / §30 row 2.669. **Next: MB52 first**, then MMBE (still Roadmap) or ME2K.

## §26.852 — SCR-127 contract: MB52 List of Warehouse Stocks on Hand, settled before implementation

**B-840.** MB52 arrives as a new capability, `INV.STOCK.WAREHOUSE`, at `/inventory/warehouse-stocks`. It reads the stock master — not the ledger — and is the first screen in this module whose whole job is the current snapshot with its valuation attached.

**Why it is a new capability.** MB52 answers a different question from MMBE's planned overview and from MB5B's rollforward: it is the snapshot by storage location with the unrestricted / quality-inspection / blocked split and the valuation behind it. It does **not** satisfy `INV.STOCK.VIEW` (MMBE stays Roadmap), and it does not displace MB5B, which remains the only way back in time. The frozen roadmap is untouched.

**Breakdown categories are stock types.** This canon carries the category on the stock record, not in three quantity columns: `stock_quantity` is keyed by client, material, plant, storage location **and stock type**, and the ledger writes whatever stock type a movement carries. MB52 therefore pivots the snapshot: `UNRESTRICTED`, `QUALITY_INSPECTION` and `BLOCKED` take the three named columns and every other stock type in the selection is aggregated into a fourth, **Special / other stock**, column. That column is a deliberate extension beyond the package's grid: without it a total would be silently short whenever a tenant carries, say, project stock. **Total quantity covers every stock type shown**, and the four columns add to the total — pinned by test.

**Valuation.** `material_valuation` stands at plant (`valuation_area` = plant in this canon) and carries `price_control` ∈ {STANDARD, MOVING_AVERAGE}, both prices, `price_unit` and the valuation currency. The price displayed is the one the control selects; the value of a line is quantity × price ÷ price unit. **A material with no valuation record shows an unknown value, never zero** — zero would assert worthlessness — and the report warns by name listing those materials. A valuation currency that differs from the client's local currency is reported as carried, with the currency on the line, and the run warns that no translation was applied (this canon translates nothing at report time).

**Selection.** Scope of List is **required**, and the two formats that stand both carry every column: `ALV` (default) adds grouping headers and a totals footer; `STANDARD` is the flat list. Any other value refuses by name. Material, plant and storage-location ranges are **optional** exactly as the package states — unlike MB5B, which demands them. Zero-stock lines are suppressed by default. Valuation Price Display defaults **on**; switched off it drops the price and value columns and the footer totals them not. **Valuation Type / Batch is deferred by name** (no batch master and no valuation type on the stock record). **Special Stock Indicator is refused by name**: Cairn records special stock as a named stock type in the ledger, not as SAP's one-character indicator, and the remedy names the stock type filter that replaces it.

**Drill-down.** Each row carries two links: **Movements** to the MB51 list and **Rollforward** to MB5B, both filtered to the row's material, plant and storage location, over the client's whole recorded ledger window (earliest to latest posting date). A row whose material has never moved carries no drill, and the screen says so rather than offering a dead link.

**Read-only, absolutely.** MB52 issues no insert, update or delete; it posts nothing and touches no period control. OMSY/MARV/OB52 remain read-only neighbours: the snapshot it reads is moved only by posted documents, so the report can never disagree with the ledger through its own action.

**Performance.** The stock master's primary key leads with material, so a plant-first selection is not served by it. Whether the package's composite index earns a migration is settled by measurement at stage 2, not by assumption — SCR-126's was declined on the evidence, and this one may well be taken.

**Tests planned.** Service: the four-way split and the total; valuation under both price controls and per price unit; unknown valuation warned, not zeroed; zero suppression; refusal by name for scope, special stock, batch/valuation type and unknown keys; truncation. UI contract: capability gate, session tenant, required scope, every grid column, both drill links. Browser: T-numbered fixture rolling unrestricted, quality and blocked stock into one material, checking the split, the value, the unknown-valuation warning and both drills.

Same-stage bookkeeping: B-840 / §26.852 / §30 row 2.670. Stage 2 next: the index decision, measured.

## §26.853 — SCR-127 stage 2: MB52 index decision is verification-only (migration 9067 not taken)

**B-841.** The package recommends a composite index on the stock master — tenant, plant, storage location, material. Measured at enterprise size, it earns nothing, and this canon keeps its 188 migrations unchanged for the second round running.

**Method.** `scripts/plan-mb52.mts` seeds a throwaway tenant with **200,000 stock rows** (5,000 materials × 10 plants × 4 storage locations, with quality-inspection and blocked stock mixed in) and **50,000 valuation rows**, gathers statistics, and times the exact snapshot the service issues: the stock master joined to the material description and the plant valuation, aggregated by material, plant and storage location and pivoted on stock type, at three shapes — one material in one plant, a four-plant range, and no material or plant restriction at all (the package makes both ranges optional, so the broad shape is the production risk).

| selection | standing indexes | plus `(client, plant, storage_location, material_number)` |
| --- | --- | --- |
| one material, one plant | 1.09 ms | 0.79 ms |
| plants Q200–Q203 | 15.45 ms | 13.05 ms |
| no material, no plant range | 11.36 ms | 10.71 ms |

**Decision — verification-only, no migration 9067.** The planner never chooses the candidate in any arm. It reaches the stock master through `stock_quantity_pkey`, which already leads with the material and so serves the material-first shapes, and it seq-scans the plant-first and unrestricted shapes — correctly, because four plants of ten is forty per cent of the table and walking an index across forty per cent loses to reading the heap. A follow-up run forcing the bitmap path confirmed it: both arms remained sequential at 72 ms, and the candidate was not selected even with plain index scans disabled. The headline numbers are inside noise (the largest gain is 2.4 ms on a 15 ms query), and the index would be paid for on every stock movement this system writes. **Migrations stand at 188; 9067 stays unused.**

**For the service.** Stage 3 issues the snapshot as measured — the pivot aggregate grouped by material, plant and storage location, ordered by material, bounded by `maxHits + 1` — and adds no schema. The broad shape is safe at this size because the hit bound, not the index, is what limits the answer.

Same-stage bookkeeping: B-841 / §26.853 / §30 row 2.671. Stage 3 next: the `INV.STOCK.WAREHOUSE` service and its tests.

## §26.854 — SCR-127 closed: MB52 warehouse stocks on hand delivered

**B-842.** MB52 is delivered as `INV.STOCK.WAREHOUSE` at `/inventory/warehouse-stocks`: the current snapshot, pivoted on stock type, valued at the plant price, and honest about what it cannot value.

**What stands.** A required scope of list (ALV grid default, standard list; anything else refused by name); optional material, plant and storage-location ranges exactly as the package states; zero-stock lines suppressed unless asked for; the valuation price display defaulting on and switchable off, which drops the price and value columns rather than zeroing them. The grid carries material, description, plant, storage location, base unit, the four quantity columns and their total, the price, the currency and the inventory value, with a totals footer. Each row drills both ways: **Movements** into MB51 and **Rollforward** into MB5B, over the client's whole recorded ledger window.

**The pivot.** `stock_quantity` is keyed by stock type, so the three named categories are stock types `UNRESTRICTED`, `QUALITY` and `BLOCKED` — the column is `varchar(16)`, which is why `QUALITY_INSPECTION` is not the stored value and the test that failed on it was right to fail — and **every other stock type lands in a fourth special/other column** so the total is never short. A project-stock fixture proves it: 7 unrestricted + 3 project = 10, not 7. All four columns add to the total on every row, and the suite pins that universally.

**Valuation honesty.** The price comes from `material_valuation` at the plant, chosen by the material's price control and divided by its price unit (standard 12.50 × 27 = 337.50; moving average 200 per 10 × 10 = 200). **A material with no valuation record shows unknown, not zero**, and is named in a warning; the footer total covers valued lines only. A valuation in a currency other than the client's is carried as is and warned about, with no translation applied at report time.

**Refusals.** Unknown material, plant, storage location or stock type by name; inverted ranges; a non-positive hit count. **Batch and valuation type are deferred by name**, and **SAP's one-character special stock indicator is refused**, with the remedy naming the stock type filter that replaces it.

**Index decision.** Measured at 200,000 stock rows and declined (B-841, §26.853): the planner walks `stock_quantity_pkey` for material-first shapes and seq-scans plant-first ones, which is correct at forty per cent selectivity. **No migration; 188 stand.**

**Acceptance.** Service 11/11; UI contract 10/10; **suite 1701/1701 across 241 files**; build clean; **T827 PASSED 8 legs** — the split 20/5/2 adds to 27 at 12.5000 and 337.50; project stock lands in the special column so 7+3 reads 10 and the moving average honours its unit of 10; an unvalued material reads "unknown" and is warned about by name; the zero line stays hidden until asked; switching the valuation display off removes the price and value columns; an unknown scope of list and the special stock indicator each refuse by name; and the row drills into MB51 for the same material. Catalogue **159 capabilities / 132 terms / 154 aliases**; migrations **188**.

**Commits.** `3a8b2ee` contract · `1445f34` stage 2 · `586c564` stage 3 · `efceac0` stage 4 · closure commit.

Same-stage bookkeeping: B-842 / §26.854 / §30 row 2.672. **Next: MMBE first**, then MB51-free alternatives — MB51 and MB5B are delivered, so the next order is **MMBE** (`INV.STOCK.VIEW`, still Roadmap) then **ME2K**.

## §26.855 — SCR-128 contract: MMBE Stock Overview, the roadmap capability finally satisfied

**B-843.** MMBE arrives as **`INV.STOCK.VIEW`** at `/inventory/stock-overview` — the one capability that has stood on the frozen roadmap since the beginning (`CAIRN.md` §10 line 898), and which MB5B and MB52 each deliberately left untouched. This round flips it to Implemented at closure. No new capability code is coined.

**Shape: a tree, not a grid.** Three levels, each rolling up to its parent:
- **Level 1 — plant**: the material's total in that plant across every stock type shown.
- **Level 2 — storage location**: the breakdown per location.
- **Level 3 — stock type**: the special-stock half of the package's "batch / special stock node". **Batch is deferred by name** — this canon carries no batch master — so the third level names the stock type (`UNRESTRICTED`, `QUALITY`, `BLOCKED`, and every other type present, such as `PROJECT`).

**What rolls up.** Every parent total is computed from its children as they are shown, and the material total from its plants — never from a second query, so a parent can never disagree with its own children. The suite pins that the leaf quantities sum to the location, the location quantities to the plant, and the plants to the material total, including after zero-suppression.

**Quantitative, deliberately.** MMBE is opened to see *where* stock stands, not what it is worth, so the tree carries quantities and no valuation. Value stays in MB52 where it belongs, and the drill from every node reaches it in one click.

**Selection.** Material is **required and single**, exactly as the package states — the overview is of one material, and a range would be MB52's job. Plant range, storage-location range and zero-stock display are optional. The expansion level dropdown takes `PLANT` (plants only) or `STORAGE_LOCATION` (default: plants and locations open); anything else refuses by name.

**Refusals and deferrals.** The one-character **special stock indicator is refused by name** on the SCR-127 ruling — Cairn carries special stock as a named stock type — with the remedy naming the third-level nodes. **Batch deferred by name.** **In-transit is deferred by name**: no movement type in this canon produces transit stock, so a Level-1 "in transit" column would be a permanent zero pretending to be a measure; the contract says so rather than drawing it.

**Drills.** Every plant and storage-location node carries the same three drills MB52 established: **Movements** (MB51), **Rollforward** (MB5B) and **Warehouse snapshot** (MB52), filtered to that node's material, plant and storage location over the client's whole recorded ledger window. A node with no posted movement behind it carries no drill.

**Read-only.** No insert, update or delete. The tree reads the stock master and the material description and nothing else.

**Index.** The package recommends (tenant, material, plant, storage location). Note before measuring that this is a strict **prefix of `stock_quantity_pkey`** (client, material, plant, storage location, stock type), so it may be redundant by construction — but it is measured, not assumed, at stage 2, as the last two rounds were.

**Tests planned.** Service: the three-level roll-up arithmetic in both directions; zero suppression at every level; refusal by name for a missing/unknown material, unknown plant/location, the special stock indicator, batch and an unknown expansion level; drills present at the right nodes; read-only. UI contract: capability gate on `INV.STOCK.VIEW`, session tenant, required material, expansion dropdown, tree rendering. Browser: T-numbered fixture with two plants, three locations and a project stock type, checking the roll-ups, the zero toggle, the expansions and the drills.

Same-stage bookkeeping: B-843 / §26.855 / §30 row 2.673. Stage 2 next: the index decision, measured.

## §26.856 — SCR-128 stage 2: MMBE index decision is verification-only (migration 9068 not taken)

**B-844.** The package recommends (client, material, plant, storage_location). That column list is a **strict prefix of `stock_quantity_pkey`** (client, material, plant, storage_location, stock_type), so it can never filter better than the key it duplicates — and the measurement says exactly that.

**Method.** `scripts/plan-mmbe.mts` seeds 6,000 stock rows (40 materials × 10 plants × 5 locations × 3 stock types) with statistics gathered, then times the tree query MMBE will issue — one material, grouped by plant, location and stock type, ordered for the three-level roll-up — at one plant and across all ten.

| selection | standing indexes | plus `(client, material, plant, storage_location)` |
| --- | --- | --- |
| one material, one plant | 0.052 ms | 0.133 ms |
| one material, all plants | 0.042 ms | 0.052 ms |

**Decision — verification-only, no migration 9068.** Where the planner took the candidate it was **slower** than the primary key, as a wider key with the same prefix must be: same rows, more bytes to walk. The primary key already answers the only query MMBE issues, because **the material is required** — there is no plant-first shape in this transaction, which is exactly what made MB52's measurement different. **Migrations stand at 188; 9068 stays unused.**

**For the service.** Stage 3 reads the stock master once for the selected material and folds the three levels in TypeScript, so the roll-ups are arithmetic on the same rows the leaves came from rather than a second query that could disagree.

Same-stage bookkeeping: B-844 / §26.856 / §30 row 2.674. Stage 3 next: the `INV.STOCK.VIEW` tree service and its tests.

## §26.857 — SCR-128 closed: MMBE stock overview, the roadmap capability satisfied

**B-845.** `INV.STOCK.VIEW` — the capability that has stood on the frozen roadmap since it was written — is now Implemented at `/inventory/stock-overview`. This is the first round that **satisfies** a roadmap capability rather than adding one beside it, and the roadmap row flips accordingly.

**What stands.** One **required material** (single, never a range — a range is MB52's job), optional plant and storage-location ranges, zero-stock display, and an expansion level of `PLANT` or `STORAGE_LOCATION` (default), anything else refused by name. The tree is three levels: **plant → storage location → stock type**, with every parent total **folded from the children it displays** — one read of the stock master, then arithmetic on those same leaves, so a parent can never disagree with its own children. The suite asserts the identity universally, at both display-zero settings: type sums to location, location sums to plant, plants sum to the material total.

**The split, and what the third level is.** `UNRESTRICTED` and `QUALITY` and `BLOCKED` are flagged on their nodes, and every other named stock type — `PROJECT` in the fixture — forms its own leaf, so special stock is visible rather than folded into a total. Batch would have been the third level in SAP; there is **no batch master in this canon**, so batch is deferred by name and the level carries stock types instead.

**Refusals.** The one-character **special stock indicator** refused on the SCR-127 ruling, with the remedy pointing at the named stock types the tree shows; unknown material, plant and location refused by name; inverted ranges; non-positive hit count. **In-transit is deferred by name** — no movement type in this canon produces transit stock, and a permanent zero would be a column pretending to be a measure.

**Quantitative on purpose.** The tree carries quantities and no valuation: MMBE answers *where* stock stands, MB52 answers what it is worth. Each node therefore carries **three drills** — Movements (MB51), Rollforward (MB5B) and Warehouse stock (MB52) — filtered to that node over the client's whole recorded ledger window.

**Index decision.** Measured and declined (B-844, §26.856): the recommended column list is a **strict prefix of `stock_quantity_pkey`**, and where the planner chose it the query ran slower (0.133 ms against 0.052 ms). Because the material is required there is no plant-first shape to serve. **No migration; 188 stand.**

**Acceptance.** Service 10/10; UI contract 10/10; **suite 1722/1722 across 243 files**; build clean; **T828 PASSED 7 legs** — 30 unrestricted + 5 quality folds to 35 and the plant to 42, 4 blocked + 3 project to 7 in its own location with `PROJECT` named at the third level, and the material to 49; the expansion dropdown decides whether plants open on arrival; a zero location stays hidden until asked; a missing material and the special stock indicator each refuse by name; and the plant node drills into the material document list. Catalogue **159 capabilities / 133 terms / 155 aliases**; migrations **188**.

**Commits.** `4320160` contract · `dee78f8` stage 2 · `0697543` stage 3 · `3e0e796` stage 4 · closure commit.

Same-stage bookkeeping: B-845 / §26.857 / §30 row 2.675. **Next: ME2K first**, then **MD04** (`PROD.MRP.STOCKREQ`, still Roadmap on the frozen plan).

## §26.858 — SCR-129 contract: ME2K purchase orders by account assignment, settled before implementation

**B-846.** ME2K arrives as a new capability, **`PROC.PO.ACCOUNTASSIGN`**, at `/purchasing/orders-by-account-assignment`. It is not on the frozen roadmap (ME2L, ME2M, ME2N and ME2C share `PROC.PO.LIST`, delivered at SCR-124), and it satisfies nothing on it. It is the account-assignment perspective over the same order items ME2L already values.

**What the canon carries, and what that settles.** `purchase_order_assignment` is a **multi-line** table: one order item can be distributed across several cost centres by percentage, each line naming its own G/L account. `purchase_order_item.account_assignment_category` carries a check constraint admitting **only `COST_CENTER`** — SAP `K`. Therefore:
- **Cost centre is the assigned object**, and the package object range is a cost-centre range over the assignment lines.
- **Account assignment categories `A` (asset), `P` (WBS) and `F` (internal order) are refused by name**, not silently ignored: the canon item constraint cannot carry them, and a filter that quietly answered everything would be a lie. `K` and `COST_CENTER` are both accepted.
- The package `ekkn` is `purchase_order_assignment` here, and SAP `ZEKKN` (assignment line) is its `line_number`.

**Scope of selection is required**, exactly as the package states, and reuses the SCR-124 derivation rather than reinventing it: delivered quantity from posted material-document lines net of reversals, invoiced quantity from posted supplier-invoice items, and `ALL` / `STILL_TO_BE_DELIVERED` / `STILL_TO_BE_INVOICED` / `COMPLETED` over those. A marked-for-deletion item never stands in a still-to-be or completed scope.

**Scope of list is required** (ALV grid default, standard list); any other value refuses by name.

**Commitment arithmetic, stated once.** An order item net value is distributed across its assignment lines by `distribution_percentage`; the **assigned value of an assignment line is the item net value times its percentage**, rounded to the cent at the line. The report groups by **assigned object** (cost centre), and each group commitment total is the sum of its lines — so the cost-centre view answers the controlling question the package names. The suite pins the roll-up to the cent at every group.

**Grid.** Order number and item, assignment line, category, cost centre, G/L account, material and description, plant, order quantity, unit, net value, distribution percentage, assigned value, delivery date (earliest schedule line), release status, vendor.

**Drills.** Each row names the **order** (the read-only purchase order display ME2L established at `/purchasing/orders?order=…`) and its **cost centre** (`/controlling/cost-center-report?costCenter=…`).

**Read-only.** No insert, update or delete; the report posts nothing and touches no period control.

**Index.** The package recommends (tenant, cost centre, document date) across two tables. Measured at stage 2 as always: the assignment table is small per item, and the question is whether a cost-centre index helps before the header date filter.

**Tests planned.** Service: distribution arithmetic and the cent-exact roll-up; scope of selection over delivered/invoiced; refusal by name for A/P/F categories, unknown cost centre, plant, vendor, scope of list and inverted ranges; multi-line splits; truncation. UI contract: capability gate, session tenant, required scope of list and scope of selection, every grid column, both drills. Browser: T-numbered fixture with a split item across two cost centres, one fully delivered item and one open item, checking grouping, scopes and drills.

Same-stage bookkeeping: B-846 / §26.858 / §30 row 2.676. Stage 2 next: the index decision, measured.

## §26.859 — SCR-129 stage 2: ME2K index decision is verification-only, and the index is refused for harm (migration 9069 not taken)

**B-847.** The package recommends an index on cost centre with the header document date. Measured on the report the service issues, it does not merely fail to help — it makes the broad case **forty-two times slower**.

**Method.** `scripts/plan-me2k.mts` seeds 2,000 purchase orders × 3 items × 2 assignment lines (**12,000 assignment rows**) across 200 cost centres and a year, then times the report: assignment lines joined to their item and header, filtered on a cost-centre range and a document-date range.

| selection | standing indexes | plus `(client, cost_center)` |
| --- | --- | --- |
| one cost centre, 1 month | 13.37 ms | 14.08 ms |
| 40 cost centres, one quarter | 17.33 ms | 18.59 ms |
| all cost centres, full year | **45.62 ms** | **1,934.41 ms** |

**Decision — not taken; the index is refused for harm, not merely for being unhelpful.** In the narrow arms the planner ignored it. In the broad arm it **chose** it, then nested-looped into `purchase_order_pkey` once per surviving row, which costs two thousand times more than walking the header by date and joining the assignment lines to it. An index that is neutral when narrow and catastrophic when broad is a liability on a report whose required fields are dates and whose optional fields are ranges. **Migrations stand at 188; 9069 stays unused.**

**For the service.** Stage 3 drives from the **header date** — the one predicate the package makes meaningful — and joins items and assignment lines to it, which is the plan every standing arm already chose.

Same-stage bookkeeping: B-847 / §26.859 / §30 row 2.677. Stage 3 next: the `PROC.PO.ACCOUNTASSIGN` service and its tests.

## §26.860 — SCR-129 closed: ME2K purchase orders by account assignment delivered

**B-848.** ME2K is delivered as `PROC.PO.ACCOUNTASSIGN` at `/purchasing/orders-by-account-assignment`: the order book seen from the controlling object, with each assignment line carrying its share of the commitment.

**What stands.** A required scope of list (ALV grid default, standard list) and a required scope of selection (all items, still to be delivered, still to be invoiced, completed), both refused by name when unknown. Ranges on cost centre, purchasing organisation, purchasing group, plant, vendor and document date, all optional. An account-assignment category of `K` or `COST_CENTER` accepted; **`A` (asset), `P` (WBS) and `F` (internal order) refused by name with a remedy**, because the canon item constraint admits only cost-centre assignment. `K` is read as `COST_CENTER` with a warning saying so.

**The arithmetic.** An item net value is distributed across its assignment lines by percentage and each line takes its share rounded to the cent — 100 split 60/40 becomes 60 and 40, and the two always add back to the item. Groups by assigned object sum those lines: CC1000 commits 60, CC2000 commits 90 across two lines, 150 in total, and the footer equals the sum of the groups.

**The scope of selection** reuses the SCR-124 derivation exactly — delivered from posted material-document lines net of reversals, invoiced from posted supplier-invoice items — over the same four scopes, with a marked-for-deletion item never standing in a still-to-be or completed scope. The browser run proves both directions on a real receipt and a real invoice.

**Index decision — refused for harm.** Measured at 12,000 assignment rows (B-847, §26.859): the recommended cost-centre index was ignored in the narrow arms and, in the broad arm, **turned 45.62 ms into 1,934.41 ms** — a forty-two-fold regression from twelve thousand nested header lookups. The service therefore drives from the document date, the one predicate the package makes meaningful. **No migration; 188 stand.**

**Acceptance.** Service 9/9; UI contract 10/10; **suite 1742/1742 across 245 files**; build clean; **T829 PASSED 7 legs** — the split distributes 60/40 and adds back to 100, the groups read 60 and 90 over two lines with 150 in total, the still-to-be-delivered scope carries only the order that is short, the completed scope only the order that is closed out, a WBS category and an unknown scope of list each refuse by name, and the line drills into the order display. Catalogue **160 capabilities / 134 terms / 156 aliases**; migrations **188**.

**Commits.** `3fae680` contract · `dac3526` stage 2 · `7badaf4` stage 3 · `b32777d` stage 4 · closure commit.

Same-stage bookkeeping: B-848 / §26.860 / §30 row 2.678. **Next: MD04 first** (`PROD.MRP.STOCKREQ`, still Roadmap — the next roadmap capability in line), then **MB1B** (`INV.TRANSFER.POST`, Roadmap — stock transfers between storage locations and plants).

## §26.861 — SCR-130 contract: MD04 stock/requirements list, settled before implementation

**B-849.** MD04 arrives as **`PROD.MRP.STOCKREQ`** at `/production/stock-requirements` — the frozen-roadmap capability at `CAIRN.md` §10 line 922, flipped to Implemented at closure. No new capability code is coined.

**No state table. Deviation recorded.** The package defines `mrp_stock_requirement_element` with a stored projected balance. It is **declined**: MD04 is a projection over live documents, and storing the projection would freeze a calculation that must always agree with the stock master, the requisitions and the orders it is made from — the moment a goods receipt posts, a stored pegging list is wrong. The list is computed on every execution and nothing new is written.

**The element universe this canon can honestly supply**, and nothing else:

| element | source | sign |
| --- | --- | --- |
| **Stock** | `stock_quantity`, **MRP-available types only** | receipt, dated today |
| **Purchase requisition** | `purchase_requisition_item` **less what has already been converted to orders** | receipt at its delivery date |
| **Purchase order** | `purchase_order_item` **less delivered** (posted documents net of reversals, the SCR-124 derivation) | receipt at its earliest schedule date |
| **Safety stock** | `material_plant.safety_stock` | requirement at the start of the list |

**Blocked stock is excluded from MRP availability** — SAP parity: planning covers unrestricted-use and quality-inspection stock, never blocked stock, which is held for a reason. Every other stock type is excluded the same way, and a warning names the quantity left out so nobody wonders where it went.

**Deferred by name: planned orders, production orders, sales orders and reservations** — no such tables exist in this canon. **Deferred by name: excess-stock alerts** — the canon carries lot-sizing bounds, not a stock ceiling, and inventing a threshold would manufacture an exception. **Refused by name:** MRP area (`BERID`, no decentralised planning here), the one-character special stock indicator (named stock types, on the SCR-127 ruling), and a simulation version (no planning runs exist to version).

**Running balance.** One chronological list: stock first, then every element by date, each row carrying its receipt or requirement quantity and the **projected stock after it**. Ties on a date put receipts before requirements, so a receipt landing the same day is available to meet it — the planner's own reading of the list.

**Past due.** The package defaults the display on. Switched **off**, past-due elements leave the list but **still move the balance**: the first visible row carries the running position the hidden rows produced. A hidden quantity that silently vanished from the projection would be the worst of both worlds.

**Period split.** `DAILY` (default) lists every element on its date; `WEEKLY` buckets the list into Monday-started weeks with summed receipts and requirements and the week-end balance. Both are implemented; the exceptions are recomputed on whatever rows are shown.

**Exceptions**, recomputed per row and per bucket: **shortage** (projected balance below zero), **safety breach** (below safety stock but not negative), **past due** (dated before today). Each row names its code; the header counts them.

**Horizon.** An optional horizon end truncates the list at that date; an inverted horizon refuses by name.

**Read-only, and the action workbench deferred by name.** The package asks for PR-to-PO conversion from the list. That is a posting action which belongs to the capabilities that own it (`PROC.PO.CREATE`), not to a read-only report, and it is not wired here; the contract says so rather than pretending the button exists.

**Selection.** Material and plant are **both required**, as the package states.

**Index.** Measured at stage 2 — the columns are the leading keys of the tables involved, so the expectation is a decline, but it is measured.

**Tests planned.** Service: the running balance and its tie rule; PR open quantity after conversion; PO open quantity after delivery; blocked stock excluded and warned; safety stock as the opening requirement; past-due hidden but carried; weekly buckets; the three exceptions; refusals. UI contract: capability gate, session tenant, required material and plant, every column, exceptions visible. Browser: T-numbered fixture with stock, a PR partly converted, a PO partly delivered and safety stock, checking the projection, an exception, the past-due toggle and the drill.

Same-stage bookkeeping: B-849 / §26.861 / §30 row 2.679. Stage 2 next: the index decision, measured.

## §26.862 — SCR-130 stage 2: MD04 index decision is verification-only (migration 9070 not taken)

**B-850.** The package recommends (client, plant, material, requirement_date) on a pegging table this round declined. Because the date lives on each source document instead, the decision was measured where the reads actually happen: the three queries MD04 issues for one material and one plant.

**Method.** `scripts/plan-md04.mts` seeds 3,000 materials across 4 plants — 36,000 stock rows, 16,000 requisition items, 8,000 order items — gathers statistics, and times the stock read, the open-requisition read and the open-order read, with and without leading-key candidates on the two document tables.

| read | standing indexes | plus leading-key candidates |
| --- | --- | --- |
| stock for one material and plant | 0.063 ms (`stock_quantity_pkey`) | 0.064 ms |
| open requisitions | **0.039 ms** (`pr_item_material_plant_idx`, already shipped) | 0.038 ms (`md04_pr_cand`) |
| open orders | 16.79 ms (`purchase_order_pkey` + item key) | 19.66 ms, candidate unused |

**Decision — verification-only, no migration 9070.** The requisition read is **already** served by `pr_item_material_plant_idx` at a twentieth of a millisecond; the candidate matched it to within noise. The order read is driven by the document date and the candidate was never chosen — the arm even ran slower. Every read is bounded by a required material and plant, so no shape exists that a wider index could serve better. **Migrations stand at 188; 9070 stays unused.**

**For the service.** Stage 3 reads the three sources exactly as measured — stock by key, requisitions by the shipped material/plant index, orders driven by the header — and folds the chronology in TypeScript.

Same-stage bookkeeping: B-850 / §26.862 / §30 row 2.680. Stage 3 next: the `PROD.MRP.STOCKREQ` service and its tests.

## §26.863 — SCR-130 closed: MD04 stock/requirements list delivered

**B-851.** `PROD.MRP.STOCKREQ` — the frozen-roadmap capability at `CAIRN.md` §10 line 922 — is implemented at `/production/stock-requirements`. The roadmap row flips to Implemented, and the projection is computed live: nothing new is written.

**What stands.** One material in one **required** plant; an optional horizon end, an optional past-due display (default on, as the package states) and a daily-or-weekly split. The list folds stock on hand, **open requisitions net of what orders already cover**, **open orders net of what has been delivered**, and **safety stock as the opening requirement** into one chronology with a running projected balance, receipts before requirements on the same date.

**Three rules worth naming.**
- **Blocked stock never plans.** MRP availability counts `UNRESTRICTED` and `QUALITY` only, as SAP counts them; the excluded quantity is named in a warning rather than silently dropped.
- **Hidden past-due rows still move the balance.** Switching the display off removes the rows from the list but not from the arithmetic — the first visible row carries the position they produced. The browser run pins it: the hidden movement still shows in the stock row's 87.
- **The package's pegging table is declined.** `mrp_stock_requirement_element` with a stored projected balance would go wrong the moment a goods receipt posts; the list is recomputed on every execution.

**Deferred and refused by name.** Planned orders, production orders, sales orders and reservations (no such tables); excess-stock alerts (no stock ceiling exists, and inventing a threshold would manufacture an exception); **PR-to-PO conversion** — a posting action belonging to `PROC.PO.CREATE`, not to a read-only report. The MRP area, the one-character special stock indicator and a simulation version are refused with remedies naming the plant, the stock type and the live list.

**Index decision.** Measured and declined (B-850, §26.862): the requisition read is already served by the shipped `pr_item_material_plant_idx` at 0.039 ms, the candidate matched it within noise, and the order read never chose it. **No migration; 188 stand.**

**Acceptance.** Service 11/11; UI contract 11/11; **suite 1765/1765 across 247 files**; build clean; **T830 PASSED 7 legs** — 4 + 18 + 25 + 40 − 20 closes at 67 with the past-due requisition opening the list, blocked stock excluded and named, hidden past-due rows still moving the balance, the weekly buckets naming their week end, an MRP area and a missing material refused by name, and the order element drilling into the order display. Catalogue **161 capabilities / 135 terms / 157 aliases**; migrations **188**.

**Commits.** `a39cb0e` contract · `50368e1` stage 2 · `fdd1899` stage 3 · `101be4c` stage 4 · closure commit.

Same-stage bookkeeping: B-851 / §26.863 / §30 row 2.681. **Next: MB1B first** (`INV.TRANSFER.POST`, Roadmap — stock transfers between storage locations and plants), then **ME2N** as the lighter by-order-number perspective.

## §26.864 — SCR-131 contract: MB1B transfer posting, settled before implementation

**B-852.** MB1B arrives as **`INV.TRANSFER.POST`** at `/inventory/transfer-posting` — the frozen-roadmap capability at `CAIRN.md` §10 line 895 (`MIGO / MB1B`), flipped to Implemented at closure. No new capability code is coined, and no SAP keyword enters a table or a route.

**No duplicate state table. Deviation recorded.** The package defines `inventory_transfer_posting` with its own primary key, copying the material number, the movement type, both plants, both storage locations, the quantity and both dates. It is **declined**, on the same ground SCR-130 declined its pegging table: canon already carries the material document header (`material_document`, MKPF shape) and its line segment (`material_document_line`, MSEG shape), and a second table would be a second truth about the same posting. A transfer is a **material document of two lines**, found by its movement type and listed by MB51 like any other document. The package's foreign key to an accounting header is satisfied by the header's existing `journal_document_number`.

**One material per document** — the package's own primary key allows one row per document and no more, so the round posts one material per transfer. A multi-material grid is deferred by name.

**The movement type catalogue is T156 and it is data.** Six rows are delivered per tenant, each a `TRANSFER`-direction movement type with a reversal partner already named by the existing `reversal_movement_type` column:

| BWART (input alias) | stored key | meaning | reversal |
| --- | --- | --- | --- |
| 311 | `TRANSFER_STORAGE_LOCATION` | storage location to storage location, one plant, unrestricted stock | 312 |
| 312 | `TRANSFER_STORAGE_LOCATION_REVERSAL` | the counter of 311 | — |
| 301 | `TRANSFER_PLANT` | plant to plant, unrestricted stock | 302 |
| 302 | `TRANSFER_PLANT_REVERSAL` | the counter of 301 | — |
| 321 | `TRANSFER_STOCK_TYPE` | quality-inspection to unrestricted, one plant and one storage location | 322 |
| 322 | `TRANSFER_STOCK_TYPE_REVERSAL` | the counter of 321 | — |

The screen takes the **three-digit number** the package's field matrix names, because that is what the user knows; the service maps it to the stored key. The number is an input alias, never a stored code — the standing SAP-keyword ruling holds. An unknown number refuses by name and lists the three transfers.

**The document is two lines, and the line carries its side.** A transfer writes line 1 as the **issuing** line and line 2 as the **receiving** line of the same document, the same material, the same quantity — net zero, exactly SAP's shape. Because `entry_quantity` is positive by check, the side is carried by one new column, `material_document_line.line_direction` (`ISSUE` / `RECEIPT`, default `RECEIPT` for every document already posted); MB51 renders an `ISSUE` line with a negative sign so the two-line document reads truthfully. Schema changes this round: that column, and the `movement_type.direction` check widened from `('RECEIPT','REVERSAL')` to admit `'TRANSFER'`. Nothing else.

**What each transfer requires, and what it refuses by name.**
- **311** — receiving plant must equal the issuing plant, receiving storage location must differ from the issuing one, stock type stays `UNRESTRICTED` on both lines.
- **301** — issuing and receiving plants must differ; the material must be extended to **both** plants (`material_plant`), active in both, and valued in both (`material_valuation`); stock type stays `UNRESTRICTED`.
- **321** — same plant, same storage location, the pair fixed at `QUALITY` → `UNRESTRICTED` by the movement type. The package's optional stock-type field may be given and must agree with that source type, or be left empty.
- A receiving plant equal to the issuing one on a 301, a difference on a 311, different storage locations on a 321, a storage location that belongs to the wrong plant, an inactive storage location, a deleted material or plant segment, a missing valuation: each refuses with its own sentence and a remedy. Material, plants and both storage locations are **required**, as the package states.

**Sufficient stock, and the configured exception.** The issuing storage location and stock type must carry the quantity before the document posts. The package allows negative stock *where configuration permits it*, and canon already stores that configuration: `storage_location.allow_negative_stock`. That flag has been **inert** until now (its column comment says so); this round makes it operational **for the issuing side of a transfer only**, and consequently relaxes the `stock_quantity` non-negative check to a service rule — the guard is enforced in the posting path, not at the table, because a table check cannot see the storage location's configuration. A negative balance without the flag is refused by name with the quantity that stands named; with the flag, the transfer posts and the resulting negative is visible wherever stocks are read.

**Valuation.** A 311 or a 321 moves stock inside one plant and therefore one valuation area: quantity moves, value does not, and **no journal is posted**. A 301 moves quantity **and** value between two valuation areas: the issuing plant's stock value falls by the issuing unit value, the receiving plant's rises by the receiving valuation of the same quantity — at the receiving plant's standard price when it prices standard, at the transferred value when it prices moving average. When the receiving plant is standard-priced and its standard differs from the transferred value, the difference posts to the `PRICE_DIFFERENCE` account (SAP posts a price difference on a stock transfer); otherwise no journal is written, which is SAP's behaviour too.

**Period.** The posting date judges the **material** period (OMSY) on the plant's company code before anything moves, and a journal, when one is written, judges the financial periods on its own (OB52). A transfer into a closed material period refuses by name.

**Immutable, and the counter type is the correction.** A posted transfer cannot be edited; it is reversed by a second document on the **counter movement type** (312 / 302 / 322) carrying the two lines with their sides swapped, its own posting date judging the period again, the original marked reversed and naming its reverser, and the journal — where one exists — reversed by the standing journal reversal. A reversal of a reversal refuses, an already-reversed document refuses, and a reversal whose returning side no longer carries the stock refuses with the quantity that stands. A **general** material document reversal (MBST, `INV.REVERSE`) stays on the roadmap: this round's reversal covers transfers, the capability that owns them.

**Idempotent.** Every post and every reversal carries a request key; a replay returns the document already standing rather than posting twice.

**Refused or deferred by name:** **cross-company plant transfer** — issuing and receiving plants in different company codes need the intercompany clearing motion, refused by name with a remedy naming it; **batch (CHARG)** — no batch master exists in canon (`INV.BATCH.MAINTAIN` is roadmap), so a batch field is refused by name rather than silently dropped; **special stock indicators** — stock types are named (`UNRESTRICTED` / `QUALITY` / `BLOCKED`), the one-character indicator is refused as it was in SCR-130; **multi-material documents**, **serial numbers and handling units** — no tables; **automatic reversal range MBST** — `INV.REVERSE`, roadmap.

**Screen.** `/inventory/transfer-posting`: a header (movement type F4 listing 311/301/321 with their meanings, posting date, document date, header text at most 25) and one item block (material, quantity with its unit read from the material master, issuing plant and storage location, receiving plant and storage location, the optional stock type); the posted document displays with its two lines, its balance effects and a **Reverse** action. Read-only beyond posting and reversal.

**Tests planned.** Service: 311 posts two lines and moves stock between storage locations with no journal; 301 moves quantity and value between plants and posts no journal when prices agree; 301 into a standard-priced receiving plant posts the price difference; 321 moves quality to unrestricted inside one storage location; a transfer larger than the stock refuses with the standing quantity; the same transfer with `allow_negative_stock` posts and leaves the negative visible; an unknown movement type, a same-plant 301, a different-plant 311, a 321 with different storage locations, an inactive storage location and a foreign storage location each refuse by name; a cross-company plant transfer refuses by name; a closed material period refuses; a replay returns the same document; a reversal restores both sides, marks the original and reverses the journal; a reversal of a reversal refuses; a reversal with the returning stock gone refuses. UI contract: the screen pins the movement-type F4 and the two-line document. Browser: **T831** posts a 311, reads the two lines, reverses it, and reads both sides back.

**Index.** Measured at stage 2: the sufficiency read is the `stock_quantity` primary key, the extension read is `material_plant`'s key, and the F4 reads are key ranges — the expectation is verification-only, but it is measured and recorded.

Same-stage bookkeeping: B-852 / §26.864 / §30 row 2.682. Stage 2 next: the schema change and the index decision, measured.

## §26.865 — SCR-131 stage 2: the transfer document's shape lands in schema 9066; no index is taken

**B-853.** Migration **9066** carries the only schema change the contract needs, and it is three lines of intent:

- `material_document_line.line_direction` (`ISSUE` / `RECEIPT`, **default `RECEIPT`**) — every document posted before today is a receipt or a reversal of one, so the default backfills the whole history without touching a row. The side of a transfer is carried by the line, not inferred from its position.
- `movement_type.direction` widens from `('RECEIPT','REVERSAL')` to admit **`TRANSFER`** — one movement type serves both lines of the transfer, exactly as one BWART serves both MSEG items in SAP.
- `stock_quantity_nonnegative_ck` is **dropped**: the package permits negative stock where configuration says so, `storage_location.allow_negative_stock` has been inert until now, and a row-level check cannot read another table's flag. The guard moves into the posting path, where the storage location's configuration is known.

**Migrations stand at 189** (188 + 9066).

**The index decision is verification-only.** Measured on 3,000 materials × 4 plants × 2 storage locations × 3 stock types — 72,000 stock rows, 12,000 plant segments, 12,000 valuation rows:

| read | standing | note |
| --- | --- | --- |
| issuing stock row | **0.034 ms** (`stock_quantity_pkey`) | full key — the sufficiency check |
| whole-plant stock | **0.053 ms** (`stock_quantity_pkey`) | material + plant is a prefix of the same key |
| material-plant extension | **0.026 ms** (`material_plant_client_material_number_plant_pk`) | |
| storage-location list | **0.031 ms** (seq scan) | eight rows; the key `(client, plant, storage_location)` is a prefix, the planner simply has nothing to skip |
| valuation row | **0.022 ms** (`material_valuation_client_material_number_valuation_area_pk`) | |

A candidate `(client, plant, material_number, stock_type)` on `stock_quantity` — the shape a plant-wide MARD sum would want — was created, measured and dropped: the issuing read did not touch it (0.033 ms, unchanged) and the plant-wide sum it did serve came in **slower** than the standing prefix walk (0.063 ms against 0.053 ms). **No index, no migration 9067.** The posting path reads by full key at every step; there is nothing worth widening.

**Harness** `scripts/plan-mb1b.mts` committed with the measurement.

Same-stage bookkeeping: B-853 / §26.865 / §30 row 2.683. Stage 3 next: `INV.TRANSFER.POST` service — six movement types, two-line documents, the sufficiency rule with the configured negative, valuation across plants, the counter-movement reversal — and its tests.

## §26.866 — SCR-131 stage 3: the transfer service, sixteen tests green

**B-854.** `src/modules/inventory/transfer-posting.ts` posts, and reverses, every transfer this canon carries.

**The catalogue, shortened to the column it lives in.** The movement-type key is 20 characters wide (`movement_type.movement_type`, and the same width on the document line). The contract's longer names did not fit — `TRANSFER_STORAGE_LOCATION_REVERSAL` is 34 — so the six delivered keys are **`TRANSFER_SLOC` / `TRANSFER_SLOC_REV`**, **`TRANSFER_PLANT` / `TRANSFER_PLANT_REV`**, **`TRANSFER_STYPE` / `TRANSFER_STYPE_REV`**, each carrying its BWART number in the description. The number the user enters stays 311 / 301 / 321 (and the counters 312 / 302 / 322 are refused as hand entry: "is the counter of 311 … reverse the transfer document").

**What the service settles, in the order it judges.**
1. Dates must be ISO, the header text at most 25, the quantity positive, the material named.
2. The movement number resolves to a scenario, or refuses listing the three.
3. Structure: a 301 needs two plants, a 311 two storage locations of one plant, a 321 one storage location and the quality pair; each mismatch refuses with its own sentence. A named stock type must agree with the scenario's source type.
4. Master data: both plants exist, both carry a company code and are storage sites; the material is extended to **both** plants and valued in **both**; both storage locations belong to their plant and are active; both valuation areas share a currency.
5. **Cross-company refuses by name** — the receiving plant's company code must equal the issuing one, with the remedy naming intercompany clearing.
6. The material period judges the posting date (OMSY) before anything moves.
7. **Sufficiency at the issuing storage location and stock type**, with `storage_location.allow_negative_stock` the only way through — the flag is now operational.

**Two lines, and what each carries.** Line 1 is the `ISSUE` side, line 2 the `RECEIPT` side, both on the same movement type, net zero. A 311 or a 321 writes **zero value on both lines** and touches no valuation row: the stock moves inside one plant. A 301 writes the moved value on the issue line and the receiving valuation on the receipt line — the same figure when the receiving plant prices moving average, the receiving standard price when it prices standard.

**The journal is written only where value would otherwise be lost.** A 301 into a standard-priced plant whose price differs from the transferred value posts `INVENTORY` (receiving, debit) against `INVENTORY` (issuing, credit) with the difference to `PRICE_DIFFERENCE`, under document type `WA` — the goods-issue type, because the stock leaves the issuing plant. Every other transfer posts nothing, which is SAP's behaviour for a valuation-neutral move.

**Reversal is the only correction.** The counter movement type is read from the original movement's `reversal_movement_type`; the sides swap (the reversal issues from where the transfer arrived), the returning side is judged for stock again, the original is stamped `REVERSED` with its reverser, and the journal — where one exists — is reversed by the standing journal reversal. A reversal of a reversal refuses; an already-reversed document refuses; a document that is not a transfer refuses.

**Catalogue.** `INV.TRANSFER.POST` (capability, posting) and the term with route `/inventory/transfer-posting`, alias **MB1B**, added to `scripts/seed.ts`. Catalogue now **162 capabilities / 136 terms / 158 aliases**.

**Tests — 16/16** (`tests/transfer-posting.test.ts`): the 311 two-line move with no journal; same-location refusal; insufficiency naming what stands (70.000 against 5000.000); the 321 quality move and its wrong-location refusal; the 301 carrying 100 of value between plants with no journal; the 301 into a standard-priced plant valuing 100 at 200 and posting the price difference; same-plant 301 and cross-plant 311 refusals; unknown and counter movement numbers refused by name; a storage location of another plant, an inactive one and a missing one; the cross-company refusal with its intercompany remedy; the closed material period; the configured negative (`-5.000` in the open store, refusal in the closed one); the replayed request key; and the reversal that restores both sides, marks the original, reverses the journal, refuses to reverse itself, and refuses when the returning stock has gone.

`tsc` clean.

Same-stage bookkeeping: B-854 / §26.866 / §30 row 2.684. Stage 4 next: the screen, its i18n and browser target **T831**.

## §26.867 — SCR-131 closed: MB1B transfer posting delivered

**B-855.** `INV.TRANSFER.POST` — the frozen-roadmap capability at `CAIRN.md` §10 line 895 — is implemented at `/inventory/transfer-posting`, and the roadmap register flips its row to Implemented.

**What a transfer is.** One material, two lines, one material document: an **issuing** line and a **receiving** line, net zero. The movement type carries the scenario and is data — **311** storage location to storage location inside one plant, **301** plant to plant inside one company code, **321** quality inspection to unrestricted in one storage location — each paired with the counter movement type (**312 / 302 / 322**) its reversal posts. The three-digit numbers are what the user enters and may search; the stored keys are `TRANSFER_SLOC`, `TRANSFER_PLANT`, `TRANSFER_STYPE` and their `_REV` counters, shortened at stage 3 because the movement-type column is twenty characters wide.

**Three rules worth naming.**
- **The issuing side must carry it.** The sufficiency check reads the issuing storage location and stock type, and `storage_location.allow_negative_stock` — inert since it was written — is the only way through. The table-level non-negative guard left the schema for that reason and the rule lives in the posting path, where the configuration can be read.
- **A move inside a plant changes no value.** 311 and 321 write zero on both lines and touch no valuation row. A 301 carries the value between valuation areas and values the receipt at the receiving plant's standard price when it prices standard — and only then, when that differs from the transferred value, is a journal written, to `PRICE_DIFFERENCE` under document type `WA` (the stock leaves the issuing plant). A price-neutral 301 posts nothing, as SAP does.
- **Correction is the counter movement type.** Posted documents are immutable: the reversal is a second document with the sides swapped, the returning side judged for stock again, the original stamped `REVERSED` with its reverser, and the journal reversed by the standing journal reversal. A reversal of a reversal refuses. A general MBST reversal stays on the roadmap as `INV.REVERSE`.

**Refused and deferred by name.** A **cross-company plant transfer** refuses with the intercompany-clearing remedy; **batch (CHARG)** has no master in canon; **special stock indicators** stay refused as in SCR-130; **multi-material documents** (the package's own key allows one material per document), **serial numbers and handling units** have no tables; **MBST** is `INV.REVERSE`, roadmap.

**Deviation recorded.** The package's `inventory_transfer_posting` table is declined (stage 1): a transfer is a material document and its two lines in the canonical MKPF/MSEG shapes, and a second table would be a second truth. The package's `stock_type` field survives as the optional source-type check the 321 pair implies.

**Schema.** Migration **9066**: `material_document_line.line_direction` (default `RECEIPT`, backfilling every document already posted), the movement-type direction widened to `TRANSFER`, and the stock non-negative check dropped. **Migrations stand at 189.** No index was taken — the stage-2 measurement found every read served by a primary key (issuing row 0.034 ms, plant sum 0.053 ms, extension 0.026 ms, valuation 0.022 ms), and the plant-level candidate was unused and slower.

**Acceptance.** Service **16/16**; UI contract **9/9**; build clean; **T831 PASSED 9 legs** — a 311 posting as `MD-00000001` with an issuing line signed and a receiving line behind it, the stock moving 25 from SH01 to SH02, a 321 releasing quality to unrestricted, a same-location 311 and an over-draw refused in their own words, the transfer reversed by its counter movement type and both sides read back at 110 / 0. **Suite 1791/1791 across 249 files.** Catalogue **162 capabilities / 136 terms / 158 aliases**; migrations **189**.

**Commits.** `f62e3d6` contract · `5de476f` stage 2 · `0dfe82a` stage 3 · `0a7d32d` stage 4 · closure commit.

Same-stage bookkeeping: B-855 / §26.867 / §30 row 2.685. **Next: MBST first** (`INV.REVERSE`, Roadmap — reverse any material document, which this round leaves as the transfer counter only), then **MB21** (`INV.RESERVATION.CREATE`, Roadmap — reservations, the element MD04 still defers).

## §26.868 — SCR-132 contract: MBST reversal of any material document, settled before implementation

**B-856.** MBST arrives as **`INV.REVERSE`** at `/inventory/reversal` — the frozen-roadmap capability at `CAIRN.md` §10 line 897 (`MBST`), flipped to Implemented at closure. No new capability code is coined.

**No state table. Deviation recorded — the third time, for the third time correctly.** The package defines `material_document_reversal` keyed on the original and the reversal document, copying dates, reason and text. Canon already carries every one of those facts on the reversal document itself: `reversal_of` names the original, `reversed_by` names the reversal, `status` carries the cancellation flag the package calls `XSTBW`. A fourth table would be a fourth place for the same truth. **The cancellation flag is the existing status column**; the package's `XSTBW` is satisfied by `REVERSED` / `PARTIALLY_REVERSED`.

**One state change is needed.** The status check admits `('POSTED','REVERSED')` today. The package asks for **partial reversal by line**, so migration **9067** widens it to admit **`PARTIALLY_REVERSED`** — a document with some lines reversed and some still open. A document is `REVERSED` only when every line is fully reversed, and the duplicate guard reads the **per-line reversed quantity**, computed from the reversal lines' `reversal_of_document` / `reversal_of_line`, never from the header flag alone.

**Partial reversal means whole lines, not part of a line.** The package's selection is "all items or specific line items": the screen and the service take a **line selection**, and each selected line is reversed in full. A partial *quantity* per line is deferred by name — it needs a split line, which this canon does not carry.

**The engine mirrors the document.** For each selected line the reversal writes a line of the same material, quantity, plant, storage location and stock type with the **direction inverted**: an `ISSUE` line becomes a `RECEIPT` and a `RECEIPT` line becomes an `ISSUE`. The movement type is the original movement's **`reversal_movement_type`**; a movement that names no counter refuses by name. That is the same rule the transfer round used, and the goods-receipt movement already carries `RECEIPT_REVERSAL`.

**Stock and value follow the inverted sides.** A reversed `ISSUE` line adds its quantity back; a reversed `RECEIPT` line takes it away again, and that side is judged for sufficiency first (honouring `storage_location.allow_negative_stock`). Each line's value moves back with it: the reversal restores the issuing and receiving valuation rows to their pre-document quantities and values, and the journal — where the original posted one — is reversed by the standing journal reversal into the reversal document's header.

**Upstream documents are restored by derivation, not by a write.** The package asks to restore open order quantities in EKPO. Canon **derives** delivered quantity from the document lines — `receivedQuantities` signs every line by its movement's direction, and a `REVERSAL` movement subtracts — so reversing a goods receipt restores the open quantity the moment the reversal lines exist. Nothing is written back onto the order, and that is the honest mechanism: a stored open quantity would be a second truth.

**Downstream dependency is refused by name.** A receipt already invoiced cannot be reversed here: the supplier invoice this canon records carries no material-document link, so the check the package asks for (MIRO without a subsequent credit memo) cannot be made and is **refused by name with that remedy**, not silently skipped. The other downstream case — stock already issued out — is caught by the sufficiency rule and names the quantity that stands.

**Fields.** Material document number is **required**; the fiscal year is optional and, when given, must agree with the document's year (the number is unique per tenant, so the year names the document rather than selecting among duplicates — refusal by name on a mismatch). Posting date and document date are required and judge the material period (OMSY) and the journal's financial periods (OB52). Header text is optional at most 25. **Reason for reversal (GRUND) is refused by name**: no reason-code table stands in canon, and the remedy names the header text as where the reason is written.

**Refused or deferred by name:** reversal of a reversal; a document that is already fully reversed; a line already reversed; partial quantities; a reversal reason code; the invoice-settlement dependency; and **the two screen-specific reversals stay on their own screens** (MIGO's goods-receipt reversal and MB1B's counter movement) — SAP splits them the same way, and each refuses what it does not own.

**Tests planned.** A goods receipt reversed through MBST returns the stock, restores the order's open quantity, marks the original and reverses the journal; a 311 reversed through MBST restores both storage locations; a partial reversal reverses one line, leaves the other open, stamps `PARTIALLY_REVERSED`, refuses to reverse the same line twice and completes to `REVERSED` on the second line; a reversed document refuses again; a reversal of a reversal refuses; an unknown document, a wrong fiscal year and a reason code each refuse by name; a closed period refuses; reversing a receipt whose stock has been consumed refuses naming what stands, and passes where the location permits a negative; a movement without a counter refuses by name; a replay returns the same document. UI contract: the screen pins the lookup, the line selection and the refusal set. Browser: **T832** reverses a goods receipt and reads the order's open quantity back.

**Index.** Measured at stage 2: the original header and its lines read by primary key, and the **per-line reversed quantity reads `material_document_line.reversal_of_document`**, which carries no index today — that read is the one this round might need to index, and it is measured before it is decided.

Same-stage bookkeeping: B-856 / §26.868 / §30 row 2.686. Stage 2 next: migration 9067 and the index decision, measured.

## §26.869 — SCR-132 stage 2: the status gains a third state, and the reversal link is indexed at last

**B-857.** Two migrations, one decision each.

**9067 — `material_document.status` admits `PARTIALLY_REVERSED`.** The check was `('POSTED','REVERSED')`; the column is the cancellation flag the package calls `XSTBW`, and a document whose lines are only partly reversed needs a word for it. Every existing row is `POSTED` or `REVERSED` and keeps its value; nothing is rewritten.

**9068 — `mdl_reversal_of_idx` on `material_document_line (client, reversal_of_document)`.** This is the first index taken in three rounds, and it was measured, not assumed:

| read | standing | with the candidate |
| --- | --- | --- |
| original header (primary key) | 0.033 ms | 0.038 ms |
| original lines (primary key) | 0.027 ms | 0.028 ms |
| **per-line reversed quantity** | **10.093 ms — sequential scan** | **0.049 ms** |

At 60,000 document lines with 5,000 reversal lines, the coverage read cost a scan of every line the tenant had ever written. **Two hundred times faster with the index.** Taken.

**Migrations stand at 191.** Harness `scripts/plan-mbst.mts` committed with the measurement.

Same-stage bookkeeping: B-857 / §26.869 / §30 row 2.687. Stage 3 next: the reversal engine and its tests.

## §26.870 — SCR-132 stage 3: the general reversal engine, nine tests green

**B-858.** `src/modules/inventory/material-document-reversal.ts` reverses any material document this canon posts — a goods receipt, a transfer, or anything a later round adds.

**The mirror rule, in one sentence.** For every selected line the reversal writes a line of the same material, quantity, plant, storage location, stock type and value, with the **direction inverted** and under the original movement's **`reversal_movement_type`**; stock and valuation follow the inverted side, and a movement that names no counter refuses by name.

**Cancellation is arithmetic, not a flag.** `material_document.status` is set from the per-line coverage the reversal leaves behind: `REVERSED` when every line is fully covered, `PARTIALLY_REVERSED` when some line still stands open. The coverage itself is read from the reversal lines' `reversal_of_line` — the indexed read stage 2 bought — never from the header. A line already fully reversed refuses with its own sentence, so a document cannot be cancelled twice through the same line.

**Two schema facts the run discovered.** The status column was **ten characters wide** and `PARTIALLY_REVERSED` is eighteen (9069), and migration **0073** had tied the reversal link to a status of `POSTED` or `REVERSED` — a document that named its reverser could not also be partly reversed (9070). Both were caught by the tests, not by reading, which is the point of running them.

**The journal, the order and the period.** A document with a journal has it reversed into the reversal's header through the standing journal reversal. The order's open quantity is **restored by derivation** — `receivedQuantities` signs a `REVERSAL` movement's lines negative, so the reversal line itself reopens the order the moment it exists; nothing is written onto the order. The posting date judges every company code the reversed lines touch against the material period.

**Refusals by name.** An unknown document; a reversal of a reversal; a document already cancelled; a line already reversed; a wrong fiscal year (the number is unique per tenant — the year names the document, it does not select one); a **reversal reason code** (no reason table stands in canon; the remedy names the header text); a closed material period; a movement with no counter; and — the downstream case — **a receipt whose stock has gone**, refused with the quantity that stands unless the storage location permits a negative.

**Catalogue.** `INV.REVERSE` (capability, action `REVERSE`, posting) and its term at `/inventory/reversal`, alias **MBST**. Catalogue now **163 capabilities / 137 terms / 159 aliases**.

**Tests — 9/9** (`tests/material-document-reversal.test.ts`), one case each for: the goods receipt reversed (stock to zero, journal reversed, order back to `remaining 5`); a transfer reversed through the same engine; the partial reversal (line 2 only, `PARTIALLY_REVERSED`, line 2 refused again, line 1 completes to `REVERSED`); the double cancellation and the reversal of a reversal; the unknown document, the wrong year and the reason code; the closed period; the consumed-stock refusal beside the configured negative posting `−9.000`; the replayed request key; and the movement without a counter.

**Migrations stand at 192.**

Same-stage bookkeeping: B-858 / §26.870 / §30 row 2.688. Stage 4 next: the screen, its i18n, the UI contract and browser target **T832**.

## §26.871 — SCR-132 closed: MBST material document reversal delivered

**B-859.** `INV.REVERSE` — the frozen-roadmap capability at `CAIRN.md` §10 line 897 — is implemented at `/inventory/reversal`, and the roadmap register flips its row.

**The engine.** Any material document this canon posts is reversible by one rule: each selected line is mirrored with its **direction inverted** (a receipt becomes an issue and takes its stock back; an issue becomes a receipt and returns it) under the **counter movement type the original movement names**. Transfers, goods receipts and whatever a later round posts all flow through the same engine, and the transfer screen's own counter-movement reversal now has a general sibling.

**Cancellation is arithmetic.** The header status is computed from the per-line reversed quantity, read off the reversal lines' `reversal_of_line` through the index this round took: `PARTIALLY_REVERSED` while any line still stands open, `REVERSED` when none does. A line already reversed in full refuses with its own sentence, so nothing is cancelled twice and nothing is silently skipped.

**The value and the order.** Stock and valuation return with the inverted lines; a document carrying a journal has it reversed into the reversal's header. The order's open quantity is **restored by derivation** — the reversal line itself signs negative in `receivedQuantities` — so no stored open quantity is written back, which is the only honest way in this canon.

**Four schema facts the work found, three of them only by running.** The status check admitted two states (9067); the status **column was ten characters wide** and `PARTIALLY_REVERSED` is eighteen (9069); migration 0073 had tied the reversal link to `POSTED`/`REVERSED`, so a partly reversed document could not name its reverser (9070); and the **per-line coverage read cost a 10.093 ms sequential scan** until `mdl_reversal_of_idx` brought it to **0.049 ms** (9068) — the first index taken in three rounds, and taken on measurement.

**Refusals by name.** Unknown document; reversal of a reversal; already-cancelled document; a line already reversed; a disagreeing fiscal year (the number is unique per tenant); a **reversal reason code** (no reason master exists; the remedy names the header text); a closed material period; a movement with no counter; and a receipt whose stock has gone, with the quantity that stands — unless the storage location permits a negative, which the round honours.

**Build note, recorded because it will recur.** The build box is 2 GB and webpack's build died of OOM at every heap cap tried (1400 → SIGKILL from the kernel at ~1.4 GB RSA; 1100 and 900 → V8 SIGABRT). Types remain gated the same way as before — `tsc --noEmit` runs as its own step — but `next.config.ts` now sets `typescript.ignoreBuildErrors` and `eslint.ignoreDuringBuilds`, and the acceptance build runs **`next build --turbopack`**, which completes in ~55 s inside the box.

**Acceptance.** Engine **9/9**; UI contract **9/9**; build clean (turbopack); **T832 PASSED 9 legs** — the lookup showing what stands open, the receipt reversed to `REVERSED` with its stock gone, the transfer reversed one line at a time through `PARTIALLY_REVERSED` to `REVERSED`, a cancelled document offering no control, and a reversal refusing to reverse itself. **Suite 1810/1810 across 251 files.** Catalogue **163 capabilities / 137 terms / 159 aliases**; migrations **193**.

**Commits.** `84de4a9` contract · `e7a9421` stage 2 · `c90f26e` stage 3 · `fc7ac7c` + `1208e81` stage 4 · closure commit.

Same-stage bookkeeping: B-859 / §26.871 / §30 row 2.689. **Next: MB21 first** (`INV.RESERVATION.CREATE`, Roadmap — reservations, the element MD04 still defers), then **MB03** (`INV.DISPLAY`, Roadmap — display a material document on its own screen).

## §26.872 — SCR-133 contract: MB21 reservations, and the demand MD04 has been missing

**B-860.** MB21 arrives as **`INV.RESERVATION.CREATE`** at `/inventory/reservations` — the frozen-roadmap capability at `CAIRN.md` §10 line 903 (`MB21`), flipped at closure. No new capability code is coined.

**This time the package's tables are right, and they are the only new state.** A reservation genuinely stores something (a demand nobody has posted) and has nowhere else to live, so `reservation_header` (the RKPF shape) and `reservation_item` (the RESB shape) are taken **as two new tables**, shaped to canon: the tenant key is `client`, and the company code is **derived from the plant** rather than entered — canon derives it everywhere else and the package's field matrix never asks for it.

**The plant is on the item, not the header.** The package's field matrix lists plant in the header, but its own schema puts it on the item — and that is SAP's shape (RESB carries WERKS; RKPF carries no plant). **Item wins**; one header may therefore supply several plants. Recorded because the matrix and the schema disagree.

**Numbering.** The reservation number comes from the standing numbering engine under a new object code **`RESERV`** (six characters, inside the R-98 ten-character rule), sub-object `*`, prefix `RSV`, length 8, delivered with the tenant's other ranges.

**Movement types 201 and 261, as data — and one thing the catalogue never carried.** The movement catalogue learns a fourth direction, **`ISSUE`**, and an **account-assignment category per movement type** (`NONE` / `COST_CENTER` / `ORDER`) — the T156 fact that decides what a withdrawal must be charged to. Two rows are delivered per tenant:

| BWART | stored key | meaning | account assignment |
| --- | --- | --- | --- |
| 201 | `RESERVATION_ISSUE_CC` | goods issue for a cost centre | **required** |
| 261 | `RESERVATION_ISSUE_ORDER` | goods issue for an order | **required** |

**But 261 refuses by name**, because canon carries no order master: `PROD.ORDER.CREATE` is a capability row without a table. The 261 row is delivered so the catalogue tells the truth about the movement, and a reservation on it refuses with the remedy naming the missing order capability. What is delivered end to end is **201 with a real cost centre**: the centre must exist in the controlling area the plant's company code points at, be valid on the required date, and not be posting-locked. That is the package's account-assignment validation, against real master data.

**A reservation posts nothing, so no posting period judges it.** The package asks that creation dates be validated against inventory and financial periods. They are not, and the deviation is deliberate: OMSY and OB52 exist to guard postings, and a reservation is a planning document. A required date in the past is allowed and MD04 shows it as a **past-due requirement**, which is SAP's behaviour. Recorded.

**The obligation this round must meet: MD04 learns reservations.** SCR-130 deferred reservations *by name* because no table existed. They exist now, so the stock/requirements list gains a fifth element — **`RESERVATION`**, a **requirement** dated at its required date, quantity **required − withdrawn**, for items that are not completed, not deleted and still carry an open quantity. A list that ignored them would report stock that the plant has already promised away. The MD04 deferral is closed for reservations, and the closure says so.

**Withdrawals.** The package asks that goods issues (MIGO / MB1A) decrement stock and increment `withdrawn_quantity`. **No goods-issue screen exists in canon** — `INV.GI.POST` is a capability row without a service — so the round delivers the **withdrawal hook itself**: `withdrawReservation` posts a withdrawal against one item, increments the cumulative quantity, refuses one larger than the open quantity, refuses a completed item or one whose movement is not allowed, and **completes the item** the moment the required quantity is withdrawn. Wiring it to an MB1A screen is **deferred by name** until that screen exists; the hook is what the screen will call, and it is tested now.

**Item state.** Each item carries the package's **movement-allowed flag** (default true) and **completion flag**; completing an item by hand is allowed and audited, and a completed item stops being a demand in MD04 at once.

**Refusals by name.** Unknown material; material not extended to the plant; material flagged for deletion; plant that does not exist or carries no company code; a movement type that is not a reservation movement; 201 without a cost centre; a cost centre outside the controlling area, not valid on the required date or posting-locked; 261 without an order master; a storage location of another plant or inactive; no items; a quantity that is not positive; a withdrawal beyond the open quantity; a withdrawal on a completed or forbidden item; a replay returning the reservation already standing.

**Fields on screen.** Header: movement type (F4 over the two delivered rows), required date, and the cost centre when the movement type demands one. Items: material, required quantity, storage location (optional), movement-allowed. The unit is read from the material master and never typed. The screen posts, shows the created reservation with its items, offers **withdraw** and **complete** on each open item, and lists the reservation's demand effect.

**Deferred by name:** the 261 order reference (no order master); the goods-issue screen that will call the withdrawal hook; retention/expiry of old reservations (the package's "retention window" needs a rule nobody has set); multi-line movement types other than 201/261; reservations created from production orders or sales orders (no such documents).

**Tests planned.** Creation writes a numbered header and its items; two items in two plants derive two company codes; MD04 shows a reservation as a requirement at its required date with the open quantity, ordered among the other elements, and drops it when completed or fully withdrawn; a partial withdrawal leaves the remainder as demand; 201 without a cost centre, a cost centre outside the area, an unlisted cost centre and a posting-locked one each refuse by name; 261 refuses by name; a storage location of another plant refuses; zero items and a non-positive quantity refuse; over-withdrawal refuses naming the open quantity; a replay returns the same reservation. UI contract pins the fields, the F4 and the refusals. Browser **T833**: create a reservation, see it in MD04 as a requirement, withdraw part, complete it, and watch the demand disappear.

**Index.** Measured at stage 2 — reservation items are read two ways (by reservation for the screen, by plant and material for MD04) and the answer is decided by measurement, not assumption.

Same-stage bookkeeping: B-860 / §26.872 / §30 row 2.690. Stage 2 next: the two tables, the movement-catalogue widening and the index decision, measured.

## §26.873 — SCR-133 stage 2: the reservation tables land (9071) and the demand read is indexed (9072)

**B-861.** Migration **9071** creates `reservation_header` (RKPF shape) and `reservation_item` (RESB shape) in canon's standing form — `client` as the tenant key, audit columns, the item's primary key `(client, reservation_number, item_number)` and the header foreign key with `on delete cascade` — and teaches the movement catalogue two facts it never carried: the **`ISSUE`** direction and an **`account_assignment`** column (`NONE` / `COST_CENTER` / `ORDER`), with the reference-category check widened to admit `RESERVATION`. The number range **`RESERV`** (`RSV`, 8 digits) joins the tenant's standard operational ranges, inside the R-98 ten-character rule.

**Migration 9072 — the second index in two rounds, taken on the same terms.** Measured on 20,000 reservations of three items over 3,000 materials and 4 plants (60,000 items):

| read | standing | with the candidate |
| --- | --- | --- |
| one reservation's items (screen) | **0.044 ms** (`reservation_item_pk`) | 0.036 ms — unchanged, already the key |
| **a material's open reservations by plant (MD04)** | **9.418 ms** — walked every header | **0.114 ms** |

**Eighty-two times faster.** `ri_plant_material_idx (client, plant, material_number)` is taken. The screen needs nothing.

**Migrations stand at 195.** Harness `scripts/plan-mb21.mts` committed with the measurement.

**Two mistakes the harness caught, both mine, both before any test:** the `account_assignment` column was written into the constraint array instead of the column object (the transform refused to compile), and the harness's own seeding used a ten-character reservation number where the column is ten — `RSV-` plus eight digits is eleven, so the seeded length is six digits.

Same-stage bookkeeping: B-861 / §26.873 / §30 row 2.691. Stage 3 next: the reservation service, the MD04 demand element, and the withdrawal hook, with their tests.

## §26.874 — SCR-133 stage 3: reservations exist, and MD04 answers with them

**B-862.** `src/modules/inventory/reservations.ts` creates, reads, withdraws from and completes reservations; `stock-requirements.ts` gains the element.

**The document.** A numbered header (RKPF shape) carrying the movement type, the required date and the cost centre; items (RESB shape) at 10, 20, 30 carrying material, plant, optional storage location, required and withdrawn quantities, unit from the master, the movement-allowed flag and the completion flag. Every item is judged **before anything is written** — material exists and is not flagged for deletion, extended to its plant, storage location belongs to the plant and is active, quantity positive — and the cost centre is judged once: it must stand in the plant's company code, be valid on the required date, and be unlocked. A reservation whose items span **two company codes refuses**, because one cost centre cannot bear both.

**The 261 refusal is the honest one.** The order movement is delivered in the catalogue so the catalogue tells the truth, and a reservation on it refuses by name with the remedy naming `PROD.ORDER.CREATE` — the capability that would bring the order master.

**Withdrawals.** `withdrawReservation` records that stock has left against an item, refuses more than the open quantity (naming what stands), refuses a completed item and one whose movement is not allowed, and **completes the item** the moment the required quantity is reached. `completeReservationItem` completes one by hand. Both are audited as changes on the reservation.

**MD04 now answers with reservations.** A new `RESERVATION` element — direction `REQUIREMENT`, dated at the required date, quantity **required − withdrawn**, drilled to `/inventory/reservations?reservation=…` — joins the list for every item not completed. The SCR-130 deferral is closed for reservations; the module header says so.

**Two widths the run corrected.** The movement keys had to shorten to fit the twenty-character column (`RESERV_ISSUE_CC`, `RESERV_ISSUE_ORDER`), and — migration **9073** — the reservation number column had been written at the package's `CHAR(10)`, while canon's numbering engine renders `RSV-00000001` (twelve). The column widens to 20 to hold what the engine issues, exactly as material documents do; the FK pair widened together. **Migrations stand at 196.**

**Catalogue.** `INV.RESERVATION.CREATE` (not posting) and its term at `/inventory/reservations`, alias **MB21**. Catalogue now **164 capabilities / 138 terms / 160 aliases**.

**Tests — 11/11** (`tests/reservations.test.ts`): the numbered header with two items in two plants, company code derived; the MD04 requirement at its required date; part withdrawal leaving the remainder as demand and full withdrawal removing it; the hand-completed item leaving the list at once; over-withdrawal, completed item and forbidden movement refused; the cost-centre set (missing, unlisted, locked, expired) refused by name; the 261 refusal naming the order capability; unknown movement, unknown material and both storage-location refusals; empty items, non-positive quantity and a malformed date; the two-company-code refusal; and the replayed request key. **MD04's own 22 tests stay green** with the new element.

`tsc` clean.

Same-stage bookkeeping: B-862 / §26.874 / §30 row 2.692. Stage 4 next: the reservation screen, its i18n, the UI contract and browser target **T833**.

## §26.875 — SCR-133 stage 4: the reservation screen

**B-863.** `/inventory/reservations` is delivered: a lookup by number, a create
form, and — once a reservation is loaded — its items with required, withdrawn and
open quantities, a withdrawal field and a Complete button per open item.

The create form takes the movement type from the two named scenarios (201 and
261, each with its plain-English description), the required date, the cost centre,
and up to three item lines with material, plant, quantity, optional storage
location and the movement-allowed flag ticked by default. The company code is
never typed: it follows the plant, and the note beside the button says so. Every
write is replayed against the request key the form carries, so a double submit
writes one reservation.

The MD04 screen learned the new element's label (**Reservation**); without it the
list would have called a reservation a safety-stock line.

**Tests — 8/8** (`tests/reservation-ui-contract.test.ts`): the capability gate and
session scope, the header fields, the three item lines, the quantity columns and
the state flag, the withdrawal and completion actions hidden on a completed item,
the request key, the 261 remedy and the catalogue row. The browser-harness
contract suite stays green with **133 targets** (T833 registered against
`cairn_b210:5432`).

`tsc` clean.

Same-stage bookkeeping: B-863 / §26.875 / §30 row 2.693. Stage 5 next: build and
run **T833**.

## §26.876 — SCR-133 stage 5: T833 passes; MB21 is delivered

**B-864.** The acceptance build (`npx next build --turbopack`, 55 s) and the
production server carried **T833** through its legs against `cairn_b210:5432`:

1. the screen opens on **Create Reservation**;
2. a 201 reservation for 25 at 2026-11-20, charged to `CC9001`, is created and the
   status reads `Reservation RSV-00000001 created with 1 item.`;
3. the loaded document shows item 10 open at **25.000**;
4. MD04 shows a **RESERVATION** row dated **2026-11-20** demanding **25.000**;
5. a withdrawal of 10 leaves the item open at **15.000**;
6. MD04 demands the **15.000** that remain;
7. a withdrawal of the last 15 completes the item, which offers no further
   withdrawal;
8. MD04 carries no reservation row for it — the demand is gone;
9. a 261 refuses by name (`carries no order master`).

The screen fix the run forced: `data-completed` sat on the state cell while the
row carried `data-item`; the row now carries both, because the completion is a
fact about the item, and the browser reads it there.

**Suite — 1830/1830 in 253 files** (up from 1810/251: eleven reservation tests and
eight UI-contract tests).

**Closed.** `INV.RESERVATION.CREATE` is **Implemented** in
`FUNCTIONS-AND-ROADMAP.md`; the catalogue reads **164 capabilities / 138 terms /
160 aliases**; migrations **196**. SCR-133 is delivered end to end in five
commits: `131725c` · `e9a804d` · `b343deb` · `e239646` · this closure.

**Deferred by name:** the MB1A/MIGO wiring of the withdrawal hook (`INV.GI.POST`
still has no service), retention and expiry of reservations, and the 261 order path
until `PROD.ORDER.CREATE` brings an order master.

**Next:** **MB03** (`INV.DISPLAY`, Display Material Document), then **MB90**
(`INV.MATERIALDOC.RECEIVEPRINT`, Print Goods Receipt Note — the next unimplemented
MB row standing after MB21 in `CAIRN.md` §10), as reported under B-444.

## §26.877 — SCR-134 / MB03: the display contract

**B-865.** Owner package: **MB03 Display Material Document** — lookup by document
number and fiscal year, read-only header (posting date, document date, header
text, user, entry time) and an item grid (movement type, material, plant, storage
location, quantity, base unit, upstream reference), a not-found message in the
SAP shape, and **no writes at all**.

**The screen exists already and is reworked, not duplicated.** SCR-125 delivered
`/inventory/material-documents` as MB51's drill and shared `INV.MATERIALDOC.LIST`
with the list, because a report and its drill were judged one capability. The
frozen roadmap gives MB03 its own capability `INV.DISPLAY`, so the display is
re-gated on it: **the list alone no longer opens a document** — a reader without
`INV.DISPLAY` sees the capability message, which is SAP's own division (MB51 shows
lines; MB03 shows the document, and each checks its own authorisation). The drill
from MB51 keeps its route and is subject to the display capability.

**The key the package proposes cannot exist here.** The package asks for
`[tenantId, companyCode, mblnr, mjahr]`; canon's material document header carries
**no company code** — a document may move stock in two plants of two company codes
(the transfer refuses cross-company transfers, but the receipt path does not pin a
header company), and SCR-125 already settled that **the document number is unique
per tenant**. The lookup therefore stands on `(client, material_document_number)`
with the **fiscal year accepted as a cross-check**: an entered year that disagrees
with the document refuses by name, exactly as MBST does. The package's matrix and
schema disagree again and parity of behaviour beats parity of columns.

**Item number (ZEILE)** is optional and contextual, as the package states: given,
it narrows the grid to that line and marks it; an item the document does not carry
refuses by name. **F4 on both fields is deferred by name** — canon has no
search-help framework, so the number and year are typed, and the screen says what
an F4 would have shown rather than pretending.

**What the display adds to the row:** the poster (`created_by`, the package's
USNAM) and the entry time (`created_at`), the material description from the
master, the stock type and line direction (canon's transfer writes an issuing and
a receiving line), the value and currency, the purchase order reference
(`EBELN`/`EBELP`), and the reversal pair.

**Drills.** To **MB51** on the same document (the list, filtered), and to the
upstream **purchase order** where a line names one. The **accounting document**
(FB03, `FIN.JOURNAL.DISPLAY`) is **deferred by name** — that capability is still
Roadmap, so the journal number is shown as text with the reason. The **reservation
reference (RSNUM)** is **deferred by name**: no path posts a document against a
reservation yet (`INV.GI.POST` has no service; SCR-133 shipped withdrawals as a
tested hook only), so a reservation number would be a column nothing could fill.

**Refused by name.** Plant- and storage-location-level authorisation objects: canon
authorises by capability and tenant, not by plant; inventing a plant filter here
would refuse documents the postings themselves allow. **Period checks (OMSY /
MARV / OB52): a display never applies them** — MB03 shows the document as posted,
including one whose period has since closed, which is the whole point of a
historical display.

**No tables, no writes.** Stage 2 will measure the package's proposed index
`(tenant, company, mblnr, mjahr)` against the primary key before agreeing to it.

Same-stage bookkeeping: B-865 / §26.877 / §30 row 2.695.

## §26.878 — SCR-134 stage 2: the package's index is refused, measured

**B-866.** No migration. The display is served by keys that already stand, and the
index the package proposes would be dead weight — and slower.

Seeded 5,000 material documents of three lines each (15,000 lines) over three
fiscal years, then timed the three reads a display makes, before and after adding
`(client, document_year, material_document_number)`:

| read | standing keys | with the package's index |
| --- | --- | --- |
| header by number | 0.026 ms (`material_document_pkey`) | 0.023 ms — unchanged |
| header by number **and year** | 0.020 ms (`material_document_pkey`) | 0.055 ms — the candidate, **2.7× slower** |
| the document's lines | 0.027 ms (`material_document_line_pkey`) | 0.037 ms — unchanged |

The reason is structural, not incidental: the lookup is **equality on a unique
key**. Adding the year to the index cannot make a unique lookup cheaper — the
primary key finds the row in one descent — while the year-leading candidate forces
a second index to be considered and chosen where the planner would rather not.
The package's `[tenantId, companyCode, mblnr, mjahr]` cannot be built at all
(§26.877: the header carries no company code), and dropping the company leaves an
index that only repeats what the primary key already guarantees.

**Index refused. Migrations stay at 196.** The plan script is kept as
`scripts/plan-mb03.mts` so the refusal can be re-run.

Same-stage bookkeeping: B-866 / §26.878 / §30 row 2.696.

## §26.879 — SCR-134 stage 3: the display service

**B-867.** `src/modules/inventory/material-document-display.ts` exports
`MATERIAL_DOC_DISPLAY_CAPABILITY = 'INV.DISPLAY'`, `MaterialDocumentDisplayError`
and `displayMaterialDocument`.

**What it reads.** The header — number, year, both dates, header text, status,
journal document, reversal pair, and **the poster and the entry time** the package
asks for as USNAM and CPUTM. The lines — item, movement type **with its
description**, the line direction canon writes transfers with, material **with its
description**, plant, storage location, stock type, base quantity and unit, entry
quantity and unit, value and currency, the purchase order and item, and the
reversal-of pair. The **company codes are derived** from the plants the lines
stand in and sorted: the document header has no company code, and inventing one
would be the fiction the package's schema already asks for (§26.877).

**The year is a cross-check.** Given, it must equal the document's own year; a
disagreement refuses with `Material document … does not exist in fiscal year …`
and a remedy naming the year it does stand in. Absent, the number alone is
enough — because the number is unique per tenant.

**The item is a narrowing.** `itemNumber` filters the grid and is reported back as
`selectedItem`; an item the document does not carry refuses with the items it does
carry listed.

**Refusals by name:** an empty number, a year that is not four digits, an item
that is not a whole number. The not-found message is the SAP shape —
`Material document 4999999999 does not exist.`

**Catalogue.** `INV.DISPLAY` delivered (not posting) and its term at
`/inventory/material-documents`, alias **MB03**: **165 capabilities / 139 terms /
161 aliases**.

**Tests — 10/10** (`tests/material-document-display.test.ts`): the header with
poster and entry time; material and movement descriptions resolved onto the line;
the company codes derived from two plants in two companies; the not-found message;
the year cross-check both ways; the malformed year and empty number; the item
narrowing and its refusal listing the real items; a reversed document in a closed
year shown exactly as posted; the list drill on the same posting date; and another
tenant never reaching the document.

Same-stage bookkeeping: B-867 / §26.879 / §30 row 2.697. Stage 4 next: the screen.

## §26.880 — SCR-134 stage 4: the display screen re-gated and reworked

**B-868.** `/inventory/material-documents` is now MB03 rather than MB51's drill: it
carries `INV.DISPLAY` in its own right, and a reader without that capability sees
the capability message even though the list may be theirs.

**The lookup** asks for the document number (required), the fiscal year (a
cross-check) and an optional item that narrows the grid. The hint beside the
button says exactly that, so nobody wonders why the year can be left empty and why
it is refused when wrong.

**The header** names the poster and the entry time, shows the company codes derived
from the plants, both dates, the header text, the status and the reversal pair, and
carries the journal number as **text with the reason** — the accounting-document
display is still Roadmap, and a dead link would be worse than a note.

**The item grid** shows the item, the movement type with its description and
direction, the material with its description, plant, storage location, stock type,
quantity with unit, value with currency, and the reference column: the purchase
order with its item as a link, the reversal-of pair as text. A deferred note under
the grid states that a reservation reference would be empty because no posting path
writes one yet.

**Two older assertions reworked, not deleted.** The MB51 contract used to assert
that the display shared its capability and called `getMaterialDocument`; both were
true when the display was the list's drill (§26.877 supersedes them), so the test
now asserts the opposite — the display gates itself and reads through its own
service.

**Tests — 18/18** across the two contracts (10 new for MB03, 8 for MB51 reworked);
the browser-harness contract is green at **134 targets** (T834 registered against
`cairn_b210:5432`). `tsc` clean.

Same-stage bookkeeping: B-868 / §26.880 / §30 row 2.698. Stage 5 next: build and
run **T834**.

## §26.881 — SCR-134 stage 5: T834 passes; MB03 is delivered

**B-869.** Acceptance build (`npx next build --turbopack`, 47 s) and the production
server carried **T834** through its legs against `cairn_b210:5432`:

1. the document opens on **Display Material Document 4900000777** at fiscal year
   2026;
2. the header names the poster **JSMITH**, and the **company code is derived** from
   the plants that moved the stock;
3. both lines stand, and the material and movement **descriptions resolve** onto
   them; the purchase order reference is shown; the issuing line carries
   `ISSUE`;
4. an item narrows the grid to one line;
5. a year that disagrees refuses: `Material document 4900000777 does not exist in
   fiscal year 2025`;
6. a number that does not stand refuses in the SAP shape:
   `Material document 4999999999 does not exist.`;
7. an item the document does not carry refuses and names the items it does carry;
8. a **reversed document in a closed year** still shows, status `REVERSED` — a
   display applies no period check.

The one fixture correction the run forced: the browser tenant carries a single
company code, so the acceptance asserts the derived code rather than a pair of
them. The suite test keeps the two-company case, where the fixture can build it.

**Suite — 1851/1851 in 255 files** (was 1830/253: ten service tests, ten UI-contract
tests, and the MB51 contract reworked).

**Closed.** `INV.DISPLAY` is **Implemented** in `FUNCTIONS-AND-ROADMAP.md`;
catalogue **165 / 139 / 161**; **migrations steady at 196** — no table and no index
was added, because the primary keys already serve every read (§26.878). SCR-134 is
delivered in five commits: `348a38f` · `3345297` · `7a7437a` · `8c7834c` · this
closure.

**Deferred by name:** F4 search help, the accounting-document drill until
`FIN.JOURNAL.DISPLAY` is delivered, the reservation reference until a posting path
writes one, and plant-level authorisation objects.

**Next:** **MB90** (`INV.MATERIALDOC.RECEIVEPRINT`, Print Goods Receipt Note), then
**MB1A** (`INV.GI.POST`, Goods Issue) — the next two unimplemented Inventory rows in
`CAIRN.md` §10.

## §26.882 — SCR-135 / MB90: the output contract

**B-870.** Owner package: **MB90 output determination and dispatch for material
documents** — output type, medium, dispatch time, a selection over documents,
plants and status, and a queue of records whose dispatch is logged with its
success, its failure and its timestamps.

**Two NAST-shaped tables, not the package's one.** `output_type` is the catalogue
*and* the condition record — the output type, its description, the direction it
applies to, the transmission medium and the dispatch time it defaults to.
`output_message` is the queue and the log: the document and year it belongs to, the
output type, the medium, the dispatch time, the status, the send count, the
recipient, the printer queue, the last attempt and its reason. The package's single
`material_document_output_log` folded the condition into the log, which means a
rule could only be learned from a message that happened to exist.

**The package's object key is refused.** It stores `MBLNR + MJAHR + ZEILE` in one
`object_key` column. A concatenation cannot be foreign-keyed, cannot be indexed by
year, and lets a record point at a document that does not exist. Canon stores
**three columns** — document, year — with a foreign key to the material document
header, and no item: SAP's output for MB90 is per document, not per line, and the
package's own matrix says so.

**The package's company code is refused again.** `tenantId` + `companyCode` with a
foreign key to an `accountingHeader` table that canon does not have, on a header
that carries **no company code** (§26.877). The tenant key is `client`; the company
code is **derived from the plants** the document moved and shown, never stored, as
MB03 does.

**Named states, with SAP's digits as aliases.** One-character codes are refused as
canon refuses them everywhere else: status is `PENDING` / `PROCESSED` / `ERROR`
(SAP 0 / 1 / 2), medium is `PRINT` (1) and `EMAIL` (5), dispatch time is
`IMMEDIATE` (1) and `PERIODIC` (3). **FAX (2) and EDI (6) are refused by name** — canon
has neither a fax nor an EDI endpoint, and a message that could never leave is a
lie in the audit trail.

**Two output types are delivered:** **WE01**, the goods receipt slip, for documents
whose lines receipt, and **WA01**, the goods issue slip, for documents whose lines
issue. The capability keeps its frozen roadmap name `INV.MATERIALDOC.RECEIVEPRINT`
even though the package's MB90 is both slips; the term reads "Material document
output" and the route is `/inventory/material-document-output`.

**Determination happens where a document is born** — goods receipt, transfer
posting and material document reversal each ask for their outputs as they post, so
an immediate output is dispatched inside the posting that caused it. A **run**
determines what stands missing and dispatches what is pending, which is both the
periodic path (VSZTP = 3 has no scheduler in canon) and the way documents posted
before this capability existed acquire their slips — the walkthrough rule needs
that, and asking an owner to re-post history to see a printout would be worse.

**Printing is rendering, and it is recorded.** A dispatch renders the slip from the
document as posted — document, year, dates, poster, every line with its material,
description, plant, storage location, quantity with unit and value — and marks the
message `PROCESSED`, increments the send count and stamps the time. It hands
nothing to a printer or a mail server: **the spool and the transport are deferred by
name**, because canon has no device or SMTP client and inventing one would be
untested infrastructure.

**Failure is real, not decorative.** An `EMAIL` message with no recipient fails at
dispatch with a recorded reason and status `ERROR`; entering a recipient and
dispatching again succeeds. That is the package's "re-trigger failed transmissions"
and "modify recipient queues" in one mechanism. A `PRINT` message always renders.

**Refused by name:** FAX and EDI media; re-dispatching a `PROCESSED` message (a
repeat is a new output, deferred); and every posting-period instinct — MB90 never
re-judges a period, because a document that stands passed its own checks when it
posted, and this screen reads history.

**Deferred by name:** the scheduler, condition technology beyond direction (access
sequences, requirements), spool files and PDF attachments, and hand-off to a
printer or mail server.

**No writes to the ledger.** The only writes are the output queue's own rows.

Same-stage bookkeeping: B-870 / §26.882 / §30 row 2.700.

## §26.883 — SCR-135 stage 2: two tables, and the index the queue actually needs

**B-871.** Migration **9074** creates `output_type` (catalogue and condition) and
`output_message` (queue and log), both keyed by `client`, with the document
referenced by `(client, material_document_number)` through a real foreign key and
no company code anywhere. Migration **9075** adds the queue index the measurements
demanded. **Migrations stand at 198.**

Measured over **40,000 documents and 40,000 messages**:

| read | standing keys | package's `(status, output_type)` | taken: `(status, created_at)` |
| --- | --- | --- | --- |
| the grid, newest first | 9.650 ms, seq scan | 7.836 ms, **still seq scan** | **0.085 ms** — `Index Scan Backward` |
| grid narrowed to one output type | 10.277 ms | 7.407 ms, still seq scan | **0.069 ms** |
| the periodic run (pending, oldest first) | 6.197 ms | 4.920 ms, still seq scan | **0.394 ms** |
| one document's messages | 0.020 ms (pk) | 0.024 ms | 0.025 ms |

**The package's index is refused because the planner refused it**: after `analyze`
it was never chosen, and it cannot be — MB90 reads the queue by *status and time*,
never by status alone. The index taken is `(client, status, created_at)`, which
serves both the grid's backward scan and the run's forward one; the plan is a
limit over an index scan reading exactly the 200 rows asked for.

**What the tables carry.** `output_type`: the code, its description, the direction
it applies to, the medium and the dispatch time it defaults to, and an active flag.
`output_message`: the document and its year, the output type and medium, the
dispatch time, the status, the send count, the recipient, the printer queue, the
last attempt and its reason — with the status, the medium, the dispatch time, the
send count and the error text each guarded by a check, so no row can claim an
ERROR without saying why.

Same-stage bookkeeping: B-871 / §26.883 / §30 row 2.701.

## §26.884 — SCR-135 stage 3: the output engine and its posting hook

**B-872.** `src/modules/inventory/material-document-output.ts` exports
`MATERIAL_DOC_OUTPUT_CAPABILITY = 'INV.MATERIALDOC.RECEIVEPRINT'`,
`MaterialDocumentOutputError`, the delivered catalogue, determination, dispatch,
the queue read, the slip renderer and the recipient change.

**Determination is at the document's birth.** `recordOutputsForPostedDocument`
runs **inside the posting transaction** and is called by all three posting paths —
goods receipt (`postGoodsReceipt`), transfer posting (`postTransfer`, and the counter
movement that reverses it) and reversal (`reverseMaterialDocument`). A document
whose lines are all receipts earns **WE01**, all issues earns **WA01**, and a
document that does both — a transfer — earns **neither**, because neither slip
describes it; the run counts those as `transfers` rather than pretending. That
ruling is recorded here rather than in §26.882 because the measurement of the
catalogue came first.

**Immediate means immediate.** The hook dispatches `IMMEDIATE` messages in the same
transaction: a goods receipt's WE01 is `PROCESSED`, `send_count` 1 and stamped
before the posting returns. `PERIODIC` messages — WA01 defaults to it, because a
goods issue slip is a batch print in SAP too — wait for the run.

**The run** (`determineOutputs`) fills what stands missing across a document, year
and posting-date selection, so documents posted before this capability acquire
their slips — the walkthrough rule needs that. It is **idempotent**: the primary key
refuses a second row, so a second run creates nothing.

**Dispatch** renders the slip from the document as posted and records the attempt.
`PRINT` always renders; `EMAIL` needs a recipient and **fails for real** without
one — status `ERROR`, the reason stored, and a `setRecipient` followed by a second
dispatch succeeds. A `PROCESSED` message refuses a repeat by name.

**The slip** is plain text: the document and year, when it posted and by whom, the
header text, and every line with its movement, material and description, plant,
storage location, quantity and unit, with the item count at the foot.

**Catalogue.** `INV.MATERIALDOC.RECEIVEPRINT` delivered (not posting) and its term
at `/inventory/material-document-output`, alias **MB90**: **166 capabilities / 140
terms / 162 aliases**.

**Tests — 11/11** (`tests/material-document-output.test.ts`): the receipt slip
determined and dispatched as it posts; the issue slip pending at the periodic
cadence; a transfer earning nothing; the run filling history and staying
idempotent; the status counts and the output-type narrowing; the rendered slip; the
EMAIL failure, its recorded reason and its success after a recipient; the refusal of
a second dispatch; the periodic run clearing the queue; FAX and EDI refused by name
with the media that exist; and a missing message plus another tenant's invisible
queue. **The three posting suites stay green — 27/27.**

Same-stage bookkeeping: B-872 / §26.884 / §30 row 2.702. Stage 4 next: the screen.

## §26.885 — SCR-135 stage 4: the output screen

**B-873.** `/inventory/material-document-output` is delivered: the selection the
package lists — output type, medium, dispatch time, status, document range, year,
plant range and posting dates — a run that determines the missing slips and
dispatches the pending ones, and the queue itself.

**The queue** shows every row with its document and year, the output type and its
description, the medium and dispatch time **with SAP's digits beside them**, the
status with its VSTAT digit, the send count, the recipient, the last attempt and
the reason a failure failed. **SAP's one-character codes appear only as aliases**;
the stored and filtered values are the names.

**Per row:** Dispatch (disabled once processed), a recipient field with Set, and a
Preview that renders the slip from the document as posted into a `<pre>` the same
screen shows. A failure states its reason in the row, not only in a status line.

**Message placement.** Both action state lines — the row action's and the
recipient's — stand **outside** the table's conditional blocks, so a message never
vanishes with the state that produced it (the standing ruling from the SCR-1xx
screens).

**Tests — 9/9** (`tests/material-document-output-ui-contract.test.ts`), and the
browser-harness contract is green at **135 targets** (T835 registered against
`cairn_b210:5432`). `tsc` clean.

Same-stage bookkeeping: B-873 / §26.885 / §30 row 2.703. Stage 5 next: build and run
**T835**.

## §26.886 — SCR-135 stage 5: T835 passes; MB90 is delivered

**B-874.** Acceptance build (`npx next build --turbopack`, 49 s) and the production
server carried **T835** against `cairn_b210:5432`:

1. the screen opens on **Material Document Output**;
2. **Determine and dispatch** runs; the status line reports what it determined and
   dispatched;
3. document `4900000901` carries **WE01, PROCESSED, one send**;
4. the slip **preview** renders `MATERIAL DOCUMENT 4900000901 / 2026`, the material
   and `10.000 PC`;
5. an **EMAIL** message with no recipient fails, and the row says **why** — "needs a
   recipient";
6. a recipient is set, the row reports it, and a second dispatch **processes** it
   with the send counted to one.

**Suite — 1872/1872 in 257 files** (was 1851/255: eleven service tests and nine
UI-contract tests; the three posting suites stayed green through the hook).

**Closed.** `INV.MATERIALDOC.RECEIVEPRINT` is **Implemented** in
`FUNCTIONS-AND-ROADMAP.md`; catalogue **166 / 140 / 162**; **migrations 198**. SCR-135
is six commits: `b06b607` · `e924bc7` · `7a04937` · `cb1eea1` · this closure.

**Deferred by name:** the scheduler (the run is operator-triggered), condition
technology beyond direction, spool files and PDF attachments, hand-off to a printer
or a mail server, and a repeat dispatch of a processed message.

**Two things the round decided late and recorded in §26.884 rather than the
contract:** a **transfer earns neither slip** — it both receipts and issues, and
neither document describes it; and the three posting paths call the hook **inside
their own transaction**, so a slip cannot exist for a document that rolled back.

**Next:** **MB1A** (`INV.GI.POST`, Goods Issue — the last unimplemented MB row in
`CAIRN.md` §10 and the service SCR-133's withdrawal hook has been waiting for), then
**MIGO 261** (`PROD.ORDER.GI`, Goods Issue to Order — which needs `PROD.ORDER.CREATE`
first and should be opened with that dependency stated).

## §26.887 — SCR-136 / MB1A: the goods issue contract

**B-875.** Owner package: **MB1A Post Goods Issue** — a movement type, a header with
its posting and document dates and text, and item lines with material, plant,
storage location, quantity, unit, optional batch, a controlling object and an
optional reservation; stock reduced, the ledger written, the period judged.

**The package's table is refused, table and all.** `goods_issue_posting` is a
*second* place where a material movement is recorded — its own document number, its
own fiscal year, its own status, foreign-keyed to an `accountingHeader` that canon
does not have. Canon already has one ledger of movements: `material_document` and
`material_document_line` (MKPF/MSEG shapes), written by goods receipt, transfer
posting, reversal and reservation withdrawal. A goods issue is a **material
document**, and a parallel table would mean two answers to "what moved", either of
which could be wrong. **No table is added this round.**

**Movements delivered: 201 and 551.** `GI_ISSUE_CC` — goods issue to a cost centre —
and `GI_SCRAP` — scrapping. **261 is refused by name**: it consumes against a
production order, canon has no order master, and `PROD.ORDER.CREATE` is still
Roadmap; SCR-133 refused the reservation on the same ground and the remedy is the
same. The counter movements (202 / 552) are delivered **in the catalogue** with
their `reversal_movement_type` links, so **MBST reverses a goods issue** through the
tested path — MB1A itself posts nothing but an issue, and an attempt to post a
counter movement here is refused with the remedy naming MBST.

**The valuation decides the value, and the cost centre decides the debit.** An issue
is valued at the material's own price in the plant — standard price under `S`,
moving average under `V` — and the plant's valuation carries the quantity and value
down by exactly that. The journal credits **INVENTORY** at the valuation class; it
debits **CONSUMPTION** (201), carrying the **cost centre on the line**, or **SCRAP**
(551) with no controlling object. Both are new account-determination events, and an
unmaintained one refuses by name before anything moves.

**201 needs a cost centre that stands**: present, in the plant's company code,
valid on the posting date, not posting-locked — the same judgement MB21 makes, so
the two agree. 551 refuses a cost centre rather than ignoring it, because a
scrapping that charged a cost centre would be a different transaction wearing the
movement's name.

**The reservation hook is finally wired.** A 201 line may name a reservation number
and its item; the posting calls SCR-133's `withdrawReservation` **inside the same
transaction**, so `withdrawn_quantity` rises, the item completes when it is issued in
full, and **MD04's demand falls in the same commit** — the deferral SCR-133 recorded
by name is closed. A reservation whose material or plant differs from the line
refuses, and issuing beyond what stands open refuses with the open quantity named.

**Stock sufficiency, on the location's own terms.** The issuing storage location must
carry the quantity unless it carries `allow_negative_stock` — the SCR-131 ruling,
operational since. Blocked stock is never issued; an unrestricted issue reads only
the unrestricted balance.

**Periods are judged, because a goods issue posts a journal.** The material period
(OMSY, `material_period_control`) and the accounting posting period (OB52 through
`checkPostingAllowed`) both judge the posting date — unlike a reservation, this
transaction writes to the ledger.

**Batch is deferred by name**: canon has no batch master (SCR-131 deferred it on the
same ground), so the field the package marks conditional has nothing to point at and
is refused if entered rather than silently dropped.

**Delivered with the screen:** a header (movement, both dates, text), lines of
material, plant, storage location, quantity de-read from the master's base unit,
cost centre, reservation; results showing the document and journal, and the lines as
posted.

Same-stage bookkeeping: B-875 / §26.887 / §30 row 2.705.

## §26.888 — SCR-136 stage 2: no table, and no index either — measured

**B-876.** A goods issue adds **no table** (§26.887: it writes the one ledger canon
has), so the question is whether any read it makes wants an index the standing keys
do not carry. It does not.

Seeded 20,000 materials extended to a plant, 80,000 location balances, 20,000
valuations and 20,000 reservations of three items, then timed the four reads a
posting makes:

| read | plan | time |
| --- | --- | --- |
| the material master | `material_client_material_number_pk` | 0.034 ms |
| the location's balance | `stock_quantity_pkey` | 0.028 ms |
| the valuation | `material_valuation_…_pk` | 0.027 ms |
| the reservation item the hook withdraws | `reservation_item_pk` | 0.027 ms |

Every one is an equality on a unique key. **No migration. Migrations stand at 198.**
The plan script is kept as `scripts/plan-mb1a.mts`.

Same-stage bookkeeping: B-876 / §26.888 / §30 row 2.706.

## §26.889 — SCR-136 stage 3: the goods issue service, and the hook that was waiting

**B-877.** `src/modules/inventory/goods-issue.ts` exports `GOODS_ISSUE_CAPABILITY =
'INV.GI.POST'`, `GoodsIssueError`, `GOODS_ISSUE_SCENARIOS`, the delivered movement
catalogue and `postGoodsIssue`.

**One transaction, seven writes.** The journal, the material document header and its
lines, the stock balance, the valuation, the reservation's withdrawn quantity and the
document's output all commit together. A refusal anywhere leaves stock exactly where
it stood — a test asserts that against a locked cost centre.

**Movements.** `201` → `GI_ISSUE_CC` (cost centre) and `551` → `GI_SCRAP`
(scrapping), each with its counter movement delivered in the catalogue (202 / 552 as
`GI_ISSUE_CC_REVERSAL` / `GI_SCRAP_REVERSAL`) and its `reversal_movement_type` link,
so **MBST reverses a goods issue** through the path SCR-132 already tested. **261
refuses by name** naming `PROD.ORDER.CREATE`; **202 and 552 refuse naming MBST**.

**Value and journal.** An issue is worth `quantity × price`, standard price under
`S` and moving average under `V`, both divided by the price unit and rounded to two
places. The journal **credits INVENTORY** at the valuation class and **debits
CONSUMPTION** — carrying the **cost centre on the line** — or **SCRAP**. Both events
are new account determinations; a missing one refuses by name before anything moves.

**The cost centre** must stand in the plant's company code, be valid on the posting
date and not be posting-locked — the same judgement MB21 makes. A 551 that names one
**refuses** rather than ignoring it: a scrapping that charged a cost centre is a
different transaction wearing the movement's name.

**Stock** is judged on the issuing location's own terms: enough on hand unless the
location carries `allow_negative_stock` (SCR-131, operational), an inactive location
refuses, and the issue reads only unrestricted stock.

**The reservation hook is wired.** `withdrawReservationInTx` was extracted from
`withdrawReservation` so the goods issue can call it **inside its own transaction**;
the item's withdrawn quantity rises, it completes when issued in full, and MD04's
demand falls **in the same commit**. A reservation whose material or plant differs
from the line refuses, naming both; an issue beyond what stands open refuses with the
open quantity in the message. **SCR-133's deferral is closed.**

**Periods.** The material period (OMSY) and the accounting period (OB52, through
`postJournalEntry`) both judge the posting date — unlike a reservation, this writes
to the ledger.

**Batch** is refused if entered, because canon has no batch master to point at.

**Catalogue.** `INV.GI.POST` delivered (posting) and its term at
`/inventory/goods-issue`, alias **MB1A**: **166 capabilities / 141 terms / 163
aliases**.

**Tests — 14/14** (`tests/goods-issue.test.ts`): the 201 with its document, journal,
stock and valuation (100 → 90, 1,000 → 990, 50,000 → 49,500, credit and debit of 500
with the cost centre on the debit); the 551 to the scrapping account with no
controlling object; a 551 naming a cost centre refused; 261 refused naming the
capability that would deliver it; 202 and 552 refused naming MBST; stock judged on
the location's terms, including the open store that takes a negative; a closed
material period refused; the cost centre missing, locked and foreign; an unknown
material, a blocked location and a batch; **the reservation withdrawal clearing MD04's
demand from 8 to 5 in the same posting**; an issue beyond the reservation refused; the
request-key replay; **a failed post leaving stock untouched**; and another tenant
refused before anything is written.

Same-stage bookkeeping: B-877 / §26.889 / §30 row 2.707. Stage 4 next: the screen.

## §26.890 — SCR-136 stage 4: the goods issue screen

**B-878.** `/inventory/goods-issue` is delivered: the header (movement, both dates,
text), four item lines with material, plant, storage location, quantity, cost centre
and a reservation with its item, and the posted document once it stands.

**The cost centre follows the movement.** Choosing 551 disables the cost-centre
inputs rather than inviting a value the service will refuse — the screen and the
service agree on what the movement charges.

**The result** carries the document, its movement, the company code derived from the
plant, the journal and the total value, then every line as posted — and, where a
reservation was named, **what still stands open on it after the posting**, which is
the fact that makes the MD04 demand fall visible on the same screen.

**The status line** sits above the form and outside every conditional block, so a
refusal — the 261 message, the stock message, the locked cost centre — never
disappears with the state that produced it.

**Tests — 8/8** (`tests/goods-issue-ui-contract.test.ts`); the browser-harness
contract is green at **136 targets** (T836 registered against `cairn_b210:5432`).
`tsc` clean.

Same-stage bookkeeping: B-878 / §26.890 / §30 row 2.708. Stage 5 next: build and run
**T836**.

## §26.891 — SCR-136 stage 5: T836 passes; MB1A is delivered

**B-879.** Acceptance build (`npx next build --turbopack`, 49 s) and the production
server carried **T836** against `cairn_b210:5432`:

1. the screen opens on **Post Goods Issue**;
2. a 201 of 10 for `MB1A-MAT` from `QP01/SP01` against `CC7701` posts, and the status
   names the **material document**, its **journal** and the value;
3. the stock balance falls from **100 to 90** — read back from the database, not from
   the screen;
4. a reservation for **8** is created on the reservation screen and **MD04 demands
   8.000**;
5. a second 201 issuing **3** against that reservation's item 10 posts, and the row
   reports **5.000 still open**;
6. **MD04 demands the 5.000 that remain**.

The fixture needed two things the screen did not: the journal's number range
(`RF_BELEG/GENERAL`) and the **INVENTORY account determination** — the first real
use of the event in a browser tenant. Both are fixture facts, recorded here so the
next posting screen's fixture starts with them.

**Suite — 1895/1895 in 259 files** (was 1872/257: fourteen service tests and eight
UI-contract tests).

**Closed.** `INV.GI.POST` is **Implemented** in `FUNCTIONS-AND-ROADMAP.md`;
catalogue **166 / 141 / 163**; **migrations steady at 198** — this round added no
table and no index, by measurement (§26.888). SCR-136 is five commits: `6973ad9` ·
`cfd2bd2` · `1366903` · `2fafacc` · this closure.

**Deferred by name:** the **production-order issue (261)** until `PROD.ORDER.CREATE`
brings an order master, **batch** (no batch master), and movement types beyond 201 and
551 — 309/311-style transfers belong to the transfer posting, not here.

**Two consequences worth stating.** SCR-133's withdrawal hook is no longer a hook: it
is called by a real posting, in the same transaction, and MD04 follows. And the goods
issue earns its **WA01** output at the periodic cadence, because SCR-135's hook runs
here too — an issue slip appears in the output queue the moment the issue posts.

**Next:** **MIGO 261** (`PROD.ORDER.GI`, Goods Issue to Order — which needs
`PROD.ORDER.CREATE` first and should be opened stating that dependency), then **MB03's
deferred drill**: `FIN.JOURNAL.DISPLAY` (FB03), the one gap every posting screen now
points at.

## §26.892 — SCR-137 / FB03: the universal drill-down anchor

**B-880.** Owner package: **FB03 Display Financial Accounting Document** — number,
company code and fiscal year in; header, line items, account type and amounts out;
read-only, immutable, the destination every posting screen jumps to.

**The screen exists and is re-gated, not duplicated.** SCR-090 delivered
`/finance/journal/document` as the accounting document display with its flow, under
**`FIN.DOC.FLOW`**. The frozen roadmap gives **`FIN.JOURNAL.DISPLAY`** (FB03) its own
row, and the two are not the same question: FB03 shows the document; the flow shows
what surrounds it. So the display's **base** is re-gated on `FIN.JOURNAL.DISPLAY`
and the **flow panel keeps `FIN.DOC.FLOW`** — a reader may hold the one without the
other, exactly as SAP separates the document from its flow.

**The company code is a cross-check, not a second key.** The package calls it
required. Canon's document number is unique per tenant **and year** (`journal_entry`
primary key `[client, documentNumber, fiscalYear]`), and the drills this round is
supposed to anchor — MB03, the goods issue, the journal list — already carry the
number, so demanding a company before the lookup would break the anchors to protect
a second copy of a fact. Ruling: **the number and year identify; the company code,
when given, must agree** and a disagreement refuses in SAP's own words —
`Document … does not exist in company code …`. Omitting it resolves it, which is
what the existing drills rely on.

**KOART is derived, and derived honestly.** A line's account type is **S** (G/L)
unless it carries a business partner — then **D** (vendor) or **K** (customer),
judged by whether that partner stands in `supplier_company_code` or
`customer_company_code` for the line's company code, both of which canon has. **A
(asset) and M (material) are refused by name**: canon's journal line carries the
material as an assignment and no asset number at all, so a type the data cannot
support would be a label nobody could audit.

**The anchor becomes real.** MB03 shows the journal number as text "because
`FIN.JOURNAL.DISPLAY` is still Roadmap" (§26.877); the goods issue result names its
journal; the journal list names its documents. All three now **link** here. That is
the deferral closing, and it is the point of the round.

**Navigation kept:** the reversal pair, the origin document, the clearing documents
and the change history the display already carries. **Deferred by name:** the tax
detail jump (a tax reporting capability owns it), and F4 search help, which canon has
no framework for anywhere.

**Refused by name:** company-code-level authorisation (canon authorises by capability
and tenant, as MB03 refused plant-level objects), and **every posting-period check** —
this display shows a document as posted, including one whose period has closed, and
re-judging it would make the audit trail conditional on today's calendar.

**No writes.** A display that wrote would not be a display.

Same-stage bookkeeping: B-880 / §26.892 / §30 row 2.710.

## §26.893 — SCR-137 stage 2: the package's index is refused, measured again

**B-881.** No migration. FB03 reads one document by a key that is already unique, and
the package's company-leading index buys nothing and costs a little.

Over **40,000 documents of four lines each** in two company codes:

| read | standing keys | with `(client, company, number, year)` |
| --- | --- | --- |
| header by number and year | 0.032 ms (`…_pk`) | 0.031 ms — unchanged |
| header **and company** | 0.033 ms (`…_pk`) | 0.052 ms — **1.6× slower** |
| the document's lines | 0.037 ms (`…_line_…_pk`) | 0.049 ms — unchanged |

Same structural reason as MB03 and MB90 (§26.878, §26.883): the lookup is **equality
on a unique key**, so the year and the company in the index cannot narrow it further,
and a second candidate only makes the planner consider more before choosing the same
plan. The company code is a **filter on the row found**, not a way to find it.

**Index refused. Migrations stay at 198.** `scripts/plan-fb03.mts` keeps the evidence
re-runnable.

Same-stage bookkeeping: B-881 / §26.893 / §30 row 2.711.

## §26.894 — SCR-137 stage 3: the document refuses the wrong company, and derives KOART

**B-882.** The display answers three questions differently now: what the key finds, whether
the company agrees, and what kind of partner each line stands against.

`DocumentLookup` is `FOUND | NOT_FOUND | COMPANY_MISMATCH | PARKED`. The header is read by
**number and year** — canon's primary key — and the company is judged *after* the row is in
hand: a document that exists under the number in another company is refused as
`Document … does not exist in company code …`, naming the company it does stand in, rather
than the bare "not found" the old fold produced. A number that names nothing, and a number
that names a parked document, keep their own answers.

Every line carries `accountType` — SAP's `KOART`. It is **derived, never stored**: `S` for a
G/L line, `D` where the line's partner stands in `supplier_company_code` for the document's
company, `K` where it stands in `customer_company_code`. Two equality reads with the
document's partner numbers, only when the document names any partner at all — no query per
line, and no fourth table to drift from the two role masters. A partner that stands in
neither table is a G/L line, which is what a one-time address is.

Nothing is written: no change history, no audit row, no period check. The display shows the
document as it was posted, which is what FB03 is for.

**Tests.** 8/8 new (`tests/journal-document-display.test.ts`) and 3/3 in the reworked
`tests/document-display.test.ts` (its mismatch assertion now expects `COMPANY_MISMATCH`).
Fixture lesson, recorded because it cost the stage twenty minutes of silence:
`supplier_company_code` and `customer_company_code` take a foreign key to **`bp_role`**, not
to `business_partner`; `role_code` is checked to `SUPPLIER` / `CUSTOMER` and `company_status`
to `INCOMPLETE` / `CREATED` / `MAINTAINED`. A `.catch` around a fixture turns broken masters
into **skipped** tests — the suite reports green while testing nothing — so the catch is gone
and a broken fixture now fails loudly.

**Type gate, honestly.** `npx tsc --noEmit` could not finish in this container (1.9 GB):
heap exhaustion at ~940 MB, and killed at 1.4 GB. A scoped `tsc -p` over the four touched
files and their import graph types clean in 11 s and is what carried the stage; the whole
program is recorded as **not run**, not as passed. Same-stage bookkeeping: B-882 / §26.894 /
§30 row 2.712.

## §26.895 — SCR-137 stage 4: the screen splits its two capabilities, and the anchors become real

**B-883.** The display's base gates on **`FIN.JOURNAL.DISPLAY`**; the flow panel keeps
**`FIN.DOC.FLOW`** and says so plainly when the reader holds only the first — "the flow
around the document needs the document flow capability; this display shows the document
alone". One screen, two questions, and a reader may hold either alone.

**The lookup form reads like the rule it follows.** Document number and fiscal year stay
required; the **company code no longer is**, and the form says why: *the number and the
fiscal year identify the document; the company code, when given, must agree with the one
it was posted in.* A disagreement renders beside the other refusals with
`data-company-mismatch` and SAP's sentence — `Document … does not exist in company code …`
— never a silent "not found".

**KOART is a column, not a footnote.** Every line row carries `data-account-type` and the
grid shows the type beside the line number, so an S, a D and a K in one document can be
read at a glance and asserted from a browser.

**The anchor is the point of the round, and it is closed.** Three screens that showed a
journal number as dead text now link here:

- the **journal list** (`/finance/journal`) — with the complete key it already carries
  (`document`, `company`, `year`), so the cross-check cannot disagree with the row;
- **MB03** — the number it deferred in §26.877, linking by number alone and letting the
  display resolve the company and year, exactly as the contract made possible;
- the **goods issue result** (MB1A) — the journal the posting wrote.

The mirror-image note `mdDoc.journalDeferred` ("the accounting document display (FB03) is
not yet delivered, so the journal number is shown as text") is **deleted**: a deferred
sentence that outlives its deferral is a lie the next reader has to disprove. Its MB03
contract test now asserts the link and the reservation deferral that remains.

**Target T837** (`journal-document-display`, `cairn_b210:5432`) joins the harness — 137
targets — with an eight-leg run: number and year with no company given, S/D/K from one
document, a company that disagrees refused in SAP's words with no header rendered,
the flow panel beside the document, the ledger unchanged after every visit, and all
three anchors followed click-by-click to the same display.

Same-stage bookkeeping: B-883 / §26.895 / §30 row 2.713.

## §26.896 — SCR-137 stage 5 and closure: T837 passes, FB03 delivered

**B-884.** The display is accepted, and the round's point — that every posting screen has
somewhere to jump to — stands closed.

**T837** (`journal-document-display`, `cairn_b210:5432`) ran against the production build
(`npx next build --turbopack` → `next start`, exit 0) in eight legs:

1. a document read **by number and year alone**, no company given — the key the drills
   actually carry;
2. **KOART derived in one document**: one D, one K, two S, read from
   `data-account-type` and from the column;
3. a company that **disagrees** refused as `Document … does not exist in company code …`
   with **no header rendered** — the refusal is not a warning above a document;
4. the **flow panel standing beside the document** under its own capability;
5. **nothing written**: four lines and 240.00 in the ledger before and after every visit;
6. the **journal list** carrying the complete key in its link, followed to the display;
7. **MB03** — the number §26.877 deferred as text — followed to the same document;
8. the **goods issue result**, its journal followed to the display it just wrote.

**Suite 1911/1911 in 261 files.** Harness **137 targets**. Capability registry unchanged
at **166 / 141 / 163** — `FIN.JOURNAL.DISPLAY` and `FIN.DOC.FLOW` were both already
seeded, and this round re-gated rather than added. **Migrations stay 198**: the index was
refused on measurement (§26.893) and no table was needed.

**The type gate, for the record.** The owner ruled that the acceptance build is the gate
(`typescript.ignoreBuildErrors` stands, B-879's option 2), and the build passed; the
whole-program `npx tsc --noEmit` still cannot run in this container — it exhausts a
1.9 GB heap. The scoped `tsc -p` over the touched graph stays the substitute evidence,
recorded here rather than claimed as a full pass.

Two deferred by name, still deferred: the **tax-detail jump** and **F4 search help**.
Two refused by name, still refused: **company-code-level authorisation** and **every
posting-period check**.

Same-stage bookkeeping: B-884 / §26.896 / §30 row 2.714.

## §26.897 — SCR-138 / CO01: the order must stand before the issue, and the issue is a material document

**B-885.** Owner package: **MIGO 261, goods issue to a production order** — action A07, reference
R08, the order number, dates, and a component grid; the issue consumes stock, charges the order,
and credits inventory. The package opens with its own prerequisite note, and it is right to:
**261 cannot post against an order master that does not exist.**

**So the round's deliverable is the prerequisite, named honestly.** `PROD.ORDER.CREATE` (CO01)
stands in the registry as a code with no service, no table and no screen; SCR-133 already refuses
a 261 reservation in these words — *"Production orders are a roadmap capability
(PROD.ORDER.CREATE); reserve on 201 against a cost centre until orders exist"* (§26.7xx). A 261
posted against a number nobody can display would be a deferral outliving its deferral, which is
the one thing this ledger refuses to do. **SCR-138 delivers CO01; SCR-139 posts 261 against it.**
Nothing in the 261 package is dropped — it is carried in this section as the consumer contract the
order master is shaped for, so the next round inherits decisions rather than re-opening them.

**The package's table is refused by name.** `production_order_goods_issue` would be a second
answer to "what moved", exactly what §26.887 refused for `goods_issue_posting` when MB1A was
built. In canon a goods issue **is** a material document plus its journal entry; the order is a
**reference on the line**, not a new ledger. The package's column set is carried onto canon's
tables rather than onto a table of its own:

| package | canon |
| --- | --- |
| `tenant_id varchar(64)` | `client varchar(4)` — the tenant key every table carries |
| `document_number` + `fiscal_year` | `material_document.material_document_number` (unique per tenant) + `document_year` |
| `manufacturing_order_number varchar(12)` (AUFNR) | a reference column on `material_document_line`, FK to the order header — **stages 2–3, next round** |
| `accountingHeader` foreign key | no such table — the journal is reached by `material_document.journal_document_number`, as MB03 and MB90 already do |
| `mkpf` / `mseg` | `material_document` / `material_document_line` |
| `mard` | `stock_quantity` |

**MIGO's action and reference dropdowns are refused by name.** A07 and R08 exist in SAP because
MIGO is one screen reaching dozens of movements; canon reaches each movement through its own
capability (MB1A for 201/551, MB1B for transfers, and now CO01 then 261). A dropdown whose only
other value is unavailable is furniture, and it invites the reader to believe the other movements
stand.

**The order master this round builds, and what it deliberately is not.** A production order in
canon is a **header** (order number from the standing `PRODORDER` range — length 12, prefix `PRD`,
already in the tenant defaults and never yet drawn — the material to be produced, the plant, the
order quantity and unit, the scheduled dates, the status) and a **component list** (material, plant,
storage location, required quantity, unit) stored as a **snapshot on the order**. There is no BOM
master and no routing in canon, so the component list is entered, not exploded — **declared, not
inferred**, and named as such at the point of entry. The order's company code is **derived from its
plant**, never typed, as MB03 derives its own (§26.877).

Status is a two-step lifecycle this round: **CREATED → RELEASED**. 261 will judge `RELEASED` and
refuse anything else by name. Deferred by name: **TECO / technically complete**, order closure,
deletion flags, and the status history — nothing posts until a release stands, so nothing needs
retiring yet.

**What the next round inherits, recorded so it is decided once.**

- **Movement types** `PROD_ISSUE_ORDER` (261) and `PROD_ISSUE_ORDER_REV` (262), `account_assignment
  ORDER` — the column already permits `ORDER` (SCR-133) — and a **new reference category
  `PRODUCTION_ORDER`**, which the standing check does not allow and which needs the round's one
  migration.
- A **`production_order_number`** on the material document line and the component item beside it;
  the order's **withdrawn quantity is derived** from the documents, never written back — the same
  discipline MBST keeps for open quantities (§26.884).
- Account determination gains **`PRODUCTION_CONSUMPTION`**: WIP (balance sheet) debited per
  valuation class, `INVENTORY` credited — the package's "WIP or production cost collector".
- **Over-issue refused by name**, naming what the component still requires: SAP warns, canon has no
  tolerance master, so a silent over-issue would be an unaudited one.
- **MD04 gains the order**, exactly as a reservation is a requirement element today (§26.882).
- **Both periods judged** — the material period (OMSY/MARV) and the accounting period
  (OB52), as MB1A judges them (§26.889).
- **The drill** — the material document opens the accounting document display, delivered last round
  (§26.896), so a 261 is inspectable from the order, from the document and from the ledger.

**Refused by name, beyond the dropdowns.** The package's blanket "negative inventory is blocked":
canon judges the **storage location's own** `allow_negative_stock` (§26.887), and a rule invented
at the movement would contradict the flag a user maintains. Company-code-level authorisation, as
MB03 and FB03 refused it.

**Deferred by name:** routing and capacity, a real BOM master, order settlement
(`PROD.ORDER.SETTLE`), the finished-goods receipt (`PROD.ORDER.GR`, 101), availability checking
(ATP), batch (CHARG), collective orders, and order-number **external** assignment.

**No writes this stage.** A contract that posted would not be a contract.

Same-stage bookkeeping: B-885 / §26.897 / §30 row 2.715.

## §26.898 — SCR-138 stage 2: the order master stands, one migration

**B-886.** Two tables, no more: `production_order` (the AUFK shape — number, material,
plant, quantity and unit, scheduled start and finish, status, release) and
`production_order_component` (the RESB shape — item, material, plant, storage location,
required quantity, unit). **Migrations 198 → 199.**

What the schema deliberately does **not** carry:

- **A company code.** It stands on the plant, where the issue will read it; a column here
  would be a second copy of a fact that can drift — the MB03 ruling (§26.877), applied to
  an order.
- **A withdrawn quantity.** The next round derives consumption from the material documents
  that name the order, as MBST derives its open quantities (§26.884). A stored counter is a
  number that can disagree with the ledger.
- **A status history.** Two statuses stand — `CREATED` and `RELEASED` — and the release
  records who and when. The audit trail of a posting is the posting; the audit trail of an
  order is its header.

Constraints that earn their place: `status in ('CREATED', 'RELEASED')`, `order_quantity > 0`,
`scheduled_finish >= scheduled_start`, `required_quantity > 0`, the plant as a foreign key,
and a **partial unique index on `(client, request_key)`** so a resubmitted create finds the
order it already made rather than making a second one.

The `PRODORDER` number range the create will draw from has stood in the tenant defaults since
the numbering round — length 12, prefix `PRD` — and has never been drawn. This stage makes it
drawable; the next two draw it.

Migration applied and verified: both tables present in `cairn_b210` (the standing acceptance
database), `199` migration files.

Same-stage bookkeeping: B-886 / §26.898 / §30 row 2.716.

## §26.899 — SCR-138 stage 3: the order service — created, and released apart from created

**B-887.** `createProductionOrder` and `releaseProductionOrder` in
`src/modules/inventory/production-orders.ts`, under `PROD.ORDER.CREATE` and
`PROD.ORDER.RELEASE`. **12/12 service tests.**

The order is drawn from the standing `PRODORDER` range (`PRD` + seven digits) under the
tenant's production-order lock, so two creates cannot draw the same number.

**Every master is judged before the header is drawn.** The produced material must exist,
carry a base unit and not be flagged for deletion; the plant must exist **and carry a
company code** — because the order derives its company from exactly there, and a plant
without one would leave an order that cannot be posted to; the material must be extended
to that plant. Each component repeats the judgement at its own plant, and names its
storage location only if that location stands in the same plant and is active. A refusal
therefore writes nothing at all, not even a number.

**The company code is derived, and the schema proves it**: the test reads
`information_schema` for any company column on `production_order` and finds none, then
reads the view and sees the four-digit code come back from the plant.

**Release is its own act, and a second release is a no-op.** The first records who and
when; a resubmitted release returns the order exactly as the first left it — it neither
fails nor rewrites history. Releasing a number that does not stand refuses in SAP's shape:
`Production order … does not exist.`

**The change history carries both acts**, which meant giving `recordChange` real before/after
snapshots: a CREATE with no field diff would have recorded *nothing* — the platform records
differences, and an order with no "after" has none. This is worth remembering: a module that
calls `recordChange` with only a reason is recording silence.

**Nothing posts.** The test asserts the ledger and the stock are untouched after creating and
releasing: no journal, no material document, zero stock moved. An order is a plan.

Same-stage bookkeeping: B-887 / §26.899 / §30 row 2.717.

## §26.900 — SCR-138 stage 4: the order screen, and the harness learns T838

**B-888.** `/production/orders` — one screen, two sections, two capabilities. The header
asks for the material to be produced, the plant, the quantity and the two scheduled dates;
the component grid is **four stated lines**, entered, never exploded. The company code is
shown but never asked for: it appears in the order card as `data-company-code`, derived from
the plant.

**Create and release sit apart.** The release section appears only once an order stands,
and it is gated on `PROD.ORDER.RELEASE` on its own — a tenant that may create but not
release sees the form and is told why the button is dark. The order card carries
`data-order-number`, `data-status` and `data-item` on each component row, so a browser can
assert what the ledger says without reading the screen's prose.

**T838** (`production-order-create`, `cairn_b210:5432`) joins the harness — **138 targets**.
The run creates an order through the screen, reads the derived company code and the two
components back, releases it, then reads the database independently: one order, two
components, `RELEASED`, **no material document, no journal, no stock moved** — the proof
that a plan is not a posting. It closes with a refusal: plant `QC99` does not exist.

The registry gains `PROD.ORDER.CREATE` as a term (`/production/orders`, alias CO01) so the
launchpad and the term registry can reach it; the capability row itself has stood since the
frozen roadmap was seeded.

Same-stage bookkeeping: B-888 / §26.900 / §30 row 2.718.

## §26.901 — SCR-138 stage 5 and closure: T838 passes, the order stands before the issue

**B-889.** `PROD.ORDER.CREATE` (CO01) is delivered, and the prerequisite the MIGO 261 package
opened with is met. The next round posts 261 against an order that exists, is released, and
carries the components it will consume.

**T838** (`production-order-create`, `cairn_b210:5432`) ran against the production build
(`npx next build --turbopack` → `next start`, exit 0):

1. an order **created through the screen** — `PRD-0000001`, with two components entered as a
   grid and no bill of materials exploded;
2. the **company code derived from the plant** and read back off the order card, never typed;
3. **`CREATED` → `RELEASED`**, the release recorded with who and when, on its own capability;
4. read **independently of the screen**: one order, two components, `RELEASED`, and
   **no material document, no journal, no stock moved** — a plan is not a posting;
5. a refusal in SAP's shape — plant `QC99` does not exist.

**Suite 1931/1931 in 263 files.** Harness **138 targets**. **Migrations 199** (one: 9076).
Registry **166 / 141 / 163** capabilities and terms, with `PROD.ORDER.CREATE` now carrying its
route and alias.

**Two things this stage taught, both recorded because they will bite again.**

- **The keyword-hygiene gate caught the round twice**: a data-dictionary keyword in a comment
  (`AUFK-MATNR`) and four DOM identifiers built from the transaction code. The screen now uses
  `order-create`, `order-release`, `order-summary`, `order-existing`. A transaction code belongs
  in the registry and in prose, never in a selector.
- **A rebuild while `next start` is running can hang the build indefinitely.** The first
  `next build` after the hygiene fix ran past ten minutes without progressing; killing the
  server, clearing `.next` and rebuilding finished in ~75 s. Stop the server before rebuilding,
  not after.

**Deferred by name, unchanged:** TECO and order closure, deletion flags, the finished-goods
receipt (`PROD.ORDER.GR`), settlement (`PROD.ORDER.SETTLE`), availability checking, batch,
collective orders, and external numbering. **Refused by name:** MIGO's A07/R08 dropdowns (each
movement has its own capability in canon) and the package's `production_order_goods_issue`
table (a 261 is a material document plus its journal).

Same-stage bookkeeping: B-889 / §26.901 / §30 row 2.719.

## §26.902 — SCR-139 / MIGO: the screen is one screen, and the matrix is the contract

**B-890.** Owner ruling, 2026-10-20: **MIGO gets complete parity with SAP.** SAP has no
"261 page" — MIGO is one screen where an **action** and a **reference document type** select
a movement, and 261 is one cell of that matrix. SCR-138 stage 1 refused the dropdowns as
furniture; that ruling is **withdrawn** and replaced by this one. A screen whose only value
is the one already delivered teaches the reader that the other values do not exist.

**The frame.** `/inventory/migo`, under a new capability `INV.MIGO.POST`, with two selectors:

| Action | Value | Meaning |
| --- | --- | --- |
| Goods receipt | `A01` | stock arrives |
| Return delivery | `A02` | stock goes back to its source |
| Cancellation | `A03` | the document is cancelled |
| Transfer posting | `A04` | stock moves without leaving the company |
| Goods issue | `A07` | stock leaves, charged to something |

| Reference | Value | Meaning |
| --- | --- | --- |
| Purchase order | `R01` | the receipt's origin is a purchase order |
| Reservation | `R04` | the issue's origin is a reservation |
| Material document | `R05` | the document itself is the reference |
| Order | `R08` | the issue's origin is a production order |

**Every cell resolves to exactly one of three answers, and the screen says which.**

1. **Posts from this screen.** `A07 + R08` — the 261 of this round: components consumed
   from stock against a released order.
2. **Delivered elsewhere, and the screen says where.** Canon already posts these movements
   through their own capabilities, and a second implementation inside MIGO would be a second
   answer to the same question — the ruling this ledger applies everywhere (§26.887, §26.897):
   - `A01 + R01` → the purchase-order goods receipt (`INV.GR.POST`, MB01/MIGO);
   - `A04` → the transfer posting (`INV.TRANSFER.POST`, MB1B) for 311 / 301 / 321;
   - `A03 + R05` → the reversal (`INV.REVERSE`, MBST);
   - `R05` without an action → the material document display (`INV.DISPLAY`, MB03).
   Each of these cells **names its capability and links to it**; none pretends to post here.
3. **Refused by name.** Every remaining cell names the capability that would light it up:
   `A02` return delivery (vendor returns, no returns chain), `A07 + R04` from the MIGO
   screen (delivered as the reservation withdrawal inside MB1A), `A01 + R04`.

**The matrix is data, not markup.** One exported table — action, reference, resolution,
capability, reason — drives the selector, the grid and the refusal text. A round that
delivers a movement adds one row; it does not touch the screen.

**What 261 does, decided here so stages 2–4 do not re-open it.**

- **Consumption lands on a P&L production-consumption account**, not on WIP. Canon has no
  settlement (KO88) and no order completion, so capitalising to WIP would grow a balance
  sheet that nothing can ever relieve. WIP is **deferred by name** until `PROD.ORDER.SETTLE`
  exists. The event is `PRODUCTION_CONSUMPTION`, per valuation class, with `INVENTORY`
  credited — the shape MB1A already uses.
- **Over-issue is refused by name**, quoting what the component still requires. SAP warns;
  canon has no tolerance master, and a silent over-issue is an unaudited one.
- **262 joins the catalogue** so MBST reverses a 261 like any other document; no second
  reversal screen.
- **The order and its component item stand on the material-document line** — a reference,
  never a second ledger.
- **The order becomes a requirement in MD04**, net of what has been issued.
- **Both periods judged**: the material period (OMSY/MARV) and the accounting period (OB52),
  exactly as MB1A judges them.
- **The drill**: the resulting material document opens MB03, and its journal opens FB03 —
  both delivered (§26.896).

**Refused by name:** a second MIGO route per movement, MIGO's own number range (the
`MATDOC` and `RF_BELEG` ranges stand), and company-code-level authorisation.

**Deferred by name:** `A05`–`A09` and every other reference type beyond `R01/R04/R05/R08`,
return delivery, GR blocked stock, and the tolerance master an over-delivery rule would need.

**No writes this stage.**

Same-stage bookkeeping: B-890 / §26.902 / §30 row 2.720.

## §30 · Change log (continued)

| Ver | Date | Change | By |
|---|---|---|---|
| 2.374 | 2026-10-19 | **CAIRN-6 opens; SCR-084 / F-39 contracted (R-132, B-540, §26.556).** `CAIRN-5.md` passed the 360,000-byte rotation trigger (361,576 bytes) and is frozen to pointer edits; this part continues §26 from 26.556 and this log from 2.374 (§0.3 / D-093). F-39 clearing is a real DZ transfer posting (alternative account debits per down payment, ordinary reconciliation credits per invoice), pairwise allocations across multiple items with partial clearing, the allocation-mapping table adopted under composite foreign keys while journal lines stay the balance authority; indicator and document type resolve through configuration. FX conversion, discount/difference postings, drafts, server simulation and clearing reset beyond the standing machinery deferred by name. | Agent |
| 2.375 | 2026-10-19 | **SCR-084 stage 1 published (B-541, §26.557).** The inert F-39 clearing screen: selection criteria, both open-item grids and the pairwise allocation builder rendered empty, posting disabled; i18n keys added. No reads, no writes. | Agent |
| 2.376 | 2026-10-19 | **SCR-084 stage 2 published (B-542, §26.558).** Clearing header + allocation-mapping tables stand (migration 0094, 157 migrations): composite foreign keys link every allocation to its down-payment and invoice journal lines; journal lines remain the balance authority. | Agent |
| 2.377 | 2026-10-19 | **SCR-084 stage 3 published (B-543, §26.559).** Customer down-payment clearing service stands: pairwise allocations judged under lock, DZ transfer journal, mapping rows reconciled to the cleared total; the screen is live. Capability follows in stage 4. | Agent |
| 2.378 | 2026-10-19 | **SCR-084 stage 4 published (B-544, §26.560).** Capability F-39 seeded (117 capabilities / 91 terms / 100 aliases). Tests and browser acceptance follow in stage 5. | Agent |
| 2.379 | 2026-10-19 | **SCR-084 stage 5 published — CLOSED (B-545, §26.561).** Tests 3/3, full suite 1360 green, browser T912 green; customer down-payment clearing stands accepted and the customer advance chain (F-29 → F-39) is complete. Next: T-code F-37 customer down payment request. | Agent |
| 2.380 | 2026-10-19 | **SCR-085 / F-37 contracted (R-133, B-546, §26.562).** Down-payment requests are noted items: no journal, a drawn CUSTDPREQ number, period and document type judged against configuration; special G/L rows gain a target indicator (F→A as tenant configuration); fulfillment is an explicit allocation from F-29 judged under the payment lock, fulfilled amounts derived from ACTIVE links. Closure/reversal workflows, F-47, FX fulfillment and drafts deferred by name. | Agent |
| 2.381 | 2026-10-19 | **SCR-085 stage 1 published (B-547, §26.563).** The inert F-37 request screen: request form and open-requests grid rendered empty, posting disabled; i18n keys added. No reads, no writes. | Agent |
| 2.382 | 2026-10-19 | **SCR-085 stage 2 published (B-548, §26.564).** Request + fulfillment tables stand (migration 0095, 158 migrations) and special G/L rows carry the target indicator; the request record is the document, no journal touched. | Agent |
| 2.383 | 2026-10-19 | **SCR-085 stage 3 published (B-549, §26.565).** Request service stands (noted item, judged period and document type, drawn number), F-29 fulfills requests under its lock with derived amounts, and noted indicators are refused for actual postings; both screens live. Supporting seed follows in stage 4. | Agent |
| 2.384 | 2026-10-19 | **SCR-085 stage 4 published (B-550, §26.566).** Capability F-37 seeded (118 capabilities / 92 terms / 101 aliases); CUSTDPREQ joins the number-range catalogue and tenant defaults; special G/L maintenance carries the request target. Tests and browser acceptance follow in stage 5. | Agent |
| 2.385 | 2026-10-19 | **SCR-085 stage 5 published — CLOSED (B-551, §26.567).** Tests 3/3, full suite 1364 green, browser T911 green; customer down-payment requests stand accepted as noted items fulfilled by F-29. Next: T-code F-47 vendor down payment request. | Agent |
| 2.386 | 2026-10-19 | **SCR-086 / F-47 contracted (R-134, B-552, §26.568).** Vendor down-payment requests mirror R-133 as noted items: drawn VENDDPREQ number, judged period and KA document type, AP request indicators with targets, fulfillment by explicit F-48 allocation under the payment lock; the payment block refuses disbursement (F-48), not the request. Closure/reversal, approvals, PO reference, FX and drafts deferred by name. | Agent |
| 2.387 | 2026-10-19 | **SCR-086 stage 1 published (B-553, §26.569).** The inert F-47 request screen: request form and open-requests grid rendered empty, posting disabled; i18n keys added. No reads, no writes. | Agent |
| 2.388 | 2026-10-19 | **SCR-086 stage 2 published (B-554, §26.570).** Vendor request + fulfillment tables stand (migration 0096, 159 migrations) under composite foreign keys; the AP side reuses the SCR-085 target column. | Agent |
| 2.389 | 2026-10-19 | **SCR-086 stage 3 published (B-555, §26.571).** Vendor request service stands (noted item, VENDDPREQ number, judged period and KA type; payment block not judged at request), F-48 fulfills requests under its lock, and both screens are live. Supporting seed follows in stage 4. | Agent |
| 2.390 | 2026-10-19 | **SCR-086 stage 4 published (B-556, §26.572).** Capability F-47 seeded (119 capabilities / 93 terms / 102 aliases); VENDDPREQ joins the number-range catalogue and tenant defaults. Tests and browser acceptance follow in stage 5. | Agent |
| 2.391 | 2026-10-19 | **SCR-086 stage 5 published — CLOSED (B-557, §26.573).** Tests 3/3, full suite 1368 green, browser T910 green; vendor down-payment requests stand accepted and both advance chains (F-47 → F-48 → F-54, F-37 → F-29 → F-39) are complete. Next: T-code FV50 park a journal entry (FBRA first named in error; it stands implemented). | Agent |
| 2.392 | 2026-10-19 | **SCR-087 / FV50 contracted (R-135, B-558, §26.574).** Parked journals live in staging tables with a drawn PARKDOC number, version-checked edits, a judged save-as-complete gate and atomic posting through the engine, the parked record retained with its posted reference; approval workflow, FX and parallel currencies deferred by name. Standing instruction recorded: completion reports name the next two T-codes in order. | Agent |
| 2.393 | 2026-10-19 | **SCR-087 stage 1 published (B-559, §26.575).** The inert FV50 parking screen: header and line grid with live totals, parked list rendered empty, parking disabled; i18n keys added. No reads, no writes. | Agent |
| 2.394 | 2026-10-19 | **SCR-087 stage 2 published (B-560, §26.576).** Parked-journal staging tables stand (migration 0097, 160 migrations) with version, status and posted-reference checks; no journal table touched. | Agent |
| 2.395 | 2026-10-19 | **SCR-087 stage 3 published (B-561, §26.577).** Parked-journal service stands: version-checked edits, judged save-as-complete, atomic posting through the engine with the posted reference retained; the screen is live. Supporting seed follows in stage 4. | Agent |
| 2.396 | 2026-10-19 | **SCR-087 stage 4 published (B-562, §26.578).** Capability FV50 seeded (120 capabilities / 94 terms / 103 aliases); PARKDOC joins the number-range catalogue and tenant defaults. Tests and browser acceptance follow in stage 5. | Agent |
| 2.397 | 2026-10-19 | **SCR-087 CLOSED (B-563, §26.579).** FV50 accepted at full parity: staged parked documents under PARKDOC numbers, judged save-as-complete, atomic posting through the engine with the posted reference retained, reasoned logical deletion. Targeted 3/3, suite 1372 green, browser T909 green, seed 120/94/103, 160 migrations. | Agent |
| 2.398 | 2026-10-19 | **SCR-088 / FAGLL03 contracted (R-136, B-564, §26.580).** A read-only line-item report over the canonical journal: session-bound tenant, reporting indexes only, server-capped hits with a truncation signal, open/cleared judged from the clearing document on open-item-managed accounts only; ledger, assignment and special-G/L filters declined by name as unstored. | Agent |
| 2.399 | 2026-10-19 | **SCR-088 stage 1 published (B-565, §26.581).** The inert FAGLL03 selection screen and empty grid; i18n keys added. No query stands yet. | Agent |
| 2.400 | 2026-10-19 | **SCR-088 stage 2 published (B-566, §26.582).** Reporting indexes stand on the canonical journal (migration 0098, 161 migrations); no table created. The query follows in stage 3. | Agent |
| 2.401 | 2026-10-19 | **SCR-088 stage 3 published (B-567, §26.583).** The line-item query stands over the canonical journal with judged selection, clearing-based status on open-item accounts, capped truncated results and per-currency subtotals; the screen is live with FB03 drill-through. Seed follows in stage 4. | Agent |
| 2.402 | 2026-10-19 | **SCR-088 stage 4 published (B-568, §26.584).** Capability FAGLL03 seeded (121 capabilities / 95 terms / 104 aliases). Tests and browser acceptance follow in stage 5. | Agent |
| 2.403 | 2026-10-19 | **SCR-088 CLOSED (B-569, §26.585).** FAGLL03 accepted at full parity: read-only canonical-journal report, clearing-judged status, capped truncated results, FB03 drill-through, journal untouched. Targeted 3/3, suite 1376 green, browser T908 green, seed 121/95/104, 161 migrations. | Agent |
| 2.404 | 2026-10-19 | **SCR-089 / FS10N contracted (R-137, B-570, §26.586).** Account balances derive at read time on the SCR-069 precedent — opening from every earlier year, turnover by stored period, closing chained, specials separate, currencies never mixed; the maintained projection declined by name as a standing design. Drill lands on FAGLL03 by period. | Agent |
| 2.405 | 2026-10-19 | **SCR-089 stage 1 published (B-571, §26.587).** The inert FS10N selection screen and annual grid; i18n keys added. No derivation stands yet. | Agent |
| 2.406 | 2026-10-19 | **SCR-089 stage 2 recorded (B-572, §26.588).** Index review: the SCR-088 line index serves the derivation; no migration. Service follows in stage 3. | Agent |
| 2.407 | 2026-10-19 | **SCR-089 stage 3 published (B-573, §26.589).** Balance derivation stands on the SCR-069 precedent, chart and currency judged by name; FAGLL03 gained the posting-period filter its drill needed. Seed follows in stage 4. | Agent |
| 2.408 | 2026-10-19 | **SCR-089 stage 4 published (B-574, §26.590).** Capability FS10N seeded (122 capabilities / 96 terms / 105 aliases). Tests and browser acceptance follow in stage 5. | Agent |
| 2.409 | 2026-10-19 | **SCR-089 CLOSED (B-575, §26.591).** FS10N accepted: derived chained balances, specials apart and drilled by stored period; special-period posting named as a deferred engine gap. Targeted 3/3, suite 1380 green, browser T907 green, seed 122/96/105, 161 migrations. | Agent |
| 2.410 | 2026-10-19 | **SCR-090 / FB03 flow contracted (R-138, B-576, §26.592).** The standing document display is completed to the review standard: composite-key retrieval with the year never derived, full header and line assignments, per-currency totals, reversal/origin/clearing flow with change history, parked documents answered as their own lifecycle. House key divergence (company as attribute) recorded. | Agent |
| 2.411 | 2026-10-19 | **SCR-090 stage 1 published (B-577, §26.593).** The inert FB03 display screen: composite-key lookup, full document sections rendered empty; i18n keys added. No retrieval stands yet. | Agent |
| 2.412 | 2026-10-19 | **SCR-090 stage 2 recorded (B-578, §26.594).** Key verification: the journal primary keys already are the prescribed composite lookup; no redundant index, no migration. Retrieval follows in stage 3. | Agent |
| 2.413 | 2026-10-19 | **SCR-090 stage 3 published (B-579, §26.595).** Composite-key retrieval with flow and change history stands behind the display; FAGLL03 drill repointed. Seed follows in stage 4. | Agent |
| 2.414 | 2026-10-19 | **SCR-090 stage 4 published (B-580, §26.596).** Capability FIN.DOC.FLOW seeded (123 capabilities / 97 terms / 105 aliases). Tests and browser acceptance follow in stage 5. | Agent |
| 2.415 | 2026-10-19 | **SCR-090 CLOSED (B-581, §26.597).** FB03 display accepted at review parity: composite-key retrieval, per-currency totals, reversal/origin/clearing flow with change history, parked answered as parked. Targeted 3/3, suite 1384 green, browser T906 green, seed 123/97/105, 161 migrations. | Agent |
| 2.416 | 2026-10-19 | **SCR-091 / AS01-AS02 contracted (R-139, B-582, §26.598).** Asset foundation laid on canonical pieces: tenant asset-class/area/key configuration with delivered defaults, composite-keyed master, interval assignments with preserved history, per-area depreciation parameters, per-company ASSETNR numbering, atomic similar-asset batches, version-checked change with immutable identity and class. Acquisition, depreciation and retirement follow as their own rounds. | Agent |
| 2.417 | 2026-10-19 | **SCR-091 stage 1 published (B-583, §26.599).** The inert tabbed AS01 form and AS02 list shell; i18n keys added. No reads or writes stand yet. | Agent |
| 2.418 | 2026-10-19 | **SCR-091 stage 2 published (B-584, §26.600).** Asset configuration, master, interval assignments and per-area depreciation parameters stand (migration 0099, 162 migrations) with delivered standard defaults. Service follows in stage 3. | Agent |
| 2.419 | 2026-10-19 | **SCR-091 stage 3 published (B-585, §26.601).** Asset service stands: judged creation with atomic similar batches and sub-numbers, version-checked change, interval-appending assignments, prospective depreciation changes, reasoned deactivation; screens live. Supporting seed follows in stage 4. | Agent |
| 2.420 | 2026-10-19 | **SCR-091 stage 4 published (B-586, §26.602).** Asset capabilities AS01/AS02 seeded (125 capabilities / 99 terms / 107 aliases); ASSETNR joins the range catalogue and tenant defaults. Tests and browser acceptance follow in stage 5. | Agent |
| 2.421 | 2026-10-19 | **SCR-091 CLOSED (B-587, §26.603).** AS01/AS02 accepted: asset foundation laid, judged numbering and batching, version-checked change with interval history, prospective depreciation, reasoned deactivation, zero postings. Targeted 4/4, suite 1389 green, browser T905 green, seed 125/99/107, 162 migrations. | Agent |
| 2.422 | 2026-10-19 | **SCR-092 / ABZON contracted (R-140, B-588, §26.604).** Vendor-less acquisition through the canonical engine: class account determination and transaction types as configuration, an asset value record that is not a second ledger, simulation without side effects, request-key idempotency, and an asset-aware reversal the FB08 path refuses to bypass. | Agent |
| 2.423 | 2026-10-19 | **SCR-092 stage 1 published (B-589, §26.605).** The inert ABZON entry and simulation-preview screen; i18n keys added. No validation or posting stands yet. | Agent |
| 2.424 | 2026-10-19 | **SCR-092 stage 2 published (B-590, §26.606).** Class account determination, transaction types and the asset value record stand (migration 0100, 163 migrations) with delivered defaults. Service follows in stage 3. | Agent |
| 2.425 | 2026-10-19 | **SCR-092 stage 3 published (B-591, §26.607).** Acquisition service stands: shared simulate/post judges, atomic engine posting with the value record, capitalization on first acquisition, asset-aware reversal with the FB08 path guarded; screens live. Supporting seed follows in stage 4. | Agent |
| 2.426 | 2026-10-19 | **SCR-092 stage 4 published (B-592, §26.608).** FIN.ASSET.ACQUIRE capability (126) and the ABZON alias seed; the asset list exposes acquisition. Acceptance follows in stage 5. | Agent |
| 2.427 | 2026-10-19 | **SCR-092 closed (B-593, §26.609).** ABZON vendor-less asset acquisition accepted under R-140: engine-only posting against the class reconciliation account, side-effect-free simulation, idempotent posting, asset-aware reversal with the FB08 path guarded. Suite 1396 green, browser T904 green (T905 re-passed), seed 126 capabilities / 100 terms / 108 aliases, DB 163 migrations. Next: FIN.ASSET.RETIRE (ABAVN), then FIN.ASSET.DEPRECIATE (AFAB). | Agent |
| 2.428 | 2026-10-19 | **SCR-093 contract published (B-594, §26.610, R-141).** ABAVN retirement by scrapping: per-class accum/loss determination, `asset_retirement` value records, unambiguous percent/amount basis on remaining acquisition value, RETIRED lifecycle state, asset-aware reversal. Implementation follows in stage order. | Agent |
| 2.429 | 2026-10-19 | **SCR-093 stage 1 published (B-595, §26.611).** ABAVN retirement shell stands at `/finance/assets/retire` with the scope matrix and the complete-retirement warning; module vocabulary committed, service deferred to stage 3. | Agent |
| 2.430 | 2026-10-19 | **SCR-093 stage 2 published (B-596, §26.612).** Retirement determination columns, RETIRED lifecycle state, RETIREMENT transaction kind and the `asset_retirement` value record stand (migration 0101, 164 total); standard determination wired. Service follows in stage 3. | Agent |
| 2.431 | 2026-10-19 | **SCR-093 stage 3 published (B-597, §26.613).** Retirement service stands: shared simulate/post judges over derived values, atomic engine write-off with the retirement record and RETIRED completion, asset-aware reversal with FB08 guarded; screens live. Supporting seed follows in stage 4. | Agent |
| 2.432 | 2026-10-19 | **SCR-093 stage 4 published (B-598, §26.614).** FIN.ASSET.RETIRE capability (127) and the ABAVN alias seed; the asset list exposes retirement. Acceptance follows in stage 5. | Agent |
| 2.433 | 2026-10-19 | **SCR-093 closed (B-599, §26.615).** ABAVN retirement by scrapping accepted under R-141: derived values, unambiguous percent/amount basis, engine-only write-off with retirement value records, RETIRED completion, asset-aware reversal with FB08 guarded. Suite 1404 green, browser T903 green, seed 127 capabilities / 101 terms / 109 aliases, DB 164 migrations. Next: FIN.ASSET.DEPRECIATE (AFAB), then FIN.ASSET.REPORT (S_ALR_87011990). | Agent |
| 2.434 | 2026-10-19 | **SCR-094 contract published (B-600, §26.616, R-142).** AFAB depreciation run: run header/items as the execution log, `asset_depreciation_posting` as the posted-value record feeding SCR-093 reversals, per-area calculation from standing configuration, planned/repeat/restart types, class expense determination. Implementation follows in stage order. | Agent |
| 2.435 | 2026-10-19 | **SCR-094 stage 1 published (B-601, §26.617).** AFAB depreciation run shell stands at `/finance/assets/depreciate` with the run-type matrix and execution log; module vocabulary committed, service deferred to stage 3. | Agent |
| 2.436 | 2026-10-19 | **SCR-094 stage 2 published (B-602, §26.618).** Run header/items, the posted-depreciation value record and class expense determination stand (migration 0102, 165 total). The run service follows in stage 3. | Agent |
| 2.437 | 2026-10-19 | **SCR-094 stage 3 published (B-603, §26.619).** Depreciation run service stands: shared test/live calculation, whole-run refusal on failed determination, grouped engine posting, posted-value records feeding repeat adjustments and SCR-093 reversals; screens live with run log. Supporting seed follows in stage 4. | Agent |
| 2.438 | 2026-10-19 | **SCR-094 stage 4 published (B-604, §26.620).** FIN.ASSET.DEPRECIATE capability (128) and the AFAB alias seed; the asset list exposes the depreciation run. Acceptance follows in stage 5. | Agent |
| 2.439 | 2026-10-19 | **SCR-094 closed (B-605, §26.621).** AFAB depreciation run accepted under R-142: shared test/live calculation, grouped engine posting, posted-depreciation records feeding repeat adjustments and SCR-093 reversals, restartable failures. Suite 1412 green, browser T902 green, seed 128 capabilities / 102 terms / 110 aliases, DB 165 migrations. Next: FIN.ASSET.REPORT (S_ALR_87011990). | Agent |
| 2.440 | 2026-10-19 | **SCR-095 contract published (B-606, §26.622, R-143).** Asset history sheet as a read-only aggregation over the standing value records: value-date windows, posted-only depreciation by area, per-currency class subtotals, judged ranges, CSV export. Implementation follows in stage order. | Agent |
| 2.441 | 2026-10-19 | **SCR-095 stage 1 published (B-607, §26.623).** Asset history sheet shell stands at `/finance/assets/history` with the selection matrix; module vocabulary committed, service deferred to stage 3. | Agent |
| 2.442 | 2026-10-19 | **SCR-095 stage 2 published (B-608, §26.624).** Report indexes stand (migration 0103, 166 total); no new tables behind the read-only sheet. Aggregation service follows in stage 3. | Agent |
| 2.443 | 2026-10-19 | **SCR-095 stage 3 published (B-609, §26.625).** History aggregation stands: value-date windows over ACTIVE records, posted-only area depreciation, per-currency reconciliation and totals, judged GET sheet with CSV export. Supporting seed follows in stage 4. | Agent |
| 2.444 | 2026-10-19 | **SCR-095 stage 4 published (B-610, §26.626).** FIN.ASSET.REPORT capability (129) and the S_ALR_87011990 alias seed; the asset list exposes the history sheet. Acceptance follows in stage 5. | Agent |
| 2.445 | 2026-10-19 | **SCR-095 stage 5 published (B-611, §26.627).** Five asset-history service tests pass (reconciliation, test/reversal exclusion, pagination, CSV, read-only, isolation); browser target T901 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.446 | 2026-10-19 | **SCR-095 CLOSED (B-612, §26.628).** S_ALR_87011990 asset history sheet accepted: reconciled read-only history, posted-only depreciation, CSV export, drill-down, browser T901 green, suite 1418. Next in order: SCR-096 (FIN.TAX.POST / FB50), then FIN.TAX.REPORT — packages awaited. | Agent |
| 2.447 | 2026-10-19 | **SCR-096 contract published (B-613, §26.629, R-144).** FB50 parity rework of the standing FIN.JOURNAL.POST screen: full header, profit centre and assignment lines, judged posting with request-key idempotency, canonical assignment persistence. UI stage follows. | Agent |
| 2.448 | 2026-10-19 | **SCR-096 stage 1 published (B-614, §26.630).** FB50 screen carries the full header, profit-centre/assignment grid with insert/copy/delete, field errors, live totals and confirmation. Canonical assignment and judged posting follow. | Agent |
| 2.449 | 2026-10-19 | **SCR-096 stage 2 published (B-615, §26.631).** Migration 0104: canonical line assignment, S/H and positive-amount checks, posting-request registry (167 migrations). Judged posting service follows in stage 3. | Agent |
| 2.450 | 2026-10-19 | **SCR-096 stage 3 published (B-616, §26.632).** Judged FB50 posting stands: full master-data validation in the posting transaction, request-key idempotency, assignment carried through engine, parked posting and reversal. Supporting seed and acceptance follow. | Agent |
| 2.451 | 2026-10-19 | **SCR-096 stage 4 published (B-617, §26.633).** Catalogue wording states the FB50 behaviour; document display shows the line assignment. Acceptance follows in stage 5. | Agent |
| 2.452 | 2026-10-19 | **SCR-096 stage 5 published (B-618, §26.634).** Three FB50 service tests pass (balanced posting with assignments, duplicate-safe, refusals atomic, reversal mirrors); browser target T900 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.453 | 2026-10-19 | **SCR-096 CLOSED (B-619, §26.635).** FB50 G/L document entry accepted: judged posting, canonical assignment, duplicate-safe resubmission, browser T900 green, suite 1422. Next in order: SCR-097 (FIN.TAX.REPORT), then FIN.FX.VALUATE — packages awaited. | Agent |
| 2.454 | 2026-10-19 | **SCR-097 contract published (B-620, §26.636, R-145).** S_ALR_87012357 advance tax return: extraction from canonical tax-coded journal lines, derived base labelled as such, test/update isolation with line stamping, optional clearing transfer. UI stage follows. | Agent |
| 2.455 | 2026-10-19 | **SCR-097 stage 1 published (B-621, §26.637).** Tax return vocabulary and selection shell stand; execution-log clarification recorded (test runs logged, never stamping). Schema follows in stage 2. | Agent |
| 2.456 | 2026-10-19 | **SCR-097 stage 2 published (B-622, §26.638).** Tax return run log and line stamp stand (migration 0105, 168 total). Extraction and update service follows in stage 3. | Agent |
| 2.457 | 2026-10-19 | **SCR-097 stage 3 published (B-623, §26.639).** Tax extraction stands: posted tax lines by code, derived base, update stamping with corrected-return re-inclusion, atomic clearing transfer. Supporting seed follows in stage 4. | Agent |
| 2.458 | 2026-10-19 | **SCR-097 stage 4 published (B-624, §26.640).** FIN.TAX.REPORT capability (130) and the S_ALR_87012357 alias seed; the journal list exposes the tax return. Acceptance follows in stage 5. | Agent |
| 2.459 | 2026-10-19 | **SCR-097 stage 5 published (B-625, §26.641).** Four tax-return service tests pass (extraction, stamping lifecycle, clearing transfer, reversal netting); browser target T899 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.460 | 2026-10-19 | **SCR-097 CLOSED (B-626, §26.642).** S_ALR_87012357 advance tax return accepted: posted-fact extraction, derived base, stamping lifecycle, clearing transfer, browser T899 green, suite 1427. Next in order: SCR-098 (FIN.FX.VALUATE / FAGL_FC_VAL), then FIN.GRIR.RECLASS — packages awaited. | Agent |
| 2.461 | 2026-10-19 | **SCR-098 contract published (B-627, §26.643, R-146).** FAGL_FC_VAL valuation: canonical foreign-currency items, standing-rate methods with named missing-rate refusal, signed gain/loss rule via FXGAIN/FXLOSS determination, atomic live posting with reversal. UI stage follows. | Agent |
| 2.462 | 2026-10-19 | **SCR-098 stage 1 published (B-628, §26.644).** FX valuation vocabulary and selection shell stand. Run/item schema follows in stage 2. | Agent |
| 2.463 | 2026-10-19 | **SCR-098 stage 2 published (B-629, §26.645).** Valuation run/item protocol stands (migration 0106, 169 total). Valuation service follows in stage 3. | Agent |
| 2.464 | 2026-10-19 | **SCR-098 stage 3 published (B-630, §26.646).** FX valuation service stands: key-date rates with named missing-rate errors, signed gain/loss posting, duplicate guard, reversal, CSV protocol. Supporting seed follows in stage 4. | Agent |
| 2.465 | 2026-10-19 | **SCR-098 stage 4 published (B-631, §26.647).** FIN.FX.VALUATE capability (131) and the FAGL_FC_VAL alias seed; the journal list exposes the valuation. Acceptance follows in stage 5. | Agent |
| 2.466 | 2026-10-19 | **SCR-098 stage 5 published (B-632, §26.648).** Four FX valuation service tests pass (signed gain/loss, reversal-and-rerun, missing-rate block); browser target T898 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.467 | 2026-10-19 | **SCR-098 CLOSED (B-633, §26.649).** FAGL_FC_VAL FX valuation accepted: key-date rates, signed gain/loss, duplicate guard, reversal-and-rerun, browser T898 green, suite 1432. Next in order: SCR-099 (FIN.GRIR.RECLASS / F.19), then FIN.ACCRUAL.POST — packages awaited. | Agent |
| 2.468 | 2026-10-19 | **SCR-099 contract published (B-634, §26.650, R-147).** F.19 GR/IR analysis: signed canonical PO history, value-and-quantity classification, separate accrual posting against WRX determination with duplicate refusal. UI stage follows. | Agent |
| 2.469 | 2026-10-19 | **SCR-099 stage 1 published (B-635, §26.651).** GR/IR vocabulary and selection shell stand. Run/item schema follows in stage 2. | Agent |
| 2.470 | 2026-10-19 | **SCR-099 stage 2 published (B-636, §26.652).** GR/IR run/item protocol stands (migration 0107, 170 total). Analysis and accrual service follows in stage 3. | Agent |
| 2.471 | 2026-10-19 | **SCR-099 stage 3 published (B-637, §26.653).** GR/IR analysis stands: signed PO history, five-way classification, separate atomic accrual with duplicate refusal, CSV protocol. Supporting seed follows in stage 4. | Agent |
| 2.472 | 2026-10-19 | **SCR-099 stage 4 published (B-638, §26.654).** FIN.GRIR.RECLASS capability (132) and the F.19 alias seed; the journal list exposes the analysis. Acceptance follows in stage 5. | Agent |
| 2.473 | 2026-10-19 | **SCR-099 stage 5 published (B-639, §26.655).** Three GR/IR service tests pass (classification, accrual lifecycle, separation); browser target T897 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.474 | 2026-10-19 | **SCR-099 CLOSED (B-640, §26.656).** F.19 GR/IR analysis accepted: signed PO history, five-way classification, separate atomic accrual, browser T897 green, suite 1436. Next in order: SCR-100 (FIN.ACCRUAL.POST / FBS1), then FIN.CLOSE.COCKPIT — packages awaited. | Agent |
| 2.475 | 2026-10-19 | **SCR-100 contract published (B-641, §26.657, R-148).** FBS1 accrual entry on the judged G/L posting with atomic reversal metadata, F.81 due-reversal processing reconciling through the canonical link. UI stage follows. | Agent |
| 2.476 | 2026-10-19 | **SCR-100 stage 1 published (B-642, §26.658).** Accrual vocabulary and entry/due shell stand. Metadata schema follows in stage 2. | Agent |
| 2.477 | 2026-10-19 | **SCR-100 stage 2 published (B-643, §26.659).** Accrual metadata table stands (migration 0108, 171 total). Posting hook, entry action and F.81 service follow in stage 3. | Agent |
| 2.478 | 2026-10-19 | **SCR-100 stage 3 published (B-644, §26.660).** Accrual posting stands atomic with its metadata; the F.81 due list executes reversals through the canonical workflow with link reconciliation. Supporting seed follows in stage 4. | Agent |
| 2.479 | 2026-10-19 | **SCR-100 stage 4 published (B-645, §26.661).** FIN.ACCRUAL.POST capability (133) and the FBS1/F.81 alias term seed; the journal list exposes accruals. Acceptance follows in stage 5. | Agent |
| 2.480 | 2026-10-19 | **SCR-100 stage 5 published (B-646, §26.662).** Three accrual service tests pass (atomic metadata, due-date lifecycle, exactly-once reversal); browser target T896 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.481 | 2026-10-19 | **SCR-100 CLOSED (B-647, §26.663).** FIN.ACCRUAL.POST accepted: atomic reversal metadata, F.81 due reversal exactly once (suite 1440/1440; browser T896). Next SCR: FIN.CLOSE.COCKPIT; its package is awaited. | Agent |
| 2.482 | 2026-10-19 | **FX valuation re-run correction published (B-648, §26.664).** The duplicate guard excludes reversed runs, so a reversed valuation can be re-run; suite stood 1440/1440 over the change. | Agent |
| 2.483 | 2026-10-19 | **SCR-101 contract approved (B-649, §26.665, R-149).** FIN.CLOSE.COCKPIT: template/instance closing cycles, registered handlers only, gated exactly-once execution, append-only execution and event trails; list completion never locks the period. Stage 1 (vocabulary + workspace shell) follows. | Owner + Agent |
| 2.484 | 2026-10-19 | **SCR-101 stage 1 published (B-650, §26.666).** Close-cockpit vocabulary, closed handler registry and the cycle/task workspace shell stand. Schema follows in stage 2. | Agent |
| 2.485 | 2026-10-19 | **SCR-101 stage 2 published (B-651, §26.667).** Migration 0109 (172 total) stands: templates, lists, instances, dependencies, execution log and event trail, all cycle-scoped. The lifecycle service follows in stage 3. | Agent |
| 2.486 | 2026-10-19 | **SCR-101 stage 3 published (B-652, §26.668).** The cockpit lifecycle stands: gated exactly-once execution through registered handlers, append-only logs, period-neutral finalization; the workspace is wired. Supporting seed follows in stage 4. | Agent |
| 2.487 | 2026-10-19 | **SCR-101 stage 4 published (B-653, §26.669).** FIN.CLOSE.COCKPIT capability (134), CLOCO-family aliases and the MONTH_END template seed; cockpit navigation stands. Acceptance follows in stage 5. | Agent |
| 2.488 | 2026-10-19 | **SCR-101 stage 5 published (B-654, §26.670).** Four cockpit service tests pass (gating, gates, scheduled settlement, reasoned overrides); browser target T895 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.489 | 2026-10-19 | **SCR-101 CLOSED (B-655, §26.671).** FIN.CLOSE.COCKPIT accepted: gated task-list closing cycles over registered handlers (suite 1445/1445; browser T895). Next SCR: FIN.CLOSE.CARRYFORWARD (FAGLGVTR); its package is awaited. | Agent |
| 2.490 | 2026-10-19 | **SCR-102 contract approved (B-656, §26.672, R-150).** FIN.CLOSE.CARRYFORWARD: derived openings recorded per account, P&L closed by a judged transfer document to determined retained earnings, delta-only repeat runs, test-first. Stage 1 (vocabulary + run sheet shell) follows. | Owner + Agent |
| 2.491 | 2026-10-19 | **SCR-102 stage 1 published (B-657, §26.673).** Carryforward vocabulary, the run-sheet shell and the RETAINED_EARNINGS determination event stand. Schema follows in stage 2. | Agent |
| 2.492 | 2026-10-19 | **SCR-102 stage 2 published (B-658, §26.674).** Migration 0110 (173 total) stands: run header and result protocol, repeatable by construction. The execution service follows in stage 3. | Agent |
| 2.493 | 2026-10-19 | **SCR-102 stage 3 published (B-659, §26.675).** The carryforward executes: derived openings recorded, P&L closed by judged transfer documents, delta-only reruns, concurrency-guarded update runs. Supporting seed follows in stage 4. | Agent |
| 2.494 | 2026-10-19 | **SCR-102 stage 4 published (B-660, §26.676).** FIN.CLOSE.CARRYFORWARD capability (135) and the F.16/FAGLGVTR alias term seed; carryforward navigation stands. Acceptance follows in stage 5. | Agent |
| 2.495 | 2026-10-19 | **SCR-102 stage 5 published (B-661, §26.677).** Three carryforward service tests pass (test/update/delta lifecycle, determination exceptions); browser target T894 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.496 | 2026-10-19 | **SCR-102 CLOSED (B-662, §26.678).** FIN.CLOSE.CARRYFORWARD accepted: derived openings, judged P&L closing transfers, delta-only repeats (suite 1449/1449; browser T894). Next SCR: FIN.IC.POST; its package is awaited. | Agent |
| 2.497 | 2026-10-19 | **Intercompany deferred to last (B-663, §26.679).** FIN.IC.POST and FIN.IC.CLEAR (with Intercompany config) marked Deferred after a clean dependency check. Next SCR: FIN.CREDIT.MAINTAIN (FD32); its package is awaited. | Owner + Agent |
| 2.498 | 2026-10-19 | **SCR-103 contract approved (B-664, §26.680, R-151).** FIN.CREDIT.MAINTAIN: per-customer/area credit records with append-only field audit, derived FI-AR exposure, and an explicit never-bypass credit-check evaluation. Stage 1 (vocabulary + credit sheet shell) follows. | Owner + Agent |
| 2.499 | 2026-10-19 | **SCR-103 stage 1 published (B-665, §26.681).** Credit vocabulary and the credit-sheet shell stand. Schema follows in stage 2. | Agent |
| 2.500 | 2026-10-19 | **SCR-103 stage 2 published (B-666, §26.682).** Migration 0111 (174 total) stands: credit vocabularies, the versioned credit record, and the append-only change audit. The credit service follows in stage 3. | Agent |
| 2.501 | 2026-10-19 | **SCR-103 stage 3 published (B-667, §26.683).** The credit service stands: judged saves with field audit and version locking, derived exposure, never-bypass checks; the sheet is wired. Supporting seed follows in stage 4. | Agent |
| 2.502 | 2026-10-19 | **SCR-103 stage 4 published (B-668, §26.684).** FIN.CREDIT.MAINTAIN capability (136), the FD32 alias term and tenant credit vocabularies seed; credit navigation stands. Acceptance follows in stage 5. | Agent |
| 2.503 | 2026-10-19 | **SCR-103 stage 5 published (B-669, §26.685).** Three credit service tests pass (check ladder, judged audited saves, version locking); browser target T893 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.504 | 2026-10-19 | **SCR-103 fix published (B-670, §26.686).** Migration 0112 renames the credit hold flag to is_on_hold, satisfying the FS00 schema-contract guard; credit tests stand green. Browser re-acceptance and closure follow. | Agent |
| 2.505 | 2026-10-19 | **SCR-103 CLOSED (B-671, §26.687).** FIN.CREDIT.MAINTAIN accepted: judged audited credit records, derived exposure, never-bypass checks (suite 1453/1453; browser T893). Next SCR: FIN.CREDIT.MONITOR (F.31); its package is awaited. | Agent |
| 2.506 | 2026-10-19 | **SCR-104 contract approved (B-672, §26.688, R-152).** FIN.CREDIT.MONITOR: read-only exposure overview over SCR-103 records and open AR, index-only migration, snapshot-consistent, unavailable SD components shown explicitly. Stage 1 (vocabulary + monitor shell) follows. | Owner + Agent |
| 2.507 | 2026-10-19 | **SCR-104 stage 1 published (B-673, §26.689).** Monitor vocabulary and the overview shell stand. The index migration follows in stage 2. | Agent |
| 2.508 | 2026-10-19 | **SCR-104 stage 2 published (B-674, §26.690).** Migration 0113 (176 total) stands: credit-area and open-item indexes only. The monitor service follows in stage 3. | Agent |
| 2.509 | 2026-10-19 | **SCR-104 stage 3 published (B-675, §26.691).** The monitor computes snapshot-consistent exposure over records and open AR with judged filters and flagged conversion; the overview is wired. Supporting seed follows in stage 4. | Agent |
| 2.510 | 2026-10-19 | **SCR-104 stage 4 published (B-676, §26.692).** FIN.CREDIT.MONITOR capability (137) and the F.31 alias term seed; monitor navigation stands. Acceptance follows in stage 5. | Agent |
| 2.511 | 2026-10-19 | **SCR-104 stage 5 published (B-677, §26.693).** Three monitor service tests pass (snapshot computation, judged filters, flagged conversion); browser target T892 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.512 | 2026-10-19 | **SCR-104 CLOSED (B-678, §26.694).** FIN.CREDIT.MONITOR accepted: read-only snapshot exposure overview with flagged no-record customers (suite 1457/1457; browser T892). Next SCR: FIN.CREDIT.RELEASE (VKM3); its package is awaited. | Agent |
| 2.513 | 2026-10-19 | **SCR-105 contract approved (B-679, §26.695, R-153).** FIN.CREDIT.RELEASE: credit determinations as the single status store (the package's sanctioned fallback until the SD canon lands), re-evaluating releases, override as a separate privilege, append-only history. Stage 1 (vocabulary + release-queue shell) follows. | Owner + Agent |
| 2.514 | 2026-10-19 | **SCR-105 stage 1 published (B-680, §26.696).** Release-queue vocabulary and the determination queue shell stand. Schema follows in stage 2. | Agent |
| 2.515 | 2026-10-19 | **SCR-105 stage 2 published (B-681, §26.697).** Migration 0114 (177 total) stands: determinations with supersedes chains and the append-only release event trail. The release service follows in stage 3. | Agent |
| 2.516 | 2026-10-19 | **SCR-105 stage 3 published (B-682, §26.698).** Determinations, re-evaluating releases with a separate override privilege, rejects and reblocks stand; the queue is wired. Supporting seed follows in stage 4. | Agent |
| 2.517 | 2026-10-19 | **SCR-105 stage 4 published (B-683, §26.699).** FIN.CREDIT.RELEASE and FIN.CREDIT.OVERRIDE capabilities (139) and the VKM3 alias term seed; release navigation stands. Acceptance follows in stage 5. | Agent |
| 2.518 | 2026-10-19 | **SCR-105 stage 5 published (B-684, §26.700).** Four release service tests pass (determinations, override discipline, reject/recheck/reblock, bulk outcomes); browser target T891 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.519 | 2026-10-19 | **SCR-105 CLOSED (B-685, §26.701).** FIN.CREDIT.RELEASE accepted: determinations as the single credit status, re-evaluating releases, separate override privilege (suite 1462/1462; browser T891). Next SCR: FIN.RPT.TRIALBALANCE (F.01); its package is awaited. | Agent |
| 2.520 | 2026-10-19 | **SCR-106 contract approved (B-686, §26.702, R-154).** FIN.RPT.TRIALBALANCE: the FSV configuration canon arrives with the read-only F.01 statement — dynamic hierarchy, canonical balance semantics, comparatives, explicit unassigned-account warnings. Stage 1 (vocabulary + report shell) follows. | Owner + Agent |
| 2.521 | 2026-10-19 | **SCR-106 stage 1 published (B-687, §26.703).** Statement vocabulary and the F.01 report shell stand. The FSV schema follows in stage 2. | Agent |
| 2.522 | 2026-10-19 | **SCR-106 stage 2 published (B-688, §26.704).** Migration 0115 (178 total) stands: FSV version/nodes/assignments and the journal aggregation index. The statement service follows in stage 3. | Agent |
| 2.523 | 2026-10-19 | **SCR-106 stage 3 published (B-689, §26.705).** The F.01 statement calculates in one snapshot over the resolved FSV with comparatives and explicit warnings; the report is wired. Supporting seed follows in stage 4. | Agent |
| 2.524 | 2026-10-19 | **SCR-106 stage 4 published (B-690, §26.706).** FIN.RPT.TRIALBALANCE capability (140), the F.01 alias term and the standard INT statement version seed; statement navigation stands. Acceptance follows in stage 5. | Agent |
| 2.525 | 2026-10-19 | **SCR-106 stage 5 published (B-691, §26.707).** Four statement service tests pass (derivation, unassigned naming, special periods, comparatives); browser target T890 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.526 | 2026-10-19 | **SCR-106 CLOSED (B-692, §26.708).** FIN.RPT.TRIALBALANCE accepted: read-only F.01 statement derived from the posted journal over the configured FSV (suite 1467/1467; browser T890). Next SCR: FIN.RPT.BALANCESHEET (balance sheet with comparatives); its package is awaited. The SCR after: FIN.RPT.CASHFLOW. | Agent |
| 2.527 | 2026-10-19 | **SCR-107 contract approved (B-693, §26.709, R-155).** FIN.RPT.BALANCESHEET over the SCR-106 FSV canon: three balance calculation types (accumulated / movement / combined with explicit current-year result), summary report level as presentation-only folding, opening-balance column; index duty in stage 2, no new balance tables. Stage 1 (vocabulary + report shell) follows. | Owner + Agent |
| 2.528 | 2026-10-19 | **SCR-107 stage 1 published (B-694, §26.710).** Balance calculation types, summary-level vocabulary and the S_ALR_87012284 report shell stand. The aligned index follows in stage 2. | Agent |
| 2.529 | 2026-10-19 | **SCR-107 stage 2 published (B-695, §26.711).** Index duty verified: the aligned header/line indexes stand (0115/0098); no new migration (178 stands), contract test pins the alignment. The calculation service follows in stage 3. | Agent |
| 2.530 | 2026-10-19 | **SCR-107 stage 3 published (B-696, §26.712).** The three calculation types calculate over one journal snapshot; opening column, summary folding and CSV export stand; the report is wired. Supporting seed follows in stage 4. | Agent |
| 2.531 | 2026-10-19 | **SCR-107 stage 4 published (B-697, §26.713).** FIN.RPT.BALANCESHEET capability (141), the S_ALR_87012284 alias term and statement navigation stand. Acceptance follows in stage 5. | Agent |
| 2.532 | 2026-10-19 | **SCR-107 stage 5 published (B-698, §26.714).** Service tests pass for all three calculation types, folding and judging; browser target T889 registered. Production build and browser acceptance follow before closure. | Agent |
| 2.533 | 2026-10-19 | **SCR-107 CLOSED (B-699, §26.715).** FIN.RPT.BALANCESHEET accepted: three calculation types over the SCR-106 FSV canon with comparatives and presentation-only folding (suite 1475/1475; browser T889). Next SCR: FIN.RPT.CASHFLOW (S_ALR_87012271/72/73); its package is awaited. The SCR after: FIN.RPT.PROFITLOSS. | Agent |
| 2.534 | 2026-10-19 | **SCR-108 contract approved (B-700, §26.716, R-156).** G/L reporting suite booked as enhancements to the standing FS10N/FAGLL03 reports (owner ruling): range balance report with account-group subtotals, line-item assignment/pagination/export; FIN.RPT.CASHFLOW stays Roadmap. Stage 1 (vocabulary + report shells) follows. | Owner + Agent |
| 2.535 | 2026-10-19 | **SCR-108 stage 1 published (B-701, §26.717).** Balance-report vocabulary and the range-report shell stand on the balances screen; line-item pagination vocabulary stands. Index verification follows in stage 2. | Agent |
| 2.536 | 2026-10-19 | **SCR-108 stage 2 published (B-702, §26.718).** Index duty verified (0098 + header/clearing indexes); no new migration (178 stands), contract test pins the paths. The services follow in stage 3. | Agent |
| 2.537 | 2026-10-19 | **SCR-108 stage 3 published (B-703, §26.719).** The range balance report calculates with group subtotals; line items paginate and carry assignment; both reports export CSV. Aliases follow in stage 4. | Agent |
| 2.538 | 2026-10-19 | **SCR-108 stage 4 published (B-704, §26.720).** S_ALR_87012271/72/73 seeded as search aliases on the standing balance/line-item terms. Acceptance follows in stage 5. | Agent |
| 2.539 | 2026-10-19 | **SCR-108 stage 5 published (B-705, §26.721).** Suite service tests pass; browser target T888 registered. Production build and browser acceptance follow before closure. | Agent |
| 2.540 | 2026-10-19 | **SCR-108 CLOSED (B-706, §26.722).** G/L reporting suite accepted over the standing FS10N/FAGLL03 reports (suite 1483/1483; browser T888). Next SCR: FIN.RPT.CASHFLOW (cash-flow statement); its package is awaited. The SCR after: FIN.RPT.PROFITLOSS. | Agent |
| 2.541 | 2026-10-19 | **SCR-109 contract approved (B-707, §26.723, R-157).** G/L reporting suite completion: company-split subtotals, validated output currency, document-date/reference columns, period-context drill-down with return link. Stage 1 (UI) follows. | Owner + Agent |
| 2.542 | 2026-10-19 | **SCR-109 stage 1 published (B-708, §26.724).** Items show document date and reference, the return link stands, the output-currency field stands. Index verification follows in stage 2. | Agent |
| 2.543 | 2026-10-19 | **SCR-109 stage 2 published (B-709, §26.725).** Summary-canon assertions stand (no totals table; indexed date ordering); no new migration. The services follow in stage 3. | Agent |
| 2.544 | 2026-10-19 | **SCR-109 stage 3 published (B-710, §26.726).** Output-currency conversion and company-split subtotals stand; drill-down carries period context. Supporting seed follows in stage 4. | Agent |
| 2.545 | 2026-10-19 | **SCR-109 stage 4 published (B-711, §26.727).** Standing term descriptions describe the delivered suite; catalogue counts unchanged. Acceptance follows in stage 5. | Agent |
| 2.546 | 2026-10-19 | **SCR-109 stage 5 published (B-712, §26.728).** Completion tests pass (conversion, missing-rate warning, document fields); browser target T887 registered. Production build and browser acceptance follow before closure. | Agent |
| 2.547 | 2026-10-19 | **SCR-109 CLOSED (B-713, §26.729).** G/L reporting suite completion accepted (suite 1489/1489; browser T887). Next SCR: FIN.RPT.CASHFLOW (cash-flow statement); its package is awaited. The SCR after: FIN.RPT.PROFITLOSS. | Agent |
| 2.548 | 2026-10-19 | **SCR-110 contract approved (B-714, §26.730, R-158).** FS15 with SAP parity: the company-code G/L segment is built (backfilled, segment-first wiring), then the transfer with test runs and run protocol. Stage 1 (vocabulary + transfer shell) follows. | Owner + Agent |
| 2.549 | 2026-10-19 | **SCR-110 stage 1 published (B-715, §26.731).** Transfer vocabulary and the FS15 shell stand. The segment schema follows in stage 2. | Agent |
| 2.550 | 2026-10-19 | **SCR-110 stage 2 published (B-716, §26.732).** Migration 0116 (179 total): the company-code segment stands backfilled, run/result audit tables stand. The transfer service follows in stage 3. | Agent |
| 2.551 | 2026-10-19 | **SCR-110 stage 3 published (B-717, §26.733).** The transfer executes with protocol; segment-first wiring stands for open-item judgement and posting blocks. Capability and alias follow in stage 4. | Agent |
| 2.552 | 2026-10-19 | **SCR-110 stage 4 published (B-718, §26.734).** CFG.FIN.GLACCOUNT.TRANSFER capability and the FS15 alias term stand (142/115/133). Acceptance follows in stage 5. | Agent |
| 2.553 | 2026-10-19 | **SCR-110 stage 5 published (B-719, §26.735).** FS15 tests pass (protocol-only test runs, create/skip/update, segment-first wiring); browser target T886 registered. Production build and browser acceptance follow before closure. | Agent |
| 2.554 | 2026-10-19 | **SCR-110 CLOSED (B-720, §26.736).** FS15 accepted: company-code segment built and backfilled, transfers with protocol (suite 1494/1494; browser T886). Next SCR: FIN.RPT.CASHFLOW (cash-flow statement); its package is awaited. The SCR after: FIN.RPT.PROFITLOSS. | Agent |
| 2.555 | 2026-10-19 | **Roadmap decision (B-721, §26.737).** S_ALR_87012271/72/73 stand delivered as the G/L suite; a distinct cash-flow statement follows later under its own package. SCR-111 proceeds to FIN.RPT.PROFITLOSS; its package is awaited. | Owner + Agent |
| 2.556 | 2026-10-19 | **SCR-111 contract approved (B-722, §26.738, R-159).** FIN.RPT.PROFITLOSS: P&L-only statement over the SCR-107 canon with range vs year-to-date movements and independent comparatives; S_PL0_86000028 ceded to the P&L term. Stage 1 (vocabulary + shell) follows. | Owner + Agent |
| 2.557 | 2026-10-19 | **SCR-111 stage 1 published (B-723, §26.739).** P&L vocabulary and the profit-loss shell stand. Index verification follows in stage 2. | Agent |
| 2.558 | 2026-10-19 | **SCR-111 stage 2 published (B-724, §26.740).** Index/snapshot verification extended to the P&L statement; no new migration (179 stands). The service follows in stage 3. | Agent |
| 2.559 | 2026-10-19 | **SCR-111 stage 3 published (B-725, §26.741).** The P&L-only statement calculates (filtered, re-rolled, range + year-to-date); the report is wired. Supporting seed follows in stage 4. | Agent |
| 2.560 | 2026-10-19 | **SCR-111 stage 4 published (B-726, §26.742).** FIN.RPT.PROFITLOSS capability (143), the P&L term with S_PL0_86000028 ceded from the balance-sheet term, statement navigation. Acceptance follows in stage 5. | Agent |
| 2.561 | 2026-10-19 | **SCR-111 stage 5 published (B-727, §26.743).** P&L tests pass; browser target T885 registered. Production build and browser acceptance follow before closure. | Agent |
| 2.562 | 2026-10-19 | **SCR-111 CLOSED (B-728, §26.744).** FIN.RPT.PROFITLOSS accepted (suite 1498/1498; browser T885). Next SCR: FIN.RPT.COSTCENTER.ACTUAL (cost centre actual vs plan); its package is awaited. The SCR after: FIN.RPT.PROFITCENTER. | Agent |
| 2.563 | 2026-10-19 | **SCR-112 contract approved (B-729, §26.745, R-160).** FIN.RPT.COSTCENTER.ACTUAL over journal actuals; the missing cost-element plan table is built minimally in stage 2 (entry UI deferred); missing plan is null, never zero. Stage 1 (vocabulary + report shell) follows. | Owner + Agent |
| 2.564 | 2026-10-19 | **SCR-112 stage 1 published (B-730, §26.746).** Actual/plan vocabulary and the cost-centre report shell stand. The plan schema follows in stage 2. | Agent |
| 2.565 | 2026-10-19 | **SCR-112 stage 2 published (B-731, §26.747).** Migration 0117 (180 total): cost_center_plan stands; index contract pins plan and journal paths. The report service follows in stage 3. | Agent |
| 2.566 | 2026-10-19 | **SCR-112 stage 3 published (B-732, §26.748).** The report service aggregates journal actuals against signed plan with null-plan semantics, hierarchy placement and activity plan; the page executes live. Supporting seed follows in stage 4. | Agent |
| 2.567 | 2026-10-19 | **SCR-112 stage 4 published (B-733, §26.749).** FIN.RPT.COSTCENTER.ACTUAL capability, S_ALR_87013611 / S_ALR_87013614 / KSB1N aliases and journal-page navigation stand (144/117/136). Acceptance follows in stage 5. | Agent |
| 2.568 | 2026-10-19 | **SCR-112 stage 5 published (B-734, §26.750).** Three report service tests pass and browser target T884 stands registered; grid rendering completed under B-732. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.569 | 2026-10-19 | **SCR-112 CLOSED (B-735, §26.751).** Full suite 1505/1505, production build green, browser T884 passed. FIN.RPT.COSTCENTER.ACTUAL is Implemented; next is SCR-113 / FIN.RPT.PROFITCENTER. | Agent |
| 2.570 | 2026-10-19 | **SCR-113 contracted (B-736, R-161, §26.752).** KE5Z profit centre actual line items over the journal: ledger `0L` only named, partner profit centre, account groups and KE5Y deferred by name. Stage 1 vocabulary/shell follows. | Agent |
| 2.571 | 2026-10-19 | **SCR-113 stage 1 published (B-737, §26.753).** KE5Z vocabulary and the profit centre line-item shell stand over the inert grid. Index check follows in stage 2. | Agent |
| 2.572 | 2026-10-19 | **SCR-113 stage 2 published (B-738, §26.754).** Migration 0118 (181 total): `jel_profitcenter_idx` stands; the index contract pins the profit-centre path. The line-item service follows in stage 3. | Agent |
| 2.573 | 2026-10-19 | **SCR-113 stage 3 published (B-739, §26.755).** The line-item service reads posted journal lines as recorded, with server-side hit limits, truncation indication, currency-separated totals and document drill-down; the page executes live. Supporting seed follows in stage 4. | Agent |
| 2.574 | 2026-10-19 | **SCR-113 stage 4 published (B-740, §26.756).** FIN.RPT.PROFITCENTER capability, KE5Z alias and journal-page navigation stand (145/118/137). Acceptance follows in stage 5. | Agent |
| 2.575 | 2026-10-19 | **SCR-113 stage 5 published (B-741, §26.757).** Four line-item service tests pass and browser target T883 stands registered; SCR-112 exclusion-leaf resolver gap named as follow-up. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.576 | 2026-10-19 | **SCR-113 CLOSED (B-742, §26.758).** Full suite 1513/1513, production build green, browser T883 passed. FIN.RPT.PROFITCENTER is Implemented; next is FIN.RPT.SUBLEDGER.TIE. | Agent |
| 2.577 | 2026-10-19 | **SCR-114 contracted (B-743, R-162, §26.759).** Owner package F-03 clear G/L account supersedes the announced tie-out scope: FIN.GL.CLEAR manual clearing over open-item-managed accounts, zero-balance only, tolerance differences deferred by name; FIN.RPT.SUBLEDGER.TIE follows after. Stage 1 UI shell follows. | Agent |
| 2.578 | 2026-10-19 | **SCR-114 stage 1 published (B-744, §26.760).** FIN.GL.CLEAR vocabulary and the G/L clearing shell stand over the inert grid. Schema/index check follows in stage 2. | Agent |
| 2.579 | 2026-10-19 | **SCR-114 stage 2 published (B-745, §26.761).** Schema check: clearing canon complete, no migration (181 stand); the schema contract pins lines, flags and index paths. The clearing service follows in stage 3. | Agent |
| 2.580 | 2026-10-19 | **SCR-114 stage 3 published (B-746, §26.762).** The clearing service judges the open-item-managed account, locks and revalidates items, posts the offsetting clearing document through the standing engine and stamps lines atomically; the screen posts live. Supporting seed follows in stage 4. | Agent |
| 2.581 | 2026-10-19 | **SCR-114 stage 4 published (B-747, §26.763).** FIN.GL.CLEAR capability and F-03 alias stand (146/119/138). Acceptance follows in stage 5. | Agent |
| 2.582 | 2026-10-19 | **SCR-114 stage 5 published (B-748, §26.764).** Four clearing service tests pass and browser target T882 stands registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.583 | 2026-10-19 | **SCR-114 CLOSED (B-749, §26.765).** Full suite 1521/1521, production build green, browser T882 passed. FIN.GL.CLEAR is Implemented; next is FIN.RPT.SUBLEDGER.TIE. | Agent |
| 2.584 | 2026-10-19 | **SCR-115 contracted (B-750, R-163, §26.766).** G/L to subledger tie-out per owner research (FS10N balances vs FBL1N/FBL5N subledger totals): reconciliation accounts CUSTOMERS/VENDORS, partnerless lines as exception detail, aliases FAGLB03 + F.03. Stage 1 vocabulary/shell follows. | Agent |
| 2.585 | 2026-10-19 | **SCR-115 stage 1 published (B-751, §26.767).** Tie-out vocabulary and the subledger tie-out shell stand over the inert grid. Index check follows in stage 2. | Agent |
| 2.586 | 2026-10-19 | **SCR-115 stage 2 published (B-752, §26.768).** Index check: tie-out canon complete, no migration (181 stand); the schema contract pins reconciliation types and both journal paths. The tie-out service follows in stage 3. | Agent |
| 2.587 | 2026-10-19 | **SCR-115 stage 3 published (B-753, §26.769).** The tie-out service compares account totals against partner-carrying totals with TIED/EXCEPTION naming, partner rows and misassignment warnings; the page executes live. Supporting seed follows in stage 4. | Agent |
| 2.588 | 2026-10-19 | **SCR-115 stage 4 published (B-754, §26.770).** FIN.RPT.SUBLEDGER.TIE capability, FAGLB03 + F.03 aliases and journal-page navigation stand (147/120/140). Acceptance follows in stage 5. | Agent |
| 2.589 | 2026-10-19 | **SCR-115 stage 5 published (B-755, §26.771).** Four tie-out service tests pass and browser target T881 stands registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.590 | 2026-10-19 | **SCR-115 CLOSED (B-756, §26.772).** Full suite 1529/1529, production build green, browser T881 passed. FIN.RPT.SUBLEDGER.TIE is Implemented; next is FIN.CONSOLIDATE. | Agent |
| 2.591 | 2026-10-19 | **SCR-116 contracted (B-757, R-164, §26.773).** UCWB consolidation workbench as FIN.RPT.CONSOLIDATE: configuration only, journal provider binding, time-dependent unit assignments, dependency-judged task hierarchies, activation gate; execution/UCMON, BW providers and transports deferred by name. Stage 1 workbench shell follows. | Agent |
| 2.592 | 2026-10-19 | **SCR-116 stage 1 published (B-758, §26.774).** UCWB vocabulary and the consolidation workbench shell stand over the inert folders. Schema follows in stage 2. | Agent |
| 2.593 | 2026-10-19 | **SCR-116 stage 2 published (B-759, §26.775).** Migration 0119 (182 total): eleven consolidation configuration tables stand; the schema contract pins keys, FKs and validity checks. The configuration service follows in stage 3. | Agent |
| 2.594 | 2026-10-19 | **SCR-116 stage 3 published (B-760, §26.776).** The configuration service judges dimensions, parents, overlaps, mappings and task references, with mandatory-reason change audit and the activation gate; folder maintenance posts live. Supporting seed follows in stage 4. | Agent |
| 2.595 | 2026-10-19 | **SCR-116 stage 4 published (B-761, §26.777).** FIN.RPT.CONSOLIDATE capability and UCWB alias stand (148/121/141). Acceptance follows in stage 5. | Agent |
| 2.596 | 2026-10-19 | **SCR-116 stage 5 published (B-762, §26.778).** Three workbench service tests pass and browser target T880 stands registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.597 | 2026-10-19 | **SCR-116 CLOSED (B-763, §26.779).** FIN.RPT.CONSOLIDATE (UCWB) accepted: 1536/1536 suite, build green, browser T880 PASSED. Catalogue 148/121/141; migrations 182. Next: FIN.CONSOLIDATE (UCMON / CX20) awaiting its field package; second-next FIN.RPT.CONSOLIDATE.STMT (CX20). | Agent |
| 2.598 | 2026-10-19 | **SCR-117 contracted (B-764, R-165, §26.780).** CX20 consolidation monitor as FIN.CONSOLIDATE: UCWB-derived task order and parent prerequisites, immutable execution history separate from current status, Test/Update modes, duplicate-run guard, and only standing journal collection/validation adapters execute; translation, investment and intercompany processing remain blocked by name. Stage 1 monitor shell follows. | Agent |
| 2.599 | 2026-10-19 | **SCR-117 stage 1 published (B-765, §26.781).** FIN.CONSOLIDATE monitor vocabulary and the CX20 selection/matrix shell stand. Execution schema follows in stage 2. | Agent |
| 2.600 | 2026-10-19 | **SCR-117 stage 2 published (B-766, §26.782).** Migration 0120 (183 total): immutable execution attempts, append-only logs and separate current task status stand, with a duplicate-running guard. The monitor service follows in stage 3. | Agent |
| 2.601 | 2026-10-19 | **SCR-117 stage 3 published (B-767, §26.783).** The CX20 service derives UCWB task order, revalidates mode-specific prerequisites, executes standing journal collection/validation adapters, records blocked unsupported engines, and posts live through separate Test/Update authorities. Supporting seed follows in stage 4. | Agent |
| 2.602 | 2026-10-19 | **SCR-117 stage 4 published (B-768, §26.784).** FIN.CONSOLIDATE capability and CX20/UCMON aliases stand (149/122/143). Acceptance follows in stage 5. | Agent |
| 2.603 | 2026-10-19 | **SCR-117 stage 5 published (B-769, §26.785).** Four CX20 service tests pass and browser target T879 stands registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.604 | 2026-10-19 | **SCR-117 CLOSED (B-770, §26.786).** FIN.CONSOLIDATE (CX20) accepted: 1544/1544 suite, production build green, browser T879 PASSED. Catalogue 149/122/143; migrations 183. Next: FIN.RPT.CONSOLIDATE.STMT (CX20) awaiting its field package; second-next FIN.RPT.CASHFLOW (S_ALR_87012271, B-721). | Agent |
| 2.605 | 2026-10-19 | **SCR-118 contracted (B-771, R-166, §26.787).** Consolidated statements (FIN.RPT.CONSOLIDATE.STMT) at owner discretion on SAP global-parameter parity: ACTIVE area/group/version/year/period, FS-item rows from UCWB group accounts classified by mapped source account types, per-unit and group totals through the mappings, unmapped lines named, CX20 standing shown, pre-elimination aggregation named (translation/intercompany engines deferred). No CX20 alias reuse. Stage 1 shell follows. | Agent |
| 2.606 | 2026-10-19 | **SCR-118 stage 1 published (B-772, §26.788).** FIN.RPT.CONSOLIDATE.STMT vocabulary and the consolidated statements selection/matrix shell stand. Index check follows in stage 2. | Agent |
| 2.607 | 2026-10-19 | **SCR-118 stage 2 published (B-773, §26.789).** Index check: journal, mapping and CX20 status paths carry the read; no migration (183 stand). The statement service follows in stage 3. | Agent |
| 2.608 | 2026-10-19 | **SCR-118 stage 3 published (B-774, §26.790).** The statement service classifies FS items, aggregates mapped journal data per unit with period/comparative columns, names unmapped lines and displays CX20 standing; the page executes live. Supporting seed follows in stage 4. | Agent |
| 2.609 | 2026-10-19 | **SCR-118 stage 4 published (B-775, §26.791).** FIN.RPT.CONSOLIDATE.STMT capability and term stand (150/123/143; no SAP alias). Acceptance follows in stage 5. | Agent |
| 2.610 | 2026-10-19 | **SCR-118 stage 5 published (B-776, §26.792).** Three statement service tests pass and browser target T878 stands registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.611 | 2026-10-19 | **SCR-118 CLOSED (B-777, §26.793).** FIN.RPT.CONSOLIDATE.STMT accepted: 1551/1551 suite, production build green, browser T878 PASSED. Catalogue 150/123/143; migrations 183. Next: FIN.RPT.CASHFLOW (S_ALR_87012271, B-721) awaiting owner direction; second-next the SCR-112 exclusion-leaf resolver repair. | Agent |
| 2.612 | 2026-10-19 | **SCR-119 contracted (B-778, R-167, §26.794).** FIN.RPT.CASHFLOW approved as proposed: Direct + Indirect methods, house-bank cash definition, account-classification derivation from standing configuration, reconciliation check, aliases S_ALR_87012271/72/73. Stage 1 shell follows. | Agent |
| 2.613 | 2026-10-19 | **SCR-119 stage 1 published (B-779, §26.795).** FIN.RPT.CASHFLOW vocabulary (methods, account classes, per-company result types) and the cash-flow selection/statement shell stand over the inert grid; the shell imports vocabulary only. Index check follows in stage 2. | Agent |
| 2.614 | 2026-10-19 | **SCR-119 stage 2 published (B-780, §26.796).** Index check: journal company/year/period and company/account paths plus all four derivation sources carry the read; no migration (183 stand); the schema contract pins indexes, determination sources and the read-only vocabulary (6/6). The derivation service follows in stage 3. | Agent |
| 2.615 | 2026-10-19 | **SCR-119 stage 3 published (B-781, §26.797).** The derivation service classifies every account from standing configuration (house-bank cash, reconciliation, BSX, asset determination, account type), derives Indirect balance movements with the depreciation add-back and Direct offsetting lines, and closes with opening/closing cash and the named reconciliation difference; the page executes live. Supporting seed follows in stage 4. | Agent |
| 2.616 | 2026-10-19 | **SCR-119 stage 4 published (B-782, §26.798).** FIN.RPT.CASHFLOW capability and term stand; S_ALR_87012271/72/73 ceded from the parked G/L balance/line-item terms on the single-owner precedent (151/124/143, seeded twice idempotent). Acceptance follows in stage 5. | Agent |
| 2.617 | 2026-10-19 | **SCR-119 stage 5 published (B-783, §26.799).** Six cash-flow service tests pass (classification derivation, both methods, reconciliation difference, refusals, multi-currency columns, persists nothing) and browser target T877 stands registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.618 | 2026-10-19 | **SCR-119 CLOSED (B-784, §26.800).** FIN.RPT.CASHFLOW accepted: 1564/1564 suite, production build green, browser T877 PASSED. Catalogue 151/124/143; migrations 183. Next: SCR-112 exclusion-leaf resolver repair (S_ALR_87013611); second-next SCR-113 CSV export (KE5Z). | Agent |
| 2.619 | 2026-10-19 | **Walkthrough seed delivered (B-785, §26.801).** Standalone `/home/user/walkthrough-seed.ts` (not in repo, not in build): fresh-install command creates the Meridian (India, INR, April–March V3) tenant with admin login plus complete config/master data and real P2P/AR history so every T-code works with no prior data entry; proven by login + report walk (W103). Vendor-ageing/F110 finding logged as candidate SCR-120 for next round; no app code touched. | Agent |
| 2.620 | 2026-10-19 | **Walkthrough seed shipped in deployment (B-786, §26.802).** `walkthrough-seed.ts` stands in the repo root (baked into the operations image) and `docker-compose.yml` mounts the host copy into the migrate service; exact command `docker compose run --rm migrate npx tsx walkthrough-seed.ts`. Re-proven from repo root (W104); container run not executable in this sandbox. Tooling only. | Agent |
| 2.621 | 2026-10-19 | **SCR-121 contracted (B-787, R-168, §26.803).** OB53 retained earnings definition: per-chart indicator (X standing) to retained earnings account on the standing determination table, new `gl_account` indicator (migration 0121), FS00 enforcement naming OB53, carryforward closing per indicator, package-seeded X so fresh tenants pass. Stage 1 shell follows. | Agent |
| 2.622 | 2026-10-19 | **SCR-121 stage 1 published (B-788, §26.804).** CFG.FIN.RETAINED.DEFINE vocabulary and the OB53 definition grid/maintenance shell stand over the inert rows; the shell imports vocabulary only. Migration 0121 follows in stage 2. | Agent |
| 2.623 | 2026-10-19 | **SCR-121 stage 2 published (B-789, §26.805).** Migration 0121 (184 total): `gl_account.retained_earnings_indicator` stands check-pinned to P&L accounts; the RETAINED_EARNINGS event takes the indicator in its modifier slot (3/3 contract). The definition service follows in stage 3. | Agent |
| 2.624 | 2026-10-19 | **SCR-121 stage 3 published (B-790, §26.806).** OB53 service live (reason judge, EQUITY judge, in-use delete refusal), FS00 forcing rule on screen saves (CREATE/CHANGE), carryforward closes per indicator and refuses naming undetermined P&L accounts; full suite 1570/1570. Package seed and catalogue registration follow in stage 4. | Agent |
| 2.625 | 2026-10-19 | **SCR-121 stage 4 published (B-791, §26.807).** Standard package seeds indicator X on its P&L accounts and the X determination to account 290000; activity, capability and CONFIG_ACTIVITY term `CFG.FIN.RETAINED.DEFINE` registered with alias OB53 — catalogue 152/125/144, full suite 1570/1570. Browser acceptance follows in stage 5. | Agent |
| 2.626 | 2026-10-19 | **SCR-121 CLOSED (B-792, §26.808).** Browser T876 PASSED against the production build (seeded X on the grid, Z defined through the screen, in-use deletion refused, FS00 Q-refusal naming OB53 with the stored account untouched); suite 1571/1571, build green. Catalogue 152/125/144, migrations 184. Next: SCR-120 ageing repair, then SCR-112 exclusion-leaf repair. | Agent |
| 2.627 | 2026-10-20 | **SCR-120 contracted (B-793, R-169, §26.809).** S_ALR_87012085 vendor ageing repair and parity: ageing items restricted to VENDORS reconciliation lines (customer/payment lines excluded), F110 self-stamps its payment lines, due dates from the canonical payment-term service, special G/L toggle, company/vendor ranges, summarization + sort, CSV export; layout variants deferred (no framework); customer mirror S_ALR_87012178 repaired as the same defect. Stage 1 UI follows. | Agent |
| 2.628 | 2026-10-20 | **SCR-120 stage 1 published (B-794, §26.810).** Ageing selection/output shape stands (company range, summarization, sort, special G/L toggle, FB03 drill, clearing-model note) over the standing derivation; SQL/index verification follows in stage 2. | Agent |
| 2.629 | 2026-10-20 | **SCR-120 stage 2 published (B-795, §26.811).** Derivation query plan proven on 90k synthetic lines (index-served throughout, 40 ms); no new index and no migration — count stays 184. Backend rework follows in stage 3. | Agent |
| 2.630 | 2026-10-20 | **SCR-120 stage 3 published (B-796, §26.812).** Shared ageing derivation (reconciliation eligibility, canonical payment-term due dates, special G/L selection), F110 self-stamps its payment lines, customer mirror repaired; suite 1574/1574. Seed refresh and CSV export follow in stage 4. | Agent |
| 2.631 | 2026-10-20 | **SCR-120 stage 4 published (B-797, §26.813).** Vendor ageing CSV export route stands under the standing capability; AP/AR ageing catalogue descriptions refreshed (catalogue unchanged 152/125/144). Browser acceptance follows in stage 5. | Agent |
| 2.632 | 2026-10-20 | **SCR-120 CLOSED (B-798, §26.814).** Browser T931 (reworked) PASSED against the production build: vendor-subledger-only population, payment item netted, customer item excluded, historical clearing standing, special G/L by selection, FB03 drill, CSV export; suite 1574/1574. Layout variants and FX conversion deferred by name; migrations 184, catalogue 152/125/144. Next: SCR-112 exclusion-leaf repair, then SCR-113 KE5Z CSV export. | Agent |
| 2.633 | 2026-10-20 | **SCR-112 repair contracted (B-799, R-170, §26.815).** S_ALR_87013611: the cost-centre report's group resolver resolves I/E leaves sequentially in display order (SCR-042 canon, as the profit-centre resolver already does), plus journal line-item drill-down; element groups, currency conversion, layout variants, actual activity quantities and allocations re-affirmed deferred by name. No schema change. Stage 1 backend follows. | Agent |
| 2.634 | 2026-10-20 | **SCR-112 repair stage 1 published (B-800, §26.816).** Resolver folds I/E leaves in display order (exclusion, re-inclusion and empty-resolution refusal pinned, report suite 4/4, tsc green). Drill-down and browser acceptance follow in stage 2. | Agent |
| 2.635 | 2026-10-20 | **SCR-112 repair CLOSED (B-801, §26.817).** Centre/element drill to journal line items stands; browser T884 (extended) PASSED: exclusion leaf removes CC9002 and its 7,000.00 from the grouped report, drill-through lands; suite 1575/1575, build green. Deferred items re-affirmed by name; migrations 184, catalogue 152/125/144. Next: SCR-113 KE5Z CSV export, then SCR-114 tolerance difference posting. | Agent |
| 2.636 | 2026-10-20 | **SCR-113 export contracted (B-802, R-171, §26.818).** KE5Z: capability-guarded CSV export of exactly the profit-centre line-item selection the screen shows (same hit-limit window, `# TRUNCATED` marker when cut), Export CSV action on the screen; partner profit centre, account groups, KE5Y, sorting/layout, parallel ledgers re-affirmed deferred by name. No schema change. Stage 1 export follows. | Agent |
| 2.637 | 2026-10-20 | **SCR-113 stage 1 published (B-803, §26.819).** CSV builder (with `# TRUNCATED` marker), capability-guarded export route and Export CSV screen action stand; tsc green. Tests and browser acceptance follow in stage 2. | Agent |
| 2.638 | 2026-10-20 | **SCR-113 CLOSED (B-804, §26.820).** KE5Z CSV export accepted: service test pins header/window/truncation marker (5/5), browser T883 (extended) PASSED (Export CSV downloads the shown selection, nothing persisted); suite 1576/1576, build green. Deferred items re-affirmed by name; migrations 184, catalogue 152/125/144. Next: SCR-114 tolerance difference posting (F-03 family). | Agent |
| 2.639 | 2026-10-20 | **SCR-114 tolerance follow-up contracted (B-805, §26.821).** F-03: a within-tolerance selected difference posts as a PAYMENT_DIFFERENCE line of the clearing journal under the default OBA4 group (both limits, smaller binds, judged per side); beyond tolerance or unconfigured refuses by name. Screen judges the live difference against the group limits. Partial/residual and multi-currency clearing re-affirmed deferred by name. No schema change. Stage 1 service follows. | Agent |
| 2.640 | 2026-10-20 | **SCR-114 follow-up stage 1 published (B-806, §26.822).** Clearing service posts a within-tolerance difference as a PAYMENT_DIFFERENCE line of the clearing journal (own-line stamp narrowed to the cleared account); tests 7/7 (no-group, within, beyond), tsc green. Screen and browser acceptance follow in stage 2. | Agent |
| 2.641 | 2026-10-20 | **SCR-114 follow-up CLOSED (B-807, §26.823).** Screen judges the live difference against the default group and names the outcome; **T882 extended PASSED** (balancing pair clears; a 5 difference posts as an unstamped expense line and the items clear); suite 1579/1579, build/tsc green. Partial/residual and multi-currency clearing re-affirmed deferred by name. Migrations 184, catalogue 152/125/144. Next: SCR-114 follow-up — partial and residual clearing (F-03 family). | Agent |
| 2.642 | 2026-10-20 | **SCR-114 advanced clearing contracted (B-808, §26.824).** STANDARD/PARTIAL/RESIDUAL with per-item settlements; partial keeps the original open, residual closes it and creates one reasoned residual item with lineage; cross-currency clearing on clearing-date rates with realized FX to FXGAIN/FXLOSS determinations. Migration 9062: allocations, residual lineage, residual reason master. Cross-currency partial/residual, FX valuation and residual terms inheritance deferred by name. Stage 1 schema follows. | Agent |
| 2.643 | 2026-10-20 | **Advanced clearing stage 1 published (B-809, §26.825).** Migration 9062 adds `gl_clearing_allocation`, `gl_clearing_residual`, `residual_reason` — forced RLS, checks, indexes; contract test 6/6, tsc green; **185 migrations**. Partial service follows. | Agent |
| 2.644 | 2026-10-20 | **Advanced clearing stage 2 published (B-810, §26.826).** Partial clearing: per-item settlements, proportional remaining balances, partial items stay open, allocations written per offset; tests 9/9 including later final clearing and refusals. Residual next. | Agent |
| 2.645 | 2026-10-20 | **Advanced clearing stage 3 published (B-811, §26.827).** Residual clearing closes the original and re-stands one reasoned residual item with lineage; tests 11/11 (generation + reason/no-remainder refusals). Multi-currency next. | Agent |
| 2.646 | 2026-10-20 | **Advanced clearing stage 4 published (B-812, §26.828).** Cross-currency clearing on clearing-date AVERAGE rates: local-currency document at original carrying values, realized difference to FXGAIN/FXLOSS determinations; missing rate and unflagged mixed selection refuse; tests 12/12. Screen and browser acceptance follow. | Agent |
| 2.647 | 2026-10-20 | **SCR-114 advanced clearing CLOSED (B-815, §26.829).** Stage 5: method selector, settlements, residual reason, cross-currency tick, applied/remaining columns; reset lifts allocations as history and residual clearings refuse a plain reset naming the reversal path. **T882 extended PASSED** (partial: 1,000 at 600 leaves 400 open; residual: 500 at 200 re-stands 300 under R01). Service suite 14/14, full suite **1589/1589**, build/tsc green; migrations 185, catalogue 152/125/144. Next: SCR-114 follow-up — residual terms inheritance and cross-currency partial/residual (F-03 family). | Agent |
| 2.648 | 2026-10-20 | **SCR-114 F-03 family follow-up contracted (B-816, §26.830).** Residual terms inheritance as line-level `payment_terms`/`baseline_date` (migration 9063) winning over origin resolution in ageing; cross-currency extended to PARTIAL and RESIDUAL with residuals re-standing in their own currency; optional realized-FX account override validated against the company chart, and an optional spread tolerance refusing a difference beyond its ceiling. Inheritance-log table deliberately not added (change document is the audit). Stage 1 schema follows. | Agent |
| 2.649 | 2026-10-20 | **F-03 family stage 1 published (B-817, §26.831).** Migration 9063 adds line-level `payment_terms`/`baseline_date`; posting engine passes them through; contract test 8/8, tsc green. **186 migrations.** Terms inheritance and ageing next. | Agent |
| 2.650 | 2026-10-20 | **F-03 family stage 2 published (B-818, §26.832).** Residual lines inherit source-invoice terms, baseline and assignment (switches honoured, audited); ageing judges a line's own terms ahead of origin resolution. Clearing 16/16, ageing 5/5. Cross-currency partial/residual next. | Agent |
| 2.651 | 2026-10-20 | **F-03 family stage 3 published (B-819, §26.833).** Cross-currency PARTIAL clears on clearing-date rates with carrying carves; cross-currency RESIDUAL refused by name (a line carries its document currency). Tests 18/18. | Agent |
| 2.652 | 2026-10-20 | **F-03 family stage 4 published (B-820, §26.834).** Realized-FX account override with four validations (chart, identity, company extension, P&L) and an optional spread tolerance refusing beyond its ceiling; both audited. Tests 21/21. Screen and acceptance next. | Agent |
| 2.653 | 2026-10-20 | **SCR-114 F-03 family follow-up CLOSED (B-821, §26.835).** Screen carries inheritance switches (default on) and the FX account / spread tolerance fields; **T882 extended PASSED** (13 legs), the 600 residual line carrying NET30, its baseline and PO-B1. Clearing 21/21, ageing 5/5, contract 8/8, full suite **1599/1599**; migrations 186, catalogue 152/125/144. Next: intercompany FIN.IC.POST / FIN.IC.CLEAR (B-663, last in the queue). | Agent |
| 2.654 | 2026-10-20 | **SCR-122 intercompany contracted (B-822, §26.836).** FB01-parity posting posts a sending and receiving journal atomically through the canon, each balanced by its own OBYA clearing account (pair config overriding the company account); every line stamps the trading partner (new column, migration 9064); currency per company translated at the posting date; OBYA balances clear through the standing FIN.GL.CLEAR. Capabilities FIN.IC.POST and CFG.FIN.IC.DEFINE (OBYA). Partner-document reversal propagation, IC profit elimination and IC invoices deferred by name. Stage 1 schema follows. | Agent |
| 2.655 | 2026-10-20 | **SCR-122 stage 1 published (B-823, §26.837).** Migration 9064: pair config (optional OBYA overrides), document pairing, trading-partner stamp on the line; forced RLS throughout; contract 4/4, tsc green; **187 migrations**. Posting service next. | Agent |
| 2.656 | 2026-10-20 | **SCR-122 stage 2 published (B-824, §26.838).** Atomic pair posting with OBYA clearing lines both sides, trading-partner stamps, rate per company, request-key replay; configuration service validated. Tests 6/6 (incl. F-03 clearing of the OBYA balance and rollback). Screens next. | Agent |
| 2.657 | 2026-10-20 | **SCR-122 intercompany CLOSED (B-827, §26.839).** Screens `/config/intercompany-clearing` (CFG.FIN.IC.DEFINE / OBYA) and `/finance/intercompany` (FIN.IC.POST / FB01); catalogue **154/127/146**. **T920 PASSED** (pair configured, two balanced documents, trading partners stamped, pairing recorded); service 6/6, contract 4/4, target guard 159/159, full suite **1610/1610**; migrations 187. T885 was already taken — target re-keyed to T920 and the displaced profit-loss target re-run green. Clearing queue drained; next entirely new round is SCR-123. | Agent |
| 2.658 | 2026-10-20 | **SCR-123 procurement opened (B-828, §26.840).** ME5A requisition list display contracted: ranges on purchasing group / plant / material / org, requisitioner, dates, account assignment and closed toggle; org derived through the plant assignment; conversion derived from live PO items (OPEN/PARTIAL/CONVERTED); closed = converted or marked; drill to the standing display; hit cap with truncation. Tracking-number filter, display variants and export deferred by name. Index decision is stage 2. | Agent |
| 2.659 | 2026-10-20 | **SCR-123 stage 2 published (B-829, §26.841).** ME5A index decision measured, not assumed: at 60,000 requisition items the list query runs 33–176 ms and the candidate composite index only helps the narrowest shape by ~8 ms while the planner declines it for the medium shape; dominant costs are the top-N sort and the PO aggregate. **Verification-only — no migration 9065**, as the SCR-120 precedent allowed. Harness `scripts/plan-me5a.mts` committed as evidence; migrations remain 187. Service next. | Agent |
| 2.660 | 2026-10-20 | **SCR-123 procurement CLOSED (B-830, §26.842).** ME5A purchase requisition list delivered: `PROC.REQ.LIST` service (9/9), screen `/purchasing/requisition-list` (UI contract 6/6), **T873 PASSED** 6 legs, target guard 160/160, full suite **1626/1626** (232 files). Catalogue **155/128/147**; migrations 187 — the candidate index was measured in stage 2 and declined, so no schema change landed. Closed queue drained; next entirely new round is SCR-124. | Agent |
| 2.661 | 2026-10-20 | **SCR-124 procurement opened (B-831, §26.843).** ME2L purchasing report suite contracted as one capability `PROC.PO.LIST` with four perspectives (vendor/material/PO/material group) and aliases ME2L, ME2M, ME2N, ME2C: ranges on vendor, org, group, plant, material, material group and PO number, document dates, and a scope of selection (all / still to be delivered / still to be invoiced / completed) derived from posted material documents and supplier invoices. Release badge, deletion flag, requisition conversion linkage, drill to the order display. Scope-of-list variants, PO history drill and export deferred by name. Index decision is stage 2. | Agent |
| 2.662 | 2026-10-20 | **SCR-124 stage 2 published (B-832, §26.844).** ME2L index decision measured: at 40,000 order items, 20,000 goods-receipt lines and 12,000 invoice lines the list query answers in 1.4–224 ms and the recommended header index buys 1.2 ms on the fastest shape, 7 % on the medium one and nothing on the broad one, where the item scan and the aggregates dominate. **Verification-only — migration 9065 stays unused.** Harness `scripts/plan-po-list.mts` committed; migrations 187. Service next. | Agent |
| 2.663 | 2026-10-20 | **SCR-124 procurement CLOSED (B-833, §26.845).** ME2L purchasing report suite delivered as one capability `PROC.PO.LIST` with four perspectives and aliases ME2L/ME2M/ME2N/ME2C: derived delivered and invoiced quantities from posted material documents and supplier invoices, four scopes of selection, requisition linkage, release and deletion badges, drill to the order display. Service 8/8, UI contract 8/8, target guard 161/161, **T874 PASSED** 5 legs, full suite **1643/1643** (234 files). Catalogue **156/129/151**; migrations 187 — the recommended index was measured and declined. A stale server on port 3000 cost one failed run; recorded in §26.845. Closed queue drained; next entirely new round is SCR-125. | Agent |
| 2.664 | 2026-10-20 | **SCR-125 inventory opened (B-834, §26.846).** MB51 material document list contracted as `INV.MATERIALDOC.LIST`: ranges on material, plant, storage location, movement type and purchase order, a required posting-date range, document dates, stock type and user; movement type judges the canon key (SAP 101/201/311 stay search aliases), the Q/E special-stock indicators are deferred by name because the canon carries no project or sales-order stock. Rows carry quantities, value, the order cited, the journal document and the document status, with reversed documents listed rather than hidden. Drill to a new read-only material document display (MB03 equivalent) on the same capability. Index decision is stage 2. | Agent |
| 2.665 | 2026-10-20 | **SCR-125 stage 2 published (B-835, §26.847).** MB51 index decision is the first measured yes in three rounds: at 60,000 ledger lines the required posting-date range plus `md_posting_date_idx (client, posting_date)` on the header takes the broad selection from 71.7 ms to 3.0 ms and the plant selection from 36.1 ms to 4.3 ms; the line index the package implies cannot span the two tables and earns nothing anyway. **Migration 9065 taken — 188 migrations.** Harness `scripts/plan-mb51.mts` committed. Service next. | Agent |
| 2.666 | 2026-10-20 | **SCR-125 inventory CLOSED (B-836, §26.848).** MB51 material document list delivered: `INV.MATERIALDOC.LIST` service (7/7), list screen and a new read-only document display (MB03 equivalent) on the same capability, **T875 PASSED** 5 legs, target guard 162/162, full suite **1661/1661** (237 files). Catalogue **157/130/152**; **migrations 188** — migration 9065 (the header posting-date index) taken on measured evidence, the first since SCR-122. Reversed documents stay visible; the Q/E special stocks remain deferred by name. Three defects caught inside the round (index-contract assertion, duplicate i18n key, a display gap the acceptance leg exposed) and one environment trap recorded. Closed queue drained; next entirely new round is SCR-126. | Agent |
| 2.667 | 2026-10-20 | **SCR-126 inventory opened (B-837, §26.849).** MB5B stocks on posting date contracted as a **new** capability `INV.STOCK.POSTINGDATE` — not on the frozen roadmap, and it does not satisfy `INV.STOCK.VIEW` (MMBE), which stays Roadmap. Required material range, plant range and reporting window; the rollforward reads the immutable ledger rather than unwinding the snapshot (deviation recorded), with the snapshot used only as a control that warns on any difference. Reversed documents contribute nothing; zero-stock lines suppressed by default; drill reuses the MB51 list filtered to the row. Batch and valuation type deferred by name. Index decision is stage 2. | Agent |
| 2.668 | 2026-10-20 | **SCR-126 stage 2 published (B-838, §26.850).** MB5B index decision measured and declined: at 40,000 ledger lines the package's line index is never chosen by the planner — `material_document_line_material_idx` already serves the material predicate and the header key the dates — buying 1 ms on the medium arm and 6 ms on a 118 ms broad one. **Verification-only, no migration 9066; migrations stand at 188.** Required material and plant ranges keep the normal shapes at 2–12 ms. Harness `scripts/plan-mb5b.mts` committed. Service next. | Agent |
| 2.669 | 2026-10-20 | **SCR-126 closed (B-839, §26.851).** MB5B delivered as `INV.STOCK.POSTINGDATE` at `/inventory/stock-on-posting-date`: a ledger rollforward of opening, receipts, issues and closing in quantity and value across a required window with required material and plant ranges, stock type defaulting to unrestricted, zero-stock lines suppressed, reversed documents contributing nothing, and the stock master compared as a warning that never adjusts. No migration (188 stand). Suite 1679/1679 / 239 files; T826 passed 7 legs; catalogue 158/131/153. Next T-codes: MB52, then MMBE/ME2K. | Agent |
| 2.670 | 2026-10-20 | **SCR-127 contract settled (B-840, §26.852).** MB52 = new capability `INV.STOCK.WAREHOUSE` at `/inventory/warehouse-stocks`; reads the stock master, not the ledger; does not satisfy `INV.STOCK.VIEW` (MMBE stays Roadmap). Breakdown pivots **stock type** into unrestricted / quality-inspection / blocked plus a fourth **special-other** column so the total is never short. Valuation from `material_valuation` at plant; **no valuation record means unknown value with a warning, never zero**. Scope of List required (ALV / STANDARD, others refused); material/plant/sloc ranges optional as the package states; zero lines suppressed; valuation display defaults on; **batch and valuation type deferred by name, special stock indicator refused by name**. Two drills per row: MB51 movements and MB5B rollforward over the whole recorded window. Index measured at stage 2, not assumed. | Agent |
| 2.671 | 2026-10-20 | **SCR-127 stage 2 published (B-841, §26.853).** MB52 index decision measured at 200,000 stock rows and 50,000 valuations and declined: the planner never selects `(client, plant, storage_location, material_number)` — it walks `stock_quantity_pkey` for material-first shapes and seq-scans plant-first ones, which is right at forty per cent selectivity. Forcing bitmap paths left both arms sequential at 72 ms. **Verification-only, no migration 9067; migrations stand at 188.** Harness `scripts/plan-mb52.mts` committed. Service next. | Agent |
| 2.672 | 2026-10-20 | **SCR-127 closed (B-842, §26.854).** MB52 delivered as `INV.STOCK.WAREHOUSE` at `/inventory/warehouse-stocks`: stock-master snapshot pivoted on stock type (unrestricted / quality / blocked / special-other) and valued at the plant price, unknown rather than zero where no valuation stands, required scope of list, optional ranges, zero suppression, valuation display defaulting on, two drills per row. No migration (188 stand). Suite 1701/1701 / 241 files; T827 passed 8 legs; catalogue 159/132/154. Next T-codes: MMBE, then ME2K. | Agent |
| 2.673 | 2026-10-20 | **SCR-128 contract settled (B-843, §26.855).** MMBE = the frozen-roadmap capability **`INV.STOCK.VIEW`** at `/inventory/stock-overview`, to be flipped to Implemented at closure; no new capability code. Three-level tree (plant → storage location → **stock type**) with every parent total rolled up from the children it shows, so a parent can never disagree with them. Material **required and single**; plant/location ranges and zero display optional; expansion level `PLANT`/`STORAGE_LOCATION` (default), others refused by name. **Batch, in-transit and the one-character special stock indicator each deferred or refused by name** — no batch master, no transit movement, special stock is a named stock type. Quantitative only; value stays in MB52. Three drills per node: MB51, MB5B, MB52. Index is a strict prefix of the existing primary key — measured anyway at stage 2. | Agent |
| 2.674 | 2026-10-20 | **SCR-128 stage 2 published (B-844, §26.856).** MMBE index decision measured and declined: the recommended (client, material, plant, storage_location) is a **strict prefix of `stock_quantity_pkey`**, and where the planner chose it the query ran slower (0.133 ms against 0.052 ms). The primary key answers the only shape MMBE issues because the material is required — there is no plant-first arm to serve. **Verification-only, no migration 9068; migrations stand at 188.** Harness `scripts/plan-mmbe.mts` committed. Service next. | Agent |
| 2.675 | 2026-10-20 | **SCR-128 closed (B-845, §26.857).** MMBE delivered as **`INV.STOCK.VIEW`** at `/inventory/stock-overview`, flipping the oldest frozen-roadmap capability to Implemented: a three-level tree (plant → storage location → stock type) for one required material, every parent folded from the children it shows, zero nodes suppressed, expansion level selectable, three drills per node, quantitative only. No migration (188 stand). Suite 1722/1722 / 243 files; T828 passed 7 legs; catalogue 159/133/155. Next T-codes: ME2K, then MD04. | Agent |
| 2.676 | 2026-10-20 | **SCR-129 contract settled (B-846, §26.858).** ME2K = new capability **`PROC.PO.ACCOUNTASSIGN`** at `/purchasing/orders-by-account-assignment`; not on the roadmap, satisfies none. Canon carries a **multi-line** `purchase_order_assignment` (one item split across cost centres by percentage, each line with its own G/L account) and admits **only `COST_CENTER`** as the item category, so **A/P/F are refused by name** rather than silently ignored. Required scope of list (ALV/STANDARD) and required scope of selection, the latter reusing the SCR-124 delivered/invoiced derivation. Assigned value = item net value times line percentage, rounded at the line, grouped by cost centre with cent-exact totals. Drills to the order display and the cost-centre report. Index measured at stage 2. | Agent |
| 2.677 | 2026-10-20 | **SCR-129 stage 2 published (B-847, §26.859).** ME2K index decision measured at 12,000 assignment rows and **refused for harm**: the recommended cost-centre index was ignored in the narrow arms and, in the broad arm, **turned 45.62 ms into 1,934.41 ms** — a 42x regression from 12,000 nested header lookups. The service drives from the document date instead. **Verification-only, no migration 9069; migrations stand at 188.** Harness `scripts/plan-me2k.mts` committed. Service next. | Agent |
| 2.678 | 2026-10-20 | **SCR-129 closed (B-848, §26.860).** ME2K delivered as `PROC.PO.ACCOUNTASSIGN` at `/purchasing/orders-by-account-assignment`: assignment lines with cost centre, G/L account, distribution percentage and the share of the item net value, rounded at the line and grouped by assigned object with cent-exact totals; required scope of list and scope of selection over the SCR-124 delivered/invoiced derivation; drills to the order and the cost-centre report; A/P/F categories refused by name. Index refused for harm (45.6 ms to 1934 ms), so no migration; 188 stand. Suite 1742/1742 / 245 files; T829 passed 7 legs; catalogue 160/134/156. Next T-codes: MD04, then MB1B. | Agent |
| 2.679 | 2026-10-20 | **SCR-130 contract settled (B-849, §26.861).** MD04 = frozen-roadmap **`PROD.MRP.STOCKREQ`** at `/production/stock-requirements`, flipped at closure. **The package state table `mrp_stock_requirement_element` is declined**: a stored pegging list goes wrong the moment anything posts; the list is computed live. Elements: **stock (MRP-available types only, blocked excluded with a warning), open purchase requisitions net of conversions, open purchase orders net of deliveries, and safety stock as the opening requirement**. Planned/production orders, sales orders and reservations **deferred by name**; excess alerts **deferred by name**; MRP area, the special stock indicator and a simulation version **refused by name**. Receipts precede requirements on the same date; hidden past-due rows still move the balance; DAILY and WEEKLY splits both implemented; exceptions shortage / safety breach / past due. **PR-to-PO conversion deferred by name** — posting belongs to the capability that owns it. Material and plant both required. Index measured at stage 2. | Agent |
| 2.680 | 2026-10-20 | **SCR-130 stage 2 published (B-850, §26.862).** MD04 index decision measured at 36,000 stock rows, 16,000 requisition items and 8,000 order items and declined: the requisition read is **already** served by the shipped `pr_item_material_plant_idx` (0.039 ms) and the candidate matched it within noise; the order read never chose the candidate and ran slower with it. Both ranges that bound the reads are required, so no shape needs a wider index. **Verification-only, no migration 9070; migrations stand at 188.** Harness `scripts/plan-md04.mts` committed. Service next. | Agent |
| 2.681 | 2026-10-20 | **SCR-130 closed (B-851, §26.863).** MD04 delivered as `PROD.MRP.STOCKREQ` at `/production/stock-requirements`, flipping a second frozen-roadmap capability this session: a live projection (the package pegging table declined) of stock, open requisitions net of conversions, open orders net of deliveries and safety stock, one chronological list with a running balance; blocked stock excluded from MRP availability and named; hidden past-due rows still move the balance; daily/weekly split; shortage / safety breach / past due. No migration (188 stand). Suite 1765/1765 / 247 files; T830 passed 7 legs; catalogue 161/135/157. Next T-codes: MB1B, then ME2N. | Agent |
| 2.682 | 2026-10-20 | **SCR-131 stage 1: MB1B contract settled (B-852, §26.864).** `INV.TRANSFER.POST` at `/inventory/transfer-posting`, the frozen-roadmap row at `CAIRN.md` §10 line 895. The package state table `inventory_transfer_posting` is **declined** — a transfer is a two-line material document. Six T156-style movement types (311/312/301/302/321/322) delivered as data with BWART numbers as input aliases only; a transfer writes an ISSUE line and a RECEIPT line, requiring one new `line_direction` column and widening the movement-type direction check to `TRANSFER`. Storage-location, plant and stock-type rules refuse by name; `allow_negative_stock` becomes operational for the issuing side, so the table-level non-negative guard moves into the posting path; 311/321 post no journal, 301 moves value between valuation areas and posts a price difference only where standard price differs; cross-company transfer, batch, special stock and MBST deferred by name. | Agent |
| 2.683 | 2026-10-20 | **SCR-131 stage 2: schema 9066 and the index decision (B-853, §26.865).** `material_document_line.line_direction` (default `RECEIPT`, backfills all history), movement-type direction widened to `TRANSFER`, `stock_quantity_nonnegative_ck` dropped so the posting path can honour `storage_location.allow_negative_stock`. **Migrations 189.** Measured at 72,000 stock rows: issuing row 0.034 ms, plant sum 0.053 ms, extension 0.026 ms, valuation 0.022 ms — all primary keys; the plant-level candidate was unused by the issuing read and slower on the sum (0.063 vs 0.053 ms). **Verification-only, no migration 9067.** Harness `scripts/plan-mb1b.mts`. | Agent |
| 2.684 | 2026-10-20 | **SCR-131 stage 3: transfer service (B-854, §26.866).** `INV.TRANSFER.POST` posts six movement types in three scenarios as two-line documents; movement keys shortened to the 20-character column (`TRANSFER_SLOC`, `TRANSFER_PLANT`, `TRANSFER_STYPE` and their `_REV` counters) with BWART numbers as input aliases. Structure, master data, cross-company, material period and sufficiency each refuse by name; `allow_negative_stock` operational (negative `-5.000` posted where configured). 311/321 write zero value; 301 carries 100 between plants and values 200 at a standard-priced receiver, posting the price difference under document type `WA`. Counter-movement reversal restores both sides and reverses the journal. **16/16 tests.** Catalogue 162/136/158. | Agent |
| 2.685 | 2026-10-20 | **SCR-131 closed (B-855, §26.867).** MB1B delivered as `INV.TRANSFER.POST` at `/inventory/transfer-posting`: a two-line material document for 311 / 301 / 321 with counter movement types 312 / 302 / 322, `allow_negative_stock` made operational (the table guard moved into the posting path), 311/321 valuation-neutral, 301 carrying value between plants and posting a price difference only at a standard-priced receiver (document type `WA`), cross-company / batch / special stock / multi-material / MBST deferred by name. Migration 9066 (line direction, TRANSFER direction, guard dropped); **189 migrations**; no index. Service 16/16, UI 9/9, **T831 9 legs**, suite **1791/1791 / 249 files**, catalogue **162/136/158**. Next T-codes: MBST, then MB21. | Agent |
| 2.686 | 2026-10-20 | **SCR-132 stage 1: MBST contract settled (B-856, §26.868).** `INV.REVERSE` at `/inventory/reversal`, the frozen-roadmap row at `CAIRN.md` §10 line 897. The package state table is **declined** — cancellation (XSTBW) is the existing document status, and `reversal_of` / `reversed_by` already bind the pair. Partial reversal is **by whole line** (a line selection, never part of a line), so migration 9067 widens the status check to `PARTIALLY_REVERSED` and the duplicate guard reads the per-line reversed quantity. The engine inverts each line\u2019s direction and posts the counter movement type; stock and value follow the inverted sides; order open quantities are **restored by derivation**, not written back; the invoice dependency and the reason code are refused by name. | Agent |
| 2.687 | 2026-10-20 | **SCR-132 stage 2: schema 9067 and 9068 (B-857, §26.869).** Status check widened to `PARTIALLY_REVERSED`; and the first index taken in three rounds — `mdl_reversal_of_idx (client, reversal_of_document)` — because the per-line reversed-quantity read cost a 10.093 ms sequential scan at 60,000 lines and answers in **0.049 ms** with it. Header and line reads stay primary keys (0.033 / 0.027 ms). **Migrations 191.** Harness `scripts/plan-mbst.mts`. | Agent |
| 2.688 | 2026-10-20 | **SCR-132 stage 3: MBST engine (B-858, §26.870).** `INV.REVERSE` reverses any material document by mirroring each line inverted under the counter movement type; cancellation is computed from per-line coverage, so a document stands `PARTIALLY_REVERSED` until every line is covered. Two schema facts the tests found: the status column was ten characters wide (9069) and 0073\u2019s reversal-link check did not admit the partial state (9070). **Migrations 192.** Journal reversed, order open quantity restored by derivation, reason code refused by name. **9/9 tests.** Catalogue 163/137/159. | Agent |
| 2.689 | 2026-10-20 | **SCR-132 closed (B-859, §26.871).** MBST delivered as `INV.REVERSE` at `/inventory/reversal`: any material document mirrored line by line under its counter movement type, whole document or whole lines, cancellation computed from per-line coverage (`PARTIALLY_REVERSED` between `POSTED` and `REVERSED`), journal and valuation returned, order open quantity restored by derivation, reason code refused by name. Migrations 9067-9070 (**193 stand**) including the measured `mdl_reversal_of_idx` (10.093 → 0.049 ms). Engine 9/9, UI 9/9, **T832 9 legs**, suite **1810/1810 / 251 files**, catalogue **163/137/159**. Build runs on turbopack inside the 2 GB box. Next T-codes: MB21, then MB03. | Agent |
| 2.690 | 2026-10-20 | **SCR-133 stage 1: MB21 contract settled (B-860, §26.872).** `INV.RESERVATION.CREATE` at `/inventory/reservations`, the frozen-roadmap row at `CAIRN.md` §10 line 903. The package\u2019s RKPF/RESB shapes are **taken** — a reservation is genuine new state — with the plant on the item (SAP parity, and the package\u2019s own schema agrees), company code derived from the plant, and number range `RESERV`. The movement catalogue gains a fourth direction `ISSUE` and an **account-assignment category per movement type**; 201 (cost centre) is delivered end to end, **261 refuses by name** because no order master exists. A reservation posts nothing, so no posting period judges it — recorded. **MD04 gains a `RESERVATION` requirement element**, closing the deferral SCR-130 left; withdrawal tracking ships as a tested hook with the MB1A wiring deferred by name. | Agent |
| 2.691 | 2026-10-20 | **SCR-133 stage 2: reservations schema (B-861, §26.873).** 9071 creates `reservation_header` / `reservation_item` and teaches the movement catalogue `ISSUE` plus an `account_assignment` column; number range `RESERV` added. 9072 takes `ri_plant_material_idx` on measurement — MD04\u2019s open-reservation read **9.418 → 0.114 ms** at 60,000 items; the screen read is the primary key (0.044 ms). **Migrations 195.** | Agent |
| 2.692 | 2026-10-20 | **SCR-133 stage 3: reservation service and the MD04 element (B-862, §26.874).** `INV.RESERVATION.CREATE` writes the numbered header and its items after judging every item and the cost centre; withdrawals complete items and refuse over-draw, completed and forbidden ones; **MD04 answers with a `RESERVATION` requirement** at the required date for OPEN = required \u2212 withdrawn, closing SCR-130\u2019s deferral. 9073 widens the number columns to hold what the numbering engine renders. **Migrations 196.** **11/11 tests**; MD04\u2019s 22 stay green. Catalogue 164/138/160. | Agent |
| 2.693 | 2026-10-20 | **SCR-133 stage 4: the reservation screen (B-863, §26.875).** `/inventory/reservations` — lookup, create form (201/261, required date, cost centre, three item lines, company code from the plant), items with required/withdrawn/open and per-item withdrawal and completion; MD04 learned the **Reservation** label. **8/8 UI-contract tests**; harness contract green at **133 targets** (T833). | Agent |
| 2.694 | 2026-10-20 | **SCR-133 stage 5 and closure: T833 passes, MB21 delivered (B-864, §26.876).** Nine legs: create (201, 25 at 2026-11-20, cost centre), item open 25, **MD04 demands 25**, withdraw 10 → 15 open, MD04 demands 15, withdraw 15 → completed, **MD04 demand gone**, 261 refused by name. `data-completed` moved onto the item row. **Suite 1830/1830 in 253 files**; `INV.RESERVATION.CREATE` **Implemented**; catalogue 164/138/160; migrations 196. | Agent |
| 2.695 | 2026-10-20 | **SCR-134 / MB03 stage 1: display contract (B-865, §26.877).** The SCR-125 display is **reworked** into MB03 and re-gated on its own `INV.DISPLAY`; the package\u2019s `[tenant, company, mblnr, mjahr]` key is refused in canon\u2019s favour (the header carries no company code; the number is tenant-unique, so the year is a **cross-check**); optional item filter; poster and entry time, material description, stock type, direction, value, PO reference and reversal pair added; F4/search-help **deferred**, FB03 drill **deferred** (`FIN.JOURNAL.DISPLAY` still Roadmap), RSNUM **deferred** (no posting path), plant-level authorisation and period checks **refused by name**. No tables. | Agent |
| 2.696 | 2026-10-20 | **SCR-134 stage 2: the package\u2019s index is refused, measured (B-866, §26.878).** 5,000 documents / 15,000 lines: every display read is already 0.02\u20130.04 ms on the primary keys; the year-leading candidate measured **0.055 ms against 0.020 ms**, i.e. 2.7\u00d7 slower on the very read it was proposed for. **No migration; migrations stay 196.** | Agent |
| 2.697 | 2026-10-20 | **SCR-134 stage 3: display service (B-867, §26.879).** `INV.DISPLAY` reads one document — header with **poster and entry time**, lines with movement and material descriptions, direction, value, PO reference and reversal pair, **company code derived from the plants**; the year is a **cross-check**, the item a narrowing, the not-found message in the SAP shape. Catalogue **165/139/161**. **10/10 tests.** | Agent |\nshot over the resolved FSV with comparatives and explicit warnings; the report is wired. Supporting seed follows in stage 4. | Agent |
| 2.698 | 2026-10-20 | **SCR-134 stage 4: the display screen re-gated and reworked (B-868, §26.880).** `/inventory/material-documents` carries **INV.DISPLAY**; lookup with required number, year cross-check and optional item; header names the **poster and entry time** and the **derived company codes**; the grid carries movement and material descriptions, direction, value, PO reference and reversal pair; the journal shows as text **with its reason**. **18/18** contract tests; harness **134 targets** (T834). | Agent |\n| 2.524 | 2026-10-19 | **SCR-106 stage 4 published (B-690, §26.706).** FIN.RPT.TRIALBALANCE capability (140), the F.01 alias term and the standard INT statement version seed; statement navigation stands. Acceptance follows in stage 5. | Agent |
| 2.699 | 2026-10-20 | **SCR-134 stage 5 and closure: T834 passes, MB03 delivered (B-869, §26.881).** Eight legs: open by number and year, poster named, **company code derived**, descriptions resolved, item narrowing, wrong year refused, wrong number refused in the SAP shape, wrong item refused naming the items it carries, and a **reversed closed-year document shown as posted**. **Suite 1851/1851 in 255 files**; `INV.DISPLAY` **Implemented**; catalogue 165/139/161; **migrations 196 (no index added)**. | Agent |\n| 2.525 | 2026-10-19 | **SCR-106 stage 5 published (B-691, §26.707).** Four statement service tests pass (derivation, unassigned naming, special periods, comparatives); browser target T890 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.700 | 2026-10-20 | **SCR-135 / MB90 stage 1: the output contract (B-870, §26.882).** Two NAST-shaped tables — `output_type` (catalogue **and** condition) and `output_message` (queue and log); the package\u2019s concatenated `object_key` **refused** for three foreign-keyed columns, its `accountingHeader` company code **refused** for a code derived from the plants; named states with SAP\u2019s digits as aliases (`PENDING`/`PROCESSED`/`ERROR`, `PRINT`/`EMAIL`, `IMMEDIATE`/`PERIODIC`), **FAX and EDI refused by name**; WE01 and WA01 delivered; determination at posting **and** a run that fills what stands missing; print renders and records, **spool and transport deferred**; an EMAIL with no recipient **fails for real** and is retried after a recipient is set. | Agent |\n2.564 | 2026-10-19 | **SCR-112 stage 1 published (B-730, §26.746).** Actual/plan vocabulary and the cost-centre report shell stand. The plan schema follows in stage 2. | Agent |
| 2.701 | 2026-10-20 | **SCR-135 stage 2: two tables and the queue index, measured (B-871, §26.883).** 9074 creates `output_type` (catalogue **and** condition) and `output_message` (queue and log) with a real foreign key to the document and **no company code**; over 40,000 messages the package\u2019s `(status, output_type)` index was **never chosen by the planner** while `(client, status, created_at)` took the grid from **9.650 to 0.085 ms** and the periodic run from **6.197 to 0.394 ms** — 9075 takes it. **Migrations 197.** | Agent |\n| 2.565 | 2026-10-19 | **SCR-112 stage 2 published (B-731, §26.747).** Migration 0117 (180 total): cost_center_plan stands; index contract pins plan and journal paths. The report service follows in stage 3. | Agent |
| 2.702 | 2026-10-20 | **SCR-135 stage 3: the output engine and its posting hook (B-872, §26.884).** Determination runs **inside all three posting transactions** (goods receipt, transfer and its counter, reversal); a receipt earns **WE01** and dispatches immediately, an issue earns **WA01** at the periodic cadence, a **transfer earns neither** (it both receipts and issues). The run fills history idempotently; dispatch renders the slip and records the attempt; an EMAIL fails without a recipient and succeeds after one. Catalogue **166/140/162**. **11/11 tests**; posting suites **27/27**. | Agent |\nshot over the resolved FSV with comparatives and explicit warnings; the report is wired. Supporting seed follows in stage 4. | Agent |
| 2.703 | 2026-10-20 | **SCR-135 stage 4: the output screen (B-873, §26.885).** `/inventory/material-document-output` — the full selection, a **run** that determines and dispatches, the queue with SAP\u2019s digits as aliases only, per-row **dispatch, recipient and slip preview**; failures state their reason in the row; action messages stand outside the conditional blocks. **9/9 UI-contract tests**; harness **135 targets** (T835). | Agent |\n| 2.524 | 2026-10-19 | **SCR-106 stage 4 published (B-690, §26.706).** FIN.RPT.TRIALBALANCE capability (140), the F.01 alias term and the standard INT statement version seed; statement navigation stands. Acceptance follows in stage 5. | Agent |
| 2.704 | 2026-10-20 | **SCR-135 stage 5 and closure: T835 passes, MB90 delivered (B-874, §26.886).** Six legs: the screen opens, the run determines and dispatches, `4900000901` carries **WE01 PROCESSED with one send**, the **slip preview** renders the document, an **EMAIL fails for want of a recipient with its reason in the row**, a recipient is set and the retry **processes with the send counted**. **Suite 1872/1872 in 257 files**; `INV.MATERIALDOC.RECEIVEPRINT` **Implemented**; catalogue 166/140/162; migrations 198. | Agent |\n| 2.525 | 2026-10-19 | **SCR-106 stage 5 published (B-691, §26.707).** Four statement service tests pass (derivation, unassigned naming, special periods, comparatives); browser target T890 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.705 | 2026-10-20 | **SCR-136 / MB1A stage 1: the goods issue contract (B-875, §26.887).** The package\u2019s `goods_issue_posting` table **refused**: a goods issue is a **material document** in canon\u2019s one ledger, and a parallel table would give two answers to "what moved" — **no table added**. **201** (cost centre) and **551** (scrapping) delivered, **261 refused by name** (no order master), counter movements **202/552 in the catalogue** so **MBST** reverses a goods issue; issue valued at the material\u2019s own price, journal credits **INVENTORY** and debits **CONSUMPTION** (with the cost centre on the line) or **SCRAP**; the **reservation hook is wired** (MB21\u2019s deferral closed, MD04 demand falls in the same commit); location stock judged on `allow_negative_stock`; **material and accounting periods both judged**; batch deferred and a batch refused if entered. | Agent |\n seed; statement navigation stands. Acceptance follows in stage 5. | Agent |
| 2.706 | 2026-10-20 | **SCR-136 stage 2: no table and no index, measured (B-876, §26.888).** Four reads over 20,000 materials, 80,000 balances, 20,000 valuations and 20,000 reservations all land on standing unique keys at **0.027\u20130.034 ms**. **No migration; migrations stay 198.** | Agent |\n| 2.525 | 2026-10-19 | **SCR-106 stage 5 published (B-691, §26.707).** Four statement service tests pass (derivation, unassigned naming, special periods, comparatives); browser target T890 registered. Full suite, rebuild and browser acceptance follow before closure. | Agent |
| 2.707 | 2026-10-20 | **SCR-136 stage 3: goods issue service (B-877, §26.889).** One transaction carries the journal, the material document, the stock, the valuation, the **reservation withdrawal** and the output. 201 and 551 with counters 202/552 in the catalogue so **MBST** reverses; **261 refused by name**; INVENTORY credited, CONSUMPTION (cost centre on the line) or SCRAP debited; stock judged on `allow_negative_stock`; **material and accounting periods judged**; batch refused. Catalogue **166/141/163**. **14/14 tests**, including MD04 demand falling 8\u21925 in the same posting and a failed post leaving stock untouched. | Agent |\n
| 2.708 | 2026-10-20 | **SCR-136 stage 4: the goods issue screen (B-878, §26.890).** `/inventory/goods-issue` — movement with both dates and text, four lines with material, plant, location, quantity, **cost centre (disabled where the movement charges none)** and a reservation with its item; the result shows the document, journal, value and **what still stands open on the reservation**. **8/8 UI-contract tests**; harness **136 targets** (T836). | Agent |\n### §26.881 addendum — a label that shipped in the working tree but not in a commit
| 2.709 | 2026-10-20 | **SCR-136 stage 5 and closure: T836 passes, MB1A delivered (B-879, §26.891).** Six legs: post a 201 of 10 (document, journal, value named), **stock 100\u219290 read back from the database**, a reservation for 8 demanded by **MD04**, an issue of 3 against it leaving **5.000 open**, **MD04 demanding the five that remain**. **Suite 1895/1895 in 259 files**; `INV.GI.POST` **Implemented**; catalogue 166/141/163; **migrations 198 (no table, no index — measured)**. | Agent |\n
| 2.710 | 2026-10-20 | **SCR-137 / FB03 stage 1: the universal drill-down anchor (B-880, §26.892).** The SCR-090 display is **re-gated**: base on **`FIN.JOURNAL.DISPLAY`**, flow panel keeps **`FIN.DOC.FLOW`** — two questions, two capabilities. The package\u2019s required company code becomes a **cross-check** (the number and year identify; a disagreement refuses as `Document \u2026 does not exist in company code \u2026`) because the anchors must not be broken to duplicate a fact. **KOART derived**: S by default, D/K from `supplier_company_code` / `customer_company_code` where the line names a partner; **A and M refused by name** (no asset number, material is an assignment). The journal number on MB03, the goods issue and the list **become links** — §26.877\u2019s deferral closes. Tax-detail jump and F4 deferred; company-code authorisation and period checks refused. | Agent |\n**B-869 (correction).** The MD04 label for the new `RESERVATION` element
| 2.711 | 2026-10-20 | **SCR-137 stage 2: the package\u2019s index refused, measured (B-881, §26.893).** Over 40,000 documents / 160,000 lines the three reads stand at **0.032\u20130.037 ms on the primary keys**; the company-leading candidate left two unchanged and made the company-checked read **0.033 \u2192 0.052 ms**. **No migration; migrations stay 198.** | Agent |\n(`md04.reservationElement` and its use in `StockRequirementsShell`) and the two
| 2.712 | 2026-10-20 | **SCR-137 stage 3: the display refuses the wrong company and derives KOART (B-882, §26.894).** `DocumentLookup` grows **`COMPANY_MISMATCH`** — the header is found by number and year, and a disagreeing company is refused in SAP's words instead of collapsing into "not found"; every line carries **`accountType`** (`S` default, `D` for a supplier of the company, `K` for a customer) derived from two equality reads against the role masters, never stored. No writes, no period check. **Tests 8/8 new, 3/3 reworked**; the whole-program `tsc` gate **could not run** in this container (heap exhaustion) and a scoped `tsc -p` over the touched graph is clean. | Agent |
| 2.713 | 2026-10-20 | **SCR-137 stage 4: the display splits its capabilities and the anchors become real (B-883, §26.895).** Base gated on **`FIN.JOURNAL.DISPLAY`**, flow panel kept on **`FIN.DOC.FLOW`**; the company code is an optional cross-check; **`data-account-type`** on every line; the journal list, **MB03** and the **goods issue result** now link here, and the stale `mdDoc.journalDeferred` note is deleted. **Harness 137 targets** (T837). Tests: UI contract 7 new, MB03 contract reworked, 202 green across the touched files. | Agent |
| 2.714 | 2026-10-20 | **SCR-137 stage 5 and closure: T837 passes, FB03 delivered (B-884, §26.896).** Eight legs on the production build: number and year alone, **S/D/K in one document**, a disagreeing company refused in SAP's words with no header, the flow panel beside it, **nothing written**, and the **journal list**, **MB03** and the **goods issue result** each followed to the display. **Suite 1911/1911 in 261 files**; harness **137 targets**; registry unchanged 166/141/163; **migrations 198**. | Agent |
| 2.715 | 2026-10-20 | **SCR-138 / CO01 contracted — the order before the issue (B-885, §26.897).** The MIGO 261 package opens with its own prerequisite and is right: **261 cannot post against an order master that does not exist**, so this round builds **`PROD.ORDER.CREATE`** and the next posts 261 against it. The package\u2019s `production_order_goods_issue` table **refused by name** — a 261 is a material document plus its journal, the order a reference on the line (§26.887\u2019s ruling, applied again). **A07/R08 refused**; the package\u2019s columns mapped onto canon\u2019s tables. The order is a header on the standing **`PRODORDER`** range plus a **declared component snapshot** (no BOM master in canon), company derived from the plant, **CREATED \u2192 RELEASED**. The next round inherits the movement types, the `PRODUCTION_ORDER` reference category, `PRODUCTION_CONSUMPTION`, derived withdrawals, over-issue refusal, MD04 demand and both periods \u2014 all decided here. | Agent |
| 2.716 | 2026-10-20 | **SCR-138 stage 2: the order master stands (B-886, §26.898).** Migration **9076** adds `production_order` (AUFK) and `production_order_component` (RESB) — **198 \u2192 199 migrations**. No company code (derived from the plant), **no stored withdrawn quantity** (derived from the documents), no status history: two statuses, `CREATED` and `RELEASED`, with the release named. Checks on status, quantity and dates; a partial unique index on `(client, request_key)` so a resubmitted create cannot make a second order. Applied and verified in `cairn_b210`. | Agent |
| 2.717 | 2026-10-20 | **SCR-138 stage 3: the order service (B-887, §26.899).** Create draws the standing **`PRODORDER`** range under the tenant lock and judges every master before the header is drawn — material, plant **with its company code**, plant extension, each component and its storage location — so a refusal writes nothing. **`releaseProductionOrder`** records who and when, and a second release is a no-op. **12/12 service tests**, including: no company column exists (it is derived), nothing posts, and both acts appear in `change_document` — which required real before/after snapshots, since `recordChange` records differences and was silently recording nothing. | Agent |
| 2.718 | 2026-10-20 | **SCR-138 stage 4: the order screen and T838 (B-888, §26.900).** `/production/orders` creates and releases under two capabilities; the company code is shown as derived and never asked for; the component grid is four stated lines. **Harness 138 targets** (T838), whose run creates an order, releases it, and reads the database back to prove **no document, no journal and no stock moved**. Registry gains `PROD.ORDER.CREATE` (alias CO01). **7/7 UI-contract tests**, 194 green across the touched files. | Agent |
| 2.719 | 2026-10-20 | **SCR-138 stage 5 and closure: T838 passes, CO01 delivered (B-889, §26.901).** Five legs on the production build: an order created through the screen on **`PRD-0000001`**, the **company derived from the plant**, `CREATED` \u2192 **`RELEASED`** with who and when, the database read back to prove **no document, no journal and no stock moved**, and a refusal in SAP\u2019s shape. **Suite 1931/1931 in 263 files**; harness **138 targets**; **migrations 199**. Two lessons kept: the keyword-hygiene gate refuses data-dictionary keywords and transaction codes in selectors, and a rebuild during `next start` can hang the build. | Agent |
| 2.720 | 2026-10-20 | **SCR-139 / MIGO — one screen, complete action/reference parity (B-890, §26.902).** Owner ruling: **MIGO gets complete parity**, and SCR-138\u2019s refusal of the A07/R08 dropdowns is **withdrawn**. `/inventory/migo` under `INV.MIGO.POST` carries the action list (A01 receipt, A02 return, A03 cancellation, A04 transfer, A07 issue) and the reference list (R01 order-document, R04 reservation, R05 material document, R08 order); **every cell resolves to posts-here, delivered-elsewhere-with-a-link, or refused-by-name**, and the matrix is **data**, so a later movement adds a row and not a screen. 261 posts here: consumption to a **P&L account, not WIP** (no settlement exists to relieve WIP), over-issue **refused by name**, **262 in the catalogue** so MBST reverses it, order on the line, MD04 demand, both periods, FB03/MB03 drills. | Agent |
movement-key renames in `scripts/plan-mb21.mts` were made during SCR-133 stage 4
but **were never staged**: the stage-4 commit listed directories, and
`src/app/production` was not among them. The green suite and the passing browser
runs read the working tree, so nothing was falsely reported as passing — but the
pushed tree lacked the label, which would have shown a reservation as a
safety-stock line for anyone who cloned it.

Both files are committed now. Standing lesson: stage by path list that names every
directory touched, not by the directories the change was *about*.

