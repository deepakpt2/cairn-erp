/**
 * The orders a tenant can name, kept apart from the module that reads stock.
 *
 * The screen that maintains a rule is a client component, and this file is the reason it can import
 * the choices without pulling the database driver into the browser bundle: `batch-determination.ts`
 * imports the tables it reads, and a client component that imports it takes the whole of `postgres`
 * with it. The meaning of each order is part of what the tenant is choosing, so it lives with the
 * choices rather than in the screen.
 */

export const SORT_RULES = ['FIFO', 'LIFO', 'EXPIRY', 'BATCH_NUMBER'] as const;
export type SortRule = (typeof SORT_RULES)[number];

export const SORT_RULE_MEANING: Record<SortRule, string> = {
  FIFO: 'The batch that has stood longest goes first.',
  LIFO: 'The newest batch goes first.',
  EXPIRY: 'The batch that expires soonest goes first — FEFO, and what a perishable store wants.',
  BATCH_NUMBER: 'The lowest batch number goes first, which is the order an auditor can check.',
};
