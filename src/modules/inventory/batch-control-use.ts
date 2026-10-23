/**
 * Readers for batch settings that already stand.
 *
 * A goods movement consults the allocation check and any released sort
 * sequence. The check is not performed. The sequence is not applied. No
 * batch is selected, rejected, or sorted, and no class is assigned.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx } from '../../platform/db/client';
import { batchSearchAllocation, batchSortSequence } from './schema';

export interface BatchControlUse {
  checkRequested: boolean;
  checkExecuted: false;
  procedure: string | null;
  sortApplied: false;
  sortSequences: string[];
  classAssigned: false;
  wipBatchCreated: false;
}

export async function noteBatchControlUse(
  tx: Tx,
  client: string,
  documentNumber: string,
  changedBy: string,
): Promise<BatchControlUse> {
  const posted = await tx.execute(sql`
    select distinct movement_type
      from material_document_line
     where client = ${client} and material_document_number = ${documentNumber}
  `) as unknown as Array<{ movement_type: string }>;
  const types = posted.map((row) => row.movement_type).filter(Boolean);
  let checkRequested = false;
  let procedure: string | null = null;
  if (types.length > 0) {
    const allocations = await tx.select({
      checkBatch: batchSearchAllocation.checkBatch,
      searchProcedure: batchSearchAllocation.searchProcedure,
    }).from(batchSearchAllocation).where(and(
      eq(batchSearchAllocation.client, client),
      inArray(batchSearchAllocation.movementType, types),
      eq(batchSearchAllocation.specialStock, ' '),
    ));
    const hit = allocations.find((row) => row.checkBatch === 'X');
    if (hit) {
      checkRequested = true;
      procedure = hit.searchProcedure;
    }
  }
  const sequences = await tx.select({
    sortSequence: batchSortSequence.sortSequence,
    status: batchSortSequence.status,
  }).from(batchSortSequence).where(eq(batchSortSequence.client, client));
  const released = sequences.filter((row) => row.status === '1').map((row) => row.sortSequence);
  const use: BatchControlUse = {
    checkRequested,
    checkExecuted: false,
    procedure,
    sortApplied: false,
    sortSequences: released,
    classAssigned: false,
    wipBatchCreated: false,
  };
  if (checkRequested || released.length > 0) {
    await recordChange(tx, {
      client,
      objectClass: 'material_document',
      objectKey: documentNumber,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: checkRequested ? 'OMCG' : 'CU70',
      reason: checkRequested
        ? 'A batch check was requested. It was not performed. No batch was selected or rejected.'
        : 'A released sort sequence stands. It was not applied. No batch was sorted.',
      before: { batchCheck: ' ', sortApplied: ' ' },
      after: {
        batchCheck: checkRequested ? 'REQUESTED_NOT_EXECUTED' : ' ',
        sortApplied: released.length > 0 ? 'NOT_APPLIED' : ' ',
        procedure: procedure ?? '',
        sortSequences: released.join(','),
      },
    });
  }
  return use;
}
