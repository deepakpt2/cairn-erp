import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import { configActivityStatus } from '@/platform/tables/registry';
import { saveCostCenter } from '@/modules/foundation/cost-center-definition';
import {
  ACTIVITY,
  ActivityTypeError,
  canonicalValidCategories,
  deleteActivityType,
  listActivityTypes,
  listActivityUnits,
  saveActivityType,
  setActivityTypePostingLock,
  type ActivityTypeInput,
} from '@/modules/foundation/activity-type-definition';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR043_STAGE5';
const REASON = 'SCR-043 automated backend test';

let tenant: TestTenant | undefined;
let prerequisiteTenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-043 stage 5 tenant fixture was not initialized.');
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

function creation(overrides: Partial<ActivityTypeInput> = {}): ActivityTypeInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    controllingArea: 'A000',
    activityType: 'LAB01',
    validFrom: '2026-01-01',
    validTo: '9999-12-31',
    name: 'Direct Labor Hours',
    activityUnit: 'HR',
    category: '1',
    priceIndicator: '3',
    validCcCategories: ['PRODUCTION', 'SERVICE'],
    reason: REASON,
    ...overrides,
  };
}

beforeAll(async () => {
  tenant = await createTenant('scr043-kl01-stage5');
  const { client } = fixture();
  await setActivity(client, 'CFG.COST.CONTROLLINGAREA.DEFINE', 'COMPLETED');
  await setActivity(client, 'CFG.COST.COSTCENTER.DEFINE', 'COMPLETED');
  await setActivity(client, ACTIVITY, 'NOT_STARTED');
  // A cost centre standing, so the prerequisite chain is honest.
  await saveCostCenter({
    client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    controllingArea: 'A000',
    costCenter: 'CC1000',
    validFrom: '2026-01-01',
    validTo: '9999-12-31',
    name: 'Fixture centre',
    personResponsible: '',
    category: 'PRODUCTION',
    companyCode: '1000',
    reason: REASON,
  });

  prerequisiteTenant = await createTenant('scr043-kl01-prereq');
});

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  if (prerequisiteTenant) await destroyTenant(prerequisiteTenant.client);
  await closeDb();
});

describe('activity type definition (SCR-043)', () => {
  it('canonicalizes the valid-category subset in catalogue order', () => {
    expect(canonicalValidCategories(['SERVICE', 'PRODUCTION'])).toBe('PRODUCTION,SERVICE');
    expect(canonicalValidCategories([])).toBe('');
  });

  it('starts empty beside the area and the standing units', async () => {
    const { client } = fixture();
    expect(await listActivityTypes(client, 'A000')).toEqual([]);
    const units = await listActivityUnits();
    expect(units.find((unit) => unit.code === 'HR')?.dimension).toBe('TIME');
    expect(units.find((unit) => unit.code === 'PC')?.dimension).toBe('COUNT');
  });

  it('creates a period, documents it, completes the activity', async () => {
    const { client } = fixture();
    const result = await saveActivityType(creation());
    expect(result.changed).toBe(true);

    const rows = await listActivityTypes(client, 'A000');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      activityType: 'LAB01',
      activityUnit: 'HR',
      category: '1',
      priceIndicator: '3',
      validCcCategories: 'PRODUCTION,SERVICE',
      isPostingLocked: false,
    });

    const [status] = await withTenant(client, (tx) =>
      tx
        .select()
        .from(configActivityStatus)
        .where(
          and(
            eq(configActivityStatus.client, client),
            eq(configActivityStatus.activityCode, ACTIVITY),
          ),
        ),
    );
    expect(status?.status).toBe('COMPLETED');

    const documents = await withTenant(client, (tx) =>
      changeHistory(tx, client, 'activity_type', 'A000/LAB01/2026-01-01'),
    );
    const own = documents.filter((document) => document.transactionCode === ACTIVITY);
    expect(own).toHaveLength(1);
    expect(own[0].changeType).toBe('CREATE');
    for (const field of ['activityUnit', 'category', 'priceIndicator']) {
      expect(
        own[0].items.find((item) => item.fieldName === field)?.isSecurityRelevant,
      ).toBe('true');
    }
    expect(own[0].items.find((item) => item.fieldName === 'validCcCategories')?.newValue).toBe(
      'PRODUCTION,SERVICE',
    );
  });

  it('refuses create over a standing period and change of a missing one', async () => {
    await expect(saveActivityType(creation())).rejects.toThrow(/already defined/);
    await expect(
      saveActivityType(creation({ mode: 'CHANGE', validFrom: '2024-01-01' })),
    ).rejects.toThrow(/not defined/);
  });

  it('judges the unit against the standing units table', async () => {
    await expect(
      saveActivityType(creation({ activityType: 'LAB02', activityUnit: 'FURLONG' })),
    ).rejects.toThrow(/Activity Unit FURLONG is not a unit of measure that stands/);
    // Any standing unit is allowed (SAP parity), counts included.
    const counted = await saveActivityType(
      creation({ activityType: 'SET01', activityUnit: 'PC', name: 'Setups' }),
    );
    expect(counted.changed).toBe(true);
  });

  it('judges both digits against their catalogues', async () => {
    await expect(saveActivityType(creation({ activityType: 'LAB03', category: '9' }))).rejects.toThrow(
      /Activity Category is one of/,
    );
    await expect(
      saveActivityType(creation({ activityType: 'LAB03', priceIndicator: '0' })),
    ).rejects.toThrow(/Price Indicator is one of/);
  });

  it('judges the categories against the KS01 catalogue', async () => {
    await expect(
      saveActivityType(creation({ activityType: 'LAB03', validCcCategories: ['WORKSHOP'] })),
    ).rejects.toThrow(/cost centre categories are chosen from the defined categories/);
  });

  it('judges the span: end before start, overlaps named, adjacent period stands', async () => {
    await expect(
      saveActivityType(creation({ activityType: 'LAB03', validFrom: '2026-06-01', validTo: '2026-01-01' })),
    ).rejects.toThrow(/precedes Valid From/);
    await expect(
      saveActivityType(creation({ validFrom: '2026-06-01', validTo: '2026-12-31' })),
    ).rejects.toThrow(/overlaps the period 2026-01-01 to 9999-12-31/);
    const adjacent = await saveActivityType(
      creation({ validFrom: '2025-01-01', validTo: '2025-12-31', name: 'Earlier labour' }),
    );
    expect(adjacent.changed).toBe(true);
  });

  it('re-sets valid to only while it overlaps no sibling', async () => {
    await expect(
      saveActivityType(
        creation({ mode: 'CHANGE', validFrom: '2025-01-01', validTo: '2026-06-01', name: 'Earlier labour' }),
      ),
    ).rejects.toThrow(/overlaps the period 2026-01-01/);
  });

  it('changes the facts of a period, no-op on repeat, blank categories mean all', async () => {
    const changed = await saveActivityType(
      creation({
        mode: 'CHANGE',
        validFrom: '2025-01-01',
        validTo: '2025-12-31',
        name: 'Earlier labour (renamed)',
        validCcCategories: [],
        category: '3',
      }),
    );
    expect(changed.changed).toBe(true);
    const repeated = await saveActivityType(
      creation({
        mode: 'CHANGE',
        validFrom: '2025-01-01',
        validTo: '2025-12-31',
        name: 'Earlier labour (renamed)',
        validCcCategories: [],
        category: '3',
      }),
    );
    expect(repeated.changed).toBe(false);
    const rows = await listActivityTypes(fixture().client, 'A000');
    const earlier = rows.find((row) => row.validFrom === '2025-01-01' && row.activityType === 'LAB01');
    expect(earlier?.validCcCategories).toBe('');
    expect(earlier?.category).toBe('3');
  });

  it('locks and unlocks for posting, repeat a no-op', async () => {
    const { client } = fixture();
    const locked = await setActivityTypePostingLock({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: 'A000',
      activityType: 'LAB01',
      validFrom: '2026-01-01',
      locked: true,
      reason: REASON,
    });
    expect(locked).toEqual({ locked: true, changed: true });
    const repeat = await setActivityTypePostingLock({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: 'A000',
      activityType: 'LAB01',
      validFrom: '2026-01-01',
      locked: true,
      reason: REASON,
    });
    expect(repeat).toEqual({ locked: true, changed: false });
    await setActivityTypePostingLock({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: 'A000',
      activityType: 'LAB01',
      validFrom: '2026-01-01',
      locked: false,
      reason: REASON,
    });
  });

  it('deletes a period and refuses the prerequisite tenant, formats and a blank reason', async () => {
    const { client } = fixture();
    await deleteActivityType({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: 'A000',
      activityType: 'SET01',
      validFrom: '2026-01-01',
      reason: REASON,
    });
    expect(
      (await listActivityTypes(client, 'A000')).some((row) => row.activityType === 'SET01'),
    ).toBe(false);

    if (!prerequisiteTenant) throw new Error('prerequisite tenant missing');
    await expect(
      saveActivityType({ ...creation(), client: prerequisiteTenant.client }),
    ).rejects.toThrow(/CFG\.COST\.COSTCENTER\.DEFINE/);
    await expect(saveActivityType(creation({ activityType: 'LAB-01' }))).rejects.toThrow(
      /Activity Type is up to six letters or digits/,
    );
    await expect(saveActivityType(creation({ reason: ' ' }))).rejects.toBeInstanceOf(
      ActivityTypeError,
    );
  });
});
