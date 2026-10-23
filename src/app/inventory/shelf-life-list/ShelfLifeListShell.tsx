import type { ReactNode } from 'react';
import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { ShelfLifeResult, ShelfLifeSelection } from '@/modules/inventory/shelf-life-list';

/** MB5M selection and list. The form does not post. */
export default function ShelfLifeListShell({ canUse, selection, result, reportError }: {
  canUse: boolean;
  selection: ShelfLifeSelection;
  result: ShelfLifeResult | null;
  reportError?: string | null;
}) {
  if (!canUse) return <div className="panel p-4 text-sm text-ink-soft">{t('mb5m.capabilityMissing')}</div>;
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('mb5m.selection')}>
        <input type="hidden" name="run" value="1" />
        <h2 className="text-sm font-medium">{t('mb5m.database')}</h2>
        <div className="flex flex-wrap gap-3">
          <Field label={t('mb5m.materialFrom')}><input name="materialFrom" maxLength={40} className="field-input code w-36" defaultValue={selection.materialFrom ?? ''} /></Field>
          <Field label={t('mb5m.materialTo')}><input name="materialTo" maxLength={40} className="field-input code w-36" defaultValue={selection.materialTo ?? ''} /></Field>
          <Field label={t('mb5m.plantFrom')}><input name="plantFrom" maxLength={10} className="field-input code w-28" defaultValue={selection.plantFrom ?? ''} /></Field>
          <Field label={t('mb5m.plantTo')}><input name="plantTo" maxLength={10} className="field-input code w-28" defaultValue={selection.plantTo ?? ''} /></Field>
          <Field label={t('mb5m.locationFrom')}><input name="storageLocationFrom" maxLength={10} className="field-input code w-28" defaultValue={selection.storageLocationFrom ?? ''} /></Field>
          <Field label={t('mb5m.locationTo')}><input name="storageLocationTo" maxLength={10} className="field-input code w-28" defaultValue={selection.storageLocationTo ?? ''} /></Field>
          <Field label={t('mb5m.batchFrom')}><input name="batchFrom" maxLength={10} className="field-input code w-28" defaultValue={selection.batchFrom ?? ''} /></Field>
          <Field label={t('mb5m.batchTo')}><input name="batchTo" maxLength={10} className="field-input code w-28" defaultValue={selection.batchTo ?? ''} /></Field>
        </div>
        <h2 className="text-sm font-medium">{t('mb5m.scope')}</h2>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('mb5m.remaining')}>
            <input name="remainingShelfLifeDays" inputMode="numeric" className="field-input code w-28" defaultValue={selection.remainingShelfLifeDays ?? ''} />
          </Field>
          <label className="text-sm">
            <input type="radio" name="scope" value="TOTAL" defaultChecked={selection.scope !== 'WAREHOUSE'} /> {t('mb5m.total')}
          </label>
          <label className="text-sm">
            <input type="radio" name="scope" value="WAREHOUSE" defaultChecked={selection.scope === 'WAREHOUSE'} /> {t('mb5m.warehouse')}
          </label>
          <label className="text-sm">
            <input type="checkbox" name="includeZeroStock" value="1" defaultChecked={selection.includeZeroStock === true} /> {t('mb5m.zeroStock')}
          </label>
        </div>
        <h2 className="text-sm font-medium">{t('mb5m.display')}</h2>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label><input type="radio" name="display" value="DAYS" defaultChecked={selection.display !== 'PERIOD'} /> {t('mb5m.days')}</label>
          <label><input type="radio" name="display" value="PERIOD" defaultChecked={selection.display === 'PERIOD'} /> {t('mb5m.period')}</label>
          <label>
            {t('mb5m.layout')}
            <select name="layout" defaultValue={selection.layout ?? 'ALV'} className="field-input ml-2">
              <option value="ALV">ALV</option>
              <option value="LIST">{t('mb5m.list')}</option>
            </select>
          </label>
        </div>
        <p className="text-sm text-ink-soft">{t('mb5m.extension')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('mb5m.execute')}</button>
          <Link href="/inventory/shelf-life-list" className="btn btn-default min-h-11 sm:min-h-8">{t('mb5m.reset')}</Link>
        </div>
      </form>
      {reportError ? <p className="panel p-4 text-sm text-ink" role="alert">{reportError}</p> : null}
      {result ? (
        <section className="panel overflow-x-auto p-4">
          <h2 className="mb-2 text-sm font-medium">{t('mb5m.rows')}</h2>
          <p className="mb-2 text-sm text-ink-soft">
            {t('mb5m.keyDate')} <span className="code">{result.keyDate}</span>
            {' · '}
            {result.scope === 'WAREHOUSE' ? t('mb5m.warehouse') : t('mb5m.total')}
            {' · '}
            {result.display === 'PERIOD' ? t('mb5m.period') : t('mb5m.days')}
          </p>
          {result.warnings.map((warning) => <p key={warning} className="text-sm text-ink-soft">{warning}</p>)}
          {result.rows.length === 0 ? <p className="mt-2 text-sm">{t('mb5m.noRows')}</p> : (
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-ink-soft">
                  <th className="py-2 pr-3">{t('mb5m.materialFrom')}</th>
                  <th className="py-2 pr-3">{t('mb5m.plantFrom')}</th>
                  <th className="py-2 pr-3">{t('mb5m.locationFrom')}</th>
                  <th className="py-2 pr-3">{t('mb5m.batchFrom')}</th>
                  <th className="py-2 pr-3">{t('mb5m.manufacture')}</th>
                  <th className="py-2 pr-3">{t('mb5m.expiration')}</th>
                  <th className="py-2 pr-3">{t('mb5m.remaining')}</th>
                  <th className="py-2 pr-3">{t('mb5m.quantity')}</th>
                  <th className="py-2">{t('mb5m.open')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={`${row.materialNumber}-${row.plant}-${row.storageLocation}-${row.batch}`} className="border-b border-line">
                    <td className="py-2 pr-3"><span className="code">{row.materialNumber}</span> {row.materialDescription}</td>
                    <td className="code py-2 pr-3">{row.plant}</td>
                    <td className="code py-2 pr-3">{row.storageLocation || '—'}</td>
                    <td className="code py-2 pr-3">{row.batch}</td>
                    <td className="code py-2 pr-3">{row.manufactureDate ?? '—'}</td>
                    <td className="code py-2 pr-3">{row.expirationDate ?? '—'}{row.comparedExpiration !== row.expirationDate ? ` / ${row.comparedExpiration}` : ''}</td>
                    <td className="py-2 pr-3">{row.displayRemaining} · {row.classification}</td>
                    <td className="code py-2 pr-3">{row.unrestrictedQuantity} {row.baseUnit}</td>
                    <td className="py-2">
                      <Link className="underline" href={row.batchHref}>MSC3N</Link>
                      {' · '}
                      <Link className="underline" href={row.materialHref}>MM03</Link>
                      {' · '}
                      <Link className="underline" href={row.stockHref}>MMBE</Link>
                      {' · '}
                      <Link className="underline" href={row.pickupHref}>MB5C</Link>
                      {row.documentHref ? <>{' · '}<Link className="underline" href={row.documentHref}>MB03</Link></> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.truncated ? <p className="mt-2 text-sm text-ink-soft">{t('mb5m.truncated')}</p> : null}
          {result.undetermined.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-sm font-medium">{t('mb5m.undetermined')}</h3>
              <ul className="mt-1 text-sm">
                {result.undetermined.map((row) => (
                  <li key={`${row.materialNumber}-${row.plant}-${row.batch}`}>{row.materialNumber} {row.plant} {row.batch}: {row.reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="text-sm">{label}<span className="mt-1 block">{children}</span></label>;
}
