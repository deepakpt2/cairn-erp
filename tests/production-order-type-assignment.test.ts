import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createProductionOrder, getProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import { changeProductionOrder } from '../src/modules/production/production-order-change';
import { saveProductionOrderType } from '../src/modules/production/production-order-type';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'AUART_TEST';
const PLANT = 'QO10';

describe('production order type assignment', () => {
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('auart');
    other = await createTenant('auart-other');
    for (const site of [tenant, other]) {
      await withTenant(site.client, async (tx) => {
        await tx.execute(sql`
          insert into material (client, material_number, description, material_type, base_unit, created_by)
          select ${site.client}, v.n, v.d, t.material_type, 'PC', ${ACTOR}
          from (values ('AUART-FG', 'Finished good'), ('AUART-RM', 'Component')) as v(n, d)
          cross join (select material_type from material_type where client = ${site.client} order by material_type limit 1) t
        `);
        await tx.execute(sql`
          insert into plant (client, plant, name, company_code, country, created_by)
          select ${site.client}, ${PLANT}, 'Assignment plant', c.company_code, 'KW', ${ACTOR}
          from (select company_code from company_code where client = ${site.client} order by company_code limit 1) c
        `);
        await tx.execute(sql`
          insert into material_plant (client, material_number, plant, created_by)
          select ${site.client}, v.n, ${PLANT}, ${ACTOR}
          from (values ('AUART-FG'), ('AUART-RM')) as v(n)
        `);
        await defineRange(tx, {
          client: site.client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR,
        });
      });
    }
    await saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP01',
      description: 'Standard production', version: 0, reason: 'Type for assignment',
    });
    await saveProductionOrderType({
      client: other.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP02',
      description: 'Other type', version: 0, reason: 'Other tenant type',
    });
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
  });

  async function order(key: string, orderType?: string) {
    return createProductionOrder({
      client: tenant.client, createdBy: ACTOR, requestKey: key,
      materialNumber: 'AUART-FG', plant: PLANT, orderQuantity: 2,
      scheduledStart: '2026-11-02', scheduledFinish: '2026-11-06',
      orderType,
      components: [{ materialNumber: 'AUART-RM', plant: PLANT, requiredQuantity: 1 }],
    });
  }

  it('stores a standing category-10 type and rejects a missing type', async () => {
    const assigned = await order('typed', 'PP01');
    expect(assigned.orderType).toBe('PP01');
    expect(assigned.status).toBe('CREATED');
    const read = await getProductionOrder(tenant.client, assigned.orderNumber);
    expect(read?.orderType).toBe('PP01');
    const before = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order where client = ${tenant.client}
    `)) as unknown as Array<{ n: number }>;
    await expect(order('blank')).rejects.toThrow(/production order type is required/);
    await expect(order('empty', '')).rejects.toThrow(/production order type is required/);
    await expect(order('spaces-only', '    ')).rejects.toThrow(/production order type is required/);
    const after = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order where client = ${tenant.client}
    `)) as unknown as Array<{ n: number }>;
    expect(after[0]?.n).toBe(before[0]?.n);
    const [parameters] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order_type_parameter where client = ${tenant.client}
    `)) as unknown as Array<{ n: number }>;
    expect(parameters.n).toBe(0);
    const [orders] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order where client = ${tenant.client} and order_number = ${assigned.orderNumber}
    `)) as unknown as Array<{ n: number }>;
    expect(orders.n).toBe(1);
  });

  it('refuses a missing, invalid, or other-tenant type and does not invent one', async () => {
    await expect(order('missing', 'PP99')).rejects.toThrow(/does not stand in this tenant/);
    await expect(order('short', 'PP1')).rejects.toThrow(/not four characters/);
    await expect(order('spaces', ' PP01')).rejects.toThrow(/surrounding spaces/);
    await expect(createProductionOrder({
      client: tenant.client, createdBy: ACTOR, requestKey: 'cross',
      materialNumber: 'AUART-FG', plant: PLANT, orderQuantity: 1,
      scheduledStart: '2026-11-02', scheduledFinish: '2026-11-06',
      orderType: 'ZZ99',
      components: [{ materialNumber: 'AUART-RM', plant: PLANT, requiredQuantity: 1 }],
    })).rejects.toThrow(/does not stand/);
    const before = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order where client = ${tenant.client}
    `)) as unknown as Array<{ n: number }>;
    await expect(createProductionOrder({
      client: tenant.client, createdBy: ACTOR, requestKey: 'foreign-type',
      materialNumber: 'AUART-FG', plant: PLANT, orderQuantity: 1,
      scheduledStart: '2026-11-02', scheduledFinish: '2026-11-06',
      orderType: 'PP02',
      components: [{ materialNumber: 'AUART-RM', plant: PLANT, requiredQuantity: 1 }],
    })).rejects.toThrow(/does not stand in this tenant/);
    const after = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order where client = ${tenant.client}
    `)) as unknown as Array<{ n: number }>;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('leaves a stored null type readable and does not fill it in', async () => {
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_order (
        client, order_number, material_number, plant, order_quantity, unit_of_measure,
        scheduled_start, scheduled_finish, status, request_key, created_by
      ) values (
        ${tenant.client}, 'PRDLEGACY1', 'AUART-FG', ${PLANT}, 1, 'PC',
        '2026-11-02', '2026-11-06', 'CREATED', 'legacy-null', ${ACTOR}
      )
    `));
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_order_component (
        client, order_number, item_number, material_number, plant, required_quantity, unit_of_measure, created_by
      ) values (
        ${tenant.client}, 'PRDLEGACY1', 10, 'AUART-RM', ${PLANT}, 1, 'PC', ${ACTOR}
      )
    `));
    const read = await getProductionOrder(tenant.client, 'PRDLEGACY1');
    expect(read?.orderType).toBeNull();
    expect(read?.status).toBe('CREATED');
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PRDLEGACY1', expectedVersion: 1,
      quantity: '3', named: { orderType: 'PP01' },
    })).rejects.toThrow(/does not replace it/);
    const changed = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PRDLEGACY1', expectedVersion: 1, quantity: '3',
    });
    expect(changed.changed).toBe(true);
    expect(changed.order.orderType).toBeNull();
    const released = await releaseProductionOrder({
      client: tenant.client, orderNumber: 'PRDLEGACY1', releasedBy: ACTOR,
    });
    expect(released.status).toBe('RELEASED');
    expect(released.orderType).toBeNull();
    const replay = await createProductionOrder({
      client: tenant.client, createdBy: ACTOR, requestKey: 'legacy-null',
      materialNumber: 'AUART-FG', plant: PLANT, orderQuantity: 1,
      scheduledStart: '2026-11-02', scheduledFinish: '2026-11-06',
      orderType: 'PP01',
      components: [{ materialNumber: 'AUART-RM', plant: PLANT, requiredQuantity: 1 }],
    });
    expect(replay.orderNumber).toBe('PRDLEGACY1');
    expect(replay.orderType).toBeNull();
    const again = await getProductionOrder(tenant.client, 'PRDLEGACY1');
    expect(again?.orderType).toBeNull();
    expect(again?.status).toBe('RELEASED');
    expect(Number(again?.orderQuantity)).toBe(3);
    expect(Number(read?.orderQuantity)).toBe(1);
  });

  it('accepts a same-tenant type on a direct insert and rejects a type that does not stand', async () => {
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_order (
        client, order_number, material_number, plant, order_quantity, unit_of_measure,
        scheduled_start, scheduled_finish, order_type, created_by
      ) values (
        ${tenant.client}, 'PRDTYPED1', 'AUART-FG', ${PLANT}, 1, 'PC',
        '2026-11-02', '2026-11-06', 'PP01', ${ACTOR}
      )
    `));
    const stored = await getProductionOrder(tenant.client, 'PRDTYPED1');
    expect(stored?.orderType).toBe('PP01');
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_order (
        client, order_number, material_number, plant, order_quantity, unit_of_measure,
        scheduled_start, scheduled_finish, order_type, created_by
      ) values (
        ${tenant.client}, 'PRDMISS1', 'AUART-FG', ${PLANT}, 1, 'PC',
        '2026-11-02', '2026-11-06', 'ZZ99', ${ACTOR}
      )
    `))).rejects.toThrow();
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_order_type (client, order_type, description, order_category, created_by)
      values (${tenant.client}, 'PP40', 'Wrong category', '40', ${ACTOR})
    `))).rejects.toThrow(/order_category|category/i);
    const [left] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order where client = ${tenant.client} and order_number = 'PRDMISS1'
    `)) as unknown as Array<{ n: number }>;
    expect(left?.n).toBe(0);
  });

  it('does not let another tenant write its type onto this order', async () => {
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_order (
        client, order_number, material_number, plant, order_quantity, unit_of_measure,
        scheduled_start, scheduled_finish, order_type, created_by
      ) values (
        ${other.client}, 'PRDFOREIGN1', 'AUART-FG', ${PLANT}, 1, 'PC',
        '2026-11-02', '2026-11-06', 'PP01', ${ACTOR}
      )
    `))).rejects.toThrow();
  });

  it('keeps creation and conversion from reading checking control', () => {
    const create = readFileSync('src/modules/inventory/production-orders.ts', 'utf8');
    const conversion = readFileSync('src/modules/production/planned-order-conversion.ts', 'utf8');
    const co01 = readFileSync('src/app/production/orders/actions.ts', 'utf8');
    const co40 = readFileSync('src/app/production/planned-order-conversion/actions.ts', 'utf8');
    const co41 = readFileSync('src/app/production/planned-order-conversion-collective/actions.ts', 'utf8');
    for (const source of [create, conversion, co01, co40, co41]) {
      expect(source).not.toContain('checking-control');
    }
    expect(conversion).toContain('readProductionVersionSelection');
    expect(readFileSync('src/modules/production/order-bom-snapshot.ts', 'utf8')).toContain('readProductionVersionSelection');
    expect(create).toContain('An order-type parameter is not proof that the type stands.');
    expect(co01).toContain('A production order type is required. Nothing was saved.');
    expect(co01).not.toContain("orderType: text(form, 'orderType') || undefined");
    expect(readFileSync('src/app/production/orders/OrderCreate.tsx', 'utf8')).toMatch(/name="orderType"[^>]*required/);
    expect(conversion).toContain('A production order type is required. Nothing was converted.');
    expect(create).toContain("type.orderCategory !== '10'");
    expect(co40).toContain('An order type is required for conversion');
    expect(co41).toContain('An order type is required for conversion');
    expect(readFileSync('src/app/production/planned-order-conversion/ConvertForm.tsx', 'utf8')).toContain('name="orderType"');
    expect(conversion).not.toMatch(/from ['"].*stock-requirements|from ['"].*checking-control/);
    expect(runtimeProductionOrderWriters()).toEqual(['src/modules/inventory/production-orders.ts']);
  });

  it('does not add an order-type trigger, so a stored null row can still be updated', async () => {
    const triggers = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select t.tgname
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
       where c.relname = 'production_order' and not t.tgisinternal
    `)) as unknown as Array<{ tgname: string }>;
    expect(triggers).toEqual([]);
  });
});

function runtimeProductionOrderWriters(): string[] {
  const hits: string[] = [];
  const pattern = /insert\s+into\s+production_order\b|insert\(productionOrder\)/;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!name.endsWith('.ts') && !name.endsWith('.tsx') && !name.endsWith('.sql')) continue;
      if (pattern.test(readFileSync(path, 'utf8'))) hits.push(path);
    }
  };
  walk('src');
  walk('scripts');
  return hits.sort();
}
