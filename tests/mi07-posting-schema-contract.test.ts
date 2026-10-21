import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-149 stage 2 — the posting link's shape, enforced by the database.
 *
 * The material document is the batch. The allocation is the link, and it is not unique on the
 * inventory document. A difference movement may name a physical-inventory reference and must name
 * its events when it values. A header may be partially posted. An item is posted or it is not.
 */
describe('SCR-149 difference-posting schema', () => {
  let client = '';
  const DOC = 'PI-2026-0000902';

  const refused = async (statement: ReturnType<typeof sql>) => {
    await expect(withTenant(client, (tx) => tx.execute(statement))).rejects.toThrow();
  };

  beforeAll(async () => {
    const tenant = await createTenant('scr149-posting-schema');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, '1000', 'Posting plant', c.company_code, 'KW', 'SC149'
        from (select company_code from company_code where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-POST', 'Posted material', t.material_type, 'PC', 'SC149'
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into physical_inventory_document
          (client, inventory_document_number, fiscal_year, plant, storage_location, planned_count_date, created_by)
        values (${client}, ${DOC}, 2026, '1000', '0001', '2026-10-20', 'SC149')
      `);
      await tx.execute(sql`
        insert into physical_inventory_item
          (client, inventory_document_number, fiscal_year, item_number, material_number, stock_type,
           counted_quantity, counted_base_quantity, entry_unit, count_date, count_status,
           book_quantity_snapshot, difference_quantity, created_by)
        values
          (${client}, ${DOC}, 2026, 10, 'MAT-POST', 'UNRESTRICTED', 95, 95, 'PC', '2026-10-20', 'COUNTED', 100, -5, 'SC149'),
          (${client}, ${DOC}, 2026, 20, 'MAT-POST', 'QUALITY', 4, 4, 'PC', '2026-10-20', 'COUNTED', 0, 4, 'SC149')
      `);
      await tx.execute(sql`
        insert into movement_type
          (client, movement_type, description, direction, reference_category, movement_kind,
           valuation_relevant, inventory_event, offset_event, offset_modifier, created_by)
        values
          (${client}, 'DIFF-IN', 'Surplus difference', 'RECEIPT', 'PHYSICAL_INVENTORY', 'INVENTORY_DIFFERENCE',
           true, 'INVENTORY', 'OFFSETTING_INVENTORY', 'DIFF', 'SC149'),
          (${client}, 'DIFF-OUT', 'Shortage difference', 'ISSUE', 'PHYSICAL_INVENTORY', 'INVENTORY_DIFFERENCE',
           true, 'INVENTORY', 'OFFSETTING_INVENTORY', 'DIFF', 'SC149')
      `);
      await tx.execute(sql`
        insert into material_document
          (client, material_document_number, document_year, document_date, posting_date, created_by)
        values
          (${client}, 'MD-POST-1', 2026, '2026-10-21', '2026-10-21', 'SC149'),
          (${client}, 'MD-POST-2', 2026, '2026-10-21', '2026-10-21', 'SC149')
      `);
      await tx.execute(sql`
        insert into material_document_line
          (client, material_document_number, line_number, movement_type, material_number, plant,
           stock_type, line_direction, entry_quantity, entry_unit, base_quantity, base_unit, created_by)
        values
          (${client}, 'MD-POST-1', 1, 'DIFF-OUT', 'MAT-POST', '1000', 'UNRESTRICTED', 'ISSUE', 5, 'PC', 5, 'PC', 'SC149'),
          (${client}, 'MD-POST-2', 1, 'DIFF-OUT', 'MAT-POST', '1000', 'UNRESTRICTED', 'ISSUE', 5, 'PC', 5, 'PC', 'SC149'),
          (${client}, 'MD-POST-2', 2, 'DIFF-IN', 'MAT-POST', '1000', 'QUALITY', 'RECEIPT', 4, 'PC', 4, 'PC', 'SC149')
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('accepts a partially posted header and refuses a status the vocabulary does not have', async () => {
    await withTenant(client, (tx) => tx.execute(sql`
      update physical_inventory_document set status = 'PARTIALLY_POSTED'
      where client = ${client} and inventory_document_number = ${DOC}
    `));
    await refused(sql`
      update physical_inventory_document set status = 'ADJUSTED'
      where client = ${client} and inventory_document_number = ${DOC}
    `);
  });

  it('posts an item whole, and refuses a partial item status', async () => {
    await withTenant(client, (tx) => tx.execute(sql`
      update physical_inventory_item set posting_status = 'POSTED'
      where client = ${client} and inventory_document_number = ${DOC} and item_number = 10
    `));
    await refused(sql`
      update physical_inventory_item set posting_status = 'PARTIALLY_POSTED'
      where client = ${client} and inventory_document_number = ${DOC} and item_number = 20
    `);
  });

  it('links a line to an item, and refuses a zero difference, an over-reversal, and half a reversal reference', async () => {
    await withTenant(client, (tx) => tx.execute(sql`
      insert into physical_inventory_difference_allocation
        (client, inventory_document_number, fiscal_year, item_number, count_version, posted_difference,
         material_document_number, line_number, created_by)
      values (${client}, ${DOC}, 2026, 10, 1, -5, 'MD-POST-1', 1, 'SC149')
    `));
    await refused(sql`
      insert into physical_inventory_difference_allocation
        (client, inventory_document_number, fiscal_year, item_number, count_version, posted_difference,
         material_document_number, line_number, created_by)
      values (${client}, ${DOC}, 2026, 20, 1, 0, 'MD-POST-2', 2, 'SC149')
    `);
    await refused(sql`
      insert into physical_inventory_difference_allocation
        (client, inventory_document_number, fiscal_year, item_number, count_version, posted_difference,
         material_document_number, line_number, reversed_quantity, created_by)
      values (${client}, ${DOC}, 2026, 20, 1, 4, 'MD-POST-2', 2, 5, 'SC149')
    `);
    await refused(sql`
      insert into physical_inventory_difference_allocation
        (client, inventory_document_number, fiscal_year, item_number, count_version, posted_difference,
         material_document_number, line_number, reversed_quantity, reversal_document_number, created_by)
      values (${client}, ${DOC}, 2026, 20, 1, 4, 'MD-POST-2', 2, 4, 'MD-POST-1', 'SC149')
    `);
  });

  it('is not unique on the inventory document, and is unique on the material-document line', async () => {
    await withTenant(client, (tx) => tx.execute(sql`
      insert into physical_inventory_difference_allocation
        (client, inventory_document_number, fiscal_year, item_number, count_version, posted_difference,
         material_document_number, line_number, created_by)
      values (${client}, ${DOC}, 2026, 20, 1, 4, 'MD-POST-2', 2, 'SC149')
    `));
    await expect(withTenant(client, (tx) => tx.execute(sql`
      insert into physical_inventory_difference_allocation
        (client, inventory_document_number, fiscal_year, item_number, count_version, posted_difference,
         material_document_number, line_number, created_by)
      values (${client}, ${DOC}, 2026, 20, 1, 4, 'MD-POST-1', 1, 'SC149')
    `))).rejects.toThrow(/physical_inventory_difference_allocation_pk|duplicate key/);
  });

  it('keeps the item index, forces tenant isolation, and does not name the alias', async () => {
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select i.indexname, i.indexdef, c.relrowsecurity, c.relforcerowsecurity
        from pg_indexes i
        join pg_class c on c.relname = i.tablename
       where i.schemaname = 'public'
         and i.tablename = 'physical_inventory_difference_allocation'
         and i.indexname = 'physical_inventory_difference_allocation_item_uq'
    `)) as unknown as Array<{ indexname: string; indexdef: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('(client, inventory_document_number, fiscal_year, item_number, material_document_number)');
    expect(rows[0].indexname.toLowerCase()).not.toContain('mi07');
    expect(rows[0].relrowsecurity).toBe(true);
    expect(rows[0].relforcerowsecurity).toBe(true);
  });

  it('lets a difference movement name its events, and refuses one that would make the poster guess', async () => {
    await refused(sql`
      insert into movement_type
        (client, movement_type, description, direction, reference_category, movement_kind,
         valuation_relevant, created_by)
      values (${client}, 'DIFF-BARE', 'Missing events', 'RECEIPT', 'PHYSICAL_INVENTORY', 'INVENTORY_DIFFERENCE',
              true, 'SC149')
    `);
    await refused(sql`
      insert into movement_type
        (client, movement_type, description, direction, reference_category, movement_kind,
         valuation_relevant, inventory_event, offset_event, offset_modifier, created_by)
      values (${client}, 'DIFF-XFER', 'A transfer pretending', 'TRANSFER', 'PHYSICAL_INVENTORY', 'INVENTORY_DIFFERENCE',
              true, 'INVENTORY', 'OFFSETTING_INVENTORY', 'DIFF', 'SC149')
    `);
    await withTenant(client, (tx) => tx.execute(sql`
      insert into movement_type
        (client, movement_type, description, direction, reference_category, movement_kind,
         valuation_relevant, created_by)
      values (${client}, 'DIFF-QTY', 'Quantity only', 'ISSUE', 'PHYSICAL_INVENTORY', 'INVENTORY_DIFFERENCE',
              false, 'SC149')
    `));
  });
});
