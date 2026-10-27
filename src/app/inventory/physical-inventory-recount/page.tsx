import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { t } from '@/platform/i18n';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import {
  PHYSICAL_INVENTORY_RECOUNT_CAPABILITY,
  PHYSICAL_INVENTORY_RECOUNT_ROUTE,
  getRecountSource,
} from '@/modules/inventory/physical-inventory-recount';
import RecountWorkbench from './RecountWorkbench';
import { displayOnlyRemedy } from '@/ui/lock/remedy';

export const dynamic = 'force-dynamic';

const ROUTE = PHYSICAL_INVENTORY_RECOUNT_ROUTE;

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

/**
 * Recount — SCR-150.
 *
 * The search alias stays in the catalogue. This screen creates a new document for the items
 * the person selects. It does not enter the recount quantity, post a difference, or reverse.
 */
export default async function PhysicalInventoryRecountPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const documentNumber = last(params.doc).toUpperCase();
  const fiscalYear = Number(last(params.year) || '0');
  const document = documentNumber && fiscalYear
    ? await getRecountSource(session.user.client, { documentNumber, fiscalYear })
    : null;
  const today = new Date().toISOString().slice(0, 10);
  const canRecount = can(session, PHYSICAL_INVENTORY_RECOUNT_CAPABILITY);
  const recountKey = document ? `${document.documentNumber.trim()}/${document.fiscalYear}` : '';
  const changeLock = document && canRecount
    ? await openChangeForSession(session, {
        lockObject: 'PHYSICAL_INVENTORY',
        argument: recountKey,
        transactionCode: 'INV.PHYINV.RECOUNT',
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('recount.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('recount.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/inventory/physical-inventory-differences" className="btn btn-default min-h-11 sm:min-h-8">
              {t('recount.toList')}
            </Link>
            <Link href="/inventory/physical-inventory-count" className="btn btn-default min-h-11 sm:min-h-8">
              {t('recount.toCounts')}
            </Link>
            <Link href="/inventory/physical-inventory" className="btn btn-default min-h-11 sm:min-h-8">
              {t('recount.toDocuments')}
            </Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('recount.subtitle')}</p>
      </header>

      {document && changeLock?.mode === 'CHANGE' && (
        <ChangeLock lockObject="PHYSICAL_INVENTORY" argument={recountKey} />
      )}
      <LockNotice message={changeLock?.mode === 'DISPLAY' ? displayOnlyMessage(changeLock) : null} remedy={displayOnlyRemedy(changeLock)} />
      <RecountWorkbench
        document={document}
        requestedNumber={documentNumber}
        requestedYear={last(params.year)}
        canRecount={canRecount}
        displayOnly={changeLock?.mode === 'DISPLAY'}
        today={today}
      />
    </div>
  );
}
