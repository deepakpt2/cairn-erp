import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-151 stage 2 — the info record's shape, enforced by the database.
 *
 * One general record per supplier, material and category. A blank plant is null, and a
 * second organisation-level segment cannot be inserted. The price is the only price.
 * The order may point at it, and deleting the price does not take the order with it.
 */
describe('SCR-151 info-record schema', () => {
  let client = '';

  const refused = async (statement: ReturnType<typeof sql>) => {
    await expect(withTenant(client, (tx) => tx.execute(statement))).rejects.toThrow();
  };

  beforeAll(async () => {
    const tenant = await createTenant('scr151-info-schema');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, name, country, created_by)
        values (${client}, 'VEND-IR', 'Info vendor', 'KW', 'SC151')
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, 'VEND-IR', 'SUPPLIER', 'SC151')
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-IR', 'Info material', t.material_type, 'EA', 'SC151'
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      `);
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by)
        values (${client}, 'P01', 'Info buyer', 'SC151')
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('stores one standard record, an organisation-level segment and a plant segment, and refuses the duplicates', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into purchasing_info_record
          (client, info_record_number, partner_number, material_number, created_by)
        values (${client}, 'IR0000001', 'VEND-IR', 'MAT-IR', 'SC151')
      `);
      await tx.execute(sql`
        insert into purchasing_info_record_org
          (client, info_record_number, segment_number, purchasing_org, planned_delivery_days, created_by)
        values (${client}, 'IR0000001', 1, '1000', 7, 'SC151')
      `);
      await tx.execute(sql`
        insert into purchasing_info_record_org
          (client, info_record_number, segment_number, purchasing_org, plant, created_by)
        values (${client}, 'IR0000001', 2, '1000', '1000', 'SC151')
      `);
      await tx.execute(sql`
        insert into purchasing_info_record_price
          (client, info_record_number, price_sequence, segment_number, amount, currency, price_unit,
           price_unit_of_measure, valid_from, valid_to, created_by)
        values (${client}, 'IR0000001', 1, 1, 0, 'USD', 1, 'EA', '2026-01-01', '2026-12-31', 'SC151')
      `);
    });
    await refused(sql`
      insert into purchasing_info_record
        (client, info_record_number, partner_number, material_number, created_by)
      values (${client}, 'IR0000002', 'VEND-IR', 'MAT-IR', 'SC151')
    `);
    await refused(sql`
      insert into purchasing_info_record_org
        (client, info_record_number, segment_number, purchasing_org, created_by)
      values (${client}, 'IR0000001', 3, '1000', 'SC151')
    `);
    await refused(sql`
      insert into purchasing_info_record_org
        (client, info_record_number, segment_number, purchasing_org, plant, created_by)
      values (${client}, 'IR0000001', 4, '1000', '1000', 'SC151')
    `);
  });

  it('refuses a category, a price and a date the contract does not allow, and keeps a later interval', async () => {
    await refused(sql`
      insert into purchasing_info_record
        (client, info_record_number, partner_number, material_number, category, created_by)
      values (${client}, 'IR0000009', 'VEND-IR', 'MAT-IR', 'SUBCONTRACT', 'SC151')
    `);
    await refused(sql`
      insert into purchasing_info_record_price
        (client, info_record_number, price_sequence, segment_number, condition_type, amount, currency,
         price_unit, price_unit_of_measure, valid_from, valid_to, created_by)
      values (${client}, 'IR0000001', 9, 1, 'PB00', 1, 'USD', 1, 'EA', '2026-01-01', '2026-12-31', 'SC151')
    `);
    await refused(sql`
      insert into purchasing_info_record_price
        (client, info_record_number, price_sequence, segment_number, amount, currency, price_unit,
         price_unit_of_measure, valid_from, valid_to, created_by)
      values (${client}, 'IR0000001', 8, 1, -1, 'USD', 1, 'EA', '2026-01-01', '2026-12-31', 'SC151')
    `);
    await refused(sql`
      insert into purchasing_info_record_price
        (client, info_record_number, price_sequence, segment_number, amount, currency, price_unit,
         price_unit_of_measure, valid_from, valid_to, created_by)
      values (${client}, 'IR0000001', 7, 1, 1, 'USD', 0, 'EA', '2026-01-01', '2026-12-31', 'SC151')
    `);
    await refused(sql`
      insert into purchasing_info_record_price
        (client, info_record_number, price_sequence, segment_number, amount, currency, price_unit,
         price_unit_of_measure, valid_from, valid_to, created_by)
      values (${client}, 'IR0000001', 6, 1, 1, 'USD', 1, 'EA', '2026-12-31', '2026-01-01', 'SC151')
    `);
    await refused(sql`
      update purchasing_info_record_org
         set planned_delivery_days = -1
       where client = ${client} and info_record_number = 'IR0000001' and segment_number = 1
    `);
    await refused(sql`
      update purchasing_info_record_org
         set minimum_order_quantity = 5
       where client = ${client} and info_record_number = 'IR0000001' and segment_number = 1
    `);
    await withTenant(client, (tx) => tx.execute(sql`
      insert into purchasing_info_record_price
        (client, info_record_number, price_sequence, segment_number, amount, currency, price_unit,
         price_unit_of_measure, valid_from, valid_to, created_by)
      values (${client}, 'IR0000001', 2, 1, 12.5, 'USD', 1, 'EA', '2027-01-01', '2027-12-31', 'SC151')
    `));
    await refused(sql`
      insert into purchasing_info_record_price
        (client, info_record_number, price_sequence, segment_number, amount, currency, price_unit,
         price_unit_of_measure, valid_from, valid_to, created_by)
      values (${client}, 'IR0000001', 3, 1, 9, 'USD', 1, 'EA', '2026-01-01', '2026-06-30', 'SC151')
    `);
  });

  it('lets an order point at the price, and refuses to delete the price while it does', async () => {
    await withTenant(client, (tx) => tx.execute(sql`
      insert into purchase_order
        (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, created_by)
      values (${client}, 'PO-IR-1', 'VEND-IR', '1000', 'P01', '1000', 'USD', '2026-10-21', 'SC151')
    `));
    await refused(sql`
      insert into purchase_order_item
        (client, order_number, item_number, short_text, quantity, unit, net_price, price_unit, net_value, plant,
         info_record_number, created_by)
      values (${client}, 'PO-IR-1', 10, 'Info material', 1, 'EA', 0, 1, 0, '1000', 'IR0000001', 'SC151')
    `);
    await withTenant(client, (tx) => tx.execute(sql`
      insert into purchase_order_item
        (client, order_number, item_number, short_text, quantity, unit, net_price, price_unit, net_value, plant,
         info_record_number, price_sequence, created_by)
      values (${client}, 'PO-IR-1', 10, 'Info material', 1, 'EA', 0, 1, 0, '1000', 'IR0000001', 1, 'SC151')
    `));
    await refused(sql`
      delete from purchasing_info_record_price
       where client = ${client} and info_record_number = 'IR0000001' and price_sequence = 1
    `);
    await withTenant(client, (tx) => tx.execute(sql`
      delete from purchase_order where client = ${client} and order_number = 'PO-IR-1'
    `));
    const remaining = await withTenant(client, (tx) => tx.execute(sql`
      select price_sequence from purchasing_info_record_price
       where client = ${client} and info_record_number = 'IR0000001' and price_sequence = 1
    `)) as unknown as Array<{ price_sequence: number }>;
    expect(remaining).toHaveLength(1);
  });

  it('has no company code, no material group, no second price, and forces tenant isolation', async () => {
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name in ('purchasing_info_record', 'purchasing_info_record_org', 'purchasing_info_record_price')
    `)) as unknown as Array<{ table_name: string; column_name: string }>;
    const names = columns.map((row) => row.column_name);
    expect(names).not.toContain('company_code');
    expect(names).not.toContain('tenant_id');
    expect(names).not.toContain('material_group');
    expect(names).not.toContain('request_key');
    expect(names).not.toContain('net_price');
    const org = columns.filter((row) => row.table_name === 'purchasing_info_record_org').map((row) => row.column_name);
    expect(org).not.toContain('amount');
    expect(org).toContain('plant');
    const indexes = await withTenant(client, (tx) => tx.execute(sql`
      select i.tablename, i.indexname, i.indexdef, c.relrowsecurity, c.relforcerowsecurity
        from pg_indexes i
        join pg_class c on c.relname = i.tablename
       where i.schemaname = 'public'
         and i.tablename in ('purchasing_info_record', 'purchasing_info_record_org', 'purchasing_info_record_price')
    `)) as unknown as Array<{ indexname: string; indexdef: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(indexes.length).toBeGreaterThan(0);
    expect(indexes.every((row) => !row.indexname.toLowerCase().includes('me11'))).toBe(true);
    expect(indexes.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const scope = indexes.find((row) => row.indexname === 'purchasing_info_record_org_scope_uq');
    expect(scope?.indexdef.toLowerCase()).toContain('nulls not distinct');
    expect(scope?.indexdef.toLowerCase()).toContain('unique');
  });
});
