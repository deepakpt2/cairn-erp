'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  INCOMPLETION_CAPABILITY,
  IncompletionError,
  assignIncompletionProcedure,
  changeIncompletionStatusGroupStatus,
  saveIncompletionProcedure,
  saveIncompletionProcedureField,
  saveIncompletionStatusGroup,
  withdrawIncompletionAssignment,
  withdrawIncompletionProcedureField,
} from '@/modules/sales/incompletion';

export interface IncompletionActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/config/incompletion';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function flag(form: FormData, name: string): boolean {
  const raw = text(form, name);
  return raw === 'on' || raw === 'true' || raw === 'yes';
}

function refuse(error: unknown): IncompletionActionState {
  if (error instanceof IncompletionError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function denied(): IncompletionActionState {
  return {
    ok: false,
    message: `You do not hold the authority ${INCOMPLETION_CAPABILITY}.`,
    remedy: 'Ask an administrator for an exact-code role assignment; wildcard role patterns do not grant this authority.',
  };
}

/** Name what a missing field stops. */
export async function saveIncompletionStatusGroupAction(
  _previous: IncompletionActionState,
  form: FormData,
): Promise<IncompletionActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INCOMPLETION_CAPABILITY)) return denied();
  try {
    const statusGroup = text(form, 'statusGroup').toUpperCase();
    const blocked = {
      blocksDelivery: flag(form, 'blocksDelivery'),
      blocksGoodsIssue: flag(form, 'blocksGoodsIssue'),
      blocksBilling: flag(form, 'blocksBilling'),
      blocksOutput: flag(form, 'blocksOutput'),
    };
    const standing = text(form, 'standing') === 'true';
    await saveIncompletionStatusGroup({
      client: session.user.client,
      changedBy: session.user.username,
      statusGroup,
      name: text(form, 'name'),
      ...blocked,
    });
    revalidatePath(ROUTE);
    const stops = [
      blocked.blocksDelivery && 'delivery',
      blocked.blocksGoodsIssue && 'goods issue',
      blocked.blocksBilling && 'billing',
      blocked.blocksOutput && 'output',
    ].filter((value): value is string => typeof value === 'string');
    return {
      ok: true,
      message: standing
        ? `Status group ${statusGroup} stands again, and a missing field it judges stops ${stops.join(', ') || 'nothing'}.`
        : `Status group ${statusGroup} stands. A field named by it stops ${stops.join(', ') || 'nothing at all, which is the way to say record this and stop nothing'}.`,
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Withdraw a status group, or restore one. */
export async function changeIncompletionStatusGroupAction(
  _previous: IncompletionActionState,
  form: FormData,
): Promise<IncompletionActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INCOMPLETION_CAPABILITY)) return denied();
  try {
    const isActive = flag(form, 'isActive');
    const statusGroup = text(form, 'statusGroup');
    await changeIncompletionStatusGroupStatus({
      client: session.user.client,
      changedBy: session.user.username,
      statusGroup,
      isActive,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: isActive
        ? `Status group ${statusGroup} stands again.`
        : `Status group ${statusGroup} is withdrawn. A procedure cannot be given a field that names it.`,
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Name a procedure: a list of the fields a document of one group must carry. */
export async function saveIncompletionProcedureAction(
  _previous: IncompletionActionState,
  form: FormData,
): Promise<IncompletionActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INCOMPLETION_CAPABILITY)) return denied();
  try {
    const procedureCode = text(form, 'procedureCode').toUpperCase();
    await saveIncompletionProcedure({
      client: session.user.client,
      changedBy: session.user.username,
      procedureCode,
      groupCode: text(form, 'groupCode').toUpperCase(),
      name: text(form, 'name'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Procedure ${procedureCode} stands. It judges nothing until it is given fields, and is assigned to a document type.`,
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Give a procedure a field, in the sequence the fields are reported in. */
export async function saveIncompletionProcedureFieldAction(
  _previous: IncompletionActionState,
  form: FormData,
): Promise<IncompletionActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INCOMPLETION_CAPABILITY)) return denied();
  try {
    const [tableName, fieldName] = text(form, 'field').split('.');
    const procedureCode = text(form, 'procedureCode');
    const isWarning = flag(form, 'isWarning');
    await saveIncompletionProcedureField({
      client: session.user.client,
      changedBy: session.user.username,
      procedureCode,
      tableName: tableName ?? '',
      fieldName: fieldName ?? '',
      sequence: Number(text(form, 'sequence')) || 0,
      statusGroup: text(form, 'statusGroup').toUpperCase(),
      isWarning,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: isWarning
        ? `Procedure ${procedureCode} records ${fieldName} as a warning: it will be listed and will stop nothing.`
        : `Procedure ${procedureCode} now checks ${fieldName}.`,
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Take a field out of a procedure. */
export async function withdrawIncompletionProcedureFieldAction(
  _previous: IncompletionActionState,
  form: FormData,
): Promise<IncompletionActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INCOMPLETION_CAPABILITY)) return denied();
  try {
    const [tableName, fieldName] = text(form, 'field').split('.');
    await withdrawIncompletionProcedureField({
      client: session.user.client,
      changedBy: session.user.username,
      procedureCode: text(form, 'procedureCode'),
      tableName: tableName ?? '',
      fieldName: fieldName ?? '',
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Procedure ${text(form, 'procedureCode')} no longer checks ${fieldName}. Documents already judged keep the log they stand at until they are changed.`,
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Assign a procedure to a document type — the act that makes any of it bite. */
export async function assignIncompletionProcedureAction(
  _previous: IncompletionActionState,
  form: FormData,
): Promise<IncompletionActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INCOMPLETION_CAPABILITY)) return denied();
  try {
    const documentType = text(form, 'documentType');
    const procedureCode = text(form, 'procedureCode');
    await assignIncompletionProcedure({
      client: session.user.client,
      changedBy: session.user.username,
      documentCategory: text(form, 'documentCategory') === 'DELIVERY' ? 'DELIVERY' : 'ORDER',
      documentType,
      procedureCode,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Document type ${documentType} is now judged by ${procedureCode}. Documents raised from now on carry the log of what they are missing.`,
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Withdraw an assignment, so the type is judged no more. */
export async function withdrawIncompletionAssignmentAction(
  _previous: IncompletionActionState,
  form: FormData,
): Promise<IncompletionActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INCOMPLETION_CAPABILITY)) return denied();
  try {
    const documentType = text(form, 'documentType');
    const procedureCode = text(form, 'procedureCode');
    await withdrawIncompletionAssignment({
      client: session.user.client,
      changedBy: session.user.username,
      documentCategory: text(form, 'documentCategory') === 'DELIVERY' ? 'DELIVERY' : 'ORDER',
      documentType,
      procedureCode,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Document type ${documentType} is no longer judged by ${procedureCode}. Documents already written keep the log they stand at.`,
    };
  } catch (error) {
    return refuse(error);
  }
}
