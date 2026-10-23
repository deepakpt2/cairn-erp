# ME31K purchase contract

This is not an S/4HANA 2025 parity claim. No official field list or program source for that release was available. MK and WK are configured type rows. They are not meanings in the service.

ME31L, scheduling agreements, service items, limit items, asset, WBS, and internal-order assignment were not built.

## Before this change

| Check | Verdict |
| --- | --- |
| Contract table, route, or capability | FAIL. None existed. |
| Purchase-order tables as the contract | FAIL. Those checks allow only a standard order. A contract row would be rejected. |
| Release category | FAIL. Only requisition and purchase order. |
| Account assignment | PARTIAL. Cost centre exists. Asset, WBS, and internal order do not. |
| Item category | PARTIAL. Standard only. |
| Pricing | PARTIAL. Typed price and info-record price exist. Condition pricing does not. |
| Supplier, organization, plant, requisition, numbering, change audit | PASS. Already present and reused. |

## After this change

| Check | Verdict | Where |
| --- | --- | --- |
| Quantity contract commits a target quantity | PASS | `purchase_contract_item.target_quantity`. A saved purchase order consumes it. Excess is refused. No overdelivery tolerance is configured. |
| Value contract commits a header target value | PASS | Item values may exceed the header. That is a warning, not a refusal. Call-off value is the purchase-order net value. |
| Called-off, goods receipt, invoice, and remaining are distinct | PASS | Called-off is the saved purchase-order quantity. A receipt of 2 against a call-off of 4 left called-off at 4 and remaining at 6. The receipt figure was 2. The invoice figure was the posted invoice value. The receipt sign follows the existing goods-receipt rule. |
| Plant and storage location not required | PASS | A contract item saved with no plant. A storage location without a plant is refused. |
| MK and WK not hardcoded | PASS | The service reads `purchasing_contract_type`. An unconfigured type is refused. Migration and new-tenant creation insert MK as quantity and WK as value. |
| Release is not universal | PASS | No strategy leaves the contract `NOT_REQUIRED`. A claiming strategy leaves it `PENDING`, and a call-off is then refused until ME35K releases it. |
| Creation does not change stock or accounting | PASS | Contract creation left material-document and journal counts unchanged. |
| Call-off is a saved purchase order | PASS | There is no draft status in this ERP. A marked-for-deletion order item does not consume the contract. |
| Reference copy does not change the source | PASS | A copied contract, a requisition, an RFQ, and a quotation kept their own quantities and prices. The contract stored the source identity and the quotation price. |
| Tenant isolation | PASS | Another tenant cannot read the contract. |
| ME31L | NOT APPLICABLE | Not this package. |
| Omitted price | PASS | An info record supplied the omitted contract price. A typed price is kept. There is no second pricing calculator. |
| Service, limit, asset, WBS, internal order | NOT APPLICABLE | Those masters or categories do not exist. The contract accepts only standard items and cost centre. |

Purchasing output determination does not exist in this ERP. Contract creation does not invent one. Material-document output remains the goods-receipt path.

Migrations `9147` and `9148` are applied. `tests/purchase-contract.test.ts` passed, 10 tests. `tests/batch-assignment.test.ts` passed, so a purchase order without a contract still saves.

Route: `/purchasing/contracts`. Aliases: ME31K, ME32K, ME33K, ME35K, ME3N. A call-off is ME21N with the contract number and item.
