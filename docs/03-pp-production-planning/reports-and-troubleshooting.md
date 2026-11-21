# PP — Reports and Troubleshooting

How to see what is planned and what happened on the shop floor, and how to handle the refusals you will meet.

## Table of Contents

- [Planning reports](#planning-reports)
- [Order reports](#order-reports)
- [Master data displays](#master-data-displays)
- [Common messages and what to do](#common-messages-and-what-to-do)
- [Checklist: "why is my order stuck?"](#checklist-why-is-my-order-stuck)

> [!IMPORTANT]
> **Prerequisites**
> - Planning has run and/or production orders exist ([Daily transactions](daily-transactions.md)).
> - You hold the display authority of each report. Reports are **read-only**, and show only the plants and companies in your business access.

## Planning reports

Menu: **PP → Production monitoring** and **Material requirements planning → Planning runs & lists**.

| Report | Path | Use it to… | Selection |
|---|---|---|---|
| **Stock/requirements list** | `/production/stock-requirements` (command box `MD04`) | See, for **one material in one plant**, stock, open requisitions and open orders in one chronological list with a running projected balance | **Material** *(mandatory)*, **Plant** *(mandatory)*, MRP area, Special stock indicator, Period split (e.g. daily), Horizon end, Simulation version, Maximum hits, *Display past due elements* |
| **MRP exception monitor** | `/production/mrp-exception-monitor` | Find materials with problems | **Plant**, Material from/to, MRP type, Horizon end, *Materials to scan*, and the exceptions **Shortage**, **Safety stock breach**, **Past due** |
| **Capacity load** | `/production/capacity-load` | See whether work centres are overloaded | **Plant**, Work center from/to, Capacity category, From/To dates, Period, Working days per week (fallback), include *Planned orders*, **Order status**, number of work centres |

How to read the **Stock/requirements list**: the first line is current stock; each following line is a receipt or requirement on a date, with the projected available quantity after it. A negative balance is a **shortage** — the date it turns negative is when you must act (produce or buy).

## Order reports

| Report | Path | Use it to… |
|---|---|---|
| **Production order information** | `/production/order-information` | List orders, planned orders and components, with filters: **Plant**, **Material**, **Production order**, **Planned order**, **Component**, **Status**, **MRP controller**, **Batch**, **Production version**, and a **Date basis** (Scheduled start, Scheduled finish, Created, Posting date) |
| **Display production order** | `/production/production-order-display` | Open one order: header, components, operations, status |
| **Display production confirmations** | `/production/confirmation-display` | See confirmations posted for an order |
| **Availability check for an order** | `/production/order-availability` | Check components for one order |
| **Production order cost report** | `/production/order-cost-report` | Read the posted costs of an order: totals by company and currency, journal lines, activity cost, WIP postings |
| **Display planned order** | `/production/planned-order-display` | Open a planning proposal |

**Reading the cost report.** Enter the **Order**, optionally **Fiscal year** and **Period from/to**, click **Read posted costs**. Sections: *Totals by company and currency* (what the order has collected), *Journal lines*, *Activity cost of confirmations* (evidence of valuation, not added twice), *Financial WIP postings* (shown separately because they carry no order), and *Basis and limits* (what the report does not cover). Debits are material issues and activity; credits are product receipts.

## Master data displays

See [PP master data → Display screens](master-data.md#display-screens).

> [!NOTE]
> **What happens in the background?**
> Reports post nothing. If a number seems wrong, the cause is nearly always a **missing posting** (a confirmation without a goods receipt, a component not yet issued) — find it in the order's documents rather than in the report.

## Common messages and what to do

| Message (or part of it) | Likely cause | What to do |
|---|---|---|
| *The order is not released.* / *Confirmation does not release it.* | Order still **CREATED** | Release it on *Create production order → Release* |
| *No production order stands for that selection.* | Wrong number or outside your access | Check the number; an order outside your plant access answers like a missing one |
| *More than one production version is eligible. Choose one.* | Overlapping versions for the same lot size/date | Enter the **Production version** explicitly, or fix validity dates |
| *BOM alternative … does not exist for usage …. Create the BOM first.* | Production version points to a missing BOM | Create the BOM, then the version |
| *BOM status … is not released …* | BOM status is not marked as released | Set a released status on the BOM |
| *This BOM / work center is open for change elsewhere. It is not editable here.* | Someone else is editing | Wait; see [Locks](../01-getting-started/navigation-guide.md#locks-is-being-changed-by) |
| *Engineering change management is not implemented.* | You typed a **Change number** | Clear it; validity is by dates |
| *A suboperation is not implemented.* / *Alternative and parallel sequences are not implemented.* | Unsupported routing feature | Use a single sequence of operations |
| *Category … requires a capacity / standard value key / costing assignment.* | Work-centre category rule | Fill the field named in the message |
| *Company … is not assigned to a controlling area.* | Costing on a work centre needs Controlling setup | Ask a finance configurator |
| *A confirmation needs a quantity.* | No yield/scrap/rework | Enter at least one quantity |
| *The actual finish stands before the actual start.* | Dates reversed | Correct the times |
| *The production order was changed by someone else.* | Concurrent edit | Reopen the order and retry |
| *Material … is not extended to plant …* | Product or component not in plant | Extend the material ([MM master data](../02-mm-materials-management/master-data.md#extend-the-material-to-a-plant-purchasing-mrp-accounting)) |
| *No goods movement was proposed. Backflush is not configured, and automatic goods receipt is not configured.* | Info only: the confirmation will move no stock | Issue and receive manually (Steps 5 and 7) or tick the MRP-view flags |
| *Maintain the account determination for this event, then post again.* | Accounting configuration missing | Ask a finance configurator |
| A planning run lists fewer materials than expected | Foreground runs cover up to 40 materials | Use **Background** execution |
| *You do not hold the … capability.* | Missing authority | Ask your administrator ([Login and roles](../01-getting-started/login-and-roles.md#roles-authorities-and-scope)) |

## Checklist: "why is my order stuck?"

1. **Status** — open *Display production order*. CREATED? Release it.
2. **Components** — run *Availability check for an order*; a missing component means stock is short ([MM stock reports](../02-mm-materials-management/reports-and-troubleshooting.md#stock-reports)).
3. **Version/BOM/routing** — is the BOM status released and valid on the order date? Does the version cover the order quantity?
4. **Confirmation** — was it saved (not only **Check**ed)? Look in *Display production confirmations*.
5. **Failed goods movements** — open **COGI**; an automatic issue or receipt may be waiting for correction.
6. **Posting block** — a physical-inventory count may be blocking the component or product.
7. Give the order number and the exact message to your administrator.

---

**← Previous** [PP daily transactions](daily-transactions.md) · **Next →** [SD overview](../04-sd-sales-distribution/overview.md)
