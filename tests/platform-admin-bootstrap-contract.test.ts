import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { platformBootstrapTokenMatches } from '../scripts/bootstrap-platform-admin';

const bootstrapSource = readFileSync('scripts/bootstrap-platform-admin.ts', 'utf8');

const OWNER_TOKEN = 'owner-bootstrap-token-generated-outside-the-repository-2026';

describe('deployment-owner platform-admin bootstrap boundary', () => {
  it('requires a matching high-entropy secret rather than tenant wildcard authority', () => {
    expect(platformBootstrapTokenMatches(OWNER_TOKEN, OWNER_TOKEN)).toBe(true);
    expect(platformBootstrapTokenMatches(OWNER_TOKEN, `${OWNER_TOKEN}x`)).toBe(false);
    expect(platformBootstrapTokenMatches('short', 'short')).toBe(false);
    expect(platformBootstrapTokenMatches(OWNER_TOKEN, '')).toBe(false);
  });

  it('requires hidden interactive owner confirmation, a separate live target, one-time marker and Cairn audit records', () => {
    expect(bootstrapSource).toMatch(/input\.setRawMode\(true\)/);
    expect(bootstrapSource).toMatch(/target\.username\.trim\(\)\.toLowerCase\(\) === ACTOR\.trim\(\)\.toLowerCase\(\)/);
    expect(bootstrapSource).toMatch(/userSession\.expiresAt} > now\(\)/);
    expect(bootstrapSource).toContain("objectClass, 'platform_admin_bootstrap'");
    expect(bootstrapSource).toContain('recordChange(tx');
    expect(bootstrapSource).toContain('auditAccessLog');
  });
});
