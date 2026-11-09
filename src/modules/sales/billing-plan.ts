/**
 * When an item is billed — the billing plan (SAP FPLA and FPLT).
 *
 * A delivery earns an invoice when its goods go out, and that is the only way this package has ever
 * billed. It is the right answer for goods and no answer at all for everything else: a year of
 * maintenance, a piece of work paid in three stages, a licence renewed every quarter. None of them is
 * delivered.
 *
 * A plan hangs off an order item and is made of dates, each carrying a share of the item's value and
 * the day it falls due. It is not a reminder and not a report: the plan *is* the billing schedule. An
 * item that carries one is billed by its dates and not by its deliveries, and the two are never both
 * — a share of an item and the whole of it are two different answers to one question, and an order
 * that answered it twice would invoice the same value twice.
 *
 * Three things are held to here.
 *
 * The shares total a hundred. A plan that promises ninety has not said when the last tenth is
 * billed, and a plan that promises a hundred and ten has promised money the order does not carry.
 *
 * A date is billed once, and only on or after the day it names. A plan is a promise about a day; the
 * day is the point of it.
 *
 * And a date is withdrawn rather than deleted. A plan is part of what was agreed about an order, and
 * an order whose plan changed twice was agreed three times. A tenant that stops wanting a date does
 * not get to pretend it never stood — for the same reason an order line is rejected rather than
 * removed and a partner function withdrawn rather than erased.
 *
 * Every date carries what it does with its share: bill it, or ask the customer for it as an advance
 * before anything is delivered. The line is drawn at the date and not at the plan type, because one
 * plan asks for an advance on one date and bills the whole of the item on another — and an advance is
 * money asked early, not a share of the billing schedule, so the dates that invoice still total a
 * hundred and the dates that ask stand outside them.
 */
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { salesOrder, salesOrderLine } from './schema';
import {
  BILLING_PLAN_DATE_RULES, BILLING_PLAN_DATE_STATUSES, type BillingPlanDateRule,
  salesBillingPlan, salesBillingPlanDate, salesBillingPlanType,
} from './schema';

export const BILLING_PLAN_ROUTE = '/sales/billing-plans';
export const BILLING_PLAN_CAPABILITY = 'SALES.BILLING_PLAN.MAINTAIN';
export const BILLING_PLAN_OBJECT_CLASS = 'sales_billing_plan';

export class BillingPlanError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'BillingPlanError';
    this.remedy = remedy;
  }
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');

export const billingPlanDateInput = z.object({
  /**
   * Present to address a date that already stands; absent on one being added. Dates are numbered in
   * tens, and the number a date carries is the number it keeps — so a document that named date 20
   * still names the same date after the plan has been changed around it.
   */
  dateNumber: z.union([z.undefined(), z.coerce.number().int().positive()]),
  billingDate: isoDate,
  /** The share of the item's value this date bills, as a percentage. */
  percentage: z.coerce.number().gt(0).max(100),
  /**
   * What the date does with that share: `DOWN_PAYMENT` asks the customer for it as an advance before
   * anything is delivered; `INVOICE` — which is what is meant where nothing is named, and is what
   * every date has always done — bills it.
   */
  billingRule: z.union([z.undefined(), z.enum(BILLING_PLAN_DATE_RULES)]),
});

export const billingPlanSaveInput = z.object({
  client: z.string().trim().length(4),
  changedBy: z.string().trim().min(1).max(60),
  orderNumber: z.string().trim().toUpperCase().pipe(z.string().min(1).max(20)),
  orderLineNumber: z.coerce.number().int().positive(),
  planType: z.string().trim().toUpperCase().pipe(z.string().min(1).max(2)),
  dates: z.array(billingPlanDateInput).min(1).max(99),
  reason: z.string().trim().min(3).max(500),
  /** Present only when the plan already stands, and read under the version the screen opened. */
  expectedVersion: z.union([z.undefined(), z.coerce.number().int().nonnegative()]),
  requestKey: z.union([z.undefined(), z.string().trim().min(1).max(64)]),
});

export type BillingPlanSaveInput = z.infer<typeof billingPlanSaveInput>;

export interface BillingPlanDateView {
  dateNumber: number;
  billingDate: string;
  percentage: number;
  /** What this date does with its share: bill it, or ask for it in advance. */
  billingRule: BillingPlanDateRule;
  status: (typeof BILLING_PLAN_DATE_STATUSES)[number];
  billingNumber: string | null;
}

export interface BillingPlanView {
  orderNumber: string;
  orderLineNumber: number;
  materialNumber: string;
  planType: string;
  planTypeName: string;
  version: number;
  /**
   * The shares of the dates that invoice, as a percentage. A hundred on a complete plan. The dates
   * that ask for an advance stand outside this total: the money is asked for early, and the invoice
   * still bills the whole.
   */
  totalPercentage: number;
  /** The shares of the dates that ask for an advance, as a percentage. Never more than a hundred. */
  totalDownPaymentPercentage: number;
  dates: BillingPlanDateView[];
}

export interface BillingPlanTypeRow {
  planType: string;
  displayName: string;
  meaning: string;
}

/** The key an order item is known by, wherever a set of items is looked up at once. */
export const itemKey = (orderNumber: string, orderLineNumber: number) => `${orderNumber}|${orderLineNumber}`;

export interface StandingPlan {
  planType: string;
  /**
   * The earliest *invoice* date of the plan that still stands open, and its number. Null where the
   * plan asks only for advances, or where every invoice date has been billed: such a plan does not
   * say when the item is billed next, and whether the item may be billed by delivery at all is
   * `hasInvoiceDates`, not this.
   */
  dateNumber: number | null;
  nextDate: string | null;
  /**
   * True where the plan carries an invoice date that answers — one that was not withdrawn. Such an
   * item is billed by its plan and not by its deliveries, whether the date has been billed or not: a
   * plan that has settled an item has still settled it. A plan that asks only for advances leaves the
   * item to its deliveries, and the advance is settled against the invoice those deliveries earn.
   */
  hasInvoiceDates: boolean;
}

/**
 * The plans that stand for a set of order items, in one read.
 *
 * Called from the billing service, which has to refuse a delivery whose items are billed by a plan
 * rather than by what was delivered. One query for every item named, because a refusal that costs a
 * query per line is a refusal that tempts somebody to skip it.
 */
export async function plansForItems(
  tx: Tx,
  client: string,
  items: Array<{ orderNumber: string; orderLineNumber: number }>,
): Promise<Map<string, StandingPlan>> {
  const found = new Map<string, StandingPlan>();
  if (items.length === 0) return found;
  const rows = await tx.select({
    orderNumber: salesBillingPlan.orderNumber,
    orderLineNumber: salesBillingPlan.orderLineNumber,
    planType: salesBillingPlan.planType,
    dateNumber: salesBillingPlanDate.dateNumber,
    billingDate: salesBillingPlanDate.billingDate,
    billingRule: salesBillingPlanDate.billingRule,
    dateStatus: salesBillingPlanDate.status,
  }).from(salesBillingPlan)
    .leftJoin(salesBillingPlanDate, and(
      eq(salesBillingPlanDate.client, salesBillingPlan.client),
      eq(salesBillingPlanDate.orderNumber, salesBillingPlan.orderNumber),
      eq(salesBillingPlanDate.orderLineNumber, salesBillingPlan.orderLineNumber),
    ))
    .where(and(
      eq(salesBillingPlan.client, client),
      inArray(salesBillingPlan.orderNumber, [...new Set(items.map((item) => item.orderNumber))]),
    ))
    .orderBy(asc(salesBillingPlan.orderNumber), asc(salesBillingPlan.orderLineNumber),
      asc(salesBillingPlanDate.billingDate));
  for (const row of rows) {
    const key = itemKey(row.orderNumber, row.orderLineNumber);
    if (!found.has(key)) {
      found.set(key, {
        planType: row.planType, dateNumber: null, nextDate: null, hasInvoiceDates: false,
      });
    }
    const plan = found.get(key)!;
    if (row.dateNumber === null) continue;
    if (row.billingRule === 'INVOICE' && row.dateStatus !== 'WITHDRAWN') plan.hasInvoiceDates = true;
    // The earliest open invoice date is the one that is due, and the rows are ordered by the day, so
    // the first one seen is the answer and the rest are history.
    if (row.billingRule === 'INVOICE' && row.dateStatus === 'OPEN' && plan.dateNumber === null) {
      plan.dateNumber = row.dateNumber;
      plan.nextDate = row.billingDate;
    }
  }
  return found;
}

/** The plan types a tenant may choose from: the two delivered with the package, while they stand. */
export async function planTypeChoices(client: string): Promise<BillingPlanTypeRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(salesBillingPlanType).where(and(
      eq(salesBillingPlanType.client, client), eq(salesBillingPlanType.isActive, true),
    )).orderBy(asc(salesBillingPlanType.planType));
    return rows.map((row) => ({
      planType: row.planType, displayName: row.displayName, meaning: row.meaning,
    }));
  });
}

export async function getBillingPlan(
  client: string, orderNumber: string, orderLineNumber: number,
): Promise<BillingPlanView | null> {
  return withTenant(client, async (tx) => readPlan(tx, client, orderNumber, orderLineNumber));
}

export async function listBillingPlans(
  client: string, filter: { orderNumber?: string; customerNumber?: string } = {},
): Promise<BillingPlanView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({ orderNumber: salesBillingPlan.orderNumber, orderLineNumber: salesBillingPlan.orderLineNumber })
      .from(salesBillingPlan)
      .innerJoin(salesOrder, and(
        eq(salesOrder.client, salesBillingPlan.client),
        eq(salesOrder.orderNumber, salesBillingPlan.orderNumber),
      ))
      .where(and(
        eq(salesBillingPlan.client, client),
        filter.orderNumber ? eq(salesBillingPlan.orderNumber, filter.orderNumber) : undefined,
        filter.customerNumber ? eq(salesOrder.customerNumber, filter.customerNumber) : undefined,
      ))
      .orderBy(asc(salesBillingPlan.orderNumber), asc(salesBillingPlan.orderLineNumber))
      .limit(200);
    const plans: BillingPlanView[] = [];
    for (const row of rows) {
      const plan = await readPlan(tx, client, row.orderNumber, row.orderLineNumber);
      if (plan) plans.push(plan);
    }
    return plans;
  });
}

/**
 * The plan dates that have come due and are still open: the second half of the billing due list.
 *
 * The first half offers deliveries whose goods have gone out; this one offers shares of items that are
 * never delivered at all. The two never overlap, and the delivery path refuses an item that appears in
 * both: a share of an item and the whole of it are two answers to one question, and an order that
 * answered it twice would invoice the same value twice.
 *
 * A date says what it is for. One that invoices is billed; one that asks for an advance raises a
 * request instead, and the caller that answers this list answers it differently for the two.
 *
 * An order held for billing is not offered — its block is there to be released, and a date that vanished
 * from this list and reappeared the moment somebody lifted the block is a worse answer than a list that
 * says what it is waiting for. A date is offered on the day it names and every day after it: the day has
 * come, and whether anybody raises the document is a decision, not a filter.
 */
export async function listBillablePlanDates(
  client: string,
  filter: { customerNumber?: string; orderNumber?: string; onDate?: string } = {},
): Promise<Array<{
  orderNumber: string; orderLineNumber: number; dateNumber: number; billingDate: string;
  percentage: number; billingRule: BillingPlanDateRule; materialNumber: string;
  customerNumber: string; quantity: string; quantityUnit: string; value: string; currency: string;
}>> {
  // Today, unless the caller names the day it is asking about — a screen asks about today, and a test
  // asks about a day it can state.
  const onDate = filter.onDate || new Date().toISOString().slice(0, 10);
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      orderNumber: salesBillingPlanDate.orderNumber,
      orderLineNumber: salesBillingPlanDate.orderLineNumber,
      dateNumber: salesBillingPlanDate.dateNumber,
      billingDate: salesBillingPlanDate.billingDate,
      percentage: salesBillingPlanDate.percentage,
      billingRule: salesBillingPlanDate.billingRule,
      materialNumber: salesOrderLine.materialNumber,
      orderQuantity: salesOrderLine.orderQuantity,
      quantityUnit: salesOrderLine.quantityUnit,
      netAmount: salesOrderLine.netAmount,
      taxAmount: salesOrderLine.taxAmount,
      customerNumber: salesOrder.customerNumber,
      currency: salesOrder.currency,
    }).from(salesBillingPlanDate)
      .innerJoin(salesOrder, and(
        eq(salesOrder.client, salesBillingPlanDate.client),
        eq(salesOrder.orderNumber, salesBillingPlanDate.orderNumber),
      ))
      .innerJoin(salesOrderLine, and(
        eq(salesOrderLine.client, salesBillingPlanDate.client),
        eq(salesOrderLine.orderNumber, salesBillingPlanDate.orderNumber),
        eq(salesOrderLine.lineNumber, salesBillingPlanDate.orderLineNumber),
      ))
      .where(and(
        eq(salesBillingPlanDate.client, client),
        eq(salesBillingPlanDate.status, 'OPEN'),
        eq(salesOrder.status, 'OPEN'),
        isNull(salesOrder.billingBlock),
        eq(salesOrderLine.status, 'OPEN'),
        lte(salesBillingPlanDate.billingDate, onDate),
        filter.customerNumber ? eq(salesOrder.customerNumber, filter.customerNumber) : undefined,
        filter.orderNumber ? eq(salesBillingPlanDate.orderNumber, filter.orderNumber) : undefined,
      ))
      .orderBy(asc(salesBillingPlanDate.billingDate), asc(salesBillingPlanDate.orderNumber),
        asc(salesBillingPlanDate.orderLineNumber), asc(salesBillingPlanDate.dateNumber))
      .limit(200);
    return rows.map((row) => {
      const share = Number(row.percentage) / 100;
      return {
        orderNumber: row.orderNumber,
        orderLineNumber: row.orderLineNumber,
        dateNumber: row.dateNumber,
        billingDate: row.billingDate,
        percentage: round3(Number(row.percentage)),
        billingRule: row.billingRule as BillingPlanDateRule,
        materialNumber: row.materialNumber,
        customerNumber: row.customerNumber,
        quantity: round3(Number(row.orderQuantity) * share).toFixed(3),
        quantityUnit: row.quantityUnit.trim(),
        value: round2((Number(row.netAmount) + Number(row.taxAmount)) * share),
        currency: row.currency,
      };
    });
  });
}

async function readPlan(
  tx: Tx, client: string, orderNumber: string, orderLineNumber: number,
): Promise<BillingPlanView | null> {
  const [plan] = await tx.select().from(salesBillingPlan).where(and(
    eq(salesBillingPlan.client, client),
    eq(salesBillingPlan.orderNumber, orderNumber),
    eq(salesBillingPlan.orderLineNumber, orderLineNumber),
  )).limit(1);
  if (!plan) return null;
  const [line] = await tx.select({ materialNumber: salesOrderLine.materialNumber })
    .from(salesOrderLine).where(and(
      eq(salesOrderLine.client, client),
      eq(salesOrderLine.orderNumber, orderNumber),
      eq(salesOrderLine.lineNumber, orderLineNumber),
    )).limit(1);
  const [type] = await tx.select({ displayName: salesBillingPlanType.displayName })
    .from(salesBillingPlanType).where(and(
      eq(salesBillingPlanType.client, client),
      eq(salesBillingPlanType.planType, plan.planType),
    )).limit(1);
  const dates = await tx.select().from(salesBillingPlanDate).where(and(
    eq(salesBillingPlanDate.client, client),
    eq(salesBillingPlanDate.orderNumber, orderNumber),
    eq(salesBillingPlanDate.orderLineNumber, orderLineNumber),
  )).orderBy(asc(salesBillingPlanDate.dateNumber));
  const live = dates.filter((row) => row.status !== 'WITHDRAWN');
  const share = (rule: BillingPlanDateRule) => round3(live
    .filter((row) => row.billingRule === rule)
    .reduce((sum, row) => sum + Number(row.percentage), 0));
  return {
    orderNumber, orderLineNumber,
    materialNumber: line?.materialNumber ?? '',
    planType: plan.planType,
    planTypeName: type?.displayName ?? plan.planType,
    version: plan.version,
    totalPercentage: share('INVOICE'),
    totalDownPaymentPercentage: share('DOWN_PAYMENT'),
    dates: dates.map((row) => ({
      dateNumber: row.dateNumber,
      billingDate: row.billingDate,
      percentage: round3(Number(row.percentage)),
      billingRule: row.billingRule as BillingPlanDateRule,
      status: row.status as BillingPlanDateView['status'],
      billingNumber: row.billingNumber,
    })),
  };
}

/**
 * Read a plan date that is about to be billed, with every refusal both paths share.
 *
 * Billing a date and asking for the advance a date carries are two different acts, and they are judged
 * by the same ladder: the order stands, the item stands, the plan and the date exist, the date has not
 * been billed and was not withdrawn, and the day it names has come. One ladder, because a rule that
 * held for an invoice and not for an advance asked from the same date is not a rule — it is a loophole
 * with a date on it.
 *
 * `action` names what the caller is about to do, so the refusal says "billed" to a clerk billing and
 * "asked for" to a clerk asking for an advance.
 */
export interface BillablePlanDateContext {
  order: typeof salesOrder.$inferSelect;
  orderLine: typeof salesOrderLine.$inferSelect;
  plan: typeof salesBillingPlan.$inferSelect;
  date: typeof salesBillingPlanDate.$inferSelect;
}

export async function loadBillablePlanDate(tx: Tx, input: {
  client: string;
  orderNumber: string;
  orderLineNumber: number;
  dateNumber: number;
  /** The day the caller is acting on, judged against the day the date names. */
  billingDate: string;
  /** `billed` or `asked for`, so a refusal names what was being done. */
  action: 'billed' | 'asked for';
}): Promise<BillablePlanDateContext> {
  const { client, orderNumber, orderLineNumber, dateNumber, action } = input;
  const [order] = await tx.select().from(salesOrder).where(and(
    eq(salesOrder.client, client), eq(salesOrder.orderNumber, orderNumber),
  )).limit(1);
  if (!order) {
    throw new BillingPlanError(
      `Sales order ${orderNumber} does not exist in this tenant.`,
      'Create the order at /sales/orders first; a plan date is billed against an order that stands.',
    );
  }
  if (order.status === 'CANCELLED') {
    throw new BillingPlanError(
      `Sales order ${orderNumber} stands CANCELLED, and a cancelled order is billed by nothing at all.`,
      'A cancelled order is not reopened by a plan date — raise a new order.',
    );
  }
  const [orderLine] = await tx.select().from(salesOrderLine).where(and(
    eq(salesOrderLine.client, client),
    eq(salesOrderLine.orderNumber, orderNumber),
    eq(salesOrderLine.lineNumber, orderLineNumber),
  )).limit(1);
  if (!orderLine) {
    throw new BillingPlanError(
      `Sales order ${orderNumber} carries no item ${orderLineNumber}.`,
      'Bill an item the order states.',
    );
  }
  if (orderLine.status === 'REJECTED') {
    throw new BillingPlanError(
      `Item ${orderLineNumber} of order ${orderNumber} is rejected${orderLine.rejectionReason ? ` (reason ${orderLine.rejectionReason})` : ''}, and a rejected item is billed on no schedule at all.`,
      'Re-enter the item on the order to lift the rejection, or leave it rejected.',
    );
  }

  const [plan] = await tx.select().from(salesBillingPlan).where(and(
    eq(salesBillingPlan.client, client),
    eq(salesBillingPlan.orderNumber, orderNumber),
    eq(salesBillingPlan.orderLineNumber, orderLineNumber),
  )).limit(1);
  if (!plan) {
    throw new BillingPlanError(
      `Order ${orderNumber} item ${orderLineNumber} carries no billing plan, so it is billed by its deliveries and not by dates.`,
      `Maintain a plan for the item at ${BILLING_PLAN_ROUTE} first: an item with no plan has no date to bill.`,
    );
  }
  const [date] = await tx.select().from(salesBillingPlanDate).where(and(
    eq(salesBillingPlanDate.client, client),
    eq(salesBillingPlanDate.orderNumber, orderNumber),
    eq(salesBillingPlanDate.orderLineNumber, orderLineNumber),
    eq(salesBillingPlanDate.dateNumber, dateNumber),
  )).limit(1);
  if (!date) {
    throw new BillingPlanError(
      `The plan of order ${orderNumber} item ${orderLineNumber} carries no date ${dateNumber}.`,
      `Read the plan at ${BILLING_PLAN_ROUTE} and bill a date it states.`,
    );
  }
  if (date.status === 'BILLED') {
    throw new BillingPlanError(
      `Date ${dateNumber} of order ${orderNumber} item ${orderLineNumber} was ${action} as ${date.billingNumber}, and a date is ${action} once.`,
      'Cancel that document first: a cancelled document releases its date, as it releases the delivery it stands against.',
    );
  }
  if (date.status === 'WITHDRAWN') {
    throw new BillingPlanError(
      `Date ${dateNumber} of order ${orderNumber} item ${orderLineNumber} was withdrawn, so it is ${action} nothing.`,
      `Maintain the plan at ${BILLING_PLAN_ROUTE}: a withdrawn date answers nothing, and what it once said stays on the record.`,
    );
  }
  // A plan is a promise about a day. The day is the point of it, and a date billed before its own day
  // is not an early invoice — it is a promise broken by the person who made it.
  if (input.billingDate < date.billingDate) {
    throw new BillingPlanError(
      `Date ${dateNumber} of order ${orderNumber} item ${orderLineNumber} falls on ${date.billingDate}, and ${input.billingDate} was entered.`,
      `A date is ${action} on or after the day it names: ${action === 'billed' ? 'bill it' : 'ask for it'} on ${date.billingDate} or later, or move the date on the plan.`,
    );
  }
  return { order, orderLine, plan, date };
}

/**
 * Write the plan an order item is billed by.
 *
 * The plan is written as a whole: the dates submitted are the plan, and a date that stood and was not
 * submitted again is withdrawn — never deleted, for the reason the header gives. A date that has
 * already been billed cannot be withdrawn or moved, and a plan with such a date is not rewritten at
 * all: the money has been asked for, and the schedule that asked for it is part of what happened.
 *
 * The shares have to total a hundred. A plan that promises ninety has not said when the last tenth is
 * billed, and the refusal says what is missing rather than filling the gap with a date nobody chose.
 */
export async function saveBillingPlan(raw: BillingPlanSaveInput): Promise<{ version: number }> {
  const parsed = billingPlanSaveInput.parse(raw);
  const { client, orderNumber, orderLineNumber, planType, changedBy } = parsed;
  // The dates that invoice share a hundred between them: that is what makes the plan an answer to when
  // the item is billed. The dates that ask for an advance stand outside the hundred — an advance is
  // money asked early and the invoice still bills the whole — but they cannot ask for more than the
  // order carries, and a plan of advances alone is one that leaves the item to its deliveries.
  // What a date does where the plan does not say is invoice it, which is what every date has always
  // done: a plan maintained before advances existed keeps its meaning unchanged.
  const ruleOf = (date: { billingRule?: BillingPlanDateRule }) => date.billingRule ?? 'INVOICE';
  const total = parsed.dates
    .filter((date) => ruleOf(date) === 'INVOICE')
    .reduce((sum, date) => sum + date.percentage, 0);
  const advances = parsed.dates
    .filter((date) => ruleOf(date) === 'DOWN_PAYMENT')
    .reduce((sum, date) => sum + date.percentage, 0);
  const invoices = parsed.dates.filter((date) => ruleOf(date) === 'INVOICE').length;
  if (invoices > 0 && Math.abs(total - 100) > 0.001) {
    throw new BillingPlanError(
      `The dates of a billing plan that invoice share a hundred per cent between them, and these share ${round3(total)}.`,
      total < 100
        ? `Add the missing ${round3(100 - total)} per cent to a date, or raise one of them to cover it.`
        : `Take ${round3(total - 100)} per cent off one of the dates.`,
    );
  }
  if (advances - 100 > 0.001) {
    throw new BillingPlanError(
      `The dates of this plan ask ${round3(advances)} per cent of the item in advance, and no plan asks for more than the whole of it.`,
      `Take ${round3(advances - 100)} per cent off one of the dates that ask for an advance.`,
    );
  }

  return withTenant(client, async (tx) => {
    const [order] = await tx.select().from(salesOrder).where(and(
      eq(salesOrder.client, client), eq(salesOrder.orderNumber, orderNumber),
    )).limit(1);
    if (!order) {
      throw new BillingPlanError(
        `Sales order ${orderNumber} does not exist in this tenant.`,
        'Create the order at /sales/orders first; a plan is maintained on an item of an order that stands.',
      );
    }
    if (order.status === 'CANCELLED') {
      throw new BillingPlanError(
        `Sales order ${orderNumber} stands CANCELLED, and a cancelled order is billed by nothing at all.`,
        'A cancelled order is not reopened by a plan — raise a new order.',
      );
    }
    const [line] = await tx.select().from(salesOrderLine).where(and(
      eq(salesOrderLine.client, client),
      eq(salesOrderLine.orderNumber, orderNumber),
      eq(salesOrderLine.lineNumber, orderLineNumber),
    )).limit(1);
    if (!line) {
      throw new BillingPlanError(
        `Sales order ${orderNumber} carries no item ${orderLineNumber}.`,
        'Maintain the plan on an item the order states.',
      );
    }
    if (line.status === 'REJECTED') {
      throw new BillingPlanError(
        `Item ${orderLineNumber} of order ${orderNumber} is rejected${line.rejectionReason ? ` (reason ${line.rejectionReason})` : ''}, and a rejected item is billed on no schedule at all.`,
        'Re-enter the item on the order to lift the rejection, or leave it rejected.',
      );
    }
    const [type] = await tx.select().from(salesBillingPlanType).where(and(
      eq(salesBillingPlanType.client, client),
      eq(salesBillingPlanType.planType, planType),
      eq(salesBillingPlanType.isActive, true),
    )).limit(1);
    if (!type) {
      throw new BillingPlanError(
        `Billing plan type ${planType} does not stand for this tenant.`,
        'The two types delivered with the package are PE, periodic, and MS, milestone. Choose one of them.',
      );
    }

    const [before] = await tx.select().from(salesBillingPlan).where(and(
      eq(salesBillingPlan.client, client),
      eq(salesBillingPlan.orderNumber, orderNumber),
      eq(salesBillingPlan.orderLineNumber, orderLineNumber),
    )).limit(1);
    if (before && parsed.expectedVersion !== undefined && before.version !== parsed.expectedVersion) {
      throw new BillingPlanError(
        `The plan was changed since it was opened (version ${before.version}, expected ${parsed.expectedVersion}).`,
        'Read the plan again and change what stands now.',
      );
    }

    const standing = before
      ? await tx.select().from(salesBillingPlanDate).where(and(
        eq(salesBillingPlanDate.client, client),
        eq(salesBillingPlanDate.orderNumber, orderNumber),
        eq(salesBillingPlanDate.orderLineNumber, orderLineNumber),
      )).orderBy(asc(salesBillingPlanDate.dateNumber))
      : [];
    const billed = standing.find((row) => row.status === 'BILLED');
    if (billed) {
      throw new BillingPlanError(
        `Date ${billed.dateNumber} of this plan was billed as ${billed.billingNumber} on its day, so the plan is settled as it stands and cannot be rewritten.`,
        'Cancel that billing document first: a cancelled document releases its date, as it releases the delivery it stands against.',
      );
    }

    const version = before ? before.version + 1 : 1;
    if (before) {
      await tx.update(salesBillingPlan).set({
        planType, version, changedBy, changedAt: new Date(),
      }).where(and(
        eq(salesBillingPlan.client, client),
        eq(salesBillingPlan.orderNumber, orderNumber),
        eq(salesBillingPlan.orderLineNumber, orderLineNumber),
        eq(salesBillingPlan.version, before.version),
      ));
    } else {
      await tx.insert(salesBillingPlan).values({
        client, orderNumber, orderLineNumber, planType, version, createdBy: changedBy,
      });
    }

    // Dates are numbered in tens, and a number once given is kept: a document that named date 20
    // still names the same date after the plan around it has been rewritten.
    let nextNumber = 10;
    const used = new Set<number>();
    for (const date of parsed.dates) {
      // A date the screen named keeps its number. A new one takes the next number in tens that
      // nothing else is using, so a date added later never lands on a number a document already
      // named.
      while (standing.some((row) => row.dateNumber === nextNumber) || used.has(nextNumber)) {
        nextNumber += 10;
      }
      const dateNumber = date.dateNumber ?? nextNumber;
      const existing = standing.find((row) => row.dateNumber === dateNumber);
      if (existing) {
        await tx.update(salesBillingPlanDate).set({
          billingDate: date.billingDate,
          percentage: String(date.percentage),
          billingRule: ruleOf(date),
          status: 'OPEN',
          changedBy, changedAt: new Date(),
        }).where(and(
          eq(salesBillingPlanDate.client, client),
          eq(salesBillingPlanDate.orderNumber, orderNumber),
          eq(salesBillingPlanDate.orderLineNumber, orderLineNumber),
          eq(salesBillingPlanDate.dateNumber, dateNumber),
        ));
      } else {
        await tx.insert(salesBillingPlanDate).values({
          client, orderNumber, orderLineNumber,
          dateNumber,
          billingDate: date.billingDate,
          percentage: String(date.percentage),
          billingRule: ruleOf(date),
          status: 'OPEN',
          createdBy: changedBy,
        });
      }
      used.add(dateNumber);
    }
    // A date that stood and was not submitted again is withdrawn. It answers nothing from now on, and
    // it stays: a plan is part of what was agreed about this order.
    for (const row of standing) {
      if (used.has(row.dateNumber)) continue;
      await tx.update(salesBillingPlanDate).set({
        status: 'WITHDRAWN', changedBy, changedAt: new Date(),
      }).where(and(
        eq(salesBillingPlanDate.client, client),
        eq(salesBillingPlanDate.orderNumber, orderNumber),
        eq(salesBillingPlanDate.orderLineNumber, orderLineNumber),
        eq(salesBillingPlanDate.dateNumber, row.dateNumber),
      ));
    }

    await recordChange(tx, {
      client, objectClass: BILLING_PLAN_OBJECT_CLASS,
      objectKey: `${orderNumber}/${orderLineNumber}`,
      changeType: before ? 'CHANGE' : 'CREATE',
      changedBy, reason: parsed.reason,
      before: before
        ? { planType: before.planType, dates: standing.filter((row) => row.status !== 'WITHDRAWN')
          .map((row) => `${row.dateNumber}:${row.billingDate}:${row.percentage}`).join(' ') }
        : undefined,
      after: {
        planType,
        dates: parsed.dates.map((date) => `${date.dateNumber ?? ''}:${date.billingDate}:${date.percentage}:${ruleOf(date)}`).join(' '),
      },
      securityRelevantFields: ['planType', 'dates'],
    });
    return { version };
  });
}

/**
 * Record that a date was billed, inside the transaction that raised the document.
 *
 * The status and the document move together, and they move in the billing service's transaction: a
 * document that stood but whose date stayed open would be billed again the next time the due list
 * was read.
 */
export async function markPlanDateBilled(tx: Tx, input: {
  client: string; orderNumber: string; orderLineNumber: number;
  dateNumber: number; billingNumber: string; changedBy: string;
}): Promise<void> {
  const applied = await tx.update(salesBillingPlanDate).set({
    status: 'BILLED', billingNumber: input.billingNumber,
    changedBy: input.changedBy, changedAt: new Date(),
  }).where(and(
    eq(salesBillingPlanDate.client, input.client),
    eq(salesBillingPlanDate.orderNumber, input.orderNumber),
    eq(salesBillingPlanDate.orderLineNumber, input.orderLineNumber),
    eq(salesBillingPlanDate.dateNumber, input.dateNumber),
    eq(salesBillingPlanDate.status, 'OPEN'),
  )).returning({ dateNumber: salesBillingPlanDate.dateNumber });
  if (!applied.length) {
    throw new BillingPlanError(
      `Date ${input.dateNumber} of order ${input.orderNumber} item ${input.orderLineNumber} is no longer open, so it cannot be billed as ${input.billingNumber}.`,
      'Read the plan again: a date is billed once, and only while it stands open.',
    );
  }
}

/**
 * Release the date a cancelled billing document billed.
 *
 * A cancelled document is history, not a door: the date stands open again, and the corrected document
 * can be raised against it — the same rule that lets a cancelled invoice's delivery be billed again.
 */
export async function releasePlanDateForBilling(tx: Tx, input: {
  client: string; billingNumber: string; changedBy: string;
}): Promise<void> {
  await tx.update(salesBillingPlanDate).set({
    status: 'OPEN', billingNumber: null,
    changedBy: input.changedBy, changedAt: new Date(),
  }).where(and(
    eq(salesBillingPlanDate.client, input.client),
    eq(salesBillingPlanDate.billingNumber, input.billingNumber),
    eq(salesBillingPlanDate.status, 'BILLED'),
  ));
}

const round3 = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000;
const round2 = (value: number) => (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
