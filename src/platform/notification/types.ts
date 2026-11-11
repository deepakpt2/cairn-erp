/**
 * Notifications — the shapes. Phase 7.
 *
 * A notification is a message to a user. It is stored. When they open it, it is
 * marked seen. Nothing else is tracked — not whether they acted on it, not
 * whether they dismissed it, not what they did next.
 *
 * That is the whole model, and the whole reason there is no state machine here.
 */

/** What a notification can be about. Constrained in SQL to `^[A-Z][A-Z0-9_.]{2,39}$`. */
export type NotificationKind =
  // Documents moving through release.
  | 'DOC.RELEASE.WAITING'
  | 'DOC.RELEASED'
  | 'DOC.REFUSED'
  // Credit.
  | 'CREDIT.BLOCKED'
  | 'CREDIT.RELEASED'
  // Documents that cannot be processed yet.
  | 'DOC.INCOMPLETE'
  | 'POSTING.FAILED'
  | 'OUTPUT.FAILED'
  // Authority and sessions.
  | 'GRANT.EXPIRING'
  | 'SESSION.CLOSED'
  // Background work.
  | 'JOB.COMPLETED'
  | 'JOB.FAILED'
  | 'JOB.BLOCKED';

/** What a notification points at. Not a foreign key — a message outlives what it is about. */
export type NotificationObjectClass =
  | 'purchase_requisition'
  | 'purchase_order'
  | 'sales_order'
  | 'output_message'
  | 'job_run'
  | 'user_session'
  | 'user_capability';

/** One row, as stored. */
export interface NotificationRow {
  notificationId: string;
  recipient: string;
  kind: string;
  objectClass: string;
  objectKey: string;
  /** i18n key, resolved at render. Never user-visible text (R-19, D-008). */
  messageKey: string;
  messageParams: Record<string, unknown>;
  createdAt: Date;
  seenAt: Date | null;
}

/**
 * One row, as the inbox shows it.
 *
 * `title` is the resolved message, which is the only place the locale is known.
 */
export interface NotificationView extends NotificationRow {
  title: string;
  isUnseen: boolean;
}

/** What a caller supplies. The recipient is one person, or a resolved pool. */
export interface NotifyInput {
  client: string;
  recipient: string;
  kind: NotificationKind;
  objectClass: NotificationObjectClass | string;
  objectKey: string;
  /** i18n key, not text. */
  messageKey: string;
  messageParams?: Record<string, string | number>;
}
