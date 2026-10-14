import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { division, distributionChannel, salesArea } from '@/modules/foundation/schema';
import {
  deactivateDivision,
  deactivateDistributionChannel,
  DistributionDimensionMaintenanceError,
  getDivisionDefinitionVersion,
  getDistributionChannelDefinitionVersion,
  saveDivisionDefinition,
  saveDistributionChannelDefinition,
} from '@/modules/foundation/distribution-channel-division-maintenance';
import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';

const ACTIVITY_CODES = ['CFG.ORG.DISTCHANNEL.DEFINE', 'CFG.ORG.DIVISION.DEFINE'] as const;
const ACTOR = 'SCR022_DIMENSION_TEST';
let alpha: TestTenant | undefined;
let beta: TestTenant | undefined;

function tenantA() {
  if (!alpha) throw new Error('SCR-022 primary tenant fixture was not initialized.');
  return alpha;
}
function tenantB() {
  if (!beta) throw new Error('SCR-022 secondary tenant fixture was not initialized.');
  return beta;
}
async function setActivities(client: string) {
  await withTenant(client, async (tx) => {
    for (const activityCode of ACTIVITY_CODES) {
      await tx.insert(configActivityStatus).values({
        client, activityCode, status: 'NOT_STARTED', createdBy: ACTOR,
      }).onConflictDoNothing();
      await tx.update(configActivityStatus).set({
        status: 'NOT_STARTED', completedAt: null, completedBy: null, changedBy: ACTOR, changedAt: new Date(),
      }).where(and(eq(configActivityStatus.client, client), eq(configActivityStatus.activityCode, activityCode)));
    }
  });
}
async function createChannel(tenant: TestTenant, code: string, name = 'Wholesale') {
  return saveDistributionChannelDefinition({
    client: tenant.client, changedBy: ACTOR, mode: 'CREATE', distributionChannel: code,
    expectedVersion: 0, values: { name },
  });
}
async function createDivision(tenant: TestTenant, code: string, name = 'Bicycles') {
  return saveDivisionDefinition({
    client: tenant.client, changedBy: ACTOR, mode: 'CREATE', division: code,
    expectedVersion: 0, values: { name },
  });
}
async function readChannel(client: string, code: string) {
  return withTenant(client, async (tx) => {
    const [row] = await tx.select().from(distributionChannel).where(and(
      eq(distributionChannel.client, client), eq(distributionChannel.distributionChannel, code),
    ));
    return row ? { ...row, distributionChannel: row.distributionChannel.trim() } : null;
  });
}
async function readDivision(client: string, code: string) {
  return withTenant(client, async (tx) => {
    const [row] = await tx.select().from(division).where(and(
      eq(division.client, client), eq(division.division, code),
    ));
    return row ? { ...row, division: row.division.trim() } : null;
  });
}
async function history(client: string, objectClass: string, code: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, objectClass, code));
}

beforeAll(async () => {
  alpha = await createTenant('scr022-channel-division-alpha');
  beta = await createTenant('scr022-channel-division-beta');
  await setActivities(alpha.client);
  await setActivities(beta.client);
}, Number(process.env.CAIRN_TEST_HOOK_TIMEOUT_MS ?? 30_000));

afterAll(async () => {
  try {
    if (alpha) await destroyTenant(alpha.client);
  } finally {
    try {
      if (beta) await destroyTenant(beta.client);
    } finally {
      await closeDb();
    }
  }
});

describe('SCR-022 Distribution Channel and Division definition services', () => {
  it('creates both tenant definitions with normalized keys, separate audit trails and activity completion', async () => {
    const tenant = tenantA();
    await expect(createChannel(tenant, 'wh')).resolves.toMatchObject({
      distributionChannel: 'WH', created: true, changed: true, isActive: true, version: 1,
    });
    await expect(createDivision(tenant, 'bi')).resolves.toMatchObject({
      division: 'BI', created: true, changed: true, isActive: true, version: 1,
    });
    expect(await readChannel(tenant.client, 'WH')).toMatchObject({
      distributionChannel: 'WH', name: 'Wholesale', isActive: true, createdBy: ACTOR,
    });
    expect(await readDivision(tenant.client, 'BI')).toMatchObject({
      division: 'BI', name: 'Bicycles', isActive: true, createdBy: ACTOR,
    });
    expect(await history(tenant.client, 'distribution_channel', 'WH')).toHaveLength(1);
    expect(await history(tenant.client, 'division', 'BI')).toHaveLength(1);
    const statuses = await withTenant(tenant.client, (tx) => tx.select().from(configActivityStatus)
      .where(and(eq(configActivityStatus.client, tenant.client))));
    expect(statuses.filter((row) => ACTIVITY_CODES.includes(row.activityCode as typeof ACTIVITY_CODES[number]))
      .every((row) => row.status === 'COMPLETED' && row.completedBy === ACTOR)).toBe(true);
  });

  it('enforces required two-character alphanumeric keys and 20-character names, unique per tenant', async () => {
    const first = tenantA();
    const second = tenantB();
    await expect(createChannel(first, 'A')).rejects.toBeInstanceOf(DistributionDimensionMaintenanceError);
    await expect(createChannel(first, 'A-')).rejects.toBeInstanceOf(DistributionDimensionMaintenanceError);
    await expect(createDivision(first, 'TOO')).rejects.toBeInstanceOf(DistributionDimensionMaintenanceError);
    await expect(createChannel(first, 'N1', '123456789012345678901'))
      .rejects.toBeInstanceOf(DistributionDimensionMaintenanceError);
    await expect(createDivision(first, 'N2', '     ')).rejects.toBeInstanceOf(DistributionDimensionMaintenanceError);
    await expect(saveDistributionChannelDefinition({
      client: first.client, changedBy: ACTOR, mode: 'CREATE', distributionChannel: 'N3', expectedVersion: 0,
      values: { name: 'Valid', active: false } as never,
    })).rejects.toBeInstanceOf(DistributionDimensionMaintenanceError);

    await createChannel(first, 'Q1', 'Online');
    await expect(createChannel(first, 'Q1', 'Retail')).rejects.toMatchObject({ message: expect.stringContaining('already exists') });
    await expect(createChannel(second, 'Q1', 'Online')).resolves.toMatchObject({ created: true, distributionChannel: 'Q1' });
    expect(await readChannel(first.client, 'Q1')).toMatchObject({ name: 'Online' });
    expect(await readChannel(second.client, 'Q1')).toMatchObject({ name: 'Online' });
  });

  it('changes only the name, makes identical changes idempotent and rejects stale versions', async () => {
    const tenant = tenantA();
    await createDivision(tenant, 'R1', 'Retail');
    await expect(saveDivisionDefinition({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', division: 'R1', expectedVersion: 1,
      values: { name: 'Retail' },
    })).resolves.toMatchObject({ division: 'R1', changed: false, version: 1 });
    await expect(saveDivisionDefinition({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', division: 'R1', expectedVersion: 1,
      values: { name: 'Direct Sales' },
    })).resolves.toMatchObject({ division: 'R1', changed: true, version: 2 });
    await expect(saveDivisionDefinition({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', division: 'R1', expectedVersion: 1,
      values: { name: 'Stale Name' },
    })).rejects.toBeInstanceOf(DistributionDimensionMaintenanceError);
    expect(await getDivisionDefinitionVersion(tenant.client, 'R1')).toBe(2);
    expect(await readDivision(tenant.client, 'R1')).toMatchObject({ division: 'R1', name: 'Direct Sales', isActive: true });
    const entries = await history(tenant.client, 'division', 'R1');
    expect(entries).toHaveLength(2);
    const definitionChange = entries.find((entry) => entry.changeType === 'CHANGE');
    expect(definitionChange?.items.map((item) => item.fieldName)).toEqual(['name']);
  });

  it('soft-deactivates unused entries with history and refuses entries referenced by any Sales Area', async () => {
    const tenant = tenantA();
    await createChannel(tenant, 'S1', 'Unused');
    await expect(deactivateDistributionChannel({
      client: tenant.client, changedBy: ACTOR, distributionChannel: 'S1', expectedVersion: 1,
      reason: 'No longer used',
    })).resolves.toMatchObject({ distributionChannel: 'S1', changed: true, isActive: false, version: 2 });
    expect(await readChannel(tenant.client, 'S1')).toMatchObject({ isActive: false, name: 'Unused', changedBy: ACTOR });
    const channelRetirement = (await history(tenant.client, 'distribution_channel', 'S1'))
      .flatMap((entry) => entry.items).find((item) => item.fieldName === 'isActive');
    expect(channelRetirement).toMatchObject({ oldValue: 'true', newValue: 'false', isSecurityRelevant: 'true' });
    await expect(createChannel(tenant, 'S1', 'Reactivated')).rejects.toBeInstanceOf(DistributionDimensionMaintenanceError);

    await createChannel(tenant, 'S2', 'Referenced');
    await withTenant(tenant.client, (tx) => tx.insert(salesArea).values({
      client: tenant.client, salesOrg: '1000', distributionChannel: 'S2', division: '01',
      name: 'SCR-022 channel dependency', createdBy: ACTOR,
    }));
    await expect(deactivateDistributionChannel({
      client: tenant.client, changedBy: ACTOR, distributionChannel: 'S2', expectedVersion: 1,
    })).rejects.toMatchObject({ message: expect.stringContaining('still referenced by Sales Area') });
    expect(await readChannel(tenant.client, 'S2')).toMatchObject({ isActive: true });

    await createDivision(tenant, 'S3', 'Referenced line');
    await withTenant(tenant.client, (tx) => tx.insert(salesArea).values({
      client: tenant.client, salesOrg: '1000', distributionChannel: '01', division: 'S3',
      name: 'SCR-022 division dependency', createdBy: ACTOR,
    }));
    await expect(deactivateDivision({
      client: tenant.client, changedBy: ACTOR, division: 'S3', expectedVersion: 1,
    })).rejects.toMatchObject({ message: expect.stringContaining('still referenced by Sales Area') });
    expect(await readDivision(tenant.client, 'S3')).toMatchObject({ isActive: true });
  });
});
