/**
 * Usage decisions — QE51N equivalent for quality management.
 *
 * A usage decision accepts, rejects, blocks or schedules rework for the goods named by one
 * inspection lot. It validates that mandatory inspection results are complete before the decision
 * is recorded, prevents duplicate decisions, and gates whether the goods may leave quality
 * inspection stock.
 *
 * The decision is recorded first; the stock movement that follows (quality to unrestricted on
 * accept, quality to blocked on reject) is a separate act that names the decision. The two are
 * atomic: postUsageDecisionWithStock posts the decision and the stock movement in one transaction,
 * so a partial failure can never leave inconsistent stock.
 */

import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import {
  qualityLot, inspectionResult, usageDecision,
} from './schema';
import { lotResultSummary } from './inspection-results';

export const USAGE_DECISION_CAPABILITY = 'QM.USAGE.DECIDE';
export const USAGE_DECISION_OBJECT_CLASS = 'usage_decision';

export class UsageDecisionError extends Error {
  remedy?: string;
  code?: string;
  constructor(message: string, remedy?: string, code?: string) {
    super(message);
    this.name = 'UsageDecisionError';
    this.remedy = remedy;
    this.code = code;
  }
}

const key = (max: number) => z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().min(1).max(max));

export const decisionInput = z.object({
  lotNumber: key(20),
  decisionCode: z.enum(['ACCEPT', 'REJECT', 'BLOCK', 'REWORK']),
  decisionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is required').optional(),
  postStock: z.boolean().optional().default(true),
  requestKey: z.string().trim().max(64).optional(),
});

export type DecisionInput = z.infer<typeof decisionInput>;

export interface DecisionRow {
  lotNumber: string;
  decisionCode: string;
  decisionDate: string;
  decidedBy: string;
  stockPosted: boolean;
  stockDocumentNumber: string | null;
  stockDocumentLine: number | null;
  createdBy: string;
}

export interface DecisionWithLot {
  lotNumber: string;
  lotState: 'OPEN' | 'SOURCE_REVERSED';
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  batchNumber: string;
  stockType: string;
  baseQuantity: string;
  baseUnit: string;
  decisionCode: string | null;
  decisionDate: string | null;
  decidedBy: string | null;
  stockPosted: boolean;
  results: {
    total: number;
    recorded: number;
    accepted: number;
    rejected: number;
    allComplete: boolean;
  };
}

async function loadLotDetail(tx: Tx, client: string, lotNumber: string): Promise<{
  lotNumber: string; materialNumber: string; plant: string;
  storageLocation: string | null; batchNumber: string;
  stockType: string; baseQuantity: string; baseUnit: string;
  state: 'OPEN' | 'SOURCE_REVERSED';
} | null> {
  const [row] = await tx.select({
    lotNumber: qualityLot.lotNumber,
    materialDocumentNumber: qualityLot.materialDocumentNumber,
    materialDocumentLine: qualityLot.materialDocumentLine,
  }).from(qualityLot).where(and(
    eq(qualityLot.client, client), eq(qualityLot.lotNumber, lotNumber),
  )).limit(1);
  if (!row) return null;

  const [source] = await tx.select({
    materialNumber: sql`mdl.material_number`,
    plant: sql`mdl.plant`,
    storageLocation: sql`mdl.storage_location`,
    batchNumber: sql`mdl.batch_number`,
    stockType: sql`mdl.stock_type`,
    baseQuantity: sql`mdl.base_quantity`,
    baseUnit: sql`mdl.base_unit`,
    documentStatus: sql`md.status`,
  }).from(sql`material_document_line mdl`)
    .innerJoin(sql`material_document md`, and(
      eq(sql`md.client`, sql`mdl.client`),
      eq(sql`md.material_document_number`, sql`mdl.material_document_number`),
    ))
    .where(and(
      eq(sql`mdl.client`, client),
      eq(sql`mdl.material_document_number`, row.materialDocumentNumber),
      eq(sql`mdl.line_number`, row.materialDocumentLine),
    )).limit(1);
  if (!source) return null;

  const state = source.documentStatus === 'REVERSED' ? 'SOURCE_REVERSED' : 'OPEN';
  return {
    lotNumber: row.lotNumber,
    materialNumber: String(source.materialNumber),
    plant: String(source.plant),
    storageLocation: source.storageLocation ? String(source.storageLocation) : null,
    batchNumber: String(source.batchNumber),
    stockType: String(source.stockType),
    baseQuantity: String(source.baseQuantity),
    baseUnit: String(source.baseUnit),
    state,
  };
}

async function getExistingDecision(tx: Tx, client: string, lotNumber: string): Promise<{
  decisionCode: string; decisionDate: string; decidedBy: string; stockPosted: boolean;
} | null> {
  const [row] = await tx.select({
    decisionCode: usageDecision.decisionCode,
    decisionDate: usageDecision.decisionDate,
    decidedBy: usageDecision.decidedBy,
    stockPosted: usageDecision.stockPosted,
  }).from(usageDecision).where(and(
    eq(usageDecision.client, client), eq(usageDecision.lotNumber, lotNumber),
  )).limit(1);
  if (!row) return null;
  return {
    decisionCode: row.decisionCode,
    decisionDate: String(row.decisionDate).slice(0, 10),
    decidedBy: row.decidedBy,
    stockPosted: row.stockPosted,
  };
}

export async function recordUsageDecision(
  raw: DecisionInput & { changedBy: string; client: string },
): Promise<DecisionRow> {
  const parsed = decisionInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UsageDecisionError(`${issue.path.join('.')}: ${issue.message}`);
  }
  const input = parsed.data;
  const { client, changedBy } = raw;

  const decision = await withTenant(client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${
      `${client}/usage-decision/${input.lotNumber}`
    }, 0))`);

    const lot = await loadLotDetail(tx, client, input.lotNumber);
    if (!lot) {
      throw new UsageDecisionError(
        `Inspection lot ${input.lotNumber} does not exist in this tenant.`,
        'Open the lot first at /quality/lots, then decide on it.',
      );
    }
    if (lot.state === 'SOURCE_REVERSED') {
      throw new UsageDecisionError(
        `Lot ${input.lotNumber} names a receipt line that has been reversed; no decision can be recorded against it.`,
        'Decide on a lot whose receipt still stands.',
      );
    }

    const existing = await getExistingDecision(tx, client, input.lotNumber);
    if (existing) {
      throw new UsageDecisionError(
        `Lot ${input.lotNumber} already has a ${existing.decisionCode} decision from ${existing.decisionDate} by ${existing.decidedBy}.`,
        'A lot carries one usage decision. The earlier decision stands as history.',
        'DUPLICATE_DECISION',
      );
    }

    const summary = await lotResultSummary(client, input.lotNumber);
    if (!summary || summary.totalCharacteristics === 0) {
      throw new UsageDecisionError(
        `No inspection characteristics stand for this tenant, so ${input.lotNumber} has nothing to decide against.`,
        'Maintain at least one characteristic, record results against the lot, then decide.',
      );
    }
    if (!summary.allMandatoryComplete) {
      throw new UsageDecisionError(
        `Lot ${input.lotNumber} has ${summary.resultsRecorded} of ${summary.totalCharacteristics} results recorded. ` +
        'All characteristics must have a result before a usage decision can be made.',
        'Record the missing results, then decide.',
        'INCOMPLETE_RESULTS',
      );
    }

    const decisionDate = input.decisionDate || new Date().toISOString().slice(0, 10);

    const [inserted] = await tx.insert(usageDecision).values({
      client,
      lotNumber: input.lotNumber,
      decisionCode: input.decisionCode,
      decisionDate,
      decidedBy: changedBy,
      stockPosted: false,
      stockDocumentNumber: null,
      stockDocumentLine: null,
      createdBy: changedBy,
    }).returning();

    await recordChange(tx, {
      client, objectClass: USAGE_DECISION_OBJECT_CLASS, objectKey: input.lotNumber,
      changeType: 'CREATE', changedBy,
      after: {
        lotNumber: input.lotNumber,
        decisionCode: input.decisionCode,
        decisionDate,
        decidedBy: changedBy,
      },
    });

    return { lotNumber: inserted.lotNumber, replayed: false };
  });

  const view = await getUsageDecisionView(client, input.lotNumber);
  if (!view) throw new UsageDecisionError(`Decision for ${input.lotNumber} could not be read back.`);
  return view;
}

export async function postUsageDecisionWithStock(
  raw: DecisionInput & { changedBy: string; client: string },
): Promise<DecisionRow & { stockDocumentNumber: string | null; stockDocumentLine: number | null }> {
  const parsed = decisionInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UsageDecisionError(`${issue.path.join('.')}: ${issue.message}`);
  }
  const input = parsed.data;
  const { client, changedBy } = raw;

  const outcome = await withTenant(client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${
      `${client}/usage-decision-stock/${input.lotNumber}`
    }, 0))`);

    const lot = await loadLotDetail(tx, client, input.lotNumber);
    if (!lot) {
      throw new UsageDecisionError(
        `Inspection lot ${input.lotNumber} does not exist in this tenant.`,
        'Open the lot first at /quality/lots, then decide on it.',
      );
    }
    if (lot.state === 'SOURCE_REVERSED') {
      throw new UsageDecisionError(
        `Lot ${input.lotNumber} names a receipt line that has been reversed; no decision can be recorded against it.`,
        'Decide on a lot whose receipt still stands.',
      );
    }

    const existing = await getExistingDecision(tx, client, input.lotNumber);
    if (existing) {
      throw new UsageDecisionError(
        `Lot ${input.lotNumber} already has a ${existing.decisionCode} decision from ${existing.decisionDate} by ${existing.decidedBy}.`,
        'A lot carries one usage decision. The earlier decision stands as history.',
        'DUPLICATE_DECISION',
      );
    }

    const summary = await lotResultSummary(client, input.lotNumber);
    if (!summary || summary.totalCharacteristics === 0) {
      throw new UsageDecisionError(
        `No inspection characteristics stand for this tenant, so ${input.lotNumber} has nothing to decide against.`,
        'Maintain at least one characteristic, record results against the lot, then decide.',
      );
    }
    if (!summary.allMandatoryComplete) {
      throw new UsageDecisionError(
        `Lot ${input.lotNumber} has ${summary.resultsRecorded} of ${summary.totalCharacteristics} results recorded. ` +
        'All characteristics must have a result before a usage decision can be made.',
        'Record the missing results, then decide.',
        'INCOMPLETE_RESULTS',
      );
    }

    if (input.decisionCode === 'REWORK') {
      const decisionDate = input.decisionDate || new Date().toISOString().slice(0, 10);
      const [inserted] = await tx.insert(usageDecision).values({
        client, lotNumber: input.lotNumber, decisionCode: input.decisionCode,
        decisionDate, decidedBy: changedBy, stockPosted: false,
        stockDocumentNumber: null, stockDocumentLine: null, createdBy: changedBy,
      }).returning();

      await recordChange(tx, {
        client, objectClass: USAGE_DECISION_OBJECT_CLASS, objectKey: input.lotNumber,
        changeType: 'CREATE', changedBy,
        after: { lotNumber: input.lotNumber, decisionCode: input.decisionCode, decisionDate, decidedBy: changedBy },
      });

      return { decision: inserted, stockDocNumber: null, stockDocLine: null, posted: false };
    }

    let destinationStockType: string;
    let stockMovementRequired: boolean;
    switch (input.decisionCode) {
      case 'ACCEPT':
        destinationStockType = 'UNRESTRICTED';
        stockMovementRequired = true;
        break;
      case 'REJECT':
      case 'BLOCK':
        destinationStockType = 'BLOCKED';
        stockMovementRequired = true;
        break;
      default:
        destinationStockType = 'QUALITY';
        stockMovementRequired = false;
    }

    const decisionDate = input.decisionDate || new Date().toISOString().slice(0, 10);

    let stockDocNumber: string | null = null;
    let stockDocLine: number | null = null;

    if (stockMovementRequired && input.postStock !== false) {
      const stockResult = await postQualityStockMovementInTx(tx, {
        client,
        changedBy,
        lotNumber: input.lotNumber,
        materialNumber: lot.materialNumber,
        plant: lot.plant,
        storageLocation: lot.storageLocation || '',
        batchNumber: lot.batchNumber,
        quantity: Number(lot.baseQuantity),
        unit: lot.baseUnit,
        sourceStockType: lot.stockType,
        destinationStockType,
        requestKey: input.requestKey,
      });
      stockDocNumber = stockResult.documentNumber;
      stockDocLine = stockResult.lineNumber;
    }

    const [inserted] = await tx.insert(usageDecision).values({
      client, lotNumber: input.lotNumber, decisionCode: input.decisionCode,
      decisionDate, decidedBy: changedBy,
      stockPosted: stockMovementRequired && input.postStock !== false,
      stockDocumentNumber: stockDocNumber,
      stockDocumentLine: stockDocLine,
      createdBy: changedBy,
    }).returning();

    await recordChange(tx, {
      client, objectClass: USAGE_DECISION_OBJECT_CLASS, objectKey: input.lotNumber,
      changeType: 'CREATE', changedBy,
      after: {
        lotNumber: input.lotNumber, decisionCode: input.decisionCode, decisionDate,
        decidedBy: changedBy, stockPosted: stockMovementRequired && input.postStock !== false,
        stockDocumentNumber: stockDocNumber, stockDocumentLine: stockDocLine,
      },
    });

    return {
      decision: inserted, stockDocNumber, stockDocLine,
      posted: stockMovementRequired && input.postStock !== false,
    };
  });

  const view = await getUsageDecisionView(client, input.lotNumber);
  if (!view) throw new UsageDecisionError(`Decision for ${input.lotNumber} could not be read back.`);
  return {
    ...view,
    stockDocumentNumber: outcome.stockDocNumber,
    stockDocumentLine: outcome.stockDocLine,
  };
}

async function postQualityStockMovementInTx(
  tx: Tx,
  input: {
    client: string; changedBy: string; lotNumber: string;
    materialNumber: string; plant: string; storageLocation: string;
    batchNumber: string; quantity: number; unit: string;
    sourceStockType: string; destinationStockType: string;
    requestKey?: string | null;
  },
): Promise<{ documentNumber: string; lineNumber: number }> {
  const { postTransfer } = await import('../../modules/inventory/transfer-posting');
  const requestKey = input.requestKey || `QM-${input.client}-${input.lotNumber}-${Date.now()}`;

  if (input.destinationStockType === 'UNRESTRICTED' && input.sourceStockType === 'QUALITY') {
    const result = await postTransfer({
      client: input.client, changedBy: input.changedBy,
      movementTypeCode: '321',
      materialNumber: input.materialNumber,
      quantity: input.quantity,
      issuingPlant: input.plant,
      issuingStorageLocation: input.storageLocation,
      receivingPlant: input.plant,
      receivingStorageLocation: input.storageLocation,
      postingDate: new Date().toISOString().slice(0, 10),
      documentDate: new Date().toISOString().slice(0, 10),
      requestKey,
      batch: input.batchNumber || undefined,
    });
    return {
      documentNumber: result.materialDocumentNumber,
      lineNumber: 1,
    };
  }

  // For quality->blocked or other stock type changes, use postTransfer
  // with the TRANSFER_STYPE_BLOCK movement (QUALITY -> BLOCKED), keeping
  // the movement inside the inventory posting/document mechanism.
  const result = await postTransfer({
    client: input.client, changedBy: input.changedBy,
    movementTypeCode: '323',
    materialNumber: input.materialNumber,
    quantity: input.quantity,
    issuingPlant: input.plant,
    issuingStorageLocation: input.storageLocation,
    receivingPlant: input.plant,
    receivingStorageLocation: input.storageLocation,
    stockType: input.sourceStockType,
    postingDate: new Date().toISOString().slice(0, 10),
    documentDate: new Date().toISOString().slice(0, 10),
    requestKey,
    batch: input.batchNumber || undefined,
  });
  return {
    documentNumber: result.materialDocumentNumber,
    lineNumber: 2,
  };
}

export async function getUsageDecisionView(
  client: string, lotNumber: string,
): Promise<DecisionRow | null> {
  return withTenant(client, async (tx) => {
    const [row] = await tx.select({
      lotNumber: usageDecision.lotNumber,
      decisionCode: usageDecision.decisionCode,
      decisionDate: usageDecision.decisionDate,
      decidedBy: usageDecision.decidedBy,
      stockPosted: usageDecision.stockPosted,
      stockDocumentNumber: usageDecision.stockDocumentNumber,
      stockDocumentLine: usageDecision.stockDocumentLine,
      createdBy: usageDecision.createdBy,
    }).from(usageDecision).where(and(
      eq(usageDecision.client, client), eq(usageDecision.lotNumber, lotNumber),
    )).limit(1);
    if (!row) return null;
    return {
      lotNumber: row.lotNumber,
      decisionCode: row.decisionCode,
      decisionDate: String(row.decisionDate).slice(0, 10),
      decidedBy: row.decidedBy,
      stockPosted: row.stockPosted,
      stockDocumentNumber: row.stockDocumentNumber,
      stockDocumentLine: row.stockDocumentLine,
      createdBy: row.createdBy,
    };
  });
}

export async function getDecisionWithLot(
  client: string, lotNumber: string,
): Promise<DecisionWithLot | null> {
  return withTenant(client, async (tx) => {
    const lot = await loadLotDetail(tx, client, lotNumber);
    if (!lot) return null;

    const [decision] = await tx.select({
      decisionCode: usageDecision.decisionCode,
      decisionDate: usageDecision.decisionDate,
      decidedBy: usageDecision.decidedBy,
      stockPosted: usageDecision.stockPosted,
    }).from(usageDecision).where(and(
      eq(usageDecision.client, client), eq(usageDecision.lotNumber, lotNumber),
    )).limit(1);

    const summary = await lotResultSummary(client, lotNumber);

    return {
      lotNumber,
      lotState: lot.state,
      materialNumber: lot.materialNumber,
      plant: lot.plant,
      storageLocation: lot.storageLocation,
      batchNumber: lot.batchNumber,
      stockType: lot.stockType,
      baseQuantity: lot.baseQuantity,
      baseUnit: lot.baseUnit,
      decisionCode: decision?.decisionCode ?? null,
      decisionDate: decision?.decisionDate ? String(decision.decisionDate).slice(0, 10) : null,
      decidedBy: decision?.decidedBy ?? null,
      stockPosted: decision?.stockPosted ?? false,
      results: {
        total: summary?.totalCharacteristics ?? 0,
        recorded: summary?.resultsRecorded ?? 0,
        accepted: summary?.resultsAccepted ?? 0,
        rejected: summary?.resultsRejected ?? 0,
        allComplete: summary?.allMandatoryComplete ?? false,
      },
    };
  });
}