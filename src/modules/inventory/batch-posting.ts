/**
 * The batch a goods movement may post. The batch master is not created here,
 * and stock is not created by MSC1N. A material that is not batch-managed
 * posts to the blank batch, which is the balance that already stood.
 * A restricted batch is refused when status management is effective.
 * A shelf-life date before the posting date is refused. A blank date is not invented.
 */
import { eq, sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { batchStatusScope } from './batch-status';
import { readPlantBatchStatusActive } from './batch-status-plant';
import { batchStatusManagement } from './schema';

export class BatchPostingError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'BatchPostingError';
  }
}

export async function resolvePostingBatch(
  tx: Tx,
  input: { client: string; materialNumber: string; plant: string; batch?: string; postingDate?: string },
): Promise<string> {
  const typed = (input.batch ?? '').trim().toUpperCase();
  const levelRows = await tx.execute(sql`
    select batch_level from batch_level_configuration where client = ${input.client} limit 1
  `) as unknown as Array<{ batch_level: string }>;
  const level = levelRows[0]?.batch_level?.trim();
  const code = level === '0' || level === '1' || level === '2' ? level : null;
  let managed = false;
  if (code === '0') {
    const plants = await tx.execute(sql`
      select batch_managed from material_plant
      where client = ${input.client} and material_number = ${input.materialNumber} and plant = ${input.plant}
      limit 1
    `) as unknown as Array<{ batch_managed: boolean }>;
    managed = Boolean(plants[0]?.batch_managed);
  } else if (code) {
    const materials = await tx.execute(sql`
      select batch_managed from material
      where client = ${input.client} and material_number = ${input.materialNumber}
      limit 1
    `) as unknown as Array<{ batch_managed: boolean }>;
    managed = Boolean(materials[0]?.batch_managed);
  }
  if (!managed) {
    if (typed) {
      throw new BatchPostingError(
        `Material ${input.materialNumber} is not batch-managed. No stock was posted.`,
        'Leave the batch empty.',
      );
    }
    return '';
  }
  if (!typed) {
    throw new BatchPostingError(
      `Material ${input.materialNumber} is batch-managed. A batch is required. No stock was posted.`,
      'Create the batch in MSC1N, then enter that number. This posting does not create a batch.',
    );
  }
  const rows = await tx.execute(sql`
    select batch_number, restricted_use, shelf_life_expiration_date from batch
    where client = ${input.client}
      and material_number = ${input.materialNumber}
      and batch_number = ${typed}
      and batch_level_at_creation = ${code}
      and ((${code} = '0' and plant = ${input.plant}) or (${code} <> '0' and plant is null))
    limit 1
  `) as unknown as Array<{ batch_number: string; restricted_use: string | null; shelf_life_expiration_date: string | null }>;
  if (!rows[0]) {
    throw new BatchPostingError(
      `Batch ${typed} does not stand for material ${input.materialNumber}. No stock was posted.`,
      'Create the batch in MSC1N first. This posting does not create a batch.',
    );
  }
  const statusRow = await tx.select({ code: batchStatusManagement.statusManagement })
    .from(batchStatusManagement)
    .where(eq(batchStatusManagement.client, input.client))
    .limit(1);
  const active = statusRow[0]?.code?.trim() === '1';
  const plantSelected = code === '0' ? await readPlantBatchStatusActive(tx, input.client, input.plant) : false;
  const scope = batchStatusScope({ batchLevel: code, active, plantSelected });
  if (scope.effective && rows[0].restricted_use?.trim() === 'X') {
    throw new BatchPostingError(
      `Batch ${typed} is restricted. No stock was posted.`,
      'Movements 341 and 342 are not available. This posting does not move restricted stock.',
    );
  }
  const postingDate = (input.postingDate ?? '').trim();
  const expiry = rows[0].shelf_life_expiration_date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(postingDate) && expiry && expiry < postingDate) {
    throw new BatchPostingError(
      `Batch ${rows[0].batch_number} expired on ${expiry}. No stock was posted.`,
      'The shelf-life expiration date is before the posting date. This posting does not extend it.',
    );
  }
  return rows[0].batch_number;
}
