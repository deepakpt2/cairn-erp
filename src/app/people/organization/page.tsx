import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ORG_ROUTE,
  ORG_UNIT_CAPABILITY,
  POSITION_CAPABILITY,
  getOrgUnit,
  getPosition,
  getJob,
  listJobs,
  listOrgUnits,
  listPositions,
} from '@/modules/people/org-structure';
import Organization from './Organization';

export const dynamic = 'force-dynamic';

/**
 * The organisation: units, positions, jobs, the tree they stand in, and the reporting line.
 *
 * This is CAIRN.md §15.1's "Org units, positions, jobs, hierarchy, reporting line", the block §8.10 names
 * `org_unit`, `position`, `job` and `org_hierarchy`, and it is what `/people/assignments` assigns into. Two
 * shapes are worth reading before using the screen, because both are the design's and not this screen's:
 *
 * **The structure is not dated.** A unit's parent and a position's unit are edges, and an edge is written when
 * it becomes true — so a misfiled branch is moved here and the tree reads as today. §15.1 asks for validity
 * dates on the *Assignment*, and the repository dates a cost centre's attributes while keeping its tree
 * undated (drizzle/0050 and 0052), so this follows that. The consequence is stated rather than hidden: nothing
 * here can show what the structure looked like last quarter.
 *
 * **A position does not know who holds it.** There is no vacancy flag and no incumbent column to write: the
 * people standing in a position are read from their assignments as of today, so the number cannot drift away
 * from the dated record that produced it.
 *
 * What is deliberately not on this screen: a leading position, headcount planning, an org unit's assignment to
 * a company code or a default cost centre, and a reporting line between two *employees* (the line here joins
 * positions, as §15.1's row has it). None of them is in §8.10 or §15.1, and each would have to invent the rule
 * that gives it meaning. Jobs are maintained under the position authority, because §10.8 gives jobs no code of
 * their own and a fourth code invented here would be a permission nobody approved.
 */
export default async function PeopleOrganizationPage({ searchParams }: {
  searchParams: Promise<{ unit?: string; position?: string; job?: string; q?: string; tab?: string }>;
}) {
  const session = await requireSession(ORG_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const unit = (params.unit ?? '').trim().toUpperCase();
  const positionCode = (params.position ?? '').trim().toUpperCase();
  const jobCode = (params.job ?? '').trim().toUpperCase();
  const query = (params.q ?? '').trim();
  const tab = params.tab === 'positions' ? 'positions' : params.tab === 'jobs' ? 'jobs' : 'units';

  const [units, positions, jobs, selectedUnit, selectedPosition, selectedJob] = await Promise.all([
    listOrgUnits(client, query),
    listPositions(client, query),
    listJobs(client),
    unit ? getOrgUnit(client, unit) : Promise.resolve(null),
    positionCode ? getPosition(client, positionCode) : Promise.resolve(null),
    jobCode ? getJob(client, jobCode) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ORG_UNIT_CAPABILITY} · {POSITION_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Organisation</h1>
          <div className="flex gap-2">
            <Link href="/people/assignments" className="btn btn-default min-h-11 sm:min-h-8">Assignments</Link>
            <Link href="/people/employees" className="btn btn-default min-h-11 sm:min-h-8">Employees</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          Units and positions, and the two relations that place them: what hangs below what, and which position
          a position reports to. Nothing here is dated — moving a unit is a change to the structure as it
          stands, and the people in it are counted from their assignments. Writing a position or a unit posts
          nothing, and no cost centre is charged for the cost centre an assignment names.
        </p>
      </header>
      <Organization
        units={units}
        positions={positions}
        jobs={jobs}
        selectedUnit={selectedUnit}
        selectedPosition={selectedPosition}
        selectedJob={selectedJob}
        query={query}
        tab={tab}
        canMaintainUnits={can(session, ORG_UNIT_CAPABILITY)}
        canMaintainPositions={can(session, POSITION_CAPABILITY)}
      />
    </div>
  );
}
