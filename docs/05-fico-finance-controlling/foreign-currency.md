# FICO — Foreign Currency, Realized/Unrealized FX and Bank Reconciliation

Foreign-currency documents are translated once, at the rate that stands on the posting date, and
that rate is snapshotted on the accounting document. Nothing is ever translated at an implicit 1.
This page explains the rate master, what settlement and period-end valuation post, and how a bank
account held in another currency is reconciled.

## Table of Contents

- [Before you start](#before-you-start)
- [Maintain exchange rates](#maintain-exchange-rates)
- [What a foreign document stores](#what-a-foreign-document-stores)
- [Settling an invoice: realized gain or loss](#settling-an-invoice-realized-gain-or-loss)
- [Period-end valuation: unrealized differences](#period-end-valuation-unrealized-differences)
- [Foreign-currency bank reconciliation](#foreign-currency-bank-reconciliation)
- [Reversal and reset](#reversal-and-reset)
- [Auditing historical postings](#auditing-historical-postings)
- [Known limitations](#known-limitations)
- [Where to go next](#where-to-go-next)

## Before you start

> [!IMPORTANT]
> **Prerequisites**
> - A company code with its **local currency** maintained (the books are kept in it).
> - The currencies involved are active in the currency master, with their decimal places (KWD 3,
>   USD 2, JPY 0).
> - You can open **Configuration → Finance → Exchange rates** (`/config/exchange-rates`).
> - Posting foreign documents needs the ordinary invoice/payment authorities. FX valuation needs
>   `FIN.FX.VALUATE`; bank reconciliation needs `FIN.BANK.STATEMENT.*`.

## Maintain exchange rates

Open **Configuration → Finance → Exchange rates** (`/config/exchange-rates`).

1. Choose the **rate type**: `AVERAGE` is the posting rate; `BUYING` and `SELLING` are available for
   valuation policies that name them.
2. Enter **From currency**, **To currency**, **Valid from**, **Rate**, and the translation
   **ratios** (`From` / `To`) when the quotation is stated per 100 or per 1,000 units.
3. Tick the indirect-quotation indicator only when the row is stated the other way round (units of
   the from currency per one unit of the to currency). The effective rate is then its reciprocal.
4. Save. A new validity date is a new row; a key is never edited into another key.

The posting lookup uses the row with the **newest `Valid from` on or before the posting date**. A
future-dated row never hides an earlier valid row. If no row stands, the document is refused; the
system does not substitute 1. A rate of 1 is valid only when it is genuinely maintained (or when
the document and local currencies are the same).

## What a foreign document stores

Every accounting document stores:

- its **document currency** and the company's **local currency**;
- the **effective exchange rate** used, and its provenance (`rate_source`, `rate_type`,
  `rate_valid_from`, the raw rate and ratios, direct/indirect);
- **both amounts on every line**: `amount_document` and `amount_local`, each rounded at its own
  currency's decimals.

Invoices, credit memos, billing documents and payments also snapshot the effective rate and the
local gross/total. The journal display (`/finance/journal/document`) shows the currency pair, the
rate and where it came from. Later rate changes never rewrite a posted document.

A payment record additionally stores the **actual bank movement** (`bank_amount`, `bank_currency`,
`bank_amount_source`). The source says whether it was the payment amount (same-currency account),
the transaction currency amount (foreign bank held in the payment currency), or a user-stated actual
amount for a local-currency bank. The master rate is never presented as the bank's actual movement.

## Settling an invoice: realized gain or loss

When an invoice is settled, three things happen in one journal:

1. The **bank moves at the payment date's rate**.
2. The receivable/payable is **relieved at the local carrying amount it was posted with**.
3. The difference is a **realized exchange gain or loss**, posted to the accounts determined for
   `FXGAIN` / `FXLOSS`. The line carries a local amount and no document amount (it is flagged as a
   local-only adjustment), so each currency still balances.

Example — local currency KWD (3 decimals), USD receivable 100 posted at 0.300 KWD/USD and received
at 0.310:

| Line | Document (USD) | Local (KWD) |
|---|---:|---:|
| Bank | 100.000 | 31.000 |
| Receivable | 100.000 | 30.000 |
| Realized gain | — | 1.000 |

A **vendor payment** at the same movement produces a **loss** of 1.000, because paying more local
currency than the payable carried is an expense.

Full, partial, residual, on-account, cash-discount and tolerance handling all use the same rule.
A discount reduces the carrying amount at the invoice's own rate, so it is not double-counted as
exchange. Several invoices posted at different rates can be settled in one payment; each item is
relieved at its own carrying amount and the single net difference is posted. If the `FXGAIN` or
`FXLOSS` account determination is missing, the whole settlement is refused before anything is
written.

A **partial** settlement closes the original item and leaves the unpaid remainder as a **residual
open item**, exactly as a residual settlement does. The remainder keeps its original document and
local carrying amounts; a later settlement relieves that remainder only. This prevents the original
full amount from being settled twice and keeps the released carrying amount exact. Released,
discount and residual carrying amounts are calculated in the local currency's minor units (KWD
1.000, USD 0.01, JPY 1) and the parts always add back to the original carrying amount; a rounding
remainder stays in the residual item rather than becoming a fictitious exchange difference.

### When the bank account is in the local currency

If the invoice is in USD but the chosen bank account is held in KWD, the posting-date rate is an
accounting rate only. The bank may credit a different KWD amount. On the payment screen, enter the
**Actual bank amount** in the bank account currency. The service validates it against the chosen
bank account and its precision, posts it as the bank line's local amount, relieves the receivable at
its carrying amount, and derives the realized difference from all settlement lines including the
actual bank movement. The actual amount and its source are stored with the payment; it is shown in
the confirmation message and in the payment-run result.

- A **same-currency** bank account needs no second entry: the movement is the payment amount.
- A foreign bank account held in the payment currency also needs none: the movement is the payment
  amount in that currency.
- A bank account in a **third currency** is refused.
- A payment run requires one actual amount for every group whose currency differs from a local bank
  account. The complete set is validated before posting; a missing, duplicate or unknown group
  amount refuses the whole run and leaves nothing posted.

## Period-end valuation: unrealized differences

Open FX items and foreign-currency balance-sheet accounts can be valued at a key date
(**Finance → Period-end close → Foreign currency valuation**, `/finance/fx/valuation`). The run
uses the rate method you choose, the newest valid row on or before the key date, and posts one
balanced adjustment to `FXGAIN` / `FXLOSS`. A test run only records the protocol.

Settlement refuses an item that an **active** valuation has already adjusted **as of the settlement
date**, with a remedy to reverse that valuation document first. This prevents the same difference
from being counted once as unrealized and again as realized. A valuation whose reversal is dated
after the settlement date still counts, because it was active when the settlement was made;
reversing it before settling is the controlled remedy. Clearing (customer and vendor) applies the
same rule to every selected item and to the account/currency balance. A company-scoped transaction
lock serializes valuation against payments, payment runs and clearings, so neither side can pass
its check while the other is still uncommitted.

A valuation posting and its reversal are marked `is_fx_valuation`. That provenance is authoritative:
on a foreign bank G/L the line is shown in reconciliation as a **local-only carrying adjustment**,
never as a matchable bank movement, and it changes no account-currency balance. It is reversible
without leaving a permanent currency blocker. An ordinary local-currency manual line on the same G/L
is still refused, because it has no trustworthy account-currency amount.

## Foreign-currency bank reconciliation

**Finance → General ledger → Clear G/L account → Bank reconciliation**
(`/finance/gl-clearing?mode=bank`).

Bank reconciliation is a manual, evidence-only mode. It does not execute payments, post fees, or
clear AR/AP. A statement and the posted bank lines are compared in the **bank account currency**,
while the same lines keep their **local-currency carrying amount** separately.

1. Choose the house bank, account and currency. The account must have its own bank G/L; a G/L
   shared by two bank accounts is refused because ownership would be ambiguous.
2. Enter the statement (opening/closing balances and lines) in the **account currency**.
3. Match each statement line to posted bank lines. The comparable amount is the line's own amount
   when the line is in the account currency, or the document's local amount when the account is
   held in the company local currency. Matches record both the account-currency allocation and the
   local carrying amount.
4. Finalize only when the bridge is explained; earlier snapshots are never rewritten.

**As-of and reversals.** Ledger movements are included by their actual posting dates. An original
receipt contributes its full amount to an as-of date before its reversal; from the reversal's
posting date the original and its mirror cancel, so the as-of balance is zero, not the opposite
movement. Parked documents never contribute. The mirror itself is not an independent bank movement
and is not counted on its own. If a journal is reversed while a match still refers to it, the
reconciliation shows a blocking `INVALID_MATCH` and requires the statement to be reopened and the
match withdrawn; the historical as-of balance is not silently rewritten. A reversed journal with no
mirror is a blocking `REVERSAL_EVIDENCE` issue because its as-of effect cannot be proved.

A `FX_VALUATION` line is shown with zero account-currency amount and its local carrying adjustment;
it is not matchable. This applies before and after its reversal and does not create a permanent
`LEDGER_CURRENCY` block.

A foreign document on a **local-currency bank G/L** has a local amount, but that amount may be a
rate conversion. It contributes to reconciliation only when the payment record says the actual
amount was user-stated (`USER_ACTUAL`). A historical or manual line without that evidence is a
blocking `BANK_EVIDENCE` issue, shown with zero account-currency movement while its local carrying
stays visible. Correct it with an actual-amount record or a controlled cutover; never assume the
local amount was what the bank moved.

A **legacy line with no trustworthy account-currency amount** — a currency that is neither the
line's nor the company's local currency — is flagged as a blocking `LEDGER_CURRENCY` issue and
cannot be signed off. It is never converted using today's rate. The controlled remedy is an
opening-balance/cutover statement at the account currency: reconcile everything up to a cutover
date, post the difference through an ordinary journal at an explicit rate, and treat later
movements as new. Historical amounts are not fabricated. This also applies to an ordinary
local-currency manual line on a foreign bank G/L: only the persisted FX-valuation provenance makes
a local-only line benign.

## Reversal and reset

- Reversing an invoice or payment posts an **exact mirror** using the original rate and amounts;
  it does not look up a new rate. Its posting date governs the bank as-of calculation; a reversal
  dated after a statement period does not change that period's signed evidence.
- Resetting a clearing that posted a realized FX difference **reverses the clearing journal first**
  (an exact mirror at the original rates), then lifts the clearing stamps. The items stand open
  again and the FX line is undone; no rate is looked up. If the reversal period is closed, the
  reset is refused with that reason and nothing is reopened.
- A valuation's unrealized posting is undone by reversing its journal.

## Auditing historical postings

Documents posted before rate provenance existed may have a foreign currency and a stored rate of
1. The read-only audit lists them, grouped by company, currency pair, document type and rate:

```bash
DATABASE_URL='postgresql://…' npm run fx:audit
DATABASE_URL='postgresql://…' npm run fx:audit -- --json
```

It separates:

- **POSSIBLE_DEFAULT** — no provenance and rate 1. Review the posting dates against the rate master
  and the source documents. An explicitly correct 1 is a false positive.
- **EXPLICIT_ONE** — provenance stands and the rate genuinely was 1.
- **FOREIGN_OTHER** — a foreign document with a non-1 rate and provenance, shown for context.

Where a historical posting is wrong, correct it with a **new adjusting document** at the right
rate; never rewrite the original. The audit changes nothing and assumes no old posting is wrong.

## Known limitations

- A payment where the bank account currency is **neither the payment currency nor the company
  local currency** is refused. One journal cannot state three currencies reliably; pay through a
  bank account in the payment or local currency.
- A foreign payment through a **local-currency bank account** requires the actual bank amount. The
  system never infers it from the master rate, a future statement match, or a later reconciliation.
  A payment already posted without trustworthy actual-bank evidence is not silently reclassified.
- Old period-end valuation postings made before the `is_fx_valuation` provenance existed are **not
  backfilled**. On a foreign bank G/L they remain a blocking `LEDGER_CURRENCY` until finance reviews
  them and corrects the record with an explicit adjusting document; they are never guessed benign
  from their text or from being local-currency.
- Cross-currency **G/L residual** clearing remains refused: a residual must re-stand in its source
  currency, which a single-currency journal line cannot represent.

## Where to go next

- Previous: [Daily transactions](daily-transactions.md)
- Next: [Reports and troubleshooting](reports-and-troubleshooting.md)
- Back to: [FICO overview](overview.md)
