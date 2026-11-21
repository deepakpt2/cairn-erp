# PP — Daily Transactions

Plan, produce, confirm and cost — step by step, with what each step does to stock and accounting.

## Table of Contents

- [1. Run planning (MRP)](#1-run-planning-mrp)
- [2. Create and release a production order](#2-create-and-release-a-production-order)
- [3. Convert a planned order](#3-convert-a-planned-order)
- [4. Check availability of components](#4-check-availability-of-components)
- [5. Issue components to the order](#5-issue-components-to-the-order)
- [6. Confirm the work](#6-confirm-the-work)
- [7. Receive the finished goods](#7-receive-the-finished-goods)
- [8. Technically complete the order](#8-technically-complete-the-order)
- [9. Work in process and settlement](#9-work-in-process-and-settlement)
- [10. Reprocess failed goods movements](#10-reprocess-failed-goods-movements)

> [!IMPORTANT]
> **Prerequisites**
> - Production master data exists: BOM (status *Released*), work centre, routing and a **production version** for the product ([PP master data](master-data.md)).
> - Components have stock in the plant ([MM daily transactions → Goods receipt](../02-mm-materials-management/daily-transactions.md#4-post-a-goods-receipt)).
> - An **order type** (e.g. `PP01`) exists (administrator).
> - You hold the authority for each step; screens say *"You do not hold the … capability"* if not.

**Sample:** make **500 PC** of `FG-LOAF-500` in plant `1000`, using BOM base 100 PC = 40 KG flour + 1.2 KG yeast. So the order needs 200 KG flour and 6 KG yeast.

---

## 1. Run planning (MRP)

**Screen:** *Total planning* — `/production/mrp-run` (**PP → Material requirements planning → Planning runs & lists**). Related: *Single-item planning* (`/production/single-item-planning`), *Single-level planning* (`/production/single-level-planning`).

1. **Plant from** `1000` *(mandatory)*, **Plant to** `1000`.
2. **Processing key**: *Net change* (only materials that changed), *Net change in horizon*, or *Regenerative* (plan everything again — also tick the confirmation box, which needs a special authority).
3. Optional filters: **Horizon start/end**, **MRP controller**, **Material from/to**.
4. **Execution mode**: *Foreground (up to 40 materials)* or *Background (plant run, any size)*. A background run is queued; you can leave the page and watch its progress in the list below.
5. Click **Check** first — it writes nothing and tells you what would be planned. Then click **Plan**.
6. The result *Run N* says how many materials were planned and lists the proposals. **Cancel run** stops a queued run.

> [!NOTE]
> **What happens in the background?**
> A run compares demand (orders, requirements) with stock and supply and **writes proposals only**: planned orders (make) and purchase requisitions (buy). It posts **no** material document, journal or stock. A make proposal is exploded through its production version. You review results in *Stock/requirements list* and *MRP exception monitor* ([Reports](reports-and-troubleshooting.md)).

## 2. Create and release a production order

**Screen:** *Create production order* — `/production/orders` (command box `CO01`).

1. Under **Order header** fill:
   - **Material to be produced** `FG-LOAF-500` — *mandatory*.
   - **Plant** `1000` — *mandatory*; the company code is derived from it and never typed, and the material must be extended to the plant.
   - **Order type** `PP01` — *mandatory* (≤ 4 characters).
   - **Order quantity** `500` — *mandatory*, positive.
   - **Batch** — optional; an existing batch for batch-managed products.
   - **Scheduled start**, **Scheduled finish** — *mandatory*, default today.
   - **Production version** `0001` — optional; if several versions qualify and you leave it blank you are asked to choose.
2. Click **Check the bill of material**. The **Components** table shows each **Item**, **BOM item**, **Material**, **Source material**, **Plant** and **Required quantity** (200 KG flour, 6 KG yeast). *You cannot type components here — they come from the version's BOM.*
3. Click **Create the order**. The order number appears; status is **CREATED**.
4. **Release.** In the **Release** panel enter the **Order number** and click **Release the order**. Status becomes **RELEASED**; *Released by* and the time are recorded. Releasing twice changes nothing.

> [!NOTE]
> **What happens in the background?**
> - **Creation** saves a **snapshot** of the components and operations. A later BOM change does *not* alter this order.
> - It posts **no stock and no accounting**.
> - A **CREATED** order is demand/supply for planning but **cannot be charged**; only **release** lets goods be issued and work confirmed.
> - To change quantity, dates or components before any goods movement: *Change production order* (`/production/production-order-change`), then **Save**. Quantity changes do *not* rescale components.

## 3. Convert a planned order

When planning proposes a planned order, turn it into a production order.

**Screen:** *Convert planned order* — `/production/planned-order-conversion` (**Collective conversion** `/production/planned-order-conversion-collective` does several at once; *Create planned order* `/production/planned-order-create` makes one by hand; *Change* / *Display planned order* also exist).

1. Search by **Plant**, **Material** or **Planned order** and click **Find**; open the order.
2. Enter **Order type** (`PP01`; *mandatory* — nothing implies one) and, if the order type parameters use manual selection, the **Production version**.
3. Tick the confirmation box and click **Convert**. The result shows the new production order number.

*Background:* the planned order is replaced by the production order (status **CREATED**); components are copied from the BOM. No stock or accounting posting.

To create a planned order by hand: **Plant**, **Material**, **Quantity**, **Unit** (default the material's base unit), **Start**, **Finish**, optional **Reference planned order**, click **Create**.

## 4. Check availability of components

**Screen:** *Availability check for an order* — `/production/order-availability`.

1. Open the order and run the check. Each component shows whether stock covers it.
2. You can **commit** or **reset** a component independently. A commitment is the full requirement or nothing, and is recorded in a ledger so later checks see it.

*Background:* a commitment does **not** reserve or move physical stock; it only reduces what later checks regard as available.

## 5. Issue components to the order

Use **Goods movement** (`/inventory/migo`): **Action** `A07 Goods issue`, **Reference** `R08 Order` → *Goods issue to a production order* (movement `261`).

1. Enter the **Production order**.
2. For each component line: **Material**, **Plant**, **Storage location**, **Quantity**, optional **Batch**, and the order's **Component item** if it has duplicates.
3. Set **Posting date** and **Document date**; post.

> [!NOTE]
> **What happens in the background?**
> - **Stock** of each component decreases in the plant.
> - **Accounting:** one journal — **Debit** the production-consumption account (collected on the order), **Credit** inventory — at the component's price. These lines are what the *Production order cost report* sums.
> - The order must be **RELEASED** (or technically completed). Issuing against a CREATED order is refused.
> - The order shows what has been issued; the quantity cannot exceed what is open on the component.
> - If a component is marked for **backflush** (MRP view), you can skip this step: confirming does it ([Step 6](#6-confirm-the-work)).

## 6. Confirm the work

**Screen:** *Enter order confirmation* — `/production/order-confirmation` (`CO15`). Also *Enter time ticket* (`/production/time-ticket`) to confirm one operation; *Cancel production order confirmation* (`/production/confirmation-cancel`); *Display production confirmations* (`/production/confirmation-display`).

1. Open the order: type its **Production order** number (or filter by **Plant**, **Material**, **Production version**) and click **Open**. The table lists **Execution order**, **Operation**, **Work center**, **Confirmed**.
2. Choose **Confirmation type** — **Partial** or **Final**. *Final* needs the **final confirmation** box ticked as a safety. Mandatory.
3. **Posting date** — *mandatory*.
4. Enter at least one quantity: **Yield quantity** (good pieces, e.g. `500`), **Scrap quantity**, **Rework quantity**. A confirmation without a quantity is refused.
5. Optional: **Execution start/finish** date and time (finish must not be before start) and a **Note** (≤ 200 characters).
6. Click **Check** — it writes nothing and shows the goods movements that *would* result. Then click **Save**.

| Refusal | Meaning |
|---|---|
| *The order is not released. Nothing was saved.* | Release it first |
| *A confirmation needs a quantity.* | Enter yield, scrap or rework |
| *A confirmation type is required.* | Choose Partial or Final |
| *The production order was changed by someone else.* | Reopen and retry |

> [!NOTE]
> **What happens in the background?**
> - The confirmation records the quantity once on the order header and on eligible operations.
> - **Backflush:** components marked *Withdraw components on a confirmation* are issued automatically in proportion to the yield over the order quantity (capped by what is still open).
> - **Final confirmation + automatic goods receipt:** a material marked *Receive the finished good on a final confirmation* is received into stock.
> - Confirmed **activity** (machine/labour time) is costed to the order when an activity-costing run posts it ([Step 9](#9-work-in-process-and-settlement)).
> - A confirmation can be **cancelled**, which reverses its effects.

## 7. Receive the finished goods

If automatic goods receipt is off, post it yourself with **Goods movement** (`/inventory/migo`): **Action** `A01 Goods receipt`, **Reference** `R08 Order` (movement `101`).

1. Enter the **Production order**; confirm **Quantity**, **Plant**, **Storage location**, **Batch** (if managed).
2. Set dates and post.

> [!NOTE]
> **What happens in the background?**
> - **Stock** of the finished product **increases**.
> - **Accounting:** **Debit** inventory, **Credit** the production-output account, valued at the material's own price in the plant — the receipt says what the product is worth, not what it cost to make. The order is never edited; what has been received is read from these documents.
> - A difference between what the order collected (debits) and what was received (credit) is the order's balance, cleared by settlement.

## 8. Technically complete the order

When production is finished: *Change production order* (`/production/production-order-change`) → open the order → click **Technically complete**. Status becomes **TECHNICALLY_COMPLETED**. **Revoke technical completion** undoes it.

*Background:* planning stops treating the order as open supply. Goods receipts, issues and confirmations are still possible. It is a prerequisite for **final settlement**. No posting.

## 9. Work in process and settlement

Screen: *Production order settlement* — `/production/order-settlement` (**PP → Production orders → Order costs & settlement**). Authority `PROD.ORDER.SETTLE`.

**Settle a completed order**
1. Enter **Production order**, **Fiscal year**, **Settlement period**, and (only to check the order) **Controlling area**.
2. Click **Simulate** to preview; then **Update** to post.

*Background:* settlement reads the order's collected costs from the journal, nets debits against credits per G/L account, and posts the remaining balance to the receivers configured in a settlement profile. It **refuses** an order that is not technically completed and **unwinds any WIP** in the same step. If no profile, allocation and distribution rule exist the screen says where the balance would go cannot be decided — nothing is invented.

**Period-end WIP (unfinished orders).** On the same screen, **Work in process (period end)**: enter **Production order**, **Fiscal year**, **Period** and post. *Background:* for a **released** order, the cost debits less output credits up to period end are capitalised as WIP on the balance sheet; the next period unwinds it.

**Confirmed activity not yet costed.** Enter the **Production order** and click **Preview cost**, then **Post cost** to value confirmed machine/labour time.

To read the result: *Production order cost report* (`/production/order-cost-report`) — **Order**, optional **Fiscal year**, **Period from/to**, click **Read posted costs**.

## 10. Reprocess failed goods movements

A confirmation can leave a component issue or product receipt **unposted** (for example because the stock was not there). These are held on **Reprocess failed production goods movements** — `/production/cogi` (`COGI`; **PP → Production monitoring → Failed goods movements**).

1. Filter by **Status**, **Order**, **Operation**, **Plant** and open the failure. It shows the movement kind, confirmation, order, operation and status.
2. **Correct movement details** (optional): only **Quantity** (never above the confirmed quantity), **Storage location** and **Batch** can change. Enter a **Reason for correction** (mandatory, ≤ 200 characters) and click **Save correction revision**. A saved revision does not post by itself.
3. **Reprocess this movement:** tick *I have reviewed the movement and confirm it should now be posted* and click **Reprocess goods movement**.
4. Or **Discard the incorrect movement:** enter a **Discard reason** (mandatory), tick the confirmation and click **Retain as discarded**. Reservations and order quantities are *not* adjusted.

*Background:* reprocessing posts the normal material document (stock and journal as in Steps 5 and 7) exactly once — retrying an already-posted movement does not create a second document. A movement whose source confirmation was cancelled is **Blocked** and can only be kept for review or discarded.

---

**← Previous** [PP master data](master-data.md) · **Next →** [PP reports and troubleshooting](reports-and-troubleshooting.md)
