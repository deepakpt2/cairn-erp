/**
 * Attention — what waits on you.
 *
 * The panel is a query, so what is worth proving is not that rows can be read
 * but the four rules that make the panel honest:
 *
 *   1. a source you cannot act on is skipped entirely, never shown disabled
 *   2. organisation narrows it: two managers on two plants see different work
 *   3. a row that names no place is shown only to somebody unrestricted
 *   4. delegated work appears and disappears with the delegation
 *
 * and the one that keeps it truthful over time: nothing is stored, so there is
 * no stale row to sweep and no cleanup path to get wrong.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import type { AuthorityGrant } from '../src/platform/auth/authority';
import { appUser, userCapability, userCapabilityScope } from '../src/platform/tables/security';
import { employee } from '../src/modules/people/schema';
import { documentRelease, purchaseRequisitionItem } from '../src/modules/purchasing/schema';
import { RELEASE_CAPABILITIES } from '../src/modules/purchasing/release';
import { t } from '../src/platform/i18n';
import { ATTENTION_SOURCES } from '../src/platform/attention/sources';
import { attentionFor, mayAct, ATTENTION_VISIBLE } from '../src/platform/attention/panel';
import { ASSIGNMENT_CAPABILITY, assignPosition as assignPositionService } from '../src/modules/people/assignment';
import {
  ORG_UNIT_CAPABILITY,
  POSITION_CAPABILITY,
  defineJob as defineJobService,
  defineOrgUnit as defineOrgUnitService,
  definePosition as definePositionService,
} from '../src/modules/people/org-structure';
import {
  createDelegation, respondToDelegation, revokeDelegation,
} from '../src/modules/people/delegation';
import { createTenant, destroyTenant, sql, type TestTenant } from './helpers';
import { sql as raw } from 'drizzle-orm';

const ACTOR = 'ATTENTION_TEST';
const ORG_AUTH = [ORG_UNIT_CAPABILITY] as const;
const POS_AUTH = [POSITION_CAPABILITY] as const;
const ASN_AUTH = [ASSIGNMENT_CAPABILITY] as const;
const defineOrgUnit = (i: Parameters<typeof defineOrgUnitService>[0]) => defineOrgUnitService(i, ORG_AUTH);
const defineJob = (i: Parameters<typeof defineJobService>[0]) => defineJobService(i, POS_AUTH);
const definePosition = (i: Parameters<typeof definePositionService>[0]) => definePositionService(i, POS_AUTH);
const assignPosition = (i: Parameters<typeof assignPositionService>[0]) => assignPositionService(i, ASN_AUTH);

const PR_RELEASE = RELEASE_CAPABILITIES.PURCHASE_REQUISITION!;
const AREA = 'A000';
const CC = 'CC100';
const TODAY = new Date().toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

let tenant: TestTenant;
let counter = 0;

/** Plant 1000 holds six requisitions; plant 2000 holds one. */
const IN_1000 = ['1000000001', '1000000002', '1000000003', '1000000004', '1000000005', '1000000006'];
const IN_2000 = ['2000000001'];

let manager1000: { userId: string; personnelNumber: string };
let director: { userId: string; personnelNumber: string };
let clerk: { userId: string; personnelNumber: string };

async function person(name: string): Promise<{ userId: string; personnelNumber: string }> {
  const client = tenant.client;
  const userId = `att-${name}-${++counter}`;
  const personnelNumber = `P${String(9300000 + counter)}`;
  await withTenant(client, async (tx) => {
    await tx.insert(appUser).values({
      id: userId,
      client,
      username: `att.${name}.${counter}`,
      fullName: `Test ${name}`,
      passwordHash: 'scrypt:not-a-real-hash:not-a-real-hash',
      isActive: true,
    });
    await tx.insert(employee).values({
      client,
      personnelNumber: `P${String(9300000 + counter)}`,
      fullName: `Test ${name}`,
      appUserId: userId,
      isActive: true,
      createdBy: ACTOR,
    });
  });
  return { userId, personnelNumber };
}

/** A direct capability grant, optionally narrowed to one organisational value. */
async function grant(userId: string, capability: string, scopeType?: string, scopeValue?: string) {
  await withTenant(tenant.client, async (tx) => {
    const id = `att-grant-${++counter}`;
    await tx.insert(userCapability).values({
      id,
      client: tenant.client,
      userId,
      capabilityCode: capability,
      validFrom: '2020-01-01',
      validTo: null,
      granter: ACTOR,
      reason: 'DIRECT',
      createdBy: ACTOR,
    });
    if (scopeType && scopeValue) {
      await tx.insert(userCapabilityScope).values({
        client: tenant.client,
        grantId: id,
        scopeType,
        scopeValue,
      });
    }
  });
}

beforeAll(async () => {
  tenant = await createTenant('attention');
  const client = tenant.client;

  await withTenant(client, async (tx) => {
    await tx.execute(raw`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${client}, ${AREA}, ${CC}, '2020-01-01', '9999-12-31', 'Attention cost centre', 'PRODUCTION', ${tenant.companyCode}, ${ACTOR})
      on conflict do nothing`);
    await tx.execute(raw`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, '1000', 'Plant 1000', ${tenant.companyCode}, 'KW', ${ACTOR}),
             (${client}, '2000', 'Plant 2000', ${tenant.companyCode}, 'KW', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(raw`
      insert into purchasing_group (client, purchasing_group, name, created_by)
      values (${client}, '001', 'Group 001', ${ACTOR}) on conflict do nothing`);
    await tx.execute(raw`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      values (${client}, 'ATT-MAT', 'Attention material', 'RAW', 'EA', ${ACTOR})
      on conflict do nothing`);
    // The release chain a document_release row points into: a group, two codes,
    // and a strategy of two steps — which is what lets a row say "step 1 of 2".
    await tx.execute(raw`
      insert into release_group (client, group_code, document_category, description, created_by)
      values (${client}, 'ATT', 'PURCHASE_REQUISITION', 'Attention group', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(raw`
      insert into release_code (client, group_code, code, description, created_by)
      values (${client}, 'ATT', 'A1', 'First approval', ${ACTOR}),
             (${client}, 'ATT', 'A2', 'Second approval', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(raw`
      insert into class_type (client, class_type, description, object_category, created_by)
      values (${client}, 'PURCHASE_REQUISITION', 'Requisition release', 'PURCHASING', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(raw`
      insert into classification_class (client, class_type, class_name, description, lifecycle_status, created_by)
      values (${client}, 'PURCHASE_REQUISITION', 'PR_RELEASE', 'Requisition release', 'ACTIVE', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(raw`
      insert into release_strategy (client, group_code, strategy_code, description, class_type, class_name, priority, lifecycle_status, created_by)
      values (${client}, 'ATT', 'TWO', 'Two approvals', 'PURCHASE_REQUISITION', 'PR_RELEASE', 100, 'ACTIVE', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(raw`
      insert into release_strategy_step (client, group_code, strategy_code, step, release_code, created_by)
      values (${client}, 'ATT', 'TWO', 1, 'A1', ${ACTOR}),
             (${client}, 'ATT', 'TWO', 2, 'A2', ${ACTOR})
      on conflict do nothing`);
  });

  manager1000 = await person('manager');
  director = await person('director');
  clerk = await person('clerk');

  // The organisational line: a director at the apex, a manager beneath. The
  // delegation below runs down it, and the apex is what self-approves.
  const root = `UA${counter}`;
  const branch = `UB${counter}`;
  await defineOrgUnit({ client, code: root, name: 'Root', changedBy: ACTOR });
  await defineOrgUnit({ client, code: branch, name: 'Branch', parentCode: root, changedBy: ACTOR });
  const job = `JA${counter}`;
  await defineJob({ client, code: job, name: 'Job', changedBy: ACTOR });
  const pDirector = `PA${counter}`;
  const pManager = `PB${counter}`;
  const pClerk = `PC${counter}`;
  await definePosition({ client, code: pDirector, title: 'Director', jobCode: job, orgUnitCode: root, changedBy: ACTOR });
  await definePosition({ client, code: pManager, title: 'Manager', jobCode: job, orgUnitCode: branch, superiorCode: pDirector, changedBy: ACTOR });
  await definePosition({ client, code: pClerk, title: 'Clerk', jobCode: job, orgUnitCode: branch, superiorCode: pManager, changedBy: ACTOR });
  await assignPosition({
    client, personnelNumber: director.personnelNumber, positionCode: pDirector,
    controllingArea: AREA, costCenter: CC, validFrom: '2020-01-01', changedBy: ACTOR,
  });
  await assignPosition({
    client, personnelNumber: clerk.personnelNumber, positionCode: pClerk,
    controllingArea: AREA, costCenter: CC, validFrom: '2020-01-01', changedBy: ACTOR,
  });

  // Requisitions awaiting release, oldest first. Six in plant 1000, one in 2000.
  await withTenant(client, async (tx) => {
    let day = 0;
    for (const [numbers, plant] of [[IN_1000, '1000'], [IN_2000, '2000']] as const) {
      for (const number of numbers) {
        await tx.insert(purchaseRequisitionItem).values({
          client,
          requisitionNumber: number,
          itemNumber: 1,
          shortText: 'Attention item',
          quantity: '1',
          unit: 'EA',
          requisitionDate: '2020-01-01',
          deliveryDate: '2020-02-01',
          plant,
          purchasingGroup: '001',
          createdBy: ACTOR,
        });
        await tx.insert(documentRelease).values({
          client,
          documentCategory: 'PURCHASE_REQUISITION',
          documentNumber: number,
          groupCode: 'ATT',
          strategyCode: 'TWO',
          currentStep: 0,
          status: 'PENDING',
          createdBy: ACTOR,
          createdAt: new Date(Date.UTC(2026, 0, 1) + day * 86_400_000),
        });
        day += 1;
      }
    }
  });

  await grant(director.userId, PR_RELEASE);
  await grant(manager1000.userId, PR_RELEASE, 'PLANT', '1000');
  // The clerk is given nothing at all.
});

afterAll(async () => {
  await destroyTenant(tenant.client);
});

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

describe('the attention registry', () => {
  it('names every source by the capability that lets you act on it', () => {
    expect(ATTENTION_SOURCES.length).toBeGreaterThan(0);
    for (const source of ATTENTION_SOURCES) {
      expect(source.code).toMatch(/^[A-Z][A-Z0-9._]+$/);
      expect(source.label.length).toBeGreaterThan(0);
    }
  });

  it('resolves every source heading through the locale, never a hardcoded word', () => {
    // CAIRN.md R-19 / D-008: no screen may carry a hardcoded label. The registry
    // holds keys, so a missing catalogue entry fails here rather than shipping
    // a raw key to the screen.
    for (const source of ATTENTION_SOURCES) {
      const resolved = t(source.label);
      expect(resolved).not.toBe(source.label);
      expect(resolved.length).toBeGreaterThan(0);
    }
  });

  it('covers release, warehouse, sales and credit', () => {
    const codes = ATTENTION_SOURCES.map((s) => s.code);
    // The four purchasing release queues.
    expect(codes).toContain('PROC.PR.RELEASE');
    expect(codes).toContain('PROC.PO.RELEASE');
    expect(codes).toContain('PROC.CONTRACT.RELEASE');
    expect(codes).toContain('PROC.SCHEDAGREE.RELEASE');
    // The warehouse keeper's two queues, and what credit is holding up.
    expect(codes).toContain('SALES.DELIVERY.PICK');
    expect(codes).toContain('SALES.GI.POST');
    // The two due lists, invoice lists, incompletion, held credit memos.
    expect(codes).toContain('SALES.DELIVERY.CREATE');
    expect(codes).toContain('SALES.BILLING.CREATE');
    expect(codes).toContain('SALES.INVOICE_LIST.CREATE');
    expect(codes).toContain('SALES.INCOMPLETION.PROCESS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mayAct — the narrowing rules, without a database
// ─────────────────────────────────────────────────────────────────────────────

describe('mayAct', () => {
  const open = (pattern: string, scope: AuthorityGrant['scope'] = {}): AuthorityGrant => ({
    source: 'DIRECT', pattern, scope, validFrom: '2020-01-01', validTo: null,
  });
  const none = new Map();

  it('lets an unrestricted grant see work that names a place', () => {
    expect(mayAct([open('PROC.PR.RELEASE')], none, 'PROC.PR.RELEASE', [{ plant: '1000' }])).toBe(true);
  });

  it('refuses a plant-1000 grant work in plant 2000', () => {
    const grants = [open('PROC.PR.RELEASE', { plant: ['1000'] })];
    expect(mayAct(grants, none, 'PROC.PR.RELEASE', [{ plant: '1000' }])).toBe(true);
    expect(mayAct(grants, none, 'PROC.PR.RELEASE', [{ plant: '2000' }])).toBe(false);
  });

  it('shows work that names nowhere only to somebody unrestricted', () => {
    // This is the multi-plant case. Asking "do you hold this at all" would let
    // every scoped manager in, which is exactly the leak to avoid.
    expect(mayAct([open('PROC.PR.RELEASE')], none, 'PROC.PR.RELEASE', [])).toBe(true);
    expect(mayAct([open('PROC.PR.RELEASE')], none, 'PROC.PR.RELEASE', undefined)).toBe(true);
    const scoped = [open('PROC.PR.RELEASE', { plant: ['1000'] })];
    expect(mayAct(scoped, none, 'PROC.PR.RELEASE', [])).toBe(false);
    expect(mayAct(scoped, none, 'PROC.PR.RELEASE', undefined)).toBe(false);
  });

  it('keeps a row that spans plants if you can act in any of them', () => {
    // A requisition whose items name two plants is real work for either manager.
    const orgs = [{ plant: '1000' }, { plant: '2000' }];
    expect(mayAct([open('P', { plant: ['1000'] })], none, 'P', orgs)).toBe(true);
    expect(mayAct([open('P', { plant: ['2000'] })], none, 'P', orgs)).toBe(true);
    expect(mayAct([open('P', { plant: ['3000'] })], none, 'P', orgs)).toBe(false);
  });

  it('narrows further under a user restriction', () => {
    const grants = [open('P')];
    const restricted = new Map([['plant' as const, ['2000']]]);
    expect(mayAct(grants, restricted, 'P', [{ plant: '1000' }])).toBe(false);
    expect(mayAct(grants, restricted, 'P', [{ plant: '2000' }])).toBe(true);
  });

  it('answers no when the capability is not held at all', () => {
    expect(mayAct([open('OTHER')], none, 'PROC.PR.RELEASE', [{ plant: '1000' }])).toBe(false);
    expect(mayAct([], none, 'PROC.PR.RELEASE', [{ plant: '1000' }])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// attentionFor — against the database
// ─────────────────────────────────────────────────────────────────────────────

describe('attentionFor', () => {
  it('shows a purchase manager only his own plant, and a director everyone’s', async () => {
    const mine = await attentionFor({ client: tenant.client, userId: manager1000.userId }, TODAY);
    const theirs = await attentionFor({ client: tenant.client, userId: director.userId }, TODAY);

    // One group each: the release queue.
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);

    expect(mine[0]!.source).toBe(PR_RELEASE);
    expect(mine[0]!.total).toBe(IN_1000.length);

    // The director's grant names nowhere, so nothing is withheld from him.
    expect(theirs[0]!.total).toBe(IN_1000.length + IN_2000.length);
  });

  it('skips a source entirely when the person cannot act on it', async () => {
    const groups = await attentionFor({ client: tenant.client, userId: clerk.userId }, TODAY);
    // Not a group with nothing in it, and not a disabled one: no group at all.
    expect(groups).toEqual([]);
  });

  it('caps what it shows and says how much more there is', async () => {
    const [group] = await attentionFor({ client: tenant.client, userId: director.userId }, TODAY);
    expect(group!.rows).toHaveLength(ATTENTION_VISIBLE);
    expect(group!.total).toBe(7);
    expect(group!.more).toBe(7 - ATTENTION_VISIBLE);
  });

  it('puts the oldest first, and links straight to the document', async () => {
    const [group] = await attentionFor({ client: tenant.client, userId: manager1000.userId }, TODAY);
    const dates = group!.rows.map((row) => row.waitingSince);
    expect([...dates].sort()).toEqual(dates);

    expect(group!.rows[0]!.title).toContain(IN_1000[0]!);
    expect(group!.rows[0]!.href).toBe(`/purchasing/requisitions?req=${IN_1000[0]!}`);
    // What is still needed, not merely that something is waiting.
    expect(group!.rows[0]!.detail).toBe('Awaiting release — step 1 of 2');
  });

  it('renders nothing at all when nothing is waiting', async () => {
    // Drop every release row; the panel must not invent a heading for emptiness.
    const removed = await withTenant(tenant.client, async (tx) =>
      tx.delete(documentRelease).where(sql`true`).returning());

    const groups = await attentionFor({ client: tenant.client, userId: director.userId }, TODAY);
    expect(groups).toEqual([]);

    // And put them back, so the tests that follow see what they expect.
    await withTenant(tenant.client, async (tx) => {
      for (const row of removed) await tx.insert(documentRelease).values(row);
    });
    const back = await attentionFor({ client: tenant.client, userId: director.userId }, TODAY);
    expect(back[0]!.total).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delegation — work appears and disappears with the delegation
// ─────────────────────────────────────────────────────────────────────────────

describe('delegated attention', () => {
  it('appears when the delegation stands and vanishes when it is revoked', async () => {
    const before = await attentionFor({ client: tenant.client, userId: clerk.userId }, TODAY);
    expect(before).toEqual([]);

    const { delegationId } = await withTenant(tenant.client, (tx) => createDelegation(tx, tenant.client, {
      delegatorUserId: director.userId,
      delegateUserId: clerk.userId,
      validFrom: TODAY,
      validTo: null,
      reason: 'Annual leave cover',
      initiatorKind: 'SELF',
      actorUserId: director.userId,
    }));

    // The delegate has to accept; the apex has already approved itself.
    await withTenant(tenant.client, (tx) =>
      respondToDelegation(tx, tenant.client, delegationId, clerk.userId, true));

    const during = await attentionFor({ client: tenant.client, userId: clerk.userId }, TODAY);
    expect(during).toHaveLength(1);
    // He stands in the director's shoes entirely: the grant names nowhere, so
    // he sees both plants.
    expect(during[0]!.total).toBe(IN_1000.length + IN_2000.length);

    // Revocation is the delegator's alone, and it takes the work with it —
    // with no sweep job, because nothing was ever copied.
    await withTenant(tenant.client, (tx) =>
      revokeDelegation(tx, tenant.client, delegationId, director.userId, 'Back from leave'));

    const after = await attentionFor({ client: tenant.client, userId: clerk.userId }, TODAY);
    expect(after).toEqual([]);
  });

  it('says nothing about a delegation that has not started yet', async () => {
    const { delegationId } = await withTenant(tenant.client, (tx) => createDelegation(tx, tenant.client, {
      delegatorUserId: director.userId,
      delegateUserId: clerk.userId,
      validFrom: TOMORROW,
      validTo: null,
      reason: 'Cover from tomorrow',
      initiatorKind: 'SELF',
      actorUserId: director.userId,
    }));
    await withTenant(tenant.client, (tx) =>
      respondToDelegation(tx, tenant.client, delegationId, clerk.userId, true));

    // Accepted, but the day is not here: authority is read as of today, and
    // today he holds nothing.
    const today = await attentionFor({ client: tenant.client, userId: clerk.userId }, TODAY);
    expect(today).toEqual([]);

    const tomorrow = await attentionFor({ client: tenant.client, userId: clerk.userId }, TOMORROW);
    expect(tomorrow).toHaveLength(1);

    await withTenant(tenant.client, (tx) =>
      revokeDelegation(tx, tenant.client, delegationId, director.userId, 'Not needed'));
  });
});
