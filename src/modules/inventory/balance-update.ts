/**
 * The balance write the goods-movement posters already share.
 *
 * A posting reads a valuation total, then later stores an absolute new total. Two
 * postings of the same material — or two lines of one posting — each write their
 * own snapshot and the second erases the first. The row lock below makes the
 * re-read the latest committed total, including a line this transaction already
 * applied, and the write is that total plus this delta.
 *
 * Request-key replay is the same idea: the unique index stops a second document,
 * and the fingerprint stops a different payload from wearing the first key.
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { materialDocument, materialValuation } from './schema';

const round2 = (n: number) => Math.round(n * 100) / 100;

export const REQUEST_MISMATCH_REMEDY = 'Post with a fresh request key, or repeat the original request exactly.';

export function postingFingerprint(parts: Array<string | number | null | undefined>): string {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('|')).digest('hex');
}

export function quantityToken(quantity: number): string {
  return Number(quantity).toFixed(6);
}

/** Held until commit, so a concurrent retry waits and then replays instead of colliding. */
export async function lockRequestKey(tx: Tx, client: string, requestKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/md-request/${requestKey}`}, 0))`);
}

/**
 * A stored fingerprint that differs is a second posting under the first key.
 * A document posted before fingerprints were stored has none; the same key still replays.
 */
export async function mismatchedRequest(
  tx: Tx, client: string, requestKey: string, fingerprint: string,
): Promise<string | null> {
  const [header] = await tx.select({
    number: materialDocument.materialDocumentNumber,
    requestFingerprint: materialDocument.requestFingerprint,
  }).from(materialDocument).where(and(
    eq(materialDocument.client, client),
    eq(materialDocument.requestKey, requestKey),
  ));
  if (!header?.requestFingerprint || header.requestFingerprint === fingerprint) return null;
  return `Request key ${requestKey} already posted ${header.number}, and this is a different posting: the stored request does not match this one.`;
}

/**
 * Apply a quantity and value delta to the locked valuation row.
 * Moving average is recomputed from the totals just written, matching the previous rounding.
 */
export async function applyValuationDelta(
  tx: Tx,
  client: string,
  changedBy: string,
  materialNumber: string,
  plant: string,
  quantityDelta: number,
  valueDelta: number,
): Promise<void> {
  const [v] = await tx.select().from(materialValuation).where(and(
    eq(materialValuation.client, client),
    eq(materialValuation.materialNumber, materialNumber),
    eq(materialValuation.valuationArea, plant),
  )).for('update');
  if (!v) return;
  const newQty = Number(v.totalStockQuantity) + quantityDelta;
  const newValue = Number(v.stockValue) + valueDelta;
  await tx.update(materialValuation).set({
    totalStockQuantity: String(newQty),
    stockValue: String(newValue),
    movingAveragePrice: v.priceControl === 'MOVING_AVERAGE' && newQty > 0
      ? String(round2((newValue / newQty) * Number(v.priceUnit)) || 0)
      : v.movingAveragePrice,
    changedBy,
    changedAt: new Date(),
  }).where(and(
    eq(materialValuation.client, client),
    eq(materialValuation.materialNumber, materialNumber),
    eq(materialValuation.valuationArea, plant),
  ));
}
