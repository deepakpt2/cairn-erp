import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { platformBootstrapTokenMatches } from '../scripts/bootstrap-platform-admin';

const bootstrapSource = readFileSync('scripts/bootstrap-platform-admin.ts', 'utf8');
const helperSource = readFileSync('src/modules/platform/platform-admin-bootstrap.ts', 'utf8');
const tenancySource = readFileSync('src/platform/tenancy/index.ts', 'utf8');

const OWNER_TOKEN = 'owner-bootstrap-token-generated-outside-the-repository-2026';

describe('deployment-owner platform-admin bootstrap boundary', () => {
  it('requires a matching high-entropy secret rather than tenant wildcard authority', () => {
    expect(platformBootstrapTokenMatches(OWNER_TOKEN, OWNER_TOKEN)).toBe(true);
    expect(platformBootstrapTokenMatches(OWNER_TOKEN, `${OWNER_TOKEN}x`)).toBe(false);
    expect(platformBootstrapTokenMatches('short', 'short')).toBe(false);
    expect(platformBootstrapTokenMatches(OWNER_TOKEN, '')).toBe(false);
  });

  it('requires hidden interactive owner confirmation, a separate live target, one-time marker and Cairn audit records', () => {
    // These three stay in the CLI, which is the only path an operator runs by hand.
    expect(bootstrapSource).toMatch(/input\.setRawMode\(true\)/);
    expect(bootstrapSource).toMatch(/target\.username\.trim\(\)\.toLowerCase\(\) === ACTOR\.trim\(\)\.toLowerCase\(\)/);
    expect(bootstrapSource).toMatch(/userSession\.expiresAt} > now\(\)/);

    // The marker is checked by the CLI and written by the shared helper. Asserting both
    // halves is the point: the record cannot be skipped by whichever path is used.
    expect(bootstrapSource).toContain("objectClass, 'platform_admin_bootstrap'");
    expect(helperSource).toContain('objectClass: PLATFORM_ADMIN_BOOTSTRAP_OBJECT_CLASS');
    expect(helperSource).toContain('recordChange(tx');
    expect(helperSource).toContain('auditAccessLog');
  });

  it('grants a new tenant the same bootstrap the CLI performs for an older one', () => {
    // One helper, two callers. If either path grew its own copy of the role, the two
    // would drift and a tenant would get a different platform administrator depending
    // on how it was created.
    expect(bootstrapSource).toContain('bootstrapPlatformAdminInTransaction');
    expect(tenancySource).toContain('bootstrapPlatformAdminInTransaction');
    expect(helperSource).toContain('PLATFORM_ADMIN_CAPABILITIES');
  });

  it('carries the user authorities a platform administrator needs to do its job', () => {
    // ROLE.MAINTAIN and USER.ROLE.MAINTAIN alone leave it unable to create the very
    // administrator it exists to create, and unable to grant company or plant access.
    expect(helperSource).toContain("'CFG.PLT.USER.CREATE'");
    expect(helperSource).toContain("'CFG.PLT.USER.MAINTAIN'");
    expect(helperSource).toContain('ROLE_MAINTAIN_CAPABILITY');
    expect(helperSource).toContain('USER_ROLE_MAINTAIN_CAPABILITY');
  });
});
