import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { getProductionOrder } from '../src/modules/inventory/production-orders';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { mrpController } from '../src/modules/inventory/schema';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { createProductionVersion } from '../src/modules/production/production-version';
import { createPlannedOrder } from '../src/modules/production/planned-order-create';
import { PlannedOrderChangeError, changePlannedOrder } from '../src/modules/production/planned-order-change';
import { getPlannedOrder } from '../src/modules/production/planned-order-display';
import { stockRequirementsList } from '../src/modules/production/stock-requirements';
import {
  PlannedOrderConversionError,
  convertPlannedOrder,
  convertPlannedOrders,
  listConvertiblePlannedOrders,
  listConversionLog,
  previewPlannedOrderConversion,
} from '../src/modules/production/planned-order-conversion';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'CO40_TEST';
let tenant: TestTenant;

async function materialOf(client: string, materialNumber: string, procurement?: 'MAKE' | 'BUY') {
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Conversion test', view: 'BASIC', description: materialNumber, materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
  if (!procurement) {
    await saveMaterialView({
      client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'Conversion test', view: 'PURCHASING', plant: '1000',
      purchasingGroup: '', orderUnit: 'KG', overdeliveryTolerance: '0',
      underdeliveryTolerance: '0', manufacturerPartNumber: '',
    });
    return;
  }
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Conversion test', view: 'MRP', plant: '1000',
    mrpType: 'NONE', mrpController: '001', procurementType: procurement, lotSizing: 'EXACT',
    fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '0', reorderPoint: '0',
    plannedDeliveryDays: 0, inHouseProductionDays: 0,
  });
}

async function planned(key: string, materialNumber = 'FG-40', quantity = '10') {
  return createPlannedOrder({
    client: tenant.client, changedBy: ACTOR, requestKey: key,
    materialNumber, plant: '1000', quantity, finishDate: '2026-10-30',
  });
}

async function counts() {
  const [row] = await withTenant(tenant.client, (tx) => tx.execute(sql`
    select
      (select count(*) from production_order where client = ${tenant.client})::int as orders,
      (select count(*) from material_document where client = ${tenant.client})::int as documents,
      (select count(*) from journal_entry where client = ${tenant.client})::int as journals,
      (select count(*) from reservation_header where client = ${tenant.client})::int as reservations
  `)) as unknown as Array<{ orders: number; documents: number; journals: number; reservations: number }>;
  return row;
}

beforeAll(async () => {
  tenant = await createTenant('co40-convert');
  await withTenant(tenant.client, async (tx) => {
    await tx.insert(mrpController).values({
      client: tenant.client, controller: '001', name: 'Controller 001', isActive: true, createdBy: ACTOR,
    }).onConflictDoNothing();
    await defineRange(tx, { client: tenant.client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client: tenant.client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
  });
  await materialOf(tenant.client, 'FG-40', 'MAKE');
  await materialOf(tenant.client, 'COMP-40');
  await materialOf(tenant.client, 'BUY-40', 'BUY');
  await withTenant(tenant.client, (tx) => tx.execute(sql`
    insert into planned_order (
      client, order_number, material_number, plant, quantity, unit, start_date, finish_date,
      firming_status, origin, request_key, created_by
    ) values (
      ${tenant.client}, 'PL-BUY40', 'BUY-40', '1000', 5, 'KG', '2026-10-30', '2026-10-30',
      'FIRMED', 'MANUAL', 'buy-40', ${ACTOR}
    )
  `));
  await saveBomUsage({
    client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
    productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
  });
  await saveBomItemCategory({
    client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock',
    materialEntry: '+', quantityEntry: '+',
  });
  await createMaterialBom({
    client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-40', plant: '1000', usage: 'P',
    alternative: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
    items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'COMP-40', quantity: '2', unit: 'KG' }],
  });
  await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
  await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
  await saveRoutingControlKey({ client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal' });
  await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
  await createWorkCenter({
    client: tenant.client, changedBy: ACTOR, plant: '1000', workCenter: 'WC40', category: 'MACH', description: 'Assembly',
  });
  await createRouting({
    client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: '1000', usage: '1',
    routingGroup: '50000041', groupCounter: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
    assignments: [{ materialNumber: 'FG-40' }],
    operations: [{ operationNumber: '0010', shortText: 'Cut', workCenter: 'WC40', controlKey: 'PP01' }],
  });
  await createProductionVersion({
    client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-40', plant: '1000', productionVersion: '0001',
    validFrom: '2026-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'KG',
    bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000041', groupCounter: '01',
  });
});

afterAll(async () => {
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('planned order conversion', () => {
  it('reviews without writing and refuses a filter that is not stored', async () => {
    const created = await planned('preview-1');
    const before = await counts();
    const preview = await previewPlannedOrderConversion(tenant.client, created.order.orderNumber);
    expect(preview?.eligible).toBe(true);
    expect(preview?.productionVersion).toBe('0001');
    expect(preview?.components[0]).toMatchObject({ materialNumber: 'COMP-40', requiredQuantity: '20.000', unit: 'KG' });
    expect(preview?.warnings.join(' ')).toMatch(/availability is not checked/i);
    expect(preview?.warnings.join(' ')).toMatch(/operations/i);
    const listed = await listConvertiblePlannedOrders(tenant.client, { plant: '1000', materialNumber: 'FG-40' });
    expect(listed.rows.some((row) => row.orderNumber === created.order.orderNumber)).toBe(true);
    await expect(listConvertiblePlannedOrders(tenant.client, {
      plant: '1000', named: { mrpArea: '0001' },
    })).rejects.toBeInstanceOf(PlannedOrderConversionError);
    expect(await counts()).toEqual(before);
  });

  it('converts the whole order once and does not post', async () => {
    const created = await planned('convert-1');
    const result = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber, expectedVersion: created.order.version,
    });
    expect(result.status).toBe('CONVERTED');
    expect(result.productionOrderStatus).toBe('CREATED');
    const production = await getProductionOrder(tenant.client, result.productionOrderNumber!);
    expect(production?.plannedOrderNumber).toBe(created.order.orderNumber);
    expect(production?.orderQuantity).toBe('10.000');
    expect(production?.components).toEqual([
      expect.objectContaining({ materialNumber: 'COMP-40', requiredQuantity: '20.000' }),
    ]);
    const standing = await getPlannedOrder(tenant.client, created.order.orderNumber);
    expect(standing?.quantity).toBe(created.order.quantity);
    expect(standing?.version).toBe(created.order.version);
    expect(standing?.converted).toBe(true);
    expect(standing?.productionOrderNumber).toBe(result.productionOrderNumber);
    const again = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber,
    });
    expect(again.status).toBe('ALREADY_CONVERTED');
    expect(again.productionOrderNumber).toBe(result.productionOrderNumber);
    const linked = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as total from production_order
       where client = ${tenant.client} and planned_order_number = ${created.order.orderNumber}
    `)) as unknown as Array<{ total: number }>;
    expect(linked[0].total).toBe(1);
    const log = await listConversionLog(tenant.client, created.order.orderNumber);
    expect(log.some((entry) => entry.reason?.includes(result.productionOrderNumber!))).toBe(true);
    const footprint = await counts();
    expect(footprint.documents).toBe(0);
    expect(footprint.journals).toBe(0);
    expect(footprint.reservations).toBe(0);
    await expect(changePlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber,
      expectedVersion: created.order.version, quantity: '11',
    })).rejects.toBeInstanceOf(PlannedOrderChangeError);
    const list = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24',
      selection: { material: 'FG-40', plant: '1000' },
    });
    expect(list.rows.some((row) => row.elementType === 'PRODUCTION_ORDER' && row.documentNumber === result.productionOrderNumber)).toBe(true);
    expect(list.rows.some((row) => row.elementType === 'PLANNED_ORDER' && row.documentNumber === created.order.orderNumber)).toBe(false);
  });

  it('does not infer conversion from another production order for the same material', async () => {
    const created = await planned('unconverted-1');
    const shown = await getPlannedOrder(tenant.client, created.order.orderNumber);
    expect(shown?.converted).toBe(false);
    expect(shown?.productionOrderNumber).toBeNull();
  });

  it('refuses a partial quantity and external procurement without creating an order', async () => {
    const created = await planned('partial-1');
    const before = await counts();
    await expect(convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber, quantity: '4',
    })).rejects.toThrow(/Partial conversion is not supported/);
    await expect(convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PL-BUY40',
    })).rejects.toThrow(/externally procured/);
    expect(await counts()).toEqual(before);
  });

  it('lets one collective failure stand beside one committed order', async () => {
    const created = await planned('collective-1');
    const result = await convertPlannedOrders({
      client: tenant.client, changedBy: ACTOR, correlationId: 'batch-1',
      orderNumbers: [created.order.orderNumber, 'MISSING', 'PL-BUY40'],
    });
    expect(result.results.map((row) => row.status)).toEqual(['CONVERTED', 'FAILED', 'FAILED']);
    expect(result.results[0].productionOrderNumber).toBeTruthy();
    const production = await getProductionOrder(tenant.client, result.results[0].productionOrderNumber!);
    expect(production?.plannedOrderNumber).toBe(created.order.orderNumber);
  });

  it('refuses more than 25 orders before writing', async () => {
    const before = await counts();
    await expect(convertPlannedOrders({
      client: tenant.client, changedBy: ACTOR, correlationId: 'too-many',
      orderNumbers: Array.from({ length: 26 }, (_, index) => `PL-${index}`),
    })).rejects.toThrow(/at most 25/);
    expect(await counts()).toEqual(before);
  });

  it('returns one production order when two conversions race', async () => {
    const created = await planned('race-1');
    const [first, second] = await Promise.all([
      convertPlannedOrder({ client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber }),
      convertPlannedOrder({ client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['ALREADY_CONVERTED', 'CONVERTED']);
    expect(first.productionOrderNumber).toBe(second.productionOrderNumber);
    const linked = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as total from production_order
       where client = ${tenant.client} and planned_order_number = ${created.order.orderNumber}
    `)) as unknown as Array<{ total: number }>;
    expect(linked[0].total).toBe(1);
  });
});
