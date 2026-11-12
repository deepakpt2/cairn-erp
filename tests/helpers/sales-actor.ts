/**
 * A signed-in sales actor for the service tests.
 *
 * The sales services — the order, the delivery, the billing document and the
 * customer payment — ask who is acting: a live session, the named authority, and
 * an explicit Company Code and Plant reach (a payment is a company's, so it is
 * judged on the company code alone). A test that calls them therefore needs a
 * real identity: a row in `app_user`, a role carrying the authorities, restriction
 * rows, and a live session whose id it can hand to the service.
 *
 * This helper builds one, over every company code and plant the tenant has, so a
 * suite can create it once its masters stand and then post against any plant it
 * likes. A test that needs to prove a refusal asks for a narrower actor instead
 * of a missing one.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { hashPassword } from '../../src/platform/auth/password';
import { createSession } from '../../src/platform/auth/session';
import { withTenant } from '../../src/platform/db/client';
import {
  appUser, authOrgRestriction, role, roleCapability, userRole,
} from '../../src/platform/tables/security';

const SETUP_ACTOR = 'SALES_ACTOR_SETUP';

export interface SalesActor {
  username: string;
  userId: string;
  sessionId: string;
  /** What a sales service takes. */
  authorization: { userId: string; sessionId: string };
}

/** The authorities the sales services ask for, and the movements they post. */
export const SALES_ACTOR_CAPABILITIES: readonly string[] = [
  'SALES.ORDER.CREATE',
  'SALES.ORDER.RELEASE',
  'SALES.DELIVERY.CREATE',
  'SALES.DELIVERY.PICK',
  'SALES.BILLING.CREATE',
  'SALES.BILLING.CANCEL',
  'SALES.GI.POST',
  'SALES.PAYMENT.ENTER',
  'SALES.CREDIT.RELEASE',
  'SALES.INVOICE_LIST.CREATE',
  'SALES.INVOICE_LIST.RELEASE',
  'SALES.INCOMPLETION.PROCESS',
  'INV.GI.POST',
  'INV.GR.POST',
  'INV.RETURN.POST',
  'INV.TRANSFER.POST',
  'FIN.AR.PAYMENT.ENTER',
  'FIN.AR.CLEAR',
  'FIN.AR.INVOICE.POST',
  'FIN.CLEARING.RESET',
  'FIN.GL.CLEAR',
];

export interface SalesActorOptions {
  username?: string;
  /** Defaults to the full sales set. An empty list grants none, which is how a refusal is proved. */
  capabilities?: readonly string[];
  /** Defaults to every plant in the tenant. An empty list grants none. */
  plantScopes?: readonly string[];
  /** Defaults to every company code in the tenant. An empty list grants none. */
  companyScopes?: readonly string[];
}

/** Create a persisted identity, grant it its authorities and reach, and sign it in. */
export async function createSalesActor(
  client: string,
  options: SalesActorOptions = {},
): Promise<SalesActor> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const username = options.username ?? `SALES_ACTOR_${suffix}`;
  const userId = randomUUID();
  const roleCode = `TEST_SALES_${suffix}`;
  const capabilities = options.capabilities ?? SALES_ACTOR_CAPABILITIES;

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
      name: 'Sales test authority',
      description: 'Test-only role carrying the sales authorities',
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
      passwordHash: await hashPassword('sales-actor-test-only-not-a-login-secret'),
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
  if (!sessionId) throw new Error(`The sales test actor ${username} was not signed in.`);

  return { username, userId, sessionId, authorization: { userId, sessionId } };
}

/**
 * Re-grant every company code and plant the tenant now has.
 *
 * A suite signs its actor in near the top of `beforeAll`, because the setup that
 * follows calls the services too — and by the time setup is done the tenant may
 * hold plants that did not exist when the actor was created. Call it before each
 * post, not only at sign-in.
 */
export async function refreshSalesActor(client: string, actor: { userId: string }): Promise<void> {
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
