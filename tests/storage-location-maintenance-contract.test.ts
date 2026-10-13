import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasCapability } from '../src/platform/auth/session';

const capability = 'CFG.ORG.STORAGELOC.DEFINE';
const actionSource = readFileSync('src/app/config/storage-locations/actions.ts', 'utf8');
const serviceSource = readFileSync('src/modules/foundation/storage-location-maintenance.ts', 'utf8');
const i18n = readFileSync('src/platform/i18n/index.ts', 'utf8');
const saveActionStart = actionSource.indexOf('export async function saveStorageLocationAction');
const deactivateActionStart = actionSource.indexOf('export async function deactivateStorageLocationAction');
const saveAction = actionSource.slice(saveActionStart, deactivateActionStart);
const deactivateAction = actionSource.slice(deactivateActionStart);
const valueSchemaStart = serviceSource.indexOf('export const storageLocationDefinitionValuesSchema');
const modeSchemaStart = serviceSource.indexOf('export const storageLocationMaintenanceModeSchema');
const valueSchema = serviceSource.slice(valueSchemaStart, modeSchemaStart);

describe('SCR-016 Storage Location maintenance contract', () => {
  it('requires a verified session and the exact Storage Location capability before either write', () => {
    expect(actionSource).toContain("const ACTIVITY = 'CFG.ORG.STORAGELOC.DEFINE'");
    for (const action of [saveAction, deactivateAction]) {
      expect(action).toContain('requireSession(ROUTE)');
      expect(action).toContain('requireCapability(ACTIVITY, session)');
      expect(action.indexOf('await requireCapability')).toBeLessThan(
        action.search(/await (saveStorageLocation|deactivateStorageLocation)\(/),
      );
      expect(action).toContain('client: session.user.client');
      expect(action).toContain('changedBy: session.user.username');
      expect(action).not.toMatch(/read\(form,\s*['"](client|changedBy)['"]\)/);
    }
  });

  it('accepts only create/change definition fields and a separate non-destructive deactivation', () => {
    expect(valueSchema).toContain("name: z.string().trim().min(1).max(120)");
    expect(valueSchema).toContain('allowNegativeStock: z.boolean().default(false)');
    expect(valueSchema).toContain('.strict()');
    expect(valueSchema).not.toContain('isActive');
    expect(serviceSource).toContain("z.enum(['CREATE', 'CHANGE'])");
    expect(serviceSource).toContain('export async function deactivateStorageLocation');
    expect(serviceSource).not.toMatch(/\.delete\s*\(/);
    expect(serviceSource).not.toMatch(/companyCode|defaultStorageLocation/i);
  });

  it('revalidates the intended Storage Location route, the Plant list, and the workbench', () => {
    expect(actionSource).toContain("const ROUTE = '/config/storage-locations'");
    expect(actionSource).toContain("revalidatePath('/config/plants')");
    expect(actionSource).toContain("revalidatePath('/config')");
    expect(actionSource).toContain("'storageLocation.created'");
    expect(actionSource).toContain("'storageLocation.deactivated'");
  });

  it('states that negative-stock configuration is not movement enforcement and retains deactivated records', () => {
    expect(serviceSource).toContain('no stock-movement behavior is implemented here');
    expect(i18n).toContain("'storageLocation.created': 'Storage Location {code} created for Plant {plant}. Negative-stock allowance is stored configuration only.'");
    expect(i18n).toContain("'storageLocation.deactivated': 'Storage Location {code} in Plant {plant} deactivated and retained with its history.'");
    expect(serviceSource).toContain('Non-destructively deactivate a Storage Location while retaining its row and audit history.');
  });

  it('preserves exact, Configurator-pattern, and Administrator-wildcard grants', () => {
    expect(hasCapability([capability], capability)).toBe(true);
    expect(hasCapability(['CFG.*'], capability)).toBe(true);
    expect(hasCapability(['*'], capability)).toBe(true);
    expect(hasCapability([], capability)).toBe(false);
  });
});
