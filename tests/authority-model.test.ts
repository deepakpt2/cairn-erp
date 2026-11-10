/**
 * Authority — what a person may do, where, and until when.
 *
 * The three questions this file exists to answer are the ones the plan set out:
 *
 *   1. every existing one-argument call site must pass unchanged — a person who
 *      holds a capability through a role still holds it, with no migration of
 *      data and no second source of truth;
 *   2. a grant scoped to plant 1000 is refused on a plant 2000 document;
 *   3. an expired grant stops matching, with no job sweeping the table.
 *
 * Around those, the cases that decide whether the model is safe to build on:
 * scope belongs to the assignment, a level a grant does not name cannot refuse,
 * a user restriction still narrows everything, and one tenant's grants are
 * invisible to another.
 *
 * People are written directly, because the user-to-person-to-position chain is
 * the thing under test. The org structure is built with the same services the
 * product uses, so the tree is one the product can actually produce.
 */

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  appUser,
  authOrgRestriction,
  positionCapability,
  role,
  roleCapability,
  userCapability,
  userCapabilityScope,
  userRole,
} from '../src/platform/tables/security';
import { employee, positionAssignment } from '../src/modules/people/schema';
import {
  ASSIGNMENT_CAPABILITY,
  assignPosition as assignPositionService,
} from '../src/modules/people/assignment';
import {
  ORG_UNIT_CAPABILITY,
  POSITION_CAPABILITY,
  defineJob as defineJobService,
  defineOrgUnit as defineOrgUnitService,
  definePosition as definePositionService,
} from '../src/modules/people/org-structure';
import {
  can,
  canTx,
  canWith,
  effectiveGrants,
  patternMatches,
  type AuthorityGrant,
} from '../src/platform/auth/authority';
import { CREDIT_CONTROL_AREA_CAPABILITY } from '../src/platform/auth/capability-policy';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'AUTHORITY_MODEL_TEST';
const ORG_AUTH = [ORG_UNIT_CAPABILITY] as const;
const POS_AUTH = [POSITION_CAPABILITY] as const;
const ASN_AUTH = [ASSIGNMENT_CAPABILITY] as const;
const defineOrgUnit = (input: Parameters<typeof defineOrgUnitService>[0]) => defineOrgUnitService(input, ORG_AUTH);
const defineJob = (input: Parameters<typeof defineJobService>[0]) => defineJobService(input, POS_AUTH);
const definePosition = (input: Parameters<typeof definePositionService>[0]) => definePositionService(input, POS_AUTH);
const assignPosition = (input: Parameters<typeof assignPositionService>[0]) => assignPositionService(input, ASN_AUTH);

const AREA = 'A000';
const CC = 'CC100';
const FROM = '2020-01-01';

const READ = 'AUTHTEST.READ';
const WRITE = 'AUTHTEST.WRITE';
const APPROVE = 'AUTHTEST.APPROVE';
const DEEP = 'AUTHTEST.SUB.CREATE';

interface Person {
  userId: string;
  personnelNumber: string;
}

let tenant: TestTenant;
let other: TestTenant;
let counter = 0;
const codeFor = (what: string) => `${what}${String(++counter).padStart(3, '0')}`;

async function person(name: string, inTenant: TestTenant = tenant): Promise<Person> {
  const client = inTenant.client;
  const userId = `auth-${name}-${++counter}`;
  const personnelNumber = `P${String(8100000 + counter)}`;
  await withTenant(client, async (tx) => {
    await tx.insert(appUser).values({
      id: userId,
      client,
      username: `auth.${name}.${counter}`,
      fullName: `Test ${name}`,
      passwordHash: 'scrypt:not-a-real-hash:not-a-real-hash',
      isActive: true,
    });
    await tx.insert(employee).values({
      client,
      personnelNumber,
      fullName: `Test ${name}`,
      appUserId: userId,
      isActive: true,
      createdBy: ACTOR,
    });
  });
  return { userId, personnelNumber };
}

/** Authority through a role: the path that already existed. */
async function grantRole(userId: string, roleCode: string, patterns: string[]): Promise<void> {
  const client = tenant.client;
  await withTenant(client, async (tx) => {
    await tx
      .insert(role)
      .values({ client, code: roleCode, name: `Role ${roleCode}`, createdBy: ACTOR })
      .onConflictDoNothing();
    for (const pattern of patterns) {
      await tx
        .insert(roleCapability)
        .values({ client, roleCode, capabilityCode: pattern, createdBy: ACTOR })
        .onConflictDoNothing();
    }
    await tx.insert(userRole).values({ client, userId, roleCode, createdBy: ACTOR }).onConflictDoNothing();
  });
}

/** Authority given directly: dated, scoped, and traceable. This is what delegation writes. */
async function directGrant(
  userId: string,
  capability: string,
  opts: {
    from: string;
    to?: string | null;
    scope?: Record<string, string>;
    reason?: string;
    granter?: string;
    inTenant?: TestTenant;
  },
): Promise<string> {
  const t = opts.inTenant ?? tenant;
  const client = t.client;
  const id = `grant-${++counter}`;
  await withTenant(client, async (tx) => {
    await tx.insert(userCapability).values({
      id,
      client,
      userId,
      capabilityCode: capability,
      validFrom: opts.from,
      validTo: opts.to ?? null,
      reason: opts.reason ?? 'DIRECT',
      granter: opts.granter ?? ACTOR,
      createdBy: ACTOR,
    });
    for (const [scopeType, scopeValue] of Object.entries(opts.scope ?? {})) {
      await tx.insert(userCapabilityScope).values({ client, grantId: id, scopeType, scopeValue });
    }
  });
  return id;
}

/** Authority through a position: the join that did not exist before this slice. */
async function grantPosition(positionCode: string, patterns: string[]): Promise<void> {
  const client = tenant.client;
  await withTenant(client, async (tx) => {
    for (const pattern of patterns) {
      await tx
        .insert(positionCapability)
        .values({ client, positionCode, capabilityCode: pattern, createdBy: ACTOR })
        .onConflictDoNothing();
    }
  });
}

async function restrict(userId: string, scopeType: string, scopeValue: string): Promise<void> {
  const client = tenant.client;
  await withTenant(client, async (tx) => {
    await tx
      .insert(authOrgRestriction)
      .values({ id: `res-${++counter}`, client, userId, scopeType, scopeValue, createdBy: ACTOR });
  });
}

let alice: Person;
let bob: Person;
let carol: Person;
let dave: Person;
let eve: Person;

let PBUY = '';

beforeAll(async () => {
  tenant = await createTenant('authority-model');

  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${tenant.client}, ${AREA}, ${CC}, '2020-01-01', '9999-12-31', 'Authority model cost centre', 'PRODUCTION', '1000', ${ACTOR})
      on conflict do nothing`);
  });

  const client = tenant.client;

  alice = await person('alice');
  bob = await person('bob');
  carol = await person('carol');
  dave = await person('dave');

  const root = codeFor('U');
  await defineOrgUnit({ client, code: root, name: `Root ${root}`, changedBy: ACTOR });
  const job = codeFor('J');
  await defineJob({ client, code: job, name: `Job ${job}`, changedBy: ACTOR });

  PBUY = codeFor('P');
  await definePosition({ client, code: PBUY, title: 'Buyer', jobCode: job, orgUnitCode: root, changedBy: ACTOR });

  // Alice holds a role, which is the only path that existed before this slice.
  await grantRole(alice.userId, 'ROLE_BUYER', ['AUTHTEST.*']);
  // Dave holds the same role, and is later narrowed to one plant.
  await grantRole(dave.userId, 'ROLE_BUYER', ['AUTHTEST.*']);

  // Bob is given authority directly: one grant for one plant, one that has
  // already expired, and one that reads like a delegation.
  await directGrant(bob.userId, WRITE, { from: '2020-01-01', scope: { PLANT: '1000' } });
  await directGrant(bob.userId, APPROVE, { from: '2020-01-01', to: '2020-06-30' });
  await directGrant(bob.userId, DEEP, {
    from: '2020-01-01',
    scope: { SALES_ORG: 'S001' },
    reason: 'DELEGATION',
    granter: 'carol.manager',
  });

  // Carol holds a position, and the position carries authority. The place it
  // applies to is set on her assignment, not on the capability.
  await assignPosition({
    client,
    personnelNumber: carol.personnelNumber,
    positionCode: PBUY,
    controllingArea: AREA,
    costCenter: CC,
    validFrom: FROM,
    changedBy: ACTOR,
  });
  await grantPosition(PBUY, ['AUTHTEST.*']);
  await withTenant(client, async (tx) => {
    await tx
      .update(positionAssignment)
      .set({ plant: '1000' })
      .where(eq(positionAssignment.personnelNumber, carol.personnelNumber));
  });

  // A second tenant, so isolation is proved rather than assumed.
  other = await createTenant('authority-model-other');
  eve = await person('eve', other);
  await directGrant(eve.userId, WRITE, { from: '2020-01-01', inTenant: other });
}, 180_000);

afterAll(async () => {
  await destroyTenant(other.client);
  await destroyTenant(tenant.client);
});

describe('authority — the three questions the plan set out', () => {
  it('a role grant still answers the one-argument question, with nothing copied', async () => {
    expect(await can({ client: tenant.client, userId: alice.userId }, READ)).toBe(true);
    expect(await can({ client: tenant.client, userId: alice.userId }, WRITE)).toBe(true);
    // Outside her area entirely. A pattern covers what hangs beneath it, so the
    // negative case has to name a different area, not a deeper code in hers.
    expect(await can({ client: tenant.client, userId: alice.userId }, 'FINANCE.GL.POST')).toBe(false);
    expect(await can({ client: tenant.client, userId: alice.userId }, 'AUTHTESTX.READ')).toBe(false);

    // The role path is read live, so there is no second row to drift out of step.
    const rows = await withTenant(tenant.client, async (tx) =>
      tx
        .select({ id: userCapability.id })
        .from(userCapability)
        .where(eq(userCapability.userId, alice.userId)),
    );
    expect(rows).toEqual([]);
  });

  it('a grant scoped to plant 1000 is refused on a plant 2000 document', async () => {
    expect(await can({ client: tenant.client, userId: bob.userId }, WRITE, { plant: '1000' })).toBe(true);
    expect(await can({ client: tenant.client, userId: bob.userId }, WRITE, { plant: '2000' })).toBe(false);
    // Naming no place at all asks only "do you hold this", which the grant does answer.
    expect(await can({ client: tenant.client, userId: bob.userId }, WRITE)).toBe(true);
  });

  it('an expired grant stops matching, and nothing sweeps the table', async () => {
    expect(await can({ client: tenant.client, userId: bob.userId }, APPROVE, {}, '2020-03-01')).toBe(true);
    expect(await can({ client: tenant.client, userId: bob.userId }, APPROVE, {}, '2020-07-01')).toBe(false);
    expect(await can({ client: tenant.client, userId: bob.userId }, APPROVE)).toBe(false);

    // The row is still there. Dating is a filter, never a cleanup job.
    const surviving = await withTenant(tenant.client, async (tx) =>
      tx
        .select({ id: userCapability.id })
        .from(userCapability)
        .where(eq(userCapability.capabilityCode, APPROVE)),
    );
    expect(surviving.length).toBeGreaterThan(0);
  });

  it('a grant that has not begun yet does not match', async () => {
    const future = await directGrant(bob.userId, 'AUTHTEST.LATER', { from: '2099-01-01' });
    expect(future).toBeTruthy();
    expect(await can({ client: tenant.client, userId: bob.userId }, 'AUTHTEST.LATER')).toBe(false);
  });
});

describe('authority — where a grant applies', () => {
  it('a position carries authority, scoped to the place the assignment names', async () => {
    expect(await can({ client: tenant.client, userId: carol.userId }, READ, { plant: '1000' })).toBe(true);
    expect(await can({ client: tenant.client, userId: carol.userId }, READ, { plant: '2000' })).toBe(false);
    expect(await can({ client: tenant.client, userId: carol.userId }, READ)).toBe(true);
  });

  it('a level a grant does not name cannot refuse the question', async () => {
    // Bob's AUTHTEST.SUB.CREATE is scoped to a sales org, so it says nothing
    // about plants and must not be refused on one.
    expect(await can({ client: tenant.client, userId: bob.userId }, DEEP, { plant: '2000' })).toBe(true);
    expect(await can({ client: tenant.client, userId: bob.userId }, DEEP, { salesOrg: 'S001' })).toBe(true);
    expect(await can({ client: tenant.client, userId: bob.userId }, DEEP, { salesOrg: 'S002' })).toBe(false);
  });

  it('a user restriction still narrows everything the person holds', async () => {
    // Unrestricted until a moment ago.
    expect(await can({ client: tenant.client, userId: dave.userId }, WRITE, { plant: '2000' })).toBe(true);

    await restrict(dave.userId, 'PLANT', '1000');

    expect(await can({ client: tenant.client, userId: dave.userId }, WRITE, { plant: '1000' })).toBe(true);
    expect(await can({ client: tenant.client, userId: dave.userId }, WRITE, { plant: '2000' })).toBe(false);
    expect(await can({ client: tenant.client, userId: dave.userId }, WRITE)).toBe(true);
  });
});

describe('authority — provenance', () => {
  it('a delegation grant carries who gave it and why', async () => {
    const grants = await withTenant(tenant.client, (tx) =>
      effectiveGrants(tx, tenant.client, bob.userId),
    );
    const delegation = grants.find((g) => g.pattern === DEEP);
    expect(delegation?.source).toBe('DIRECT');
    expect(delegation?.reason).toBe('DELEGATION');
    expect(delegation?.granter).toBe('carol.manager');
    expect(delegation?.scope).toEqual({ salesOrg: ['S001'] });
  });

  it('names the source of each grant, so a refusal can be explained', async () => {
    const grants = await withTenant(tenant.client, (tx) =>
      effectiveGrants(tx, tenant.client, carol.userId),
    );
    expect(grants.every((g) => g.source === 'POSITION')).toBe(true);
    expect(grants.every((g) => g.positionCode === PBUY)).toBe(true);
  });
});

describe('authority — isolation', () => {
  it("one tenant's grants are invisible to another", async () => {
    // Eve holds a grant, but in the other tenant.
    expect(await can({ client: other.client, userId: eve.userId }, WRITE)).toBe(true);

    // The very same user id, read inside this tenant, holds nothing at all —
    // row-level security hides the row rather than any code branching on client.
    const leaked = await withTenant(tenant.client, (tx) => effectiveGrants(tx, tenant.client, eve.userId));
    expect(leaked).toEqual([]);
    expect(await can({ client: tenant.client, userId: eve.userId }, WRITE)).toBe(false);
  });

  it('asks the same question inside a transaction the caller already owns', async () => {
    const answer = await withTenant(tenant.client, (tx) =>
      canTx(tx, tenant.client, bob.userId, WRITE, { plant: '2000' }),
    );
    expect(answer).toBe(false);
  });
});

describe('authority — patterns and scope, without a database', () => {
  it('a pattern covers itself and what hangs beneath it, but not a sibling', () => {
    expect(patternMatches('PROC.*', 'PROC')).toBe(true);
    expect(patternMatches('PROC.*', 'PROC.REQ.CREATE')).toBe(true);
    expect(patternMatches('PROC.*', 'PROCX')).toBe(false);
    expect(patternMatches('PROC.REQ.CREATE', 'PROC.REQ.CREATE')).toBe(true);
    expect(patternMatches('PROC.REQ.CREATE', 'PROC.REQ.CHANGE')).toBe(false);
    expect(patternMatches('*', 'ANYTHING.AT.ALL')).toBe(true);
  });

  it('matching is the existing matcher, not a second opinion', () => {
    // Interior wildcards — the case a hand-rolled "ends in .*" test gets wrong.
    expect(patternMatches('PROC.*.CREATE', 'PROC.PO.CREATE')).toBe(true);
    expect(patternMatches('PROC.*.CREATE', 'PROC.PO.CHANGE')).toBe(false);

    // The length rule, in both directions: holding create grants neither the
    // object above it nor a deeper authority below it.
    expect(patternMatches('PROC.PO.CREATE', 'PROC.PO')).toBe(false);
    expect(patternMatches('PROC.PO.CREATE', 'PROC.PO.CREATE.APPROVE')).toBe(false);
    expect(patternMatches('PROC.*', 'PROC.PO.CREATE.APPROVE')).toBe(true);
  });

  it('refuses to honour a pattern for an authority that requires an exact grant', () => {
    // Authorities whose semantics require an exact grant: a broad pattern, even
    // `*`, must not hand them out. Authority is only safe while there is one
    // matcher, so this is asserted here rather than assumed from session.ts.
    const everything: AuthorityGrant = {
      source: 'ROLE',
      pattern: '*',
      validFrom: null,
      validTo: null,
      scope: {},
    };
    const exact: AuthorityGrant = { ...everything, pattern: CREDIT_CONTROL_AREA_CAPABILITY };

    expect(canWith([everything], CREDIT_CONTROL_AREA_CAPABILITY)).toBe(false);
    expect(canWith([exact], CREDIT_CONTROL_AREA_CAPABILITY)).toBe(true);
  });

  it('an unrestricted grant answers anywhere, and a scoped one only where it says', () => {
    const open: AuthorityGrant = {
      source: 'DIRECT',
      pattern: 'PROC.*',
      validFrom: '2020-01-01',
      validTo: null,
      scope: {},
    };
    const scoped: AuthorityGrant = { ...open, scope: { plant: ['1000', '3000'] } };

    expect(canWith([open], 'PROC.REQ.CREATE', { plant: '9999' })).toBe(true);
    expect(canWith([scoped], 'PROC.REQ.CREATE', { plant: '1000' })).toBe(true);
    expect(canWith([scoped], 'PROC.REQ.CREATE', { plant: '3000' })).toBe(true);
    expect(canWith([scoped], 'PROC.REQ.CREATE', { plant: '2000' })).toBe(false);

    // Either grant is enough: authority is a union, never an intersection.
    expect(canWith([scoped, open], 'PROC.REQ.CREATE', { plant: '2000' })).toBe(true);
    expect(canWith([], 'PROC.REQ.CREATE')).toBe(false);
  });

  it('a restriction narrows every grant the person holds', () => {
    const open: AuthorityGrant = {
      source: 'ROLE',
      pattern: 'PROC.*',
      validFrom: null,
      validTo: null,
      scope: {},
    };
    const narrowed = new Map([['plant' as const, ['1000']]]);
    expect(canWith([open], 'PROC.REQ.CREATE', { plant: '1000' }, narrowed)).toBe(true);
    expect(canWith([open], 'PROC.REQ.CREATE', { plant: '2000' }, narrowed)).toBe(false);
    expect(canWith([open], 'PROC.REQ.CREATE', {}, narrowed)).toBe(true);
  });
});
