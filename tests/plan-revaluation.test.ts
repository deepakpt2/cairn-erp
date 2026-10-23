import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { closeDb, createTenant, destroyTenant } from './helpers';
import { controllingArea, controllingAreaCompany, fiscalYearVariant } from '../src/modules/foundation/schema';
import { changeInternalOrder, createInternalOrder } from '../src/modules/foundation/internal-order';
import {
  createPlanRevaluationOrder,
  getPlanRevaluationOrder,
  PlanRevaluationError,
  planRevaluationEligibility,
} from '../src/modules/foundation/plan-revaluation';

const ACTOR = 'REVAL_TEST';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

interface Place {
  client: string;
  companyCode: string;
  currency: string;
  area: string;
  company: string;
  periods: number;
}

async function standing(seed: string): Promise<Place> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  const place = tenant as Place;
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, { client: tenant.client, objectCode: 'INTORDER', subObject: '*', prefix: 'IO', numberLength: 8, createdBy: ACTOR });
    await defineRange(tx, { client: tenant.client, objectCode: 'REVALORD', subObject: '*', prefix: 'RV', numberLength: 8, createdBy: ACTOR });
    await tx.execute(sql`
      insert into internal_order_type (
        client, order_type, description, number_range_sub_object, statistical_default, created_by
      ) values (${tenant.client}, 'IO01', 'Internal order', '*', false, ${ACTOR})
      on conflict do nothing
    `);
    const [assignment] = await tx.select().from(controllingAreaCompany).where(eq(controllingAreaCompany.client, tenant.client));
    const [area] = await tx.select().from(controllingArea).where(and(
      eq(controllingArea.client, tenant.client),
      eq(controllingArea.controllingArea, assignment.controllingArea),
    ));
    const [variant] = await tx.select().from(fiscalYearVariant).where(and(
      eq(fiscalYearVariant.client, tenant.client),
      eq(fiscalYearVariant.variant, area.fiscalYearVariant),
    ));
    place.area = assignment.controllingArea;
    place.company = assignment.companyCode;
    place.currency = area.currency.trim();
    place.periods = variant.regularPeriods;
  });
  return place;
}

function order(tenant: Place, description = 'Plant overhead') {
  return {
    client: tenant.client,
    changedBy: ACTOR,
    orderType: 'IO01',
    description,
    controllingArea: tenant.area,
    companyCode: tenant.company,
    startDate: '2026-04-01',
    endDate: '2027-03-31',
  };
}

function definition(tenant: Place, orderNumber: string) {
  return {
    client: tenant.client,
    changedBy: ACTOR,
    controllingArea: tenant.area,
    fiscalYear: 2026,
    periodFrom: 1,
    periodTo: 1,
    planVersion: '000',
    description: 'Plan revaluation',
    orderFrom: orderNumber,
    orderTo: orderNumber,
  };
}

async function counts(client: string) {
  return withTenant(client, async (tx) => {
    const [plans] = await tx.execute(sql`select count(*)::int as n from cost_center_plan where client = ${client}`) as unknown as Array<{ n: number }>;
    const [budgets] = await tx.execute(sql`select count(*)::int as n from internal_order_original_budget where client = ${client}`) as unknown as Array<{ n: number }>;
    const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
    const [orders] = await tx.execute(sql`select count(*)::int as n from internal_order where client = ${client}`) as unknown as Array<{ n: number }>;
    return {
      plans: Number(plans.n),
      budgets: Number(budgets.n),
      journals: Number(journals.n),
      orders: Number(orders.n),
    };
  });
}

describe('plan revaluation definition', () => {
  it('saves a definition and does not revalue plan data', async () => {
    const tenant = await standing('kop1-save');
    const saved = await createInternalOrder(order(tenant));
    const before = await counts(tenant.client);
    const created = await createPlanRevaluationOrder({
      ...definition(tenant, saved.orderNumber),
      requestKey: 'walk-1',
    });
    expect(created.revaluationNumber).toMatch(/^RV/);
    expect(created.executed).toBe(false);
    expect(created.orders).toEqual([saved.orderNumber]);
    const replay = await createPlanRevaluationOrder({
      ...definition(tenant, saved.orderNumber),
      requestKey: 'walk-1',
      description: 'Changed on retry',
    });
    expect(replay.revaluationNumber).toBe(created.revaluationNumber);
    const stored = await getPlanRevaluationOrder(tenant.client, created.revaluationNumber);
    expect(stored?.description).toBe('Plan revaluation');
    expect(stored?.fiscalYear).toBe(2026);
    expect(stored?.planVersion).toBe('000');
    expect(stored?.currency).toBe(tenant.currency);
    expect(stored?.executionStatus).toBe('NOT_EXECUTED');
    expect(stored?.executable).toBe(false);
    expect(planRevaluationEligibility().executable).toBe(false);
    expect(await counts(tenant.client)).toEqual(before);
  });

  it('refuses a typed number, a period outside the variant, a missing order, and a foreign currency', async () => {
    const tenant = await standing('kop1-bad');
    const saved = await createInternalOrder(order(tenant));
    await expect(createPlanRevaluationOrder({
      ...definition(tenant, saved.orderNumber),
      revaluationNumber: 'RV00000099',
    })).rejects.toThrow(/typed number/i);
    await expect(createPlanRevaluationOrder({
      ...definition(tenant, saved.orderNumber),
      periodTo: tenant.periods + 1,
    })).rejects.toThrow(/Periods must run/);
    await expect(createPlanRevaluationOrder({
      ...definition(tenant, 'IO00000999'),
    })).rejects.toThrow(/does not exist/);
    await expect(createPlanRevaluationOrder({
      ...definition(tenant, saved.orderNumber),
      currency: tenant.currency === 'USD' ? 'INR' : 'USD',
    })).rejects.toBeInstanceOf(PlanRevaluationError);
    await expect(createPlanRevaluationOrder({
      ...definition(tenant, saved.orderNumber),
      planVersion: '',
    })).rejects.toBeInstanceOf(PlanRevaluationError);
  });

  it('excludes a marked order and does not cross clients', async () => {
    const tenant = await standing('kop1-mark');
    const other = await standing('kop1-hide');
    const saved = await createInternalOrder(order(tenant));
    await changeInternalOrder({ ...order(tenant), orderNumber: saved.orderNumber, markedForDeletion: true });
    await expect(createPlanRevaluationOrder(definition(tenant, saved.orderNumber))).rejects.toThrow(/marked for deletion/);
    await expect(getPlanRevaluationOrder(other.client, 'RV00000001')).resolves.toBeNull();
  });

  it('does not create two definitions for the same request', async () => {
    const tenant = await standing('kop1-pair');
    const saved = await createInternalOrder(order(tenant));
    const input = { ...definition(tenant, saved.orderNumber), requestKey: 'same-run' };
    const [left, right] = await Promise.all([
      createPlanRevaluationOrder(input),
      createPlanRevaluationOrder(input),
    ]);
    expect(left.revaluationNumber).toBe(right.revaluationNumber);
    const [count] = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as n from plan_revaluation_order where client = ${tenant.client}
    `) as unknown as Array<{ n: number }>);
    expect(Number(count.n)).toBe(1);
  });
});
