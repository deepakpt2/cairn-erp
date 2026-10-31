import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const auditFailure = vi.hoisted(() => ({ failAfterChangeWrite: false }));

vi.mock('@/platform/change', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/change')>();
  return {
    ...actual,
    recordChange: async (...args: Parameters<typeof actual.recordChange>) => {
      const changeId = await actual.recordChange(...args);
      if (auditFailure.failAfterChangeWrite) {
        auditFailure.failAfterChangeWrite = false;
        throw new Error('test-only audit failure after change document insert');
      }
      return changeId;
    },
  };
});

import { createSession } from '@/platform/auth/session';
import { auditAccessLog, appUser, authOrgRestriction, role, roleCapability, userRole, userSession } from '@/platform/tables/security';
import { changeDocument } from '@/platform/tables/audit-trail';
import { grantCompanyCodeScope, ORGANISATION_SCOPE_ADMIN_CAPABILITY } from '@/modules/platform/organisation-scope-admin';
import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';

let tenant: TestTenant | undefined;
let actor: { userId: string; sessionId: string };
let targetUserId: string;

beforeAll(async () => {
  tenant = await createTenant('central-org-scope-audit-rollback');
  const client = tenant.client;
  const adminId = randomUUID();
  targetUserId = randomUUID();
  await withTenant(client, async (tx) => {
    await tx.insert(appUser).values({
      id: adminId, client, username: 'rollback.admin', fullName: 'Rollback Administrator',
      passwordHash: 'TEST_ONLY_NOT_A_CREDENTIAL', createdBy: 'TEST',
    });
    await tx.insert(appUser).values({
      id: targetUserId, client, username: 'rollback.target', fullName: 'Rollback Target',
      passwordHash: 'TEST_ONLY_NOT_A_CREDENTIAL', createdBy: 'TEST',
    });
    await tx.insert(role).values({ client, code: 'ORG_SCOPE_ADMIN', name: 'Organisation scope administrator', createdBy: 'TEST' }).onConflictDoNothing();
    await tx.insert(roleCapability).values({
      client, roleCode: 'ORG_SCOPE_ADMIN', capabilityCode: ORGANISATION_SCOPE_ADMIN_CAPABILITY, createdBy: 'TEST',
    }).onConflictDoNothing();
    await tx.insert(userRole).values({ client, userId: adminId, roleCode: 'ORG_SCOPE_ADMIN', createdBy: 'TEST' });
    await createSession(tx, { client, userId: adminId });
  });
  const session = await withTenant(client, async (tx) => {
    const [row] = await tx.select({ id: userSession.id }).from(userSession)
      .where(and(eq(userSession.client, client), eq(userSession.userId, adminId)))
      .orderBy(desc(userSession.issuedAt)).limit(1);
    return row;
  });
  if (!session) throw new Error('Rollback administrator session was not persisted.');
  actor = { userId: adminId, sessionId: session.id };
}, Number(process.env.CAIRN_TEST_HOOK_TIMEOUT_MS ?? 30_000));

afterAll(async () => {
  try {
    if (tenant) await destroyTenant(tenant.client);
  } finally {
    await closeDb();
  }
});

describe('organisation-scope transactional rollback', () => {
  it('rolls back the scope and already-written change document when audit completion fails', async () => {
    const client = tenant!.client;
    auditFailure.failAfterChangeWrite = true;
    await expect(grantCompanyCodeScope({
      client,
      actor,
      targetUserId,
      companyCode: '1000',
    })).rejects.toThrow('test-only audit failure after change document insert');

    const state = await withTenant(client, async (tx) => ({
      scopes: await tx.select().from(authOrgRestriction).where(and(
        eq(authOrgRestriction.client, client),
        eq(authOrgRestriction.userId, targetUserId),
      )),
      changes: await tx.select().from(changeDocument).where(and(
        eq(changeDocument.client, client),
        eq(changeDocument.objectClass, 'auth_org_restriction'),
      )),
      accessLogs: await tx.select().from(auditAccessLog).where(and(
        eq(auditAccessLog.client, client),
        eq(auditAccessLog.userId, targetUserId),
      )),
    }));
    expect(state.scopes).toHaveLength(0);
    expect(state.changes).toHaveLength(0);
    expect(state.accessLogs).toHaveLength(0);
  });
});
