# SD — Master Data

The records Sales relies on: the customer, the material's Sales view, prices, and the configuration that ties them together.

## Table of Contents

- [1. The customer master](#1-the-customer-master)
- [2. The material Sales view](#2-the-material-sales-view)
- [3. Prices: condition records](#3-prices-condition-records)
- [4. Configuration (set once by an administrator)](#4-configuration-set-once-by-an-administrator)
- [Checklist: can I sell this to that customer?](#checklist-can-i-sell-this-to-that-customer)

> [!IMPORTANT]
> **Prerequisites**
> - [Master data concepts](../01-getting-started/master-data-concepts.md) read, especially [the company structure](../01-getting-started/master-data-concepts.md#the-company-structure-organisational-units).
> - Authority to maintain business partners and materials (administrator, or sales administrator with company scope).
> - The material already exists ([MM material master](../02-mm-materials-management/master-data.md#1-the-material-master)).

## 1. The customer master

A customer is a **business partner** carrying the **customer role**. Open **Foundation → Business partners** (`/foundation/partners`). Select the partner (for example `CUS-1000`); the customer panels appear below the general data.

> [!NOTE]
> If a sales order says the customer is "not in the customer role", extend the partner with the **FL customer role** here first.

### 1.1 Customer sales-area defaults

One block per sales area the customer buys in. Mandatory fields are marked **\***.

| Field | Meaning | Required |
|---|---|---|
| **Sales area\*** | Sales organisation + channel + division, e.g. `1000 / 01 / 01` | **Yes** |
| Pricing procedure | Code of the price calculation scheme to use | Optional |
| Sales district | Reporting group (stored code) | Optional |
| Account assignment group | Customer half of revenue-account finding | Optional |
| **Complete delivery required** | Ship the whole order at once, never in parts | Optional |
| **Combine orders** | Allow several orders to be delivered together | Optional |
| **Delivering plant** | Default plant to ship from; must belong to the sales organisation's company code | Optional |
| **Invoicing list schedule** | Collect this customer's invoices on a list | Optional |
| **Blocked for this sales area** | Stops new orders here | Optional |

> [!WARNING]
> No sales-area data = no order. The order refuses with "has no sales-area data for 1000/01/01".

### 1.2 Customer company accounting

Needed before an invoice can post.

| Field | Meaning | Required |
|---|---|---|
| **Company code\*** | The legal entity the customer owes | **Yes** |
| **Customer reconciliation account** | G/L account the receivable is booked to | **Yes** to post invoices |
| Payment terms | Default due-date rule | Optional |
| Payment method codes | Up to 10 | Optional |
| Dunning procedure code | Reminder scheme | Optional |
| Interest indicator code | Interest on overdue items | Optional |
| Tolerance group code | Payment-difference tolerances | Optional |
| **Blocked** | Stops posting for this company | Optional |
| **Reason\*** | Why you are changing it, 3–500 characters | **Yes** |

### 1.3 Partner functions

A customer can name other partners for three functions: **Ship-to** (`SH`), **Bill-to** (`BP`) and **Payer** (`PY`). Each row applies either to the current sales area or to all areas. Where none is named, the customer itself (the sold-to) is used, and the payer falls back to the bill-to.

## 2. The material Sales view

Open **MM → Material master** (`/inventory/materials`), pick the material (for example `FG-CHOC`) and use **Select sales area**. The text reads: *"Sales view for 1000/01/01. The material is sold in this sales area only where this view stands."*

| Field | Meaning | Required |
|---|---|---|
| **Sales unit** | Unit the material is sold in; blank = base unit | Optional |
| **Item category group** | Standard item, text item, packaging, service | Optional |
| **Account assignment group** | Material half of revenue-account finding | Optional |
| **Delivering plant** | Default plant | Optional |
| **Loading group** | Used with the shipping point to find where goods load | Optional |
| **Availability check group** | Which stock and receipts count when checking availability | Optional |

> [!WARNING]
> A material with no view in the sales area cannot be sold there at all.

The material must also be extended to the delivering plant (a warehouse and MRP view isn't required to sell, but the plant must exist).

## 3. Prices: condition records

**SD → Pricing & conditions → Sales condition records** (`/sales/conditions`). Needs capability `CFG.SALES.CONDITION.MAINTAIN` to save; with display only, the page is read-only.

**Save a price** (sample: `FG-CHOC`, 1.250 KWD for customer `CUS-1000`)

1. Fill **Sales organization** `1000`, **Distribution channel** `01`, **Division** `01` (prefilled from your default area).
2. **Customer** — leave blank for *every customer*, or enter `CUS-1000` for a customer-specific price.
3. **Material** — leave blank for *every material*, or `FG-CHOC`.
4. **Currency** `KWD`, **Amount** `1.250`, **Price unit** `1` (price per how many units).
5. **Valid from** `2026-11-01`, **Valid to** `2099-12-31` (format `YYYY-MM-DD`).
6. Tick **Replace the price that stands for an overlapping period** only if a price already covers those dates; the standing record then ends the day before yours starts. Without the box an overlap is refused.
7. Click **Save condition record**.

The table **Standing prices** lists Record, Sales area, Customer, Material, Amount, Valid from/to and Changed by.

Condition types delivered: `PR00` price, `K007` discount, `KF00` freight, `HD00` handling, `VPRS` cost, `MWST` tax, `BO01` rebate accrual.

> [!NOTE]
> **What Happens in the Background?**
> A condition record posts nothing. When an order line is priced, the system looks for the most specific record valid on the order date (customer and material, then customer only, then material only, then all) and stores the result on the order line as **Priced from**. Changing a price later does not change orders already priced.

## 4. Configuration (set once by an administrator)

Under **SD → Configuration**. Describe each in terms of what it decides:

| Screen | Route | What it decides |
|---|---|---|
| Sales organisations | `/config/sales-orgs` | Who sells; belongs to one company code |
| Distribution channels | `/config/distribution-channels` | How it reaches the customer (e.g. `01` direct) |
| Divisions | `/config/divisions` | Product line grouping |
| Sales areas | `/config/sales-areas` | The valid combinations |
| Sales document types | `/config/sales-document-types` | Order, quotation, return types; each needs a **number range** to "stand" |
| Pricing procedures | `/config/pricing-procedure` | The order in which condition types are applied |
| Revenue account determination | `/config/sales-account-determination` | Which G/L revenue account billing uses |
| Billing split | `/config/billing-split` | When one delivery produces several invoices |
| Incompletion | `/config/incompletion` | Which fields must be filled or the document is held |
| Shipping points | `/config/shipping-points` | Docks, which plant loads where, shipping conditions |
| Returns chain | `/config/sales-returns` | Document types and movement used for returns |
| Batch determination | `/config/batch-determination` | Which batch a pick is proposed from |

> [!NOTE]
> **What Happens in the Background?** Configuration rows are *defined* and then *stand*. A row can be withdrawn and restored but not deleted while documents use it ("Documents standing"). Changes apply from the next document, not to ones already created.

## Checklist: can I sell this to that customer?

1. Partner has the customer role.
2. Customer sales-area defaults exist for the area, not blocked.
3. Customer company accounting has a reconciliation account.
4. Material has a Sales view for the area and is extended to the plant.
5. A valid condition record covers the order date.
6. Sales area is defined and active; document type has a number range.

---

**← Previous** [SD overview](overview.md) · **Next →** [SD daily transactions](daily-transactions.md)
