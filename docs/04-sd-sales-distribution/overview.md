# SD — Sales & Distribution: Overview

Sales & Distribution (SD) covers **selling things**: quoting a customer, taking the order, picking and shipping the goods, invoicing, and handling returns and credit notes.

## Table of Contents

- [What SD does for you](#what-sd-does-for-you)
- [Who uses it](#who-uses-it)
- [The SD menu](#the-sd-menu)
- [The life of a sale](#the-life-of-a-sale)
- [Key ideas in plain words](#key-ideas-in-plain-words)
- [Where to go next](#where-to-go-next)

> [!IMPORTANT]
> **Prerequisites**
> - You have read [Login and roles](../01-getting-started/login-and-roles.md) and [Master data concepts](../01-getting-started/master-data-concepts.md).
> - The customer exists as a business partner with the customer role, and the material has a Sales view for the sales area ([SD master data](master-data.md)).
> - Your role carries SD authorities and business access to the company, plant or sales organisation concerned.

## What SD does for you

| Business question | SD answers it with |
|---|---|
| "What will you charge me?" | **Sales quotation** (`/sales/quotations`) |
| "I want 200 of these." | **Sales order** (`/sales/orders`) with price from **condition records** |
| "Can you deliver on Friday?" | **Check availability** on the order |
| "Send it." | **Outbound delivery** (`/sales/delivery`): pick, then post the goods issue |
| "Bill it." | **Billing** (`/sales/billing`) → customer invoice and receivable |
| "It came back / the price was wrong." | **Returns** (`/sales/returns`), **Credit memo request** and **Credit memo** |
| "How are we selling?" | **Sales analysis**, **Sales documents** register, **Incomplete documents** |

## Who uses it

| Role | Typical work |
|---|---|
| **Sales clerk** | Quotations, orders, deliveries, billing |
| **Sales administrator** | Condition records (prices), billing plans, rebate agreements, output |
| **Credit controller** | Releases orders and deliveries held for credit (`/finance/credit-release`) |
| **Configuration administrator** | Sales organisations, areas, document types, pricing procedures, shipping points |

## The SD menu

Choose **SD – Sales & Distribution** in the left menu. You see only the categories your authorities allow.

| Category | Activities | Covered in |
|---|---|---|
| **Sales** | Sales orders, Quotations, Returns, Output | [Daily transactions](daily-transactions.md) |
| **Shipping** | Outbound deliveries | [Daily transactions](daily-transactions.md#4-create-a-delivery-pick-and-post-the-goods-issue) |
| **Billing** | Billing, Billing plans, Credit memo requests, Enter customer credit memo, Invoice lists | [Daily transactions](daily-transactions.md#5-bill-the-delivery) |
| **Pricing & conditions** | Sales condition records, Rebate agreements | [Master data](master-data.md#3-prices-condition-records) |
| **Sales information** | Incomplete documents, Sales analysis, Sales documents | [Reports and troubleshooting](reports-and-troubleshooting.md) |
| **Configuration** *(administrators)* | Sales organisations, distribution channels, divisions, sales areas, document types, pricing procedures, revenue account determination, billing split, incompletion, shipping points, returns chain | [Master data](master-data.md#4-configuration-set-once-by-an-administrator) |

## The life of a sale

```
 Quotation ─► Sales order ─► Delivery ─► Goods issue ─► Billing ─► Customer payment
 (optional)   no stock move  picking     stock out,       invoice,    (see FICO)
              no accounting  confirmed   cost of sales    receivable
                                         posted
```

Only two steps touch the books: the **goods issue** (stock leaves, cost of goods sold is booked) and **billing** (revenue and receivable are booked). Everything before that is a promise, not a posting.

## Key ideas in plain words

- **Sales area** — the combination *sales organisation + distribution channel + division* under which you sell. A customer and a material must both be set up for it.
- **Condition record** — a stored price (or discount, surcharge). You never type a price on an order; the system finds it.
- **Credit block** — an order or delivery for a customer over their credit limit is held, not deleted. A separate, authorised person releases it.
- **Billing follows delivery** — the invoice bills what was actually shipped, at the order's price, scaled to the quantity issued.
- **Out of reach looks like missing** — a document from a company outside your scope answers as "not found", never as "not allowed".

## Where to go next

1. [SD master data](master-data.md) — customer, material Sales view, prices, configuration.
2. [SD daily transactions](daily-transactions.md) — quotation to invoice.
3. [SD reports and troubleshooting](reports-and-troubleshooting.md).

---

**← Previous** [PP reports and troubleshooting](../03-pp-production-planning/reports-and-troubleshooting.md) · **Next →** [SD master data](master-data.md)
