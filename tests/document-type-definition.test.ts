/**
 * SCR-038 / OBA7 stage 5 — defining document types, its refusals and its audit trail.
 *
 * The fixture tenant arrives as every tenant does: the standard package has delivered
 * the working set (SA and the rest), all drawing on JOURNAL_ENTRY · GENERAL. The
 * writes under test add keys the package does not hold. What this stage asserts is the
 * owner-settled contract (R-87) at each joint: the key is exactly two characters and
 * immutable, the interval must stand among the intervals defined for its object, the
 * reverse type must stand in the tenant (a type may name itself), the account types
 * are stored in canonical order, deactivation and deletion are both real — deletion
 * refused while journal entries carry the type, exercised by one balanced posted
 * document — and each write files one change document with the money-deciding fields
 * security-relevant and the standing usage count on the after side only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { documentType } from '@/modules/foundation/schema';
import { journalEntry, journalEntryLine } from '@/modules/finance/schema';
import {
  ACTIVITY,
  DocumentTypeError,
  deleteDocumentType,
  listDocumentTypes,
  listIntervalChoices,
  saveDocumentType,
  setDocumentTypeActive,
  type DocumentTypeInput,
} from '@/modules/foundation/document-type-definition';
import { createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR038_STAGE5';
const REASON = 'SCR-038 automated backend test';

const CODE = 'Z1';
const SPARE = 'Z2';
const USED = 'Z3';

let tenant: TestTenant | undefined;
let prerequisiteTenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-038 stage 5 tenant fixture was not initialized.');
  return tenant;
}

beforeAll(async () => {
  tenant = await createTenant('scr038-oba7-stage5');
  const { client } = fixture();

  // The delivered types name JOURNAL_ENTRY · GENERAL; the interval itself is
  // tenant-defined numbering, which the fixture must stand up before any
  // write can be judged against it.
  await defineTestRanges(fixture());
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
    activityCode: 'CFG.PLT.NUMBERRANGE.DEFINE',
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

/**
 * One posted document under the type — a debit and a credit, because the database
 * refuses a document that does not balance, fixture or otherwise. What the deletion
 * rule reads is that a journal entry carries the type.
 */
async function insertJournalEntry(client: string, code: string) {
  await withTenant(client, async (tx) => {
    await tx.insert(journalEntry).values({
      client,
      documentNumber: 'OBA7-1',
      fiscalYear: 2026,
      documentType: code,
      companyCode: '1000',
      documentDate: '2026-06-15',
      postingDate: '2026-06-15',
      postingPeriod: 6,
      documentCurrency: 'KWD',
      localCurrency: 'KWD',
      status: 'POSTED',
      createdBy: TEST_ACTOR,
    });
    for (const [lineNumber, debitCredit] of [[1, 'S'], [2, 'H']] as const) {
      await tx.insert(journalEntryLine).values({
        client,
        documentNumber: 'OBA7-1',
        fiscalYear: 2026,
        lineNumber,
        glAccount: '140000',
        companyCode: '1000',
        debitCredit,
        amountLocal: '15.0000',
        amountDocument: '15.0000',
        currency: 'KWD',
      });
    }
  });
}

function creation(overrides: Partial<DocumentTypeInput> = {}): DocumentTypeInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    documentType: CODE,
    name: 'Fixture posting type',
    numberRangeObject: 'RF_BELEG',
    numberRangeSubObject: 'GENERAL',
    allowedAccountTypes: ['S', 'D'],
    reversalMode: 'REVERSE_AND_ALT_DATE',
    reversalDocumentType: '',
    requiresReference: false,
    requiresLineText: false,
    reason: REASON,
    ...overrides,
  };
}

async function storedType(code = CODE) {
  const { client } = fixture();
  return withTenant(client, async (tx) => {
    const [row] = await tx
      .select()
      .from(documentType)
      .where(and(eq(documentType.client, client), eq(documentType.documentType, code)));
    return row;
  });
}

/** Only the documents this activity filed, under the key the service files on. */
async function typeHistory(code = CODE) {
  const { client } = fixture();
  const documents = await withTenant(client, (tx) => changeHistory(tx, client, 'document_type', code));
  return documents.filter((document) => document.transactionCode === ACTIVITY);
}

/* ── Create, change, lifecycle, delete ──────────────────────────────────────── */

describe('OBA7 define document types', () => {
  it('sees the delivered registry and the intervals it may draw on', async () => {
    const rows = await listDocumentTypes(fixture().client);
    expect(rows.length).toBeGreaterThanOrEqual(11);
    expect(rows.find((row) => row.documentType === 'SA')).toMatchObject({
      numberRangeObject: 'RF_BELEG', numberRangeSubObject: 'GENERAL',
      allowedAccountTypes: 'S', isActive: true, usedByEntries: 0,
    });
    const intervals = await listIntervalChoices(fixture().client);
    expect(intervals).toContainEqual({ objectCode: 'RF_BELEG', subObject: 'GENERAL' });
  });

  it('creates a type, stores its account types in canonical order and completes the activity', async () => {
    const result = await saveDocumentType(creation());
    expect(result).toMatchObject({ changed: true, documentType: CODE, usedByEntries: 0 });

    // Given S then D, the stored letter set reads DS — the canonical ADKMS order,
    // so two screens cannot store the same permission two ways.
    expect(await storedType()).toMatchObject({
      name: 'Fixture posting type', allowedAccountTypes: 'DS', isActive: true, createdBy: TEST_ACTOR,
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

  it('files one change document, account types and interval security-relevant', async () => {
    const documents = await typeHistory();
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ changeType: 'CREATE', transactionCode: ACTIVITY, reason: REASON });
    expect(documents[0].items.find((item) => item.fieldName === 'allowedAccountTypes'))
      .toMatchObject({ newValue: 'DS', isSecurityRelevant: 'true' });
    expect(documents[0].items.find((item) => item.fieldName === 'numberRangeSubObject'))
      .toMatchObject({ newValue: 'GENERAL', isSecurityRelevant: 'true' });
  });

  it('refuses to create over a key that already stands, naming the change', async () => {
    const error = await saveDocumentType(creation()).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(DocumentTypeError);
    expect((error as DocumentTypeError).message).toMatch(/is already defined/);
    expect((error as DocumentTypeError).remedy).toMatch(/Change the document type that exists/);
    expect(await typeHistory()).toHaveLength(1);
  });

  it('refuses to change a key that does not stand, naming the creation', async () => {
    await expect(saveDocumentType(creation({ mode: 'CHANGE', documentType: 'ZZ' })))
      .rejects.toThrow(/is not defined/);
  });

  it('enforces the exactly-two key, one account type at least and a reason', async () => {
    await expect(saveDocumentType(creation({ documentType: 'Z' })))
      .rejects.toThrow(/exactly two letters or digits/);
    await expect(saveDocumentType(creation({ documentType: 'Z12' })))
      .rejects.toThrow(/exactly two letters or digits/);
    await expect(saveDocumentType(creation({ documentType: SPARE, allowedAccountTypes: [] })))
      .rejects.toThrow(/At least one account type/);
    await expect(saveDocumentType(creation({ documentType: SPARE, reason: '   ' })))
      .rejects.toThrow(/A reason is required/);
  });

  it('refuses an interval nobody defined for the object, and a reverse type that does not stand', async () => {
    await expect(saveDocumentType(creation({ documentType: SPARE, numberRangeSubObject: 'NOSUCH' })))
      .rejects.toThrow(/is not defined for object RF_BELEG/);
    await expect(saveDocumentType(creation({ documentType: SPARE, reversalDocumentType: 'ZZ' })))
      .rejects.toThrow(/is not defined in this tenant/);
    expect(await storedType(SPARE)).toBeUndefined();
  });

  it('lets a type name itself as its reverse type', async () => {
    const result = await saveDocumentType(creation({ documentType: SPARE, reversalDocumentType: SPARE }));
    expect(result.changed).toBe(true);
    expect(await storedType(SPARE)).toMatchObject({ reversalDocumentType: SPARE });
    await expect(deleteDocumentType({
      client: fixture().client, changedBy: TEST_ACTOR, documentType: SPARE, reason: REASON,
    })).resolves.toEqual({ deleted: true });
  });

  it('changes everything but the key and the active state, then repeats as a no-op', async () => {
    const changed = await saveDocumentType(creation({
      mode: 'CHANGE', name: 'Fixture posting type, corrected',
      allowedAccountTypes: ['K', 'S'], reversalDocumentType: 'SA', requiresReference: true,
    }));
    expect(changed.changed).toBe(true);
    expect(await storedType()).toMatchObject({
      name: 'Fixture posting type, corrected', allowedAccountTypes: 'KS', reversalDocumentType: 'SA',
      requiresReference: true, isActive: true,
    });

    const repeated = await saveDocumentType(creation({
      mode: 'CHANGE', name: 'Fixture posting type, corrected',
      allowedAccountTypes: ['K', 'S'], reversalDocumentType: 'SA', requiresReference: true,
    }));
    expect(repeated.changed).toBe(false);
    expect(await typeHistory()).toHaveLength(2);
  });

  /* ── Deactivate and reactivate ────────────────────────────────────────────── */

  it('deactivates, repeats as a no-op, and reactivates — each real move documented', async () => {
    const off = await setDocumentTypeActive({
      client: fixture().client, changedBy: TEST_ACTOR, documentType: CODE, active: false, reason: REASON,
    });
    expect(off.changed).toBe(true);
    expect(await storedType()).toMatchObject({ isActive: false });

    const repeated = await setDocumentTypeActive({
      client: fixture().client, changedBy: TEST_ACTOR, documentType: CODE, active: false, reason: REASON,
    });
    expect(repeated.changed).toBe(false);

    const on = await setDocumentTypeActive({
      client: fixture().client, changedBy: TEST_ACTOR, documentType: CODE, active: true, reason: REASON,
    });
    expect(on.changed).toBe(true);
    expect(await storedType()).toMatchObject({ isActive: true });

    // CREATE, CHANGE, deactivate, reactivate: four documents, no-op filed none.
    const documents = await typeHistory();
    expect(documents).toHaveLength(4);
    expect(documents.filter((document) => document.items.some(
      (item) => item.fieldName === 'isActive' && item.isSecurityRelevant === 'true',
    ))).toHaveLength(2);
  });

  it('refuses the state change for a type that does not stand', async () => {
    await expect(setDocumentTypeActive({
      client: fixture().client, changedBy: TEST_ACTOR, documentType: 'ZZ', active: false, reason: REASON,
    })).rejects.toThrow(/is not defined/);
  });

  /* ── Usage and deletion ─────────────────────────────────────────────────── */

  it('refuses to delete a type journal entries carry, and counts them tenant-wide', async () => {
    await saveDocumentType(creation({ documentType: USED, name: 'Fixture used type' }));
    await insertJournalEntry(fixture().client, USED);

    const rows = await listDocumentTypes(fixture().client);
    expect(rows.find((row) => row.documentType === USED)).toMatchObject({ usedByEntries: 1 });
    expect(rows.find((row) => row.documentType === CODE)).toMatchObject({ usedByEntries: 0 });

    const error = await deleteDocumentType({
      client: fixture().client, changedBy: TEST_ACTOR, documentType: USED, reason: REASON,
    }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(DocumentTypeError);
    expect((error as DocumentTypeError).message).toMatch(/carried by 1 journal entr\(ies\) and cannot be deleted/);
    expect((error as DocumentTypeError).remedy).toMatch(/deactivate it/);
    expect(await storedType(USED)).toBeDefined();
  });

  it('deletes an unused type, files what was removed, and refuses a second deletion', async () => {
    await expect(deleteDocumentType({
      client: fixture().client, changedBy: TEST_ACTOR, documentType: CODE, reason: REASON,
    })).resolves.toEqual({ deleted: true });
    expect(await storedType()).toBeUndefined();

    const documents = await typeHistory();
    const deletion = documents.find((document) => document.changeType === 'DELETE');
    expect(deletion?.items.find((item) => item.fieldName === 'name'))
      .toMatchObject({ oldValue: 'Fixture posting type, corrected', newValue: null });

    await expect(deleteDocumentType({
      client: fixture().client, changedBy: TEST_ACTOR, documentType: CODE, reason: REASON,
    })).rejects.toThrow(/is not defined/);
  });

  it('refuses when the number-range prerequisite is not complete', async () => {
    prerequisiteTenant = await createTenant('scr038-oba7-prerequisites');
    const error = await saveDocumentType(creation({ client: prerequisiteTenant.client }))
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(DocumentTypeError);
    expect((error as DocumentTypeError).message).toMatch(/prerequisites are incomplete/);
    expect((error as DocumentTypeError).message).toContain('CFG.PLT.NUMBERRANGE.DEFINE');
  });
});
