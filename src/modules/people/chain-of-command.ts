/**
 * Chain of command — who a person answers to.
 *
 * The organisation is already there: `org_hierarchy` carries `REPORTS_TO` edges
 * between positions and `STRUCTURE` edges that hang a position in an org unit,
 * and `position_assignment` says who holds a position over a dated span. What
 * was missing is the join that turns those into an answer about a *person*,
 * because authority is keyed by `app_user` while the structure is keyed by
 * `personnel_number`. The bridge is `employee.app_user_id`.
 *
 * So:
 *
 *   app_user.id -> employee.app_user_id -> employee.personnel_number
 *               -> position_assignment.position_code -> position
 *               -> org_hierarchy REPORTS_TO (up) -> the position above
 *               -> who holds *that* position -> the superior
 *
 * Three things are decided here rather than left to callers.
 *
 * **The top of the tree is an org unit, not a person.** A position with no
 * `REPORTS_TO` edge is not an error, it is the top of the reporting line; its
 * superior is the org unit it hangs in, and an org unit has no holder. This is
 * why the walk terminates by construction and why a ring, if one were ever
 * written, is the only thing that could stop it - so it is guarded against
 * explicitly rather than trusted.
 *
 * **A dated question gets a dated answer.** Every lookup takes `on`, defaulting
 * to today. A person who moves next month has a different superior next month,
 * and an answer that ignores the date would be wrong twice.
 *
 * **Several positions give several answers.** The data model permits a person to
 * hold more than one position at once, and nothing here invents a "primary" to
 * hide that. `superiorOfUser` returns one answer per position held,
 * deduplicated. Delegation will have to decide which chain it means; that is
 * its decision to make, not one to bake in here before it is understood.
 */
import { sql } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import { MAX_ORG_DEPTH } from './schema';

/** One person, as authority knows them. */
export interface PositionHolder {
  userId: string;
  username: string;
  fullName: string;
  personnelNumber: string;
}

/** A position, named the way the structure names it. */
export interface PositionRef {
  code: string;
  title: string;
}

/**
 * Who a person answers to.
 *
 * `USER` - a human holds the position above.
 * `ORG_UNIT` - the reporting line ends in an org unit, which has no holder.
 * `UNATTACHED` - the person holds no position on the date asked about.
 */
export type Superior =
  | { kind: 'USER'; position: PositionRef; holder: PositionHolder }
  | { kind: 'ORG_UNIT'; position: PositionRef; orgUnitCode: string; orgUnitName: string }
  | { kind: 'UNATTACHED' };

export class ChainOfCommandError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'ChainOfCommandError';
    this.remedy = remedy;
  }
}

type Row = Record<string, unknown>;

const rows = (result: unknown): Row[] => (Array.isArray(result) ? (result as Row[]) : []);
const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/** The day asked about. Passed in so a test can name a day and mean it. */
function asOf(on?: string): string {
  return on ?? new Date().toISOString().slice(0, 10);
}

/**
 * The positions a person holds on a given day.
 *
 * Read through `employee`, because that is the only place a user and a personnel
 * number meet. A span is current when it has started and has not ended;
 * `valid_to` is inclusive, so a person does not fall out of a position on their
 * last morning.
 */
export async function positionsOfUser(
  tx: Tx,
  client: string,
  userId: string,
  on?: string,
): Promise<PositionRef[]> {
  const day = asOf(on);
  const result = await tx.execute(sql`
    select distinct a.position_code as code, p.title as title
      from position_assignment a
      join employee e
        on e.client = a.client and e.personnel_number = a.personnel_number
      join position p
        on p.client = a.client and p.code = a.position_code
     where a.client = ${client}
       and e.app_user_id = ${userId}
       and a.valid_from <= ${day}::date
       and (a.valid_to is null or a.valid_to >= ${day}::date)
     order by a.position_code
  `);
  return rows(result).map((row) => ({ code: text(row.code), title: text(row.title) }));
}

/**
 * The people holding a position on a given day.
 *
 * Active users only: a deactivated account still has a personnel number, and an
 * approval routed to someone who cannot sign in is an approval that never
 * arrives.
 */
export async function holdersOfPosition(
  tx: Tx,
  client: string,
  positionCode: string,
  on?: string,
): Promise<PositionHolder[]> {
  const day = asOf(on);
  const result = await tx.execute(sql`
    select u.id as user_id, u.username as username, u.full_name as full_name,
           a.personnel_number as personnel_number
      from position_assignment a
      join employee e
        on e.client = a.client and e.personnel_number = a.personnel_number
      join app_user u
        on u.id = e.app_user_id and u.client = a.client
     where a.client = ${client}
       and a.position_code = ${positionCode}
       and a.valid_from <= ${day}::date
       and (a.valid_to is null or a.valid_to >= ${day}::date)
       and u.is_active = true
     order by u.username
  `);
  return rows(result).map((row) => ({
    userId: text(row.user_id),
    username: text(row.username),
    fullName: text(row.full_name),
    personnelNumber: text(row.personnel_number),
  }));
}

/** The position directly above this one, or null at the top of the reporting line. */
export async function superiorPositionOf(
  tx: Tx,
  client: string,
  positionCode: string,
): Promise<PositionRef | null> {
  const result = await tx.execute(sql`
    select h.parent_code as code, p.title as title
      from org_hierarchy h
      join position p
        on p.client = h.client and p.code = h.parent_code
     where h.client = ${client}
       and h.relation_type = 'REPORTS_TO'
       and h.child_kind = 'POSITION'
       and h.child_code = ${positionCode}
  `);
  const row = rows(result)[0];
  return row ? { code: text(row.code), title: text(row.title) } : null;
}

/** The org unit a position hangs in, or null if it hangs nowhere. */
export async function orgUnitOfPosition(
  tx: Tx,
  client: string,
  positionCode: string,
): Promise<{ code: string; name: string } | null> {
  const result = await tx.execute(sql`
    select h.parent_code as code, u.name as name
      from org_hierarchy h
      join org_unit u
        on u.client = h.client and u.code = h.parent_code
     where h.client = ${client}
       and h.relation_type = 'STRUCTURE'
       and h.child_kind = 'POSITION'
       and h.child_code = ${positionCode}
  `);
  const row = rows(result)[0];
  return row ? { code: text(row.code), name: text(row.name) } : null;
}

/**
 * The reporting line above a position, nearest first, ending at the org unit the
 * topmost position hangs in.
 *
 * The walk is bounded twice. A visited set stops a ring - the edge table's key
 * makes one parent per child, but nothing in it stops A reporting to B reporting
 * to A. A depth cap stops a walk that is merely long. Both raise, because a
 * chain that cannot be walked to its end cannot answer who approves anything,
 * and returning a partial answer would be worse than refusing.
 */
export async function chainAbove(
  tx: Tx,
  client: string,
  positionCode: string,
): Promise<{ positions: PositionRef[]; orgUnit: { code: string; name: string } | null }> {
  const seen = new Set<string>([positionCode]);
  const positions: PositionRef[] = [];
  let cursor = positionCode;

  for (let step = 0; step < MAX_ORG_DEPTH; step += 1) {
    const above = await superiorPositionOf(tx, client, cursor);
    if (!above) {
      const unit = await orgUnitOfPosition(tx, client, cursor);
      return { positions, orgUnit: unit };
    }
    if (seen.has(above.code)) {
      throw new ChainOfCommandError(
        `The reporting line through ${positionCode} runs in a ring at ${above.code}.`,
        'Break the ring: a position cannot sit above itself however many steps apart. ' +
          'Correct the REPORTS_TO edges through the organisation screen.',
      );
    }
    seen.add(above.code);
    positions.push(above);
    cursor = above.code;
  }

  throw new ChainOfCommandError(
    `The reporting line above ${positionCode} runs deeper than ${MAX_ORG_DEPTH} levels.`,
    'A chain this long is almost always a ring the edge key did not catch, or a structure ' +
      'that was never meant to be one line. Review the REPORTS_TO edges.',
  );
}

/**
 * Who a person answers to.
 *
 * One answer per position held, deduplicated. The nearest position above that
 * has an active holder wins; a position held by the person themselves is stepped
 * over rather than reported as their own superior, which is what a shared or
 * doubled-up assignment would otherwise produce.
 *
 * A person with no position is `UNATTACHED` rather than an error. It is a real
 * and common state - someone who has not been assigned yet - and a caller
 * deciding whether to route an approval can act on it, which it could not do
 * with an exception.
 */
export async function superiorOfUser(
  tx: Tx,
  client: string,
  userId: string,
  on?: string,
): Promise<Superior[]> {
  const day = asOf(on);
  const held = await positionsOfUser(tx, client, userId, day);
  if (held.length === 0) return [{ kind: 'UNATTACHED' }];

  const answers: Superior[] = [];
  const claimed = new Set<string>();

  for (const start of held) {
    const { positions, orgUnit } = await chainAbove(tx, client, start.code);

    let resolved: Superior | null = null;
    for (const position of positions) {
      const holders = (await holdersOfPosition(tx, client, position.code, day))
        .filter((holder) => holder.userId !== userId);
      if (holders.length > 0) {
        resolved = { kind: 'USER', position, holder: holders[0]! };
        break;
      }
    }

    if (!resolved) {
      resolved = orgUnit
        ? {
            kind: 'ORG_UNIT',
            position: positions[positions.length - 1] ?? start,
            orgUnitCode: orgUnit.code,
            orgUnitName: orgUnit.name,
          }
        : { kind: 'UNATTACHED' };
    }

    const key =
      resolved.kind === 'USER' ? `USER:${resolved.holder.userId}`
      : resolved.kind === 'ORG_UNIT' ? `UNIT:${resolved.orgUnitCode}`
      : 'UNATTACHED';
    if (claimed.has(key)) continue;
    claimed.add(key);
    answers.push(resolved);
  }

  return answers;
}

/**
 * Every position below this one, however many steps down, nearest first.
 *
 * The inverse of `chainAbove`, and the one an escalation needs: who can act for
 * this person is the complement of who they answer to. Breadth-first, so the
 * nearest reports come back first.
 */
export async function positionsBelow(
  tx: Tx,
  client: string,
  positionCode: string,
): Promise<PositionRef[]> {
  const found: PositionRef[] = [];
  const seen = new Set<string>([positionCode]);
  let frontier = [positionCode];

  for (let depth = 0; depth < MAX_ORG_DEPTH && frontier.length > 0; depth += 1) {
    const result = await tx.execute(sql`
      select h.child_code as code, p.title as title
        from org_hierarchy h
        join position p
          on p.client = h.client and p.code = h.child_code
       where h.client = ${client}
         and h.relation_type = 'REPORTS_TO'
         and h.child_kind = 'POSITION'
         and h.parent_code in (${sql.join(frontier.map((code) => sql`${code}`), sql`, `)})
       order by h.child_code
    `);
    const next: string[] = [];
    for (const row of rows(result)) {
      const code = text(row.code);
      if (seen.has(code)) continue;
      seen.add(code);
      found.push({ code, title: text(row.title) });
      next.push(code);
    }
    frontier = next;
  }

  return found;
}
