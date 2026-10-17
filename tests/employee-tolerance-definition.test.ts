/**
 * SCR-039 / OBA4 stage 5 — defining employee tolerance groups.
 *
 * Nothing delivers groups into a tenant, so the fixture starts empty and
 * every row under test is written through the service here. The sharp
 * edges are the stored meanings (R-88): both key parts may be blank (the
 * tenant-wide scope, its default group), a zero in any limit imposes no
 * ceiling, the line ceiling is judged against the document ceiling only
 * when both stand non-zero — so the tests work that rule through all
 * three zero shapes — and the cash-discount ceiling of 100.000 stores
 * whole after stage 2 widened the column that would have refused it.
 *
 * Deletion is asserted only in its absence: no delete exists in the
 * service surface, by ruling, and the screen says why.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { employeeToleranceGroup } from '@/modules/foundation/schema';
import {
  ACTIVITY,
  ToleranceGroupError,
  listEmployeeToleranceGroups,
  listToleranceCompanies,
  saveEmployeeToleranceGroup,
  type ToleranceGroupInput,
} from '@/modules/foundation/employee-tolerance-definition';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR039_STAGE5';
const REASON = 'SCR-039 automated backend test';

const COMPANY = '1000';
const GROUP = 'TG01';

let tenant: TestTenant | undefined;
let prerequisiteTenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-039 stage 5 tenant fixture was not initialized.');
  return tenant;
}

beforeAll(async () => {
  tenant = await createTenant('scr039-oba4-stage5');
  const { client } = fixture();

  await completePrerequisite(client);
  await startActivity(client);
});

afterAll(async () => {
  if (prerequisiteTenant) await destroyTenant(prerequisiteTenant.client);
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

/* ── Helpers ────────────────────────────────────────────────────────────────── */

async function completePrerequisite(client: string) {
  await withTenant(client, (tx) => tx.insert(configActivityStatus).values({
    client,
    activityCode: 'CFG.ORG.COMPANYCODE.DEFINE',
    status: 'COMPLETED',
    completedAt: new Date(),
    completedBy: TEST_ACTOR,
    createdBy: TEST_ACTOR,
  }).onConflictDoUpdate({
    target: [configActivityStatus.client, configActivityStatus.activityCode],
    set: { status: 'COMPLETED', completedAt: new Date(), completedBy: TEST_ACTOR },
  }));
}

/**
 * The workbench row for the activity itself. Completing an activity updates a row rather
 * than inventing one, and a fixture tenant is created after the seed runs, so without
 * this the service would have nothing to mark and the assertion below would prove nothing.
 */
async function startActivity(client: string) {
  await withTenant(client, (tx) => tx.insert(configActivityStatus).values({
    client,
    activityCode: ACTIVITY,
    status: 'NOT_STARTED',
    createdBy: TEST_ACTOR,
  }).onConflictDoUpdate({
    target: [configActivityStatus.client, configActivityStatus.activityCode],
    set: { status: 'NOT_STARTED' },
  }));
}

function creation(overrides: Partial<ToleranceGroupInput> = {}): ToleranceGroupInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    companyCode: COMPANY,
    groupKey: GROUP,
    maxDocumentAmount: '100000.00',
    maxLineAmount: '50000.00',
    maxCashDiscountPercent: '3.000',
    paymentDiffRevenueAmount: '10.00',
    paymentDiffExpenseAmount: '10.00',
    paymentDiffRevenuePercent: '0.5',
    paymentDiffExpensePercent: '0.5',
    reason: REASON,
    ...overrides,
  };
}

async function storedGroup(companyCode = COMPANY, groupKey = GROUP) {
  const { client } = fixture();
  return withTenant(client, async (tx) => {
    const [row] = await tx
      .select()
      .from(employeeToleranceGroup)
      .where(and(
        eq(employeeToleranceGroup.client, client),
        eq(employeeToleranceGroup.companyCode, companyCode),
        eq(employeeToleranceGroup.groupKey, groupKey),
      ));
    return row;
  });
}

function objectKey(companyCode = COMPANY, groupKey = GROUP): string {
  return `${companyCode === '' ? 'ALL' : companyCode}/${groupKey === '' ? 'DEFAULT' : groupKey}`;
}

/** Only the documents this activity filed, under the key the service files on. */
async function groupHistory(companyCode = COMPANY, groupKey = GROUP) {
  const { client } = fixture();
  const documents = await withTenant(client, (tx) =>
    changeHistory(tx, client, 'employee_tolerance_group', objectKey(companyCode, groupKey)));
  return documents.filter((document) => document.transactionCode === ACTIVITY);
}

/* ── Create, change ─────────────────────────────────────────────────────────── */

describe('OBA4 define employee tolerance groups', () => {
  it('starts empty, with the tenant company codes as the scope help', async () => {
    expect(await listEmployeeToleranceGroups(fixture().client)).toEqual([]);
    const companies = await listToleranceCompanies(fixture().client);
    expect(companies.map((company) => company.companyCode)).toContain(COMPANY);
  });

  it('creates the tenant-wide default group, both key parts blank, and completes the activity', async () => {
    const result = await saveEmployeeToleranceGroup(creation({ companyCode: '', groupKey: '' }));
    expect(result).toMatchObject({ changed: true, companyCode: '', groupKey: '' });

    expect(await storedGroup('', '')).toMatchObject({
      maxDocumentAmount: '100000.00', maxLineAmount: '50000.00',
      maxCashDiscountPercent: '3.000', createdBy: TEST_ACTOR,
    });

    const { client } = fixture();
    const status = await withTenant(client, (tx) => tx
      .select()
      .from(configActivityStatus)
      .where(and(
        eq(configActivityStatus.client, client),
        eq(configActivityStatus.activityCode, ACTIVITY),
      )));
    expect(status[0]).toMatchObject({ status: 'COMPLETED', completedBy: TEST_ACTOR });
  });

  it('files one change document under ALL/DEFAULT, every limit security-relevant', async () => {
    const documents = await groupHistory('', '');
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ changeType: 'CREATE', transactionCode: ACTIVITY, reason: REASON });
    const limitItems = documents[0].items.filter((item) => item.fieldName.startsWith('max') || item.fieldName.startsWith('payment'));
    expect(limitItems).toHaveLength(7);
    expect(limitItems.every((item) => item.isSecurityRelevant === 'true')).toBe(true);
  });

  it('refuses to create over a blank key that stands, and to change one that does not', async () => {
    await expect(saveEmployeeToleranceGroup(creation({ companyCode: '', groupKey: '' })))
      .rejects.toThrow(/The default group is already defined for the tenant-wide scope/);
    await expect(saveEmployeeToleranceGroup(creation({ mode: 'CHANGE', groupKey: 'ZZZZ' })))
      .rejects.toThrow(/is not defined for/);
    expect(await groupHistory('', '')).toHaveLength(1);
  });

  it('creates a company group with the optional differences defaulting to zero', async () => {
    const result = await saveEmployeeToleranceGroup(creation({
      paymentDiffRevenueAmount: '', paymentDiffExpenseAmount: '',
      paymentDiffRevenuePercent: '', paymentDiffExpensePercent: '',
    }));
    expect(result.changed).toBe(true);
    expect(await storedGroup()).toMatchObject({
      paymentDiffRevenueAmount: '0.00', paymentDiffExpenseAmount: '0.00',
      paymentDiffRevenuePercent: '0.0', paymentDiffExpensePercent: '0.0',
    });
  });

  it('refuses a company code the tenant does not hold, while the blank scope always stands', async () => {
    const error = await saveEmployeeToleranceGroup(creation({ companyCode: '9999', groupKey: 'TG02' }))
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToleranceGroupError);
    expect((error as ToleranceGroupError).message).toMatch(/Company Code 9999 is not defined in this tenant/);
    expect(await storedGroup('9999', 'TG02')).toBeUndefined();
  });

  it('changes the limits, files both sides, and repeats as a no-op', async () => {
    const changed = await saveEmployeeToleranceGroup(creation({
      mode: 'CHANGE', maxLineAmount: '25000.00', maxCashDiscountPercent: '5.000',
    }));
    expect(changed.changed).toBe(true);
    expect(await storedGroup()).toMatchObject({ maxLineAmount: '25000.00', maxCashDiscountPercent: '5.000' });

    const repeated = await saveEmployeeToleranceGroup(creation({
      mode: 'CHANGE', maxLineAmount: '25000.00', maxCashDiscountPercent: '5.000',
    }));
    expect(repeated.changed).toBe(false);

    const documents = await groupHistory();
    expect(documents).toHaveLength(2);
    const change = documents.find((document) => document.changeType === 'CHANGE');
    expect(change?.items.find((item) => item.fieldName === 'maxLineAmount'))
      .toMatchObject({ oldValue: '50000.00', newValue: '25000.00', isSecurityRelevant: 'true' });
  });

  /* ── The zero rule, in its three shapes ───────────────────────────────────── */

  it('refuses a line ceiling above the document ceiling only when both stand non-zero', async () => {
    await expect(saveEmployeeToleranceGroup(creation({ groupKey: 'Z1', maxLineAmount: '150000.00' })))
      .rejects.toThrow(/exceeds Maximum Amount per Document/);
    expect(await storedGroup(COMPANY, 'Z1')).toBeUndefined();

    // A zero on either side switches that side off (R-88): both of these stand.
    await saveEmployeeToleranceGroup(creation({ groupKey: 'Z1', maxLineAmount: '0.00' }));
    await saveEmployeeToleranceGroup(creation({ groupKey: 'Z2', maxDocumentAmount: '0.00', maxLineAmount: '150000.00' }));
    expect(await storedGroup(COMPANY, 'Z1')).toMatchObject({ maxLineAmount: '0.00' });
    expect(await storedGroup(COMPANY, 'Z2')).toMatchObject({ maxDocumentAmount: '0.00', maxLineAmount: '150000.00' });
  });

  it('stores the 100.000 cash discount ceiling whole, and refuses 100.001', async () => {
    await saveEmployeeToleranceGroup(creation({ groupKey: 'Z3', maxCashDiscountPercent: '100.000' }));
    expect(await storedGroup(COMPANY, 'Z3')).toMatchObject({ maxCashDiscountPercent: '100.000' });

    await expect(saveEmployeeToleranceGroup(creation({ groupKey: 'Z4', maxCashDiscountPercent: '100.001' })))
      .rejects.toThrow(/between 0.000 and 100.000/);
  });

  it('refuses values out of shape at each width, bad keys, and a missing reason', async () => {
    await expect(saveEmployeeToleranceGroup(creation({ groupKey: 'Z5', maxDocumentAmount: '1.234' })))
      .rejects.toThrow(/Maximum Amount per Document is a number/);
    await expect(saveEmployeeToleranceGroup(creation({ groupKey: 'Z5', paymentDiffRevenuePercent: '0.55' })))
      .rejects.toThrow(/Payment Difference Revenue percentage is a number/);
    await expect(saveEmployeeToleranceGroup(creation({ groupKey: 'TOOLONG' })))
      .rejects.toThrow(/Tolerance Group is up to four/);
    await expect(saveEmployeeToleranceGroup(creation({ companyCode: 'TOOLONG', groupKey: 'Z5' })))
      .rejects.toThrow(/Company Code is four letters or digits/);
    await expect(saveEmployeeToleranceGroup(creation({ groupKey: 'Z5', reason: '   ' })))
      .rejects.toThrow(/A reason is required/);
    expect(await storedGroup(COMPANY, 'Z5')).toBeUndefined();
  });

  it('refuses when the Company Code prerequisite is not complete', async () => {
    prerequisiteTenant = await createTenant('scr039-oba4-prerequisites');
    const error = await saveEmployeeToleranceGroup(creation({ client: prerequisiteTenant.client }))
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToleranceGroupError);
    expect((error as ToleranceGroupError).message).toMatch(/prerequisites are incomplete/);
    expect((error as ToleranceGroupError).message).toContain('CFG.ORG.COMPANYCODE.DEFINE');
  });

  it('lists every scope in key order, the tenant-wide scope first', async () => {
    const rows = await listEmployeeToleranceGroups(fixture().client);
    expect(rows.map((row) => `${row.companyCode}|${row.groupKey}`)).toEqual([
      '|', `${COMPANY}|${GROUP}`, `${COMPANY}|Z1`, `${COMPANY}|Z2`, `${COMPANY}|Z3`,
    ]);
  });
});
