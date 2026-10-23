# ME31L, ME32L, and ME33L

This is not an S/4HANA 2025 parity claim. No official field list or program source for that release was available. A scheduling agreement is not a purchase contract and not a purchase order.

## Before this change

| Check | Verdict |
| --- | --- |
| Scheduling-agreement table, route, or capability | FAIL. None existed. |
| Purchase contract used as the agreement | Not done. ME31K stays a contract. |
| Purchase order used as the agreement | Not done. ME21N stays an order. |
| Delivery schedule service | FAIL. No schedule-line table and no ME38 or ME39. |
| Condition pricing and purchasing output | NOT APPLICABLE. Neither engine exists. |
| Source list and MRP | PASS as closed refusals. Both already refuse a scheduling agreement. They were not changed. |

## After this change

| Check | Verdict | Where |
| --- | --- | --- |
| Distinct document | PASS | `scheduling_agreement` and `scheduling_agreement_item`. A save created neither a contract nor a purchase order. |
| ME31L create | PASS | Configured type, supplier, organization, dates, unit, and material are judged. An unconfigured type is refused. `LP` is seeded data, not a service constant. |
| Numbering | PASS | The existing `SCHEDAGREE` allocator draws the number. The same request key returns the same agreement. A second key draws another number. |
| Failed save | PASS | Invalid supplier, date, material, and unit left no agreement header. |
| No schedule line on create | PASS | Create left the schedule-line count at zero. |
| No stock or accounting | PASS | Material-document and journal counts were unchanged. |
| ME32L change | PASS | A price change stored old 2.00, new 9.00, and transaction `ME32L`. Supplier, organization, company, currency, and document type stay as saved. |
| Schedule line not rewritten | PASS | A stored line stayed at quantity 4.000 after the price change. Material and plant cannot change once a line stands. |
| Released agreement | PASS | The existing release engine refuses the change. No second approval mechanism was added. |
| ME33L read-only | PASS | Display refused a price parameter, wrote nothing, and did not change `changed_at`. The display page has no save action and takes no change lock. |
| Tenant isolation | PASS | Another tenant cannot display the agreement. |
| Plant not universally required | PASS | An agreement saved with no plant. A plant that is set cannot move after a schedule line exists. |
| Pricing | PASS for the existing price | Typed price or info-record price. No condition procedure was added. |
| ME38 and ME39 | NOT BUILT | The schedule-line table is present so a later ME38 has a place to write. This package does not write lines and does not invent those transactions. |
| ME37, ME34L, ME84, ME3R, ME9E | NOT BUILT | Stock transport, supplements, release generation, price recalculation, and output print are not in this ERP. They were not simulated. |
| Source list, MRP, goods receipt, invoice | UNCHANGED | Those services still do not consume a scheduling agreement. A change here does not rewrite their history. |
| Output, firm zone, exchange rate, central contract | NOT APPLICABLE | Not stored. Display refuses those parameters. |
| Concurrency | PASS for the existing model | ME32L uses the enqueue lock and an advisory lock. No version column was added. |

Migration `9150` is applied. `tests/scheduling-agreement.test.ts` passed, 6 tests. `tests/purchase-contract.test.ts` still passed, 13 tests. `tsc` reported existing errors in `scripts/seed.ts` and none in the scheduling-agreement files. Lint and the production build were not run. Nothing was pushed.
