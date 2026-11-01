import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { defineCompanyCode } from '../src/modules/foundation/company-code-definition';
import { hashPassword } from '../src/platform/auth/password';
import { createSession, resolveSession, signIn, type SessionContext } from '../src/platform/auth/session';
import { hasCapability } from '../src/platform/auth/session';
import { assertChangeForSession, openChangeForSession, releaseChangeLock } from '../src/platform/lock/enqueue';
import { appUser } from '../src/platform/tables/security';
import { CREDIT_CONTROL_AREA_CAPABILITY } from '../src/platform/auth/capability-policy';
import {
  createCreditControlAreaSetup,
  listCreditControlAreaSetup,
  type CreditControlAreaSetupInput,
} from '../src/modules/finance/credit-control-area-maintenance';
import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';

let tenant: TestTenant;
let otherTenant: TestTenant;

beforeAll(async () => {
  // Deliberately do not activate standard configuration: that helper can create CCA 0001.
  tenant = await createTenant('credit-control-area-maintenance-isolated', {
    withConfiguration: false,
    currency: 'AED',
    companyCode: '9009',
  });
  otherTenant = await createTenant('credit-control-area-maintenance-other-tenant', {
    withConfiguration: false,
    currency: 'AED',
    companyCode: '9020',
  });
  await defineCompanyCode({
    client: tenant.client,
    changedBy: 'TEST',
    companyCode: '9009',
    name: `CCA test company ${tenant.client}`,
    country: 'AE',
    currency: 'AED',
  });
  await defineCompanyCode({
    client: tenant.client,
    changedBy: 'TEST',
    companyCode: '9010',
    name: `CCA mismatch company ${tenant.client}`,
    country: 'AE',
    currency: 'USD',
  });
  await defineCompanyCode({
    client: tenant.client,
    changedBy: 'TEST',
    companyCode: '9011',
    name: `CCA concurrency company ${tenant.client}`,
    country: 'AE',
    currency: 'USD',
  });
});

afterAll(async () => {
  if (otherTenant) await destroyTenant(otherTenant.client);
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

const LOCK_TEST_PASSWORD = 'CcaLock2026Pass!';

async function liveSession(username: string): Promise<SessionContext> {
  const id = randomUUID();
  const passwordHash = await hashPassword(LOCK_TEST_PASSWORD);
  await withTenant(tenant.client, (tx) => tx.insert(appUser).values({
    id,
    client: tenant.client,
    username,
    fullName: `CCA lock fixture ${username}`,
    passwordHash,
    isActive: true,
    createdBy: 'TEST',
  }));
  const signedIn = await signIn({ client: tenant.client, username, password: LOCK_TEST_PASSWORD });
  const issued = await withTenant(tenant.client, (tx) => createSession(tx, {
    client: tenant.client,
    userId: signedIn.userId,
  }));
  return withTenant(tenant.client, (tx) => resolveSession(tx, {
    client: tenant.client,
    token: issued.token,
  })).then((session) => {
    if (!session) throw new Error('Expected the CCA lock fixture session to resolve.');
    return session;
  });
}

function setup(patch: Partial<CreditControlAreaSetupInput> = {}): CreditControlAreaSetupInput {
  return {
    client: tenant.client,
    changedBy: 'TEST',
    creditControlArea: '9001',
    name: 'Isolated test credit area',
    companyCode: '9009',
    warningThresholdPercent: 90,
    reason: 'Isolated CCA setup test',
    ...patch,
  };
}

describe('audited initial credit-control setup', () => {
  it('creates a distinct test area and initial mapping in one supported service call', async () => {
    const result = await createCreditControlAreaSetup(setup());
    expect(result).toEqual({
      creditControlArea: '9001',
      companyCode: '9009',
      currency: 'AED',
      created: true,
      assigned: true,
      unchanged: false,
    });

    const state = await listCreditControlAreaSetup(tenant.client);
    expect(state.areas).toContainEqual(expect.objectContaining({
      creditControlArea: '9001',
      name: 'Isolated test credit area',
      currency: 'AED',
      warningThresholdPercent: 90,
      isActive: true,
    }));
    expect(state.companies).toContainEqual(expect.objectContaining({
      companyCode: '9009',
      creditControlArea: '9001',
    }));
  });

  it('keeps the setup read model tenant-isolated', async () => {
    expect(await listCreditControlAreaSetup(otherTenant.client)).toEqual({
      areas: [],
      companies: [],
      availableCompanies: [],
    });
  });

  it('requires session-owned locks on both affected records and gives fixture users no CCA grant', async () => {
    const owner = await liveSession('cca.lock.owner');
    const other = await liveSession('cca.lock.other');
    expect(hasCapability(owner.user.capabilities, CREDIT_CONTROL_AREA_CAPABILITY)).toBe(false);
    expect(hasCapability(other.user.capabilities, CREDIT_CONTROL_AREA_CAPABILITY)).toBe(false);

    const locks = [
      { lockObject: 'CREDIT_CONTROL_AREA', argument: '9001' },
      { lockObject: 'COMPANY_CODE_CREDIT_AREA', argument: '9009' },
    ] as const;
    try {
      for (const lock of locks) {
        expect((await openChangeForSession(owner, { ...lock, transactionCode: CREDIT_CONTROL_AREA_CAPABILITY })).mode).toBe('CHANGE');
        await assertChangeForSession(owner, lock);
        await expect(assertChangeForSession(other, lock)).rejects.toMatchObject({ code: 'ENQUEUE_HELD' });
        expect((await openChangeForSession(other, { ...lock, transactionCode: CREDIT_CONTROL_AREA_CAPABILITY })).mode).toBe('DISPLAY');
      }
    } finally {
      for (const lock of locks) {
        if (owner.sessionId) await releaseChangeLock({ client: tenant.client, sessionId: owner.sessionId, ...lock });
      }
    }
  });

  it('records separate audit entries for CCA creation and the Company Code mapping', async () => {
    const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select object_class, object_key, change_type
        from change_document
       where object_key in ('9001', '9009')
         and transaction_code = 'CFG.FIN.CCA.MAINTAIN'
       order by object_class
    `));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ object_class: 'credit_control_area', object_key: '9001', change_type: 'CREATE' }),
      expect.objectContaining({ object_class: 'company_code', object_key: '9009', change_type: 'CHANGE' }),
    ]));
  });

  it('is idempotent for an exact retry and refuses edits to an existing area', async () => {
    await expect(createCreditControlAreaSetup(setup())).resolves.toMatchObject({
      created: false, assigned: false, unchanged: true,
    });
    await expect(createCreditControlAreaSetup(setup({ name: 'Different financial name' })))
      .rejects.toThrow('already exists with different or inactive settings');

    const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as count from change_document
       where transaction_code = 'CFG.FIN.CCA.MAINTAIN'
         and object_key in ('9001', '9009')
    `));
    expect(Number((rows as unknown as Array<{ count: number }>)[0].count)).toBe(2);
  });

  it('never reassigns an already-mapped Company Code or leaves a partial new area', async () => {
    await expect(createCreditControlAreaSetup(setup({ creditControlArea: '9002' })))
      .rejects.toThrow('already assigned to credit control area 9001');
    const state = await listCreditControlAreaSetup(tenant.client);
    expect(state.areas.map((area) => area.creditControlArea)).toEqual(['9001']);
    expect(state.companies.find((company) => company.companyCode === '9009')?.creditControlArea).toBe('9001');
  });

  it('serializes competing initial setups and commits one coherent area/mapping pair', async () => {
    const attempts = await Promise.allSettled([
      createCreditControlAreaSetup(setup({
        creditControlArea: '9004',
        name: 'Concurrent setup winner A',
        companyCode: '9011',
      })),
      createCreditControlAreaSetup(setup({
        creditControlArea: '9004',
        name: 'Concurrent setup winner B',
        companyCode: '9011',
      })),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    const state = await listCreditControlAreaSetup(tenant.client);
    const area = state.areas.filter((item) => item.creditControlArea === '9004');
    expect(area).toHaveLength(1);
    expect(state.companies.find((company) => company.companyCode === '9011')?.creditControlArea).toBe('9004');
  });

  it('refuses a currency mismatch when sharing an existing area with a second Company Code', async () => {
    await expect(createCreditControlAreaSetup(setup({ companyCode: '9010' })))
      .rejects.toThrow('already exists with different or inactive settings');
    const state = await listCreditControlAreaSetup(tenant.client);
    expect(state.companies.find((company) => company.companyCode === '9010')?.creditControlArea).toBeNull();
  });

  it('keeps all test keys separate from the prohibited target CCA and Company Code', async () => {
    const state = await listCreditControlAreaSetup(tenant.client);
    expect(state.areas.every((area) => area.creditControlArea !== '0001')).toBe(true);
    expect(state.companies.every((company) => company.companyCode !== '1000')).toBe(true);
  });
});
