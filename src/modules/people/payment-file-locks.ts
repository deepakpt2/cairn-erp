/**
 * Shared transaction-level locks for the salary payment file and its controlled replacement.
 *
 * Lock protocol (acquire in this order, always):
 *   1. `employee-bank:<client>:<personnelNumber>` — sorted ascending across the employees involved. The bank
 *      maintenance services (`createEmployeeBank`, `endEmployeeBank`) take exactly this lock, so holding it
 *      freezes every effective bank record those employees could gain or lose for the duration.
 *   2. `payment-reissue-state:<client>:<runId>` — approval, cancellation, replacement download and the
 *      original file's ordinary download.
 *
 * Bank maintenance takes only lock (1); the file/reissue paths take (1) then (2). Because no path takes (2)
 * before (1), the ordering cannot deadlock: a bank write holds only the first class, every other writer holds
 * it before the second.
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
