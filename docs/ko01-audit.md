# KO01, KO02, and KO03

This is not an S/4HANA 2025 parity claim.

KO01 creates an internal order. KO02 changes one. KO03 displays one. Saving does not post, budget, plan, or settle.

## What was already here

Controlling area, company-code assignment, cost center, and profit center already exist. Journal lines already store `internal_order` as text of length 20. Posting copies that text and does not validate a master. No internal-order table, order type, route, or status profile existed.

## What this package stores

Migration `9152` adds `internal_order_type` and `internal_order`. It does not add a foreign key from the journal line. Existing free-text order codes remain valid.

`IO01` is seeded configuration. The service refuses an unknown type. It does not treat `IO01` as a hardcoded meaning.

The number comes from the existing `INTORDER` range. A typed number is refused. External ranges are refused by the existing number service. There is no second allocator.

Currency follows the controlling area. Company code must be assigned to that area. Cost center and profit center are optional and are checked only when entered. No status code is stored.

## What a save does not do

Create and change do not insert a journal, a budget, a plan, a commitment, or a settlement document. A change does not rewrite a journal line that already cites the order. If the new dates would exclude that line's posting date, the change is refused and the line stays as posted.

KO03 accepts only the client and order number. It does not take a change lock and does not change last-modified data.

A marked order cannot be changed. The row is not deleted.

## Gaps, not built here

Posting still does not read the master. The stored posting lock is not consulted by a goods movement or a journal. Statistical is stored and not executed.

There is no status profile, so no system or user status is invented.

KO04, KOH1, KO12, KO22, KO30, KOB1, and KO88 are not implemented. Creating an order does not settle it.

This is not an S/4HANA 2025 parity claim.
