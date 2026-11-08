'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACCOUNT_DETERMINATION_CAPABILITY,
  AccountDeterminationMaintenanceError,
  changeAccountDeterminationStatus,
  defineAccountDetermination,
} from '@/modules/sales/account-determination-maintenance';

export interface DeterminationActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/config/sales-account-determination';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function flag(form: FormData, name: string): boolean {
  const raw = text(form, name);
  return raw === 'on' || raw === 'true' || raw === 'yes';
}

function refuse(error: unknown): DeterminationActionState {
  if (error instanceof AccountDeterminationMaintenanceError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function denied(): DeterminationActionState {
  return {
    ok: false,
    message: `You do not hold the authority ${ACCOUNT_DETERMINATION_CAPABILITY}.`,
    remedy: 'Ask an administrator for an exact-code role assignment; wildcard role patterns do not grant this authority.',
  };
}

/** Name the account one key posts to, for one chart, sales organisation and pair of groups. */
export async function defineAccountDeterminationAction(
  _previous: DeterminationActionState,
  form: FormData,
): Promise<DeterminationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ACCOUNT_DETERMINATION_CAPABILITY)) return denied();
  try {
    await defineAccountDetermination({
      client: session.user.client,
      changedBy: session.user.username,
      chartOfAccounts: text(form, 'chartOfAccounts'),
      salesOrg: text(form, 'salesOrg'),
      customerAccountAssignmentGroup: text(form, 'customerAccountAssignmentGroup'),
      materialAccountAssignmentGroup: text(form, 'materialAccountAssignmentGroup'),
      accountKey: text(form, 'accountKey'),
      glAccount: text(form, 'glAccount'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: 'The account is determined. Every document of that key posts to it from now on.' };
  } catch (error) {
    return refuse(error);
  }
}

/** Withdraw a row so it stops answering, or restore one that was withdrawn. */
export async function changeAccountDeterminationAction(
  _previous: DeterminationActionState,
  form: FormData,
): Promise<DeterminationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ACCOUNT_DETERMINATION_CAPABILITY)) return denied();
  try {
    const isActive = flag(form, 'isActive');
    await changeAccountDeterminationStatus({
      client: session.user.client,
      changedBy: session.user.username,
      chartOfAccounts: text(form, 'chartOfAccounts'),
      salesOrg: text(form, 'salesOrg'),
      customerAccountAssignmentGroup: text(form, 'customerAccountAssignmentGroup'),
      materialAccountAssignmentGroup: text(form, 'materialAccountAssignmentGroup'),
      accountKey: text(form, 'accountKey'),
      isActive,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: isActive
        ? 'The row answers again.'
        : 'The row is withdrawn. No document of that key can be posted until another row answers for it.',
    };
  } catch (error) {
    return refuse(error);
  }
}
