import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { TaxReportResult } from '@/modules/finance/tax-report';

export interface TaxReportDefaults {
  companyCode: string;
  taxGroup: string;
  postingDateFrom: string;
  postingDateTo: string;
  taxReturnCountry: string;
  testRun: boolean;
  doNotUpdateDocuments: boolean;
  electronicReturn: boolean;
  correctedReturn: boolean;
  clearingAccount: string;
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Selection and result of the advance tax return (SCR-097). The
 * form GETs so a judged selection stays bookmarkable; execution
 * mode is an explicit checkbox pair, never assumed — test is the
 * default, and an update run must be chosen on purpose.
 */
export default function TaxReportForm({ canReport, defaults, result }: {
  canReport: boolean;
  defaults: TaxReportDefaults;
  result: TaxReportResult | null;
}) {
  if (!canReport) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.TAX.REPORT' })}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4">
        <input type="hidden" name="run" value="1" />
        <div className="flex flex-wrap gap-3">
          <Field label={t('taxReport.companyCode')}>
            <input name="companyCode" defaultValue={defaults.companyCode} className="field-input code w-28" required placeholder="1000" />
          </Field>
          <Field label={t('taxReport.taxGroup')}>
            <input name="taxGroup" defaultValue={defaults.taxGroup} className="field-input code w-36" placeholder="—" />
          </Field>
          <Field label={t('taxReport.postingDateFrom')}>
            <input type="date" name="postingDateFrom" defaultValue={defaults.postingDateFrom} className="field-input w-40" required />
          </Field>
          <Field label={t('taxReport.postingDateTo')}>
            <input type="date" name="postingDateTo" defaultValue={defaults.postingDateTo} className="field-input w-40" required />
          </Field>
          <Field label={t('taxReport.country')}>
            <input name="taxReturnCountry" defaultValue={defaults.taxReturnCountry} className="field-input code w-24" required placeholder="KW" />
          </Field>
          <Field label={t('taxReport.clearingAccount')}>
            <input name="clearingAccount" defaultValue={defaults.clearingAccount} className="field-input code w-32" placeholder="170000" />
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="testRun" value="on" defaultChecked={defaults.testRun} />
            {t('taxReport.testRun')}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="doNotUpdate" value="on" defaultChecked={defaults.doNotUpdateDocuments} />
            {t('taxReport.doNotUpdate')}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="electronic" value="on" defaultChecked={defaults.electronicReturn} />
            {t('taxReport.electronic')}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="corrected" value="on" defaultChecked={defaults.correctedReturn} />
            {t('taxReport.corrected')}
          </label>
        </div>
        <p className="text-2xs text-ink-faint">{t('taxReport.modeHint')}</p>
        <div className="flex gap-3">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('taxReport.execute')}</button>
          <Link href="/finance/journal" className="btn btn-default min-h-11 sm:min-h-8">{t('journal.title')}</Link>
        </div>
      </form>

      {result && (
        <section className="panel overflow-x-auto" aria-label={t('taxReport.result')}>
          <div className="panel-header">
            <h2 className="panel-title">{t('taxReport.result')}</h2>
            <span className="text-2xs text-ink-faint">
              {t('taxReport.resultMeta', {
                companies: result.companies.join(', '), country: result.taxReturnCountry,
                from: result.postingDateFrom, to: result.postingDateTo, currency: result.currency,
              })}
            </span>
          </div>
          {result.warnings.length > 0 && (
            <ul className="space-y-1 border-b border-line bg-signal-warn-soft px-3 py-2 text-sm text-signal-warn">
              {result.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          <table className="grid-table min-w-[56rem]">
            <thead>
              <tr>
                <th>{t('taxReport.taxCode')}</th>
                <th>{t('taxReport.accountKey')}</th>
                <th className="text-end">{t('taxReport.rate')}</th>
                <th className="text-end">{t('taxReport.taxBase')}</th>
                <th className="text-end">{t('taxReport.inputTax')}</th>
                <th className="text-end">{t('taxReport.outputTax')}</th>
                <th className="text-end">{t('taxReport.documents')}</th>
              </tr>
            </thead>
            <tbody>
              {result.lines.map((line) => (
                <tr key={`${line.taxCode}-${line.currency}`}>
                  <td className="code">{line.taxCode}</td>
                  <td className="code">{line.accountKey ?? '—'}</td>
                  <td className="tabular text-end">{line.ratePercent.toFixed(2)}%</td>
                  <td className="tabular text-end">{line.taxBase === null ? t('taxReport.baseNotDerivable') : money(line.taxBase)}</td>
                  <td className="tabular text-end">{money(line.inputTax)}</td>
                  <td className="tabular text-end">{money(line.outputTax)}</td>
                  <td className="tabular text-end">{line.documentCount}</td>
                </tr>
              ))}
              {result.lines.length === 0 && (
                <tr><td colSpan={7} className="text-sm text-ink-soft">{t('taxReport.empty')}</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-sunken font-semibold">
                <td colSpan={3}>{t('taxReport.totals')}</td>
                <td className="tabular text-end">{money(result.totalBase)}</td>
                <td className="tabular text-end">{money(result.totalInputTax)}</td>
                <td className="tabular text-end">{money(result.totalOutputTax)}</td>
                <td />
              </tr>
              <tr className="bg-sunken font-semibold">
                <td colSpan={5}>{result.netTax >= 0 ? t('taxReport.netPayable') : t('taxReport.netReceivable')}</td>
                <td className="tabular text-end">{money(Math.abs(result.netTax))}</td>
                <td />
              </tr>
            </tfoot>
          </table>
          {result.runId && (
            <p className="border-t border-line px-3 py-2 text-sm text-ink-soft">
              {t('taxReport.runRecorded', { run: result.runId })}
              {result.transferDocumentNumber && ` ${t('taxReport.transferPosted', { document: result.transferDocumentNumber })}`}
            </p>
          )}
        </section>
      )}
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
