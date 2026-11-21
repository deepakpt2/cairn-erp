# FICO — Master Data

The records every posting depends on: the chart of accounts, G/L accounts, cost and profit centres, banks, periods, tax codes and payment terms. Most are set once by a finance administrator.

## Table of Contents

- [1. How the pieces fit](#1-how-the-pieces-fit)
- [2. The G/L account master](#2-the-gl-account-master)
- [3. Chart of accounts and company codes](#3-chart-of-accounts-and-company-codes)
- [4. Cost centres and profit centres](#4-cost-centres-and-profit-centres)
- [5. Customer and vendor accounting data](#5-customer-and-vendor-accounting-data)
- [6. Banks and house banks](#6-banks-and-house-banks)
- [7. Document types, number ranges and posting periods](#7-document-types-number-ranges-and-posting-periods)
- [8. Tax codes, payment terms and payment methods](#8-tax-codes-payment-terms-and-payment-methods)
- [9. Credit control areas](#9-credit-control-areas)
- [Checklist: ready to post?](#checklist-ready-to-post)

> [!IMPORTANT]
> **Prerequisites**
> - [Master data concepts](../01-getting-started/master-data-concepts.md) read.
> - Authority to maintain configuration (finance administrator). With display authority only, these screens are read-only: they say "Read-only view. Changes require authority …".
> - Changes are recorded with a **reason / change note**. Write what you changed and why; the change history keeps it.

## 1. How the pieces fit

```
 Chart of accounts ──► G/L accounts ──► extended to company code
 Company code ──► fiscal-year variant ──► posting periods (open/closed)
 Company code ──► controlling area ──► cost centres, profit centres
 Customers / vendors ──► reconciliation account (a G/L account)
 Document types ──► number ranges
```

## 2. The G/L account master

**FICO → General ledger → G/L account master create / change / display** (`/config/gl-accounts/new`, `/config/gl-accounts/edit`, `/config/gl-accounts/view`; list at `/config/gl-accounts`). You can also search for the alias **FS00**.

**Create a G/L account** (sample: `510200` Repairs and maintenance)

| Field | Meaning | Required |
|---|---|---|
| **Chart of Accounts** | Only active, unblocked charts can be chosen | **Yes** |
| **G/L Account** | The number; **it can never be changed afterwards** (a wrong number needs a new account) | **Yes** |
| **Short Text** | The description, up to 200 characters | **Yes** |
| **Account Group** | Which number range and field rules apply | **Yes** |
| **Account Type** | Drives where it appears on the statements | **Yes** |
| **G/L Account Type** | **Balance Sheet** or **P&L Statement**. Balance-sheet accounts carry forward; P&L accounts reset at year end | **Yes** |
| **Balance Sheet Account** | Derived from the type, never typed | — |
| **Retained Earnings Indicator** | Marks the account that receives the year's profit | Optional |
| **Language Key** | Language of the text | Optional |
| **Sort Key** | Three characters; default `000` | Optional |
| **Open Item Management** | Required for clearing accounts such as bank, receivables, payables | Optional |
| **Reconciliation Account** | Which subledger it reconciles: customers or vendors | Optional |
| **Tax Relevant** | Takes part in tax determination | Optional |
| **Cost Object Required** | Postings must carry a cost object | Optional |
| **Group Account Number** | For consolidation roll-up | Optional |
| **Posting Block**, **Creation Block** | Stop postings, or stop extending to company codes | Optional |
| **Reason / Change Note** | Required when you block or delete | **Yes** for block/delete |

Click **Create G/L Account** (or **Save changes** when changing).

> [!NOTE]
> **What Happens in the Background?** The account exists in the chart but can be posted to only in company codes it is **extended** to. Blocking it stops new postings; balances already posted stay. A reconciliation account should move only through its subledger: a direct posting to it is shown as an exception in the [G/L to subledger tie-out](reports-and-troubleshooting.md#period-end-and-control-reports).

## 3. Chart of accounts and company codes

- **Chart of Accounts** (`/config/chart-of-accounts`): **Chart of Accounts** code, **Description**, **Language Key**, **Length of G/L Account Number**, **Group Chart of Accounts**, **Cost Element Integration** (**Automatic**, **Manual**, **None**), **Status**. A copy tool lives at `/config/chart-of-accounts/copy`.
- **Fiscal-year variants** (`/config/fiscal-year-variants`): the calendar of posting periods, e.g. `K4` = calendar year with four special periods. Assign a variant to a company code at `/config/fiscal-year-variants/assign-company-codes`. The screen lists **Posted documents** per company beside the variant, and the change is recorded in the change document with the old and the new variant.
- **Retained earnings account** (`/config/retained-earnings`): where the year-end carryforward moves the P&L result.

## 4. Cost centres and profit centres

**Controlling area** (`/config/controlling-area`): defined by a **four-letter code** that cannot be changed. Choose the **Assignment Control**: *Controlling area same as company code (1:1)* or *Cross-company-code cost accounting (1:N)*. Assign company codes to it.

**Cost centres** (`/config/cost-centers`, activity `KS01`): choose the **Controlling area**, then **New cost centre period**:

| Field | Meaning |
|---|---|
| **Cost centre** | Code, e.g. `CC1000` |
| **Valid** (from / to) | A cost centre exists in periods of validity |
| **Name** | Description |
| **Company code** | Must belong to the controlling area |
| **Category** | Kind of cost centre |
| **Hierarchy node** | Where it sits in the cost-centre tree (`/config/cost-center-hierarchy`) |
| **Posting** | Whether it can be posted to |

**Profit centres** (`/config/profit-centers`): **Profit centre** (e.g. `PC100`), **Valid**, **Name**, **Person responsible**, **User**, **Segment**, **Hierarchy node**, **Posting**. Hierarchy at `/config/profit-center-hierarchy`.

Also under Controlling configuration: **Activity types** (`/config/activity-types`), **Activity prices** (`/config/activity-rates`) and **Settlement configuration** (`/config/settlement-configuration`).

> [!NOTE]
> **What Happens in the Background?** Nothing posts. A cost centre is a label on a posting line; the line must still carry a G/L account. Journal and invoice screens offer cost centres that are valid for the company entered.

## 5. Customer and vendor accounting data

Both are business partners ([Master data concepts](../01-getting-started/master-data-concepts.md)). At `/foundation/partners`:

- **Customer company accounting** and **Supplier company accounting** panels hold the **reconciliation account**, **payment terms**, payment methods, dunning procedure (customers), tolerance group and a **Blocked** flag, with a mandatory reason. See [SD master data](../04-sd-sales-distribution/master-data.md#12-customer-company-accounting).
- Without a reconciliation account, no invoice can be posted for that partner.

## 6. Banks and house banks

1. **Banks** (`/config/banks`): **Bank Country**, **Bank Key** (e.g. `012345678`), **Bank Name** (e.g. National Bank of Kuwait), **City**, **SWIFT / BIC** (optional, 8 or 11 characters).
2. **House banks** (`/config/house-banks`): your own bank, per company code: **House Bank** code (e.g. `NBK01`), then its **bank accounts**: **Account ID** (e.g. `ACC01`), **Account Number**, **IBAN** (optional, up to 34 characters), **Currency** and the **G/L Account** (an asset balance-sheet account of the company's chart, e.g. `101000`).
3. Payment runs and payments post to the bank's G/L account.

## 7. Document types, number ranges and posting periods

- **Document types** (`/config/document-types`): exactly **two letters or digits** (e.g. `SA`), **Description**, **Number Range Interval** (which numbers it draws), **Reverse Doc. Type** (default: the same type), **Account Types Allowed**, **Active**. Number ranges: `/config/number-ranges`.
- **Posting periods** (`/config/posting-periods`): per **Account type** and **From** period, which **Open periods** and **Special periods** accept postings. Closing a period is a controlled action. Variants: `/config/posting-period-variants` and its company assignment.
- **Exchange rates** (`/config/exchange-rates`): the rates used for foreign-currency documents and valuation.

> [!WARNING]
> A document dated in a closed period is refused. Ask the administrator to open the period; do not change the date unless it is genuinely wrong.

## 8. Tax codes, payment terms and payment methods

- **Tax codes** (`/config/tax-codes`): **Country**, **Tax Code** (e.g. `V1`), **Tax Type (condition)** (up to four characters, e.g. `VST`), **Account Key** (optional, up to three), **Tax Rate %**, **Description**. Invoices calculate tax at the code's rate. Deleting a code removes it from future tax determination; the screen shows **Used by (lines)** for each code.
- **Payment terms** (`/config/payment-terms`): **Terms code**, **Baseline source**, **Description**, discount tiers (days and percentage, e.g. 10 days 2%), net due date, **Active**, **Reason / maintenance note**. A **Saved due-date preview** shows the dates a sample invoice would get. *Unused discount: leave days blank and percentage 0.00; enabled discounts must precede the net due date.*
- **Payment methods** (`/config/payment-methods`): **Country**, **Method code**, **Allowed direction**, **Description**, **Active**.
- **Special G/L indicators** (`/config/special-gl`) and **tolerance groups** (`/config/tolerance-groups`) govern down payments and payment differences.

## 9. Credit control areas

`/config/credit-control-areas`: **Credit control area** (four letters or digits), **Company Code**, **Name**, **Currency** (taken from the company code), **Warning threshold** (% of the credit limit), **Reason for setup**. Customer limits are then kept at `/finance/credit` ([daily transactions](daily-transactions.md#35-credit-management)).

## Checklist: ready to post?

1. Company code has a chart of accounts, fiscal-year variant and an **open** posting period.
2. Every G/L account you use is extended to the company, not blocked.
3. Document type exists with a number range.
4. Partner has a reconciliation account.
5. Tax code exists for taxable lines.
6. Cost / profit centres are valid on the posting date.

---

**← Previous** [FICO overview](overview.md) · **Next →** [FICO daily transactions](daily-transactions.md)
