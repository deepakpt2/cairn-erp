# Workflow: Plan to Produce

From "what do we need to make?" to "the finished loaves are in stock and the cost is settled".

## Table of Contents

- [The story](#the-story)
- [The whole flow at a glance](#the-whole-flow-at-a-glance)
- [Step 1 — Master data in place](#step-1--master-data-in-place)
- [Step 2 — Planning run](#step-2--planning-run)
- [Step 3 — Production order](#step-3--production-order)
- [Step 4 — Check and issue components](#step-4--check-and-issue-components)
- [Step 5 — Confirm the work](#step-5--confirm-the-work)
- [Step 6 — Receive the finished goods](#step-6--receive-the-finished-goods)
- [Step 7 — Complete and settle](#step-7--complete-and-settle)
- [Step 8 — Check the result](#step-8--check-the-result)
- [What can go wrong, and where to look](#what-can-go-wrong-and-where-to-look)

> [!IMPORTANT]
> **Prerequisites**
> - Master data: finished material `FG-LOAF-500`, component `RM-FLOUR-25`, a released **BOM**, a **routing**, a **work centre** and a **production version** ([PP master data](../03-pp-production-planning/master-data.md)).
> - Component stock is available (see [Procure to pay](procure-to-pay.md)).
> - Roles: **planner**, **production clerk**, **controller**; plus an open posting period.

## The story

Demand for 500 loaves exists. Planning finds that it needs 200 kg of flour, the clerk makes a production order, the bakers use the flour, report their work, and the loaves go into stock. At month-end the controller settles what the order cost.

## The whole flow at a glance

| # | Step | Screen | Stock | Books |
|---|---|---|---|---|
| 1 | Master data | `/production/boms`, `/production/routings`, `/production/work-centers`, `/production/production-versions` | — | — |
| 2 | Planning run | `/production/mrp-run` | — | — |
| 3 | Production order create + **release** | `/production/orders` | — | — |
| 4 | Issue components (`261`) | `/inventory/migo` | Flour **−200 kg** | **Dr** Production consumption / **Cr** Inventory |
| 5 | Confirmation | `/production/order-confirmation` | (backflush components, if set) | — |
| 6 | Goods receipt from order (`101`) | `/inventory/migo` | Loaves **+500** | **Dr** Inventory / **Cr** Production output |
| 7 | Technically complete, then settle | `/production/production-order-change`, `/production/order-settlement` | — | Order balance cleared to its receivers |

Order status: **CREATED → RELEASED → TECHNICALLY_COMPLETED**.

## Step 1 — Master data in place

The **BOM** (what goes into one loaf), **routing** (how it is made), **work centre** (where) and **production version** (which BOM and routing go together). See [PP master data](../03-pp-production-planning/master-data.md#how-the-four-fit-together).

## Step 2 — Planning run

**Total planning** compares requirements with stock and supply and proposes **planned orders** (for made items) and **purchase requisitions** (for bought items). Instructions: [Run planning (MRP)](../03-pp-production-planning/daily-transactions.md#1-run-planning-mrp), and read results in the stock/requirements list.

> [!NOTE]
> **What Happens in the Background?** Planning posts nothing and moves no stock. It reads open sales orders ([SD](order-to-cash.md)), stock, open orders and requisitions, and writes proposals. Shortages of flour become requisitions that start [Procure to pay](procure-to-pay.md).

## Step 3 — Production order

Either **convert the planned order** ([PP §3](../03-pp-production-planning/daily-transactions.md#3-convert-a-planned-order)) or [create the order directly](../03-pp-production-planning/daily-transactions.md#2-create-and-release-a-production-order): **Material** `FG-LOAF-500`, **Plant** `1000`, **Order type** `PP01`, **Order quantity** `500`, scheduled dates, then **Check the bill of material**, **Create the order**, and **Release the order**.

> [!NOTE]
> **What Happens in the Background?** Creation saves a **snapshot** of components and operations: later BOM changes do not alter this order. No stock or accounting posts. Only a **RELEASED** order can have goods issued or work confirmed.

## Step 4 — Check and issue components

[Check availability](../03-pp-production-planning/daily-transactions.md#4-check-availability-of-components), then [issue the components](../03-pp-production-planning/daily-transactions.md#5-issue-components-to-the-order) with **Goods movement** (`/inventory/migo`): Action `A07 Goods issue`, Reference `R08 Order` (movement `261`), flour `200 KG`.

> [!NOTE]
> **What Happens in the Background?** Flour stock falls; **Dr** production-consumption (collected on the order) / **Cr** inventory at the component's price. If the component is flagged **backflush**, skip this step: the confirmation issues it.

## Step 5 — Confirm the work

[Confirm the work](../03-pp-production-planning/daily-transactions.md#6-confirm-the-work): enter the yield, scrap and the time worked per operation. Failed automatic goods movements land in **COGI** ([PP §10](../03-pp-production-planning/daily-transactions.md#10-reprocess-failed-goods-movements)).

> [!NOTE]
> **What Happens in the Background?** A confirmation records progress and activity. It may trigger the automatic goods movements (backflush, automatic receipt). Confirmed machine or labour time can be costed later in the settlement screen.

## Step 6 — Receive the finished goods

[Receive the finished goods](../03-pp-production-planning/daily-transactions.md#7-receive-the-finished-goods) with Action `A01 Goods receipt`, Reference `R08 Order` (movement `101`), quantity `500`.

> [!NOTE]
> **What Happens in the Background?** Loaf stock rises by 500; **Dr** inventory / **Cr** production output at the material's own price. The difference between what the order collected (consumption debits) and the value received is the **order balance**, cleared in step 7.

## Step 7 — Complete and settle

1. [Technically complete the order](../03-pp-production-planning/daily-transactions.md#8-technically-complete-the-order). Planning stops counting it as open supply.
2. [Settle](../03-pp-production-planning/daily-transactions.md#9-work-in-process-and-settlement): **Simulate**, then **Update**. Unfinished orders at period end get a **Work in process** posting instead.

> [!NOTE]
> **What Happens in the Background?** Settlement nets the order's debits and credits per G/L account and posts the remaining balance to the receivers of the settlement profile. It is the one step that turns "the order collected cost" into "the cost sits where finance expects it".

## Step 8 — Check the result

| Question | Where |
|---|---|
| Is the stock right? | [Stock reports](../02-mm-materials-management/reports-and-troubleshooting.md#stock-reports) |
| What did the order cost? | `/production/order-cost-report` ([PP reports](../03-pp-production-planning/reports-and-troubleshooting.md#order-reports)) |
| Did every goods movement post? | **COGI** failed-movements list |
| Do the books agree? | [Trial balance](../05-fico-finance-controlling/reports-and-troubleshooting.md#financial-statements) |

## What can go wrong, and where to look

| Symptom | Cause | Where |
|---|---|---|
| Cannot issue goods: order not released | Order still **CREATED** | Release it |
| Component missing in the order | BOM item not valid / wrong production version | [PP master data](../03-pp-production-planning/master-data.md#1-bill-of-material-bom) |
| Receipt posts nothing to the books? | By design only value is posted; check the material's valuation price | [PP reports](../03-pp-production-planning/reports-and-troubleshooting.md#common-messages-and-what-to-do) |
| Settlement refused | Order not technically complete, or no settlement profile | [PP §9](../03-pp-production-planning/daily-transactions.md#9-work-in-process-and-settlement) |

---

**← Previous** [Procure to pay](procure-to-pay.md) · **Next →** [Order to cash](order-to-cash.md)
