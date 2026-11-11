/**
 * The one operation: tell somebody something. Phase 7.
 *
 * Two rules shape this file.
 *
 * **Emitted inside the caller's transaction.** Out-of-band delivery can
 * announce a change that never committed; after-the-fact delivery can lose one
 * that did. If the insert fails the business change rolls back, which is the
 * right way round: a save the user retries beats an announcement of something
 * that vanished.
 *
 * **A notification is a pointer, never a permission.** Whether the button on
 * the far end works is `can(session, capability)`, unchanged and untouched by
 * anything here.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Tx } from '@/platform/db/client';
import { withTenantAs } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { notification } from '@/platform/tables/system';

import type { NotifyInput, NotificationView } from './types';

/**
 * Tell one person one thing, inside the caller's transaction.
 *
 * Returns the new row's id, or null when an identical unseen notification
 * already exists — which is not an error. A sweep that runs daily and finds
 * the same expiring grant would otherwise say the same thing every day.
 */
export async function notifyOn(tx: Tx, input: NotifyInput): Promise<string | null> {
  const [row] = await tx.execute<{ notification_deliver: string | null }>(
    sql`select notification_deliver(
      ${input.client}, ${input.recipient}, ${input.kind}, ${input.objectClass},
      ${input.objectKey}, ${input.messageKey},
      ${JSON.stringify(input.messageParams ?? {})}::jsonb
    ) as notification_deliver`,
  );
  return row?.notification_deliver ?? null;
}

/**
 * Tell several people the same thing.
 *
 * Used after recipients have been resolved by capability and scope. A pool is
 * only ever built that way — never passed in by a caller, because a caller
 * that can name recipients can name anybody.
 */
export async function notifyAll(
  tx: Tx,
  client: string,
  recipients: readonly string[],
  shared: Omit<NotifyInput, 'client' | 'recipient'>,
): Promise<number> {
  let written = 0;
  for (const recipient of new Set(recipients)) {
    if (!recipient) continue;
    const id = await notifyOn(tx, { ...shared, client, recipient });
    if (id) written += 1;
  }
  return written;
}

/**
 * Mark one notification seen. Idempotent: opening the same thing twice is not
 * an error, and re-marking does not move the time.
 *
 * Scoped to the recipient by RLS, so asking about somebody else's row marks
 * nothing rather than reporting success.
 */
export async function markSeen(
  client: string,
  userId: string,
  notificationId: string,
): Promise<boolean> {
  return withTenantAs(client, userId, async (tx) => {
    const updated = await tx
      .update(notification)
      .set({ seenAt: sql`now()` })
      .where(
        and(
          eq(notification.client, client),
          eq(notification.notificationId, notificationId),
          isNull(notification.seenAt),
        ),
      )
      .returning({ id: notification.notificationId });
    return updated.length > 0;
  });
}

/** Mark everything in this person's inbox seen. */
export async function markAllSeen(client: string, userId: string): Promise<number> {
  return withTenantAs(client, userId, async (tx) => {
    const updated = await tx
      .update(notification)
      .set({ seenAt: sql`now()` })
      .where(and(eq(notification.client, client), isNull(notification.seenAt)))
      .returning({ id: notification.notificationId });
    return updated.length;
  });
}

/**
 * This person's inbox, newest first, unseen first among equals.
 *
 * Unseen rows sort above seen ones because the inbox is a worklist: the thing
 * you have not read is what you came for. Within each group, newest first —
 * the opposite of the attention panel, which is oldest first because waiting
 * longer makes something more urgent. A notification is about something that
 * already happened, and recency is what makes it relevant.
 */
export async function listInbox(
  client: string,
  userId: string,
  limit = 50,
): Promise<NotificationView[]> {
  return withTenantAs(client, userId, async (tx) => {
    const rows = await tx
      .select()
      .from(notification)
      .where(eq(notification.client, client))
      .orderBy(asc(notification.seenAt), desc(notification.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      ...row,
      messageParams: (row.messageParams ?? {}) as Record<string, unknown>,
      title: t(row.messageKey, row.messageParams as Record<string, string | number>),
      isUnseen: row.seenAt === null,
    }));
  });
}

/** How many are waiting. The only number the bell needs. */
export async function unreadCount(client: string, userId: string): Promise<number> {
  return withTenantAs(client, userId, async (tx) => {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(notification)
      .where(and(eq(notification.client, client), isNull(notification.seenAt)));
    return row?.count ?? 0;
  });
}
