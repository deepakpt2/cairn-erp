import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  deleteBatchAccessSequence,
  deleteBatchAccessStep,
  listBatchAccessSteps,
  saveBatchAccessSequence,
  saveBatchAccessStep,
} from '../src/modules/inventory/batch-access-sequence';
import { deleteBatchConditionTable, saveBatchConditionTable } from '../src/modules/inventory/batch-condition-table';
import { GoodsIssueError, postGoodsIssue } from '../src/modules/inventory/goods-issue';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMCX_STEP';
const ACCESS = ['CFG.INV.BATCHACCESS.DEFINE'];
const TABLE = ['CFG.INV.BATCHCONDTABLE.DEFINE'];
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

async function sequence(client: string, accessSequence = 'ME01') {
  return saveBatchAccessSequence({
    client, changedBy: ACTOR, capabilities: ACCESS, mode: 'CREATE', accessSequence,
    description: 'Issue access', confirmed: true, reason: 'Sequence for the step test',
  });
}

async function table(client: string, conditionTable: string, fields = ['WERKS', 'MATNR']) {
  return saveBatchConditionTable({
    client, changedBy: ACTOR, capabilities: TABLE, mode: 'CREATE', conditionTable, fields,
    confirmed: true, reason: 'Table for the step test',
  });
}

describe('OMCX access step', () => {
  it('names a standing condition table and refuses an access that cannot run', async () => {
    const client = await tenant('omcx-step');
    await sequence(client);
    await table(client, '501');
    await table(client, '502', ['BWART']);
    const before = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as steps from batch_access_step where client = ${client}
    `)) as unknown as Array<{ steps: number }>;
    expect(await listBatchAccessSteps(client, 'ME01')).toEqual([]);
    expect(before[0]?.steps).toBe(0);

    await expect(saveBatchAccessStep({
      client, changedBy: ACTOR, capabilities: ACCESS, mode: 'CREATE', accessSequence: 'ME01',
      accessNumber: '01', conditionTable: '024', expectedVersion: 1, confirmed: true, reason: 'No standard table',
    })).rejects.toMatchObject({ code: 'TABLE_UNKNOWN' });
    await expect(saveBatchAccessStep({
      client, changedBy: ACTOR, capabilities: ACCESS, mode: 'CREATE', accessSequence: 'ME01',
      accessNumber: '100', conditionTable: '501', expectedVersion: 1, confirmed: true, reason: 'Three digits',
    })).rejects.toMatchObject({ code: 'STEP_UNKNOWN' });
    await expect(saveBatchAccessStep({
      client, changedBy: ACTOR, capabilities: ACCESS, mode: 'CREATE', accessSequence: 'ME01',
      accessNumber: '01', conditionTable: '501', expectedVersion: 1, confirmed: true, reason: 'Exclusive does not run',
      exclusive: 'X', requirement: '001', fieldMapping: 'WERKS',
    })).rejects.toMatchObject({ code: 'STEP_REFUSED' });
    expect(await listBatchAccessSteps(client, 'ME01')).toEqual([]);

    const other = await tenant('omcx-step-other');
    await sequence(other, 'ME02');
    await table(other, '503', ['LGORT']);
    await expect(saveBatchAccessStep({
      client, changedBy: ACTOR, capabilities: ACCESS, mode: 'CREATE', accessSequence: 'ME01',
      accessNumber: '01', conditionTable: '503', expectedVersion: 1, confirmed: true, reason: 'Another client is not visible',
    })).rejects.toMatchObject({ code: 'TABLE_UNKNOWN' });

    const created = await saveBatchAccessStep({
      client, changedBy: ACTOR, capabilities: ACCESS, mode: 'CREATE', accessSequence: 'me01',
      accessNumber: '5', conditionTable: '501', expectedVersion: 1, confirmed: true, reason: 'A gap is allowed',
    });
    expect(created).toMatchObject({ accessSequence: 'ME01', accessNumber: '05', conditionTable: '501', version: 1, sequenceVersion: 2 });
    await expect(saveBatchAccessStep({
      client, changedBy: ACTOR, capabilities: ACCESS, mode: 'CREATE', accessSequence: 'ME01',
      accessNumber: '05', conditionTable: '502', expectedVersion: 2, confirmed: true, reason: 'Same number',
    })).rejects.toMatchObject({ code: 'STEP_DUPLICATE' });
    const changed = await saveBatchAccessStep({
      client, changedBy: ACTOR, capabilities: ACCESS, mode: 'CHANGE', accessSequence: 'ME01',
      accessNumber: '05', conditionTable: '502', expectedVersion: 2, confirmed: true, reason: 'Point at the other table',
    });
    expect(changed).toMatchObject({ conditionTable: '502', version: 2, sequenceVersion: 3 });

    await withTenant(client, (tx) => tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
      values (${client}, '4900000094', 2026, '2026-10-23', '2026-10-23', 'POSTED', ${ACTOR})
    `));
    await expect(deleteBatchConditionTable({
      client, changedBy: ACTOR, capabilities: TABLE, conditionTable: '502', expectedVersion: 1,
      confirmed: true, reason: 'A cited table stays',
    })).rejects.toMatchObject({ code: 'CITED' });
    const document = await withTenant(client, (tx) => tx.execute(sql`
      select status from material_document where client = ${client} and material_document_number = '4900000094'
    `)) as unknown as Array<{ status: string }>;
    expect(document).toEqual([{ status: 'POSTED' }]);

    await deleteBatchAccessStep({
      client, changedBy: ACTOR, capabilities: ACCESS, accessSequence: 'ME01', accessNumber: '05',
      expectedVersion: 3, confirmed: true, reason: 'Remove the access',
    });
    expect(await listBatchAccessSteps(client, 'ME01')).toEqual([]);
    await deleteBatchConditionTable({
      client, changedBy: ACTOR, capabilities: TABLE, conditionTable: '502', expectedVersion: 1,
      confirmed: true, reason: 'The access is gone',
    });
    await saveBatchAccessStep({
      client, changedBy: ACTOR, capabilities: ACCESS, mode: 'CREATE', accessSequence: 'ME01',
      accessNumber: '10', conditionTable: '501', expectedVersion: 4, confirmed: true, reason: 'Restore one access',
    });
    await deleteBatchAccessSequence({
      client, changedBy: ACTOR, capabilities: ACCESS, accessSequence: 'ME01', expectedVersion: 5,
      confirmed: true, reason: 'Remove the sequence and its access',
    });
    expect(await listBatchAccessSteps(client, 'ME01')).toEqual([]);
    expect(document).toEqual([{ status: 'POSTED' }]);
  });

  it('does not propose a batch when an access names a condition table', async () => {
    const client = await tenant('omcx-step-post');
    await sequence(client, 'Z001');
    await table(client, '501', ['BWART', 'WERKS', 'MATNR']);
    await saveBatchAccessStep({
      client, changedBy: ACTOR, capabilities: ACCESS, mode: 'CREATE', accessSequence: 'Z001',
      accessNumber: '01', conditionTable: '501', expectedVersion: 1, confirmed: true, reason: 'Name the table',
    });
    const before = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*) from material_document where client = ${client})::int as documents,
        (select count(*) from stock_quantity where client = ${client})::int as stock,
        (select count(*) from batch_access_step where client = ${client})::int as steps
    `)) as unknown as Array<{ documents: number; stock: number; steps: number }>;
    const result = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '201', postingDate: '2026-10-23', documentDate: '2026-10-23',
      requestKey: 'omcx-step-gi', lines: [{ materialNumber: 'NO-MAT', plant: '1000', quantity: 1, batch: '' }],
    }).then(() => 'posted').catch((error: unknown) => error);
    expect(result).toBeInstanceOf(GoodsIssueError);
    expect((result as Error).message).not.toMatch(/access sequence|condition table|batch determination|proposed/i);
    const after = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*) from material_document where client = ${client})::int as documents,
        (select count(*) from stock_quantity where client = ${client})::int as stock,
        (select count(*) from batch_access_step where client = ${client})::int as steps
    `)) as unknown as Array<{ documents: number; stock: number; steps: number }>;
    expect(after[0]).toEqual(before[0]);
  });

  it('does not store an exclusive indicator or call the step from a goods movement', async () => {
    const service = readFileSync('src/modules/inventory/batch-access-sequence.ts', 'utf8');
    expect(service).not.toContain('kzexl');
    expect(service).not.toContain('kobed');
    for (const file of [
      'src/modules/inventory/goods-issue.ts',
      'src/modules/inventory/transfer-posting.ts',
      'src/modules/inventory/production-receipt.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('batch-access-sequence');
    }
    const client = await tenant('omcx-step-columns');
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'batch_access_step'
        and column_name in ('access_number', 'condition_table', 'kzexl', 'kobed', 'zifna')
    `)) as unknown as Array<{ column_name: string }>;
    expect(columns.map((row) => row.column_name).sort()).toEqual(['access_number', 'condition_table']);
  });
});
