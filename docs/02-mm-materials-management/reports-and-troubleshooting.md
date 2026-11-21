# MM — Reports and Troubleshooting

How to look at what happened (stock, orders, invoices, values), and how to read and fix the messages you meet.

## Table of Contents

- [How selection screens work](#how-selection-screens-work)
- [Stock reports](#stock-reports)
- [Material document reports](#material-document-reports)
- [Purchasing reports](#purchasing-reports)
- [Valuation reports](#valuation-reports)
- [Common messages and what to do](#common-messages-and-what-to-do)
- [Checklist: "my stock or order looks wrong"](#checklist-my-stock-or-order-looks-wrong)

> [!IMPORTANT]
> **Prerequisites**
> - Posted documents exist to report on ([Daily transactions](daily-transactions.md)).
> - Report screens need their *display* authority. You only see data of the companies and plants in your business access — a colleague with wider access may see more rows than you.
> - Reports are **read-only**: they never change anything.

## How selection screens work

Most reports start with a **selection**: type what you want, then click **Execute**.

1. Ranges come as **From / To** pairs (for example **Plant from** `1000` **to** `1000`). Fill only the fields you need; empty means "all".
2. **Maximum hits** limits rows (the screen tells you when it cut the list); narrow the selection to see the rest.
3. **Display zero stock lines** also shows items with nothing on hand.
4. Click **Execute**. Click a document number in the result to open it.

## Stock reports

Menu: **MM → Inventory management → Stock reports**.

| Report | Path | Use it to… | Key selection fields |
|---|---|---|---|
| **Stock overview** | `/inventory/stock-overview` | See where one material's stock is: plant, storage location, stock type | **Material** *(mandatory)*, Plant from/to, Storage location from/to, Batch, Special stock indicator, **Expansion level**, Maximum hits, Display zero stock lines |
| **Warehouse stocks on hand** | `/inventory/warehouse-stocks` | List stock **with value** across materials | Scope of list, Material, Plant, Storage location, Valuation type, Batch, Display zero stock lines, Valuation price display |
| **Shelf life list** | `/inventory/shelf-life-list` | Find batches nearing expiry | |
| **Stock reconciliation** | `/inventory/stock-reconcile` | Compare the stock figures with the material documents they come from (a consistency check) | |
| **Stocks on posting date** | `/inventory/stock-posting-date` | What stock stood on a past date | Posting date |
| **Stock ageing and slow-moving items** | `/inventory/stock-ageing` | Find stock that has not moved | **As of** date, **Age buckets**, **Slow-moving days**, **Non-moving days**, Stock type |

Reading the stock overview: **Stock type** rows show *Unrestricted* (free to use), *Quality inspection* and *Blocked*. *Stock in transit* belongs to the receiving plant and is **not available** until its goods receipt is posted.

## Material document reports

Menu: **MM → Inventory management → Material documents**.

| Report | Path | Use it to… |
|---|---|---|
| **Material document list** | `/inventory/material-document-list` | Search all stock movements by material, plant, date, movement type |
| **Display material document** | `/inventory/material-documents` | Open one movement: lines, quantities, values, linked journal |
| **Material document output** | `/inventory/material-document-output` | Print / export a movement |

On a displayed document you can see the **journal** number (the matching accounting entry) or *"no journal — the movement carried no value"*, and whether it has been **reversed by** another document.

## Purchasing reports

Menu: **MM → Purchasing reports** and **Procurement → Invoice verification & GR/IR**.

| Report | Path | Use it to… |
|---|---|---|
| **Purchase order list display** | `/purchasing/purchase-order-list` | Find orders by supplier, purchasing org/group, plant, material, document date. Choose a **Perspective** (e.g. by vendor) and a **Scope**. |
| **Purchase requisitions: list display** | `/purchasing/requisition-list` | See open requests and their status |
| **Purchase orders by account assignment** | `/purchasing/orders-by-account-assignment` | See orders charged to a cost centre or other object |
| **Invoice overview** | `/purchasing/invoice-overview` | See invoices posted against orders |
| **Reconcile GR/IR** | `/purchasing/grir-reconciliation` | Explain balances on the GR/IR account (see below) |
| **Maintain GR/IR clearing** | `/purchasing/grir-clearing` | Clear old, settled GR/IR balances |

**GR/IR reconciliation.** Enter **Company** from/to, **Order** from/to, **Plant** from/to, a **Key date** *(mandatory)* and a **Category**, then click **List**. A balance on GR/IR is **not an error**: it normally means "goods received, invoice still to come" or the reverse. The list shows, for each order item, *Ordered / received / invoiced* and says which balances still explain themselves. *The list writes nothing; a wrong balance is put right by a posting, never by editing the list.*

## Valuation reports

Menu: **MM → Valuation**.

- **Change material price** (`/inventory/price-change`) is a *transaction*, not a report: enter **Company code**, **Posting date**, **When** (*Current* / previous period / future), a **Reason**, and one or more lines (**Material**, **Plant**, **Price**, **Price unit**). A change in the current period posts the **stock-value difference** now; a previous period posts only while that period is open; a future price is stored until released (see **Stored future prices**).
- **Stock ageing and slow-moving items** and **Stocks on posting date** are in the stock reports above.

> [!NOTE]
> **What happens in the background?**
> Reports post nothing. **Change material price** is the exception: it posts a revaluation between the inventory account and a price-difference account for the stock on hand, and updates the book price. Master maintenance cannot do this once stock exists.

## Common messages and what to do

| Message (or part of it) | Likely cause | What to do |
|---|---|---|
| *This view changed after it was opened.* | Someone saved while you were editing | Reload, review the new values, re-apply your change |
| *…is being changed by X. This opening is display only.* | Another user holds the lock | Wait, or ask them to finish; see [Locks](../01-getting-started/navigation-guide.md#locks-is-being-changed-by) |
| *Material … is not extended to plant …* / *The … view of … is missing or incomplete.* | The plant view was never created or saved incomplete | Complete the Purchasing/MRP/Accounting view ([Master data](master-data.md#extend-the-material-to-a-plant-purchasing-mrp-accounting)) |
| *The basic view of … is incomplete.* | Description, group or base unit missing | Complete the **Basic data** view |
| *Material … is blocked for operational use.* / *…is flagged for deletion.* | Blocked or flagged | Ask a master-data maintainer to review the reason |
| *The plant is not assigned to a company code.* | Plant setup incomplete | Ask an administrator ([Master data concepts](../01-getting-started/master-data-concepts.md)) |
| *Supplier … is blocked.* | Supplier blocked | Ask the purchasing manager; do not bypass |
| *No receipt quantities were entered.* | All receipt quantities are 0 | Enter a quantity on at least one item |
| *Purchase order … does not exist.* | Wrong number, or outside your business access | Check the number; an order outside your access answers exactly as a missing one |
| *Valuation settings cannot be changed here while stock exists.* | Trying to edit price control with stock | Use **Change material price** |
| *Maintain the account determination for this event, then post again.* | Accounting configuration is missing | Ask a finance configurator |
| *…does not stand valid on … in controlling area …* / *Cost centre … is locked for postings.* | Cost centre is out of validity or locked | Pick another cost centre or ask Controlling |
| *Material document … has already been reversed by …* / *A reversal document cannot itself be reversed.* | Reversing twice | Open the reversal document; nothing more to do |
| *The supplier reference is required.* | Invoice without the supplier's invoice number | Type it from the paper invoice |
| *Maximum lot size must not be below minimum lot size.* | MRP lot settings | Correct the numbers |
| *You do not hold the … capability.* | Missing authority | Ask your administrator for the role ([Login and roles](../01-getting-started/login-and-roles.md#roles-authorities-and-scope)) |

## Checklist: "my stock or order looks wrong"

1. Open **Display material document** for the movement you expect; confirm it exists and whether it was **reversed**.
2. Open the **Stock overview** for the material and plant; check the **Stock type** (stock may sit in *Quality inspection* or *Blocked*).
3. Open **Display purchase order**; compare **Ordered**, **Received**, **Invoiced** per item.
4. Check **Reconcile GR/IR** for the order if value looks off.
5. Check whether a **physical inventory posting block** is active for the material.
6. If a number still does not make sense, give the *document numbers* to your administrator — they are enough to trace everything.

---

**← Previous** [MM daily transactions](daily-transactions.md) · **Next →** [PP overview](../03-pp-production-planning/overview.md)
