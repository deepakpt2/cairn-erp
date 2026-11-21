/**
 * Capacity load (CM01). The arithmetic is asserted as numbers, because the point of the report is that
 * each figure is right, and every default it takes is a stated warning.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  bucketKey, checkWindow, CAPACITY_LOAD_CAPABILITY, CAPACITY_LOAD_LIMIT_CEILING, CapacityLoadError, drillDownFor, effectiveDailyMinutes,
  isoWeekKey, loadCapacityReport, requirementOf, type CapacityLoadQuery, type CapacityLoadReport,
} from '../src/modules/production/capacity-load';
import { createProductionVersionForProvisioning as createProductionVersion } from '../src/modules/production/production-version';
import { createMaterialBomForProvisioning as createMaterialBom, saveBomItemCategory, saveBomStatus, saveBomUsage } from '../src/modules/production/material-bom';
import { createRoutingForProvisioning as createRouting, saveRoutingControlKey, saveRoutingStandardValueKey, saveRoutingStatus, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { changeWorkCenterForProvisioning as changeWorkCenter, createWorkCenterForProvisioning as createWorkCenter, getWorkCenterForProvisioning as getWorkCenter, saveWorkCenterCategory, WorkCenterError, type WorkCenterCapacityInput } from '../src/modules/production/work-center';
import { saveCalendarPeriod, saveHolidayCalendar, addHolidayDay } from '../src/modules/foundation/factory-calendar';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'CM01-TEST';
const PLANT = '1000';
const OTHER = '2000';
const FROM = '2026-06-01'; // a Monday: ISO week 23
const TO = '2026-06-28';   // four weeks, W23 to W26
const CAPS = [CAPACITY_LOAD_CAPABILITY];
let tenant: TestTenant;
let other: TestTenant;
let client = '';

const times = { startTime: '08:00', endTime: '17:00', breakMinutes: 60 };
const cap = (category: string, over: Partial<WorkCenterCapacityInput> = {}): WorkCenterCapacityInput => ({
  capacityCategory: category, baseUnit: 'MIN', ...times, utilization: '90.00', individualCapacities: 2, ...over,
});

async function center(workCenter: string, capacities: WorkCenterCapacityInput[], standardValueKey: string | null = 'SV01') {
  await createWorkCenter({ client, changedBy: ACTOR, plant: PLANT, workCenter, category: 'MACH', description: workCenter, standardValueKey, capacities });
}

let seq = 0;
async function order(o: {
  start: string; finish?: string | null; status?: string; plant?: string; workCenter: string; workCenterPlant?: string; quantity?: number;
  opQuantity?: number | null; base?: number | null; values: Array<[string, number, string]>;
}) {
  const number = `9${String(++seq).padStart(5, '0')}`;
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into production_order (client, order_number, material_number, plant, order_quantity, unit_of_measure, scheduled_start, scheduled_finish, status,
        technically_completed_by, technically_completed_at, created_by)
      values (${client}, ${number}, 'CM-FG', ${o.plant ?? PLANT}, ${o.quantity ?? 100}, 'PC', ${o.start}, ${o.finish === undefined ? o.start : o.finish}, ${o.status ?? 'RELEASED'},
        ${o.status === 'TECHNICALLY_COMPLETED' ? ACTOR : null}, ${o.status === 'TECHNICALLY_COMPLETED' ? new Date().toISOString() : null}, ${ACTOR})`);
    await tx.execute(sql`
      insert into production_order_operation (client, order_number, operation_number, sequence, execution_order, task_list_type, routing_group, group_counter,
        production_version, source_operation_number, routing_version, work_center, work_center_plant, operation_quantity, base_quantity, valid_from, valid_to,
        confirmation, external_processing, created_by)
      values (${client}, ${number}, '0010', '000000', 1, 'N', 'CMX', '01', '0001', '0010', 1, ${o.workCenter}, ${o.workCenterPlant ?? PLANT},
        ${o.opQuantity === undefined ? o.quantity ?? 100 : o.opQuantity}, ${o.base === undefined ? 1 : o.base}, '2020-01-01', '9999-12-31', ' ', ' ', ${ACTOR})`);
    for (const [parameter, quantity, unit] of o.values) {
      await tx.execute(sql`
        insert into production_order_operation_value (client, order_number, operation_number, parameter, description, quantity, unit, required, created_by)
        values (${client}, ${number}, '0010', ${parameter}, ${parameter}, ${quantity}, ${unit}, ' ', ${ACTOR})`);
    }
  });
  return number;
}

const report = (over: Partial<CapacityLoadQuery> = {}, caps: string[] = CAPS): Promise<CapacityLoadReport> =>
  loadCapacityReport({ client, plant: PLANT, dateFrom: FROM, dateTo: TO, period: 'WEEK', includePlannedOrders: false, ...over }, caps);
const rowOf = (r: CapacityLoadReport, wc: string, category: string) => r.rows.find((x) => x.workCenter === wc && x.capacityCategory === category)!;
const codes = (r: CapacityLoadReport, scope?: 'HEADER' | 'ROW') => r.warnings.filter((w) => !scope || w.scope === scope).map((w) => w.code);

async function expectRefusal(promise: Promise<unknown>, fragment: string | RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(CapacityLoadError);
    expect((error as Error).message).toMatch(fragment);
    expect((error as CapacityLoadError).remedy, 'a refusal names what to do next').toBeTruthy();
    return error as CapacityLoadError;
  }
  throw new Error(`Expected a CapacityLoadError matching ${fragment}, nothing was thrown.`);
}

beforeAll(async () => {
  tenant = await createTenant('cm01-load');
  client = tenant.client;
  other = await createTenant('cm01-load-b');
  await withTenant(client, async (tx) => {
    await tx.execute(sql`insert into plant (client, plant, name, country, created_by) values (${client}, ${OTHER}, 'Other plant', 'KW', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'CM-FG', 'Finished good', t.material_type, 'PC', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t on conflict do nothing`);
  });
  await saveRoutingStandardValueKey({
    client, changedBy: ACTOR, standardValueKey: 'SV01', description: 'Machine and labour',
    parameters: [{ parameter: 'MACH', description: 'Machine', unit: 'MIN' }, { parameter: 'LAB', description: 'Labour', unit: 'MIN' }, { parameter: 'SETUP', description: 'Setup', unit: 'MIN' }],
  });
  await saveWorkCenterCategory({ client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });

  await center('WC01', [cap('MAC', { standardValueParameter: 'MACH' }), cap('LAB', { standardValueParameter: 'LAB' })]);
  await center('WC02', [cap('MAC')]);                                                   // no parameter: load is Unassigned
  await center('WC03', [cap('MAC', { standardValueParameter: 'MACH', startTime: null, endTime: null, breakMinutes: 0 })]);
  await center('WC04', [{ capacityCategory: 'MAC', baseUnit: 'MIN', ...times, standardValueParameter: 'MACH' }]); // null utilisation and individual
  await center('WC05', [cap('MAC', { standardValueParameter: 'MACH' })]);              // unit mismatch
  await center('WC06', [cap('MAC', { standardValueParameter: 'MACH', baseUnit: null })]); // unit unstated
  await center('WC07', [cap('MAC', { standardValueParameter: 'MACH' })]);              // planned orders
  await center('WC08', [cap('MAC', { standardValueParameter: 'MACH' })]);              // nothing loads it
  await center('WC09', [cap('MAC', { standardValueParameter: 'MACH' })]);              // no base quantity
  await center('WC10', [cap('MAC', { standardValueParameter: 'MACH' })]);              // cross plant

  // Calendar rules, spreading and unit conversion (the amended CM01).
  await withTenant(client, (tx) => tx.execute(sql`
    insert into factory_calendar (client, calendar_id, name) values (${client}, '01', 'Ruled'), (${client}, '02', 'No rules')`));
  await saveHolidayCalendar({ client, changedBy: ACTOR, capabilities: ['CFG.FND.CALENDAR.DEFINE'], holidayCalendarId: 'H1', name: 'Holidays', validFromYear: 2026, validToYear: 2026 });
  await addHolidayDay({ client, changedBy: ACTOR, capabilities: ['CFG.FND.CALENDAR.DEFINE'], holidayCalendarId: 'H1', date: '2026-06-03', description: 'Midweek' });
  await saveCalendarPeriod({
    client, changedBy: ACTOR, capabilities: ['CFG.FND.CALENDAR.DEFINE'], calendarId: '01', validFrom: '2026-01-01', validTo: '2026-12-31', holidayCalendarId: 'H1',
    monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false,
  });
  await center('WC11', [cap('MAC', { standardValueParameter: 'MACH', factoryCalendar: '01' })]);
  await center('WC12', [cap('MAC', { standardValueParameter: 'MACH', factoryCalendar: '02' })]);
  await center('WC13', [cap('MAC', { standardValueParameter: 'MACH' })]);              // 7-day window
  await center('WC14', [cap('MAC', { standardValueParameter: 'MACH' })]);              // 21-day window
  await center('WC15', [cap('MAC', { standardValueParameter: 'MACH' }), cap('LAB', { standardValueParameter: 'LAB' })]); // 90:10
  await center('WC16', [cap('MAC', { standardValueParameter: 'MACH' })]);              // one day
  await center('WC17', [cap('MAC', { standardValueParameter: 'MACH' })]);              // no finish date
  await center('WC18', [cap('MAC', { standardValueParameter: 'MACH' })]);              // MIN + HR
  await center('WC19', [cap('MAC', { standardValueParameter: 'MACH' })]);              // unconvertible unit
  await withTenant(client, (tx) => tx.execute(sql`
    insert into unit_of_measure (code, name, dimension, decimal_places, is_base_unit) values ('XT9', 'Unseeded test unit', 'TIME', 2, false) on conflict do nothing`));
  await order({ start: '2026-06-02', finish: '2026-06-08', workCenter: 'WC13', opQuantity: 1, base: 1, values: [['MACH', 700, 'MIN']] });
  await order({ start: '2026-06-01', finish: '2026-06-21', workCenter: 'WC14', opQuantity: 1, base: 1, values: [['MACH', 700, 'MIN']] });
  await order({ start: '2026-06-02', finish: '2026-06-08', workCenter: 'WC15', opQuantity: 1, base: 1, values: [['MACH', 90, 'MIN'], ['LAB', 10, 'MIN']] });
  await order({ start: '2026-06-02', workCenter: 'WC16', opQuantity: 1, base: 1, values: [['MACH', 70, 'MIN']] });
  await order({ start: '2026-06-02', finish: 'unknown', workCenter: 'WC17', opQuantity: 1, base: 1, values: [['MACH', 70, 'MIN']] });
  await order({ start: '2026-06-02', workCenter: 'WC18', opQuantity: 1, base: 1, values: [['MACH', 90, 'MIN']] });
  await order({ start: '2026-06-02', workCenter: 'WC18', opQuantity: 1, base: 1, values: [['MACH', 1, 'HR']] });
  await order({ start: '2026-06-02', workCenter: 'WC19', opQuantity: 1, base: 1, values: [['MACH', 5, 'XT9']] });

  // 1, 5, 7, 8: WC01 (machine 90 / labour 30 per 120 base, quantity 300), WC02 unassigned.
  await order({ start: '2026-06-02', workCenter: 'WC01', opQuantity: 300, base: 120, values: [['MACH', 90, 'MIN'], ['LAB', 30, 'MIN']] });
  await order({ start: '2026-06-09', workCenter: 'WC02', opQuantity: 10, base: 1, values: [['MACH', 5, 'MIN']] });
  // 2/3: WC04 gets some load too, 4: WC03 has load but no times.
  await order({ start: '2026-06-02', workCenter: 'WC04', opQuantity: 10, base: 1, values: [['MACH', 10, 'MIN']] });
  await order({ start: '2026-06-02', workCenter: 'WC03', opQuantity: 10, base: 1, values: [['MACH', 10, 'MIN']] });
  // 9: the parameter is in hours but the capacity is in minutes.
  await order({ start: '2026-06-02', workCenter: 'WC05', opQuantity: 10, base: 1, values: [['MACH', 3, 'H']] });
  await order({ start: '2026-06-02', workCenter: 'WC06', opQuantity: 10, base: 1, values: [['MACH', 3, 'MIN']] });
  // 10: one order spanning three weeks puts all of its load in the first week.
  await order({ start: '2026-06-09', workCenter: 'WC08', opQuantity: 1, base: 1, values: [['MACH', 100, 'MIN']] });
  // 6: no base quantity.
  await order({ start: '2026-06-02', workCenter: 'WC09', opQuantity: 10, base: null, values: [['MACH', 7, 'MIN']] });
  // 14: an order of another plant that loads this plant's work center.
  await order({ start: '2026-06-16', plant: OTHER, workCenter: 'WC10', opQuantity: 1, base: 1, values: [['MACH', 60, 'MIN']] });
  // Outside the range, and in a status the report does not count.
  await order({ start: '2026-07-20', workCenter: 'WC10', opQuantity: 1, base: 1, values: [['MACH', 999, 'MIN']] });
  await order({ start: '2026-06-16', status: 'TECHNICALLY_COMPLETED', workCenter: 'WC10', opQuantity: 1, base: 1, values: [['MACH', 999, 'MIN']] });
}, 300_000);

afterAll(async () => {
  await withTenant(client, (tx) => tx.execute(sql`delete from unit_of_measure where code = 'XT9'`)).catch(() => undefined);
  if (tenant) await destroyTenant(tenant.client);
  if (other) await destroyTenant(other.client);
  await closeDb();
});

describe('the arithmetic', () => {
  it('1. available capacity is (540 − 60) × 2 × 0.9 = 864 minutes a day', async () => {
    expect(effectiveDailyMinutes({ ...times, individualCapacities: 2, utilization: 90 })).toBe(864);
    const r = await report();
    expect(rowOf(r, 'WC01', 'MAC').cells[0].available).toBe(864 * 5);
    expect(rowOf(r, 'WC01', 'MAC').total.available).toBe(864 * 5 * 4);
    expect(r.workingDaysPerWeek).toBe(5);
  });

  it('2. a null utilisation is 100% and is warned about', async () => {
    const row = rowOf(await report(), 'WC04', 'MAC');
    expect(row.warnings.map((w) => w.code)).toContain('CAPACITY_NO_UTILISATION');
    expect(row.cells[0].available).toBe(480 * 1 * 1 * 5);
  });

  it('3. a null individual capacities is 1 and is warned about', async () => {
    expect(rowOf(await report(), 'WC04', 'MAC').warnings.map((w) => w.code)).toContain('CAPACITY_NO_INDIVIDUAL');
  });

  it('4. no operating times is unknown, not free', async () => {
    const r = await report();
    const unknown = rowOf(r, 'WC03', 'MAC');
    const free = rowOf(r, 'WC08', 'MAC');
    expect(unknown.availableUnknown).toBe(true);
    expect(unknown.warnings.map((w) => w.code)).toContain('CAPACITY_NO_TIMES');
    expect(unknown.total.available).toBe(0);
    expect(free.availableUnknown).toBe(false);
    expect(unknown.total.loadPercent).toBeNull();
  });

  it('5. a requirement is standard value × operation quantity ÷ base quantity = 225', async () => {
    expect(requirementOf(90, 300, 120)).toBe(225);
    expect(rowOf(await report(), 'WC01', 'MAC').total.required).toBe(225);
  });

  it('6. a null base quantity is skipped and warned about, with no bogus figure', async () => {
    expect(requirementOf(7, 10, null)).toBeNull();
    expect(requirementOf(7, 10, 0)).toBeNull();
    const row = rowOf(await report(), 'WC09', 'MAC');
    expect(row.total.required).toBe(0);
    expect(row.warnings.map((w) => w.code)).toContain('CAPACITY_NO_BASE_QTY');
  });

  it('12. loadPercent is null when available is 0, never infinity and never 0', async () => {
    const row = rowOf(await report(), 'WC03', 'MAC');
    expect(row.total.required).toBe(100);
    expect(row.total.loadPercent).toBeNull();
    expect(row.cells.every((c) => c.loadPercent === null)).toBe(true);
    expect(rowOf(await report(), 'WC01', 'MAC').total.loadPercent).toBe(Math.round((225 / (864 * 5 * 4)) * 100));
  });
});

describe('attribution', () => {
  it('7. each capacity receives only its own parameter’s value', async () => {
    const r = await report();
    expect(rowOf(r, 'WC01', 'MAC').total.required).toBe(225);
    expect(rowOf(r, 'WC01', 'LAB').total.required).toBe(75); // 30 × 300 ÷ 120
  });

  it('8. a capacity with no parameter puts the load in Unassigned, visibly', async () => {
    const r = await report();
    const row = r.rows.find((x) => x.workCenter === 'WC02' && x.unassigned)!;
    expect(row.total.required).toBe(50);
    expect(row.warnings.map((w) => w.code)).toContain('CAPACITY_UNASSIGNED_LOAD');
    expect(rowOf(r, 'WC02', 'MAC').total.required).toBe(0);
  });

  it('9. a unit mismatch excludes the contribution and names both units', async () => {
    const row = rowOf(await report(), 'WC05', 'MAC');
    expect(row.total.required).toBe(0);
    const w = row.warnings.find((x) => x.code === 'CAPACITY_UNIT_MISMATCH')!;
    expect(w.message).toContain(' H ');
    expect(w.message).toContain('MIN');
    expect(w.message).toMatch(/UNIT_(NOT_FOUND|FACTOR_MISSING)/); // the converter's own reason is given
  });

  it('9b. an unstated capacity unit takes the first contribution’s and says so', async () => {
    const row = rowOf(await report(), 'WC06', 'MAC');
    expect(row.unit).toBe('MIN');
    expect(row.warnings.map((w) => w.code)).toContain('CAPACITY_UNIT_UNSTATED');
    expect(row.total.required).toBe(30);
  });

  it('14. an order of another plant that loads this plant’s work center is included', async () => {
    const r = await report();
    expect(rowOf(r, 'WC10', 'MAC').total.required).toBe(60);
    expect(r.rows.some((x) => x.total.required === 999)).toBe(false);
  });
});

describe('periods', () => {
  it('10. a 7-day window with a load of 700 puts 100 in each day; 21 days over three weeks puts a third in each', async () => {
    const days = rowOf(await report({ period: 'DAY' }), 'WC13', 'MAC');
    const loaded = days.cells.filter((c) => c.required > 0);
    expect(loaded).toHaveLength(7);
    expect(loaded.every((c) => c.required === 100)).toBe(true);
    expect(days.cells[1].period).toBe('2026-06-02');
    const weeks = rowOf(await report(), 'WC14', 'MAC');
    expect(weeks.cells.map((c) => c.required)).toEqual([233.333, 233.333, 233.333, 0]);
  });

  it('11a. an order of one day puts the whole load on that day', async () => {
    const cells = rowOf(await report({ period: 'DAY' }), 'WC16', 'MAC').cells;
    expect(cells.filter((c) => c.required > 0)).toEqual([expect.objectContaining({ period: '2026-06-02', required: 70 })]);
  });

  it('11b. a finish before the start refuses, naming the order', () => {
    // The database forbids such an order, so the rule is asserted directly.
    expect(() => checkWindow('Production order 900001', '2026-06-10', '2026-06-09')).toThrow(/Production order 900001.*2026-06-09/);
    expect(() => checkWindow('Production order 900001', '2026-06-10', '2026-06-10')).not.toThrow();
    expect(() => checkWindow('Production order 900001', '2026-06-10', 'unknown')).not.toThrow();
  });

  it('11c. a missing finish puts everything on the start and warns on the row', async () => {
    const row = rowOf(await report(), 'WC17', 'MAC');
    expect(row.cells.map((c) => c.required)).toEqual([70, 0, 0, 0]);
    expect(row.warnings.map((w) => w.code)).toContain('CAPACITY_ORDER_WINDOW_MISSING');
    expect(rowOf(await report(), 'WC13', 'MAC').warnings.map((w) => w.code)).not.toContain('CAPACITY_ORDER_WINDOW_MISSING');
  });

  it('spreading follows the operation durations: 90 and 10 are 90% and 10% of every day', async () => {
    const r = await report({ period: 'DAY' });
    const mac = rowOf(r, 'WC15', 'MAC').cells.filter((c) => c.required > 0);
    const lab = rowOf(r, 'WC15', 'LAB').cells.filter((c) => c.required > 0);
    expect(mac).toHaveLength(7);
    for (let i = 0; i < 7; i += 1) expect(mac[i].required / (mac[i].required + lab[i].required)).toBeCloseTo(0.9, 2);
    expect(rowOf(r, 'WC15', 'MAC').total.required).toBeCloseTo(90, 2);
  });

  it('a window that runs past the range loses only the part outside it', async () => {
    const order9 = rowOf(await report({ dateTo: '2026-06-04', period: 'DAY' }), 'WC13', 'MAC');
    expect(order9.total.required).toBe(300); // 2, 3 and 4 June of seven days
  });

  it('11. the axis holds every period, loaded or not', async () => {
    const r = await report();
    expect(r.periods).toEqual(['2026-W23', '2026-W24', '2026-W25', '2026-W26']);
    expect(rowOf(r, 'WC01', 'MAC').cells).toHaveLength(4);
    expect((await report({ period: 'DAY' })).periods).toHaveLength(28);
    expect((await report({ dateTo: '2026-08-15', period: 'MONTH' })).periods).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    expect(bucketKey('2026-06-17', 'MONTH')).toBe('2026-06');
  });

  it('changing working days per week changes available capacity, and is echoed', async () => {
    const five = rowOf(await report(), 'WC01', 'MAC').cells[0];
    const sevenReport = await report({ workingDaysPerWeek: 7 });
    expect(rowOf(sevenReport, 'WC01', 'MAC').cells[0].available).toBe(864 * 7);
    expect(sevenReport.workingDaysPerWeek).toBe(7);
    expect(five.available).toBe(864 * 5);
  });

  it('a cell drills to the order list for its own period, dated by scheduled start', async () => {
    const r = await report();
    const url = new URL(drillDownFor(PLANT, r.periodRanges['2026-W24']), 'http://x');
    expect(url.pathname).toBe('/production/order-information');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ plant: PLANT, dateBasis: 'SCHEDULED_START', dateFrom: '2026-06-08', dateTo: '2026-06-14', run: '1' });
  });
});

describe('calendar and units', () => {
  it('11d. 90 MIN and 1 HR sum to 150 minutes, not 91 and not a refusal', async () => {
    const row = rowOf(await report(), 'WC18', 'MAC');
    expect(row.total.required).toBe(150);
    expect(row.warnings.map((w) => w.code)).not.toContain('CAPACITY_UNIT_MISMATCH');
  });

  it('11e. a unit the converter refuses is excluded with its reason', async () => {
    const row = rowOf(await report(), 'WC19', 'MAC');
    expect(row.total.required).toBe(0);
    const w = row.warnings.find((x) => x.code === 'CAPACITY_UNIT_MISMATCH')!;
    expect(w.message).toContain('UNIT_FACTOR_MISSING');
    expect(w.message).toContain('XT9');
  });

  it('11f. a capacity with calendar rules counts the real working days, a holiday excluded', async () => {
    const r = await report();
    const cells = rowOf(r, 'WC11', 'MAC').cells;
    expect(cells[0].available).toBe(864 * 4); // week of 1 June: Mon–Fri less Wednesday 3 June
    expect(cells[1].available).toBe(864 * 5);
    expect(rowOf(r, 'WC11', 'MAC').warnings.map((w) => w.code)).not.toContain('CAPACITY_NO_CALENDAR');
    // the declared figure is ignored where rules exist
    expect(rowOf(await report({ workingDaysPerWeek: 7 }), 'WC11', 'MAC').cells[1].available).toBe(864 * 5);
  });

  it('11g. a calendar with no rules falls back to the proportion and says so on the row', async () => {
    const r = await report();
    const row = rowOf(r, 'WC12', 'MAC');
    expect(row.cells[0].available).toBe(864 * 5);
    const w = row.warnings.find((x) => x.code === 'CAPACITY_NO_CALENDAR')!;
    expect(w.message).toContain('calendar 02');
    expect((await report({ workingDaysPerWeek: 7 })).rows.find((x) => x.workCenter === 'WC12')!.cells[0].available).toBe(864 * 7);
  });
});

describe('warnings and bounds', () => {
  it('the spread is always a header warning; the working-days assumption names how many capacities fell back', async () => {
    const r = await report();
    expect(codes(r, 'HEADER')).toEqual(expect.arrayContaining(['CAPACITY_LOAD_SPREAD', 'CAPACITY_WORKING_DAYS_ASSUMED']));
    const w = r.warnings.find((x) => x.code === 'CAPACITY_WORKING_DAYS_ASSUMED')!;
    expect(r.calendarFallbackCount).toBeGreaterThan(0);
    expect(w.message).toMatch(new RegExp(`${r.calendarFallbackCount} of \\d+ capacities`));
    expect(w.message).toContain('/config/factory-calendars');
  });

  it('when every capacity has rules the header says so instead of warning', async () => {
    const r = await report({ workCenterFrom: 'WC11', workCenterTo: 'WC11' });
    expect(r.calendarFallbackCount).toBe(0);
    expect(codes(r, 'HEADER')).toContain('CAPACITY_CALENDAR_RULES_USED');
    expect(codes(r, 'HEADER')).not.toContain('CAPACITY_WORKING_DAYS_ASSUMED');
  });

  it('16. a limit above the ceiling is refused, naming the ceiling', async () => {
    await expectRefusal(report({ limit: CAPACITY_LOAD_LIMIT_CEILING + 1 }), String(CAPACITY_LOAD_LIMIT_CEILING));
  });

  it('17. truncation reports how many work centers were not scanned', async () => {
    const r = await report({ limit: 3 });
    expect(r.scanned.workCenters).toBe(3);
    expect(r.truncated).toBe(true);
    const total = (await report()).scanned.workCenters;
    expect(r.notScanned).toBe(total - 3);
    expect(r.warnings.find((w) => w.code === 'CAPACITY_LOAD_TRUNCATED')!.message).toContain(`${total - 3} work centers were not scanned`);
  });

  it('15. a missing capability is refused before anything is read', async () => {
    // The client does not exist: any read would fail differently, so this refusal proves none was made.
    await expectRefusal(loadCapacityReport({ client: 'ZZZZ', plant: PLANT, dateFrom: FROM, dateTo: TO }, ['PROD.MRP.EXCEPTION']), CAPACITY_LOAD_CAPABILITY);
  });

  it('validates in order: plant, dates, range, period, working days', async () => {
    await expectRefusal(report({ plant: 'NOPE' }), /Plant NOPE does not stand/);
    await expectRefusal(report({ dateFrom: '2026-02-30' }), /not a calendar date/);
    await expectRefusal(report({ dateFrom: TO, dateTo: FROM }), /before the from date/);
    await expectRefusal(report({ workCenterFrom: 'WC09', workCenterTo: 'WC01' }), /later than/);
    await expectRefusal(report({ period: 'YEAR' as never }), /YEAR/);
    await expectRefusal(report({ workingDaysPerWeek: 8 }), /1 to 7/);
  });

  it('a work center with no load is returned with zeros', async () => {
    const row = rowOf(await report(), 'WC08', 'MAC');
    expect(row.cells[0]).toMatchObject({ required: 0, loadPercent: 0 });
  });
});

describe('planned orders', () => {
  it('13. a planned order with a selectable version loads its routing’s work center; one without is warned about', async () => {
    await saveBomUsage({ client, changedBy: ACTOR, usage: 'P', description: 'Production', productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.' });
    await saveBomItemCategory({ client, changedBy: ACTOR, category: 'S', description: 'Stock', materialEntry: '+', quantityEntry: '+' });
    await saveBomStatus({ client, changedBy: ACTOR, status: '01', description: 'Released', releasedForMrp: 'X', releasedForCosting: 'X', releasedForOrders: 'X' });
    await saveRoutingTaskListType({ client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingStatus({ client, changedBy: ACTOR, status: '1', description: 'Released', releasedForScheduling: 'X', releasedForCosting: 'X', releasedForOrders: 'X' });
    await saveRoutingControlKey({ client, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal', costing: 'X' });
    await withTenant(client, async (tx) => {
      for (const code of ['CM-PL', 'CM-RAW', 'CM-NOVER']) {
        await tx.execute(sql`
          insert into material (client, material_number, description, material_type, base_unit, created_by)
          select ${client}, ${code}, ${code}, t.material_type, 'PC', ${ACTOR} from (select material_type from material_type where client = ${client} order by material_type limit 1) t on conflict do nothing`);
        await tx.execute(sql`
          insert into material_plant (client, material_number, plant, mrp_type, mrp_controller, procurement_type, lot_sizing, fixed_lot_size, safety_stock, reorder_point,
            planned_delivery_days, in_house_production_days, purchasing_group, mrp_status, created_by)
          values (${client}, ${code}, ${PLANT}, 'REQUIREMENTS', '001', 'MAKE', 'EXACT', '0', '0', '0', 0, 0, '001', 'MAINTAINED', ${ACTOR}) on conflict do nothing`);
      }
    });
    await createMaterialBom({
      client, changedBy: ACTOR, materialNumber: 'CM-PL', plant: PLANT, usage: 'P', alternative: '01', status: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'CM-RAW', quantity: '1', unit: 'PC' }],
    });
    await createRouting({
      client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1', status: '1', routingGroup: '63000001', groupCounter: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01', assignments: [{ materialNumber: 'CM-PL' }],
      operations: [{ operationNumber: '0010', shortText: 'Make', workCenter: 'WC07', controlKey: 'PP01', standardValueKey: 'SV01', operationQuantity: '1', operationUnit: 'PC', baseQuantity: '1', baseUnit: 'PC', values: [{ parameter: 'MACH', quantity: '2', unit: 'MIN' }] }],
    });
    await createProductionVersion({
      client, changedBy: ACTOR, materialNumber: 'CM-PL', plant: PLANT, productionVersion: '0001', validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '63000001', groupCounter: '01',
    });
    await withTenant(client, async (tx) => {
      for (const [number, material, qty] of [['PL0000000001', 'CM-PL', 50], ['PL0000000002', 'CM-NOVER', 10]] as const) {
        await tx.execute(sql`
          insert into planned_order (client, order_number, material_number, plant, quantity, unit, start_date, finish_date, firming_status, origin, request_key, version, created_by)
          values (${client}, ${number}, ${material}, ${PLANT}, ${qty}, 'PC', '2026-06-10', '2026-06-12', 'OPEN', 'MRP', ${`cm-${number}`}, 1, ${ACTOR})`);
      }
    });

    const without = await report({ includePlannedOrders: false });
    expect(rowOf(without, 'WC07', 'MAC').total.required).toBe(0);
    const withPlanned = await report({ includePlannedOrders: true });
    expect(rowOf(withPlanned, 'WC07', 'MAC').total.required).toBe(100); // 2 min × 50 ÷ 1
    expect(rowOf(withPlanned, 'WC07', 'MAC').cells[1].required).toBe(100);
    expect(withPlanned.scanned.plannedOrders).toBe(1);
    const warning = withPlanned.warnings.find((w) => w.code === 'PLANNED_NO_VERSION')!;
    expect(warning.scope).toBe('HEADER');
    expect(warning.message).toContain('1 planned order');
    // The rest of the report is unaffected.
    expect(rowOf(withPlanned, 'WC01', 'MAC').total.required).toBe(225);
  });
});

describe('isolation and writes', () => {
  it('18. another tenant sees none of this client’s work centers or orders', async () => {
    const r = await loadCapacityReport({ client: other.client, plant: PLANT, dateFrom: FROM, dateTo: TO }, CAPS);
    expect(r.rows).toHaveLength(0);
    expect(r.scanned).toEqual({ workCenters: 0, orders: 0, plannedOrders: 0 });
  });

  it('writes nothing', async () => {
    const count = () => withTenant(client, async (tx) => ((await tx.execute(sql`
      select (select count(*) from production_order) + (select count(*) from work_center_capacity) + (select count(*) from change_document) as n`)) as unknown as Array<{ n: string }>)[0].n);
    const before = await count();
    await report({ includePlannedOrders: true });
    expect(await count()).toBe(before);
  });
});

describe('the mapping column on the work center', () => {
  it('19. the parameter round-trips through create, change and read', async () => {
    await center('WCRT', [cap('MAC', { standardValueParameter: 'MACH' })]);
    expect((await getWorkCenter(client, PLANT, 'WCRT'))!.capacities[0].standardValueParameter).toBe('MACH');
    const saved = (await getWorkCenter(client, PLANT, 'WCRT'))!;
    await changeWorkCenter({
      client, changedBy: ACTOR, plant: PLANT, workCenter: 'WCRT', category: 'MACH', description: 'WCRT', standardValueKey: 'SV01', version: saved.version,
      capacities: [cap('MAC', { standardValueParameter: 'LAB' })],
    });
    expect((await getWorkCenter(client, PLANT, 'WCRT'))!.capacities[0].standardValueParameter).toBe('LAB');
  });

  it('20. a parameter the key does not hold, or with no key at all, is refused', async () => {
    await expect(center('WCBAD', [cap('MAC', { standardValueParameter: 'NOPE' })])).rejects.toThrow(/Parameter NOPE is not defined for standard value key SV01/);
    await expect(center('WCBAD', [cap('MAC', { standardValueParameter: 'MACH' })], null)).rejects.toBeInstanceOf(WorkCenterError);
    await expect(center('WCBAD', [cap('MAC', { standardValueParameter: 'MACH' })], null)).rejects.toThrow(/needs a standard value key/);
  });
});
