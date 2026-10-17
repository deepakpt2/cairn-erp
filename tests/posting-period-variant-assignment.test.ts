/**
 * SCR-033 / OBBP stage 5 — the posting period variant assignment, its refusals and its audit trail.
 *
 * One tenant, two variants defined here through the OBBO service, and two Company Codes built
 * here: one that has never posted, which is the only shape a clearing can succeed in, and one
 * carrying journal entries, which may move between variants but may not be left unassigned.
 *
 * The tests read the row and the change document after every write, because the point of this
 * activity is not that a column changes — it is that the periods open for everything a Company
 * Code posts next change, and that an auditor can see which variant was held and how many
 * entries already stood against it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { companyCode } from '@/modules/foundation/schema';
import { journalEntry } from '@/modules/finance/schema';
import { defineCompanyCode } from '@/modules/foundation/company-code-definition';
import { savePostingPeriodVariant } from '@/modules/foundation/posting-period-variant-definition';
import {
  assignPostingPeriodVariant,
  PostingPeriodVariantAssignmentError,
  type PostingPeriodVariantAssignmentInput,
} from '@/modules/foundation/posting-period-variant-assignment';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR033_STAGE5';
const REASON = 'SCR-033 automated backend test';

const ASSIGNMENT_ACTIVITY = 'CFG.FIN.PPV.ASSIGN';
const FIRST = 'ZP01';
const SECOND = 'ZP02';
const MISSING = 'ZP99';
/** Built here, no journal entries — the shape a clearing can succeed in. */
const OPEN_CODE = '2000';
/** Built here and given journal entries. */
const POSTED_CODE = '3000';

let tenant: TestTenant | undefined;
let prerequisiteTenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-033 stage 5 tenant fixture was not initialized.');
  return tenant;
}

beforeAll(async () => {
  tenant = await createTenant('scr033-obbp-stage5');
  const { client } = fixture();

  await completePrerequisites(client);
  await startAssignmentActivity(client);

  for (const variant of [FIRST, SECOND]) {
    await savePostingPeriodVariant({
      client, changedBy: TEST_ACTOR, mode: 'CREATE', variant,
      name: `Assignment variant ${variant}`,
    });
  }

  for (const [code, name] of [[OPEN_CODE, 'OBBP open company'], [POSTED_CODE, 'OBBP posted company']] as const) {
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
 * The workbench rows the services insist on. CFG.FIN.FYV.ASSIGN is OBBO's own prerequisite, the
 * other two are this activity's. A fixture tenant is created after the seed runs, so it has no
 * activity status at all, and the service would refuse every assignment for a reason that has
 * nothing to do with the assignment.
 */
async function completePrerequisites(client: string) {
  for (const activityCode of ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.FIN.PPV.DEFINE', 'CFG.FIN.FYV.ASSIGN']) {
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
 * Three entries in three statuses. The clearing rule counts every journal entry under the
 * Company Code — the same measure the screen states — so a draft counts here in a way it does
 * not for OB37's exposure, and the count below says so.
 */
async function insertJournalEntries(client: string) {
  const rows = [
    { documentNumber: 'OBBP-1', status: 'POSTED' },
    { documentNumber: 'OBBP-2', status: 'REVERSED' },
    { documentNumber: 'OBBP-3', status: 'DRAFT' },
  ];
  await withTenant(client, async (tx) => {
    for (const row of rows) {
      await tx.insert(journalEntry).values({
        client,
        documentNumber: row.documentNumber,
        fiscalYear: 2026,
        documentType: 'SA',
        companyCode: POSTED_CODE,
        documentDate: '2026-06-15',
        postingDate: '2026-06-15',
        postingPeriod: 6,
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
  overrides: Partial<PostingPeriodVariantAssignmentInput> = {},
): PostingPeriodVariantAssignmentInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    companyCode: companyCodeKey,
    postingPeriodVariant: FIRST,
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
        postingPeriodVariant: companyCode.postingPeriodVariant,
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

/**
 * Only the documents this activity filed. A Company Code built here already has a CREATE
 * document under the same object class and key, and counting it would make every assertion
 * about the assignment off by one.
 */
async function assignmentHistory(objectKey: string) {
  const { client } = fixture();
  const documents = await withTenant(client, (tx) => changeHistory(tx, client, 'company_code', objectKey));
  return documents.filter((document) => document.transactionCode === ASSIGNMENT_ACTIVITY);
}

/* ── The assignment that works, then the ones that do not ───────────────────── */

describe('OBBP assign a posting period variant', () => {
  it('assigns a variant to a Company Code that has none', async () => {
    const result = await assignPostingPeriodVariant(assignment(OPEN_CODE));

    expect(result).toMatchObject({
      assigned: true,
      companyCode: OPEN_CODE,
      postingPeriodVariant: FIRST,
      previousVariant: null,
      postedDocuments: 0,
    });

    const stored = await storedVariant(OPEN_CODE);
    expect(stored).toMatchObject({ postingPeriodVariant: FIRST, changedBy: TEST_ACTOR });
  });

  it('files one change document, with the variant flagged security-relevant and the count beside it', async () => {
    const documents = await assignmentHistory(OPEN_CODE);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      changeType: 'CHANGE',
      transactionCode: ASSIGNMENT_ACTIVITY,
      reason: REASON,
    });

    const variantItem = documents[0].items.find((item) => item.fieldName === 'postingPeriodVariant');
    expect(variantItem).toMatchObject({ oldValue: null, newValue: FIRST, isSecurityRelevant: 'true' });
    expect(documents[0].items.find((item) => item.fieldName === 'postedDocuments')?.newValue).toBe('0');
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
    const result = await assignPostingPeriodVariant(assignment(OPEN_CODE, { expectedVariant: FIRST }));
    expect(result).toMatchObject({ assigned: false, previousVariant: FIRST });
    expect(await assignmentHistory(OPEN_CODE)).toHaveLength(1);
  });

  it('reassigns to another variant at any time, then clears while nothing has posted', async () => {
    const moved = await assignPostingPeriodVariant(assignment(OPEN_CODE, {
      postingPeriodVariant: 'zp02',
      expectedVariant: FIRST,
    }));
    expect(moved).toMatchObject({ assigned: true, postingPeriodVariant: SECOND, previousVariant: FIRST });

    const cleared = await assignPostingPeriodVariant(assignment(OPEN_CODE, {
      postingPeriodVariant: '',
      expectedVariant: SECOND,
    }));
    expect(cleared).toMatchObject({ assigned: true, postingPeriodVariant: null, previousVariant: SECOND });
    expect(await storedVariant(OPEN_CODE)).toMatchObject({ postingPeriodVariant: null });

    // Clearing an assignment that does not exist is the same state, not an error.
    const repeated = await assignPostingPeriodVariant(assignment(OPEN_CODE, {
      postingPeriodVariant: '',
      expectedVariant: '',
    }));
    expect(repeated).toMatchObject({ assigned: false, postingPeriodVariant: null });
    expect(await assignmentHistory(OPEN_CODE)).toHaveLength(3);
  });

  /* ── Refusals ───────────────────────────────────────────────────────────── */

  it('refuses a variant that is not defined, naming where to define it', async () => {
    const error = await assignPostingPeriodVariant(assignment(OPEN_CODE, {
      postingPeriodVariant: MISSING,
    })).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(PostingPeriodVariantAssignmentError);
    expect((error as PostingPeriodVariantAssignmentError).message).toMatch(/is not defined in this tenant/);
    expect((error as PostingPeriodVariantAssignmentError).remedy).toContain('CFG.FIN.PPV.DEFINE');
    expect(await storedVariant(OPEN_CODE)).toMatchObject({ postingPeriodVariant: null });
  });

  it('refuses a Company Code that does not exist, and one that has been deactivated', async () => {
    await expect(assignPostingPeriodVariant(assignment('9999')))
      .rejects.toThrow(/does not exist in this tenant/);

    await setCompanyCodeActive(OPEN_CODE, false);
    await expect(assignPostingPeriodVariant(assignment(OPEN_CODE)))
      .rejects.toThrow(/is deactivated/);
    await setCompanyCodeActive(OPEN_CODE, true);

    expect(await storedVariant(OPEN_CODE)).toMatchObject({ postingPeriodVariant: null });
  });

  it('refuses an assignment opened against a variant that has moved on', async () => {
    await expect(assignPostingPeriodVariant(assignment(OPEN_CODE, { expectedVariant: FIRST })))
      .rejects.toThrow(/changed after it was opened/);
    await expect(assignPostingPeriodVariant(assignment(OPEN_CODE, { expectedVariant: FIRST })))
      .rejects.toThrowError(PostingPeriodVariantAssignmentError);

    expect(await storedVariant(OPEN_CODE)).toMatchObject({ postingPeriodVariant: null });
    expect(await assignmentHistory(OPEN_CODE)).toHaveLength(3);
  });

  it('needs a reason, a four-character key, and a real tenant', async () => {
    await expect(assignPostingPeriodVariant(assignment(OPEN_CODE, { reason: '   ' })))
      .rejects.toThrow(/A reason is required/);
    await expect(assignPostingPeriodVariant(assignment(OPEN_CODE, { postingPeriodVariant: 'ZP1' })))
      .rejects.toThrow(/exactly four letters or digits/);
    await expect(assignPostingPeriodVariant(assignment(OPEN_CODE, { client: '!!' })))
      .rejects.toThrow(PostingPeriodVariantAssignmentError);
  });

  it('refuses when the workbench prerequisites are not complete', async () => {
    // A second tenant, left exactly as createTenant leaves it: no activity status at all, so
    // neither prerequisite can be shown as complete.
    prerequisiteTenant = await createTenant('scr033-obbp-prerequisites');
    const error = await assignPostingPeriodVariant({
      client: prerequisiteTenant.client,
      changedBy: TEST_ACTOR,
      companyCode: '1000',
      postingPeriodVariant: FIRST,
      expectedVariant: '',
      reason: REASON,
    }).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(PostingPeriodVariantAssignmentError);
    expect((error as PostingPeriodVariantAssignmentError).message).toMatch(/prerequisites are incomplete/);
    expect((error as PostingPeriodVariantAssignmentError).message).toContain('CFG.FIN.PPV.DEFINE');
  });
});

/* ── The book that has already posted ───────────────────────────────────────── */

describe('OBBP and the Company Code that has posted', () => {
  it('assigns and reassigns freely, counting every journal entry', async () => {
    const first = await assignPostingPeriodVariant(assignment(POSTED_CODE));
    expect(first).toMatchObject({ assigned: true, postedDocuments: 3 });

    const moved = await assignPostingPeriodVariant(assignment(POSTED_CODE, {
      postingPeriodVariant: SECOND,
      expectedVariant: FIRST,
    }));
    expect(moved).toMatchObject({ assigned: true, postingPeriodVariant: SECOND, postedDocuments: 3 });
    expect(await storedVariant(POSTED_CODE)).toMatchObject({ postingPeriodVariant: SECOND });
  });

  it('refuses to clear the variant from under the entries already posted', async () => {
    const error = await assignPostingPeriodVariant(assignment(POSTED_CODE, {
      postingPeriodVariant: '',
      expectedVariant: SECOND,
    })).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(PostingPeriodVariantAssignmentError);
    expect((error as PostingPeriodVariantAssignmentError).message).toMatch(/3 journal entries/);
    expect((error as PostingPeriodVariantAssignmentError).message).toMatch(/cannot be left unassigned/);
    expect(await storedVariant(POSTED_CODE)).toMatchObject({ postingPeriodVariant: SECOND });
    expect(await assignmentHistory(POSTED_CODE)).toHaveLength(2);
  });
});
