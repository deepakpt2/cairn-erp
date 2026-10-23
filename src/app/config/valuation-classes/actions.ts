'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ROUTE,
  ACTIVITY,
  ValuationClassError,
  assignMaterialTypeReference,
  deleteValuationClass,
  deleteValuationReference,
  listValuationGaps,
  saveValuationClass,
  saveValuationReference,
} from '@/modules/inventory/valuation-class-definition';

export interface ValuationClassActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  valuationClass?: string;
  reference?: string;
  materialType?: string;
  replaceRequestKey?: boolean;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function many(form: FormData, name: string): string[] {
  return form.getAll(name).filter((value): value is string => typeof value === 'string' && value.trim() !== '');
}

function fail(error: unknown): ValuationClassActionState {
  if (error instanceof ValuationClassError || error instanceof EnqueueError || error instanceof AuthzError) {
    return {
      ok: false,
      message: error.message,
      remedy: error.remedy,
      replaceRequestKey: /request key/i.test(error.message),
    };
  }
  throw error;
}

function refused(form: FormData) {
  return {
    generalLedgerAccount: read(form, 'generalLedgerAccount'),
    companyCode: read(form, 'companyCode'),
    postingPeriod: read(form, 'postingPeriod'),
    transportRequest: read(form, 'transportRequest'),
    approval: read(form, 'approval'),
    version: read(form, 'version'),
    configurationVersion: read(form, 'configurationVersion'),
    status: read(form, 'status'),
  };
}

export async function saveReferenceAction(
  _previous: ValuationClassActionState,
  form: FormData,
): Promise<ValuationClassActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, {
        lockObject: 'ACCOUNT_CATEGORY_REFERENCE',
        argument: read(form, 'reference'),
      });
    }
    const result = await saveValuationReference({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      reference: read(form, 'reference'),
      name: read(form, 'name'),
      isActive: read(form, 'isActive') === 'on',
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
      expectedVersion: Number(read(form, 'expectedVersion')),
      ...refused(form),
    });
    revalidatePath(ROUTE);
    const verb = result.replayed ? 'already stood' : result.changed ? 'saved' : 'is unchanged';
    return { ok: true, reference: result.reference, message: `Account category reference ${result.reference} ${verb}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteReferenceAction(
  _previous: ValuationClassActionState,
  form: FormData,
): Promise<ValuationClassActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    await assertChangeForSession(session, {
      lockObject: 'ACCOUNT_CATEGORY_REFERENCE',
      argument: read(form, 'reference'),
    });
    const result = await deleteValuationReference({
      client: session.user.client,
      changedBy: session.user.username,
      reference: read(form, 'reference'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
      expectedVersion: Number(read(form, 'expectedVersion')),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: result.replayed
        ? `Account category reference ${result.reference} was already deleted.`
        : `Account category reference ${result.reference} deleted.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function saveClassAction(
  _previous: ValuationClassActionState,
  form: FormData,
): Promise<ValuationClassActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, {
        lockObject: 'VALUATION_CLASS',
        argument: read(form, 'valuationClass'),
      });
    }
    const result = await saveValuationClass({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      valuationClass: read(form, 'valuationClass'),
      name: read(form, 'name'),
      isActive: read(form, 'isActive') === 'on',
      references: many(form, 'reference'),
      materialTypes: many(form, 'materialType'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
      expectedVersion: Number(read(form, 'expectedVersion')),
      ...refused(form),
    });
    revalidatePath(ROUTE);
    const verb = result.replayed ? 'already stood' : result.changed ? 'saved' : 'is unchanged';
    return { ok: true, valuationClass: result.valuationClass, message: `Valuation class ${result.valuationClass} ${verb}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteClassAction(
  _previous: ValuationClassActionState,
  form: FormData,
): Promise<ValuationClassActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    await assertChangeForSession(session, {
      lockObject: 'VALUATION_CLASS',
      argument: read(form, 'valuationClass'),
    });
    const result = await deleteValuationClass({
      client: session.user.client,
      changedBy: session.user.username,
      valuationClass: read(form, 'valuationClass'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
      expectedVersion: Number(read(form, 'expectedVersion')),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: result.replayed
        ? `Valuation class ${result.valuationClass} was already deleted.`
        : `Valuation class ${result.valuationClass} deleted.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function assignTypeAction(
  _previous: ValuationClassActionState,
  form: FormData,
): Promise<ValuationClassActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    await assertChangeForSession(session, {
      lockObject: 'MATERIAL_TYPE',
      argument: read(form, 'materialType'),
    });
    const result = await assignMaterialTypeReference({
      client: session.user.client,
      changedBy: session.user.username,
      materialType: read(form, 'materialType'),
      reference: read(form, 'reference'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
      postingPeriod: read(form, 'postingPeriod'),
      transportRequest: read(form, 'transportRequest'),
    });
    revalidatePath(ROUTE);
    revalidatePath('/config/material-types');
    const verb = result.replayed ? 'already stood' : result.changed ? 'now uses' : 'already uses';
    return {
      ok: true,
      materialType: result.materialType,
      message: `Material type ${result.materialType} ${verb} reference ${read(form, 'reference').trim().toUpperCase()}. A material valuation class was not rewritten.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function checkValuationAction(
  _previous: ValuationClassActionState,
  _form: FormData,
): Promise<ValuationClassActionState> {
  const session = await requireSession(ROUTE);
  try {
    const gaps = await listValuationGaps(session.user.client);
    return {
      ok: true,
      message: gaps.length === 0
        ? 'Valuation configuration is consistent. A check writes nothing.'
        : `Valuation configuration has ${gaps.length} gap${gaps.length === 1 ? '' : 's'}. A check writes nothing. ${gaps.slice(0, 3).join(' ')}`,
    };
  } catch (error) {
    return fail(error);
  }
}
