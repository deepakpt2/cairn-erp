import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { mrpController } from '../src/modules/inventory/schema';
import {
  ProductionOrderError,
  createProductionOrder,
  getProductionOrder,
  previewProductionOrderBom,
} from '../src/modules/inventory/production-orders';
import { changeMaterialBom, createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { createProductionVersion } from '../src/modules/production/production-version';
import { createPlannedOrder } from '../src/modules/production/planned-order-create';
import { convertPlannedOrder } from '../src/modules/production/planned-order-conversion';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * CO01 reads the production version and stores that BOM as the order snapshot.
 * A missing or invalid version creates no order. A later BOM change does not
 * rewrite the saved rows. CO40 is not edited; the two snapshots are compared.
 */
const ACTOR = 'CO01_BOM_TEST';
const PLANT = '1000';
const FINISH = '2026-10-30';
const START = '2026-10-24';

let tenant: TestTenant;
let client = '';

async function finished(materialNumber: string) {
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'CO01 BOM test', view: 'BASIC', description: materialNumber, materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'CO01 BOM test', view: 'MRP', plant: PLANT,
    mrpType: 'NONE', mrpController: '001', procurementType: 'MAKE', lotSizing: 'EXACT',
    fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '0', reorderPoint: '0',
    plannedDeliveryDays: 0, inHouseProductionDays: 0,
  });
}

async function component(materialNumber: string) {
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'CO01 BOM test', view: 'BASIC', description: materialNumber, materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'CO01 BOM test', view: 'PURCHASING', plant: PLANT,
    purchasingGroup: '', orderUnit: 'KG', overdeliveryTolerance: '0',
    underdeliveryTolerance: '0', manufacturerPartNumber: '',
  });
}

async function bom(materialNumber: string, alternative: string, items: Array<Record<string, string>>) {
  return createMaterialBom({
    client, changedBy: ACTOR, materialNumber, plant: PLANT, usage: 'P', alternative,
    baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
    items: items.map((item) => ({ itemCategory: 'S', unit: 'KG', ...item })),
  });
}

async function version(materialNumber: string, productionVersion: string, bomAlternative: string) {
  return createProductionVersion({
    client, changedBy: ACTOR, materialNumber, plant: PLANT, productionVersion,
    validFrom: '2026-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'KG',
    bomUsage: 'P', bomAlternative, taskListType: 'N', routingGroup: '50000051', groupCounter: '01',
  });
}

async function counts() {
  const [row] = await withTenant(client, (tx) => tx.execute(sql`
    select
      (select count(*) from production_order where client = ${client})::int as orders,
      (select count(*) from production_order_component where client = ${client})::int as components,
      (select count(*) from material_document where client = ${client})::int as documents,
      (select count(*) from journal_entry where client = ${client})::int as journals,
      (select count(*) from reservation_header where client = ${client})::int as reservations
  `)) as unknown as Array<{ orders: number; components: number; documents: number; journals: number; reservations: number }>;
  return row;
}

function orderInput(materialNumber: string, requestKey?: string, productionVersion?: string) {
  return {
    client, createdBy: ACTOR, materialNumber, plant: PLANT,
    orderQuantity: 10, scheduledStart: START, scheduledFinish: FINISH,
    requestKey, productionVersion, orderType: 'PP01',
  };
}

describe('CO01 production version and BOM snapshot', () => {
  beforeAll(async () => {
    tenant = await createTenant('co01-bom');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.insert(mrpController).values({
        client, controller: '001', name: 'Controller 001', isActive: true, createdBy: ACTOR,
      }).onConflictDoNothing();
      await defineRange(tx, { client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${client}, 'PP01', 'Standard production', '10', ${ACTOR})
        on conflict (client, order_type) do nothing
      `);
    });
    await saveBomUsage({
      client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client, changedBy: ACTOR, category: 'S', description: 'Stock',
      materialEntry: '+', quantityEntry: '+',
      allowFixedQuantity: 'X', allowBulk: 'X', allowPhantom: 'X', allowCoproduct: 'X',
      allowFollowUp: 'X', allowSpecialProcurement: 'X',
    });
    for (const materialNumber of ['CO01-FG', 'CO01-CHG', 'CO01-PH', 'CO01-BK', 'CO01-OUT', 'CO01-REC', 'CO01-AMB', 'CO01-EXT', 'CO01-MISS']) {
      await finished(materialNumber);
    }
    for (const materialNumber of ['CO01-RM1', 'CO01-RM2', 'CO01-RM3', 'CHG-RM', 'PH-RM', 'BK-RM', 'OUT-RM', 'REC-RM', 'AMB-RM', 'EXT-RM']) {
      await component(materialNumber);
    }
    await saveRoutingTaskListType({ client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingControlKey({ client, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal' });
    await saveWorkCenterCategory({ client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    await createWorkCenter({
      client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC01', category: 'MACH', description: 'Assembly',
    });
    await createRouting({
      client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup: '50000051', groupCounter: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
      assignments: ['CO01-FG', 'CO01-CHG', 'CO01-PH', 'CO01-BK', 'CO01-OUT', 'CO01-REC', 'CO01-AMB', 'CO01-EXT'].map((materialNumber) => ({ materialNumber })),
      operations: [{ operationNumber: '0010', shortText: 'Make', workCenter: 'WC01', controlKey: 'PP01' }],
    });
    await bom('CO01-FG', '01', [
      { itemNumber: '0010', componentMaterial: 'CO01-RM1', quantity: '2' },
      { itemNumber: '0020', componentMaterial: 'CO01-RM2', quantity: '3', fixedQuantity: 'X' },
      { itemNumber: '0030', componentMaterial: 'CO01-RM3', quantity: '1', scrapPercent: '10' },
    ]);
    await version('CO01-FG', '0001', '01');
    await bom('CO01-CHG', '01', [{ itemNumber: '0010', componentMaterial: 'CHG-RM', quantity: '2' }]);
    await version('CO01-CHG', '0001', '01');
    await bom('CO01-PH', '01', [{ itemNumber: '0010', componentMaterial: 'PH-RM', quantity: '1', phantom: 'X' }]);
    await version('CO01-PH', '0001', '01');
    await bom('CO01-BK', '01', [{ itemNumber: '0010', componentMaterial: 'BK-RM', quantity: '1', bulkMaterial: 'X' }]);
    await version('CO01-BK', '0001', '01');
    await bom('CO01-OUT', '01', [{ itemNumber: '0010', componentMaterial: 'OUT-RM', quantity: '1', validTo: '2026-01-31' }]);
    await version('CO01-OUT', '0001', '01');
    await bom('CO01-REC', '01', [{ itemNumber: '0010', componentMaterial: 'REC-RM', quantity: '2' }]);
    await bom('REC-RM', '01', [{ itemNumber: '0010', componentMaterial: 'CO01-REC', quantity: '1' }]);
    await version('CO01-REC', '0001', '01');
    await bom('CO01-AMB', '01', [{ itemNumber: '0010', componentMaterial: 'AMB-RM', quantity: '2' }]);
    await bom('CO01-AMB', '02', [{ itemNumber: '0010', componentMaterial: 'AMB-RM', quantity: '4' }]);
    await version('CO01-AMB', '0001', '01');
    await version('CO01-AMB', '0002', '02');
    await bom('CO01-EXT', '01', [{ itemNumber: '0010', componentMaterial: 'EXT-RM', quantity: '1' }]);
    await version('CO01-EXT', '0001', '01');
  }, 180_000);

  afterAll(async () => {
    if (client) await destroyTenant(client);
  }, 180_000);

  it('stores the selected version and scales the BOM snapshot', async () => {
    const before = await counts();
    const preview = await previewProductionOrderBom(orderInput('CO01-FG'));
    expect(preview.productionVersion).toBe('0001');
    expect(preview.components.map((row) => [row.bomItem, row.materialNumber, row.requiredQuantity, row.sourceMaterial])).toEqual([
      ['0010', 'CO01-RM1', '20.000', 'CO01-FG'],
      ['0020', 'CO01-RM2', '3.000', 'CO01-FG'],
      ['0030', 'CO01-RM3', '11.000', 'CO01-FG'],
    ]);
    expect(preview.warnings.join(' ')).toMatch(/does not store operations/i);
    expect(await counts()).toEqual(before);

    const view = await createProductionOrder({ orderType: 'PP01', ...orderInput('CO01-FG', 'fg-create'), });
    expect(view.status).toBe('CREATED');
    expect(view.productionVersion).toBe('0001');
    expect(view.bomUsage).toBe('P');
    expect(view.bomAlternative).toBe('01');
    expect(view.components).toEqual([
      expect.objectContaining({ itemNumber: 10, bomItem: '0010', materialNumber: 'CO01-RM1', requiredQuantity: '20.000', unit: 'KG', plant: PLANT, sourceMaterial: 'CO01-FG' }),
      expect.objectContaining({ itemNumber: 20, bomItem: '0020', materialNumber: 'CO01-RM2', requiredQuantity: '3.000', unit: 'KG' }),
      expect.objectContaining({ itemNumber: 30, bomItem: '0030', materialNumber: 'CO01-RM3', requiredQuantity: '11.000', unit: 'KG' }),
    ]);
    expect(view.snapshotWarnings?.join(' ')).toMatch(/does not rewrite this snapshot/i);
    const footprint = await counts();
    expect(footprint.orders).toBe(before.orders + 1);
    expect(footprint.documents).toBe(0);
    expect(footprint.journals).toBe(0);
    expect(footprint.reservations).toBe(0);
  });

  it('matches the CO40 snapshot for the same material, quantity, and finish date', async () => {
    const planned = await createPlannedOrder({
      client, changedBy: ACTOR, requestKey: 'co01-compare',
      materialNumber: 'CO01-FG', plant: PLANT, quantity: '10', finishDate: FINISH,
    });
    const converted = await convertPlannedOrder({
      orderType: 'PP01',
      client, changedBy: ACTOR, orderNumber: planned.order.orderNumber, expectedVersion: planned.order.version,
    });
    const direct = await createProductionOrder(orderInput('CO01-FG', 'fg-compare'));
    const fromConversion = await getProductionOrder(client, converted.productionOrderNumber!);
    expect(fromConversion?.productionVersion).toBeNull();
    expect(direct.components.map((row) => ({
      itemNumber: row.itemNumber, materialNumber: row.materialNumber, requiredQuantity: row.requiredQuantity, unit: row.unit, plant: row.plant,
    }))).toEqual(fromConversion?.components.map((row) => ({
      itemNumber: row.itemNumber, materialNumber: row.materialNumber, requiredQuantity: row.requiredQuantity, unit: row.unit, plant: row.plant,
    })));
  });

  it('returns the stored snapshot for a repeated request and does not create a second order', async () => {
    const before = await counts();
    const [first, second] = await Promise.all([
      createProductionOrder(orderInput('CO01-FG', 'fg-race')),
      createProductionOrder(orderInput('CO01-FG', 'fg-race')),
    ]);
    expect(first.orderNumber).toBe(second.orderNumber);
    expect((await counts()).orders).toBe(before.orders + 1);
  });

  it('does not rewrite the snapshot when the BOM later changes', async () => {
    const created = await createProductionOrder(orderInput('CO01-CHG', 'chg-create'));
    expect(created.components[0]?.requiredQuantity).toBe('20.000');
    const standingBom = await withTenant(client, (tx) => tx.execute(sql`
      select version from material_bom
       where client = ${client} and material_number = 'CO01-CHG' and plant = ${PLANT} and usage = 'P' and alternative = '01'
    `)) as unknown as Array<{ version: number }>;
    await changeMaterialBom({
      client, changedBy: ACTOR, materialNumber: 'CO01-CHG', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01', version: standingBom[0].version,
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'CHG-RM', quantity: '9', unit: 'KG' }],
    });
    const standing = await getProductionOrder(client, created.orderNumber);
    expect(standing?.components[0]?.requiredQuantity).toBe('20.000');
    expect(standing?.productionVersion).toBe('0001');
    const before = await counts();
    await expect(createProductionOrder(orderInput('CO01-CHG', 'chg-after'))).rejects.toThrow(/No order was created/);
    expect(await counts()).toEqual(before);
    expect((await getProductionOrder(client, created.orderNumber))?.components[0]?.requiredQuantity).toBe('20.000');
  });

  it('creates no order when the version or BOM cannot be used', async () => {
    const before = await counts();
    await expect(createProductionOrder(orderInput('CO01-MISS', 'miss'))).rejects.toThrow(/No order was created/);
    await expect(createProductionOrder({ orderType: 'PP01', ...orderInput('CO01-FG', 'bad-version'), productionVersion: 'ZZZZ' })).rejects.toThrow(/No order was created/);
    await expect(createProductionOrder(orderInput('CO01-PH', 'phantom'))).rejects.toThrow(/phantom/);
    await expect(createProductionOrder(orderInput('CO01-BK', 'bulk'))).rejects.toThrow(/bulk/);
    await expect(createProductionOrder(orderInput('CO01-OUT', 'out'))).rejects.toThrow(/no component in effect/);
    await expect(createProductionOrder(orderInput('CO01-AMB', 'ambiguous'))).rejects.toThrow(/Choose one/);
    expect(await counts()).toEqual(before);
  });

  it('uses a named version through the selector and does not accept an alternative bypass', async () => {
    const named = await createProductionOrder({ orderType: 'PP01', ...orderInput('CO01-AMB', 'amb-named'), productionVersion: '0002' });
    expect(named.productionVersion).toBe('0002');
    expect(named.bomAlternative).toBe('02');
    expect(named.components[0]?.requiredQuantity).toBe('40.000');
  });

  it('does not walk a component BOM, so a recursive structure cannot loop', async () => {
    const view = await createProductionOrder(orderInput('CO01-REC', 'recursive'));
    expect(view.components.map((row) => row.materialNumber)).toEqual(['REC-RM']);
    expect(view.components[0]?.requiredQuantity).toBe('20.000');
    expect(view.components[0]?.bomItem).toBe('0010');
  });

  it('refuses an unextended component without leaving an order', async () => {
    await withTenant(client, (tx) => tx.execute(sql`
      delete from material_plant where client = ${client} and material_number = 'EXT-RM' and plant = ${PLANT}
    `));
    const before = await counts();
    await expect(createProductionOrder(orderInput('CO01-EXT', 'unextended'))).rejects.toThrow(/not extended/);
    expect(await counts()).toEqual(before);
  });

  it('keeps a caller-supplied snapshot without recording a production version', async () => {
    const view = await createProductionOrder({
      orderType: 'PP01',
      ...orderInput('CO01-FG', 'supplied'),
      components: [{ materialNumber: 'CO01-RM1', plant: PLANT, requiredQuantity: 5 }],
    });
    expect(view.productionVersion).toBeNull();
    expect(view.components).toEqual([
      expect.objectContaining({ itemNumber: 10, materialNumber: 'CO01-RM1', requiredQuantity: '5.000', bomItem: null, sourceMaterial: null }),
    ]);
  });

  it('does not show the order to another tenant', async () => {
    const view = await createProductionOrder(orderInput('CO01-FG', 'tenant-owner'));
    expect(await getProductionOrder('ZZZ9', view.orderNumber)).toBeNull();
    const [hidden] = await withTenant('ZZZ9', (tx) => tx.execute(sql`
      select count(*)::int as total from production_order where order_number = ${view.orderNumber}
    `)) as unknown as Array<{ total: number }>;
    expect(hidden.total).toBe(0);
  });
});
