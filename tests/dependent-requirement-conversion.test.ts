import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createProductionOrder } from '../src/modules/inventory/production-orders';
import { mrpController } from '../src/modules/inventory/schema';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { planMaterials, planSingleItem } from '../src/modules/production/mrp-run';
import { saveOrderTypeParameter } from '../src/modules/production/order-type-parameters';
import { createPlannedOrder } from '../src/modules/production/planned-order-create';
import { convertPlannedOrder, convertPlannedOrders, previewPlannedOrderConversion } from '../src/modules/production/planned-order-conversion';
import {
  PRODUCTION_ORDER_CHANGE_CAPABILITY,
  changeProductionOrder,
  productionOrderChangeRefusal,
  revokeTechnicalCompletion,
  technicallyCompleteProductionOrder,
} from '../src/modules/production/production-order-change';
import { getProductionOrderDisplay } from '../src/modules/production/production-order-display';
import { createProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { stockRequirementsList } from '../src/modules/production/stock-requirements';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * A production-order component is planning demand only when conversion copied
 * the date and quantity from a matching dependent requirement. That dependent
 * row is then closed. An unmatched row stays open. The order start is not used.
 */
const HELD = [PRODUCTION_ORDER_CHANGE_CAPABILITY];
const ACTOR = 'CO40_DEP';
const PLANT = '1000';
const FINISH = '2026-10-30';

let tenant: TestTenant;
let other: TestTenant;
let key = 0;
const nextKey = () => `dep-conv-${++key}`;

async function extend(client: string, materialNumber: string, procurement: 'MAKE' | 'BUY') {
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Dependent requirement conversion', view: 'BASIC', description: materialNumber, materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Dependent requirement conversion', view: 'PURCHASING', plant: PLANT,
    purchasingGroup: '', orderUnit: 'KG', overdeliveryTolerance: '0',
    underdeliveryTolerance: '0', manufacturerPartNumber: '',
  });
  await saveMaterialView({
    client, materialNumber, changedBy: ACTOR, expectedVersion: 1,
    reason: 'Dependent requirement conversion', view: 'MRP', plant: PLANT,
    mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: procurement, lotSizing: 'EXACT',
    fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '0', reorderPoint: '0',
    plannedDeliveryDays: 0, inHouseProductionDays: 0,
  });
}

async function dependents(client: string, parent?: string) {
  return withTenant(client, (tx) => tx.execute(sql`
    select parent_order_number, source_material, item_number, material_number,
           quantity::text as quantity, status, version
      from mrp_dependent_requirement
     where client = ${client}
       and (${parent ?? ''} = '' or parent_order_number = ${parent ?? ''})
     order by parent_order_number, item_number
  `)) as unknown as Promise<Array<{
    parent_order_number: string;
    source_material: string;
    item_number: string;
    material_number: string;
    quantity: string;
    status: string;
    version: number;
  }>>;
}

describe('dependent requirements survive conversion', () => {
  beforeAll(async () => {
    tenant = await createTenant('dep-conv');
    other = await createTenant('dep-conv-other');
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(mrpController).values({
        client: tenant.client, controller: '001', name: 'Controller 001', isActive: true, createdBy: ACTOR,
      }).onConflictDoNothing();
      await defineRange(tx, { client: tenant.client, objectCode: 'MRPRUN', subObject: '*', prefix: 'MR', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${tenant.client}, 'PP01', 'Standard production', '10', ${ACTOR})
      `);
    });
    await saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      taskListType: '', productionVersionSelection: '0', version: 0, reason: 'Automatic selection',
    });
    await extend(tenant.client, 'FG-DEP', 'MAKE');
    await extend(tenant.client, 'FG-OTHER', 'MAKE');
    await extend(tenant.client, 'COMP-DEP', 'BUY');
    await saveBomUsage({
      client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock',
      materialEntry: '+', quantityEntry: '+',
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-DEP', plant: PLANT, usage: 'P',
      alternative: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
      items: [
        { itemNumber: '0010', itemCategory: 'S', componentMaterial: 'COMP-DEP', quantity: '2', unit: 'KG' },
        { itemNumber: '0020', itemCategory: 'S', componentMaterial: 'COMP-DEP', quantity: '3', unit: 'KG' },
      ],
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-OTHER', plant: PLANT, usage: 'P',
      alternative: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'COMP-DEP', quantity: '1', unit: 'KG' }],
    });
    await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingControlKey({ client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal' });
    await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    await createWorkCenter({
      client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WCDEP', category: 'MACH', description: 'Assembly',
    });
    await createRouting({
      client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup: '50000091', groupCounter: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
      assignments: [{ materialNumber: 'FG-DEP' }, { materialNumber: 'FG-OTHER' }],
      operations: [{ operationNumber: '0010', shortText: 'Make', workCenter: 'WCDEP', controlKey: 'PP01' }],
    });
    await createProductionVersion({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-DEP', plant: PLANT, productionVersion: '0001',
      validFrom: '2026-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'KG',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000091', groupCounter: '01',
    });
    await createProductionVersion({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-OTHER', plant: PLANT, productionVersion: '0001',
      validFrom: '2026-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'KG',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000091', groupCounter: '01',
    });
    await withTenant(other.client, async (tx) => {
      await tx.insert(mrpController).values({
        client: other.client, controller: '001', name: 'Controller 001', isActive: true, createdBy: ACTOR,
      }).onConflictDoNothing();
      await defineRange(tx, { client: other.client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
    });
    await extend(other.client, 'FG-FOREIGN', 'MAKE');
    await extend(other.client, 'COMP-FOREIGN', 'BUY');
  }, 180_000);

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
    await closeDb();
  }, 180_000);

  it('copies a matched dependent date and does not invent one', () => {
    const conversion = readFileSync('src/modules/production/planned-order-conversion.ts', 'utf8');
    const planning = readFileSync('src/modules/production/mrp-run.ts', 'utf8');
    const list = readFileSync('src/modules/production/stock-requirements.ts', 'utf8');
    const explosion = readFileSync('src/modules/production/mrp-explosion.ts', 'utf8');
    const reconcile = conversion.slice(
      conversion.indexOf('async function replaceMatchedDependentDemand'),
      conversion.indexOf('export async function convertPlannedOrder'),
    );
    const demand = planning.slice(
      planning.indexOf('async function productionComponentDemand'),
      planning.indexOf('async function calculate'),
    );
    expect(reconcile).toContain('parent_order_number =');
    expect(reconcile).toContain("status = 'OPEN'");
    expect(reconcile).toContain('requirement_date =');
    expect(reconcile).not.toContain('start_date');
    expect(reconcile).not.toContain('finish_date');
    expect(reconcile).not.toContain('scheduled_start');
    expect(demand).toContain('requirement_date is not null');
    expect(demand).toContain("o.status in ('CREATED', 'RELEASED')");
    expect(demand).not.toContain('received');
    expect(demand).not.toContain('scheduled_finish');
    expect(planning).toContain('PRODUCTION_COMPONENT_DEMAND');
    expect(planning).toContain('its components are not exploded');
    expect(list).toContain("elementType: 'PRODUCTION_COMPONENT'");
    expect(list).toContain('requirement_date is not null');
    expect(explosion).toContain('component.requirement_date is not null');
    expect(explosion).toContain("open_demand.status = 'OPEN'");
    expect(explosion).toContain("where mrp_dependent_requirement.status = 'OPEN'");
    expect(reconcile).toContain('dated.length !== 1');
    expect(reconcile).toContain('closed.length !== 1');
    expect(reconcile).toContain('Nothing was converted');
    expect(reconcile).toContain("'PARTIAL'");
    expect(reconcile).toContain('quantity');
    const convert = conversion.slice(
      conversion.indexOf('export async function convertPlannedOrder'),
      conversion.indexOf('export async function convertPlannedOrders'),
    );
    expect(convert.indexOf('createProductionOrder')).toBeLessThan(convert.indexOf('replaceMatchedDependentDemand'));
    expect(convert).toContain("reconciliation: 'NOT_RERUN'");
    const outcome = readFileSync('src/modules/production/conversion-outcome.ts', 'utf8');
    expect(outcome).toContain('Demand reconciliation is incomplete');
    expect(outcome).toContain('This is not an incomplete reconciliation.');
  });

  it('keeps the converted order’s requirements and every unrelated requirement', async () => {
    const selected = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-selected',
      materialNumber: 'FG-DEP', plant: PLANT, quantity: '10', finishDate: FINISH,
    });
    const sibling = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-sibling',
      materialNumber: 'FG-OTHER', plant: PLANT, quantity: '10', finishDate: FINISH,
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, production_version, bom_usage, bom_alternative, status, version, created_by
      ) values
        (${tenant.client}, ${selected.order.orderNumber}, 'FG-DEP', '0010', 'COMP-DEP', ${PLANT}, 20, 'KG', ${FINISH}, 'FG-DEP', '0001', 'P', '01', 'OPEN', 1, ${ACTOR}),
        (${tenant.client}, ${selected.order.orderNumber}, 'FG-DEP', '0020', 'COMP-DEP', ${PLANT}, 30, 'KG', ${FINISH}, 'FG-DEP', '0001', 'P', '01', 'OPEN', 1, ${ACTOR}),
        (${tenant.client}, ${sibling.order.orderNumber}, 'FG-OTHER', '0010', 'COMP-DEP', ${PLANT}, 10, 'KG', ${FINISH}, 'FG-OTHER', '0001', 'P', '01', 'OPEN', 1, ${ACTOR})
    `));
    const selectedRows = await dependents(tenant.client, selected.order.orderNumber);
    const siblingRows = await dependents(tenant.client, sibling.order.orderNumber);
    expect(selectedRows.map((row) => [row.item_number, row.material_number, row.quantity, row.status])).toEqual([
      ['0010', 'COMP-DEP', '20.000', 'OPEN'],
      ['0020', 'COMP-DEP', '30.000', 'OPEN'],
    ]);
    expect(siblingRows).toEqual([
      expect.objectContaining({ item_number: '0010', material_number: 'COMP-DEP', quantity: '10.000', status: 'OPEN' }),
    ]);

    const foreign = await createPlannedOrder({
      client: other.client, changedBy: ACTOR, requestKey: 'foreign-dep',
      materialNumber: 'FG-FOREIGN', plant: PLANT, quantity: '4', finishDate: FINISH,
    });
    await withTenant(other.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values (
        ${other.client}, ${foreign.order.orderNumber}, 'FG-FOREIGN', '0010', 'COMP-FOREIGN', ${PLANT}, 4, 'KG',
        ${FINISH}, 'FG-FOREIGN', 'OPEN', 1, ${ACTOR}
      )
    `));

    const converted = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: selected.order.orderNumber, orderType: 'PP01',
    });
    expect(converted.status).toBe('CONVERTED');
    expect(converted.reconciliation).toBe('COMPLETE');
    expect(converted.message).toMatch(/Every open dependent requirement was reconciled/);
    expect(converted.warnings.join(' ')).toMatch(/were closed after the same requirement date/);
    expect(converted.warnings.join(' ')).not.toMatch(/not the only line/);
    const replaced = await dependents(tenant.client, selected.order.orderNumber);
    expect(replaced.map((row) => [row.item_number, row.quantity, row.status, row.version])).toEqual([
      ['0010', '20.000', 'CLOSED', 2],
      ['0020', '30.000', 'CLOSED', 2],
    ]);
    const dated = await getProductionOrderDisplay(tenant.client, converted.productionOrderNumber!);
    expect(dated?.components.map((row) => [row.bomItem, row.requirementDate, row.requiredQuantity])).toEqual([
      ['0010', FINISH, '20.000'],
      ['0020', FINISH, '30.000'],
    ]);
    expect(await dependents(tenant.client, sibling.order.orderNumber)).toEqual(siblingRows);
    expect(await dependents(other.client, foreign.order.orderNumber)).toEqual([
      expect.objectContaining({ quantity: '4.000', status: 'OPEN', material_number: 'COMP-FOREIGN' }),
    ]);

    const again = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: selected.order.orderNumber, orderType: 'PP01',
    });
    expect(again.status).toBe('ALREADY_CONVERTED');
    expect(again.reconciliation).toBe('NOT_RERUN');
    expect(again.message).toMatch(/not revalidated/);
    expect(again.warnings.join(' ')).toMatch(/not reconciled again/);
    expect(again.productionOrderNumber).toBe(converted.productionOrderNumber);
    const collective = await convertPlannedOrders({
      client: tenant.client, changedBy: ACTOR, correlationId: 'dep-repeat',
      orderNumbers: [selected.order.orderNumber], orderType: 'PP01',
    });
    expect(collective.results[0]?.status).toBe('ALREADY_CONVERTED');
    expect(await dependents(tenant.client, selected.order.orderNumber)).toEqual(replaced);

    const failed = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-fail',
      materialNumber: 'FG-DEP', plant: PLANT, quantity: '10', finishDate: FINISH,
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values (
        ${tenant.client}, ${failed.order.orderNumber}, 'FG-DEP', '0010', 'COMP-DEP', ${PLANT}, 9, 'KG',
        ${FINISH}, 'FG-DEP', 'OPEN', 1, ${ACTOR}
      )
    `));
    await expect(convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: failed.order.orderNumber, orderType: 'ZZ99',
    })).rejects.toMatchObject({ reconciliation: 'ROLLED_BACK' });
    expect(await dependents(tenant.client, failed.order.orderNumber)).toEqual([
      expect.objectContaining({ quantity: '9.000', status: 'OPEN', version: 1 }),
    ]);
    expect(await dependents(tenant.client, selected.order.orderNumber)).toEqual(replaced);

    const componentList = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    const demand = componentList.rows.filter((row) => row.elementType === 'DEPENDENT_REQUIREMENT');
    expect(demand.map((row) => row.quantity).sort((left, right) => left - right)).toEqual([9, 10]);
    const componentDemand = componentList.rows.filter((row) => row.elementType === 'PRODUCTION_COMPONENT');
    expect(componentDemand.map((row) => [row.documentNumber, row.quantity, row.date])).toEqual([
      [converted.productionOrderNumber, 20, FINISH],
      [converted.productionOrderNumber, 30, FINISH],
    ]);
    expect(new Set(componentDemand.map((row) => row.documentItem)).size).toBe(2);
    expect(componentList.rows.some((row) => row.elementType === 'PRODUCTION_ORDER')).toBe(false);
    expect(componentList.rows.some((row) => row.elementType === 'RESERVATION')).toBe(false);
    const parentList = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'FG-DEP', plant: PLANT },
    });
    expect(parentList.rows.some((row) => row.elementType === 'PRODUCTION_ORDER' && row.direction === 'RECEIPT')).toBe(true);
    expect(parentList.rows.some((row) => row.elementType === 'DEPENDENT_REQUIREMENT')).toBe(false);

    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update planning_file set net_change = true
       where client = ${tenant.client} and plant = ${PLANT} and material_number in ('FG-DEP', 'FG-OTHER')
    `));
    const later = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH',
      plantFrom: PLANT, materialFrom: 'FG-DEP', materialTo: 'FG-OTHER',
    });
    expect(later.diagnostics.some((row) => row.diagnosticCode === 'PRODUCTION_ORDER_COUNTED')).toBe(true);
    const after = await dependents(tenant.client, selected.order.orderNumber);
    expect(after).toHaveLength(2);
    expect(after.every((row) => row.status === 'CLOSED')).toBe(true);
    expect(new Set(after.map((row) => row.item_number))).toEqual(new Set(['0010', '0020']));
    expect(await dependents(tenant.client, sibling.order.orderNumber)).toEqual([
      expect.objectContaining({ item_number: '0010', quantity: '10.000', status: 'OPEN' }),
    ]);
    expect(await dependents(other.client)).toHaveLength(1);
    const projected = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    const openDemand = (await dependents(tenant.client)).filter((row) => row.status === 'OPEN' && row.material_number === 'COMP-DEP');
    const remaining = projected.rows.filter((row) => row.elementType === 'DEPENDENT_REQUIREMENT');
    expect(remaining.reduce((sum, row) => sum + row.quantity, 0)).toBe(
      openDemand.reduce((sum, row) => sum + Number(row.quantity), 0),
    );
    expect(projected.rows.filter((row) => row.documentNumber === selected.order.orderNumber && row.elementType === 'DEPENDENT_REQUIREMENT')).toHaveLength(0);
    expect(projected.rows.filter((row) => row.documentNumber === converted.productionOrderNumber && row.elementType === 'PRODUCTION_COMPONENT')).toHaveLength(2);
    expect(projected.rows.some((row) => row.elementType === 'PRODUCTION_ORDER')).toBe(false);
  }, 180_000);

  it('keeps an unmatched dependent open and does not date the order from its start', async () => {
    const planned = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-partial',
      materialNumber: 'FG-DEP', plant: PLANT, quantity: '10', finishDate: FINISH,
    });
    expect(planned.order.startDate).not.toBe('2026-12-15');
    expect(planned.order.finishDate).not.toBe('2026-12-15');
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values
        (${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0010', 'COMP-DEP', ${PLANT}, 20, 'KG', '2026-12-15', 'FG-DEP', 'OPEN', 1, ${ACTOR}),
        (${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0020', 'COMP-DEP', ${PLANT}, 9, 'KG', '2026-12-16', 'FG-DEP', 'OPEN', 1, ${ACTOR})
    `));
    const converted = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: planned.order.orderNumber, orderType: 'PP01',
    });
    expect(converted.status).toBe('CONVERTED');
    expect(converted.reconciliation).toBe('PARTIAL');
    expect(converted.message).toMatch(/Demand reconciliation is incomplete/);
    expect(converted.warnings.join(' ')).toMatch(/stayed open/);
    expect(converted.warnings.join(' ')).toMatch(/quantity 9.000 is not 30.000/);
    expect(await dependents(tenant.client, planned.order.orderNumber)).toEqual([
      expect.objectContaining({ item_number: '0010', quantity: '20.000', status: 'CLOSED' }),
      expect.objectContaining({ item_number: '0020', quantity: '9.000', status: 'OPEN' }),
    ]);
    const shown = await getProductionOrderDisplay(tenant.client, converted.productionOrderNumber!);
    expect(shown?.components.find((row) => row.bomItem === '0010')?.requirementDate).toBe('2026-12-15');
    expect(shown?.components.find((row) => row.bomItem === '0020')?.requirementDate).toBeNull();
    const list = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    const replaced = list.rows.filter((row) => row.documentNumber === converted.productionOrderNumber && row.elementType === 'PRODUCTION_COMPONENT');
    expect(replaced).toEqual([expect.objectContaining({ quantity: 20, date: '2026-12-15', direction: 'REQUIREMENT' })]);
    expect(list.rows.filter((row) => row.documentNumber === planned.order.orderNumber && row.elementType === 'DEPENDENT_REQUIREMENT')).toEqual([
      expect.objectContaining({ quantity: 9, date: '2026-12-16' }),
    ]);
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update planning_file set net_change = true
       where client = ${tenant.client} and plant = ${PLANT} and material_number = 'FG-DEP'
    `));
    await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH',
      plantFrom: PLANT, materialFrom: 'FG-DEP', materialTo: 'FG-DEP',
    });
    expect(await dependents(tenant.client, planned.order.orderNumber)).toEqual([
      expect.objectContaining({ item_number: '0010', quantity: '20.000', status: 'CLOSED', version: 2 }),
      expect.objectContaining({ item_number: '0020', quantity: '30.000', status: 'OPEN' }),
    ]);
    const refreshed = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(refreshed.rows.filter((row) => row.documentNumber === converted.productionOrderNumber && row.elementType === 'PRODUCTION_COMPONENT')).toEqual([
      expect.objectContaining({ quantity: 20, date: '2026-12-15', direction: 'REQUIREMENT' }),
    ]);
    expect(refreshed.rows.filter((row) => row.documentNumber === planned.order.orderNumber && row.elementType === 'DEPENDENT_REQUIREMENT')).toEqual([
      expect.objectContaining({ quantity: 30, date: planned.order.startDate, direction: 'REQUIREMENT' }),
    ]);
    expect(refreshed.rows.some((row) => row.documentNumber === planned.order.orderNumber && row.quantity === 20)).toBe(false);
    expect(refreshed.warnings.join(' ')).toMatch(/active planning demand/);
    expect(refreshed.warnings.join(' ')).toMatch(/not counted again/);
    const afterRefresh = await getProductionOrderDisplay(tenant.client, converted.productionOrderNumber!);
    expect(afterRefresh?.components.find((row) => row.bomItem === '0020')?.requirementDate).toBeNull();
    const hidden = await withTenant(other.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order_component where requirement_date is not null
    `)) as unknown as Array<{ n: number }>;
    expect(hidden[0]?.n).toBe(0);
  }, 180_000);

  it('reports an established mismatch, leaves another order untouched, and rolls a failed conversion back', async () => {
    const sibling = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-reason-sibling',
      materialNumber: 'FG-OTHER', plant: PLANT, quantity: '4', finishDate: FINISH,
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values (
        ${tenant.client}, ${sibling.order.orderNumber}, 'FG-OTHER', '0010', 'COMP-DEP', ${PLANT}, 4, 'KG',
        '2026-12-18', 'FG-OTHER', 'OPEN', 1, ${ACTOR}
      )
    `));
    const planned = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-reasons',
      materialNumber: 'FG-DEP', plant: PLANT, quantity: '10', finishDate: FINISH,
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values
        (${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0010', 'COMP-DEP', ${PLANT}, 20, 'KG', '2026-12-21', 'FG-DEP', 'OPEN', 1, ${ACTOR}),
        (${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0020', 'COMP-DEP', ${PLANT}, 30, 'PC', '2026-12-22', 'FG-DEP', 'OPEN', 1, ${ACTOR}),
        (${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0090', 'COMP-DEP', ${PLANT}, 4, 'KG', '2026-12-23', 'FG-DEP', 'OPEN', 1, ${ACTOR})
    `));
    const preview = await previewPlannedOrderConversion(tenant.client, planned.order.orderNumber);
    expect(preview?.warnings.join(' ')).toMatch(/3 open dependent requirement/);
    expect(preview?.warnings.join(' ')).toMatch(/stays open/);
    const converted = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: planned.order.orderNumber, orderType: 'PP01',
    });
    expect(converted.status).toBe('CONVERTED');
    expect(converted.reconciliation).toBe('PARTIAL');
    expect(converted.message).toMatch(/Conversion succeeded/);
    expect(converted.message).toMatch(/Demand reconciliation is incomplete/);
    const reasons = converted.warnings.join(' ');
    expect(reasons).toMatch(/unit PC is not KG/);
    expect(reasons).toMatch(/0090 has no production-order component for FG-DEP\/0090/);
    expect(reasons).not.toMatch(/not the only line/);
    expect(await dependents(tenant.client, planned.order.orderNumber)).toEqual([
      expect.objectContaining({ item_number: '0010', quantity: '20.000', status: 'CLOSED', version: 2 }),
      expect.objectContaining({ item_number: '0020', quantity: '30.000', status: 'OPEN', version: 1 }),
      expect.objectContaining({ item_number: '0090', quantity: '4.000', status: 'OPEN', version: 1 }),
    ]);
    const shown = await getProductionOrderDisplay(tenant.client, converted.productionOrderNumber!);
    expect(shown?.components.find((row) => row.bomItem === '0010')?.requirementDate).toBe('2026-12-21');
    expect(shown?.components.find((row) => row.bomItem === '0020')?.requirementDate).toBeNull();
    expect(await dependents(tenant.client, sibling.order.orderNumber)).toEqual([
      expect.objectContaining({ quantity: '4.000', status: 'OPEN', version: 1 }),
    ]);
    const list = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(list.rows.filter((row) => row.documentNumber === converted.productionOrderNumber && row.elementType === 'PRODUCTION_COMPONENT')).toEqual([
      expect.objectContaining({ quantity: 20, date: '2026-12-21', direction: 'REQUIREMENT' }),
    ]);
    expect(list.rows.filter((row) => row.documentNumber === planned.order.orderNumber && row.elementType === 'DEPENDENT_REQUIREMENT').map((row) => row.quantity).sort((left, right) => left - right)).toEqual([4, 30]);
    expect(list.rows.some((row) => row.documentNumber === converted.productionOrderNumber && row.elementType === 'PRODUCTION_ORDER')).toBe(false);
    expect(list.rows.some((row) => row.documentNumber === planned.order.orderNumber && row.quantity === 20)).toBe(false);
    expect(list.warnings.join(' ')).toMatch(/active planning demand/);
    expect(list.warnings.join(' ')).toMatch(/not counted again/);

    const again = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: planned.order.orderNumber, orderType: 'PP01',
    });
    expect(again).toMatchObject({ status: 'ALREADY_CONVERTED', reconciliation: 'NOT_RERUN', productionOrderNumber: converted.productionOrderNumber });
    expect(again.message).toMatch(/not revalidated/);
    expect(again.warnings.join(' ')).toMatch(/not reconciled again/);
    expect(await dependents(tenant.client, planned.order.orderNumber)).toEqual([
      expect.objectContaining({ item_number: '0010', status: 'CLOSED', version: 2 }),
      expect.objectContaining({ item_number: '0020', status: 'OPEN', version: 1 }),
      expect.objectContaining({ item_number: '0090', status: 'OPEN', version: 1 }),
    ]);

    const closedOrder = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-already-closed',
      materialNumber: 'FG-DEP', plant: PLANT, quantity: '10', finishDate: FINISH,
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values
        (${tenant.client}, ${closedOrder.order.orderNumber}, 'FG-DEP', '0010', 'COMP-DEP', ${PLANT}, 20, 'KG', '2026-12-24', 'FG-DEP', 'CLOSED', 1, ${ACTOR}),
        (${tenant.client}, ${closedOrder.order.orderNumber}, 'FG-DEP', '0020', 'COMP-DEP', ${PLANT}, 30, 'KG', '2026-12-25', 'FG-DEP', 'CLOSED', 1, ${ACTOR})
    `));
    const closedConversion = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: closedOrder.order.orderNumber, orderType: 'PP01',
    });
    expect(closedConversion.reconciliation).toBe('NONE');
    expect(closedConversion.message).toMatch(/No open dependent requirement was reconciled/);
    expect(closedConversion.warnings.join(' ')).toMatch(/already closed/);
    expect(closedConversion.warnings.join(' ')).toMatch(/not reopened/);
    expect((await getProductionOrderDisplay(tenant.client, closedConversion.productionOrderNumber!))?.components.every((row) => row.requirementDate == null)).toBe(true);
    expect(await dependents(tenant.client, closedOrder.order.orderNumber)).toEqual([
      expect.objectContaining({ item_number: '0010', status: 'CLOSED', version: 1 }),
      expect.objectContaining({ item_number: '0020', status: 'CLOSED', version: 1 }),
    ]);
    const closedList = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(closedList.rows.some((row) => row.documentNumber === closedConversion.productionOrderNumber && row.elementType === 'PRODUCTION_COMPONENT')).toBe(false);
    expect(closedList.rows.some((row) => row.documentNumber === closedOrder.order.orderNumber && row.elementType === 'DEPENDENT_REQUIREMENT')).toBe(false);

    const failed = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-rollback',
      materialNumber: 'FG-DEP', plant: PLANT, quantity: '10', finishDate: FINISH,
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values (
        ${tenant.client}, ${failed.order.orderNumber}, 'FG-DEP', '0010', 'COMP-DEP', ${PLANT}, 20, 'KG',
        '2026-12-26', 'FG-DEP', 'OPEN', 1, ${ACTOR}
      )
    `));
    const collective = await convertPlannedOrders({
      client: tenant.client, changedBy: ACTOR, correlationId: 'dep-rollback',
      orderNumbers: [failed.order.orderNumber], orderType: 'ZZ99',
    });
    expect(collective.results[0]).toMatchObject({ status: 'FAILED', reconciliation: 'ROLLED_BACK', productionOrderNumber: null });
    expect(collective.results[0]?.warnings.join(' ')).toMatch(/not an incomplete reconciliation/);
    await expect(convertPlannedOrders({
      client: tenant.client, changedBy: ACTOR, correlationId: 'dep-empty', orderNumbers: [], orderType: 'PP01',
    })).rejects.toMatchObject({ code: 'EMPTY', reconciliation: 'NOT_ATTEMPTED' });
    expect(collective.results[0]?.warnings.join(' ')).toMatch(/not closed/);
    expect(await dependents(tenant.client, failed.order.orderNumber)).toEqual([
      expect.objectContaining({ quantity: '20.000', status: 'OPEN', version: 1 }),
    ]);
    const absent = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order where client = ${tenant.client} and planned_order_number = ${failed.order.orderNumber}
    `)) as unknown as Array<{ n: number }>;
    expect(absent[0]?.n).toBe(0);
    const foreign = await createPlannedOrder({
      client: other.client, changedBy: ACTOR, requestKey: 'dep-reason-foreign',
      materialNumber: 'FG-FOREIGN', plant: PLANT, quantity: '4', finishDate: FINISH,
    });
    await withTenant(other.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values (
        ${other.client}, ${foreign.order.orderNumber}, 'FG-FOREIGN', '0010', 'COMP-FOREIGN', ${PLANT}, 4, 'KG',
        '2026-12-27', 'FG-FOREIGN', 'OPEN', 1, ${ACTOR}
      )
    `));
    await expect(convertPlannedOrder({
      client: other.client, changedBy: ACTOR, orderNumber: planned.order.orderNumber, orderType: 'PP01',
    })).rejects.toThrow(/does not stand/);
    expect(await dependents(other.client, foreign.order.orderNumber)).toEqual([
      expect.objectContaining({ quantity: '4.000', status: 'OPEN', version: 1 }),
    ]);
    expect(await dependents(tenant.client, planned.order.orderNumber)).toEqual([
      expect.objectContaining({ item_number: '0010', status: 'CLOSED', version: 2 }),
      expect.objectContaining({ item_number: '0020', status: 'OPEN', version: 1 }),
      expect.objectContaining({ item_number: '0090', status: 'OPEN', version: 1 }),
    ]);
  }, 180_000);

  it('does not date a direct order or an unmatched conversion, and a later run can still refresh the open dependent', async () => {
    const direct = await createProductionOrder({
      client: tenant.client, createdBy: ACTOR, requestKey: 'co01-undated',
      materialNumber: 'FG-DEP', plant: PLANT, orderQuantity: 5, orderType: 'PP01',
      scheduledStart: '2026-10-20', scheduledFinish: '2026-10-30',
    });
    const directDisplay = await getProductionOrderDisplay(tenant.client, direct.orderNumber);
    expect(directDisplay?.components.length).toBeGreaterThan(0);
    expect(directDisplay?.components.every((row) => row.requirementDate == null)).toBe(true);
    expect(directDisplay?.gaps.join(' ')).toMatch(/no requirement date/);
    expect(directDisplay?.gaps.join(' ')).toMatch(/were not used/);
    const directList = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(directList.rows.some((row) => row.documentNumber === direct.orderNumber && row.elementType === 'PRODUCTION_COMPONENT')).toBe(false);

    const planned = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-unmatched',
      materialNumber: 'FG-DEP', plant: PLANT, quantity: '10', finishDate: FINISH,
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values (
        ${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0010', 'COMP-DEP', ${PLANT}, 9, 'KG',
        '2026-12-20', 'FG-DEP', 'OPEN', 1, ${ACTOR}
      )
    `));
    const converted = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: planned.order.orderNumber, orderType: 'PP01',
    });
    expect(converted.status).toBe('CONVERTED');
    expect(converted.warnings.join(' ')).toMatch(/stayed open/);
    const undated = await getProductionOrderDisplay(tenant.client, converted.productionOrderNumber!);
    expect(undated?.components.every((row) => row.requirementDate == null)).toBe(true);
    expect(await dependents(tenant.client, planned.order.orderNumber)).toEqual([
      expect.objectContaining({ item_number: '0010', quantity: '9.000', status: 'OPEN', version: 1 }),
    ]);
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update planning_file set net_change = true
       where client = ${tenant.client} and plant = ${PLANT} and material_number = 'FG-DEP'
    `));
    await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH',
      plantFrom: PLANT, materialFrom: 'FG-DEP', materialTo: 'FG-DEP',
    });
    const refreshed = await dependents(tenant.client, planned.order.orderNumber);
    expect(refreshed.map((row) => [row.item_number, row.quantity, row.status])).toEqual([
      ['0010', '20.000', 'OPEN'],
      ['0020', '30.000', 'OPEN'],
    ]);
    const list = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(list.rows.some((row) => row.documentNumber === converted.productionOrderNumber && row.elementType === 'PRODUCTION_COMPONENT')).toBe(false);
  }, 180_000);

  it('follows a quantity change, technical completion, and a partial receipt without reducing or reopening demand', async () => {
    const planned = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-lifecycle',
      materialNumber: 'FG-DEP', plant: PLANT, quantity: '10', finishDate: FINISH,
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values
        (${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0010', 'COMP-DEP', ${PLANT}, 20, 'KG', '2026-12-01', 'FG-DEP', 'OPEN', 1, ${ACTOR}),
        (${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0020', 'COMP-DEP', ${PLANT}, 30, 'KG', '2026-12-02', 'FG-DEP', 'OPEN', 1, ${ACTOR})
    `));
    const converted = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: planned.order.orderNumber, orderType: 'PP01',
    });
    const orderNumber = converted.productionOrderNumber!;
    const opened = await getProductionOrderDisplay(tenant.client, orderNumber);
    const changed = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: opened!.version,
      components: [{ itemNumber: 10, materialNumber: 'COMP-DEP', requiredQuantity: '7', unit: 'KG' }],
    });
    expect(changed.order.components.find((row) => row.itemNumber === 10)).toMatchObject({
      requiredQuantity: '7.000', requirementDate: '2026-12-01',
    });
    const added = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: changed.order.version,
      components: [{ materialNumber: 'COMP-DEP', requiredQuantity: '1', unit: 'KG' }],
    });
    expect(added.order.components.find((row) => row.itemNumber === 30)?.requirementDate).toBeNull();
    const header = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: added.order.version, quantity: '12',
    });
    expect(header.order.quantity).toBe('12.000');
    expect(header.order.components.find((row) => row.itemNumber === 10)?.requiredQuantity).toBe('7.000');
    expect(await dependents(tenant.client, planned.order.orderNumber)).toEqual([
      expect.objectContaining({ item_number: '0010', status: 'CLOSED', quantity: '20.000' }),
      expect.objectContaining({ item_number: '0020', status: 'CLOSED', quantity: '30.000' }),
    ]);
    const before = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(before.rows.filter((row) => row.documentNumber === orderNumber && row.elementType === 'PRODUCTION_COMPONENT').map((row) => row.quantity).sort((left, right) => left - right)).toEqual([7, 30]);

    const completed = await technicallyCompleteProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: header.order.version, held: HELD, confirmed: true,
    });
    const hidden = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(hidden.rows.some((row) => row.documentNumber === orderNumber)).toBe(false);
    const hiddenParent = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'FG-DEP', plant: PLANT },
    });
    expect(hiddenParent.rows.some((row) => row.documentNumber === orderNumber && row.elementType === 'PRODUCTION_ORDER')).toBe(false);
    expect(await dependents(tenant.client, planned.order.orderNumber)).toEqual([
      expect.objectContaining({ item_number: '0010', status: 'CLOSED' }),
      expect.objectContaining({ item_number: '0020', status: 'CLOSED' }),
    ]);
    const revoked = await revokeTechnicalCompletion({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: completed.order.version, held: HELD, confirmed: true,
    });
    expect(revoked.order.status).toBe('CREATED');
    const restored = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(restored.rows.filter((row) => row.documentNumber === orderNumber && row.elementType === 'PRODUCTION_COMPONENT').map((row) => [row.documentItem, row.quantity, row.date])).toEqual([
      ['10', 7, '2026-12-01'],
      ['20', 30, '2026-12-02'],
    ]);

    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${tenant.client}, '101', 'Production receipt', 'RECEIPT', 'PRODUCTION_ORDER', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
        values (${tenant.client}, '4900001901', 2026, '2026-10-25', '2026-10-25', 'POSTED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          line_direction, entry_quantity, entry_unit, base_quantity, base_unit, production_order_number, created_by
        ) values (
          ${tenant.client}, '4900001901', 1, '101', 'FG-DEP', ${PLANT},
          'RECEIPT', 4, 'KG', 4, 'KG', ${orderNumber}, ${ACTOR}
        )
      `);
    });
    const received = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'FG-DEP', plant: PLANT },
    });
    expect(received.rows.find((row) => row.documentNumber === orderNumber && row.elementType === 'PRODUCTION_ORDER')?.quantity).toBe(8);
    const afterReceipt = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(afterReceipt.rows.filter((row) => row.documentNumber === orderNumber && row.elementType === 'PRODUCTION_COMPONENT').map((row) => row.quantity).sort((left, right) => left - right)).toEqual([7, 30]);
    expect(await dependents(tenant.client, planned.order.orderNumber)).toEqual([
      expect.objectContaining({ status: 'CLOSED', quantity: '20.000' }),
      expect.objectContaining({ status: 'CLOSED', quantity: '30.000' }),
    ]);
  }, 180_000);

  it('counts the dated component once in MD01 and MD04, and does not add the closed dependent again', async () => {
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update material_plant set purchasing_group = '001'
       where client = ${tenant.client} and material_number = 'COMP-DEP' and plant = ${PLANT}
    `));
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update planning_file set net_change = true
       where client = ${tenant.client} and plant = ${PLANT} and material_number = 'COMP-DEP'
    `));
    const open = (await dependents(tenant.client)).filter((row) => row.status === 'OPEN' && row.material_number === 'COMP-DEP');
    const closed = (await dependents(tenant.client)).filter((row) => row.status === 'CLOSED' && row.material_number === 'COMP-DEP');
    const dated = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select c.required_quantity::text as quantity
        from production_order_component c
        join production_order o on o.client = c.client and o.order_number = c.order_number
       where c.client = ${tenant.client} and c.material_number = 'COMP-DEP' and c.plant = ${PLANT}
         and c.requirement_date is not null and o.status in ('CREATED', 'RELEASED')
    `)) as unknown as Array<{ quantity: string }>;
    const openSum = open.reduce((sum, row) => sum + Number(row.quantity), 0);
    const datedSum = dated.reduce((sum, row) => sum + Number(row.quantity), 0);
    const closedSum = closed.reduce((sum, row) => sum + Number(row.quantity), 0);
    expect(datedSum).toBeGreaterThan(0);
    expect(closedSum).toBeGreaterThan(0);
    const run = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH',
      plantFrom: PLANT, materialFrom: 'COMP-DEP', materialTo: 'COMP-DEP',
    });
    const material = run.materials.find((row) => row.materialNumber === 'COMP-DEP');
    expect(material?.status).not.toBe('FAILED');
    expect(Number(material?.demandQuantity)).toBe(openSum + datedSum);
    expect(Number(material?.demandQuantity)).toBeLessThan(openSum + datedSum + closedSum);
    expect(run.diagnostics.some((row) => row.diagnosticCode === 'PRODUCTION_COMPONENT_DEMAND')).toBe(true);
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update planning_file set net_change = true
       where client = ${tenant.client} and plant = ${PLANT} and material_number = 'COMP-DEP'
    `));
    const single = await planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH',
      materialNumber: 'COMP-DEP', plant: PLANT,
    });
    expect(Number(single.materials.find((row) => row.materialNumber === 'COMP-DEP')?.demandQuantity)).toBe(openSum + datedSum);
    const list = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    const requirements = list.rows.filter((row) => row.elementType === 'DEPENDENT_REQUIREMENT' || row.elementType === 'PRODUCTION_COMPONENT');
    expect(requirements.reduce((sum, row) => sum + row.quantity, 0)).toBe(openSum + datedSum);
    expect(list.rows.some((row) => row.elementType === 'PRODUCTION_COMPONENT' && row.direction === 'RECEIPT')).toBe(false);
  }, 180_000);

  it('keeps a requirement date only while the component identity is unchanged', async () => {
    const change = readFileSync('src/modules/production/production-order-change.ts', 'utf8');
    const write = change.slice(change.indexOf('for (const itemNumber of removed)'), change.indexOf('const recorded = await recordChange'));
    expect(write).toContain('preservedRequirementDate');
    expect(write).toContain('requirementDate: null');
    expect(write).not.toContain('mrp_dependent_requirement');
    expect(write).not.toContain('requirementDate: start');
    expect(write).not.toContain('requirementDate: finish');
    expect(productionOrderChangeRefusal({ requirementDate: '2026-12-01' })).toMatch(/not entered/);
    expect(productionOrderChangeRefusal({ bomItem: '0090' })).toMatch(/not changed/);
    expect(productionOrderChangeRefusal({ sourceMaterial: 'FG-OTHER' })).toMatch(/not copied/);
    expect(productionOrderChangeRefusal({ componentPlant: '2000' })).toMatch(/not changed/);

    const unrelated = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-unrelated-co02',
      materialNumber: 'FG-OTHER', plant: PLANT, quantity: '4', finishDate: FINISH,
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values (
        ${tenant.client}, ${unrelated.order.orderNumber}, 'FG-OTHER', '0010', 'COMP-DEP', ${PLANT}, 4, 'KG',
        '2026-12-19', 'FG-OTHER', 'OPEN', 1, ${ACTOR}
      )
    `));
    const planned = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-co02-identity',
      materialNumber: 'FG-DEP', plant: PLANT, quantity: '10', finishDate: FINISH,
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values
        (${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0010', 'COMP-DEP', ${PLANT}, 20, 'KG', '2026-12-01', 'FG-DEP', 'OPEN', 1, ${ACTOR}),
        (${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0020', 'COMP-DEP', ${PLANT}, 30, 'KG', '2026-12-02', 'FG-DEP', 'OPEN', 1, ${ACTOR})
    `));
    const converted = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: planned.order.orderNumber, orderType: 'PP01',
    });
    const orderNumber = converted.productionOrderNumber!;
    const opened = await getProductionOrderDisplay(tenant.client, orderNumber);
    const changed = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: opened!.version,
      components: [{ itemNumber: 10, materialNumber: 'COMP-DEP', requiredQuantity: '7', unit: 'KG' }],
    });
    expect(changed.warnings.join(' ')).toMatch(/requirement date was kept/);
    expect(changed.order.components.find((row) => row.itemNumber === 10)).toMatchObject({
      requiredQuantity: '7.000', requirementDate: '2026-12-01', bomItem: '0010', sourceMaterial: 'FG-DEP',
    });
    expect(changed.order.scheduledStart).toBe(opened!.scheduledStart);
    const audit = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select i.old_value, i.new_value
        from change_document d
        join change_document_item i on i.change_document_id = d.id
       where d.client = ${tenant.client} and d.object_key = ${orderNumber} and d.change_type = 'CHANGE'
         and i.field_name = 'components'
       order by d.changed_at desc
       limit 1
    `)) as unknown as Array<{ old_value: string; new_value: string }>;
    expect(audit[0]?.old_value).toContain('2026-12-01');
    expect(audit[0]?.new_value).toContain('2026-12-01');
    expect(audit[0]?.new_value).toContain(':7:');
    expect(await dependents(tenant.client, planned.order.orderNumber)).toEqual([
      expect.objectContaining({ item_number: '0010', status: 'CLOSED', quantity: '20.000', version: 2 }),
      expect.objectContaining({ item_number: '0020', status: 'CLOSED', quantity: '30.000', version: 2 }),
    ]);
    expect(await dependents(tenant.client, unrelated.order.orderNumber)).toEqual([
      expect.objectContaining({ quantity: '4.000', status: 'OPEN', version: 1 }),
    ]);

    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${tenant.client}, ${PLANT}, '0001', 'Component store', true, false, ${ACTOR})
      on conflict do nothing
    `));
    const located = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: changed.order.version,
      components: [{ itemNumber: 10, materialNumber: 'COMP-DEP', requiredQuantity: '7', unit: 'KG', storageLocation: '0001' }],
    });
    expect(located.order.components.find((row) => row.itemNumber === 10)).toMatchObject({
      storageLocation: '0001', requirementDate: '2026-12-01', bomItem: '0010', sourceMaterial: 'FG-DEP',
    });
    const redated = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: located.order.version,
      startDate: '2026-10-21', finishDate: '2026-10-31',
    });
    expect(redated.warnings.join(' ')).toMatch(/not recalculated/);
    expect(redated.order.scheduledStart).toBe('2026-10-21');
    expect(redated.order.scheduledFinish).toBe('2026-10-31');
    expect(redated.order.components.map((row) => row.requirementDate).sort()).toEqual(['2026-12-01', '2026-12-02']);

    const version = redated.order.version;
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: version,
      components: [{ itemNumber: 10, materialNumber: 'COMP-OTHER', requiredQuantity: '7', unit: 'KG' }],
    })).rejects.toThrow(/not replaced/);
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: version,
      components: [{ itemNumber: 10, materialNumber: 'COMP-DEP', requiredQuantity: '7', unit: 'PC' }],
    })).rejects.toThrow(/not substituted/);
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: version, plant: '2000',
    })).rejects.toThrow(/plant is fixed/);
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: version,
      named: { bomItem: '0090' },
    })).rejects.toThrow(/not changed/);
    const foreignBefore = await dependents(other.client);
    await expect(changeProductionOrder({
      client: other.client, changedBy: ACTOR, orderNumber, expectedVersion: version, quantity: '11',
    })).rejects.toThrow(/does not stand/);
    expect((await getProductionOrderDisplay(tenant.client, orderNumber))?.version).toBe(version);
    expect((await getProductionOrderDisplay(tenant.client, orderNumber))?.components.find((row) => row.itemNumber === 10)?.requirementDate).toBe('2026-12-01');
    expect(await dependents(other.client)).toEqual(foreignBefore);

    const removed = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: version,
      components: [{ itemNumber: 20, materialNumber: 'COMP-DEP', requiredQuantity: '30', unit: 'KG', remove: true }],
    });
    expect(removed.warnings.join(' ')).toMatch(/no longer planning demand/);
    expect(removed.order.components.map((row) => row.itemNumber)).toEqual([10]);
    const afterRemoval = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(afterRemoval.rows.filter((row) => row.documentNumber === orderNumber && row.elementType === 'PRODUCTION_COMPONENT')).toEqual([
      expect.objectContaining({ documentItem: '10', quantity: 7, date: '2026-12-01' }),
    ]);
    expect(await dependents(tenant.client, planned.order.orderNumber)).toEqual([
      expect.objectContaining({ item_number: '0010', status: 'CLOSED' }),
      expect.objectContaining({ item_number: '0020', status: 'CLOSED' }),
    ]);
    expect(await dependents(tenant.client, unrelated.order.orderNumber)).toEqual([
      expect.objectContaining({ quantity: '4.000', status: 'OPEN', version: 1 }),
    ]);
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: removed.order.version,
      components: [{ itemNumber: 10, materialNumber: 'COMP-DEP', requiredQuantity: '7', unit: 'KG', remove: true }],
    })).rejects.toThrow(/at least one component/);
    expect((await getProductionOrderDisplay(tenant.client, orderNumber))?.components).toHaveLength(1);

    const added = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: removed.order.version,
      components: [{ materialNumber: 'COMP-DEP', requiredQuantity: '1', unit: 'KG' }],
    });
    expect(added.warnings.join(' ')).toMatch(/no requirement date/);
    const reused = added.order.components.find((row) => row.itemNumber === 20);
    expect(reused).toMatchObject({ requirementDate: null, bomItem: null, sourceMaterial: null, requiredQuantity: '1.000' });
    const afterAdd = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(afterAdd.rows.filter((row) => row.documentNumber === orderNumber && row.elementType === 'PRODUCTION_COMPONENT').map((row) => row.documentItem)).toEqual(['10']);

    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: opened!.version, quantity: '15',
    })).rejects.toThrow(/changed by someone else/);
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${tenant.client}, '101', 'Production receipt', 'RECEIPT', 'PRODUCTION_ORDER', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
        values (${tenant.client}, '4900001902', 2026, '2026-10-25', '2026-10-25', 'POSTED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          line_direction, entry_quantity, entry_unit, base_quantity, base_unit, production_order_number, created_by
        ) values (
          ${tenant.client}, '4900001902', 1, '101', 'FG-DEP', ${PLANT},
          'RECEIPT', 1, 'KG', 1, 'KG', ${orderNumber}, ${ACTOR}
        )
      `);
    });
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: added.order.version,
      components: [{ itemNumber: 10, materialNumber: 'COMP-DEP', requiredQuantity: '8', unit: 'KG' }],
    })).rejects.toThrow(/goods movement/);
    expect((await getProductionOrderDisplay(tenant.client, orderNumber))?.components.find((row) => row.itemNumber === 10)).toMatchObject({
      requiredQuantity: '7.000', requirementDate: '2026-12-01',
    });
    const hidden = await withTenant(other.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order_component where order_number = ${orderNumber}
    `)) as unknown as Array<{ n: number }>;
    expect(hidden[0]?.n).toBe(0);
  }, 180_000);

  it('keeps a copied requirement date when only the order start or finish changes', async () => {
    const change = readFileSync('src/modules/production/production-order-change.ts', 'utf8');
    const planning = readFileSync('src/modules/production/mrp-run.ts', 'utf8');
    const listSource = readFileSync('src/modules/production/stock-requirements.ts', 'utf8');
    const componentDemand = planning.slice(
      planning.indexOf('async function productionComponentDemand'),
      planning.indexOf('async function calculate'),
    );
    const receiptSupply = planning.slice(
      planning.indexOf('for (const row of production)'),
      planning.indexOf('for (const row of reservations)'),
    );
    expect(change).toContain('not recalculated');
    expect(change).toContain('only path that changes them');
    expect(change).not.toContain('requirementDate: start');
    expect(change).not.toContain('requirementDate: finish');
    expect(componentDemand).toContain('requirement_date');
    expect(componentDemand).not.toContain('scheduled_finish');
    expect(componentDemand).not.toContain('scheduled_start');
    expect(receiptSupply).toContain('scheduled_finish');
    expect(receiptSupply).not.toContain('requirement_date');
    expect(listSource).toContain('dated at the scheduled finish');

    const unrelated = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-header-unrelated',
      materialNumber: 'FG-OTHER', plant: PLANT, quantity: '4', finishDate: FINISH,
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values (
        ${tenant.client}, ${unrelated.order.orderNumber}, 'FG-OTHER', '0010', 'COMP-DEP', ${PLANT}, 8, 'KG',
        '2026-12-19', 'FG-OTHER', 'OPEN', 1, ${ACTOR}
      )
    `));
    const planned = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-header-dates',
      materialNumber: 'FG-DEP', plant: PLANT, quantity: '10', unit: 'KG',
      startDate: '2026-10-20', finishDate: FINISH,
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values
        (${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0010', 'COMP-DEP', ${PLANT}, 20, 'KG', '2026-12-11', 'FG-DEP', 'OPEN', 1, ${ACTOR}),
        (${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0020', 'COMP-DEP', ${PLANT}, 30, 'KG', '2026-12-12', 'FG-DEP', 'OPEN', 1, ${ACTOR})
    `));
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update material_plant set purchasing_group = '001'
       where client = ${tenant.client} and material_number = 'COMP-DEP' and plant = ${PLANT}
    `));
    const converted = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: planned.order.orderNumber, orderType: 'PP01',
    });
    expect(converted.warnings.join(' ')).toMatch(/were closed after the same requirement date/);
    const orderNumber = converted.productionOrderNumber!;
    const opened = (await getProductionOrderDisplay(tenant.client, orderNumber))!;
    expect(opened.scheduledStart).toBe('2026-10-20');
    expect(opened.scheduledFinish).toBe(FINISH);
    expect(opened.components.map((row) => row.requirementDate).sort()).toEqual(['2026-12-11', '2026-12-12']);
    expect(opened.gaps.join(' ')).toMatch(/does not move a component requirement date/);

    const componentRows = async () => (await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    })).rows.filter((row) => row.documentNumber === orderNumber && row.elementType === 'PRODUCTION_COMPONENT');
    const receiptRows = async () => (await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'FG-DEP', plant: PLANT },
    })).rows.filter((row) => row.documentNumber === orderNumber && row.elementType === 'PRODUCTION_ORDER');
    const planComponent = async () => {
      await withTenant(tenant.client, (tx) => tx.execute(sql`
        update planning_file set net_change = true
         where client = ${tenant.client} and plant = ${PLANT} and material_number = 'COMP-DEP'
      `));
      return planMaterials({
        client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH',
        plantFrom: PLANT, materialFrom: 'COMP-DEP', materialTo: 'COMP-DEP',
      });
    };
    const beforePlan = await planComponent();
    const beforeDemand = Number(beforePlan.materials.find((row) => row.materialNumber === 'COMP-DEP')?.demandQuantity);
    expect(beforePlan.materials.find((row) => row.materialNumber === 'COMP-DEP')?.status).not.toBe('FAILED');

    const startOnly = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: opened.version, startDate: '2026-10-18',
    });
    expect(startOnly.warnings.join(' ')).toMatch(/not recalculated/);
    expect(startOnly.warnings.join(' ')).toMatch(/scheduled finish/);
    expect(startOnly.order.scheduledStart).toBe('2026-10-18');
    expect(startOnly.order.scheduledFinish).toBe(FINISH);
    expect(startOnly.order.components.map((row) => row.requirementDate).sort()).toEqual(['2026-12-11', '2026-12-12']);
    expect((await componentRows()).map((row) => [row.date, row.quantity]).sort()).toEqual([['2026-12-11', 20], ['2026-12-12', 30]]);
    expect(await receiptRows()).toEqual([expect.objectContaining({ date: FINISH, direction: 'RECEIPT' })]);
    const startPlan = await planComponent();
    const startMessages = startPlan.diagnostics.filter((row) => row.message?.includes(orderNumber)).map((row) => row.message).join(' ');
    expect(Number(startPlan.materials.find((row) => row.materialNumber === 'COMP-DEP')?.demandQuantity)).toBe(beforeDemand);
    expect(startMessages).toContain('on 2026-12-11');
    expect(startMessages).toContain('on 2026-12-12');
    expect(startMessages).not.toContain('2026-10-18');

    const finishOnly = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: startOnly.order.version, finishDate: '2026-11-02',
    });
    expect(finishOnly.order.scheduledStart).toBe('2026-10-18');
    expect(finishOnly.order.scheduledFinish).toBe('2026-11-02');
    expect(finishOnly.order.components.map((row) => row.requirementDate).sort()).toEqual(['2026-12-11', '2026-12-12']);
    expect((await componentRows()).map((row) => [row.date, row.quantity]).sort()).toEqual([['2026-12-11', 20], ['2026-12-12', 30]]);
    expect(await receiptRows()).toEqual([expect.objectContaining({ date: '2026-11-02', direction: 'RECEIPT' })]);
    const finishPlan = await planComponent();
    const finishMessages = finishPlan.diagnostics.filter((row) => row.message?.includes(orderNumber)).map((row) => row.message).join(' ');
    expect(Number(finishPlan.materials.find((row) => row.materialNumber === 'COMP-DEP')?.demandQuantity)).toBe(beforeDemand);
    expect(finishMessages).toContain('on 2026-12-11');
    expect(finishMessages).toContain('on 2026-12-12');
    expect(finishMessages).not.toContain('2026-11-02');
    expect(await dependents(tenant.client, planned.order.orderNumber)).toEqual([
      expect.objectContaining({ item_number: '0010', status: 'CLOSED', quantity: '20.000', version: 2 }),
      expect.objectContaining({ item_number: '0020', status: 'CLOSED', quantity: '30.000', version: 2 }),
    ]);
    expect(await dependents(tenant.client, unrelated.order.orderNumber)).toEqual([
      expect.objectContaining({ status: 'OPEN', quantity: '8.000', version: 1 }),
    ]);

    const beforeFailure = (await getProductionOrderDisplay(tenant.client, orderNumber))!;
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: beforeFailure.version, finishDate: '2026-10-01',
    })).rejects.toThrow(/before the scheduled start/);
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: beforeFailure.version, startDate: '2026-02-31',
    })).rejects.toThrow(/not a valid date/);
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: beforeFailure.version + 1, finishDate: '2026-11-04',
    })).rejects.toThrow(/changed by someone else/);
    await expect(changeProductionOrder({
      client: other.client, changedBy: ACTOR, orderNumber, expectedVersion: beforeFailure.version, startDate: '2026-10-19',
    })).rejects.toThrow(/does not stand/);
    const afterFailure = (await getProductionOrderDisplay(tenant.client, orderNumber))!;
    expect(afterFailure.scheduledStart).toBe(beforeFailure.scheduledStart);
    expect(afterFailure.scheduledFinish).toBe(beforeFailure.scheduledFinish);
    expect(afterFailure.version).toBe(beforeFailure.version);
    expect(afterFailure.components).toEqual(beforeFailure.components);
    const hidden = await withTenant(other.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order_component where client = ${other.client}
    `)) as unknown as Array<{ n: number }>;
    expect(hidden[0]?.n).toBe(0);

    const manual = await createProductionOrder({
      client: tenant.client, createdBy: ACTOR, requestKey: 'co01-header-undated',
      materialNumber: 'FG-DEP', plant: PLANT, orderQuantity: 1, orderType: 'PP01',
      scheduledStart: '2026-10-20', scheduledFinish: FINISH,
    });
    const manualOpened = (await getProductionOrderDisplay(tenant.client, manual.orderNumber))!;
    const movedManual = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: manual.orderNumber,
      expectedVersion: manualOpened.version, startDate: '2026-10-19', finishDate: '2026-10-29',
    });
    expect(movedManual.warnings.join(' ')).toMatch(/No component requirement date was created/);
    expect(movedManual.order.components.every((row) => row.requirementDate == null)).toBe(true);
    const manualList = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(manualList.rows.some((row) => row.documentNumber === manual.orderNumber && row.elementType === 'PRODUCTION_COMPONENT')).toBe(false);

    const demandWithOrder = Number((await planComponent()).materials.find((row) => row.materialNumber === 'COMP-DEP')?.demandQuantity);
    const completed = await technicallyCompleteProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: afterFailure.version, held: HELD, confirmed: true,
    });
    expect(Number((await planComponent()).materials.find((row) => row.materialNumber === 'COMP-DEP')?.demandQuantity)).toBe(demandWithOrder - 50);
    expect(await componentRows()).toEqual([]);
    expect(await receiptRows()).toEqual([]);
    const revoked = await revokeTechnicalCompletion({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: completed.order.version, held: HELD, confirmed: true,
    });
    expect(revoked.order.status).toBe('CREATED');
    expect(revoked.order.scheduledStart).toBe('2026-10-18');
    expect(revoked.order.scheduledFinish).toBe('2026-11-02');
    expect(revoked.order.components.map((row) => row.requirementDate).sort()).toEqual(['2026-12-11', '2026-12-12']);
    expect((await componentRows()).map((row) => row.date).sort()).toEqual(['2026-12-11', '2026-12-12']);
    expect(await receiptRows()).toEqual([expect.objectContaining({ date: '2026-11-02', direction: 'RECEIPT' })]);
    expect(Number((await planComponent()).materials.find((row) => row.materialNumber === 'COMP-DEP')?.demandQuantity)).toBe(demandWithOrder);

    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${tenant.client}, '101', 'Production receipt', 'RECEIPT', 'PRODUCTION_ORDER', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
        values (${tenant.client}, '4900001903', 2026, '2026-10-25', '2026-10-25', 'POSTED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          line_direction, entry_quantity, entry_unit, base_quantity, base_unit, production_order_number, created_by
        ) values (
          ${tenant.client}, '4900001903', 1, '101', 'FG-DEP', ${PLANT},
          'RECEIPT', 1, 'KG', 1, 'KG', ${orderNumber}, ${ACTOR}
        )
      `);
    });
    await expect(changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: revoked.order.version, finishDate: '2026-11-03',
    })).rejects.toThrow(/goods movement/);
    const blocked = (await getProductionOrderDisplay(tenant.client, orderNumber))!;
    expect(blocked.scheduledFinish).toBe('2026-11-02');
    expect(blocked.version).toBe(revoked.order.version);
    expect(blocked.components.map((row) => row.requirementDate).sort()).toEqual(['2026-12-11', '2026-12-12']);
    expect(await dependents(tenant.client, unrelated.order.orderNumber)).toEqual([
      expect.objectContaining({ status: 'OPEN', quantity: '8.000', version: 1 }),
    ]);
  }, 180_000);

  it('does not invent a date on a direct order, and technical completion hides only active dated demand', async () => {
    const direct = await createProductionOrder({
      client: tenant.client, createdBy: ACTOR, requestKey: 'co01-co02-undated',
      materialNumber: 'FG-DEP', plant: PLANT, orderQuantity: 5, orderType: 'PP01',
      scheduledStart: '2026-10-20', scheduledFinish: '2026-10-30',
    });
    const opened = await getProductionOrderDisplay(tenant.client, direct.orderNumber);
    const changed = await changeProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: direct.orderNumber, expectedVersion: opened!.version,
      components: [{ itemNumber: opened!.components[0]!.itemNumber, materialNumber: opened!.components[0]!.materialNumber, requiredQuantity: '9', unit: 'KG' }],
    });
    expect(changed.warnings.join(' ')).toMatch(/no requirement date/);
    expect(changed.order.components.every((row) => row.requirementDate == null)).toBe(true);
    const directList = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(directList.rows.some((row) => row.documentNumber === direct.orderNumber && row.elementType === 'PRODUCTION_COMPONENT')).toBe(false);

    const planned = await createPlannedOrder({
      client: tenant.client, changedBy: ACTOR, requestKey: 'dep-co02-teco',
      materialNumber: 'FG-DEP', plant: PLANT, quantity: '10', finishDate: FINISH,
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
        requirement_date, parent_material, status, version, created_by
      ) values
        (${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0010', 'COMP-DEP', ${PLANT}, 20, 'KG', '2026-12-03', 'FG-DEP', 'OPEN', 1, ${ACTOR}),
        (${tenant.client}, ${planned.order.orderNumber}, 'FG-DEP', '0020', 'COMP-DEP', ${PLANT}, 30, 'KG', '2026-12-04', 'FG-DEP', 'OPEN', 1, ${ACTOR})
    `));
    const converted = await convertPlannedOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber: planned.order.orderNumber, orderType: 'PP01',
    });
    const orderNumber = converted.productionOrderNumber!;
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update material_plant set purchasing_group = '001'
       where client = ${tenant.client} and material_number = 'COMP-DEP' and plant = ${PLANT}
    `));
    const mark = async () => withTenant(tenant.client, (tx) => tx.execute(sql`
      update planning_file set net_change = true
       where client = ${tenant.client} and plant = ${PLANT} and material_number = 'COMP-DEP'
    `));
    const demandOf = async (key: string) => {
      await mark();
      const run = await planMaterials({
        client: tenant.client, requestedBy: ACTOR, requestKey: key, processingKey: 'NETCH',
        plantFrom: PLANT, materialFrom: 'COMP-DEP', materialTo: 'COMP-DEP',
      });
      return Number(run.materials.find((row) => row.materialNumber === 'COMP-DEP')?.demandQuantity);
    };
    const active = await demandOf(nextKey());
    const shown = await getProductionOrderDisplay(tenant.client, orderNumber);
    const completed = await technicallyCompleteProductionOrder({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: shown!.version, held: HELD, confirmed: true,
    });
    const hiddenDemand = await demandOf(nextKey());
    expect(active - hiddenDemand).toBe(50);
    const hiddenList = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(hiddenList.rows.some((row) => row.documentNumber === orderNumber)).toBe(false);
    const hiddenReceipt = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'FG-DEP', plant: PLANT },
    });
    expect(hiddenReceipt.rows.some((row) => row.documentNumber === orderNumber && row.elementType === 'PRODUCTION_ORDER')).toBe(false);
    expect(await dependents(tenant.client, planned.order.orderNumber)).toEqual([
      expect.objectContaining({ status: 'CLOSED' }),
      expect.objectContaining({ status: 'CLOSED' }),
    ]);
    const revoked = await revokeTechnicalCompletion({
      client: tenant.client, changedBy: ACTOR, orderNumber, expectedVersion: completed.order.version, held: HELD, confirmed: true,
    });
    expect(revoked.order.status).toBe('CREATED');
    expect(await demandOf(nextKey())).toBe(active);
    const restored = await stockRequirementsList({
      client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-DEP', plant: PLANT },
    });
    expect(restored.rows.filter((row) => row.documentNumber === orderNumber && row.elementType === 'PRODUCTION_COMPONENT').map((row) => [row.quantity, row.date])).toEqual([
      [20, '2026-12-03'],
      [30, '2026-12-04'],
    ]);
    expect(restored.rows.some((row) => row.elementType === 'PRODUCTION_COMPONENT' && row.direction === 'RECEIPT')).toBe(false);
  }, 180_000);
});
