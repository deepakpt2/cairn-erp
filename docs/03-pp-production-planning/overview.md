# PP — Production Planning: Overview

Production Planning (PP) covers **making things**: defining how a product is built, planning what to make and when, producing it on the shop floor, recording what was done, and settling the cost.

## Table of Contents

- [What PP does for you](#what-pp-does-for-you)
- [Who uses it](#who-uses-it)
- [The PP menu](#the-pp-menu)
- [The life of a production order](#the-life-of-a-production-order)
- [Key ideas in plain words](#key-ideas-in-plain-words)
- [Where to go next](#where-to-go-next)

> [!IMPORTANT]
> **Prerequisites**
> - You have read [Login and roles](../01-getting-started/login-and-roles.md) and [Master data concepts](../01-getting-started/master-data-concepts.md).
> - Materials exist and are extended to the plant ([MM master data](../02-mm-materials-management/master-data.md#1-the-material-master)). A produced material is normally type finished or semi-finished and has an **MRP** view.
> - Your role carries PP authorities (for example **PLANNER** or **PRODUCTION_CLERK**) and business access to the plant.

## What PP does for you

| Business question | PP answers it with |
|---|---|
| "What goes into one loaf, and how is it made?" | **Bill of material (BOM)**, **routing**, **work centre**, **production version** |
| "What do we need to make, and when?" | **Total planning** (MRP run), **planned orders**, **Stock/requirements list** |
| "Do we have the parts, and the capacity?" | **Availability check for an order**, **Capacity load** |
| "Make it." | **Production order**: create, release, issue components, confirm, receive the product |
| "What did it cost?" | **Production order cost report**, **WIP**, **settlement** |
| "What went wrong?" | **MRP exception monitor**, **Reprocess failed production goods movements** |

## Who uses it

| Role | Typical work |
|---|---|
| **Planner** (`PLANNER`) | Maintains BOMs, routings, work centres; runs planning; converts planned orders |
| **Production clerk** (`PRODUCTION_CLERK`) | Creates and releases orders; enters confirmations; posts component issues and product receipts |
| **Controller** (`CONTROLLER`) | Reviews order costs; runs WIP and settlement |

## The PP menu

Choose **PP – Production Planning** in the left menu. Categories (what you see depends on your authorities):

| Category | Activities | Covered in |
|---|---|---|
| **Master data** | BOM, routing, work centre, production version (display and change) | [Master data](master-data.md) |
| **Material requirements planning** | Planning runs & lists, Planned orders | [Daily transactions](daily-transactions.md) |
| **Production orders** | Production orders; Order costs & settlement | [Daily transactions](daily-transactions.md) |
| **Confirmations** | Order confirmations (enter, time ticket, cancel, display) | [Daily transactions](daily-transactions.md) |
| **Production monitoring** | Stock/requirements, Order information, Planning exceptions, Failed goods movements | [Reports and troubleshooting](reports-and-troubleshooting.md) |
| **Configuration** *(administrators)* | Production order type, order-type parameters, scheduling profile, availability check, checking control, MRP controllers | [Master data](master-data.md#configuration-set-once-by-an-administrator) |

## The life of a production order

```
 Planned order ──convert──►  CREATED ──release──►  RELEASED ──work & post──►  TECHNICALLY_COMPLETED ──settle──► costs cleared
 (from planning)             (can't be charged)    ▲ issue components (261)
                                                   ▲ confirm operations
                                                   ▲ receive finished goods (101)
```

| Status | Meaning | Allowed |
|---|---|---|
| **CREATED** | The order exists with a component list copied from the BOM. | Change quantity/dates; **release**. Nothing can be charged. |
| **RELEASED** | Work may start. | Issue components, confirm, receive the product, change. |
| **TECHNICALLY_COMPLETED** | Production is finished. | Planning ends; late postings are still possible; **settlement** now allowed. |

## Key ideas in plain words

- **BOM** — the recipe: which components, how much of each, for a base quantity of the product.
- **Routing** — the method: the operations in order (mix, bake, pack), each at a work centre, with time standards.
- **Work centre** — where an operation runs (a machine or a line), with capacity.
- **Production version** — pairs *one* BOM with *one* routing for a material and plant, for a range of lot sizes and dates. Orders pick a version.
- **Planned order** — a proposal made by planning ("make 500 loaves by Friday"). It becomes a production order when converted.
- **Confirmation** — the shop-floor report: how much was made, scrapped, reworked, and when.
- **Backflush** — withdrawing components automatically when a confirmation is posted instead of issuing them by hand.
- **Settlement** — moving the order's collected cost to its receivers (so the order's balance goes to zero).

> [!NOTE]
> **What happens in the background?**
> Master data and planning post **nothing**. The production order itself posts nothing. Stock and accounting move only when goods are **issued** to or **received** from an order, when a confirmation triggers those movements, and when costs are **settled** or capitalised as **WIP**.

## Where to go next

1. [Master data](master-data.md) — BOMs, routings, work centres, versions.
2. [Daily transactions](daily-transactions.md) — plan, produce, confirm, settle.
3. [Reports and troubleshooting](reports-and-troubleshooting.md).

---

**← Previous** [MM reports and troubleshooting](../02-mm-materials-management/reports-and-troubleshooting.md) · **Next →** [PP master data](master-data.md)
