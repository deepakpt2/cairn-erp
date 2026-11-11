/**
 * Delegation — the state machine, the three creation flows, and the derived
 * authority.
 *
 * The structure is built with the same services the product calls, so the tree
 * under test is one the product can produce. Assignments open in 2020, which is
 * in the past for as long as this suite matters.
 *
 * What is worth proving here is not that a row can be written. It is the four
 * rules that make delegation trustworthy:
 *
 *   1. an unaccepted or unapproved delegation grants nothing at all
 *   2. two parties under different superiors collect both approvals
 *   3. the apex — an org unit — approves and revokes itself
 *   4. a delegate cannot extend, re-delegate or revoke; only the delegator can
 *
 * and the one that makes the whole design safe: authority is *derived*, so
 * taking it away from the delegator takes it away from the delegate too, with
 * no sweep job and no window.
 */

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { effectiveGrants, canWith } from '../src/platform/auth/authority';
import { appUser, userCapability, userCapabilityScope } from '../src/platform/tables/security';
import { assignPosition as assignPositionService } from '../src/modules/people/assignment';
import { employee } from '../src/modules/people/schema';
import { ASSIGNMENT_CAPABILITY } from '../src/modules/people/assignment';
import {
  ORG_UNIT_CAPABILITY,
  POSITION_CAPABILITY,
  defineJob as defineJobService,
  defineOrgUnit as defineOrgUnitService,
  definePosition as definePositionService,
} from '../src/modules/people/org-structure';
import { authorityChart } from '../src/modules/people/authority-chart';
import {
  approvalsSatisfied,
  closeDelegation,
  createDelegation,
  decideApproval,
  effectiveStatus,
  loadDelegation,
  respondToDelegation,
  revokeDelegation,
  scopeCovers,
  DelegationError,
} from '../src/modules/people/delegation';
import { delegation, delegationApproval } from '../src/modules/people/schema';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'DELEGATION_TEST';
const ORG_AUTH = [ORG_UNIT_CAPABILITY] as const;
const POS_AUTH = [POSITION_CAPABILITY] as const;
const ASN_AUTH = [ASSIGNMENT_CAPABILITY] as const;
const defineOrgUnit = (i: Parameters<typeof defineOrgUnitService>[0]) => defineOrgUnitService(i, ORG_AUTH);
const defineJob = (i: Parameters<typeof defineJobService>[0]) => defineJobService(i, POS_AUTH);
const definePosition = (i: Parameters<typeof definePositionService>[0]) => definePositionService(i, POS_AUTH);
const assignPosition = (i: Parameters<typeof assignPositionService>[0]) => assignPositionService(i, ASN_AUTH);

const AREA = 'A000';
const CC = 'CC100';
const FROM = '2020-01-01';
const TODAY = new Date().toISOString().slice(0, 10);

let tenant: TestTenant;
let counter = 0;
const codeFor = (what: string) => `${what}${String(++counter).padStart(3, '0')}`;

async function person(name: string) {
  const client = tenant.client;
  const userId = `dlg-${name}-${++counter}`;
  const username = `dlg.${name}.${counter}`;
  const personnelNumber = `P${String(9200000 + counter)}`;
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

/** A three-level line: head above manager above clerk, all in one branch. */
let head: Awaited<ReturnType<typeof person>>;
let manager: Awaited<ReturnType<typeof person>>;
let clerk: Awaited<ReturnType<typeof person>>;
/** A separate branch with its own head, so two parties can have two superiors. */
let otherHead: Awaited<ReturnType<typeof person>>;
let otherClerk: Awaited<ReturnType<typeof person>>;
/** A second clerk under the same manager, so two parties can share a superior. */
let clerk2: Awaited<ReturnType<typeof person>>;
let outsider: Awaited<ReturnType<typeof person>>;

beforeAll(async () => {
  tenant = await createTenant('delegation', { currency: 'INR' });
  const client = tenant.client;

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${client}, ${AREA}, ${CC}, '2020-01-01', '9999-12-31', 'Delegation cost centre', 'PRODUCTION', '1000', ${ACTOR})
      on conflict do nothing`);
  });

  head = await person('head');
  manager = await person('manager');
  clerk = await person('clerk');
  otherHead = await person('otherhead');
  otherClerk = await person('otherclerk');
  clerk2 = await person('clerk2');
  outsider = await person('outsider');

  const root = codeFor('U');
  const branch = codeFor('U');
  const otherBranch = codeFor('U');
  await defineOrgUnit({ client, code: root, name: `Root ${root}`, changedBy: ACTOR });
  await defineOrgUnit({ client, code: branch, name: `Branch ${branch}`, parentCode: root, changedBy: ACTOR });
  await defineOrgUnit({ client, code: otherBranch, name: `Other ${otherBranch}`, parentCode: root, changedBy: ACTOR });

  const job = codeFor('J');
  await defineJob({ client, code: job, name: `Job ${job}`, changedBy: ACTOR });

  const pHead = codeFor('P');
  const pManager = codeFor('P');
  const pClerk = codeFor('P');
  const pOtherHead = codeFor('P');
  const pOtherClerk = codeFor('P');
  const pClerk2 = codeFor('P');

  // pHead sits directly under the root org unit, so the line above it ends in
  // an org unit with no holder. That is the apex, and it is self-approving.
  await definePosition({ client, code: pHead, title: 'Head', jobCode: job, orgUnitCode: root, changedBy: ACTOR });
  await definePosition({
    client, code: pManager, title: 'Manager', jobCode: job, orgUnitCode: branch, superiorCode: pHead, changedBy: ACTOR,
  });
  await definePosition({
    client, code: pClerk, title: 'Clerk', jobCode: job, orgUnitCode: branch, superiorCode: pManager, changedBy: ACTOR,
  });
  await definePosition({
    client, code: pClerk2, title: 'Second clerk', jobCode: job, orgUnitCode: branch, superiorCode: pManager, changedBy: ACTOR,
  });
  await definePosition({
    client, code: pOtherHead, title: 'Other head', jobCode: job, orgUnitCode: otherBranch, changedBy: ACTOR,
  });
  await definePosition({
    client, code: pOtherClerk, title: 'Other clerk', jobCode: job, orgUnitCode: otherBranch, superiorCode: pOtherHead, changedBy: ACTOR,
  });

  for (const [who, positionCode] of [
    [head, pHead],
    [manager, pManager],
    [clerk, pClerk],
    [otherHead, pOtherHead],
    [otherClerk, pOtherClerk],
    [clerk2, pClerk2],
  ] as const) {
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

  // The delegator has to hold something, or there is nothing to delegate and
  // the derived-authority tests would pass for the wrong reason.
  for (const who of [head, manager]) {
    await withTenant(client, async (tx) => {
      await tx.insert(userCapability).values({
        id: `dlg-cap-${who.userId}`,
        client,
        userId: who.userId,
        capabilityCode: 'PLT.LOCK.DISPLAY',
        validFrom: FROM,
        validTo: null,
        reason: 'DIRECT',
        granter: ACTOR,
        createdBy: ACTOR,
      });
    });
  }

  fixtures.pHead = pHead;
  fixtures.pClerk = pClerk;
}, 120_000);

const fixtures: { pHead: string; pClerk: string } = { pHead: '', pClerk: '' };

afterAll(async () => {
  await destroyTenant(tenant.client);
});

async function clearDelegations(): Promise<void> {
  await withTenant(tenant.client, async (tx) => {
    await tx.delete(delegationApproval).where(eq(delegationApproval.client, tenant.client));
    await tx.delete(delegation).where(eq(delegation.client, tenant.client));
  });
}

afterEach(clearDelegations);

/** Create and drive to ACTIVE, failing loudly if the path was not what we said. */
async function makeActive(
  from: { userId: string },
  to: { userId: string },
  over: { initiatorKind?: 'SUPERIOR' | 'SELF'; actor?: string; validTo?: string | null } = {},
) {
  const initiatorKind = over.initiatorKind ?? 'SELF';
  const actorUserId = over.actor ?? from.userId;
  const { delegationId } = await withTenant(tenant.client, (tx) =>
    createDelegation(tx, tenant.client, {
      delegatorUserId: from.userId,
      delegateUserId: to.userId,
      validFrom: TODAY,
      validTo: over.validTo ?? null,
      reason: 'Cover for planned leave.',
      initiatorKind,
      actorUserId,
    }),
  );

  // Accept on whichever side has not already accepted by proposing.
  const row = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, delegationId));
  if (!row.delegatorAcceptedAt) {
    await withTenant(tenant.client, (tx) => respondToDelegation(tx, tenant.client, delegationId, from.userId, true));
  }
  await withTenant(tenant.client, (tx) => respondToDelegation(tx, tenant.client, delegationId, to.userId, true));

  // Approve everything still pending.
  const pending = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, delegationId));
  for (const approval of pending.approvals.filter((a) => a.status === 'PENDING')) {
    await withTenant(tenant.client, (tx) =>
      decideApproval(tx, tenant.client, delegationId, approval.approverUserId!, true),
    );
  }

  return delegationId;
}

/**
 * Drive a delegation to ACTIVE whatever path that takes: accept on behalf of
 * whichever party has not, then approve everyone still owed.
 *
 * The point is that the *rules* about who must act are asserted in the tests
 * above; this exists so the derived-authority tests can stop repeating the
 * walk and talk about authority instead.
 */
async function driveToActive(delegationId: string): Promise<void> {
  const initial = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, delegationId));
  if (!initial.delegatorAcceptedAt) {
    await withTenant(tenant.client, (tx) =>
      respondToDelegation(tx, tenant.client, delegationId, initial.delegatorUserId, true),
    );
  }
  if (!initial.delegateAcceptedAt) {
    await withTenant(tenant.client, (tx) =>
      respondToDelegation(tx, tenant.client, delegationId, initial.delegateUserId, true),
    );
  }
  const row = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, delegationId));
  for (const approval of row.approvals.filter((a) => a.status === 'PENDING')) {
    await withTenant(tenant.client, (tx) =>
      decideApproval(tx, tenant.client, delegationId, approval.approverUserId!, true),
    );
  }
}

describe('delegation — the three creation flows', () => {
  it('flow 1: a superior creates it, and both parties must still accept', async () => {
    const { delegationId } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: manager.userId,
        delegateUserId: clerk.userId,
        validFrom: TODAY,
        reason: 'Cover for planned leave.',
        initiatorKind: 'SUPERIOR',
        actorUserId: head.userId,
      }),
    );

    const row = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, delegationId));

    // A superior proposing is not the delegator accepting: the two are
    // different facts and must not be collapsed.
    expect(row.delegatorAcceptedAt).toBeNull();
    expect(row.delegateAcceptedAt).toBeNull();
    expect(row.status).toBe('PENDING_ACCEPTANCE');
    expect(row.initiatorKind).toBe('SUPERIOR');
  });

  it('flow 2: the delegator proposes, which is their acceptance', async () => {
    const { delegationId } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: manager.userId,
        delegateUserId: clerk.userId,
        validFrom: TODAY,
        reason: 'Cover for planned leave.',
        initiatorKind: 'SELF',
        actorUserId: manager.userId,
      }),
    );

    const row = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, delegationId));
    expect(row.delegatorAcceptedAt).toBeTruthy();
    expect(row.delegateAcceptedAt).toBeNull();
    expect(row.status).toBe('PENDING_ACCEPTANCE');
  });

  it('flow 3: two parties under different superiors collect both approvals', async () => {
    // clerk reports to manager; otherClerk reports to otherHead. Two sides.
    const { delegationId, approvals } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: clerk.userId,
        delegateUserId: otherClerk.userId,
        validFrom: TODAY,
        reason: 'Cross-branch cover.',
        initiatorKind: 'SELF',
        actorUserId: clerk.userId,
      }),
    );

    const sides = [...new Set(approvals.map((a) => a.side))].sort();
    expect(sides).toEqual(['DELEGATEE', 'DELEGATOR']);
    expect(approvals.some((a) => a.approverUserId === manager.userId)).toBe(true);
    expect(approvals.some((a) => a.approverUserId === otherHead.userId)).toBe(true);

    // Accepting does not make it live: one approval is still missing.
    await withTenant(tenant.client, (tx) => respondToDelegation(tx, tenant.client, delegationId, otherClerk.userId, true));
    await withTenant(tenant.client, (tx) => decideApproval(tx, tenant.client, delegationId, manager.userId, true));

    const half = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, delegationId));
    expect(half.status).toBe('PENDING_ACCEPTANCE');
    expect(half.isLive).toBe(false);

    await withTenant(tenant.client, (tx) => decideApproval(tx, tenant.client, delegationId, otherHead.userId, true));

    const done = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, delegationId));
    expect(done.status).toBe('ACTIVE');
    expect(done.isLive).toBe(true);
  });

  it('two parties under one superior need one approval, and it is the superior above', async () => {
    // clerk and clerk2 both report to manager, so both sides of the agreement
    // name the same person. Approving once satisfies both.
    const { delegationId, approvals } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: clerk.userId,
        delegateUserId: clerk2.userId,
        validFrom: TODAY,
        reason: 'Peer cover.',
        initiatorKind: 'SELF',
        actorUserId: clerk.userId,
      }),
    );

    const people = [...new Set(approvals.map((a) => a.approverUserId).filter(Boolean))];
    expect(people).toEqual([manager.userId]);

    // The delegator's own acceptance plus one approval from the shared
    // superior is the whole of it.
    await withTenant(tenant.client, (tx) => respondToDelegation(tx, tenant.client, delegationId, clerk2.userId, true));
    await withTenant(tenant.client, (tx) => decideApproval(tx, tenant.client, delegationId, manager.userId, true));

    const row = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, delegationId));
    expect(row.status).toBe('ACTIVE');
  });

  it('the delegator does not have to approve their own proposal', async () => {
    // manager delegates to clerk. manager is the superior above clerk, so the
    // delegatee side names manager — who is also the person proposing. Asking
    // them to approve their own proposal could only ever say yes.
    const { approvals } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: manager.userId,
        delegateUserId: clerk.userId,
        validFrom: TODAY,
        reason: 'Cover.',
        initiatorKind: 'SELF',
        actorUserId: manager.userId,
      }),
    );

    const owedByDelegator = approvals.filter(
      (a) => a.approverUserId === manager.userId && a.status === 'PENDING',
    );
    expect(owedByDelegator).toEqual([]);

    // The one approval that is still owed is from head, above the delegator.
    const pending = approvals.filter((a) => a.status === 'PENDING');
    expect(pending.map((a) => a.approverUserId)).toEqual([head.userId]);
  });

  it('a superior-created delegation still needs the delegator to approve it', async () => {
    // Flow 1: head creates it. manager has not accepted, so manager's own
    // approval is NOT auto-satisfied — otherwise a superior could bypass the
    // delegator's say entirely.
    const { approvals } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: manager.userId,
        delegateUserId: clerk.userId,
        validFrom: TODAY,
        reason: 'Cover.',
        initiatorKind: 'SUPERIOR',
        actorUserId: head.userId,
      }),
    );

    const owedByDelegator = approvals.filter(
      (a) => a.approverUserId === manager.userId && a.status === 'PENDING',
    );
    expect(owedByDelegator.length).toBe(1);
  });
});

describe('delegation — the apex', () => {
  it('approves itself, because an org unit has no holder to act', async () => {
    // head's line ends in the root org unit, which cannot approve anything.
    const { delegationId, approvals } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: head.userId,
        delegateUserId: manager.userId,
        validFrom: TODAY,
        reason: 'Apex cover.',
        initiatorKind: 'SELF',
        actorUserId: head.userId,
      }),
    );

    const apex = approvals.filter((a) => a.approverOrgUnit !== null);
    expect(apex.length).toBeGreaterThan(0);
    expect(apex.every((a) => a.status === 'APPROVED')).toBe(true);

    // The delegator's own side is the apex and needs nothing. The delegatee's
    // side names head — the delegator — whose proposal already covered it.
    await withTenant(tenant.client, (tx) => respondToDelegation(tx, tenant.client, delegationId, manager.userId, true));
    const row = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, delegationId));
    expect(row.status).toBe('ACTIVE');
  });

  it('is self-revocable — the delegator at the top still keeps revocation', async () => {
    const id = await makeActive(head, manager);
    const status = await withTenant(tenant.client, (tx) =>
      revokeDelegation(tx, tenant.client, id, head.userId, 'Back from leave.'),
    );
    expect(status).toBe('REVOKED');
  });
});

describe('delegation — what grants nothing', () => {
  it('grants nothing until both parties have accepted', async () => {
    const { delegationId } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: manager.userId,
        delegateUserId: clerk.userId,
        validFrom: TODAY,
        reason: 'Cover.',
        initiatorKind: 'SELF',
        actorUserId: manager.userId,
      }),
    );

    const row = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, delegationId));
    expect(row.isLive).toBe(false);

    const before = await withTenant(tenant.client, (tx) => effectiveGrants(tx, tenant.client, clerk.userId));
    const delegated = before.filter((g) => g.source === 'DELEGATION');
    expect(delegated).toEqual([]);
  });

  it('grants nothing until the chain has approved, even with both acceptances in', async () => {
    const { delegationId } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: manager.userId,
        delegateUserId: clerk.userId,
        validFrom: TODAY,
        reason: 'Cover.',
        initiatorKind: 'SUPERIOR',
        actorUserId: head.userId,
      }),
    );
    await withTenant(tenant.client, (tx) => respondToDelegation(tx, tenant.client, delegationId, manager.userId, true));
    await withTenant(tenant.client, (tx) => respondToDelegation(tx, tenant.client, delegationId, clerk.userId, true));

    const row = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, delegationId));
    expect(row.delegatorAcceptedAt).toBeTruthy();
    expect(row.delegateAcceptedAt).toBeTruthy();
    expect(row.status).toBe('PENDING_ACCEPTANCE'); // approval still outstanding
    expect(row.isLive).toBe(false);
  });

  it('a refusal by either party ends it, recording who and why', async () => {
    const { delegationId } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: manager.userId,
        delegateUserId: clerk.userId,
        validFrom: TODAY,
        reason: 'Cover.',
        initiatorKind: 'SELF',
        actorUserId: manager.userId,
      }),
    );

    const status = await withTenant(tenant.client, (tx) =>
      respondToDelegation(tx, tenant.client, delegationId, clerk.userId, false, 'Not while the audit is open.'),
    );
    expect(status).toBe('REFUSED');

    const row = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, delegationId));
    expect(row.refusedBy).toBe(clerk.userId);
    expect(row.refusalReason).toBe('Not while the audit is open.');
    expect(row.isLive).toBe(false);
  });
});

describe('delegation — derived authority', () => {
  it('gives the delegate what the delegator holds, and no more', async () => {
    const id = await makeActive(head, clerk);

    const delegatorGrants = await withTenant(tenant.client, (tx) => effectiveGrants(tx, tenant.client, head.userId));
    const delegateGrants = await withTenant(tenant.client, (tx) => effectiveGrants(tx, tenant.client, clerk.userId));

    const derived = delegateGrants.filter((g) => g.source === 'DELEGATION');
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((g) => g.delegationId === id)).toBe(true);
    expect(derived.every((g) => g.granter === head.userId)).toBe(true);

    // Every delegated capability is one the delegator actually holds.
    const held = new Set(delegatorGrants.map((g) => g.pattern));
    for (const grant of derived) expect(held.has(grant.pattern)).toBe(true);
  });

  it('revocation removes the derived authority immediately, with no sweep', async () => {
    const id = await makeActive(head, clerk);
    const during = await withTenant(tenant.client, (tx) => effectiveGrants(tx, tenant.client, clerk.userId));
    expect(during.some((g) => g.source === 'DELEGATION')).toBe(true);

    await withTenant(tenant.client, (tx) => revokeDelegation(tx, tenant.client, id, head.userId, 'Returned.'));

    const after = await withTenant(tenant.client, (tx) => effectiveGrants(tx, tenant.client, clerk.userId));
    expect(after.filter((g) => g.source === 'DELEGATION')).toEqual([]);
  });

  it('ended delegations grant nothing, whatever their recorded status', async () => {
    for (const end of ['revoke', 'close'] as const) {
      await clearDelegations();
      const id = await makeActive(head, clerk);

      if (end === 'revoke') {
        await withTenant(tenant.client, (tx) => revokeDelegation(tx, tenant.client, id, head.userId, 'Done.'));
      } else {
        await withTenant(tenant.client, (tx) => closeDelegation(tx, tenant.client, id, clerk.userId, 'Finished.'));
      }

      const grants = await withTenant(tenant.client, (tx) => effectiveGrants(tx, tenant.client, clerk.userId));
      expect(grants.filter((g) => g.source === 'DELEGATION')).toEqual([]);
    }
  });

  it('a delegation outside its dates grants nothing', async () => {
    const { delegationId } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: manager.userId,
        delegateUserId: clerk.userId,
        validFrom: '2099-01-01',
        reason: 'Not yet.',
        initiatorKind: 'SELF',
        actorUserId: manager.userId,
      }),
    );
    await withTenant(tenant.client, (tx) => respondToDelegation(tx, tenant.client, delegationId, clerk.userId, true));
    await withTenant(tenant.client, async (itrx) => {
      const row = await loadDelegation(itrx, tenant.client, delegationId);
      for (const a of row.approvals.filter((x) => x.status === 'PENDING')) {
        await decideApproval(itrx, tenant.client, delegationId, a.approverUserId!, true);
      }
    });

    const grants = await withTenant(tenant.client, (tx) => effectiveGrants(tx, tenant.client, clerk.userId));
    expect(grants.filter((g) => g.delegationId === delegationId)).toEqual([]);
  });

  it('carries the delegation id, so an audit can answer "under what authority"', async () => {
    const id = await makeActive(head, clerk);
    const grants = await withTenant(tenant.client, (tx) => effectiveGrants(tx, tenant.client, clerk.userId));
    const derived = grants.filter((g) => g.source === 'DELEGATION');
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((g) => g.delegationId === id)).toBe(true);
    expect(derived.every((g) => g.granter === head.userId)).toBe(true);
  });

  it('restricts an unrestricted grant to the places the delegation names', async () => {
    const { delegationId } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: head.userId,
        delegateUserId: clerk.userId,
        validFrom: TODAY,
        reason: 'Plant 1000 cover only.',
        initiatorKind: 'SELF',
        actorUserId: head.userId,
        scope: { plant: ['1000'] },
      }),
    );
    // head is above everyone, but the delegatee's own superior still has to
    // authorise the delegatee receiving it. That is manager.
    await driveToActive(delegationId);

    const grants = await withTenant(tenant.client, (tx) => effectiveGrants(tx, tenant.client, clerk.userId));
    const derived = grants.filter((g) => g.delegationId === delegationId);

    expect(derived.length).toBeGreaterThan(0);
    // The delegator's grant names no plant; the delegated one names exactly one.
    expect(derived.every((g) => g.scope.plant?.length === 1)).toBe(true);

    // Which means it answers for that plant and not for another.
    const capability = derived[0]!.pattern;
    expect(canWith(derived, capability, { plant: '1000' })).toBe(true);
    expect(canWith(derived, capability, { plant: '2000' })).toBe(false);
  });

  it('yields nothing where the delegation asks for a place the grant cannot reach', async () => {
    // The delegator's grant is unrestricted, so narrowing cannot empty it —
    // but a grant already restricted elsewhere can. Give the delegator a
    // plant-1000-only grant and delegate plant 2000.
    await withTenant(tenant.client, async (tx) => {
      await tx.insert(userCapability).values({
        id: 'dlg-scoped-grant',
        client: tenant.client,
        userId: head.userId,
        capabilityCode: 'PLT.LOCK.DELETE',
        validFrom: FROM,
        validTo: null,
        reason: 'DIRECT',
        granter: ACTOR,
        createdBy: ACTOR,
      });
      // Restricted to plant 1000. Without this the grant is unrestricted and
      // narrowing to 2000 would succeed, which is the opposite of the point.
      await tx.insert(userCapabilityScope).values({
        client: tenant.client,
        grantId: 'dlg-scoped-grant',
        scopeType: 'PLANT',
        scopeValue: '1000',
      });
    });

    const { delegationId } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: head.userId,
        delegateUserId: clerk.userId,
        validFrom: TODAY,
        reason: 'Wrong plant.',
        initiatorKind: 'SELF',
        actorUserId: head.userId,
        scope: { plant: ['2000'] },
      }),
    );
    await driveToActive(delegationId);

    const grants = await withTenant(tenant.client, (tx) => effectiveGrants(tx, tenant.client, clerk.userId));
    const wrong = grants.filter((g) => g.delegationId === delegationId && g.pattern === 'PLT.LOCK.DELETE');
    // An empty intersection is not a wider grant — it is no grant at all.
    expect(wrong).toEqual([]);

    await withTenant(tenant.client, async (tx) => {
      await tx.delete(userCapabilityScope).where(eq(userCapabilityScope.grantId, 'dlg-scoped-grant'));
      await tx.delete(userCapability).where(eq(userCapability.id, 'dlg-scoped-grant'));
    });
  });
});

describe('delegation — who may do what', () => {
  it('only the delegator may revoke', async () => {
    const id = await makeActive(manager, clerk);
    await expect(
      withTenant(tenant.client, (tx) => revokeDelegation(tx, tenant.client, id, clerk.userId, 'I am done.')),
    ).rejects.toThrow(DelegationError);

    // Still live: a failed attempt must not half-end it.
    const row = await withTenant(tenant.client, (tx) => loadDelegation(tx, tenant.client, id));
    expect(row.isLive).toBe(true);
  });

  it('a superior may not revoke either — revocation is the delegator’s alone', async () => {
    const id = await makeActive(manager, clerk);
    await expect(
      withTenant(tenant.client, (tx) => revokeDelegation(tx, tenant.client, id, head.userId, 'Cancelled.')),
    ).rejects.toThrow(DelegationError);
  });

  it('either party may close it, so an open-ended delegation is never stuck', async () => {
    const id = await makeActive(manager, clerk, { validTo: null });

    await withTenant(tenant.client, (tx) => respondToDelegation(tx, tenant.client, id, clerk.userId, true)).catch(
      () => undefined,
    );

    const status = await withTenant(tenant.client, (tx) =>
      closeDelegation(tx, tenant.client, id, clerk.userId, 'Cover no longer needed.'),
    );
    expect(status).toBe('CLOSED');
  });

  it('a stranger may not close, accept or approve', async () => {
    const { delegationId } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: manager.userId,
        delegateUserId: clerk.userId,
        validFrom: TODAY,
        reason: 'Cover.',
        initiatorKind: 'SELF',
        actorUserId: manager.userId,
      }),
    );

    await expect(
      withTenant(tenant.client, (tx) => respondToDelegation(tx, tenant.client, delegationId, outsider.userId, true)),
    ).rejects.toThrow(DelegationError);

    await expect(
      withTenant(tenant.client, (tx) => decideApproval(tx, tenant.client, delegationId, outsider.userId, true)),
    ).rejects.toThrow(DelegationError);

    await expect(
      withTenant(tenant.client, (tx) => closeDelegation(tx, tenant.client, delegationId, outsider.userId, 'Not mine.')),
    ).rejects.toThrow(DelegationError);
  });

  it('refuses to create a delegation to oneself', async () => {
    await expect(
      withTenant(tenant.client, (tx) =>
        createDelegation(tx, tenant.client, {
          delegatorUserId: manager.userId,
          delegateUserId: manager.userId,
          validFrom: TODAY,
          reason: 'Nonsense.',
          initiatorKind: 'SELF',
          actorUserId: manager.userId,
        }),
      ),
    ).rejects.toThrow(DelegationError);
  });

  it('refuses a delegation with no reason', async () => {
    await expect(
      withTenant(tenant.client, (tx) =>
        createDelegation(tx, tenant.client, {
          delegatorUserId: manager.userId,
          delegateUserId: clerk.userId,
          validFrom: TODAY,
          reason: '  ',
          initiatorKind: 'SELF',
          actorUserId: manager.userId,
        }),
      ),
    ).rejects.toThrow(DelegationError);
  });

  it('refuses when the chain has a hole, rather than authorising nobody', async () => {
    // outsider holds no position at all.
    await expect(
      withTenant(tenant.client, (tx) =>
        createDelegation(tx, tenant.client, {
          delegatorUserId: outsider.userId,
          delegateUserId: clerk.userId,
          validFrom: TODAY,
          reason: 'Cover.',
          initiatorKind: 'SELF',
          actorUserId: outsider.userId,
        }),
      ),
    ).rejects.toThrow(DelegationError);
  });
});

describe('the approval rule', () => {
  it('a side with no approver needs nothing — that is the apex', () => {
    expect(approvalsSatisfied([]).satisfied).toBe(true);
  });

  it('one approval satisfies a side with two candidates', () => {
    const rows = [
      { side: 'DELEGATOR', status: 'PENDING' },
      { side: 'DELEGATOR', status: 'APPROVED' },
    ];
    expect(approvalsSatisfied(rows).satisfied).toBe(true);
  });

  it('a refusal on a side cannot be outvoted by an approval on it', () => {
    const rows = [
      { side: 'DELEGATOR', status: 'APPROVED' },
      { side: 'DELEGATOR', status: 'REFUSED' },
    ];
    const result = approvalsSatisfied(rows);
    expect(result.satisfied).toBe(false);
    expect(result.outstanding).toEqual(['DELEGATOR']);
  });

  it('both sides must be satisfied', () => {
    expect(approvalsSatisfied([{ side: 'DELEGATOR', status: 'APPROVED' }]).satisfied).toBe(true);
    expect(
      approvalsSatisfied([
        { side: 'DELEGATOR', status: 'APPROVED' },
        { side: 'DELEGATEE', status: 'PENDING' },
      ]).satisfied,
    ).toBe(false);
  });
});

describe('the scope rule', () => {
  it('permits when the authoriser’s scope covers both ends', () => {
    const r = scopeCovers({ plant: ['1000', '2000'] }, { plant: ['1000'] }, { plant: ['2000'] });
    expect(r.ok).toBe(true);
  });

  it('refuses when the authoriser cannot reach the target', () => {
    const r = scopeCovers({ plant: ['1000'] }, { plant: ['1000'] }, { plant: ['2000'] });
    expect(r.ok).toBe(false);
    expect(r.uncovered).toEqual(['plant=2000']);
  });

  it('a level the authoriser does not name is one they do not restrict', () => {
    expect(scopeCovers({}, { plant: ['1000'] }, { plant: ['9999'] }).ok).toBe(true);
  });

  it('the delegate’s own scope is not the constraint', () => {
    // The point of delegation is that a narrow user is temporarily given wider
    // reach. Only the authoriser's scope is examined here.
    expect(scopeCovers({ companyCode: ['1000'] }, {}, { plant: ['2000'] }).ok).toBe(true);
  });
});

describe('status', () => {
  it('EXPIRED is derived from the end date, never written', () => {
    expect(effectiveStatus({ status: 'ACTIVE', validFrom: '2020-01-01', validTo: '2020-01-31' }, '2020-02-01')).toBe(
      'EXPIRED',
    );
    expect(effectiveStatus({ status: 'ACTIVE', validFrom: '2020-01-01', validTo: '2020-01-31' }, '2020-01-31')).toBe(
      'ACTIVE',
    );
    expect(effectiveStatus({ status: 'ACTIVE', validFrom: '2020-01-01', validTo: null }, '2099-01-01')).toBe('ACTIVE');
  });

  it('a terminal status stays terminal whatever the date', () => {
    expect(effectiveStatus({ status: 'REVOKED', validFrom: '2020-01-01', validTo: null }, '2099-01-01')).toBe('REVOKED');
  });
});

describe('the authority chart panels', () => {
  it('fills the three delegation panels instead of leaving them empty', async () => {
    // Phase 3 declared these empty and typed. Phase 5 fills them without
    // reshaping them, which is why the assertion is on the same field names.
    const id = await makeActive(manager, clerk);

    const card = await withTenant(tenant.client, (tx) =>
      authorityChart(tx, tenant.client, head.userId, clerk.userId),
    );

    expect(card.selected?.userId).toBe(clerk.userId);
    // Delegated *to* them: clerk is the delegate.
    expect(card.selected?.delegatedToThem.map((l) => l.delegationId)).toEqual([id]);
    expect(card.selected?.delegatedToThem[0]?.status).toBe('ACTIVE');
    expect(card.selected?.delegatedToThem[0]?.granter).toBe('Test manager');
    // Nothing delegated away, and nothing waiting.
    expect(card.selected?.delegatedAway).toEqual([]);
    expect(card.selected?.pendingAcceptance).toEqual([]);
  });

  it('shows a delegation waiting on the delegate as pending acceptance', async () => {
    const { delegationId } = await withTenant(tenant.client, (tx) =>
      createDelegation(tx, tenant.client, {
        delegatorUserId: manager.userId,
        delegateUserId: clerk.userId,
        validFrom: TODAY,
        reason: 'Awaiting the clerk.',
        initiatorKind: 'SELF',
        actorUserId: manager.userId,
      }),
    );

    const card = await withTenant(tenant.client, (tx) =>
      authorityChart(tx, tenant.client, head.userId, clerk.userId),
    );
    expect(card.selected?.pendingAcceptance.map((l) => l.delegationId)).toEqual([delegationId]);
    expect(card.selected?.pendingAcceptance[0]?.status).toBe('PENDING_ACCEPTANCE');
  });

  it('names the counterparty, not the subject, in every panel', async () => {
    await makeActive(manager, clerk);
    const card = await withTenant(tenant.client, (tx) =>
      authorityChart(tx, tenant.client, head.userId, clerk.userId),
    );
    // Reading your own card, the counterparty is the other person.
    expect(card.selected?.delegatedToThem[0]?.counterpartyName).toBe('Test manager');

    const managers = await withTenant(tenant.client, (tx) =>
      authorityChart(tx, tenant.client, head.userId, manager.userId),
    );
    expect(managers.selected?.delegatedAway[0]?.counterpartyName).toBe('Test clerk');
  });
});
