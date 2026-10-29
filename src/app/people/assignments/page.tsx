import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ASSIGNMENT_CAPABILITY,
  ASSIGNMENT_ROUTE,
  AssignmentError,
  assignmentsOf,
  listAssignments,
  openAssignmentOf,
  type AssignmentView,
} from '@/modules/people/assignment';
import { listPositions } from '@/modules/people/org-structure';
import { dateParam, endedAssignmentMessage } from './copy';
import Assignments from './Assignments';

export const dynamic = 'force-dynamic';

/**
 * Assignments: who stands in which position, whose cost centre carried them, from when to when.
 *
 * This is §8.10's `position_assignment` and §15.1's "Position → cost centre → employee, with validity dates".
 * Three things about it are the design's rather than this screen's, and each changes what a clerk can do here:
 *
 * **A change is a new dated assignment.** There is no "edit the cost centre" that rewrites history: the open
 * assignment is ended with a last day and the next one starts the day after, so any past date still reads back
 * as it was then. Correcting the values of the assignment that is *still open* is allowed — the person was put
 * in the wrong position yesterday and nothing has built on it yet — and only that.
 *
 * **One employee, one assignment, per day.** The span of a new assignment may not overlap the one standing, and
 * an employee cannot hold two positions at once with a percentage beside each. That split is how a shared
 * person is really charged, and it is left unbuilt because no rule in this design says how it divides; two
 * roles at different times are written as two spans, one ending the day before the other starts.
 *
 * **The cost centre is named, not posted.** Choosing it here is what a payroll posting will one day charge
 * (§15.2), and it charges nothing now: payroll is posting-side only and waits on a result that does not exist
 * (D-013, R-11, §15.3). The assignment is checked against the cost centre master as of its first day, because
 * that master is itself dated.
 */
export default async function PeopleAssignmentsPage({ searchParams }: {
  searchParams: Promise<{
    employee?: string;
    position?: string;
    q?: string;
    open?: string;
    /** Set by the end-assignment redirect: the span's first day, so the confirmation can name it. */
    ended?: string;
    /** Its new last day. */
    to?: string;
  }>;
}) {
  const session = await requireSession(ASSIGNMENT_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const employee = (params.employee ?? '').trim().toUpperCase();
  const positionCode = (params.position ?? '').trim().toUpperCase();
  const query = (params.q ?? '').trim();
  const openOnly = params.open === '1';

  const [rows, positions] = await Promise.all([
    listAssignments({ client, query, positionCode: positionCode || undefined, openOnly }),
    listPositions(client),
  ]);

  // An unknown personnel number is a refusal, not an empty history: read it as the screen's own message, so a
  // stale link says what is missing instead of dying on the service's error.
  let history: AssignmentView[] = [];
  let note: string | undefined;
  let remedy: string | undefined;
  let open: AssignmentView | null = null;
  if (employee !== '') {
    try {
      [history, open] = await Promise.all([assignmentsOf(client, employee), openAssignmentOf(client, employee)]);
    } catch (error) {
      if (!(error instanceof AssignmentError)) throw error;
      note = error.message;
      remedy = error.remedy;
    }
  }

  // A confirmation the standing panel cannot carry: ending an assignment leaves no open span to stand in, so
  // the action redirects with the dates and the screen says the sentence above the history. Both are held to
  // the shape of a date before they are read back at all — a parameter is not allowed to become a message.
  const ended = dateParam(params.ended);
  const endedOn = dateParam(params.to);
  const confirmed =
    employee !== '' && ended !== undefined && endedOn !== undefined
      ? endedAssignmentMessage(ended, endedOn)
      : undefined;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ASSIGNMENT_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Assignments</h1>
          <div className="flex gap-2">
            <Link href="/people/organization" className="btn btn-default min-h-11 sm:min-h-8">Organisation</Link>
            <Link href="/people/employees" className="btn btn-default min-h-11 sm:min-h-8">Employees</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          An assignment says which position a person held and which cost centre carried them, for a span of
          dates. A change ends the open assignment the day before and starts a new one; nothing here is
          overwritten, and nothing is posted to the cost centre named. A person in two positions at once is not
          modelled — write two spans instead, and see the screen notes for why the split is left open.
        </p>
      </header>
      <Assignments
        assignments={rows}
        history={history}
        open={open}
        positions={positions}
        employee={employee}
        query={query}
        positionCode={positionCode}
        openOnly={openOnly}
        note={note}
        remedy={remedy}
        confirmed={confirmed}
        canWrite={can(session, ASSIGNMENT_CAPABILITY)}
      />
    </div>
  );
}
