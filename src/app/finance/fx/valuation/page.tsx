import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { FX_VALUATION_CAPABILITY, type FxValuationResult } from '@/modules/finance/fx-valuation';
import ValuationForm from './ValuationForm';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/fx/valuation';

/**
 * Foreign currency valuation (SCR-098 / FAGL_FC_VAL as a search
 * alias only).
 */
export default async function FxValuationPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const get = (name: string) => params[name]?.trim() ?? '';
  const executed = params.run === '1';
  const defaults = {
    companyCode: get('companyCode'),
    valuationArea: get('valuationArea') || 'LOCAL',
    valuationKeyDate: get('valuationKeyDate'),
    postingDate: get('postingDate'),
    fiscalYear: get('fiscalYear'),
    valuationMethod: get('valuationMethod') || 'AVERAGE',
    includeOpenItems: executed ? params.openItems === 'on' : true,
    includeBalances: executed ? params.balances === 'on' : true,
    testRun: executed ? params.testRun === 'on' : true,
    documentType: get('documentType'),
    reversalDate: get('reversalDate'),
  };
  const result: FxValuationResult | null = null;
  const requestKey = get('requestKey') || `fx-${Date.now().toString(36)}`;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.FX.VALUATE · FAGL_FC_VAL</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('fxValuation.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('fxValuation.subtitle')}</p>
      </header>
      <ValuationForm
        canExecute={can(session, FX_VALUATION_CAPABILITY)}
        defaults={defaults}
        result={result}
        requestKey={requestKey}
      />
    </div>
  );
}
