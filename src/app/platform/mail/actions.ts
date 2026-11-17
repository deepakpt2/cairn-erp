'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  MAIL_DEFINE_CAPABILITY,
  MailError,
  saveMailConfig,
  sendTestMail,
  testMailConnection,
} from '@/platform/mail/service';
import { setSelfServiceReset, UserAdminError } from '@/modules/platform/user-admin';

const ROUTE = '/platform/mail';

export interface MailActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function refuse(error: unknown): MailActionState {
  if (error instanceof MailError || error instanceof UserAdminError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** The password is the one field that is not trimmed: whitespace can be part of it. */
function raw(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function flag(form: FormData, name: string): boolean {
  return form.get(name) === 'on' || form.get(name) === 'true';
}

async function authorised() {
  const session = await requireSession(ROUTE);
  if (!can(session, MAIL_DEFINE_CAPABILITY)) return { session, denied: refuse(new MailError('MAIL_FORBIDDEN', `Mail server configuration needs ${MAIL_DEFINE_CAPABILITY}, which this session does not hold.`, `Ask an administrator to grant ${MAIL_DEFINE_CAPABILITY} to one of your roles.`)) };
  return { session, denied: null };
}

export async function saveMailConfigAction(_previous: MailActionState, formData: FormData): Promise<MailActionState> {
  const { session, denied } = await authorised();
  if (denied) return denied;
  try {
    await saveMailConfig(
      {
        client: session.user.client,
        changedBy: session.user.username,
        host: text(formData, 'host'),
        port: Number(text(formData, 'port')),
        encryption: text(formData, 'encryption') as 'STARTTLS' | 'TLS' | 'NONE',
        username: text(formData, 'username'),
        password: raw(formData, 'password'),
        clearPassword: flag(formData, 'clearPassword'),
        senderAddress: text(formData, 'senderAddress'),
        senderName: text(formData, 'senderName'),
        isEnabled: flag(formData, 'isEnabled'),
      },
      session.user.capabilities,
    );
    revalidatePath(ROUTE);
    return { ok: true, message: 'Mail node saved.' };
  } catch (error) {
    return refuse(error);
  }
}

export async function testConnectionAction(_previous: MailActionState, _formData: FormData): Promise<MailActionState> {
  const { session, denied } = await authorised();
  if (denied) return denied;
  try {
    const outcome = await testMailConnection(
      { client: session.user.client, changedBy: session.user.username },
      session.user.capabilities,
    );
    revalidatePath(ROUTE);
    return { ok: outcome.ok, message: outcome.message };
  } catch (error) {
    return refuse(error);
  }
}

export async function sendTestMailAction(_previous: MailActionState, formData: FormData): Promise<MailActionState> {
  const { session, denied } = await authorised();
  if (denied) return denied;
  try {
    await sendTestMail(
      { client: session.user.client, changedBy: session.user.username, toAddress: text(formData, 'testAddress') },
      session.user.capabilities,
    );
    revalidatePath(ROUTE);
    return { ok: true, message: 'Test mail queued. It is sent by the next run of MAIL.SEND (every five minutes).' };
  } catch (error) {
    return refuse(error);
  }
}

/** Authentication policy, saved on the mail screen: the screen needs DEFINE, the service needs USER.MAINTAIN. */
export async function saveSelfServiceResetAction(_previous: MailActionState, formData: FormData): Promise<MailActionState> {
  const { session, denied } = await authorised();
  if (denied) return denied;
  try {
    const { enabled } = await setSelfServiceReset(
      { client: session.user.client, enabled: formData.get('selfServiceReset') === '1', changedBy: session.user.username },
      session.user.capabilities,
    );
    revalidatePath(ROUTE);
    return { ok: true, message: enabled ? 'Users can now request their own password reset.' : 'Password reset is administrator-initiated only.' };
  } catch (error) {
    return refuse(error);
  }
}
