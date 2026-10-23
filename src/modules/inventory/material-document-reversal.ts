/**
 * Material document reversal — SCR-132 / MBST.
 *
 * Every movement this canon posts can be undone the same way: a second material
 * document whose lines mirror the first with their sides inverted — an issue
 * line returns its stock, a receipt line takes it away again — under the counter
 * movement type the original movement names. The cancellation flag is the
 * document's own status: POSTED while nothing is reversed, PARTIALLY_REVERSED
 * while some lines stand open, REVERSED when none does.
 *
 * A document may be reversed in whole or by line, but never by part of a line.
 * Downstream orders need no write-back: delivered quantities are derived from
 * the document lines, and a reversal line signed by a REVERSAL movement
 * subtracts itself from the open quantity the moment it exists.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { PostingError, reverseJournalEntry } from '../../platform/posting';
import { plant as plantTable, storageLocation } from '../foundation/schema';
import { assertInventoryCountOpen, lockStockScope, PhysicalInventoryError } from './physical-inventory';
import {
  applyValuationDelta, lockRequestKey, mismatchedRequest, postingFingerprint, REQUEST_MISMATCH_REMEDY,
} from './balance-update';
import { materialPeriodAllows } from './material-period-control';
import { recordOutputsForPostedDocument } from './material-document-output';
import { batchClassificationRefusal } from './batch-classification';
import { releaseDifferenceAllocations } from './physical-inventory-posting-status';
import {
  materialDocument, materialDocumentLine, materialValuation, movementType, stockQuantity,
} from './schema';

export const REVERSE_CAPABILITY = 'INV.REVERSE';
const MATERIAL_DOCUMENT_CLASS = 'material_document';

export class MaterialReversalError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'MaterialReversalError';
    this.remedy = remedy;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReversalLineView {
  lineNumber: number;
  lineDirection: string;
  movementType: string;
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  stockType: string;
  /** The batch stored on the line. Blank when the line carries none. Not typed on this screen. */
  batch: string;
  quantity: string;
  unit: string;
  value: string;
  reversedQuantity: string;
  remainingQuantity: string;
  /** The movement type the reversal of this line posts, or null where the movement names none. */
  counterMovementType: string | null;
}

export interface ReversalDocumentView {
  materialDocumentNumber: string;
  documentYear: number;
  documentDate: string;
  postingDate: string;
  headerText: string | null;
  status: string;
  journalDocumentNumber: string | null;
  reversalOf: string | null;
  reversedBy: string | null;
  lines: ReversalLineView[];
}

interface ReversedMap {
  [lineNumber: number]: number;
}

/**
 * How much of each line has already been reversed — read from the reversal
 * lines themselves, never from the header flag. The header flag is set from
 * this same arithmetic when a reversal posts.
 */
async function reversedQuantities(
  tx: Tx, client: string, documentNumber: string,
): Promise<ReversedMap> {
  const rows = await tx.execute(sql`
    select reversal_of_line, sum(base_quantity) as reversed_quantity
    from material_document_line
    where client = ${client} and reversal_of_document = ${documentNumber}
      and reversal_of_line is not null
    group by reversal_of_line
  `) as unknown as Array<{ reversal_of_line: number; reversed_quantity: string }>;
  const map: ReversedMap = {};
  for (const row of rows) map[Number(row.reversal_of_line)] = Number(row.reversed_quantity);
  return map;
}

async function counterMovements(tx: Tx, client: string): Promise<Map<string, string | null>> {
  const rows = await tx.select().from(movementType).where(eq(movementType.client, client));
  const map = new Map<string, string | null>();
  for (const row of rows) map.set(row.movementType, row.reversalMovementType ?? null);
  return map;
}

async function toView(
  tx: Tx, client: string, header: typeof materialDocument.$inferSelect,
): Promise<ReversalDocumentView> {
  const lines = await tx.select().from(materialDocumentLine).where(and(
    eq(materialDocumentLine.client, client),
    eq(materialDocumentLine.materialDocumentNumber, header.materialDocumentNumber),
  )).orderBy(materialDocumentLine.lineNumber);
  const reversed = await reversedQuantities(tx, client, header.materialDocumentNumber);
  const counters = await counterMovements(tx, client);
  return {
    materialDocumentNumber: header.materialDocumentNumber,
    documentYear: header.documentYear,
    documentDate: header.documentDate,
    postingDate: header.postingDate,
    headerText: header.headerText,
    status: header.status,
    journalDocumentNumber: header.journalDocumentNumber,
    reversalOf: header.reversalOf,
    reversedBy: header.reversedBy,
    lines: lines.map((l) => {
      const done = reversed[l.lineNumber] ?? 0;
      return {
        lineNumber: l.lineNumber,
        lineDirection: l.lineDirection,
        movementType: l.movementType,
        materialNumber: l.materialNumber,
        plant: l.plant,
        storageLocation: l.storageLocation,
        stockType: l.stockType,
        batch: l.batchNumber,
        quantity: l.baseQuantity,
        unit: l.baseUnit,
        value: l.value,
        reversedQuantity: done.toFixed(3),
        remainingQuantity: Math.max(0, Number(l.baseQuantity) - done).toFixed(3),
        counterMovementType: counters.get(l.movementType) ?? null,
      };
    }),
  };
}

export async function getReversalDocument(client: string, number: string): Promise<ReversalDocumentView | null> {
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, client), eq(materialDocument.materialDocumentNumber, number),
    ));
    if (!header) return null;
    return toView(tx, client, header);
  });
}

export interface PostReversalInput {
  client: string;
  changedBy: string;
  materialDocumentNumber: string;
  fiscalYear?: number;
  /** The lines to reverse; omitted means every line that still stands open. */
  lines?: number[];
  postingDate: string;
  documentDate: string;
  headerText?: string;
  /** The package's reversal reason code; no master stands in this canon, so it is refused by name. */
  reason?: string;
  requestKey: string;
}

async function existingByRequestKey(tx: Tx, client: string, requestKey: string) {
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client), eq(materialDocument.requestKey, requestKey),
  ));
  if (!header) return null;
  return toView(tx, client, header);
}

async function judgePeriods(tx: Tx, client: string, plants: string[], postingDate: string) {
  const seen = new Set<string>();
  let position: { fiscalYear: number; period: number } | null = null;
  let company: NonNullable<Awaited<ReturnType<typeof getCompanyCode>>> | null = null;
  for (const plant of plants) {
    const [row] = await tx.select().from(plantTable).where(and(
      eq(plantTable.client, client), eq(plantTable.plant, plant),
    ));
    if (!row?.companyCode) {
      throw new MaterialReversalError(
        `Plant ${plant} does not exist or carries no company code.`,
        'Complete the plant, then reverse the document.',
      );
    }
    if (seen.has(row.companyCode)) continue;
    seen.add(row.companyCode);
    const configured = await getCompanyCode(tx, client, row.companyCode);
    if (!configured?.fiscalYearVariant) {
      throw new MaterialReversalError(`Company code ${row.companyCode} is not configured.`);
    }
    const derived = await derivePosition(tx, client, configured.fiscalYearVariant, postingDate);
    const rows = await tx.execute(sql`
      select current_fiscal_year, current_period, previous_fiscal_year, previous_period,
             allow_backposting, disallow_backposting_after_change
      from material_period_control where client = ${client} and company_code = ${row.companyCode}
    `) as unknown as Array<{
      current_fiscal_year: number; current_period: number; previous_fiscal_year: number;
      previous_period: number; allow_backposting: boolean; disallow_backposting_after_change: boolean;
    }>;
    const record = rows[0]
      ? {
          companyCode: row.companyCode,
          currentFiscalYear: Number(rows[0].current_fiscal_year),
          currentPeriod: Number(rows[0].current_period),
          previousFiscalYear: Number(rows[0].previous_fiscal_year),
          previousPeriod: Number(rows[0].previous_period),
          allowBackposting: Boolean(rows[0].allow_backposting),
          disallowBackpostingAfterChange: Boolean(rows[0].disallow_backposting_after_change),
        }
      : null;
    if (!materialPeriodAllows(record, derived.fiscalYear, derived.period)) {
      throw new MaterialReversalError(
        `The material posting period ${derived.fiscalYear}/${derived.period} is closed for company ${row.companyCode}.`,
        'Post the reversal into an open material period.',
      );
    }
    position = derived;
    company = configured;
  }
  if (!position || !company) {
    throw new MaterialReversalError('The document carries no plant to judge the period on.');
  }
  return { position, company };
}

async function stockAt(
  tx: Tx, client: string, line: { materialNumber: string; plant: string; storageLocation: string | null; stockType: string; batchNumber?: string | null },
): Promise<number> {
  const [row] = await tx.select().from(stockQuantity).where(and(
    eq(stockQuantity.client, client),
    eq(stockQuantity.materialNumber, line.materialNumber),
    eq(stockQuantity.plant, line.plant),
    eq(stockQuantity.storageLocation, line.storageLocation ?? ''),
    eq(stockQuantity.stockType, line.stockType),
    eq(stockQuantity.batchNumber, line.batchNumber ?? ''),
  )).for('update');
  return row ? Number(row.quantity) : 0;
}

async function moveStock(
  tx: Tx, client: string, changedBy: string,
  line: { materialNumber: string; plant: string; storageLocation: string | null; stockType: string; batchNumber?: string | null },
  delta: number,
) {
  const location = line.storageLocation ?? '';
  const [existing] = await tx.select().from(stockQuantity).where(and(
    eq(stockQuantity.client, client),
    eq(stockQuantity.materialNumber, line.materialNumber),
    eq(stockQuantity.plant, line.plant),
    eq(stockQuantity.storageLocation, location),
    eq(stockQuantity.stockType, line.stockType),
    eq(stockQuantity.batchNumber, line.batchNumber ?? ''),
  ));
  if (!existing) {
    await tx.insert(stockQuantity).values({
      client, materialNumber: line.materialNumber, plant: line.plant,
      storageLocation: location, stockType: line.stockType,
      batchNumber: line.batchNumber ?? '',
      quantity: String(delta), createdBy: changedBy,
    });
    return;
  }
  await tx.update(stockQuantity).set({
    quantity: sql`${stockQuantity.quantity} + ${delta}`,
    changedBy, changedAt: new Date(),
  }).where(and(
    eq(stockQuantity.client, client),
    eq(stockQuantity.materialNumber, line.materialNumber),
    eq(stockQuantity.plant, line.plant),
    eq(stockQuantity.storageLocation, location),
    eq(stockQuantity.stockType, line.stockType),
    eq(stockQuantity.batchNumber, line.batchNumber ?? ''),
  ));
}

async function moveValuation(
  tx: Tx, client: string, changedBy: string, materialNumber: string, plant: string,
  quantityDelta: number, valueDelta: number,
) {
  await applyValuationDelta(tx, client, changedBy, materialNumber, plant, quantityDelta, valueDelta);
}

function splitJournalKey(key: string): [number, string] {
  const parts = key.split('/');
  return [Number(parts[1]), parts.slice(2).join('/')];
}

export async function reverseMaterialDocument(input: PostReversalInput): Promise<ReversalDocumentView> {
  if (!ISO_DATE.test(input.postingDate) || Number.isNaN(Date.parse(input.postingDate))) {
    throw new MaterialReversalError(
      `The posting date ${input.postingDate || '(empty)'} is not a date.`,
      'Enter the date as YYYY-MM-DD.',
    );
  }
  if (!ISO_DATE.test(input.documentDate) || Number.isNaN(Date.parse(input.documentDate))) {
    throw new MaterialReversalError(
      `The document date ${input.documentDate || '(empty)'} is not a date.`,
      'Enter the date as YYYY-MM-DD.',
    );
  }
  if ((input.headerText ?? '').length > 25) {
    throw new MaterialReversalError('The header text is longer than 25 characters.', 'Shorten the header text.');
  }
  if (input.reason) {
    throw new MaterialReversalError(
      `Reversal reason ${input.reason} cannot be recorded: this canon carries no reversal-reason table.`,
      'Leave the reason empty and write it in the header text.',
    );
  }

  const fingerprint = postingFingerprint([
    'REV', input.materialDocumentNumber.trim(), input.fiscalYear ?? '',
    input.postingDate, input.documentDate, input.headerText ?? '',
    ...(input.lines ?? []).map(String).sort(),
  ]);
  return withTenant(input.client, async (tx) => {
    await lockRequestKey(tx, input.client, input.requestKey);
    const replay = await existingByRequestKey(tx, input.client, input.requestKey);
    if (replay) {
      const mismatch = await mismatchedRequest(tx, input.client, input.requestKey, fingerprint);
      if (mismatch) throw new MaterialReversalError(mismatch, REQUEST_MISMATCH_REMEDY);
      return replay;
    }

    const [original] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.materialDocumentNumber, input.materialDocumentNumber),
    ));
    if (!original) {
      throw new MaterialReversalError(
        `Material document ${input.materialDocumentNumber || '(empty)'} does not exist.`,
        'Check the document number and fiscal year.',
      );
    }
    if (original.reversalOf) {
      throw new MaterialReversalError(
        `Material document ${input.materialDocumentNumber} is itself a reversal of ${original.reversalOf}.`,
        'Reverse the original document, never its reversal.',
      );
    }
    if (input.fiscalYear != null && Number(input.fiscalYear) !== original.documentYear) {
      throw new MaterialReversalError(
        `Material document ${input.materialDocumentNumber} stands in fiscal year ${original.documentYear}, not ${input.fiscalYear}.`,
        'The number is unique per tenant, so the fiscal year names the document rather than selecting among duplicates.',
      );
    }
    if (original.status === 'REVERSED') {
      throw new MaterialReversalError(
        `Material document ${input.materialDocumentNumber} has already been cancelled by ${original.reversedBy}.`,
        'A document is reversed once; post a fresh movement instead.',
      );
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/reverse/${input.materialDocumentNumber}`}, 0))`);
    const [locked] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.materialDocumentNumber, input.materialDocumentNumber),
    ));
    if (locked?.status === 'REVERSED' && !(input.lines && input.lines.length > 0)) {
      throw new MaterialReversalError(
        `Material document ${input.materialDocumentNumber} has already been cancelled by ${locked.reversedBy}.`,
        'A document is reversed once; post a fresh movement instead.',
      );
    }

    const lines = await tx.select().from(materialDocumentLine).where(and(
      eq(materialDocumentLine.client, input.client),
      eq(materialDocumentLine.materialDocumentNumber, input.materialDocumentNumber),
    )).orderBy(materialDocumentLine.lineNumber);
    if (lines.length === 0) throw new MaterialReversalError('The document carries no lines.');
    await lockStockScope(
      tx, input.client,
      [...new Set(lines.map((line) => line.materialNumber).filter((m): m is string => Boolean(m)))].sort(),
      'EXCLUSIVE',
    );
    const reversed = await reversedQuantities(tx, input.client, input.materialDocumentNumber);
    const counters = await counterMovements(tx, input.client);

    const wanted = input.lines && input.lines.length > 0
      ? lines.filter((l) => input.lines!.includes(l.lineNumber))
      : lines.filter((l) => Number(l.baseQuantity) - (reversed[l.lineNumber] ?? 0) > 1e-9);
    if (wanted.length === 0) {
      throw new MaterialReversalError(
        `Material document ${input.materialDocumentNumber} has already been cancelled` +
          (input.lines?.length ? ' on the selected lines.' : '.'),
        'A document line is reversed once; choose a line that still stands open.',
      );
    }
    // SCR-143: the reversal moves stock like any other posting, so it answers to the count
    // block. This is the path that let a blocked material move before this round.
    for (const line of wanted) {
      try {
        await assertInventoryCountOpen(tx, input.client, {
          materialNumber: line.materialNumber, plant: line.plant,
          storageLocation: line.storageLocation ?? null,
          batch: line.batchNumber,
        });
      } catch (caught) {
        if (caught instanceof PhysicalInventoryError) {
          throw new MaterialReversalError(caught.message, caught.remedy);
        }
        throw caught;
      }
    }

    for (const line of wanted) {
      if (Number(line.baseQuantity) - (reversed[line.lineNumber] ?? 0) <= 1e-9) {
        throw new MaterialReversalError(
          `Line ${line.lineNumber} of material document ${input.materialDocumentNumber} is already reversed in full.`,
          'Choose a line that still stands open.',
        );
      }
      if (!counters.get(line.movementType)) {
        throw new MaterialReversalError(
          `Movement type ${line.movementType} names no counter movement type.`,
          'Complete the movement catalogue, then reverse the document.',
        );
      }
      const refused = await batchClassificationRefusal(tx, input.client, counters.get(line.movementType)!);
      if (refused) throw new MaterialReversalError(refused.message, refused.remedy);
    }

    const { position, company } = await judgePeriods(
      tx, input.client, [...new Set(wanted.map((l) => l.plant))], input.postingDate,
    );

    // A reversal takes stock back, so its issue side is judged for sufficiency first.
    // The claim is the batch the line stored. Two batches of one material are not one pile.
    const claimedStock = new Map<string, number>();
    for (const line of wanted) {
      if (line.lineDirection !== 'RECEIPT') continue;
      const [location] = await tx.select().from(storageLocation).where(and(
        eq(storageLocation.client, input.client),
        eq(storageLocation.plant, line.plant),
        eq(storageLocation.storageLocation, line.storageLocation ?? ''),
      ));
      const held = await stockAt(tx, input.client, line);
      const batch = line.batchNumber ?? '';
      const stockKey = `${line.materialNumber}|${line.plant}|${line.storageLocation ?? ''}|${line.stockType}|${batch}`;
      const already = claimedStock.get(stockKey) ?? 0;
      const taking = Number(line.baseQuantity) + already;
      if (held + 1e-9 < taking && !location?.allowNegativeStock) {
        throw new MaterialReversalError(
          `Stock of ${line.materialNumber}${batch ? ` batch ${batch}` : ''} in plant ${line.plant} storage location ${line.storageLocation ?? ''} is ${held.toFixed(3)}, short of the ${taking.toFixed(3)} the reversal takes back.`,
          'The received stock has been consumed; the receipt can no longer be reversed in full.',
        );
      }
      claimedStock.set(stockKey, taking);
    }

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'MATDOC', allocatedBy: input.changedBy,
    });
    const number = allocated.display;

    let journalNumber: string | null = null;
    if (original.journalDocumentNumber) {
      const [journalYear] = splitJournalKey(original.journalDocumentNumber);
      const reversedJournal = await reverseJournalEntry(tx, {
        client: input.client,
        documentNumber: original.journalDocumentNumber,
        fiscalYear: journalYear,
        reversalDate: input.postingDate,
        reason: `Reversal of material document ${input.materialDocumentNumber}`,
        reversedBy: input.changedBy,
        transactionCode: REVERSE_CAPABILITY,
      }).catch((error: unknown) => {
        if (error instanceof PostingError) throw new MaterialReversalError(error.message, error.remedy);
        throw error;
      });
      journalNumber = reversedJournal.documentNumber;
    }

    await tx.insert(materialDocument).values({
      client: input.client,
      materialDocumentNumber: number,
      documentYear: position.fiscalYear,
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      headerText: input.headerText ?? `Reversal of ${input.materialDocumentNumber}`,
      status: 'POSTED',
      journalDocumentNumber: journalNumber,
      reversalOf: input.materialDocumentNumber,
      requestKey: input.requestKey,
      requestFingerprint: fingerprint,
      createdBy: input.changedBy,
    });

    let lineNumber = 0;
    for (const line of wanted) {
      lineNumber += 1;
      const direction = line.lineDirection === 'ISSUE' ? 'RECEIPT' : 'ISSUE';
      const stockDelta = direction === 'RECEIPT' ? Number(line.baseQuantity) : -Number(line.baseQuantity);
      const valueDelta = direction === 'RECEIPT' ? Number(line.value) : -Number(line.value);
      await tx.insert(materialDocumentLine).values({
        client: input.client,
        materialDocumentNumber: number,
        lineNumber,
        movementType: counters.get(line.movementType)!,
        lineDirection: direction,
        materialNumber: line.materialNumber,
        plant: line.plant,
        storageLocation: line.storageLocation,
        stockType: line.stockType,
        batchNumber: line.batchNumber,
        entryQuantity: line.entryQuantity,
        entryUnit: line.entryUnit,
        baseQuantity: line.baseQuantity,
        baseUnit: line.baseUnit,
        unitPrice: line.unitPrice,
        priceUnit: line.priceUnit,
        currency: line.currency,
        value: line.value,
        purchaseOrderNumber: line.purchaseOrderNumber,
        purchaseOrderItem: line.purchaseOrderItem,
        reversalOfDocument: input.materialDocumentNumber,
        reversalOfLine: line.lineNumber,
        itemText: `Reversal of ${input.materialDocumentNumber}`,
        createdBy: input.changedBy,
      });
      await moveStock(tx, input.client, input.changedBy, line, stockDelta);
      await moveValuation(tx, input.client, input.changedBy, line.materialNumber, line.plant, stockDelta, valueDelta);
    }

    // The header flag follows the arithmetic: every line reversed or some left open.
    const nowReversed = await reversedQuantities(tx, input.client, input.materialDocumentNumber);
    const allDone = lines.every((l) => Number(l.baseQuantity) - (nowReversed[l.lineNumber] ?? 0) <= 1e-9);
    await tx.update(materialDocument).set({
      status: allDone ? 'REVERSED' : 'PARTIALLY_REVERSED',
      reversedBy: allDone ? number : original.reversedBy ?? number,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.materialDocumentNumber, input.materialDocumentNumber),
    ));

    await releaseDifferenceAllocations(tx, input.client, input.changedBy, {
      reversalDocument: number,
      lines: wanted.map((line, index) => ({
        originalDocument: input.materialDocumentNumber,
        originalLine: line.lineNumber,
        reversalLine: index + 1,
      })),
    });

    await recordChange(tx, {
      client: input.client,
      objectClass: MATERIAL_DOCUMENT_CLASS,
      objectKey: number,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: REVERSE_CAPABILITY,
      after: {
        reversalOf: input.materialDocumentNumber,
        lines: wanted.map((l) => l.lineNumber),
        status: allDone ? 'REVERSED' : 'PARTIALLY_REVERSED',
        journal: journalNumber,
        company: company?.companyCode ?? null,
        reversedLines: wanted.length,
      },
    });

    // SCR-135: the cancellation is a document of its own and carries its own slip.
    await recordOutputsForPostedDocument(tx, input.client, number, input.changedBy);

    return (await existingByRequestKey(tx, input.client, input.requestKey))!;
  });
}
