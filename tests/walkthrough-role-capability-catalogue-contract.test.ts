import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const walkthrough = readFileSync('walkthrough-seed.ts', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');
const deliveryMigration = readFileSync('drizzle/9191_sales_delivery_billing.sql', 'utf8');
const roleAdminMigration = readFileSync('drizzle/9209_platform_role_capability_administration.sql', 'utf8');

describe('walkthrough role capability catalogue contract', () => {
  it('has all 20 distinct required capability codes in the global registration sources', () => {
    const requiredBlock = walkthrough.match(/const requiredCapabilities = \[([\s\S]*?)\];/)?.[1] ?? '';
    const required = [...requiredBlock.matchAll(/'([A-Z0-9.]+)'/g)].map((match) => match[1]);
    const seedBlock = seed.match(/const CAPABILITIES:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1] ?? '';
    const registered = new Set([...seedBlock.matchAll(/code: '([A-Z0-9.]+)'/g)].map((match) => match[1]));
    for (const match of deliveryMigration.matchAll(/'(SALES\.DELIVERY\.(?:CREATE|PICK))'/g)) registered.add(match[1]);
    for (const match of roleAdminMigration.matchAll(/\('([A-Z0-9.]+)'/g)) registered.add(match[1]);
    expect(required).toHaveLength(20);
    expect(new Set(required).size).toBe(20);
    expect(required.filter((code) => !registered.has(code))).toEqual([]);
  });
});
