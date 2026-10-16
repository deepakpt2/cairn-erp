import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { controllingAreaCompanyAssignmentInputSchema } from '../src/modules/foundation/controlling-area-company-assignment';

const page = readFileSync('src/app/config/controlling-area/assign-company-code/page.tsx', 'utf8');
const actions = readFileSync('src/app/config/controlling-area/assign-company-code/actions.ts', 'utf8');
const ui = readFileSync('src/app/config/controlling-area/ControllingAreaCompanyAssignmentUI.tsx', 'utf8');
const compatibility = readFileSync('src/modules/foundation/controlling-area-company-compatibility.ts', 'utf8');
const assignment = readFileSync('src/modules/foundation/controlling-area-company-assignment.ts', 'utf8');
const okkp = readFileSync('src/modules/foundation/controlling-area-maintenance.ts', 'utf8');
const companyCodeCoa = readFileSync('src/modules/foundation/company-code-coa-assignment.ts', 'utf8');
const foundationServices = readFileSync('src/modules/foundation/services.ts', 'utf8');
const standardConfig = readFileSync('src/modules/foundation/standard-config.ts', 'utf8');
const standardStructure = readFileSync('src/platform/tenancy/standard-structure.ts', 'utf8');
const workbench = readFileSync('src/app/config/page.tsx', 'utf8');
const workbenchTree = readFileSync('src/app/config/WorkbenchTree.tsx', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');
const migration = readFileSync('drizzle/0032_controlling_area_company_ox19.sql', 'utf8');
const locale = readFileSync('src/platform/i18n/index.ts', 'utf8');

const valid = {
  client: 'T025',
  changedBy: 'test.operator',
  controllingArea: ' a000 ',
  companyCode: ' aBc1 ',
};

describe('SCR-025 / OX19 assignment contract', () => {
  it('normalizes the Controlling Area but preserves the existing Company Code key case', () => {
    expect(controllingAreaCompanyAssignmentInputSchema.parse(valid)).toMatchObject({
      client: 'T025',
      changedBy: 'test.operator',
      controllingArea: 'A000',
      companyCode: 'aBc1',
    });
    expect(() => controllingAreaCompanyAssignmentInputSchema.parse({ ...valid, companyCode: 'AB1' })).toThrow();
    expect(() => controllingAreaCompanyAssignmentInputSchema.parse({ ...valid, companyCode: 'AB-1' })).toThrow();
    expect(() => controllingAreaCompanyAssignmentInputSchema.parse({ ...valid, reassignment: true })).toThrow();
  });

  it('offers all tenant-local source masters, including inactive records, with four-character format selection', () => {
    expect(page).toContain('.where(eq(controllingArea.client, client))');
    expect(page).toContain('.where(eq(companyCode.client, client))');
    expect(page).not.toContain('eq(controllingArea.isActive, true)');
    expect(page).not.toContain('eq(companyCode.isActive, true)');
    expect(page).toContain('selectable: /^[A-Za-z0-9]{4}$/.test(code)');
    expect(ui).toContain('pattern="[A-Za-z0-9]{4}"');
    expect(ui).toContain('normalizeUppercase={false}');
  });

  it('requires both owner-approved capabilities before each mutation and derives tenant and actor from session', () => {
    const assignAction = actions.slice(
      actions.indexOf('export async function assignControllingAreaCompanyAction'),
      actions.indexOf('export async function unassignControllingAreaCompanyAction'),
    );
    const unassignAction = actions.slice(actions.indexOf('export async function unassignControllingAreaCompanyAction'));
    for (const [source, serviceCall] of [
      [assignAction, 'await assignCompanyCodeToControllingArea({'],
      [unassignAction, 'await unassignCompanyCodeFromControllingArea({'],
    ]) {
      expect(source).toContain('await requireSession(ROUTE)');
      expect(source).toContain('await requireCapability(CONTROLLING_AREA_DEFINE, session)');
      expect(source).toContain('await requireCapability(COMPANY_CODE_DEFINE, session)');
      expect(source.indexOf('await requireCapability(CONTROLLING_AREA_DEFINE, session)')).toBeLessThan(source.indexOf(serviceCall));
      expect(source.indexOf('await requireCapability(COMPANY_CODE_DEFINE, session)')).toBeLessThan(source.indexOf(serviceCall));
      expect(source).toContain('client: session.user.client');
      expect(source).toContain('changedBy: session.user.username');
      expect(source).not.toMatch(/client:\s*read\(/);
      expect(source).not.toMatch(/changedBy:\s*read\(/);
    }
  });

  it('wires Add and Unassign to server actions and renders pending, success, duplicate and error feedback', () => {
    expect(ui).toContain('useActionState<ControllingAreaCompanyAssignmentActionState, FormData>');
    expect(ui).toContain('<form action={assignAction}');
    expect(ui.match(/<form action=\{unassignAction\}>/g)).toHaveLength(2); // mobile and desktop layouts
    expect(ui).toContain('disabled={!canMaintain || assignmentPending}');
    expect(ui).toContain('disabled={!canMaintain || unassignmentPending}');
    expect(ui).toContain("role={assignmentState.ok ? 'status' : 'alert'}");
    expect(ui).toContain("role={unassignmentState.ok ? 'status' : 'alert'}");
    expect(ui).toContain('name="controllingArea" value={item.controllingArea}');
    expect(ui).toContain('name="companyCode" value={item.companyCode}');
    expect(ui).not.toContain('keepPreviewLocal');
    expect(actions).toContain("t('controllingArea.assignmentDuplicate'");
    expect(locale).toContain('controllingArea.assignmentAdded');
    expect(locale).toContain('controllingArea.assignmentDuplicate');
    expect(locale).toContain('controllingArea.assignmentRemoved');
  });

  it('enforces exact currency/Fiscal Year Variant matches and current-assignment CoA baseline', () => {
    expect(assignment).toContain('companyCurrency !== areaCurrency');
    expect(assignment).toContain('companyFiscalYearVariant !== areaFiscalYearVariant');
    expect(assignment).toContain('chartBaseline !== null && chartBaseline !== companyChartOfAccounts');
    expect(assignment).toContain('async function validateCurrentAreaAssignments');
    expect(assignment).toContain('recordDuplicateAssignmentEvent');
    expect(assignment).toContain("newValue: 'DUPLICATE_NO_OP'");
    expect(assignment).toContain("changeType: 'DELETE'");
    expect(assignment).toContain('export async function unassignCompanyCodeFromControllingArea');
    expect(assignment).not.toContain('isActive');
  });

  it('coordinates assignment and source-master locks, and guards every in-repo financial-setting write path', () => {
    expect(compatibility).toContain('pg_advisory_xact_lock');
    expect(compatibility).toContain('controlling_area_company_code/${companyCodeKey}');
    expect(compatibility).toContain('controlling_area/${areaCode}');
    expect(compatibility).toContain(".for('share')");
    expect(compatibility).toContain('year !== areaFiscalYearVariant');
    expect(compatibility).toContain('currency !== areaCurrency');
    expect(compatibility).toContain("area.companyCodeScope === 'MULTIPLE' && currentCharts.size > 1");
    expect(assignment).toContain('lockCompanyCodeOxxAssignments(tx, client, companyCodeKey, [areaCode])');
    expect(companyCodeCoa).toContain('assertCompanyCodeFinancialSettingsCompatible');
    expect(foundationServices).toContain('assertCompanyCodeFinancialSettingsCompatible');
    // The standard package no longer writes company financial settings at all — SCR-032
    // removed its company-specific half — so the write path this inventory tracks moved
    // to the structure builder. The builder does not call the compatibility assert
    // itself: it only ever inserts a company code that cannot already exist, and it
    // reaches the controlling area through the OX19 service below, which validates the
    // chart baseline against the area's other assignments.
    expect(standardConfig).not.toContain('assertCompanyCodeFinancialSettingsCompatible');
    expect(standardStructure).toContain('assignCompanyCodeToControllingAreaInTransaction(tx, {');
    expect(okkp).toContain('row.currency.trim() !== areaCurrency');
    expect(okkp).toContain("scope === 'MULTIPLE' && chartBaseline !== null && chartBaseline !== chart");
  });

  it('keeps the OX19 route discoverable from the workbench and the migration fail-closed', () => {
    expect(workbench).toContain("'/config/controlling-area/assign-company-code'");
    // The workbench renders as a tree, so the rule that a route is offered only when its screen
    // exists lives in the component that draws the link, fed by the page's list of built routes.
    expect(workbench).toContain('builtRoutes={[...BUILT_ROUTES]}');
    expect(workbenchTree).toContain('item.route_path && routes.has(item.route_path)');
    expect(workbench).not.toContain('PENDING_ACTIVITY_CODES');
    expect(seed).toContain("code: 'CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY'");
    expect(seed).toContain("route: '/config/controlling-area/assign-company-code'");
    expect(migration).toContain('0032 refuses OX19 compatibility validation');
    expect(migration).toContain('controlling_area_company_code_unique_idx');
    expect(migration).toContain('controlling_area_company_area_fk');
    expect(migration).toContain('controlling_area_company_company_code_fk');
  });
});
