# Screen links, missing functions, and production gaps

Audit only. No screen was added. No production function was built. The live site was not opened. This is not an S/4HANA 2025 parity claim.

Checked on 23 October 2026 against the code and the local database `cairn_b210`.

## What was compared

- 209 `page.tsx` routes under `src/app`.
- Links written in those screens.
- `BUILT_ROUTES` in `src/app/config/page.tsx` (84 routes). Every one of those routes has a page. None points at a missing page.
- `scripts/seed.ts`: 87 workbench activities and 201 command-bar terms, including CO01, MD01, MD04, MIGO, ME21N, and MB1A.
- This database: 61 `term_registry` rows and 19 `config_activity` rows. The seed catalogue is not loaded here. The walked site was not queried, so this does not say what that site’s command bar contains.

No in-page link was found that points at a route with no page.

## Missing links

The command bar is the intended way to open a screen. On this database it cannot, because the seed terms were never inserted.

Not registered here, though the page exists and the seed names it:

- Production: `/production/orders`, `/production/mrp-run`, `/production/stock-requirements`.
- The earlier finance, inventory, and purchasing screens (journal, MIGO, purchase order, invoice, payments, and the rest of that set).
- The 19 registered terms are the later controlling, batch, contract, and scheduling-agreement rows. Their routes exist.

The workbench on this database lists 19 activities, all later batch and production-config steps. It does not list company code, chart of accounts, plants, or the other seed activities. Those pages exist. The launchpad still says “51 activities”; the seed list is 87; this database has 19.

Follow-on links that are missing in the page itself:

| From | Does not open |
| --- | --- |
| Production order | MIGO, the stock/requirements list, or the planning run. The only link is the launchpad. |
| Planning run | The production order screen, or the requisition the run created. It does open the stock/requirements list. |
| Stock/requirements list | A production order. It drills to stock, a requisition, a purchase order, the planning run, and a reservation. |
| Internal order create | Original budget, the settlement-rule screen, or individual settlement. It does open the display. |
| Individual settlement and the rule screen | Each other, or the order. Each links only to the launchpad. |
| Purchase order | Goods receipt or invoice verification. |

Physical-inventory count does link to differences and recount. That chain is not in the gap list.

## Missing functions already named in code

These are named and not built. This audit does not start them.

- Bill of material. Components on an order are typed. Planning does not explode dependent demand.
- Routing, work center, and capacity.
- Factory calendar. Lead time is a number of days.
- MRP area.
- Planned-order conversion to a production order or a purchase order.
- Production confirmation. A `PRODCONF` number range exists. No confirmation posts.
- WIP batch creation. The activation flag is stored. The flag does not create a batch.
- ATP.
- Cost estimate and costing sheet. A receipt is valued at standard or moving average, not at a planned cost.
- Technical completion, order closure, and deletion flags.
- External production-order numbering.
- Production-order settlement. Not started.
- A second settlement receiver, and display of a settlement document. Not started.

Stale comments, not missing functions: goods issue to an order and goods receipt from an order both post from MIGO. The production-order file header still calls the receipt deferred. The goods-issue file header still says 261 is refused. The movement table posts 261 from MIGO only, not from the older goods-issue screen.

## Production: what a basic loop already has

Met:

- Create a production order and release it. Release does not move stock.
- A scheduling profile can be stored and snapshotted onto the order. It is not a scheduler.
- Components are stored on the order as entered.
- MIGO can issue those components to a released order, and can receive the finished good. Neither screen is linked from the order.
- A planning run can create or adapt a requisition or a planned order. It posts no stock and no journal. A firmed planned order counts as supply. An existing production order counts as supply and is not exploded.
- The stock/requirements list shows stock, requisitions, purchase orders, firmed planned orders, and reservations. It does not show production orders.

Not met for a basic production loop:

1. No bill of material, so the order cannot be built from a master and planning cannot create component demand.
2. No way to turn a planned order into a production order.
3. The stock/requirements list does not show the production order the planning run already counts.
4. No confirmation of yield, scrap, or time.
5. The order screen does not open the issue or the receipt.
6. No technical completion or close.
7. No cost estimate, and no settlement of the order. Settlement was not started.

A walk of create, release, issue, and receipt can already be done by typing the routes. It cannot be done from the command bar on this database, and the screens do not lead to one another.

## Not done

No screen was opened in a browser. No test was run. The walked site’s registry was not read. Nothing was pushed.
