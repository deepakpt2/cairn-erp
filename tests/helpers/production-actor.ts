/**
 * A signed-in production actor for the service tests.
 *
 * The production services — create, release, change, technical completion, the
 * component issue and the finished-good receipt — refuse a caller who is not a
 * signed-in user holding the named authority *and* an explicit Company Code and
 * Plant grant. A test that calls them therefore needs a real identity: a row in
 * `app_user`, a role carrying the authorities, two restriction rows, and a live
 * session whose id it can hand to the service.
 *
 * This helper builds one. It grants the actor reach over every company code and
 * every plant the tenant has at the moment it is called, so a suite can create it
 * once its masters stand and then post against any plant it likes; a test that
 * needs to prove a refusal asks for a narrower actor instead of a missing one.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { hashPassword } from '../../src/platform/auth/password';
import { createSession } from '../../src/platform/auth/session';
import { withTenant } from '../../src/platform/db/client';
import {
  appUser, authOrgRestriction, role, roleCapability, userRole,
} from '../../src/platform/tables/security';

const SETUP_ACTOR = 'PRODUCTION_ACTOR_SETUP';

export interface ProductionActor {
  username: string;
  userId: string;
  sessionId: string;
  /** What a production service takes. */
  authorization: { userId: string; sessionId: string };
}

/** The authorities the production services ask for, and the movements they post. */
export const PRODUCTION_ACTOR_CAPABILITIES: readonly string[] = [
  'PROD.ORDER.CREATE',
  'PROD.ORDER.RELEASE',
  'PROD.ORDER.CHANGE',
  'PROD.ORDER.GI',
  'PROD.ORDER.GR',
  'PROD.CONFIRM.ENTER',
  'PROD.CONFIRM.ORDER',
  'PROD.CONFIRM.CANCEL',
  // The confirmation's automatic movements are recorded the way COGI records them, so
  // the same recovery authority is needed for a ticket that names a user at all.
  'PROD.GM.REPROCESS',
  'INV.GI.POST',
  'INV.GR.POST',
];

export interface ProductionActorOptions {
  username?: string;
  /** Defaults to the full production set. An empty list grants none, which is how a refusal is proved. */
  capabilities?: readonly string[];
  /** Defaults to every plant in the tenant. An empty list grants none. */
  plantScopes?: readonly string[];
  /** Defaults to every company code in the tenant. An empty list grants none. */
  companyScopes?: readonly string[];
}

/** Create a persisted identity, grant it its authorities and reach, and sign it in. */
export async function createProductionActor(
  client: string,
  options: ProductionActorOptions = {},
): Promise<ProductionActor> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const username = options.username ?? `PROD_ACTOR_${suffix}`;
  const userId = randomUUID();
  const roleCode = `TEST_PROD_${suffix}`;
  const capabilities = options.capabilities ?? PRODUCTION_ACTOR_CAPABILITIES;

  const scopes = await withTenant(client, async (tx) => {
    const companies = (await tx.execute(sql`
      select company_code as code from company_code where client = ${client}
    `)) as unknown as Array<{ code: string }>;
    const plants = (await tx.execute(sql`
      select plant as code from plant where client = ${client}
    `)) as unknown as Array<{ code: string }>;
    return {
      companies: (options.companyScopes ?? companies.map((row) => row.code)).map(String),
      plants: (options.plantScopes ?? plants.map((row) => row.code)).map(String),
    };
  });

  await withTenant(client, async (tx) => {
    await tx.insert(role).values({
      client,
      code: roleCode,
      name: 'Production test authority',
      description: 'Test-only role carrying the production authorities',
      isSystemRole: false,
      isReadOnly: false,
      createdBy: SETUP_ACTOR,
    });
    for (const capabilityCode of capabilities) {
      await tx.insert(roleCapability).values({
        client, roleCode, capabilityCode, createdBy: SETUP_ACTOR,
      });
    }
    await tx.insert(appUser).values({
      id: userId,
      client,
      username,
      fullName: username,
      passwordHash: await hashPassword('production-actor-test-only-not-a-login-secret'),
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
  if (!sessionId) throw new Error(`The production test actor ${username} was not signed in.`);

  return { username, userId, sessionId, authorization: { userId, sessionId } };
}

/**
 * Extend an actor's reach to plants created after it was signed in. A suite that
 * builds a second plant inside a test calls this before posting against it.
 */
export async function grantActorPlants(client: string, actor: ProductionActor, plants: readonly string[]): Promise<void> {
  const wanted = plants.map((plant) => plant.trim()).filter(Boolean);
  if (!wanted.length) return;
  await grantScopes(client, actor.userId, [], wanted);
}

/**
 * Re-grant every company code and plant the tenant now has.
 *
 * A suite signs its actor in near the top of `beforeAll`, because the setup that
 * follows calls the services too — and by the time setup is done the tenant may
 * hold plants that did not exist when the actor was created. This is the second
 * half of that arrangement: call it once the masters stand.
 */
export async function refreshActorPlants(client: string, actor: { userId: string }): Promise<void> {
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
  await grantScopes(client, actor.userId, scopes.companies, scopes.plants);
}

/** Insert the restrictions that are not already there. */
async function grantScopes(
  client: string,
  userId: string,
  companies: readonly string[],
  plants: readonly string[],
): Promise<void> {
  await withTenant(client, async (tx) => {
    const held = (await tx.execute(sql`
      select scope_type as "scopeType", scope_value as "scopeValue"
        from auth_org_restriction
       where client = ${client} and user_id = ${userId}
    `)) as unknown as Array<{ scopeType: string; scopeValue: string }>;
    const missing = [
      ...companies.filter((code) => !held.some((row) => row.scopeType === 'COMPANY_CODE' && row.scopeValue === code))
        .map((code) => ({ scopeType: 'COMPANY_CODE' as const, scopeValue: code })),
      ...plants.filter((code) => !held.some((row) => row.scopeType === 'PLANT' && row.scopeValue === code))
        .map((code) => ({ scopeType: 'PLANT' as const, scopeValue: code })),
    ];
    if (!missing.length) return;
    await tx.insert(authOrgRestriction).values(missing.map((row) => ({
      id: randomUUID(), client, userId, createdBy: SETUP_ACTOR, ...row,
    })));
  });
}
