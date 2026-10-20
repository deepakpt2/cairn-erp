import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { REVERSE_CAPABILITY, getReversalDocument } from '@/modules/inventory/material-document-reversal';
import Reversal from './Reversal';

export const dynamic = 'force-dynamic';

const ROUTE = '/inventory/reversal';

/**
 * Material document reversal (SCR-132 / MBST as a search alias only).
 *
 * Look up a document by number and fiscal year, read its lines and the quantity
 * each one still has open, and reverse the whole document or the lines chosen.
 * A document is cancelled once: the status is the cancellation flag, and a
 * partly reversed document says so.
 */
export default async function ReversalPage({ searchParams }: {
  searchParams: Promise<{ doc?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const document = params.doc ? await getReversalDocument(session.user.client, params.doc) : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('mbst.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('mbst.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('mbst.subtitle')}</p>
      </header>

      <Reversal document={document} canPost={can(session, REVERSE_CAPABILITY)} today={today} />
    </div>
  );
}
