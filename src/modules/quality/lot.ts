/**
 * The inspection lot: opened against a posted receipt line, and read back with the goods it names.
 *
 * Three rules govern this file, and they are the difference between a record and a second ledger.
 *
 * **A lot names a line; it does not copy one.** The material, plant, storage location, batch, movement,
 * quantity, unit and stock segment are read from `material_document_line` on every call, because that row is
 * where the posting put them and a copy starts lying the moment the receipt is reversed. The lot's own
 * standing is derived the same way: it is open while the line it points at still stands.
 *
 * **Opening a lot changes nothing about the goods.** No stock row is written, no valuation or journal
 * document is raised, and the batch's restricted-use indicator is untouched — that is D3 of the 2026-10-28
 * readiness record, and it is why `openLot` needs no posting capability, no period check and no place in the
 * inventory engines. Whether the goods may move is decided by the segment and the batch indicator the receipt
 * left behind, which `goods-issue.ts` and `resolvePostingBatch` already enforce. A lot adds the request for an
 * inspection, so that there is something for a decision to be made on later.
 *
 * **One line is inspected once.** A second lot against the same receipt line is refused and the standing lot
 * is named, and a submission that repeats its request key gets back the lot the first attempt created
 * instead of a second one. The decision path, when it arrives (slice 2), is an act on the existing lot.
 */
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { materialDocument, materialDocumentLine } from '../inventory/schema';
import { LOT_RANGE, qualityLot } from './schema';

export const LOT_CAPABILITY = 'QM.LOT.CREATE';
export const LOT_ROUTE = '/quality/lots';
export const LOT_OBJECT_CLASS = 'quality_lot';

export class InspectionLotError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'InspectionLotError';
    this.remedy = remedy;
  }
}

const key = (max: number) => z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().min(1).max(max));
const optionalText = (max: number) =>
  z.union([z.undefined(), z.literal(''), z.string().trim().pipe(z.string().max(max))]);

export const lotOpenInput = z.object({
  client: z.string().trim().length(4),
  changedBy: key(60),
  materialDocumentNumber: key(20),
  lineNumber: z.coerce.number().int().positive(),
  inspectionNote: optionalText(200).optional(),
  requestKey: optionalText(64).optional(),
});
export type LotOpenInput = z.infer<typeof lotOpenInput>;

/**
 * What the receipt left standing, as the lot sees it. Every field here is read from the document line or its
 * header; none of them is stored on the lot, and the pair of quantities is the posting's own: the item-unit
 * figure the person typed and the base-unit figure the stock and valuation moved in.
 */
export interface LotSourceView {
  materialDocumentNumber: string;
  documentYear: number;
  documentDate: string;
  postingDate: string;
  documentStatus: string;
  reversedBy: string | null;
  lineNumber: number;
  movementType: string;
  lineDirection: string;
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  batchNumber: string;
  stockType: string;
  entryQuantity: string;
  entryUnit: string;
  baseQuantity: string;
  baseUnit: string;
  purchaseOrderNumber: string | null;
  purchaseOrderItem: number | null;
  /** Another document's line reverses this one, so the goods no longer stand where the lot was opened. */
  reversedOutBy: string | null;
  /** Set when this line is itself the reversal of another: goods going back, not goods arriving. */
  reversalOfDocument: string | null;
  reversalOfLine: number | null;
}

/**
 * `OPEN` while the receipt line stands. `SOURCE_REVERSED` once a reversal has undone the line — read from
 * the documents themselves, never stored, so a lot cannot claim to be open about goods that have gone back.
 */
export type LotState = 'OPEN' | 'SOURCE_REVERSED';

export interface LotView {
  lotNumber: string;
  inspectionNote: string | null;
  openedBy: string;
  openedAt: string;
  state: LotState;
  source: LotSourceView;
}

async function sourceOfLine(
  tx: Tx, client: string, materialDocumentNumber: string, lineNumber: number,
): Promise<LotSourceView | null> {
  const [row] = await tx.select({
    documentYear: materialDocument.documentYear,
    documentDate: materialDocument.documentDate,
    postingDate: materialDocument.postingDate,
    documentStatus: materialDocument.status,
    documentReversedBy: materialDocument.reversedBy,
    movementType: materialDocumentLine.movementType,
    lineDirection: materialDocumentLine.lineDirection,
    materialNumber: materialDocumentLine.materialNumber,
    plant: materialDocumentLine.plant,
    storageLocation: materialDocumentLine.storageLocation,
    batchNumber: materialDocumentLine.batchNumber,
    stockType: materialDocumentLine.stockType,
    entryQuantity: materialDocumentLine.entryQuantity,
    entryUnit: materialDocumentLine.entryUnit,
    baseQuantity: materialDocumentLine.baseQuantity,
    baseUnit: materialDocumentLine.baseUnit,
    purchaseOrderNumber: materialDocumentLine.purchaseOrderNumber,
    purchaseOrderItem: materialDocumentLine.purchaseOrderItem,
    reversalOfDocument: materialDocumentLine.reversalOfDocument,
    reversalOfLine: materialDocumentLine.reversalOfLine,
  }).from(materialDocumentLine).innerJoin(materialDocument, and(
    eq(materialDocument.client, materialDocumentLine.client),
    eq(materialDocument.materialDocumentNumber, materialDocumentLine.materialDocumentNumber),
  )).where(and(
    eq(materialDocumentLine.client, client),
    eq(materialDocumentLine.materialDocumentNumber, materialDocumentNumber),
    eq(materialDocumentLine.lineNumber, lineNumber),
  )).limit(1);
  if (!row) return null;

  // A reversal is its own document naming the line it undid (SCR-145 keeps `reversal_of_*` for exactly
  // this), so which line has gone back is a fact of the ledger rather than a state the lot has to keep.
  const reversedOutBy = await reversalOf(tx, client, materialDocumentNumber, lineNumber);

  return {
    materialDocumentNumber,
    documentYear: row.documentYear,
    documentDate: row.documentDate,
    postingDate: row.postingDate,
    documentStatus: row.documentStatus,
    reversedBy: row.documentReversedBy,
    lineNumber,
    movementType: row.movementType,
    lineDirection: row.lineDirection,
    materialNumber: row.materialNumber,
    plant: row.plant,
    storageLocation: row.storageLocation,
    batchNumber: row.batchNumber,
    stockType: row.stockType,
    entryQuantity: row.entryQuantity,
    entryUnit: row.entryUnit,
    baseQuantity: row.baseQuantity,
    baseUnit: row.baseUnit,
    purchaseOrderNumber: row.purchaseOrderNumber,
    purchaseOrderItem: row.purchaseOrderItem,
    reversedOutBy,
    reversalOfDocument: row.reversalOfDocument,
    reversalOfLine: row.reversalOfLine,
  };
}

async function lotOf(
  tx: Tx, client: string, lotNumber: string,
): Promise<LotView | null> {
  // The lot, its source line and that line's document in one read: what a lot is told by is the receipt, so
  // the view is assembled from the rows the lot points at rather than from anything the lot keeps.
  const [row] = await tx.select({
    inspectionNote: qualityLot.inspectionNote,
    createdBy: qualityLot.createdBy,
    createdAt: qualityLot.createdAt,
    materialDocumentNumber: qualityLot.materialDocumentNumber,
    materialDocumentLine: qualityLot.materialDocumentLine,
    documentYear: materialDocument.documentYear,
    documentDate: materialDocument.documentDate,
    postingDate: materialDocument.postingDate,
    documentStatus: materialDocument.status,
    documentReversedBy: materialDocument.reversedBy,
    movementType: materialDocumentLine.movementType,
    lineDirection: materialDocumentLine.lineDirection,
    materialNumber: materialDocumentLine.materialNumber,
    plant: materialDocumentLine.plant,
    storageLocation: materialDocumentLine.storageLocation,
    batchNumber: materialDocumentLine.batchNumber,
    stockType: materialDocumentLine.stockType,
    entryQuantity: materialDocumentLine.entryQuantity,
    entryUnit: materialDocumentLine.entryUnit,
    baseQuantity: materialDocumentLine.baseQuantity,
    baseUnit: materialDocumentLine.baseUnit,
    purchaseOrderNumber: materialDocumentLine.purchaseOrderNumber,
    purchaseOrderItem: materialDocumentLine.purchaseOrderItem,
    reversalOfDocument: materialDocumentLine.reversalOfDocument,
    reversalOfLine: materialDocumentLine.reversalOfLine,
  }).from(qualityLot).innerJoin(materialDocument, and(
    eq(materialDocument.client, qualityLot.client),
    eq(materialDocument.materialDocumentNumber, qualityLot.materialDocumentNumber),
  )).innerJoin(materialDocumentLine, and(
    eq(materialDocumentLine.client, qualityLot.client),
    eq(materialDocumentLine.materialDocumentNumber, qualityLot.materialDocumentNumber),
    eq(materialDocumentLine.lineNumber, qualityLot.materialDocumentLine),
  )).where(and(
    eq(qualityLot.client, client), eq(qualityLot.lotNumber, lotNumber),
  )).limit(1);
  if (!row) return null;

  const reversedOutBy = await reversalOf(tx, client, row.materialDocumentNumber, row.materialDocumentLine);

  return {
    lotNumber,
    inspectionNote: row.inspectionNote,
    openedBy: row.createdBy,
    openedAt: row.createdAt.toISOString(),
    state: row.documentStatus === 'REVERSED' || reversedOutBy ? 'SOURCE_REVERSED' : 'OPEN',
    source: {
      materialDocumentNumber: row.materialDocumentNumber,
      documentYear: row.documentYear,
      documentDate: row.documentDate,
      postingDate: row.postingDate,
      documentStatus: row.documentStatus,
      reversedBy: row.documentReversedBy,
      lineNumber: row.materialDocumentLine,
      movementType: row.movementType,
      lineDirection: row.lineDirection,
      materialNumber: row.materialNumber,
      plant: row.plant,
      storageLocation: row.storageLocation,
      batchNumber: row.batchNumber,
      stockType: row.stockType,
      entryQuantity: row.entryQuantity,
      entryUnit: row.entryUnit,
      baseQuantity: row.baseQuantity,
      baseUnit: row.baseUnit,
      purchaseOrderNumber: row.purchaseOrderNumber,
      purchaseOrderItem: row.purchaseOrderItem,
      reversedOutBy,
      reversalOfDocument: row.reversalOfDocument,
      reversalOfLine: row.reversalOfLine,
    },
  };
}

/** The document and line that undo this one, if any — the reversal pair the ledger already keeps. */
async function reversalOf(
  tx: Tx, client: string, materialDocumentNumber: string, lineNumber: number,
): Promise<string | null> {
  const [undo] = await tx.select({
    document: materialDocumentLine.materialDocumentNumber,
    line: materialDocumentLine.lineNumber,
  }).from(materialDocumentLine).where(and(
    eq(materialDocumentLine.client, client),
    eq(materialDocumentLine.reversalOfDocument, materialDocumentNumber),
    eq(materialDocumentLine.reversalOfLine, lineNumber),
  )).limit(1);
  return undo ? `${undo.document} / ${undo.line}` : null;
}

/**
 * Open a lot against one line of a posted material document.
 *
 * The line has to be a receipt that still stands: an issue line records goods leaving, and a line a reversal
 * has undone records goods that went back — neither is anything an inspector could examine. A lot already
 * standing against the line is named in the refusal rather than answered with a second one, and a submission
 * that repeats its request key returns the lot the first attempt created.
 */
export async function openLot(input: LotOpenInput): Promise<LotView & { replayed: boolean }> {
  const parsed = lotOpenInput.parse(input);
  const opened = await withTenant(parsed.client, async (tx) => {
    if (parsed.requestKey) {
      const [previous] = await tx.select({ lotNumber: qualityLot.lotNumber }).from(qualityLot).where(and(
        eq(qualityLot.client, parsed.client), eq(qualityLot.requestKey, parsed.requestKey),
      )).limit(1);
      if (previous) return { lotNumber: previous.lotNumber, replayed: true };
    }

    // One lock per source line, so two people opening the same goods at the same moment cannot both find
    // the space free. The unique index on (client, document, line) is the backstop, not the message.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${
      `${parsed.client}/quality-lot/${parsed.materialDocumentNumber}/${parsed.lineNumber}`}, 0))`);

    const source = await sourceOfLine(tx, parsed.client, parsed.materialDocumentNumber, parsed.lineNumber);
    if (!source) {
      throw new InspectionLotError(
        `Material document ${parsed.materialDocumentNumber} carries no line ${parsed.lineNumber} in this tenant.`,
        'Open a lot against the line a posted receipt actually wrote. The number is on the receipt confirmation.',
      );
    }
    if (source.lineDirection !== 'RECEIPT') {
      throw new InspectionLotError(
        `Document ${source.materialDocumentNumber} line ${source.lineNumber} is an ${source.lineDirection.toLowerCase()} of `
        + `${source.baseQuantity} ${source.baseUnit} of ${source.materialNumber}, and an issue records goods leaving.`,
        'A lot is opened against the line that received the goods.',
      );
    }
    if (source.reversalOfDocument) {
      throw new InspectionLotError(
        `Document ${source.materialDocumentNumber} line ${source.lineNumber} is the reversal of `
        + `${source.reversalOfDocument}${source.reversalOfLine ? ` line ${source.reversalOfLine}` : ''}: it records goods going back.`,
        'Open the lot against the receipt line the reversal undid, while that receipt still stands.',
      );
    }
    if (source.documentStatus === 'REVERSED') {
      throw new InspectionLotError(
        `Material document ${source.materialDocumentNumber} stands reversed${source.reversedBy ? ` by ${source.reversedBy}` : ''}; `
        + 'its receipt is not standing goods to inspect.',
        'Open the lot against the receipt that stands, before it is reversed.',
      );
    }
    if (source.reversedOutBy) {
      throw new InspectionLotError(
        `Line ${source.lineNumber} of ${source.materialDocumentNumber} was reversed by ${source.reversedOutBy}; those goods went back.`,
        'Open a lot against a line no reversal has undone.',
      );
    }

    const [standing] = await tx.select({ lotNumber: qualityLot.lotNumber }).from(qualityLot).where(and(
      eq(qualityLot.client, parsed.client),
      eq(qualityLot.materialDocumentNumber, source.materialDocumentNumber),
      eq(qualityLot.materialDocumentLine, source.lineNumber),
    )).limit(1);
    if (standing) {
      throw new InspectionLotError(
        `Lot ${standing.lotNumber} already stands against ${source.materialDocumentNumber} line ${source.lineNumber}.`,
        'One lot per receipt line. Record what was found on '
        + `${standing.lotNumber} when the decision path exists, or open a lot against another line.`,
      );
    }

    let number: string;
    try {
      const drawn = await allocateNumber(tx, {
        client: parsed.client, objectCode: LOT_RANGE.objectCode, companyCode: '*',
        subObject: LOT_RANGE.subObject, allocatedBy: parsed.changedBy,
      });
      number = drawn.display;
    } catch {
      throw new InspectionLotError(
        `No active ${LOT_RANGE.objectCode} number range stands for this tenant, so no lot number can be drawn.`,
        'Define the interval at /config/number-ranges for object code INSPLOT, then save again.',
      );
    }

    try {
      await tx.insert(qualityLot).values({
        client: parsed.client,
        lotNumber: number,
        materialDocumentNumber: source.materialDocumentNumber,
        materialDocumentLine: source.lineNumber,
        inspectionNote: parsed.inspectionNote || null,
        requestKey: parsed.requestKey || null,
        createdBy: parsed.changedBy,
      });
    } catch (caught) {
      // The race the advisory lock does not cover: same line, different key, same instant.
      if (typeof caught === 'object' && caught !== null && 'code' in caught && caught.code === '23505') {
        const [winner] = await tx.select({ lotNumber: qualityLot.lotNumber }).from(qualityLot).where(and(
          eq(qualityLot.client, parsed.client),
          eq(qualityLot.materialDocumentNumber, source.materialDocumentNumber),
          eq(qualityLot.materialDocumentLine, source.lineNumber),
        )).limit(1);
        throw new InspectionLotError(
          `Lot ${winner?.lotNumber ?? 'another'} was opened against ${source.materialDocumentNumber} line ${source.lineNumber} in the same moment.`,
          'One lot per receipt line. Read the list and open the other line.',
        );
      }
      throw caught;
    }

    await recordChange(tx, {
      client: parsed.client, objectClass: LOT_OBJECT_CLASS, objectKey: number, changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: {
        materialDocumentNumber: source.materialDocumentNumber,
        materialDocumentLine: source.lineNumber,
        materialNumber: source.materialNumber,
        plant: source.plant,
        batch: source.batchNumber,
        quantity: source.baseQuantity,
        unit: source.baseUnit,
        stockType: source.stockType,
        movementType: source.movementType,
        inspectionNote: parsed.inspectionNote || null,
      },
    });

    return { lotNumber: number, replayed: false };
  });

  const view = await getLot(parsed.client, opened.lotNumber);
  if (!view) throw new InspectionLotError(`Lot ${opened.lotNumber} could not be read back.`);
  return { ...view, replayed: opened.replayed };
}

/** One lot, as it stands: its own note plus the receipt line it was opened against. */
export async function getLot(client: string, lotNumber: string): Promise<LotView | null> {
  const wanted = lotNumber.trim().toUpperCase();
  if (!wanted) return null;
  return withTenant(client, async (tx) => lotOf(tx, client, wanted));
}

export interface LotListRow {
  lotNumber: string;
  materialDocumentNumber: string;
  materialDocumentLine: number;
  state: LotState;
  documentStatus: string;
  postingDate: string;
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  batchNumber: string;
  stockType: string;
  movementType: string;
  baseQuantity: string;
  baseUnit: string;
  openedBy: string;
}

/**
 * The lots of this tenant, newest first, narrowed by lot, document, material or batch.
 *
 * The list reads the receipt lines too, so a page of lots carries what a dispatcher needs without one query
 * per row; `state` here is derived from the document header alone, which is the difference between "the
 * receipt was undone in full" and the line-level answer the detail gives.
 */
export async function listLots(client: string, filter: {
  lotNumber?: string; materialDocumentNumber?: string; materialNumber?: string; batchNumber?: string;
} = {}): Promise<LotListRow[]> {
  const wanted = (value: string | undefined) => (value ? value.trim().toUpperCase() : '');
  const lot = wanted(filter.lotNumber);
  const document = wanted(filter.materialDocumentNumber);
  const material = wanted(filter.materialNumber);
  const batch = wanted(filter.batchNumber);

  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      lotNumber: qualityLot.lotNumber,
      materialDocumentNumber: qualityLot.materialDocumentNumber,
      materialDocumentLine: qualityLot.materialDocumentLine,
      createdBy: qualityLot.createdBy,
      documentStatus: materialDocument.status,
      postingDate: materialDocument.postingDate,
      movementType: materialDocumentLine.movementType,
      materialNumber: materialDocumentLine.materialNumber,
      plant: materialDocumentLine.plant,
      storageLocation: materialDocumentLine.storageLocation,
      batchNumber: materialDocumentLine.batchNumber,
      stockType: materialDocumentLine.stockType,
      baseQuantity: materialDocumentLine.baseQuantity,
      baseUnit: materialDocumentLine.baseUnit,
    }).from(qualityLot)
      .innerJoin(materialDocument, and(
        eq(materialDocument.client, qualityLot.client),
        eq(materialDocument.materialDocumentNumber, qualityLot.materialDocumentNumber),
      ))
      .innerJoin(materialDocumentLine, and(
        eq(materialDocumentLine.client, qualityLot.client),
        eq(materialDocumentLine.materialDocumentNumber, qualityLot.materialDocumentNumber),
        eq(materialDocumentLine.lineNumber, qualityLot.materialDocumentLine),
      ))
      .where(and(
        eq(qualityLot.client, client),
        lot ? eq(qualityLot.lotNumber, lot) : undefined,
        document ? eq(qualityLot.materialDocumentNumber, document) : undefined,
        material ? eq(materialDocumentLine.materialNumber, material) : undefined,
        batch ? eq(materialDocumentLine.batchNumber, batch) : undefined,
      ))
      .orderBy(desc(qualityLot.lotNumber))
      .limit(200);

    return rows.map((row) => ({
      lotNumber: row.lotNumber,
      materialDocumentNumber: row.materialDocumentNumber,
      materialDocumentLine: row.materialDocumentLine,
      state: row.documentStatus === 'REVERSED' ? 'SOURCE_REVERSED' : 'OPEN',
      documentStatus: row.documentStatus,
      postingDate: row.postingDate,
      materialNumber: row.materialNumber,
      plant: row.plant,
      storageLocation: row.storageLocation,
      batchNumber: row.batchNumber,
      stockType: row.stockType,
      movementType: row.movementType,
      baseQuantity: row.baseQuantity,
      baseUnit: row.baseUnit,
      openedBy: row.createdBy,
    }));
  });
}

/**
 * The receipt lines of this tenant that no lot stands against yet — the list the opening form works from,
 * in the same shape `listDeliverableOrderLines` gives for a delivery.
 *
 * "Still stands" is the document's own state, not a rule invented here: a line whose document is reversed in
 * full is not goods to examine, and a line an issue wrote never was.
 */
export async function listInspectableLines(client: string, filter: {
  materialDocumentNumber?: string;
} = {}): Promise<Array<{
  materialDocumentNumber: string; documentYear: number; postingDate: string; lineNumber: number;
  movementType: string; materialNumber: string; plant: string; storageLocation: string | null;
  batchNumber: string; stockType: string; baseQuantity: string; baseUnit: string;
  purchaseOrderNumber: string | null;
}>> {
  const document = (filter.materialDocumentNumber ?? '').trim().toUpperCase();
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select ml.material_document_number, h.document_year, h.posting_date, ml.line_number,
             ml.movement_type, ml.material_number, ml.plant, ml.storage_location, ml.batch_number,
             ml.stock_type, ml.base_quantity::text as base_quantity, ml.base_unit,
             ml.purchase_order_number
        from material_document_line ml
        join material_document h on h.client = ml.client and h.material_document_number = ml.material_document_number
       where ml.client = ${client}
         and ml.line_direction = 'RECEIPT'
         and ml.reversal_of_document is null
         and h.status <> 'REVERSED'
         and not exists (
           select 1 from material_document_line undo
            where undo.client = ml.client
              and undo.reversal_of_document = ml.material_document_number
              and undo.reversal_of_line = ml.line_number
         )
         and not exists (
           select 1 from quality_lot lot
            where lot.client = ml.client
              and lot.material_document_number = ml.material_document_number
              and lot.material_document_line = ml.line_number
         )
         ${document ? sql`and ml.material_document_number = ${document}` : sql``}
       order by ml.material_document_number desc, ml.line_number
       limit 50
    `) as unknown as Array<{
      material_document_number: string; document_year: number; posting_date: string; line_number: number;
      movement_type: string; material_number: string; plant: string; storage_location: string | null;
      batch_number: string; stock_type: string; base_quantity: string; base_unit: string;
      purchase_order_number: string | null;
    }>;

    return rows.map((row) => ({
      materialDocumentNumber: row.material_document_number,
      documentYear: row.document_year,
      postingDate: row.posting_date,
      lineNumber: row.line_number,
      movementType: row.movement_type,
      materialNumber: row.material_number,
      plant: row.plant,
      storageLocation: row.storage_location,
      batchNumber: row.batch_number,
      stockType: row.stock_type,
      baseQuantity: row.base_quantity,
      baseUnit: row.base_unit,
      purchaseOrderNumber: row.purchase_order_number,
    }));
  });
}
