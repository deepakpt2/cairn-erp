import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  listSchedulingAgreementReleases,
  RELEASE_CREATE_CAPABILITY,
  RELEASE_ROUTE,
} from '@/modules/purchasing/scheduling-agreement-release';
import ReleaseForm from './ReleaseForm';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** ME84. Creates release snapshots. It does not post or notify the supplier. */
export default async function SchedulingAgreementReleasesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(RELEASE_ROUTE);
  if (!can(session, RELEASE_CREATE_CAPABILITY)) {
    return (
      <Page
      title="Scheduling agreement releases" width="3xl" back={null}
    >
        <p className="mt-2 text-sm">You do not hold the scheduling-agreement release capability (PROC.SARELEASE.CREATE).</p>
      </Page>
    );
  }
  const agreement = last((await searchParams).agreement);
  const history = agreement ? await listSchedulingAgreementReleases(session.user.client, agreement, { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => []) : [];

  return (
    <Page
      title="Create scheduling agreement releases" code="PROC.SARELEASE.CREATE · ME84" width="5xl"
      description="ME84 creates a forecast or JIT release from the delivery schedule. It does not change the schedule lines, create a purchase order, post stock, or send a supplier message. ME38 maintains the schedule. ME39 displays it. ME83 and ME88 are not this screen."
    >
      <ReleaseForm agreement={agreement} />
      {agreement && (
        <section className="space-y-2 text-sm">
          <h2 className="font-semibold">Release history · {agreement}</h2>
          {history.length === 0 && <p>No release is stored for this agreement.</p>}
          {history.map((row) => (
            <article key={row.releaseNumber} className="border-b border-line py-2">
              <p>
                {row.releaseNumber} · item {row.itemNumber} · {row.releaseType} · {row.generationDate} · {row.releasedQuantity}
              </p>
              <p>{row.transmissionStatus}. {row.transmissionDetail}</p>
              <ul>
                {row.lines.map((line) => (
                  <li key={line.lineNumber}>{line.deliveryDate} · {line.quantity} {line.unit}</li>
                ))}
              </ul>
              <p>
                <Link className="underline" href={`/purchasing/scheduling-agreements?agreement=${encodeURIComponent(row.agreementNumber)}`}>ME32L</Link>
                {' · '}
                <Link className="underline" href={`/purchasing/delivery-schedule?agreement=${encodeURIComponent(row.agreementNumber)}&item=${row.itemNumber}`}>ME38</Link>
                {' · '}
                <Link className="underline" href={`/purchasing/delivery-schedule-display?agreement=${encodeURIComponent(row.agreementNumber)}&item=${row.itemNumber}`}>ME39</Link>
              </p>
            </article>
          ))}
        </section>
      )}
    </Page>
  );
}
