/**
 * Sign-in and sessions — CAIRN.md §23, decisions D-005 and D-044.
 *
 * ## Why the tenant key is part of signing in
 *
 * A tenant (client) is the partition that row-level security enforces, and every
 * query runs inside a tenant scope. Sign-in therefore has a chicken-and-egg
 * problem: to find a user we must already know which tenant to look in, but the
 * tenant is what we are trying to establish.
 *
 * There are two honest ways out: a cross-tenant lookup function outside row-level
 * security (the narrow SECURITY DEFINER pattern of D-038), or asking for the
 * tenant key at the logon screen. We ask. The reference model does the same — its
 * logon screen takes client, user and password — and it is the better answer on
 * the merits, not just on precedent: the tenant key is not a secret (it appears in
 * every URL and on every printed document), so making it an explicit input keeps
 * the security boundary exactly where it belongs, on the credential, and keeps the
 * tenant scope established *before* the first row is read rather than widened
 * afterwards to find one.
 *
 * Consequence, and it is a deliberate one: the session cookie is
 * `client.token` and is not signed. Tampering with the client half only re-points
 * the lookup at a different tenant, where that token does not exist — the token is
 * 256 bits of randomness stored only as a hash, so possession is the entire
 * credential and the client half carries no authority. Signing it would add a
 * ceremony that protects nothing.
 *
 * ## What is stored
 *
 * Sessions are server-side rows (D-005) — the cookie carries an opaque token and
 * nothing else, so revoking a session takes effect immediately and a stolen cookie
 * is not a self-contained credential. The token is stored as a SHA-256 hash, never
 * raw, so a database leak does not hand over live sessions.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../db/client';
import { verifyPassword } from './password';

export const SESSION_COOKIE = 'cairn_session';

/**
 * A working day. Long enough that nobody is signed out mid-task, short enough
 * that an abandoned browser is not a standing key to the ledgers.
 */
export const SESSION_TTL_MINUTES = 12 * 60;

/**
 * Failed attempts before the account locks, matching the reference profile
 * parameter's order of magnitude (theirs locks at three).
 *
 * Deliberately five, and deliberately a named constant: the unlock screen does
 * not exist yet, so three would leave a user who mistypes twice locked out with
 * no way back in. This is a divergence from the reference default and is recorded
 * as such — it must return to three once an administrator can unlock an account.
 */
export const MAX_FAILED_ATTEMPTS = 5;

/** Renew when less than this much of the session's life remains. */
const RENEW_WHEN_REMAINING_MINUTES = SESSION_TTL_MINUTES / 4;

export class AuthError extends Error {
  readonly remedy: string;
  readonly code: string;

  constructor(message: string, remedy: string, code = 'CAIRN_AUTH') {
    super(message);
    this.name = 'AuthError';
    this.remedy = remedy;
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokens and cookies
// ─────────────────────────────────────────────────────────────────────────────

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function encodeSessionCookie(client: string, rawToken: string): string {
  return `${client}.${rawToken}`;
}

export function parseSessionCookie(value: string | undefined): {
  client: string;
  token: string;
} | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;

  const client = value.slice(0, dot);
  const token = value.slice(dot + 1);

  // The tenant key is interpolated into a SET statement, so it is validated here
  // with the same discipline as everywhere else: four alphanumerics, nothing more.
  if (!/^[A-Za-z0-9]{4}$/.test(client)) return null;
  if (token.length < 20) return null;

  return { client, token };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────────

async function writeAccessLog(
  tx: Tx,
  entry: {
    client: string;
    userId?: string | null;
    username?: string | null;
    eventType: 'LOGIN' | 'LOGOUT' | 'LOGIN_FAILED' | 'CAPABILITY_DENIED' | 'READ' | 'EXPORT' | 'CONFIG_CHANGE';
    detail?: string;
    ipAddress?: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into audit_access_log
      (id, client, user_id, username, event_type, detail, ip_address)
    values (
      ${randomUUID()}, ${entry.client}, ${entry.userId ?? null}, ${entry.username ?? null},
      ${entry.eventType}, ${entry.detail ?? null}, ${entry.ipAddress ?? null}
    )
  `);
}



// ─────────────────────────────────────────────────────────────────────────────
// Sign in
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthenticatedUser {
  client: string;
  userId: string;
  username: string;
  fullName: string;
  email: string | null;
  mustChangePassword: boolean;
  capabilities: string[];
}

interface UserRow {
  id: string;
  client: string;
  username: string;
  full_name: string;
  email: string | null;
  password_hash: string;
  is_active: boolean;
  is_locked: boolean;
  must_change_password: boolean;
  failed_login_count: string;
}

/**
 * What a sign-in attempt produced.
 *
 * A result rather than an exception, and that is a deliberate correction. The
 * first version threw inside the tenant transaction — and because a thrown error
 * rolls the transaction back, both the failed-attempt counter and the audit row
 * were discarded along with it. The lockout never happened and the access log
 * recorded nothing, while the caller saw exactly the right error message.
 *
 * Recording an attempt and refusing it are the same event, so they must commit
 * together. This function therefore always returns normally; the exception is
 * raised by `signIn` *after* the transaction has committed.
 */
export type AuthOutcome =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; code: string; message: string; remedy: string };

function refuse(code: string, message: string, remedy: string): AuthOutcome {
  return { ok: false, code, message, remedy };
}

/** The message for every credential failure. Never say which half was wrong. */
const INVALID_MESSAGE = 'The tenant, user or password is not correct.';
const INVALID_REMEDY =
  'Check the three fields and try again. After several failed attempts the user is locked until an administrator unlocks it.';

/**
 * Verify credentials inside a tenant scope and count the attempt.
 *
 * Must run inside the caller's transaction: the counter and the audit row belong
 * to the same commit as the refusal itself.
 */
export async function attemptSignIn(
  tx: Tx,
  input: {
    client: string;
    username: string;
    password: string;
    ipAddress?: string | null;
  },
): Promise<AuthOutcome> {
  const rows = (await tx.execute(sql`
    select id, client, username, full_name, email, password_hash,
           is_active, is_locked, must_change_password, failed_login_count
      from app_user
     where client = ${input.client}
       and lower(username) = lower(${input.username})
     limit 1
  `)) as unknown as UserRow[];

  const user = rows[0];

  if (!user) {
    // Same message as a wrong password. A different one would let anyone enumerate
    // which usernames exist in a tenant.
    await writeAccessLog(tx, {
      client: input.client,
      username: input.username,
      eventType: 'LOGIN_FAILED',
      detail: 'Unknown user',
      ipAddress: input.ipAddress,
    });
    return refuse('CAIRN_AUTH_INVALID', INVALID_MESSAGE, INVALID_REMEDY);
  }

  if (!user.is_active) {
    await writeAccessLog(tx, {
      client: input.client,
      userId: user.id,
      username: user.username,
      eventType: 'LOGIN_FAILED',
      detail: 'User is not active',
      ipAddress: input.ipAddress,
    });
    return refuse(
      'CAIRN_AUTH_INACTIVE',
      'This user is not active.',
      'Ask an administrator to activate the user before signing in.',
    );
  }

  if (user.is_locked) {
    await writeAccessLog(tx, {
      client: input.client,
      userId: user.id,
      username: user.username,
      eventType: 'LOGIN_FAILED',
      detail: 'User is locked',
      ipAddress: input.ipAddress,
    });
    return refuse(
      'CAIRN_AUTH_LOCKED',
      'This user is locked after too many failed attempts.',
      'An administrator must unlock the user before you can sign in again.',
    );
  }

  const ok = await verifyPassword(input.password, user.password_hash);

  if (!ok) {
    const attempts = Number(user.failed_login_count) + 1;
    const nowLocked = attempts >= MAX_FAILED_ATTEMPTS;

    await tx.execute(sql`
      update app_user
         set failed_login_count = ${String(attempts)},
             is_locked          = ${nowLocked},
             changed_by         = 'AUTH',
             changed_at         = now()
       where client = ${input.client} and id = ${user.id}
    `);

    await writeAccessLog(tx, {
      client: input.client,
      userId: user.id,
      username: user.username,
      eventType: 'LOGIN_FAILED',
      detail: nowLocked
        ? `Wrong password — user locked after ${attempts} failed attempts`
        : `Wrong password — attempt ${attempts} of ${MAX_FAILED_ATTEMPTS}`,
      ipAddress: input.ipAddress,
    });

    if (nowLocked) {
      return refuse(
        'CAIRN_AUTH_LOCKED',
        `This user is locked after ${attempts} failed attempts.`,
        'An administrator must unlock the user before you can sign in again.',
      );
    }

    return refuse('CAIRN_AUTH_INVALID', INVALID_MESSAGE, INVALID_REMEDY);
  }

  await tx.execute(sql`
    update app_user
       set failed_login_count = '0',
           last_login_at      = now(),
           changed_by         = 'AUTH',
           changed_at         = now()
     where client = ${input.client} and id = ${user.id}
  `);

  const capabilities = await loadCapabilities(tx, input.client, user.id);

  await writeAccessLog(tx, {
    client: input.client,
    userId: user.id,
    username: user.username,
    eventType: 'LOGIN',
    detail: `Signed in with ${capabilities.length} capability pattern(s)`,
    ipAddress: input.ipAddress,
  });

  return {
    ok: true,
    user: {
      client: user.client,
      userId: user.id,
      username: user.username,
      fullName: user.full_name,
      email: user.email,
      mustChangePassword: user.must_change_password,
      capabilities,
    },
  };
}

/**
 * Sign in, committing the attempt before reporting the result.
 *
 * The order matters and is the whole reason this wrapper exists: the transaction
 * commits first, so a refused attempt is on the record and a lockout is real, and
 * only then is the exception raised for the caller to display.
 */
export async function signIn(input: {
  client: string;
  username: string;
  password: string;
  ipAddress?: string | null;
}): Promise<AuthenticatedUser> {
  const outcome = await withTenant(input.client, (tx) => attemptSignIn(tx, input));

  if (!outcome.ok) {
    throw new AuthError(outcome.message, outcome.remedy, outcome.code);
  }

  return outcome.user;
}

/**
 * Issue a session and return the raw token. Only the hash is stored.
 *
 * The token is returned to exactly one caller — the code that sets the cookie —
 * and never logged or persisted in raw form.
 */
export async function createSession(
  tx: Tx,
  input: {
    client: string;
    userId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    ttlMinutes?: number;
  },
): Promise<{ token: string; expiresAt: Date }> {
  const raw = randomBytes(32).toString('base64url');
  const ttl = input.ttlMinutes ?? SESSION_TTL_MINUTES;
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  await tx.execute(sql`
    insert into user_session
      (id, client, user_id, token_hash, issued_at, expires_at, ip_address, user_agent)
    values (
      ${randomUUID()}, ${input.client}, ${input.userId}, ${hashToken(raw)},
      now(), ${expiresAt.toISOString()}, ${input.ipAddress ?? null}, ${input.userAgent ?? null}
    )
  `);

  return { token: raw, expiresAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve an existing session
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionContext {
  user: AuthenticatedUser;
  expiresAt: Date;
  /** True when this request extended the session, so the caller refreshes the cookie. */
  renewed: boolean;
}

/**
 * Resolve a cookie into a session, inside the tenant scope the cookie names.
 *
 * Returns null — never throws — for anything that is not a live session: unknown
 * token, revoked, expired, user deactivated or locked since sign-in. The caller
 * treats them all the same way, which is the correct behaviour: send them to the
 * logon screen.
 */
export async function resolveSession(
  tx: Tx,
  input: { client: string; token: string },
): Promise<SessionContext | null> {
  const rows = (await tx.execute(sql`
    select s.user_id, s.expires_at, s.revoked_at, s.token_hash,
           u.username, u.full_name, u.email, u.is_active, u.is_locked,
           u.must_change_password
      from user_session s
      join app_user u on u.client = s.client and u.id = s.user_id
     where s.client = ${input.client}
       and s.token_hash = ${hashToken(input.token)}
     limit 1
  `)) as unknown as Array<{
    user_id: string;
    expires_at: string | Date;
    revoked_at: string | Date | null;
    token_hash: string;
    username: string;
    full_name: string;
    email: string | null;
    is_active: boolean;
    is_locked: boolean;
    must_change_password: boolean;
  }>;

  const row = rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;
  if (!row.is_active || row.is_locked) return null;

  const expiresAt = new Date(row.expires_at);
  const now = Date.now();
  if (expiresAt.getTime() <= now) return null;

  // Sliding renewal, but only in the last quarter of the session's life — so a
  // busy user is never interrupted, and an idle tab still expires on schedule.
  const remainingMinutes = (expiresAt.getTime() - now) / 60_000;
  let renewed = false;

  if (remainingMinutes < RENEW_WHEN_REMAINING_MINUTES) {
    const next = new Date(now + SESSION_TTL_MINUTES * 60_000);
    await tx.execute(sql`
      update user_session
         set expires_at = ${next.toISOString()}
       where client = ${input.client} and token_hash = ${hashToken(input.token)}
    `);
    renewed = true;
    return {
      user: {
        client: input.client,
        userId: row.user_id,
        username: row.username,
        fullName: row.full_name,
        email: row.email,
        mustChangePassword: row.must_change_password,
        capabilities: await loadCapabilities(tx, input.client, row.user_id),
      },
      expiresAt: next,
      renewed,
    };
  }

  return {
    user: {
      client: input.client,
      userId: row.user_id,
      username: row.username,
      fullName: row.full_name,
      email: row.email,
      mustChangePassword: row.must_change_password,
      capabilities: await loadCapabilities(tx, input.client, row.user_id),
    },
    expiresAt,
    renewed,
  };
}

/** Revoke one session. Idempotent: revoking a dead session is not an error. */
export async function revokeSession(
  tx: Tx,
  input: { client: string; token: string; username?: string | null },
): Promise<void> {
  await tx.execute(sql`
    update user_session
       set revoked_at = now()
     where client = ${input.client}
       and token_hash = ${hashToken(input.token)}
       and revoked_at is null
  `);

  await writeAccessLog(tx, {
    client: input.client,
    username: input.username ?? null,
    eventType: 'LOGOUT',
    detail: 'Signed out',
  });
}

/** Revoke every live session for a user — used when a password changes or a user is locked. */
export async function revokeAllSessions(
  tx: Tx,
  input: { client: string; userId: string; reason: string },
): Promise<number> {
  const result = (await tx.execute(sql`
    update user_session
       set revoked_at = now()
     where client = ${input.client}
       and user_id = ${input.userId}
       and revoked_at is null
    returning id
  `)) as unknown as Array<{ id: string }>;

  if (result.length > 0) {
    await writeAccessLog(tx, {
      client: input.client,
      userId: input.userId,
      eventType: 'LOGOUT',
      detail: `Revoked ${result.length} session(s): ${input.reason}`,
    });
  }

  return result.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The capability patterns a user holds, resolved through their roles.
 *
 * Patterns, because a role is a set of authorities rather than a list of screens:
 * `PROC.*` grants buying without enumerating every purchasing screen, and adding a
 * screen later must not require editing thirty roles (D-037).
 */
export async function loadCapabilities(
  tx: Tx,
  client: string,
  userId: string,
): Promise<string[]> {
  const now = new Date().toISOString();
  const rows = (await tx.execute(sql`
    select distinct rc.capability_code
      from user_role ur
      join role_capability rc on rc.client = ur.client and rc.role_code = ur.role_code
     where ur.client = ${client}
       and ur.user_id = ${userId}
       and (ur.valid_from is null or ur.valid_from <= ${now})
       and (ur.valid_to   is null or ur.valid_to   >= ${now})
     order by rc.capability_code
  `)) as unknown as Array<{ capability_code: string }>;

  return rows.map((r) => r.capability_code);
}

/**
 * Does the user hold this authority?
 *
 * Matching is on whole dot-separated segments: `PROC.*` grants `PROC.PO.CREATE`,
 * and `PROC` alone grants nothing. A naive `startsWith` would let `PROC` match
 * `PROCUREMENT.VIEW` — which is precisely the class of bug that turns an
 * authorisation check into a decoration.
 */
export function hasCapability(capabilities: string[], required: string): boolean {
  const requiredParts = required.split('.');
  return capabilities.some((held) => patternGrants(held.split('.'), requiredParts));
}

/**
 * Does one held pattern grant one required authority?
 *
 * Segments are compared position by position, and a `*` covers the remainder of
 * the path — so `PROC.*` grants `PROC.PO.CREATE` and also `PROC` itself, while
 * `PROC.PO.CREATE` grants that authority and nothing else.
 *
 * The rule that matters is the one about length. A held pattern must account for
 * the *whole* required path and no more:
 *
 *   held `PROC.PO.CREATE`, required `PROC.PO`              → no. Holding create is
 *                                                            not holding the object.
 *   held `PROC.PO.CREATE`, required `...CREATE.APPROVE`    → no. Approving is a
 *                                                            different authority.
 *
 * Both were granted by the first version of this function, which stopped as soon
 * as the held segments ran out — so any authority that began with a held one was
 * allowed, and `PROC.PO.CREATE` would have granted `PROC.PO.CREATE.APPROVE`. That
 * is the difference between an authorisation check and a decoration.
 */
function patternGrants(heldParts: string[], requiredParts: string[]): boolean {
  for (let i = 0; i < heldParts.length; i += 1) {
    if (heldParts[i] === '*') {
      // A terminal wildcard covers the remainder, including no more segments.
      // An interior wildcard consumes ONE segment; its suffix still has to match.
      if (i === heldParts.length - 1) return true;
      if (i >= requiredParts.length) return false;
      continue;
    }
    // The pattern is longer than the requirement: it would be granting a
    // sub-authority of what was asked for, which is not what was asked.
    if (i >= requiredParts.length) return false;
    if (heldParts[i] !== requiredParts[i]) return false;
  }

  // The pattern ran out. It grants only if it consumed the requirement exactly.
  return heldParts.length === requiredParts.length;
}

/** Used by constant-time comparisons in tests and diagnostics. */
export function tokenHashFor(raw: string): string {
  return hashToken(raw);
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
