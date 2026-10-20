'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  GOODS_ISSUE_CAPABILITY,
  GOODS_ISSUE_ROUTE,
  GoodsIssueError,
  postGoodsIssue,
  type GoodsIssueView,
} from '@/modules/inventory/goods-issue';

export interface IssueActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  document?: GoodsIssueView | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function postGoodsIssueAction(
  _previous: IssueActionState,
  form: FormData,
): Promise<IssueActionState> {
  const session = await requireSession(GOODS_ISSUE_ROUTE);
  if (!can(session, GOODS_ISSUE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the goods issue capability.' };
  }
  const lines: Array<{
    materialNumber: string; plant: string; storageLocation?: string; quantity: number;
    costCenter?: string; reservationNumber?: string; reservationItem?: number; batch?: string;
  }> = [];
  for (const n of [1, 2, 3, 4]) {
    const materialNumber = text(form, `material-${n}`);
    const plant = text(form, `plant-${n}`);
    const quantity = Number(text(form, `quantity-${n}`) || '0');
    if (!materialNumber && !plant && !(quantity > 0)) continue;
    lines.push({
      materialNumber,
      plant,
      storageLocation: text(form, `sloc-${n}`) || undefined,
      quantity,
      costCenter: text(form, `costCenter-${n}`) || undefined,
      reservationNumber: text(form, `reservation-${n}`) || undefined,
      reservationItem: text(form, `reservationItem-${n}`) ? Number(text(form, `reservationItem-${n}`)) : undefined,
      batch: text(form, `batch-${n}`) || undefined,
    });
  }
  try {
    const document = await postGoodsIssue({
      client: session.user.client,
      changedBy: session.user.username,
      movementTypeCode: text(form, 'movementTypeCode'),
      postingDate: text(form, 'postingDate'),
      documentDate: text(form, 'documentDate'),
      headerText: text(form, 'headerText') || undefined,
      requestKey: text(form, 'requestKey'),
      lines,
    });
    revalidatePath(GOODS_ISSUE_ROUTE);
    return {
      ok: true,
      message: `Issued: material document ${document.materialDocumentNumber}, journal ${document.journalDocumentNumber ?? '—'}, value ${document.totalValue}.`,
      document,
    };
  } catch (error) {
    if (error instanceof GoodsIssueError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
