/**
 * Grant expiry sweep — Phase 7.
 *
 * A direct grant carries an end date, and the day it passes the person simply
 * stops being able to do the thing. Nothing tells them it is coming, which is
 * the kind of surprise people discover in the middle of a month-end close.
 *
 * This tells them once. It does not warn daily, because the deduplication is
 * on unseen rows: the sweep finds the same grant every day for seven days and
 * only the first of those writes anything. Once the row is seen the warning
 * has done its job, and a fresh expiry next quarter is a fresh row.
 *
 * Chunked, because a tenant can hold thousands of grants and this runs against
 * all of them. One chunk locks nothing and commits; the next picks up after
 * the last grant it looked at.
 */
import { and, asc, eq, gt, isNotNull, lte } from 'drizzle-orm';

import { withTenant } from '@/platform/db/client';
import type { JobHandler } from '@/platform/job/types';
import { registerJob } from '@/platform/job/registry';
import { userCapability } from '@/platform/tables/security';
import { notifyOn } from '@/platform/notification/notify';

export const GRANT_EXPIRING_JOB = 'AUTH.GRANT.EXPIRING';

/** How far ahead a grant is worth mentioning. */
const HORIZON_DAYS = 7;

export const grantExpiringJob: JobHandler = {
  code: GRANT_EXPIRING_JOB,

  async chunk(ctx) {
    const cursor = (ctx.cursor ?? {}) as { afterId?: string };
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);

    const result = await withTenant(ctx.client, async (tx) => {
      const rows = await tx
        .select({
          id: userCapability.id,
          userId: userCapability.userId,
          capabilityCode: userCapability.capabilityCode,
          validTo: userCapability.validTo,
        })
        .from(userCapability)
        .where(
          and(
            eq(userCapability.client, ctx.client),
            isNotNull(userCapability.validTo),
            lte(userCapability.validTo, horizon),
            gt(userCapability.validTo, today),
            // Resume where the last chunk stopped, never from zero.
            cursor.afterId ? gt(userCapability.id, cursor.afterId) : undefined,
          ),
        )
        .orderBy(asc(userCapability.id))
        .limit(ctx.chunkSize);

      let told = 0;
      for (const row of rows) {
        await notifyOn(tx, {
          client: ctx.client,
          recipient: row.userId,
          kind: 'GRANT.EXPIRING',
          objectClass: 'user_capability',
          objectKey: row.id,
          messageKey: 'notification.kind.GRANT.EXPIRING',
          messageParams: { capability: row.capabilityCode, date: row.validTo ?? '' },
        });
        told += 1;
      }

      const last = rows[rows.length - 1];
      const done = rows.length < ctx.chunkSize;
      return {
        told,
        cursor: done ? null : { afterId: last?.id },
        processed: rows.length,
      };
    });

    return {
      cursor: result.cursor,
      processed: result.processed,
      progressText: `${result.told} grant(s) expiring within ${HORIZON_DAYS} days`,
    };
  },
};

// As in fanout.ts: a handler that is imported but not registered is a run that
// fails the moment a worker claims it.
registerJob(grantExpiringJob);
