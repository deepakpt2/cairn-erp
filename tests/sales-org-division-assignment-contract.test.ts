import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STANDARD_STRUCTURE } from '../src/platform/tenancy/standard-structure';

const service = readFileSync('src/modules/foundation/sales-org-division-assignment.ts', 'utf8');
const schema = readFileSync('src/modules/foundation/schema.ts', 'utf8');
const migration = readFileSync('drizzle/0029_sales_org_division_assignment.sql', 'utf8');
const rlsMigration = readFileSync('drizzle/9024_sales_org_division_policies.sql', 'utf8');
const standardConfig = readFileSync('src/modules/foundation/standard-config.ts', 'utf8');
const standardStructure = readFileSync('src/platform/tenancy/standard-structure.ts', 'utf8');
const tenancy = readFileSync('src/platform/tenancy/index.ts', 'utf8');
const salesOrgMaintenance = readFileSync('src/modules/foundation/sales-organization-maintenance.ts', 'utf8');
const divisionMaintenance = readFileSync('src/modules/foundation/distribution-channel-division-maintenance.ts', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');

const assignmentActivity = 'CFG.ORG.SALESORG.ASSIGN_DIVISION';

describe('OVXA Sales Organization / Division service and database contract', () => {
  it('uses a tenant-keyed many-to-many relation with exact key checks and RLS', () => {
    const relation = schema.slice(schema.indexOf("export const salesOrgDivision = pgTable("));
    expect(relation).toContain("pgTable(\n  'sales_org_division'");
    expect(relation).toContain('primaryKey({ columns: [t.client, t.salesOrg, t.division] })');
    expect(relation).toContain("'^[A-Z0-9]{4}$'");
    expect(relation).toContain("'^[A-Z0-9]{2}$'");
    expect(relation).toContain('salesOrg.client, salesOrg.salesOrg');
    expect(relation).toContain('division.client, division.division');
    expect(migration).toContain('PRIMARY KEY (client, sales_org, division)');
    expect(migration).toContain('FOREIGN KEY (client, sales_org)');
    expect(migration).toContain('FOREIGN KEY (client, division)');
    expect(migration).toContain('INSERT INTO sales_org_division (client, sales_org, division, created_by)');
    expect(migration).toContain('SELECT DISTINCT client, sales_org, division');
    expect(rlsMigration).toContain('ALTER TABLE sales_org_division ENABLE ROW LEVEL SECURITY');
    expect(rlsMigration).toContain('ALTER TABLE sales_org_division FORCE ROW LEVEL SECURITY');
    expect(rlsMigration).toContain('client = current_setting(\'cairn.client\', true)');
  });

  it('offers active tenant-local F4 values, validates active definitions and requires both definitions complete', () => {
    expect(service).toContain(`const ASSIGNMENT_ACTIVITY = '${assignmentActivity}'`);
    expect(service).toContain("const PREREQUISITES = ['CFG.ORG.SALESORG.DEFINE', 'CFG.ORG.DIVISION.DEFINE'] as const");
    expect(service).toContain('eq(salesOrg.isActive, true)');
    expect(service).toContain('eq(divisionDefinition.isActive, true)');
    expect(service).toContain('salesOrg: z.string().trim().regex(\n    /^[A-Z0-9]{4}$/');
    expect(service).toContain('division: z.string().trim().regex(\n    /^[A-Z0-9]{2}$/');
    expect(service).toContain('await requireDefinitionPrerequisites(tx, client)');
    expect(service).toContain('for(\'update\')');
    expect(service).toContain('eq(configActivityStatus.status, \'COMPLETED\')');
    expect(service).toContain('const missing = PREREQUISITES.filter((code) => !completed.has(code))');
  });

  it('makes duplicate assignment an idempotent no-op and serializes concurrent pair writes', () => {
    expect(service).toContain('pg_advisory_xact_lock(hashtextextended(');
    expect(service).toContain('`${client}/sales_org_division/${salesOrgCode}/${divisionCode}`');
    const existing = service.indexOf('if (existing) {', service.indexOf('export async function assignSalesOrgDivision('));
    const insert = service.indexOf('.insert(salesOrgDivision)', existing);
    expect(existing).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(existing);
    const duplicateBranch = service.slice(existing, insert);
    expect(duplicateBranch).toContain('assigned: false as const');
    expect(duplicateBranch).toContain('markActivityComplete');
    expect(duplicateBranch).not.toContain('recordChange');
    expect(service).toContain('.onConflictDoNothing()');
  });

  it('blocks pair removal on any Sales Area channel, preserves delete history and completes the activity', () => {
    const start = service.indexOf('export async function unassignSalesOrgDivision(');
    const dependentCheck = service.indexOf('const [dependentArea]', start);
    const blocked = service.indexOf('if (dependentArea)', dependentCheck);
    const dependencyQuery = service.slice(dependentCheck, blocked);
    expect(dependencyQuery).toContain('eq(salesArea.client, client)');
    expect(dependencyQuery).toContain('eq(salesArea.salesOrg, values.salesOrg)');
    expect(dependencyQuery).toContain('eq(salesArea.division, values.division)');
    expect(dependencyQuery).not.toMatch(/eq\(salesArea\.distributionChannel/);
    expect(dependencyQuery).not.toContain('isActive');
    const deleteAt = service.indexOf('.delete(salesOrgDivision)', blocked);
    const auditAt = service.indexOf('changeType: \'DELETE\'', deleteAt);
    expect(deleteAt).toBeGreaterThan(blocked);
    expect(auditAt).toBeGreaterThan(deleteAt);
    expect(service.slice(auditAt, service.indexOf('await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy)', auditAt)))
      .toContain('before:');
  });

  it('seeds and audits the standard pair before its default Sales Area, and retains definition dependencies', () => {
    // SCR-032 moved the standard pair and its default sales area out of the package and
    // into the structure builder; the ordering this test exists to protect — the pair
    // audited before the sales area that depends on it — is asserted where they now live.
    const pairAt = standardStructure.indexOf('.insert(salesOrgDivision)');
    const areaAt = standardStructure.indexOf('.insert(salesArea)', pairAt);
    expect(pairAt).toBeGreaterThan(-1);
    expect(areaAt).toBeGreaterThan(pairAt);
    const standardPair = standardStructure.slice(pairAt, areaAt);
    expect(STANDARD_STRUCTURE.division).toBe('01');
    expect(standardPair).toContain('division: STANDARD_STRUCTURE.division');
    expect(standardPair).toContain("objectClass: 'sales_org_division'");
    expect(standardPair).toContain(`transactionCode: '${assignmentActivity}'`);
    expect(standardPair).toContain("changeType: 'CREATE'");
    expect(standardPair).toContain("securityRelevantFields: ['salesOrg', 'division']");
    // Tenant creation no longer marks the assignment: nothing at creation links a sales
    // organisation to a division any more.
    expect(tenancy).not.toContain(`'${assignmentActivity}'`);
    expect(seed).toContain(`{ code: '${assignmentActivity}'`);
    expect(salesOrgMaintenance).toContain('salesOrgDivision');
    expect(salesOrgMaintenance).toContain('Division assignments and cannot be deactivated');
    expect(divisionMaintenance).toContain('salesOrgDivision');
    expect(divisionMaintenance).toContain('still assigned to one or more Sales Organizations');
  });
});
