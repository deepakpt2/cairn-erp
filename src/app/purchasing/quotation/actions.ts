'use server';

/**
 * SCR-157 — the quotation screen's door.
 *
 * Open writes nothing. Check calls the preview and writes nothing, including
 * the number. Save calls the service. A price, a status, a currency, a
 * rejection, an award, a condition, a company code, a revision and a request
 * key are passed through, so the service refuses them by name rather than the
 * action quietly dropping them. This screen does not compare.
 */
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  QUOTATION_CAPABILITY,
  QUOTATION_ROUTE,
  QuotationError,
  changeQuotation,
  createQuotation,
  previewQuotation,
  previewQuotationChange,
  type QuotationInput,
  type QuotationLineInput,
  type QuotationPreview,
} from '@/modules/purchasing/quotation';

export interface QuotationActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  wrote?: boolean;
  quotationNumber?: string | null;
  rfqNumber?: string;
  preview?: QuotationPreview | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function named(form: FormData, pattern: RegExp): boolean {
  return [...form.keys()].some((name) => pattern.test(name));
}

function missing(): QuotationActionState {
  return {
    ok: false,
    message: `You do not hold the quotation capability (${QUOTATION_CAPABILITY}). A purchase-order permission does not maintain a quotation.`,
  };
}

function refused(caught: unknown): QuotationActionState | null {
  if (caught instanceof QuotationError || caught instanceof EnqueueError) return { ok: false, message: caught.message, remedy: caught.remedy };
  return null;
}

function blocked(form: FormData): QuotationActionState | null {
  if (named(form, /^(postingDate|movementType)$/)) {
    return { ok: false, message: 'This screen does not post a goods movement or a journal.' };
  }
  return null;
}

function extras(form: FormData): Partial<QuotationInput> {
  const extra: Partial<QuotationInput> = {};
  if (text(form, 'companyCode')) extra.companyCode = text(form, 'companyCode');
  if (text(form, 'status')) extra.status = text(form, 'status');
  if (text(form, 'currency')) extra.currency = text(form, 'currency');
  if (text(form, 'requestKey')) extra.requestKey = text(form, 'requestKey');
  if (text(form, 'outbox')) extra.outbox = text(form, 'outbox');
  if (text(form, 'revision')) extra.revision = text(form, 'revision');
  if (text(form, 'receivedAt')) extra.receivedAt = text(form, 'receivedAt');
  if (text(form, 'award')) extra.award = text(form, 'award');
  if (text(form, 'comparison')) extra.comparison = text(form, 'comparison');
  if (text(form, 'rejection')) extra.rejection = text(form, 'rejection');
  if (text(form, 'withdrawal')) extra.withdrawal = text(form, 'withdrawal');
  if (text(form, 'condition')) extra.condition = text(form, 'condition');
  if (text(form, 'freight')) extra.freight = text(form, 'freight');
  if (text(form, 'tax')) extra.tax = text(form, 'tax');
  if (text(form, 'discount')) extra.discount = text(form, 'discount');
  if (text(form, 'minimumOrderQuantity')) extra.minimumOrderQuantity = text(form, 'minimumOrderQuantity');
  if (text(form, 'infoRecord')) extra.infoRecord = text(form, 'infoRecord');
  if (text(form, 'price')) extra.price = text(form, 'price');
  if (text(form, 'unitPrice')) extra.unitPrice = text(form, 'unitPrice');
  if (text(form, 'normalizedPrice')) extra.normalizedPrice = text(form, 'normalizedPrice');
  if (text(form, 'orderNumber')) extra.orderNumber = text(form, 'orderNumber');
  if (text(form, 'requisitionNumber')) extra.requisitionNumber = text(form, 'requisitionNumber');
  if (text(form, 'id')) extra.id = text(form, 'id');
  if (text(form, 'partnerNumber')) extra.partnerNumber = text(form, 'partnerNumber');
  if (text(form, 'deleteItem')) extra.deleteItem = true;
  const postedNumber = text(form, 'quotationNumber');
  if (postedNumber) extra.quotationNumber = postedNumber;
  return extra;
}

function linesOf(form: FormData): QuotationLineInput[] {
  const count = Number(text(form, 'lineCount') || '0');
  const lines: QuotationLineInput[] = [];
  for (let index = 0; index < count; index += 1) {
    const standing = form.has(`line${index}Standing`);
    const quantity = text(form, `line${index}Quantity`);
    const unit = text(form, `line${index}Unit`);
    const netPrice = text(form, `line${index}NetPrice`);
    const priceUnit = text(form, `line${index}PriceUnit`);
    const delivery = text(form, `line${index}Delivery`);
    const remark = text(form, `line${index}Remark`);
    const intentional = netPrice || priceUnit || remark
      || text(form, `line${index}Price`)
      || text(form, `line${index}UnitPrice`)
      || text(form, `line${index}Plant`)
      || text(form, `line${index}Material`)
      || text(form, `line${index}Condition`);
    if (!standing && !intentional) continue;
    const line: QuotationLineInput = { itemNumber: text(form, `line${index}Item`) || null };
    if (form.has(`line${index}Quantity`)) line.quantity = quantity || null;
    if (form.has(`line${index}Unit`)) line.unit = unit || null;
    if (form.has(`line${index}NetPrice`)) line.netPrice = netPrice || null;
    if (form.has(`line${index}PriceUnit`)) line.priceUnit = priceUnit || null;
    if (form.has(`line${index}Delivery`)) line.deliveryDate = delivery || null;
    if (form.has(`line${index}Remark`)) line.remark = remark || null;
    if (text(form, `line${index}Price`)) line.price = text(form, `line${index}Price`);
    if (text(form, `line${index}UnitPrice`)) line.unitPrice = text(form, `line${index}UnitPrice`);
    if (text(form, `line${index}Plant`)) line.plant = text(form, `line${index}Plant`);
    if (text(form, `line${index}Material`)) line.materialNumber = text(form, `line${index}Material`);
    if (text(form, `line${index}Condition`)) line.condition = text(form, `line${index}Condition`);
    if (text(form, `line${index}Freight`)) line.freight = text(form, `line${index}Freight`);
    if (text(form, `line${index}Tax`)) line.tax = text(form, `line${index}Tax`);
    if (text(form, `line${index}Discount`)) line.discount = text(form, `line${index}Discount`);
    if (text(form, `line${index}Minimum`)) line.minimumOrderQuantity = text(form, `line${index}Minimum`);
    lines.push(line);
  }
  return lines;
}

function inputOf(form: FormData, client: string, changedBy: string): QuotationInput {
  const changing = form.has('expectedChangedAt');
  return {
    client,
    changedBy,
    rfqNumber: text(form, 'rfqNumber'),
    expectedChangedAt: changing ? (text(form, 'expectedChangedAt') || null) : null,
    reason: text(form, 'reason') || null,
    lines: linesOf(form),
    ...extras(form),
  };
}

export async function checkQuotationAction(
  _previous: QuotationActionState,
  form: FormData,
): Promise<QuotationActionState> {
  const session = await requireSession(QUOTATION_ROUTE);
  if (!can(session, QUOTATION_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  try {
    const input = inputOf(form, session.user.client, session.user.username);
    const preview = form.has('expectedChangedAt')
      ? await previewQuotationChange(input)
      : await previewQuotation(input);
    return {
      ok: true,
      wrote: false,
      quotationNumber: preview.quotationNumber,
      rfqNumber: preview.rfqNumber,
      preview,
      message: preview.message,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function saveQuotationAction(
  _previous: QuotationActionState,
  form: FormData,
): Promise<QuotationActionState> {
  const session = await requireSession(QUOTATION_ROUTE);
  if (!can(session, QUOTATION_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  try {
    const input = inputOf(form, session.user.client, session.user.username);
    if (input.rfqNumber) {
      await assertChangeForSession(session, { lockObject: 'SUPPLIER_QUOTATION', argument: input.rfqNumber });
    }
    const saved = form.has('expectedChangedAt')
      ? await changeQuotation(input)
      : await createQuotation(input);
    revalidatePath(QUOTATION_ROUTE);
    return {
      ok: true,
      wrote: true,
      quotationNumber: saved.quotationNumber,
      rfqNumber: saved.rfqNumber,
      message: `Quotation ${saved.quotationNumber} stands. Nothing was posted.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}
