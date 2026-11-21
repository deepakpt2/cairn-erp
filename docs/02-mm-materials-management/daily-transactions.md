# MM — Daily Transactions

Step-by-step instructions for the work done every day in purchasing and the warehouse, with the effect each step has behind the scenes.

## Table of Contents

- [1. Create a purchase requisition](#1-create-a-purchase-requisition)
- [2. Request and compare quotations](#2-request-and-compare-quotations)
- [3. Create a purchase order](#3-create-a-purchase-order)
- [4. Post a goods receipt](#4-post-a-goods-receipt)
- [5. Return goods to a supplier, or reverse a document](#5-return-goods-to-a-supplier-or-reverse-a-document)
- [6. Enter an incoming invoice](#6-enter-an-incoming-invoice)
- [7. Issue goods (to a cost centre, or scrap)](#7-issue-goods-to-a-cost-centre-or-scrap)
- [8. Transfer stock](#8-transfer-stock)
- [9. Create a reservation](#9-create-a-reservation)
- [10. Count stock (physical inventory)](#10-count-stock-physical-inventory)
- [11. The all-in-one screen: Goods movement](#11-the-all-in-one-screen-goods-movement)

> [!IMPORTANT]
> **Prerequisites**
> - Master data exists: a **material** extended to the plant with Purchasing and Accounting views, a **supplier** with accounting and purchasing extensions, and (for goods issue to a cost centre) a **cost centre** ([MM master data](master-data.md)).
> - You hold the authority for each screen (screens show *"You do not hold the … capability"* otherwise) and business access to the company and plant.
> - The accounting period of the **posting date** is open (see [Troubleshooting](reports-and-troubleshooting.md#common-messages-and-what-to-do)).

Dates on every posting screen default to today. **Posting date** decides which accounting period the entry falls into; **Document date** is the date printed on the paper (delivery note, invoice). **Header text** is a free note of up to 25 characters.

**Sample data used below:** company `1000` (EUR), plant `1000` "Main bakery", storage location `0001`, material `RM-FLOUR-25` (KG), supplier `SUP-NORTHERN`, cost centre `CC1100`.

---

## 1. Create a purchase requisition

*A purchase requisition is an internal request: "we need this".* It commits no money.

**Screen:** *Create purchase requisition* — `/purchasing/requisitions` (**MM → Procurement → Purchase requisitions**).

1. Open the screen. Under **Release**, nothing is needed yet.
2. In the item table click **Add item** and fill one row:

   | Column | Example | Notes |
   |---|---|---|
   | **Material** | `RM-FLOUR-25` | Pick from the list; leave blank for a text item |
   | **Short text** | `Wheat flour, 25 kg sack` | **Mandatory** — from the material, or typed for a text item |
   | **Quantity** | `200` | |
   | **Unit** | `KG` | **Mandatory**; must be a valid unit |
   | **Delivery date** | next Friday | |
   | **Estimated price**, **Price unit**, **Currency** | `0.58`, `1`, `EUR` | A currency is required once you give a price |
   | **Plant**, **Storage location**, **Purchasing group** | `1000`, `0001`, `001` | The plant must exist; the location must be active at that plant |

3. For an item charged to a cost centre (not stock), fill the **account assignment** block: **Cost centre** `CC1100`, **G/L account**, **Distribution %** — percentages must total 100, the cost centre must be valid on the requisition date and not locked, and the G/L account must be a profit-and-loss account.
4. Click **Save requisition**. The system gives a requisition number.

> [!NOTE]
> **What happens in the background?**
> No stock changes and no accounting entry is made. The requisition is stored as a plan; planners and buyers see it, and it can be converted into an order. If a **release strategy** applies, the requisition must first be approved: under **Release** the approver chooses the **Release code** and clicks the release button (*Release step N*). Blocked or unreleased requisitions cannot be turned into orders.

## 2. Request and compare quotations

1. **Request for quotation** (`/purchasing/rfq`): list the material and quantity and the suppliers you are inviting.
2. **Quotation** (`/purchasing/quotation`): enter each supplier's reply (price, validity).
3. **Compare quotations** (`/purchasing/quotation-comparison`): see the offers side by side and choose the best.
4. The accepted quotation can be used for an info record or order. *Display quotation* (`/purchasing/quotation-display`) shows a finished one.

> [!NOTE]
> **What happens in the background?** Quotation documents are plans only: nothing is posted.

## 3. Create a purchase order

**Screen:** *Create purchase order* — `/purchasing/orders` (**MM → Procurement → Purchase orders**; command box `ME21N`).

1. Choose the order type: **Supplier order** (default) or **Stock transport order (plant to plant)**. The rest of this section is for a supplier order.
2. **Header → Org. data** tab:
   - **Supplier** — pick `SUP-NORTHERN`. *Mandatory.* A blocked supplier is refused.
   - **Purchasing organization** — e.g. `1000`. *Mandatory.*
   - **Purchasing group** — e.g. `001`. *Mandatory.*
   - **Company code** — `1000`. *Mandatory.*
   - **Currency** — `EUR`.
3. **Header → Delivery / Invoice** tab (optional): **Payment terms** (blank = the supplier's default), **Incoterms**, **Incoterms location** (e.g. `Hamburg`).
4. Click **Add item**. In the table fill **Material** `RM-FLOUR-25`, **Short text** (taken from the material), **Order quantity** `200`, **Order unit** `KG`, **Net price** `0.58`, **Price unit** `1`. If an info record exists the price and delivery time are proposed.
5. Select the item to open the **item detail** tabs: **Delivery schedule**, **Delivery**, **Invoice**, **Account assignment**, **Source**. On **Delivery** you can set tolerances and a plant/storage location; on **Account assignment** you can charge the item to a cost centre.
6. Optional: set the item as converted from a **requisition** (enter the requisition number and item — the material must be the same one).
7. Click **Save purchase order**. A purchase order number is shown. Use **Save changes** on later edits.

| Rule | What the system says if you break it |
|---|---|
| Supplier must exist and not be blocked | *Supplier … is blocked.* |
| Item needs a short text and an order unit | *A short text is required …* / *An order unit is required.* |
| Tax code must belong to the company's country | *Tax code … does not stand for country …* |
| Storage location must be active in the plant | *Storage location … does not stand active at plant …* |
| Tolerance 0–100 % | *A tolerance of …% does not stand between 0 and 100.* |
| Payment terms must exist | *Payment terms … do not stand for this client.* |

> [!NOTE]
> **What happens in the background?**
> Saving the order **does not change stock or post accounting**. It records the commitment and fixes who will deliver what, at what price. If a **release strategy** applies, the order has a **Release** panel showing the strategy and steps (e.g. `1. A · 2. B`); the approver chooses a code and clicks **Release step N**. The order cannot be received until fully released. Use the **Display purchase order** screen (`/purchasing/purchase-order-display`) to review it read-only.

## 4. Post a goods receipt

**Screen:** *Post goods receipt* — `/inventory/goods-receipt` (**MM → Inventory management → Goods movements**).

1. Under **Operation and reference** keep **Operation** = goods receipt, type the **Order number** (the purchase order from step 3) and click **Load reference**.
2. The page **Goods receipt for order …** lists each item with **Ordered**, **Received**, **Remaining** and **Overdelivery**.
3. Set **Document date** and **Posting date** (default today); optionally **Header text**.
4. For each item you are receiving enter **Receipt quantity** (e.g. `200`), confirm the **Storage location** (proposed from the order) and, for batch-managed materials, the **Batch**. Leave a row at `0` to receive nothing for it.
5. Click **Post goods receipt**. A message gives the material document number and the accounting document number.

Refusals you may meet: *No receipt quantities were entered.* · *Item N: the receipt quantity must be positive.* · *Material … is not extended to plant …* · *Material … is flagged for deletion.* · an over-delivery beyond the order's tolerance · an order still awaiting release. An item that is charged straight to a cost centre takes no goods receipt (it is invoiced directly).

> [!NOTE]
> **What happens in the background?**
> - **Stock:** the plant/storage-location stock of the material **increases** by the received quantity (movement type `101`), and the order item's **Received** quantity rises.
> - **Accounting:** one balanced journal is posted: **Debit** the material's *inventory* account, **Credit** the *GR/IR clearing* account, at the order price. For a standard-price material any price difference is posted to a price-difference account.
> - **Status:** the order item becomes partly or fully delivered; when received equals ordered, **Remaining** is zero.
> - The goods receipt is **a new document** — see §5 to correct it.

## 5. Return goods to a supplier, or reverse a document

**Return to a supplier** — *Return delivery to a vendor* (`/inventory/return-delivery`):
1. Type the **Material document** number of the goods receipt (and **Fiscal year** if needed) and click the load button (**Read the document**).
2. For each line enter the **Return quantity** (not above **Returnable**) and its **Unit**; set **Posting date** and **Document date**.
3. Click **Post the return**.

*Background:* the original receipt is **not** cancelled — it stands. A new material document reduces stock and reduces what counts as received on the order; the matching accounting entry reverses the value.

**Reverse a whole document** — *Reverse material document* (`/inventory/reversal`, SAP-style `MBST`):
1. Enter the **Material document** number (and **Fiscal year**) and click **Load document**.
2. Select the lines to reverse and set **Posting date**, **Document date**, **Header text**.
3. Click **Reverse**.

*Background:* a reversal posts an *opposite* document; the original is never edited or deleted. Stock and value of each reversed line come back. The accounting entry is reversed **once, when the last line is reversed**; until then the screen says accounting is not yet reversed. You cannot reverse a reversal, or a document already reversed.

## 6. Enter an incoming invoice

**Screen:** *Enter incoming invoice* — `/purchasing/invoice-verification` (**MM → Procurement → Invoice verification & GR/IR**). *Park supplier invoice* (`/purchasing/parked-invoice`) saves an invoice to finish later.

1. Under **Invoice header** type the **Order number** and click **Load reference**.
2. Fill the header:
   - **Supplier invoice number** — *mandatory*, ≤ 16 characters (the number printed on the supplier's invoice).
   - **Gross amount** — *mandatory*, the invoice total including tax.
   - **Invoice date** and **Posting date** — *mandatory*.
3. In the item table, for each item enter **Quantity** (what is invoiced; the screen shows **Ordered**, **Received**, **Invoiced** and **Invoiceable**), **Net amount (excl. tax)** and **Tax code**. Quantity must be positive and net cannot be negative.
4. If an advance payment was already made on this order, a table *Advances already paid against this order* lets you tick **Clear** and enter an amount to **clear now**.
5. Click **Post invoice**.

> [!NOTE]
> **What happens in the background?**
> - **Accounting:** one journal: **Debit** *GR/IR clearing* for the value received, **Debit** *tax* for input tax, a **Debit/Credit** to a *price-difference* account if invoiced and expected values differ, and **Credit** the supplier's *reconciliation account* for the full amount. The supplier now has an open item to pay.
> - **Order:** the item's **Invoiced** quantity rises. When invoiced equals received, the GR/IR balance of the item is zero.
> - **Stock:** unchanged — stock was increased at goods receipt.
> - To undo it, open the invoice and click **Cancel invoice** (a posting date is needed); a cancellation cannot itself be cancelled. *Place invoice payment hold* (`/purchasing/blocked-invoice`) blocks an invoice from payment; *Maintain GR/IR clearing* and *Reconcile GR/IR* are in [Reports](reports-and-troubleshooting.md#purchasing-reports).

## 7. Issue goods (to a cost centre, or scrap)

**Screen:** *Post goods issue* — `/inventory/goods-issue` (**MM → Inventory management → Goods movements**).

1. **Header**: choose the **Movement type**: `201` *Goods issue for a cost centre* or `551` *Scrapping*. Set **Posting date**, **Document date**, **Header text**.
2. In the line table enter **Material** `RM-FLOUR-25`, **Plant** `1000`, **Storage location** `0001`, optional **Batch**, **Quantity** `25`, and for `201` a **Cost centre** `CC1100` (greyed out for scrapping). **Reservation** and item are optional — use them when issuing against a reservation (§9).
3. Click the post button.

> [!NOTE]
> **What happens in the background?**
> Stock **decreases**. The journal: **Debit** the consumption (or scrap) expense account, **Credit** the inventory account, at the material's current price. The company code follows the plant. A reversal (movement `202`/`552`) is done through §5, not typed here.

## 8. Transfer stock

**Screen:** *Post stock transfer* — `/inventory/transfer-posting`.

1. Choose the **Movement type**: `311` storage location to storage location (same plant), `301` plant to plant (same company code), `321` quality inspection to unrestricted.
2. Fill **Material**, **Quantity**, **Entry unit**, **Issuing plant**/**Issuing storage location**, **Receiving plant**/**Receiving storage location**, **Posting date**, **Document date**, **Header text**.
3. Post.

> [!NOTE]
> **What happens in the background?** Stock decreases at the sender and increases at the receiver. A move that stays inside one plant (`311`) moves quantity only and the screen reports *"no journal — the transfer moves quantity only"*. A plant-to-plant move (`301`) carries the value with the stock; the screen shows the journal number when one is posted.

## 9. Create a reservation

**Screen:** *Create reservation* — `/inventory/reservations`. A reservation sets stock aside for a later issue.

1. Under **Create a reservation** choose the **Movement type** (default `201`), a **Required date**, and a **Cost centre** (must belong to the plant's company code and be valid on that date).
2. In each line fill **Material**, **Plant**, **Quantity**, **Storage location** and tick **Movements allowed** if goods may be issued.
3. Save. To find one later use **Show a reservation** (`RSV-…`) and **Load reservation**; the table shows **Required**, **Withdrawn**, **Open**.

*Background:* a reservation posts nothing; it only records the planned need so planners and the warehouse see it.

## 10. Count stock (physical inventory)

Counting has three steps, each its own screen under **MM → Inventory management → Physical inventory**.

1. **Physical inventory** (`/inventory/physical-inventory`) — create the **count document**: **Plant** (*mandatory*), **Storage location**, **Planned count date** (*mandatory*), one line per **Material to count** (and **Batch**). Tick **posting block** to freeze movements of those materials until the count is done. The company code and fiscal year are derived, never typed.
2. **Enter physical inventory count** (`/inventory/physical-inventory-count`) — load the document (number and year), then for each item enter **Counted quantity**, **Unit**, tick **Zero count** if the shelf is empty, a **Count date**, and the **counter** name. A blank quantity with no zero count means *not counted yet*. Corrections are allowed until differences are posted; each needs a **reason** and is kept in the count history.
3. **Post inventory differences** (`/inventory/physical-inventory-posting`) — load the document and select items, then click **Post selected differences**. (*Physical inventory differences* and *Recount* screens review and re-check items first.)

> [!NOTE]
> **What happens in the background?**
> Creating the document and entering counts **post nothing** — the book quantity is simply frozen for comparison. Posting differences creates a material document: movement `701` for a **surplus** (stock increases) or `702` for a **shortage** (stock decreases), with a journal against the inventory-difference account. The **whole** remaining difference of an item is posted — a fraction is refused. **Reverse** is a separate authority from posting.

## 11. The all-in-one screen: Goods movement

**Screen:** *Goods movement* — `/inventory/migo` (command box `MIGO`). Choose an **Action** and a **Reference document type**; the pair decides the movement:

| Action | Reference | Result |
|---|---|---|
| **A01** Goods receipt | **R01** Purchase order | Directs you to *Post goods receipt* (§4) |
| **A01** Goods receipt | **R08** Order | Posts a goods receipt from a production order (movement `101`) |
| **A07** Goods issue | **R08** Order | Posts the component issue to a production order (movement `261`) |
| **A07** Goods issue | **R04** Reservation | Directs you to *Post goods issue* (§7) |
| **A03** Cancellation | **R05** Material document | Posts a reversal (§5) |
| **A04** Transfer posting | **R10** Other | Posts `311`, `301` or `321` (§8) |

Any other pair shows why it is not available.

---

**← Previous** [MM master data](master-data.md) · **Next →** [MM reports and troubleshooting](reports-and-troubleshooting.md)
