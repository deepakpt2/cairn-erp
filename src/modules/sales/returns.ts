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
import {
  salesDocumentTypeFor,
} from './document-type';
import { returnsChain } from './returns-configuration';
import {
  billingDocument, billingDocumentLine, delivery, deliveryLine, salesOrder, salesOrderLine,
} from './schema';

/** The transaction code this posting records. No screen offers it yet, so no capability is bound. */
export const RETURNS_RECEIPT_TRANSACTION = 'SALES.RETURNS.RECEIPT';

/** The screen the chain is worked from, and the capability each of its three acts is gated by. */
export const RETURNS_ROUTE = '/sales/returns';
/** Raise the returns order: a commercial claim, which posts nothing. */
export const RETURNS_ORDER_CAPABILITY = 'SALES.RETURNS.ORDER.CREATE';
/** Raise the returns delivery: the document the warehouse receives against. Also posts nothing. */
export const RETURNS_DELIVERY_CAPABILITY = 'SALES.RETURNS.DELIVERY.CREATE';
/**
 * Receive the goods back, which is the 651. It moves stock into returns stock and it writes no
 * financial record, because returns stock is not valuated — value arrives when the inspected goods
 * are transferred out of it. It is a posting in the warehouse sense and not in the ledger's, which is
 * why it is not flagged posting-relevant: an auditor may watch goods come back.
 */
export const RETURNS_RECEIPT_CAPABILITY = 'SALES.RETURNS.RECEIPT.POST';

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
/** The movement the delivered returns chain receives with, named so the standard package can seed it. */
export const DELIVERED_RETURNS_RECEIPT_MOVEMENT = 'RETURNS_RECEIPT';

export const DELIVERED_RETURNS_MOVEMENTS = [
  {
    movementType: DELIVERED_RETURNS_RECEIPT_MOVEMENT,
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

/**
 * The delivered returns movements, written for a tenant that does not have them. Exported because the
 * standard package delivers them with the tenant (9237): the returns configuration carries a foreign key
 * to the receipt movement, so the movement has to stand before the configuration can name it.
 */
export async function ensureReturnsMovements(tx: Tx, client: string, changedBy: string): Promise<void> {
  for (const m of DELIVERED_RETURNS_MOVEMENTS) {
    await tx.insert(movementType).values({ client, ...m, createdBy: changedBy }).onConflictDoNothing();
  }
}

/**
 * The movement this tenant posts a customer return with — as configured, and only if it describes a
 * return into returns stock.
 */
export async function resolveReturnsMovement(tx: Tx, client: string) {
  await ensureReturnsMovements(tx, client, 'SYSTEM');
  // Which movement a return is received with is configuration (9237), not a constant: the chain names it
  // per tenant, and what follows re-reads the four facts a return must satisfy.
  const chain = await returnsChain(tx, client);
  const [row] = await tx.select().from(movementType).where(and(
    eq(movementType.client, client),
    eq(movementType.movementType, chain.receiptMovementType),
  ));
  if (!row) {
    throw new ReturnsError(
      `This tenant configures no returns movement (${chain.receiptMovementType}).`,
      'Maintain the movement in the movement catalogue, or name one that stands on the returns configuration screen.',
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
  /**
   * The line the goods are coming back against: a line of the outbound delivery when the return is
   * raised against a delivery, a line of the returns order when it is raised against an order.
   */
  lineNumber: number;
  quantity: number;
}

/** The transaction code the returns delivery records. No screen offers it yet. */
export const RETURNS_DELIVERY_TRANSACTION = 'SALES.RETURNS.DELIVERY';

export interface CreateReturnsDeliveryInput {
  client: string;
  changedBy: string;
  /**
   * The outbound delivery the goods went out on. Named when the return is raised against a delivery;
   * a return raised against a returns order names that instead, and the delivery is found from it.
   */
  deliveryNumber?: string;
  /** The returns order the goods are coming back against, as SAP raises a returns delivery. */
  returnsOrderNumber?: string;
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
  if (!input.deliveryNumber?.trim() && !input.returnsOrderNumber?.trim()) {
    throw new ReturnsError(
      'A returns delivery names what the goods are coming back against: the outbound delivery, or the returns order.',
      'Give the delivery number, or the returns order number.',
    );
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

/**
 * How much of one returns-order line has already been handed to a returns delivery, over the ones
 * that stand.
 *
 * The request is what bounds the next document, not the receipt: a returns delivery that has been
 * raised but not yet received has still promised those goods to the warehouse, and a second one for
 * the same line would promise them twice.
 */
async function quantityRequestedAgainstOrderLine(
  tx: Tx,
  client: string,
  orderNumber: string,
  orderLineNumber: number,
): Promise<number> {
  const chain = await returnsChain(tx, client);
  const [row] = await tx.execute(sql`
    select coalesce(sum(dl.delivery_quantity), 0)::text as quantity
      from delivery_line dl
      join delivery d on d.client = dl.client and d.delivery_number = dl.delivery_number
     where dl.client = ${client}
       and d.document_type = ${chain.returnsDeliveryType}
       and d.status <> 'CANCELLED'
       and dl.order_number = ${orderNumber}
       and dl.order_line_number = ${orderLineNumber}
  `) as unknown as Array<{ quantity: string }>;
  return Number(row?.quantity ?? '0');
}

/**
 * Raise a returns delivery: the document goods come back on.
 *
 * SAP raises it two ways, and so does this. Against the outbound delivery, when what is known is that
 * goods left on a particular shipment; and against a returns order, which is the way a return that
 * began as a complaint reaches the warehouse — the returns delivery is the returns order's delivery,
 * and it is what posts the 651. The two differ in what they name and in what bounds the quantity: a
 * delivery bounds it by what was issued and has not already come back, and a returns order, which has
 * already been bounded by what was invoiced, adds a second bound of its own — how much of the request
 * has not already been given a returns delivery.
 *
 * Whichever way it is raised, the document names the outbound delivery the goods left on, because
 * that is the delivery whose line carries how much has come back and whose issue the 651 answers.
 */
export async function createReturnsDelivery(
  input: CreateReturnsDeliveryInput,
): Promise<{ deliveryNumber: string; replayed: boolean }> {
  validateReturnsDeliveryInput(input);
  const raisedAgainstOrder = Boolean(input.returnsOrderNumber?.trim());
  const raisedAgainstDelivery = Boolean(input.deliveryNumber?.trim());
  if (raisedAgainstOrder === raisedAgainstDelivery) {
    throw new ReturnsError(
      'A returns delivery is raised either against the delivery the goods left on or against a returns order, and not against neither, nor against both.',
      'Name the outbound delivery, or name the returns order — one of them.',
    );
  }
  return withTenant(input.client, async (tx) => {
    const chain = await returnsChain(tx, input.client);
    const type = await salesDocumentTypeFor(tx, input.client, chain.returnsDeliveryType);
    if (!type) {
      throw new ReturnsError(
        `This tenant configures no returns delivery type (${chain.returnsDeliveryType}).`,
        'Maintain the returns delivery type on the sales document types screen, or name one that stands on the returns configuration screen.',
      );
    }

    const [standing] = await tx.select({ number: delivery.deliveryNumber }).from(delivery).where(and(
      eq(delivery.client, input.client), eq(delivery.requestKey, input.requestKey),
    ));
    if (standing) return { deliveryNumber: standing.number, replayed: true };

    /** What one item resolves to: the delivery line the goods left on, and the order line behind it. */
    interface RequestedLine {
      /** The delivery line of the outbound delivery the goods are coming back against. */
      deliveryLineNumber: number;
      /** The line of the order this return is raised against, if it was raised against an order. */
      orderLineNumber: number | null;
      /** How much of the request has not yet been given a returns delivery. */
      remainingOnOrder: number | null;
      quantity: number;
    }

    let originNumber = '';
    let orderNumber = '';
    const requested: RequestedLine[] = [];

    if (raisedAgainstOrder) {
      const returnsOrderNumber = input.returnsOrderNumber!.trim();
      const [order] = await tx.select().from(salesOrder).where(and(
        eq(salesOrder.client, input.client), eq(salesOrder.orderNumber, returnsOrderNumber),
      )).limit(1);
      if (!order) {
        throw new ReturnsError(
          `Returns order ${returnsOrderNumber} does not stand for this tenant.`,
          'Name a returns order that exists.',
        );
      }
      if (order.documentType !== chain.returnsOrderType) {
        throw new ReturnsError(
          `Sales order ${returnsOrderNumber} is a ${order.documentType}, and a returns delivery is raised against a returns order.`,
          'Name a returns order, or raise the return against the delivery the goods left on.',
        );
      }
      if (order.status !== 'OPEN') {
        throw new ReturnsError(
          `Returns order ${returnsOrderNumber} stands ${order.status}, and goods come back against an open return.`,
          'A return that no longer stands receives nothing; raise a new one.',
        );
      }
      const orderLines = await tx.select().from(salesOrderLine).where(and(
        eq(salesOrderLine.client, input.client), eq(salesOrderLine.orderNumber, returnsOrderNumber),
      ));
      const byNumber = new Map(orderLines.map((line) => [line.lineNumber, line]));

      for (const item of input.items) {
        const line = byNumber.get(item.lineNumber);
        if (!line) {
          throw new ReturnsError(
            `Returns order ${returnsOrderNumber} carries no line ${item.lineNumber}.`,
            'Name a line the returns order actually carries.',
          );
        }
        if (!line.referenceBillingNumber || line.referenceBillingLineNumber === null) {
          throw new ReturnsError(
            `Returns order line ${item.lineNumber} names no invoiced line, so the delivery these goods left on cannot be found.`,
            'Raise the return against the delivery instead, or raise a returns order that names the invoice.',
          );
        }
        const [billed] = await tx.select().from(billingDocumentLine).where(and(
          eq(billingDocumentLine.client, input.client),
          eq(billingDocumentLine.billingNumber, line.referenceBillingNumber),
          eq(billingDocumentLine.lineNumber, line.referenceBillingLineNumber),
        )).limit(1);
        if (!billed || !billed.deliveryNumber || billed.deliveryLineNumber === null) {
          throw new ReturnsError(
            `Returns order line ${item.lineNumber} was priced from an invoiced line that names no delivery, so these goods have nowhere to come back to.`,
            'Raise the return against the delivery the goods left on.',
          );
        }
        if (!originNumber) {
          originNumber = billed.deliveryNumber;
        } else if (originNumber !== billed.deliveryNumber) {
          throw new ReturnsError(
            `Returns order ${returnsOrderNumber} asks for goods that left on two deliveries, ${originNumber} and ${billed.deliveryNumber}, and a returns delivery comes back against one.`,
            'Raise one returns delivery for each delivery the goods left on.',
          );
        }
        // The second bound: what the request has not already handed to a returns delivery. Two
        // delivery documents for the same request are two promises of the same goods.
        const asked = await quantityRequestedAgainstOrderLine(
          tx, input.client, returnsOrderNumber, line.lineNumber,
        );
        requested.push({
          deliveryLineNumber: billed.deliveryLineNumber,
          orderLineNumber: line.lineNumber,
          remainingOnOrder: Number(line.orderQuantity) - asked,
          quantity: item.quantity,
        });
      }
      orderNumber = returnsOrderNumber;
    } else {
      originNumber = input.deliveryNumber!.trim();
      for (const item of input.items) {
        requested.push({
          deliveryLineNumber: item.lineNumber, orderLineNumber: null,
          remainingOnOrder: null, quantity: item.quantity,
        });
      }
    }

    const [origin] = await tx.select().from(delivery).where(and(
      eq(delivery.client, input.client), eq(delivery.deliveryNumber, originNumber),
    )).limit(1);
    if (!origin) {
      throw new ReturnsError(
        `Delivery ${originNumber} does not stand for this tenant.`,
        'Return against a delivery that exists.',
      );
    }
    if (origin.documentType === chain.returnsDeliveryType) {
      throw new ReturnsError(
        `Delivery ${originNumber} is itself a returns delivery, and goods come back against the delivery they left on.`,
        'Name the outbound delivery the goods were issued from.',
      );
    }
    if (origin.status !== 'GOODS_ISSUED') {
      throw new ReturnsError(
        `Delivery ${originNumber} is ${origin.status}, and goods can only come back from a delivery that has been issued.`,
        'Post the goods issue first; nothing has left the plant to return.',
      );
    }
    // A return raised against a delivery is raised against that delivery's own order.
    if (!orderNumber) orderNumber = origin.orderNumber;

    const originLines = await tx.select().from(deliveryLine).where(and(
      eq(deliveryLine.client, input.client), eq(deliveryLine.deliveryNumber, originNumber),
    ));
    const byNumber = new Map(originLines.map((line) => [line.lineNumber, line]));

    const rows: Array<typeof deliveryLine.$inferInsert> = [];
    for (const item of requested) {
      const line = byNumber.get(item.deliveryLineNumber);
      if (!line) {
        throw new ReturnsError(
          `Delivery ${originNumber} carries no line ${item.deliveryLineNumber}.`,
          'Name a line the delivery actually carries.',
        );
      }
      const issued = Number(line.goodsIssueQuantity);
      const already = Number(line.returnedQuantity);
      if (item.remainingOnOrder !== null && item.quantity > item.remainingOnOrder + 1e-9) {
        throw new ReturnsError(
          `Returns order line ${item.orderLineNumber} asks for ${item.quantity}, but only ${item.remainingOnOrder} of it has not been given a returns delivery already.`,
          'Receive no more than the returns order asks for; raise another returns order for the rest.',
        );
      }
      if (item.quantity > issued - already + 1e-9) {
        throw new ReturnsError(
          `Delivery line ${item.deliveryLineNumber} has already received back ${already} of the ${issued} that was issued, so only ${issued - already} can come back.`,
          'Return no more than was issued; the goods that never left cannot come back.',
        );
      }
      rows.push({
        client: input.client, deliveryNumber: '', lineNumber: item.deliveryLineNumber,
        orderNumber, orderLineNumber: item.orderLineNumber ?? line.orderLineNumber,
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
      orderNumber,
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
      after: {
        documentType: type.documentType, returnOf: origin.deliveryNumber,
        raisedAgainst: raisedAgainstOrder ? `returns order ${orderNumber}` : `delivery ${origin.deliveryNumber}`,
        items: rows.length, status: 'OPEN',
      },
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
    const chain = await returnsChain(tx, input.client);
    const [header] = await tx.select().from(delivery).where(and(
      eq(delivery.client, input.client), eq(delivery.deliveryNumber, input.deliveryNumber),
    ));
    if (!header) {
      throw new ReturnsError(`Returns delivery ${input.deliveryNumber} does not stand for this tenant.`);
    }
    if (header.documentType !== chain.returnsDeliveryType) {
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

/** The transaction a returns order records. No screen offers it yet, so no capability is bound. */
export const RETURNS_ORDER_TRANSACTION = 'SALES.RETURNS.ORDER';

/** What the user enters for one item of a returns order: the invoiced line, and how much comes back. */
export interface ReturnsOrderLineInput {
  /** The line of the invoice the goods were billed on. */
  billingLineNumber: number;
  /** How much of that line the customer is sending back, in the unit it was invoiced in. */
  quantity: number;
}

export interface CreateReturnsOrderInput {
  client: string;
  changedBy: string;
  requestKey: string;
  /** The invoice the goods were billed on, which the return is priced from. */
  billingNumber: string;
  orderDate: string;
  items: ReturnsOrderLineInput[];
  headerText?: string;
}

function round2(value: number): string {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

/** Three decimals is what every quantity column here carries; more than that cannot be stored. */
function quantityDecimals(value: number): number {
  const text = String(value);
  const point = text.indexOf('.');
  return point < 0 ? 0 : text.length - point - 1;
}

function validateReturnsOrderInput(input: CreateReturnsOrderInput): void {
  if (!ISO_DATE.test(input.orderDate)) {
    throw new ReturnsError(
      `A returns order is raised on a date, and ${input.orderDate} is not one.`,
      'Enter the date as YYYY-MM-DD.',
    );
  }
  if (input.items.length === 0) {
    throw new ReturnsError(
      'A returns order with no items returns nothing.',
      'Name at least one invoiced line, and how much of it is coming back.',
    );
  }
  const seen = new Set<number>();
  for (const item of input.items) {
    if (seen.has(item.billingLineNumber)) {
      throw new ReturnsError(
        `Invoice line ${item.billingLineNumber} was named twice.`,
        'Name each invoiced line once; two items of the same line is one item with a larger quantity.',
      );
    }
    seen.add(item.billingLineNumber);
    if (!(item.quantity > 0)) {
      throw new ReturnsError(
        `A quantity of ${item.quantity} on invoice line ${item.billingLineNumber} returns nothing.`,
        'Enter how much of the invoiced line the customer is sending back.',
      );
    }
    if (quantityDecimals(item.quantity) > 3) {
      throw new ReturnsError(
        `A quantity of ${item.quantity} carries more decimals than a quantity can hold (3).`,
        'Enter the quantity with at most three decimal places.',
      );
    }
  }
}

/**
 * How much of one invoiced line has already been asked back, over the returns orders that stand.
 *
 * The request is what bounds the next request, not the receipt: two returns orders for the same goods
 * are two promises of the same goods, and the goods are only there once.
 */
async function quantityReturnedAgainst(
  tx: Tx,
  client: string,
  billingNumber: string,
  billingLineNumber: number,
): Promise<number> {
  const chain = await returnsChain(tx, client);
  const [row] = await tx.execute(sql`
    select coalesce(sum(l.order_quantity), 0)::text as quantity
      from sales_order_line l
      join sales_order o on o.client = l.client and o.order_number = l.order_number
     where l.client = ${client}
       and o.document_type = ${chain.returnsOrderType}
       and o.status = 'OPEN'
       and l.reference_billing_number = ${billingNumber}
       and l.reference_billing_line_number = ${billingLineNumber}
  `) as unknown as Array<{ quantity: string }>;
  return Number(row?.quantity ?? '0');
}

/**
 * Raise a returns order against an invoice.
 *
 * SAP's RE exists because a return is a commercial event before it is a warehouse one: the customer
 * says what they are sending back and why, and that request is what the goods are received against and
 * what the credit memo is priced from. It is created with reference to the invoice, and it copies the
 * price, the unit and the tax that line was invoiced at rather than pricing again — a return settles
 * what was billed, and a condition record renegotiated since is no part of what the customer owes.
 *
 * The order is not credit-checked, which is the one respect in which it differs from a standard order.
 * A return is a claim against us, not a commitment of theirs: it earns the customer credit rather than
 * spending it, and a block raised on the strength of goods coming back is a block raised backwards.
 */
export async function createReturnsOrder(
  input: CreateReturnsOrderInput,
): Promise<{ orderNumber: string; replayed: boolean; netValue: string; taxValue: string; grossValue: string }> {
  validateReturnsOrderInput(input);
  return withTenant(input.client, async (tx) => {
    const chain = await returnsChain(tx, input.client);
    const type = await salesDocumentTypeFor(tx, input.client, chain.returnsOrderType);
    if (!type) {
      throw new ReturnsError(
        `This tenant configures no returns order type (${chain.returnsOrderType}).`,
        'Maintain the returns order type on the sales document types screen, or name one that stands on the returns configuration screen.',
      );
    }

    const [standing] = await tx.select({ orderNumber: salesOrder.orderNumber }).from(salesOrder).where(and(
      eq(salesOrder.client, input.client), eq(salesOrder.requestKey, input.requestKey),
    )).limit(1);
    if (standing) {
      const [saved] = await tx.select().from(salesOrder).where(and(
        eq(salesOrder.client, input.client), eq(salesOrder.orderNumber, standing.orderNumber),
      ));
      return {
        orderNumber: standing.orderNumber, replayed: true,
        netValue: saved ? Number(saved.netValue).toFixed(2) : '0.00',
        taxValue: saved ? Number(saved.taxValue).toFixed(2) : '0.00',
        grossValue: saved ? Number(saved.grossValue).toFixed(2) : '0.00',
      };
    }

    const [invoice] = await tx.select().from(billingDocument).where(and(
      eq(billingDocument.client, input.client), eq(billingDocument.billingNumber, input.billingNumber),
    )).limit(1);
    if (!invoice) {
      throw new ReturnsError(
        `Billing document ${input.billingNumber} does not stand for this tenant.`,
        'Raise the return against an invoice that exists.',
      );
    }
    if (invoice.status === 'CANCELLED') {
      throw new ReturnsError(
        `Billing document ${input.billingNumber} stands cancelled, and nothing is owed on it to return.`,
        'Raise the return against an invoice that stands.',
      );
    }
    if (invoice.cancellationOf || invoice.creditOf) {
      throw new ReturnsError(
        `Billing document ${input.billingNumber} is ${invoice.creditOf ? 'a credit memo' : 'a cancellation'}, and goods are returned against an invoice.`,
        'Name the invoice the goods were billed on; a credit has no goods behind it.',
      );
    }

    const invoiceLines = await tx.select().from(billingDocumentLine).where(and(
      eq(billingDocumentLine.client, input.client),
      eq(billingDocumentLine.billingNumber, input.billingNumber),
    ));
    const byNumber = new Map(invoiceLines.map((line) => [line.lineNumber, line]));

    const rows: Array<typeof salesOrderLine.$inferInsert> = [];
    let lineNumber = 10;
    for (const item of input.items) {
      const billed = byNumber.get(item.billingLineNumber);
      if (!billed) {
        throw new ReturnsError(
          `Billing document ${input.billingNumber} carries no line ${item.billingLineNumber}.`,
          'Name a line the invoice actually carries.',
        );
      }
      // The order line the invoice was raised from carries what a billing line does not: the unit the
      // goods were sold in, the plant they left from, and the profit centre that earned the revenue.
      const [sold] = await tx.select().from(salesOrderLine).where(and(
        eq(salesOrderLine.client, input.client),
        eq(salesOrderLine.orderNumber, billed.orderNumber),
        eq(salesOrderLine.lineNumber, billed.orderLineNumber),
      )).limit(1);
      if (!sold) {
        throw new ReturnsError(
          `Invoice line ${item.billingLineNumber} was raised from order item ${billed.orderLineNumber} of order ${billed.orderNumber}, which does not stand.`,
          'Raise the return against an invoice whose order still stands.',
        );
      }
      const already = await quantityReturnedAgainst(tx, input.client, input.billingNumber, item.billingLineNumber);
      const invoiced = Number(billed.billingQuantity);
      if (item.quantity > invoiced - already + 1e-9) {
        throw new ReturnsError(
          `Invoice line ${item.billingLineNumber} billed ${invoiced}, of which ${already} has already been asked back, so only ${invoiced - already} can come back.`,
          'Return no more than was invoiced; what was never billed cannot be credited.',
        );
      }

      const netAmount = round2((item.quantity * Number(billed.netPrice)) / billed.priceUnit);
      const taxAmount = round2((Number(netAmount) * Number(billed.taxRate)) / 100);
      let baseQuantity: number;
      try {
        const conversion = await toBaseQuantity(tx, input.client, {
          materialNumber: billed.materialNumber, quantity: item.quantity, entryUnit: sold.quantityUnit,
        });
        baseQuantity = conversion.baseQuantity;
      } catch (error) {
        if (error instanceof UnitConversionError) throw new ReturnsError(error.message, error.remedy);
        throw error;
      }

      rows.push({
        client: input.client, orderNumber: '', lineNumber,
        materialNumber: billed.materialNumber, plant: sold.plant,
        orderQuantity: String(item.quantity), quantityUnit: sold.quantityUnit,
        baseQuantity: String(baseQuantity),
        netPrice: billed.netPrice, priceUnit: billed.priceUnit, netAmount,
        taxCode: billed.taxCode, taxRate: billed.taxRate, taxAmount,
        profitCenter: sold.profitCenter,
        requestedDeliveryDate: null,
        // The price came from the invoice, so the condition record named is the one the invoice named.
        conditionNumber: billed.conditionNumber,
        referenceBillingNumber: billed.billingNumber, referenceBillingLineNumber: billed.lineNumber,
        status: 'OPEN', createdBy: input.changedBy,
      });
      lineNumber += 10;
    }

    const netValue = round2(rows.reduce((sum, row) => sum + Number(row.netAmount), 0));
    const taxValue = round2(rows.reduce((sum, row) => sum + Number(row.taxAmount), 0));
    const grossValue = round2(Number(netValue) + Number(taxValue));

    let number: string;
    try {
      const drawn = await allocateNumber(tx, {
        client: input.client, objectCode: type.numberRangeObject, companyCode: '*',
        subObject: type.numberRangeSubObject, fiscalYear: 0, allocatedBy: input.changedBy,
      });
      number = drawn.display;
    } catch {
      throw new ReturnsError(
        `No active internal ${type.numberRangeObject} number range stands for sub-object ${type.numberRangeSubObject} of sales document type ${type.documentType}, so no returns order number can be drawn.`,
        'Define or unblock the interval on the number ranges screen, then save again.',
      );
    }

    await tx.insert(salesOrder).values({
      client: input.client, orderNumber: number, documentType: type.documentType,
      referenceDocumentType: invoice.documentType, referenceDocumentNumber: invoice.billingNumber,
      salesOrg: invoice.salesOrg, distributionChannel: invoice.distributionChannel, division: invoice.division,
      customerNumber: invoice.customerNumber, companyCode: invoice.companyCode, currency: invoice.currency,
      orderDate: input.orderDate,
      headerText: input.headerText?.trim() || null,
      status: 'OPEN',
      netValue, taxValue, grossValue,
      requestKey: input.requestKey, createdBy: input.changedBy,
    });
    for (const row of rows) {
      await tx.insert(salesOrderLine).values({ ...row, orderNumber: number });
    }

    await recordChange(tx, {
      client: input.client, objectClass: 'sales_order', objectKey: number, changeType: 'CREATE',
      changedBy: input.changedBy, transactionCode: RETURNS_ORDER_TRANSACTION,
      after: {
        documentType: type.documentType, against: invoice.billingNumber,
        items: rows.length, netValue, taxValue, grossValue,
      },
    });

    return { orderNumber: number, replayed: false, netValue, taxValue, grossValue };
  });
}

/**
 * What the returns screen reads: the complaints that stand, and the documents the goods come back on.
 *
 * Both lists are deliberately narrow — a returns order is an order of type RE, a returns delivery is a
 * delivery of type LR, and neither is the general order or delivery list with a filter in the screen.
 * The screen shows a chain, and a chain is read from the documents that belong to it.
 *
 * Each row carries what the next act needs. A returns order names the invoice it was priced from and how
 * much of the request a returns delivery has already been given; a returns delivery names the outbound
 * delivery the goods went out on, because that is the delivery whose line counts what has come back, and
 * it names the material document the receipt posted.
 */
/** Quantities are read from sums, and a sum over nothing has no scale of its own: three decimals is what a quantity carries everywhere else in the chain. */
function fixed3(value: string | number | null | undefined): string {
  return Number(value ?? 0).toFixed(3);
}

export interface ReturnsOrderSummary {
  orderNumber: string;
  orderDate: string;
  customerNumber: string;
  /** The invoice the return was priced from; null only for a request raised before the reference was kept. */
  billingNumber: string | null;
  status: string;
  currency: string;
  grossValue: string;
  headerText: string | null;
  /** What the customer is sending back, over the lines of the request. */
  requestedQuantity: string;
  /** How much of that has already been handed to a returns delivery. */
  committedQuantity: string;
}

export async function listReturnsOrders(
  client: string,
  filter: { customerNumber?: string } = {},
): Promise<ReturnsOrderSummary[]> {
  return withTenant(client, async (tx) => {
    // What a returns order is, is configuration: the list reads the type this tenant named (9237).
    const { returnsOrderType, returnsDeliveryType } = await returnsChain(tx, client);
    const rows = await tx.execute(sql`
      select o.order_number, o.order_date, o.customer_number, o.currency, o.gross_value::text as gross_value,
             o.status, o.header_text, o.reference_document_number,
             coalesce(sum(l.order_quantity), 0)::text as requested,
             coalesce(sum((
               select coalesce(sum(dl.delivery_quantity), 0)
                 from delivery_line dl
                 join delivery d on d.client = dl.client and d.delivery_number = dl.delivery_number
                where dl.client = ${client} and dl.order_number = o.order_number
                  and dl.order_line_number = l.line_number
                  and d.document_type = ${returnsDeliveryType}
                  and d.status <> 'CANCELLED'
             )), 0)::text as committed
        from sales_order o
        left join sales_order_line l
               on l.client = o.client and l.order_number = o.order_number and l.status = 'OPEN'
       where o.client = ${client}
         and o.document_type = ${returnsOrderType}
         and (${filter.customerNumber ?? null}::varchar is null
              or o.customer_number = ${filter.customerNumber ?? null}::varchar)
       group by o.order_number, o.order_date, o.customer_number, o.currency, o.gross_value,
                o.status, o.header_text, o.reference_document_number
       order by o.order_number desc
       limit 100
    `) as unknown as Array<{
      order_number: string; order_date: string; customer_number: string; currency: string;
      gross_value: string; status: string; header_text: string | null; reference_document_number: string | null;
      requested: string; committed: string;
    }>;
    return rows.map((row) => ({
      orderNumber: row.order_number,
      orderDate: typeof row.order_date === 'string' ? row.order_date : String(row.order_date).slice(0, 10),
      customerNumber: row.customer_number,
      billingNumber: row.reference_document_number,
      status: row.status,
      currency: row.currency,
      grossValue: row.gross_value,
      headerText: row.header_text,
      requestedQuantity: fixed3(row.requested),
      committedQuantity: fixed3(row.committed),
    }));
  });
}

export interface ReturnsDeliverySummary {
  deliveryNumber: string;
  deliveryDate: string;
  /** The returns order the document was raised against, when it was raised against one. */
  orderNumber: string | null;
  /** The outbound delivery the goods went out on, which the receipt is answered against. */
  referenceDeliveryNumber: string | null;
  customerNumber: string;
  status: string;
  /** What is coming back on this document. */
  quantity: string;
  /** The 651 the receipt posted; null until the goods are received. */
  materialDocumentNumber: string | null;
}

export async function listReturnsDeliveries(
  client: string,
  filter: { orderNumber?: string } = {},
): Promise<ReturnsDeliverySummary[]> {
  return withTenant(client, async (tx) => {
    const { returnsDeliveryType } = await returnsChain(tx, client);
    const rows = await tx.execute(sql`
      select d.delivery_number, d.delivery_date, d.order_number, d.reference_delivery_number,
             d.customer_number, d.status, d.material_document_number,
             coalesce(sum(dl.delivery_quantity), 0)::text as quantity
        from delivery d
        left join delivery_line dl on dl.client = d.client and dl.delivery_number = d.delivery_number
       where d.client = ${client}
         and d.document_type = ${returnsDeliveryType}
         and (${filter.orderNumber ?? null}::varchar is null
              or d.order_number = ${filter.orderNumber ?? null}::varchar)
       group by d.delivery_number, d.delivery_date, d.order_number, d.reference_delivery_number,
                d.customer_number, d.status, d.material_document_number
       order by d.delivery_number desc
       limit 100
    `) as unknown as Array<{
      delivery_number: string; delivery_date: string; order_number: string | null;
      reference_delivery_number: string | null; customer_number: string; status: string;
      material_document_number: string | null; quantity: string;
    }>;
    return rows.map((row) => ({
      deliveryNumber: row.delivery_number,
      deliveryDate: typeof row.delivery_date === 'string' ? row.delivery_date : String(row.delivery_date).slice(0, 10),
      orderNumber: row.order_number,
      referenceDeliveryNumber: row.reference_delivery_number,
      customerNumber: row.customer_number,
      status: row.status,
      quantity: fixed3(row.quantity),
      materialDocumentNumber: row.material_document_number,
    }));
  });
}
