'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import { recomputeActivityStatus } from '@/platform/tenancy/config-activity-status';

/**
 * Settle the checklist against what the tenant actually holds, from the workbench.
 *
 * Any signed-in user of the tenant may ask, because the answer is read from the
 * tenant's own configuration: it marks a step complete only when the rows that step
 * defines are standing, and it never un-completes anything. It grants no capability
 * and posts nothing.
 */
export async function recheckConfigurationStatusAction(): Promise<void> {
  const session = await requireSession('/config');
  await recomputeActivityStatus({ client: session.user.client, by: session.user.username });
  revalidatePath('/config');
}
