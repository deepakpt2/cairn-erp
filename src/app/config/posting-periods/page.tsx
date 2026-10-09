import Link from 'next/link';
import { t } from '@/platform/i18n';
import { listPeriodRules } from '@/modules/foundation/services';
import { savePeriodRule } from './actions';
import { PeriodRules } from './PeriodRules';
import { can, requireSession } from '@/platform/auth/current';

export const dynamic = 'force-dynamic';

/**
 * Posting periods — CFG.FIN.PPV.DEFINE / FIN.CLOSE.PERIOD
 *
 * The screen where a user decides what the books will accept. It reads the
 * company code's posting period variant, so what is shown is what the posting
 * engine will actually enforce — the two cannot disagree.
 */
export default async function PostingPeriodsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; company?: string }>;
}) {
  const params = await searchParams;
  // The tenant comes from the session, never from the query string. A `?client=`
  // override here would let a signed-in user of one tenant read another's books.
  const session = await requireSession();
  const client = session.user.client;

  const { listCompanyCodes } = await import('@/modules/foundation/services');
  const companies = await listCompanyCodes(client);
  const companyCodeKey = params.company ?? companies[0]?.companyCode;

  if (!companyCodeKey) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="panel p-8 text-center text-sm text-ink-soft">
          No company code exists in tenant {client}.
        </div>
      </div>
    );
  }

  const fiscalYear = new Date().getUTCFullYear();
  const status = await listPeriodRules(client, companyCodeKey, fiscalYear);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-4 border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.CLOSE.PERIOD</span>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{t('pp.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('pp.subtitle')}</p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-2xs uppercase tracking-wide text-ink-faint">
            {t('cc.code')}
          </span>
          {companies.map((company) => (
            <Link
              key={company.companyCode}
              href={`/config/posting-periods?company=${company.companyCode}`}
              className={`chip ${company.companyCode === companyCodeKey ? 'chip-info' : 'chip-neutral'}`}
            >
              {company.companyCode} · {company.name}
            </Link>
          ))}
        </div>
      </header>

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Summary label={t('journal.period')} value={`${fiscalYear}`} />
        <Summary label={t('cc.fyv')} value={status.fiscalYearVariant} />
        <Summary label={t('cc.ppv')} value={status.postingPeriodVariant} />
        <Summary
          label={t('pp.openRange')}
          value={`1–${status.regularPeriods} + ${status.specialPeriods}`}
        />
      </div>

      <PeriodRules
        canEdit={can(session, "FIN.CLOSE.PERIOD")}
        variant={status.postingPeriodVariant}
        rules={status.rules}
        regularPeriods={status.regularPeriods}
        specialPeriods={status.specialPeriods}
        onSave={savePeriodRule}
      />
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel p-3">
      <p className="text-2xs uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="mt-0.5 text-base font-semibold code">{value}</p>
    </div>
  );
}
