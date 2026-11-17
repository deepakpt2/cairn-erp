/**
 * OUTPUT.DISPATCH — renders and sends the output messages that stand PENDING (MAIL-03).
 *
 * A transaction that writes an output message writes it PENDING and returns; this job does the
 * reading of partners, materials and totals, the rendering, the PDF and the hand-over to the mail
 * queue. It is queued by the posting transaction (IMMEDIATE) and scheduled every two minutes as a
 * sweep, so a message whose enqueue was lost is still found. Two runs can reach the same row; the
 * row's PENDING status, taken `for update`, is the only arbiter.
 *
 * One transaction per message: a document that cannot be rendered — a missing partner, a material
 * deleted since — becomes that message's `error_text` and must never abandon the rest of the chunk.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { withTenant } from '@/platform/db/client';
import { registerJob } from '@/platform/job/registry';
import type { JobHandler } from '@/platform/job/types';
import { OUTPUT_ACTOR } from '../../foundation/output-notify';
import { outputMessage } from '../../foundation/output-schema';
import { processMaterialOutputMessage } from '../../inventory/material-document-output';
import { processSalesOutputMessage } from '../../sales/output';
import { OUTPUT_DISPATCH_JOB } from '../dispatch-queue';

export { OUTPUT_DISPATCH_JOB };

/** The composite key as one sortable text, so the cursor can step past rows that stay PENDING. */
const keyText = sql<string>`concat_ws('/', ${outputMessage.documentCategory}, ${outputMessage.documentNumber}, ${outputMessage.outputType}, ${outputMessage.transmissionMedium}, ${outputMessage.issueNumber})`;

/** Millisecond precision, the precision a JS Date can carry back into the cursor. */
const createdMs = sql`date_trunc('milliseconds', ${outputMessage.createdAt})`;

type Candidate = typeof outputMessage.$inferSelect;
type Outcome = 'PROCESSED' | 'ERROR' | 'SKIPPED';

async function processOne(client: string, candidate: Candidate): Promise<{ outcome: Outcome; replaced: number }> {
  return withTenant(client, async (tx) => {
    // The row decides: re-read it under a lock and let go of anything no longer PENDING.
    const [message] = await tx.select().from(outputMessage).where(and(
      eq(outputMessage.client, client),
      eq(outputMessage.documentCategory, candidate.documentCategory),
      eq(outputMessage.documentNumber, candidate.documentNumber),
      eq(outputMessage.outputType, candidate.outputType),
      eq(outputMessage.transmissionMedium, candidate.transmissionMedium),
      eq(outputMessage.issueNumber, candidate.issueNumber),
    )).for('update');
    if (!message || message.status !== 'PENDING') return { outcome: 'SKIPPED' as const, replaced: 0 };

    if (message.documentCategory === 'MATERIAL_DOCUMENT') {
      const result = await processMaterialOutputMessage(tx, client, OUTPUT_ACTOR, message);
      return { outcome: result.status, replaced: result.replacedCharacters };
    }
    const result = await processSalesOutputMessage(tx, client, OUTPUT_ACTOR, message);
    return { outcome: result.status, replaced: result.replacedCharacters };
  });
}

/** Record why one message failed, in a transaction of its own: the failed one was rolled back. */
async function recordFailure(client: string, candidate: Candidate, error: unknown): Promise<void> {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 190);
  await withTenant(client, (tx) => tx.update(outputMessage).set({
    status: 'ERROR', errorText: `The document could not be processed: ${reason}`.slice(0, 200),
    lastProcessedAt: new Date(), changedBy: OUTPUT_ACTOR, changedAt: new Date(),
  }).where(and(
    eq(outputMessage.client, client),
    eq(outputMessage.documentCategory, candidate.documentCategory),
    eq(outputMessage.documentNumber, candidate.documentNumber),
    eq(outputMessage.outputType, candidate.outputType),
    eq(outputMessage.transmissionMedium, candidate.transmissionMedium),
    eq(outputMessage.issueNumber, candidate.issueNumber),
    eq(outputMessage.status, 'PENDING'),
  )));
}

export const outputDispatchJob: JobHandler = {
  code: OUTPUT_DISPATCH_JOB,

  async chunk(ctx) {
    const cursor = (ctx.cursor ?? {}) as { afterKey?: string };
    const after = cursor.afterKey ? (JSON.parse(cursor.afterKey) as { at: string; key: string }) : null;

    const candidates = await withTenant(ctx.client, (tx) => tx.select().from(outputMessage).where(and(
      eq(outputMessage.client, ctx.client),
      eq(outputMessage.status, 'PENDING'),
      after ? sql`(${createdMs}, ${keyText}) > (${after.at}::timestamptz, ${after.key})` : undefined,
    )).orderBy(asc(createdMs), asc(keyText)).limit(ctx.chunkSize));

    let processed = 0;
    let failed = 0;
    let stoppedAt = '';
    for (const candidate of candidates) {
      stoppedAt = `${candidate.documentCategory} ${candidate.documentNumber} ${candidate.outputType}/${candidate.transmissionMedium}`;
      try {
        const { outcome, replaced } = await processOne(ctx.client, candidate);
        if (outcome === 'PROCESSED') processed += 1;
        else if (outcome === 'ERROR') failed += 1;
        if (replaced > 0) {
          await ctx.log('WARN', `${replaced} character(s) in ${stoppedAt} could not be represented in the PDF and were replaced.`, {
            documentNumber: candidate.documentNumber, replacedCharacters: replaced,
          });
        }
      } catch (error) {
        failed += 1;
        try {
          await recordFailure(ctx.client, candidate, error);
        } catch {
          // The failure could not even be recorded; the next sweep will find the row again.
        }
      }
    }

    const last = candidates[candidates.length - 1];
    const more = candidates.length === ctx.chunkSize && last
      ? {
          afterKey: JSON.stringify({
            at: new Date(last.createdAt).toISOString(),
            key: [last.documentCategory, last.documentNumber, last.outputType, last.transmissionMedium, last.issueNumber].join('/'),
          }),
        }
      : null;
    return {
      cursor: more,
      processed: candidates.length,
      progressText: candidates.length === 0
        ? 'nothing pending'
        : `${processed} processed, ${failed} failed; stopped at ${stoppedAt}`,
    };
  },
};

registerJob(outputDispatchJob);
