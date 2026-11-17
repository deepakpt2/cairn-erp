'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import {
  beginEnrolment, confirmEnrolment, disableMfa, MfaError, regenerateRecoveryCodes, setMfaRequired,
} from '@/platform/auth/mfa';
import { ACCOUNT_ROUTE } from '@/modules/platform/personal-account';

/** State for the forms that must show something once (recovery codes) or an error in place. */
export interface MfaState { ok: boolean; message?: string; remedy?: string; recoveryCodes?: string[] }

const field = (form: FormData, name: string) => (typeof form.get(name) === 'string' ? (form.get(name) as string) : '');
const fail = (error: unknown): MfaState => {
  if (error instanceof MfaError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
};
/** A forced user never reaches these: the page redirects, and the services are refused here as well. */
async function me() {
  const session = await requireSession();
  if (session.user.mustChangePassword) redirect(`${ACCOUNT_ROUTE}?section=password`);
  return session;
}

export async function beginEnrolmentAction(): Promise<void> {
  const s = await me();
  try {
    await beginEnrolment({ client: s.user.client, userId: s.user.userId, changedBy: s.user.username });
  } catch (error) {
    if (error instanceof MfaError) redirect(`${ACCOUNT_ROUTE}?section=security&error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  redirect(`${ACCOUNT_ROUTE}?section=security&setup=1`);
}

export async function confirmEnrolmentAction(_p: MfaState, form: FormData): Promise<MfaState> {
  const s = await me();
  try {
    const { recoveryCodes } = await confirmEnrolment({ client: s.user.client, userId: s.user.userId, code: field(form, 'code'), changedBy: s.user.username });
    revalidatePath(ACCOUNT_ROUTE);
    return { ok: true, message: 'Two-factor authentication is on.', recoveryCodes };
  } catch (error) { return fail(error); }
}

export async function regenerateCodesAction(_p: MfaState, form: FormData): Promise<MfaState> {
  const s = await me();
  try {
    const { recoveryCodes } = await regenerateRecoveryCodes({ client: s.user.client, userId: s.user.userId, password: field(form, 'password'), changedBy: s.user.username });
    revalidatePath(ACCOUNT_ROUTE);
    return { ok: true, message: 'New recovery codes issued. The old ones no longer work.', recoveryCodes };
  } catch (error) { return fail(error); }
}

export async function disableMfaAction(_p: MfaState, form: FormData): Promise<MfaState> {
  const s = await me();
  try {
    await disableMfa({ client: s.user.client, userId: s.user.userId, password: field(form, 'password'), code: field(form, 'code'), changedBy: s.user.username });
    revalidatePath(ACCOUNT_ROUTE);
    return { ok: true, message: 'Two-factor authentication is off.' };
  } catch (error) { return fail(error); }
}

export async function setMfaRequiredAction(form: FormData): Promise<void> {
  const s = await me();
  try {
    await setMfaRequired({ client: s.user.client, enabled: form.get('required') === '1', changedBy: s.user.username }, s.user.capabilities);
  } catch (error) {
    if (error instanceof MfaError) redirect(`${ACCOUNT_ROUTE}?section=security&error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  redirect(`${ACCOUNT_ROUTE}?section=security&ok=${encodeURIComponent('Two-factor policy saved.')}`);
}
