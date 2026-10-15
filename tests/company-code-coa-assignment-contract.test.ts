import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { companyCodeCoaAssignmentInputSchema } from '../src/modules/foundation/company-code-coa-assignment';

const actions = readFileSync('src/app/config/company-codes/actions.ts', 'utf8');
const action = actions.slice(actions.indexOf('export async function assignCompanyCodeCoaAction'));
const service = readFileSync('src/modules/foundation/company-code-coa-assignment.ts', 'utf8');
const valid = {
  client: 'T001',
  changedBy: 'TEST',
  companyCode: ' 2000 ',
  chartOfAccounts: ' CORP ',
};

describe('protected Company Code CoA assignment contract', () => {
  it('normalizes the company and chart keys while rejecting unrelated assignment fields', () => {
    expect(companyCodeCoaAssignmentInputSchema.parse(valid)).toMatchObject({
      client: 'T001',
      changedBy: 'TEST',
      companyCode: '2000',
      chartOfAccounts: 'CORP',
    });
    expect(() => companyCodeCoaAssignmentInputSchema.parse({ ...valid, chartOfAccounts: 'C'.repeat(9) })).toThrow();
    expect(() => companyCodeCoaAssignmentInputSchema.parse({ ...valid, fiscalYearVariant: 'K4' })).toThrow();
    expect(() => companyCodeCoaAssignmentInputSchema.parse({ ...valid, postingPeriodVariant: 'C001' })).toThrow();
    expect(() => companyCodeCoaAssignmentInputSchema.parse({ ...valid, tenant: 'OTHER' })).toThrow();
  });

  it('requires the exact SCR-013 capability before calling the service and derives tenant/actor from session', () => {
    expect(action).toContain("requireSession('/config/company-codes')");
    expect(action).toContain("requireCapability('CFG.ORG.COMPANYCODE.ASSIGN_COA', session)");
    expect(action.indexOf("requireCapability('CFG.ORG.COMPANYCODE.ASSIGN_COA'")).toBeLessThan(
      action.indexOf('await assignCompanyCodeCoa({'),
    );
    expect(action).toContain('client: session.user.client');
    expect(action).toContain('changedBy: session.user.username');
    expect(action).not.toMatch(/client:\s*read\(/);
    expect(action).not.toMatch(/changedBy:\s*read\(/);
    expect(action).toContain("revalidatePath('/finance/journal/new')");
    expect(action).toContain("t('cc.coaAssigned'");
    expect(action).toContain("t('cc.coaAlreadyAssigned'");
  });

  it('checks tenant-local prerequisites and active CoA, and refuses a different existing assignment', () => {
    expect(service).toContain('.strict()');
    expect(service).toContain('lockCompanyCodeOxxAssignments(tx, client, values.companyCode)');
    expect(service).toContain(".for('update')");
    expect(service).toContain("'CFG.ORG.COMPANYCODE.DEFINE', 'CFG.FIN.COA.DEFINE'");
    expect(service).toContain("eq(chartOfAccounts.isActive, true)");
    expect(service).toContain('isNull(companyCode.chartOfAccounts)');
    expect(service).toContain('This initial assignment action does not replace an existing chart of accounts.');
  });

  it('records the CoA change and completes SCR-013 in the same tenant transaction', () => {
    expect(service).toContain('return withTenant(client, async (tx) =>');
    expect(service).toContain("objectClass: 'company_code'");
    expect(service).toContain("changeType: 'CHANGE'");
    expect(service).toContain("transactionCode: ASSIGNMENT_ACTIVITY");
    expect(service).toContain("securityRelevantFields: ['chartOfAccounts']");
    expect(service).toContain('await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy)');
  });
});
