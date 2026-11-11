/**
 * Who to tell about their own document. Phase 7.
 *
 * `document_release` has no creator column — it records the release state and
 * nothing about who asked for it. Rather than add one, this reads the change
 * trail which already answers the question: the first `CREATE` change
 * document for an object names the person who made it.
 *
 * Returns null when there is no such record, which happens for documents
 * created before change documents were written, or seeded directly. Nothing is
 * sent in that case, which is the honest outcome — guessing a recipient is
 * worse than telling nobody.
 */
import { and, asc, eq } from 'drizzle-orm';

import type { Tx } from '@/platform/db/client';
import { appUser } from '@/platform/tables/security';
import { changeDocument } from '@/platform/tables/audit-trail';

/**
 * Turn whoever a record names into somebody the inbox can actually address.
 *
 * The change trail, and every `changed_by` column like it, carries a
 * **username**: all 400-odd module call sites pass `session.user.username`.
 * The inbox is keyed by `app_user.id`, because that is what the session carries
 * (`session.user.userId = user.id`) and what the recipient term of the
 * notification policy compares against.
 *
 * So the two are not interchangeable, and the failure is silent rather than
 * loud. A notification addressed to a username is a row that is written, stored,
 * counted as delivered — and that no session can ever read, because the policy
 * answers no rows for it. Nothing errors; the row simply sits there looking
 * like a working feature.
 *
 * The id is tried first, so a caller that already holds one does not pay for a
 * second lookup, and a trail that recorded an id rather than a username still
 * resolves.
 */
export async function recipientFor(
  tx: Tx,
  client: string,
  actor: string,
): Promise<string | null> {
  if (!actor) return null;

  const [byId] = await tx
    .select({ id: appUser.id })
    .from(appUser)
    .where(and(eq(appUser.client, client), eq(appUser.id, actor)))
    .limit(1);
  if (byId?.id) return byId.id;

  const [byUsername] = await tx
    .select({ id: appUser.id })
    .from(appUser)
    .where(and(eq(appUser.client, client), eq(appUser.username, actor)))
    .limit(1);
  return byUsername?.id ?? null;
}

export async function creatorOf(
  tx: Tx,
  client: string,
  objectClass: string,
  objectKey: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ changedBy: changeDocument.changedBy })
    .from(changeDocument)
    .where(
      and(
        eq(changeDocument.client, client),
        eq(changeDocument.objectClass, objectClass),
        eq(changeDocument.objectKey, objectKey),
        eq(changeDocument.changeType, 'CREATE'),
      ),
    )
    .orderBy(asc(changeDocument.changedAt))
    .limit(1);

  return recipientFor(tx, client, row?.changedBy ?? '');
}
