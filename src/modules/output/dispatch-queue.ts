/**
 * Queueing output dispatch (MAIL-03).
 *
 * A transaction that writes an output message writes it PENDING and queues the OUTPUT.DISPATCH job in
 * the same transaction; it renders nothing, builds no PDF and opens no socket. The job does the work.
 * This file is deliberately import-light so the sales and inventory modules can use it without
 * importing the job (and the PDF library behind it).
 */
import type { Tx } from '../../platform/db/client';
import { enqueue } from '../../platform/job/queue';
import { OUTPUT_ACTOR } from '../foundation/output-notify';

export const OUTPUT_DISPATCH_JOB = 'OUTPUT.DISPATCH';

/** The message key the idempotency key is built from: one queued run per message. */
export function outputMessageKey(message: {
  documentCategory: string; documentNumber: string; outputType: string;
  transmissionMedium: string; issueNumber: number;
}): string {
  return [
    message.documentCategory, message.documentNumber, message.outputType,
    message.transmissionMedium, message.issueNumber,
  ].join('/');
}

/**
 * Queue a dispatch run for one message, inside the caller's transaction.
 *
 * `IMMEDIATE` arrival (the posting transaction): the key is the message key, so a repeat of the same
 * message does not queue a second run. A deliberate act from a screen (`manual`) is a new decision —
 * dispatching an ERROR message again after the cause was fixed — so it carries a per-click suffix.
 * Either way the PENDING guard inside the job is the only arbiter of whether a row is processed.
 */
export async function enqueueOutputDispatch(
  tx: Tx,
  input: {
    client: string;
    message: Parameters<typeof outputMessageKey>[0];
    manual?: { triggeredBy: string };
  },
): Promise<void> {
  const key = outputMessageKey(input.message);
  await enqueue(tx, {
    client: input.client,
    jobCode: OUTPUT_DISPATCH_JOB,
    triggerType: input.manual ? 'MANUAL' : 'CHAINED',
    triggeredBy: input.manual?.triggeredBy ?? OUTPUT_ACTOR,
    idempotencyKey: input.manual ? `${key}@${Date.now()}` : key,
  });
}

/** Queue one sweep run for a whole selection of PENDING messages (the screens' "run"). */
export async function enqueueOutputSweep(tx: Tx, input: { client: string; triggeredBy: string }): Promise<void> {
  await enqueue(tx, {
    client: input.client,
    jobCode: OUTPUT_DISPATCH_JOB,
    triggerType: 'MANUAL',
    triggeredBy: input.triggeredBy,
    idempotencyKey: `SWEEP@${Date.now()}`,
  });
}
