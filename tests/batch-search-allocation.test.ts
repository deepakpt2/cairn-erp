import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  ACTIVITY,
  ALIAS,
  APPLICATION,
  NOT_EXECUTED,
  USAGE,
  checkEnteredBatch,
  deleteBatchSearchAllocation,
  listBatchSearchAllocations,
  resolveBatchSearchAllocation,
  saveBatchSearchAllocation,
} from '../src/modules/inventory/batch-search-allocation';
import { deleteBatchSearchProcedure, saveBatchSearchProcedure } from '../src/modules/inventory/batch-search-procedure';
import { deleteMovementType } from '../src/modules/inventory/movement-type-configuration';
import { GoodsIssueError, postGoodsIssue } from '../src/modules/inventory/goods-issue';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMCG_TEST';
const AUTH = [ACTIVITY];
const PROCEDURE = ['CFG.INV.BATCHSEARCH.DEFINE'];
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function tenant(seed: string): Promise<string> {
  const created = await createTenant(seed);
  clients.push(created.client);
  return created.client;
}

async function movement(client: string, code: string) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
    values (${client}, ${code}, ${`Movement ${code}`}, 'ISSUE', 'MATERIAL_DOCUMENT', ${ACTOR})
  `));
}

function procedure(client: string, searchProcedure: string) {
  return saveBatchSearchProcedure({
    client, changedBy: ACTOR, capabilities: PROCEDURE, mode: 'CREATE', searchProcedure,
    description: 'Issue procedure', confirmed: true, reason: 'Procedure for the allocation test',
  });
}

function save(client: string, movementType: string, searchProcedure: string, extra: Record<string, unknown> = {}) {
  return saveBatchSearchAllocation({
    client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', movementType, searchProcedure,
    confirmed: true, reason: 'Allocate the procedure', ...extra,
  });
}

describe('OMCG Inventory Management search allocation', () => {
  it('allocates a standing procedure to own stock and does not fall back', async () => {
    const client = await tenant('omcg-save');
    expect(ACTIVITY).toBe('CFG.INV.BATCHALLOCATE.DEFINE');
    expect(ALIAS).toBe('OMCG');
    expect(USAGE).toBe('H');
    expect(APPLICATION).toBe('ME');
    expect(NOT_EXECUTED.map((item) => item.field)).toEqual(['KZCHP', 'WERKS', 'UMCHP', 'MBC1']);
    expect(await listBatchSearchAllocations(client)).toEqual([]);

    await movement(client, '201');
    await movement(client, '301');
    await procedure(client, 'Z00001');
    await procedure(client, 'Z00002');
    const other = await tenant('omcg-other');
    await procedure(other, 'Z00009');
    await movement(other, '309');

    await expect(saveBatchSearchAllocation({
      client, changedBy: ACTOR, capabilities: [], mode: 'CREATE', movementType: '201', searchProcedure: 'Z00001',
      confirmed: true, reason: 'No authority',
    })).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    await expect(save(client, '309', 'Z00001')).rejects.toMatchObject({ code: 'MOVEMENT_UNKNOWN' });
    await expect(save(client, '201', 'Z00009')).rejects.toMatchObject({ code: 'PROCEDURE_UNKNOWN' });
    await expect(save(client, '201', 'Z00001', { plant: '1000' })).rejects.toMatchObject({ code: 'PLANT_REFUSED' });
    await expect(save(client, '201', 'Z00001', { specialStock: 'K' })).rejects.toMatchObject({ code: 'STOCK_UNKNOWN' });
    await expect(save(client, '201', 'Z00001', { application: 'CO' })).rejects.toMatchObject({ code: 'SCOPE_REFUSED' });
    await expect(save(client, '201', 'Z00001', { checkBatch: 'Y' })).rejects.toMatchObject({ code: 'CHECK_UNKNOWN' });
    await expect(save(client, '201', 'Z00001', { transferCheck: 'X' })).rejects.toMatchObject({ code: 'CONTROL_REFUSED' });
    expect(await listBatchSearchAllocations(client)).toEqual([]);

    const created = await save(client, '201', 'z00001', { transferProcedure: 'z00002', checkBatch: 'X' });
    expect(created).toMatchObject({
      movementType: '201', specialStock: ' ', searchProcedure: 'Z00001', transferProcedure: 'Z00002', checkBatch: 'X', version: 1,
    });
    await expect(save(client, '201', 'Z00001')).rejects.toMatchObject({ code: 'DUPLICATE' });
    await expect(saveBatchSearchAllocation({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CHANGE', movementType: '201', searchProcedure: 'Z00002',
      expectedVersion: 4, confirmed: true, reason: 'Stale',
    })).rejects.toMatchObject({ code: 'VERSION_STALE' });

    const resolved = await resolveBatchSearchAllocation(client, '201');
    expect(resolved?.searchProcedure).toBe('Z00001');
    expect(await resolveBatchSearchAllocation(client, '201', 'K')).toBeNull();
    expect(await resolveBatchSearchAllocation(client, '301')).toBeNull();
    expect(await resolveBatchSearchAllocation(other, '201')).toBeNull();

    await expect(deleteBatchSearchProcedure({
      client, changedBy: ACTOR, capabilities: PROCEDURE, searchProcedure: 'Z00002', expectedVersion: 1,
      confirmed: true, reason: 'A cited procedure stays',
    })).rejects.toMatchObject({ code: 'CITED' });
    await expect(deleteMovementType({
      client, changedBy: ACTOR, movementType: '201', reason: 'A cited movement stays',
    })).rejects.toThrow(/search allocation/);

    await withTenant(client, (tx) => tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
      values (${client}, '4900000096', 2026, '2026-10-23', '2026-10-23', 'POSTED', ${ACTOR})
    `));
    await expect(checkEnteredBatch({ client, movementType: '201', batch: 'BATCH1' })).rejects.toMatchObject({ code: 'CHECK_NOT_EXECUTED' });
    const document = await withTenant(client, (tx) => tx.execute(sql`
      select status from material_document where client = ${client} and material_document_number = '4900000096'
    `)) as unknown as Array<{ status: string }>;
    expect(document).toEqual([{ status: 'POSTED' }]);

    await deleteBatchSearchAllocation({
      client, changedBy: ACTOR, capabilities: AUTH, movementType: '201', expectedVersion: 1,
      confirmed: true, reason: 'Remove the allocation',
    });
    expect(await resolveBatchSearchAllocation(client, '201')).toBeNull();
    await deleteBatchSearchProcedure({
      client, changedBy: ACTOR, capabilities: PROCEDURE, searchProcedure: 'Z00001', expectedVersion: 1,
      confirmed: true, reason: 'The allocation is gone',
    });
    await deleteMovementType({ client, changedBy: ACTOR, movementType: '201', reason: 'The allocation is gone' });
    expect(document).toEqual([{ status: 'POSTED' }]);
  });

  it('does not select a batch when a movement type has an allocation', async () => {
    const client = await tenant('omcg-post');
    await movement(client, '201');
    await procedure(client, 'Z00001');
    await save(client, '201', 'Z00001', { checkBatch: 'X' });
    const before = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*) from material_document where client = ${client})::int as documents,
        (select count(*) from stock_quantity where client = ${client})::int as stock,
        (select count(*) from batch_search_allocation where client = ${client})::int as allocations
    `)) as unknown as Array<{ documents: number; stock: number; allocations: number }>;
    const result = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '201', postingDate: '2026-10-23', documentDate: '2026-10-23',
      requestKey: 'omcg-gi', lines: [{ materialNumber: 'NO-MAT', plant: '1000', quantity: 1, batch: 'BATCH1' }],
    }).then(() => 'posted').catch((error: unknown) => error);
    expect(result).toBeInstanceOf(GoodsIssueError);
    expect((result as Error).message).not.toMatch(/search procedure|batch determination|proposed/i);
    const after = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*) from material_document where client = ${client})::int as documents,
        (select count(*) from stock_quantity where client = ${client})::int as stock,
        (select count(*) from batch_search_allocation where client = ${client})::int as allocations
    `)) as unknown as Array<{ documents: number; stock: number; allocations: number }>;
    expect(after[0]).toEqual(before[0]);
    await deleteBatchSearchAllocation({
      client, changedBy: ACTOR, capabilities: AUTH, movementType: '201', expectedVersion: 1,
      confirmed: true, reason: 'Leave nothing behind',
    });
  });

  it('does not store a plant or call the allocation from a goods movement', async () => {
    const service = readFileSync('src/modules/inventory/batch-search-allocation.ts', 'utf8');
    expect(service).not.toContain('fifo');
    expect(service).not.toContain('fefo');
    const page = readFileSync('src/app/config/batch-search-allocations/page.tsx', 'utf8');
    expect(page).toContain('Not executed');
    expect(page).not.toContain('name="plant"');
    for (const file of [
      'src/modules/inventory/goods-issue.ts',
      'src/modules/inventory/transfer-posting.ts',
      'src/modules/inventory/production-receipt.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('batch-search-allocation');
    }
    const client = await tenant('omcg-columns');
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'batch_search_allocation'
        and column_name in ('movement_type', 'special_stock', 'search_procedure', 'transfer_procedure', 'check_batch', 'plant', 'umchp')
    `)) as unknown as Array<{ column_name: string }>;
    expect(columns.map((row) => row.column_name).sort()).toEqual([
      'check_batch', 'movement_type', 'search_procedure', 'special_stock', 'transfer_procedure',
    ]);
  });
});
