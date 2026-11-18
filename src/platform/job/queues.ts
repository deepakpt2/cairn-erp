/**
 * The queues the shipped worker services consume. Compose runs two processes:
 * the regular worker takes the short scheduled and event jobs, the intensive
 * worker takes long business runs, so a long run never holds the only slot that
 * sends mail.
 *
 * Two processes isolate worker slots only. They still share the database, its
 * CPU and memory; no latency is guaranteed.
 */
export const REGULAR_QUEUES = ['DEFAULT', 'MAIL', 'OUTPUT'] as const;
export const INTENSIVE_QUEUES = ['INTENSIVE'] as const;
export const INTENSIVE_QUEUE = 'INTENSIVE';
