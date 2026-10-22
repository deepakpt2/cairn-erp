import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../change';
import { withTenant, type Tx } from '../db/client';
import { enqueueEntry } from '../tables/lock';

/**
 * Dialog enqueue — the lock SM12 lists.
 *
 * An exclusive entry is taken when a session opens a document, or a
 * configuration row, in change. It is not an advisory lock: the advisory
 * lock dies with the request, and a second user could open the same object
 * a moment later. This row stands until the session releases it, signs out,
 * or stops answering. A second session is not given the lock. It may read
 * the object and cannot change it.
 *
 * A company code is not a key. The argument is the document or the
 * configuration row. Nothing is posted.
 */

export const ENQUEUE_STALE_MS = 3 * 60 * 1000;

export class EnqueueError extends Error {
  readonly code: 'ENQUEUE_HELD' | 'ENQUEUE_NOT_HELD' | 'ENQUEUE_ARGUMENT';
  readonly holder?: EnqueueHolder;

  constructor(
    message: string,
    code: EnqueueError['code'],
    readonly remedy?: string,
    holder?: EnqueueHolder,
  ) {
    super(message);
    this.name = 'EnqueueError';
    this.code = code;
    this.holder = holder;
  }
}

export interface EnqueueHolder {
  username: string;
  transactionCode: string | null;
  acquiredAt: string;
}

export interface EnqueueOpen {
  mode: 'CHANGE' | 'DISPLAY';
  lockObject: string;
  argument: string;
  holder?: EnqueueHolder;
}

export interface EnqueueRow {
  lockObject: string;
  argument: string;
  mode: string;
  ownerUser: string;
  transactionCode: string | null;
  acquiredAt: string;
  heartbeatAt: string;
  stale: boolean;
}

function argumentOf(value: string): string {
  const argument = value.trim().toUpperCase();
  if (!argument || argument.length > 200) {
    throw new EnqueueError(
      'The lock argument is missing.',
      'ENQUEUE_ARGUMENT',
      'Open a document or a configuration row that already stands.',
    );
  }
  return argument;
}

function objectOf(value: string): string {
  const object = value.trim().toUpperCase();
  if (!/^[A-Z0-9_]{2,40}$/.test(object)) {
    throw new EnqueueError('The lock object is not a named object.', 'ENQUEUE_ARGUMENT');
  }
  return object;
}

async function purgeStale(tx: Tx, client: string) {
  await tx.execute(sql`
    delete from enqueue_entry e
     where e.client = ${client}
       and (
         e.heartbeat_at < now() - interval '3 minutes'
         or exists (
           select 1 from user_session s
            where s.id = e.owner_session_id
              and (s.revoked_at is not null or s.expires_at <= now())
         )
       )
  `);
}

function holderOf(row: {
  ownerUser: string;
  transactionCode: string | null;
  acquiredAt: Date;
}): EnqueueHolder {
  return {
    username: row.ownerUser,
    transactionCode: row.transactionCode,
    acquiredAt: row.acquiredAt.toISOString(),
  };
}

export async function openForChange(input: {
  client: string;
  sessionId: string;
  username: string;
  lockObject: string;
  argument: string;
  transactionCode: string;
}): Promise<EnqueueOpen> {
  const lockObject = objectOf(input.lockObject);
  const argument = argumentOf(input.argument);
  if (!input.sessionId) {
    throw new EnqueueError('The session is missing.', 'ENQUEUE_ARGUMENT', 'Sign in again.');
  }
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/enqueue/${lockObject}/${argument}`}, 0))`);
    await purgeStale(tx, input.client);
    const [standing] = await tx
      .select()
      .from(enqueueEntry)
      .where(and(
        eq(enqueueEntry.client, input.client),
        eq(enqueueEntry.lockObject, lockObject),
        eq(enqueueEntry.argument, argument),
      ))
      .for('update');
    if (!standing) {
      await tx.insert(enqueueEntry).values({
        client: input.client,
        lockObject,
        argument,
        mode: 'EXCLUSIVE',
        ownerUser: input.username,
        ownerSessionId: input.sessionId,
        transactionCode: input.transactionCode,
      });
      return { mode: 'CHANGE', lockObject, argument };
    }
    if (standing.ownerSessionId === input.sessionId) {
      await tx.update(enqueueEntry).set({ heartbeatAt: new Date(), transactionCode: input.transactionCode }).where(and(
        eq(enqueueEntry.client, input.client),
        eq(enqueueEntry.lockObject, lockObject),
        eq(enqueueEntry.argument, argument),
      ));
      return { mode: 'CHANGE', lockObject, argument };
    }
    return {
      mode: 'DISPLAY',
      lockObject,
      argument,
      holder: holderOf(standing),
    };
  });
}

export async function heartbeatChangeLock(input: {
  client: string;
  sessionId: string;
  lockObject: string;
  argument: string;
}): Promise<boolean> {
  const lockObject = objectOf(input.lockObject);
  const argument = argumentOf(input.argument);
  return withTenant(input.client, async (tx) => {
    await purgeStale(tx, input.client);
    const updated = await tx.update(enqueueEntry).set({ heartbeatAt: new Date() }).where(and(
      eq(enqueueEntry.client, input.client),
      eq(enqueueEntry.lockObject, lockObject),
      eq(enqueueEntry.argument, argument),
      eq(enqueueEntry.ownerSessionId, input.sessionId),
    )).returning({ argument: enqueueEntry.argument });
    return updated.length > 0;
  });
}

export async function releaseChangeLock(input: {
  client: string;
  sessionId: string;
  lockObject: string;
  argument: string;
}): Promise<void> {
  const lockObject = objectOf(input.lockObject);
  const argument = argumentOf(input.argument);
  await withTenant(input.client, async (tx) => {
    await tx.delete(enqueueEntry).where(and(
      eq(enqueueEntry.client, input.client),
      eq(enqueueEntry.lockObject, lockObject),
      eq(enqueueEntry.argument, argument),
      eq(enqueueEntry.ownerSessionId, input.sessionId),
    ));
  });
}

/** A save of an existing object is refused unless this session holds the change lock. */
export async function assertChangeLock(input: {
  client: string;
  sessionId: string;
  lockObject: string;
  argument: string;
}): Promise<void> {
  const lockObject = objectOf(input.lockObject);
  const argument = argumentOf(input.argument);
  await withTenant(input.client, async (tx) => {
    await purgeStale(tx, input.client);
    const [standing] = await tx.select().from(enqueueEntry).where(and(
      eq(enqueueEntry.client, input.client),
      eq(enqueueEntry.lockObject, lockObject),
      eq(enqueueEntry.argument, argument),
    ));
    if (!standing || standing.ownerSessionId !== input.sessionId) {
      const holder = standing ? holderOf(standing) : undefined;
      throw new EnqueueError(
        holder
          ? `${lockObject} ${argument} is being changed by ${holder.username}. This session cannot change it.`
          : `${lockObject} ${argument} is not open for change in this session.`,
        standing ? 'ENQUEUE_HELD' : 'ENQUEUE_NOT_HELD',
        holder
          ? 'Open it again when that session has left. Display does not take the lock.'
          : 'Open the object in change. A save does not take a lock the screen did not hold.',
        holder,
      );
    }
  });
}

export async function listEnqueue(client: string): Promise<EnqueueRow[]> {
  return withTenant(client, async (tx) => {
    await purgeStale(tx, client);
    const rows = await tx.select().from(enqueueEntry).where(eq(enqueueEntry.client, client));
    const now = Date.now();
    return rows
      .map((row) => ({
        lockObject: row.lockObject,
        argument: row.argument,
        mode: row.mode,
        ownerUser: row.ownerUser,
        transactionCode: row.transactionCode,
        acquiredAt: row.acquiredAt.toISOString(),
        heartbeatAt: row.heartbeatAt.toISOString(),
        stale: now - row.heartbeatAt.getTime() > ENQUEUE_STALE_MS,
      }))
      .sort((a, b) => a.lockObject.localeCompare(b.lockObject) || a.argument.localeCompare(b.argument));
  });
}

export async function deleteEnqueueEntry(input: {
  client: string;
  changedBy: string;
  lockObject: string;
  argument: string;
  reason: string;
}): Promise<void> {
  const lockObject = objectOf(input.lockObject);
  const argument = argumentOf(input.argument);
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new EnqueueError('A reason is required to delete a lock.', 'ENQUEUE_ARGUMENT', 'State why the lock is being removed.');
  }
  await withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(enqueueEntry).where(and(
      eq(enqueueEntry.client, input.client),
      eq(enqueueEntry.lockObject, lockObject),
      eq(enqueueEntry.argument, argument),
    )).for('update');
    if (!standing) {
      throw new EnqueueError(`${lockObject} ${argument} is not locked.`, 'ENQUEUE_NOT_HELD');
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'enqueue_entry',
      objectKey: `${lockObject}/${argument}`,
      changeType: 'DELETE',
      changedBy: input.changedBy,
      reason,
      transactionCode: 'SM12',
      before: {
        ownerUser: standing.ownerUser,
        transactionCode: standing.transactionCode,
        acquiredAt: standing.acquiredAt.toISOString(),
      },
    });
    await tx.delete(enqueueEntry).where(and(
      eq(enqueueEntry.client, input.client),
      eq(enqueueEntry.lockObject, lockObject),
      eq(enqueueEntry.argument, argument),
    ));
  });
}

export async function openChangeForSession(
  session: { sessionId?: string; user: { client: string; username: string } },
  input: { lockObject: string; argument: string; transactionCode: string },
): Promise<EnqueueOpen> {
  if (!session.sessionId) {
    return {
      mode: 'DISPLAY',
      lockObject: input.lockObject,
      argument: input.argument,
      holder: { username: '—', transactionCode: null, acquiredAt: new Date(0).toISOString() },
    };
  }
  return openForChange({
    client: session.user.client,
    sessionId: session.sessionId,
    username: session.user.username,
    ...input,
  });
}

export async function assertChangeForSession(
  session: { sessionId?: string; user: { client: string } },
  input: { lockObject: string; argument: string },
): Promise<void> {
  if (!session.sessionId) {
    throw new EnqueueError('The session is missing.', 'ENQUEUE_ARGUMENT', 'Sign in again.');
  }
  await assertChangeLock({
    client: session.user.client,
    sessionId: session.sessionId,
    ...input,
  });
}

export function displayOnlyMessage(open: EnqueueOpen): string | null {
  if (open.mode !== 'DISPLAY' || !open.holder) return null;
  const where = open.holder.transactionCode ? ` in ${open.holder.transactionCode}` : '';
  return `${open.lockObject} ${open.argument} is being changed by ${open.holder.username}${where}. This opening is display only.`;
}
