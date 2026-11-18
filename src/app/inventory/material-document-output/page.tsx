import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  MATERIAL_DOC_OUTPUT_CAPABILITY,
  MATERIAL_DOC_OUTPUT_ROUTE,
  MaterialDocumentOutputError,
  listOutputMessages,
  materialDocumentCompanyCode,
  renderSlip,
  type OutputListResult,
  type OutputSelection,
} from '@/modules/inventory/material-document-output';
import { letterheadViews } from '@/modules/output/document-layout';
import MaterialDocumentOutput from './MaterialDocumentOutput';

export const dynamic = 'force-dynamic';

/**
 * Material document output — SCR-135 / INV.MATERIALDOC.RECEIVEPRINT (MB90 as a
 * search alias only).
 *
 * The queue, its statuses and its slips. A run determines what stands missing and
 * dispatches what is pending; a row can be dispatched on its own, given a
 * recipient, or previewed.
 */
export default async function MaterialDocumentOutputPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(MATERIAL_DOC_OUTPUT_ROUTE);
  const params = await searchParams;
  const get = (name: string) => (typeof params[name] === 'string' ? (params[name] as string).trim() : '');

  const selection: OutputSelection = {
    outputType: get('outputType').toUpperCase(),
    transmissionMedium: get('transmissionMedium').toUpperCase(),
    dispatchTime: get('dispatchTime').toUpperCase(),
    status: get('status').toUpperCase(),
    documentFrom: get('documentFrom'),
    documentTo: get('documentTo'),
    documentYear: get('documentYear'),
    plantFrom: get('plantFrom'),
    plantTo: get('plantTo'),
    postingDateFrom: get('postingDateFrom'),
    postingDateTo: get('postingDateTo'),
  };

  const canRun = can(session, MATERIAL_DOC_OUTPUT_CAPABILITY);
  let result: OutputListResult | null = null;
  let listError: string | null = null;
  if (canRun) {
    try {
      result = await listOutputMessages({ client: session.user.client, selection });
    } catch (error) {
      if (error instanceof MaterialDocumentOutputError) {
        listError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
      } else {
        throw error;
      }
    }
  }

  // The preview shows what was sent when the message carries a rendering, and only otherwise reads the
  // document as it stands — and says so.
  let slip: { documentNumber: string; text: string; companyCode: string | null; stored: boolean } | null = null;
  if (canRun && get('preview')) {
    const documentNumber = get('preview');
    const stored = result?.rows.find((row) => row.documentNumber === documentNumber && row.renderedDocument);
    try {
      slip = {
        documentNumber,
        text: stored?.renderedDocument
          ?? await renderSlip({ client: session.user.client, documentNumber }),
        companyCode: stored?.companyCodes[0]
          ?? await materialDocumentCompanyCode(session.user.client, documentNumber),
        stored: Boolean(stored),
      };
    } catch {
      slip = null;
    }
  }
  const letterheads = await letterheadViews(session.user.client, [
    ...(slip?.companyCode ? [slip.companyCode] : []),
  ]);

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">INV.MATERIALDOC.RECEIVEPRINT · MB90</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('mb90.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('mb90.subtitle')}</p>
      </header>

      {!canRun && (
        <div className="panel p-4 text-sm text-ink-soft" role="alert">{t('mb90.capabilityMissing')}</div>
      )}

      {listError && <div className="panel p-4 text-sm text-signal-error" role="alert">{listError}</div>}

      {canRun && (
        <MaterialDocumentOutput
          result={result}
          selection={selection}
          slip={slip}
          letterheads={letterheads}
          route={MATERIAL_DOC_OUTPUT_ROUTE}
        />
      )}
    </div>
  );
}
