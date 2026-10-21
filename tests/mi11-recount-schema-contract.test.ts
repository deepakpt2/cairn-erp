import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-150 stage 2 — the recount link's shape, enforced by the database.
 *
 * The pair of items is the key. One original item has one link that is not cancelled. One
 * recount item has one source. A blank reason, a date that is not a date, and a status outside
 * the four words are refused. Deleting either item does not take the link with it.
 */
describe('SCR-150 recount-link schema', () => {
  let client = '';
  const SOURCE = 'PI-2026-0000950';
  const RECOUNT = 'RC-2026-0000950';
  const NEXT = 'RC-2026-0000951';

  const refused = async (statement: ReturnType<typeof sql>) => {
    await expect(withTenant(client, (tx) => tx.execute(statement))).rejects.toThrow();
  };

  beforeAll(async () => {
    const tenant = await createTenant('scr150-recount-schema');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, '1000', 'Recount plant', c.company_code, 'KW', 'SC150'
        from (select company_code from company_code where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-RC', 'Recounted material', t.material_type, 'PC', 'SC150'
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into physical_inventory_document
          (client, inventory_document_number, fiscal_year, plant, storage_location, planned_count_date, created_by)
        values
          (${client}, ${SOURCE}, 2026, '1000', '0001', '2026-10-20', 'SC150'),
          (${client}, ${RECOUNT}, 2026, '1000', '0001', '2026-10-22', 'SC150'),
          (${client}, ${NEXT}, 2026, '1000', '0001', '2026-10-23', 'SC150')
      `);
      await tx.execute(sql`
        insert into physical_inventory_item
          (client, inventory_document_number, fiscal_year, item_number, material_number, stock_type,
           counted_quantity, counted_base_quantity, entry_unit, count_date, count_status,
           book_quantity_snapshot, difference_quantity, created_by)
        values
          (${client}, ${SOURCE}, 2026, 10, 'MAT-RC', 'UNRESTRICTED', 95, 95, 'PC', '2026-10-20', 'COUNTED', 100, -5, 'SC150'),
          (${client}, ${SOURCE}, 2026, 20, 'MAT-RC', 'QUALITY', 4, 4, 'PC', '2026-10-20', 'COUNTED', 0, 4, 'SC150')
      `);
      await tx.execute(sql`
        insert into physical_inventory_item
          (client, inventory_document_number, fiscal_year, item_number, material_number, stock_type, created_by)
        values
          (${client}, ${RECOUNT}, 2026, 10, 'MAT-RC', 'UNRESTRICTED', 'SC150'),
          (${client}, ${RECOUNT}, 2026, 20, 'MAT-RC', 'QUALITY', 'SC150'),
          (${client}, ${NEXT}, 2026, 10, 'MAT-RC', 'UNRESTRICTED', 'SC150')
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('links a counted item to a new document, and refuses a blank reason, a long note, a bad date and an unknown status', async () => {
    await withTenant(client, (tx) => tx.execute(sql`
      insert into physical_inventory_recount_link
        (client, original_document_number, original_fiscal_year, original_item_number,
         recount_document_number, recount_fiscal_year, recount_item_number,
         reason, header_text, planned_recount_date, created_by)
      values (${client}, ${SOURCE}, 2026, 10, ${RECOUNT}, 2026, 10, 'Count disagreed', 'Bay 3', '2026-10-22', 'SC150')
    `));
    await refused(sql`
      insert into physical_inventory_recount_link
        (client, original_document_number, original_fiscal_year, original_item_number,
         recount_document_number, recount_fiscal_year, recount_item_number,
         reason, planned_recount_date, created_by)
      values (${client}, ${SOURCE}, 2026, 20, ${RECOUNT}, 2026, 20, '   ', '2026-10-22', 'SC150')
    `);
    await refused(sql`
      insert into physical_inventory_recount_link
        (client, original_document_number, original_fiscal_year, original_item_number,
         recount_document_number, recount_fiscal_year, recount_item_number,
         reason, header_text, planned_recount_date, created_by)
      values (${client}, ${SOURCE}, 2026, 20, ${RECOUNT}, 2026, 20, 'Count disagreed', repeat('x', 41), '2026-10-22', 'SC150')
    `);
    await refused(sql`
      insert into physical_inventory_recount_link
        (client, original_document_number, original_fiscal_year, original_item_number,
         recount_document_number, recount_fiscal_year, recount_item_number,
         reason, planned_recount_date, created_by)
      values (${client}, ${SOURCE}, 2026, 20, ${RECOUNT}, 2026, 20, 'Count disagreed', '22-10-2026', 'SC150')
    `);
    await refused(sql`
      insert into physical_inventory_recount_link
        (client, original_document_number, original_fiscal_year, original_item_number,
         recount_document_number, recount_fiscal_year, recount_item_number,
         reason, planned_recount_date, status, created_by)
      values (${client}, ${SOURCE}, 2026, 20, ${RECOUNT}, 2026, 20, 'Count disagreed', '2026-10-22', 'PENDING', 'SC150')
    `);
  });

  it('refuses a second active link, and keeps a cancelled generation so a later one can stand', async () => {
    await refused(sql`
      insert into physical_inventory_recount_link
        (client, original_document_number, original_fiscal_year, original_item_number,
         recount_document_number, recount_fiscal_year, recount_item_number,
         reason, planned_recount_date, created_by)
      values (${client}, ${SOURCE}, 2026, 10, ${NEXT}, 2026, 10, 'Again', '2026-10-23', 'SC150')
    `);
    await withTenant(client, (tx) => tx.execute(sql`
      update physical_inventory_recount_link set status = 'CANCELLED'
       where client = ${client} and original_item_number = 10 and recount_document_number = ${RECOUNT}
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into physical_inventory_recount_link
        (client, original_document_number, original_fiscal_year, original_item_number,
         recount_document_number, recount_fiscal_year, recount_item_number,
         reason, planned_recount_date, created_by)
      values (${client}, ${SOURCE}, 2026, 10, ${NEXT}, 2026, 10, 'Again', '2026-10-23', 'SC150')
    `));
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select status from physical_inventory_recount_link
       where client = ${client} and original_item_number = 10
       order by status
    `)) as unknown as Array<{ status: string }>;
    expect(rows.map((row) => row.status).sort()).toEqual(['CANCELLED', 'SCHEDULED']);
  });

  it('refuses one recount item with two sources, and a link that is not a new document', async () => {
    await refused(sql`
      insert into physical_inventory_recount_link
        (client, original_document_number, original_fiscal_year, original_item_number,
         recount_document_number, recount_fiscal_year, recount_item_number,
         reason, planned_recount_date, created_by)
      values (${client}, ${SOURCE}, 2026, 20, ${NEXT}, 2026, 10, 'Same recount item', '2026-10-23', 'SC150')
    `);
    await refused(sql`
      insert into physical_inventory_recount_link
        (client, original_document_number, original_fiscal_year, original_item_number,
         recount_document_number, recount_fiscal_year, recount_item_number,
         reason, planned_recount_date, created_by)
      values (${client}, ${SOURCE}, 2026, 20, ${SOURCE}, 2026, 10, 'Same document', '2026-10-23', 'SC150')
    `);
  });

  it('does not delete the link by deleting either item', async () => {
    await refused(sql`
      delete from physical_inventory_item
       where client = ${client} and inventory_document_number = ${SOURCE} and item_number = 10
    `);
    await refused(sql`
      delete from physical_inventory_item
       where client = ${client} and inventory_document_number = ${NEXT} and item_number = 10
    `);
  });

  it('has no company code, forces tenant isolation, and does not name the alias', async () => {
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'physical_inventory_recount_link'
    `)) as unknown as Array<{ column_name: string }>;
    const names = columns.map((row) => row.column_name);
    expect(names).not.toContain('company_code');
    expect(names).not.toContain('tenant_id');
    expect(names).toContain('reason');
    const indexes = await withTenant(client, (tx) => tx.execute(sql`
      select i.indexname, i.indexdef, c.relrowsecurity, c.relforcerowsecurity
        from pg_indexes i
        join pg_class c on c.relname = i.tablename
       where i.schemaname = 'public' and i.tablename = 'physical_inventory_recount_link'
    `)) as unknown as Array<{ indexname: string; indexdef: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(indexes.length).toBeGreaterThan(0);
    expect(indexes.every((row) => !row.indexname.toLowerCase().includes('mi11'))).toBe(true);
    expect(indexes.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const active = indexes.find((row) => row.indexname === 'physical_inventory_recount_link_active_uq');
    const reverse = indexes.find((row) => row.indexname === 'physical_inventory_recount_link_recount_uq');
    expect(active?.indexdef).toContain('status');
    expect(active?.indexdef.toLowerCase()).toContain('unique');
    expect(reverse?.indexdef).toContain('recount_document_number');
    expect(reverse?.indexdef.toLowerCase()).toContain('unique');
  });
});
