/**
 * KOP1 — create a plan-revaluation definition for internal orders.
 *
 * Saving records which orders, year, periods, and plan version were
 * selected. It does not change plan amounts, budgets, or journals.
 * No percentage is stored. KOP2, KOP3, KOP4, and KOPU are not this service.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { numberRange } from '../../platform/tables/numbering';
import {
  controllingArea,
  fiscalYearVariant,
  internalOrder,
  planRevaluationOrder,
  planRevaluationOrderItem,
} from './schema';

export const PLAN_REVALUATION_CAPABILITY = 'CO.PLANREVAL.CREATE';
export const PLAN_REVALUATION_ROUTE = '/controlling/plan-revaluation';
export const PLAN_REVALUATION_OBJECT_CLASS = 'plan_revaluation_order';
export const PLAN_REVALUATION_NOT_EXECUTED = 'KOPU is not implemented. Saving this definition does not revalue plan data.';

export class PlanRevaluationError extends Error {
  readonly remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PlanRevaluationError';
    this.remedy = remedy;
  }
}

const createInput = z.object({
  client: z.string().trim().min(1).max(4),
  changedBy: z.string().trim().min(1).max(60),
  controllingArea: z.string().trim().min(4).max(4),
  fiscalYear: z.number().int(),
  periodFrom: z.number().int(),
  periodTo: z.number().int(),
  planVersion: z.string().trim().min(1).max(3),
  description: z.string().trim().min(1).max(40),
  orderFrom: z.string().trim().max(20).optional().default(''),
  orderTo: z.string().trim().max(20).optional().default(''),
  currency: z.string().trim().max(3).optional().default(''),
  revaluationNumber: z.string().trim().max(20).optional().default(''),
  requestKey: z.string().trim().max(64).optional(),
}).strict();

export type CreatePlanRevaluationInput = z.input<typeof createInput>;

export interface PlanRevaluationExclusion {
  orderNumber: string;
  reason: string;
}

export interface PlanRevaluationView {
  revaluationNumber: string;
  controllingArea: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  planVersion: string;
  description: string;
  currency: string;
  executionStatus: 'NOT_EXECUTED';
  orders: string[];
  executable: false;
  executionReason: string;
}

export interface CreatePlanRevaluationResult {
  revaluationNumber: string;
  orders: string[];
  excluded: PlanRevaluationExclusion[];
  executed: false;
}

export function planRevaluationEligibility(): { executable: false; reason: string } {
  return { executable: false, reason: PLAN_REVALUATION_NOT_EXECUTED };
}

async function assertRange(client: string): Promise<void> {
  await withTenant(client, async (tx) => {
    const [range] = await tx.select().from(numberRange).where(and(
      eq(numberRange.client, client),
      eq(numberRange.objectCode, 'REVALORD'),
      eq(numberRange.companyCode, '*'),
      eq(numberRange.subObject, '*'),
      eq(numberRange.fiscalYear, 0),
    ));
    if (!range || range.isExternal) {
      throw new PlanRevaluationError(
        'No internal REVALORD number range stands, so no revaluation number can be drawn.',
        'Define an internal REVALORD interval. A typed number is not accepted.',
      );
    }
  });
}

async function toView(tx: Tx, client: string, number: string): Promise<PlanRevaluationView | null> {
  const [header] = await tx.select().from(planRevaluationOrder).where(and(
    eq(planRevaluationOrder.client, client),
    eq(planRevaluationOrder.revaluationNumber, number),
  ));
  if (!header) return null;
  const items = await tx.select().from(planRevaluationOrderItem).where(and(
    eq(planRevaluationOrderItem.client, client),
    eq(planRevaluationOrderItem.revaluationNumber, number),
  )).orderBy(asc(planRevaluationOrderItem.orderNumber));
  return {
    revaluationNumber: header.revaluationNumber,
    controllingArea: header.controllingArea,
    fiscalYear: header.fiscalYear,
    periodFrom: header.periodFrom,
    periodTo: header.periodTo,
    planVersion: header.planVersion,
    description: header.description,
    currency: header.currency.trim(),
    executionStatus: 'NOT_EXECUTED',
    orders: items.map((item) => item.orderNumber),
    executable: false,
    executionReason: PLAN_REVALUATION_NOT_EXECUTED,
  };
}

export async function getPlanRevaluationOrder(client: string, revaluationNumber: string): Promise<PlanRevaluationView | null> {
  return withTenant(client, (tx) => toView(tx, client, revaluationNumber.trim()));
}

export async function createPlanRevaluationOrder(raw: CreatePlanRevaluationInput): Promise<CreatePlanRevaluationResult> {
  const parsed = createInput.safeParse(raw);
  if (!parsed.success) throw new PlanRevaluationError(parsed.error.issues[0].message);
  const input = parsed.data;
  if (input.revaluationNumber.trim()) {
    throw new PlanRevaluationError(
      'This number range assigns the revaluation number. A typed number is not accepted.',
      'Leave the number empty. External numbering is not assigned by this service.',
    );
  }
  if (!/^[A-Z0-9]{1,3}$/.test(input.planVersion.toUpperCase())) {
    throw new PlanRevaluationError('The plan version must be 1 to 3 letters or digits. It is not defaulted.');
  }
  if (input.fiscalYear < 1000 || input.fiscalYear > 9999) {
    throw new PlanRevaluationError('The fiscal year must be the year you intend. It is not substituted.');
  }
  if (!input.orderFrom && !input.orderTo) {
    throw new PlanRevaluationError('Enter an internal order, or an order number range.');
  }
  if (input.orderFrom && input.orderTo && input.orderFrom > input.orderTo) {
    throw new PlanRevaluationError('The order number from is after the order number to.');
  }
  await assertRange(input.client);
  return withTenant(input.client, async (tx) => {
    const lockKey = input.requestKey
      ? `${input.client}/plan_revaluation/${input.requestKey}`
      : `${input.client}/plan_revaluation/create/${input.controllingArea}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    if (input.requestKey) {
      const [existing] = await tx.select().from(planRevaluationOrder).where(and(
        eq(planRevaluationOrder.client, input.client),
        eq(planRevaluationOrder.requestKey, input.requestKey),
      ));
      if (existing) {
        const view = await toView(tx, input.client, existing.revaluationNumber);
        return { revaluationNumber: existing.revaluationNumber, orders: view?.orders ?? [], excluded: [], executed: false };
      }
    }
    const areaCode = input.controllingArea.trim().toUpperCase();
    const [area] = await tx.select().from(controllingArea).where(and(
      eq(controllingArea.client, input.client),
      eq(controllingArea.controllingArea, areaCode),
    ));
    if (!area?.isActive) throw new PlanRevaluationError(`Controlling area ${areaCode} does not exist or is inactive.`);
    const supplied = input.currency.trim().toUpperCase();
    if (supplied && supplied !== area.currency.trim().toUpperCase()) {
      throw new PlanRevaluationError(`The currency is the controlling area currency ${area.currency.trim()}. It is not substituted.`);
    }
    const [variant] = await tx.select().from(fiscalYearVariant).where(and(
      eq(fiscalYearVariant.client, input.client),
      eq(fiscalYearVariant.variant, area.fiscalYearVariant),
    ));
    if (!variant) throw new PlanRevaluationError(`Fiscal year variant ${area.fiscalYearVariant} does not exist.`);
    if (input.periodFrom < 1 || input.periodTo < 1 || input.periodFrom > input.periodTo || input.periodTo > variant.regularPeriods) {
      throw new PlanRevaluationError(
        `Periods must run from 1 to ${variant.regularPeriods} for fiscal year variant ${variant.variant}.`,
        'The period range is not replaced with a calendar year.',
      );
    }
    const from = input.orderFrom || input.orderTo;
    const to = input.orderTo || input.orderFrom;
    const orders = await tx.select().from(internalOrder).where(and(
      eq(internalOrder.client, input.client),
      eq(internalOrder.controllingArea, areaCode),
    )).orderBy(asc(internalOrder.orderNumber));
    const inRange = orders.filter((order) => order.orderNumber >= from && order.orderNumber <= to);
    if (from === to && inRange.length === 0) {
      const [elsewhere] = await tx.select().from(internalOrder).where(and(
        eq(internalOrder.client, input.client),
        eq(internalOrder.orderNumber, from),
      ));
      if (!elsewhere) throw new PlanRevaluationError(`Internal order ${from} does not exist.`);
      throw new PlanRevaluationError(`Internal order ${from} is not in controlling area ${areaCode}.`);
    }
    const excluded: PlanRevaluationExclusion[] = [];
    const included = inRange.filter((order) => {
      if (!order.markedForDeletion) return true;
      excluded.push({ orderNumber: order.orderNumber, reason: 'The order is marked for deletion and is not included.' });
      return false;
    });
    if (included.length === 0) {
      throw new PlanRevaluationError(
        excluded[0]?.reason ?? 'No internal order in this controlling area matches the selection.',
      );
    }
    const drawn = await allocateNumber(tx, {
      client: input.client,
      objectCode: 'REVALORD',
      companyCode: '*',
      subObject: '*',
      fiscalYear: 0,
      allocatedBy: input.changedBy,
    });
    if (drawn.display.length > 20) {
      throw new PlanRevaluationError('The drawn revaluation number is longer than the number field.');
    }
    await tx.insert(planRevaluationOrder).values({
      client: input.client,
      revaluationNumber: drawn.display,
      controllingArea: areaCode,
      fiscalYear: input.fiscalYear,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      planVersion: input.planVersion.toUpperCase(),
      description: input.description,
      currency: area.currency.trim(),
      executionStatus: 'NOT_EXECUTED',
      requestKey: input.requestKey ?? null,
      createdBy: input.changedBy,
    });
    for (const order of included) {
      await tx.insert(planRevaluationOrderItem).values({
        client: input.client,
        revaluationNumber: drawn.display,
        orderNumber: order.orderNumber,
        createdBy: input.changedBy,
      });
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: PLAN_REVALUATION_OBJECT_CLASS,
      objectKey: drawn.display,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: 'KOP1',
      after: {
        controllingArea: areaCode,
        fiscalYear: String(input.fiscalYear),
        planVersion: input.planVersion.toUpperCase(),
        orders: String(included.length),
        executionStatus: 'NOT_EXECUTED',
      },
    });
    return {
      revaluationNumber: drawn.display,
      orders: included.map((order) => order.orderNumber),
      excluded,
      executed: false,
    };
  });
}

