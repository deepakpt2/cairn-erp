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
  deleteBatchSearchProcedure,
  deleteBatchSearchProcedureStep,
  listBatchSearchProcedures,
  listBatchSearchProcedureSteps,
  saveBatchSearchProcedure,
  saveBatchSearchProcedureStep,
} from '../src/modules/inventory/batch-search-procedure';
import { deleteBatchStrategyType, saveBatchStrategyType } from '../src/modules/inventory/batch-strategy-type';
import { GoodsIssueError, postGoodsIssue } from '../src/modules/inventory/goods-issue';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMCY_TEST';
const AUTH = [ACTIVITY];
const STRATEGY = ['CFG.INV.BATCHSTRATEGY.DEFINE'];
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

function save(client: string, searchProcedure: string, description: string, mode: 'CREATE' | 'CHANGE' = 'CREATE', expectedVersion?: number) {
  return saveBatchSearchProcedure({
    client, changedBy: ACTOR, capabilities: AUTH, mode, searchProcedure, description, expectedVersion,
    confirmed: true, reason: 'Search procedure for the test',
  });
}

async function strategy(client: string, strategyType: string) {
  return saveBatchStrategyType({
    client, changedBy: ACTOR, capabilities: STRATEGY, mode: 'CREATE', strategyType,
    description: 'Issue type', confirmed: true, reason: 'Strategy type for the procedure test',
  });
}

describe('OMCY Inventory Management search procedures', () => {
  it('stores usage H and application ME, and a step that names a standing strategy type', async () => {
    const client = await tenant('omcy-save');
    expect(ACTIVITY).toBe('CFG.INV.BATCHSEARCH.DEFINE');
    expect(ALIAS).toBe('OMCY');
    expect(USAGE).toBe('H');
    expect(APPLICATION).toBe('ME');
    expect(NOT_EXECUTED.map((item) => item.field)).toEqual(['KOBED', 'KAUTO', 'OMCG']);

    const before = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as procedures from batch_search_procedure where client = ${client}
    `)) as unknown as Array<{ procedures: number }>;
    expect(await listBatchSearchProcedures(client)).toEqual([]);
    expect(before[0]?.procedures).toBe(0);

    await expect(saveBatchSearchProcedure({
      client, changedBy: ACTOR, capabilities: [], mode: 'CREATE', searchProcedure: 'Z00001',
      description: 'Issue procedure', confirmed: true, reason: 'No authority',
    })).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    await expect(save(client, 'TOO-LONG', 'Issue procedure')).rejects.toMatchObject({ code: 'KEY_UNKNOWN' });
    await expect(save(client, 'Z00001', 'This description is thirty-one chars')).rejects.toMatchObject({ code: 'DESCRIPTION_REQUIRED' });
    await expect(saveBatchSearchProcedure({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', searchProcedure: 'Z00001',
      description: 'Issue procedure', confirmed: true, reason: 'A movement type is not here',
      movementType: '201', requirement: '001',
    })).rejects.toMatchObject({ code: 'STEP_REFUSED' });
    await expect(saveBatchSearchProcedure({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', searchProcedure: 'Z00001',
      description: 'Issue procedure', confirmed: true, reason: 'Production is not this screen', application: 'CO',
    })).rejects.toMatchObject({ code: 'SCOPE_REFUSED' });
    expect(await listBatchSearchProcedures(client)).toEqual([]);

    const created = await save(client, 'z00001', 'Issue procedure');
    expect(created).toMatchObject({ searchProcedure: 'Z00001', description: 'Issue procedure', usage: 'H', application: 'ME', version: 1 });
    await expect(save(client, 'Z00001', 'Again')).rejects.toMatchObject({ code: 'DUPLICATE' });
    await strategy(client, 'ME01');
    await strategy(client, 'ME02');

    const other = await tenant('omcy-other');
    await strategy(other, 'ME09');
    await expect(saveBatchSearchProcedureStep({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', searchProcedure: 'Z00001',
      stepNumber: '001', counter: '01', strategyType: 'ME09', expectedVersion: 1, confirmed: true, reason: 'Another client is not visible',
    })).rejects.toMatchObject({ code: 'STRATEGY_UNKNOWN' });
    await expect(saveBatchSearchProcedureStep({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', searchProcedure: 'Z00001',
      stepNumber: '1000', counter: '01', strategyType: 'ME01', expectedVersion: 1, confirmed: true, reason: 'Four digits',
    })).rejects.toMatchObject({ code: 'STEP_UNKNOWN' });
    await expect(saveBatchSearchProcedureStep({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', searchProcedure: 'Z00001',
      stepNumber: '010', counter: '1', strategyType: 'ME01', expectedVersion: 1, confirmed: true, reason: 'A movement type is not a step',
      movementType: '201',
    })).rejects.toMatchObject({ code: 'STEP_REFUSED' });

    const step = await saveBatchSearchProcedureStep({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', searchProcedure: 'Z00001',
      stepNumber: '10', counter: '1', strategyType: 'me01', expectedVersion: 1, confirmed: true, reason: 'A gap is allowed',
    });
    expect(step).toMatchObject({ searchProcedure: 'Z00001', stepNumber: '010', counter: '01', strategyType: 'ME01', procedureVersion: 2 });
    await expect(saveBatchSearchProcedureStep({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', searchProcedure: 'Z00001',
      stepNumber: '010', counter: '01', strategyType: 'ME02', expectedVersion: 2, confirmed: true, reason: 'Same step',
    })).rejects.toMatchObject({ code: 'STEP_DUPLICATE' });

    await withTenant(client, (tx) => tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
      values (${client}, '4900000095', 2026, '2026-10-23', '2026-10-23', 'POSTED', ${ACTOR})
    `));
    await expect(deleteBatchStrategyType({
      client, changedBy: ACTOR, capabilities: STRATEGY, strategyType: 'ME01', expectedVersion: 1,
      confirmed: true, reason: 'A cited type stays',
    })).rejects.toMatchObject({ code: 'CITED' });
    const document = await withTenant(client, (tx) => tx.execute(sql`
      select status from material_document where client = ${client} and material_document_number = '4900000095'
    `)) as unknown as Array<{ status: string }>;
    expect(document).toEqual([{ status: 'POSTED' }]);

    await deleteBatchSearchProcedureStep({
      client, changedBy: ACTOR, capabilities: AUTH, searchProcedure: 'Z00001', stepNumber: '010', counter: '01',
      expectedVersion: 2, confirmed: true, reason: 'Remove the step',
    });
    expect(await listBatchSearchProcedureSteps(client, 'Z00001')).toEqual([]);
    await deleteBatchStrategyType({
      client, changedBy: ACTOR, capabilities: STRATEGY, strategyType: 'ME01', expectedVersion: 1,
      confirmed: true, reason: 'The step is gone',
    });
    await deleteBatchSearchProcedure({
      client, changedBy: ACTOR, capabilities: AUTH, searchProcedure: 'Z00001', expectedVersion: 3,
      confirmed: true, reason: 'Remove the unused procedure',
    });
    expect(await listBatchSearchProcedures(client)).toEqual([]);
    expect(document).toEqual([{ status: 'POSTED' }]);
  });

  it('does not propose a batch when a procedure names a strategy type', async () => {
    const client = await tenant('omcy-post');
    await save(client, 'Z00001', 'No proposal');
    await strategy(client, 'Z001');
    await saveBatchSearchProcedureStep({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', searchProcedure: 'Z00001',
      stepNumber: '001', counter: '01', strategyType: 'Z001', expectedVersion: 1, confirmed: true, reason: 'Name the type',
    });
    const before = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*) from material_document where client = ${client})::int as documents,
        (select count(*) from stock_quantity where client = ${client})::int as stock,
        (select count(*) from batch_search_procedure_step where client = ${client})::int as steps
    `)) as unknown as Array<{ documents: number; stock: number; steps: number }>;
    const result = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '201', postingDate: '2026-10-23', documentDate: '2026-10-23',
      requestKey: 'omcy-gi', lines: [{ materialNumber: 'NO-MAT', plant: '1000', quantity: 1, batch: '' }],
    }).then(() => 'posted').catch((error: unknown) => error);
    expect(result).toBeInstanceOf(GoodsIssueError);
    expect((result as Error).message).not.toMatch(/search procedure|batch determination|proposed/i);
    const after = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*) from material_document where client = ${client})::int as documents,
        (select count(*) from stock_quantity where client = ${client})::int as stock,
        (select count(*) from batch_search_procedure_step where client = ${client})::int as steps
    `)) as unknown as Array<{ documents: number; stock: number; steps: number }>;
    expect(after[0]).toEqual(before[0]);
    await deleteBatchSearchProcedure({
      client, changedBy: ACTOR, capabilities: AUTH, searchProcedure: 'Z00001', expectedVersion: 2,
      confirmed: true, reason: 'Leave nothing behind',
    });
  });

  it('does not assign a movement type or call the procedure from a goods movement', async () => {
    const service = readFileSync('src/modules/inventory/batch-search-procedure.ts', 'utf8');
    expect(service).not.toContain('kobed');
    expect(service).not.toContain('movement_type');
    const page = readFileSync('src/app/config/batch-search-procedures/page.tsx', 'utf8');
    expect(page).toContain('Not executed');
    expect(page).not.toContain('name="movementType"');
    for (const file of [
      'src/modules/inventory/goods-issue.ts',
      'src/modules/inventory/transfer-posting.ts',
      'src/modules/inventory/production-receipt.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('batch-search-procedure');
    }
    const client = await tenant('omcy-columns');
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'batch_search_procedure_step'
        and column_name in ('step_number', 'counter', 'strategy_type', 'kobed', 'kauto', 'movement_type')
    `)) as unknown as Array<{ column_name: string }>;
    expect(columns.map((row) => row.column_name).sort()).toEqual(['counter', 'step_number', 'strategy_type']);
  });
});
