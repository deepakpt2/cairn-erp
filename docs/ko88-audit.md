# KO88 / KO8G audit

Date checked: 2026-10-23, with the settlement ownership split re-checked 2026-10-26. This is not S/4HANA 2025 field parity. Program source for that release was not available.

## What was already there

- An internal order stores a statistical flag, a posting lock, and a deletion mark. No status profile is stored, so release and close are not checked.
- Journal lines may cite an internal order as text. `postJournalEntry` posts a balanced journal. Period control on that poster is real.
- No settlement profile, distribution rule, allocation structure, settlement document, maintenance order, order group, selection variant, or background job was stored.
- `settleQuota` is a purchasing quota settlement. Production-order settlement is named and not implemented. That is CO88, not this package.
- KO8B is display of a settlement document. It was not built.

## What this package does

KO88 (`/controlling/order-settlement`) names one internal order. A range or an order type is rejected.

KO8G (`/controlling/order-settlement-collective`) selects internal orders and calls the same `settleOne` function. A range that matches nothing is an empty selection. A named order that does not exist is an invalid selection.

A settlement rule is stored at `/controlling/settlement-rules`: the receiver of one order, its share, and the period range it is valid over. That screen has no SAP transaction code. Saving it does not post. It does not fill in a receiver, a percentage, a document type, or an account. KO02 is not reopened. It writes `settlement_distribution_rule` and nothing else. A payload that still names a master field — a profile code, a profile or structure description, a document type, a source account, the original-account choice — is refused by name, because a field nobody read would look like a setting the user had stored.

The rows an order type shares are maintained at `/config/settlement-configuration` under `CFG.COST.SETTLEMENT.DEFINE`: the allocation structure, its account assignments, the settlement profile, and the settlement profile an internal order type reads. The profile states its document type and its allowed distribution methods there. None of them is inferred from the share one order happened to save last, and a rule save changes none of those four tables — not one description, not one timestamp.

| Row | Stored by | Read by |
| --- | --- | --- |
| `settlement_distribution_rule` | `/controlling/settlement-rules`, `CO.SETTLE.RULE` | the run; the rule screen replaces the whole set for one order |
| `allocation_structure`, `allocation_structure_assignment` | `/config/settlement-configuration`, `CFG.COST.SETTLEMENT.DEFINE` | the run; the rule screen only to refuse against |
| `settlement_profile`, `internal_order_type_settlement_profile` | the same | the run, the rule screen, and the masters' own dependency checks |

An update posts only when the order type has a settlement profile, the allocation structure assigns every source account being settled, and a distribution rule names the receiver and the share. The posting date is the end of the entered settlement period. It is not today's date, and a different posting period is not accepted. The journal is created by `postJournalEntry`. A settlement document row points at that journal. The journal is not deleted. A reversal screen was not added.

A test run calculates the same amount and posts nothing. A repeated request key returns the same document. A second update with no remaining balance posts nothing. Two concurrent updates of one order create one document. A percentage that does not total 100 is not topped up. An unmapped source account stops the order. A statistical or deletion-marked order is not settled. The order's own cost center is not used as a receiver unless a rule names it.

Maintenance orders are not selected. Production and process orders are not selected.

## What was not closed

KO8B, KO9E, KO9G, CO88, and CJ88 were not built. Asset settlement, selection variants, order groups, and background execution are refused. A processing type is not assumed when both periodic and full rules apply. No status profile is configured, so release is not checked and is not invented.

## What the masters refuse

A shared row is refused rather than changed into something an order can no longer settle.

- An account a balance still stands on keeps its assignment: changing or removing it while an order that reads the structure carries a non-zero net on that account is refused, with the orders named. Where those orders have settlement documents behind them and no live balance, the change needs an explicit confirmation.
- A profile an order type resolves to stays active. Deactivating it is refused while the type reads it, so no order is left pointing at an inactive profile: the assignment is removed first, then the profile is deactivated. Reactivating is done where the profiles are listed, not from the deactivation form.
- A profile keeps allowing every method a rule of its orders uses. Clearing the percentage flag while a rule distributes by percentage is refused.
- Repointing an order type onto another profile, or a profile onto another structure, is refused when a balance of an order of that type would land on an account the target structure does not assign for the receiver category the rule names.
- A profile's document type is an explicit field. It is never taken from an order, and `SA` is not assumed.
- Nothing is seeded. A profile, a structure, and an account mapping are the customer's decision; a default account would be posted to a general ledger. A new tenant finds these four tables empty, and its first rule save says which master is missing.

## Concurrency

An update takes the advisory key of the order's rule (`lockSettlementRuleForOrder`) before it reads the rule, and reads the order header and the shared master rows `for share`. A rule save and a master save take those rows `for update`, so a change waits behind the posting rather than slipping between its decision and its commit; two runs still read side by side, and a test run takes no lock at all. A run therefore settles on one configuration snapshot: one profile, one structure, one set of rules, from one point of its transaction. The repeated request key, the second update with no balance left, and the freeze of a rule by a settlement document behave as they did before the split.

## Checks

`tests/order-settlement.test.ts` covers the refusal, the KO88/KO8G split, a balanced posted document, a test run that does not post, replay, a concurrent pair, a partial percentage, and an unmapped account. It does not claim S/4HANA 2025 parity. `tests/config-settlement-master-contract.test.ts` covers the masters themselves: an explicit document type and method set, a create that never overwrites, a stale version, the refusals above, and the confirmation a settled order asks for. `tests/controlling-settlement-rule-contract.test.ts` covers the boundary: the four shared tables digested before and after a rule save, a refused legacy payload, and a rule refused because its profile does not allow the method or its structure assigns nothing for the receiver category. `tests/controlling-settlement-concurrency.test.ts` covers the locks: a run that waits while a profile is changed mid-flight, a test run that is not held, and one document from two sessions. `tests/config-settlement-configuration-registry.test.ts` covers the registration the workbench reads, and that no settlement default arrives with it.
