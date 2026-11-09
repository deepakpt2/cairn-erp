'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  BILLING_PLAN_CAPABILITY,
  BILLING_PLAN_ROUTE,
  BillingPlanError,
  saveBillingPlan,
} from '@/modules/sales/billing-plan';

const ROUTE = BILLING_PLAN_ROUTE;
/** How many dates a plan may be made of on the screen. The service holds ninety-nine. */
const DATE_SLOTS = 12;

export interface BillingPlanActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  orderNumber?: string;
  orderLineNumber?: number;
  /** The version the plan stands at after the save, which is what the next save is guarded by. */
  version?: number;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

/** A refusal is reported in the plan service's own words, with the remedy it names. */
function refuse(error: unknown): BillingPlanActionState {
  if (error instanceof BillingPlanError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

/**
 * The dates a form submitted: one row per date, and a row with no day or no share is not a date —
 * the form leaves the slots it does not want empty rather than submitting zeroes.
 */
function datesFrom(form: FormData): Array<{ dateNumber?: number; billingDate: string; percentage: number }> {
  const dates: Array<{ dateNumber?: number; billingDate: string; percentage: number }> = [];
  for (let slot = 1; slot <= DATE_SLOTS; slot += 1) {
    const billingDate = text(form, `date-${slot}-billingDate`);
    const percentage = text(form, `date-${slot}-percentage`);
    if (!billingDate || !percentage) continue;
    const dateNumber = text(form, `date-${slot}-dateNumber`);
    dates.push({
      ...(dateNumber ? { dateNumber: Number(dateNumber) } : {}),
      billingDate,
      percentage: Number(percentage),
    });
  }
  return dates;
}

/**
 * Write the plan an order item is billed by.
 *
 * The dates submitted *are* the plan: one that stood and was not submitted again is withdrawn rather
 * than deleted, because a plan is part of what was agreed about an order and an order whose plan
 * changed twice was agreed three times. The shares have to total a hundred, and the service says what
 * is missing rather than filling the gap with a date nobody chose.
 */
export async function saveBillingPlanAction(
  _previous: BillingPlanActionState,
  form: FormData,
): Promise<BillingPlanActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BILLING_PLAN_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the billing plan capability.',
      remedy: 'Ask for SALES.BILLING_PLAN.MAINTAIN.',
    };
  }
  const orderNumber = text(form, 'orderNumber').toUpperCase();
  const orderLineNumber = Number(text(form, 'orderLineNumber') || '0');
  const dates = datesFrom(form);
  if (!dates.length) {
    return {
      ok: false,
      message: 'A plan is made of dates, and none was given a day and a share.',
      remedy: 'Give each date the day it falls on and the share of the item it bills.',
    };
  }
  try {
    const result = await saveBillingPlan({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber,
      orderLineNumber,
      planType: text(form, 'planType').toUpperCase(),
      dates,
      reason: text(form, 'reason'),
      expectedVersion: Number(optional(form, 'expectedVersion') ?? '0') || undefined,
      requestKey: optional(form, 'requestKey'),
    });
    revalidatePath(ROUTE);
    const shared = dates.reduce((sum, date) => sum + date.percentage, 0);
    return {
      ok: true,
      orderNumber,
      orderLineNumber,
      version: result.version,
      message: `Order ${orderNumber} item ${orderLineNumber} is billed by ${dates.length} date${dates.length === 1 ? '' : 's'} sharing ${Number(shared.toFixed(3))} per cent, and the plan stands at version ${result.version}.`,
      remedy: 'Each date is billed from /sales/billing on the day it names, and not before. An item with a plan is billed by the plan and not by its deliveries.',
    };
  } catch (error) {
    return refuse(error);
  }
}
