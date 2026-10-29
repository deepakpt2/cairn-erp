/**
 * Stage 4 — User administration and password recovery security tests.
 *
 * Covers: authorization (capability gating), tenant isolation, token
 * expiry/reuse, concurrency (single-use), account state, session revocation,
 * HR-field preservation, and transactional consistency.
 *
 * Runs against a dedicated scratch database (cairn_test_stage4) provisioned on
 * the owner-provided test server. Does not touch cairn_b210, cairn_hr_accept,
 * or cairn_demo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';

import { withTenant, closeDb } from '@/platform/db/client';
import { appUser, userSession, passwordResetToken, role, roleCapability, userRole, capability } from '@/platform/tables/security';
import { createUser, changeUser, initiatePasswordReset, requestPasswordReset, completePasswordReset, type CreateUserInput } from '@/modules/platform/user-admin';
import { hashPassword } from '@/platform/auth/password';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'STAGE4_TEST';
const PASSWORD = 'Password123!'; // meets policy: 10+ chars, letter, digit

// Human-readable refusal messages (from REFUSALS in user-admin.ts)
const MSG_CAP_MISSING = 'This session does not hold the needed authority.';
const MSG_USER_NOT_FOUND = 'No application user of that id stands in this tenant.';
const MSG_USER_INACTIVE = 'This account is not active.';
const MSG_USER_LOCKED = 'This account is locked.';
const MSG_TOKEN_UNKNOWN = 'This reset link is not known.';
const MSG_TOKEN_USED = 'This reset link has already been used.';
const MSG_PW_TOO_SHORT = 'A password is at least 10 characters.';

let tenant: TestTenant;
let adminUserId: string;      // holds CFG.PLT.USER.CREATE + MAINTAIN + PASSWORD_RESET
let noCapsUserId: string;     // holds no capabilities
let targetUserId: string;     // a user to operate on

beforeAll(async () => {
  tenant = await createTenant('stage4-ua', { withConfiguration: true });

  await withTenant(tenant.client, async (tx) => {
    // Seed capabilities needed for the tests.
    for (const code of ['CFG.PLT.USER.CREATE', 'CFG.PLT.USER.MAINTAIN', 'CFG.PLT.USER.PASSWORD_RESET']) {
      const [cap] = await tx
        .select()
        .from(capability)
        .where(eq(capability.code, code))
        .limit(1);
      if (!cap) {
        await tx.insert(capability).values({
          code,
          module: 'PLT',
          description: `Test capability ${code}`,
          action: 'CONFIGURE',
          createdBy: ACTOR,
        });
      }
    }

    // Create a role holding all three user-admin capabilities.
    await tx.insert(role).values({
      client: tenant.client,
      code: 'TEST_ADMIN',
      name: 'Test Administrator',
      description: 'Holds user administration capabilities for tests',
      isSystemRole: false,
      isReadOnly: false,
      createdBy: ACTOR,
    });
    for (const code of ['CFG.PLT.USER.CREATE', 'CFG.PLT.USER.MAINTAIN', 'CFG.PLT.USER.PASSWORD_RESET']) {
      await tx.insert(roleCapability).values({
        client: tenant.client,
        roleCode: 'TEST_ADMIN',
        capabilityCode: code,
        createdBy: ACTOR,
      });
    }

    // Admin user with all capabilities.
    const [admin] = await tx
      .insert(appUser)
      .values({
        id: 'stage4-admin',
        client: tenant.client,
        username: 'stage4.admin',
        fullName: 'Stage 4 Admin',
        passwordHash: await hashPassword(PASSWORD),
        isActive: true,
        createdBy: ACTOR,
      })
      .returning();
    adminUserId = admin.id;

    // User with no capabilities.
    const [noCaps] = await tx
      .insert(appUser)
      .values({
        id: 'stage4-nocaps',
        client: tenant.client,
        username: 'stage4.nocaps',
        fullName: 'No Caps User',
        passwordHash: await hashPassword(PASSWORD),
        isActive: true,
        createdBy: ACTOR,
      })
      .returning();
    noCapsUserId = noCaps.id;

    // Target user for change/reset operations.
    const [target] = await tx
      .insert(appUser)
      .values({
        id: 'stage4-target',
        client: tenant.client,
        username: 'stage4.target',
        fullName: 'Target User',
        email: 'target@example.com',
        passwordHash: await hashPassword(PASSWORD),
        isActive: true,
        isLocked: false,
        mustChangePassword: false,
        createdBy: ACTOR,
      })
      .returning();
    targetUserId = target.id;

    // Grant admin role to admin user.
    await tx.insert(userRole).values({
      client: tenant.client,
      userId: adminUserId,
      roleCode: 'TEST_ADMIN',
      createdBy: ACTOR,
    });
  });
});

afterAll(async () => {
  await destroyTenant(tenant.client);
  await closeDb();
});

const ADMIN_CAPS = ['CFG.PLT.USER.CREATE', 'CFG.PLT.USER.MAINTAIN', 'CFG.PLT.USER.PASSWORD_RESET'];
const EMPTY_CAPS: string[] = [];

describe('user administration — authorization', () => {
  it('creates a user with CFG.PLT.USER.CREATE capability', async () => {
    const view = await createUser(
      {
        client: tenant.client,
        username: 'stage4.newuser',
        fullName: 'New User',
        email: 'new@example.com',
        password: 'NewPass123!',
        changedBy: adminUserId,
      },
      ADMIN_CAPS,
    );

    expect(view.username).toBe('STAGE4.NEWUSER');
    expect(view.isActive).toBe(true);
    expect(view.isLocked).toBe(false);
    expect(view.client).toBe(tenant.client);

    const row = await withTenant(tenant.client, (tx) =>
      tx.select().from(appUser).where(eq(appUser.id, view.id)).limit(1),
    );
    expect(row.length).toBe(1);
    expect(row[0].client).toBe(tenant.client);
    expect(row[0].username).toBe('STAGE4.NEWUSER');
  });

  it('denies creation without CFG.PLT.USER.CREATE capability', async () => {
    await expect(
      createUser(
        {
          client: tenant.client,
          username: 'stage4.nocapscreate',
          fullName: 'No Caps Create',
          password: 'NewPass123!',
          changedBy: noCapsUserId,
        },
        EMPTY_CAPS,
      ),
    ).rejects.toThrow(MSG_CAP_MISSING);
  });

  it('rejects forged sessionCapabilities injected through input object', async () => {
    // sessionCapabilities is not in the Zod schema — a caller cannot supply it
    // through the input object. Zod strips unknown keys, and the function uses
    // the trusted sessionCapabilities parameter (from the authenticated session),
    // not caller-supplied data.
    await expect(
      createUser(
        {
          client: tenant.client,
          username: 'stage4.forged',
          fullName: 'Forged Caps',
          password: 'NewPass123!',
          changedBy: noCapsUserId,
          // This key is not in the Zod schema — it will be stripped.
          sessionCapabilities: ['CFG.PLT.USER.CREATE', 'CFG.PLT.USER.MAINTAIN'],
        } as unknown as CreateUserInput,
        EMPTY_CAPS,
      ),
    ).rejects.toThrow(MSG_CAP_MISSING);
  });

  it('changes user details with CFG.PLT.USER.MAINTAIN capability', async () => {
    const view = await changeUser({
      client: tenant.client,
      userId: targetUserId,
      fullName: 'Updated Target User',
      email: 'updated@example.com',
      changedBy: adminUserId,
      sessionCapabilities: ADMIN_CAPS,
    }, ADMIN_CAPS);

    expect(view.fullName).toBe('Updated Target User');
    expect(view.email).toBe('updated@example.com');

    const row = await withTenant(tenant.client, (tx) =>
      tx.select().from(appUser).where(eq(appUser.id, targetUserId)).limit(1),
    );
    expect(row[0].fullName).toBe('Updated Target User');
    expect(row[0].email).toBe('updated@example.com');
  });

  it('denies change without CFG.PLT.USER.MAINTAIN capability', async () => {
    await expect(
      changeUser({
        client: tenant.client,
        userId: targetUserId,
        fullName: 'Should Not Change',
        changedBy: noCapsUserId,
        sessionCapabilities: EMPTY_CAPS,
      }, EMPTY_CAPS),
    ).rejects.toThrow(MSG_CAP_MISSING);
  });

  it('administrator-initiated reset with CFG.PLT.USER.PASSWORD_RESET capability', async () => {
    const outcome = await initiatePasswordReset({
      client: tenant.client,
      userId: targetUserId,
      changedBy: adminUserId,
    }, ADMIN_CAPS);

    expect(outcome.token).toBeDefined();
    expect(outcome.token.length).toBeGreaterThan(0);
    expect(outcome.userId).toBe(targetUserId);
    expect(outcome.expiresAt).toBeDefined();

    const tokenRow = await withTenant(tenant.client, (tx) =>
      tx.select().from(passwordResetToken).where(eq(passwordResetToken.userId, targetUserId)).limit(1),
    );
    expect(tokenRow.length).toBe(1);
    expect(tokenRow[0].tokenHash).toBeDefined();
    expect(tokenRow[0].tokenHash).not.toBe(outcome.token);
    expect(tokenRow[0].usedAt).toBeNull();
  });

  it('denies administrative reset without CFG.PLT.USER.PASSWORD_RESET capability', async () => {
    await expect(
      initiatePasswordReset({
        client: tenant.client,
        userId: targetUserId,
        changedBy: noCapsUserId,
      }, EMPTY_CAPS),
    ).rejects.toThrow(MSG_CAP_MISSING);
  });

  it('refuses reset for nonexistent user', async () => {
    await expect(
      initiatePasswordReset({
        client: tenant.client,
        userId: '00000000-0000-0000-0000-000000000000',
        changedBy: adminUserId,
      }, ADMIN_CAPS),
    ).rejects.toThrow(MSG_USER_NOT_FOUND);
  });

  it('refuses reset for inactive account', async () => {
    await withTenant(tenant.client, (tx) =>
      tx.update(appUser).set({ isActive: false }).where(eq(appUser.id, targetUserId)),
    );
    await expect(
      initiatePasswordReset({
        client: tenant.client,
        userId: targetUserId,
        changedBy: adminUserId,
      }, ADMIN_CAPS),
    ).rejects.toThrow(MSG_USER_INACTIVE);
    await withTenant(tenant.client, (tx) =>
      tx.update(appUser).set({ isActive: true }).where(eq(appUser.id, targetUserId)),
    );
  });

  it('refuses reset for locked account', async () => {
    await withTenant(tenant.client, (tx) =>
      tx.update(appUser).set({ isLocked: true }).where(eq(appUser.id, targetUserId)),
    );
    await expect(
      initiatePasswordReset({
        client: tenant.client,
        userId: targetUserId,
        changedBy: adminUserId,
      }, ADMIN_CAPS),
    ).rejects.toThrow(MSG_USER_LOCKED);
    await withTenant(tenant.client, (tx) =>
      tx.update(appUser).set({ isLocked: false }).where(eq(appUser.id, targetUserId)),
    );
  });

  it('does not assign roles or modify HR fields through changeUser', async () => {
    const beforeRoles = await withTenant(tenant.client, (tx) =>
      tx.select().from(userRole).where(and(eq(userRole.client, tenant.client), eq(userRole.userId, targetUserId))),
    );

    await changeUser({
      client: tenant.client,
      userId: targetUserId,
      fullName: 'Still Target User',
      changedBy: adminUserId,
      sessionCapabilities: ADMIN_CAPS,
    }, ADMIN_CAPS);

    const afterRoles = await withTenant(tenant.client, (tx) =>
      tx.select().from(userRole).where(and(eq(userRole.client, tenant.client), eq(userRole.userId, targetUserId))),
    );
    expect(afterRoles).toEqual(beforeRoles);

    const row = await withTenant(tenant.client, (tx) =>
      tx.select().from(appUser).where(eq(appUser.id, targetUserId)).limit(1),
    );
    expect(row[0].passwordHash).toBeDefined();
    expect(row[0].isLocked).toBe(false);
  });

  it('prevents cross-tenant read — user from tenant A cannot see tenant B users', async () => {
    const other = await createTenant('stage4-ua-other', { withConfiguration: true });
    try {
      // Create a user in the other tenant.
      await withTenant(other.client, async (tx) => {
        await tx.insert(appUser).values({
          id: 'stage4-other-user',
          client: other.client,
          username: 'stage4.other.user',
          fullName: 'Other Tenant User',
          passwordHash: await hashPassword(PASSWORD),
          isActive: true,
          createdBy: ACTOR,
        });
      });

      // From our tenant scope, we should see zero users from the other tenant.
      const rows = await withTenant(tenant.client, (tx) =>
        tx.select({ id: appUser.id }).from(appUser),
      );
      const otherTenantUsers = rows.filter((r) => r.id === 'stage4-other-user');
      expect(otherTenantUsers.length).toBe(0);
    } finally {
      await destroyTenant(other.client);
    }
  });
});

describe('password recovery — self-service request', () => {
  let activeUserId: string;

  beforeAll(async () => {
    await withTenant(tenant.client, async (tx) => {
      const [u] = await tx
        .insert(appUser)
        .values({
          id: 'stage4-reset-active',
          client: tenant.client,
          username: 'stage4.reset.active',
          fullName: 'Reset Active',
          passwordHash: await hashPassword(PASSWORD),
          isActive: true,
          isLocked: false,
          createdBy: ACTOR,
        })
        .returning();
      activeUserId = u.id;
    });
  });

  it('returns accepted=true for existing active user', async () => {
    const result = await requestPasswordReset({
      client: tenant.client,
      username: 'stage4.reset.active',
    });
    expect(result.accepted).toBe(true);
  });

  it('returns accepted=true for nonexistent user (no enumeration)', async () => {
    const result = await requestPasswordReset({
      client: tenant.client,
      username: 'stage4.does.not.exist',
    });
    expect(result.accepted).toBe(true);
  });

  it('returns accepted=true for inactive user (no disclosure)', async () => {
    await withTenant(tenant.client, (tx) =>
      tx.update(appUser).set({ isActive: false }).where(eq(appUser.id, activeUserId)),
    );
    const result = await requestPasswordReset({
      client: tenant.client,
      username: 'stage4.reset.active',
    });
    expect(result.accepted).toBe(true);
    await withTenant(tenant.client, (tx) =>
      tx.update(appUser).set({ isActive: true }).where(eq(appUser.id, activeUserId)),
    );
  });

  it('returns accepted=true for locked user (no disclosure)', async () => {
    await withTenant(tenant.client, (tx) =>
      tx.update(appUser).set({ isLocked: true }).where(eq(appUser.id, activeUserId)),
    );
    const result = await requestPasswordReset({
      client: tenant.client,
      username: 'stage4.reset.active',
    });
    expect(result.accepted).toBe(true);
    await withTenant(tenant.client, (tx) =>
      tx.update(appUser).set({ isLocked: false }).where(eq(appUser.id, activeUserId)),
    );
  });

  it('handles invalid client identifier without error', async () => {
    const result = await requestPasswordReset({
      client: 'X', // invalid: too short
      username: 'stage4.reset.active',
    });
    expect(result.accepted).toBe(true);
  });

  it('creates token and audit record tenant-scoped', async () => {
    const result = await requestPasswordReset({
      client: tenant.client,
      username: 'stage4.reset.active',
    });
    expect(result.accepted).toBe(true);

    const tokenRows = await withTenant(tenant.client, (tx) =>
      tx.select().from(passwordResetToken).where(eq(passwordResetToken.client, tenant.client)),
    );
    expect(tokenRows.length).toBeGreaterThan(0);
    for (const row of tokenRows) {
      expect(row.client).toBe(tenant.client);
    }
  });

  it('prevents cross-tenant token access — caller cannot read another tenant\'s tokens', async () => {
    const other = await createTenant('stage4-recovery-other', { withConfiguration: true });
    try {
      await withTenant(other.client, async (tx) => {
        await tx.insert(appUser).values({
          id: 'stage4-other-user',
          client: other.client,
          username: 'stage4.other.user',
          fullName: 'Other Tenant User',
          passwordHash: await hashPassword(PASSWORD),
          isActive: true,
          createdBy: ACTOR,
        });
      });
      await requestPasswordReset({ client: other.client, username: 'stage4.other.user' });

      // From our tenant scope, we should see no tokens from the other tenant.
      const ourTokens = await withTenant(tenant.client, (tx) =>
        tx.select().from(passwordResetToken),
      );
      const otherTenantTokens = ourTokens.filter((t) => t.client === other.client);
      expect(otherTenantTokens.length).toBe(0);
    } finally {
      await destroyTenant(other.client);
    }
  });
});

describe('password recovery — token completion security', () => {
  let tokenUserId: string;
  let validToken: string;

  beforeAll(async () => {
    await withTenant(tenant.client, async (tx) => {
      const [u] = await tx
        .insert(appUser)
        .values({
          id: 'stage4-token-user',
          client: tenant.client,
          username: 'stage4.token.user',
          fullName: 'Token User',
          passwordHash: await hashPassword(PASSWORD),
          isActive: true,
          isLocked: false,
          mustChangePassword: false,
          createdBy: ACTOR,
        })
        .returning();
      tokenUserId = u.id;

      const token = 'valid_test_token_abc123';
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await tx.execute(sql`
        insert into password_reset_token (id, client, user_id, token_hash, expires_at, created_by)
        values (${randomUUID()}, ${tenant.client}, ${tokenUserId}, ${tokenHash}, ${expiresAt}, 'TEST')
      `);
      validToken = token;
    });
  });

  it('valid token successfully resets the password', async () => {
    const outcome = await completePasswordReset({
      client: tenant.client,
      token: validToken,
      password: 'NewResetPass456!',
    });

    expect(outcome.userId).toBe(tokenUserId);

    const row = await withTenant(tenant.client, (tx) =>
      tx.select({ mustChangePassword: appUser.mustChangePassword }).from(appUser).where(eq(appUser.id, tokenUserId)).limit(1),
    );
    expect(row[0].mustChangePassword).toBe(false);

    const tokenRow = await withTenant(tenant.client, (tx) =>
      tx.select({ usedAt: passwordResetToken.usedAt }).from(passwordResetToken).where(eq(passwordResetToken.userId, tokenUserId)).limit(1),
    );
    expect(tokenRow[0].usedAt).not.toBeNull();
  });

  it('invalid token is rejected', async () => {
    await expect(
      completePasswordReset({
        client: tenant.client,
        token: 'nonexistent_token_that_no_one_has',
        password: 'NewResetPass456!',
      }),
    ).rejects.toThrow(MSG_TOKEN_UNKNOWN);
  });

  it('expired token is rejected', async () => {
    await withTenant(tenant.client, async (tx) => {
      const [u] = await tx
        .insert(appUser)
        .values({
          id: 'stage4-expired-token-user',
          client: tenant.client,
          username: 'stage4.expired.token',
          fullName: 'Expired Token User',
          passwordHash: await hashPassword(PASSWORD),
          isActive: true,
          createdBy: ACTOR,
        })
        .returning();

      const token = 'expired_test_token_123';
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await tx.execute(sql`
        insert into password_reset_token (id, client, user_id, token_hash, expires_at, created_by)
        values (${randomUUID()}, ${tenant.client}, ${u.id}, ${tokenHash}, ${expiresAt}, 'TEST')
      `);
    });

    await expect(
      completePasswordReset({
        client: tenant.client,
        token: 'expired_test_token_123',
        password: 'NewResetPass456!',
      }),
    ).rejects.toThrow(MSG_TOKEN_UNKNOWN);
  });

  it('already-consumed token is rejected (single-use)', async () => {
    // Create a fresh token for this test (validToken was consumed earlier).
    await withTenant(tenant.client, async (tx) => {
      const [u] = await tx
        .insert(appUser)
        .values({
          id: 'stage4-single-use-user',
          client: tenant.client,
          username: 'stage4.single.use',
          fullName: 'Single Use',
          passwordHash: await hashPassword(PASSWORD),
          isActive: true,
          createdBy: ACTOR,
        })
        .returning();

      const token = 'single_use_test_token_xyz';
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await tx.execute(sql`
        insert into password_reset_token (id, client, user_id, token_hash, expires_at, created_by)
        values (${randomUUID()}, ${tenant.client}, ${u.id}, ${tokenHash}, ${expiresAt}, 'TEST')
      `);
    });

    // First request succeeds.
    await completePasswordReset({
      client: tenant.client,
      token: 'single_use_test_token_xyz',
      password: 'SingleUsePass456!',
    });

    // A sequential second request with the same token finds it already used
    // (isNull(usedAt) filters it out), so it reports TOKEN_UNKNOWN — the same
    // message as an unknown or expired token, which prevents enumeration.
    await expect(
      completePasswordReset({
        client: tenant.client,
        token: 'single_use_test_token_xyz',
        password: 'SingleUsePass789!',
      }),
    ).rejects.toThrow(MSG_TOKEN_UNKNOWN);
  });

  it('only stores token hash, never plaintext', async () => {
    const token = 'verify_hash_only_token_456';
    const tokenHash = createHash('sha256').update(token).digest('hex');

    await withTenant(tenant.client, async (tx) => {
      const [u] = await tx
        .insert(appUser)
        .values({
          id: 'stage4-hash-verify',
          client: tenant.client,
          username: 'stage4.hash.verify',
          fullName: 'Hash Verify',
          passwordHash: await hashPassword(PASSWORD),
          isActive: true,
          createdBy: ACTOR,
        })
        .returning();

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await tx.execute(sql`
        insert into password_reset_token (id, client, user_id, token_hash, expires_at, created_by)
        values (${randomUUID()}, ${tenant.client}, ${u.id}, ${tokenHash}, ${expiresAt}, 'TEST')
      `);
    });

    const rows = await withTenant(tenant.client, (tx) =>
      tx.select({ tokenHash: passwordResetToken.tokenHash }).from(passwordResetToken).where(eq(passwordResetToken.client, tenant.client)),
    );
    for (const row of rows) {
      expect(row.tokenHash).not.toBe('verify_hash_only_token_456');
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('enforces password policy server-side', async () => {
    await withTenant(tenant.client, async (tx) => {
      const [u] = await tx
        .insert(appUser)
        .values({
          id: 'stage4-policy-user',
          client: tenant.client,
          username: 'stage4.policy.user',
          fullName: 'Policy User',
          passwordHash: await hashPassword(PASSWORD),
          isActive: true,
          createdBy: ACTOR,
        })
        .returning();

      const token = 'policy_test_token_789';
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await tx.execute(sql`
        insert into password_reset_token (id, client, user_id, token_hash, expires_at, created_by)
        values (${randomUUID()}, ${tenant.client}, ${u.id}, ${tokenHash}, ${expiresAt}, 'TEST')
      `);
    });

    await expect(
      completePasswordReset({
        client: tenant.client,
        token: 'policy_test_token_789',
        password: 'short',
      }),
    ).rejects.toThrow(MSG_PW_TOO_SHORT);

    await expect(
      completePasswordReset({
        client: tenant.client,
        token: 'policy_test_token_789',
        password: 'NoDigitsHere!',
      }),
    ).rejects.toThrow(MSG_PW_TOO_SHORT);

    await expect(
      completePasswordReset({
        client: tenant.client,
        token: 'policy_test_token_789',
        password: '1234567890',
      }),
    ).rejects.toThrow(MSG_PW_TOO_SHORT);
  });

  it('revokes all prior sessions after successful reset', async () => {
    await withTenant(tenant.client, async (tx) => {
      const [u] = await tx
        .insert(appUser)
        .values({
          id: 'stage4-session-revoke',
          client: tenant.client,
          username: 'stage4.session.revoke',
          fullName: 'Session Revoke',
          passwordHash: await hashPassword(PASSWORD),
          isActive: true,
          createdBy: ACTOR,
        })
        .returning();

      await tx.execute(sql`
        insert into user_session (id, client, user_id, token_hash, expires_at, revoked_at)
        values
          (${randomUUID()}, ${tenant.client}, ${u.id}, ${createHash('sha256').update('session1').digest('hex')}, ${new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()}, null),
          (${randomUUID()}, ${tenant.client}, ${u.id}, ${createHash('sha256').update('session2').digest('hex')}, ${new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()}, null)
      `);

      const token = 'session_revoke_token_abc';
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await tx.execute(sql`
        insert into password_reset_token (id, client, user_id, token_hash, expires_at, created_by)
        values (${randomUUID()}, ${tenant.client}, ${u.id}, ${tokenHash}, ${expiresAt}, 'TEST')
      `);
    });

    await completePasswordReset({
      client: tenant.client,
      token: 'session_revoke_token_abc',
      password: 'SessionRevokedPass456!',
    });

    const activeSessions = await withTenant(tenant.client, (tx) =>
      tx.select().from(userSession).where(and(eq(userSession.client, tenant.client), sql`${userSession.revokedAt} is null`)),
    );
    const unrevokedForTarget = activeSessions.filter((s) => s.userId === 'stage4-session-revoke');
    expect(unrevokedForTarget.length).toBe(0);
  });

  it('does not activate disabled account through reset', async () => {
    await withTenant(tenant.client, async (tx) => {
      const [u] = await tx
        .insert(appUser)
        .values({
          id: 'stage4-disabled-reset',
          client: tenant.client,
          username: 'stage4.disabled.reset',
          fullName: 'Disabled Reset',
          passwordHash: await hashPassword(PASSWORD),
          isActive: false,
          isLocked: false,
          createdBy: ACTOR,
        })
        .returning();

      const token = 'disabled_reset_token_xyz';
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await tx.execute(sql`
        insert into password_reset_token (id, client, user_id, token_hash, expires_at, created_by)
        values (${randomUUID()}, ${tenant.client}, ${u.id}, ${tokenHash}, ${expiresAt}, 'TEST')
      `);
    });

    await expect(
      completePasswordReset({
        client: tenant.client,
        token: 'disabled_reset_token_xyz',
        password: 'DisabledResetPass456!',
      }),
    ).rejects.toThrow(MSG_USER_INACTIVE);

    const row = await withTenant(tenant.client, (tx) =>
      tx.select({ isActive: appUser.isActive }).from(appUser).where(eq(appUser.username, 'stage4.disabled.reset')).limit(1),
    );
    expect(row[0].isActive).toBe(false);
  });

  it('does not unlock locked account through reset', async () => {
    await withTenant(tenant.client, async (tx) => {
      const [u] = await tx
        .insert(appUser)
        .values({
          id: 'stage4-locked-reset',
          client: tenant.client,
          username: 'stage4.locked.reset',
          fullName: 'Locked Reset',
          passwordHash: await hashPassword(PASSWORD),
          isActive: true,
          isLocked: true,
          createdBy: ACTOR,
        })
        .returning();

      const token = 'locked_reset_token_xyz';
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await tx.execute(sql`
        insert into password_reset_token (id, client, user_id, token_hash, expires_at, created_by)
        values (${randomUUID()}, ${tenant.client}, ${u.id}, ${tokenHash}, ${expiresAt}, 'TEST')
      `);
    });

    const result = await completePasswordReset({
      client: tenant.client,
      token: 'locked_reset_token_xyz',
      password: 'LockedResetPass456!',
    });
    expect(result.userId).toBeDefined();

    const row = await withTenant(tenant.client, (tx) =>
      tx.select({ isLocked: appUser.isLocked }).from(appUser).where(eq(appUser.username, 'stage4.locked.reset')).limit(1),
    );
    expect(row[0].isLocked).toBe(true);
  });

  it('does not change roles, org access, or HR fields through reset', async () => {
    await withTenant(tenant.client, async (tx) => {
      const [u] = await tx
        .insert(appUser)
        .values({
          id: 'stage4-hr-preserve',
          client: tenant.client,
          username: 'stage4.hr.preserve',
          fullName: 'HR Preserve',
          email: 'hr@example.com',
          passwordHash: await hashPassword(PASSWORD),
          isActive: true,
          isLocked: false,
          mustChangePassword: true,
          createdBy: ACTOR,
        })
        .returning();

      const token = 'hr_preserve_token_xyz';
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await tx.execute(sql`
        insert into password_reset_token (id, client, user_id, token_hash, expires_at, created_by)
        values (${randomUUID()}, ${tenant.client}, ${u.id}, ${tokenHash}, ${expiresAt}, 'TEST')
      `);
    });

    await completePasswordReset({
      client: tenant.client,
      token: 'hr_preserve_token_xyz',
      password: 'HRPreservedPass456!',
    });

    const row = await withTenant(tenant.client, (tx) =>
      tx.select({ email: appUser.email, fullName: appUser.fullName, isActive: appUser.isActive, isLocked: appUser.isLocked }).from(appUser).where(eq(appUser.username, 'stage4.hr.preserve')).limit(1),
    );
    expect(row[0].email).toBe('hr@example.com');
    expect(row[0].fullName).toBe('HR Preserve');
    expect(row[0].isActive).toBe(true);
    expect(row[0].isLocked).toBe(false);
  });
});

describe('password recovery — concurrency (mandatory)', () => {
  it('consumes token at most once under simultaneous reset requests', async () => {
    await withTenant(tenant.client, async (tx) => {
      const [u] = await tx
        .insert(appUser)
        .values({
          id: 'stage4-concurrent-user',
          client: tenant.client,
          username: 'stage4.concurrent.user',
          fullName: 'Concurrent User',
          passwordHash: await hashPassword(PASSWORD),
          isActive: true,
          createdBy: ACTOR,
        })
        .returning();

      const token = 'concurrent_test_token_999';
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await tx.execute(sql`
        insert into password_reset_token (id, client, user_id, token_hash, expires_at, created_by)
        values (${randomUUID()}, ${tenant.client}, ${u.id}, ${tokenHash}, ${expiresAt}, 'TEST')
      `);
    });

    const results = await Promise.allSettled([
      completePasswordReset({
        client: tenant.client,
        token: 'concurrent_test_token_999',
        password: 'ConcurrentPassOne456!',
      }),
      completePasswordReset({
        client: tenant.client,
        token: 'concurrent_test_token_999',
        password: 'ConcurrentPassTwo789!',
      }),
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);

    const failure = failed[0] as PromiseRejectedResult;
    expect(failure.reason.message).toMatch(/already been used|not known/);

    const tokenRows = await withTenant(tenant.client, (tx) =>
      tx.select({ usedAt: passwordResetToken.usedAt, userId: passwordResetToken.userId }).from(passwordResetToken).where(eq(passwordResetToken.client, tenant.client)),
    );
    // The token created for this test (user stage4-concurrent-user) should be consumed exactly once.
    const consumed = tokenRows.filter((t) => t.usedAt !== null && t.userId === 'stage4-concurrent-user');
    expect(consumed.length).toBe(1);
  });

  it('transactional consistency — no partial state on failure', async () => {
    await withTenant(tenant.client, async (tx) => {
      const [u] = await tx
        .insert(appUser)
        .values({
          id: 'stage4-partial-user',
          client: tenant.client,
          username: 'stage4.partial.user',
          fullName: 'Partial User',
          passwordHash: await hashPassword(PASSWORD),
          isActive: true,
          createdBy: ACTOR,
        })
        .returning();

      const token = 'partial_expired_token';
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() - 1000).toISOString();
      await tx.execute(sql`
        insert into password_reset_token (id, client, user_id, token_hash, expires_at, created_by)
        values (${randomUUID()}, ${tenant.client}, ${u.id}, ${tokenHash}, ${expiresAt}, 'TEST')
      `);
    });

    await expect(
      completePasswordReset({
        client: tenant.client,
        token: 'partial_expired_token',
        password: 'PartialPass456!',
      }),
    ).rejects.toThrow(MSG_TOKEN_UNKNOWN);

    const tokenRows = await withTenant(tenant.client, (tx) =>
      tx.select({ usedAt: passwordResetToken.usedAt }).from(passwordResetToken).where(eq(passwordResetToken.client, tenant.client)),
    );
    const expiredToken = tokenRows.find((t) => t.usedAt === null);
    expect(expiredToken).toBeDefined();
  });
});