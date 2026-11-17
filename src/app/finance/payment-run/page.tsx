import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  PAYMENT_RUN_CAPABILITY, getPaymentRun, listBankChoices, listPaymentRuns,
} from '@/modules/finance/payment-run';
import { PAYMENT_RUN_RELEASE_CAPABILITY, getPaymentRunRelease } from '@/modules/finance/payment-run-release';
import PaymentRun from './PaymentRun';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/payment-run';

/**
 * Payment run (SCR-063 / F110 as a search alias only).
 */
export default async function PaymentRunPage({ searchParams }: {
  searchParams: Promise<{ runDate?: string; runId?: string; run?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const [runs, banks] = await Promise.all([listPaymentRuns(client), listBankChoices(client)]);
  // `run` is the notification form, `<run date>/<run id>`; the two parameters are the screen's own.
  const [keyDate, keyId] = (params.run ?? '').split('/');
  const runDate = params.runDate ?? keyDate;
  const runId = params.runId ?? keyId;
  const run = runDate && runId ? await getPaymentRun(client, runDate, runId) : null;
  const release = run && run.status === 'PROPOSAL' ? await getPaymentRunRelease(client, run.runDate, run.runId) : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AP.PAYMENTRUN.EXECUTE · F110</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('paymentRun.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('paymentRun.subtitle')}</p>
      </header>

      <PaymentRun
        run={run}
        runs={runs}
        banks={banks}
        canExecute={can(session, PAYMENT_RUN_CAPABILITY)}
        release={release}
        canRelease={can(session, PAYMENT_RUN_RELEASE_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
