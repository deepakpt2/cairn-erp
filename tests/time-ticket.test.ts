import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { changeProductionOrder, technicallyCompleteProductionOrder } from '../src/modules/production/production-order-change';
import { getProductionOrderDisplay } from '../src/modules/production/production-order-display';
import { saveOrderTypeParameter } from '../src/modules/production/order-type-parameters';
import { checkProductionVersion, createProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingStandardValueKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { insertOrderOperationSnapshot, resolveOrderOperationSnapshot } from '../src/modules/production/order-operation-snapshot';
import { enterTimeTicket, loadTimeTicket, previewTimeTicket, timeTicketRefusal } from '../src/modules/production/time-ticket';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'CO11N_CLERK';
const PLANT = '1000';

describe('CO11N time ticket', () => {
  let tenant: TestTenant;
  let released = '';
  let created = '';
  let version = 1;
  let key = 0;
  const nextKey = () => `co11n-${++key}`;

  async function extend(materialNumber: string) {
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'CO11N', view: 'BASIC', description: materialNumber, materialType: 'RAW',
      materialGroup: 'RAW', baseUnit: 'PC', industrySector: 'M', barcode: '',
      grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'CO11N', view: 'PURCHASING', plant: PLANT,
      purchasingGroup: '001', orderUnit: 'PC',
      overdeliveryTolerance: '0', underdeliveryTolerance: '0', manufacturerPartNumber: '',
    });
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 1,
      reason: 'CO11N', view: 'MRP', plant: PLANT,
      mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: materialNumber.startsWith('FG') ? 'MAKE' : 'BUY',
      lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0',
      safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 0, inHouseProductionDays: 0,
    });
  }

  beforeAll(async () => {
    tenant = await createTenant('co11n-ticket');
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${tenant.client}, 'PP01', 'Standard production', '10', ${ACTOR})
        on conflict (client, order_type) do nothing
      `);
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODCONF', subObject: '*', prefix: 'CNF', numberLength: 7, createdBy: ACTOR });
    });
    await saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      taskListType: '', productionVersionSelection: '0', version: 0, reason: 'Automatic selection for CO11N',
    });
    await extend('FG-11');
    await extend('RM-11');
    await saveBomUsage({
      client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock',
      materialEntry: '+', quantityEntry: '+',
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-11', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'RM-11', quantity: '1', unit: 'PC' }],
    });
    await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingControlKey({
      client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Confirm', confirmation: 'X',
    });
    await saveRoutingControlKey({
      client: tenant.client, changedBy: ACTOR, controlKey: 'PP02', description: 'No confirm',
    });
    await saveRoutingStandardValueKey({
      client: tenant.client, changedBy: ACTOR, standardValueKey: 'SV01', description: 'Labor',
      parameters: [{ parameter: 'LABOR', description: 'Labor', unit: 'HR', required: 'X' }],
    });
    await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    await createWorkCenter({
      client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC11', category: 'MACH', description: 'Assembly',
    });
    await createRouting({
      client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup: '50000011', groupCounter: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      assignments: [{ materialNumber: 'FG-11' }],
      operations: [
        {
          operationNumber: '0010', shortText: 'Cut', workCenter: 'WC11', controlKey: 'PP01', standardValueKey: 'SV01',
          values: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
        },
        { operationNumber: '0020', shortText: 'Skip', workCenter: 'WC11', controlKey: 'PP02' },
      ],
    });
    await createProductionVersion({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-11', plant: PLANT, productionVersion: '0001',
      validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000011', groupCounter: '01',
    });
    await checkProductionVersion(tenant.client, 'FG-11', PLANT, '0001', ACTOR);
    const order = await createProductionOrder({
      orderType: 'PP01',
      client: tenant.client, createdBy: ACTOR, materialNumber: 'FG-11', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey: 'co11n-order',
      components: [{ materialNumber: 'RM-11', plant: PLANT, requiredQuantity: 1 }],
    });
    await withTenant(tenant.client, async (tx) => {
      const copied = await resolveOrderOperationSnapshot(tx, {
        client: tenant.client, plant: PLANT, finishDate: '2026-10-25',
        taskListType: 'N', routingGroup: '50000011', groupCounter: '01', productionVersion: '0001',
      });
      await insertOrderOperationSnapshot(tx, {
        client: tenant.client, orderNumber: order.orderNumber, createdBy: ACTOR, operations: copied.operations,
      });
    });
    const open = await createProductionOrder({
      orderType: 'PP01',
      client: tenant.client, createdBy: ACTOR, materialNumber: 'FG-11', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey: 'co11n-open',
      components: [{ materialNumber: 'RM-11', plant: PLANT, requiredQuantity: 1 }],
    });
    const releasedOrder = await releaseProductionOrder({ client: tenant.client, orderNumber: order.orderNumber, releasedBy: ACTOR });
    released = releasedOrder.orderNumber;
    created = open.orderNumber;
    const stamped = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`select version from production_order where client = ${tenant.client} and order_number = ${released}`) as unknown as Array<{ version: number }>;
      return rows[0]?.version;
    });
    version = Number(stamped);
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await closeDb();
  });

  it('refuses an unimplemented confirmation control by name', () => {
    expect(timeTicketRefusal({ backflush: 'X' })).toMatch(/backflush/);
    expect(timeTicketRefusal({ automaticGoodsReceipt: 'X' })).toMatch(/not configured/);
    expect(timeTicketRefusal({ personnel: '1' })).toMatch(/not validated/);
    expect(timeTicketRefusal({ co13: '1' })).toMatch(/Open CO13/);
    expect(timeTicketRefusal({ automatic: 'X' })).toMatch(/not a stored rule/);
  });

  it('does not confirm an unreleased order or an operation the control key excludes', async () => {
    await expect(enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: created, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: 1,
      activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    })).rejects.toThrow(/not released/);
    const loaded = await loadTimeTicket(tenant.client, { orderNumber: released, postingDate: '2026-10-24' });
    expect(loaded.blockingReason).toBeNull();
    expect(loaded.operations.map((row) => row.operationNumber)).toEqual(['0010', '0020']);
    expect(loaded.operations.find((row) => row.operationNumber === '0020')?.confirmable).toBe(false);
    await expect(enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: released, operationNumber: '0020',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: version,
      activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    })).rejects.toThrow(/does not allow confirmation/);
  });

  it('checks without writing, then posts a partial confirmation without a goods movement', async () => {
    const preview = await previewTimeTicket(tenant.client, {
      orderNumber: released, operationNumber: '0010', confirmationType: 'PARTIAL', yieldQuantity: '4', scrapQuantity: '1',
      postingDate: '2026-10-24', expectedVersion: version,
      activities: [{ parameter: 'LABOR', quantity: '2', unit: 'HR' }],
    });
    expect(preview.written).toBe(false);
    expect(preview.confirmationNumber).toBe('');
    expect(preview.movementsPosted).toBe(0);
    const requestKey = nextKey();
    const posted = await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey, orderNumber: released, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '4', scrapQuantity: '1', postingDate: '2026-10-24', expectedVersion: version,
      executionStartDate: '2026-10-24', executionStartTime: '22:30',
      executionFinishDate: '2026-10-25', executionFinishTime: '01:15',
      activities: [{ parameter: 'LABOR', quantity: '2', unit: 'HR' }],
    });
    expect(posted.confirmationNumber).toMatch(/^CNF/);
    expect(posted.orderStatus).toBe('RELEASED');
    expect(posted.activities[0]).toMatchObject({ parameter: 'LABOR', unit: 'HR' });
    expect(Number(posted.activities[0]?.quantity)).toBe(2);
    expect(Number(posted.activities[0]?.suggested)).toBe(1);
    expect(posted.executionFinish).toBe('2026-10-25 01:15:00');
    const again = await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey, orderNumber: released, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '4', scrapQuantity: '1', postingDate: '2026-10-24', expectedVersion: version,
      executionStartDate: '2026-10-24', executionStartTime: '22:30',
      executionFinishDate: '2026-10-25', executionFinishTime: '01:15',
      activities: [{ parameter: 'LABOR', quantity: '2', unit: 'HR' }],
    });
    expect(again.confirmationNumber).toBe(posted.confirmationNumber);
    const after = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select (select count(*) from production_confirmation where client = ${tenant.client})::int as confirmations,
               (select count(*) from material_document where client = ${tenant.client})::int as documents,
               (select count(*) from journal_entry where client = ${tenant.client})::int as journals,
               (select status from production_order where client = ${tenant.client} and order_number = ${released}) as status
      `) as unknown as Array<{ confirmations: number; documents: number; journals: number; status: string }>;
      return rows[0];
    });
    expect(after).toMatchObject({ confirmations: 1, documents: 0, journals: 0, status: 'RELEASED' });
  });

  it('does not clamp an excessive yield, and a final confirmation blocks another', async () => {
    await expect(enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: released, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '11', postingDate: '2026-10-24', expectedVersion: version,
      activities: [{ parameter: 'LABOR', quantity: '0', unit: 'HR' }],
    })).rejects.toThrow(/was not reduced/);
    const finalTicket = await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: released, operationNumber: '0010',
      confirmationType: 'FINAL', confirmFinal: true, yieldQuantity: '6', postingDate: '2026-10-24', expectedVersion: version,
      activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    });
    expect(finalTicket.confirmationType).toBe('FINAL');
    expect(finalTicket.orderStatus).toBe('RELEASED');
    await expect(enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: released, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: version,
      activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    })).rejects.toThrow(/final confirmation already stands/);
  });

  it('shows the confirmation on CO03 and stops CO02 from changing the order', async () => {
    const shown = await getProductionOrderDisplay(tenant.client, released);
    expect(shown?.status).toBe('RELEASED');
    expect(shown?.confirmations).toHaveLength(2);
    expect(shown?.operations.map((row) => row.operationNumber)).toEqual(['0010', '0020']);
    expect(shown?.gaps.join(' ')).toMatch(/were copied onto this order/);
    expect(shown?.version).toBe(version);
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: released, expectedVersion: version, quantity: '12',
    })).rejects.toThrow(/has a confirmation/);
  });

  it('confirms a technically completed order and leaves that status', async () => {
    const draft = await createProductionOrder({
      orderType: 'PP01',
      client: tenant.client, createdBy: ACTOR, materialNumber: 'FG-11', plant: PLANT, orderQuantity: 4,
      scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey: 'co11n-teco',
      components: [{ materialNumber: 'RM-11', plant: PLANT, requiredQuantity: 1 }],
    });
    await withTenant(tenant.client, async (tx) => {
      const copied = await resolveOrderOperationSnapshot(tx, {
        client: tenant.client, plant: PLANT, finishDate: '2026-10-25',
        taskListType: 'N', routingGroup: '50000011', groupCounter: '01', productionVersion: '0001',
      });
      await insertOrderOperationSnapshot(tx, {
        client: tenant.client, orderNumber: draft.orderNumber, createdBy: ACTOR, operations: copied.operations,
      });
    });
    await releaseProductionOrder({ client: tenant.client, orderNumber: draft.orderNumber, releasedBy: ACTOR });
    const [standing] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select version from production_order where client = ${tenant.client} and order_number = ${draft.orderNumber}
    `)) as unknown as Array<{ version: number }>;
    const completed = await technicallyCompleteProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: draft.orderNumber,
      expectedVersion: Number(standing?.version), held: ['PROD.ORDER.CHANGE'], confirmed: true,
    });
    const posted = await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: nextKey(), orderNumber: draft.orderNumber, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24',
      expectedVersion: completed.order.version,
      activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    });
    expect(posted.orderStatus).toBe('TECHNICALLY_COMPLETED');
    const [after] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select status from production_order where client = ${tenant.client} and order_number = ${draft.orderNumber}
    `)) as unknown as Array<{ status: string }>;
    expect(after?.status).toBe('TECHNICALLY_COMPLETED');
  });
});
