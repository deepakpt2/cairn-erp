/**
 * Activity price calculation (KSPI) — the price the activity-rate screen refuses to take by hand.
 *
 * What is worth proving: price = planned cost ÷ planned quantity × price unit, half-up to two
 * decimals, all of it fixed; ANNUAL writes one price into every row, PERIOD prices each period; the
 * residual is reported; manual types are skipped untouched; indicator 2, no output, negative cost, an
 * invalid period and a centre planning two types are refused by name; no row is invented; preview
 * writes nothing; the run is recorded; the service judges its own authority. Each scenario plans its
 * own version, so one refusal never blocks another case.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { saveCostCenter } from '../src/modules/foundation/cost-center-definition';
import { saveActivityRates } from '../src/modules/foundation/activity-rate-definition';
import {
  ActivityPriceError,
  calculateActivityPrices,
  computePrices,
  listCalculableActivities,
  previewActivityPrices,
  type CalculateInput,
} from '../src/modules/foundation/activity-price';
import { configActivityStatus } from '@/platform/tables/registry';
import { controllingAreaCompany } from '@/modules/foundation/schema';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';

const ACTOR = 'KSPI-TEST';
const REASON = 'KSPI automated test';
const YEAR = 2026;
let tenant: TestTenant | undefined;
let client = '';
let controller: FinanceActor;

async function expectRefusal(promise: Promise<unknown>, fragment: string | RegExp): Promise<ActivityPriceError> {
  try {
    await promise;
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(ActivityPriceError);
    expect((error as Error).message).toMatch(fragment);
    return error as ActivityPriceError;
  }
  throw new Error(`Expected an ActivityPriceError matching ${fragment}, nothing was thrown.`);
}

const input = (over: Partial<CalculateInput> = {}): CalculateInput => ({
  client, changedBy: controller.username, controllingArea: 'A000', planVersion: '000', fiscalYear: YEAR,
  periodFrom: 1, periodTo: 12, basis: 'ANNUAL', reason: REASON, ...over,
});
const calculate = (over: Partial<CalculateInput> = {}, actor: FinanceActor = controller) =>
  calculateActivityPrices({ ...input(over), changedBy: actor.username }, { authorization: actor.authorization });
const preview = (over: Partial<CalculateInput> = {}) => previewActivityPrices(input(over), { authorization: controller.authorization });

async function type(code: string, indicator: '1' | '2' | '3', validTo = `${YEAR}-12-31`, locked = false) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into activity_type (client, controlling_area, activity_type, valid_from, valid_to, name, activity_unit, category, price_indicator, is_posting_locked, created_by)
    values (${client}, 'A000', ${code}, ${`${YEAR}-01-01`}, ${validTo}, ${`Activity ${code}`}, 'H', '1', ${indicator}, ${locked}, ${ACTOR})`));
}

/** Rate rows for a pair in a version: quantity per period (null skips the period). */
async function rates(version: string, centre: string, activity: string, quantities: Array<string | null>, opts: { fixedPrice?: string; priceUnit?: number } = {}) {
  await withTenant(client, async (tx) => {
    for (const [i, q] of quantities.entries()) {
      if (q === null) continue;
      await tx.execute(sql`
        insert into activity_rate (client, controlling_area, plan_version, fiscal_year, period, cost_center, activity_type, planned_quantity, fixed_price, variable_price, price_unit, created_by)
        values (${client}, 'A000', ${version}, ${YEAR}, ${i + 1}, ${centre}, ${activity}, ${q}, ${opts.fixedPrice ?? '0'}, 0, ${opts.priceUnit ?? 1}, ${ACTOR})`);
    }
  });
}

/** Primary-cost plan for a centre in a version: amount per period, on expense element 400000. */
async function costs(version: string, centre: string, amounts: string[], element = '400000') {
  await withTenant(client, async (tx) => {
    for (const [i, a] of amounts.entries()) {
      await tx.execute(sql`
        insert into cost_center_plan (client, controlling_area, plan_version, fiscal_year, period, cost_center, cost_element, planned_amount, created_by)
        values (${client}, 'A000', ${version}, ${YEAR}, ${i + 1}, ${centre}, ${element}, ${a}, ${ACTOR})`);
    }
  });
}

async function storedPrices(version: string, centre: string, activity: string) {
  return withTenant(client, async (tx) => (await tx.execute(sql`
    select period, fixed_price::text as fixed, variable_price::text as variable, changed_by
      from activity_rate
     where client = ${client} and controlling_area = 'A000' and plan_version = ${version} and fiscal_year = ${YEAR}
       and cost_center = ${centre} and activity_type = ${activity}
     order by period`)) as unknown as Array<{ period: number; fixed: string; variable: string; changed_by: string | null }>);
}

const twelve = (v: string) => Array<string>(12).fill(v);

beforeAll(async () => {
  tenant = await createTenant('kspi-price');
  client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: YEAR });
  await withTenant(client, async (tx) => {
    for (const activityCode of ['CFG.COST.CONTROLLINGAREA.DEFINE', 'CFG.COST.COSTCENTER.DEFINE', 'CFG.COST.ACTIVITYTYPE.DEFINE']) {
      await tx.insert(configActivityStatus)
        .values({ client, activityCode, status: 'COMPLETED', createdBy: ACTOR })
        .onConflictDoUpdate({ target: [configActivityStatus.client, configActivityStatus.activityCode], set: { status: 'COMPLETED', changedBy: ACTOR, changedAt: new Date() } });
    }
    await tx.insert(controllingAreaCompany).values({ client, controllingArea: 'A000', companyCode: '1000', createdBy: ACTOR }).onConflictDoNothing();
  });
  for (const centre of ['CC1000', 'CC2000', 'CC3000', 'CC4000']) {
    await saveCostCenter({
      client, changedBy: ACTOR, mode: 'CREATE', controllingArea: 'A000', costCenter: centre, validFrom: `${YEAR}-01-01`, validTo: `${YEAR}-12-31`,
      name: `Centre ${centre}`, personResponsible: '', category: 'PRODUCTION', companyCode: '1000', reason: REASON,
    });
  }
  await type('LAB01', '1');
  await type('MACH1', '1');
  await type('MAN1', '3');
  await type('CAP1', '2');
  await type('HALF1', '1', `${YEAR}-06-30`);
  controller = await createFinanceActor(client, { capabilities: ['CO.PLAN.ACTIVITYPRICE.EXECUTE'] });

  // Version 000: the main scenario.
  await rates('000', 'CC1000', 'LAB01', twelve('100'), { priceUnit: 10 });        // 12,000 / 1,200 × 10 = 100.00
  await costs('000', 'CC1000', twelve('1000'));
  await rates('000', 'CC2000', 'MACH1', twelve('3'));                             // 1,300 / 36 = 36.11, residual
  await costs('000', 'CC2000', ['200', ...Array(11).fill('100')]);
  await rates('000', 'CC3000', 'MAN1', twelve('10'), { fixedPrice: '55.00' });    // manual, skipped
  await costs('000', 'CC3000', twelve('500'));
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

describe('computePrices (pure)', () => {
  it('rounds half-up once and reports the residual', () => {
    const result = computePrices({
      basis: 'ANNUAL',
      pairs: [{ costCenter: 'C', activityType: 'T', rangeCost: '100', rows: [1, 2, 3].map((period) => ({ period, plannedQuantity: '1', plannedCost: '33.3333', priceUnit: 1 })) }],
    });
    expect(result.iterations).toBe(1);
    expect(result.pairs[0]!.prices.map((p) => p.price)).toEqual(['33.33', '33.33', '33.33']);
    expect(result.pairs[0]!.residual).toBe('0.0100');
    expect(result.totalResidual).toBe('0.0100');
    // 0.005 rounds up.
    expect(computePrices({ basis: 'ANNUAL', pairs: [{ costCenter: 'C', activityType: 'T', rangeCost: '0.01', rows: [{ period: 1, plannedQuantity: '2', plannedCost: '0', priceUnit: 1 }] }] }).pairs[0]!.prices[0]!.price).toBe('0.01');
  });
});

describe('the calculation', () => {
  it('shows, before anything is pressed, what a run would do', async () => {
    const listed = await listCalculableActivities({ client, controllingArea: 'A000', fiscalYear: YEAR, planVersion: '000' }, { authorization: controller.authorization });
    expect(listed).toMatchObject({ periodFrom: 1, periodTo: 12 });
    expect(listed!.pairs.map((l) => [l.costCenter, l.activityType, l.status])).toEqual([
      ['CC1000', 'LAB01', 'CALCULATED'], ['CC2000', 'MACH1', 'CALCULATED'], ['CC3000', 'MAN1', 'SKIPPED'],
    ]);
    expect(listed!.pairs.find((l) => l.activityType === 'MAN1')!.reason).toMatch(/Manual price indicator/);
    // Without a range the listing judges the periods in which activity is planned.
    const p3 = await listCalculableActivities({ client, controllingArea: 'A000', fiscalYear: YEAR, planVersion: 'P3X' }, { authorization: controller.authorization });
    expect(p3).toMatchObject({ pairs: [] });
  });

  it('14. preview writes nothing', async () => {
    const view = await preview();
    expect(view.blocked).toBe(false);
    expect(view.pairs.find((p) => p.activityType === 'LAB01')!.newPrices[0]!.price).toBe('100.00');
    expect((await storedPrices('000', 'CC1000', 'LAB01')).every((r) => r.fixed === '0.00')).toBe(true);
  });

  it('1, 2, 8. ANNUAL: planned cost ÷ planned quantity × price unit, the same fixed price in every row, variable zero', async () => {
    const view = await calculate({ requestKey: 'kspi-run-1' });
    expect(view.written).toMatchObject({ rows: 24, changed: true });
    const lab = await storedPrices('000', 'CC1000', 'LAB01');
    expect(lab).toHaveLength(12);
    expect(lab.every((r) => r.fixed === '100.00' && r.variable === '0.00' && r.changed_by === controller.username)).toBe(true);
    const mach = await storedPrices('000', 'CC2000', 'MACH1');
    expect(new Set(mach.map((r) => r.fixed))).toEqual(new Set(['36.11']));
  });

  it('9. the residual is planned cost minus the priced output', async () => {
    const view = await preview();
    const mach = view.pairs.find((p) => p.activityType === 'MACH1')!;
    // 1,300 − 36.11 × 36 = 1,300 − 1,299.96 = 0.04
    expect(mach).toMatchObject({ cost: '1300.0000', quantity: '36.000', residual: '0.0400' });
    expect(view.pairs.find((p) => p.activityType === 'LAB01')!.residual).toBe('0.0000');
    expect(view.totalResidual).toBe('0.0400');
  });

  it('3. PERIOD prices each period on its own, and differs where inputs differ', async () => {
    const view = await calculate({ basis: 'PERIOD', periodFrom: 1, periodTo: 2 });
    const mach = view.pairs.find((p) => p.activityType === 'MACH1')!;
    expect(mach.newPrices).toEqual([{ period: 1, price: '66.67', priceUnit: 1 }, { period: 2, price: '33.33', priceUnit: 1 }]);
    const stored = await storedPrices('000', 'CC2000', 'MACH1');
    expect(stored.slice(0, 3).map((r) => r.fixed)).toEqual(['66.67', '33.33', '36.11']);
  });

  it('4, 12. a manual price is never overwritten', async () => {
    expect((await storedPrices('000', 'CC3000', 'MAN1')).every((r) => r.fixed === '55.00')).toBe(true);
  });

  it('15. a change record carries the reason and the before and after prices', async () => {
    const docs = await withTenant(client, async (tx) => (await tx.execute(sql`
      select d.reason, d.correlation_id, i.field_name, i.old_value, i.new_value
        from change_document d join change_document_item i on i.change_document_id = d.id
       where d.client = ${client} and d.object_class = 'activity_price_run' and d.correlation_id = 'kspi-run-1'`)) as unknown as Array<{ reason: string; field_name: string; old_value: string | null; new_value: string | null }>);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0]!.reason).toBe(REASON);
    expect(docs.find((d) => d.field_name === 'CC1000/LAB01/p1')).toMatchObject({ old_value: expect.stringContaining('0.00'), new_value: expect.stringContaining('100.00') });
    expect(docs.find((d) => d.field_name === 'totalResidual')?.new_value).toContain('0.04');
  });

  it('the planning screen accepts the calculated price coming back unchanged, and still refuses an entered one', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ period: i + 1, plannedQuantity: '100', fixedPrice: '100.00', variablePrice: '0.00', priceUnit: 10 }));
    await expect(saveActivityRates({ client, changedBy: ACTOR, controllingArea: 'A000', planVersion: '000', fiscalYear: YEAR, costCenter: 'CC1000', activityType: 'LAB01', entries, reason: 'Quantity unchanged' })).resolves.toBeTruthy();
    const typed = entries.map((e) => (e.period === 1 ? { ...e, fixedPrice: '99.00' } : e));
    await expect(saveActivityRates({ client, changedBy: ACTOR, controllingArea: 'A000', planVersion: '000', fiscalYear: YEAR, costCenter: 'CC1000', activityType: 'LAB01', entries: typed, reason: 'Typed price' }))
      .rejects.toThrow(/prices are calculated, not entered/);
  });
});

describe('refusals', () => {
  it('5. an activity type on indicator 2 is refused, naming the work centre’s missing cost centre', async () => {
    await rates('C2', 'CC4000', 'CAP1', twelve('10'));
    await costs('C2', 'CC4000', twelve('100'));
    await expectRefusal(calculate({ planVersion: 'C2' }), /price indicator 2 \(automatic on capacity\).*cost centre on the work centre master/);
  });

  it('6. a pair with zero planned quantity is refused, and no price is written', async () => {
    await rates('ZQ', 'CC1000', 'LAB01', twelve('0'));
    await costs('ZQ', 'CC1000', twelve('100'));
    await expectRefusal(calculate({ planVersion: 'ZQ' }), /CC1000 plans no output for activity type LAB01/);
    expect((await storedPrices('ZQ', 'CC1000', 'LAB01')).every((r) => r.fixed === '0.00')).toBe(true);
  });

  it('7. a negative planned cost is refused', async () => {
    await rates('NG', 'CC1000', 'LAB01', twelve('10'));
    await costs('NG', 'CC1000', twelve('-50'));
    await expectRefusal(calculate({ planVersion: 'NG' }), /CC1000 plans a negative cost of -600/);
  });

  it('10. an activity type not valid in one period of the range is refused, naming that period', async () => {
    await rates('IV', 'CC1000', 'HALF1', twelve('10'));
    await costs('IV', 'CC1000', twelve('100'));
    await expectRefusal(calculate({ planVersion: 'IV' }), /HALF1 is not valid in period 7/);
    expect((await preview({ planVersion: 'IV', periodTo: 6 })).blocked).toBe(false);
  });

  it('11. a run with nothing calculable is refused', async () => {
    await rates('MN', 'CC3000', 'MAN1', twelve('10'), { fixedPrice: '20.00' });
    await expectRefusal(calculate({ planVersion: 'MN' }), /Nothing to calculate: no cost centre plans output against an automatic activity type/);
  });

  it('a cost centre planning two activity types is refused as ambiguous', async () => {
    await rates('AM', 'CC1000', 'LAB01', twelve('10'));
    await rates('AM', 'CC1000', 'MAN1', twelve('10'), { fixedPrice: '5.00' });
    await costs('AM', 'CC1000', twelve('100'));
    await expectRefusal(calculate({ planVersion: 'AM' }), /CC1000 plans more than one activity type \(LAB01, MAN1\)/);
  });

  it('a centre with no primary-cost plan is refused rather than priced at zero', async () => {
    await rates('NC', 'CC2000', 'MACH1', twelve('10'));
    await expectRefusal(calculate({ planVersion: 'NC' }), /CC2000 has no primary-cost plan/);
  });

  it('13. no activity_rate row is created for a period the pair never planned', async () => {
    await rates('P3', 'CC1000', 'LAB01', ['10', '10', '10', ...Array<null>(9).fill(null)]);
    await costs('P3', 'CC1000', twelve('100'));
    const view = await calculate({ planVersion: 'P3' });
    expect(view.written?.rows).toBe(3);
    expect(await storedPrices('P3', 'CC1000', 'LAB01')).toHaveLength(3);
    // The range's whole cost (1,200) over the planned output (30): 40.00 into the three rows.
    expect((await storedPrices('P3', 'CC1000', 'LAB01')).map((r) => r.fixed)).toEqual(['40.00', '40.00', '40.00']);
  });

  it('a period the variant does not define, and a missing reason, are refused', async () => {
    await expectRefusal(calculate({ periodTo: 17 }), /between 1 and 16/);
    await expectRefusal(calculate({ reason: '' }), /A reason is required/);
    await expectRefusal(calculate({ controllingArea: 'ZZ99' }), /Controlling Area ZZ99 is not defined/);
  });

  it('16. an actor without CO.PLAN.ACTIVITYPRICE.EXECUTE is refused by the service', async () => {
    const clerk = await createFinanceActor(client, { capabilities: ['CO.PLAN.COSTCENTER.MAINTAIN'] });
    await expectRefusal(calculate({}, clerk), /CO\.PLAN\.ACTIVITYPRICE\.EXECUTE/);
    await expectRefusal(previewActivityPrices(input()), /signed-in user/);
    const elsewhere = await createFinanceActor(client, { capabilities: ['CO.PLAN.ACTIVITYPRICE.EXECUTE'], companyScopes: ['ZZZZ'] });
    await expectRefusal(calculate({}, elsewhere), /Company Code scope does not cover company code 1000/);
  });
});
