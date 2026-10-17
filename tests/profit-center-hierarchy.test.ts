import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import { configActivityStatus } from '@/platform/tables/registry';
import { saveProfitCenter } from '@/modules/foundation/profit-center-definition';
import {
  profitCenter,
  profitCenterGroupLeaf,
} from '@/modules/foundation/schema';
import {
  ACTIVITY,
  ProfitCenterHierarchyError,
  addGroupLeaf,
  deleteProfitCenterGroup,
  deleteHierarchyNode,
  flattenNodes,
  listHierarchy,
  placeProfitCenterPeriod,
  resolveGroupMembers,
  saveProfitCenterGroup,
  saveHierarchyHeader,
  saveHierarchyNode,
  unplaceProfitCenterPeriod,
} from '@/modules/foundation/profit-center-hierarchy';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR046_STAGE5';
const REASON = 'SCR-046 automated backend test';
const AREA = 'A000';
const CENTRE_REASON = 'SCR-046 automated backend test';

let tenant: TestTenant | undefined;
let prerequisiteTenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-046 stage 5 tenant fixture was not initialized.');
  return tenant;
}

async function setActivity(client: string, activityCode: string, status: 'COMPLETED' | 'NOT_STARTED') {
  await withTenant(client, async (tx) => {
    await tx
      .insert(configActivityStatus)
      .values({ client, activityCode, status, createdBy: TEST_ACTOR })
      .onConflictDoUpdate({
        target: [configActivityStatus.client, configActivityStatus.activityCode],
        set: { status, changedBy: TEST_ACTOR, changedAt: new Date() },
      });
  });
}

async function standPeriod(client: string, profitCenter: string) {
  await saveProfitCenter({
    client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    controllingArea: AREA,
    profitCenter,
    validFrom: '2026-01-01',
    validTo: '9999-12-31',
    name: `Centre ${profitCenter}`,
    longText: '',
    personResponsible: '',
    responsibleUser: '',
    segment: '',
    reason: CENTRE_REASON,
  });
}

function header(overrides: Record<string, unknown> = {}) {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE' as const,
    controllingArea: AREA,
    title: 'Standard hierarchy',
    reason: REASON,
    ...overrides,
  };
}

function node(nodeKey: string, overrides: Record<string, unknown> = {}) {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE' as const,
    controllingArea: AREA,
    node: nodeKey,
    parentNode: '',
    title: `Node ${nodeKey}`,
    displayOrder: 0,
    reason: REASON,
    ...overrides,
  };
}

beforeAll(async () => {
  tenant = await createTenant('scr046-ksh1-stage5');
  const { client } = fixture();
  await setActivity(client, 'CFG.COST.CONTROLLINGAREA.DEFINE', 'COMPLETED');
  await setActivity(client, 'CFG.COST.PROFITCENTER.DEFINE', 'COMPLETED');
  await setActivity(client, ACTIVITY, 'NOT_STARTED');
  await standPeriod(client, 'CC1000');
  await standPeriod(client, 'CC2000');
  await standPeriod(client, 'CC3000');

  prerequisiteTenant = await createTenant('scr046-ksh1-prereq');
});

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  if (prerequisiteTenant) await destroyTenant(prerequisiteTenant.client);
  await closeDb();
});

describe('profit centre hierarchy (SCR-046)', () => {
  it('resolves group members in display order, exclusions removing', () => {
    const members = resolveGroupMembers(
      ['CC1000', 'CC1500', 'CC2000', 'CC3000'],
      [
        { valSign: 'I', valOption: 'BT', valFrom: 'CC1000', valTo: 'CC2000', displayOrder: 1 },
        { valSign: 'E', valOption: 'EQ', valFrom: 'CC1500', valTo: '', displayOrder: 2 },
        { valSign: 'I', valOption: 'EQ', valFrom: 'CC3000', valTo: '', displayOrder: 3 },
      ],
    );
    expect(members).toEqual(['CC1000', 'CC2000', 'CC3000']);
  });

  it('flattens the tree in sibling display order with depths', () => {
    const rows = flattenNodes(
      [
        { node: 'ROOT', parentNode: null, title: 'root', displayOrder: 0 },
        { node: 'B', parentNode: 'ROOT', title: 'b', displayOrder: 2 },
        { node: 'A', parentNode: 'ROOT', title: 'a', displayOrder: 1 },
        { node: 'A1', parentNode: 'A', title: 'a1', displayOrder: 0 },
      ],
      new Map(),
    );
    expect(rows.map((row) => `${row.depth}:${row.node}`)).toEqual(['0:ROOT', '1:A', '2:A1', '1:B']);
  });

  it('defines the header once and refuses the duplicate', async () => {
    await saveHierarchyHeader(header());
    await expect(saveHierarchyHeader(header())).rejects.toThrow(/already defined/);
  });

  it('defines nodes: the root first, a second root refused, children under it', async () => {
    await saveHierarchyNode(node('ALL'));
    await expect(saveHierarchyNode(node('OTHER'))).rejects.toThrow(/already has root ALL/);
    await saveHierarchyNode(node('PROD', { parentNode: 'ALL', displayOrder: 1 }));
    await saveHierarchyNode(node('ADMIN', { parentNode: 'ALL', displayOrder: 2 }));
    const view = await listHierarchy(fixture().client, AREA);
    expect(view.nodes.map((entry) => entry.node)).toEqual(['ALL', 'PROD', 'ADMIN']);
    expect(view.nodes[0].depth).toBe(0);
  });

  it('refuses cycles: a root cannot be parked under its own child', async () => {
    await expect(
      saveHierarchyNode(node('ALL', { mode: 'CHANGE', parentNode: 'PROD' })),
    ).rejects.toThrow(/cycle/);
  });

  it('guards the tree at ten levels', async () => {
    const { client } = fixture();
    await saveHierarchyHeader({
      ...header({ title: 'Depth fixture' }),
      client,
      controllingArea: AREA,
    }).catch(() => undefined);
    let parent = 'DEEP0';
    await saveHierarchyNode(node('DEEP0', { parentNode: 'ALL' }));
    for (let level = 1; level <= 8; level += 1) {
      await saveHierarchyNode(node(`DEEP${level}`, { parentNode: parent }));
      parent = `DEEP${level}`;
    }
    // ALL(1) DEEP0(2) … DEEP8(10): the next level is refused.
    await expect(saveHierarchyNode(node('DEEP9', { parentNode: 'DEEP8' }))).rejects.toThrow(
      /guarded at 10/,
    );
  });

  it('places a period exclusively; moving is unplace-then-place', async () => {
    const { client } = fixture();
    await placeProfitCenterPeriod({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: AREA,
      node: 'PROD',
      profitCenter: 'CC1000',
      validFrom: '2026-01-01',
      reason: REASON,
    });
    await expect(
      placeProfitCenterPeriod({
        client,
        changedBy: TEST_ACTOR,
        controllingArea: AREA,
        node: 'ADMIN',
        profitCenter: 'CC1000',
        validFrom: '2026-01-01',
        reason: REASON,
      }),
    ).rejects.toThrow(/already stands in Node PROD/);
    await unplaceProfitCenterPeriod({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: AREA,
      node: 'PROD',
      profitCenter: 'CC1000',
      validFrom: '2026-01-01',
      reason: REASON,
    });
    await placeProfitCenterPeriod({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: AREA,
      node: 'ADMIN',
      profitCenter: 'CC1000',
      validFrom: '2026-01-01',
      reason: REASON,
    });
    const view = await listHierarchy(client, AREA);
    expect(view.placements).toContainEqual(
      expect.objectContaining({ node: 'ADMIN', profitCenter: 'CC1000' }),
    );
    expect(view.unplacedPeriods.map((period) => period.profitCenter)).toEqual(['CC2000', 'CC3000']);
    const documents = await withTenant(client, (tx) =>
      changeHistory(tx, client, 'profit_center_node_assignment', `${AREA}/CC1000/2026-01-01`),
    );
    const own = documents.filter((document) => document.transactionCode === ACTIVITY);
    expect(own.map((document) => document.changeType)).toEqual(
      expect.arrayContaining(['CREATE', 'DELETE', 'CREATE']),
    );
  });

  it('refuses placing a period that does not stand', async () => {
    await expect(
      placeProfitCenterPeriod({
        client: fixture().client,
        changedBy: TEST_ACTOR,
        controllingArea: AREA,
        node: 'PROD',
        profitCenter: 'CC9999',
        validFrom: '2026-01-01',
        reason: REASON,
      }),
    ).rejects.toThrow(/has no period from 2026-01-01/);
  });

  it('deletes a node only when children and placements are gone', async () => {
    const { client } = fixture();
    await expect(
      deleteHierarchyNode({
        client,
        changedBy: TEST_ACTOR,
        controllingArea: AREA,
        node: 'ALL',
        reason: REASON,
      }),
    ).rejects.toThrow(/child node/);
    await expect(
      deleteHierarchyNode({
        client,
        changedBy: TEST_ACTOR,
        controllingArea: AREA,
        node: 'ADMIN',
        reason: REASON,
      }),
    ).rejects.toThrow(/placed period/);
    await unplaceProfitCenterPeriod({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: AREA,
      node: 'ADMIN',
      profitCenter: 'CC1000',
      validFrom: '2026-01-01',
      reason: REASON,
    });
    await deleteHierarchyNode({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: AREA,
      node: 'ADMIN',
      reason: REASON,
    });
    // The master stands untouched by every placement act.
    const masters = await withTenant(client, (tx) =>
      tx.select().from(profitCenter).where(eq(profitCenter.client, client)),
    );
    expect(masters).toHaveLength(3);
  });

  it('builds alternative groups: ranged leaves with an exclusion resolve dynamically', async () => {
    const { client } = fixture();
    await saveProfitCenterGroup({
      client,
      changedBy: TEST_ACTOR,
      mode: 'CREATE',
      controllingArea: AREA,
      groupName: 'PLANTS',
      title: 'Plant centres',
      reason: REASON,
    });
    await addGroupLeaf({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: AREA,
      groupName: 'PLANTS',
      valSign: 'I',
      valOption: 'BT',
      valFrom: 'CC1000',
      valTo: 'CC2000',
      displayOrder: 1,
      reason: REASON,
    });
    await addGroupLeaf({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: AREA,
      groupName: 'PLANTS',
      valSign: 'E',
      valOption: 'EQ',
      valFrom: 'CC2000',
      valTo: '',
      displayOrder: 2,
      reason: REASON,
    });
    const view = await listHierarchy(client, AREA);
    const group = view.groups.find((entry) => entry.groupName === 'PLANTS');
    expect(group?.members).toEqual(['CC1000']);
  });

  it('judges leaf shapes: EQ with an end, BT reversed', async () => {
    const { client } = fixture();
    await expect(
      addGroupLeaf({
        client,
        changedBy: TEST_ACTOR,
        controllingArea: AREA,
        groupName: 'PLANTS',
        valSign: 'I',
        valOption: 'EQ',
        valFrom: 'CC1000',
        valTo: 'CC2000',
        displayOrder: 3,
        reason: REASON,
      }),
    ).rejects.toThrow(/names no upper end/);
    await expect(
      addGroupLeaf({
        client,
        changedBy: TEST_ACTOR,
        controllingArea: AREA,
        groupName: 'PLANTS',
        valSign: 'I',
        valOption: 'BT',
        valFrom: 'CC3000',
        valTo: 'CC1000',
        displayOrder: 3,
        reason: REASON,
      }),
    ).rejects.toThrow(/ordered pair/);
  });

  it('deletes a group with its leaves; the centres stand', async () => {
    const { client } = fixture();
    const result = await deleteProfitCenterGroup({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: AREA,
      groupName: 'PLANTS',
      reason: REASON,
    });
    expect(result.leaves).toBe(2);
    const leaves = await withTenant(client, (tx) =>
      tx.select().from(profitCenterGroupLeaf).where(eq(profitCenterGroupLeaf.client, client)),
    );
    expect(leaves).toHaveLength(0);
    const masters = await withTenant(client, (tx) =>
      tx.select().from(profitCenter).where(eq(profitCenter.client, client)),
    );
    expect(masters).toHaveLength(3);
  });

  it('refuses while the cost-centre prerequisite is incomplete', async () => {
    if (!prerequisiteTenant) throw new Error('prerequisite tenant missing');
    await expect(
      saveHierarchyHeader({ ...header(), client: prerequisiteTenant.client }),
    ).rejects.toThrow(/CFG\.COST\.PROFITCENTER\.DEFINE/);
    await expect(saveHierarchyHeader(header({ reason: ' ' }))).rejects.toBeInstanceOf(
      ProfitCenterHierarchyError,
    );
  });
});
