# Production transactions not yet implemented

A wiring order, not a build. Nothing was added. This is not an S/4HANA 2025 layout. Transaction names below are the ordinary discrete-manufacturing codes. Process orders, repetitive manufacturing, printing, archiving, and batch determination are not in this sequence.

`CA01` in the standard package is a chart-of-accounts key. It is not the routing transaction.

## Already present

Do not rebuild these.

- `CO01` creates a production order and releases it. Components are typed. There is no change and no technical completion.
- `MD01` plans a plant and writes a requisition or a planned order. It does not explode a bill of material, and it does not turn a planned order into a production order.
- `MD04` lists stock, requisitions, purchase orders, planned orders, and reservations. It does not list a production order.
- `OPKP` stores a scheduling profile. The order snapshots it.
- `OMCWB` stores the WIP-batch activation flag. It does not create a batch.
- Goods issue to the order and goods receipt from the order already post from MIGO. A second receipt transaction is not required.
- `CO11N` confirms one operation, and it now posts what the material asks for: a component marked for backflush is withdrawn and a final confirmation of a marked finished good is received, in the confirmation's own transaction, through the MIGO services. `CO13` cancels the confirmation and refuses while a document it caused still stands. `CO15` confirms the order header and posts no movement.
- The two marks live on the material's plant view, on the MRP screen. A material carries neither mark by default, so a confirmation posts no movement until someone maintains it there. No order type, scheduling profile, or confirmation profile overrides that decision.

## Order to wire

Each step is what the next step reads. Change and display belong with the create. They are not separate projects.

1. `CR01`, `CR02`, `CR03` — work center. A routing has nowhere to put an operation until a work center exists. Confirmation of an operation needs the same master.
2. `CS01`, `CS02`, `CS03` — material bill of material. This is the master `CO01` should read instead of a typed component list, and the master `MD01` should explode. Dependent demand does not exist until this does.
3. `CA01`, `CA02`, `CA03` — routing. It names the work center from step 1 and the operations a confirmation will post against. Do not reuse the chart-of-accounts key `CA01`.
4. `C223` — production version for a material and plant. It is the link from the material to one bill of material and one routing. `CO01` and `MD01` should read this, not a typed snapshot.
5. `MD02` — single-item, multi-level planning. Plan one material through the bill of material before relying on the plant run. `MD01` already exists and should then use the same explosion. It is not a new transaction.
6. `MD13`, `MD12`, `MD11` — display, change, and manual create of a planned order. `MD01` already stores planned orders. Nothing opens one. Display first, then change. Manual create is only for an order the run did not propose.
7. `CO40` — convert one planned order into a production order. This is the missing link between `MD01` and `CO01`. The order it creates should carry the components from the bill of material, not a second typed list.
8. `CO41` — convert the selected planned orders together. Only after one conversion is right.
9. `CO03`, `CO02` — display, then change, the production order. Create and release already exist. Quantity, dates, and components cannot be changed. Technical completion is a later use of `CO02`, after confirmation and receipt. It is not a separate transaction.
10. `CO11N` — confirm yield, scrap, and time against the operations. Done, with `CO13` and `CO15` beside it. The time ticket stores no activity cost, no personnel, and no shift, and it does not change the order status. What it moves is read from the material's own plant marks on the MRP view, and the browser target `co11n-movement` drives those marks, the withdrawal, the receipt a final confirmation causes, and the `CO13` refusal that waits for the reversal.
11. MIGO issue and receipt stay the goods movements. Wired: the order and the confirmation now reach them, and no second goods-receipt transaction was added. What is still not wired is named on the confirmation screen — scrap is not grossed into a component quantity, no order type switches a receipt on or off, a batch is not determined, and a reservation is not cleared by an issue.
12. `CO88` — settle the production order. Last. It is not started. It should run only after the order can be technically completed. A cost estimate has no transaction in this application, and none is assigned here.

## Not in this sequence

These are real, and they are not the next wire.

- `MD04` must show the production order. That is a gap in the existing list, not a new transaction.
- `CO09` availability was deferred by name. It is not required to connect the bill of material, the order, the confirmation, and the receipt. `docs/co09-availability-audit.md` now holds the audit, the gap matrix and the first-slice specification; the deferral itself stands until that is scheduled.
- Mass release, printing, and the order information system are not required to make one order flow.
- Process-order transactions are a different module. They are not this list.
