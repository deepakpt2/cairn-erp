/**
 * Shared transaction-level locks for the salary payment file and its controlled replacement.
 *
 * Lock protocol (acquire in this order, always):
 *   1. `employee-bank:<client>:<personnelNumber>` — sorted ascending across the employees involved. The bank
 *      maintenance services (`createEmployeeBank`, `endEmployeeBank`) take exactly this lock, so holding it
 *      freezes every effective bank record those employees could gain or lose for the duration.
 *   2. `payment-reissue-state:<client>:<runId>` — approval, cancellation, replacement download and the
 *      original file's ordinary download.
 *   3. `payment-artifact:<client>` — SHARED by every artifact publisher (original preparation, replacement
 *      approval, backfill) for the whole publish+commit; EXCLUSIVE by the orphan sweeper. See below.
 *
 * Bank maintenance takes only lock (1); the file/reissue paths take (1) then (2); only the paths that publish an
 * artifact take (3), always last. The sweeper takes only (3). Because no path takes a higher class before a lower
 * one, the ordering cannot deadlock: a bank write holds only the first class, every other writer holds it before
 * the second, and the artifact lock is only ever taken after both.
 */
import { sql } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';

/** Sorted so two callers with the same employees never take the locks in a different order. */
export async function lockEmployeeBank(tx: Tx, client: string, personnelNumbers: readonly string[]): Promise<void> {
  const sorted = [...new Set(personnelNumbers.map((p) => p.trim().toUpperCase()).filter(Boolean))].sort();
  for (const personnelNumber of sorted) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`employee-bank:${client}:${personnelNumber}`}, 0))`);
  }
}

/** The per-run state lock, taken only after every `employee-bank` lock. */
export async function lockReissueState(tx: Tx, client: string, runId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payment-reissue-state:${client}:${runId}`}, 0))`);
}

/**
 * A key-scoped lock, so two requests reusing one `request_key` (even across runs) serialise on the key before
 * either looks it up. Taken before the state lock; it never nests inside a bank lock.
 */
export async function lockRequestKey(tx: Tx, client: string, requestKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payment-reissue-key:${client}:${requestKey}`}, 0))`);
}

/**
 * Tenant-scoped SHARED artifact-store lock. A publisher takes it BEFORE writing any staging/published file and
 * holds it (transaction-level) until commit or rollback, so the sweeper cannot observe a half-published artifact
 * as an orphan. Safe for multiple app instances and for long or stalled transactions: the lock is released by
 * PostgreSQL when the transaction ends, including on connection loss.
 */
export async function lockArtifactStoreShared(tx: Tx, client: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${`payment-artifact:${client}`}, 0))`);
}

/**
 * Tenant-scoped EXCLUSIVE artifact-store lock for the sweeper. It waits for every in-flight publisher (shared) to
 * commit or roll back, so a committed artifact is always visible when the sweep reads references. Must be the
 * sweeper's first statement; the reference check that follows is a fresh READ COMMITTED statement.
 */
export async function lockArtifactStoreExclusive(tx: Tx, client: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payment-artifact:${client}`}, 0))`);
}
