import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  DOCUMENT_FLOW_CAPABILITY, DocumentDisplayError, FIN_JOURNAL_DISPLAY_CAPABILITY,
  getJournalDocument, resolveDocumentNumber, type JournalDocumentView,
} from '@/modules/finance/document-display';
import DocumentDisplay from './DocumentDisplay';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/journal/document';

/**
 * Accounting document display with flow (SCR-090 / FB03 as a
 * search alias only).
 */
export default async function JournalDocumentPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  // FB03 shows the document (FIN.JOURNAL.DISPLAY); the flow around it is a second
  // question with a second capability (FIN.DOC.FLOW) — a reader may hold one alone.
  const canDisplay = can(session, FIN_JOURNAL_DISPLAY_CAPABILITY);
  const canFlow = can(session, DOCUMENT_FLOW_CAPABILITY);
  let document: JournalDocumentView | null = null;
  let parkedNumber: string | null = null;
  let notFound = false;
  let mismatch: string | null = null;
  let error: string | null = null;
  if (params.document && canDisplay) {
    try {
      let company = params.company ?? '';
      let year = params.year ? Number(params.year) : NaN;
      if (!params.company || !params.year) {
        const resolved = await resolveDocumentNumber(session.user.client, params.document);
        if (resolved) {
          company = resolved.companyCode;
          year = resolved.fiscalYear;
        }
      }
      if (company && Number.isInteger(year)) {
        const lookup = await getJournalDocument(session.user.client, {
          documentNumber: params.document, companyCode: company, fiscalYear: year,
        });
        if (lookup.kind === 'FOUND') document = lookup.document;
        else if (lookup.kind === 'PARKED') parkedNumber = lookup.parkedNumber;
        else if (lookup.kind === 'COMPANY_MISMATCH') {
          // SAP's own refusal: the document stands, in another company.
          mismatch = `Document ${lookup.documentNumber} does not exist in company code ${company}.`;
        } else notFound = true;
      } else {
        notFound = true;
      }
    } catch (caught) {
      error = caught instanceof DocumentDisplayError ? caught.message : 'The document could not be read.';
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.JOURNAL.DISPLAY · FB03</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('documentDisplay.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('documentDisplay.subtitle')}</p>
      </header>

      {error && (
        <p role="alert" className="rounded-card border border-line bg-surface p-4 text-sm text-red-700 shadow-card">{error}</p>
      )}
      <DocumentDisplay
        document={document}
        parkedNumber={parkedNumber}
        notFound={notFound}
        mismatch={mismatch}
        canDisplay={canDisplay}
        canFlow={canFlow}
      />
    </div>
  );
}
