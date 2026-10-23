import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { noteBatchControlUse } from '../src/modules/inventory/batch-control-use';
import { checkEnteredBatch } from '../src/modules/inventory/batch-search-allocation';
import { saveBatchSearchProcedure } from '../src/modules/inventory/batch-search-procedure';
import { saveBatchSearchAllocation } from '../src/modules/inventory/batch-search-allocation';
import { withTenant } from '../src/platform/db/client';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'BATCH_CONTROL_TEST';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

describe('batch control is read and not executed', () => {
  it('records a requested check and a standing sort without selecting a batch', async () => {
    const created = await createTenant('batch-control');
    const client = created.client;
    clients.push(client);

    await withTenant(client, (tx) => tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, '201', 'Issue', 'ISSUE', 'MATERIAL_DOCUMENT', ${ACTOR})
    `));
    await saveBatchSearchProcedure({
      client, changedBy: ACTOR, capabilities: ['CFG.INV.BATCHSEARCH.DEFINE'], mode: 'CREATE',
      searchProcedure: 'Z00001', description: 'Issue procedure', confirmed: true,
      reason: 'Procedure for the control read',
    });
    await saveBatchSearchAllocation({
      client, changedBy: ACTOR, capabilities: ['CFG.INV.BATCHALLOCATE.DEFINE'], mode: 'CREATE',
      movementType: '201', searchProcedure: 'Z00001', checkBatch: 'X', confirmed: true,
      reason: 'Request the check',
    });
    await withTenant(client, (tx) => tx.execute(sql`
      insert into batch_sort_sequence (client, sort_sequence, description, status, created_by)
      values (${client}, 'LOBM_TEST', 'Test sequence', '1', ${ACTOR})
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
      values (${client}, '4900000201', 2026, '2026-10-23', '2026-10-23', 'POSTED', ${ACTOR})
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into material_document_line (
        client, material_document_number, line_number, movement_type, material_number, plant,
        stock_type, batch_number, line_direction, entry_quantity, entry_unit, base_quantity, base_unit, created_by
      ) values (
        ${client}, '4900000201', 1, '201', 'RM-CTRL', '1000',
        'UNRESTRICTED', 'B1', 'ISSUE', 1, 'PC', 1, 'PC', ${ACTOR}
      )
    `));

    await expect(checkEnteredBatch({ client, movementType: '201', batch: 'B1' })).rejects.toThrow(/not performed/);

    const use = await withTenant(client, (tx) => noteBatchControlUse(tx, client, '4900000201', ACTOR));
    expect(use).toMatchObject({
      checkRequested: true,
      checkExecuted: false,
      procedure: 'Z00001',
      sortApplied: false,
      sortSequences: ['LOBM_TEST'],
      classAssigned: false,
      wipBatchCreated: false,
    });

    const written = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*) from stock_quantity where client = ${client})::int as stock,
        (select count(*) from batch where client = ${client})::int as batches,
        (select reason from change_document
          where client = ${client} and object_class = 'material_document' and object_key = '4900000201'
          order by changed_at desc limit 1) as reason
    `)) as unknown as Array<{ stock: number; batches: number; reason: string }>;
    expect(written[0]?.stock).toBe(0);
    expect(written[0]?.batches).toBe(0);
    expect(written[0]?.reason).toMatch(/not performed/);
    expect(written[0]?.reason).toMatch(/No batch was selected/);
  });
});
