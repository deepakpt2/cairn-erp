'use server';

/**
 * SCR-155 / SCR-156 — the request-for-quotation screen's door.
 *
 * Check calls the preview and writes nothing, including either number. Save
 * calls the service. A change check calls the change preview and writes
 * nothing, including the change document. A price, a status, a delivery
 * channel, a quotation, a notification, a revision and a request key are
 * passed through, so the service refuses them by name rather than the action
 * quietly dropping them.
 */
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  RFQ_CAPABILITY,
  RFQ_ROUTE,
  RfqError,
  changeRequestForQuotation,
  createRequestForQuotation,
  previewRequestForQuotation,
  previewRequestForQuotationChange,
  type RfqChangeInput,
  type RfqChangePreview,
  type RfqCreateInput,
  type RfqLineInput,
  type RfqSupplierInput,
  type StandingRfqLine,
} from '@/modules/purchasing/rfq';

export interface RfqActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  eventNumber?: string | null;
  rfqNumbers?: string[];
  wrote?: boolean;
  currency?: string;
  lines?: StandingRfqLine[];
  requests?: Array<{ rfqNumber: string | null; partnerNumber: string }>;
  rfqNumber?: string | null;
  change?: RfqChangePreview | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function named(form: FormData, pattern: RegExp): boolean {
  return [...form.keys()].some((name) => pattern.test(name));
}

function missing(): RfqActionState {
  return {
    ok: false,
    message: `You do not hold the request for quotation capability (${RFQ_CAPABILITY}). A purchase-order permission does not create a request.`,
  };
}

function refused(caught: unknown): RfqActionState | null {
  if (caught instanceof RfqError) return { ok: false, message: caught.message, remedy: caught.remedy };
  return null;
}

function blocked(form: FormData): RfqActionState | null {
  if (named(form, /^(postingDate|movementType)$/)) {
    return { ok: false, message: 'This screen does not post a goods movement or a journal.' };
  }
  return null;
}

function extras(form: FormData): Partial<RfqCreateInput> {
  const extra: Partial<RfqCreateInput> = {};
  if (text(form, 'eventNumber')) extra.eventNumber = text(form, 'eventNumber');
  if (text(form, 'rfqNumber')) extra.rfqNumber = text(form, 'rfqNumber');
  if (text(form, 'companyCode')) extra.companyCode = text(form, 'companyCode');
  if (text(form, 'status')) extra.status = text(form, 'status');
  if (text(form, 'deliveryChannel')) extra.deliveryChannel = text(form, 'deliveryChannel');
  if (text(form, 'contactId')) extra.contactId = text(form, 'contactId');
  if (text(form, 'sentAt')) extra.sentAt = text(form, 'sentAt');
  if (text(form, 'deliveryReference')) extra.deliveryReference = text(form, 'deliveryReference');
  if (text(form, 'requestKey')) extra.requestKey = text(form, 'requestKey');
  if (text(form, 'price')) extra.price = text(form, 'price');
  if (text(form, 'quotationNumber')) extra.quotationNumber = text(form, 'quotationNumber');
  if (text(form, 'award')) extra.award = text(form, 'award');
  if (text(form, 'comparison')) extra.comparison = text(form, 'comparison');
  if (text(form, 'requisitionNumber')) extra.requisitionNumber = text(form, 'requisitionNumber');
  if (text(form, 'orderNumber')) extra.orderNumber = text(form, 'orderNumber');
  if (text(form, 'outbox')) extra.outbox = text(form, 'outbox');
  if (text(form, 'id')) extra.id = text(form, 'id');
  if (text(form, 'currency')) extra.currency = text(form, 'currency');
  if (text(form, 'deleteEvent')) extra.deleteEvent = true;
  return extra;
}

function linesOf(form: FormData): RfqLineInput[] {
  const count = Number(text(form, 'lineCount') || '0');
  const lines: RfqLineInput[] = [];
  for (let index = 0; index < count; index += 1) {
    const material = text(form, `line${index}Material`);
    const shortText = text(form, `line${index}Text`);
    const quantity = text(form, `line${index}Quantity`);
    const unit = text(form, `line${index}Unit`);
    const plant = text(form, `line${index}Plant`);
    const storage = text(form, `line${index}Storage`);
    const delivery = text(form, `line${index}Delivery`);
    if (!material && !shortText && !quantity && !unit && !plant && !storage && !delivery) continue;
    const line: RfqLineInput = {
      materialNumber: material || null,
      shortText: shortText || null,
      quantity: quantity || null,
      unit: unit || null,
      plant: plant || null,
      storageLocation: storage || null,
      deliveryDate: delivery || null,
    };
    if (text(form, `line${index}Item`)) line.itemNumber = text(form, `line${index}Item`);
    if (text(form, `line${index}Price`)) line.price = text(form, `line${index}Price`);
    if (text(form, `line${index}DeliveryLocation`)) line.deliveryLocation = text(form, `line${index}DeliveryLocation`);
    if (text(form, `line${index}Requisition`)) line.requisitionNumber = text(form, `line${index}Requisition`);
    lines.push(line);
  }
  return lines;
}

function suppliersOf(form: FormData): RfqSupplierInput[] {
  const count = Number(text(form, 'supplierCount') || '0');
  const suppliers: RfqSupplierInput[] = [];
  for (let index = 0; index < count; index += 1) {
    const partner = text(form, `supplier${index}Partner`);
    const rfqNumber = text(form, `supplier${index}Number`);
    const contact = text(form, `supplier${index}Contact`);
    const channel = text(form, `supplier${index}Channel`);
    if (!partner && !rfqNumber && !contact && !channel) continue;
    suppliers.push({
      partnerNumber: partner || null,
      rfqNumber: rfqNumber || null,
      contactId: contact || null,
      deliveryChannel: channel || null,
    });
  }
  return suppliers;
}

function createInput(form: FormData, client: string, changedBy: string): RfqCreateInput {
  return {
    client,
    changedBy,
    documentType: text(form, 'documentType') || null,
    purchasingOrg: text(form, 'purchasingOrg'),
    purchasingGroup: text(form, 'purchasingGroup'),
    rfqDate: text(form, 'rfqDate'),
    quotationDeadline: text(form, 'quotationDeadline'),
    collectiveNumber: text(form, 'collectiveNumber') || null,
    suppliers: suppliersOf(form),
    lines: linesOf(form),
    ...extras(form),
  };
}

export async function checkRfqAction(
  _previous: RfqActionState,
  form: FormData,
): Promise<RfqActionState> {
  const session = await requireSession(RFQ_ROUTE);
  if (!can(session, RFQ_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  try {
    const preview = await previewRequestForQuotation(createInput(form, session.user.client, session.user.username));
    return {
      ok: true,
      wrote: false,
      eventNumber: null,
      rfqNumbers: preview.requests.map((request) => request.rfqNumber),
      currency: preview.currency,
      lines: preview.lines,
      requests: preview.requests,
      message: `A request for ${preview.purchasingOrg} can be created. Nothing was written.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function createRfqAction(
  _previous: RfqActionState,
  form: FormData,
): Promise<RfqActionState> {
  const session = await requireSession(RFQ_ROUTE);
  if (!can(session, RFQ_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  try {
    const created = await createRequestForQuotation(createInput(form, session.user.client, session.user.username));
    revalidatePath(RFQ_ROUTE);
    return {
      ok: true,
      wrote: true,
      eventNumber: created.eventNumber,
      rfqNumbers: created.rfqNumbers,
      message: `Event ${created.eventNumber} stands. Nothing was posted.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

function changeExtras(form: FormData): Partial<RfqChangeInput> {
  const extra: Partial<RfqChangeInput> = {};
  if (text(form, 'eventNumber')) extra.eventNumber = text(form, 'eventNumber');
  if (text(form, 'partnerNumber')) extra.partnerNumber = text(form, 'partnerNumber');
  if (text(form, 'purchasingOrg')) extra.purchasingOrg = text(form, 'purchasingOrg');
  if (text(form, 'rfqDate')) extra.rfqDate = text(form, 'rfqDate');
  if (text(form, 'documentType')) extra.documentType = text(form, 'documentType');
  if (text(form, 'currency')) extra.currency = text(form, 'currency');
  if (text(form, 'companyCode')) extra.companyCode = text(form, 'companyCode');
  if (text(form, 'status')) extra.status = text(form, 'status');
  if (text(form, 'deliveryChannel')) extra.deliveryChannel = text(form, 'deliveryChannel');
  if (text(form, 'contactId')) extra.contactId = text(form, 'contactId');
  if (text(form, 'sentAt')) extra.sentAt = text(form, 'sentAt');
  if (text(form, 'deliveryReference')) extra.deliveryReference = text(form, 'deliveryReference');
  if (text(form, 'requestKey')) extra.requestKey = text(form, 'requestKey');
  if (text(form, 'price')) extra.price = text(form, 'price');
  if (text(form, 'quotationNumber')) extra.quotationNumber = text(form, 'quotationNumber');
  if (text(form, 'award')) extra.award = text(form, 'award');
  if (text(form, 'comparison')) extra.comparison = text(form, 'comparison');
  if (text(form, 'requisitionNumber')) extra.requisitionNumber = text(form, 'requisitionNumber');
  if (text(form, 'orderNumber')) extra.orderNumber = text(form, 'orderNumber');
  if (text(form, 'outbox')) extra.outbox = text(form, 'outbox');
  if (text(form, 'notification')) extra.notification = text(form, 'notification');
  if (text(form, 'revision')) extra.revision = text(form, 'revision');
  if (text(form, 'id')) extra.id = text(form, 'id');
  if (text(form, 'deleteEvent') || text(form, 'deleteItem')) extra.deleteItem = true;
  if (text(form, 'supplierCount')) extra.suppliers = suppliersOf(form);
  return extra;
}

function changeLinesOf(form: FormData): RfqLineInput[] {
  const count = Number(text(form, 'lineCount') || '0');
  const lines: RfqLineInput[] = [];
  for (let index = 0; index < count; index += 1) {
    const line: RfqLineInput = { itemNumber: text(form, `line${index}Item`) || null };
    if (text(form, `line${index}Text`)) line.shortText = text(form, `line${index}Text`);
    if (text(form, `line${index}Quantity`)) line.quantity = text(form, `line${index}Quantity`);
    if (text(form, `line${index}Unit`)) line.unit = text(form, `line${index}Unit`);
    if (text(form, `line${index}Plant`)) line.plant = text(form, `line${index}Plant`);
    if (form.has(`line${index}Storage`)) line.storageLocation = text(form, `line${index}Storage`) || null;
    if (text(form, `line${index}Delivery`)) line.deliveryDate = text(form, `line${index}Delivery`);
    if (text(form, `line${index}Material`)) line.materialNumber = text(form, `line${index}Material`);
    if (text(form, `line${index}Price`)) line.price = text(form, `line${index}Price`);
    if (text(form, `line${index}DeliveryLocation`)) line.deliveryLocation = text(form, `line${index}DeliveryLocation`);
    if (text(form, `line${index}Requisition`)) line.requisitionNumber = text(form, `line${index}Requisition`);
    lines.push(line);
  }
  return lines;
}

function changeInput(form: FormData, client: string, changedBy: string): RfqChangeInput {
  return {
    client,
    changedBy,
    rfqNumber: text(form, 'rfqNumber'),
    expectedEventChangedAt: text(form, 'expectedEventChangedAt') || null,
    expectedRequestChangedAt: text(form, 'expectedRequestChangedAt') || null,
    reason: text(form, 'reason') || null,
    purchasingGroup: text(form, 'purchasingGroup'),
    quotationDeadline: text(form, 'quotationDeadline'),
    collectiveNumber: text(form, 'collectiveNumber') || null,
    lines: changeLinesOf(form),
    ...changeExtras(form),
  };
}

export async function checkChangeRfqAction(
  _previous: RfqActionState,
  form: FormData,
): Promise<RfqActionState> {
  const session = await requireSession(RFQ_ROUTE);
  if (!can(session, RFQ_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  try {
    const preview = await previewRequestForQuotationChange(changeInput(form, session.user.client, session.user.username));
    return {
      ok: true,
      wrote: false,
      eventNumber: preview.eventNumber,
      rfqNumber: preview.rfqNumber,
      change: preview,
      message: preview.message,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function changeRfqAction(
  _previous: RfqActionState,
  form: FormData,
): Promise<RfqActionState> {
  const session = await requireSession(RFQ_ROUTE);
  if (!can(session, RFQ_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  try {
    const changed = await changeRequestForQuotation(changeInput(form, session.user.client, session.user.username));
    revalidatePath(RFQ_ROUTE);
    return {
      ok: true,
      wrote: true,
      eventNumber: changed.eventNumber,
      rfqNumber: changed.rfqNumber,
      message: `Request ${changed.rfqNumber} stands. Nothing was posted.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}
