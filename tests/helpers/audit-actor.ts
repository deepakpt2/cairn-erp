/**
 * A signed-in actor for the auditor-workspace tests.
 *
 * The audit services ask who is acting — a live session, the named authority and,
 * for the controller's acts, an explicit Company Code reach — so a test needs a real
 * identity: a row in `app_user`, a role carrying the capabilities, restriction rows
 * and a live session. Built the same way as the sales and finance actors.
 *
 * The capabilities go into `role_capability` as written, wildcards included: the
 * auditor is given broad patterns on purpose, so the tests prove a live grant cuts
 * them down rather than relying on a role that never held anything.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { hashPassword } from '../../src/platform/auth/password';
import { createSession } from '../../src/platform/auth/session';
import { withTenant } from '../../src/platform/db/client';
import { appUser, authOrgRestriction, role, roleCapability, userRole } from '../../src/platform/tables/security';

const SETUP_ACTOR = 'AUDIT_ACTOR_SETUP';

export interface AuditTestActor {
  client: string;
  username: string;
  userId: string;
  sessionId: string;
  roleCode: string;
  /** What a service judging authority takes. */
  authorization: { userId: string; sessionId: string };
  /** What the audit read services take. */
  actor: { client: string; userId: string; username: string };
}

/** The auditor: workspace, trail and export, plus the display side of finance. */
export const AUDITOR_CAPABILITIES: readonly string[] = [
  'AUDIT.WORKSPACE',
  'AUDIT.TRAIL.VIEW',
  'AUDIT.EVIDENCE.EXPORT',
  'FIN.JOURNAL.DISPLAY',
  'FIN.GL.BALANCE',
];

/** The controller: grants access and answers requests. */
export const CONTROLLER_CAPABILITIES: readonly string[] = ['AUDIT.ACCESS.GRANT', 'AUDIT.REQUEST.RESPOND'];

export async function createAuditActor(
  client: string,
  options: { username?: string; capabilities: readonly string[]; companyScopes?: readonly string[] },
): Promise<AuditTestActor> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const username = options.username ?? `AUDIT_ACTOR_${suffix}`;
  const userId = randomUUID();
  const roleCode = `TEST_AUDIT_${suffix}`;

  const companies = await withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select company_code as code from company_code where client = ${client}
    `)) as unknown as Array<{ code: string }>;
    return (options.companyScopes ?? rows.map((row) => row.code)).map(String);
  });

  await withTenant(client, async (tx) => {
    await tx.insert(role).values({
      client,
      code: roleCode,
      name: 'Audit test authority',
      description: 'Test-only role for the auditor workspace suite',
      isSystemRole: false,
      isReadOnly: false,
      createdBy: SETUP_ACTOR,
    });
    for (const capabilityCode of new Set(options.capabilities)) {
      await tx.insert(roleCapability).values({ client, roleCode, capabilityCode, createdBy: SETUP_ACTOR });
    }
    await tx.insert(appUser).values({
      id: userId,
      client,
      username,
      fullName: username,
      passwordHash: await hashPassword('audit-actor-test-only-not-a-login-secret'),
      isActive: true,
      isLocked: false,
      createdBy: SETUP_ACTOR,
    });
    await tx.insert(userRole).values({ client, userId, roleCode, createdBy: SETUP_ACTOR });
    if (companies.length) {
      await tx.insert(authOrgRestriction).values(
        companies.map((scopeValue) => ({
          id: randomUUID(), client, userId, scopeType: 'COMPANY_CODE' as const, scopeValue, createdBy: SETUP_ACTOR,
        })),
      );
    }
    await createSession(tx, { client, userId });
  });

  const sessions = (await withTenant(client, (tx) => tx.execute(sql`
    select id from user_session
     where client = ${client} and user_id = ${userId} and revoked_at is null and expires_at > now()
     order by issued_at desc limit 1
  `))) as unknown as Array<{ id: string }>;
  const sessionId = String(sessions[0]?.id ?? '');
  if (!sessionId) throw new Error(`The audit test actor ${username} was not signed in.`);

  return {
    client,
    username,
    userId,
    sessionId,
    roleCode,
    authorization: { userId, sessionId },
    actor: { client, userId, username },
  };
}
