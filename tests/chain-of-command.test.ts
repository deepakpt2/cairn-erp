/**
 * Chain of command — who a person answers to.
 *
 * The structure is built with the same services `/people/organization` and
 * `/people/assignments` call, so the tree under test is one the product can
 * actually produce. Employees and application users are written directly,
 * because the user-to-personnel-number link is the thing under test and routing
 * it through a service that already assumes it would prove nothing.
 *
 * Everything hinges on one join that did not exist before this slice:
 * `app_user` meets `personnel_number` only through `employee.app_user_id`, so
 * authority (keyed by user) can only reach the reporting line (keyed by
 * position) through it.
 *
 * Assignments open in 2020, which is in the past for as long as this suite
 * matters, so "current" means current today without depending on the date.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { appUser } from '../src/platform/tables/security';
import { assignPosition as assignPositionService } from '../src/modules/people/assignment';
import { employee } from '../src/modules/people/schema';
import {
  ASSIGNMENT_CAPABILITY,
} from '../src/modules/people/assignment';
import {
  ORG_UNIT_CAPABILITY,
  POSITION_CAPABILITY,
  changePosition as changePositionService,
  defineJob as defineJobService,
  defineOrgUnit as defineOrgUnitService,
  definePosition as definePositionService,
} from '../src/modules/people/org-structure';
import {
  ChainOfCommandError,
  chainAbove,
  holdersOfPosition,
  orgUnitOfPosition,
  positionsBelow,
  positionsOfUser,
  superiorOfUser,
  superiorPositionOf,
} from '../src/modules/people/chain-of-command';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'CHAIN_OF_COMMAND_TEST';
const ORG_AUTH = [ORG_UNIT_CAPABILITY] as const;
const POS_AUTH = [POSITION_CAPABILITY] as const;
const ASN_AUTH = [ASSIGNMENT_CAPABILITY] as const;
const defineOrgUnit = (input: Parameters<typeof defineOrgUnitService>[0]) => defineOrgUnitService(input, ORG_AUTH);
const defineJob = (input: Parameters<typeof defineJobService>[0]) => defineJobService(input, POS_AUTH);
const definePosition = (input: Parameters<typeof definePositionService>[0]) => definePositionService(input, POS_AUTH);
const changePosition = (input: Parameters<typeof changePositionService>[0]) => changePositionService(input, POS_AUTH);
const assignPosition = (input: Parameters<typeof assignPositionService>[0]) => assignPositionService(input, ASN_AUTH);

const AREA = 'A000';
const CC = 'CC100';
const FROM = '2020-01-01';

let tenant: TestTenant;
let counter = 0;
const codeFor = (what: string) => `${what}${String(++counter).padStart(3, '0')}`;

/** A person who can sign in, and the personnel number the structure knows them by. */
async function person(name: string): Promise<{ userId: string; personnelNumber: string; username: string }> {
  const client = tenant.client;
  const userId = `coc-${name}-${++counter}`;
  const username = `coc.${name}.${counter}`;
  const personnelNumber = `P${String(9100000 + counter)}`;
  await withTenant(client, async (tx) => {
    await tx.insert(appUser).values({
      id: userId,
      client,
      username,
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
  return { userId, personnelNumber, username };
}

let boss: Awaited<ReturnType<typeof person>>;
let middle: Awaited<ReturnType<typeof person>>;
let junior: Awaited<ReturnType<typeof person>>;
let stranger: Awaited<ReturnType<typeof person>>;

let PTOP = '';
let PMID = '';
let PBOT = '';
let ROOT = '';
let SUB = '';

beforeAll(async () => {
  tenant = await createTenant('chain-of-command', { currency: 'INR' });

  // The cost centre the assignments name. The service asks the dated master as of
  // the assignment's first day, so the fixture needs a span wide enough to cover
  // it; 2020-01-01 is the day the test means and this span covers it.
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${tenant.client}, ${AREA}, ${CC}, '2020-01-01', '9999-12-31', 'Chain of command cost centre', 'PRODUCTION', '1000', ${ACTOR})
      on conflict do nothing`);
  });
  const client = tenant.client;

  boss = await person('boss');
  middle = await person('middle');
  junior = await person('junior');
  stranger = await person('stranger');

  ROOT = codeFor('U');
  SUB = codeFor('U');
  await defineOrgUnit({ client, code: ROOT, name: `Root ${ROOT}`, changedBy: ACTOR });
  await defineOrgUnit({ client, code: SUB, name: `Sub ${SUB}`, parentCode: ROOT, changedBy: ACTOR });

  const job = codeFor('J');
  await defineJob({ client, code: job, name: `Job ${job}`, changedBy: ACTOR });

  PTOP = codeFor('P');
  PMID = codeFor('P');
  PBOT = codeFor('P');
  await definePosition({ client, code: PTOP, title: 'Head', jobCode: job, orgUnitCode: ROOT, changedBy: ACTOR });
  await definePosition({ client, code: PMID, title: 'Manager', jobCode: job, orgUnitCode: SUB, superiorCode: PTOP, changedBy: ACTOR });
  await definePosition({ client, code: PBOT, title: 'Clerk', jobCode: job, orgUnitCode: SUB, superiorCode: PMID, changedBy: ACTOR });

  for (const [who, positionCode] of [[boss, PTOP], [middle, PMID], [junior, PBOT]] as const) {
    await assignPosition({
      client,
      personnelNumber: who.personnelNumber,
      positionCode,
      controllingArea: AREA,
      costCenter: CC,
      validFrom: FROM,
      changedBy: ACTOR,
    });
  }
}, 120_000);

afterAll(async () => {
  await destroyTenant(tenant.client);
});

describe('chain of command', () => {
  it('reaches a person from a user through the employee link', async () => {
    const held = await withTenant(tenant.client, (tx) => positionsOfUser(tx, tenant.client, junior.userId));
    expect(held.map((p) => p.code)).toEqual([PBOT]);
  });

  it('names the human who holds the position above', async () => {
    const [answer] = await withTenant(tenant.client, (tx) => superiorOfUser(tx, tenant.client, junior.userId));
    expect(answer?.kind).toBe('USER');
    if (answer?.kind !== 'USER') return;
    expect(answer.holder.userId).toBe(middle.userId);
    expect(answer.position.code).toBe(PMID);
  });

  it('walks past a vacant position to the next one that is held', async () => {
    // The manager leaves: the position stays, the holder does not.
    await withTenant(tenant.client, async (tx) => {
      await tx.update(employee).set({ appUserId: null }).where(eq(employee.personnelNumber, middle.personnelNumber));
    });
    const [answer] = await withTenant(tenant.client, (tx) => superiorOfUser(tx, tenant.client, junior.userId));
    expect(answer?.kind).toBe('USER');
    if (answer?.kind !== 'USER') return;
    expect(answer.holder.userId).toBe(boss.userId);
    expect(answer.position.code).toBe(PTOP);

    await withTenant(tenant.client, async (tx) => {
      await tx.update(employee).set({ appUserId: middle.userId }).where(eq(employee.personnelNumber, middle.personnelNumber));
    });
  });

  it('ends the reporting line in an org unit, not a person', async () => {
    const [answer] = await withTenant(tenant.client, (tx) => superiorOfUser(tx, tenant.client, boss.userId));
    expect(answer?.kind).toBe('ORG_UNIT');
    if (answer?.kind !== 'ORG_UNIT') return;
    expect(answer.orgUnitCode).toBe(ROOT);
    expect(answer.position.code).toBe(PTOP);
  });

  it('says so, rather than throwing, when a person holds no position', async () => {
    const [answer] = await withTenant(tenant.client, (tx) => superiorOfUser(tx, tenant.client, stranger.userId));
    expect(answer?.kind).toBe('UNATTACHED');
  });

  it('reads the line above a position, nearest first, ending at its unit', async () => {
    const line = await withTenant(tenant.client, (tx) => chainAbove(tx, tenant.client, PBOT));
    expect(line.positions.map((p) => p.code)).toEqual([PMID, PTOP]);
    expect(line.orgUnit?.code).toBe(ROOT);
  });

  it('reads the positions below, nearest first', async () => {
    const below = await withTenant(tenant.client, (tx) => positionsBelow(tx, tenant.client, PTOP));
    expect(below.map((p) => p.code)).toEqual([PMID, PBOT]);
  });

  it('refuses a ring rather than walking it for ever', async () => {
    const client = tenant.client;
    const ring = codeFor('U');
    await defineOrgUnit({ client, code: ring, name: `Ring ${ring}`, parentCode: ROOT, changedBy: ACTOR });
    const job = codeFor('J');
    await defineJob({ client, code: job, name: `Ring job ${job}`, changedBy: ACTOR });

    const A = codeFor('R');
    const B = codeFor('R');
    await definePosition({ client, code: A, title: 'A', jobCode: job, orgUnitCode: ring, changedBy: ACTOR });
    await definePosition({ client, code: B, title: 'B', jobCode: job, orgUnitCode: ring, superiorCode: A, changedBy: ACTOR });

    // The service will not write a ring: it refuses a parent that already hangs
    // below the child. So the ring is written past it, the way a careless psql
    // session or a bad import would. The walk still has to refuse it, because a
    // guard that only holds when the writer behaves is not a guard.
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into org_hierarchy (client, relation_type, parent_kind, parent_code, child_kind, child_code, created_by)
        values (${client}, 'REPORTS_TO', 'POSITION', ${B}, 'POSITION', ${A}, ${ACTOR})
        on conflict (client, relation_type, child_kind, child_code) do update set parent_code = ${B}`);
    });

    await expect(withTenant(client, (tx) => chainAbove(tx, client, A))).rejects.toThrow(/ring/i);
    await expect(withTenant(client, (tx) => chainAbove(tx, client, A))).rejects.toBeInstanceOf(ChainOfCommandError);
    await withTenant(client, (tx) => chainAbove(tx, client, A)).catch((error: ChainOfCommandError) => {
      expect(error.remedy.length).toBeGreaterThan(0);
    });
  });

  it('answers a dated question with the answer for that day', async () => {
    // Before the assignments opened, nobody held anything.
    const before = await withTenant(tenant.client, (tx) => superiorOfUser(tx, tenant.client, junior.userId, '2019-01-01'));
    expect(before.map((a) => a.kind)).toEqual(['UNATTACHED']);

    const onTheDay = await withTenant(tenant.client, (tx) => superiorOfUser(tx, tenant.client, junior.userId, FROM));
    expect(onTheDay[0]?.kind).toBe('USER');
  });

  it('holds a position to only its current span', async () => {
    const holders = await withTenant(tenant.client, (tx) => holdersOfPosition(tx, tenant.client, PMID));
    expect(holders.map((h) => h.userId)).toEqual([middle.userId]);
  });

  it('places the top position in its unit and finds no position above it', async () => {
    const client = tenant.client;
    const above = await withTenant(client, (tx) => superiorPositionOf(tx, client, PTOP));
    expect(above).toBeNull();
    const unit = await withTenant(client, (tx) => orgUnitOfPosition(tx, client, PTOP));
    expect(unit?.code).toBe(ROOT);
  });
});
