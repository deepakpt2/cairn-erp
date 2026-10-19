import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { AccrualDocumentView } from '@/modules/finance/accrual';

/**
 * Accrual/deferral entry shell (SCR-100 stage 1): the supplied
 * FBS1 field shape with the reversal header the package requires.
 * The judged posting action lands in stage 3. Below it, the F.81
 * due list renders whatever accrual documents stand pending.
 */
export default function AccrualShell({ canPost, companies, types, reasons, due }: {
  canPost: boolean;
  companies: Array<{ companyCode: string; name: string; currency: string }>;
  types: Array<{ documentType: string; name: string }>;
  reasons: Array<{ reasonCode: string; reasonDescription: string }>;
  due: AccrualDocumentView[];
}) {
  if (!canPost) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.ACCRUAL.POST' })}
      </div>
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-4">
      <form className="panel space-y-3 p-4" aria-label={t('accrual.entryTitle')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('accrual.companyCode')}>
            <select name="companyCode" className="field-input code w-40">
              {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode} · {c.name}</option>)}
            </select>
          </Field>
          <Field label={t('accrual.documentDate')}>
            <input type="date" name="documentDate" defaultValue={today} className="field-input w-40" required />
          </Field>
          <Field label={t('accrual.postingDate')}>
            <input type="date" name="postingDate" defaultValue={today} className="field-input w-40" required />
          </Field>
          <Field label={t('accrual.documentType')}>
            <select name="documentType" className="field-input w-52">
              {types.map((type) => <option key={type.documentType} value={type.documentType}>{type.documentType} — {type.name}</option>)}
            </select>
          </Field>
          <Field label={t('accrual.reference')}>
            <input name="reference" maxLength={16} className="field-input w-44" />
          </Field>
          <Field label={t('accrual.headerText')}>
            <input name="headerText" maxLength={25} className="field-input w-56" />
          </Field>
        </div>
        <div className="flex flex-wrap gap-3">
          <Field label={t('accrual.reversalDate')}>
            <input type="date" name="reversalDate" className="field-input w-40" required />
          </Field>
          <Field label={t('accrual.reversalReason')}>
            <select name="reversalReason" className="field-input w-64" required>
              {reasons.map((r) => <option key={r.reasonCode} value={r.reasonCode}>{r.reasonCode} — {r.reasonDescription}</option>)}
            </select>
          </Field>
        </div>
        <p className="text-2xs text-ink-faint">{t('accrual.stageNote')}</p>
        <div className="flex gap-3">
          <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>{t('accrual.post')}</button>
          <Link href="/finance/journal/park" className="btn btn-default min-h-11 sm:min-h-8">{t('accrual.parkInstead')}</Link>
        </div>
      </form>

      <section className="panel overflow-x-auto" aria-label={t('accrual.dueTitle')}>
        <div className="panel-header">
          <h2 className="panel-title">{t('accrual.dueTitle')}</h2>
          <span className="text-2xs text-ink-faint">{t('accrual.dueHint')}</span>
        </div>
        <table className="grid-table min-w-[56rem]">
          <thead>
            <tr>
              <th>{t('accrual.document')}</th>
              <th>{t('accrual.postingDate')}</th>
              <th>{t('accrual.reversalDate')}</th>
              <th>{t('accrual.reversalReason')}</th>
              <th className="text-end">{t('accrual.amount')}</th>
              <th>{t('accrual.status')}</th>
              <th>{t('accrual.reversalDocument')}</th>
            </tr>
          </thead>
          <tbody>
            {due.map((doc) => (
              <tr key={`${doc.documentNumber}-${doc.fiscalYear}`}>
                <td className="code">{doc.displayNumber || doc.documentNumber}</td>
                <td>{doc.postingDate}</td>
                <td>{doc.reversalDate}</td>
                <td className="code">{doc.reversalReason}</td>
                <td className="tabular text-end">{doc.totalAmount.toFixed(2)} {doc.currency}</td>
                <td>{doc.reversalStatus}</td>
                <td className="code">{doc.reversalDocumentNumber ?? '—'}</td>
              </tr>
            ))}
            {due.length === 0 && (
              <tr><td colSpan={7} className="text-sm text-ink-soft">{t('accrual.dueEmpty')}</td></tr>
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
