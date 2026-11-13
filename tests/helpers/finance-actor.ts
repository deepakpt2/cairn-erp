/**
 * A signed-in finance and controlling actor for the service tests.
 *
 * The finance services — the G/L document, the outgoing payment, the
 * reclassification, the dunning run, the tax return, the accrual and the
 * carryforward — and the controlling services — the internal order and its
 * settlement — ask who is acting: a live session, the named authority, and an
 * explicit Company Code reach. A test that calls them therefore needs a real
 * identity: a row in `app_user`, a role carrying the authorities, restriction
 * rows, and a live session whose id it can hand to the service.
 *
 * This helper builds one, over every company code the tenant has, so a suite can
 * create it once its structure stands and then post against any company it
 * likes. A test that needs to prove a refusal asks for a narrower actor instead
 * of a missing one.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import type { ServiceAuthorityContext } from '../../src/platform/auth/service-authority';
import { hashPassword } from '../../src/platform/auth/password';
import { createSession } from '../../src/platform/auth/session';
import { withTenant } from '../../src/platform/db/client';
import {
  appUser, authOrgRestriction, role, roleCapability, userRole,
} from '../../src/platform/tables/security';

const SETUP_ACTOR = 'FINANCE_ACTOR_SETUP';

export interface FinanceActor {
  username: string;
  userId: string;
  sessionId: string;
  /** What an enforced service takes. */
  authorization: { userId: string; sessionId: string };
}

/** The authorities the finance and controlling services ask for. */
export const FINANCE_ACTOR_CAPABILITIES: readonly string[] = [
  'FIN.JOURNAL.POST',
  'FIN.JOURNAL.PARK',
  'FIN.AP.PAYMENT.POST',
  'FIN.AR.PAYMENT.ENTER',
  'FIN.GRIR.RECLASS',
  'FIN.AR.DUNNING.RUN',
  'FIN.TAX.REPORT',
  'FIN.ACCRUAL.POST',
  'FIN.CLOSE.CARRYFORWARD',
  'FIN.GL.CLEAR',
  'FIN.AP.CLEAR',
  'FIN.AR.CLEAR',
  'CO.ORDER.MAINTAIN',
  'CO.SETTLE.ORDER',
  'CO.SETTLE.COLLECTIVE',
  'CO.SETTLE.RULE',
  'CO.BUDGET.ORIGINAL.CHANGE',
  'CO.PLANREVAL.CREATE',
];

export interface FinanceActorOptions {
  username?: string;
  /** Defaults to the full finance set. An empty list grants none, which is how a refusal is proved. */
  capabilities?: readonly string[];
  /** Defaults to every company code in the tenant. An empty list grants none. */
  companyScopes?: readonly string[];
  /** Defaults to every plant in the tenant. An empty list grants none. */
  plantScopes?: readonly string[];
}

/** Create a persisted identity, grant it its authorities and reach, and sign it in. */
export async function createFinanceActor(
  client: string,
  options: FinanceActorOptions = {},
): Promise<FinanceActor> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const username = options.username ?? `FINANCE_ACTOR_${suffix}`;
  const userId = randomUUID();
  const roleCode = `TEST_FINANCE_${suffix}`;
  const capabilities = options.capabilities ?? FINANCE_ACTOR_CAPABILITIES;

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

  await grant(client, userId, username, roleCode, capabilities, scopes);

  const sessions = await withTenant(client, async (tx) => tx.execute(sql`
    select id from user_session
     where client = ${client} and user_id = ${userId}
       and revoked_at is null and expires_at > now()
     order by issued_at desc limit 1
  `) as unknown as Array<{ id: string }>);
  const sessionId = String(sessions[0]?.id ?? '');
  if (!sessionId) throw new Error(`The finance test actor ${username} was not signed in.`);

  return { username, userId, sessionId, authorization: { userId, sessionId } };
}

/**
 * Re-grant every company code and plant the tenant now has.
 *
 * A suite signs its actor in near the top of `beforeAll`, because the setup that
 * follows creates the structure — and by the time setup is done the tenant may
 * hold company codes or plants that did not exist when the actor was created.
 * Call it before each test that posts.
 */
export async function refreshFinanceActorScopes(client: string, actor: FinanceActor): Promise<void> {
  const scopes = await withTenant(client, async (tx) => {
    const companies = (await tx.execute(sql`
      select company_code as code from company_code where client = ${client}
    `)) as unknown as Array<{ code: string }>;
    const plants = (await tx.execute(sql`
      select plant as code from plant where client = ${client}
    `)) as unknown as Array<{ code: string }>;
    return { companies: companies.map((r) => String(r.code)), plants: plants.map((r) => String(r.code)) };
  });
  await withTenant(client, async (tx) => {
    await tx.execute(sql`delete from auth_org_restriction
      where client = ${client} and user_id = ${actor.userId}`);
    const restrictions = [
      ...scopes.companies.map((scopeValue) => ({
        id: randomUUID(), client, userId: actor.userId, scopeType: 'COMPANY_CODE' as const,
        scopeValue, createdBy: SETUP_ACTOR,
      })),
      ...scopes.plants.map((scopeValue) => ({
        id: randomUUID(), client, userId: actor.userId, scopeType: 'PLANT' as const,
        scopeValue, createdBy: SETUP_ACTOR,
      })),
    ];
    if (restrictions.length) await tx.insert(authOrgRestriction).values(restrictions);
  });
}

async function grant(
  client: string,
  userId: string,
  username: string,
  roleCode: string,
  capabilities: readonly string[],
  scopes: { companies: string[]; plants: string[] },
): Promise<void> {
  await withTenant(client, async (tx) => {
    await tx.insert(role).values({
      client,
      code: roleCode,
      name: 'Finance test authority',
      description: 'Test-only role carrying the finance and controlling authorities',
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
      passwordHash: await hashPassword('finance-actor-test-only-not-a-login-secret'),
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
}

/**
 * Wrap a service that takes its authority as a second argument, so a suite that
 * posts through it does not have to name the actor at every call.
 *
 * The actor is created the first time the service is called, which is inside a
 * test, which is after the tenant and its company codes stand — and the wrapper
 * reads the client off the input, so it needs nothing the call site does not
 * already have.
 */
export function financePoster<A extends { client: string }, R>(
  service: (input: A, options: { authorization?: ServiceAuthorityContext }) => Promise<R>,
): (input: A) => Promise<R> {
  let actor: FinanceActor | undefined;
  return async (input: A): Promise<R> => {
    actor = await standingActor(input.client, actor);
    return service(input, { authorization: actor.authorization });
  };
}

/** The same, for a service that carries the authority inside its own input. */
export function financeInputPoster<A extends { client: string }, R>(
  service: (input: A & { authorization?: ServiceAuthorityContext }) => Promise<R>,
): (input: A) => Promise<R> {
  let actor: FinanceActor | undefined;
  return async (input: A): Promise<R> => {
    actor = await standingActor(input.client, actor);
    return service({ ...input, authorization: actor.authorization });
  };
}

/**
 * Whether the actor's session still stands.
 *
 * A suite that rebuilds its tenant between tests leaves the actor's user and
 * session rows behind with the old tenant, and a service that asks who is acting
 * then answers "no longer active" — which is the service being right and the
 * helper being wrong. So the wrapper asks before it reuses one.
 */
async function sessionStands(client: string, actor: FinanceActor): Promise<boolean> {
  try {
    return await withTenant(client, async (tx) => {
      const rows = (await tx.execute(sql`
        select 1 as present
          from user_session
         where client = ${client} and id = ${actor.sessionId} and user_id = ${actor.userId}
           and revoked_at is null and expires_at > now()
      `)) as unknown as Array<{ present: number }>;
      return rows.length > 0;
    });
  } catch {
    return false;
  }
}

/** An actor that stands for this client, created or replaced as the suite rebuilds. */
async function standingActor(client: string, current?: FinanceActor): Promise<FinanceActor> {
  if (current && (await sessionStands(client, current))) return current;
  return createFinanceActor(client);
}
