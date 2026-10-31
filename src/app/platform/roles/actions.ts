'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/platform/auth/current';
import {
  createRole,
  grantCapabilityToRole,
  grantRoleToUser,
  revokeCapabilityFromRole,
  revokeRoleFromUser,
  RoleAdminError,
  setRoleActive,
  updateRoleMetadata,
} from '@/modules/platform/role-admin';

const ROUTE = '/platform/roles';
export interface RoleAdminActionState { ok: boolean; message?: string; remedy?: string }
const EMPTY: RoleAdminActionState = { ok: false };
function text(form: FormData, name: string) { const value = form.get(name); return typeof value === 'string' ? value.trim() : ''; }
function failure(error: unknown): RoleAdminActionState {
  if (error instanceof RoleAdminError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}
function actor(session: Awaited<ReturnType<typeof requireSession>>) {
  if (!session.sessionId) throw new RoleAdminError('This session cannot be verified for role administration.', 'Sign in again and retry.');
  return { userId: session.user.userId, sessionId: session.sessionId };
}
async function run(operation: (session: Awaited<ReturnType<typeof requireSession>>) => Promise<void>, success: string): Promise<RoleAdminActionState> {
  const session = await requireSession(ROUTE);
  try {
    await operation(session);
    revalidatePath(ROUTE);
    return { ok: true, message: success };
  } catch (error) { return failure(error); }
}

export async function createRoleAction(_previous: RoleAdminActionState, form: FormData): Promise<RoleAdminActionState> {
  const session = await requireSession(ROUTE);
  try {
    const code = text(form, 'code');
    await createRole({ client: session.user.client, actor: actor(session), code, name: text(form, 'name'), description: text(form, 'description'), isReadOnly: form.get('isReadOnly') === 'on' });
    revalidatePath(ROUTE);
    return { ok: true, message: `Role ${code} created.` };
  } catch (error) { return failure(error); }
}

export async function updateRoleAction(_previous: RoleAdminActionState, form: FormData): Promise<RoleAdminActionState> {
  const session = await requireSession(ROUTE);
  try {
    const code = text(form, 'code');
    await updateRoleMetadata({ client: session.user.client, actor: actor(session), code, name: text(form, 'name'), description: text(form, 'description') });
    revalidatePath(ROUTE);
    return { ok: true, message: `Role ${code} updated.` };
  } catch (error) { return failure(error); }
}

export async function setRoleActiveAction(_previous: RoleAdminActionState, form: FormData): Promise<RoleAdminActionState> {
  const active = text(form, 'isActive') === 'true';
  const code = text(form, 'code');
  return run((session) => setRoleActive({ client: session.user.client, actor: actor(session), code, isActive: active }), `Role ${code} ${active ? 'activated' : 'deactivated'}.`);
}

export async function grantCapabilityAction(_previous: RoleAdminActionState, form: FormData): Promise<RoleAdminActionState> {
  const roleCode = text(form, 'roleCode'); const capabilityCode = text(form, 'capabilityCode');
  return run((session) => grantCapabilityToRole({ client: session.user.client, actor: actor(session), roleCode, capabilityCode }), `Granted ${capabilityCode} to ${roleCode}.`);
}

export async function revokeCapabilityAction(_previous: RoleAdminActionState, form: FormData): Promise<RoleAdminActionState> {
  const roleCode = text(form, 'roleCode'); const capabilityCode = text(form, 'capabilityCode');
  return run((session) => revokeCapabilityFromRole({ client: session.user.client, actor: actor(session), roleCode, capabilityCode }), `Revoked ${capabilityCode} from ${roleCode}.`);
}

export async function grantUserRoleAction(_previous: RoleAdminActionState, form: FormData): Promise<RoleAdminActionState> {
  const targetUserId = text(form, 'userId'); const roleCode = text(form, 'roleCode');
  return run((session) => grantRoleToUser({ client: session.user.client, actor: actor(session), targetUserId, roleCode }), `Assigned ${roleCode} to the selected user.`);
}

export async function revokeUserRoleAction(_previous: RoleAdminActionState, form: FormData): Promise<RoleAdminActionState> {
  const targetUserId = text(form, 'userId'); const roleCode = text(form, 'roleCode');
  return run((session) => revokeRoleFromUser({ client: session.user.client, actor: actor(session), targetUserId, roleCode }), `Revoked ${roleCode} from the selected user.`);
}

export { EMPTY as EMPTY_ROLE_ADMIN_STATE };
