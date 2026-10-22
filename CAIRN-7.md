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
