import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  plantDefinitionValuesSchema,
  plantMaintenanceInputSchema,
} from '../src/modules/foundation/plant-maintenance';

const service = readFileSync('src/modules/foundation/plant-maintenance.ts', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');
const capabilitySeed = seed.slice(seed.indexOf('const CAPABILITIES'), seed.indexOf('async function main()'));

const base = {
  client: 'T001',
  changedBy: 'plant.editor',
  mode: 'CREATE' as const,
  plant: ' P100 ',
  expectedVersion: 0,
  values: {
    name: ' Main site ',
    country: 'kw',
  },
};

describe('Plant definition maintenance contract', () => {
  it('normalizes required identity and country and supplies language and descriptive-role defaults', () => {
    const parsed = plantDefinitionValuesSchema.parse({ name: ' Main site ', country: 'kw' });
    expect(parsed).toMatchObject({
      name: 'Main site',
      country: 'KW',
      language: 'EN',
      isProductionSite: true,
      isStorageSite: true,
    });
  });

  it('allows both Cairn descriptive role flags to be false and retains the optional Factory Calendar key without reference validation', () => {
    const parsed = plantDefinitionValuesSchema.parse({
      name: 'Main site',
      country: 'KW',
      factoryCalendar: 'NO-MASTER',
      language: 'en',
      isProductionSite: false,
      isStorageSite: false,
    });
    expect(parsed).toMatchObject({
      country: 'KW',
      factoryCalendar: 'NO-MASTER',
      language: 'EN',
      isProductionSite: false,
      isStorageSite: false,
    });
  });

  it('trims optional structured address fields and turns blank values into empty fields', () => {
    const parsed = plantDefinitionValuesSchema.parse({
      name: 'Main site',
      country: 'KW',
      street: '  1 River Road  ',
      houseNumber: '  8A ',
      postalCode: ' ',
      city: ' Al Jahra ',
      region: '',
    });
    expect(parsed).toMatchObject({
      street: '1 River Road',
      houseNumber: '8A',
      postalCode: undefined,
      city: 'Al Jahra',
      region: undefined,
      language: 'EN',
    });
  });

  it('requires a valid Plant key, name, two-letter country and two-letter language, within schema limits', () => {
    expect(plantMaintenanceInputSchema.parse(base).plant).toBe('P100');
    expect(() => plantMaintenanceInputSchema.parse({ ...base, plant: 'P'.repeat(11) })).toThrow();
    expect(() => plantDefinitionValuesSchema.parse({ name: ' ', country: 'KW' })).toThrow();
    expect(() => plantDefinitionValuesSchema.parse({ name: 'Main', country: 'KWT' })).toThrow();
    expect(() => plantDefinitionValuesSchema.parse({ name: 'Main', country: 'KW', language: 'ENG' })).toThrow();
    expect(() => plantDefinitionValuesSchema.parse({ name: 'N'.repeat(161), country: 'KW' })).toThrow();
    expect(() => plantDefinitionValuesSchema.parse({ name: 'Main', country: 'KW', street: 'S'.repeat(161) })).toThrow();
    expect(() => plantDefinitionValuesSchema.parse({ name: 'Main', country: 'KW', houseNumber: 'H'.repeat(41) })).toThrow();
    expect(() => plantDefinitionValuesSchema.parse({ name: 'Main', country: 'KW', postalCode: 'P'.repeat(21) })).toThrow();
    expect(() => plantDefinitionValuesSchema.parse({ name: 'Main', country: 'KW', factoryCalendar: 'F'.repeat(11) })).toThrow();
  });

  it('rejects assignment, default-location, legacy-address, and active-status fields at the strict service boundary', () => {
    for (const unsupported of ['companyCode', 'defaultStorageLocation', 'address', 'isActive']) {
      expect(() =>
        plantMaintenanceInputSchema.parse({
          ...base,
          values: { ...base.values, [unsupported]: 'forged' },
        }),
      ).toThrow();
    }
    expect(() => plantMaintenanceInputSchema.parse({ ...base, companyCode: 'C100' })).toThrow();
  });

  it('registers the exact non-posting Plant definition capability without adding a role grant', () => {
    expect(capabilitySeed).toContain(
      "{ code: 'CFG.ORG.PLANT.DEFINE', module: 'FND', action: 'CONFIGURE', posting: false, description: 'Define and change tenant-scoped Plant records' },",
    );
    expect(capabilitySeed).not.toMatch(/role_capability/i);
  });

  it('serializes create/change by tenant and Plant key and checks the audit-backed expected version', () => {
    expect(service).toContain('pg_advisory_xact_lock');
    expect(service).toContain(".for('update')");
    expect(service).toContain('count(*)::int');
    expect(service).toContain('expectedVersion !== version');
    expect(service).toContain('expectedVersion !== 0 || version !== 0');
  });

  it('audits create and change through the exact Plant activity and marks that activity complete', () => {
    expect(service).toContain("changeType: 'CREATE'");
    expect(service).toContain("changeType: 'CHANGE'");
    expect(service).toContain("transactionCode: PLANT_ACTIVITY");
    expect(service).toContain("const PLANT_ACTIVITY = 'CFG.ORG.PLANT.DEFINE'");
    expect(service).toContain('await markActivityComplete(tx, client, PLANT_ACTIVITY, changedBy)');
    expect(service).toContain('before: auditSnapshot(plantCode, current)');
    expect(service).toContain('after: auditSnapshot(plantCode, fields)');
  });

  it('keeps company assignment, default storage location, legacy address, and active status outside the write and audit projections', () => {
    const fieldsBuilder = service.slice(
      service.indexOf('function definitionFields'),
      service.indexOf('function auditSnapshot'),
    );
    const updateSet = service.slice(
      service.indexOf('.update(plant)'),
      service.indexOf('.where(and(eq(plant.client', service.indexOf('.update(plant)')),
    );
    const auditStart = service.indexOf('return {\n    plant: plantCode,', service.indexOf('function auditSnapshot'));
    const auditEnd = service.indexOf('\n  };', auditStart);
    const auditProjection = service.slice(auditStart, auditEnd);

    for (const projection of [fieldsBuilder, updateSet, auditProjection]) {
      expect(projection).not.toMatch(/companyCode|defaultStorageLocation|address|isActive/);
    }
    expect(service).not.toContain('factoryCalendarReference');
    expect(service).not.toContain('validateFactoryCalendar');
  });
});
