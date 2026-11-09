/**
 * The incompletion procedure and the log of incomplete items — §5.1, SAP's OVA2, OVA0, VUA2, VUA4
 * and the table they all write, VBUV.
 *
 * A document is refused today when it is wrong and saved when it is not, and there is no third
 * state. The log is the third state: the document stands, it is simply not complete, and what it is
 * missing is recorded against it, field by field. That is what lets a clerk save an order with the
 * customer's purchase-order number still to come, and what stops the warehouse raising a delivery
 * for an order with no date on it.
 *
 * Three things about the shape are deliberate, and each is a departure from SAP for a reason.
 *
 * **The log is the only record.** SAP carries `VBUK-UVALL` and `VBUP` beside the document because
 * `VBUV` was expensive to ask. Here an indexed existence query answers "is this document blocked for
 * delivery" inside the transaction that would have read a status column, and a second copy of the
 * answer is a second thing to keep true.
 *
 * **A field the code cannot check cannot be maintained.** SAP's `TVUVF` holds a free table-and-field
 * pair, because SAP reads any field of any table at runtime. A typed service layer cannot, and a
 * field nothing evaluates would leave a document silently never complete. So the set of checkable
 * fields is code — the registry below — and what stays data is which of them a tenant chose.
 *
 * **No item category, so no VUP2, VUE2 or VUPA.** A procedure is assigned to a document type, and
 * its own group says whether it checks the header, the lines, the schedule lines or the partners.
 *
 * Nothing is delivered but the six groups. No procedure, no field, no status group and no
 * assignment, so a document written the day this is deployed is written exactly as it was the day
 * before — and stays that way until a tenant says otherwise.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import {
  type IncompletionDocumentCategory, type IncompletionGroup,
  delivery, deliveryLine, deliveryPicking,
  incompletionAssignment, incompletionGroup, incompletionProcedure, incompletionProcedureField,
  incompletionStatusGroup, salesDocumentPartner, salesDocumentType, salesIncompletionLog,
  salesOrder, salesOrderLine, salesOrderSchedule,
} from './schema';

export const INCOMPLETION_CAPABILITY = 'CFG.SALES.INCOMPLETION.DEFINE';
export const INCOMPLETION_PROCESS_CAPABILITY = 'SALES.INCOMPLETION.PROCESS';

/** Where the configuration is maintained, and where the worklist stands. */
export const INCOMPLETION_ROUTE = '/config/incompletion';
export const INCOMPLETION_WORKLIST_ROUTE = '/sales/incomplete';
/** Where a missing field is filled in. The order and the delivery each have one screen. */
export const ORDER_ROUTE = '/sales/orders';
export const DELIVERY_ROUTE = '/sales/delivery';

export const INCOMPLETION_STATUS_GROUP_OBJECT_CLASS = 'incompletion_status_group';
export const INCOMPLETION_PROCEDURE_OBJECT_CLASS = 'incompletion_procedure';
export const INCOMPLETION_PROCEDURE_FIELD_OBJECT_CLASS = 'incompletion_procedure_field';
export const INCOMPLETION_ASSIGNMENT_OBJECT_CLASS = 'incompletion_assignment';

/** The functions a missing field can stop. SAP's consequence, made explicit. */
export const BLOCKED_FUNCTIONS = ['DELIVERY', 'GOODS_ISSUE', 'BILLING', 'OUTPUT'] as const;
export type BlockedFunction = (typeof BLOCKED_FUNCTIONS)[number];

const CODE = /^[A-Z0-9]{1,4}$/;
const STATUS_CODE = /^[A-Z0-9]{1,2}$/;
const NAME = /^.{1,40}$/;

export class IncompletionError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'IncompletionError';
    this.remedy = remedy;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The subject: the document as it was just written
// ─────────────────────────────────────────────────────────────────────────────

/** Where a field is missing: the whole address of a gap, as SAP's VBUV key holds it. */
interface MissingAt {
  /** Zero for a header entry, and for a partner entry, which is about the document as a whole. */
  lineNumber: number;
  /** Zero unless the schedule line itself is what carries the gap. */
  scheduleNumber: number;
  /** Blank unless a partner function is what is missing. */
  partnerFunction: string;
}

const HEADER_ONLY: MissingAt = { lineNumber: 0, scheduleNumber: 0, partnerFunction: '' };

/**
 * What the evaluator looks at.
 *
 * One shape for both categories, because a procedure's group says what it asks about and a field is
 * never asked of a document that cannot answer it: a delivery header check on an order is not a
 * question, and the group is what keeps it from being asked.
 */
export interface IncompletionSubject {
  orderHeader?: {
    purchaseOrderReference: string | null;
    requestedDate: string | null;
    headerText: string | null;
  };
  orderLines?: Array<{
    lineNumber: number;
    plant: string;
    requestedDeliveryDate: string | null;
    taxCode: string | null;
    profitCenter: string | null;
  }>;
  orderSchedules?: Array<{
    orderLineNumber: number;
    scheduleNumber: number;
    requestedDate: string | null;
    requestedQuantity: string | null;
  }>;
  partners?: Array<{ functionCode: string; partnerNumber: string }>;
  deliveryHeader?: {
    shippingPoint: string | null;
    deliveryDate: string | null;
    shipToName: string | null;
    shipToStreet: string | null;
    shipToCity: string | null;
    shipToCountry: string | null;
  };
  deliveryLines?: Array<{
    lineNumber: number;
    plant: string;
    quantityUnit: string;
    /** The storage location the goods were picked from, once anything has been picked. */
    storageLocation: string | null;
  }>;
}

interface CheckableField {
  group: IncompletionGroup;
  /** The table SAP would name. Here it names the part of the document the field lives on. */
  table: string;
  field: string;
  /** What the field is called, so a worklist reads as English rather than as column names. */
  name: string;
  /** Where the field is entered, which is what makes a worklist entry a link. */
  screen: string;
  /** Where the gap is. Empty means the document carries the field everywhere it can. */
  missing: (subject: IncompletionSubject) => MissingAt[];
}

const blank = (value: string | null | undefined) => !value || !value.trim();

/**
 * The fields the evaluator knows how to look at.
 *
 * This is the whole of the bargain struck in the header: configuration is data, but the set of
 * things that can be configured is code, because a maintained field nothing evaluates would leave a
 * document silently never complete. A partner function is a field here for the same reason it is one
 * in SAP's group `D` — the `PARVW` in the `VBUV` key is the function that was not filled in.
 */
const CHECKABLE_FIELDS: CheckableField[] = [
  // ── A — the sales order header ────────────────────────────────────────────
  {
    group: 'A', table: 'salesOrder', field: 'purchaseOrderReference',
    name: "The customer's purchase order reference", screen: ORDER_ROUTE,
    missing: (s) => (s.orderHeader && blank(s.orderHeader.purchaseOrderReference) ? [HEADER_ONLY] : []),
  },
  {
    group: 'A', table: 'salesOrder', field: 'requestedDate',
    name: 'The date the goods were asked for', screen: ORDER_ROUTE,
    missing: (s) => (s.orderHeader && blank(s.orderHeader.requestedDate) ? [HEADER_ONLY] : []),
  },
  {
    group: 'A', table: 'salesOrder', field: 'headerText',
    name: 'A text saying what the order is', screen: ORDER_ROUTE,
    missing: (s) => (s.orderHeader && blank(s.orderHeader.headerText) ? [HEADER_ONLY] : []),
  },
  // ── B — the sales order item ──────────────────────────────────────────────
  {
    group: 'B', table: 'salesOrderLine', field: 'requestedDeliveryDate',
    name: 'When the line is wanted', screen: ORDER_ROUTE,
    missing: (s) => (s.orderLines ?? [])
      .filter((line) => blank(line.requestedDeliveryDate))
      .map((line) => ({ lineNumber: line.lineNumber, scheduleNumber: 0, partnerFunction: '' })),
  },
  {
    group: 'B', table: 'salesOrderLine', field: 'taxCode',
    name: 'How the line is taxed', screen: ORDER_ROUTE,
    missing: (s) => (s.orderLines ?? [])
      .filter((line) => blank(line.taxCode))
      .map((line) => ({ lineNumber: line.lineNumber, scheduleNumber: 0, partnerFunction: '' })),
  },
  {
    group: 'B', table: 'salesOrderLine', field: 'profitCenter',
    name: 'Where the line’s profit belongs', screen: ORDER_ROUTE,
    missing: (s) => (s.orderLines ?? [])
      .filter((line) => blank(line.profitCenter))
      .map((line) => ({ lineNumber: line.lineNumber, scheduleNumber: 0, partnerFunction: '' })),
  },
  {
    group: 'B', table: 'salesOrderLine', field: 'plant',
    name: 'The plant the line is delivered from', screen: ORDER_ROUTE,
    missing: (s) => (s.orderLines ?? [])
      .filter((line) => blank(line.plant))
      .map((line) => ({ lineNumber: line.lineNumber, scheduleNumber: 0, partnerFunction: '' })),
  },
  // ── C — the schedule line ─────────────────────────────────────────────────
  {
    group: 'C', table: 'salesOrderSchedule', field: 'requestedDate',
    name: 'When the instalment is wanted', screen: ORDER_ROUTE,
    missing: (s) => (s.orderSchedules ?? [])
      .filter((row) => blank(row.requestedDate))
      .map((row) => ({
        lineNumber: row.orderLineNumber, scheduleNumber: row.scheduleNumber, partnerFunction: '',
      })),
  },
  {
    group: 'C', table: 'salesOrderSchedule', field: 'requestedQuantity',
    name: 'How much the instalment is for', screen: ORDER_ROUTE,
    missing: (s) => (s.orderSchedules ?? [])
      .filter((row) => blank(row.requestedQuantity) || Number(row.requestedQuantity) <= 0)
      .map((row) => ({
        lineNumber: row.orderLineNumber, scheduleNumber: row.scheduleNumber, partnerFunction: '',
      })),
  },
  // ── D — the partners. The field is the function, as SAP's VBUV key holds it. ──
  {
    group: 'D', table: 'salesDocumentPartner', field: 'SH',
    name: 'The ship-to party', screen: ORDER_ROUTE,
    missing: (s) => (s.partners && s.partners.some((row) => row.functionCode === 'SH')
      ? [] : [{ lineNumber: 0, scheduleNumber: 0, partnerFunction: 'SH' }]),
  },
  {
    group: 'D', table: 'salesDocumentPartner', field: 'BP',
    name: 'The bill-to party', screen: ORDER_ROUTE,
    missing: (s) => (s.partners && s.partners.some((row) => row.functionCode === 'BP')
      ? [] : [{ lineNumber: 0, scheduleNumber: 0, partnerFunction: 'BP' }]),
  },
  {
    group: 'D', table: 'salesDocumentPartner', field: 'PY',
    name: 'The payer', screen: ORDER_ROUTE,
    missing: (s) => (s.partners && s.partners.some((row) => row.functionCode === 'PY')
      ? [] : [{ lineNumber: 0, scheduleNumber: 0, partnerFunction: 'PY' }]),
  },
  // ── G — the delivery header ───────────────────────────────────────────────
  {
    group: 'G', table: 'delivery', field: 'shippingPoint',
    name: 'Where the delivery loads from', screen: DELIVERY_ROUTE,
    missing: (s) => (s.deliveryHeader && blank(s.deliveryHeader.shippingPoint) ? [HEADER_ONLY] : []),
  },
  {
    group: 'G', table: 'delivery', field: 'deliveryDate',
    name: 'When the delivery goes out', screen: DELIVERY_ROUTE,
    missing: (s) => (s.deliveryHeader && blank(s.deliveryHeader.deliveryDate) ? [HEADER_ONLY] : []),
  },
  {
    group: 'G', table: 'delivery', field: 'shipToAddress',
    name: 'Where the delivery is going', screen: DELIVERY_ROUTE,
    missing: (s) => (s.deliveryHeader && (
      blank(s.deliveryHeader.shipToName) || blank(s.deliveryHeader.shipToStreet)
      || blank(s.deliveryHeader.shipToCity) || blank(s.deliveryHeader.shipToCountry)
    ) ? [HEADER_ONLY] : []),
  },
  // ── H — the delivery item ─────────────────────────────────────────────────
  {
    group: 'H', table: 'deliveryLine', field: 'plant',
    name: 'The plant the line is shipped from', screen: DELIVERY_ROUTE,
    missing: (s) => (s.deliveryLines ?? [])
      .filter((line) => blank(line.plant))
      .map((line) => ({ lineNumber: line.lineNumber, scheduleNumber: 0, partnerFunction: '' })),
  },
  {
    group: 'H', table: 'deliveryLine', field: 'quantityUnit',
    name: 'The unit the line is counted in', screen: DELIVERY_ROUTE,
    missing: (s) => (s.deliveryLines ?? [])
      .filter((line) => blank(line.quantityUnit))
      .map((line) => ({ lineNumber: line.lineNumber, scheduleNumber: 0, partnerFunction: '' })),
  },
  {
    group: 'H', table: 'deliveryPicking', field: 'storageLocation',
    name: 'Where in the plant the goods were picked from', screen: DELIVERY_ROUTE,
    missing: (s) => (s.deliveryLines ?? [])
      .filter((line) => blank(line.storageLocation))
      .map((line) => ({ lineNumber: line.lineNumber, scheduleNumber: 0, partnerFunction: '' })),
  },
];

export interface CheckableFieldView {
  group: IncompletionGroup;
  table: string;
  field: string;
  name: string;
  screen: string;
}

/** The fields a tenant may maintain, which is what the screen offers and the save validates against. */
export function checkableFields(group?: IncompletionGroup): CheckableFieldView[] {
  return CHECKABLE_FIELDS
    .filter((row) => group === undefined || row.group === group)
    .map((row) => ({
      group: row.group, table: row.table, field: row.field, name: row.name, screen: row.screen,
    }));
}

const fieldOf = (table: string, field: string) => CHECKABLE_FIELDS
  .find((row) => row.table === table && row.field === field);

/** What a field is called, for a log row and a worklist. Falls back to the column name. */
function fieldName(table: string, field: string, fallback?: string): string {
  return fieldOf(table, field)?.name ?? fallback ?? `${table}.${field}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the subject
// ─────────────────────────────────────────────────────────────────────────────

async function subjectFor(
  tx: Tx,
  client: string,
  documentCategory: IncompletionDocumentCategory,
  documentNumber: string,
): Promise<IncompletionSubject | null> {
  if (documentCategory === 'ORDER') {
    const [header] = await tx.select().from(salesOrder).where(and(
      eq(salesOrder.client, client), eq(salesOrder.orderNumber, documentNumber),
    )).limit(1);
    if (!header) return null;
    const lines = await tx.select().from(salesOrderLine).where(and(
      eq(salesOrderLine.client, client), eq(salesOrderLine.orderNumber, documentNumber),
    )).orderBy(asc(salesOrderLine.lineNumber));
    const schedules = await tx.select().from(salesOrderSchedule).where(and(
      eq(salesOrderSchedule.client, client), eq(salesOrderSchedule.orderNumber, documentNumber),
    )).orderBy(asc(salesOrderSchedule.orderLineNumber), asc(salesOrderSchedule.scheduleNumber));
    const partners = await tx.select().from(salesDocumentPartner).where(and(
      eq(salesDocumentPartner.client, client),
      eq(salesDocumentPartner.documentCategory, 'ORDER'),
      eq(salesDocumentPartner.documentNumber, documentNumber),
    ));
    return {
      orderHeader: {
        purchaseOrderReference: header.purchaseOrderReference,
        requestedDate: header.requestedDate,
        headerText: header.headerText,
      },
      orderLines: lines
        // A rejected line is not incomplete. It is finished, and asking a clerk to fill it in would
        // be asking them to make a dead line look live.
        .filter((line) => line.status === 'OPEN')
        .map((line) => ({
          lineNumber: line.lineNumber,
          plant: line.plant,
          requestedDeliveryDate: line.requestedDeliveryDate,
          taxCode: line.taxCode,
          profitCenter: line.profitCenter,
        })),
      orderSchedules: schedules.map((row) => ({
        orderLineNumber: row.orderLineNumber,
        scheduleNumber: row.scheduleNumber,
        requestedDate: row.requestedDate,
        requestedQuantity: row.requestedQuantity,
      })),
      partners: partners.map((row) => ({
        functionCode: row.functionCode, partnerNumber: row.partnerNumber,
      })),
    };
  }
  const [header] = await tx.select().from(delivery).where(and(
    eq(delivery.client, client), eq(delivery.deliveryNumber, documentNumber),
  )).limit(1);
  if (!header) return null;
  const lines = await tx.select().from(deliveryLine).where(and(
    eq(deliveryLine.client, client), eq(deliveryLine.deliveryNumber, documentNumber),
  )).orderBy(asc(deliveryLine.lineNumber));
  const picks = await tx.select().from(deliveryPicking).where(and(
    eq(deliveryPicking.client, client), eq(deliveryPicking.deliveryNumber, documentNumber),
  ));
  const locationOf = (lineNumber: number) => picks
    .map((row) => (row.lineNumber === lineNumber ? row.storageLocation : null))
    .find((value) => value !== null && value.trim() !== '') ?? null;
  return {
    deliveryHeader: {
      shippingPoint: header.shippingPoint,
      deliveryDate: header.deliveryDate,
      shipToName: header.shipToName,
      shipToStreet: header.shipToStreet,
      shipToCity: header.shipToCity,
      shipToCountry: header.shipToCountry,
    },
    deliveryLines: lines.map((line) => ({
      lineNumber: line.lineNumber,
      plant: line.plant,
      quantityUnit: line.quantityUnit,
      storageLocation: locationOf(line.lineNumber),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

interface MissingRow {
  lineNumber: number;
  scheduleNumber: number;
  partnerFunction: string;
  tableName: string;
  fieldName: string;
  procedureCode: string;
  statusGroup: string;
  isWarning: boolean;
}

/**
 * Judge a document and write the log it now stands at.
 *
 * Called inside the transaction that wrote the document, in the same place output determination
 * runs, for the same reason: a document and the statement about its completeness are written
 * together or not at all. It rewrites the log whole — the rows that stand now, not the rows that
 * stood last time — because the alternative, patching the difference, is how a log comes to hold
 * an entry for a field that was filled in three saves ago.
 *
 * A document whose type carries no procedure is complete: it has no log rows, which is what every
 * document in the books has today.
 */
export async function evaluateIncompletion(
  tx: Tx,
  input: {
    client: string; changedBy: string;
    documentCategory: IncompletionDocumentCategory;
    documentNumber: string;
    documentType: string;
  },
): Promise<void> {
  const { client, documentCategory, documentNumber, documentType } = input;
  const assignments = await tx.select().from(incompletionAssignment).where(and(
    eq(incompletionAssignment.client, client),
    eq(incompletionAssignment.documentCategory, documentCategory),
    eq(incompletionAssignment.documentType, documentType),
  ));
  await tx.delete(salesIncompletionLog).where(and(
    eq(salesIncompletionLog.client, client),
    eq(salesIncompletionLog.documentCategory, documentCategory),
    eq(salesIncompletionLog.documentNumber, documentNumber),
  ));
  if (assignments.length === 0) return;

  const procedures = await tx.select().from(incompletionProcedure).where(and(
    eq(incompletionProcedure.client, client),
    eq(incompletionProcedure.isActive, true),
    inArray(incompletionProcedure.procedureCode, assignments.map((row) => row.procedureCode)),
  ));
  if (procedures.length === 0) return;
  const fields = await tx.select().from(incompletionProcedureField).where(and(
    eq(incompletionProcedureField.client, client),
    inArray(incompletionProcedureField.procedureCode, procedures.map((row) => row.procedureCode)),
  )).orderBy(asc(incompletionProcedureField.sequence));

  const subject = await subjectFor(tx, client, documentCategory, documentNumber);
  if (!subject) {
    throw new IncompletionError(
      `${documentCategory} ${documentNumber} does not stand, so it cannot be judged.`,
      'Judge a document that has been written.',
    );
  }

  const missing: MissingRow[] = [];
  for (const field of fields) {
    const known = fieldOf(field.tableName, field.fieldName);
    // A field the evaluator does not know cannot go missing. It cannot be maintained either — the
    // save refuses it — but a procedure maintained before a field was withdrawn from the registry
    // must not become a document that is permanently incomplete.
    if (!known) continue;
    for (const at of known.missing(subject)) {
      missing.push({
        lineNumber: at.lineNumber,
        scheduleNumber: at.scheduleNumber,
        partnerFunction: at.partnerFunction,
        tableName: field.tableName,
        fieldName: field.fieldName,
        procedureCode: field.procedureCode,
        statusGroup: field.statusGroup,
        isWarning: field.isWarning,
      });
    }
  }
  if (missing.length === 0) return;
  const now = new Date();
  await tx.insert(salesIncompletionLog).values(missing.map((row) => ({
    client,
    documentCategory,
    documentNumber,
    lineNumber: row.lineNumber,
    scheduleNumber: row.scheduleNumber,
    partnerFunction: row.partnerFunction,
    tableName: row.tableName,
    fieldName: row.fieldName,
    procedureCode: row.procedureCode,
    statusGroup: row.statusGroup,
    isWarning: row.isWarning,
    createdBy: input.changedBy,
    createdAt: now,
  })));
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the log
// ─────────────────────────────────────────────────────────────────────────────

export interface IncompletionEntry {
  tableName: string;
  fieldName: string;
  /** What the field is called, so a clerk is not asked to find `shipToAddress`. */
  name: string;
  lineNumber: number;
  scheduleNumber: number;
  partnerFunction: string;
  procedureCode: string;
  statusGroup: string;
  isWarning: boolean;
  /** Where the field is filled in, which makes an entry a link rather than a complaint. */
  screen: string;
}

/** What one document is missing, in the sequence the procedure named. */
export async function readIncompletion(
  client: string,
  documentCategory: IncompletionDocumentCategory,
  documentNumber: string,
): Promise<IncompletionEntry[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(salesIncompletionLog).where(and(
      eq(salesIncompletionLog.client, client),
      eq(salesIncompletionLog.documentCategory, documentCategory),
      eq(salesIncompletionLog.documentNumber, documentNumber),
    ));
    return rows.map(toEntry);
  });
}

function toEntry(row: typeof salesIncompletionLog.$inferSelect): IncompletionEntry {
  const known = fieldOf(row.tableName, row.fieldName);
  return {
    tableName: row.tableName,
    fieldName: row.fieldName,
    name: known?.name ?? `${row.tableName}.${row.fieldName}`,
    lineNumber: row.lineNumber,
    scheduleNumber: row.scheduleNumber,
    partnerFunction: row.partnerFunction,
    procedureCode: row.procedureCode,
    statusGroup: row.statusGroup,
    isWarning: row.isWarning,
    screen: known?.screen ?? (row.documentCategory === 'ORDER' ? ORDER_ROUTE : DELIVERY_ROUTE),
  };
}

/**
 * The log entries that stop a named function.
 *
 * A warning row never blocks — that is what a warning is — and neither does a row whose status
 * group has since been changed to block nothing. The line filter is for a call about one line: a
 * header gap (line number zero) blocks every line of the document, because a delivery raised for
 * one line of an order with no requested date is raised for an order with no requested date.
 */
export async function blockingEntries(
  tx: Tx,
  client: string,
  input: {
    documentCategory: IncompletionDocumentCategory;
    documentNumber: string;
    lineNumber?: number;
    fn: BlockedFunction;
  },
): Promise<IncompletionEntry[]> {
  const rows = await tx.select().from(salesIncompletionLog).where(and(
    eq(salesIncompletionLog.client, client),
    eq(salesIncompletionLog.documentCategory, input.documentCategory),
    eq(salesIncompletionLog.documentNumber, input.documentNumber),
    eq(salesIncompletionLog.isWarning, false),
    input.lineNumber === undefined
      ? undefined
      : inArray(salesIncompletionLog.lineNumber, [0, input.lineNumber]),
  ));
  if (rows.length === 0) return [];
  const groups = await tx.select().from(incompletionStatusGroup).where(and(
    eq(incompletionStatusGroup.client, client),
    inArray(incompletionStatusGroup.statusGroup, [...new Set(rows.map((row) => row.statusGroup))]),
  ));
  const blocks = new Set(groups
    .filter((row) => blocksFunction(row, input.fn))
    .map((row) => row.statusGroup));
  return rows.filter((row) => blocks.has(row.statusGroup)).map(toEntry);
}

function blocksFunction(
  row: typeof incompletionStatusGroup.$inferSelect,
  fn: BlockedFunction,
): boolean {
  if (fn === 'DELIVERY') return row.blocksDelivery;
  if (fn === 'GOODS_ISSUE') return row.blocksGoodsIssue;
  if (fn === 'BILLING') return row.blocksBilling;
  return row.blocksOutput;
}

/**
 * The words a refusal uses.
 *
 * A refusal that says "incomplete" sends a clerk nowhere. This names the field and the screen it is
 * entered on, which is the whole point of keeping the log rather than a flag.
 */
export function describeBlocked(entries: IncompletionEntry[]): string {
  if (entries.length === 0) return '';
  const named = entries.map((row) => {
    const where = row.lineNumber > 0
      ? ` on line ${row.lineNumber}`
      : row.partnerFunction ? ` (${row.partnerFunction})` : '';
    return `${row.name.toLowerCase()}${where}, at ${row.screen}`;
  });
  return named.join('; ');
}

/** Convenience for a caller holding a client rather than a transaction. */
export async function blockedFor(
  client: string,
  input: {
    documentCategory: IncompletionDocumentCategory;
    documentNumber: string;
    lineNumber?: number;
    fn: BlockedFunction;
  },
): Promise<IncompletionEntry[]> {
  return withTenant(client, (tx) => blockingEntries(tx, client, input));
}

// ─────────────────────────────────────────────────────────────────────────────
// The worklist — SAP's V.02
// ─────────────────────────────────────────────────────────────────────────────

export interface IncompleteDocument {
  documentCategory: IncompletionDocumentCategory;
  documentNumber: string;
  documentType: string;
  customerNumber: string;
  /** The order date, or the delivery date. What the document is dated, whatever it is. */
  documentDate: string;
  netValue: string | null;
  currency: string | null;
  /** How many fields are missing, and how many of those stop something. */
  missing: number;
  blocking: number;
  entries: IncompletionEntry[];
}

/**
 * Every document that stands and is missing something its procedure says it must carry.
 *
 * SAP's `V.02`. An entry carries the field, the line and the screen the field is entered on, so the
 * list is not a report to be read but a set of links to be followed — which is the only shape in
 * which a worklist gets worked.
 */
export async function listIncompleteDocuments(
  client: string,
  filter: { documentCategory?: IncompletionDocumentCategory; customerNumber?: string } = {},
): Promise<IncompleteDocument[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(salesIncompletionLog).where(and(
      eq(salesIncompletionLog.client, client),
      filter.documentCategory
        ? eq(salesIncompletionLog.documentCategory, filter.documentCategory)
        : undefined,
    ));
    if (rows.length === 0) return [];

    const groups = await tx.select().from(incompletionStatusGroup)
      .where(eq(incompletionStatusGroup.client, client));
    const blockingGroup = new Set(groups.filter((row) => (
      row.blocksDelivery || row.blocksGoodsIssue || row.blocksBilling || row.blocksOutput
    )).map((row) => row.statusGroup));
    const blocks = (row: typeof salesIncompletionLog.$inferSelect) =>
      !row.isWarning && blockingGroup.has(row.statusGroup);

    const orderNumbers = [...new Set(rows.filter((r) => r.documentCategory === 'ORDER')
      .map((r) => r.documentNumber))];
    const deliveryNumbers = [...new Set(rows.filter((r) => r.documentCategory === 'DELIVERY')
      .map((r) => r.documentNumber))];
    const orders = orderNumbers.length === 0 ? [] : await tx.select().from(salesOrder).where(and(
      eq(salesOrder.client, client), inArray(salesOrder.orderNumber, orderNumbers),
    ));
    const deliveries = deliveryNumbers.length === 0 ? [] : await tx.select().from(delivery).where(and(
      eq(delivery.client, client), inArray(delivery.deliveryNumber, deliveryNumbers),
    ));
    const orderOf = new Map(orders.map((row) => [row.orderNumber, row]));
    const deliveryOf = new Map(deliveries.map((row) => [row.deliveryNumber, row]));

    const byDocument = new Map<string, IncompleteDocument>();
    for (const row of rows) {
      if (filter.customerNumber) {
        const header = row.documentCategory === 'ORDER'
          ? orderOf.get(row.documentNumber) : deliveryOf.get(row.documentNumber);
        if (!header || header.customerNumber !== filter.customerNumber) continue;
      }
      const key = `${row.documentCategory}/${row.documentNumber}`;
      let view = byDocument.get(key);
      if (!view) {
        if (row.documentCategory === 'ORDER') {
          const header = orderOf.get(row.documentNumber);
          if (!header) continue;
          view = {
            documentCategory: 'ORDER',
            documentNumber: header.orderNumber,
            documentType: header.documentType,
            customerNumber: header.customerNumber,
            documentDate: header.orderDate,
            netValue: header.netValue,
            currency: header.currency,
            missing: 0, blocking: 0, entries: [],
          };
        } else {
          const header = deliveryOf.get(row.documentNumber);
          if (!header) continue;
          view = {
            documentCategory: 'DELIVERY',
            documentNumber: header.deliveryNumber,
            documentType: header.documentType,
            customerNumber: header.customerNumber,
            documentDate: header.deliveryDate,
            netValue: null,
            currency: null,
            missing: 0, blocking: 0, entries: [],
          };
        }
        byDocument.set(key, view);
      }
      view.missing += 1;
      if (blocks(row)) view.blocking += 1;
      view.entries.push(toEntry(row));
    }
    const ordered = [...byDocument.values()].sort((a, b) => (
      a.documentDate === b.documentDate
        ? a.documentNumber.localeCompare(b.documentNumber)
        : a.documentDate.localeCompare(b.documentDate)
    ));
    for (const view of ordered) {
      view.entries.sort((a, b) => (
        a.lineNumber - b.lineNumber || a.fieldName.localeCompare(b.fieldName)
      ));
    }
    return ordered;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Maintaining the configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface IncompletionStatusGroupRow {
  statusGroup: string;
  name: string;
  blocksDelivery: boolean;
  blocksGoodsIssue: boolean;
  blocksBilling: boolean;
  blocksOutput: boolean;
  isActive: boolean;
  /** How many procedure fields name it. A group in use cannot be quietly redefined. */
  fields: number;
}

export interface IncompletionProcedureRow {
  procedureCode: string;
  groupCode: IncompletionGroup;
  name: string;
  isActive: boolean;
  fields: Array<{
    tableName: string;
    fieldName: string;
    name: string;
    sequence: number;
    statusGroup: string;
    isWarning: boolean;
  }>;
}

export interface IncompletionAssignmentRow {
  documentCategory: IncompletionDocumentCategory;
  documentType: string;
  documentTypeName: string | null;
  procedureCode: string;
  procedureName: string | null;
  groupCode: IncompletionGroup | null;
}

export interface IncompletionConfiguration {
  groups: Array<{ groupCode: IncompletionGroup; name: string; meaning: string }>;
  statusGroups: IncompletionStatusGroupRow[];
  procedures: IncompletionProcedureRow[];
  assignments: IncompletionAssignmentRow[];
  /** What may be maintained, so the screen offers a list instead of asking for a column name. */
  checkable: CheckableFieldView[];
  documentTypes: Array<{ documentType: string; name: string | null }>;
}

/** The whole configuration as it stands, in the four pieces the screen shows. */
export async function listIncompletionConfiguration(
  client: string,
): Promise<IncompletionConfiguration> {
  return withTenant(client, async (tx) => {
    const groups = await tx.select().from(incompletionGroup)
      .where(eq(incompletionGroup.client, client)).orderBy(asc(incompletionGroup.groupCode));
    const statusGroups = await tx.select().from(incompletionStatusGroup)
      .where(eq(incompletionStatusGroup.client, client))
      .orderBy(asc(incompletionStatusGroup.statusGroup));
    const procedures = await tx.select().from(incompletionProcedure)
      .where(eq(incompletionProcedure.client, client))
      .orderBy(asc(incompletionProcedure.procedureCode));
    const fields = await tx.select().from(incompletionProcedureField)
      .where(eq(incompletionProcedureField.client, client))
      .orderBy(asc(incompletionProcedureField.procedureCode), asc(incompletionProcedureField.sequence));
    const assignments = await tx.select().from(incompletionAssignment)
      .where(eq(incompletionAssignment.client, client))
      .orderBy(asc(incompletionAssignment.documentCategory), asc(incompletionAssignment.documentType),
        asc(incompletionAssignment.procedureCode));
    const types = await tx.select().from(salesDocumentType)
      .where(eq(salesDocumentType.client, client)).orderBy(asc(salesDocumentType.documentType));
    const typeName = new Map(types.map((row) => [row.documentType, row.name]));
    const procedureOf = new Map(procedures.map((row) => [row.procedureCode, row]));

    return {
      groups: groups.map((row) => ({
        groupCode: row.groupCode as IncompletionGroup, name: row.name, meaning: row.meaning,
      })),
      statusGroups: statusGroups.map((row) => ({
        statusGroup: row.statusGroup,
        name: row.name,
        blocksDelivery: row.blocksDelivery,
        blocksGoodsIssue: row.blocksGoodsIssue,
        blocksBilling: row.blocksBilling,
        blocksOutput: row.blocksOutput,
        isActive: row.isActive,
        fields: fields.filter((row2) => row2.statusGroup === row.statusGroup).length,
      })),
      procedures: procedures.map((row) => ({
        procedureCode: row.procedureCode,
        groupCode: row.groupCode as IncompletionGroup,
        name: row.name,
        isActive: row.isActive,
        fields: fields.filter((row2) => row2.procedureCode === row.procedureCode).map((row2) => ({
          tableName: row2.tableName,
          fieldName: row2.fieldName,
          name: fieldName(row2.tableName, row2.fieldName),
          sequence: row2.sequence,
          statusGroup: row2.statusGroup,
          isWarning: row2.isWarning,
        })),
      })),
      assignments: assignments.map((row) => ({
        documentCategory: row.documentCategory as IncompletionDocumentCategory,
        documentType: row.documentType,
        documentTypeName: typeName.get(row.documentType) ?? null,
        procedureCode: row.procedureCode,
        procedureName: procedureOf.get(row.procedureCode)?.name ?? null,
        groupCode: (procedureOf.get(row.procedureCode)?.groupCode ?? null) as IncompletionGroup | null,
      })),
      checkable: checkableFields(),
      documentTypes: types.map((row) => ({ documentType: row.documentType, name: row.name })),
    };
  });
}

/**
 * Name a status group: what a missing field stops.
 *
 * A group that blocks nothing is a legitimate thing to maintain — it is how a tenant says *record
 * this, stop nothing* — but a group that blocks everything is a promise the screens have to keep,
 * which is why the four functions are named one by one rather than implied by a severity.
 */
export async function saveIncompletionStatusGroup(input: {
  client: string; changedBy: string;
  statusGroup: string; name: string;
  blocksDelivery?: boolean; blocksGoodsIssue?: boolean;
  blocksBilling?: boolean; blocksOutput?: boolean;
}): Promise<void> {
  const code = input.statusGroup.trim().toUpperCase();
  if (!STATUS_CODE.test(code)) {
    throw new IncompletionError(
      `Status group ${input.statusGroup} is not a status group code.`,
      'Name it in one or two capital letters or digits, the way a document type is named.',
    );
  }
  const name = input.name.trim();
  if (!NAME.test(name)) {
    throw new IncompletionError(
      'A status group is named by what it stops, not by how important it is.',
      'Name it in up to forty characters, so a reader can tell one group from another.',
    );
  }
  const blocked = {
    blocksDelivery: input.blocksDelivery ?? false,
    blocksGoodsIssue: input.blocksGoodsIssue ?? false,
    blocksBilling: input.blocksBilling ?? false,
    blocksOutput: input.blocksOutput ?? false,
  };
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(incompletionStatusGroup).where(and(
      eq(incompletionStatusGroup.client, input.client),
      eq(incompletionStatusGroup.statusGroup, code),
    )).limit(1);
    if (standing) {
      await tx.update(incompletionStatusGroup).set({
        ...blocked, changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(incompletionStatusGroup.client, input.client),
        eq(incompletionStatusGroup.statusGroup, code),
      ));
      await recordChange(tx, {
        client: input.client, objectClass: INCOMPLETION_STATUS_GROUP_OBJECT_CLASS, objectKey: code,
        changeType: 'CHANGE', changedBy: input.changedBy,
        before: {
          blocksDelivery: standing.blocksDelivery, blocksGoodsIssue: standing.blocksGoodsIssue,
          blocksBilling: standing.blocksBilling, blocksOutput: standing.blocksOutput,
        },
        after: blocked,
        securityRelevantFields: ['blocksDelivery', 'blocksGoodsIssue', 'blocksBilling', 'blocksOutput'],
      });
      return;
    }
    await tx.insert(incompletionStatusGroup).values({
      client: input.client, statusGroup: code, name, ...blocked, createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client, objectClass: INCOMPLETION_STATUS_GROUP_OBJECT_CLASS, objectKey: code,
      changeType: 'CREATE', changedBy: input.changedBy, after: { name, ...blocked },
      securityRelevantFields: ['blocksDelivery', 'blocksGoodsIssue', 'blocksBilling', 'blocksOutput'],
    });
  });
}

/** Withdraw a status group, or restore one. */
export async function changeIncompletionStatusGroupStatus(input: {
  client: string; changedBy: string; statusGroup: string; isActive: boolean;
}): Promise<void> {
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(incompletionStatusGroup).where(and(
      eq(incompletionStatusGroup.client, input.client),
      eq(incompletionStatusGroup.statusGroup, input.statusGroup),
    )).limit(1);
    if (!standing) {
      throw new IncompletionError(
        `Status group ${input.statusGroup} does not stand, so there is nothing to change.`,
        `Define it at ${INCOMPLETION_ROUTE} first.`,
      );
    }
    await tx.update(incompletionStatusGroup).set({
      isActive: input.isActive, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(incompletionStatusGroup.client, input.client),
      eq(incompletionStatusGroup.statusGroup, input.statusGroup),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: INCOMPLETION_STATUS_GROUP_OBJECT_CLASS,
      objectKey: input.statusGroup, changeType: 'CHANGE', changedBy: input.changedBy,
      before: { isActive: standing.isActive }, after: { isActive: input.isActive },
      securityRelevantFields: ['isActive'],
    });
  });
}

/**
 * Name an incompletion procedure: a list of the fields a document of one group must carry.
 *
 * It belongs to one group, because a header check and an item check are not the same question, and
 * it means nothing at all until it is assigned to a document type.
 */
export async function saveIncompletionProcedure(input: {
  client: string; changedBy: string;
  procedureCode: string; groupCode: string; name: string;
}): Promise<void> {
  const code = input.procedureCode.trim().toUpperCase();
  if (!CODE.test(code)) {
    throw new IncompletionError(
      `Procedure ${input.procedureCode} is not a procedure code.`,
      'Name it in up to four capital letters or digits, the way a pricing procedure is named.',
    );
  }
  const name = input.name.trim();
  if (!NAME.test(name)) {
    throw new IncompletionError(
      'A procedure is named by the document it judges.',
      'Name it in up to forty characters, so a reader knows which document it stands behind.',
    );
  }
  const group = input.groupCode.trim().toUpperCase();
  return withTenant(input.client, async (tx) => {
    const [group2] = await tx.select().from(incompletionGroup).where(and(
      eq(incompletionGroup.client, input.client), eq(incompletionGroup.groupCode, group),
    )).limit(1);
    if (!group2) {
      throw new IncompletionError(
        `Incompletion group ${group} does not stand.`,
        `Choose one of the six the package delivers, at ${INCOMPLETION_ROUTE}.`,
      );
    }
    const [standing] = await tx.select().from(incompletionProcedure).where(and(
      eq(incompletionProcedure.client, input.client), eq(incompletionProcedure.procedureCode, code),
    )).limit(1);
    if (standing) {
      if (standing.groupCode !== group) {
        throw new IncompletionError(
          `Procedure ${code} judges the ${standing.groupCode} group, and a procedure cannot change what it judges.`,
          'Define a second procedure for the other group. A header field and an item field are not the same question.',
        );
      }
      await tx.update(incompletionProcedure).set({
        name, changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(incompletionProcedure.client, input.client), eq(incompletionProcedure.procedureCode, code),
      ));
      await recordChange(tx, {
        client: input.client, objectClass: INCOMPLETION_PROCEDURE_OBJECT_CLASS, objectKey: code,
        changeType: 'CHANGE', changedBy: input.changedBy,
        before: { name: standing.name }, after: { name },
      });
      return;
    }
    await tx.insert(incompletionProcedure).values({
      client: input.client, procedureCode: code, groupCode: group as IncompletionGroup, name,
      createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client, objectClass: INCOMPLETION_PROCEDURE_OBJECT_CLASS, objectKey: code,
      changeType: 'CREATE', changedBy: input.changedBy, after: { name, groupCode: group },
    });
  });
}

/** Withdraw a procedure, or restore one. A withdrawn procedure judges nothing. */
export async function changeIncompletionProcedureStatus(input: {
  client: string; changedBy: string; procedureCode: string; isActive: boolean;
}): Promise<void> {
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(incompletionProcedure).where(and(
      eq(incompletionProcedure.client, input.client),
      eq(incompletionProcedure.procedureCode, input.procedureCode),
    )).limit(1);
    if (!standing) {
      throw new IncompletionError(
        `Procedure ${input.procedureCode} does not stand, so there is nothing to change.`,
        `Define it at ${INCOMPLETION_ROUTE} first.`,
      );
    }
    await tx.update(incompletionProcedure).set({
      isActive: input.isActive, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(incompletionProcedure.client, input.client),
      eq(incompletionProcedure.procedureCode, input.procedureCode),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: INCOMPLETION_PROCEDURE_OBJECT_CLASS,
      objectKey: input.procedureCode, changeType: 'CHANGE', changedBy: input.changedBy,
      before: { isActive: standing.isActive }, after: { isActive: input.isActive },
      securityRelevantFields: ['isActive'],
    });
  });
}

/**
 * Add a field to a procedure, or change the one that stands.
 *
 * The refusal that matters here is the first one: a field the evaluator does not know cannot be
 * maintained, because a maintained field nothing evaluates would leave every document of that type
 * permanently incomplete, and the log would say so forever without anyone being able to fix it.
 */
export async function saveIncompletionProcedureField(input: {
  client: string; changedBy: string;
  procedureCode: string; tableName: string; fieldName: string;
  sequence: number; statusGroup: string; isWarning?: boolean;
}): Promise<void> {
  const table = input.tableName.trim();
  const field = input.fieldName.trim();
  const known = fieldOf(table, field);
  if (!known) {
    const offered = checkableFields().map((row) => `${row.table}.${row.field}`).join(', ');
    throw new IncompletionError(
      `${table}.${field} is not a field this package can judge.`,
      `Choose one the evaluator knows how to look at: ${offered}.`,
    );
  }
  if (!Number.isInteger(input.sequence) || input.sequence <= 0) {
    throw new IncompletionError(
      'A field is reported in the sequence the procedure names it in.',
      'Number the fields from one, in the order a clerk should fill them in.',
    );
  }
  return withTenant(input.client, async (tx) => {
    const [procedure] = await tx.select().from(incompletionProcedure).where(and(
      eq(incompletionProcedure.client, input.client),
      eq(incompletionProcedure.procedureCode, input.procedureCode),
    )).limit(1);
    if (!procedure) {
      throw new IncompletionError(
        `Procedure ${input.procedureCode} does not stand.`,
        `Define the procedure at ${INCOMPLETION_ROUTE} before giving it fields.`,
      );
    }
    if (procedure.groupCode !== known.group) {
      throw new IncompletionError(
        `${table}.${field} is a ${known.group}-group field, and procedure ${input.procedureCode} judges the ${procedure.groupCode} group.`,
        'Put the field on a procedure of its own group. A header field cannot be judged line by line.',
      );
    }
    const [group] = await tx.select().from(incompletionStatusGroup).where(and(
      eq(incompletionStatusGroup.client, input.client),
      eq(incompletionStatusGroup.statusGroup, input.statusGroup),
    )).limit(1);
    if (!group) {
      throw new IncompletionError(
        `Status group ${input.statusGroup} does not stand, so the field cannot say what its absence stops.`,
        `Define the status group at ${INCOMPLETION_ROUTE} first.`,
      );
    }
    const isWarning = input.isWarning ?? false;
    const values = {
      client: input.client,
      procedureCode: input.procedureCode,
      tableName: table,
      fieldName: field,
      sequence: input.sequence,
      statusGroup: input.statusGroup,
      isWarning,
      createdBy: input.changedBy,
    };
    const [standing] = await tx.select().from(incompletionProcedureField).where(and(
      eq(incompletionProcedureField.client, input.client),
      eq(incompletionProcedureField.procedureCode, input.procedureCode),
      eq(incompletionProcedureField.tableName, table),
      eq(incompletionProcedureField.fieldName, field),
    )).limit(1);
    if (standing) {
      await tx.update(incompletionProcedureField).set({
        sequence: input.sequence, statusGroup: input.statusGroup, isWarning,
        changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(incompletionProcedureField.client, input.client),
        eq(incompletionProcedureField.procedureCode, input.procedureCode),
        eq(incompletionProcedureField.tableName, table),
        eq(incompletionProcedureField.fieldName, field),
      ));
      await recordChange(tx, {
        client: input.client, objectClass: INCOMPLETION_PROCEDURE_FIELD_OBJECT_CLASS,
        objectKey: `${input.procedureCode}/${table}.${field}`, changeType: 'CHANGE',
        changedBy: input.changedBy,
        before: {
          sequence: standing.sequence, statusGroup: standing.statusGroup,
          isWarning: standing.isWarning,
        },
        after: { sequence: input.sequence, statusGroup: input.statusGroup, isWarning },
        securityRelevantFields: ['statusGroup', 'isWarning'],
      });
      return;
    }
    await tx.insert(incompletionProcedureField).values(values);
    await recordChange(tx, {
      client: input.client, objectClass: INCOMPLETION_PROCEDURE_FIELD_OBJECT_CLASS,
      objectKey: `${input.procedureCode}/${table}.${field}`, changeType: 'CREATE',
      changedBy: input.changedBy,
      after: { sequence: input.sequence, statusGroup: input.statusGroup, isWarning },
      securityRelevantFields: ['statusGroup', 'isWarning'],
    });
  });
}

/** Take a field out of a procedure. The documents it judged are not re-judged; the next change is. */
export async function withdrawIncompletionProcedureField(input: {
  client: string; changedBy: string;
  procedureCode: string; tableName: string; fieldName: string;
}): Promise<void> {
  return withTenant(input.client, async (tx) => {
    const removed = await tx.delete(incompletionProcedureField).where(and(
      eq(incompletionProcedureField.client, input.client),
      eq(incompletionProcedureField.procedureCode, input.procedureCode),
      eq(incompletionProcedureField.tableName, input.tableName),
      eq(incompletionProcedureField.fieldName, input.fieldName),
    )).returning({ fieldName: incompletionProcedureField.fieldName });
    if (removed.length === 0) {
      throw new IncompletionError(
        `Procedure ${input.procedureCode} does not check ${input.tableName}.${input.fieldName}.`,
        'Withdraw a field the procedure carries.',
      );
    }
    await recordChange(tx, {
      client: input.client, objectClass: INCOMPLETION_PROCEDURE_FIELD_OBJECT_CLASS,
      objectKey: `${input.procedureCode}/${input.tableName}.${input.fieldName}`,
      changeType: 'DELETE', changedBy: input.changedBy,
      before: { procedureCode: input.procedureCode },
      securityRelevantFields: ['procedureCode'],
    });
  });
}

/**
 * Assign a procedure to a document type. This is the act that makes any of it bite.
 *
 * Every document type that stands today carries no assignment, so nothing is checked and nothing is
 * recorded until a tenant does this by name.
 */
export async function assignIncompletionProcedure(input: {
  client: string; changedBy: string;
  documentCategory: IncompletionDocumentCategory;
  documentType: string; procedureCode: string;
}): Promise<void> {
  return withTenant(input.client, async (tx) => {
    const [type] = await tx.select().from(salesDocumentType).where(and(
      eq(salesDocumentType.client, input.client),
      eq(salesDocumentType.documentType, input.documentType),
    )).limit(1);
    if (!type) {
      throw new IncompletionError(
        `Document type ${input.documentType} does not stand.`,
        'Assign a procedure to a document type that exists.',
      );
    }
    const [procedure] = await tx.select().from(incompletionProcedure).where(and(
      eq(incompletionProcedure.client, input.client),
      eq(incompletionProcedure.procedureCode, input.procedureCode),
    )).limit(1);
    if (!procedure) {
      throw new IncompletionError(
        `Procedure ${input.procedureCode} does not stand.`,
        `Define the procedure at ${INCOMPLETION_ROUTE} before assigning it.`,
      );
    }
    const inserted = await tx.insert(incompletionAssignment).values({
      client: input.client,
      documentCategory: input.documentCategory,
      documentType: input.documentType,
      procedureCode: input.procedureCode,
      createdBy: input.changedBy,
    }).onConflictDoNothing().returning({ procedureCode: incompletionAssignment.procedureCode });
    if (inserted.length === 0) {
      throw new IncompletionError(
        `Document type ${input.documentType} is already judged by procedure ${input.procedureCode}.`,
        `Withdraw the standing assignment at ${INCOMPLETION_ROUTE} rather than assigning it twice.`,
      );
    }
    await recordChange(tx, {
      client: input.client, objectClass: INCOMPLETION_ASSIGNMENT_OBJECT_CLASS,
      objectKey: `${input.documentCategory}/${input.documentType}/${input.procedureCode}`,
      changeType: 'CREATE', changedBy: input.changedBy,
      after: {
        documentCategory: input.documentCategory,
        documentType: input.documentType,
        procedureCode: input.procedureCode,
      },
      securityRelevantFields: ['procedureCode'],
    });
  });
}

/** Withdraw an assignment. The documents already judged keep the log they stand at. */
export async function withdrawIncompletionAssignment(input: {
  client: string; changedBy: string;
  documentCategory: IncompletionDocumentCategory;
  documentType: string; procedureCode: string;
}): Promise<void> {
  return withTenant(input.client, async (tx) => {
    const removed = await tx.delete(incompletionAssignment).where(and(
      eq(incompletionAssignment.client, input.client),
      eq(incompletionAssignment.documentCategory, input.documentCategory),
      eq(incompletionAssignment.documentType, input.documentType),
      eq(incompletionAssignment.procedureCode, input.procedureCode),
    )).returning({ procedureCode: incompletionAssignment.procedureCode });
    if (removed.length === 0) {
      throw new IncompletionError(
        `Document type ${input.documentType} is not judged by procedure ${input.procedureCode}.`,
        'Withdraw an assignment that stands.',
      );
    }
    await recordChange(tx, {
      client: input.client, objectClass: INCOMPLETION_ASSIGNMENT_OBJECT_CLASS,
      objectKey: `${input.documentCategory}/${input.documentType}/${input.procedureCode}`,
      changeType: 'DELETE', changedBy: input.changedBy,
      before: {
        documentCategory: input.documentCategory,
        documentType: input.documentType,
        procedureCode: input.procedureCode,
      },
      securityRelevantFields: ['procedureCode'],
    });
  });
}
