import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import Requisitions from './Requisitions';

export const dynamic = 'force-dynamic';

const ROUTE = '/purchasing/requisitions';

/**
 * Purchase requisitions (SCR-055 / ME51N; inert since stage 1).
 *
 * The item-level requisition document: an item grid with per-item
 * account assignment, created and changed against the standing masters
 * (SCR-055 stage 3 wires the acts).
 */
export default async function PurchaseRequisitionsPage() {
  await requireSession(ROUTE);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROC.PR.CREATE · ME51N</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('purchaseRequisition.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('purchaseRequisition.subtitle')}</p>
      </header>

      <Requisitions />
    </div>
  );
}
