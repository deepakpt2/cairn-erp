import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { REVERSE_CAPABILITY } from '@/modules/inventory/material-document-reversal';
import {
  PHYSICAL_INVENTORY_DIFF_POST_CAPABILITY,
  PHYSICAL_INVENTORY_DIFF_POST_ROUTE,
  getDifferencePosting,
  getPostingHistory,
} from '@/modules/inventory/physical-inventory-posting';
import PostingWorkbench from './PostingWorkbench';

export const dynamic = 'force-dynamic';

const ROUTE = PHYSICAL_INVENTORY_DIFF_POST_ROUTE;

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

/**
 * Difference posting — SCR-149.
 *
 * The search alias stays in the catalogue. This screen posts the items the person selects,
 * through the service, and it does not reverse unless the person holds the reversal capability.
 */
export default async function PhysicalInventoryPostingPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const documentNumber = last(params.doc).toUpperCase();
  const fiscalYear = Number(last(params.year) || '0');
  const client = session.user.client;
  const document = documentNumber && fiscalYear
    ? await getDifferencePosting(client, { documentNumber, fiscalYear })
    : null;
  const history = document
    ? await getPostingHistory(client, { documentNumber: document.documentNumber, fiscalYear: document.fiscalYear })
    : [];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('diffpost.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('diffpost.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/inventory/physical-inventory-differences" className="btn btn-default min-h-11 sm:min-h-8">
              {t('diffpost.toList')}
            </Link>
            <Link href="/inventory/physical-inventory-count" className="btn btn-default min-h-11 sm:min-h-8">
              {t('diffpost.toCounts')}
            </Link>
            <Link href="/inventory/physical-inventory" className="btn btn-default min-h-11 sm:min-h-8">
              {t('diffpost.toDocuments')}
            </Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('diffpost.subtitle')}</p>
      </header>

      <PostingWorkbench
        document={document}
        history={history}
        requestedNumber={documentNumber}
        requestedYear={last(params.year)}
        canPost={can(session, PHYSICAL_INVENTORY_DIFF_POST_CAPABILITY)}
        canReverse={can(session, REVERSE_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
