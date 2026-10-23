# KOP1 — create orders for plan revaluation

This is not an S/4HANA 2025 parity claim. The field layout of SAPMKPU1 was not available as program source. The screen stores the selection this ERP can validate. It does not copy SAP table names.

## What was already here

Internal orders, controlling areas, and fiscal-year variants already exist. Cost-center plan amounts and activity rates already use a plan version of one to three characters. There is no internal-order plan table, no order group, no revaluation key, and no revaluation percentage table.

KOP2, KOP3, KOP4, and KOPU were not present.

## What this package stores

Migration `9155` adds a plan-revaluation definition and the internal orders selected for it. The number comes from the internal `REVALORD` range. A typed number is refused. External numbering is not assigned.

The fiscal year is the year entered. It is not replaced. Periods must fall inside the controlling area variant's regular periods. The plan version is the version entered. It is not defaulted to `000`. The currency is the controlling area currency.

A marked order is not included. If that leaves no order, the save is refused. An order in another controlling area is refused.

The execution status can only be `NOT_EXECUTED`. No percentage is stored.

## What a save does not do

It does not change cost-center plan amounts, original budgets, journals, or the internal-order master. It does not create another internal order. It does not run KOPU.

## Gaps, not built here

KOP2, KOP3, KOP4, and KOPU are not implemented. There is no revaluation rule and no percentage. Plan data for internal orders does not exist, so nothing was revalued. Order groups are not implemented. A planning lock does not exist, so none is applied. This is not an S/4HANA 2025 parity claim.
