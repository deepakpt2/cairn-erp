# MM — Master Data

The records you set up **once** so that purchase orders, goods receipts and invoices can be created quickly and correctly: materials, suppliers, and sources of supply.

## Table of Contents

- [1. The material master](#1-the-material-master)
  - [Create a material (Basic data)](#create-a-material-basic-data)
  - [Extend the material to a plant: Purchasing, MRP, Accounting](#extend-the-material-to-a-plant-purchasing-mrp-accounting)
  - [Block, flag for deletion, copy, history](#block-flag-for-deletion-copy-history)
  - [Units of measure per material](#units-of-measure-per-material)
- [2. Suppliers (business partners)](#2-suppliers-business-partners)
- [3. Sources of supply](#3-sources-of-supply)
- [Configuration (set once by an administrator)](#configuration-set-once-by-an-administrator)
- [Mandatory and optional fields at a glance](#mandatory-and-optional-fields-at-a-glance)

> [!IMPORTANT]
> **Prerequisites**
> - The company structure exists: a company code, a **plant** assigned to it, and a **storage location** ([Master data concepts](../01-getting-started/master-data-concepts.md)).
> - You hold the authority for the screen. Material master: `INV.MATERIAL.MAINTAIN` (basic data) plus the authority for each view; valuation (the **Accounting / Costing** view) is a separate authority so that only finance staff see prices.
> - Menu path: **MM – Materials Management → Material master**.

---

## 1. The material master

**Screen:** *Material master* — `/inventory/materials` (menu items **Create material**, **Material master list**, **Material planning settings**; command box code `MM01`).

The material master is entered in **views**. A tab strip shows each view with its status: **Not created**, **Incomplete**, **Created**, **Maintained** or **Blocked**.

| View (tab) | Level | Owner | What it holds |
|---|---|---|---|
| **Basic data** | whole tenant | Material master maintainer | Number, type, group, description, base unit, weights |
| **Purchasing** | per plant | Buyer | Purchasing group, order unit, delivery tolerances |
| **MRP** | per plant | Planner | Planning method, controller, lot size, safety stock, lead times |
| **Accounting / Costing** | per plant | Accountant | Valuation class, price control, standard / moving price |
| **Sales** | per sales organisation + channel | Sales | See [SD master data](../04-sd-sales-distribution/master-data.md) |
| **Deletion flags**, **Shelf life** | per tenant / plant | Maintainer | See below |

Tabs for *Production, Sales general / Plant, Storage, Forecasting, Quality, Warehouse* appear greyed out with the word **Pending** — they are not yet available.

### Create a material (Basic data)

**Sample:** a 25 kg sack of wheat flour bought for the bakery.

1. Choose **MM → Material master → Create material** (or type `MM01` in the command box). The **Basic data** tab opens on an empty form.
2. **Material** — leave blank to let the system assign the next number from the material type's internal range, **or** type your own number (letters, digits, `_ . -`, up to 40 characters, e.g. `RM-FLOUR-25`). A number you type is checked against the *external* interval of the type's number range. The field converts to capitals as you type.
3. **Material type** — choose `RAW` (raw material). *The type cannot be changed later.* It decides whether the material has stock and a valuation.
4. **Material group** — choose the grouping used in reporting (default `GENERAL`).
5. **Description** — type `Wheat flour, 25 kg sack` (max 40 characters).
6. **Base unit** — choose `KG`. *The base unit cannot be changed once plant views exist.* All stock is kept in this unit.
7. **Industry sector** — keep the default `M` unless told otherwise.
8. Optional: **Barcode / EAN** (max 32), **Gross weight**, **Net weight** and **Weight unit**.
9. Optional: tick **Blocked for operational use** (only to stop all use of the material).
10. **Reason / maintenance note** is optional on creation (required when you later block or unblock).
11. Click **Save**. A green message *"View saved. Status: …"* appears with a link **Open material and its views**.

| Field | Mandatory? | Rule from the system |
|---|---|---|
| Material | Optional on create (system numbers it); fixed afterwards | Capitals/digits/`_ . -`; ≤ 40 |
| Material type | **Mandatory** | Must be active; immutable after creation |
| Industry sector | **Mandatory** on create | Must be an active sector |
| Material group | Needed to complete the view | Must be active |
| Description | Needed to complete the view | ≤ 40 characters |
| Base unit | Needed to complete the view | Must be a valid unit |
| Gross / net weight | Optional | Gross must not be below net; a **weight unit** is then required |
| Barcode | Optional | ≤ 32 characters |

> [!TIP]
> You may **save an incomplete view**. The status shows **Incomplete** so another department can finish it. But a material whose basic view is incomplete **cannot be used in any transaction** — you will be told *"The basic view of … is incomplete. Complete description, group and base unit before operational use."*

### Extend the material to a plant: Purchasing, MRP, Accounting

A material can only be bought, received or issued in a plant where it has been **extended**. Open the material (click its number in the list), then:

1. In the plant selector choose the **Plant** (e.g. `1000 · Main bakery`) and click **Select plant**.
2. Open the **Purchasing** tab and fill:
   - **Purchasing group** *(default `001`)* — the buyer team.
   - **Order unit** — must equal the base unit for now (a different unit needs a unit conversion; the screen says so).
   - **Manufacturer part number** — optional.
   - **Overdelivery tolerance (%)** / **Underdelivery tolerance (%)** — how much more or less than ordered a receipt may be; between 0 and 100.
   Click **Save**.
3. Open the **MRP** tab:
   - **Planning method** — *Requirements planning*, *Reorder-point planning* or *No planning*. A material that holds no stock (a service) must use *No planning*.
   - **MRP controller** — the planner responsible. Only controllers of **this plant** are offered; define them under **Configuration → MRP controllers** (`/config/mrp-controllers`).
   - **Procurement type** — *External procurement*, *In-house production* or *Both*.
   - **Lot-sizing procedure** — *Lot for lot* or *Fixed lot size*; then **Fixed lot size**, **Minimum lot size**, **Maximum lot size (0 = unlimited)**. The maximum must not be below the minimum.
   - **Safety stock**, **Reorder point**, **Planned delivery time (days)** and **In-house production time (days)** (0–3650).
   - Tick **Withdraw components on a confirmation** (backflush) and **Receive the finished good on a final confirmation** if production confirmations should move stock automatically ([PP daily transactions](../03-pp-production-planning/daily-transactions.md)).
4. Open the **Accounting / Costing** tab (needs the valuation authority):
   - **Valuation class** — links the material to its stock account; only classes allowed for the material type are offered.
   - **Price control** — *Standard price* or *Moving average price*.
   - **Price unit** (default 1), **Standard price**, **Moving average price**.
   - **Book quantity** and **Book value** are shown **read-only** — they come from postings, never from typing.

> [!WARNING]
> Once stock exists you cannot change valuation settings here: *"Valuation settings cannot be changed here while stock exists."* Price changes with stock need a balanced revaluation document ([Change material price](reports-and-troubleshooting.md#valuation-reports)).

### Block, flag for deletion, copy, history

- **Block** — tick *Blocked for operational use* on Basic data and enter a **Reason** (≥ 3 characters). Blocked materials are refused in transactions.
- **Deletion flags** tab — flag the material for deletion at **client level** or for one **plant**, giving a reason. If stock exists the screen warns you first. A flag is a marker; nothing is erased.
- **Copy basic data** — in the **Material master list**, click *Copy basic data* beside a material to start a new one with the same basic data. Plant and valuation views are not copied.
- **Change history** — link on the material page; shows every change with who, when, old → new value.
- **Shelf life** tab — **Minimum remaining shelf life**, **Total shelf life**, **Storage percentage**, **Period** and a **Reason**, for perishable goods.

### Units of measure per material

**Screen:** *Units of measure per material* — `/inventory/uom-conversion`. Use it when you buy in one unit and stock in another (buy in sacks, stock in kilograms). Enter how many base units one alternative unit equals. Only then can an order unit other than the base unit be used.

---

## 2. Suppliers (business partners)

**Screen:** *Business partners* — `/foundation/partners` (button **Create business partner**; command box `XK01` or `XD01`). A supplier is a business partner with the **Supplier** role, extended for accounting and purchasing.

**Sample:** Northern Mills, a flour supplier in Hamburg.

1. Open **Finance & Controlling → Business partners** and choose **Create business partner**.
2. **General data**:
   - **Partner number** — *mandatory*; capitals, digits, `_ . -`; ≤ 40, e.g. `SUP-NORTHERN`.
   - **Name** — `Northern Mills GmbH`.
   - **Search term** (≤ 40), **Country** (from configured countries), **Region / State**, **City**, **Street / Address**, **Postal code**, **Tax number**, **Email**, **Phone** — optional but name, country and city complete the record.
   - **General roles** — tick **Supplier** (and **Customer** if they also buy from you).
   - **Blocked for operational use** — leave unticked.
   - **Reason / maintenance note** — *mandatory* (3–500 characters), e.g. `New supplier`.
3. Click **Save**. Roles do **not** by themselves allow trading — they need the next two extensions.
4. Open the partner and fill **Supplier company accounting** for the company code:
   - **Supplier reconciliation account** — the G/L control account the supplier's liabilities post to (must be an unblocked supplier reconciliation account of the company's chart).
   - **Payment terms** — e.g. 30 days net.
   - **Payment methods** — up to 10 methods, only those enabled for outgoing payments in the company's country.
   - **Blocked** — tick to stop postings for this company.
   - **Reason** — mandatory.
5. Fill **Supplier purchasing defaults** for each purchasing organisation:
   - **Order currency**, **Purchasing group**, **Payment-term override (optional)**, **Delivery term code** (Incoterms), **Delivery term location**, and **Blocked for this purchasing organisation**. **Reason** is mandatory.

A supplier with no accounting extension cannot be invoiced; a supplier with no purchasing extension cannot receive purchase orders from that organisation. A **blocked** supplier is refused: *"Supplier … is blocked."* / *"…is blocked for purchasing organization …"*.

> [!NOTE]
> **What happens in the background?** Saving partner data posts nothing. The reconciliation account you pick is what later accounting entries use when an invoice credits this supplier ([Daily transactions → Enter an incoming invoice](daily-transactions.md#6-enter-an-incoming-invoice)).

---

## 3. Sources of supply

| Screen | Path | Purpose |
|---|---|---|
| **Purchasing info record** | `/purchasing/info-record` | The agreed price, delivery time, minimum quantity and tolerances for one supplier–material pair, per purchasing organisation and plant. |
| **Purchasing source list** | `/purchasing/source-list` | Which suppliers are *allowed* (or required) to deliver a material to a plant. |
| **Purchasing quota arrangement** | `/purchasing/quota-arrangement` | Splits demand between several suppliers by percentage. |
| **Maintain vendor evaluation** | `/purchasing/vendor-evaluation` | Scores a supplier on price, quality, delivery. |
| **Purchase contract** | `/purchasing/contracts` | A long-term agreement with a target value or quantity; orders are "called off" against it. |
| **Scheduling agreement** | `/purchasing/scheduling-agreements` | A long-term agreement with a delivery schedule. |

**Create an info record** (Sample: flour from Northern Mills at 14.50 EUR per 25 kg sack):

1. Open **MM → Procurement → Sources of supply → Purchasing info record**.
2. Under **Open a record** choose **Supplier**, **Material**, **Purchasing organization** and **Plant**, then **Open**. If a record already links this supplier and material the system opens it and does **not** create a second.
3. Fill the segment: **Planned delivery time** (days), **Minimum order quantity** and its unit, **Order unit**, **Overdelivery tolerance**, **Underdelivery tolerance**.
4. Add a price row: **Net price**, **Validity** dates. *A new price is a new row; leave the amount empty to keep existing prices. Zero is a price.*
5. Enter a **Reason** (3–500 characters) and save. To switch the record off, use **Deactivate record**; **Reactivate** brings it back.

In a purchase order, picking a supplier and material proposes the price and delivery time from the info record.

---

## Configuration (set once by an administrator)

These screens live under the **Configuration** category and define the choices offered above. Ordinary users do not change them.

| Screen | Path | Defines |
|---|---|---|
| Purchasing organisations | `/config/purchasing-orgs` | Buying units |
| Purchasing groups | `/config/purchasing-groups` | Buyer teams |
| Material types | `/config/material-types` | RAW, FIN, SERV… and whether they hold stock/value |
| Material groups | `/config/material-groups` | Reporting groups |
| Material number ranges | `/config/material-number-ranges` | Internal / external number intervals |
| Number range intervals | `/config/number-ranges` | Document numbering |
| Release strategies | `/config/release-strategies` | Approval steps for orders and requisitions |
| MRP controllers | `/config/mrp-controllers` | Planner keys per plant |
| Batch management | `/config/batch-management` | Batch settings (also batch level, classes, status, search strategies) |

## Mandatory and optional fields at a glance

The system marks mandatory fields with `*`. Beyond those, some fields are "needed to complete the view" — you can save without them, but the view then shows **Incomplete** and cannot be used for postings. Rule of thumb: **description, group, base unit** (basic); **purchasing group, order unit** (purchasing); **planning method, controller** (MRP); **valuation class** (accounting).

---

**← Previous** [MM overview](overview.md) · **Next →** [MM daily transactions](daily-transactions.md)
