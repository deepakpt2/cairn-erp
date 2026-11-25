# Cairn ERP — End-to-end UAT guide

**Company:** Cairn Demo Industries Private Limited (`IN01`), Pune, Maharashtra.
**Business:** fabricated steel storage racks and shelving for warehouses and retail.
**Fictional.** Every company, person, vendor, customer, PAN, GSTIN and bank account here is
invented. Nothing resembles a real undertaking.

**Reader:** knows SAP MM well; has little finance, HR, production or QM background. Where a
concept is standard accounting, it is explained in one or two plain sentences. Where the product
cannot do something, the step says **TARGET (GAP)** and the entry is real only in a GST-compliant
system — see `02-gap-list.md`.

---

## How to read this guide

Each step gives:

- **As** — the account to sign in with, from `04-users-and-credentials.md`.
- **Path** — the screen, as it appears in the menu.
- **Data** — the exact values. Phases 0–2 come from the fixture files
  (`fixtures/core/`, `fixtures/country/IN/`, `fixtures/company/IN01/`), which are the single
  source of truth: if a value here disagrees with a fixture, the fixture is right and this file
  is a bug.
- **Expect** — what the screen should show.
- **Journal** — the accounting document the app posts, with Dr/Cr, account and amount.
- **TARGET (GAP)** — the entry a properly localised system would post, shown beside the real one
  so the difference is visible rather than hidden.
- **Verify** — the check that proves the step worked.
- **Why** — one or two sentences for a non-finance reader.

A note on money: every amount is INR. GST is posted at **one consolidated rate per line**
(18 %, 12 % or 5 %), because the product's tax model carries one rate per line and one `TAX`
account per chart. The CGST/SGST/IGST split is **GAP A1**; separate input and output accounts are
**GAP A3**.

---

## Before you start

1. Install the dataset (Phase 0–2):

   ```
   DATABASE_URL=... CAIRN_ENV=development npx tsx scripts/in01-install.ts --until=phase2
   ```

2. Sign in at `/signin` as `in01.admin`. The password is in `credentials/demo-credentials.txt`.
3. Confirm the tenant is `IN01` and the company code is `IN01`.

Working month for the guide: **November 2026**, fiscal year **2026 (April 2026 – March 2027)**,
posting period **8**. Another month can be used by passing `--anchor` at install; the fixture
values and the guide's dates then move together.

---

# Phase 0 — Organisation structure

Everything a company must have before it can post a single document.

## 0.1 Company code

- **As** `in01.admin` · **Path** Configuration → Company codes (`/config/company-codes`)
- **Data**

  | Field | Value |
  |---|---|
  | Company code | `IN01` |
  | Name | Cairn Demo Industries |
  | Country | India (`IN`) |
  | Currency | INR |
  | City | Pune |
  | Chart of accounts | `CA01` |
  | Fiscal year variant | `A4` — April to March |
  | Posting period variant | `C001` |
  | Tax registration number (GSTIN) | `27AABCC1234D1ZV` |

- **Expect** The company code is active, with all four assignments complete. The screen should
  show no assignment warning.
- **Verify** The company code detail shows `CA01`, `A4`, `C001`, `INR`, `IN` — no blank in any of
  the four.
- **Why** The company code is the legal entity that keeps books. Everything posted lands here,
  and the currency and fiscal year on it decide how every document is read.

**Note on the fiscal year.** India runs April to March. The delivered variant `K4` is calendar
year, so the installer builds `A4` and moves the controlling area `A000` onto it before pointing
the company code at it. A company code and its controlling area must share a fiscal year, and
each refuses to change while the other disagrees — which is why the installer unlinks them
through OX19's own assignment service and relinks them once both agree. This is configuration,
not a workaround.

**GAP A9.** April–March is not delivered; a real deployment maintains its own variant.

## 0.2 Controlling area

- **As** `in01.admin` · **Path** Configuration → Controlling area (`/config/controlling-area`)
- **Data**

  | Field | Value |
  |---|---|
  | Controlling area | `A000` |
  | Name | Cairn Demo Industries |
  | Currency | INR |
  | Fiscal year variant | `A4` |
  | Company code scope | Multiple |

- **Expect** The area lists `IN01` as its one assigned company code, with matching currency and
  fiscal year.
- **Verify** Changing the area's fiscal year against the company code's is refused with a message
  naming both.
- **Why** The controlling area is the container for cost accounting. It must read the books in
  the same year and currency as every company code inside it, or a cost report and a P&L would
  disagree about which year they are describing.

## 0.3 Plants and storage locations

- **As** `in01.admin` · **Path** Configuration → Plants (`/config/plants`), Storage locations
  (`/config/storage-locations`)
- **Data**

  | Plant | Name | Production | Storage |
  |---|---|---|---|
  | `1000` | Cairn Demo Industries — Works | Yes | Yes |
  | `2000` | Cairn Demo Industries — Distribution centre | No | Yes |

  Storage locations at plant `1000`: `0001` Raw materials store · `0002` Production floor ·
  `0003` Finished goods warehouse · `0099` Goods receipt area.
  At plant `2000`: `0001` Finished goods hall · `0002` Dispatch bay · `0099` Goods receipt area.

- **Expect** Two plants, each assigned to company code `IN01`. Plant `2000` is not a production
  site.
- **Verify** A goods movement attempted at plant `2000` for a material that is not kept there is
  refused.
- **Why** A plant is where stock physically sits. The factory makes and stores; the distribution
  centre only stores and ships. Testers who find the same material at both have found the reason
  the fixture marks which plants each material is kept at.

## 0.4 Purchasing organisation

- **As** `in01.admin` · **Path** Configuration → Purchasing organisations (`/config/purchasing-orgs`)
- **Data** `1000` — Cairn Demo Industries, company code `IN01`, assigned to both plants.

- **Verify** The purchasing-organisation-to-plant link shows plants `1000` and `2000`.
- **Why** The purchasing organisation is the buying unit that negotiates; a purchase order names
  one, and its plant links decide where the goods can be delivered.

## 0.5 Sales organisation, channel and division

- **As** `in01.admin` · **Path** Configuration → Sales organisations (`/config/sales-orgs`),
  Distribution channels, Divisions
- **Data**

  | Object | Value |
  |---|---|
  | Sales organisation | `1000` — Cairn Demo Industries |
  | Distribution channel | `01` — Direct sales |
  | Division | `01` — Manufactured goods |
  | Sales area | `1000` / `01` / `01` |

- **Verify** The sales area `1000/01/01` appears in the sales-area list.
- **Why** A sales area is the combination that owns a price and a customer's terms. All three
  parts are needed before an order can be priced.

## 0.6 Shipping points

- **As** `in01.admin` · **Path** Configuration → Shipping points (`/config/shipping-points`)
- **Data** `1000` — Works dock, for plant `1000`. `2000` — Distribution dock, for plant `2000`.

- **Verify** Each plant has exactly one shipping point assigned, with a blank condition and a
  blank loading group (so it answers for every customer and material).
- **Why** The shipping point is where goods physically leave. A plant with no dock cannot
  deliver, which is why the installer creates one per plant rather than assuming one.

## 0.7 Chart of accounts and the Indian accounts

- **As** `in01.admin` · **Path** Configuration → Chart of accounts (`/config/chart-of-accounts`),
  G/L accounts (`/config/gl-accounts`)
- **Data** The delivered chart `CA01` plus **20 India-specific accounts** added by the installer:

  | Account | Name | Type |
  |---|---|---|
  | `140100` / `140200` / `140300` | GST input credit — CGST / SGST / IGST | Asset |
  | `220100` / `220200` / `220300` | GST output payable — CGST / SGST / IGST | Liability |
  | `221100` | TDS payable — contractors (194C) | Liability |
  | `221200` | TDS payable — professional fees (194J) | Liability |
  | `251100` | Provident fund payable | Liability |
  | `251200` | ESI payable | Liability |
  | `251300` | Professional tax payable | Liability |
  | `251400` | TDS payable — salary (192) | Liability |
  | `250100` | Salary advances recoverable | Asset |
  | `500400` | Provident fund — employer contribution | Expense |
  | `500500` | ESI — employer contribution | Expense |
  | `510300` | Power and fuel | Expense |
  | `510400` | Consumables — factory | Expense |
  | `520100` | Depreciation — plant and machinery | Expense |
  | `550100` | Insurance — plant and machinery | Expense |
  | `580100` | Rates and taxes — municipal | Expense |

- **Expect** Each added account saves and appears in the chart. A P&L account requires a
  retained-earnings indicator; the installer passes the delivered code `X`.
- **Verify** `220000 Output tax payable`, `140000 Input tax receivable`, `210000 Goods received
  not invoiced`, `200000 Trade payables`, `110000 Trade receivables` and the four inventory
  accounts (`120000`, `120100`, `120200`, `120300`) all exist and are active.
- **Why** The chart is the list of every account the books may use. The generic chart has no GST,
  PF, ESI, PT or TDS accounts, so the installer adds them — as data, through the G/L service.

**GAP A8.** There is no delivered India chart; each deployment maintains its own.
**GAP A3.** Accounts `140100`–`140300` and `220100`–`220300` exist but **nothing posts to them**.
The product has one `TAX` determination account per chart, and the demo points it at `220000`.

## 0.8 GST tax codes

- **As** `in01.admin` · **Path** Configuration → Tax codes (`/config/tax-codes`)
- **Data**

  | Code | Name | Rate | Used for |
  |---|---|---|---|
  | `G18` | GST 18% — standard | 18.00 | Racks, steel, coatings, fasteners |
  | `G12` | GST 12% — reduced | 12.00 | Corrugated packing sheet |
  | `G05` | GST 5% — reduced | 5.00 | Available, not used |
  | `G28` | GST 28% — luxury | 28.00 | Available, not used |
  | `GZ0` | GST 0% — export / zero-rated | 0.00 | Foreign customer |
  | `GEX` | GST exempt | 0.00 | Available, not used |

- **Expect** Six codes, all for country `IN`, all active.
- **Verify** A purchase order line carrying `G18` computes 18 % of the net price. An invoice with
  `GZ0` computes zero.
- **Why** A tax code is the rate a document line carries. One rate per line is the model; a GST
  invoice with two rates on one line cannot be expressed here.

**GAP A1.** No CGST/SGST split — a 18 % intra-state invoice posts one 18 % line, not 9 % + 9 %.
**GAP A2.** No place-of-supply decision; the tester chooses the code by hand.
**GAP A4.** No HSN/SAC on the material master. See 2.1 for the codes the guide quotes.
**GAP A5.** GSTIN is free text; the pattern is documentation, not validation.

## 0.9 Number ranges and document types

- **As** `in01.admin` · **Path** Configuration → Number ranges, Document types
- **Data** Journal interval `RF_BELEG / IN01 / GENERAL / year 0`, `JE` prefix, 1–999999, 6 digits.
  Document types delivered by the standard package; the journal type used here is `SA`, payroll
  posting `PR`, payroll payment `PY`.

- **Verify** A trial post as a journal takes a number of the form `IN01/2026/JE######`.
- **Why** A number range issues document numbers. The accounting interval is per company and is
  created here; the operational ranges come with the tenant.

## 0.10 Posting periods

- **As** `in01.admin` · **Path** Configuration → Posting periods (`/config/posting-periods`)
- **Data** Period variant `C001`, all account types open for periods 1–12 of FY2026. Special
  periods 13–16 open only for year-end adjustment.

- **Expect** The period list shows 12 ordinary periods ending with March 2027, and 4 special
  periods sharing March's window.
- **Verify** A posting dated 15 November 2026 lands in period 8. A posting dated 15 February 2027
  lands in period 11 **of fiscal year 2026** — the year that started in April 2026.
- **Why** The period decides whether a posting is allowed and which year's books it enters. The
  February test is the interesting one: an April–March year puts January to March in the
  *previous* fiscal year, which is where a naive calendar-year assumption breaks. (It did: see
  `06-bug-fix-log.md`.)

## 0.11 Account determination

- **As** `in01.admin` · **Path** Configuration → Account determination (`/config/account-determination`)
- **Data** Fifteen rows, all in chart `CA01`:

  | Event | Valuation class | G/L account |
  |---|---|---|
  | INVENTORY | RAW_INVENTORY | `120000` |
  | INVENTORY | SEMI_INVENTORY | `120100` |
  | INVENTORY | FINISHED_INVENTORY | `120200` |
  | INVENTORY | TRADE_INVENTORY | `120300` |
  | GR_IR_CLEARING | (blank) | `210000` |
  | PRICE_DIFFERENCE | (blank) | `410200` |
  | TAX | (blank) | `220000` |
  | SALES_REVENUE | (blank) | `300000` |
  | CONSUMPTION | RAW_INVENTORY | `410000` |
  | CONSUMPTION | SEMI_INVENTORY | `410000` |
  | CONSUMPTION | FINISHED_INVENTORY | `400000` |
  | CONSUMPTION | TRADE_INVENTORY | `400000` |
  | SALES_ISSUE | FINISHED_INVENTORY | `400000` |
  | SALES_ISSUE | TRADE_INVENTORY | `400000` |
  | PAYROLL_NET_PAY | (blank) | `251000` |

- **Verify** A goods receipt posts inventory to `120000` and GR/IR to `210000` without anyone
  naming an account on the document.
- **Why** Account determination is the rule that turns "a goods receipt of raw material" into "Dr
  inventory, Cr GR/IR". Without it every posting would have to name its own accounts, and the
  first clerk to type one wrong would break the tie-out.

## 0.12 Cost centres, profit centres, work centres

- **As** `in01.admin` · **Path** Configuration → Cost centres, Profit centres, Work centres
- **Data**

  | Cost centre | Name | Category |
  |---|---|---|
  | CC1000 | Cutting | Production |
  | CC1010 | Welding | Production |
  | CC1020 | Painting | Production |
  | CC2000 | Stores and warehousing | Service |
  | CC3000 | Purchase | Support |
  | CC4000 | Sales and marketing | Sales |
  | CC5000 | Administration | Administration |
  | CC5100 | Human resources | Administration |
  | CC6000 | Quality | Service |
  | CC7000 | Maintenance | Service |
  | CC8000 | Dispatch | Service |

  Profit centres: `PC1000` Manufactured racks, `PC2000` Traded components.
  Work centres at plant `1000`: `WC01` Cutting line (CC1000), `WC02` Welding station (CC1010),
  `WC03` Powder coating line (CC1020).

- **Verify** Every cost centre is valid from 1 April 2026 with no end date, and each work centre
  names its cost centre.
- **Why** A cost centre answers "who spent this". A work centre answers "which machine did the
  work", and every routing operation runs at one.

## 0.13 Holiday calendar

- **As** `in01.admin` · **Path** Configuration → Factory calendars (`/config/factory-calendars`)
- **Data** Holiday calendar `IM` — India, Maharashtra. Eight days: Ambedkar Jayanti (14 Apr 2026),
  Maharashtra Day (1 May), Independence Day (15 Aug), Gandhi Jayanti (2 Oct), Diwali–Laxmi Puja
  (8 Nov), Christmas (25 Dec), Republic Day (26 Jan 2027), Holi (5 Mar 2027).

- **Verify** All eight days appear, each with a description, inside the calendar's year range.
- **Why** The calendar is what leave and scheduling count against. A public holiday is not a
  working day, so absence on it is not an absence.

**GAP B10.** No service creates a *factory calendar* (the working-week grid); only its periods and
holidays can be maintained. The working-week calendar must be created on the screen by hand before
periods can be added to it.

---

# Phase 1 — HR

## 1.1 Organisational units

- **As** `in01.hr` · **Path** People → Organisation (`/people/organization`)
- **Data** Fourteen units, one root:

  ```
  CDI  Cairn Demo Industries
   ├── CDIMGT  Management
   ├── CDFIN   Finance
   ├── CDHR    Human Resources
   ├── CDPUR   Purchase
   ├── CDSTR   Stores
   ├── CDPRD   Production
   │    ├── CDCUT  Production — Cutting
   │    ├── CDWEL  Production — Welding
   │    └── CDPNT  Production — Painting
   ├── CDQUA   Quality
   ├── CDMNT   Maintenance
   ├── CDSAL   Sales
   └── CDDSP   Dispatch
  ```

- **Verify** The org chart shows one root and every unit has a parent except `CDI`.
- **Why** The org chart is the shape of the company. Positions hang off these units, and authority
  charts read the hierarchy rather than a list of names.

## 1.2 Jobs and positions

- **As** `in01.hr` · **Path** People → Organisation, job and position tabs
- **Data** Twenty jobs (Managing Director, Finance Manager, Accounts Executive, HR Manager, HR
  Executive, Purchase Manager, Buyer, Stores Supervisor, Storekeeper, Production Manager, Shift
  Supervisor, Machine Operator, Welder, Helper, Quality Manager, QC Inspector, Maintenance
  Technician, Sales Manager, Sales Executive, Dispatch Clerk). Twenty-eight positions, each with
  a job, an org unit, a cost centre and a tier.

  A sample of the reporting chart:

  | Position | Title | Reports to | Cost centre | Tier |
  |---|---|---|---|---|
  | P1000 | Managing Director | — | CC5000 | 9 |
  | P5000 | Finance Manager | P1000 | CC5000 | 6 |
  | P5100 | Accounts Executive — Payables | P5000 | CC5000 | 2 |
  | P5110 | Accounts Executive — Receivables | P5000 | CC5000 | 2 |
  | P5120 | Payroll Officer | P5000 | CC5000 | 2 |
  | P5200 | Costing Controller | P5000 | CC5000 | 4 |
  | P4000 | Production Manager | P1000 | CC1000 | 6 |
  | P4100 | Shift Supervisor — Cutting | P4000 | CC1000 | 3 |
  | P4110 | Shift Supervisor — Welding | P4000 | CC1010 | 3 |
  | P4210 | Welder | P4110 | CC1010 | 1 |
  | P4230 | Helper — Production | P4000 | CC1000 | 1 |
  | P6000 | Quality Manager | P1000 | CC6000 | 6 |
  | P6100 | QC Inspector | P6000 | CC6000 | 2 |
  | P8000 | Sales Manager | P1000 | CC4000 | 6 |
  | P8100 | Sales Executive | P8000 | CC4000 | 2 |

- **Verify** The authority chart shows the Managing Director at the top and every other position
  with a reporting line.
- **Why** A position is a seat in the org chart; a person fills it. Tier decides who may approve
  whom — an HR officer (tier 4) can approve a supervisor (tier 3) but not a manager (tier 6).

## 1.3 Employees — 52 people across every department

- **As** `in01.hr` · **Path** People → Employees (`/people/employees`)
- **Data** 52 employees, personnel numbers `10000001`–`10000052`. A representative slice:

  | Personnel no. | Name | Position | Department | Joined | Grade | Base (₹/month) |
  |---|---|---|---|---|---|---|
  | 10000001 | Rajesh Deshpande | Managing Director | Management | 2011-06-01 | Management | 1,80,000 |
  | 10000002 | Sunita Kulkarni | Finance Manager | Finance | 2013-04-15 | Management | 95,000 |
  | 10000003 | Amit Joshi | Accounts Exec. — Payables | Finance | 2016-08-01 | Staff | 38,000 |
  | 10000004 | Priya Nair | Accounts Exec. — Receivables | Finance | 2017-02-13 | Staff | 36,000 |
  | 10000007 | Vikram Shinde | HR Manager | HR | 2014-07-14 | Management | 78,000 |
  | 10000009 | Sandeep Bhosale | Purchase Manager | Purchase | 2013-10-21 | Management | 72,000 |
  | 10000010 | Kavita Pawar | Buyer | Purchase | 2017-09-11 | Staff | 34,000 |
  | 10000012 | Sanjay Gaikwad | Storekeeper — RM | Stores | 2016-01-18 | Skilled worker | 21,000 |
  | 10000014 | Mahesh Chavan | Production Manager | Production | 2012-02-20 | Management | 85,000 |
  | 10000015 | Santosh Waghmare | Shift Supervisor — Cutting | Production | 2015-06-15 | Staff | 40,000 |
  | 10000020 | Prakash Sawant | Welder | Welding | 2018-08-20 | Skilled worker | 20,000 |
  | 10000025 | Dattatray Jagtap | Helper | Production | 2022-09-12 | Unskilled | 16,000 |
  | 10000028 | Snehal Deshmukh | Quality Manager | Quality | 2014-11-03 | Management | 70,000 |
  | 10000029 | Arun Kulkarni | QC Inspector | Quality | 2018-04-23 | Staff | 33,000 |
  | 10000031 | Yogesh Patil | Maintenance Fitter | Maintenance | 2016-10-10 | Skilled worker | 24,000 |
  | 10000033 | Rahul Bhise | Sales Manager | Sales | 2013-01-14 | Management | 80,000 |
  | 10000034 | Neha Kulkarni | Sales Executive | Sales | 2018-06-04 | Staff | 35,000 |
  | 10000037 | Akash Pawar | Dispatch Clerk | Dispatch | 2019-09-02 | Skilled worker | 22,000 |
  | 10000051 | Anita Gaikwad | QC Inspector | Quality | 2019-04-29 | Staff | 30,000 |

  The full 52 are in `fixtures/company/IN01/company.json` under `employees`, each with a date of
  birth, joining date, grade, salary structure and base amount.

- **Verify** 52 employees, each with one active position assignment and one cost centre.
- **Why** The employee master is the person; the assignment is where they sit and what they are
  paid from. The two are separate because a person can move post without being re-hired.

**Note.** `in01.hr`, `in01.admin` and the other accounts are each linked to one of these employees,
so sign-in and person are the same human.

## 1.4 Roles and segregation of duties

- **As** `in01.owner` · **Path** Platform → Roles (`/platform/roles`)
- **Data** Twelve custom roles. Each names the capabilities it holds; a custom role cannot hold a
  wildcard, so the installer expands each pattern against the catalogue:

  | Role | What it may do | What it deliberately cannot |
  |---|---|---|
  | `DEMO_BUYER` | Requisitions, purchase orders, supplier negotiation | Post to FI, move stock |
  | `DEMO_PLANNER` | MRP, planned orders, production orders | Post FI, receive goods |
  | `DEMO_PROD_CLERK` | Confirmations, component issue, FG receipt | Raise orders, post FI |
  | `DEMO_WH_CLERK_MFG` | All stock movements at plant 1000, delivery PGI | Raise orders, post FI |
  | `DEMO_WH_CLERK_DIST` | All stock movements at plant 2000 | Anything at plant 1000 |
  | `DEMO_SALES_CLERK` | Quotations, orders, deliveries, billing | Move stock, post FI |
  | `DEMO_ACCOUNTANT` | General ledger, AP, AR, banking | Release what it parks |
  | `DEMO_CONTROLLER` | Costing, profitability, internal orders, settlement, **releases** | Enter documents |
  | `DEMO_AUDITOR` | Read-only, under a time-boxed grant | Any write |
  | `DEMO_HR_CLERK` | Employee data for its plant; requests hires | Approve hires |
  | `DEMO_HR_OFFICER` | Employee data company-wide, tiers, approves lower tiers | Post FI |
  | `DEMO_QUALITY` | Inspection lots, results, usage decisions | Receive or issue goods |

- **Verify** Sign in as `in01.buyer` and attempt to post a supplier invoice: refused. Sign in as
  `in01.sales` and attempt a goods issue: refused.
- **Why** Segregation of duties is the control that stops one person raising, receiving, paying
  and posting the same transaction. Each role here is one job, not one person's convenience.

**Verify one more:** `in01.storekeeper` reaches plant 1000 only; `in01.dispatch` plant 2000 only.
A movement at the wrong plant is refused for want of a scope, which is the point of giving a
scope rather than none.

## 1.5 Payroll master data

- **As** `in01.admin` · **Path** Configuration → Pay components (`/config/pay-components`),
  People → Salary structures (`/people/salary-structures`)

- **Data — earning components**

  | Code | Name | Debit | Credit |
  |---|---|---|---|
  | BASIC | Basic salary | `500000` | — |
  | HRA | House rent allowance | `500000` | — |
  | CONVEY | Conveyance allowance | `500000` | — |
  | SPECIAL | Special allowance | `500000` | — |
  | OT | Overtime | `500300` | — |

  **Statutory deductions and contributions**

  | Code | Name | Kind | Employee/employer | Debit | Credit |
  |---|---|---|---|---|---|
  | PFEE | Provident fund — employee 12% | Deduction | Employee | — | `251100` |
  | PFER | Provident fund — employer 12% | Employer contribution | Employer | `500400` | `251100` |
  | ESIEE | ESI — employee 0.75% | Deduction | Employee | — | `251200` |
  | ESIER | ESI — employer 3.25% | Employer contribution | Employer | `500500` | `251200` |
  | PTAX | Professional tax — Maharashtra | Deduction | Employee | — | `251300` |
  | TDS192 | TDS u/s 192 — salary | Deduction | Employee | — | `251400` |

  Every component is mapped to chart `CA01` with its cost receiver: earnings and employer
  contributions charge the employee's assignment (their cost centre), deductions charge nothing.

  **Two salary structures**

  | | MGMT (management and staff) | WORKER (shop floor) |
  |---|---|---|
  | BASIC | 100 % of base | 100 % of base |
  | HRA | 40 % of base | 20 % of base |
  | CONVEY | ₹1,600 fixed | ₹800 fixed |
  | PFEE / PFER | 12 % | 12 % |
  | ESIEE / ESIER | not in the structure (added per employee where eligible) | 0.75 % / 3.25 % in the structure |
  | PTAX | ₹200 fixed | ₹200 fixed |
  | TDS192 | ₹0 in the structure (set per employee) | — |

  Every employee has a structure assignment valid from 1 April 2026 with a base amount.

- **Verify** The structure view shows each component and its rule, and every employee has an
  assignment.
- **Why** A salary structure is the recipe for one grade's pay. The base amount is the only thing
  that changes between people on the same grade, which is why the structure is defined once.

**GAP B1 — read this before trusting any payroll number.** Nothing statutory ships (DV-001). PF,
ESI, PT and TDS are **configured approximations**, not a compliance computation. Specifically:

- **PF** is 12 % of the structure base. It does not cap at the statutory wage ceiling of ₹15,000.
- **ESI** is 0.75 %/3.25 % applied only to the employees the fixture marks as under the ₹21,000
  ceiling. The engine has no ceiling rule, so eligibility is data, not a calculation.
- **Professional tax** is a flat ₹200. Maharashtra's slabs cannot be expressed.
- **TDS u/s 192** is a **pre-calculated fixed monthly amount per employee** in the fixture. The
  product cannot compute it.

**GAP B2.** A rule is a fixed amount or a percentage of the base, with no condition — no ceiling,
no slab, no formula. This is the single limit that makes statutory payroll impossible in any
country, not only India.

## 1.6 Leave types, quotas and record types

- **As** `in01.hr` · **Path** Configuration → Time types (`/config/time-types`),
  People → Time and leave (`/people/time-leave`)

- **Data — leave types**

  | Code | Name | Reduces quota | Paid |
  |---|---|---|---|
  | CL | Casual leave | Yes | Yes |
  | SL | Sick leave | Yes | Yes |
  | EL | Earned / privilege leave | Yes | Yes |
  | LOP | Loss of pay | No | No |

  **Opening quotas**, per employee for calendar year 2026: CL 12 days, SL 8 days, EL 15 days —
  156 quota records (52 employees × 3 quota-bearing types).

  **Employee record types** — four, each a configured set of fields:

  | Type | Fields |
  |---|---|
  | PAN | PAN (text) |
  | UAN | UAN (text) |
  | ESIC | ESIC No. (text) |
  | BANK | Bank (text), Account number (text) |

- **Verify** Open one employee's leave balances: CL 12, SL 8, EL 15, and no LOP quota (it does not
  accrue).
- **Why** A quota is the balance an employee may draw on. A record type is how the product holds
  data it does not model as a column — PAN, UAN and bank details are the tenant's own fields, not
  the product's.

**GAP B7.** The four identifiers are unvalidated text. A PAN typed as `ABC` saves.
**GAP B6.** No daily-wage master; a day-rate worker is a monthly base divided by days.

---

# Phase 2 — Master data

## 2.1 Materials

- **As** `in01.admin` · **Path** Inventory → Materials (`/inventory/materials`)
- **Data** Thirteen materials. HSN is shown for the guide only (**GAP A4** — the product has no
  HSN field):

  | Material | Description | Type | Unit | Price (₹) | Control | GST | HSN |
  |---|---|---|---|---|---|---|---|
  | RM-MSROD-05 | MS iron rod 5mm | RAW | KG | 62.50 | Moving avg | G18 | 72149990 |
  | RM-MSANG-4040 | MS angle 40×40×5mm | RAW | KG | 64.00 | Moving avg | G18 | 72161000 |
  | RM-CRCA-12 | CRCA sheet 1.2mm | RAW | KG | 68.75 | Moving avg | G18 | 72091790 |
  | RM-MSPIPE-1IN | MS square pipe 25×25×2mm | RAW | KG | 66.20 | Moving avg | G18 | 73063000 |
  | CON-HEXBOLT-M10 | Hex bolt M10×50 zinc plated | RAW | PC | 9.40 | Moving avg | G18 | 73181500 |
  | CON-ROXIDE-20L | Red oxide primer 20L | RAW | L | 295.00 | Moving avg | G18 | 32089029 |
  | CON-POWDER-R7035 | Powder coat RAL 7035 | RAW | KG | 385.00 | Moving avg | G18 | 39073010 |
  | CON-PACK-CORR | Corrugated packing sheet | RAW | PC | 62.00 | Moving avg | G12 | 48191010 |
  | SF-WELDFRAME | Welded frame assembly, cut | SEMI | PC | 1,480.00 | Standard | G18 | 73089090 |
  | FG-RACK-2000 | Heavy duty storage rack 2000×1000×450 | FIN | PC | 4,250.00 | Standard | G18 | 73089090 |
  | FG-RACK-1500 | Medium duty storage rack 1500×900×400 | FIN | PC | 3,150.00 | Standard | G18 | 73089090 |
  | FG-SHELF-1200 | Slotted angle shelf 1200×600×300 | FIN | PC | 1,980.00 | Standard | G18 | 73089090 |
  | TRD-CASTOR-100 | Castor wheel 100mm, swivel | TRAD | PC | 420.00 | Moving avg | G18 | 83022000 |

  Every material carries the views it needs at each plant it is kept at: MRP, purchasing (bought
  materials), accounting (valuation class and price control) and sales (sellable items).

- **Verify** Open `FG-RACK-2000`. It is kept at plants `1000` and `2000`, valued at standard
  ₹4,250.00, and has a sales view.
- **Why** A material is not usable at a plant until its views exist there: the MRP view says how
  it is replenished, the purchasing view says who buys it, the accounting view what it is worth.

## 2.2 Bills of material

- **As** `in01.admin` · **Path** Production → Bills of material (`/production/boms`)
- **Data** Four BOMs, usage `P` (production), all at plant `1000`:

  **SF-WELDFRAME** — base 1 PC
  | Item | Component | Qty | Unit |
  |---|---|---|---|
  | 0010 | RM-MSROD-05 | 8.5 | KG |
  | 0020 | RM-MSANG-4040 | 6.2 | KG |
  | 0030 | RM-CRCA-12 | 2.4 | KG |
  | 0040 | CON-HEXBOLT-M10 | 12 | PC |

  **FG-RACK-2000** — base 10 PC
  | Item | Component | Qty | Unit |
  |---|---|---|---|
  | 0010 | SF-WELDFRAME | 10 | PC |
  | 0020 | RM-MSPIPE-1IN | 40 | KG |
  | 0030 | CON-HEXBOLT-M10 | 240 | PC |
  | 0040 | CON-POWDER-R7035 | 18 | KG |
  | 0050 | CON-ROXIDE-20L | 3.5 | L |
  | 0060 | CON-PACK-CORR | 20 | PC |

  **FG-RACK-1500** — base 10 PC: SF-WELDFRAME 8 PC, RM-MSPIPE-1IN 30 KG,
  CON-HEXBOLT-M10 180 PC, CON-POWDER-R7035 13 KG, CON-PACK-CORR 10 PC.

  **FG-SHELF-1200** — base 10 PC: RM-CRCA-12 11 KG, RM-MSANG-4040 20 KG,
  CON-HEXBOLT-M10 80 PC, CON-POWDER-R7035 9 KG.

- **Verify** The BOM explosion of `FG-RACK-2000` shows two levels: the rack uses frames, and a
  frame uses rod, angle, sheet and bolts.
- **Why** A BOM is the recipe. It is what makes MRP able to say "to build 100 racks I need 400 kg
  of pipe" without anyone counting by hand, and it is what a production order issues components
  against.

**Note.** Component quantities are validated against their **own** unit's decimal places. A `PC`
quantity has no decimals, so "0.75 PC" is refused — which is correct, since a rack frame is not
delivered in fractions.

## 2.3 Routings and work centres

- **As** `in01.admin` · **Path** Production → Routings (`/production/routings`)
- **Data** Three routings, task-list type `N`, usage `1`, base 1 PC:

  **FG-RACK-2000**
  | Op | Work centre | Description | Hours | Control key |
  |---|---|---|---|---|
  | 0010 | WC01 | Cutting | 0.75 | PP01 |
  | 0020 | WC02 | Welding | 1.40 | PP01 |
  | 0030 | WC03 | Powder coating | 0.55 | PP01 |

  **FG-RACK-1500**: WC01 0.55 h, WC02 1.05 h, WC03 0.40 h.
  **FG-SHELF-1200**: WC01 0.35 h, WC03 0.30 h.

- **Verify** Each routing names work centres that exist at plant `1000`, and control key `PP01`
  allows confirmation.
- **Why** A routing is the sequence of operations. Control key `PP01` is the flag that lets an
  operation be confirmed on the shop floor; without it a confirmation is refused.

**GAP C2.** There is no inspection plan. Inspection is per lot, configured at the lot.

## 2.4 Vendors

- **As** `in01.admin` · **Path** Foundation → Business partners (`/config/business-partners`),
  supplier company and purchasing views
- **Data** Six vendors, five domestic and one foreign:

  | Vendor | Name | City | State | GSTIN | Terms | Scope |
  |---|---|---|---|---|---|---|
  | SUP-1000 | Deccan Steel Traders Pvt Ltd | Pune | MH (27) | 27AABCD5678E1Z2 | NET30 | Intra-state |
  | SUP-2000 | Sahyadri Fasteners | Satara | MH (27) | 27AABCS9012F1Z5 | NET30 | Intra-state |
  | SUP-3000 | Vidarbha Coatings and Chemicals | Nagpur | MH (27) | 27AABCV3456G1Z8 | NET30 | Intra-state |
  | SUP-4000 | Gujarat Steel Corporation | Ahmedabad | GJ (24) | 24AABCG7890H1Z3 | NET30 | **Inter-state** |
  | SUP-5000 | Karnataka Packaging Supplies | Bengaluru | KA (29) | 29AABCK2345J1Z7 | NET30 | **Inter-state** |
  | SUP-6000 | Zhejiang Precision Fasteners Co Ltd | Ningbo, CN | — | — | NET60 | **Foreign, USD** |

  Each has a company-code view (reconciliation account `200000`), a purchasing view (purchasing
  group `001`, order currency, incoterms) and an info record per material it supplies with a
  price and a lead time.

- **Verify** `SUP-4000` orders in INR (it is domestic, in another state); `SUP-6000` orders in
  **USD** with FOB Ningbo and a 45-day lead time.
- **Why** The supplier's state is what decides CGST+SGST versus IGST in a localised system. Here
  it decides only which GST code a tester should pick by hand — the product cannot check the
  choice (**GAP A2**).

**GAP C4.** The foreign vendor's purchase runs PO → GR → invoice in USD with exchange
differences. **Customs duty, Bill of Entry and import IGST do not exist in the product** and are
shown as TARGET (GAP) wherever they belong.

## 2.5 Customers

- **As** `in01.admin` · **Path** Foundation → Business partners, customer company, sales-area and
  credit views
- **Data** Six customers:

  | Customer | Name | City | State | GSTIN | Terms | Credit limit (₹) |
  |---|---|---|---|---|---|---|
  | CUS-1000 | Bhosari Hardware Mart | Pune | MH (27) | 27AABCB1111K1Z4 | NET30 | 15,00,000 |
  | CUS-2000 | Maharashtra Warehouse Solutions Pvt Ltd | Mumbai | MH (27) | 27AABCM2222L1Z9 | NET30 | 25,00,000 |
  | CUS-3000 | Nashik Agro Storage | Nashik | MH (27) | 27AABCN3333M1Z6 | NET15 | 8,00,000 |
  | CUS-4000 | Rajasthan Steel Racks | Jaipur | RJ (08) | 08AABCR4444N1Z1 | NET30 | 12,00,000 |
  | CUS-5000 | Coimbatore Industrial Supplies | Coimbatore | TN (33) | 33AABCC5555P1Z8 | NET30 | 9,00,000 |
  | CUS-6000 | Souq Trading LLC | Dubai, AE | — | — | NET30 | 18,00,000 (USD sales) |

  Each has a company-code view (reconciliation account `110000`), a complete sales area
  `1000/01/01` with delivering plant `2000` and pricing procedure `1`, and a credit record in
  credit control area `0001`.

- **Verify** `CUS-4000` is a complete sales area (no INCOMPLETE status) and has a credit limit of
  ₹12,00,000. `CUS-6000` is foreign with no GSTIN.
- **Why** A customer is only orderable once its sales area is complete — a sales area without a
  delivering plant and a pricing procedure is refused at order entry, not warned about.

## 2.6 Prices

- **As** `in01.admin` · **Path** Sales → Conditions (`/sales/conditions`), Purchasing → Info
  records (`/purchasing/info-record`)
- **Data** Selling prices per material at the distributor level (PL02):

  | Material | List (₹) | Distributor (₹) |
  |---|---|---|
  | FG-RACK-2000 | 4,850.00 | 4,450.00 |
  | FG-RACK-1500 | 3,650.00 | 3,320.00 |
  | FG-SHELF-1200 | 2,250.00 | 2,050.00 |
  | TRD-CASTOR-100 | 520.00 | 470.00 |

  Purchase info-record prices match the material standard/moving-average prices in 2.1.

- **Verify** A sales order for `FG-RACK-2000` for `CUS-1000` defaults to ₹4,450.00 before GST.
- **Why** A price is a condition record: it says "this customer, this material, this period, this
  amount". The order reads it rather than the clerk typing it, which is how a price list stays
  consistent.

---

# Phase 3 — One month of transactions

> **Not yet built as a dataset.** `--with-transactions` is refused by name (**GAP D1**). The
> steps below are the scenario the automated tests must eventually drive; each names the role,
> the screen, the data and the expected journal, so the work is specified even though the data is
> not installed. The **Verify** lines are what an E2E test would assert.

## 3.1 Procure to pay (P2P)

### 3.1.1 Purchase requisition
- **As** `in01.buyer` · **Path** Purchasing → Purchase requisitions
- **Data**

  | Field | Value |
  |---|---|
  | Material | `RM-MSROD-05` MS iron rod 5mm |
  | Quantity | **500 KG** |
  | Plant | `1000` |
  | Required date | **25 Nov 2026** |
  | Requisition date | **18 Nov 2026** |
  | Account assignment | Cost centre **CC1000** (Cutting) |
  | Estimated price | ₹62.50/KG → **₹31,250.00** |

- **Expect** A requisition with one item, released — the value is below the release strategy's
  threshold, so one release clears it.
- **Journal** None — a requisition is a request, not a commitment.
- **Verify** The requisition appears in the purchase-order conversion list.

### 3.1.2 Purchase order
- **As** `in01.buyer` · **Path** Purchasing → Purchase orders
- **Data**

  | Field | Value |
  |---|---|
  | Vendor | `SUP-1000` Deccan Steel Traders Pvt Ltd, Pune, GSTIN `27AABCD5678E1Z2` |
  | Purchasing org / group | `1000` / `001` |
  | Company code | `IN01` |
  | Material | `RM-MSROD-05` |
  | Quantity / unit | **500 KG** |
  | Net price | **₹62.50** per KG → ₹31,250.00 |
  | GST code / amount | `G18` / **₹5,625.00** |
  | Gross | **₹36,875.00** |
  | Order date | **19 Nov 2026** |
  | Delivery date | **24 Nov 2026** |

- **Expect** Order total ₹31,250.00 + 18 % GST ₹5,625.00 = **₹36,875.00**; the order is released.
- **Journal** None — a commitment, not a posting.
- **Verify** The order's tax line shows 18 % and ₹5,625.00, and the order status is released.

### 3.1.3 Goods receipt
- **As** `in01.storekeeper` · **Path** Inventory → Goods receipt
- **Data**

  | Field | Value |
  |---|---|
  | Purchase order | The order from 3.1.2 |
  | Material | `RM-MSROD-05` |
  | Quantity | **500 KG** |
  | Plant / storage location | `1000` / `0001` Raw materials store |
  | Posting date | **24 Nov 2026** (period 8, FY 2026) |
  | Movement type | 101 (goods receipt against a purchase order) |

- **Expect** Stock rises by 500 KG at ₹62.50; the PO's received quantity updates to 500.
- **Journal** — the entry the product posts:

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `120000` Raw materials inventory | 31,250.00 |
  | Cr | `210000` Goods received not invoiced (GR/IR) | 31,250.00 |

- **TARGET (GAP A3)** GST-compliant systems would not yet book input credit here; the credit
  arises with the invoice below, and against `140100` CGST / `140200` SGST, not a single account.
- **Verify** GR/IR (`210000`) stands at ₹31,250.00 credit.
- **Why** The goods have arrived but no invoice has. Booking the stock now and the liability to
  "goods received not invoiced" keeps the stock right while remembering we owe for it.

### 3.1.4 Invoice verification, with GST input
- **As** `in01.ap` · **Path** Purchasing → Invoice verification
- **Data**

  | Field | Value |
  |---|---|
  | Supplier invoice number | `DST/2026/1187` |
  | Invoice date | **25 Nov 2026** |
  | Posting date | **25 Nov 2026** (period 8, FY 2026) |
  | Net amount | ₹31,250.00 |
  | GST code / amount | `G18` / **₹5,625.00** |
  | Gross | **₹36,875.00** |
  | Reference | The purchase order from 3.1.2 |
- **Expect** A three-way match: invoice, order and receipt agree, so no block.
- **Journal**

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `210000` GR/IR (cleared) | 31,250.00 |
  | Dr | `220000` Output tax payable *(the product's single TAX account)* | 5,625.00 |
  | Cr | `200000` Trade payables — SUP-1000 | 36,875.00 |

- **TARGET (GAP A3, A1)** A localised system posts the ₹5,625.00 input credit as **Dr `140100`
  CGST 2,812.50 / Dr `140200` SGST 2,812.50**, not to a liability account. The product has one
  `TAX` account for both sides, so a purchase debits `220000` "output tax payable" — arithmetically
  it nets, but the balance sheet reads wrong.
- **Verify** GR/IR is back to zero for this order. The supplier's open item is ₹36,875.00.
- **Why** The invoice replaces the estimate with the real liability. GR/IR clears because the
  invoice and the receipt now agree.

### 3.1.5 Payment, with TDS (**GAP A7**)
- **As** `in01.ap` · **Path** Finance → Outgoing payment
- **Data**

  | Field | Value |
  |---|---|
  | Payee | `SUP-1000` Deccan Steel Traders Pvt Ltd |
  | Amount | **₹36,875.00** |
  | Payment date | **30 Nov 2026** (period 8, FY 2026) |
  | Method | NEFT |
  | Bank account | `101000` Bank — current account |
  | Invoices cleared | `DST/2026/1187` |
- **Journal**

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `200000` Trade payables — SUP-1000 | 36,875.00 |
  | Cr | `101000` Bank — current account | 36,875.00 |

- **TARGET (GAP A7)** For a contract payment u/s 194C a localised system would deduct TDS and
  post **Dr `200000` 36,875.00 / Cr `101000` 36,510.00 / Cr `221100` TDS payable 365.00** (1 % for
  an individual/HUF contractor, 2 % for a company; assume 1 % here). **The product cannot do
  this**: no withholding engine exists. The guide shows the payment without TDS, and the
  reconciliation checklist marks the TDS line **not verifiable — GAP**.
- **Verify** The supplier's open item is cleared; the bank is ₹36,875.00 lower.
- **Why** Paying the invoice settles the liability. TDS is a statutory deduction the payer makes
  on the government's behalf — which is exactly the piece that does not exist here.

### 3.1.6 One QM rejection and vendor return
- **As** `in01.qc` then `in01.storekeeper` · **Path** Quality → Inspection lots
- **Data** A second receipt of 200 kg `RM-CRCA-12` from `SUP-4000` is received into inspection
  stock. The inspector records a thickness result out of tolerance and takes a usage decision of
  **reject**.
- **Expect** The lot is rejected; the goods move to blocked stock (movement 323).
- **Journal** No value change on rejection — the stock is still there, just not usable.

  The return (movement `122`) then posts:

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `210000` GR/IR | 13,750.00 |
  | Cr | `120000` Raw materials inventory | 13,750.00 |

- **Verify** Rejected stock is zero; the vendor's balance carries a debit for the returned goods.
- **Why** Goods that fail inspection are still ours until returned. The rejection records the
  decision; the return movement sends them back and reverses the receipt's value.

## 3.2 Production

### 3.2.1 Demand and MRP
- **As** `in01.planner` · **Path** Production → MRP run
- **Data**

  | Field | Value |
  |---|---|
  | Plant | `1000` |
  | Requirement source | The sales order from 3.3.2 — 40 `FG-RACK-2000`, requested **28 Nov 2026** |
  | Run date | **20 Nov 2026** |
  | Planning horizon | 30 days |
  | Processing key | Net change (or regenerative — either is fine for one run) |

- **Expect** MRP proposes a production order for 40 `FG-RACK-2000` and dependent requirements for
  `SF-WELDFRAME` (40 PC), `RM-MSPIPE-1IN` (160 KG), `CON-HEXBOLT-M10` (960 PC),
  `CON-POWDER-R7035` (72 KG), `CON-ROXIDE-20L` (14 L) and `CON-PACK-CORR` (80 PC).
- **Journal** None — MRP plans, it does not post.
- **Verify** The MRP exception monitor shows no missing-master exception for any component, and the
  planned order carries quantity 40.
- **Why** MRP reads the demand, explodes the BOM and proposes what to make or buy. It is the step
  that turns a customer's order into work the factory can start.

### 3.2.2 Production order and goods issue
- **As** `in01.planner` raises and releases the order; `in01.supervisor` issues the components
  · **Path** Production → Orders (`/production/orders`), then Inventory → Goods issue
- **Data**

  | Field | Value |
  |---|---|
  | Material | `FG-RACK-2000` |
  | Plant | `1000` |
  | Order quantity | **40 PC** |
  | Basic start | **21 Nov 2026** |
  | Basic finish | **27 Nov 2026** |
  | Order type | The production order type the standard package delivers (e.g. `PP01`) |

  Component issue, at the BOM base of **10 PC** scaled to 40 (×4):

  | Item | Component | Quantity to issue | Unit |
  |---|---|---|---|
  | 0010 | `SF-WELDFRAME` | 40 | PC |
  | 0020 | `RM-MSPIPE-1IN` | 160 | KG |
  | 0030 | `CON-HEXBOLT-M10` | 960 | PC |
  | 0040 | `CON-POWDER-R7035` | 72 | KG |
  | 0050 | `CON-ROXIDE-20L` | 14 | L |
  | 0060 | `CON-PACK-CORR` | 80 | PC |

- **Journal** Component issue, valued at the materials' own values. `SF-WELDFRAME` is a
  semi-finished material carried at a **standard price of ₹1,480.00**, so the issue values it at
  that standard, not at its own components:

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `410000` Raw material consumption | **1,15,626.00** |
  | Cr | `120000` Raw materials inventory | 1,15,626.00 |

  The credit is split across the items it drew from:
  `SF-WELDFRAME` 40 × 1,480.00 = 59,200.00 · `RM-MSPIPE-1IN` 160 × 66.20 = 10,592.00 ·
  `CON-HEXBOLT-M10` 960 × 9.40 = 9,024.00 · `CON-POWDER-R7035` 72 × 385.00 = 27,720.00 ·
  `CON-ROXIDE-20L` 14 × 295.00 = 4,130.00 · `CON-PACK-CORR` 80 × 62.00 = 4,960.00.

- **Verify** Stock falls by exactly those quantities in plant `1000`. `410000` carries a debit of
  ₹1,15,626.00 against this order.
- **Why** The order takes materials out of stock and into work in progress. The consumption
  account is where the cost of those materials goes.

### 3.2.3 Confirmation
- **As** `in01.supervisor` · **Path** Production → Order confirmation (`CO15`-equivalent)
- **Data**

  | Op | Work centre | Yield | Scrap | Confirmation date |
  |---|---|---|---|---|
  | 0010 Cutting | `WC01` | 40 PC | 0 | **25 Nov 2026** |
  | 0020 Welding | `WC02` | 40 PC | 0 | **26 Nov 2026** |
  | 0030 Powder coating | `WC03` | 40 PC | 0 | **27 Nov 2026** |

  Posting date on the confirmation: **27 Nov 2026** (period 8, FY 2026).

- **Journal** **None.** A confirmation records that the work happened, not what it cost
  (**GAP C5**). Activity cost is not posted at confirmation in this product.
- **Verify** The order's confirmed quantity is 40 on each operation, and its status shows the
  operations confirmed.
- **Why** A confirmation is the shop floor's statement of output. In a system with activity
  costing it would also debit the order and credit the cost centres for the hours; here it does
  not, so conversion cost appears later as a balance on the consumption account.

### 3.2.4 FG receipt and inspection
- **As** `in01.supervisor` (receipt) then `in01.qc` (inspection) · **Path** Inventory → Goods
  receipt (production), Quality → Inspection lots
- **Data**

  | Field | Value |
  |---|---|
  | Material | `FG-RACK-2000` |
  | Quantity | **40 PC** |
  | Plant / storage location | `1000` / `0003` Finished goods warehouse |
  | Posting date | **27 Nov 2026** |
  | Movement type | The production receipt movement (101 for the order) |
  | Inspection | Create a lot, record the results, take a usage decision of **accept** |

- **Journal** Receipt at standard, at ₹4,250.00 each:

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `120200` Finished goods inventory | **1,70,000.00** |
  | Cr | `410000` Raw material consumption *(production output offset)* | 1,70,000.00 |

- **Verify** Finished goods stock rises by 40 at ₹4,250.00 each. `410000` now carries
  **₹1,70,000.00 credit − ₹1,15,626.00 debit = ₹54,374.00 credit**, which is the conversion
  "residue" the next step discusses.
- **Why** The receipt puts the finished racks into stock at their standard value and offsets the
  consumption account, which is where production cost has been accumulating.

### 3.2.5 Settlement and variance — **TARGET (GAP C1)**
- **As** `in01.controller` · **Path** Production → Order settlement (`KO88`-equivalent)
- **Data**

  | Field | Value |
  |---|---|
  | Order | The production order from 3.2.2 (40 `FG-RACK-2000`) |
  | Settlement period | **8** (November 2026) |
  | Fiscal year | **2026** |
  | Test run | Start with **test run** on, then repeat with it off |

- **Expect** The screen **calculates and displays** the order's balance; it **posts nothing**.
  `productionOrderSettlementPosting()` returns `posts: false`. WIP at period end and variance
  splitting are deferred (DV-003, DV-004).
- **TARGET (GAP C1)** A localised system would post the variance to the order's receiver. On the
  figures above, the order's actual charge is ₹1,15,626.00 and its credit on receipt is
  ₹1,70,000.00, so the residue is a **₹54,374.00 credit** on `410000`. A settlement would move it
  to a variance account:

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `410000` Raw material consumption (clear the order) | 54,374.00 |
  | Cr | `410100` Production variance | 54,374.00 |

  and, where WIP stands at period end, capitalise it to a WIP account against a WIP-change P&L
  line. Neither posting exists here.
- **Verify — not possible yet.** The reconciliation checklist marks "production variance
  explained" as **not testable — GAP C1**. What *is* visible and checkable is the residue: after
  3.2.4, `410000` carries a **₹54,374.00 credit** for this order, and that figure is the number a
  settlement would have cleared.
- **Why** Settlement is how a production order hands its cost to the thing it was made for.
  Without it the order's balance has nowhere to go, and the consumption account carries the
  difference.

## 3.3 Order to cash (O2C)

### 3.3.1 Quotation
- **As** `in01.sales` · **Path** Sales → Quotations (`/sales/quotations`)
- **Data**

  | Field | Value |
  |---|---|
  | Customer | `CUS-2000` Maharashtra Warehouse Solutions Pvt Ltd |
  | Sales area | `1000` / `01` / `01` |
  | Material | `FG-RACK-2000` |
  | Quantity | **40 PC** |
  | Price | ₹4,450.00 each (the distributor level, read from the condition record) |
  | Net value | **₹1,78,000.00** before GST |
  | Valid from | **20 Nov 2026** |
  | Valid to | **20 Dec 2026** (30 days) |

- **Expect** The quotation prices at ₹4,450.00 from the condition record. Typing a price is not
  what this step tests.
- **Journal** None — a quotation is an offer, not a posting.
- **Verify** The line price is ₹4,450.00 and the net value ₹1,78,000.00, with no GST on a
  quotation.
- **Why** A quotation tells the customer what the goods would cost. The price comes from the
  condition record so that two clerks quote the same customer the same figure.

### 3.3.2 Sales order (credit and pricing)
- **As** `in01.sales` · **Path** Sales → Orders (`/sales/orders`)
- **Data**

  | Field | Value |
  |---|---|
  | Customer | `CUS-2000` |
  | Reference | The quotation from 3.3.1, raised to an order |
  | Material / quantity | `FG-RACK-2000`, **40 PC** |
  | Price | ₹4,450.00 → net **₹1,78,000.00** |
  | GST code | `G18` → **₹32,040.00** → gross **₹2,10,040.00** |
  | Requested delivery | **28 Nov 2026** |
  | Order date | **20 Nov 2026** |
  | Credit limit | ₹25,00,000; this order's exposure is ₹2,10,040.00, well inside it |

- **Expect** The order is **not** credit-blocked. The credit determination shows exposure
  ₹2,10,040.00 against the ₹25,00,000 limit.
- **Journal** None at order entry — an order is a commitment, not a posting.
- **Verify** The order status is not `BLOCKED`, and the credit monitor shows the headroom.
  (Push the quantity to 600 and the order blocks — that is the control working; then undo it.)
- **Why** Credit checking stops the company promising goods to a customer who already owes more
  than it is willing to risk.

### 3.3.3 Delivery and PGI
- **As** `in01.sales` (delivery) then `in01.dispatch` (PGI) · **Path** Sales → Delivery
  (`/sales/delivery`)
- **Data** Delivery of 40 racks from plant `2000`, shipping point `2000`.
- **Journal** Post goods issue:

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `400000` Cost of goods sold | 1,70,000.00 |
  | Cr | `120200` Finished goods inventory | 1,70,000.00 |

- **Verify** Distribution-centre stock falls by 40.
- **Why** PGI is the moment the goods leave and become a cost. The sale is not yet invoiced, so
  revenue has not been recognised — only the cost of what left.

### 3.3.4 Billing, with GST output
- **As** `in01.sales` · **Path** Sales → Billing (`/sales/billing`)
- **Data** Invoice `CUS-2000` for 40 racks at ₹4,450.00, GST `G18`.
- **Expect** Net ₹1,78,000.00 + 18 % GST ₹32,040.00 = **₹2,10,040.00**.
- **Journal**

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `110000` Trade receivables — CUS-2000 | 2,10,040.00 |
  | Cr | `300000` Revenue — domestic sales | 1,78,000.00 |
  | Cr | `220000` Output tax payable | 32,040.00 |

- **TARGET (GAP A1)** Intra-state (Pune to Mumbai): **Cr `220100` CGST 16,020.00 / Cr `220200`
  SGST 16,020.00**. For `CUS-4000` in Rajasthan it would be **Cr `220300` IGST 32,040.00**.
  The product posts one ₹32,040.00 line to `220000`.
- **Verify** The customer's open item is ₹2,10,040.00. Revenue is ₹1,78,000.00.
- **Why** Billing recognises the revenue and creates the receivable. The GST collected is not the
  company's money — it is a liability to the government, which is why it does not sit in revenue.

### 3.3.5 Customer payment
- **As** `in01.ar` · **Path** Finance → Incoming payment
- **Data** ₹2,10,040.00 received 30 Nov 2026.
- **Journal**

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `101000` Bank — current account | 2,10,040.00 |
  | Cr | `110000` Trade receivables — CUS-2000 | 2,10,040.00 |

- **Verify** The customer's open item is cleared.

### 3.3.6 Customer complaint — **TARGET (GAP C3)**
- **As** `in01.sales` (returns order) then `in01.storekeeper` (returns receipt) · **Path**
  Sales → Returns (`/sales/returns`) — there is no QM notification screen
- **Data**

  | Field | Value |
  |---|---|
  | Customer | `CUS-2000` |
  | Reference | The delivery from 3.3.3 |
  | Material | `FG-RACK-2000` |
  | Quantity returned | **2 PC** |
  | Reason | Cosmetic — powder coat flaking at the weld seam |
  | Complaint date | **29 Nov 2026** |
  | Returns delivery date | **30 Nov 2026** |
  | Credit memo | `G18`, ₹4,450.00 × 2 = **₹8,900.00** + GST ₹1,602.00 = **₹10,502.00** |

- **Expect** There is no quality notification. The complaint is recorded as a **sales returns
  order**, whose type and complaint type are configured on the returns configuration, and the
  goods come back on a returns delivery.
- **Journal** Returns receipt, at standard:

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `120200` Finished goods inventory | 8,500.00 |
  | Cr | `400000` Cost of goods sold *(returns offset)* | 8,500.00 |

  and the credit memo: **Dr `300000` Revenue 8,900.00 / Dr `220000` Output tax 1,602.00 /
  Cr `110000` Trade receivables 10,502.00**.
- **TARGET (GAP C3)** A localised system opens a QM notification (type Q1/Q2) linked to the
  delivery and the lot, with defects and a task list. That object does not exist here.
- **Verify** A returns order can be raised and the goods received back on a returns delivery; the
  complaint is the returns order's reference, not a notification. The customer's open item falls
  by ₹10,502.00.
- **Why** Goods coming back are a reversal of both the stock movement and the sale. The complaint
  record is what justifies the return to an auditor.

## 3.4 Import (international slice)

- **As** `in01.buyer` (order) → `in01.storekeeper` (GR) → `in01.ap` (invoice and payment)
- **Data** `SUP-6000` (Ningbo, China), 5,000 `CON-HEXBOLT-M10` at **USD 0.11** each.
  Exchange rate on the order date: **₹83.25/USD**.

  | Step | Document | USD | Rate | INR |
  |---|---|---|---|---|
  | PO | 5,000 bolts | 550.00 | 83.2500 | 45,787.50 |
  | GR | Goods received | 550.00 | 83.2500 | 45,787.50 |
  | Invoice | Supplier invoice | 550.00 | 83.2500 | 45,787.50 |
  | Payment | Paid at a later rate 83.9000 | 550.00 | 83.9000 | 46,145.00 |

- **Journal — goods receipt**

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `120000` Raw materials inventory | 45,787.50 |
  | Cr | `210000` GR/IR | 45,787.50 |

- **Journal — payment, with the exchange difference**

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `200000` Trade payables — SUP-6000 | 45,787.50 |
  | Dr | `570000` Foreign exchange gain or loss | 357.50 |
  | Cr | `101000` Bank — current account | 46,145.00 |

- **TARGET (GAP C4)** An import also needs **customs duty** (a cost added to inventory), a
  **Bill of Entry**, and **import IGST** (creditable input tax). **None of these exists in the
  product.** A localised system would post, at the Bill of Entry, a duty debit to inventory and a
  duty payable credit, and import IGST to the IGST input account. TARGET (GAP).
- **Verify** The payable is cleared at the invoice's rate; the ₹357.50 difference is on the FX
  account, not on the payable or the inventory.
- **Why** A foreign invoice is booked at one rate and paid at another. The difference is a real
  gain or loss on the currency, not a change in what the goods cost — which is why it goes to its
  own P&L account.

- **Export customer** `CUS-6000` (Dubai) is invoiced in USD with tax code `GZ0` (zero-rated). The
  receivable is in USD and settles with the same exchange-difference logic in reverse.

## 3.5 HR and payroll for the month

> **Not yet built as a dataset (GAP D1/D4).** The payroll engine exists and the master data is
> installed; the attendance, absences, advances and the run itself are Phase 3 work.

- **As** `in01.admin` (only this account reaches payroll — **GAP B/payroll authority**) and
  `in01.hr` (attendance and leave)
- **What the month must contain**
  - Attendance for all 52 employees: most fully present; overtime recorded for welders and
    operators.
  - Paid leave (CL/SL/EL) for at least 8 employees, each drawn from a quota set in 1.6.
  - Unpaid absence (LOP) for at least 4 employees, reducing pay by payable days.
  - Salary advances for at least 3 employees, paid mid-month by manual FI journal to `250100`, and
    recovered as a payroll deduction.
  - Other deductions where supported: canteen, a loan EMI, a damage recovery.
  - One joiner mid-month (prorated) and one leaver with an ending assignment.
- **Payroll run → posting**, the expected journals:

  | Dr/Cr | Account | Amount |
  |---|---|---|
  | Dr | `500000` Salaries and wages (by cost centre) | gross earnings |
  | Dr | `500400` PF — employer | 12 % of PF base |
  | Dr | `500500` ESI — employer | 3.25 % where eligible |
  | Cr | `251100` PF payable | employee + employer |
  | Cr | `251200` ESI payable | employee + employer |
  | Cr | `251300` Professional tax payable | ₹200 × employees |
  | Cr | `251400` TDS payable — salary | sum of fixture amounts |
  | Cr | `251000` Net pay payable | gross − deductions |

  Then the bank payment of net salaries: **Dr `251000` / Cr `101000`**.

- **Verify** A payroll result's gross − deductions = net, and the posting's net-pay credit equals
  the sum of the results' net pay.
- **GAP B1/B2.** Every statutory figure above is a configured approximation. PF does not cap at
  ₹15,000; ESI eligibility is fixture data; PT is flat ₹200; TDS is pre-calculated. None is a
  compliance claim.
- **Why** Payroll is an accrual: the month's work creates an expense and a set of liabilities
  (to the employee, and to the PF/ESI/PT/TDS authorities), and the bank payment later clears only
  the employee's share.

---

# Phase 4 — Month-end close

> **Not yet built as a dataset (GAP D1).** The close cockpit and the reports exist; the closing
> documents are Phase 3 work. What follows is the sequence and the checks.

## 4.1 GR/IR clearing
- **As** `in01.controller` · **Path** Purchasing → GR/IR clearing
- **Data**

  | Field | Value |
  |---|---|
  | Company code | `IN01` |
  | Key date | **30 Nov 2026** |
  | Residual to reclassify | whatever the run displays (expected **zero** after 3.1.4) |
  | Target account | `230000` Accrued liabilities |

  On the scenario as written, every receipt has been invoiced by 3.1.4, so the run should report
  **nothing to reclassify**. If it reports a residual, the step that invoiced the receipt is the
  one to look at — not this step.

- **Journal** Only when a residual stands: Dr `210000` / Cr `230000` for a credit residual, or the
  reverse for a debit one.
- **Verify** `210000` is **zero** after the run, and the run reports no residual.
- **Why** GR/IR holds the gap between "goods arrived" and "invoice arrived". At month end that gap
  should be empty; anything left is either a missing invoice or a missing receipt, so it is moved
  to accruals where it is visible rather than left in a clearing account pretending to be real.

## 4.2 Depreciation
- **As** `in01.controller` · **Path** Finance → Assets → Depreciate (`/finance/assets/depreciate`)
- **Data**

  | Field | Value |
  |---|---|
  | Company code | `IN01` |
  | Fiscal year | **2026** |
  | Posting period | **8** (November 2026) |
  | Posting date | **30 Nov 2026** |
  | Asset | Plant and machinery, gross **₹62,00,000.00** |
  | Rate | 10 % straight line, monthly posting |

- **Journal** The month's charge: ₹62,00,000.00 × 10 % ÷ 12 = **₹51,666.67**

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `520100` Depreciation — plant and machinery | 51,666.67 |
  | Cr | `150100` Accumulated depreciation — plant and machinery | 51,666.67 |

- **Verify** Accumulated depreciation rises from ₹14,50,000.00 to **₹15,01,666.67** for this run.
- **Why** Depreciation spreads the cost of a machine over the years it earns money in. The asset
  stays at what it cost; a separate accumulated account records how much of that cost has been
  used up.

## 4.3 Accruals
- **As** `in01.ap` · **Path** Finance → Accruals (`/finance/accruals`)
- **Data**

  | Field | Value |
  |---|---|
  | Accrual | November power bill, not yet invoiced by the utility |
  | Amount | **₹1,85,000.00** |
  | Cost centre | **CC1000** (Cutting — the largest consumer) |
  | Expense account | `510300` Power and fuel |
  | Liability account | `230000` Accrued liabilities |
  | Accrual date | **30 Nov 2026** |
  | Reversal date | **01 Dec 2026** |

- **Journal** Dr `510300` Power and fuel 1,85,000.00 / Cr `230000` Accrued liabilities 1,85,000.00,
  reversed on 1 December.
- **Verify** The accrual stands with a reversal date of 01 Dec 2026, and the power cost appears on
  CC1000 in the November cost-centre report.
- **Why** The factory used electricity in November and has not been billed. Booking the cost now
  puts it in the month that incurred it; the reversal stops it being counted again when the real
  invoice arrives.

## 4.4 Cost centre allocation
- **As** `in01.controller` · **Path** Controlling → Cost allocation cycles
- **Data**

  | Field | Value |
  |---|---|
  | Cycle | Service-centre assessment |
  | Senders | `CC7000` Maintenance, `CC6000` Quality |
  | Receivers | `CC1000` Cutting, `CC1010` Welding, `CC1020` Painting |
  | Allocation account | `600000` Cost centre allocation — clearing |
  | Period | **8** (November 2026) |
  | Fiscal year | **2026** |
  | Basis | The senders' own November actual cost |

- **Journal** One document: the senders are credited and the receivers debited, both on `600000`:

  | Dr/Cr | Account | Amount (₹) |
  |---|---|---|
  | Dr | `600000` (receivers, by cost centre) | sender total |
  | Cr | `600000` (senders, by cost centre) | same |

- **Verify** The document nets to zero; no new external expense appears; each receiver's cost
  centre report now carries its share.
- **Why** Maintenance and quality serve the whole factory but do not sell anything. Assessment
  moves their cost onto the departments that use them, so each product's cost reflects the
  support it consumed.

## 4.5 Production order settlement — **TARGET (GAP C1)**
See 3.2.5. Display only; nothing posts.

## 4.6 Period close and statements
- **As** `in01.controller` · **Path** Finance → Close cockpit (`/finance/close-cockpit`), Trial
  balance (`/finance/trial-balance`), P&L (`/finance/profit-loss`), Balance sheet
  (`/finance/balance-sheet`)
- **Data**

  | Field | Value |
  |---|---|
  | Company code | `IN01` |
  | Fiscal year | **2026** |
  | Period | **8** (November 2026) |
  | Close cycle | November 2026, company code `IN01` |

  Walk the cockpit's tasks in order; each is a check the close depends on. Do **not** close the
  period until the reconciliation checklist below passes.

- **Expect** The cockpit lists its tasks with their completion state; the statements open for
  FY 2026 period 8.
- **Verify** Trial balance nets to zero; total assets = total liabilities + equity; the P&L's
  result equals the change in the current-year result account; no document sits outside the open
  periods.
- **Why** Closing a period is the month-end lock: after it, nothing more can be posted to
  November, which is what makes November's numbers final.

## 4.7 GST summary — GSTR-3B style
- **As** `in01.ap` · **Path** Finance → Tax (`/finance/tax`)
- **Data**

  | Field | Value |
  |---|---|
  | Company code | `IN01` |
  | Country | **IN** |
  | From | **01 Nov 2026** |
  | To | **30 Nov 2026** |
  | Corrected return | off |
  | Test run | run once as a test, then once for real |

  Expected figures on the scenario as written — output from 3.3.4 (₹32,040.00) and the credit memo
  in 3.3.6 (₹1,602.00), input from 3.1.4 (₹5,625.00):

  | Line | Amount (₹) |
  |---|---|
  | Output tax (`G18`) | 32,040.00 − 1,602.00 = **30,438.00** |
  | Input tax (`G18`) | **5,625.00** |
  | Net payable | **24,813.00** |
- **Expect** A per-tax-code summary: output tax, input tax, taxable base.
- **Journal (clearing transfer)** Dr/Cr between `220000` and a clearing account for the net.
- **TARGET (GAP A6)** This is **GSTR-3B-style**, not GSTR-3B. It is not invoice-wise, so it is not
  GSTR-1. No statutory file format exists.
- **Verify** Output − input = the net payable the run reports.

## 4.8 Payroll summary — **GAP B8**
- **As** `in01.admin` (only this account reaches payroll) · **Path** People → Payroll results
  (`/people/payroll-results`)
- **Data** The November 2026 run for company code `IN01`, fiscal year 2026, period 8.
- **Expect** A result per employee, with gross, deductions and net; a printable payslip per
  result. **PF, ESI, PT and TDS registers do not exist.**
- **Verify** For each result, gross − deductions = net; the sum of net pay equals the credit on
  `251000`; the sum by cost centre equals the `500000` debit by cost centre.
- **GAP B8.** The reconciliation's register checks are marked **not verifiable — GAP B8**.
- **Why** Payroll results are what each person was paid and why. The registers a payroll officer
  files with the PF, ESI and tax authorities are separate statutory reports, and this product
  does not produce them.

---

# Reconciliation checklist

Run every line at 30 November 2026. **A line marked "not verifiable" is a GAP, not a failure of
the data.**

| # | Check | Where | Expected | Status |
|---|---|---|---|---|
| 1 | Trial balance nets to zero | Finance → Trial balance | Total debits = total credits | Testable |
| 2 | MM stock value = inventory G/L | Inventory → Stock reconcile; G/L balances `120000`+`120100`+`120200`+`120300` | Equal, per valuation class | Testable |
| 3 | AP open items = AP control account | Finance → Vendor balances vs `200000` | Equal | Testable |
| 4 | AR open items = AR control account | Finance → Customer balances vs `110000` | Equal | Testable |
| 5 | GR/IR cleared to zero | `210000` after 4.1 | Zero | Testable |
| 6 | Production variance explained | Consumption account `410000` residue | Explained, not posted | **Not verifiable — GAP C1** |
| 7 | GST output − input = GST payable account | `220000` vs the tax run | Equal | Testable (single consolidated account) |
| 7a | CGST/SGST/IGST split reconciles to the three output accounts | `220100`/`220200`/`220300` | — | **Not verifiable — GAP A1/A3** |
| 8 | Payroll: gross − deductions = net paid | Payroll results vs `251000` and the bank | Equal | Testable |
| 9 | PF / ESI / PT / TDS liability = registers | `251100`/`251200`/`251300`/`251400` | — | **Not verifiable — GAP B8** (no registers) |
| 9a | TDS liability = register | `251400`, `221100`, `221200` | — | **Not verifiable — GAP A7/A7 (no TDS engine; 194C/194J nothing posts)** |
| 10 | Employee advance account = open instalments | `250100` | Zero, or equals open instalments | **Not verifiable — GAP B4** (no advance subledger) |
| 11 | Salary expense by cost centre = payroll register by department | `500000` by CC vs results by assignment | Equal | Testable from the results |

### The two lines the owner asked to see explicitly

- **GST split (7a): not verifiable — GAP.** The product posts one consolidated rate to one `TAX`
  account. There are no CGST/SGST/IGST balances to reconcile, because nothing writes to
  `220100`–`220300`.
- **TDS (9a): not verifiable — GAP.** There is no withholding engine. The vendor payment carries
  no TDS, so there is no liability to reconcile against a register. Sections 194C and 194J have no
  posting at all; 192 is a pre-calculated payroll deduction whose total is on `251400`, but there
  is no register to compare it with.

---

# Where this guide and the fixtures disagree

The fixture files are the single source of truth for Phases 0–2:

- `fixtures/core/organisation.json` — country-neutral structure, roles, account keys
- `fixtures/country/IN/country-pack.json` — fiscal year, chart additions, tax codes, payroll statute
- `fixtures/company/IN01/company.json` — employees, materials, partners, prices, opening balances

If a value in this guide differs from a fixture, **the fixture is right** and this file should be
corrected. The installer reads only the fixtures; nothing in it invents a business value.
