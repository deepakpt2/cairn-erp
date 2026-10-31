'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  grantCompanyCodeScope,
  grantPlantScope,
  OrganisationScopeAdminError,
  revokeOrganisationScope,
  ORGANISATION_SCOPE_ADMIN_CAPABILITY,
} from '@/modules/platform/organisation-scope-admin';

const ROUTE = '/platform/users/access';

export interface OrganisationScopeActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const EMPTY: OrganisationScopeActionState = { ok: false };

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function denied(): OrganisationScopeActionState {
  return {
    ...EMPTY,
    message: `Managing company and plant access needs ${ORGANISATION_SCOPE_ADMIN_CAPABILITY}, which this session does not hold.`,
    remedy: `Ask a central platform administrator to grant ${ORGANISATION_SCOPE_ADMIN_CAPABILITY} to one of your roles.`,
  };
}

function failure(error: unknown): OrganisationScopeActionState {
  if (error instanceof OrganisationScopeAdminError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function actorFromSession(session: Awaited<ReturnType<typeof requireSession>>) {
  if (!session.sessionId) {
    throw new OrganisationScopeAdminError('This session cannot be verified for central user administration.', 'Sign in again, then retry the scope change.');
  }
  return { userId: session.user.userId, sessionId: session.sessionId };
}

function done(message: string): OrganisationScopeActionState {
  revalidatePath(ROUTE);
  return { ok: true, message };
}

export async function grantCompanyScopeAction(
  _previous: OrganisationScopeActionState,
  formData: FormData,
): Promise<OrganisationScopeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ORGANISATION_SCOPE_ADMIN_CAPABILITY)) return denied();
  try {
    const targetUserId = text(formData, 'targetUserId');
    const companyCode = text(formData, 'companyCode');
    const assignment = await grantCompanyCodeScope({
      client: session.user.client,
      actor: actorFromSession(session),
      targetUserId,
      companyCode,
    });
    return done(`Company code ${assignment.scopeValue} access was granted to ${assignment.username}.`);
  } catch (error) {
    return failure(error);
  }
}

export async function grantPlantScopeAction(
  _previous: OrganisationScopeActionState,
  formData: FormData,
): Promise<OrganisationScopeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ORGANISATION_SCOPE_ADMIN_CAPABILITY)) return denied();
  try {
    const targetUserId = text(formData, 'targetUserId');
    const companyCode = text(formData, 'companyCode');
    const plantCode = text(formData, 'plantCode');
    const assignment = await grantPlantScope({
      client: session.user.client,
      actor: actorFromSession(session),
      targetUserId,
      companyCode,
      plantCode,
    });
    return done(`Plant ${assignment.scopeValue} access was granted to ${assignment.username}.`);
  } catch (error) {
    return failure(error);
  }
}

export async function revokeOrganisationScopeAction(
  _previous: OrganisationScopeActionState,
  formData: FormData,
): Promise<OrganisationScopeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ORGANISATION_SCOPE_ADMIN_CAPABILITY)) return denied();
  try {
    const targetUserId = text(formData, 'targetUserId');
    const assignmentId = text(formData, 'assignmentId');
    const result = await revokeOrganisationScope({
      client: session.user.client,
      actor: actorFromSession(session),
      targetUserId,
      assignmentId,
    });
    return done(result.revoked ? 'Business access was revoked.' : 'That scope was already absent; no change was made.');
  } catch (error) {
    return failure(error);
  }
}
