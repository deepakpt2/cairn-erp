/**
 * Output — the documents a company sends out, and the record that they were sent.
 *
 * This is the NAST shape (§26.882): an **output type** is what may be sent, a **condition record** says
 * when, to whom and by which channel, and an **output message** is one issue of one output for one
 * document, with the status it reached. It belongs to no module. A goods receipt slip and an invoice
 * are both documents a company hands to somebody, and one queue holds them both: a package with two
 * output engines would have two answers to "what was sent, and to whom".
 *
 * The engine arrived with Inventory (SCR-135) and its determination was a single test — the direction a
 * material document's lines move in. The condition technique behind real output determination was
 * deferred then, and it is what the sales side cannot do without: an invoice goes to the bill-to by
 * e-mail because a record says so, not because a code path happens to render one. So the records stand
 * here, and both applications read them.
 *
 * What is *not* here is as deliberate as what is: nothing hands bytes to a printer and nothing talks to
 * a mail server. Rendering and dispatch are the package's; spool and transport are deferred by name. A
 * message that reaches PROCESSED says the document was rendered and given to a channel.
 */
import { sql } from 'drizzle-orm';
import {
  boolean, check, date, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, varchar,
} from 'drizzle-orm/pg-core';

import { auditColumns, client } from '../../platform/tables/tenancy';

/**
 * The tenant column, in the shape every schema file in the package declares it: the first column on
 * the table, referencing the client it is partitioned by.
 */
const tenant = () => varchar('client', { length: 4 }).notNull()
  .references(() => client.client, { onDelete: 'cascade' });

/**
 * Which part of the package an output type belongs to — SAP's KAPPL. It is what keeps the goods receipt
 * slip from being determined for a sales order: determination reads only the types of the application
 * the document belongs to.
 */
export const OUTPUT_APPLICATIONS = ['IN', 'SD'] as const;
export type OutputApplication = (typeof OUTPUT_APPLICATIONS)[number];

/** The documents an output can stand for. The category is half of the message's key. */
export const OUTPUT_DOCUMENT_CATEGORIES = [
  'MATERIAL_DOCUMENT', 'SALES_ORDER', 'DELIVERY', 'BILLING',
] as const;
export type OutputDocumentCategory = (typeof OUTPUT_DOCUMENT_CATEGORIES)[number];

/** PRINT and EMAIL. FAX and EDI are refused by name: no endpoint exists. */
export const OUTPUT_MEDIA = ['PRINT', 'EMAIL'] as const;
export type OutputMedium = (typeof OUTPUT_MEDIA)[number];

/** IMMEDIATE is dispatched as the document is written; PERIODIC waits for the run (SAP VSZTP 1 / 3). */
export const DISPATCH_TIMES = ['IMMEDIATE', 'PERIODIC'] as const;
export type DispatchTime = (typeof DISPATCH_TIMES)[number];

/** PENDING | PROCESSED | ERROR — SAP's VSTAT 0 / 1 / 2. */
export const OUTPUT_STATUSES = ['PENDING', 'PROCESSED', 'ERROR'] as const;
export type OutputStatus = (typeof OUTPUT_STATUSES)[number];

/** SAP VSTAT's digits, carried as aliases beside the names. */
export const OUTPUT_STATUS_ALIASES: Record<OutputStatus, string> = {
  PENDING: '0', PROCESSED: '1', ERROR: '2',
};

/**
 * The partner an output is addressed to: sold-to, ship-to, bill-to or payer — the sales partner
 * functions the package already carries. Which one, is what the condition record says.
 */
export const OUTPUT_PARTNER_FUNCTIONS = ['SP', 'SH', 'BP', 'PY'] as const;
export type OutputPartnerFunction = (typeof OUTPUT_PARTNER_FUNCTIONS)[number];

/**
 * An output type: what may be sent, and how.
 *
 * The medium and the dispatch time stand here as the default the type carries; a condition record may
 * name another for the document it answers for, which is how one type is printed for one customer and
 * e-mailed for another.
 *
 * `direction` is Inventory's own test — RECEIPT, ISSUE, or ANY — and it is meaningless to every other
 * application, whose determination is the access sequence. It stands where it stands rather than being
 * re-modelled out from under a capability that works.
 */
export const outputType = pgTable('output_type', {
  client: tenant(),
  outputType: varchar('output_type', { length: 4 }).notNull(),
  description: varchar('description', { length: 60 }).notNull(),
  /** Which part of the package this type belongs to: IN inventory, SD sales. */
  application: varchar('application', { length: 2 }).notNull().default('IN'),
  /** RECEIPT | ISSUE | ANY — the line direction a material document must carry to receive it. */
  direction: varchar('direction', { length: 8 }).notNull(),
  transmissionMedium: varchar('transmission_medium', { length: 8 }).notNull().default('PRINT'),
  dispatchTime: varchar('dispatch_time', { length: 10 }).notNull().default('IMMEDIATE'),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.outputType] }),
  check('output_type_code_ck', sql`${t.outputType} ~ '^[A-Z0-9]{2,4}$'`),
  check('output_type_application_ck', sql`${t.application} in ('IN', 'SD')`),
  check('output_type_direction_ck', sql`${t.direction} in ('RECEIPT', 'ISSUE', 'ANY')`),
  check('output_type_medium_ck', sql`${t.transmissionMedium} in ('PRINT', 'EMAIL')`),
  check('output_type_dispatch_ck', sql`${t.dispatchTime} in ('IMMEDIATE', 'PERIODIC')`),
]);

/**
 * One output condition record: when a type is sent, to whom, and by which channel.
 *
 * This is the condition technique applied to output, and it is the half of output determination the
 * package was missing: the most specific record that stands for the sales area, the document type and
 * the customer of the document, on the day, answers. Blank means *any* and is a value that is matched,
 * never an absence — which is why every position defaults to the empty string and not to null: null in
 * a unique key would let two "any customer" records stand side by side.
 *
 * The record names the **partner function that receives it**. An invoice addressed to the bill-to and
 * one addressed to the payer are two different decisions, and the medium is beside it because one
 * customer is e-mailed and another is posted.
 */
export const outputConditionRecord = pgTable('output_condition_record', {
  client: tenant(),
  conditionNumber: varchar('condition_number', { length: 18 }).notNull(),
  application: varchar('application', { length: 2 }).notNull().default('SD'),
  outputType: varchar('output_type', { length: 4 }).notNull(),
  /** Which document the record answers for, where it is narrowed: ORDER, DELIVERY or BILLING. */
  documentCategory: varchar('document_category', { length: 20 }).notNull().default(''),
  /** The sales document type, where the record is narrowed to one: OR, LF, F2, G2, B1. */
  documentType: varchar('document_type', { length: 2 }).notNull().default(''),
  salesOrg: varchar('sales_org', { length: 4 }).notNull().default(''),
  distributionChannel: varchar('distribution_channel', { length: 2 }).notNull().default(''),
  division: varchar('division', { length: 2 }).notNull().default(''),
  customerNumber: varchar('customer_number', { length: 40 }).notNull().default(''),
  transmissionMedium: varchar('transmission_medium', { length: 8 }).notNull().default('PRINT'),
  dispatchTime: varchar('dispatch_time', { length: 10 }).notNull().default('IMMEDIATE'),
  /** Who receives it: one of the document's own partners. */
  partnerFunction: varchar('partner_function', { length: 10 }).notNull().default('BP'),
  /** Where PRINT goes. Empty means the tenant's default queue, which is deferred by name. */
  printerQueue: varchar('printer_queue', { length: 30 }),
  validityFrom: date('validity_from', { mode: 'string' }).notNull(),
  validityTo: date('validity_to', { mode: 'string' }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.conditionNumber] }),
  // The type a record names is a row in the output type master, for the same client.
  foreignKey({
    name: 'output_condition_record_type_fk',
    columns: [t.client, t.outputType],
    foreignColumns: [outputType.client, outputType.outputType],
  }).onDelete('restrict'),
  check('output_condition_record_application_ck', sql`${t.application} in ('IN', 'SD')`),
  check('output_condition_record_medium_ck', sql`${t.transmissionMedium} in ('PRINT', 'EMAIL')`),
  check('output_condition_record_dispatch_ck', sql`${t.dispatchTime} in ('IMMEDIATE', 'PERIODIC')`),
  check('output_condition_record_partner_ck', sql`${t.partnerFunction} in ('SP', 'SH', 'BP', 'PY')`),
  check('output_condition_record_validity_ck', sql`${t.validityTo} >= ${t.validityFrom}`),
  // One record per combination and period: two records saying different things about the same document
  // would be two answers to one question.
  index('output_condition_record_key_uq').on(
    t.client, t.application, t.outputType, t.documentCategory, t.documentType,
    t.salesOrg, t.distributionChannel, t.division, t.customerNumber, t.validityFrom,
  ),
]);

/**
 * One issue of one output for one document: the NAST row.
 *
 * The **issue number** is part of the key because an output is issued once and issuing it again is a
 * deliberate second act, not a rewrite of the first. Two rows for the same document, type and medium
 * are two things that were sent, and both of them stand.
 *
 * The **rendering is stored with the message**, which is what makes a copy asked for a year later the
 * document as it was sent rather than a fresh reading of masters that have moved since. Nothing here
 * reaches a printer or a mail server: `PROCESSED` says the document was rendered and handed to a
 * channel.
 *
 * There is deliberately no foreign key on the document. A row here is the record that something was
 * sent, and it outlives the document's own referential convenience — which is also why a document of
 * any category can stand in the same queue.
 */
export const outputMessage = pgTable('output_message', {
  client: tenant(),
  /** What kind of document this output stands for: MATERIAL_DOCUMENT, SALES_ORDER, DELIVERY, BILLING. */
  documentCategory: varchar('document_category', { length: 20 }).notNull(),
  documentNumber: varchar('document_number', { length: 20 }).notNull(),
  /** Written from the document, never from input — a document owns its own year. */
  documentYear: integer('document_year').notNull(),
  outputType: varchar('output_type', { length: 4 }).notNull(),
  transmissionMedium: varchar('transmission_medium', { length: 8 }).notNull(),
  dispatchTime: varchar('dispatch_time', { length: 10 }).notNull(),
  /** 1 for the first issue; one higher for each re-issue. */
  issueNumber: integer('issue_number').notNull().default(1),
  status: varchar('status', { length: 10 }).notNull().default('PENDING'),
  sendCount: integer('send_count').notNull().default(0),
  /** Who it went to, for EMAIL. Read from the partner the condition record names. */
  recipient: varchar('recipient', { length: 50 }),
  printerQueue: varchar('printer_queue', { length: 30 }),
  /**
   * The document as it was rendered and sent. Kept, not re-derived: a copy printed next year has to be
   * the document the customer received, and masters move.
   */
  renderedDocument: text('rendered_document'),
  /** Why a re-issue was raised. Only a re-issue carries one. */
  reissueReason: varchar('reissue_reason', { length: 200 }),
  lastProcessedAt: timestamp('last_processed_at', { withTimezone: true }),
  /** Why the last attempt failed; only an ERROR carries one. */
  errorText: varchar('error_text', { length: 200 }),
  ...auditColumns,
}, (t) => [
  primaryKey({
    columns: [
      t.client, t.documentCategory, t.documentNumber, t.outputType, t.transmissionMedium, t.issueNumber,
    ],
  }),
  foreignKey({
    name: 'output_message_type_fk',
    columns: [t.client, t.outputType],
    foreignColumns: [outputType.client, outputType.outputType],
  }).onDelete('restrict'),
  check('output_message_category_ck',
    sql`${t.documentCategory} in ('MATERIAL_DOCUMENT', 'SALES_ORDER', 'DELIVERY', 'BILLING')`),
  check('output_message_medium_ck', sql`${t.transmissionMedium} in ('PRINT', 'EMAIL')`),
  check('output_message_dispatch_ck', sql`${t.dispatchTime} in ('IMMEDIATE', 'PERIODIC')`),
  check('output_message_status_ck', sql`${t.status} in ('PENDING', 'PROCESSED', 'ERROR')`),
  check('output_message_send_count_ck', sql`${t.sendCount} >= 0`),
  check('output_message_issue_ck', sql`${t.issueNumber} > 0`),
  check('output_message_error_ck', sql`${t.status} <> 'ERROR' or ${t.errorText} is not null`),
  check('output_message_recipient_ck', sql`${t.recipient} is null or length(btrim(${t.recipient})) > 0`),
  check('output_message_reissue_ck', sql`${t.issueNumber} = 1 or ${t.reissueReason} is not null`),
  index('output_message_queue_idx').on(t.client, t.status, t.createdAt),
  index('output_message_document_idx').on(t.client, t.documentCategory, t.documentNumber),
]);
