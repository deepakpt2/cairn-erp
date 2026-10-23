import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  ACTIVITY,
  ALIAS,
  APPLICATION,
  BatchAccessSequenceError,
  NOT_EXECUTED,
  USAGE,
  deleteBatchAccessSequence,
  listBatchAccessSequences,
  saveBatchAccessSequence,
} from '../src/modules/inventory/batch-access-sequence';
import { saveBatchStrategyType } from '../src/modules/inventory/batch-strategy-type';
import { GoodsIssueError, postGoodsIssue } from '../src/modules/inventory/goods-issue';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMCX_TEST';
const AUTH = [ACTIVITY];
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

function save(client: string, accessSequence: string, description: string, mode: 'CREATE' | 'CHANGE' = 'CREATE', expectedVersion?: number) {
  return saveBatchAccessSequence({
    client,
    changedBy: ACTOR,
    capabilities: AUTH,
    mode,
    accessSequence,
    description,
    expectedVersion,
    confirmed: true,
    reason: 'Access sequence for the test',
  });
}

async function counts(client: string) {
  const rows = await withTenant(client, (tx) => tx.execute(sql`
    select
      (select count(*) from material_document where client = ${client})::int as documents,
      (select count(*) from stock_quantity where client = ${client})::int as stock,
      (select count(*) from journal_entry where client = ${client})::int as journals,
      (select count(*) from batch_access_sequence where client = ${client})::int as sequences,
      (select count(*) from batch_strategy_type where client = ${client})::int as strategies
  `)) as unknown as Array<{ documents: number; stock: number; journals: number; sequences: number; strategies: number }>;
  return rows[0];
}

describe('OMCX Inventory Management access sequences', () => {
  it('stores usage H and application ME, and refuses a step that cannot run', async () => {
    const client = await tenant('omcx-save');
    expect(ACTIVITY).toBe('CFG.INV.BATCHACCESS.DEFINE');
    expect(ALIAS).toBe('OMCX');
    expect(USAGE).toBe('H');
    expect(APPLICATION).toBe('ME');
    expect(NOT_EXECUTED.map((item) => item.field)).toEqual(['KZEXL', 'KOBED', 'T682Z']);

    const before = await counts(client);
    expect(await listBatchAccessSequences(client)).toEqual([]);
    expect(await counts(client)).toEqual(before);

    await expect(saveBatchAccessSequence({
      client, changedBy: ACTOR, capabilities: [], mode: 'CREATE', accessSequence: 'ME01',
      description: 'Issue access', confirmed: true, reason: 'No authority',
    })).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    await expect(save(client, 'TOO-LONG', 'Issue access')).rejects.toBeInstanceOf(BatchAccessSequenceError);
    await expect(save(client, 'ME01', 'This description is thirty-one chars')).rejects.toMatchObject({ code: 'DESCRIPTION_REQUIRED' });
    await expect(saveBatchAccessSequence({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', accessSequence: 'ME01',
      description: 'Issue access', confirmed: true, reason: 'A condition table does not stand',
      conditionTable: '001', accessNumber: '01', exclusive: 'X',
    })).rejects.toMatchObject({ code: 'STEP_REFUSED' });
    await expect(saveBatchAccessSequence({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', accessSequence: 'ME01',
      description: 'Issue access', confirmed: true, reason: 'Production is not this screen',
      application: 'CO',
    })).rejects.toMatchObject({ code: 'SCOPE_REFUSED' });
    await expect(saveBatchAccessSequence({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', accessSequence: 'ME01',
      description: 'Issue access', confirmed: true, reason: 'A plant is not this screen',
      plant: '1000',
    })).rejects.toMatchObject({ code: 'PLANT_REFUSED' });
    await expect(saveBatchAccessSequence({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', accessSequence: 'ME01',
      description: 'Issue access', confirmed: true, reason: 'No transport is written',
      transportRequest: 'DEVK900001',
    })).rejects.toMatchObject({ code: 'TRANSPORT_REFUSED' });
    expect(await counts(client)).toEqual(before);

    const created = await save(client, 'me01', 'Issue access');
    expect(created).toMatchObject({ accessSequence: 'ME01', description: 'Issue access', usage: 'H', application: 'ME', version: 1 });
    await expect(save(client, 'ME01', 'Again')).rejects.toMatchObject({ code: 'DUPLICATE' });

    const other = await tenant('omcx-other');
    await save(other, 'ME02', 'Other client');
    expect((await listBatchAccessSequences(client)).map((row) => row.description)).toEqual(['Issue access']);
    await expect(saveBatchStrategyType({
      client, changedBy: ACTOR, capabilities: ['CFG.INV.BATCHSTRATEGY.DEFINE'], mode: 'CREATE',
      strategyType: 'Z008', description: 'Other tenant', accessSequence: 'ME02',
      confirmed: true, reason: 'Another client is not visible',
    })).rejects.toMatchObject({ code: 'ACCESS_UNKNOWN' });
    await expect(saveBatchStrategyType({
      client, changedBy: ACTOR, capabilities: ['CFG.INV.BATCHSTRATEGY.DEFINE'], mode: 'CREATE',
      strategyType: 'Z009', description: 'Other sequence', accessSequence: 'NOPE',
      confirmed: true, reason: 'An unknown sequence is not stored',
    })).rejects.toMatchObject({ code: 'ACCESS_UNKNOWN' });

    await withTenant(client, (tx) => tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
      values (${client}, '4900000092', 2026, '2026-10-23', '2026-10-23', 'POSTED', ${ACTOR})
    `));
    const changed = await save(client, 'ME01', 'Issue only', 'CHANGE', 1);
    expect(changed.version).toBe(2);
    const document = await withTenant(client, (tx) => tx.execute(sql`
      select status from material_document where client = ${client} and material_document_number = '4900000092'
    `)) as unknown as Array<{ status: string }>;
    expect(document).toEqual([{ status: 'POSTED' }]);

    await expect(saveBatchStrategyType({
      client, changedBy: ACTOR, capabilities: ['CFG.INV.BATCHSTRATEGY.DEFINE'], mode: 'CREATE',
      strategyType: 'Z001', description: 'Uses the sequence', accessSequence: 'ME01',
      confirmed: true, reason: 'Name a standing sequence',
    })).resolves.toMatchObject({ strategyType: 'Z001', accessSequence: 'ME01' });
    await expect(deleteBatchAccessSequence({
      client, changedBy: ACTOR, capabilities: AUTH, accessSequence: 'ME01', expectedVersion: 2,
      confirmed: true, reason: 'Remove a cited sequence',
    })).rejects.toMatchObject({ code: 'CITED' });
    expect((await listBatchAccessSequences(client)).map((row) => row.accessSequence)).toEqual(['ME01']);
    expect(document).toEqual([{ status: 'POSTED' }]);
  });

  it('does not propose a batch when a sequence is named by a strategy type', async () => {
    const client = await tenant('omcx-post');
    await save(client, 'Z001', 'No proposal');
    await saveBatchStrategyType({
      client, changedBy: ACTOR, capabilities: ['CFG.INV.BATCHSTRATEGY.DEFINE'], mode: 'CREATE',
      strategyType: 'Z001', description: 'Names the sequence', accessSequence: 'Z001',
      confirmed: true, reason: 'Reference does not run an access',
    });
    const before = await counts(client);
    const result = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '201', postingDate: '2026-10-23', documentDate: '2026-10-23',
      requestKey: 'omcx-gi', lines: [{ materialNumber: 'NO-MAT', plant: '1000', quantity: 1, batch: '' }],
    }).then(() => 'posted').catch((error: unknown) => error);
    expect(result).toBeInstanceOf(GoodsIssueError);
    expect((result as Error).message).not.toMatch(/access sequence|batch determination|proposed/i);
    const after = await counts(client);
    expect(after.documents).toBe(before.documents);
    expect(after.stock).toBe(before.stock);
    expect(after.journals).toBe(before.journals);
    expect(after.sequences).toBe(1);
    expect(after.strategies).toBe(1);
  });

  it('does not store an exclusive indicator on the header or call the sequence from a goods movement', async () => {
    const service = readFileSync('src/modules/inventory/batch-access-sequence.ts', 'utf8');
    expect(service).not.toContain('kotabnr');
    expect(service).not.toContain('kzexl');
    const page = readFileSync('src/app/config/batch-access-sequences/page.tsx', 'utf8');
    expect(page).toContain('Not executed');
    expect(page).not.toContain('name="conditionTable"');
    for (const file of [
      'src/modules/inventory/goods-issue.ts',
      'src/modules/inventory/transfer-posting.ts',
      'src/modules/inventory/production-receipt.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('batch-access-sequence');
    }
    const client = await tenant('omcx-columns');
    const tables = await withTenant(client, (tx) => tx.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('batch_access_sequence', 'batch_access_step')
    `)) as unknown as Array<{ table_name: string }>;
    expect(tables.map((row) => row.table_name).sort()).toEqual(['batch_access_sequence', 'batch_access_step']);
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'batch_access_sequence'
        and column_name in ('access_sequence', 'description', 'kolnr', 'kotabnr', 'kzexl')
    `)) as unknown as Array<{ column_name: string }>;
    expect(columns.map((row) => row.column_name).sort()).toEqual(['access_sequence', 'description']);
  });
});
