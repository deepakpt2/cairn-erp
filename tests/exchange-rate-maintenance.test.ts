/**
 * SCR-034 / OB08 stage 5 — maintaining exchange rates, its refusals and its audit trail.
 *
 * One tenant, rates written only through the service. A rate is reference data with a
 * composite key, so the interesting cases are the shape of that key: creating over a key
 * that stands, changing a key that does not, and the one correction the package allows —
 * the rate and its ratios, guarded on the rate the caller saw.
 *
 * The tests read the row and the change document after every write, because the point of
 * this activity is not that a number changes: it is that the effective rate a pair
 * converts at (rate × ratioTo / ratioFrom) is stated, stored and auditable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { exchangeRate } from '@/modules/foundation/schema';
import {
  deleteExchangeRate,
  ExchangeRateError,
  listExchangeRates,
  saveExchangeRate,
  type ExchangeRateDeleteInput,
  type ExchangeRateInput,
} from '@/modules/foundation/exchange-rate-maintenance';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR034_STAGE5';
const REASON = 'SCR-034 automated backend test';

const ACTIVITY = 'CFG.FIN.EXRATE.MAINTAIN';
const VALID_FROM = '2026-01-01';

let tenant: TestTenant | undefined;
let prerequisiteTenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-034 stage 5 tenant fixture was not initialized.');
  return tenant;
}

beforeAll(async () => {
  tenant = await createTenant('scr034-ob08-stage5');
  const { client } = fixture();

  await completePrerequisite(client);
  await startActivity(client);
  await retireFixtureCurrency(client);
});

afterAll(async () => {
  if (tenant) await restoreFixtureCurrency(fixture().client);
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
 * A retired currency, so the inactive refusal can be asserted. The currency master is
 * global reference data shared by every test file, so the fixture invents a code nobody
 * else uses and removes it again afterwards rather than touching a real currency.
 */
const RETIRED_CURRENCY = 'ZXQ';

async function retireFixtureCurrency(client: string) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into currency (code, name, decimal_places, is_active)
    values (${RETIRED_CURRENCY}, 'Retired fixture currency', 2, false)
    on conflict (code) do update set is_active = false
  `));
}

async function restoreFixtureCurrency(client: string) {
  await withTenant(client, (tx) => tx.execute(sql`
    delete from currency where code = ${RETIRED_CURRENCY}
  `));
}

function creation(overrides: Partial<ExchangeRateInput> = {}): ExchangeRateInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    rateType: 'BUYING',
    fromCurrency: 'USD',
    toCurrency: 'KWD',
    validFrom: VALID_FROM,
    rate: '3.10000000',
    ratioFrom: 1,
    ratioTo: 1,
    expectedRate: '',
    reason: REASON,
    ...overrides,
  };
}

async function storedRate(overrides: Partial<ExchangeRateInput> = {}) {
  const { client } = fixture();
  const key = creation(overrides);
  return withTenant(client, async (tx) => {
    const [row] = await tx
      .select()
      .from(exchangeRate)
      .where(and(
        eq(exchangeRate.client, client),
        eq(exchangeRate.rateType, key.rateType),
        eq(exchangeRate.fromCurrency, key.fromCurrency),
        eq(exchangeRate.toCurrency, key.toCurrency),
        eq(exchangeRate.validFrom, key.validFrom),
      ));
    return row;
  });
}

/** Only the documents this activity filed, under the composite key the service files on. */
async function rateHistory(overrides: Partial<ExchangeRateInput> = {}) {
  const { client } = fixture();
  const key = creation(overrides);
  const objectKey = `${key.rateType}/${key.fromCurrency}/${key.toCurrency}/${key.validFrom}`;
  const documents = await withTenant(client, (tx) => changeHistory(tx, client, 'exchange_rate', objectKey));
  return documents.filter((document) => document.transactionCode === ACTIVITY);
}

/* ── Create, change, delete ─────────────────────────────────────────────────── */

describe('OB08 maintain exchange rates', () => {
  it('creates a rate and marks the activity complete against the actor', async () => {
    const result = await saveExchangeRate(creation());
    expect(result).toMatchObject({ changed: true, rate: '3.10000000' });

    const stored = await storedRate();
    expect(stored).toMatchObject({ rate: '3.10000000', ratioFrom: 1, ratioTo: 1, createdBy: TEST_ACTOR });

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
    const documents = await rateHistory();
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ changeType: 'CREATE', transactionCode: ACTIVITY, reason: REASON });

    const rateItem = documents[0].items.find((item) => item.fieldName === 'rate');
    expect(rateItem).toMatchObject({ oldValue: null, newValue: '3.10000000', isSecurityRelevant: 'true' });
  });

  it('refuses to create over a key that already stands, naming the change', async () => {
    const error = await saveExchangeRate(creation()).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExchangeRateError);
    expect((error as ExchangeRateError).message).toMatch(/is already maintained/);
    expect((error as ExchangeRateError).remedy).toMatch(/Change the rate that exists/);
    expect(await rateHistory()).toHaveLength(1);
  });

  it('refuses to change a key that does not stand, naming the creation', async () => {
    await expect(saveExchangeRate(creation({
      mode: 'CHANGE', rateType: 'SELLING', expectedRate: '1.00000000',
    }))).rejects.toThrow(/is not maintained/);
  });

  it('stores the ratios and reads the effective rate back at full precision', async () => {
    await saveExchangeRate(creation({
      rateType: 'SELLING', fromCurrency: 'EUR', toCurrency: 'USD',
      rate: '110.00000000', ratioFrom: 100, ratioTo: 1,
    }));

    const rows = await listExchangeRates(fixture().client);
    const quoted = rows.find((row) => row.rateType === 'SELLING');
    expect(quoted).toMatchObject({ rate: '110.00000000', ratioFrom: 100, ratioTo: 1 });
    // 110 quoted for 100 units is 1.1 per unit; the database did that arithmetic, not a float.
    expect(quoted?.effectiveRate).toBe('1.10000000');
  });

  it('changes the rate and its ratios, and files both sides', async () => {
    const result = await saveExchangeRate(creation({
      mode: 'CHANGE', rate: '3.20000000', ratioTo: 10, expectedRate: '3.10000000',
    }));
    expect(result).toMatchObject({ changed: true, rate: '3.20000000', ratioTo: 10 });
    expect(await storedRate()).toMatchObject({ rate: '3.20000000', ratioTo: 10 });

    const documents = await rateHistory();
    expect(documents).toHaveLength(2);
    const change = documents.find((document) => document.changeType === 'CHANGE');
    expect(change?.items.find((item) => item.fieldName === 'rate'))
      .toMatchObject({ oldValue: '3.10000000', newValue: '3.20000000' });
  });

  it('reports a repeated change and writes nothing', async () => {
    const result = await saveExchangeRate(creation({
      mode: 'CHANGE', rate: '3.20000000', ratioTo: 10, expectedRate: '3.20000000',
    }));
    expect(result.changed).toBe(false);
    expect(await rateHistory()).toHaveLength(2);
  });

  it('refuses a change opened against a rate that has moved on', async () => {
    await expect(saveExchangeRate(creation({
      mode: 'CHANGE', rate: '3.30000000', expectedRate: '3.10000000',
    }))).rejects.toThrow(/changed after it was opened/);
    expect(await storedRate()).toMatchObject({ rate: '3.20000000' });
    expect(await rateHistory()).toHaveLength(2);
  });

  /* ── Refusals ───────────────────────────────────────────────────────────── */

  it('refuses a pair that translates a currency into itself', async () => {
    await expect(saveExchangeRate(creation({ toCurrency: 'USD' })))
      .rejects.toThrow(/translates nothing/);
  });

  it('refuses currencies the master does not hold, and ones it has retired', async () => {
    await expect(saveExchangeRate(creation({ fromCurrency: 'ZZZ' })))
      .rejects.toThrow(/is not defined in the currency master/);
    await expect(saveExchangeRate(creation({ fromCurrency: RETIRED_CURRENCY })))
      .rejects.toThrow(/is not active in the currency master/);
  });

  it('needs a positive rate, a whole ratio, a known type, a reason and a real tenant', async () => {
    await expect(saveExchangeRate(creation({ rate: '0' })))
      .rejects.toThrow(/greater than zero/);
    await expect(saveExchangeRate(creation({ rate: '1.123456789' })))
      .rejects.toThrow(/eight fractional digits/);
    await expect(saveExchangeRate(creation({ ratioFrom: 0 })))
      .rejects.toThrow(/at least 1/);
    await expect(saveExchangeRate(creation({ rateType: 'WEEKLY' })))
      .rejects.toThrow(/Average, Buying or Selling/);
    await expect(saveExchangeRate(creation({ reason: '   ' })))
      .rejects.toThrow(/A reason is required/);
    await expect(saveExchangeRate(creation({ client: '!!' })))
      .rejects.toThrow(ExchangeRateError);
  });

  it('refuses when the Company Code prerequisite is not complete', async () => {
    prerequisiteTenant = await createTenant('scr034-ob08-prerequisites');
    const error = await saveExchangeRate(creation({ client: prerequisiteTenant.client }))
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExchangeRateError);
    expect((error as ExchangeRateError).message).toMatch(/prerequisites are incomplete/);
    expect((error as ExchangeRateError).message).toContain('CFG.ORG.COMPANYCODE.DEFINE');
  });

  /* ── Deletion ───────────────────────────────────────────────────────────── */

  it('deletes a rate, files what was removed, and refuses a second deletion', async () => {
    const request: ExchangeRateDeleteInput = {
      client: fixture().client,
      changedBy: TEST_ACTOR,
      rateType: 'BUYING',
      fromCurrency: 'USD',
      toCurrency: 'KWD',
      validFrom: VALID_FROM,
      reason: REASON,
    };

    await expect(deleteExchangeRate(request)).resolves.toEqual({ deleted: true });
    expect(await storedRate()).toBeUndefined();

    const documents = await rateHistory();
    expect(documents).toHaveLength(3);
    const deletion = documents.find((document) => document.changeType === 'DELETE');
    expect(deletion?.items.find((item) => item.fieldName === 'rate'))
      .toMatchObject({ oldValue: '3.20000000', newValue: null, isSecurityRelevant: 'true' });

    await expect(deleteExchangeRate(request)).rejects.toThrow(/is not maintained/);
  });
});
