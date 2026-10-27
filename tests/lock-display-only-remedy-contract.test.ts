/**
 * One recovery sentence, one condition, every screen that is told to display.
 *
 * Screens reach the display-only state by two routes: the client hook (`openChangeLockAction`) and a lock
 * opened while the page renders (`openChangeForSession`). Both must tell the operator the same thing, so the
 * wording lives in one helper and the tests below hold both routes to it. Three behaviours are checked, all of
 * them real: a state that has nothing to recover gets no advice; a blocked session gets the platform's
 * sentence and no invented promise of automation; and the recovery is not tied to one module's lock object.
 *
 * Only the session and the framework cache are mocked; every lock row is the platform's own.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import type { SessionContext } from '@/platform/auth/session';
import { displayOnlyMessage, openChangeForSession, releaseChangeLock } from '@/platform/lock/enqueue';
import { displayOnlyRemedy } from '@/ui/lock/remedy';
import { t } from '@/platform/i18n';
import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';

const request = vi.hoisted(() => ({ session: null as SessionContext | null }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/platform/auth/current', async (original) => {
  const actual = await original<typeof import('@/platform/auth/current')>();
  return {
    ...actual,
    requireSession: vi.fn(async () => {
      if (!request.session) throw new Error('AUTH_REDIRECT');
      return request.session;
    }),
  };
});

import { openChangeLockAction } from '@/app/platform/locks/actions';

let tenant: TestTenant;
const HOLDER = { user: 'remedy.one', session: 'remedy-contract-session-1' };
const BLOCKED = { user: 'remedy.two', session: 'remedy-contract-session-2' };

/** A lock object of another module, so the contract is not read as a settlement special case. */
const OBJECT = 'COST_CENTER';
const ARGUMENT = 'PP29-CC-1';
const HOOK_ARGUMENT = 'PP29-CC-2';

async function person(username: string, sessionId: string) {
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into app_user (id, client, username, full_name, password_hash, is_active, is_locked, created_by)
      values (${`u-${username}`}, ${tenant.client}, ${username}, ${username}, 'test-hash', true, false, 'TEST')
    `);
    await tx.execute(sql`
      insert into user_session (id, client, user_id, token_hash, issued_at, expires_at)
      values (${sessionId}, ${tenant.client}, ${`u-${username}`}, ${createHash('sha256').update(sessionId).digest('hex')}, now(), now() + interval '8 hours')
    `);
  });
}

function signedIn(who: { user: string; session: string }, capabilities: string[]) {
  request.session = {
    sessionId: who.session,
    user: {
      client: tenant.client, userId: `u-${who.user}`, username: who.user, fullName: who.user,
      email: null, mustChangePassword: false, capabilities,
    },
    expiresAt: new Date(Date.now() + 100000),
    renewed: false,
  } as SessionContext;
  return request.session;
}

const asSession = (who: { user: string; session: string }) => ({
  sessionId: who.session,
  user: { client: tenant.client, username: who.user },
});

beforeAll(async () => {
  tenant = await createTenant('lock-remedy');
  await person(HOLDER.user, HOLDER.session);
  await person(BLOCKED.user, BLOCKED.session);
});

afterAll(async () => {
  for (const who of [HOLDER, BLOCKED]) {
    for (const argument of [ARGUMENT, HOOK_ARGUMENT]) {
      await releaseChangeLock({ client: tenant.client, sessionId: who.session, lockObject: OBJECT, argument }).catch(() => false);
    }
  }
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('displayOnlyRemedy — the condition, not only the words', () => {
  it('says nothing where there is nothing to recover', () => {
    expect(displayOnlyRemedy(null)).toBeNull();
    expect(displayOnlyRemedy(undefined)).toBeNull();
    expect(displayOnlyRemedy({ mode: 'CHANGE', lockObject: OBJECT, argument: ARGUMENT })).toBeNull();
    // a display result without a holder is an error the platform already explained in its own message
    expect(displayOnlyRemedy({ mode: 'DISPLAY', lockObject: OBJECT, argument: ARGUMENT })).toBeNull();
  });

  it('is the catalogue sentence for a display-only opening, and promises no automation', () => {
    const remedy = displayOnlyRemedy({
      mode: 'DISPLAY',
      lockObject: OBJECT,
      argument: ARGUMENT,
      holder: { username: HOLDER.user, transactionCode: 'CFG.COST.COSTCENTER.DEFINE', acquiredAt: new Date().toISOString() },
    });
    expect(remedy).toBe(t('lock.displayOnlyRecovery'));
    expect(remedy).toMatch(/does not take the lock back by itself/);
    expect(remedy).toMatch(/Re-open the document/);
    expect(remedy).toMatch(/three minutes/);
    expect(remedy).toMatch(/lock monitor/);
    expect(remedy).not.toMatch(/will refresh|automatically|retries/);
  });
});

describe('a screen whose lock is opened while the page renders', () => {
  it('tells the blocked session the reason and the way back', async () => {
    const held = await openChangeForSession(asSession(HOLDER), { lockObject: OBJECT, argument: ARGUMENT, transactionCode: 'CFG.COST.COSTCENTER.DEFINE' });
    expect(held.mode).toBe('CHANGE');
    expect(displayOnlyRemedy(held)).toBeNull();          // the holder has nothing to recover

    const blocked = await openChangeForSession(asSession(BLOCKED), { lockObject: OBJECT, argument: ARGUMENT, transactionCode: 'CFG.COST.COSTCENTER.DEFINE' });
    expect(blocked.mode).toBe('DISPLAY');
    expect(displayOnlyMessage(blocked)).toContain(`${OBJECT} ${ARGUMENT} is being changed by ${HOLDER.user}`);
    expect(displayOnlyMessage(blocked)).toContain('This opening is display only.');
    expect(displayOnlyRemedy(blocked)).toBe(t('lock.displayOnlyRecovery'));

    await releaseChangeLock({ client: tenant.client, sessionId: HOLDER.session, lockObject: OBJECT, argument: ARGUMENT });
    const reopened = await openChangeForSession(asSession(BLOCKED), { lockObject: OBJECT, argument: ARGUMENT, transactionCode: 'CFG.COST.COSTCENTER.DEFINE' });
    expect(reopened.mode).toBe('CHANGE');                 // re-opening is the recovery, and it works
    expect(displayOnlyRemedy(reopened)).toBeNull();
  });
});

describe('a screen whose lock is opened by the client hook', () => {
  it('hands the component the same sentence the server-rendered screens compose', async () => {
    // its own object, so nothing the describe above left standing decides the outcome
    await openChangeForSession(asSession(HOLDER), { lockObject: OBJECT, argument: HOOK_ARGUMENT, transactionCode: 'CFG.COST.COSTCENTER.DEFINE' });
    signedIn(BLOCKED, ['CFG.COST.COSTCENTER.DEFINE']);
    const state = await openChangeLockAction(OBJECT, HOOK_ARGUMENT, 'CFG.COST.COSTCENTER.DEFINE');
    expect(state.mode).toBe('DISPLAY');
    const expected = await openChangeForSession(asSession(BLOCKED), { lockObject: OBJECT, argument: HOOK_ARGUMENT, transactionCode: 'CFG.COST.COSTCENTER.DEFINE' });
    expect(state.message).toBe(displayOnlyMessage(expected));
    expect(state.remedy).toBe(displayOnlyRemedy(expected));

    signedIn(HOLDER, ['CFG.COST.COSTCENTER.DEFINE']);
    const holder = await openChangeLockAction(OBJECT, HOOK_ARGUMENT, 'CFG.COST.COSTCENTER.DEFINE');
    expect(holder.mode).toBe('CHANGE');
    expect(holder.message).toBeNull();
    expect(holder.remedy).toBeNull();                     // no advice where nothing is wrong
  });
});
