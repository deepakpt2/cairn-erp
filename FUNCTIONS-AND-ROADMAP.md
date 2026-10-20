# Cairn ERP — Functions & Roadmap

> **Maintenance rule (owner instruction, 2026-10-18):** this file is updated on **each completion** (an SCR acceptance moves its items to *Implemented*) and on **each deferred decision** (items move to *Deferred* with the decision reference), in the same turn as the event. The "As of" line below always names the latest event reflected.

Status key: **Implemented** (built, tested, accepted) · **Roadmap** (in the frozen plan, not yet built) · **Deferred** (postponed by owner decision).
SAP transaction codes are search aliases only. Sources: delivered catalogue (`scripts/seed.ts`, 160 capabilities / 134 business terms / 156 aliases) and the frozen roadmap (`CAIRN.md` §10). As of SCR-129 ME2K orders by account assignment closure (B-848), 2026-10-20.

## Finance — General ledger

| Item | T-code | Module | Status |
|---|---|---|---|
| Post a general journal entry (FIN.JOURNAL.POST) | FB50 / F-02 | Finance | Implemented |
| Display an accounting document (FIN.JOURNAL.DISPLAY) | FB03 | Finance | Implemented |
| Reverse any accounting document (FIN.DOCUMENT.REVERSE) | FB08 | Finance | Implemented |
| Reset cleared items (FIN.CLEARING.RESET) | FBRA | Finance | Implemented |
| Clear G/L open items (FIN.GL.CLEAR) | F-03 | Finance | Implemented (SCR-114, B-749); tolerance difference (B-807), advanced clearing (B-815), residual terms inheritance, cross-currency partial clearing and realized-FX routing (B-821) delivered |
| Park a journal entry (FIN.JOURNAL.PARK) | FV50 | Finance | Implemented (SCR-087) |
| Line item report with drill-through (FIN.JOURNAL.LIST) | FAGLL03 / S_ALR_87012272 / S_ALR_87012273 | Finance | Implemented (SCR-088; pagination and assignment added SCR-108) |
| G/L account balances by period (FIN.GL.BALANCE) | FS10N / S_ALR_87012271 | Finance | Implemented (SCR-089; range balance report added SCR-108) |
| Accounting document flow (FIN.DOC.FLOW) | FB03 (flow) | Finance | Implemented (SCR-090) |
| Open and close posting periods (FIN.CLOSE.PERIOD) | OB52 | Finance | Implemented |

## Finance — Accounts payable (AP)

| Item | T-code | Module | Status |
|---|---|---|---|
| Enter vendor invoice (FIN.AP.INVOICE.POST) | FB60 | Finance AP | Implemented |
| Enter vendor credit memo (FIN.AP.CREDITMEMO.POST) | FB65 | Finance AP | Implemented |
| Post outgoing payment with discount, residual/partial, on-account and tolerated differences (FIN.AP.PAYMENT.POST) | F-53 | Finance AP | Implemented |
| Post vendor down payment (FIN.AP.DOWNPAYMENT.POST) with special G/L configuration (CFG.FIN.SPECIALGL.DEFINE) | F-48 | Finance AP | Implemented |
| Post vendor down payment request (FIN.AP.DOWNPAYMENT.REQUEST) | F-47 | Finance AP | Implemented |
| Clear vendor down payment (FIN.AP.DOWNPAYMENT.CLEAR) | F-54 | Finance AP | Implemented |
| Automatic payment run (FIN.AP.PAYMENTRUN.EXECUTE) | F110 | Finance AP | Implemented |
| Clear vendor open items (FIN.AP.CLEAR) | F-44 | Finance AP | Implemented |
| Vendor balances and due items (FIN.AP.BALANCE) | FK10N | Finance AP | Implemented |
| Vendor ageing analysis (FIN.AP.AGEING) — reconciliation-role population, canonical payment-term due dates, special G/L selection, CSV export | S_ALR_87012085 | Finance AP | Implemented (reworked SCR-120, B-798) |

## Finance — Accounts receivable (AR)

| Item | T-code | Module | Status |
|---|---|---|---|
| Enter customer invoice (FIN.AR.INVOICE.POST) | FB70 | Finance AR | Implemented |
| Post incoming payment with discount, residual/partial, on-account and tolerated differences (FIN.AR.PAYMENT.ENTER) | F-28 | Finance AR | Implemented |
| Clear customer open items (FIN.AR.CLEAR) | F-32 | Finance AR | Implemented |
| Customer balances and due items (FIN.AR.BALANCE) | FD10N | Finance AR | Implemented |
| Customer ageing analysis (FIN.AR.AGEING) — mirror repair of the ageing derivation (SCR-120) | S_ALR_87012178 | Finance AR | Implemented (reworked SCR-120, B-798) |
| Post customer down payment received (FIN.AR.DOWNPAYMENT.POST) | F-29 | Finance AR | Implemented |
| Clear customer down payment (FIN.AR.DOWNPAYMENT.CLEAR) | F-39 | Finance AR | Implemented |
| Post customer down payment request (FIN.AR.DOWNPAYMENT.REQUEST) | F-37 | Finance AR | Implemented |
| Dunning programme (FIN.AR.DUNNING.RUN) | F150 | Finance AR | Implemented |

## Finance — Bank, assets, tax, close, credit

| Item | T-code | Module | Status |
|---|---|---|---|
| Import bank statement (FIN.BANK.STATEMENT.IMPORT) | FF.5 | Finance Bank | Deferred (B-507) |
| Post and reconcile statement lines (FIN.BANK.STATEMENT.POST) | FEBAN | Finance Bank | Deferred (with FF.5) |
| Automatic clearing run (FIN.BANK.AUTOCLEAR) | F.13 | Finance Bank | Deferred (with FF.5) |
| Asset master create/change (FIN.ASSET.CREATE) | AS01 / AS02 | Finance Assets | Implemented (SCR-091) |
| Asset acquisition posting (FIN.ASSET.ACQUIRE) | ABZON / F-90 | Finance Assets | Implemented (SCR-092) |
| Asset retirement (FIN.ASSET.RETIRE) | ABAVN | Finance Assets | Implemented (SCR-093) |
| Depreciation run (FIN.ASSET.DEPRECIATE) | AFAB | Finance Assets | Implemented (SCR-094) |
| Asset history sheet (FIN.ASSET.REPORT) | S_ALR_87011990 | Finance Assets | Implemented (SCR-095, B-612) |
| Tax posting and handling (FIN.TAX.POST) | FB50 | Finance Tax | Implemented (SCR-096, B-619) — delivered as the FB50 parity rework of FIN.JOURNAL.POST: judged G/L entry with assignments and duplicate-safe posting |
| Advance return for tax on sales/purchases (FIN.TAX.REPORT) | S_ALR_87012357 | Finance Tax | Implemented (SCR-097, B-626) |
| Foreign-currency valuation run (FIN.FX.VALUATE) | FAGL_FC_VAL | Finance Close | Implemented (SCR-098, B-633) |
| GR/IR clearing account analysis (FIN.GRIR.RECLASS) | F.19 | Finance Close | Implemented (SCR-099, B-640) |
| Accrual and deferral postings (FIN.ACCRUAL.POST) | FBS1 | Finance Close | Implemented (SCR-100, B-647) |
| Period-end close cockpit (FIN.CLOSE.COCKPIT) | CLOCO | Finance Close | Implemented (SCR-101, B-655) |
| Balance carryforward (FIN.CLOSE.CARRYFORWARD) | FAGLGVTR | Finance Close | Implemented (SCR-102, B-662) |
| Intercompany posting (FIN.IC.POST) | FB01 | Finance | Implemented (SCR-122, B-827) — one submission posts both company documents atomically, each balanced by its own OBYA clearing line, every line stamped with its trading partner |
| Intercompany clearing (FIN.IC.CLEAR) | F-03 | Finance | Delivered through the standing G/L clearing screen (SCR-114/B-815): OBYA balances are ordinary open-item balances, cleared by FIN.GL.CLEAR with tolerance, partial, residual and cross-currency rules — no separate IC clearing capability was added |
| Credit master per customer (FIN.CREDIT.MAINTAIN) | FD32 | Finance Credit | Implemented (SCR-103, B-671) |
| Credit exposure monitor (FIN.CREDIT.MONITOR) | F.31 | Finance Credit | Implemented (SCR-104, B-678) |
| Release credit-blocked documents (FIN.CREDIT.RELEASE) | VKM3 | Finance Credit | Implemented (SCR-105, B-685) |

## Finance — Reports

| Item | T-code | Module | Status |
|---|---|---|---|
| Trial balance (FIN.RPT.TRIALBALANCE) | F.01 | Finance Reports | Implemented (SCR-106, B-692) |
| Balance sheet with comparatives (FIN.RPT.BALANCESHEET) | S_ALR_87012284 | Finance Reports | Implemented (SCR-107, B-699) |
| Profit and loss statement (FIN.RPT.PROFITLOSS) | S_PL0_86000028 | Finance Reports | Implemented (SCR-111, B-728) |
| Cash flow statement (FIN.RPT.CASHFLOW) — direct + indirect methods over the posted journal, classified from standing configuration, reconciled to the house-bank cash movement | S_ALR_87012271 (Direct), S_ALR_87012272/73 (Indirect) | Finance Reports | Implemented (SCR-119, B-784) |
| Cost centre actual vs plan (FIN.RPT.COSTCENTER.ACTUAL) — group exclusion leaves honoured, line-item drill-down | S_ALR_87013611 | Finance Reports | Implemented (SCR-112, B-735; exclusion-leaf repair B-801) |
| Profit centre reporting (FIN.RPT.PROFITCENTER) — actual line items with CSV export of the shown selection | KE5Z | Finance Reports | Implemented (SCR-113, B-742; CSV export B-804) |
| G/L to subledger tie-out (FIN.RPT.SUBLEDGER.TIE) | FAGLB03 | Finance Reports | Implemented (SCR-115, B-756) |
| Consolidation (FIN.RPT.CONSOLIDATE) | UCWB (Consolidation Workbench) | Finance Reports | Implemented (SCR-116, B-763) |
| Consolidation monitor (FIN.CONSOLIDATE) | CX20 / UCMON (Consolidation Monitor) | Finance Reports | Implemented (SCR-117, B-770) |
| Consolidated statements (FIN.RPT.CONSOLIDATE.STMT) | — | Finance Reports | Implemented (SCR-118, B-777) |

## Business partners & master data

| Item | T-code | Module | Status |
|---|---|---|---|
| Create business partner (FND.PARTNER.CREATE) | BP / XK01 / XD01 | Foundation | Implemented |
| Maintain business partners (FND.PARTNER.MAINTAIN) | — | Foundation | Implemented |
| Business partner list (FND.PARTNER.DISPLAY) | — | Foundation | Implemented |
| Customer company accounting | — | Foundation | Implemented |
| Supplier company accounting | — | Foundation | Implemented |
| Customer sales-area defaults | VD02 / VD03 | Foundation | Implemented |
| Supplier purchasing defaults | — | Foundation | Implemented |
| Create material (INV.MATERIAL.CREATE) | MM01 | Inventory | Implemented |
| Material master list / change (INV.MATERIAL.DISPLAY) | MM02 / MM03 | Inventory | Implemented |
| Flag material for deletion (INV.MATERIAL.FLAGDELETION) | MM06 | Inventory | Implemented |
| Material planning settings (PROD.MRP.SETTINGS) | MM02 views | Production | Implemented |

## Procurement

| Item | T-code | Module | Status |
|---|---|---|---|
| Create purchase requisition (PROC.PR.CREATE) | ME51N / ME52N / ME53N | Procurement | Implemented |
| Release requisition / order (inside PR & PO flows) | ME54N / ME55 / ME29N / ME28 | Procurement | Implemented |
| Create purchase order (PROC.PO.CREATE) | ME21N / ME22N / ME23N | Procurement | Implemented |
| Enter incoming invoice, verification (PROC.INV.RECORD) | MIRO / MR8M | Procurement | Implemented |
| Post goods receipt (INV.GR.POST) | MIGO | Inventory | Implemented |
| Purchase requisition list display (PROC.REQ.LIST) | ME5A | Procurement | Implemented — `/purchasing/requisition-list`; ranges on purchasing group, plant, material and derived purchasing organisation, requisitioner, dates and account assignment, conversion status derived from live order items, closed hidden by default, drill-down to the requisition display (SCR-123) |
| RFQ create (PROC.RFQ.CREATE) | ME41 | Procurement | Roadmap |
| Enter quotation / price comparison (PROC.QUOTE.ENTER) | ME47 / ME49 | Procurement | Roadmap |
| Purchase order list display (PROC.PO.LIST) | ME2L, ME2M, ME2N, ME2C | Procurement | Implemented — `/purchasing/purchase-order-list`; four perspectives (vendor/material/order/material group), ranges on vendor, org, group, plant, material, material group and order number with document dates, scope of selection (all / still to be delivered / still to be invoiced / completed) derived from posted goods receipts and supplier invoices, requisition linkage, drill to the order display (SCR-124) |
| Purchase orders by account assignment (PROC.PO.ACCOUNTASSIGN) | ME2K | Procurement | Implemented — `/purchasing/orders-by-account-assignment`; every assignment line with its **cost centre, G/L account, distribution percentage and the share of the item net value it carries**, rounded at the line and **grouped by assigned object so the cost-centre commitments add back to the items**; required scope of list (ALV/STANDARD) and required scope of selection (all / still to be delivered / still to be invoiced / completed) over the delivered and invoiced quantities; drills to the order and the cost-centre report; **asset (A), WBS (P) and internal-order (F) categories refused by name** — the canon assigns purchase order items to cost centres only (SCR-129) |
| PO document flow (PROC.PO.DISPLAY_FLOW) | ME23N (flow) | Procurement | Roadmap |
| Release blocked invoices (PROC.INV.RELEASE) | MRBR | Procurement | Roadmap |
| Park supplier invoice (PROC.INV.PARK) | MIR7 | Procurement | Roadmap |
| Vendor invoice worklist (PROC.INV.LIST) | MIR6 | Procurement | Roadmap |
| GR/IR clearing analysis (PROC.GRIR.ANALYSE) | MR11 | Procurement | Roadmap |
| Vendor evaluation (PROC.VENDOR.EVALUATION) | ME61 | Procurement | Roadmap |
| Vendor account statement (PROC.STATEMENT.VIEW) | FK10N (stmt) | Procurement | Roadmap |
| Purchasing info records (PROC.INFO.RECORD.MAINTAIN) | ME11 / ME12 | Procurement | Roadmap |
| Source lists (PROC.SOURCELIST.MAINTAIN) | ME01 | Procurement | Roadmap |
| Quota arrangements (PROC.QUOTA.MAINTAIN) | MEQ1 | Procurement | Roadmap |

## Inventory (remaining)

| Item | T-code | Module | Status |
|---|---|---|---|
| Goods issue (INV.GI.POST) | MIGO / MB1A | Inventory | Roadmap |
| Stock transfer (INV.TRANSFER.POST) | MIGO / MB1B | Inventory | Roadmap |
| Display material document (INV.DISPLAY) | MB03 | Inventory | Roadmap |
| Reverse material document (INV.REVERSE) | MBST | Inventory | Roadmap |
| Stock overview (INV.STOCK.VIEW) | MMBE | Inventory | Implemented — `/inventory/stock-overview`; three-level tree for **one required material**: plant → storage location → stock type (`UNRESTRICTED`, `QUALITY`, `BLOCKED` and every other named type), **every parent total folded from the children it shows**, zero nodes suppressed at every level unless asked for, expansion level (plants only / plants and locations), each node drilling into MB51, MB5B and MB52; quantitative only — value stays in MB52; batch and in-transit deferred by name, the one-character special stock indicator refused in favour of a named stock type (SCR-128) |
| Stock ageing analysis (INV.STOCKAGE.ANALYSE) | — | Inventory | Roadmap |
| Physical inventory create (INV.PHYINV.CREATE) | MI01 | Inventory | Roadmap |
| Enter count results (INV.PHYINV.ENTERCOUNT) | MI04 | Inventory | Roadmap |
| Post inventory differences (INV.PHYINV.DIFF) | MI07 | Inventory | Roadmap |
| Create reservation (INV.RESERVATION.CREATE) | MB21 | Inventory | Roadmap |
| Batch master (INV.BATCH.MAINTAIN) | MSC1N | Inventory | Roadmap |
| Movement type display (INV.MOVEMENTTYPE.UK) | OMJJ | Inventory | Roadmap |
| Valuation / price change (INV.STOCK.VALUATION) | MR21 | Inventory | Roadmap |
| Stock transport order (INV.STO.CREATE) | ME21N (STO) | Inventory | Roadmap |
| Material document list (INV.MATERIALDOC.LIST) | MB51 | Inventory | Implemented — `/inventory/material-document-list` with a read-only document display at `/inventory/material-documents`; ranges on material, plant, storage location, movement type and purchase order, **required posting-date range**, stock type and user, reversed documents listed with their status, drill to the document (SCR-125) |
| Stocks on posting date (INV.STOCK.POSTINGDATE) | MB5B | Inventory | Implemented — `/inventory/stock-on-posting-date`; read-only rollforward of opening, receipts, issues and closing **quantity and value** per material, plant, storage location and stock type across a **required reporting window**, **required material and plant ranges**, stock type defaulting to unrestricted, zero-stock lines suppressed unless asked for, reversed documents contributing nothing, the stock master compared as a **control that warns, never adjusts**, each row drilling into MB51 on the same window; batch and valuation type, Scope-of-List variants, ageing and exporting deferred by name (SCR-126) |
| Warehouse stocks on hand (INV.STOCK.WAREHOUSE) | MB52 | Inventory | Implemented — `/inventory/warehouse-stocks`; read-only snapshot of the stock master by material, plant and storage location with the **unrestricted / quality-inspection / blocked split plus a special-other column that always adds to the total**, valued at the plant price under both price controls and per price unit, **unknown (never zero) where no valuation stands**, foreign valuation currencies carried without translation, **required scope of list** (ALV grid / standard list), optional ranges as the package states, zero-stock lines suppressed unless asked for, valuation display defaulting on, each row drilling into MB51 and MB5B; valuation type and batch deferred by name, the one-character special stock indicator refused in favour of a named stock type (SCR-127) |
| Print goods receipt note (INV.MATERIALDOC.RECEIVEPRINT) | MB90 | Inventory | Roadmap |

## Production & MRP

| Item | T-code | Module | Status |
|---|---|---|---|
| BOM create/change (PROD.BOM.CREATE) | CS01 / CS02 / CS03 | Production | Roadmap |
| BOM explosion / where-used (PROD.BOM.EXPLODE) | CS11 / CS15 | Production | Roadmap |
| Routing create (PROD.ROUTING.CREATE) | CA01 | Production | Roadmap |
| Work centre create (PROD.WORKCENTER.CREATE) | CR01 | Production | Roadmap |
| MRP run (PROD.MRP.RUN) | MD01 / MD02 | Production | Roadmap |
| Planning file (PROD.MRP.PLANFILE) | MD21 | Production | Roadmap |
| MRP exception monitor (PROD.MRP.EXCEPTIONS) | MD06 | Production | Roadmap |
| Stock/requirements list (PROD.MRP.STOCKREQ) | MD04 | Production | Roadmap |
| Convert planned order (PROD.PLANNEDORDER.CONVERT) | MD11 / CO41 | Production | Roadmap |
| Maintain planned orders (PROD.PLANNEDORDER.MAINTAIN) | MD11 / MD12 | Production | Roadmap |
| Production order create (PROD.ORDER.CREATE) | CO01 | Production | Roadmap |
| Order release / shop papers (PROD.ORDER.RELEASE) | CO02 | Production | Roadmap |
| Component availability (PROD.ORDER.COMPONENT.LIST) | CO24 | Production | Roadmap |
| Goods issue to order (PROD.ORDER.GI) | MIGO 261 | Production | Roadmap |
| Operation confirmation (PROD.CONFIRM.ENTER) | CO11N | Production | Roadmap |
| Goods receipt from order (PROD.ORDER.GR) | MIGO 101 | Production | Roadmap |
| Order cost analysis (PROD.ORDER.COSTS) | CO03 / KOB1 | Production | Roadmap |
| Order settlement (PROD.ORDER.SETTLE) | KO88 | Production | Roadmap |
| Order close (PROD.ORDER.CLOSE) | CO02 | Production | Roadmap |
| Standard cost estimate (PROD.COSTESTIMATE.CREATE) | CK11N | Production | Roadmap |
| Mark/release cost estimate (PROD.COSTESTIMATE.RELEASE) | CK24 | Production | Roadmap |
| Order worklist (PROD.ORDER.LIST) | COOIS | Production | Roadmap |
| Capacity load display (PROD.CAPACITY.LOAD) | CM01 | Production | Roadmap |
| MRP areas (PROD.MRP.AREA.MAINTAIN) | OPPQ | Production | Roadmap |

## Sales

| Item | T-code | Module | Status |
|---|---|---|---|
| Customer enquiry (SALES.INQUIRY.CREATE) | VA11 | Sales | Roadmap |
| Quotation (SALES.QUOTE.CREATE) | VA21 | Sales | Roadmap |
| Sales order (SALES.ORDER.CREATE) | VA01 | Sales | Roadmap |
| Order release (SALES.ORDER.RELEASE) | VA02 | Sales | Roadmap |
| Availability check (SALES.AVAILABILITY.CHECK) | VA03 (ATP) | Sales | Roadmap |
| Order worklist (SALES.ORDER.LIST) | VA05 | Sales | Roadmap |
| Outbound delivery (SALES.DELIVERY.CREATE) | VL01N / VL10 | Sales | Roadmap |
| Picking (SALES.DELIVERY.PICK) | VL02N | Sales | Roadmap |
| Packing (SALES.DELIVERY.PACK) | VL02N | Sales | Roadmap |
| Post goods issue (SALES.GI.POST) | VL02N | Sales | Roadmap |
| Billing (SALES.BILLING.CREATE) | VF01 | Sales | Roadmap |
| Billing due list (SALES.BILLING.LIST) | VF04 | Sales | Roadmap |
| Cancel billing (SALES.BILLING.CANCEL) | VF11 | Sales | Roadmap |
| Returns (SALES.RETURNS.CREATE) | VA01 / VL01N | Sales | Roadmap |
| Sales credit memo (SALES.CREDITMEMO.CREATE) | VF01 | Sales | Roadmap |
| Pricing/condition analysis (SALES.PRICING.ANALYSE) | VA03 | Sales | Roadmap |
| Blocked orders worklist (SALES.BLOCKED.ORDERS) | V.23 / VKM3 | Sales | Roadmap |
| Output printing (SALES.OUTPUT.PRINT) | VF31 / VL71 | Sales | Roadmap |
| Document flow (SALES.ORDER.FLOW) | VA03 (flow) | Sales | Roadmap |
| Incompletion log (SALES.INCOMPLETION.CHECK) | V.02 | Sales | Roadmap |
| Customer account statement (SALES.STATEMENT.VIEW) | FD10N (stmt) | Sales | Roadmap |

## Costing (CO)

| Item | T-code | Module | Status |
|---|---|---|---|
| Cost centre planning (COST.CENTER.PLAN) | KP06 | Costing | Roadmap |
| Activity price calculation (COST.ACTIVITY.RESULT) | KSPI | Costing | Roadmap |
| Assessment cycles (COST.ALLOCATION.ASSESS) | KSU5 | Costing | Roadmap |
| Distribution cycles (COST.ALLOCATION.DISTRIBUTE) | KSV5 | Costing | Roadmap |
| Internal orders (COST.INTERNALORDER.CREATE) | KO01 | Costing | Roadmap |
| Internal order budget (COST.INTERNALORDER.BUDGET) | KO22 | Costing | Roadmap |
| Internal order settlement (COST.INTERNALORDER.SETTLE) | KO88 | Costing | Roadmap |
| Cost centre report (COST.COSTCENTER.REPORT) | KS13 | Costing | Roadmap |
| Order cost analysis (COST.ORDER.COSTANALYSE) | KOB1 | Costing | Roadmap |
| Budget maintenance (COST.BUDGET.MAINTAIN) | KO22 / KSB1 | Costing | Roadmap |

*(Cost/profit centre and activity-type masters themselves stand implemented as configuration — see below.)*

## People (HR)

| Item | T-code | Module | Status |
|---|---|---|---|
| Employee create/change (PEOPLE.EMPLOYEE.CREATE) | PA30 / PA40 | People | Roadmap |
| Dated record maintenance (PEOPLE.RECORD.MAINTAIN) | PA30 | People | Roadmap |
| Organisational units (PEOPLE.ORGUNIT.CREATE) | PPOCE | People | Roadmap |
| Positions (PEOPLE.POSITION.CREATE) | PPOME | People | Roadmap |
| Assignments (PEOPLE.ASSIGNMENT.MAINTAIN) | PA30 | People | Roadmap |
| Time entry (PEOPLE.TIME.ENTER) | PA30 / CAT2 | People | Roadmap |
| Leave balances (PEOPLE.LEAVE.VIEW) | PT50 | People | Roadmap |
| Payroll run (PEOPLE.PAYROLLRUN.EXECUTE) | PC00_M99_CALC | People | Roadmap |
| Payroll results (PEOPLE.PAYROLL.RESULT) | PC00_M99_DISPLAY | People | Roadmap |
| Post payroll to G/L (PEOPLE.PAYROLL.POST) | PC00_M99_CIPE | People | Roadmap |
| Import payroll results (PEOPLE.PAYROLL.IMPORT) | — | People | Roadmap |
| End-of-service provision (PEOPLE.EOS.PROVISION) | — | People | Roadmap |
| Salary payment run (PEOPLE.SALARY.PAYMENT) | F110 | People | Roadmap |
| Headcount reporting (PEOPLE.RPT.HEADCOUNT) | S_AHR_61015507 | People | Roadmap |

## Audit

| Item | T-code | Module | Status |
|---|---|---|---|
| Auditor workspace (AUDIT.WORKSPACE) | — | Audit | Roadmap |
| Change-document trail query (AUDIT.TRAIL.VIEW) | — | Audit | Roadmap |
| Field-level before/after (AUDIT.TRAIL.DISPLAY) | S_ALR_87012050 | Audit | Roadmap |
| Statement drill-down (AUDIT.DRILLDOWN) | — | Audit | Roadmap |
| Tie-out runs (AUDIT.TIEOUT.RUN) | — | Audit | Roadmap |
| Number-range gap report (AUDIT.NUMBERRANGE.CHECK) | — | Audit | Roadmap |
| Period-close evidence pack (AUDIT.PERIOD.EVIDENCE) | — | Audit | Roadmap |
| Access review (AUDIT.ACCESS.REVIEW) | — | Audit | Roadmap |
| Segregation-of-duties analysis (AUDIT.SOD.ANALYSE) | — | Audit | Roadmap |
| Findings tracking (AUDIT.FINDING.RAISE) | — | Audit | Roadmap |
| Evidence export (AUDIT.EVIDENCE.EXPORT) | — | Audit | Roadmap |
| Auditor access grant (AUDIT.ACCESS.GRANT) | — | Audit | Roadmap |

*(Change documents already record every built write; the dedicated audit screens are roadmap.)*

## Configuration & platform (workbench)

| Item | T-code | Module | Status |
|---|---|---|---|
| Configuration workbench (CFG.WORKBENCH) | SPRO / IMG | Platform | Implemented |
| Tenant administration (CFG.PLT.CLIENT.DEFINE) | — | Platform | Implemented |
| Tenant onboarding wizard (CFG.PLT.CLIENT.ONBOARD) | — | Platform | Implemented |
| Number range maintenance (CFG.PLT.NUMBERRANGE.DEFINE) | SNRO | Platform | Implemented |
| Term registry search (PLT.REGISTRY.SEARCH) | — | Platform | Implemented |
| Define company code | OX02 | Foundation | Implemented |
| Assign chart of accounts to company code | — | Foundation | Implemented |
| Define chart of accounts | OB13 | Finance Config | Implemented |
| Copy chart of accounts | OBY7 | Finance Config | Implemented |
| G/L account create | FS00 | Finance Config | Implemented |
| G/L account change | FSP0 | Finance Config | Implemented |
| G/L account display | FSS0 | Finance Config | Implemented |
| Define fiscal year variants | OB29 | Finance Config | Implemented |
| Assign fiscal year variant to company code | OB37 | Finance Config | Implemented |
| Define posting period variants | OBBO | Finance Config | Implemented |
| Assign posting period variant | OBBP | Finance Config | Implemented |
| Define document types | OBA7 | Finance Config | Implemented |
| Define employee tolerance groups | OBA4 | Finance Config | Implemented |
| Define account determination | OBYC | Finance Config | Implemented |
| Retained earnings account definition (CFG.FIN.RETAINED.DEFINE) — per-chart indicator (X standing) to retained earnings account; FS00 forcing rule; carryforward closes per indicator | OB53 | Finance Config | Implemented (SCR-121, B-792) |
| Define payment terms | OBB8 | Finance Config | Implemented |
| Define payment methods | — | Finance Config | Implemented |
| Define house banks | FI12 | Finance Config | Implemented |
| Define bank master | FI01 | Finance Config | Implemented |
| Define tax codes | FTXP | Finance Config | Implemented |
| Maintain exchange rates | OB08 | Finance Config | Implemented |
| Define cost centres | KS01 | Costing Config | Implemented |
| Define cost centre hierarchy | KSH1 / KSH2 / OKEON | Costing Config | Implemented |
| Define activity types | KL01 | Costing Config | Implemented |
| Plan activity prices | KP26 | Costing Config | Implemented |
| Define profit centres | KE51 | Costing Config | Implemented |
| Define profit centre hierarchy | KCH1 / KCH5N / KCH6N | Costing Config | Implemented |
| Define material types | OMS2 | Inventory Config | Implemented |
| Define material groups | OMSF | Inventory Config | Implemented |
| Define industry sectors | OMS3 | Inventory Config | Implemented |
| Maintain Industries | OB44 | Foundation Config | Implemented |
| Define material number ranges | MMNR | Inventory Config | Implemented |
| Define material period control | OMSY / MMPV / MMRV | Inventory Config | Implemented |
| Define classes | CL01 / CL02 / CL03 | Procurement Config | Implemented |
| Define characteristics | CT04 | Procurement Config | Implemented |
| Define release strategies | OMGSCK | Procurement Config | Implemented |
| Define plants | OX10 | Foundation Config | Implemented |
| Define storage locations | OX09 | Foundation Config | Implemented |
| Define purchasing organisations | OX08 | Procurement Config | Implemented |
| Assign purchasing org to company code | — | Procurement Config | Implemented |
| Define purchasing groups | — | Procurement Config | Implemented |
| Define sales organisations | — | Sales Config | Implemented |
| Assign sales org to company code | OVX3 | Sales Config | Implemented |
| Define distribution channels | OVXI | Sales Config | Implemented |
| Define divisions | OVXB | Sales Config | Implemented |
| Sales area maintenance | OVXG | Sales Config | Implemented |
| User / role / authorisation administration | — | Platform | Roadmap |
| Currency definitions | — | Finance Config | Roadmap |
| Controlling area definition & assignment | — | Costing Config | Roadmap |
| Plant-to-company assignment screen | — | Foundation Config | Roadmap |
| Purchasing-org-to-plant assignment | — | Procurement Config | Roadmap |
| Movement type configuration | OMJJ | Inventory Config | Roadmap |
| Work centre / MRP controller / lot-size config | — | Production Config | Roadmap |
| Sales document types, item categories, pricing, output config | — | Sales Config | Roadmap |
| HR record types, pay components, deductions config | — | People Config | Roadmap |
| Credit management config | FD32 config | Finance Config | Roadmap |
| Intercompany config (CFG.FIN.IC.DEFINE) | OBYA | Finance Config | Implemented (SCR-122, B-827) — company pairs with optional per-side clearing-account overrides and default currency; a pair that has posted stands as history and cannot be deleted |
| Import template definitions | — | Platform | Roadmap |
| Message / mail configuration | — | Platform | Roadmap |

## Cross-module reports (roadmap list)

| Item | Module | Status |
|---|---|---|
| Configuration checklist report (FND.RPT.CONFIG.CHECKLIST) | Platform | Roadmap |
| Master data reports (FND.RPT.MASTER.DATA) | Platform | Roadmap |
| Spend analysis (PROC.RPT.SPEND) | Procurement | Roadmap |
| Open purchase orders (PROC.RPT.OPENPO) | Procurement | Roadmap |
| Stock value (INV.RPT.STOCKVALUE) | Inventory | Roadmap |
| Stock movements (INV.RPT.MOVEMENTS) | Inventory | Roadmap |
| Order status / WIP (PROD.RPT.*) | Production | Roadmap |
| Sales backlog / revenue (SALES.RPT.*) | Sales | Roadmap |
| Audit evidence report (AUDIT.RPT.EVIDENCE) | Audit | Roadmap |

## Tier 3 — registry-only until requested

Physical inventory sampling · LIFO/FIFO valuation layers · transfer pricing · material ledger (actual costing) · joint venture accounting · treasury & cash management · profitability analysis (CO-PA) · Kanban / repetitive manufacturing · process manufacturing · warehouse management with bins · variant configuration · batch determination · quality management · plant maintenance · project system · investment management · travel expenses · recruitment & training · finite capacity planning · EDI/IDoc interfaces · foreign trade & customs · real estate · industry solutions · country-specific legal reporting.

---

**Counts:** ~95 functions implemented (35 transactions + ~55 configuration activities, all test-accepted through SCR-078), ~150 roadmap functions across §10.2–§10.10, 3 deferred (FF.5 chain), plus the Tier-3 registry list.
