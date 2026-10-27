'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { toScaled, fromScaled } from '@/platform/posting/decimal';
import type { AccrualDocumentView } from '@/modules/finance/accrual';
import { postAccrualAction, reverseAccrualAction, type AccrualState } from './actions';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

const INITIAL: AccrualState = { ok: true };

interface LineDraft {
  key: number;
  account: string;
  side: 'S' | 'H';
  amount: string;
  costCenter: string;
  profitCenter: string;
  assignment: string;
  text: string;
}

const emptyLine = (key: number, side: 'S' | 'H'): LineDraft => ({
  key, account: '', side, amount: '', costCenter: '', profitCenter: '', assignment: '', text: '',
});

/**
 * Accrual/deferral entry (SCR-100 / FBS1): the FB50-shaped grid
 * with the reversal header the package requires, posted through
 * the judged accrual service. Below, the F.81 list of accrual
 * documents due for reversal, each with its execute action.
 */
export default function AccrualShell({ canPost, companies, types, reasons, due }: {
  canPost: boolean;
  companies: Array<{ companyCode: string; name: string; currency: string }>;
  types: Array<{ documentType: string; name: string }>;
  reasons: Array<{ reasonCode: string; reasonDescription: string }>;
  due: AccrualDocumentView[];
}) {
  const [state, action, pending] = useActionState(postAccrualAction, INITIAL);
  const [requestKey] = useState(() => `accrual-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);
  const [companyKey, setCompanyKey] = useState(companies[0]?.companyCode ?? '');
  const currency = companies.find((c) => c.companyCode === companyKey)?.currency ?? '';
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(1, 'S'), emptyLine(2, 'H')]);
  const draftAmount = (value: string) => { try { return toScaled(value || '0'); } catch { return 0n; } };
  const debitTotal = lines.filter((l) => l.side === 'S').reduce((s, l) => s + draftAmount(l.amount), 0n);
  const creditTotal = lines.filter((l) => l.side === 'H').reduce((s, l) => s + draftAmount(l.amount), 0n);
  const balanced = debitTotal === creditTotal && debitTotal > 0n;
  const today = new Date().toISOString().slice(0, 10);

  if (!canPost) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.ACCRUAL.POST' })}
      </div>
    );
  }

  function updateLine(key: number, patch: Partial<LineDraft>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((current) => [...current, emptyLine(Math.max(0, ...current.map((l) => l.key)) + 1, 'S')]);
  }
  function removeLine(key: number) {
    if (lines.length <= 2) return;
    setLines((current) => current.filter((l) => l.key !== key));
  }

  return (
    <div className="space-y-4">
      {state.message && (
        <div className={`border p-3 ${state.ok ? 'border-signal-ok/30 bg-signal-ok-soft' : 'border-signal-error/30 bg-signal-error-soft'}`}>
          <p className={`text-sm font-semibold ${state.ok ? 'text-signal-ok' : 'text-signal-error'}`}>{state.message}</p>
          {state.remedy && <p className="mt-0.5 text-sm text-ink-soft">{state.remedy}</p>}
          {state.ok && state.documentNumber && (
            <Link href={`/finance/journal/document?document=${encodeURIComponent(state.documentNumber)}`} className="mt-2 inline-block text-sm text-accent hover:underline">
              {t('accrual.openDocument')}
            </Link>
          )}
        </div>
      )}

      <form action={action} className="panel space-y-3 p-4" aria-label={t('accrual.entryTitle')}>
        <input type="hidden" name="requestKey" value={requestKey} />
        <div className="flex flex-wrap gap-3">
          <Field label={t('accrual.companyCode')}>
            <select name="companyCode" value={companyKey} onChange={(e) => setCompanyKey(e.target.value)} className="field-input code w-40">
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
            <select name="documentType" className="field-input w-52" defaultValue={types[0]?.documentType ?? ''}>
              {types.map((type) => <option key={type.documentType} value={type.documentType}>{type.documentType} — {type.name}</option>)}
            </select>
          </Field>
          <Field label={t('accrual.currency')}>
            <input name="currency" value={currency} readOnly className="field-input code w-28 bg-sunken" />
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
            <select name="reversalReason" className="field-input w-64" required defaultValue={reasons[0]?.reasonCode ?? ''}>
              {reasons.map((r) => <option key={r.reasonCode} value={r.reasonCode}>{r.reasonCode} — {r.reasonDescription}</option>)}
            </select>
          </Field>
        </div>

        <div className="overflow-x-auto">
          <table className="grid-table min-w-[56rem]">
            <thead>
              <tr>
                <th>#</th><th>{t('accrual.account')}</th><th>D / C</th>
                <th className="text-end">{t('accrual.amount')}</th>
                <th>{t('accrual.costCenter')}</th><th>{t('accrual.profitCenter')}</th>
                <th>{t('accrual.assignment')}</th><th>{t('accrual.lineText')}</th><th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.key}>
                  <td className="tabular text-ink-faint">{index + 1}</td>
                  <td><input name={`line_${index}_account`} value={line.account} onChange={(e) => updateLine(line.key, { account: e.target.value })} className="field-input code w-28" placeholder="510000" /></td>
                  <td>
                    <select name={`line_${index}_side`} value={line.side} onChange={(e) => updateLine(line.key, { side: e.target.value as 'S' | 'H' })} className="field-input w-20">
                      <option value="S">Debit</option>
                      <option value="H">Credit</option>
                    </select>
                  </td>
                  <td><input name={`line_${index}_amount`} value={line.amount} onChange={(e) => updateLine(line.key, { amount: e.target.value })} inputMode="decimal" className="field-input tabular w-28 text-end" placeholder="0.00" /></td>
                  <td><input name={`line_${index}_costCenter`} value={line.costCenter} onChange={(e) => updateLine(line.key, { costCenter: e.target.value })} className="field-input code w-28" /></td>
                  <td><input name={`line_${index}_profitCenter`} value={line.profitCenter} onChange={(e) => updateLine(line.key, { profitCenter: e.target.value })} className="field-input code w-28" /></td>
                  <td><input name={`line_${index}_assignment`} value={line.assignment} onChange={(e) => updateLine(line.key, { assignment: e.target.value })} maxLength={18} className="field-input code w-28" /></td>
                  <td><input name={`line_${index}_text`} value={line.text} onChange={(e) => updateLine(line.key, { text: e.target.value })} maxLength={50} className="field-input" /></td>
                  <td><button type="button" onClick={() => removeLine(line.key)} disabled={lines.length <= 2} className="btn btn-default min-h-8 px-2 text-2xs disabled:opacity-30">×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={addLine} className="btn btn-default">{t('accrual.addLine')}</button>
          <span className={`text-sm ${balanced ? 'text-signal-ok' : 'text-signal-warn'}`}>
            {balanced
              ? t('accrual.balanced', { total: fromScaled(debitTotal), currency })
              : t('accrual.unbalanced', { difference: fromScaled(debitTotal - creditTotal), currency })}
          </span>
        </div>
        <div className="flex gap-3">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!balanced || pending}>
            {pending ? t('accrual.posting') : t('accrual.post')}
          </button>
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
              <th />
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
                <td>
                  {doc.reversalStatus === 'PENDING' && (
                    <ReverseAccrual doc={doc} />
                  )}
                </td>
              </tr>
            ))}
            {due.length === 0 && (
              <tr><td colSpan={8} className="text-sm text-ink-soft">{t('accrual.dueEmpty')}</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function ReverseAccrual({ doc }: { doc: AccrualDocumentView }) {
  const [engaged, setEngaged] = useState(false);
  const [state, action, pending] = useActionState(reverseAccrualAction, INITIAL);
  const lock = useChangeLock(
    'ACCRUAL_DOCUMENT',
    `${doc.companyCode}/${doc.documentNumber}/${doc.fiscalYear}`,
    'FIN.ACCRUAL.POST',
    engaged,
  );
  return (
    <form
      action={action}
      className="space-y-1"
      onFocus={() => setEngaged(true)}
      onSubmit={(event) => {
        if (lock?.mode !== 'CHANGE') event.preventDefault();
      }}
    >
      <input type="hidden" name="companyCode" value={doc.companyCode} />
      <input type="hidden" name="documentNumber" value={doc.documentNumber} />
      <input type="hidden" name="fiscalYear" value={doc.fiscalYear} />
      <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} remedy={lock?.remedy} />
      {state.message && !state.ok && <p className="text-2xs text-signal-error">{state.message}</p>}
      <button type="submit" className="btn btn-default min-h-8 px-2 text-2xs" disabled={pending || lock?.mode === 'DISPLAY'}>
        {pending ? t('common.saving') : t('accrual.reverseNow')}
      </button>
    </form>
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
