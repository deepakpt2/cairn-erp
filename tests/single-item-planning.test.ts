import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createRequisition } from '../src/modules/purchasing/requisitions';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { componentRequirementQuantity } from '../src/modules/production/mrp-explosion';
import { planMaterials, planSingleItem } from '../src/modules/production/mrp-run';
import { createProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { stockRequirementsList } from '../src/modules/production/stock-requirements';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'MD02_PLANNER';
const PLANT = '1000';

describe('component quantity', () => {
  it('applies the base quantity, scrap, and a fixed quantity without a float', () => {
    expect(componentRequirementQuantity({
      parentQuantity: 20000n, itemQuantity: 1000n, baseQuantity: 1000n, scrapPercent: '10.00', fixed: false,
    })).toBe(22000n);
    expect(componentRequirementQuantity({
      parentQuantity: 10000n, itemQuantity: 2000n, baseQuantity: 1000n, scrapPercent: null, fixed: true,
    })).toBe(2000n);
    expect(componentRequirementQuantity({
      parentQuantity: 10000n, itemQuantity: -1000n, baseQuantity: 1000n, scrapPercent: null, fixed: false,
    })).toBeNull();
  });
});

describe('MD02 single-item planning', () => {
  let tenant: TestTenant;
  let other: TestTenant;
  let key = 0;
  const nextKey = () => `md02-${++key}`;

  async function extend(materialNumber: string, procurement: 'MAKE' | 'BUY', extra: { safety?: string; production?: number; group?: string | null } = {}) {
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'MD02', view: 'BASIC', description: materialNumber, materialType: 'RAW',
      materialGroup: 'RAW', baseUnit: 'PC', industrySector: 'M', barcode: '',
      grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'MD02', view: 'PURCHASING', plant: PLANT,
      purchasingGroup: extra.group === undefined ? '001' : extra.group ?? '', orderUnit: 'PC',
      overdeliveryTolerance: '0', underdeliveryTolerance: '0', manufacturerPartNumber: '',
    });
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 1,
      reason: 'MD02', view: 'MRP', plant: PLANT,
      mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: procurement, lotSizing: 'EXACT',
      fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: extra.safety ?? '0', reorderPoint: '0',
      plannedDeliveryDays: 0, inHouseProductionDays: extra.production ?? 0,
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
    tenant = await createTenant('md02-single');
    other = await createTenant('md02-single-other');
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, { client: tenant.client, objectCode: 'MRPRUN', subObject: '*', prefix: 'MR', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR });
    });
    await extend('FG-1', 'MAKE', { safety: '10' });
    await extend('SUB-1', 'MAKE');
    await extend('COMP-1', 'BUY');
    await extend('GRAND-1', 'BUY');
    await saveBomUsage({
      client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock',
      materialEntry: '+', quantityEntry: '+',
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-1', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'SUB-1', quantity: '2', unit: 'PC' }],
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'SUB-1', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'COMP-1', quantity: '1', unit: 'PC', scrapPercent: '10' }],
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'COMP-1', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'GRAND-1', quantity: '1', unit: 'PC' }],
    });
    await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingControlKey({ client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal' });
    await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    await createWorkCenter({
      client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC01', category: 'MACH', description: 'Assembly',
    });
    await createRouting({
      client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup: '50000001', groupCounter: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      assignments: [{ materialNumber: 'FG-1' }, { materialNumber: 'SUB-1' }],
      operations: [{ operationNumber: '0010', shortText: 'Cut', workCenter: 'WC01', controlKey: 'PP01' }],
    });
    for (const materialNumber of ['FG-1', 'SUB-1']) {
      await createProductionVersion({
        client: tenant.client, changedBy: ACTOR, materialNumber, plant: PLANT, productionVersion: '0001',
        validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
        bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000001', groupCounter: '01',
      });
    }
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${tenant.client}, 'COMP-1', ${PLANT}, '0001', 'UNRESTRICTED', 2, ${ACTOR}),
               (${tenant.client}, 'COMP-1', ${PLANT}, '0001', 'BLOCKED', 9, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        update planning_file set net_change = true, last_changed_at = now()
         where client = ${tenant.client} and material_number = 'FG-1' and plant = ${PLANT}
      `);
    });
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
    await closeDb();
  });

  it('refuses an MRP area, a typed BOM, delete-and-recreate, and lead-time scheduling', async () => {
    await expect(planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'FG-1', plant: PLANT,
      processingKey: 'NETCH', named: { mrpArea: '0001' },
    })).rejects.toThrow(/MRP area does not stand/);
    await expect(planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'FG-1', plant: PLANT,
      processingKey: 'NETCH', named: { bomAlternative: '01' },
    })).rejects.toThrow(/production version/);
    await expect(planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'FG-1', plant: PLANT,
      processingKey: 'NETCH', planningMode: '3',
    })).rejects.toThrow(/not removed/);
    await expect(planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'FG-1', plant: PLANT,
      processingKey: 'NETCH', schedulingMode: 'LEAD_TIME',
    })).rejects.toThrow(/Lead-time scheduling is not carried/);
  });

  it('explodes two levels, buys the component, and does not explode a purchased BOM', async () => {
    const before = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select (select count(*) from journal_entry where client = ${tenant.client})::int as journals,
               (select count(*) from material_document where client = ${tenant.client})::int as documents
      `) as unknown as Array<{ journals: number; documents: number }>;
      return rows[0];
    });
    const run = await planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'FG-1', plant: PLANT,
      processingKey: 'NETCH',
    });
    expect(run.materials.map((row) => row.materialNumber)).toEqual(expect.arrayContaining(['FG-1', 'SUB-1', 'COMP-1']));
    expect(run.materials.map((row) => row.materialNumber)).not.toContain('GRAND-1');
    const sub = run.dependents.find((row) => row.componentMaterial === 'SUB-1');
    const comp = run.dependents.find((row) => row.componentMaterial === 'COMP-1');
    expect(sub?.quantity).toBe('20.000');
    expect(comp?.quantity).toBe('22.000');
    const requisition = run.proposals.find((row) => row.materialNumber === 'COMP-1');
    expect(requisition?.proposalType).toBe('PURCHASE_REQUISITION');
    expect(requisition?.quantity).toBe('20.000');
    expect(run.proposals.find((row) => row.materialNumber === 'SUB-1')?.proposalType).toBe('PLANNED_ORDER');
    expect(run.diagnostics.some((row) => row.diagnosticCode === 'BUY_NOT_EXPLODED')).toBe(true);
    const list = await stockRequirementsList({ client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-1', plant: PLANT } });
    expect(list.rows.some((row) => row.elementType === 'DEPENDENT_REQUIREMENT' && row.quantity === 22)).toBe(true);
    const after = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select (select count(*) from journal_entry where client = ${tenant.client})::int as journals,
               (select count(*) from material_document where client = ${tenant.client})::int as documents
      `) as unknown as Array<{ journals: number; documents: number }>;
      return rows[0];
    });
    expect(after).toEqual(before);
  });

  it('lets the plant run read a bought component without exploding its bill', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        delete from purchase_requisition_item
         where client = ${tenant.client} and material_number = 'COMP-1'
      `);
      await tx.execute(sql`
        insert into planning_file (client, material_number, plant, net_change, reason, last_changed_by)
        values (${tenant.client}, 'COMP-1', ${PLANT}, true, 'Test', ${ACTOR})
        on conflict (client, material_number, plant) do update set net_change = true, last_changed_at = now()
      `);
    });
    const run = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'COMP-1', materialTo: 'COMP-1',
    });
    expect(run.proposals[0]?.quantity).toBe('20.000');
    expect(run.diagnostics.some((row) => row.diagnosticCode === 'BOM_EXPLODED')).toBe(false);
    expect(run.diagnostics.some((row) => row.diagnosticCode === 'BUY_NOT_EXPLODED')).toBe(true);
  });

  it('does not duplicate a repeated request, and a check writes no operational demand', async () => {
    const key = nextKey();
    const first = await planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: key, materialNumber: 'FG-1', plant: PLANT, processingKey: 'NEUPL', confirmRegenerative: true,
    });
    const again = await planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: key, materialNumber: 'FG-1', plant: PLANT, processingKey: 'NEUPL', confirmRegenerative: true,
    });
    expect(again.runNumber).toBe(first.runNumber);
    const orders = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as count from planned_order
         where client = ${tenant.client} and material_number = 'FG-1'
      `) as unknown as Array<{ count: number }>;
      return rows[0]?.count;
    });
    expect(orders).toBe(1);
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update planning_file set net_change = true, last_changed_at = now()
         where client = ${tenant.client} and material_number = 'SUB-1'
      `);
    });
    const preview = await planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'SUB-1', plant: PLANT,
      processingKey: 'NETCH', simulationOnly: true,
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
    const hidden = await stockRequirementsList({ client: tenant.client, today: '2026-10-24', selection: { material: 'COMP-1', plant: PLANT } });
    expect(hidden.rows.filter((row) => row.elementType === 'DEPENDENT_REQUIREMENT')).toHaveLength(1);
  });

  it('does not overwrite a firmed planned order', async () => {
    const standing = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select order_number, quantity::text as quantity from planned_order
         where client = ${tenant.client} and material_number = 'FG-1'
      `) as unknown as Array<{ order_number: string; quantity: string }>;
      await tx.execute(sql`
        update planned_order set firming_status = 'FIRMED'
         where client = ${tenant.client} and order_number = ${rows[0]!.order_number}
      `);
      await tx.execute(sql`
        update material_plant set safety_stock = 14
         where client = ${tenant.client} and material_number = 'FG-1' and plant = ${PLANT}
      `);
      await tx.execute(sql`
        update planning_file set net_change = true, last_changed_at = now()
         where client = ${tenant.client} and material_number = 'FG-1' and plant = ${PLANT}
      `);
      return rows[0]!;
    });
    const run = await planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'FG-1', plant: PLANT, processingKey: 'NETCH',
    });
    const firmed = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select quantity::text as quantity from planned_order
         where client = ${tenant.client} and order_number = ${standing.order_number}
      `) as unknown as Array<{ quantity: string }>;
      return rows[0]?.quantity;
    });
    expect(firmed).toBe(standing.quantity);
    expect(run.proposals.some((row) => row.documentNumber === standing.order_number && row.action === 'CONFLICT')).toBe(true);
  });

  it('stops a cycle and does not show another tenant the run', async () => {
    await extend('CYC-A', 'MAKE', { safety: '1' });
    await extend('CYC-B', 'MAKE');
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'CYC-A', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'CYC-B', quantity: '1', unit: 'PC' }],
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'CYC-B', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'CYC-A', quantity: '1', unit: 'PC' }],
    });
    await createRouting({
      client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup: '50000002', groupCounter: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      assignments: [{ materialNumber: 'CYC-A' }, { materialNumber: 'CYC-B' }],
      operations: [{ operationNumber: '0010', shortText: 'Cut', workCenter: 'WC01', controlKey: 'PP01' }],
    });
    for (const materialNumber of ['CYC-A', 'CYC-B']) {
      await createProductionVersion({
        client: tenant.client, changedBy: ACTOR, materialNumber, plant: PLANT, productionVersion: '0001',
        validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
        bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000002', groupCounter: '01',
      });
    }
    const run = await planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'CYC-A', plant: PLANT,
      processingKey: 'NEUPL', confirmRegenerative: true,
    });
    expect(run.diagnostics.some((row) => row.diagnosticCode === 'BOM_CYCLE')).toBe(true);
    expect(run.materials.length).toBeLessThan(6);
    expect(await withTenant(other.client, async (tx) => {
      const rows = await tx.execute(sql`select run_number from mrp_run where run_number = ${run.runNumber}`) as unknown as unknown[];
      return rows.length;
    })).toBe(0);
  });

  it('rejects a buy shortage that needs more than one purchase lot', async () => {
    await extend('BUY-LOTS', 'BUY', { safety: '25' });
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update material_plant set maximum_lot_size = 10, minimum_lot_size = 0
         where client = ${tenant.client} and material_number = 'BUY-LOTS' and plant = ${PLANT}
      `);
      await tx.execute(sql`
        update planning_file set net_change = true, last_changed_at = now()
         where client = ${tenant.client} and material_number = 'BUY-LOTS' and plant = ${PLANT}
      `);
    });
    const run = await planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'BUY-LOTS', plant: PLANT,
      processingKey: 'NETCH',
    });
    expect(run.materials).toHaveLength(1);
    expect(run.materials[0]?.status).toBe('FAILED');
    expect(run.materials[0]?.diagnosticCode).toBe('MULTI_LOT_NOT_STORED');
    expect(run.proposals.filter((row) => row.action === 'CREATE')).toHaveLength(0);
    expect(run.proposalsCreated).toBe(0);
    const stored = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select count(*) from purchase_requisition_item
            where client = ${tenant.client} and material_number = 'BUY-LOTS')::int as requisitions,
          (select count(*) from mrp_run_proposal
            where client = ${tenant.client} and run_number = ${run.runNumber} and action = 'CREATE')::int as creates,
          (select net_change from planning_file
            where client = ${tenant.client} and material_number = 'BUY-LOTS' and plant = ${PLANT}) as net_change
      `) as unknown as Array<{ requisitions: number; creates: number; net_change: boolean }>;
      return rows[0];
    });
    expect(stored?.requisitions).toBe(0);
    expect(stored?.creates).toBe(0);
    expect(stored?.net_change).toBe(true);

    const heldDate = new Date().toISOString().slice(0, 10);
    await extend('BUY-HELD', 'BUY', { safety: '25' });
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
    expect(await withTenant(other.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as count from purchase_requisition_item
         where requisition_number = ${created.requisitionNumber}
      `) as unknown as Array<{ count: number }>;
      return rows[0]?.count;
    })).toBe(0);
    const held = await planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'BUY-HELD', plant: PLANT,
      processingKey: 'NETCH',
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
         where client = ${tenant.client} and run_number = ${run.runNumber}
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
    const replayed = await planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: rejectedKey!, materialNumber: 'BUY-LOTS', plant: PLANT,
      processingKey: 'NETCH',
    });
    expect(replayed.runNumber).toBe(run.runNumber);
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

    const planned = await planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'BUY-LOTS', plant: PLANT,
      processingKey: 'NETCH',
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

  it('still stores one requisition when a buy shortage is a single lot', async () => {
    await extend('BUY-ONE', 'BUY', { safety: '5' });
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update planning_file set net_change = true, last_changed_at = now()
         where client = ${tenant.client} and material_number = 'BUY-ONE' and plant = ${PLANT}
      `);
    });
    const run = await planSingleItem({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), materialNumber: 'BUY-ONE', plant: PLANT,
      processingKey: 'NETCH',
    });
    expect(run.materials[0]?.diagnosticCode).not.toBe('MULTI_LOT_NOT_STORED');
    expect(run.proposals.filter((row) => row.action === 'CREATE' && row.proposalType === 'PURCHASE_REQUISITION')).toHaveLength(1);
    expect(run.proposals[0]?.quantity).toBe('5.000');
    const stored = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as requisitions from purchase_requisition_item
         where client = ${tenant.client} and material_number = 'BUY-ONE'
      `) as unknown as Array<{ requisitions: number }>;
      return rows[0]?.requisitions;
    });
    expect(stored).toBe(1);
  });

  it('keeps a typed bill of material out of the plant run', () => {
    const planning = readFileSync('src/modules/production/mrp-run.ts', 'utf8');
    const explosion = readFileSync('src/modules/production/mrp-explosion.ts', 'utf8');
    const order = readFileSync('src/modules/inventory/production-orders.ts', 'utf8');
    expect(planning).toContain('A bill of material is selected through the production version. It is not entered.');
    expect(planning).not.toMatch(/selectProductionVersion/);
    expect(explosion).toContain('selectProductionVersion');
    expect(explosion).not.toContain('posting_period');
    expect(order).not.toMatch(/selectProductionVersion/);
    expect(order).not.toMatch(/planSingleItem/);
  });
});
