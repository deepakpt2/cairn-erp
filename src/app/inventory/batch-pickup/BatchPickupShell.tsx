import type { ReactNode } from 'react';
import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { BatchPickupResult, BatchPickupSelection } from '@/modules/inventory/batch-pickup';

/**
 * MB5C: the pick-up list. The form only names a material, a plant, or a batch.
 * A row opens the same list with that batch named, which is what shows the
 * material documents. Nothing on this screen posts.
 */
export default function BatchPickupShell({ canUse, selection, result, reportError }: {
  canUse: boolean;
  selection: BatchPickupSelection;
  result: BatchPickupResult | null;
  reportError?: string | null;
}) {
  if (!canUse) {
    return <div className="panel p-4 text-sm text-ink-soft">{t('mb5c.capabilityMissing')}</div>;
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('mb5c.selection')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('mb5c.material')}>
            <input name="material" maxLength={40} className="field-input code w-40" defaultValue={selection.material ?? ''} />
          </Field>
          <Field label={t('mb5c.plant')}>
            <input name="plant" maxLength={10} className="field-input code w-32" defaultValue={selection.plant ?? ''} />
          </Field>
          <Field label={t('mb5c.batch')}>
            <input name="batch" maxLength={10} className="field-input code w-32" defaultValue={selection.batch ?? ''} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('mb5c.execute')}</button>
          <Link href="/inventory/batch-pickup" className="btn btn-default min-h-11 sm:min-h-8">{t('mb5c.reset')}</Link>
        </div>
      </form>

      {reportError ? (
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="alert">
          {reportError}
        </div>
      ) : null}

      {result ? (
        <section className="panel overflow-x-auto p-4">
          <p className="mb-2 text-sm text-ink-soft">{t('mb5c.readOnly')}</p>
          {result.rows.length === 0 ? (
            <p className="text-sm">{t('mb5c.noRows')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-ink-soft">
                  <th className="py-2 pr-3">{t('mb5c.material')}</th>
                  <th className="py-2 pr-3">{t('mb5c.batch')}</th>
                  <th className="py-2 pr-3">{t('mb5c.plant')}</th>
                  <th className="py-2 pr-3">{t('mb5c.documents')}</th>
                  <th className="py-2 pr-3">{t('mb5c.lastPosting')}</th>
                  <th className="py-2 pr-3">{t('mb5c.shelfLife')}</th>
                  <th className="py-2">{t('mb5c.restricted')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={`${row.materialNumber}-${row.batch}-${row.plant}`} className="border-b border-line" data-batch={row.batch}>
                    <td className="py-2 pr-3"><span className="code">{row.materialNumber}</span> {row.materialDescription}</td>
                    <td className="py-2 pr-3">
                      <Link className="code underline" href={`/inventory/batch-pickup?material=${encodeURIComponent(row.materialNumber)}&plant=${encodeURIComponent(row.plant)}&batch=${encodeURIComponent(row.batch)}`}>
                        {row.batch}
                      </Link>
                    </td>
                    <td className="code py-2 pr-3">{row.plant}</td>
                    <td className="code py-2 pr-3">{row.documentCount}</td>
                    <td className="code py-2 pr-3">{row.lastPostingDate}</td>
                    <td className="code py-2 pr-3">{row.shelfLifeExpirationDate ?? '—'}</td>
                    <td className="code py-2">{row.restrictedUse === 'X' ? 'X' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.truncated ? <p className="mt-2 text-sm text-ink-soft">{t('mb5c.truncated')}</p> : null}
        </section>
      ) : null}

      {result && result.uses.length > 0 ? (
        <section className="panel overflow-x-auto p-4">
          <h2 className="mb-2 text-sm font-medium">{t('mb5c.uses')}</h2>
          {selection.batch ? (
            <p className="mb-2 text-sm">
              <Link className="underline" href={`/inventory/batches/display?material=${encodeURIComponent(selection.material ?? '')}&batch=${encodeURIComponent(selection.batch)}`}>MSC3N</Link>
              {' · '}
              <Link className="underline" href={`/inventory/batch-cockpit?material=${encodeURIComponent(selection.material ?? '')}&batch=${encodeURIComponent(selection.batch)}`}>BMBC</Link>
            </p>
          ) : null}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-ink-soft">
                <th className="py-2 pr-3">{t('mb5c.document')}</th>
                <th className="py-2 pr-3">{t('mb5c.line')}</th>
                <th className="py-2 pr-3">{t('mb5c.lastPosting')}</th>
                <th className="py-2 pr-3">{t('mb5c.movement')}</th>
                <th className="py-2 pr-3">{t('mb5c.direction')}</th>
                <th className="py-2 pr-3">{t('mb5c.quantity')}</th>
                <th className="py-2">{t('mb5c.reference')}</th>
              </tr>
            </thead>
            <tbody>
              {result.uses.map((use) => (
                <tr key={`${use.materialDocumentNumber}-${use.lineNumber}`} className="border-b border-line">
                  <td className="code py-2 pr-3">
                    <Link className="underline" href={`/inventory/material-documents?document=${encodeURIComponent(use.materialDocumentNumber)}`}>
                      {use.materialDocumentNumber}
                    </Link>
                  </td>
                  <td className="code py-2 pr-3">{use.lineNumber}</td>
                  <td className="code py-2 pr-3">{use.postingDate}</td>
                  <td className="code py-2 pr-3">{use.movementType}</td>
                  <td className="py-2 pr-3">{use.direction}</td>
                  <td className="code py-2 pr-3">{use.quantity} {use.unit}</td>
                  <td className="code py-2">{use.purchaseOrderNumber ?? use.productionOrderNumber ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.usesTruncated ? <p className="mt-2 text-sm text-ink-soft">{t('mb5c.usesTruncated')}</p> : null}
        </section>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
