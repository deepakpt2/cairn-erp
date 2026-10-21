'use server';

/**
 * SCR-153 — the source-list screen's door.
 *
 * Check calls the preview and writes nothing, including the number. Create and
 * change call the service. An agreement, a price, a quota, a ranking, a company
 * code and a request key are passed through, so the service refuses them by name
 * rather than the action quietly dropping them. A requisition and an order are
 * not fields here.
 */
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  SOURCE_LIST_CAPABILITY,
  SOURCE_LIST_ROUTE,
  SourceListError,
  changeSourceListEntry,
  createSourceListEntry,
  previewSourceListChange,
  previewSourceListEntry,
  type SourceListChangeInput,
  type SourceListChangePreview,
  type SourceListCreateInput,
} from '@/modules/purchasing/source-list';

export interface SourceListActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  sourceNumber?: string | null;
  wrote?: boolean;
  changes?: SourceListChangePreview['changes'];
}

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

function missing(): SourceListActionState {
  return {
    ok: false,
    message: `You do not hold the source list capability (${SOURCE_LIST_CAPABILITY}). A purchase-order permission does not maintain a source list.`,
  };
}

function refused(caught: unknown): SourceListActionState | null {
  if (caught instanceof SourceListError) {
    return { ok: false, message: caught.message, remedy: caught.remedy };
  }
  return null;
}

function blocked(form: FormData): SourceListActionState | null {
  if (named(form, /^(requisitionNumber|requisitionItem)$/)) {
    return { ok: false, message: 'This screen does not create or change a requisition. A requisition has no supplier, so it cannot take a source.' };
  }
  if (named(form, /^(orderNumber|netPrice)$/)) {
    return { ok: false, message: 'This screen does not create a purchase order. The order stores the source it used.' };
  }
  if (named(form, /^(postingDate|documentDate|movementType)$/)) {
    return { ok: false, message: 'This screen does not post a goods movement or a journal.' };
  }
  return null;
}

function extras(form: FormData): Partial<SourceListCreateInput> {
  const extra: Partial<SourceListCreateInput> = {};
  if (text(form, 'agreementNumber')) extra.agreementNumber = text(form, 'agreementNumber');
  if (text(form, 'agreementItem')) extra.agreementItem = Number(text(form, 'agreementItem'));
  if (text(form, 'schedulingAgreement')) extra.schedulingAgreement = text(form, 'schedulingAgreement');
  if (text(form, 'price')) extra.price = Number(text(form, 'price'));
  if (text(form, 'quota')) extra.quota = Number(text(form, 'quota'));
  if (text(form, 'ranking')) extra.ranking = Number(text(form, 'ranking'));
  if (text(form, 'companyCode')) extra.companyCode = text(form, 'companyCode');
  if (text(form, 'infoRecordNumber')) extra.infoRecordNumber = text(form, 'infoRecordNumber');
  if (text(form, 'requestKey')) extra.requestKey = text(form, 'requestKey');
  if (text(form, 'deleteEntry')) extra.deleteEntry = true;
  return extra;
}

function createInput(form: FormData, client: string, changedBy: string): SourceListCreateInput {
  return {
    client,
    changedBy,
    materialNumber: text(form, 'materialNumber'),
    plant: text(form, 'plant'),
    partnerNumber: text(form, 'partnerNumber'),
    purchasingOrg: text(form, 'purchasingOrg'),
    validFrom: text(form, 'validFrom'),
    validTo: text(form, 'validTo'),
    fixedSource: flag(form, 'fixedSource'),
    blockedSource: flag(form, 'blockedSource'),
    mrpRelevant: flag(form, 'mrpRelevant'),
    sourceListRequired: form.has('sourceListRequired') ? flag(form, 'sourceListRequired') : undefined,
    sourceNumber: text(form, 'sourceNumber') || null,
    ...extras(form),
  };
}

function changeInput(form: FormData, client: string, changedBy: string, intent: string): SourceListChangeInput {
  return {
    client,
    changedBy,
    reason: text(form, 'reason'),
    sourceNumber: text(form, 'sourceNumber'),
    expectedVersion: Number(text(form, 'expectedVersion')),
    expectedListVersion: text(form, 'expectedListVersion') === '' ? null : Number(text(form, 'expectedListVersion')),
    materialNumber: text(form, 'materialNumber') || null,
    plant: text(form, 'plant') || null,
    partnerNumber: text(form, 'partnerNumber') || null,
    purchasingOrg: text(form, 'purchasingOrg') || null,
    validFrom: text(form, 'validFrom') || null,
    validTo: text(form, 'validTo') || null,
    fixedSource: flag(form, 'fixedSource'),
    blockedSource: flag(form, 'blockedSource'),
    mrpRelevant: flag(form, 'mrpRelevant'),
    sourceListRequired: form.has('sourceListRequiredField') ? flag(form, 'sourceListRequired') : undefined,
    markDeleted: intent === 'deactivate',
    reactivate: intent === 'reactivate',
    ...extras(form),
  };
}

export async function checkSourceListAction(
  _previous: SourceListActionState,
  form: FormData,
): Promise<SourceListActionState> {
  const session = await requireSession(SOURCE_LIST_ROUTE);
  if (!can(session, SOURCE_LIST_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  try {
    const preview = await previewSourceListEntry(createInput(form, session.user.client, session.user.username));
    return {
      ok: true,
      wrote: false,
      sourceNumber: preview.sourceNumber,
      message: `A source for ${preview.partnerNumber} at plant ${preview.plant} can be created. Nothing was written.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function checkChangeSourceListAction(
  _previous: SourceListActionState,
  form: FormData,
): Promise<SourceListActionState> {
  const session = await requireSession(SOURCE_LIST_ROUTE);
  if (!can(session, SOURCE_LIST_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  try {
    const preview = await previewSourceListChange(
      changeInput(form, session.user.client, session.user.username, 'change'),
    );
    return {
      ok: true,
      wrote: false,
      sourceNumber: preview.sourceNumber,
      changes: preview.changes,
      message: `Source ${preview.sourceNumber} can be saved. Nothing was written.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function createSourceListAction(
  _previous: SourceListActionState,
  form: FormData,
): Promise<SourceListActionState> {
  const session = await requireSession(SOURCE_LIST_ROUTE);
  if (!can(session, SOURCE_LIST_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  try {
    const created = await createSourceListEntry(createInput(form, session.user.client, session.user.username));
    revalidatePath(SOURCE_LIST_ROUTE);
    return {
      ok: true,
      wrote: true,
      sourceNumber: created.sourceNumber,
      message: `Source ${created.sourceNumber} stands. Nothing was posted.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}

export async function changeSourceListAction(
  _previous: SourceListActionState,
  form: FormData,
): Promise<SourceListActionState> {
  const session = await requireSession(SOURCE_LIST_ROUTE);
  if (!can(session, SOURCE_LIST_CAPABILITY)) return missing();
  const stop = blocked(form);
  if (stop) return stop;
  const intent = text(form, 'intent') || 'change';
  try {
    const changed = await changeSourceListEntry(
      changeInput(form, session.user.client, session.user.username, intent),
    );
    revalidatePath(SOURCE_LIST_ROUTE);
    return {
      ok: true,
      wrote: true,
      sourceNumber: changed.sourceNumber,
      message: `Source ${changed.sourceNumber} stands at version ${changed.version}. Nothing was posted.`,
    };
  } catch (caught) {
    return refused(caught) ?? (() => { throw caught; })();
  }
}
