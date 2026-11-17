/**
 * MAIL-02 — password reset delivery and the self-service switch.
 * The transport is mocked; everything else runs against the real erp_test database.
 */
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/platform/mail/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/platform/mail/transport')>();
  return { ...actual, deliverMail: vi.fn(), probeConnection: vi.fn() };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const sessionRef: { current: unknown } = { current: null };
vi.mock('../src/platform/auth/current', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/platform/auth/current')>();
  return {
    ...actual,
    requireSession: vi.fn(async () => sessionRef.current),
    can: (s: { user: { capabilities: string[] } }, code: string) => s.user.capabilities.includes(code),
  };
});

import { withTenant } from '../src/platform/db/client';
import { mailMessage } from '../src/platform/tables/system';
import { passwordResetToken, appUser } from '../src/platform/tables/security';
import { decryptBankData } from '../src/platform/security/bank-data-encryption';
import { loadBankDataKeyring } from '../src/platform/security/bank-data-keyring';
import { saveMailConfig } from '../src/platform/mail/service';
import {
  completePasswordReset,
  createUser,
  initiatePasswordReset,
  isSelfServiceResetEnabled,
  requestPasswordReset,
  setSelfServiceReset,
  UserAdminError,
} from '../src/modules/platform/user-admin';
import { signIn } from '../src/platform/auth/session';
import { initiatePasswordResetAction } from '../src/app/platform/users/actions';
import { createTenant, destroyTenant } from './helpers';

const RESET_CAP = ['CFG.PLT.USER.PASSWORD_RESET'];
const MAINTAIN = ['CFG.PLT.USER.MAINTAIN'];
const ACTOR = 'RESET-TEST';
const PASSWORD = 'Original-Passw0rd!';
const NEW_PASSWORD = 'Brand-New-Passw0rd!';

let client = '';
const saved: Record<string, string | undefined> = {};
let n = 0;

async function mkUser(email: string | null) {
  n += 1;
  const username = `reset.user${n}`;
  const u = await createUser({ client, username, fullName: 'Reset User', email, password: PASSWORD, changedBy: ACTOR }, ['CFG.PLT.USER.CREATE']);
  return { id: u.id, username };
}
const enableMail = (isEnabled = true) =>
  saveMailConfig(
    { client, changedBy: ACTOR, host: 'smtp.example', port: 587, encryption: 'STARTTLS', username: '', password: '', clearPassword: false, senderAddress: 'erp@example.com', senderName: 'ERP', isEnabled },
    ['CFG.PLT.MAIL.DEFINE'],
  );
const tokens = (userId: string) => withTenant(client, (tx) => tx.select().from(passwordResetToken).where(eq(passwordResetToken.userId, userId)));
const mails = () => withTenant(client, (tx) => tx.select().from(mailMessage).where(eq(mailMessage.client, client)));
const account = (userId: string) => withTenant(client, async (tx) => (await tx.select().from(appUser).where(eq(appUser.id, userId)))[0]);
const liveSessions = (userId: string) =>
  withTenant(client, async (tx) => Number((await tx.execute(sql`select count(*)::int c from user_session where user_id = ${userId} and revoked_at is null`))[0].c));
const setFlag = (enabled: boolean) => setSelfServiceReset({ client, enabled, changedBy: ACTOR }, MAINTAIN);
const adminReset = (userId: string) => initiatePasswordReset({ client, userId, changedBy: ACTOR }, RESET_CAP);
const selfReset = (username: string) => requestPasswordReset({ client, username });

async function secretOf(row: typeof mailMessage.$inferSelect): Promise<string> {
  return decryptBankData(row.secretEncrypted!, { client, partnerNumber: 'MAIL', bankRecordId: row.id as never, field: 'secret' }, loadBankDataKeyring());
}

beforeAll(async () => {
  saved.ring = process.env.CAIRN_BANK_DATA_KEYRING_JSON;
  saved.base = process.env.APP_BASE_URL;
  process.env.CAIRN_BANK_DATA_KEYRING_JSON = JSON.stringify({ activeKeyId: 'k1', keys: { k1: randomBytes(32).toString('base64url') } });
  process.env.APP_BASE_URL = 'https://erp.example';
  client = (await createTenant('reset-a')).client;
});
afterAll(async () => {
  for (const [k, v] of [['CAIRN_BANK_DATA_KEYRING_JSON', saved.ring], ['APP_BASE_URL', saved.base]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await destroyTenant(client);
});
beforeEach(async () => {
  await withTenant(client, async (tx) => {
    await tx.update(mailMessage).set({ status: 'DEAD' }).where(eq(mailMessage.client, client));
    await tx.execute(sql`delete from mail_server_config where client = ${client}`);
  });
  await setFlag(false);
});

describe('self-service request', () => {
  it('1 — flag absent: no token, no mail, accepted', async () => {
    await withTenant(client, (tx) => tx.execute(sql`update client_settings set flags = '{}' where client = ${client}`));
    await enableMail();
    const u = await mkUser('a@example.com');
    const before = (await mails()).length;
    expect(await selfReset(u.username)).toEqual({ accepted: true });
    expect(await tokens(u.id)).toHaveLength(0);
    expect((await mails()).length).toBe(before);
  });

  it('2 — flag on: one token and exactly one QUEUED mail to the user email', async () => {
    await enableMail(); await setFlag(true);
    const u = await mkUser('on@example.com');
    const before = (await mails()).length;
    expect(await selfReset(u.username)).toEqual({ accepted: true });
    expect(await tokens(u.id)).toHaveLength(1);
    const added = (await mails()).filter((m) => m.toAddress === 'on@example.com');
    expect(added).toHaveLength(1);
    expect(added[0].status).toBe('QUEUED');
    expect((await mails()).length).toBe(before + 1);
  });

  it('3 — null email: no token, no mail, accepted', async () => {
    await enableMail(); await setFlag(true);
    const u = await mkUser(null);
    const before = (await mails()).length;
    expect(await selfReset(u.username)).toEqual({ accepted: true });
    expect(await tokens(u.id)).toHaveLength(0);
    expect((await mails()).length).toBe(before);
  });

  it('4 — unknown username: same shape, nothing recorded; mail disabled also silent', async () => {
    await enableMail(); await setFlag(true);
    const before = (await mails()).length;
    expect(await selfReset('nobody.here')).toEqual({ accepted: true });
    expect((await mails()).length).toBe(before);
    await enableMail(false);
    const u = await mkUser('x@example.com');
    expect(await selfReset(u.username)).toEqual({ accepted: true });
    expect(await tokens(u.id)).toHaveLength(0);
  });

  it('5 — rate limit: the 4th request mints nothing', async () => {
    await enableMail(); await setFlag(true);
    const u = await mkUser('rate@example.com');
    for (let i = 0; i < 4; i++) await selfReset(u.username);
    expect(await tokens(u.id)).toHaveLength(3);
  });
});

describe('administrator reset', () => {
  it('6 — one mail, body holds {link} and no token, secret encrypted', async () => {
    await enableMail();
    const u = await mkUser('admin@example.com');
    const out = await adminReset(u.id);
    const rows = (await mails()).filter((m) => m.toAddress === 'admin@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0].bodyText).toContain('{link}');
    expect(rows[0].bodyText).not.toContain(out.token);
    expect(rows[0].secretEncrypted).not.toBeNull();
    expect(out.maskedEmail).toBe('a•••@e•••.com');
  });

  it('7 — no email: USER_EMAIL_MISSING, account untouched', async () => {
    await enableMail();
    const u = await mkUser(null);
    const err = await adminReset(u.id).catch((e) => e);
    expect(err).toBeInstanceOf(UserAdminError);
    expect(err.message).toMatch(/no usable email/);
    expect(err.remedy).toMatch(/maintain this user's email address/i);
    expect((await account(u.id)).mustChangePassword).toBe(false);
    expect(await tokens(u.id)).toHaveLength(0);
  });

  it('8 — mail disabled: refused, account untouched, no token row survives', async () => {
    const u = await mkUser('off@example.com');
    await signIn({ client, username: u.username, password: PASSWORD }).catch(() => undefined);
    const err = await adminReset(u.id).catch((e) => e);
    expect(err).toBeInstanceOf(UserAdminError);
    expect(err.message).toMatch(/Mail is not configured/);
    expect(err.remedy).toMatch(/\/platform\/mail/);
    expect((await account(u.id)).mustChangePassword).toBe(false);
    expect(await tokens(u.id)).toHaveLength(0);
  });

  it('9 — end to end: decrypt link, complete, sign in; second use is refused', async () => {
    await enableMail();
    const u = await mkUser('e2e@example.com');
    await adminReset(u.id);
    const row = (await mails()).find((m) => m.toAddress === 'e2e@example.com')!;
    const link = await secretOf(row);
    const token = new URL(link).searchParams.get('token')!;
    expect(link.startsWith('https://erp.example/reset-password?token=')).toBe(true);
    await completePasswordReset({ client, token, password: NEW_PASSWORD });
    await expect(signIn({ client, username: u.username, password: NEW_PASSWORD })).resolves.toBeTruthy();
    const again = await completePasswordReset({ client, token, password: NEW_PASSWORD + 'x' }).catch((e) => e);
    // The service deliberately answers a used token like an unknown one (no token oracle), so TOKEN_USED
    // is only reachable by a race; the spec's TOKEN_USED is reported, not changed.
    expect(again).toBeInstanceOf(UserAdminError);
    expect(again.message).toMatch(/not known/);
  });

  it('10 — sessions revoked and must_change_password set', async () => {
    await enableMail();
    const u = await mkUser('sess@example.com');
    await withTenant(client, (tx) => tx.execute(sql`
      insert into user_session (id, client, user_id, token_hash, issued_at, expires_at)
      values (gen_random_uuid(), ${client}, ${u.id}, ${'h' + u.id}, now(), now() + interval '1 hour')`));
    expect(await liveSessions(u.id)).toBe(1);
    await adminReset(u.id);
    expect(await liveSessions(u.id)).toBe(0);
    expect((await account(u.id)).mustChangePassword).toBe(true);
  });
});

describe('switch', () => {
  it('11 — needs USER.MAINTAIN; preserves unrelated flags; default off', async () => {
    await expect(setSelfServiceReset({ client, enabled: true, changedBy: ACTOR }, [])).rejects.toBeInstanceOf(UserAdminError);
    await withTenant(client, (tx) => tx.execute(sql`update client_settings set flags = '{"OTHER": true}' where client = ${client}`));
    expect(await withTenant(client, (tx) => isSelfServiceResetEnabled(tx, client))).toBe(false);
    await setFlag(true);
    const flags = await withTenant(client, async (tx) => (await tx.execute(sql`select flags from client_settings where client = ${client}`))[0].flags as Record<string, boolean>);
    expect(flags).toEqual({ OTHER: true, PASSWORD_SELF_SERVICE: true });
    const changes = await withTenant(client, async (tx) => tx.execute(sql`select 1 from change_document where client = ${client} and object_class = 'client_settings'`)).catch(() => []);
    expect(changes.length).toBeGreaterThan(0);
  });
});

describe('server action', () => {
  it('12 — success message carries a masked address, never the token', async () => {
    await enableMail();
    const u = await mkUser('masked@example.com');
    sessionRef.current = { user: { client, username: ACTOR, capabilities: RESET_CAP } };
    const fd = new FormData();
    fd.set('userId', u.id);
    const state = await initiatePasswordResetAction({ ok: false }, fd);
    expect(state.ok).toBe(true);
    expect(state.message).toContain('m•••@e•••.com');
    expect(state.message).not.toContain('masked@example.com');
    const row = (await mails()).find((m) => m.toAddress === 'masked@example.com')!;
    const token = new URL(await secretOf(row)).searchParams.get('token')!;
    expect(JSON.stringify(state)).not.toContain(token);
  });
});
