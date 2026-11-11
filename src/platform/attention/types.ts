import type { AuthoritySubject, OrgScope } from '../auth/authority';

/**
 * What waits on you.
 *
 * The attention panel is a **query, not a message**. Nothing is stored, so
 * nothing can go stale and nothing needs cleaning up. A row exists while the
 * document behind it stands in a state this person can move; when the document
 * moves, the row is simply no longer in the answer.
 *
 * This is deliberately a different mechanism from the notification inbox
 * (Phase 7). Notifications are stored messages about things that happened;
 * attention is a live question about things that are waiting. They must not be
 * merged — a notification you can dismiss, attention you can only clear by
 * doing the work.
 */

/**
 * One thing waiting on one person.
 */
export interface AttentionRow {
  /** The source that produced it, which is also the capability that lets you act. */
  source: string;
  /** What the document is, named the way the person names it. */
  title: string;
  /** Why it is waiting, and what is needed. */
  detail: string;
  /** A deep link straight to the document, not to a list. */
  href: string;
  /** `YYYY-MM-DD`. What the panel ages by, and sorts by. */
  waitingSince: string;
  /**
   * The places this work could be acted on.
   *
   * Several where the document genuinely spans them — a purchase requisition
   * whose items name two plants is real work for a manager holding either one.
   * The panel keeps the row if the person can act in **any** of them.
   *
   * Absent or empty means the source could not name a place. That is not
   * "everywhere": it is shown only to somebody whose grant names nowhere
   * either. Failing closed here is the whole point of the multi-plant case.
   */
  orgs?: OrgScope[];
  /**
   * Set only where the source itself knows the work is stuck rather than merely
   * old. There are no age thresholds in this phase — `waitingSince` carries the
   * age and the reader decides. When the customer chooses thresholds, they
   * belong here, computed from `waitingSince` in one place.
   */
  severity?: 'BLOCKED' | 'DUE' | 'OPEN';
}

/**
 * One kind of work the panel knows how to ask about.
 *
 * `code` is the capability that lets a person act on the rows this source
 * returns — not a label, not a role name. That is what makes the gating honest:
 * the panel asks the same question the screen will ask when the person clicks
 * through, so it can never offer work the screen would then refuse.
 */
export interface AttentionSource {
  /** The capability that lets the user act on what this source finds. */
  code: string;
  /**
   * An i18n key, not a word. The registry is data and a screen may not carry a
   * hardcoded label, so the panel resolves the heading at render time.
   */
  label: string;
  /**
   * What is waiting, for this person, on this day.
   *
   * Sources return everything the tenant has, unfiltered by organisation. The
   * panel narrows afterwards, in memory, against grants it has already loaded —
   * so a source never has to know how authority works.
   */
  due(who: AuthoritySubject, asOf: string): Promise<AttentionRow[]>;
}

/**
 * One source's rows, capped for display.
 */
export interface AttentionGroup {
  source: string;
  label: string;
  /** The oldest `ATTENTION_VISIBLE` rows. */
  rows: AttentionRow[];
  /** How many there are in total, before the cap. */
  total: number;
  /** How many are hidden behind the cap. */
  more: number;
}
