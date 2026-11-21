# SD — Reports and Troubleshooting

How to see what has been sold, shipped and billed, and what to do when a sales step is refused.

## Table of Contents

- [Sales analysis](#sales-analysis)
- [Sales documents register](#sales-documents-register)
- [Incomplete documents](#incomplete-documents)
- [Output and invoice lists](#output-and-invoice-lists)
- [Common messages and what to do](#common-messages-and-what-to-do)
- [Checklist: "why can't I deliver or bill this?"](#checklist-why-cant-i-deliver-or-bill-this)

> [!IMPORTANT]
> **Prerequisites**
> - You hold display capability for SD. Reports show only documents of companies, plants and sales organisations in your scope; anything outside answers as not found.
> - Documents exist ([daily transactions](daily-transactions.md)).

## Sales analysis

**SD → Sales information → Sales analysis** (`/sales/analysis`). Choose **what** to read, **how** to group it, and **Narrow it**.

| Choice | Options |
|---|---|
| Analysis (kind) | **Sales** (billed), **Margin** (billed with cost), **Backlog** (open orders), **Returns** |
| Broken down by | Customer, Material, Sales org, Document type (**Type**), **Period** |
| Narrow it | Customer, Material, Sales org, Plant, Document type, Currency, Date from / Date to |

Columns: the grouping key, **Period** (when a period split is chosen), **Curr.**, **Docs**, a quantity column (**Billed**, **Open** or **Returned**), **Net**, and for Margin: **Cost**, **Margin**, **Margin %**. Click **Read the analysis** to run it.

> [!NOTE]
> **What Happens in the Background?** Nothing is posted; the report only reads. Amounts are never added across currencies — each currency gets its own total. In *Margin*, if some lines were priced without a cost condition (`VPRS`), the page says the cost is incomplete: the margin is understated rather than guessed.

## Sales documents register

**SD → Sales information → Sales documents** (`/sales/documents`). Filter by document number, customer, material, sales org, plant, type and status, then **Read the register**. Columns: **Document**, **Type**, **Customer**, **Sales org**, **Plant**, **Dated**, **Net**, **Gross**, **Status**, **Raised against** (the document it follows). Use it to find an order's deliveries and invoices.

## Incomplete documents

**SD → Sales information → Incomplete documents** (`/sales/incomplete`). Lists documents held because a required field is empty. Columns: **Line**, **What is missing**, **Consequence** (what you cannot do until it is filled), **Filled in at** (the screen that fixes it). Fill the field at the screen named there, then retry the blocked step.

What is mandatory is set by the administrator in **Configuration → Incompletion** (`/config/incompletion`).

## Output and invoice lists

- **Output** (`/sales/output`): shows documents queued for sending (order confirmations, delivery notes, invoices) with **Medium**, **Recipient**, **Dispatch** and **State**. **Set recipient** fixes a missing address. The output is found by **output condition records** through an **access sequence**.
- **Invoice lists** (`/sales/invoice-lists`): collect a payer's invoices on one list. **What is waiting to be listed** shows documents not yet on a list; **Invoice lists as they stand** shows lists with **Documents**, **Billed**, **Gross**, **Payer**. A list can be cancelled with a reason (**Why this list is cancelled**).

## Common messages and what to do

| Message (shortened) | Cause | Do this |
|---|---|---|
| "is not in the customer role" | Partner is not a customer | Extend the partner with the customer role ([master data](master-data.md#1-the-customer-master)) |
| "has no sales-area data for …" | Customer not set up for the area | Maintain the [sales-area defaults](master-data.md#11-customer-sales-area-defaults) |
| "not extended to plant …" | Material not at the delivering plant | Extend the material ([MM](../02-mm-materials-management/master-data.md#extend-the-material-to-a-plant-purchasing-mrp-accounting)) |
| "flagged for deletion at plant …" | Deletion flag set | Lift the flag or use another plant |
| "…is credit-blocked: nothing was …" | Customer over limit | A credit controller releases it at `/finance/credit-release` |
| "Sales order … stands CANCELLED" | Order cancelled | Create a new order |
| "is a returns order" | Tried to ship a returns order | Receive it on a returns delivery |
| "requires a complete delivery" | Customer demands all-at-once | Deliver the whole open quantity or clear the flag |
| "ships to …, and this delivery ships to …" | Orders for different ship-tos combined | Deliver separately |
| "does not allow their orders to be combined" | Order combination off | Enable it on the customer or deliver separately |
| "carries … open of … ordered" | Delivering more than is open | Lower the quantity |
| "only a goods-issued delivery earns an invoice" | Billing before shipping | Post the goods issue |
| "already billed as …" | Delivery has a live invoice | Cancel it first if it must be redone |
| "Quotation … has expired" | Past **Valid to** | Create a new quotation |
| "A price did not scale…" / no price | No condition record valid on the date | Add one in [Condition records](master-data.md#3-prices-condition-records) |

## Checklist: "why can't I deliver or bill this?"

1. **Order** — status open, not cancelled, no incompletion (`/sales/incomplete`).
2. **Credit** — not blocked; if so, ask for release.
3. **Stock** — enough in the plant and storage location for the goods issue ([stock reports](../02-mm-materials-management/reports-and-troubleshooting.md#stock-reports)).
4. **Delivery** — picked, then goods issue posted.
5. **Billing** — delivery is goods-issued, not reversed, not already billed; customer has a reconciliation account.
6. **Posting period** open for the date entered ([FICO](../05-fico-finance-controlling/master-data.md)).
7. Give the document number and exact message to your administrator.

---

**← Previous** [SD daily transactions](daily-transactions.md) · **Next →** [FICO overview](../05-fico-finance-controlling/overview.md)
