'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  SALES_OUTPUT_ADMIN_CAPABILITY,
  SALES_OUTPUT_CAPABILITY,
  SALES_OUTPUT_ROUTE,
  SalesOutputError,
  dispatchPendingSalesOutput,
  dispatchSalesOutput,
  determineSalesOutputsForSelection,
  reissueSalesOutput,
  saveOutputConditionRecord,
  setOutputConditionRecordStatus,
  setSalesOutputRecipient,
  type SalesOutputCategory,
} from '@/modules/sales/output';

const ROUTE = SALES_OUTPUT_ROUTE;

export interface SalesOutputActionState {
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

function category(form: FormData): SalesOutputCategory {
  const value = text(form, 'documentCategory').toUpperCase();
  if (value === 'SALES_ORDER' || value === 'DELIVERY' || value === 'BILLING') return value;
  throw new SalesOutputError(
    `${value || 'nothing'} is not a document sales sends output for.`,
    'A document is a sales order, a delivery or a billing document.',
  );
}

/** A refusal is reported in the service's own words, with the remedy it names. */
function refuse(error: unknown): SalesOutputActionState {
  if (error instanceof SalesOutputError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

/**
 * The run: determine what stands missing and dispatch what is pending. It is both the periodic path —
 * canon has no scheduler — and the way documents that stood before output existed acquire theirs.
 */
export async function runSalesOutputAction(
  _previous: SalesOutputActionState,
  form: FormData,
): Promise<SalesOutputActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_OUTPUT_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the sales output capability.',
      remedy: 'Ask for SALES.OUTPUT.PROCESS.',
    };
  }
  try {
    const determined = await determineSalesOutputsForSelection({
      client: session.user.client,
      changedBy: session.user.username,
      selection: {
        documentCategory: optional(form, 'runCategory') as SalesOutputCategory | undefined,
      },
    });
    const dispatched = await dispatchPendingSalesOutput({
      client: session.user.client,
      changedBy: session.user.username,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `The run examined ${determined.examined} documents, wrote ${determined.created} outputs that stood missing, and dispatched ${dispatched.dispatched} of what was pending${dispatched.failed ? `, with ${dispatched.failed} failing` : ''}.`,
      remedy: determined.created === 0 && dispatched.dispatched === 0
        ? 'Nothing was sent because nothing was due: a document earns an output only where a condition record stands for its sales area, document type and customer on the day it bears.'
        : 'Each dispatch kept the document as it was rendered and sent, so a copy read later is the one the customer received.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Dispatch one message. A message that already stands processed refuses: a repeat is a new output. */
export async function dispatchSalesOutputAction(
  _previous: SalesOutputActionState,
  form: FormData,
): Promise<SalesOutputActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_OUTPUT_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the sales output capability.',
      remedy: 'Ask for SALES.OUTPUT.PROCESS.',
    };
  }
  try {
    const result = await dispatchSalesOutput({
      client: session.user.client,
      changedBy: session.user.username,
      documentCategory: category(form),
      documentNumber: text(form, 'documentNumber').toUpperCase(),
      outputType: text(form, 'outputType').toUpperCase(),
      transmissionMedium: text(form, 'transmissionMedium').toUpperCase() === 'EMAIL' ? 'EMAIL' : 'PRINT',
      issueNumber: optional(form, 'issueNumber') ? Number(optional(form, 'issueNumber')) : undefined,
    });
    revalidatePath(ROUTE);
    if (result.status === 'ERROR') {
      return {
        ok: false,
        message: `The ${result.outputType} output for ${result.documentNumber} failed: ${result.errorText}`,
        remedy: 'Give the partner it is addressed to an e-mail address, or set a recipient on the message and dispatch it again.',
      };
    }
    return {
      ok: true,
      message: `The ${result.outputType} output for ${result.documentNumber} went out by ${result.transmissionMedium.toLowerCase()}${result.recipient ? ` to ${result.recipient}` : ''}, and stands processed.`,
      remedy: 'What was rendered is kept with the message, so this copy is the document the customer received and not a re-reading of masters that have moved since.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Issue the same output again: a new message beside the first, with the reason it was raised. The
 * first stands exactly as it was sent.
 */
export async function reissueSalesOutputAction(
  _previous: SalesOutputActionState,
  form: FormData,
): Promise<SalesOutputActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_OUTPUT_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the sales output capability.',
      remedy: 'Ask for SALES.OUTPUT.PROCESS.',
    };
  }
  const reason = text(form, 'reason');
  if (!reason) {
    return {
      ok: false,
      message: 'A second copy has to say why.',
      remedy: 'Give the reason the document is being sent again — a copy with no reason answers nothing when somebody asks.',
    };
  }
  try {
    const reissue = await reissueSalesOutput({
      client: session.user.client,
      changedBy: session.user.username,
      documentCategory: category(form),
      documentNumber: text(form, 'documentNumber').toUpperCase(),
      outputType: text(form, 'outputType').toUpperCase(),
      transmissionMedium: text(form, 'transmissionMedium').toUpperCase() === 'EMAIL' ? 'EMAIL' : 'PRINT',
      reason,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Issue ${reissue.issueNumber} of the ${reissue.message.outputType} output for ${reissue.message.documentNumber} went out, and issue 1 stands beside it as it was sent.`,
      remedy: reissue.message.status === 'ERROR'
        ? 'It stands in error and says why; correct the recipient and dispatch it again.'
        : 'Two issues of one document are two things that were sent, which is what makes “we sent it twice” answerable.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Set the recipient or the printer queue on a message — how a failed e-mail is made to succeed. */
export async function setSalesOutputRecipientAction(
  _previous: SalesOutputActionState,
  form: FormData,
): Promise<SalesOutputActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_OUTPUT_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the sales output capability.',
      remedy: 'Ask for SALES.OUTPUT.PROCESS.',
    };
  }
  try {
    await setSalesOutputRecipient({
      client: session.user.client,
      changedBy: session.user.username,
      documentCategory: category(form),
      documentNumber: text(form, 'documentNumber').toUpperCase(),
      outputType: text(form, 'outputType').toUpperCase(),
      transmissionMedium: text(form, 'transmissionMedium').toUpperCase() === 'EMAIL' ? 'EMAIL' : 'PRINT',
      issueNumber: optional(form, 'issueNumber') ? Number(optional(form, 'issueNumber')) : undefined,
      recipient: optional(form, 'recipient'),
      printerQueue: optional(form, 'printerQueue'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: 'The recipient was set on the message.',
      remedy: 'Dispatch it again and it goes to the address that now stands on it.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Maintain an output condition record: the decision that a customer receives something at all. Without
 * one a document earns no output, which is the rule rather than an omission.
 */
export async function saveOutputConditionAction(
  _previous: SalesOutputActionState,
  form: FormData,
): Promise<SalesOutputActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_OUTPUT_ADMIN_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the capability that decides what a customer receives.',
      remedy: 'Ask for SALES.OUTPUT.ADMIN.',
    };
  }
  try {
    const saved = await saveOutputConditionRecord({
      client: session.user.client,
      changedBy: session.user.username,
      outputType: text(form, 'outputType').toUpperCase(),
      documentCategory: (optional(form, 'documentCategory') ?? '') as SalesOutputCategory | '',
      documentType: text(form, 'documentType').toUpperCase(),
      salesOrg: text(form, 'salesOrg').toUpperCase(),
      distributionChannel: text(form, 'distributionChannel').toUpperCase(),
      division: text(form, 'division').toUpperCase(),
      customerNumber: text(form, 'customerNumber').toUpperCase(),
      transmissionMedium: text(form, 'transmissionMedium').toUpperCase() === 'EMAIL' ? 'EMAIL' : 'PRINT',
      dispatchTime: text(form, 'dispatchTime').toUpperCase() === 'PERIODIC' ? 'PERIODIC' : 'IMMEDIATE',
      partnerFunction: (optional(form, 'partnerFunction') ?? 'BP') as 'SP' | 'SH' | 'BP' | 'PY',
      printerQueue: optional(form, 'printerQueue'),
      validityFrom: text(form, 'validityFrom'),
      validityTo: text(form, 'validityTo'),
      isActive: text(form, 'isActive') !== 'false',
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Record ${saved.conditionNumber} stands at access ${saved.access} — ${saved.accessName} — and every document it answers for now earns the ${saved.outputType} output.`,
      remedy: 'Blank means any: the record is read most specific first, so a record naming a customer stands over one that names only the sales area it is sold to.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Withdraw a record, or put it back. Withdrawing one stops the output without losing the decision. */
export async function setOutputConditionStatusAction(
  _previous: SalesOutputActionState,
  form: FormData,
): Promise<SalesOutputActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SALES_OUTPUT_ADMIN_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the capability that decides what a customer receives.',
      remedy: 'Ask for SALES.OUTPUT.ADMIN.',
    };
  }
  const conditionNumber = text(form, 'conditionNumber');
  if (!conditionNumber) {
    return {
      ok: false,
      message: 'Name the record to change.',
      remedy: 'Choose one of the records that stand.',
    };
  }
  try {
    const updated = await setOutputConditionRecordStatus({
      client: session.user.client,
      changedBy: session.user.username,
      conditionNumber,
      isActive: text(form, 'isActive') !== 'false',
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Record ${updated.conditionNumber} stands ${updated.isActive ? 'active' : 'withdrawn'}.`,
      remedy: updated.isActive
        ? 'Documents that fall inside it earn its output from now on.'
        : 'Documents no longer earn its output; the decision itself is kept, and can be put back.',
    };
  } catch (error) {
    return refuse(error);
  }
}
