import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-154 stage 2 — the quota arrangement's shape, enforced by the database.
 *
 * The header key is the drawn number. A standing arrangement holds its start.
 * A different start may overlap; the locked service refuses that, not an
 * exclusion constraint. A deactivated arrangement does not hold the start.
 * The same supplier and organisation may appear once. The order gains no
 * quota column.
 */
describe('SCR-154 quota-arrangement schema', () => {
  let client = '';

  const refused = async (statement: ReturnType<typeof sql>) => {
    await expect(withTenant(client, (tx) => tx.execute(statement))).rejects.toThrow();
  };

  beforeAll(async () => {
    const tenant = await createTenant('scr154-quota-schema');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, name, country, created_by)
        values
          (${client}, 'VEND-QA', 'Quota vendor', 'KW', 'SC154'),
          (${client}, 'VEND-QA2', 'Other vendor', 'KW', 'SC154')
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values
          (${client}, 'VEND-QA', 'SUPPLIER', 'SC154'),
          (${client}, 'VEND-QA2', 'SUPPLIER', 'SC154')
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-QA', 'Quota material', t.material_type, 'EA', 'SC154'
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      `);
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
        values (${client}, '2000', 'Other purchasing', '1000', 'SC154')
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('stores one arrangement, defaults the marks off, and refuses a broken item', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into purchasing_quota_arrangement
          (client, quota_number, material_number, plant, valid_from, valid_to, created_by)
        values (${client}, 'QA0000001', 'MAT-QA', '1000', '2026-01-01', '2026-12-31', 'SC154')
      `);
      await tx.execute(sql`
        insert into purchasing_quota_arrangement_item
          (client, quota_number, item_number, partner_number, purchasing_org, quota, created_by)
        values (${client}, 'QA0000001', '001', 'VEND-QA', '1000', 60, 'SC154')
      `);
    });
    const [row] = await withTenant(client, (tx) => tx.execute(sql`
      select h.marked_for_deletion, i.quota_base_quantity::text as base, i.quota
        from purchasing_quota_arrangement h
        join purchasing_quota_arrangement_item i
          on i.client = h.client and i.quota_number = h.quota_number
       where h.client = ${client} and h.quota_number = 'QA0000001'
    `)) as unknown as Array<{ marked_for_deletion: boolean; base: string; quota: number }>;
    expect(row.marked_for_deletion).toBe(false);
    expect(row.base).toBe('0.000');
    expect(row.quota).toBe(60);
    await refused(sql`
      insert into purchasing_quota_arrangement
        (client, quota_number, material_number, plant, valid_from, valid_to, created_by)
      values (${client}, 'QA0000002', 'MAT-QA', '1000', '2026-06-01', '2026-01-01', 'SC154')
    `);
    await refused(sql`
      insert into purchasing_quota_arrangement_item
        (client, quota_number, item_number, partner_number, purchasing_org, quota, created_by)
      values (${client}, 'QA0000001', '002', 'VEND-QA', '1000', 40, 'SC154')
    `);
    await refused(sql`
      insert into purchasing_quota_arrangement_item
        (client, quota_number, item_number, partner_number, purchasing_org, quota, created_by)
      values (${client}, 'QA0000001', '002', 'VEND-QA2', '1000', 0, 'SC154')
    `);
    await refused(sql`
      insert into purchasing_quota_arrangement_item
        (client, quota_number, item_number, partner_number, purchasing_org, quota, quota_base_quantity, created_by)
      values (${client}, 'QA0000001', '002', 'VEND-QA2', '1000', 40, -1, 'SC154')
    `);
    await refused(sql`
      insert into purchasing_quota_arrangement_item
        (client, quota_number, item_number, partner_number, purchasing_org, quota, created_by)
      values (${client}, 'QA0000001', '2', 'VEND-QA2', '1000', 40, 'SC154')
    `);
    await withTenant(client, (tx) => tx.execute(sql`
      insert into purchasing_quota_arrangement_item
        (client, quota_number, item_number, partner_number, purchasing_org, quota, created_by)
      values (${client}, 'QA0000001', '002', 'VEND-QA2', '1000', 40, 'SC154')
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into purchasing_quota_arrangement_item
        (client, quota_number, item_number, partner_number, purchasing_org, quota, created_by)
      values (${client}, 'QA0000001', '003', 'VEND-QA', '2000', 10, 'SC154')
    `));
  });

  it('holds a standing start, frees it on deactivation, and lets a different start overlap', async () => {
    await refused(sql`
      insert into purchasing_quota_arrangement
        (client, quota_number, material_number, plant, valid_from, valid_to, created_by)
      values (${client}, 'QA0000003', 'MAT-QA', '1000', '2026-01-01', '2026-06-30', 'SC154')
    `);
    await withTenant(client, (tx) => tx.execute(sql`
      insert into purchasing_quota_arrangement
        (client, quota_number, material_number, plant, valid_from, valid_to, created_by)
      values (${client}, 'QA0000004', 'MAT-QA', '1000', '2027-01-01', '2027-06-30', 'SC154')
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      update purchasing_quota_arrangement set marked_for_deletion = true
       where client = ${client} and quota_number = 'QA0000001'
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into purchasing_quota_arrangement
        (client, quota_number, material_number, plant, valid_from, valid_to, created_by)
      values (${client}, 'QA0000005', 'MAT-QA', '1000', '2026-01-01', '2026-03-31', 'SC154')
    `));
    await refused(sql`
      delete from purchasing_quota_arrangement
       where client = ${client} and quota_number = 'QA0000001'
    `);
  });

  it('adds no quota column to the order, and forces tenant isolation', async () => {
    const orderColumns = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'purchase_order_item'
    `)) as unknown as Array<{ column_name: string }>;
    // SCR-154 forbade a quota column on the order; 9109_purchasing_follow_on.sql changed that on
    // purpose — "An order may name the quotation and the quota item it settled" — so the guard now
    // bounds the quota family on the item to the reference pair and holds the line the rule was
    // really drawn at: the arrangement's own arithmetic stays out of the order.
    const quotaOnItem = orderColumns.map((row) => row.column_name)
      .filter((c) => c.startsWith('quota') && !c.startsWith('quotation')).sort();
    expect(quotaOnItem).toEqual(['quota_item', 'quota_number']);
    for (const absent of ['allocated_quantity', 'quota_base_quantity', 'valid_from', 'valid_to', 'status']) {
      expect(orderColumns.map((row) => row.column_name)).not.toContain(absent);
    }
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name in ('purchasing_quota_arrangement', 'purchasing_quota_arrangement_item')
    `)) as unknown as Array<{ table_name: string; column_name: string }>;
    const names = columns.map((row) => row.column_name);
    for (const absent of [
      'company_code', 'allocated_quantity', 'min_split_quantity', 'max_lot_size',
      'status', 'procurement_type', 'supplying_plant', 'request_key', 'tenant_id', 'unit',
    ]) {
      expect(names).not.toContain(absent);
    }
    expect(names).toContain('quota');
    expect(names).toContain('quota_base_quantity');
    expect(names).toContain('marked_for_deletion');
    const indexes = await withTenant(client, (tx) => tx.execute(sql`
      select i.tablename, i.indexname, i.indexdef, c.relrowsecurity, c.relforcerowsecurity
        from pg_indexes i
        join pg_class c on c.relname = i.tablename
       where i.schemaname = 'public'
         and i.tablename in ('purchasing_quota_arrangement', 'purchasing_quota_arrangement_item')
    `)) as unknown as Array<{ indexname: string; indexdef: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(indexes.every((row) => !row.indexname.toLowerCase().includes('meq1'))).toBe(true);
    expect(indexes.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    expect(indexes.some((row) => row.indexdef.toLowerCase().includes('exclusion'))).toBe(false);
    const standing = indexes.find((row) => row.indexname === 'purchasing_quota_arrangement_standing_start_uq');
    expect(standing?.indexdef.toLowerCase()).toContain('unique');
    expect(standing?.indexdef.toLowerCase()).toContain('marked_for_deletion');
    const supplier = indexes.find((row) => row.indexname === 'purchasing_quota_item_supplier_uq');
    expect(supplier?.indexdef.toLowerCase()).toContain('unique');
  });
});
