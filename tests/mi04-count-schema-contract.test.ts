import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-147 stage 2 — the count result's shape, enforced by the database.
 *
 * Every refusal here is the database's, not the service's: a zero flag beside a quantity that is
 * not zero, a zero flag beside no quantity at all, a count status outside the vocabulary, a
 * "complete" count missing its date, a second item for the same material and stock type. If the
 * service ever forgets one of these, the row still cannot be written.
 */
describe('SCR-147 MI04 count-result schema', () => {
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let client = '';
  const DOC = 'PI-2026-0000901';

  /** A refused write surfaces at the transaction boundary: the check poisons the transaction. */
  const refused = async (statement: ReturnType<typeof sql>) => {
    await expect(withTenant(client, (tx) => tx.execute(statement)))
      .rejects.toThrow(/physical_inventory_item|physical_inventory_document/);
  };

  const item = (overrides: { itemNumber?: number; stockType?: string; extra?: string } = {}) => sql`
    insert into physical_inventory_item
      (client, inventory_document_number, fiscal_year, item_number, material_number, stock_type, created_by
       ${sql.raw(overrides.extra ? `, ${Object.keys(JSON.parse(overrides.extra)).join(', ')}` : '')})
    values (${client}, ${DOC}, 2026, ${overrides.itemNumber ?? 1}, 'MAT-MI04',
            ${overrides.stockType ?? 'UNRESTRICTED'}, 'SC147'
            ${sql.raw(overrides.extra ? `, ${Object.values(JSON.parse(overrides.extra)).map((v) => `'${v}'`).join(', ')}` : '')})
  `;

  beforeAll(async () => {
    tenant = await createTenant('scr147-mi04-schema');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, '1000', 'Count plant', c.company_code, 'KW', 'SC147'
        from (select company_code from company_code where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-MI04', 'Counted material', t.material_type, 'PC', 'SC147'
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into physical_inventory_document
          (client, inventory_document_number, fiscal_year, plant, storage_location, planned_count_date, created_by)
        values (${client}, ${DOC}, 2026, '1000', '0001', '2026-10-15', 'SC147')
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    await destroyTenant(client);
  });

  it('refuses a zero flag beside a quantity that is not zero', async () => {
    await refused(sql`
      insert into physical_inventory_item
        (client, inventory_document_number, fiscal_year, item_number, material_number,
         counted_quantity, counted_base_quantity, zero_count_flag, entry_unit, count_date, count_status, created_by)
      values (${client}, ${DOC}, 2026, 11, 'MAT-MI04', 5, 5, true, 'PC', '2026-10-15', 'COUNTED', 'SC147')
    `);
  });

  it('refuses a zero flag beside no quantity at all', async () => {
    await refused(sql`
      insert into physical_inventory_item
        (client, inventory_document_number, fiscal_year, item_number, material_number,
         zero_count_flag, count_status, created_by)
      values (${client}, ${DOC}, 2026, 12, 'MAT-MI04', true, 'UNCOUNTED', 'SC147')
    `);
  });

  it('refuses a count status the vocabulary does not define', async () => {
    await refused(sql`
      insert into physical_inventory_item
        (client, inventory_document_number, fiscal_year, item_number, material_number, count_status, created_by)
      values (${client}, ${DOC}, 2026, 13, 'MAT-MI04', 'SIDEWAYS', 'SC147')
    `);
  });

  it('refuses a counted item that is missing the date it was counted', async () => {
    await refused(sql`
      insert into physical_inventory_item
        (client, inventory_document_number, fiscal_year, item_number, material_number,
         counted_quantity, counted_base_quantity, entry_unit, count_status, created_by)
      values (${client}, ${DOC}, 2026, 14, 'MAT-MI04', 5, 5, 'PC', 'COUNTED', 'SC147')
    `);
  });

  it('accepts one item per material per stock type, and refuses a duplicate of the pair', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into physical_inventory_item
          (client, inventory_document_number, fiscal_year, item_number, material_number, stock_type,
           counted_quantity, counted_base_quantity, entry_unit, zero_count_flag, count_date, count_status, created_by)
        values
          (${client}, ${DOC}, 2026, 21, 'MAT-MI04', 'UNRESTRICTED', 8, 8, 'PC', false, '2026-10-15', 'COUNTED', 'SC147'),
          (${client}, ${DOC}, 2026, 22, 'MAT-MI04', 'QUALITY', 0, 0, 'PC', true, '2026-10-15', 'COUNTED', 'SC147')
      `);
    });

    await expect(withTenant(client, (tx) => tx.execute(sql`
      insert into physical_inventory_item
        (client, inventory_document_number, fiscal_year, item_number, material_number, stock_type, created_by)
      values (${client}, ${DOC}, 2026, 23, 'MAT-MI04', 'UNRESTRICTED', 'SC147')
    `))).rejects.toThrow(/physical_inventory_item_material_key/);
  });

  it('widens the header vocabulary without letting a made-up status through', async () => {
    for (const status of ['PARTIALLY_COUNTED', 'COUNTED']) {
      await withTenant(client, async (tx) => {
        await tx.execute(sql`
          update physical_inventory_document set status = ${status}
          where client = ${client} and inventory_document_number = ${DOC}
        `);
      });
    }
    await refused(sql`
      update physical_inventory_document set status = 'MOSTLY_COUNTED'
      where client = ${client} and inventory_document_number = ${DOC}
    `);
  });

  it('names the basis a book quantity was taken on, and refuses one it cannot name', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update physical_inventory_item
           set book_quantity_snapshot = 10, book_quantity_unit = 'PC', book_quantity_basis = 'COUNT_TIME',
               difference_quantity = -2
         where client = ${client} and inventory_document_number = ${DOC} and item_number = 21
      `);
    });
    await refused(sql`
      update physical_inventory_item set book_quantity_basis = 'GUESSWORK'
      where client = ${client} and inventory_document_number = ${DOC} and item_number = 21
    `);
  });
});
