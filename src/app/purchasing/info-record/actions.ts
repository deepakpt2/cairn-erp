'use server';

/**
 * SCR-151 — the info-record screen's door.
 *
 * Check calls the preview and writes nothing, including the number. Create and change call the
 * service. A material group, another category, tax, incoterms, confirmation control, a scale or
 * a standard quantity is passed through, so the service refuses it by name rather than the
 * action quietly dropping it. A company code, a requisition and an order are not fields here.
 */
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { PartnerError } from '@/modules/foundation/business-partners';
import { SupplierPurchasingError } from '@/modules/foundation/supplier-purchasing';
import { UnitConversionError } from '@/modules/inventory/unit-conversion';
import {
  INFO_RECORD_CAPABILITY,
  INFO_RECORD_ROUTE,
  InfoRecordError,
  changePurchasingInfoRecord,
  createPurchasingInfoRecord,
  previewPurchasingInfoRecord,
  previewPurchasingInfoRecordChange,
  type InfoRecordChangePreview,
  type InfoRecordCreateInput,
} from '@/modules/purchasing/info-record';

export interface InfoRecordActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  infoRecordNumber?: string | null;
  existing?: boolean;
  wrote?: boolean;
  changes?: InfoRecordChangePreview['changes'];
  closedInterval?: InfoRecordChangePreview['closedInterval'];
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function raw(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function named(form: FormData, pattern: RegExp): boolean {
  return [...form.keys()].some((name) => pattern.test(name));
}

function missing(): InfoRecordActionState {
  return {
    ok: false,
    message: `You do not hold the info record capability (${INFO_RECORD_CAPABILITY}). A purchase-order permission does not maintain an info record.`,
  };
}

function refused(caught: unknown): InfoRecordActionState | null {
  if (
    caught instanceof InfoRecordError
    || caught instanceof SupplierPurchasingError
    || caught instanceof PartnerError
    || caught instanceof UnitConversionError
    || caught instanceof EnqueueError
  ) {
    const remedy = 'remedy' in caught && typeof caught.remedy === 'string' ? caught.remedy : undefined;
    return { ok: false, message: caught.message, remedy };
  }
  return null;
}

function blocked(form: FormData): InfoRecordActionState | null {
  if (named(form, /^(companyCode|company_code)$/)) {
    return { ok: false, message: 'The company code is not a field of the info record. It is the purchasing organisation\'s.' };
  }
  if (named(form, /^(requisitionNumber|requisitionItem)$/)) {
    return { ok: false, message: 'This screen does not create or change a requisition. A requisition has no supplier, so it cannot take an info record.' };
  }
  if (named(form, /^(orderNumber|netPrice)$/)) {
    return { ok: false, message: 'This screen does not create a purchase order. The order keeps the price it used.' };
  }
  if (named(form, /^(postingDate|documentDate|movementType)$/)) {
    return { ok: false, message: 'This screen does not post a goods movement or a journal.' };
  }
  return null;
}

function extras(form: FormData): Partial<InfoRecordCreateInput> {
  const extra: Partial<InfoRecordCreateInput> = {};
  if (text(form, 'materialGroup')) extra.materialGroup = text(form, 'materialGroup');
  if (text(form, 'category')) extra.category = text(form, 'category');
  if (text(form, 'conditionType')) extra.conditionType = text(form, 'conditionType');
  if (text(form, 'taxCode')) extra.taxCode = text(form, 'taxCode');
  if (text(form, 'incoterms')) extra.incoterms = text(form, 'incoterms');
  if (text(form, 'confirmationControl')) extra.confirmationControl = text(form, 'confirmationControl');
  if (text(form, 'scale')) extra.scale = text(form, 'scale');
  if (text(form, 'standardQuantity')) extra.standardQuantity = Number(text(form, 'standardQuantity'));
  return extra;
}

function optionalCount(form: FormData, name: string): number | null {
  const value = text(form, name);
  return value === '' ? null : Number(value);
}

function createInput(form: FormData, client: string, changedBy: string): InfoRecordCreateInput {
  const number = text(form, 'infoRecordNumber');
  const version = text(form, 'expectedVersion');
  return {
    client,
    changedBy,
    partnerNumber: text(form, 'partnerNumber'),
    materialNumber: text(form, 'materialNumber'),
    purchasingOrg: text(form, 'purchasingOrg'),
    plant: text(form, 'plant') || null,
    infoRecordNumber: number || null,
    expectedVersion: version === '' ? null : Number(version),
    price: {
      amount: Number(text(form, 'amount')),
      currency: text(form, 'currency'),
      priceUnit: Number(text(form, 'priceUnit') || '1'),
      priceUnitOfMeasure: text(form, 'priceUnitOfMeasure'),
      validFrom: text(form, 'validFrom'),
      validTo: text(form, 'validTo'),
    },
    plannedDeliveryDays: optionalCount(form, 'plannedDeliveryDays'),
    minimumOrderQuantity: optionalCount(form, 'minimumOrderQuantity'),
    minimumOrderUnit: text(form, 'minimumOrderUnit') || null,
    orderUnit: text(form, 'orderUnit') || null,
    ...extras(form),
  };
}

export async function checkInfoRecordAction(
  _previous: InfoRecordActionState,
  form: FormData,
): Promise<InfoRecordActionState> {
  const session = await requireSession(INFO_RECORD_ROUTE);
  if (!can(session, INFO_RECORD_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  if (!text(form, 'materialNumber') && !text(form, 'materialGroup')) {
    return { ok: false, message: 'A material is required. A material-group record is not created.' };
  }
  try {
    const preview = await previewPurchasingInfoRecord(createInput(form, session.user.client, session.user.username));
    return {
      ok: true,
      wrote: false,
      existing: preview.existing,
      infoRecordNumber: preview.infoRecordNumber,
      message: preview.existing
        ? `Info record ${preview.infoRecordNumber} can take this segment. Nothing was written.`
        : 'The record can be created. Nothing was written.',
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

function changeInput(form: FormData, client: string, changedBy: string, intent: string) {
  const amount = text(form, 'amount');
  return {
    client,
    changedBy,
    reason: raw(form, 'reason'),
    infoRecordNumber: text(form, 'infoRecordNumber'),
    expectedVersion: Number(text(form, 'expectedVersion')),
    segmentNumber: text(form, 'segmentNumber') === '' ? null : Number(text(form, 'segmentNumber')),
    expectedSegmentVersion: text(form, 'expectedSegmentVersion') === '' ? null : Number(text(form, 'expectedSegmentVersion')),
    partnerNumber: text(form, 'partnerNumber') || null,
    materialNumber: text(form, 'materialNumber') || null,
    purchasingOrg: text(form, 'purchasingOrg') || null,
    plant: form.has('plant') ? text(form, 'plant') || null : undefined,
    plannedDeliveryDays: form.has('plannedDeliveryDays') ? optionalCount(form, 'plannedDeliveryDays') : undefined,
    minimumOrderQuantity: form.has('minimumOrderQuantity') ? optionalCount(form, 'minimumOrderQuantity') : undefined,
    minimumOrderUnit: form.has('minimumOrderUnit') ? text(form, 'minimumOrderUnit') || null : undefined,
    orderUnit: form.has('orderUnit') ? text(form, 'orderUnit') || null : undefined,
    markRecordDeleted: intent === 'deactivate-record',
    reactivateRecord: intent === 'reactivate-record',
    markSegmentDeleted: intent === 'deactivate-segment',
    reactivateSegment: intent === 'reactivate-segment',
    markPriceDeleted: intent === 'deactivate-price' ? Number(text(form, 'priceSequence')) : null,
    reactivatePrice: intent === 'reactivate-price' ? Number(text(form, 'priceSequence')) : null,
    newPrice: intent === 'change' && amount !== '' ? {
      amount: Number(amount),
      currency: text(form, 'currency'),
      priceUnit: Number(text(form, 'priceUnit') || '1'),
      priceUnitOfMeasure: text(form, 'priceUnitOfMeasure'),
      validFrom: text(form, 'validFrom'),
      validTo: text(form, 'validTo'),
    } : null,
  };
}

function refusedNamed(form: FormData): InfoRecordActionState | null {
  if (text(form, 'materialGroup')) {
    return {
      ok: false,
      message: 'A material-group info record is not created.',
      remedy: 'Name the material. A group record is a later round.',
    };
  }
  if (text(form, 'category') && text(form, 'category') !== 'STANDARD') {
    return { ok: false, message: `Info record category ${text(form, 'category')} is not supported. Only a standard record is created.` };
  }
  if (text(form, 'taxCode') || text(form, 'incoterms') || text(form, 'confirmationControl')) {
    return { ok: false, message: 'Tax, incoterms and confirmation control are not fields of the info record.' };
  }
  if (text(form, 'scale') || text(form, 'standardQuantity')) {
    return { ok: false, message: 'A scale and a standard quantity are not stored. One net price is the price.' };
  }
  if (text(form, 'conditionType') && text(form, 'conditionType') !== 'NET_PRICE') {
    return { ok: false, message: `Condition type ${text(form, 'conditionType')} is not supported. The price is a net price, and there is no condition-type catalogue.` };
  }
  return null;
}

export async function checkChangeInfoRecordAction(
  _previous: InfoRecordActionState,
  form: FormData,
): Promise<InfoRecordActionState> {
  const session = await requireSession(INFO_RECORD_ROUTE);
  if (!can(session, INFO_RECORD_CAPABILITY)) return missing();
  const stop = blocked(form) ?? refusedNamed(form);
  if (stop) return stop;
  try {
    const preview = await previewPurchasingInfoRecordChange(
      changeInput(form, session.user.client, session.user.username, 'change'),
    );
    return {
      ok: true,
      wrote: false,
      infoRecordNumber: preview.infoRecordNumber,
      changes: preview.changes,
      closedInterval: preview.closedInterval,
      message: preview.changes.length === 0
        ? `Nothing on segment ${text(form, 'segmentNumber')} would change. Nothing was written.`
        : `Segment ${text(form, 'segmentNumber')} can be saved. Nothing was written.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function createInfoRecordAction(
  _previous: InfoRecordActionState,
  form: FormData,
): Promise<InfoRecordActionState> {
  const session = await requireSession(INFO_RECORD_ROUTE);
  if (!can(session, INFO_RECORD_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  if (!text(form, 'materialNumber') && !text(form, 'materialGroup')) {
    return { ok: false, message: 'A material is required. A material-group record is not created.' };
  }
  try {
    const created = await createPurchasingInfoRecord(createInput(form, session.user.client, session.user.username));
    revalidatePath(INFO_RECORD_ROUTE);
    return {
      ok: true,
      wrote: true,
      infoRecordNumber: created.infoRecordNumber,
      message: `Info record ${created.infoRecordNumber} stands, segment ${created.segmentNumber}, price ${created.priceSequence}. Nothing was posted.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function changeInfoRecordAction(
  _previous: InfoRecordActionState,
  form: FormData,
): Promise<InfoRecordActionState> {
  const session = await requireSession(INFO_RECORD_ROUTE);
  if (!can(session, INFO_RECORD_CAPABILITY)) return missing();
  const stop = blocked(form) ?? refusedNamed(form);
  if (stop) return stop;
  const intent = text(form, 'intent') || 'change';
  try {
    await assertChangeForSession(session, { lockObject: 'INFO_RECORD', argument: text(form, 'infoRecordNumber') });
    const changed = await changePurchasingInfoRecord(
      changeInput(form, session.user.client, session.user.username, intent),
    );
    revalidatePath(INFO_RECORD_ROUTE);
    return {
      ok: true,
      wrote: true,
      infoRecordNumber: changed.infoRecordNumber,
      message: `Info record ${changed.infoRecordNumber} stands at version ${changed.version}. Nothing was posted.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}
