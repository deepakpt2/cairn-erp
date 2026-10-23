# MB5M shelf life list — audit

Target: program RM07MMHD, transaction MB5M. This repository does not name an S/4HANA feature pack. The selection texts and view `V_MMIM_LC_MB5M` are the same program from ECC through S/4HANA on-premise. Parity is against that documented program, not an unnamed FPS.

The list is read-only. It does not post, does not change a batch date, and does not sum material documents into stock.

## Requirement matrix

| Requirement | Status | What stands |
| --- | --- | --- |
| Transaction MB5M / RM07MMHD, not MB52, MB5B, or MB56 | PASS | `INV.SLED.LIST`, alias `MB5M`, route `/inventory/shelf-life-list` |
| Optional material, plant, storage location, and batch | PASS | Inclusive from-to ranges. A bound that is a master must exist. |
| Multiple disjoint or exclusive select-options | PARTIAL | This ERP's report framework is from-to, as MB52 is. Disjoint and exclusive ranges are not added. |
| Remaining shelf life in days | PASS | Blank lists batches already expired (`SLED < key date`). A number lists remaining life of at most that many days, including expired. |
| Total vs warehouse remaining life | PASS | Total is stored expiration less the key date. Warehouse subtracts the storage percentage of minimum remaining shelf life, in the period unit. They are not the same figure. A missing percentage does not fall back to total life. |
| Zero-stock checkbox | PASS | Off excludes unrestricted quantity zero. On includes it. A missing date is not treated as zero stock. |
| Days vs period display | PASS | Filtering stays in days. Period display uses the indicator: space days, 1 weeks of 7 days, 2 calendar months, 3 calendar years. Display does not change the rows or the quantity. |
| Saved ALV layout | NOT APPLICABLE | No layout store exists. A variant name is refused. ALV and list show the same rows. |
| Expiration-date range on the selection screen | NOT APPLICABLE | Not part of RM07MMHD. Not added. The key date is the business date in Asia/Kuwait. |
| Stock quantity | PASS | Unrestricted stock (`LABST` on `V_MMIM_LC_MB5M`). Not the sum of material documents. |
| Quality and blocked stock as list quantity | NOT APPLICABLE | The standard view column is unrestricted. Those quantities are not shown as the list quantity. |
| Missing expiration date | PASS | Named in the undetermined list. No date is invented. |
| Report writes nothing | PASS | No stock, batch, or material document is written by the list. |
| Navigation | PASS | MSC3N, material, MMBE, MB5C, and MB03 when a document already names the batch. |
| Tenant isolation | PASS | Every read is tenant-scoped. |

## Integration map

| Function | Existing source | Status | Gap closed |
| --- | --- | --- | --- |
| Material shelf life | `material` had no MHDRZ, MHDHB, MHDLP, or IPRKZ | FAIL, now PARTIAL | Columns added. Saved on the material screen. Client-level, not per plant. |
| Period-indicator customizing | No PRDKZ | PARTIAL | Standard space/1/2/3 mapping is fixed. A customizing screen was not added. |
| Rounding rule RDMHD | Not stored | NOT APPLICABLE | The list does not recalculate a batch date, so rounding is not applied. |
| Batch manufacture and expiration dates | `batch.manufacture_date`, `batch.shelf_life_expiration_date` | PASS | Read. Not overwritten. |
| Goods receipt SLED calculation | Posting does not derive SLED from production date plus total shelf life | PARTIAL | Left as it stands. MSC1N and MSC2N store the date. The list reads that date. |
| Expiration check on posting | `batch-posting.ts` refuses a batch whose stored date is before the posting date | PASS | Not changed. Minimum remaining shelf life is not a posting refusal. |
| OMJ5 plant and movement check | Not in this ERP | NOT APPLICABLE | Not invented. |
| Goods issue, transfer, reversal | They change `stock_quantity` | PASS | The next list reads that stock. The list does not post. |
| Canonical stock | `stock_quantity`, unrestricted | PASS | One row per material, plant, location, and batch. A document join does not multiply it. |
| Batch display | MSC3N | PASS | Linked. The list does not assign a class. |
| Material document display | `/inventory/material-documents?document=` | PASS | Linked when a line already names the batch. |
| Authorization | Session capability `INV.SLED.LIST` | PASS | Granted to roles that already hold MB52, MSC3N, or MB5C. No separate plant grant exists in this ERP. |
| Report access audit | MB52 and MB5C do not write an access row | NOT APPLICABLE | No new audit table. |

## Files

- `drizzle/9146_mb5m_shelf_life_list.sql` — material columns, capability, term, alias. Applied locally.
- `src/modules/inventory/shelf-life-list.ts` — the list.
- `src/modules/inventory/material-shelf-life.ts` — client-level settings.
- `src/app/inventory/shelf-life-list/page.tsx` and `ShelfLifeListShell.tsx`
- `src/app/inventory/materials/ShelfLifePanel.tsx` and `shelf-life-action.ts`
- `tests/shelf-life-list.test.ts`

## Tests

`tests/shelf-life-list.test.ts` passed 5. `tests/materials.test.ts` passed 24. `tests/batch-master.test.ts` passed 5. `tests/batch-display.test.ts` passed 3. `tests/batch-management-img.test.ts` passed 6. The full suite was not rerun.

## Not claimed

Dynpro parity is not claimed. A named S/4HANA FPS was not in this repository, so a release-specific difference from RM07MMHD is not claimed as tested. Posting still does not calculate or overwrite a batch expiration date. Minimum remaining shelf life is stored and used by the warehouse figure. It does not refuse a goods movement.
