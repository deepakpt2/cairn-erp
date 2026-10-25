import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createProductionOrder, getProductionOrder } from '../src/modules/inventory/production-orders';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { saveOrderTypeParameter } from '../src/modules/production/order-type-parameters';
import { getProductionOrderDisplay } from '../src/modules/production/production-order-display';
import { createProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingStandardValueKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { enterTimeTicket, loadTimeTicket } from '../src/modules/production/time-ticket';
import { releaseProductionOrder } from '../src/modules/inventory/production-orders';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'CO01_OP_TEST';
const PLANT = '1000';

describe('production order operation snapshot', () => {
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('order-ops');
    other = await createTenant('order-ops-other');
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODCONF', subObject: '*', prefix: 'CNF', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${tenant.client}, 'PP01', 'Standard production', '10', ${ACTOR})
        on conflict (client, order_type) do nothing
      `);
    });
    await saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      taskListType: '', productionVersionSelection: '0', version: 0, reason: 'Automatic selection',
    });
    for (const materialNumber of ['OP-FG', 'OP-RM', 'OP-LEG', 'OP-LATE']) {
      await saveMaterialView({
        client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
        reason: 'Operation snapshot', view: 'BASIC', description: materialNumber, materialType: 'RAW',
        materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
        grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
      });
      await saveMaterialView({
        client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
        reason: 'Operation snapshot', view: 'MRP', plant: PLANT,
        mrpType: 'NONE', mrpController: '001', procurementType: materialNumber.endsWith('RM') ? 'BUY' : 'MAKE',
        lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0',
        safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 0, inHouseProductionDays: 0,
      });
    }
    await saveBomUsage({
      client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock', materialEntry: '+', quantityEntry: '+',
    });
    await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingControlKey({
      client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Confirm', confirmation: 'X',
    });
    await saveRoutingStandardValueKey({
      client: tenant.client, changedBy: ACTOR, standardValueKey: 'SVOP', description: 'Labor',
      parameters: [{ parameter: 'LABOR', description: 'Labor', unit: 'HR', required: 'X' }],
    });
    await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    await createWorkCenter({
      client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WCOP', category: 'MACH', description: 'Assembly',
    });
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
    await closeDb();
  });

  async function bomAndVersion(materialNumber: string, routingGroup: string, operationValidTo = '9999-12-31') {
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber, plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'KG', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'OP-RM', quantity: '1', unit: 'KG' }],
    });
    await createRouting({
      client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup, groupCounter: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2020-01-01',
      assignments: [{ materialNumber }],
      operations: [{
        operationNumber: '0010', shortText: 'Cut', workCenter: 'WCOP', controlKey: 'PP01', standardValueKey: 'SVOP',
        validTo: operationValidTo,
        values: [{ parameter: 'LABOR', quantity: '2', unit: 'HR' }],
      }],
    });
    await createProductionVersion({
      client: tenant.client, changedBy: ACTOR, materialNumber, plant: PLANT, productionVersion: '0001',
      validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'KG',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup, groupCounter: '01',
    });
  }

  it('copies the selected operations and does not follow a later routing edit', async () => {
    await bomAndVersion('OP-FG', '50000081');
    const created = await createProductionOrder({
      orderType: 'PP01', client: tenant.client, createdBy: ACTOR, materialNumber: 'OP-FG', plant: PLANT,
      orderQuantity: 5, scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey: 'op-create',
    });
    expect(created.snapshotWarnings?.join(' ')).toMatch(/copied onto the order/i);
    const before = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select o.operation_number, o.short_text, o.routing_version, o.confirmation, o.production_version,
             v.parameter, v.quantity::text as quantity, v.unit
        from production_order_operation o
        join production_order_operation_value v
          on v.client = o.client and v.order_number = o.order_number and v.operation_number = o.operation_number
       where o.client = ${tenant.client} and o.order_number = ${created.orderNumber}
    `)) as unknown as Array<Record<string, string | number>>;
    expect(before).toEqual([expect.objectContaining({
      operation_number: '0010', short_text: 'Cut', confirmation: 'X', production_version: '0001',
      parameter: 'LABOR', quantity: '2.000', unit: 'HR',
    })]);
    const routingVersion = Number(before[0]?.routing_version);

    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update routing_operation
           set short_text = 'Changed later'
         where client = ${tenant.client} and routing_group = '50000081' and operation_number = '0010'
      `);
      await tx.execute(sql`
        update routing_control_key
           set confirmation = ' '
         where client = ${tenant.client} and control_key = 'PP01'
      `);
      await tx.execute(sql`
        update routing_operation_value
           set quantity = 9
         where client = ${tenant.client} and routing_group = '50000081' and parameter = 'LABOR'
      `);
      await tx.execute(sql`
        update routing
           set version = version + 1
         where client = ${tenant.client} and routing_group = '50000081'
      `);
    });

    const after = await getProductionOrderDisplay(tenant.client, created.orderNumber);
    expect(after?.operations).toEqual([expect.objectContaining({
      operationNumber: '0010', shortText: 'Cut', confirmation: 'X', routingVersion, progress: 'UNCONFIRMED',
    })]);
    expect(after?.operations[0]?.values).toEqual([expect.objectContaining({ parameter: 'LABOR', quantity: '2.000', unit: 'HR' })]);
    expect(await getProductionOrder(other.client, created.orderNumber)).toBeNull();

    const released = await releaseProductionOrder({ client: tenant.client, orderNumber: created.orderNumber, releasedBy: ACTOR });
    const [stamped] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select version from production_order where client = ${tenant.client} and order_number = ${released.orderNumber}
    `)) as unknown as Array<{ version: number }>;
    const loaded = await loadTimeTicket(tenant.client, { orderNumber: released.orderNumber, operationNumber: '0010' });
    expect(loaded.operations.map((row) => row.operationNumber)).toEqual(['0010']);
    expect(loaded.selected?.shortText).toBe('Cut');
    expect(loaded.selected?.confirmable).toBe(true);
    expect(loaded.selected?.activities[0]).toMatchObject({ parameter: 'LABOR', suggested: '2.000' });
    const posted = await enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: 'op-confirm', orderNumber: released.orderNumber, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: Number(stamped?.version),
      activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    });
    expect(posted.operationNumber).toBe('0010');
    expect(posted.productionVersion).toBe('0001');
  });

  it('does not create an order when the routing has no operation in effect', async () => {
    await bomAndVersion('OP-LATE', '50000082', '2026-01-31');
    const before = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as orders from production_order where client = ${tenant.client} and material_number = 'OP-LATE'
    `)) as unknown as Array<{ orders: number }>;
    await expect(createProductionOrder({
      orderType: 'PP01', client: tenant.client, createdBy: ACTOR, materialNumber: 'OP-LATE', plant: PLANT,
      orderQuantity: 1, scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey: 'op-late',
    })).rejects.toThrow(/no operation in effect/i);
    const after = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as orders from production_order where client = ${tenant.client} and material_number = 'OP-LATE'
    `)) as unknown as Array<{ orders: number }>;
    expect(after[0]?.orders).toBe(before[0]?.orders);
  });

  it('does not invent operations for an order whose components were supplied independently', async () => {
    const created = await createProductionOrder({
      orderType: 'PP01', client: tenant.client, createdBy: ACTOR, materialNumber: 'OP-LEG', plant: PLANT,
      orderQuantity: 2, scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey: 'op-legacy',
      components: [{ materialNumber: 'OP-RM', plant: PLANT, requiredQuantity: 1 }],
    });
    const shown = await getProductionOrderDisplay(tenant.client, created.orderNumber);
    expect(shown?.operations).toEqual([]);
    expect(shown?.gaps.join(' ')).toMatch(/Operations are not stored/);
    const released = await releaseProductionOrder({ client: tenant.client, orderNumber: created.orderNumber, releasedBy: ACTOR });
    const [stamped] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select version from production_order where client = ${tenant.client} and order_number = ${released.orderNumber}
    `)) as unknown as Array<{ version: number }>;
    await expect(enterTimeTicket(tenant.client, {
      requestedBy: ACTOR, requestKey: 'op-legacy-confirm', orderNumber: released.orderNumber, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: Number(stamped?.version),
    })).rejects.toThrow(/no operation snapshot/i);
  });
});
