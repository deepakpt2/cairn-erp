/**
 * The fan-out job — Phase 7.
 *
 * "This is waiting for your release" cannot be answered inside the business
 * transaction that created the document, because resolving who may release it
 * means loading every candidate's authority. That is real work and it does not
 * belong on the request path.
 *
 * So the transaction enqueues this job with what it knows — the capability the
 * next step needs, the document, and the place — and the worker resolves the
 * recipients and writes one row per person.
 *
 * The recipients are never supplied by the caller. A caller that can name
 * recipients can name anybody, and the inbox would become an address book for
 * sending messages to colleagues. They are derived, here, from authority.
 */
import { withTenant } from '@/platform/db/client';
import type { JobHandler } from '@/platform/job/types';
import { notifyAll } from '../notify';
import { resolveRecipients } from '../recipients';

export const FANOUT_JOB = 'NOTIFY.FANOUT';

interface FanoutParams {
  capability: string;
  org: Record<string, string>;
  kind: string;
  objectClass: string;
  objectKey: string;
  messageKey: string;
  messageParams?: Record<string, string | number>;
  asOf?: string;
}

export const fanoutJob: JobHandler = {
  code: FANOUT_JOB,

  /**
   * One chunk, then done. Resolving recipients is a single question about a
   * single document; splitting it across chunks would only make the same
   * people wait longer between chunks.
   */
  async chunk(ctx) {
    const p = ctx.parameters as unknown as FanoutParams;

    if (!p?.capability || !p?.objectClass || !p?.objectKey || !p?.kind) {
      await ctx.log('ERROR', 'Fan-out run is missing its parameters; nothing was sent.', {
        parameters: ctx.parameters,
      });
      return { cursor: null, processed: 0 };
    }

    const asOf = p.asOf ?? new Date().toISOString().slice(0, 10);

    const told = await withTenant(ctx.client, async (tx) => {
      const recipients = await resolveRecipients(tx, ctx.client, p.capability, p.org ?? {}, asOf);
      return notifyAll(tx, ctx.client, recipients, {
        kind: p.kind as never,
        objectClass: p.objectClass,
        objectKey: p.objectKey,
        messageKey: p.messageKey,
        messageParams: p.messageParams ?? {},
      });
    });

    await ctx.log('INFO', `Notified ${told} holder(s) of ${p.capability}.`, {
      capability: p.capability,
      objectClass: p.objectClass,
      objectKey: p.objectKey,
      told,
    });

    return {
      cursor: null,
      processed: told,
      progressText: `${p.objectClass} ${p.objectKey}, ${told} told`,
    };
  },
};
