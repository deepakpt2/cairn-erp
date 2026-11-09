'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  REBATE_CAPABILITY,
  REBATE_ROUTE,
  REBATE_SETTLEMENT_CAPABILITY,
  RebateError,
  releaseRebateAgreement,
  saveRebateAgreement,
  settleRebateAgreement,
} from '@/modules/sales/rebate';

const ROUTE = REBATE_ROUTE;

export interface RebateActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  agreementNumber?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

/** A refusal is reported in the rebate service's own words, with the remedy it names. */
function refuse(error: unknown): RebateActionState {
  if (error instanceof RebateError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

/**
 * Maintain a rebate agreement.
 *
 * It stands open, and open accrues nothing: the release is a separate act, because a provision nobody
 * authorised is worse than no provision. Once sales have accrued against one, what it promised is
 * history — only the day it runs to can still be changed.
 */
export async function saveRebateAgreementAction(
  _previous: RebateActionState,
  form: FormData,
): Promise<RebateActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, REBATE_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the rebate capability.',
      remedy: 'Ask for SALES.REBATE.MAINTAIN.',
    };
  }
  try {
    const agreement = await saveRebateAgreement({
      client: session.user.client,
      changedBy: session.user.username,
      agreementNumber: optional(form, 'agreementNumber')?.toUpperCase(),
      customerNumber: text(form, 'customerNumber').toUpperCase(),
      salesOrg: text(form, 'salesOrg'),
      distributionChannel: text(form, 'distributionChannel'),
      division: text(form, 'division'),
      currency: text(form, 'currency').toUpperCase() || 'USD',
      validFrom: text(form, 'validFrom'),
      validTo: text(form, 'validTo'),
      conditionType: text(form, 'conditionType').toUpperCase() || 'BO01',
      requestKey: optional(form, 'requestKey'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      agreementNumber: agreement.agreementNumber,
      message: `Rebate agreement ${agreement.agreementNumber} promises ${agreement.customerNumber} a rebate between ${agreement.validFrom} and ${agreement.validTo}, priced by ${agreement.conditionType}, and stands ${agreement.status.toLowerCase()}.`,
      remedy: agreement.status === 'OPEN'
        ? 'It accrues nothing until it is released. Release it, then the sales that fall inside it provide for what they earn as they are billed.'
        : `It has provided for ${agreement.accrued} ${agreement.currency} so far, of which ${agreement.settled} has been paid out.`,
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Release an agreement, which is the act that lets it accrue. */
export async function releaseRebateAgreementAction(
  _previous: RebateActionState,
  form: FormData,
): Promise<RebateActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, REBATE_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the rebate capability.',
      remedy: 'Ask for SALES.REBATE.MAINTAIN.',
    };
  }
  const agreementNumber = text(form, 'agreementNumber').toUpperCase();
  if (!agreementNumber) {
    return {
      ok: false,
      message: 'Name the agreement to release.',
      remedy: 'Open an agreement and release it from there.',
    };
  }
  try {
    const agreement = await releaseRebateAgreement({
      client: session.user.client,
      changedBy: session.user.username,
      agreementNumber,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      agreementNumber,
      message: `Rebate agreement ${agreementNumber} stands released, and every sale inside its period for its payer and sales area now provides for the rebate it earns.`,
      remedy: 'The provision is posted with the invoice and released by the settlement, which credits the customer on a credit memo of its own.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Settle an agreement: pay the customer what the sales inside it have earned.
 *
 * Naming no amount settles all of what stands and closes the agreement; naming less pays that out and
 * leaves it accruing. Settling more than accrued is refused by the service, because a promise is not a
 * blank cheque.
 */
export async function settleRebateAgreementAction(
  _previous: RebateActionState,
  form: FormData,
): Promise<RebateActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, REBATE_SETTLEMENT_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the capability that gives the company’s money back.',
      remedy: 'Ask for SALES.CREDIT.MEMO.POST.',
    };
  }
  const agreementNumber = text(form, 'agreementNumber').toUpperCase();
  const settlementDate = text(form, 'settlementDate');
  if (!agreementNumber || !settlementDate) {
    return {
      ok: false,
      message: 'A settlement names an agreement and a day.',
      remedy: 'Open the agreement and give the day the credit memo is to bear.',
    };
  }
  const amount = optional(form, 'amount');
  try {
    const settlement = await settleRebateAgreement({
      client: session.user.client,
      changedBy: session.user.username,
      agreementNumber,
      settlementDate,
      ...(amount ? { amount: Number(amount) } : {}),
      requestKey: optional(form, 'requestKey'),
    });
    revalidatePath(ROUTE);
    const documents = settlement.documents.length === 1
      ? `credit memo ${settlement.documents[0].billingNumber}`
      : `${settlement.documents.length} credit memos, one per order`;
    return {
      ok: true,
      agreementNumber,
      message: `${settlement.amount} was settled against rebate agreement ${agreementNumber} as ${documents}, and the settlement is ${settlement.settlementType === 'FINAL' ? 'final' : 'partial'}.`,
      remedy: settlement.settlementType === 'FINAL'
        ? 'The agreement stands settled: everything that accrued against it has been paid out.'
        : 'The agreement goes on accruing, and what is left standing can be settled later.',
    };
  } catch (error) {
    return refuse(error);
  }
}
