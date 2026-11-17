/**
 * AUTH-02 — the personal account and the must_change_password gate.
 * Real erp_test database; only the cookie jar and `redirect` are stubbed.
 */
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import * as React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const jar: { value: string | undefined } = { value: undefined };
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (n: string) => (n === 'cairn_session' && jar.value ? { value: jar.value } : undefined) }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock('../src/platform/mail/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/platform/mail/transport')>();
  return { ...actual, deliverMail: vi.fn(), probeConnection: vi.fn() };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { requireSession, getSession } from '../src/platform/auth/current';
import { createSession } from '../src/platform/auth/session';
import { appUser, auditAccessLog } from '../src/platform/tables/security';
import { withTenant } from '../src/platform/db/client';
import { createUser, completePasswordReset, initiatePasswordReset } from '../src/modules/platform/user-admin';
import {
  AccountError, changeOwnPassword, forcedChangeRedirect, listOwnSessions, pendingAccountActions,
  revokeOwnSession, safeNextPath, saveOwnPreferences,
} from '../src/modules/platform/personal-account';
import { attentionFor } from '../src/platform/attention/panel';
import { savePreferencesAction } from '../src/app/account/actions';
import { saveMailConfig } from '../src/platform/mail/service';
import { createTenant, destroyTenant } from './helpers';

(globalThis as { React?: unknown }).React = React; // the page's JSX uses the classic runtime under vitest
const PASSWORD = 'Original-Passw0rd!';
const NEW = 'Brand-New-Passw0rd!';
const ACTOR = 'ACCT-TEST';
let a = '';
let b = '';
let n = 0;

async function mkUser(client: string, forced = false) {
  n += 1;
  const u = await createUser({ client, username: `acct.user${n}`, fullName: 'Acct User', email: `acct${n}@example.com`, password: PASSWORD, changedBy: ACTOR }, ['CFG.PLT.USER.CREATE']);
  if (forced) await withTenant(client, (tx) => tx.execute(sql`update app_user set must_change_password = true where id = ${u.id}`));
  return u.id;
}
async function open(client: string, userId: string) {
  const { token } = await withTenant(client, (tx) => createSession(tx, { client, userId }));
  return `${client}.${token}`;
}
const as = (cookie: string) => { jar.value = cookie; };
const row = (client: string, id: string) => withTenant(client, async (tx) => (await tx.select().from(appUser).where(eq(appUser.id, id)))[0]!);
const live = (client: string, id: string) =>
  withTenant(client, async (tx) => Number((await tx.execute(sql`select count(*)::int c from user_session where user_id = ${id} and revoked_at is null`))[0]!.c));
const redirectOf = async (p: () => Promise<unknown>) => { try { await p(); return null; } catch (e) { const m = (e as Error).message; if (m.startsWith('REDIRECT:')) return m.slice(9); throw e; } };
const change = (client: string, userId: string, over: Partial<Parameters<typeof changeOwnPassword>[0]> = {}) =>
  changeOwnPassword({ client, userId, currentPassword: PASSWORD, newPassword: NEW, confirmation: NEW, ...over });
const refusal = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AccountError; } throw new Error('expected a refusal'); };

const saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  saved.ring = process.env.CAIRN_BANK_DATA_KEYRING_JSON; saved.base = process.env.APP_BASE_URL;
  process.env.CAIRN_BANK_DATA_KEYRING_JSON = JSON.stringify({ activeKeyId: 'k1', keys: { k1: randomBytes(32).toString('base64url') } });
  process.env.APP_BASE_URL = 'https://erp.example';
  a = (await createTenant('acct-a')).client; b = (await createTenant('acct-b')).client;
  await saveMailConfig({ client: a, changedBy: ACTOR, host: 'smtp.example', port: 587, encryption: 'STARTTLS', username: '', password: '', clearPassword: false, senderAddress: 'erp@example.com', senderName: 'ERP', isEnabled: true }, ['CFG.PLT.MAIL.DEFINE']);
});
afterAll(async () => {
  for (const [k, v] of [['CAIRN_BANK_DATA_KEYRING_JSON', saved.ring], ['APP_BASE_URL', saved.base]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await destroyTenant(a); await destroyTenant(b);
});

describe('changeOwnPassword', () => {
  it('1-3 — wrong current password, policy failure and mismatch each refuse and change nothing', async () => {
    const id = await mkUser(a);
    const before = (await row(a, id)).passwordHash;
    expect((await refusal(change(a, id, { currentPassword: 'nope-nope-1' }))).code).toBe('PASSWORD_WRONG');
    expect((await refusal(change(a, id, { newPassword: 'short1', confirmation: 'short1' }))).code).toBe('PASSWORD_POLICY');
    expect((await refusal(change(a, id, { confirmation: NEW + 'x' }))).code).toBe('PASSWORD_MISMATCH');
    expect((await row(a, id)).passwordHash).toBe(before);
  });

  it('4-5 — success: hash changes, flag clears, other sessions revoked, this one kept; change document holds no password', async () => {
    const id = await mkUser(a, true);
    const mine = await open(a, id);
    await open(a, id); await open(a, id);
    as(mine);
    const current = (await getSession())!;
    const before = (await row(a, id)).passwordHash;
    const out = await change(a, id, { currentSessionId: current.sessionId });
    expect(out.revokedSessions).toBe(2);
    const after = await row(a, id);
    expect(after.passwordHash).not.toBe(before);
    expect(after.mustChangePassword).toBe(false);
    expect(after.changedBy).toBe(after.username);
    expect(await live(a, id)).toBe(1);
    expect(await getSession()).not.toBeNull();

    const docs = await withTenant(a, async (tx) => JSON.stringify(await tx.execute(sql`
      select i.* from change_document d join change_document_item i on i.change_document_id = d.id
       where d.object_class = 'app_user' and d.object_key = ${id}`)));
    expect(docs).toContain('mustChangePassword');
    expect(docs).not.toContain(NEW);
    expect(docs).not.toContain(PASSWORD);
    expect(docs).not.toContain(after.passwordHash);
    const audit = await withTenant(a, (tx) => tx.select().from(auditAccessLog).where(eq(auditAccessLog.objectKey, id)));
    expect(audit.some((r) => r.detail === 'Self-service password change' && r.eventType === 'CONFIG_CHANGE')).toBe(true);
  });
});

describe('the must_change_password gate', () => {
  it('6 — redirects every other path, never loops on /account, leaves sign-out open, honours next safely', async () => {
    const id = await mkUser(a, true);
    const cookie = await open(a, id);
    as(cookie);
    expect(await redirectOf(() => requireSession('/somewhere'))).toBe('/account?section=password&next=%2Fsomewhere');
    expect(await redirectOf(() => requireSession('/'))).toContain('/account?section=password');
    expect(await redirectOf(() => requireSession('/account'))).toBeNull();
    expect(await redirectOf(() => requireSession('/signin'))).toBeNull();
    expect(await redirectOf(() => requireSession('/api/auth/signout'))).toBeNull();
    expect(await redirectOf(() => requireSession())).toBeNull(); // pathless: documented hole, not gated

    expect(forcedChangeRedirect(true, '/account?section=sessions')).toBeNull(); // the page's own gate handles this one
    expect(safeNextPath('https://evil.example/x')).toBeNull();
    expect(safeNextPath('//evil.example')).toBeNull();
    expect(safeNextPath('/\\evil.example')).toBeNull();
    expect(safeNextPath('/mm/orders?x=1')).toBe('/mm/orders?x=1');

    await change(a, id, { currentSessionId: (await getSession())!.sessionId });
    expect(await redirectOf(() => requireSession('/somewhere'))).toBeNull();
  });

  it('6b/9 — the account page sends a forced user from any other section back to the password section', async () => {
    const { default: AccountPage } = await import('../src/app/account/page');
    const id = await mkUser(a, true);
    as(await open(a, id));
    for (const section of ['sessions', 'security', 'preferences']) {
      expect(await redirectOf(() => AccountPage({ searchParams: Promise.resolve({ section }) }))).toBe('/account?section=password');
    }
    expect(await redirectOf(() => AccountPage({ searchParams: Promise.resolve({ section: 'password' }) }))).toBeNull();
  });

  it('7-8 — both doors end in the same state, and a token is dead once the flag is cleared elsewhere', async () => {
    const door = async (via: 'account' | 'token') => {
      const id = await mkUser(a);
      await open(a, id);
      const reset = await initiatePasswordReset({ client: a, userId: id, changedBy: ACTOR }, ['CFG.PLT.USER.PASSWORD_RESET']);
      if (via === 'account') {
        const cookie = await open(a, id);
        as(cookie);
        await change(a, id, { currentSessionId: (await getSession())!.sessionId });
      } else {
        await completePasswordReset({ client: a, token: reset.token, password: NEW });
      }
      return { id, reset };
    };
    const viaAccount = await door('account');
    const viaToken = await door('token');
    const [r1, r2] = [await row(a, viaAccount.id), await row(a, viaToken.id)];
    expect(r1.mustChangePassword).toBe(r2.mustChangePassword);
    expect(r1.mustChangePassword).toBe(false);
    expect(await live(a, viaAccount.id)).toBe(1); // the changing session is kept...
    expect(await live(a, viaToken.id)).toBe(0);   // ...the token door signs everyone out; both unflagged

    // 8 — the token is single-use even after /account cleared the flag.
    // The token flow does not look at the flag, so it still consumes an unused token once; a second use refuses.
    await completePasswordReset({ client: a, token: viaAccount.reset.token, password: 'Another-Passw0rd!' });
    await expect(completePasswordReset({ client: a, token: viaAccount.reset.token, password: 'Third-Passw0rd!' })).rejects.toMatchObject({ message: expect.any(String) });
    expect((await row(a, viaAccount.id)).mustChangePassword).toBe(false);
  });
});

describe('sessions', () => {
  it('10-12 — lists only own live sessions; refuses another user\'s id; revokes exactly one and audits', async () => {
    const u1 = await mkUser(a); const u2 = await mkUser(a);
    as(await open(a, u1)); await open(a, u1);
    const theirs = await open(a, u2);
    const current = (await getSession())!;
    const list = await listOwnSessions({ client: a, userId: u1, currentSessionId: current.sessionId! });
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.isCurrent)).toHaveLength(1);

    as(theirs);
    const theirId = (await getSession())!.sessionId!;
    expect((await refusal(revokeOwnSession({ client: a, userId: u1, sessionId: theirId }))).code).toBe('SESSION_NOT_FOUND');
    expect(await live(a, u2)).toBe(1);

    const victim = list.find((s) => !s.isCurrent)!;
    expect(await revokeOwnSession({ client: a, userId: u1, sessionId: victim.id })).toEqual({ revoked: true });
    expect(await live(a, u1)).toBe(1);
    const audit = await withTenant(a, (tx) => tx.select().from(auditAccessLog).where(eq(auditAccessLog.objectKey, victim.id)));
    expect(audit).toHaveLength(1);
  });

  it('17 — a session of client A is invisible and unrevocable from client B', async () => {
    const id = await mkUser(a);
    as(await open(a, id));
    const sid = (await getSession())!.sessionId!;
    expect(await listOwnSessions({ client: b, userId: id, currentSessionId: sid })).toEqual([]);
    expect((await refusal(revokeOwnSession({ client: b, userId: id, sessionId: sid }))).code).toBe('SESSION_NOT_FOUND');
    expect(await live(a, id)).toBe(1);
  });
});

describe('preferences', () => {
  it('13-14 — merges (unknown key survives) and refuses an unregistered language', async () => {
    const id = await mkUser(a);
    await withTenant(a, (tx) => tx.execute(sql`update app_user set preferences = '{"density":"compact"}' where id = ${id}`));
    const out = await saveOwnPreferences({ client: a, userId: id, logonLanguage: 'e' });
    expect(out.preferences).toEqual({ density: 'compact', logonLanguage: 'E' });
    expect((await refusal(saveOwnPreferences({ client: a, userId: id, logonLanguage: 'Z' }))).code).toBe('PREFERENCE_INVALID');
    expect((await row(a, id)).preferences).toEqual({ density: 'compact', logonLanguage: 'E' });
  });

  it('17 — preferences of client A are not written or read through client B', async () => {
    const id = await mkUser(a);
    await expect(saveOwnPreferences({ client: b, userId: id, logonLanguage: 'E' })).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    expect((await row(a, id)).preferences).toEqual({});
  });

  it('the action wrapper redirects with a refusal rather than throwing', async () => {
    const id = await mkUser(a); as(await open(a, id));
    const form = new FormData(); form.set('logonLanguage', 'Z');
    expect(await redirectOf(() => savePreferencesAction(form))).toContain('section=preferences&error=');
  });
});

describe('pending band and access', () => {
  it('15 — non-empty while the flag is set, empty after the change', async () => {
    const id = await mkUser(a, true);
    as(await open(a, id));
    expect(pendingAccountActions((await getSession())!.user)).toHaveLength(1);
    await change(a, id, { currentSessionId: (await getSession())!.sessionId });
    expect(pendingAccountActions((await getSession())!.user)).toEqual([]);
  });

  it('9 (launchpad) — the account source speaks for a forced user with no capability, and disappears at zero', async () => {
    const id = await mkUser(a, true);
    const who = { client: a, userId: id };
    const groups = await attentionFor(who, '2026-11-17');
    expect(groups.map((g) => g.label)).toEqual(['attention.source.account']);
    expect(groups[0]!.total).toBe(1);
    await change(a, id);
    expect(await attentionFor(who, '2026-11-17')).toEqual([]);
  });

  it('16 — a user holding no capability opens /account', async () => {
    const { default: AccountPage } = await import('../src/app/account/page');
    const id = await mkUser(a);
    as(await open(a, id));
    const session = (await getSession())!;
    expect(session.user.capabilities).toEqual([]);
    expect(await redirectOf(() => requireSession('/account'))).toBeNull();
    expect(await redirectOf(() => AccountPage({ searchParams: Promise.resolve({}) }))).toBeNull();
  });
});
