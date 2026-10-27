# Implemented functions and transaction codes

Source: the capability registry `CAPABILITIES` and the screen registry `REGISTRY` in `scripts/seed.ts`, plus the
built screens whose code is in one of those and not the other. The product code is the function. The alias is the
search code only. A section heading's count is the number of rows under it — every section here agrees with its own
table, and a row is kept while the route it names resolves to a page under `src/app`.

## Platform (7)

| Function | Alias | Type | Route |
|---|---|---|---|
| `CFG.PLT.CLIENT.DEFINE` Tenant administration | — | Config | `/clients` |
| `CFG.PLT.CLIENT.ONBOARD` Tenant onboarding wizard | — | Config | `/clients/new` |
| `PLT.LOCK.DISPLAY` Lock monitor | SM12 | Transaction | `/platform/locks` |
| `CFG.WORKBENCH` Configuration workbench | SPRO, IMG | Config | `/config` |
| `CFG.PLT.NUMBERRANGE.DEFINE` Number range maintenance | SNRO | Config | `/config/number-range-objects` |
| `PLT.REGISTRY.SEARCH` Term registry search | — | CONCEPT | `/registry` |
| `CFG.PLT.NUMBERRANGE.DEFINE` Number range intervals | SNRO (intervals) | Config | `/config/number-ranges` |

## Foundation (7)

| Function | Alias | Type | Route |
|---|---|---|---|
| `FND.PARTNER.CREATE` Create business partner | BP, XK01, XD01 | Transaction | `/foundation/partners?new=1` |
| `FND.PARTNER.DISPLAY` Business partner list | — | Transaction | `/foundation/partners` |
| `FND.PARTNER.MAINTAIN` Maintain general business partners | — | Transaction | `/foundation/partners` |
| `CFG.ORG.COMPANYCODE.DEFINE` Company code define | OX02 | Config | `/config/company-codes` |
| `CFG.ORG.COMPANYCODE.ASSIGN_COA` Assign chart of accounts to company code | — | Config | `/config/company-codes/assign-chart-of-accounts` |
| `CFG.ORG.PLANT.DEFINE` Plant definition | OX10 | Config | `/config/plants` |
| `CFG.ORG.STORAGELOC.DEFINE` Storage Location definitions | OX09 | Config | `/config/storage-locations` |

## Organisation (1)

| Function | Alias | Type | Route |
|---|---|---|---|
| `CFG.ORG.INDUSTRY.DEFINE` Maintain Industries | OB44 | Config | `/config/industries` |

## Finance (FI) (77)

| Function | Alias | Type | Route |
|---|---|---|---|
| `FIN.CUSTOMER.COMPANY.MAINTAIN` Customer company accounting | — | Transaction | `/foundation/partners?view=CUSTOMER_COMPANY` |
| `FIN.AR.PAYMENT.ENTER` Post incoming payment | F-28 | Transaction | `/finance/incoming-payment` |
| `FIN.AR.DOWNPAYMENT.POST` Post customer down payment | F-29 | Transaction | `/finance/customer-down-payment` |
| `FIN.AP.DOWNPAYMENT.POST` Post vendor down payment | F-48 | Transaction | `/finance/vendor-down-payment` |
| `FIN.AP.DOWNPAYMENT.CLEAR` Clear vendor down payment | F-54 | Transaction | `/finance/vendor-down-payment-clearing` |
| `FIN.AR.DOWNPAYMENT.CLEAR` Clear customer down payment | F-39 | Transaction | `/finance/customer-down-payment-clearing` |
| `FIN.AR.DOWNPAYMENT.REQUEST` Post customer down payment request | F-37 | Transaction | `/finance/customer-down-payment-request` |
| `FIN.AP.DOWNPAYMENT.REQUEST` Post vendor down payment request | F-47 | Transaction | `/finance/vendor-down-payment-request` |
| `CFG.FIN.SPECIALGL.DEFINE` Define special G/L indicators | OBXR, OBYR | Config | `/config/special-gl` |
| `FIN.AP.PAYMENT.POST` Post outgoing payment | F-53 | Transaction | `/finance/outgoing-payment` |
| `FIN.AR.BALANCE` Customer balances | FD10N | Transaction | `/finance/customer-balances` |
| `FIN.AR.AGEING` Customer ageing | S_ALR_87012178 | Transaction | `/finance/customer-ageing` |
| `FIN.DOCUMENT.REVERSE` Reverse accounting document | FB08 | Transaction | `/finance/document-reversal` |
| `FIN.CLEARING.RESET` Reset cleared items | FBRA | Transaction | `/finance/clearing-reset` |
| `FIN.AR.INVOICE.POST` Enter customer invoice | FB70 | Transaction | `/finance/customer-invoice` |
| `FIN.AP.AGEING` Vendor ageing | S_ALR_87012085 | Transaction | `/finance/vendor-ageing` |
| `FIN.AP.BALANCE` Vendor balances | FK10N | Transaction | `/finance/vendor-balances` |
| `FIN.AP.CLEAR` Clear vendor open items | F-44 | Transaction | `/finance/vendor-clearing` |
| `FIN.AP.INVOICE.POST` Enter vendor invoice | FB60 | Transaction | `/finance/vendor-invoice` |
| `FIN.AP.CREDITMEMO.POST` Enter vendor credit memo | FB65 | Transaction | `/finance/vendor-credit-memo` |
| `FIN.AR.CLEAR` Clear customer open items | F-32 | Transaction | `/finance/customer-clearing` |
| `FIN.GL.CLEAR` Clear G/L account | F-03 | Transaction | `/finance/gl-clearing` |
| `FIN.RPT.CONSOLIDATE` Consolidation workbench | UCWB | Transaction | `/config/consolidation` |
| `FIN.CONSOLIDATE` Consolidation monitor | CX20, UCMON | Transaction | `/finance/consolidation-monitor` |
| `FIN.RPT.CONSOLIDATE.STMT` Consolidated statements | — | Transaction | `/finance/consolidated-statements` |
| `FIN.RPT.CASHFLOW` Cash flow statement | S_ALR_87012271, S_ALR_87012272, S_ALR_87012273 | Transaction | `/finance/cash-flow` |
| `FIN.AR.DUNNING.RUN` Dunning programme | F150 | Transaction | `/finance/dunning` |
| `FIN.AP.PAYMENTRUN.EXECUTE` Payment run | F110 | Transaction | `/finance/payment-run` |
| `FIN.SUPPLIER.COMPANY.MAINTAIN` Supplier company accounting | — | Transaction | `/foundation/partners?view=SUPPLIER_COMPANY` |
| `CFG.FIN.PAYTERMS.DEFINE` Payment terms | OBB8 | Config | `/config/payment-terms` |
| `CFG.FIN.PAYMENTMETHOD.DEFINE` Payment method definitions | — | Config | `/config/payment-methods` |
| `CFG.FIN.COA.DEFINE` Chart of Accounts definition | OB13 | Config | `/config/chart-of-accounts` |
| `CFG.FIN.COA.COPY` Copy Chart of Accounts | OBY7 | Config | `/config/chart-of-accounts/copy` |
| `CFG.FIN.FYV.DEFINE` Fiscal year variant definition | OB29 | Config | `/config/fiscal-year-variants` |
| `CFG.FIN.FYV.ASSIGN` Assign fiscal year variant to Company Code | OB37 | Config | `/config/fiscal-year-variants/assign-company-codes` |
| `CFG.FIN.GLACCOUNT.CREATE` G/L account master create | FS00 | Config | `/config/gl-accounts/new` |
| `CFG.FIN.GLACCOUNT.CHANGE` G/L account master change | FSP0 | Config | `/config/gl-accounts/edit` |
| `CFG.FIN.GLACCOUNT.DISPLAY` G/L account master display | FSS0 | Config | `/config/gl-accounts` |
| `CFG.FIN.GLACCOUNT.TRANSFER` G/L account master transfer | FS15 | Config | `/config/gl-accounts/transfer` |
| `CFG.FIN.DOCTYPE.DEFINE` Define document types | OBA7 | Config | `/config/document-types` |
| `CFG.FIN.IC.DEFINE` Configure intercompany clearing accounts | OBYA | Config | `/config/intercompany-clearing` |
| `FIN.IC.POST` Post an intercompany journal | FB01 | Transaction | `/finance/intercompany` |
| `CFG.FIN.TOLERANCE.DEFINE` Define employee tolerance groups | OBA4 | Config | `/config/tolerance-groups` |
| `CFG.FIN.RETAINED.DEFINE` Define retained earnings account | OB53 | Config | `/config/retained-earnings` |
| `CFG.FIN.ACCTDET.DEFINE` Define account determination | OBYC | Config | `/config/account-determination` |
| `CFG.FIN.HOUSEBANK.DEFINE` Define house banks | FI12 | Config | `/config/house-banks` |
| `CFG.FIN.BANK.DEFINE` Define banks (bank master) | FI01 | Transaction | `/config/banks` |
| `CFG.FIN.TAXCODE.DEFINE` Define tax codes for sales and purchases | FTXP | Config | `/config/tax-codes` |
| `CFG.FIN.EXRATE.MAINTAIN` Maintain exchange rates | OB08 | Config | `/config/exchange-rates` |
| `CFG.FIN.PPV.ASSIGN` Assign posting period variant to Company Code | OBBP | Config | `/config/posting-period-variants/assign-company-codes` |
| `CFG.FIN.PPV.DEFINE` Posting period variant definition | OBBO | Config | `/config/posting-period-variants` |
| `FIN.CLOSE.PERIOD` Posting periods | OB52 | Transaction | `/config/posting-periods` |
| `FIN.JOURNAL.POST` Post a journal entry | FB50, F-02 | Transaction | `/finance/journal/new` |
| `FIN.JOURNAL.PARK` Park a journal entry | FV50 | Transaction | `/finance/journal/park` |
| `FIN.JOURNAL.LIST` G/L line item report | FAGLL03 | Transaction | `/finance/journal/items` |
| `FIN.GL.BALANCE` G/L account balances by period | FS10N | Transaction | `/finance/journal/balances` |
| `FIN.DOC.FLOW` Accounting document display and flow | FB03 | Transaction | `/finance/journal/document` |
| `FIN.ASSET.CREATE` Create asset master | AS01 | Transaction | `/finance/assets/new` |
| `FIN.ASSET.ACQUIRE` Acquire asset against offsetting account | ABZON | Transaction | `/finance/assets/acquire` |
| `FIN.ASSET.RETIRE` Retire asset by scrapping | ABAVN | Transaction | `/finance/assets/retire` |
| `FIN.ASSET.DEPRECIATE` Depreciation run | AFAB | Transaction | `/finance/assets/depreciate` |
| `FIN.RPT.TRIALBALANCE` Trial balance / financial statement | F.01 | Transaction | `/finance/trial-balance` |
| `FIN.RPT.BALANCESHEET` Balance sheet / profit and loss statement | S_ALR_87012284, FC10 | Transaction | `/finance/balance-sheet` |
| `FIN.RPT.SUBLEDGER.TIE` G/L to subledger tie-out | FAGLB03, F.03 | Transaction | `/finance/subledger-tie-out` |
| `FIN.RPT.PROFITLOSS` Profit and loss statement | S_PL0_86000028 | Transaction | `/finance/profit-loss` |
| `FIN.CREDIT.RELEASE` Release credit-blocked documents | VKM3 | Transaction | `/finance/credit-release` |
| `FIN.CREDIT.MONITOR` Credit exposure monitor | F.31 | Transaction | `/finance/credit-monitor` |
| `FIN.CREDIT.MAINTAIN` Customer credit management | FD32 | Transaction | `/finance/credit` |
| `FIN.CLOSE.CARRYFORWARD` G/L balance carryforward | F.16, FAGLGVTR | Transaction | `/finance/carryforward` |
| `FIN.CLOSE.COCKPIT` Period-end close cockpit | CLOCO, CLOCOC, FCLOCO, FCLOCOC | Transaction | `/finance/close-cockpit` |
| `FIN.ACCRUAL.POST` Accrual/deferral documents | FBS1, F.81 | Transaction | `/finance/accruals` |
| `FIN.GRIR.RECLASS` GR/IR clearing account analysis | F.19 | Transaction | `/finance/grir-reclass` |
| `FIN.FX.VALUATE` Foreign currency valuation | FAGL_FC_VAL | Transaction | `/finance/fx/valuation` |
| `FIN.TAX.REPORT` Advance return for tax on sales/purchases | S_ALR_87012357 | Transaction | `/finance/tax/report` |
| `FIN.ASSET.REPORT` Asset history sheet | S_ALR_87011990 | Transaction | `/finance/assets/history` |
| `FIN.ASSET.CHANGE` Change asset master | AS02 | Transaction | `/finance/assets` |
| `FIN.JOURNAL.DISPLAY` Display an accounting document | FB03 | Transaction | `/finance/journal` |

## Controlling (CO) (10)

| Function | Alias | Type | Route |
|---|---|---|---|
| `CFG.COST.COSTCENTER.DEFINE` Define cost centres | KS01 | Config | `/config/cost-centers` |
| `CFG.COST.COSTCENTERHIER.DEFINE` Define cost centre hierarchy | KSH1, KSH2, OKEON | Config | `/config/cost-center-hierarchy` |
| `CFG.COST.ACTIVITYTYPE.DEFINE` Define activity types | KL01 | Config | `/config/activity-types` |
| `CFG.COST.ACTIVITYRATE.CONFIRM` Plan activity prices | KP26 | Config | `/config/activity-rates` |
| `CFG.COST.PROFITCENTER.DEFINE` Define profit centres | KE51 | Config | `/config/profit-centers` |
| `CFG.COST.PROFITCENTERHIER.DEFINE` Define profit centre hierarchy | KCH1, KCH5N, KCH6N | Config | `/config/profit-center-hierarchy` |
| `FIN.RPT.COSTCENTER.ACTUAL` Cost centre actual/plan report | S_ALR_87013611, S_ALR_87013614, KSB1N | Transaction | `/controlling/cost-center-report` |
| `FIN.RPT.PROFITCENTER` Profit centre actual line items | KE5Z | Transaction | `/controlling/profit-center-report` |
| `CFG.COST.CONTROLLINGAREA.DEFINE` Controlling area | OKKP | Config | `/config/controlling-area` |
| `CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY` Assign company code to controlling area | OX19 | Config | `/config/controlling-area/assign-company-code` |

## Procurement (MM) (30)

| Function | Alias | Type | Route |
|---|---|---|---|
| `PROC.INV.RECORD` Enter incoming invoice | MIRO, MR8M | Transaction | `/purchasing/invoice-verification` |
| `PROC.INV.PARK` Park supplier invoice | MIR7 | Transaction | `/purchasing/parked-invoice` |
| `PROC.INV.OVERVIEW` Invoice overview | MIR6 | Transaction | `/purchasing/invoice-overview` |
| `PROC.INV.BLOCK` Place invoice payment hold | — | Transaction | `/purchasing/blocked-invoice` |
| `PROC.INV.BLOCK.RELEASE` Release blocked invoices | MRBR | Transaction | `/purchasing/blocked-invoice` |
| `PROC.GRIR.MAINTAIN` Maintain GR/IR clearing | MR11 | Transaction | `/purchasing/grir-clearing` |
| `PROC.GRIR.MAINTAIN.POST` Post GR/IR clearing | — | Transaction | `/purchasing/grir-clearing` |
| `PROC.GRIR.MAINTAIN.REVERSE` Reverse GR/IR clearing | — | Transaction | `/purchasing/grir-clearing` |
| `PROC.INFO.RECORD.MAINTAIN` Purchasing info record | ME11, ME12 | Transaction | `/purchasing/info-record` |
| `PROC.SOURCE.LIST.MAINTAIN` Purchasing source list | ME01 | Transaction | `/purchasing/source-list` |
| `PROC.QUOTA.MAINTAIN` Purchasing quota arrangement | MEQ1 | Transaction | `/purchasing/quota-arrangement` |
| `PROC.RFQ.CREATE` Request for quotation | ME41, ME42 | Transaction | `/purchasing/rfq` |
| `PROC.RFQ.QUOTATION` Quotation | ME47 | Transaction | `/purchasing/quotation` |
| `PROC.RFQ.QUOTATION.DISPLAY` Display quotation | ME48 | Transaction | `/purchasing/quotation-display` |
| `PROC.RFQ.COMPARISON` Compare quotations | ME49 | Transaction | `/purchasing/quotation-comparison` |
| `PROC.PO.CREATE` Create purchase order | ME21N, ME22N, ME28, ME29N | Transaction | `/purchasing/orders` |
| `PROC.PO.DISPLAY` Display purchase order | ME23N | Transaction | `/purchasing/purchase-order-display` |
| `PROC.VENDOR.EVALUATE` Maintain vendor evaluation | ME61 | Transaction | `/purchasing/vendor-evaluation` |
| `PROC.PO.ACCOUNTASSIGN` Purchase orders by account assignment | ME2K | Transaction | `/purchasing/orders-by-account-assignment` |
| `PROC.PO.LIST` Purchase order list display | ME2L, ME2M, ME2N, ME2C | Transaction | `/purchasing/purchase-order-list` |
| `PROC.PR.CREATE` Create purchase requisition | ME51N, ME52N, ME53N, ME54N, ME55 | Transaction | `/purchasing/requisitions` |
| `PROC.REQ.LIST` Purchase requisitions: list display | ME5A | Transaction | `/purchasing/requisition-list` |
| `PROC.SUPPLIER.PURCHASING.MAINTAIN` Supplier purchasing defaults | — | Transaction | `/foundation/partners?view=SUPPLIER_PURCHASING` |
| `CFG.PROC.RELEASE.DEFINE` Define release strategies | OMGSCK | Config | `/config/release-strategies` |
| `CFG.PROC.CLASS.DEFINE` Define classes | CL01, CL02, CL03 | Config | `/config/classes` |
| `CFG.PROC.CHARACTERISTIC.DEFINE` Define characteristics | CT04 | Config | `/config/characteristics` |
| `CFG.PROC.PURORG.DEFINE` Purchasing Organisation definitions | OX08 | Config | `/config/purchasing-orgs` |
| `CFG.PROC.PURORG.ASSIGN_COMPANY` Assign Purchasing Organisation to Company Code | — | Config | `/config/purchasing-orgs/assign-company` |
| `CFG.PROC.PURORG.ASSIGN_PLANT` Assign purchasing organisation to plant | OX17 | Config | `/config/purchasing-orgs/assign-plant` |
| `CFG.PROC.PURGROUP.DEFINE` Purchasing group | — (screen built, alias not registered) | Config | `/config/purchasing-groups` |

## Inventory (MM-IM) (29)

| Function | Alias | Type | Route |
|---|---|---|---|
| `INV.STOCK.VIEW` Stock overview | MMBE | Transaction | `/inventory/stock-overview` |
| `INV.RETURN.POST` Return delivery to a vendor | MBRL | Transaction | `/inventory/return-delivery` |
| `INV.STOCK.UOM` Units of measure per material | CUNI | Transaction | `/inventory/uom-conversion` |
| `INV.STOCK.RECONCILE` Stock reconciliation | MB5L | Transaction | `/inventory/stock-reconcile` |
| `INV.STOCK.WAREHOUSE` Warehouse stocks on hand | MB52 | Transaction | `/inventory/warehouse-stocks` |
| `INV.STOCK.POSTINGDATE` Stocks on posting date | MB5B | Transaction | `/inventory/stock-posting-date` |
| `INV.GI.POST` Post goods issue | MB1A | Transaction | `/inventory/goods-issue` |
| `INV.MATERIALDOC.RECEIVEPRINT` Material document output | MB90 | Transaction | `/inventory/material-document-output` |
| `INV.DISPLAY` Display material document | MB03 | Transaction | `/inventory/material-documents` |
| `INV.MATERIALDOC.LIST` Material document list | MB51 | Transaction | `/inventory/material-document-list` |
| `INV.PHYINV.CREATE` Physical inventory | MI01, MI02 | Transaction | `/inventory/physical-inventory` |
| `INV.PHYINV.COUNT` Enter physical inventory count | MI04 | Transaction | `/inventory/physical-inventory-count` |
| `INV.PHYINV.DIFF.LIST` Physical inventory differences | MI20 | Transaction | `/inventory/physical-inventory-differences` |
| `INV.PHYINV.DIFF.POST` Post inventory differences | MI07 | Transaction | `/inventory/physical-inventory-posting` |
| `INV.PHYINV.RECOUNT` Recount physical inventory | MI11 | Transaction | `/inventory/physical-inventory-recount` |
| `INV.MIGO.POST` Goods movement | MIGO | Transaction | `/inventory/migo` |
| `INV.GR.POST` Post goods receipt | MIGO | Transaction | `/inventory/goods-receipt` |
| `INV.RESERVATION.CREATE` Create reservation | MB21 | Transaction | `/inventory/reservations` |
| `INV.REVERSE` Reverse material document | MBST | Transaction | `/inventory/reversal` |
| `INV.TRANSFER.POST` Post stock transfer | MB1B | Transaction | `/inventory/transfer-posting` |
| `INV.MATERIAL.CREATE` Create material | MM01 | Transaction | `/inventory/materials?new=1` |
| `INV.MATERIAL.FLAGDELETION` Flag material for deletion | MM06 | Transaction | `/inventory/materials` |
| `INV.MATERIAL.DISPLAY` Material master list | MM02, MM03 | Transaction | `/inventory/materials` |
| `CFG.INV.MATERIALTYPE.DEFINE` Define material types | OMS2 | Config | `/config/material-types` |
| `CFG.INV.MOVETYPE.CONFIG` Configure movement types | OMJJ | Config | `/config/movement-types` |
| `CFG.INV.MATPERIOD.DEFINE` Define material period control | OMSY, MMPV, MMRV | Config | `/config/material-period-control` |
| `CFG.INV.INDUSTRYSECTOR.DEFINE` Define industry sectors | OMS3 | Config | `/config/industry-sectors` |
| `CFG.INV.MATERIALRANGE.DEFINE` Define material number ranges | MMNR | Config | `/config/material-number-ranges` |
| `CFG.INV.MATERIALGROUP.DEFINE` Define material groups | OMSF | Config | `/config/material-groups` |

## Production (37)

Thirty-two `PROD.*` codes are registered in `CAPABILITIES` in `scripts/seed.ts` (thirty-three rows, because
`PROD.MRP.RUN` is entered twice), and five more are demanded by built screens without being registered —
`PROD.MRP.SETTINGS`, `PROD.WORKCENTER.{CREATE,CHANGE,DISPLAY}` and `PROD.CONFIRM.CANCEL` — the
"built screens whose code is in one of those and not the other" case the header names (DI-014 in
`docs/DEFERRED_ISSUES.md`). Route is the screen that demands the code, read from that page's own
`requireCapability` calls; a screen that demands several codes appears under each. The alias is the search code
the screen prints beside its capability, or the one its registry description names.

| Function | Alias | Type | Route |
|---|---|---|---|
| `PROD.ORDER.CREATE` Create a production order | CO01 | Transaction | `/production/orders` |
| `PROD.ORDER.RELEASE` Release a production order | CO01 | Action | `/production/orders` |
| `PROD.ORDER.CHANGE` Change a production order | CO02 | Transaction | `/production/production-order-change` · `/production/order-information` |
| `PROD.ORDER.DISPLAY` Display a production order | CO03 | Transaction | `/production/production-order-display` · `/production/order-availability` |
| `PROD.ORDER.GI` Issue components to a production order | MIGO | Transaction | `/inventory/migo` — 261 is offered there alone, and `MB1A` refuses it by name |
| `PROD.ORDER.GR` Receive finished goods from a production order | MIGO | Transaction | `/inventory/migo` — movement 101 with R08, `production-receipt.ts` |
| `PROD.ORDER.SETTLE` Settle a production order | — | Registered, no screen | — — see the note below: it settles nothing |
| `PROD.ORDER.INFO` List production and planned orders | COOIS | Transaction | `/production/order-information` |
| `PROD.CONFIRM.ENTER` Enter a time ticket | CO11N | Transaction | `/production/time-ticket` · `/production/order-information` |
| `PROD.CONFIRM.ORDER` Confirm at header level | CO15 | Transaction | `/production/order-confirmation` · `/production/order-information` |
| `PROD.CONFIRM.CANCEL` Cancel a confirmation | CO13 | Transaction | `/production/confirmation-cancel` |
| `PROD.MRP.RUN` Plan a plant | MD01, MD02 | Transaction | `/production/mrp-run` · `/production/single-item-planning` |
| `PROD.MRP.REGENERATE` Confirm a regenerative run | — | Action | `/production/mrp-run` · `/production/single-item-planning` · `/production/single-level-planning` |
| `PROD.MRP.SINGLELEVEL` Plan one material at one level | MD03 | Transaction | `/production/single-level-planning` |
| `PROD.MRP.STOCKREQ` Stock/requirements list, and the availability of an order | MD04, CO09 | Transaction | `/production/stock-requirements` · `/production/order-availability` |
| `PROD.MRP.SETTINGS` Material planning settings | — | Transaction | `/inventory/materials?view=MRP` |
| `PROD.MATERIAL.MRP.MAINTAIN` Maintain material planning views | — | Action | the MRP view of `/inventory/materials`; the posting records this code |
| `PROD.PLANNEDORDER.CREATE` Create a planned order by hand | MD11 | Transaction | `/production/planned-order-create` |
| `PROD.PLANNEDORDER.CHANGE` Change a planned order | MD12 | Transaction | `/production/planned-order-change` |
| `PROD.PLANNEDORDER.DISPLAY` Display a planned order | MD13 | Transaction | `/production/planned-order-display` · `/production/order-information` |
| `PROD.PLANNEDORDER.CONVERT` Convert one planned order | CO40 | Transaction | `/production/planned-order-conversion` |
| `PROD.PLANNEDORDER.CONVERT.COLLECTIVE` Convert a selected set | CO41 | Transaction | `/production/planned-order-conversion-collective` |
| `PROD.WORKCENTER.CREATE` Define a work centre | CR01 | Transaction | `/production/work-centers` |
| `PROD.WORKCENTER.CHANGE` Change a work centre | CR02 | Transaction | `/production/work-centers` |
| `PROD.WORKCENTER.DISPLAY` Display a work centre | CR03 | Transaction | `/production/work-center-display` |
| `PROD.BOM.CREATE` Create a material BOM | CS01 | Transaction | `/production/boms` |
| `PROD.BOM.CHANGE` Change a material BOM | CS02 | Transaction | `/production/boms` |
| `PROD.BOM.DISPLAY` Display a material BOM | CS03 | Transaction | `/production/bom-display` |
| `PROD.ROUTING.CREATE` Create a standard routing | CA01 | Transaction | `/production/routings` — not the chart-of-accounts key of the same name |
| `PROD.ROUTING.CHANGE` Change a standard routing | CA02 | Transaction | `/production/routings` |
| `PROD.ROUTING.DISPLAY` Display a standard routing | CA03 | Transaction | `/production/routing-display` |
| `PROD.VERSION.CREATE` Create a production version | C223 | Transaction | `/production/production-versions` |
| `PROD.VERSION.CHANGE` Change a production version | C223 | Transaction | `/production/production-versions` |
| `PROD.VERSION.DISPLAY` Display a production version | C223 | Transaction | `/production/production-version-display` |
| `PROD.VERSION.CHECK` Run the version consistency check | — | Action | `/production/production-versions` |
| `PROD.VERSION.LOCK` Lock or unlock a version | — | Action | `/production/production-versions` |
| `PROD.VERSION.DELETE` Delete or flag an unused version | — | Action | `/production/production-versions` |

Two lines carry a decision rather than a screen. `PROD.ORDER.SETTLE` is granted by the registry and implements
nothing for a production order: no cost basis stands on the order to settle, so there is no variance, no WIP and
no settlement to read, `CO88` is not wired, and the acceptance criteria live in DI-012 of
`docs/DEFERRED_ISSUES.md`. `docs/production-tcode-order.md` and the header of
`src/modules/inventory/production-orders.ts` say the same thing. And the two goods movements of an order are not
new transactions: they are the 261 issue and the 101 + R08 receipt on MIGO, which is why `MB1A` refuses a 261 by
name and names the screen that posts it.

## Sales (8)

| Function | Alias | Type | Route |
|---|---|---|---|
| `SALES.CUSTOMER.SALESAREA.MAINTAIN` Customer sales area defaults | VD02, VD03 | Transaction | `/foundation/partners?view=CUSTOMER_SALES` |
| `CFG.ORG.SALESORG.DEFINE` Sales Organization definition | — | Config | `/config/sales-orgs` |
| `CFG.ORG.SALESORG.ASSIGN_COMPANY` Assign Sales Organization to Company Code | OVX3 | Config | `/config/sales-orgs/assign-company` |
| `CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL` Assign Distribution Channel to Sales Organization | OVXK | Config | `/config/sales-orgs/assign-distribution-channel` |
| `CFG.ORG.DISTCHANNEL.DEFINE` Distribution Channel definitions | OVXI | Config | `/config/distribution-channels` |
| `CFG.ORG.DIVISION.DEFINE` Division definitions | OVXB | Config | `/config/divisions` |
| `CFG.ORG.SALESORG.ASSIGN_DIVISION` Assign Division to Sales Organization | OVXA | Config | `/config/sales-orgs/assign-division` |
| `CFG.ORG.SALESAREA.DEFINE` Sales Area | OVXG | Config | `/config/sales-areas` |

