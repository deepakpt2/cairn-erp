import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { changeHistory } from '@/platform/change';
import { createSession } from '@/platform/auth/session';
import { auditAccessLog, appUser, authOrgRestriction, role, roleCapability, userRole, userSession } from '@/platform/tables/security';
import { companyCode, plant } from '@/modules/foundation/schema';
import { employee } from '@/modules/people/schema';
import {
  getOrganisationScopeAdminOverview,
  getUserOrganisationScopes,
  grantCompanyCodeScope,
  grantPlantScope,
  ORGANISATION_SCOPE_ADMIN_CAPABILITY,
  OrganisationScopeAdminError,
  revokeOrganisationScope,
  type OrganisationScopeActor,
} from '@/modules/platform/organisation-scope-admin';
import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';

interface ActorFixture {
  id: string;
  username: string;
  actor: OrganisationScopeActor;
}

let alpha: TestTenant | undefined;
let beta: TestTenant | undefined;
let admin: ActorFixture;
let peerAdmin: ActorFixture;
let unauthorized: ActorFixture;
let target: ActorFixture;
let scopeLessTarget: ActorFixture;
let concurrentTarget: ActorFixture;
let racingTarget: ActorFixture;
let cascadeTarget: ActorFixture;
let orphanTarget: ActorFixture;
let betaTarget: ActorFixture;

async function createActor(client: string, username: string, withScopeAdmin: boolean): Promise<ActorFixture> {
  const id = randomUUID();
  await withTenant(client, async (tx) => {
    await tx.insert(appUser).values({
      id,
      client,
      username,
      fullName: `Test ${username}`,
      passwordHash: 'TEST_ONLY_NOT_A_CREDENTIAL',
      createdBy: 'TEST',
    });
    if (withScopeAdmin) {
      await tx.insert(role).values({ client, code: 'ORG_SCOPE_ADMIN', name: 'Organisation scope administrator', createdBy: 'TEST' }).onConflictDoNothing();
      await tx.insert(roleCapability).values({
        client,
        roleCode: 'ORG_SCOPE_ADMIN',
        capabilityCode: ORGANISATION_SCOPE_ADMIN_CAPABILITY,
        createdBy: 'TEST',
      }).onConflictDoNothing();
      await tx.insert(userRole).values({ client, userId: id, roleCode: 'ORG_SCOPE_ADMIN', createdBy: 'TEST' });
    }
    await createSession(tx, { client, userId: id, userAgent: 'organisation-scope-admin.test' });
  });
  const session = await withTenant(client, async (tx) => {
    const [row] = await tx.select({ id: userSession.id }).from(userSession)
      .where(and(eq(userSession.client, client), eq(userSession.userId, id)))
      .orderBy(desc(userSession.issuedAt)).limit(1);
    if (!row) throw new Error(`Session was not persisted for ${username}.`);
    return row;
  });
  return { id, username, actor: { userId: id, sessionId: session.id } };
}

function alphaTenant() {
  if (!alpha) throw new Error('Primary organisation-scope test tenant was not initialized.');
  return alpha;
}

function betaTenant() {
  if (!beta) throw new Error('Secondary organisation-scope test tenant was not initialized.');
  return beta;
}

beforeAll(async () => {
  alpha = await createTenant('central-org-scope-admin-alpha');
  beta = await createTenant('central-org-scope-admin-beta');
  admin = await createActor(alpha.client, 'scope.admin', true);
  peerAdmin = await createActor(alpha.client, 'scope.peeradmin', true);
  unauthorized = await createActor(alpha.client, 'scope.viewer', false);
  target = await createActor(alpha.client, 'scope.target', false);
  scopeLessTarget = await createActor(alpha.client, 'scope.nocompany', false);
  concurrentTarget = await createActor(alpha.client, 'scope.concurrent', false);
  racingTarget = await createActor(alpha.client, 'scope.racing', false);
  cascadeTarget = await createActor(alpha.client, 'scope.cascade', false);
  orphanTarget = await createActor(alpha.client, 'scope.orphan', false);
  betaTarget = await createActor(beta.client, 'scope.foreign', false);

  await withTenant(alpha.client, async (tx) => {
    await tx.insert(companyCode).values({
      client: alpha!.client,
      companyCode: '2000',
      name: 'Second scope test company',
      currency: alpha!.currency,
      country: 'KW',
      createdBy: 'TEST',
    }).onConflictDoNothing();
    await tx.insert(companyCode).values({
      client: alpha!.client,
      companyCode: '3000',
      name: 'Inactive scope test company',
      currency: alpha!.currency,
      country: 'KW',
      isActive: false,
      createdBy: 'TEST',
    }).onConflictDoNothing();
    await tx.insert(plant).values({
      client: alpha!.client,
      plant: 'P200',
      name: 'Second company test plant',
      companyCode: '2000',
      country: 'KW',
      createdBy: 'TEST',
    }).onConflictDoNothing();
    await tx.insert(plant).values({
      client: alpha!.client,
      plant: 'PINACTIVE',
      name: 'Inactive test plant',
      companyCode: '1000',
      country: 'KW',
      isActive: false,
      createdBy: 'TEST',
    }).onConflictDoNothing();
  });
  await withTenant(beta.client, async (tx) => {
    await tx.insert(plant).values({
      client: beta!.client,
      plant: 'PFOREIGN',
      name: 'Foreign tenant test plant',
      companyCode: '1000',
      country: 'KW',
      createdBy: 'TEST',
    }).onConflictDoNothing();
  });
}, Number(process.env.CAIRN_TEST_HOOK_TIMEOUT_MS ?? 30_000));

afterAll(async () => {
  try {
    if (alpha) await destroyTenant(alpha.client);
  } finally {
    try {
      if (beta) await destroyTenant(beta.client);
    } finally {
      await closeDb();
    }
  }
});

describe('central organisation-scope administration', () => {
  it('requires a live central administrator session and reads only the current tenant', async () => {
    const tenant = alphaTenant();
    const overview = await getOrganisationScopeAdminOverview(tenant.client, admin.actor, 'scope.target');
    expect(overview.users.map((user) => user.id)).toContain(target.id);
    expect(overview.users.some((user) => user.id === betaTarget.id)).toBe(false);
    expect(overview.companies.map((item) => item.companyCode)).toContain('1000');
    expect(overview.plants.some((item) => item.plant === '1000' && item.companyCode === '1000')).toBe(true);

    await expect(getOrganisationScopeAdminOverview(tenant.client, unauthorized.actor)).rejects.toBeInstanceOf(OrganisationScopeAdminError);
    await expect(getOrganisationScopeAdminOverview(tenant.client, { userId: admin.id, sessionId: randomUUID() })).rejects.toThrow(/session/i);
  });

  it('grants company and contained plant scopes with actor, target, scope and timestamp audit without changing roles', async () => {
    const tenant = alphaTenant();
    const beforeRoles = await withTenant(tenant.client, (tx) => tx.select({ roleCode: userRole.roleCode })
      .from(userRole).where(and(eq(userRole.client, tenant.client), eq(userRole.userId, target.id))));

    const company = await grantCompanyCodeScope({ client: tenant.client, actor: admin.actor, targetUserId: target.id, companyCode: '1000' });
    const plantResult = await grantPlantScope({ client: tenant.client, actor: admin.actor, targetUserId: target.id, companyCode: '1000', plantCode: '1000' });
    expect(company).toMatchObject({ username: target.username, scopeType: 'COMPANY_CODE', scopeValue: '1000', masterStatus: 'ACTIVE' });
    expect(plantResult).toMatchObject({ username: target.username, scopeType: 'PLANT', scopeValue: '1000', companyCode: '1000', masterStatus: 'ACTIVE' });

    const result = await getUserOrganisationScopes(tenant.client, admin.actor, target.id);
    expect(result.assignments).toHaveLength(2);
    expect(result.assignments.map((item) => item.scopeType)).toEqual(['COMPANY_CODE', 'PLANT']);
    expect(result.assignments.every((item) => item.createdAt.length > 0 && item.createdBy === admin.username)).toBe(true);
    const employeeLinks = await withTenant(tenant.client, (tx) => tx.select({ personnelNumber: employee.personnelNumber })
      .from(employee).where(and(eq(employee.client, tenant.client), eq(employee.appUserId, target.id))));
    expect(employeeLinks).toHaveLength(0);
    await expect(getUserOrganisationScopes(tenant.client, target.actor, target.id)).rejects.toThrow(ORGANISATION_SCOPE_ADMIN_CAPABILITY);

    const { history, access, afterRoles } = await withTenant(tenant.client, async (tx) => ({
      history: await changeHistory(tx, tenant.client, 'auth_org_restriction', company.id),
      access: await tx.select().from(auditAccessLog).where(and(eq(auditAccessLog.client, tenant.client), eq(auditAccessLog.userId, target.id))),
      afterRoles: await tx.select({ roleCode: userRole.roleCode }).from(userRole)
        .where(and(eq(userRole.client, tenant.client), eq(userRole.userId, target.id))),
    }));
    expect(history[0]).toMatchObject({ changeType: 'CREATE', changedBy: admin.username });
    expect(history[0].items.map((item) => [item.fieldName, item.newValue])).toEqual(expect.arrayContaining([
      ['actorUserId', admin.id],
      ['targetUserId', target.id],
      ['scopeType', 'COMPANY_CODE'],
      ['scopeValue', '1000'],
    ]));
    expect(access).toHaveLength(2);
    expect(access.every((row) => row.eventType === 'CONFIG_CHANGE' && row.detail?.includes(`${admin.username} (${admin.id})`))).toBe(true);
    expect(access.every((row) => row.occurredAt instanceof Date && row.occurredAt.getTime() > 0)).toBe(true);
    expect(history[0].changedAt).toBeInstanceOf(Date);
    expect(afterRoles).toEqual(beforeRoles);
  });

  it('rejects self-escalation, users without the central capability, and cross-tenant target ids', async () => {
    const tenant = alphaTenant();
    await expect(grantCompanyCodeScope({ client: tenant.client, actor: admin.actor, targetUserId: admin.id, companyCode: '1000' }))
      .rejects.toThrow(/own account/i);
    await expect(grantCompanyCodeScope({ client: tenant.client, actor: unauthorized.actor, targetUserId: target.id, companyCode: '1000' }))
      .rejects.toThrow(ORGANISATION_SCOPE_ADMIN_CAPABILITY);
    await expect(getUserOrganisationScopes(tenant.client, admin.actor, betaTarget.id)).rejects.toThrow(/not found in this tenant/i);
    await expect(grantCompanyCodeScope({ client: tenant.client, actor: admin.actor, targetUserId: betaTarget.id, companyCode: '1000' }))
      .rejects.toThrow(/not found in this tenant/i);
    const foreignRows = await withTenant(betaTenant().client, (tx) => tx.select().from(authOrgRestriction)
      .where(and(eq(authOrgRestriction.client, betaTenant().client), eq(authOrgRestriction.userId, betaTarget.id))));
    expect(foreignRows).toHaveLength(0);
  });

  it('rejects inactive or absent companies, plant/company mismatches, and plant grants without company access', async () => {
    const tenant = alphaTenant();
    await expect(grantCompanyCodeScope({ client: tenant.client, actor: admin.actor, targetUserId: target.id, companyCode: '9999' }))
      .rejects.toThrow(/active company code/i);
    await expect(grantCompanyCodeScope({ client: tenant.client, actor: admin.actor, targetUserId: target.id, companyCode: '3000' }))
      .rejects.toThrow(/active company code/i);
    await expect(grantPlantScope({ client: tenant.client, actor: admin.actor, targetUserId: scopeLessTarget.id, companyCode: '1000', plantCode: '1000' }))
      .rejects.toThrow(/must have company code 1000 access/i);
    await expect(grantPlantScope({ client: tenant.client, actor: admin.actor, targetUserId: target.id, companyCode: '1000', plantCode: 'PINACTIVE' }))
      .rejects.toThrow(/active plant PINACTIVE/i);
    await expect(grantPlantScope({ client: tenant.client, actor: admin.actor, targetUserId: target.id, companyCode: '1000', plantCode: 'PFOREIGN' }))
      .rejects.toThrow(/active plant PFOREIGN/i);

    await grantCompanyCodeScope({ client: tenant.client, actor: admin.actor, targetUserId: target.id, companyCode: '2000' });
    await expect(grantPlantScope({ client: tenant.client, actor: admin.actor, targetUserId: target.id, companyCode: '2000', plantCode: '1000' }))
      .rejects.toThrow(/not assigned to company code 2000/i);
  });

  it('rejects duplicate assignments and serializes concurrent grants to one assignment', async () => {
    const tenant = alphaTenant();
    await grantCompanyCodeScope({ client: tenant.client, actor: admin.actor, targetUserId: concurrentTarget.id, companyCode: '1000' });
    await expect(grantCompanyCodeScope({ client: tenant.client, actor: admin.actor, targetUserId: concurrentTarget.id, companyCode: '1000' }))
      .rejects.toThrow(/already assigned/i);

    const outcomes = await Promise.allSettled([
      grantCompanyCodeScope({ client: tenant.client, actor: admin.actor, targetUserId: racingTarget.id, companyCode: '1000' }),
      grantCompanyCodeScope({ client: tenant.client, actor: admin.actor, targetUserId: racingTarget.id, companyCode: '1000' }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rows = await withTenant(tenant.client, (tx) => tx.select({ id: authOrgRestriction.id }).from(authOrgRestriction).where(and(
      eq(authOrgRestriction.client, tenant.client),
      eq(authOrgRestriction.userId, racingTarget.id),
      eq(authOrgRestriction.scopeType, 'COMPANY_CODE'),
      eq(authOrgRestriction.scopeValue, '1000'),
    )));
    expect(rows).toHaveLength(1);

    const mutualAdminChanges = await Promise.allSettled([
      grantCompanyCodeScope({ client: tenant.client, actor: admin.actor, targetUserId: peerAdmin.id, companyCode: '1000' }),
      grantCompanyCodeScope({ client: tenant.client, actor: peerAdmin.actor, targetUserId: admin.id, companyCode: '1000' }),
    ]);
    expect(mutualAdminChanges.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
  });

  it('prevents orphaned plant access, revokes idempotently, and audits the revocations', async () => {
    const tenant = alphaTenant();
    const company = await grantCompanyCodeScope({ client: tenant.client, actor: admin.actor, targetUserId: cascadeTarget.id, companyCode: '1000' });
    const plantScope = await grantPlantScope({ client: tenant.client, actor: admin.actor, targetUserId: cascadeTarget.id, companyCode: '1000', plantCode: '1000' });

    await expect(revokeOrganisationScope({ client: tenant.client, actor: admin.actor, targetUserId: cascadeTarget.id, assignmentId: company.id }))
      .rejects.toThrow(/still has plant access assigned/i);
    expect(await revokeOrganisationScope({ client: tenant.client, actor: admin.actor, targetUserId: cascadeTarget.id, assignmentId: plantScope.id }))
      .toMatchObject({ revoked: true });
    expect(await revokeOrganisationScope({ client: tenant.client, actor: admin.actor, targetUserId: cascadeTarget.id, assignmentId: plantScope.id }))
      .toMatchObject({ revoked: false });
    expect(await revokeOrganisationScope({ client: tenant.client, actor: admin.actor, targetUserId: cascadeTarget.id, assignmentId: company.id }))
      .toMatchObject({ revoked: true });
    expect(await revokeOrganisationScope({ client: tenant.client, actor: admin.actor, targetUserId: cascadeTarget.id, assignmentId: company.id }))
      .toMatchObject({ revoked: false });

    const logs = await withTenant(tenant.client, (tx) => tx.select().from(auditAccessLog).where(and(
      eq(auditAccessLog.client, tenant.client),
      eq(auditAccessLog.userId, cascadeTarget.id),
    )));
    expect(logs.filter((row) => row.detail?.includes('revoked'))).toHaveLength(2);
    expect(logs.every((row) => row.detail?.includes(`${admin.username} (${admin.id})`))).toBe(true);
    const remaining = await getUserOrganisationScopes(tenant.client, admin.actor, cascadeTarget.id);
    expect(remaining.assignments).toHaveLength(0);
  });

  it('requires dangling legacy plant scopes to be revoked before their company scope', async () => {
    const tenant = alphaTenant();
    const company = await grantCompanyCodeScope({ client: tenant.client, actor: admin.actor, targetUserId: orphanTarget.id, companyCode: '1000' });
    const missingPlantAssignmentId = randomUUID();
    await withTenant(tenant.client, (tx) => tx.insert(authOrgRestriction).values({
      id: missingPlantAssignmentId,
      client: tenant.client,
      userId: orphanTarget.id,
      scopeType: 'PLANT',
      scopeValue: 'MISSING',
      createdBy: 'TEST_FIXTURE',
    }));

    const detail = await getUserOrganisationScopes(tenant.client, admin.actor, orphanTarget.id);
    expect(detail.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeType: 'PLANT', scopeValue: 'MISSING', masterStatus: 'MASTER_NOT_FOUND' }),
    ]));
    await expect(revokeOrganisationScope({ client: tenant.client, actor: admin.actor, targetUserId: orphanTarget.id, assignmentId: company.id }))
      .rejects.toThrow(/still has plant access assigned \(MISSING\)/i);
    expect(await revokeOrganisationScope({ client: tenant.client, actor: admin.actor, targetUserId: orphanTarget.id, assignmentId: missingPlantAssignmentId }))
      .toMatchObject({ revoked: true });
    expect(await revokeOrganisationScope({ client: tenant.client, actor: admin.actor, targetUserId: orphanTarget.id, assignmentId: company.id }))
      .toMatchObject({ revoked: true });
  });
});
