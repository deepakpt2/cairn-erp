# Cairn browser walkthrough

Server: `https://cairn.deepakpt.com`

Do the steps in order. Each step is one screen. The code in the command bar is the function. The short code, where one exists, is only a search alias. If the bar does not know the alias, paste the URL.

Do not send the owner token or the password here. Choose a password of at least 10 characters, with a letter and a digit. Enter the owner token only on the server page that asks for it.

If a screen refuses, copy the message and the remedy, then stop if a later posting needs that row. A report may be opened empty. A posting may not.

Dates below are in October 2026, so they fall in the open year. Today for this plan is 23 October 2026.

## Standing keys

| What | Value |
|---|---|
| Tenant | `1000` |
| Company | `1000` · Meridian Auto Components Pvt Ltd |
| Country / currency / time zone | `IN` / `INR` / `Asia/Kolkata` |
| Chart | `CA01` |
| Fiscal year variant | `V3` · April to March · financial year 2026 is 1 April 2026 to 31 March 2027 |
| Posting period variant | `C001` |
| October 2026 | period `7` of financial year `2026` |
| Controlling area | `A000` |
| Plant | `1000` · Pune |
| Storage locations | `0001` raw store, `0002` floor, `0003` finished warehouse, `0099` receipt area |
| Purchasing organisation | `1000` |
| Purchasing group | `001` |
| User | `admin` |

The create-tenant form opens with `0200`, `KW`, `USD`, `Asia/Kuwait`, and the development box checked. Change all of those.

## 1. Tenant

**1. Create tenant** · `CFG.PLT.CLIENT.ONBOARD` · `/clients/new`

| Field | Enter |
|---|---|
| Owner provisioning token | the server token, on this page only |
| Tenant key | `1000` |
| Tenant name | `Meridian Auto Components` |
| Legal name | `Meridian Auto Components Pvt Ltd` |
| Country | `IN` |
| Currency | `INR` |
| Time zone | `Asia/Kolkata` |
| What the tenant starts with | **Empty tenant** |
| Username | `admin` |
| Full name | `Walkthrough Administrator` |
| Email | leave blank |
| Password | yours |
| Development tenant | uncheck |

Do not choose Standard general data. That would hide the chart, document types, periods and purchasing groups behind a package. Do not choose Copy. Copy is offered and then refused.

After submit, the server should open sign-in with client `1000` and user `admin`.

**2. Sign in** · `/signin`

Client `1000`, user `admin`, your password. You should land on the workbench or the launchpad.

**3. Tenant list** · `CFG.PLT.CLIENT.DEFINE` · `/clients`

Confirm `1000` is active, country `IN`, currency `INR`, and not marked development. Do not create a second tenant.

**4. Workbench** · `CFG.WORKBENCH` · `SPRO` · `/config`

Open it once so you know the tree. Do not mark anything complete by hand. Saving a screen marks its own activity.

**5. Term registry** · `PLT.REGISTRY.SEARCH` · `/registry`

Search `OX02`. It should resolve to company code. This is a search, not a posting.

## 2. Chart and document types

Create these before the company, because the company assignment points at them.

**6. Chart of accounts** · `CFG.FIN.COA.DEFINE` · `OB13` · `/config/chart-of-accounts`

| Field | Enter |
|---|---|
| Chart | `CA01` |
| Name | `Meridian chart` |
| Language | `EN` |
| Account number length | `6` |
| Blocked | no |

**7. Group chart** · same screen, group-chart section

| Field | Enter |
|---|---|
| Group chart | `GCA1` |
| Name | `Meridian group chart` |
| Language | `EN` |

Then change `CA01` and set its group chart to `GCA1`.

**8. Account group** · `/config/gl-accounts` · account-group section

| Field | Enter |
|---|---|
| Chart | `CA01` |
| Account group | `GENL` |
| Description | `General ledger accounts` |
| From | `000000` |
| To | `999999` |
| Active | yes |

**9. G/L accounts** · `CFG.FIN.GLACCOUNT.CREATE` · `FS00` · `/config/gl-accounts/new`

Repeat this screen once per row. Chart `CA01`, group `GENL`, language `EN`. Open-item and reconciliation are blank unless the row says otherwise. A cost-object account must require a cost centre.

| Account | Name | Type | Extra |
|---|---|---|---|
| `101000` | Bank — current account | Asset | |
| `110000` | Trade receivables | Asset | open item, reconciliation Customers |
| `110100` | Intercompany receivables | Asset | open item, reconciliation Customers |
| `120000` | Raw materials inventory | Asset | reconciliation Material |
| `120200` | Finished goods inventory | Asset | reconciliation Material |
| `140000` | Input tax receivable | Asset | tax relevant |
| `150000` | Plant and machinery | Asset | reconciliation Assets |
| `150100` | Accumulated depreciation — plant | Asset | |
| `200000` | Trade payables | Liability | open item, reconciliation Vendors |
| `200100` | Intercompany payables | Liability | open item, reconciliation Vendors |
| `210000` | Goods received not invoiced | Liability | open item |
| `220000` | Output tax payable | Liability | tax relevant |
| `230000` | Accrued liabilities | Liability | open item |
| `280000` | Share capital | Equity | |
| `290000` | Retained earnings | Equity | |
| `300000` | Revenue — domestic sales | Revenue | |
| `400000` | Cost of goods sold | Expense | |
| `410000` | Raw material consumption | Expense | requires cost centre |
| `410200` | Inventory price differences | Expense | |
| `440000` | Inventory differences | Expense | |
| `500000` | Salaries and wages | Expense | requires cost centre |
| `510000` | Rent expense | Expense | requires cost centre |
| `520000` | Depreciation expense | Expense | requires cost centre |
| `560000` | Bank charges | Expense | |
| `560100` | Cash discount allowed | Expense | |
| `560200` | Cash discount received | Revenue | |
| `570000` | Foreign exchange gain or loss | Expense | |

**10. Display an account** · `CFG.FIN.GLACCOUNT.DISPLAY` · `FSS0` · `/config/gl-accounts`

Chart `CA01`, account `200000`. Confirm open item and vendor reconciliation.

**11. Account view** · `/config/gl-accounts/view`

Same account. This route is built and is not in the command registry. Open it by URL.

**12. Change an account** · `CFG.FIN.GLACCOUNT.CHANGE` · `FSP0` · `/config/gl-accounts/edit`

Account `101000`. Add the sort key or line text the screen offers, reason `House bank account`. Save.

**13. Copy chart** · `CFG.FIN.COA.COPY` · `OBY7` · `/config/chart-of-accounts/copy`

Source `CA01`, target `CA02`, name is taken by the screen, copy texts yes, overwrite no. This gives the transfer screen a second chart. Do not assign `CA02` to the company.

**14. Transfer accounts** · `CFG.FIN.GLACCOUNT.TRANSFER` · `FS15` · `/config/gl-accounts/transfer`

There is only one company so far. Skip the post. Open the screen, run a test with source and target both `1000` only after step 20, chart `CA01`, account from `101000` to `101000`, test run yes. If it refuses a same-company transfer, record that and continue. It is not required for the receipt.

**15. Document types** · `CFG.FIN.DOCTYPE.DEFINE` · `OBA7` · `/config/document-types`

Number range object `RF_BELEG`, sub-object `GENERAL`, for every row.

| Type | Name | Allowed account types | Reference required |
|---|---|---|---|
| `SA` | General journal entry | `S` | no |
| `KR` | Vendor invoice | `SK` | yes |
| `KG` | Vendor credit memo | `SK` | yes |
| `KZ` | Vendor payment | `SK` | no |
| `KA` | Vendor down payment | `SK` | no |
| `DR` | Customer invoice | `SD` | yes |
| `DZ` | Customer payment | `SD` | no |
| `WE` | Goods receipt | `SM` | no |
| `WA` | Goods issue | `SM` | no |
| `AA` | Asset acquisition | `SA` | no |
| `AF` | Depreciation run | `SA` | no |

**16. Number range objects** · `CFG.PLT.NUMBERRANGE.DEFINE` · `SNRO` · `/config/number-range-objects`

Confirm `RF_BELEG` exists. If the journal later says the range is missing, return to the next step.

**17. Number range intervals** · `/config/number-ranges`

This is the interval screen for the same activity. It has no separate alias.

| Field | Enter |
|---|---|
| Object | `RF_BELEG` |
| Company | `1000` |
| Sub-object | `GENERAL` |
| Prefix | `JE` |
| From | `1` |
| To | `999999` |
| Length | `6` |
| Status | active |

Also confirm a purchasing-order range exists, object `PURCHORD` or the name the screen shows for purchase orders. If it asks you to create one: prefix `POF`, length `7`, from `1`, to `9999999`. Material documents: object `MATDOC`, length `10`. Supplier invoices: object `VENDINV`, length `10`.

## 3. Calendar, periods, banks, tax

**18. Fiscal year variant** · `CFG.FIN.FYV.DEFINE` · `OB29` · `/config/fiscal-year-variants`

| Field | Enter |
|---|---|
| Variant | `V3` |
| Name | `April-March (India)` |
| Calendar year | no |
| Year dependent | no |
| Regular periods | `12` |
| Special periods | `0` |
| Active | yes |

Then the twelve periods. Year shift `0` means the calendar year of the financial year start. Year shift `1` means the next calendar year.

| Period | Month | Last day | Year shift |
|---|---|---|---|
| 1 | 4 | 30 | 0 |
| 2 | 5 | 31 | 0 |
| 3 | 6 | 30 | 0 |
| 4 | 7 | 31 | 0 |
| 5 | 8 | 31 | 0 |
| 6 | 9 | 30 | 0 |
| 7 | 10 | 31 | 0 |
| 8 | 11 | 30 | 0 |
| 9 | 12 | 31 | 0 |
| 10 | 1 | 31 | 1 |
| 11 | 2 | 28 | 1 |
| 12 | 3 | 31 | 1 |

**19. Posting period variant** · `CFG.FIN.PPV.DEFINE` · `OBBO` · `/config/posting-period-variants`

Variant `C001`, name `Meridian periods`.

**20. Company code** · `CFG.ORG.COMPANYCODE.DEFINE` · `OX02` · `/config/company-codes`

| Field | Enter |
|---|---|
| Company | `1000` |
| Name | `Meridian Auto Components Pvt Ltd` |
| Country | `IN` |
| Currency | `INR` |
| City | `Pune` |
| Tax registration | `27AAQCM0000A1Z5` |

The same page also assigns the company to a chart. If that block is on this page, chart `CA01`. If it is not, use the next step.

**21. Assign chart to company** · `CFG.ORG.COMPANYCODE.ASSIGN_COA` · `/config/company-codes/assign-chart-of-accounts`

Company `1000`, chart `CA01`.

**22. Assign fiscal year variant** · `CFG.FIN.FYV.ASSIGN` · `OB37` · `/config/fiscal-year-variants/assign-company-codes`

Company `1000`, variant `V3`.

**23. Assign posting period variant** · `CFG.FIN.PPV.ASSIGN` · `OBBP` · `/config/posting-period-variants/assign-company-codes`

Company `1000`, variant `C001`.

**24. Open periods** · `FIN.CLOSE.PERIOD` · `OB52` · `/config/posting-periods`

Variant `C001`. One rule per account type. Period from `1`, period to `12`, past year shift `0`, future year shift `1`.

| Account type | Special periods |
|---|---|
| `S` G/L | yes |
| `K` vendors | no |
| `D` customers | no |
| `A` assets | yes |
| `M` materials | no |

**25. Industries** · `CFG.ORG.INDUSTRY.DEFINE` · `OB44` · `/config/industries`

Code `AUTO`, name `Auto components`.

**26. Banks** · `CFG.FIN.BANK.DEFINE` · `FI01` · `/config/banks`

Country `IN`, bank key `HDFC01`, name `Meridian Bank`. This bank is fictional.

**27. House bank** · `CFG.FIN.HOUSEBANK.DEFINE` · `FI12` · `/config/house-banks`

Company `1000`, house bank `HB01`, country `IN`, bank key `HDFC01`. Account id `MAIN`, account number `50200012345678`, currency `INR`, G/L `101000`.

**28. Tax codes** · `CFG.FIN.TAXCODE.DEFINE` · `FTXP` · `/config/tax-codes`

| Code | Name | Country | Type | Rate |
|---|---|---|---|---|
| `G18` | GST 18 percent | `IN` | GST, or the purchase-and-sales type the list offers | `18` |
| `G0` | GST zero rated | `IN` | same | `0` |

**29. Payment terms** · `CFG.FIN.PAYTERMS.DEFINE` · `OBB8` · `/config/payment-terms`

Code `NET30`, description `Net 30 days`, baseline `document date`, net days `30`.

**30. Payment methods** · `CFG.FIN.PAYMENTMETHOD.DEFINE` · `/config/payment-methods`

| Code | Description | Country | Direction |
|---|---|---|---|
| `T` | Bank transfer | `IN` | outgoing |
| `C` | Cheque | `IN` | outgoing |

**31. Tolerance group** · `CFG.FIN.TOLERANCE.DEFINE` · `OBA4` · `/config/tolerance-groups`

Group `1000`, name `Meridian clerks`. Allow a small difference, `100.00` INR, if the screen requires an amount. Assign it to `admin` if the screen has a user field.

**32. Exchange rates** · `CFG.FIN.EXRATE.MAINTAIN` · `OB08` · `/config/exchange-rates`

Type `M` if asked. From `USD`, to `INR`, valid from `2026-04-01`, rate `83.50`. Direct quotation. A second row: `EUR` to `INR`, `90.00`, same date.

**33. Retained earnings** · `CFG.FIN.RETAINED.DEFINE` · `OB53` · `/config/retained-earnings`

Chart `CA01`, indicator `X`, account `290000`.

**34. Special G/L** · `CFG.FIN.SPECIALGL.DEFINE` · `OBXR` / `OBYR` · `/config/special-gl`

| Indicator | Account type | Special account | Reconciliation | Name |
|---|---|---|---|---|
| `A` | Customer | `110000` | `110000` | Customer down payment |
| `A` | Vendor | `200000` | `200000` | Vendor down payment |

Use the indicator letters the screen already offers if `A` is rejected. Write down the letter you saved. The down-payment steps use it.

**35. Intercompany clearing** · `CFG.FIN.IC.DEFINE` · `OBYA` · `/config/intercompany-clearing`

There is one company. Open the screen. If it allows a company to clear with itself, do not save that. Record the message if it refuses a single company. Continue.

**36. Account determination** · `CFG.FIN.ACCTDET.DEFINE` · `OBYC` · `/config/account-determination`

Chart `CA01`. Leave valuation class and modifier blank unless the row says otherwise.

| Event | Alias on screen | Valuation class | Modifier | Account |
|---|---|---|---|---|
| `INVENTORY` | BSX | `RAW_INVENTORY` | | `120000` |
| `GR_IR_CLEARING` | WRX | | | `210000` |
| `PRICE_DIFFERENCE` | PRD | `RAW_INVENTORY` | | `410200` |
| `TAX` | MWS | | | `140000` |
| `CONSUMPTION` | GBB | `RAW_INVENTORY` | | `410000` |
| `OFFSETTING_INVENTORY` | GBB | `RAW_INVENTORY` | `VBR` | `400000` |
| `SCRAP` | GBB | `RAW_INVENTORY` | | `440000` |
| `RETAINED_EARNINGS` | | | `X` | `290000` |
| `FXGAIN` | | | | `570000` |
| `FXLOSS` | | | | `570000` |
| `CASH_DISCOUNT` | SKTO | | | `560200` |
| `PAYMENT_DIFFERENCE` | DIF | | | `560000` |

`RAW_INVENTORY` does not exist yet. Save the rows that do not need it now: GR/IR, tax, retained earnings, FX, discount, payment difference. Return to this screen after step 55 and add the inventory rows. If the screen refuses an unknown valuation class, that is expected. Record it.

## 4. Logistics structure

**37. Plant** · `CFG.ORG.PLANT.DEFINE` · `OX10` · `/config/plants`

| Field | Enter |
|---|---|
| Plant | `1000` |
| Name | `Pune plant` |
| Country | `IN` |
| City | `Pune` |
| Language | `EN` |
| Production site | yes |
| Storage site | yes |

On the same page, assign plant `1000` to company `1000`. There is no separate route for that assignment.

**38. Storage locations** · `CFG.ORG.STORAGELOC.DEFINE` · `OX09` · `/config/storage-locations`

Plant `1000` for each.

| Location | Name |
|---|---|
| `0001` | Raw materials store |
| `0002` | Production floor |
| `0003` | Finished goods warehouse |
| `0099` | Goods receipt area |

Do not allow negative stock.

**39. Purchasing organisation** · `CFG.PROC.PURORG.DEFINE` · `OX08` · `/config/purchasing-orgs`

Organisation `1000`, name `Meridian purchasing`.

**40. Assign purchasing organisation to company** · `CFG.PROC.PURORG.ASSIGN_COMPANY` · `/config/purchasing-orgs/assign-company`

Organisation `1000`, company `1000`.

**41. Assign purchasing organisation to plant** · `CFG.PROC.PURORG.ASSIGN_PLANT` · `OX17` · `/config/purchasing-orgs/assign-plant`

Organisation `1000`, plant `1000`. The company is read from the plant. Do not expect a company field.

**42. Purchasing groups** · `CFG.PROC.PURGROUP.DEFINE` · `/config/purchasing-groups`

No alias is registered. Use the URL.

| Group | Name |
|---|---|
| `001` | Raw materials buying |
| `002` | Components and parts |
| `003` | Services and indirect spend |

**43. Industry sector** · `CFG.INV.INDUSTRYSECTOR.DEFINE` · `OMS3` · `/config/industry-sectors`

Sector `M`, name `Mechanical engineering`. The material master allows one character.

**44. Material groups** · `CFG.INV.MATERIALGROUP.DEFINE` · `OMSF` · `/config/material-groups`

| Group | Name |
|---|---|
| `RAW` | Raw materials |
| `PACK` | Packaging |
| `PROD` | Manufactured goods |

**45. Material types** · `CFG.INV.MATERIALTYPE.DEFINE` · `OMS2` · `/config/material-types`

| Type | Name | Price control | Procurement | Quantity and value updating at plant `1000` |
|---|---|---|---|---|
| `RAW` | Raw material | Moving average | External | yes / yes |
| `FIN` | Finished product | Standard | Internal | yes / yes |

Internal purchase orders allowed for `FIN`. External purchase orders allowed for `RAW`.

**46. Material number range** · `CFG.INV.MATERIALRANGE.DEFINE` · `MMNR` · `/config/material-number-ranges`

If you will type material numbers yourself, an external range is enough. Group for type `RAW`, external, from `MAT-10000`, to `MAT-19999`. You will type `MAT-10001`, `MAT-10002` and `MAT-20001`.

**47. Movement types** · `CFG.INV.MOVETYPE.CONFIG` · `OMJJ` · `/config/movement-types`

Open `101` goods receipt against a purchase order, `201` goods issue to a cost centre, and `311` storage-location transfer. Confirm each is active. Do not add a movement type. If `101` is missing, record that and stop before the goods receipt.

**IMG Batch Management** · `CFG.INV.BATCHIMG.DISPLAY` · `OCHA` · `/config/batch-management`

This walk does not change a batch setting here. OCHA opens the batch management index. It is not CT04. It does not define a characteristic, assign a class, create a batch, or post. The index lists OMCE, OMCS, OMCU, OMAB, OMCZ, OMAD, OMCT, ODOC, OMCV, OMCW, OMCX, OMA1, OMCY, OMCG, and OMCWB. It also links MBC1, BMC1, CU70, MB5C, BMBC, MSC2N, and MSC3N. Opening it writes nothing. Class type 023 is not active. Movements 341 and 342 are not this screen.

**Batch level** · `CFG.INV.BATCHLEVEL.DEFINE` · `OMCE` · `/config/batch-level`

This walk does not use batches. Leave the level unset. An unset level is not plant level. The screen stores one code for the client, `0`, `1`, or `2`, and it does not post. A closed period does not block it. `OMCS`, `OMCZ`, `OMAD`, `MSC1N`, `MSC2N`, and `MSC3N` are not this screen.

**Batch status** · `CFG.INV.BATCHSTATUS.DEFINE` · `OMCS` · `/config/batch-status`

Leave the indicator blank for this walk. Active is the character `1`, not a label. The level is read from the previous screen. This screen does not select a plant and does not post. A closed period does not block it. `OMCU`, `OMAB`, `MSC1N`, `MSC2N`, and `MSC3N` are not this screen.

**Initial status of a new batch** · `CFG.INV.BATCHINITIAL.DEFINE` · `OMAB` · `/config/batch-initial-status`

Do not change a material type on this walk. Opening the screen does not restrict a batch. Checked is the character `X`, stored for a future batch only. An existing batch is not rewritten. This screen does not create a material type, select a plant, or post. Restricted use is not blocked stock. `OMCS` and `MSC1N` are not this screen.

**Batch classification for goods movements** · `CFG.INV.BATCHCLASSIFY.DEFINE` · `OMCV` · `/config/batch-classification`

Leave the classification control blank on this walk. Blank is no branching, and a goods movement posts as it does today. `1`, `2`, `3`, and `4` ask for classification. Class type `023` is not active, so a goods movement with one of those codes is refused before stock or a journal. Characteristic copying, WIP-batch adoption, and extended CFC are not stored and are not functional. This screen does not create a movement type, change its posting rules, or rewrite a posted movement. `OMJJ` and `MSC1N` are not this screen.

**Inventory Management strategy types** · `CFG.INV.BATCHSTRATEGY.DEFINE` · `OMCW` · `/config/batch-strategy-types`

Do not create a strategy type on this walk. Opening the screen writes nothing. Usage is `H` and application is `ME`. The key is the condition type, one to four uppercase letters or digits. The description is at most 20 characters. An access sequence is optional and must already stand on `OMCX`. Naming it does not run an access. Selection classes, sort rules, quantity-proposal exits, and batch splits are not stored and do not select a batch. Class type `023` is not active. A goods movement is not changed. `OMCY` and `MBC1` are not this screen.

**Inventory Management access sequences** · `CFG.INV.BATCHACCESS.DEFINE` · `OMCX` · `/config/batch-access-sequences`

Do not create an access sequence on this walk. Opening the screen writes nothing. Usage is `H` and application is `ME`. The key is one to four uppercase letters or digits. The description is at most 30 characters. An access may name a condition table that already stands on `OMA1`. The access number is two digits and need not follow the previous one. Naming a table does not search it, and an exclusive indicator, a requirement, and a field mapping are not stored. A strategy type may name a standing sequence, and that name does not change a goods movement. `OMCY` and `MBC1` are not this screen.

**Inventory Management condition tables** · `CFG.INV.BATCHCONDTABLE.DEFINE` · `OMA1` · `/config/batch-condition-tables`

Do not create a condition table on this walk. Opening the screen writes nothing. Usage is `H` and application is `ME`. The number is 501 to 999. Tables 001 to 500 are refused and are not seeded. The key fields are movement type, customer, storage location, supplier, material group, material, material type, special stock, and plant. A field outside that list is refused. No physical table is generated, no condition record is stored, and no batch is selected. `OMA0`, `OMCX`, and `MBC1` are not this screen.

**Inventory Management search procedures** · `CFG.INV.BATCHSEARCH.DEFINE` · `OMCY` · `/config/batch-search-procedures`

Do not create a search procedure on this walk. Opening the screen writes nothing. Usage is `H` and application is `ME`. The key is one to six uppercase letters or digits. The description is at most 30 characters. A step may name a strategy type that already stands on `OMCW`. The step number is three digits and the counter is two digits. Neither need follow the previous one. Naming a strategy type does not select a batch. A requirement, a manual indicator, and a movement-type allocation are not stored. `OMCG` and `MBC1` are not this screen.

**Allocate IM search procedure** · `CFG.INV.BATCHALLOCATE.DEFINE` · `OMCG` · `/config/batch-search-allocations`

Do not allocate a procedure on this walk. Opening the screen writes nothing. The key is a movement type that already stands, and own stock. Blank special stock is not a plant and not a wildcard. The search procedure must already stand on `OMCY`. A transfer procedure is optional. The check indicator `X` records the request and does not check a batch. No batch is selected, and a goods movement is not changed. `MBC1` is not this screen.

**Batch search strategy** · `INV.BATCHSTRATEGY.MAINTAIN` · `MBC1` / `MBC2` / `MBC3` · `/inventory/batch-search-strategies`

Do not create a search strategy on this walk. Opening the screen writes nothing. The strategy type must already stand on `OMCW` and name an access sequence. The key combination is a condition table named by that sequence. A field is required only when that combination names it. Valid from must not be later than valid to. A selection class, a sort rule, and a quantity proposal are not stored. No batch is selected, and a goods movement is not changed.

**Batch class** · `INV.BATCHCLASS.MAINTAIN` · `BMC1` / `BMC2` / `BMC3` · `/inventory/batch-classes`

Do not create a batch class on this walk. Opening the screen writes nothing. This is not `CL01`. The batch level must already stand on `OMCE`. Plant level names class type `022`. Material or client level names `023`. The type is not typed and is not hard-coded. A characteristic must already stand, and a blocked characteristic is refused. The class name is at most 18 characters. One description is stored. The class is not assigned to a material or a batch. No characteristic value is stored, no batch is selected, and a goods movement is not changed.

**Batch sort sequence** · `INV.BATCHSORT.MAINTAIN` · `CU70` / `CU71` / `CU72` · `/inventory/batch-sort-sequences`

Do not create a sort sequence on this walk. Opening the screen writes nothing. The name is at most 18 characters. The description is at most 40 characters. Status `0` is in preparation, `1` is released, and `2` is locked. A characteristic must already stand, except `LOBM_LGORT` and `LOBM_MENGE`, which sort stock and must not stand in a batch class. Each criterion is ascending or descending. The row order is the priority. A weighting factor is not stored. The sequence is not assigned to a search strategy. No batch is selected, and a goods movement is not changed.

**Batch level and status conversion** · `CFG.INV.BATCHCONVERT.DEFINE` · `OMCT` · `/config/batch-conversion`

Do not convert on this walk. Opening the screen writes nothing. This is not `OMCE` and not `OMCS`. The level codes stay `0`, `1`, and `2`. A dry run writes nothing. A confirmed check records the finding and does not change the level, the status, a batch, stock, or a document. Duplicate batch identifiers are reported and are not merged. A batch with no plant is not given one. Movements `341` and `342` are not posted. Live conversion is not available.

**Activate document management for batches** · `CFG.INV.BATCHDOCMGMT.DEFINE` · `ODOC` · `/config/batch-document-management`

Do not activate document management on this walk. Opening the screen writes nothing. The indicator is `X` or blank. A missing row is not active. `X` shows a documents tab on the batch master. Blank hides that tab. Neither save creates a document, uploads a file, or stores a link. Deactivation does not delete a batch. `CV01N`, `MB56`, `MB57`, and `MB5C` are not this screen.

**Activate WIP batch** · `CFG.PROD.WIPBATCH.DEFINE` · `OMCWB` · `/config/wip-batch`

Do not activate WIP batch on this walk. Opening the screen writes nothing. The indicator is `X` or blank. A missing row is not active. Activation requires a batch level and an explicit confirmation. Once `X` is saved it cannot be revoked. The save does not create a WIP batch, a production order, or a material document. `LOG_PP_WIP_BATCH`, original-batch reference material, a confirmation profile, and a control key are not this screen.

**Batch information cockpit** · `INV.BATCH.COCKPIT` · `BMBC` · `/inventory/batch-cockpit`

Open the cockpit and name a material or a batch that already stands. Opening the screen writes nothing. A batch with no material document is still listed. Stock is the stock master, shown in the material base unit, and is not the sum of document lines. Restricted use is not unrestricted, quality, or blocked stock. A row opens the direct material-document lines, the purchase order on a line, and the supplier on that order. It is not a top-down or bottom-up explosion. A class, a characteristic, an inspection lot, and a sales document are not filters on this screen. `MSC3N`, `MB5C`, and `MMBE` are the detail screens. A closed posting period does not block it.

**Batch status management in plant** · `CFG.INV.BATCHSTATUSPLANT.DEFINE` · `OMCU` · `/config/batch-status-plants`

Do not select a plant on this walk. Opening the screen does not select one. Selected is the character `X`, not `1`. The plant name is read from the plant master. This screen applies only when the batch level is plant. It does not change `OMCS`, create a batch, or post movement `341` or `342`. Restricted use is not blocked stock. `OMAB` and `MSC1N` are not this screen.

**Internal batch number assignment** · `CFG.INV.BATCHNUMBER.DEFINE` · `OMCZ` · `/config/batch-number-assignment`

Leave both settings inactive for this walk. Active is the character `X`, not a label and not `1`. The client flag is not a plant. The plant flag permits a number only for an account-assigned goods receipt, and that receipt is not posted here. This screen does not create `BATCH_CLT` interval `01`, a batch, or a stock receipt. `OMAD` is the number range, and it is not this screen. A closed period does not block it.

**Number ranges for batch numbers** · `CFG.INV.BATCHRANGE.DEFINE` · `OMAD` · `/config/batch-number-ranges`

Do not create an interval on this walk. Opening the screen does not create `01`. The object is `BATCH_CLT` only. From and to are digits, shown with leading zeros. The current number is not moved backwards here. A typed batch number is not drawn from `01`. Interval `02` checks a typed number only when it stands. This screen does not create a batch and does not post. `OMCZ`, `OMCE`, and `MSC1N` are not this screen.

**Create batch** · `INV.BATCH.CREATE` · `MSC1N` · `/inventory/batches/new`

Do not create a batch on this walk. The material must already be batch-managed, and that indicator is not on the material screen yet. Type the batch number. This walk leaves OMCZ inactive, so a blank number is not assigned. This screen does not post stock. `MSC2N` and `MSC3N` are not this screen.

**Change batch** · `INV.BATCH.CHANGE` · `MSC2N` · `/inventory/batches/change`

Do not change a batch on this walk. Open a batch that already stands. The material, plant, and batch number cannot be changed. This screen does not post stock and does not post movements 341 or 342. `MSC1N` and `MSC3N` are not this screen.

**Display batch** · `INV.BATCH.DISPLAY` · `MSC3N` · `/inventory/batches/display`

Do not open a batch on this walk. This screen reads a batch that already stands. It does not change the batch and does not post. The status is `X` or blank, not `1` or `2`. The date of manufacture is HSDAT, not HERDT. Deletion, classification, and inspection lots are not stored. `MSC1N` and `MSC2N` are not this screen.

**Batch pick-up list** · `INV.BATCH.PICKUP` · `MB5C` · `/inventory/batch-pickup`

Do not open this list on this walk. It reads a batch that already stands and already appears on a material document. It does not create a batch and does not post. A sales order, a delivery, a billing document, and a scheduling agreement are refused. Those documents are not on the material document.

**48. Material period** · `CFG.INV.MATPERIOD.DEFINE` · `OMSY` / `MMPV` / `MMRV` · `/config/material-period-control`

Company `1000`, financial year `2026`, period `7`. That is October 2026. Do not close the period.

## 5. Controlling

The controlling-area screens are built. They are not in the command registry. Use the URL, or `OKKP` / `OX19` if the bar accepts them.

**49. Controlling area** · `CFG.COST.CONTROLLINGAREA.DEFINE` · `OKKP` · `/config/controlling-area`

Area `A000`, name `Meridian controlling`, currency `INR`, chart `CA01`.

**50. Assign company to controlling area** · `CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY` · `OX19` · `/config/controlling-area/assign-company-code`

Area `A000`, company `1000`.

**51. Cost centre hierarchy** · `CFG.COST.COSTCENTERHIER.DEFINE` · `KSH1` · `/config/cost-center-hierarchy`

Area `A000`, group `MERIDIAN`, name `Meridian`.

**52. Cost centres** · `CFG.COST.COSTCENTER.DEFINE` · `KS01` · `/config/cost-centers`

Area `A000`, company `1000`, valid from `2026-04-01`, valid to `9999-12-31`.

| Centre | Name | Category |
|---|---|---|
| `PROD` | Production | Production |
| `ADMIN` | Administration | Administration |

Put both under group `MERIDIAN` if the screen asks for a node.

**53. Profit centre hierarchy** · `CFG.COST.PROFITCENTERHIER.DEFINE` · `KCH1` · `/config/profit-center-hierarchy`

Area `A000`, group `MERIDIAN`, name `Meridian`.

**54. Profit centre** · `CFG.COST.PROFITCENTER.DEFINE` · `KE51` · `/config/profit-centers`

Centre `PC01`, name `Auto components`, area `A000`, company `1000`, valid from `2026-04-01`.

**55. Activity type** · `CFG.COST.ACTIVITYTYPE.DEFINE` · `KL01` · `/config/activity-types`

Type `LABR`, name `Labour hour`, unit `H`, area `A000`. If `H` is rejected, use the hour unit the list shows and write it down.

**56. Activity price** · `CFG.COST.ACTIVITYRATE.CONFIRM` · `KP26` · `/config/activity-rates`

Area `A000`, centre `PROD`, type `LABR`, year `2026`, period `7`, price `250.00` INR per hour.

**57. Return to account determination** · `OBYC` · `/config/account-determination`

Add the inventory, price-difference, consumption, scrap and offsetting rows from step 36.

Stop here if `RAW_INVENTORY` is not in the valuation-class list. There is no screen to create a valuation class. The four classes (`RAW_INVENTORY`, `SEMI_INVENTORY`, `FINISHED_INVENTORY`, `TRADE_INVENTORY`) are not created by the plant screen. Record the message. Do not post a goods receipt until the class exists. You can still complete every screen that does not need it.

## 6. Sales structure

These screens are implemented. There is no sales-order screen. Create the structure so the customer sales view has somewhere to go.

**58. Distribution channels** · `CFG.ORG.DISTCHANNEL.DEFINE` · `OVXI` · `/config/distribution-channels`

`01` Direct sales. `02` Distributors.

**59. Divisions** · `CFG.ORG.DIVISION.DEFINE` · `OVXB` · `/config/divisions`

`01` Manufactured goods. `02` Traded goods.

**60. Sales organisation** · `CFG.ORG.SALESORG.DEFINE` · `/config/sales-orgs`

Organisation `1000`, name `Meridian sales`, currency `INR`.

**61. Assign sales organisation to company** · `CFG.ORG.SALESORG.ASSIGN_COMPANY` · `OVX3` · `/config/sales-orgs/assign-company`

Organisation `1000`, company `1000`.

**62. Assign channel** · `CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL` · `OVXK` · `/config/sales-orgs/assign-distribution-channel`

Organisation `1000`, channel `01`.

**63. Assign division** · `CFG.ORG.SALESORG.ASSIGN_DIVISION` · `OVXA` · `/config/sales-orgs/assign-division`

Organisation `1000`, division `01`.

**64. Sales area** · `CFG.ORG.SALESAREA.DEFINE` · `OVXG` · `/config/sales-areas`

Organisation `1000`, channel `01`, division `01`.

## 7. Business partners

**65. Create vendors and customers** · `FND.PARTNER.CREATE` · `BP` · `/foundation/partners?new=1`

Category Organisation, country `IN`, not blocked. Repeat for each number.

| Number | Name | Role |
|---|---|---|
| `V10000` | Sharma Steel Traders | Supplier |
| `V20000` | Krishna Polymers Ltd | Supplier |
| `V30000` | Deccan Logistics | Supplier |
| `C10000` | Apex Motors Ltd | Customer |
| `C20000` | Nova Vehicles Pvt Ltd | Customer |

**66. Partner list** · `FND.PARTNER.DISPLAY` · `/foundation/partners`

Confirm five partners.

**67. Maintain a partner** · `FND.PARTNER.MAINTAIN` · `/foundation/partners`

Open `V10000`. Add a street in Pune if the general view has an address. Save with a reason.

**68. Bank country profile** · `/foundation/partners/bank-profiles`

Country `IN`. If the screen asks you to activate a profile, activate `IN` and write down the revision it shows. This route is built and is not in the command registry.

**69. Supplier company data** · `FIN.SUPPLIER.COMPANY.MAINTAIN` · `/foundation/partners?view=SUPPLIER_COMPANY`

For `V10000`, `V20000` and `V30000`: company `1000`, chart `CA01`, reconciliation `200000`, terms `NET30`, payment method `T`.

**70. Supplier purchasing data** · `PROC.SUPPLIER.PURCHASING.MAINTAIN` · `/foundation/partners?view=SUPPLIER_PURCHASING`

Same three vendors. Purchasing organisation `1000`, order currency `INR`.

**71. Supplier partner function** · `/foundation/partners` · partner-function panel on `V10000`

Purchasing organisation `1000`, function the ordering-address or supplier function the list offers, assigned partner `V10000`, default yes. If the panel is absent, record that and continue.

**72. Customer company data** · `FIN.CUSTOMER.COMPANY.MAINTAIN` · `/foundation/partners?view=CUSTOMER_COMPANY`

`C10000` and `C20000`. Company `1000`, reconciliation `110000`, terms `NET30`.

**73. Customer sales area** · `SALES.CUSTOMER.SALESAREA.MAINTAIN` · `VD02` · `/foundation/partners?view=CUSTOMER_SALES`

`C10000`. Sales organisation `1000`, channel `01`, division `01`, delivering plant `1000`.

**74. Customer credit** · `FIN.CREDIT.MAINTAIN` · `FD32` · `/finance/credit`

Customer `C10000`, credit control area `0001` if the list has it, otherwise the area the screen offers. Limit `500000` INR, currency `INR`. If it refuses because no credit area exists, record that. There may be no separate credit-area screen. Continue. The procure-to-pay path does not need it.

## 8. Materials

**75. Create materials** · `INV.MATERIAL.CREATE` · `MM01` · `/inventory/materials?new=1`

Basic view first, then purchasing, then accounting. Plant `1000` on the plant views. Reason `Opening master`.

| Material | Description | Type | Group | Sector | Unit |
|---|---|---|---|---|---|
| `MAT-10001` | Steel plate 5mm | `RAW` | `RAW` | `M` | `PC` |
| `MAT-10002` | Polymer resin pellets | `RAW` | `RAW` | `M` | `PC` |
| `MAT-20001` | Gear housing casting | `RAW` | `RAW` | `M` | `PC` |

Purchasing view, plant `1000`, group `001`, order unit `PC`, over-delivery `0`, under-delivery `0`.

Accounting view, plant `1000`, valuation class `RAW_INVENTORY`, price control moving average, price `0`, price unit `1`. If `RAW_INVENTORY` is not in the list, stop. That is the missing valuation-class screen. Do not type a class the list does not contain.

**76. Material list** · `INV.MATERIAL.DISPLAY` · `MM03` · `/inventory/materials`

Open `MAT-10001` and confirm all three views are complete.

**77. MRP view** · `PROD.MRP.SETTINGS` · `/inventory/materials?view=MRP`

`MAT-10001`, plant `1000`. MRP type `PD` or the planning type the list offers, controller `001` if it is in the list, procurement external, lot sizing lot-for-lot or the list's equivalent, planned delivery `14` days, safety stock `0`. If controller `001` is missing, leave the controller blank only if the screen allows it. Record a refusal.

**78. Unit conversion** · `INV.STOCK.UOM` · `CUNI` · `/inventory/uom-conversion`

Material `MAT-10001`. Alternative unit `KG`, 1 PC = 8 KG, if the screen asks for a numerator and denominator. This is a conversion for one material, not the global unit table. Units themselves are global seed data and have no tenant screen.

**79. Flag and unflag deletion** · `INV.MATERIAL.FLAGDELETION` · `MM06` · `/inventory/materials`

Flag `MAT-20001` at plant `1000`, reason `Test the flag`. Remove the flag before you order it. A flagged material must not be on a purchase order.

## 9. Purchasing masters, then three orders

**80. Info record** · `PROC.INFO.RECORD.MAINTAIN` · `ME11` · `/purchasing/info-record`

| Vendor | Material | Organisation | Plant | Net price | Unit | Per |
|---|---|---|---|---|---|---|
| `V10000` | `MAT-10001` | `1000` | `1000` | `1000` | `PC` | `1` |
| `V10000` | `MAT-10002` | `1000` | `1000` | `450` | `PC` | `1` |
| `V20000` | `MAT-20001` | `1000` | `1000` | `2200` | `PC` | `1` |
| `V30000` | `MAT-10001` | `1000` | `1000` | `980` | `PC` | `1` |

Currency `INR`.

**81. Source list** · `PROC.SOURCE.LIST.MAINTAIN` · `ME01` · `/purchasing/source-list`

Material `MAT-10001`, plant `1000`. Two lines, valid `2026-04-01` to `2027-03-31`.

| Vendor | Organisation | Fixed | Blocked |
|---|---|---|---|
| `V10000` | `1000` | yes | no |
| `V30000` | `1000` | no | no |

**82. Quota** · `PROC.QUOTA.MAINTAIN` · `MEQ1` · `/purchasing/quota-arrangement`

Material `MAT-10001`, plant `1000`, valid `2026-04-01` to `2027-03-31`. `V10000` quota `70`. `V30000` quota `30`.

**83. Characteristics** · `CFG.PROC.CHARACTERISTIC.DEFINE` · `CT04` · `/config/characteristics`

OCHA is not this screen. Characteristic `THICKNESS`, description `Plate thickness`, data type numeric, unit `MM` if offered, one decimal.

**84. Class** · `CFG.PROC.CLASS.DEFINE` · `CL01` · `/config/classes`

Class `PLATE`, class type the material type the list offers, characteristic `THICKNESS`.

**85. Release strategy** · `CFG.PROC.RELEASE.DEFINE` · `OMGSCK` · `/config/release-strategies`

A one-step strategy for purchase orders over `50000` INR, release code `R1`, group and strategy the screen requires. If the screen cannot be saved without the class from the previous step, use `PLATE`. If it still refuses, record it. The orders below are under or near that limit. A missing strategy must not block a purchase order unless the screen says the order is subject to release.

**86. Purchase requisition** · `PROC.PR.CREATE` · `ME51N` · `/purchasing/requisitions`

One requisition, two items. Document date `2026-10-06`.

| Item | Material | Text | Quantity | Unit | Price | Plant | Location | Delivery |
|---|---|---|---|---|---|---|---|---|
| 10 | `MAT-10001` | Steel plate 5mm | `10` | `PC` | `1000` | `1000` | `0001` | `2026-10-20` |
| 20 | `MAT-10002` | Polymer resin pellets | `20` | `PC` | `450` | `1000` | `0001` | `2026-10-21` |

Write down the requisition number.

**87. Requisition list** · `PROC.REQ.LIST` · `ME5A` · `/purchasing/requisition-list`

Plant `1000`. Both items should be listed.

**88. Request for quotation** · `PROC.RFQ.CREATE` · `ME41` · `/purchasing/rfq`

Vendor `V30000`, organisation `1000`, group `001`, date `2026-10-06`, deadline `2026-10-18`. One item: `MAT-10001`, quantity `10` PC, plant `1000`. Write down the RFQ number.

**89. Quotation** · `PROC.RFQ.QUOTATION` · `ME47` · `/purchasing/quotation`

The RFQ from step 88. Vendor `V30000`, price `980` INR per PC, valid to `2027-03-31`.

**90. Display quotation** · `PROC.RFQ.QUOTATION.DISPLAY` · `ME48` · `/purchasing/quotation-display`

Same RFQ. Confirm `980`.

**91. Compare quotations** · `PROC.RFQ.COMPARISON` · `ME49` · `/purchasing/quotation-comparison`

Material `MAT-10001` or the RFQ number. You may only have one quotation. Confirm it lists `V30000` at `980`. The order will still go to `V10000` for the first buy, and to `V30000` for the third order.

**92. Purchase order, two items** · `PROC.PO.CREATE` · `ME21N` · `/purchasing/orders`

Vendor `V10000`, organisation `1000`, group `001`, company `1000`, currency `INR`, date `2026-10-08`. Storage location `0001` on every line. Do not leave the location blank. Leave Batch empty. This walk does not use batches, and a batch is stored only when that batch already stands.

| Item | Material | Quantity | Unit | Net price | Per | Plant | Delivery |
|---|---|---|---|---|---|---|---|
| 10 | `MAT-10001` | `10` | `PC` | `1000` | `1` | `1000` | `2026-10-20` |
| 20 | `MAT-10002` | `20` | `PC` | `450` | `1` | `1000` | `2026-10-21` |

Write this number down as **PO-A**. Net value is `19000` INR.

**93. Purchase order, one item** · `ME21N` again

Vendor `V20000`, same organisation, group, company and currency, date `2026-10-10`.

| Item | Material | Quantity | Price | Plant | Location | Delivery |
|---|---|---|---|---|---|---|
| 10 | `MAT-20001` | `8` | `2200` | `1000` | `0001` | `2026-10-22` |

Write this number down as **PO-B**. Net value `17600` INR.

**94. Purchase order to the second source** · `ME21N` again

Vendor `V30000`, date `2026-10-12`.

| Item | Material | Quantity | Price | Plant | Location | Delivery |
|---|---|---|---|---|---|---|
| 10 | `MAT-10001` | `5` | `980` | `1000` | `0001` | `2026-10-22` |

Write this number down as **PO-C**. Net value `4900` INR. This one stays unpaid.

**95. Display a purchase order** · `PROC.PO.DISPLAY` · `ME23N` · `/purchasing/purchase-order-display`

Open **PO-A**. Confirm two items and location `0001`. Batch is shown when the item stores one. This order has none, so Batch stays empty.

**96. Purchase order list** · `PROC.PO.LIST` · `ME2L` · `/purchasing/purchase-order-list`

Vendor from `V10000` to `V30000`, organisation `1000`. Three orders.

**97. Orders by account assignment** · `PROC.PO.ACCOUNTASSIGN` · `ME2K` · `/purchasing/orders-by-account-assignment`

Organisation `1000`, plant `1000`. These orders have no cost-centre assignment. An empty result is correct. Record it.

**98. Vendor evaluation** · `PROC.VENDOR.EVALUATE` · `ME61` · `/purchasing/vendor-evaluation`

Vendor `V10000`, organisation `1000`. Enter the scores the screen asks for. Overall is calculated. Save.

## 10. Receive and invoice

Use location `0001` on every receipt line. A blank location is accepted by the posting service and hides the stock from the real locations.

**99. Goods receipt for PO-A** · `INV.GR.POST` · `/inventory/goods-receipt`

Order **PO-A**. Document date and posting date `2026-10-20`. Item 10 quantity `10`. Item 20 quantity `20`. Location `0001` on both. Leave Batch empty. These materials are not batch-managed. A blank Batch posts the batch stored on the order when one already stands, and it does not create a batch. Write down the material document and the journal number.

**100. Goods receipt for PO-B** · same screen

Order **PO-B**, date `2026-10-22`, item 10 quantity `8`, location `0001`.

**101. Goods receipt for PO-C** · same screen

Order **PO-C**, date `2026-10-22`, item 10 quantity `5`, location `0001`.

**102. MIGO** · `INV.MIGO.POST` · `MIGO` · `/inventory/migo`

Display the first material document. Do not post a second receipt for the same order quantity. If MIGO is a posting screen rather than a display, leave it without posting and record what movements it offers.

**103. Material document** · `INV.DISPLAY` · `MB03` · `/inventory/material-documents`

The PO-A document. Two lines, location `0001`. Batch is shown when the line stores one. This walk's receipts have none, so Batch stays empty.

**104. Material document list** · `INV.MATERIALDOC.LIST` · `MB51` · `/inventory/material-document-list`

Plant `1000`, posting date `2026-10-01` to `2026-10-23`, material `MAT-10001`. Quantities `10` and `5`. Leave Batch empty. These receipts have none, so Batch stays empty. A sales order, a delivery, and a billing document are not selected.

**105. Output** · `INV.MATERIALDOC.RECEIVEPRINT` · `MB90` · `/inventory/material-document-output`

The PO-A document. If it only queues a message, that is enough.

**106. Stock overview** · `INV.STOCK.VIEW` · `MMBE` · `/inventory/stock-overview`

| Material | Location `0001` |
|---|---|
| `MAT-10001` | `15` |
| `MAT-10002` | `20` |
| `MAT-20001` | `8` |

If the quantity is under a blank location, the receipt did not keep `0001`. Record that. Do not continue the count until you know which location holds the stock. Leave Batch empty. These materials are not batch-managed. A named batch is read back and does not create a batch.

**107. Warehouse stock** · `INV.STOCK.WAREHOUSE` · `MB52` · `/inventory/warehouse-stocks`

Plant `1000`. Same three quantities. Leave Batch empty. These materials are not batch-managed. A named batch is read back and does not create a batch.

**108. Stock on a posting date** · `INV.STOCK.POSTINGDATE` · `MB5B` · `/inventory/stock-posting-date`

Plant `1000`, date `2026-10-20`. `MAT-10001` should be `10` and `MAT-10002` `20`. `MAT-20001` should be zero on that date. Leave Batch empty. These materials are not batch-managed. A named batch is read back and does not create a batch.

**109. Invoice verification, PO-A** · `PROC.INV.RECORD` · `MIRO` · `/purchasing/invoice-verification`

Order **PO-A**. Supplier reference `INV-PO-A`. Invoice date and posting date `2026-10-22`. Gross `19000`. Item 10 quantity `10`, amount `10000`. Item 20 quantity `20`, amount `9000`. No tax on this one, so the gross equals the net. Write down the invoice and journal numbers.

**110. Invoice verification, PO-B** · same screen

Order **PO-B**. Reference `INV-PO-B`. Date `2026-10-23`. Gross `17600`. Item 10 quantity `8`, amount `17600`.

**111. Invoice verification, PO-C** · same screen

Order **PO-C**. Reference `INV-PO-C`. Date `2026-10-23`. Gross `4900`. Item 10 quantity `5`, amount `4900`.

**112. Park an invoice** · `PROC.INV.PARK` · `MIR7` · `/purchasing/parked-invoice`

Do not park against a fully invoiced order. If the screen requires an order, use **PO-A** item 10 for quantity `1` and amount `1000`, reference `PARK-1`, and do not post it. If it refuses because the order is fully invoiced, record that and continue.

**113. Invoice overview** · `PROC.INV.OVERVIEW` · `MIR6` · `/purchasing/invoice-overview`

Company `1000`, vendor `V10000`. `INV-PO-A` should be listed.

**114. Block an invoice** · `PROC.INV.BLOCK` · `/purchasing/blocked-invoice`

Block the PO-C invoice. Reason `Price check`. 

**115. Release the block** · `PROC.INV.BLOCK.RELEASE` · `MRBR` · same URL

Release that block so the payment run can see it. You will still not pay PO-C.

**116. GR/IR maintenance** · `PROC.GRIR.MAINTAIN` · `MR11` · `/purchasing/grir-clearing`

Company `1000`. The three orders were received and invoiced in full, so the account should be clear. An empty proposal is correct. Do not post a maintenance document. The post and reverse actions are on this same screen (`PROC.GRIR.MAINTAIN.POST`, `PROC.GRIR.MAINTAIN.REVERSE`). Leave them unused if there is no residual.

## 11. Pay two vendors, leave one open

**117. Vendor balances** · `FIN.AP.BALANCE` · `FK10N` · `/finance/vendor-balances`

Company `1000`, year `2026`. `V10000` open `19000`, `V20000` open `17600`, `V30000` open `4900`, before the payment run.

**118. Vendor ageing** · `FIN.AP.AGEING` · `S_ALR_87012085` · `/finance/vendor-ageing`

Company `1000`, key date `2026-10-23`. All three invoices are not yet due if terms are 30 days. They should sit in the not-due column.

**119. Payment run** · `FIN.AP.PAYMENTRUN.EXECUTE` · `F110` · `/finance/payment-run`

| Field | Enter |
|---|---|
| Run date | `2026-10-23` |
| Identification | `WT01` |
| Posting date | `2026-10-23` |
| Documents entered up to | `2026-10-23` |
| Next payment date | `2026-10-30` |
| Company | `1000` |
| Paying company | `1000` |
| Method | `T` |
| Vendor from | `V10000` |
| Vendor to | `V20000` |

Do not include `V30000`. Propose, then execute with house bank `HB01` and account `MAIN`. The proposal should contain two items, `19000` and `17600`. Write down the payment document numbers.

**120. Outgoing payment, single** · `FIN.AP.PAYMENT.POST` · `F-53` · `/finance/outgoing-payment`

Do not pay `V30000` here either, or the later open-item reports change. Open the screen, enter vendor `V30000`, company `1000`, amount `4900`, bank `101000`, date `2026-10-23`, and cancel without posting. If you post it by mistake, the open vendor item is gone and the ageing step will not show `4900`.

**121. Vendor line items after payment** · `FK10N` again

`V10000` and `V20000` clear. `V30000` remains `4900`.

## 12. Inventory movements

**122. Transfer** · `INV.TRANSFER.POST` · `MB1B` · `/inventory/transfer-posting`

Movement `311` if asked. Material `MAT-10001`, plant `1000`, from `0001` to `0002`, quantity `1`, date `2026-10-23`. Leave Batch empty. These materials are not batch-managed. A named batch moves with the transfer and does not create a batch. Stock in `0001` becomes `14`. Stock in `0002` becomes `1`.

**123. Goods issue** · `INV.GI.POST` · `MB1A` · `/inventory/goods-issue`

Material `MAT-10002`, plant `1000`, location `0001`, quantity `2`, date `2026-10-23`, cost centre `PROD`. Movement `201` if asked. Write down the material document.

**124. Reservation** · `INV.RESERVATION.CREATE` · `MB21` · `/inventory/reservations`

Material `MAT-20001`, plant `1000`, location `0001`, quantity `1`, requirement date `2026-10-28`, cost centre `PROD`. Write down the reservation number.

**125. Return to vendor** · `INV.RETURN.POST` · `MBRL` · `/inventory/return-delivery`

The PO-C receipt. Material `MAT-10001`, quantity `1`, location `0001`, date `2026-10-23`. The batch is the receipt line's batch and is not typed. This walk's materials are not batch-managed, so Batch stays empty. PO-C stock becomes `4` in `0001`, plus the `1` already transferred to `0002` from the other receipt. Write down the return document.

**126. Reverse the goods issue** · `INV.REVERSE` · `MBST` · `/inventory/reversal`

Reverse the document from step 123, date `2026-10-23`. `MAT-10002` in `0001` returns to `20`. Do not reverse the receipts. The batch is the document line's batch and is not typed. This walk's materials are not batch-managed, so Batch stays empty.

**127. Physical inventory document** · `INV.PHYINV.CREATE` · `MI01` · `/inventory/physical-inventory`

Plant `1000`, location `0001`, date `2026-10-23`. Materials `MAT-10001`, `MAT-10002`, `MAT-20001`. Leave Batch empty. These materials are not batch-managed. A batch is stored only when that batch already stands. Write down the count document.

**128. Enter the count** · `INV.PHYINV.COUNT` · `MI04` · `/inventory/physical-inventory-count`

Counted quantities: `MAT-10001` `13`, `MAT-10002` `20`, `MAT-20001` `8`. The book for `MAT-10001` in `0001` should be `14` after the transfer and the return of one from PO-C's five. A difference of `1` is intentional.

**129. Difference list** · `INV.PHYINV.DIFF.LIST` · `MI20` · `/inventory/physical-inventory-differences`

The count document. One difference on `MAT-10001`.

**130. Recount** · `INV.PHYINV.RECOUNT` · `MI11` · `/inventory/physical-inventory-recount`

Recount `MAT-10001` only. Counted quantity `13` again.

**131. Post the difference** · `INV.PHYINV.DIFF.POST` · `MI07` · `/inventory/physical-inventory-posting`

Post the recount. The difference should hit account `440000`. Write down the journal number.

**132. Stock reconciliation** · `INV.STOCK.RECONCILE` · `MB5L` · `/inventory/stock-reconcile`

Company `1000`, plant `1000`. Inventory account `120000` should equal the stock value. The value is `14` times `1000` for steel still in `0001` and `0002`, plus `4` times `980` for the PO-C steel remaining, plus `20` times `450`, plus `8` times `2200`, minus the counted difference of one steel piece at its moving-average price. Record the figure the report shows and any difference. Do not force it to match by posting a journal.

## 13. Finance documents

**133. Opening journal** · `FIN.JOURNAL.POST` · `FB50` · `/finance/journal/new`

Company `1000`, type `SA`, dates `2026-04-01`, currency `INR`, text `Opening balances FY2026`.

| Account | Debit / credit | Amount |
|---|---|---|
| `101000` | Debit | `2500000` |
| `280000` | Credit | `2500000` |

Do not debit `120000` here. A journal does not create stock, and the stock account would no longer match the warehouse.

**134. Rent journal** · `FB50` again

Dates `2026-10-23`, type `SA`, text `October rent`.

| Account | Debit / credit | Amount | Cost centre |
|---|---|---|---|
| `510000` | Debit | `150000` | `ADMIN` |
| `101000` | Credit | `150000` | |

**135. Park a journal** · `FIN.JOURNAL.PARK` · `FV50` · `/finance/journal/park`

Company `1000`, type `SA`, dates `2026-10-23`, currency `INR`, text `Parked accrual`. Debit `500000` `10000` with cost centre `ADMIN`. Credit `230000` `10000`. Save as parked. Do not post it. Write down the parked number.

**136. Display the opening document** · `FIN.JOURNAL.DISPLAY` · `FB03` · `/finance/journal`

Company `1000`, year `2026`, the opening document number.

**137. Document flow** · `FIN.DOC.FLOW` · `FB03` · `/finance/journal/document`

Same document. Confirm the two lines.

**138. G/L line items** · `FIN.JOURNAL.LIST` · `FAGLL03` · `/finance/journal/items`

Company `1000`, year `2026`, account `101000`.

**139. G/L balances** · `FIN.GL.BALANCE` · `FS10N` · `/finance/journal/balances`

Account `101000`, company `1000`, year `2026`.

**140. Customer invoice** · `FIN.AR.INVOICE.POST` · `FB70` · `/finance/customer-invoice`

Customer `C10000`, company `1000`, dates `2026-10-14`, reference `SO-1001`, currency `INR`, terms `NET30`. Revenue `300000` amount `100000`, tax code `G18` if the line accepts it. Gross `118000` if tax is calculated, otherwise gross `100000` and no tax code. Write down which one posted, and the document number. This is a finance invoice. There is no sales-order screen.

**141. Second customer invoice** · `FB70` again

Customer `C20000`, dates `2026-10-20`, reference `SO-1002`, revenue `300000` amount `50000`, tax `G18`, gross `59000` or `50000` without tax. Leave this one open.

**142. Incoming payment** · `FIN.AR.PAYMENT.ENTER` · `F-28` · `/finance/incoming-payment`

Customer `C10000`, company `1000`, dates `2026-10-23`, bank account `101000`, currency `INR`, amount equal to the invoice you posted (`118000` or `100000`). Select that invoice only. Clear it.

**143. Customer balances** · `FIN.AR.BALANCE` · `FD10N` · `/finance/customer-balances`

Company `1000`, year `2026`. `C10000` clear. `C20000` open.

**144. Customer ageing** · `FIN.AR.AGEING` · `S_ALR_87012178` · `/finance/customer-ageing`

Company `1000`, key date `2026-10-23`. `C20000` not yet due.

**145. Customer down-payment request** · `FIN.AR.DOWNPAYMENT.REQUEST` · `F-37` · `/finance/customer-down-payment-request`

Customer `C20000`, company `1000`, special G/L the letter from step 34, amount `10000`, dates `2026-10-23`, tax none. Write down the document.

**146. Customer down payment** · `FIN.AR.DOWNPAYMENT.POST` · `F-29` · `/finance/customer-down-payment`

Same customer, amount `10000`, bank `101000`, special G/L the same letter, date `2026-10-23`. Clear the request if the screen offers it.

**147. Clear the customer down payment** · `FIN.AR.DOWNPAYMENT.CLEAR` · `F-39` · `/finance/customer-down-payment-clearing`

Customer `C20000`, company `1000`, date `2026-10-23`. Clear the down payment against the open invoice if the amounts allow a partial clear. If it refuses a partial clear, record the message and leave both open.

**148. Vendor down-payment request** · `FIN.AP.DOWNPAYMENT.REQUEST` · `F-47` · `/finance/vendor-down-payment-request`

Vendor `V30000`, company `1000`, amount `1000`, special G/L the vendor letter, date `2026-10-23`.

**149. Vendor down payment** · `FIN.AP.DOWNPAYMENT.POST` · `F-48` · `/finance/vendor-down-payment`

Vendor `V30000`, amount `1000`, bank `101000`, same special G/L, date `2026-10-23`.

**150. Clear the vendor down payment** · `FIN.AP.DOWNPAYMENT.CLEAR` · `F-54` · `/finance/vendor-down-payment-clearing`

Vendor `V30000`. Clear `1000` against the open invoice of `4900` if partial clearing is allowed. The remainder should stay open.

**151. Vendor invoice, no order** · `FIN.AP.INVOICE.POST` · `FB60` · `/finance/vendor-invoice`

Vendor `V30000`, company `1000`, dates `2026-10-23`, reference `RENT-STORE`, currency `INR`, terms `NET30`. Expense `510000` amount `25000`, cost centre `ADMIN`. This is a second open item, not the PO-C invoice.

**152. Vendor credit memo** · `FIN.AP.CREDITMEMO.POST` · `FB65` · `/finance/vendor-credit-memo`

Vendor `V30000`, dates `2026-10-23`, reference `RENT-STORE-CM`, account `510000`, amount `5000`, cost centre `ADMIN`.

**153. Clear vendor items** · `FIN.AP.CLEAR` · `F-44` · `/finance/vendor-clearing`

Vendor `V30000`, company `1000`, date `2026-10-23`. Clear the `25000` invoice against the `5000` credit memo only if the screen can leave a residual. If it requires a full clear, do not force it. Record the message. The PO-C item of `4900` should remain.

**154. Clear customer items** · `FIN.AR.CLEAR` · `F-32` · `/finance/customer-clearing`

Open the screen for `C20000`. If the only open item is the invoice, there is nothing to clear against. Record that and do not invent a second posting.

**155. G/L clearing** · `FIN.GL.CLEAR` · `F-03` · `/finance/gl-clearing`

Account `201000` was not created. Use `230000` only if it has both a debit and a credit. If it has only the parked item, which is not posted, the screen should show nothing. Record that.

**156. Reverse a finance document** · `FIN.DOCUMENT.REVERSE` · `FB08` · `/finance/document-reversal`

Reverse the rent journal from step 134, reason `04` duplicate, date `2026-10-23`. Then post the rent journal again with the same amounts so the profit and loss still contains October rent. Write down both document numbers.

**157. Reset cleared items** · `FIN.CLEARING.RESET` · `FBRA` · `/finance/clearing-reset`

Reset the clearing of the `C10000` incoming payment only if you can clear it again afterwards. If you reset it, return to `F-28` and clear the same invoice again. If you would rather keep the clear, open the screen, select nothing, and record that reset is available.

**158. Accrual** · `FIN.ACCRUAL.POST` · `FBS1` · `/finance/accruals`

Company `1000`, dates `2026-10-23`, reversal date `2026-11-01` if asked. Debit `510000` `20000` cost centre `ADMIN`. Credit `230000` `20000`. Text `October accrual`.

**159. Intercompany journal** · `FIN.IC.POST` · `FB01` · `/finance/intercompany`

One company cannot post intercompany. Open the screen. If it refuses, record the message. Do not create a second company to force it.

**160. Credit monitor** · `FIN.CREDIT.MONITOR` · `F.31` · `/finance/credit-monitor`

Customer `C10000` or company `1000`. 

**161. Credit release** · `FIN.CREDIT.RELEASE` · `VKM3` · `/finance/credit-release`

There is no sales order to block. An empty list is correct.

**162. Dunning** · `FIN.AR.DUNNING.RUN` · `F150` · `/finance/dunning`

Company `1000`, run date `2026-10-23`, customer `C20000`. The invoice is not overdue. A proposal with no dunning letter is correct. Do not print a letter if the screen would still produce one for a not-due item. Record that.

**163. Asset** · `FIN.ASSET.CREATE` · `AS01` · `/finance/assets/new`

Company `1000`, asset class the list offers for machinery, description `Press line 1`, cost centre `PROD`, plant `1000`. Write down the asset number.

**164. Change asset** · `FIN.ASSET.CHANGE` · `AS02` · `/finance/assets`

This route is `/finance/assets/change` as well. The command list points at `/finance/assets`. Open the asset. Change the description to `Press line 1 — Pune`. Reason `Name correction`.

**165. Acquire asset** · `FIN.ASSET.ACQUIRE` · `ABZON` · `/finance/assets/acquire`

Asset from step 163, date `2026-10-23`, amount `500000`, offset account `101000`, currency `INR`.

**166. Depreciation** · `FIN.ASSET.DEPRECIATE` · `AFAB` · `/finance/assets/depreciate`

Company `1000`, year `2026`, period `7`. If it refuses because no depreciation key was captured on the asset, record the message. Do not invent a key the screen does not offer.

**167. Retire asset** · `FIN.ASSET.RETIRE` · `ABAVN` · `/finance/assets/retire`

Do this only if depreciation posted or the screen allows scrap without it. Otherwise open the screen, do not post, and record the refusal. Scrapping the only asset removes it from the history report.

**168. Asset history** · `FIN.ASSET.REPORT` · `S_ALR_87011990` · `/finance/assets/history`

Company `1000`, year `2026`.

## 14. Reports

Use company `1000`, financial year `2026`, periods `1` to `7`, currency `INR`, unless the screen asks for a date. Key date `2026-10-23`.

**169. Trial balance** · `FIN.RPT.TRIALBALANCE` · `F.01` · `/finance/trial-balance`

Debits must equal credits.

**170. Balance sheet** · `FIN.RPT.BALANCESHEET` · `S_ALR_87012284` · `/finance/balance-sheet`

**171. Profit and loss** · `FIN.RPT.PROFITLOSS` · `S_PL0_86000028` · `/finance/profit-loss`

Rent and revenue should appear. The reversed rent journal must not be double-counted if you re-posted it once.

**172. Cash flow** · `FIN.RPT.CASHFLOW` · `S_ALR_87012271` · `/finance/cash-flow`

Company `1000`, year `2026`, periods `1` to `7`, method indirect, ledger `0L` if asked. The reconciliation difference should be zero. The opening cash of the statement is zero because the opening journal is inside period 1, not before the year. That is expected.

**173. Subledger tie-out** · `FIN.RPT.SUBLEDGER.TIE` · `FAGLB03` · `/finance/subledger-tie-out`

Receivables `110000` must equal the open customer items. Payables `200000` must equal the open vendor items.

**174. GR/IR analysis** · `FIN.GRIR.RECLASS` · `F.19` · `/finance/grir-reclass`

Company `1000`, key date `2026-10-23`. Account `210000` should be zero. Do not post a reclass if the proposal is empty.

**175. Tax report** · `FIN.TAX.REPORT` · `S_ALR_87012357` · `/finance/tax/report`

Company `1000`, country `IN`, periods of October 2026. Output tax should show if the customer invoice took `G18`.

**176. Foreign currency valuation** · `FIN.FX.VALUATE` · `FAGL_FC_VAL` · `/finance/fx/valuation`

Company `1000`, key date `2026-10-23`, valuation currency `INR`. There is no open foreign-currency item. An empty proposal is correct. Do not post a valuation document.

**177. Cost centre report** · `FIN.RPT.COSTCENTER.ACTUAL` · `KSB1N` · `/controlling/cost-center-report`

Area `A000`, centre `ADMIN`, year `2026`, period `7`. Rent should be there.

**178. Profit centre report** · `FIN.RPT.PROFITCENTER` · `KE5Z` · `/controlling/profit-center-report`

Area `A000`, centre `PC01`, year `2026`. It may be empty if no line carried a profit centre. Record that. Do not post another journal just to fill it unless you want to: a debit to `510000` and a credit to `101000` cannot take a profit centre if the screen only accepts a cost centre.

**179. Consolidation workbench** · `FIN.RPT.CONSOLIDATE` · `UCWB` · `/config/consolidation`

One company. Open it. If it requires a group and a second company, record the message. Do not create a second company.

**180. Consolidation monitor** · `FIN.CONSOLIDATE` · `CX20` · `/finance/consolidation-monitor`

Same. Empty or refused is acceptable.

**181. Consolidated statements** · `FIN.RPT.CONSOLIDATE.STMT` · `/finance/consolidated-statements`

Open with company `1000` and year `2026`.

**182. Carryforward** · `FIN.CLOSE.CARRYFORWARD` · `F.16` · `/finance/carryforward`

Do not carry 2026 forward. The year is not finished. Open the screen, select company `1000`, from year `2026`, and leave without posting. Record any message that says the year is still open.

**183. Close cockpit** · `FIN.CLOSE.COCKPIT` · `CLOCO` · `/finance/close-cockpit`

Company `1000`, year `2026`, period `7`. Open the task list. Do not close the period.

**184. Lock monitor** · `PLT.LOCK.DISPLAY` · `SM12` · `/platform/locks`

Open a purchase order in change in one browser tab. In a second tab, open the same order. The second tab must be able to see it and must not be able to change it. A different order in the second tab must still be editable. Then release the first order. Deleting a lock, if you try it, must not change the document. Reason `Walkthrough check`.

## 15. Production

There is no bill of material screen and no sales-order screen. These four screens are still implemented. Open each. Record a refusal. Do not treat a refusal as a reason to invent a screen.

**185. Stock requirements** · `PROD.MRP.STOCKREQ` · `MD04` · `/production/stock-requirements`

Material `MAT-10001`, plant `1000`. You should see stock and the reservation. A demand from a sales order will not be there.

**186. MRP** · `PROD.MRP.RUN` · `MD01` · `/production/mrp-run`

Plant `1000`. If it refuses because sales demand or planning data is missing, record the message and stop the run. Do not post a planned order by hand.

**Production scheduling profile** · `CFG.PROD.SCHEDPROFILE.DEFINE` · `OPKP` · `/config/scheduling-profiles`

Do not create a profile on this walk. Opening the screen does not select a plant and does not create a profile. The key is stored as typed, at most six characters. Release at creation is the character X or blank. Batch creation in the order is blank, 1, or 2. This screen does not print, schedule, check capacity, or post a goods receipt. CO01 is not this screen. A closed period does not block it.

**187. Production order** · `PROD.ORDER.CREATE` · `CO01` · `/production/orders`

Material `MAT-20001` is raw, not finished. Try finished type only if you created a finished material. If you did not, enter material `MAT-20001`, plant `1000`, quantity `1`, date `2026-10-23`. Leave Batch empty. Expect a refusal because it is not a produced material or because no bill of material exists. Record it. A batch is stored only when that batch already stands.

## What you should have at the end

- Tenant `1000`, company `1000`, INR, April–March, periods open.
- Three vendors, two customers, three materials.
- One requisition, one RFQ with a quotation, three purchase orders. The first order has two items.
- Three receipts in location `0001`, three invoices.
- Payment run `WT01` cleared Sharma Steel and Krishna Polymers. Deccan Logistics remains open.
- One customer invoice cleared, one left open.
- Trial balance equal on both sides. Warehouse stock agrees with account `120000`, or you have written down the difference.

## Known gaps, not steps

- Valuation class has no screen. `RAW_INVENTORY` is not created when you save a plant. If it is missing at step 57, goods receipt cannot post.
- Copy tenant is offered and refused.
- Country and currency on the tenant screen are not checked against the reference list. `IN` and `INR` are valid. A typo would still be stored.
- Units of measure and currencies are global seed data. There is no tenant screen to create `PC` or `INR`.
- There is no sales-order screen and no bill-of-material screen.
- Purchasing group has no alias. Controlling area is not in the command registry. Use the URLs in those steps.
