# ME84 — Create scheduling agreement releases

This is not an S/4HANA 2025 parity claim.

ME84 creates a supplier-facing release snapshot from the canonical delivery schedule. It does not change that schedule, create a purchase order, post stock or accounting, or notify the supplier.

## What was already here

ME31L, ME32L, ME33L, ME38, and ME39 already share `scheduling_agreement`, its items, and its schedule lines. `LP` is seeded configuration. Creation of an agreement does not create a schedule line. ME38 maintains the lines and does not send a release.

`document_release` is the approval release used by ME35L. It is not a supplier scheduling release. ME84 reads it and does not approve the agreement.

Material-document output is MB90. It renders goods-receipt and goods-issue slips. It is not purchasing message determination. There is no job framework. The existing number service refuses an external range.

No release document, release profile, forecast/JIT flag, or ME84 route existed.

## What this package stores

Migration `9153` adds a release-documentation flag on the agreement type. Existing `LP` rows stay false. `LPA` is seeded with the flag true. The service reads the flag. It does not treat the code `LPA` as a meaning.

It also adds `scheduling_release_profile` and an assignment by supplier, purchasing organization, plant, and release type. No profile, horizon, or tolerance is seeded. A missing profile is reported. It is not replaced by a sample percentage.

JIT stays off unless the agreement item and the material plant both say so. Those columns default false. Forecast does not use them.

A created release stores the agreement, item, release type, profile used, generation date, and the aggregated lines. `released_quantity` is the total of that snapshot. It is not a goods-receipt cumulative. Transmission status is `NOT_TRANSMITTED`. The check constraint does not allow a sent status.

## How a run decides

The selection must name an agreement, a supplier, a purchasing organization, or a plant. Each selected item is judged on its own. A skip names the agreement and the reason. A failure does not roll back a release that already committed.

An item is skipped when the document type has no release documentation, approval is still pending, the supplier is blocked, JIT is requested but not enabled, no active profile applies, or no schedule line falls in the configured horizon. A null horizon is not turned into a default number of days. Dates are not shifted by a factory calendar. A time of day is not stored, so `NONE` and `DAY` both sum by date.

A later run compares the new snapshot with the previous release of the same type. Line or overall comparison, and any tolerance, come from the profile. An identical snapshot is not created again. The same request key returns the release already stored. The agreement lock is the same advisory lock ME38 uses.

The release is numbered from the internal `SARELEASE` range. An external range is refused by the existing number service.

## What a run does not do

It does not update schedule lines, the agreement header, purchase orders, goods receipts, journals, or `output_message`. It does not mark the supplier as notified. It does not invent an acknowledgement. It does not run in the background. It does not archive a release, and it does not reset an agreed cumulative quantity.

## Gaps, not built here

Purchasing output, print, email, and EDI are not configured for this document. MB90 was not reused.

There is no profile-maintenance transaction. OMUP was not built. The walk agreement is type `LP`, so ME84 reports that release documentation is not used.

JIT indicators have no maintenance screen. ME83 and ME88 are not implemented. There is no scheduler. Finer than a day is not stored. This is not an S/4HANA 2025 parity claim.
