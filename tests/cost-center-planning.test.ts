/**
 * Cost centre planning (KP06) — the write side of cost_center_plan.
 *
 * What is worth proving: a plan saved for a cost centre reads back and is what the actual/plan report
 * shows (asserted through the report, so both halves agree); an annual total spreads exactly; a save
 * replaces the selection; and every refusal is named — period, duplicate, validity, cost element,
 * precision, authority. Plan is plan: no journal is written.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { saveCostCenter } from '../src/modules/foundation/cost-center-definition';
import { calculateCostCenterReport, type CostCenterReportSelection } from '../src/modules/foundation/cost-center-report';
import {
  CostCenterPlanningError,
  planningGrid,
  saveCostCenterPlan,
  spreadAnnualTotal,
  type SaveCostCenterPlanInput,
} from '../src/modules/foundation/cost-center-planning';
import { configActivityStatus } from '@/platform/tables/registry';
import { controllingAreaCompany } from '@/modules/foundation/schema';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';

const ACTOR = 'KP06-TEST';
const REASON = 'KP06 automated test';
const YEAR = 2026;
let tenant: TestTenant | undefined;
let client = '';
let currency = 'USD';
let planner: FinanceActor;

async function expectRefusal(promise: Promise<unknown>, fragment: string | RegExp): Promise<CostCenterPlanningError> {
  try {
    await promise;
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(CostCenterPlanningError);
    expect((error as Error).message).toMatch(fragment);
    expect((error as CostCenterPlanningError).remedy).toBeTruthy();
    return error as CostCenterPlanningError;
  }
  throw new Error(`Expected a CostCenterPlanningError matching ${fragment}, nothing was thrown.`);
}

const twelve = (amount: string) => Array.from({ length: 12 }, (_, i) => ({ costElement: '400000', period: i + 1, amount }));

function save(over: Partial<SaveCostCenterPlanInput> = {}, actor: FinanceActor = planner) {
  return saveCostCenterPlan({
    client, changedBy: actor.username, controllingArea: 'A000', planVersion: '000', fiscalYear: YEAR,
    costCenter: 'CC1000', entries: twelve('1000.00'), reason: REASON, ...over,
  }, { authorization: actor.authorization });
}

function report(over: Partial<CostCenterReportSelection> = {}) {
  return calculateCostCenterReport({
    client,
    selection: {
      controllingArea: 'A000', costCenterGroup: '', costCenterFrom: 'CC1000', costCenterTo: 'CC1000',
      costElementFrom: '', costElementTo: '', fiscalYear: YEAR, periodFrom: 1, periodTo: 12, planVersion: '000', ...over,
    },
  });
}

beforeAll(async () => {
  tenant = await createTenant('kp06-planning');
  client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: YEAR });
  await withTenant(client, async (tx) => {
    for (const activityCode of ['CFG.COST.CONTROLLINGAREA.DEFINE', 'CFG.COST.COSTCENTER.DEFINE']) {
      await tx.insert(configActivityStatus)
        .values({ client, activityCode, status: 'COMPLETED', createdBy: ACTOR })
        .onConflictDoUpdate({ target: [configActivityStatus.client, configActivityStatus.activityCode], set: { status: 'COMPLETED', changedBy: ACTOR, changedAt: new Date() } });
    }
    await tx.insert(controllingAreaCompany).values({ client, controllingArea: 'A000', companyCode: '1000', createdBy: ACTOR }).onConflictDoNothing();
    const rows = (await tx.execute(sql`select currency from controlling_area where client = ${client} and controlling_area = 'A000'`)) as unknown as Array<{ currency: string }>;
    currency = String(rows[0]?.currency ?? 'USD').trim();
  });
  for (const [centre, from, to, name] of [
    ['CC1000', `${YEAR}-01-01`, `${YEAR}-12-31`, 'Production centre'],
    ['CC2000', `${YEAR}-01-01`, `${YEAR}-06-30`, 'Half-year centre'],
  ] as const) {
    await saveCostCenter({
      client, changedBy: ACTOR, mode: 'CREATE', controllingArea: 'A000', costCenter: centre, validFrom: from, validTo: to,
      name, personResponsible: '', category: 'PRODUCTION', companyCode: '1000', reason: REASON,
    });
  }
  planner = await createFinanceActor(client, { capabilities: ['CO.PLAN.COSTCENTER.MAINTAIN'] });
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

describe('spreadAnnualTotal (pure)', () => {
  const sum = (parts: string[]) => parts.reduce((s, p) => s + BigInt(p.replace('.', '').replace(/^(-?)0+(?=\d)/, '$1')), 0n);

  it('3. the parts sum exactly to the total', () => {
    for (const [total, n, d] of [['1000.00', 12, 2], ['12345.67', 12, 2], ['1', 7, 4], ['999.999', 12, 3], ['100', 16, 0]] as const) {
      const parts = spreadAnnualTotal(total, n, d);
      expect(parts).toHaveLength(n);
      expect(sum(parts)).toBe(BigInt(Number(total).toFixed(4).replace('.', '')));
    }
  });

  it('4. the remainder goes to the earliest periods', () => {
    expect(spreadAnnualTotal('1000.00', 12, 2)).toEqual([
      '83.3400', '83.3400', '83.3400', '83.3400', '83.3300', '83.3300', '83.3300', '83.3300', '83.3300', '83.3300', '83.3300', '83.3300',
    ]);
  });

  it('5. a negative total and a total smaller than the period count', () => {
    const negative = spreadAnnualTotal('-10.00', 3, 2);
    expect(negative).toEqual(['-3.3300', '-3.3300', '-3.3400']);
    expect(sum(negative)).toBe(-100000n);
    expect(spreadAnnualTotal('0.03', 12, 2)).toEqual(['0.0100', '0.0100', '0.0100', ...Array(9).fill('0.0000')]);
    expect(() => spreadAnnualTotal('abc', 12, 2)).toThrow(CostCenterPlanningError);
    expect(() => spreadAnnualTotal('100', 0, 2)).toThrow(CostCenterPlanningError);
  });
});

describe('saving and reading a plan', () => {
  it('1. a plan saved across twelve periods reads back identically', async () => {
    const result = await save({ entries: twelve('1000.00') });
    expect(result).toMatchObject({ changed: true, rows: 12 });
    const grid = await planningGrid({ client, controllingArea: 'A000', fiscalYear: YEAR, planVersion: '000', costCenter: 'CC1000' });
    expect(grid.plannedElements).toEqual(['400000']);
    for (let p = 1; p <= 12; p++) expect(grid.cells.get(`400000|${p}`)).toBe('1000.0000');
    expect(grid.context.currency).toBe(currency);
    const again = await save({ entries: twelve('1000.00') });
    expect(again.changed).toBe(false);
  });

  it('the grid saves back exactly as it reads (stored four-place values are exact amounts)', async () => {
    const grid = await planningGrid({ client, controllingArea: 'A000', fiscalYear: YEAR, planVersion: '000', costCenter: 'CC1000' });
    const entries = [...grid.cells.entries()].map(([key, amount]) => {
      const [costElement, period] = key.split('|');
      return { costElement: costElement!, period: Number(period), amount };
    });
    expect(entries[0]!.amount).toBe('1000.0000');
    expect((await save({ entries })).changed).toBe(false);
    // A spread total saves as it comes.
    const spread = spreadAnnualTotal('1000.00', 12, 2).map((amount, i) => ({ costElement: '400000', period: i + 1, amount }));
    expect((await save({ entries: spread })).rows).toBe(12);
    await save({ entries: twelve('1000.00') });
  });

  it('2. the report shows the plan, and its no-plan warning is gone', async () => {
    const result = await report();
    const element = result.rows.find((r) => r.kind === 'ELEMENT' && r.costCenter === 'CC1000' && r.costElement === '400000');
    expect(element?.plan).toBe(12000);
    expect(result.warnings.some((w) => /No plan data stands/.test(w))).toBe(false);
    const other = await report({ planVersion: '001' });
    expect(other.warnings.some((w) => /No plan data stands/.test(w))).toBe(true);
  });

  it('15. a revenue account may be planned', async () => {
    const result = await save({ entries: [...twelve('1000.00'), { costElement: '300000', period: 4, amount: '8000.00' }] });
    expect(result.rows).toBe(13);
    const fourth = await report({ periodFrom: 4, periodTo: 4 });
    expect(fourth.rows.find((r) => r.kind === 'ELEMENT' && r.costElement === '300000')?.plan).not.toBeNull();
  });

  it('6, 7. saving again replaces: a removed element loses its rows, a blank cell deletes its period', async () => {
    const entries = twelve('1000.00').map((e) => (e.period === 12 ? { ...e, amount: '' } : e));
    const result = await save({ entries });
    expect(result.rows).toBe(11);
    const grid = await planningGrid({ client, controllingArea: 'A000', fiscalYear: YEAR, planVersion: '000', costCenter: 'CC1000' });
    expect(grid.plannedElements).toEqual(['400000']);
    expect(grid.cells.has('400000|12')).toBe(false);
    expect(grid.cells.has('300000|4')).toBe(false);
    expect((await report()).rows.find((r) => r.kind === 'ELEMENT' && r.costElement === '400000')?.plan).toBe(11000);
  });

  it('14. a change record carries the reason and the before and after cells', async () => {
    await save({ entries: twelve('1000.00').map((e) => (e.period === 1 ? { ...e, amount: '1500.00' } : e)), reason: 'Raise January' });
    const docs = await withTenant(client, async (tx) => (await tx.execute(sql`
      select d.reason, i.field_name, i.old_value, i.new_value
        from change_document d join change_document_item i on i.change_document_id = d.id
       where d.client = ${client} and d.object_class = 'cost_center_plan' and d.reason = 'Raise January'`)) as unknown as Array<{ reason: string; field_name: string; old_value: string | null; new_value: string | null }>);
    expect(docs.find((d) => d.field_name === 'e400000p1')).toMatchObject({ old_value: expect.stringContaining('1000'), new_value: expect.stringContaining('1500') });
    expect(docs.find((d) => d.field_name === 'e400000p12')).toMatchObject({ new_value: expect.stringContaining('1000') });
  });

  it('a request key replayed for another selection is refused; for the same selection it is accepted', async () => {
    await save({ requestKey: 'kp06-form-1', entries: twelve('900.00') });
    await save({ requestKey: 'kp06-form-1', entries: twelve('900.00') });
    await expectRefusal(save({ requestKey: 'kp06-form-1', planVersion: '001' }), /already submitted for plan A000\/000\/2026\/CC1000/);
  });

  it('no journal is written by planning', async () => {
    const rows = await withTenant(client, async (tx) => (await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`)) as unknown as Array<{ n: number }>);
    expect(rows[0]!.n).toBe(0);
  });
});

describe('refusals', () => {
  it('8. a period the fiscal year variant does not define is refused, naming the variant', async () => {
    const original = await withTenant(client, async (tx) => {
      await tx.execute(sql`insert into fiscal_year_variant (client, variant, name, regular_periods, special_periods, created_by)
        values (${client}, 'Z6', 'Two-monthly', 6, 0, ${ACTOR}) on conflict do nothing`);
      for (let p = 1; p <= 6; p++) {
        await tx.execute(sql`insert into fiscal_year_period (client, variant, calendar_year, period, period_type, month, day, created_by)
          values (${client}, 'Z6', 0, ${p}, 'REGULAR', ${p * 2}, 31, ${ACTOR}) on conflict do nothing`);
      }
      const rows = (await tx.execute(sql`select fiscal_year_variant from controlling_area where client = ${client} and controlling_area = 'A000'`)) as unknown as Array<{ fiscal_year_variant: string }>;
      await tx.execute(sql`update controlling_area set fiscal_year_variant = 'Z6' where client = ${client} and controlling_area = 'A000'`);
      return rows[0]!.fiscal_year_variant;
    });
    try {
      const refusal = await expectRefusal(save({ entries: [{ costElement: '400000', period: 7, amount: '1.00' }] }), /period 7 is not defined by fiscal year variant Z6/);
      expect(refusal.message).toContain(String(YEAR));
    } finally {
      await withTenant(client, (tx) => tx.execute(sql`update controlling_area set fiscal_year_variant = ${original} where client = ${client} and controlling_area = 'A000'`));
    }
  });

  it('9. the same cost element and period twice is refused', async () => {
    await expectRefusal(save({ entries: [{ costElement: '400000', period: 3, amount: '1' }, { costElement: '400000', period: 3, amount: '2' }] }), /400000 is planned twice for period 3/);
  });

  it('10. a cost centre not valid in a planned period is refused, naming the period', async () => {
    await expectRefusal(save({ costCenter: 'CC2000', entries: twelve('10.00') }), /Cost Centre CC2000 is not valid in period 7/);
    // The grid submits every period: blank cells outside the centre's validity do not refuse the save.
    const halfYear = twelve('10.00').map((e) => (e.period > 6 ? { ...e, amount: '' } : e));
    expect((await save({ costCenter: 'CC2000', entries: halfYear })).rows).toBe(6);
    await expectRefusal(save({ costCenter: 'CC9999' }), /CC9999 does not stand in Controlling Area A000/);
  });

  it('11. a cost element in no reachable chart is refused, naming /config/chart-of-accounts', async () => {
    const refusal = await expectRefusal(save({ entries: [{ costElement: '999999', period: 1, amount: '1.00' }] }), /Cost Element 999999 was not found/);
    expect(refusal.remedy).toContain('/config/chart-of-accounts');
  });

  it('12. a blocked cost element is refused', async () => {
    await withTenant(client, (tx) => tx.execute(sql`update gl_account set is_blocked_posting = true where client = ${client} and account_number = '500200'`));
    try {
      await expectRefusal(save({ entries: [{ costElement: '500200', period: 1, amount: '1.00' }] }), /500200 is blocked for posting/);
    } finally {
      await withTenant(client, (tx) => tx.execute(sql`update gl_account set is_blocked_posting = false where client = ${client} and account_number = '500200'`));
    }
  });

  it('13. an amount with too many decimals for the currency is refused, naming the precision', async () => {
    const refusal = await expectRefusal(save({ entries: [{ costElement: '400000', period: 1, amount: '10.123' }] }), new RegExp(`than ${currency} carries \\(\\d\\)`));
    expect(refusal.message).toContain('decimal places');
    await expectRefusal(save({ entries: [{ costElement: '400000', period: 1, amount: '10.12345' }] }), /decimal places/);
    await expectRefusal(save({ entries: [{ costElement: '400000', period: 1, amount: '1,000' }] }), /is not a number/);
  });

  it('plan at least one period, and a reason, are required', async () => {
    await expectRefusal(save({ entries: [] }), /Plan at least one period/);
    await expectRefusal(save({ reason: '' }), /A reason is required/);
  });

  it('16. an actor without CO.PLAN.COSTCENTER.MAINTAIN is refused by the service', async () => {
    const clerk = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.POST'] });
    await expectRefusal(save({}, clerk), /CO\.PLAN\.COSTCENTER\.MAINTAIN/);
    await expectRefusal(saveCostCenterPlan({
      client, changedBy: 'nobody', controllingArea: 'A000', planVersion: '000', fiscalYear: YEAR, costCenter: 'CC1000', entries: twelve('1'), reason: REASON,
    }), /signed-in user/);
    const elsewhere = await createFinanceActor(client, { capabilities: ['CO.PLAN.COSTCENTER.MAINTAIN'], companyScopes: ['ZZZZ'] });
    await expectRefusal(save({}, elsewhere), /Company Code scope does not cover company code 1000/);
  });
});
