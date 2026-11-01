import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

const { recordChangeMock } = vi.hoisted(() => ({ recordChangeMock: vi.fn() }));
vi.mock('@/platform/change', () => ({ recordChange: recordChangeMock }));

import { defineCompanyCode } from '../src/modules/foundation/company-code-definition';
import { type SessionContext } from '../src/platform/auth/session';
import { createCcaAuthorizedSession } from './helpers/credit-control-area-authorized';
import {
  createCreditControlAreaSetup,
  listCreditControlAreaSetup,
} from '../src/modules/finance/credit-control-area-maintenance';
import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';

let tenant: TestTenant;
let actor: SessionContext;

beforeAll(async () => {
  // No standard package or structure helper: those may create CCA 0001.
  tenant = await createTenant('credit-control-area-atomicity-isolated', {
    withConfiguration: false,
    currency: 'AED',
    companyCode: '9030',
  });
  recordChangeMock.mockResolvedValue(null);
  await defineCompanyCode({
    client: tenant.client,
    changedBy: 'TEST',
    companyCode: '9030',
    name: `CCA atomicity company ${tenant.client}`,
    country: 'AE',
    currency: 'AED',
  });
  actor = await createCcaAuthorizedSession(tenant.client, 'cca.atomicity.operator', ['9030']);
});

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

describe('credit-control setup transaction atomicity', () => {
  it('rolls back both the new area and mapping when the second audit record fails', async () => {
    recordChangeMock.mockReset();
    recordChangeMock.mockResolvedValueOnce('cca-create-change-document');
    recordChangeMock.mockRejectedValueOnce(new Error('injected company-mapping audit failure'));

    if (!actor.sessionId) throw new Error('Expected a persisted CCA atomicity test session.');
    await expect(createCreditControlAreaSetup({
      client: tenant.client,
      authorization: { userId: actor.user.userId, sessionId: actor.sessionId },
      creditControlArea: '9031',
      name: 'Atomic rollback test area',
      companyCode: '9030',
      warningThresholdPercent: 90,
      reason: 'Exercise transaction rollback',
    })).rejects.toThrow('injected company-mapping audit failure');

    const state = await listCreditControlAreaSetup(tenant.client);
    expect(state.areas.map((area) => area.creditControlArea)).not.toContain('9031');
    expect(state.companies.find((company) => company.companyCode === '9030')?.creditControlArea).toBeNull();
    const audits = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as count from change_document
       where transaction_code = 'CFG.FIN.CCA.MAINTAIN'
         and object_key in ('9031', '9030')
    `));
    expect(Number((audits as unknown as Array<{ count: number }>)[0].count)).toBe(0);
  });
});
