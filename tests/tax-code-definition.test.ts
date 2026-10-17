/**
 * SCR-035 / FTXP stage 5 — defining tax codes, its refusals and its audit trail.
 *
 * One tenant, codes written only through the service, and two journal lines inserted
 * header-and-line so a code can be *used*: deletion in this SCR turns on that usage,
 * and the count is tenant-wide for the code because journal lines store no country —
 * a property the tests assert rather than assume, by posting the line under a
 * different company than the code's country would suggest and watching the deletion
 * of a same-named code under another country refuse as well.
 *
 * The tests read the row and the change document after every write, because the point
 * of this activity is not that a row appears — it is that the rate a posting
 * determines at is stated, guarded while it changes, and remains readable after
 * history has named it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { taxCode } from '@/modules/foundation/schema';
import { journalEntry, journalEntryLine } from '@/modules/finance/schema';
import {
  deleteTaxCode,
  TaxCodeError,
  listTaxCodes,
  saveTaxCode,
  type TaxCodeDeleteInput,
  type TaxCodeInput,
} from '@/modules/foundation/tax-code-definition';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR035_STAGE5';
const REASON = 'SCR-035 automated backend test';

const ACTIVITY = 'CFG.FIN.TAXCODE.DEFINE';
const COUNTRY = 'KW';
const OTHER_COUNTRY = 'AE';
const CODE = 'V1';
const USED = 'A1';

let tenant: TestTenant | undefined;
let prerequisiteTenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-035 stage 5 tenant fixture was not initialized.');
  return tenant;
}

beforeAll(async () => {
  tenant = await createTenant('scr035-ftxp-stage5');
  const { client } = fixture();

  await completePrerequisite(client);
  await startActivity(client);
  await insertJournalLines(client);
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

/**
 * Two lines carrying the USED code on one posted document. Header and lines, the way a
 * posting writes them — balanced, because the database refuses a document that is
 * not, fixture or otherwise.
 */
async function insertJournalLines(client: string) {
  await withTenant(client, async (tx) => {
    await tx.insert(journalEntry).values({
      client,
      documentNumber: 'FTXP-1',
      fiscalYear: 2026,
      documentType: 'SA',
      companyCode: '1000',
      documentDate: '2026-06-15',
      postingDate: '2026-06-15',
      postingPeriod: 6,
      documentCurrency: 'KWD',
      localCurrency: 'KWD',
      status: 'POSTED',
      createdBy: TEST_ACTOR,
    });
    // One debit and one credit: the database asserts a document balances, and a
    // fixture that posted two debits would be refused for its arithmetic.
    for (const [lineNumber, debitCredit] of [[1, 'S'], [2, 'H']] as const) {
      await tx.insert(journalEntryLine).values({
        client,
        documentNumber: 'FTXP-1',
        fiscalYear: 2026,
        lineNumber,
        glAccount: '140000',
        companyCode: '1000',
        debitCredit,
        amountLocal: '15.0000',
        amountDocument: '15.0000',
        currency: 'KWD',
        taxCode: USED,
      });
    }
  });
}

function creation(overrides: Partial<TaxCodeInput> = {}): TaxCodeInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    country: COUNTRY,
    taxCode: CODE,
    name: 'Standard input tax',
    taxType: 'VST',
    ratePercent: '5.00',
    accountKey: 'NVV',
    expectedRate: '',
    reason: REASON,
    ...overrides,
  };
}

async function storedCode(country = COUNTRY, code = CODE) {
  const { client } = fixture();
  return withTenant(client, async (tx) => {
    const [row] = await tx
      .select()
      .from(taxCode)
      .where(and(
        eq(taxCode.client, client),
        eq(taxCode.country, country),
        eq(taxCode.taxCode, code),
      ));
    return row;
  });
}

/** Only the documents this activity filed, under the composite key the service files on. */
async function codeHistory(country = COUNTRY, code = CODE) {
  const { client } = fixture();
  const documents = await withTenant(client, (tx) => changeHistory(tx, client, 'tax_code', `${country}/${code}`));
  return documents.filter((document) => document.transactionCode === ACTIVITY);
}

/* ── Create, change, delete ─────────────────────────────────────────────────── */

describe('FTXP define tax codes', () => {
  it('creates a code and marks the activity complete against the actor', async () => {
    const result = await saveTaxCode(creation());
    expect(result).toMatchObject({ changed: true, ratePercent: '5.00', usedByLines: 0 });

    const stored = await storedCode();
    expect(stored).toMatchObject({
      name: 'Standard input tax', taxType: 'VST', ratePercent: '5.00', accountKey: 'NVV', createdBy: TEST_ACTOR,
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

  it('files one change document, with the rate flagged security-relevant', async () => {
    const documents = await codeHistory();
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ changeType: 'CREATE', transactionCode: ACTIVITY, reason: REASON });

    const rateItem = documents[0].items.find((item) => item.fieldName === 'ratePercent');
    expect(rateItem).toMatchObject({ oldValue: null, newValue: '5.00', isSecurityRelevant: 'true' });
  });

  it('refuses to create over a key that already stands, naming the change', async () => {
    const error = await saveTaxCode(creation()).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaxCodeError);
    expect((error as TaxCodeError).message).toMatch(/is already defined for/);
    expect((error as TaxCodeError).remedy).toMatch(/Change the tax code that exists/);
    expect(await codeHistory()).toHaveLength(1);
  });

  it('lets the same code stand under another country, because the country is half the key', async () => {
    await saveTaxCode(creation({ country: OTHER_COUNTRY, name: 'Emirates input tax' }));
    expect(await storedCode(OTHER_COUNTRY)).toMatchObject({ name: 'Emirates input tax' });
  });

  it('refuses to change a key that does not stand, naming the creation', async () => {
    await expect(saveTaxCode(creation({ mode: 'CHANGE', taxCode: 'ZZ', expectedRate: '5.00' })))
      .rejects.toThrow(/is not defined for/);
  });

  it('changes the rate and files both sides', async () => {
    const result = await saveTaxCode(creation({
      mode: 'CHANGE', ratePercent: '7.50', expectedRate: '5.00', accountKey: '',
    }));
    expect(result).toMatchObject({ changed: true, ratePercent: '7.50' });
    expect(await storedCode()).toMatchObject({ ratePercent: '7.50', accountKey: null });

    const documents = await codeHistory();
    expect(documents).toHaveLength(2);
    const change = documents.find((document) => document.changeType === 'CHANGE');
    expect(change?.items.find((item) => item.fieldName === 'ratePercent'))
      .toMatchObject({ oldValue: '5.00', newValue: '7.50' });
  });

  it('reports a repeated change and writes nothing', async () => {
    const result = await saveTaxCode(creation({
      mode: 'CHANGE', ratePercent: '7.50', expectedRate: '7.50', accountKey: '',
    }));
    expect(result.changed).toBe(false);
    expect(await codeHistory()).toHaveLength(2);
  });

  it('refuses a change opened against a rate that has moved on', async () => {
    await expect(saveTaxCode(creation({
      mode: 'CHANGE', ratePercent: '9.00', expectedRate: '5.00',
    }))).rejects.toThrow(/changed after it was opened/);
    expect(await storedCode()).toMatchObject({ ratePercent: '7.50' });
    expect(await codeHistory()).toHaveLength(2);
  });

  /* ── Refusals ───────────────────────────────────────────────────────────── */

  it('refuses a country the master does not hold', async () => {
    await expect(saveTaxCode(creation({ country: 'XX' })))
      .rejects.toThrow(/is not defined in the country master/);
  });

  it('needs a rate within bounds, a short description, codes in shape, a reason and a real tenant', async () => {
    await expect(saveTaxCode(creation({ ratePercent: '100.01' })))
      .rejects.toThrow(/at most 100/);
    await expect(saveTaxCode(creation({ ratePercent: '5.001' })))
      .rejects.toThrow(/two fractional digits/);
    await expect(saveTaxCode(creation({ name: 'x'.repeat(51) })))
      .rejects.toThrow(/at most fifty characters/);
    await expect(saveTaxCode(creation({ taxCode: 'TOOLONG' })))
      .rejects.toThrow(/up to four letters or digits/);
    await expect(saveTaxCode(creation({ reason: '   ' })))
      .rejects.toThrow(/A reason is required/);
    await expect(saveTaxCode(creation({ client: '!!' })))
      .rejects.toThrow(TaxCodeError);
  });

  it('refuses when the Company Code prerequisite is not complete', async () => {
    prerequisiteTenant = await createTenant('scr035-ftxp-prerequisites');
    const error = await saveTaxCode(creation({ client: prerequisiteTenant.client }))
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(TaxCodeError);
    expect((error as TaxCodeError).message).toMatch(/prerequisites are incomplete/);
    expect((error as TaxCodeError).message).toContain('CFG.ORG.COMPANYCODE.DEFINE');
  });

  /* ── Usage and deletion ─────────────────────────────────────────────────── */

  it('counts the lines carrying a code, tenant-wide, and states it beside the code', async () => {
    await saveTaxCode(creation({ taxCode: USED, name: 'Standard output tax', taxType: 'MWS', ratePercent: '5.00' }));

    const rows = await listTaxCodes(fixture().client);
    expect(rows.find((row) => row.taxCode === USED && row.country === COUNTRY))
      .toMatchObject({ usedByLines: 2 });
    expect(rows.find((row) => row.taxCode === CODE && row.country === COUNTRY))
      .toMatchObject({ usedByLines: 0 });
  });

  it('refuses to delete a used code — under either country, because lines store none', async () => {
    const request = (country: string): TaxCodeDeleteInput => ({
      client: fixture().client,
      changedBy: TEST_ACTOR,
      country,
      taxCode: USED,
      reason: REASON,
    });

    const error = await deleteTaxCode(request(COUNTRY)).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaxCodeError);
    expect((error as TaxCodeError).message).toMatch(/posted on 2 journal line\(s\) and cannot be deleted/);

    // The same code defined under the other country is protected by the same lines:
    // a line names the code, not the country, so neither definition may vanish.
    await saveTaxCode(creation({ country: OTHER_COUNTRY, taxCode: USED, name: 'Emirates output tax', taxType: 'MWS' }));
    await expect(deleteTaxCode(request(OTHER_COUNTRY))).rejects.toThrow(/cannot be deleted/);

    expect(await storedCode(COUNTRY, USED)).toBeDefined();
    expect(await codeHistory(COUNTRY, USED)).toHaveLength(1);
  });

  it('deletes an unused code, files what was removed, and refuses a second deletion', async () => {
    const request: TaxCodeDeleteInput = {
      client: fixture().client,
      changedBy: TEST_ACTOR,
      country: OTHER_COUNTRY,
      taxCode: CODE,
      reason: REASON,
    };

    await expect(deleteTaxCode(request)).resolves.toEqual({ deleted: true });
    expect(await storedCode(OTHER_COUNTRY)).toBeUndefined();

    const documents = await codeHistory(OTHER_COUNTRY);
    // CREATE (the second-country code) and DELETE; this tenant's KW code is untouched.
    expect(documents).toHaveLength(2);
    const deletion = documents.find((document) => document.changeType === 'DELETE');
    expect(deletion?.items.find((item) => item.fieldName === 'ratePercent'))
      .toMatchObject({ oldValue: '5.00', newValue: null });

    await expect(deleteTaxCode(request)).rejects.toThrow(/is not defined for/);
  });
});
