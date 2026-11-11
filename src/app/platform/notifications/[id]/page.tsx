/**
 * Opening one notification — Phase 7, completed in Phase 8.
 *
 * The whole of "read" in this model: mark it seen, then show the person what
 * it was about.
 *
 * It redirects rather than renders, because opening is an act and not a
 * destination, and because a page that both mutates and renders invites the
 * browser to repeat the mutation on refresh.
 *
 * Where it lands used to be the inbox, because there was no routing table.
 * Now there is one, and it covers the document classes that have exactly one
 * obvious screen. Classes it does not cover still land on the inbox: a
 * notification that opened the wrong document would be worse than one that
 * opened nothing, because it would be confidently wrong about where you are.
 *
 * The row is read before it is marked. Marking cannot fail in a way worth
 * reporting here, but if it did the person should still be taken somewhere —
 * an unmarked row is merely unread, while a dead end is a dead end.
 */
import { redirect } from 'next/navigation';

import { requireSession } from '@/platform/auth/current';
import { getNotification, markSeen } from '@/platform/notification/notify';
import { routeForNotification } from '@/platform/notification/routing';

export const dynamic = 'force-dynamic';

const INBOX = '/platform/notifications';

export default async function OpenNotificationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession(INBOX);

  const row = await getNotification(session.user.client, session.user.userId, id).catch(
    () => null,
  );

  await markSeen(session.user.client, session.user.userId, id).catch(() => {
    // Not seeing a message is not worth failing a navigation over. The row
    // stays unseen and the next open tries again.
  });

  // Falls back to the inbox for an unknown class, an unreadable row, or a row
  // that has already been tidied away. All three are worth one destination
  // that always exists.
  redirect((row && routeForNotification(row)) || INBOX);
}
