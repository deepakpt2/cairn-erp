# FICO — Finance & Controlling: Overview

Financial Accounting (FI) keeps the **official books**: every posting, every payable and receivable, the balance sheet. Controlling (CO) answers **"where did the money go inside the company?"**: cost centres, internal orders, allocations and planning.

## Table of Contents

- [What FICO does for you](#what-fico-does-for-you)
- [Who uses it](#who-uses-it)
- [The FICO menu](#the-fico-menu)
- [How postings reach the books](#how-postings-reach-the-books)
- [Key ideas in plain words](#key-ideas-in-plain-words)
- [Where to go next](#where-to-go-next)

> [!IMPORTANT]
> **Prerequisites**
> - You have read [Login and roles](../01-getting-started/login-and-roles.md) and [Master data concepts](../01-getting-started/master-data-concepts.md).
> - Your company code exists with a chart of accounts, fiscal-year variant and open posting periods ([FICO master data](master-data.md)).
> - Your role carries FICO authorities (for example **ACCOUNTANT** or **CONTROLLER**) and business access to the company.

## What FICO does for you

| Business question | FICO answers it with |
|---|---|
| "Record a transaction that has no other screen." | **Post a journal entry** (`/finance/journal/new`) |
| "What do we owe suppliers, and when do we pay?" | **Enter vendor invoice**, **Payment run**, **Post outgoing payment** |
| "What do customers owe us?" | **Enter customer invoice**, **Post incoming payment**, **Customer ageing**, **Dunning programme** |
| "Is a customer allowed to order more?" | **Customer credit management**, **Release credit-blocked documents** |
| "Record a machine we bought." | **Asset accounting**: create, acquire, depreciate, retire |
| "Close the month." | **Period-end close cockpit**, accruals, foreign-currency valuation, GR/IR analysis, carryforward |
| "Show me the numbers." | **Trial balance**, **Balance sheet**, **Profit and loss**, **Cash flow**, **G/L line items** |
| "What does this department cost?" | **Cost centre planning and actual/plan report**, **Allocation cycles**, **Internal orders and settlement** |

## Who uses it

| Role | Typical work |
|---|---|
| **Accountant** | Journals, vendor and customer invoices, payments, clearing, reversals |
| **Credit controller** | Customer credit limits, releasing blocked orders |
| **Controller** | Close cockpit, planning, allocations, settlement, reports |
| **Finance administrator** | Chart of accounts, G/L accounts, document types, posting periods, tax codes |

## The FICO menu

Choose **FICO** in the left menu. Categories (you see only what your authorities allow):

| Category | What is in it | Covered in |
|---|---|---|
| **General ledger** | Post / park a journal entry, display a document, reverse a document, clear G/L accounts, reset cleared items, intercompany journal | [Daily transactions](daily-transactions.md#1-general-ledger) |
| **Accounts payable** | Vendor invoice, vendor credit memo, vendor down payments, outgoing payment, payment run, clearing, balances, ageing | [Daily transactions](daily-transactions.md#2-accounts-payable) |
| **Accounts receivable** | Customer invoice, incoming payment, customer down payments, clearing, balances, ageing, dunning, credit | [Daily transactions](daily-transactions.md#3-accounts-receivable) |
| **Asset accounting** | Create asset, acquire, change, depreciation run, retire, history | [Daily transactions](daily-transactions.md#4-asset-accounting) |
| **Period-end close** | Close cockpit, accruals, FX valuation, GR/IR analysis, tax return, subledger tie-out, carryforward, consolidation | [Daily transactions](daily-transactions.md#5-period-end-close) |
| **Financial reporting** | Trial balance, balance sheet, P&L, cash flow, line items, balances | [Reports and troubleshooting](reports-and-troubleshooting.md) |
| **Controlling** | Cost centres, planning, allocations, internal orders, settlement, reports | [Daily transactions](daily-transactions.md#6-controlling) |
| **Configuration** *(administrators)* | G/L accounts, chart, document types, banks, periods, tax, payment terms | [Master data](master-data.md) |

## How postings reach the books

Every posting is a **balanced document**: total debits equal total credits, in one company code, on one posting date, in an **open posting period**. Sales, purchasing, inventory and payroll postings are created by those modules; FICO is where you see and correct them.

```
 Source (MM, SD, PP, HR, or you in FICO)
        │  balanced journal
        ▼
 Accounting document (type SA, KR, DR, KZ, DZ, WE, WA, AB …) ──► G/L balances ──► Statements
        │
        └── partner lines ──► vendor / customer open items ──► payment ──► cleared
```

A posted document is **never edited or deleted**. A mistake is corrected by **reversal**, which posts an equal and opposite document and links the two.

## Key ideas in plain words

- **Debit / credit (D/C, `S` / `H`)** — Debit is `S` (Soll), credit is `H` (Haben) in the data; screens say **Debit** and **Credit**.
- **Reconciliation account** — the G/L account that is the total of all vendor (or customer) balances. You never post to it directly; invoices and payments do.
- **Open item** — an invoice not yet paid. A payment **clears** it.
- **Posting period** — the month a document belongs to; it must be open for that account type.
- **Document type** — `SA` general journal, `KR` vendor invoice, `KG` vendor credit memo, `KZ` vendor payment, `KA` vendor down payment, `DR` customer invoice, `DZ` customer payment, `AB` accounting document (used by reversals), `AF` depreciation run, `AA` asset acquisition, `WE` goods receipt, `WA` goods issue.
- **Park** — save an unfinished journal without it affecting any balance.

## Where to go next

1. [FICO master data](master-data.md) — chart of accounts, G/L accounts, cost centres, banks, periods, tax, payment terms.
2. [FICO daily transactions](daily-transactions.md).
3. [FICO reports and troubleshooting](reports-and-troubleshooting.md).

---

**← Previous** [SD reports and troubleshooting](../04-sd-sales-distribution/reports-and-troubleshooting.md) · **Next →** [FICO master data](master-data.md)
