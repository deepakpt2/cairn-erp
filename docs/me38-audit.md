# ME38 delivery schedule

This is not an S/4HANA 2025 parity claim. No official field list or program source for that release was available. ME38 maintains delivery schedule lines on the scheduling agreement created by ME31L. It does not replace that agreement.

## Before this change

| Check | Verdict |
| --- | --- |
| Schedule-line table | PASS. `scheduling_agreement_schedule_line` already stood. ME31L did not write it. |
| ME38 or ME39 route | FAIL. Neither transaction was registered. |
| Firm zone, fixed indicator, date category, delivery time | NOT STORED. No configuration exists. |
| MRP schedule lines | NOT BUILT. The MRP run already refuses to create one. |
| Goods receipt against an agreement | NOT BUILT. A receipt does not reference a scheduling agreement. |
| Supplier release / ME84 / output | NOT BUILT. No purchasing output service exists. |

## After this change

| Check | Verdict | Where |
| --- | --- | --- |
| ME38 writes the existing line table | PASS | A line of 4 and a later line of 3 left scheduled quantity 7 against a target of 10. No second schedule engine. |
| Partial schedule allowed | PASS | The total does not have to equal the target. |
| Total above target refused | PASS | No overdelivery tolerance is configured. The refused save left the first line at 4.000. |
| Date and unit | PASS | A date outside validity, an impossible calendar date, and a unit other than the item unit are refused. The date is stored as entered. The factory calendar is non-operational and is not consulted. |
| Line identity | PASS | A line cannot be moved to another item. A repeated line number in one save is refused. An omitted line stays. |
| Cancellation | PASS | The line is marked, not deleted. It no longer consumes the target. |
| Agreement, order, receipt, and release | PASS | The agreement header timestamp and price stayed. No purchase order or material document was created. A released agreement stayed released at the same step. Saving does not claim a supplier release was sent. |
| ME39 read-only | PASS | A quantity parameter is refused. Display writes nothing and takes no change lock. |
| Other tenant | PASS | Display returns no document. |
| Firm zone, fixed line, MRP, goods-receipt progress, ME84 | NOT BUILT | Those controls are not configured. They were not invented, and a goods-receipt quantity is not typed onto the line. |

Migration `9151` is applied. It adds the cancellation mark and the ME38/ME39 routes. `tests/scheduling-agreement-schedule.test.ts` passed, 5 tests. `tests/scheduling-agreement.test.ts` still passed, 6 tests. `tsc` was run; it still reports existing errors in `scripts/seed.ts` and none in these files. Lint and the production build were not run. Nothing was pushed.
