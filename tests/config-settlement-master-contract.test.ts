/**
 * The settlement masters: an allocation structure, its assignments, the profile, and the order type
 * that reads them.
 *
 * These rows belong to a client and to an order type, so they are stored here rather than as a
 * side effect of one order's rule. The document type and the three distribution methods are stated
 * on the profile by whoever maintains it, and a change that would leave an order unable to settle is
 * refused instead of stored for a run to discover.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { closeDb, createTenant, defineTestRanges, destroyTenant, sql, withTenant } from './helpers';
import { ensureSettlementMasters } from './settlement-masters';
import { defineRange } from '../src/platform/numbering';
import { postJournalEntry } from '../src/platform/posting';
import { createInternalOrder } from '../src/modules/foundation/internal-order';
import { settleOrder } from '../src/modules/foundation/order-settlement';
import { saveOrderSettlementConfiguration } from '../src/modules/foundation/settlement-configuration';
import {
  assignOrderTypeSettlementProfile,
  getAllocationStructure,
  getSettlementProfile,
  listOrderTypeSettlementProfiles,
  listSettlementProfileDocumentTypes,
  removeAllocationStructureAssignment,
  removeOrderTypeSettlementProfile,
  saveAllocationStructure,
  saveAllocationStructureAssignment,
  saveSettlementProfile,
  structureDependents,
} from '../src/modules/foundation/settlement-configuration-masters';

const ACTOR = 'SETCFG_TEST';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

interface Place {
  client: string;
  area: string;
  company: string;
  currency: string;
}

async function standing(seed: string): Promise<Place> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  const place: Place = { client: tenant.client, area: '', company: '', currency: '' };
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, {
      client: tenant.client, objectCode: 'INTORDER', subObject: '*', prefix: 'IO', numberLength: 8, createdBy: ACTOR,
    });
    await tx.execute(sql`
      insert into internal_order_type (
        client, order_type, description, number_range_sub_object, statistical_default, created_by
      ) values (${tenant.client}, 'IO01', 'Internal order', '*', false, ${ACTOR}) on conflict do nothing
    `);
    const [assignment] = await tx.execute(sql`
      select a.controlling_area as area, a.company_code as company, c.currency
        from controlling_area_company a
        join controlling_area c on c.client = a.client and c.controlling_area = a.controlling_area
       where a.client = ${tenant.client}
       limit 1
    `) as unknown as Array<{ area: string; company: string; currency: string }>;
    place.area = assignment.area;
    place.company = assignment.company;
    place.currency = assignment.currency.trim();
  });
  await defineTestRanges({ client: place.client, companyCode: place.company, currency: place.currency }, { fiscalYear: 2026 });
  await withTenant(place.client, (tx) => tx.execute(sql`
    insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
    values (${place.client}, ${place.area}, 'CC100', '2020-01-01', '9999-12-31', 'Overhead', 'ADMINISTRATION', ${place.company}, ${ACTOR})
  `));
  return place;
}

function structure(tenant: Place, mode: 'CREATE' | 'CHANGE', structureCode: string, description: string, expectedVersion = 0) {
  return saveAllocationStructure({
    client: tenant.client, changedBy: ACTOR, mode, expectedVersion, structureCode, description,
  });
}

function assignment(tenant: Place, input: {
  structureCode: string;
  sourceAccount: string;
  receiverCategory: 'COST_CENTER' | 'INTERNAL_ORDER' | 'GL_ACCOUNT';
  byOriginalAccount: boolean;
  settlementAccount?: string;
  expectedVersion?: number;
  confirmed?: boolean;
}) {
  return saveAllocationStructureAssignment({
    client: tenant.client,
    changedBy: ACTOR,
    expectedVersion: input.expectedVersion ?? 0,
    structureCode: input.structureCode,
    sourceAccount: input.sourceAccount,
    receiverCategory: input.receiverCategory,
    byOriginalAccount: input.byOriginalAccount,
    settlementAccount: input.settlementAccount ?? '',
    confirmed: input.confirmed,
  });
}

function profile(tenant: Place, mode: 'CREATE' | 'CHANGE', input: {
  profileCode: string;
  description?: string;
  allocationStructure: string;
  documentType?: string;
  percentageAllowed?: boolean;
  equivalenceAllowed?: boolean;
  amountAllowed?: boolean;
  isActive?: boolean;
  expectedVersion?: number;
}) {
  return saveSettlementProfile({
    client: tenant.client,
    changedBy: ACTOR,
    mode,
    expectedVersion: input.expectedVersion ?? 0,
    profileCode: input.profileCode,
    description: input.description ?? 'Order settlement',
    allocationStructure: input.allocationStructure,
    documentType: input.documentType ?? 'SA',
    percentageAllowed: input.percentageAllowed ?? true,
    equivalenceAllowed: input.equivalenceAllowed ?? false,
    amountAllowed: input.amountAllowed ?? false,
    isActive: input.isActive ?? true,
  });
}

function link(tenant: Place, mode: 'CREATE' | 'CHANGE', profileCode: string, expectedVersion = 0, confirmed?: boolean) {
  return assignOrderTypeSettlementProfile({
    client: tenant.client, changedBy: ACTOR, mode, expectedVersion, orderType: 'IO01', profileCode, confirmed,
  });
}

/** The whole chain, as an installer would store it: structure, assignment, profile, type link. */
async function configured(tenant: Place, input?: {
  structureCode?: string;
  profileCode?: string;
  sourceAccount?: string;
  byOriginalAccount?: boolean;
  settlementAccount?: string;
}) {
  const structureCode = input?.structureCode ?? 'AS01';
  const profileCode = input?.profileCode ?? 'SP01';
  await structure(tenant, 'CREATE', structureCode, 'Original account');
  await assignment(tenant, {
    structureCode,
    sourceAccount: input?.sourceAccount ?? '410000',
    receiverCategory: 'COST_CENTER',
    byOriginalAccount: input?.byOriginalAccount ?? true,
    settlementAccount: input?.settlementAccount,
  });
  await profile(tenant, 'CREATE', { profileCode, allocationStructure: structureCode });
  await link(tenant, 'CREATE', profileCode);
}

function order(tenant: Place, description: string) {
  return createInternalOrder({
    client: tenant.client,
    changedBy: ACTOR,
    orderType: 'IO01',
    description,
    controllingArea: tenant.area,
    companyCode: tenant.company,
    startDate: '2026-01-01',
    endDate: '2027-03-31',
  });
}

function cost(tenant: Place, orderNumber: string, amount = '70.0000', glAccount = '410000') {
  return withTenant(tenant.client, (tx) => postJournalEntry(tx, {
    client: tenant.client,
    companyCode: tenant.company,
    documentType: 'SA',
    documentDate: '2026-01-15',
    postingDate: '2026-01-15',
    fiscalYear: 2026,
    postingPeriod: 1,
    currency: tenant.currency,
    localCurrency: tenant.currency,
    headerText: 'Order cost',
    postedBy: ACTOR,
    lines: [
      { glAccount, debitCredit: 'S', amount, internalOrder: orderNumber },
      { glAccount: '100000', debitCredit: 'H', amount },
    ],
  }));
}

/** The order's own rule. Its shared-field arguments disappear with the rule-screen stage. */
function rule(tenant: Place, orderNumber: string, input?: { profileCode?: string; structureCode?: string; sourceAccount?: string }) {
  return saveOrderSettlementConfiguration({
    client: tenant.client,
    changedBy: ACTOR,
    orderNumber,
    receiverCategory: 'COST_CENTER',
    receiver: 'CC100',
    percentage: '100',
    settlementType: 'PER',
    validFromYear: 2026,
    validFromPeriod: 1,
    validToYear: 2026,
    validToPeriod: 12,
  });
}

function settle(tenant: Place, orderNumber: string) {
  return settleOrder({
    client: tenant.client, changedBy: ACTOR, orderNumber, fiscalYear: 2026, settlementPeriod: 1, testRun: false,
  });
}

async function changeRows(tenant: Place, objectClass: string) {
  const rows = await withTenant(tenant.client, async (tx) => tx.execute(sql`
    select change_type, object_key, changed_by
      from change_document
     where client = ${tenant.client} and object_class = ${objectClass}
     order by changed_at, id
  `)) as unknown as Array<{ change_type: string; object_key: string; changed_by: string }>;
  return rows;
}

async function assignmentRows(tenant: Place) {
  const rows = await withTenant(tenant.client, async (tx) => tx.execute(sql`
    select structure_code, source_account, receiver_category, by_original_account, settlement_account, created_by, created_at::text as created_at
      from allocation_structure_assignment
     where client = ${tenant.client}
     order by 1, 2, 3
  `)) as unknown as Array<Record<string, string | boolean | null>>;
  return rows;
}

describe('the settlement masters', () => {
  it('stores a profile with the document type and the methods its maintainer named', async () => {
    const tenant = await standing('ko88-master-create');
    await structure(tenant, 'CREATE', 'AS01', 'Original account');
    await assignment(tenant, {
      structureCode: 'AS01', sourceAccount: '410000', receiverCategory: 'COST_CENTER', byOriginalAccount: true,
    });
    await profile(tenant, 'CREATE', {
      profileCode: 'SP01',
      allocationStructure: 'AS01',
      documentType: 'SA',
      percentageAllowed: true,
      equivalenceAllowed: true,
      amountAllowed: false,
    });

    const stored = await getSettlementProfile(tenant.client, 'SP01');
    expect(stored).toMatchObject({
      profileCode: 'SP01',
      description: 'Order settlement',
      allocationStructure: 'AS01',
      documentType: 'SA',
      percentageAllowed: true,
      equivalenceAllowed: true,
      amountAllowed: false,
      isActive: true,
      version: 1,
    });
    const structureView = await getAllocationStructure(tenant.client, 'AS01');
    expect(structureView?.assignments).toMatchObject([{
      sourceAccount: '410000', receiverCategory: 'COST_CENTER', byOriginalAccount: true, settlementAccount: null, version: 1,
    }]);
    expect(await changeRows(tenant, 'settlement_profile')).toMatchObject([{ change_type: 'CREATE', object_key: 'SP01' }]);
    expect(await changeRows(tenant, 'allocation_structure')).toMatchObject([{ change_type: 'CREATE', object_key: 'AS01' }]);
    expect((await listSettlementProfileDocumentTypes(tenant.client)).length).toBeGreaterThan(0);
  });

  it('refuses to invent a structure, to allow no method, and to create twice', async () => {
    const tenant = await standing('ko88-master-refuse');
    await expect(profile(tenant, 'CREATE', { profileCode: 'SP09', allocationStructure: 'AS99' }))
      .rejects.toThrow(/does not exist\. A profile does not create it/);

    await structure(tenant, 'CREATE', 'AS01', 'Original account');
    await expect(profile(tenant, 'CREATE', {
      profileCode: 'SP01', allocationStructure: 'AS01', percentageAllowed: false, equivalenceAllowed: false, amountAllowed: false,
    })).rejects.toThrow(/allows no distribution method/);

    await profile(tenant, 'CREATE', { profileCode: 'SP01', allocationStructure: 'AS01' });
    const first = await profile(tenant, 'CREATE', { profileCode: 'SP01', allocationStructure: 'AS01', description: 'Changed on a second create' });
    expect(first).toMatchObject({ created: false, changed: false });
    expect((await getSettlementProfile(tenant.client, 'SP01'))?.description).toBe('Order settlement');
    expect((await changeRows(tenant, 'settlement_profile')).length).toBe(1);
  });

  it('refuses a stale version and writes nothing', async () => {
    const tenant = await standing('ko88-master-version');
    await configured(tenant);
    const before = await getSettlementProfile(tenant.client, 'SP01');
    expect(before?.version).toBe(1);

    await expect(profile(tenant, 'CHANGE', {
      profileCode: 'SP01', allocationStructure: 'AS01', description: 'Renamed twice', expectedVersion: 0,
    })).rejects.toThrow(/another version/);

    const after = await getSettlementProfile(tenant.client, 'SP01');
    expect(after?.description).toBe('Order settlement');
    expect(after?.version).toBe(1);
    // The same change at the standing version goes through and bumps it.
    const saved = await profile(tenant, 'CHANGE', {
      profileCode: 'SP01', allocationStructure: 'AS01', description: 'Renamed once', expectedVersion: 1,
    });
    expect(saved).toMatchObject({ changed: true, version: 2 });
    expect((await changeRows(tenant, 'settlement_profile')).map((row) => row.change_type)).toEqual(['CREATE', 'CHANGE']);
  });

  it('gives a removed assignment key the version a re-add has to submit', async () => {
    const tenant = await standing('ko88-master-readd');
    await configured(tenant);

    const live = await getAllocationStructure(tenant.client, 'AS01');
    expect(live?.assignments).toMatchObject([{ sourceAccount: '410000', receiverCategory: 'COST_CENTER', version: 1 }]);
    expect(live?.removedAssignments).toEqual([]);

    await removeAllocationStructureAssignment({
      client: tenant.client, changedBy: ACTOR, structureCode: 'AS01', sourceAccount: '410000', receiverCategory: 'COST_CENTER',
    });
    const removed = await getAllocationStructure(tenant.client, 'AS01');
    expect(removed?.assignments).toEqual([]);
    // Two audit rows stand against the key — the create and the removal — and the guard counts both.
    expect(removed?.removedAssignments).toMatchObject([{ sourceAccount: '410000', receiverCategory: 'COST_CENTER', version: 2 }]);

    // The number a reader that only saw live rows would have sent is 0. The guard is untouched, so it is
    // still refused, and the remedy it offers — re-read and repeat — now leads somewhere.
    await expect(assignment(tenant, {
      structureCode: 'AS01', sourceAccount: '410000', receiverCategory: 'COST_CENTER', byOriginalAccount: true, expectedVersion: 0,
    })).rejects.toThrow(/stands at another version/);

    const back = await assignment(tenant, {
      structureCode: 'AS01',
      sourceAccount: '410000',
      receiverCategory: 'COST_CENTER',
      byOriginalAccount: false,
      settlementAccount: '200000',
      expectedVersion: 2,
    });
    expect(back).toMatchObject({ created: true, changed: true, version: 3 });

    const again = await getAllocationStructure(tenant.client, 'AS01');
    expect(again?.assignments).toMatchObject([{
      sourceAccount: '410000', receiverCategory: 'COST_CENTER', byOriginalAccount: false, settlementAccount: '200000', version: 3,
    }]);
    expect(again?.removedAssignments).toEqual([]);
    expect(await assignmentRows(tenant)).toHaveLength(1);
    expect((await changeRows(tenant, 'allocation_structure_assignment')).map((row) => row.change_type))
      .toEqual(['CREATE', 'DELETE', 'CREATE']);
  });

  it('counts the version on the structure whose key it removes, and nowhere else', async () => {
    const tenant = await standing('ko88-master-removed-scope');
    await configured(tenant);
    await structure(tenant, 'CREATE', 'AS02', 'Second structure');
    await assignment(tenant, { structureCode: 'AS02', sourceAccount: '410000', receiverCategory: 'COST_CENTER', byOriginalAccount: true });

    await removeAllocationStructureAssignment({
      client: tenant.client, changedBy: ACTOR, structureCode: 'AS02', sourceAccount: '410000', receiverCategory: 'COST_CENTER',
    });
    const first = await getAllocationStructure(tenant.client, 'AS01');
    const second = await getAllocationStructure(tenant.client, 'AS02');
    // The audit key is structure/source/receiver: one account standing on two structures is two keys, and a
    // removal on one must not hand the other a version it never earned.
    expect(second?.removedAssignments).toMatchObject([{ sourceAccount: '410000', receiverCategory: 'COST_CENTER', version: 2 }]);
    expect(first?.removedAssignments).toEqual([]);
    expect(first?.assignments).toMatchObject([{ sourceAccount: '410000', version: 1 }]);
    // Removing a key that is already gone writes nothing and reports the number it stands at.
    await expect(removeAllocationStructureAssignment({
      client: tenant.client, changedBy: ACTOR, structureCode: 'AS02', sourceAccount: '410000', receiverCategory: 'COST_CENTER',
    })).resolves.toMatchObject({ removed: false, version: 2 });
    expect((await changeRows(tenant, 'allocation_structure_assignment')).map((row) => row.change_type)).toEqual(['CREATE', 'CREATE', 'DELETE']);
  });

  it('starts a key that was never assigned at version zero', async () => {
    const tenant = await standing('ko88-master-never-used');
    await configured(tenant);
    const view = await getAllocationStructure(tenant.client, 'AS01');
    expect(view?.removedAssignments.map((row) => row.sourceAccount)).not.toContain('410100');

    const fresh = await assignment(tenant, {
      structureCode: 'AS01', sourceAccount: '410100', receiverCategory: 'GL_ACCOUNT', byOriginalAccount: true, expectedVersion: 0,
    });
    expect(fresh).toMatchObject({ created: true, changed: true, version: 1 });
    expect((await getAllocationStructure(tenant.client, 'AS01'))?.removedAssignments).toEqual([]);
  });

  it('refuses a stale assignment save, on a live row and on a key taken back', async () => {
    const tenant = await standing('ko88-master-assignment-stale');
    await configured(tenant);

    const first = await assignment(tenant, {
      structureCode: 'AS01', sourceAccount: '410000', receiverCategory: 'COST_CENTER', byOriginalAccount: false, settlementAccount: '200000', expectedVersion: 1,
    });
    expect(first).toMatchObject({ changed: true, version: 2 });
    await expect(assignment(tenant, {
      structureCode: 'AS01', sourceAccount: '410000', receiverCategory: 'COST_CENTER', byOriginalAccount: true, expectedVersion: 1,
    })).rejects.toThrow(/stands at another version/);
    expect(await assignmentRows(tenant)).toHaveLength(1);
    expect((await getAllocationStructure(tenant.client, 'AS01'))?.assignments[0])
      .toMatchObject({ byOriginalAccount: false, settlementAccount: '200000' });

    await removeAllocationStructureAssignment({
      client: tenant.client, changedBy: ACTOR, structureCode: 'AS01', sourceAccount: '410000', receiverCategory: 'COST_CENTER',
    });
    const view = await getAllocationStructure(tenant.client, 'AS01');
    const at = view?.removedAssignments.find((row) => row.sourceAccount === '410000')?.version ?? -1;
    expect(at).toBe(3);
    // Reading the removed key's version is what makes the re-add pass; one number off still refuses, so the
    // fix has not put a window next to the guard.
    await expect(assignment(tenant, {
      structureCode: 'AS01', sourceAccount: '410000', receiverCategory: 'COST_CENTER', byOriginalAccount: true, expectedVersion: at - 1,
    })).rejects.toThrow(/stands at another version/);
    await expect(assignment(tenant, {
      structureCode: 'AS01', sourceAccount: '410000', receiverCategory: 'COST_CENTER', byOriginalAccount: true, expectedVersion: at,
    })).resolves.toMatchObject({ created: true, version: 4 });
  });

  it('lets the supported fixture writer rebuild a key it removed', async () => {
    const tenant = await standing('ko88-master-fixture');
    await ensureSettlementMasters(tenant.client, { orderType: 'IO01' });
    await removeAllocationStructureAssignment({
      client: tenant.client, changedBy: ACTOR, structureCode: 'AS01', sourceAccount: '410000', receiverCategory: 'COST_CENTER',
    });
    await removeOrderTypeSettlementProfile({ client: tenant.client, changedBy: ACTOR, orderType: 'IO01' });
    // The writer documents itself as idempotent. After a removal, 0 is a stale number for a key that has
    // been used before, so it has to submit what the reads report — on both sides of the chain.
    await expect(ensureSettlementMasters(tenant.client, { orderType: 'IO01' })).resolves.toBeUndefined();
    expect((await getAllocationStructure(tenant.client, 'AS01'))?.assignments)
      .toMatchObject([{ sourceAccount: '410000', receiverCategory: 'COST_CENTER' }]);
    expect((await listOrderTypeSettlementProfiles(tenant.client)).find((row) => row.orderType === 'IO01')?.profileCode).toBe('SP01');
  });

  it('keeps an assignment an unsettled balance still reads', async () => {
    const tenant = await standing('ko88-master-balance');
    await configured(tenant);
    const saved = await order(tenant, 'Balance on the assignment');
    await cost(tenant, saved.orderNumber);

    await expect(assignment(tenant, {
      structureCode: 'AS01',
      sourceAccount: '410000',
      receiverCategory: 'COST_CENTER',
      byOriginalAccount: false,
      settlementAccount: '200000',
      expectedVersion: 1,
    })).rejects.toThrow(/still carry a balance on that account/);

    const rows = await assignmentRows(tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ by_original_account: true, settlement_account: null });

    const dependents = await structureDependents(tenant.client, 'AS01');
    expect(dependents.orders).toBe(1);
    expect(dependents.orderTypes).toEqual(['IO01']);

    // Removing it is refused for the same reason.
    await expect(removeAllocationStructureAssignment({
      client: tenant.client, changedBy: ACTOR, structureCode: 'AS01', sourceAccount: '410000', receiverCategory: 'COST_CENTER',
    })).rejects.toThrow(/still carry a balance on that account/);
  });

  it('asks for a confirmation when settled orders would lose their assignment', async () => {
    const tenant = await standing('ko88-master-confirm');
    await configured(tenant);
    const saved = await order(tenant, 'Settled then unmapped');
    await cost(tenant, saved.orderNumber);
    await rule(tenant, saved.orderNumber);
    const first = await settle(tenant, saved.orderNumber);
    expect(first.posted).toBe(true);

    await expect(removeAllocationStructureAssignment({
      client: tenant.client, changedBy: ACTOR, structureCode: 'AS01', sourceAccount: '410000', receiverCategory: 'COST_CENTER',
    })).rejects.toThrow(/already have settlement documents/);

    const removed = await removeAllocationStructureAssignment({
      client: tenant.client,
      changedBy: ACTOR,
      structureCode: 'AS01',
      sourceAccount: '410000',
      receiverCategory: 'COST_CENTER',
      confirmed: true,
    });
    expect(removed.removed).toBe(true);
    expect(await assignmentRows(tenant)).toHaveLength(0);

    // The posting stops exactly where the check said it would, with the run's own reason.
    await cost(tenant, saved.orderNumber, '30.0000');
    const again = await settle(tenant, saved.orderNumber);
    expect(again.orders[0]?.outcome).toBe('NOT_SETTLED');
    // With no assignment row left on the structure at all, the run stops one step earlier, on the
    // structure itself. Either way the order is not settled and no document is created.
    expect(again.orders[0]?.reasons.join(' ')).toMatch(/no allocation (structure|assignment)/i);
    expect(again.documents).toEqual([]);
  });

  it('keeps a profile active while an order type resolves to it', async () => {
    const tenant = await standing('ko88-master-deactivate');
    await configured(tenant);
    await expect(profile(tenant, 'CHANGE', {
      profileCode: 'SP01', allocationStructure: 'AS01', isActive: false, expectedVersion: 1,
    })).rejects.toThrow(/is assigned to 1 order type/);
    expect((await getSettlementProfile(tenant.client, 'SP01'))?.isActive).toBe(true);

    const removed = await removeOrderTypeSettlementProfile({ client: tenant.client, changedBy: ACTOR, orderType: 'IO01' });
    expect(removed.removed).toBe(true);
    const deactivated = await profile(tenant, 'CHANGE', {
      profileCode: 'SP01', allocationStructure: 'AS01', isActive: false, expectedVersion: 1,
    });
    expect(deactivated.changed).toBe(true);
    expect((await getSettlementProfile(tenant.client, 'SP01'))?.isActive).toBe(false);
    // An inactive profile is not assigned to an order type, and is not reactivated here.
    await expect(link(tenant, 'CREATE', 'SP01')).rejects.toThrow(/is inactive/);
    await expect(profile(tenant, 'CHANGE', {
      profileCode: 'SP01', allocationStructure: 'AS01', isActive: true, expectedVersion: 2,
    })).rejects.toThrow(/is not reactivated/);
  });

  it('keeps allowing a method the orders of the profile still distribute by', async () => {
    const tenant = await standing('ko88-master-method');
    await configured(tenant);
    const saved = await order(tenant, 'Percentage rule');
    await rule(tenant, saved.orderNumber);

    await expect(profile(tenant, 'CHANGE', {
      profileCode: 'SP01',
      allocationStructure: 'AS01',
      percentageAllowed: false,
      equivalenceAllowed: false,
      amountAllowed: true,
      expectedVersion: 1,
    })).rejects.toThrow(/distribute by percentage/);

    const stored = await getSettlementProfile(tenant.client, 'SP01');
    expect(stored).toMatchObject({ percentageAllowed: true, equivalenceAllowed: false, amountAllowed: false });

    // With no rule using percentages, the same change goes through.
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      delete from settlement_distribution_rule where client = ${tenant.client} and order_number = ${saved.orderNumber}
    `));
    const changed = await profile(tenant, 'CHANGE', {
      profileCode: 'SP01',
      allocationStructure: 'AS01',
      percentageAllowed: false,
      equivalenceAllowed: false,
      amountAllowed: true,
      expectedVersion: 1,
    });
    expect(changed.changed).toBe(true);
  });

  it('repoints an order type only onto a configuration that settles its balances', async () => {
    const tenant = await standing('ko88-master-repoint');
    await configured(tenant);
    const saved = await order(tenant, 'Balance to be stranded');
    await cost(tenant, saved.orderNumber);
    await rule(tenant, saved.orderNumber);
    // A second structure and profile with no assignment at all.
    await structure(tenant, 'CREATE', 'AS02', 'Second structure');
    await profile(tenant, 'CREATE', { profileCode: 'SP02', allocationStructure: 'AS02', description: 'Not mapped' });

    await expect(link(tenant, 'CHANGE', 'SP02', 1)).rejects.toThrow(/does not assign/);
    expect((await listOrderTypeSettlementProfiles(tenant.client))[0]).toMatchObject({
      orderType: 'IO01', profileCode: 'SP01', orders: 1, ordersWithRules: 1, ordersWithSettlementDocuments: 0,
    });

    await assignment(tenant, {
      structureCode: 'AS02', sourceAccount: '410000', receiverCategory: 'COST_CENTER', byOriginalAccount: true,
    });
    const repointed = await link(tenant, 'CHANGE', 'SP02', 1);
    expect(repointed).toMatchObject({ changed: true, profileCode: 'SP02' });

    // An unknown profile never becomes a link.
    await expect(link(tenant, 'CHANGE', 'SP99', 2)).rejects.toThrow(/does not exist\. The order type assignment does not create it/);
    expect((await getSettlementProfile(tenant.client, 'SP02'))?.orderTypes).toEqual(['IO01']);
  });

  it('confirms a repoint once orders of the type have settled', async () => {
    const tenant = await standing('ko88-master-repoint-settled');
    await configured(tenant);
    const saved = await order(tenant, 'Settled before repoint');
    await cost(tenant, saved.orderNumber);
    await rule(tenant, saved.orderNumber);
    expect((await settle(tenant, saved.orderNumber)).posted).toBe(true);

    await structure(tenant, 'CREATE', 'AS02', 'Second structure');
    await assignment(tenant, {
      structureCode: 'AS02', sourceAccount: '410000', receiverCategory: 'COST_CENTER', byOriginalAccount: true,
    });
    await profile(tenant, 'CREATE', { profileCode: 'SP02', allocationStructure: 'AS02', description: 'Second profile' });

    await expect(link(tenant, 'CHANGE', 'SP02', 1)).rejects.toThrow(/already have settlement documents/);
    const repointed = await link(tenant, 'CHANGE', 'SP02', 1, true);
    expect(repointed.changed).toBe(true);
    // The settled order keeps its rule and its document; the profile it was settled under stands.
    expect((await getSettlementProfile(tenant.client, 'SP01'))?.orderTypes).toEqual([]);
  });
});
