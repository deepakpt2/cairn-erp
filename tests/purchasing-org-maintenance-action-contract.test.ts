import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasCapability } from '../src/platform/auth/session';

const capability = 'CFG.PROC.PURORG.DEFINE';
const actionSource = readFileSync('src/app/config/purchasing-orgs/actions.ts', 'utf8');
const i18n = readFileSync('src/platform/i18n/index.ts', 'utf8');
const saveStart = actionSource.indexOf('export async function savePurchasingOrgDefinitionAction');
const deactivateStart = actionSource.indexOf('export async function deactivatePurchasingOrgAction');
const saveAction = actionSource.slice(saveStart, deactivateStart);
const saveServiceCallStart = saveAction.indexOf('await savePurchasingOrgDefinition({');
const saveServiceCallEnd = saveAction.indexOf('});', saveServiceCallStart) + 3;
const saveServiceCall = saveAction.slice(saveServiceCallStart, saveServiceCallEnd);
const deactivateAction = actionSource.slice(deactivateStart);

describe('SCR-017 Purchasing Organisation protected-action contract', () => {
  it('requires a verified session and exact define capability before each service write', () => {
    expect(actionSource).toContain("const ACTIVITY = 'CFG.PROC.PURORG.DEFINE'");
    for (const [action, service] of [
      [saveAction, 'savePurchasingOrgDefinition'],
      [deactivateAction, 'deactivatePurchasingOrg'],
    ]) {
      expect(action).toContain('requireSession(ROUTE)');
      expect(action).toContain('requireCapability(ACTIVITY, session)');
      expect(action.indexOf('await requireCapability')).toBeLessThan(
        action.indexOf(`await ${service}(`),
      );
      expect(action).toContain('client: session.user.client');
      expect(action).toContain('changedBy: session.user.username');
    }
  });

  it('maps only the approved definition fields and never trusts tenant, actor or assignment form values', () => {
    expect(saveAction).toContain("mode: read(form, 'mode') as PurchasingOrgMaintenanceMode");
    expect(saveAction).toContain("purchasingOrg: code");
    expect(saveAction).toContain("name: read(form, 'name')");
    expect(deactivateAction).toContain('await deactivatePurchasingOrg({');
    for (const field of ['client', 'changedBy', 'companyCode', 'plant', 'isActive']) {
      expect(saveAction).not.toMatch(new RegExp(`read\\(form,\\s*['\"]${field}['\"]\\)`));
      expect(deactivateAction).not.toMatch(new RegExp(`read\\(form,\\s*['\"]${field}['\"]\\)`));
    }
    expect(saveServiceCall).not.toContain('companyCode:');
    expect(saveServiceCall).not.toContain('plant:');
    expect(saveServiceCall).not.toContain('isActive:');
  });

  it('keeps deactivation separate, revalidates the workbench and exposes translated outcomes', () => {
    expect(actionSource).toContain('export async function deactivatePurchasingOrgAction');
    expect(actionSource).toContain('function revalidatePurchasingOrgViews()');
    expect(actionSource).toContain("revalidatePath('/config')");
    for (const key of [
      'purchasingOrg.created',
      'purchasingOrg.changed',
      'purchasingOrg.unchanged',
      'purchasingOrg.deactivated',
      'purchasingOrg.alreadyInactive',
    ]) {
      expect(i18n).toContain(`'${key}':`);
    }
    expect(actionSource).not.toMatch(/\.delete\s*\(/);
    expect(actionSource).not.toMatch(/reactivate|hard.delete/i);
  });

  it('retains exact, Configurator-wildcard and Administrator-wildcard matching', () => {
    expect(hasCapability([capability], capability)).toBe(true);
    expect(hasCapability(['CFG.*'], capability)).toBe(true);
    expect(hasCapability(['*'], capability)).toBe(true);
    expect(hasCapability([], capability)).toBe(false);
  });
});
