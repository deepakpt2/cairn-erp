# Status of what is already built

Checked against `scripts/seed.ts` and the pages under `src/app`. No new screen was added.

The screen catalogue in `src/ui/shell/screen-catalog.ts` holds 242 entries over 235 distinct routes, and every one of
those routes has a page under `src/app`, where 236 pages exist. This file no longer repeats the counts it once did
(`169` codes, `166` pages, `71` activities, fourteen routes with no page): none of them could be re-derived from any
rule, and a count nobody can reproduce is how a status file starts to lie. What is checked instead is the link the
counts were standing in for — that nothing in the catalogue or in a screen's own related links points at a page that
is not there, which is what `tests/screen-links.test.ts` holds.

## Broken links between parts that exist

These are the gaps that stop a browser company from posting, or that send a built screen to the wrong place.

**Valuation class is now a screen.** OMSK is `/config/valuation-classes`. It maintains the account category reference, the valuation class, and which classes a reference permits. A packaged tenant still receives `RAW_INVENTORY` and the other delivered classes. An empty tenant creates the class here; saving a plant does not.

**A goods receipt does not have to use a storage location the plant defined.** A purchase order checks the location when one is typed. The receipt accepts a blank location and writes the stock there. The locations from OX09 are then invisible to that stock.

**A requisition does not become a purchase order.** A quotation does not either. The quotation service refuses with “A requisition is not converted.” The screens link to one another. The documents do not.

**Source list and quota are not read when an order is saved.** An info record is read. If its unit or currency disagrees with the line, the order keeps the price that was typed.

**The command bar and the workbench now open the same page for one code.** Tenant administration is `/clients`. The create wizard remains `CFG.PLT.CLIENT.ONBOARD` at `/clients/new`. Number range maintenance is `/config/number-range-objects`; intervals are one link from that screen. Intercompany clearing is `/config/intercompany-clearing` only. Customer credit is `/finance/credit`. A credit control area is still created by the standard package, not by that screen. A workbench step with no page no longer stores a route.

OX17 is connected. A requisition, request for quotation, order, source list and quota all refuse a purchasing organisation that is not assigned to the plant.

## Built screens the command bar cannot open

Controlling area (`OKKP`), its company assignment (`OX19`), and purchasing groups now have command-bar codes and open the same route as the workbench. Number range intervals stay one link from number range objects; they do not have a second code.

These pages still have no command-bar code. They are not workbench steps.

| Screen | Route |
|---|---|
| G/L account display | `/config/gl-accounts/view` |
| Change asset | `/finance/assets/change` |
| Bank country profiles | `/foundation/partners/bank-profiles` |

Asset class `1000` is created only by the standard package, not by a screen. AS01 asks for a class. An empty tenant has none.

Goods receipt writes its own movement `GOODS_RECEIPT_PO` if the movement table is empty. OMJJ maintains that same table, but the first receipt does not depend on OMJJ having been opened.

## Workbench entries that are not built

These steps remain on the plan and no longer store a route, so the workbench says the screen is pending instead of opening a missing page.

Roles, users, pricing procedures, condition records, MRP controllers, lot sizing, scheduling, employee record
types, pay components, deduction rules, and mail. Work centres were on this list and are taken off it: they are
built, at `/production/work-centers` and `/production/work-center-display` over
`src/modules/production/work-center.ts`, with `CFG.PROD.WORKCENTER.DEFINE` as the activity that opens the way.

The first user and the system roles are created with the tenant. There is no later screen for a second user.
