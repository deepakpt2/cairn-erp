# Master Data Concepts

Before you post a purchase order or a sales order you need to understand the two kinds of information the system holds, and how a company is laid out inside it.

## Table of Contents

- [Master data versus transaction data](#master-data-versus-transaction-data)
- [The company structure (organisational units)](#the-company-structure-organisational-units)
- [Where the main master records live](#where-the-main-master-records-live)
- [One master record, several views](#one-master-record-several-views)
- [Numbers are given by the system](#numbers-are-given-by-the-system)
- [Rules every master record follows](#rules-every-master-record-follows)
- [Worked example: what must exist before the first purchase order](#worked-example-what-must-exist-before-the-first-purchase-order)
- [Glossary](#glossary)

> [!IMPORTANT]
> **Prerequisites**
> - You can sign in and use the menu ([Login and roles](login-and-roles.md), [Navigation guide](navigation-guide.md)).
> - To *read* master data you need the display authority of the screen. To *create or change* it you need the create/change authority — usually held by a few people per department.
> - The company structure (company codes, plants, …) is set up once by an administrator or configurator, under **Administration** and the **Configuration** categories. Most users never change it.

## Master data versus transaction data

| | Master data | Transaction data |
|---|---|---|
| **What it is** | The long-lived facts: *what* you buy and sell, *who* you deal with, *where* you keep things | The events: *this* purchase order, *this* goods receipt, *this* invoice |
| **Examples** | A material `RM-FLOUR-25`, a supplier `Northern Mills`, a G/L account `400000`, an employee | Purchase order `4500000012`, accounting document `1900000034` |
| **Changes** | Rarely, deliberately | Every day |
| **Entered** | Once, then reused everywhere | Each time, *using* master data |

**Why it matters:** a transaction copies defaults from master data (a supplier's payment terms, a material's unit, a customer's currency). If the master data is wrong, every transaction built on it is wrong too. That is why creating and changing master data is restricted to a few people, and why the system asks for so many fields up front.

## The company structure (organisational units)

Think of the structure as a set of boxes inside boxes. Each box has a short code. Everything you do belongs to one box at each level.

| Unit | Plain meaning | Relationship | Where it is defined |
|---|---|---|---|
| **Tenant** (client) | One complete, separate set of data. Four characters, e.g. `0100`. | Contains everything below. | **Tenant administration** `/clients` |
| **Company code** | A legal company with its own books (balance sheet and profit and loss), own currency, own country. | Many per tenant. | **Company code define** `/config/company-codes` |
| **Plant** | A site: a factory, warehouse or distribution centre. | Belongs to **exactly one** company code. | **Plant definition** `/config/plants` |
| **Storage location** | A place inside a plant where stock is kept, e.g. "Raw material store". | Belongs to one plant. | **Storage Location definitions** `/config/storage-locations` |
| **Purchasing organisation** | The buying department that negotiates with suppliers. | Assigned to company codes and plants. | `/config/purchasing-orgs` |
| **Purchasing group** | A buyer or team of buyers within it. | — | `/config/purchasing-groups` |
| **Sales organisation** | The selling unit, responsible for customers' terms. | Assigned to a company code, with distribution channels and divisions. | `/config/sales-orgs` |
| **Distribution channel / Division** | *How* you sell (wholesale, retail) / *what* product line. | Assigned to a sales organisation. | `/config/distribution-channels`, `/config/divisions` |
| **Controlling area** | The unit within which costs are tracked and reported. | One or more company codes are assigned to it. | **Define controlling area** `/config/controlling-area` |
| **Chart of accounts** | The list of G/L accounts a company uses. | Assigned to a company code. | `/config/company-codes/assign-chart-of-accounts` |
| **Fiscal year variant** | How the year is cut into posting periods. | Assigned to a company code. | `/config/fiscal-year-variants` |

**A picture in words**

```
Tenant 0100
 ├─ Company code 1000  (currency EUR)   ── controlling area, chart of accounts, fiscal year variant
 │    ├─ Plant 1000 (Main factory)
 │    │    ├─ Storage location 0001 (Raw materials)
 │    │    └─ Storage location 0002 (Finished goods)
 │    └─ Plant 1100 (Distribution centre)
 └─ Company code 2000  (currency USD)
      └─ Plant 2000 (US warehouse)
```

> [!WARNING]
> A plant **must be assigned to a company code** (and that company needs a currency) before it can be used. Screens refuse with messages like *"Plant 1000 is assigned to no company code"* otherwise. This link is also how the system knows which company's books a stock movement belongs to — and which users may see it ([Roles, authorities and scope](login-and-roles.md#roles-authorities-and-scope)).

## Where the main master records live

| Master record | What it holds | Menu location | Screen |
|---|---|---|---|
| **Material** | Everything about something you buy, make or sell: description, unit, type, group, plant data, planning and cost settings | **MM** → Material master | `/inventory/materials` |
| **Business partner** | One record for a company or person you deal with; it can act as **supplier**, **customer** or both | **Finance & Controlling** → Business partners | `/foundation/partners` |
| **G/L account** | An account in the chart of accounts | **Finance & Controlling** → General ledger | `/config/gl-accounts/new` |
| **Cost centre** | A department whose costs you track | **Finance & Controlling** → Controlling | see the FICO guide |
| **Bill of materials (BOM)** | The parts and quantities that make one product | **PP** → Master data | `/production/boms` |
| **Routing** | The ordered operations to make the product, with times | **PP** → Master data | `/production/routings` |
| **Work centre** | A machine or line that carries out operations | **PP** → Master data | `/production/work-centers` |
| **Production version** | Ties a BOM and a routing together for a product in a plant | **PP** → Master data | `/production/production-versions` |
| **Employee** | A person employed, with position and assignments | **HR** → Personnel administration | `/people/employees` |

Each of these gets its own chapter: [MM master data](../02-mm-materials-management/master-data.md), [PP master data](../03-pp-production-planning/master-data.md), [SD master data](../04-sd-sales-distribution/master-data.md), [FICO master data](../05-fico-finance-controlling/master-data.md), [HR master data](../06-hr-human-resources/master-data.md).

## One master record, several views

Some records are too big for one screen, so they are entered in **views**, each owned by the department that knows the facts:

- A **material** is filled in as **Basic**, **Purchasing**, **MRP** (planning) and **Valuation** (accounting) data. A buyer completes the purchasing data; a planner the planning settings; an accountant the valuation.
- A **business partner** is one record with extensions: **Supplier company accounting** and **Supplier purchasing defaults** for a supplier; **Customer company accounting** and **Customer sales area defaults** for a customer.

A material is usually not usable for a transaction until the views *that transaction needs* exist. For example, you cannot buy a material in a plant before it has been extended to that plant; the screen says *"Material … is not maintained in plant …"*.

## Numbers are given by the system

Document numbers (purchase orders, accounting documents, production orders…) are **assigned automatically** from **number ranges**, so you never type or invent them. A number range is an interval, for example `4500000000`–`4599999999`, kept per document type. If a range is exhausted, or missing, the screen refuses with a message naming it; an administrator extends it on **Number range intervals** (`/config/number-ranges`).

Master data differs: **materials**, for instance, can be numbered by you or by the system depending on the **material type** and its number-range setting (*Define material types* and *Define material number ranges* under **MM → Configuration**). The screen tells you which applies.

## Rules every master record follows

1. **Mandatory fields are starred (\*).** The system will not save without them.
2. **Codes are short and fixed.** A plant code or storage location is up to 10 characters; a company code up to 10; a tenant exactly 4. Choose carefully — a code cannot be renamed once transactions use it.
3. **Deactivate instead of delete.** A record that has been used is switched off (for example **Deactivate** on a storage location, with a **Reason**), never erased, so the history stays readable.
4. **Who and when are recorded.** Every record stores who created and who last changed it, and when. Important master changes also go to an audit trail.
5. **Don't change the unchangeable.** Fields that would corrupt history — a material's base unit once stock exists, a plant's company code once documents exist — are refused. The message says why.
6. **Two people, one record.** If someone else is editing it, you see it display-only; if someone saved after you opened it, your save is refused and you reload ([Locks](navigation-guide.md#locks-is-being-changed-by)).
7. **Scope applies.** You only see master and transaction data of the companies and plants in your business access.

## Worked example: what must exist before the first purchase order

Imagine a new bakery, **Sunrise Bakery**, buying flour. In this order, the following must exist. Whoever sets up the system does steps 1–6 once; the buyer works from step 7.

1. A **tenant** `0100` (Tenant administration).
2. A **company code** `1000` "Sunrise Bakery GmbH", country Germany, currency EUR.
3. A **plant** `1000` "Main bakery", assigned to company code `1000`.
4. A **storage location** `0001` "Raw materials" in plant `1000`.
5. A **purchasing organisation** `1000` assigned to company code `1000` and plant `1000`, and a **purchasing group** `B01` for the buyer.
6. Users with a role (Buyer) and **business access** to company `1000`.
7. A **material** `RM-FLOUR-25` "Wheat flour, 25 kg sack", base unit `KG`, extended to plant `1000` with purchasing and valuation data.
8. A **business partner** "Northern Mills" with the **supplier** extensions.
9. Now the buyer can open **Create purchase order** (`ME21N`).

> [!NOTE]
> **What happens in the background?**
> Nothing is posted while you maintain master data — no stock moves and no accounting entries are made. Master data only *prepares* the ground. The first posting happens with a transaction, such as a goods receipt. Changes to master data take effect for **new** transactions; documents already posted keep the values they were posted with.

## Glossary

| Term | Meaning |
|---|---|
| **Authority / capability** | A single permission, e.g. `FIN.JOURNAL.POST`. |
| **Business access / scope** | Which companies and plants a user may reach. |
| **Company code** | A legal company with its own books. |
| **Document** | The record of one transaction (a purchase order, a goods movement, an accounting entry). |
| **Material** | Anything you buy, make, store or sell. |
| **Number range** | The interval from which the system assigns document numbers. |
| **Plant** | A site (factory, warehouse). |
| **Posting** | Recording a transaction so that stock and/or the ledgers change. |
| **Role** | A named bundle of authorities. |
| **Storage location** | A place for stock inside a plant. |
| **Tenant** | A separate set of company data. Also called *client*. |

---

**← Previous** [Navigation guide](navigation-guide.md) · **Next →** [MM overview](../02-mm-materials-management/overview.md)
