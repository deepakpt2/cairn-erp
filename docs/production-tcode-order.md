# Production transactions — the wiring order, and what it has become

A wiring order, not a build. The order below is the one the module was cut to; steps 1 to 9 and step 11 have
since been executed, and each line now says where the result lives. What is not wired is named as not wired.
This is not an S/4HANA 2025 layout. Transaction names below are the ordinary discrete-manufacturing codes.
Process orders, repetitive manufacturing, printing, archiving, and batch determination are not in this sequence.

`CA01` in the standard package is a chart-of-accounts key. It is not the routing transaction.

## Already present

Do not rebuild these.

- `CO01` creates a production order and releases it, at `/production/orders`. The components come from the
  production version's bill of material — the create screen offers no component rows of its own — and the
  snapshot is not re-read afterwards.
- `CO02` and `CO03` change and display a saved order — `/production/production-order-change` and
  `/production/production-order-display`. The change carries the quantity, the dates and the component snapshot
  while no goods movement has been posted against the line; it does not re-read the bill of material. Technical
  completion and its revocation are in the same service (`technicallyCompleteProductionOrder`,
  `revokeTechnicalCompletion`), not a separate transaction.
- `MD01` plans a plant at `/production/mrp-run` and **does** explode a bill of material: a make proposal is
  exploded by the shared single-item explosion (`explodePlannedSupply` in `mrp-explosion.ts`); a bought material
  is not exploded, and dependent demand is a planning record, not an order. It does not post, and it does not
  become the order itself — `CO40` does that.
- `MD02` and `MD03` are the same explosion at one material: `/production/single-item-planning` and
  `/production/single-level-planning`.
- `MD04` lists stock, requisitions, purchase orders, planned orders, reservations **and the production order**:
  the order is a receipt element and its components are the demand under it (`stock-requirements.ts`). A receipt
  line that stands against a cancelled document is excluded by its reversal lineage, not by a status guess.
- `MD11`, `MD12` and `MD13` create, change and display a planned order: `/production/planned-order-create`,
  `…-change`, `…-display`. `CO40` and `CO41` convert one planned order and a selection of them:
  `/production/planned-order-conversion` and `…-collective`.
- `OPKP` stores a scheduling profile. The order snapshots it.
- `OMCWB` stores the WIP-batch activation flag. It does not create a batch.
- Goods issue **to** the order posts as movement 261 and is offered by MIGO alone
  (`/inventory/migo`); `MB1A` refuses a 261 by name and says which screen posts it. Goods receipt **from** the
  order is `PROD.ORDER.GR` — `production-receipt.ts`, MIGO 101 + R08 — so no second receipt transaction was
  added, and none is needed.
- `CR01`/`CR02`/`CR03` work centres (`/production/work-centers`, `/production/work-center-display`),
  `CS01`/`CS02`/`CS03` material bills of material (`/production/boms`, `/production/bom-display`),
  `CA01`/`CA02`/`CA03` routings (`/production/routings`, `/production/routing-display`) and `C223` production
  versions (`/production/production-versions`, `/production/production-version-display`) are screens with their
  own display route, and `CO01` reads the version rather than a typed list.
- `CO11N` confirms one operation, and it now posts what the material asks for: a component marked for backflush is
  withdrawn and a final confirmation of a marked finished good is received, in the confirmation's own transaction,
  through the MIGO services. `CO13` cancels the confirmation and refuses while a document it caused still stands.
  `CO15` confirms the order header and posts no movement. The time ticket is `PROD.CONFIRM.ENTER` at
  `/production/time-ticket`.
- The two marks live on the material's plant view, on the MRP screen. A material carries neither mark by default,
  so a confirmation posts no movement until someone maintains it there. No order type, scheduling profile, or
  confirmation profile overrides that decision.

## Order to wire

Each step is what the next step reads. Change and display belong with the create. They are not separate projects.
The steps are kept in this order, and each carries what was delivered against it.

1. `CR01`, `CR02`, `CR03` — work center. **Wired:** `/production/work-centers` and its display companion, over
   `work-center.ts`. A routing has nowhere to put an operation until a work centre exists, and confirming an
   operation needs the same master.
2. `CS01`, `CS02`, `CS03` — material bill of material. **Wired:** `/production/boms` and `/production/bom-display`
   over `material-bom.ts`. `CO01` reads it through a production version, and dependent demand exists.
3. `CA01`, `CA02`, `CA03` — routing. **Wired:** `/production/routings` and `/production/routing-display` over
   `routing.ts`. It names the work centre from step 1 and the operations a confirmation posts against. Do not
   reuse the chart-of-accounts key `CA01`.
4. `C223` — production version for a material and plant. **Wired:** `/production/production-versions` over
   `production-version.ts`; it is the link from the material to one bill of material and one routing, and the
   snapshot a saved order keeps.
5. `MD02` — single-item, multi-level planning. **Wired:** `/production/single-item-planning`, sharing the
   explosion `MD01` uses.
6. `MD13`, `MD12`, `MD11` — display, change, and manual create of a planned order. **Wired:** the three
   `/production/planned-order-*` routes. Manual create is only for an order the run did not propose.
7. `CO40` — convert one planned order into a production order. **Wired:** `/production/planned-order-conversion`;
   the order carries the components of the snapshot, not a second typed list.
8. `CO41` — convert the selected planned orders together. **Wired:** `/production/planned-order-conversion-collective`.
9. `CO03`, `CO02` — display, then change, the production order. **Wired**, with technical completion and its
   revocation in the same service, after confirmation and receipt.
10. `CO11N` — confirm yield, scrap, and time against the operations. Done, with `CO13` and `CO15` beside it. The
    time ticket stores no activity cost, no personnel, and no shift, and it does not change the order status. What
    it moves is read from the material's own plant marks on the MRP view, and the browser target `co11n-movement`
    drives those marks, the withdrawal, the receipt a final confirmation causes, and the `CO13` refusal that waits
    for the reversal.
11. MIGO issue and receipt stay the goods movements. Wired: the order and the confirmation now reach them, and no
    second goods-receipt transaction was added. What is still not wired is named on the confirmation screen —
    scrap is not grossed into a component quantity, no order type switches a receipt on or off, a batch is not
    determined, and a reservation is not cleared by an issue.
12. `CO88` — settle the production order. Implemented at `/production/order-settlement` (PROD.ORDER.SETTLE). The run
    settles actual costs collected on the order — journal lines that cite it — to configured receivers through
    `postJournalEntry`. A settlement rule must be stored first (`/production/settlement-rules`); no receiver or
    percentage is assumed. Cost estimates, WIP calculation (DV-003), and variance categorization (DV-004) remain
    deferred under `docs/DEFERRED_ISSUES.md` DI-012.

## Not in this sequence

These are real, and they are not the next wire.

- `CO09` availability: a read-only overview is delivered at `/production/order-availability` — the elements and
  the per-component answer for one order per run. It writes no commitment, no reservation and no re-check on
  release, and it refuses a reset and a collective check by name (`order-availability.ts`). The gap matrix and the
  refusal set are `docs/co09-availability-audit.md`; that screen is under active work, so read the module and the
  audit rather than this list.
- Mass release and printing are not required to make one order flow. The order information system is not a gap:
  `/production/order-information` lists orders, confirmations and the documents they caused.
- Process-order transactions are a different module. They are not this list.
