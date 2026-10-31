import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const testDb = readFileSync('scripts/test-db.ts', 'utf8');
const referenceInitializer = readFileSync('scripts/seed-reference.ts', 'utf8');
const referenceDefinitions = readFileSync('scripts/standard-reference-data.ts', 'utf8');

describe('scratch database reference-data provisioning contract', () => {
  it('always initializes standard reference data after migrations, including in --no-seed mode', () => {
    const stepsStart = testDb.indexOf('const steps = [');
    const stepsEnd = testDb.indexOf('for (const step of steps)', stepsStart);
    const steps = testDb.slice(stepsStart, stepsEnd);
    const migrationIndex = steps.indexOf("script: 'src/platform/db/migrate.ts'");
    const referenceIndex = steps.indexOf("script: 'scripts/seed-reference.ts'");
    const noSeedIndex = steps.indexOf("argv.includes('--no-seed')");
    const globalSeedIndex = steps.indexOf("script: 'scripts/seed.ts'");

    expect(migrationIndex).toBeGreaterThanOrEqual(0);
    expect(referenceIndex).toBeGreaterThan(migrationIndex);
    expect(noSeedIndex).toBeGreaterThan(referenceIndex);
    expect(globalSeedIndex).toBeGreaterThan(noSeedIndex);
    expect(referenceInitializer).toContain('initializeStandardReferenceData(client)');
    expect(referenceDefinitions).toContain("['USD', 'US Dollar', 2");
  });
});
