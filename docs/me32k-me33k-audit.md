# ME32K change and ME33K display

This is not an S/4HANA 2025 parity claim. No official field list or program source for that release was available. The same contract tables and services from ME31K are reused. Creation was not rebuilt.

## Before this change

| Check | Verdict |
| --- | --- |
| Canonical contract, item, call-off, and release | PASS. Already present. |
| ME32K change of an unreleased contract | PARTIAL. The change service existed, but a released contract threw the release error instead of the contract error, and the change log stored only an item count. |
| ME33K read-only on the backend | FAIL. ME33K opened the change screen. A user who could maintain the contract saw the save form, and the page took a change lock. |
| Existing purchase order left unchanged | PASS in code, untested. The change updated only the contract. |
| Condition pricing and purchasing output | NOT APPLICABLE. Neither engine exists. |

## After this change

| Check | Verdict | Where |
| --- | --- | --- |
| Same contract document | PASS | ME32K and ME33K read `purchase_contract`. No second contract table. |
| Released contract cannot be changed | PASS | The existing release check refuses it. The change service now returns that refusal as a contract error. Tested. |
| Price change does not rewrite a purchase order | PASS | Contract price moved from 2.00 to 9.00. The purchase-order price and material stayed 2.00 and `MAT-CONT`. |
| Material, unit, and plant stay after a call-off | PASS | A different standing material was refused. Unit and plant use the same guard. The purchase order is not rewritten. |
| Target below the call-off | PASS | Already refused. The existing test still passed. |
| Change history | PASS | The price change stored old value 2.00, new value 9.00, and transaction `ME32K`. |
| ME33K writes nothing | PASS | Display refused a price parameter, returned no document for that call, and left `changed_at` unchanged. The display page has no save action and takes no change lock. |
| Display and change stay separate | PASS | Save still requires `PROC.CONTRACT.MAINTAIN`. ME33K is `PROC.CONTRACT.DISPLAY` at `/purchasing/contract-display`. A maintain user may open display, but that route cannot save. |
| Another tenant | PASS | Display of another tenant's contract returns not found and no document. |
| Client-side identifier | PASS for display | A display call cannot select a mutation. Change still requires the contract number and the existing change lock for that number. |
| Concurrency | PASS for the existing model | ME32K uses the enqueue lock and the contract advisory lock. No version column was added. |
| Stock, goods receipt, invoice, and accounting | PASS | Display and the price change do not post them. Called-off, remaining, receipt, and invoice stay separate figures. |
| Condition pricing | NOT APPLICABLE | No purchasing condition engine exists. Display shows the stored net price and does not calculate another one. |
| Purchasing output | NOT APPLICABLE | No contract output engine exists. Display refuses an output parameter and does not send a message. |
| Service, limit, tolerances, long text, incoterms version | NOT APPLICABLE | Those fields are not stored. They were not invented. |
| ME31L | NOT APPLICABLE | Not this package. |

Migration `9149` is applied. It moves only the display route. `tests/purchase-contract.test.ts` passed, 13 tests. Nothing was pushed.
