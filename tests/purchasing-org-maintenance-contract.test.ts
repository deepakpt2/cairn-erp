import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/modules/foundation/purchasing-org-maintenance.ts', 'utf8');
const definitionValuesStart = source.indexOf('export const purchasingOrgDefinitionValuesSchema');
const modeStart = source.indexOf('export const purchasingOrgMaintenanceModeSchema');
const definitionValues = source.slice(definitionValuesStart, modeStart);
const maintenanceInputStart = source.indexOf('export const purchasingOrgMaintenanceInputSchema');
const deactivationInputStart = source.indexOf('export const purchasingOrgDeactivationInputSchema');
const maintenanceInput = source.slice(maintenanceInputStart, deactivationInputStart);

describe('SCR-017 Purchasing Organisation definition service contract', () => {
  it('uses the approved 2–10 uppercase alphanumeric key and required 160-character name', () => {
    expect(source).toContain("z.string().trim().regex(/^[A-Z0-9]{2,10}$/)");
    expect(definitionValues).toContain("name: z.string().trim().min(1).max(160)");
    expect(definitionValues).toContain('.strict()');
  });

  it('keeps Company Code and Plant assignment out of the OX08 input contract', () => {
    expect(definitionValues).not.toMatch(/companyCode|plant/i);
    expect(maintenanceInput).not.toMatch(/companyCode|plant/i);
    expect(source).toContain('companyCode: null');
    expect(source).toContain('const PURCHASING_ORG_ACTIVITY = \'CFG.PROC.PURORG.DEFINE\'');
  });

  it('supports create/change plus a distinct retained deactivation, with audit and optimistic versioning', () => {
    expect(source).toContain("z.enum(['CREATE', 'CHANGE'])");
    expect(source).toContain('export async function savePurchasingOrgDefinition');
    expect(source).toContain('export async function deactivatePurchasingOrg');
    expect(source).toContain('purchasingOrgAuditVersion');
    expect(source).toContain('pg_advisory_xact_lock');
    expect(source).toContain('recordChange(tx');
    expect(source).toContain('markActivityComplete(tx, client, PURCHASING_ORG_ACTIVITY, changedBy)');
    expect(source).not.toMatch(/\.delete\s*\(/);
    expect(source).not.toMatch(/'ACTIVATE'|'REACTIVATE'/);
  });

  it('preserves an assigned Company Code and all Plant links when changing or deactivating the definition', () => {
    expect(source).toContain(".set({ name: fields.name, changedBy, changedAt: new Date() })");
    expect(source).toContain(".set({ isActive: false, changedBy, changedAt: new Date() })");
    expect(source).not.toContain('purchasingOrgPlant');
  });
});
