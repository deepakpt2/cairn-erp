import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import { configActivityStatus } from '@/platform/tables/registry';
import { controllingAreaCompany } from '@/modules/foundation/schema';
import { journalEntry, journalEntryLine } from '@/modules/finance/schema';
import {
  ACTIVITY,
  CostCenterError,
  deleteCostCenter,
  listAreaCompanyCodes,
  listCostCenterAreas,
  listCostCenters,
  saveCostCenter,
  setCostCenterPostingLock,
  type CostCenterInput,
} from '@/modules/foundation/cost-center-definition';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR041_STAGE5';
const REASON = 'SCR-041 automated backend test';

let tenant: TestTenant | undefined;
let prerequisiteTenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-041 stage 5 tenant fixture was not initialized.');
  return tenant;
}

async function completeActivity(client: string, activityCode: string) {
  await withTenant(client, async (tx) => {
    await tx
      .insert(configActivityStatus)
      .values({ client, activityCode, status: 'COMPLETED', createdBy: TEST_ACTOR })
      .onConflictDoUpdate({
        target: [configActivityStatus.client, configActivityStatus.activityCode],
        set: { status: 'COMPLETED', changedBy: TEST_ACTOR, changedAt: new Date() },
      });
  });
}

/** The controlling area and its company assignment: the configured fixture
 * tenant already stands area A000 with company 1000 assigned to it (a company
 * code belongs to exactly one area), so these inserts only confirm the shape. */
async function standArea(client: string) {
  await withTenant(client, async (tx) => {
    await tx
      .insert(controllingAreaCompany)
      .values({ client, controllingArea: 'A000', companyCode: '1000', createdBy: TEST_ACTOR })
      .onConflictDoNothing();
  });
}

/** One posted document carrying the centre on a line — a debit and a credit to balance. */
async function insertJournalEntry(client: string, postingDate: string) {
  await withTenant(client, async (tx) => {
    await tx.insert(journalEntry).values({
      client,
      documentNumber: 'KS01-1',
      fiscalYear: 2026,
      documentType: 'SA',
      companyCode: '1000',
      documentDate: postingDate,
      postingDate,
      postingPeriod: 6,
      documentCurrency: 'KWD',
      localCurrency: 'KWD',
      status: 'POSTED',
      createdBy: TEST_ACTOR,
    });
    for (const [lineNumber, debitCredit] of [[1, 'S'], [2, 'H']] as const) {
      await tx.insert(journalEntryLine).values({
        client,
        documentNumber: 'KS01-1',
        fiscalYear: 2026,
        lineNumber,
        glAccount: '140000',
        companyCode: '1000',
        debitCredit,
        amountLocal: '15.0000',
        amountDocument: '15.0000',
        currency: 'KWD',
        costCenter: lineNumber === 1 ? 'CC1000' : null,
      });
    }
  });
}

function creation(overrides: Partial<CostCenterInput> = {}): CostCenterInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    controllingArea: 'A000',
    costCenter: 'CC1000',
    validFrom: '2026-01-01',
    validTo: '9999-12-31',
    name: 'Production Cost Center',
    personResponsible: 'Fixture Owner',
    category: 'PRODUCTION',
    companyCode: '1000',
    reason: REASON,
    ...overrides,
  };
}

beforeAll(async () => {
  tenant = await createTenant('scr041-ks01-stage5');
  const { client } = fixture();
  await standArea(client);
  await completeActivity(client, 'CFG.COST.CONTROLLINGAREA.DEFINE');
  // A standing status row for this activity: markActivityComplete only
  // updates, and the fixture tenant carries none for it yet.
  await withTenant(client, async (tx) => {
    await tx
      .insert(configActivityStatus)
      .values({ client, activityCode: ACTIVITY, status: 'NOT_STARTED', createdBy: TEST_ACTOR })
      .onConflictDoNothing();
  });

  prerequisiteTenant = await createTenant('scr041-ks01-prereq');
});

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  if (prerequisiteTenant) await destroyTenant(prerequisiteTenant.client);
  await closeDb();
});

describe('cost centre definition (SCR-041)', () => {
  it('starts empty beside the area and its assigned company codes', async () => {
    const { client } = fixture();
    expect(await listCostCenters(client, 'A000')).toEqual([]);
    expect(await listCostCenterAreas(client)).toContainEqual({
      controllingArea: 'A000',
      name: 'Standard controlling area',
      currency: 'USD',
    });
    expect(await listAreaCompanyCodes(client, 'A000')).toEqual(['1000']);
  });

  it('creates a period, documents it and completes the activity', async () => {
    const { client } = fixture();
    const result = await saveCostCenter(creation());
    expect(result.changed).toBe(true);

    const rows = await listCostCenters(client, 'A000');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      costCenter: 'CC1000',
      validFrom: '2026-01-01',
      validTo: '9999-12-31',
      personResponsible: 'Fixture Owner',
      category: 'PRODUCTION',
      companyCode: '1000',
      isPostingLocked: false,
      journalDocuments: 0,
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

    const history = await withTenant(client, (tx) =>
      changeHistory(tx, client, 'cost_center', 'A000/CC1000/2026-01-01'),
    );
    expect(history).toHaveLength(1);
    expect(history[0].changeType).toBe('CREATE');
    expect(
      history[0].items.find((item) => item.fieldName === 'companyCode')?.isSecurityRelevant,
    ).toBe('true');
  });

  it('refuses create over a standing period and change of a missing one', async () => {
    await expect(saveCostCenter(creation())).rejects.toThrow(/already defined/);
    await expect(
      saveCostCenter(creation({ mode: 'CHANGE', validFrom: '2024-01-01' })),
    ).rejects.toThrow(/not defined/);
  });

  it('refuses a company code that is not assigned to the area, by name', async () => {
    await expect(
      saveCostCenter(creation({ costCenter: 'CC2000', companyCode: '9999' })),
    ).rejects.toThrow(/Company Code 9999 is not assigned to Controlling Area A000/);
  });

  it('refuses an area the tenant does not hold', async () => {
    await expect(saveCostCenter(creation({ controllingArea: '9999' }))).rejects.toThrow(
      /Controlling Area 9999 is not defined/,
    );
  });

  it('judges the period span: end before start, and overlaps named', async () => {
    await expect(
      saveCostCenter(creation({ costCenter: 'CC3000', validFrom: '2026-06-01', validTo: '2026-01-01' })),
    ).rejects.toThrow(/precedes Valid From/);
    await expect(
      saveCostCenter(creation({ validFrom: '2026-06-01', validTo: '2026-12-31' })),
    ).rejects.toThrow(/overlaps the period 2026-01-01 to 9999-12-31/);
    // An adjacent earlier period stands.
    const adjacent = await saveCostCenter(
      creation({ validFrom: '2025-01-01', validTo: '2025-12-31', name: 'Earlier production' }),
    );
    expect(adjacent.changed).toBe(true);
  });

  it('re-sets valid to only while it overlaps no sibling', async () => {
    await expect(
      saveCostCenter(
        creation({ mode: 'CHANGE', validFrom: '2025-01-01', validTo: '2026-06-01', name: 'Earlier production' }),
      ),
    ).rejects.toThrow(/overlaps the period 2026-01-01/);
  });

  it('changes the facts of a period, no-op on repeat', async () => {
    const changed = await saveCostCenter(
      creation({
        mode: 'CHANGE',
        validFrom: '2025-01-01',
        validTo: '2025-12-31',
        name: 'Earlier production centre',
        personResponsible: '',
        category: 'ADMINISTRATION',
      }),
    );
    expect(changed.changed).toBe(true);
    const repeated = await saveCostCenter(
      creation({
        mode: 'CHANGE',
        validFrom: '2025-01-01',
        validTo: '2025-12-31',
        name: 'Earlier production centre',
        personResponsible: '',
        category: 'ADMINISTRATION',
      }),
    );
    expect(repeated.changed).toBe(false);
    const rows = await listCostCenters(fixture().client, 'A000');
    const earlier = rows.find((row) => row.validFrom === '2025-01-01');
    expect(earlier?.personResponsible).toBeNull();
    expect(earlier?.category).toBe('ADMINISTRATION');
  });

  it('locks and unlocks for posting, the lock security-relevant, repeat a no-op', async () => {
    const { client } = fixture();
    const locked = await setCostCenterPostingLock({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: 'A000',
      costCenter: 'CC1000',
      validFrom: '2026-01-01',
      locked: true,
      reason: REASON,
    });
    expect(locked).toEqual({ locked: true, changed: true });
    const repeat = await setCostCenterPostingLock({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: 'A000',
      costCenter: 'CC1000',
      validFrom: '2026-01-01',
      locked: true,
      reason: REASON,
    });
    expect(repeat).toEqual({ locked: true, changed: false });
    const history = await withTenant(client, (tx) =>
      changeHistory(tx, client, 'cost_center', 'A000/CC1000/2026-01-01'),
    );
    expect(
      history.some((document) =>
        document.items.some(
          (item) => item.fieldName === 'isPostingLocked' && item.isSecurityRelevant === 'true',
        ),
      ),
    ).toBe(true);
    await setCostCenterPostingLock({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: 'A000',
      costCenter: 'CC1000',
      validFrom: '2026-01-01',
      locked: false,
      reason: REASON,
    });
  });

  it('refuses deletion while documents dated inside the period carry the centre', async () => {
    const { client } = fixture();
    await insertJournalEntry(client, '2026-06-15');
    await expect(
      deleteCostCenter({
        client,
        changedBy: TEST_ACTOR,
        controllingArea: 'A000',
        costCenter: 'CC1000',
        validFrom: '2026-01-01',
        reason: REASON,
      }),
    ).rejects.toThrow(/carries 1 journal document dated inside this period/);
    const rows = await listCostCenters(client, 'A000');
    expect(rows.find((row) => row.validFrom === '2026-01-01')?.journalDocuments).toBe(1);
    // The 2025 period carries no documents inside its window and deletes.
    await deleteCostCenter({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: 'A000',
      costCenter: 'CC1000',
      validFrom: '2025-01-01',
      reason: REASON,
    });
    expect(
      (await listCostCenters(client, 'A000')).some((row) => row.validFrom === '2025-01-01'),
    ).toBe(false);
  });

  it('refuses category, format and reason failures at their own joints', async () => {
    await expect(saveCostCenter(creation({ category: 'ADMIN' as never }))).rejects.toThrow(
      CostCenterError,
    );
    await expect(
      saveCostCenter(creation({ costCenter: 'CC-1000', validFrom: '2030-01-01' })),
    ).rejects.toThrow(/Cost Centre is up to ten letters or digits/);
    await expect(saveCostCenter(creation({ validFrom: '2026-02-30' }))).rejects.toThrow(
      /real calendar date/,
    );
    await expect(saveCostCenter(creation({ reason: '  ' }))).rejects.toThrow(/reason is required/);
  });

  it('refuses while the controlling-area prerequisite is incomplete', async () => {
    if (!prerequisiteTenant) throw new Error('prerequisite tenant missing');
    await expect(
      saveCostCenter({ ...creation(), client: prerequisiteTenant.client }),
    ).rejects.toThrow(/CFG\.COST\.CONTROLLINGAREA\.DEFINE/);
  });
});
