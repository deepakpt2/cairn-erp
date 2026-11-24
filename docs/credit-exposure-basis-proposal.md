# Decision — foreign-currency commitments in the credit exposure basis

**Status:** DECIDED — **Option A** is implemented. Foreign-currency open commitments are converted into
the credit control area's currency and counted in the basis. Recorded against DI-019.

**Date:** 2026-11-24 · **Branch:** `development`

---

## The question this settles

The credit check compares a customer's exposure with a limit, both in the credit control area's currency.
The exposure has two halves:

| Half | Source | Currency |
|---|---|---|
| Open receivables | `journal_entry_line.amount_local` — posted, uncleared | Area currency |
| Open sales commitments | `openSalesCommitmentBuckets` — undelivered order value + delivered-not-billed | Each document's own currency, converted |

Before this change the second half counted **only documents in the area's own currency**. A USD order on a
KWD company added nothing to exposure. That was deliberate — adding a document-currency number to a
local-currency limit without a rate rule would invent one — but it left a permanent under-count in a control
that now blocks goods issues and billing.

---

## The decision, and why

**Option A: convert foreign commitments into the basis.**

Option B (keep them excluded, but visible on the monitor) had been recommended while the impact on live
customers was unknown. **There is no production database.** The app is in development, no customer holds a
limit, and no document has been judged. The cost that made B attractive does not exist yet; the under-count
that made B bad does. Shipping B would leave a control that under-counts *by construction* — silently passing
a customer whose commitments are all foreign — and nothing later would force it to be revisited.

> Option B leaves a permanent under-count in a control that blocks goods issues. With no live data to
> protect, there is no reason to accept that.

### What is now true

- Every open commitment is counted, whatever its currency.
- Each document is converted at **its own date** — the order date, or the delivery date — using
  `CREDIT_CHECK_RATE_TYPE` (AVERAGE), the same rate type and date rule the judged amount uses. An order
  raised in March is judged at March's rate, not today's.
- A missing rate is a **refusal naming the currency pair, the date and the maintenance path**. A document is
  never dropped from the basis and never translated at 1.
- A rate older than the tenant's **maximum rate age** (default 45 days, configurable in
  `client_settings.flags.CREDIT_MAX_RATE_AGE_DAYS`) is **refused by name**. A stale rate is never used.
- `totalExposure`, `availableCredit` and `utilizationPercent` all use the converted basis.
- The monitor shows a **per-currency breakdown** — original amount, rate, rate date, converted amount — and
  never only a converted total.
- Every determination records `rate_used` and `rate_date`, so a blocked or released document can say which
  rate decided it.

### What this does not change

- Receivables exposure: it is already local (`amount_local`), and `refuseAreaCurrencyMismatch` refuses by
  name if a company's local currency ever differs from its area's.
- A same-currency customer sees exactly the same arithmetic as before: the identity rate applies, and the
  converted figure is the original figure.

### Accepted consequence

A customer whose commitment stands in a currency with no maintained rate **cannot be judged at all** — the
order, the delivery and the monitor all refuse until the rate exists. That is intentional: an unjudgeable
commitment is a maintenance task, not a silent pass. The remedy names the pair and the date, so the fix is
one screen. This is the sharp edge of Option A and the reason Option B existed; with no live data, accepting
it is the cheaper error.

---

## Before enabling credit blocks on real data

`scripts/credit-currency-impact.sql` is the go-live check: read-only, changes nothing. Run it with the
migration role against the target database **before** credit blocks are relied on, and read both parts:

- **Part A** — open documents whose determination would change under the converted basis, in both
  directions (`PASSED → BLOCKED` and `BLOCKED → PASSED`), with customer, document, currency, document
  amount, converted amount, the rate and its date, and old and new verdicts.
- **Part B** — open foreign-currency documents that would be **refused right now** because no rate stands
  for their currency pair on their document date.

Expected on an empty or development database: **no rows in either part**. Any row in Part A is a document
whose verdict moves; any row in Part B is a document that will refuse until a rate is maintained. Neither is
an error — they are the work to do before go-live.

Also confirm, once per tenant: `client_settings.flags.CREDIT_MAX_RATE_AGE_DAYS` is set to the age the
business accepts (absent means 45), and a rate exists for every currency pair a customer actually trades in.

---

## Where this lives

- Conversion, staleness and the basis: `src/modules/finance/credit.ts` — `judgedAmountInAreaCurrency`,
  `convertedCommitments`, `maxRateAgeDays`, `CREDIT_CHECK_RATE_TYPE`, `CREDIT_MAX_RATE_AGE_DAYS`.
- Bucket reader: `src/modules/sales/exposure.ts` — `openSalesCommitmentBuckets`.
- Recorded rate: `drizzle/9334_credit_determination_rate.sql` (`rate_used`, `rate_date`).
- Monitor: `src/app/finance/credit-monitor/CreditMonitorShell.tsx` — the per-currency breakdown table.
- Tests: `tests/credit-exposure-basis.test.ts` (converted sum of KWD + USD + EUR, no-rate refusal, stale-rate
  refusal and configuration, rate move between two determinations), `tests/credit-currency.test.ts` (judged
  amount both directions, area-currency check).
- Report: `scripts/credit-currency-impact.sql`.
