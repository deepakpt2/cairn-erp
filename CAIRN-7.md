# Cairn — Project Log & Technical Specification (continued)

**Product:** Cairn — an enterprise resource planning system
**Hostname:** cairn.deepakpt.com
**Document status:** AGREED baseline (2026-10-08 Go) — implementation IN BUILD; screen sign-off remains per §24.1
**Created:** 2026-10-22 (v2.798) · **Part 7 of 7 — this is the live part**
**Continues:** [CAIRN.md](CAIRN.md) (§0–§26.35) · [CAIRN-2.md](CAIRN-2.md) (§26.36–§30 through v1.69) · [CAIRN-3.md](CAIRN-3.md) (§0.3, §1.4 R-24–R-72, §2.1 D-093–D-139, §26.167–§26.259, §30 v1.70–v2.61) · [CAIRN-4.md](CAIRN-4.md) (§1.4 R-73–R-98, §26.260–§26.364, §30 v2.62–2.169) · [CAIRN-5.md](CAIRN-5.md) (§26.365–§26.555, §30 v2.170–2.373) · [CAIRN-6.md](CAIRN-6.md) (§26.556–§26.979, §30 v2.374–2.797)
**Owner:** Deepak (product owner) · Built with Arena.ai Agent Mode

---

## §0.3 Document-set size and rotation rule `AGREED · v1.70`

The rule recorded in `CAIRN-3.md` §0.3 (R-24 / D-093) is unchanged and binding: no part may exceed
400,000 bytes; a live part rotates as soon as it passes 360,000 bytes; the next part continues section
and version numbering without a gap; both the outgoing and the incoming part carry a continuation
notice; a rotated part is frozen to pointer edits and corrections that cannot be deferred; size is
measured on disk in the same turn any canonical file is edited.

**Set status at v2.798 (2026-10-22):** `CAIRN-6.md` is frozen at v2.797. It had already passed the
400,000-byte ceiling; its written sections are not moved. This part continues §26 from 26.980 and §30
from 2.798. SCR-158 (ME48) is the last round closed in part 6; SCR-159 (ME49) opens here.

---

## §26.980 — ME49 contracted: one event is compared, and it does not buy

**B-968.** SCR-159. The owner's package (2026-10-22, three parts) is the contract. ME49 compares the quotations that already stand for one event. It is not a revision, not a condition, not an exchange rate, not a report run, not an award, and not an order. ME47 and ME48 still refuse a status, a revision stack, a condition, a currency column, and an award. This round does not weaken that refusal. A supplier portal, EDI, email dispatch, a rejection, and an award stay later. Balance-form suggestions stay deferred.

**What already stands, and this round does not rebuild.** One quotation prices one request. The event number groups the requests. A collective number is a label. The supplier is on the request. The currency is the company's, on the event. The net price and the price unit are on the quotation item. The price per one unit is calculated. Migrations `9096` and `9097` are not edited. There is no schema stage. There is no `9098`.

**The comparison.** The event number is the key. A collective number that matches one event resolves that event and is named as a label. A collective number that matches more than one is refused and names the event numbers. Events are not merged. The purchasing organisation is required, must stand, and must be the event's. There is no purchasing-organisation authorization object. A plant and a material are optional filters. An unknown plant or material is refused. Another tenant's event is the same miss.

**The price.** The currency is the event's company currency. A posted currency is refused and names that currency. An exchange rate is not read. The compared price is the net price per one unit of the unit that was asked. It is calculated. It is not stored. Rank is within one event item, lowest first, and equal prices are ordered by supplier number for display only. Equal prices share a rank. They are not called commercially superior. The next distinct price takes the competition rank. A zero price is an offer and ranks when it can be compared. A missing offer is not a zero and is not ranked. A quantity mismatch is shown and is not a disqualification. Rank is by the comparable unit price, not by the extended cost. The extended cost for the quantity that was asked is shown and is not stored.

**The unit.** The comparable unit is the event item's unit. The comparison is grouped by the event item, not by the material number alone. The same unit compares directly. A standing material unit conversion converts by integer arithmetic, half up at scale 4. Alternative quantity times numerator, divided by denominator, equals base quantity. When the offered unit is the alternative and the asked unit is the base, the price per asked unit is the price per offered unit times denominator, divided by numerator. The reverse uses the inverse ratio. No conversion path means the offer is not comparable and is not ranked. The float path in `unit-conversion.ts` is not used.

**The date.** A day after the deadline does not hide a standing quotation. The evaluation date is the server's date. It is shown. It is not an input. A posted date is refused.

**Refused by name, so a later round does not mistake refusal for absence:** a stored status, a revision, a condition, a discount, freight, a tax, a landed cost, a currency column, an exchange rate, a report-run record, a stored rank, a stored normalized price, an award, a purchase order, a request key, an outbox, a uuid, a goods movement, and a journal. Viewing writes nothing, including a change document.

## §26.981 — ME49 read: the event number is the key, and nothing is written

**B-969.** SCR-159 stage 2. No schema. `src/modules/purchasing/quotation-comparison.ts` reads the event, the requests, the copies, the quotations, the offers, the current supplier names, and the standing conversions. It does not insert, update, or delete. It does not draw a number. It does not record a view.

The service proof. Item 10 ranked a zero price first and 2.5000 second. The dearer offer's quantity differed from the quantity asked and was not disqualified. Its extended cost for the asked 12.500 was 31.2500 and was not stored. Item 20 converted a standing alternative unit by 3 to 1: 2.0000 per alternative unit became 0.6667 per asked unit, half up, and the extended cost of quantity 3 was 2.0001. Item 30 reversed that ratio: 5.0000 per base unit became 15.0000 per alternative unit, and the two equal prices shared rank 1. Item 40 had no conversion from the offered unit to the asked unit, so a zero price was not ranked. The other supplier had no offer, and that absence was not a zero. A day after the deadline the same rank stood. One collective number resolved the event. Two events carrying that label were refused by name, and the event number did not merge them. Another tenant's event was the same miss. A different purchasing organisation was refused. An unknown plant and an unknown material were refused. A filter that matched no line was named and was not a miss of the event. A posted currency, including the company's own, was refused and named the company's currency. A posted evaluation date, a landed cost, freight, an award, a status, a revision, an order and a request key were refused. The quotation count, the change documents, the journals, the material documents, the info records, the orders and the number were unchanged. The screen was not the acceptance of this stage. T854 through T857 were not rerun.

## §26.982 — ME49 screen: one route, and nothing is written

**B-970.** SCR-159 stage 3. Route `/purchasing/quotation-comparison`. Capability `PROC.RFQ.COMPARISON`, posting false. Alias `ME49` in the catalogue and the code line only. It is not in the three quotation-maintain files, and it is not an identifier on this page. The event field suggests event numbers only, five at a time, and does not search a collective number. Purchasing organisation and plant are dropdowns. Material uses the request's material search. The screen says a collective number is a label, that the price is not converted, that the compared price is calculated and not stored, and that it does not award or buy. A quotation link is the display. A maintain link is shown only when the user holds `PROC.RFQ.QUOTATION`. There is no award button and no order link. Nothing is written. Live seed 184 capabilities, 158 terms, 182 aliases. Configuration activities stayed 71. The message catalogue stayed 11. Screen contract 2/2. T858 follows. T854 through T857 were not rerun.

## §26.983 — ME49 acceptance: T858 compares one event, and it does not buy

**B-971.** T858 green on the production build. ME49 opened the one screen. A price, a status, a currency, a revision and an award are not fields. There is no award button and no order link. Event EV-0000001 was compared in KWD. Item 10 ranked 1.0000 first and 2.5000 second, and the quantity mismatch was not a disqualification. Item 20 was a tie at rank 1. Item 30 ranked a zero price, and the supplier with no offer was not ranked. Collective number BID-1 resolved that event and was named as a label. A second event carrying the same label was refused, and both event numbers were named. The events were not merged. After the deadline was 2026-10-21 the comparison still stood. Purchasing organisation 2000 was refused. The order price stayed 1.00. The requisition stayed 1.000. The read wrote no quotation, no change document, no journal and no material document. Service test 1/1. Screen contract 2/2. T854 through T857 were not rerun.

An award, a rejection, a supplier portal, EDI and dispatch were not started.

Same-stage bookkeeping: B-971 / §26.983 / §30 row 2.801.

## §26.984 — MIR7 contracted: a park is not a posted invoice

**B-972.** SCR-160. The owner's package (2026-10-22) is the contract. MIR7 parks a supplier invoice. It is not invoice verification, not a credit memo, not a subsequent debit or credit, not an approval, and not a deletion. The row is the park. There is no status to complete, post, reject or delete. Posting remains `supplier_invoice`, and only a posted row counts as invoiced. The purchase order is named and is not consumed. The goods receipt is not consumed. No journal is written. The supplier, the company and the currency are the order's. Payment terms are the supplier's company data. The tax is the standing tax code, calculated and not entered. A quantity above the invoiceable quantity is shown and is not a refusal. A missing receipt is shown and is not a refusal. A check writes nothing, including the number. A closed period is not read, so it cannot block a park. A date that is not a fiscal date is refused. MIR4, MIR6, a workflow and balance-form suggestions stay later. T849 through T858 were not rerun. Migrations `9093` through `9097` were not edited.

## §26.985 — MIR7 service: the park stands, and the receipt still posts

**B-973.** SCR-160 stage 2. Migration `9098`. Tables `parked_supplier_invoice` and `parked_supplier_invoice_item`. The number object is `PARKINV`, prefix `PV`, length 7. It is not `VENDINV` and it is not `PARKDOC`. The line number is the order item. It does not add an item. There is no status column, no exchange rate, no freight, no discount and no approval.

The service proof. A check of eight against an order of five, with nothing received, wrote nothing and did not draw a number. The note named the missing receipt. Payment terms were NET30 and the due date was 2026-11-21. The park then stood as a `PV-` number. The journal count, the posted-invoice count, the material-document count and the vendor-invoice number were unchanged. The same request key returned that number and did not draw another. Another tenant's read was the same miss. A later goods receipt of five was not consumed by a parked quantity of eight. Invoice verification refused that supplier reference and named the parked number. A different reference posted five, and the parked quantity remained eight while invoiced became five. A posted reference was refused and named the invoice. A second park of the same reference was refused and named the first park. A change of the reference and the quantity stood in the change history. The stale token was refused and the new reference remained. A credit memo, a subsequent debit, a subsequent credit, a currency, a company code, a supplier, payment terms, an entered tax, an exchange rate, freight, a discount, a status, an approval, a posting, an award, a deletion and a request key on the check were refused by name, and the counts were unchanged. An empty order suggestion returned nothing. A typed order returned that order, and no more than five. The other tenant saw none. The screen was not the acceptance of this stage. T859 was not run.

## §26.986 — MIR7 screen: one route, and it does not post

**B-974.** SCR-160 stage 3. Route `/purchasing/parked-invoice`. Capability `PROC.INV.PARK`, posting false. Alias `MIR7` in the catalogue only. It is not an identifier on the page. The order field and the parked-number field suggest as the user types, five at a time. An empty query returns nothing. The screen shows received, invoiced and invoiceable. It says the tax is calculated, that a difference from the order price is not a match status, and that a parked invoice is not invoiced quantity. Check writes nothing, including the number. There is no post button and no delete button. A link to invoice verification is navigation. Invoice verification links back, and it does not park. Invoice verification now refuses a supplier reference that already stands parked, and it names that number. It does not post the parked document. Live seed was not re-run. Screen contract 2/2. Service test 5/5. T859 was not run. T849 through T858 were not rerun.

An approval, a workflow, MIR4 and MIR6 were not started.

Same-stage bookkeeping: B-974 / §26.986 / §30 row 2.804.

## §26.987 — MIR7 acceptance: T859 parks one invoice, and it does not post

**B-975.** T859 green on the production build. MIR7 opened the one screen. The alias was not on the page. A status, a currency and a category are not fields. There is no post button and no delete button. Purchase order POF-0000001 opened for V-PARK in KWD. Item 10 had received 0, invoiced 0 and invoiceable 0. An empty order click suggested nothing. A typed prefix suggested the order, and no more than five. Purchase order NO-SUCH was named, and nothing was written. A check of quantity 8 and net 800 named the missing receipt. Payment terms were NET30 and the due date was 2026-11-21. The check wrote nothing, including the number. The entered invoice remained, and the park submitted it. The park stood as PV-0000001. The journal count, the posted-invoice count, the material-document count and the vendor-invoice number were unchanged. The order quantity stayed 5. A change to reference PARK-2, quantity 2 and net 200 stood in the change history beside the create. Invoiced stayed 0. The parked count did not grow, and the vendor-invoice number was not drawn. Service test 5/5. Screen contract 2/2. T849 through T858 were not rerun.

A credit memo, an approval, a post from the park, MIR4 and MIR6 were not started.

Same-stage bookkeeping: B-975 / §26.987 / §30 row 2.805.

## §26.988 — MIR6 contracted: the list is not a posting

**B-976.** SCR-161. The owner's package (2026-10-22) is the contract. MIR6 lists the logistics invoices that already stand. It introduces no invoice table, no status, and no accounting source of truth. A parked invoice is a parked row. A posted invoice is a supplier invoice. A cancelled invoice stays cancelled, and the cancellation document stays posted and names the invoice it cancels. A credit memo is a category, not a reversal. A draft, a payment block, a saved layout, an export, an invoice without a purchase order, a company-code authorization object, and a purchasing-organisation authorization object are not this list, and each is refused by name. The fiscal year is the year stored on the invoice. It is not derived from the posting date. A closed period is not read, so it cannot hide a historical invoice. A company-currency amount is the journal line's stored amount, or it is absent. It is not converted. Viewing writes nothing. MIR4, a payment-block release, and an export stay later. T849 through T859 were not rerun. Migration `9098` was not edited.

## §26.989 — MIR6 read: one row per invoice, and the park has no journal

**B-977.** SCR-161 stage 2. No schema. `src/modules/purchasing/invoice-overview.ts` reads `supplier_invoice` and `parked_supplier_invoice`. It does not insert, update, or delete. It does not draw a number. It does not read a posting period.

The service proof. A park of quantity 8 and gross 800 stood with no journal, no category, no company-currency amount, and payment state not applicable. Its posting date was blank. A posted invoice was cancelled. The original stood cancelled and named the cancellation. The cancellation stood posted, category invoice, and named the original. It was not a credit memo. The posted journal link named the stored document, and the payment state was open from the uncleared supplier line. A company-currency amount stood only where that line stored one. A document stored as fiscal year 2025, with posting date 2026-04-01 and two items, was absent from year 2026 and stood once in year 2025 at gross 40.0000. The items did not duplicate it. A posting-date filter left the park out and said why. Another tenant's read was the same miss. The parked count, the posted count, the journal count and the change count were unchanged. A draft, a payment block, a reversal, an export, an invoice without an order, a company authorization, a purchasing authorization, an exchange rate, a post, company 1099, a missing year and lifecycle DRAFT were refused by name. Category credit memo returned an empty list and did not include the park. Year 1999 returned an empty list. Service test 2/2. The screen was not the acceptance of this stage. T860 was not run. T849 through T859 were not rerun.

## §26.990 — MIR6 screen: one route, and it does not post

**B-978.** SCR-161 stage 3. Route `/purchasing/invoice-overview`. Capability `PROC.INV.OVERVIEW`, posting false. Alias `MIR6` in the catalogue only. It is not an identifier on the page. Company code and purchasing organisation are dropdowns. Vendor, purchase order, and invoice document suggest as the user types, five at a time. An empty query returns nothing. The fiscal year is required and is not taken from the calendar date. The list shows parked, posted, and cancelled. A parked posting date is blank. A parked invoice has no accounting-document link. A posted invoice links to the accounting document that stands, and the destination rechecks its own capability. Totals stay in their currency and lifecycle. There is no post button, no export, and no payment-block field. A link to the park and a link to invoice verification are navigation. Live seed was not re-run. Screen contract 2/2. Service test was not the browser acceptance. T860 was not run. T849 through T859 were not rerun.

An export, a payment block, and MIR4 were not started.

Same-stage bookkeeping: B-978 / §26.990 / §30 row 2.808.

## §26.991 — MIR6 acceptance: T860 lists one park, and it does not post

**B-979.** T860 green on the production build. MIR6 opened the one screen. The alias was not on the page. A draft, a payment block and an export are not fields. There is no post button. A draft was refused by name, and nothing was written. Company 1000 and fiscal year 2026 listed PV-0000001 as parked. The posting date was blank. There was no accounting document, and the payment state was not applicable. The parked count, the posted count, the journal count and the change count were unchanged. The document opened on the list and said no accounting document stands. The park link opened the parked invoice. The list still wrote nothing. Live seed 186 capabilities, 160 terms, 184 aliases. Configuration activities stayed 71. The message catalogue stayed 11. Service test 2/2. Screen contract 2/2. T849 through T859 were not rerun.

An export, a payment block, and MIR4 were not started.

Same-stage bookkeeping: B-979 / §26.991 / §30 row 2.809.

## §26.992 — MRBR contracted: a release is not a posting

**B-980.** SCR-162. The owner's package (2026-10-22) is the contract. MRBR releases a payment block on a posted logistics invoice. It does not repost, reverse, or change the invoice amount or the accounting document. A check writes nothing. Releasing one reason does not clear another. A payable stays blocked while a mandatory block remains. A payable in a payment proposal, or already paid, is not released. A closed period does not by itself refuse a release that posts nothing.

**What already stands, and this round does not invent.** The payable is the uncleared supplier credit line of a posted journal whose origin is `supplier_invoice`. Invoice verification posts that journal. It does not write a payment block, and a price difference is not a block. There is no tolerance that generates a price block or a quantity block. MIR6 still refuses a payment block by name. The payment run already proposes and pays open supplier lines. This round does not build another payment run.

**The only hold that can stand.** A manual hold on a posted unpaid supplier invoice whose supplier line is still open and not sitting in a proposal. The hold is a row the payment run reads. It is not a second payable and not a flag the run ignores. A price block, a quantity block, and a quality block are refused by name.

## §26.993 — MRBR service: the hold is the row the payment run reads

**B-981.** SCR-162 stage 2. Migration `9099`. Tables `supplier_invoice_payment_block` and `supplier_invoice_payment_block_event`. The reason check admits only `MANUAL`. A release sets the hold inactive and appends an event. It does not update the invoice or the journal. The same request key returns the standing result and does not write again. A stale version is refused. `openItems` in the payment run skips an invoice with an active hold.

The service proof. A posted invoice with a price difference had no hold until one was placed. A check wrote nothing. The same request key did not write a second event. The payment proposal left the held invoice out. Period 10 was closed for vendors, and the release still stood. The invoice gross, the journal document, the journal count, the line amount, and the clearing stamp were unchanged. A replay did not add an event. After the release, the same proposal included the invoice. Execution paid it, and a later hold was refused as already paid. An invoice already in a proposal could not be held. After that proposal was cancelled, the hold stood, was released, and was placed again as the same row. A price block, a quantity block, a quality block, and a parked number were refused by name. Service test 3/3. The existing payment-run tests still passed, 2/2. The screen was not the acceptance of this stage. T861 was not run. T849 through T860 were not rerun.

Same-stage bookkeeping: B-981 / §26.993 / §30 row 2.811.

## §26.994 — MRBR screen: one route, and it does not post

**B-982.** SCR-162 stage 3. Route `/purchasing/blocked-invoice`. Capabilities `PROC.INV.BLOCK` and `PROC.INV.BLOCK.RELEASE`, both posting false. Alias `MRBR` in the catalogue only, on the release capability. It is not an identifier on the page. Company code is a dropdown. Vendor, purchase order, and invoice suggest as the user types, five at a time. The fiscal year is required and is the year stored on the invoice. The list shows the manual reason, who placed it, and whether the payable is open, in a proposal, or paid. A check writes nothing. Place and release return to the same selection. The history names the action, the person, and the reason. There is no post button, no price field, and no quantity field. A link to the invoice overview and a link to the payment run are navigation. Live seed on this workspace was 188 capabilities, 162 terms, 185 aliases. Configuration activities stayed 71. The message catalogue stayed 11. Screen contract 2/2. Service test was not the browser acceptance. T861 was not run. T849 through T860 were not rerun.

Same-stage bookkeeping: B-982 / §26.994 / §30 row 2.812.

## §26.995 — MRBR acceptance: T861 releases one hold, and it does not post

**B-983.** T861 green on the production build. MRBR opened the one screen. The alias was not on the page. An unheld invoice was not listed, and nothing was written. A check named the manual hold on VI-0000001 and wrote nothing. The hold then stood. The reason was manual. The source was the person who placed it. The journal count, the invoice gross, and the line amount did not change. A release check wrote nothing. The release stood in the history, named the person, and left the invoice amount standing. The active row left the list. T849 through T860 were not rerun.

Same-stage bookkeeping: B-983 / §26.995 / §30 row 2.813.

## §30 · Change log (continued)

| Ver | Date | Change | By |
|---|---|---|---|
| 2.798 | 2026-10-22 | **SCR-159 / ME49 contracted (B-968, §26.980).** One event is compared by the net price per asked unit. A collective number is a label. No schema. No award. | Agent |
| 2.799 | 2026-10-22 | **SCR-159 stage 2 — the comparison reads, and it writes nothing (B-969, §26.981).** A zero ranks when it can be compared. A missing conversion does not. Equal prices share a rank. A shared label is refused by name. | Agent |
| 2.800 | 2026-10-22 | **SCR-159 stage 3 — one screen (B-970, §26.982).** Route `/purchasing/quotation-comparison`. Alias only in the catalogue and the code line. Capability `PROC.RFQ.COMPARISON`, posting false. Live seed 184/158/182. Screen contract 2/2. T858 not run. T854 through T857 not rerun. | Agent |
| 2.801 | 2026-10-22 | **SCR-159 stage 5 — T858 compares one event, and it does not buy (B-971, §26.983).** Production build. ME49 opened the one screen. The lower price ranked first, a tie was named, a zero ranked, and a missing offer did not. A shared collective number was refused. Nothing was written. T854 through T857 not rerun. | Agent |
| 2.802 | 2026-10-22 | **SCR-160 / MIR7 contracted (B-972, §26.984).** A park is not a posted invoice. No status. The order and the receipt are not consumed. A closed period is not read. | Agent |
| 2.803 | 2026-10-22 | **SCR-160 stage 2 — the park stands, and the receipt still posts (B-973, §26.985).** Migration `9098`. Number `PARKINV` / `PV`. A check writes nothing. A parked quantity is not invoiced quantity. A shared reference is refused by name. | Agent |
| 2.804 | 2026-10-22 | **SCR-160 stage 3 — one screen (B-974, §26.986).** Route `/purchasing/parked-invoice`. Alias only in the catalogue. Capability `PROC.INV.PARK`, posting false. Screen contract 2/2. Service test 5/5. T859 not run. T849 through T858 not rerun. | Agent |
| 2.805 | 2026-10-22 | **SCR-160 stage 5 — T859 parks one invoice, and it does not post (B-975, §26.987).** Production build. MIR7 opened the one screen. The check named the missing receipt and wrote nothing. PV-0000001 stood. The change stood in the history. The order was not invoiced. T849 through T858 not rerun. | Agent |
| 2.806 | 2026-10-22 | **SCR-161 / MIR6 contracted (B-976, §26.988).** The list is not a posting. No new invoice table. The fiscal year is the stored year. A closed period is not read. | Agent |
| 2.807 | 2026-10-22 | **SCR-161 stage 2 — one row per invoice (B-977, §26.989).** A park has no journal. A cancellation names the original and is not a credit memo. Fiscal year 2025 stayed out of 2026. Two items did not duplicate the row. Service test 2/2. | Agent |
| 2.808 | 2026-10-22 | **SCR-161 stage 3 — one screen (B-978, §26.990).** Route `/purchasing/invoice-overview`. Alias only in the catalogue. Capability `PROC.INV.OVERVIEW`, posting false. T860 not run. T849 through T859 not rerun. | Agent |
| 2.809 | 2026-10-22 | **SCR-161 stage 5 — T860 lists one park, and it does not post (B-979, §26.991).** Production build. MIR6 opened the one screen. PV-0000001 stood parked, with no accounting document. A draft was refused. Nothing was written. T849 through T859 not rerun. | Agent |
| 2.810 | 2026-10-22 | **SCR-162 / MRBR contracted (B-980, §26.992).** A release is not a posting. The only hold is manual. A price difference is not a block. The payment run reads the same row. | Agent |
| 2.811 | 2026-10-22 | **SCR-162 stage 2 — the hold is the row the payment run reads (B-981, §26.993).** Migration `9099`. A closed period did not refuse the release. The journal amount did not change. A paid item and a proposal item were refused. Service test 3/3. | Agent |
| 2.812 | 2026-10-22 | **SCR-162 stage 3 — one screen (B-982, §26.994).** Route `/purchasing/blocked-invoice`. Alias only in the catalogue. Capabilities `PROC.INV.BLOCK` and `PROC.INV.BLOCK.RELEASE`, posting false. T861 not run. T849 through T860 not rerun. | Agent |
| 2.813 | 2026-10-22 | **SCR-162 stage 5 — T861 releases one hold, and it does not post (B-983, §26.995).** Production build. MRBR opened the one screen. VI-0000001 was held, then released. The journal amount did not change. T849 through T860 not rerun. | Agent |
