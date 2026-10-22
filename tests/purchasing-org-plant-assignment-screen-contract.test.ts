import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/config/purchasing-orgs/assign-plant/page.tsx', 'utf8');
const form = readFileSync('src/app/config/purchasing-orgs/assign-plant/AssignPlant.tsx', 'utf8');
const action = readFileSync('src/app/config/purchasing-orgs/assign-plant/actions.ts', 'utf8');
const service = readFileSync('src/modules/purchasing/purchasing-org-plant-assignment.ts', 'utf8');
const definePage = readFileSync('src/app/config/purchasing-orgs/page.tsx', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');
const hub = readFileSync('src/app/config/page.tsx', 'utf8');

describe('purchasing organisation plant assignment screen contract', () => {
  it('stands on the assignment route and treats OX17 as a search alias', () => {
    expect(page).toContain("const ROUTE = '/config/purchasing-orgs/assign-plant'");
    expect(page).toContain('can(session, ACTIVITY)');
    expect(page).toContain('{ACTIVITY} · OX17');
    expect(page).not.toContain("'/ox17'");
    expect(seed).toContain("aliases: ['OX17']");
    expect(seed).toContain("route: '/config/purchasing-orgs/assign-plant'");
    const built = hub.slice(hub.indexOf('const BUILT_ROUTES'), hub.indexOf(']);', hub.indexOf('const BUILT_ROUTES')));
    expect(built).toContain("'/config/purchasing-orgs/assign-plant'");
  });

  it('takes the tenant from the session and does not enter a company code', () => {
    expect(action).toContain('client: session.user.client');
    expect(action).toContain('changedBy: session.user.username');
    expect(action).toContain("read(form, 'reason')");
    expect(action).toContain('requireCapability');
    expect(form).toContain('name="reason"');
    expect(form).toContain('name="purchasingOrg"');
    expect(form).toContain('name="plant"');
    expect(form).not.toMatch(/name="(client|changedBy|companyCode|status|version|postingPeriod)"/);
    expect(form).toContain('Check');
    expect(form).toContain('Save');
    expect(action).not.toContain('revalidatePath');
    expect(service).toContain('A posting period');
    expect(service).not.toMatch(/journal_entry|stock_quantity|from '..\/finance/);
  });

  it('maintains the standing pair and leaves the define page read-only', () => {
    expect(service).toContain('purchasingOrgPlant');
    expect(service).not.toContain('purchasing_organization_plant_assignment');
    expect(service).toContain('purchasingOrgMayBuyForPlant');
    expect(readFileSync('src/modules/purchasing/orders.ts', 'utf8')).toContain('assertPurchasingOrgForPlant');
    expect(readFileSync('src/modules/purchasing/requisitions.ts', 'utf8')).toContain('assertPurchasingOrgForPlant');
    expect(readFileSync('src/modules/purchasing/rfq.ts', 'utf8')).toContain('assertPurchasingOrgForPlant');
    expect(readFileSync('src/modules/purchasing/orders.ts', 'utf8')).toContain("documentType: 'PURCHASE_ORDER'");
    expect(definePage).toContain('href="/config/purchasing-orgs/assign-plant"');
    expect(definePage).not.toContain('assignPurchasingOrgPlant');
    expect(definePage).not.toContain('removePurchasingOrgPlant');
  });
});
