import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  ACTIVITY,
  ALIAS,
  APPLICATION,
  BatchStrategyTypeError,
  NOT_EXECUTED,
  USAGE,
  deleteBatchStrategyType,
  listBatchStrategyTypes,
  saveBatchStrategyType,
} from '../src/modules/inventory/batch-strategy-type';
import { GoodsIssueError, postGoodsIssue } from '../src/modules/inventory/goods-issue';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMCW_TEST';
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

function save(client: string, strategyType: string, description: string, mode: 'CREATE' | 'CHANGE' = 'CREATE', expectedVersion?: number) {
  return saveBatchStrategyType({
    client,
    changedBy: ACTOR,
    capabilities: AUTH,
    mode,
    strategyType,
    description,
    expectedVersion,
    confirmed: true,
    reason: 'Strategy type for the test',
  });
}

async function counts(client: string) {
  const rows = await withTenant(client, (tx) => tx.execute(sql`
    select
      (select count(*) from material_document where client = ${client})::int as documents,
      (select count(*) from stock_quantity where client = ${client})::int as stock,
      (select count(*) from journal_entry where client = ${client})::int as journals,
      (select count(*) from batch_strategy_type where client = ${client})::int as strategies
  `)) as unknown as Array<{ documents: number; stock: number; journals: number; strategies: number }>;
  return rows[0];
}

describe('OMCW Inventory Management strategy types', () => {
  it('stores usage H and application ME, and refuses a control that cannot select a batch', async () => {
    const client = await tenant('omcw-save');
    expect(ACTIVITY).toBe('CFG.INV.BATCHSTRATEGY.DEFINE');
    expect(ALIAS).toBe('OMCW');
    expect(USAGE).toBe('H');
    expect(APPLICATION).toBe('ME');
    expect(NOT_EXECUTED.map((item) => item.field)).toContain('CHMVS');
    expect(NOT_EXECUTED.map((item) => item.field)).toContain('CLASS_SEL');

    const before = await counts(client);
    expect(await listBatchStrategyTypes(client)).toEqual([]);
    expect(await counts(client)).toEqual(before);

    await expect(saveBatchStrategyType({
      client, changedBy: ACTOR, capabilities: [], mode: 'CREATE', strategyType: 'ME01',
      description: 'Issue search', confirmed: true, reason: 'No authority',
    })).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    await expect(save(client, 'TOO-LONG', 'Issue search')).rejects.toBeInstanceOf(BatchStrategyTypeError);
    await expect(save(client, 'ME01', 'This description is far too long')).rejects.toMatchObject({ code: 'DESCRIPTION_REQUIRED' });
    await expect(saveBatchStrategyType({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', strategyType: 'ME01',
      description: 'Issue search', confirmed: true, reason: 'Access sequence is not here',
      accessSequence: 'ME01',
    })).rejects.toMatchObject({ code: 'ACCESS_UNKNOWN' });
    await expect(saveBatchStrategyType({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', strategyType: 'ME01',
      description: 'Issue search', confirmed: true, reason: 'Production is not this screen',
      application: 'CO',
    })).rejects.toMatchObject({ code: 'SCOPE_REFUSED' });
    expect(await counts(client)).toEqual(before);

    const created = await save(client, 'me01', 'Issue search');
    expect(created).toMatchObject({ strategyType: 'ME01', description: 'Issue search', usage: 'H', application: 'ME', version: 1 });
    await expect(save(client, 'ME01', 'Again')).rejects.toMatchObject({ code: 'DUPLICATE' });

    const other = await tenant('omcw-other');
    await save(other, 'ME01', 'Other client');
    expect((await listBatchStrategyTypes(client)).map((row) => row.description)).toEqual(['Issue search']);

    await withTenant(client, (tx) => tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
      values (${client}, '4900000091', 2026, '2026-10-23', '2026-10-23', 'POSTED', ${ACTOR})
    `));
    const changed = await save(client, 'ME01', 'Issue only', 'CHANGE', 1);
    expect(changed.version).toBe(2);
    const document = await withTenant(client, (tx) => tx.execute(sql`
      select status from material_document where client = ${client} and material_document_number = '4900000091'
    `)) as unknown as Array<{ status: string }>;
    expect(document).toEqual([{ status: 'POSTED' }]);

    await deleteBatchStrategyType({
      client, changedBy: ACTOR, capabilities: AUTH, strategyType: 'ME01', expectedVersion: 2,
      confirmed: true, reason: 'Remove the unused type',
    });
    expect(await listBatchStrategyTypes(client)).toEqual([]);
    expect(document).toEqual([{ status: 'POSTED' }]);
  });

  it('does not propose a batch when a strategy type stands', async () => {
    const client = await tenant('omcw-post');
    await save(client, 'Z001', 'No proposal');
    const before = await counts(client);
    const result = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '201', postingDate: '2026-10-23', documentDate: '2026-10-23',
      requestKey: 'omcw-gi', lines: [{ materialNumber: 'NO-MAT', plant: '1000', quantity: 1, batch: '' }],
    }).then(() => 'posted').catch((error: unknown) => error);
    expect(result).toBeInstanceOf(GoodsIssueError);
    expect((result as Error).message).not.toMatch(/strategy type|batch determination|proposed/i);
    const after = await counts(client);
    expect(after.documents).toBe(before.documents);
    expect(after.stock).toBe(before.stock);
    expect(after.journals).toBe(before.journals);
    expect(after.strategies).toBe(1);
  });

  it('does not store the determination controls or call them from a goods movement', async () => {
    const service = readFileSync('src/modules/inventory/batch-strategy-type.ts', 'utf8');
    expect(service).not.toContain('chmvs');
    expect(service).not.toContain('class_sel');
    const page = readFileSync('src/app/config/batch-strategy-types/page.tsx', 'utf8');
    expect(page).toContain('Not executed');
    expect(page).not.toContain('name="quantityProposal"');
    for (const file of [
      'src/modules/inventory/goods-issue.ts',
      'src/modules/inventory/transfer-posting.ts',
      'src/modules/inventory/production-receipt.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('batch-strategy-type');
    }
    const client = await tenant('omcw-columns');
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'batch_strategy_type'
        and column_name in ('strategy_type', 'access_sequence', 'class_sel', 'chmvs', 'chasp')
    `)) as unknown as Array<{ column_name: string }>;
    expect(columns.map((row) => row.column_name).sort()).toEqual(['access_sequence', 'strategy_type']);
  });
});
