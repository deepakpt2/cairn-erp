import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as change from '../src/platform/change';
import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import {
  PRODUCTION_ORDER_CHANGE_CAPABILITY,
  changeProductionOrder,
  productionOrderChangeRefusal,
  revokeTechnicalCompletion,
  technicallyCompleteProductionOrder,
} from '../src/modules/production/production-order-change';
import {
  getProductionOrderDisplay,
  listProductionOrders,
  productionOrderDisplayRefusal,
} from '../src/modules/production/production-order-display';
import { runOrderInformation } from '../src/modules/production/order-information';
import { parseProductionOrderStatus } from '../src/modules/production/production-order-status';
import { stockRequirementsList } from '../src/modules/production/stock-requirements';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'CO02_TECO';
const PLANT = 'QTCO';
const HELD = [PRODUCTION_ORDER_CHANGE_CAPABILITY];

describe('CO02 technical completion', () => {
  let tenant: TestTenant;
  let other: TestTenant;

  async function order(key: string) {
    const created = await createProductionOrder({
      orderType: 'PP01',
      client: tenant.client,
      createdBy: ACTOR,
      requestKey: key,
      materialNumber: 'TECO-FG',
      plant: PLANT,
      orderQuantity: 8,
      scheduledStart: '2026-10-24',
      scheduledFinish: '2026-10-30',
      components: [{ materialNumber: 'TECO-RM', plant: PLANT, requiredQuantity: 2 }],
    });
    const standing = await header(created.orderNumber);
    return { ...created, version: Number(standing.version) };
  }

  async function header(orderNumber: string) {
    const [row] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select status, version, order_quantity::text as quantity,
             released_by, released_at, technically_completed_by, technically_completed_at,
             (select count(*) from production_order_component
               where client = ${tenant.client} and order_number = ${orderNumber})::int as components
        from production_order
       where client = ${tenant.client} and order_number = ${orderNumber}
    `)) as unknown as Array<{
      status: string;
      version: number;
      quantity: string;
      released_by: string | null;
      released_at: Date | null;
      technically_completed_by: string | null;
      technically_completed_at: Date | null;
      components: number;
    }>;
    return row!;
  }

  async function audits(orderNumber: string) {
    return withTenant(tenant.client, (tx) => tx.execute(sql`
      select d.change_type, d.changed_by, d.transaction_code, i.field_name, i.old_value, i.new_value
        from change_document d
        left join change_document_item i on i.change_document_id = d.id
       where d.client = ${tenant.client} and d.object_class = 'production_order' and d.object_key = ${orderNumber}
       order by d.changed_at, i.field_name
    `)) as unknown as Promise<Array<{
      change_type: string;
      changed_by: string;
      transaction_code: string | null;
      field_name: string | null;
      old_value: string | null;
      new_value: string | null;
    }>>;
  }

  function life(orderNumber: string, expectedVersion: number, held: readonly string[] = HELD, confirmed = true) {
    return {
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber,
      expectedVersion,
      held,
      confirmed,
    };
  }

  beforeAll(async () => {
    tenant = await createTenant('co02-teco');
    other = await createTenant('co02-teco-other');
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${tenant.client}, v.n, v.d, t.material_type, 'PC', ${ACTOR}
        from (values ('TECO-FG', 'Finished'), ('TECO-RM', 'Component')) as v(n, d)
        cross join (select material_type from material_type where client = ${tenant.client} order by material_type limit 1) t
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${tenant.client}, ${PLANT}, 'Completion plant', c.company_code, 'KW', ${ACTOR}
        from (select company_code from company_code where client = ${tenant.client} order by company_code limit 1) c
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        select ${tenant.client}, v.n, ${PLANT}, ${ACTOR}
        from (values ('TECO-FG'), ('TECO-RM')) as v(n)
      `);
      await defineRange(tx, {
        client: tenant.client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${tenant.client}, 'PP01', 'Standard production', '10', ${ACTOR})
        on conflict (client, order_type) do nothing
      `);
    });
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
    await closeDb();
  });

  it('keeps technical completion off the quantity save and on the change screen', () => {
    expect(productionOrderChangeRefusal({ teco: 'X' })).toMatch(/not a status/);
    expect(productionOrderDisplayRefusal({ teco: 'X' })).toMatch(/not a display key/);
    expect(parseProductionOrderStatus('TECO')).toBeNull();
    expect(parseProductionOrderStatus('CLOSED')).toBeNull();
    expect(parseProductionOrderStatus('TECHNICALLY_COMPLETED')).toBe('TECHNICALLY_COMPLETED');
    const page = readFileSync('src/app/production/production-order-change/page.tsx', 'utf8');
    const form = readFileSync('src/app/production/production-order-change/OrderChangeForm.tsx', 'utf8');
    const actions = readFileSync('src/app/production/production-order-change/actions.ts', 'utf8');
    expect(page).toContain('technically complete');
    expect(form).toContain('data-co02-status');
    expect(form).toContain('data-co02-teco');
    expect(form).toContain('data-co02-revoke-teco');
    expect(form).toContain('completed.order ?? revoked.order ?? saved.order ?? order');
    expect(form).toContain('disabled={editsLocked}');
    expect(actions).toContain('confirmed: true');
    expect(actions).toContain('held: session.user.capabilities');
    expect(actions).toContain('ok: false');
  });

  it('completes a created order and a released order, then revokes to the prior status', async () => {
    const created = await order('teco-created');
    const completed = await technicallyCompleteProductionOrder(life(created.orderNumber, created.version));
    expect(completed.order.status).toBe('TECHNICALLY_COMPLETED');
    expect(completed.order.technicallyCompletedBy).toBe(ACTOR);
    expect(completed.order.technicallyCompletedAt).toBeTruthy();
    expect(completed.changed).toBe(true);
    const createdHeader = await header(created.orderNumber);
    expect(createdHeader.status).toBe('TECHNICALLY_COMPLETED');
    expect(createdHeader.components).toBe(1);
    expect(createdHeader.quantity).toBe('8.000');
    expect(createdHeader.released_by).toBeNull();

    const revoked = await revokeTechnicalCompletion(life(created.orderNumber, completed.order.version));
    expect(revoked.order.status).toBe('CREATED');
    expect(revoked.order.technicallyCompletedBy).toBeNull();
    expect(revoked.order.technicallyCompletedAt).toBeNull();
    expect((await header(created.orderNumber)).released_by).toBeNull();

    const released = await order('teco-released');
    await releaseProductionOrder({ client: tenant.client, orderNumber: released.orderNumber, releasedBy: ACTOR });
    const releasedHeader = await header(released.orderNumber);
    const done = await technicallyCompleteProductionOrder(life(released.orderNumber, Number(releasedHeader.version)));
    expect(done.order.status).toBe('TECHNICALLY_COMPLETED');
    expect(done.order.releasedBy).toBe(ACTOR);
    const restored = await revokeTechnicalCompletion(life(released.orderNumber, done.order.version));
    expect(restored.order.status).toBe('RELEASED');
    expect(restored.order.releasedBy).toBe(ACTOR);
    expect((await header(released.orderNumber)).technically_completed_by).toBeNull();
  });

  it('refuses a missing authority, an unconfirmed action, a repeat, and a stale version without a second audit', async () => {
    const created = await order('teco-guards');
    await expect(technicallyCompleteProductionOrder(life(created.orderNumber, created.version, []))).rejects.toThrow(/do not hold the authority/);
    await expect(technicallyCompleteProductionOrder(life(created.orderNumber, created.version, HELD, false))).rejects.toThrow(/not confirmed/);
    expect((await header(created.orderNumber)).status).toBe('CREATED');
    expect((await audits(created.orderNumber)).some((row) => row.change_type === 'TECO')).toBe(false);

    const done = await technicallyCompleteProductionOrder(life(created.orderNumber, created.version));
    await expect(technicallyCompleteProductionOrder(life(created.orderNumber, done.order.version))).rejects.toThrow(/already technically complete/);
    await expect(technicallyCompleteProductionOrder(life(created.orderNumber, created.version))).rejects.toThrow(/changed by someone else/);
    const standing = await header(created.orderNumber);
    expect(standing.status).toBe('TECHNICALLY_COMPLETED');
    expect(Number(standing.version)).toBe(done.order.version);
    const rows = await audits(created.orderNumber);
    expect(rows.filter((row) => row.change_type === 'TECO')).toHaveLength(2);
    expect(rows.filter((row) => row.change_type === 'REVOKE_TECO')).toHaveLength(0);

    await expect(revokeTechnicalCompletion(life(created.orderNumber, created.version))).rejects.toThrow(/changed by someone else/);
    await expect(revokeTechnicalCompletion({ ...life(created.orderNumber, done.order.version), client: other.client })).rejects.toThrow(/does not stand/);
    expect((await header(created.orderNumber)).status).toBe('TECHNICALLY_COMPLETED');
  });

  it('rolls back when the audit write fails, and does not guess a prior status', async () => {
    const created = await order('teco-audit');
    const spy = vi.spyOn(change, 'recordChange').mockRejectedValueOnce(new Error('audit down'));
    await expect(technicallyCompleteProductionOrder(life(created.orderNumber, created.version))).rejects.toThrow(/audit down/);
    spy.mockRestore();
    const standing = await header(created.orderNumber);
    expect(standing.status).toBe('CREATED');
    expect(Number(standing.version)).toBe(created.version);
    expect((await audits(created.orderNumber)).some((row) => row.change_type === 'TECO')).toBe(false);

    const done = await technicallyCompleteProductionOrder(life(created.orderNumber, created.version));
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update production_order
         set released_by = ${ACTOR}, released_at = null
       where client = ${tenant.client} and order_number = ${created.orderNumber}
    `));
    await expect(revokeTechnicalCompletion(life(created.orderNumber, done.order.version))).rejects.toThrow(/release record is incomplete/);
    expect((await header(created.orderNumber)).status).toBe('TECHNICALLY_COMPLETED');
    expect((await audits(created.orderNumber)).filter((row) => row.change_type === 'REVOKE_TECO')).toHaveLength(0);
  });

  it('refuses quantity, component, and release changes, and records the status transition', async () => {
    const created = await order('teco-frozen');
    await releaseProductionOrder({ client: tenant.client, orderNumber: created.orderNumber, releasedBy: ACTOR });
    const before = await header(created.orderNumber);
    const done = await technicallyCompleteProductionOrder(life(created.orderNumber, Number(before.version)));
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber,
      expectedVersion: done.order.version, quantity: '9',
    })).rejects.toThrow(/technically complete/);
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber,
      expectedVersion: done.order.version,
      components: [{ itemNumber: 10, materialNumber: 'TECO-RM', requiredQuantity: '3', unit: 'PC' }],
    })).rejects.toThrow(/technically complete/);
    await expect(releaseProductionOrder({
      client: tenant.client, orderNumber: created.orderNumber, releasedBy: ACTOR,
    })).rejects.toThrow(/technically complete/);
    expect(await header(created.orderNumber)).toMatchObject({
      status: 'TECHNICALLY_COMPLETED', quantity: '8.000', components: 1,
    });
    const rows = await audits(created.orderNumber);
    const status = rows.find((row) => row.change_type === 'TECO' && row.field_name === 'status');
    expect(status).toMatchObject({
      changed_by: ACTOR,
      transaction_code: 'CO02',
      old_value: 'RELEASED',
      new_value: 'TECHNICALLY_COMPLETED',
    });
  });

  it('shows technical completion on CO03 and COOIS and does not coerce it to created', async () => {
    const created = await order('teco-readers');
    const open = await order('teco-open');
    const done = await technicallyCompleteProductionOrder(life(created.orderNumber, created.version));
    const shown = await getProductionOrderDisplay(tenant.client, created.orderNumber);
    expect(shown?.status).toBe('TECHNICALLY_COMPLETED');
    expect(shown?.status).not.toBe('CREATED');
    expect(shown?.technicallyCompletedBy).toBe(ACTOR);
    const listed = await listProductionOrders(tenant.client, { plant: PLANT, status: 'TECHNICALLY_COMPLETED' });
    expect(listed.rows.map((row) => row.orderNumber)).toContain(created.orderNumber);
    expect(listed.rows.every((row) => row.status === 'TECHNICALLY_COMPLETED')).toBe(true);
    await expect(listProductionOrders(tenant.client, { plant: PLANT, status: 'CLOSED' })).rejects.toThrow(/not a production-order status/);
    const hidden = await getProductionOrderDisplay(other.client, created.orderNumber);
    expect(hidden).toBeNull();

    const headers = await runOrderInformation(tenant.client, { listType: 'HEADERS', plant: PLANT });
    const row = headers.rows.find((item) => item.orderNumber === created.orderNumber);
    expect(row?.status).toBe('TECHNICALLY_COMPLETED');
    const createdOnly = await runOrderInformation(tenant.client, { listType: 'HEADERS', plant: PLANT, status: 'CREATED' });
    expect(createdOnly.rows.map((item) => item.orderNumber)).not.toContain(created.orderNumber);
    expect(createdOnly.rows.map((item) => item.orderNumber)).toContain(open.orderNumber);
    const completedOnly = await runOrderInformation(tenant.client, {
      listType: 'HEADERS', plant: PLANT, status: 'TECHNICALLY_COMPLETED',
    });
    expect(completedOnly.rows.map((item) => item.orderNumber)).toContain(created.orderNumber);
    expect(completedOnly.rows.map((item) => item.orderNumber)).not.toContain(open.orderNumber);
    await expect(runOrderInformation(tenant.client, { listType: 'HEADERS', plant: PLANT, status: 'TECO' })).rejects.toThrow(/not a production-order status/);
    expect(done.order.version).toBeGreaterThan(created.version);
  });

  it('excludes a technically completed order from the stock requirements receipt', async () => {
    const created = await order('teco-md04');
    const open = await order('teco-md04-open');
    await technicallyCompleteProductionOrder(life(created.orderNumber, created.version));
    const list = await stockRequirementsList({
      client: tenant.client,
      today: '2026-10-24',
      selection: { material: 'TECO-FG', plant: PLANT },
    });
    const receipts = list.rows.filter((row) => row.elementType === 'PRODUCTION_ORDER');
    expect(receipts.map((row) => row.documentNumber)).toContain(open.orderNumber);
    expect(receipts.map((row) => row.documentNumber)).not.toContain(created.orderNumber);
  });

  it('lets one completion win a version conflict and writes one audit', async () => {
    const created = await order('teco-race');
    const raced = await Promise.allSettled([
      technicallyCompleteProductionOrder(life(created.orderNumber, created.version)),
      technicallyCompleteProductionOrder(life(created.orderNumber, created.version)),
    ]);
    expect(raced.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect((await header(created.orderNumber)).status).toBe('TECHNICALLY_COMPLETED');
    const rows = await audits(created.orderNumber);
    expect(rows.filter((row) => row.change_type === 'TECO' && row.field_name === 'status')).toHaveLength(1);
  });
});
