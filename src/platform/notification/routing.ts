/**
 * Where opening a notification takes you. Phase 8.
 *
 * This is the piece Phase 7 deliberately left out, and the reason it was left
 * out is the reason this table is short: routing means deciding, for every
 * document type in the system, which screen is the right one to open. Guessing
 * is worse than not routing, because a link that lands on the wrong document
 * is a lie about where you are, whereas landing on the inbox is merely
 * unhelpful. So only classes with one obvious home appear here, and everything
 * else falls back to the inbox.
 *
 * The table keeps no knowledge of the screen catalogue. It is deliberately
 * free of any import from `ui/`, because `platform/` does not depend on the
 * shell anywhere else and a routing table is not the place to start. The
 * consistency between the two is asserted by a test instead, which is better:
 * a test fails loudly in CI, while a wrong import would only quietly invert
 * the layering.
 *
 * A route is a pointer, never a permission. Whether the screen on the far end
 * opens is still `can(session, capability)`, decided by that screen. Someone
 * who loses the authority between the notification arriving and being opened
 * gets the screen's own "you lack this authority" message, which names the
 * authority they are missing — more useful than a dead link here.
 */

/** What a router needs to know about a row. Nothing more. */
export interface RoutableNotification {
  objectClass: string;
  objectKey: string;
  /** Who it was sent to. Some screens are filtered by person, not by document. */
  recipient: string;
}

interface RouteEntry {
  path: string;
  /** The query parameter the screen reads. Omitted where the screen takes none. */
  param?: string;
  /**
   * What goes into `param`. Defaults to the object key.
   *
   * `recipient` exists for notifications that are about a person rather than a
   * document: an expiring grant is addressed to the person who holds it, and
   * the authority screen is filtered by user. Resolving that would need a
   * lookup from grant to holder, which is a query on the routing path to
   * answer a question the row already answers.
   */
  value?: 'key' | 'recipient';
}

/**
 * Object class to screen.
 *
 * Every `param` here must appear in that screen's `accepts` list in the screen
 * catalogue, and the screen must actually read it. Both are asserted by test.
 *
 * Absent on purpose:
 *
 * - `output_message` — the shared output queue's own name. A failed output is
 *   never routed under it, because one class covers two applications with two
 *   different screens; the notification carries `sales_output` or
 *   `material_document_output` instead, and each of those has one home.
 * - `user_session` — there is no session screen, and a closed session has
 *   nothing to show. The message is the whole content.
 * - `job_run` is present but takes no parameter: the jobs screen lists every
 *   run and accepts no filter, so it is the right place to land and cannot
 *   open the specific one.
 */
export const NOTIFICATION_ROUTES: Readonly<Record<string, RouteEntry>> = {
  purchase_requisition: { path: '/purchasing/requisitions', param: 'req' },
  purchase_order: { path: '/purchasing/purchase-order-display', param: 'order' },
  purchase_contract: { path: '/purchasing/contract-display', param: 'contract' },
  scheduling_agreement: {
    path: '/purchasing/scheduling-agreement-display',
    param: 'agreement',
  },
  sales_order: { path: '/sales/orders', param: 'order' },
  delivery: { path: '/sales/delivery', param: 'delivery' },
  // A failed output is routed to the document, because that is what the screen
  // filters by and what the message names.
  sales_output: { path: '/sales/output', param: 'documentNumber' },
  // The material-document output queue filters by a document *range*, not by one
  // document, so the specific slip cannot be opened from here. Landing on the
  // queue is the honest answer — the same reason `job_run` takes no parameter.
  material_document_output: { path: '/inventory/material-document-output' },
  // The COGI workbench opens one record by id, so the failure can be opened
  // rather than merely listed.
  production_goods_movement: { path: '/production/cogi', param: 'id' },
  user_capability: { path: '/people/authority', param: 'user', value: 'recipient' },
  job_run: { path: '/platform/jobs' },
};

/**
 * Where to send someone who opened this notification, or null.
 *
 * Null is not an error and is not worth logging: it means this class has no
 * obvious home yet, and the caller falls back to a place that always exists.
 */
export function routeForNotification(row: RoutableNotification): string | null {
  const entry = NOTIFICATION_ROUTES[row.objectClass];
  if (!entry) return null;

  if (!entry.param) return entry.path;

  const value = entry.value === 'recipient' ? row.recipient : row.objectKey;
  if (!value) return null;

  return `${entry.path}?${entry.param}=${encodeURIComponent(value)}`;
}
