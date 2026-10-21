'use client';

/**
 * SCR-144 / INV.STOCK.RECONCILE — drift, and the repair of it.
 *
 * The grid lists only the dimensions that disagree. A balanced plant shows a verdict and no
 * rows, which is the honest shape: a screen that lists every dimension to say "all fine" buries
 * the one line that matters.
 */
import { useActionState } from 'react';

import { t } from '@/platform/i18n';
import type { ReconcileResult } from '@/modules/inventory/stock-reconcile';
import { rebuildAction, type RebuildState } from './actions';

const INITIAL: RebuildState = { ok: false, message: '' };

export default function ReconcileShell({
  canReconcile,
  plant,
  result,
  reportError,
}: {
  canReconcile: boolean;
  plant: string;
  result: ReconcileResult | null;
  reportError: string | null;
}) {
  const [state, action, rebuilding] = useActionState(rebuildAction, INITIAL);

  return (
    <>
      <section aria-labelledby="reconcile-scope" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="reconcile-scope" className="text-sm font-semibold">{t('recon.scopeHeader')}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t('recon.scopeHint')}</p>
        <form method="get" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="field-label">{t('recon.plant')}</span>
            <input name="plant" className="input w-32" placeholder="1000" defaultValue={plant} required />
          </label>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('recon.run')}</button>
        </form>
      </section>

      {reportError && (
        <p role="alert" className="rounded-card border border-red-300 bg-red-50 p-3 text-sm text-red-800">{reportError}</p>
      )}

      {result && (
        <section aria-labelledby="reconcile-report" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="reconcile-report" className="text-sm font-semibold">{t('recon.reportHeader')}</h2>
          <p
            role="status"
            className={`mt-2 text-sm ${result.balanced ? 'text-ink' : 'text-red-700'}`}
            data-reconcile-verdict={result.balanced ? 'BALANCED' : 'DRIFT'}
            data-dimensions-checked={result.dimensionsChecked}
          >
            {result.balanced
              ? `${result.dimensionsChecked} ${t('recon.balancedTail')}`
              : `${result.drift.length} ${t('recon.driftTail')} ${result.dimensionsChecked} ${t('recon.dimensionsTail')}`}
          </p>

          <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
            {state.message}{state.remedy ? ` ${state.remedy}` : ''}
          </p>

          {result.drift.length > 0 && (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-1">{t('recon.material')}</th>
                  <th className="py-1">{t('recon.plant')}</th>
                  <th className="py-1">{t('recon.location')}</th>
                  <th className="py-1">{t('recon.stockType')}</th>
                  <th className="py-1 text-right">{t('recon.ledger')}</th>
                  <th className="py-1 text-right">{t('recon.projection')}</th>
                  <th className="py-1 text-right">{t('recon.difference')}</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {result.drift.map((row) => {
                  const key = `${row.materialNumber}/${row.plant}/${row.storageLocation ?? '-'}/${row.stockType}`;
                  return (
                    <tr key={key} className="border-t border-line" data-drift={key}>
                      <td className="py-1 code">{row.materialNumber}</td>
                      <td className="py-1 code">{row.plant}</td>
                      <td className="py-1 code">{row.storageLocation ?? '—'}</td>
                      <td className="py-1 code">{row.stockType}</td>
                      <td className="py-1 text-right tabular">{row.ledgerQuantity}</td>
                      <td className="py-1 text-right tabular">{row.projectedQuantity}</td>
                      <td className="py-1 text-right tabular" data-difference={row.difference}>{row.difference}</td>
                      <td className="py-1 text-right">
                        <form action={action}>
                          <input type="hidden" name="materialNumber" value={row.materialNumber} />
                          <input type="hidden" name="plant" value={row.plant} />
                          <input type="hidden" name="storageLocation" value={row.storageLocation ?? ''} />
                          <input type="hidden" name="stockType" value={row.stockType} />
                          <button
                            type="submit"
                            className="btn min-h-11 sm:min-h-8"
                            disabled={!canReconcile || rebuilding}
                            data-rebuild
                          >
                            {t('recon.rebuild')}
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}
    </>
  );
}
