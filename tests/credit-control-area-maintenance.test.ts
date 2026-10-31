import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { defineCompanyCode } from '../src/modules/foundation/company-code-definition';
import {
  createCreditControlAreaSetup,
  listCreditControlAreaSetup,
  type CreditControlAreaSetupInput,
} from '../src/modules/finance/credit-control-area-maintenance';
import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';

let tenant: TestTenant;

beforeAll(async () => {
  // Deliberately do not activate standard configuration: that helper can create CCA 0001.
  tenant = await createTenant('credit-control-area-maintenance-isolated', {
    withConfiguration: false,
    currency: 'AED',
    companyCode: '9009',
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
});

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

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
