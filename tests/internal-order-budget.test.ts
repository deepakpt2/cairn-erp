import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { derivePosition } from '../src/platform/periods';
import { closeDb, createTenant, destroyTenant } from './helpers';
import { controllingArea, controllingAreaCompany } from '../src/modules/foundation/schema';
import { changeInternalOrder, createInternalOrder } from '../src/modules/foundation/internal-order';
import {
  assignOrderTypeBudgetProfile,
  changeOriginalBudget,
  getOriginalBudget,
  InternalOrderBudgetError,
  saveBudgetProfile,
} from '../src/modules/foundation/internal-order-budget';
import { displayOriginalBudget } from '../src/modules/foundation/internal-order-budget-display';

const ACTOR = 'BUDGET_TEST';
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
  variant: string;
}

async function standing(seed: string): Promise<Place> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  const place = tenant as Place;
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, { client: tenant.client, objectCode: 'INTORDER', subObject: '*', prefix: 'IO', numberLength: 8, createdBy: ACTOR });
    await defineRange(tx, { client: tenant.client, objectCode: 'ORDBUDGET', subObject: '*', prefix: 'OB', numberLength: 8, createdBy: ACTOR });
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
    place.area = assignment.controllingArea;
    place.company = assignment.companyCode;
    place.currency = area.currency.trim();
    place.variant = area.fiscalYearVariant;
  });
  return place;
}

function order(tenant: Place) {
  return {
    client: tenant.client,
    changedBy: ACTOR,
    orderType: 'IO01',
    description: 'Plant overhead',
    controllingArea: tenant.area,
    companyCode: tenant.company,
    startDate: '2026-04-01',
    endDate: '2027-03-31',
  };
}

async function profile(tenant: Place, changeAllowed = true) {
  await saveBudgetProfile({
    client: tenant.client,
    changedBy: ACTOR,
    profileCode: 'BP01',
    description: 'Original budget',
    overallBudget: true,
    annualBudget: true,
    annualNotExceedOverall: true,
    availabilityControl: false,
    changeAllowed,
  });
  await assignOrderTypeBudgetProfile({
    client: tenant.client,
    changedBy: ACTOR,
    orderType: 'IO01',
    profileCode: 'BP01',
  });
}

async function span(tenant: Place) {
  return withTenant(tenant.client, async (tx) => {
    const start = await derivePosition(tx, tenant.client, tenant.variant, '2026-04-01');
    const end = await derivePosition(tx, tenant.client, tenant.variant, '2027-03-31');
    return { first: Math.min(start.fiscalYear, end.fiscalYear), last: Math.max(start.fiscalYear, end.fiscalYear) };
  });
}

describe('original budget', () => {
  it('saves an original budget document and does not post', async () => {
    const tenant = await standing('ko22-save');
    await profile(tenant);
    const saved = await createInternalOrder(order(tenant));
    const years = await span(tenant);
    const before = await withTenant(tenant.client, async (tx) => {
      const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${tenant.client}`) as unknown as Array<{ n: number }>;
      const [header] = await tx.execute(sql`
        select changed_at from internal_order where client = ${tenant.client} and order_number = ${saved.orderNumber}
      `) as unknown as Array<{ changed_at: Date | null }>;
      return { journals: Number(journals.n), changedAt: header.changed_at };
    });
    const document = await changeOriginalBudget({
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber: saved.orderNumber,
      documentDate: '2026-04-01',
      overallAmount: '10000',
      annual: [{ fiscalYear: years.first, amount: '4000' }],
      requestKey: 'walk-1',
    });
    expect(document.documentNumber).toMatch(/^OB/);
    const replay = await changeOriginalBudget({
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber: saved.orderNumber,
      documentDate: '2026-04-01',
      overallAmount: '1',
      requestKey: 'walk-1',
    });
    expect(replay.documentNumber).toBe(document.documentNumber);
    const view = await getOriginalBudget(tenant.client, saved.orderNumber);
    expect(view?.overallAmount).toBe('10000.0000');
    expect(view?.annual).toEqual([{ fiscalYear: years.first, amount: '4000.0000' }]);
    expect(view?.currency).toBe(tenant.currency);
    expect(view?.currentBudgetCalculated).toBe(false);
    expect(view?.availabilityControlExecuted).toBe(false);
    const after = await withTenant(tenant.client, async (tx) => {
      const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${tenant.client}`) as unknown as Array<{ n: number }>;
      const [header] = await tx.execute(sql`
        select changed_at from internal_order where client = ${tenant.client} and order_number = ${saved.orderNumber}
      `) as unknown as Array<{ changed_at: Date | null }>;
      const [count] = await tx.execute(sql`
        select count(*)::int as n from internal_order_original_budget where client = ${tenant.client}
      `) as unknown as Array<{ n: number }>;
      return { journals: Number(journals.n), changedAt: header.changed_at, documents: Number(count.n) };
    });
    expect(after.journals).toBe(before.journals);
    expect(after.changedAt).toEqual(before.changedAt);
    expect(after.documents).toBe(1);
  });

  it('refuses an annual total above the overall budget and keeps the earlier document', async () => {
    const tenant = await standing('ko22-over');
    await profile(tenant);
    const saved = await createInternalOrder(order(tenant));
    const years = await span(tenant);
    const first = await changeOriginalBudget({
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber: saved.orderNumber,
      documentDate: '2026-04-01',
      overallAmount: '10000',
      annual: [{ fiscalYear: years.first, amount: '4000' }],
    });
    await expect(changeOriginalBudget({
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber: saved.orderNumber,
      documentDate: '2026-04-01',
      overallAmount: '10000',
      annual: [{ fiscalYear: years.first, amount: '11000' }],
    })).rejects.toThrow(/exceeds the overall/);
    await expect(changeOriginalBudget({
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber: saved.orderNumber,
      documentDate: '2026-04-01',
      overallAmount: '10000',
      annual: [{ fiscalYear: 1990, amount: '1' }],
    })).rejects.toThrow(/outside the order validity/);
    const second = await changeOriginalBudget({
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber: saved.orderNumber,
      documentDate: '2026-05-01',
      overallAmount: '8000',
    });
    const view = await getOriginalBudget(tenant.client, saved.orderNumber);
    expect(view?.overallAmount).toBe('8000.0000');
    expect(view?.annual).toEqual([{ fiscalYear: years.first, amount: '4000.0000' }]);
    const original = view?.documents.find((row) => row.documentNumber === first.documentNumber);
    expect(original?.overallAmount).toBe('10000.0000');
    expect(second.documentNumber).not.toBe(first.documentNumber);
  });

  it('refuses a missing profile, a foreign currency, a marked order, and a restricted profile', async () => {
    const tenant = await standing('ko22-bad');
    const saved = await createInternalOrder(order(tenant));
    await expect(changeOriginalBudget({
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber: saved.orderNumber,
      documentDate: '2026-04-01',
      overallAmount: '10',
    })).rejects.toThrow(/No budget profile/);
    await profile(tenant, false);
    await expect(changeOriginalBudget({
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber: saved.orderNumber,
      documentDate: '2026-04-01',
      overallAmount: '10',
    })).rejects.toThrow(/does not allow a change/);
    await saveBudgetProfile({
      client: tenant.client,
      changedBy: ACTOR,
      profileCode: 'BP01',
      description: 'Original budget',
      overallBudget: true,
      annualBudget: true,
      annualNotExceedOverall: true,
      changeAllowed: true,
    });
    await expect(changeOriginalBudget({
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber: saved.orderNumber,
      documentDate: '2026-04-01',
      overallAmount: '10',
      currency: tenant.currency === 'USD' ? 'INR' : 'USD',
    })).rejects.toThrow(/order currency/);
    await changeInternalOrder({ ...order(tenant), orderNumber: saved.orderNumber, markedForDeletion: true });
    await expect(changeOriginalBudget({
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber: saved.orderNumber,
      documentDate: '2026-04-01',
      overallAmount: '10',
    })).rejects.toThrow(/marked for deletion/);
  });

  it('displays without writing, and does not cross clients', async () => {
    const tenant = await standing('ko23-show');
    const other = await standing('ko23-hide');
    await profile(tenant);
    const saved = await createInternalOrder(order(tenant));
    await changeOriginalBudget({
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber: saved.orderNumber,
      documentDate: '2026-04-01',
      overallAmount: '2500',
    });
    const before = await getOriginalBudget(tenant.client, saved.orderNumber);
    const shown = await displayOriginalBudget({ client: tenant.client, orderNumber: saved.orderNumber });
    expect(shown.overallAmount).toBe('2500.0000');
    await expect(displayOriginalBudget({
      client: tenant.client,
      orderNumber: saved.orderNumber,
      overallAmount: '9',
    })).rejects.toThrow(/does not accept a change/);
    const after = await getOriginalBudget(tenant.client, saved.orderNumber);
    expect(after?.overallAmount).toBe(before?.overallAmount);
    expect(after?.documents[0].createdAt).toBe(before?.documents[0].createdAt);
    await expect(getOriginalBudget(other.client, saved.orderNumber)).resolves.toBeNull();
  });

  it('does not create two documents for the same request', async () => {
    const tenant = await standing('ko22-pair');
    await profile(tenant);
    const saved = await createInternalOrder(order(tenant));
    const input = {
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber: saved.orderNumber,
      documentDate: '2026-04-01',
      overallAmount: '15',
      requestKey: 'same-run',
    };
    const [left, right] = await Promise.all([
      changeOriginalBudget(input),
      changeOriginalBudget(input),
    ]);
    expect(left.documentNumber).toBe(right.documentNumber);
    const [count] = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as n from internal_order_original_budget where client = ${tenant.client}
    `) as unknown as Array<{ n: number }>);
    expect(Number(count.n)).toBe(1);
  });
});
