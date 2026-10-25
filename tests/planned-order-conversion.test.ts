import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { getProductionOrder } from '../src/modules/inventory/production-orders';
import { saveProductionOrderType } from '../src/modules/production/production-order-type';
import { saveOrderTypeParameter } from '../src/modules/production/order-type-parameters';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { materialPlant, mrpController } from '../src/modules/inventory/schema';
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
    await tx.execute(sql`
      insert into production_order_type (client, order_type, description, order_category, created_by)
      values (${tenant.client}, 'PP01', 'Standard production', '10', ${ACTOR})
      on conflict (client, order_type) do nothing
    `);
  });
  await saveOrderTypeParameter({
    client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: '1000', orderType: 'PP01',
    taskListType: '', productionVersionSelection: '0', version: 0, reason: 'Automatic selection for conversion',
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
    expect(preview?.warnings.join(' ')).toMatch(/operation/i);
    expect(preview?.operationCount).toBe(1);
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
      orderType: 'PP01',
      client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber, expectedVersion: created.order.version,
    });
    expect(result.status).toBe('CONVERTED');
    expect(result.productionOrderStatus).toBe('CREATED');
    const production = await getProductionOrder(tenant.client, result.productionOrderNumber!);
    expect(production?.plannedOrderNumber).toBe(created.order.orderNumber);
    expect(production?.orderType).toBe('PP01');
    expect(production?.orderQuantity).toBe('10.000');
    expect(production?.components).toEqual([
      expect.objectContaining({ materialNumber: 'COMP-40', requiredQuantity: '20.000' }),
    ]);
    const copied = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select operation_number, short_text from production_order_operation
       where client = ${tenant.client} and order_number = ${result.productionOrderNumber}
       order by operation_number
    `)) as unknown as Array<{ operation_number: string; short_text: string }>;
    expect(copied.map((row) => [row.operation_number, row.short_text])).toEqual([['0010', 'Cut']]);
    const standing = await getPlannedOrder(tenant.client, created.order.orderNumber);
    expect(standing?.quantity).toBe(created.order.quantity);
    expect(standing?.version).toBe(created.order.version);
    expect(standing?.converted).toBe(true);
    expect(standing?.productionOrderNumber).toBe(result.productionOrderNumber);
    const again = await convertPlannedOrder({
      orderType: 'PP01',
      client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber,
    });
    expect(again.status).toBe('ALREADY_CONVERTED');
    expect(again.productionOrderNumber).toBe(result.productionOrderNumber);
    const linked = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as total from production_order
       where client = ${tenant.client} and planned_order_number = ${created.order.orderNumber}
    `)) as unknown as Array<{ total: number }>;
    expect(linked[0].total).toBe(1);
    const snapshotRows = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as total from production_order_operation
       where client = ${tenant.client} and order_number = ${result.productionOrderNumber}
    `)) as unknown as Array<{ total: number }>;
    expect(snapshotRows[0].total).toBe(1);
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
      orderType: 'PP01',
      client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber, quantity: '4',
    })).rejects.toThrow(/Partial conversion is not supported/);
    await expect(convertPlannedOrder({
      orderType: 'PP01',
      client: tenant.client, changedBy: ACTOR, orderNumber: 'PL-BUY40',
    })).rejects.toThrow(/externally procured/);
    expect(await counts()).toEqual(before);
  });

  it('lets one collective failure stand beside one committed order', async () => {
    const created = await planned('collective-1');
    const result = await convertPlannedOrders({
      orderType: 'PP01',
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
      orderType: 'PP01',
      client: tenant.client, changedBy: ACTOR, correlationId: 'too-many',
      orderNumbers: Array.from({ length: 26 }, (_, index) => `PL-${index}`),
    })).rejects.toThrow(/at most 25/);
    expect(await counts()).toEqual(before);
  });

  it('returns one production order when two conversions race', async () => {
    const created = await planned('race-1');
    const [first, second] = await Promise.all([
      convertPlannedOrder({ orderType: 'PP01', client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber }),
      convertPlannedOrder({ orderType: 'PP01', client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber }),
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

  it('rejects a missing conversion type before creating an order', async () => {
    const created = await planned('no-type');
    const before = await counts();
    await expect(convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber,
      orderType: '',
    })).rejects.toThrow(/production order type is required/);
    await expect(convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber,
      orderType: undefined as unknown as string,
    })).rejects.toThrow(/production order type is required/);
    await expect(convertPlannedOrders({
      client: tenant.client, changedBy: ACTOR, correlationId: 'no-type-batch',
      orderNumbers: [created.order.orderNumber],
      orderType: '   ',
    })).rejects.toThrow(/production order type is required/);
    expect(await counts()).toEqual(before);
    const standing = await getPlannedOrder(tenant.client, created.order.orderNumber);
    expect(standing?.converted).toBe(false);
  });

  it('stores an explicit order type and does not invent one', async () => {
    await saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP40',
      description: 'Conversion type', version: 0, reason: 'Type for conversion',
    });
    await saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: '1000', orderType: 'PP40',
      taskListType: '', productionVersionSelection: '0', version: 0, reason: 'Automatic selection for PP40',
    });
    const created = await planned('typed-1');
    const result = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber, orderType: 'PP40',
    });
    expect(result.status).toBe('CONVERTED');
    const production = await getProductionOrder(tenant.client, result.productionOrderNumber!);
    expect(production?.orderType).toBe('PP40');
    const before = await counts();
    await expect(convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: (await planned('bad-type')).order.orderNumber, orderType: 'ZZ99',
    })).rejects.toThrow(/does not stand/);
    expect(await counts()).toEqual(before);
    const collective = await planned('collective-type');
    const batch = await convertPlannedOrders({
      client: tenant.client, changedBy: ACTOR, correlationId: 'typed-batch',
      orderNumbers: [collective.order.orderNumber], orderType: 'PP40',
    });
    expect(batch.results[0]?.status).toBe('CONVERTED');
    const copied = await getProductionOrder(tenant.client, batch.results[0]!.productionOrderNumber!);
    expect(copied?.orderType).toBe('PP40');
  });

  it('applies manual, blank, and missing selection on CO40 and CO41', async () => {
    await saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP41',
      description: 'Manual conversion', version: 0, reason: 'Manual selection',
    });
    await saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: '1000', orderType: 'PP41',
      taskListType: '', productionVersionSelection: '1', version: 0, reason: 'Manual selection',
    });
    await saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP4B',
      description: 'Blank conversion', version: 0, reason: 'Blank selection',
    });
    await saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: '1000', orderType: 'PP4B',
      taskListType: '', productionVersionSelection: ' ', version: 0, reason: 'Blank selection',
    });
    await saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP4M',
      description: 'Missing parameters', version: 0, reason: 'Type without parameters',
    });
    const missing = await planned('missing-param');
    const blank = await planned('blank-selection');
    const manual = await planned('manual-missing');
    const named = await planned('manual-named');
    const collective = await planned('manual-collective');
    const before = await counts();
    await expect(convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: missing.order.orderNumber, orderType: 'PP4M',
    })).rejects.toThrow(/do not stand for plant 1000 and order type PP4M/);
    await expect(convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: blank.order.orderNumber, orderType: 'PP4B',
      productionVersion: '0001',
    })).rejects.toThrow(/not a selection method/);
    await expect(convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: manual.order.orderNumber, orderType: 'PP41',
    })).rejects.toThrow(/require a production version/);
    await expect(convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: manual.order.orderNumber, orderType: 'PP41',
      named: { productionVersion: '0001' },
    })).rejects.toThrow(/not used as a filter/);
    const converted = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: named.order.orderNumber, orderType: 'PP41',
      productionVersion: '0001',
    });
    expect(converted.status).toBe('CONVERTED');
    const batch = await convertPlannedOrders({
      client: tenant.client, changedBy: ACTOR, correlationId: 'manual-batch',
      orderNumbers: [collective.order.orderNumber], orderType: 'PP41',
    });
    expect(batch.results[0]?.status).toBe('FAILED');
    expect(batch.results[0]?.message).toMatch(/require a production version/);
    const namedBatch = await convertPlannedOrders({
      client: tenant.client, changedBy: ACTOR, correlationId: 'manual-batch-named',
      orderNumbers: [collective.order.orderNumber], orderType: 'PP41', productionVersion: '0001',
    });
    expect(namedBatch.results[0]?.status).toBe('CONVERTED');
    await expect(convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: (await planned('bad-version')).order.orderNumber,
      orderType: 'PP41', productionVersion: 'ZZZZ',
    })).rejects.toThrow(/not valid on/);
    expect((await counts()).orders).toBe(before.orders + 2);
  });

  it('stores the selected version and bill of material on CO40 and CO41', async () => {
    const single = await planned('persist-co40');
    const converted = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: single.order.orderNumber, orderType: 'PP01',
    });
    expect(converted.status).toBe('CONVERTED');
    const order = await getProductionOrder(tenant.client, converted.productionOrderNumber!);
    expect(order?.productionVersion).toBe('0001');
    expect(order?.bomUsage).toBe('P');
    expect(order?.bomAlternative).toBe('01');
    expect(order?.components).toEqual([
      expect.objectContaining({
        itemNumber: 10, bomItem: '0010', sourceMaterial: 'FG-40', materialNumber: 'COMP-40', requiredQuantity: '20.000',
      }),
    ]);
    const collective = await planned('persist-co41');
    const batch = await convertPlannedOrders({
      client: tenant.client, changedBy: ACTOR, correlationId: 'persist-batch',
      orderNumbers: [collective.order.orderNumber], orderType: 'PP01',
    });
    expect(batch.results[0]?.status).toBe('CONVERTED');
    const copied = await getProductionOrder(tenant.client, batch.results[0]!.productionOrderNumber!);
    expect(copied?.productionVersion).toBe('0001');
    expect(copied?.bomUsage).toBe('P');
    expect(copied?.bomAlternative).toBe('01');
    expect(copied?.components[0]).toEqual(expect.objectContaining({ bomItem: '0010', sourceMaterial: 'FG-40' }));
  });

  it('keeps separate bill-of-material lines when the component material is repeated', async () => {
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-40', plant: '1000', usage: 'P',
      alternative: '02', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
      items: [
        { itemNumber: '0010', itemCategory: 'S', componentMaterial: 'COMP-40', quantity: '2', unit: 'KG' },
        { itemNumber: '0020', itemCategory: 'S', componentMaterial: 'COMP-40', quantity: '3', unit: 'KG' },
      ],
    });
    await createProductionVersion({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-40', plant: '1000', productionVersion: '0002',
      validFrom: '2026-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'KG',
      bomUsage: 'P', bomAlternative: '02', taskListType: 'N', routingGroup: '50000041', groupCounter: '01',
    });
    const created = await planned('duplicate-lines');
    const result = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber,
      orderType: 'PP41', productionVersion: '0002',
    });
    expect(result.status).toBe('CONVERTED');
    const order = await getProductionOrder(tenant.client, result.productionOrderNumber!);
    expect(order?.productionVersion).toBe('0002');
    expect(order?.bomAlternative).toBe('02');
    expect(order?.components.map((row) => [row.itemNumber, row.bomItem, row.materialNumber, row.requiredQuantity, row.sourceMaterial])).toEqual([
      [10, '0010', 'COMP-40', '20.000', 'FG-40'],
      [20, '0020', 'COMP-40', '30.000', 'FG-40'],
    ]);
  });

  it('rejects an independent snapshot that does not match the selected version and rolls back', async () => {
    const created = await planned('supplied-mismatch');
    const before = await counts();
    await expect(convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber, orderType: 'PP01',
      productionVersion: '0001',
      components: [{ materialNumber: 'COMP-40', plant: '1000', requiredQuantity: 1, bomItem: '0090' }],
    })).rejects.toThrow(/does not match production version 0001/);
    expect(await counts()).toEqual(before);
    const [left] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select
        (select count(*) from production_order where client = ${tenant.client} and planned_order_number = ${created.order.orderNumber})::int as orders,
        (select count(*) from production_order_component c
          join production_order o on o.client = c.client and o.order_number = c.order_number
         where c.client = ${tenant.client} and o.planned_order_number = ${created.order.orderNumber})::int as components
    `)) as unknown as Array<{ orders: number; components: number }>;
    expect(left).toEqual({ orders: 0, components: 0 });
    const matched = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber, orderType: 'PP01',
      productionVersion: '0001',
      components: [{ materialNumber: 'COMP-40', plant: '1000', requiredQuantity: 20 }],
    });
    expect(matched.status).toBe('CONVERTED');
    const order = await getProductionOrder(tenant.client, matched.productionOrderNumber!);
    expect(order?.productionVersion).toBe('0001');
    expect(order?.components[0]?.bomItem).toBe('0010');
    expect(order?.components[0]?.sourceMaterial).toBe('FG-40');
  });

  it('rolls back the order when creation fails after the version was selected', async () => {
    const created = await planned('create-fails');
    const [saved] = await withTenant(tenant.client, (tx) => tx.select().from(materialPlant).where(and(
      eq(materialPlant.client, tenant.client),
      eq(materialPlant.materialNumber, 'COMP-40'),
      eq(materialPlant.plant, '1000'),
    )));
    await withTenant(tenant.client, (tx) => tx.delete(materialPlant).where(and(
      eq(materialPlant.client, tenant.client),
      eq(materialPlant.materialNumber, 'COMP-40'),
      eq(materialPlant.plant, '1000'),
    )));
    const before = await counts();
    try {
      await expect(convertPlannedOrder({
        client: tenant.client, changedBy: ACTOR, orderNumber: created.order.orderNumber,
        orderType: 'PP01', productionVersion: '0001',
      })).rejects.toThrow(/not extended/);
      expect(await counts()).toEqual(before);
      const [left] = await withTenant(tenant.client, (tx) => tx.execute(sql`
        select count(*)::int as orders
          from production_order
         where client = ${tenant.client} and planned_order_number = ${created.order.orderNumber}
      `)) as unknown as Array<{ orders: number }>;
      expect(left?.orders).toBe(0);
    } finally {
      if (saved) {
        await withTenant(tenant.client, (tx) => tx.insert(materialPlant).values(saved));
      }
    }
  });
});
