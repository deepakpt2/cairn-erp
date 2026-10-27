/**
 * The recovery surface of a display-only opening — three contract lines the screens depend on.
 *
 * 1. A save that a change lock refuses comes back with the platform's own remedy, not only its reason.
 *    The classification is unchanged: the same `EnqueueError`, the same message, the same refusal.
 * 2. A display-only opening states what the operator can actually do, and states it truthfully: nothing
 *    retries by itself, so the guidance says "re-open", never "wait and it will refresh".
 * 3. The monitor's answer state is real, and the audited recovery — deleting the lock with a reason, which
 *    changes no document — keeps its authority gate, its reason gate and its audit entry.
 *
 * Only the session and the framework cache are mocked; every lock, row and audit entry is the platform's own.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import type { SessionContext } from '@/platform/auth/session';
import { changeHistory } from '@/platform/change';
import { openForChange, releaseChangeLock, listEnqueue } from '@/platform/lock/enqueue';
import { settlementConfigLock } from '@/modules/foundation/settlement-configuration-keys';
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

import {
  deleteEnqueueAction,
  openChangeLockAction,
} from '@/app/platform/locks/actions';
import { saveAssignmentAction } from '@/app/config/settlement-configuration/actions';

let tenant: TestTenant;
const HOLDER = { user: 'lock.one', session: 'lock-recovery-session-1' };
const WATCHER = { user: 'lock.two', session: 'lock-recovery-session-2' };
const ADMIN = { user: 'lock.admin', session: 'lock-recovery-session-3' };

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

/** The signed-in shape the actions read: capabilities decide everything the screen cannot. */
function signedIn(who: { user: string; session: string }, capabilities: string[]) {
  request.session = {
    sessionId: who.session,
    user: {
      client: tenant.client, userId: `u-${who.user}`, username: who.user, fullName: who.user,
      email: null, mustChangePassword: false, capabilities,
    },
    expiresAt: new Date(Date.now() + 100000),
    renewed: false,
  };
}
function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}
async function hold(lockObject: string, argument: string, who = HOLDER) {
  return openForChange({
    client: tenant.client,
    sessionId: who.session,
    username: who.user,
    lockObject,
    argument,
    transactionCode: 'LOCK.UX.TEST',
  });
}

beforeAll(async () => {
  tenant = await createTenant('lock-ux');
  await person(HOLDER.user, HOLDER.session);
  await person(WATCHER.user, WATCHER.session);
  await person(ADMIN.user, ADMIN.session);
});

afterAll(async () => {
  for (const who of [HOLDER, WATCHER, ADMIN]) {
    await releaseChangeLock({
      client: tenant.client,
      sessionId: who.session,
      lockObject: 'SETTLEMENT_ALLOCATION_STRUCTURE',
      argument: 'ASUX1',
    }).catch(() => undefined);
  }
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('the display-only notice carries a remedy the operator can act on', () => {
  it('answers the second opening with the recovery path, in the platform’s own words', async () => {
    const structureLock = settlementConfigLock('structure', 'ASUX1');
    signedIn(HOLDER, ['*']);
    const first = await openChangeLockAction(structureLock.lockObject, structureLock.argument, 'CFG.COST.SETTLEMENT.DEFINE');
    expect(first).toEqual({ mode: 'CHANGE', message: null, remedy: null });

    signedIn(WATCHER, ['*']);
    const second = await openChangeLockAction(structureLock.lockObject, structureLock.argument, 'CFG.COST.SETTLEMENT.DEFINE');
    expect(second.mode).toBe('DISPLAY');
    expect(second.message).toBe(`${structureLock.lockObject} ${structureLock.argument} is being changed by ${HOLDER.user} in CFG.COST.SETTLEMENT.DEFINE. This opening is display only.`);
    // The line is a translation, not a key left to rot in the catalogue…
    expect(second.remedy).toBe(t('lock.displayOnlyRecovery'));
    expect(t('lock.displayOnlyRecovery')).not.toBe('lock.displayOnlyRecovery');
    // …and it says what is true: this opening does not recover itself, the holder has to leave or go quiet,
    // and there is a named operator path. It must not promise a refresh.
    for (const promise of ['does not take the lock back by itself', 'Re-open the document', 'three minutes', 'lock monitor']) {
      expect(second.remedy, `recovery guidance missing ${promise}`).toContain(promise);
    }
    expect(second.remedy).not.toMatch(/will refresh|automatically/i);

    await releaseChangeLock({
      client: tenant.client, sessionId: HOLDER.session, lockObject: structureLock.lockObject, argument: structureLock.argument,
    });
  });

  it('invents nothing where the platform has no guidance, and passes through what it has', async () => {
    // An object name the platform rejects: refused, still display-only, and no invented second line.
    signedIn(HOLDER, ['*']);
    const illegal = await openChangeLockAction('plant order', '1000', 'MX01');
    expect(illegal).toEqual({ mode: 'DISPLAY', message: 'The lock object is not a named object.', remedy: null });

    // A session the platform can name a remedy for: its own words reach the caller unchanged.
    request.session = {
      user: {
        client: tenant.client, userId: 'u-lock.one', username: 'lock.one', fullName: 'lock.one',
        email: null, mustChangePassword: false, capabilities: ['*'],
      },
      expiresAt: new Date(Date.now() + 100000),
      renewed: false,
    };
    const anonymous = await openChangeLockAction('PLANT', '1000', 'MX01');
    expect(anonymous).toEqual({ mode: 'DISPLAY', message: 'The session is missing.', remedy: 'Sign in again.' });
  });
});

describe('a settlement save refused by the lock keeps its remedy', () => {
  it('refuses with the reason the platform found, and the remedy that goes with it', async () => {
    const structureLock = settlementConfigLock('structure', 'ASUX1');
    await hold(structureLock.lockObject, structureLock.argument);
    signedIn(WATCHER, ['*']);

    const held = await saveAssignmentAction({ ok: true }, form({
      structureCode: 'ASUX1', sourceAccount: '410000', receiverCategory: 'COST_CENTER', expectedVersion: '0',
    }));
    expect(held.ok).toBe(false);
    expect(held.message).toBe(`${structureLock.lockObject} ${structureLock.argument} is being changed by ${HOLDER.user}. This session cannot change it.`);
    expect(held.remedy).toBe('Open it again when that session has left. Display does not take the lock.');

    // Nothing was written by the refused save: the assignment table of this tenant is still empty.
    const rows = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as n from allocation_structure_assignment where client = ${tenant.client}
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0);

    // And the other case — no lock standing at all — keeps its own remedy, not this one.
    await releaseChangeLock({
      client: tenant.client, sessionId: HOLDER.session, lockObject: structureLock.lockObject, argument: structureLock.argument,
    });
    const neverHeld = await saveAssignmentAction({ ok: true }, form({
      structureCode: 'ASUX1', sourceAccount: '410000', receiverCategory: 'COST_CENTER', expectedVersion: '0',
    }));
    expect(neverHeld.ok).toBe(false);
    expect(neverHeld.message).toBe(`${structureLock.lockObject} ${structureLock.argument} is not open for change in this session.`);
    expect(neverHeld.remedy).toBe('Open the object in change. A save does not take a lock the screen did not hold.');
  });
});

describe('the monitor distinguishes an answering holder from one that has gone quiet', () => {
  it('lists a live holder as answered, and drops a silent one rather than marking it', async () => {
    const lock = settlementConfigLock('profile', 'SPUX1');
    await hold(lock.lockObject, lock.argument);

    const standing = await listEnqueue(tenant.client);
    const row = standing.find((entry) => entry.lockObject === lock.lockObject && entry.argument === lock.argument);
    expect(row, 'the holder is not listed at all').toBeDefined();
    expect(row!.stale).toBe(false);

    // The same predicate that would set `stale` deletes the row first, inside the same call: a lock nobody
    // answers is therefore *absent* from this list, never flagged in it. The monitor's own hint says so, and
    // an operator reading the answer column sees the silence grow toward that threshold.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update enqueue_entry set heartbeat_at = now() - interval '10 minutes'
         where client = ${tenant.client} and lock_object = ${lock.lockObject} and argument = ${lock.argument}
      `);
    });
    const after = await listEnqueue(tenant.client);
    expect(after.find((entry) => entry.lockObject === lock.lockObject && entry.argument === lock.argument)).toBeUndefined();
  });
});

describe('the audited recovery still works, and still refuses to be casual about it', () => {
  it('keeps its authority gate, its reason gate, its audit entry, and its hands off the document', async () => {
    const lock = settlementConfigLock('profile', 'SPUX2');
    await hold(lock.lockObject, lock.argument, ADMIN);
    const key = `${lock.lockObject}/${lock.argument}`;

    signedIn({ user: ADMIN.user, session: ADMIN.session }, ['PLT.LOCK.DISPLAY']);
    const denied = await deleteEnqueueAction({ ok: true }, form({ lockObject: lock.lockObject, argument: lock.argument, reason: 'Testing the gate.' }));
    expect(denied).toEqual({ ok: false, message: 'You do not hold the authority to delete a lock.' });
    expect((await listEnqueue(tenant.client)).find((row) => row.argument === lock.argument), 'a denied delete still removed the lock').toBeDefined();

    signedIn(ADMIN, ['PLT.LOCK.DISPLAY', 'PLT.LOCK.DELETE']);
    const tooShort = await deleteEnqueueAction({ ok: true }, form({ lockObject: lock.lockObject, argument: lock.argument, reason: 'x' }));
    expect(tooShort.ok).toBe(false);
    expect(tooShort.message).toBe('A reason is required to delete a lock.');
    expect(tooShort.remedy).toBe('State why the lock is being removed.');

    const deleted = await deleteEnqueueAction({ ok: true }, form({
      lockObject: lock.lockObject, argument: lock.argument, reason: 'The holder left the screen open.',
    }));
    expect(deleted.ok).toBe(true);
    expect(deleted.message).toBe('The lock is gone. The document was not changed.');
    expect((await listEnqueue(tenant.client)).find((row) => row.argument === lock.argument)).toBeUndefined();
    const history = await withTenant(tenant.client, (tx) => changeHistory(tx, tenant.client, 'enqueue_entry', key));
    expect(history.filter((row) => row.changeType === 'DELETE')).toHaveLength(1);
    expect(history[0]).toMatchObject({ changedBy: ADMIN.user, transactionCode: 'SM12' });

    // A lock that is not standing is refused, with no remedy invented for it.
    const gone = await deleteEnqueueAction({ ok: true }, form({
      lockObject: lock.lockObject, argument: lock.argument, reason: 'Trying again after it was cleared.',
    }));
    expect(gone.ok).toBe(false);
    expect(gone.message).toBe(`${lock.lockObject} ${lock.argument} is not locked.`);
    expect(gone.remedy ?? null).toBeNull();

    // And the document the lock was standing on is untouched by all of it.
    const profiles = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as n from settlement_profile where client = ${tenant.client}
    `)) as unknown as Array<{ n: number }>;
    expect(profiles[0]!.n).toBe(0);
  });
});
