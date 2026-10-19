import Link from 'next/link';
import { t } from '@/platform/i18n';
import type { CreditMonitorFilter, CreditMonitorResult } from '@/modules/finance/credit';

/**
 * Credit exposure monitor (SCR-104 / F.31): read-only overview
 * of every customer in the selected credit control areas —
 * limit, open AR exposure, available credit, Utilization and
 * block standing, computed at execution time. Order, delivery
 * and billing components show as unavailable until the SD canon
 * stands; they are never silently zero.
 */
export default function CreditMonitorShell({ canUse, result, error, filter }: {
  canUse: boolean;
  result: CreditMonitorResult | null;
  error?: string | null;
  filter?: CreditMonitorFilter;
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.CREDIT.MONITOR' })}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {error && (
        <div className="border border-signal-error/30 bg-signal-error-soft p-3">
          <p className="text-sm font-semibold text-signal-error">{error}</p>
        </div>
      )}
      <form method="get" className="panel space-y-3 p-4" aria-label={t('monitor.filtersTitle')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('monitor.areaFrom')}>
            <input name="areaFrom" defaultValue={filter?.areaFrom ?? ''} maxLength={4} className="field-input code w-28" />
          </Field>
          <Field label={t('monitor.areaTo')}>
            <input name="areaTo" defaultValue={filter?.areaTo ?? ''} maxLength={4} className="field-input code w-28" />
          </Field>
          <Field label={t('monitor.company')}>
            <input name="companyCode" defaultValue={filter?.companyCode ?? ''} className="field-input code w-32" />
          </Field>
          <Field label={t('monitor.customerFrom')}>
            <input name="customerFrom" defaultValue={filter?.customerFrom ?? ''} className="field-input code w-36" />
          </Field>
          <Field label={t('monitor.customerTo')}>
            <input name="customerTo" defaultValue={filter?.customerTo ?? ''} className="field-input code w-36" />
          </Field>
          <Field label={t('monitor.risk')}>
            <input name="riskCategory" maxLength={3} defaultValue={filter?.riskCategory ?? ''} className="field-input code w-28" />
          </Field>
          <Field label={t('monitor.reportingCurrency')}>
            <input name="reportingCurrency" defaultValue={filter?.reportingCurrency ?? ''} maxLength={5} className="field-input code w-28" placeholder="USD" />
          </Field>
          <Field label={t('monitor.flags')}>
            <span className="flex gap-3 pt-2 text-sm text-ink-soft">
              <label className="flex items-center gap-1">
                <input type="checkbox" name="limitExceededOnly" value="true" /> {t('monitor.exceededOnly')}
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" name="blockedOnly" value="true" /> {t('monitor.blockedOnly')}
              </label>
            </span>
          </Field>
        </div>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">
          {t('monitor.run')}
        </button>
      </form>

      {result && (
        <p className="text-sm text-ink-soft">
          {t('monitor.calculatedAt', { when: result.calculatedAt.slice(0, 19).replace('T', ' '), count: result.totalCustomers })}
          {result.reportingCurrency ? ` · ${result.reportingCurrency}` : ''}
        </p>
      )}

      <section className="panel overflow-x-auto" aria-label={t('monitor.gridTitle')}>
        <table className="grid-table min-w-[72rem]">
          <thead>
            <tr>
              <th>{t('monitor.customer')}</th><th>{t('monitor.area')}</th>
              <th className="text-end">{t('monitor.limit')}</th>
              <th className="text-end">{t('monitor.arExposure')}</th>
              <th className="text-end">{t('monitor.orderExposure')}</th>
              <th className="text-end">{t('monitor.deliveryExposure')}</th>
              <th className="text-end">{t('monitor.billingExposure')}</th>
              <th className="text-end">{t('monitor.totalExposure')}</th>
              <th className="text-end">{t('monitor.available')}</th>
              <th className="text-end">{t('monitor.utilization')}</th>
              <th>{t('monitor.risk')}</th><th>{t('monitor.block')}</th>
            </tr>
          </thead>
          <tbody>
            {(result?.rows ?? []).map((row) => (
              <tr key={`${row.customer}-${row.creditControlArea}`} className={row.utilizationPercent !== null && row.utilizationPercent > 100 ? 'bg-signal-error-soft' : undefined}>
                <td>
                  <Link href={`/finance/credit?customer=${encodeURIComponent(row.customer)}&area=${encodeURIComponent(row.creditControlArea)}`} className="text-accent hover:underline">
                    {row.customerName} ({row.customer})
                  </Link>
                  {row.noCreditRecord && <span className="block text-2xs font-semibold text-signal-error">{t('monitor.noRecord')}</span>}
                </td>
                <td className="code">{row.creditControlArea}</td>
                <td className="tabular text-end">{row.creditLimit === null ? '—' : `${row.creditLimit.toFixed(2)} ${row.creditCurrency}`}</td>
                <td className="tabular text-end">{row.arExposure.toFixed(2)}</td>
                <td className="tabular text-end text-ink-faint">{row.orderExposure === null ? t('monitor.unavailable') : row.orderExposure.toFixed(2)}</td>
                <td className="tabular text-end text-ink-faint">{row.deliveryExposure === null ? t('monitor.unavailable') : row.deliveryExposure.toFixed(2)}</td>
                <td className="tabular text-end text-ink-faint">{row.billingExposure === null ? t('monitor.unavailable') : row.billingExposure.toFixed(2)}</td>
                <td className="tabular text-end font-semibold">{row.totalExposure.toFixed(2)}</td>
                <td className="tabular text-end">{row.availableCredit === null ? '—' : row.availableCredit.toFixed(2)}</td>
                <td className="tabular text-end">{row.utilizationPercent === null ? '—' : `${row.utilizationPercent.toFixed(1)}%`}</td>
                <td className="code">{row.riskCategory ?? '—'}</td>
                <td>{row.isBlocked ? (row.blockReason ?? t('monitor.blocked')) : '—'}{row.limitExpired ? <span className="block text-2xs text-signal-error">{t('monitor.expired')}</span> : null}</td>
              </tr>
            ))}
            {(!result || result.rows.length === 0) && (
              <tr><td colSpan={12} className="text-sm text-ink-soft">{t('monitor.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}
