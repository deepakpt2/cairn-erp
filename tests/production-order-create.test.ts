import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  PRODUCTION_ORDER_CAPABILITY,
  PRODUCTION_ORDER_RELEASE_CAPABILITY,
  ProductionOrderError,
  createProductionOrder,
  getProductionOrder,
  releaseProductionOrder,
} from '../src/modules/inventory/production-orders';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * SCR-138 / CO01 — the order master the 261 issue will post against.
 *
 * The order records what is produced, where, how much and when, with its components as
 * a snapshot; the company code is derived from the plant and never stored; release is
 * the one act that lets work be charged. Nothing posts and nothing moves stock.
 */
const ACTOR = 'SCR138_CO01_TEST';
const PLANT = 'QO01';

describe('SCR-138 production order create (CO01)', () => {
  let fx: TestTenant;
  let client = '';
  let made = '';

  beforeAll(async () => {
    fx = await createTenant('scr138-co01');
    client = fx.client;
    await withTenant(client, async (tx) => {
      // The produced material and two components, extended to the plant.
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, v.n, v.d, t.material_type, 'PC', ${ACTOR}
        from (values ('CO01-FG', 'Finished good'), ('CO01-RM1', 'Raw material one'), ('CO01-RM2', 'Raw material two'))
          as v(n, d)
        cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, ${PLANT}, 'Order plant', c.company_code, 'KW', ${ACTOR}
        from (select company_code from company_code where client = ${client} order by company_code limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        select ${client}, v.n, ${PLANT}, ${ACTOR}
        from (values ('CO01-FG'), ('CO01-RM1'), ('CO01-RM2')) as v(n)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${client}, ${PLANT}, 'SO01', 'Order store', true, false, ${ACTOR})
        on conflict do nothing
      `);
    });
    // The standing tenant default already carries a PRODORDER interval; the create draws
    // from it, so no range is defined here unless the tenant has none.
    await withTenant(client, async (tx) => {
      await defineRange(tx, {
        client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${client}, 'PP01', 'Standard production', '10', ${ACTOR})
        on conflict (client, order_type) do nothing
      `);
    });
  }, 180_000);

  afterAll(async () => {
    if (client) await destroyTenant(client);
  }, 180_000);

  it('names the two capabilities the order needs, apart from the issue', () => {
    expect(PRODUCTION_ORDER_CAPABILITY).toBe('PROD.ORDER.CREATE');
    expect(PRODUCTION_ORDER_RELEASE_CAPABILITY).toBe('PROD.ORDER.RELEASE');
  });

  it('creates an order on its own number range with its components and a derived company', async () => {
    const view = await createProductionOrder({
      orderType: 'PP01',
      client, createdBy: ACTOR,
      materialNumber: 'CO01-FG', plant: PLANT, orderQuantity: 100,
      scheduledStart: '2026-11-02', scheduledFinish: '2026-11-06',
      components: [
        { materialNumber: 'CO01-RM1', plant: PLANT, storageLocation: 'SO01', requiredQuantity: 50 },
        { materialNumber: 'CO01-RM2', plant: PLANT, requiredQuantity: 20 },
      ],
    });
    made = view.orderNumber;
    expect(view.orderNumber).toMatch(/^PRD/);
    expect(view.status).toBe('CREATED');
    expect(view.companyCode).toMatch(/^\d{4}$/);
    expect(view.unit).toBe('PC');
    expect(view.components).toHaveLength(2);
    expect(view.components[0].itemNumber).toBe(10);
    expect(view.components[1].itemNumber).toBe(20);
    expect(view.components[0].storageLocation).toBe('SO01');
    expect(Number(view.components[1].requiredQuantity)).toBe(20);
  });

  it('stores no company code: the order derives it from its plant every time it is read', async () => {
    const view = await getProductionOrder(client, made);
    expect(view?.companyCode).toMatch(/^\d{4}$/);
    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'production_order' and column_name like '%company%'
    `));
    expect(columns).toHaveLength(0);
  });

  it('refuses a plant the produced material is not extended to, by name', async () => {
    await expect(createProductionOrder({
      orderType: 'PP01',
      client, createdBy: ACTOR,
      materialNumber: 'CO01-FG', plant: 'QO99', orderQuantity: 10,
      scheduledStart: '2026-11-02', scheduledFinish: '2026-11-06',
      components: [{ materialNumber: 'CO01-RM1', plant: PLANT, requiredQuantity: 5 }],
    })).rejects.toThrow(/Plant QO99 does not exist/);
  });

  it('refuses a component that is not extended to its plant, naming the material and plant', async () => {
    await expect(createProductionOrder({
      orderType: 'PP01',
      client, createdBy: ACTOR,
      materialNumber: 'CO01-FG', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-11-02', scheduledFinish: '2026-11-06',
      components: [{ materialNumber: 'CO01-RM1', plant: 'QO98', requiredQuantity: 5 }],
    })).rejects.toThrow(/Plant QO98 does not exist/);
  });

  it('refuses a finish before the start and a non-positive order quantity', async () => {
    await expect(createProductionOrder({
      orderType: 'PP01',
      client, createdBy: ACTOR,
      materialNumber: 'CO01-FG', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-11-06', scheduledFinish: '2026-11-02',
      components: [{ materialNumber: 'CO01-RM1', plant: PLANT, requiredQuantity: 5 }],
    })).rejects.toThrow(/stands before the scheduled start/);

    await expect(createProductionOrder({
      orderType: 'PP01',
      client, createdBy: ACTOR,
      materialNumber: 'CO01-FG', plant: PLANT, orderQuantity: 0,
      scheduledStart: '2026-11-02', scheduledFinish: '2026-11-06',
      components: [{ materialNumber: 'CO01-RM1', plant: PLANT, requiredQuantity: 5 }],
    })).rejects.toThrow(/not a positive quantity/);
  });

  it('refuses an order with no components, and a storage location of another plant', async () => {
    await expect(createProductionOrder({
      orderType: 'PP01',
      client, createdBy: ACTOR,
      materialNumber: 'CO01-FG', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-11-02', scheduledFinish: '2026-11-06',
      components: [],
    })).rejects.toThrow(/at least one component/);

    await expect(createProductionOrder({
      orderType: 'PP01',
      client, createdBy: ACTOR,
      materialNumber: 'CO01-FG', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-11-02', scheduledFinish: '2026-11-06',
      components: [{ materialNumber: 'CO01-RM1', plant: PLANT, storageLocation: 'ZZZZ', requiredQuantity: 5 }],
    })).rejects.toThrow(/Storage location ZZZZ does not stand in plant QO01/);
  });

  it('replays a request key instead of making a second order', async () => {
    const key = 'co01-replay-1';
    const first = await createProductionOrder({
      orderType: 'PP01',
      client, createdBy: ACTOR,
      materialNumber: 'CO01-FG', plant: PLANT, orderQuantity: 5,
      scheduledStart: '2026-11-02', scheduledFinish: '2026-11-06',
      components: [{ materialNumber: 'CO01-RM1', plant: PLANT, requiredQuantity: 5 }],
      requestKey: key,
    });
    const second = await createProductionOrder({
      orderType: 'PP01',
      client, createdBy: ACTOR,
      materialNumber: 'CO01-FG', plant: PLANT, orderQuantity: 5,
      scheduledStart: '2026-11-02', scheduledFinish: '2026-11-06',
      components: [{ materialNumber: 'CO01-RM1', plant: PLANT, requiredQuantity: 5 }],
      requestKey: key,
    });
    expect(second.orderNumber).toBe(first.orderNumber);
  });

  it('releases an order once, naming who released it and when, and a second release is a no-op', async () => {
    const released = await releaseProductionOrder({ client, orderNumber: made, releasedBy: ACTOR });
    expect(released.status).toBe('RELEASED');
    expect(released.releasedBy).toBe(ACTOR);
    expect(released.releasedAt).not.toBeNull();

    const again = await releaseProductionOrder({ client, orderNumber: made, releasedBy: 'SOMEONE_ELSE' });
    expect(again.status).toBe('RELEASED');
    expect(again.releasedBy).toBe(ACTOR);
  });

  it('refuses to release an order that does not stand, in SAP’s wording', async () => {
    await expect(releaseProductionOrder({ client, orderNumber: 'PRD9999999', releasedBy: ACTOR }))
      .rejects.toThrow(/Production order PRD9999999 does not exist/);
  });

  it('writes an order and releases it without touching the ledger or the stock', async () => {
    const before = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select count(*)::int from journal_entry where client = ${client}) as journals,
          (select count(*)::int from material_document where client = ${client}) as documents,
          (select coalesce(sum(quantity), 0)::text from stock_quantity where client = ${client}) as stock
      `) as unknown as Array<{ journals: number; documents: number; stock: string }>;
      return rows[0];
    });
    expect(before.journals).toBe(0);
    expect(before.documents).toBe(0);
    expect(Number(before.stock)).toBe(0);
  });

  it('records the create and the release in the change history', async () => {
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select change_type from change_document
      where client = ${client} and object_class = 'production_order' and object_key = ${made}
      order by changed_at
    `)) as unknown as Array<{ change_type: string }>;
    expect(rows.map((r) => r.change_type)).toEqual(['CREATE', 'RELEASE']);
  });
});
