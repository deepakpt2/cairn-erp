import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const cases = [
  ['src/modules/inventory/goods-receipt.ts', 'goods receipt'],
  ['src/modules/inventory/goods-issue.ts', 'goods issue'],
  ['src/modules/platform/organisation-scope-admin.ts', 'business-scope administration'],
] as const;

describe('live role lifecycle authorization boundaries', () => {
  it.each(cases)('%s revalidates active role capability rows under lock (%s)', (path) => {
    const source = readFileSync(`${root}/${path}`, 'utf8');
    expect(source).toMatch(/join role r on r\.client = ur\.client and r\.code = ur\.role_code and r\.is_active = true/);
    expect(source).toMatch(/for share of ur, r, rc/);
  });
});
