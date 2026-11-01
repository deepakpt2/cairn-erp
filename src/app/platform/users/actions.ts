'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { CREATE, MAINTAIN, PASSWORD_RESET } from './constants';
import {
  changeUser,
  completePasswordReset,
  createUser,
  listUsers,
  setUserLocked,
  type UserStatusFilter,
  requestPasswordReset,
  type ChangeUserInput,
  type CompleteResetInput,
  type CreateUserInput,
  type RequestResetInput,
  UserAdminError,
} from '@/modules/platform/user-admin';

const ROUTE = '/platform/users';

export interface UserActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  username?: string;
}

function refuse(error: unknown): UserActionState {
  if (error instanceof UserAdminError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function secret(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function done(message: string): UserActionState {
  revalidatePath(ROUTE);
  revalidatePath('/platform/users/[username]', 'page');
  return { ok: true, message };
}

export async function createUserAction(
  _previous: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CREATE)) {
    return {
      ok: false,
      message: `Creating a user needs ${CREATE}, which this session does not hold.`,
      remedy: `Ask an administrator to grant ${CREATE} to one of your roles.`,
    };
  }
  try {
    const input: CreateUserInput = {
      client: session.user.client,
      username: text(formData, 'username'),
      fullName: text(formData, 'fullName'),
      email: text(formData, 'email') || undefined,
      password: secret(formData, 'password'),
      changedBy: session.user.username,
    };
    await createUser(input, session.user.capabilities);
    return done(`User ${input.username} created.`);
  } catch (error) {
    return refuse(error);
  }
}

export async function changeUserAction(
  _previous: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, MAINTAIN)) {
    return {
      ok: false,
      message: `Maintaining users needs ${MAINTAIN}, which this session does not hold.`,
      remedy: `Ask an administrator to grant ${MAINTAIN} to one of your roles.`,
    };
  }
  try {
    const activeValue = text(formData, 'isActive');
    const emailValue = formData.get('email');
    const input: ChangeUserInput = {
      client: session.user.client,
      userId: text(formData, 'userId'),
      fullName: text(formData, 'fullName') || undefined,
      email: typeof emailValue === 'string' ? emailValue.trim() : undefined,
      isActive: activeValue === 'true' ? true : activeValue === 'false' ? false : undefined,
      changedBy: session.user.username,
    };
    await changeUser(input, session.user.capabilities);
    return done('Account details saved.');
  } catch (error) {
    return refuse(error);
  }
}

export async function setUserLockAction(
  _previous: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, MAINTAIN)) {
    return {
      ok: false,
      message: `Locking or unlocking users needs ${MAINTAIN}, which this session does not hold.`,
      remedy: `Ask an administrator to grant ${MAINTAIN} to one of your roles.`,
    };
  }
  try {
    const raw = text(formData, 'isLocked');
    if (raw !== 'true' && raw !== 'false') return { ok: false, message: 'Choose a valid account-lock action.' };
    await setUserLocked({
      client: session.user.client,
      userId: text(formData, 'userId'),
      isLocked: raw === 'true',
      changedBy: session.user.username,
    }, session.user.capabilities);
    return done(raw === 'true' ? 'Account locked and active sessions revoked.' : 'Account unlocked.');
  } catch (error) {
    return refuse(error);
  }
}

export async function initiatePasswordResetAction(
  _previous: UserActionState,
  _formData: FormData,
): Promise<UserActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PASSWORD_RESET)) {
    return {
      ok: false,
      message: `Resetting passwords needs ${PASSWORD_RESET}, which this session does not hold.`,
      remedy: `Ask an administrator to grant ${PASSWORD_RESET} to one of your roles.`,
    };
  }
  // D-033: the repository has no approved outbound delivery transport. Do not
  // mint a token that cannot be delivered and, critically, never return a reset
  // token to the browser. Public self-service recovery remains generic.
  return {
    ok: false,
    message: 'Administrator-initiated password reset is unavailable until an approved delivery channel is configured.',
    remedy: 'Use the existing self-service recovery process or your organization’s approved support channel. No reset token was created or returned.',
  };
}

export async function requestPasswordResetAction(
  _previous: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  try {
    const input: RequestResetInput = {
      client: text(formData, 'client'),
      username: text(formData, 'username'),
      ipAddress: undefined,
    };
    await requestPasswordReset(input);
    return {
      ok: true,
      message:
        'If this account is eligible, the recovery request was recorded. Email delivery is not configured; contact support through your organization’s approved recovery channel.'
    };
  } catch (error) {
    return refuse(error);
  }
}

export async function completePasswordResetAction(
  _previous: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  try {
    const input: CompleteResetInput = {
      client: text(formData, 'client'),
      token: secret(formData, 'token'),
      password: secret(formData, 'password'),
      ipAddress: undefined,
    };
    await completePasswordReset(input);
    return {
      ok: true,
      message: 'Your password has been reset. You may sign in with the new password.',
    };
  } catch (error) {
    return refuse(error);
  }
}

export async function listUsersAction(
  client: string,
  query?: string,
  status: UserStatusFilter = 'ALL',
): Promise<UserActionState & { users?: Array<{ id: string; username: string; fullName: string; email: string | null; isActive: boolean; isLocked: boolean; mustChangePassword: boolean; lastLoginAt: string | null; roles: Array<{ code: string; name: string }>; hasEmployeeRecord: boolean }> }> {
  const session = await requireSession(ROUTE);
  if (session.user.client !== client) {
    return { ok: false, message: 'Client mismatch.' };
  }
  try {
    const users = await listUsers(client, session.user.capabilities, query, status);
    return {
      ok: true,
      users: users.map((user) => ({
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        isActive: user.isActive,
        isLocked: user.isLocked,
        mustChangePassword: user.mustChangePassword,
        lastLoginAt: user.lastLoginAt,
        roles: user.roles,
        hasEmployeeRecord: user.hasEmployeeRecord,
      })),
    };
  } catch (error) {
    return refuse(error);
  }
}
