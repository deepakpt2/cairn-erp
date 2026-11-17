/**
 * The personal account (AUTH-02, SU3): what belongs to one signed-in person.
 *
 * Every function here acts on the user it is handed and nobody else. Administering
 * other people is `user-admin.ts`; the pre-session token flows live there too and are
 * untouched. No capability is required — a session is enough — but the two dangerous
 * controls, changing the password and closing a session, still prove who is asking.
 */
import { randomUUID } from 'node:crypto';

import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { hashPassword, checkPasswordPolicy, verifyPassword } from '../../platform/auth/password';
import { revokeSessionById } from '../../platform/auth/session';
import { type Tx, withTenant } from '../../platform/db/client';
import { LOCALES } from '../../platform/i18n';
import { appUser, auditAccessLog, userSession } from '../../platform/tables/security';

export type AccountErrorCode =
  | 'PASSWORD_POLICY' | 'PASSWORD_MISMATCH' | 'PASSWORD_WRONG' | 'USER_NOT_FOUND'
  | 'SESSION_NOT_FOUND' | 'PREFERENCE_INVALID';

export class AccountError extends Error {
  readonly code: AccountErrorCode;
  readonly remedy: string;
  constructor(code: AccountErrorCode, message: string, remedy: string) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
    this.remedy = remedy;
  }
}

export const ACCOUNT_ROUTE = '/account';
export const ACCOUNT_SECTIONS = ['password', 'security', 'sessions', 'preferences'] as const;
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number];

/** What a user who must change their password may still open. Sign-out must stay reachable. */
export const ALLOWED_WHILE_CHANGE_REQUIRED: ReadonlySet<string> = new Set([ACCOUNT_ROUTE, '/signin', '/api/auth/signout']);

/**
 * Where a forced user is sent instead of `nextPath`, or null when they may proceed.
 * Only called with a path: pathless `requireSession()` calls (server actions, route
 * handlers) cannot be gated and are not.
 */
export function forcedChangeRedirect(mustChangePassword: boolean, nextPath: string | undefined): string | null {
  if (!mustChangePassword || !nextPath) return null;
  const path = nextPath.split('?')[0]!;
  if (ALLOWED_WHILE_CHANGE_REQUIRED.has(path)) return null;
  return `${ACCOUNT_ROUTE}?section=password&next=${encodeURIComponent(nextPath)}`;
}

/** A relative in-app path, or null. Never a full URL, a protocol-relative `//host` or a backslash form. */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /[\r\n]/.test(next)) return null;
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Password
// ─────────────────────────────────────────────────────────────────────────────

export interface ChangeOwnPasswordInput {
  client: string;
  userId: string;
  /** The `user_session` id of the caller. That session is kept; every other one is revoked. */
  currentSessionId?: string | null;
  currentPassword: string;
  newPassword: string;
  confirmation: string;
  ipAddress?: string | null;
}

export async function changeOwnPassword(input: ChangeOwnPasswordInput): Promise<{ ok: true; revokedSessions: number }> {
  const policy = checkPasswordPolicy(input.newPassword);
  if (policy) throw new AccountError('PASSWORD_POLICY', policy, 'Choose a password that meets the policy.');
  if (input.newPassword !== input.confirmation) {
    throw new AccountError('PASSWORD_MISMATCH', 'The new password and its confirmation are different.', 'Type the same new password twice.');
  }

  return withTenant(input.client, async (tx) => {
    const [user] = await tx
      .select({ id: appUser.id, username: appUser.username, hash: appUser.passwordHash, mustChange: appUser.mustChangePassword })
      .from(appUser)
      .where(and(eq(appUser.client, input.client), eq(appUser.id, input.userId)))
      .for('update');
    if (!user) throw new AccountError('USER_NOT_FOUND', 'This account no longer exists.', 'Sign in again.');

    // Without this a hijacked session could lock the real user out by changing the password.
    if (!(await verifyPassword(input.currentPassword, user.hash))) {
      throw new AccountError('PASSWORD_WRONG', 'The current password is not correct.', 'Type the password you signed in with.');
    }

    await tx.execute(sql`
      update app_user
         set password_hash = ${await hashPassword(input.newPassword)},
             must_change_password = false,
             changed_by = ${user.username},
             changed_at = now()
       where client = ${input.client} and id = ${user.id}
    `);

    // Every other session goes; this one stays, or the user is signed out mid-action.
    const others = await tx
      .select({ id: userSession.id })
      .from(userSession)
      .where(and(
        eq(userSession.client, input.client), eq(userSession.userId, user.id), isNull(userSession.revokedAt),
        input.currentSessionId ? ne(userSession.id, input.currentSessionId) : undefined,
      ));
    for (const other of others) {
      await revokeSessionById(tx, { client: input.client, sessionId: other.id, reason: 'password changed by the user' });
    }

    // Never the hash: recordChange serialises whatever it is given.
    await recordChange(tx, {
      client: input.client, objectClass: 'app_user', objectKey: user.id, changeType: 'CHANGE',
      changedBy: user.username,
      before: { mustChangePassword: user.mustChange },
      after: { mustChangePassword: false },
      securityRelevantFields: ['mustChangePassword'],
    });
    await tx.insert(auditAccessLog).values({
      id: randomUUID(), client: input.client, userId: user.id, username: user.username,
      eventType: 'CONFIG_CHANGE', objectType: 'app_user', objectKey: user.id,
      detail: 'Self-service password change', ipAddress: input.ipAddress ?? null,
    });
    return { ok: true as const, revokedSessions: others.length };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

export interface OwnSessionView {
  id: string; issuedAt: string; expiresAt: string;
  ipAddress: string | null; userAgent: string | null; isCurrent: boolean;
}

export async function listOwnSessions(input: { client: string; userId: string; currentSessionId: string }): Promise<OwnSessionView[]> {
  return withTenant(input.client, async (tx) => {
    const rows = await tx
      .select()
      .from(userSession)
      .where(and(
        eq(userSession.client, input.client), eq(userSession.userId, input.userId),
        isNull(userSession.revokedAt), gt(userSession.expiresAt, sql`now()`),
      ))
      .orderBy(desc(userSession.issuedAt))
      .limit(50);
    return rows.map((r) => ({
      id: r.id, issuedAt: r.issuedAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
      ipAddress: r.ipAddress, userAgent: r.userAgent, isCurrent: r.id === input.currentSessionId,
    }));
  });
}

/**
 * `revokeSessionById` revokes whatever id it is given, so the ownership check is here:
 * the row must belong to the caller before the id goes anywhere near it.
 */
export async function revokeOwnSession(input: { client: string; userId: string; sessionId: string }): Promise<{ revoked: boolean }> {
  return withTenant(input.client, async (tx) => {
    const [owned] = await tx
      .select({ id: userSession.id })
      .from(userSession)
      .where(and(eq(userSession.client, input.client), eq(userSession.id, input.sessionId), eq(userSession.userId, input.userId)));
    if (!owned) throw new AccountError('SESSION_NOT_FOUND', 'That session is not one of yours.', 'Reload the list and try again.');

    const revoked = await revokeSessionById(tx, { client: input.client, sessionId: owned.id, reason: 'closed by its owner' });
    if (revoked) {
      await tx.insert(auditAccessLog).values({
        id: randomUUID(), client: input.client, userId: input.userId,
        eventType: 'CONFIG_CHANGE', objectType: 'user_session', objectKey: owned.id,
        detail: 'Own session closed from the account screen',
      });
    }
    return { revoked };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Preferences
// ─────────────────────────────────────────────────────────────────────────────

/** The one-character keys of the registered UI locales (`en` → `E`). */
export function registeredLogonLanguages(): string[] {
  return LOCALES.map((l) => l.charAt(0).toUpperCase());
}

export async function readOwnPreferences(client: string, userId: string): Promise<Record<string, unknown>> {
  return withTenant(client, async (tx) => {
    const [row] = await tx.select({ p: appUser.preferences }).from(appUser)
      .where(and(eq(appUser.client, client), eq(appUser.id, userId)));
    return row?.p ?? {};
  });
}

/**
 * Merge, never replace: the column carries keys this screen does not know about.
 * Only `logonLanguage` is accepted — it is the one preference the product reads.
 * `dateFormat` and the separators are not read by any formatter yet, so offering them
 * would be a setting that does nothing.
 */
export async function saveOwnPreferences(input: {
  client: string; userId: string; logonLanguage?: string;
}): Promise<{ preferences: Record<string, unknown> }> {
  const patch: Record<string, unknown> = {};
  if (input.logonLanguage !== undefined) {
    const key = input.logonLanguage.trim().toUpperCase();
    if (!registeredLogonLanguages().includes(key)) {
      throw new AccountError(
        'PREFERENCE_INVALID', `“${input.logonLanguage}” is not a registered language.`,
        `Choose one of: ${registeredLogonLanguages().join(', ')}.`,
      );
    }
    patch.logonLanguage = key;
  }
  return withTenant(input.client, async (tx: Tx) => {
    const rows = (await tx.execute(sql`
      update app_user
         set preferences = preferences || ${JSON.stringify(patch)}::jsonb
       where client = ${input.client} and id = ${input.userId}
      returning preferences
    `)) as unknown as Array<{ preferences: Record<string, unknown> }>;
    if (!rows[0]) throw new AccountError('USER_NOT_FOUND', 'This account no longer exists.', 'Sign in again.');
    return { preferences: rows[0].preferences };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending actions — a query, never stored rows
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingAccountAction { key: 'CHANGE_PASSWORD'; message: string; actionLabel: string; href: string }

/**
 * What the system requires of this person. The two-factor line of §8 is not here:
 * AUTH-01 is not built, so there is no tenant setting or enrolment to ask about.
 */
export function pendingAccountActions(user: { mustChangePassword: boolean }): PendingAccountAction[] {
  const rows: PendingAccountAction[] = [];
  if (user.mustChangePassword) {
    rows.push({
      key: 'CHANGE_PASSWORD',
      message: 'Your password must be changed. It was reset by an administrator.',
      actionLabel: 'Change password',
      href: `${ACCOUNT_ROUTE}?section=password`,
    });
  }
  return rows;
}
