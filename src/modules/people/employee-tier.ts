/**
 * Tiers: who may act on whom.
 *
 * The org chart gives every position a tier (1..9). An employee's tier is the tier of the position they hold today
 * (else the one they last held; else, while a hire is pending, the proposed position's; else 1). To add, approve,
 * assign, move or end someone, the actor's tier must be **strictly above** theirs, so an HR clerk of a plant can
 * take on staff but never a plant manager, and nobody can act on an equal or a superior.
 *
 * The actor's tier is:
 * - TOP for a user holding the ADMINISTRATOR or PLATFORM_ADMIN role (they are outside the employee group);
 * - the tier of the employee whose `app_user_id` is the user (the one explicit employee-to-user link);
 * - nothing for anyone else: a user with no linked employee cannot act on tiers, and is told so.
 *
 * Trusted in-process callers (capability lists: the demo provisioner, service tests) carry no tier limit.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';

export const TOP_TIER = 99;
export const MIN_TIER = 1;
export const MAX_TIER = 9;
export const HIRE_APPROVE_CAPABILITY = 'PEOPLE.EMPLOYEE.APPROVE';
const ADMIN_ROLES = ['ADMINISTRATOR', 'PLATFORM_ADMIN'];

export interface ActorTier {
  tier: number;
  basis: 'ADMIN' | 'EMPLOYEE' | 'UNLINKED';
  personnelNumber: string | null;
}

export async function positionTier(tx: Tx, client: string, code: string): Promise<number | null> {
  const rows = (await tx.execute(sql`select tier from position where client = ${client} and code = ${code}`)) as unknown as Array<{ tier: number }>;
  return rows[0] ? Number(rows[0].tier) : null;
}

/** An employee's tier as they stand today (see the file header). */
export async function employeeTier(tx: Tx, client: string, personnelNumber: string, today: string): Promise<number> {
  const held = (await tx.execute(sql`
    select max(p.tier)::int as tier
      from position_assignment a join position p on p.client = a.client and p.code = a.position_code
     where a.client = ${client} and a.personnel_number = ${personnelNumber}
       and a.valid_from <= ${today}::date and (a.valid_to is null or a.valid_to >= ${today}::date)
  `)) as unknown as Array<{ tier: number | null }>;
  if (held[0]?.tier != null) return Number(held[0].tier);
  const last = (await tx.execute(sql`
    select p.tier::int as tier
      from position_assignment a join position p on p.client = a.client and p.code = a.position_code
     where a.client = ${client} and a.personnel_number = ${personnelNumber} and a.valid_from <= ${today}::date
     order by a.valid_from desc limit 1
  `)) as unknown as Array<{ tier: number }>;
  if (last[0]) return Number(last[0].tier);
  const pending = (await tx.execute(sql`
    select p.tier::int as tier
      from employee e join position p on p.client = e.client and p.code = e.proposed_position_code
     where e.client = ${client} and e.personnel_number = ${personnelNumber}
  `)) as unknown as Array<{ tier: number }>;
  return pending[0] ? Number(pending[0].tier) : MIN_TIER;
}

export async function actorTier(tx: Tx, client: string, userId: string, today: string): Promise<ActorTier> {
  const admin = (await tx.execute(sql`
    select 1 from user_role ur join role r on r.client = ur.client and r.code = ur.role_code and r.is_active = true
     where ur.client = ${client} and ur.user_id = ${userId} and ur.role_code in (${sql.join(ADMIN_ROLES.map((c) => sql`${c}`), sql`, `)})
       and (ur.valid_from is null or ur.valid_from <= now()) and (ur.valid_to is null or ur.valid_to >= now()) limit 1
  `)) as unknown as unknown[];
  if (admin.length > 0) return { tier: TOP_TIER, basis: 'ADMIN', personnelNumber: null };
  const linked = (await tx.execute(sql`
    select personnel_number as pn from employee where client = ${client} and app_user_id = ${userId} and is_active = true
  `)) as unknown as Array<{ pn: string }>;
  if (linked[0]) return { tier: await employeeTier(tx, client, linked[0].pn, today), basis: 'EMPLOYEE', personnelNumber: linked[0].pn };
  return { tier: 0, basis: 'UNLINKED', personnelNumber: null };
}

/** null when the actor is above `target`; otherwise the refusal, in words the screen can show. */
export function tierRefusal(actor: ActorTier, target: number, doing: string): { message: string; remedy: string } | null {
  if (actor.tier > target) return null;
  if (actor.basis === 'UNLINKED') {
    return {
      message: `${doing} needs your user to be linked to an employee whose position has a tier above ${target}, and yours is not linked to an employee.`,
      remedy: 'Ask an administrator to link your user to your employee record (Employees screen), then try again.',
    };
  }
  return {
    message: `${doing} needs a tier above ${target}; yours is ${actor.tier}.`,
    remedy: 'Ask someone whose position has a higher tier on the org chart to do this, or to approve it.',
  };
}
