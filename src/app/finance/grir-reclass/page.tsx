
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  GRIR_RECLASS_CAPABILITY, GrIrReclassError, executeGrIrAnalysis, type GrIrResult,
} from '@/modules/finance/grir-reclass';
import GrIrForm from './GrIrForm';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/grir-reclass';

/**
 * GR/IR clearing account analysis (SCR-099 / F.19 as a search
 * alias only).
 */
export default async function GrIrReclassPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const get = (name: string) => params[name]?.trim() ?? '';
  const executed = params.run === '1';
  const defaults = {
    companyCode: get('companyCode'),
    keyDate: get('keyDate'),
    purchaseOrderFrom: get('purchaseOrderFrom'),
    purchaseOrderTo: get('purchaseOrderTo'),
    postingDateFrom: get('postingDateFrom'),
    postingDateTo: get('postingDateTo'),
    displayVariant: get('displayVariant'),
    testRun: executed ? params.testRun === 'on' : true,
    createAccruals: executed ? params.createAccruals === 'on' : false,
    postingDate: get('postingDate'),
    reversalDate: get('reversalDate'),
    accrualDocumentType: get('accrualDocumentType'),
    accrualAccount: get('accrualAccount'),
  };
  let result: GrIrResult | null = null;
  let error: string | null = null;
  const requestKey = get('requestKey') || `grir-${Date.now().toString(36)}`;
  if (can(session, GRIR_RECLASS_CAPABILITY) && executed && defaults.companyCode && defaults.keyDate) {
    try {
      result = await executeGrIrAnalysis({
        client: session.user.client, changedBy: session.user.username,
        selection: {
          companyCode: defaults.companyCode, keyDate: defaults.keyDate,
          purchaseOrderFrom: defaults.purchaseOrderFrom || undefined,
          purchaseOrderTo: defaults.purchaseOrderTo || undefined,
          postingDateFrom: defaults.postingDateFrom || undefined,
          postingDateTo: defaults.postingDateTo || undefined,
          displayVariant: defaults.displayVariant || undefined,
          testRun: defaults.testRun, createAccruals: defaults.createAccruals,
          postingDate: defaults.postingDate || undefined,
          reversalDate: defaults.reversalDate || undefined,
          accrualDocumentType: defaults.accrualDocumentType || undefined,
          accrualAccount: defaults.accrualAccount || undefined,
          requestKey,
        },
      });
    } catch (e) {
      if (e instanceof GrIrReclassError) error = e.message;
      else throw e;
    }
  }

  return (
    <Page
      title={t('grir.title')} code="FIN.GRIR.RECLASS · F.19" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('grir.subtitle')}
    >
      {error && (
        <p role="alert" className="rounded border border-signal-error/40 bg-signal-error-soft px-3 py-2 text-sm text-signal-error">{error}</p>
      )}
      <GrIrForm
        canExecute={can(session, GRIR_RECLASS_CAPABILITY)}
        defaults={defaults}
        result={result}
        requestKey={requestKey}
      />
    </Page>
  );
}
