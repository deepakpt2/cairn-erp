/**
 * A signed-in actor for the browser-smoke scripts.
 *
 * The smoke scripts set their scene by writing masters directly and then drive one
 * screen. The services they call on the way — creating, releasing and receiving a
 * production order — are the same services the UI calls, and they ask who is acting:
 * a live session, the named authority, and an explicit Company Code and Plant grant.
 * A script that writes masters under `browser.admin` signs nobody in, so this module
 * builds the identity the services will accept and hands back the ids they take.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { hashPassword } from '../../src/platform/auth/password';
import { createSession } from '../../src/platform/auth/session';
import {
  appUser, authOrgRestriction, role, roleCapability, userRole,
} from '../../src/platform/tables/security';

const SETUP_ACTOR = 'browser.smoke.setup';

/** The authorities the production screens and services ask for. */
export const BROWSER_PRODUCTION_CAPABILITIES: readonly string[] = [
  'PROD.ORDER.CREATE',
  'PROD.ORDER.RELEASE',
  'PROD.ORDER.CHANGE',
  'PROD.ORDER.GI',
  'PROD.ORDER.GR',
  'PROD.CONFIRM.ENTER',
  'PROD.CONFIRM.ORDER',
  'INV.GI.POST',
  'INV.GR.POST',
];

export interface BrowserActor {
  username: string;
  userId: string;
  sessionId: string;
  authorization: { userId: string; sessionId: string };
}

/**
 * Create a user holding the production authorities, grant it reach over every company
 * code and plant in the tenant, and sign it in. Idempotent in spirit rather than in
 * fact: each call makes a new identity, which is what a script that sets up its own
 * scene wants.
 */
export async function createBrowserActor(
  client: string,
  capabilities: readonly string[] = BROWSER_PRODUCTION_CAPABILITIES,
): Promise<BrowserActor> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  const username = `BROWSER_PROD_${suffix}`;
  const userId = randomUUID();
  const roleCode = `BROWSER_PROD_${suffix}`;

  const scopes = await withTenant(client, async (tx) => {
    const companies = (await tx.execute(sql`
      select company_code as code from company_code where client = ${client}
    `)) as unknown as Array<{ code: string }>;
    const plants = (await tx.execute(sql`
      select plant as code from plant where client = ${client}
    `)) as unknown as Array<{ code: string }>;
    return {
      companies: companies.map((row) => String(row.code)),
      plants: plants.map((row) => String(row.code)),
    };
  });

  await withTenant(client, async (tx) => {
    await tx.insert(role).values({
      client,
      code: roleCode,
      name: 'Browser smoke production authority',
      description: 'Throwaway role for a browser acceptance script',
      isSystemRole: false,
      isReadOnly: false,
      createdBy: SETUP_ACTOR,
    });
    for (const capabilityCode of capabilities) {
      await tx.insert(roleCapability).values({ client, roleCode, capabilityCode, createdBy: SETUP_ACTOR });
    }
    await tx.insert(appUser).values({
      id: userId,
      client,
      username,
      fullName: username,
      passwordHash: await hashPassword('browser-smoke-test-only-not-a-login-secret'),
      isActive: true,
      isLocked: false,
      createdBy: SETUP_ACTOR,
    });
    await tx.insert(userRole).values({ client, userId, roleCode, createdBy: SETUP_ACTOR });

    const restrictions = [
      ...scopes.companies.map((scopeValue) => ({
        id: randomUUID(), client, userId, scopeType: 'COMPANY_CODE' as const, scopeValue, createdBy: SETUP_ACTOR,
      })),
      ...scopes.plants.map((scopeValue) => ({
        id: randomUUID(), client, userId, scopeType: 'PLANT' as const, scopeValue, createdBy: SETUP_ACTOR,
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
  if (!sessionId) throw new Error(`The browser smoke actor ${username} was not signed in.`);

  return { username, userId, sessionId, authorization: { userId, sessionId } };
}

/**
 * Extend an actor's reach to the company codes and plants that now stand.
 *
 * A script builds its plant as part of the scene, sometimes after it has signed the
 * actor in; a service asked before that plant was granted answers that the actor's
 * reach does not cover it. Call this before posting, not only at sign-in.
 */
export async function refreshBrowserActor(client: string, actor: BrowserActor): Promise<void> {
  const scopes = await withTenant(client, async (tx) => {
    const companies = (await tx.execute(sql`
      select company_code as code from company_code where client = ${client}
    `)) as unknown as Array<{ code: string }>;
    const plants = (await tx.execute(sql`
      select plant as code from plant where client = ${client}
    `)) as unknown as Array<{ code: string }>;
    return {
      companies: companies.map((row) => String(row.code)),
      plants: plants.map((row) => String(row.code)),
    };
  });

  await withTenant(client, async (tx) => {
    const held = (await tx.execute(sql`
      select scope_type as "scopeType", scope_value as "scopeValue"
        from auth_org_restriction
       where client = ${client} and user_id = ${actor.userId}
    `)) as unknown as Array<{ scopeType: string; scopeValue: string }>;
    const missing = [
      ...scopes.companies
        .filter((code) => !held.some((row) => row.scopeType === 'COMPANY_CODE' && row.scopeValue === code))
        .map((scopeValue) => ({ scopeType: 'COMPANY_CODE' as const, scopeValue })),
      ...scopes.plants
        .filter((code) => !held.some((row) => row.scopeType === 'PLANT' && row.scopeValue === code))
        .map((scopeValue) => ({ scopeType: 'PLANT' as const, scopeValue })),
    ];
    if (!missing.length) return;
    await tx.insert(authOrgRestriction).values(missing.map((row) => ({
      id: randomUUID(), client, userId: actor.userId, createdBy: SETUP_ACTOR, ...row,
    })));
  });
}
