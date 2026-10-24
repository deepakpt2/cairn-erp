import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { planSingleItem, planSingleLevel, singleLevelRefusal } from '../src/modules/production/mrp-run';
import { createProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'MD03_PLANNER';
const PLANT = '1000';

describe('MD03 single-level planning', () => {
  let tenant: TestTenant;
  let key = 0;
  const nextKey = () => `md03-${++key}`;

  async function extend(materialNumber: string, procurement: 'MAKE' | 'BUY', safety = '0') {
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'MD03', view: 'BASIC', description: materialNumber, materialType: 'RAW',
      materialGroup: 'RAW', baseUnit: 'PC', industrySector: 'M', barcode: '',
      grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'MD03', view: 'PURCHASING', plant: PLANT,
      purchasingGroup: '001', orderUnit: 'PC',
      overdeliveryTolerance: '0', underdeliveryTolerance: '0', manufacturerPartNumber: '',
    });
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 1,
      reason: 'MD03', view: 'MRP', plant: PLANT,
      mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: procurement, lotSizing: 'EXACT',
      fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: safety, reorderPoint: '0',
      plannedDeliveryDays: 0, inHouseProductionDays: 0,
    });
  }

  beforeAll(async () => {
    tenant = await createTenant('md03-level');
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, { client: tenant.client, objectCode: 'MRPRUN', subObject: '*', prefix: 'MR', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR });
    });
    await extend('FG-3', 'MAKE', '8');
    await extend('COMP-3', 'BUY');
    await saveBomUsage({
      client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock',
      materialEntry: '+', quantityEntry: '+',
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-3', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'COMP-3', quantity: '2', unit: 'PC' }],
    });
    await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingControlKey({ client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal' });
    await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    await createWorkCenter({
      client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC03', category: 'MACH', description: 'Assembly',
    });
    await createRouting({
      client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup: '50000003', groupCounter: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      assignments: [{ materialNumber: 'FG-3' }],
      operations: [{ operationNumber: '0010', shortText: 'Cut', workCenter: 'WC03', controlKey: 'PP01' }],
    });
    await createProductionVersion({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-3', plant: PLANT, productionVersion: '0001',
      validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000003', groupCounter: '01',
    });
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update planning_file set net_change = true, last_changed_at = now()
         where client = ${tenant.client} and material_number = 'FG-3' and plant = ${PLANT}
      `);
    });
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await closeDb();
  });

  it('treats planning mode 1 as adapt existing on the single-item entry', async () => {
    const run = await planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'COMP-3', plant: PLANT,
      processingKey: 'NETCH', planningMode: '1',
    });
    expect(run.planningMode).toBe('ADAPT_EXISTING');
    expect(run.proposals).toHaveLength(0);
  });

  it('refuses an MRP area, an MRP list, a schedule line, and delete-and-recreate', () => {
    expect(singleLevelRefusal({ mrpArea: '0001' })).toMatch(/MRP area does not stand/);
    expect(singleLevelRefusal({ mrpList: '1' })).toMatch(/MRP list is not created/);
    expect(singleLevelRefusal({ scheduleLine: '1' })).toMatch(/schedule line is not created/);
    expect(singleLevelRefusal(undefined, '3')).toMatch(/not removed/);
    const planning = readFileSync('src/modules/production/mrp-run.ts', 'utf8');
    expect(planning).toContain("entryPoint === 'SINGLE_LEVEL'");
    expect(planning).toContain('COMPONENT_NOT_PLANNED');
    expect(planning).not.toMatch(/planSingleLevel[\s\S]*enqueueComponent/);
  });

  it('plans the selected material and does not plan the component', async () => {
    const run = await planSingleLevel({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'FG-3', plant: PLANT,
      processingKey: 'NETCH', planningMode: '1',
    });
    expect(run.planningMode).toBe('ADAPT_EXISTING');
    expect(run.materials.map((row) => row.materialNumber)).toEqual(['FG-3']);
    expect(run.proposals.some((row) => row.materialNumber === 'COMP-3')).toBe(false);
    expect(run.dependents).toHaveLength(0);
    expect(run.diagnostics.some((row) => row.diagnosticCode === 'BOM_NOT_EXPLODED')).toBe(true);
    const orders = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as orders,
               (select count(*) from journal_entry where client = ${tenant.client})::int as journals,
               (select count(*) from material_document where client = ${tenant.client})::int as documents
          from planned_order
         where client = ${tenant.client} and material_number = 'FG-3'
      `) as unknown as Array<{ orders: number; journals: number; documents: number }>;
      return rows[0];
    });
    expect(orders?.orders).toBe(1);
    expect(orders?.journals).toBe(0);
    expect(orders?.documents).toBe(0);
  });

  it('re-explodes dependent demand and still does not plan the component', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update planning_file set net_change = true, last_changed_at = now()
         where client = ${tenant.client} and material_number = 'FG-3' and plant = ${PLANT}
      `);
    });
    const run = await planSingleLevel({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'FG-3', plant: PLANT,
      processingKey: 'NEUPL', confirmRegenerative: true, planningMode: '2', productionVersion: '0001',
    });
    expect(run.planningMode).toBe('REEXPLODE');
    expect(run.materials.map((row) => row.materialNumber)).toEqual(['FG-3']);
    expect(run.dependents.some((row) => row.componentMaterial === 'COMP-3')).toBe(true);
    expect(run.diagnostics.some((row) => row.diagnosticCode === 'COMPONENT_NOT_PLANNED')).toBe(true);
    expect(run.proposals.some((row) => row.materialNumber === 'COMP-3')).toBe(false);
    const requisitions = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as count from purchase_requisition_item
         where client = ${tenant.client} and material_number = 'COMP-3'
      `) as unknown as Array<{ count: number }>;
      return rows[0]?.count;
    });
    expect(requisitions).toBe(0);
  });

  it('does not commit a check, and a repeated request does not draw another run', async () => {
    const preview = await planSingleLevel({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'FG-3', plant: PLANT,
      processingKey: 'NEUPL', confirmRegenerative: true, planningMode: '2', simulationOnly: true,
    });
    expect(preview.simulationOnly).toBe(true);
    expect(preview.proposalsCreated).toBe(0);
    const written = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as count from mrp_dependent_requirement
         where client = ${tenant.client} and run_number = ${preview.runNumber}
      `) as unknown as Array<{ count: number }>;
      return rows[0]?.count;
    });
    expect(written).toBe(0);
    const again = await planSingleLevel({
      client: tenant.client, requestedBy: ACTOR, requestKey: preview.requestKey, materialNumber: 'FG-3', plant: PLANT,
      processingKey: 'NEUPL', confirmRegenerative: true, planningMode: '2', simulationOnly: true,
    });
    expect(again.runNumber).toBe(preview.runNumber);
  });
});
