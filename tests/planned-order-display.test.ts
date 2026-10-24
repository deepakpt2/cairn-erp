import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { mrpController, productionOrder } from '../src/modules/inventory/schema';
import { mrpDependentRequirement, plannedOrder } from '../src/modules/production/schema';
import {
  PlannedOrderDisplayError,
  getPlannedOrder,
  holdsPlannedOrderDisplayAuthority,
  listPlannedOrders,
  plannedOrderDisplayRefusal,
} from '../src/modules/production/planned-order-display';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'MD13_TEST';
let tenant: TestTenant;
let other: TestTenant;

async function materialOf(client: string, materialNumber: string, description: string) {
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Display test', view: 'BASIC', description, materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
}

beforeAll(async () => {
  tenant = await createTenant('md13-display');
  other = await createTenant('md13-display-other');
  await withTenant(tenant.client, (tx) => tx.insert(mrpController).values({
    client: tenant.client, controller: '001', name: 'Controller 001', isActive: true, createdBy: ACTOR,
  }).onConflictDoNothing());
  await materialOf(tenant.client, 'FG-13', 'Finished good');
  await materialOf(tenant.client, 'COMP-13', 'Component');
  await saveMaterialView({
    client: tenant.client, materialNumber: 'FG-13', changedBy: ACTOR, expectedVersion: 0,
    reason: 'Display test', view: 'MRP', plant: '1000',
    mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: 'MAKE', lotSizing: 'EXACT',
    fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '0', reorderPoint: '0',
    plannedDeliveryDays: 0, inHouseProductionDays: 1,
  });
  await withTenant(tenant.client, async (tx) => {
    await tx.insert(plannedOrder).values([
      {
        client: tenant.client, orderNumber: 'PL-0000001', materialNumber: 'FG-13', plant: '1000',
        quantity: '12.500', unit: 'KG', startDate: '2026-10-01', finishDate: '2026-10-05',
        firmingStatus: 'FIRMED', origin: 'MRP', requestKey: 'md13-1', createdBy: ACTOR,
      },
      {
        client: tenant.client, orderNumber: 'PL-0000002', materialNumber: 'FG-13', plant: '1000',
        quantity: '1', unit: 'KG', startDate: '2026-10-02', finishDate: '2026-10-03',
        firmingStatus: 'OPEN', origin: 'MRP', requestKey: 'md13-2', createdBy: ACTOR,
      },
    ]);
    await tx.insert(mrpDependentRequirement).values({
      client: tenant.client, parentOrderNumber: 'PL-0000001', sourceMaterial: 'FG-13', itemNumber: '0010',
      materialNumber: 'COMP-13', plant: '1000', quantity: '25.000', unit: 'KG', requirementDate: '2026-10-01',
      parentMaterial: 'FG-13', status: 'OPEN', createdBy: ACTOR,
    });
    await tx.insert(productionOrder).values({
      client: tenant.client, orderNumber: '1000001', materialNumber: 'FG-13', plant: '1000',
      orderQuantity: '12.500', unitOfMeasure: 'KG', scheduledStart: '2026-10-01', scheduledFinish: '2026-10-05',
      status: 'CREATED', requestKey: 'md13-po', createdBy: ACTOR,
    });
  });
});

afterAll(async () => {
  await destroyTenant(tenant.client);
  await destroyTenant(other.client);
  await closeDb();
});

async function stamp() {
  const [row] = await withTenant(tenant.client, (tx) => tx.select({
    quantity: plannedOrder.quantity,
    unit: plannedOrder.unit,
    firmingStatus: plannedOrder.firmingStatus,
    version: plannedOrder.version,
    changedAt: plannedOrder.changedAt,
    changedBy: plannedOrder.changedBy,
  }).from(plannedOrder).where(and(eq(plannedOrder.client, tenant.client), eq(plannedOrder.orderNumber, 'PL-0000001'))));
  return row;
}

describe('MD13 display planned order', () => {
  it('shows the stored order and writes nothing', async () => {
    const before = await stamp();
    const shown = await getPlannedOrder(tenant.client, 'PL-0000001');
    expect(shown).toMatchObject({
      orderNumber: 'PL-0000001',
      materialNumber: 'FG-13',
      materialDescription: 'Finished good',
      plant: '1000',
      quantity: '12.500',
      unit: 'KG',
      startDate: '2026-10-01',
      finishDate: '2026-10-05',
      firmingStatus: 'FIRMED',
      origin: 'MRP',
      procurementType: 'MAKE',
      mrpController: '001',
      mrpControllerName: 'Primary planner',
      converted: false,
    });
    expect(shown?.dependents).toEqual([expect.objectContaining({
      componentMaterial: 'COMP-13', quantity: '25.000', unit: 'KG', status: 'OPEN',
    })]);
    expect(await stamp()).toEqual(before);
    expect(await getPlannedOrder(other.client, 'PL-0000001')).toBeNull();
    expect(await getPlannedOrder(tenant.client, 'pl-0000001')).toBeNull();
    expect(await getPlannedOrder(tenant.client, 'PL-MISSING')).toBeNull();
  });

  it('lists authorized matches and does not open the first', async () => {
    const before = await stamp();
    const listed = await listPlannedOrders(tenant.client, { plant: '1000', materialNumber: 'FG-13' });
    expect(listed.total).toBe(2);
    expect(listed.rows.map((row) => row.orderNumber)).toEqual(['PL-0000002', 'PL-0000001']);
    expect(listed.rows[0]).not.toHaveProperty('opened');
    expect(await stamp()).toEqual(before);
    await expect(listPlannedOrders(tenant.client, {})).rejects.toBeInstanceOf(PlannedOrderDisplayError);
    await expect(getPlannedOrder(tenant.client, 'PL-000000000001')).rejects.toThrow(/too long/);
    await expect(getPlannedOrder(tenant.client, '   ')).rejects.toThrow(/required/);
  });

  it('refuses fields the order does not store', () => {
    expect(plannedOrderDisplayRefusal({ mrpArea: '001' })).toMatch(/MRP area/);
    expect(plannedOrderDisplayRefusal({ deletionIndicator: 'X' })).toMatch(/does not remove/);
    expect(plannedOrderDisplayRefusal({ convert: 'X' })).toMatch(/not inferred/);
    expect(plannedOrderDisplayRefusal({ firming: 'FIRMED' })).toMatch(/does not firm/);
    expect(plannedOrderDisplayRefusal({ productionVersion: '0001' })).toMatch(/not stored/);
    expect(plannedOrderDisplayRefusal({})).toBeNull();
    expect(holdsPlannedOrderDisplayAuthority(['PROD.PLANNEDORDER.DISPLAY'])).toBe(true);
    expect(holdsPlannedOrderDisplayAuthority([])).toBe(false);
    const source = readFileSync('src/modules/production/planned-order-display.ts', 'utf8');
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(|sql`\s*(insert|update|delete)/i);
    expect(source).toContain('planned_order_number');
    expect(source).not.toMatch(/insert into production_order|createProductionOrder|convertPlannedOrder/i);
    const page = readFileSync('src/app/production/planned-order-display/page.tsx', 'utf8');
    expect(page).toContain('The first was not opened.');
    expect(page).not.toContain('use server');
    expect(page).not.toMatch(/firmPlannedOrder|changePlannedOrder|convertPlannedOrder|deletePlannedOrder/);
  });
});
