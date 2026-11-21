# PP — Master Data

The four records that describe *how a product is made*: the **bill of material**, the **work centre**, the **routing** and the **production version**.

## Table of Contents

- [How the four fit together](#how-the-four-fit-together)
- [1. Bill of material (BOM)](#1-bill-of-material-bom)
- [2. Work centre](#2-work-centre)
- [3. Routing](#3-routing)
- [4. Production version](#4-production-version)
- [Display screens](#display-screens)
- [Configuration (set once by an administrator)](#configuration-set-once-by-an-administrator)

> [!IMPORTANT]
> **Prerequisites**
> - The finished product and every component exist as materials extended to the plant ([MM master data](../02-mm-materials-management/master-data.md)).
> - A plant assigned to a company code exists ([Master data concepts](../01-getting-started/master-data-concepts.md)).
> - Authorities: *Change material BOM* `PROD.BOM.CHANGE`, *Change work center* `PROD.WORKCENTER.CHANGE`, *Change routing* `PROD.ROUTING.CHANGE`, *Change production version* `PROD.VERSION.CHANGE` (the display screens need the matching `…DISPLAY`).
> - Menu path: **PP – Production Planning → Master data → BOM, routing, work centre, version**.

**Sample product used here:** `FG-LOAF-500` "White loaf 500 g", made in plant `1000`. One batch of **100 PC** needs **40 KG** of `RM-FLOUR-25`, **1.2 KG** of `RM-YEAST`, and runs through *Mix → Bake → Pack*.

## How the four fit together

```
Production version 0001 (material FG-LOAF-500, plant 1000)
   ├── BOM        P / alternative 01   → components & quantities
   └── Routing    group + counter      → operations → work centre BAKE01
```

Create them in this order: **BOM → work centre → routing → production version**, because each refers to the one before.

---

## 1. Bill of material (BOM)

**Screen:** *Change material BOM* — `/production/boms` (read-only: *Display material BOM* `/production/bom-display`; *BOM explosion and where-used* `/production/bom-explosion`).

1. Open **Change material BOM**. In **Header** fill:

   | Field | Example | Mandatory? | Notes |
   |---|---|---|---|
   | **Material** | `FG-LOAF-500` | **Yes** | The product. Fixed once saved |
   | **Plant** | `1000` | **Yes** | Fixed once saved |
   | **BOM usage** | `P` (Production) | **Yes** | Where the BOM is used. Fixed once saved |
   | **Alternative** | *(blank)* | No | Blank = the system assigns the next `01`–`99`; up to 2 characters |
   | **Status** | `01` Released | No | The status must be *released* for planning and orders to use it |
   | **Base quantity** | `100` | **Yes** | Component quantities are for this much product; must be positive |
   | **Base unit** | `PC` | **Yes** | ≤ 6 characters |
   | **Valid from** | today | **Yes** | |
   | **Valid to** | *(blank)* | No | Blank is stored as 31 Dec 9999 |
   | **Header text** | `Standard recipe` | No | ≤ 40 |
   | **Change number** | — | No | Engineering change management is not implemented; a change number is refused |
   | **Deletion flag** | | No | Marks the BOM for deletion |

2. Under **Components** click the add button and fill one row per ingredient:

   | Field | Example | Meaning |
   |---|---|---|
   | **Item** | `0010` | Line number (proposed) |
   | **Category** | stock item | Kind of line |
   | **Component** | `RM-FLOUR-25` | The material consumed; its description comes from the material master |
   | **Quantity** | `40` | Per base quantity |
   | **Unit** | `KG` | |
   | **Scrap %** | `2` | Expected loss on this component (0–100) |
   | **Sort string**, **Item text** | | Optional |
   | **Fixed quantity** | ☐ | Quantity does *not* scale with order size |
   | **Bulk** | ☐ | Bulk material (not tracked individually) |
   | **Phantom** | ☐ | An assembly that is not stocked but "exploded" into its own components |
   | **Co-product** | ☐ | A by-product produced rather than consumed |

3. Click **Save**. The message states the BOM number and its version, and how many existing production orders use this material (they are *not* changed).

**Copy a BOM:** use the **Copy** block: enter **Reference material**, **Plant**, **Usage**, **Alternative**, tick *copy items*, and save to start from an existing recipe.

> [!WARNING]
> A later BOM change **never rewrites** a production order already created: each order keeps its own saved component snapshot ([Daily transactions](daily-transactions.md#2-create-and-release-a-production-order)).
> A BOM that someone else is changing shows *"This BOM is open for change elsewhere. It is not editable here."*

> [!NOTE]
> **What happens in the background?** Saving a BOM posts nothing and moves no stock. It is the recipe planning and order creation will read.

---

## 2. Work centre

**Screen:** *Change work center* — `/production/work-centers` (display: `/production/work-center-display`).

1. Fill **Basic data**:

   | Field | Example | Mandatory? |
   |---|---|---|
   | **Plant** | `1000` | **Yes** |
   | **Work center** | `BAKE01` (≤ 8 characters) | **Yes** |
   | **Category** | `MACH` (Machine) or `LINE` (Production line) | **Yes** — defines what else is required |
   | **Description** | `Deck oven line 1` (≤ 40) | **Yes** |
   | **Person responsible**, **Location**, **Usage**, **Standard value key** | | No (unless the category demands them) |
   | **Copy from plant / Copy from work center** | | No — start from an existing one |

2. **Default values → Control key** — the default control key copied to routing operations that leave theirs blank.
3. **Capacities** — add a row: **Capacity category**, **Factory calendar**, **Start time**, **End time** (`HH:MM`), and a **Standard value parameter** that loads this capacity in the capacity-load report. A category can be used only once per work centre.
4. **Scheduling** — **Capacity category**, **Processing formula**.
5. **Costing** (if the category requires it) — a cost centre and a validity interval.
6. Save.

The category can make fields mandatory; the screen tells you: *"Category … requires a capacity / a standard value key / a costing assignment / a scheduling capacity category."* The costing cost centre's company must belong to a controlling area.

*Background:* nothing is posted; capacity data feeds **Capacity load** and costing.

---

## 3. Routing

**Screen:** *Change routing* — `/production/routings` (display: `/production/routing-display`).

1. Fill the header:

   | Field | Example | Mandatory? |
   |---|---|---|
   | **Task list type** | `N` Routing | **Yes** |
   | **Group** | blank | No — blank assigns the next group |
   | **Counter** | blank | No — blank assigns the next |
   | **Plant** | `1000` | **Yes** |
   | **Description** | `White loaf routing` | No |
   | **Usage** | production | **Yes** |
   | **Status** | released | No |
   | **Base quantity** / **Base unit** | `100` / `PC` | **Yes** |
   | **Lot from / Lot to** | `1` / `10000` | No |
   | **Valid from** | today | **Yes** |
   | **Valid to**, **Change number**, **Deletion flag** | | No |

2. **Material assignments** (one per line, `material|plant`): `FG-LOAF-500|1000`. A routing may have none.
3. **Operations** (one per line): `number|text|work center|control key|value key|parameter,quantity,unit|material,usage,alternative,item,quantity|execution order`. Example: `0010|Mix|MIX01|PP01` then `0020|Bake|BAKE01|PP01`, `0030|Pack|PACK01|PP01` (`PP01` is the control key *Internal processing*). The operation number is **not** the execution order. The line under the form lists the control keys and value keys available.
4. Click **Create routing** (or **Save change** when editing).

*Not supported:* alternative and parallel sequences, suboperations, and engineering change numbers — the screen refuses them. A standard-value formula is stored but not calculated.

*Background:* nothing is posted. Operations are copied into a production order at creation and drive confirmation and costing.

---

## 4. Production version

**Screen:** *Change production version* — `/production/production-versions` (display: `/production/production-version-display`).

| Field | Example | Mandatory? |
|---|---|---|
| **Plant** | `1000` | **Yes** |
| **Material** | `FG-LOAF-500` | **Yes** |
| **Version** | `0001` (≤ 4) | **Yes** |
| **Description** | `Standard` | No |
| **Valid from** / **Valid to** | today / blank | **From: Yes** |
| **Lot from** / **Lot to** / **Lot unit** | `0` / `100000` / `PC` | **Yes** |
| **BOM usage** / **BOM alternative** | `P` / `01` | **Yes** — the BOM must already exist |
| **Task list type** / **Routing group** / **Group counter** | `N` / the group number the routing was given / its counter | **Yes** |
| **Receiving location** | `0002` | No — where finished goods are received |

Save. Errors you may see: *"BOM alternative … does not exist for usage …. Create the BOM first."* and *"More than one production version is eligible. Choose one …"* (when several versions cover the same lot and date).

> [!NOTE]
> **What happens in the background?** Nothing is posted. When you create a production order, the system picks the version (or uses the one you name) and copies its BOM components into the order.

## Display screens

| Screen | Path | Shows |
|---|---|---|
| Display material BOM | `/production/bom-display` | One BOM |
| BOM explosion and where-used | `/production/bom-explosion` | The full multi-level structure of a product, or every product using a component |
| Display routing | `/production/routing-display` | Operations of a routing |
| Display work center | `/production/work-center-display` | Work-centre data and capacities |
| Display production version | `/production/production-version-display` | A version and its BOM/routing |

## Configuration (set once by an administrator)

| Screen | Path | Defines |
|---|---|---|
| Production order type | `/config/production-order-types` | Order types (e.g. `PP01`) |
| Order type-dependent parameters | `/config/order-type-parameters` | Defaults per order type and plant |
| Production scheduling profile | `/config/scheduling-profiles` | How dates are set |
| Availability check configuration | `/config/availability-check` | What counts as available |
| Checking control | `/config/checking-control` | Which receipts/issues the check includes |
| Define MRP controllers | `/config/mrp-controllers` | Planner codes per plant |

---

**← Previous** [PP overview](overview.md) · **Next →** [PP daily transactions](daily-transactions.md)
