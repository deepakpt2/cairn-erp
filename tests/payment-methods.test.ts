import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTenant, destroyTenant, withTenant, closeDb, type TestTenant } from './helpers';
import { configActivityStatus, paymentMethod } from '@/platform/schema';
import {
  getPaymentMethod,
  listPaymentMethods,
  PaymentMethodError,
  PaymentMethodReadError,
  retirePaymentMethod,
  savePaymentMethod,
  type PaymentMethodUse,
} from '@/modules/foundation/payment-methods';
import { changeHistory } from '@/platform/change';

let alpha: TestTenant;
let beta: TestTenant;
const paymentMethodActivity = 'CFG.FIN.PAYMENTMETHOD.DEFINE';

async function addActivityStatus(client: string) {
  await withTenant(client, tx => tx.insert(configActivityStatus).values({
    client,
    activityCode: paymentMethodActivity,
    status: 'NOT_STARTED',
    createdBy: 'TEST',
  }).onConflictDoNothing());
}

async function addMethod(client: string, country: string, code: string, direction: PaymentMethodUse | 'BOTH', isActive = true) {
  await withTenant(client, tx => tx.insert(paymentMethod).values({
    client,
    country,
    methodCode: code,
    description: `Test ${country} ${code}`,
    allowedDirection: direction,
    isActive,
    createdBy: 'TEST',
  }));
}

beforeAll(async () => {
  alpha = await createTenant('payment-method-read-alpha', { withConfiguration: false });
  beta = await createTenant('payment-method-read-beta', { withConfiguration: false });
  await addActivityStatus(alpha.client);
  await addActivityStatus(beta.client);
  await addMethod(alpha.client, 'KW', 'T', 'OUTGOING');
  await addMethod(alpha.client, 'US', 'T', 'INCOMING');
  await addMethod(alpha.client, 'KW', 'B', 'BOTH');
  await addMethod(alpha.client, 'KW', 'I', 'INCOMING');
  await addMethod(alpha.client, 'KW', 'Z', 'OUTGOING', false);
});

afterAll(async () => {
  if (beta) await destroyTenant(beta.client);
  if (alpha) await destroyTenant(alpha.client);
  await closeDb();
});

describe('Payment Methods read services', () => {
  it('gets by tenant/country/code and canonicalizes ASCII case', async () => {
    const kuwait = await getPaymentMethod(alpha.client, 'kw', 't');
    const unitedStates = await getPaymentMethod(alpha.client, 'US', 'T');
    expect(kuwait?.country).toBe('KW');
    expect(kuwait?.allowedDirection).toBe('OUTGOING');
    expect(unitedStates?.country).toBe('US');
    expect(unitedStates?.allowedDirection).toBe('INCOMING');
    expect(await getPaymentMethod(alpha.client, 'AE', 'T')).toBeNull();
  });

  it('lists one country in code order and includes inactive definitions by default', async () => {
    const rows = await listPaymentMethods(alpha.client, 'KW');
    expect(rows.map(row => row.methodCode)).toEqual(['B', 'I', 'T', 'Z']);
    expect(rows.find(row => row.methodCode === 'Z')?.isActive).toBe(false);
  });

  it('filters for a requested direction, includes BOTH, and optionally removes inactive rows', async () => {
    const outgoing = await listPaymentMethods(alpha.client, 'KW', { direction: 'OUTGOING', activeOnly: true });
    const incoming = await listPaymentMethods(alpha.client, 'KW', { direction: 'INCOMING', activeOnly: true });
    expect(outgoing.map(row => row.methodCode)).toEqual(['B', 'T']);
    expect(incoming.map(row => row.methodCode)).toEqual(['B', 'I']);

    const outgoingIncludingInactive = await listPaymentMethods(alpha.client, 'KW', { direction: 'OUTGOING' });
    expect(outgoingIncludingInactive.map(row => row.methodCode)).toEqual(['B', 'T', 'Z']);
  });

  it('scopes reads to the tenant even when another tenant has the same country/code', async () => {
    await addMethod(beta.client, 'KW', 'T', 'BOTH');
    expect(await getPaymentMethod(beta.client, 'KW', 'T')).toMatchObject({ client: beta.client, methodCode: 'T' });
    expect(await getPaymentMethod(alpha.client, 'KW', 'T')).toMatchObject({ client: alpha.client, methodCode: 'T' });
    expect(await listPaymentMethods(beta.client, 'US')).toEqual([]);
  });

  it('rejects malformed read keys and unsupported query filters before querying', async () => {
    await expect(getPaymentMethod(alpha.client, 'K1', 'T')).rejects.toBeInstanceOf(PaymentMethodReadError);
    await expect(getPaymentMethod(alpha.client, 'KW', 'TOO')).rejects.toBeInstanceOf(PaymentMethodReadError);
    await expect(listPaymentMethods(alpha.client, 'KW', { direction: 'BOTH' as PaymentMethodUse })).rejects.toBeInstanceOf(PaymentMethodReadError);
    await expect(listPaymentMethods(alpha.client, 'KW', { activeOnly: 'true' as unknown as boolean })).rejects.toBeInstanceOf(PaymentMethodReadError);
  });
});

describe('Payment Methods audited maintenance services', () => {
  it('creates, changes and retires a definition with versioned before/after history', async () => {
    const key = { client: alpha.client, country: 'KW', methodCode: 'C' };
    const created = await savePaymentMethod({
      ...key,
      expectedVersion: 0,
      changedBy: 'ALICE',
      reason: 'Add outbound clearing method',
      values: { description: 'Clearing transfer', allowedDirection: 'OUTGOING', isActive: true },
    });
    expect(created).toEqual({ changed: true, version: 1 });
    const [activity] = await withTenant(key.client, tx => tx.select({ status: configActivityStatus.status })
      .from(configActivityStatus).where(and(
        eq(configActivityStatus.client, key.client),
        eq(configActivityStatus.activityCode, paymentMethodActivity),
      )));
    expect(activity?.status).toBe('COMPLETED');
    expect(await getPaymentMethod(key.client, key.country, key.methodCode)).toMatchObject({
      ...key,
      description: 'Clearing transfer',
      allowedDirection: 'OUTGOING',
      isActive: true,
      version: 1,
      createdBy: 'ALICE',
    });

    const createHistory = await withTenant(alpha.client, tx => changeHistory(tx, alpha.client, 'payment_method', 'KW/C'));
    expect(createHistory).toHaveLength(1);
    expect(createHistory[0]).toMatchObject({
      changeType: 'CREATE',
      transactionCode: 'CFG.FIN.PAYMENTMETHOD.DEFINE',
      changedBy: 'ALICE',
      reason: 'Add outbound clearing method',
    });
    expect(createHistory[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'description', oldValue: null, newValue: 'Clearing transfer' }),
      expect.objectContaining({ fieldName: 'allowedDirection', newValue: 'OUTGOING', isSecurityRelevant: 'true' }),
    ]));

    const unchanged = await savePaymentMethod({
      ...key,
      expectedVersion: 1,
      changedBy: 'ALICE',
      reason: 'Confirm existing definition',
      values: { description: 'Clearing transfer', allowedDirection: 'OUTGOING', isActive: true },
    });
    expect(unchanged).toEqual({ changed: false, version: 1 });

    const changed = await savePaymentMethod({
      ...key,
      expectedVersion: 1,
      changedBy: 'BOB',
      reason: 'Allow both payment directions',
      values: { description: 'Clearing transfer', allowedDirection: 'BOTH', isActive: true },
    });
    expect(changed).toEqual({ changed: true, version: 2 });
    await expect(savePaymentMethod({
      ...key,
      expectedVersion: 1,
      changedBy: 'ALICE',
      reason: 'Stale update attempt',
      values: { description: 'Old value', allowedDirection: 'OUTGOING', isActive: true },
    })).rejects.toBeInstanceOf(PaymentMethodError);

    const retired = await retirePaymentMethod({
      ...key,
      expectedVersion: 2,
      changedBy: 'CAROL',
      reason: 'Method replaced by a bank transfer',
    });
    expect(retired).toEqual({ changed: true, version: 3 });
    expect(await getPaymentMethod(key.client, key.country, key.methodCode)).toMatchObject({
      isActive: false,
      version: 3,
      changedBy: 'CAROL',
    });
    expect((await listPaymentMethods(key.client, key.country)).map(row => row.methodCode)).toContain('C');
    expect((await listPaymentMethods(key.client, key.country, { activeOnly: true })).map(row => row.methodCode)).not.toContain('C');

    const alreadyRetired = await retirePaymentMethod({
      ...key,
      expectedVersion: 3,
      changedBy: 'CAROL',
      reason: 'Confirm retirement',
    });
    expect(alreadyRetired).toEqual({ changed: false, version: 3 });

    const history = await withTenant(alpha.client, tx => changeHistory(tx, alpha.client, 'payment_method', 'KW/C'));
    expect(history).toHaveLength(3);
    expect(history.map(document => document.reason)).toEqual(expect.arrayContaining([
      'Add outbound clearing method',
      'Allow both payment directions',
      'Method replaced by a bank transfer',
    ]));
    expect(history.find(document => document.reason === 'Method replaced by a bank transfer')).toMatchObject({
      changeType: 'CHANGE',
      changedBy: 'CAROL',
      items: expect.arrayContaining([
        expect.objectContaining({ fieldName: 'isActive', oldValue: 'true', newValue: 'false', isSecurityRelevant: 'true' }),
      ]),
    });
  });

  it('scopes writes and versions by tenant when the country/code key is reused', async () => {
    const betaWrite = await savePaymentMethod({
      client: beta.client,
      country: 'KW',
      methodCode: 'X',
      expectedVersion: 0,
      changedBy: 'BETA_USER',
      reason: 'Define tenant beta method',
      values: { description: 'Beta only', allowedDirection: 'INCOMING', isActive: true },
    });
    const alphaWrite = await savePaymentMethod({
      client: alpha.client,
      country: 'KW',
      methodCode: 'X',
      expectedVersion: 0,
      changedBy: 'ALPHA_USER',
      reason: 'Define tenant alpha method',
      values: { description: 'Alpha only', allowedDirection: 'OUTGOING', isActive: true },
    });
    expect(betaWrite).toEqual({ changed: true, version: 1 });
    expect(alphaWrite).toEqual({ changed: true, version: 1 });
    expect(await getPaymentMethod(beta.client, 'KW', 'X')).toMatchObject({ description: 'Beta only', version: 1 });
    expect(await getPaymentMethod(alpha.client, 'KW', 'X')).toMatchObject({ description: 'Alpha only', version: 1 });

    const betaHistory = await withTenant(beta.client, tx => changeHistory(tx, beta.client, 'payment_method', 'KW/X'));
    const alphaHistory = await withTenant(alpha.client, tx => changeHistory(tx, alpha.client, 'payment_method', 'KW/X'));
    expect(betaHistory.map(document => document.reason)).toEqual(['Define tenant beta method']);
    expect(alphaHistory.map(document => document.reason)).toEqual(['Define tenant alpha method']);
  });

  it('rejects missing rows and malformed audit/write inputs without creating a definition', async () => {
    await expect(retirePaymentMethod({
      client: alpha.client,
      country: 'KW',
      methodCode: 'N',
      expectedVersion: 1,
      changedBy: 'TEST',
      reason: 'No method to retire',
    })).rejects.toBeInstanceOf(PaymentMethodError);
    await expect(savePaymentMethod({
      client: alpha.client,
      country: 'KW',
      methodCode: 'N',
      expectedVersion: 0,
      changedBy: 'TEST',
      reason: '  ',
      values: { description: 'Invalid reason', allowedDirection: 'OUTGOING', isActive: true },
    })).rejects.toBeInstanceOf(PaymentMethodError);
    expect(await getPaymentMethod(alpha.client, 'KW', 'N')).toBeNull();
  });
});
