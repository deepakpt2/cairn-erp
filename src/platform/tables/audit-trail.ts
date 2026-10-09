/**
 * Audit trail, document flow and change documents — CAIRN.md §5.4, §16.3, D-017
 *
 * The document principle: no data change without a document.
 * Nothing posted is ever deleted — corrections are reversal documents that
 * reference the original.
 */
import {
  pgTable,
  varchar,
  char,
  text,
  timestamp,
  numeric,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { client } from './tenancy';

/**
 * Field-level change history for master data and configuration.
 * Answers "what did this field look like on that date" — the basis of the
 * time-travel view (§24.4) and of auditor drill-through (§16.2).
 */
export const changeDocument = pgTable(
  'change_document',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    /** Business object changed, e.g. material, business_partner, company_code_config */
    objectClass: varchar('object_class', { length: 64 }).notNull(),
    objectKey: varchar('object_key', { length: 120 }).notNull(),
    /** CREATE | CHANGE | BLOCK | UNBLOCK | DELETE_DENIED | REVERSE */
    changeType: varchar('change_type', { length: 24 }).notNull(),
    transactionCode: varchar('transaction_code', { length: 64 }),
    reason: text('reason'),
    changedBy: varchar('changed_by', { length: 60 }).notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Business-effective date, which may differ from the technical change date. */
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
  },
  (t) => [
    index('change_document_object_idx').on(t.client, t.objectClass, t.objectKey),
    index('change_document_time_idx').on(t.client, t.changedAt),
  ],
);

/** One row per changed field: the before/after values a native user expects to see. */
export const changeDocumentItem = pgTable(
  'change_document_item',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    changeDocumentId: varchar('change_document_id', { length: 36 })
      .notNull()
      .references(() => changeDocument.id, { onDelete: 'cascade' }),
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    fieldName: varchar('field_name', { length: 120 }).notNull(),
    fieldLabel: varchar('field_label', { length: 200 }),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    /** true when the field is security-relevant (vendor bank details, prices) — §16.3 */
    isSecurityRelevant: varchar('is_security_relevant', { length: 8 }).notNull().default('false'),
  },
  (t) => [index('change_document_item_doc_idx').on(t.client, t.changeDocumentId)],
);

/**
 * The document graph. Directed predecessor → successor links with context.
 * This is what the document-flow button renders and what the auditor walks.
 */
export const documentFlowLink = pgTable(
  'document_flow_link',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    predecessorClass: varchar('predecessor_class', { length: 48 }).notNull(),
    predecessorKey: varchar('predecessor_key', { length: 120 }).notNull(),
    successorClass: varchar('successor_class', { length: 48 }).notNull(),
    successorKey: varchar('successor_key', { length: 120 }).notNull(),
    /** What the link represents, e.g. DELIVERED_QUANTITY, INVOICED_VALUE */
    relationType: varchar('relation_type', { length: 40 }).notNull().default('FOLLOWS'),
    /** Quantities and values carried across the link, for the flow display. */
    linkQuantity: numeric('link_quantity', { precision: 23, scale: 3 }),
    linkValue: numeric('link_value', { precision: 23, scale: 4 }),
    linkCurrency: char('link_currency', { length: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: varchar('created_by', { length: 60 }).notNull(),
  },
  (t) => [
    index('dfl_predecessor_idx').on(t.client, t.predecessorClass, t.predecessorKey),
    index('dfl_successor_idx').on(t.client, t.successorClass, t.successorKey),
  ],
);

/** Every status transition on a document, with who and why. */
export const documentStatusHistory = pgTable(
  'document_status_history',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    documentClass: varchar('document_class', { length: 48 }).notNull(),
    documentKey: varchar('document_key', { length: 120 }).notNull(),
    previousStatus: varchar('previous_status', { length: 32 }),
    newStatus: varchar('new_status', { length: 32 }).notNull(),
    reason: text('reason'),
    changedBy: varchar('changed_by', { length: 60 }).notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('dsh_document_idx').on(t.client, t.documentClass, t.documentKey),
  ],
);

/**
 * Lightweight cross-class index so global search and drill-through can find any
 * document without knowing which table holds it (§5.4).
 */
export const documentIndex = pgTable(
  'document_index',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    documentClass: varchar('document_class', { length: 48 }).notNull(),
    documentKey: varchar('document_key', { length: 120 }).notNull(),
    displayNumber: varchar('display_number', { length: 40 }).notNull(),
    documentType: varchar('document_type', { length: 24 }),
    companyCode: varchar('company_code', { length: 10 }),
    postingDate: timestamp('posting_date', { withTimezone: true }),
    /** OPEN | POSTED | REVERSED | BLOCKED | CLOSED */
    status: varchar('status', { length: 24 }).notNull().default('POSTED'),
    summary: text('summary'),
    /** Search payload for the global search box. */
    searchText: text('search_text'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('document_index_key_idx').on(t.client, t.documentClass, t.documentKey),
    index('document_index_number_idx').on(t.client, t.displayNumber),
  ],
);
