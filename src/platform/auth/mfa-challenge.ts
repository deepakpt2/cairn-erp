/**
 * The sign-in challenge: the only thing between a correct password and a session.
 *
 * Kept apart from `mfa.ts` so `session.ts` (which `mfa.ts` itself imports) can create one
 * without a cycle. A challenge is not a session, carries no authority and grants nothing.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Tx } from '../db/client';

export const MFA_CHALLENGE_TTL_MINUTES = 5;
export const MFA_MAX_ATTEMPTS = 5;

export async function createChallenge(
  tx: Tx,
  input: { client: string; userId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<string> {
  const id = randomUUID();
  await tx.execute(sql`
    insert into mfa_challenge (id, client, user_id, expires_at, max_attempts, ip_address, user_agent, created_by)
    values (${id}, ${input.client}, ${input.userId}, now() + ${`${MFA_CHALLENGE_TTL_MINUTES} minutes`}::interval,
            ${MFA_MAX_ATTEMPTS}, ${input.ipAddress?.slice(0, 45) ?? null}, ${input.userAgent?.slice(0, 255) ?? null}, 'AUTH')
  `);
  return id;
}

/** Is two-factor demanded of everybody in this tenant? Absent means optional. */
export async function tenantRequiresMfa(tx: Tx, client: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    select flags -> 'MFA_REQUIRED' as v from client_settings where client = ${client}
  `)) as unknown as Array<{ v: unknown }>;
  return rows[0]?.v === true;
}
