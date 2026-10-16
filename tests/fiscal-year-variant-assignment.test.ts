/**
 * SCR-030 / OB37 stage 5 — the fiscal year variant assignment, its refusals and its audit trail.
 *
 * One tenant with the standard package's own Company Code, which holds the seeded variant and is
 * linked to a Controlling Area, beside two Company Codes built here: one with no variant and no
 * Controlling Area, which is the only shape a successful reassignment can happen in, and one
 * carrying journal entries in three statuses so the exposure the change creates can be counted
 * rather than assumed.
 *
 * The tests read the row and the change document after every write, because the point of this
 * activity is not that a column changes — it is that the calendar a book posts in changes, that
 * the Controlling Area it belongs to still agrees, and that an auditor can see afterwards how
 * many documents were already on the other side of the line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { companyCode } from '@/modules/foundation/schema';
import { journalEntry } from '@/modules/finance/schema';
import { defineCompanyCode } from '@/modules/foundation/company-code-definition';
import {
  saveFiscalYearVariant,
  setFiscalYearVariantActive,
} from '@/modules/foundation/fiscal-year-variant-maintenance';
import {
  assignFiscalYearVariant,
  FiscalYearVariantAssignmentError,
  type FiscalYearVariantAssignmentInput,
} from '@/modules/foundation/fiscal-year-variant-assignment';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR030_STAGE5';
const REASON = 'SCR-030 automated backend test';

/** The standard package's Company Code: holds K4 and is linked to Controlling Area A000. */
const SEEDED_CODE = '1000';
const SEEDED_VARIANT = 'K4';
const AREA = 'A000';
const ASSIGNMENT_ACTIVITY = 'CFG.FIN.FYV.ASSIGN';
/** Built here, no variant, no Controlling Area — the shape a reassignment can succeed in. */
const OPEN_CODE = '2000';
/** Built here and given journal entries in three statuses. */
const POSTED_CODE = '3000';
/** Built here as an assignment target. */
const TARGET = 'V4';
/** Built here, then retired, so an assignment can be refused for a variant that exists. */
const RETIRED = 'V9';

let tenant: TestTenant | undefined;
let prerequisiteTenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-030 stage 5 tenant fixture was not initialized.');
  return tenant;
}

beforeAll(async () => {
  tenant = await createTenant('scr030-ob37-stage5');
  const { client } = fixture();

  await completePrerequisites(client);
  await startAssignmentActivity(client);

  await saveFiscalYearVariant({
    client, changedBy: TEST_ACTOR, mode: 'CREATE', expectedVersion: 0,
    variant: TARGET, name: 'Calendar year, four adjustment',
    isCalendarYear: true, regularPeriods: 12, specialPeriods: 4,
    isYearDependent: false, reason: REASON,
  });
  await saveFiscalYearVariant({
    client, changedBy: TEST_ACTOR, mode: 'CREATE', expectedVersion: 0,
    variant: RETIRED, name: 'Retired before assignment',
    isCalendarYear: false, regularPeriods: 12, specialPeriods: 0,
    isYearDependent: false, reason: REASON,
  });
  await setFiscalYearVariantActive({
    client, changedBy: TEST_ACTOR, variant: RETIRED, isActive: false,
    expectedVersion: 1, reason: REASON,
  });

  for (const [code, name] of [[OPEN_CODE, 'OB37 open company'], [POSTED_CODE, 'OB37 posted company']] as const) {
    await defineCompanyCode({
      client, changedBy: TEST_ACTOR, companyCode: code, name, country: 'KW', currency: 'USD',
    });
  }

  await insertJournalEntries(client);
});

afterAll(async () => {
  if (prerequisiteTenant) await destroyTenant(prerequisiteTenant.client);
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

/* ── Helpers ────────────────────────────────────────────────────────────────── */

/**
 * The two workbench rows the service insists on. A fixture tenant is created after the seed
 * runs, so it has no activity status at all, and the service would refuse every assignment for
 * a reason that has nothing to do with the assignment.
 */
async function completePrerequisites(client: string) {
  for (const activityCode of ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.FIN.FYV.DEFINE']) {
    await withTenant(client, (tx) => tx.insert(configActivityStatus).values({
      client,
      activityCode,
      status: 'COMPLETED',
      completedAt: new Date(),
      completedBy: TEST_ACTOR,
      createdBy: TEST_ACTOR,
    }).onConflictDoUpdate({
      target: [configActivityStatus.client, configActivityStatus.activityCode],
      set: { status: 'COMPLETED', completedAt: new Date(), completedBy: TEST_ACTOR },
    }));
  }
}

/**
 * The workbench row for the activity itself. Completing an activity updates a row rather than
 * inventing one, and a fixture tenant is created after the seed runs, so without this the
 * service would have nothing to mark and the assertion below would prove nothing.
 */
async function startAssignmentActivity(client: string) {
  await withTenant(client, (tx) => tx.insert(configActivityStatus).values({
    client,
    activityCode: ASSIGNMENT_ACTIVITY,
    status: 'NOT_STARTED',
    createdBy: TEST_ACTOR,
  }).onConflictDoUpdate({
    target: [configActivityStatus.client, configActivityStatus.activityCode],
    set: { status: 'NOT_STARTED' },
  }));
}

/**
 * Two posted and one reversed document across two fiscal years, and a draft that must not count.
 * Headers only: the balance rule lives on the lines, and nothing here needs a balanced document
 * to prove which statuses the exposure count reads.
 */
async function insertJournalEntries(client: string) {
  const rows = [
    { documentNumber: 'OB37-1', fiscalYear: 2025, status: 'POSTED', postingPeriod: 3 },
    { documentNumber: 'OB37-2', fiscalYear: 2026, status: 'POSTED', postingPeriod: 1 },
    { documentNumber: 'OB37-3', fiscalYear: 2026, status: 'REVERSED', postingPeriod: 2 },
    { documentNumber: 'OB37-4', fiscalYear: 2026, status: 'DRAFT', postingPeriod: 2 },
  ];
  await withTenant(client, async (tx) => {
    for (const row of rows) {
      await tx.insert(journalEntry).values({
        client,
        documentNumber: row.documentNumber,
        fiscalYear: row.fiscalYear,
        documentType: 'SA',
        companyCode: POSTED_CODE,
        documentDate: `${row.fiscalYear}-06-15`,
        postingDate: `${row.fiscalYear}-06-15`,
        postingPeriod: row.postingPeriod,
        documentCurrency: 'USD',
        localCurrency: 'USD',
        status: row.status,
        createdBy: TEST_ACTOR,
      });
    }
  });
}

function assignment(
  companyCodeKey: string,
  overrides: Partial<FiscalYearVariantAssignmentInput> = {},
): FiscalYearVariantAssignmentInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    companyCode: companyCodeKey,
    fiscalYearVariant: TARGET,
    expectedVariant: '',
    reason: REASON,
    ...overrides,
  };
}

async function storedVariant(companyCodeKey: string) {
  const { client } = fixture();
  return withTenant(client, async (tx) => {
    const [row] = await tx
      .select({
        fiscalYearVariant: companyCode.fiscalYearVariant,
        isActive: companyCode.isActive,
        changedBy: companyCode.changedBy,
      })
      .from(companyCode)
      .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, companyCodeKey)));
    return row;
  });
}

async function setCompanyCodeActive(companyCodeKey: string, isActive: boolean) {
  const { client } = fixture();
  await withTenant(client, (tx) => tx
    .update(companyCode)
    .set({ isActive })
    .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, companyCodeKey))));
}

async function history(objectKey: string) {
  const { client } = fixture();
  return withTenant(client, (tx) => changeHistory(tx, client, 'company_code', objectKey));
}

/**
 * Only the documents this activity filed. A Company Code built here already has a CREATE
 * document under the same object class and key, and counting it would make every assertion
 * about the assignment off by one.
 */
async function assignmentHistory(objectKey: string) {
  const documents = await history(objectKey);
  return documents.filter((document) => document.transactionCode === ASSIGNMENT_ACTIVITY);
}

/* ── The assignment that works ──────────────────────────────────────────────── */

describe('OB37 assign a fiscal year variant', () => {
  it('assigns a variant to a Company Code that has none', async () => {
    const result = await assignFiscalYearVariant(assignment(OPEN_CODE));

    expect(result).toMatchObject({
      assigned: true,
      companyCode: OPEN_CODE,
      fiscalYearVariant: TARGET,
      previousVariant: null,
      postedDocuments: 0,
      controllingAreas: [],
    });

    const stored = await storedVariant(OPEN_CODE);
    expect(stored).toMatchObject({ fiscalYearVariant: TARGET, changedBy: TEST_ACTOR });
  });

  it('files one change document, with the variant flagged security-relevant and the exposure beside it', async () => {
    const documents = await assignmentHistory(OPEN_CODE);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      changeType: 'CHANGE',
      transactionCode: 'CFG.FIN.FYV.ASSIGN',
      reason: REASON,
    });

    const variantItem = documents[0].items.find((item) => item.fieldName === 'fiscalYearVariant');
    expect(variantItem).toMatchObject({ oldValue: null, newValue: TARGET, isSecurityRelevant: 'true' });

    // The exposure is filed on the after side only, because recordChange drops a field whose
    // value did not move — and a figure repeated on both sides never moves.
    expect(documents[0].items.find((item) => item.fieldName === 'postedDocuments')?.newValue).toBe('0');
    expect(documents[0].items.find((item) => item.fieldName === 'postedYears')?.newValue).toBe('none');
  });

  it('marks the assignment activity complete against the actor who did the work', async () => {
    const { client } = fixture();
    const status = await withTenant(client, (tx) => tx
      .select()
      .from(configActivityStatus)
      .where(and(
        eq(configActivityStatus.client, client),
        eq(configActivityStatus.activityCode, ASSIGNMENT_ACTIVITY),
      )));
    expect(status[0]).toMatchObject({ status: 'COMPLETED', completedBy: TEST_ACTOR });
  });

  it('reports a repeated assignment and writes nothing', async () => {
    const result = await assignFiscalYearVariant(assignment(OPEN_CODE, { expectedVariant: TARGET }));
    expect(result).toMatchObject({ assigned: false, previousVariant: TARGET });
    expect(await assignmentHistory(OPEN_CODE)).toHaveLength(1);
  });

  /* ── Refusals ───────────────────────────────────────────────────────────── */

  it('refuses a Company Code whose Controlling Area holds another variant', async () => {
    await expect(assignFiscalYearVariant(assignment(SEEDED_CODE, { expectedVariant: SEEDED_VARIANT })))
      .rejects.toThrow(new RegExp(`Controlling Area ${AREA}`));
    await expect(assignFiscalYearVariant(assignment(SEEDED_CODE, { expectedVariant: SEEDED_VARIANT })))
      .rejects.toThrow(/would not match/);

    expect(await storedVariant(SEEDED_CODE)).toMatchObject({ fiscalYearVariant: SEEDED_VARIANT });
    expect(await assignmentHistory(SEEDED_CODE)).toHaveLength(0);
  });

  it('refuses a variant that is not defined, and one that has been retired', async () => {
    await expect(assignFiscalYearVariant(assignment(OPEN_CODE, {
      fiscalYearVariant: 'ZZ', expectedVariant: TARGET,
    }))).rejects.toThrow(/is not defined in this tenant/);

    await expect(assignFiscalYearVariant(assignment(OPEN_CODE, {
      fiscalYearVariant: RETIRED, expectedVariant: TARGET,
    }))).rejects.toThrow(/is deactivated/);

    expect(await storedVariant(OPEN_CODE)).toMatchObject({ fiscalYearVariant: TARGET });
  });

  it('refuses a Company Code that does not exist, and one that has been deactivated', async () => {
    await expect(assignFiscalYearVariant(assignment('9999')))
      .rejects.toThrow(/does not exist in this tenant/);

    await setCompanyCodeActive(OPEN_CODE, false);
    await expect(assignFiscalYearVariant(assignment(OPEN_CODE, { expectedVariant: TARGET })))
      .rejects.toThrow(/is deactivated/);
    await setCompanyCodeActive(OPEN_CODE, true);

    expect(await storedVariant(OPEN_CODE)).toMatchObject({ fiscalYearVariant: TARGET });
  });

  it('refuses an assignment opened against a variant that has moved on', async () => {
    await expect(assignFiscalYearVariant(assignment(OPEN_CODE, { expectedVariant: SEEDED_VARIANT })))
      .rejects.toThrow(/changed after it was opened/);
    await expect(assignFiscalYearVariant(assignment(OPEN_CODE, { expectedVariant: SEEDED_VARIANT })))
      .rejects.toThrowError(FiscalYearVariantAssignmentError);

    expect(await storedVariant(OPEN_CODE)).toMatchObject({ fiscalYearVariant: TARGET });
    expect(await assignmentHistory(OPEN_CODE)).toHaveLength(1);
  });

  it('needs a reason, a two-character key, and a real tenant', async () => {
    await expect(assignFiscalYearVariant(assignment(OPEN_CODE, { reason: '   ' })))
      .rejects.toThrow(/A reason is required/);
    await expect(assignFiscalYearVariant(assignment(OPEN_CODE, { fiscalYearVariant: 'K44' })))
      .rejects.toThrow(/exactly two letters or digits/);
    await expect(assignFiscalYearVariant(assignment(OPEN_CODE, { client: '!!' })))
      .rejects.toThrow(FiscalYearVariantAssignmentError);
  });

  it('refuses when the workbench prerequisites are not complete', async () => {
    // A second tenant, left exactly as createTenant leaves it: no activity status at all, so
    // neither prerequisite can be shown as complete.
    prerequisiteTenant = await createTenant('scr030-ob37-prerequisites');
    const error = await assignFiscalYearVariant({
      client: prerequisiteTenant.client,
      changedBy: TEST_ACTOR,
      companyCode: '1000',
      fiscalYearVariant: 'K4',
      expectedVariant: '',
      reason: REASON,
    }).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(FiscalYearVariantAssignmentError);
    expect((error as FiscalYearVariantAssignmentError).message).toMatch(/prerequisites are incomplete/);
    expect((error as FiscalYearVariantAssignmentError).message).toContain('CFG.FIN.FYV.DEFINE');
  });
});

/* ── The exposure a posted book creates ─────────────────────────────────────── */

describe('OB37 and the documents already posted', () => {
  it('counts posted and reversed documents, not drafts, and files the years they span', async () => {
    // Lower case in, upper case stored: the key is a code, not a sentence.
    const first = await assignFiscalYearVariant(assignment(POSTED_CODE, { fiscalYearVariant: 'v4' }));
    expect(first).toMatchObject({
      assigned: true,
      fiscalYearVariant: TARGET,
      postedDocuments: 3,
      firstPostedYear: 2025,
      lastPostedYear: 2026,
    });
    expect(await storedVariant(POSTED_CODE)).toMatchObject({ fiscalYearVariant: TARGET });

    // Moving a posted book back to the seeded variant is allowed with a reason, and the change
    // document has to say what was on the other calendar when it happened.
    const second = await assignFiscalYearVariant(assignment(POSTED_CODE, {
      fiscalYearVariant: SEEDED_VARIANT,
      expectedVariant: TARGET,
    }));
    expect(second).toMatchObject({ assigned: true, fiscalYearVariant: SEEDED_VARIANT, postedDocuments: 3 });

    // Newest first, so this is the move back to the seeded variant.
    const documents = await assignmentHistory(POSTED_CODE);
    expect(documents).toHaveLength(2);
    const items = documents[0].items;
    expect(items.find((item) => item.fieldName === 'fiscalYearVariant'))
      .toMatchObject({ oldValue: TARGET, newValue: SEEDED_VARIANT, isSecurityRelevant: 'true' });
    expect(items.find((item) => item.fieldName === 'postedDocuments')?.newValue).toBe('3');
    expect(items.find((item) => item.fieldName === 'postedYears')?.newValue).toBe('2025–2026');
  });
});
