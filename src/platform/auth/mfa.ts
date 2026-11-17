/**
 * Two-factor authentication with a code generator (AUTH-01).
 *
 * The secret exists only as a keyring envelope; recovery codes only as SHA-256 hashes. Nothing
 * here is imported by a client component. MFA failures count against the challenge, never against
 * the account (`MAX_FAILED_ATTEMPTS` and `is_locked` are untouched).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import QRCode from 'qrcode';

import { recordChange } from '../change';
import { type Tx, withTenant } from '../db/client';
import { decryptBankData, encryptBankData, type BankDataContext } from '../security/bank-data-encryption';
import { loadBankDataKeyring } from '../security/bank-data-keyring';
import { appUser, auditAccessLog, mfaChallenge, userMfa, userMfaRecoveryCode } from '../tables/security';
import { client as clientTable } from '../tables/tenancy';
import { verifyPassword } from './password';
import { acceptTotp, generateSecret, otpauthUri, base32Decode } from './totp';
import { createChallenge, tenantRequiresMfa } from './mfa-challenge';
import { constantTimeEquals, hasCapability, revokeAllSessions } from './session';

export { createChallenge };

export const MFA_SECTION = 'security';
export const MFA_CHALLENGE_ROUTE = '/signin/mfa';
export const MFA_ADMIN_CAPABILITY = 'CFG.PLT.USER.MFA.RESET';
export const MFA_POLICY_CAPABILITY = 'CFG.PLT.USER.MAINTAIN';
export const MFA_REQUIRED_FLAG = 'MFA_REQUIRED';
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0 O 1 I L

export type MfaErrorCode =
  | 'ALREADY_ENROLLED' | 'NOT_ENROLLED' | 'NO_PENDING_ENROLMENT' | 'CODE_WRONG' | 'PASSWORD_WRONG'
  | 'CAPABILITY_MISSING' | 'REASON_REQUIRED' | 'USER_NOT_FOUND' | 'CHALLENGE_INVALID' | 'CHALLENGE_DEAD';

export class MfaError extends Error {
  readonly code: MfaErrorCode;
  readonly remedy: string;
  /** Attempts left on the challenge after a wrong code; 0 when it is dead. */
  readonly attemptsLeft?: number;
  constructor(code: MfaErrorCode, message: string, remedy: string, attemptsLeft?: number) {
    super(message);
    this.name = 'MfaError';
    this.code = code;
    this.remedy = remedy;
    this.attemptsLeft = attemptsLeft;
  }
}

export interface EnrolmentDraft {
  secretBase32: string;
  otpauthUri: string;
  /** Data-URI SVG for the QR. */
  qrDataUri: string | null;
}

// ── secret handling ─────────────────────────────────────────────────────────

/** Fixed AAD identity: `BankDataContext` carries bank vocabulary and is reused for a non-bank secret, as mail does. */
function secretContext(client: string, userId: string): BankDataContext {
  return { client, partnerNumber: 'MFA', bankRecordId: userId as BankDataContext['bankRecordId'], field: 'totpSecret' };
}
const seal = (client: string, userId: string, base32: string) =>
  encryptBankData(base32, secretContext(client, userId), loadBankDataKeyring());
const unseal = (client: string, userId: string, envelope: string) =>
  decryptBankData(envelope, secretContext(client, userId), loadBankDataKeyring());

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
/** Uppercase, strip everything that is not alphanumeric. */
export const normaliseRecoveryCode = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const bytes = randomBytes(10);
    const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`.toLowerCase();
  });
}

async function issueRecoveryCodes(tx: Tx, client: string, userId: string, by: string): Promise<string[]> {
  await tx.delete(userMfaRecoveryCode).where(and(eq(userMfaRecoveryCode.client, client), eq(userMfaRecoveryCode.userId, userId)));
  const codes = newRecoveryCodes();
  await tx.insert(userMfaRecoveryCode).values(codes.map((c) => ({
    id: randomUUID(), client, userId, codeHash: sha256(normaliseRecoveryCode(c)), createdBy: by,
  })));
  return codes;
}

async function draftFrom(tx: Tx, client: string, userId: string, base32: string): Promise<EnrolmentDraft> {
  const [user] = await tx.select({ username: appUser.username }).from(appUser).where(and(eq(appUser.client, client), eq(appUser.id, userId)));
  const [tenant] = await tx.select({ name: clientTable.name }).from(clientTable).where(eq(clientTable.client, client));
  const uri = otpauthUri({ issuer: tenant?.name || client, account: user?.username ?? userId, secretBase32: base32 });
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 1 });
  return { secretBase32: base32, otpauthUri: uri, qrDataUri: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
}

async function audit(tx: Tx, client: string, userId: string, detail: string, username?: string) {
  await tx.insert(auditAccessLog).values({
    id: randomUUID(), client, userId, username: username ?? null, eventType: 'CONFIG_CHANGE',
    objectType: 'app_user', objectKey: userId, detail,
  });
}

async function activeRow(tx: Tx, client: string, userId: string) {
  const [row] = await tx.select().from(userMfa).where(and(eq(userMfa.client, client), eq(userMfa.userId, userId))).for('update');
  return row;
}

// ── enrolment ───────────────────────────────────────────────────────────────

/** Overwrites a PENDING row; refuses over an ACTIVE one. */
async function beginIn(tx: Tx, client: string, userId: string, by: string): Promise<EnrolmentDraft> {
  const row = await activeRow(tx, client, userId);
  if (row?.status === 'ACTIVE') throw new MfaError('ALREADY_ENROLLED', 'Two-factor authentication is already on.', 'Turn it off first, then set it up again.');
  const secret = generateSecret();
  const envelope = seal(client, userId, secret.base32);
  if (row) {
    await tx.update(userMfa).set({ secretEncrypted: envelope, lastUsedStep: null, enrolledAt: new Date(), changedBy: by, changedAt: new Date() })
      .where(and(eq(userMfa.client, client), eq(userMfa.userId, userId)));
  } else {
    await tx.insert(userMfa).values({ client, userId, secretEncrypted: envelope, status: 'PENDING', enrolledAt: new Date(), createdBy: by });
  }
  return draftFrom(tx, client, userId, secret.base32);
}

export async function beginEnrolment(input: { client: string; userId: string; changedBy: string }): Promise<EnrolmentDraft> {
  return withTenant(input.client, (tx) => beginIn(tx, input.client, input.userId, input.changedBy));
}

/** The secret of a half-finished enrolment, for re-display after a page reload. Null when there is none. */
export async function pendingEnrolment(input: { client: string; userId: string }): Promise<EnrolmentDraft | null> {
  return withTenant(input.client, async (tx) => {
    const [row] = await tx.select().from(userMfa).where(and(eq(userMfa.client, input.client), eq(userMfa.userId, input.userId)));
    if (!row || row.status !== 'PENDING') return null;
    return draftFrom(tx, input.client, input.userId, unseal(input.client, input.userId, row.secretEncrypted));
  });
}

async function confirmIn(tx: Tx, client: string, userId: string, code: string, by: string, now: number): Promise<string[]> {
  const row = await activeRow(tx, client, userId);
  if (!row || row.status !== 'PENDING') throw new MfaError('NO_PENDING_ENROLMENT', 'There is no set-up in progress.', 'Start the set-up again.');
  const step = acceptTotp(base32Decode(unseal(client, userId, row.secretEncrypted)), code.replace(/\s/g, ''), now, null);
  if (step === null) throw new MfaError('CODE_WRONG', 'That code is not correct.', 'Type the six digits your authenticator app shows now.');
  await tx.update(userMfa).set({
    status: 'ACTIVE', confirmedAt: new Date(), lastUsedStep: step, lastUsedAt: new Date(), changedBy: by, changedAt: new Date(),
  }).where(and(eq(userMfa.client, client), eq(userMfa.userId, userId)));
  const codes = await issueRecoveryCodes(tx, client, userId, by);
  await recordChange(tx, {
    client, objectClass: 'app_user', objectKey: userId, changeType: 'CHANGE', changedBy: by,
    before: { mfaEnrolled: false }, after: { mfaEnrolled: true }, securityRelevantFields: ['mfaEnrolled'],
  });
  await audit(tx, client, userId, 'Two-factor authentication turned on', by);
  return codes;
}

export async function confirmEnrolment(
  input: { client: string; userId: string; code: string; changedBy: string; nowMs?: number },
): Promise<{ recoveryCodes: string[] }> {
  return withTenant(input.client, async (tx) => ({
    recoveryCodes: await confirmIn(tx, input.client, input.userId, input.code, input.changedBy, input.nowMs ?? Date.now()),
  }));
}

// ── own account ─────────────────────────────────────────────────────────────

async function requirePassword(tx: Tx, client: string, userId: string, password: string): Promise<string> {
  const [u] = await tx.select({ hash: appUser.passwordHash, username: appUser.username }).from(appUser).where(and(eq(appUser.client, client), eq(appUser.id, userId)));
  if (!u) throw new MfaError('USER_NOT_FOUND', 'This account no longer exists.', 'Sign in again.');
  if (!(await verifyPassword(password, u.hash))) throw new MfaError('PASSWORD_WRONG', 'The current password is not correct.', 'Type the password you signed in with.');
  return u.username;
}

/** Needs the password and a current code: a hijacked session must not be enough to remove the second factor. */
export async function disableMfa(
  input: { client: string; userId: string; password: string; code: string; changedBy: string; nowMs?: number },
): Promise<void> {
  await withTenant(input.client, async (tx) => {
    await requirePassword(tx, input.client, input.userId, input.password);
    const row = await activeRow(tx, input.client, input.userId);
    if (!row || row.status !== 'ACTIVE') throw new MfaError('NOT_ENROLLED', 'Two-factor authentication is not on.', 'There is nothing to turn off.');
    const step = acceptTotp(base32Decode(unseal(input.client, input.userId, row.secretEncrypted)), input.code.replace(/\s/g, ''), input.nowMs ?? Date.now(), row.lastUsedStep);
    if (step === null) throw new MfaError('CODE_WRONG', 'That code is not correct.', 'Type the six digits your authenticator app shows now. A code can be used once.');
    await wipe(tx, input.client, input.userId);
    await recordChange(tx, {
      client: input.client, objectClass: 'app_user', objectKey: input.userId, changeType: 'CHANGE', changedBy: input.changedBy,
      before: { mfaEnrolled: true }, after: { mfaEnrolled: false }, securityRelevantFields: ['mfaEnrolled'],
    });
    await audit(tx, input.client, input.userId, 'Two-factor authentication turned off', input.changedBy);
  });
}

async function wipe(tx: Tx, client: string, userId: string) {
  await tx.delete(userMfaRecoveryCode).where(and(eq(userMfaRecoveryCode.client, client), eq(userMfaRecoveryCode.userId, userId)));
  await tx.delete(userMfa).where(and(eq(userMfa.client, client), eq(userMfa.userId, userId)));
  await tx.update(mfaChallenge).set({ consumedAt: new Date() })
    .where(and(eq(mfaChallenge.client, client), eq(mfaChallenge.userId, userId), sql`consumed_at is null`));
}

export async function regenerateRecoveryCodes(
  input: { client: string; userId: string; password: string; changedBy: string },
): Promise<{ recoveryCodes: string[] }> {
  return withTenant(input.client, async (tx) => {
    await requirePassword(tx, input.client, input.userId, input.password);
    const row = await activeRow(tx, input.client, input.userId);
    if (!row || row.status !== 'ACTIVE') throw new MfaError('NOT_ENROLLED', 'Two-factor authentication is not on.', 'Set it up first.');
    const recoveryCodes = await issueRecoveryCodes(tx, input.client, input.userId, input.changedBy);
    await audit(tx, input.client, input.userId, 'Two-factor recovery codes regenerated', input.changedBy);
    return { recoveryCodes };
  });
}

export async function mfaStatus(input: { client: string; userId: string }): Promise<{
  enrolled: boolean; pending: boolean; confirmedAt: string | null; remainingRecoveryCodes: number;
}> {
  return withTenant(input.client, async (tx) => {
    const [row] = await tx.select().from(userMfa).where(and(eq(userMfa.client, input.client), eq(userMfa.userId, input.userId)));
    const left = (await tx.execute(sql`
      select count(*)::int as n from user_mfa_recovery_code
       where client = ${input.client} and user_id = ${input.userId} and used_at is null
    `)) as unknown as Array<{ n: number }>;
    return {
      enrolled: row?.status === 'ACTIVE', pending: row?.status === 'PENDING',
      confirmedAt: row?.confirmedAt?.toISOString() ?? null, remainingRecoveryCodes: Number(left[0]?.n ?? 0),
    };
  });
}

// ── administrator reset ─────────────────────────────────────────────────────

/** The lockout escape: audited, a capability of its own, and it does not set must_change_password. */
export async function adminResetMfa(
  input: { client: string; userId: string; changedBy: string; reason: string },
  capabilities: string[],
): Promise<void> {
  if (!hasCapability(capabilities, MFA_ADMIN_CAPABILITY)) {
    throw new MfaError('CAPABILITY_MISSING', `Resetting two-factor needs ${MFA_ADMIN_CAPABILITY}, which this session does not hold.`, `Ask an administrator to grant ${MFA_ADMIN_CAPABILITY} to one of your roles.`);
  }
  const reason = input.reason.trim();
  if (!reason) throw new MfaError('REASON_REQUIRED', 'A reason is required.', 'Say why the second factor is being reset.');
  await withTenant(input.client, async (tx) => {
    const row = await activeRow(tx, input.client, input.userId);
    if (!row) throw new MfaError('NOT_ENROLLED', 'This user has no two-factor enrolment.', 'There is nothing to reset.');
    await wipe(tx, input.client, input.userId);
    await revokeAllSessions(tx, { client: input.client, userId: input.userId, reason: 'two-factor reset by an administrator' });
    await recordChange(tx, {
      client: input.client, objectClass: 'app_user', objectKey: input.userId, changeType: 'CHANGE', changedBy: input.changedBy, reason,
      before: { mfaEnrolled: row.status === 'ACTIVE' }, after: { mfaEnrolled: false }, securityRelevantFields: ['mfaEnrolled'],
    });
    await audit(tx, input.client, input.userId, `Two-factor reset by administrator: ${reason}`, input.changedBy);
  });
}

// ── tenant policy ───────────────────────────────────────────────────────────

export async function isMfaRequired(client: string): Promise<boolean> {
  return withTenant(client, (tx) => tenantRequiresMfa(tx, client));
}

/** Merge idiom: an unrelated flag survives. Needs CFG.PLT.USER.MAINTAIN. */
export async function setMfaRequired(
  input: { client: string; enabled: boolean; changedBy: string },
  capabilities: string[],
): Promise<{ enabled: boolean }> {
  if (!hasCapability(capabilities, MFA_POLICY_CAPABILITY)) {
    throw new MfaError('CAPABILITY_MISSING', `Changing the two-factor policy needs ${MFA_POLICY_CAPABILITY}, which this session does not hold.`, `Ask an administrator to grant ${MFA_POLICY_CAPABILITY} to one of your roles.`);
  }
  return withTenant(input.client, async (tx) => {
    const before = await tenantRequiresMfa(tx, input.client);
    await tx.execute(sql`
      insert into client_settings (client, flags, created_by)
      values (${input.client}, jsonb_build_object(${MFA_REQUIRED_FLAG}::text, ${input.enabled}::bool), ${input.changedBy})
      on conflict (client) do update
        set flags = coalesce(client_settings.flags, '{}'::jsonb) || jsonb_build_object(${MFA_REQUIRED_FLAG}::text, ${input.enabled}::bool),
            changed_by = ${input.changedBy}, changed_at = now()
    `);
    const key = `flags.${MFA_REQUIRED_FLAG}`;
    await recordChange(tx, {
      client: input.client, objectClass: 'client_settings', objectKey: input.client, changeType: 'CHANGE', changedBy: input.changedBy,
      transactionCode: MFA_POLICY_CAPABILITY, before: { [key]: before }, after: { [key]: input.enabled }, securityRelevantFields: [key],
    });
    return { enabled: input.enabled };
  });
}

/** For the pending band and the launchpad: the tenant demands two-factor and this user has none. */
export async function mfaEnrolmentOutstanding(client: string, userId: string): Promise<boolean> {
  return withTenant(client, async (tx) => {
    if (!(await tenantRequiresMfa(tx, client))) return false;
    const rows = (await tx.execute(sql`select status from user_mfa where client = ${client} and user_id = ${userId}`)) as unknown as Array<{ status: string }>;
    return rows[0]?.status !== 'ACTIVE';
  });
}

// ── the challenge ───────────────────────────────────────────────────────────

export interface ChallengeView { live: boolean; attemptsLeft: number; enrolment: EnrolmentDraft | null }

/**
 * What the challenge screen shows. For a user with no ACTIVE factor (the tenant requires one) this also
 * returns the secret to enrol with, creating a PENDING row on first sight and reusing it on reload.
 */
export async function challengeView(input: { client: string; challengeId: string }): Promise<ChallengeView> {
  return withTenant(input.client, async (tx) => {
    const [c] = await tx.select().from(mfaChallenge).where(and(eq(mfaChallenge.client, input.client), eq(mfaChallenge.id, input.challengeId)));
    if (!c || c.consumedAt || c.expiresAt.getTime() <= Date.now() || c.attempts >= c.maxAttempts) return { live: false, attemptsLeft: 0, enrolment: null };
    const [row] = await tx.select().from(userMfa).where(and(eq(userMfa.client, input.client), eq(userMfa.userId, c.userId)));
    let enrolment: EnrolmentDraft | null = null;
    if (row?.status !== 'ACTIVE') {
      enrolment = row
        ? await draftFrom(tx, input.client, c.userId, unseal(input.client, c.userId, row.secretEncrypted))
        : await beginIn(tx, input.client, c.userId, 'AUTH');
    }
    return { live: true, attemptsLeft: c.maxAttempts - c.attempts, enrolment };
  });
}

type VerifyOutcome =
  | { ok: true; userId: string; recoveryCodes?: string[] }
  | { ok: false; code: MfaErrorCode; message: string; remedy: string; attemptsLeft: number };

export interface VerifyChallengeInput {
  client: string; challengeId: string; code: string; ipAddress?: string | null; nowMs?: number;
}

/**
 * Check a code (or a recovery code) against a challenge, in one transaction with the row locked.
 * A refusal is *returned* from the transaction and thrown afterwards so the attempt count commits.
 * The caller creates the session from the returned user id — never from a form field.
 */
export async function verifyChallenge(input: VerifyChallengeInput): Promise<{ userId: string; recoveryCodes?: string[] }> {
  const now = input.nowMs ?? Date.now();
  const outcome = await withTenant(input.client, async (tx): Promise<VerifyOutcome> => {
    const [c] = await tx.select().from(mfaChallenge)
      .where(and(eq(mfaChallenge.client, input.client), eq(mfaChallenge.id, input.challengeId))).for('update');
    const dead = (): VerifyOutcome => ({ ok: false, code: 'CHALLENGE_DEAD', message: 'This sign-in has expired.', remedy: 'Sign in again.', attemptsLeft: 0 });
    if (!c || c.consumedAt || c.expiresAt.getTime() <= now || c.attempts >= c.maxAttempts) return dead();

    const row = await activeRow(tx, input.client, c.userId);
    const entered = input.code.trim();
    let ok = false;
    let recoveryCodes: string[] | undefined;

    if (row && /^\d{3}\s?\d{3}$/.test(entered)) {
      const step = acceptTotp(base32Decode(unseal(input.client, c.userId, row.secretEncrypted)), entered.replace(/\s/g, ''), now, row.lastUsedStep);
      if (step !== null) {
        // Guarded update: two concurrent posts of the same code produce one success.
        const claimed = (await tx.execute(sql`
          update user_mfa set last_used_step = ${step}, last_used_at = now()
           where client = ${input.client} and user_id = ${c.userId}
             and (last_used_step is null or last_used_step < ${step})
          returning 1 as n
        `)) as unknown as unknown[];
        if (claimed.length > 0) {
          ok = true;
          if (row.status === 'PENDING') recoveryCodes = await confirmIn2(tx, input.client, c.userId, step);
        }
      }
    } else if (row?.status === 'ACTIVE' && normaliseRecoveryCode(entered).length === 10) {
      const hash = sha256(normaliseRecoveryCode(entered));
      const used = (await tx.execute(sql`
        update user_mfa_recovery_code set used_at = now(), changed_by = 'AUTH', changed_at = now()
         where client = ${input.client} and user_id = ${c.userId} and code_hash = ${hash} and used_at is null
        returning id
      `)) as unknown as unknown[];
      ok = used.length > 0;
    }

    if (!ok) {
      const attempts = c.attempts + 1;
      await tx.update(mfaChallenge).set({ attempts, changedBy: 'AUTH', changedAt: new Date() }).where(eq(mfaChallenge.id, c.id));
      await tx.insert(auditAccessLog).values({
        id: randomUUID(), client: input.client, userId: c.userId, eventType: 'LOGIN_FAILED',
        detail: `Wrong second-factor code — attempt ${attempts} of ${c.maxAttempts}`, ipAddress: input.ipAddress ?? null,
      });
      const left = Math.max(0, c.maxAttempts - attempts);
      return { ok: false, code: left === 0 ? 'CHALLENGE_DEAD' : 'CODE_WRONG', message: left === 0 ? 'Too many wrong codes. This sign-in has ended.' : 'That code is not correct.', remedy: left === 0 ? 'Sign in again.' : 'Try the current code, or use a recovery code.', attemptsLeft: left };
    }

    const consumed = (await tx.execute(sql`
      update mfa_challenge set consumed_at = now(), changed_by = 'AUTH', changed_at = now()
       where id = ${c.id} and consumed_at is null returning 1 as n
    `)) as unknown as unknown[];
    if (consumed.length === 0) return dead();
    await tx.execute(sql`update app_user set last_login_at = now() where client = ${input.client} and id = ${c.userId}`);
    await tx.insert(auditAccessLog).values({
      id: randomUUID(), client: input.client, userId: c.userId, eventType: 'LOGIN',
      detail: 'Second factor accepted', ipAddress: input.ipAddress ?? null,
    });
    return { ok: true, userId: c.userId, ...(recoveryCodes ? { recoveryCodes } : {}) };
  });

  if (!outcome.ok) throw new MfaError(outcome.code, outcome.message, outcome.remedy, outcome.attemptsLeft);
  return { userId: outcome.userId, ...(outcome.recoveryCodes ? { recoveryCodes: outcome.recoveryCodes } : {}) };
}

/** Enrolment confirmed from the challenge screen: the code was already checked and its step claimed. */
async function confirmIn2(tx: Tx, client: string, userId: string, step: number): Promise<string[]> {
  await tx.update(userMfa).set({ status: 'ACTIVE', confirmedAt: new Date(), lastUsedStep: step, changedBy: 'AUTH', changedAt: new Date() })
    .where(and(eq(userMfa.client, client), eq(userMfa.userId, userId)));
  const codes = await issueRecoveryCodes(tx, client, userId, 'AUTH');
  await recordChange(tx, {
    client, objectClass: 'app_user', objectKey: userId, changeType: 'CHANGE', changedBy: 'AUTH',
    before: { mfaEnrolled: false }, after: { mfaEnrolled: true }, securityRelevantFields: ['mfaEnrolled'],
  });
  await audit(tx, client, userId, 'Two-factor authentication turned on at sign-in');
  return codes;
}

void constantTimeEquals; // codes are compared inside `acceptTotp` with constantTimeEquals, never `===`
