/**
 * Inspection results — QA32 equivalent for quality management.
 *
 * A result records what was measured or observed against one characteristic on one inspection lot.
 * Quantitative results carry a measured value, unit and tolerance check; qualitative results carry
 * a result value (e.g. 'PASS', 'FAIL') and no unit. Partial recording is supported: a lot may have
 * many results recorded over time, and a lot is inspection-complete when every mandatory characteristic
 * has a result.
 *
 * Results are append-only per (lot, characteristic): a second recording for the same pair supersedes
 * the first and the earlier value is kept as history through the audit trail. The result status
 * ('RECORDED', 'ACCEPTED', 'REJECTED') is set at recording time from tolerance validation and may
 * be revised when the usage decision is made.
 */

import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import {
  inspectionCharacteristic, inspectionResult, qualityLot,
} from './schema';
import { InspectionLotError } from './lot';

export const INSPECTION_RESULT_CAPABILITY = 'QM.INSPECTION.RECORD';
export const INSPECTION_OBJECT_CLASS = 'inspection_result';

export class InspectionResultError extends Error {
  remedy?: string;
  code?: string;
  constructor(message: string, remedy?: string, code?: string) {
    super(message);
    this.name = 'InspectionResultError';
    this.remedy = remedy;
    this.code = code;
  }
}

const key = (max: number) => z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().min(1).max(max));

export const characteristicInput = z.object({
  characteristicCode: key(16),
  description: z.string().trim().min(1).max(80),
  characteristicType: z.enum(['QUANTITATIVE', 'QUALITATIVE']),
  nominalValue: z.coerce.number().optional().default(0),
  tolerancePlus: z.coerce.number().optional(),
  toleranceMinus: z.coerce.number().optional(),
  unit: z.string().trim().max(6).optional().default(''),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is required').optional().default('2020-01-01'),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is required').optional().default('9999-12-31'),
});

export type CharacteristicInput = z.infer<typeof characteristicInput>;

export const resultInput = z.object({
  lotNumber: key(20),
  characteristicCode: key(16),
  resultValue: z.string().trim().min(1).max(40),
  measuredUnit: z.string().trim().max(6).optional().default(''),
  resultStatus: z.enum(['RECORDED', 'ACCEPTED', 'REJECTED']).optional().default('RECORDED'),
  requestKey: z.string().trim().max(64).optional(),
});

export type ResultInput = z.infer<typeof resultInput>;

export interface CharacteristicRow {
  characteristicCode: string;
  description: string;
  characteristicType: string;
  tolerancePlus: string | null;
  toleranceMinus: string | null;
  unit: string | null;
  validFrom: string;
  validTo: string;
  isActive: boolean;
}

export interface ResultRow {
  lotNumber: string;
  characteristicCode: string;
  characteristicDescription: string;
  characteristicType: string;
  resultValue: string;
  measuredUnit: string | null;
  resultStatus: string;
  recordedBy: string;
  recordedAt: string;
}

export interface LotResultSummary {
  lotNumber: string;
  totalCharacteristics: number;
  resultsRecorded: number;
  resultsAccepted: number;
  resultsRejected: number;
  allMandatoryComplete: boolean;
  canDecide: boolean;
}

async function loadLot(tx: Tx, client: string, lotNumber: string): Promise<{
  lotNumber: string; state: 'OPEN' | 'SOURCE_REVERSED';
} | null> {
  const [row] = await tx.select({
    lotNumber: qualityLot.lotNumber,
    materialDocumentNumber: qualityLot.materialDocumentNumber,
    materialDocumentLine: qualityLot.materialDocumentLine,
  }).from(qualityLot).where(and(
    eq(qualityLot.client, client), eq(qualityLot.lotNumber, lotNumber),
  )).limit(1);
  if (!row) return null;
  // Derive lot standing from the source document.
  const [doc] = await tx.select({
    documentStatus: sql`md.status`,
  }).from(sql`material_document md`).where(and(
    eq(sql`md.client`, client),
    eq(sql`md.material_document_number`, row.materialDocumentNumber),
  )).limit(1);
  const state = doc?.documentStatus === 'REVERSED' ? 'SOURCE_REVERSED' : 'OPEN';
  return { lotNumber: row.lotNumber, state };
}

/** Save or update a characteristic definition. */
export async function saveCharacteristic(
  raw: CharacteristicInput & { changedBy: string; client: string },
): Promise<CharacteristicRow> {
  const parsed = characteristicInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InspectionResultError(
      `${issue.path.join('.')}: ${issue.message}`,
    );
  }
  const input = parsed.data;
  const { client, changedBy } = raw;

  const validated = await withTenant(client, async (tx) => {
    // Validate tolerance pairing.
    if (input.tolerancePlus !== undefined && input.toleranceMinus !== undefined) {
      if (input.tolerancePlus < 0 || input.toleranceMinus > 0) {
        throw new InspectionResultError(
          'Tolerance plus must be >= 0 and tolerance minus must be <= 0.',
          'Enter a non-negative plus tolerance and a non-positive minus tolerance.',
        );
      }
    }
    // Quantitative requires a unit; qualitative does not.
    if (input.characteristicType === 'QUANTITATIVE' && (!input.unit || input.unit.trim().length === 0)) {
      throw new InspectionResultError(
        'A quantitative characteristic needs a unit of measure.',
        'Enter the unit the measured value is stated in.',
      );
    }
    if (input.unit && input.unit.trim().length > 0) {
      const [uom] = await tx.execute(sql`
        select code from public.unit_of_measure
         where code = ${input.unit.trim().toUpperCase()}
      `);
      if (!uom) {
        throw new InspectionResultError(
          `Unit ${input.unit} is not a standing unit of measure.`,
          'Maintain the unit on the units screen, or leave it blank for a qualitative characteristic.',
        );
      }
    }

    const row = await tx.insert(inspectionCharacteristic).values({
      client,
      characteristicCode: input.characteristicCode,
      description: input.description,
      characteristicType: input.characteristicType,
      nominalValue: input.nominalValue !== undefined ? String(input.nominalValue) : '0',
      tolerancePlus: input.tolerancePlus !== undefined ? String(input.tolerancePlus) : null,
      toleranceMinus: input.toleranceMinus !== undefined ? String(input.toleranceMinus) : null,
      unit: input.unit?.trim().toUpperCase() || null,
      validFrom: input.validFrom,
      validTo: input.validTo,
      createdBy: changedBy,
    }).onConflictDoUpdate({
      target: [inspectionCharacteristic.client, inspectionCharacteristic.characteristicCode],
      set: {
        description: input.description,
        characteristicType: input.characteristicType,
        nominalValue: input.nominalValue !== undefined ? String(input.nominalValue) : '0',
        tolerancePlus: input.tolerancePlus !== undefined ? String(input.tolerancePlus) : null,
        toleranceMinus: input.toleranceMinus !== undefined ? String(input.toleranceMinus) : null,
        unit: input.unit?.trim().toUpperCase() || null,
        validFrom: input.validFrom,
        validTo: input.validTo,
        changedBy,
        changedAt: new Date(),
      },
    }).returning();

    await recordChange(tx, {
      client, objectClass: 'inspection_characteristic', objectKey: input.characteristicCode,
      changeType: 'CREATE', changedBy,
      after: { characteristicCode: input.characteristicCode, description: input.description, characteristicType: input.characteristicType },
    });

    return row[0];
  });

  return {
    characteristicCode: validated.characteristicCode,
    description: validated.description,
    characteristicType: validated.characteristicType,
    tolerancePlus: validated.tolerancePlus,
    toleranceMinus: validated.toleranceMinus,
    unit: validated.unit,
    validFrom: validated.validFrom,
    validTo: validated.validTo,
    isActive: true,
  };
}

/** List all characteristics for a tenant. */
export async function listCharacteristics(client: string): Promise<CharacteristicRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(inspectionCharacteristic)
      .where(eq(inspectionCharacteristic.client, client))
      .orderBy(desc(inspectionCharacteristic.characteristicCode));
    return rows.map((r) => ({
      characteristicCode: r.characteristicCode,
      description: r.description,
      characteristicType: r.characteristicType,
      tolerancePlus: r.tolerancePlus,
      toleranceMinus: r.toleranceMinus,
      unit: r.unit,
      validFrom: r.validFrom,
      validTo: r.validTo,
      isActive: true,
    }));
  });
}

/** Record or supersede an inspection result for one characteristic on one lot. */
export async function recordInspectionResult(
  raw: ResultInput & { changedBy: string; client: string },
): Promise<ResultRow> {
  const parsed = resultInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InspectionResultError(
      `${issue.path.join('.')}: ${issue.message}`,
    );
  }
  const input = parsed.data;
  const { client, changedBy } = raw;

  const result = await withTenant(client, async (tx) => {
    // Lock the lot so two people cannot record conflicting results at the same moment.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${
      `${client}/inspection-result/${input.lotNumber}/${input.characteristicCode}`
    }, 0))`);

    // The lot must exist and be open.
    const lot = await loadLot(tx, client, input.lotNumber);
    if (!lot) {
      throw new InspectionLotError(
        `Inspection lot ${input.lotNumber} does not exist in this tenant.`,
        'Open the lot first at /quality/lots, then record results against it.',
      );
    }
    if (lot.state === 'SOURCE_REVERSED') {
      throw new InspectionResultError(
        `Lot ${input.lotNumber} names a receipt line that has been reversed; no result can be recorded against it.`,
        'Record the result against a lot whose receipt still stands.',
      );
    }

    // The characteristic must exist and be valid.
    const [char] = await tx.select().from(inspectionCharacteristic).where(and(
      eq(inspectionCharacteristic.client, client),
      eq(inspectionCharacteristic.characteristicCode, input.characteristicCode),
    ));
    if (!char) {
      throw new InspectionResultError(
        `Characteristic ${input.characteristicCode} does not exist for this tenant.`,
        'Maintain the characteristic first, then record the result.',
      );
    }
    const validFrom = new Date(char.validFrom);
    const validTo = new Date(char.validTo);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (today < validFrom || today > validTo) {
      throw new InspectionResultError(
        `Characteristic ${input.characteristicCode} is not valid today (${char.validFrom} to ${char.validTo}).`,
        'Use a characteristic whose validity covers today, or extend the characteristic.',
      );
    }

    // Validate result against characteristic type and tolerances.
    let resultStatus = input.resultStatus;
    const measuredUnit = (input.measuredUnit ?? '').trim().toUpperCase() || null;

    if (char.characteristicType === 'QUANTITATIVE') {
      if (!measuredUnit) {
        throw new InspectionResultError(
          'A quantitative result needs a unit of measure.',
          'Enter the unit the measured value is stated in.',
        );
      }
      if (char.unit && measuredUnit !== char.unit) {
        throw new InspectionResultError(
          `Characteristic ${input.characteristicCode} is measured in ${char.unit}, not ${measuredUnit}.`,
          'Enter the result in the characteristic\'s unit.',
        );
      }
      const value = Number(input.resultValue);
      if (!Number.isFinite(value)) {
        throw new InspectionResultError(
          `The result value "${input.resultValue}" is not a number.`,
          'Enter a numeric measured value for a quantitative characteristic.',
        );
      }
      // Tolerance check relative to nominal value.
      const nominal = char.nominalValue !== null ? Number(char.nominalValue) : 0;
      const tolPlus = char.tolerancePlus !== null ? Number(char.tolerancePlus) : null;
      const tolMinus = char.toleranceMinus !== null ? Number(char.toleranceMinus) : null;
      const deviation = value - nominal;
      // Quantitative results without tolerances are accepted as recorded.
      if (tolPlus !== null || tolMinus !== null) {
        if (tolPlus !== null && deviation > tolPlus) {
          resultStatus = 'REJECTED';
        } else if (tolMinus !== null && deviation < tolMinus) {
          resultStatus = 'REJECTED';
        } else {
          resultStatus = 'ACCEPTED';
        }
      } else {
        resultStatus = 'ACCEPTED';
      }
    } else {
      // Qualitative: no unit, no numeric tolerance. The result value itself is the judgement.
      if (measuredUnit) {
        throw new InspectionResultError(
          'A qualitative result carries no unit of measure.',
          'Leave the unit blank for a qualitative characteristic.',
        );
      }
      resultStatus = input.resultStatus;
    }

    const upserted = await tx.insert(inspectionResult).values({
      client,
      lotNumber: input.lotNumber,
      characteristicCode: input.characteristicCode,
      resultValue: input.resultValue,
      measuredUnit,
      resultStatus,
      recordedBy: changedBy,
    }).onConflictDoUpdate({
      target: [inspectionResult.client, inspectionResult.lotNumber, inspectionResult.characteristicCode],
      set: {
        resultValue: input.resultValue,
        measuredUnit,
        resultStatus,
        recordedBy: changedBy,
        recordedAt: new Date(),
        changedBy,
        changedAt: new Date(),
      },
    }).returning();

    await recordChange(tx, {
      client, objectClass: INSPECTION_OBJECT_CLASS,
      objectKey: `${input.lotNumber}/${input.characteristicCode}`,
      changeType: 'CREATE', changedBy,
      after: {
        lotNumber: input.lotNumber,
        characteristicCode: input.characteristicCode,
        resultValue: input.resultValue,
        resultStatus,
        measuredUnit,
      },
    });

    return { lotNumber: upserted[0].lotNumber, characteristicCode: upserted[0].characteristicCode, replayed: false };
  });

  const view = await getInspectionResult(client, input.lotNumber, input.characteristicCode);
  if (!view) throw new InspectionResultError(`Result for ${input.lotNumber} / ${input.characteristicCode} could not be read back.`);
  return view;
}

/** Read one result. */
export async function getInspectionResult(
  client: string, lotNumber: string, characteristicCode: string,
): Promise<ResultRow | null> {
  return withTenant(client, async (tx) => {
    const [row] = await tx.select({
      lotNumber: inspectionResult.lotNumber,
      characteristicCode: inspectionResult.characteristicCode,
      resultValue: inspectionResult.resultValue,
      measuredUnit: inspectionResult.measuredUnit,
      resultStatus: inspectionResult.resultStatus,
      recordedBy: inspectionResult.recordedBy,
      recordedAt: inspectionResult.recordedAt,
      charDescription: sql`ic.description`,
      charType: sql`ic.characteristic_type`,
    }).from(inspectionResult)
      .innerJoin(sql`inspection_characteristic ic`, and(
        eq(sql`ic.client`, inspectionResult.client),
        eq(sql`ic.characteristic_code`, inspectionResult.characteristicCode),
      ))
      .where(and(
        eq(inspectionResult.client, client),
        eq(inspectionResult.lotNumber, lotNumber),
        eq(inspectionResult.characteristicCode, characteristicCode),
      )).limit(1);
    if (!row) return null;
    return {
      lotNumber: row.lotNumber,
      characteristicCode: row.characteristicCode,
      characteristicDescription: row.charDescription as string,
      characteristicType: row.charType as string,
      resultValue: row.resultValue,
      measuredUnit: row.measuredUnit,
      resultStatus: row.resultStatus,
      recordedBy: row.recordedBy,
      recordedAt: row.recordedAt.toISOString(),
    };
  });
}

/** List all results for a lot. */
export async function listInspectionResults(client: string, lotNumber: string): Promise<ResultRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      lotNumber: inspectionResult.lotNumber,
      characteristicCode: inspectionResult.characteristicCode,
      resultValue: inspectionResult.resultValue,
      measuredUnit: inspectionResult.measuredUnit,
      resultStatus: inspectionResult.resultStatus,
      recordedBy: inspectionResult.recordedBy,
      recordedAt: inspectionResult.recordedAt,
      charDescription: sql`ic.description`,
      charType: sql`ic.characteristic_type`,
    }).from(inspectionResult)
      .innerJoin(sql`inspection_characteristic ic`, and(
        eq(sql`ic.client`, inspectionResult.client),
        eq(sql`ic.characteristic_code`, inspectionResult.characteristicCode),
      ))
      .where(and(
        eq(inspectionResult.client, client),
        eq(inspectionResult.lotNumber, lotNumber),
      ))
      .orderBy(desc(inspectionResult.recordedAt));
    return rows.map((r) => ({
      lotNumber: r.lotNumber,
      characteristicCode: r.characteristicCode,
      characteristicDescription: r.charDescription as string,
      characteristicType: r.charType as string,
      resultValue: r.resultValue,
      measuredUnit: r.measuredUnit,
      resultStatus: r.resultStatus,
      recordedBy: r.recordedBy,
      recordedAt: r.recordedAt.toISOString(),
    }));
  });
}

/** Summary of a lot's results: how many characteristics are configured, how many have results,
 *  and whether the lot is ready for a usage decision. */
export async function lotResultSummary(client: string, lotNumber: string): Promise<LotResultSummary | null> {
  return withTenant(client, async (tx) => {
    const [lot] = await tx.select({ lotNumber: qualityLot.lotNumber }).from(qualityLot).where(and(
      eq(qualityLot.client, client), eq(qualityLot.lotNumber, lotNumber),
    )).limit(1);
    if (!lot) return null;

    // Count configured characteristics (all characteristics that exist for the tenant).
    const [totalChar] = await tx.execute(sql`
      select count(*)::int as total from inspection_characteristic where client = ${client}
    `) as unknown as Array<{ total: number }>;

    // Count results for this lot.
    const [resultStats] = await tx.execute(sql`
      select
        count(*)::int as recorded,
        count(*) filter (where result_status = 'ACCEPTED')::int as accepted,
        count(*) filter (where result_status = 'REJECTED')::int as rejected
      from inspection_result
      where client = ${client} and lot_number = ${lotNumber}
    `) as unknown as Array<{ recorded: number; accepted: number; rejected: number }>;

    const total = Number(totalChar?.total ?? 0);
    const recorded = Number(resultStats?.recorded ?? 0);
    const accepted = Number(resultStats?.accepted ?? 0);
    const rejected = Number(resultStats?.rejected ?? 0);

    return {
      lotNumber,
      totalCharacteristics: total,
      resultsRecorded: recorded,
      resultsAccepted: accepted,
      resultsRejected: rejected,
      allMandatoryComplete: total > 0 && recorded === total,
      canDecide: total > 0 && recorded === total,
    };
  });
}