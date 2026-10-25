import { sql, type SQL } from 'drizzle-orm';

/**
 * Open production quantities are read from material documents, never from a
 * stored counter.
 *
 * A receipt is a line for the order's own material with no component item.
 * A component issue is a line that names the component item. An issue is not
 * a receipt, and a receipt does not reduce component demand.
 *
 * Reversal is by line, never by part of a line's quantity. A line still stands
 * when it is not itself a reversal and no linked reversal cancels that line in
 * full. A full cancel is the same material, the same base unit, the same base
 * quantity, and the same production-order reference when the reversal line
 * carries one. A smaller reversal quantity is not subtracted. A missing or
 * different reference is not inferred from the material or the order. The
 * counter line is not added, and it is not subtracted again.
 *
 * Stored quantities are numeric(23,3). Equality is exact at that scale.
 */
export function lineNotReversed(alias = 'l'): SQL {
  const row = sql.raw(alias);
  return sql`${row}.reversal_of_document is null and not exists (
    select 1
      from material_document_line rev
     where rev.client = ${row}.client
       and rev.reversal_of_document = ${row}.material_document_number
       and rev.reversal_of_line = ${row}.line_number
       and rev.material_number = ${row}.material_number
       and rev.base_unit = ${row}.base_unit
       and rev.base_quantity = ${row}.base_quantity
       and (rev.production_order_number is null or rev.production_order_number = ${row}.production_order_number)
       and (rev.production_order_item is null or rev.production_order_item = ${row}.production_order_item)
  )`;
}

/**
 * A reversal points at the line, but it does not cancel the line under the
 * full-line rule, or the linked reversal quantities exceed the original.
 */
export function lineReversalDisagreement(alias = 'l'): SQL {
  const row = sql.raw(alias);
  return sql`${row}.reversal_of_document is null and (
    exists (
      select 1
        from material_document_line rev
       where rev.client = ${row}.client
         and rev.reversal_of_document = ${row}.material_document_number
         and rev.reversal_of_line = ${row}.line_number
         and not (
           rev.material_number = ${row}.material_number
           and rev.base_unit = ${row}.base_unit
           and rev.base_quantity = ${row}.base_quantity
           and (rev.production_order_number is null or rev.production_order_number = ${row}.production_order_number)
           and (rev.production_order_item is null or rev.production_order_item = ${row}.production_order_item)
         )
    )
    or exists (
      select 1
        from material_document_line rev
       where rev.client = ${row}.client
         and rev.reversal_of_document = ${row}.material_document_number
         and rev.reversal_of_line = ${row}.line_number
      having sum(rev.base_quantity) > ${row}.base_quantity
    )
  )`;
}

export const OPEN_PRODUCTION_DOCUMENT = sql`d.status in ('POSTED', 'PARTIALLY_REVERSED')`;

export const REVERSAL_QUANTITY_DISAGREEMENT =
  'A reversal does not cancel the production line in full. A partial quantity is not supported, so the original quantity still stands. It was not inferred from the material or the order.';
