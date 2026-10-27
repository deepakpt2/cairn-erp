import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-157 stage 2 — the quotation's shape, enforced by the database.
 *
 * One quotation per standing request. The drawn number is the key. A quotation
 * item must name a line of that request. A price may be zero. A price unit is
 * positive. The request, the order, the requisition and the info record gain
 * no quotation column.
 */
describe('SCR-157 quotation schema', () => {
  let client = '';

  const refused = async (statement: ReturnType<typeof sql>) => {
    await expect(withTenant(client, (tx) => tx.execute(statement))).rejects.toThrow();
  };

  beforeAll(async () => {
    const tenant = await createTenant('scr157-quotation-schema');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, name, country, created_by)
        values
          (${client}, 'VEND-QT', 'Quoted vendor', 'KW', 'SC157'),
          (${client}, 'VEND-QT2', 'Other vendor', 'KW', 'SC157')
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values
          (${client}, 'VEND-QT', 'SUPPLIER', 'SC157'),
          (${client}, 'VEND-QT2', 'SUPPLIER', 'SC157')
      `);
      await tx.execute(sql`
        insert into purchasing_rfq_event
          (client, event_number, purchasing_org, purchasing_group, rfq_date, quotation_deadline, currency, created_by)
        values (${client}, 'EV0000001', '1000', '001', '2026-10-22', '2026-11-05', 'USD', 'SC157')
      `);
      await tx.execute(sql`
        insert into purchasing_rfq_event_item
          (client, event_number, item_number, short_text, quantity, unit, plant, delivery_date, created_by)
        values
          (${client}, 'EV0000001', 10, 'Asked material', 12.500, 'EA', '1000', '2026-12-01', 'SC157'),
          (${client}, 'EV0000001', 20, 'Second line', 1, 'EA', '1000', '2026-12-15', 'SC157')
      `);
      await tx.execute(sql`
        insert into purchasing_rfq
          (client, rfq_number, event_number, partner_number, created_by)
        values
          (${client}, 'RQ0000001', 'EV0000001', 'VEND-QT', 'SC157'),
          (${client}, 'RQ0000002', 'EV0000001', 'VEND-QT2', 'SC157')
      `);
      await tx.execute(sql`
        insert into purchasing_rfq_item
          (client, rfq_number, event_number, item_number, short_text, quantity, unit, plant, delivery_date, created_by)
        values
          (${client}, 'RQ0000001', 'EV0000001', 10, 'Asked material', 12.500, 'EA', '1000', '2026-12-01', 'SC157'),
          (${client}, 'RQ0000001', 'EV0000001', 20, 'Second line', 1, 'EA', '1000', '2026-12-15', 'SC157'),
          (${client}, 'RQ0000002', 'EV0000001', 10, 'Asked material', 12.500, 'EA', '1000', '2026-12-01', 'SC157'),
          (${client}, 'RQ0000002', 'EV0000001', 20, 'Second line', 1, 'EA', '1000', '2026-12-15', 'SC157')
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('stores one quotation against one request, and a zero price stands', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into purchasing_quotation (client, quotation_number, rfq_number, created_by)
        values (${client}, 'QT0000001', 'RQ0000001', 'SC157')
      `);
      await tx.execute(sql`
        insert into purchasing_quotation_item
          (client, quotation_number, rfq_number, item_number, quantity, unit, net_price, price_unit, delivery_date, created_by)
        values (${client}, 'QT0000001', 'RQ0000001', 10, 12.500, 'EA', 0, 100, '2026-12-20', 'SC157')
      `);
      await tx.execute(sql`
        insert into purchasing_quotation (client, quotation_number, rfq_number, created_by)
        values (${client}, 'QT0000002', 'RQ0000002', 'SC157')
      `);
    });
    const [row] = await withTenant(client, (tx) => tx.execute(sql`
      select q.rfq_number, i.quantity::text as quantity, i.net_price::text as net_price,
             i.price_unit::text as price_unit, i.remark
        from purchasing_quotation q
        join purchasing_quotation_item i
          on i.client = q.client and i.quotation_number = q.quotation_number
       where q.client = ${client} and q.quotation_number = 'QT0000001'
    `)) as unknown as Array<{
      rfq_number: string;
      quantity: string;
      net_price: string;
      price_unit: string;
      remark: string | null;
    }>;
    expect(row.rfq_number).toBe('RQ0000001');
    expect(row.quantity).toBe('12.500');
    expect(row.net_price).toBe('0.0000');
    expect(row.price_unit).toBe('100');
    expect(row.remark).toBeNull();
  });

  it('refuses a second quotation, a foreign line, a bad price, and a deletion that would orphan the offer', async () => {
    await refused(sql`
      insert into purchasing_quotation (client, quotation_number, rfq_number, created_by)
      values (${client}, 'QT0000003', 'RQ0000001', 'SC157')
    `);
    await refused(sql`
      insert into purchasing_quotation_item
        (client, quotation_number, rfq_number, item_number, quantity, unit, net_price, price_unit, delivery_date, created_by)
      values (${client}, 'QT0000001', 'RQ0000001', 30, 1, 'EA', 1, 1, '2026-12-20', 'SC157')
    `);
    await refused(sql`
      insert into purchasing_quotation_item
        (client, quotation_number, rfq_number, item_number, quantity, unit, net_price, price_unit, delivery_date, created_by)
      values (${client}, 'QT0000001', 'RQ0000002', 10, 1, 'EA', 1, 1, '2026-12-20', 'SC157')
    `);
    await refused(sql`
      insert into purchasing_quotation_item
        (client, quotation_number, rfq_number, item_number, quantity, unit, net_price, price_unit, delivery_date, created_by)
      values (${client}, 'QT0000001', 'RQ0000001', 20, 0, 'EA', 1, 1, '2026-12-20', 'SC157')
    `);
    await refused(sql`
      insert into purchasing_quotation_item
        (client, quotation_number, rfq_number, item_number, quantity, unit, net_price, price_unit, delivery_date, created_by)
      values (${client}, 'QT0000001', 'RQ0000001', 20, -1, 'EA', 1, 1, '2026-12-20', 'SC157')
    `);
    await refused(sql`
      insert into purchasing_quotation_item
        (client, quotation_number, rfq_number, item_number, quantity, unit, net_price, price_unit, delivery_date, created_by)
      values (${client}, 'QT0000001', 'RQ0000001', 20, 1, 'EA', -1, 1, '2026-12-20', 'SC157')
    `);
    await refused(sql`
      insert into purchasing_quotation_item
        (client, quotation_number, rfq_number, item_number, quantity, unit, net_price, price_unit, delivery_date, created_by)
      values (${client}, 'QT0000001', 'RQ0000001', 20, 1, 'EA', 1, 0, '2026-12-20', 'SC157')
    `);
    await refused(sql`
      insert into purchasing_quotation_item
        (client, quotation_number, rfq_number, item_number, quantity, unit, net_price, price_unit, delivery_date, created_by)
      values (${client}, 'QT0000001', 'RQ0000001', 20, 1, 'ZZ', 1, 1, '2026-12-20', 'SC157')
    `);
    await refused(sql`
      insert into purchasing_quotation_item
        (client, quotation_number, rfq_number, item_number, quantity, unit, net_price, price_unit, delivery_date, remark, created_by)
      values (${client}, 'QT0000001', 'RQ0000001', 20, 1, 'EA', 1, 1, '2026-12-20', '   ', 'SC157')
    `);
    await refused(sql`
      insert into purchasing_quotation_item
        (client, quotation_number, rfq_number, item_number, quantity, unit, net_price, price_unit, delivery_date, remark, created_by)
      values (${client}, 'QT0000001', 'RQ0000001', 20, 1, 'EA', 1, 1, '2026-12-20', ${'x'.repeat(81)}, 'SC157')
    `);
    await refused(sql`
      delete from purchasing_quotation where client = ${client} and quotation_number = 'QT0000001'
    `);
    await refused(sql`
      delete from purchasing_rfq_item where client = ${client} and rfq_number = 'RQ0000001' and item_number = 10
    `);
    await refused(sql`
      delete from purchasing_rfq where client = ${client} and rfq_number = 'RQ0000001'
    `);
    await refused(sql`
      insert into purchasing_quotation (client, quotation_number, rfq_number, created_by)
      values ('ZZZZ', 'QT0000099', 'RQ0000001', 'SC157')
    `);
  });

  it('adds no quotation column to the request, the order, or the info record, and forces tenant isolation', async () => {
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name in (
           'purchasing_quotation', 'purchasing_quotation_item',
           'purchasing_rfq', 'purchasing_rfq_item', 'purchasing_rfq_event',
           'purchase_order', 'purchase_order_item', 'purchase_requisition_item',
           'purchasing_info_record', 'purchasing_info_record_price'
         )
    `)) as unknown as Array<{ table_name: string; column_name: string }>;
    const of = (table: string) => columns.filter((row) => row.table_name === table).map((row) => row.column_name);
    for (const absent of ['status', 'currency', 'partner_number', 'revision', 'request_key', 'tenant_id', 'id', 'supplier_number']) {
      expect(of('purchasing_quotation')).not.toContain(absent);
      expect(of('purchasing_quotation_item')).not.toContain(absent);
    }
    expect(of('purchasing_quotation_item')).toContain('net_price');
    expect(of('purchasing_quotation_item')).toContain('price_unit');
    expect(of('purchasing_rfq')).not.toContain('quotation_number');
    expect(of('purchasing_rfq_item')).not.toContain('net_price');
    expect(of('purchasing_rfq_event')).not.toContain('quotation_number');
    expect(of('purchase_order')).not.toContain('quotation_number');
    // As with the quota: 9109_purchasing_follow_on.sql lets an order name the quotation it was
    // saved from, and nothing more. The pair is the whole quotation family on the item, which is
    // what keeps the quotation's state from being copied into the order.
    expect(of('purchase_order_item').filter((c) => c.startsWith('quotation')).sort())
      .toEqual(['quotation_item', 'quotation_number']);
    expect(of('purchase_requisition_item')).not.toContain('quotation_number');
    expect(of('purchasing_info_record')).not.toContain('quotation_number');
    expect(of('purchasing_info_record_price')).not.toContain('quotation_number');
    const indexes = await withTenant(client, (tx) => tx.execute(sql`
      select i.tablename, i.indexname, i.indexdef, c.relrowsecurity, c.relforcerowsecurity
        from pg_indexes i
        join pg_class c on c.relname = i.tablename
       where i.schemaname = 'public'
         and i.tablename in ('purchasing_quotation', 'purchasing_quotation_item')
    `)) as unknown as Array<{ indexname: string; indexdef: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(indexes.every((row) => !row.indexname.toLowerCase().includes('me47'))).toBe(true);
    expect(indexes.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const link = indexes.find((row) => row.indexname === 'purchasing_quotation_request_uq');
    expect(link?.indexdef.toLowerCase()).toContain('unique');
    expect(link?.indexdef.toLowerCase()).toContain('rfq_number');
  });
});
