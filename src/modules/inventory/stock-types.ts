/**
 * Stock type identities — plain constants with no imports.
 *
 * Kept apart from the services (e.g. `warehouse-stocks.ts`, which reads the
 * database) so client-safe catalogues such as `transfer-scenarios.ts` can use
 * them without pulling server-only code (`next/headers`, the DB client) into
 * the browser bundle.
 */
export const UNRESTRICTED = 'UNRESTRICTED';
// The stock type column is varchar(16): the canonical value is QUALITY, displayed as quality inspection.
export const QUALITY_INSPECTION = 'QUALITY';
export const BLOCKED = 'BLOCKED';
/**
 * Returns stock — SAP's "blocked stock returns", what movement 651 receives a customer return into.
 * The goods stand in the plant but are not the company's stock again until they are inspected and
 * transferred out of here: the bucket is deliberately NOT VALUATED, so it is counted and it is not
 * valued, and a movement into it posts no accounting document.
 */
export const RETURNS = 'RETURNS';

/**
 * Stock in transit of a stock transport order (351 issued, 101 not yet posted). A plant-level quantity of
 * the RECEIVING plant with a blank storage location: it is counted and valued, and it is NOT available.
 */
export const IN_TRANSIT = 'IN_TRANSIT';
