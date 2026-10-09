'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { toScaled, fromScaled } from '@/platform/posting/decimal';
import { postJournalAction, type PostState } from './actions';

const INITIAL: PostState = { ok: true };

interface LineDraft {
  key: number;
  account: string;
  side: 'S' | 'H';
  amount: string;
  costCenter: string;
  text: string;
}

/**
 * Post a journal entry — FIN.JOURNAL.POST (Tier A)
 *
 * The tooltip in the header and the running total below the grid exist for the
 * same reason: a user should see that a document balances *before* pressing post,
 * not discover it afterwards. The engine refuses an unbalanced document either
 * way, but a refusal the user could have predicted is just friction.
 *
 * Fiscal year and period are not fields. They are derived from the posting date
 * by the engine, from the company code's fiscal year variant — the single source
 * of truth for what period a date belongs to.
 */
export function JournalForm({ companies, types }: { companies: Array<{ companyCode: string; name: string; currency: string }>; types: Array<{ documentType: string; name: string }> }) {
  const [companyKey, setCompanyKey] = useState(companies[0]?.companyCode ?? '');
  const selectedCompany = companies.find((c) => c.companyCode === companyKey);
  const draftAmount = (value: string) => { try { return toScaled(value || '0'); } catch { return 0n; } };
  const [state, action, pending] = useActionState(postJournalAction, INITIAL);

  const today = new Date().toISOString().slice(0, 10);
  const [lines, setLines] = useState<LineDraft[]>([
    { key: 1, account: '', side: 'S', amount: '', costCenter: '', text: '' },
    { key: 2, account: '', side: 'H', amount: '', costCenter: '', text: '' },
  ]);

  const debitTotal = lines
    .filter((l) => l.side === 'S')
    .reduce((sum, l) => sum + draftAmount(l.amount), 0n);
  const creditTotal = lines
    .filter((l) => l.side === 'H')
    .reduce((sum, l) => sum + draftAmount(l.amount), 0n);
  const difference = debitTotal - creditTotal;
  const balanced = difference === 0n && debitTotal > 0n;

  function updateLine(key: number, patch: Partial<LineDraft>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function addLine() {
    const nextKey = Math.max(0, ...lines.map((l) => l.key)) + 1;
    setLines((current) => [
      ...current,
      { key: nextKey, account: '', side: 'S', amount: '', costCenter: '', text: '' },
    ]);
  }

  function removeLine(key: number) {
    if (lines.length <= 2) return;
    setLines((current) => current.filter((l) => l.key !== key));
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-4 border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.JOURNAL.POST</span>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{t('journal.postTitle')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('journal.postSubtitle')}</p>
      </header>

      {state.message && (
        <div
          className={`mb-4 border p-3 ${
            state.ok
              ? 'border-signal-ok/30 bg-signal-ok-soft'
              : 'border-signal-error/30 bg-signal-error-soft'
          }`}
        >
          <p
            className={`text-sm font-semibold ${
              state.ok ? 'text-signal-ok' : 'text-signal-error'
            }`}
          >
            {state.message}
          </p>
          {state.remedy && <p className="mt-0.5 text-sm text-ink-soft">{state.remedy}</p>}
          {state.ok && state.documentNumber && (
            <Link
              href={`/finance/journal?document=${encodeURIComponent(state.documentNumber)}`}
              className="mt-2 inline-block text-sm text-accent hover:underline"
            >
              Open document {state.displayNumber || state.documentNumber}
            </Link>
          )}
        </div>
      )}

      <form action={action}>
        <fieldset className="panel mb-4 p-4">
          <legend className="px-1 text-2xs font-semibold uppercase tracking-wide text-ink-soft">
            {t('journal.headerData')}
          </legend>
          <div className="flex flex-wrap gap-3">
            <Field label={t('journal.postingDate')} width="w-44">
              <input
                type="date"
                name="postingDate"
                defaultValue={today}
                required
                className="field-input"
              />
            </Field>
            <Field label={t('journal.type')} width="w-52">
              <select name="documentType" defaultValue="SA" className="field-input">
                {types.map((type) => <option key={type.documentType} value={type.documentType}>{type.documentType} — {type.name}</option>)}
              </select>
            </Field>
            <Field label={t('cc.code')} width="w-32">
              <select name="companyCode" value={companyKey} onChange={(e) => setCompanyKey(e.target.value)} className="field-input code">{companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode} · {c.name}</option>)}</select>
            </Field>
            <Field label={t('journal.currency')} width="w-28">
              <input name="currency" value={selectedCompany?.currency ?? ""} readOnly className="field-input code bg-sunken" />
            </Field>
            <Field label={t('journal.reference')} width="w-48">
              <input name="reference" className="field-input" />
            </Field>
            <Field label={t('journal.headerText')} width="flex-1">
              <input name="headerText" className="field-input" />
            </Field>
          </div>
        </fieldset>

        <div className="panel mb-4 overflow-hidden">
          <div className="panel-header">
            <h2 className="panel-title">{t('journal.lineItems')}</h2>
            <button type="button" onClick={addLine} className="btn btn-default">
              {t('journal.addLine')}
            </button>
          </div>
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-14">#</th>
                <th className="w-28">{t('gl.number')}</th>
                <th className="w-24">D / C</th>
                <th className="w-32 text-end">{t('journal.amount')}</th>
                <th className="w-32">Cost centre</th>
                <th>Text</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.key}>
                  <td className="tabular text-ink-faint">{index + 1}</td>
                  <td>
                    <input
                      name={`line_${index}_account`}
                      value={line.account}
                      onChange={(e) => updateLine(line.key, { account: e.target.value })}
                      className="field-input code w-24"
                      placeholder="510000"
                    />
                  </td>
                  <td>
                    <select
                      name={`line_${index}_side`}
                      value={line.side}
                      onChange={(e) =>
                        updateLine(line.key, { side: e.target.value as 'S' | 'H' })
                      }
                      className="field-input w-20"
                    >
                      <option value="S">Debit</option>
                      <option value="H">Credit</option>
                    </select>
                  </td>
                  <td>
                    <input
                      name={`line_${index}_amount`}
                      value={line.amount}
                      onChange={(e) => updateLine(line.key, { amount: e.target.value })}
                      inputMode="decimal"
                      className="field-input tabular w-28 text-end"
                      placeholder="0.00"
                    />
                  </td>
                  <td>
                    <input
                      name={`line_${index}_costCenter`}
                      value={line.costCenter}
                      onChange={(e) => updateLine(line.key, { costCenter: e.target.value })}
                      className="field-input code w-28"
                    />
                  </td>
                  <td>
                    <input
                      name={`line_${index}_text`}
                      value={line.text}
                      onChange={(e) => updateLine(line.key, { text: e.target.value })}
                      className="field-input"
                    />
                  </td>
                  <td className="text-end">
                    <button
                      type="button"
                      onClick={() => removeLine(line.key)}
                      disabled={lines.length <= 2}
                      className="text-ink-faint hover:text-signal-error disabled:opacity-30"
                      aria-label="Remove line"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-sunken">
                <td colSpan={3} className="text-end text-2xs uppercase tracking-wide text-ink-faint">
                  Totals
                </td>
                <td className="tabular text-end font-semibold">
                  {fromScaled(debitTotal)}
                  <span className="ms-1 text-2xs font-normal text-ink-faint">Dr</span>
                </td>
                <td colSpan={2}>
                  <span className="tabular font-semibold">{fromScaled(creditTotal)}</span>
                  <span className="ms-1 text-2xs font-normal text-ink-faint">Cr</span>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>

          <div
            className={`border-t px-3 py-2 text-sm ${
              balanced
                ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok'
                : 'border-signal-warn/30 bg-signal-warn-soft text-signal-warn'
            }`}
          >
            {balanced
              ? t('journal.balanced')
              : t('journal.unbalanced', { difference: fromScaled(difference) })}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Link href="/finance/journal" className="btn btn-default">
            {t('common.cancel')}
          </Link>
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? t('journal.posting') : t('journal.post')}
          </button>
          <span className="text-2xs text-ink-faint">{t('journal.postHint')}</span>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  width,
  children,
}: {
  label: string;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={width ?? 'w-44'}>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}
