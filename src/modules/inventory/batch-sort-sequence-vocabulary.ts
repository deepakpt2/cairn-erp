/**
 * The batch sort sequence status codes CU71 offers, and their meanings.
 *
 * Kept apart from the maintenance service so the screen can render its dropdown
 * without pulling the database into the client bundle — the same separation
 * `movement-type-vocabulary.ts` and `batch-classification-vocabulary.ts` use.
 *
 * `SORT_STATUS`, `LOCK_OBJECT`, the aliases and every writer that checks a
 * capability, locks the row or reads and writes the table stay in
 * `batch-sort-sequence.ts`.
 */

export const SORT_STATUS = [
  { code: '0', title: 'In preparation' },
  { code: '1', title: 'Released' },
  { code: '2', title: 'Locked' },
] as const;
