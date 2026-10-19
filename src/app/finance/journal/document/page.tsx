import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { DOCUMENT_FLOW_CAPABILITY } from '@/modules/finance/document-display';
import DocumentDisplay from './DocumentDisplay';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/journal/document';

/**
 * Accounting document display with flow (SCR-090 / FB03 as a
 * search alias only). Stage 1 shell: retrieval lands in stage 3
 * of R-138.
 */
export default async function JournalDocumentPage() {
  const session = await requireSession(ROUTE);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.DOC.FLOW · FB03</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('documentDisplay.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('documentDisplay.subtitle')}</p>
      </header>

      <DocumentDisplay
        document={null}
        parkedNumber={null}
        notFound={false}
        canDisplay={can(session, DOCUMENT_FLOW_CAPABILITY)}
      />
    </div>
  );
}
