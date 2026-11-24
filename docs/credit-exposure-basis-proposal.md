# Proposal — foreign-currency commitments in the credit exposure basis

**Status:** proposal for the product owner. Nothing here is implemented, and nothing in the repair this
accompanies depends on it. Recorded against DI-019, which stays open.

**Date:** 2026-11-24 · **Branch:** `development`

---

## The question

The credit check compares a customer's exposure with a limit, both in the credit control area's currency
(the company's local currency). The exposure has two halves:

| Half | Source | Currency today |
|---|---|---|
| Open receivables | `journal_entry_line.amount_local` — posted, uncleared | Area currency ✅ |
| Open sales commitments | `openSalesCommitments` — undelivered order value + delivered-not-billed | **Area currency only; foreign documents are dropped** |

The second half filters `o.currency = areaCurrency` (`src/modules/sales/exposure.ts`). A USD order on a KWD
company adds **nothing** to exposure — deliberately, because adding a document-currency number to a
local-currency limit without a rate rule would invent one the credit master does not state. But the
exclusion was invisible until this repair, and a monitor showing a smaller exposure reads as "this customer
is fine".

Since `sales-order.ts` accepts any currency, and `createDelivery`/billing accept it too, foreign
commitments are reachable in normal use.

**What the repair changed (and did not):** the *judged* amount is now translated, so a foreign order is
compared correctly. What still is not translated is the *accumulated* foreign commitment. So the ladder's
first order is judged properly; the basis it is judged against under-counts.

**What was added for visibility:** the monitor now derives `orderExposure` and states
`foreignCommitmentExclusion` — the count of excluded documents and their value **per currency**, never
summed across currencies.

---

## Option A — convert foreign commitments into the basis

Translate each excluded document into the area currency at its own document date, AVERAGE rate, and add it
to exposure.

**For**
- Exposure becomes the real commitment: one number, in one currency, matching the limit.
- Consistent with how the judged amount is now handled — both sides of the comparison translated at the
  same rate type on the same date.
- Removes a class of under-blocking: today a customer with only foreign orders shows zero exposure.

**Against**
- **It changes a live control that has a screen, an audit trail and tests.** Customers currently passing
  may start blocking the moment it lands.
- A rate that moves after the order date restates past exposure; the ledger's own `amount_local` is fixed
  at posting, so the two halves would drift whenever rates move between the order and the invoice.
- A missing rate would make *the basis* unavailable, not just one judgement — the monitor and every check
  in the area would refuse until the rate is maintained. That is a harder failure than a single refusal.
- Choosing the rate (document date vs key date vs month-end average) is itself a policy decision.

**Effect on current customers:** cannot be stated from the database until the impact report is run against
production-shaped data. On a tenant with no foreign open orders (every test tenant, and the demo), the
effect is exactly zero. Where foreign orders exist, every affected customer's exposure rises, and those
whose translated commitment crosses the limit start blocking. **This is the number to collect before
deciding.**

---

## Option B — keep them excluded, but visible (current state)

Leave the basis as it is; keep the monitor's `orderExposure` and the per-currency
`foreignCommitmentExclusion` indicator.

**For**
- No change to a live control; no customer starts or stops blocking.
- The figure is honest: it is labelled a floor, not a total. A reader sees "exposure 400, 3 foreign
  documents excluded worth 50,000 JPY and 1,200 USD" and can judge for themselves.
- No new failure mode from a missing rate.
- Cheap: already done.

**Against**
- A customer whose commitments are all foreign still reads as zero exposure. Visibility is not a block —
  the goods ship unless a human notices.
- It pushes the judgement onto whoever reads the monitor, which is exactly what a control is supposed
  to remove.

---

## Recommendation

**Option B now, Option A once the impact is measured.** The reason is asymmetry: Option A's downside is a
live control that suddenly blocks real customers on a rate-driven number, and that cost lands on the
business immediately; Option B's downside is a known, stated under-count, and it is now visible on the
screen. A control that under-counts visibly is a truthful control; a control that silently under-counts
was the actual defect, and it is closed.

Before Option A is adopted, run `scripts/credit-currency-impact.sql` against production-shaped data and
collect, per option:

- how many open documents are excluded, per currency;
- how many customers have **only** foreign commitments (they show zero exposure today);
- for those with both, how much their exposure rises and how many would newly block.

**One sub-question that does not depend on the above:** should a *missing* rate for a foreign commitment
make the exposure unavailable, or should that customer be shown with a stated "commitment not valued"
flag? Option A forces the choice; the answer shapes whether a broken rate can stop the whole monitor.

---

## What is already true regardless of the decision

- The judged amount is translated at the document's date, AVERAGE, rounded to the area currency's
  precision; no rate is a refusal naming the pair and the date, never a comparison of unlike amounts and
  never a rate of 1 (`tests/credit-currency.test.ts`).
- The area currency is verified equal to each company's local currency at runtime, and a mismatch is
  refused by name rather than summed (`refuseAreaCurrencyMismatch`).
- The monitor derives `orderExposure` and states the exclusion per currency.
- DI-019 remains open, with its note corrected and these criteria added.
