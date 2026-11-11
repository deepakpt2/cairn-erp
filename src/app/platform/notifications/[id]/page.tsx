/**
 * Opening one notification — Phase 7.
 *
 * The whole of "read" in this model: mark it seen, then show the person what
 * it was about.
 *
 * It redirects rather than renders, because opening is an act and not a
 * destination, and because a page that both mutates and renders invites the
 * browser to repeat the mutation on refresh.
 *
 * Where it lands is the inbox. Mapping `object_class` and `object_key` to a
 * screen would need a routing table, and building one would mean deciding, for
 * every document type in the system, which screen is the right one to open —
 * a decision no one has made yet. Until it is made, opening tells you what
 * happened and takes you back to the list, which at least cannot lie about
 * where you are.
 */
import { redirect } from 'next/navigation';

import { requireSession } from '@/platform/auth/current';
import { markSeen } from '@/platform/notification/notify';

export const dynamic = 'force-dynamic';

const ROUTE = '/platform/notifications';

export default async function OpenNotificationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession(ROUTE);

  await markSeen(session.user.client, session.user.userId, id).catch(() => {
    // Not seeing a message is not worth failing a navigation over. The row
    // stays unseen and the next open tries again.
  });

  redirect(ROUTE);
}
