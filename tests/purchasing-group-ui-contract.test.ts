import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/config/purchasing-groups/page.tsx', 'utf8');
const grid = readFileSync('src/app/config/purchasing-groups/PurchasingGroupsGrid.tsx', 'utf8');
const action = readFileSync('src/app/config/purchasing-groups/actions.ts', 'utf8');
const workbench = readFileSync('src/app/config/page.tsx', 'utf8');

describe('SCR-019 Purchasing Groups screen contract', () => {
  it('registers the activity route and renders the tenant-scoped overview', () => {
    expect(page).toContain("requireSession('/config/purchasing-groups')");
    expect(page).toContain('listPurchasingGroupDefinitions(session.user.client)');
    expect(page).toContain("can(session, PURCHASING_GROUP_DEFINE)");
    expect(workbench).toContain("'/config/purchasing-groups'");
    expect(grid).toContain("t('purchasingGroup.screenTitle')");
  });

  it('renders all overview columns and the table-maintenance toolbar actions', () => {
    for (const key of ['code', 'description', 'telNoPurchGroup', 'faxNumber', 'telephone', 'extension', 'emailAddress']) {
      expect(grid).toContain(`t('purchasingGroup.${key}')`);
    }
    for (const key of ['newEntries', 'copy', 'delete', 'undo', 'save', 'more']) {
      expect(grid).toContain(`t('purchasingGroup.${key}')`);
    }
    expect(grid).toContain('useActionState');
    expect(grid).toContain('JSON.stringify(pendingChanges)');
    expect(grid).toContain('expectedVersion: row.version');
  });

  it('hides mutation actions without capability and protects writes server-side', () => {
    expect(grid).toContain('{canMaintain && (');
    expect(grid).toContain('readOnly={!canMaintain');
    expect(action).toContain("await requireCapability(ACTIVITY, session)");
    expect(action).toContain('client: session.user.client');
    expect(action).toContain('changedBy: session.user.username');
    expect(action).not.toContain("read(form, 'client')");
    expect(action).not.toContain("read(form, 'changedBy')");
  });
});
