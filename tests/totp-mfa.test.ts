/**
 * AUTH-01 — TOTP two-factor authentication. Real erp_test database.
 * Codes are compared in `acceptTotp` with `constantTimeEquals` (session.ts), never `===`.
 */
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptTotp, base32Decode, base32Encode, generateSecret, otpauthUri, stepAt, totpForStep,
} from '../src/platform/auth/totp';
import {
  adminResetMfa, beginEnrolment, challengeView, confirmEnrolment, disableMfa, mfaStatus, MfaError,
  regenerateRecoveryCodes, setMfaRequired, verifyChallenge, MFA_ADMIN_CAPABILITY,
} from '../src/platform/auth/mfa';
import { createSession, signIn } from '../src/platform/auth/session';
import { appUser, userMfa, userMfaRecoveryCode, mfaChallenge } from '../src/platform/tables/security';
import { withTenant } from '../src/platform/db/client';
import { createUser } from '../src/modules/platform/user-admin';
import { createTenant, destroyTenant } from './helpers';

const PASSWORD = 'Original-Passw0rd!';
const ACTOR = 'MFA-TEST';
let a = '';
let b = '';
let n = 0;
const saved: Record<string, string | undefined> = {};

async function mkUser(client = a) {
  n += 1;
  const u = await createUser({ client, username: `mfa.user${n}`, fullName: 'Mfa User', email: `mfa${n}@example.com`, password: PASSWORD, changedBy: ACTOR }, ['CFG.PLT.USER.CREATE']);
  return { id: u.id, username: `mfa.user${n}` };
}
const codeAt = (secret: string, offset = 0, now = Date.now()) => totpForStep(base32Decode(secret), stepAt(now) + offset);
/** Enrol and confirm; returns the secret and recovery codes. The confirming code's step is spent. */
async function enrol(client: string, userId: string) {
  const draft = await beginEnrolment({ client, userId, changedBy: ACTOR });
  const { recoveryCodes } = await confirmEnrolment({ client, userId, code: codeAt(draft.secretBase32), changedBy: ACTOR });
  return { secret: draft.secretBase32, recoveryCodes };
}
const sessions = (client: string, userId: string) =>
  withTenant(client, async (tx) => Number((await tx.execute(sql`select count(*)::int c from user_session where user_id = ${userId}`))[0]!.c));
const account = (client: string, id: string) => withTenant(client, async (tx) => (await tx.select().from(appUser).where(eq(appUser.id, id)))[0]!);
const refusal = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as MfaError; } throw new Error('expected a refusal'); };
/** Start a sign-in and return its challenge id. */
async function challengeFor(client: string, username: string) {
  const out = await signIn({ client, username, password: PASSWORD });
  return out;
}
/** A code for a step later than any spent, presented at the matching moment. */
const nextCode = (secret: string, spent = 1) => ({ code: codeAt(secret, spent), nowMs: Date.now() + spent * 30_000 });

beforeAll(async () => {
  saved.ring = process.env.CAIRN_BANK_DATA_KEYRING_JSON;
  process.env.CAIRN_BANK_DATA_KEYRING_JSON = JSON.stringify({ activeKeyId: 'k1', keys: { k1: randomBytes(32).toString('base64url') } });
  a = (await createTenant('mfa-a')).client; b = (await createTenant('mfa-b')).client;
});
afterAll(async () => {
  if (saved.ring === undefined) delete process.env.CAIRN_BANK_DATA_KEYRING_JSON; else process.env.CAIRN_BANK_DATA_KEYRING_JSON = saved.ring;
  await destroyTenant(a); await destroyTenant(b);
});

describe('the algorithm', () => {
  const rfc = base32Decode(base32Encode(Buffer.from('12345678901234567890')));
  // RFC 6238 Appendix B: T=1111111111 is 14050471, i.e. 050471. The spec's 504071 transposes two digits.
  it('1 — the six RFC 6238 SHA-1 vectors', () => {
    for (const [t, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']] as const) {
      expect(totpForStep(rfc, Math.floor(t / 30))).toBe(code);
    }
  });
  it('2 — base32 round-trips, including lengths that are not a multiple of five', () => {
    for (let len = 0; len < 40; len += 1) {
      const bytes = randomBytes(len);
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
  });
  it('3 — a secret is 20 bytes, 32 unpadded uppercase base32 characters', () => {
    const s = generateSecret();
    expect(s.bytes).toHaveLength(20);
    expect(s.base32).toMatch(/^[A-Z2-7]{32}$/);
  });
  it('4 — current, previous and next step accepted; two steps away refused', () => {
    const secret = generateSecret().bytes; const now = 1_700_000_000_000; const step = stepAt(now);
    for (const d of [-1, 0, 1]) expect(acceptTotp(secret, totpForStep(secret, step + d), now, null)).toBe(step + d);
    expect(acceptTotp(secret, totpForStep(secret, step - 2), now, null)).toBeNull();
    expect(acceptTotp(secret, totpForStep(secret, step + 2), now, null)).toBeNull();
  });
  it('5 — replay: a step at or below the last used one is refused', () => {
    const secret = generateSecret().bytes; const now = 1_700_000_000_000; const step = stepAt(now);
    const code = totpForStep(secret, step);
    expect(acceptTotp(secret, code, now, null)).toBe(step);
    expect(acceptTotp(secret, code, now, step)).toBeNull();
  });
  it('6 — a wrong code of the right length is refused; non-digits are refused', () => {
    const secret = generateSecret().bytes; const now = 1_700_000_000_000;
    const right = totpForStep(secret, stepAt(now));
    const wrong = right === '000000' ? '000001' : '000000';
    expect(acceptTotp(secret, wrong, now, null)).toBeNull();
    expect(acceptTotp(secret, 'abcdef', now, null)).toBeNull();
  });
  it('the otpauth URI drops spaces from the issuer and percent-encodes both parts', () => {
    const uri = otpauthUri({ issuer: 'Vantage Foods', account: 'a b@x', secretBase32: 'ABC' });
    expect(uri).toBe('otpauth://totp/VantageFoods:a%20b%40x?secret=ABC&issuer=VantageFoods&algorithm=SHA1&digits=6&period=30');
  });
});

describe('enrolment', () => {
  it('7-8 — PENDING until confirmed; wrong code leaves it PENDING; ACTIVE with ten codes; begin over ACTIVE refuses', async () => {
    const u = await mkUser();
    const draft = await beginEnrolment({ client: a, userId: u.id, changedBy: ACTOR });
    expect(draft.secretBase32).toMatch(/^[A-Z2-7]{32}$/);
    expect(draft.qrDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(await mfaStatus({ client: a, userId: u.id })).toMatchObject({ enrolled: false, pending: true });
    const wrong = codeAt(draft.secretBase32) === '000000' ? '000001' : '000000';
    expect((await refusal(confirmEnrolment({ client: a, userId: u.id, code: wrong, changedBy: ACTOR }))).code).toBe('CODE_WRONG');
    expect((await mfaStatus({ client: a, userId: u.id })).pending).toBe(true);
    const done = await confirmEnrolment({ client: a, userId: u.id, code: codeAt(draft.secretBase32), changedBy: ACTOR });
    expect(done.recoveryCodes).toHaveLength(10);
    expect(await mfaStatus({ client: a, userId: u.id })).toMatchObject({ enrolled: true, remainingRecoveryCodes: 10 });
    expect((await refusal(beginEnrolment({ client: a, userId: u.id, changedBy: ACTOR }))).code).toBe('ALREADY_ENROLLED');
  });

  it('10 — the secret and the recovery codes are never stored in the clear', async () => {
    const u = await mkUser();
    const { secret, recoveryCodes } = await enrol(a, u.id);
    const [row] = await withTenant(a, (tx) => tx.select().from(userMfa).where(eq(userMfa.userId, u.id)));
    expect(row!.secretEncrypted).not.toContain(secret);
    const hashes = (await withTenant(a, (tx) => tx.select().from(userMfaRecoveryCode).where(eq(userMfaRecoveryCode.userId, u.id)))).map((r) => r.codeHash);
    for (const c of recoveryCodes) {
      expect(c).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
      expect(hashes.join('|')).not.toContain(c.replace('-', ''));
    }
    const dump = JSON.stringify(await withTenant(a, (tx) => tx.execute(sql`select * from change_document_item i join change_document d on d.id = i.change_document_id where d.object_key = ${u.id}`)));
    expect(dump).not.toContain(secret);
  });
});

describe('sign-in', () => {
  it('11-12 — an enrolled user gets a challenge and no session; the right code makes exactly one; the challenge is single-use', async () => {
    const u = await mkUser(); const { secret } = await enrol(a, u.id);
    const out = await challengeFor(a, u.username);
    expect(out.mfaChallengeId).toBeTruthy();
    expect(out.mfaEnrolmentRequired).toBeUndefined();
    expect(await sessions(a, u.id)).toBe(0);

    const { code, nowMs } = nextCode(secret);
    const verified = await verifyChallenge({ client: a, challengeId: out.mfaChallengeId!, code, nowMs });
    expect(verified.userId).toBe(u.id);
    await withTenant(a, (tx) => createSession(tx, { client: a, userId: verified.userId }));
    expect(await sessions(a, u.id)).toBe(1);
    expect((await refusal(verifyChallenge({ client: a, challengeId: out.mfaChallengeId!, code, nowMs }))).code).toBe('CHALLENGE_DEAD');
    expect(await sessions(a, u.id)).toBe(1);
  });

  it('5b — the same code at sign-in is refused twice (replay) but the challenge only counts the failure', async () => {
    const u = await mkUser(); const { secret } = await enrol(a, u.id);
    const { code, nowMs } = nextCode(secret);
    const one = await challengeFor(a, u.username);
    await verifyChallenge({ client: a, challengeId: one.mfaChallengeId!, code, nowMs });
    const two = await challengeFor(a, u.username);
    const e = await refusal(verifyChallenge({ client: a, challengeId: two.mfaChallengeId!, code, nowMs }));
    expect(e.code).toBe('CODE_WRONG'); expect(e.attemptsLeft).toBe(4);
  });

  it('9 — a recovery code works once, then is refused', async () => {
    const u = await mkUser(); const { recoveryCodes } = await enrol(a, u.id);
    const one = await challengeFor(a, u.username);
    await verifyChallenge({ client: a, challengeId: one.mfaChallengeId!, code: recoveryCodes[0]!.toUpperCase().replace('-', ' ') });
    expect((await mfaStatus({ client: a, userId: u.id })).remainingRecoveryCodes).toBe(9);
    const two = await challengeFor(a, u.username);
    expect((await refusal(verifyChallenge({ client: a, challengeId: two.mfaChallengeId!, code: recoveryCodes[0]! }))).code).toBe('CODE_WRONG');
  });

  it('13 — five wrong codes kill the challenge; the account is not locked and its counter is untouched', async () => {
    const u = await mkUser(); await enrol(a, u.id);
    const before = await account(a, u.id);
    const { mfaChallengeId } = await challengeFor(a, u.username);
    let last: MfaError | undefined;
    for (let i = 0; i < 5; i += 1) last = await refusal(verifyChallenge({ client: a, challengeId: mfaChallengeId!, code: '000000' }));
    expect(last!.code).toBe('CHALLENGE_DEAD');
    expect((await refusal(verifyChallenge({ client: a, challengeId: mfaChallengeId!, code: '000000' }))).code).toBe('CHALLENGE_DEAD');
    const after = await account(a, u.id);
    expect(after.isLocked).toBe(false);
    expect(after.failedLoginCount).toBe(before.failedLoginCount);
    expect((await challengeView({ client: a, challengeId: mfaChallengeId! })).live).toBe(false);
    await expect(signIn({ client: a, username: u.username, password: PASSWORD })).resolves.toBeTruthy(); // can sign in again
  });

  it('14 — an expired challenge is refused', async () => {
    const u = await mkUser(); const { secret } = await enrol(a, u.id);
    const { mfaChallengeId } = await challengeFor(a, u.username);
    await withTenant(a, (tx) => tx.update(mfaChallenge).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(mfaChallenge.id, mfaChallengeId!)));
    const { code, nowMs } = nextCode(secret);
    expect((await refusal(verifyChallenge({ client: a, challengeId: mfaChallengeId!, code, nowMs }))).code).toBe('CHALLENGE_DEAD');
  });

  it('15 — MFA_REQUIRED: an unenrolled user gets a challenge flagged for enrolment, no session until confirmed', async () => {
    const u = await mkUser();
    await setMfaRequired({ client: a, enabled: true, changedBy: ACTOR }, ['CFG.PLT.USER.MAINTAIN']);
    try {
      const out = await challengeFor(a, u.username);
      expect(out.mfaChallengeId).toBeTruthy(); expect(out.mfaEnrolmentRequired).toBe(true);
      expect(await sessions(a, u.id)).toBe(0);
      const view = await challengeView({ client: a, challengeId: out.mfaChallengeId! });
      expect(view.live).toBe(true);
      expect(view.enrolment!.secretBase32).toMatch(/^[A-Z2-7]{32}$/);
      // a reload shows the same secret
      expect((await challengeView({ client: a, challengeId: out.mfaChallengeId! })).enrolment!.secretBase32).toBe(view.enrolment!.secretBase32);
      const verified = await verifyChallenge({ client: a, challengeId: out.mfaChallengeId!, code: codeAt(view.enrolment!.secretBase32) });
      expect(verified.recoveryCodes).toHaveLength(10);
      expect((await mfaStatus({ client: a, userId: u.id })).enrolled).toBe(true);
    } finally {
      await setMfaRequired({ client: a, enabled: false, changedBy: ACTOR }, ['CFG.PLT.USER.MAINTAIN']);
    }
  });

  it('9b — the tenant flag merges: an unrelated flag survives', async () => {
    await withTenant(a, (tx) => tx.execute(sql`update client_settings set flags = coalesce(flags, '{}'::jsonb) || '{"OTHER":true}'::jsonb where client = ${a}`));
    await setMfaRequired({ client: a, enabled: true, changedBy: ACTOR }, ['CFG.PLT.USER.MAINTAIN']);
    const flags = await withTenant(a, async (tx) => ((await tx.execute(sql`select flags from client_settings where client = ${a}`))[0] as { flags: Record<string, unknown> }).flags);
    expect(flags).toMatchObject({ OTHER: true, MFA_REQUIRED: true });
    await setMfaRequired({ client: a, enabled: false, changedBy: ACTOR }, ['CFG.PLT.USER.MAINTAIN']);
    expect((await refusal(setMfaRequired({ client: a, enabled: true, changedBy: ACTOR }, []))).code).toBe('CAPABILITY_MISSING');
  });
});

describe('own account and administrator', () => {
  it('16 — disable needs the password and a current code; regenerate needs the password', async () => {
    const u = await mkUser(); const { secret, recoveryCodes } = await enrol(a, u.id);
    const { code, nowMs } = nextCode(secret);
    expect((await refusal(disableMfa({ client: a, userId: u.id, password: 'wrong-wrong-1', code, nowMs, changedBy: ACTOR }))).code).toBe('PASSWORD_WRONG');
    expect((await refusal(disableMfa({ client: a, userId: u.id, password: PASSWORD, code: '000000', nowMs, changedBy: ACTOR }))).code).toBe('CODE_WRONG');
    expect((await mfaStatus({ client: a, userId: u.id })).enrolled).toBe(true);

    expect((await refusal(regenerateRecoveryCodes({ client: a, userId: u.id, password: 'nope-nope-1', changedBy: ACTOR }))).code).toBe('PASSWORD_WRONG');
    const fresh = await regenerateRecoveryCodes({ client: a, userId: u.id, password: PASSWORD, changedBy: ACTOR });
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect(fresh.recoveryCodes).not.toContain(recoveryCodes[0]);

    await disableMfa({ client: a, userId: u.id, password: PASSWORD, code, nowMs, changedBy: ACTOR });
    expect((await mfaStatus({ client: a, userId: u.id }))).toMatchObject({ enrolled: false, pending: false, remainingRecoveryCodes: 0 });
  });

  it('17 — admin reset needs the capability and a reason; clears everything, revokes sessions, records a document with the reason', async () => {
    const u = await mkUser(); await enrol(a, u.id);
    await withTenant(a, (tx) => createSession(tx, { client: a, userId: u.id }));
    const input = { client: a, userId: u.id, changedBy: ACTOR, reason: 'Lost phone' };
    expect((await refusal(adminResetMfa(input, []))).code).toBe('CAPABILITY_MISSING');
    expect((await refusal(adminResetMfa({ ...input, reason: '  ' }, [MFA_ADMIN_CAPABILITY]))).code).toBe('REASON_REQUIRED');
    await adminResetMfa(input, [MFA_ADMIN_CAPABILITY]);
    expect(await mfaStatus({ client: a, userId: u.id })).toMatchObject({ enrolled: false, remainingRecoveryCodes: 0 });
    expect(await withTenant(a, async (tx) => Number((await tx.execute(sql`select count(*)::int c from user_session where user_id = ${u.id} and revoked_at is null`))[0]!.c))).toBe(0);
    expect((await account(a, u.id)).mustChangePassword).toBe(false);
    const doc = JSON.stringify(await withTenant(a, (tx) => tx.execute(sql`select d.reason, i.field_name from change_document d join change_document_item i on i.change_document_id = d.id where d.object_key = ${u.id} and i.field_name = 'mfaEnrolled'`)));
    expect(doc).toContain('Lost phone');
    expect((await refusal(adminResetMfa(input, [MFA_ADMIN_CAPABILITY]))).code).toBe('NOT_ENROLLED');
  });

  it('18 — tenant isolation: client B sees none of client A\'s rows or challenges', async () => {
    const u = await mkUser(); await enrol(a, u.id);
    const { mfaChallengeId } = await challengeFor(a, u.username);
    expect(await withTenant(b, (tx) => tx.select().from(userMfa))).toEqual([]);
    expect(await withTenant(b, (tx) => tx.select().from(mfaChallenge).where(eq(mfaChallenge.id, mfaChallengeId!)))).toEqual([]);
    expect((await challengeView({ client: b, challengeId: mfaChallengeId! })).live).toBe(false);
    expect((await mfaStatus({ client: b, userId: u.id })).enrolled).toBe(false);
  });
});
