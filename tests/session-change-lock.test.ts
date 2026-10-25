/**
 * From a cookie to a change lock — CAIRN.md §23 (sessions) and §24 (dialog enqueue).
 *
 * `tests/dialog-enqueue.test.ts` proves the lock rules with session ids written by
 * hand. This file proves the link the screens actually depend on: a session
 * resolved from a real cookie has to arrive at `openChangeForSession` and
 * `assertChangeForSession` carrying the same `user_session.id` the enqueue row
 * stores as its owner. Nothing here is a source-text assertion — each case signs
 * in, issues a session, resolves it, and then reads rows back.
 *
 * The bug this pins: the resolve query read `row.session_id` without selecting the
 * column, so `session.sessionId` came out undefined for every signed-in request.
 * Every gated screen then took its no-session branch — display-only for an
 * entitled user, with the holder rendered as an em dash — and nothing failed
 * loudly. So the assertions below are written from the outside in: a live session
 * must own the lock, and a session that is not live must never own one.
 */
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { closeDb, withTenant } from '@/platform/db/client';
import { hashPassword } from '@/platform/auth/password';
import {
  createSession,
  resolveSession,
  revokeSession,
  signIn,
  type SessionContext,
} from '@/platform/auth/session';
import {
  EnqueueError,
  assertChangeForSession,
  displayOnlyMessage,
  heartbeatChangeLock,
  listEnqueue,
  openChangeForSession,
  releaseChangeLock,
} from '@/platform/lock/enqueue';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const PASSWORD = 'change-lock-7';

/**
 * Fixed seeds rather than `testClientId` guesses: these two keys are the ones that
 * hash free of every other fixture tenant in the suite, so this file cannot be
 * corrupted by a test running in parallel.
 */
const tenant: TestTenant = await createTenant('session-change-lock-0');
const other: TestTenant = await createTenant('session-change-lock-1');

const LOCK_OBJECT = 'MATERIAL';

/** The same hash the session module stores, so a test can find a row by its token. */
function tokenHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function addPerson(client: string, username: string): Promise<void> {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into app_user
        (id, client, username, full_name, email, password_hash, is_active, is_locked, created_by)
      values
        (gen_random_uuid()::text, ${client}, ${username}, ${username},
         null, ${await hashPassword(PASSWORD)}, true, false, 'TEST')
    `);
  });
}

await addPerson(tenant.client, 'scl.editor');
await addPerson(tenant.client, 'scl.second');
await addPerson(other.client, 'scl.editor');

afterAll(async () => {
  await destroyTenant(other.client);
  await destroyTenant(tenant.client);
  await closeDb();
});

/**
 * The path a request takes: sign in for real, issue the session the logon would
 * hand to the cookie, then resolve that token the way `requireSession` does.
 *
 * `ttlMinutes` is passed through so a caller can produce a session that is already
 * past its expiry instead of pretending with a hand-written row.
 */
async function liveSession(username: string, client = tenant.client, ttlMinutes?: number) {
  const user = await signIn({ client, username, password: PASSWORD });
  const created = await withTenant(client, (tx) =>
    createSession(tx, { client, userId: user.userId, ttlMinutes }),
  );
  const session = await withTenant(client, (tx) => resolveSession(tx, { client, token: created.token }));
  const persisted = (await withTenant(client, (tx) =>
    tx.execute(sql`
      select id from user_session where client = ${client} and user_id = ${user.userId}
        and token_hash = ${tokenHash(created.token)}
    `),
  )) as unknown as Array<{ id: string }>;

  return {
    session,
    token: created.token,
    /** The row the browser cookie stands for, read straight from the table. */
    storedId: persisted[0]?.id ?? null,
    client,
  };
}

async function lockRow(client: string, argument: string) {
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select owner_session_id, owner_user, transaction_code, mode
        from enqueue_entry
       where client = ${client} and lock_object = ${LOCK_OBJECT} and argument = ${argument}
    `)) as unknown as Array<{
      owner_session_id: string;
      owner_user: string;
      transaction_code: string | null;
      mode: string;
    }>;
    return rows[0] ?? null;
  });
}

async function clearLock(client: string, sessionId: string | undefined, argument: string) {
  if (!sessionId) return;
  await releaseChangeLock({
    client,
    sessionId,
    lockObject: LOCK_OBJECT,
    argument,
  });
}

describe('a resolved session is the session the lock belongs to', () => {
  it('hands change to a live session and records that session as the owner', async () => {
    const { session, storedId } = await liveSession('scl.editor');
    expect(session).not.toBeNull();
    const editor = session as SessionContext;
    expect(editor.sessionId).toBeTruthy();
    expect(editor.sessionId).toBe(storedId);

    const opened = await openChangeForSession(editor, {
      lockObject: LOCK_OBJECT,
      argument: 'RAW-SCL-OWNED',
      transactionCode: 'MM02',
    });
    expect(opened.mode).toBe('CHANGE');

    // The ownership is a fact in the database, not only in the return value: this
    // is the column every later save is judged against.
    const standing = await lockRow(tenant.client, 'RAW-SCL-OWNED');
    expect(standing?.owner_session_id).toBe(editor.sessionId);
    expect(standing?.owner_user).toBe('scl.editor');
    expect(standing?.mode).toBe('EXCLUSIVE');

    // And a save through the screen's own guard is allowed for exactly that session.
    await assertChangeForSession(editor, {
      lockObject: LOCK_OBJECT,
      argument: 'RAW-SCL-OWNED',
    });

    await clearLock(tenant.client, editor.sessionId, 'RAW-SCL-OWNED');
    expect(await lockRow(tenant.client, 'RAW-SCL-OWNED')).toBeNull();
  });

  it('keeps first-opener-wins: another session reads, never takes over', async () => {
    const holder = await liveSession('scl.editor');
    const bidder = await liveSession('scl.second');
    const held = holder.session as SessionContext;
    const second = bidder.session as SessionContext;

    await openChangeForSession(held, {
      lockObject: LOCK_OBJECT,
      argument: 'RAW-SCL-CONTESTED',
      transactionCode: 'MM02',
    });

    const refused = await openChangeForSession(second, {
      lockObject: LOCK_OBJECT,
      argument: 'RAW-SCL-CONTESTED',
      transactionCode: 'MM02',
    });
    expect(refused.mode).toBe('DISPLAY');
    expect(refused.holder?.username).toBe('scl.editor');

    await expect(
      assertChangeForSession(second, {
        lockObject: LOCK_OBJECT,
        argument: 'RAW-SCL-CONTESTED',
      }),
    ).rejects.toMatchObject({ code: 'ENQUEUE_HELD' });

    // The second session cannot move the heartbeat or the owner either.
    expect(
      await heartbeatChangeLock({
        client: tenant.client,
        sessionId: second.sessionId as string,
        lockObject: LOCK_OBJECT,
        argument: 'RAW-SCL-CONTESTED',
      }),
    ).toBe(false);
    await releaseChangeLock({
      client: tenant.client,
      sessionId: second.sessionId as string,
      lockObject: LOCK_OBJECT,
      argument: 'RAW-SCL-CONTESTED',
    });
    expect((await lockRow(tenant.client, 'RAW-SCL-CONTESTED'))?.owner_session_id).toBe(held.sessionId);

    // The owner releasing is what frees it — and only then.
    await clearLock(tenant.client, held.sessionId, 'RAW-SCL-CONTESTED');
    const after = await openChangeForSession(second, {
      lockObject: LOCK_OBJECT,
      argument: 'RAW-SCL-CONTESTED',
      transactionCode: 'MM02',
    });
    expect(after.mode).toBe('CHANGE');
    await clearLock(tenant.client, second.sessionId, 'RAW-SCL-CONTESTED');
  });
});

describe('a session that is not live never reaches change', () => {
  it('refuses an expired session and honours no lock left behind by it', async () => {
    const { session, storedId, token: expiredToken } = await liveSession('scl.editor');
    const editor = session as SessionContext;
    expect(editor.sessionId).toBe(storedId);

    await openChangeForSession(editor, {
      lockObject: LOCK_OBJECT,
      argument: 'RAW-SCL-EXPIRED',
      transactionCode: 'MM02',
    });
    expect((await lockRow(tenant.client, 'RAW-SCL-EXPIRED'))?.owner_session_id).toBe(editor.sessionId);

    // The session ages out while its screen still stands open.
    await withTenant(tenant.client, (tx) =>
      tx.execute(
        sql`update user_session set expires_at = now() - interval '1 minute' where id = ${storedId}`,
      ),
    );

    // A resolve of that token returns no session at all, which is what sends the
    // browser to the logon screen instead of granting a change opening.
    const reresolved = await withTenant(tenant.client, (tx) =>
      resolveSession(tx, { client: tenant.client, token: expiredToken }),
    );
    expect(reresolved).toBeNull();

    // And a save attempted with the identity the stale context still carries is
    // refused: the lock of an expired session is not an opening.
    const staleContext = {
      sessionId: editor.sessionId,
      user: { client: tenant.client },
    };
    await expect(
      assertChangeForSession(staleContext, {
        lockObject: LOCK_OBJECT,
        argument: 'RAW-SCL-EXPIRED',
      }),
    ).rejects.toBeInstanceOf(EnqueueError);
    // The row is refused, not honoured — and it is not swept away by the refusal
    // either: the rollback takes the purge with it. A dead session's lock is cleared
    // the next time the object is opened, which is the case immediately below.
    expect(await lockRow(tenant.client, 'RAW-SCL-EXPIRED')).toMatchObject({
      owner_session_id: editor.sessionId as string,
      owner_user: 'scl.editor',
    });

    // A fresh session of the same user takes what the expired one can no longer hold.
    const next = await liveSession('scl.editor');
    const reopened = await openChangeForSession(next.session as SessionContext, {
      lockObject: LOCK_OBJECT,
      argument: 'RAW-SCL-EXPIRED',
      transactionCode: 'MM02',
    });
    expect(reopened.mode).toBe('CHANGE');
    await clearLock(tenant.client, next.session?.sessionId, 'RAW-SCL-EXPIRED');
  });

  it('refuses a revoked session and drops the lock it held', async () => {
    const opened = await liveSession('scl.editor');
    const editor = opened.session as SessionContext;
    await openChangeForSession(editor, {
      lockObject: LOCK_OBJECT,
      argument: 'RAW-SCL-REVOKED',
      transactionCode: 'MM02',
    });

    await withTenant(tenant.client, (tx) =>
      revokeSession(tx, {
        client: tenant.client,
        token: opened.token,
        username: 'scl.editor',
      }),
    );

    const after = await withTenant(tenant.client, (tx) =>
      resolveSession(tx, { client: tenant.client, token: opened.token }),
    );
    expect(after).toBeNull();
    expect(await lockRow(tenant.client, 'RAW-SCL-REVOKED')).toBeNull();
    await expect(
      assertChangeForSession(editor, {
        lockObject: LOCK_OBJECT,
        argument: 'RAW-SCL-REVOKED',
      }),
    ).rejects.toMatchObject({ code: 'ENQUEUE_NOT_HELD' });
  });

  it('refuses a token that never matched a session', async () => {
    const forged = await withTenant(tenant.client, (tx) =>
      resolveSession(tx, {
        client: tenant.client,
        token: 'no-such-token-at-all',
      }),
    );
    expect(forged).toBeNull();

    // A deleted session row cannot be resolved by its old token either.
    const real = await liveSession('scl.editor');
    await withTenant(tenant.client, (tx) =>
      tx.execute(sql`delete from user_session where token_hash = ${tokenHash(real.token)}`),
    );
    const afterDelete = await withTenant(tenant.client, (tx) =>
      resolveSession(tx, { client: tenant.client, token: real.token }),
    );
    expect(afterDelete).toBeNull();
    expect(real.session?.sessionId).not.toBe(afterDelete?.sessionId);
  });

  it('fails closed when a context carries no session id, granting nothing', async () => {
    // The shape a hand-built fixture has. It must not become an opening, and it
    // must not leave a half-taken lock behind either.
    const fixture = { user: { client: tenant.client, username: 'scl.editor' } };
    const opened = await openChangeForSession(fixture, {
      lockObject: LOCK_OBJECT,
      argument: 'RAW-SCL-FIXTURE',
      transactionCode: 'MM02',
    });
    expect(opened.mode).toBe('DISPLAY');
    expect(opened.holder?.username).toBe('—');
    expect(displayOnlyMessage(opened)).toContain('display only');
    expect(await lockRow(tenant.client, 'RAW-SCL-FIXTURE')).toBeNull();

    await expect(
      assertChangeForSession(fixture, {
        lockObject: LOCK_OBJECT,
        argument: 'RAW-SCL-FIXTURE',
      }),
    ).rejects.toMatchObject({ code: 'ENQUEUE_ARGUMENT' });

    // An empty session id is the same nothing, and is refused the same way.
    await expect(
      assertChangeForSession(
        { sessionId: '', user: { client: tenant.client } },
        { lockObject: LOCK_OBJECT, argument: 'RAW-SCL-FIXTURE' },
      ),
    ).rejects.toMatchObject({ code: 'ENQUEUE_ARGUMENT' });

    const rows = await listEnqueue(tenant.client);
    expect(rows.some((row) => row.argument === 'RAW-SCL-FIXTURE')).toBe(false);
  });
});

describe('the session identity stays inside its own tenant', () => {
  it('gives each tenant its own lock and never resolves a foreign token', async () => {
    const here = await liveSession('scl.editor', tenant.client);
    const there = await liveSession('scl.editor', other.client);
    const local = here.session as SessionContext;
    const foreign = there.session as SessionContext;

    // The same username in two tenants is two sessions with two ids.
    expect(local.sessionId).toBeTruthy();
    expect(foreign.sessionId).toBeTruthy();
    expect(local.sessionId).not.toBe(foreign.sessionId);

    await openChangeForSession(local, {
      lockObject: LOCK_OBJECT,
      argument: 'RAW-SCL-ISOLATED',
      transactionCode: 'MM02',
    });
    const foreignOpening = await openChangeForSession(foreign, {
      lockObject: LOCK_OBJECT,
      argument: 'RAW-SCL-ISOLATED',
      transactionCode: 'MM02',
    });
    expect(foreignOpening.mode).toBe('CHANGE');
    expect(await lockRow(other.client, 'RAW-SCL-ISOLATED')).not.toBeNull();

    // A session id from this tenant owns nothing over there: the guard in the other
    // tenant refuses that object because it was never opened in that tenant.
    await expect(assertChangeForSession(
      { sessionId: local.sessionId, user: { client: other.client } },
      { lockObject: LOCK_OBJECT, argument: 'RAW-SCL-ONE-SIDE' },
    )).rejects.toMatchObject({ code: 'ENQUEUE_NOT_HELD' });

    // And the row here is untouched by anything that happened over there — including
    // a release attempted with a foreign session id.
    const listed = await listEnqueue(tenant.client);
    expect(listed.filter((row) => row.argument === 'RAW-SCL-ISOLATED')).toHaveLength(1);
    expect(listed.find((row) => row.argument === 'RAW-SCL-ISOLATED')?.ownerUser).toBe('scl.editor');
    await releaseChangeLock({
      client: tenant.client,
      sessionId: foreign.sessionId as string,
      lockObject: LOCK_OBJECT,
      argument: 'RAW-SCL-ISOLATED',
    });
    expect(await lockRow(tenant.client, 'RAW-SCL-ISOLATED')).not.toBeNull();
    expect(await lockRow(other.client, 'RAW-SCL-ISOLATED')).not.toBeNull();

    // And a token minted in one tenant is worthless in the other.
    const stolen = await withTenant(other.client, (tx) =>
      resolveSession(tx, { client: other.client, token: here.token }),
    );
    expect(stolen).toBeNull();

    await clearLock(tenant.client, local.sessionId, 'RAW-SCL-ISOLATED');
    await clearLock(other.client, foreign.sessionId, 'RAW-SCL-ISOLATED');
  });
});
