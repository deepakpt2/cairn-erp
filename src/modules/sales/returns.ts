/**
 * Returns from a customer — SD returns, movement 651 (SAP: the goods receipt a returns delivery
 * posts).
 *
 * A return is not a reversal and not a cancellation. Those say a document never should have stood.
 * A return says the goods left, the customer has sent some of them back, and now they stand in the
 * plant being decided on. What separates it from every other movement is that the goods are back and
 * they are not *stock* again yet: SAP receives a 651 into returns stock — "blocked stock returns" —
 * which is deliberately not valuated, and posts no accounting document at all. The value comes back
 * with the transfer that takes the goods out of returns stock into valuated stock after inspection
 * (453 unrestricted, 457 quality inspection, 459 blocked). Until then the quantity is counted and it
 * is not owned, which is why a 651 writes no journal and why this quantity is not available to
 * promise.
 *
 * The receipt names the delivery line the goods left on, which is what makes the quantity
 * answerable: a line cannot receive back more than was issued from it, and that bound stands in the
 * database (`delivery_line_returned_ck`) rather than in the caller's intentions.
 *
 * The movement is configuration, as the delivery's own 601 is: this module reads the `movement_type`
 * row and refuses it by name if a tenant has configured it into something that is not a returns
 * receipt — an issuing direction, a movement that carries value, a destination that is not returns
 * stock. A return that valued the goods would be a purchase wearing a returns label.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import {
  lockRequestKey, mismatchedRequest, postingFingerprint, REQUEST_MISMATCH_REMEDY,
} from '../inventory/balance-update';
import { noteBatchControlUse } from '../inventory/batch-control-use';
import { getMaterialPeriodControlInTx } from '../inventory/goods-issue';
import { materialPeriodAllows } from '../inventory/material-period-control';
import { recordOutputsForPostedDocument } from '../inventory/material-document-output';
import {
  material, materialDocument, materialDocumentLine, movementType, stockQuantity,
} from '../inventory/schema';
import { resolveStorageLocation, StorageLocationError } from '../inventory/storage-location';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import { RETURNS } from '../inventory/warehouse-stocks';
import { plant as plantTable } from '../foundation/schema';
import { STANDARD_RETURNS_DELIVERY_TYPE, salesDocumentTypeFor } from './document-type';
import { delivery, deliveryLine } from './schema';

/** The transaction code this posting records. No screen offers it yet, so no capability is bound. */
export const RETURNS_RECEIPT_TRANSACTION = 'SALES.RETURNS.RECEIPT';

/** What the user enters. The stored identity is the row below; the number is an alias, as elsewhere. */
export const RETURNS_RECEIPT_CODE = '651';
/** The reversal, posted when the receipt itself is reversed: 652. */
export const RETURNS_RECEIPT_REVERSAL_CODE = '652';

const MATERIAL_DOCUMENT_CLASS = 'material_document';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ReturnsError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ReturnsError';
    this.remedy = remedy;
  }
}

/**
 * The returns movements, delivered per tenant and then authoritative from the table. The destination
 * is returns stock and the movement carries no value, both of which the posting re-reads from
 * configuration rather than from here.
 */
export const DELIVERED_RETURNS_MOVEMENTS = [
  {
    movementType: 'RETURNS_RECEIPT',
    description: `Returns from customer (${RETURNS_RECEIPT_CODE})`,
    direction: 'RECEIPT',
    referenceCategory: 'SALES_DELIVERY',
    reversalMovementType: 'RETURNS_RECEIPT_REV',
    sourceStockType: null,
    destinationStockType: RETURNS,
    valuationRelevant: false,
  },
  {
    movementType: 'RETURNS_RECEIPT_REV',
    description: `Reversal of a returns receipt (${RETURNS_RECEIPT_REVERSAL_CODE})`,
    direction: 'REVERSAL',
    referenceCategory: 'MATERIAL_DOCUMENT',
    reversalMovementType: null,
    sourceStockType: RETURNS,
    destinationStockType: null,
    valuationRelevant: false,
  },
] as const;

async function ensureMovements(tx: Tx, client: string, changedBy: string): Promise<void> {
  for (const m of DELIVERED_RETURNS_MOVEMENTS) {
    await tx.insert(movementType).values({ client, ...m, createdBy: changedBy }).onConflictDoNothing();
  }
}

/**
 * The movement this tenant posts a customer return with — as configured, and only if it describes a
 * return into returns stock.
 */
export async function resolveReturnsMovement(tx: Tx, client: string) {
  await ensureMovements(tx, client, 'SYSTEM');
  const [row] = await tx.select().from(movementType).where(and(
    eq(movementType.client, client),
    eq(movementType.movementType, 'RETURNS_RECEIPT'),
  ));
  if (!row) {
    throw new ReturnsError(
      'This tenant configures no returns movement (RETURNS_RECEIPT).',
      `Maintain the movement type in the movement catalogue; ${RETURNS_RECEIPT_CODE} posts it.`,
    );
  }
  if (row.direction !== 'RECEIPT') {
    throw new ReturnsError(
      `Movement ${row.movementType} is configured with direction ${row.direction}, and a return takes goods back in.`,
      'Correct the direction in the movement catalogue; a return that removes stock is an issue.',
    );
  }
  if (row.referenceCategory !== 'SALES_DELIVERY') {
    throw new ReturnsError(
      `Movement ${row.movementType} is configured to reference ${row.referenceCategory}, and a customer return references the delivery the goods left on.`,
      'Correct the reference category in the movement catalogue.',
    );
  }
  if (row.destinationStockType !== RETURNS) {
    throw new ReturnsError(
      `Movement ${row.movementType} is configured to receive into ${row.destinationStockType ?? 'no stock type'}, and a customer return is received into returns stock.`,
      `Set the destination stock type to ${RETURNS}; goods received straight into valuated stock are a purchase, not a return.`,
    );
  }
  if (row.valuationRelevant) {
    throw new ReturnsError(
      `Movement ${row.movementType} is configured to carry value, and a return into returns stock carries none.`,
      'Set the movement to not valuation relevant; the value comes back with the transfer out of returns stock.',
    );
  }
  return row;
}

export interface ReturnsReceiptLineInput {
  /** The delivery line the goods are coming back against. */
  lineNumber: number;
  quantity: number;
  /** Defaults to the plant's own receiving location. */
  storageLocation?: string;
}

export interface PostReturnsReceiptInput {
  client: string;
  changedBy: string;
  /** The delivery the goods went out on, and come back against. */
  deliveryNumber: string;
  postingDate: string;
  documentDate?: string;
  headerText?: string;
  externalReference?: string;
  /**
   * The caller's idempotency key. A resubmission with the same key is answered with the document the
   * first attempt posted, so goods are not received twice by a form pressed twice.
   */
  requestKey: string;
  lines: ReturnsReceiptLineInput[];
}

export interface ReturnsReceiptLineResult {
  lineNumber: number;
  materialNumber: string;
  plant: string;
  storageLocation: string;
  quantity: number;
  baseQuantity: number;
  unit: string;
}

export interface ReturnsReceiptResult {
  materialDocumentNumber: string;
  documentYear: number;
  deliveryNumber: string;
  stockType: string;
  lines: ReturnsReceiptLineResult[];
}

function validateInput(input: PostReturnsReceiptInput): void {
  if (!input.client?.trim()) throw new ReturnsError('A returns receipt names the tenant it belongs to.');
  if (!input.changedBy?.trim()) throw new ReturnsError('A returns receipt names who posted it.');
  if (!input.deliveryNumber?.trim()) {
    throw new ReturnsError('A returns receipt names the delivery the goods left on.', 'Give the delivery number.');
  }
  if (!ISO_DATE.test(input.postingDate)) {
    throw new ReturnsError(`Posting date ${input.postingDate} is not an ISO date.`, 'Post with a date like 2026-11-07.');
  }
  if (input.documentDate != null && !ISO_DATE.test(input.documentDate)) {
    throw new ReturnsError(`Document date ${input.documentDate} is not an ISO date.`, 'Post with a date like 2026-11-07.');
  }
  if (!input.requestKey?.trim()) throw new ReturnsError('A returns receipt carries the request key it is posted under.');
  if (!input.lines?.length) {
    throw new ReturnsError('A returns receipt carries at least one line.', 'Name the delivery lines the goods came back against.');
  }
  const seen = new Set<number>();
  for (const line of input.lines) {
    if (!Number.isInteger(line.lineNumber) || line.lineNumber <= 0) {
      throw new ReturnsError(`Delivery line ${line.lineNumber} is not a line number.`, 'Name the delivery line by its number.');
    }
    if (seen.has(line.lineNumber)) {
      throw new ReturnsError(`Delivery line ${line.lineNumber} is named twice.`, 'Return each delivery line once.');
    }
    seen.add(line.lineNumber);
    if (!(line.quantity > 0)) {
      throw new ReturnsError(
        `Delivery line ${line.lineNumber} states no positive quantity to receive back.`,
        'Return a quantity greater than zero.',
      );
    }
  }
}

/** Receive quantity into a stock bucket. Returns stock is not valuated, so no value moves here. */
async function receiveStock(
  tx: Tx, client: string, changedBy: string,
  row: { materialNumber: string; plant: string; storageLocation: string; stockType: string; batchNumber?: string },
  delta: number,
): Promise<void> {
  const batchNumber = row.batchNumber ?? '';
  const [existing] = await tx.select().from(stockQuantity).where(and(
    eq(stockQuantity.client, client),
    eq(stockQuantity.materialNumber, row.materialNumber),
    eq(stockQuantity.plant, row.plant),
    eq(stockQuantity.storageLocation, row.storageLocation),
    eq(stockQuantity.stockType, row.stockType),
    eq(stockQuantity.batchNumber, batchNumber),
  ));
  if (!existing) {
    await tx.insert(stockQuantity).values({
      client, materialNumber: row.materialNumber, plant: row.plant,
      storageLocation: row.storageLocation, stockType: row.stockType, batchNumber,
      quantity: String(delta), createdBy: changedBy,
    });
    return;
  }
  await tx.update(stockQuantity).set({
    quantity: String(Number(existing.quantity) + delta),
    changedBy, changedAt: new Date(),
  }).where(and(
    eq(stockQuantity.client, client),
    eq(stockQuantity.materialNumber, row.materialNumber),
    eq(stockQuantity.plant, row.plant),
    eq(stockQuantity.storageLocation, row.storageLocation),
    eq(stockQuantity.stockType, row.stockType),
    eq(stockQuantity.batchNumber, batchNumber),
  ));
}

/** Rebuild the result of a receipt the database already holds — the answer to a repeated request. */
async function standingReceipt(
  tx: Tx, client: string, materialDocumentNumber: string, deliveryNumber: string,
): Promise<ReturnsReceiptResult> {
  const rows = await tx.select().from(materialDocumentLine).where(and(
    eq(materialDocumentLine.client, client),
    eq(materialDocumentLine.materialDocumentNumber, materialDocumentNumber),
  ));
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client),
    eq(materialDocument.materialDocumentNumber, materialDocumentNumber),
  ));
  const deliveryLines = await tx.select().from(deliveryLine).where(and(
    eq(deliveryLine.client, client),
    eq(deliveryLine.deliveryNumber, deliveryNumber),
  ));
  const byMaterial = new Map(deliveryLines.map((line) => [line.materialNumber, line]));
  return {
    materialDocumentNumber,
    documentYear: header?.documentYear ?? 0,
    deliveryNumber,
    stockType: RETURNS,
    lines: rows.map((row) => ({
      lineNumber: byMaterial.get(row.materialNumber)?.lineNumber ?? 0,
      materialNumber: row.materialNumber,
      plant: row.plant,
      storageLocation: row.storageLocation ?? '',
      quantity: Number(row.entryQuantity),
      baseQuantity: Number(row.baseQuantity),
      unit: row.entryUnit ?? '',
    })),
  };
}

export async function postReturnsReceipt(input: PostReturnsReceiptInput): Promise<ReturnsReceiptResult> {
  validateInput(input);
  return withTenant(input.client, (tx) => postReturnsReceiptInTx(tx, input));
}

/** Post a returns receipt inside an existing tenant transaction so callers can compose it. */
export async function postReturnsReceiptInTx(tx: Tx, input: PostReturnsReceiptInput): Promise<ReturnsReceiptResult> {
  validateInput(input);
  const [scope] = await tx.execute(sql<{ client: string | null }>`
    select current_setting('cairn.client', true) as client
  `);
  if (scope?.client !== input.client) {
    throw new ReturnsError('The returns transaction is not scoped to the requested tenant.');
  }

  const movement = await resolveReturnsMovement(tx, input.client);
  const fingerprint = postingFingerprint([
    'returns-receipt', input.client, input.deliveryNumber, input.postingDate,
    ...input.lines.flatMap((line) => [line.lineNumber, line.quantity, line.storageLocation ?? '']),
  ]);
  await lockRequestKey(tx, input.client, input.requestKey);
  const [standing] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, input.client),
    eq(materialDocument.requestKey, input.requestKey),
  ));
  if (standing) {
    const mismatch = await mismatchedRequest(tx, input.client, input.requestKey, fingerprint);
    if (mismatch) throw new ReturnsError(mismatch, REQUEST_MISMATCH_REMEDY);
    // The same request pressed twice: answer with the receipt the first attempt posted, so goods are
    // not received twice by a form that was submitted twice.
    return await standingReceipt(tx, input.client, standing.materialDocumentNumber, input.deliveryNumber);
  }

  const [header] = await tx.select().from(delivery).where(and(
    eq(delivery.client, input.client),
    eq(delivery.deliveryNumber, input.deliveryNumber),
  ));
  if (!header) {
    throw new ReturnsError(
      `Delivery ${input.deliveryNumber} does not stand for this tenant.`,
      'Return against a delivery that exists.',
    );
  }
  if (header.status !== 'GOODS_ISSUED') {
    throw new ReturnsError(
      `Delivery ${input.deliveryNumber} is ${header.status}, and goods can only come back from a delivery that has been issued.`,
      'Post the goods issue first; nothing has left the plant to return.',
    );
  }

  const lines = await tx.select().from(deliveryLine).where(and(
    eq(deliveryLine.client, input.client),
    eq(deliveryLine.deliveryNumber, input.deliveryNumber),
  ));
  const byNumber = new Map(lines.map((line) => [line.lineNumber, line]));
  const posted: ReturnsReceiptLineResult[] = [];
  const prepared: Array<{
    line: (typeof lines)[number];
    quantity: number;
    baseQuantity: number;
    storageLocation: string;
    baseUnit: string;
  }> = [];

  for (const requested of input.lines) {
    const line = byNumber.get(requested.lineNumber);
    if (!line) {
      throw new ReturnsError(
        `Delivery ${input.deliveryNumber} carries no line ${requested.lineNumber}.`,
        'Name a line the delivery actually carries.',
      );
    }
    const open = Number(line.goodsIssueQuantity) - Number(line.returnedQuantity);
    if (requested.quantity > open + 1e-9) {
      throw new ReturnsError(
        `Delivery line ${requested.lineNumber} has already received back ${Number(line.returnedQuantity)} of the ${Number(line.goodsIssueQuantity)} that was issued, so only ${open} can come back.`,
        'Return no more than was issued; the goods that never left cannot come back.',
      );
    }
    const [materialRow] = await tx.select().from(material).where(and(
      eq(material.client, input.client),
      eq(material.materialNumber, line.materialNumber),
    ));
    if (!materialRow) {
      throw new ReturnsError(
        `Material ${line.materialNumber} does not stand for this tenant.`,
        'The delivery names a material this tenant does not carry.',
      );
    }
    const baseUnit = materialRow.baseUnit?.trim();
    if (!baseUnit) {
      throw new ReturnsError(
        `Material ${line.materialNumber} carries no base unit of measure.`,
        'Maintain the base unit on the material master; a movement cannot be recorded without one.',
      );
    }
    const entryUnit = line.quantityUnit.trim();
    let baseQuantity = requested.quantity;
    if (entryUnit !== baseUnit) {
      try {
        const conversion = await toBaseQuantity(tx, input.client, {
          materialNumber: line.materialNumber, quantity: requested.quantity, entryUnit,
        });
        baseQuantity = conversion.baseQuantity;
      } catch (caught) {
        if (caught instanceof UnitConversionError) throw new ReturnsError(caught.message, caught.remedy);
        throw caught;
      }
    }
    let storageLocation: string;
    try {
      const resolved = await resolveStorageLocation(tx, {
        client: input.client, plant: line.plant, typed: requested.storageLocation,
        required: true, applyPlantDefault: true, verb: 'Receive into',
      });
      storageLocation = resolved.row!.storageLocation;
    } catch (caught) {
      if (caught instanceof StorageLocationError) throw new ReturnsError(caught.message, caught.remedy);
      throw caught;
    }
    prepared.push({ line, quantity: requested.quantity, baseQuantity, storageLocation, baseUnit });
  }

  // The period: a return belongs to the period it is posted in, and a closed period is closed for
  // returns as it is for everything else.
  const [plantRow] = await tx.select().from(plantTable).where(and(
    eq(plantTable.client, input.client),
    eq(plantTable.plant, header.plant),
  ));
  const companyCode = plantRow?.companyCode?.trim();
  if (!companyCode) {
    throw new ReturnsError(`Plant ${header.plant} has no company-code assignment.`, 'Assign the plant to a company code, then post the return.');
  }
  const company = await getCompanyCode(tx, input.client, companyCode);
  if (!company?.fiscalYearVariant) {
    throw new ReturnsError(`Company code ${companyCode} has no fiscal-year variant.`);
  }
  const currency = company.currency?.trim();
  if (!currency) throw new ReturnsError(`Company code ${companyCode} has no posting currency.`);
  const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
  const control = await getMaterialPeriodControlInTx(tx, input.client, companyCode);
  if (control && !materialPeriodAllows(control, position.fiscalYear, position.period)) {
    throw new ReturnsError(
      `Period ${position.fiscalYear}/${position.period} is closed for goods movements.`,
      'Open the period for materials, or post the return in the period it belongs to.',
    );
  }

  const allocated = await allocateNumber(tx, {
    client: input.client, objectCode: 'MATDOC', allocatedBy: input.changedBy,
  });
  const number = allocated.display;
  const documentDate = input.documentDate?.trim() || input.postingDate;

  // No journal: returns stock is not valuated, and SAP posts no accounting document for a 651. The
  // value returns with the transfer out of returns stock, not with the goods coming back.
  await tx.insert(materialDocument).values({
    client: input.client, materialDocumentNumber: number, documentYear: position.fiscalYear,
    documentDate, postingDate: input.postingDate,
    headerText: input.headerText?.trim() || `SD return ${input.deliveryNumber}`.slice(0, 25),
    status: 'POSTED',
    externalReference: input.externalReference?.trim() || null,
    journalDocumentNumber: null,
    requestKey: input.requestKey, requestFingerprint: fingerprint,
    createdBy: input.changedBy,
  });

  let lineNumber = 0;
  for (const item of prepared) {
    lineNumber += 1;
    const unitPrice = '0';
    const value = '0';
    await tx.insert(materialDocumentLine).values({
      client: input.client, materialDocumentNumber: number, lineNumber,
      movementType: movement.movementType, lineDirection: 'RECEIPT',
      materialNumber: item.line.materialNumber, plant: item.line.plant,
      storageLocation: item.storageLocation, stockType: RETURNS, batchNumber: '',
      entryQuantity: String(item.quantity), entryUnit: item.line.quantityUnit.trim(),
      baseQuantity: String(item.baseQuantity), baseUnit: item.baseUnit,
      unitPrice, priceUnit: '1', currency, value,
      itemText: `Return ${RETURNS_RECEIPT_CODE}`.slice(0, 40),
      createdBy: input.changedBy,
    });
    await receiveStock(tx, input.client, input.changedBy, {
      materialNumber: item.line.materialNumber, plant: item.line.plant,
      storageLocation: item.storageLocation, stockType: RETURNS,
    }, item.baseQuantity);
    const applied = await tx.update(deliveryLine).set({
      returnedQuantity: String(Number(item.line.returnedQuantity) + item.quantity),
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(deliveryLine.client, input.client),
      eq(deliveryLine.deliveryNumber, input.deliveryNumber),
      eq(deliveryLine.lineNumber, item.line.lineNumber),
      eq(deliveryLine.returnedQuantity, item.line.returnedQuantity),
    )).returning({ number: deliveryLine.lineNumber });
    if (!applied.length) {
      throw new ReturnsError(
        `Delivery line ${item.line.lineNumber} changed while the return was being posted. The receipt was rolled back with it.`,
      );
    }
    posted.push({
      lineNumber: item.line.lineNumber,
      materialNumber: item.line.materialNumber,
      plant: item.line.plant,
      storageLocation: item.storageLocation,
      quantity: item.quantity,
      baseQuantity: item.baseQuantity,
      unit: item.line.quantityUnit.trim(),
    });
  }

  await recordChange(tx, {
    client: input.client,
    objectClass: MATERIAL_DOCUMENT_CLASS,
    objectKey: number,
    changeType: 'CREATE',
    changedBy: input.changedBy,
    transactionCode: RETURNS_RECEIPT_TRANSACTION,
    after: {
      movement: movement.movementType, return: RETURNS_RECEIPT_CODE,
      delivery: input.deliveryNumber, stockType: RETURNS,
      lines: posted.length, journal: null, status: 'POSTED',
    },
  });
  await noteBatchControlUse(tx, input.client, number, input.changedBy);
  await recordOutputsForPostedDocument(tx, input.client, number, input.changedBy);

  return {
    materialDocumentNumber: number,
    documentYear: position.fiscalYear,
    deliveryNumber: input.deliveryNumber,
    stockType: RETURNS,
    lines: posted,
  };
}

/**
 * The returns delivery — SAP's LR.
 *
 * A return has been postable by naming an outbound delivery and calling the receipt directly. That
 * works for the movement and it is not enough for the chain: nothing else can point at the return,
 * so a credit memo has nothing to name, a document flow has nothing to draw, and "what came back"
 * lives in a column on the delivery the goods left on instead of in a document of its own.
 *
 * The returns delivery names the delivery it came back against and carries the quantity on its own
 * lines. Posting it is what posts the 651: the document moves the goods, and the receipt inside it
 * is the movement.
 *
 * One thing it deliberately does not do. A returns delivery is not an outbound delivery that happens
 * to run backwards, and every place that answers "how much of this order line has been delivered"
 * has to keep saying the same number before and after a return — returning goods does not undeliver
 * them. Those readers exclude returns deliveries by document type, and a test holds them to it.
 */
/** A line of a returns delivery: the delivery line the goods came back against, and how much of it. */
export interface ReturnsDeliveryLineInput {
  /** The line of the outbound delivery the goods are coming back against. */
  lineNumber: number;
  quantity: number;
}

/** The transaction code the returns delivery records. No screen offers it yet. */
export const RETURNS_DELIVERY_TRANSACTION = 'SALES.RETURNS.DELIVERY';

export interface CreateReturnsDeliveryInput {
  client: string;
  changedBy: string;
  /** The outbound delivery the goods went out on. */
  deliveryNumber: string;
  deliveryDate: string;
  headerText?: string;
  requestKey: string;
  items: ReturnsDeliveryLineInput[];
}

export interface PostReturnsDeliveryInput {
  client: string;
  changedBy: string;
  /** The returns delivery being received. */
  deliveryNumber: string;
  expectedVersion: number;
  postingDate: string;
  documentDate?: string;
  requestKey: string;
}

function validateReturnsDeliveryInput(input: CreateReturnsDeliveryInput): void {
  if (!input.client?.trim()) throw new ReturnsError('A returns delivery names the tenant it belongs to.');
  if (!input.changedBy?.trim()) throw new ReturnsError('A returns delivery names who created it.');
  if (!input.deliveryNumber?.trim()) {
    throw new ReturnsError('A returns delivery names the delivery the goods left on.', 'Give the delivery number.');
  }
  if (!ISO_DATE.test(input.deliveryDate)) {
    throw new ReturnsError(`Delivery date ${input.deliveryDate} is not an ISO date.`, 'Create the return with a date like 2026-11-07.');
  }
  if (!input.requestKey?.trim()) throw new ReturnsError('A returns delivery carries the request key it is created under.');
  if (!input.items?.length) {
    throw new ReturnsError('A returns delivery carries at least one item.', 'Name the delivery lines the goods came back against.');
  }
  const seen = new Set<number>();
  for (const item of input.items) {
    if (!Number.isInteger(item.lineNumber) || item.lineNumber <= 0) {
      throw new ReturnsError(`Delivery line ${item.lineNumber} is not a line number.`);
    }
    if (seen.has(item.lineNumber)) {
      throw new ReturnsError(`Delivery line ${item.lineNumber} is named twice.`, 'Return each delivery line once.');
    }
    seen.add(item.lineNumber);
    if (!(item.quantity > 0)) {
      throw new ReturnsError(
        `Delivery line ${item.lineNumber} states no positive quantity to receive back.`,
        'Return a quantity greater than zero.',
      );
    }
  }
}

export async function createReturnsDelivery(
  input: CreateReturnsDeliveryInput,
): Promise<{ deliveryNumber: string; replayed: boolean }> {
  validateReturnsDeliveryInput(input);
  return withTenant(input.client, async (tx) => {
    const type = await salesDocumentTypeFor(tx, input.client, STANDARD_RETURNS_DELIVERY_TYPE);
    if (!type) {
      throw new ReturnsError(
        'This tenant configures no returns delivery type (LR).',
        'Maintain the returns delivery type in the sales document type catalogue.',
      );
    }

    const [standing] = await tx.select({ number: delivery.deliveryNumber }).from(delivery).where(and(
      eq(delivery.client, input.client), eq(delivery.requestKey, input.requestKey),
    ));
    if (standing) return { deliveryNumber: standing.number, replayed: true };

    const [origin] = await tx.select().from(delivery).where(and(
      eq(delivery.client, input.client), eq(delivery.deliveryNumber, input.deliveryNumber),
    ));
    if (!origin) {
      throw new ReturnsError(
        `Delivery ${input.deliveryNumber} does not stand for this tenant.`,
        'Return against a delivery that exists.',
      );
    }
    if (origin.documentType === STANDARD_RETURNS_DELIVERY_TYPE) {
      throw new ReturnsError(
        `Delivery ${input.deliveryNumber} is itself a returns delivery, and goods come back against the delivery they left on.`,
        'Name the outbound delivery the goods were issued from.',
      );
    }
    if (origin.status !== 'GOODS_ISSUED') {
      throw new ReturnsError(
        `Delivery ${input.deliveryNumber} is ${origin.status}, and goods can only come back from a delivery that has been issued.`,
        'Post the goods issue first; nothing has left the plant to return.',
      );
    }

    const originLines = await tx.select().from(deliveryLine).where(and(
      eq(deliveryLine.client, input.client), eq(deliveryLine.deliveryNumber, input.deliveryNumber),
    ));
    const byNumber = new Map(originLines.map((line) => [line.lineNumber, line]));

    const rows: Array<typeof deliveryLine.$inferInsert> = [];
    for (const item of input.items) {
      const line = byNumber.get(item.lineNumber);
      if (!line) {
        throw new ReturnsError(
          `Delivery ${input.deliveryNumber} carries no line ${item.lineNumber}.`,
          'Name a line the delivery actually carries.',
        );
      }
      const issued = Number(line.goodsIssueQuantity);
      const already = Number(line.returnedQuantity);
      if (item.quantity > issued - already + 1e-9) {
        throw new ReturnsError(
          `Delivery line ${item.lineNumber} has already received back ${already} of the ${issued} that was issued, so only ${issued - already} can come back.`,
          'Return no more than was issued; the goods that never left cannot come back.',
        );
      }
      rows.push({
        client: input.client, deliveryNumber: '', lineNumber: item.lineNumber,
        orderNumber: line.orderNumber, orderLineNumber: line.orderLineNumber,
        materialNumber: line.materialNumber, plant: line.plant, quantityUnit: line.quantityUnit,
        // Ordered against what left, delivered-before against what has already come back, so the
        // line's own remaining quantity answers how much of the shipment might still return.
        orderedQuantity: line.goodsIssueQuantity, deliveredBefore: line.returnedQuantity,
        deliveryQuantity: String(item.quantity),
        remainingQuantity: String(issued - already - item.quantity),
        pickedQuantity: '0', goodsIssueQuantity: '0', returnedQuantity: '0',
        status: 'OPEN', createdBy: input.changedBy,
      });
    }

    const drawn = await allocateNumber(tx, {
      client: input.client, objectCode: type.numberRangeObject, companyCode: '*',
      subObject: type.numberRangeSubObject, fiscalYear: 0, allocatedBy: input.changedBy,
    });
    const number = drawn.display;

    await tx.insert(delivery).values({
      client: input.client, deliveryNumber: number,
      documentType: type.documentType, referenceDeliveryNumber: origin.deliveryNumber,
      orderNumber: origin.orderNumber,
      salesOrg: origin.salesOrg, distributionChannel: origin.distributionChannel, division: origin.division,
      customerNumber: origin.customerNumber, companyCode: origin.companyCode, plant: origin.plant,
      deliveryDate: input.deliveryDate, goodsMovementDate: null,
      headerText: input.headerText?.trim() || null,
      status: 'OPEN',
      requestKey: input.requestKey, createdBy: input.changedBy,
    });
    for (const row of rows) {
      await tx.insert(deliveryLine).values({ ...row, deliveryNumber: number });
    }

    await recordChange(tx, {
      client: input.client, objectClass: 'delivery', objectKey: number, changeType: 'CREATE',
      changedBy: input.changedBy, transactionCode: RETURNS_DELIVERY_TRANSACTION,
      after: { documentType: type.documentType, returnOf: origin.deliveryNumber, items: rows.length, status: 'OPEN' },
    });

    return { deliveryNumber: number, replayed: false };
  });
}

/** Receive a returns delivery: this is what posts the 651. */
export async function postReturnsDelivery(
  input: PostReturnsDeliveryInput,
): Promise<ReturnsReceiptResult & { returnsDeliveryNumber: string }> {
  if (!input.client?.trim()) throw new ReturnsError('A returns delivery names the tenant it belongs to.');
  if (!ISO_DATE.test(input.postingDate)) {
    throw new ReturnsError(`Posting date ${input.postingDate} is not an ISO date.`, 'Post with a date like 2026-11-07.');
  }
  if (input.documentDate != null && !ISO_DATE.test(input.documentDate)) {
    throw new ReturnsError(`Document date ${input.documentDate} is not an ISO date.`, 'Post with a date like 2026-11-07.');
  }

  return withTenant(input.client, async (tx) => {
    const [header] = await tx.select().from(delivery).where(and(
      eq(delivery.client, input.client), eq(delivery.deliveryNumber, input.deliveryNumber),
    ));
    if (!header) {
      throw new ReturnsError(`Returns delivery ${input.deliveryNumber} does not stand for this tenant.`);
    }
    if (header.documentType !== STANDARD_RETURNS_DELIVERY_TYPE) {
      throw new ReturnsError(
        `Delivery ${input.deliveryNumber} is ${header.documentType}, and only a returns delivery receives goods back.`,
        'A delivery that took goods out is not received; it is billed.',
      );
    }
    if (header.status === 'CANCELLED') {
      throw new ReturnsError(`Returns delivery ${input.deliveryNumber} is cancelled, and a cancelled return receives nothing.`);
    }
    if (!header.referenceDeliveryNumber) {
      throw new ReturnsError(
        `Returns delivery ${input.deliveryNumber} names no delivery it came back against.`,
        'The delivery is incomplete: a return without an origin cannot say what may come back.',
      );
    }
    // Already received: the same request pressed twice is answered with what the first attempt
    // posted, not with a second receipt of the same goods.
    if (header.status === 'RECEIVED') {
      const receipt = await standingReceipt(
        tx, input.client, header.materialDocumentNumber ?? '', header.referenceDeliveryNumber,
      );
      return { ...receipt, returnsDeliveryNumber: header.deliveryNumber };
    }
    if (header.version !== input.expectedVersion) {
      throw new ReturnsError(
        `Returns delivery ${input.deliveryNumber} changed since it was read.`,
        'Re-read the delivery and post again.',
      );
    }

    const lines = await tx.select().from(deliveryLine).where(and(
      eq(deliveryLine.client, input.client), eq(deliveryLine.deliveryNumber, input.deliveryNumber),
    ));
    if (!lines.length) {
      throw new ReturnsError(`Returns delivery ${input.deliveryNumber} carries no items to receive.`);
    }

    const receipt = await postReturnsReceiptInTx(tx, {
      client: input.client, changedBy: input.changedBy,
      deliveryNumber: header.referenceDeliveryNumber,
      postingDate: input.postingDate, documentDate: input.documentDate,
      headerText: `Return ${header.deliveryNumber}`.slice(0, 25),
      requestKey: input.requestKey,
      lines: lines.map((line) => ({
        lineNumber: line.lineNumber,
        quantity: Number(line.deliveryQuantity),
      })),
    });

    const applied = await tx.update(delivery).set({
      status: 'RECEIVED',
      materialDocumentNumber: receipt.materialDocumentNumber,
      materialDocumentYear: receipt.documentYear,
      goodsMovementDate: input.postingDate,
      version: header.version + 1,
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(delivery.client, input.client),
      eq(delivery.deliveryNumber, input.deliveryNumber),
      eq(delivery.version, header.version),
    )).returning({ number: delivery.deliveryNumber });
    if (!applied.length) {
      throw new ReturnsError(
        `Returns delivery ${input.deliveryNumber} changed while it was being received. The receipt was rolled back with it.`,
      );
    }
    await tx.update(deliveryLine).set({
      status: 'RECEIVED', changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(deliveryLine.client, input.client),
      eq(deliveryLine.deliveryNumber, input.deliveryNumber),
    ));

    await recordChange(tx, {
      client: input.client, objectClass: 'delivery', objectKey: input.deliveryNumber,
      changeType: 'CHANGE', changedBy: input.changedBy,
      transactionCode: RETURNS_DELIVERY_TRANSACTION,
      after: {
        status: 'RECEIVED', materialDocument: receipt.materialDocumentNumber,
        returnOf: header.referenceDeliveryNumber, lines: lines.length,
      },
    });

    return { ...receipt, returnsDeliveryNumber: header.deliveryNumber };
  });
}
