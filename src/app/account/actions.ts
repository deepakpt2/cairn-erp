'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import {
  AccountError, ACCOUNT_ROUTE, changeOwnPassword, revokeOwnSession, safeNextPath, saveOwnPreferences,
} from '@/modules/platform/personal-account';

/**
 * Thin wrappers. Each one ends in a redirect carrying the outcome in the query string,
 * so the screen works with no client-side JavaScript. The messages are our own
 * `AccountError` text, never user input.
 */
function back(section: string, outcome: { ok?: string; error?: string; remedy?: string }, next?: string | null): never {
  const q = new URLSearchParams({ section });
  if (outcome.ok) q.set('ok', outcome.ok);
  if (outcome.error) q.set('error', outcome.error);
  if (outcome.remedy) q.set('remedy', outcome.remedy);
  if (next) q.set('next', next);
  redirect(`${ACCOUNT_ROUTE}?${q.toString()}`);
}

function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

export async function changePasswordAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const next = safeNextPath(field(formData, 'next'));
  try {
    await changeOwnPassword({
      client: session.user.client, userId: session.user.userId, currentSessionId: session.sessionId ?? null,
      currentPassword: field(formData, 'currentPassword'), newPassword: field(formData, 'newPassword'),
      confirmation: field(formData, 'confirmation'),
    });
  } catch (error) {
    if (error instanceof AccountError) back('password', { error: error.message, remedy: error.remedy }, next);
    throw error;
  }
  revalidatePath('/', 'layout');
  if (next) redirect(next);
  back('password', { ok: 'Password changed. Your other sessions were signed out.' });
}

export async function revokeSessionAction(formData: FormData): Promise<void> {
  const session = await requireSession(ACCOUNT_ROUTE);
  const sessionId = field(formData, 'sessionId');
  try {
    await revokeOwnSession({ client: session.user.client, userId: session.user.userId, sessionId });
  } catch (error) {
    if (error instanceof AccountError) back('sessions', { error: error.message, remedy: error.remedy });
    throw error;
  }
  if (sessionId === session.sessionId) redirect('/signin');
  back('sessions', { ok: 'Session closed.' });
}

export async function savePreferencesAction(formData: FormData): Promise<void> {
  const session = await requireSession(ACCOUNT_ROUTE);
  try {
    await saveOwnPreferences({ client: session.user.client, userId: session.user.userId, logonLanguage: field(formData, 'logonLanguage') });
  } catch (error) {
    if (error instanceof AccountError) back('preferences', { error: error.message, remedy: error.remedy });
    throw error;
  }
  back('preferences', { ok: 'Preferences saved.' });
}
