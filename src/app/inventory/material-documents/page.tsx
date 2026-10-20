import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { getMaterialDocument } from '@/modules/inventory/goods-receipt';
import { MATERIAL_DOC_LIST_CAPABILITY } from '@/modules/inventory/material-document-list';

export const dynamic = 'force-dynamic';

/**
 * SCR-125: the material document display — the MB03 equivalent and the list's
 * drill-down target. A read-only read of one document exactly as the ledger
 * recorded it; it shares INV.MATERIALDOC.LIST with the list, because a report
 * and its drill are one capability.
 */
export default async function MaterialDocumentPage({
  searchParams,
}: {
  searchParams: Promise<{ document?: string }>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const canView = can(session, MATERIAL_DOC_LIST_CAPABILITY);
  const document = params.document && canView
    ? await getMaterialDocument(session.user.client, params.document)
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">INV.MATERIALDOC.LIST · MB51 / MB03</span>
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

      {!canView ? (
        <div className="panel p-4 text-sm text-ink-soft">{t('mdDoc.capabilityMissing')}</div>
      ) : null}

      {canView && !document ? (
        <div className="panel p-4 text-sm text-ink-soft" role="alert">{t('mdDoc.notFound')}</div>
      ) : null}

      {document ? (
        <>
          <section className="panel p-4" aria-label={t('mdDoc.header')}>
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <dt className="field-label">{t('mdDoc.header')}</dt>
                <dd className="code">{document.materialDocumentNumber}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.year')}</dt>
                <dd className="code">{document.documentYear}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.documentDate')}</dt>
                <dd>{document.documentDate}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.postingDate')}</dt>
                <dd>{document.postingDate}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.status')}</dt>
                <dd>{document.status}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.headerText')}</dt>
                <dd>{document.headerText ?? ''}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.journal')}</dt>
                <dd className="code">
                  {document.journalDocumentNumber
                    ? <Link href={`/finance/journal?document=${encodeURIComponent(document.journalDocumentNumber)}`}>{document.journalDocumentNumber}</Link>
                    : ''}
                </dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.reversalOf')}</dt>
                <dd className="code">{document.reversalOf ?? ''}</dd>
              </div>
              <div>
                <dt className="field-label">{t('mdDoc.reversedBy')}</dt>
                <dd className="code">{document.reversedBy ?? ''}</dd>
              </div>
            </dl>
          </section>

          <section className="panel overflow-x-auto" aria-label={t('mdDoc.lines')}>
            <table className="grid-table min-w-[64rem]">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('mdList.movementType')}</th>
                  <th>{t('mdList.material')}</th>
                  <th className="text-end">{t('mdList.baseQuantity')}</th>
                  <th>{t('mdList.unit')}</th>
                  <th className="text-end">{t('mdList.value')}</th>
                  <th>{t('mdList.plant')}</th>
                  <th>{t('mdList.storageLocation')}</th>
                  <th>{t('mdList.purchaseOrder')}</th>
                </tr>
              </thead>
              <tbody>
                {document.lines.map((line) => (
                  <tr key={line.lineNumber}>
                    <td>{line.lineNumber}</td>
                    <td className="code">{line.movementType}</td>
                    <td className="code">{line.materialNumber}</td>
                    <td className="text-end">{Number(line.quantity).toFixed(3)}</td>
                    <td>{line.unit}</td>
                    <td className="text-end">{Number(line.value).toFixed(2)}</td>
                    <td className="code">{line.plant}</td>
                    <td className="code">{line.storageLocation ?? ''}</td>
                    <td className="code">
                      {line.purchaseOrderNumber
                        ? <Link href={`/purchasing/orders?order=${encodeURIComponent(line.purchaseOrderNumber)}`}>
                            {line.purchaseOrderNumber} / {line.purchaseOrderItem ?? ''}
                          </Link>
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </div>
  );
}
