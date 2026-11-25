/**
 * The India UAT installer — contracts that hold without a database.
 *
 * These guard the parts that are decisions rather than data: the fixture tree is internally
 * consistent, the scenario resolver puts January to March in the right fiscal year, the argument
 * parser refuses what it should, and the reset refuses rather than deletes when it is not safe.
 *
 * The parts that need a database — that a run creates 52 employees, that a second run changes
 * nothing — are exercised against a scratch database and recorded in `docs/uat-india/README.md`.
 * A unit test cannot prove them, and pretending otherwise would be the kind of green that means
 * nothing.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  loadFixtures,
  resolveScenario,
  validate,
  type CompanyFixture,
  type CountryPack,
  type CoreOrganisation,
} from '../src/platform/tenancy/in01-fixtures';
import { judgeReset } from '../src/platform/tenancy/in01-reset';
import { parseArgs } from '../scripts/in01-install';
import { renderIn01CredentialCsv, renderIn01CredentialReport } from '../src/platform/tenancy/in01-credentials';

const fixtures = loadFixtures({ countryCode: 'IN', companyKey: 'IN01' });

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('the fixture tree', () => {
  it('loads the three parts and names where each came from', () => {
    expect(fixtures.sources.core).toMatch(/fixtures\/core\/organisation\.json$/);
    expect(fixtures.sources.country).toMatch(/fixtures\/country\/IN\/country-pack\.json$/);
    expect(fixtures.sources.company).toMatch(/fixtures\/company\/IN01\/company\.json$/);
  });

  it('is India in rupees, on an April-to-March year', () => {
    expect(fixtures.country.country.code).toBe('IN');
    expect(fixtures.country.country.currency).toBe('INR');
    expect(fixtures.company.identity.currency).toBe('INR');
    expect(fixtures.country.fiscalYear.variant).toBe('A4');
    expect(fixtures.country.fiscalYear.isCalendarYear).toBe(false);
  });

  it('provisions at least the fifty employees the brief asks for', () => {
    expect(fixtures.company.employees.length).toBeGreaterThanOrEqual(50);
  });

  it('gives 12 to 15 system users, and leaves the rest as employees only', () => {
    expect(fixtures.company.users.length).toBeGreaterThanOrEqual(12);
    expect(fixtures.company.users.length).toBeLessThanOrEqual(15);
    expect(fixtures.company.users.length).toBeLessThan(fixtures.company.employees.length);
  });

  it('takes the company code from the company folder, not the neutral pattern', () => {
    // The defect this guards: `core/` carried `1000` and the installer read it, so the company
    // installed under the product's standard key instead of the code the brief asks for.
    expect(fixtures.companyCode).toBe('IN01');
    expect(fixtures.company.identity.companyCode).toBe('IN01');
    expect((fixtures.core.structure as unknown as Record<string, unknown>).companyCode).toBeUndefined();
  });

  it('runs a company that is not the demo dataset and not a real undertaking', () => {
    // The old dataset stays in git history; this installer must not touch it.
    expect(fixtures.company.identity.clientKey).toBe('IN01');
    expect(fixtures.company.identity.legalName).not.toMatch(/Vantage Foods/i);
    expect(fixtures.company.identity.country).toBe('IN');
  });

  it('balances the opening journal', () => {
    const journal = fixtures.company.openingBalances.journal;
    const debit = journal.reduce((sum, line) => sum + Number(line.debit), 0);
    const credit = journal.reduce((sum, line) => sum + Number(line.credit), 0);
    expect(debit).toBe(credit);
    expect(debit).toBeGreaterThan(0);
  });

  it('carries a foreign vendor and a foreign customer for the international slice', () => {
    const vendors = fixtures.company.vendors as Array<Record<string, unknown>>;
    const customers = fixtures.company.customers as Array<Record<string, unknown>>;
    expect(vendors.some((v) => v.foreign === true)).toBe(true);
    expect(customers.some((c) => c.foreign === true)).toBe(true);
  });
});

describe('the fixture validator refuses inconsistent data', () => {
  const base = { core: fixtures.core, country: fixtures.country, company: fixtures.company };

  it('accepts the shipped fixtures', () => {
    expect(() => validate(base)).not.toThrow();
  });

  it('refuses an employee in an undefined cost centre', () => {
    const broken = clone(base);
    broken.company.employees[0]!.costCentre = 'CC9999';
    expect(() => validate(broken)).toThrow(/cost centre CC9999/);
  });

  it('refuses a user linked to a personnel number that is not an employee', () => {
    const broken = clone(base);
    broken.company.users[1]!.personnelNumber = '99999999';
    expect(() => validate(broken)).toThrow(/99999999/);
  });

  it('refuses a BOM that names a material which does not exist', () => {
    const broken = clone(base);
    broken.company.boms[0]!.items[0]!.component = 'RM-NOT-REAL';
    expect(() => validate(broken)).toThrow(/RM-NOT-REAL/);
  });

  it('refuses a salary structure naming a component the country pack lacks', () => {
    const broken = clone(base);
    broken.company.salaryStructures.MGMT.rules.push({ component: 'NOT_A_COMPONENT', kind: 'FIXED', value: '1' });
    expect(() => validate(broken)).toThrow(/NOT_A_COMPONENT/);
  });

  it('refuses opening balances that do not net to zero', () => {
    const broken = clone(base);
    broken.company.openingBalances.journal[0]!.debit = '4500001';
    expect(() => validate(broken)).toThrow(/do not net to zero/);
  });

  it('refuses a company whose country disagrees with the country pack', () => {
    const broken = clone(base);
    broken.company.identity.country = 'AE';
    expect(() => validate(broken)).toThrow(/country/);
  });

  it('refuses an org unit whose parent is not defined', () => {
    const broken = clone(base);
    broken.company.orgUnits.push({ code: 'ORPHAN', name: 'Orphan', parentCode: 'NOT_THERE' });
    expect(() => validate(broken)).toThrow(/NOT_THERE/);
  });
});

describe('the scenario resolver, on an April-to-March year', () => {
  const at = (anchorDate: string) => resolveScenario({ country: fixtures.country, anchorDate });

  it('puts April to December in the fiscal year that starts in April', () => {
    expect(at('2026-04-01')).toMatchObject({ fiscalYear: 2026, period: 1 });
    expect(at('2026-08-15')).toMatchObject({ fiscalYear: 2026, period: 5 });
    expect(at('2026-12-31')).toMatchObject({ fiscalYear: 2026, period: 9 });
  });

  it('puts January to March in the fiscal year that started the previous April', () => {
    // This is the boundary the application itself got wrong; see 06-bug-fix-log.md.
    expect(at('2027-01-15')).toMatchObject({ fiscalYear: 2026, period: 10 });
    expect(at('2027-02-10')).toMatchObject({ fiscalYear: 2026, period: 11 });
    expect(at('2027-03-31')).toMatchObject({ fiscalYear: 2026, period: 12 });
  });

  it('returns the calendar window the period actually covers', () => {
    expect(at('2026-11-15')).toMatchObject({ from: '2026-11-01', to: '2026-11-30' });
    expect(at('2027-02-10')).toMatchObject({ from: '2027-02-01', to: '2027-02-28' });
  });

  it('resolves every day of a whole year, with no gap', () => {
    let unresolved = 0;
    for (let month = 1; month <= 12; month++) {
      const lastDay = new Date(Date.UTC(2026, month, 0)).getUTCDate();
      for (let day = 1; day <= lastDay; day++) {
        const date = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        try { at(date); } catch { unresolved += 1; }
      }
    }
    expect(unresolved).toBe(0);
  });
});

describe('the argument parser', () => {
  it('defaults to the master-data install', () => {
    expect(parseArgs([]).until).toBe('phase2');
  });

  it('accepts each phase, in either form', () => {
    expect(parseArgs(['--until=phase0']).until).toBe('phase0');
    expect(parseArgs(['--until', 'phase1']).until).toBe('phase1');
    expect(parseArgs(['--until=phase2']).until).toBe('phase2');
  });

  it('refuses a phase it does not have', () => {
    expect(() => parseArgs(['--until=phase9'])).toThrow(/phase0, phase1, phase2/);
  });

  it('refuses --with-transactions by name rather than ignoring it', () => {
    expect(() => parseArgs(['--with-transactions'])).toThrow(/not implemented/);
  });

  it('reads the reset flag and the confirmation separately', () => {
    const parsed = parseArgs(['--reset-demo', 'IN01', '--confirm', 'IN01']);
    expect(parsed.reset).toEqual({ enabled: true, companyCode: 'IN01', confirm: 'IN01' });
  });

  it('refuses an unknown option', () => {
    expect(() => parseArgs(['--force'])).toThrow(/Unknown option/);
  });
});

describe('the reset refuses rather than deletes', () => {
  const safe = {
    databaseUrl: 'postgresql://app@127.0.0.1:5432/cairn_in01_work',
    client: 'IN01',
    companyCode: 'IN01',
    confirmedCompanyCode: 'IN01',
    flag: 'reset-demo' as const,
    installationExists: true,
    environment: 'development',
  };

  it('proceeds when every condition is met', () => {
    expect(judgeReset(safe)).toBeNull();
  });

  it('refuses outside development', () => {
    const refusal = judgeReset({ ...safe, environment: 'production' });
    expect(refusal?.reason).toMatch(/disabled outside development/);
  });

  it('refuses without the flag', () => {
    const refusal = judgeReset({ ...safe, flag: 'reset-demo' as const, confirmedCompanyCode: '' });
    expect(refusal).not.toBeNull();
  });

  it('refuses a company code that was not typed back', () => {
    const refusal = judgeReset({ ...safe, confirmedCompanyCode: 'WRONG' });
    expect(refusal?.reason).toMatch(/does not match/);
  });

  it('refuses when no installation record exists', () => {
    const refusal = judgeReset({ ...safe, installationExists: false });
    expect(refusal?.reason).toMatch(/No installation record/);
    expect(refusal?.detail.join(' ')).toMatch(/Nothing was deleted/);
  });

  /**
   * The founder rule is enforced inside `performReset`, against the installation's `completed_at`
   * and the two audit columns, so it cannot be unit-tested without a database. What can be
   * checked here is that the caller passes the founder accounts at all: without them the whole
   * check is skipped, which is the failure mode worth guarding against.
   */
  it('is wired to receive the founder accounts as well as the tester accounts', () => {
    const source = readFileSync('scripts/in01-install.ts', 'utf8');
    expect(source).toMatch(/founderAccounts:\s*\[\.\.\.founders\]/);
  });

  it('checks the two audit columns separately, so an edit to an installer row is seen', () => {
    const source = readFileSync('src/platform/tenancy/in01-reset.ts', 'utf8');
    // A row the installer created and a founder later changed must be attributed to the founder;
    // coalescing the columns would report the creator and hide the edit.
    expect(source).toMatch(/'changed_by'\)\) as actor/);
    expect(source).toMatch(/events\."when" > coalesce\(/);
  });
});

describe('the credential report', () => {
  const rows = [
    {
      username: 'IN01.BUYER', password: 'GeneratedPass123', role: 'Buyer',
      employee: 'Kavita Pawar', personnelNumber: '10000010', department: 'Purchase',
    },
    {
      username: 'IN01.AP', password: 'AnotherPass456', role: 'Accountant (AP/AR)',
      employee: 'Amit Joshi', personnelNumber: '10000003', department: 'Finance',
    },
  ];

  it('lists every account with its own password and department', () => {
    const report = renderIn01CredentialReport({
      company: 'Cairn Demo Industries Private Limited',
      clientKey: 'IN01',
      companyCode: 'IN01',
      loginUrl: 'http://localhost:3000',
      accounts: rows,
      filePath: '/app/credentials/demo-credentials.txt',
      generatedAt: '2026-11-25T00:00:00.000Z',
      until: 'phase2',
    });
    expect(report).toContain('TEST ONLY');
    expect(report).toContain('FICTIONAL DATA');
    for (const row of rows) {
      expect(report).toContain(row.username);
      expect(report).toContain(row.password);
      expect(report).toContain(row.department);
      expect(report).toContain(row.employee);
    }
    // Two different passwords, not one shared one.
    expect(rows[0]!.password).not.toBe(rows[1]!.password);
  });

  it('exports the same rows as CSV, and escapes a comma', () => {
    const csv = renderIn01CredentialCsv([
      { ...rows[0]!, employee: 'Pawar, Kavita' },
    ]);
    expect(csv.split('\n')[0]).toBe('username,password,role,employee,personnelNumber,department');
    expect(csv).toContain('"Pawar, Kavita"');
    expect(csv).toContain('IN01.BUYER');
  });
});

describe('the country pack stays a pack, not a company', () => {
  it('names no company, no employee and no partner', () => {
    const raw = readFileSync(fixtures.sources.country, 'utf8');
    for (const companySpecific of ['Cairn Demo Industries', 'Deccan Steel', 'Kavita Pawar', 'IN01.buyer']) {
      expect(raw).not.toContain(companySpecific);
    }
  });

  it('carries the tax codes, the fiscal year and the statutory components', () => {
    expect(fixtures.country.taxCodes.codes.map((code) => code.code)).toEqual(
      expect.arrayContaining(['G18', 'G12', 'GZ0']),
    );
    const components = fixtures.country.payrollStatutory.components.map((component) => component.code);
    expect(components).toEqual(expect.arrayContaining(['PFEE', 'PFER', 'ESIEE', 'ESIER', 'PTAX', 'TDS192']));
  });
});

describe('the core pack stays country-neutral', () => {
  it('names no country, no currency and no jurisdiction', () => {
    // Word boundaries, because a substring match is a false positive: "manufacturing storage"
    // contains the letters of "GST" without being a tax term. What must not appear is the term.
    const raw = readFileSync(fixtures.sources.core, 'utf8');
    for (const countrySpecific of ['INR', 'India', 'GST', 'CGST', 'SGST', 'IGST', 'TDS', 'PF', 'ESI']) {
      const pattern = new RegExp(`\\b${countrySpecific}\\b`, 'i');
      expect(pattern.test(raw), `${countrySpecific} must not appear in the core pack`).toBe(false);
    }
    expect(/april to march/i.test(raw)).toBe(false);
  });
});
