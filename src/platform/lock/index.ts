/**
 * Enqueue and locking — engine E4, CAIRN.md §5.2, D-018
 *
 * PostgreSQL advisory locks, transaction-scoped. Two properties matter:
 *
 *  1. They are released automatically when the transaction ends, so a crashed
 *     request cannot leave a stale lock behind. No lock-cleanup job, no "why is
 *     this document locked forever" support call.
 *  2. Keys are acquired in a deterministic sorted order. Two transactions
 *     touching the same set of objects always take their locks in the same
 *     sequence, which is what prevents deadlocks rather than merely detecting them.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { lockWaitLog } from '../tables/lock';

export interface LockRequest {
  objectCode: string;
  /** Business keys that identify the locked instance, e.g. ['MAT-1000', 'PLANT-1000']. */
  keys: string[];
}

export interface LockOptions {
  client: string;
  requestedBy: string;
  transactionCode?: string;
  /** Milliseconds to wait before giving up. Defaults to 10 seconds. */
  waitTimeoutMs?: number;
}

/**
 * 64-bit FNV-1a. Chosen for speed and good dispersion; a collision would cause
 * false contention between unrelated objects (slower, never incorrect), and at
 * 64 bits over a few thousand distinct lock keys the odds are negligible.
 */
function fnv1a64(input: string): bigint {
  const FNV_PRIME = 0x100000001b3n;
  const OFFSET_BASIS = 0xcbf29ce484222325n;
  const MASK = 0xffffffffffffffffn;
  let hash = OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK;
  }
  // Fold into signed 64-bit range, which is what pg_advisory_xact_lock expects.
  return hash >= 0x8000000000000000n ? hash - 0x10000000000000000n : hash;
}

function lockKeyFor(objectCode: string, keys: string[]): bigint {
  return fnv1a64(`${objectCode}::${keys.join('|')}`);
}

/** Await a lock, waiting up to the timeout. Throws a clear error if it cannot be had. */
export async function acquireLock(
  tx: Tx,
  request: LockRequest,
  options: LockOptions,
): Promise<void> {
  const timeoutMs = options.waitTimeoutMs ?? 10_000;
  const key = lockKeyFor(request.objectCode, request.keys);
  const lockKeyText = `${request.objectCode}:${request.keys.join(',')}`;
  const started = Date.now();

  // pg_try_advisory_xact_lock never blocks, so we control the timeout and can
  // report contention instead of silently hanging a request for ever.
  const deadline = started + timeoutMs;
  let attempt = 0;

  for (;;) {
    const result = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${key as unknown as string}::bigint) as acquired`,
    );
    const rows = result as unknown as Array<{ acquired: boolean }>;
    if (rows[0]?.acquired) {
      const waited = Date.now() - started;
      if (waited > 50) {
        await writeWaitLog(tx, options, request, 'ACQUIRED_AFTER_WAIT', waited);
      }
      return;
    }

    if (Date.now() >= deadline) {
      await writeWaitLog(tx, options, request, 'TIMED_OUT', Date.now() - started);
      throw new LockTimeoutError(request.objectCode, lockKeyText, timeoutMs);
    }
    // Back off a little more each round, so a hot lock does not spin the CPU.
    attempt++;
    await sleep(Math.min(25 * attempt, 250));
  }
}

/** Acquire several locks in a deterministic order, which is the deadlock guard. */
export async function acquireLocks(
  tx: Tx,
  requests: LockRequest[],
  options: LockOptions,
): Promise<void> {
  const ordered = [...requests].sort((a, b) => {
    const ak = lockKeyFor(a.objectCode, a.keys);
    const bk = lockKeyFor(b.objectCode, b.keys);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  for (const request of ordered) {
    await acquireLock(tx, request, options);
  }
}

/** Advisory locks held by the current transaction. Powers the lock monitor (§24.4). */
export async function currentLocks(tx: Tx) {
  const result = await tx.execute(sql`
    select classid, objid, objsubid, mode, granted
    from pg_locks
    where locktype = 'advisory'
    order by granted desc
  `);
  return result as unknown as Array<{
    classid: string;
    objid: string;
    objsubid: number;
    mode: string;
    granted: boolean;
  }>;
}

async function writeWaitLog(
  tx: Tx,
  options: LockOptions,
  request: LockRequest,
  outcome: string,
  waitedMs: number,
) {
  await tx.insert(lockWaitLog).values({
    id: crypto.randomUUID(),
    client: options.client,
    lockObjectCode: request.objectCode.slice(0, 40),
    lockKey: request.keys.join(',').slice(0, 200),
    outcome,
    waitedMs,
    requestedBy: options.requestedBy,
    transactionCode: options.transactionCode,
  });
}

export class LockTimeoutError extends Error {
  readonly code = 'CAIRN_LOCK_TIMEOUT';
  constructor(
    readonly objectCode: string,
    readonly lockKey: string,
    readonly waitedMs: number,
  ) {
    super(
      `Could not obtain lock on ${objectCode} (${lockKey}) within ${waitedMs} ms. ` +
        `Another user is changing the same object. Retry once they have finished.`,
    );
    this.name = 'LockTimeoutError';
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
