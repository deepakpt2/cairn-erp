import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/config/plants/page.tsx', 'utf8');
const form = readFileSync('src/app/config/plants/PlantCompanyCodeAssignmentForm.tsx', 'utf8');
const definitionForm = readFileSync('src/app/config/plants/PlantDefinitionForm.tsx', 'utf8');
const i18n = readFileSync('src/platform/i18n/index.ts', 'utf8');

describe('SCR-015 initial Plant Company Code assignment UI contract', () => {
  it('loads active tenant-local Company Code choices only for the separate authority and unassigned Plants', () => {
    expect(page).toContain("const PLANT_ASSIGNMENT = 'CFG.ORG.PLANT.ASSIGN_COMPANY'");
    expect(page).toContain('const canAssign = can(session, PLANT_ASSIGNMENT)');
    expect(page).toContain('canAssign && hasUnassignedPlants');
    expect(page).toContain('await withTenant(client, async (tx) =>');
    expect(page).toContain('eq(companyCodeTable.client, client)');
    expect(page).toContain('eq(companyCodeTable.isActive, true)');
    expect(page).toContain('orderBy(asc(companyCodeTable.companyCode))');
  });

  it('shows assignment only for unassigned Plants and authorized users, with an explicit empty-choice state', () => {
    expect(page).toContain('{!plant.companyCode && (');
    expect(page).toContain('{canAssign ? (');
    expect(page).toContain('<PlantCompanyCodeAssignmentForm plant={plant.plant} companyCodes={companyCodeChoices} />');
    expect(page).toContain("t('plant.noActiveCompanyCodes')");
    expect(page).toContain("t('auth.readOnly', { authority: PLANT_ASSIGNMENT })");
    expect(page).toContain('PLANT_ASSIGNMENT');
  });

  it('submits only Plant and Company Code and states that replacement/clear are not available', () => {
    expect(form).toContain('useActionState(assignPlantCompanyCodeAction, INITIAL)');
    expect(form).toContain('type="hidden" name="plant" value={plant}');
    expect(form).toContain('name="companyCode"');
    expect(form).toContain('defaultValue=""');
    expect(form).not.toMatch(/name="(client|changedBy|tenant|actor)"/);
    expect(form).toContain('companyCodes.length === 0');
    expect(i18n).toContain("'plant.assignmentInitialOnly': 'Initial assignment only; an assigned Plant cannot be changed or cleared in this milestone.'");
    expect(definitionForm).not.toContain('name="companyCode"');
    expect(definitionForm).not.toContain('assignPlantCompanyCodeAction');
  });

  it('provides English labels and accessible action feedback', () => {
    expect(i18n).toContain("'plant.companyCodeForPlant': 'Company Code for Plant {code}'");
    expect(i18n).toContain("'plant.chooseCompanyCode': 'Choose a Company Code'");
    expect(i18n).toContain("'plant.assignCompanyCode': 'Assign Company Code'");
    expect(form).toContain('role="status"');
    expect(form).toContain('state.remedy');
  });
});
