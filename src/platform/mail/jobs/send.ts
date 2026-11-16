/**
 * MAIL.SEND — the queue drain.
 *
 * Every five minutes, per tenant: claim due QUEUED / FAILED rows and hand each to sendOneMail.
 * Trapped per message, so one poisoned row cannot abandon the rest of the chunk. The run itself has
 * max_retries = 0 on purpose: the message row already counts its own attempts.
 */
import { and, asc, inArray, lte, eq, sql } from 'drizzle-orm';

import { withTenant } from '@/platform/db/client';
import type { JobHandler } from '@/platform/job/types';
import { registerJob } from '@/platform/job/registry';
import { mailMessage } from '@/platform/tables/system';
import { sendOneMail } from '../service';

export const MAIL_SEND_JOB = 'MAIL.SEND';

export const mailSendJob: JobHandler = {
  code: MAIL_SEND_JOB,

  async chunk(ctx) {
    const { ids } = await withTenant(ctx.client, async (tx) => ({
      ids: (
        await tx
          .select({ id: mailMessage.id })
          .from(mailMessage)
          .where(
            and(
              eq(mailMessage.client, ctx.client),
              inArray(mailMessage.status, ['QUEUED', 'FAILED']),
              lte(mailMessage.availableAt, sql`now()`),
            ),
          )
          .orderBy(asc(mailMessage.availableAt))
          .limit(ctx.chunkSize)
      ).map((r) => r.id),
    }));

    let sent = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        // One transaction per message: a send that fails must not roll back its neighbours.
        const outcome = await withTenant(ctx.client, (tx) => sendOneMail(tx, ctx.client, id));
        if (outcome === 'SENT') sent += 1;
        else if (outcome !== 'SKIPPED') failed += 1;
      } catch {
        failed += 1;
      }
    }

    // A full chunk may leave more due rows; the next scheduled run picks them up.
    return { cursor: null, processed: ids.length, progressText: `${sent} sent, ${failed} failed` };
  },
};

registerJob(mailSendJob);
