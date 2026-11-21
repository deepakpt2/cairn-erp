/**
 * BOM explosion (CS11/CS12) and where-used (CS15) — read-only, and in agreement with MRP.
 *
 * What is worth proving: the levels and the quantities, asserted through MRP's own
 * `componentRequirementQuantity`; the rules MRP applies to what is exploded (MAKE only, BUY and other
 * procurement types stop with a note, phantoms passed through with their components one level below,
 * cycles and the depth limit stop with a diagnostic); validity and deletion filtering; the BOM chosen
 * through the production version or named directly; base-unit conversion and its failure; the
 * upward walk with BOM quantities only; and the authority, Plant scope included.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { toScaled } from '../src/platform/posting/decimal';
import { createMaterialBomForProvisioning as createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { componentRequirementQuantity, SCALE } from '../src/modules/production/mrp-explosion';
import { createProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { createWorkCenterForProvisioning as createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { BomExplosionError, explodeBom, whereUsedBom, type ExplodeBomInput } from '../src/modules/production/bom-explosion';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';

const ACTOR = 'CS12-TEST';
const PLANT = '1000';
const KEY = '2026-03-15';
let tenant: TestTenant;
let client = '';
let reader: FinanceActor;
const auth = () => ({ authorization: reader.authorization });

async function expectRefusal(promise: Promise<unknown>, fragment: string | RegExp): Promise<BomExplosionError> {
  try {
    await promise;
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(BomExplosionError);
    expect((error as Error).message).toMatch(fragment);
    return error as BomExplosionError;
  }
  throw new Error(`Expected a BomExplosionError matching ${fragment}, nothing was thrown.`);
}

async function material(materialNumber: string, procurement: 'MAKE' | 'BUY' | 'BOTH', baseUnit = 'PC') {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, ${materialNumber}, ${`Material ${materialNumber}`}, t.material_type, ${baseUnit}, ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing`);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, mrp_type, mrp_controller, procurement_type, lot_sizing,
        fixed_lot_size, safety_stock, reorder_point, planned_delivery_days, in_house_production_days, purchasing_group, mrp_status, created_by)
      values (${client}, ${materialNumber}, ${PLANT}, 'REQUIREMENTS', '001', ${procurement}, 'EXACT', '0', '0', '0', 0, 0, '001', 'MAINTAINED', ${ACTOR})
      on conflict (client, material_number, plant) do update set procurement_type = excluded.procurement_type`);
  });
}

type Item = { component?: string; quantity?: string; unit?: string; scrap?: string; fixed?: boolean; phantom?: boolean; text?: string; validTo?: string; category?: string };
async function bill(materialNumber: string, items: Item[], baseQuantity = '1', alternative = '01') {
  await createMaterialBom({
    client, changedBy: ACTOR, materialNumber, plant: PLANT, usage: 'P', alternative, baseQuantity, baseUnit: 'PC', validFrom: '2020-01-01',
    items: items.map((item, index) => ({
      itemNumber: String((index + 1) * 10).padStart(4, '0'),
      itemCategory: item.category ?? (item.text ? 'T' : 'S'),
      componentMaterial: item.text ? null : item.component,
      quantity: item.text ? null : (item.quantity ?? '1'),
      unit: item.text ? null : (item.unit ?? 'PC'),
      scrapPercent: item.scrap ?? null,
      fixedQuantity: item.fixed ? 'X' : ' ',
      phantom: item.phantom ? 'X' : ' ',
      itemText: item.text ?? null,
      validTo: item.validTo ?? null,
    })),
  });
}

let routingGroup = 61000000;
async function versionsFor(materials: string[]) {
  const group = String(++routingGroup);
  await createRouting({
    client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1', routingGroup: group, groupCounter: '01',
    baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
    assignments: materials.map((materialNumber) => ({ materialNumber })),
    operations: [{ operationNumber: '0010', shortText: 'Make', workCenter: 'WC01', controlKey: 'PP01' }],
  });
  for (const materialNumber of materials) {
    await createProductionVersion({
      client, changedBy: ACTOR, materialNumber, plant: PLANT, productionVersion: '0001', validFrom: '2020-01-01',
      lotFrom: '0', lotTo: '999999', lotUnit: 'PC', bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: group, groupCounter: '01',
    });
  }
}

const explode = (over: Partial<ExplodeBomInput> = {}) =>
  explodeBom({ client, materialNumber: 'FG', plant: PLANT, keyDate: KEY, depth: 'MULTI', ...over }, auth());
const q = (v: string) => toScaled(v, SCALE);
const mrp = (parent: string, item: string, base: string, scrap: string | null = null, fixed = false) =>
  componentRequirementQuantity({ parentQuantity: q(parent), itemQuantity: q(item), baseQuantity: q(base), scrapPercent: scrap, fixed });
const shown = (v: bigint | null) => (v === null ? null : (Number(v) / 1000).toFixed(3));

beforeAll(async () => {
  tenant = await createTenant('cs12-explosion');
  client = tenant.client;
  await saveBomUsage({ client, changedBy: ACTOR, usage: 'P', description: 'Production', productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.' });
  await saveBomItemCategory({ client, changedBy: ACTOR, category: 'S', description: 'Stock', materialEntry: '+', quantityEntry: '+', allowPhantom: 'X', allowBulk: 'X', allowCoproduct: 'X', allowFixedQuantity: 'X' });
  await saveBomItemCategory({ client, changedBy: ACTOR, category: 'T', description: 'Text', materialEntry: '-', quantityEntry: '-' });
  await saveRoutingTaskListType({ client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
  await saveRoutingUsage({ client, changedBy: ACTOR, usage: '1', description: 'Production' });
  await saveRoutingControlKey({ client, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal' });
  await saveWorkCenterCategory({ client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
  await createWorkCenter({ client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC01', category: 'MACH', description: 'Assembly' });

  for (const m of ['FG', 'SUB', 'PH', 'CYA', 'CYB']) await material(m, 'MAKE');
  for (const m of ['RAW1', 'RAW2', 'RAW3', 'RAW5']) await material(m, 'BUY');
  await material('RAW4', 'BUY', 'KG');
  await material('MIXED', 'BOTH');
  await withTenant(client, (tx) => tx.execute(sql`
    insert into material_uom_conversion (client, material_number, alternative_unit, base_unit, numerator, denominator, created_by)
    values (${client}, 'RAW4', 'G', 'KG', 1, 1000, ${ACTOR})`));

  await bill('FG', [
    { component: 'SUB', quantity: '2' },                       // 0010 MAKE → exploded
    { component: 'RAW1', quantity: '5', scrap: '10' },          // 0020 scrap
    { component: 'RAW2', quantity: '3', fixed: true },          // 0030 fixed
    { component: 'PH', quantity: '1', phantom: true },          // 0040 phantom
    { text: 'Assemble with care' },                             // 0050 text item
    { component: 'RAW3', quantity: '1', validTo: '2020-06-30' }, // 0060 expired
    { component: 'MIXED', quantity: '1' },                      // 0070 BOTH: not exploded
    { component: 'RAW4', quantity: '500', unit: 'G' },          // 0080 converted to KG
    { component: 'RAW5', quantity: '2' },                       // 0090 unit set to BOX below: no conversion
    { component: 'RAW1', quantity: '7' },                       // 0100 deleted below
  ], '10');
  await withTenant(client, (tx) => tx.execute(sql`update material_bom_item set deletion_flag = 'X' where client = ${client} and material_number = 'FG' and item_number = '0100'`));
  // A unit whose conversion is gone since the BOM was maintained (BOM maintenance itself refuses it).
  await withTenant(client, (tx) => tx.execute(sql`update material_bom_item set unit = 'BOX' where client = ${client} and material_number = 'FG' and item_number = '0090'`));
  await bill('FG', [{ component: 'RAW2', quantity: '9' }], '1', '02');   // an alternative no version selects
  await bill('SUB', [{ component: 'RAW2', quantity: '4' }], '1');
  await bill('PH', [{ component: 'RAW1', quantity: '2' }], '1');
  await bill('MIXED', [{ component: 'RAW1', quantity: '1' }], '1');
  await bill('CYA', [{ component: 'CYB' }]);
  await bill('CYB', [{ component: 'CYA' }]);
  // A chain deeper than the depth limit: DP00 → DP01 → … → DP22.
  const chain = Array.from({ length: 23 }, (_, i) => `DP${String(i).padStart(2, '0')}`);
  for (const m of chain) await material(m, 'MAKE');
  for (let i = 0; i < chain.length - 1; i++) await bill(chain[i]!, [{ component: chain[i + 1]! }]);
  await versionsFor(['FG', 'SUB', 'PH', 'MIXED', 'CYA', 'CYB', ...chain.slice(0, -1)]);

  reader = await createFinanceActor(client, { capabilities: ['PROD.BOM.DISPLAY'] });
}, 300_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

describe('the explosion (CS11 / CS12)', () => {
  it('1, 10, 11, 14. single level lists exactly the valid, undeleted items, a text item with its text and no material', async () => {
    const view = await explode({ depth: 'SINGLE' });
    expect(view.rows.map((r) => r.itemNumber)).toEqual(['0010', '0020', '0030', '0040', '0050', '0070', '0080', '0090']);
    expect(view.rows.every((r) => r.level === 1)).toBe(true);
    const text = view.rows.find((r) => r.itemNumber === '0050')!;
    expect(text).toMatchObject({ materialNumber: null, itemText: 'Assemble with care' });
    expect(view.bom).toMatchObject({ usage: 'P', alternative: '01', productionVersion: '0001', baseQuantity: '10.000' });
  });

  it('2, 3. multi-level recurses with the right level, and every quantity agrees with MRP’s formula', async () => {
    const view = await explode();
    expect(view.quantityWasDefaulted).toBe(true);
    expect(view.quantity).toBe('10.000');
    const at = (path: string) => view.rows.find((r) => r.path === path)!;
    expect(at('FG/SUB')).toMatchObject({ level: 1, requiredQuantity: shown(mrp('10', '2', '10')) });
    expect(at('FG/SUB/RAW2')).toMatchObject({ level: 2, requiredQuantity: shown(mrp(shown(mrp('10', '2', '10'))!, '4', '1')) });
    expect(view.maxLevel).toBe(2);
  });

  it('4, 5. a requested quantity scales every row and applies scrap; a fixed quantity does not scale', async () => {
    const view = await explode({ quantity: '40' });
    const at = (path: string) => view.rows.find((r) => r.path === path)!;
    expect(at('FG/RAW1').requiredQuantity).toBe(shown(mrp('40', '5', '10', '10')));
    expect(at('FG/RAW1').requiredQuantity).toBe('22.000');
    expect(at('FG/RAW2').requiredQuantity).toBe(shown(mrp('40', '3', '10', null, true)));
    expect(at('FG/RAW2').requiredQuantity).toBe('3.000');
    expect(at('FG/SUB/RAW2').requiredQuantity).toBe('32.000');
  });

  it('6, 22. a phantom is passed through, its components one level below it', async () => {
    const view = await explode();
    const phantom = view.rows.find((r) => r.path === 'FG/PH')!;
    expect(phantom).toMatchObject({ level: 1, isPhantom: true });
    expect(phantom.diagnostics.map((d) => d.code)).toContain('PHANTOM');
    expect(phantom.diagnostics.find((d) => d.code === 'PHANTOM')!.message).toMatch(/passed through — not planned as an assembly; its components are planned against the parent/);
    expect(view.rows.find((r) => r.path === 'FG/PH/RAW1')).toMatchObject({ level: 2, requiredQuantity: '2.000' });
  });

  it('7. a bought material ends its branch with an informational note; BOTH says it is not MAKE', async () => {
    const view = await explode();
    expect(view.rows.find((r) => r.path === 'FG/RAW1')!.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'INFO', code: 'BUY_NOT_EXPLODED' })]));
    const mixed = view.rows.find((r) => r.path === 'FG/MIXED')!;
    expect(mixed.diagnostics.find((d) => d.code === 'NOT_MAKE')!.message).toMatch(/procurement type BOTH/);
    expect(view.rows.some((r) => r.path.startsWith('FG/MIXED/'))).toBe(false);
  });

  it('20, 21. a component quantity is converted to its base unit; a missing conversion stops the branch with a note', async () => {
    const view = await explode();
    expect(view.rows.find((r) => r.path === 'FG/RAW4')).toMatchObject({ quantity: '500.000', unit: 'G', requiredQuantity: '0.500', requiredUnit: 'KG' });
    const box = view.rows.find((r) => r.path === 'FG/RAW5')!;
    expect(box.diagnostics.map((d) => d.code)).toContain('UNIT');
  });

  it('8. a cycle stops the branch with a cycle diagnostic and does not hang', async () => {
    const view = await explode({ materialNumber: 'CYA' });
    const back = view.rows.find((r) => r.path === 'CYA/CYB/CYA')!;
    expect(back.diagnostics.map((d) => d.code)).toContain('BOM_CYCLE');
    expect(view.rows.length).toBe(2);
  });

  it('9. the depth limit stops with a diagnostic rather than silently', async () => {
    const view = await explode({ materialNumber: 'DP00' });
    expect(view.maxLevel).toBe(20);
    const last = view.rows.find((r) => r.level === 20)!;
    expect(last.diagnostics.map((d) => d.code)).toContain('DEPTH_LIMIT');
  });

  it('12. a named usage and alternative override the production version', async () => {
    const view = await explode({ usage: 'P', alternative: '02' });
    expect(view.bom).toMatchObject({ alternative: '02', productionVersion: null });
    expect(view.rows.map((r) => r.materialNumber)).toEqual(['RAW2']);
  });

  it('13. a material with no production version and no named BOM is refused, naming the versions screen', async () => {
    const refusal = await expectRefusal(explode({ materialNumber: 'RAW1' }), /No BOM resolves for RAW1 in plant 1000/);
    expect(refusal.remedy).toContain('/production/production-versions');
  });

  it('refusals: unknown material, a bad date, a non-positive quantity, a named BOM that does not stand', async () => {
    await expectRefusal(explode({ materialNumber: 'NOPE' }), /Material NOPE does not stand/);
    await expectRefusal(explode({ keyDate: '2026-02-30' }), /Key date 2026-02-30 is not a calendar date/);
    await expectRefusal(explode({ quantity: '0' }), /Quantity 0 is not positive/);
    await expectRefusal(explode({ usage: 'P', alternative: '09' }), /BOM P\/09 of FG does not stand/);
  });
});

describe('where-used (CS15)', () => {
  it('15. single level finds every BOM containing the material, with the BOM quantity per base quantity', async () => {
    const view = await whereUsedBom({ client, materialNumber: 'RAW2', plant: PLANT, keyDate: KEY, depth: 'SINGLE' }, auth());
    expect(view.rows.map((r) => [r.parentMaterial, r.alternative, r.quantity, r.baseQuantity])).toEqual([
      ['FG', '01', '3.000', '10.000'], ['FG', '02', '9.000', '1.000'], ['SUB', '01', '4.000', '1.000'],
    ]);
    expect(view.rows.every((r) => r.level === 1)).toBe(true);
  });

  it('16. multi-level walks upward with levels, and applies the cycle rule', async () => {
    const view = await whereUsedBom({ client, materialNumber: 'RAW2', plant: PLANT, keyDate: KEY, depth: 'MULTI' }, auth());
    expect(view.rows.find((r) => r.path === 'RAW2/SUB/FG')).toMatchObject({ level: 2, parentMaterial: 'FG', componentMaterial: 'SUB' });
    const cyc = await whereUsedBom({ client, materialNumber: 'CYA', plant: PLANT, keyDate: KEY, depth: 'MULTI' }, auth());
    expect(cyc.rows.find((r) => r.path === 'CYA/CYB/CYA')!.diagnostics.map((d) => d.code)).toContain('BOM_CYCLE');
    const deep = await whereUsedBom({ client, materialNumber: 'DP22', plant: PLANT, keyDate: KEY, depth: 'MULTI' }, auth());
    expect(deep.maxLevel).toBe(20);
    expect(deep.rows.find((r) => r.level === 20)!.diagnostics.map((d) => d.code)).toContain('DEPTH_LIMIT');
  });

  it('where-used lists a parent whatever its procurement type (MIXED is BOTH)', async () => {
    const view = await whereUsedBom({ client, materialNumber: 'RAW1', plant: PLANT, keyDate: KEY, depth: 'SINGLE' }, auth());
    expect(view.rows.map((r) => r.parentMaterial)).toEqual(['FG', 'MIXED', 'PH']);
  });

  it('17. a material used in nothing returns an empty list with a note, not an error', async () => {
    const view = await whereUsedBom({ client, materialNumber: 'FG', plant: PLANT, keyDate: KEY, depth: 'MULTI' }, auth());
    expect(view.rows).toEqual([]);
    expect(view.note).toMatch(/FG is used in no BOM/);
  });
});

describe('authority', () => {
  it('18. an actor without PROD.BOM.DISPLAY is refused by the service', async () => {
    const clerk = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.POST'] });
    await expectRefusal(explodeBom({ client, materialNumber: 'FG', plant: PLANT, keyDate: KEY }, { authorization: clerk.authorization }), /You do not hold PROD\.BOM\.DISPLAY/);
    await expectRefusal(whereUsedBom({ client, materialNumber: 'RAW1', plant: PLANT, keyDate: KEY }), /signed-in user/);
  });

  it('19. an actor whose Plant scope misses the plant is refused, naming it; every-plant where-used reads only scoped plants', async () => {
    const elsewhere = await createFinanceActor(client, { capabilities: ['PROD.BOM.DISPLAY'], plantScopes: ['9999'] });
    await expectRefusal(explodeBom({ client, materialNumber: 'FG', plant: PLANT, keyDate: KEY }, { authorization: elsewhere.authorization }), /Plant scope does not cover plant 1000/);
    const scoped = await whereUsedBom({ client, materialNumber: 'RAW1', plant: PLANT, keyDate: KEY, allScopedPlants: true }, auth());
    expect(scoped.plants).toContain(PLANT);
    expect(scoped.rows.length).toBeGreaterThan(0);
  });
});
