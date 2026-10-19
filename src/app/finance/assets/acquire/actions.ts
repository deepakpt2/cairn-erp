'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  ASSET_ACQUIRE_CAPABILITY, AssetAcquisitionError,
  postAssetAcquisition, reverseAssetAcquisition, simulateAssetAcquisition,
  type AcquisitionPreview,
} from '@/modules/finance/asset-acquisition';

export interface AcquireActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  preview?: AcquisitionPreview;
  documentNumber?: string;
}

const ROUTE = '/finance/assets/acquire';
const POST_CAPABILITY = 'FIN.JOURNAL.POST';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function fields(form: FormData) {
  return {
    companyCode: text(form, 'companyCode'),
    assetNumber: text(form, 'assetNumber'), subNumber: text(form, 'subNumber') || '0000',
    documentDate: text(form, 'documentDate'), postingDate: text(form, 'postingDate'),
    assetValueDate: text(form, 'assetValueDate'),
    documentType: text(form, 'documentType').toUpperCase(),
    currency: text(form, 'currency').toUpperCase(),
    amount: Number(text(form, 'amount')),
    offsetAccount: text(form, 'offsetAccount'),
    transactionType: text(form, 'transactionType').toUpperCase(),
    text: text(form, 'text') || undefined,
    reference: text(form, 'reference') || undefined,
  };
}

function wrap(error: unknown): AcquireActionState {
  if (error instanceof AssetAcquisitionError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function simulateAction(
  _previous: AcquireActionState,
  form: FormData,
): Promise<AcquireActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ASSET_ACQUIRE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the asset acquisition capability.' };
  }
  try {
    const preview = await simulateAssetAcquisition({
      client: session.user.client, changedBy: session.user.username, ...fields(form),
    });
    return { ok: true, message: 'Simulation stands clean; nothing has been written.', preview };
  } catch (error) {
    return wrap(error);
  }
}

export async function postAction(
  _previous: AcquireActionState,
  form: FormData,
): Promise<AcquireActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ASSET_ACQUIRE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the asset acquisition capability.' };
  }
  if (!can(session, POST_CAPABILITY)) {
    return { ok: false, message: 'Posting an acquisition takes the journal posting capability, apart from acquisition.' };
  }
  try {
    const result = await postAssetAcquisition({
      client: session.user.client, changedBy: session.user.username,
      requestKey: text(form, 'requestKey') || crypto.randomUUID(),
      ...fields(form),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      documentNumber: result.documentNumber,
      message: `Acquisition posted as document ${result.documentNumber}: asset ${result.assetNumber}/${result.subNumber} now carries ${result.totalAcquiredValue.toFixed(2)} ${result.currency} acquired.`,
    };
  } catch (error) {
    return wrap(error);
  }
}

export async function reverseAction(
  _previous: AcquireActionState,
  form: FormData,
): Promise<AcquireActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ASSET_ACQUIRE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the asset acquisition capability.' };
  }
  if (!can(session, POST_CAPABILITY)) {
    return { ok: false, message: 'Reversing an acquisition takes the journal posting capability, apart from acquisition.' };
  }
  try {
    const result = await reverseAssetAcquisition({
      client: session.user.client, changedBy: session.user.username,
      companyCode: text(form, 'companyCode'),
      assetNumber: text(form, 'assetNumber'), subNumber: text(form, 'subNumber') || '0000',
      documentNumber: text(form, 'documentNumber'), fiscalYear: Number(text(form, 'fiscalYear')),
      reversalDate: text(form, 'reversalDate'), reason: text(form, 'reason') || undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Acquisition reversed by document ${result.reversalDocumentNumber}; its value record stands REVERSED with the original preserved.` };
  } catch (error) {
    return wrap(error);
  }
}
