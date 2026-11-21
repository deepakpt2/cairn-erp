# Workflow: Order to Cash

From "the customer wants 200 chocolate wafers" to "the customer's money is in the bank".

## Table of Contents

- [The story](#the-story)
- [The whole flow at a glance](#the-whole-flow-at-a-glance)
- [Step 1 — Master data and price](#step-1--master-data-and-price)
- [Step 2 — Quotation (optional)](#step-2--quotation-optional)
- [Step 3 — Sales order](#step-3--sales-order)
- [Step 4 — Credit check and release](#step-4--credit-check-and-release)
- [Step 5 — Delivery, picking and goods issue](#step-5--delivery-picking-and-goods-issue)
- [Step 6 — Billing](#step-6--billing)
- [Step 7 — Incoming payment](#step-7--incoming-payment)
- [Step 8 — Check the result](#step-8--check-the-result)
- [When something goes back](#when-something-goes-back)
- [What can go wrong, and where to look](#what-can-go-wrong-and-where-to-look)

> [!IMPORTANT]
> **Prerequisites**
> - Customer `CUS-1000` with the customer role, sales-area defaults for `1000 / 01 / 01` and a reconciliation account ([SD master data](../04-sd-sales-distribution/master-data.md#1-the-customer-master)).
> - Material `FG-WAFER` with a Sales view for that area, extended to plant `1000`, **in stock** (see [Plan to produce](plan-to-produce.md)).
> - A valid price in a condition record ([prices](../04-sd-sales-distribution/master-data.md#3-prices-condition-records)).
> - Roles: **sales clerk**, **warehouse clerk**, **credit controller** (only if blocked), **accountant**.

## The story

`CUS-1000` orders 200 wafers. Sales enters the order; the warehouse picks and ships; billing invoices what was shipped; the customer pays and finance matches the payment to the invoice.

## The whole flow at a glance

| # | Step | Screen | Stock | Books | Open item |
|---|---|---|---|---|---|
| 2 | Quotation (optional) | `/sales/quotations` | — | — | — |
| 3 | Sales order | `/sales/orders` | — (availability is checked, nothing reserved) | — | — |
| 4 | Credit release (if blocked) | `/finance/credit-release` | — | — | — |
| 5 | Delivery + goods issue (`601`) | `/sales/delivery` | **−200** | **Dr** Cost of goods sold / **Cr** Inventory | — |
| 6 | Billing | `/sales/billing` | — | **Dr** Customer receivable / **Cr** Revenue, **Cr** Output tax | **Customer owes** |
| 7 | Incoming payment | `/finance/incoming-payment` | — | **Dr** Bank / **Cr** Customer receivable | **Cleared** |

## Step 1 — Master data and price

Checklist: [can I sell this to that customer?](../04-sd-sales-distribution/master-data.md#checklist-can-i-sell-this-to-that-customer). A missing price is the most common blocker: the order's price is *found*, never typed.

## Step 2 — Quotation (optional)

[Create a quotation](../04-sd-sales-distribution/daily-transactions.md#1-create-a-sales-quotation) with **Valid to**, and when the customer accepts, **Raise a sales order** from it.

> [!NOTE]
> **What Happens in the Background?** Nothing is posted. An open quotation past its **Valid to** date is marked `EXPIRED` and cannot become an order.

## Step 3 — Sales order

[Create the order](../04-sd-sales-distribution/daily-transactions.md#2-create-a-sales-order): **Customer** `CUS-1000`, sales area `1000 / 01 / 01`, **Company code** `1000`, **Currency** `KWD`; item **Material** `FG-WAFER`, **Plant** `1000`, **Quantity** `200`, **Unit** `PC`. Click **Create order** and use [Check availability](../04-sd-sales-distribution/daily-transactions.md#3-check-availability-change-or-cancel-an-order).

> [!NOTE]
> **What Happens in the Background?** **No stock is reserved and nothing is posted.** The price is read from condition records and stored on each line as **Priced from**. The customer's credit is checked. Open order quantities count as demand in planning ([Plan to produce](plan-to-produce.md#step-2--planning-run)).

## Step 4 — Credit check and release

If the customer is over their limit the order is **blocked, not lost**. A credit controller opens [Release credit-blocked documents](../05-fico-finance-controlling/daily-transactions.md#35-credit-management), clicks **Recheck**, then **Release** with a **Reason (required)**. The clerk repeats the blocked step.

> [!NOTE]
> **What Happens in the Background?** Credit is judged when the order is saved, when the delivery is created and again at goods issue, from the customer's open receivables across the credit control area. Release changes the block only.

## Step 5 — Delivery, picking and goods issue

[Create the delivery](../04-sd-sales-distribution/daily-transactions.md#4-create-a-delivery-pick-and-post-the-goods-issue) from the order, **Confirm picking** (quantity, storage location, batch), and **Post the goods issue**.

> [!NOTE]
> **What Happens in the Background?**
> - Creating and picking move **nothing**.
> - **Goods issue (`601`):** wafer stock falls by 200; **Dr** cost of goods sold / **Cr** inventory at the material's valuation price. The order's **Delivered** rises and **Open** falls.
> - A reversed goods issue is not billable.

## Step 6 — Billing

[Bill the delivery](../04-sd-sales-distribution/daily-transactions.md#5-bill-the-delivery): **Bill a goods-issued delivery**, or **Bill the due list** for all.

> [!NOTE]
> **What Happens in the Background?** The invoice carries no price of its own: it bills the **order's price scaled to the quantity actually issued**. One live billing document per delivery. Posting: **Dr** customer reconciliation account (receivable) / **Cr** revenue (account found by revenue-account determination) / **Cr** output tax. The order's **Billed** rises and the customer's open item appears.

## Step 7 — Incoming payment

[Post incoming payment](../05-fico-finance-controlling/daily-transactions.md#32-post-an-incoming-payment): load `CUS-1000`'s open items, tick the invoice, enter the bank account `101000` and amount, post. Unpaid and overdue items go through [dunning](../05-fico-finance-controlling/daily-transactions.md#34-dunning).

> [!NOTE]
> **What Happens in the Background?** **Dr** bank / **Cr** customer reconciliation account; the invoice is **cleared** under the payment document. Customer balance and ageing fall.

## Step 8 — Check the result

| Question | Where |
|---|---|
| What happened to this order? | [Sales documents register](../04-sd-sales-distribution/reports-and-troubleshooting.md#sales-documents-register) (the *Raised against* column links the chain) |
| Is anything held back? | [Incomplete documents](../04-sd-sales-distribution/reports-and-troubleshooting.md#incomplete-documents) |
| Who still owes us? | [Customer ageing](../05-fico-finance-controlling/reports-and-troubleshooting.md#customer-and-vendor-reports) |
| How are we selling? | [Sales analysis](../04-sd-sales-distribution/reports-and-troubleshooting.md#sales-analysis) |

## When something goes back

| Situation | Do this |
|---|---|
| Wrong price or damaged goods, goods stay with customer | [Credit memo request → release → credit memo](../04-sd-sales-distribution/daily-transactions.md#8-credit-memos) |
| Customer returns goods | [Returns order → returns delivery → receipt](../04-sd-sales-distribution/daily-transactions.md#7-returns): goods enter non-valued **returns stock** and no journal posts; then a credit memo returns the money |
| Wrong invoice | Cancel the billing document (frees the delivery to be billed again) |

## What can go wrong, and where to look

| Symptom | Cause | Where |
|---|---|---|
| Order refused: no sales-area data | Customer not set up for the area | [Customer sales-area defaults](../04-sd-sales-distribution/master-data.md#11-customer-sales-area-defaults) |
| No price | No condition record valid on the date | [Condition records](../04-sd-sales-distribution/master-data.md#3-prices-condition-records) |
| "is credit-blocked" | Over limit | Step 4 |
| Billing refused: not goods-issued | Skipped goods issue | Step 5 |
| Goods issue refused: not enough stock | Stock too low or wrong location | [Stock reports](../02-mm-materials-management/reports-and-troubleshooting.md#stock-reports) |

---

**← Previous** [Plan to produce](plan-to-produce.md) · **Next →** [Hire to retire](hire-to-retire.md)
