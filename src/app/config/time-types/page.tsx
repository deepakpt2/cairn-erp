import { can, requireSession } from '@/platform/auth/current';
import { LEAVE_ASSIGN, LEAVE_CONFIGURE, isLeaveError } from '@/modules/people/leave-access';
import { listLeaveAssignments, listLeaveGroups, listLeavePolicies } from '@/modules/people/leave-policy';
import { listTimeTypes } from '@/modules/people/time-leave';
import { withTenant } from '@/platform/db/client';
import { tenantToday } from '@/modules/people/leave-ledger';
import { Page } from '@/ui/kit';
import TimeTypes from './TimeTypes';

export const dynamic = 'force-dynamic';
const ROUTE = '/config/time-types';

/** A section the caller may not read comes back empty with the reason, never as an error page. */
async function section<T>(run: () => Promise<T>, empty: T): Promise<{ data: T; note: string | null }> {
  try { return { data: await run(), note: null }; } catch (e) {
    if (isLeaveError(e)) return { data: empty, note: e.message };
    throw e;
  }
}

/**
 * Time types and leave policies: the one configuration screen for what leave exists, how it accrues (versioned
 * policies), and who gets which policy (a group or one person; a person overrides the group on overlapping dates).
 * Authority is judged by the leave services on the live session; the buttons here only reflect it.
 */
export default async function TimeTypesPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const access = { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } };
  const [types, policies, groups, assignments, today] = await Promise.all([
    listTimeTypes(client),
    section(() => listLeavePolicies(client, access), []),
    section(() => listLeaveGroups(client, access), []),
    section(() => listLeaveAssignments(client, access), []),
    withTenant(client, (tx) => tenantToday(tx, client)).then((r) => r.today).catch(() => new Date().toISOString().slice(0, 10)),
  ]);
  return (
    <Page
      title="Time types &amp; leave policies" code={`${LEAVE_CONFIGURE} · ${LEAVE_ASSIGN}`}
      description="Define the time types, versioned leave policies (monthly accrual, partial-month rule, paid-to-unpaid fallback), leave groups, and which policy applies to a group or a person. A person's own assignment overrides the group's on the dates they overlap; overlaps within one subject are refused."
    >
      <TimeTypes
        timeTypes={types} policies={policies.data} groups={groups.data} assignments={assignments.data}
        notes={[policies.note, groups.note, assignments.note].filter((n): n is string => n !== null)}
        today={today} canConfigure={can(session, LEAVE_CONFIGURE)} canAssign={can(session, LEAVE_ASSIGN)}
      />
    </Page>
  );
}
