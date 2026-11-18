
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  FX_VALUATION_CAPABILITY, FxValuationError, executeFxValuation,
  type FxRateType, type FxValuationResult,
} from '@/modules/finance/fx-valuation';
import ValuationForm from './ValuationForm';
import { Page } from '@/ui/kit';

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
  let result: FxValuationResult | null = null;
  let error: string | null = null;
  const requestKey = get('requestKey') || `fx-${Date.now().toString(36)}`;
  if (can(session, FX_VALUATION_CAPABILITY) && executed && defaults.companyCode && defaults.valuationKeyDate && defaults.postingDate && defaults.fiscalYear && defaults.documentType) {
    try {
      result = await executeFxValuation({
        client: session.user.client, changedBy: session.user.username,
        selection: {
          companyCode: defaults.companyCode,
          valuationArea: defaults.valuationArea,
          valuationKeyDate: defaults.valuationKeyDate,
          postingDate: defaults.postingDate,
          fiscalYear: Number(defaults.fiscalYear),
          valuationMethod: defaults.valuationMethod as FxRateType,
          includeOpenItems: defaults.includeOpenItems,
          includeBalances: defaults.includeBalances,
          testRun: defaults.testRun,
          documentType: defaults.documentType,
          reversalDate: defaults.reversalDate || undefined,
          requestKey,
        },
      });
    } catch (e) {
      if (e instanceof FxValuationError) error = e.message;
      else throw e;
    }
  }

  return (
    <Page
      title={t('fxValuation.title')} code="FIN.FX.VALUATE · FAGL_FC_VAL" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('fxValuation.subtitle')}
    >
      {error && (
        <p role="alert" className="rounded border border-signal-error/40 bg-signal-error-soft px-3 py-2 text-sm text-signal-error">{error}</p>
      )}
      <ValuationForm
        canExecute={can(session, FX_VALUATION_CAPABILITY)}
        defaults={defaults}
        result={result}
        requestKey={requestKey}
      />
    </Page>
  );
}
