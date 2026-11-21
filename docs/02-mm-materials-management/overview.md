# MM — Materials Management: Overview

Materials Management (MM) covers everything about the goods you **buy, store and move**: requesting them, ordering them from suppliers, receiving them into stock, checking the supplier's invoice, and counting what is on the shelf.

## Table of Contents

- [What MM does for you](#what-mm-does-for-you)
- [Who uses it](#who-uses-it)
- [The MM menu](#the-mm-menu)
- [How the pieces connect](#how-the-pieces-connect)
- [Key ideas in plain words](#key-ideas-in-plain-words)
- [Where to go next](#where-to-go-next)

> [!IMPORTANT]
> **Prerequisites**
> - You have read [Login and roles](../01-getting-started/login-and-roles.md), [Navigation guide](../01-getting-started/navigation-guide.md) and [Master data concepts](../01-getting-started/master-data-concepts.md).
> - Your administrator has given you a role with MM authorities (for example **BUYER** or **WAREHOUSE_CLERK**) and business access to the company codes and plants you work in.

## What MM does for you

| Business question | MM answers it with |
|---|---|
| "What do we need to buy?" | **Purchase requisitions** — an internal request to buy |
| "Who should we buy from, at what price?" | **Requests for quotation**, **quotations**, **info records**, **source lists**, **contracts**, **scheduling agreements** |
| "Place the order." | **Purchase orders** |
| "The goods arrived." | **Goods receipt** — stock goes up |
| "The supplier sent a bill." | **Invoice verification** — matches the bill to the order and the receipt |
| "Use, move or scrap stock." | **Goods issue**, **transfer posting**, **reservations**, **return delivery** |
| "Is the system's stock right?" | **Physical inventory** counts and **stock reports** |
| "What is stock worth?" | **Material valuation**, price changes, stock ageing |

## Who uses it

| Role | Typical work | Typical screens |
|---|---|---|
| **Buyer** (`BUYER`) | Turns requests into orders; keeps sources and prices current | Purchase requisitions, purchase orders, info records, quotations |
| **Warehouse clerk** (`WAREHOUSE_CLERK`) | Receives, issues, transfers and counts stock | Goods movement, goods receipt, physical inventory |
| **Accountant** (`ACCOUNTANT`) | Verifies invoices; reviews GR/IR | Enter incoming invoice, Reconcile GR/IR |
| **Material master maintainer** | Creates and maintains materials | Material master |

## The MM menu

In the left-hand menu choose **MM – Materials Management**. It is grouped into categories (the exact list you see depends on your authorities):

| Category | Activities | Covered in |
|---|---|---|
| **Material master** | Create material, Material master list, Material planning settings, Units of measure per material | [Master data](master-data.md) |
| **Procurement** | Purchase requisitions, Purchase orders, Requests for quotation, Sources of supply, Outline agreements, Invoice verification & GR/IR | [Master data](master-data.md) (sources), [Daily transactions](daily-transactions.md) |
| **Inventory management** | Goods movements, Material documents, Physical inventory, Batch management, Serial numbers, Stock reports | [Daily transactions](daily-transactions.md) |
| **Valuation** | Material valuation, Stock valuation & ageing | [Reports and troubleshooting](reports-and-troubleshooting.md) |
| **Purchasing reports** | Purchase order list, Invoice overview, Requisition list, Orders by account assignment | [Reports and troubleshooting](reports-and-troubleshooting.md) |
| **Configuration** *(administrators)* | Purchasing organisations and groups, material types and groups, number ranges, release strategies, batch settings | [Master data](master-data.md#configuration-set-once-by-an-administrator) |

## How the pieces connect

```
Purchase requisition  ──►  Purchase order  ──►  Goods receipt  ──►  Invoice verification
 (internal request)        (to supplier)        (stock ↑, value ↑)   (liability to supplier)
                                                       │
                                                       ▼
                         Goods issue / transfer / physical inventory (stock ↓ / moves / corrected)
```

Every step leaves a **document**, and each document refers to the one before it. That chain is what lets you ask later: *"Which order did this receipt belong to, and was it invoiced?"*

## Key ideas in plain words

- **Material document** — the record of a stock movement (receipt, issue, transfer). It never gets edited; mistakes are fixed by a **reversal** (a new, opposite document).
- **Movement type** — a three-digit code that says *what kind* of movement it is, e.g. `101` goods receipt for an order, `201` issue to a cost centre, `261` issue to a production order, `301`/`311` transfers, `551` scrapping, `701`/`702` physical-inventory surplus/shortage.
- **GR/IR (goods received / invoice received)** — a temporary accounting account that holds the value of goods received but not yet invoiced. It balances to zero once the invoice arrives.
- **Plant, storage location** — where the stock physically is ([Master data concepts](../01-getting-started/master-data-concepts.md#the-company-structure-organisational-units)).
- **Posting block** — while a stock count is open, movements of the counted material may be refused.

> [!NOTE]
> **What happens in the background?**
> Only some MM actions change stock or accounting. **Requisitions and purchase orders post nothing** — they are plans and commitments. A **goods receipt** increases stock and posts an accounting entry. An **invoice** books the supplier's bill. Each page in this section ends with a note telling you which of these applies.

## Where to go next

1. [Master data](master-data.md) — materials, sources of supply, configuration.
2. [Daily transactions](daily-transactions.md) — step-by-step purchasing and stock work.
3. [Reports and troubleshooting](reports-and-troubleshooting.md) — reports and the error messages you will meet.

---

**← Previous** [Master data concepts](../01-getting-started/master-data-concepts.md) · **Next →** [MM master data](master-data.md)
