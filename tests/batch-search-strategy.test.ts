import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { deleteBatchAccessStep, saveBatchAccessSequence, saveBatchAccessStep } from '../src/modules/inventory/batch-access-sequence';
import { deleteBatchConditionTable, saveBatchConditionTable } from '../src/modules/inventory/batch-condition-table';
import {
  ACTIVITY,
  ALIAS,
  APPLICATION,
  CHANGE_ALIAS,
  DISPLAY_ALIAS,
  NOT_EXECUTED,
  USAGE,
  deleteBatchSearchStrategy,
  determineBatch,
  listBatchSearchStrategies,
  resolveBatchSearchStrategy,
  saveBatchSearchStrategy,
} from '../src/modules/inventory/batch-search-strategy';
import { deleteBatchStrategyType, saveBatchStrategyType } from '../src/modules/inventory/batch-strategy-type';
import { GoodsIssueError, postGoodsIssue } from '../src/modules/inventory/goods-issue';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'MBC1_TEST';
const AUTH = [ACTIVITY];
const TABLE = ['CFG.INV.BATCHCONDTABLE.DEFINE'];
const ACCESS = ['CFG.INV.BATCHACCESS.DEFINE'];
const TYPE = ['CFG.INV.BATCHSTRATEGY.DEFINE'];
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

async function table(client: string, conditionTable: string, fields: string[]) {
  return saveBatchConditionTable({
    client, changedBy: ACTOR, capabilities: TABLE, mode: 'CREATE', conditionTable, fields,
    confirmed: true, reason: 'Condition table for the strategy test',
  });
}

async function chain(client: string) {
  await table(client, '501', ['BWART']);
  await table(client, '502', ['WERKS', 'MATNR']);
  await table(client, '503', ['SOBKZ']);
  await table(client, '504', ['KUNNR']);
  await saveBatchAccessSequence({
    client, changedBy: ACTOR, capabilities: ACCESS, mode: 'CREATE', accessSequence: 'ME01',
    description: 'Issue access', confirmed: true, reason: 'Access for the strategy test',
  });
  for (const [accessNumber, conditionTable] of [['01', '501'], ['02', '502'], ['03', '503'], ['04', '504']] as const) {
    await saveBatchAccessStep({
      client, changedBy: ACTOR, capabilities: ACCESS, mode: 'CREATE', accessSequence: 'ME01',
      accessNumber, conditionTable, expectedVersion: Number(accessNumber), confirmed: true, reason: 'Name the table',
    });
  }
  await saveBatchStrategyType({
    client, changedBy: ACTOR, capabilities: TYPE, mode: 'CREATE', strategyType: 'ME01',
    description: 'Issue type', accessSequence: 'ME01', confirmed: true, reason: 'Type for the strategy test',
  });
}

function save(client: string, conditionTable: string, keys: Record<string, string>, validFrom = '2026-10-01', validTo = '2026-10-31', extra: Record<string, unknown> = {}) {
  return saveBatchSearchStrategy({
    client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', strategyType: 'ME01', conditionTable, keys,
    validFrom, validTo, confirmed: true, reason: 'Strategy for the test', ...extra,
  });
}

describe('MBC1 Inventory Management batch search strategy', () => {
  it('stores a record for the selected key combination and does not hard-code the keys', async () => {
    const client = await tenant('mbc1-save');
    expect(ACTIVITY).toBe('INV.BATCHSTRATEGY.MAINTAIN');
    expect(ALIAS).toBe('MBC1');
    expect(CHANGE_ALIAS).toBe('MBC2');
    expect(DISPLAY_ALIAS).toBe('MBC3');
    expect(USAGE).toBe('H');
    expect(APPLICATION).toBe('ME');
    expect(NOT_EXECUTED.map((item) => item.field)).toEqual(['CLINT', 'SRTSQ', 'CHMVS', 'DETERMINATION']);
    expect(await listBatchSearchStrategies(client)).toEqual([]);
    await chain(client);
    await withTenant(client, (tx) => tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, '201', 'Issue', 'ISSUE', 'MATERIAL_DOCUMENT', ${ACTOR})
    `));

    await expect(saveBatchSearchStrategy({
      client, changedBy: ACTOR, capabilities: [], mode: 'CREATE', strategyType: 'ME01', conditionTable: '501',
      keys: { BWART: '201' }, validFrom: '2026-10-01', validTo: '2026-10-31', confirmed: true, reason: 'No authority',
    })).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    await expect(save(client, '501', {})).rejects.toMatchObject({ code: 'KEY_REQUIRED' });
    await expect(save(client, '501', { BWART: '201', MATNR: 'MAT1' })).rejects.toMatchObject({ code: 'KEY_REFUSED' });
    await expect(save(client, '501', { BWART: '201' }, '2026-10-31', '2026-10-01')).rejects.toMatchObject({ code: 'PERIOD_UNKNOWN' });
    await expect(save(client, '509', { BWART: '201' })).rejects.toMatchObject({ code: 'COMBINATION_UNKNOWN' });
    await expect(save(client, '503', { SOBKZ: 'K' })).rejects.toMatchObject({ code: 'STOCK_UNKNOWN' });
    await expect(save(client, '501', { BWART: '201' }, '2026-10-01', '2026-10-31', { sortRule: 'FEFO' })).rejects.toMatchObject({ code: 'CONTROL_REFUSED' });
    await expect(save(client, '501', { BWART: '201' }, '2026-10-01', '2026-10-31', { application: 'CO' })).rejects.toMatchObject({ code: 'SCOPE_REFUSED' });
    expect(await listBatchSearchStrategies(client)).toEqual([]);

    const created = await save(client, '501', { BWART: '201' });
    expect(created).toMatchObject({
      recordNumber: '0000000001', strategyType: 'ME01', conditionTable: '501', validFrom: '2026-10-01', validTo: '2026-10-31', version: 1,
    });
    expect(created.keys).toEqual([{ field: 'BWART', title: 'Movement type', value: '201', position: 1 }]);
    await expect(save(client, '501', { BWART: '201' }, '2026-10-15', '2026-11-15')).rejects.toMatchObject({ code: 'OVERLAP' });
    const later = await save(client, '501', { BWART: '201' }, '2026-11-01', '2026-11-30');
    expect(later.recordNumber).toBe('0000000002');

    const inside = await resolveBatchSearchStrategy({
      client, strategyType: 'ME01', conditionTable: '501', keys: { BWART: '201' }, date: '2026-10-23',
    });
    expect(inside?.recordNumber).toBe('0000000001');
    expect(await resolveBatchSearchStrategy({
      client, strategyType: 'ME01', conditionTable: '501', keys: { BWART: '201' }, date: '2026-12-01',
    })).toBeNull();
    await expect(determineBatch({
      client, strategyType: 'ME01', conditionTable: '501', keys: { BWART: '201' }, date: '2026-10-23',
    })).rejects.toMatchObject({ code: 'DETERMINATION_NOT_EXECUTED' });
    await expect(determineBatch({
      client, strategyType: 'ME01', conditionTable: '501', keys: { BWART: '201' }, date: '2026-12-01',
    })).rejects.toMatchObject({ code: 'DETERMINATION_NOT_EXECUTED' });

    const plants = await withTenant(client, (tx) => tx.execute(sql`
      select plant from plant where client = ${client} and is_active = true order by plant limit 1
    `)) as unknown as Array<{ plant: string }>;
    const plantCode = plants[0].plant;
    const types = await withTenant(client, (tx) => tx.execute(sql`
      select material_type from material_type where client = ${client} and is_active = true order by material_type limit 1
    `)) as unknown as Array<{ material_type: string }>;
    const materialType = types[0].material_type;
    await withTenant(client, (tx) => tx.execute(sql`
      insert into material (client, material_number, description, material_type, batch_managed, created_by)
      values (${client}, 'MAT1', 'Material', ${materialType}, true, ${ACTOR})
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into material (client, material_number, description, material_type, batch_managed, created_by)
      values (${client}, 'MAT2', 'Plain', ${materialType}, false, ${ACTOR})
    `));
    await withTenant(client, (tx) => tx.execute(sql`insert into business_partner (client, partner_number, name, created_by) values (${client}, 'C100', 'Customer', ${ACTOR})`));
    await withTenant(client, (tx) => tx.execute(sql`insert into bp_role (client, partner_number, role_code, created_by) values (${client}, 'C100', 'CUSTOMER', ${ACTOR})`));
    await expect(save(client, '502', { WERKS: plantCode, MATNR: 'MAT2' })).rejects.toMatchObject({ code: 'BATCH_REQUIRED' });
    const materialRecord = await save(client, '502', { WERKS: plantCode, MATNR: 'mat1' });
    expect(materialRecord.keys.map((key) => key.field)).toEqual(['WERKS', 'MATNR']);
    expect(materialRecord.keys[1]?.value).toBe('MAT1');
    await expect(save(client, '504', { KUNNR: 'NOBODY' })).rejects.toMatchObject({ code: 'KEY_UNKNOWN' });
    const customer = await save(client, '504', { KUNNR: 'c100' });
    expect(customer.keys).toEqual([{ field: 'KUNNR', title: 'Customer', value: 'C100', position: 1 }]);

    await expect(deleteBatchConditionTable({
      client, changedBy: ACTOR, capabilities: TABLE, conditionTable: '501', expectedVersion: 1,
      confirmed: true, reason: 'A cited table stays',
    })).rejects.toMatchObject({ code: 'CITED' });
    await expect(deleteBatchStrategyType({
      client, changedBy: ACTOR, capabilities: TYPE, strategyType: 'ME01', expectedVersion: 1,
      confirmed: true, reason: 'A cited type stays',
    })).rejects.toMatchObject({ code: 'CITED' });
    await expect(deleteBatchAccessStep({
      client, changedBy: ACTOR, capabilities: ACCESS, accessSequence: 'ME01', accessNumber: '01',
      expectedVersion: 5, confirmed: true, reason: 'A cited access stays',
    })).rejects.toMatchObject({ code: 'CITED' });

    await saveBatchSearchStrategy({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CHANGE', strategyType: 'ME01', conditionTable: '501',
      recordNumber: '0000000001', validFrom: '2026-10-02', validTo: '2026-10-31', expectedVersion: 1,
      confirmed: true, reason: 'Shorten the period',
    });
    await expect(saveBatchSearchStrategy({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CHANGE', strategyType: 'ME02', conditionTable: '501',
      recordNumber: '0000000001', validFrom: '2026-10-02', validTo: '2026-10-31', expectedVersion: 2,
      confirmed: true, reason: 'The key stays',
    })).rejects.toMatchObject({ code: 'KEY_REFUSED' });
    for (const recordNumber of ['0000000001', '0000000002', materialRecord.recordNumber, customer.recordNumber]) {
      const current = (await listBatchSearchStrategies(client)).find((row) => row.recordNumber === recordNumber);
      await deleteBatchSearchStrategy({
        client, changedBy: ACTOR, capabilities: AUTH, recordNumber, expectedVersion: current?.version ?? 1,
        confirmed: true, reason: 'Remove the record',
      });
    }
    expect(await listBatchSearchStrategies(client)).toEqual([]);
  });

  it('does not propose a batch when a strategy stands', async () => {
    const client = await tenant('mbc1-post');
    await chain(client);
    await withTenant(client, (tx) => tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, '201', 'Issue', 'ISSUE', 'MATERIAL_DOCUMENT', ${ACTOR})
    `));
    await save(client, '501', { BWART: '201' });
    const before = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*) from material_document where client = ${client})::int as documents,
        (select count(*) from stock_quantity where client = ${client})::int as stock,
        (select count(*) from batch_search_strategy where client = ${client})::int as strategies
    `)) as unknown as Array<{ documents: number; stock: number; strategies: number }>;
    const result = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '201', postingDate: '2026-10-23', documentDate: '2026-10-23',
      requestKey: 'mbc1-gi', lines: [{ materialNumber: 'NO-MAT', plant: '1000', quantity: 1, batch: '' }],
    }).then(() => 'posted').catch((error: unknown) => error);
    expect(result).toBeInstanceOf(GoodsIssueError);
    expect((result as Error).message).not.toMatch(/search strategy|proposed|fefo/i);
    const after = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*) from material_document where client = ${client})::int as documents,
        (select count(*) from stock_quantity where client = ${client})::int as stock,
        (select count(*) from batch_search_strategy where client = ${client})::int as strategies
    `)) as unknown as Array<{ documents: number; stock: number; strategies: number }>;
    expect(after[0]).toEqual(before[0]);
  });

  it('does not store a selection class or call the strategy from a goods movement', () => {
    const service = readFileSync('src/modules/inventory/batch-search-strategy.ts', 'utf8');
    expect(service).not.toContain('fefo');
    expect(service).not.toContain('selection_class');
    const page = readFileSync('src/app/inventory/batch-search-strategies/page.tsx', 'utf8');
    expect(page).toContain('Not executed');
    expect(page).not.toContain('name="sortRule"');
    for (const file of [
      'src/modules/inventory/goods-issue.ts',
      'src/modules/inventory/transfer-posting.ts',
      'src/modules/inventory/production-receipt.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('batch-search-strategy');
    }
  });
});
