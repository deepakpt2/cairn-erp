import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  ACTIVITY,
  ALIAS,
  APPLICATION,
  ALLOWED_FIELDS,
  BatchConditionTableError,
  NOT_EXECUTED,
  USAGE,
  deleteBatchConditionTable,
  listBatchConditionTables,
  saveBatchConditionTable,
} from '../src/modules/inventory/batch-condition-table';
import { GoodsIssueError, postGoodsIssue } from '../src/modules/inventory/goods-issue';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMA1_TEST';
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

function save(client: string, conditionTable: string, fields: string[], mode: 'CREATE' | 'CHANGE' = 'CREATE', expectedVersion?: number) {
  return saveBatchConditionTable({
    client,
    changedBy: ACTOR,
    capabilities: AUTH,
    mode,
    conditionTable,
    fields,
    expectedVersion,
    confirmed: true,
    reason: 'Condition table for the test',
  });
}

async function counts(client: string) {
  const rows = await withTenant(client, (tx) => tx.execute(sql`
    select
      (select count(*) from material_document where client = ${client})::int as documents,
      (select count(*) from stock_quantity where client = ${client})::int as stock,
      (select count(*) from journal_entry where client = ${client})::int as journals,
      (select count(*) from batch_condition_table where client = ${client})::int as tables
  `)) as unknown as Array<{ documents: number; stock: number; journals: number; tables: number }>;
  return rows[0];
}

describe('OMA1 Inventory Management condition tables', () => {
  it('stores a customer table and refuses a reserved number or an unknown field', async () => {
    const client = await tenant('oma1-save');
    expect(ACTIVITY).toBe('CFG.INV.BATCHCONDTABLE.DEFINE');
    expect(ALIAS).toBe('OMA1');
    expect(USAGE).toBe('H');
    expect(APPLICATION).toBe('ME');
    expect(ALLOWED_FIELDS.map((item) => item.field)).toEqual([
      'BWART', 'KUNNR', 'LGORT', 'LIFNR', 'MATKL', 'MATNR', 'MTART', 'SOBKZ', 'WERKS',
    ]);
    expect(NOT_EXECUTED.map((item) => item.field)).toEqual(['KOTAB', 'GESTA', 'KSDAT', 'T682Z']);

    const before = await counts(client);
    expect(await listBatchConditionTables(client)).toEqual([]);
    expect(await counts(client)).toEqual(before);

    await expect(saveBatchConditionTable({
      client, changedBy: ACTOR, capabilities: [], mode: 'CREATE', conditionTable: '501',
      fields: ['WERKS'], confirmed: true, reason: 'No authority',
    })).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    await expect(save(client, '024', ['BWART', 'WERKS', 'MATNR'])).rejects.toMatchObject({ code: 'TABLE_RESERVED' });
    await expect(save(client, '500', ['WERKS'])).rejects.toMatchObject({ code: 'TABLE_RESERVED' });
    await expect(save(client, '1000', ['WERKS'])).rejects.toMatchObject({ code: 'TABLE_UNKNOWN' });
    await expect(save(client, '501', [])).rejects.toMatchObject({ code: 'FIELDS_REQUIRED' });
    await expect(save(client, '501', ['AUART'])).rejects.toMatchObject({ code: 'FIELD_UNKNOWN' });
    await expect(save(client, '501', ['WERKS', 'WERKS'])).rejects.toMatchObject({ code: 'FIELD_DUPLICATE' });
    await expect(saveBatchConditionTable({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', conditionTable: '501',
      fields: ['WERKS'], confirmed: true, reason: 'Generation is not this save', generate: 'X',
    })).rejects.toMatchObject({ code: 'GENERATION_REFUSED' });
    await expect(saveBatchConditionTable({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', conditionTable: '501',
      fields: ['WERKS'], confirmed: true, reason: 'A record is not stored', conditionRecord: 'ME01',
    })).rejects.toMatchObject({ code: 'RECORD_REFUSED' });
    await expect(saveBatchConditionTable({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', conditionTable: '501',
      fields: ['WERKS'], confirmed: true, reason: 'Production is not this screen', application: 'CO',
    })).rejects.toMatchObject({ code: 'SCOPE_REFUSED' });
    await expect(saveBatchConditionTable({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', conditionTable: '501',
      fields: ['WERKS'], confirmed: true, reason: 'A plant value is not a key', plant: '1000',
    })).rejects.toMatchObject({ code: 'PLANT_REFUSED' });
    await expect(saveBatchConditionTable({
      client, changedBy: ACTOR, capabilities: AUTH, mode: 'CREATE', conditionTable: '501',
      fields: ['WERKS'], confirmed: true, reason: 'No transport is written', transportRequest: 'DEVK900001',
    })).rejects.toMatchObject({ code: 'TRANSPORT_REFUSED' });
    expect(await counts(client)).toEqual(before);

    const created = await save(client, '501', ['werks', 'bwart', 'matnr']);
    expect(created).toMatchObject({
      conditionTable: '501',
      fields: ['WERKS', 'BWART', 'MATNR'],
      usage: 'H',
      application: 'ME',
      version: 1,
    });
    await expect(save(client, '501', ['MATNR'])).rejects.toMatchObject({ code: 'DUPLICATE' });

    const other = await tenant('oma1-other');
    await save(other, '501', ['LGORT']);
    expect((await listBatchConditionTables(client)).map((row) => row.fields[0])).toEqual(['WERKS']);

    await withTenant(client, (tx) => tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
      values (${client}, '4900000093', 2026, '2026-10-23', '2026-10-23', 'POSTED', ${ACTOR})
    `));
    const changed = await save(client, '501', ['MATNR', 'WERKS'], 'CHANGE', 1);
    expect(changed.version).toBe(2);
    expect(changed.fields).toEqual(['MATNR', 'WERKS']);
    const document = await withTenant(client, (tx) => tx.execute(sql`
      select status from material_document where client = ${client} and material_document_number = '4900000093'
    `)) as unknown as Array<{ status: string }>;
    expect(document).toEqual([{ status: 'POSTED' }]);

    await deleteBatchConditionTable({
      client, changedBy: ACTOR, capabilities: AUTH, conditionTable: '501', expectedVersion: 2,
      confirmed: true, reason: 'Remove the unused table',
    });
    expect(await listBatchConditionTables(client)).toEqual([]);
    expect(document).toEqual([{ status: 'POSTED' }]);
  });

  it('does not propose a batch when a condition table stands', async () => {
    const client = await tenant('oma1-post');
    await save(client, '999', ['BWART', 'WERKS', 'MATNR']);
    const before = await counts(client);
    const result = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '201', postingDate: '2026-10-23', documentDate: '2026-10-23',
      requestKey: 'oma1-gi', lines: [{ materialNumber: 'NO-MAT', plant: '1000', quantity: 1, batch: '' }],
    }).then(() => 'posted').catch((error: unknown) => error);
    expect(result).toBeInstanceOf(GoodsIssueError);
    expect((result as Error).message).not.toMatch(/condition table|batch determination|proposed/i);
    const after = await counts(client);
    expect(after.documents).toBe(before.documents);
    expect(after.stock).toBe(before.stock);
    expect(after.journals).toBe(before.journals);
    expect(after.tables).toBe(1);
  });

  it('does not generate a table or call the definition from a goods movement', async () => {
    const service = readFileSync('src/modules/inventory/batch-condition-table.ts', 'utf8');
    expect(service).not.toContain('create table');
    expect(service).not.toContain('gesta');
    const page = readFileSync('src/app/config/batch-condition-tables/page.tsx', 'utf8');
    expect(page).toContain('Not executed');
    expect(page).not.toContain('name="generate"');
    for (const file of [
      'src/modules/inventory/goods-issue.ts',
      'src/modules/inventory/transfer-posting.ts',
      'src/modules/inventory/production-receipt.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('batch-condition-table');
    }
    const client = await tenant('oma1-columns');
    const tables = await withTenant(client, (tx) => tx.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('batch_condition_table', 'batch_condition_table_field', 'batch_condition_record')
    `)) as unknown as Array<{ table_name: string }>;
    expect(tables.map((row) => row.table_name).sort()).toEqual(['batch_condition_table', 'batch_condition_table_field']);
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'batch_condition_table'
        and column_name in ('condition_table', 'kotab', 'gesta', 'ksdat')
    `)) as unknown as Array<{ column_name: string }>;
    expect(columns.map((row) => row.column_name)).toEqual(['condition_table']);
  });
});
