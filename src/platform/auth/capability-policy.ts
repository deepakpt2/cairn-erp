/**
 * Authorities whose semantics require an exact role grant. A broad role pattern (including `*`) must
 * not silently grant these authorities. Adding a code here does not assign it to a role or user.
 */
export const CREDIT_CONTROL_AREA_CAPABILITY = 'CFG.FIN.CCA.MAINTAIN';
export const PRODUCTION_GOODS_MOVEMENT_REPROCESS_CAPABILITY = 'PROD.GM.REPROCESS';

export const EXPLICIT_GRANT_ONLY_CAPABILITIES: ReadonlySet<string> = new Set([
  CREDIT_CONTROL_AREA_CAPABILITY,
  PRODUCTION_GOODS_MOVEMENT_REPROCESS_CAPABILITY,
]);
