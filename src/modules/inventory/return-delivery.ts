/**
 * Return delivery to a vendor — SCR-145 / INV.RETURN.POST (MBRL).
 *
 * A return is not a cancellation. Cancelling a wrong receipt is the reversal workflow, which says
 * "that document never should have stood". A return says the document stood, the goods arrived,
 * and now some of them have gone back to the vendor: the receipt keeps its quantity and the
 * received position falls. The two are kept apart in the data — `return_of_*` never shares a line
 * with `reversal_of_*` — so nothing downstream has to guess which statement it is reading.
 *
 * The movement is configuration, not a constant. This module reads the `movement_type` row named
 * `RETURN_TO_VENDOR` and uses whatever it says: its direction must be ISSUE (a return that adds
 * stock is a receipt wearing a different label) and its reference category must be the purchase
 * order. A tenant that points that row at a different movement gets that movement; a row that does
 * not describe a return is refused by name rather than reinterpreted.
 *
 * Accounting mirrors the receipt. A receipt debits inventory and credits GR/IR; a return credits
 * inventory and debits GR/IR, reopening the clearing position that the later credit memo closes.
 * No vendor liability is touched and no credit memo is created — that is invoice verification's
 * own work, and pretending otherwise here would put a document in the books nobody authorized.
 *
 * The batch is the receipt line's batch. It is not typed and it is not changed. A typed
 * batch that is not that batch is refused. Serial numbers, split valuation, special stock,
 * and shipping integration stay refused by name.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { linkDocuments } from '../../platform/document';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import {
  accountDetermination, plant,
} from '../foundation/schema';
import {
  material, materialDocument, materialDocumentLine, materialPlant, materialValuation,
  movementType, stockQuantity,
} from './schema';
import { materialPeriodAllows } from './material-period-control';
import { resolveStorageLocation, StorageLocationError } from './storage-location';
import { postingValuationRefusal } from './valuation-class-definition';
import { getMaterialPeriodControlInTx } from './goods-issue';
import { assertInventoryCountOpen, lockStockScope, PhysicalInventoryError } from './physical-inventory';
import { BatchPostingError, resolvePostingBatch } from './batch-posting';
import {
  applyValuationDelta, lockRequestKey, mismatchedRequest, postingFingerprint, quantityToken,
  REQUEST_MISMATCH_REMEDY,
} from './balance-update';
import { recordOutputsForPostedDocument } from './material-document-output';
import { toBaseQuantity, UnitConversionError } from './unit-conversion';

export const RETURN_CAPABILITY = 'INV.RETURN.POST';
export const RETURN_ALIASES = ['MBRL'] as const;
export const RETURN_MOVEMENT_CODE = '122';
export const RETURN_REVERSAL_MOVEMENT_CODE = '123';

const MATERIAL_DOCUMENT_CLASS = 'material_document';
const JOURNAL_DOCUMENT_TYPE = 'WE';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number) => Math.round(n * 100) / 100;

export class ReturnDeliveryError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ReturnDeliveryError';
    this.remedy = remedy;
  }
}

/** The delivered movement catalogue, ensured per tenant. Configuration may replace it. */
export const DELIVERED_RETURN_MOVEMENTS = [
  {
    movementType: 'RETURN_TO_VENDOR', description: 'Return delivery to vendor',
    direction: 'ISSUE', referenceCategory: 'PURCHASE_ORDER',
    reversalMovementType: 'RETURN_TO_VENDOR_REV', accountAssignment: 'NONE',
  },
  {
    movementType: 'RETURN_TO_VENDOR_REV', description: 'Reversal of a return delivery',
    direction: 'REVERSAL', referenceCategory: 'MATERIAL_DOCUMENT',
    reversalMovementType: null, accountAssignment: 'NONE',
  },
] as const;

async function ensureMovements(tx: Tx, client: string, changedBy: string) {
  for (const m of DELIVERED_RETURN_MOVEMENTS) {
    await tx.insert(movementType).values({ client, ...m, createdBy: changedBy }).onConflictDoNothing();
  }
}

/**
 * The movement this tenant posts a return with — as configured, and only if it describes a return.
 */
export async function resolveReturnMovement(tx: Tx, client: string) {
  await ensureMovements(tx, client, 'SYSTEM');
  const [row] = await tx.select().from(movementType).where(and(
    eq(movementType.client, client),
    eq(movementType.movementType, 'RETURN_TO_VENDOR'),
  ));
  if (!row) {
    throw new ReturnDeliveryError(
      'This tenant configures no return-to-vendor movement (RETURN_TO_VENDOR).',
      `Maintain the movement type in the movement catalogue; ${RETURN_CAPABILITY} posts it.`,
    );
  }
  if (row.direction !== 'ISSUE') {
    throw new ReturnDeliveryError(
      `Movement ${row.movementType} is configured with direction ${row.direction}, and a return must take stock out.`,
      'Correct the direction in the movement catalogue; a return that adds stock is a receipt.',
    );
  }
  if (row.referenceCategory !== 'PURCHASE_ORDER') {
    throw new ReturnDeliveryError(
      `Movement ${row.movementType} is configured to reference ${row.referenceCategory}, and a return delivery references the purchase order.`,
      'Correct the reference category in the movement catalogue.',
    );
  }
  return row;
}

export interface ReturnableItem {
  lineNumber: number;
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  stockType: string;
  /** The receipt line's batch. Blank when that line has none. Not entered on the return. */
  batch: string;
  unit: string;
  originalQuantity: number;
  previouslyReturned: number;
  remaining: number;
  purchaseOrderNumber: string | null;
  purchaseOrderItem: number | null;
  itemText: string | null;
  eligible: boolean;
  refusal: string | null;
}

export interface ReturnableDocument {
  documentNumber: string;
  documentYear: number;
  postingDate: string;
  status: string;
  headerText: string | null;
  items: ReturnableItem[];
}

/**
 * The reference document and what may still be returned from it. Read-only: selection changes
 * nothing, which §6.1 requires of preparation.
 */
export async function getReturnableDocument(
  client: string,
  input: { documentNumber: string; documentYear?: number | null },
): Promise<ReturnableDocument | null> {
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, client),
      eq(materialDocument.materialDocumentNumber, input.documentNumber),
    ));
    if (!header) return null;
    if (input.documentYear != null && Number(input.documentYear) !== header.documentYear) {
      throw new ReturnDeliveryError(
        `Material document ${input.documentNumber} stands in fiscal year ${header.documentYear}, not ${input.documentYear}.`,
        'The number is unique per tenant; the fiscal year names the document rather than selecting among duplicates.',
      );
    }

    const lines = await tx.select().from(materialDocumentLine).where(and(
      eq(materialDocumentLine.client, client),
      eq(materialDocumentLine.materialDocumentNumber, input.documentNumber),
    )).orderBy(materialDocumentLine.lineNumber);

    const returned = await returnedAgainst(tx, client, input.documentNumber);

    const items: ReturnableItem[] = lines.map((line) => {
      const original = Number(line.baseQuantity);
      const already = returned.get(line.lineNumber) ?? 0;
      const remaining = round2(Math.max(0, original - already));
      let refusal: string | null = null;
      if (header.status === 'REVERSED') refusal = `Material document ${header.documentNumber} is reversed in full.`;
      else if (line.reversalOfDocument) refusal = `Line ${line.lineNumber} is itself a reversal; it cannot be returned.`;
      else if ((line.lineDirection) !== 'RECEIPT') refusal = `Line ${line.lineNumber} is an issue, not a receipt.`;
      else if (!line.purchaseOrderNumber) refusal = `Line ${line.lineNumber} carries no purchase order, and a return delivery references one.`;
      else if (remaining <= 1e-9) refusal = `Line ${line.lineNumber} has already been returned in full.`;
      return {
        lineNumber: line.lineNumber,
        materialNumber: line.materialNumber,
        plant: line.plant,
        storageLocation: line.storageLocation,
        stockType: line.stockType,
        batch: line.batchNumber ?? '',
        unit: line.baseUnit,
        originalQuantity: round2(original),
        previouslyReturned: round2(already),
        remaining,
        purchaseOrderNumber: line.purchaseOrderNumber,
        purchaseOrderItem: line.purchaseOrderItem,
        itemText: line.itemText,
        eligible: refusal === null,
        refusal,
      };
    });

    return {
      documentNumber: header.materialDocumentNumber,
      documentYear: header.documentYear,
      postingDate: header.postingDate,
      status: header.status,
      headerText: header.headerText,
      items,
    };
  });
}

/**
 * How much of each original line has already gone back.
 *
 * Two things count, and they pull in opposite directions:
 *
 *  - a return line against the original adds its quantity — the goods went back to the vendor;
 *  - a reversal of such a return subtracts it — the goods came back to us, and the receipt stands
 *    as it did before the return.
 *
 * The second is why this cannot simply read `return_of_*`: a reversal line records what it
 * reverses (`reversal_of_document`), not what its original returned against. So the returns are
 * found first, and then every line that reverses one of them is netted off.
 */
async function returnedAgainst(
  tx: Tx, client: string, documentNumber: string,
): Promise<Map<number, number>> {
  const returns = await tx.select({
    number: materialDocumentLine.materialDocumentNumber,
    line: materialDocumentLine.lineNumber,
    ofLine: materialDocumentLine.returnOfLine,
    qty: materialDocumentLine.baseQuantity,
  })
    .from(materialDocumentLine)
    .where(and(
      eq(materialDocumentLine.client, client),
      eq(materialDocumentLine.returnOfDocument, documentNumber),
    ));

  const returned = new Map<number, number>();
  const returnLineQty = new Map<string, number>();
  for (const row of returns) {
    if (row.ofLine == null) continue;
    returned.set(row.ofLine, (returned.get(row.ofLine) ?? 0) + Number(row.qty));
    returnLineQty.set(`${row.number}/${row.line}`, Number(row.qty));
  }
  if (returnLineQty.size === 0) return returned;

  const returnNumbers = [...new Set(returns.map((r) => r.number))];
  const reversals = await tx.select({
    number: materialDocumentLine.materialDocumentNumber,
    reversalOfDocument: materialDocumentLine.reversalOfDocument,
    reversalOfLine: materialDocumentLine.reversalOfLine,
    qty: materialDocumentLine.baseQuantity,
  })
    .from(materialDocumentLine)
    .where(and(
      eq(materialDocumentLine.client, client),
      inArray(materialDocumentLine.reversalOfDocument, returnNumbers),
    ));

  const lineOfReturn = new Map<string, number>();
  for (const row of returns) lineOfReturn.set(`${row.number}/${row.line}`, row.ofLine);

  for (const row of reversals) {
    if (!row.reversalOfDocument || row.reversalOfLine == null) continue;
    const originalLine = lineOfReturn.get(`${row.reversalOfDocument}/${row.reversalOfLine}`);
    if (originalLine == null) continue;
    returned.set(originalLine, (returned.get(originalLine) ?? 0) - Number(row.qty));
  }
  return returned;
}

export interface ReturnLineInput {
  /** The line on the reference document being returned. */
  originalLine: number;
  quantity: number;
  entryUnit?: string;
  storageLocation?: string;
  itemText?: string;
}

export interface PostReturnDeliveryInput {
  client: string;
  changedBy: string;
  documentNumber: string;
  documentYear?: number | null;
  postingDate: string;
  documentDate: string;
  headerText?: string;
  /** Vendor return authorization or return note. Stored with the header text when given. */
  externalReference?: string;
  lines: ReturnLineInput[];
  requestKey: string;
  /**
   * Optional confirmation of the receipt line's batch. A different batch is refused.
   * A blank value uses the batch already on that line.
   */
  batch?: string;
  serialNumbers?: string[];
  valuationType?: string;
  specialStock?: string;
  /** Refused by name: no logistics module exists. */
  createDelivery?: boolean;
}

export interface ReturnDocumentView {
  materialDocumentNumber: string;
  documentYear: number;
  documentDate: string;
  postingDate: string;
  headerText: string | null;
  status: string;
  movementType: string;
  journalDocumentNumber: string | null;
  reversalOf: string | null;
  /** The receipt this document returns against. */
  returnsAgainst: { documentNumber: string; documentYear: number } | null;
  lines: Array<{
    lineNumber: number; materialNumber: string; plant: string; storageLocation: string | null;
    stockType: string; batch: string; quantity: string; unit: string; value: string;
    purchaseOrderNumber: string | null; purchaseOrderItem: number | null;
    returnOfLine: number | null;
  }>;
}

function toView(
  header: typeof materialDocument.$inferSelect,
  lines: Array<typeof materialDocumentLine.$inferSelect>,
): ReturnDocumentView {
  const first = lines[0];
  return {
    materialDocumentNumber: header.materialDocumentNumber,
    documentYear: header.documentYear,
    documentDate: header.documentDate,
    postingDate: header.postingDate,
    headerText: header.headerText,
    status: header.status,
    movementType: first?.movementType ?? '',
    journalDocumentNumber: header.journalDocumentNumber,
    reversalOf: header.reversalOf,
    returnsAgainst: first?.returnOfDocument && first.returnOfDocumentYear != null
      ? { documentNumber: first.returnOfDocument, documentYear: first.returnOfDocumentYear }
      : null,
    lines: lines.map((line) => ({
      lineNumber: line.lineNumber,
      materialNumber: line.materialNumber,
      plant: line.plant,
      storageLocation: line.storageLocation,
      stockType: line.stockType,
      batch: line.batchNumber ?? '',
      quantity: line.baseQuantity,
      unit: line.baseUnit,
      value: line.value,
      purchaseOrderNumber: line.purchaseOrderNumber,
      purchaseOrderItem: line.purchaseOrderItem,
      returnOfLine: line.returnOfLine,
    })),
  };
}

async function existingByRequestKey(tx: Tx, client: string, requestKey: string) {
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client), eq(materialDocument.requestKey, requestKey),
  ));
  if (!header) return null;
  const lines = await tx.select().from(materialDocumentLine).where(and(
    eq(materialDocumentLine.client, client),
    eq(materialDocumentLine.materialDocumentNumber, header.materialDocumentNumber),
  )).orderBy(materialDocumentLine.lineNumber);
  return toView(header, lines);
}

export async function getReturnDocument(client: string, number: string): Promise<ReturnDocumentView | null> {
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, client), eq(materialDocument.materialDocumentNumber, number),
    ));
    if (!header) return null;
    const lines = await tx.select().from(materialDocumentLine).where(and(
      eq(materialDocumentLine.client, client),
      eq(materialDocumentLine.materialDocumentNumber, number),
    )).orderBy(materialDocumentLine.lineNumber);
    return toView(header, lines);
  });
}

async function resolveAccount(tx: Tx, client: string, chart: string, event: string, valuationClass: string) {
  const [row] = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, event),
    eq(accountDetermination.valuationClass, valuationClass),
  ));
  if (!row) {
    throw new ReturnDeliveryError(
      `Account determination for ${event} and valuation class ${valuationClass} does not stand in chart ${chart}.`,
      'Complete the account determination, then post the return.',
    );
  }
  return row.glAccount;
}

/**
 * Post the return. One transaction: the document, its lines, the stock move, the valuation move,
 * the journal and the lineage either all stand or none of them do.
 */
export async function postReturnDelivery(input: PostReturnDeliveryInput): Promise<ReturnDocumentView> {
  if (!ISO_DATE.test(input.postingDate) || Number.isNaN(Date.parse(input.postingDate))) {
    throw new ReturnDeliveryError(`The posting date ${input.postingDate || '(empty)'} is not a date.`, 'Enter the date as YYYY-MM-DD.');
  }
  if (!ISO_DATE.test(input.documentDate) || Number.isNaN(Date.parse(input.documentDate))) {
    throw new ReturnDeliveryError(`The document date ${input.documentDate || '(empty)'} is not a date.`, 'Enter the date as YYYY-MM-DD.');
  }
  if ((input.headerText ?? '').length > 25) {
    throw new ReturnDeliveryError('The header text is longer than 25 characters.', 'Shorten the header text.');
  }
  if (input.lines.length === 0) {
    throw new ReturnDeliveryError('No return quantities were entered.', 'Enter a quantity against at least one receipt item.');
  }
  const typedBatch = (input.batch ?? '').trim().toUpperCase();
  if ((input.serialNumbers ?? []).length > 0) {
    throw new ReturnDeliveryError(
      'A serial-managed return cannot be posted: this canon carries no serial-number master.',
      'Post the return without serial numbers, or record them in the item text.',
    );
  }
  if ((input.valuationType ?? '').trim()) {
    throw new ReturnDeliveryError(
      'A split-valuation return cannot be posted: this canon carries no valuation types.',
      'Post against the material valuation as it stands.',
    );
  }
  if ((input.specialStock ?? '').trim()) {
    throw new ReturnDeliveryError(
      'A special-stock return cannot be posted: this canon carries stock as a named stock type, not an ownership indicator.',
      'Return unrestricted or quality stock; special stock categories are not implemented.',
    );
  }
  if (input.createDelivery) {
    throw new ReturnDeliveryError(
      'An outbound delivery cannot be created: this canon has no logistics module.',
      'Post the return material document; shipping integration is not implemented and is refused rather than half-built.',
    );
  }

  const fingerprint = postingFingerprint([
    'RET', input.documentNumber.trim(), input.postingDate, input.documentDate, input.headerText ?? '',
    ...[...input.lines].map((line) => `${line.originalLine}:${quantityToken(line.quantity)}:${line.entryUnit ?? ''}:${line.storageLocation ?? ''}`).sort(),
  ]);
  return withTenant(input.client, async (tx) => {
    await lockRequestKey(tx, input.client, input.requestKey);
    const replay = await existingByRequestKey(tx, input.client, input.requestKey);
    if (replay) {
      const mismatch = await mismatchedRequest(tx, input.client, input.requestKey, fingerprint);
      if (mismatch) throw new ReturnDeliveryError(mismatch, REQUEST_MISMATCH_REMEDY);
      return replay;
    }

    await ensureMovements(tx, input.client, input.changedBy);
    const movement = await resolveReturnMovement(tx, input.client);

    const [reference] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.materialDocumentNumber, input.documentNumber),
    ));
    if (!reference) {
      throw new ReturnDeliveryError(
        `Material document ${input.documentNumber || '(empty)'} does not exist.`,
        'Check the document number and fiscal year.',
      );
    }
    if (input.documentYear != null && Number(input.documentYear) !== reference.documentYear) {
      throw new ReturnDeliveryError(
        `Material document ${input.documentNumber} stands in fiscal year ${reference.documentYear}, not ${input.documentYear}.`,
        'The number is unique per tenant; the fiscal year names the document rather than selecting among duplicates.',
      );
    }
    if (reference.status !== 'POSTED') {
      throw new ReturnDeliveryError(
        `Material document ${input.documentNumber} is ${reference.status.toLowerCase()} and cannot be returned against.`,
        'Return against a posted receipt that still stands.',
      );
    }

    // The returnable quantity is judged under a lock, then judged again below — never trusted
    // from the caller, and never read once.
    const lockKeys = [...new Set(input.lines.map((l) => `${input.client}/return/${input.documentNumber}/${l.originalLine}`))].sort();
    for (const key of lockKeys) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    }
    const returned = await returnedAgainst(tx, input.client, input.documentNumber);

    const originals = await tx.select().from(materialDocumentLine).where(and(
      eq(materialDocumentLine.client, input.client),
      eq(materialDocumentLine.materialDocumentNumber, input.documentNumber),
      inArray(materialDocumentLine.lineNumber, input.lines.map((l) => l.originalLine)),
    ));
    const byLine = new Map(originals.map((l) => [l.lineNumber, l]));
    await lockStockScope(
      tx, input.client,
      [...new Set(originals.map((line) => line.materialNumber).filter((m): m is string => Boolean(m)))].sort(),
      'EXCLUSIVE',
    );
    const claimedReturn = new Map<number, number>();
    const claimedStock = new Map<string, number>();

    const prepared: Array<{
      original: typeof materialDocumentLine.$inferSelect;
      quantity: number;
      entryQuantity: number;
      entryUnit: string;
      storageLocation: string;
      value: number;
      poValue: number;
      valuation: typeof materialValuation.$inferSelect;
      poNumber: string;
      poItem: number;
    }> = [];

    for (const line of input.lines) {
      const original = byLine.get(line.originalLine);
      if (!original) {
        throw new ReturnDeliveryError(
          `Line ${line.originalLine} does not stand on material document ${input.documentNumber}.`,
          'Choose a line from the reference document.',
        );
      }
      if (original.lineDirection !== 'RECEIPT') {
        throw new ReturnDeliveryError(
          `Line ${original.lineNumber} of ${input.documentNumber} is an issue, not a receipt, and cannot be returned.`,
          'Return against a receipt line.',
        );
      }
      if (original.reversalOfDocument) {
        throw new ReturnDeliveryError(
          `Line ${original.lineNumber} of ${input.documentNumber} is itself a reversal and cannot be returned.`,
          'Return against a receipt that stands.',
        );
      }
      if (!original.purchaseOrderNumber || original.purchaseOrderItem == null) {
        throw new ReturnDeliveryError(
          `Line ${original.lineNumber} of ${input.documentNumber} carries no purchase order, and a return delivery references one.`,
          'This round returns goods received against a purchase order.',
        );
      }
      const receiptBatch = (original.batchNumber ?? '').trim().toUpperCase();
      if (typedBatch && typedBatch !== receiptBatch) {
        throw new ReturnDeliveryError(
          receiptBatch
            ? `Line ${original.lineNumber} stands on batch ${receiptBatch}. A return does not change it. No stock was posted.`
            : `Line ${original.lineNumber} has no batch. A return does not assign one. No stock was posted.`,
          'Leave the batch empty. The return uses the batch on the receipt line.',
        );
      }
      let postingBatch = receiptBatch;
      if (receiptBatch) {
        try {
          postingBatch = await resolvePostingBatch(tx, {
            client: input.client,
            materialNumber: original.materialNumber,
            plant: original.plant,
            batch: receiptBatch,
            postingDate: input.postingDate,
          });
        } catch (caught) {
          if (caught instanceof BatchPostingError) throw new ReturnDeliveryError(caught.message, caught.remedy);
          throw caught;
        }
      }
      if (!(line.quantity > 0)) {
        throw new ReturnDeliveryError(`Line ${line.originalLine}: the return quantity must be positive.`, 'Enter a quantity greater than zero.');
      }

      const already = returned.get(original.lineNumber) ?? 0;
      const remaining = round2(Math.max(0, Number(original.baseQuantity) - already));

      const entryUnit = line.entryUnit ?? original.baseUnit;
      let quantity = line.quantity;
      if (entryUnit !== original.baseUnit) {
        try {
          const conversion = await toBaseQuantity(tx, input.client, {
            materialNumber: original.materialNumber, quantity: line.quantity, entryUnit,
          });
          quantity = conversion.baseQuantity;
        } catch (caught) {
          if (caught instanceof UnitConversionError) throw new ReturnDeliveryError(caught.message, caught.remedy);
          throw caught;
        }
      }
      const claimed = claimedReturn.get(original.lineNumber) ?? 0;
      if (quantity + claimed > remaining + 1e-9) {
        throw new ReturnDeliveryError(
          `Line ${original.lineNumber}: ${(quantity + claimed).toFixed(3)} was entered but only ${remaining.toFixed(3)} of the ${Number(original.baseQuantity).toFixed(3)} received may still be returned.`,
          already > 0
            ? `The difference is already out: ${already.toFixed(3)} has been returned. Reduce the quantity to what remains.`
            : 'Reduce the quantity to what was received.',
        );
      }
      claimedReturn.set(original.lineNumber, claimed + quantity);

      const [mat] = await tx.select().from(material).where(and(
        eq(material.client, input.client), eq(material.materialNumber, original.materialNumber),
      ));
      if (!mat) throw new ReturnDeliveryError(`Material ${original.materialNumber} does not exist.`);
      if (mat.markedForDeletion) {
        throw new ReturnDeliveryError(`Material ${original.materialNumber} is flagged for deletion.`, 'Cancel the deletion flag, then post again.');
      }
      const [ext] = await tx.select().from(materialPlant).where(and(
        eq(materialPlant.client, input.client),
        eq(materialPlant.materialNumber, original.materialNumber),
        eq(materialPlant.plant, original.plant),
      ));
      if (!ext) {
        throw new ReturnDeliveryError(`Material ${original.materialNumber} is not extended to plant ${original.plant}.`);
      }
      const [valuation] = await tx.select().from(materialValuation).where(and(
        eq(materialValuation.client, input.client),
        eq(materialValuation.materialNumber, original.materialNumber),
        eq(materialValuation.valuationArea, original.plant),
      ));
      if (!valuation || !valuation.valuationClass) {
        throw new ReturnDeliveryError(
          `Material ${original.materialNumber} carries no valuation class in plant ${original.plant}.`,
          'Complete the material valuation data, then post again.',
        );
      }
      const classRefusal = await postingValuationRefusal(tx, input.client, original.materialNumber, valuation.valuationClass);
      if (classRefusal) {
        throw new ReturnDeliveryError(classRefusal, 'Maintain a valuation class this material type permits, then post again.');
      }

      let returning;
      try {
        returning = await resolveStorageLocation(tx, {
          client: input.client,
          plant: original.plant,
          typed: line.storageLocation,
          documentDefault: original.storageLocation,
          applyPlantDefault: false,
          required: true,
          verb: 'Return from',
        });
      } catch (caught) {
        if (caught instanceof StorageLocationError) {
          throw new ReturnDeliveryError(
            caught.message.includes('is required')
              ? `Line ${original.lineNumber}: a storage location is required to return from.`
              : caught.message,
            caught.remedy,
          );
        }
        throw caught;
      }
      const storageLocationName = returning.storageLocation;
      const location = returning.row!;

      // SCR-142/143: the count block reaches this posting like every other stock writer.
      try {
        await assertInventoryCountOpen(tx, input.client, {
          materialNumber: original.materialNumber, plant: original.plant,
          storageLocation: storageLocationName,
          batch: postingBatch,
        });
      } catch (caught) {
        if (caught instanceof PhysicalInventoryError) throw new ReturnDeliveryError(caught.message, caught.remedy);
        throw caught;
      }

      // The exact dimension includes the receipt line's batch. A return does not choose another.
      const [held] = await tx.select().from(stockQuantity).where(and(
        eq(stockQuantity.client, input.client),
        eq(stockQuantity.materialNumber, original.materialNumber),
        eq(stockQuantity.plant, original.plant),
        eq(stockQuantity.storageLocation, storageLocationName),
        eq(stockQuantity.stockType, original.stockType),
        eq(stockQuantity.batchNumber, postingBatch),
      ));
      const onHand = held ? Number(held.quantity) : 0;
      const stockKey = `${original.materialNumber}|${original.plant}|${storageLocationName}|${original.stockType}|${postingBatch}`;
      const alreadyStock = claimedStock.get(stockKey) ?? 0;
      if (!location.allowNegativeStock && onHand + 1e-9 < quantity + alreadyStock) {
        throw new ReturnDeliveryError(
          `Stock of ${original.materialNumber} (${original.stockType})${postingBatch ? ` batch ${postingBatch}` : ''} in storage location ${storageLocationName} of plant ${original.plant} is ${onHand.toFixed(3)}, short of the ${(quantity + alreadyStock).toFixed(3)} to return.`,
          'Reduce the quantity to what stands, or release negative stock on that storage location.',
        );
      }
      claimedStock.set(stockKey, alreadyStock + quantity);

      const poValue = round2((quantity * Number(original.unitPrice)) / Number(original.priceUnit ?? '1'));
      const stockValue = valuation.priceControl === 'STANDARD'
        ? round2((quantity * Number(valuation.standardPrice)) / Number(valuation.priceUnit))
        : poValue;

      prepared.push({
        original, postingBatch, quantity, entryQuantity: line.quantity, entryUnit, storageLocation: storageLocationName,
        value: stockValue, poValue, valuation,
        poNumber: original.purchaseOrderNumber, poItem: original.purchaseOrderItem,
      });
    }

    // One reference document, one plant and company: the reference's own company code judges the
    // period, exactly as the receipt it returns against did.
    const [firstOriginal] = await tx.select().from(materialDocumentLine).where(and(
      eq(materialDocumentLine.client, input.client),
      eq(materialDocumentLine.materialDocumentNumber, input.documentNumber),
    )).limit(1);
    const [plantRow] = await tx.select().from(plant).where(and(
      eq(plant.client, input.client), eq(plant.plant, firstOriginal!.plant),
    ));
    if (!plantRow?.companyCode) {
      throw new ReturnDeliveryError(`Plant ${firstOriginal?.plant} carries no company code.`, 'Complete the plant, then post the return.');
    }
    const companyCodeRow = await getCompanyCode(tx, input.client, plantRow.companyCode);
    if (!companyCodeRow?.fiscalYearVariant) {
      throw new ReturnDeliveryError(`Company code ${plantRow.companyCode} is not configured.`);
    }
    const position = await derivePosition(tx, input.client, companyCodeRow.fiscalYearVariant, input.postingDate);
    const mmRecord = await getMaterialPeriodControlInTx(tx, input.client, plantRow.companyCode);
    if (!materialPeriodAllows(mmRecord, position.fiscalYear, position.period)) {
      throw new ReturnDeliveryError(
        `The material posting period ${position.fiscalYear}/${position.period} is closed for company ${plantRow.companyCode}.`,
        'Post into the open material period, or shift the material period first.',
      );
    }

    const chart = companyCodeRow.chartOfAccounts as string;
    const grIrAccount = await resolveAccount(tx, input.client, chart, 'GR_IR_CLEARING', '');
    const journalLines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; amount: string; material?: string; plant?: string }> = [];
    for (const p of prepared) {
      const inventoryAccount = await resolveAccount(tx, input.client, chart, 'INVENTORY', p.valuation.valuationClass!);
      // The mirror of the receipt: stock leaves, so inventory is credited and GR/IR reopened.
      journalLines.push({ glAccount: inventoryAccount, debitCredit: 'H', amount: p.value.toFixed(2), material: p.original.materialNumber, plant: p.original.plant });
      journalLines.push({ glAccount: grIrAccount, debitCredit: 'S', amount: p.poValue.toFixed(2), material: p.original.materialNumber, plant: p.original.plant });
      const difference = round2(p.poValue - p.value);
      if (difference !== 0) {
        const prdAccount = await resolveAccount(tx, input.client, chart, 'PRICE_DIFFERENCE', p.valuation.valuationClass!);
        journalLines.push({
          glAccount: prdAccount, debitCredit: difference > 0 ? 'H' : 'S',
          amount: Math.abs(difference).toFixed(2), material: p.original.materialNumber, plant: p.original.plant,
        });
      }
    }

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'MATDOC', allocatedBy: input.changedBy,
    });
    const number = allocated.display;

    const headerText = input.externalReference
      ? `${input.headerText ? `${input.headerText} ` : ''}${input.externalReference}`.slice(0, 25)
      : input.headerText;

    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: plantRow.companyCode,
      documentType: JOURNAL_DOCUMENT_TYPE,
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: prepared[0].valuation.currency as string,
      localCurrency: companyCodeRow.currency,
      reference: input.documentNumber,
      headerText,
      lines: journalLines,
      origin: { documentClass: MATERIAL_DOCUMENT_CLASS, documentKey: number },
      postedBy: input.changedBy,
      transactionCode: RETURN_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new ReturnDeliveryError(error.message, error.remedy);
      throw error;
    });

    await tx.insert(materialDocument).values({
      client: input.client, materialDocumentNumber: number, documentYear: position.fiscalYear,
      documentDate: input.documentDate, postingDate: input.postingDate,
      headerText: headerText ?? null, status: 'POSTED',
      journalDocumentNumber: journal.documentNumber, requestKey: input.requestKey,
      requestFingerprint: fingerprint,
      createdBy: input.changedBy,
    });

    let lineNumber = 0;
    for (const p of prepared) {
      lineNumber += 1;
      await tx.insert(materialDocumentLine).values({
        client: input.client, materialDocumentNumber: number, lineNumber,
        movementType: movement.movementType, lineDirection: 'ISSUE',
        materialNumber: p.original.materialNumber, plant: p.original.plant,
        storageLocation: p.storageLocation, stockType: p.original.stockType,
        batchNumber: p.postingBatch,
        entryQuantity: String(p.entryQuantity), entryUnit: p.entryUnit,
        baseQuantity: String(p.quantity), baseUnit: p.original.baseUnit,
        unitPrice: p.original.unitPrice, priceUnit: p.original.priceUnit, currency: p.valuation.currency,
        value: String(p.value),
        purchaseOrderNumber: p.poNumber, purchaseOrderItem: p.poItem,
        returnOfDocument: input.documentNumber, returnOfDocumentYear: reference.documentYear,
        returnOfLine: p.original.lineNumber,
        itemText: p.original.lineNumber ? `Return of ${input.documentNumber}/${p.original.lineNumber}` : null,
        createdBy: input.changedBy,
      });
      await tx.update(stockQuantity).set({
        quantity: sql`${stockQuantity.quantity} - ${p.quantity}`,
        changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(stockQuantity.client, input.client),
        eq(stockQuantity.materialNumber, p.original.materialNumber),
        eq(stockQuantity.plant, p.original.plant),
        eq(stockQuantity.storageLocation, p.storageLocation),
        eq(stockQuantity.stockType, p.original.stockType),
        eq(stockQuantity.batchNumber, p.postingBatch),
      ));
      await applyValuationDelta(
        tx, input.client, input.changedBy, p.original.materialNumber, p.original.plant, -p.quantity, -p.value,
      );
    }

    await linkDocuments(tx, {
      client: input.client,
      predecessor: { documentClass: MATERIAL_DOCUMENT_CLASS, documentKey: input.documentNumber },
      successor: { documentClass: MATERIAL_DOCUMENT_CLASS, documentKey: number },
      relationType: 'GOODS_RETURN',
      createdBy: input.changedBy,
    });
    await linkDocuments(tx, {
      client: input.client,
      predecessor: { documentClass: 'purchase_order', documentKey: prepared[0].poNumber },
      successor: { documentClass: MATERIAL_DOCUMENT_CLASS, documentKey: number },
      relationType: 'GOODS_RETURN',
      createdBy: input.changedBy,
    });

    await recordChange(tx, {
      client: input.client,
      objectClass: MATERIAL_DOCUMENT_CLASS,
      objectKey: number,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: RETURN_CAPABILITY,
      after: {
        movement: movement.movementType, returnsAgainst: input.documentNumber,
        order: prepared[0].poNumber, lines: prepared.length,
        journal: journal.documentNumber, status: 'POSTED',
      },
    });

    await recordOutputsForPostedDocument(tx, input.client, number, input.changedBy);

    return (await existingByRequestKey(tx, input.client, input.requestKey))!;
  });
}
