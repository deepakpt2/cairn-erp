import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { changeDocument } from '../src/platform/tables/audit-trail';
import { createProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import {
  ProductionOrderDisplayError,
  getProductionOrderDisplay,
  listProductionOrders,
  productionOrderDisplayRefusal,
} from '../src/modules/production/production-order-display';
import {
  ProductionOrderChangeError,
  changeProductionOrder,
  productionOrderChangeRefusal,
} from '../src/modules/production/production-order-change';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'CO02_TEST';
const PLANT = 'QO02';
let tenant: TestTenant;
let other: TestTenant;

async function order(key: string, quantity = 10) {
  return createProductionOrder({
    orderType: 'PP01',
    client: tenant.client,
    createdBy: ACTOR,
    requestKey: key,
    materialNumber: 'CO02-FG',
    plant: PLANT,
    orderQuantity: quantity,
    scheduledStart: '2026-10-24',
    scheduledFinish: '2026-10-30',
    components: [{ materialNumber: 'CO02-RM', plant: PLANT, requiredQuantity: 2 }],
  });
}

async function stamp(orderNumber: string) {
  const [row] = await withTenant(tenant.client, (tx) => tx.execute(sql`
    select version, status, order_quantity::text as quantity, changed_at
      from production_order
     where client = ${tenant.client} and order_number = ${orderNumber}
  `)) as unknown as Array<{ version: number; status: string; quantity: string; changed_at: Date | null }>;
  return row;
}

beforeAll(async () => {
  tenant = await createTenant('co02-change');
  other = await createTenant('co02-other');
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${tenant.client}, v.n, v.d, t.material_type, 'PC', ${ACTOR}
      from (values ('CO02-FG', 'Finished'), ('CO02-RM', 'Component'), ('CO02-RM2', 'Second')) as v(n, d)
      cross join (select material_type from material_type where client = ${tenant.client} order by material_type limit 1) t
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      select ${tenant.client}, ${PLANT}, 'Order plant', c.company_code, 'KW', ${ACTOR}
      from (select company_code from company_code where client = ${tenant.client} order by company_code limit 1) c
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      select ${tenant.client}, v.n, ${PLANT}, ${ACTOR}
      from (values ('CO02-FG'), ('CO02-RM'), ('CO02-RM2')) as v(n)
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

describe('CO03 display production order', () => {
  it('shows the stored order and writes nothing', async () => {
    const created = await order('display-1');
    const before = await stamp(created.orderNumber);
    const shown = await getProductionOrderDisplay(tenant.client, created.orderNumber);
    expect(shown).toMatchObject({
      orderNumber: created.orderNumber,
      materialNumber: 'CO02-FG',
      plant: PLANT,
      quantity: '10.000',
      unit: 'PC',
      status: 'CREATED',
      plannedOrderNumber: null,
      receivedQuantity: '0.000',
      version: 1,
    });
    expect(shown).toMatchObject({
      productionVersion: null,
      bomUsage: null,
      bomAlternative: null,
    });
    expect(shown?.components[0]).toMatchObject({
      itemNumber: 10,
      bomItem: null,
      sourceMaterial: null,
      materialNumber: 'CO02-RM', requiredQuantity: '2.000', issuedQuantity: '0.000', remainingQuantity: '2.000',
    });
    expect(shown?.gaps.join(' ')).toMatch(/Operations are not stored/);
    expect(shown?.gaps.join(' ')).toMatch(/were not recorded/);
    expect(shown?.gaps.join(' ')).not.toMatch(/is not stored on the order/);
    expect(shown?.gaps.join(' ')).not.toMatch(/does not read a material BOM/);
    expect(await stamp(created.orderNumber)).toEqual(before);
    expect(await getProductionOrderDisplay(other.client, created.orderNumber)).toBeNull();
    const listed = await listProductionOrders(tenant.client, { plant: PLANT });
    expect(listed.rows.some((row) => row.orderNumber === created.orderNumber)).toBe(true);
    await expect(listProductionOrders(tenant.client, { plant: PLANT, status: 'TECO' })).rejects.toBeInstanceOf(ProductionOrderDisplayError);
    expect(productionOrderDisplayRefusal({ orderType: 'PP01' })).toMatch(/not a search key/);
    expect(productionOrderDisplayRefusal({ operation: '0010' })).toMatch(/not stored/);
    expect(productionOrderDisplayRefusal({ productionVersion: '0001' })).toMatch(/not a search key/);
    expect(productionOrderDisplayRefusal({ productionVersion: '0001' })).not.toMatch(/not stored/);
    expect(productionOrderDisplayRefusal({ productionVersion: '0001' })).not.toMatch(/does not read a material BOM/);
  });

  it('shows a stored BOM snapshot and does not treat the line number as the BOM item', async () => {
    const created = await order('display-snapshot');
    const before = await stamp(created.orderNumber);
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update production_order
           set production_version = '0001', bom_usage = 'P', bom_alternative = '01'
         where client = ${tenant.client} and order_number = ${created.orderNumber}
      `);
      await tx.execute(sql`
        update production_order_component
           set bom_item = 'A010', source_material = 'CO02-FG'
         where client = ${tenant.client} and order_number = ${created.orderNumber} and item_number = 10
      `);
    });
    const shown = await getProductionOrderDisplay(tenant.client, created.orderNumber);
    expect(shown).toMatchObject({
      productionVersion: '0001',
      bomUsage: 'P',
      bomAlternative: '01',
    });
    expect(shown?.components[0]).toMatchObject({
      itemNumber: 10,
      bomItem: 'A010',
      sourceMaterial: 'CO02-FG',
      materialNumber: 'CO02-RM',
    });
    expect(shown?.components[0]?.bomItem).not.toBe(String(shown?.components[0]?.itemNumber));
    expect(shown?.gaps.join(' ')).toMatch(/determination that selected this snapshot/);
    expect(shown?.gaps.join(' ')).toMatch(/not proof|not applied|does not re-read/);
    expect(shown?.gaps.join(' ')).not.toMatch(/is not stored on the order/);
    expect(await stamp(created.orderNumber)).toEqual(before);
  });
});

describe('CO02 change production order', () => {
  it('changes quantity without rescaling components or releasing', async () => {
    const created = await order('change-1');
    const saved = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, expectedVersion: 1,
      quantity: '12', startDate: '2026-10-25',
    });
    expect(saved.changed).toBe(true);
    expect(saved.order.status).toBe('CREATED');
    expect(saved.order.quantity).toBe('12.000');
    expect(saved.order.scheduledStart).toBe('2026-10-25');
    expect(saved.order.components[0]?.requiredQuantity).toBe('2.000');
    expect(saved.warnings.join(' ')).toMatch(/not rescaled/);
    const unchanged = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, expectedVersion: saved.order.version,
      quantity: '12.000',
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.order.version).toBe(saved.order.version);
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, expectedVersion: 1, quantity: '13',
    })).rejects.toThrow(/changed by someone else/);
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, expectedVersion: saved.order.version, unit: 'KG',
    })).rejects.toThrow(/not substituted/);
    expect(productionOrderChangeRefusal({ release: 'X' })).toMatch(/does not release/);
    expect(productionOrderChangeRefusal({ teco: 'X' })).toMatch(/not a status/);
    const history = await withTenant(tenant.client, (tx) => tx.select({ changeType: changeDocument.changeType }).from(changeDocument).where(sql`
      ${changeDocument.client} = ${tenant.client} and ${changeDocument.objectKey} = ${created.orderNumber} and ${changeDocument.changeType} = 'CHANGE'
    `));
    expect(history.length).toBeGreaterThan(0);
  });

  it('adds and removes a component, and refuses the last component', async () => {
    const created = await order('component-1');
    const added = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, expectedVersion: 1,
      components: [{ materialNumber: 'CO02-RM2', requiredQuantity: '1' }],
    });
    expect(added.order.components.map((row) => row.materialNumber)).toEqual(['CO02-RM', 'CO02-RM2']);
    const addedItem = added.order.components[1]?.itemNumber;
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, expectedVersion: added.order.version,
      components: [
        { itemNumber: 10, materialNumber: 'CO02-RM', requiredQuantity: '2', remove: true },
        { itemNumber: addedItem, materialNumber: 'CO02-RM2', requiredQuantity: '1', remove: true },
      ],
    })).rejects.toThrow(/at least one component/);
    const standing = await stamp(created.orderNumber);
    expect(standing.version).toBe(added.order.version);
  });

  it('allows a released order with no movement, then freezes it after a goods movement', async () => {
    const created = await order('released-1', 8);
    await releaseProductionOrder({ client: tenant.client, orderNumber: created.orderNumber, releasedBy: ACTOR });
    const released = await getProductionOrderDisplay(tenant.client, created.orderNumber);
    expect(released?.status).toBe('RELEASED');
    expect(released?.version).toBe(2);
    const changed = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, expectedVersion: 2, quantity: '9',
    });
    expect(changed.order.status).toBe('RELEASED');
    expect(changed.order.quantity).toBe('9.000');
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into movement_type (
          client, movement_type, description, direction, reference_category, account_assignment, batch_classification, created_by
        ) values (
          ${tenant.client}, '261', 'Issue', 'ISSUE', 'PRODUCTION_ORDER', 'ORDER', ' ', ${ACTOR}
        ) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (
          client, material_document_number, document_year, document_date, posting_date, status, created_by
        ) values (
          ${tenant.client}, 'MD-CO02-1', 2026, '2026-10-24', '2026-10-24', 'POSTED', ${ACTOR}
        )
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          entry_quantity, entry_unit, base_quantity, base_unit, line_direction,
          production_order_number, production_order_item, created_by
        ) values (
          ${tenant.client}, 'MD-CO02-1', 1, '261', 'CO02-RM', ${PLANT},
          1, 'PC', 1, 'PC', 'ISSUE', ${created.orderNumber}, 10, ${ACTOR}
        )
      `);
    });
    const before = await stamp(created.orderNumber);
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, expectedVersion: changed.order.version, quantity: '11',
    })).rejects.toThrow(/goods movement/);
    expect(await stamp(created.orderNumber)).toEqual(before);
    const shown = await getProductionOrderDisplay(tenant.client, created.orderNumber);
    expect(shown?.components[0]?.issuedQuantity).toBe('1.000');
    expect(shown?.documents).toHaveLength(1);
  });

  it('rolls back a component that does not exist', async () => {
    const created = await order('rollback-1');
    const before = await stamp(created.orderNumber);
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, expectedVersion: 1,
      quantity: '15',
      components: [{ materialNumber: 'MISSING', requiredQuantity: '1' }],
    })).rejects.toThrow(/MISSING/);
    expect(await stamp(created.orderNumber)).toEqual(before);
  });
});

describe('CO03 screen contract', () => {
  it('does not expose a mutation', () => {
    const page = readFileSync('src/app/production/production-order-display/page.tsx', 'utf8');
    const service = readFileSync('src/modules/production/production-order-display.ts', 'utf8');
    expect(page).toContain('The first was not opened.');
    expect(page).toContain('data-production-version');
    expect(page).toContain('data-bom-item');
    expect(page).toContain('BOM item');
    expect(page).toContain('not recorded');
    expect(page).not.toContain('A production version is not stored');
    expect(page).not.toContain('does not read a material BOM');
    expect(service).toContain('o.production_version');
    expect(service).toContain('c.bom_item');
    expect(service).not.toContain('was read at conversion and was not copied');
    expect(service).not.toContain('does not read a material BOM');
    expect(page).not.toMatch(/changeProductionOrder|releaseProductionOrder|createProductionOrder/);
    expect(service).not.toMatch(/\.insert\(|\.update\(|\.delete\(|sql`\s*(insert|update|delete)/i);
    expect(readFileSync('scripts/seed.ts', 'utf8')).toContain("aliases: ['CO03']");
    expect(readFileSync('scripts/seed.ts', 'utf8')).toContain("aliases: ['CO02']");
  });
});
