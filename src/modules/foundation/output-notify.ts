/**
 * OUTPUT.FAILED — the one author of the notification rule. Phase 8.
 *
 * A failed output is not an error on the screen where it happened. An order
 * confirmation that could not be e-mailed was dispatched inside the transaction
 * that saved the order, and the person who saved it may have moved on; the
 * message then sits at ERROR in the shared queue until somebody with the output
 * capability notices it, gives the partner an address, and issues it again.
 * Nothing in the product looks at that queue on its own, so the queue has to
 * speak.
 *
 * Two decisions shape this file, and both are the decisions the credit pair
 * already made for the same reasons.
 *
 * **Only a transition into ERROR is an episode.** A message that already stood
 * at ERROR and is dispatched again fails again, and saying so a second time
 * tells nobody anything they do not already have unread — the notification
 * table's own deduplication would swallow it, at the cost of a run and a
 * resolution per attempt.
 *
 * **The recipients are a capability within a place, not a person.** Who may
 * dispatch output is `SALES.OUTPUT.PROCESS` over the document's sales area, or
 * `INV.MATERIALDOC.RECEIVEPRINT` over the plant the document's lines stand in.
 * Resolving that means loading every candidate's authority, which does not
 * belong on the request path — least of all on the path that is *writing the
 * document* — so the transaction records only what it already knows and the
 * worker does the rest once the dispatch is committed.
 *
 * The rule has two callers, one per application, and they deliberately share
 * this file rather than each writing their own: sales and inventory already
 * have two authors of the dispatch rule, and a third pair of authors of the
 * notification rule is two more places for it to disagree with itself.
 */
import type { Tx } from '../../platform/db/client';
import { enqueue } from '../../platform/job/queue';
import { FANOUT_JOB } from '../../platform/notification/jobs/fanout';

/**
 * Who the run is attributed to. A non-person, like `'RELEASE'` and `'CREDIT'`:
 * an output failure has no submitter to name, and naming the document's author
 * would make the job status page claim they asked for it.
 */
export const OUTPUT_ACTOR = 'OUTPUT';

/**
 * The two classes a failed output notification carries.
 *
 * `output_message` — the shared queue's own name — is deliberately *not* used
 * here even though it is the object the failure happened to. Routing is by
 * class, and a material-document slip and a sales invoice have two different
 * screens: one class with two homes is exactly why the routing table leaves
 * `output_message` out. These two have one home each.
 */
export const SALES_OUTPUT_NOTIFICATION_CLASS = 'sales_output';
export const MATERIAL_DOC_OUTPUT_NOTIFICATION_CLASS = 'material_document_output';

export type OutputNotificationClass =
  | typeof SALES_OUTPUT_NOTIFICATION_CLASS
  | typeof MATERIAL_DOC_OUTPUT_NOTIFICATION_CLASS;

export interface OutputFailedInput {
  client: string;
  objectClass: OutputNotificationClass;
  /** The document, which is what the notification names and what the screen filters by. */
  documentNumber: string;
  outputType: string;
  transmissionMedium: string;
  issueNumber: number;
  /** The capability whose holders can put this right. */
  capability: string;
  /**
   * Where they have to hold it. One entry per place the output has to be
   * answered in — a material document can span plants, and a holder scoped to
   * one of them is not responsible for the others.
   */
  orgs: Record<string, string>[];
  /**
   * The status the message carried before this attempt. Only a message that
   * was *not* already in error is worth a notification.
   */
  previousStatus: string;
}

/**
 * Queue the fan-out, inside the caller's transaction.
 *
 * A message that was already at ERROR queues nothing, and a document no plant
 * or sales area can be named for queues nothing either: an unscoped fan-out
 * would reach every holder of the capability in the tenant, which is the
 * enumeration the recipient rule exists to prevent.
 */
export async function enqueueOutputFailed(tx: Tx, input: OutputFailedInput): Promise<void> {
  if (input.previousStatus === 'ERROR') return;
  const scoped = input.orgs.filter((org) => Object.keys(org).length > 0);
  if (scoped.length === 0) return;

  for (const org of scoped) {
    await enqueue(tx, {
      client: input.client,
      jobCode: FANOUT_JOB,
      triggeredBy: OUTPUT_ACTOR,
      idempotencyKey: [
        'output-failed',
        input.objectClass,
        input.documentNumber,
        input.outputType,
        input.transmissionMedium,
        input.issueNumber,
        Object.entries(org).sort().map(([key, value]) => `${key}=${value}`).join(','),
      ].join('/').slice(0, 120),
      parameters: {
        capability: input.capability,
        org,
        kind: 'OUTPUT.FAILED',
        objectClass: input.objectClass,
        objectKey: input.documentNumber,
        messageKey: 'notification.kind.OUTPUT.FAILED',
        messageParams: { document: input.documentNumber },
      },
    });
  }
}
