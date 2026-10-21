'use client';

import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import type { CreditAuditView, CreditConfigView, CustomerCreditView } from '@/modules/finance/credit';
import { loadCreditAction, saveCreditAction, type CreditState } from './actions';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';

const INITIAL: CreditState = { ok: true };

/**
 * Customer credit management (SCR-103 / FD32): load a customer
 * in a credit control area, see limit, exposure, available
 * credit and utilization, edit the control data with a stated
 * reason, and read the complete change history. Every save is
 * audited field by field and version-checked.
 */
export default function CreditShell({ canUse, config, credit, audit, selected }: {
  canUse: boolean;
  config: CreditConfigView;
  credit: CustomerCreditView | null;
  audit: CreditAuditView[];
  selected: { customer: string; area: string } | null;
}) {
  const [state, saveAction, saving] = useActionState(saveCreditAction, INITIAL);
  const [blocked, setBlocked] = useState(credit?.isBlocked ?? false);

  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.CREDIT.MAINTAIN' })}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {state.message && (
        <div className={`border p-3 ${state.ok ? 'border-signal-ok/30 bg-signal-ok-soft' : 'border-signal-error/30 bg-signal-error-soft'}`}>
          <p className={`text-sm font-semibold ${state.ok ? 'text-signal-ok' : 'text-signal-error'}`}>{state.message}</p>
          {state.remedy && <p className="mt-0.5 text-sm text-ink-soft">{state.remedy}</p>}
        </div>
      )}

      <form action={loadCreditAction} className="panel space-y-3 p-4" aria-label={t('credit.selectionTitle')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('credit.customer')}>
            <input name="customer" required defaultValue={selected?.customer ?? ''} className="field-input code w-44" placeholder="C100" />
          </Field>
          <Field label={t('credit.area')}>
            <select name="area" className="field-input code w-44" defaultValue={selected?.area ?? config.areas[0]?.code ?? ''}>
              {config.areas.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.currency}</option>)}
            </select>
          </Field>
        </div>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('credit.load')}</button>
      </form>

      {selected && !credit && (
        <p className="border border-signal-warn/40 bg-signal-warn-soft p-3 text-sm text-ink">
          {t('credit.noRecord', { customer: selected.customer, area: selected.area })}
        </p>
      )}

      {selected && (
        <form action={saveAction} className="panel space-y-3 p-4" aria-label={t('credit.editTitle')}>
          <input type="hidden" name="customer" value={selected.customer} />
          <input type="hidden" name="area" value={selected.area} />
          <input type="hidden" name="version" value={credit?.version ?? ''} />
          <h2 className="panel-title">
            {credit ? `${credit.customerName} (${credit.customer}) · ${credit.creditControlArea}` : t('credit.newRecord', { customer: selected.customer, area: selected.area })}
          </h2>
          {credit && (
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Stat label={t('credit.exposure')} value={`${credit.exposure.toFixed(2)} ${credit.creditCurrency}`} />
              <Stat label={t('credit.available')} value={`${credit.availableCredit.toFixed(2)} ${credit.creditCurrency}`} />
              <Stat label={t('credit.utilization')} value={credit.utilizationPercent === null ? '—' : `${credit.utilizationPercent.toFixed(1)}%`} />
              <Stat label={t('credit.openReceivables')} value={`${credit.openReceivables.toFixed(2)} ${credit.creditCurrency}`} />
            </dl>
          )}
          <div className="flex flex-wrap gap-3">
            <Field label={t('credit.limit')}>
              <input name="creditLimit" required inputMode="decimal" defaultValue={credit?.creditLimit ?? ''} className="field-input tabular w-40" placeholder="10000.00" />
            </Field>
            <Field label={t('credit.riskCategory')}>
              <select name="riskCategory" className="field-input w-48" defaultValue={credit?.riskCategory ?? config.riskCategories[0]?.code ?? ''}>
                {config.riskCategories.map((r) => <option key={r.code} value={r.code}>{r.code} — {r.name}</option>)}
              </select>
            </Field>
            <Field label={t('credit.repGroup')}>
              <select name="representativeGroup" className="field-input w-48" defaultValue={credit?.representativeGroup ?? ''}>
                <option value="">—</option>
                {config.representativeGroups.map((r) => <option key={r.code} value={r.code}>{r.code} — {r.name}</option>)}
              </select>
            </Field>
            <Field label={t('credit.creditGroup')}>
              <select name="customerCreditGroup" className="field-input w-48" defaultValue={credit?.customerCreditGroup ?? ''}>
                <option value="">—</option>
                {config.creditGroups.map((r) => <option key={r.code} value={r.code}>{r.code} — {r.name}</option>)}
              </select>
            </Field>
            <Field label={t('credit.validTo')}>
              <input name="validTo" type="date" defaultValue={credit?.validTo ?? ''} className="field-input w-40" />
            </Field>
            <Field label={t('credit.hold')}>
              <select name="isBlocked" value={blocked ? 'true' : 'false'} onChange={(e) => setBlocked(e.target.value === 'true')} className="field-input w-36">
                <option value="false">{t('credit.holdNo')}</option>
                <option value="true">{t('credit.holdYes')}</option>
              </select>
            </Field>
            {blocked && (
              <Field label={t('credit.blockReason')}>
                <select name="blockReason" className="field-input w-52" defaultValue={credit?.blockReason ?? config.blockReasons[0]?.code ?? ''}>
                  {config.blockReasons.map((r) => <option key={r.code} value={r.code}>{r.code} — {r.name}</option>)}
                </select>
              </Field>
            )}
            <Field label={t('credit.changeReason')}>
              <input name="changeReason" required maxLength={240} className="field-input w-72" placeholder={t('credit.changeReasonHint')} />
            </Field>
          </div>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={saving}>
            {saving ? t('credit.saving') : t('credit.save')}
          </button>
        </form>
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
