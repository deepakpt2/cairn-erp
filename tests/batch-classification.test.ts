import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  ACTIVITY, ALIAS, BatchClassificationError, NOT_EXECUTED, listBatchClassification, saveBatchClassification, } from '../src/modules/inventory/batch-classification';
import { GoodsReceiptError } from '../src/modules/inventory/goods-receipt';
import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { GoodsIssueError, postGoodsIssue } from '../src/modules/inventory/goods-issue';
import { saveMovementType } from '../src/modules/inventory/movement-type-configuration';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMCV_TEST';
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

async function ensureReceipt(client: string) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into movement_type (client, movement_type, description, direction, reference_category, reversal_movement_type, created_by)
    values
      (${client}, 'RECEIPT_REVERSAL', 'Reversal of a goods receipt', 'REVERSAL', 'MATERIAL_DOCUMENT', null, ${ACTOR}),
      (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', 'RECEIPT_REVERSAL', ${ACTOR})
    on conflict (client, movement_type) do nothing
  `));
}

async function ensureIssue(client: string) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into movement_type (client, movement_type, description, direction, reference_category, account_assignment, reversal_movement_type, created_by)
    values (
      ${client}, 'GI_ISSUE_CC', 'Goods issue for a cost centre (201)', 'ISSUE', 'MATERIAL_DOCUMENT',
      'COST_CENTER', 'GI_ISSUE_CC_REVERSAL', ${ACTOR}
    )
    on conflict (client, movement_type) do nothing
  `));
}

async function stored(client: string, key: string) {
  const rows = await withTenant(client, (tx) => tx.execute(sql`
    select batch_classification, description from movement_type
    where client = ${client} and movement_type = ${key}
  `)) as unknown as Array<{ batch_classification: string; description: string }>;
  return rows[0] ?? null;
}

async function counts(client: string) {
  const rows = await withTenant(client, (tx) => tx.execute(sql`
    select
      (select count(*) from material_document where client = ${client})::int as documents,
      (select count(*) from material_document_line where client = ${client})::int as lines,
      (select count(*) from stock_quantity where client = ${client})::int as stock,
      (select count(*) from journal_entry where client = ${client})::int as journals
  `)) as unknown as Array<{ documents: number; lines: number; stock: number; journals: number }>;
  return rows[0];
}

function save(client: string, key: string, classification: string, expected = '') {
  return saveBatchClassification({
    client,
    changedBy: ACTOR,
    capabilities: AUTH,
    movementType: key,
    classification,
    expectedClassification: expected,
    confirmed: true,
    reason: 'Classification control for the test',
  });
}

describe('OMCV batch classification for goods movements', () => {
  it('stores the verified code, refuses a copy control, and does not rewrite a posted line', async () => {
    const client = await tenant('omcv-save');
    expect(ACTIVITY).toBe('CFG.INV.BATCHCLASSIFY.DEFINE');
    expect(ALIAS).toBe('OMCV');
    expect(NOT_EXECUTED.map((item) => item.field)).toEqual(['MILL_CPCONF', 'CO_WIPB_CPCONF', 'XKCFC', '023']);

    const before = await withTenant(client, (tx) => tx.execute(sql`
      select movement_type, batch_classification, changed_at from movement_type where client = ${client}
    `)) as unknown as Array<{ movement_type: string; batch_classification: string; changed_at: Date | null }>;
    const opened = await listBatchClassification(client);
    const afterOpen = await withTenant(client, (tx) => tx.execute(sql`
      select movement_type, batch_classification, changed_at from movement_type where client = ${client}
    `)) as unknown as Array<{ movement_type: string; batch_classification: string; changed_at: Date | null }>;
    expect(afterOpen).toEqual(before);
    expect(opened.every((row) => row.classification === ' ')).toBe(true);

    await ensureReceipt(client);
    await expect(postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: 'PO-NONE', documentDate: '2026-10-23', postingDate: '2026-10-23',
      requestKey: 'omcv-blank-gr', lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow(/does not exist/);
    expect((await stored(client, 'GOODS_RECEIPT_PO'))?.batch_classification).toBe(' ');

    await expect(save(client, 'NO_SUCH', '1')).rejects.toBeInstanceOf(BatchClassificationError);
    await expect(saveBatchClassification({
      client, changedBy: ACTOR, capabilities: [], movementType: 'GOODS_RECEIPT_PO',
      classification: '1', expectedClassification: '', confirmed: true, reason: 'No authority',
    })).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    await expect(save(client, 'GOODS_RECEIPT_PO', 'background')).rejects.toMatchObject({ code: 'CODE_UNKNOWN' });
    await expect(saveBatchClassification({
      client, changedBy: ACTOR, capabilities: AUTH, movementType: 'GOODS_RECEIPT_PO',
      classification: '1', expectedClassification: '', confirmed: true, reason: 'Copy is not a control',
      copyRule: '1',
    })).rejects.toMatchObject({ code: 'COPY_REFUSED' });
    expect((await stored(client, 'GOODS_RECEIPT_PO'))?.batch_classification).toBe(' ');

    const saved = await save(client, 'GOODS_RECEIPT_PO', '1');
    expect(saved.classification).toBe('1');
    expect((await stored(client, 'GOODS_RECEIPT_PO'))?.batch_classification).toBe('1');

    await saveMovementType({
      client, changedBy: ACTOR, mode: 'CHANGE', movementType: 'GOODS_RECEIPT_PO',
      description: 'Goods receipt, description only',
      direction: 'RECEIPT', referenceCategory: 'PURCHASE_ORDER', reversalMovementType: 'RECEIPT_REVERSAL',
      reason: 'Description only, classification stays', requestKey: 'omcv-omjj-desc',
    });
    expect((await stored(client, 'GOODS_RECEIPT_PO'))?.batch_classification).toBe('1');
    expect((await stored(client, 'GOODS_RECEIPT_PO'))?.description).toBe('Goods receipt, description only');

    const other = await tenant('omcv-other');
    await ensureReceipt(other);
    await postGoodsReceipt({
      client: other, changedBy: ACTOR, orderNumber: 'PO-NONE', documentDate: '2026-10-23', postingDate: '2026-10-23',
      requestKey: 'omcv-other-gr', lines: [{ itemNumber: 10, quantity: 1 }],
    }).catch((error: unknown) => {
      expect(error).toBeInstanceOf(GoodsReceiptError);
      expect((error as Error).message).toMatch(/does not exist/);
    });
    expect((await stored(other, 'GOODS_RECEIPT_PO'))?.batch_classification).toBe(' ');

    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
        values (${client}, '4900000001', 2026, '2026-10-23', '2026-10-23', 'POSTED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          entry_quantity, entry_unit, base_quantity, base_unit, created_by
        ) values (
          ${client}, '4900000001', 1, 'GOODS_RECEIPT_PO', 'MAT-OLD', '1000', 1, 'PC', 1, 'PC', ${ACTOR}
        )
      `);
    });
    await save(client, 'GOODS_RECEIPT_PO', '3', '1');
    const line = await withTenant(client, (tx) => tx.execute(sql`
      select movement_type, base_quantity::text as quantity from material_document_line
      where client = ${client} and material_document_number = '4900000001'
    `)) as unknown as Array<{ movement_type: string; quantity: string }>;
    expect(line[0]?.movement_type).toBe('GOODS_RECEIPT_PO');
    expect(Number(line[0]?.quantity)).toBe(1);
    expect((await stored(client, 'GOODS_RECEIPT_PO'))?.batch_classification).toBe('3');
  });

  it('refuses a non-blank code before stock or a journal, and a blank code does not', async () => {
    const client = await tenant('omcv-post');
    await ensureReceipt(client);
    const posted = counts(client);
    await expect(postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: 'PO-NONE', documentDate: '2026-10-23', postingDate: '2026-10-23',
      requestKey: 'omcv-post-blank', lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow(/does not exist/);
    expect(await counts(client)).toEqual(await posted);

    for (const code of ['1', '2', '3', '4'] as const) {
      const current = (await stored(client, 'GOODS_RECEIPT_PO'))?.batch_classification ?? ' ';
      await save(client, 'GOODS_RECEIPT_PO', code, current);
      await expect(postGoodsReceipt({
        client, changedBy: ACTOR, orderNumber: 'PO-NONE', documentDate: '2026-10-23', postingDate: '2026-10-23',
        requestKey: `omcv-post-${code}`, lines: [{ itemNumber: 10, quantity: 1 }],
      })).rejects.toThrow(new RegExp(`GOODS_RECEIPT_PO asks for batch classification ${code}`));
      expect(await counts(client)).toEqual(await posted);
    }

    await save(client, 'GOODS_RECEIPT_PO', '', '4');
    await expect(postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: 'PO-NONE', documentDate: '2026-10-23', postingDate: '2026-10-23',
      requestKey: 'omcv-post-cleared', lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow(/does not exist/);

    await ensureIssue(client);
    const blankIssue = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '201', postingDate: '2026-10-23', documentDate: '2026-10-23',
      requestKey: 'omcv-gi-blank-2', lines: [{ materialNumber: 'NO-MAT', plant: '1000', quantity: 1 }],
    }).then(() => 'posted').catch((error: unknown) => error);
    expect(blankIssue).toBeInstanceOf(GoodsIssueError);
    expect((blankIssue as Error).message).not.toMatch(/batch classification/);
    expect((await stored(client, 'GI_ISSUE_CC'))?.batch_classification).toBe(' ');

    await save(client, 'GI_ISSUE_CC', '2');
    const classifiedIssue = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '201', postingDate: '2026-10-23', documentDate: '2026-10-23',
      requestKey: 'omcv-gi-2', lines: [{ materialNumber: 'NO-MAT', plant: '1000', quantity: 1 }],
    }).then(() => 'posted').catch((error: unknown) => error);
    expect(classifiedIssue).toBeInstanceOf(GoodsIssueError);
    expect((classifiedIssue as Error).message).toMatch(/GI_ISSUE_CC asks for batch classification 2/);
    expect(await counts(client)).toEqual(await posted);
  });

  it('names the control on every goods-movement writer and does not store a copy column', async () => {
    const writers = [
      'src/modules/inventory/goods-receipt.ts',
      'src/modules/inventory/goods-issue.ts',
      'src/modules/inventory/transfer-posting.ts',
      'src/modules/inventory/production-receipt.ts',
      'src/modules/inventory/return-delivery.ts',
      'src/modules/inventory/physical-inventory-posting.ts',
      'src/modules/inventory/material-document-reversal.ts',
    ];
    for (const file of writers) {
      expect(readFileSync(file, 'utf8')).toContain('batchClassificationRefusal');
    }
    const service = readFileSync('src/modules/inventory/batch-classification.ts', 'utf8');
    expect(service).not.toContain('mill_cpconf');
    expect(service).not.toContain('co_wipb_cpconf');
    const page = readFileSync('src/app/config/batch-classification/page.tsx', 'utf8');
    expect(page).toContain('Not executed');
    expect(page).not.toContain('name="copyRule"');
    const client = await tenant('omcv-columns');
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'movement_type'
        and column_name in ('mill_cpconf', 'co_wipb_cpconf', 'xkcfc', 'batch_classification')
    `)) as unknown as Array<{ column_name: string }>;
    expect(columns.map((row) => row.column_name).sort()).toEqual(['batch_classification']);
  });
});
