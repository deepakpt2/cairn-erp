/**
 * The identity a background job acts as.
 *
 * A job never holds a session or a copy of the user's capabilities. It holds the durable user id
 * of whoever submitted it (`job_run.triggered_by`) and, every time it is about to do work, asks the
 * same authority engine `can()` uses whether that user may still do it: active, not locked, a
 * current grant, inside their organisational restrictions. A user who has since been deactivated,
 * locked, or stripped of the grant fails closed. The result carries the username so audit columns
 * (`changed_by`) name the person, not the worker.
 */
import { and, eq } from 'drizzle-orm';

import { canTx, type OrgScope } from '../auth/authority';
import type { Tx } from '../db/client';
import { appUser } from '../tables/security';

export class JobActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobActorError';
  }
}

export interface JobActor {
  id: string;
  username: string;
}

/** The submitting user, if they are still an active, unlocked user of this tenant. */
export async function loadJobActor(tx: Tx, client: string, userId: string): Promise<JobActor> {
  const [user] = await tx
    .select({ id: appUser.id, username: appUser.username, isActive: appUser.isActive, isLocked: appUser.isLocked })
    .from(appUser)
    .where(and(eq(appUser.client, client), eq(appUser.id, userId)))
    .limit(1);
  if (!user) throw new JobActorError('The user who submitted this run no longer exists.');
  if (!user.isActive) throw new JobActorError(`The user ${user.username} who submitted this run is no longer active.`);
  if (user.isLocked) throw new JobActorError(`The user ${user.username} who submitted this run is locked.`);
  return { id: user.id, username: user.username };
}

/** Current grant and organisational scope, at the moment of the call. Throws when refused. */
export async function assertActorCan(
  tx: Tx,
  client: string,
  actor: JobActor,
  capability: string,
  org: OrgScope = {},
): Promise<void> {
  if (!(await canTx(tx, client, actor.id, capability, org))) {
    const where = Object.entries(org).map(([k, v]) => `${k} ${v}`).join(', ');
    throw new JobActorError(
      `${actor.username} no longer holds ${capability}${where ? ` for ${where}` : ''}.`,
    );
  }
}
