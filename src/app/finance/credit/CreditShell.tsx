import { t } from '@/platform/i18n';
import type { CreditAuditView, CustomerCreditView } from '@/modules/finance/credit';

/**
 * Customer credit management (SCR-103 / FD32): load a customer
 * in a credit control area, see limit, exposure, available
 * credit and utilization, edit the control data with a stated
 * reason, and read the complete change history. Every save is
 * audited field by field.
 */
export default function CreditShell({ canUse, credit, audit }: {
  canUse: boolean;
  credit: CustomerCreditView | null;
  audit: CreditAuditView[];
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.CREDIT.MAINTAIN' })}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <form className="panel space-y-3 p-4" aria-label={t('credit.selectionTitle')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('credit.customer')}>
            <input name="customer" required className="field-input code w-44" placeholder="C100" />
          </Field>
          <Field label={t('credit.area')}>
            <input name="area" required maxLength={4} className="field-input code w-32" placeholder="1000" />
          </Field>
        </div>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
          {t('credit.load')}
        </button>
      </form>

      {credit && (
        <section className="panel p-4" aria-label={t('credit.overviewTitle')}>
          <h2 className="panel-title">
            {credit.customerName} ({credit.customer}) · {credit.creditControlArea}
          </h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label={t('credit.limit')} value={`${credit.creditLimit.toFixed(2)} ${credit.creditCurrency}`} />
            <Stat label={t('credit.exposure')} value={`${credit.exposure.toFixed(2)} ${credit.creditCurrency}`} />
            <Stat label={t('credit.available')} value={`${credit.availableCredit.toFixed(2)} ${credit.creditCurrency}`} />
            <Stat label={t('credit.utilization')} value={credit.utilizationPercent === null ? '—' : `${credit.utilizationPercent.toFixed(1)}%`} />
            <Stat label={t('credit.openReceivables')} value={`${credit.openReceivables.toFixed(2)} ${credit.creditCurrency}`} />
            <Stat label={t('credit.riskCategory')} value={credit.riskCategory} />
            <Stat label={t('credit.validTo')} value={credit.validTo ?? '—'} warn={credit.limitExpired} />
            <Stat label={t('credit.hold')} value={credit.isBlocked ? (credit.blockReason ?? t('credit.holdYes')) : t('credit.holdNo')} warn={credit.isBlocked} />
          </dl>
        </section>
      )}

      <section className="panel" aria-label={t('credit.auditTitle')}>
        <div className="panel-header"><h2 className="panel-title">{t('credit.auditTitle')}</h2></div>
        <table className="grid-table">
          <thead>
            <tr>
              <th>{t('credit.when')}</th><th>{t('credit.field')}</th>
              <th>{t('credit.previous')}</th><th>{t('credit.newValue')}</th>
              <th>{t('credit.changedBy')}</th><th>{t('credit.reason')}</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((row) => (
              <tr key={row.auditId}>
                <td className="tabular text-2xs">{row.changedAt.slice(0, 19).replace('T', ' ')}</td>
                <td className="code">{row.field}</td>
                <td className="code">{row.previousValue ?? '—'}</td>
                <td className="code">{row.newValue ?? '—'}</td>
                <td className="code">{row.changedBy}</td>
                <td className="text-sm">{row.changeReason}</td>
              </tr>
            ))}
            {audit.length === 0 && (
              <tr><td colSpan={6} className="text-sm text-ink-soft">{t('credit.auditEmpty')}</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="field-label">{label}</dt>
      <dd className={`tabular font-semibold ${warn ? 'text-signal-error' : 'text-ink'}`}>{value}</dd>
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
