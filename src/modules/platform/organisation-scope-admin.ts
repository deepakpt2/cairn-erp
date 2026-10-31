/**
 * Central client-level administration of company and plant business-access scopes.
 *
 * Scope assignments are deliberately separate from roles, capabilities and HR
 * records. They narrow business operations; they never confer administration.
 */
import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { hasCapability, loadCapabilities } from '../../platform/auth/session';
import { withTenant, type Tx } from '../../platform/db/client';
import { auditAccessLog, appUser, authOrgRestriction } from '../../platform/tables/security';
import { companyCode, plant } from '../foundation/schema';
import type { UserView } from './user-admin';

export const ORGANISATION_SCOPE_ADMIN_CAPABILITY = 'CFG.PLT.USER.MAINTAIN';
const TRANSACTION_CODE = 'CFG.PLT.USER.MAINTAIN';
const OBJECT_CLASS = 'auth_org_restriction';
const MANAGED_SCOPE_TYPES = ['COMPANY_CODE', 'PLANT'] as const;

type ManagedScopeType = (typeof MANAGED_SCOPE_TYPES)[number];

const actorSchema = z.object({ userId: z.string().trim().min(1).max(36), sessionId: z.string().trim().min(1).max(36) }).strict();
const tenantSchema = z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/);
const targetIdSchema = z.string().trim().min(1).max(36);
const scopeCodeSchema = z.string().trim().min(1).max(10);

export class OrganisationScopeAdminError extends Error {
  readonly remedy: string;

  constructor(message: string, remedy = "Review the user's company and plant access, then try again.") {
    super(message);
    this.name = 'OrganisationScopeAdminError';
    this.remedy = remedy;
  }
}

export interface OrganisationScopeActor {
  userId: string;
  sessionId: string;
}

export interface ScopeCompanyChoice {
  companyCode: string;
  name: string;
  isActive: boolean;
}

export interface ScopePlantChoice {
  plant: string;
  name: string;
  companyCode: string | null;
  isActive: boolean;
}

export interface ManagedOrganisationScope {
  id: string;
  scopeType: ManagedScopeType;
  scopeValue: string;
  createdBy: string;
  createdAt: string;
  masterName: string | null;
  companyCode: string | null;
  masterStatus: 'ACTIVE' | 'INACTIVE' | 'MASTER_NOT_FOUND';
}

export interface ScopeAdminOverview {
  users: UserView[];
  companies: ScopeCompanyChoice[];
  plants: ScopePlantChoice[];
}

function validateActorAndTenant(client: string, actor: OrganisationScopeActor) {
  const parsedClient = tenantSchema.safeParse(client);
  const parsedActor = actorSchema.safeParse(actor);
  if (!parsedClient.success || !parsedActor.success) {
    throw new OrganisationScopeAdminError('A valid tenant and authenticated administrator session are required.', 'Sign in again and open user business-access administration from the same tenant.');
  }
  return { client: parsedClient.data, actor: parsedActor.data };
}

function parseField<T extends string>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new OrganisationScopeAdminError(`${label} is invalid.`, `Provide a valid ${label.toLowerCase()} and submit again.`);
  }
  return parsed.data;
}

/** Revalidate the live central-administrator session and hold its authority through commit. */
async function requireAdministrator(tx: Tx, client: string, actor: OrganisationScopeActor): Promise<void> {
  const rows = await tx.execute(sql`
    select u.username
      from user_session s
      join app_user u on u.client = s.client and u.id = s.user_id
     where s.client = ${client}
       and s.id = ${actor.sessionId}
       and s.user_id = ${actor.userId}
       and s.revoked_at is null
       and s.expires_at > now()
       and u.is_active = true
       and u.is_locked = false
     for share of s
  `) as unknown as Array<{ username: string }>;
  const administrator = rows[0];
  if (!administrator) {
    throw new OrganisationScopeAdminError('This authenticated session is no longer valid for central user administration.', 'Sign in again with an active account.');
  }

  await tx.execute(sql`
    select ur.role_code, rc.capability_code
      from user_role ur
      join role_capability rc on rc.client = ur.client and rc.role_code = ur.role_code
     where ur.client = ${client}
       and ur.user_id = ${actor.userId}
       and (ur.valid_from is null or ur.valid_from <= now())
       and (ur.valid_to is null or ur.valid_to >= now())
     for share of ur, rc
  `);
  const capabilities = await loadCapabilities(tx, client, actor.userId);
  if (!hasCapability(capabilities, ORGANISATION_SCOPE_ADMIN_CAPABILITY)) {
    throw new OrganisationScopeAdminError(
      `Managing company and plant access needs ${ORGANISATION_SCOPE_ADMIN_CAPABILITY}.`,
      `Ask a central platform administrator to grant ${ORGANISATION_SCOPE_ADMIN_CAPABILITY} to one of your roles.`,
    );
  }
}

/** Lock actor and target rows in stable ID order to avoid cross-admin lock cycles. */
async function lockAdministratorAndTarget(tx: Tx, client: string, actorUserId: string, targetUserId: string) {
  const userIds = [...new Set([actorUserId, targetUserId])].sort();
  const rows = await tx.select({
    id: appUser.id,
    username: appUser.username,
    isActive: appUser.isActive,
    isLocked: appUser.isLocked,
  }).from(appUser).where(and(eq(appUser.client, client), inArray(appUser.id, userIds)))
    .orderBy(appUser.id).for('update');
  const administrator = rows.find((row) => row.id === actorUserId);
  if (!administrator || !administrator.isActive || administrator.isLocked) {
    throw new OrganisationScopeAdminError('This authenticated session is no longer valid for central user administration.', 'Sign in again with an active account.');
  }
  const target = rows.find((row) => row.id === targetUserId);
  if (!target) {
    throw new OrganisationScopeAdminError('That application user was not found in this tenant.', 'Search for a user in the current tenant and try again.');
  }
  return { administrator, target };
}

/** Serialize every scope mutation for one user, including company revoke vs plant grant. */
async function lockUserScopes(tx: Tx, client: string, userId: string) {
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${`cairn/org-scope/${client}/${userId}`}, 0))
  `);
}

async function companyGrantExists(tx: Tx, client: string, userId: string, company: string): Promise<boolean> {
  const rows = await tx.select({ id: authOrgRestriction.id }).from(authOrgRestriction).where(and(
    eq(authOrgRestriction.client, client),
    eq(authOrgRestriction.userId, userId),
    eq(authOrgRestriction.scopeType, 'COMPANY_CODE'),
    eq(authOrgRestriction.scopeValue, company),
  ));
  return rows.length > 0;
}

async function masterLabel(tx: Tx, client: string, type: ManagedScopeType, value: string) {
  if (type === 'COMPANY_CODE') {
    const [row] = await tx.select({ name: companyCode.name, isActive: companyCode.isActive })
      .from(companyCode).where(and(eq(companyCode.client, client), eq(companyCode.companyCode, value)));
    return { name: row?.name ?? null, companyCode: null, active: row?.isActive ?? null };
  }
  const [row] = await tx.select({ name: plant.name, companyCode: plant.companyCode, isActive: plant.isActive })
    .from(plant).where(and(eq(plant.client, client), eq(plant.plant, value)));
  return { name: row?.name ?? null, companyCode: row?.companyCode ?? null, active: row?.isActive ?? null };
}

function statusOf(active: boolean | null): ManagedOrganisationScope['masterStatus'] {
  if (active === null) return 'MASTER_NOT_FOUND';
  return active ? 'ACTIVE' : 'INACTIVE';
}

async function auditScopeChange(
  tx: Tx,
  input: {
    client: string;
    actorUserId: string;
    actorUsername: string;
    targetUserId: string;
    targetUsername: string;
    assignmentId: string;
    scopeType: ManagedScopeType;
    scopeValue: string;
    companyCode?: string | null;
    action: 'GRANTED' | 'REVOKED';
  },
) {
  const values = {
    actorUserId: input.actorUserId,
    targetUserId: input.targetUserId,
    scopeType: input.scopeType,
    scopeValue: input.scopeValue,
    ...(input.companyCode ? { companyCode: input.companyCode } : {}),
  };
  await recordChange(tx, {
    client: input.client,
    objectClass: OBJECT_CLASS,
    objectKey: input.assignmentId,
    changeType: input.action === 'GRANTED' ? 'CREATE' : 'DELETE',
    changedBy: input.actorUsername,
    transactionCode: TRANSACTION_CODE,
    before: input.action === 'REVOKED' ? values : undefined,
    after: input.action === 'GRANTED' ? values : undefined,
    fieldLabels: {
      actorUserId: 'Administrator user ID',
      targetUserId: 'Affected user ID',
      scopeType: 'Access scope type',
      scopeValue: 'Access scope value',
      companyCode: 'Plant company code',
    },
    securityRelevantFields: ['targetUserId', 'scopeType', 'scopeValue', 'companyCode'],
  });

  const scopeLabel = `${input.scopeType} ${input.scopeValue}`;
  await tx.insert(auditAccessLog).values({
    id: crypto.randomUUID(),
    client: input.client,
    userId: input.targetUserId,
    username: input.targetUsername,
    eventType: 'CONFIG_CHANGE',
    transactionCode: TRANSACTION_CODE,
    objectType: OBJECT_CLASS,
    objectKey: input.assignmentId,
    detail: `${input.actorUsername} (${input.actorUserId}) ${input.action.toLowerCase()} ${scopeLabel} ${input.action === 'GRANTED' ? 'to' : 'from'} ${input.targetUsername} (${input.targetUserId})`,
  });
}

async function insertScope(
  tx: Tx,
  input: {
    client: string;
    actorUserId: string;
    actorUsername: string;
    target: { id: string; username: string };
    scopeType: ManagedScopeType;
    scopeValue: string;
    companyCode?: string | null;
  },
) {
  const existing = await tx.select({ id: authOrgRestriction.id }).from(authOrgRestriction).where(and(
    eq(authOrgRestriction.client, input.client),
    eq(authOrgRestriction.userId, input.target.id),
    eq(authOrgRestriction.scopeType, input.scopeType),
    eq(authOrgRestriction.scopeValue, input.scopeValue),
  ));
  if (existing.length > 0) {
    throw new OrganisationScopeAdminError(`${input.scopeType === 'COMPANY_CODE' ? 'Company' : 'Plant'} scope ${input.scopeValue} is already assigned to ${input.target.username}.`, 'No change was made. Review the current assignments instead of submitting a duplicate.');
  }

  const assignmentId = crypto.randomUUID();
  await tx.insert(authOrgRestriction).values({
    id: assignmentId,
    client: input.client,
    userId: input.target.id,
    scopeType: input.scopeType,
    scopeValue: input.scopeValue,
    createdBy: input.actorUsername,
  });
  await auditScopeChange(tx, {
    client: input.client,
    actorUserId: input.actorUserId,
    actorUsername: input.actorUsername,
    targetUserId: input.target.id,
    targetUsername: input.target.username,
    assignmentId,
    scopeType: input.scopeType,
    scopeValue: input.scopeValue,
    companyCode: input.companyCode,
    action: 'GRANTED',
  });
  const master = await masterLabel(tx, input.client, input.scopeType, input.scopeValue);
  return {
    id: assignmentId,
    userId: input.target.id,
    username: input.target.username,
    scopeType: input.scopeType,
    scopeValue: input.scopeValue,
    companyCode: master.companyCode,
    masterName: master.name,
    masterStatus: statusOf(master.active),
  };
}

export async function getOrganisationScopeAdminOverview(
  rawClient: string,
  actor: OrganisationScopeActor,
  query?: string,
): Promise<ScopeAdminOverview> {
  const { client, actor: validActor } = validateActorAndTenant(rawClient, actor);
  const cleanQuery = query?.trim().slice(0, 120) || undefined;
  return withTenant(client, async (tx) => {
    await requireAdministrator(tx, client, validActor);
    const userCondition = cleanQuery
      ? or(
          ilike(appUser.username, `%${cleanQuery}%`),
          ilike(appUser.fullName, `%${cleanQuery}%`),
          ilike(appUser.email, `%${cleanQuery}%`),
        )
      : undefined;
    const userRows = await tx.select().from(appUser).where(userCondition
      ? and(eq(appUser.client, client), userCondition)
      : eq(appUser.client, client)).orderBy(appUser.username).limit(100);
    const companies = await tx.select({ companyCode: companyCode.companyCode, name: companyCode.name, isActive: companyCode.isActive })
      .from(companyCode).where(and(eq(companyCode.client, client), eq(companyCode.isActive, true))).orderBy(companyCode.companyCode);
    const plants = await tx.select({ plant: plant.plant, name: plant.name, companyCode: plant.companyCode, isActive: plant.isActive })
      .from(plant).where(and(eq(plant.client, client), eq(plant.isActive, true))).orderBy(plant.plant);
    const users: UserView[] = userRows.map((user) => ({
      id: user.id,
      client: user.client,
      username: user.username,
      fullName: user.fullName,
      email: user.email,
      isActive: user.isActive,
      isLocked: user.isLocked,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdBy: user.createdBy,
      createdAt: user.createdAt.toISOString(),
      changedBy: user.changedBy ?? null,
      changedAt: user.changedAt?.toISOString() ?? null,
    }));
    return {
      users,
      companies: companies.map((row) => ({ companyCode: row.companyCode, name: row.name, isActive: row.isActive })),
      plants: plants.map((row) => ({ plant: row.plant, name: row.name, companyCode: row.companyCode, isActive: row.isActive })),
    };
  });
}

export async function getUserOrganisationScopes(
  rawClient: string,
  actor: OrganisationScopeActor,
  rawTargetUserId: string,
): Promise<{ user: UserView; assignments: ManagedOrganisationScope[] }> {
  const { client, actor: validActor } = validateActorAndTenant(rawClient, actor);
  const targetUserId = parseField(targetIdSchema, rawTargetUserId, 'User ID');
  return withTenant(client, async (tx) => {
    await requireAdministrator(tx, client, validActor);
    const rows = await tx.select().from(appUser).where(and(eq(appUser.client, client), eq(appUser.id, targetUserId))).limit(1);
    if (!rows[0]) throw new OrganisationScopeAdminError('That application user was not found in this tenant.', 'Search for a user in the current tenant and try again.');
    const user = rows[0];
    const scopes = await tx.execute(sql`
      select r.id,
             r.scope_type as "scopeType",
             r.scope_value as "scopeValue",
             r.created_by as "createdBy",
             r.created_at as "createdAt",
             case when r.scope_type = 'COMPANY_CODE' then c.name else p.name end as "masterName",
             case when r.scope_type = 'PLANT' then p.company_code else null end as "companyCode",
             case when r.scope_type = 'COMPANY_CODE' then c.is_active else p.is_active end as "masterActive"
        from auth_org_restriction r
        left join company_code c on r.scope_type = 'COMPANY_CODE' and c.client = r.client and c.company_code = r.scope_value
        left join plant p on r.scope_type = 'PLANT' and p.client = r.client and p.plant = r.scope_value
       where r.client = ${client}
         and r.user_id = ${targetUserId}
         and r.scope_type in ('COMPANY_CODE', 'PLANT')
       order by r.scope_type, r.scope_value
    `) as unknown as Array<{
      id: string;
      scopeType: ManagedScopeType;
      scopeValue: string;
      createdBy: string;
      createdAt: Date | string;
      masterName: string | null;
      companyCode: string | null;
      masterActive: boolean | null;
    }>;
    return {
      user: {
        id: user.id,
        client: user.client,
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        isActive: user.isActive,
        isLocked: user.isLocked,
        mustChangePassword: user.mustChangePassword,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        createdBy: user.createdBy,
        createdAt: user.createdAt.toISOString(),
        changedBy: user.changedBy ?? null,
        changedAt: user.changedAt?.toISOString() ?? null,
      },
      assignments: scopes.map((row) => ({
        id: row.id,
        scopeType: row.scopeType,
        scopeValue: row.scopeValue,
        createdBy: row.createdBy,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString(),
        masterName: row.masterName,
        companyCode: row.companyCode,
        masterStatus: statusOf(row.masterActive),
      })),
    };
  });
}

export async function grantCompanyCodeScope(input: {
  client: string;
  actor: OrganisationScopeActor;
  targetUserId: string;
  companyCode: string;
}) {
  const { client, actor } = validateActorAndTenant(input.client, input.actor);
  const targetUserId = parseField(targetIdSchema, input.targetUserId, 'User ID');
  const company = parseField(scopeCodeSchema, input.companyCode, 'Company code');
  return withTenant(client, async (tx) => {
    await requireAdministrator(tx, client, actor);
    if (actor.userId === targetUserId) {
      throw new OrganisationScopeAdminError('You cannot grant company or plant access to your own account.', 'Ask another central platform administrator to make this security-relevant change.');
    }
    const { administrator, target } = await lockAdministratorAndTarget(tx, client, actor.userId, targetUserId);
    await lockUserScopes(tx, client, targetUserId);
    const [master] = await tx.select({ companyCode: companyCode.companyCode, isActive: companyCode.isActive })
      .from(companyCode).where(and(eq(companyCode.client, client), eq(companyCode.companyCode, company))).for('share');
    if (!master || !master.isActive) {
      throw new OrganisationScopeAdminError(`Active company code ${company} was not found in this tenant.`, 'Choose an active company code from the current tenant.');
    }
    return insertScope(tx, {
      client, actorUserId: actor.userId, actorUsername: administrator.username, target,
      scopeType: 'COMPANY_CODE', scopeValue: master.companyCode,
    });
  });
}

export async function grantPlantScope(input: {
  client: string;
  actor: OrganisationScopeActor;
  targetUserId: string;
  companyCode: string;
  plantCode: string;
}) {
  const { client, actor } = validateActorAndTenant(input.client, input.actor);
  const targetUserId = parseField(targetIdSchema, input.targetUserId, 'User ID');
  const company = parseField(scopeCodeSchema, input.companyCode, 'Company code');
  const plantCode = parseField(scopeCodeSchema, input.plantCode, 'Plant code');
  return withTenant(client, async (tx) => {
    await requireAdministrator(tx, client, actor);
    if (actor.userId === targetUserId) {
      throw new OrganisationScopeAdminError('You cannot grant company or plant access to your own account.', 'Ask another central platform administrator to make this security-relevant change.');
    }
    const { administrator, target } = await lockAdministratorAndTarget(tx, client, actor.userId, targetUserId);
    await lockUserScopes(tx, client, targetUserId);
    const [companyMaster] = await tx.select({ companyCode: companyCode.companyCode, isActive: companyCode.isActive })
      .from(companyCode).where(and(eq(companyCode.client, client), eq(companyCode.companyCode, company))).for('share');
    if (!companyMaster || !companyMaster.isActive) {
      throw new OrganisationScopeAdminError(`Active company code ${company} was not found in this tenant.`, 'Choose an active company code from the current tenant.');
    }
    const [plantMaster] = await tx.select({ plant: plant.plant, name: plant.name, companyCode: plant.companyCode, isActive: plant.isActive })
      .from(plant).where(and(eq(plant.client, client), eq(plant.plant, plantCode))).for('share');
    if (!plantMaster || !plantMaster.isActive || plantMaster.companyCode !== companyMaster.companyCode) {
      throw new OrganisationScopeAdminError(`Active plant ${plantCode} is not assigned to company code ${company}.`, 'Select a plant currently assigned to the selected active company code.');
    }
    if (!await companyGrantExists(tx, client, targetUserId, companyMaster.companyCode)) {
      throw new OrganisationScopeAdminError(`User ${target.username} must have company code ${company} access before a plant can be assigned.`, 'Assign the company-code scope first, then assign a plant within that company.');
    }
    return insertScope(tx, {
      client, actorUserId: actor.userId, actorUsername: administrator.username, target,
      scopeType: 'PLANT', scopeValue: plantMaster.plant, companyCode: plantMaster.companyCode,
    });
  });
}

export async function revokeOrganisationScope(input: {
  client: string;
  actor: OrganisationScopeActor;
  targetUserId: string;
  assignmentId: string;
}): Promise<{ revoked: boolean; assignmentId: string }> {
  const { client, actor } = validateActorAndTenant(input.client, input.actor);
  const targetUserId = parseField(targetIdSchema, input.targetUserId, 'User ID');
  const assignmentId = parseField(targetIdSchema, input.assignmentId, 'Assignment ID');
  return withTenant(client, async (tx) => {
    await requireAdministrator(tx, client, actor);
    const { administrator, target } = await lockAdministratorAndTarget(tx, client, actor.userId, targetUserId);
    await lockUserScopes(tx, client, targetUserId);
    const rows = await tx.select({
      id: authOrgRestriction.id,
      scopeType: authOrgRestriction.scopeType,
      scopeValue: authOrgRestriction.scopeValue,
    }).from(authOrgRestriction).where(and(
      eq(authOrgRestriction.client, client),
      eq(authOrgRestriction.userId, targetUserId),
      eq(authOrgRestriction.id, assignmentId),
      inArray(authOrgRestriction.scopeType, [...MANAGED_SCOPE_TYPES]),
    )).for('update');
    const assignment = rows[0];
    if (!assignment) return { revoked: false, assignmentId };
    const scopeType = assignment.scopeType as ManagedScopeType;

    if (scopeType === 'COMPANY_CODE') {
      const dependentPlants = await tx.execute(sql`
        select r.scope_value as "plantCode"
          from auth_org_restriction r
          left join plant p on p.client = r.client and p.plant = r.scope_value
         where r.client = ${client}
           and r.user_id = ${targetUserId}
           and r.scope_type = 'PLANT'
           and (p.company_code = ${assignment.scopeValue} or p.plant is null)
         order by r.scope_value
      `) as unknown as Array<{ plantCode: string }>;
      if (dependentPlants.length > 0) {
        throw new OrganisationScopeAdminError(
          `Company code ${assignment.scopeValue} still has plant access assigned (${dependentPlants.map((row) => row.plantCode).join(', ')}).`,
          'Revoke the dependent plant scopes first, then revoke the company-code scope.',
        );
      }
    }

    const master = await masterLabel(tx, client, scopeType, assignment.scopeValue);
    await auditScopeChange(tx, {
      client,
      actorUserId: actor.userId,
      actorUsername: administrator.username,
      targetUserId,
      targetUsername: target.username,
      assignmentId: assignment.id,
      scopeType,
      scopeValue: assignment.scopeValue,
      companyCode: master.companyCode,
      action: 'REVOKED',
    });
    await tx.delete(authOrgRestriction).where(and(
      eq(authOrgRestriction.client, client),
      eq(authOrgRestriction.userId, targetUserId),
      eq(authOrgRestriction.id, assignmentId),
    ));
    return { revoked: true, assignmentId };
  });
}
