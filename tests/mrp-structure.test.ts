import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { planMaterials } from '../src/modules/production/mrp-run';
import { structuralBomLevels, type StructuralBomLevels } from '../src/modules/production/mrp-structure';
import { createProductionVersion, deleteProductionVersion, lockProductionVersion, selectProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'MD01_STRUCTURE';
const PLANT = '1000';

describe('plant structural bill levels', () => {
  let tenant: TestTenant;
  let other: TestTenant;
  let routeGroup = 51000000;
  const nextGroup = () => String(++routeGroup);

  function levelsOf(result: StructuralBomLevels): Record<string, number> {
    return Object.fromEntries(result.levels.map((row) => [row.materialNumber, row.level]));
  }

  async function extend(materialNumber: string, procurement: 'MAKE' | 'BUY', netChange = false) {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${tenant.client}, ${materialNumber}, ${materialNumber}, t.material_type, 'PC', ${ACTOR}
          from (select material_type from material_type where client = ${tenant.client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (
          client, material_number, plant, mrp_type, mrp_controller, procurement_type, lot_sizing,
          fixed_lot_size, safety_stock, reorder_point, planned_delivery_days, in_house_production_days,
          purchasing_group, mrp_status, created_by
        ) values (
          ${tenant.client}, ${materialNumber}, ${PLANT}, 'REQUIREMENTS', '001', ${procurement},
          'EXACT', '0', '0', '0', 0, 0, '001', 'MAINTAINED', ${ACTOR}
        )
        on conflict (client, material_number, plant) do update set
          procurement_type = excluded.procurement_type, mrp_status = 'MAINTAINED'
      `);
      await tx.execute(sql`
        insert into planning_file (client, material_number, plant, net_change, reason, last_changed_by)
        values (${tenant.client}, ${materialNumber}, ${PLANT}, ${netChange}, 'Structure test', ${ACTOR})
        on conflict (client, material_number, plant) do update set net_change = excluded.net_change
      `);
    });
  }

  async function bill(materialNumber: string, items: Array<{ component: string; phantom?: boolean; bulk?: boolean; coproduct?: boolean; special?: string }>, alternative = '01') {
    await createMaterialBom({
      client: tenant.client,
      changedBy: ACTOR,
      materialNumber,
      plant: PLANT,
      usage: 'P',
      alternative,
      baseQuantity: '1',
      baseUnit: 'PC',
      validFrom: '2020-01-01',
      items: items.map((item, index) => ({
        itemNumber: String((index + 1) * 10).padStart(4, '0'),
        itemCategory: 'S',
        componentMaterial: item.component,
        quantity: '1',
        unit: 'PC',
        phantom: item.phantom ? 'X' : ' ',
        bulkMaterial: item.bulk ? 'X' : ' ',
        coproduct: item.coproduct ? 'X' : ' ',
        specialProcurement: item.special,
      })),
    });
  }

  async function route(materials: string[]) {
    const routingGroup = nextGroup();
    await createRouting({
      client: tenant.client,
      changedBy: ACTOR,
      taskListType: 'N',
      plant: PLANT,
      usage: '1',
      routingGroup,
      groupCounter: '01',
      baseQuantity: '1',
      baseUnit: 'PC',
      validFrom: '2020-01-01',
      assignments: materials.map((materialNumber) => ({ materialNumber })),
      operations: [{ operationNumber: '0010', shortText: 'Cut', workCenter: 'WC01', controlKey: 'PP01' }],
    });
    return routingGroup;
  }

  async function version(
    materialNumber: string,
    routingGroup: string,
    alternative = '01',
    productionVersion = '0001',
    bounds?: { validFrom?: string; validTo?: string; lotFrom?: string; lotTo?: string },
  ) {
    const saved = await createProductionVersion({
      client: tenant.client,
      changedBy: ACTOR,
      materialNumber,
      plant: PLANT,
      productionVersion,
      validFrom: bounds?.validFrom ?? '2020-01-01',
      validTo: bounds?.validTo,
      lotFrom: bounds?.lotFrom ?? '0',
      lotTo: bounds?.lotTo ?? '999999',
      lotUnit: 'PC',
      bomUsage: 'P',
      bomAlternative: alternative,
      taskListType: 'N',
      routingGroup,
      groupCounter: '01',
    });
    expect(saved.checkStatus).toBe('1');
    expect(saved.stale).toBe(false);
    return saved;
  }

  async function readLevels(roots: string[]) {
    return withTenant(tenant.client, (tx) => structuralBomLevels(tx, {
      client: tenant.client,
      roots: roots.map((materialNumber) => ({ materialNumber, plant: PLANT })),
    }));
  }

  async function query<T extends Record<string, unknown>>(statement: ReturnType<typeof sql>): Promise<T[]> {
    return withTenant(tenant.client, async (tx) => await tx.execute(statement) as unknown as T[]);
  }

  async function markNetChange(materials: string[]) {
    await query(sql`update planning_file set net_change = false where client = ${tenant.client}`);
    for (const materialNumber of materials) {
      await query(sql`
        update planning_file set net_change = true
         where client = ${tenant.client} and plant = ${PLANT} and material_number = ${materialNumber}
      `);
    }
  }

  async function seedOpenDependent(orderNumber: string, parent: string, component: string) {
    await query(sql`
      insert into planned_order (
        client, order_number, material_number, plant, quantity, unit, start_date, finish_date,
        firming_status, origin, request_key, version, created_by
      ) values (
        ${tenant.client}, ${orderNumber}, ${parent}, ${PLANT}, 4, 'PC', '1999-01-01', '1999-01-01',
        'FIRMED', 'MRP', ${`sentinel-${orderNumber}`}, 2, ${ACTOR}
      )
    `);
    await query(sql`
      insert into mrp_dependent_requirement (
        client, parent_order_number, source_material, item_number, material_number, plant,
        quantity, unit, requirement_date, parent_material, status, version, created_by
      ) values (
        ${tenant.client}, ${orderNumber}, ${parent}, '0010', ${component}, ${PLANT},
        1, 'PC', '1999-01-01', ${parent}, 'OPEN', 4, ${ACTOR}
      )
    `);
  }

  async function dependentState(orderNumber: string) {
    const [row] = await query<{
      dependents: number; closed: number; requisitions: number;
      sentinel_status: string | null; sentinel_version: number | null;
      order_quantity: string | null; order_firming: string | null; order_version: number | null;
    }>(sql`
      select
        (select count(*) from mrp_dependent_requirement where client = ${tenant.client})::int as dependents,
        (select count(*) from mrp_dependent_requirement where client = ${tenant.client} and status = 'CLOSED')::int as closed,
        (select count(*) from purchase_requisition_item where client = ${tenant.client})::int as requisitions,
        (select status from mrp_dependent_requirement where client = ${tenant.client} and parent_order_number = ${orderNumber}) as sentinel_status,
        (select version from mrp_dependent_requirement where client = ${tenant.client} and parent_order_number = ${orderNumber})::int as sentinel_version,
        (select quantity::text from planned_order where client = ${tenant.client} and order_number = ${orderNumber}) as order_quantity,
        (select firming_status from planned_order where client = ${tenant.client} and order_number = ${orderNumber}) as order_firming,
        (select version from planned_order where client = ${tenant.client} and order_number = ${orderNumber})::int as order_version
    `);
    return row;
  }

  beforeAll(async () => {
    tenant = await createTenant('md01-structure');
    other = await createTenant('md01-structure-other');
    await saveBomUsage({
      client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock',
      materialEntry: '+', quantityEntry: '+', allowPhantom: 'X', allowBulk: 'X', allowCoproduct: 'X', allowSpecialProcurement: 'X',
    });
    await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingControlKey({ client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal' });
    await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    await createWorkCenter({
      client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC01', category: 'MACH', description: 'Assembly',
    });
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
    await closeDb();
  });

  it('explodes through the shared function, and the structural calculator writes nothing', () => {
    const planning = readFileSync('src/modules/production/mrp-run.ts', 'utf8');
    const structure = readFileSync('src/modules/production/mrp-structure.ts', 'utf8');
    const store = planning.slice(planning.indexOf('async function storeStructuralLevels'), planning.indexOf('export async function planMaterials'));
    expect(planning).toContain('A bill of material is selected through the production version. It is not entered.');
    expect(planning).toContain('explodePlannedSupply');
    expect(planning).not.toMatch(/selectProductionVersion/);
    expect(store).toContain('set bom_level');
    expect(store).toMatch(/update mrp_run_material\s+set bom_level = \$\{level\.level\}\s+where client = \$\{client\} and run_number = \$\{runNumber\}/);
    expect(store).not.toMatch(/status =|diagnostic_code|proposals_created|insert into/);
    expect(store).not.toContain('mrp_dependent_requirement');
    expect(structure).not.toContain('explodePlannedSupply');
    expect(structure).not.toContain('selectProductionVersion');
    expect(structure).not.toContain('mrp_dependent_requirement');
    expect(structure).not.toMatch(/insert into|update /);
  });

  it('assigns the shared component the deepest included level and does not require it to be selected', async () => {
    for (const [materialNumber, procurement] of [['FG-A', 'MAKE'], ['FG-B', 'MAKE'], ['SUB', 'MAKE'], ['COMP', 'BUY']] as const) {
      await extend(materialNumber, procurement);
    }
    await bill('FG-A', [{ component: 'SUB' }]);
    await bill('FG-B', [{ component: 'SUB' }]);
    await bill('SUB', [{ component: 'COMP' }]);
    const routingGroup = await route(['FG-A', 'FG-B', 'SUB']);
    await version('FG-A', routingGroup);
    await version('FG-B', routingGroup);
    await version('SUB', routingGroup);
    const first = await readLevels(['FG-A', 'FG-B']);
    const second = await readLevels(['FG-A', 'FG-B']);
    expect(levelsOf(first)).toMatchObject({ 'FG-A': 0, 'FG-B': 0, SUB: 1, COMP: 2 });
    expect(second).toEqual(first);
    expect(first.diagnostics).toEqual([]);
  });

  it('includes every eligible version and excludes a deleted, locked, unchecked, or stale version', async () => {
    for (const materialNumber of ['ALT-P', 'KEEP', 'ALSO', 'LOCK-P', 'KEEP-L', 'DROP-L', 'DEL-P', 'KEEP-D', 'DROP-D', 'UNCH-P', 'KEEP-U', 'DROP-U', 'STALE-P', 'KEEP-S', 'DROP-S']) {
      await extend(materialNumber, 'MAKE');
    }
    await bill('ALT-P', [{ component: 'KEEP' }], '01');
    await bill('ALT-P', [{ component: 'ALSO' }], '02');
    const altRoute = await route(['ALT-P']);
    await version('ALT-P', altRoute, '01', '0001');
    await version('ALT-P', altRoute, '02', '0002');
    expect(levelsOf(await readLevels(['ALT-P']))).toMatchObject({ 'ALT-P': 0, KEEP: 1, ALSO: 1 });
    const marked = await withTenant(tenant.client, async (tx) => {
      const updated = await tx.execute(sql`
        update production_version set check_status = '2'
         where client = ${tenant.client} and material_number = 'ALT-P' and plant = ${PLANT}
           and production_version = '0002' and check_status = '1' and deletion_flag = ' ' and lock_indicator <> '1'
        returning production_version
      `) as unknown as Array<{ production_version: string }>;
      expect(updated.map((row) => row.production_version)).toEqual(['0002']);
      const stored = await tx.execute(sql`
        select check_status from production_version
         where client = ${tenant.client} and material_number = 'ALT-P' and plant = ${PLANT} and production_version = '0002'
      `) as unknown as Array<{ check_status: string }>;
      return stored.map((row) => String(row.check_status).trim());
    });
    expect(marked).toEqual(['2']);
    const withWarning = levelsOf(await readLevels(['ALT-P']));
    expect(withWarning['ALT-P']).toBe(0);
    expect(withWarning['KEEP']).toBe(1);
    expect(withWarning['ALSO']).toBe(1);

    await bill('LOCK-P', [{ component: 'KEEP-L' }], '01');
    await bill('LOCK-P', [{ component: 'DROP-L' }], '02');
    const lockRoute = await route(['LOCK-P']);
    await version('LOCK-P', lockRoute, '01', '0001');
    const locked = await version('LOCK-P', lockRoute, '02', '0002');
    await lockProductionVersion(tenant.client, 'LOCK-P', PLANT, '0002', ACTOR, true, locked.version);
    const lockedLevels = levelsOf(await readLevels(['LOCK-P']));
    expect(lockedLevels['KEEP-L']).toBe(1);
    expect(lockedLevels['DROP-L']).toBeUndefined();

    await bill('DEL-P', [{ component: 'KEEP-D' }], '01');
    await bill('DEL-P', [{ component: 'DROP-D' }], '02');
    const deleteRoute = await route(['DEL-P']);
    await version('DEL-P', deleteRoute, '01', '0001');
    const removed = await version('DEL-P', deleteRoute, '02', '0002');
    await deleteProductionVersion(tenant.client, 'DEL-P', PLANT, '0002', ACTOR, removed.version);
    const deletedLevels = levelsOf(await readLevels(['DEL-P']));
    expect(deletedLevels['KEEP-D']).toBe(1);
    expect(deletedLevels['DROP-D']).toBeUndefined();

    await bill('UNCH-P', [{ component: 'KEEP-U' }], '01');
    await bill('UNCH-P', [{ component: 'DROP-U' }], '02');
    const uncheckedRoute = await route(['UNCH-P']);
    await version('UNCH-P', uncheckedRoute, '01', '0001');
    await version('UNCH-P', uncheckedRoute, '02', '0002');
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update production_version set check_status = ' '
       where client = ${tenant.client} and material_number = 'UNCH-P' and plant = ${PLANT} and production_version = '0002'
    `));
    const uncheckedLevels = levelsOf(await readLevels(['UNCH-P']));
    expect(uncheckedLevels['KEEP-U']).toBe(1);
    expect(uncheckedLevels['DROP-U']).toBeUndefined();

    await bill('STALE-P', [{ component: 'KEEP-S' }], '01');
    await bill('STALE-P', [{ component: 'DROP-S' }], '02');
    const staleRoute = await route(['STALE-P']);
    await version('STALE-P', staleRoute, '01', '0001');
    await version('STALE-P', staleRoute, '02', '0002');
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update material_bom set version = version + 1
       where client = ${tenant.client} and material_number = 'STALE-P' and plant = ${PLANT} and usage = 'P' and alternative = '02'
    `));
    const staleLevels = levelsOf(await readLevels(['STALE-P']));
    expect(staleLevels['KEEP-S']).toBe(1);
    expect(staleLevels['DROP-S']).toBeUndefined();
  });

  it('walks a direct phantom one level and does not walk a nested phantom', async () => {
    for (const materialNumber of ['PH-FG', 'PH-PH', 'REAL-PH', 'N-FG', 'N-PH', 'N-NEST', 'HIDDEN']) {
      await extend(materialNumber, 'MAKE');
    }
    await bill('PH-FG', [{ component: 'PH-PH', phantom: true }]);
    await bill('PH-PH', [{ component: 'REAL-PH' }]);
    await bill('N-FG', [{ component: 'N-PH', phantom: true }]);
    await bill('N-PH', [{ component: 'N-NEST', phantom: true }]);
    await bill('N-NEST', [{ component: 'HIDDEN' }]);
    const routingGroup = await route(['PH-FG', 'PH-PH', 'N-FG', 'N-PH', 'N-NEST']);
    for (const materialNumber of ['PH-FG', 'PH-PH', 'N-FG', 'N-PH', 'N-NEST']) await version(materialNumber, routingGroup);
    const direct = await readLevels(['PH-FG']);
    expect(levelsOf(direct)).toEqual({ 'PH-FG': 0, 'REAL-PH': 1 });
    expect(JSON.stringify(direct.diagnostics)).not.toContain('NESTED');
    const nested = await readLevels(['N-FG']);
    expect(levelsOf(nested)).toEqual({ 'N-FG': 0 });
    expect(nested.diagnostics.map((row) => row.code)).not.toContain('NESTED_PHANTOM');
  });

  it('stops a cycle and a depth of 20 without assigning a level through the stopped edge', async () => {
    await extend('CYC-A', 'MAKE');
    await extend('CYC-B', 'MAKE');
    await bill('CYC-A', [{ component: 'CYC-B' }]);
    await bill('CYC-B', [{ component: 'CYC-A' }]);
    const cycleRoute = await route(['CYC-A', 'CYC-B']);
    await version('CYC-A', cycleRoute);
    await version('CYC-B', cycleRoute);
    const cycle = await readLevels(['CYC-A']);
    const cycleAgain = await readLevels(['CYC-A']);
    expect(cycleAgain).toEqual(cycle);
    expect(levelsOf(cycle)).toEqual({ 'CYC-A': 0, 'CYC-B': 1 });
    expect(cycle.diagnostics.map((row) => row.code)).toEqual(['BOM_CYCLE']);
    expect(Math.max(...cycle.levels.map((row) => row.level))).toBe(1);

    const names = Array.from({ length: 22 }, (_, index) => `D${String(index).padStart(2, '0')}`);
    for (const materialNumber of names) await extend(materialNumber, 'MAKE');
    for (let index = 0; index < 21; index += 1) await bill(names[index]!, [{ component: names[index + 1]! }]);
    const depthRoute = await route(names.slice(0, 21));
    for (const materialNumber of names.slice(0, 21)) await version(materialNumber, depthRoute);
    const depth = await readLevels(['D00']);
    const depthAgain = await readLevels(['D00']);
    expect(depthAgain).toEqual(depth);
    expect(levelsOf(depth)['D20']).toBe(20);
    expect(levelsOf(depth)['D21']).toBeUndefined();
    expect(depth.levels.some((row) => row.level > 20)).toBe(false);
    expect(depth.diagnostics.some((row) => row.code === 'DEPTH_LIMIT' && row.materialNumber === 'D20')).toBe(true);
  });

  it('does not walk a bought parent or a bulk, co-product, or special-procurement item', async () => {
    for (const materialNumber of ['BUY-P', 'BUY-C', 'HS-P', 'HS-N', 'HS-B', 'HS-C', 'HS-S']) await extend(materialNumber, 'MAKE');
    await bill('BUY-P', [{ component: 'BUY-C' }]);
    await bill('HS-P', [
      { component: 'HS-N' },
      { component: 'HS-B', bulk: true },
      { component: 'HS-C', coproduct: true },
      { component: 'HS-S', special: 'SP' },
    ]);
    const routingGroup = await route(['BUY-P', 'HS-P']);
    await version('BUY-P', routingGroup);
    await version('HS-P', routingGroup);
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update material_plant set procurement_type = 'BUY'
       where client = ${tenant.client} and material_number = 'BUY-P' and plant = ${PLANT}
    `));
    expect(levelsOf(await readLevels(['BUY-P']))).toEqual({ 'BUY-P': 0 });
    expect(levelsOf(await readLevels(['HS-P']))).toEqual({ 'HS-P': 0, 'HS-N': 1 });
  });

  it('explodes a selected make order, plans the reached component, and still stores structural levels', async () => {
    await extend('A-LOW', 'MAKE', true);
    await extend('FG-Z', 'MAKE', true);
    await extend('MID-Z', 'MAKE', false);
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update material_plant set safety_stock = 1
         where client = ${tenant.client} and plant = ${PLANT} and material_number in ('A-LOW', 'FG-Z')
      `);
      await defineRange(tx, { client: tenant.client, objectCode: 'MRPRUN', subObject: '*', prefix: 'MR', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
    });
    await bill('FG-Z', [{ component: 'MID-Z' }]);
    await bill('MID-Z', [{ component: 'A-LOW' }]);
    const routingGroup = await route(['FG-Z', 'MID-Z']);
    await version('FG-Z', routingGroup);
    await version('MID-Z', routingGroup);
    const beforeDependents = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`select count(*)::int as count from mrp_dependent_requirement where client = ${tenant.client}`) as unknown as Array<{ count: number }>;
      return Number(rows[0]?.count ?? 0);
    });
    const run = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: 'md01-structure-plant', processingKey: 'NETCH', plantFrom: PLANT,
    });
    const byMaterial = Object.fromEntries(run.materials.map((row) => [row.materialNumber, row]));
    expect(run.materials.map((row) => row.materialNumber).sort()).toEqual(['A-LOW', 'FG-Z', 'MID-Z']);
    expect(byMaterial['FG-Z']?.bomLevel).toBe(0);
    expect(byMaterial['MID-Z']?.bomLevel).toBe(1);
    expect(byMaterial['A-LOW']?.bomLevel).toBe(2);
    expect(byMaterial['A-LOW']?.status).toBe('COMPLETED');
    expect(byMaterial['FG-Z']?.status).toBe('COMPLETED');
    expect(byMaterial['MID-Z']?.status).toBe('COMPLETED');
    expect(byMaterial['FG-Z']?.shortageQuantity).toBe('1.000');
    expect(byMaterial['MID-Z']?.shortageQuantity).toBe('1.000');
    expect(byMaterial['A-LOW']?.shortageQuantity).toBe('2.000');
    expect(run.diagnostics.map((row) => row.diagnosticCode)).not.toContain('BOM_CYCLE');
    expect(run.diagnostics.map((row) => row.diagnosticCode)).not.toContain('DEPTH_LIMIT');
    expect(run.dependents.some((row) => row.parentMaterial === 'FG-Z' && row.componentMaterial === 'MID-Z' && row.quantity === '1.000')).toBe(true);
    const orders = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select material_number, order_number from planned_order
       where client = ${tenant.client} and material_number in ('A-LOW', 'FG-Z', 'MID-Z')
       order by material_number
    `) as unknown as Array<{ material_number: string; order_number: string }>);
    expect(orders.map((row) => row.material_number)).toEqual(['A-LOW', 'FG-Z', 'MID-Z']);
    const dependents = await withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select count(*) from mrp_dependent_requirement where client = ${tenant.client})::int as operational,
          (select count(*) from mrp_run_dependent where client = ${tenant.client} and run_number = ${run.runNumber})::int as evidence
      `) as unknown as Array<{ operational: number; evidence: number }>;
      return rows[0];
    });
    expect(Number(dependents?.operational ?? 0)).toBeGreaterThan(beforeDependents);
    expect(Number(dependents?.evidence ?? 0)).toBeGreaterThan(0);
    const repeated = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: 'md01-structure-plant', processingKey: 'NETCH', plantFrom: PLANT,
    });
    expect(repeated.runNumber).toBe(run.runNumber);
    expect(repeated.materials.find((row) => row.materialNumber === 'A-LOW')?.bomLevel).toBe(2);

    const hidden = await withTenant(other.client, (tx) => structuralBomLevels(tx, {
      client: tenant.client,
      roots: [{ materialNumber: 'FG-Z', plant: PLANT }, { materialNumber: 'A-LOW', plant: PLANT }],
    }));
    expect(levelsOf(hidden)).toEqual({ 'A-LOW': 0, 'FG-Z': 0 });
    const crossed = await withTenant(other.client, async (tx) => tx.execute(sql`
      update mrp_run_material set bom_level = 9
       where client = ${tenant.client} and run_number = ${run.runNumber}
      returning material_number
    `) as unknown as unknown[]);
    expect(crossed.length).toBe(0);
    const untouched = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: 'md01-structure-plant', processingKey: 'NETCH', plantFrom: PLANT,
    });
    expect(untouched.materials.find((row) => row.materialNumber === 'A-LOW')?.bomLevel).toBe(2);
  });

  it('includes a version that quantity selection would reject for date or lot size', async () => {
    for (const materialNumber of ['DATE-P', 'DATE-C', 'LOT-P', 'LOT-C']) await extend(materialNumber, 'MAKE');
    await bill('DATE-P', [{ component: 'DATE-C' }]);
    await bill('LOT-P', [{ component: 'LOT-C' }]);
    const routingGroup = await route(['DATE-P', 'LOT-P']);
    const dated = await version('DATE-P', routingGroup, '01', '0001', { validFrom: '2099-01-01', validTo: '2099-12-31' });
    const sized = await version('LOT-P', routingGroup, '01', '0001', { lotFrom: '500', lotTo: '600' });
    expect(dated.checkStatus).toBe('1');
    expect(dated.stale).toBe(false);
    expect(dated.validFrom).toBe('2099-01-01');
    expect(sized.checkStatus).toBe('1');
    expect(sized.stale).toBe(false);
    expect(Number(sized.lotFrom)).toBe(500);
    expect(Number(sized.lotTo)).toBe(600);
    await expect(selectProductionVersion(tenant.client, {
      materialNumber: 'DATE-P', plant: PLANT, keyDate: '2026-10-24', quantity: '1', unit: 'PC',
    })).rejects.toMatchObject({ code: 'NONE_ELIGIBLE' });
    await expect(selectProductionVersion(tenant.client, {
      materialNumber: 'LOT-P', plant: PLANT, keyDate: '2026-10-24', quantity: '1', unit: 'PC',
    })).rejects.toMatchObject({ code: 'NONE_ELIGIBLE' });
    expect(levelsOf(await readLevels(['DATE-P']))).toEqual({ 'DATE-P': 0, 'DATE-C': 1 });
    expect(levelsOf(await readLevels(['LOT-P']))).toEqual({ 'LOT-P': 0, 'LOT-C': 1 });
  });

  it('stops a cycle without overwriting the firmed order or deleting its dependent', async () => {
    await extend('RUN-CYC-A', 'MAKE');
    await extend('RUN-CYC-B', 'MAKE');
    await bill('RUN-CYC-A', [{ component: 'RUN-CYC-B' }]);
    await bill('RUN-CYC-B', [{ component: 'RUN-CYC-A' }]);
    const routingGroup = await route(['RUN-CYC-A', 'RUN-CYC-B']);
    await version('RUN-CYC-A', routingGroup);
    await version('RUN-CYC-B', routingGroup);
    const detected = await readLevels(['RUN-CYC-A']);
    expect(detected.diagnostics.map((row) => row.code)).toEqual(['BOM_CYCLE']);
    expect(levelsOf(detected)).toEqual({ 'RUN-CYC-A': 0, 'RUN-CYC-B': 1 });
    await query(sql`
      update material_plant set safety_stock = 1
       where client = ${tenant.client} and plant = ${PLANT} and material_number in ('RUN-CYC-A', 'RUN-CYC-B')
    `);
    await markNetChange(['RUN-CYC-A', 'RUN-CYC-B']);
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, { client: tenant.client, objectCode: 'MRPRUN', subObject: '*', prefix: 'MR', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
    });
    await seedOpenDependent('PLSENTCYC01', 'RUN-CYC-A', 'RUN-CYC-B');
    await query(sql`
      update planned_order
         set start_date = '2026-01-01', finish_date = '2026-01-01'
       where client = ${tenant.client} and order_number = 'PLSENTCYC01'
    `);
    await query(sql`
      update mrp_dependent_requirement
         set requirement_date = '2026-01-01'
       where client = ${tenant.client} and parent_order_number = 'PLSENTCYC01'
    `);
    const before = await dependentState('PLSENTCYC01');
    const run = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: 'md01-structure-cycle', processingKey: 'NETCH', plantFrom: PLANT,
    });
    const byMaterial = Object.fromEntries(run.materials.map((row) => [row.materialNumber, row]));
    expect(run.materials.map((row) => row.materialNumber).sort()).toEqual(['RUN-CYC-A', 'RUN-CYC-B']);
    expect(byMaterial['RUN-CYC-A']?.bomLevel).toBe(0);
    expect(byMaterial['RUN-CYC-B']?.bomLevel).toBe(1);
    expect(run.diagnostics.map((row) => row.diagnosticCode)).toContain('BOM_CYCLE');
    const storedDiagnostics = await query<{ diagnostic_code: string }>(sql`
      select diagnostic_code from mrp_run_diagnostic
       where client = ${tenant.client} and run_number = ${run.runNumber} and diagnostic_code = 'BOM_CYCLE'
    `);
    expect(storedDiagnostics.length).toBeGreaterThan(0);
    const after = await dependentState('PLSENTCYC01');
    expect(after?.order_quantity).toBe(before?.order_quantity);
    expect(after?.order_firming).toBe('FIRMED');
    expect(after?.order_version).toBe(before?.order_version);
    expect(after?.sentinel_status).toBe('OPEN');
    expect(Number(after?.sentinel_version)).toBeGreaterThan(Number(before?.sentinel_version));
    expect(after?.closed).toBe(0);
    expect(after?.requisitions).toBe(0);
  });

  it('stores a structural level on a cancelled or simulated plant run without changing proposals or operational documents', async () => {
    for (const materialNumber of ['CAN-FG', 'CAN-MID', 'CAN-LOW', 'SIM-FG', 'SIM-MID', 'SIM-LOW']) await extend(materialNumber, 'MAKE');
    await bill('CAN-FG', [{ component: 'CAN-MID' }]);
    await bill('CAN-MID', [{ component: 'CAN-LOW' }]);
    await bill('SIM-FG', [{ component: 'SIM-MID' }]);
    await bill('SIM-MID', [{ component: 'SIM-LOW' }]);
    const routingGroup = await route(['CAN-FG', 'CAN-MID', 'SIM-FG', 'SIM-MID']);
    await version('CAN-FG', routingGroup);
    await version('CAN-MID', routingGroup);
    await version('SIM-FG', routingGroup);
    await version('SIM-MID', routingGroup);
    await query(sql`
      update material_plant set safety_stock = case material_number when 'SIM-FG' then 5 else 1 end
       where client = ${tenant.client} and plant = ${PLANT} and material_number in ('SIM-FG', 'SIM-LOW')
    `);
    await markNetChange(['SIM-FG', 'SIM-LOW']);
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, { client: tenant.client, objectCode: 'MRPRUN', subObject: '*', prefix: 'MR', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
    });
    await seedOpenDependent('PLSENTSIM01', 'SIM-FG', 'CAN-LOW');
    const beforeSimulation = await dependentState('PLSENTSIM01');
    const beforeOrders = await query<{ count: number }>(sql`
      select count(*)::int as count from planned_order
       where client = ${tenant.client} and material_number in ('SIM-FG', 'SIM-MID', 'SIM-LOW')
    `);
    const simulated = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: 'md01-structure-sim', processingKey: 'NETCH', plantFrom: PLANT, simulationOnly: true,
    });
    const simulatedByMaterial = Object.fromEntries(simulated.materials.map((row) => [row.materialNumber, row]));
    expect(simulated.simulationOnly).toBe(true);
    expect(simulated.materials.map((row) => row.materialNumber).sort()).toEqual(['SIM-FG', 'SIM-LOW', 'SIM-MID']);
    expect(simulatedByMaterial['SIM-FG']?.bomLevel).toBe(0);
    expect(simulatedByMaterial['SIM-MID']?.bomLevel).toBe(1);
    expect(simulatedByMaterial['SIM-LOW']?.bomLevel).toBe(2);
    expect(simulatedByMaterial['SIM-LOW']?.status).toBe('COMPLETED');
    expect(simulatedByMaterial['SIM-LOW']?.shortageQuantity).toBe('2.000');
    expect(simulated.proposals.length).toBeGreaterThan(0);
    expect(simulated.proposals.every((row) => row.status === 'PROPOSED' && row.action === 'CREATE' && row.documentNumber == null)).toBe(true);
    const simulatedOrders = await query<{ count: number }>(sql`
      select count(*)::int as count from planned_order
       where client = ${tenant.client} and material_number in ('SIM-FG', 'SIM-MID', 'SIM-LOW')
    `);
    expect(simulatedOrders[0]?.count).toBe(beforeOrders[0]?.count);
    expect(await dependentState('PLSENTSIM01')).toEqual(beforeSimulation);
    const simulatedEvidence = await query<{ evidence: number }>(sql`
      select count(*)::int as evidence from mrp_run_dependent
       where client = ${tenant.client} and run_number = ${simulated.runNumber}
    `);
    expect(Number(simulatedEvidence[0]?.evidence ?? 0)).toBeGreaterThan(0);

    await query(sql`
      insert into mrp_run (
        client, run_number, processing_key, execution_mode, planning_mode, simulation_only,
        plant_from, plant_to, status, request_key, requested_by, materials_selected, entry_point, created_by
      ) values (
        ${tenant.client}, 'MRSTRUCTCAN', 'NETCH', 'FOREGROUND', 'ADAPT_EXISTING', false,
        ${PLANT}, ${PLANT}, 'CANCELLING', 'md01-structure-cancel', ${ACTOR}, 2, 'PLANT', ${ACTOR}
      )
    `);
    await query(sql`
      insert into mrp_run_material (
        client, run_number, material_number, plant, status, bom_level, supply_quantity, demand_quantity,
        shortage_quantity, proposals_created, diagnostic_code, message, created_by
      ) values
        (${tenant.client}, 'MRSTRUCTCAN', 'CAN-FG', ${PLANT}, 'COMPLETED', 7, 0, 3, 3, 1, 'KEPT', 'Kept parent.', ${ACTOR}),
        (${tenant.client}, 'MRSTRUCTCAN', 'CAN-LOW', ${PLANT}, 'COMPLETED', 7, 0, 3, 3, 1, 'KEPT', 'Kept component.', ${ACTOR})
    `);
    await query(sql`
      insert into mrp_run_proposal (
        client, run_number, line_number, material_number, plant, proposal_type, action, document_number,
        quantity, unit, receipt_date, start_date, status, reason, created_by
      ) values (
        ${tenant.client}, 'MRSTRUCTCAN', 1, 'CAN-FG', ${PLANT}, 'PLANNED_ORDER', 'CREATE', 'PLSENTCAN01',
        4, 'PC', '1999-01-01', '1999-01-01', 'APPLIED', 'Standing proposal.', ${ACTOR}
      )
    `);
    await seedOpenDependent('PLSENTCAN01', 'CAN-FG', 'CAN-LOW');
    const beforeCancel = {
      materials: await query(sql`
        select material_number, status, supply_quantity::text as supply_quantity, demand_quantity::text as demand_quantity,
               shortage_quantity::text as shortage_quantity, proposals_created, proposals_changed, proposals_retained,
               diagnostic_code, message, explosion_path, replan_count, changed_by, changed_at, bom_level
          from mrp_run_material
         where client = ${tenant.client} and run_number = 'MRSTRUCTCAN'
         order by material_number
      `),
      proposals: await query(sql`
        select line_number, material_number, proposal_type, action, document_number, item_number,
               quantity::text as quantity, unit, receipt_date::text as receipt_date, start_date::text as start_date,
               status, reason
          from mrp_run_proposal
         where client = ${tenant.client} and run_number = 'MRSTRUCTCAN'
         order by line_number
      `),
      demand: await dependentState('PLSENTCAN01'),
    };
    const cancelled = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: 'md01-structure-cancel', processingKey: 'NETCH', plantFrom: PLANT,
    });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.runNumber).toBe('MRSTRUCTCAN');
    const afterMaterials = await query<{ material_number: string; bom_level: number }>(sql`
      select material_number, status, supply_quantity::text as supply_quantity, demand_quantity::text as demand_quantity,
             shortage_quantity::text as shortage_quantity, proposals_created, proposals_changed, proposals_retained,
             diagnostic_code, message, explosion_path, replan_count, changed_by, changed_at, bom_level
        from mrp_run_material
       where client = ${tenant.client} and run_number = 'MRSTRUCTCAN'
       order by material_number
    `);
    expect(afterMaterials.map((row) => ({ ...row, bom_level: 7 }))).toEqual(beforeCancel.materials);
    expect(Object.fromEntries(afterMaterials.map((row) => [row.material_number, Number(row.bom_level)]))).toEqual({
      'CAN-FG': 0,
      'CAN-LOW': 2,
    });
    expect(await query(sql`
      select line_number, material_number, proposal_type, action, document_number, item_number,
             quantity::text as quantity, unit, receipt_date::text as receipt_date, start_date::text as start_date,
             status, reason
        from mrp_run_proposal
       where client = ${tenant.client} and run_number = 'MRSTRUCTCAN'
       order by line_number
    `)).toEqual(beforeCancel.proposals);
    expect(await dependentState('PLSENTCAN01')).toEqual(beforeCancel.demand);
    expect(cancelled.materials.map((row) => row.materialNumber).sort()).toEqual(['CAN-FG', 'CAN-LOW']);
    expect(cancelled.diagnostics.map((row) => row.diagnosticCode)).not.toContain('BOM_CYCLE');
  });
});
