import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { GRIR_RECLASS_CAPABILITY, type GrIrResult } from '@/modules/finance/grir-reclass';
import GrIrForm from './GrIrForm';

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
  const result: GrIrResult | null = null;
  const requestKey = get('requestKey') || `grir-${Date.now().toString(36)}`;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.GRIR.RECLASS · F.19</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('grir.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('grir.subtitle')}</p>
      </header>
      <GrIrForm
        canExecute={can(session, GRIR_RECLASS_CAPABILITY)}
        defaults={defaults}
        result={result}
        requestKey={requestKey}
      />
    </div>
  );
}
