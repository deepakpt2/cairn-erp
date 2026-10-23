import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { MaterialDocListError, listMaterialDocuments } from '../src/modules/inventory/material-document-list';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'MB51_BATCH_TEST';
const DOC = '4900000913';
const clients: string[] = [];
const DATES = { postingDateFrom: '2026-10-01', postingDateTo: '2026-10-23' };

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

describe('material document list batch', () => {
  it('filters the stored batch and refuses a sales document', async () => {
    const tenant = await createTenant('mb51-batch-list');
    clients.push(tenant.client);
    const client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-BATCH', 'Batch material', t.material_type, 'PC', ${ACTOR}
          from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      `);
      await tx.execute(sql`
        insert into batch (id, client, batch_number, material_number, plant, batch_level_at_creation, created_by, changed_by)
        values
          ('mb51-12', ${client}, '00012', 'MAT-BATCH', null, '1', ${ACTOR}, ${ACTOR}),
          ('mb51-13', ${client}, '00013', 'MAT-BATCH', null, '1', ${ACTOR}, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${client}, 'RECEIPT_OTHER', 'Goods receipt without reference', 'RECEIPT', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
        values (${client}, ${DOC}, 2026, '2026-10-18', '2026-10-18', 'POSTED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          storage_location, stock_type, batch_number, line_direction,
          entry_quantity, entry_unit, base_quantity, base_unit, created_by
        ) values
          (${client}, ${DOC}, 1, 'RECEIPT_OTHER', 'MAT-BATCH', '1000', '0001', 'UNRESTRICTED', '00012', 'RECEIPT', 1, 'PC', 1, 'PC', ${ACTOR}),
          (${client}, ${DOC}, 2, 'RECEIPT_OTHER', 'MAT-BATCH', '1000', '0001', 'UNRESTRICTED', '00013', 'RECEIPT', 1, 'PC', 1, 'PC', ${ACTOR})
      `);
    });
    const before = await withTenant(client, async (tx) => tx.execute(sql`
      select count(*)::int as n from material_document where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    const listed = await listMaterialDocuments({ client, selection: { ...DATES, batch: '00012' } });
    expect(listed.rows.map((row) => row.batch)).toEqual(['00012']);
    const both = await listMaterialDocuments({ client, selection: DATES });
    expect(both.rows.map((row) => row.batch).sort()).toEqual(['00012', '00013']);
    await expect(listMaterialDocuments({
      client, selection: { ...DATES, salesOrder: 'SO-1' },
    })).rejects.toBeInstanceOf(MaterialDocListError);
    await expect(listMaterialDocuments({
      client, selection: { ...DATES, batch: 'MISSING' },
    })).rejects.toThrow(/does not stand/);
    const after = await withTenant(client, async (tx) => tx.execute(sql`
      select count(*)::int as n from material_document where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});
