/**
 * The shared strings of the settlement masters. This file holds no database access on purpose: the
 * client component opens a change session, the server actions assert one, and the module takes an
 * advisory transaction lock — all three read the same keys here, so a lock the browser holds and the
 * lock a save demands can never name different objects.
 */
export const SETTLEMENT_CONFIG_ACTIVITY = 'CFG.COST.SETTLEMENT.DEFINE';
export const SETTLEMENT_CONFIG_ROUTE = '/config/settlement-configuration';

/**
 * The change-lock name of each master, as the platform holds it.
 *
 * These are validated: `objectOf` in `src/platform/lock/enqueue.ts` admits only a named object —
 * two to forty characters of upper case, digits and underscores. A name outside that shape does not
 * fail loudly where it is written: `openChangeLockAction` turns it into display-only mode, so every
 * edit form opens locked, and the heartbeat answers 500. `tests/config-settlement-lock-object-contract.test.ts`
 * holds the line. The advisory key below is a different name space — it is hashed, never validated —
 * and its wording is what a run and a save contend on, so the two do not have to match and do not.
 */
export const SETTLEMENT_CONFIG_LOCKS = {
  structure: 'SETTLEMENT_ALLOCATION_STRUCTURE',
  profile: 'SETTLEMENT_PROFILE',
  orderType: 'SETTLEMENT_ORDER_TYPE',
} as const;

export type SettlementConfigLockKind = keyof typeof SETTLEMENT_CONFIG_LOCKS;

/** Codes are stored upper case; the lock argument is the stored code, so both sides normalise alike. */
export function settlementConfigArgument(code: string): string {
  return code.trim().toUpperCase();
}

export function settlementConfigLock(kind: SettlementConfigLockKind, code: string): { lockObject: string; argument: string } {
  return { lockObject: SETTLEMENT_CONFIG_LOCKS[kind], argument: settlementConfigArgument(code) };
}

/**
 * The key of the advisory lock the module takes, derived from the same pair. The suffixes are the ones
 * the settlement masters have always locked under, so a run and a screen already contend on them.
 */
const ADVISORY_SUFFIXES: Record<SettlementConfigLockKind, string> = {
  structure: 'allocation-structure',
  profile: 'settlement-profile',
  orderType: 'order-type-settlement',
};

export function settlementConfigAdvisoryKey(client: string, kind: SettlementConfigLockKind, code: string): string {
  return `${client}/${ADVISORY_SUFFIXES[kind]}/${settlementConfigArgument(code)}`;
}
