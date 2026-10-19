import Link from 'next/link';
import { t } from '@/platform/i18n';
import type { CreditDeterminationView } from '@/modules/finance/credit';

/**
 * Release credit-blocked documents (SCR-105 / VKM3): the queue
 * of current credit determinations. Release re-evaluates against
 * today's credit standing; a still-failing document needs the
 * separate override privilege with justification. Nothing here
 * creates deliveries, invoices or accounting entries.
 */
export default function CreditReleaseShell({ canUse, determinations }: {
  canUse: boolean;
  determinations: CreditDeterminationView[];
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.CREDIT.RELEASE' })}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('release.filtersTitle')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('release.areaFrom')}>
            <input name="areaFrom" maxLength={4} className="field-input code w-28" />
          </Field>
          <Field label={t('release.salesOrg')}>
            <input name="salesOrg" maxLength={4} className="field-input code w-28" />
          </Field>
          <Field label={t('release.customerFrom')}>
            <input name="customerFrom" className="field-input code w-36" />
          </Field>
          <Field label={t('release.documentFrom')}>
            <input name="documentFrom" className="field-input code w-36" />
          </Field>
          <Field label={t('release.dateFrom')}>
            <input name="dateFrom" type="date" className="field-input w-40" />
          </Field>
          <Field label={t('release.dateTo')}>
            <input name="dateTo" type="date" className="field-input w-40" />
          </Field>
          <Field label={t('release.flags')}>
            <span className="flex gap-3 pt-2 text-sm text-ink-soft">
              <label className="flex items-center gap-1">
                <input type="checkbox" name="blockedOnly" value="true" defaultChecked /> {t('release.blockedOnly')}
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" name="includeReleased" value="true" /> {t('release.includeReleased')}
              </label>
            </span>
          </Field>
        </div>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
          {t('release.display')}
        </button>
      </form>

      <section className="panel overflow-x-auto" aria-label={t('release.queueTitle')}>
        <table className="grid-table min-w-[72rem]">
          <thead>
            <tr>
              <th>{t('release.document')}</th><th>{t('release.date')}</th>
              <th>{t('release.customer')}</th><th>{t('release.area')}</th>
              <th className="text-end">{t('release.orderValue')}</th>
              <th className="text-end">{t('release.exposureLimit')}</th>
              <th className="text-end">{t('release.utilization')}</th>
              <th>{t('release.status')}</th><th>{t('release.reason')}</th>
              <th>{t('release.releasedBy')}</th>
            </tr>
          </thead>
          <tbody>
            {determinations.map((d) => (
              <tr key={d.determinationId}>
                <td className="code">{d.salesDocument}</td>
                <td>{d.documentDate}</td>
                <td>
                  <Link href={`/finance/credit?customer=${encodeURIComponent(d.customer)}&area=${encodeURIComponent(d.creditControlArea)}`} className="text-accent hover:underline">
                    {d.customerName} ({d.customer})
                  </Link>
                </td>
                <td className="code">{d.creditControlArea}</td>
                <td className="tabular text-end">{d.orderValue.toFixed(2)} {d.orderCurrency}</td>
                <td className="tabular text-end">{d.currentExposure.toFixed(2)} / {d.currentLimit === null ? '—' : d.currentLimit.toFixed(2)}</td>
                <td className="tabular text-end">{d.utilizationPercent === null ? '—' : `${d.utilizationPercent.toFixed(1)}%`}</td>
                <td>{d.status}</td>
                <td className="code">{d.reason}</td>
                <td className="code">{d.releasedBy ?? '—'}</td>
              </tr>
            ))}
            {determinations.length === 0 && (
              <tr><td colSpan={10} className="text-sm text-ink-soft">{t('release.empty')}</td></tr>
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
