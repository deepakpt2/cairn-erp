'use client';

import Link from 'next/link';
import { useActionState, useEffect, useMemo, useState } from 'react';
import { t } from '@/platform/i18n';
import { toScaled, fromScaled } from '@/platform/posting/decimal';
import { postJournalAction, type PostState } from './actions';

const INITIAL: PostState = { ok: true };

export interface JournalAccountOption {
  accountNumber: string;
  name: string;
  requiresCostObject: boolean;
  isBlockedPosting: boolean;
}

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

const CURRENCY_DECIMALS: Record<string, number> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3 };

const emptyLine = (key: number, side: 'S' | 'H'): LineDraft => ({
  key, account: '', side, amount: '', costCenter: '', profitCenter: '', assignment: '', text: '',
});

/**
 * Enter G/L account document — FIN.JOURNAL.POST (FB50 as a search
 * alias only), reworked by SCR-096 / R-144: the full supplied
 * header, an editable line grid with insert/copy/delete, live
 * totals, field-level errors, a confirmation summary, and posting
 * disabled until the document is valid and balanced. The server
 * judges everything again; this guidance only saves a round trip.
 */
export function JournalForm({ companies, types, accounts }: {
  companies: Array<{ companyCode: string; name: string; currency: string }>;
  types: Array<{ documentType: string; name: string }>;
  accounts: JournalAccountOption[];
}) {
  const [companyKey, setCompanyKey] = useState(companies[0]?.companyCode ?? '');
  const selectedCompany = companies.find((c) => c.companyCode === companyKey);
  const currency = selectedCompany?.currency ?? '';
  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  const draftAmount = (value: string) => { try { return toScaled(value || '0'); } catch { return 0n; } };
  const [state, action, pending] = useActionState(postJournalAction, INITIAL);
  const [requestKey] = useState(() => `fb50-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);
  const [confirming, setConfirming] = useState(false);
  // A completed post closes the confirmation panel; the same form
  // (and request key) may be reviewed again, and the server will
  // return the original document rather than posting twice.
  useEffect(() => {
    if (state.ok && state.documentNumber) setConfirming(false);
  }, [state]);

  const today = new Date().toISOString().slice(0, 10);
  const [postingDate, setPostingDate] = useState(today);
  const [documentDate, setDocumentDate] = useState(today);
  const [documentType, setDocumentType] = useState(types[0]?.documentType ?? '');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(1, 'S'), emptyLine(2, 'H')]);

  const accountByNumber = useMemo(
    () => new Map(accounts.map((a) => [a.accountNumber, a])),
    [accounts],
  );
  const debitTotal = lines.filter((l) => l.side === 'S').reduce((sum, l) => sum + draftAmount(l.amount), 0n);
  const creditTotal = lines.filter((l) => l.side === 'H').reduce((sum, l) => sum + draftAmount(l.amount), 0n);
  const difference = debitTotal - creditTotal;
  const balanced = difference === 0n && debitTotal > 0n;

  function lineError(line: LineDraft): string | null {
    if (!line.account) return t('journal.errorAccountRequired');
    const account = accountByNumber.get(line.account);
    if (accounts.length > 0 && !account) return t('journal.errorAccountUnknown');
    if (account?.isBlockedPosting) return t('journal.errorAccountBlocked');
    if (!line.amount) return t('journal.errorAmountRequired');
    let scaled: bigint;
    try { scaled = toScaled(line.amount); } catch { return t('journal.errorAmountFormat'); }
    if (scaled <= 0n) return t('journal.errorAmountPositive');
    const fraction = (line.amount.split('.')[1] ?? '').replace(/0+$/, '');
    if (fraction.length > decimals) return t('journal.errorAmountPrecision', { decimals });
    if (account?.requiresCostObject && !line.costCenter && !line.profitCenter) {
      return t('journal.errorCostObjectRequired');
    }
    return null;
  }
  const lineErrors = lines.map(lineError);
  const canPost = balanced && lineErrors.every((e) => e === null)
    && Boolean(companyKey && postingDate && documentDate && documentType);

  function updateLine(key: number, patch: Partial<LineDraft>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setConfirming(false);
  }

  function insertLine(afterKey?: number, copy?: LineDraft) {
    const nextKey = Math.max(0, ...lines.map((l) => l.key)) + 1;
    const fresh: LineDraft = copy
      ? { ...copy, key: nextKey }
      : emptyLine(nextKey, 'S');
    setLines((current) => {
      if (afterKey === undefined) return [...current, fresh];
      const at = current.findIndex((l) => l.key === afterKey);
      return [...current.slice(0, at + 1), fresh, ...current.slice(at + 1)];
    });
    setConfirming(false);
  }

  function removeLine(key: number) {
    if (lines.length <= 2) return;
    setLines((current) => current.filter((l) => l.key !== key));
    setConfirming(false);
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-4 border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.JOURNAL.POST · FB50</span>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{t('journal.postTitle')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('journal.postSubtitle')}</p>
      </header>

      {state.message && (
        <div className={`mb-4 border p-3 ${state.ok ? 'border-signal-ok/30 bg-signal-ok-soft' : 'border-signal-error/30 bg-signal-error-soft'}`}>
          <p className={`text-sm font-semibold ${state.ok ? 'text-signal-ok' : 'text-signal-error'}`}>{state.message}</p>
          {state.remedy && <p className="mt-0.5 text-sm text-ink-soft">{state.remedy}</p>}
          {state.ok && state.documentNumber && (
            <Link href={`/finance/journal/document?document=${encodeURIComponent(state.documentNumber)}`} className="mt-2 inline-block text-sm text-accent hover:underline">
              {t('journal.openDocument', { document: state.displayNumber || state.documentNumber })}
            </Link>
          )}
        </div>
      )}

      <form action={action}>
        <input type="hidden" name="requestKey" value={requestKey} />
        <fieldset className="panel mb-4 p-4">
          <legend className="px-1 text-2xs font-semibold uppercase tracking-wide text-ink-soft">{t('journal.headerData')}</legend>
          <div className="flex flex-wrap gap-3">
            <Field label={t('cc.code')} width="w-40">
              <select name="companyCode" value={companyKey} onChange={(e) => setCompanyKey(e.target.value)} className="field-input code" required>
                {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode} · {c.name}</option>)}
              </select>
            </Field>
            <Field label={t('journal.documentDate')} width="w-44">
              <input type="date" name="documentDate" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} required className="field-input" />
            </Field>
            <Field label={t('journal.postingDate')} width="w-44">
              <input type="date" name="postingDate" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} required className="field-input" />
            </Field>
            <Field label={t('journal.type')} width="w-56">
              <select name="documentType" value={documentType} onChange={(e) => setDocumentType(e.target.value)} className="field-input" required>
                {types.map((type) => <option key={type.documentType} value={type.documentType}>{type.documentType} — {type.name}</option>)}
              </select>
            </Field>
            <Field label={t('journal.currency')} width="w-32">
              <input name="currency" value={currency} readOnly className="field-input code bg-sunken" />
              <p className="mt-1 text-2xs text-ink-faint">{t('journal.currencyPrecision', { decimals })}</p>
            </Field>
            <Field label={t('journal.reference')} width="w-48">
              <input name="reference" maxLength={16} className="field-input" placeholder="JE-2026-001" />
            </Field>
            <Field label={t('journal.headerText')} width="flex-1">
              <input name="headerText" maxLength={25} className="field-input" placeholder="Monthly accrual" />
            </Field>
          </div>
        </fieldset>

        <div className="panel mb-4 overflow-x-auto">
          <div className="panel-header">
            <h2 className="panel-title">{t('journal.lineItems')}</h2>
            <button type="button" onClick={() => insertLine()} className="btn btn-default">{t('journal.addLine')}</button>
          </div>
          <table className="grid-table min-w-[72rem]">
            <thead>
              <tr>
                <th className="w-12">#</th>
                <th className="w-32">{t('gl.number')}</th>
                <th className="w-24">D / C</th>
                <th className="w-36 text-end">{t('journal.amount')}</th>
                <th className="w-32">{t('journal.costCenter')}</th>
                <th className="w-32">{t('journal.profitCenter')}</th>
                <th className="w-36">{t('journal.assignment')}</th>
                <th>{t('journal.lineText')}</th>
                <th className="w-36" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.key}>
                  <td className="tabular text-ink-faint">{index + 1}</td>
                  <td>
                    <input name={`line_${index}_account`} value={line.account} onChange={(e) => updateLine(line.key, { account: e.target.value })} className="field-input code w-28" placeholder="400000" list="gl-account-value-help" aria-invalid={Boolean(lineErrors[index])} />
                    {accounts.length > 0 && <datalist id="gl-account-value-help">{accounts.map((a) => <option key={a.accountNumber} value={a.accountNumber}>{a.name}</option>)}</datalist>}
                    {lineErrors[index] && <p className="mt-1 text-2xs text-signal-error">{lineErrors[index]}</p>}
                  </td>
                  <td>
                    <select name={`line_${index}_side`} value={line.side} onChange={(e) => updateLine(line.key, { side: e.target.value as 'S' | 'H' })} className="field-input w-20">
                      <option value="S">Debit</option>
                      <option value="H">Credit</option>
                    </select>
                  </td>
                  <td>
                    <input name={`line_${index}_amount`} value={line.amount} onChange={(e) => updateLine(line.key, { amount: e.target.value })} inputMode="decimal" className="field-input tabular w-32 text-end" placeholder="0.00" aria-invalid={Boolean(lineErrors[index])} />
                  </td>
                  <td><input name={`line_${index}_costCenter`} value={line.costCenter} onChange={(e) => updateLine(line.key, { costCenter: e.target.value })} className="field-input code w-28" placeholder="CC100" /></td>
                  <td><input name={`line_${index}_profitCenter`} value={line.profitCenter} onChange={(e) => updateLine(line.key, { profitCenter: e.target.value })} className="field-input code w-28" placeholder="PC100" /></td>
                  <td><input name={`line_${index}_assignment`} value={line.assignment} onChange={(e) => updateLine(line.key, { assignment: e.target.value })} maxLength={18} className="field-input code w-32" placeholder="ASSIGN-01" /></td>
                  <td><input name={`line_${index}_text`} value={line.text} onChange={(e) => updateLine(line.key, { text: e.target.value })} maxLength={50} className="field-input" placeholder="Office expense" /></td>
                  <td className="text-end whitespace-nowrap">
                    <button type="button" onClick={() => insertLine(line.key)} className="btn btn-default min-h-8 px-2 text-2xs">{t('journal.insertLine')}</button>{' '}
                    <button type="button" onClick={() => insertLine(line.key, line)} className="btn btn-default min-h-8 px-2 text-2xs">{t('journal.copyLine')}</button>{' '}
                    <button type="button" onClick={() => removeLine(line.key)} disabled={lines.length <= 2} className="btn btn-default min-h-8 px-2 text-2xs disabled:opacity-30" aria-label="Remove line">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-sunken">
                <td colSpan={3} className="text-end text-2xs uppercase tracking-wide text-ink-faint">Totals</td>
                <td className="tabular text-end font-semibold">{fromScaled(debitTotal)}<span className="ms-1 text-2xs font-normal text-ink-faint">Dr</span></td>
                <td colSpan={2}><span className="tabular font-semibold">{fromScaled(creditTotal)}</span><span className="ms-1 text-2xs font-normal text-ink-faint">Cr</span></td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
          <div className={`border-t px-3 py-2 text-sm ${balanced ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok' : 'border-signal-warn/30 bg-signal-warn-soft text-signal-warn'}`}>
            {balanced ? t('journal.balanced') : t('journal.unbalanced', { difference: fromScaled(difference) })}
          </div>
        </div>

        {confirming && canPost && (
          <div className="panel mb-4 border-signal-warn/40 p-4" role="alertdialog" aria-label={t('journal.confirmTitle')}>
            <h2 className="text-sm font-semibold">{t('journal.confirmTitle')}</h2>
            <p className="mt-1 text-sm text-ink-soft">
              {t('journal.confirmSummary', {
                company: companyKey, type: documentType, currency,
                lines: lines.length, total: fromScaled(debitTotal), date: postingDate,
              })}
            </p>
            <div className="mt-3 flex gap-3">
              <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? t('journal.posting') : t('journal.confirmPost')}</button>
              <button type="button" className="btn btn-default" onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Link href="/finance/journal" className="btn btn-default">{t('common.cancel')}</Link>
          <Link href="/finance/journal/park" className="btn btn-default">{t('journal.parkInstead')}</Link>
          {!confirming && (
            <button type="button" className="btn btn-primary" disabled={!canPost || pending} onClick={() => setConfirming(true)}>
              {t('journal.reviewPost')}
            </button>
          )}
          <span className="text-2xs text-ink-faint">{t('journal.postHint')}</span>
        </div>
      </form>
    </div>
  );
}

function Field({ label, width, children }: { label: string; width?: string; children: React.ReactNode }) {
  return (
    <div className={width ?? 'w-44'}>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}
