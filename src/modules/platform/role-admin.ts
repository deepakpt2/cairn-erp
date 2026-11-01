/**
 * Tenant-local role and user-role administration.
 *
 * Routine administration is granted only by the separately bootstrapped,
 * non-wildcard PLATFORM_ADMIN role. A tenant's ADMINISTRATOR wildcard and the
 * ordinary CFG.PLT.USER.MAINTAIN capability are deliberately insufficient.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { hasCapability } from '../../platform/auth/session';
import { withTenant, type Tx } from '../../platform/db/client';
import {
  appUser,
  auditAccessLog,
  capability,
  role,
  roleCapability,
  authOrgRestriction,
  sodRule,
  userRole,
} from '../../platform/tables/security';

export const PLATFORM_ADMIN_ROLE_CODE = 'PLATFORM_ADMIN';
export const ROLE_MAINTAIN_CAPABILITY = 'CFG.PLT.ROLE.MAINTAIN';
export const USER_ROLE_MAINTAIN_CAPABILITY = 'CFG.PLT.USER.ROLE.MAINTAIN';
const PROTECTED_ROLE_CODES = new Set([
  PLATFORM_ADMIN_ROLE_CODE, 'ADMINISTRATOR', 'CONFIGURATOR', 'ACCOUNTANT', 'CONTROLLER',
  'BUYER', 'PLANNER', 'PRODUCTION_CLERK', 'WAREHOUSE_CLERK', 'SALES_CLERK', 'AUDITOR',
]);
const OBJECT_CLASS = 'role';
const TENANT_SCHEMA = z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/);
const ACTOR_SCHEMA = z.object({ userId: z.string().trim().min(1).max(36), sessionId: z.string().trim().min(1).max(36) }).strict();
const ROLE_CODE_SCHEMA = z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/);
const CAPABILITY_CODE_SCHEMA = z.string().trim().regex(/^[A-Z][A-Z0-9_]*(?:\.[A-Z0-9_]+)+$/);

export interface RoleAdminActor {
  userId: string;
  sessionId: string;
}

export interface RoleAdminRole {
  code: string;
  name: string;
  description: string | null;
  isSystemRole: boolean;
  isReadOnly: boolean;
  isActive: boolean;
  capabilities: string[];
}

export interface RoleAdminUser {
  id: string;
  username: string;
  fullName: string;
  isActive: boolean;
  isLocked: boolean;
  roles: Array<{ code: string; name: string; validFrom: string; validTo: string | null; currentlyEffective: boolean }>;
  effectiveCapabilities: string[];
  organizationRestrictions: Array<{ scopeType: string; scopeValue: string }>;
}

export interface RoleAdminOverview {
  roles: RoleAdminRole[];
  capabilities: Array<{ code: string; module: string; action: string; isPostingRelevant: boolean; description: string | null }>;
  users: RoleAdminUser[];
}

export class RoleAdminError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy = 'Review the role and user assignments, then try again.') {
    super(message);
    this.name = 'RoleAdminError';
    this.remedy = remedy;
  }
}

function validateContext(client: string, actor: RoleAdminActor) {
  const tenant = TENANT_SCHEMA.safeParse(client);
  const parsedActor = ACTOR_SCHEMA.safeParse(actor);
  if (!tenant.success || !parsedActor.success) {
    throw new RoleAdminError('A valid tenant and live signed-in administrator session are required.', 'Sign in again and open role administration in the same tenant.');
  }
  return { client: tenant.data, actor: parsedActor.data };
}

function parse<T extends string>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RoleAdminError(`${label} is invalid.`, `Provide a valid ${label.toLowerCase()} and retry.`);
  return result.data;
}

/** A single coarse lock serializes all tenant role mutations and composition checks. */
async function lockTenant(tx: Tx, client: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cairn/platform-role-admin/${client}`}, 0))`);
}

/**
 * Require the exact, dedicated tenant-local authority from a live persisted
 * session. Matching `*` against the authority code is intentionally not enough.
 */
async function requirePlatformAdministrator(
  tx: Tx,
  client: string,
  actor: RoleAdminActor,
  required: typeof ROLE_MAINTAIN_CAPABILITY | typeof USER_ROLE_MAINTAIN_CAPABILITY,
): Promise<{ username: string }> {
  const rows = await tx.execute(sql`
    select u.username
      from user_session s
      join app_user u on u.client = s.client and u.id = s.user_id
      join user_role ur on ur.client = u.client and ur.user_id = u.id
      join role r on r.client = ur.client and r.code = ur.role_code
      join role_capability rc on rc.client = r.client and rc.role_code = r.code
     where s.client = ${client}
       and s.id = ${actor.sessionId}
       and s.user_id = ${actor.userId}
       and s.revoked_at is null
       and s.expires_at > now()
       and u.is_active = true
       and u.is_locked = false
       and ur.valid_from <= now()
       and (ur.valid_to is null or ur.valid_to >= now())
       and r.is_active = true
       and r.is_system_role = true
       and r.code = ${PLATFORM_ADMIN_ROLE_CODE}
       and rc.capability_code = ${required}
     for share of s, u, ur, r, rc
  `) as unknown as Array<{ username: string }>;
  if (!rows[0]) {
    throw new RoleAdminError(
      `This live session lacks the dedicated ${required} authority. Tenant wildcard ADMINISTRATOR access is not platform role-administration authority.`,
      'Ask the deployment owner to bootstrap a designated active account, then sign in again.',
    );
  }
  return rows[0];
}

async function logChange(
  tx: Tx,
  input: { client: string; actor: RoleAdminActor; username: string; transactionCode: string; objectType: string; objectKey: string; detail: string },
) {
  await tx.insert(auditAccessLog).values({
    id: crypto.randomUUID(),
    client: input.client,
    userId: input.actor.userId,
    username: input.username,
    eventType: 'CONFIG_CHANGE',
    transactionCode: input.transactionCode,
    objectType: input.objectType,
    objectKey: input.objectKey,
    detail: input.detail,
  });
}

async function loadEffectiveCapabilities(tx: Tx, client: string, userId: string, extraRoleCode?: string): Promise<string[]> {
  const rows = await tx.execute(sql`
    select distinct rc.capability_code
      from user_role ur
      join role r on r.client = ur.client and r.code = ur.role_code and r.is_active = true
      join role_capability rc on rc.client = ur.client and rc.role_code = ur.role_code
     where ur.client = ${client}
       and ur.user_id = ${userId}
       and ur.valid_from <= now()
       and (ur.valid_to is null or ur.valid_to >= now())
  `) as unknown as Array<{ capability_code: string }>;
  const capabilities = rows.map((row) => row.capability_code);
  if (extraRoleCode) {
    const extra = await tx.select({ capabilityCode: roleCapability.capabilityCode }).from(roleCapability)
      .innerJoin(role, and(eq(role.client, roleCapability.client), eq(role.code, roleCapability.roleCode), eq(role.isActive, true)))
      .where(and(eq(roleCapability.client, client), eq(roleCapability.roleCode, extraRoleCode)));
    capabilities.push(...extra.map((row) => row.capabilityCode));
  }
  return [...new Set(capabilities)];
}

async function assertNoSodConflict(tx: Tx, client: string, capabilities: string[], context: string) {
  const rules = await tx.select({ code: sodRule.code, a: sodRule.capabilityA, b: sodRule.capabilityB, severity: sodRule.severity })
    .from(sodRule).where(eq(sodRule.client, client)).for('share');
  for (const rule of rules) {
    if (hasCapability(capabilities, rule.a) && hasCapability(capabilities, rule.b)) {
      throw new RoleAdminError(
        `The change would violate segregation-of-duties rule ${rule.code} (${rule.severity}) for ${context}.`,
        'Separate the conflicting capabilities across different users or revise the standing SoD rule through its authorized configuration process.',
      );
    }
  }
}

async function lockUsers(tx: Tx, client: string, userIds: string[]) {
  const ids = [...new Set(userIds)].sort();
  const rows = await tx.select({ id: appUser.id, username: appUser.username, fullName: appUser.fullName, isActive: appUser.isActive, isLocked: appUser.isLocked })
    .from(appUser).where(and(eq(appUser.client, client), inArray(appUser.id, ids))).orderBy(appUser.id).for('update');
  const map = new Map(rows.map((row) => [row.id, row]));
  return map;
}

async function requireCustomRole(tx: Tx, client: string, code: string, lock = true) {
  const query = tx.select({ code: role.code, name: role.name, description: role.description, isSystemRole: role.isSystemRole, isReadOnly: role.isReadOnly, isActive: role.isActive })
    .from(role).where(and(eq(role.client, client), eq(role.code, code)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new RoleAdminError(`Role ${code} was not found in this tenant.`);
  if (row.isSystemRole || PROTECTED_ROLE_CODES.has(row.code)) {
    throw new RoleAdminError(`Protected role ${code} cannot be changed through routine role administration.`, 'Choose a custom role; deployment-owner bootstrap is the only path that creates the protected platform-admin role.');
  }
  return row;
}

async function recordMutation(
  tx: Tx,
  input: { client: string; actor: RoleAdminActor; username: string; transactionCode: string; objectClass: string; objectKey: string; changeType: 'CREATE' | 'CHANGE' | 'DELETE' | 'BLOCK' | 'UNBLOCK'; before?: Record<string, unknown>; after?: Record<string, unknown>; detail: string },
) {
  await recordChange(tx, {
    client: input.client,
    objectClass: input.objectClass,
    objectKey: input.objectKey,
    changeType: input.changeType,
    transactionCode: input.transactionCode,
    changedBy: input.username,
    before: input.before,
    after: input.after,
    securityRelevantFields: ['capabilities', 'isActive', 'isReadOnly', 'roleCode', 'targetUserId'],
  });
  await logChange(tx, {
    client: input.client,
    actor: input.actor,
    username: input.username,
    transactionCode: input.transactionCode,
    objectType: input.objectClass,
    objectKey: input.objectKey,
    detail: input.detail,
  });
}

export async function getRoleAdminOverview(clientArg: string, actorArg: RoleAdminActor): Promise<RoleAdminOverview> {
  const { client, actor } = validateContext(clientArg, actorArg);
  return withTenant(client, async (tx) => {
    await requirePlatformAdministrator(tx, client, actor, ROLE_MAINTAIN_CAPABILITY);
    const roles = await tx.select({ code: role.code, name: role.name, description: role.description, isSystemRole: role.isSystemRole, isReadOnly: role.isReadOnly, isActive: role.isActive })
      .from(role).where(eq(role.client, client)).orderBy(role.code);
    const roleCaps = await tx.select({ roleCode: roleCapability.roleCode, capabilityCode: roleCapability.capabilityCode })
      .from(roleCapability).where(eq(roleCapability.client, client)).orderBy(roleCapability.roleCode, roleCapability.capabilityCode);
    const catalogue = await tx.select({ code: capability.code, module: capability.module, action: capability.action, isPostingRelevant: capability.isPostingRelevant, description: capability.description })
      .from(capability).orderBy(capability.code);
    const users = await tx.select({ id: appUser.id, username: appUser.username, fullName: appUser.fullName, isActive: appUser.isActive, isLocked: appUser.isLocked })
      .from(appUser).where(eq(appUser.client, client)).orderBy(appUser.username);
    const assignments = await tx.select({ userId: userRole.userId, roleCode: userRole.roleCode, validFrom: userRole.validFrom, validTo: userRole.validTo, roleName: role.name, roleIsActive: role.isActive })
      .from(userRole).innerJoin(role, and(eq(role.client, userRole.client), eq(role.code, userRole.roleCode)))
      .where(eq(userRole.client, client)).orderBy(userRole.userId, userRole.roleCode);
    const scopeRows = await tx.select({ userId: authOrgRestriction.userId, scopeType: authOrgRestriction.scopeType, scopeValue: authOrgRestriction.scopeValue })
      .from(authOrgRestriction).where(eq(authOrgRestriction.client, client)).orderBy(authOrgRestriction.userId, authOrgRestriction.scopeType, authOrgRestriction.scopeValue);
    const currentTime = Date.now();
    const capabilitiesByRole = new Map<string, string[]>();
    for (const item of roleCaps) {
      const list = capabilitiesByRole.get(item.roleCode) ?? [];
      list.push(item.capabilityCode);
      capabilitiesByRole.set(item.roleCode, list);
    }
    return {
      roles: roles.map((item) => ({ ...item, capabilities: capabilitiesByRole.get(item.code) ?? [] })),
      capabilities: catalogue,
      users: users.map((user) => {
        const userAssignments = assignments.filter((assignment) => assignment.userId === user.id);
        const effectivePatterns = userAssignments.filter((assignment) => assignment.roleIsActive
          && assignment.validFrom.getTime() <= currentTime
          && (!assignment.validTo || assignment.validTo.getTime() >= currentTime))
          .flatMap((assignment) => capabilitiesByRole.get(assignment.roleCode) ?? []);
        return {
          ...user,
          roles: userAssignments.map((assignment) => ({
            code: assignment.roleCode,
            name: assignment.roleName,
            validFrom: assignment.validFrom.toISOString(),
            validTo: assignment.validTo?.toISOString() ?? null,
            currentlyEffective: assignment.roleIsActive
              && assignment.validFrom.getTime() <= currentTime
              && (!assignment.validTo || assignment.validTo.getTime() >= currentTime),
          })),
          effectiveCapabilities: user.isActive && !user.isLocked ? catalogue.filter((item) => hasCapability(effectivePatterns, item.code)).map((item) => item.code) : [],
          organizationRestrictions: scopeRows.filter((scope) => scope.userId === user.id).map(({ scopeType, scopeValue }) => ({ scopeType, scopeValue })),
        };
      }),
    };
  });
}

export interface CreateRoleInput { client: string; actor: RoleAdminActor; code: string; name: string; description?: string; isReadOnly?: boolean }
export async function createRole(input: CreateRoleInput): Promise<void> {
  const { client, actor } = validateContext(input.client, input.actor);
  const code = parse(ROLE_CODE_SCHEMA, input.code, 'Role code');
  const name = parse(z.string().trim().min(1).max(80), input.name, 'Role name');
  const description = input.description ? parse(z.string().trim().max(1000), input.description, 'Role description') || null : null;
  if (PROTECTED_ROLE_CODES.has(code)) throw new RoleAdminError(`${code} is a protected system-role code and cannot be created as a custom role.`, 'Choose a new custom role code; only the deployment-owner bootstrap creates PLATFORM_ADMIN.');
  await withTenant(client, async (tx) => {
    await lockTenant(tx, client);
    const admin = await requirePlatformAdministrator(tx, client, actor, ROLE_MAINTAIN_CAPABILITY);
    const [existing] = await tx.select({ code: role.code }).from(role).where(and(eq(role.client, client), eq(role.code, code))).for('update');
    if (existing) throw new RoleAdminError(`Role ${code} already exists.`);
    const value = { client, code, name, description, isSystemRole: false, isReadOnly: input.isReadOnly ?? false, isActive: true, createdBy: admin.username };
    await tx.insert(role).values(value);
    await recordMutation(tx, { client, actor, username: admin.username, transactionCode: ROLE_MAINTAIN_CAPABILITY, objectClass: OBJECT_CLASS, objectKey: code, changeType: 'CREATE', after: { code, name, description, isSystemRole: false, isReadOnly: value.isReadOnly, isActive: true }, detail: `Created custom role ${code}.` });
  });
}

export interface UpdateRoleInput { client: string; actor: RoleAdminActor; code: string; name: string; description?: string }
export async function updateRoleMetadata(input: UpdateRoleInput): Promise<void> {
  const { client, actor } = validateContext(input.client, input.actor);
  const code = parse(ROLE_CODE_SCHEMA, input.code, 'Role code');
  const name = parse(z.string().trim().min(1).max(80), input.name, 'Role name');
  const description = input.description ? parse(z.string().trim().max(1000), input.description, 'Role description') || null : null;
  await withTenant(client, async (tx) => {
    await lockTenant(tx, client);
    const admin = await requirePlatformAdministrator(tx, client, actor, ROLE_MAINTAIN_CAPABILITY);
    const before = await requireCustomRole(tx, client, code);
    const after = { ...before, name, description };
    if (before.name === name && before.description === description) return;
    await tx.update(role).set({ name, description, changedBy: admin.username, changedAt: new Date() }).where(and(eq(role.client, client), eq(role.code, code)));
    await recordMutation(tx, { client, actor, username: admin.username, transactionCode: ROLE_MAINTAIN_CAPABILITY, objectClass: OBJECT_CLASS, objectKey: code, changeType: 'CHANGE', before, after, detail: `Changed metadata for role ${code}.` });
  });
}

export async function setRoleActive(input: { client: string; actor: RoleAdminActor; code: string; isActive: boolean }): Promise<void> {
  const { client, actor } = validateContext(input.client, input.actor);
  const code = parse(ROLE_CODE_SCHEMA, input.code, 'Role code');
  await withTenant(client, async (tx) => {
    await lockTenant(tx, client);
    const admin = await requirePlatformAdministrator(tx, client, actor, ROLE_MAINTAIN_CAPABILITY);
    const before = await requireCustomRole(tx, client, code);
    if (before.isActive === input.isActive) throw new RoleAdminError(`Role ${code} is already ${input.isActive ? 'active' : 'inactive'}.`);
    const after = { ...before, isActive: input.isActive };
    await tx.update(role).set({ isActive: input.isActive, changedBy: admin.username, changedAt: new Date() }).where(and(eq(role.client, client), eq(role.code, code)));
    await recordMutation(tx, { client, actor, username: admin.username, transactionCode: ROLE_MAINTAIN_CAPABILITY, objectClass: OBJECT_CLASS, objectKey: code, changeType: input.isActive ? 'UNBLOCK' : 'BLOCK', before, after, detail: `${input.isActive ? 'Activated' : 'Deactivated'} role ${code}; existing user assignments are preserved.` });
  });
}

export async function grantCapabilityToRole(input: { client: string; actor: RoleAdminActor; roleCode: string; capabilityCode: string }): Promise<void> {
  const { client, actor } = validateContext(input.client, input.actor);
  const roleCode = parse(ROLE_CODE_SCHEMA, input.roleCode, 'Role code');
  const capabilityCode = parse(CAPABILITY_CODE_SCHEMA, input.capabilityCode, 'Capability code');
  if (capabilityCode.includes('*') || capabilityCode === ROLE_MAINTAIN_CAPABILITY || capabilityCode === USER_ROLE_MAINTAIN_CAPABILITY) {
    throw new RoleAdminError('Wildcards and protected platform-administration authorities cannot be assigned to custom roles.', 'Choose a concrete registered business capability; platform-administrator authority is bootstrap-only.');
  }
  await withTenant(client, async (tx) => {
    await lockTenant(tx, client);
    const admin = await requirePlatformAdministrator(tx, client, actor, ROLE_MAINTAIN_CAPABILITY);
    const targetRole = await requireCustomRole(tx, client, roleCode);
    if (!targetRole.isActive) throw new RoleAdminError(`Inactive role ${roleCode} cannot be changed.`);
    const [catalogueEntry] = await tx.select({ code: capability.code, isPostingRelevant: capability.isPostingRelevant }).from(capability).where(eq(capability.code, capabilityCode));
    if (!catalogueEntry) throw new RoleAdminError(`Capability ${capabilityCode} is not registered in the Cairn capability catalogue.`);
    if (targetRole.isReadOnly && catalogueEntry.isPostingRelevant) throw new RoleAdminError(`Read-only role ${roleCode} cannot hold posting capability ${capabilityCode}.`);
    const [existing] = await tx.select({ capabilityCode: roleCapability.capabilityCode }).from(roleCapability)
      .where(and(eq(roleCapability.client, client), eq(roleCapability.roleCode, roleCode), eq(roleCapability.capabilityCode, capabilityCode))).for('update');
    if (existing) throw new RoleAdminError(`Role ${roleCode} already holds ${capabilityCode}.`);
    const oldCaps = await tx.select({ code: roleCapability.capabilityCode }).from(roleCapability)
      .where(and(eq(roleCapability.client, client), eq(roleCapability.roleCode, roleCode)));
    await assertNoSodConflict(tx, client, [...oldCaps.map((item) => item.code), capabilityCode], `role ${roleCode}`);
    const affected = await tx.selectDistinct({ userId: userRole.userId }).from(userRole)
      .where(and(eq(userRole.client, client), eq(userRole.roleCode, roleCode), sql`${userRole.validFrom} <= now()`, sql`(${userRole.validTo} is null or ${userRole.validTo} >= now())`));
    for (const assignment of affected) {
      const current = await loadEffectiveCapabilities(tx, client, assignment.userId);
      await assertNoSodConflict(tx, client, [...current, capabilityCode], `user ${assignment.userId}`);
    }
    await tx.insert(roleCapability).values({ client, roleCode, capabilityCode, createdBy: admin.username });
    await recordMutation(tx, { client, actor, username: admin.username, transactionCode: ROLE_MAINTAIN_CAPABILITY, objectClass: 'role_capability', objectKey: `${roleCode}/${capabilityCode}`, changeType: 'CREATE', after: { roleCode, capabilityCode }, detail: `Granted ${capabilityCode} to role ${roleCode}.` });
  });
}

export async function revokeCapabilityFromRole(input: { client: string; actor: RoleAdminActor; roleCode: string; capabilityCode: string }): Promise<void> {
  const { client, actor } = validateContext(input.client, input.actor);
  const roleCode = parse(ROLE_CODE_SCHEMA, input.roleCode, 'Role code');
  const capabilityCode = parse(CAPABILITY_CODE_SCHEMA, input.capabilityCode, 'Capability code');
  await withTenant(client, async (tx) => {
    await lockTenant(tx, client);
    const admin = await requirePlatformAdministrator(tx, client, actor, ROLE_MAINTAIN_CAPABILITY);
    await requireCustomRole(tx, client, roleCode);
    const [existing] = await tx.select({ capabilityCode: roleCapability.capabilityCode }).from(roleCapability)
      .where(and(eq(roleCapability.client, client), eq(roleCapability.roleCode, roleCode), eq(roleCapability.capabilityCode, capabilityCode))).for('update');
    if (!existing) throw new RoleAdminError(`Role ${roleCode} does not hold ${capabilityCode}.`);
    await tx.delete(roleCapability).where(and(eq(roleCapability.client, client), eq(roleCapability.roleCode, roleCode), eq(roleCapability.capabilityCode, capabilityCode)));
    await recordMutation(tx, { client, actor, username: admin.username, transactionCode: ROLE_MAINTAIN_CAPABILITY, objectClass: 'role_capability', objectKey: `${roleCode}/${capabilityCode}`, changeType: 'DELETE', before: { roleCode, capabilityCode }, detail: `Revoked ${capabilityCode} from role ${roleCode}.` });
  });
}

export async function grantRoleToUser(input: { client: string; actor: RoleAdminActor; targetUserId: string; roleCode: string }): Promise<void> {
  const { client, actor } = validateContext(input.client, input.actor);
  const targetUserId = z.string().trim().min(1).max(36).parse(input.targetUserId);
  const roleCode = parse(ROLE_CODE_SCHEMA, input.roleCode, 'Role code');
  if (targetUserId === actor.userId) throw new RoleAdminError('You cannot grant a role to your own account.', 'Ask another bootstrapped platform administrator to make the assignment.');
  if (roleCode === PLATFORM_ADMIN_ROLE_CODE) throw new RoleAdminError('The protected platform administrator role can only be assigned by the deployment-owner bootstrap.');
  if (PROTECTED_ROLE_CODES.has(roleCode)) throw new RoleAdminError(`Protected system role ${roleCode} cannot be assigned through routine role administration.`, 'Create a custom least-privilege role from exact registered capabilities.');
  await withTenant(client, async (tx) => {
    await lockTenant(tx, client);
    const admin = await requirePlatformAdministrator(tx, client, actor, USER_ROLE_MAINTAIN_CAPABILITY);
    const lockedUsers = await lockUsers(tx, client, [actor.userId, targetUserId]);
    const target = lockedUsers.get(targetUserId);
    if (!lockedUsers.get(actor.userId)?.isActive || lockedUsers.get(actor.userId)?.isLocked) throw new RoleAdminError('The acting account is no longer active.');
    if (!target) throw new RoleAdminError('The target user was not found in this tenant.');
    if (!target.isActive || target.isLocked) throw new RoleAdminError('A role cannot be assigned to an inactive or locked user.');
    const [targetRole] = await tx.select({ code: role.code, isActive: role.isActive, isSystemRole: role.isSystemRole })
      .from(role).where(and(eq(role.client, client), eq(role.code, roleCode))).for('share');
    if (!targetRole) throw new RoleAdminError(`Role ${roleCode} was not found in this tenant.`);
    if (!targetRole.isActive) throw new RoleAdminError(`Inactive role ${roleCode} cannot be assigned.`);
    if (targetRole.isSystemRole) throw new RoleAdminError(`Protected system role ${roleCode} cannot be assigned through routine administration.`, 'Create a custom least-privilege role from exact registered capabilities.');
    const caps = await tx.select({ code: roleCapability.capabilityCode }).from(roleCapability)
      .where(and(eq(roleCapability.client, client), eq(roleCapability.roleCode, roleCode))).for('share');
    if (caps.some((item) => item.code.includes('*') || item.code === ROLE_MAINTAIN_CAPABILITY || item.code === USER_ROLE_MAINTAIN_CAPABILITY)) {
      throw new RoleAdminError(`Protected or wildcard role ${roleCode} cannot be assigned through routine role administration.`, 'Use a named, least-privilege role without wildcard or platform-administrator authority.');
    }
    const current = await loadEffectiveCapabilities(tx, client, targetUserId, roleCode);
    await assertNoSodConflict(tx, client, current, `user ${targetUserId}`);
    const [existing] = await tx.select({ validFrom: userRole.validFrom, validTo: userRole.validTo }).from(userRole)
      .where(and(eq(userRole.client, client), eq(userRole.userId, targetUserId), eq(userRole.roleCode, roleCode))).for('update');
    const now = new Date();
    if (existing && existing.validFrom <= now && (!existing.validTo || existing.validTo >= now)) throw new RoleAdminError(`User ${target.username} already holds role ${roleCode}.`);
    if (existing) {
      await tx.update(userRole).set({ validFrom: now, validTo: null, changedBy: admin.username, changedAt: now })
        .where(and(eq(userRole.client, client), eq(userRole.userId, targetUserId), eq(userRole.roleCode, roleCode)));
    } else {
      await tx.insert(userRole).values({ client, userId: targetUserId, roleCode, validFrom: now, createdBy: admin.username });
    }
    await recordMutation(tx, { client, actor, username: admin.username, transactionCode: USER_ROLE_MAINTAIN_CAPABILITY, objectClass: 'user_role', objectKey: `${targetUserId}/${roleCode}`, changeType: existing ? 'CHANGE' : 'CREATE', before: existing ? { targetUserId, roleCode, validFrom: existing.validFrom, validTo: existing.validTo } : undefined, after: { targetUserId, targetUsername: target.username, roleCode, validFrom: now, validTo: null }, detail: `Assigned role ${roleCode} to ${target.username} (${targetUserId}).` });
  });
}

export async function revokeRoleFromUser(input: { client: string; actor: RoleAdminActor; targetUserId: string; roleCode: string }): Promise<void> {
  const { client, actor } = validateContext(input.client, input.actor);
  const targetUserId = z.string().trim().min(1).max(36).parse(input.targetUserId);
  const roleCode = parse(ROLE_CODE_SCHEMA, input.roleCode, 'Role code');
  if (targetUserId === actor.userId) throw new RoleAdminError('You cannot revoke a role from your own account.', 'Ask another bootstrapped platform administrator to make the assignment change.');
  if (roleCode === PLATFORM_ADMIN_ROLE_CODE) throw new RoleAdminError('Protected platform administrator access is not managed through user-role assignment.');
  await withTenant(client, async (tx) => {
    await lockTenant(tx, client);
    const admin = await requirePlatformAdministrator(tx, client, actor, USER_ROLE_MAINTAIN_CAPABILITY);
    const lockedUsers = await lockUsers(tx, client, [actor.userId, targetUserId]);
    const target = lockedUsers.get(targetUserId);
    if (!lockedUsers.get(actor.userId)?.isActive || lockedUsers.get(actor.userId)?.isLocked) throw new RoleAdminError('The acting account is no longer active.');
    if (!target) throw new RoleAdminError('The target user was not found in this tenant.');
    const [assignment] = await tx.select({ validFrom: userRole.validFrom, validTo: userRole.validTo }).from(userRole)
      .where(and(eq(userRole.client, client), eq(userRole.userId, targetUserId), eq(userRole.roleCode, roleCode))).for('update');
    if (!assignment || assignment.validFrom > new Date() || (assignment.validTo && assignment.validTo < new Date())) throw new RoleAdminError(`User ${target.username} does not currently hold role ${roleCode}.`);
    const now = new Date();
    await tx.update(userRole).set({ validTo: now, changedBy: admin.username, changedAt: now })
      .where(and(eq(userRole.client, client), eq(userRole.userId, targetUserId), eq(userRole.roleCode, roleCode)));
    await recordMutation(tx, { client, actor, username: admin.username, transactionCode: USER_ROLE_MAINTAIN_CAPABILITY, objectClass: 'user_role', objectKey: `${targetUserId}/${roleCode}`, changeType: 'CHANGE', before: { targetUserId, roleCode, validFrom: assignment.validFrom, validTo: assignment.validTo }, after: { targetUserId, targetUsername: target.username, roleCode, validFrom: assignment.validFrom, validTo: now }, detail: `Revoked role ${roleCode} from ${target.username} (${targetUserId}).` });
  });
}
