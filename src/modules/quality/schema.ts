/**
 * The inspection lot — CAIRN.md §10.11, and decisions D1 to D5 as recorded in
 * `docs/operational-readiness.md` (2026-10-28).
 *
 * A lot is the record that inspection was asked for. Before it, nothing in the system could say that a
 * received quantity was under inspection: `batch-cockpit.ts` refuses the question outright ("An inspection
 * lot is not stored. Nothing was read."), and the only levers were the quality stock segment and the batch
 * restricted-use indicator. This table adds the document, and only the document.
 *
 * **It names a receipt line and owns nothing else.** Material, plant, storage location, batch, quantity,
 * unit, movement type and the stock segment are all columns of `material_document_line` already, and a lot
 * points at that line rather than copying it. That is not brevity for its own sake: a copied quantity goes
 * stale the moment the receipt is reversed, a copied segment contradicts the movement that posted it, and
 * a second truth about one pallet is exactly the defect the inventory ledger was built to avoid. What the
 * lot stores is what no other row states — its own number, the line it was opened against, the note of the
 * person who opened it, and the key that makes a double submission one act.
 *
 * **It has no power over stock, and no columns yet for what has not been decided.** Opening a lot posts
 * nothing: no `stock_quantity` write, no valuation, no journal, no batch status change (D3). The usage
 * decision arrives with the act that makes it (slice 2), which is why there is no `status`, `decision` or
 * `results` column here — a lifecycle column that only one value could ever reach, and a results table no
 * sampling rule or tolerance exists to fill, are schema guesses rather than records. What the lot's own
 * standing is today, it derives from the document it points at: while that line stands, the lot is open.
 */
import { foreignKey, integer, pgTable, primaryKey, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, client } from '../../platform/tables/tenancy';
import { materialDocumentLine } from '../inventory/schema';

const tenant = () => varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' });

/** The interval a lot number is drawn from: displayed `QL-` plus seven digits, like every other document class. */
export const LOT_RANGE = { objectCode: 'INSPLOT', subObject: '*', prefix: 'QL', length: 7 } as const;

/** One inspection lot: the request that a received quantity be examined, tied to the line that received it. */
export const qualityLot = pgTable(
  'quality_lot',
  {
    client: tenant(),
    lotNumber: varchar('lot_number', { length: 20 }).notNull(),
    /** The receipt line the lot was opened against. The document, not a copy of it. */
    materialDocumentNumber: varchar('material_document_number', { length: 20 }).notNull(),
    materialDocumentLine: integer('material_document_line').notNull(),
    /** What the person who opened the lot wrote about it. The lot's own words, never a result. */
    inspectionNote: varchar('inspection_note', { length: 200 }),
    requestKey: varchar('request_key', { length: 64 }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.lotNumber] }),
    // Restrict, as `9091_mi07_difference_posting.sql` does for the same parent key: a lot outlives no
    // document, and the platform never deletes a document line — a reversal writes a new one.
    foreignKey({
      name: 'quality_lot_source_line_fk',
      columns: [t.client, t.materialDocumentNumber, t.materialDocumentLine],
      foreignColumns: [
        materialDocumentLine.client,
        materialDocumentLine.materialDocumentNumber,
        materialDocumentLine.lineNumber,
      ],
    }).onDelete('restrict'),
    uniqueIndex('quality_lot_request_key_uq')
      .on(t.client, t.requestKey)
      .where(sql`${t.requestKey} is not null`),
    // Duplicate prevention at the source: one lot stands against one receipt line. A second request for the
    // same goods is a decision on the first lot, not a second lot.
    uniqueIndex('quality_lot_source_line_uq').on(t.client, t.materialDocumentNumber, t.materialDocumentLine),
  ],
);
