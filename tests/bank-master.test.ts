/**
 * SCR-036 stage 5 — maintaining the global bank master, and its audit shape.
 *
 * Banks are global: one row per bank for every tenant. So these tests write
 * through the service under one tenant's context, assert the row as the
 * database holds it — actor columns, because change history files per tenant
 * and a global row has none to file under (R-86) — and then read the same bank
 * back under a second tenant, because "global" is a property to assert, not
 * to assume. Every bank created here is deleted again by the end: the master
 * is shared with the development tenant and ships empty (D-058), and a test
 * that leaves banks behind has changed the product it was testing.
 *
 * The deletion guard counts house banks across every tenant through the
 * information schema, because the house-bank table arrives with SCR-037. In
 * this commit there is nothing that can name a bank, so the guard is asserted
 * in the only state it can honestly be in: a bank nobody names deletes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { closeDb, withTenant } from '@/platform/db/client';
import { bankMaster } from '@/platform/tables/reference';
import {
  BankMasterError,
  deleteBank,
  listBanks,
  saveBank,
  type BankDeleteInput,
  type BankInput,
} from '@/modules/foundation/bank-master';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR036_STAGE5';
const COUNTRY = 'KW';
const KEY = 'SCR36A';
const OTHER_KEY = 'SCR36B';

let tenant: TestTenant | undefined;
let otherTenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-036 stage 5 tenant fixture was not initialized.');
  return tenant;
}

beforeAll(async () => {
  tenant = await createTenant('scr036-banks-stage5');
});

afterAll(async () => {
  // The master is global and shared: a failure above must not leave test banks
  // behind in it, whatever the tests themselves managed to assert.
  if (tenant) {
    await withTenant(tenant.client, (tx) => tx
      .delete(bankMaster)
      .where(and(
        eq(bankMaster.bankCountry, COUNTRY),
        inArray(bankMaster.bankKey, [KEY, OTHER_KEY]),
      )));
  }
  if (otherTenant) await destroyTenant(otherTenant.client);
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

function creation(overrides: Partial<BankInput> = {}): BankInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    bankCountry: COUNTRY,
    bankKey: KEY,
    name: 'National Bank of Kuwait',
    city: 'Kuwait City',
    swift: 'NBOKKWKW',
    ...overrides,
  };
}

async function storedBank(client: string, bankKey: string = KEY) {
  return withTenant(client, async (tx) => {
    const [row] = await tx
      .select()
      .from(bankMaster)
      .where(and(eq(bankMaster.bankCountry, COUNTRY), eq(bankMaster.bankKey, bankKey)));
    return row;
  });
}

describe('bank master maintenance', () => {
  it('creates a bank and stamps the actor, with no change made yet', async () => {
    const result = await saveBank(creation());
    expect(result).toMatchObject({ changed: true, bankCountry: COUNTRY, bankKey: KEY });

    const stored = await storedBank(fixture().client);
    expect(stored).toMatchObject({
      name: 'National Bank of Kuwait', city: 'Kuwait City', swift: 'NBOKKWKW', createdBy: TEST_ACTOR,
    });
    expect(stored.changedBy).toBeNull();
    expect(stored.changedAt).toBeNull();
  });

  it('refuses to create over a key that already stands, naming the change', async () => {
    const error = await saveBank(creation()).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(BankMasterError);
    expect((error as BankMasterError).message).toMatch(/is already defined for/);
    expect((error as BankMasterError).remedy).toMatch(/Change the bank that exists/);
  });

  it('refuses to change a key that does not stand, naming the creation', async () => {
    await expect(saveBank(creation({ mode: 'CHANGE', bankKey: OTHER_KEY })))
      .rejects.toThrow(/is not defined for/);
  });

  it('changes the name and SWIFT, clears the optional fields, and stamps the changer', async () => {
    const result = await saveBank(creation({
      mode: 'CHANGE',
      name: 'Kuwait Finance House',
      city: '',
      swift: 'KFHOKWKWXXX',
    }));
    expect(result.changed).toBe(true);

    const stored = await storedBank(fixture().client);
    expect(stored).toMatchObject({ name: 'Kuwait Finance House', city: null, swift: 'KFHOKWKWXXX' });
    expect(stored.changedBy).toBe(TEST_ACTOR);
    expect(stored.changedAt).not.toBeNull();
  });

  it('reports a repeated change and writes nothing — not even the actor columns', async () => {
    const before = await storedBank(fixture().client);
    const result = await saveBank(creation({
      mode: 'CHANGE',
      changedBy: 'SOMEONE_ELSE',
      name: 'Kuwait Finance House',
      city: '',
      swift: 'KFHOKWKWXXX',
    }));
    expect(result.changed).toBe(false);

    const after = await storedBank(fixture().client);
    expect(after.changedBy).toBe(TEST_ACTOR);
    expect(after.changedAt?.getTime()).toBe(before.changedAt?.getTime());
  });

  it('reads the same bank under another tenant, because the master is global', async () => {
    otherTenant = await createTenant('scr036-banks-global');
    const rows = await listBanks(otherTenant.client);
    expect(rows.find((row) => row.bankKey === KEY)).toMatchObject({
      bankCountry: COUNTRY, name: 'Kuwait Finance House',
    });
  });

  it('refuses a country the master does not hold', async () => {
    await expect(saveBank(creation({ bankCountry: 'XX', bankKey: OTHER_KEY })))
      .rejects.toThrow(/is not defined in the country master/);
  });

  it('needs a bank key in shape, a name that fits, and a SWIFT that is a BIC', async () => {
    await expect(saveBank(creation({ bankKey: 'WAY-TOO-LONG-KEY-1' })))
      .rejects.toThrow(/up to fifteen letters or digits/);
    await expect(saveBank(creation({ bankKey: OTHER_KEY, name: 'x'.repeat(61) })))
      .rejects.toThrow(/at most sixty characters/);
    await expect(saveBank(creation({ bankKey: OTHER_KEY, swift: 'NBOKKWKWX' })))
      .rejects.toThrow(/eight or eleven characters/);
    await expect(saveBank(creation({ client: '!!' })))
      .rejects.toThrow(BankMasterError);
  });

  it('normalizes a lowercase SWIFT and key the way the codes are normalized', async () => {
    await saveBank(creation({ bankKey: OTHER_KEY.toLowerCase(), swift: 'nbokkwkw' }));
    const stored = await storedBank(fixture().client, OTHER_KEY);
    expect(stored).toMatchObject({ bankKey: OTHER_KEY, swift: 'NBOKKWKW' });
    await deleteBank({
      client: fixture().client, changedBy: TEST_ACTOR, bankCountry: COUNTRY, bankKey: OTHER_KEY,
    });
  });

  it('deletes a bank nobody names, and refuses a second deletion', async () => {
    const request: BankDeleteInput = {
      client: fixture().client,
      changedBy: TEST_ACTOR,
      bankCountry: COUNTRY,
      bankKey: KEY,
    };

    await expect(deleteBank(request)).resolves.toEqual({ deleted: true });
    expect(await storedBank(fixture().client)).toBeUndefined();
    await expect(deleteBank(request)).rejects.toThrow(/is not defined for/);
  });

  it('leaves the master as it found it: empty', async () => {
    const rows = await listBanks(fixture().client);
    expect(rows.filter((row) => row.bankKey.startsWith('SCR36'))).toHaveLength(0);
  });
});
