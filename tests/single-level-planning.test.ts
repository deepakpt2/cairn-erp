import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createRequisition } from '../src/modules/purchasing/requisitions';
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

  async function requisitionState(client: string, materialNumber: string) {
    return withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select i.requisition_number, i.item_number,
               i.quantity::text as quantity, i.delivery_date::text as delivery_date,
               i.requisition_date::text as requisition_date, i.plant, i.purchasing_group,
               i.material_number, i.short_text, i.unit, i.marked_for_deletion,
               i.planning_run_number, i.creation_source, i.document_type, i.item_category,
               i.changed_by, i.changed_at::text as changed_at,
               coalesce(rel.status, '') as release_status,
               (select count(*) from change_document d
                 where d.client = i.client and d.object_class = 'purchase_requisition'
                   and d.object_key = i.requisition_number)::int as changes
          from purchase_requisition_item i
          left join document_release rel
            on rel.client = i.client and rel.document_category = 'PURCHASE_REQUISITION'
           and rel.document_number = i.requisition_number
         where i.client = ${client} and i.material_number = ${materialNumber} and i.plant = ${PLANT}
         order by i.requisition_number, i.item_number
      `) as unknown as Array<{
        requisition_number: string; item_number: number; quantity: string; delivery_date: string;
        requisition_date: string; plant: string; purchasing_group: string; material_number: string;
        short_text: string; unit: string; marked_for_deletion: boolean; planning_run_number: string | null;
        creation_source: string; document_type: string; item_category: string; changed_by: string | null;
        changed_at: string | null; release_status: string; changes: number;
      }>;
      return rows;
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

  it('rejects a buy shortage that needs more than one purchase lot and still stores one lot', async () => {
    await extend('BUY-LOTS', 'BUY', '25');
    await extend('BUY-ONE', 'BUY', '4');
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update material_plant set maximum_lot_size = 10, minimum_lot_size = 0
         where client = ${tenant.client} and material_number = 'BUY-LOTS' and plant = ${PLANT}
      `);
      await tx.execute(sql`
        update planning_file set net_change = true, last_changed_at = now()
         where client = ${tenant.client} and material_number in ('BUY-LOTS', 'BUY-ONE') and plant = ${PLANT}
      `);
    });
    const rejected = await planSingleLevel({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'BUY-LOTS', plant: PLANT,
      processingKey: 'NETCH', planningMode: '1',
    });
    expect(rejected.materials).toHaveLength(1);
    expect(rejected.materials[0]?.status).toBe('FAILED');
    expect(rejected.materials[0]?.diagnosticCode).toBe('MULTI_LOT_NOT_STORED');
    expect(rejected.proposals.filter((row) => row.action === 'CREATE')).toHaveLength(0);
    expect(rejected.proposalsCreated).toBe(0);
    const stored = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select count(*) from purchase_requisition_item
            where client = ${tenant.client} and material_number = 'BUY-LOTS')::int as requisitions,
          (select count(*) from mrp_run_proposal
            where client = ${tenant.client} and run_number = ${rejected.runNumber} and action = 'CREATE')::int as creates,
          (select net_change from planning_file
            where client = ${tenant.client} and material_number = 'BUY-LOTS' and plant = ${PLANT}) as net_change
      `) as unknown as Array<{ requisitions: number; creates: number; net_change: boolean }>;
      return rows[0];
    });
    expect(stored?.requisitions).toBe(0);
    expect(stored?.creates).toBe(0);
    expect(stored?.net_change).toBe(true);

    const accepted = await planSingleLevel({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'BUY-ONE', plant: PLANT,
      processingKey: 'NETCH', planningMode: '1',
    });
    expect(accepted.materials[0]?.diagnosticCode).not.toBe('MULTI_LOT_NOT_STORED');
    expect(accepted.proposals.filter((row) => row.action === 'CREATE' && row.proposalType === 'PURCHASE_REQUISITION')).toHaveLength(1);
    expect(accepted.proposals[0]?.quantity).toBe('4.000');
    const one = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as requisitions from purchase_requisition_item
         where client = ${tenant.client} and material_number = 'BUY-ONE'
      `) as unknown as Array<{ requisitions: number }>;
      return rows[0]?.requisitions;
    });
    expect(one).toBe(1);

    const heldDate = new Date().toISOString().slice(0, 10);
    await extend('BUY-HELD', 'BUY', '25');
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update material_plant set maximum_lot_size = 10, minimum_lot_size = 0
         where client = ${tenant.client} and material_number = 'BUY-HELD' and plant = ${PLANT}
      `);
      await tx.execute(sql`
        update planning_file set net_change = true, last_changed_at = now()
         where client = ${tenant.client} and material_number = 'BUY-HELD' and plant = ${PLANT}
      `);
    });
    const created = await createRequisition({
      client: tenant.client, changedBy: ACTOR, planningRunNumber: 'MR-HELD',
      items: [{
        materialNumber: 'BUY-HELD', shortText: 'Standing lot', quantity: 6, unit: 'PC',
        deliveryDate: heldDate, plant: PLANT, purchasingGroup: '001',
      }],
    });
    const beforeHeld = await requisitionState(tenant.client, 'BUY-HELD');
    expect(beforeHeld).toHaveLength(1);
    expect(beforeHeld[0]).toMatchObject({
      requisition_number: created.requisitionNumber,
      item_number: 10,
      quantity: '6.000',
      delivery_date: heldDate,
      plant: PLANT,
      purchasing_group: '001',
      material_number: 'BUY-HELD',
      marked_for_deletion: false,
      planning_run_number: 'MR-HELD',
      unit: 'PC',
    });
    const held = await planSingleLevel({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'BUY-HELD', plant: PLANT,
      processingKey: 'NETCH', planningMode: '1',
    });
    expect(held.materials).toHaveLength(1);
    expect(held.materials[0]?.status).toBe('FAILED');
    expect(held.materials[0]?.diagnosticCode).toBe('MULTI_LOT_NOT_STORED');
    expect(held.proposals.filter((row) => row.action === 'CREATE')).toHaveLength(0);
    expect(held.proposalsCreated).toBe(0);
    const heldStored = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select count(*) from purchase_requisition_item
            where client = ${tenant.client} and material_number = 'BUY-HELD')::int as requisitions,
          (select count(*) from mrp_run_proposal
            where client = ${tenant.client} and run_number = ${held.runNumber} and action = 'CREATE')::int as creates,
          (select net_change from planning_file
            where client = ${tenant.client} and material_number = 'BUY-HELD' and plant = ${PLANT}) as net_change
      `) as unknown as Array<{ requisitions: number; creates: number; net_change: boolean }>;
      return rows[0];
    });
    expect(heldStored?.requisitions).toBe(1);
    expect(heldStored?.creates).toBe(0);
    expect(heldStored?.net_change).toBe(true);
    expect(await requisitionState(tenant.client, 'BUY-HELD')).toEqual(beforeHeld);

    // A finished request key is returned as it stands. Raising the lot does not make that key plan again.
    // The planning file stayed marked, so the next net-change request is a new key.
    const rejectedKey = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select request_key from mrp_run
         where client = ${tenant.client} and run_number = ${rejected.runNumber}
      `) as unknown as Array<{ request_key: string }>;
      return rows[0]?.request_key;
    });
    expect(rejectedKey).toBeTruthy();
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update material_plant set maximum_lot_size = 25
         where client = ${tenant.client} and material_number = 'BUY-LOTS' and plant = ${PLANT}
      `);
    });
    const stillMarked = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select net_change from planning_file
         where client = ${tenant.client} and material_number = 'BUY-LOTS' and plant = ${PLANT}
      `) as unknown as Array<{ net_change: boolean }>;
      return rows[0]?.net_change;
    });
    expect(stillMarked).toBe(true);
    const replayed = await planSingleLevel({
      client: tenant.client, requestedBy: ACTOR, requestKey: rejectedKey!, materialNumber: 'BUY-LOTS', plant: PLANT,
      processingKey: 'NETCH', planningMode: '1',
    });
    expect(replayed.runNumber).toBe(rejected.runNumber);
    expect(replayed.materials[0]?.status).toBe('FAILED');
    expect(replayed.materials[0]?.diagnosticCode).toBe('MULTI_LOT_NOT_STORED');
    expect(replayed.proposalsCreated).toBe(0);
    expect(await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as count from purchase_requisition_item
         where client = ${tenant.client} and material_number = 'BUY-LOTS'
      `) as unknown as Array<{ count: number }>;
      return rows[0]?.count;
    })).toBe(0);

    const planned = await planSingleLevel({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'BUY-LOTS', plant: PLANT,
      processingKey: 'NETCH', planningMode: '1',
    });
    expect(planned.materials[0]?.status).toBe('COMPLETED');
    expect(planned.materials[0]?.diagnosticCode).not.toBe('MULTI_LOT_NOT_STORED');
    expect(planned.status).toBe('COMPLETED');
    expect(planned.proposals).toHaveLength(1);
    expect(planned.proposals[0]?.action).toBe('CREATE');
    expect(planned.proposals[0]?.proposalType).toBe('PURCHASE_REQUISITION');
    expect(planned.proposals[0]?.quantity).toBe('25.000');
    expect(planned.proposalsCreated).toBe(1);
    const plannedStored = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select count(*) from purchase_requisition_item
            where client = ${tenant.client} and material_number = 'BUY-LOTS')::int as requisitions,
          (select quantity::text from purchase_requisition_item
            where client = ${tenant.client} and material_number = 'BUY-LOTS' limit 1) as quantity,
          (select delivery_date::text from purchase_requisition_item
            where client = ${tenant.client} and material_number = 'BUY-LOTS' limit 1) as delivery_date,
          (select net_change from planning_file
            where client = ${tenant.client} and material_number = 'BUY-LOTS' and plant = ${PLANT}) as net_change,
          (select reason from planning_file
            where client = ${tenant.client} and material_number = 'BUY-LOTS' and plant = ${PLANT}) as reason,
          (select last_changed_by from planning_file
            where client = ${tenant.client} and material_number = 'BUY-LOTS' and plant = ${PLANT}) as last_changed_by
      `) as unknown as Array<{
        requisitions: number; quantity: string; delivery_date: string;
        net_change: boolean; reason: string; last_changed_by: string;
      }>;
      return rows[0];
    });
    expect(plannedStored?.requisitions).toBe(1);
    expect(plannedStored?.quantity).toBe('25.000');
    expect(plannedStored?.delivery_date).toBe(planned.proposals[0]?.receiptDate);
    expect(plannedStored?.net_change).toBe(false);
    expect(plannedStored?.reason).toBe('Planned');
    expect(plannedStored?.last_changed_by).toBe(ACTOR);
    expect(await requisitionState(tenant.client, 'BUY-HELD')).toEqual(beforeHeld);
    expect(await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select net_change from planning_file
         where client = ${tenant.client} and material_number = 'BUY-HELD' and plant = ${PLANT}
      `) as unknown as Array<{ net_change: boolean }>;
      return rows[0]?.net_change;
    })).toBe(true);
  }, 60_000);
});
