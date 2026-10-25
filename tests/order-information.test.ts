import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import {
  orderInformationLists,
  orderInformationRefusal,
  runOrderInformation,
  saveOrderInformationLayout,
} from '../src/modules/production/order-information';
import { enterOrderConfirmation } from '../src/modules/production/order-confirmation';
import { createPlannedOrder } from '../src/modules/production/planned-order-create';
import { checkProductionVersion, createProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { enterTimeTicket } from '../src/modules/production/time-ticket';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'COOIS_CLERK';
const PLANT = '1000';

describe('COOIS order information', () => {
  let tenant: TestTenant;
  let other: TestTenant;
  let released = '';
  let second = '';
  let planned = '';
  let version = 1;
  let key = 0;
  const nextKey = () => `coois-${++key}`;

  async function extend(materialNumber: string) {
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'COOIS', view: 'BASIC', description: materialNumber, materialType: 'RAW',
      materialGroup: 'RAW', baseUnit: 'PC', industrySector: 'M', barcode: '',
      grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'COOIS', view: 'PURCHASING', plant: PLANT,
      purchasingGroup: '001', orderUnit: 'PC',
      overdeliveryTolerance: '0', underdeliveryTolerance: '0', manufacturerPartNumber: '',
    });
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 1,
      reason: 'COOIS', view: 'MRP', plant: PLANT,
      mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: materialNumber.startsWith('FG') ? 'MAKE' : 'BUY',
      lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0',
      safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 0, inHouseProductionDays: 0,
    });
  }

  beforeAll(async () => {
    tenant = await createTenant('coois-info');
    other = await createTenant('coois-other');
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${tenant.client}, 'PP01', 'Standard production', '10', ${ACTOR})
        on conflict (client, order_type) do nothing
      `);
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODCONF', subObject: '*', prefix: 'CNF', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
    });
    for (const material of ['FG-16', 'RM-16', 'RM-16B']) await extend(material);
    await saveBomUsage({
      client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock',
      materialEntry: '+', quantityEntry: '+',
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-16', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'RM-16', quantity: '1', unit: 'PC' }],
    });
    await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingControlKey({
      client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Confirm', confirmation: 'X',
    });
    await saveRoutingControlKey({
      client: tenant.client, changedBy: ACTOR, controlKey: 'PP02', description: 'No confirm',
    });
    await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    await createWorkCenter({
      client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC16', category: 'MACH', description: 'Assembly',
    });
    await createRouting({
      client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup: '50000016', groupCounter: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      assignments: [{ materialNumber: 'FG-16' }],
      operations: [
        { operationNumber: '0010', shortText: 'Cut', workCenter: 'WC16', controlKey: 'PP01' },
        { operationNumber: '0020', shortText: 'Skip', workCenter: 'WC16', controlKey: 'PP02' },
      ],
    });
    await createProductionVersion({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-16', plant: PLANT, productionVersion: '0001',
      validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000016', groupCounter: '01',
    });
    await checkProductionVersion(tenant.client, 'FG-16', PLANT, '0001', ACTOR);
    const order = await createProductionOrder({
      orderType: 'PP01',
      client: tenant.client, createdBy: ACTOR, materialNumber: 'FG-16', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey: 'coois-order',
      components: [
        { materialNumber: 'RM-16', plant: PLANT, requiredQuantity: 2 },
        { materialNumber: 'RM-16B', plant: PLANT, requiredQuantity: 1 },
      ],
    });
    const extra = await createProductionOrder({
      orderType: 'PP01',
      client: tenant.client, createdBy: ACTOR, materialNumber: 'FG-16', plant: PLANT, orderQuantity: 4,
      scheduledStart: '2026-10-24', scheduledFinish: '2026-10-26', requestKey: 'coois-second',
      components: [{ materialNumber: 'RM-16', plant: PLANT, requiredQuantity: 1 }],
    });
    const releasedOrder = await releaseProductionOrder({ client: tenant.client, orderNumber: order.orderNumber, releasedBy: ACTOR });
    released = releasedOrder.orderNumber;
    second = extra.orderNumber;
    const stamped = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`select version from production_order where client = ${tenant.client} and order_number = ${released}`) as unknown as Array<{ version: number }>;
      return Number(rows[0]?.version);
    });
    version = stamped;
    await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: released, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '4', postingDate: '2026-10-24', expectedVersion: version,
    });
    await enterOrderConfirmation(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: released,
      confirmationType: 'PARTIAL', yieldQuantity: '2', postingDate: '2026-10-24', expectedVersion: version,
    });
    const createdPlan = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: nextKey(), materialNumber: 'FG-16', plant: PLANT,
      quantity: '3', unit: 'PC', startDate: '2026-10-24', finishDate: '2026-10-25',
    });
    planned = createdPlan.order.orderNumber;
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${tenant.client}, 'COOIS', 'Report fixture', 'RECEIPT', 'PRODUCTION_ORDER', ${ACTOR})
        on conflict (client, movement_type) do nothing
      `);
      await tx.execute(sql`
        insert into material_document (
          client, material_document_number, document_year, document_date, posting_date, status, created_by
        ) values
          (${tenant.client}, 'MDCOIS1', 2026, '2026-10-24', '2026-10-24', 'POSTED', ${ACTOR}),
          (${tenant.client}, 'MDCOIS2', 2026, '2026-10-24', '2026-10-24', 'REVERSED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          entry_quantity, entry_unit, base_quantity, base_unit, production_order_number, production_order_item,
          line_direction, created_by
        ) values
          (${tenant.client}, 'MDCOIS1', 1, 'COOIS', 'FG-16', ${PLANT}, 2, 'PC', 2, 'PC', ${released}, null, 'RECEIPT', ${ACTOR}),
          (${tenant.client}, 'MDCOIS1', 2, 'COOIS', 'RM-16', ${PLANT}, 1, 'PC', 1, 'PC', ${released}, 10, 'ISSUE', ${ACTOR}),
          (${tenant.client}, 'MDCOIS2', 1, 'COOIS', 'FG-16', ${PLANT}, 9, 'PC', 9, 'PC', ${released}, null, 'RECEIPT', ${ACTOR})
      `);
    });
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
    await closeDb();
  });

  it('names unavailable lists instead of inventing their rows', () => {
    expect(orderInformationRefusal({ cost: '1' })).toMatch(/not carried/);
    expect(orderInformationRefusal({ workCenter: 'WC16' })).toMatch(/not stored/);
    expect(orderInformationLists().find((row) => row.id === 'OPERATIONS')?.available).toBe(false);
    expect(orderInformationLists().find((row) => row.id === 'HEADERS')?.available).toBe(true);
  });

  it('keeps header, component, and confirmation rows at their own grain', async () => {
    await expect(runOrderInformation(tenant.client, {
      listType: 'OPERATIONS', plant: PLANT,
    })).rejects.toThrow(/not stored/);
    await expect(runOrderInformation(tenant.client, {
      listType: 'HEADERS', plant: PLANT, dateBasis: 'POSTING', dateFrom: '2026-10-24',
    })).rejects.toThrow(/not a date of this list/);
    const headers = await runOrderInformation(tenant.client, { listType: 'HEADERS', plant: PLANT });
    expect(headers.written).toBe(false);
    expect(headers.total).toBe(2);
    expect(headers.rows).toHaveLength(2);
    expect(headers.rows.map((row) => row.orderNumber).sort()).toEqual([released, second].sort());
    const header = headers.rows.find((row) => row.orderNumber === released);
    expect(Number(header?.headerConfirmedYield)).toBe(2);
    expect(Number(header?.confirmationCount)).toBe(2);
    expect(Number(header?.deliveredQuantity)).toBe(2);
    expect(header).not.toHaveProperty('price');
    const limited = await runOrderInformation(tenant.client, { listType: 'HEADERS', plant: PLANT, limit: 1 });
    expect(limited.rows).toHaveLength(1);
    expect(limited.total).toBe(2);
    expect(limited.truncated).toBe(true);
    const selected = await runOrderInformation(tenant.client, {
      listType: 'HEADERS', plant: PLANT, componentMaterial: 'RM-16B',
    });
    expect(selected.rows.map((row) => row.orderNumber)).toEqual([released]);
    const components = await runOrderInformation(tenant.client, { listType: 'COMPONENTS', plant: PLANT });
    expect(components.total).toBe(3);
    expect(components.rows.filter((row) => row.orderNumber === released)).toHaveLength(2);
    const issued = components.rows.find((row) => row.orderNumber === released && row.materialNumber === 'RM-16');
    expect(Number(issued?.issuedQuantity)).toBe(1);
    const confirmations = await runOrderInformation(tenant.client, { listType: 'CONFIRMATIONS', plant: PLANT });
    expect(confirmations.total).toBe(2);
    expect(confirmations.rows.map((row) => row.confirmationLevel).sort()).toEqual(['HEADER', 'OPERATION']);
    expect(confirmations.rows.find((row) => row.confirmationLevel === 'HEADER')?.operationNumber).toBeNull();
    const movements = await runOrderInformation(tenant.client, { listType: 'GOODS_MOVEMENTS', orderNumber: released });
    expect(movements.total).toBe(3);
    expect(movements.rows.some((row) => row.documentStatus === 'REVERSED')).toBe(true);
    expect(movements.rows[0]).not.toHaveProperty('value');
    const plannedRows = await runOrderInformation(tenant.client, {
      object: 'PLANNED_ORDER', listType: 'HEADERS', plant: PLANT,
    });
    expect(plannedRows.rows.map((row) => row.orderNumber)).toEqual([planned]);
    expect(plannedRows.rows.some((row) => row.orderNumber === released)).toBe(false);
    const hidden = await runOrderInformation(other.client, { listType: 'HEADERS', orderNumber: released, plant: PLANT });
    expect(hidden.total).toBe(0);
  });

  it('loads one order overview without writing and keeps a layout private', async () => {
    const before = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select version from production_order where client = ${tenant.client} and order_number = ${released}
      `) as unknown as Array<{ version: number }>;
      return Number(rows[0]?.version);
    });
    const overview = await runOrderInformation(tenant.client, {
      listType: 'OVERVIEW', orderNumber: released, plant: PLANT,
    });
    expect(overview.rows).toHaveLength(0);
    expect(overview.overview?.components).toHaveLength(2);
    expect(overview.overview?.confirmations).toHaveLength(2);
    expect(overview.overview?.movements).toHaveLength(3);
    const reduced = await runOrderInformation(tenant.client, {
      listType: 'OVERVIEW', orderNumber: released, plant: PLANT, reduced: true,
    });
    expect(reduced.overview?.reduced).toBe(true);
    expect(reduced.overview?.components).toHaveLength(0);
    const after = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select version,
               (select count(*) from production_confirmation where client = ${tenant.client})::int as confirmations,
               (select count(*) from material_document where client = ${tenant.client})::int as documents
          from production_order where client = ${tenant.client} and order_number = ${released}
      `) as unknown as Array<{ version: number; confirmations: number; documents: number }>;
      return rows[0];
    });
    expect(after?.version).toBe(before);
    expect(after?.confirmations).toBe(2);
    expect(after?.documents).toBe(2);
    await expect(saveOrderInformationLayout(tenant.client, {
      owner: ACTOR, object: 'PRODUCTION_ORDER', listType: 'HEADERS', name: 'Mine',
      fields: ['cost'], sortField: 'cost',
    })).rejects.toThrow(/not a column/);
    const saved = await saveOrderInformationLayout(tenant.client, {
      owner: ACTOR, object: 'PRODUCTION_ORDER', listType: 'HEADERS', name: 'Mine',
      fields: ['orderNumber', 'status'], sortField: 'orderNumber', isDefault: true,
    });
    const applied = await runOrderInformation(tenant.client, {
      listType: 'HEADERS', plant: PLANT, layoutId: saved.layoutId, owner: ACTOR,
    });
    expect(applied.columns.map((column) => column.id)).toEqual(['orderNumber', 'status']);
    await expect(runOrderInformation(tenant.client, {
      listType: 'HEADERS', plant: PLANT, layoutId: saved.layoutId, owner: 'OTHER',
    })).rejects.toThrow(/does not stand/);
    await expect(runOrderInformation(tenant.client, {
      listType: 'CONFIRMATIONS', plant: PLANT, layoutId: saved.layoutId, owner: ACTOR,
    })).rejects.toThrow(/does not stand/);
  });
});
