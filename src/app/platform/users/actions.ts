'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { CREATE, MAINTAIN, PASSWORD_RESET } from './constants';
import {
  changeUser,
  completePasswordReset,
  createUser,
  initiatePasswordReset,
  listUsers,
  requestPasswordReset,
  type ChangeUserInput,
  type CompleteResetInput,
  type CreateUserInput,
  type InitiateResetInput,
  type RequestResetInput,
  UserAdminError,
} from '@/modules/platform/user-admin';

const ROUTE = '/platform/users';

export interface UserActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  userId?: string;
  username?: string;
  token?: string;
  expiresAt?: string;
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

function done(message: string): UserActionState {
  revalidatePath(ROUTE);
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
      password: text(formData, 'password'),
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
    const input: ChangeUserInput = {
      client: session.user.client,
      userId: text(formData, 'userId'),
      fullName: text(formData, 'fullName') || undefined,
      email: text(formData, 'email') || undefined,
      isActive:
        formData.get('isActive') === 'on' || formData.get('isActive') === 'true'
          ? true
          : formData.get('isActive') === 'off' || formData.get('isActive') === 'false'
            ? false
            : undefined,
      changedBy: session.user.username,
    };
    await changeUser(input, session.user.capabilities);
    return done(`User ${input.userId} updated.`);
  } catch (error) {
    return refuse(error);
  }
}

export async function initiatePasswordResetAction(
  _previous: UserActionState,
  formData: FormData,
): Promise<UserActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PASSWORD_RESET)) {
    return {
      ok: false,
      message: `Resetting passwords needs ${PASSWORD_RESET}, which this session does not hold.`,
      remedy: `Ask an administrator to grant ${PASSWORD_RESET} to one of your roles.`,
    };
  }
  try {
    const input: InitiateResetInput = {
      client: session.user.client,
      userId: text(formData, 'userId'),
      changedBy: session.user.username,
      ipAddress: undefined,
    };
    const result = await initiatePasswordReset(input, session.user.capabilities);
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Reset token created for ${result.username}. Deliver it to the user out of band.`,
      userId: result.userId,
      username: result.username,
      token: result.token,
      expiresAt: result.expiresAt,
    };
  } catch (error) {
    return refuse(error);
  }
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
        'If this username stands in this tenant, a reset link has been created. It will arrive by email when the mail server is configured; otherwise an administrator can deliver it out of band.',
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
      token: text(formData, 'token'),
      password: text(formData, 'password'),
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
): Promise<UserActionState & { users?: Array<{ id: string; username: string; fullName: string; email: string | null; isActive: boolean; isLocked: boolean; mustChangePassword: boolean; lastLoginAt: string | null }> }> {
  const session = await requireSession(ROUTE);
  if (session.user.client !== client) {
    return { ok: false, message: 'Client mismatch.' };
  }
  try {
    const users = await listUsers(client, query);
    return {
      ok: true,
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        fullName: u.fullName,
        email: u.email,
        isActive: u.isActive,
        isLocked: u.isLocked,
        mustChangePassword: u.mustChangePassword,
        lastLoginAt: u.lastLoginAt,
      })),
    };
  } catch (error) {
    return refuse(error);
  }
}
