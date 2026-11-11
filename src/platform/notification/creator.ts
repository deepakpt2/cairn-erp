/**
 * Who to tell about their own document. Phase 7.
 *
 * `document_release` has no creator column — it records the release state and
 * nothing about who asked for it. Rather than add one, this reads the change
 * trail, which already answers the question: the first `CREATE` change
 * document for an object names the person who made it.
 *
 * Returns null when there is no such record, which happens for documents
 * created before change documents were written, or seeded directly. Nothing is
 * sent in that case, which is the honest outcome — guessing a recipient is
 * worse than telling nobody.
 */
import { and, asc, eq } from 'drizzle-orm';

import type { Tx } from '@/platform/db/client';
import { changeDocument } from '@/platform/tables/audit-trail';

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
  return row?.changedBy ?? null;
}
