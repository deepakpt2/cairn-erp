import { randomUUID } from 'node:crypto';

import { createSession, resolveSession, type SessionContext } from '../../src/platform/auth/session';
import { CREDIT_CONTROL_AREA_CAPABILITY } from '../../src/platform/auth/capability-policy';
import { appUser, authOrgRestriction, role, roleCapability, userRole } from '../../src/platform/tables/security';
import { withTenant } from '../../src/platform/db/client';

/** Test-only exact role and scoped live session; callers must use an isolated test tenant. */
export async function createCcaAuthorizedSession(
  client: string,
  username: string,
  companyCodes: readonly string[],
): Promise<SessionContext> {
  const userId = randomUUID();
  const token = await withTenant(client, async (tx) => {
    await tx.insert(role).values({
      client,
      code: 'CCA_MAINTAIN_TEST',
      name: 'CCA maintenance test fixture',
      isSystemRole: false,
      createdBy: 'TEST',
    }).onConflictDoNothing();
    await tx.insert(roleCapability).values({
      client,
      roleCode: 'CCA_MAINTAIN_TEST',
      capabilityCode: CREDIT_CONTROL_AREA_CAPABILITY,
      createdBy: 'TEST',
    }).onConflictDoNothing();
    await tx.insert(appUser).values({
      id: userId,
      client,
      username,
      fullName: `CCA authorization fixture ${username}`,
      passwordHash: 'TEST_ONLY_NOT_A_CREDENTIAL',
      isActive: true,
      createdBy: 'TEST',
    });
    await tx.insert(userRole).values({ client, userId, roleCode: 'CCA_MAINTAIN_TEST', createdBy: 'TEST' });
    for (const scopeValue of companyCodes) {
      await tx.insert(authOrgRestriction).values({
        id: randomUUID(),
        client,
        userId,
        scopeType: 'COMPANY_CODE',
        scopeValue,
        createdBy: 'TEST',
      });
    }
    return (await createSession(tx, { client, userId, userAgent: 'credit-control-area.test' })).token;
  });
  const session = await withTenant(client, (tx) => resolveSession(tx, { client, token }));
  if (!session?.sessionId) throw new Error('The CCA test fixture did not resolve a persisted session.');
  return session;
}
