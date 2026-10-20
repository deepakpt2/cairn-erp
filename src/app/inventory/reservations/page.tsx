import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  RESERVATION_CREATE_CAPABILITY,
  RESERVATION_SCENARIOS,
  getReservation,
} from '@/modules/inventory/reservations';
import Reservations from './Reservations';

export const dynamic = 'force-dynamic';

const ROUTE = '/inventory/reservations';

/**
 * Reservations (SCR-133 / MB21 as a search alias only).
 *
 * A reservation is a demand nobody has posted: a planned withdrawal against a
 * cost centre on a required date. It reserves nothing physically; it is the
 * requirement the stock/requirements list answers with until it is withdrawn in
 * full or completed.
 */
export default async function ReservationsPage({ searchParams }: {
  searchParams: Promise<{ reservation?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const reservation = params.reservation
    ? await getReservation(session.user.client, params.reservation)
    : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('mb21.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('mb21.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('mb21.subtitle')}</p>
      </header>

      <Reservations
        reservation={reservation}
        scenarios={RESERVATION_SCENARIOS.map((s) => ({ code: s.code, description: s.description }))}
        canPost={can(session, RESERVATION_CREATE_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
