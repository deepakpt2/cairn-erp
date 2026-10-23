/**
 * Client-level shelf-life settings. SAP stores these on MARA and shows them
 * on the plant storage view. A plant does not keep a second copy.
 *
 * Saving these fields does not post, does not change a batch date, and does
 * not change the material version used by the other views.
 */
import { eq, and } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { material } from './schema';

export const SHELF_LIFE_PERIODS = [
  { code: ' ', title: 'Days' },
  { code: '1', title: 'Weeks' },
  { code: '2', title: 'Months' },
  { code: '3', title: 'Years' },
] as const;

export type ShelfLifePeriod = (typeof SHELF_LIFE_PERIODS)[number]['code'];

export interface MaterialShelfLife {
  materialNumber: string;
  minRemainingShelfLife: number | null;
  totalShelfLife: number | null;
  storagePercentage: number | null;
  periodIndicator: ShelfLifePeriod | null;
}

export class MaterialShelfLifeError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'MaterialShelfLifeError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy: string): never {
  throw new MaterialShelfLifeError(message, remedy);
}

function optionalCount(value: number | null | undefined, name: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > 9999) {
    fail(`${name} must be a whole number from 0 to 9999.`, 'Leave it empty if it is not maintained.');
  }
  return value;
}

export async function getMaterialShelfLife(client: string, materialNumber: string): Promise<MaterialShelfLife | null> {
  const number = materialNumber.trim().toUpperCase();
  if (!number) return null;
  return withTenant(client, async (tx) => {
    const [row] = await tx.select({
      materialNumber: material.materialNumber,
      minRemainingShelfLife: material.minRemainingShelfLife,
      totalShelfLife: material.totalShelfLife,
      storagePercentage: material.storagePercentage,
      periodIndicator: material.sledPeriodIndicator,
    }).from(material).where(and(eq(material.client, client), eq(material.materialNumber, number)));
    if (!row) return null;
    const indicator = row.periodIndicator?.trim() === '' ? ' ' : row.periodIndicator;
    return {
      materialNumber: row.materialNumber,
      minRemainingShelfLife: row.minRemainingShelfLife,
      totalShelfLife: row.totalShelfLife,
      storagePercentage: row.storagePercentage,
      periodIndicator: indicator === ' ' || indicator === '1' || indicator === '2' || indicator === '3' ? indicator : null,
    };
  });
}

export async function saveMaterialShelfLife(input: {
  client: string;
  changedBy: string;
  materialNumber: string;
  minRemainingShelfLife?: number | null;
  totalShelfLife?: number | null;
  storagePercentage?: number | null;
  periodIndicator?: string | null;
  reason: string;
}): Promise<MaterialShelfLife> {
  const number = input.materialNumber.trim().toUpperCase();
  const reason = input.reason.trim();
  if (reason.length < 3) fail('A reason is required.', 'Say why the shelf-life settings are changing.');
  const minRemaining = optionalCount(input.minRemainingShelfLife, 'Minimum remaining shelf life');
  const total = optionalCount(input.totalShelfLife, 'Total shelf life');
  if (input.storagePercentage === 0) {
    fail('Storage percentage 0 is the initial value. It is not a defined percentage.', 'Leave it empty, or enter 1 to 999.');
  }
  let percentage: number | null = null;
  if (input.storagePercentage !== null && input.storagePercentage !== undefined) {
    if (!Number.isInteger(input.storagePercentage) || input.storagePercentage < 1 || input.storagePercentage > 999) {
      fail('Storage percentage must be a whole number from 1 to 999.', 'Leave it empty if warehouse remaining life is not used.');
    }
    percentage = input.storagePercentage;
  }
  const rawIndicator = (input.periodIndicator ?? '').trim();
  const periodIndicator: ShelfLifePeriod | null = rawIndicator === ''
    ? null
    : rawIndicator === ' ' || rawIndicator === 'D' || rawIndicator === 'DAYS'
      ? ' '
      : rawIndicator === '1' || rawIndicator === '2' || rawIndicator === '3'
        ? rawIndicator
        : null;
  if (rawIndicator !== '' && periodIndicator === null) {
    fail(`Period indicator ${rawIndicator} does not stand.`, 'Choose days, weeks, months, or years. Hours are not a period.');
  }

  return withTenant(input.client, async (tx) => {
    const [before] = await tx.select().from(material).where(and(
      eq(material.client, input.client), eq(material.materialNumber, number),
    )).for('update');
    if (!before) fail(`Material ${number} does not stand.`, 'Create the material before storing shelf life.');
    await tx.update(material).set({
      minRemainingShelfLife: minRemaining,
      totalShelfLife: total,
      storagePercentage: percentage,
      sledPeriodIndicator: periodIndicator,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(eq(material.client, input.client), eq(material.materialNumber, number)));
    await recordChange(tx, {
      client: input.client,
      objectClass: 'material',
      objectKey: number,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: 'INV.MATERIAL.MAINTAIN',
      reason,
      before: {
        minRemainingShelfLife: before.minRemainingShelfLife,
        totalShelfLife: before.totalShelfLife,
        storagePercentage: before.storagePercentage,
        sledPeriodIndicator: before.sledPeriodIndicator,
      },
      after: {
        minRemainingShelfLife: minRemaining,
        totalShelfLife: total,
        storagePercentage: percentage,
        sledPeriodIndicator: periodIndicator,
      },
    });
    return {
      materialNumber: number,
      minRemainingShelfLife: minRemaining,
      totalShelfLife: total,
      storagePercentage: percentage,
      periodIndicator,
    };
  });
}
