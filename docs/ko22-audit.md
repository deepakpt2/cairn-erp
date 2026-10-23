# KO22 and KO23 — original budget

This is not an S/4HANA 2025 parity claim.

KO22 changes the original budget of an internal order. KO23 displays it. A save writes a budget document. It does not post, supplement, return, carry forward, or settle.

## What was already here

KO01, KO02, and KO03 already store the internal order. The order currency follows the controlling area. The controlling area has a fiscal-year variant, and `derivePosition` resolves a date to a fiscal year and period. Journal lines may cite the order number as text.

No budget document, budget profile, supplement, return, carryforward, or availability-control engine existed.

## What this package stores

Migration `9154` adds a budget profile and an assignment from an order type. `BP01` is seeded and assigned to `IO01`. The service reads that assignment. It does not treat `BP01` or `IO01` as a meaning.

The seeded profile allows an overall amount and annual amounts, and it requires the annual total not to exceed the overall amount. It does not require the annual total to equal the overall amount. Availability control is false. No tolerance is seeded.

Each save inserts a new original-budget document and its annual lines. An earlier document is not updated. The displayed original budget is the latest document. `released` supplements and returns are not stored in this table.

The document date is resolved through the controlling area's fiscal-year variant. A fiscal year outside the order's resolved validity is refused. A calendar year is not assumed. Financial posting periods are not applied, because this save does not post.

The number comes from the internal `ORDBUDGET` range. An external range is refused by the existing number service.

## What a save does not do

It does not insert a journal, a supplement, a return, a commitment, or a settlement. It does not change the order's last-modified data. It does not rewrite a journal line that cites the order. Journal lines are shown as citations, not as budget consumption.

KO23 accepts only the client and order number. It does not take a change lock and does not change stored budget data.

A marked order cannot be changed. A profile that does not allow a change is refused. A missing profile is refused.

## Gaps, not built here

Availability control is stored on the profile and is not executed. There is no tolerance check and no consumption calculation.

KO24, KO25, KO26, KO27, KOCO, KO30, KO2A, KOB1, KOB2, and KO88 are not implemented. Current budget is not calculated, because supplements, returns, and carryforward are not configured.

There is no separate budget-profile maintenance transaction. This is not an S/4HANA 2025 parity claim.
