import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasCapability } from '../src/platform/auth/session';
import { plantCompanyCodeAssignmentInputSchema } from '../src/modules/foundation/plant-company-code-assignment';

const capability = 'CFG.ORG.PLANT.ASSIGN_COMPANY';
const seedSource = readFileSync('scripts/seed.ts', 'utf8');
const capabilitySeed = seedSource.slice(seedSource.indexOf('const CAPABILITIES'), seedSource.indexOf('async function main()'));
const service = readFileSync('src/modules/foundation/plant-company-code-assignment.ts', 'utf8');
const actions = readFileSync('src/app/config/plants/actions.ts', 'utf8');
const action = actions.slice(actions.indexOf('export async function assignPlantCompanyCodeAction'));
const valid = {
  client: 'T126',
  changedBy: 'PLANT_ASSIGNER',
  plant: ' P126 ',
  companyCode: ' 2000 ',
};

describe('Plant Company Code initial-assignment contract', () => {
  it('accepts only the Plant and Company Code assignment values plus service identity', () => {
    expect(plantCompanyCodeAssignmentInputSchema.parse(valid)).toMatchObject({
      client: 'T126',
      changedBy: 'PLANT_ASSIGNER',
      plant: 'P126',
      companyCode: '2000',
    });
    expect(() => plantCompanyCodeAssignmentInputSchema.parse({ ...valid, isActive: false })).toThrow();
    expect(() => plantCompanyCodeAssignmentInputSchema.parse({ ...valid, address: 'forged' })).toThrow();
    expect(() => plantCompanyCodeAssignmentInputSchema.parse({ ...valid, actor: 'FORGED' })).toThrow();
  });

  it('registers assignment authority separately as non-posting and keeps activity prerequisites explicit', () => {
    expect(capabilitySeed).toContain(
      "{ code: 'CFG.ORG.PLANT.ASSIGN_COMPANY', module: 'FND', action: 'CONFIGURE', posting: false, description: 'Assign an unassigned Plant to a Company Code' },",
    );
    expect(capabilitySeed).not.toMatch(/role_capability/i);
    expect(seedSource).toContain(
      "{ code: 'CFG.ORG.PLANT.ASSIGN_COMPANY', area: 'ENTERPRISE_STRUCTURE', title: 'Assign plant to company code', kind: 'ASSIGN', prerequisites: ['CFG.ORG.PLANT.DEFINE'], enables: 'Plant accounting', wizardStage: 'ONBOARDING', route: '/config/plants' },",
    );
    expect(hasCapability([capability], capability)).toBe(true);
    expect(hasCapability(['CFG.*'], capability)).toBe(true);
    expect(hasCapability(['*'], capability)).toBe(true);
    expect(hasCapability(['CFG.ORG.PLANT.DEFINE'], capability)).toBe(false);
  });

  it('requires the distinct capability and derives tenant/actor only from the verified session', () => {
    expect(action).toContain("requireSession(ROUTE)");
    expect(action).toContain("requireCapability(PLANT_ASSIGNMENT, session)");
    expect(action.indexOf('requireCapability(PLANT_ASSIGNMENT, session)')).toBeLessThan(
      action.indexOf('await assignPlantCompanyCode({'),
    );
    expect(action).toContain('client: session.user.client');
    expect(action).toContain('changedBy: session.user.username');
    expect(action).not.toMatch(/client:\s*read\(/);
    expect(action).not.toMatch(/changedBy:\s*read\(/);
    expect(action).toContain("read(form, 'plant')");
    expect(action).toContain("read(form, 'companyCode')");
  });

  it('serializes an initial-only assignment, validates active tenant-local Company Codes, and refuses replacement', () => {
    expect(service).toContain('.strict()');
    expect(service).toContain('pg_advisory_xact_lock');
    expect(service).toContain(".for('update')");
    expect(service).toContain("'CFG.ORG.PLANT.DEFINE'");
    expect(service).toContain('eq(companyCode.client, client)');
    expect(service).toContain('eq(companyCode.isActive, true)');
    expect(service).toContain('isNull(plant.companyCode)');
    expect(service).toContain('Reassignment and unassignment are deferred until after full application development.');
  });

  it('records assignment history and completes only the separate assignment activity', () => {
    expect(service).toContain("objectClass: 'plant'");
    expect(service).toContain("transactionCode: ASSIGNMENT_ACTIVITY");
    expect(service).toContain("securityRelevantFields: ['companyCode']");
    expect(service).toContain('await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy)');
  });
});
