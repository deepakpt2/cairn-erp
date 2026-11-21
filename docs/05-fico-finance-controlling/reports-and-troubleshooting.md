# FICO — Reports and Troubleshooting

How to read the books, and what to do when a posting is refused.

## Table of Contents

- [Ledger reports](#ledger-reports)
- [Financial statements](#financial-statements)
- [Customer and vendor reports](#customer-and-vendor-reports)
- [Period-end and control reports](#period-end-and-control-reports)
- [Controlling reports](#controlling-reports)
- [Common messages and what to do](#common-messages-and-what-to-do)
- [Checklist: "why won't it post?"](#checklist-why-wont-it-post)

> [!IMPORTANT]
> **Prerequisites**
> - You hold the display capability for the report. Without it the page says "You do not hold the … capability".
> - Reports show only company codes inside your scope; another company's data is simply absent.
> - Postings exist ([daily transactions](daily-transactions.md)).

> [!NOTE]
> **What Happens in the Background?** Reports post nothing. Every balance is **derived at read time** from posted documents. A reversed document and its reversal both stay visible and net to zero; a **parked** document is not in any balance.

## Ledger reports

| Screen | Route | Use it to | Key selections / columns |
|---|---|---|---|
| **G/L line item report** | `/finance/journal/items` | See every posted line on accounts | **G/L account from/to**, **Company codes**, **Fiscal year**, **Posting date from/to**, **Document number**, **Document type**, **Cost centre**, **Profit centre**, **Reference contains**, **Maximum hits**, **Line item status** (All / Open / Cleared). Shows **Document, Line, Posting date, Type, Account, D/C, Amount, Local amount, Status, Clearing, Assignment, Reference, Text**, with debit and credit **subtotals over the displayed lines** |
| **G/L account balances by period** | `/finance/journal/balances` | Balance per account | **Company codes**, **G/L account from/to**, **Fiscal year**, **Period from/to**, **Ledger**, **Output currency**. Columns **Opening Balance, Period Debit, Period Credit, Net Change, Closing Balance**; account-group subtotals; **Drill** into one account's periods and items |
| **Display an accounting document** | `/finance/journal`, `/finance/journal/document` | One document and its flow | **Company code**, **Document number**, **Fiscal year** |

## Financial statements

| Screen | Route | Notes |
|---|---|---|
| **Trial balance / financial statement** | `/finance/trial-balance` | **Balance at Cutoff**, **Debit Turnover**, **Credit Turnover**, optional **Comparative**, **Variance**, **Variance %** per statement node. Tick **Include 13–16** to include special periods |
| **Balance sheet** | `/finance/balance-sheet` | **Opening Balance**, **Period Debit/Credit**, **Closing Balance**, **Comparative Balance**, **Variance** per statement node and account |
| **Profit and loss** | `/finance/profit-loss` | **Period Movement**, **Year-to-Date Movement**, **Comparative Movement**, **Variance** |
| **Cash flow statement** | `/finance/cash-flow` | Opening cash, closing cash, net change by line; **Unclassified Accounts** lists accounts whose movement has no cash-flow line |

> [!WARNING]
> Each statement ends with **Accounts without an FSV assignment — named, never dropped**. Those accounts have balances but no place on the statement, so the statement will not tie to the ledger until the administrator assigns them.

## Customer and vendor reports

| Screen | Route | Reads |
|---|---|---|
| **Customer balances** | `/finance/customer-balances` | Period balances and line items per customer: **Opening balance, Debit turnover, Credit turnover, Closing balance** |
| **Customer ageing** | `/finance/customer-ageing` | What customers owe, aged at a **Key date** into buckets set by **First / Second / Third threshold (days)**; shows **Days overdue** and **Bucket** per document |
| **Vendor balances**, **Vendor ageing** | `/finance/vendor-balances`, `/finance/vendor-ageing` | The same for what you owe |
| **Credit exposure monitor** | `/finance/credit-monitor` | Exposure against credit limit |

Ageing counts **open** items only; a cleared invoice never appears.

## Period-end and control reports

| Screen | Route | Reads |
|---|---|---|
| **G/L to subledger tie-out** | `/finance/subledger-tie-out` | Per reconciliation account, the G/L balance beside the subledger total. Difference is named **TIED** or **EXCEPTION**, never netted. Partnerless lines (direct postings to a reconciliation account) are listed as exception detail |
| **Advance return for tax** | `/finance/tax/report` | **Tax Base**, **Input Tax**, **Output Tax** per tax code. Use **Test Run** first |
| **Period-end close cockpit** | `/finance/close-cockpit` | Task status, **Execution log**, **Event trail** |
| **Carryforward runs** | `/finance/carryforward` | **Latest run results**: **Source closing**, **Target opening**, **Transfer document**, **Errors** |
| **Asset history sheet** | `/finance/assets/history` | Every acquisition, depreciation and retirement of an asset |

## Controlling reports

| Screen | Route | Reads |
|---|---|---|
| **Cost centre actual/plan report** | `/controlling/cost-center-report` | Per cost centre and cost element: **Actual, Plan, Variance, Variance %, Status**, with year-to-date and line items; planned activity prices and quantities |
| **Profit centre actual line items** | `/controlling/profit-center-report` | Actual postings by profit centre |
| **Internal order line items** | `/controlling/internal-order-line-items` | What was charged to an order |

## Common messages and what to do

| Message (shortened) | Cause | What to do |
|---|---|---|
| "The document does not balance. Debits …, credits …" | Debit ≠ credit | Correct a line amount or add the offsetting line |
| "A document must have at least two line items" | One-sided entry | Add the other side |
| "Period … of fiscal year … is closed" | Posting period closed for the account type | Use an open date or ask the administrator ([posting periods](master-data.md#7-document-types-number-ranges-and-posting-periods)) |
| "Company code … is missing …" | Company code not fully configured | Administrator completes chart, fiscal-year variant, posting-period variant |
| "G/L account … does not exist in this chart of accounts" | Wrong number or not in chart | Check at **G/L account master display** |
| Account refused in the company | Not extended, or posting block | Extend or unblock (needs a reason) |
| "Document type … is not active or does not exist" | Type missing | Pick a configured type |
| "The vendor reference stands required" | Reference empty | Type the invoice number |
| "Correct the gross amount or the line amounts so the document balances" | Gross ≠ net + tax | Recalculate |
| "Use a standing tax code / cost centre / profit centre" | Unknown or invalid code | Pick from the list or leave blank |
| "Extend the vendor to the company code" | No company accounting data | Maintain it at `/foundation/partners` |
| "has already been reversed by …" | Duplicate reversal | Nothing to do; the first reversal stands |
| "is itself a reversal and cannot be reversed" | Reversing a reversal | Post the original again |
| "A cancellation document cannot itself be cancelled" | Cancelling a cancel | Cancel the original invoice |
| Payment "allocation must equal the payment" | Allocated ≠ amount | Adjust **Applied**, or put the rest **On-account** |
| Payment difference beyond tolerance | Unassigned remainder too large | Allocate it, or ask for a higher tolerance group |
| "cannot release a proposal you generated" | Four-eyes rule | Ask a colleague to release |
| Customer order blocked for credit | Exposure over limit | [Release](daily-transactions.md#35-credit-management) with a reason, or raise the limit |
| "An unconfigured special G/L indicator is refused" | Down payment indicator missing | Administrator configures `/config/special-gl` |

## Checklist: "why won't it post?"

1. **Period** — is the posting date's period open for this account type?
2. **Balance** — does debit equal credit?
3. **Accounts** — exist, extended to the company, not blocked, open-item rules respected?
4. **Document type and number range** — active, with a number range?
5. **Master data** — partner has a reconciliation account and company data; tax code and centres valid.
6. **Already done?** — duplicate reference, already reversed, already cleared (**Reset cleared items** first).
7. **Authority** — do you hold the capability and company scope?
8. Give the document number and the exact message to your administrator.

---

**← Previous** [FICO daily transactions](daily-transactions.md) · **Next →** [HR overview](../06-hr-human-resources/overview.md)
