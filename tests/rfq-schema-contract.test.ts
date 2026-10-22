import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-155 stage 2 — the request for quotation's shape, enforced by the database.
 *
 * The event number and the request number are the keys. A collective number is
 * a label. One supplier is invited once. The request's copy must belong to that
 * request's event. Item numbers step by ten. A quantity is greater than zero.
 * The order and the requisition gain no request column.
 */
describe('SCR-155 request-for-quotation schema', () => {
  let client = '';

  const refused = async (statement: ReturnType<typeof sql>) => {
    await expect(withTenant(client, (tx) => tx.execute(statement))).rejects.toThrow();
  };

  beforeAll(async () => {
    const tenant = await createTenant('scr155-rfq-schema');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, name, country, created_by)
        values
          (${client}, 'VEND-RFQ', 'RFQ vendor', 'KW', 'SC155'),
          (${client}, 'VEND-RFQ2', 'Other vendor', 'KW', 'SC155')
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values
          (${client}, 'VEND-RFQ', 'SUPPLIER', 'SC155'),
          (${client}, 'VEND-RFQ2', 'SUPPLIER', 'SC155')
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-RFQ', 'Asked material', t.material_type, 'EA', 'SC155'
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('stores one event, one request, and a copy of the line', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into purchasing_rfq_event
          (client, event_number, purchasing_org, purchasing_group, rfq_date, quotation_deadline, currency, collective_number, created_by)
        values (${client}, 'EV0000001', '1000', '001', '2026-10-22', '2026-11-05', 'USD', 'BID-1', 'SC155')
      `);
      await tx.execute(sql`
        insert into purchasing_rfq_event_item
          (client, event_number, item_number, short_text, material_number, quantity, unit, plant, storage_location, delivery_date, created_by)
        values (${client}, 'EV0000001', 10, 'Asked material', 'MAT-RFQ', 12.500, 'EA', '1000', '0001', '2026-12-01', 'SC155')
      `);
      await tx.execute(sql`
        insert into purchasing_rfq
          (client, rfq_number, event_number, partner_number, created_by)
        values (${client}, 'RQ0000001', 'EV0000001', 'VEND-RFQ', 'SC155')
      `);
      await tx.execute(sql`
        insert into purchasing_rfq_item
          (client, rfq_number, event_number, item_number, short_text, material_number, quantity, unit, plant, storage_location, delivery_date, created_by)
        values (${client}, 'RQ0000001', 'EV0000001', 10, 'Asked material', 'MAT-RFQ', 12.500, 'EA', '1000', '0001', '2026-12-01', 'SC155')
      `);
    });
    const [row] = await withTenant(client, (tx) => tx.execute(sql`
      select e.document_type, e.collective_number, e.currency,
             i.quantity::text as quantity, r.role_code, c.short_text
        from purchasing_rfq_event e
        join purchasing_rfq_event_item i
          on i.client = e.client and i.event_number = e.event_number
        join purchasing_rfq r
          on r.client = e.client and r.event_number = e.event_number
        join purchasing_rfq_item c
          on c.client = r.client and c.rfq_number = r.rfq_number
       where e.client = ${client} and e.event_number = 'EV0000001'
    `)) as unknown as Array<{
      document_type: string;
      collective_number: string;
      currency: string;
      quantity: string;
      role_code: string;
      short_text: string;
    }>;
    expect(row.document_type).toBe('STANDARD');
    expect(row.collective_number).toBe('BID-1');
    expect(row.currency.trim()).toBe('USD');
    expect(row.quantity).toBe('12.500');
    expect(row.role_code).toBe('SUPPLIER');
    expect(row.short_text).toBe('Asked material');
  });

  it('refuses a broken event, a second invitation, and a copy from another event', async () => {
    await refused(sql`
      insert into purchasing_rfq_event
        (client, event_number, purchasing_org, purchasing_group, rfq_date, quotation_deadline, currency, created_by)
      values (${client}, 'EV0000002', '1000', '001', '2026-11-05', '2026-10-22', 'USD', 'SC155')
    `);
    await refused(sql`
      insert into purchasing_rfq_event
        (client, event_number, document_type, purchasing_org, purchasing_group, rfq_date, quotation_deadline, currency, created_by)
      values (${client}, 'EV0000002', 'AN', '1000', '001', '2026-10-22', '2026-11-05', 'USD', 'SC155')
    `);
    await refused(sql`
      insert into purchasing_rfq_event
        (client, event_number, purchasing_org, purchasing_group, rfq_date, quotation_deadline, currency, collective_number, created_by)
      values (${client}, 'EV0000002', '1000', '001', '2026-10-22', '2026-11-05', 'USD', '   ', 'SC155')
    `);
    await refused(sql`
      insert into purchasing_rfq_event_item
        (client, event_number, item_number, short_text, quantity, unit, plant, delivery_date, created_by)
      values (${client}, 'EV0000001', 15, 'Broken step', 1, 'EA', '1000', '2026-12-01', 'SC155')
    `);
    await refused(sql`
      insert into purchasing_rfq_event_item
        (client, event_number, item_number, short_text, quantity, unit, plant, delivery_date, created_by)
      values (${client}, 'EV0000001', 20, 'None', 0, 'EA', '1000', '2026-12-01', 'SC155')
    `);
    await refused(sql`
      insert into purchasing_rfq_event_item
        (client, event_number, item_number, short_text, quantity, unit, plant, delivery_date, created_by)
      values (${client}, 'EV0000001', 20, 'None', -1, 'EA', '1000', '2026-12-01', 'SC155')
    `);
    await refused(sql`
      insert into purchasing_rfq_event_item
        (client, event_number, item_number, short_text, quantity, unit, plant, delivery_date, created_by)
      values (${client}, 'EV0000001', 20, '   ', 1, 'EA', '1000', '2026-12-01', 'SC155')
    `);
    await refused(sql`
      insert into purchasing_rfq_event_item
        (client, event_number, item_number, short_text, quantity, unit, plant, delivery_date, created_by)
      values (${client}, 'EV0000001', 20, 'Unknown unit', 1, 'ZZ', '1000', '2026-12-01', 'SC155')
    `);
    await refused(sql`
      insert into purchasing_rfq
        (client, rfq_number, event_number, partner_number, created_by)
      values (${client}, 'RQ0000002', 'EV0000001', 'VEND-RFQ', 'SC155')
    `);
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into purchasing_rfq_event
          (client, event_number, purchasing_org, purchasing_group, rfq_date, quotation_deadline, currency, collective_number, created_by)
        values (${client}, 'EV0000002', '1000', '001', '2026-10-22', '2026-11-05', 'USD', 'BID-1', 'SC155')
      `);
      await tx.execute(sql`
        insert into purchasing_rfq_event_item
          (client, event_number, item_number, short_text, quantity, unit, plant, delivery_date, created_by)
        values (${client}, 'EV0000002', 10, 'Text line', 1, 'EA', '1000', '2026-12-15', 'SC155')
      `);
      await tx.execute(sql`
        insert into purchasing_rfq
          (client, rfq_number, event_number, partner_number, created_by)
        values (${client}, 'RQ0000002', 'EV0000002', 'VEND-RFQ', 'SC155')
      `);
    });
    await refused(sql`
      insert into purchasing_rfq_item
        (client, rfq_number, event_number, item_number, short_text, quantity, unit, plant, delivery_date, created_by)
      values (${client}, 'RQ0000001', 'EV0000002', 10, 'Other event', 1, 'EA', '1000', '2026-12-15', 'SC155')
    `);
    await refused(sql`
      insert into purchasing_rfq_item
        (client, rfq_number, event_number, item_number, short_text, quantity, unit, plant, delivery_date, created_by)
      values (${client}, 'RQ0000001', 'EV0000001', 20, 'Missing line', 1, 'EA', '1000', '2026-12-01', 'SC155')
    `);
    await refused(sql`
      delete from purchasing_rfq_event where client = ${client} and event_number = 'EV0000001'
    `);
    await refused(sql`
      delete from purchasing_rfq where client = ${client} and rfq_number = 'RQ0000001'
    `);
    await refused(sql`
      insert into purchasing_rfq_event
        (client, event_number, purchasing_org, purchasing_group, rfq_date, quotation_deadline, currency, created_by)
      values ('ZZZZ', 'EV0000099', '1000', '001', '2026-10-22', '2026-11-05', 'USD', 'SC155')
    `);
  });

  it('adds no request column to the order, and forces tenant isolation', async () => {
    const orderColumns = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
       where table_schema = 'public'
         and table_name in ('purchase_order', 'purchase_order_item', 'purchase_requisition_item')
    `)) as unknown as Array<{ column_name: string }>;
    const orderNames = orderColumns.map((row) => row.column_name);
    expect(orderNames).not.toContain('rfq_number');
    expect(orderNames).not.toContain('event_number');
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name in (
           'purchasing_rfq_event', 'purchasing_rfq_event_item',
           'purchasing_rfq', 'purchasing_rfq_item'
         )
    `)) as unknown as Array<{ table_name: string; column_name: string }>;
    const names = columns.map((row) => row.column_name);
    for (const absent of [
      'company_code', 'status', 'price', 'net_price', 'request_key', 'tenant_id',
      'delivery_channel', 'quotation_number', 'sent_at', 'contact_id', 'id',
    ]) {
      expect(names).not.toContain(absent);
    }
    expect(names).toContain('collective_number');
    expect(names).toContain('quotation_deadline');
    expect(names).toContain('short_text');
    // purchasing_quotation is ME47's table. This round still has no delivery attempt and no second event table.
    const absentTables = await withTenant(client, (tx) => tx.execute(sql`
      select name
        from (values ('rfq_delivery_attempt'), ('sourcing_event')) as wanted(name)
       where to_regclass('public.' || name) is not null
    `)) as unknown as Array<{ name: string }>;
    expect(absentTables).toEqual([]);
    const indexes = await withTenant(client, (tx) => tx.execute(sql`
      select i.tablename, i.indexname, i.indexdef, c.relrowsecurity, c.relforcerowsecurity
        from pg_indexes i
        join pg_class c on c.relname = i.tablename
       where i.schemaname = 'public'
         and i.tablename in (
           'purchasing_rfq_event', 'purchasing_rfq_event_item',
           'purchasing_rfq', 'purchasing_rfq_item'
         )
    `)) as unknown as Array<{ indexname: string; indexdef: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(indexes.every((row) => !row.indexname.toLowerCase().includes('me41'))).toBe(true);
    expect(indexes.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const supplier = indexes.find((row) => row.indexname === 'purchasing_rfq_supplier_uq');
    expect(supplier?.indexdef.toLowerCase()).toContain('unique');
    expect(supplier?.indexdef.toLowerCase()).toContain('partner_number');
  });
});
