import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import { configActivityStatus } from '@/platform/tables/registry';
import { saveActivityType, deleteActivityType } from '@/modules/foundation/activity-type-definition';
import { saveCostCenter, deleteCostCenter } from '@/modules/foundation/cost-center-definition';
import {
  ACTIVITY,
  ActivityRateError,
  deleteActivityRate,
  listActivityRates,
  planningContext,
  saveActivityRates,
  type ActivityRatesInput,
} from '@/modules/foundation/activity-rate-definition';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR044_STAGE5';
const REASON = 'SCR-044 automated backend test';

let tenant: TestTenant | undefined;
let prerequisiteTenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-044 stage 5 tenant fixture was not initialized.');
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

function plan(overrides: Partial<ActivityRatesInput> = {}): ActivityRatesInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    controllingArea: 'A000',
    planVersion: '000',
    fiscalYear: 2026,
    costCenter: 'CC1000',
    activityType: 'LAB01',
    entries: [
      { period: 1, plannedQuantity: '160.000', fixedPrice: '50.00', variablePrice: '10.00', priceUnit: 1 },
      { period: 2, plannedQuantity: '150.000', fixedPrice: '50.00', variablePrice: '10.00', priceUnit: 1 },
    ],
    reason: REASON,
    ...overrides,
  };
}

beforeAll(async () => {
  tenant = await createTenant('scr044-kp26-stage5');
  const { client } = fixture();
  await setActivity(client, 'CFG.COST.CONTROLLINGAREA.DEFINE', 'COMPLETED');
  await setActivity(client, 'CFG.COST.COSTCENTER.DEFINE', 'COMPLETED');
  await setActivity(client, 'CFG.COST.ACTIVITYTYPE.DEFINE', 'COMPLETED');
  await setActivity(client, ACTIVITY, 'NOT_STARTED');

  await saveCostCenter({
    client, changedBy: TEST_ACTOR, mode: 'CREATE', controllingArea: 'A000',
    costCenter: 'CC1000', validFrom: '2026-01-01', validTo: '2026-12-31',
    name: 'Production centre', personResponsible: '', category: 'PRODUCTION',
    companyCode: '1000', reason: REASON,
  });
  await saveCostCenter({
    client, changedBy: TEST_ACTOR, mode: 'CREATE', controllingArea: 'A000',
    costCenter: 'CC2000', validFrom: '2026-01-01', validTo: '2026-12-31',
    name: 'Service centre', personResponsible: '', category: 'SERVICE',
    companyCode: '1000', reason: REASON,
  });
  await saveActivityType({
    client, changedBy: TEST_ACTOR, mode: 'CREATE', controllingArea: 'A000',
    activityType: 'LAB01', validFrom: '2026-01-01', validTo: '9999-12-31',
    name: 'Direct Labor Hours', activityUnit: 'HR', category: '1',
    priceIndicator: '3', validCcCategories: ['PRODUCTION'], reason: REASON,
  });
  await saveActivityType({
    client, changedBy: TEST_ACTOR, mode: 'CREATE', controllingArea: 'A000',
    activityType: 'AUTO1', validFrom: '2026-01-01', validTo: '9999-12-31',
    name: 'Automatic priced', activityUnit: 'HR', category: '1',
    priceIndicator: '1', validCcCategories: [], reason: REASON,
  });
  await saveActivityType({
    client, changedBy: TEST_ACTOR, mode: 'CREATE', controllingArea: 'A000',
    activityType: 'PART01', validFrom: '2026-01-01', validTo: '2026-06-30',
    name: 'Half-year type', activityUnit: 'HR', category: '1',
    priceIndicator: '3', validCcCategories: [], reason: REASON,
  });

  prerequisiteTenant = await createTenant('scr044-kp26-prereq');
});

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  if (prerequisiteTenant) await destroyTenant(prerequisiteTenant.client);
  await closeDb();
});

describe('activity rate planning (SCR-044)', () => {
  it('reads the planning context from the area variant', async () => {
    const { client } = fixture();
    const context = await planningContext(client, 'A000', 2026);
    expect(context?.currency).toMatch(/^[A-Z]{3}$/);
    expect(context?.periods.length).toBeGreaterThanOrEqual(12);
    expect(context?.periods[0]).toMatchObject({ period: 1, start: '2026-01-01', end: '2026-01-31' });
  });

  it('saves a matrix act under one document and completes the activity', async () => {
    const { client } = fixture();
    const result = await saveActivityRates(plan());
    expect(result).toEqual({ changed: true, periods: 2 });

    const rows = await listActivityRates(client, {
      controllingArea: 'A000', planVersion: '000', fiscalYear: 2026,
      costCenter: 'CC1000', activityType: 'LAB01',
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      period: 1, plannedQuantity: '160.000', fixedPrice: '50.00', variablePrice: '10.00', priceUnit: 1,
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
      changeHistory(tx, client, 'activity_rate', 'A000/000/2026/CC1000/LAB01'),
    );
    const own = documents.filter((document) => document.transactionCode === ACTIVITY);
    expect(own).toHaveLength(1);
    expect(
      own[0].items.find((item) => item.fieldName === 'p1FixedPrice')?.isSecurityRelevant,
    ).toBe('true');
    expect(own[0].items.find((item) => item.fieldName === 'p2Quantity')?.newValue).toBe('150.000');
  });

  it('is a no-op when the matrix repeats itself', async () => {
    const repeated = await saveActivityRates(plan());
    expect(repeated.changed).toBe(false);
  });

  it('versions stand side by side as a free key', async () => {
    const { client } = fixture();
    const alt = await saveActivityRates(plan({ planVersion: '100' }));
    expect(alt.changed).toBe(true);
    const v000 = await listActivityRates(client, {
      controllingArea: 'A000', planVersion: '000', fiscalYear: 2026,
      costCenter: 'CC1000', activityType: 'LAB01',
    });
    const v100 = await listActivityRates(client, {
      controllingArea: 'A000', planVersion: '100', fiscalYear: 2026,
      costCenter: 'CC1000', activityType: 'LAB01',
    });
    expect(v000).toHaveLength(2);
    expect(v100).toHaveLength(2);
  });

  it('special periods share the last regular period window', async () => {
    const { client } = fixture();
    const context = await planningContext(client, 'A000', 2026);
    const regular = context?.periods.filter((period) => period.periodType === 'REGULAR') ?? [];
    const specials = context?.periods.filter((period) => period.periodType === 'SPECIAL') ?? [];
    expect(regular).toHaveLength(12);
    for (const special of specials) {
      expect(special.start).toBe(regular[regular.length - 1]?.start);
      expect(special.end).toBe(regular[regular.length - 1]?.end);
    }
  });

  it('judges master validity per period, not per year', async () => {
    // PART01 stands only to 2026-06-30: July (period 7) refuses, June stands.
    await expect(
      saveActivityRates(plan({
        activityType: 'PART01',
        entries: [{ period: 7, plannedQuantity: '10', fixedPrice: '1', variablePrice: '0', priceUnit: 1 }],
      })),
    ).rejects.toThrow(/Activity Type PART01 is not valid in period 7/);
    const june = await saveActivityRates(plan({
      activityType: 'PART01',
      entries: [{ period: 6, plannedQuantity: '10', fixedPrice: '1', variablePrice: '0', priceUnit: 1 }],
    }));
    expect(june.changed).toBe(true);
    // A centre unknown to the area refuses on the same rule.
    await expect(saveActivityRates(plan({ costCenter: 'CC9999' }))).rejects.toThrow(
      /Cost Centre CC9999 is not valid in period 1/,
    );
  });

  it('judges the type against the centre category', async () => {
    // LAB01 is valid for PRODUCTION only; CC2000 is SERVICE.
    await expect(saveActivityRates(plan({ costCenter: 'CC2000' }))).rejects.toThrow(
      /not valid for cost centre category SERVICE/,
    );
  });

  it('automatic indicators refuse entered prices while quantities stand', async () => {
    await expect(
      saveActivityRates(plan({
        activityType: 'AUTO1',
        entries: [{ period: 3, plannedQuantity: '10', fixedPrice: '5', variablePrice: '0', priceUnit: 1 }],
      })),
    ).rejects.toThrow(/price indicator 1 \(automatic\)/);
    const quantityOnly = await saveActivityRates(plan({
      activityType: 'AUTO1',
      entries: [{ period: 3, plannedQuantity: '10', fixedPrice: '0', variablePrice: '0', priceUnit: 1 }],
    }));
    expect(quantityOnly.changed).toBe(true);
  });

  it('judges the arithmetic widths and the price unit floor', async () => {
    await expect(
      saveActivityRates(plan({
        entries: [{ period: 4, plannedQuantity: '1.2345', fixedPrice: '0', variablePrice: '0', priceUnit: 1 }],
      })),
    ).rejects.toThrow(/planned activity quantity is a number with up to 3/);
    await expect(
      saveActivityRates(plan({
        entries: [{ period: 4, plannedQuantity: '1', fixedPrice: '0', variablePrice: '0', priceUnit: 0 }],
      })),
    ).rejects.toThrow(/price unit is at least 1/);
    await expect(saveActivityRates(plan({ planVersion: 'TOOLONG' }))).rejects.toThrow(
      /Planning Version is up to three/,
    );
  });

  it('deletes a period row and documents it', async () => {
    const { client } = fixture();
    await deleteActivityRate({
      client, changedBy: TEST_ACTOR, controllingArea: 'A000', planVersion: '100',
      fiscalYear: 2026, period: 2, costCenter: 'CC1000', activityType: 'LAB01', reason: REASON,
    });
    const rows = await listActivityRates(client, {
      controllingArea: 'A000', planVersion: '100', fiscalYear: 2026,
      costCenter: 'CC1000', activityType: 'LAB01',
    });
    expect(rows.map((row) => row.period)).toEqual([1]);
  });

  it('gives the activity type deletion judge its count', async () => {
    const { client } = fixture();
    await expect(
      deleteActivityType({
        client, changedBy: TEST_ACTOR, controllingArea: 'A000',
        activityType: 'LAB01', validFrom: '2026-01-01', reason: REASON,
      }),
    ).rejects.toThrow(/activity rate row/);
  });

  it('gives the cost centre deletion judge its count', async () => {
    const { client } = fixture();
    await expect(
      deleteCostCenter({
        client, changedBy: TEST_ACTOR, controllingArea: 'A000',
        costCenter: 'CC1000', validFrom: '2026-01-01', reason: REASON,
      }),
    ).rejects.toThrow(/activity rate row/);
  });

  it('refuses the prerequisite tenant, and a blank reason', async () => {
    if (!prerequisiteTenant) throw new Error('prerequisite tenant missing');
    await expect(
      saveActivityRates({ ...plan(), client: prerequisiteTenant.client }),
    ).rejects.toThrow(/CFG\.COST\.ACTIVITYTYPE\.DEFINE/);
    await expect(saveActivityRates(plan({ reason: ' ' }))).rejects.toBeInstanceOf(
      ActivityRateError,
    );
  });
});
