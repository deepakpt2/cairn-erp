# Deliverable 5 — GAP list

Everything the UAT needs that the product does not have. **Nothing in this list was built.** A
GAP is not a defect: the application is behaving as designed, and the design does not include
this yet. The defects that *were* fixed are in `06-bug-fix-log.md`.

Severity: **P0** blocks a step of the scenario · **P1** forces a documented workaround · **P2**
cosmetic or future.

How to read an entry: *What is missing* — what the product does instead — what the guide shows.
Where the guide shows a target that cannot be posted, the entry is labelled **TARGET (GAP)**.

---

## A. India configuration

| # | Gap | Sev |
|---|---|---|
| A1 | **No CGST/SGST split.** A tax code carries one rate and an invoice line carries one code. A 18 % intra-state invoice cannot show CGST 9 % + SGST 9 % as two tax lines. The product posts one consolidated 18 % line. | **P0** |
| A2 | **No place-of-supply decision.** Nothing chooses between CGST+SGST and IGST. The tester must pick the tax code by hand, and the product cannot check the choice against the customer's state. `region` on an address is free text with no state-code semantics. | **P0** |
| A3 | **One TAX account for input and output.** Account determination has a single `TAX` event per chart. Purchases and sales both land on it (the demo points it at `220000 Output tax payable`). A GST-compliant ledger separates input credit (`140100`/`140200`/`140300`) from output payable (`220100`/`220200`/`220300`). `tax_code.account_key` is maintainable and **read by no posting path**. | **P0** |
| A4 | **No HSN/SAC on the material master.** The material table has no such column. The fixture carries `hsn` per material for the guide only; nothing validates or prints it. | **P0** |
| A5 | **No GSTIN validation, and no state derived from it.** `tax_registration_number` on the company and `tax_number` on a partner are free text up to 40 characters. The GSTIN pattern in `country/IN` is documentation, not enforcement. | **P1** |
| A6 | **No GSTR-1, no e-invoice, no e-way bill.** The product has a per-tax-code input/output run (`/finance/tax`) usable as a **GSTR-3B-style** summary. It is not a GSTR-3B and produces no statutory file (the run even records that electronic filing is configured but no format exists). | **P1** |
| A7 | **No withholding-tax engine.** TDS u/s 194C, 194J and 192 cannot be computed, deducted or posted. `221000 Withholding tax payable` exists in the delivered chart and nothing posts to it. Outgoing payment and the payment run contain no TDS path. | **P0** |
| A8 | **No delivered India chart of accounts.** The standard package delivers a generic chart (`CA01`). The installer adds 20 India-specific accounts through the G/L service; a real deployment would maintain its own chart. | **P1** |
| A9 | **Standard fiscal year variant is calendar.** `K4` is January–December. April–March is supported and is built by the installer as variant `A4`, but it is not delivered, and the controlling area must be moved onto it (the installer does that through OX19's services). | **P1** |
| A10 | **A P&L G/L account must name a retained-earnings indicator.** `upsertGlAccount` refuses one that does not. The installer passes the delivered `X`. Not a gap for India, recorded because it shapes how the country pack's additions must be written. | **P2** |
| A11 | **No service creates a credit risk category.** The credit master only reads them, so the installer inserts the row directly — following the existing provisioner's documented precedent. A second country pack would face the same. | **P1** |

## B. Payroll and HR statutory

| # | Gap | Sev |
|---|---|---|
| B1 | **Nothing statutory ships** (DV-001). PF, ESI, professional tax and TDS are **configured approximations** posted as pay components: PF 12 %/12 % of the structure base, ESI 0.75 %/3.25 % for fixture-marked employees, PT a flat ₹200/month, TDS 192 a pre-calculated fixed amount per employee. None of it is a compliance claim. | **P0** |
| B2 | **A pay rule is a fixed amount or a percentage — with no condition.** There is no wage ceiling, no slab, no formula. ESI eligibility is decided in the fixture, not the engine; professional tax slabs cannot be expressed; TDS 192 cannot be computed at all. | **P0** |
| B3 | **No overtime in payroll.** `OVERTIME` time types exist and are recorded, but the run reads only unpaid absences. An overtime amount must arrive as a recurring employee component. | **P1** |
| B4 | **No salary-advance subledger.** No employee-advance account, no instalment recovery. The workaround is a manual FI journal against `250100` plus a payroll deduction component. | **P1** |
| B5 | **No full-and-final settlement.** Ending a position and a salary assignment stops pay; there is no gratuity, no leave encashment, no settlement document. | **P1** |
| B6 | **No daily-wage master.** Proration by payable days is the only mechanism; a worker paid per day is a monthly base divided by days. | **P2** |
| B7 | **Employee statutory identifiers need record types defined first.** PAN, UAN, ESIC and bank details are `employee_record` types the tenant must define. The installer defines four; nothing validates their format. | **P1** |
| B8 | **No payroll registers.** PF, ESI, PT and TDS registers do not exist as reports; the payroll result screen is the only view, and a payslip is a printable page per employee. | **P1** |
| B9 | **No payroll document per employee.** The PR posting is summarised by account and cost centre; trace is document → run → result → line. | **P2** |
| B10 | **No service creates a factory calendar.** `saveCalendarPeriod` requires one to exist and nothing creates it. The installer therefore builds the holiday calendar and its days only, and leaves the working-week calendar to the configuration screen. | **P1** |

## C. Transactions, production and quality

| # | Gap | Sev |
|---|---|---|
| C1 | **Production order settlement does not post.** `productionOrderSettlementPosting()` returns `posts: false`; WIP at period end and variance splitting are deferred (DV-003, DV-004). The screen calculates and displays; no document results. The guide shows the settlement and variance entries as **TARGET (GAP)**. | **P0** |
| C2 | **No inspection plan.** Quality has lots, characteristics, results and usage decisions — four tables, no plan. Inspection is per lot, configured at the lot, not from a master plan. | **P1** |
| C3 | **No QM notification or customer-complaint object.** A complaint is modelled through a sales returns order (`sales_returns_configuration` names the returns order type and the complaint type). There is no quality notification. | **P1** |
| C4 | **No customs duty, Bill of Entry, or import IGST.** Nothing in the product handles an import declaration. The foreign-vendor purchase runs PO → GR → invoice in USD with FX; duty and import IGST are **TARGET (GAP)**. | **P0** |
| C5 | **Production confirmation posts no activity cost.** A confirmation records that an operation happened, not what labour or machine time cost. Conversion cost therefore appears as a balance on the consumption account, which is expected rather than a defect. | **P1** |
| C6 | **No profit centre on payroll postings.** Nothing in the payroll model supplies one. | **P2** |
| C7 | **Batch management exists but is not configured for this dataset.** Not needed for fabricated steel; recorded so the guide does not imply it is absent. | **P2** |

## D. Installer and dataset mechanics

| # | Gap | Sev |
|---|---|---|
| D1 | **`--with-transactions` is not implemented.** Phases 0–2 are the master-data install; the transactional dataset is separate work. The flag is parsed and refused by name rather than silently ignored. | **P0** |
| D2 | **No automatic eligibility refusal.** Unlike `demo:provision`, this installer does not refuse a database that already holds business data. It is intended for a database an operator has chosen, and a mistake is caught by the reset's own checks instead. Worth closing before it is used on anything shared. | **P1** |
| D3 | **The reset deletes the tenant rather than the company code.** The product's tenancy model is one tenant per company, and its `client` rows cascade from the tenant. A product that later hosts several company codes in one tenant would need this revisited. | **P2** |
| D4 | **No CSV export of the credentials from the app.** The page shows the rows and the file is the export; `renderIn01CredentialCsv` exists but no route serves it. | **P2** |

## E. Localisation — what is missing for India, and what is missing for a second country

Requested with the fixture split. For each area: **what India still needs**, and **what any
second country would still need** once `fixtures/country/<XX>` exists.

| Area | Missing for India | Missing for any second country |
|---|---|---|
| **Tax** | The CGST/SGST split (A1), place-of-supply selection (A2), separate input/output accounts (A3), HSN (A4), GSTIN validation (A5), GSTR-1 and statutory file formats (A6). | Tax codes are already per country and the installer reads them from the pack. What is missing is **any** jurisdiction that needs more than one rate on a line, or a tax decided by geography. The model is "one rate per line, one TAX account per chart" — that is the ceiling for every country. |
| **Withholding** | The whole concept (A7): no engine, no sections, no certificates. | No country can have withholding without building the engine first. Nothing country-specific exists to extend. |
| **Payroll statutory** | Ceilings, slabs and formulae (B2); PF/ESI/PT/TDS as real computations (B1); gratuity (B5); registers (B8). | A second country can define its own components and flat rates through the country pack — that part is genuinely reusable. It cannot express a ceiling, a slab, a wage-band or an age-dependent rate, which is most of what statutory payroll means anywhere. |
| **Currency** | INR is in the reference data; nothing is needed. | A **company** must be single-currency in its books; foreign transactions work (exchange rates, FX gain/loss, payment-run FX). What is missing is any per-document currency policy, triangulation between two non-local currencies, and a currency on the country pack's payroll components — the base amount's currency is the company's, hard-coded in the fixture. |
| **Fiscal year** | April–March, built by the installer (A9), with the controlling-area move that requires. | The variant machinery is country-neutral and hand-maintainable, so a second country needs only a period list in its pack. The **defect that made shifted years fail was fixed** (`06-bug-fix-log.md`), without which no country with a non-calendar year could have worked. Still open: report and screen defaults assume the calendar year (`03-calendar-year-assumption-report.md`). |
| **Formats** | GSTIN, PAN, HSN, and the DD-MM-YYYY display convention. None is enforced; date rendering is not localised at all. | **No input-mask or validation-by-country mechanism exists.** A country pack can document a pattern but nothing applies it. Date, number and address formats are not configurable: addresses are a single free-text line with free-text `region`, and there is no per-country address layout. This is the largest cross-country gap after tax. |
| **Chart of accounts** | The 20 India-specific accounts, added as data (A8). | Each country's pack must carry its own additions; there is no country chart template and no localisation layer for account naming. |
| **Calendar** | The holiday list, built as data. | A factory calendar cannot be created by any service (B10), so every country pack hits this. |

### The short version

The country pack makes **tax codes, payroll components, the fiscal year and the chart additions**
genuinely country-swappable — the installer reads them and does not change. It does not make
**tax structure** (split, place of supply, separate accounts), **withholding**, **statutory
formulae**, **input formats** or **address layout** swappable, because the product has no such
concepts at all. Those are product work, not fixture work, in any country.
