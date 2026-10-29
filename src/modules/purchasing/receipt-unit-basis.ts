import { sql, type SQL } from 'drizzle-orm';

/**
 * The received-quantity basis for purchase-order readers.
 *
 * A material document line keeps two pairs of figures: the quantity as it was entered
 * (`entry_quantity` / `entry_unit`) and the quantity in the material's base unit
 * (`base_quantity` / `base_unit`). The first is what the order line counts, the second is
 * what stock, valuation and the inventory-facing screens count. Goods-receipt posting
 * converts one into the other (`inventory/goods-receipt.ts`), so a purchase-order screen that
 * reads `base_quantity` and compares it with `purchase_order_item.quantity` is measuring an
 * alternative-unit line in the wrong unit — a line ordered as 3 boxes arrives as 36 pieces
 * and the order reads as over-received by a factor of twelve.
 *
 * This module states the line's figure once, in the unit the order item counts in, so every
 * purchase-order reader agrees and no reader converts twice. Three shapes are distinguished,
 * in this order:
 *
 *  1. the entered pair is already in the order unit — the whole of goods receipt, whose
 *     entered unit is the order item's unit by construction, in both the converted and the
 *     pre-conversion writing;
 *  2. the base pair names the material's own base unit — the figure was converted at posting,
 *     so it is brought back with the material's conversion and rounded the way
 *     `inventory/unit-conversion.ts` rounds (`fromBaseQuantity`): to the unit's maintained
 *     decimal places, three when the unit carries none. This is the shape of a return delivery
 *     entered in another unit, and the conversion is applied exactly once;
 *  3. the base pair names the order unit while the material counts in another — a receipt
 *     posted before the conversion was introduced, whose stored base figure is the entered
 *     figure. Taking branch 2's arithmetic here would divide the historical number by a factor
 *     the posting never applied, so the stored figure is used as it stands. This is a live read
 *     of a legacy row, not a reconciliation of it: the historical figures stay untouched and
 *     the audit script (`gr-legacy-unit-audit.sql`, outside this repository) is what reports
 *     them.
 *
 * A line that fits none of the three yields NULL rather than a guess. `purchasing/grir-clearing.ts`
 * refuses an item whose residual depends on such a line; the informational screens add what
 * they can state, which is what they did before this module existed.
 */

/**
 * The joins the basis needs. Every query that uses it aliases `material_document_line` as
 * `l`, which is the only alias these expressions depend on. `ri`, `rm`, `ru` and `ruom` are
 * reserved here so that a caller's own aliases (`mv` for the movement catalogue, `d` or `h`
 * for the document header, `m` in the list readers) cannot collide with them.
 */
export const receiptUnitJoins = sql`
  left join purchase_order_item ri
    on ri.client = l.client and ri.order_number = l.purchase_order_number and ri.item_number = l.purchase_order_item
  left join material rm on rm.client = l.client and rm.material_number = l.material_number
  left join material_uom_conversion ru
    on ru.client = l.client and ru.material_number = l.material_number and ru.alternative_unit = ri.unit
  left join unit_of_measure ruom on ruom.code = ri.unit
`;

/** The received figure in the unit the order item counts in, or NULL when it cannot be stated. */
export const receiptQuantityInOrderUnit = sql`
  case
    when l.entry_unit is not distinct from ri.unit then l.entry_quantity
    -- The inverse of the posting's conversion: base × denominator / numerator, the same
    -- expression and the same rounding as fromBaseQuantity in inventory/unit-conversion.ts.
    when l.base_unit is not distinct from rm.base_unit
         and ru.numerator is not null and ru.denominator is not null and ru.numerator <> 0
      then round(l.base_quantity * ru.denominator::numeric / nullif(ru.numerator, 0)::numeric,
                 coalesce(ruom.decimal_places, 3))
    when l.base_unit is not distinct from ri.unit then l.base_quantity
  end
`;

/** True when the line cannot be placed in the order unit, so a reader must refuse instead of adding nothing. */
export const receiptQuantityUnstateable = sql`(${receiptQuantityInOrderUnit}) is null`;

/**
 * The sign a movement line carries in the received figure of the order line it points at.
 *
 * `movement_type.direction` states what a movement does to stock, which is not the same as how
 * a purchase-order reader adds it up. Three cases have to be told apart:
 *
 *  - `RECEIPT` adds — the goods reached the plant, which is what a receipt of a purchase order
 *    line is for;
 *  - `ISSUE` takes back. A return to the vendor is an issue movement that carries the order
 *    number and item, and it belongs to the order line as a subtraction: goods that went back were
 *    not kept. Counting it as a receipt reports a line received and returned in full as received
 *    twice over, and the line then reads delivered, nothing outstanding;
 *  - `REVERSAL` cancels the line it was posted against. The reversal module copies the original
 *    line's figures verbatim and names it in `reversal_of_document` / `reversal_of_line`, so a
 *    reversal negates the sign that line carried rather than always subtracting: reversing a
 *    receipt takes the goods away, reversing a return puts them back. Where the reversed line
 *    cannot be found — a document reversed by hand, or one recorded before the lineage columns
 *    were set — the reversal subtracts, which is the reading every screen gave it before.
 *
 * `TRANSFER` is neither: no PO-carried movement uses it, and the readers leave it adding, as they
 * did. The movement-side reading of the same three cases is
 * `inventory/goods-receipt.ts` and `purchasing/grir-clearing.ts`.
 *
 * A reversal therefore cancels through the line it points at, not through its document header:
 * `material_document.status` marks a reversed document `REVERSED` or `PARTIALLY_REVERSED` precisely
 * so that its lines stay readable, and a reader that skips those lines while also counting the
 * posted reversal takes the quantity back twice. Those are the only three statuses the header can
 * carry, so dropping the status predicate lets in nothing that was not posted.
 */
export function receiptMovementSign(movementAlias = 'm'): SQL {
  const movement = sql.raw(movementAlias);
  return sql`case ${movement}.direction
    when 'REVERSAL' then -(case when exists (
      select 1
        from material_document_line rev
        join movement_type rev_mv
          on rev_mv.client = rev.client and rev_mv.movement_type = rev.movement_type
         and rev_mv.direction = 'ISSUE'
       where rev.client = l.client
         and rev.material_document_number = l.reversal_of_document
         and rev.line_number = l.reversal_of_line
    ) then -1 else 1 end)
    when 'ISSUE' then -1
    else 1
  end`;
}
