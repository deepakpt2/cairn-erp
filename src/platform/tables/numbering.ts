/**
 * Number ranges — CAIRN.md §5.2 engine E3, D-019
 *
 * Gap-free allocation per client, per object, per document type, per fiscal year.
 * Numbers are never reused and never allocated outside a lock. The integrity
 * report in §16.5 depends on this being genuinely gap-free.
 */
import {
  pgTable,
  varchar,
  char,
  integer,
  bigint,
  boolean,
  numeric,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { auditColumns, client } from './tenancy';

/**
 * Number range objects (SCR-050 / SNRO; R-98).
 *
 * One registry row per standing object per tenant: the maintainable
 * facts (description, number length, consumption warning, year
 * relevance, subobject hint). Object names belong to the application —
 * no screen creates or deletes an object; this table describes the
 * objects the code numbers from.
 */
export const numberRangeObject = pgTable(
  'number_range_object',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    /** SAP-width object name (at most 10): RF_BELEG, MATERIALNR, … */
    objectCode: varchar('object_code', { length: 10 }).notNull(),
    description: varchar('description', { length: 60 }).notNull(),
    /** The number-format length the object's intervals format to. */
    numberLength: integer('number_length').notNull().default(10),
    /** Optional consumption-warning percentage (one decimal), like the reference. */
    warningPercent: numeric('warning_percent', { precision: 3, scale: 1 }),
    /** Whether the object's intervals run per fiscal year. */
    yearRelevant: boolean('year_relevant').notNull().default(false),
    /** What the interval subobject means for this object, where it has one. */
    subobjectHint: varchar('subobject_hint', { length: 30 }),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.objectCode] })],
);

export const numberRange = pgTable(
  'number_range',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    /** Business object the number belongs to, e.g. PURCHORD, RF_BELEG */
    objectCode: varchar('object_code', { length: 40 }).notNull(),
    /** '*' for tenant-wide objects; a company code for accounting numbering. */
    companyCode: varchar('company_code', { length: 10 }).notNull().default('*'),
    /** Document type or sub-object, e.g. POF, INV. Use '*' where the object has no split. */
    subObject: varchar('sub_object', { length: 24 }).notNull().default('*'),
    /**
     * 0 means the range is not year-dependent. A sentinel rather than NULL because
     * fiscal_year is part of the primary key, and key columns cannot be null —
     * which also removes every IS NOT DISTINCT FROM from the allocation path.
     */
    fiscalYear: integer('fiscal_year').notNull().default(0),
    /** Display prefix, e.g. "POF" (D-030). */
    prefix: varchar('prefix', { length: 12 }).notNull().default(''),
    fromNumber: bigint('from_number', { mode: 'number' }).notNull(),
    toNumber: bigint('to_number', { mode: 'number' }).notNull(),
    currentNumber: bigint('current_number', { mode: 'number' }).notNull(),
    /** Zero padding width for the display format. */
    numberLength: integer('number_length').notNull().default(6),
    /** READABLE (prefix-year-number) | CLASSIC (padded numeric only) — D-030 */
    displayStyle: varchar('display_style', { length: 16 }).notNull().default('READABLE'),
    /** Buffered ranges allocate blocks in memory; default is gap-free unbuffered. */
    isBuffered: boolean('is_buffered').notNull().default(false),
    bufferSize: integer('buffer_size').notNull().default(0),
    /**
     * External (user-supplied) numbering. When true the caller provides the value
     * and the engine validates it falls inside the interval and has not been used.
     */
    isExternal: boolean('is_external').notNull().default(false),
    /** ACTIVE | BLOCKED — a blocked range refuses allocation with a clear message. */
    status: varchar('status', { length: 16 }).notNull().default('ACTIVE'),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.objectCode, t.companyCode, t.subObject, t.fiscalYear] }),
    index('number_range_client_object_idx').on(t.client, t.objectCode),
  ],
);

/**
 * Allocation audit. One row per allocated number. This is what lets the integrity
 * report distinguish "number never used" from "document deleted" (§16.5).
 */
export const numberRangeAllocation = pgTable(
  'number_range_allocation',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    objectCode: varchar('object_code', { length: 40 }).notNull(),
    companyCode: varchar('company_code', { length: 10 }).notNull().default('*'),
    subObject: varchar('sub_object', { length: 24 }).notNull(),
    fiscalYear: integer('fiscal_year').notNull().default(0),
    /** Actual interval used, distinct from the document fiscal year. */
    rangeFiscalYear: integer('range_fiscal_year').notNull().default(0),
    allocatedNumber: bigint('allocated_number', { mode: 'number' }).notNull(),
    /** The display string actually shown to the user. */
    displayedNumber: varchar('displayed_number', { length: 40 }).notNull(),
    /** Document that consumed it, filled once the document is written. */
    documentId: varchar('document_id', { length: 80 }),
    allocatedAt: timestamp('allocated_at', { withTimezone: true }).notNull().defaultNow(),
    allocatedBy: varchar('allocated_by', { length: 60 }).notNull(),
  },
  (t) => [
    index('nra_lookup_idx').on(t.client, t.objectCode, t.subObject, t.allocatedNumber),
  ],
);
