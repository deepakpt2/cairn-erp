import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  MATERIAL_DOC_DISPLAY_CAPABILITY,
  MaterialDocumentDisplayError,
  displayMaterialDocument,
  type DisplayedDocument,
} from '@/modules/inventory/material-document-display';

export const dynamic = 'force-dynamic';

const ACCOUNTING_CAPTION: Record<string, string> = {
  NONE: 'mbst.accountingNone',
  POSTED: 'mbst.accountingPosted',
  PARTIAL: 'mbst.accountingPartial',
  COMPLETE: 'mbst.accountingComplete',
  MISSING: 'mbst.accountingMissing',
  MISMATCH: 'mbst.accountingMismatch',
  DEFERRED: 'mbst.accountingDeferred',
  ABSENT: 'mbst.accountingAbsent',
};

function accountingCaption(state: string): string {
  return ACCOUNTING_CAPTION[state] ?? 'mbst.accountingMissing';
}

/**
 * Display material document — SCR-134 / INV.DISPLAY (MB03 as a search alias only).
 *
 * A display and nothing else: the document opens exactly as the ledger recorded
 * it, whoever posted it and whenever, with no period check and no write. The
 * company code is derived from the plants and shown; the fiscal year is a
 * cross-check, and an item narrows the grid to one line.
 */
export default async function MaterialDocumentPage({ searchParams }: {
  searchParams: Promise<{ document?: string; fiscalYear?: string; item?: string }>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const canDisplay = can(session, MATERIAL_DOC_DISPLAY_CAPABILITY);

  let document: DisplayedDocument | null = null;
  let error: string | null = null;
  let remedy: string | null = null;

  if (canDisplay && params.document) {
    try {
      document = await displayMaterialDocument({
        client: session.user.client,
        documentNumber: params.document,
        fiscalYear: params.fiscalYear,
        itemNumber: params.item,
      });
    } catch (caught) {
      if (caught instanceof MaterialDocumentDisplayError) {
        error = caught.message;
        remedy = caught.remedy ?? null;
      } else {
        throw caught;
      }
    }
  } else if (canDisplay && (params.fiscalYear || params.item)) {
    error = t('mdDoc.numberRequired');
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">INV.DISPLAY · MB03</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {t('mdDoc.title')}{document ? ` ${document.materialDocumentNumber}` : ''}
          </h1>
          <Link href="/inventory/material-document-list" className="btn btn-default min-h-11 sm:min-h-8">
            {t('mdDoc.back')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('mdDoc.subtitle')}</p>
      </header>

      {!canDisplay && (
        <div className="panel p-4 text-sm text-ink-soft" role="alert">{t('mdDoc.capabilityMissing')}</div>
      )}

      {canDisplay && (
        <section aria-labelledby="document-lookup" className="panel p-4">
          <h2 id="document-lookup" className="text-sm font-semibold">{t('mdDoc.lookup')}</h2>
          <form method="get" action="/inventory/material-documents" className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mdDoc.document')}</span>
              <input
                name="document"
                className="input"
                placeholder={t('mdDoc.documentPlaceholder')}
                defaultValue={document?.materialDocumentNumber ?? params.document ?? ''}
                required
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mdDoc.year')}</span>
              <input
                name="fiscalYear"
                className="input w-28"
                placeholder="2026"
                maxLength={4}
                defaultValue={params.fiscalYear ?? ''}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mdDoc.item')}</span>
              <input
                name="item"
                className="input w-24"
                placeholder="1"
                defaultValue={params.item ?? ''}
              />
            </label>
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">{t('mdDoc.search')}</button>
          </form>
          <p className="mt-2 text-xs text-ink-faint">{t('mdDoc.lookupHint')}</p>
        </section>
      )}

      {error && (
        <div className="panel p-4 text-sm" role="alert">
          <span className="text-red-700">{error}</span>
          {remedy ? <span className="text-ink-soft"> {remedy}</span> : null}
        </div>
      )}

      {document && (
        <>
          <section className="panel p-4" aria-label={t('mdDoc.header')}>
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <dt className="field-label">{t('mdDoc.document')}</dt>
                <dd className="code">{document.materialDocumentNumber}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.year')}</dt>
                <dd className="code">{document.documentYear}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.postingDate')}</dt>
                <dd>{document.postingDate}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.documentDate')}</dt>
                <dd>{document.documentDate}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.status')}</dt>
                <dd data-status={document.status}>{document.status}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.postedBy')}</dt>
                <dd data-posted-by={document.postedBy}>{document.postedBy}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.enteredAt')}</dt>
                <dd className="code">{document.enteredAt}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.companyCode')}</dt>
                <dd className="code" data-company-codes={document.companyCodes.join(',')}>
                  {document.companyCodes.join(', ') || '—'}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="field-label">{t('mdDoc.headerText')}</dt>
                <dd>{document.headerText ?? '—'}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.reversalOf')}</dt>
                <dd>{document.reversalOf ?? '—'}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.reversedBy')}</dt>
                <dd>{document.reversedBy ?? '—'}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-ink-faint">
              {t('mdDoc.journal')}:{' '}
              {document.journalDocumentNumber
                ? (
                  <Link
                    className="code text-accent hover:underline"
                    href={`/finance/journal/document?document=${encodeURIComponent(document.journalDocumentNumber)}`}
                  >
                    {document.journalDocumentNumber}
                  </Link>
                )
                : document.journalAccounting.state === 'NONE'
                  ? t('mbst.noJournal')
                  : t(accountingCaption(document.journalAccounting.state))}
            </p>
            <p className="mt-1 text-xs text-ink-soft" data-accounting={document.journalAccounting.state}>
              {t(accountingCaption(document.journalAccounting.state))}
            </p>
          </section>

          <section className="panel p-4" aria-label={t('mdDoc.lines')}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">
                {t('mdDoc.lines')} <span className="text-ink-faint">({document.lineCount})</span>
                {document.selectedItem !== null
                  ? <span className="ms-2 text-xs text-ink-soft">{t('mdDoc.itemNarrowed')} {document.selectedItem}</span>
                  : null}
              </h2>
              <Link href={document.listDrillDown} className="btn btn-default min-h-11 sm:min-h-8">
                {t('mdDoc.openInList')}
              </Link>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th className="py-1">{t('mdDoc.columnItem')}</th>
                    <th className="py-1">{t('mdDoc.columnMovement')}</th>
                    <th className="py-1">{t('mdDoc.columnMaterial')}</th>
                    <th className="py-1">{t('mdDoc.columnPlant')}</th>
                    <th className="py-1">{t('mdDoc.columnLocation')}</th>
                    <th className="py-1">{t('mdDoc.columnStockType')}</th>
                    <th className="py-1">{t('mdDoc.columnBatch')}</th>
                    <th className="py-1 text-right">{t('mdDoc.columnQuantity')}</th>
                    <th className="py-1 text-right">{t('mdDoc.columnValue')}</th>
                    <th className="py-1">{t('mdDoc.columnReference')}</th>
                  </tr>
                </thead>
                <tbody>
                  {document.lines.map((line) => (
                    <tr
                      key={line.lineNumber}
                      data-item={line.lineNumber}
                      data-direction={line.lineDirection}
                      className={`border-t border-line ${line.lineNumber === document.selectedItem ? 'bg-surface-muted' : ''}`}
                    >
                      <td className="py-1">{line.lineNumber}</td>
                      <td className="py-1">
                        <span className="code">{line.movementType}</span>
                        {line.movementDescription ? (
                          <span className="ms-1 text-ink-soft">{line.movementDescription}</span>
                        ) : null}
                        <span className="ms-1 text-ink-faint">({line.lineDirection})</span>
                      </td>
                      <td className="py-1">
                        <span className="code">{line.materialNumber}</span>
                        {line.materialDescription ? (
                          <span className="ms-1 text-ink-soft">{line.materialDescription}</span>
                        ) : null}
                      </td>
                      <td className="py-1">{line.plant}</td>
                      <td className="py-1">{line.storageLocation ?? '—'}</td>
                      <td className="py-1">{line.stockType}</td>
                      <td className="code py-1" data-batch={line.batch}>{line.batch || '—'}</td>
                      <td className="py-1 text-right tabular-nums">{line.quantity} {line.unit}</td>
                      <td className="py-1 text-right tabular-nums">
                        {line.value}{line.currency ? ` ${line.currency}` : ''}
                      </td>
                      <td className="py-1">
                        {line.purchaseOrderNumber ? (
                          <Link
                            href={`/purchasing/orders?order=${encodeURIComponent(line.purchaseOrderNumber)}`}
                            className="link"
                          >
                            {line.purchaseOrderNumber}
                            {line.purchaseOrderItem !== null ? ` / ${line.purchaseOrderItem}` : ''}
                          </Link>
                        ) : '—'}
                        {line.reversalOfDocument ? (
                          <span className="ms-1 text-ink-faint">
                            {t('mdDoc.reversalOf')} {line.reversalOfDocument}
                            {line.reversalOfLine !== null ? ` / ${line.reversalOfLine}` : ''}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-ink-faint">{t('mdDoc.reservationDeferred')}</p>
          </section>
        </>
      )}
    </div>
  );
}
