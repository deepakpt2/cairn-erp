import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-153 stage 2 — the source list's shape, enforced by the database.
 *
 * One list per material and plant. The requirement flag defaults off. An entry
 * is one supplier and one purchasing organisation. A same start is refused.
 * A different start may overlap; the locked service refuses that, not an
 * exclusion constraint. The order may point at the entry, and deleting the
 * entry does not take the order with it.
 */
describe('SCR-153 source-list schema', () => {
  let client = '';

  const refused = async (statement: ReturnType<typeof sql>) => {
    await expect(withTenant(client, (tx) => tx.execute(statement))).rejects.toThrow();
  };

  beforeAll(async () => {
    const tenant = await createTenant('scr153-source-schema');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, name, country, created_by)
        values
          (${client}, 'VEND-SL', 'Source vendor', 'KW', 'SC153'),
          (${client}, 'VEND-SL2', 'Other vendor', 'KW', 'SC153')
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values
          (${client}, 'VEND-SL', 'SUPPLIER', 'SC153'),
          (${client}, 'VEND-SL2', 'SUPPLIER', 'SC153')
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-SL', 'Source material', t.material_type, 'EA', 'SC153'
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      `);
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by)
        values (${client}, 'P01', 'Source buyer', 'SC153')
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('stores one list, defaults the requirement off, and refuses a second list and a broken entry', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into purchasing_source_list (client, material_number, plant, created_by)
        values (${client}, 'MAT-SL', '1000', 'SC153')
      `);
      await tx.execute(sql`
        insert into purchasing_source_list_entry
          (client, source_number, material_number, plant, partner_number, purchasing_org, valid_from, valid_to, fixed_source, created_by)
        values (${client}, 'SL0000001', 'MAT-SL', '1000', 'VEND-SL', '1000', '2026-01-01', '2026-12-31', true, 'SC153')
      `);
    });
    const [header] = await withTenant(client, (tx) => tx.execute(sql`
      select source_list_required, mrp_relevant
        from purchasing_source_list h
        join purchasing_source_list_entry e
          on e.client = h.client and e.material_number = h.material_number and e.plant = h.plant
       where h.client = ${client} and h.material_number = 'MAT-SL'
    `)) as unknown as Array<{ source_list_required: boolean; mrp_relevant: boolean }>;
    expect(header.source_list_required).toBe(false);
    expect(header.mrp_relevant).toBe(false);
    await refused(sql`
      insert into purchasing_source_list (client, material_number, plant, created_by)
      values (${client}, 'MAT-SL', '1000', 'SC153')
    `);
    await refused(sql`
      insert into purchasing_source_list_entry
        (client, source_number, material_number, plant, partner_number, purchasing_org, valid_from, valid_to, created_by)
      values (${client}, 'SL0000002', 'MAT-SL', '1000', 'VEND-SL', '1000', '2026-06-01', '2026-01-01', 'SC153')
    `);
    await refused(sql`
      insert into purchasing_source_list_entry
        (client, source_number, material_number, plant, partner_number, purchasing_org, valid_from, valid_to, created_by)
      values (${client}, 'SL0000003', 'MAT-SL', '1000', 'VEND-SL', '1000', '2026-01-01', '2026-06-30', 'SC153')
    `);
    await withTenant(client, (tx) => tx.execute(sql`
      insert into purchasing_source_list_entry
        (client, source_number, material_number, plant, partner_number, purchasing_org, valid_from, valid_to, fixed_source, created_by)
      values (${client}, 'SL0000004', 'MAT-SL', '1000', 'VEND-SL2', '1000', '2026-01-01', '2026-12-31', true, 'SC153')
    `));
  });

  it('lets an order point at the entry, and refuses to delete the entry while it does', async () => {
    await withTenant(client, (tx) => tx.execute(sql`
      insert into purchase_order
        (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, created_by)
      values (${client}, 'PO-SL-1', 'VEND-SL', '1000', 'P01', '1000', 'USD', '2026-10-21', 'SC153')
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into purchase_order_item
        (client, order_number, item_number, short_text, quantity, unit, net_price, price_unit, net_value, plant, source_number, created_by)
      values (${client}, 'PO-SL-1', 10, 'Source material', 1, 'EA', 0, 1, 0, '1000', 'SL0000001', 'SC153')
    `));
    await refused(sql`
      delete from purchasing_source_list_entry
       where client = ${client} and source_number = 'SL0000001'
    `);
    await withTenant(client, (tx) => tx.execute(sql`
      delete from purchase_order where client = ${client} and order_number = 'PO-SL-1'
    `));
    const remaining = await withTenant(client, (tx) => tx.execute(sql`
      select source_number from purchasing_source_list_entry
       where client = ${client} and source_number = 'SL0000001'
    `)) as unknown as Array<{ source_number: string }>;
    expect(remaining).toHaveLength(1);
  });

  it('has no agreement, no price, no company code, and forces tenant isolation', async () => {
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name in ('purchasing_source_list', 'purchasing_source_list_entry')
    `)) as unknown as Array<{ table_name: string; column_name: string }>;
    const names = columns.map((row) => row.column_name);
    expect(names).not.toContain('company_code');
    expect(names).not.toContain('agreement_number');
    expect(names).not.toContain('agreement_item');
    expect(names).not.toContain('amount');
    expect(names).not.toContain('request_key');
    expect(names).toContain('source_list_required');
    expect(names).toContain('fixed_source');
    expect(names).toContain('blocked_source');
    expect(names).toContain('mrp_relevant');
    const indexes = await withTenant(client, (tx) => tx.execute(sql`
      select i.tablename, i.indexname, i.indexdef, c.relrowsecurity, c.relforcerowsecurity
        from pg_indexes i
        join pg_class c on c.relname = i.tablename
       where i.schemaname = 'public'
         and i.tablename in ('purchasing_source_list', 'purchasing_source_list_entry')
    `)) as unknown as Array<{ indexname: string; indexdef: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(indexes.every((row) => !row.indexname.toLowerCase().includes('me01'))).toBe(true);
    expect(indexes.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    expect(indexes.some((row) => row.indexdef.toLowerCase().includes('exclusion'))).toBe(false);
    const start = indexes.find((row) => row.indexname === 'purchasing_source_list_entry_start_uq');
    expect(start?.indexdef.toLowerCase()).toContain('unique');
  });
});
