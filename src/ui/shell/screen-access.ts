import { SCREENS } from './screen-catalog';
import { hasCapability } from '@/platform/auth/session';

/**
 * Which related screens a reader is shown — CAIRN.md §19.1.
 *
 * The strip offers the screens next door to the one you are on. Offering one you
 * cannot use is noise, so a screen is offered when you hold the authority it is
 * about — and that is the screen's own code, the same string the page passes to
 * `can(session, ACTIVITY)`. The catalogue is read, never restated.
 *
 * Two things are offered to everybody, and both are deliberate:
 *
 *  1. A screen with no code. It claims no authority, so there is nothing to hold.
 *  2. A screen whose code *names reading* — DISPLAY, LIST, REPORT, BALANCE and
 *     the rest. In this application opening a screen asks only for a session;
 *     the authority is what lets you *do* something on it. So an inquiry screen
 *     is genuinely usable by someone who holds nothing at all, and hiding it
 *     would be pedantry dressed as security.
 *
 * That leaves the screens that exist to change something — DEFINE, POST, CLEAR,
 * SETTLE. Those are the ones this filter removes, and they are removed from the
 * strip only: every page still enforces its own authority the moment you try to
 * post. Hiding a link is a courtesy, never a control.
 *
 * This module runs on the server. It sends no authority to the browser — only
 * the list of screens this reader may be shown.
 */

/**
 * Final segments that name reading rather than writing.
 *
 * Reviewed by hand against the catalogue. Adding a screen to the strip for
 * everyone is a one-word change here; so is taking one away.
 */
const READ_VERBS: readonly string[] = [
  'DISPLAY',
  'LIST',
  'VIEW',
  'REPORT',
  'INQUIRY',
  'SEARCH',
  'OVERVIEW',
  'INFO',
  'AGEING',
  'BALANCE',
  'BALANCESHEET',
  'TRIALBALANCE',
  'PROFITLOSS',
  'CASHFLOW',
  'COMPARISON',
  'MONITOR',
  'STOCKREQ',
];

/**
 * Screens shown to everyone regardless of what they hold, over and above the
 * reading screens above. Empty by default: the verbs should carry it, and a
 * special case belongs here only with a reason beside it.
 */
const ALWAYS_VISIBLE: readonly string[] = [];

function namesReading(code: string): boolean {
  const last = code.split('.').pop() ?? '';
  return READ_VERBS.includes(last);
}

/** The screens this reader may be offered, by screen id. */
export function visibleScreenIds(capabilities: readonly string[]): ReadonlySet<string> {
  const held = [...capabilities];
  const ids = new Set<string>();
  for (const screen of SCREENS) {
    if (screen.code === '') {
      ids.add(screen.id);
      continue;
    }
    if (ALWAYS_VISIBLE.includes(screen.id)) {
      ids.add(screen.id);
      continue;
    }
    if (namesReading(screen.code)) {
      ids.add(screen.id);
      continue;
    }
    if (hasCapability(held, screen.code)) ids.add(screen.id);
  }
  return ids;
}
