# SD — Daily Transactions

From the first quote to the posted invoice, plus returns and credit notes. Sample data: customer `CUS-1000`, material `FG-CHOC`, plant `1000`, sales area `1000 / 01 / 01`.

## Table of Contents

- [1. Create a sales quotation](#1-create-a-sales-quotation)
- [2. Create a sales order](#2-create-a-sales-order)
- [3. Check availability, change or cancel an order](#3-check-availability-change-or-cancel-an-order)
- [4. Create a delivery, pick and post the goods issue](#4-create-a-delivery-pick-and-post-the-goods-issue)
- [5. Bill the delivery](#5-bill-the-delivery)
- [6. Billing plans and down payments](#6-billing-plans-and-down-payments)
- [7. Returns](#7-returns)
- [8. Credit memos](#8-credit-memos)
- [9. Credit release](#9-credit-release)
- [10. Rebate agreements](#10-rebate-agreements)

> [!IMPORTANT]
> **Prerequisites**
> - [SD master data](master-data.md) is in place: customer, Sales view, a valid price.
> - Stock exists for what you ship ([MM goods receipt](../02-mm-materials-management/daily-transactions.md#4-post-a-goods-receipt)).
> - Your role holds the matching SD capability. Pages you may only *display* show no entry forms.

---

## 1. Create a sales quotation

**SD → Sales → Quotations** (`/sales/quotations`) → form **Create sales quotation**.

A quotation is an offer. It reserves nothing and posts nothing.

1. Choose the **Customer** (`CUS-1000`) and sales area. **Order date** and **Requested date** default to today.
2. Add an item: **Material** `FG-CHOC`, **Plant** `1000`, **Quantity** `200`, **Unit** `PC`.
3. Set the quote's **Valid to** date.
4. Click **Create quotation**. The price is found from condition records and shown as **Price** and **Priced from**.
5. To accept: open the quotation and use **Raise a sales order** → **Raise order**. The new order's number appears in the **Orders** column.
6. To decline: **Reject the quotation** → **Reject quotation**.
7. To amend an open quotation: **Change the quotation** → **Save changes**.

> [!NOTE]
> **What Happens in the Background?** Nothing is posted and no stock is reserved. The quotation's status moves open → confirmed (when an order is raised) or rejected. An open quotation past its **Valid to** date shows `EXPIRED` and no order can be raised from it.

---

## 2. Create a sales order

**SD → Sales → Sales orders** (`/sales/orders`).

**Header**

| Field | Notes | Required |
|---|---|---|
| **Customer** | Must be a business partner with the customer role | **Yes** |
| **Sales organization**, **Distribution channel**, **Division** | The sales area | **Yes** |
| **Company code** | Must be within your company scope | **Yes** |
| **Currency** | e.g. `KWD` | **Yes** |
| **Order date**, **Requested date** | Dates | Order date defaults to today |
| **Customer reference** | The customer's PO number | Optional |
| **Order note** | Free text | Optional |
| **Credit control area** | Where credit is judged | Optional (if the company uses one) |

**Items** (use **Add another item** for more rows)

| Field | Notes | Required |
|---|---|---|
| **Material** | Needs a Sales view for the area | **Yes** |
| **Plant** | Delivering plant | **Yes** |
| **Quantity** | Decimals limited by the unit | **Yes** |
| **Unit** | A maintained unit | **Yes** |
| **Tax code** | Output tax | Optional |
| **Needed by** | Requested date for this line | Optional |

Click **Create order**. The item table then shows **Quantity, Confirmed, Delivered, Billed, Open, Price, Net, Tax, Priced from, Status**.

> [!NOTE]
> You never type a price. It is found from the [condition records](master-data.md#3-prices-condition-records).

> [!NOTE]
> **What Happens in the Background?**
> - **Stock:** nothing is reserved or moved. Availability is a check, not a booking.
> - **Accounting:** no journal is posted.
> - **Credit:** the order is checked against the customer's limit. If over, it is saved but **blocked** — see [Credit release](#9-credit-release).
> - **Demand:** open order quantities feed planning as sales demand.

### Typical refusals

| Message (shortened) | What to do |
|---|---|
| Customer is not a business partner / not in the customer role | Extend the partner with the **FL customer role** |
| Customer blocked or incomplete for the sales area | Fill the customer's [sales-area defaults](master-data.md#11-customer-sales-area-defaults) or lift the block |
| Sales area not defined / not active | Ask the administrator ([configuration](master-data.md#4-configuration-set-once-by-an-administrator)) |
| Unknown unit / too many decimals | Use a maintained unit; fewer decimals |
| Material not in the client | Check the number; create the material |
| Company code outside scope | Use a company you are authorised for |
| Sales document type does not stand … number ranges | Administrator sets the number range |

---

## 3. Check availability, change or cancel an order

- **Check availability** (panel on the order): shows what can be confirmed from stock and receipts for the date wanted. **Confirmed** on each line is what the system promises.
- **Save changes**: edit an open order. Quantities already delivered cannot be reduced below what shipped.
- **Cancel order**: enter a reason. A cancelled order delivers nothing and is **not reopened**; create a new one.

> [!NOTE]
> **What Happens in the Background?** Changing an order re-prices lines whose quantity changed and re-checks credit. Cancelling posts nothing, because nothing was posted.

---

## 4. Create a delivery, pick and post the goods issue

**SD → Shipping → Outbound deliveries** (`/sales/delivery`).

1. **Create a delivery from an order**: enter the **order number**, **delivery date** and **goods-movement date**, an optional **note**, and per line the **quantity** to ship (default: the open quantity).
2. Click create. The delivery is saved with a status; **nothing has moved yet**.
3. **Confirm picking**: per line enter **Quantity**, **Storage location** and **Batch** (if the material is batch-managed). Enter a **correction reason** when you change a confirmed pick.
4. **Post the goods issue**: choose the **posting date** and post.
5. To abandon a delivery that has not shipped: **Cancel** with a reason.

> [!WARNING]
> Orders for a customer that requires a **complete delivery** cannot be partly delivered. Orders for different ship-tos or different sales areas cannot share one delivery.

> [!NOTE]
> **What Happens in the Background?**
> - **Creating or picking** moves no stock.
> - **Goods issue (movement `601`)**: stock of `FG-CHOC` falls by the quantity; the journal is **Dr Cost of goods sold / Cr Inventory** at the material's valuation price.
> - The delivery status becomes `GOODS_ISSUED`; the order's **Delivered** and **Open** columns update.
> - **Credit** is judged both when the delivery is created and again at goods issue. A blocked delivery shows **Release for credit**.
> - A goods issue can be reversed; a reversed issue is not billable.

---

## 5. Bill the delivery

**SD → Billing → Billing** (`/sales/billing`).

Two ways:

- **Bill the due list**: enter **billing date** and **posting date**; every goods-issued delivery not yet billed is invoiced in one run.
- **Bill a goods-issued delivery**: enter the **delivery number** and **billing date**.

The invoice carries no price of its own: it bills the **order's price scaled to the quantity actually issued**.

> [!NOTE]
> **What Happens in the Background?**
> - One live billing document per delivery. A billing document is created open, then posted.
> - Posting runs the customer invoice: **Dr Customer reconciliation account (receivable) / Cr Revenue** (account found by *revenue account determination*) **/ Cr Output tax**.
> - The order's **Billed** column updates; the open item appears for payment and dunning in FICO ([Daily transactions](../05-fico-finance-controlling/daily-transactions.md)).
> - A cancelled billing document frees the delivery to be billed again.

| Message | Meaning / action |
|---|---|
| Delivery … stands CANCELLED / is not GOODS_ISSUED | Post the goods issue first |
| …already billed as … | Cancel the old billing document before re-billing |
| Goods issue … has been reversed | Post the issue again or cancel the delivery |

---

## 6. Billing plans and down payments

**SD → Billing → Billing plans** (`/sales/billing-plans`) → **Maintain a billing plan**.

1. Enter the **Order** and **Item**, choose the plan **Type** (for example `PE · Periodic`).
2. Add dates with each **Share of the item** (the shares make 100%), and **Kind**: **Invoice it** or **Ask in advance** (a down-payment request).
3. Enter a **reason** and save. Each date is billed on its day.

> [!NOTE]
> **What Happens in the Background?** A down-payment request asks the customer for money before delivery and is posted as a customer down payment, later cleared against the final invoice.

---

## 7. Returns

**SD → Sales → Returns** (`/sales/returns`).

1. **Raise a returns order**: choose **Against** an invoice (**— choose an invoice —**) or an outbound delivery; pick the **Invoice line** and the **Quantity coming back**; add a **text**.
2. **Raise a returns delivery** against the returns order.
3. **Receive the goods back** (**Goods receipt**): enter the **posting date** and **Receive a returns delivery**.

> [!NOTE]
> **What Happens in the Background?** The goods receipt (movement `651`) puts the goods into **returns stock**: they are counted but **not valued and not available to sell**, and **no journal is posted**. Value returns to stock only when the goods are later transferred out of returns stock after inspection (to unrestricted, quality inspection or blocked). A return cannot receive back more than was issued on the delivery line. The customer's money is returned by a [credit memo](#8-credit-memos), not by the return itself.

---

## 8. Credit memos

For a price error, a damaged item or goods returned.

**SD → Billing → Credit memo requests** (`/sales/credit-memo-request`):

1. **Raise a credit memo request**: choose the **Invoice** and **Invoice line**, **Quantity in dispute**, **Reason**.
2. **Release** the request (this is the approval; until then the amount is **Held for**).
3. **Post a credit memo** against the released request: choose **Posting** date. **Quantity credited** is capped at the quantity billed.

**Enter customer credit memo** (`/sales/credit-memo`) is the direct route: **Company code**, **Customer**, **Currency**, **Document date**, **Posting date**, **Payment terms**, **Reference**, **Original billing document** or **Original customer invoice** (optional), **Gross credit amount (tax included)**, then lines with **G/L account**, **Net amount (tax excluded)**, **Tax code**, **Profit centre**, **Text**. Use **Load** to retrieve a posted credit memo or **Cancellation posting date** to cancel one.

> [!NOTE]
> **What Happens in the Background?** A credit memo posts the opposite of the invoice: **Dr Revenue, Dr Output tax / Cr Customer receivable**. The customer's balance falls.

---

## 9. Credit release

An order or delivery held for credit is released at **Finance → Credit release** (`/finance/credit-release`) by a credit controller: enter a **justification** and an **approval reference**. The sales clerk then repeats the blocked step (the order is not lost). Details: [FICO daily transactions](../05-fico-finance-controlling/daily-transactions.md).

---

## 10. Rebate agreements

**SD → Pricing & conditions → Rebate agreements** (`/sales/rebate-agreements`) → **Maintain a rebate agreement**.

1. Enter **Customer**, **Sales org / channel / division**, **Type** `BO01 · Rebate accrual`, **From / To** dates, **Amount** and **Currency**.
2. **Release** the agreement to start accruing.
3. Billing then accrues a rebate (**Accrued**, **Basis**). Later, **Settle** the agreement to pay out (**Paid out**). Only a released agreement accrues.

> [!NOTE]
> **What Happens in the Background?** When an invoice is posted, part of the rebate is accrued as a provision: the sales deduction is debited and the rebate accrual is credited. A cancelled billing document takes its accrual with it. Settlement is a credit memo that reverses the provision and credits the customer; settling less than the accrued amount leaves the agreement accruing.

---

**← Previous** [SD master data](master-data.md) · **Next →** [SD reports and troubleshooting](reports-and-troubleshooting.md)
