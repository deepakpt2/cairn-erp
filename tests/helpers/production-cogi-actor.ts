import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { createSession } from '../../src/platform/auth/session';
import { hashPassword } from '../../src/platform/auth/password';
import { withTenant } from '../../src/platform/db/client';
import { appUser, authOrgRestriction, capability, role, roleCapability, userRole } from '../../src/platform/tables/security';

const SETUP_ACTOR = 'COGI_TEST_SETUP';

export interface ProductionCogiTestActor {
  username: string;
  userId: string;
  sessionId: string;
  authorization: { userId: string; sessionId: string };
}

/** Create a persisted test user with exact COGI authority and explicit org scopes. */
export async function createProductionCogiTestActor(
  client: string,
  options: {
    username?: string;
    canReprocess?: boolean;
    companyScopes?: string[];
    plantScopes?: string[];
  } = {},
): Promise<ProductionCogiTestActor> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const username = options.username ?? `COGI_${suffix}`;
  const userId = randomUUID();
  const roleCode = `TEST_COGI_${suffix}`;

  await withTenant(client, async (tx) => {
    await tx.insert(capability).values({
      code: 'PROD.GM.REPROCESS', module: 'PROD', action: 'POST', isPostingRelevant: true,
      description: 'Test-only COGI reprocessing authority',
    }).onConflictDoNothing();
    await tx.insert(role).values({
      client, code: roleCode, name: 'COGI test authority', description: 'Test-only COGI role',
      isSystemRole: false, isReadOnly: false, createdBy: SETUP_ACTOR,
    });
    if (options.canReprocess !== false) {
      await tx.insert(roleCapability).values({
        client, roleCode, capabilityCode: 'PROD.GM.REPROCESS', createdBy: SETUP_ACTOR,
      });
    }
    await tx.insert(appUser).values({
      id: userId,
      client,
      username,
      fullName: username,
      passwordHash: await hashPassword('COGI-test-only-not-a-login-secret'),
      isActive: true,
      isLocked: false,
      createdBy: SETUP_ACTOR,
    });
    await tx.insert(userRole).values({ client, userId, roleCode, createdBy: SETUP_ACTOR });
    const restrictions = [
      ...(options.companyScopes ?? ['1000']).map((scopeValue) => ({
        id: randomUUID(), client, userId, scopeType: 'COMPANY_CODE', scopeValue, createdBy: SETUP_ACTOR,
      })),
      ...(options.plantScopes ?? ['1000']).map((scopeValue) => ({
        id: randomUUID(), client, userId, scopeType: 'PLANT', scopeValue, createdBy: SETUP_ACTOR,
      })),
    ];
    if (restrictions.length) await tx.insert(authOrgRestriction).values(restrictions);
    await createSession(tx, { client, userId });
  });
  const sessions = await withTenant(client, async (tx) => tx.execute(sql`
    select id from user_session
     where client = ${client} and user_id = ${userId}
       and revoked_at is null and expires_at > now()
     order by issued_at desc limit 1
  `) as unknown as Array<{ id: string }>);
  const sessionId = String(sessions[0]?.id ?? '');
  if (!sessionId) throw new Error('COGI test actor session was not persisted.');
  return { username, userId, sessionId, authorization: { userId, sessionId } };
}
