/**
 * MRP exception monitor (MD06).
 *
 * What is worth proving: the monitor reads MD04's own exception counts and never recomputes them (test 17
 * is the one that catches a reimplemented rule); its population is the MRP run's (REQUIREMENTS and REORDER —
 * NONE and blank are not scanned, and are counted); the worklist is ordered by urgency and then by the
 * date that bites soonest; the scan is bounded and says so, and a material whose own list MD04 cut is
 * marked; and the authority is judged by the service before any planning data is read.
 */
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  MRP_EXCEPTION_CAPABILITY, MRP_EXCEPTION_LIMIT_CEILING, MrpExceptionError, mrpExceptionMonitor, type MrpExceptionResult,
} from '../src/modules/production/mrp-exception-monitor';
import { stockRequirementsList } from '../src/modules/production/stock-requirements';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';

const ACTOR = 'MD06-TEST';
const PLANT = 'QM01';
const QUIET = 'QM02';
const TODAY = '2026-05-15';
let tenant: TestTenant;
let client = '';
let planner: FinanceActor;
let outsider: FinanceActor;

async function material(code: string, o: { mrpType: string | null; stock: number; safety?: number; plant?: string }) {
  const plant = o.plant ?? PLANT;
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, ${code}, ${`Material ${code}`}, t.material_type, 'PC', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing`);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, mrp_type, mrp_controller, safety_stock, reorder_point, created_by)
      values (${client}, ${code}, ${plant}, ${o.mrpType}, '001', ${o.safety ?? 0}, 0, ${ACTOR})
      on conflict (client, material_number, plant) do update set mrp_type = excluded.mrp_type, safety_stock = excluded.safety_stock`);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values (${client}, ${code}, ${plant}, 'SL01', 'UNRESTRICTED', ${o.stock}, ${ACTOR})
      on conflict do nothing`);
  });
}

async function requisition(materialNumber: string, number: string, quantity: number, delivery: string) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into purchase_requisition_item (client, requisition_number, item_number, short_text, quantity, unit, requisition_date, delivery_date, plant, purchasing_group, material_number, created_by)
    values (${client}, ${number}, 1, 'Open requisition', ${quantity}, 'PC', '2026-03-01', ${delivery}, ${PLANT}, 'G94', ${materialNumber}, ${ACTOR})
    on conflict do nothing`));
}

async function reservation(materialNumber: string, number: string, quantity: number, date: string) {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into reservation_header (client, reservation_number, movement_type, base_date, created_by)
      values (${client}, ${number}, 'GOODS_ISSUE_RES', ${date}, ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into reservation_item (client, reservation_number, item_number, material_number, plant, required_quantity, unit_of_measure, created_by)
      values (${client}, ${number}, 1, ${materialNumber}, ${PLANT}, ${quantity}, 'PC', ${ACTOR}) on conflict do nothing`);
  });
}

const monitor = (over: Partial<Parameters<typeof mrpExceptionMonitor>[0]> = {}, actor: FinanceActor = planner) =>
  mrpExceptionMonitor({ client, today: TODAY, plant: PLANT, ...over }, { authorization: actor.authorization });
const names = (r: MrpExceptionResult) => r.materials.map((m) => m.materialNumber);

async function expectRefusal(promise: Promise<unknown>, fragment: string | RegExp): Promise<MrpExceptionError> {
  try {
    await promise;
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(MrpExceptionError);
    expect((error as Error).message).toMatch(fragment);
    expect((error as MrpExceptionError).remedy, 'a refusal names what to do next').toBeTruthy();
    return error as MrpExceptionError;
  }
  throw new Error(`Expected a MrpExceptionError matching ${fragment}, nothing was thrown.`);
}

beforeAll(async () => {
  tenant = await createTenant('md06-monitor');
  client = tenant.client;
  await withTenant(client, async (tx) => {
    for (const plant of [PLANT, QUIET]) {
      await tx.execute(sql`insert into plant (client, plant, name, country, created_by) values (${client}, ${plant}, ${`Plant ${plant}`}, 'KW', ${ACTOR}) on conflict do nothing`);
      await tx.execute(sql`insert into mrp_controller (client, plant, controller, name, created_by) values (${client}, ${plant}, '001', 'Controller 001', ${ACTOR}) on conflict do nothing`);
      await tx.execute(sql`insert into storage_location (client, plant, storage_location, name, is_active, created_by) values (${client}, ${plant}, 'SL01', 'Store', true, ${ACTOR}) on conflict do nothing`);
    }
    await tx.execute(sql`insert into purchasing_group (client, purchasing_group, name, created_by) values (${client}, 'G94', 'Test group', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values (${client}, 'GOODS_ISSUE_RES', 'Issue to reservation', 'ISSUE', 'RESERVATION', ${ACTOR}) on conflict do nothing`);
  });

  // Shortage today: 10 in stock against a safety stock of 20 → balance −10 (and the stock row itself dips under 20).
  await material('M-SHORT', { mrpType: 'REQUIREMENTS', stock: 10, safety: 20 });
  // Shortage later: 100 in stock, a reservation of 150 on 05-20, and another on 06-01.
  await material('M-SHORT-EARLY', { mrpType: 'REQUIREMENTS', stock: 100 });
  await reservation('M-SHORT-EARLY', 'R94000001', 150, '2026-05-20');
  await material('M-SHORT-LATE', { mrpType: 'REQUIREMENTS', stock: 100 });
  await reservation('M-SHORT-LATE', 'R94000002', 150, '2026-06-01');
  // Safety breach only: 30 in stock, safety 20 → balance 10, above zero and below 20.
  await material('M-BREACH', { mrpType: 'REQUIREMENTS', stock: 30, safety: 20 });
  await material('M-BREACH-REORDER', { mrpType: 'REORDER', stock: 30, safety: 20 });
  // Past due only: plenty in stock, a requisition that fell due before today.
  await material('M-PAST-OLD', { mrpType: 'REQUIREMENTS', stock: 500 });
  await requisition('M-PAST-OLD', '940000001', 5, '2026-04-01');
  await material('M-PAST-NEW', { mrpType: 'REQUIREMENTS', stock: 500 });
  await requisition('M-PAST-NEW', '940000002', 5, '2026-05-01');
  // Nothing wrong.
  await material('M-FINE', { mrpType: 'REQUIREMENTS', stock: 100, safety: 20 });
  // Would be in the worklist if they were scanned.
  await material('M-NONE', { mrpType: 'NONE', stock: 10, safety: 20 });
  await material('M-BLANK', { mrpType: null, stock: 10, safety: 20 });
  // A list MD04 cuts at its own limit: 505 open requisition items, with a shortage at the start.
  await material('M-BIG', { mrpType: 'REQUIREMENTS', stock: 10, safety: 20 });
  await withTenant(client, (tx) => tx.execute(sql`
    insert into purchase_requisition_item (client, requisition_number, item_number, short_text, quantity, unit, requisition_date, delivery_date, plant, purchasing_group, material_number, created_by)
    select ${client}, '940000900', g, 'Bulk requisition', 1, 'PC', '2026-03-01', ('2026-06-01'::date + g)::text::date, ${PLANT}, 'G94', 'M-BIG', ${ACTOR}
      from generate_series(1, 505) g`));
  // A quiet plant: one planned material, nothing wrong.
  await material('Q-FINE', { mrpType: 'REQUIREMENTS', stock: 100, safety: 20, plant: QUIET });

  planner = await createFinanceActor(client, { capabilities: [MRP_EXCEPTION_CAPABILITY] });
  outsider = await createFinanceActor(client, { capabilities: ['PROD.MRP.STOCKREQ'] });
}, 300_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

describe('what appears in the worklist', () => {
  it('1. a material below zero appears with SHORTAGE', async () => {
    const r = await monitor();
    expect(r.materials.find((m) => m.materialNumber === 'M-SHORT')!.counts.SHORTAGE).toBeGreaterThan(0);
    expect(r.materials.find((m) => m.materialNumber === 'M-SHORT-EARLY')!.counts.SHORTAGE).toBeGreaterThan(0);
  });

  it('2. a material between zero and its safety stock appears with SAFETY_BREACH and not SHORTAGE', async () => {
    const m = (await monitor()).materials.find((x) => x.materialNumber === 'M-BREACH')!;
    expect(m.counts).toMatchObject({ SHORTAGE: 0, PAST_DUE: 0 });
    expect(m.counts.SAFETY_BREACH).toBeGreaterThan(0);
    expect(m.worst).toBe('SAFETY_BREACH');
  });

  it('3. a material with a row dated before today appears with PAST_DUE', async () => {
    const m = (await monitor()).materials.find((x) => x.materialNumber === 'M-PAST-OLD')!;
    expect(m.counts).toMatchObject({ SHORTAGE: 0, SAFETY_BREACH: 0, PAST_DUE: 1 });
    expect(m.firstExceptionDate).toBe('2026-04-01');
  });

  it('4. a material with no exceptions does not appear', async () => {
    const r = await monitor();
    expect(names(r)).not.toContain('M-FINE');
    expect(r.population.scanned).toBeGreaterThan(r.population.matched);
  });

  it('5, 6. NONE and blank MRP types are not scanned, and are counted', async () => {
    const r = await monitor();
    expect(names(r)).not.toContain('M-NONE');
    expect(names(r)).not.toContain('M-BLANK');
    expect(r.population).toMatchObject({ excludedNone: 1, excludedBlank: 1, excludedNoMrpType: 2 });
  });

  it('7. the exceptions filter narrows the worklist to one code', async () => {
    const r = await monitor({ selection: { exceptions: ['PAST_DUE'] } });
    expect(names(r).sort()).toEqual(['M-PAST-NEW', 'M-PAST-OLD']);
    expect(r.selection.exceptions).toEqual(['PAST_DUE']);
    const shortages = await monitor({ selection: { exceptions: ['SHORTAGE'] } });
    expect(shortages.materials.every((m) => m.counts.SHORTAGE > 0)).toBe(true);
    expect(names(shortages)).not.toContain('M-BREACH');
  });

  it('7b. the MRP type narrows the population to one of the planned types', async () => {
    const r = await monitor({ selection: { mrpType: 'REORDER' } });
    expect(names(r)).toEqual(['M-BREACH-REORDER']);
  });

  it('8. the material range bounds the population; reversed is refused, naming both', async () => {
    const r = await monitor({ selection: { materialFrom: 'M-PAST-NEW', materialTo: 'M-PAST-OLD' } });
    expect(names(r).sort()).toEqual(['M-PAST-NEW', 'M-PAST-OLD']);
    expect(r.population.scanned).toBe(2);
    const error = await expectRefusal(monitor({ selection: { materialFrom: 'M-Z', materialTo: 'M-A' } }), /M-Z.*later than.*M-A/);
    expect(error.message).toContain('M-A');
  });
});

describe('ordering, totals and the population', () => {
  it('9. most urgent code first, and within a code the exception that bites soonest', async () => {
    const full = await monitor({ limit: 100 });
    const order = names(full).filter((n) => ['M-SHORT', 'M-SHORT-EARLY', 'M-SHORT-LATE', 'M-BREACH', 'M-PAST-OLD', 'M-PAST-NEW'].includes(n));
    expect(order).toEqual(['M-SHORT', 'M-SHORT-EARLY', 'M-SHORT-LATE', 'M-BREACH', 'M-PAST-OLD', 'M-PAST-NEW']);
    const rank = { SHORTAGE: 0, SAFETY_BREACH: 1, PAST_DUE: 2 } as const;
    for (let i = 1; i < full.materials.length; i += 1) {
      const a = full.materials[i - 1]!; const b = full.materials[i]!;
      expect(rank[a.worst]).toBeLessThanOrEqual(rank[b.worst]);
      if (a.worst === b.worst) expect((a.firstExceptionDate ?? '9999') <= (b.firstExceptionDate ?? '9999')).toBe(true);
    }
  });

  it('10. totals per code match the worklist', async () => {
    const r = await monitor({ limit: 100 });
    for (const code of ['SHORTAGE', 'SAFETY_BREACH', 'PAST_DUE'] as const) {
      expect(r.totals[code]).toBe(r.materials.reduce((t, m) => t + m.counts[code], 0));
    }
    expect(r.totals.SHORTAGE).toBeGreaterThan(0);
  });

  it('11. the cap is reported, not silent', async () => {
    const all = await monitor({ limit: 100 });
    const capped = await monitor({ limit: 3 });
    expect(capped.truncated).toBe(true);
    expect(capped.population).toMatchObject({ scanned: 3, capped: true, limit: 3 });
    expect(capped.population.notScanned).toBe(all.population.scanned - 3);
    expect(capped.warnings[0]).toMatch(new RegExp(`${capped.population.notScanned} materials were not scanned. The scan limit is 3.`));
    expect(all.truncated).toBe(false);
    expect(all.population.notScanned).toBe(0);
  });

  it('12. MD04\'s own truncation is carried up: a material whose list was cut is marked', async () => {
    const r = await monitor({ limit: 100 });
    const big = r.materials.find((m) => m.materialNumber === 'M-BIG')!;
    expect(big.listTruncated).toBe(true);
    expect(big.warnings.join(' ')).toMatch(/truncated at 500 rows/);
    expect(r.warnings.join(' ')).toMatch(/M-BIG: its own stock\/requirements list was truncated/);
    expect(r.materials.filter((m) => m.materialNumber !== 'M-BIG').every((m) => !m.listTruncated)).toBe(true);
  });

  it('13. the population is stated: scanned, matched, excluded, capped', async () => {
    const r = await monitor({ limit: 100 });
    expect(r.population).toMatchObject({
      scanned: 9, matched: r.materials.length, excludedNoMrpType: 2, capped: false, notScanned: 0, failed: 0, limit: 100,
    });
    expect(r.population.matched).toBe(8);          // the nine planned materials less M-FINE; the quiet plant's is not in this plant
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('14. a plant with no exceptions returns an empty worklist and a stated population, not an error', async () => {
    const r = await monitor({ plant: QUIET });
    expect(r.materials).toEqual([]);
    expect(r.totals).toEqual({ SHORTAGE: 0, SAFETY_BREACH: 0, PAST_DUE: 0 });
    expect(r.population).toMatchObject({ scanned: 1, matched: 0, excludedNoMrpType: 0, capped: false });
  });

  it('every row drills to MD04 with the material and plant filled in', async () => {
    const r = await monitor();
    const link = r.drillDown('M-SHORT');
    expect(link).toBe('/production/stock-requirements?material=M-SHORT&plant=QM01');
    const withHorizon = await monitor({ selection: { horizonEnd: '2026-12-31' } });
    expect(withHorizon.drillDown('M-SHORT')).toBe('/production/stock-requirements?material=M-SHORT&plant=QM01&horizonEnd=2026-12-31');
  });
});

describe('refusals', () => {
  it('15. an MRP area is refused, naming the plant as the planning scope', async () => {
    await expectRefusal(monitor({ selection: { mrpArea: 'A1' } }), /MRP area A1 does not stand/);
    const error = await expectRefusal(monitor({ selection: { mrpArea: 'A1' } }), /./);
    expect(error.remedy).toMatch(/plant is the planning scope/);
  });

  it('a plant that does not stand, a bad date and a limit above the ceiling are refused by name', async () => {
    await expectRefusal(monitor({ plant: 'ZZ99' }), /Plant scope does not cover plant ZZ99|Plant ZZ99 does not stand/);
    await expectRefusal(monitor({ selection: { horizonEnd: '2026-02-30' } }), /Planning horizon end 2026-02-30 is not a calendar date/);
    await expectRefusal(monitor({ selection: { horizonEnd: '2026-01-01' } }), /horizon ends in the past/);
    await expectRefusal(monitor({ limit: MRP_EXCEPTION_LIMIT_CEILING + 1 }), new RegExp(`above the ceiling of ${MRP_EXCEPTION_LIMIT_CEILING}`));
    await expectRefusal(monitor({ limit: 0 }), /positive whole number/);
  });

  it('16. an actor without the capability is refused by the service, before any read', async () => {
    await expectRefusal(monitor({}, outsider), /do not hold PROD\.MRP\.EXCEPTION/);
    await expectRefusal(mrpExceptionMonitor({ client, today: TODAY, plant: PLANT }), /signed-in user/);
    // The refusal comes before the selection is even looked at: a bad selection does not get a different answer.
    await expectRefusal(monitor({ selection: { mrpArea: 'A1' } }, outsider), /do not hold PROD\.MRP\.EXCEPTION/);
  });
});

describe('agreement with MD04', () => {
  it('17. for every listed material the monitor\'s counts equal MD04\'s exceptionCounts for the same material, plant and date', async () => {
    const r = await monitor({ limit: 100 });
    expect(r.materials.length).toBeGreaterThan(5);
    for (const m of r.materials) {
      const md04 = await stockRequirementsList({ client, today: TODAY, selection: { material: m.materialNumber, plant: PLANT } });
      expect(m.counts, m.materialNumber).toEqual(md04.exceptionCounts);
      expect(m.closingBalance, m.materialNumber).toBe(md04.closingBalance);
      expect(m.safetyStock, m.materialNumber).toBe(md04.safetyStock);
    }
    // And a material the monitor leaves out has none in MD04.
    const fine = await stockRequirementsList({ client, today: TODAY, selection: { material: 'M-FINE', plant: PLANT } });
    expect(fine.exceptionCounts).toEqual({ SHORTAGE: 0, SAFETY_BREACH: 0, PAST_DUE: 0 });
  });
});

describe('registry and screen', () => {
  const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

  it('the capability, MD06 and the route are registered; the service never writes', async () => {
    const found = await withTenant(client, async (tx) => ({
      capability: (await tx.execute(sql`select module, action, is_posting_relevant from capability where code = ${MRP_EXCEPTION_CAPABILITY}`)) as unknown as Array<Record<string, unknown>>,
      term: (await tx.execute(sql`
        select r.route_path, r.coverage_tier, r.conformance_tier, array_agg(a.alias order by a.alias) as aliases
          from term_registry r join term_alias a on a.term_id = r.id and a.external_system = 'REFERENCE_ERP' and a.usage = 'SEARCH_ONLY'
         where r.our_code = ${MRP_EXCEPTION_CAPABILITY} group by 1, 2, 3`)) as unknown as Array<Record<string, unknown>>,
    }));
    expect(found.capability[0]).toMatchObject({ module: 'PROD', action: 'DISPLAY', is_posting_relevant: false });
    expect(found.term[0]).toMatchObject({ route_path: '/production/mrp-exception-monitor', coverage_tier: 'TIER_1_BUILT', conformance_tier: 'B', aliases: ['MD06'] });
    expect(source('scripts/seed.ts')).toContain("code: 'PROD.MRP.EXCEPTION'");
    expect(source('src/ui/shell/screen-catalog.ts')).toMatch(/path: "\/production\/mrp-exception-monitor",[\s\S]*?code: "PROD\.MRP\.EXCEPTION",[\s\S]*?title: "MRP exception monitor",[\s\S]*?accepts: \["plant", "materialFrom", "materialTo", "mrpType", "horizonEnd", "exceptions"\]/);
    const service = source('src/modules/production/mrp-exception-monitor.ts');
    expect(service).not.toMatch(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i);
    expect(service).toContain('stockRequirementsList(');
    expect(service).not.toMatch(/balanceNow|projectedBalance\s*<|SHORTAGE['\"]\s*\)?\s*;?\s*\n\s*(if|else)/);
  });

  it('the screen reads the FormData names, calls the service and links every row to MD04', () => {
    const page = source('src/app/production/mrp-exception-monitor/page.tsx');
    for (const name of ['plant', 'materialFrom', 'materialTo', 'mrpType', 'horizonEnd', 'exceptions']) expect(page).toContain(`name="${name}"`);
    expect(page).toContain('mrpExceptionMonitor(');
    expect(page).toContain('result.drillDown(');
    expect(page).toContain('not scanned');
    expect(page).toContain('list truncated');
    expect(source('src/app/production/stock-requirements/page.tsx')).toContain("get('material')");
  });
});
