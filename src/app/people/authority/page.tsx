import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { AUTHORITY_ROUTE, AUTHORITY_VIEW_CAPABILITY } from '@/modules/people/schema';
import { authorityChartFor } from '@/modules/people/authority-chart';
import Authority from './Authority';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * The organisation chart of authority.
 *
 * The screen exists so that a superior can see the shape of the authority in
 * front of them *before* creating a delegation: where each person stands, what
 * they hold, at which level it applies, and what is already delegated. Building
 * delegation first would ask a superior to approve a transfer of authority they
 * cannot see.
 *
 * Two things about the read are worth stating because they are easy to get
 * wrong. First, the set of people is not a parameter — it is derived from the
 * viewer's own positions, so a hand-written `?user=` cannot widen the screen
 * beyond their reporting line. Second, seeing nothing is a valid answer rather
 * than a fault: authority here runs through positions, and someone standing
 * outside the structure has no line to read.
 */
export default async function PeopleAuthorityPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const session = await requireSession(AUTHORITY_ROUTE);
  const params = await searchParams;
  const wanted = (params.user ?? '').trim();
  const chart = await authorityChartFor(
    session.user.client,
    session.user.userId,
    wanted || undefined,
  );

  return (
    <Page
      title="Authority" code={AUTHORITY_VIEW_CAPABILITY}
      description="Who holds what, at which level, and where they stand. This shows your own reporting line and nobody else’s — the people you can see are the people in the positions beneath yours. Delegation does not exist yet; the panels for it are here, empty, so that what gets built next has a place to land."
      actions={
        <>
          <Link
                        href="/people/organization"
                        className="btn btn-default min-h-11 sm:min-h-8"
                      >
                        Organization
                      </Link>
          <Link
                        href="/people/assignments"
                        className="btn btn-default min-h-11 sm:min-h-8"
                      >
                        Assignments
                      </Link>
        </>
      }
    >
      <Authority
        chart={chart}
        selectedUserId={wanted}
        canMaintain={can(session, 'PEOPLE.POSITION.CREATE')}
      />
    </Page>
  );
}
