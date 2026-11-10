/**
 * The one capability-pattern matcher.
 *
 * This module is a leaf on purpose. It exists so that `session.ts` (which loads
 * a user's authority) and `authority.ts` (which answers questions about it) can
 * share a single matcher without importing each other. Two matchers that
 * disagree is the difference between an authorisation check and a decoration,
 * so there is one, and it lives where both can reach it.
 *
 * The rules, in the order they are enforced:
 *
 *   - **Whole segments.** Matching is on complete dot-separated segments, so
 *     `PROC` does not match `PROCUREMENT.VIEW`. A naive `startsWith` is
 *     precisely the bug that turns a check into a decoration.
 *   - **Interior wildcards.** `PROC.*.CREATE` grants `PROC.PO.CREATE`. An
 *     interior `*` consumes exactly one segment; its suffix still has to match.
 *   - **The length rule.** A held pattern must account for the *whole* required
 *     path and no more. Holding `PROC.PO.CREATE` grants neither `PROC.PO` above
 *     it nor `PROC.PO.CREATE.APPROVE` below it.
 *   - **Explicit-grant-only authorities.** For a small set, patterns are not
 *     honoured at all: only an exact grant counts. A broad role pattern, even
 *     `*`, must not hand these out.
 */

import { EXPLICIT_GRANT_ONLY_CAPABILITIES } from './capability-policy';

/**
 * Does one held pattern grant one required authority?
 *
 * See the module comment for the rules. The two that were violated by an
 * earlier version of this function are the length checks: it stopped as soon as
 * the held segments ran out, so any authority that began with a held one was
 * allowed, and `PROC.PO.CREATE` would have granted `PROC.PO.CREATE.APPROVE`.
 */
export function patternGrants(heldParts: string[], requiredParts: string[]): boolean {
  for (let i = 0; i < heldParts.length; i += 1) {
    if (heldParts[i] === '*') {
      // A terminal wildcard covers the remainder, including no more segments.
      // An interior wildcard consumes ONE segment; its suffix still has to match.
      if (i === heldParts.length - 1) return true;
      if (i >= requiredParts.length) return false;
      continue;
    }
    // The pattern is longer than the requirement: it would be granting a
    // sub-authority of what was asked for, which is not what was asked.
    if (i >= requiredParts.length) return false;
    if (heldParts[i] !== requiredParts[i]) return false;
  }

  // The pattern ran out. It grants only if it consumed the requirement exactly.
  return heldParts.length === requiredParts.length;
}

/**
 * Does the user hold this authority?
 *
 * Matching is on whole dot-separated segments: `PROC.*` grants `PROC.PO.CREATE`,
 * and `PROC` alone grants nothing.
 */
export function hasCapability(capabilities: string[], required: string): boolean {
  // The administrator/configurator role patterns are intentionally broad. For a restricted authority,
  // those patterns must not turn registration in the catalogue into an effective grant; an exact role
  // capability assignment is the only grant recognized here.
  if (EXPLICIT_GRANT_ONLY_CAPABILITIES.has(required)) return capabilities.includes(required);
  const requiredParts = required.split('.');
  return capabilities.some((held) => patternGrants(held.split('.'), requiredParts));
}

/** Does this single pattern cover this capability? The grant-level form of `hasCapability`. */
export function patternMatches(pattern: string, capability: string): boolean {
  return hasCapability([pattern], capability);
}
