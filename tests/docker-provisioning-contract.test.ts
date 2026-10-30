import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const compose = readFileSync('docker-compose.yml', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');
const bootstrap = readFileSync('scripts/bootstrap.ts', 'utf8');
const testDb = readFileSync('scripts/test-db.ts', 'utf8');

describe('Docker provisioning and walkthrough packaging contract', () => {
  it('explicitly packages the walkthrough seed in operations and app images', () => {
    expect(dockerfile.match(/COPY walkthrough-seed\.ts \/app\/walkthrough-seed\.ts/g)).toHaveLength(1);
    expect(dockerfile).toMatch(/COPY --chown=cairn:cairn walkthrough-seed\.ts \/app\/walkthrough-seed\.ts/);
    expect(compose).toContain('./walkthrough-seed.ts:/app/walkthrough-seed.ts:ro');
  });

  it('initializes references after migrations and before global seeding in every bootstrap path', () => {
    const bootstrapSteps = bootstrap.slice(bootstrap.indexOf('const STEPS = ['));
    expect(bootstrapSteps.indexOf("script: 'src/platform/db/migrate.ts'")).toBeLessThan(bootstrapSteps.indexOf("script: 'scripts/seed-reference.ts'"));
    expect(bootstrapSteps.indexOf("script: 'scripts/seed-reference.ts'")).toBeLessThan(bootstrapSteps.indexOf("script: 'scripts/seed.ts'"));

    const testSteps = testDb.slice(testDb.indexOf('const steps = ['));
    expect(testSteps.indexOf("script: 'src/platform/db/migrate.ts'")).toBeLessThan(testSteps.indexOf("script: 'scripts/seed-reference.ts'"));
    expect(testSteps.indexOf("script: 'scripts/seed-reference.ts'")).toBeLessThan(testSteps.indexOf("script: 'scripts/seed.ts'"));
  });

  it('keeps walkthrough execution manual-only while initializing references during provisioning', () => {
    const command = dockerfile.match(/CMD \["sh", "-c", "([^"]+)"\]/)?.[1] ?? '';
    expect(command).toContain('npm run db:init-reference');
    expect(command.indexOf('npm run db:migrate')).toBeLessThan(command.indexOf('npm run db:init-reference'));
    expect(command.indexOf('npm run db:init-reference')).toBeLessThan(command.indexOf('npm run seed'));
    expect(command).not.toContain('walkthrough-seed');
    expect(packageJson).toContain('"db:init-reference": "tsx scripts/seed-reference.ts"');
    expect(compose).not.toMatch(/command:\s*.*walkthrough-seed/);
  });
});
