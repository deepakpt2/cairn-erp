import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import { configActivityStatus } from '@/platform/tables/registry';
import { journalEntry, journalEntryLine } from '@/modules/finance/schema';
import { appUser } from '@/platform/tables/security';
import { profitCenterHierarchy, profitCenterNode, profitCenterNodeAssignment } from '@/modules/foundation/schema';
import {
  ACTIVITY,
  ProfitCenterError,
  deleteProfitCenter,
  listProfitCenters,
  listResponsibleUsers,
  saveProfitCenter,
  setProfitCenterPostingLock,
  type ProfitCenterInput,
} from '@/modules/foundation/profit-center-definition';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR045_STAGE5';
const REASON = 'SCR-045 automated backend test';

let tenant: TestTenant | undefined;
let prerequisiteTenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-045 stage 5 tenant fixture was not initialized.');
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

/** One posted document carrying the centre on a line — a debit and a credit to balance. */
async function insertJournalEntry(client: string, postingDate: string) {
  await withTenant(client, async (tx) => {
    await tx.insert(journalEntry).values({
      client,
      documentNumber: 'KE51-1',
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
        documentNumber: 'KE51-1',
        fiscalYear: 2026,
        lineNumber,
        glAccount: '140000',
        companyCode: '1000',
        debitCredit,
        amountLocal: '15.0000',
        amountDocument: '15.0000',
        currency: 'KWD',
        profitCenter: lineNumber === 1 ? 'PC100' : null,
      });
    }
  });
}

function creation(overrides: Partial<ProfitCenterInput> = {}): ProfitCenterInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    controllingArea: 'A000',
    profitCenter: 'PC100',
    validFrom: '2026-01-01',
    validTo: '9999-12-31',
    name: 'Services Profit Ctr',
    longText: 'Services & Consulting Profit Center',
    personResponsible: 'Jane Doe',
    responsibleUser: '',
    segment: 'SEG_CORP',
    reason: REASON,
    ...overrides,
  };
}

beforeAll(async () => {
  tenant = await createTenant('scr045-ke51-stage5');
  const { client } = fixture();
  await setActivity(client, 'CFG.COST.CONTROLLINGAREA.DEFINE', 'COMPLETED');
  await setActivity(client, ACTIVITY, 'NOT_STARTED');
  // A user who can sign in here, for the responsible-user judge.
  await withTenant(client, async (tx) => {
    await tx
      .insert(appUser)
      .values({
        id: 'scr045-user-1',
        client,
        username: 'jdoe',
        fullName: 'Jane Doe',
        passwordHash: 'fixture-only',
        isActive: true,
        createdBy: TEST_ACTOR,
      })
      .onConflictDoNothing();
  });

  prerequisiteTenant = await createTenant('scr045-ke51-prereq');
});

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  if (prerequisiteTenant) await destroyTenant(prerequisiteTenant.client);
  await closeDb();
});

describe('profit centre definition (SCR-045)', () => {
  it('starts empty beside the area and the tenant users', async () => {
    const { client } = fixture();
    expect(await listProfitCenters(client, 'A000')).toEqual([]);
    const users = await listResponsibleUsers(client);
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((user) => user.username !== '')).toBe(true);
  });

  it('creates a period, documents it, completes the activity', async () => {
    const { client } = fixture();
    const users = await listResponsibleUsers(client);
    const result = await saveProfitCenter(creation({ responsibleUser: users[0].username }));
    expect(result.changed).toBe(true);

    const rows = await listProfitCenters(client, 'A000');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      profitCenter: 'PC100',
      name: 'Services Profit Ctr',
      longText: 'Services & Consulting Profit Center',
      segment: 'SEG_CORP',
      isPostingLocked: false,
    });
    expect(rows[0].responsibleUser).toBe(users[0].username);

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
      changeHistory(tx, client, 'profit_center', 'A000/PC100/2026-01-01'),
    );
    const own = documents.filter((document) => document.transactionCode === ACTIVITY);
    expect(own).toHaveLength(1);
    expect(own[0].changeType).toBe('CREATE');
    for (const field of ['responsibleUser', 'segment']) {
      expect(
        own[0].items.find((item) => item.fieldName === field)?.isSecurityRelevant,
      ).toBe('true');
    }
  });

  it('refuses create over a standing period and change of a missing one', async () => {
    await expect(saveProfitCenter(creation())).rejects.toThrow(/already defined/);
    await expect(
      saveProfitCenter(creation({ mode: 'CHANGE', validFrom: '2024-01-01' })),
    ).rejects.toThrow(/not defined/);
  });

  it('judges the responsible user against the tenant users', async () => {
    await expect(
      saveProfitCenter(creation({ profitCenter: 'PC200', responsibleUser: 'NO_SUCH_USER' })),
    ).rejects.toThrow(/Responsible User NO_SUCH_USER is not an active user/);
    const unassigned = await saveProfitCenter(
      creation({ profitCenter: 'PC200', responsibleUser: '' }),
    );
    expect(unassigned.changed).toBe(true);
  });

  it('judges the text widths at parity', async () => {
    await expect(
      saveProfitCenter(creation({ profitCenter: 'PC201', name: '123456789012345678901' })),
    ).rejects.toThrow(/Name is at most 20/);
    await expect(
      saveProfitCenter(
        creation({ profitCenter: 'PC201', name: 'Ok', longText: 'x'.repeat(41) }),
      ),
    ).rejects.toThrow(/Long Text is at most 40/);
    await expect(
      saveProfitCenter(creation({ profitCenter: 'PC201', name: 'Ok', segment: 'TOOLONGSEG1' })),
    ).rejects.toThrow(/Segment is at most 10/);
  });

  it('judges the span: end before start, overlaps named, adjacent period stands', async () => {
    await expect(
      saveProfitCenter(creation({ profitCenter: 'PC300', validFrom: '2026-06-01', validTo: '2026-01-01' })),
    ).rejects.toThrow(/precedes Valid From/);
    await expect(
      saveProfitCenter(creation({ validFrom: '2026-06-01', validTo: '2026-12-31' })),
    ).rejects.toThrow(/overlaps the period 2026-01-01 to 9999-12-31/);
    const adjacent = await saveProfitCenter(
      creation({ validFrom: '2025-01-01', validTo: '2025-12-31', name: 'Earlier services' }),
    );
    expect(adjacent.changed).toBe(true);
  });

  it('re-sets valid to only while it overlaps no sibling', async () => {
    await expect(
      saveProfitCenter(
        creation({ mode: 'CHANGE', validFrom: '2025-01-01', validTo: '2026-06-01', name: 'Earlier services' }),
      ),
    ).rejects.toThrow(/overlaps the period 2026-01-01/);
  });

  it('changes the facts of a period, no-op on repeat', async () => {
    const changed = await saveProfitCenter(
      creation({
        mode: 'CHANGE',
        validFrom: '2025-01-01',
        validTo: '2025-12-31',
        name: 'Earlier svcs renamed',
        responsibleUser: '',
        segment: '',
      }),
    );
    expect(changed.changed).toBe(true);
    const repeated = await saveProfitCenter(
      creation({
        mode: 'CHANGE',
        validFrom: '2025-01-01',
        validTo: '2025-12-31',
        name: 'Earlier svcs renamed',
        responsibleUser: '',
        segment: '',
      }),
    );
    expect(repeated.changed).toBe(false);
    const rows = await listProfitCenters(fixture().client, 'A000');
    const earlier = rows.find((row) => row.validFrom === '2025-01-01');
    expect(earlier?.segment).toBeNull();
  });

  it('locks and unlocks for posting, repeat a no-op', async () => {
    const { client } = fixture();
    const locked = await setProfitCenterPostingLock({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: 'A000',
      profitCenter: 'PC100',
      validFrom: '2026-01-01',
      locked: true,
      reason: REASON,
    });
    expect(locked).toEqual({ locked: true, changed: true });
    const repeat = await setProfitCenterPostingLock({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: 'A000',
      profitCenter: 'PC100',
      validFrom: '2026-01-01',
      locked: true,
      reason: REASON,
    });
    expect(repeat).toEqual({ locked: true, changed: false });
    await setProfitCenterPostingLock({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: 'A000',
      profitCenter: 'PC100',
      validFrom: '2026-01-01',
      locked: false,
      reason: REASON,
    });
  });

  it('refuses deletion while a journal document inside carries the centre', async () => {
    const { client } = fixture();
    await insertJournalEntry(client, '2026-06-15');
    await expect(
      deleteProfitCenter({
        client,
        changedBy: TEST_ACTOR,
        controllingArea: 'A000',
        profitCenter: 'PC100',
        validFrom: '2026-01-01',
        reason: REASON,
      }),
    ).rejects.toThrow(/carries 1 journal document/);
  });

  it('deletes an unused period and documents it', async () => {
    const { client } = fixture();
    await deleteProfitCenter({
      client,
      changedBy: TEST_ACTOR,
      controllingArea: 'A000',
      profitCenter: 'PC200',
      validFrom: '2026-01-01',
      reason: REASON,
    });
    expect(
      (await listProfitCenters(client, 'A000')).some((row) => row.profitCenter === 'PC200'),
    ).toBe(false);
    const documents = await withTenant(client, (tx) =>
      changeHistory(tx, client, 'profit_center', 'A000/PC200/2026-01-01'),
    );
    expect(
      documents.some(
        (document) => document.changeType === 'DELETE' && document.transactionCode === ACTIVITY,
      ),
    ).toBe(true);
  });

  it('shows the hierarchy placement from SCR-046 assignments', async () => {
    const { client } = fixture();
    const beforeRows = await listProfitCenters(client, 'A000');
    expect(beforeRows.find((row) => row.profitCenter === 'PC100' && row.validFrom === '2026-01-01')?.hierarchyNode).toBeNull();

    await withTenant(client, async (tx) => {
      await tx
        .insert(profitCenterHierarchy)
        .values({ client, controllingArea: 'A000', title: 'Test hierarchy', createdBy: TEST_ACTOR })
        .onConflictDoNothing();
      await tx
        .insert(profitCenterNode)
        .values({
          client, controllingArea: 'A000', node: 'PROD', parentNode: null,
          title: 'Production', createdBy: TEST_ACTOR,
        })
        .onConflictDoNothing();
      await tx.insert(profitCenterNodeAssignment).values({
        client, controllingArea: 'A000', node: 'PROD', profitCenter: 'PC100',
        validFrom: '2026-01-01', createdBy: TEST_ACTOR,
      });
    });

    const afterRows = await listProfitCenters(client, 'A000');
    expect(afterRows.find((row) => row.profitCenter === 'PC100' && row.validFrom === '2026-01-01')?.hierarchyNode).toBe('PROD');
  });

  it('refuses the prerequisite tenant, formats and a blank reason', async () => {
    if (!prerequisiteTenant) throw new Error('prerequisite tenant missing');
    await expect(
      saveProfitCenter({ ...creation(), client: prerequisiteTenant.client }),
    ).rejects.toThrow(/CFG\.COST\.CONTROLLINGAREA\.DEFINE/);
    await expect(saveProfitCenter(creation({ profitCenter: 'PC-100' }))).rejects.toThrow(
      /Profit Centre is up to ten letters or digits/,
    );
    await expect(saveProfitCenter(creation({ reason: ' ' }))).rejects.toBeInstanceOf(
      ProfitCenterError,
    );
  });
});
