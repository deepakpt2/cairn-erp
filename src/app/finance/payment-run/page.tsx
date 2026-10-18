import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  PAYMENT_RUN_CAPABILITY, getPaymentRun, listBankChoices, listPaymentRuns,
} from '@/modules/finance/payment-run';
import PaymentRun from './PaymentRun';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/payment-run';

/**
 * Payment run (SCR-063 / F110 as a search alias only).
 */
export default async function PaymentRunPage({ searchParams }: {
  searchParams: Promise<{ runDate?: string; runId?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const [runs, banks] = await Promise.all([listPaymentRuns(client), listBankChoices(client)]);
  const run = params.runDate && params.runId
    ? await getPaymentRun(client, params.runDate, params.runId)
    : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
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
        today={today}
      />
    </div>
  );
}
