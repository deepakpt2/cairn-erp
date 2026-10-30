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
import {
  boolean, date, foreignKey, integer, numeric, pgTable, primaryKey,
  timestamp, uniqueIndex, varchar,
} from 'drizzle-orm/pg-core';
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

/** One characteristic a lot can be inspected against: quantitative or qualitative. */
export const inspectionCharacteristic = pgTable(
  'inspection_characteristic',
  {
    client: tenant(),
    characteristicCode: varchar('characteristic_code', { length: 16 }).notNull(),
    description: varchar('description', { length: 80 }).notNull(),
    characteristicType: varchar('characteristic_type', { length: 16 }).notNull(),
    nominalValue: numeric('nominal_value', { precision: 13, scale: 4 }).notNull().default('0'),
    tolerancePlus: numeric('tolerance_plus', { precision: 13, scale: 4 }),
    toleranceMinus: numeric('tolerance_minus', { precision: 13, scale: 4 }),
    unit: varchar('unit', { length: 6 }),
    validFrom: date('valid_from', { mode: 'string' }).notNull().default('2020-01-01'),
    validTo: date('valid_to', { mode: 'string' }).notNull().default('9999-12-31'),
    createdBy: varchar('created_by', { length: 60 }).notNull().default('SYSTEM'),
    changedBy: varchar('changed_by', { length: 60 }),
    changedAt: timestamp('changed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.client, t.characteristicCode] }),
  ],
);

/** One measured result against one characteristic on one lot. */
export const inspectionResult = pgTable(
  'inspection_result',
  {
    client: tenant(),
    lotNumber: varchar('lot_number', { length: 20 }).notNull(),
    characteristicCode: varchar('characteristic_code', { length: 16 }).notNull(),
    resultValue: varchar('result_value', { length: 40 }).notNull(),
    measuredUnit: varchar('measured_unit', { length: 6 }),
    resultStatus: varchar('result_status', { length: 16 }).notNull().default('RECORDED'),
    recordedBy: varchar('recorded_by', { length: 60 }).notNull().default('SYSTEM'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    changedBy: varchar('changed_by', { length: 60 }),
    changedAt: timestamp('changed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.client, t.lotNumber, t.characteristicCode] }),
    foreignKey({
      name: 'inspection_result_lot_fk',
      columns: [t.client, t.lotNumber],
      foreignColumns: [qualityLot.client, qualityLot.lotNumber],
    }).onDelete('restrict'),
    foreignKey({
      name: 'inspection_result_characteristic_fk',
      columns: [t.client, t.characteristicCode],
      foreignColumns: [inspectionCharacteristic.client, inspectionCharacteristic.characteristicCode],
    }).onDelete('restrict'),
  ],
);

/** The usage decision on one lot: accept, reject, block or rework. */
export const usageDecision = pgTable(
  'usage_decision',
  {
    client: tenant(),
    lotNumber: varchar('lot_number', { length: 20 }).notNull(),
    decisionCode: varchar('decision_code', { length: 16 }).notNull(),
    decisionDate: date('decision_date', { mode: 'string' }).notNull().default(sql`CURRENT_DATE`),
    decidedBy: varchar('decided_by', { length: 60 }).notNull().default('SYSTEM'),
    stockPosted: boolean('stock_posted').notNull().default(false),
    stockDocumentNumber: varchar('stock_document_number', { length: 20 }),
    stockDocumentLine: integer('stock_document_line'),
    createdBy: varchar('created_by', { length: 60 }).notNull().default('SYSTEM'),
    changedBy: varchar('changed_by', { length: 60 }),
    changedAt: timestamp('changed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.client, t.lotNumber] }),
    foreignKey({
      name: 'usage_decision_lot_fk',
      columns: [t.client, t.lotNumber],
      foreignColumns: [qualityLot.client, qualityLot.lotNumber],
    }).onDelete('restrict'),
  ],
);