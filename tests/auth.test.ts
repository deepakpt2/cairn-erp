/**
 * Sign-in and session tests — CAIRN.md §23, §24.
 *
 * These assert database state, not return values alone: a lockout that is not
 * written to the user row has not happened, and an audit trail that exists only in
 * an object has not been kept.
 */
import { describe, expect, it, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, closeDb } from '@/platform/db/client';
import { hashPassword } from '@/platform/auth/password';
import {
  AuthError,
  MAX_FAILED_ATTEMPTS,
  createSession,
  encodeSessionCookie,
  hasCapability,
  parseSessionCookie,
  resolveSession,
  revokeAllSessions,
  signIn,
  revokeSession,
} from '@/platform/auth/session';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const tenant: TestTenant = await createTenant('auth');
const PASSWORD = 'correct-horse-7';

await withTenant(tenant.client, async (tx) => {
  await tx.execute(sql`
    insert into app_user
      (id, client, username, full_name, email, password_hash, is_active, is_locked, created_by)
    values
      (gen_random_uuid()::text, ${tenant.client}, 'auth.active', 'Active User',
       'active@example.test', ${await hashPassword(PASSWORD)}, true, false, 'TEST'),
      (gen_random_uuid()::text, ${tenant.client}, 'auth.inactive', 'Inactive User',
       null, ${await hashPassword(PASSWORD)}, false, false, 'TEST'),
      (gen_random_uuid()::text, ${tenant.client}, 'auth.locked', 'Locked User',
       null, ${await hashPassword(PASSWORD)}, true, true, 'TEST')
  `);
});

/** A second tenant, to prove a token from one is worthless in the other. */
const other: TestTenant = await createTenant('auth-other');
await withTenant(other.client, async (tx) => {
  await tx.execute(sql`
    insert into app_user
      (id, client, username, full_name, email, password_hash, is_active, is_locked, created_by)
    values (gen_random_uuid()::text, ${other.client}, 'auth.active', 'Other Tenant User',
            null, ${await hashPassword(PASSWORD)}, true, false, 'TEST')
  `);
});

afterAll(async () => {
  await destroyTenant(tenant.client);
  await destroyTenant(other.client);
  await closeDb();
});

/**
 * Sign in for real, through the same committing wrapper the logon screen calls —
 * so these tests exercise the path that has to record a refused attempt, not a
 * convenient equivalent of it.
 */
function attempt(username: string, password: string) {
  return signIn({ client: tenant.client, username, password });
}

describe('sign in', () => {
  it('accepts the right password and rejects the wrong one', async () => {
    const user = await attempt('auth.active', PASSWORD);
    expect(user.username).toBe('auth.active');

    await expect(attempt('auth.active', 'wrong-password')).rejects.toBeInstanceOf(AuthError);
  });

  it('gives the same message for an unknown user as for a wrong password', async () => {
    // Otherwise the logon screen becomes a tool for discovering who exists.
    const wrongPassword = (await attempt('auth.active', 'nope').catch((e) => e)) as AuthError;
    const unknownUser = (await attempt('auth.nobody', PASSWORD).catch((e) => e)) as AuthError;

    expect(unknownUser.message).toBe(wrongPassword.message);
    expect(unknownUser.code).toBe(wrongPassword.code);
  });

  it('refuses an inactive user and says why', async () => {
    const error = (await attempt('auth.inactive', PASSWORD).catch((e) => e)) as AuthError;
    expect(error.code).toBe('CAIRN_AUTH_INACTIVE');
  });

  it('locks the user after the configured number of failures, and records each attempt', async () => {
    // This test counts attempts, so it starts from a known counter rather than
    // from whatever the tests above happened to leave behind.
    await withTenant(tenant.client, (tx) =>
      tx.execute(sql`update app_user set failed_login_count = '0', is_locked = false where username = 'auth.active'`),
    );

    await attempt('auth.active', 'nope-1').catch(() => {});
    await attempt('auth.active', 'nope-2').catch(() => {});

    const counted = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`select failed_login_count, is_locked from app_user where username = 'auth.active'`),
    );
    expect((counted as unknown as Array<{ failed_login_count: string }>)[0].failed_login_count).toBe('2');

    for (let i = 3; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await attempt('auth.active', `nope-${i}`).catch(() => {});
    }

    const locked = (await attempt('auth.active', 'nope-final').catch((e) => e)) as AuthError;
    expect(locked.code).toBe('CAIRN_AUTH_LOCKED');

    // The lock is a fact in the database, not just in the response.
    const row = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`select is_locked, failed_login_count from app_user where username = 'auth.active'`),
    );
    const state = (row as unknown as Array<{ is_locked: boolean; failed_login_count: string }>)[0];
    expect(state.is_locked).toBe(true);

    // And the correct password no longer helps — that is what a lock means.
    const stillLocked = (await attempt('auth.active', PASSWORD).catch((e) => e)) as AuthError;
    expect(stillLocked.code).toBe('CAIRN_AUTH_LOCKED');
  });

  it('records every failed attempt in the access log', async () => {
    const log = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`
        select count(*)::int as count from audit_access_log
         where event_type = 'LOGIN_FAILED' and username like 'auth.%'
      `),
    );
    expect((log as unknown as Array<{ count: number }>)[0].count).toBeGreaterThanOrEqual(
      MAX_FAILED_ATTEMPTS,
    );
  });

  it('clears the failure count on a successful sign-in', async () => {
    await withTenant(tenant.client, (tx) =>
      tx.execute(sql`
        update app_user set is_locked = false, failed_login_count = '0' where username = 'auth.active'
      `),
    );

    const user = await attempt('auth.active', PASSWORD);
    expect(user.username).toBe('auth.active');

    const row = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`select failed_login_count, last_login_at from app_user where username = 'auth.active'`),
    );
    const state = (row as unknown as Array<{ failed_login_count: string; last_login_at: string | null }>)[0];
    expect(state.failed_login_count).toBe('0');
    expect(state.last_login_at).not.toBeNull();
  });
});

describe('sessions', () => {
  async function newSession(ttlMinutes?: number) {
    const user = await attempt('auth.active', PASSWORD);
    return withTenant(tenant.client, (tx) =>
      createSession(tx, { client: tenant.client, userId: user.userId, ttlMinutes }),
    );
  }

  it('stores the token hashed, never raw', async () => {
    const { token } = await newSession();

    const byRaw = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`select count(*)::int as count from user_session where token_hash = ${token}`),
    );
    expect((byRaw as unknown as Array<{ count: number }>)[0].count).toBe(0);

    const resolved = await withTenant(tenant.client, (tx) =>
      resolveSession(tx, { client: tenant.client, token }),
    );
    expect(resolved?.user.username).toBe('auth.active');
  });

  it('refuses a token that belongs to another tenant', async () => {
    const { token } = await newSession();

    const stolen = await withTenant(other.client, (tx) =>
      resolveSession(tx, { client: other.client, token }),
    );
    expect(stolen).toBeNull();
  });

  it('refuses an expired session', async () => {
    const { token } = await newSession(-1);
    const resolved = await withTenant(tenant.client, (tx) =>
      resolveSession(tx, { client: tenant.client, token }),
    );
    expect(resolved).toBeNull();
  });

  it('refuses a revoked session immediately', async () => {
    const { token } = await newSession();

    await withTenant(tenant.client, (tx) =>
      revokeSession(tx, { client: tenant.client, token, username: 'auth.active' }),
    );

    const resolved = await withTenant(tenant.client, (tx) =>
      resolveSession(tx, { client: tenant.client, token }),
    );
    expect(resolved).toBeNull();
  });

  it('revokes every session for a user at once', async () => {
    const first = await newSession();
    await newSession();

    const userId = (await withTenant(tenant.client, (tx) =>
      tx.execute(sql`select id from app_user where username = 'auth.active'`),
    )) as unknown as Array<{ id: string }>;

    const revoked = await withTenant(tenant.client, (tx) =>
      revokeAllSessions(tx, { client: tenant.client, userId: userId[0].id, reason: 'test' }),
    );
    expect(revoked).toBeGreaterThanOrEqual(1);

    // And the tokens those sessions handed out are dead.
    const resolved = await withTenant(tenant.client, (tx) =>
      resolveSession(tx, { client: tenant.client, token: first.token }),
    );
    expect(resolved).toBeNull();

    const live = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`
        select count(*)::int as count
          from user_session s join app_user u on u.id = s.user_id and u.client = s.client
         where s.revoked_at is null and u.username = 'auth.active'
      `),
    );
    expect((live as unknown as Array<{ count: number }>)[0].count).toBe(0);
  });

  it('renews a session that is near expiry, and leaves a fresh one alone', async () => {
    const fresh = await newSession();
    const freshResolved = await withTenant(tenant.client, (tx) =>
      resolveSession(tx, { client: tenant.client, token: fresh.token }),
    );
    expect(freshResolved?.renewed).toBe(false);

    // Ten minutes from the end of a twelve-hour session: inside the renewal window.
    const nearlyDone = await newSession(10);
    const renewed = await withTenant(tenant.client, (tx) =>
      resolveSession(tx, { client: tenant.client, token: nearlyDone.token }),
    );

    expect(renewed?.renewed).toBe(true);
    expect(renewed!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
  });
});

describe('session cookie', () => {
  it('round-trips a tenant and token', () => {
    const cookie = encodeSessionCookie('0100', 'a'.repeat(43));
    expect(parseSessionCookie(cookie)).toEqual({ client: '0100', token: 'a'.repeat(43) });
  });

  it('rejects a cookie whose tenant key is not a four-character tenant', () => {
    // The tenant key reaches a SET statement, so this is the guard that matters.
    expect(parseSessionCookie("'; drop table client--." + 'a'.repeat(43))).toBeNull();
    expect(parseSessionCookie('10.' + 'a'.repeat(43))).toBeNull();
    expect(parseSessionCookie('0100.')).toBeNull();
    expect(parseSessionCookie(undefined)).toBeNull();
  });
});

describe('capability matching', () => {
  it('grants an exact capability', () => {
    expect(hasCapability(['FIN.JOURNAL.POST'], 'FIN.JOURNAL.POST')).toBe(true);
  });

  it('treats a wildcard as one whole segment, not as a prefix of a word', () => {
    expect(hasCapability(['PROC.*'], 'PROC.PO.CREATE')).toBe(true);
    expect(hasCapability(['PROC.*'], 'PROC')).toBe(true);

    // The bug this guards against: a naive prefix match would let PROC grant a
    // completely unrelated authority that merely starts with those letters.
    expect(hasCapability(['PROC'], 'PROCUREMENT.VIEW')).toBe(false);
    expect(hasCapability(['PROC.*'], 'PROCUREMENT.VIEW')).toBe(false);
  });

  it('does not grant a narrower capability than the one held', () => {
    expect(hasCapability(['PROC.PO.CREATE'], 'PROC.PO')).toBe(false);
    expect(hasCapability(['PROC.PO.CREATE'], 'PROC.PO.CREATE.APPROVE')).toBe(false);
  });

  it('grants everything to the superuser pattern', () => {
    expect(hasCapability(['*'], 'ANY.THING.AT.ALL')).toBe(true);
  });

  it('does not discard the suffix after an interior wildcard', () => {
    expect(hasCapability(['*.*.DISPLAY'], 'FIN.JOURNAL.DISPLAY')).toBe(true);
    expect(hasCapability(['*.*.DISPLAY'], 'FIN.JOURNAL.POST')).toBe(false);
    expect(hasCapability(['*.*.DISPLAY'], 'CFG.PLT.NUMBERRANGE.DEFINE')).toBe(false);
    expect(hasCapability(['*.PO.CREATE'], 'PROC.PO.CREATE')).toBe(true);
    expect(hasCapability(['*.PO.CREATE'], 'PROC.PO.RELEASE')).toBe(false);
  });

  it('denies when nothing is held', () => {
    expect(hasCapability([], 'FIN.JOURNAL.POST')).toBe(false);
  });
});
