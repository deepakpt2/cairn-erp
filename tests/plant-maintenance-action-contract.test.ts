import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasCapability } from '../src/platform/auth/session';

const actionSource = readFileSync('src/app/config/plants/actions.ts', 'utf8');
const definitionActionStart = actionSource.indexOf('export async function savePlantDefinitionAction');
const assignmentActionStart = actionSource.indexOf('export interface PlantCompanyCodeAssignmentState');
const action = actionSource.slice(definitionActionStart, assignmentActionStart);
const definitionForm = readFileSync('src/app/config/plants/PlantDefinitionForm.tsx', 'utf8');
const i18n = readFileSync('src/platform/i18n/index.ts', 'utf8');

const capability = 'CFG.ORG.PLANT.DEFINE';

describe('protected Plant definition action contract', () => {
  it('requires a verified session and the exact Plant define capability before calling the service', () => {
    expect(actionSource).toContain("const ACTIVITY = 'CFG.ORG.PLANT.DEFINE'");
    expect(action).toContain('requireSession(ROUTE)');
    expect(action).toContain('requireCapability(ACTIVITY, session)');
    expect(action.indexOf('await requireCapability')).toBeLessThan(action.indexOf('await savePlantDefinition'));
    expect(action).toContain('client: session.user.client');
    expect(action).toContain('changedBy: session.user.username');
    expect(action).not.toMatch(/form\.get\(['"]client['"]\)/);
    expect(action).not.toMatch(/form\.get\(['"]changedBy['"]\)/);
  });

  it('submits the approved create/change field set and version token only', () => {
    for (const field of [
      'mode',
      'plant',
      'expectedVersion',
      'name',
      'country',
      'street',
      'houseNumber',
      'postalCode',
      'city',
      'region',
      'factoryCalendar',
      'language',
      'isProductionSite',
      'isStorageSite',
    ]) {
      expect(actionSource).toContain(`'${field}'`);
    }
    expect(action).not.toMatch(/companyCode|defaultStorageLocation|address|isActive/);
    expect(action).toContain("revalidatePath(ROUTE)");
    expect(action).toContain("revalidatePath('/config')");
  });

  it('supports explicit false role values while leaving omitted values to the service defaults', () => {
    expect(actionSource).toContain("const falseValues = new Set(['false', 'off', '0'])");
    expect(actionSource).toContain("const trueValues = new Set(['true', 'on', '1'])");
    expect(action).toContain('isProductionSite: readSiteFlag(form, \'isProductionSite\')');
    expect(action).toContain('isStorageSite: readSiteFlag(form, \'isStorageSite\')');
  });

  it('keeps initial Company Code assignment out of the Plant definition form and registers English messages', () => {
    expect(definitionForm).not.toContain('assignPlantCompanyCodeAction');
    expect(definitionForm).not.toMatch(/name="companyCode"/);
    expect(i18n).toContain("'plant.created': 'Plant {code} defined; Company Code assignment remains separate.'");
    expect(i18n).toContain("'plant.changed': 'Plant {code} saved and its change history recorded.'");
    expect(i18n).toContain("'plant.unchanged': 'No Plant definition data changed for {code}.'");
  });

  it('preserves exact, Configurator-pattern and Administrator-wildcard grants for the new capability', () => {
    expect(hasCapability([capability], capability)).toBe(true);
    expect(hasCapability(['CFG.*'], capability)).toBe(true);
    expect(hasCapability(['*'], capability)).toBe(true);
    expect(hasCapability([], capability)).toBe(false);
  });
});
