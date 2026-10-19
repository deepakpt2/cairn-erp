'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  ASSET_RETIRE_CAPABILITY, AssetRetirementError,
  postAssetRetirement, reverseAssetRetirement, simulateAssetRetirement,
  type RetirementPreview, type RetirementScope,
} from '@/modules/finance/asset-retirement';

export interface RetireActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  preview?: RetirementPreview;
  documentNumber?: string;
}

const ROUTE = '/finance/assets/retire';
const POST_CAPABILITY = 'FIN.JOURNAL.POST';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function fields(form: FormData) {
  const scope = (text(form, 'scope').toUpperCase() || 'COMPLETE') as RetirementScope;
  return {
    companyCode: text(form, 'companyCode'),
    assetNumber: text(form, 'assetNumber'), subNumber: text(form, 'subNumber') || '0000',
    documentDate: text(form, 'documentDate'), postingDate: text(form, 'postingDate'),
    assetValueDate: text(form, 'assetValueDate'),
    documentType: text(form, 'documentType').toUpperCase(),
    currency: text(form, 'currency').toUpperCase(),
    transactionType: text(form, 'transactionType').toUpperCase(),
    scope,
    retirementPercent: scope === 'PERCENT' ? Number(text(form, 'retirementPercent')) : undefined,
    retirementAmount: scope === 'AMOUNT' ? Number(text(form, 'retirementAmount')) : undefined,
    text: text(form, 'text') || undefined,
    reference: text(form, 'reference') || undefined,
  };
}

function wrap(error: unknown): RetireActionState {
  if (error instanceof AssetRetirementError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function simulateAction(
  _previous: RetireActionState,
  form: FormData,
): Promise<RetireActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ASSET_RETIRE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the asset retirement capability.' };
  }
  try {
    const preview = await simulateAssetRetirement({
      client: session.user.client, changedBy: session.user.username, ...fields(form),
    });
    return { ok: true, message: 'Simulation stands clean; nothing has been written.', preview };
  } catch (error) {
    return wrap(error);
  }
}

export async function postAction(
  _previous: RetireActionState,
  form: FormData,
): Promise<RetireActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ASSET_RETIRE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the asset retirement capability.' };
  }
  if (!can(session, POST_CAPABILITY)) {
    return { ok: false, message: 'Posting a retirement takes the journal posting capability, apart from retirement.' };
  }
  try {
    const result = await postAssetRetirement({
      client: session.user.client, changedBy: session.user.username,
      requestKey: text(form, 'requestKey') || crypto.randomUUID(),
      ...fields(form),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      documentNumber: result.documentNumber,
      message: `Retirement posted as document ${result.documentNumber}: ${result.retiredAcquisitionValue.toFixed(2)} ${result.currency} retired from asset ${result.assetNumber}/${result.subNumber}, loss ${result.lossAmount.toFixed(2)}, remaining ${result.remainingAcquisitionValue.toFixed(2)}.`,
    };
  } catch (error) {
    return wrap(error);
  }
}

export async function reverseAction(
  _previous: RetireActionState,
  form: FormData,
): Promise<RetireActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ASSET_RETIRE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the asset retirement capability.' };
  }
  if (!can(session, POST_CAPABILITY)) {
    return { ok: false, message: 'Reversing a retirement takes the journal posting capability, apart from retirement.' };
  }
  try {
    const result = await reverseAssetRetirement({
      client: session.user.client, changedBy: session.user.username,
      companyCode: text(form, 'companyCode'),
      assetNumber: text(form, 'assetNumber'), subNumber: text(form, 'subNumber') || '0000',
      documentNumber: text(form, 'documentNumber'), fiscalYear: Number(text(form, 'fiscalYear')),
      reversalDate: text(form, 'reversalDate'), reason: text(form, 'reason') || undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Retirement reversed by document ${result.reversalDocumentNumber}; its value record stands REVERSED and the asset's eligibility is restored.` };
  } catch (error) {
    return wrap(error);
  }
}
