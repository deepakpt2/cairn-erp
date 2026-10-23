import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  listSchedulingAgreementReleases,
  RELEASE_CREATE_CAPABILITY,
  RELEASE_ROUTE,
} from '@/modules/purchasing/scheduling-agreement-release';
import ReleaseForm from './ReleaseForm';

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
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Scheduling agreement releases</h1>
        <p className="mt-2 text-sm">You do not hold the scheduling-agreement release capability (PROC.SARELEASE.CREATE).</p>
      </main>
    );
  }
  const agreement = last((await searchParams).agreement);
  const history = agreement ? await listSchedulingAgreementReleases(session.user.client, agreement) : [];

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROC.SARELEASE.CREATE · ME84</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Create scheduling agreement releases</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          ME84 creates a forecast or JIT release from the delivery schedule. It does not change the schedule lines, create a purchase order, post stock, or send a supplier message. ME38 maintains the schedule. ME39 displays it. ME83 and ME88 are not this screen.
        </p>
      </header>
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
    </main>
  );
}
