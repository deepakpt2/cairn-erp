import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { changeHistory } from '@/platform/change';
import { createSession, resolveSession } from '@/platform/auth/session';
import { auditAccessLog, appUser, authOrgRestriction, capability, role, roleCapability, sodRule, userRole, userSession } from '@/platform/tables/security';
import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';
import {
  createRole,
  getRoleAdminOverview,
  grantCapabilityToRole,
  grantRoleToUser,
  PLATFORM_ADMIN_ROLE_CODE,
  revokeCapabilityFromRole,
  revokeRoleFromUser,
  ROLE_MAINTAIN_CAPABILITY,
  setRoleActive,
  updateRoleMetadata,
  USER_ROLE_MAINTAIN_CAPABILITY,
  type RoleAdminActor,
} from '@/modules/platform/role-admin';

interface FixtureUser { id: string; username: string; actor: RoleAdminActor; token: string }
const CAP_A = 'TEST.ROLEADMIN.GRANT';
const CAP_B = 'TEST.ROLEADMIN.ISSUE';
let alpha: TestTenant | undefined;
let beta: TestTenant | undefined;
let admin: FixtureUser;
let wildcardAdmin: FixtureUser;
let target: FixtureUser;
let betaUser: FixtureUser;

async function makeUser(client: string, username: string, roleCode?: string, roleCaps: string[] = []): Promise<FixtureUser> {
  const id = randomUUID();
  let token = '';
  await withTenant(client, async (tx) => {
    await tx.insert(appUser).values({ id, client, username, fullName: `Role test ${username}`, passwordHash: 'TEST_ONLY_NOT_A_CREDENTIAL', createdBy: 'TEST' });
    if (roleCode) {
      await tx.insert(role).values({ client, code: roleCode, name: roleCode, isSystemRole: roleCode === PLATFORM_ADMIN_ROLE_CODE, createdBy: 'TEST' }).onConflictDoNothing();
      for (const code of roleCaps) await tx.insert(roleCapability).values({ client, roleCode, capabilityCode: code, createdBy: 'TEST' }).onConflictDoNothing();
      await tx.insert(userRole).values({ client, userId: id, roleCode, createdBy: 'TEST' });
    }
    const created = await createSession(tx, { client, userId: id, userAgent: 'platform-role-admin.test' });
    token = created.token;
  });
  const session = await withTenant(client, async (tx) => {
    const [row] = await tx.select({ id: userSession.id }).from(userSession)
      .where(and(eq(userSession.client, client), eq(userSession.userId, id)))
      .orderBy(desc(userSession.issuedAt)).limit(1);
    if (!row) throw new Error(`Session was not persisted for ${username}.`);
    return row;
  });
  return { id, username, actor: { userId: id, sessionId: session.id }, token };
}

beforeAll(async () => {
  alpha = await createTenant('platform-role-admin-alpha', { withConfiguration: false });
  beta = await createTenant('platform-role-admin-beta', { withConfiguration: false });
  await withTenant(alpha.client, async (tx) => {
    await tx.insert(capability).values([
      { code: CAP_A, module: 'TEST', action: 'POST', isPostingRelevant: true, description: 'Role-admin test capability A' },
      { code: CAP_B, module: 'TEST', action: 'POST', isPostingRelevant: true, description: 'Role-admin test capability B' },
    ]).onConflictDoNothing();
  });
  admin = await makeUser(alpha.client, 'role.admin', PLATFORM_ADMIN_ROLE_CODE, [ROLE_MAINTAIN_CAPABILITY, USER_ROLE_MAINTAIN_CAPABILITY]);
  wildcardAdmin = await makeUser(alpha.client, 'role.wildcard', 'ADMINISTRATOR', ['*']);
  target = await makeUser(alpha.client, 'role.target');
  betaUser = await makeUser(beta.client, 'role.foreign');
}, Number(process.env.CAIRN_TEST_HOOK_TIMEOUT_MS ?? 30_000));

afterAll(async () => {
  try {
    if (alpha) {
      await withTenant(alpha.client, (tx) => tx.delete(capability).where(inArray(capability.code, [CAP_A, CAP_B])));
      await destroyTenant(alpha.client);
    }
  } finally { try { if (beta) await destroyTenant(beta.client); } finally { await closeDb(); } }
});

function tenant() { if (!alpha) throw new Error('Role-admin test tenant was not initialized.'); return alpha; }

describe('tenant-local role and capability administration', () => {
  it('requires a live session and the exact dedicated authority, not wildcard ADMINISTRATOR', async () => {
    const overview = await getRoleAdminOverview(tenant().client, admin.actor);
    expect(overview.roles.map((item) => item.code)).toContain(PLATFORM_ADMIN_ROLE_CODE);
    await expect(getRoleAdminOverview(tenant().client, wildcardAdmin.actor)).rejects.toThrow(/dedicated CFG.PLT.ROLE.MAINTAIN/);
    await expect(getRoleAdminOverview(tenant().client, { userId: admin.id, sessionId: randomUUID() })).rejects.toThrow(/dedicated/);
    await expect(getRoleAdminOverview(beta!.client, admin.actor)).rejects.toThrow(/dedicated CFG.PLT.ROLE.MAINTAIN/);
  });

  it('creates, inspects, edits, deactivates and reactivates a custom role with audited metadata', async () => {
    await createRole({ client: tenant().client, actor: admin.actor, code: 'WALKTHROUGH', name: 'Walkthrough', description: 'Initial description', isReadOnly: false });
    await grantCapabilityToRole({ client: tenant().client, actor: admin.actor, roleCode: 'WALKTHROUGH', capabilityCode: CAP_A });
    await grantRoleToUser({ client: tenant().client, actor: admin.actor, targetUserId: target.id, roleCode: 'WALKTHROUGH' });
    await withTenant(tenant().client, (tx) => tx.insert(authOrgRestriction).values({
      id: randomUUID(), client: tenant().client, userId: target.id, scopeType: 'PLANT', scopeValue: 'TEST-PLANT', createdBy: admin.username,
    }));
    const overviewWithUserAccess = await getRoleAdminOverview(tenant().client, admin.actor);
    expect(overviewWithUserAccess.users.find((user) => user.id === target.id)?.effectiveCapabilities).toContain(CAP_A);
    expect(overviewWithUserAccess.users.find((user) => user.id === target.id)?.organizationRestrictions).toContainEqual({ scopeType: 'PLANT', scopeValue: 'TEST-PLANT' });
    const initiallyAuthorized = await withTenant(tenant().client, (tx) => resolveSession(tx, { client: tenant().client, token: target.token }));
    expect(initiallyAuthorized?.user.capabilities).toContain(CAP_A);
    await updateRoleMetadata({ client: tenant().client, actor: admin.actor, code: 'WALKTHROUGH', name: 'Walkthrough operator', description: 'Least privilege' });
    let overview = await getRoleAdminOverview(tenant().client, admin.actor);
    expect(overview.roles.find((item) => item.code === 'WALKTHROUGH')).toMatchObject({ name: 'Walkthrough operator', description: 'Least privilege', capabilities: [CAP_A] });
    await setRoleActive({ client: tenant().client, actor: admin.actor, code: 'WALKTHROUGH', isActive: false });
    overview = await getRoleAdminOverview(tenant().client, admin.actor);
    expect(overview.roles.find((item) => item.code === 'WALKTHROUGH')?.isActive).toBe(false);
    const afterDeactivation = await withTenant(tenant().client, (tx) => resolveSession(tx, { client: tenant().client, token: target.token }));
    expect(afterDeactivation?.user.capabilities).not.toContain(CAP_A);
    await setRoleActive({ client: tenant().client, actor: admin.actor, code: 'WALKTHROUGH', isActive: true });
    const afterReactivation = await withTenant(tenant().client, (tx) => resolveSession(tx, { client: tenant().client, token: target.token }));
    expect(afterReactivation?.user.capabilities).toContain(CAP_A);
    await revokeRoleFromUser({ client: tenant().client, actor: admin.actor, targetUserId: target.id, roleCode: 'WALKTHROUGH' });
    const history = await withTenant(tenant().client, (tx) => changeHistory(tx, tenant().client, 'role', 'WALKTHROUGH'));
    expect(history.length).toBeGreaterThanOrEqual(3);
    expect(history.every((entry) => entry.changedBy === admin.username)).toBe(true);
  });

  it('only grants registered exact capabilities and protects system, wildcard and platform roles', async () => {
    await createRole({ client: tenant().client, actor: admin.actor, code: 'EXACT_ROLE', name: 'Exact role' });
    await expect(grantCapabilityToRole({ client: tenant().client, actor: admin.actor, roleCode: 'EXACT_ROLE', capabilityCode: 'INV.NOT.REGISTERED' })).rejects.toThrow(/not registered/);
    await expect(grantCapabilityToRole({ client: tenant().client, actor: admin.actor, roleCode: 'EXACT_ROLE', capabilityCode: 'CFG.PLT.ROLE.MAINTAIN' })).rejects.toThrow(/protected platform/);
    await expect(createRole({ client: tenant().client, actor: admin.actor, code: 'PLATFORM_ADMIN', name: 'Not mine' })).rejects.toThrow(/protected system-role code|reserved/);
    await expect(grantCapabilityToRole({ client: tenant().client, actor: admin.actor, roleCode: 'ADMINISTRATOR', capabilityCode: CAP_A })).rejects.toThrow(/Protected role/);
    await grantCapabilityToRole({ client: tenant().client, actor: admin.actor, roleCode: 'EXACT_ROLE', capabilityCode: CAP_A });
    await expect(grantCapabilityToRole({ client: tenant().client, actor: admin.actor, roleCode: 'EXACT_ROLE', capabilityCode: CAP_A })).rejects.toThrow(/already holds/);
    await revokeCapabilityFromRole({ client: tenant().client, actor: admin.actor, roleCode: 'EXACT_ROLE', capabilityCode: CAP_A });
  });

  it('assigns and revokes ordinary roles for other users, refusing self, duplicate, wildcard, protected and cross-tenant grants', async () => {
    await createRole({ client: tenant().client, actor: admin.actor, code: 'GRANTABLE', name: 'Grantable' });
    await grantCapabilityToRole({ client: tenant().client, actor: admin.actor, roleCode: 'GRANTABLE', capabilityCode: CAP_A });
    await expect(grantRoleToUser({ client: tenant().client, actor: admin.actor, targetUserId: admin.id, roleCode: 'GRANTABLE' })).rejects.toThrow(/own account/);
    await expect(grantRoleToUser({ client: tenant().client, actor: admin.actor, targetUserId: betaUser.id, roleCode: 'GRANTABLE' })).rejects.toThrow(/not found in this tenant/);
    await expect(grantRoleToUser({ client: tenant().client, actor: admin.actor, targetUserId: target.id, roleCode: 'PLATFORM_ADMIN' })).rejects.toThrow(/deployment-owner bootstrap/);
    await expect(grantRoleToUser({ client: tenant().client, actor: admin.actor, targetUserId: target.id, roleCode: 'ADMINISTRATOR' })).rejects.toThrow(/protected|wildcard role/i);
    await withTenant(tenant().client, async (tx) => {
      await tx.insert(role).values({ client: tenant().client, code: 'CUSTOM_WILDCARD', name: 'Custom wildcard', isSystemRole: false, createdBy: 'TEST' });
      await tx.insert(roleCapability).values({ client: tenant().client, roleCode: 'CUSTOM_WILDCARD', capabilityCode: '*', createdBy: 'TEST' });
    });
    await expect(grantRoleToUser({ client: tenant().client, actor: admin.actor, targetUserId: target.id, roleCode: 'CUSTOM_WILDCARD' })).rejects.toThrow(/wildcard role/);
    await grantRoleToUser({ client: tenant().client, actor: admin.actor, targetUserId: target.id, roleCode: 'GRANTABLE' });
    await expect(grantRoleToUser({ client: tenant().client, actor: admin.actor, targetUserId: target.id, roleCode: 'GRANTABLE' })).rejects.toThrow(/already holds/);
    const session = await withTenant(tenant().client, (tx) => resolveSession(tx, { client: tenant().client, token: target.token }));
    expect(session?.user.capabilities).toContain(CAP_A);
    await revokeRoleFromUser({ client: tenant().client, actor: admin.actor, targetUserId: target.id, roleCode: 'GRANTABLE' });
    const refreshed = await withTenant(tenant().client, (tx) => resolveSession(tx, { client: tenant().client, token: target.token }));
    expect(refreshed?.user.capabilities).not.toContain(CAP_A);
    await expect(revokeRoleFromUser({ client: tenant().client, actor: admin.actor, targetUserId: admin.id, roleCode: PLATFORM_ADMIN_ROLE_CODE })).rejects.toThrow();
  });

  it('rejects role-composition SoD conflicts and serializes concurrent duplicate assignments', async () => {
    await createRole({ client: tenant().client, actor: admin.actor, code: 'GR_ROLE', name: 'Goods receipt' });
    await createRole({ client: tenant().client, actor: admin.actor, code: 'GI_ROLE', name: 'Goods issue' });
    await grantCapabilityToRole({ client: tenant().client, actor: admin.actor, roleCode: 'GR_ROLE', capabilityCode: CAP_A });
    await grantCapabilityToRole({ client: tenant().client, actor: admin.actor, roleCode: 'GI_ROLE', capabilityCode: CAP_B });
    await withTenant(tenant().client, (tx) => tx.insert(sodRule).values({ client: tenant().client, code: 'TEST_INV_SOD', description: 'Separate receipt and issue', capabilityA: CAP_A, capabilityB: CAP_B, severity: 'HIGH', createdBy: 'TEST' }).onConflictDoNothing());
    await grantRoleToUser({ client: tenant().client, actor: admin.actor, targetUserId: target.id, roleCode: 'GR_ROLE' });
    await expect(grantRoleToUser({ client: tenant().client, actor: admin.actor, targetUserId: target.id, roleCode: 'GI_ROLE' })).rejects.toThrow(/segregation-of-duties/);
    await withTenant(tenant().client, (tx) => tx.delete(sodRule).where(and(eq(sodRule.client, tenant().client), eq(sodRule.code, 'TEST_INV_SOD'))));
    const attempts = await Promise.allSettled([
      grantRoleToUser({ client: tenant().client, actor: admin.actor, targetUserId: target.id, roleCode: 'GI_ROLE' }),
      grantRoleToUser({ client: tenant().client, actor: admin.actor, targetUserId: target.id, roleCode: 'GI_ROLE' }),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
  });

  it('records actor, target, role, before/after and timestamps without leaking assignments across tenants', async () => {
    const { history, audit, foreign } = await withTenant(tenant().client, async (tx) => ({
      history: await changeHistory(tx, tenant().client, 'user_role', `${target.id}/GRANTABLE`),
      audit: await tx.select().from(auditAccessLog).where(and(eq(auditAccessLog.client, tenant().client), eq(auditAccessLog.userId, admin.id))),
      foreign: await tx.select({ id: userRole.userId }).from(userRole).where(and(eq(userRole.client, tenant().client), eq(userRole.userId, betaUser.id))),
    }));
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((entry) => entry.changedBy === admin.username)).toBe(true);
    expect(audit.some((entry) => entry.eventType === 'CONFIG_CHANGE' && entry.detail?.includes(target.id))).toBe(true);
    expect(foreign).toHaveLength(0);
    await expect(getRoleAdminOverview(beta!.client, admin.actor)).rejects.toThrow(/dedicated CFG.PLT.ROLE.MAINTAIN/);
  });
});
