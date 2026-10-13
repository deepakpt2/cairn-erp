import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const service = readFileSync('src/modules/foundation/purchasing-org-company-code-assignment.ts', 'utf8');
const action = readFileSync('src/app/config/purchasing-orgs/assign-company/actions.ts', 'utf8');
const page = readFileSync('src/app/config/purchasing-orgs/assign-company/page.tsx', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-018 initial Purchasing Organisation -> Company Code assignment', () => {
  it('limits the service to one active same-tenant Company Code and refuses replacement or clearing', () => {
    expect(service).toContain("const ASSIGNMENT_ACTIVITY = 'CFG.PROC.PURORG.ASSIGN_COMPANY'");
    expect(service).toContain("eq(companyCode.client, client)");
    expect(service).toContain("eq(companyCode.isActive, true)");
    expect(service).toContain("eq(purchasingOrg.isActive, true)");
    expect(service).toContain('isNull(purchasingOrg.companyCode)');
    expect(service).toContain('initial-assignment slice');
    expect(service).toContain('cannot replace or clear an existing Company Code assignment');
    expect(service).toContain("objectClass: 'purchasing_org'");
    expect(service).toContain("securityRelevantFields: ['companyCode']");
  });

  it('derives tenant and actor from session and checks the exact assignment capability', () => {
    expect(action).toContain("const ACTIVITY = 'CFG.PROC.PURORG.ASSIGN_COMPANY'");
    expect(action).toContain('requireSession(ROUTE)');
    expect(action).toContain('requireCapability(ACTIVITY, session)');
    expect(action).toContain('client: session.user.client');
    expect(action).toContain('changedBy: session.user.username');
    expect(action).not.toContain("read(form, 'client')");
    expect(action).not.toContain("read(form, 'changedBy')");
  });

  it('registers the workbench route and capability without an unverified OX01 lookup alias', () => {
    expect(seed).toContain("code: 'CFG.PROC.PURORG.ASSIGN_COMPANY', area: 'MATERIALS_MANAGEMENT'");
    expect(seed).toContain("route: '/config/purchasing-orgs/assign-company'");
    expect(seed).toContain("code: 'CFG.PROC.PURORG.ASSIGN_COMPANY', module: 'PROC'");
    expect(seed).not.toContain("aliases: ['OX01']");
  });

  it('offers actions only for active unassigned organisations and authorized users', () => {
    expect(page).toContain("const canAssign = can(session, ASSIGNMENT)");
    expect(page).toContain("eq(companyCode.isActive, true)");
    expect(page).toContain('organisation.isActive && organisation.companyCode === null');
    expect(page).toContain('PurchasingOrgCompanyCodeAssignmentForm');
    expect(page).toContain("requireSession('/config/purchasing-orgs/assign-company')");
  });
});
