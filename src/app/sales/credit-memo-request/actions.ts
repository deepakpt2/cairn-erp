'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { getBilling } from '@/modules/sales/billing';
import {
  CREDIT_MEMO_POST_CAPABILITY,
  CREDIT_MEMO_RELEASE_CAPABILITY,
  CREDIT_MEMO_REQUEST_CAPABILITY,
  CREDIT_MEMO_ROUTE,
  CreditMemoError,
  createCreditMemo,
  createCreditMemoRequest,
  postCreditMemo,
  releaseBillingBlock,
} from '@/modules/sales/credit-memo';

const ROUTE = CREDIT_MEMO_ROUTE;
const LINE_SLOTS = 10;

export interface CreditRequestActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  orderNumber?: string;
  billingNumber?: string;
  invoiceNumber?: string;
  /** The version the raised credit memo stands at, which is what posting it is guarded by. */
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

/** A refusal is reported in the credit memo engine's own words, with the remedy it names. */
function refuse(error: unknown): CreditRequestActionState {
  if (error instanceof CreditMemoError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

/**
 * The lines a form submitted: one per invoiced line in dispute, or being credited. A row with no
 * quantity is not a line — the form leaves the lines it does not want untouched rather than
 * submitting zeroes.
 */
function linesFrom(form: FormData): Array<{ billingLineNumber: number; quantity: number }> {
  const items: Array<{ billingLineNumber: number; quantity: number }> = [];
  for (let slot = 1; slot <= LINE_SLOTS; slot += 1) {
    const billingLineNumber = text(form, `line-${slot}-billingLine`);
    const quantity = text(form, `line-${slot}-quantity`);
    if (!billingLineNumber || !quantity) continue;
    items.push({ billingLineNumber: Number(billingLineNumber), quantity: Number(quantity) });
  }
  return items;
}

/**
 * Raise the complaint.
 *
 * What is created is held: the request carries a billing block, and the block says why. That is not a
 * formality to be cleared later by the same hand — it is the difference between a customer asking for
 * money back and the company agreeing they should have it. The block reason is therefore required
 * here, even though the service will supply a default: a block that says nothing is a block nobody
 * can review.
 */
export async function createCreditMemoRequestAction(
  _previous: CreditRequestActionState,
  form: FormData,
): Promise<CreditRequestActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CREDIT_MEMO_REQUEST_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the credit memo request capability.',
      remedy: 'Ask for SALES.CREDIT.REQUEST.CREATE.',
    };
  }
  const items = linesFrom(form);
  if (!items.length) {
    return {
      ok: false,
      message: 'No invoiced line was given a quantity in dispute.',
      remedy: 'Name at least one invoiced line, and how much of it the customer disputes.',
    };
  }
  try {
    const result = await createCreditMemoRequest({
      client: session.user.client,
      changedBy: session.user.username,
      requestKey: text(form, 'requestKey') || `CRQ-${session.user.username}-${Date.now()}`,
      billingNumber: text(form, 'billingNumber'),
      orderDate: text(form, 'orderDate'),
      blockReason: optional(form, 'blockReason'),
      headerText: optional(form, 'headerText'),
      items,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      orderNumber: result.orderNumber,
      message: result.replayed
        ? `Credit memo request ${result.orderNumber} was already raised by this submission; nothing was raised twice.`
        : `Credit memo request ${result.orderNumber} raised against ${text(form, 'billingNumber')}, and held: ${result.billingBlock}.`,
      remedy: result.replayed
        ? undefined
        : 'Nothing can be credited from it yet. Somebody with SALES.CREDIT.RELEASE releases the block, and only then is the credit raised.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Release the block: the act that agrees to the complaint.
 *
 * The version the screen read travels with the form, so a request somebody else has moved on since is
 * refused rather than released twice. Who released it, and that they did, is written into the change
 * history by the service — which is what makes the control worth having rather than a formality.
 */
export async function releaseBillingBlockAction(
  _previous: CreditRequestActionState,
  form: FormData,
): Promise<CreditRequestActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CREDIT_MEMO_RELEASE_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the credit release capability.',
      remedy: 'Ask for SALES.CREDIT.RELEASE. Raising a request is not agreeing to it, and the two are held apart on purpose.',
    };
  }
  const orderNumber = text(form, 'orderNumber');
  try {
    const result = await releaseBillingBlock({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber,
      expectedVersion: Number(text(form, 'expectedVersion') || '0'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      orderNumber: result.orderNumber,
      message: `Credit memo request ${result.orderNumber} released.`,
      remedy: `The block is lifted and the request now stands at version ${result.version}. Raise the credit from it while it stands released.`,
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Raise the credit memo from a released request.
 *
 * The request bounds it — per line, by what was asked for less what has already been credited — and it
 * is priced from the invoiced line rather than from the form. The service refuses a request that still
 * stands blocked, and names the block and the act that lifts it, so the screen never has to.
 */
export async function createCreditMemoAction(
  _previous: CreditRequestActionState,
  form: FormData,
): Promise<CreditRequestActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CREDIT_MEMO_POST_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the credit memo capability.',
      remedy: 'Ask for SALES.CREDIT.MEMO.POST.',
    };
  }
  const items = linesFrom(form);
  if (!items.length) {
    return {
      ok: false,
      message: 'No line was given a quantity to credit.',
      remedy: 'Name the invoiced lines being credited, and how much of each.',
    };
  }
  try {
    const result = await createCreditMemo({
      client: session.user.client,
      changedBy: session.user.username,
      requestKey: text(form, 'requestKey') || `CM-${session.user.username}-${Date.now()}`,
      billingNumber: text(form, 'billingNumber'),
      billingDate: text(form, 'billingDate'),
      headerText: optional(form, 'headerText'),
      creditMemoRequestNumber: text(form, 'creditMemoRequestNumber'),
      items,
    });
    revalidatePath(ROUTE);
    // The version the document stands at, so the post below is guarded by what the screen just read
    // rather than by a guess. A credit memo that was raised elsewhere carries its own, and it is asked
    // for rather than assumed.
    const raised = await getBilling(session.user.client, result.billingNumber);
    return {
      ok: true,
      billingNumber: result.billingNumber,
      version: raised?.version,
      message: result.replayed
        ? `Credit memo ${result.billingNumber} was already raised by this submission; nothing was raised twice.`
        : `Credit memo ${result.billingNumber} raised for ${result.grossValue}.`,
      remedy: result.replayed
        ? undefined
        : 'It stands open until it is posted: raising the credit is not giving the money back yet.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Post the credit memo: the receivable comes down and the revenue goes back. */
export async function postCreditMemoAction(
  _previous: CreditRequestActionState,
  form: FormData,
): Promise<CreditRequestActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CREDIT_MEMO_POST_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the credit memo capability.',
      remedy: 'Ask for SALES.CREDIT.MEMO.POST.',
    };
  }
  const billingNumber = text(form, 'billingNumber');
  try {
    const result = await postCreditMemo({
      client: session.user.client,
      changedBy: session.user.username,
      billingNumber,
      expectedVersion: Number(text(form, 'expectedVersion') || '0'),
      postingDate: text(form, 'postingDate'),
      requestKey: text(form, 'requestKey') || `CM-POST-${session.user.username}-${Date.now()}`,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      billingNumber: result.billingNumber,
      invoiceNumber: result.invoiceNumber,
      message: `Credit memo ${result.billingNumber} posted as invoice ${result.invoiceNumber}, accounting document ${result.journalDocumentNumber}.`,
      remedy: 'The customer has their money back, and the revenue has gone back through the account it came from.',
    };
  } catch (error) {
    return refuse(error);
  }
}
