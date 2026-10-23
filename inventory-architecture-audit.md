# Inventory architecture audit

Read from the current code in `src/modules/inventory`, the foundation masters it posts against, and the screens under `src/app/inventory` and `src/app/config`. No screen was added. Aliases below are the ones already registered. A three-digit movement number is an input alias unless the table stores that number as the key.

## How a movement is built

Stock is one balance per tenant, material, plant, storage location, and stock type. The plant is the valuation area. A valued movement writes four things in one transaction: a material document, the stock balance, the plant valuation, and one journal. A posted material document is not edited. Correction is another document.

The journal does not carry a G/L account chosen on the movement. It reads account determination by event and valuation class. The movement type may name the event. It must not name the account.

## Schemas

All inventory tables are tenant-scoped. Quantity is 23,3. Money is 23,4.

### Masters

| Table | What it holds |
|---|---|
| `account_category_reference` | OMSK reference. A material type names one. Inactive cannot be newly assigned. |
| `valuation_class` | Class master. Optional material-type narrowing. Does not store a G/L account. |
| `valuation_class_reference` | Which classes a reference permits. One class may belong to more than one reference. |
| `industry_sector` | One-character sector a material is created under. |
| `material_type` | Type, procurement default, price-control default (`S` / `V`), number-range keys, account-category reference, purchase-order permission. |
| `material_type_valuation` | Quantity updating and value updating per type per plant. |
| `material_group` | Reporting and search classification. |
| `material_number_range_group` | Pair of internal and external `MATERIALNR` intervals. Membership is the pair on the type, not a second assignment table. |
| `material_period_control` | One row per company code. Current and previous material period, and two backposting flags. Initialized once, shifted, never deleted. |
| `mrp_controller` | Planner key. Seeded as `001`. No maintenance screen. |
| `material` | Client material. Base unit, sector, weights, deletion flag. Status `INCOMPLETE`, `CREATED`, or `MAINTAINED`. |
| `material_plant` | Purchasing and MRP data, deletion flag, lot sizes, safety stock, reorder point. No batch-management flag. |
| `material_valuation` | Price control `STANDARD` or `MOVING_AVERAGE`, both prices, price unit, currency, book quantity, book value, future price, previous-period price. |
| `material_uom_conversion` | Exact numerator and denominator from an alternative unit to the base unit. |
| `planning_file` | Net-change marker for a material and plant. |

### Ledger

| Table | What it holds |
|---|---|
| `movement_type` | Direction, reference category, reversal type, kind, stock types, plant and location rules, negative-stock policy, valuation relevance, account-assignment, and the account-determination events for a difference movement. Flags for batch, serial, special stock, and valuation type are stored. The stock row has no columns for those. |
| `material_document` | Immutable header. Status `POSTED`, `PARTIALLY_REVERSED`, or `REVERSED`. Journal number, reversal pair, request key, fingerprint. |
| `material_document_line` | Movement, material, plant, storage location, stock type, issue or receipt, quantities, price, value, purchase-order reference, production-order reference, reversal lineage, return lineage. No batch, serial, special stock, or valuation type. |
| `stock_quantity` | Balance. Key includes a blank storage location. No table check against negative stock. The location flag is read by issue and transfer, not by the table. |

Stock types the vocabulary allows: `UNRESTRICTED`, `QUALITY`, `BLOCKED`.

### Demand, count, and output

| Table | What it holds |
|---|---|
| `reservation_header` / `reservation_item` | Planned withdrawal. Does not move stock until a goods issue names it. |
| `output_type` / `output_message` | Slip catalogue and dispatch queue. Media are print and email. Fax and EDI are refused. |
| `production_order` / `production_order_component` | Header and a typed component list. There is no bill of material to explode. Status is `CREATED` or `RELEASED`. Company code is taken from the plant. |
| `physical_inventory_document` / `physical_inventory_item` | Count in progress. Book quantity is frozen. A count posts nothing. |
| `physical_inventory_difference_allocation` | Which material-document line posted which count item. Reversal releases the link. It does not delete it. |
| `physical_inventory_recount_link` | Recount document raised from an original item. One active link blocks difference posting of that item. |

Foundation tables a movement also requires: `plant`, `storage_location` (`allow_negative_stock`, active flag), `company_code`, `account_determination`, `document_type`, posting-period control, and the number-range tables.

## Posting services

Each service inserts its own delivered movement rows on first use if they are missing. Opening movement-type configuration is not required for the first post.

| Service | Capability | Route | Journal type | What it writes |
|---|---|---|---|---|
| `postGoodsReceipt` | `INV.GR.POST` | `/inventory/goods-receipt` | `WE` | Receipt against a purchase order. Increases unrestricted stock, purchase-order history, valuation, and posts inventory against GR/IR. A standard-price difference posts to price difference. |
| `reverseGoodsReceipt` | same | same | reversal of the journal | Counter document. |
| `postGoodsIssue` | `INV.GI.POST` | `/inventory/goods-issue` | `WA` | 201 to a cost centre, or 551 scrapping. Values at the plant price. May withdraw a reservation in the same transaction. |
| `postGoodsIssue` via MIGO | `INV.MIGO.POST` | `/inventory/migo` | `WA` | 261 only, against a released production order and a component item. |
| `postProductionReceipt` | `PROD.ORDER.GR` | `/inventory/migo` | `WE` | 101 of the order header material. Credits production output, debits inventory. |
| `postReturnDelivery` | `INV.RETURN.POST` | `/inventory/return-delivery` | `WE` | 122 against a posted receipt. Reduces received quantity. Not a reversal. |
| `postTransfer` | `INV.TRANSFER.POST` | `/inventory/transfer-posting` | `WA` when the move is valued | 311, 301, or 321. Plant-to-plant is valued. The other two move quantity only. |
| `reverseTransfer` | same | same | reversal | Counter of the transfer. |
| `reverseMaterialDocument` | `INV.REVERSE` | `/inventory/reversal` | reversal | MBST. Also offered from MIGO cancellation against a material document. |
| `postDifferences` | `INV.PHYINV.DIFF.POST` | `/inventory/physical-inventory-posting` | `WA` when the movement values | Whole remaining difference. Looks up the difference movement by kind and direction, not by a typed number. |
| `changeMaterialPrice` / `releaseFuturePrices` | `INV.MATERIAL.PRICECHANGE` | `/inventory/price-change` | `SA` | Current period revalues book price and stock value. Previous period posts only if that material period is open, and does not change the current book. Future price is stored until release. No material document. |
| `createReservation` / `withdrawReservation` | `INV.RESERVATION.CREATE` | `/inventory/reservations` | none | Demand only. Withdrawal is the goods issue. |
| `createProductionOrder` / `releaseProductionOrder` | `PROD.ORDER.CREATE` / `PROD.ORDER.RELEASE` | `/production/orders` | none | Order master. A 261 refuses a status other than `RELEASED`. |

Read-only services, no stock write: stock overview (`/inventory/stock-overview`), warehouse stocks (`/inventory/warehouse-stocks`), stock on a posting date (`/inventory/stock-posting-date`), stock reconciliation (`/inventory/stock-reconcile`), material document display and list, physical-inventory difference list.

Count, recount, and cancellation of a count document do not post stock. A posting block on a count document refuses receipt, issue, transfer, production receipt, and reversal for that material and plant until the count is finished or cancelled.

### Account-determination events the posters read

Maintained at `/config/account-determination`. The alias is search text only.

| Event | Alias | Required for |
|---|---|---|
| `INVENTORY` | BSX | Every valued movement. Split by valuation class. |
| `GR_IR_CLEARING` | WRX | Purchase-order receipt and return. No valuation class. |
| `PRICE_DIFFERENCE` | PRD | Standard-price variance on receipt, return, plant transfer, and price change. |
| `CONSUMPTION` | GBB | 201. |
| `SCRAP` | GBB | 551. |
| `PRODUCTION_CONSUMPTION` | GBB | 261. |
| `PRODUCTION_OUTPUT` | GBB | 101 from a production order. Must not be the consumption account. |
| `OFFSETTING_INVENTORY` | GBB | Physical-inventory difference. Uses general modifier `DIFF`. |

A missing row refuses the posting and names the event and the valuation class. Nothing is left half-posted.

### Number objects a movement draws

| Object | Used by | Seeded interval |
|---|---|---|
| `MATDOC` | Every material document | Yes, prefix `MD` |
| `RF_BELEG` | The journal behind a valued movement | Customer-maintained. The standard package creates the document types that draw it. |
| `MATERIALNR` | Internal material numbers | Interval is assigned through material number-range groups. |
| `PHYINV` | Count documents | Yes, prefix `PI`. Year-relevant. |
| `PRODORDER` | Production orders | Yes, prefix `PRD` |
| `RESERV` | Reservations | An interval is seeded. The number-range object roster does not list `RESERV`, so number-range maintenance cannot show it. |

`DELIVERY`, `BILLING`, `SALESORD`, and `PRODCONF` exist as number objects. No inventory service posts them.

## Movement types

Stored keys and the numbers a person types are not the same list. Goods receipt resolves a receipt for a purchase order by direction and reference category, and takes the first row. The other posters resolve their own delivered key. A row created in movement-type configuration is not used unless a poster looks it up.

| Alias | Stored key | Direction | Reference | Where it posts | Valuation |
|---|---|---|---|---|---|
| — | `GOODS_RECEIPT_PO` | RECEIPT | Purchase order | Goods receipt | Yes. Inventory and GR/IR. |
| — | `RECEIPT_REVERSAL` | REVERSAL | Material document | Goods-receipt reversal | Reverses the journal. |
| 122 | `RETURN_TO_VENDOR` | ISSUE | Purchase order | Return delivery | Yes. Reverses the receipt accounts. |
| 123 | `RETURN_TO_VENDOR_REV` | REVERSAL | Material document | Return reversal | Yes. |
| 101 | `PROD_RECEIPT_ORDER` | RECEIPT | Production order | MIGO | Yes. Inventory and production output. |
| 102 | `PROD_RECEIPT_ORD_REV` | REVERSAL | Production order | Reversal | Yes. |
| 201 | `GI_ISSUE_CC` | ISSUE | Material document | Goods issue | Yes. Inventory and consumption. Cost centre required. |
| 202 | `GI_ISSUE_CC_REVERSAL` | ISSUE | Material document | Not enterable. MBST posts it. | Yes. |
| 551 | `GI_SCRAP` | ISSUE | Material document | Goods issue | Yes. Inventory and scrap. |
| 552 | `GI_SCRAP_REVERSAL` | ISSUE | Material document | MBST only. | Yes. |
| 261 | `PROD_ISSUE_ORDER` | ISSUE | Production order | MIGO only | Yes. Inventory and production consumption. |
| 262 | `PROD_ISSUE_ORDER_REV` | ISSUE | Production order | MBST only. | Yes. |
| 201 | `RESERV_ISSUE_CC` | ISSUE | Reservation | Reservation create. Not a stock posting. | No. |
| 261 | `RESERV_ISSUE_ORDER` | ISSUE | Reservation | Reservation create. Not a stock posting. | No. |
| 311 | `TRANSFER_SLOC` | TRANSFER | Material document | Transfer and MIGO | No. Same plant, different location, unrestricted to unrestricted. |
| 312 | `TRANSFER_SLOC_REV` | TRANSFER | Material document | Reversal only. | No. |
| 301 | `TRANSFER_PLANT` | TRANSFER | Material document | Transfer and MIGO | Yes, if the two plants value differently. |
| 302 | `TRANSFER_PLANT_REV` | TRANSFER | Material document | Reversal only. | No on the counter row. |
| 321 | `TRANSFER_STYPE` | TRANSFER | Material document | Transfer and MIGO | No. Quality to unrestricted, same plant and location. |
| 322 | `TRANSFER_STYPE_REV` | TRANSFER | Material document | Reversal only. | No. |
| 701 | `701` | RECEIPT | Physical inventory | Difference posting | Yes, unless the configured row says otherwise. Inventory and offsetting inventory, modifier `DIFF`. |
| 702 | `702` | ISSUE | Physical inventory | Difference posting | Same. |

Refused by name, not posted as a one-step move: `303`, `313`, `315`. There is no in-transit stock type. The chart of accounts seeds account `120300` Goods in transit, and no movement posts to it.

There is no movement that puts stock into quality or blocked. `321` only takes stock out of quality. A goods receipt always writes unrestricted.

MIGO is a matrix, not a second posting engine.

| Action | Reference | Result |
|---|---|---|
| Goods receipt + order | A01 + R08 | Posts 101 here. |
| Goods issue + order | A07 + R08 | Posts 261 here. |
| Transfer + other | A04 + R10 | Posts 311, 301, or 321 here. |
| Cancellation + material document | A03 + R05 | Posts the reversal here. |
| Goods receipt + purchase order | A01 + R01 | Opens the goods-receipt screen. |
| Goods issue + reservation | A07 + R04 | Opens the goods-issue screen. |
| Return delivery | A02 + any | Refused. The return screen exists. This cell does not open it. |
| Anything else | | Refused, and the refusal names why. |

## Configuration screens

| Screen | Alias | Route | What a posting reads from it |
|---|---|---|---|
| Company code | OX02 | `/config/company-codes` | The plant's company, chart, currency, and fiscal-year variant. |
| Plant | OX10 | `/config/plants` | Valuation area. Creating a plant seeds quantity and value updating for the standing material types. |
| Storage location | OX09 | `/config/storage-locations` | Name, active flag, negative-stock flag. |
| Material type | OMS2 | `/config/material-types` | Type, number ranges, account-category reference, updating rules. |
| Valuation class | OMSK | `/config/valuation-classes` | Class, reference, and which classes a type may use. |
| Material group | OMSF | `/config/material-groups` | Optional on the material. |
| Industry sector | OMS3 | `/config/industry-sectors` | Required to create a material. |
| Material number ranges | MMNR | `/config/material-number-ranges` | Internal and external intervals for `MATERIALNR`. |
| Material period | OMSY, MMPV, MMRV | `/config/material-period-control` | Current and previous period, and whether the previous period may be posted. |
| Movement types | OMJJ | `/config/movement-types` | The catalogue. Posters still seed and resolve their own delivered rows. A G/L account cannot be stored here. |
| Account determination | OBYC | `/config/account-determination` | The eight inventory events above. |
| Document types | OBA7 | `/config/document-types` | `WE`, `WA`, and `SA` are in the standard package. Posters do not look them up. They send the code. |
| Posting periods | OB52 | `/config/posting-periods` | Financial period. Independent of the material period. Both must accept the date. |
| Number ranges | SNRO | `/config/number-range-objects` | `MATDOC`, `RF_BELEG`, `MATERIALNR`, `PHYINV`, `PRODORDER`. Not `RESERV`. |
| Units per material | CUNI | `/inventory/uom-conversion` | Conversion used when the entered unit is not the base unit. |
| Price change | MR21 | `/inventory/price-change` | Posts or stores a price. It is not a configuration master. |

A packaged tenant also receives material types `RAW`, `SEMI`, `FIN`, `TRAD`, and `SERV`, reference `0001`, and valuation classes `RAW_INVENTORY`, `SEMI_INVENTORY`, `FINISHED_INVENTORY`, and `TRADE_INVENTORY`. An empty tenant creates those on the screens. Saving a plant does not create a valuation class.

## What must already stand before a valued movement posts

1. Company code, plant, and the plant's company assignment.
2. Material type, and a valuation class permitted by that type's account-category reference.
3. Material with a base unit, a plant view, and an accounting view in the plant currency. The accounting view must be complete enough to value: class, price control, price, price unit.
4. Material period control for the company, and a posting date in the current period, or in the previous period only when backposting is allowed.
5. Financial posting period open for that date. OB52 does not gate the configuration screens. It does gate the journal.
6. Account determination for the events that movement uses, on the company chart, for that valuation class.
7. Document type `WE` or `WA`, and `SA` for a price change, and a `RF_BELEG` interval the type can draw. The standard package creates the types. A tenant whose document-type table is empty cannot post.
8. A `MATDOC` interval.
9. A quantity-updating movement requires a storage location of that plant, and the location must be active. A blank line takes the document location (order item, reservation item, or component), then the plant default. A typed location is never replaced. A transfer names both sides and does not take the default. A non-stock material, a reservation, and a whole-plant count may omit one.
10. For a purchase-order receipt: a released order, the same material and plant, and a quantity that does not exceed what remains. A unit that does not convert refuses the line.
11. For 201: a cost centre. For 261 and 101: a released production order. For a reservation withdrawal: an open reservation item with movement allowed.
12. For a difference posting: a counted item, no active recount, and a difference movement whose events are configured.
13. No physical-inventory posting block on that material and plant.
14. The acting user must hold the capability. A packaged role with `INV.*` covers the inventory postings. There is no later screen to grant a second user.

## Missing, and not configurable around

These are absent as tables or as posting behaviour. A flag on the movement type does not create them.

- **Batch.** No batch master, no batch on the stock key or the document line. A typed batch is refused. The movement-type flag is stored and not read by the posters.
- **Serial number.** Same. The flag is stored. There is no serial table.
- **Special stock.** No sales-order, project, consignment, or subcontract stock. The flag is stored. The stock key has no special-stock indicator.
- **Split valuation.** The valuation area is the plant. There is no valuation type on stock or on the document line.
- **Inspection stock as a receipt.** Quality and blocked are stock types, but nothing receipts into them. Only `321` moves quality to unrestricted, and only if quality stock already exists.
- **Two-step transfer and stock transport.** `303`, `313`, and `315` are refused. There is no in-transit balance and no stock-transport order. Account `120300` is unused by inventory posting.
- **Warehouse management.** Warehouse stocks are plant and storage-location balances. There is no bin, quant, or transfer order.
- **Stock ageing.** No report and no layer table. Stock on a posting date is a reconstruction of movements, not an ageing.
- **Sales goods issue.** No delivery document and no 601. The delivery number object has no poster.
- **Bill of material, routing, confirmation.** A production order stores the components that were typed. `PRODCONF` has a number object and no service.
- **Cycle counting.** A count document is created by naming materials. There is no cycle indicator and no automatic proposal.
- **Material ledger.** One price per plant. No ledger settlement.
- **Document lock on receipt and MIGO.** A reservation change takes a record lock. A goods receipt and MIGO do not. Two users can post the same order line together. The only movement block is the physical-inventory posting block.
- **Goods receipt and the storage-location master.** A quantity-updating receipt now refuses a blank or unassigned location. A blank line uses the order item, then the plant default, and only when that default is an active location of the plant.
- **Movement configuration is not the only source.** Each poster seeds its own rows and most of them resolve a fixed key. Two reservation movements reuse the numbers 201 and 261 as separate keys from the posting movements. Changing a description in OMJJ is safe. Expecting a new OMJJ row to become a new posting is not.
- **Return delivery is not on the MIGO matrix.** The return service and screen exist. MIGO still says a return has no chain.
- **Price-change document type is a constant.** It sends `SA`. It does not look up an active type. `SA` is in the standard package, so a packaged tenant has it. An empty document-type table does not.
- **Reservation number object.** Posting draws `RESERV`. The object roster used by number-range maintenance does not include it.
- **Goods-issue reversals are stored as issues.** 202, 552, and 262 have direction `ISSUE`, not `REVERSAL`. They are refused if typed on the issue screen. MBST is the only way to post them.
- **Output.** Slips are `WE01` and `WA01`. Fax, EDI, and a spool are refused or absent. Email needs a recipient or the dispatch fails and records why.
- **MRP controller, lot sizing, and work centres.** Named on the workbench as pending. No screen. The controller `001` is seeded with the material defaults. Total planning stops where sales demand would be required. That is outside this ledger.

## What this pass does not authorize

The batch master, a warehouse, a stock-transport order, and a second posting engine for movement types are not implied by this audit. The posting services above are the ones that move stock today.
