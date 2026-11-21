# Workflow: Procure to Pay

From "we need flour" to "the supplier has been paid", showing exactly what each step does to stock, to the books and to the open invoice.

## Table of Contents

- [The story](#the-story)
- [The whole flow at a glance](#the-whole-flow-at-a-glance)
- [Step 1 — Requisition](#step-1--requisition)
- [Step 2 — Purchase order](#step-2--purchase-order)
- [Step 3 — Goods receipt](#step-3--goods-receipt)
- [Step 4 — Invoice verification](#step-4--invoice-verification)
- [Step 5 — Payment](#step-5--payment)
- [Step 6 — Check the result](#step-6--check-the-result)
- [What can go wrong, and where to look](#what-can-go-wrong-and-where-to-look)

> [!IMPORTANT]
> **Prerequisites**
> - Master data: material `RM-FLOUR-25` extended to plant `1000` with purchasing and accounting views ([MM master data](../02-mm-materials-management/master-data.md#1-the-material-master)); supplier `SUP-1000` extended to company `1000` with a reconciliation account ([MM suppliers](../02-mm-materials-management/master-data.md#2-suppliers-business-partners)); a house bank account ([FICO banks](../05-fico-finance-controlling/master-data.md#6-banks-and-house-banks)).
> - Roles: a **buyer** (purchasing), a **warehouse clerk** (goods receipt) and an **accountant** (payment). In practice these are often three different people.
> - Open posting period for the dates you use.

## The story

The bakery plans to make 500 loaves and needs **200 kg of flour**. Nobody holds that stock, so purchasing buys it from `SUP-1000`, the warehouse receives it, accounting checks the supplier's invoice and finance pays it.

## The whole flow at a glance

| # | Step | Screen | Stock | Books | Open item |
|---|---|---|---|---|---|
| 1 | Requisition | `/purchasing/requisitions` | — | — | — |
| 2 | Purchase order | `/purchasing/orders` | — | — | — |
| 3 | Goods receipt | `/inventory/goods-receipt` | **+200 kg** (movement `101`) | **Dr** Inventory / **Cr** GR/IR clearing | — |
| 4 | Invoice verification | `/purchasing/invoice-verification` | — | **Dr** GR/IR, **Dr** input tax / **Cr** supplier reconciliation account | **Supplier owed** |
| 5 | Payment | `/finance/outgoing-payment` or `/finance/payment-run` | — | **Dr** supplier reconciliation account / **Cr** bank | **Cleared** |

Only steps 3, 4 and 5 touch the books. Steps 1 and 2 are promises.

## Step 1 — Requisition

An internal request: material `RM-FLOUR-25`, plant `1000`, storage location `0001`, purchasing group `001`, quantity `200`, needed-by date. Full instructions: [Create a purchase requisition](../02-mm-materials-management/daily-transactions.md#1-create-a-purchase-requisition).

> [!NOTE]
> **What Happens in the Background?** Nothing is posted and no stock moves. Planning (MRP) may also create requisitions automatically ([PP planning](../03-pp-production-planning/daily-transactions.md#1-run-planning-mrp)).

## Step 2 — Purchase order

The buyer turns the requisition into a purchase order to `SUP-1000`: purchasing organisation `1000`, group `001`, company code, currency, quantity, price, delivery date. Instructions: [Create a purchase order](../02-mm-materials-management/daily-transactions.md#3-create-a-purchase-order). Quotations can be compared first ([step 2 there](../02-mm-materials-management/daily-transactions.md#2-request-and-compare-quotations)).

> [!NOTE]
> **What Happens in the Background?** The order is a commitment, not a posting. The ordered quantity appears as *expected supply* in the stock/requirements list. A release strategy may need an approver before the order can be sent.

## Step 3 — Goods receipt

The truck arrives. The warehouse clerk opens `/inventory/goods-receipt`, loads the order number, enters the **Receipt quantity** `200` and the **Storage location**, and clicks **Post goods receipt**. Instructions: [Post a goods receipt](../02-mm-materials-management/daily-transactions.md#4-post-a-goods-receipt).

> [!NOTE]
> **What Happens in the Background?**
> - **Stock** of `RM-FLOUR-25` rises by 200 kg.
> - **Books:** **Dr** raw-materials inventory / **Cr** GR/IR clearing, at the order price. GR/IR ("goods received, not invoiced") is the bridge account that waits for the invoice.
> - The order item shows **Received 200, Remaining 0**.
> - Wrong receipt? Reverse it with a return delivery or document reversal ([MM §5](../02-mm-materials-management/daily-transactions.md#5-return-goods-to-a-supplier-or-reverse-a-document)); never edit it.

## Step 4 — Invoice verification

The invoice arrives. The accountant opens `/purchasing/invoice-verification`, loads the order, enters the **Supplier invoice number**, **Gross amount**, dates, and per item the **Quantity**, **Net amount** and **Tax code**, then clicks **Post invoice**. Instructions: [Enter an incoming invoice](../02-mm-materials-management/daily-transactions.md#6-enter-an-incoming-invoice).

> [!NOTE]
> **What Happens in the Background?**
> - **Books:** **Dr** GR/IR clearing (the value received), **Dr** input tax / **Cr** the supplier's reconciliation account (Trade payables). A price difference between order and invoice posts to a price-difference account.
> - GR/IR for that item returns to zero: what was received has now been invoiced.
> - The supplier's **open item** exists and now shows in vendor balances and ageing.
> - **Stock is unchanged** — it already went up at step 3.
> - Mismatch? The invoice is refused or can be parked/blocked ([MM reports](../02-mm-materials-management/reports-and-troubleshooting.md#common-messages-and-what-to-do)).

## Step 5 — Payment

Finance pays on the due date, either:

- **One supplier:** [Post outgoing payment](../05-fico-finance-controlling/daily-transactions.md#23-pay-the-vendor-outgoing-payment) — load the supplier's open items, tick the invoice, enter the bank account `101000` and amount, post.
- **Many suppliers:** [Payment run](../05-fico-finance-controlling/daily-transactions.md#24-pay-many-vendors-payment-run) — parameters, proposal, release by a second person, execute.

> [!NOTE]
> **What Happens in the Background?** **Dr** supplier reconciliation account / **Cr** bank. The invoice open item is **cleared** under the payment document. The supplier balance falls to zero for that invoice. Cash discount, if any, is judged against the payment terms.

## Step 6 — Check the result

| Question | Screen | Look for |
|---|---|---|
| Is the flour in stock? | `/inventory/stock-overview` (see [stock reports](../02-mm-materials-management/reports-and-troubleshooting.md#stock-reports)) | +200 kg |
| Is GR/IR clear? | [Purchasing reports](../02-mm-materials-management/reports-and-troubleshooting.md#purchasing-reports) | Zero for the item |
| Does the supplier still have an open item? | [Vendor balances / ageing](../05-fico-finance-controlling/reports-and-troubleshooting.md#customer-and-vendor-reports) | Cleared |
| Does the ledger tie to the subledger? | [Subledger tie-out](../05-fico-finance-controlling/reports-and-troubleshooting.md#period-end-and-control-reports) | **TIED** |

## What can go wrong, and where to look

| Symptom | Likely cause | Where |
|---|---|---|
| Goods receipt refused: material not extended to plant | Plant view missing | [MM master data](../02-mm-materials-management/master-data.md#extend-the-material-to-a-plant-purchasing-mrp-accounting) |
| Invoice refused: quantity above received | Invoicing before receiving | Post the goods receipt first |
| Invoice posts but the payment run skips it | Payment block, or due date after "Next payment date" | [Payment run](../05-fico-finance-controlling/daily-transactions.md#24-pay-many-vendors-payment-run) exceptions |
| Payment refused: period closed | Posting period not open | [FICO posting periods](../05-fico-finance-controlling/master-data.md#7-document-types-number-ranges-and-posting-periods) |

---

**← Previous** [HR reports and troubleshooting](../06-hr-human-resources/reports-and-troubleshooting.md) · **Next →** [Plan to produce](plan-to-produce.md)
