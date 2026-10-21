'use server';

/**
 * SCR-154 — the quota screen's door.
 *
 * Check calls the preview and writes nothing, including the number. Create and
 * change call the service. A supplying plant, an allocated quantity, a lot size
 * and a request key are passed through, so the service refuses them by name
 * rather than the action quietly dropping them. A requisition and an order are
 * not fields here.
 */
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  QUOTA_CAPABILITY,
  QUOTA_ROUTE,
  QuotaError,
  changeQuotaArrangement,
  createQuotaArrangement,
  previewQuotaArrangement,
  previewQuotaChange,
  previewQuotaSelection,
  type QuotaChangeInput,
  type QuotaCreateInput,
  type QuotaItemInput,
  type QuotaRating,
  type QuotaSelection,
} from '@/modules/purchasing/quota-arrangement';

export interface QuotaActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  quotaNumber?: string | null;
  wrote?: boolean;
  changes?: Array<{ field: string; before: string | null; after: string | null }>;
  ratings?: QuotaRating[];
  selection?: QuotaSelection | null;
}

const INITIAL_MESSAGE = '';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function named(form: FormData, pattern: RegExp): boolean {
  return [...form.keys()].some((name) => pattern.test(name));
}

function flag(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === 'on' || value === 'true' || value === '1';
}

function missing(): QuotaActionState {
  return {
    ok: false,
    message: `You do not hold the quota arrangement capability (${QUOTA_CAPABILITY}). A purchase-order permission does not maintain a quota arrangement.`,
  };
}

function refused(caught: unknown): QuotaActionState | null {
  if (caught instanceof QuotaError) return { ok: false, message: caught.message, remedy: caught.remedy };
  return null;
}

function blocked(form: FormData): QuotaActionState | null {
  if (named(form, /^(requisitionNumber|requisitionItem)$/)) {
    return { ok: false, message: 'This screen does not create or change a requisition. A requisition has no supplier, so it cannot take a quota.' };
  }
  if (named(form, /^(orderNumber|netPrice)$/)) {
    return { ok: false, message: 'This screen does not create a purchase order. The order is not given a quota.' };
  }
  if (named(form, /^(postingDate|movementType)$/)) {
    return { ok: false, message: 'This screen does not post a goods movement or a journal.' };
  }
  return null;
}

function extras(form: FormData): Partial<QuotaCreateInput> {
  const extra: Partial<QuotaCreateInput> = {};
  if (text(form, 'supplyingPlant')) extra.supplyingPlant = text(form, 'supplyingPlant');
  if (text(form, 'procurementType')) extra.procurementType = text(form, 'procurementType');
  if (text(form, 'allocatedQuantity')) extra.allocatedQuantity = text(form, 'allocatedQuantity');
  if (text(form, 'allocatedByItem')) extra.allocatedQuantity = text(form, 'allocatedByItem');
  if (text(form, 'minSplitQuantity')) extra.minSplitQuantity = text(form, 'minSplitQuantity');
  if (text(form, 'maxLotSize')) extra.maxLotSize = text(form, 'maxLotSize');
  if (text(form, 'unit')) extra.unit = text(form, 'unit');
  if (text(form, 'status')) extra.status = text(form, 'status');
  if (text(form, 'agreementNumber')) extra.agreementNumber = text(form, 'agreementNumber');
  if (text(form, 'price')) extra.price = Number(text(form, 'price'));
  if (text(form, 'ranking')) extra.ranking = Number(text(form, 'ranking'));
  if (text(form, 'percentage')) extra.percentage = Number(text(form, 'percentage'));
  if (text(form, 'companyCode')) extra.companyCode = text(form, 'companyCode');
  if (text(form, 'requestKey')) extra.requestKey = text(form, 'requestKey');
  if (text(form, 'deleteArrangement')) extra.deleteArrangement = true;
  if (text(form, 'quotaNumber')) extra.quotaNumber = text(form, 'quotaNumber');
  return extra;
}

function itemExtras(form: FormData, index: number): Partial<QuotaItemInput> {
  const extra: Partial<QuotaItemInput> = {};
  const supplyingPlant = text(form, `item${index}SupplyingPlant`);
  const procurementType = text(form, `item${index}ProcurementType`);
  const allocated = text(form, `item${index}Allocated`);
  const split = text(form, `item${index}MinSplit`);
  const lot = text(form, `item${index}MaxLot`);
  const unit = text(form, `item${index}Unit`);
  if (supplyingPlant) extra.supplyingPlant = supplyingPlant;
  if (procurementType) extra.procurementType = procurementType;
  if (allocated) extra.allocatedQuantity = allocated;
  if (split) extra.minSplitQuantity = split;
  if (lot) extra.maxLotSize = lot;
  if (unit) extra.unit = unit;
  return extra;
}

function createItems(form: FormData): QuotaItemInput[] {
  const count = Number(text(form, 'itemCount') || '0');
  const items: QuotaItemInput[] = [];
  for (let index = 0; index < count; index += 1) {
    const partner = text(form, `item${index}Partner`);
    const org = text(form, `item${index}Org`);
    const quota = text(form, `item${index}Quota`);
    if (!partner && !org && !quota) continue;
    items.push({
      partnerNumber: partner,
      purchasingOrg: org,
      quota: quota === '' ? null : Number(quota),
      quotaBaseQuantity: text(form, `item${index}Base`) || '0',
      itemNumber: text(form, `item${index}Number`) || null,
      ...itemExtras(form, index),
    });
  }
  return items;
}

function changeItems(form: FormData): QuotaItemInput[] {
  const count = Number(text(form, 'itemCount') || '0');
  const items: QuotaItemInput[] = [];
  for (let index = 0; index < count; index += 1) {
    const itemNumber = text(form, `item${index}Number`);
    const partner = text(form, `item${index}Partner`);
    const quota = text(form, `item${index}Quota`);
    if (!itemNumber && !partner && !quota) continue;
    items.push({
      itemNumber: itemNumber || null,
      partnerNumber: partner || null,
      purchasingOrg: text(form, `item${index}Org`) || null,
      quota: quota === '' ? null : Number(quota),
      quotaBaseQuantity: text(form, `item${index}Base`) || null,
      markDeleted: flag(form, `item${index}Deactivate`),
      reactivate: flag(form, `item${index}Reactivate`),
      ...itemExtras(form, index),
    });
  }
  return items;
}

function createInput(form: FormData, client: string, changedBy: string): QuotaCreateInput {
  return {
    client,
    changedBy,
    materialNumber: text(form, 'materialNumber'),
    plant: text(form, 'plant'),
    validFrom: text(form, 'validFrom'),
    validTo: text(form, 'validTo'),
    items: createItems(form),
    ...extras(form),
  };
}

function changeInput(form: FormData, client: string, changedBy: string, intent: string): QuotaChangeInput {
  return {
    client,
    changedBy,
    reason: text(form, 'reason'),
    quotaNumber: text(form, 'quotaNumber'),
    expectedVersion: Number(text(form, 'expectedVersion')),
    materialNumber: text(form, 'materialNumber') || null,
    plant: text(form, 'plant') || null,
    validFrom: text(form, 'validFrom') || null,
    validTo: text(form, 'validTo') || null,
    markDeleted: intent === 'deactivate',
    reactivate: intent === 'reactivate',
    items: intent === 'change' ? changeItems(form) : undefined,
    ...extras(form),
  };
}

export async function checkQuotaAction(
  _previous: QuotaActionState,
  form: FormData,
): Promise<QuotaActionState> {
  const session = await requireSession(QUOTA_ROUTE);
  if (!can(session, QUOTA_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  try {
    const preview = await previewQuotaArrangement(createInput(form, session.user.client, session.user.username));
    return {
      ok: true,
      wrote: false,
      quotaNumber: null,
      ratings: preview.ratings,
      message: `A quota arrangement for ${preview.materialNumber} at plant ${preview.plant} can be created. Nothing was written.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function createQuotaAction(
  _previous: QuotaActionState,
  form: FormData,
): Promise<QuotaActionState> {
  const session = await requireSession(QUOTA_ROUTE);
  if (!can(session, QUOTA_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  try {
    const created = await createQuotaArrangement(createInput(form, session.user.client, session.user.username));
    revalidatePath(QUOTA_ROUTE);
    return {
      ok: true,
      wrote: true,
      quotaNumber: created.quotaNumber,
      message: `Quota ${created.quotaNumber} stands. Nothing was posted.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function checkChangeQuotaAction(
  _previous: QuotaActionState,
  form: FormData,
): Promise<QuotaActionState> {
  const session = await requireSession(QUOTA_ROUTE);
  if (!can(session, QUOTA_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  try {
    const preview = await previewQuotaChange(changeInput(form, session.user.client, session.user.username, 'change'));
    return {
      ok: true,
      wrote: false,
      quotaNumber: preview.quotaNumber,
      changes: preview.changes,
      message: `Quota ${preview.quotaNumber} can be saved. Nothing was written.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function changeQuotaAction(
  _previous: QuotaActionState,
  form: FormData,
): Promise<QuotaActionState> {
  const session = await requireSession(QUOTA_ROUTE);
  if (!can(session, QUOTA_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  const intent = text(form, 'intent') || 'change';
  try {
    const changed = await changeQuotaArrangement(changeInput(form, session.user.client, session.user.username, intent));
    revalidatePath(QUOTA_ROUTE);
    return {
      ok: true,
      wrote: true,
      quotaNumber: changed.quotaNumber,
      message: `Quota ${changed.quotaNumber} stands at version ${changed.version}. Nothing was posted.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

function hasRefusedField(form: FormData): boolean {
  return [...form.keys()].some((name) => (
    /^(supplyingPlant|procurementType|allocatedQuantity|allocatedByItem|minSplitQuantity|maxLotSize|unit|status|agreementNumber|price|ranking|percentage|companyCode|requestKey|deleteArrangement)$/.test(name)
    || /SupplyingPlant|ProcurementType|Allocated|MinSplit|MaxLot|Unit$/.test(name)
  ));
}

export async function rateQuotaAction(
  _previous: QuotaActionState,
  form: FormData,
): Promise<QuotaActionState> {
  const session = await requireSession(QUOTA_ROUTE);
  if (!can(session, QUOTA_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  try {
    if (hasRefusedField(form)) {
      await previewQuotaArrangement(createInput(form, session.user.client, session.user.username));
      return { ok: false, wrote: false, message: 'A field this screen does not maintain was sent. Nothing was written.' };
    }
    const selection = await previewQuotaSelection({
      client: session.user.client,
      materialNumber: text(form, 'materialNumber'),
      plant: text(form, 'plant'),
      documentDate: text(form, 'documentDate'),
    });
    return {
      ok: true,
      wrote: false,
      quotaNumber: selection.quotaNumber,
      selection,
      ratings: selection.ratings,
      message: selection.message,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}
