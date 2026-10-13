import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/config/purchasing-orgs/assign-company/page.tsx', 'utf8');
const form = readFileSync('src/app/config/purchasing-orgs/assign-company/PurchasingOrgCompanyCodeAssignmentForm.tsx', 'utf8');
const definitions = readFileSync('src/app/config/purchasing-orgs/page.tsx', 'utf8');
const workbench = readFileSync('src/app/config/page.tsx', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');

describe('SCR-018 Purchasing Organisation Company Code assignment UI', () => {
  it('uses a dedicated assignment route and exposes it from the definition page/workbench', () => {
    expect(page).toContain("requireSession('/config/purchasing-orgs/assign-company')");
    expect(page).toContain("const ASSIGNMENT = 'CFG.PROC.PURORG.ASSIGN_COMPANY'");
    expect(definitions).toContain('PURCHASING_ORG_ASSIGN_COMPANY');
    expect(definitions).toContain('/config/purchasing-orgs/assign-company');
    expect(workbench).toContain("'/config/purchasing-orgs/assign-company'");
  });

  it('shows only active Company Code choices and only for active unassigned organisations with authority', () => {
    expect(page).toContain('canAssign && hasEligibleOrganisations');
    expect(page).toContain('eq(companyCode.isActive, true)');
    expect(page).toContain('organisation.isActive && organisation.companyCode === null');
    expect(page).toContain('purchasingOrg.companyCode');
  });

  it('posts only the Purchasing Organisation and selected Company Code from the browser', () => {
    expect(form).toContain('name="purchasingOrg"');
    expect(form).toContain('name="companyCode"');
    expect(form).not.toContain('name="client"');
    expect(form).not.toContain('name="changedBy"');
  });

  it('keeps the assignment boundary and initial-only feedback in English messages', () => {
    expect(messages).toContain("'purchasingOrg.companyAssignmentTitle': 'Assign Purchasing Organisation to Company Code'");
    expect(messages).toContain("'purchasingOrg.companyAssignmentInitialOnly': 'Initial assignment only.");
    expect(messages).toContain("'purchasingOrg.companyAssigned': 'Purchasing Organisation {org} assigned to Company Code {company}; change history recorded.'");
  });
});
