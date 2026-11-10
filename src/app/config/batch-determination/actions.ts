'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  BATCH_DETERMINATION_CAPABILITY, BATCH_DETERMINATION_ROUTE,
  BatchDeterminationError, saveBatchDeterminationRule,
} from '@/modules/sales/batch-determination';

const ROUTE = BATCH_DETERMINATION_ROUTE;

export interface BatchRuleActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

/**
 * Save one rule. The number is the identity: a rule that already stands is changed, and one that does
 * not is created, because a tenant that has three rules does not think of them as a list to append to
 * but as three answers to three questions.
 */
export async function saveBatchRuleAction(
  _previous: BatchRuleActionState,
  form: FormData,
): Promise<BatchRuleActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BATCH_DETERMINATION_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the batch determination capability.',
      remedy: `Ask for ${BATCH_DETERMINATION_CAPABILITY}.`,
    };
  }
  try {
    const saved = await saveBatchDeterminationRule({
      client: session.user.client,
      changedBy: session.user.username,
      ruleNumber: text(form, 'ruleNumber'),
      ...(optional(form, 'name') ? { name: optional(form, 'name') } : {}),
      ...(optional(form, 'salesOrg') ? { salesOrg: optional(form, 'salesOrg') } : {}),
      ...(optional(form, 'distributionChannel') ? { distributionChannel: optional(form, 'distributionChannel') } : {}),
      ...(optional(form, 'customerNumber') ? { customerNumber: optional(form, 'customerNumber') } : {}),
      ...(optional(form, 'materialNumber') ? { materialNumber: optional(form, 'materialNumber') } : {}),
      ...(optional(form, 'plant') ? { plant: optional(form, 'plant') } : {}),
      sortRule: text(form, 'sortRule') as 'FIFO',
      isActive: text(form, 'isActive') !== 'off',
      validityFrom: text(form, 'validityFrom'),
      validityTo: text(form, 'validityTo'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Rule ${saved.ruleNumber} ${saved.created ? 'created' : 'changed'}.`,
    };
  } catch (error) {
    if (error instanceof BatchDeterminationError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return { ok: false, message: String((error as Error).message ?? error) };
  }
}
