import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { displayMaterialDocument } from '../src/modules/inventory/material-document-display';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'MB03_BATCH_TEST';
const DOC = '4900000912';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

describe('material document batch display', () => {
  it('shows the batch stored on the line and writes nothing', async () => {
    const tenant = await createTenant('mb03-batch-display');
    clients.push(tenant.client);
    const client = tenant.client;
    await withTenant(client, async (tx) => {
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
          (${client}, ${DOC}, 2, 'RECEIPT_OTHER', 'MAT-BATCH', '1000', '0001', 'UNRESTRICTED', '', 'RECEIPT', 1, 'PC', 1, 'PC', ${ACTOR})
      `);
    });
    const before = await withTenant(client, async (tx) => tx.execute(sql`
      select count(*)::int as n from material_document where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    const shown = await displayMaterialDocument({ client, documentNumber: DOC });
    expect(shown.lines.find((line) => line.lineNumber === 1)?.batch).toBe('00012');
    expect(shown.lines.find((line) => line.lineNumber === 2)?.batch).toBe('');
    const after = await withTenant(client, async (tx) => tx.execute(sql`
      select count(*)::int as n from material_document where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('prints the stored batch and does not offer a field that could change it', () => {
    const page = readFileSync('src/app/inventory/material-documents/page.tsx', 'utf8');
    expect(page).toContain('data-batch={line.batch}');
    expect(page).not.toContain('name="batch"');
  });
});
