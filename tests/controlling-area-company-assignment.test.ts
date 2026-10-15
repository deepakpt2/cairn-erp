import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { closeDb, withTenant, type TestTenant, createTenant, destroyTenant } from './helpers';
import {
  chartOfAccounts,
  companyCode,
  controllingArea,
  controllingAreaCompany,
  fiscalYearVariant,
} from '@/modules/foundation/schema';
import {
  assignCompanyCodeToControllingArea,
  unassignCompanyCodeFromControllingArea,
} from '@/modules/foundation/controlling-area-company-assignment';
import { saveControllingArea } from '@/modules/foundation/controlling-area-maintenance';
import { defineCompanyCode } from '@/modules/foundation/company-code-definition';
import { upsertCompanyCode } from '@/modules/foundation/services';

const ASSIGNMENT_ACTIVITY = 'CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY';
const ACTOR = 'SCR025_OX19_DB_TEST';

let alpha: TestTenant | undefined;
let beta: TestTenant | undefined;

function primary(): TestTenant {
  if (!alpha) throw new Error('SCR-025 primary tenant fixture was not initialized.');
  return alpha;
}

function secondary(): TestTenant {
  if (!beta) throw new Error('SCR-025 secondary tenant fixture was not initialized.');
  return beta;
}

async function createArea(
  tenant: TestTenant,
  code: string,
  companyCodeScope: 'SINGLE' | 'MULTIPLE',
  currency = 'KWD',
  fiscalYearVariant = 'K4',
) {
  return saveControllingArea({
    client: tenant.client,
    changedBy: ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    controllingArea: code,
    name: `SCR-025 ${code}`,
    organizationName: 'OX19 database fixture',
    companyCodeScope,
    currency,
    fiscalYearVariant,
    reason: 'Disposable SCR-025 database acceptance fixture',
  });
}

async function createCompany(
  tenant: TestTenant,
  code: string,
  settings: { chart?: string; fiscalYearVariant?: string; currency?: string; active?: boolean } = {},
) {
  const chart = settings.chart ?? 'CA01';
  const fiscalYearVariant = settings.fiscalYearVariant ?? 'K4';
  const currency = settings.currency ?? 'KWD';
  await defineCompanyCode({
    client: tenant.client,
    changedBy: ACTOR,
    companyCode: code,
    name: `SCR-025 Company ${code}`,
    country: 'KW',
    currency,
  });
  await upsertCompanyCode({
    client: tenant.client,
    changedBy: ACTOR,
    companyCode: code,
    name: `SCR-025 Company ${code}`,
    chartOfAccounts: chart,
    fiscalYearVariant,
    postingPeriodVariant: 'C001',
    currency,
    country: 'KW',
  });
  if (settings.active === false) {
    await withTenant(tenant.client, (tx) => tx.update(companyCode)
      .set({ isActive: false, changedBy: ACTOR, changedAt: new Date() })
      .where(and(eq(companyCode.client, tenant.client), eq(companyCode.companyCode, code))));
  }
}

async function addAlternateMasters(client: string) {
  await withTenant(client, async (tx) => {
    await tx.insert(chartOfAccounts).values({
      client,
      chartOfAccounts: 'ALT1',
      name: 'SCR-025 alternate operational chart',
      language: 'EN',
      accountNumberLength: 6,
      createdBy: ACTOR,
    }).onConflictDoNothing();
    await tx.insert(fiscalYearVariant).values({
      client,
      variant: 'F2',
      name: 'SCR-025 alternate fiscal year',
      regularPeriods: 12,
      specialPeriods: 4,
      isCalendarYear: false,
      createdBy: ACTOR,
    }).onConflictDoNothing();
  });
}

async function setAreaInactive(client: string, code: string) {
  await withTenant(client, (tx) => tx.update(controllingArea)
    .set({ isActive: false, changedBy: ACTOR, changedAt: new Date() })
    .where(and(
      eq(controllingArea.client, client),
      eq(controllingArea.controllingArea, code),
    )));
}

async function setActivityStatus(
  client: string,
  status: 'NOT_STARTED' | 'COMPLETED',
  activityCode = ASSIGNMENT_ACTIVITY,
) {
  await withTenant(client, async (tx) => {
    await tx.insert(configActivityStatus).values({
      client,
      activityCode,
      status: 'NOT_STARTED',
      createdBy: ACTOR,
    }).onConflictDoNothing();
    await tx.update(configActivityStatus)
      .set({
        status,
        completedAt: status === 'COMPLETED' ? new Date() : null,
        completedBy: status === 'COMPLETED' ? ACTOR : null,
        changedBy: ACTOR,
        changedAt: new Date(),
      })
      .where(and(
        eq(configActivityStatus.client, client),
        eq(configActivityStatus.activityCode, activityCode),
      ));
  });
}

async function readAssignments(client: string, area?: string) {
  return withTenant(client, (tx) => tx.select().from(controllingAreaCompany)
    .where(area
      ? and(eq(controllingAreaCompany.client, client), eq(controllingAreaCompany.controllingArea, area))
      : eq(controllingAreaCompany.client, client)));
}

async function readAssignment(client: string, area: string, code: string) {
  return withTenant(client, async (tx) =>
    (await tx.select().from(controllingAreaCompany).where(and(
      eq(controllingAreaCompany.client, client),
      eq(controllingAreaCompany.controllingArea, area),
      eq(controllingAreaCompany.companyCode, code),
    )))[0] ?? null,
  );
}

async function readHistory(client: string, area: string, code: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, 'controlling_area_company', `${area}/${code}`));
}

async function readActivity(client: string) {
  return withTenant(client, async (tx) =>
    (await tx.select().from(configActivityStatus).where(and(
      eq(configActivityStatus.client, client),
      eq(configActivityStatus.activityCode, ASSIGNMENT_ACTIVITY),
    )))[0] ?? null,
  );
}

async function readArea(client: string, code: string) {
  return withTenant(client, async (tx) =>
    (await tx.select().from(controllingArea).where(and(
      eq(controllingArea.client, client),
      eq(controllingArea.controllingArea, code),
    )))[0] ?? null,
  );
}

async function changeArea(
  tenant: TestTenant,
  code: string,
  patch: Partial<{
    companyCodeScope: 'SINGLE' | 'MULTIPLE';
    currency: string;
    fiscalYearVariant: string;
  }>,
) {
  const current = await readArea(tenant.client, code);
  if (!current) throw new Error(`SCR-025 Controlling Area ${code} is missing.`);
  const history = await withTenant(tenant.client, (tx) =>
    changeHistory(tx, tenant.client, 'controlling_area', code),
  );
  return saveControllingArea({
    client: tenant.client,
    changedBy: ACTOR,
    mode: 'CHANGE',
    expectedVersion: history.length,
    controllingArea: code,
    name: current.name.trim(),
    organizationName: current.organizationName?.trim() ?? '',
    companyCodeScope: patch.companyCodeScope ?? current.companyCodeScope as 'SINGLE' | 'MULTIPLE',
    currency: patch.currency ?? current.currency.trim(),
    fiscalYearVariant: patch.fiscalYearVariant ?? current.fiscalYearVariant.trim(),
    reason: 'Disposable SCR-025 compatibility guard verification',
  });
}

beforeAll(async () => {
  alpha = await createTenant('scr025-ox19-alpha');
  beta = await createTenant('scr025-ox19-beta');
  await addAlternateMasters(primary().client);
  await setActivityStatus(primary().client, 'COMPLETED', 'CFG.ORG.COMPANYCODE.DEFINE');

  await createArea(primary(), 'S210', 'SINGLE');
  await createArea(primary(), 'M210', 'MULTIPLE');
  await createArea(primary(), 'M211', 'MULTIPLE');
  await createArea(primary(), 'M212', 'MULTIPLE');
  await createArea(primary(), 'M213', 'MULTIPLE');
  await createArea(primary(), 'I210', 'MULTIPLE');

  await createCompany(primary(), 'S101', { chart: 'ALT1' });
  await createCompany(primary(), 'S102');
  await createCompany(primary(), 'S103', { chart: 'ALT1', fiscalYearVariant: 'F2' });
  await createCompany(primary(), 'S104', { chart: 'ALT1', currency: 'USD' });
  await createCompany(primary(), 'M101', { chart: 'ALT1' });
  await createCompany(primary(), 'M102', { chart: 'ALT1' });
  await createCompany(primary(), 'M103');
  await createCompany(primary(), 'M104', { chart: 'ALT1', fiscalYearVariant: 'F2' });
  await createCompany(primary(), 'M105', { chart: 'ALT1', currency: 'USD' });
  await createCompany(primary(), 'M106');
  await createCompany(primary(), 'M107', { chart: 'ALT1' });
  await createCompany(primary(), 'I210', { chart: 'ALT1', active: false });
  await createCompany(primary(), 'aBc1', { chart: 'ALT1' });
  await createCompany(primary(), 'RACE', { chart: 'ALT1' });
  await createCompany(secondary(), 'BETA', { chart: 'CA01', currency: 'USD' });
  await setAreaInactive(primary().client, 'I210');
  await setActivityStatus(primary().client, 'NOT_STARTED');
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

describe('SCR-025 / OX19 Company Code assignment on PostgreSQL', () => {
  it('provisions the standard A000 / 1000 link through the OX19 transaction and records its audit event', async () => {
    const tenant = primary();
    expect(await readAssignment(tenant.client, 'A000', '1000')).not.toBeNull();
    const history = await readHistory(tenant.client, 'A000', '1000');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      changeType: 'CREATE',
      changedBy: 'TEST',
      transactionCode: ASSIGNMENT_ACTIVITY,
    });
  });

  it('validates Char 4 keys, uppercases only the Controlling Area, and preserves Company Code case', async () => {
    const tenant = primary();
    await expect(assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'S21', companyCode: 'S101',
    })).rejects.toMatchObject({ name: 'ControllingAreaCompanyAssignmentError' });
    await expect(assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'S210', companyCode: 'S10-',
    })).rejects.toThrow(/Company Code must be four alphanumeric characters/);

    const result = await assignCompanyCodeToControllingArea({
      client: tenant.client,
      changedBy: ACTOR,
      controllingArea: 'm211',
      companyCode: ' aBc1 ',
    });
    expect(result).toMatchObject({
      assigned: true,
      controllingArea: 'M211',
      companyCode: 'aBc1',
      chartOfAccounts: 'ALT1',
      fiscalYearVariant: 'K4',
      currency: 'KWD',
    });
    expect(await readAssignment(tenant.client, 'M211', 'aBc1')).not.toBeNull();
  });

  it('requires tenant-local existing Controlling Area and Company Code masters', async () => {
    const tenant = primary();
    const other = secondary();
    await expect(assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'Z999', companyCode: 'S101',
    })).rejects.toThrow(/Controlling Area Z999 does not exist in this tenant/);
    await expect(assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'S210', companyCode: 'BETA',
    })).rejects.toThrow(/Company Code BETA does not exist in this tenant/);
    await expect(assignCompanyCodeToControllingArea({
      client: other.client, changedBy: ACTOR, controllingArea: 'S210', companyCode: other.companyCode,
    })).rejects.toThrow(/Controlling Area S210 does not exist in this tenant/);
    expect(await readAssignments(tenant.client, 'S210')).toHaveLength(0);
    expect(await readHistory(tenant.client, 'S210', 'S101')).toHaveLength(0);
  });

  it('accepts inactive existing masters while preserving their exact identifiers', async () => {
    const tenant = primary();
    const result = await assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'I210', companyCode: 'I210',
    });
    expect(result).toMatchObject({ assigned: true, controllingArea: 'I210', companyCode: 'I210' });
    const [area, code] = await withTenant(tenant.client, async (tx) => Promise.all([
      tx.select().from(controllingArea).where(and(
        eq(controllingArea.client, tenant.client), eq(controllingArea.controllingArea, 'I210'),
      )),
      tx.select().from(companyCode).where(and(
        eq(companyCode.client, tenant.client), eq(companyCode.companyCode, 'I210'),
      )),
    ]));
    expect(area[0]?.isActive).toBe(false);
    expect(code[0]?.isActive).toBe(false);
    expect(await readAssignment(tenant.client, 'I210', 'I210')).not.toBeNull();
  });

  it('enforces Currency Key and Fiscal Year Variant equality in SINGLE scope and permits only one link', async () => {
    const tenant = primary();
    await expect(assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'S210', companyCode: 'S103',
    })).rejects.toThrow(/Fiscal Year Variant F2 does not match Controlling Area S210 Fiscal Year Variant K4/);
    await expect(assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'S210', companyCode: 'S104',
    })).rejects.toThrow(/local currency USD does not match Controlling Area S210 currency KWD/);

    const first = await assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'S210', companyCode: 'S101',
    });
    expect(first).toMatchObject({ assigned: true, chartOfAccounts: 'ALT1' });
    await expect(assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'S210', companyCode: 'S102',
    })).rejects.toThrow(/configured for Same Company Code and already has a Company Code assignment/);
    expect(await readAssignments(tenant.client, 'S210')).toHaveLength(1);
  });

  it('enforces the multiple-scope CoA baseline plus exact Fiscal Year Variant and Currency Key', async () => {
    const tenant = primary();
    const first = await assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'M210', companyCode: 'M101',
    });
    expect(first).toMatchObject({ assigned: true, chartOfAccounts: 'ALT1' });
    const second = await assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'M210', companyCode: 'M102',
    });
    expect(second).toMatchObject({ assigned: true, chartOfAccounts: 'ALT1' });

    await expect(assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'M210', companyCode: 'M103',
    })).rejects.toThrow(/Operational Chart of Accounts CA01 does not match the current assignment baseline ALT1/);
    await expect(assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'M210', companyCode: 'M104',
    })).rejects.toThrow(/Fiscal Year Variant F2 does not match Controlling Area M210 Fiscal Year Variant K4/);
    await expect(assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'M210', companyCode: 'M105',
    })).rejects.toThrow(/local currency USD does not match Controlling Area M210 currency KWD/);
    expect(await readAssignments(tenant.client, 'M210')).toHaveLength(2);
  });

  it('records duplicate attempts as audited state no-ops and completes the OX19 activity', async () => {
    const tenant = primary();
    const before = await readAssignment(tenant.client, 'M210', 'M101');
    const historyBefore = await readHistory(tenant.client, 'M210', 'M101');
    const result = await assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'M210', companyCode: 'M101',
    });
    expect(result).toMatchObject({ assigned: false, duplicate: true, controllingArea: 'M210', companyCode: 'M101' });
    expect(await readAssignment(tenant.client, 'M210', 'M101')).toMatchObject({
      createdBy: before?.createdBy,
      createdAt: before?.createdAt,
    });
    const historyAfter = await readHistory(tenant.client, 'M210', 'M101');
    expect(historyAfter).toHaveLength(historyBefore.length + 1);
    const duplicate = historyAfter.find((event) => event.items.some((item) => item.newValue === 'DUPLICATE_NO_OP'));
    expect(duplicate).toMatchObject({
      changeType: 'CHANGE',
      transactionCode: ASSIGNMENT_ACTIVITY,
      reason: 'Duplicate assignment requested; the current mapping was unchanged.',
      changedBy: ACTOR,
    });
    expect((await readActivity(tenant.client))?.status).toBe('COMPLETED');
  });

  it('blocks Company Code and OKKP writes that would break current OX19 compatibility', async () => {
    const tenant = primary();
    const updateCompany = (code: string, overrides: Partial<{
      chartOfAccounts: string;
      fiscalYearVariant: string;
      currency: string;
    }>) => upsertCompanyCode({
      client: tenant.client,
      changedBy: ACTOR,
      companyCode: code,
      name: `SCR-025 Company ${code}`,
      chartOfAccounts: overrides.chartOfAccounts ?? 'ALT1',
      fiscalYearVariant: overrides.fiscalYearVariant ?? 'K4',
      postingPeriodVariant: 'C001',
      currency: overrides.currency ?? 'KWD',
      country: 'KW',
    });

    await expect(updateCompany('M101', { chartOfAccounts: 'CA01' }))
      .rejects.toThrow(/would make current assignments for Controlling Area M210 inconsistent/);
    await expect(updateCompany('M101', { fiscalYearVariant: 'F2' }))
      .rejects.toThrow(/Fiscal Year Variant F2 would not match Controlling Area M210/);
    await expect(updateCompany('M101', { currency: 'USD' }))
      .rejects.toThrow(/local currency USD would not match Controlling Area M210 Currency Key KWD/);

    await expect(changeArea(tenant, 'M210', { companyCodeScope: 'SINGLE' }))
      .rejects.toThrow(/cannot use Same Company Code while multiple Company Codes are assigned/);
    await expect(changeArea(tenant, 'M210', { fiscalYearVariant: 'F2' }))
      .rejects.toThrow(/must use Fiscal Year Variant F2/);
    await expect(changeArea(tenant, 'M210', { currency: 'USD' }))
      .rejects.toThrow(/must use Currency Key USD/);

    await expect(updateCompany('S101', { fiscalYearVariant: 'F2' }))
      .rejects.toThrow(/Fiscal Year Variant F2 would not match Controlling Area S210/);
    await expect(updateCompany('S101', { currency: 'USD' }))
      .rejects.toThrow(/local currency USD would not match Controlling Area S210 Currency Key KWD/);
    await expect(changeArea(tenant, 'S210', { fiscalYearVariant: 'F2' }))
      .rejects.toThrow(/must use Fiscal Year Variant F2/);
    await expect(changeArea(tenant, 'S210', { currency: 'USD' }))
      .rejects.toThrow(/must use Currency Key USD/);

    expect(await readAssignment(tenant.client, 'M210', 'M101')).not.toBeNull();
    expect(await readAssignment(tenant.client, 'S210', 'S101')).not.toBeNull();
  });

  it('requires explicit unassignment before reassignment and retains CREATE/DELETE audit history', async () => {
    const tenant = primary();
    const before = await readHistory(tenant.client, 'M210', 'M101');
    await expect(assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'M211', companyCode: 'M101',
    })).rejects.toThrow(/already assigned to Controlling Area M210/);
    expect(await readAssignment(tenant.client, 'M210', 'M101')).not.toBeNull();
    expect(await readHistory(tenant.client, 'M210', 'M101')).toHaveLength(before.length);

    const removed = await unassignCompanyCodeFromControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'M210', companyCode: 'M101',
    });
    expect(removed).toEqual({ unassigned: true, controllingArea: 'M210', companyCode: 'M101' });
    expect(await readAssignment(tenant.client, 'M210', 'M101')).toBeNull();
    const retained = await readHistory(tenant.client, 'M210', 'M101');
    expect(retained).toHaveLength(before.length + 1);
    expect(retained.some((event) => event.changeType === 'CREATE')).toBe(true);
    expect(retained.some((event) => event.changeType === 'DELETE' && event.transactionCode === ASSIGNMENT_ACTIVITY)).toBe(true);

    await expect(unassignCompanyCodeFromControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'M210', companyCode: 'M101',
    })).rejects.toThrow(/is not assigned to Controlling Area M210/);
    const reassigned = await assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'M211', companyCode: 'M101',
    });
    expect(reassigned).toMatchObject({ assigned: true, controllingArea: 'M211', companyCode: 'M101' });
    expect(await readAssignment(tenant.client, 'M211', 'M101')).not.toBeNull();
    expect(await readHistory(tenant.client, 'M211', 'M101')).toHaveLength(1);
  });

  it('derives a fresh CoA baseline from the current assignments after the set becomes empty', async () => {
    const tenant = primary();
    await unassignCompanyCodeFromControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'M210', companyCode: 'M102',
    });
    expect(await readAssignments(tenant.client, 'M210')).toHaveLength(0);

    const first = await assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'M210', companyCode: 'M103',
    });
    expect(first).toMatchObject({ assigned: true, chartOfAccounts: 'CA01' });
    await expect(assignCompanyCodeToControllingArea({
      client: tenant.client, changedBy: ACTOR, controllingArea: 'M210', companyCode: 'M107',
    })).rejects.toThrow(/Operational Chart of Accounts ALT1 does not match the current assignment baseline CA01/);
  });

  it('serializes concurrent attempts so one Company Code cannot acquire two Controlling Areas', async () => {
    const tenant = primary();
    const attempts = await Promise.allSettled([
      assignCompanyCodeToControllingArea({
        client: tenant.client, changedBy: ACTOR, controllingArea: 'M212', companyCode: 'RACE',
      }),
      assignCompanyCodeToControllingArea({
        client: tenant.client, changedBy: ACTOR, controllingArea: 'M213', companyCode: 'RACE',
      }),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const owners = await withTenant(tenant.client, (tx) => tx.select({
      controllingArea: controllingAreaCompany.controllingArea,
      companyCode: controllingAreaCompany.companyCode,
    }).from(controllingAreaCompany).where(and(
      eq(controllingAreaCompany.client, tenant.client),
      eq(controllingAreaCompany.companyCode, 'RACE'),
    )));
    expect(owners).toHaveLength(1);
    const ownerHistory = await readHistory(tenant.client, owners[0]!.controllingArea, 'RACE');
    expect(ownerHistory).toHaveLength(1);
    expect(ownerHistory[0]?.changeType).toBe('CREATE');
  });
});
