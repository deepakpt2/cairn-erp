import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/config/sales-orgs/assign-division/page.tsx', 'utf8');
const form = readFileSync('src/app/config/sales-orgs/assign-division/AssignmentForm.tsx', 'utf8');
const list = readFileSync('src/app/config/sales-orgs/assign-division/AssignmentsList.tsx', 'utf8');
const actions = readFileSync('src/app/config/sales-orgs/assign-division/actions.ts', 'utf8');
const salesOrgPage = readFileSync('src/app/config/sales-orgs/page.tsx', 'utf8');
const divisionPage = readFileSync('src/app/config/divisions/page.tsx', 'utf8');
const workbench = readFileSync('src/app/config/page.tsx', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const checks = readFileSync('scripts/browser-smoke/checks.ts', 'utf8');
const browserRunner = readFileSync('scripts/browser-smoke.ts', 'utf8');
const targets = readFileSync('scripts/browser-smoke/targets.ts', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');

const activity = 'CFG.ORG.SALESORG.ASSIGN_DIVISION';
const route = '/config/sales-orgs/assign-division';

describe('OVXA assignment UI, action and browser acceptance contract', () => {
  it('uses the verified session tenant/actor and protects both mutations with only the exact capability', () => {
    expect(page).toContain(`const ACTIVITY = '${activity}'`);
    expect(page).toContain(`const ROUTE = '${route}'`);
    expect(page).toContain('const session = await requireSession(ROUTE)');
    expect(page).toContain('const client = session.user.client');
    expect(page).toContain('can(session, ACTIVITY)');
    expect(page).toContain('listSalesOrgDivisionAssignments(client)');
    expect(page).toContain('salesOrgDivisionF4Choices(client)');
    expect(page).toContain('const valueHelp = canMaintain');
    expect(page).toContain('await salesOrgDivisionF4Choices(client)');
    expect(page).toContain('<SalesOrgDivisionAssignmentsList assignments={assignmentRows} canRemove={canMaintain} />');

    for (const action of ['assignSalesOrgDivisionAction', 'unassignSalesOrgDivisionAction']) {
      const start = actions.indexOf(`export async function ${action}`);
      const end = actions.indexOf('\n}', start) + 2;
      const snippet = actions.slice(start, end);
      expect(snippet).toContain('requireSession(ROUTE)');
      expect(snippet).toContain('requireCapability(ACTIVITY, session)');
      expect(snippet).toContain('client: session.user.client');
      expect(snippet).toContain('changedBy: session.user.username');
      expect(snippet).not.toMatch(/form\.get\(['"](client|changedBy)['"]\)/);
    }
    expect(actions).toContain(`const ACTIVITY = '${activity}'`);
    expect(actions).toContain("revalidatePath('/config/divisions')");
    expect(actions).toContain("revalidatePath('/config/sales-areas')");
  });

  it('accepts only Sales Organization Char 4 and Division Char 2 values with active-definition F4', () => {
    expect(form).toContain('name="salesOrg"');
    expect(form).toContain('maxLength={4}');
    expect(form).toContain('pattern="[A-Za-z0-9]{4}"');
    expect(form).toContain('name="division"');
    expect(form).toContain('maxLength={2}');
    expect(form).toContain('pattern="[A-Za-z0-9]{2}"');
    expect(form).toContain("onKeyDown={(event) => {");
    expect(form).toContain("if (event.key === 'F4')");
    expect(form).toContain("openHelp('salesOrg')");
    expect(form).toContain("openHelp('division')");
    expect(form).toContain('salesOrganizations.filter');
    expect(form).toContain('divisions.filter');
    expect(form).toContain('role="dialog"');
    expect(form).toContain('aria-modal="true"');
    expect(form).not.toMatch(/name="(client|changedBy)"/);
    expect(form).toContain('min-h-11');
    expect(messages).toContain("'salesOrgDivision.salesOrgLookupEmpty': 'No matching active Sales Organizations are available.'");
    expect(messages).toContain("'salesOrgDivision.divisionLookupEmpty': 'No matching active Divisions are available.'");
  });

  it('shows retained current history and confirms removal under the cross-channel Sales Area rule', () => {
    expect(list).toContain('aria-label={t(\'salesOrgDivision.assignmentListTitle\')}');
    expect(list).toContain('salesOrgActive');
    expect(list).toContain('divisionActive');
    expect(list).toContain('name="salesOrg" value={item.salesOrg}');
    expect(list).toContain('name="division" value={item.division}');
    expect(list).toContain("t('salesOrgDivision.confirmRemoveText'");
    expect(list).toContain("t('salesOrgDivision.confirmRemove')");
    expect(list).not.toMatch(/name="(client|changedBy)"/);
    expect(messages).toContain('across any Distribution Channel; change history will be retained.');
    expect(messages).toContain('Change history is retained after removal.');
    expect(messages).toContain("'salesOrgDivision.alreadyAssigned':");
    expect(messages).toContain("'salesOrgDivision.removed':");
  });

  it('links OVXA from OVX5, OVXB and the configuration workbench without exposing controls to other authorities', () => {
    expect(salesOrgPage).toContain(`href="${route}"`);
    expect(salesOrgPage).toContain('canAssignDivision');
    expect(divisionPage).toContain(`href="${route}"`);
    expect(divisionPage).toContain('canAssignSalesOrg');
    expect(workbench).toContain(`'${route}'`);
    expect(page).toContain('!canMaintain && (');
    expect(page).toContain("t('auth.readOnly', { authority: ACTIVITY })");
    expect(page).toContain('canMaintain && hasActiveSalesOrganizations && hasActiveDivisions');
  });

  it('registers a single reserved browser target and exercises audit, idempotence, dependencies and exact access', () => {
    expect(targets).toContain("{ id: 'sales-org-division', client: 'T973'");
    expect(targets).not.toContain("  'sales-org-division',");
    expect(browserRunner).toContain("target.id === 'sales-org-division') return '/config/sales-orgs/assign-division'");
    expect(checks).toContain("'sales-org-division': salesOrgDivisionAssignment");
    expect(checks).toContain("const assignmentActivity = 'CFG.ORG.SALESORG.ASSIGN_DIVISION'");
    expect(checks).toContain("distributionChannel: '02'");
    expect(checks).toContain("'spoofed.actor'");
    expect(checks).toContain("changeHistory(tx, CLIENT, 'sales_org_division', '1000/02')");
    expect(packageJson).toContain('"smoke:browser:sales-org-division"');
  });
});
