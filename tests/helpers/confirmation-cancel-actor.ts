import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { createSession } from '../../src/platform/auth/session';
import { hashPassword } from '../../src/platform/auth/password';
import { withTenant } from '../../src/platform/db/client';
import { appUser, authOrgRestriction, capability, role, roleCapability, userRole } from '../../src/platform/tables/security';

const ACTOR = 'CO13_TEST_SETUP';

export interface ConfirmationCancelTestActor {
  username: string;
  userId: string;
  sessionId: string;
  authorization: { userId: string; sessionId: string };
}

/** Create a persisted test identity/session with explicit cancellation capability and org scopes. */
export async function createConfirmationCancelTestActor(
  client: string,
  options: {
    username?: string;
    canCancel?: boolean;
    companyScopes?: string[];
    plantScopes?: string[];
  } = {},
): Promise<ConfirmationCancelTestActor> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const username = options.username ?? `CO13_${suffix}`;
  const userId = randomUUID();
  const roleCode = `TEST_CO13_${suffix}`;

  await withTenant(client, async (tx) => {
    await tx.insert(capability).values({
      code: 'PROD.CONFIRM.CANCEL', module: 'PROD', action: 'REVERSE', isPostingRelevant: false,
      description: 'Test-only CO13 cancellation authority',
    }).onConflictDoNothing();
    await tx.insert(role).values({
      client, code: roleCode, name: 'CO13 test authority', description: 'Test-only role',
      isSystemRole: false, isReadOnly: false, createdBy: ACTOR,
    });
    if (options.canCancel !== false) {
      await tx.insert(roleCapability).values({
        client, roleCode, capabilityCode: 'PROD.CONFIRM.CANCEL', createdBy: ACTOR,
      });
    }
    await tx.insert(appUser).values({
      id: userId,
      client,
      username,
      fullName: username,
      passwordHash: await hashPassword('CO13-test-only-not-a-login-secret'),
      isActive: true,
      isLocked: false,
      createdBy: ACTOR,
    });
    await tx.insert(userRole).values({ client, userId, roleCode, createdBy: ACTOR });

    const restrictions = [
      ...(options.companyScopes ?? ['1000']).map((scopeValue) => ({
        id: randomUUID(), client, userId, scopeType: 'COMPANY_CODE', scopeValue, createdBy: ACTOR,
      })),
      ...(options.plantScopes ?? ['1000']).map((scopeValue) => ({
        id: randomUUID(), client, userId, scopeType: 'PLANT', scopeValue, createdBy: ACTOR,
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
  if (!sessionId) throw new Error('CO13 test actor session was not persisted.');

  return { username, userId, sessionId, authorization: { userId, sessionId } };
}
