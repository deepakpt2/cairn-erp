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

export * from '../modules/inventory/schema';
