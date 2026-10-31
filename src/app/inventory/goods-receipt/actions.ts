'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, can, requireSession } from '@/platform/auth/current';
import {
  GR_POST_CAPABILITY,
  GoodsReceiptError,
  postGoodsReceipt,
  reverseGoodsReceipt,
} from '@/modules/inventory/goods-receipt';

export interface GoodsReceiptActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  documentNumber?: string;
}

const ROUTE = '/inventory/goods-receipt';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function postGoodsReceiptAction(
  _previous: GoodsReceiptActionState,
  form: FormData,
): Promise<GoodsReceiptActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, GR_POST_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the goods receipt posting capability.' };
  }
  if (!session.sessionId) {
    return { ok: false, message: 'You are not authorised to post this goods receipt.' };
  }
  const lines: Array<{ itemNumber: number; quantity: number; storageLocation?: string; batch?: string }> = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('qty-')) continue;
    const quantity = Number(value);
    if (quantity > 0) {
      const itemNumber = Number(key.slice(4));
      lines.push({
        itemNumber,
        quantity,
        storageLocation: text(form, `sloc-${itemNumber}`) || undefined,
        batch: text(form, `batch-${itemNumber}`) || undefined,
      });
    }
  }
  try {
    const doc = await postGoodsReceipt({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber: text(form, 'orderNumber'),
      documentDate: text(form, 'documentDate'),
      postingDate: text(form, 'postingDate'),
      headerText: text(form, 'headerText') || undefined,
      requestKey: text(form, 'requestKey'),
      lines,
    }, { authorization: { userId: session.user.userId, sessionId: session.sessionId } });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Goods receipt posted as material document ${doc.materialDocumentNumber}.`,
      documentNumber: doc.materialDocumentNumber,
    };
  } catch (error) {
    if (error instanceof AuthzError) return { ok: false, message: error.message, remedy: error.remedy };
    if (error instanceof GoodsReceiptError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function reverseGoodsReceiptAction(
  _previous: GoodsReceiptActionState,
  form: FormData,
): Promise<GoodsReceiptActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, GR_POST_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the goods receipt posting capability.' };
  }
  if (!session.sessionId) {
    return { ok: false, message: 'You are not authorised to post this goods receipt.' };
  }
  try {
    const doc = await reverseGoodsReceipt({
      client: session.user.client,
      changedBy: session.user.username,
      materialDocumentNumber: text(form, 'materialDocumentNumber'),
      documentDate: text(form, 'documentDate'),
      postingDate: text(form, 'postingDate'),
      requestKey: text(form, 'requestKey'),
    }, { authorization: { userId: session.user.userId, sessionId: session.sessionId } });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Reversal posted as material document ${doc.materialDocumentNumber}.`,
      documentNumber: doc.materialDocumentNumber,
    };
  } catch (error) {
    if (error instanceof AuthzError) return { ok: false, message: error.message, remedy: error.remedy };
    if (error instanceof GoodsReceiptError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
