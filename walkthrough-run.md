# Walkthrough run — 23 October 2026

Fresh database. Tenant `1000`, company `1000`, currency INR, country IN, time zone Asia/Kolkata, April–March fiscal year. Posted through the application services in `walkthrough-seed.ts`. Exit 0. No step was skipped.

Production orders and sales orders were not run.

## What posted

| Step | Result |
|---|---|
| Tenant and standard package | 75 accounts, chart CA01 |
| Enterprise structure | Company, plant, purchasing organisation, storage locations 0001, 0002, 0003, 0099 |
| Opening journal | `1000/2026/1` on 1 April 2026 |
| Purchase orders | `POF-0000001`, `POF-0000002`, `POF-0000003` |
| Goods receipts and supplier invoices | All three received and invoiced |
| Payment run `2026-12-10/WT01` | 2 items proposed and cleared |
| Customer invoices | `1000/2026/10` received and cleared; `1000/2026/11` left open |
| Expense journals | Rent and salaries, with cost centres |
| Cash flow FY2026 | Closing 1,879,000. Reconciliation difference 0 |

Trial balance: debits 4,407,200.0000, credits 4,407,200.0000. No unbalanced document.

Open items left on purpose: vendor `V10000` 17,600 on account 200000, customer `C20000` 59,000 on account 110000. GR/IR account 210000 is zero.

Bank account 101000 balance 1,879,000 matches the cash-flow closing.

## Defect — goods receipt accepts a blank storage location

Not fixed. It did not stop the next posting.

The three receipts were posted with an empty storage location. Stock now stands in location `''`, which is not one of the locations defined for plant 1000:

| Material | Quantity | Location |
|---|---:|---|
| MAT-10001 | 10 | *(blank)* |
| MAT-10002 | 20 | *(blank)* |
| MAT-20001 | 8 | *(blank)* |

The plant locations are `0001`, `0002`, `0003` and `0099`. A later issue, transfer or count that names a real location will not see this stock.

## Not a posting-engine defect

The inventory G/L account 120000 is 836,600. The three receipts are only 36,600. The other 800,000 is the opening journal, which never created a stock quantity. That is how the sample was written.

November and December documents posted. The posting period variant C001 is open for periods 1–12, with one future year allowed. The material period was moved to FY2026 period 8 so the November receipt could post. That is the sample opening the next period, not a refusal.

## Not exercised by this run

Master data for partners, materials, tax codes, terms, banks and the April–March variant was inserted for the sample. Those configuration screens were not clicked. The create-tenant form still opens with client `0200`, country `KW`, currency `USD`, time zone `Asia/Kuwait`, and the development box checked. Copy is still offered and then refused. Country and currency are still not checked against the reference list. None of those stopped this run.
