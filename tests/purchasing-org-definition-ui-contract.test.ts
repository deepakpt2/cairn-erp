import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const capability = 'CFG.PROC.PURORG.DEFINE';
const page = readFileSync('src/app/config/purchasing-orgs/page.tsx', 'utf8');
const form = readFileSync('src/app/config/purchasing-orgs/PurchasingOrgDefinitionForm.tsx', 'utf8');
const deactivate = readFileSync('src/app/config/purchasing-orgs/DeactivatePurchasingOrgForm.tsx', 'utf8');
const actions = readFileSync('src/app/config/purchasing-orgs/actions.ts', 'utf8');
const workbench = readFileSync('src/app/config/page.tsx', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');

function inputTag(name: string, source = form, tag: 'input' | 'textarea' = 'input') {
  const marker = `name="${name}"`;
  const position = source.indexOf(marker);
  if (position < 0) return '';
  const start = source.lastIndexOf(`<${tag}`, position);
  const end = source.indexOf('>', position);
  return start < 0 || end < 0 ? '' : source.slice(start, end + 1);
}

describe('SCR-017 Purchasing Organisation definition UI contract', () => {
  it('uses a verified session, derives tenant scope from it and gates maintenance on the exact capability', () => {
    expect(page).toContain(`const PURCHASING_ORG_DEFINE = '${capability}'`);
    expect(page).toContain("requireSession('/config/purchasing-orgs')");
    expect(page).toContain('const client = session.user.client');
    expect(page).toContain('can(session, PURCHASING_ORG_DEFINE)');
    expect(page).toContain('where(eq(purchasingOrgTable.client, client))');
    expect(page).toContain('const creating = params.new === \'1\' && !selectionRequested && canMaintain');
    // SM12 gates editing on the change lock as well: a session that holds only DISPLAY may not
    // submit, so the literal names the lock. `displayOnlyMessage` and `ChangeLock` above are the
    // other half of that same line.
    expect(page).toContain(
      "const editing = Boolean(params.edit && selected && canMaintain && changeLock?.mode === 'CHANGE')",
    );
    expect(page).toContain('getPurchasingOrgDefinitionVersion(client, selected.purchasingOrg)');
    expect(page).not.toContain('params.client');
    expect(page).not.toContain('searchParams.client');
  });

  it('limits the definition form to code/name/reason and makes the code immutable after creation', () => {
    expect(form).toContain('useActionState<PurchasingOrgMaintenanceActionState, FormData>(\n    savePurchasingOrgDefinitionAction');
    expect(form).toContain('name="mode" value={mode}');
    expect(form).toContain('name="expectedVersion" value={version}');
    expect(inputTag('purchasingOrg')).toContain('minLength={2}');
    expect(inputTag('purchasingOrg')).toContain('maxLength={10}');
    expect(inputTag('purchasingOrg')).toContain('pattern="[A-Z0-9]{2,10}"');
    expect(inputTag('name')).toContain('maxLength={160}');
    expect(inputTag('reason', form, 'textarea')).toContain('maxLength={500}');
    expect(form).toContain('readOnly />');
    expect(form).not.toMatch(/name="(client|changedBy|companyCode|plant|isActive)"/);
    expect(deactivate).not.toMatch(/name="(client|changedBy|companyCode|plant|isActive)"/);
    expect(page).toContain("t('purchasingOrg.assignedCompanyCode')");
    expect(page).toContain("t('purchasingOrg.plantAssignments')");
    expect(page).toContain("t('purchasingOrg.plantAssignmentReadOnlyNote')");
  });

  it('shows tenant-local history and supports retained deactivation without delete or reactivation', () => {
    expect(page).toContain("changeHistory(tx, client, 'purchasing_org', selected.purchasingOrg)");
    expect(page).toContain("t('purchasingOrg.retentionNote')");
    expect(page).toContain('DeactivatePurchasingOrgForm');
    expect(deactivate).toContain('deactivatePurchasingOrgAction');
    expect(deactivate).toContain('name="expectedVersion"');
    expect(deactivate).toContain('name="reason"');
    expect(page).toContain("t('purchasingOrg.companyCodePrerequisite')");
    expect(actions).toContain('deactivatePurchasingOrgAction');
    expect(actions).not.toMatch(/\.delete\s*\(/);
    expect(actions).not.toMatch(/reactivate|hard.delete/i);
    expect(form).not.toMatch(/hardDelete|reactivate/i);
    expect(deactivate).not.toMatch(/hardDelete|reactivate/i);
    expect(messages).toContain('Hard delete and reactivation are not available.');
    expect(messages).toContain('Supplier-purchasing use requires exactly one Company Code assignment');
  });

  it('registers the built workbench route and OX08 definition activity in the term registry', () => {
    expect(workbench).toContain("'/config/purchasing-orgs'");
    expect(registry).toContain(`ourCode: '${capability}'`);
    expect(registry).toContain("route: '/config/purchasing-orgs', tier: 'TIER_2_CONFIGURED'");
    expect(registry).toContain("aliases: ['OX08']");
  });
});
