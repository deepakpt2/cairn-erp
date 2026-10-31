import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('credit-control area setup boundaries', () => {
  const service = read('src/modules/finance/credit-control-area-maintenance.ts');
  const contract = read('src/modules/finance/credit-control-area-contract.ts');
  const action = read('src/app/config/credit-control-areas/actions.ts');
  const page = read('src/app/config/credit-control-areas/page.tsx');
  const seed = read('scripts/seed.ts');

  it('registers the dedicated authority and activity without assigning it to a role', () => {
    expect(seed).toContain("code: 'CFG.FIN.CCA.MAINTAIN'");
    expect(seed).toContain("ourCode: 'CFG.FIN.CCA.MAINTAIN'");
    expect(seed).toContain("route: '/config/credit-control-areas'");
    expect(seed).not.toMatch(/(?:roleCapability|role_capability)[\s\S]{0,500}CFG\.FIN\.CCA\.MAINTAIN/);
  });

  it('protects the write action and requires locks on both master and assignment objects', () => {
    expect(action).toContain('can(session, CREDIT_CONTROL_AREA_CAPABILITY)');
    expect(action).toContain("lockObject: CREDIT_CONTROL_AREA_LOCKS.area");
    expect(action).toContain("lockObject: CREDIT_CONTROL_AREA_LOCKS.company");
    expect(action).toContain('assertChangeForSession');
  });

  it('records the approved defaults but keeps currency tied to the Company Code', () => {
    expect(contract).toContain("creditControlArea: '0001'");
    expect(contract).toContain("name: 'Standard credit control area'");
    expect(contract).toContain('warningThresholdPercent: 90');
    expect(service).toContain('currency: company.currency');
    expect(contract).toContain('isActive: true');
  });

  it('is initial-assignment-only, tenant-scoped, transactional and audited', () => {
    expect(service).toContain('withTenant(client, async (tx)');
    expect(service).toContain('await recordChange(tx');
    expect(service).toContain('await markActivityComplete');
    expect(service).toContain("isNull(companyCode.creditControlArea)");
    expect(service).toContain('never edits an existing');
    expect(service).toContain("'creditControlArea'");
    expect(page).toContain('Existing CCA settings and assignments are read-only here');
  });
});
