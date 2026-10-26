/**
 * The controlling screens that lock an internal order must be enforced where the order is written —
 * CAIRN.md §24.
 *
 * Step 7 left these two screens as the remaining screens that take a change lock and then let the
 * action write anyway: the internal-order screen and the original-budget screen.
 * The budget screen also raises a question about identity — it locks `INTERNAL_ORDER/<order>`, not a
 * budget object — so these cases check both halves: the guard must refuse whoever was not granted the
 * row, and the key that decides must be the key both screens and the module's own advisory lock use,
 * so that a lock for one order cannot authorize a change of another, and the header editor and the
 * budget editor hold each other off on purpose.
 *
 * The real pages are rendered, the real actions are called, and `enqueue_entry` is read back.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { SessionContext } from '@/platform/auth/session';

// The pages are transformed to the classic runtime (`React.createElement`) because the project
// tsconfig keeps `jsx: "preserve"`; they are called directly, so that global is all they need.
vi.stubGlobal('React', React);

const request = vi.hoisted(() => ({ session: null as SessionContext | null }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/platform/auth/current', async (original) => {
  const actual = await original<typeof import('@/platform/auth/current')>();
  const { hasCapability } = await import('@/platform/auth/session');
  const resolve = async () => {
    if (!request.session) throw new Error('AUTH_REDIRECT');
    return request.session;
  };
  return {
    ...actual,
    // `can` stays the platform's own, so the capability sets below are judged by real
    // whole-segment matching. Only the cookie lookup is replaced.
    requireSession: vi.fn(resolve),
    requireCapability: vi.fn(async (capability: string) => {
      const resolved = await resolve();
      if (!hasCapability(resolved.user.capabilities, capability)) {
        throw new actual.AuthzError(capability, resolved.user.username);
      }
      return resolved;
    }),
  };
});

import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';
import { defineRange } from '@/platform/numbering';
import { derivePosition } from '@/platform/periods';
import { releaseChangeLock } from '@/platform/lock/enqueue';
import { controllingArea, controllingAreaCompany } from '@/modules/foundation/schema';
import {
  INTERNAL_ORDER_DISPLAY_CAPABILITY,
  INTERNAL_ORDER_MAINTAIN_CAPABILITY,
  createInternalOrder,
} from '@/modules/foundation/internal-order';
import {
  ORIGINAL_BUDGET_CHANGE_CAPABILITY,
  ORIGINAL_BUDGET_DISPLAY_CAPABILITY,
  assignOrderTypeBudgetProfile,
  getOriginalBudget,
  saveBudgetProfile,
} from '@/modules/foundation/internal-order-budget';
import { saveInternalOrderAction } from '@/app/controlling/internal-orders/actions';
import { saveOriginalBudgetAction } from '@/app/controlling/original-budget/actions';
import InternalOrdersPage from '@/app/controlling/internal-orders/page';
import OrderForm from '@/app/controlling/internal-orders/OrderForm';
import InternalOrderDisplayPage from '@/app/controlling/internal-order-display/page';
import OriginalBudgetPage from '@/app/controlling/original-budget/page';
import BudgetForm from '@/app/controlling/original-budget/BudgetForm';
import OriginalBudgetDisplayPage from '@/app/controlling/original-budget-display/page';

const ACTOR = 'CONTROLLING_LOCK_TEST';
const LOCK_OBJECT = 'INTERNAL_ORDER';

let tenant: TestTenant & { area: string; company: string; currency: string; variant: string };
let orderA = '';
let orderB = '';
let firstYear = 0;

/** Three real logins: two who may maintain orders and budgets, and one who may only look. */
const PEOPLE = {
  holder: { username: 'ko.holder', sessionId: 'ko-holder-session' },
  bidder: { username: 'ko.bidder', sessionId: 'ko-bidder-session' },
  watcher: { username: 'ko.watcher', sessionId: 'ko-watcher-session' },
} as const;

type Person = keyof typeof PEOPLE;

const CAPABILITIES: Record<Person, string[]> = {
  holder: [INTERNAL_ORDER_MAINTAIN_CAPABILITY, ORIGINAL_BUDGET_CHANGE_CAPABILITY],
  bidder: [INTERNAL_ORDER_MAINTAIN_CAPABILITY, ORIGINAL_BUDGET_CHANGE_CAPABILITY],
  watcher: [INTERNAL_ORDER_DISPLAY_CAPABILITY, ORIGINAL_BUDGET_DISPLAY_CAPABILITY],
};

function actingAs(person: Person): void {
  const { username, sessionId } = PEOPLE[person];
  request.session = {
    sessionId,
    user: {
      client: tenant.client, userId: `user-${username}`, username, fullName: username,
      email: null, mustChangePassword: false, capabilities: [...CAPABILITIES[person]],
    },
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    renewed: false,
  } as unknown as SessionContext;
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function orderPayload(orderNumber: string, description: string): FormData {
  return form({
    payload: JSON.stringify({
      orderNumber, orderType: 'IO01', description,
      controllingArea: tenant.area, companyCode: tenant.company,
      startDate: '2026-04-01', endDate: '2027-03-31',
      personResponsible: '', responsibleUser: '', costCenter: '', profitCenter: '',
      statistical: false, isPostingLocked: false, markedForDeletion: false,
    }),
  });
}

function newOrderPayload(description: string, requestKey: string): FormData {
  return form({
    payload: JSON.stringify({
      orderType: 'IO01', description,
      controllingArea: tenant.area, companyCode: tenant.company,
      startDate: '2026-04-01', endDate: '2027-03-31',
      personResponsible: '', responsibleUser: '', costCenter: '', profitCenter: '',
      statistical: false, sourceOrderNumber: '', requestKey,
    }),
  });
}

function budgetPayload(orderNumber: string, overallAmount: string, requestKey: string): FormData {
  return form({
    payload: JSON.stringify({
      orderNumber, documentDate: '2026-04-01', overallAmount,
      annual: [{ fiscalYear: firstYear, amount: overallAmount }],
      documentText: 'Step eight', requestKey,
    }),
  });
}

/**
 * The protected state of an order row. There is no revision column on this table, which is exactly why
 * the change lock is the only thing standing between two editors of an internal order: nothing else
 * would notice a lost update.
 */
async function orderRow(number: string) {
  const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select description, cost_center, profit_center, is_posting_locked, marked_for_deletion
      from internal_order
     where client = ${tenant.client} and order_number = ${number}
  `))) as unknown as Array<{
    description: string;
    cost_center: string | null;
    profit_center: string | null;
    is_posting_locked: boolean;
    marked_for_deletion: boolean;
  }>;
  return rows[0] ?? null;
}

async function enqueueRow(argument: string) {
  const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select owner_session_id, owner_user, transaction_code, mode
      from enqueue_entry
     where client = ${tenant.client} and lock_object = ${LOCK_OBJECT} and argument = ${argument}
  `))) as unknown as Array<{
    owner_session_id: string;
    owner_user: string;
    transaction_code: string | null;
    mode: string;
  }>;
  return rows[0] ?? null;
}

async function lockCount(): Promise<number> {
  const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select count(*)::int as count from enqueue_entry where client = ${tenant.client}
  `))) as unknown as Array<{ count: number }>;
  return rows[0]?.count ?? -1;
}

async function release(person: Person, argument: string): Promise<void> {
  await releaseChangeLock({ client: tenant.client, sessionId: PEOPLE[person].sessionId, lockObject: LOCK_OBJECT, argument });
}

type AnyElement = ReactElement<{ children?: ReactNode }>;

/** The props of the first element of `type` in the tree the page function returned. */
function propsOf(node: unknown, type: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as AnyElement;
  if (element.type === type) return element.props as Record<string, unknown>;
  return propsOf(element.props.children, type);
}

function orderParams(order: string): Promise<Record<string, string | string[] | undefined>> {
  return Promise.resolve({ order });
}

beforeAll(async () => {
  const created = await createTenant('controlling-lock-0');
  tenant = Object.assign(created, { area: '', company: '', currency: '', variant: '' });

  for (const person of Object.values(PEOPLE)) {
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into app_user
        (id, client, username, full_name, email, password_hash, is_active, is_locked, created_by)
      values (${`user-${person.username}`}, ${tenant.client}, ${person.username}, ${person.username},
              null, 'test-hash', true, false, 'TEST')
    `));
    // A live `user_session` row, because a lock is only honoured while its session is alive.
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into user_session (id, client, user_id, token_hash, issued_at, expires_at)
      values (${person.sessionId}, ${tenant.client}, ${`user-${person.username}`}, ${`token-${person.sessionId}`},
              now(), now() + interval '8 hours')
    `));
  }

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
    tenant.area = assignment.controllingArea;
    tenant.company = assignment.companyCode;
    tenant.currency = area.currency.trim();
    tenant.variant = area.fiscalYearVariant;
  });
  await saveBudgetProfile({
    client: tenant.client, changedBy: ACTOR, profileCode: 'BP01', description: 'Original budget',
    overallBudget: true, annualBudget: true, annualNotExceedOverall: true,
    availabilityControl: false, changeAllowed: true,
  });
  await assignOrderTypeBudgetProfile({ client: tenant.client, changedBy: ACTOR, orderType: 'IO01', profileCode: 'BP01' });
  const start = await withTenant(tenant.client, (tx) => derivePosition(tx, tenant.client, tenant.variant, '2026-04-01'));
  firstYear = start.fiscalYear;

  orderA = (await createInternalOrder({
    client: tenant.client, changedBy: ACTOR, orderType: 'IO01', description: 'Order as created',
    controllingArea: tenant.area, companyCode: tenant.company, startDate: '2026-04-01', endDate: '2027-03-31',
  })).orderNumber;
  orderB = (await createInternalOrder({
    client: tenant.client, changedBy: ACTOR, orderType: 'IO01', description: 'The other order',
    controllingArea: tenant.area, companyCode: tenant.company, startDate: '2026-04-01', endDate: '2027-03-31',
  })).orderNumber;
});

afterAll(async () => {
  await withTenant(tenant.client, (tx) => tx.execute(sql`delete from enqueue_entry where client = ${tenant.client}`));
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('the internal-order screen gets the order lock it takes enforced where the order is written', () => {
  it('grants change to the session the screen opened, and lets that save through', async () => {
    actingAs('holder');
    const page = await InternalOrdersPage({ searchParams: orderParams(orderA) });

    // Ownership, mode and the key are what decide the write; the transaction label the page stores on
    // the row is its own naming and is not restated here.
    expect(await enqueueRow(orderA)).toMatchObject({
      owner_session_id: PEOPLE.holder.sessionId,
      owner_user: PEOPLE.holder.username,
      mode: 'EXCLUSIVE',
    });
    expect(propsOf(page, OrderForm)).toMatchObject({ document: { orderNumber: orderA } });

    const before = await orderRow(orderA);
    const result = await saveInternalOrderAction({ ok: false }, orderPayload(orderA, 'Changed under the lock'));

    expect(result).toMatchObject({ ok: true });
    expect((await orderRow(orderA))?.description).toBe('Changed under the lock');
    // This table carries no revision column, so the lock is the only thing that could notice two
    // editors at once: the write the guard allowed is the one the screen asked for, and no other
    // field of the row moved.
    expect((await orderRow(orderA))?.marked_for_deletion).toBe(before?.marked_for_deletion);
    expect((await orderRow(orderA))?.cost_center).toBe(before?.cost_center);

    await release('holder', orderA);
    expect(await lockCount()).toBe(0);
  });

  it('refuses a change from a session that never took the order, and writes nothing', async () => {
    actingAs('bidder');
    const before = await orderRow(orderA);

    const result = await saveInternalOrderAction({ ok: false }, orderPayload(orderA, 'Written with no lock'));

    expect(result.ok).toBe(false);
    expect(result.message).toContain(`${LOCK_OBJECT} ${orderA} is not open for change in this session`);
    expect(await orderRow(orderA)).toEqual(before);
    expect(await lockCount()).toBe(0);
  });

  it('refuses a change of another order while this session holds one, because the key is the order', async () => {
    actingAs('holder');
    await InternalOrdersPage({ searchParams: orderParams(orderA) });
    try {
      const before = await orderRow(orderB);
      const result = await saveInternalOrderAction({ ok: false }, orderPayload(orderB, 'Authorized by the wrong lock'));

      expect(result.ok).toBe(false);
      expect(result.message).toContain(`${LOCK_OBJECT} ${orderB} is not open for change in this session`);
      expect(await orderRow(orderB)).toEqual(before);
      // The held lock is still exactly the one order it was taken for.
      expect(await enqueueRow(orderA)).toMatchObject({ owner_user: PEOPLE.holder.username });
      expect(await enqueueRow(orderB)).toBeNull();
    } finally {
      await release('holder', orderA);
    }
  });

  it('shows an order another session holds as display only, offers no form, and refuses the save', async () => {
    actingAs('holder');
    await InternalOrdersPage({ searchParams: orderParams(orderA) });
    try {
      actingAs('bidder');
      const contested = await InternalOrdersPage({ searchParams: orderParams(orderA) });

      expect(await enqueueRow(orderA)).toMatchObject({ owner_user: PEOPLE.holder.username });
      expect(propsOf(contested, OrderForm)).toBeNull();

      const before = await orderRow(orderA);
      const result = await saveInternalOrderAction({ ok: false }, orderPayload(orderA, 'Written over another session'));
      expect(result.ok).toBe(false);
      expect(result.message).toContain(`is being changed by ${PEOPLE.holder.username}`);
      expect(await orderRow(orderA)).toEqual(before);
    } finally {
      await release('holder', orderA);
    }
    expect(await lockCount()).toBe(0);
  });

  it('stops authorizing the moment the lock is released, and once its heartbeat has aged out', async () => {
    actingAs('holder');
    await InternalOrdersPage({ searchParams: orderParams(orderA) });
    const before = await orderRow(orderA);

    await release('holder', orderA);
    const afterRelease = await saveInternalOrderAction({ ok: false }, orderPayload(orderA, 'Written after releasing'));
    expect(afterRelease.ok).toBe(false);
    expect(afterRelease.message).toContain('is not open for change in this session');
    expect(await orderRow(orderA)).toEqual(before);

    // The screen takes the lock again, then goes quiet past the sweep window: the row is no longer
    // the holder's to write.
    await InternalOrdersPage({ searchParams: orderParams(orderA) });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update enqueue_entry set heartbeat_at = now() - interval '4 minutes'
       where client = ${tenant.client} and lock_object = ${LOCK_OBJECT} and argument = ${orderA}
    `));
    const afterSilence = await saveInternalOrderAction({ ok: false }, orderPayload(orderA, 'Written on a stale lock'));
    expect(afterSilence.ok).toBe(false);
    expect(await orderRow(orderA)).toEqual(before);

    await release('holder', orderA);
  });

  it('creates an order with no lock at all, as it always did', async () => {
    actingAs('bidder');
    const result = await saveInternalOrderAction({ ok: false }, newOrderPayload('Created with no lock', 'ko-lock-create-1'));

    expect(result).toMatchObject({ ok: true });
    expect(result.orderNumber).toMatch(/^IO/);
    expect(await lockCount()).toBe(0);
  });

  it('is refused by the action, not the screen, when the session cannot maintain orders at all', async () => {
    // The screen's own gate is not the boundary: a watcher who posts the form anyway is refused by the
    // capability the action now asks for, and the order is untouched.
    actingAs('watcher');
    const before = await orderRow(orderA);

    await expect(saveInternalOrderAction({ ok: false }, orderPayload(orderA, 'Written without authority')))
      .rejects.toThrow(new RegExp(`does not hold the authority ${INTERNAL_ORDER_MAINTAIN_CAPABILITY}`));

    expect(await orderRow(orderA)).toEqual(before);
    expect(await lockCount()).toBe(0);
  });
});

describe('the original-budget screen is held by the same order lock it takes', () => {
  it('grants change to the session the screen opened, and lets the budget document through', async () => {
    actingAs('holder');
    const page = await OriginalBudgetPage({ searchParams: orderParams(orderA) });

    expect(await enqueueRow(orderA)).toMatchObject({
      owner_session_id: PEOPLE.holder.sessionId,
      owner_user: PEOPLE.holder.username,
      mode: 'EXCLUSIVE',
    });
    expect(propsOf(page, BudgetForm)).toMatchObject({ budget: { orderNumber: orderA } });

    const result = await saveOriginalBudgetAction({ ok: false }, budgetPayload(orderA, '5000', 'ob-lock-1'));

    expect(result).toMatchObject({ ok: true });
    expect(result.documentNumber).toMatch(/^OB/);
    const view = await getOriginalBudget(tenant.client, orderA);
    expect(view?.overallAmount).toBe('5000.0000');
    expect(view?.documents.length).toBe(1);

    await release('holder', orderA);
    expect(await lockCount()).toBe(0);
  });

  it('refuses a budget for a session that never took the order, and leaves no document behind', async () => {
    actingAs('bidder');
    const before = await getOriginalBudget(tenant.client, orderA);

    const result = await saveOriginalBudgetAction({ ok: false }, budgetPayload(orderA, '9000', 'ob-nolock-1'));

    expect(result.ok).toBe(false);
    expect(result.message).toContain(`${LOCK_OBJECT} ${orderA} is not open for change in this session`);
    const after = await getOriginalBudget(tenant.client, orderA);
    expect(after?.documents.length).toBe(before?.documents.length ?? 0);
    expect(after?.overallAmount).toBe(before?.overallAmount ?? null);
    expect(await lockCount()).toBe(0);
  });

  it('is held off by the order header screen, which is why the key is the order', async () => {
    actingAs('holder');
    // The header screen locks the order itself, so the budget screen finds the order taken.
    await InternalOrdersPage({ searchParams: orderParams(orderA) });
    try {
      actingAs('bidder');
      const contested = await OriginalBudgetPage({ searchParams: orderParams(orderA) });
      expect(await enqueueRow(orderA)).toMatchObject({ owner_user: PEOPLE.holder.username });
      expect(propsOf(contested, BudgetForm)).toBeNull();

      const before = await getOriginalBudget(tenant.client, orderA);
      const result = await saveOriginalBudgetAction({ ok: false }, budgetPayload(orderA, '7000', 'ob-contended-1'));
      expect(result.ok).toBe(false);
      expect(result.message).toContain(`is being changed by ${PEOPLE.holder.username}`);
      expect((await getOriginalBudget(tenant.client, orderA))?.documents.length).toBe(before?.documents.length ?? 0);
    } finally {
      await release('holder', orderA);
    }
  });

  it('refuses a budget for an order the session has no lock on, even while it holds another', async () => {
    actingAs('holder');
    await OriginalBudgetPage({ searchParams: orderParams(orderA) });
    try {
      const result = await saveOriginalBudgetAction({ ok: false }, budgetPayload(orderB, '4000', 'ob-wronglock-1'));
      expect(result.ok).toBe(false);
      expect(result.message).toContain(`${LOCK_OBJECT} ${orderB} is not open for change in this session`);
      expect((await getOriginalBudget(tenant.client, orderB))?.documents.length ?? 0).toBe(0);
      expect(await enqueueRow(orderB)).toBeNull();
    } finally {
      await release('holder', orderA);
    }
  });
});

describe('the display screens stay out of the locking', () => {
  it('takes no lock for an order or a budget it only reads', async () => {
    actingAs('watcher');
    const order = await InternalOrderDisplayPage({ searchParams: orderParams(orderA) });
    const budget = await OriginalBudgetDisplayPage({ searchParams: orderParams(orderA) });

    expect(order).toBeTruthy();
    expect(budget).toBeTruthy();
    expect(await lockCount()).toBe(0);
    expect(await enqueueRow(orderA)).toBeNull();
  });
});
