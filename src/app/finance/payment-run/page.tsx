
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  PAYMENT_RUN_CAPABILITY, getPaymentRun, listBankChoices, listPaymentRuns,
} from '@/modules/finance/payment-run';
import { PAYMENT_RUN_RELEASE_CAPABILITY, getPaymentRunRelease } from '@/modules/finance/payment-run-release';
import { listPaymentOperations } from '@/modules/finance/payment-run-background';
import PaymentRun from './PaymentRun';
import { Page } from '@/ui/kit';

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
  const operation = run ? ((await listPaymentOperations(client, run.runDate, run.runId, 1))[0] ?? null) : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('paymentRun.title')} code="FIN.AP.PAYMENTRUN.EXECUTE · F110" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('paymentRun.subtitle')}
    >

      <PaymentRun
        run={run}
        runs={runs}
        banks={banks}
        canExecute={can(session, PAYMENT_RUN_CAPABILITY)}
        release={release}
        canRelease={can(session, PAYMENT_RUN_RELEASE_CAPABILITY)}
        today={today}
        operation={operation}
      />
    </Page>
  );
}
