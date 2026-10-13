import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { purchasingGroup } from '@/modules/foundation/schema';
import { material, materialPlant } from '@/modules/inventory/schema';
import {
  getPurchasingGroupDefinitionVersion,
  listPurchasingGroupDefinitions,
  PurchasingGroupMaintenanceError,
  savePurchasingGroupChanges,
} from '@/modules/foundation/purchasing-group-maintenance';
import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';

const ACTIVITY = 'CFG.PROC.PURGROUP.DEFINE';
const ACTOR = 'SCR019_PURGROUP_TEST';

let alpha: TestTenant | undefined;
let beta: TestTenant | undefined;

function alphaTenant(): TestTenant {
  if (!alpha) throw new Error('SCR-019 primary tenant fixture was not initialized.');
  return alpha;
}

function betaTenant(): TestTenant {
  if (!beta) throw new Error('SCR-019 second tenant fixture was not initialized.');
  return beta;
}

async function resetActivity(client: string) {
  await withTenant(client, async (tx) => {
    await tx
      .insert(configActivityStatus)
      .values({ client, activityCode: ACTIVITY, status: 'NOT_STARTED', createdBy: ACTOR })
      .onConflictDoNothing();
    await tx
      .update(configActivityStatus)
      .set({
        status: 'NOT_STARTED',
        completedAt: null,
        completedBy: null,
        changedBy: ACTOR,
        changedAt: new Date(),
      })
      .where(and(
        eq(configActivityStatus.client, client),
        eq(configActivityStatus.activityCode, ACTIVITY),
      ));
  });
}

async function readGroup(client: string, code: string) {
  return withTenant(client, async (tx) =>
    (await tx
      .select()
      .from(purchasingGroup)
      .where(and(eq(purchasingGroup.client, client), eq(purchasingGroup.purchasingGroup, code))))[0] ?? null,
  );
}

async function readHistory(client: string, code: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, 'purchasing_group', code));
}

async function createGroup(tenant: TestTenant, code: string, name = 'Buyer team') {
  return savePurchasingGroupChanges({
    client: tenant.client,
    changedBy: ACTOR,
    changes: [{
      mode: 'CREATE',
      purchasingGroup: code,
      expectedVersion: 0,
      values: { name },
    }],
  });
}

beforeAll(async () => {
  // T920 and T518 are dedicated to this integration fixture, distinct from guarded browser targets.
  alpha = await createTenant('scr019-purchasing-group-alpha');
  beta = await createTenant('scr019-purchasing-group-beta');
  await resetActivity(alpha.client);
  await resetActivity(beta.client);
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

describe('SCR-019 Purchasing Group maintenance on isolated PostgreSQL', () => {
  it('creates a normalized standalone definition with contacts, audit history and completed activity', async () => {
    const tenant = alphaTenant();
    const result = await savePurchasingGroupChanges({
      client: tenant.client,
      changedBy: ACTOR,
      reason: 'SCR-019 create buyer group',
      changes: [{
        mode: 'CREATE',
        purchasingGroup: ' a19 ',
        expectedVersion: 0,
        values: {
          name: '  Buyer team  ',
          telNoPurchGroup: '200123456789',
          faxNumber: '2001234567890123456789012345678',
          telephone: '0096520012345',
          extension: '214',
          emailAddress: 'purchasing at example.test',
        },
      }],
    });

    expect(result.changedCount).toBe(1);
    expect(result.outcomes).toEqual([expect.objectContaining({
      purchasingGroup: 'A19',
      mode: 'CREATE',
      version: 1,
      changed: true,
    })]);
    expect(await readGroup(tenant.client, 'A19')).toMatchObject({
      client: tenant.client,
      purchasingGroup: 'A19',
      name: 'Buyer team',
      telNoPurchGroup: '200123456789',
      faxNumber: '2001234567890123456789012345678',
      telephone: '0096520012345',
      extension: '214',
      emailAddress: 'purchasing at example.test',
      purchasingOrg: null,
      responsibleBuyer: null,
      isActive: true,
      createdBy: ACTOR,
    });
    expect(await getPurchasingGroupDefinitionVersion(tenant.client, 'A19')).toBe(1);
    expect(await listPurchasingGroupDefinitions(tenant.client)).toEqual(expect.arrayContaining([
      expect.objectContaining({ purchasingGroup: 'A19', name: 'Buyer team', version: 1 }),
    ]));

    const history = await readHistory(tenant.client, 'A19');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      changeType: 'CREATE',
      changedBy: ACTOR,
      reason: 'SCR-019 create buyer group',
      transactionCode: ACTIVITY,
    });
    expect(history[0].items.map((item) => item.fieldName)).toEqual(expect.arrayContaining([
      'purchasingGroup', 'name', 'telNoPurchGroup', 'faxNumber', 'telephone', 'extension', 'emailAddress', 'isActive',
    ]));

    const [activity] = await withTenant(tenant.client, (tx) =>
      tx
        .select()
        .from(configActivityStatus)
        .where(and(
          eq(configActivityStatus.client, tenant.client),
          eq(configActivityStatus.activityCode, ACTIVITY),
        )),
    );
    expect(activity).toMatchObject({ status: 'COMPLETED', completedBy: ACTOR });
  });

  it('changes only overview fields, preserves legacy consumer links, records no-op silence and rejects stale writes', async () => {
    const tenant = alphaTenant();
    const code = 'L01';
    await withTenant(tenant.client, (tx) =>
      tx.insert(purchasingGroup).values({
        client: tenant.client,
        purchasingGroup: code,
        name: 'Legacy buyer team',
        purchasingOrg: '1000',
        responsibleBuyer: 'Legacy responsibility',
        createdBy: ACTOR,
      }),
    );

    const changed = await savePurchasingGroupChanges({
      client: tenant.client,
      changedBy: ACTOR,
      reason: 'SCR-019 contact maintenance',
      changes: [{
        mode: 'CHANGE',
        purchasingGroup: code,
        expectedVersion: 0,
        values: { name: 'Updated buyer', telephone: '5550100', emailAddress: 'buyer@example.test' },
      }],
    });
    expect(changed).toMatchObject({ changedCount: 1, outcomes: [expect.objectContaining({ version: 1, changed: true })] });
    expect(await readGroup(tenant.client, code)).toMatchObject({
      name: 'Updated buyer',
      telephone: '5550100',
      emailAddress: 'buyer@example.test',
      purchasingOrg: '1000',
      responsibleBuyer: 'Legacy responsibility',
      changedBy: ACTOR,
    });
    expect((await readHistory(tenant.client, code))[0].items.map((item) => item.fieldName)).toEqual(
      expect.arrayContaining(['name', 'telephone', 'emailAddress']),
    );

    const noOp = await savePurchasingGroupChanges({
      client: tenant.client,
      changedBy: ACTOR,
      changes: [{
        mode: 'CHANGE',
        purchasingGroup: code,
        expectedVersion: 1,
        values: { name: 'Updated buyer', telephone: '5550100', emailAddress: 'buyer@example.test' },
      }],
    });
    expect(noOp).toMatchObject({ changedCount: 0, outcomes: [expect.objectContaining({ version: 1, changed: false })] });
    expect(await readHistory(tenant.client, code)).toHaveLength(1);

    await expect(savePurchasingGroupChanges({
      client: tenant.client,
      changedBy: ACTOR,
      changes: [{
        mode: 'CHANGE',
        purchasingGroup: code,
        expectedVersion: 0,
        values: { name: 'Stale overwrite' },
      }],
    })).rejects.toBeInstanceOf(PurchasingGroupMaintenanceError);
    expect((await readGroup(tenant.client, code))?.name).toBe('Updated buyer');
  });

  it('isolates identical keys by client and retains deletion history so deleted keys cannot be reused', async () => {
    const first = alphaTenant();
    const second = betaTenant();
    const code = 'D01';
    await createGroup(first, code, 'Alpha buyer');
    await createGroup(second, code, 'Beta buyer');

    const deleted = await savePurchasingGroupChanges({
      client: first.client,
      changedBy: ACTOR,
      changes: [{ mode: 'DELETE', purchasingGroup: code, expectedVersion: 1 }],
    });
    expect(deleted).toMatchObject({ changedCount: 1, outcomes: [expect.objectContaining({ mode: 'DELETE', version: 2 })] });
    expect(await readGroup(first.client, code)).toBeNull();
    expect(await getPurchasingGroupDefinitionVersion(first.client, code)).toBe(2);
    expect(await readHistory(first.client, code)).toHaveLength(2);
    expect((await readHistory(first.client, code))[0].changeType).toBe('DELETE');
    expect(await readGroup(second.client, code)).toMatchObject({ name: 'Beta buyer' });
    expect(await getPurchasingGroupDefinitionVersion(second.client, code)).toBe(1);

    await expect(createGroup(first, code, 'Attempted key reuse')).rejects.toMatchObject({
      message: `Purchasing Group ${code} has prior change history and cannot be reused.`,
    });
    expect(await readGroup(second.client, code)).toMatchObject({ name: 'Beta buyer' });
  });

  it('blocks deletion while a Material purchasing view references the group and rolls back delete history', async () => {
    const tenant = alphaTenant();
    const code = 'R01';
    await createGroup(tenant, code, 'Referenced buyer');

    await withTenant(tenant.client, async (tx) => {
      await tx.insert(material).values({
        client: tenant.client,
        materialNumber: 'SCR019-MAT-01',
        description: 'Purchasing Group reference fixture',
        materialType: 'RAW',
        createdBy: ACTOR,
      });
      await tx.insert(materialPlant).values({
        client: tenant.client,
        materialNumber: 'SCR019-MAT-01',
        plant: '1000',
        purchasingGroup: code,
        createdBy: ACTOR,
      });
    });

    await expect(savePurchasingGroupChanges({
      client: tenant.client,
      changedBy: ACTOR,
      changes: [{ mode: 'DELETE', purchasingGroup: code, expectedVersion: 1 }],
    })).rejects.toMatchObject({
      message: `Purchasing Group ${code} cannot be deleted while Material or Supplier purchasing records reference it.`,
    });
    expect(await readGroup(tenant.client, code)).toMatchObject({ name: 'Referenced buyer' });
    expect(await readHistory(tenant.client, code)).toHaveLength(1);
    expect(await getPurchasingGroupDefinitionVersion(tenant.client, code)).toBe(1);
  });
});
