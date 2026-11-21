# Scope model: SAP's 4-tier authorization mapped onto Cairn

Source: the SAP scoping report supplied by the user (4 gates, 13 transaction families, 4 special mechanisms). This file converts it to Cairn's modules and records what is enforced today. It is a plan and status list, not a claim that everything is covered. Enforcement status for each service lives in `docs/company-scope-audit.md`.

## 1. The four gates in Cairn terms

| SAP gate | Cairn equivalent | State |
|---|---|---|
| 1. Menu gate (`S_TCODE`, Fiori catalog) | Route capability (`requireSession(ROUTE)` + `can(session, CAP)`) | Present on pages. Not a security boundary on its own: the service must check again. |
| 2. Org-level gate (BUKRS, WERKS, EKORG, VKORG, KOKRS, LGORT…) | `user_capability_scope` / `auth_org_restriction`, nine levels: PLANT, COMPANY_CODE, PURCHASING_ORG, PURCHASING_GROUP, SALES_ORG, DISTRIBUTION_CHANNEL, DIVISION, CREDIT_CONTROL_AREA, CONTROLLING_AREA. Helpers: `hasOrgAccess`, `company-scope.ts`, `scope-actor.ts` | **COMPANY_CODE and PLANT are enforced** in finance, purchasing (company level), production cost report, part of sales billing, and inventory (reads, reservations, price change, physical inventory). **SALES_ORG, DISTRIBUTION_CHANNEL and DIVISION are enforced for sales orders (phase 6a).** The remaining levels are stored and editable but not enforced by any service. `auth_org_restriction` already accepts STORAGE_LOCATION (free scope type, nothing enforces it); `user_capability_scope` has no such type; there is no WAREHOUSE type. |
| 3. Object gate (`ACTVT` + doc type, account type, order type) | One capability per action (create/change/display/post/reverse are separate keys) | Present. Not present: scoping by document type, order type, account type inside one capability. |
| 4. Technical gate (`S_TABU_DIS`, jobs, RFC, queries) | Reports/exports re-enter the same services with the verified session; jobs use a lease | Reports and CSV/PDF exports covered for finance and the inventory/production reports done so far. Job and import paths not audited as a whole. |

Rules that apply to every row below (already the project rule): capability alone never reaches another scope; the check is in the service, in its own transaction, before any read or replay lookup; actor and tenant come from the session or job lease; an empty restriction list is never "unrestricted"; a multi-scope request is refused as a whole; an out-of-reach document answers as a missing one.

## 2. SAP transaction family → Cairn area

Status: **done** = Company Code and Plant enforced as described in the audit; **partial** = some services; **open** = none; **n/a** = no Cairn equivalent.

| SAP family | Cairn module / area | Org levels SAP uses → Cairn level | Status |
|---|---|---|---|
| Procure-to-pay (PR, PO, contracts, SA, IR) | `purchasing` | EKORG → PURCHASING_ORG, EKGRP → PURCHASING_GROUP, WERKS → PLANT, BUKRS → COMPANY_CODE | partial. Company Code done for requisitions, orders, release, invoice verification, parked invoices, payment/GR-IR. **Open:** Purchasing Org and Group enforcement everywhere; plant scope on order and requisition writes; contracts, scheduling agreements, info records, quotations, RFQs, source lists, quota arrangements, vendor evaluation, follow-on, goods-receipt posting, vendor and price reads. |
| Inventory and warehouse (MIGO, MI01, stock) | `inventory` | WERKS → PLANT, LGORT → STORAGE_LOCATION (accepted in `auth_org_restriction`, not enforced), LGNUM → WAREHOUSE (new) | partial. Plant (via its company) done for material documents, stock overview, warehouse stocks, price change, reservations, physical inventory. **Open:** stock ageing/reconcile/shelf-life lists, batch reads, serial numbers, MIGO posting, return delivery, goods-receipt posting; storage-location and warehouse levels; movement-type scoping (receipt vs scrap/adjustment). |
| Financial accounting (GL, AP, AR, assets, bank) | `finance` | BUKRS → COMPANY_CODE, account type D/K/S/A, document type | partial. Company Code done for statements, balances, journals, reversal, FX, accruals, close cockpit, consolidation, intercompany, tax. **Open:** AR/AP posting family; account-type and document-type scoping (`F_BKPF_KOA`/`BLA`); payment-run scoping; asset accounting posting paths. |
| Controlling (cost centers, internal orders, profit centers, COPA) | `finance` (CO), `production` (order costing) | KOKRS → CONTROLLING_AREA, cost-center / profit-center hierarchy nodes | open for CONTROLLING_AREA (stored, never enforced). Cost-center hierarchy scope not modelled as a scope type. |
| Sales and distribution (quote, order, delivery, billing, credit) | `sales`, `finance` (credit) | VKORG → SALES_ORG, VTWEG → DISTRIBUTION_CHANNEL, SPART → DIVISION, VSTEL shipping point (not modelled), KKBER → CREDIT_CONTROL_AREA | partial. Billing invoice lists and credit memos done at company level. Sales orders done incl. sales area (6a). **Open:** quotations, deliveries; shipping point; credit-control area on credit limits; pricing-condition override authority. |
| Production planning and execution | `production` | WERKS → PLANT, MRP controller, order type | partial. Cost report done. **Open:** plant scope on order create/change/release/confirmation, BOM, routing, MRP run (uses unscoped variants), order-type scoping. |
| Plant maintenance | none | — | n/a |
| Quality management | `quality` (4 files) | WERKS → PLANT | open. Includes the SAP rule that the usage-decision maker must differ from the producer (separation of duties). |
| Project system | none | — | n/a |
| HCM / payroll | `people` | Personnel Area/Subarea, Employee Group, infotype | scope-checked by earlier payroll work; not re-audited here. No infotype-level or structural (reporting-line) scoping model. |
| Master data (BP, material, GL) | `foundation` | company-code / purch-org / sales-area / plant view-dependent | open. Reads of vendor, customer, material views are not filtered by org level. Material view split (engineering vs accounting) not modelled. |
| Reporting and query | report services, `/reports/export/*` | inherits the underlying levels | follows the services above. No ad-hoc table browser exists, so `S_TABU_DIS` has no equivalent. |
| Basis, admin, jobs, interfaces | `platform`, `worker`, `audit` | client | tenant isolation by RLS; job lease authority exists. Not part of this pass. |

## 3. The four special mechanisms

| SAP mechanism | Cairn equivalent | State |
|---|---|---|
| Field/infotype/view scoping | none | Not modelled. Material-view and payroll-infotype splits would be new capability keys, not org scopes. |
| Structural/hierarchical (reporting line, cost-center/WBS tree) | none | Not modelled. Needs a hierarchy scope type. |
| Authorization groups (`BEGRU`) | none | Not modelled. Would be a column on sensitive masters plus a scope type. |
| Release strategies / value limits | `foundation/release-strategy-definition.ts`, purchasing release | Exists for purchasing; scoped by company in phase 4b. Value-tier authority for other documents (journals, parked invoices) not audited. |

## 4. Implementation order

Each phase: a service-level gate, pages and actions passing the session, adversarial tests (other scope hidden as missing, scope refused as a whole, no session / capability / scope / other tenant, session user recorded), audit section, codemap, typecheck, commit and push.

1. **Sales area** (SALES_ORG, DISTRIBUTION_CHANNEL, DIVISION): orders, quotations, deliveries, billing remainder. Needs a shared `salesAreaReach` helper beside `reachablePlantsInTx`.
2. **Purchasing org and group**: enforce on every purchasing service already gated at company level, then the uncovered purchasing masters and goods-receipt posting.
3. **Inventory remainder** and **storage location** scope type (check constraint change, no data to migrate).
4. **Controlling area / cost center** for CO postings and reports; production plant scope.
5. **Finance leftovers**: AR/AP posting family, account-type and document-type scoping, credit-control area.
6. **Quality** plant scope plus separation of duties on the usage decision.
7. **Master data reads** by org level.
8. Mechanisms not modelled (authorization groups, infotype/view, hierarchy): design decision first, because each adds a new concept.

Phases 1 to 7 reuse the existing scope tables. Phase 3's storage-location level and phase 8 change the schema; with no production data, that is allowed under CLAUDE.md, but they are listed separately because they add a concept.
