import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { getMrpRun, planMaterials } from '../src/modules/production/mrp-run';
import { createProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { stockRequirementsList } from '../src/modules/production/stock-requirements';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'MD01_EXPLODE';
const PLANT = '1000';
const TODAY = new Date().toISOString().slice(0, 10);

describe('MD01 plant explosion', () => {
  let tenant: TestTenant;
  let other: TestTenant;
  let key = 0;
  const nextKey = () => `md01-explode-${++key}`;

  async function extend(materialNumber: string, procurement: 'MAKE' | 'BUY', extra: { safety?: string; maximum?: string } = {}) {
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'MD01', view: 'BASIC', description: materialNumber, materialType: 'RAW',
      materialGroup: 'RAW', baseUnit: 'PC', industrySector: 'M', barcode: '',
      grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'MD01', view: 'PURCHASING', plant: PLANT,
      purchasingGroup: '001', orderUnit: 'PC',
      overdeliveryTolerance: '0', underdeliveryTolerance: '0', manufacturerPartNumber: '',
    });
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 1,
      reason: 'MD01', view: 'MRP', plant: PLANT,
      mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: procurement, lotSizing: 'EXACT',
      fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: extra.maximum ?? '0', safetyStock: extra.safety ?? '0', reorderPoint: '0',
      plannedDeliveryDays: 0, inHouseProductionDays: 0,
    });
  }

  async function mark(materials: string[]) {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`update planning_file set net_change = false where client = ${tenant.client}`);
      for (const materialNumber of materials) {
        await tx.execute(sql`
          update planning_file set net_change = true, last_changed_at = now()
           where client = ${tenant.client} and material_number = ${materialNumber} and plant = ${PLANT}
        `);
      }
    });
  }

  async function version(materialNumber: string, routingGroup: string) {
    await createProductionVersion({
      client: tenant.client, changedBy: ACTOR, materialNumber, plant: PLANT, productionVersion: '0001',
      validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup, groupCounter: '01',
    });
  }

  beforeAll(async () => {
    tenant = await createTenant('md01-explode');
    other = await createTenant('md01-explode-other');
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, { client: tenant.client, objectCode: 'MRPRUN', subObject: '*', prefix: 'MR', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR });
    });
    for (const [materialNumber, procurement, safety] of [
      ['FG-1', 'MAKE', '10'],
      ['SUB-1', 'MAKE', '0'],
      ['COMP-1', 'BUY', '0'],
      ['GRAND-1', 'BUY', '0'],
      ['PH-FG', 'MAKE', '1'],
      ['PHAN', 'MAKE', '0'],
      ['PH-BUY', 'BUY', '0'],
      ['NOVER', 'MAKE', '4'],
      ['FIRM-FG', 'MAKE', '10'],
      ['FIRM-BUY', 'BUY', '0'],
      ['LOT-FG', 'MAKE', '25'],
      ['LOT-BUY', 'BUY', '0'],
    ] as const) {
      await extend(materialNumber, procurement, { safety, maximum: materialNumber === 'LOT-BUY' ? '10' : '0' });
    }
    await saveBomUsage({
      client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock',
      materialEntry: '+', quantityEntry: '+', allowPhantom: 'X',
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-1', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'SUB-1', quantity: '2', unit: 'PC' }],
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'SUB-1', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'COMP-1', quantity: '1', unit: 'PC' }],
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'COMP-1', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'GRAND-1', quantity: '1', unit: 'PC' }],
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'PH-FG', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'PHAN', quantity: '1', unit: 'PC', phantom: 'X' }],
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'PHAN', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'PH-BUY', quantity: '3', unit: 'PC' }],
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'FIRM-FG', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'FIRM-BUY', quantity: '1', unit: 'PC' }],
    });
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'LOT-FG', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'LOT-BUY', quantity: '1', unit: 'PC' }],
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
      routingGroup: '53000001', groupCounter: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      assignments: [
        { materialNumber: 'FG-1' }, { materialNumber: 'SUB-1' }, { materialNumber: 'PH-FG' },
        { materialNumber: 'PHAN' }, { materialNumber: 'FIRM-FG' }, { materialNumber: 'LOT-FG' },
      ],
      operations: [{ operationNumber: '0010', shortText: 'Cut', workCenter: 'WC01', controlKey: 'PP01' }],
    });
    for (const materialNumber of ['FG-1', 'SUB-1', 'PH-FG', 'PHAN', 'FIRM-FG', 'LOT-FG']) {
      await version(materialNumber, '53000001');
    }
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
    await closeDb();
  });

  it('explodes a make proposal, scales the component, and does not make a production order for a purchase', async () => {
    await mark(['FG-1']);
    const before = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select (select count(*) from journal_entry where client = ${tenant.client})::int as journals,
               (select count(*) from material_document where client = ${tenant.client})::int as documents,
               (select count(*) from production_order where client = ${tenant.client})::int as orders,
               (select count(*) from reservation_header where client = ${tenant.client})::int as reservations
      `) as unknown as Array<{ journals: number; documents: number; orders: number; reservations: number }>;
      return rows[0];
    });
    const key = nextKey();
    const run = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: key, processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'FG-1', materialTo: 'FG-1',
    });
    const sub = run.dependents.find((row) => row.componentMaterial === 'SUB-1');
    const comp = run.dependents.find((row) => row.componentMaterial === 'COMP-1');
    expect(sub).toMatchObject({ parentMaterial: 'FG-1', plant: PLANT, quantity: '20.000', unit: 'PC', productionVersion: '0001' });
    expect(comp).toMatchObject({ parentMaterial: 'SUB-1', plant: PLANT, quantity: '20.000', unit: 'PC' });
    expect(sub?.requirementDate).toBe(TODAY);
    expect(run.proposals.find((row) => row.materialNumber === 'COMP-1')?.proposalType).toBe('PURCHASE_REQUISITION');
    expect(run.proposals.find((row) => row.materialNumber === 'SUB-1')?.proposalType).toBe('PLANNED_ORDER');
    expect(run.materials.map((row) => row.materialNumber)).not.toContain('GRAND-1');
    expect(run.diagnostics.some((row) => row.diagnosticCode === 'BUY_NOT_EXPLODED' && row.materialNumber === 'COMP-1')).toBe(true);
    expect(run.status).toBe('COMPLETED');
    const list = await stockRequirementsList({ client: tenant.client, today: TODAY, selection: { material: 'COMP-1', plant: PLANT } });
    expect(list.rows.some((row) => row.elementType === 'DEPENDENT_REQUIREMENT' && row.quantity === 20)).toBe(true);
    const again = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: key, processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'FG-1', materialTo: 'FG-1',
    });
    expect(again.runNumber).toBe(run.runNumber);
    const stored = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as count from mrp_dependent_requirement
         where client = ${tenant.client} and parent_material = 'FG-1' and material_number = 'SUB-1' and status = 'OPEN'
      `) as unknown as Array<{ count: number }>;
      return rows[0]?.count;
    });
    expect(stored).toBe(1);
    expect(await getMrpRun(other.client, run.runNumber)).toBeNull();
    const crossed = await withTenant(other.client, async (tx) => tx.execute(sql`
      update mrp_dependent_requirement set quantity = 99
       where client = ${tenant.client} and material_number = 'SUB-1'
      returning material_number
    `) as unknown as unknown[]);
    expect(crossed.length).toBe(0);
    const after = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select (select count(*) from journal_entry where client = ${tenant.client})::int as journals,
               (select count(*) from material_document where client = ${tenant.client})::int as documents,
               (select count(*) from production_order where client = ${tenant.client})::int as orders,
               (select count(*) from reservation_header where client = ${tenant.client})::int as reservations
      `) as unknown as Array<{ journals: number; documents: number; orders: number; reservations: number }>;
      return rows[0];
    });
    expect(after).toEqual(before);
  });

  it('adapts the dependent quantity on a later run and does not insert a second row', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update material_plant set safety_stock = 15
         where client = ${tenant.client} and material_number = 'FG-1' and plant = ${PLANT}
      `);
    });
    await mark(['FG-1']);
    const before = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as count from mrp_dependent_requirement
         where client = ${tenant.client} and material_number = 'SUB-1' and status = 'OPEN'
      `) as unknown as Array<{ count: number }>;
      return rows[0]?.count;
    });
    const run = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'FG-1', materialTo: 'FG-1',
    });
    expect(run.dependents.find((row) => row.componentMaterial === 'SUB-1')?.quantity).toBe('30.000');
    const after = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as open_count,
               (select count(*) from mrp_dependent_requirement
                 where client = ${tenant.client} and parent_material = 'FG-1' and material_number = 'SUB-1')::int as parent_rows
          from mrp_dependent_requirement
         where client = ${tenant.client} and material_number = 'SUB-1' and status = 'OPEN'
      `) as unknown as Array<{ open_count: number; parent_rows: number }>;
      return rows[0];
    });
    expect(after?.open_count).toBe(before);
    expect(after?.parent_rows).toBe(1);
  });

  it('writes no operational demand when the plant run is only a check', async () => {
    await mark(['PH-FG']);
    const before = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select (select count(*) from planned_order where client = ${tenant.client} and material_number = 'PH-FG')::int as orders,
               (select count(*) from mrp_dependent_requirement where client = ${tenant.client} and parent_material = 'PH-FG')::int as demand,
               (select count(*) from purchase_requisition_item where client = ${tenant.client} and material_number = 'PH-BUY')::int as requisitions
      `) as unknown as Array<{ orders: number; demand: number; requisitions: number }>;
      return rows[0];
    });
    const run = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'PH-FG', materialTo: 'PH-FG', simulationOnly: true,
    });
    expect(run.simulationOnly).toBe(true);
    expect(run.dependents.some((row) => row.componentMaterial === 'PH-BUY')).toBe(true);
    expect(run.proposals.every((row) => row.status === 'PROPOSED' && row.documentNumber == null)).toBe(true);
    const after = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select (select count(*) from planned_order where client = ${tenant.client} and material_number = 'PH-FG')::int as orders,
               (select count(*) from mrp_dependent_requirement where client = ${tenant.client} and parent_material = 'PH-FG')::int as demand,
               (select count(*) from purchase_requisition_item where client = ${tenant.client} and material_number = 'PH-BUY')::int as requisitions,
               (select count(*) from mrp_run_dependent where client = ${tenant.client} and run_number = ${run.runNumber})::int as evidence
      `) as unknown as Array<{ orders: number; demand: number; requisitions: number; evidence: number }>;
      return rows[0];
    });
    expect(after?.orders).toBe(before?.orders);
    expect(after?.demand).toBe(before?.demand);
    expect(after?.requisitions).toBe(before?.requisitions);
    expect(Number(after?.evidence ?? 0)).toBeGreaterThan(0);
  });

  it('follows the shared phantom rule and does not propose the phantom', async () => {
    await mark(['PH-FG']);
    const run = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'PH-FG', materialTo: 'PH-FG',
    });
    expect(run.diagnostics.some((row) => row.diagnosticCode === 'PHANTOM')).toBe(true);
    expect(run.proposals.find((row) => row.materialNumber === 'PHAN')).toBeUndefined();
    expect(run.dependents.find((row) => row.componentMaterial === 'PH-BUY')).toMatchObject({ quantity: '3.000', unit: 'PC', plant: PLANT });
    expect(run.proposals.find((row) => row.materialNumber === 'PH-BUY')?.proposalType).toBe('PURCHASE_REQUISITION');
  });

  it('names a make material whose production version cannot be selected', async () => {
    await mark(['NOVER']);
    const run = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'NOVER', materialTo: 'NOVER',
    });
    const diagnostic = run.diagnostics.find((row) => row.materialNumber === 'NOVER' && row.diagnosticCode === 'NONE_ELIGIBLE');
    expect(diagnostic?.severity).toBe('WARNING');
    expect(run.status).not.toBe('COMPLETED');
    expect(run.dependents.filter((row) => row.parentMaterial === 'NOVER')).toHaveLength(0);
    expect(run.proposals.some((row) => row.materialNumber === 'NOVER' && row.proposalType === 'PLANNED_ORDER')).toBe(true);
  });

  it('does not overwrite a firmed planned order while refreshing its component demand', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into planned_order (
          client, order_number, material_number, plant, quantity, unit, start_date, finish_date,
          firming_status, origin, request_key, version, created_by
        ) values (
          ${tenant.client}, 'PLFIRM0001', 'FIRM-FG', ${PLANT}, 99, 'PC', ${TODAY}, ${TODAY},
          'FIRMED', 'MRP', 'firm-sentinel', 2, ${ACTOR}
        )
      `);
    });
    await mark(['FIRM-FG']);
    const run = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'FIRM-FG', materialTo: 'FIRM-FG',
    });
    expect(run.proposals.find((row) => row.documentNumber === 'PLFIRM0001' && row.action !== 'RETAIN' && row.action !== 'CONFLICT')).toBeUndefined();
    const standing = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select quantity::text as quantity, firming_status, version
          from planned_order
         where client = ${tenant.client} and order_number = 'PLFIRM0001'
      `) as unknown as Array<{ quantity: string; firming_status: string; version: number }>;
      return rows[0];
    });
    expect(standing).toMatchObject({ quantity: '99.000', firming_status: 'FIRMED', version: 2 });
    expect(run.dependents.find((row) => row.parentOrderNumber === 'PLFIRM0001' && row.componentMaterial === 'FIRM-BUY')?.quantity).toBe('99.000');
  });

  it('does not store a requisition when an exploded buy shortage needs more than one lot', async () => {
    await mark(['LOT-FG']);
    const run = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'LOT-FG', materialTo: 'LOT-FG',
    });
    expect(run.materials.find((row) => row.materialNumber === 'LOT-BUY')?.status).toBe('FAILED');
    expect(run.materials.find((row) => row.materialNumber === 'LOT-BUY')?.diagnosticCode).toBe('MULTI_LOT_NOT_STORED');
    expect(run.status).not.toBe('COMPLETED');
    expect(run.dependents.some((row) => row.componentMaterial === 'LOT-BUY' && row.quantity === '25.000')).toBe(true);
    const stored = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as count from purchase_requisition_item
         where client = ${tenant.client} and material_number = 'LOT-BUY'
      `) as unknown as Array<{ count: number }>;
      return rows[0]?.count;
    });
    expect(stored).toBe(0);
  });

  it('names the component the foreground limit did not plan, and does not call that run complete', async () => {
    await withTenant(tenant.client, async (tx) => {
      const type = await tx.execute(sql`
        select material_type from material_type where client = ${tenant.client} order by material_type limit 1
      `) as unknown as Array<{ material_type: string }>;
      const materialType = type[0]?.material_type;
      for (let index = 1; index <= 39; index += 1) {
        const number = `ZL${String(index).padStart(2, '0')}`;
        await tx.execute(sql`
          insert into material (client, material_number, description, material_type, base_unit, created_by)
          values (${tenant.client}, ${number}, ${number}, ${materialType}, 'PC', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_plant (
            client, material_number, plant, mrp_type, mrp_controller, procurement_type, lot_sizing,
            purchasing_group, mrp_status, created_by
          ) values (
            ${tenant.client}, ${number}, ${PLANT}, 'NONE', '001', 'BUY', 'EXACT', '001', 'MAINTAINED', ${ACTOR}
          )
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into planning_file (client, material_number, plant, net_change, reason, last_changed_by)
          values (${tenant.client}, ${number}, ${PLANT}, true, 'Limit', ${ACTOR})
          on conflict (client, material_number, plant) do update set net_change = true, last_changed_at = now()
        `);
      }
    });
    await extend('ZPARENT', 'MAKE', { safety: '1' });
    await extend('ZCOMP', 'BUY');
    await createMaterialBom({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'ZPARENT', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'ZCOMP', quantity: '1', unit: 'PC' }],
    });
    await createRouting({
      client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup: '53000002', groupCounter: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      assignments: [{ materialNumber: 'ZPARENT' }],
      operations: [{ operationNumber: '0010', shortText: 'Cut', workCenter: 'WC01', controlKey: 'PP01' }],
    });
    await version('ZPARENT', '53000002');
    await mark(['ZPARENT', ...Array.from({ length: 39 }, (_, index) => `ZL${String(index + 1).padStart(2, '0')}`)]);
    const run = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'ZL01', materialTo: 'ZPARENT',
    });
    const limited = run.diagnostics.find((row) => row.diagnosticCode === 'FOREGROUND_LIMIT');
    expect(limited?.materialNumber).toBe('ZCOMP');
    expect(limited?.message).toContain('was not added');
    expect(run.materials.map((row) => row.materialNumber)).not.toContain('ZCOMP');
    expect(run.status).not.toBe('COMPLETED');
  });

  it('does not start a second run while one is already planning the plant', async () => {
    expect(readFileSync('src/modules/production/mrp-run.ts', 'utf8')).toContain('for update');
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into mrp_run (
          client, run_number, processing_key, execution_mode, planning_mode, simulation_only,
          plant_from, plant_to, status, request_key, requested_by, materials_selected, entry_point, created_by
        ) values (
          ${tenant.client}, 'MRBLOCK01', 'NETCH', 'FOREGROUND', 'ADAPT_EXISTING', false,
          ${PLANT}, ${PLANT}, 'RUNNING', 'md01-block', ${ACTOR}, 1, 'PLANT', ${ACTOR}
        )
      `);
    });
    await expect(planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'FG-1', materialTo: 'FG-1',
    })).rejects.toThrow(/already planning this plant/);
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`delete from mrp_run where client = ${tenant.client} and run_number = 'MRBLOCK01'`);
    });
  });
});
