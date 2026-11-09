/**
 * Schema root — CAIRN.md §20.1, §20.3
 *
 * Drizzle reads this file, and it is the single place a module registers its
 * tables. Adding a module means adding one export line here — the same
 * registration principle the screen registry uses for UI.
 */
export * from './tables';

/* ── Modules ────────────────────────────────────────────────────────────────
 * Each business module contributes its own tables. Platform tables above are
 * shared by all of them.
 */
export * from '../modules/finance/schema';
export * from '../modules/foundation/schema';
/**
 * Output — types, condition records and messages. It stands outside the inventory module that first
 * carried it, because a goods receipt slip and an invoice are both documents a company sends and one
 * queue has to hold them both (§4.4, audit gap C7).
 */
export * from '../modules/foundation/output-schema';

export * from '../modules/inventory/schema';
export * from '../modules/people/schema';
export * from '../modules/production/schema';
export * from '../modules/quality/schema';
export * from '../modules/sales/schema';
