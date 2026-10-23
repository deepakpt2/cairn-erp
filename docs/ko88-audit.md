# KO88 / KO8G audit

Date checked: 2026-10-23. This is not S/4HANA 2025 field parity. Program source for that release was not available.

## What was already there

- An internal order stores a statistical flag, a posting lock, and a deletion mark. No status profile is stored, so release and close are not checked.
- Journal lines may cite an internal order as text. `postJournalEntry` posts a balanced journal. Period control on that poster is real.
- No settlement profile, distribution rule, allocation structure, settlement document, maintenance order, order group, selection variant, or background job was stored.
- `settleQuota` is a purchasing quota settlement. Production-order settlement is named and not implemented. That is CO88, not this package.
- KO8B is display of a settlement document. It was not built.

## What this package does

KO88 (`/controlling/order-settlement`) names one internal order. A range or an order type is rejected.

KO8G (`/controlling/order-settlement-collective`) selects internal orders and calls the same `settleOne` function. A range that matches nothing is an empty selection. A named order that does not exist is an invalid selection.

A settlement rule is stored at `/controlling/settlement-rules`. That screen has no SAP transaction code. Saving it does not post. It does not fill in a receiver, a percentage, a document type, or an account. KO02 is not reopened.

An update posts only when the order type has a settlement profile, the allocation structure assigns every source account being settled, and a distribution rule names the receiver and the share. The posting date is the end of the entered settlement period. It is not today's date, and a different posting period is not accepted. The journal is created by `postJournalEntry`. A settlement document row points at that journal. The journal is not deleted. A reversal screen was not added.

A test run calculates the same amount and posts nothing. A repeated request key returns the same document. A second update with no remaining balance posts nothing. Two concurrent updates of one order create one document. A percentage that does not total 100 is not topped up. An unmapped source account stops the order. A statistical or deletion-marked order is not settled. The order's own cost center is not used as a receiver unless a rule names it.

Maintenance orders are not selected. Production and process orders are not selected.

## What was not closed

KO8B, KO9E, KO9G, CO88, and CJ88 were not built. Asset settlement, selection variants, order groups, and background execution are refused. A processing type is not assumed when both periodic and full rules apply. No status profile is configured, so release is not checked and is not invented.

## Checks

`tests/order-settlement.test.ts` covers the refusal, the KO88/KO8G split, a balanced posted document, a test run that does not post, replay, a concurrent pair, a partial percentage, and an unmapped account. It does not claim S/4HANA 2025 parity.
