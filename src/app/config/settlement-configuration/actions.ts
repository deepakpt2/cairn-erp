'use server';

/**
 * Server actions for `/config/settlement-configuration`.
 *
 * The screen derives nothing. Each action reads its fields, the mode and the version out of the
 * submitted form, requires the capability, takes the change session of the user's own for the row it
 * is about to write, and calls the master module. A refusal comes back as the module's own message and
 * remedy, so the reason a save stopped is the reason the module found and not a wording the screen
 * invented. Tenant and actor are session-derived: the browser cannot select another tenant or user.
 */
import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  SETTLEMENT_CONFIG_ACTIVITY,
  SETTLEMENT_CONFIG_ROUTE,
  SettlementMastersError,
  assignOrderTypeSettlementProfile,
  removeAllocationStructureAssignment,
  removeOrderTypeSettlementProfile,
  saveAllocationStructure,
  saveAllocationStructureAssignment,
  saveSettlementProfile,
  settlementConfigLock,
} from '@/modules/foundation/settlement-configuration-masters';

const ROUTE = SETTLEMENT_CONFIG_ROUTE;

export interface SettlementConfigActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, key: string): string {
  return String(form.get(key) ?? '').trim();
}

function flag(form: FormData, key: string): boolean {
  return form.get(key) === 'on';
}

function version(form: FormData): number {
  const raw = Number(form.get('expectedVersion') ?? '0');
  return Number.isFinite(raw) ? raw : Number.NaN;
}

function receiverCategory(form: FormData): 'COST_CENTER' | 'INTERNAL_ORDER' | 'GL_ACCOUNT' {
  const value = read(form, 'receiverCategory');
  if (value === 'INTERNAL_ORDER' || value === 'GL_ACCOUNT' || value === 'COST_CENTER') return value;
  throw new SettlementMastersError(
    'A receiver category is required.',
    'Choose the receiver category the assignment belongs to: cost center, internal order, or general ledger account.',
  );
}

/**
 * Capability on every write; a change session on every write that edits or removes a row somebody
 * else may be holding. A create has no row to hold yet, which is why it is the one case that does not
 * demand the session.
 */
async function authorized(form: FormData, kind: 'structure' | 'profile' | 'orderType', code: string, holds: boolean) {
  const session = await requireSession(ROUTE);
  await requireCapability(SETTLEMENT_CONFIG_ACTIVITY, session);
  if (holds) await assertChangeForSession(session, settlementConfigLock(kind, code));
  return session;
}

function refused(error: unknown): SettlementConfigActionState {
  if (error instanceof SettlementMastersError) return { ok: false, message: error.message, remedy: error.remedy };
  if (error instanceof EnqueueError) return { ok: false, message: error.message };
  if (error instanceof AuthzError) {
    return {
      ok: false,
      message: `Your user is not permitted to maintain settlement configuration (${error.capability}).`,
      remedy: `Ask for the ${error.capability} capability, or open the screen read only.`,
    };
  }
  throw error;
}

function done(message: string): SettlementConfigActionState {
  revalidatePath(ROUTE);
  revalidatePath('/config');
  revalidatePath('/controlling/settlement-rules');
  return { ok: true, message };
}

export async function saveStructureAction(
  _previous: SettlementConfigActionState,
  form: FormData,
): Promise<SettlementConfigActionState> {
  const structureCode = read(form, 'structureCode');
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  try {
    const session = await authorized(form, 'structure', structureCode, mode === 'CHANGE');
    const saved = await saveAllocationStructure({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      expectedVersion: version(form),
      structureCode,
      description: read(form, 'description'),
    });
    return done(saved.created
      ? `Allocation structure ${saved.structureCode} created.`
      : saved.changed
        ? `Allocation structure ${saved.structureCode} changed.`
        : `Allocation structure ${saved.structureCode} already held that description.`);
  } catch (error) {
    return refused(error);
  }
}

export async function saveAssignmentAction(
  _previous: SettlementConfigActionState,
  form: FormData,
): Promise<SettlementConfigActionState> {
  const structureCode = read(form, 'structureCode');
  try {
    const session = await authorized(form, 'structure', structureCode, true);
    const saved = await saveAllocationStructureAssignment({
      client: session.user.client,
      changedBy: session.user.username,
      expectedVersion: version(form),
      structureCode,
      sourceAccount: read(form, 'sourceAccount'),
      receiverCategory: receiverCategory(form),
      byOriginalAccount: flag(form, 'byOriginalAccount'),
      settlementAccount: read(form, 'settlementAccount'),
      confirmed: flag(form, 'confirmed'),
      reason: read(form, 'reason') || undefined,
    });
    return done(saved.created
      ? `Account ${saved.sourceAccount} is assigned in ${saved.structureCode}.`
      : saved.changed
        ? `Account ${saved.sourceAccount} is reassigned in ${saved.structureCode}.`
        : `Account ${saved.sourceAccount} was already assigned that way.`);
  } catch (error) {
    return refused(error);
  }
}

export async function removeAssignmentAction(
  _previous: SettlementConfigActionState,
  form: FormData,
): Promise<SettlementConfigActionState> {
  const structureCode = read(form, 'structureCode');
  try {
    const session = await authorized(form, 'structure', structureCode, true);
    const removed = await removeAllocationStructureAssignment({
      client: session.user.client,
      changedBy: session.user.username,
      structureCode,
      sourceAccount: read(form, 'sourceAccount'),
      receiverCategory: receiverCategory(form),
      confirmed: flag(form, 'confirmed'),
      reason: read(form, 'reason') || undefined,
    });
    return done(removed.removed
      ? `Account ${removed.sourceAccount} is no longer assigned in ${removed.structureCode}.`
      : `Account ${removed.sourceAccount} was not assigned in ${removed.structureCode}.`);
  } catch (error) {
    return refused(error);
  }
}

export async function saveProfileAction(
  _previous: SettlementConfigActionState,
  form: FormData,
): Promise<SettlementConfigActionState> {
  const profileCode = read(form, 'profileCode');
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  try {
    const session = await authorized(form, 'profile', profileCode, mode === 'CHANGE');
    const saved = await saveSettlementProfile({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      expectedVersion: version(form),
      profileCode,
      description: read(form, 'description'),
      allocationStructure: read(form, 'allocationStructure'),
      documentType: read(form, 'documentType'),
      percentageAllowed: flag(form, 'percentageAllowed'),
      equivalenceAllowed: flag(form, 'equivalenceAllowed'),
      amountAllowed: flag(form, 'amountAllowed'),
      isActive: flag(form, 'isActive'),
      reason: read(form, 'reason') || undefined,
    });
    return done(saved.created
      ? `Settlement profile ${saved.profileCode} created.`
      : saved.changed
        ? `Settlement profile ${saved.profileCode} changed.`
        : `Settlement profile ${saved.profileCode} already held those values.`);
  } catch (error) {
    return refused(error);
  }
}

export async function saveOrderTypeAction(
  _previous: SettlementConfigActionState,
  form: FormData,
): Promise<SettlementConfigActionState> {
  const orderType = read(form, 'orderType');
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  try {
    const session = await authorized(form, 'orderType', orderType, mode === 'CHANGE');
    const saved = await assignOrderTypeSettlementProfile({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      expectedVersion: version(form),
      orderType,
      profileCode: read(form, 'profileCode'),
      confirmed: flag(form, 'confirmed'),
      reason: read(form, 'reason') || undefined,
    });
    return done(saved.created
      ? `Order type ${saved.orderType} now reads settlement profile ${saved.profileCode}.`
      : saved.changed
        ? `Order type ${saved.orderType} now reads settlement profile ${saved.profileCode}.`
        : `Order type ${saved.orderType} already read that profile.`);
  } catch (error) {
    return refused(error);
  }
}

export async function removeOrderTypeAction(
  _previous: SettlementConfigActionState,
  form: FormData,
): Promise<SettlementConfigActionState> {
  const orderType = read(form, 'orderType');
  try {
    const session = await authorized(form, 'orderType', orderType, true);
    const removed = await removeOrderTypeSettlementProfile({
      client: session.user.client,
      changedBy: session.user.username,
      orderType,
      confirmed: flag(form, 'confirmed'),
      reason: read(form, 'reason') || undefined,
    });
    return done(removed.removed
      ? `Order type ${removed.orderType} no longer reads a settlement profile.`
      : `Order type ${removed.orderType} was not assigned a settlement profile.`);
  } catch (error) {
    return refused(error);
  }
}
